// MongoDB aggregation pipelines producing the scope's dashboard views.
// All views accept the same filter object (date range + dimensions).
const RequestRecord = require("../models/RequestRecord");
const ApiKey = require("../models/ApiKey");
const { computeRealisedSavings } = require("./savings");

// Build a $match stage from filter query params.
//
// internalScope decides whether Arbr's own internal calls (classification, policy
// generation, eval judging, …) are in scope. It defaults to "customer" — DEFAULT DENY —
// so a view that knows nothing about internal spend cannot accidentally attribute
// Arbr's overhead to a customer application. Callers opt in explicitly:
//   "customer" (default) — customer traffic only
//   "internal"           — Arbr's own calls only (the overhead detail view)
//   "all"                — everything (headline totals, which include real overhead)
function buildMatch(filter = {}) {
  const m = {};
  if (filter.from || filter.to) {
    m.timestamp = {};
    if (filter.from) m.timestamp.$gte = new Date(filter.from);
    if (filter.to) m.timestamp.$lte = new Date(filter.to);
  }
  for (const f of ["application", "workflow", "department", "model", "provider", "taskType", "userId", "status"]) {
    if (filter[f]) m[f] = filter[f];
  }
  if (filter.requestId) m.requestId = filter.requestId;

  const scope = filter.internalScope || "customer";
  if (scope === "customer") m.internalKind = null;
  else if (scope === "internal") m.internalKind = { $ne: null };
  // "all" — no constraint
  return m;
}

// True when the filter narrows to a customer dimension (not just a time range).
// Internal records carry no application/workflow/user, so any such view is
// customer-scoped by definition and must report zero overhead.
function isDimensionScoped(filter = {}) {
  return ["application", "workflow", "department", "taskType", "userId"].some((f) => filter[f]);
}

// Headline view. `totalCost` deliberately INCLUDES Arbr's own internal spend, because
// that is real money on the customer's provider key and a cost dashboard that hides it
// would understate their actual bill. It is also reported separately as `internalCost`
// so it can be shown as its own line rather than smeared across customer applications.
//
// Every OTHER metric here is customer-only: internal calls have their own latency and
// never hit the response cache, so counting them would distort avgLatency and the cache
// hit rate. A dimension-scoped view reports zero overhead by definition.
async function overview(filter) {
  const scoped = isDimensionScoped(filter);
  const match = buildMatch({ ...filter, internalScope: scoped ? "customer" : "all" });
  // $ifNull is load-bearing: a *query* predicate like { internalKind: null } matches
  // documents where the field is absent, but an aggregation expression does not —
  // $eq: ["$internalKind", null] is false for a missing field. Records written before
  // this field existed have no internalKind, so without this they'd count as neither
  // customer nor internal and silently vanish from the split.
  const isCustomer = { $eq: [{ $ifNull: ["$internalKind", null] }, null] };
  const customerSum = (expr) => ({ $sum: { $cond: [isCustomer, expr, 0] } });

  const [row] = await RequestRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        // Headline: everything in scope, overhead included.
        totalCost: { $sum: "$totalCost" },
        // The overhead split.
        internalCost: { $sum: { $cond: [isCustomer, 0, "$totalCost"] } },
        internalRequests: { $sum: { $cond: [isCustomer, 0, 1] } },
        // Customer-only from here down.
        totalRequests: customerSum(1),
        totalTokens: customerSum("$totalTokens"),
        failures: { $sum: { $cond: [{ $and: [isCustomer, { $eq: ["$status", "failure"] }] }, 1, 0] } },
        cacheHits: { $sum: { $cond: [{ $and: [isCustomer, "$cacheHit"] }, 1, 0] } },
        cachedReadTokens: customerSum("$cachedReadTokens"),
        cacheSavingUsd: customerSum("$cacheSavingUsd"),
        // Pass-through models with no pricing entry log $0; surface them so cost isn't read as complete.
        unknownPricingRequests: {
          $sum: { $cond: [{ $and: [isCustomer, { $eq: ["$knownPricing", false] }] }, 1, 0] },
        },
        customerCost: customerSum("$totalCost"),
        customerLatencySum: customerSum("$latencyMs"),
      },
    },
  ]);
  const totalRequests = row?.totalRequests || 0;
  const totalCost = row?.totalCost || 0;
  const customerCost = row?.customerCost || 0;
  const internalCost = row?.internalCost || 0;
  const cacheHits = row?.cacheHits || 0;
  const unknownPricingRequests = row?.unknownPricingRequests || 0;
  const pricedRequests = totalRequests - unknownPricingRequests;
  return {
    totalRequests,
    totalCost,
    // The overhead split. internalShare is of the headline total, so the two read together.
    customerCost,
    internalCost,
    internalRequests: row?.internalRequests || 0,
    internalShare: totalCost ? internalCost / totalCost : 0,
    // Average over priced CUSTOMER requests only — $0 unknown-pricing records would
    // otherwise deflate it, and overhead isn't attributable to a customer request.
    avgCostPerRequest: pricedRequests ? customerCost / pricedRequests : 0,
    unknownPricingRequests,
    avgLatency: totalRequests ? (row?.customerLatencySum || 0) / totalRequests : 0,
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
        _id: { requested: "$modelRequested", served: "$model", qualityGate: { $ifNull: ["$qualityGate", null] } },
        requests: { $sum: 1 },
        promptTokens: { $sum: "$promptTokens" },
        completionTokens: { $sum: "$completionTokens" },
        actualCost: { $sum: "$totalCost" },
      },
    },
  ]);
  const groups = grouped.map((g) => ({
    requested: g._id.requested, served: g._id.served, qualityGate: g._id.qualityGate,
    requests: g.requests,
    promptTokens: g.promptTokens, completionTokens: g.completionTokens, actualCost: g.actualCost,
  }));
  const priceOf = (modelId, p, c) =>
    pricing.getModel(modelId) ? pricing.costFor(modelId, p, c).totalCost : null;
  const base = computeRealisedSavings(groups, priceOf);
  // Split by quality trust (from the rule that served the substitution, if any).
  let gatedSaved = 0, ungatedSaved = 0, unknownSaved = 0;
  for (const g of groups) {
    const baselineCost = priceOf(g.requested, g.promptTokens, g.completionTokens);
    if (baselineCost == null || !g.requested || g.requested === "auto") continue;
    const saved = baselineCost - g.actualCost;
    if (g.qualityGate === "passed") gatedSaved += saved;
    else if (g.qualityGate === "overridden" || g.qualityGate === "ungated") ungatedSaved += saved;
    else unknownSaved += saved;
  }
  return {
    ...base,
    byQualityGate: {
      passed: gatedSaved,
      ungated: ungatedSaved,
      unknown: unknownSaved,
    },
  };
}

