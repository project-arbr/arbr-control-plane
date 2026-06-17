// Usage logger. Writes one RequestRecord per call, AFTER the response is on its
// way back. Must never throw into the request path — errors are swallowed + logged.
const RequestRecord = require("../models/RequestRecord");
const { costFor } = require("../pricing/registry");

// record: {
//   requestId, timestamp, application, workflow, userId, department,
//   provider, model, modelRequested, taskType,
//   promptTokens, completionTokens, totalTokens,
//   latencyMs, status, retryCount, routingDecision, cacheHit,
//   knownPricing?  — false for pass-through unlisted models; costs logged as $0
// }
async function write(record) {
  try {
    const promptTokens = record.promptTokens || 0;
    const completionTokens = record.completionTokens || 0;
    const totalTokens = record.totalTokens || promptTokens + completionTokens;
    const { inputCost, outputCost, totalCost } = record.knownPricing === false
      ? { inputCost: 0, outputCost: 0, totalCost: 0 }
      : costFor(record.model, promptTokens, completionTokens);

    await RequestRecord.create({
      ...record,
      promptTokens,
      completionTokens,
      totalTokens,
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
