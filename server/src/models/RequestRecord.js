// One record per AI request — the source of every view, report and saving.
// Records BOTH the model requested and the model served (scope p.10) so realised
// savings are measurable and later phases can learn which substitutions held up.
const mongoose = require("mongoose");

// The kinds of LLM call Arbr makes on its own behalf. One entry per internal call
// site; see server/src/internal/ for the wrapper that stamps these.
const INTERNAL_KINDS = [
  "classifier",         // routing-path task classification
  "policy-generation",  // AI routing policy / per-app policy generation
  "shadow-candidate",   // shadow campaign candidate call
  "shadow-judge",       // shadow campaign LLM-as-judge
  "eval-replay",        // eval run candidate replay
  "eval-judge",         // eval run rubric judge
  "eval-disprove",      // eval run "disprove worse" second pass
  "connection-test",    // admin: test a provider connection
  "model-test",         // admin: test a registry model
];

const requestRecordSchema = new mongoose.Schema(
  {
    requestId: { type: String, required: true, unique: true, index: true },
    timestamp: { type: Date, required: true, default: Date.now, index: true },

    // who / what
    application: { type: String, index: true },
    workflow: { type: String, index: true },
    userId: { type: String, index: true },
    department: { type: String, index: true },

    // model — requested vs actually served
    provider: { type: String, index: true }, // provider served
    model: { type: String, index: true },     // model served
    modelRequested: { type: String, index: true },
    taskType: { type: String, index: true },

    // usage
    promptTokens: { type: Number, default: 0 },      // TOTAL input, including any cached tokens
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },
    // Provider prompt-cache breakdown (subset of promptTokens) + the $ saved on cached reads
    // vs paying full input rate. Lets analytics show cache hit-rate and cache ROI.
    cachedReadTokens: { type: Number, default: 0 },
    cacheWriteTokens: { type: Number, default: 0 },
    cacheSavingUsd: { type: Number, default: 0 },

    // cost (USD)
    inputCost: { type: Number, default: 0 },
    outputCost: { type: Number, default: 0 },
    totalCost: { type: Number, default: 0, index: true },
    // false = pass-through model with no pricing entry; cost is logged as $0 and must be
    // EXCLUDED from spend/savings claims rather than treated as free. Surfaced in analytics.
    knownPricing: { type: Boolean, default: true, index: true },

    // Non-null = a call Arbr made FOR ITSELF (task classification, policy generation,
    // eval judging, connection tests) rather than customer traffic it proxied. This is
    // real money on the customer's provider key, so it COUNTS in headline spend — but it
    // is excluded from every per-application / workflow / user dimension view, from
    // facets, recommendations, eval datasets and error alerting, because it belongs to
    // no customer application.
    //
    // null (or absent, on records written before this field existed) = customer traffic.
    // Mongo matches missing fields with `{ internalKind: null }`, so the exclusion
    // predicate is already correct for historical records without a backfill.
    internalKind: {
      type: String,
      enum: [...INTERNAL_KINDS, null],
      default: null,
      index: true, // deliberately not sparse: null is the value most queries filter on
    },
    // Debug-only provenance (which request/campaign/run triggered this overhead).
    // Deliberately NOT a top-level indexed dimension, so no group-by can surface it.
    internalContext: { type: mongoose.Schema.Types.Mixed, default: null },

    // Non-null = reported via POST /v1/ingest (F-01: observe-only) rather than a live
    // call through Arbr's own gateway. Unlike internalKind, this is NOT excluded from
    // customer views by default — it's real partner spend, just via a different intake
    // path — only made *filterable* (see analytics buildMatch / GET /api/requests).
    // null = today's implicit truth for every native record; no backfill needed, since
    // this concept didn't exist before this field was added.
    source: { type: String, enum: ["ingested", null], default: null, index: true },
    // The caller's own id from an ingested event, kept only for display/reference.
    // The enforced-unique `requestId` above is namespaced per-key for ingested rows
    // (see server/src/api/routes/ingest.js) so two integrations can't collide.
    externalRequestId: { type: String, default: null },

    // true = written by the design-partner demo fixture (F-06), never real traffic. Lets
    // `npm run demo:reset` find and delete every fixture-owned document with one scoped
    // query, without touching anything real. Default false = today's behavior for every
    // existing and future non-fixture record; no backfill needed.
    isDemoFixture: { type: Boolean, default: false, index: true },

    // performance + outcome
    latencyMs: { type: Number, default: 0 },
    // Time-to-first-token in ms (streaming proxy path only; null for non-streaming or LangChain path).
    ttftMs: { type: Number, default: null },
    // Gateway processing overhead in ms before the LLM call was dispatched (excludes provider time).
    gatewayOverheadMs: { type: Number, default: null },
    status: { type: String, enum: ["success", "failure", "blocked"], default: "success", index: true },
    errorMessage: { type: String, default: null },   // provider error text on status:"failure"
    retryCount: { type: Number, default: 0 },

    // routing transparency
    routingDecision: {
      type: String,
      enum: ["passthrough", "explicit", "rule", "auto", "ai", "budget", "cache", "fallback", "canary", "external"],
      default: "passthrough",
      index: true,
    },
    // How the taskType was determined: app-provided, keyword heuristic, or AI classifier.
    classifiedBy: { type: String, enum: ["provided", "keyword", "ai"], default: "keyword", index: true },
    // Estimated difficulty of this instance (drives difficulty-aware model selection) and the
    // classifier's confidence (0-1) in the taskType. Null when not estimated (e.g. provided taskType).
    difficulty: { type: String, enum: ["light", "mid", "premium", null], default: null },
    // Finer 1-10 difficulty estimate (the tier above is derived from it). Captured for analysis;
    // routing still uses the tier. Null when not estimated.
    difficultyScore: { type: Number, default: null },
    confidence: { type: Number, default: null },
    cacheHit: { type: Boolean, default: false },

    // Quality trust of the route that served this request (from the matching rule, if any).
    // null = not rule-routed / legacy. Used to split realised savings by quality gate.
    qualityGate: {
      type: String,
      enum: ["passed", "overridden", "ungated"],
      default: null,
      index: true,
    },

    // WHY this model was served — the non-derivable reasoning captured at decision time
    // (which rule matched, the AI-policy source/base, a breached budget cap, a fallback
    // origin). The UI narrates from this plus the flat fields above. Null on older records.
    // Shape: { basis, classificationUsed, rule?, policy?, defaultScope?, override? }
    routingExplain: { type: mongoose.Schema.Types.Mixed, default: null },

    // Realtime voice sessions — audio token breakdown and total session wall-clock time.
    // Populated only for taskType:"realtime-voice"; zero/null on all other records.
    audioInputTokens:  { type: Number, default: 0 },
    audioOutputTokens: { type: Number, default: 0 },
    sessionDurationMs: { type: Number, default: null },

    // Captured context (full prompt + response). PII-masked at write time when
    // Settings.piiMaskingEnabled is on, and size-capped. Headers are intentionally NOT
    // stored (they carry Authorization/API keys). Governed by retentionDays auto-purge.
    messages: { type: mongoose.Schema.Types.Mixed, default: null }, // request payload (OpenAI messages)
    responseText: { type: String, default: null },                   // model output text
  },
  { collection: "request_records" }
);

const RequestRecord = mongoose.model("RequestRecord", requestRecordSchema);

// Predicates for the internal/customer split, so no caller hand-writes the shape.
RequestRecord.CUSTOMER_ONLY = { internalKind: null };
RequestRecord.INTERNAL_ONLY = { internalKind: { $ne: null } };
RequestRecord.INTERNAL_KINDS = INTERNAL_KINDS;

// Predicates for the gateway/ingested split (F-01) — same shape, opposite default
// visibility: unlike internalKind, callers do NOT exclude INGESTED_ONLY by default.
RequestRecord.GATEWAY_ONLY = { source: null };
RequestRecord.INGESTED_ONLY = { source: "ingested" };

module.exports = RequestRecord;
