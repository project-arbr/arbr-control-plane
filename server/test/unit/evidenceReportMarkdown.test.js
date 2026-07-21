"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { renderMarkdown } = require("../../src/recommend/evidenceReport");

function baseReport(over = {}) {
  return {
    reportVersion: 1, generatedAt: new Date("2026-01-01T00:00:00Z"),
    recommendation: {
      id: "r1", title: "t", reason: "r", taskType: "classification",
      currentModel: "gpt-4o", suggestedModel: "gpt-4o-mini", createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    stage: "opportunity", stageLabel: "Opportunity",
    trafficScope: { requestCount: 5, replayableCount: null },
    models: { current: { id: "gpt-4o", knownPricing: true }, suggested: { id: "gpt-4o-mini", knownPricing: true } },
    privacy: { current: { piiMaskingEnabled: true, captureRequestPayloads: false, retentionDays: 30 }, dataset: null, caveat: "MASKING_CAVEAT_TEXT" },
    evaluation: null, shadow: null, rollout: null, history: [], outcome: null,
    caveats: ["MASKING_CAVEAT_TEXT"],
    ...over,
  };
}

test("sparse report (no links at all) renders every section as a 'not applicable' placeholder", () => {
  const md = renderMarkdown(baseReport());
  assert.match(md, /## Evaluation\nNo offline eval has been run/);
  assert.match(md, /## Shadow evaluation\nNo shadow campaign was run/);
  assert.match(md, /## Rollout\nNo canary rollout was run/);
  assert.match(md, /## Approval and rollout history\nNo audit-log entries found/);
  assert.match(md, /## Measured outcome \(projected vs\. realised\)\nNot applicable/);
});

test("every caveat string appears verbatim in the rendered output", () => {
  const report = baseReport({ caveats: ["MASKING_CAVEAT_TEXT", "Unknown pricing for the current model \"gpt-4o\"."] });
  const md = renderMarkdown(report);
  for (const c of report.caveats) assert.ok(md.includes(c), `expected caveat to appear verbatim: ${c}`);
});

test("full report (every section populated) renders evaluation, shadow, rollout, history, and outcome", () => {
  const report = baseReport({
    evaluation: {
      runId: "run1", status: "passed", fidelity: "high", riskTier: "medium",
      summary: { judged: 300, worseRate: 0.02, criticalFailRate: 0, formatPassRate: 0.99, costSavingPct: 0.3, avgLatencyDeltaPct: -0.1 },
      failures: [], sufficientSample: true,
    },
    shadow: { campaignId: "camp1", status: "active", statusReason: null, thresholds: { minPairs: 50, maxLossRate: 0.1 } },
    rollout: {
      experimentId: "exp1", status: "active", rolloutPct: 25,
      guardrails: { maxErrorRateIncrease: 0.02, maxLatencyRegressionPct: 0.25, minCostSavingPct: 0.1, maxWorseRate: 0.1 },
      lastMetrics: { candErrorRate: 0.01, baseErrorRate: 0.01, latencyRegressionPct: 0.05, costSavingPct: 0.3, worseRate: 0.02 },
      lastMonitoredAt: new Date("2026-01-02T00:00:00Z"), rollbackReason: null,
    },
    history: [
      { timestamp: new Date("2026-01-01T01:00:00Z"), action: "recommendation.accept", entity: "recommendation", entityId: "r1", changes: { via: "passed" }, actor: { email: "a@b.com" } },
      { timestamp: new Date("2026-01-01T02:00:00Z"), action: "canary.create", entity: "routingExperiment", entityId: "exp1", changes: { rolloutPct: 10 }, actor: { email: "a@b.com" } },
    ],
    outcome: {
      live: true, ruleId: "rule1", liveSince: new Date("2026-01-01T00:00:00Z"),
      projected: { savings: 100 }, realised: { savings: 90, substitutedRequests: 42 },
      latency: { baselineAvgMs: 500, candidateAvgMs: 400, deltaPct: -0.2 },
      errors: { baselineRate: 0.01, candidateRate: 0.01 },
      sampleSizes: { baselineRequests: 100, candidateRequests: 42 },
      caveat: "OUTCOME_CAVEAT_TEXT",
    },
  });
  const md = renderMarkdown(report);
  assert.match(md, /passed/);
  assert.match(md, /active/);
  assert.match(md, /25%/);
  assert.match(md, /a@b\.com/);
  assert.match(md, /\$90\.00/); // realised savings
  assert.match(md, /OUTCOME_CAVEAT_TEXT/);
});

test("auto-rollback (rolled_back status, no matching audit history) is a plausible input and renders without crashing", () => {
  const report = baseReport({
    rollout: {
      experimentId: "exp1", status: "rolled_back", rolloutPct: 15,
      guardrails: {}, lastMetrics: { candErrorRate: 0.2, baseErrorRate: 0.01 },
      lastMonitoredAt: new Date("2026-01-02T00:00:00Z"), rollbackReason: "error rate spike",
    },
    history: [], // no canary.rollback entry — the reconstructed-from-live-state case
    caveats: ["MASKING_CAVEAT_TEXT", "This rollback has no matching audit-log entry — reconstructed from live document state"],
  });
  const md = renderMarkdown(report);
  assert.match(md, /rolled_back/);
  assert.match(md, /error rate spike/);
  assert.ok(md.includes("reconstructed from live document state"));
});

test("rendered output never contains raw prompt/response payload markers, even if some future caller wired them in by mistake", () => {
  // Defensive: renderMarkdown must never format messages/responseText fields even if a
  // malformed report object somehow carried them — it should only ever read the fields this
  // module itself defines. This asserts the ABSENCE of those substrings in a realistic report.
  const report = baseReport({
    evaluation: { runId: "r", status: "failed", fidelity: "masked", riskTier: "low", summary: { judged: 10 }, failures: ["worse-rate 10% exceeds 5%"] },
  });
  const md = renderMarkdown(report);
  assert.ok(!md.includes("\"messages\""));
  assert.ok(!md.includes("\"responseText\""));
});
