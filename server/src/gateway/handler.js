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
const capEngine = require("../routing/capEngine");
const responseCache = require("../routing/responseCache");
const logger = require("../logging/logger");
const Settings = require("../models/Settings");
const ApplicationConfig = require("../models/ApplicationConfig");

// Short-lived cache to avoid a DB hit per request for app configs.
const _appConfigCache = new Map(); // appName → { cfg, expiresAt }
async function getAppConfig(appName) {
  if (!appName || appName === "unknown") return null;
  const cached = _appConfigCache.get(appName);
  if (cached && cached.expiresAt > Date.now()) return cached.cfg;
  const cfg = await ApplicationConfig.findOne({ applicationName: appName }).lean().catch(() => null);
  _appConfigCache.set(appName, { cfg, expiresAt: Date.now() + 30_000 });
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

// Try the chosen provider; on failure, retry the remaining live providers
// (their default model). Returns { result, usedFallback }.
async function invokeWithFallback(router, eff, { provider, model, messages, temperature, maxTokens }) {
  const order = [provider, ...eff.liveIds.filter((p) => p !== provider)];
  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    const m = i === 0 ? model : config.defaultModels[p];
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
// Returns { served, routingDecision, taskType, classifiedBy, cls }.
// Callers are responsible for budget enforcement (it may short-circuit the response).
async function resolveRoute(body, { router, eff, application, workflow, appConfig = {}, appDbConfig = null }) {
  const routingMode = await ruleEngine.getRoutingMode();
  const explicit = resolveExplicit(body, eff);
  const autoMode = !explicit;
  const providedTaskType = !!(body.taskType && String(body.taskType).trim());

  const cls = await classifyTask({
    taskType: body.taskType,
    messages: body.messages,
    router, eff,
    useLLM: routingMode === "ai" && autoMode && !providedTaskType,
  });
  const taskType = cls.taskType;
  const classifiedBy = cls.method;
  const difficulty = cls.difficulty || null;
  const confidence = typeof cls.confidence === "number" ? cls.confidence : null;

  let served, routingDecision;
  if (explicit) {
    served = explicit;
    routingDecision = "explicit";
  } else {
    served = resolveDefault(body, eff);
    routingDecision = "passthrough";
    // Per-app default: override the global default model when the key specifies one.
    if (appConfig.defaultModel) {
      const known = pricing.getModel(appConfig.defaultModel);
      if (known && eff.liveIds.includes(known.provider)) {
        served = { provider: known.provider, model: appConfig.defaultModel, knownPricing: true };
      }
    }
    const route = await ruleEngine.findRoute({ taskType, application, workflow });
    if (route) {
      served = { provider: route.provider, model: route.model };
      routingDecision = "rule";
    } else if (routingMode === "ai") {
      const aiMap = appDbConfig?.aiPolicyAssignments
        ? appDbConfig.aiPolicyAssignments
        : await aiPolicy.getEffective();
      // A low-confidence classification shouldn't drive a difficulty-based downgrade;
      // fall back to the task's default policy pick when we're unsure.
      const effDifficulty = (confidence == null || confidence >= 0.5) ? difficulty : null;
      const hit = aiPolicy.resolveModel({ map: aiMap, taskType, difficulty: effDifficulty, eff });
      if (hit && eff.liveIds.includes(hit.provider)) {
        served = { provider: hit.provider, model: hit.model };
        routingDecision = "ai";
      }
    } else if (routingMode === "guardrail") {
      const policy = await policyEngine.getEffective();
      const auto = autoRouter.selectAutoRoute({ taskType, requested: served }, policy);
      if (auto) {
        served = { provider: auto.provider, model: auto.model };
        routingDecision = "auto";
      }
    }
  }

  // Per-app allowed-model enforcement: if the key restricts which models it can reach
  // and routing landed outside that set, fall back to the key's default or reject.
  if (appConfig.allowedModels?.length > 0 && !appConfig.allowedModels.includes(served.model)) {
    const fallbackKnown = appConfig.defaultModel ? pricing.getModel(appConfig.defaultModel) : null;
    if (fallbackKnown && eff.liveIds.includes(fallbackKnown.provider)) {
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
      served = fallback;
      routingDecision = "passthrough";
    }
  }

  return { served, routingDecision, taskType, classifiedBy, cls, difficulty, confidence };
}

async function handleChat(req, res) {
  const body = req.body || {};

  // 1 · INGRESS — validate, capture metadata, stamp id + time.
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({ error: "messages array is required" });
  }

  // Maintenance mode (kill-switch): checked before any routing or provider access.
  const settings = await Settings.get();
  if (settings.maintenanceMode?.enabled) {
    return res.status(503).json({
      error: "maintenance_mode",
      message: settings.maintenanceMode.message || "Service temporarily unavailable.",
    });
  }

  // Per-application kill switch — checked before attribution is fully resolved,
  // using the body's application claim (key binding happens later).
  const earlyApp = req.apiKey?.application || body.application || "unknown";
  const appCfg = await getAppConfig(earlyApp);
  if (appCfg?.killSwitchEnabled) {
    return res.status(503).json({
      error: "app_kill_switch",
      message: appCfg.killSwitchMessage || `Application "${earlyApp}" is temporarily disabled.`,
    });
  }

  const { router, eff } = await getRouter();
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

  const requestId = uuidv4();
  const timestamp = new Date();
  const meta = {
    // A gateway API key binds attribution — it overrides what the body claims.
    application: req.apiKey?.application || body.application || "unknown",
    workflow: body.workflow || "unknown",
    userId: body.userId || null,
    department: body.department || "unknown",
  };

  // The developer's literal model intent, for the log ("auto" when deferred).
  const rawModel = (body.model || "").trim();
  const modelRequested = rawModel && rawModel.toLowerCase() !== "auto" ? rawModel : "auto";

  // 2 · MATCH
  const appConfig = {
    allowedModels: req.apiKey?.allowedModels || [],
    defaultModel: req.apiKey?.defaultModel || null,
  };
  let served, routingDecision, taskType, classifiedBy, cls, difficulty, confidence;
  try {
    ({ served, routingDecision, taskType, classifiedBy, cls, difficulty, confidence } =
      await resolveRoute(body, { router, eff, application: meta.application, workflow: meta.workflow, appConfig, appDbConfig: appCfg }));
  } catch (err) {
    if (err.code === "model_not_allowed") {
      return res.status(403).json({ error: err.message, code: "model_not_allowed" });
    }
    throw err;
  }

  if (cls.llm) {
    setImmediate(() =>
      logger.write({
        requestId: uuidv4(), timestamp: new Date(),
        application: "arbr-internal", workflow: "auto-classifier",
        userId: null, department: "arbr",
        provider: cls.llm.provider, model: cls.llm.model, modelRequested: cls.llm.model,
        taskType: "classification",
        promptTokens: cls.llm.usage?.inputTokens || 0,
        completionTokens: cls.llm.usage?.outputTokens || 0,
        totalTokens: cls.llm.usage?.totalTokens || 0,
        latencyMs: cls.llm.latencyMs || 0, status: "success",
        routingDecision: "passthrough", cacheHit: false,
      })
    );
  }

  // Budget enforcement — a breached enforcing cap outranks everything, including
  // explicit pins (that is the point of enforcement). block → 429; downgrade →
  // force the provider's light model while the window is breached.
  const enf = await capEngine.enforcement({ application: meta.application, provider: served.provider });
  if (enf) {
    if (enf.action === "block") {
      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: served.provider, model: served.model, modelRequested,
          taskType, classifiedBy, latencyMs: 0, status: "blocked",
          routingDecision: "budget", cacheHit: false,
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
      served = { provider: target.provider, model: target.model };
      routingDecision = "budget";
    }
  }

  // Response cache, keyed by the decided served model.
  {
    const cached = responseCache.get(served.model, body.messages);
    if (cached) {
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
        text: cached.text,
        usage: cached.usage,
      });
      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: cached.provider, model: cached.model, modelRequested,
          taskType, classifiedBy, difficulty, confidence,
          promptTokens: cached.usage?.inputTokens || 0,
          completionTokens: cached.usage?.outputTokens || 0,
          totalTokens: cached.usage?.totalTokens || 0,
          latencyMs: 0, status: "success",
          routingDecision: "cache", cacheHit: true,
        })
      );
      return;
    }
  }

  // 3 · INVOKE — provider call, fallback on failure.
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
        errorMessage,
      })
    );
    return res.status(502).json({ error: "provider_error", message: errorMessage });
  }

  const { result, usedFallback } = invocation;
  if (usedFallback) routingDecision = "fallback";

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
    text: result.text,
    usage: result.usage,
  });

  // 5 · AFTER THE RESPONSE — cache + log (cost computed in the logger).
  setImmediate(() => {
    responseCache.set(served.model, body.messages, {
      model: result.modelId,
      provider: result.providerId,
      text: result.text,
      usage: result.usage,
    });
    logger.write({
      requestId, timestamp, ...meta,
      provider: result.providerId, model: result.modelId, modelRequested,
      taskType, classifiedBy, difficulty, confidence,
      promptTokens: result.usage?.inputTokens || 0,
      completionTokens: result.usage?.outputTokens || 0,
      totalTokens: result.usage?.totalTokens || 0,
      cachedReadTokens: result.usage?.cachedReadTokens || 0,
      cacheWriteTokens: result.usage?.cacheWriteTokens || 0,
      latencyMs: result.latencyMs, status: "success",
      routingDecision, cacheHit: false,
      knownPricing: served.knownPricing,
    });
  });
}

module.exports = { handleChat, resolveRoute, invokeWithFallback };
