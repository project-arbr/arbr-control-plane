// Usage logger. Writes one RequestRecord per call, AFTER the response is on its
// way back. Must never throw into the request path — errors are swallowed + logged.
const RequestRecord = require("../models/RequestRecord");
const { costFor } = require("../pricing/registry");
const { maskMessages, maskPii, clampText } = require("./piiFilter");
const Settings = require("../models/Settings");
const capEngine = require("../routing/capEngine");

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
// }
async function write(record) {
  try {
    const promptTokens = record.promptTokens || 0;
    const completionTokens = record.completionTokens || 0;
    const totalTokens = record.totalTokens || promptTokens + completionTokens;
    const cachedReadTokens = record.cachedReadTokens || 0;
    const cacheWriteTokens = record.cacheWriteTokens || 0;
    const { inputCost, outputCost, totalCost } = record.knownPricing === false
      ? { inputCost: 0, outputCost: 0, totalCost: 0 }
      : costFor(record.model, promptTokens, completionTokens, { cachedReadTokens, cacheWriteTokens });
    // Estimated $ saved by cached reads vs paying full input rate for them.
    let cacheSavingUsd = 0;
    if (record.knownPricing !== false && cachedReadTokens > 0) {
      const full = costFor(record.model, promptTokens, completionTokens);
      cacheSavingUsd = Math.max(0, full.totalCost - totalCost);
    }

    // Captured context (prompt + response): respect captureRequestPayloads toggle, then
    // PII-mask when enabled, then size-cap. Only the logged copy is masked — the model
    // already received the original text. Settings are read lazily (singleton pattern).
    const s = await Settings.get().catch(() => null);
    const { messages, responseText } = payloadFields(record, s);

    await RequestRecord.create({
      ...record,
      knownPricing: record.knownPricing !== false, // normalize to a stored boolean
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
    });

    // Hard budget counters: only count successful, priced spend (not blocked/failed).
    if (record.status === "success" && totalCost > 0 && record.knownPricing !== false) {
      setImmediate(() =>
        capEngine.recordSpend(totalCost, {
          application: record.application,
          provider: record.provider,
        }).catch(() => {})
      );
    }
  } catch (err) {
    // Logging failures must not affect the user-facing call.
    console.error("[logger] failed to write request record:", err.message);
  }
}

module.exports = { write, payloadFields };
