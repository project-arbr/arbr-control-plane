"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { aggregateGroups, parseJsonl, runAudit } = require("../src/audit");
const { renderReport } = require("../src/report");

test("aggregateGroups sums requests/tokens/cost per (taskType, model, provider)", () => {
  const records = [
    { taskType: "classification", model: "claude-opus-4-8", provider: "anthropic", promptTokens: 100, completionTokens: 10, totalCost: 1 },
    { taskType: "classification", model: "claude-opus-4-8", provider: "anthropic", promptTokens: 200, completionTokens: 20, totalCost: 2 },
    { taskType: "faq", model: "gpt-4o-mini", provider: "openai", promptTokens: 50, completionTokens: 5, totalCost: 0.01 },
  ];
  const { groups, totalRequests, totalCost } = aggregateGroups(records);
  assert.equal(totalRequests, 3);
  assert.equal(totalCost, 3.01);

  const classify = groups.find((g) => g.taskType === "classification");
  assert.equal(classify.requests, 2);
  assert.equal(classify.promptTokens, 300);
  assert.equal(classify.completionTokens, 30);
  assert.equal(classify.currentCost, 3);
});

test("runAudit flags premium-model overuse using the vendored pricing table + engine", async () => {
  // Mirrors the shape (not the numbers) of server/test/unit/recommendPlan.test.js's
  // fixture: enough "classification" volume on a premium model to clear MIN_REQUESTS
  // (20) and produce a global (no-application) recommendation.
  const records = [];
  for (let i = 0; i < 25; i++) {
    records.push({ taskType: "classification", model: "claude-opus-4-8", provider: "anthropic", promptTokens: 500, completionTokens: 100, totalCost: 0.005 });
  }
  const tmpFile = path.join(require("node:os").tmpdir(), `arbr-cli-test-${Date.now()}.jsonl`);
  require("node:fs").writeFileSync(tmpFile, records.map((r) => JSON.stringify(r)).join("\n"));

  try {
    const result = await runAudit(tmpFile);
    assert.equal(result.totalRequests, 25);
    assert.equal(result.recommendations.length, 1);
    const rec = result.recommendations[0];
    assert.equal(rec.taskType, "classification");
    assert.equal(rec.currentModel, "claude-opus-4-8");
    assert.equal(rec.suggestedModel, "claude-haiku-4-5");
    assert.equal(rec.application, null); // no app concept in a solo audit — always the global fallback
    assert.ok(rec.projectedSavings > 0);
  } finally {
    require("node:fs").unlinkSync(tmpFile);
  }
});

test("runAudit finds no recommendations below the minimum-request threshold", async () => {
  const records = Array.from({ length: 5 }, () => ({
    taskType: "classification", model: "claude-opus-4-8", provider: "anthropic",
    promptTokens: 500, completionTokens: 100, totalCost: 0.005,
  }));
  const tmpFile = path.join(require("node:os").tmpdir(), `arbr-cli-test-${Date.now()}-below.jsonl`);
  require("node:fs").writeFileSync(tmpFile, records.map((r) => JSON.stringify(r)).join("\n"));
  try {
    const result = await runAudit(tmpFile);
    assert.equal(result.recommendations.length, 0);
  } finally {
    require("node:fs").unlinkSync(tmpFile);
  }
});

test("parseJsonl throws with the line number on malformed input", async () => {
  const tmpFile = path.join(require("node:os").tmpdir(), `arbr-cli-test-${Date.now()}-bad.jsonl`);
  require("node:fs").writeFileSync(tmpFile, '{"taskType":"faq"}\nnot json\n');
  try {
    await assert.rejects(() => parseJsonl(tmpFile), /:2: not valid JSON/);
  } finally {
    require("node:fs").unlinkSync(tmpFile);
  }
});

test("bundled sample.jsonl produces at least one flagged recommendation", async () => {
  const result = await runAudit(path.join(__dirname, "..", "fixtures", "sample.jsonl"));
  assert.ok(result.recommendations.length >= 1);
  assert.ok(result.flaggedSavings > 0);
});

test("renderReport produces a self-contained HTML string without throwing", async () => {
  const result = await runAudit(path.join(__dirname, "..", "fixtures", "sample.jsonl"));
  const html = renderReport(result, { generatedAt: new Date("2026-07-23T00:00:00Z") });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Arbr Audit Report/);
  assert.match(html, new RegExp(result.totalRequests.toLocaleString()));
});

test("renderReport handles the zero-recommendations case", () => {
  const html = renderReport({
    totalRequests: 10, totalCost: 1, groups: [], recommendations: [],
    flaggedCost: 0, flaggedSavings: 0, overusePct: 0,
  }, { generatedAt: new Date("2026-07-23T00:00:00Z") });
  assert.match(html, /No premium-model overuse found/);
});

test("renderReport in wrap mode skips the overuse empty-state and shows a per-model breakdown", () => {
  const html = renderReport({
    totalRequests: 12, totalCost: 3.5,
    groups: [
      { taskType: "unknown", model: "claude-opus-4-8", requests: 8, currentCost: 3 },
      { taskType: "unknown", model: "claude-haiku-4-5", requests: 4, currentCost: 0.5 },
    ],
    recommendations: [], flaggedCost: 0, flaggedSavings: 0, overusePct: 0,
  }, { mode: "wrap", generatedAt: new Date("2026-07-23T00:00:00Z") });

  assert.match(html, /Arbr Wrap Report/);
  assert.doesNotMatch(html, /No premium-model overuse found/);
  assert.match(html, /isn't task-classified/);
  assert.match(html, /claude-opus-4-8/);
  assert.match(html, /claude-haiku-4-5/);
  assert.match(html, /2<\/div>\s*<div class="stat-label">models used this session/);
});
