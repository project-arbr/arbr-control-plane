// Usage logger. Writes one RequestRecord per call, AFTER the response is on its
// way back. Must never throw into the request path — errors are swallowed + logged.
const RequestRecord = require("../models/RequestRecord");
const { costFor } = require("../pricing/registry");
const { maskMessages, maskPii, clampText } = require("./piiFilter");
const Settings = require("../models/Settings");
const capEngine = require("../routing/capEngine");
const telemetry = require("../telemetry");

function payloadFields(record, settings) {
  if (settings?.captureRequestPayloads === false) {
    return { messages: undefined, responseText: null };
  }
  let messages = record.messages;
  let responseText = typeof record.responseText === "string" ? record.responseText : null;
  if ((messages || responseText) && settings?.piiMaskingEnabled) {
    if (messages) messages = maskMessages(messages, settings.customPiiPatterns);
    if (responseText) responseText = maskPii(responseText, settings.customPiiPatterns);
  }
  if (responseText) responseText = clampText(responseText);
  return { messages, responseText };
}

// record: {
//   requestId, timestamp, application, workflow, userId, department,
//   provider, model, modelRequested, taskType,
//   promptTokens, completionTokens, totalTokens,
//   latencyMs, status, retryCount, routingDecision, cacheHit,
//   knownPricing?  — false for pass-through unlisted models; costs logged as $0
//   messages?      — raw messages array; stored masked when piiMaskingEnabled
//   source?, externalRequestId? — set by POST /v1/ingest (F-01); pass through
//     unmodified via the spread below, same as internalKind already does. Cost
//     derivation, masking, and capEngine.recordSpend() below apply identically
//     regardless of source — ingested spend is real spend, counted the same way.
// }
// Same as write(), but propagates errors instead of swallowing them — used by
// POST /v1/ingest (F-01), which needs to distinguish a duplicate requestId
// (expected, reported back as such) from a real write failure per-event.
// Every other caller should keep using write() below, not this directly.
async function writeOrThrow(record) {
  // Transport-only fields: the W3C trace context read off the gateway request, used
  // to parent the OTel span. Never stored — strip before building the Mongo doc.
  const { _traceparent, _tracestate, ...rec } = record;
  const promptTokens = rec.promptTokens || 0;
  const completionTokens = rec.completionTokens || 0;
  const totalTokens = rec.totalTokens || promptTokens + completionTokens;
  const cachedReadTokens = rec.cachedReadTokens || 0;
  const cacheWriteTokens = rec.cacheWriteTokens || 0;
  const { inputCost, outputCost, totalCost } = rec.knownPricing === false
    ? { inputCost: 0, outputCost: 0, totalCost: 0 }
    : costFor(rec.model, promptTokens, completionTokens, { cachedReadTokens, cacheWriteTokens });
  // Estimated $ saved by cached reads vs paying full input rate for them.
  let cacheSavingUsd = 0;
  if (rec.knownPricing !== false && cachedReadTokens > 0) {
    const full = costFor(rec.model, promptTokens, completionTokens);
    cacheSavingUsd = Math.max(0, full.totalCost - totalCost);
  }

  // Captured context (prompt + response): respect captureRequestPayloads toggle, then
  // PII-mask when enabled, then size-cap. Only the logged copy is masked — the model
  // already received the original text. Settings are read lazily (singleton pattern).
  const s = await Settings.get().catch(() => null);
  const { messages, responseText } = payloadFields(rec, s);

  const fields = {
    ...rec,
    knownPricing: rec.knownPricing !== false, // normalize to a stored boolean
    messages,
    responseText,
    promptTokens,
    completionTokens,
    totalTokens,
    cachedReadTokens,
    cacheWriteTokens,
    cacheSavingUsd,
    inputCost,
    outputCost,
    totalCost,
  };

  // Emit the OTel trace span BEFORE the DB write, so a Mongo failure can't suppress
  // it. Content capture inherits the masking above (messages/responseText already
  // masked, and undefined when captureRequestPayloads is off). Synchronous and
  // swallowed inside telemetry — it never throws into this path.
  telemetry.emit(fields, { traceparent: _traceparent, tracestate: _tracestate });

  const doc = await RequestRecord.create(fields);

  // Hard budget counters: only count successful, priced spend (not blocked/failed).
  if (rec.status === "success" && totalCost > 0 && rec.knownPricing !== false) {
    setImmediate(() =>
      capEngine.recordSpend(totalCost, {
        application: rec.application,
        provider: rec.provider,
        // Arbr's own overhead counts against a global cap but not a scoped one.
        internalKind: rec.internalKind || null,
      }).catch(() => {})
    );
  }

  return doc;
}

async function write(record) {
  try {
    await writeOrThrow(record);
  } catch (err) {
    // Logging failures must not affect the user-facing call.
    console.error("[logger] failed to write request record:", err.message);
  }
}

module.exports = { write, writeOrThrow, payloadFields };
