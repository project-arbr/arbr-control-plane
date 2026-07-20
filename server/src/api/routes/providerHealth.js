// Admin API routes — providerHealth
const express = require("express");
const analytics = require("../../analytics/aggregate");

const router = express.Router();

// ── Provider health (error rate + avg latency over last 24h) ──
router.get("/analytics/provider-health", async (_req, res, next) => {
  try { res.json(await analytics.providerHealth()); } catch (e) { next(e); }
});

router.get("/analytics/latency-percentiles", async (req, res, next) => {
  try { res.json(await analytics.latencyPercentiles(req.query)); } catch (e) { next(e); }
});


module.exports = router;
