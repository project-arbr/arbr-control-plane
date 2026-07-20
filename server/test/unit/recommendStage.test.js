"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { STAGES, deriveStage } = require("../../src/recommend/stage");

const rec = (over) => ({ status: "pending", evalStatus: "not_started", ...over });

test("dismissed rec always returns dismissed, regardless of anything else linked", () => {
  const out = deriveStage({ rec: rec({ status: "dismissed" }), run: { status: "passed" } });
  assert.equal(out.stage, STAGES.DISMISSED);
});

test("no dataset, no run, replayableCount unset -> opportunity with build_dataset action", () => {
  const out = deriveStage({ rec: rec({}) });
  assert.equal(out.stage, STAGES.OPPORTUNITY);
  assert.equal(out.nextAction.actionKey, "build_dataset");
});

test("no dataset, replayableCount 0 -> opportunity with a none action (payload capture callout)", () => {
  const out = deriveStage({ rec: rec({ replayableCount: 0 }) });
  assert.equal(out.stage, STAGES.OPPORTUNITY);
  assert.equal(out.nextAction.actionKey, "none");
});

test("dataset creating -> dataset_building", () => {
  const out = deriveStage({ rec: rec({}), dataset: { status: "creating" } });
  assert.equal(out.stage, STAGES.DATASET_BUILDING);
});

test("dataset ready, no run yet -> dataset_ready with run_eval action", () => {
  const out = deriveStage({ rec: rec({}), dataset: { status: "ready" } });
  assert.equal(out.stage, STAGES.DATASET_READY);
  assert.equal(out.nextAction.actionKey, "run_eval");
});

test("run queued -> evaluating", () => {
  const out = deriveStage({ rec: rec({}), run: { status: "queued" } });
  assert.equal(out.stage, STAGES.EVALUATING);
});

test("run running -> evaluating", () => {
  const out = deriveStage({ rec: rec({}), run: { status: "running" } });
  assert.equal(out.stage, STAGES.EVALUATING);
});

test("run failed -> eval_failed with run_eval (retry) action", () => {
  const out = deriveStage({ rec: rec({}), run: { status: "failed" } });
  assert.equal(out.stage, STAGES.EVAL_FAILED);
  assert.equal(out.nextAction.actionKey, "run_eval");
});

test("run passed -> ready_for_rollout with accept action", () => {
  const out = deriveStage({ rec: rec({}), run: { status: "passed" } });
  assert.equal(out.stage, STAGES.READY_FOR_ROLLOUT);
  assert.equal(out.nextAction.actionKey, "accept");
});

test("evalStatus overridden with no run -> ready_for_rollout", () => {
  const out = deriveStage({ rec: rec({ evalStatus: "overridden" }) });
  assert.equal(out.stage, STAGES.READY_FOR_ROLLOUT);
});

test("accepted, no campaign/experiment/live rule -> accepted_awaiting_enable", () => {
  const out = deriveStage({ rec: rec({ status: "accepted" }), run: { status: "passed" } });
  assert.equal(out.stage, STAGES.ACCEPTED_AWAITING_ENABLE);
  assert.equal(out.nextAction.actionKey, "enable_rule");
});

test("active shadow campaign -> shadow_running, even while accepted", () => {
  const out = deriveStage({ rec: rec({ status: "accepted" }), campaign: { status: "active" } });
  assert.equal(out.stage, STAGES.SHADOW_RUNNING);
});

test("paused shadow campaign -> shadow_running", () => {
  const out = deriveStage({ rec: rec({ status: "accepted" }), campaign: { status: "paused" } });
  assert.equal(out.stage, STAGES.SHADOW_RUNNING);
});

test("done shadow campaign does not itself imply shadow_running (falls through)", () => {
  const out = deriveStage({ rec: rec({ status: "accepted" }), campaign: { status: "done" } });
  assert.equal(out.stage, STAGES.ACCEPTED_AWAITING_ENABLE);
});

test("active experiment -> canary_running with view_guardrails action", () => {
  const out = deriveStage({ rec: rec({ status: "accepted" }), experiment: { status: "active", rolloutPct: 15 } });
  assert.equal(out.stage, STAGES.CANARY_RUNNING);
  assert.equal(out.nextAction.actionKey, "view_guardrails");
});

test("paused experiment -> canary_running", () => {
  const out = deriveStage({ rec: rec({ status: "accepted" }), experiment: { status: "paused", rolloutPct: 15 } });
  assert.equal(out.stage, STAGES.CANARY_RUNNING);
});

test("rolled_back experiment -> rolled_back with review_rollback action", () => {
  const out = deriveStage({ rec: rec({ status: "accepted" }), experiment: { status: "rolled_back", rollbackReason: "error spike" } });
  assert.equal(out.stage, STAGES.ROLLED_BACK);
  assert.equal(out.nextAction.actionKey, "review_rollback");
});

test("promoted experiment with no enabled rule found falls through to accepted_awaiting_enable", () => {
  const out = deriveStage({ rec: rec({ status: "accepted" }), experiment: { status: "promoted" }, rules: [] });
  assert.equal(out.stage, STAGES.ACCEPTED_AWAITING_ENABLE);
});

// ── Precedence: reality on the wire beats any stale field ──────────────────────────────────

test("an enabled rule wins even when rec.status is stuck at pending (stale recompute race)", () => {
  const out = deriveStage({
    rec: rec({ status: "pending" }),
    rules: [{ enabled: true, updatedAt: new Date("2026-01-01") }],
  });
  assert.equal(out.stage, STAGES.PROMOTED_LIVE);
});

test("a rolled_back experiment wins over a stale evalStatus:passed still on the rec", () => {
  const out = deriveStage({
    rec: rec({ status: "accepted", evalStatus: "passed" }),
    run: { status: "passed" },
    experiment: { status: "rolled_back", rollbackReason: "cost regression" },
  });
  assert.equal(out.stage, STAGES.ROLLED_BACK);
});

test("an enabled rule wins over an active experiment (promote already happened, experiment field just hasn't caught up)", () => {
  const out = deriveStage({
    rec: rec({ status: "accepted" }),
    experiment: { status: "active", rolloutPct: 50 },
    rules: [{ enabled: true, updatedAt: new Date() }],
  });
  assert.equal(out.stage, STAGES.PROMOTED_LIVE);
});

test("two rules for the same rec (accept path + canary-promote path) — enabled one wins regardless of order", () => {
  const out = deriveStage({
    rec: rec({ status: "accepted" }),
    rules: [
      { enabled: false, updatedAt: new Date("2026-01-01") },
      { enabled: true, updatedAt: new Date("2026-02-01") },
    ],
  });
  assert.equal(out.stage, STAGES.PROMOTED_LIVE);
});
