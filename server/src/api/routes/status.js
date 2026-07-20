// Admin API routes — status
const express = require("express");
const Cap = require("../../models/Cap");
const auth = require("../../gateway/auth");
const ruleEngine = require("../../routing/ruleEngine");
const connections = require("../../providers/connections");
const Settings = require("../../models/Settings");
const { capStatus } = require("./_shared");

const router = express.Router();

// ── status / health ──
router.get("/status", async (_req, res, next) => {
  try {
    const [routingMode, requireApiKey, eff, caps] = await Promise.all([
      ruleEngine.getRoutingMode(),
      auth.requireApiKeyOn(),
      connections.effective(),
      Cap.find({ enabled: true }).lean(),
    ]);
    const breachedCaps = (await Promise.all(caps.map(capStatus))).filter((c) => c.breached).length;
    res.json({
      demoMode: eff.demoMode,
      liveProviders: eff.liveIds,
      defaultProvider: eff.defaultProvider,
      defaultModel: eff.defaultModel,
      routingMode,
      requireApiKey,
      breachedCaps,
    });
  } catch (e) { next(e); }
});

router.get("/about", async (_req, res, next) => {
  try {
    // package.json is at the repo root (server/src/api → ../../../). Guarded so a missing file
    // degrades to "unknown version" instead of 500-ing /about (which ops/deploy.sh reads for the
    // model-seed version).
    let pkg = {};
    try { pkg = require("../../../../package.json"); } catch { /* version unknown */ }
    const s = await Settings.get().catch(() => null);
    res.json({
      version: pkg.version,
      name: pkg.name,
      sdkJs: "0.2.0",
      sdkPython: "0.2.0",
      nodeVersion: process.version,
      modelSeedVersion: s?.modelSeedVersion ?? null, // ops/deploy.sh uses this to detect a re-seed
    });
  } catch (e) { next(e); }
});


module.exports = router;
