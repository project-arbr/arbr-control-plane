// Scoped, read-only usage API (/v1/usage/*).
//
// Authenticated by a "read" token (see gateway/readTokenAuth.js), which sets
// req.readScope = { application, userId }. Every query is FORCED to that scope, so a
// token can only ever read its own application (+ optional user) — the caller cannot
// widen it by passing query params. This is the self-serve, per-end-user usage view
// a partner app needs without proxying through the admin key.
//
// Mounted OUTSIDE the /api adminAuth gate (see index.js). Reuses the same analytics
// aggregation the console uses, so numbers match exactly.
const express = require("express");
const analytics = require("../../analytics/aggregate");

const router = express.Router();

const BUCKETS = new Set(["hour", "day", "month"]);

// Headline stats for this token's scope: cost, requests, tokens, success rate, cache.
router.get("/overview", async (req, res, next) => {
  try {
    res.json(await analytics.overview(req.readScope));
  } catch (e) { next(e); }
});

// Cost / request trend over time, for a chart. bucket ∈ hour | day | month.
router.get("/timeseries", async (req, res, next) => {
  try {
    const bucket = BUCKETS.has(req.query.bucket) ? req.query.bucket : "day";
    res.json(await analytics.timeseries(req.readScope, bucket));
  } catch (e) { next(e); }
});

// Spend + usage broken down by model, within this token's scope.
router.get("/by-model", async (req, res, next) => {
  try {
    res.json(await analytics.byModel(req.readScope));
  } catch (e) { next(e); }
});

// Echo the token's own scope, so a client knows what it is allowed to see.
router.get("/scope", (req, res) => {
  res.json({ application: req.readScope.application, userId: req.readScope.userId });
});

module.exports = router;
