// Admin API routes — analytics
const express = require("express");
const Recommendation = require("../../models/Recommendation");
const analytics = require("../../analytics/aggregate");
const RoutingExperiment = require("../../models/RoutingExperiment");

const router = express.Router();

// ── analytics ──
router.get("/analytics/overview", async (req, res, next) => {
  try { res.json(await analytics.overview(req.query)); } catch (e) { next(e); }
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

router.get("/analytics/facets", async (_req, res, next) => {
  try { res.json(await analytics.facets()); } catch (e) { next(e); }
});


module.exports = router;
