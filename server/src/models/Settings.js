// Singleton runtime settings, flippable from the dashboard without a redeploy:
// routing mode, automated-routing policies, default provider/model, API-key
// requirement. Created on first read.
const mongoose = require("mongoose");
const { config } = require("../config");

function privacyDefaults(isProduction = config.isProduction) {
  return isProduction
    ? { retentionDays: 30, piiMaskingEnabled: true, captureRequestPayloads: false }
    : { retentionDays: 90, piiMaskingEnabled: false, captureRequestPayloads: true };
}

const PRIVACY_DEFAULTS = privacyDefaults();

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: "global", unique: true },
    // Auto-mode routing engine: "off" (serve default) | "guardrail" (heuristic cost
    // downgrade) | "ai" (AI-generated task→model policy). Legacy `autoRouting` bool is
    // migrated on read (true → "guardrail").
    routingMode: { type: String, enum: ["off", "guardrail", "ai"], default: null },
    // When true, /v1/* requires a valid gateway API key (default off — backward compatible).
    requireApiKey: { type: Boolean, default: false },
    autoRouting: { type: Boolean, default: false }, // legacy — kept for migration
    modelSeedVersion: { type: Number, default: null }, // legacy — no longer used
    // AI-generated routing policy: task type → model id, editable + regeneratable.
    aiPolicy: {
      assignments:       { type: mongoose.Schema.Types.Mixed, default: null },
      generatedAt:       { type: Date,   default: null },
      generatorModel:    { type: String, default: null },
      capabilityVersion: { type: Number, default: null },
    },
    // Editable knobs for the automated-routing cost guardrail. null fields fall back
    // to the hardcoded defaults in pricing/table.js (so behaviour is unchanged until edited).
    //   cheapTaskTypes: string[] — task types eligible for downgrade
    //   lightTargets:   { [provider]: modelId } — the downgrade target per provider
    //   mode: "conservative" (downgrade premium only) | "aggressive" (downgrade anything
    //         costlier than the target)
    policy: {
      cheapTaskTypes: { type: [String], default: null },
      lightTargets: { type: mongoose.Schema.Types.Mixed, default: null },
      mode: { type: String, enum: ["conservative", "aggressive"], default: "conservative" },
    },
    // Preferred default provider chosen in the dashboard (null = fall back to env / first live).
    defaultProvider: { type: String, default: null },
    // Preferred default MODEL (applies to the default provider; null = that provider's built-in default).
    defaultModel: { type: String, default: null },
    livebenchSyncedAt: { type: Date,   default: null },
    livebenchVersion:  { type: String, default: null },
    lmsysSyncedAt:     { type: Date,   default: null },
    lmsysVersion:      { type: String, default: null },
    litellmSyncedAt:   { type: Date,   default: null },
    litellmVersion:    { type: String, default: null },
    // Maintenance / kill-switch: when enabled, all /v1/* gateway calls return 503.
    maintenanceMode: {
      enabled: { type: Boolean, default: false },
      message: { type: String, default: "Service temporarily unavailable for maintenance." },
    },
    // Hard cap on max_tokens per request. When set, requests claiming more are clamped.
    // Prevents runaway expensive completions from any single call.
    maxTokensGuardrail: { type: Number, default: null },
    // Webhook URL for real-time alerts (cap breach, provider errors, new unknown applications).
    webhookUrl: { type: String, default: null },
    // Request record retention in days. Records older than this are auto-purged daily.
    retentionDays: { type: Number, default: PRIVACY_DEFAULTS.retentionDays },
    // PII masking: when enabled, PII patterns are redacted from prompts before logging.
    piiMaskingEnabled: { type: Boolean, default: PRIVACY_DEFAULTS.piiMaskingEnabled },
    // Custom PII patterns (admin-defined regex strings applied in addition to built-ins).
    customPiiPatterns: { type: [{ name: String, pattern: String }], default: [] },
    // Global gateway rate limit. When set, all requests across all API keys share this RPM ceiling.
    globalRpmGuardrail: { type: Number, default: null },
    // When false, messages and responseText are NOT stored in RequestRecord. Costs, latency, and
    // routing metadata are always logged regardless.
    captureRequestPayloads: { type: Boolean, default: PRIVACY_DEFAULTS.captureRequestPayloads },
    // Error-rate alerting: fires the webhook when the rolling 1-hour error rate exceeds threshold.
    alertErrorRateEnabled:   { type: Boolean, default: false },
    alertErrorRateThreshold: { type: Number,  default: 5 },  // percent, 0–100
    // Output guardrails: keyword/regex deny-list checked against response text before returning to caller.
    outputGuardrailsEnabled: { type: Boolean, default: false },
    outputGuardrailRules: {
      type: [{
        name:        String,
        pattern:     String,
        // "*" = all applications; any other string = specific application name.
        application: { type: String, default: "*" },
      }],
      default: [],
    },
    // When true, PII patterns (built-in + custom) are redacted from the response text sent to callers,
    // not just from stored logs.
    maskPiiInResponses: { type: Boolean, default: false },
    // Prompt injection detection: blocks requests whose user/tool messages match known injection patterns.
    promptInjectionDetectionEnabled: { type: Boolean, default: false },
    promptInjectionRules: {
      type: [{
        name:        String,
        pattern:     String,
        application: { type: String, default: "*" },
      }],
      default: [],
    },
    // Semantic response cache: embed incoming messages and return a cached response
    // when cosine similarity exceeds the threshold. Requires OPENAI_API_KEY.
    semanticCacheEnabled:      { type: Boolean, default: false },
    semanticCacheThreshold:    { type: Number,  default: 0.92 },  // 0–1 cosine similarity
    semanticCacheTtlMinutes:   { type: Number,  default: 60 },    // cache TTL in minutes

    // Runtime overrides for OTLP trace export. ARBR_OTEL_ENABLED (env) is the HARD
    // gate — whether the exporter is loaded at all; these only narrow an env-enabled
    // exporter, so an operator can pause tracing or retune it without a redeploy.
    //   enabled:        soft on/off. null = on (default when env-enabled).
    //   sampleRatio:    0–1 head sampling. null = use ARBR_OTEL_SAMPLE_RATIO.
    //   captureContent: put prompt/response on spans. null = use ARBR_OTEL_CAPTURE_CONTENT.
    otel: {
      enabled:        { type: Boolean, default: null },
      sampleRatio:    { type: Number,  default: null },
      captureContent: { type: Boolean, default: null },
    },
  },
  { collection: "settings" }
);

let _cache = { doc: null, at: 0 };
const CACHE_TTL_MS = 5_000;

settingsSchema.statics.get = async function get() {
  if (_cache.doc && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.doc;
  let doc = await this.findOne({ key: "global" });
  if (!doc) {
    doc = await this.create({ key: "global" });
  }
  _cache = { doc, at: Date.now() };
  return doc;
};

settingsSchema.statics.invalidateCache = function invalidateCache() {
  _cache.at = 0;
};

module.exports = mongoose.model("Settings", settingsSchema);
module.exports.privacyDefaults = privacyDefaults;
