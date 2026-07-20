// Admin API routes — governance
const express = require("express");
const { logAction } = require("../auditLogger");
const Settings = require("../../models/Settings");

const router = express.Router();

// ── Governance settings (maintenance mode, max-tokens, webhook, retention, PII) ──
function governanceView(s) {
  return {
    maintenanceMode:         s.maintenanceMode || { enabled: false, message: "" },
    maxTokensGuardrail:      s.maxTokensGuardrail || null,
    globalRpmGuardrail:      s.globalRpmGuardrail || null,
    captureRequestPayloads:  s.captureRequestPayloads !== false,  // default true
    piiMaskingEnabled:       s.piiMaskingEnabled ?? false,
    customPiiPatterns:       s.customPiiPatterns || [],
    requireApiKey:           s.requireApiKey ?? false,
    webhookUrl:              s.webhookUrl || null,
    retentionDays:           s.retentionDays ?? 90,
    alertErrorRateEnabled:   s.alertErrorRateEnabled ?? false,
    alertErrorRateThreshold: s.alertErrorRateThreshold ?? 5,
    outputGuardrailsEnabled: s.outputGuardrailsEnabled ?? false,
    outputGuardrailRules:    s.outputGuardrailRules || [],
    maskPiiInResponses:      s.maskPiiInResponses ?? false,
    promptInjectionDetectionEnabled: s.promptInjectionDetectionEnabled ?? false,
    promptInjectionRules:    s.promptInjectionRules || [],
    semanticCacheEnabled:    s.semanticCacheEnabled ?? false,
    semanticCacheThreshold:  s.semanticCacheThreshold ?? 0.92,
    semanticCacheTtlMinutes: s.semanticCacheTtlMinutes ?? 60,
  };
}

router.get("/governance", async (_req, res, next) => {
  try {
    res.json(governanceView(await Settings.get()));
  } catch (e) { next(e); }
});

router.patch("/governance", async (req, res, next) => {
  try {
    const body = req.body || {};
    const update = {};
    if (body.maintenanceMode !== undefined) {
      update["maintenanceMode.enabled"] = !!body.maintenanceMode.enabled;
      if (typeof body.maintenanceMode.message === "string") {
        update["maintenanceMode.message"] = body.maintenanceMode.message.trim() || "Service temporarily unavailable.";
      }
    }
    if ("maxTokensGuardrail" in body)
      update.maxTokensGuardrail = body.maxTokensGuardrail ? Math.max(1, Number(body.maxTokensGuardrail)) : null;
    if ("globalRpmGuardrail" in body)
      update.globalRpmGuardrail = body.globalRpmGuardrail ? Math.max(1, Number(body.globalRpmGuardrail)) : null;
    if ("captureRequestPayloads" in body)
      update.captureRequestPayloads = !!body.captureRequestPayloads;
    if ("piiMaskingEnabled" in body)
      update.piiMaskingEnabled = !!body.piiMaskingEnabled;
    if ("customPiiPatterns" in body && Array.isArray(body.customPiiPatterns))
      update.customPiiPatterns = body.customPiiPatterns.filter(p => p.name && p.pattern);
    if ("requireApiKey" in body)
      update.requireApiKey = !!body.requireApiKey;
    if ("webhookUrl" in body)
      update.webhookUrl = body.webhookUrl ? String(body.webhookUrl).trim() : null;
    if ("retentionDays" in body)
      update.retentionDays = Math.max(0, Number(body.retentionDays) || 0) || null;
    if ("alertErrorRateEnabled" in body)
      update.alertErrorRateEnabled = !!body.alertErrorRateEnabled;
    if ("alertErrorRateThreshold" in body)
      update.alertErrorRateThreshold = Math.min(100, Math.max(0, Number(body.alertErrorRateThreshold) || 5));
    if ("outputGuardrailsEnabled" in body)
      update.outputGuardrailsEnabled = !!body.outputGuardrailsEnabled;
    if (Array.isArray(body.outputGuardrailRules))
      update.outputGuardrailRules = body.outputGuardrailRules.filter(r => r.pattern);
    if ("maskPiiInResponses" in body)
      update.maskPiiInResponses = !!body.maskPiiInResponses;
    if ("promptInjectionDetectionEnabled" in body)
      update.promptInjectionDetectionEnabled = !!body.promptInjectionDetectionEnabled;
    if (Array.isArray(body.promptInjectionRules))
      update.promptInjectionRules = body.promptInjectionRules.filter(r => r.pattern);
    if ("semanticCacheEnabled" in body)
      update.semanticCacheEnabled = !!body.semanticCacheEnabled;
    if ("semanticCacheThreshold" in body)
      update.semanticCacheThreshold = Math.min(1, Math.max(0, Number(body.semanticCacheThreshold) || 0.92));
    if ("semanticCacheTtlMinutes" in body)
      update.semanticCacheTtlMinutes = Math.max(1, Number(body.semanticCacheTtlMinutes) || 60);

    await Settings.updateOne({ key: "global" }, { $set: update }, { upsert: true });
    Settings.invalidateCache();
    const s = await Settings.get();
    setImmediate(() => logAction("governance.update", "settings", "global", body));
    res.json(governanceView(s));
  } catch (e) { next(e); }
});


module.exports = router;
