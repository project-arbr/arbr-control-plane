"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { withinWindow, campaignMatches } = require("../../src/eval/logic");
const { canActivateShadow } = require("../../src/eval/thresholds");

test("withinWindow respects open and closed bounds", () => {
  const now = new Date("2026-07-05T12:00:00Z").getTime();
  assert.equal(withinWindow(now, null, null), true);
  assert.equal(withinWindow(now, "2026-07-01T00:00:00Z", "2026-07-10T00:00:00Z"), true);
  assert.equal(withinWindow(now, "2026-07-06T00:00:00Z", null), false); // before start
  assert.equal(withinWindow(now, null, "2026-07-04T00:00:00Z"), false); // after end
});

test("campaignMatches filters by taskType, workflow, and baseline model", () => {
  const c = { scope: { taskType: "classification", workflow: "triage" }, baselineModel: "gpt-4o" };
  assert.equal(campaignMatches(c, { taskType: "classification", workflow: "triage", baselineModel: "gpt-4o" }), true);
  assert.equal(campaignMatches(c, { taskType: "coding", workflow: "triage", baselineModel: "gpt-4o" }), false);
  assert.equal(campaignMatches(c, { taskType: "classification", workflow: "other", baselineModel: "gpt-4o" }), false);
  assert.equal(campaignMatches(c, { taskType: "classification", workflow: "triage", baselineModel: "claude-haiku-4-5" }), false);
});

test("campaignMatches treats null scope fields as 'any'", () => {
  const c = { scope: {}, baselineModel: null };
  assert.equal(campaignMatches(c, { taskType: "anything", workflow: "x", baselineModel: "y" }), true);
});

test("campaignMatches is case-insensitive on taskType", () => {
  const c = { scope: { taskType: "Classification" }, baselineModel: null };
  assert.equal(campaignMatches(c, { taskType: "classification" }), true);
});

test("canActivateShadow requires a passed offline run", () => {
  assert.equal(canActivateShadow({ status: "passed" }, null).allowed, true);
  assert.equal(canActivateShadow({ status: "failed" }, null).allowed, false);
  assert.equal(canActivateShadow(null, null).allowed, false);
});

test("canActivateShadow honors a valid override", () => {
  assert.equal(canActivateShadow(null, { reason: "pilot", approver: "prasanna" }).allowed, true);
  assert.equal(canActivateShadow({ status: "running" }, { reason: "x" }).allowed, false); // no approver
});
