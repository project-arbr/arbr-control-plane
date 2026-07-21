// F-05: exportable recommendation evidence report. Computed on demand, never stored — same
// pattern as ./outcome.js — so it's always "regenerated from immutable identifiers and
// historical records" by construction, no separate snapshot to go stale.
//
// Deliberately never touches EvalResult, RequestRecord.messages, or RequestRecord.responseText
// — every section reads only aggregate/reason-string fields (EvalRun.summary/.failures,
// RoutingExperiment.lastMetrics) or reuses outcome.js's computeOutcome() verbatim (already
// metadata-only). This is what makes "no prompt/response text in metadata-only mode" true by
// construction rather than a runtime filter that could be forgotten later.
const EvalDataset = require("../models/EvalDataset");
const EvalRun = require("../models/EvalRun");
const EvalCampaign = require("../models/EvalCampaign");
const RoutingExperiment = require("../models/RoutingExperiment");
const Rule = require("../models/Rule");
const AuditLog = require("../models/AuditLog");
const Settings = require("../models/Settings");
const pricing = require("../pricing/registry");
const { deriveStage } = require("./stage");
const { targetCountForRisk } = require("../eval/thresholds");
const outcome = require("./outcome");

const MASKING_CAVEAT =
  "Privacy settings shown reflect the CURRENT configuration, not necessarily what was in " +
  "effect at the time this recommendation's dataset/eval/rollout actually ran — Settings is a " +
  "live, mutable singleton with no historical snapshot per run.";

async function buildReport(rec) {
  const [dataset, run, campaign, experiment, rules, settings] = await Promise.all([
    rec.evalDatasetId ? EvalDataset.findById(rec.evalDatasetId).lean() : null,
    rec.evalRunId ? EvalRun.findById(rec.evalRunId).lean() : null,
    rec.shadowCampaignId ? EvalCampaign.findById(rec.shadowCampaignId).lean() : null,
    rec.experimentId ? RoutingExperiment.findById(rec.experimentId).lean() : null,
    Rule.find({ sourceRecommendation: rec._id }).lean(),
    Settings.get(),
  ]);

  const { stage, label: stageLabel } = deriveStage({ rec, dataset, run, campaign, experiment, rules });
  const liveRule = rules.find((r) => r.enabled) || null;

  const linkedIds = [
    rec._id, rec.evalDatasetId, rec.evalRunId, rec.shadowCampaignId, rec.experimentId,
    ...rules.map((r) => r._id),
  ].filter(Boolean).map(String);
  const history = await AuditLog.find({ entityId: { $in: linkedIds } })
    .sort({ timestamp: 1 }).lean();

  const outcomeResult = liveRule ? await outcome.computeOutcome(rec) : null;

  const caveats = [MASKING_CAVEAT];

  const currentKnown = !!pricing.getModel(rec.currentModel);
  const suggestedKnown = !!pricing.getModel(rec.suggestedModel);
  if (!currentKnown) caveats.push(`Unknown pricing for the current model "${rec.currentModel}" — cost figures involving it are incomplete.`);
  if (!suggestedKnown) caveats.push(`Unknown pricing for the suggested model "${rec.suggestedModel}" — cost figures involving it are incomplete.`);

  if (run && run.summary) {
    const target = targetCountForRisk(run.riskTier);
    const judged = Number(run.summary.judged) || 0;
    if (judged < target) {
      caveats.push(`Insufficient eval sample: ${judged} judged vs. the ${target}-item target for "${run.riskTier}" risk.`);
    }
  }

  if (outcomeResult && outcomeResult.live) {
    const floor = (experiment && experiment.minSampleForRollback) || 20;
    if ((outcomeResult.sampleSizes.candidateRequests || 0) < floor) {
      caveats.push(`Insufficient outcome sample: only ${outcomeResult.sampleSizes.candidateRequests} candidate requests observed since rollout (floor: ${floor}).`);
    }
  }

  if (experiment && experiment.status === "rolled_back") {
    const audited = history.some((h) => h.action === "canary.rollback" && String(h.entityId) === String(experiment._id));
    if (!audited) {
      caveats.push("This rollback has no matching audit-log entry — reconstructed from live document state (rollbackReason/lastMetrics), consistent with an automatic guardrail-triggered rollback rather than a manually audited one.");
    }
  }

  return {
    reportVersion: 1,
    generatedAt: new Date(),
    recommendation: {
      id: rec._id, title: rec.title, reason: rec.reason, taskType: rec.taskType,
      application: rec.application, workflow: rec.workflow, department: rec.department,
      currentModel: rec.currentModel, currentProvider: rec.currentProvider,
      suggestedModel: rec.suggestedModel, suggestedProvider: rec.suggestedProvider,
      dedupeKey: rec.dedupeKey, createdAt: rec.createdAt,
    },
    stage, stageLabel,
    trafficScope: {
      application: rec.application, workflow: rec.workflow, taskType: rec.taskType,
      requestCount: rec.requestCount, replayableCount: rec.replayableCount,
    },
    models: {
      current: { id: rec.currentModel, knownPricing: currentKnown },
      suggested: { id: rec.suggestedModel, knownPricing: suggestedKnown },
    },
    privacy: {
      current: {
        piiMaskingEnabled: settings.piiMaskingEnabled,
        captureRequestPayloads: settings.captureRequestPayloads,
        retentionDays: settings.retentionDays,
      },
      dataset: dataset ? { piiMode: dataset.piiMode, riskTier: dataset.riskTier } : null,
      caveat: MASKING_CAVEAT,
    },
    evaluation: run ? {
      runId: run._id, status: run.status, fidelity: run.fidelity, riskTier: run.riskTier,
      summary: run.summary, failures: run.failures,
      sufficientSample: run.summary ? (Number(run.summary.judged) || 0) >= targetCountForRisk(run.riskTier) : null,
    } : null,
    shadow: campaign ? {
      campaignId: campaign._id, status: campaign.status, statusReason: campaign.statusReason,
      thresholds: campaign.thresholds,
    } : null,
    rollout: experiment ? {
      experimentId: experiment._id, status: experiment.status, rolloutPct: experiment.rolloutPct,
      guardrails: experiment.guardrails, lastMetrics: experiment.lastMetrics,
      lastMonitoredAt: experiment.lastMonitoredAt, rollbackReason: experiment.rollbackReason,
    } : null,
    history: history.map((h) => ({
      timestamp: h.timestamp, action: h.action, entity: h.entity, entityId: h.entityId,
      changes: h.changes, actor: h.actor,
    })),
    outcome: outcomeResult,
    caveats,
  };
}

