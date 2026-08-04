// Admin API routes — display currency (live FX).
const express = require("express");
const fx = require("../../currency/fx");
const { requireRole } = require("../rbac");
const { logAction } = require("../auditLogger");

const router = express.Router();

// Current display currency + rate + freshness (stale/available). Read by the console.
router.get("/currency", async (_req, res, next) => {
  try { res.json(await fx.getState()); } catch (e) { next(e); }
});

// Set the display currency; fx.setCurrency resets the cached rate then fetches the new
// one, so a failed fetch can't leave the previous currency's rate under the new label.
router.put("/currency", requireRole("administrator"), async (req, res, next) => {
  try {
    const code = String(req.body?.currency || "USD").trim().toUpperCase().slice(0, 3);
    if (!/^[A-Z]{3}$/.test(code)) return res.status(400).json({ error: "currency must be a 3-letter code (e.g. USD, INR)" });
    const state = await fx.setCurrency(code);
    setImmediate(() => logAction("currency.set", "settings", "global", { currency: code, rate: state.rate, available: state.available }, req.user));
    res.json(state);
  } catch (e) { next(e); }
});

// Force an FX rate refresh now (otherwise it runs on a schedule).
router.post("/currency/refresh", requireRole("operator"), async (_req, res, next) => {
  try { res.json(await fx.refreshRate()); } catch (e) { next(e); }
});

module.exports = router;
