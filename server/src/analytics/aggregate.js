// MongoDB aggregation pipelines producing the scope's dashboard views.
// All views accept the same filter object (date range + dimensions).
const RequestRecord = require("../models/RequestRecord");
const { computeRealisedSavings } = require("./savings");

// Build a $match stage from filter query params.
function buildMatch(filter = {}) {
  const m = {};
  if (filter.from || filter.to) {
    m.timestamp = {};
    if (filter.from) m.timestamp.$gte = new Date(filter.from);
    if (filter.to) m.timestamp.$lte = new Date(filter.to);
  }
  for (const f of ["application", "workflow", "department", "model", "provider", "taskType", "userId"]) {
    if (filter[f]) m[f] = filter[f];
  }
  return m;
}

async function overview(filter) {
  const match = buildMatch(filter);
  const [row] = await RequestRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalRequests: { $sum: 1 },
        totalCost: { $sum: "$totalCost" },
        avgLatency: { $avg: "$latencyMs" },
        totalTokens: { $sum: "$totalTokens" },
        failures: { $sum: { $cond: [{ $eq: ["$status", "failure"] }, 1, 0] } },
        cacheHits: { $sum: { $cond: ["$cacheHit", 1, 0] } },
        cachedReadTokens: { $sum: "$cachedReadTokens" },
        cacheSavingUsd: { $sum: "$cacheSavingUsd" },
      },
    },
  ]);
  const totalRequests = row?.totalRequests || 0;
  const totalCost = row?.totalCost || 0;
  const cacheHits = row?.cacheHits || 0;
  return {
    totalRequests,
    totalCost,
    avgCostPerRequest: totalRequests ? totalCost / totalRequests : 0,
    avgLatency: row?.avgLatency || 0,
    totalTokens: row?.totalTokens || 0,
    failures: row?.failures || 0,
    // Caching observability: response-cache hit rate + provider prompt-cache reuse and savings.
    cacheHits,
    cacheHitRate: totalRequests ? cacheHits / totalRequests : 0,
    cachedReadTokens: row?.cachedReadTokens || 0,
    cacheSavingUsd: row?.cacheSavingUsd || 0,
  };
}

// Generic group-by view. dimension is a record field name.
async function groupBy(dimension, filter, extra = {}) {
  const match = buildMatch(filter);
  const project = {
    _id: 0,
    key: "$_id",
    requests: 1,
    cost: 1,
    avgLatency: 1,
    failures: 1,
    ...extra.project,
  };
  return RequestRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: `$${dimension}`,
        requests: { $sum: 1 },
        cost: { $sum: "$totalCost" },
        avgLatency: { $avg: "$latencyMs" },
        failures: { $sum: { $cond: [{ $eq: ["$status", "failure"] }, 1, 0] } },
        ...extra.group,
      },
    },
    { $project: project },
    { $sort: { cost: -1 } },
  ]);
}

const byApplication = (f) => groupBy("application", f);
const byTeam = (f) => groupBy("department", f); // "team" view keyed by department
const byWorkflow = (f) => groupBy("workflow", f);
const byModel = (f) => groupBy("model", f);
const byProvider = (f) =>
  groupBy("provider", f, {
    group: { tokens: { $sum: "$totalTokens" } },
    project: { tokens: 1 },
  });
const byTaskType = (f) => groupBy("taskType", f);
const byUser = (f) => groupBy("userId", f); // per-person spend (null userId = unattributed)

// Realised savings from model SUBSTITUTIONS: requests where a specific model was requested but a
// different one was served (budget downgrades, rule/opt-out/allowed-model fallbacks). Re-prices the
// served tokens at the requested model and compares to what was actually paid. The pure math lives
// in ./savings so it's testable without a DB.
async function realisedSavings(filter) {
  const pricing = require("../pricing/registry");
  const match = buildMatch(filter);
  const grouped = await RequestRecord.aggregate([
    { $match: { ...match, status: "success", $expr: { $ne: ["$modelRequested", "$model"] } } },
    {
      $group: {
        _id: { requested: "$modelRequested", served: "$model" },
        requests: { $sum: 1 },
        promptTokens: { $sum: "$promptTokens" },
        completionTokens: { $sum: "$completionTokens" },
        actualCost: { $sum: "$totalCost" },
      },
    },
  ]);
  const groups = grouped.map((g) => ({
    requested: g._id.requested, served: g._id.served, requests: g.requests,
    promptTokens: g.promptTokens, completionTokens: g.completionTokens, actualCost: g.actualCost,
  }));
  const priceOf = (modelId, p, c) =>
    pricing.getModel(modelId) ? pricing.costFor(modelId, p, c).totalCost : null;
  return computeRealisedSavings(groups, priceOf);
}

// Total cost for a scope over a window — powers cost caps. dimension/value are
// optional (omit both for global spend); from/to bound the window.
async function spend({ dimension, value, from, to } = {}) {
  const filter = {};
  if (from) filter.from = from;
  if (to) filter.to = to;
  if (dimension && value) filter[dimension] = value;
  const match = buildMatch(filter);
  const [row] = await RequestRecord.aggregate([
    { $match: match },
    { $group: { _id: null, totalCost: { $sum: "$totalCost" } } },
  ]);
  return row?.totalCost || 0;
}

// Distinct values for filter dropdowns.
async function facets() {
  const [applications, workflows, departments, models, providers, taskTypes, users] = await Promise.all([
    RequestRecord.distinct("application"),
    RequestRecord.distinct("workflow"),
    RequestRecord.distinct("department"),
    RequestRecord.distinct("model"),
    RequestRecord.distinct("provider"),
    RequestRecord.distinct("taskType"),
    RequestRecord.distinct("userId"),
  ]);
  return { applications, workflows, departments, models, providers, taskTypes, users };
}

// Per-provider health over the last 24h: error rate and average latency.
// Surfaces in the Connections page so operators can spot degraded providers.
async function providerHealth() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await RequestRecord.aggregate([
    { $match: { timestamp: { $gte: since } } },
    {
      $group: {
        _id: "$provider",
        total:    { $sum: 1 },
        failures: { $sum: { $cond: [{ $eq: ["$status", "failure"] }, 1, 0] } },
        avgLatencyMs: { $avg: "$latencyMs" },
        p50LatencyMs: { $median: { input: "$latencyMs", method: "approximate" } },
      },
    },
    { $project: { _id: 0, provider: "$_id", total: 1, failures: 1, avgLatencyMs: 1, p50LatencyMs: 1 } },
  ]);
  return rows.map((r) => ({
    ...r,
    errorRate: r.total > 0 ? r.failures / r.total : 0,
  }));
}

module.exports = {
  buildMatch,
  overview,
  spend,
  byApplication,
  byTeam,
  byWorkflow,
  byModel,
  byProvider,
  byTaskType,
  byUser,
  realisedSavings,
  facets,
  providerHealth,
};
