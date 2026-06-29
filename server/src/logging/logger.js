// Usage logger. Writes one RequestRecord per call, AFTER the response is on its
// way back. Must never throw into the request path — errors are swallowed + logged.
const RequestRecord = require("../models/RequestRecord");
const { costFor } = require("../pricing/registry");
const { maskMessages, maskPii, clampText } = require("./piiFilter");
const Settings = require("../models/Settings");

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

    // Captured context (prompt + response): PII-mask when enabled, then size-cap. Only the
    // logged copy is masked — the model already received the original text. Setting is read
    // lazily (cached by Settings.get's singleton pattern).
    let messages = record.messages;
    let responseText = typeof record.responseText === "string" ? record.responseText : null;
    if (messages || responseText) {
      const s = await Settings.get().catch(() => null);
      if (s?.piiMaskingEnabled) {
        if (messages) messages = maskMessages(messages);
        if (responseText) responseText = maskPii(responseText);
      }
    }
    if (responseText) responseText = clampText(responseText);

    await RequestRecord.create({
      ...record,
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
  } catch (err) {
    // Logging failures must not affect the user-facing call.
    console.error("[logger] failed to write request record:", err.message);
  }
}

module.exports = { write };
