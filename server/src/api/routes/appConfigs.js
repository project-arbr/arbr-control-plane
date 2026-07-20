// Admin API routes — appConfigs
const express = require("express");
const { logAction } = require("../auditLogger");
const { requireRole } = require("../rbac");
const aiPolicy = require("../../routing/aiPolicy");
const { toRouterConfig, getRouter } = require("../../providers/router");
const Settings = require("../../models/Settings");
const { config, KNOWN_PROVIDERS } = require("../../config");

const router = express.Router();

// ── Per-application config (kill switch, model opt-out, AI policy override) ──
const ApplicationConfig = require("../../models/ApplicationConfig");

const DEFAULT_APP_CONFIG = { killSwitchEnabled: false, killSwitchMessage: null, modelOptOut: [], aiPolicyAssignments: null };

router.get("/app-configs", async (_req, res, next) => {
  try {
    const configs = await ApplicationConfig.find().lean();
    res.json(configs);
  } catch (e) { next(e); }
});

router.get("/app-configs/:app", async (req, res, next) => {
  try {
    const cfg = await ApplicationConfig.findOne({ applicationName: req.params.app }).lean();
    res.json(cfg ? cfg : { applicationName: req.params.app, ...DEFAULT_APP_CONFIG });
  } catch (e) { next(e); }
});

router.put("/app-configs/:app", requireRole("operator"), async (req, res, next) => {
  try {
    const { killSwitchEnabled, killSwitchMessage, modelOptOut, aiPolicyAssignments } = req.body || {};
    const update = {};
    if (typeof killSwitchEnabled === "boolean") update.killSwitchEnabled = killSwitchEnabled;
    if ("killSwitchMessage" in req.body) update.killSwitchMessage = killSwitchMessage ? String(killSwitchMessage).trim() : null;
    if (Array.isArray(modelOptOut)) update.modelOptOut = modelOptOut.filter(Boolean);
    if ("aiPolicyAssignments" in req.body) update.aiPolicyAssignments = aiPolicyAssignments || null;
    const cfg = await ApplicationConfig.findOneAndUpdate(
      { applicationName: req.params.app },
      { $set: update },
      { new: true, upsert: true }
    ).lean();
    setImmediate(() => logAction("appConfig.update", "appConfig", req.params.app, update, req.user));
    res.json(cfg);
  } catch (e) { next(e); }
});

router.post("/app-configs/:app/generate-policy", requireRole("operator"), async (req, res, next) => {
  try {
    const { router: r, eff } = await getRouter();
    if (!r) return res.status(503).json({ error: "no live providers — cannot generate policy" });
    const excludeModels = Array.isArray(req.body?.excludeModels) ? req.body.excludeModels : [];
    const goal = String(req.body?.goal || "balanced");
    const { assignments, generatorModel } = await aiPolicy.computeAssignments({ router: r, eff, excludeModels, goal });
    const generatedAt = new Date();
    const cfg = await ApplicationConfig.findOneAndUpdate(
      { applicationName: req.params.app },
      { $set: { aiPolicyAssignments: assignments } },
      { new: true, upsert: true }
    ).lean();
    setImmediate(() => logAction("appConfig.generatePolicy", "appConfig", req.params.app, { excludeModels, goal }, req.user));
    const simulation = await aiPolicy.simulate({ assignments, application: req.params.app, windowDays: Number(req.body?.windowDays) || 14 });
    res.json({ assignments, generatedAt, generatorModel: generatorModel.id, cfg, simulation });
  } catch (e) { next(e); }
});

// Project a proposed policy's cost + capability over this app's recent traffic (no persist).
router.post("/app-configs/:app/simulate", async (req, res, next) => {
  try {
    const simulation = await aiPolicy.simulate({
      assignments: req.body?.assignments || {},
      application: req.params.app,
      windowDays: Number(req.body?.windowDays) || 14,
    });
    res.json(simulation);
  } catch (e) { next(e); }
});

router.post("/app-configs/:app/set-default-policy", requireRole("administrator"), async (req, res, next) => {
  try {
    const cfg = await ApplicationConfig.findOne({ applicationName: req.params.app }).lean();
    if (!cfg?.aiPolicyAssignments) return res.status(400).json({ error: "No custom policy set for this application." });
    await Settings.updateOne({ key: "global" }, { $set: { aiPolicy: cfg.aiPolicyAssignments } }, { upsert: true });
    Settings.invalidateCache();
    aiPolicy.invalidate?.();
    setImmediate(() => logAction("appConfig.setDefaultPolicy", "settings", "global", { from: req.params.app }, req.user));
    res.json({ ok: true });
  } catch (e) { next(e); }
});


module.exports = router;
