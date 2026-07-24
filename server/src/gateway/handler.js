// The path of a single request: ingress → match → invoke → return, with logging /
// cost / classification done after the response is on its way.
//
// Routing precedence (the developer's explicit choice is honored):
//   1. Explicit available model → use it as-is, skip ALL policies (rules + auto)
//   2. Otherwise (model "auto", absent, or the requested provider isn't connected)
//      → the router decides: cache → rules → automated routing → default
//   + fallback to another live provider on a provider error.
const { v4: uuidv4 } = require("uuid");
const { getRouter } = require("../providers/router");
const { config } = require("../config");
const pricing = require("../pricing/registry");
const { classifyTask } = require("../classify/classifier");
const ruleEngine = require("../routing/ruleEngine");
const autoRouter = require("../routing/autoRouter");
const policyEngine = require("../routing/policy");
const aiPolicy = require("../routing/aiPolicy");
const canaryEngine = require("../routing/canaryEngine");
const capEngine = require("../routing/capEngine");
const responseCache = require("../routing/responseCache");
const outputGuardrail = require("./outputGuardrail");
const promptInjection = require("./promptInjection");
const semanticCache = require("../routing/semanticCache");
const { maybeShadowEval } = require("../eval/shadow");
const logger = require("../logging/logger");
const Settings = require("../models/Settings");
const ApplicationConfig = require("../models/ApplicationConfig");
const { createBoundedTtlCache } = require("../utils/boundedTtlCache");
const { pushOverride } = require("./explain");

// Short-lived cache to avoid a DB hit per request for app configs.
//
// Bounded on purpose: the key is the caller-supplied application name, and
// anonymous calls are allowed until Settings.requireApiKey is turned on, so an
// untrusted caller can otherwise mint a permanent entry per request. The cap is
// far above any real deployment's application count, so it only ever bites abuse.
const _appConfigCache = createBoundedTtlCache({ ttlMs: 30_000, maxEntries: 1000 });

async function getAppConfig(appName) {
  if (!appName || appName === "unknown") return null;
  const hit = _appConfigCache.getEntry(appName);
  if (hit) return hit.value;
  const cfg = await ApplicationConfig.findOne({ applicationName: appName }).lean().catch(() => null);
  // Misses are cached too. Unknown names are the cheap case to spam, and caching
  // the null is exactly what keeps that traffic off the database; now that the
  // map is bounded, doing so no longer trades a DB problem for a memory one.
  _appConfigCache.set(appName, cfg);
  return cfg;
}

// An explicit, honorable model pin → { provider, model, knownPricing } to use
// as-is, or null to defer to the router. Defers when the model is "auto"/absent
// or the resolved provider is not connected (live).
// Pass-through: an explicit provider + any non-empty model ID is accepted even
// when the model is not in the registry — costs are logged as $0 until it's added.
function resolveExplicit(body, eff) {
  const rawModel = (body.model || "").trim();
  const rawProvider = (body.provider || "").trim();
  if (!rawModel || rawModel.toLowerCase() === "auto") return null;
  const known = pricing.getModel(rawModel);
  const provider = (rawProvider && rawProvider.toLowerCase() !== "auto" ? rawProvider : null)
    || (known ? known.provider : null);
  if (!provider || !eff.liveIds.includes(provider)) return null;
  return { provider, model: rawModel, knownPricing: !!known };
}

// The router's base model for auto mode: honor a live provider hint if given,
// else the configured default provider. The chosen default model (eff.defaultModel)
// applies to the default provider; other providers use their built-in default.
function resolveDefault(body, eff) {
  const rawProvider = (body.provider || "").trim();
  const hinted =
    rawProvider && rawProvider.toLowerCase() !== "auto" && eff.liveIds.includes(rawProvider)
      ? rawProvider
      : null;
  const provider = hinted || eff.defaultProvider;
  const model =
    provider === eff.defaultProvider
      ? eff.defaultModel || config.defaultModels[provider]
      : config.defaultModels[provider] || eff.defaultModel;
  return { provider, model };
}

