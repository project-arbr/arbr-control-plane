// Admin API routes — requests
const express = require("express");
const RequestRecord = require("../../models/RequestRecord");
const analytics = require("../../analytics/aggregate");
const { csvCell } = require("../../utils/csv");

const router = express.Router();

// ── request records (filterable, paginated) ──
router.get("/requests", async (req, res, next) => {
  try {
    const match = analytics.buildMatch(req.query);
    const limit = Math.min(Number(req.query.limit) || 50, 500);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const [items, total] = await Promise.all([
      // Exclude the heavy captured-context fields from the list — the drilldown fetches them by id.
      RequestRecord.find(match).select("-messages -responseText").sort({ timestamp: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      RequestRecord.countDocuments(match),
    ]);
    res.json({ items, total, page, limit });
  } catch (e) { next(e); }
});

// CSV export — same filters as /requests but no pagination; streams all matching rows.
router.get("/requests/export", async (req, res, next) => {
  try {
    const match = analytics.buildMatch(req.query);
    const COLS = [
      "timestamp", "requestId", "application", "workflow", "department", "userId",
      "taskType", "model", "modelRequested", "provider", "routingDecision", "classifiedBy",
      "promptTokens", "completionTokens", "totalTokens", "totalCost",
      "latencyMs", "status", "cacheHit", "difficulty", "difficultyScore",
    ];
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="requests.csv"');
    res.write(COLS.join(",") + "\n");
    const cursor = RequestRecord.find(match).select(COLS.join(" ")).sort({ timestamp: -1 }).lean().cursor();
    for await (const doc of cursor) {
      res.write(COLS.map((c) => csvCell(doc[c])).join(",") + "\n");
    }
    res.end();
  } catch (e) { next(e); }
});

// Full single record incl. captured payload + response (for the request drilldown).
router.get("/requests/:id", async (req, res, next) => {
  try {
    const doc = await RequestRecord.findOne({ requestId: req.params.id }).lean();
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json(doc);
  } catch (e) { next(e); }
});


module.exports = router;