// Total cost for a scope over a window — powers cost caps. dimension/value are
// optional (omit both for global spend); from/to bound the window.
//
// includeInternal defaults to false so any caller that hasn't thought about Arbr's
// own overhead gets the customer-only number. Only a GLOBAL cap should pass true:
// a scoped cap is a control over scoped traffic, and overhead belongs to no scope.
async function spend({ dimension, value, from, to, includeInternal = false } = {}) {
  const filter = {};
  if (from) filter.from = from;
  if (to) filter.to = to;
  if (dimension && value) filter[dimension] = value;
  if (includeInternal) filter.internalScope = "all";
  const match = buildMatch(filter);
  const [row] = await RequestRecord.aggregate([
    { $match: match },
    { $group: { _id: null, totalCost: { $sum: "$totalCost" } } },
  ]);
  return row?.totalCost || 0;
}

// Distinct values for filter dropdowns.
// Customer-only: Arbr's own internal calls must never become a selectable dimension
// value, or the console offers "filter by Arbr's overhead" as if it were an application.
async function facets() {
  const customer = RequestRecord.CUSTOMER_ONLY;
  const [applications, workflows, departments, models, providers, taskTypes, users, keyApps] = await Promise.all([
    RequestRecord.distinct("application", customer),
    RequestRecord.distinct("workflow", customer),
    RequestRecord.distinct("department", customer),
    RequestRecord.distinct("model", customer),
    RequestRecord.distinct("provider", customer),
    RequestRecord.distinct("taskType", customer),
    RequestRecord.distinct("userId", customer),
    ApiKey.distinct("application", { enabled: true, revokedAt: null }),
  ]);
  // Apps that have a key but have never made a request — shown as "newly added".
  const appSet = new Set(applications);
  const newApplications = keyApps.filter((a) => a && !appSet.has(a));
  return { applications, newApplications, workflows, departments, models, providers, taskTypes, users };
}

