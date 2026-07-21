// Batch-attaches a derived lifecycle stage (see ./stage.js) to a list of Recommendations
// without N+1 queries — 5 queries total regardless of recommendation count, each a single
// $in fetch of every linked EvalDataset/EvalRun/EvalCampaign/RoutingExperiment, plus one
// Rule lookup by the inverse sourceRecommendation FK (Recommendation has no ruleId field).
const EvalDataset = require("../models/EvalDataset");
const EvalRun = require("../models/EvalRun");
const EvalCampaign = require("../models/EvalCampaign");
const RoutingExperiment = require("../models/RoutingExperiment");
const Rule = require("../models/Rule");
const { deriveStage } = require("./stage");

function idsOf(recs, field) {
  return [...new Set(recs.map((r) => r[field]).filter(Boolean).map(String))];
}

function byId(docs) {
  return new Map(docs.map((d) => [String(d._id), d]));
}

// recs: plain/lean Recommendation objects. Returns a new array — does not mutate input.
async function attachStages(recs) {
  if (!recs.length) return [];

  const [datasets, runs, campaigns, experiments, rules] = await Promise.all([
    EvalDataset.find({ _id: { $in: idsOf(recs, "evalDatasetId") } }).lean(),
    EvalRun.find({ _id: { $in: idsOf(recs, "evalRunId") } }).lean(),
    EvalCampaign.find({ _id: { $in: idsOf(recs, "shadowCampaignId") } }).lean(),
    RoutingExperiment.find({ _id: { $in: idsOf(recs, "experimentId") } }).lean(),
    Rule.find({ sourceRecommendation: { $in: recs.map((r) => r._id) } }).lean(),
  ]);

  const dsMap = byId(datasets);
  const runMap = byId(runs);
  const campMap = byId(campaigns);
  const expMap = byId(experiments);
  const rulesByRec = new Map();
  for (const r of rules) {
    const k = String(r.sourceRecommendation);
    if (!rulesByRec.has(k)) rulesByRec.set(k, []);
    rulesByRec.get(k).push(r);
  }

  return recs.map((rec) => {
    const ctx = {
      rec,
      dataset: rec.evalDatasetId ? dsMap.get(String(rec.evalDatasetId)) || null : null,
      run: rec.evalRunId ? runMap.get(String(rec.evalRunId)) || null : null,
      campaign: rec.shadowCampaignId ? campMap.get(String(rec.shadowCampaignId)) || null : null,
      experiment: rec.experimentId ? expMap.get(String(rec.experimentId)) || null : null,
      rules: rulesByRec.get(String(rec._id)) || [],
    };
    const { stage, label, nextAction, rule } = deriveStage(ctx);

    return {
      ...rec,
      stage,
      stageLabel: label,
      nextAction,
      // Lightweight linked-doc summaries so the redesigned card never needs a second fetch.
      shadowCampaignSummary: ctx.campaign && {
        _id: ctx.campaign._id,
        status: ctx.campaign.status,
        statusReason: ctx.campaign.statusReason,
        thresholds: ctx.campaign.thresholds,
      },
      experimentSummary: ctx.experiment && {
        _id: ctx.experiment._id,
        status: ctx.experiment.status,
        rolloutPct: ctx.experiment.rolloutPct,
        guardrails: ctx.experiment.guardrails,
        lastMetrics: ctx.experiment.lastMetrics,
        lastMonitoredAt: ctx.experiment.lastMonitoredAt,
        rollbackReason: ctx.experiment.rollbackReason,
      },
      liveRule: rule ? { _id: rule._id, enabled: rule.enabled, updatedAt: rule.updatedAt } : null,
    };
  });
}

module.exports = { attachStages };
