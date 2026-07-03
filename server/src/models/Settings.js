// Singleton runtime settings, flippable from the dashboard without a redeploy:
// routing mode, automated-routing policies, default provider/model, API-key
// requirement. Created on first read.
const mongoose = require("mongoose");
const { config } = require("../config");

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
    // Tracks the last applied seedModels.js version. registry.init() re-seeds when this
    // differs from SEED_VERSION in seedModels.js.
    modelSeedVersion: { type: Number, default: null },
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
    retentionDays: { type: Number, default: 90 },
    // PII masking: when enabled, PII patterns are redacted from prompts before logging.
    piiMaskingEnabled: { type: Boolean, default: false },
    // Custom PII patterns (admin-defined regex strings applied in addition to built-ins).
    customPiiPatterns: { type: [{ name: String, pattern: String }], default: [] },
    // Global gateway rate limit. When set, all requests across all API keys share this RPM ceiling.
    globalRpmGuardrail: { type: Number, default: null },
    // When false, messages and responseText are NOT stored in RequestRecord. Costs, latency, and
    // routing metadata are always logged regardless.
    captureRequestPayloads: { type: Boolean, default: true },
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
  },
  { collection: "settings" }
);

settingsSchema.statics.get = async function get() {
  let doc = await this.findOne({ key: "global" });
  if (!doc) {
    doc = await this.create({ key: "global" });
  }
  return doc;
};

module.exports = mongoose.model("Settings", settingsSchema);
