// Every LLM call Arbr makes FOR ITSELF goes through here.
//
// Arbr is a cost-control product, so it has to be honest about the cost it creates.
// Historically each internal call site was responsible for logging its own spend, and
// nine of ten forgot — the router never logs, only callers do. This wrapper moves that
// responsibility to one choke point: call it and your spend is priced, attributed and
// recorded, whether or not you remembered to think about it.
//
// Records are written with `internalKind` set and every customer dimension left null,
// so analytics counts the money in headline totals while never attributing it to a
// customer application. See ARCHITECTURE.md → "Arbr's own AI spend".
const RequestRecord = require("../models/RequestRecord");
const { costFor } = require("../pricing/registry");
const logger = require("../logging/logger");
const { v4: uuidv4 } = require("uuid");

const INTERNAL_KINDS = RequestRecord.INTERNAL_KINDS;

// In-flight write promises, so tests can await the fire-and-forget logging without a
// mocking library or arbitrary sleeps.
const _pending = new Set();

function _record(fields) {
  const p = Promise.resolve()
    .then(() => logger.write(fields))
    .catch(() => { /* logger already swallows; belt and braces */ })
    .finally(() => _pending.delete(p));
  _pending.add(p);
}

/**
 * Run an internal LLM call and account for it.
 *
 * @param {object}   o
 * @param {string}   o.kind      one of RequestRecord.INTERNAL_KINDS
 * @param {object}   o.router    a router from providers/router.js getRouter(), or a
 *                               one-off createRouter (the admin test endpoints use these)
 * @param {Array}    o.messages  chat messages
 * @param {string}  [o.provider] providerOverride
 * @param {string}  [o.model]    modelOverride
 * @param {number}  [o.temperature]
 * @param {number}  [o.maxTokens]
 * @param {object}  [o.context]  provenance ({ application, requestId, campaignId, runId })
 *                               stored on internalContext — never a queryable dimension
 * @returns {Promise<{text,providerId,modelId,latencyMs,usage,costUsd}>}
 *
 * Provider errors propagate unchanged (every call site already handles them), but a
 * failure record is written first — so failed internal calls are visible too.
 */
async function internalComplete({
  kind, router, messages, provider, model, temperature, maxTokens, context = null,
}) {
  if (!INTERNAL_KINDS.includes(kind)) {
    throw new Error(`internalComplete: unknown kind "${kind}". Known: ${INTERNAL_KINDS.join(", ")}`);
  }
  if (!router) throw new Error("internalComplete: router is required");

  const startedAt = new Date();
  try {
    const res = await router.complete({
      messages,
      providerOverride: provider,
      modelOverride: model,
      temperature,
      maxTokens,
    });

    const usage = res.usage || {};
    const promptTokens = usage.inputTokens || 0;
    const completionTokens = usage.outputTokens || 0;
    const { totalCost } = costFor(res.modelId, promptTokens, completionTokens, {
      cachedReadTokens: usage.cachedReadTokens || 0,
      cacheWriteTokens: usage.cacheWriteTokens || 0,
    });

    _record({
      ...baseFields(kind, startedAt, context),
      provider: res.providerId,
      model: res.modelId,
      modelRequested: model || res.modelId,
      promptTokens,
      completionTokens,
      totalTokens: usage.totalTokens || promptTokens + completionTokens,
      cachedReadTokens: usage.cachedReadTokens || 0,
      cacheWriteTokens: usage.cacheWriteTokens || 0,
      latencyMs: res.latencyMs || 0,
      status: "success",
    });

    return { ...res, costUsd: totalCost };
  } catch (err) {
    _record({
      ...baseFields(kind, startedAt, context),
      provider: provider || null,
      model: model || null,
      modelRequested: model || null,
      latencyMs: Date.now() - startedAt.getTime(),
      status: "failure",
      errorMessage: String(err && err.message ? err.message : err).slice(0, 500),
    });
    throw err;
  }
}

// Customer dimensions are deliberately null: defence in depth, so a query that forgets
// to exclude internal records yields an unattributed bucket rather than a fake app.
// messages/responseText are deliberately never captured — Arbr's own prompts are not
// customer data, and omitting them also makes internal records fail eval-dataset
// eligibility (which requires both) even if a query filter is ever missed.
function baseFields(kind, timestamp, context) {
  return {
    requestId: uuidv4(),
    timestamp,
    internalKind: kind,
    internalContext: context || null,
    application: null,
    workflow: null,
    department: null,
    userId: null,
    taskType: null,
    routingDecision: "passthrough",
    classifiedBy: "provided",
    cacheHit: false,
  };
}

// Test helper: await all in-flight internal log writes.
function _flushForTests() {
  return Promise.all([..._pending]);
}

module.exports = { internalComplete, _flushForTests, INTERNAL_KINDS };
