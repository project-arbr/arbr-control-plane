// Admin API routes — analytics
const express = require("express");
const Rule = require("../../models/Rule");
const Recommendation = require("../../models/Recommendation");
const analytics = require("../../analytics/aggregate");
const RoutingExperiment = require("../../models/RoutingExperiment");

const router = express.Router();

// ── analytics ──
router.get("/analytics/overview", async (req, res, next) => {
  try { res.json(await analytics.overview(req.query)); } catch (e) { next(e); }
});

// Arbr's own overhead — what the control plane spent on the customer's provider keys
// making calls for itself (task classification, policy generation, eval judging,
// connection tests). Real money, counted in the headline total, but excluded from every
// customer dimension view because it belongs to no application.
router.get("/analytics/internal-spend", async (req, res, next) => {
  try { res.json(await analytics.internalSpend(req.query)); } catch (e) { next(e); }
});

// Adoption / acceptance-rate — the "production truth" beside benchmark scores: what humans actually
// did with Arbr's suggestions (accepted vs dismissed) and its canaries (promoted vs rolled back).
router.get("/analytics/acceptance", async (_req, res, next) => {
  try {
    const rc = Object.fromEntries((await Recommendation.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
    const accepted = rc.accepted || 0, dismissed = rc.dismissed || 0, pending = rc.pending || 0;
    const decided = accepted + dismissed;
    const overridden = await Recommendation.countDocuments({ evalStatus: "overridden" });
    const ec = Object.fromEntries((await RoutingExperiment.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }])).map((r) => [r._id, r.n]));
    const promoted = ec.promoted || 0, rolledBack = ec.rolled_back || 0;
    const canaryDecided = promoted + rolledBack;
    res.json({
      recommendations: { total: accepted + dismissed + pending, accepted, dismissed, pending, overridden,
        acceptanceRate: decided ? accepted / decided : null },
      canaries: { promoted, rolledBack, active: ec.active || 0, paused: ec.paused || 0,
        promotionRate: canaryDecided ? promoted / canaryDecided : null },
    });
  } catch (e) { next(e); }
});

const VIEWS = {
  application: analytics.byApplication,
  team: analytics.byTeam,
  workflow: analytics.byWorkflow,
  model: analytics.byModel,
  provider: analytics.byProvider,
  taskType: analytics.byTaskType,
  user: analytics.byUser,
};
router.get("/analytics/by/:dimension", async (req, res, next) => {
  try {
    const fn = VIEWS[req.params.dimension];
    if (!fn) return res.status(404).json({ error: "unknown dimension" });
    res.json(await fn(req.query));
  } catch (e) { next(e); }
});

router.get("/analytics/timeseries", async (req, res, next) => {
  try {
    const bucket = req.query.bucket === "hour" ? "hour" : "day";
    res.json(await analytics.timeseries(req.query, bucket));
  } catch (e) { next(e); }
});

router.get("/analytics/realised-savings", async (req, res, next) => {
  try { res.json(await analytics.realisedSavings(req.query)); } catch (e) { next(e); }
});

// Projected / accepted savings split by quality trust (eval-passed vs overridden vs ungated).
// Complements realised-savings (which is measured post-route) with the governance signal:
// how much of the optimization funnel is quality-gated.
router.get("/analytics/savings-trust", async (_req, res, next) => {
  try {
    const recs = await Recommendation.aggregate([
      { $match: { status: "accepted" } },
      {
        $group: {
          _id: { $ifNull: ["$acceptedVia", "ungated"] },
          count: { $sum: 1 },
          projectedSavings: { $sum: "$projectedSavings" },
        },
      },
    ]);
    const byVia = { passed: { count: 0, projectedSavings: 0 }, overridden: { count: 0, projectedSavings: 0 }, ungated: { count: 0, projectedSavings: 0 } };
    for (const r of recs) {
      const k = byVia[r._id] ? r._id : "ungated";
      byVia[k].count += r.count;
      byVia[k].projectedSavings += r.projectedSavings || 0;
    }
    const rules = await Rule.aggregate([
      {
        $group: {
          _id: { $ifNull: ["$qualityGate", "ungated"] },
          count: { $sum: 1 },
          enabled: { $sum: { $cond: ["$enabled", 1, 0] } },
        },
      },
    ]);
    const rulesByGate = { passed: { count: 0, enabled: 0 }, overridden: { count: 0, enabled: 0 }, ungated: { count: 0, enabled: 0 } };
    for (const r of rules) {
      const k = rulesByGate[r._id] ? r._id : "ungated";
      rulesByGate[k].count += r.count;
      rulesByGate[k].enabled += r.enabled || 0;
    }
    const gatedSavings = byVia.passed.projectedSavings;
    const totalAcceptedSavings = byVia.passed.projectedSavings + byVia.overridden.projectedSavings + byVia.ungated.projectedSavings;
    res.json({
      recommendations: byVia,
      rules: rulesByGate,
      gatedProjectedSavings: gatedSavings,
      ungatedProjectedSavings: byVia.overridden.projectedSavings + byVia.ungated.projectedSavings,
      totalAcceptedProjectedSavings: totalAcceptedSavings,
      gatedShare: totalAcceptedSavings > 0 ? gatedSavings / totalAcceptedSavings : null,
    });
  } catch (e) { next(e); }
});

router.get("/analytics/facets", async (_req, res, next) => {
  try { res.json(await analytics.facets()); } catch (e) { next(e); }
});


module.exports = router;
