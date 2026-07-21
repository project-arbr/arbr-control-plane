// Pure mapping from a RequestRecord-shaped object to OpenTelemetry span data.
// No @opentelemetry/* import here — otel.js owns the SDK. Nearly all the logic
// lives in this file, so it unit-tests without loading the SDK.
//
// The GenAI semantic conventions are still evolving; attribute names may shift
// between versions. Keeping the whole mapping here means a rename is a one-file
// change. Cost (`gen_ai.usage.cost`) and the message-content attributes are the
// least stable; treat them as de-facto.

// Arbr provider id → OTel gen_ai.system value. semconv is unstable on the exact
// strings, so unmapped ids pass through verbatim.
const PROVIDER_MAP = {
  openai: "openai",
  anthropic: "anthropic",
  gemini: "gcp.gemini",
  "bedrock-nova": "aws.bedrock",
  deepseek: "deepseek",
  moonshot: "moonshot",
  xai: "xai",
  groq: "groq",
  litellm: "litellm",
};

function providerName(p) {
  return p ? (PROVIDER_MAP[p] || p) : undefined;
}

function operationName(record) {
  return record.taskType === "embedding" ? "embeddings" : "chat";
}

// Span name: "{operation} {served-model}". The spec says name with the request
// model, but Arbr's modelRequested is literally "auto" on routed traffic, which
// makes every span read "chat auto". Name with the SERVED model and record both
// as attributes.
function spanName(record) {
  const op = operationName(record);
  return record.model ? `${op} ${record.model}` : op;
}

function set(a, key, val) {
  if (val !== undefined && val !== null && val !== "") a[key] = val;
}

function clamp(s, n) {
  return s.length > n ? s.slice(0, n) : s;
}

function attributesFor(record, { captureContent = false, contentMaxChars = 8192 } = {}) {
  const a = {};
  const provider = providerName(record.provider);

  // GenAI semantic conventions.
  set(a, "gen_ai.operation.name", operationName(record));
  set(a, "gen_ai.system", provider);        // legacy name, still what most backends key on
  set(a, "gen_ai.provider.name", provider); // newer name, emitted during the transition
  set(a, "gen_ai.request.model", record.modelRequested);
  set(a, "gen_ai.response.model", record.model);
  set(a, "gen_ai.response.id", record.requestId);
  if (record.promptTokens != null) a["gen_ai.usage.input_tokens"] = record.promptTokens;
  if (record.completionTokens != null) a["gen_ai.usage.output_tokens"] = record.completionTokens;
  if (record.totalCost != null) a["gen_ai.usage.cost"] = record.totalCost; // non-standard, de-facto

  // Standard non-GenAI.
  set(a, "user.id", record.userId);

  // arbr.* — everything semconv has no home for. Flat scalars (queryable in every
  // backend), never nested JSON.
  set(a, "arbr.request_id", record.requestId);
  set(a, "arbr.application", record.application);
  set(a, "arbr.workflow", record.workflow);
  set(a, "arbr.department", record.department);
  set(a, "arbr.task_type", record.taskType);
  set(a, "arbr.classified_by", record.classifiedBy);
  set(a, "arbr.difficulty", record.difficulty);
  if (record.difficultyScore != null) a["arbr.difficulty_score"] = record.difficultyScore;
  if (record.confidence != null) a["arbr.confidence"] = record.confidence;
  set(a, "arbr.routing.decision", record.routingDecision);
  if (record.cacheHit != null) a["arbr.cache.hit"] = !!record.cacheHit;
  if (record.cachedReadTokens) a["arbr.cache.read_tokens"] = record.cachedReadTokens;
  if (record.cacheSavingUsd) a["arbr.cache.saving_usd"] = record.cacheSavingUsd;
  if (record.inputCost != null) a["arbr.cost.input_usd"] = record.inputCost;
  if (record.outputCost != null) a["arbr.cost.output_usd"] = record.outputCost;
  if (record.totalCost != null) a["arbr.cost.total_usd"] = record.totalCost;
  if (record.knownPricing != null) a["arbr.cost.known_pricing"] = record.knownPricing !== false;
  if (record.latencyMs != null) a["arbr.latency_ms"] = record.latencyMs;
  if (record.ttftMs != null) a["arbr.ttft_ms"] = record.ttftMs;
  if (record.gatewayOverheadMs != null) a["arbr.gateway_overhead_ms"] = record.gatewayOverheadMs;
  // status has three values (success|failure|blocked); OTel status has two, so keep it.
  set(a, "arbr.status", record.status);
  set(a, "arbr.internal_kind", record.internalKind);
  set(a, "arbr.source", record.source);

  // routingExplain (a Mixed field) flattened to scalars.
  const ex = record.routingExplain;
  if (ex && typeof ex === "object") {
    set(a, "arbr.routing.basis", ex.basis);
    if (ex.rule && ex.rule.note) set(a, "arbr.routing.rule", ex.rule.note);
    if (ex.override && ex.override.type) set(a, "arbr.routing.override_type", ex.override.type);
  }

  // Content — opt-in, clamped small. Collectors drop oversized spans, so one long
  // prompt would otherwise lose the whole trace. This is the least-stable mapping.
  if (captureContent) {
    if (record.messages) a["gen_ai.input.messages"] = clamp(JSON.stringify(record.messages), contentMaxChars);
    if (record.responseText) a["gen_ai.output.messages"] = clamp(String(record.responseText), contentMaxChars);
  }

  return a;
}

// OTel status is two-valued. success → UNSET (setting OK overrides a backend's own
// error heuristics); failure and blocked → ERROR. arbr.status keeps the full three.
function spanStatus(record) {
  if (record.status === "failure") return { code: "ERROR", message: record.errorMessage || "request failed" };
  if (record.status === "blocked") return { code: "ERROR", message: record.errorMessage || "blocked" };
  return { code: "UNSET" };
}

// A normalized error.type token for non-success spans.
function errorType(record) {
  if (record.status === "success") return undefined;
  const m = String(record.errorMessage || "").toLowerCase();
  if (record.status === "blocked") {
    if (m.includes("budget") || m.includes("cap")) return "budget_exceeded";
    if (m.includes("guardrail")) return "guardrail_violation";
    if (m.includes("injection")) return "prompt_injection";
    if (m.includes("kill") || m.includes("maintenance") || m.includes("disabled")) return "app_disabled";
    return "blocked";
  }
  return "provider_error";
}

// Span timing. start = record.timestamp; end = start + latencyMs, clamped to a 1ms
// floor so zero-latency failure records still render. Some records (embeddings,
// realtime) carry no timestamp — fall back to now - latency.
function timing(record, now = Date.now()) {
  const latency = Math.max(1, Number(record.latencyMs) || 0);
  const start = record.timestamp ? new Date(record.timestamp).getTime() : now - latency;
  return { startMs: start, endMs: start + latency };
}

// The sampling decision, made here (not via an SDK sampler) so two policies the
// sampler can't see always apply: honor a sampled parent (never leave a hole in the
// caller's trace), and never drop a failure or a block. rng is injectable for tests.
function shouldSample(record, parent, ratio, rng = Math.random) {
  if (parent && parent.sampled) return true;
  if (record.status && record.status !== "success") return true;
  if (ratio >= 1) return true;
  if (ratio <= 0) return false;
  return rng() < ratio;
}

module.exports = {
  attributesFor, spanName, spanStatus, errorType, timing, shouldSample,
  operationName, providerName,
};
