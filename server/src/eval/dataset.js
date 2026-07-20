// Build an immutable EvalDataset from historical RequestRecords for a recommendation's scope.
// Pure helpers (query/filter/dedupe/stratify/hash) are separated from the DB writer so they
// unit-test without Mongo.
const crypto = require("crypto");
const RequestRecord = require("../models/RequestRecord");
const EvalDataset = require("../models/EvalDataset");
const EvalItem = require("../models/EvalItem");
const Settings = require("../models/Settings");
const { maskMessages, maskPii, clampText } = require("../logging/piiFilter");
const { isSingleShot } = require("./logic");
const { tierForTask } = require("../classify/classifier");
const { riskForTier, targetCountForRisk } = require("./thresholds");

const DEFAULT_WINDOW_DAYS = 60;
const FETCH_MULTIPLIER = 5; // over-fetch before dedupe/stratify so we can still hit target

// Mongo query for a recommendation's scope. Only successful, single-shot, non-cache records
// with a stored response are eligible (tools/multi-turn are excluded downstream via isSingleShot).
function buildScopeQuery(rec, since) {
  // Customer traffic only — Arbr's own internal prompts must never become items in a
  // customer's evaluation dataset.
  const q = { status: "success", cacheHit: { $ne: true }, ...RequestRecord.CUSTOMER_ONLY };
  if (rec.taskType) q.taskType = rec.taskType;
  if (rec.currentModel) q.model = rec.currentModel;
  if (rec.application) q.application = rec.application;
  if (since) q.timestamp = { $gte: since };
  return q;
}

// A record is eligible if it is single-shot and actually has prompt + response text to replay.
function isEligible(r) {
  if (!r || !r.responseText || !String(r.responseText).trim()) return false;
  if (!r.messages) return false;
  return isSingleShot(r.messages, false);
}

function promptHashOf(messages) {
  return crypto.createHash("sha256").update(JSON.stringify(messages || [])).digest("hex");
}
function responseHashOf(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

// Keep the first record per prompt hash. Pure.
function dedupeByPromptHash(records) {
  const seen = new Set();
  const out = [];
  for (const r of records) {
    const h = promptHashOf(r.messages);
    if (seen.has(h)) continue;
    seen.add(h);
    out.push(r);
  }
  return out;
}

// Proportional stratified sample: round-robin across strata (keyed by workflow/difficulty)
// until we reach target, so no single stratum dominates. Pure.
function stratifiedSample(records, target, keyFn) {
  if (records.length <= target) return records.slice();
  const buckets = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(r);
  }
  const queues = [...buckets.values()];
  const out = [];
  let progress = true;
  while (out.length < target && progress) {
    progress = false;
    for (const q of queues) {
      if (q.length) { out.push(q.shift()); progress = true; if (out.length >= target) break; }
    }
  }
  return out;
}

function stratumKey(r) {
  return `${r.workflow || "-"}|${r.difficulty || "-"}`;
}

// Infer output validators for a dataset from what the BASELINE actually produced, so the
// format pass-rate is a real check (not vacuously 100%). Pure.
//   - baseline outputs all parse as JSON  → require the candidate to emit valid JSON.
//   - baseline outputs are a small closed set of short strings → treat as labels; require membership.
//   - otherwise (free-form text)          → no validator (the judge carries quality).
function inferValidators(responses) {
  const vals = (responses || []).map((r) => String(r || "").trim()).filter(Boolean);
  if (vals.length < 5) return []; // too few to infer a shape confidently
  const isJson = (s) => { try { JSON.parse(s); return true; } catch { return false; } };
  if (vals.every(isJson)) return [{ type: "json_schema" }];
  const distinct = [...new Set(vals)];
  if (distinct.length <= 12 && distinct.every((v) => v.length <= 40)) {
    return [{ type: "classification_label", labels: distinct }];
  }
  return [];
}

// Store the item text according to piiMode + global masking. Returns { messages, productionResponse }.
function projectText(record, piiMode, maskEnabled, customPatterns, captureEnabled = true) {
  if (!captureEnabled || piiMode === "metadata_only") return { messages: null, productionResponse: null };
  const raw = piiMode === "raw_allowed" && !maskEnabled;
  const msgs = Array.isArray(record.messages)
    ? record.messages
    : [{ role: "user", content: String(record.messages ?? "") }];
  return {
    messages: raw ? msgs : maskMessages(msgs, customPatterns),
    productionResponse: clampText(raw ? (record.responseText || "") : maskPii(record.responseText || "", customPatterns)),
  };
}

