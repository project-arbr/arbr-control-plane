// Admin API routes — governance
const express = require("express");
const { logAction } = require("../auditLogger");
const { requireRole } = require("../rbac");
const Settings = require("../../models/Settings");
const { config } = require("../../config");
const telemetry = require("../../telemetry");
const telemetryConfig = require("../../telemetry/config");

const router = express.Router();

// ── Governance settings (maintenance mode, max-tokens, webhook, retention, PII) ──
function governanceView(s) {
  const defaults = Settings.privacyDefaults(config.isProduction);
  return {
    maintenanceMode:         s.maintenanceMode || { enabled: false, message: "" },
    maxTokensGuardrail:      s.maxTokensGuardrail || null,
    globalRpmGuardrail:      s.globalRpmGuardrail || null,
    captureRequestPayloads:  s.captureRequestPayloads ?? defaults.captureRequestPayloads,
    piiMaskingEnabled:       s.piiMaskingEnabled ?? defaults.piiMaskingEnabled,
    customPiiPatterns:       s.customPiiPatterns || [],
    requireApiKey:           s.requireApiKey ?? false,
    webhookUrl:              s.webhookUrl || null,
    retentionDays:           s.retentionDays ?? defaults.retentionDays,
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
    // OTLP tracing. otelConfigured is read-only: whether ARBR_OTEL_ENABLED is set in
    // the environment (the hard gate). The editable fields only narrow an env-enabled
    // exporter; null means "use the environment value".
    otelConfigured:          telemetryConfig.enabled,
    otelEndpoint:            telemetryConfig.enabled ? telemetryConfig.endpointDisplay : null,
    otelEnabled:             s.otel?.enabled ?? null,
    otelSampleRatio:         s.otel?.sampleRatio ?? telemetryConfig.sampleRatio,
    otelCaptureContent:      s.otel?.captureContent ?? null,
  };
}

router.get("/governance", async (_req, res, next) => {
  try {
    res.json(governanceView(await Settings.get()));
  } catch (e) { next(e); }
});

router.patch("/governance", requireRole("administrator"), async (req, res, next) => {
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
    // OTLP tracing runtime overrides. These only narrow an env-enabled exporter.
    if ("otelEnabled" in body)
      update["otel.enabled"] = body.otelEnabled == null ? null : !!body.otelEnabled;
    if ("otelSampleRatio" in body)
      update["otel.sampleRatio"] = body.otelSampleRatio == null ? null : Math.min(1, Math.max(0, Number(body.otelSampleRatio) || 0));
    if ("otelCaptureContent" in body)
      update["otel.captureContent"] = body.otelCaptureContent == null ? null : !!body.otelCaptureContent;

    await Settings.updateOne({ key: "global" }, { $set: update }, { upsert: true });
    Settings.invalidateCache();
    const s = await Settings.get();
    // Push tracing changes to the live exporter now, rather than waiting for the poll.
    setImmediate(() => telemetry.refreshRuntime());
    setImmediate(() => logAction("governance.update", "settings", "global", body, req.user));
    res.json(governanceView(s));
  } catch (e) { next(e); }
});


module.exports = router;