function fmtPct(n) {
  if (n == null || isNaN(n)) return "n/a";
  return `${(Number(n) * 100).toFixed(1)}%`;
}
function fmtUsd(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}
function fmtActor(a) {
  if (!a) return "unknown";
  return typeof a === "string" ? a : (a.email || a.id || "unknown");
}

// Pure — renders the report shape into a human-readable markdown document. No I/O, no DB.
function renderMarkdown(report) {
  const r = report.recommendation;
  const lines = [];
  lines.push(`# Evidence report: ${r.title || r.taskType || r.id}`);
  lines.push("");
  lines.push(`Generated ${new Date(report.generatedAt).toISOString()} · report version ${report.reportVersion}`);
  lines.push(`Stage: **${report.stageLabel}**`);
  lines.push("");
  lines.push("## Recommendation");
  lines.push(`- Model substitution: \`${r.currentModel}\` → \`${r.suggestedModel}\``);
  lines.push(`- Task type: ${r.taskType || "—"} · Application: ${r.application || "any"} · Workflow: ${r.workflow || "any"}`);
  lines.push(`- Reason: ${r.reason}`);
  lines.push(`- Created: ${new Date(r.createdAt).toISOString()}`);
  lines.push("");

  lines.push("## Traffic scope");
  lines.push(`- ${report.trafficScope.requestCount ?? 0} requests observed` +
    (report.trafficScope.replayableCount != null ? `, ${report.trafficScope.replayableCount} replayable` : ""));
  lines.push("");

  lines.push("## Models");
  lines.push(`- Current (\`${report.models.current.id}\`): pricing ${report.models.current.knownPricing ? "known" : "**UNKNOWN**"}`);
  lines.push(`- Suggested (\`${report.models.suggested.id}\`): pricing ${report.models.suggested.knownPricing ? "known" : "**UNKNOWN**"}`);
  lines.push("");

  lines.push("## Privacy / masking policy");
  lines.push(`- PII masking enabled (current): ${report.privacy.current.piiMaskingEnabled}`);
  lines.push(`- Payload capture enabled (current): ${report.privacy.current.captureRequestPayloads}`);
  lines.push(`- Retention (days, current): ${report.privacy.current.retentionDays}`);
  if (report.privacy.dataset) {
    lines.push(`- Eval dataset masking mode: ${report.privacy.dataset.piiMode} · risk tier: ${report.privacy.dataset.riskTier}`);
  }
  lines.push(`- ⚠️ ${report.privacy.caveat}`);
  lines.push("");

  lines.push("## Evaluation");
  if (!report.evaluation) {
    lines.push("No offline eval has been run for this recommendation yet.");
  } else {
    const e = report.evaluation;
    const s = e.summary || {};
    lines.push(`- Run status: **${e.status}** · fidelity: ${e.fidelity} · risk tier: ${e.riskTier}`);
    lines.push(`- Judged: ${s.judged ?? "—"} · worse-rate: ${fmtPct(s.worseRate)} · critical-fail-rate: ${fmtPct(s.criticalFailRate)} · format-pass-rate: ${fmtPct(s.formatPassRate)}`);
    lines.push(`- Cost saving: ${fmtPct(s.costSavingPct)} · avg latency delta: ${fmtPct(s.avgLatencyDeltaPct)}`);
    lines.push(`- Sample sufficiency: ${e.sufficientSample === false ? "**INSUFFICIENT**" : e.sufficientSample === true ? "sufficient" : "n/a"}`);
    if (e.failures && e.failures.length) {
      lines.push("- Failure reasons:");
      for (const f of e.failures) lines.push(`  - ${f}`);
    }
  }
  lines.push("");

  lines.push("## Shadow evaluation");
  if (!report.shadow) {
    lines.push("No shadow campaign was run for this recommendation.");
  } else {
    const sh = report.shadow;
    lines.push(`- Status: **${sh.status}**${sh.statusReason ? ` (${sh.statusReason})` : ""}`);
    lines.push(`- Safe-to-switch gate: ${sh.thresholds?.minPairs ?? "—"} judged pairs at or below ${fmtPct(sh.thresholds?.maxLossRate)} loss rate.`);
  }
  lines.push("");

  lines.push("## Rollout");
  if (!report.rollout) {
    lines.push("No canary rollout was run for this recommendation.");
  } else {
    const ro = report.rollout;
    const g = ro.guardrails || {};
    const m = ro.lastMetrics || {};
    lines.push(`- Status: **${ro.status}** · rollout: ${ro.rolloutPct}%`);
    lines.push(`- Guardrails (configured / last observed): error rate +${fmtPct(g.maxErrorRateIncrease)} max / ${m.candErrorRate != null ? fmtPct((m.candErrorRate ?? 0) - (m.baseErrorRate ?? 0)) : "—"}, ` +
      `latency ${fmtPct(g.maxLatencyRegressionPct)} max / ${fmtPct(m.latencyRegressionPct)}, ` +
      `cost saving ${fmtPct(g.minCostSavingPct)} min / ${fmtPct(m.costSavingPct)}, ` +
      `worse-rate ${fmtPct(g.maxWorseRate)} max / ${fmtPct(m.worseRate)}`);
    if (ro.lastMonitoredAt) lines.push(`- Guardrails last checked: ${new Date(ro.lastMonitoredAt).toISOString()}`);
    if (ro.status === "rolled_back") lines.push(`- Rollback reason: ${ro.rollbackReason || "—"}`);
  }
  lines.push("");

  lines.push("## Approval and rollout history");
  if (!report.history.length) {
    lines.push("No audit-log entries found for this recommendation or its linked records.");
  } else {
    for (const h of report.history) {
      lines.push(`- ${new Date(h.timestamp).toISOString()} · **${h.action}** (${h.entity}) by ${fmtActor(h.actor)}` +
        (h.changes ? ` — ${JSON.stringify(h.changes)}` : ""));
    }
  }
  lines.push("");

  lines.push("## Measured outcome (projected vs. realised)");
  if (!report.outcome) {
    lines.push("Not applicable — no enabled rule is routing traffic for this recommendation yet.");
  } else if (!report.outcome.live) {
    lines.push(report.outcome.message);
  } else {
    const o = report.outcome;
    lines.push(`- Projected savings: ${fmtUsd(o.projected.savings)} · Realised savings: ${fmtUsd(o.realised.savings)} (${o.realised.substitutedRequests} substituted requests)`);
    lines.push(`- Latency — candidate: ${o.latency.candidateAvgMs ?? "—"}ms vs. baseline: ${o.latency.baselineAvgMs ?? "—"}ms (${fmtPct(o.latency.deltaPct)})`);
    lines.push(`- Errors — candidate: ${fmtPct(o.errors.candidateRate)} vs. baseline: ${fmtPct(o.errors.baselineRate)}`);
    lines.push(`- Sample sizes — candidate: ${o.sampleSizes.candidateRequests} · baseline: ${o.sampleSizes.baselineRequests}`);
    lines.push(`- Live since: ${new Date(o.liveSince).toISOString()}`);
    lines.push(`- ⚠️ ${o.caveat}`);
  }
  lines.push("");

  lines.push("## Notes and limitations");
  for (const c of report.caveats) lines.push(`- ${c}`);
  lines.push("");

  return lines.join("\n");
}

module.exports = { buildReport, renderMarkdown };