// Build the ordered list of { provider, model } attempts for a failed primary call.
// Pure helper — exported for unit tests.
//   same-provider (default): primary, then this provider's default model if different
//   cross-provider: primary, then every other live provider's default model
//   none: primary only
function buildFallbackOrder(provider, model, liveIds, defaultModels, scope = "same-provider") {
  const primary = { provider, model };
  if (scope === "none") return [primary];
  if (scope === "cross-provider") {
    const rest = (liveIds || [])
      .filter((p) => p !== provider)
      .map((p) => ({ provider: p, model: defaultModels[p] }))
      .filter((x) => x.model);
    return [primary, ...rest];
  }
  // same-provider
  const light = defaultModels[provider];
  if (light && light !== model) return [primary, { provider, model: light }];
  return [primary];
}

// Try the chosen provider; on failure, retry per config.fallbackScope.
// Returns { result, usedFallback }.
async function invokeWithFallback(router, eff, { provider, model, messages, temperature, maxTokens }) {
  const order = buildFallbackOrder(
    provider,
    model,
    eff.liveIds,
    config.defaultModels,
    config.fallbackScope
  );
  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const { provider: p, model: m } = order[i];
    try {
      const result = await router.complete({
        messages,
        providerOverride: p,
        modelOverride: m,
        temperature,
        maxTokens,
      });
      return { result, usedFallback: i > 0 };
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error("all providers failed");
}

// Shared routing resolution: classify task + decide served {provider, model}.
// Returns { served, routingDecision, taskType, classifiedBy }. The classifier's own
// spend is accounted inside classify/classifier.js, so callers don't have to remember
// to log it — the OpenAI-compatible gateway used to forget, and its cost vanished.
// Callers are responsible for budget enforcement (it may short-circuit the response).
async function resolveRoute(body, { router, eff, application, workflow, userId = null, appConfig = {}, appDbConfig = null }) {
  const routingMode = await ruleEngine.getRoutingMode();
  const explicit = resolveExplicit(body, eff);
  const autoMode = !explicit;
  const providedTaskType = !!(body.taskType && String(body.taskType).trim());

  const cls = await classifyTask({
    taskType: body.taskType,
    messages: body.messages,
    router, eff,
    useLLM: routingMode === "ai" && autoMode && !providedTaskType,
    // Provenance only — recorded on internalContext so the overhead view can show
    // which app's traffic triggered a classification. Never a queryable dimension.
    application,
  });
  const taskType = cls.taskType;
  const classifiedBy = cls.method;
  const difficulty = cls.difficulty || null;
  const difficultyScore = typeof cls.difficultyScore === "number" ? cls.difficultyScore : null;
  const confidence = typeof cls.confidence === "number" ? cls.confidence : null;

  // routingExplain captures the non-derivable "why" (rule matched, policy source/base,
  // default scope, later overrides). The UI narrates from this + the flat fields.
  const explain = { basis: null, classificationUsed: false };

  let served, routingDecision;
  if (explicit) {
    served = explicit;
    routingDecision = "explicit";
    explain.basis = "explicit";
  } else {
    served = resolveDefault(body, eff);
    routingDecision = "passthrough";
    explain.basis = "passthrough";
    explain.defaultScope = "global";
    // Per-app default: override the global default model when the key specifies one.
    if (appConfig.defaultModel) {
      const known = pricing.getModel(appConfig.defaultModel);
      if (known && eff.liveIds.includes(known.provider)) {
        served = { provider: known.provider, model: appConfig.defaultModel, knownPricing: true };
        explain.defaultScope = "app";
      }
    }
    const route = await ruleEngine.findRoute({ taskType, application, workflow });
    if (route) {
      served = { provider: route.provider, model: route.model };
      routingDecision = "rule";
      explain.basis = "rule";
      explain.rule = {
        condition: route.condition || null,
        note: route.note || null,
        qualityGate: route.qualityGate || "ungated",
      };
      explain.qualityGate = route.qualityGate || "ungated";
    } else if (routingMode === "ai") {
      const aiMap = appDbConfig?.aiPolicyAssignments
        ? appDbConfig.aiPolicyAssignments
        : await aiPolicy.getEffective();
      // A low-confidence classification shouldn't drive a difficulty-based downgrade;
      // fall back to the task's default policy pick when we're unsure.
      const effDifficulty = (confidence == null || confidence >= 0.5) ? difficulty : null;
      const base = aiPolicy.lookup(aiMap, taskType);
      const hit = aiPolicy.resolveModel({ map: aiMap, taskType, difficulty: effDifficulty, eff });
      if (hit && eff.liveIds.includes(hit.provider)) {
        served = { provider: hit.provider, model: hit.model };
        routingDecision = "ai";
        explain.basis = "ai";
        explain.policy = {
          source: appDbConfig?.aiPolicyAssignments ? "app" : "global",
          base: base ? base.model : null,
          adjustedByDifficulty: !!(base && base.model !== hit.model),
          effDifficulty: effDifficulty || null,
        };
      }
    } else if (routingMode === "guardrail") {
      const policy = await policyEngine.getEffective();
      const auto = autoRouter.selectAutoRoute({ taskType, requested: served }, policy);
      if (auto) {
        served = { provider: auto.provider, model: auto.model };
        routingDecision = "auto";
        explain.basis = "auto";
      }
    }
  }
  // Eval-approved canary: divert a deterministic fraction of AUTO-routed traffic to a candidate
  // model. Pinned (explicit) models are never touched. Fail-open — selectCanary swallows its own
  // errors, and allowed-model / opt-out checks below still apply to the canary target.
  if (autoMode) {
    const canary = await canaryEngine.selectCanary({ application, workflow, taskType, servedModel: served.model, userId });
    if (canary) {
      // Prefer the registered model's provider; fall back to the experiment's stored provider
      // so an unregistered candidate can still be canaried.
      const provider = pricing.getModel(canary.toModel)?.provider || canary.experiment.candidateProvider;
      if (provider && eff.liveIds.includes(provider)) {
        explain.canary = {
          experimentId: String(canary.experiment._id),
          evalRunId: canary.experiment.evalRunId ? String(canary.experiment.evalRunId) : null,
          fromModel: served.model, toModel: canary.toModel, rolloutPct: canary.experiment.rolloutPct,
        };
        pushOverride(explain, { type: "canary", from: served.model, to: canary.toModel });
        served = { provider, model: canary.toModel };
        routingDecision = "canary";
      }
    }
  }

  explain.classificationUsed =
    explain.basis === "ai" || explain.basis === "auto" ||
    (explain.basis === "rule" && !!explain.rule?.condition?.taskType);

  // Per-app allowed-model enforcement: if the key restricts which models it can reach
  // and routing landed outside that set, fall back to the key's default or reject.
  if (appConfig.allowedModels?.length > 0 && !appConfig.allowedModels.includes(served.model)) {
    const fallbackKnown = appConfig.defaultModel ? pricing.getModel(appConfig.defaultModel) : null;
    if (fallbackKnown && eff.liveIds.includes(fallbackKnown.provider)) {
      pushOverride(explain, { type: "allowed", from: served.model, to: appConfig.defaultModel });
      served = { provider: fallbackKnown.provider, model: appConfig.defaultModel, knownPricing: true };
      routingDecision = "passthrough";
    } else {
      throw Object.assign(
        new Error(`Model "${served.model}" is not in the allowed set for this API key.`),
        { code: "model_not_allowed", status: 403 }
      );
    }
  }

  // Per-app model opt-out: if the resolved model is explicitly blocked for this app,
  // fall back to the default provider's default model.
  if (appDbConfig?.modelOptOut?.length > 0 && appDbConfig.modelOptOut.includes(served.model)) {
    const fallback = resolveDefault(body, eff);
    if (!appDbConfig.modelOptOut.includes(fallback.model)) {
      pushOverride(explain, { type: "optout", from: served.model, to: fallback.model });
      served = fallback;
      routingDecision = "passthrough";
    }
  }

  // The opt-out fallback resolves from the GLOBAL defaults, which know nothing about
  // this key's allowed set, so it can land back on the very model the allowed-check
  // just rejected (allowed → key default → opted out → global default). That used to
  // pass silently, so a key restricted to one model could still be served another.
  // Serving is preserved deliberately, so a policy conflict never breaks live traffic,
  // but the violation is recorded and the dashboard flags it.
  if (appConfig.allowedModels?.length > 0 && !appConfig.allowedModels.includes(served.model)) {
    explain.allowedViolation = { model: served.model, allowed: appConfig.allowedModels };
  }

  // qualityGate: only set when a human-approved rule (or canary promote path) chose the model.
  let qualityGate = null;
  if (routingDecision === "rule" && explain.qualityGate) {
    qualityGate = explain.qualityGate;
  } else if (routingDecision === "canary") {
    qualityGate = "passed"; // canaries require a passed offline eval before activation
  }

  return {
    served, routingDecision, taskType, classifiedBy,
    difficulty, difficultyScore, confidence, explain, qualityGate,
  };
}

async function handleChat(req, res) {
  const _reqStart = Date.now();
  const body = req.body || {};

  // 1 · INGRESS — validate, capture metadata, stamp id + time.
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  // Parallel: settings + appConfig + router are independent reads.
  const earlyApp = req.apiKey?.application || body.application || "unknown";
  const [settings, appCfg, routerResult] = await Promise.all([
    Settings.get(),
    getAppConfig(earlyApp),
    getRouter(),
  ]);

  if (settings.maintenanceMode?.enabled) {
    return res.status(503).json({
      error: "maintenance_mode",
      message: settings.maintenanceMode.message || "Service temporarily unavailable.",
    });
  }
  if (appCfg?.killSwitchEnabled) {
    return res.status(503).json({
      error: "app_kill_switch",
      message: appCfg.killSwitchMessage || `Application "${earlyApp}" is temporarily disabled.`,
    });
  }
  const { router, eff } = routerResult;
  if (!router) {
    return res.status(503).json({
      error: "demo_mode",
      message:
        "No provider keys configured — the live gateway is disabled. Add a key in the " +
        "dashboard (Settings → Connections) or set OPENAI_API_KEY / ANTHROPIC_API_KEY / " +
        "GEMINI_API_KEY in .env. Dashboards, analytics, recommendations and rules work without keys.",
    });
  }

  // Max-tokens guardrail: clamp body.maxTokens to the configured ceiling.
  if (settings.maxTokensGuardrail && body.maxTokens > settings.maxTokensGuardrail) {
    body.maxTokens = settings.maxTokensGuardrail;
  }

  // Prompt injection detection — checked before routing/invoke, always returns JSON.
  if (settings.promptInjectionDetectionEnabled) {
    const injApp = req.apiKey?.application || body.application || "unknown";
    const { blocked, ruleName } = promptInjection.check(body.messages, settings.promptInjectionRules, injApp);
    if (blocked) {
      return res.status(400).json({ error: "prompt_injection_detected", message: "Request blocked: potential prompt injection detected.", rule: ruleName });
    }
  }

  const requestId = uuidv4();
  const timestamp = new Date();
  const meta = {
    // A gateway API key binds attribution — it overrides what the body claims.
    application: req.apiKey?.application || body.application || "unknown",
    workflow: body.workflow || "unknown",
    userId: body.userId || null,
    department: body.department || "unknown",
    // W3C trace context, so the OTel span nests inside the caller's trace. Stripped
    // before the record is stored (see logging/logger.js). Spread into every log
    // call below via ...meta, so no per-call-site edits are needed.
    _traceparent: req.headers.traceparent,
    _tracestate: req.headers.tracestate,
  };

  // The developer's literal model intent, for the log ("auto" when deferred).
  const rawModel = (body.model || "").trim();
  const modelRequested = rawModel && rawModel.toLowerCase() !== "auto" ? rawModel : "auto";

  // 2 · MATCH
  const appConfig = {
    allowedModels: req.apiKey?.allowedModels || [],
    defaultModel: req.apiKey?.defaultModel || null,
  };
  let served, routingDecision, taskType, classifiedBy, difficulty, difficultyScore, confidence, explain, qualityGate;
  try {
    ({ served, routingDecision, taskType, classifiedBy, difficulty, difficultyScore, confidence, explain, qualityGate } =
      await resolveRoute(body, { router, eff, application: meta.application, workflow: meta.workflow, userId: meta.userId, appConfig, appDbConfig: appCfg }));
  } catch (err) {
    if (err.code === "model_not_allowed") {
      return res.status(403).json({ error: err.message, code: "model_not_allowed" });
    }
    throw err;
  }

  // The classifier's own spend is recorded by classify/classifier.js via
  // internal/complete.js — not here. It used to be logged at this call site, which meant
  // the OpenAI-compatible gateway (which shares resolveRoute) never logged it at all.

  // Budget enforcement — a breached enforcing cap outranks everything, including
  // explicit pins (that is the point of enforcement). block → 429; downgrade →
  // force the provider's light model while the window is breached.
  const enf = await capEngine.enforcement({ application: meta.application, provider: served.provider });
  if (enf) {
    if (enf.action === "block") {
      pushOverride(explain, { type: "budget", action: "block",
        cap: { scope: capEngine.describeScope(enf.cap), period: enf.cap.period, limit: enf.cap.limit } });
      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: served.provider, model: served.model, modelRequested,
          taskType, classifiedBy, latencyMs: 0, status: "blocked",
          routingDecision: "budget", cacheHit: false, routingExplain: explain,
        })
      );
      return res.status(429).json({
        error: "budget_exceeded",
        message: `Budget exceeded: ${capEngine.describeScope(enf.cap)} is over its ${enf.cap.period === "day" ? "daily" : "monthly"} limit ($${enf.cap.limit}).`,
      });
    }
    // downgrade
    const target = pricing.suggestLightTarget(served.model);
    if (target) {
      pushOverride(explain, { type: "budget", action: "downgrade", from: served.model, to: target.model,
        cap: { scope: capEngine.describeScope(enf.cap), period: enf.cap.period, limit: enf.cap.limit } });
      served = { provider: target.provider, model: target.model };
      routingDecision = "budget";
      qualityGate = null; // budget override is not eval-gated
    }
  }

  // Per-model output clamp: cap maxTokens to the SERVED model's known ceiling, so an
  // over-large client value doesn't 400 upstream. Only clamps when the cap is known
  // (populated by the LiteLLM sync); unknown → left untouched.
  body.maxTokens = pricing.clampMaxTokens(body.maxTokens, pricing.maxOutputFor(served.model));

  // Response cache, keyed by the decided served model.
  {
    const cached = responseCache.get(served.model, body.messages);
    if (cached) {
      // Apply output guardrails to cached responses too.
      if (settings.outputGuardrailsEnabled && settings.outputGuardrailRules?.length) {
        const { blocked, ruleName } = outputGuardrail.check(cached.text, settings.outputGuardrailRules, meta.application);
        if (blocked) {
          setImmediate(() =>
            logger.write({
              requestId, timestamp, ...meta,
              provider: cached.provider, model: cached.model, modelRequested,
              taskType, classifiedBy, latencyMs: 0,
              status: "blocked", routingDecision: "cache", cacheHit: true,
              errorMessage: `guardrail_violation: ${ruleName}`,
            })
          );
          return res.status(422).json({ error: "guardrail_violation", message: "Response blocked by content policy.", rule: ruleName });
        }
      }
      const cachedDeliveryText = settings.maskPiiInResponses
        ? outputGuardrail.maskPii(cached.text, settings.customPiiPatterns)
        : cached.text;
      res.set({
        "X-Arbr-Request-ID": requestId,
        "X-Arbr-Model":      cached.model,
        "X-Arbr-Provider":   cached.provider,
        "X-Arbr-Routing":    "cache",
        "X-Arbr-Task-Type":  taskType || "",
      }).json({
        requestId,
        model: cached.model,
        modelRequested,
        provider: cached.provider,
        routingDecision: "cache",
        classifiedBy,
        cacheHit: true,
        text: cachedDeliveryText,
        usage: cached.usage,
      });
      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: cached.provider, model: cached.model, modelRequested,
          taskType, classifiedBy, difficulty, difficultyScore, confidence,
          promptTokens: cached.usage?.inputTokens || 0,
          completionTokens: cached.usage?.outputTokens || 0,
          totalTokens: cached.usage?.totalTokens || 0,
          latencyMs: 0, status: "success",
          routingDecision: "cache", cacheHit: true, routingExplain: explain,
          messages: body.messages, responseText: cached.text,
        })
      );
      return;
    }
  }

  // Semantic cache — embedding similarity match (async; requires OpenAI key).
  // Only reached on exact-match miss so it never adds latency to cache hits.
  if (settings.semanticCacheEnabled) {
    const semCached = await semanticCache.get(body.messages, settings.semanticCacheThreshold, settings.semanticCacheTtlMinutes).catch(() => null);
    if (semCached) {
      if (settings.outputGuardrailsEnabled && settings.outputGuardrailRules?.length) {
        const { blocked, ruleName } = outputGuardrail.check(semCached.text, settings.outputGuardrailRules, meta.application);
        if (blocked) {
          setImmediate(() =>
            logger.write({
              requestId, timestamp, ...meta,
              provider: semCached.provider, model: semCached.model, modelRequested,
              taskType, classifiedBy, latencyMs: 0,
              status: "blocked", routingDecision: "semantic_cache", cacheHit: true,
              errorMessage: `guardrail_violation: ${ruleName}`,
            })
          );
          return res.status(422).json({ error: "guardrail_violation", message: "Response blocked by content policy.", rule: ruleName });
        }
      }
      const semDeliveryText = settings.maskPiiInResponses
        ? outputGuardrail.maskPii(semCached.text, settings.customPiiPatterns) : semCached.text;
      res.set({
        "X-Arbr-Request-ID": requestId,
        "X-Arbr-Model":      semCached.model,
        "X-Arbr-Provider":   semCached.provider,
        "X-Arbr-Routing":    "semantic_cache",
        "X-Arbr-Task-Type":  taskType || "",
      }).json({
        requestId, model: semCached.model, modelRequested, provider: semCached.provider,
        routingDecision: "semantic_cache", classifiedBy, cacheHit: true,
        text: semDeliveryText, usage: semCached.usage,
      });
      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: semCached.provider, model: semCached.model, modelRequested,
          taskType, classifiedBy, difficulty, difficultyScore, confidence,
          promptTokens: semCached.usage?.inputTokens || 0,
          completionTokens: semCached.usage?.outputTokens || 0,
          totalTokens: semCached.usage?.totalTokens || 0,
          latencyMs: 0, status: "success",
          routingDecision: "semantic_cache", cacheHit: true, routingExplain: explain,
          messages: body.messages, responseText: semCached.text,
        })
      );
      return;
    }
  }

  // 3 · INVOKE — provider call, fallback on failure.
  const gatewayOverheadMs = Date.now() - _reqStart;
  let invocation;
  try {
    invocation = await invokeWithFallback(router, eff, {
      provider: served.provider,
      model: served.model,
      messages: body.messages,
      temperature: body.temperature,
      maxTokens: body.maxTokens,
    });
  } catch (err) {
    const errorMessage = String(err.message || err);
    setImmediate(() =>
      logger.write({
        requestId, timestamp, ...meta,
        provider: served.provider, model: served.model, modelRequested,
        taskType, classifiedBy, latencyMs: 0, status: "failure", routingDecision,
        errorMessage, routingExplain: explain,
      })
    );
    return res.status(502).json({ error: "provider_error", message: errorMessage });
  }

  const { result, usedFallback } = invocation;
  if (usedFallback) {
    routingDecision = "fallback";
    pushOverride(explain, { type: "fallback", from: served.model, to: result.modelId });
    qualityGate = null;
  }

  // Output guardrail — deny-list checked before sending response to caller.
  if (settings.outputGuardrailsEnabled && settings.outputGuardrailRules?.length) {
    const { blocked, ruleName } = outputGuardrail.check(result.text, settings.outputGuardrailRules, meta.application);
    if (blocked) {
      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: result.providerId, model: result.modelId, modelRequested,
          taskType, classifiedBy, latencyMs: result.latencyMs,
          status: "blocked", routingDecision, cacheHit: false,
          errorMessage: `guardrail_violation: ${ruleName}`,
        })
      );
      return res.status(422).json({
        error: "guardrail_violation",
        message: "Response blocked by content policy.",
        rule: ruleName,
      });
    }
  }

  // PII live masking: redact PII from the text delivered to the caller (response + cache entry).
  const deliveryText = settings.maskPiiInResponses
    ? outputGuardrail.maskPii(result.text, settings.customPiiPatterns)
    : result.text;

  // 4 · RETURN — response on its way back immediately.
  res.set({
    "X-Arbr-Request-ID": requestId,
    "X-Arbr-Model":      result.modelId,
    "X-Arbr-Provider":   result.providerId,
    "X-Arbr-Routing":    routingDecision,
    "X-Arbr-Task-Type":  taskType || "",
  }).json({
    requestId,
    model: result.modelId,
    modelRequested,
    provider: result.providerId,
    routingDecision,
    classifiedBy,
    cacheHit: false,
    text: deliveryText,
    usage: result.usage,
  });

  // 5 · AFTER THE RESPONSE — cache + log (cost computed in the logger).
  setImmediate(() => {
    const cacheValue = { model: result.modelId, provider: result.providerId, text: deliveryText, usage: result.usage };
    responseCache.set(served.model, body.messages, cacheValue);
    if (settings.semanticCacheEnabled) {
      semanticCache.set(body.messages, cacheValue, settings.semanticCacheTtlMinutes).catch(() => {});
    }
    logger.write({
      requestId, timestamp, ...meta,
      provider: result.providerId, model: result.modelId, modelRequested,
      taskType, classifiedBy, difficulty, difficultyScore, confidence, routingExplain: explain,
      promptTokens: result.usage?.inputTokens || 0,
      completionTokens: result.usage?.outputTokens || 0,
      totalTokens: result.usage?.totalTokens || 0,
      cachedReadTokens: result.usage?.cachedReadTokens || 0,
      cacheWriteTokens: result.usage?.cacheWriteTokens || 0,
      latencyMs: result.latencyMs, gatewayOverheadMs, status: "success",
      routingDecision, cacheHit: false, qualityGate: qualityGate || null,
      knownPricing: served.knownPricing,
      messages: body.messages, responseText: result.text,
    });
    // Shadow-eval: mirror to a candidate model if a campaign is active for this app (self-guarded, non-blocking).
    maybeShadowEval({
      application: meta.application, workflow: meta.workflow, taskType, messages: body.messages, hasTools: false, requestId, router, eff,
      prod: { model: result.modelId, provider: result.providerId, latencyMs: result.latencyMs, text: result.text, usage: result.usage },
    });
  });
}

module.exports = {
  handleChat,
  resolveRoute,
  invokeWithFallback,
  buildFallbackOrder,
  getAppConfig,
};