// Per-provider health over the last 24h: error rate and average latency.
// Surfaces in the Connections page so operators can spot degraded providers.
// Customer-only: internal call volume is small and bursty (a run of connection tests
// would swing the numbers), and this panel answers "how are my providers serving my
// traffic". Arbr's own calls do exercise the provider, so this is a deliberate choice.
async function providerHealth() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await RequestRecord.aggregate([
    { $match: { timestamp: { $gte: since }, ...RequestRecord.CUSTOMER_ONLY } },
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

// Daily (or hourly) time-series of requests, cost, and failures for the selected window.
// bucket: "day" (default) or "hour". Useful for the Overview trend chart.
async function timeseries(filter, bucket = "day") {
  const match = buildMatch(filter);
  const fmt = bucket === "hour" ? "%Y-%m-%dT%H" : "%Y-%m-%d";
  const rows = await RequestRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: fmt, date: "$timestamp", timezone: "UTC" } },
        requests: { $sum: 1 },
        cost: { $sum: "$totalCost" },
        failures: { $sum: { $cond: [{ $eq: ["$status", "failure"] }, 1, 0] } },
      },
    },
    { $sort: { _id: 1 } },
    { $project: { _id: 0, date: "$_id", requests: 1, cost: 1, failures: 1 } },
  ]);
  return rows;
}

// Global latency percentiles (p50 / p95 / p99) + TTFT percentiles for the selected window.
// Only success requests; TTFT only from records where ttftMs was captured (streaming proxy path).
async function latencyPercentiles(filter) {
  const match = buildMatch(filter);
  const [row] = await RequestRecord.aggregate([
    { $match: { ...match, status: "success" } },
    {
      $group: {
        _id: null,
        p50:         { $percentile: { input: "$latencyMs",        p: [0.5],  method: "approximate" } },
        p95:         { $percentile: { input: "$latencyMs",        p: [0.95], method: "approximate" } },
        p99:         { $percentile: { input: "$latencyMs",        p: [0.99], method: "approximate" } },
        ttftP50:     { $percentile: { input: "$ttftMs",           p: [0.5],  method: "approximate" } },
        ttftP95:     { $percentile: { input: "$ttftMs",           p: [0.95], method: "approximate" } },
        overheadP50: { $percentile: { input: "$gatewayOverheadMs", p: [0.5],  method: "approximate" } },
        overheadP95: { $percentile: { input: "$gatewayOverheadMs", p: [0.95], method: "approximate" } },
        overheadP99: { $percentile: { input: "$gatewayOverheadMs", p: [0.99], method: "approximate" } },
      },
    },
    {
      $project: {
        _id: 0,
        p50:         { $round: [{ $first: "$p50" },         0] },
        p95:         { $round: [{ $first: "$p95" },         0] },
        p99:         { $round: [{ $first: "$p99" },         0] },
        ttftP50:     { $round: [{ $first: "$ttftP50" },     0] },
        ttftP95:     { $round: [{ $first: "$ttftP95" },     0] },
        overheadP50: { $round: [{ $first: "$overheadP50" }, 0] },
        overheadP95: { $round: [{ $first: "$overheadP95" }, 0] },
        overheadP99: { $round: [{ $first: "$overheadP99" }, 0] },
      },
    },
  ]);
  return row || { p50: null, p95: null, p99: null, ttftP50: null, ttftP95: null, overheadP50: null, overheadP95: null, overheadP99: null };
}

// Arbr's own overhead, broken down by what it was spent on. This is the one view that
// deliberately looks at internal records — everything else excludes them.
async function internalSpend(filter = {}) {
  const scoped = { ...filter, internalScope: "internal" };
  const [byKind, byModel, [totals]] = await Promise.all([
    groupBy("internalKind", scoped),
    groupBy("model", scoped),
    RequestRecord.aggregate([
      { $match: buildMatch(scoped) },
      {
        $group: {
          _id: null,
          totalCost: { $sum: "$totalCost" },
          totalRequests: { $sum: 1 },
          totalTokens: { $sum: "$totalTokens" },
          failures: { $sum: { $cond: [{ $eq: ["$status", "failure"] }, 1, 0] } },
        },
      },
    ]),
  ]);
  return {
    totalCost: totals?.totalCost || 0,
    totalRequests: totals?.totalRequests || 0,
    totalTokens: totals?.totalTokens || 0,
    failures: totals?.failures || 0,
    byKind,
    byModel,
  };
}

module.exports = {
  buildMatch,
  isDimensionScoped,
  overview,
  internalSpend,
  spend,
  timeseries,
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
  latencyPercentiles,
};