// Create a dataset from traffic. Returns the persisted EvalDataset (status "ready" or "failed").
async function createFromTraffic({ rec, targetCount, piiMode = "masked", windowDays = DEFAULT_WINDOW_DAYS, createdBy = "console", isBenchmark = false, name = null } = {}) {
  const risk = riskForTier(tierForTask(rec.taskType));
  const target = targetCount || targetCountForRisk(risk);
  const settings = await Settings.get().catch(() => ({}));
  const maskEnabled = !!settings.piiMaskingEnabled;
  const captureEnabled = settings.captureRequestPayloads !== false;
  const customPatterns = settings.customPiiPatterns || [];
  // Global masking wins: never store raw when masking is on.
  const effectivePiiMode = !captureEnabled
    ? "metadata_only"
    : (piiMode === "raw_allowed" && maskEnabled ? "masked" : piiMode);

  const since = new Date(Date.now() - windowDays * 86400000);
  const dataset = await EvalDataset.create({
    // A benchmark is user-named and candidate-agnostic (candidates are chosen per run).
    name: name || `${rec.taskType || "task"}: ${rec.currentModel} → ${rec.suggestedModel}`,
    isBenchmark: !!isBenchmark,
    recommendationId: rec._id || null,
    scope: {
      application: rec.application || null, workflow: null, taskType: rec.taskType || null,
      currentModel: rec.currentModel || null, department: null, difficulty: null,
    },
    baselineModel: rec.currentModel || null,
    candidateModel: rec.suggestedModel || null,
    sourceWindow: { from: since, to: new Date() },
    sampling: { method: "stratified", targetCount: target, dedupeByPromptHash: true },
    riskTier: risk,
    piiMode: effectivePiiMode,
    status: "creating",
    createdBy,
  });

  if (!captureEnabled) {
    dataset.status = "failed";
    dataset.error = "Payload capture is disabled. Enable it explicitly before creating replay datasets from traffic.";
    await dataset.save();
    return dataset;
  }

  try {
    const raw = await RequestRecord.find(buildScopeQuery(rec, since))
      .sort({ timestamp: -1 })
      .limit(target * FETCH_MULTIPLIER)
      .lean();
    const eligible = raw.filter(isEligible);
    const deduped = dedupeByPromptHash(eligible);
    const sampled = stratifiedSample(deduped, target, stratumKey);

    if (!sampled.length) {
      const withResp = raw.filter((r) => r.responseText).length;
      const withMsgs = raw.filter((r) => r.messages).length;
      const singleShot = raw.filter((r) => r.messages && isSingleShot(r.messages, false)).length;
      dataset.status = "failed";
      dataset.error = !raw.length
        ? "No requests match this recommendation's scope (task type + model) in the window."
        : withMsgs === 0
          ? `${raw.length} requests match, but none have a captured prompt to replay. Turn on payload capture (Settings → Observability); only traffic logged after it is enabled can be evaluated.`
          : `No replayable requests: of ${raw.length} matched, ${withResp} have a response and ${withMsgs} a prompt, ${singleShot} single-shot (multi-turn / tool calls are skipped).`;
      await dataset.save();
      return dataset;
    }

    // Attach validators inferred from the baseline outputs, so formatPassRate is a real gate.
    const validators = inferValidators(sampled.map((r) => r.responseText));
    const items = sampled.map((r) => {
      const { messages, productionResponse } = projectText(r, effectivePiiMode, maskEnabled, customPatterns, captureEnabled);
      return {
        datasetId: dataset._id, requestId: r.requestId, application: r.application || null,
        workflow: r.workflow || null, taskType: r.taskType || null, currentModel: r.model || null,
        messages, productionResponse,
        productionCost: r.totalCost || 0, productionLatencyMs: r.latencyMs || 0,
        promptHash: promptHashOf(r.messages), responseHash: responseHashOf(r.responseText),
        validators, metadata: { classifiedBy: r.classifiedBy || null, difficulty: r.difficulty || null, confidence: r.confidence ?? null },
      };
    });
    await EvalItem.insertMany(items);
    dataset.itemCount = items.length;
    dataset.status = "ready";
    await dataset.save();
    return dataset;
  } catch (err) {
    dataset.status = "failed";
    dataset.error = err.message;
    await dataset.save();
    return dataset;
  }
}

module.exports = {
  createFromTraffic,
  buildScopeQuery, isEligible, promptHashOf, responseHashOf,
  dedupeByPromptHash, stratifiedSample, stratumKey, projectText, inferValidators,
};
