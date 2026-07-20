// Admin API routes — aiPolicy
const express = require("express");
const aiPolicy = require("../../routing/aiPolicy");
const { requireRole } = require("../rbac");
const { toRouterConfig, getRouter } = require("../../providers/router");
const Settings = require("../../models/Settings");

const router = express.Router();

// ── AI routing policy (task → model, generated/editable) ──
router.get("/ai-policy", async (_req, res, next) => {
  try {
    const s = await Settings.get();
    const storedVer = s.aiPolicy?.capabilityVersion ?? null;
    // Auto-regen when: assignments already exist (not a fresh install) AND version is stale.
    if (storedVer !== aiPolicy.CAPABILITY_VERSION && s.aiPolicy?.assignments) {
      const { router: r, eff } = await getRouter().catch(() => ({}));
      if (r) await aiPolicy.regenerate({ router: r, eff });
    }
    res.json(await aiPolicy.describe());
  } catch (e) { next(e); }
});

router.put("/ai-policy", requireRole("administrator"), async (req, res, next) => {
  try {
    await aiPolicy.setAssignments(req.body?.assignments || {});
    res.json(await aiPolicy.describe());
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

router.post("/ai-policy/regenerate", requireRole("administrator"), async (req, res, next) => {
  try {
    const { router: r, eff } = await getRouter();
    if (!r) return res.status(503).json({ error: "demo_mode", message: "Add a provider key to generate an AI policy." });
    const goal = String(req.body?.goal || "balanced");
    const pol = await aiPolicy.regenerate({ router: r, eff, goal });
    const simulation = await aiPolicy.simulate({ assignments: pol.assignments, windowDays: Number(req.body?.windowDays) || 14 });
    res.json({ ...(await aiPolicy.describe()), simulation });
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});

// Project a proposed policy's cost + capability over recent global traffic (no persist).
router.post("/ai-policy/simulate", async (req, res, next) => {
  try {
    const simulation = await aiPolicy.simulate({
      assignments: req.body?.assignments || {},
      windowDays: Number(req.body?.windowDays) || 14,
    });
    res.json(simulation);
  } catch (e) { res.status(400).json({ error: "bad_request", message: String(e.message || e) }); }
});


module.exports = router;
