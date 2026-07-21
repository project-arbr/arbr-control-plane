"use strict";
// The wrapper every internal Arbr LLM call goes through. These tests use a hand-written
// fake router (no mocking library, per the project's testing rules) and stub logger.write
// so they assert on the exact record that would be persisted, without a DB.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const logger = require("../../src/logging/logger");
const RequestRecord = require("../../src/models/RequestRecord");
const { internalComplete, _flushForTests } = require("../../src/internal/complete");

const realWrite = logger.write;
let written;

beforeEach(() => {
  written = [];
  logger.write = async (rec) => { written.push(rec); };
});
afterEach(() => { logger.write = realWrite; });

function fakeRouter(over = {}) {
  return {
    calls: [],
    async complete(args) {
      this.calls.push(args);
      return {
        text: "ok",
        providerId: "openai",
        modelId: "gpt-4o-mini",
        latencyMs: 42,
        usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 },
        ...over,
      };
    },
  };
}

test("records a priced internal call with no customer dimensions", async () => {
  const router = fakeRouter();
  const res = await internalComplete({
    kind: "classifier", router,
    messages: [{ role: "user", content: "hi" }],
    provider: "openai", model: "gpt-4o-mini", temperature: 0, maxTokens: 256,
  });
  await _flushForTests();

  assert.equal(res.text, "ok");
  assert.equal(typeof res.costUsd, "number", "callers need costUsd to keep their own ledgers in step");

  assert.equal(written.length, 1);
  const rec = written[0];
  assert.equal(rec.internalKind, "classifier");
  assert.equal(rec.status, "success");
  assert.equal(rec.provider, "openai");
  assert.equal(rec.promptTokens, 100);
  assert.equal(rec.completionTokens, 20);
  assert.equal(rec.latencyMs, 42);

  // Defence in depth: a query that forgets to exclude internal records must yield an
  // unattributed bucket, never a fake application.
  for (const f of ["application", "workflow", "department", "userId", "taskType"]) {
    assert.equal(rec[f], null, `${f} must be null on an internal record`);
  }
});

test("never captures prompt or response text", async () => {
  await internalComplete({
    kind: "policy-generation", router: fakeRouter(),
    messages: [{ role: "user", content: "a secret internal prompt" }],
  });
  await _flushForTests();

  const rec = written[0];
  assert.equal(rec.messages, undefined, "Arbr's own prompts are not customer data");
  assert.equal(rec.responseText, undefined);
  // This is also what makes internal records fail eval-dataset eligibility, which
  // requires both fields — a second barrier if a query filter is ever missed.
});

test("passes overrides through to the router", async () => {
  const router = fakeRouter();
  await internalComplete({
    kind: "eval-judge", router,
    messages: [{ role: "user", content: "x" }],
    provider: "anthropic", model: "claude-haiku-4-5", temperature: 0.2, maxTokens: 999,
  });
  assert.deepEqual(router.calls[0], {
    messages: [{ role: "user", content: "x" }],
    providerOverride: "anthropic",
    modelOverride: "claude-haiku-4-5",
    temperature: 0.2,
    maxTokens: 999,
  });
});

test("records a failure and rethrows so callers keep their own handling", async () => {
  const router = { complete: async () => { throw new Error("provider exploded"); } };
  await assert.rejects(
    () => internalComplete({ kind: "connection-test", router, messages: [{ role: "user", content: "x" }] }),
    /provider exploded/
  );
  await _flushForTests();

  assert.equal(written.length, 1, "a failed internal call must still be visible");
  assert.equal(written[0].status, "failure");
  assert.equal(written[0].internalKind, "connection-test");
  assert.match(written[0].errorMessage, /provider exploded/);
});

test("a logging failure never reaches the caller", async () => {
  logger.write = async () => { throw new Error("mongo is down"); };
  const res = await internalComplete({
    kind: "model-test", router: fakeRouter(), messages: [{ role: "user", content: "x" }],
  });
  await _flushForTests();
  assert.equal(res.text, "ok", "accounting must never break the thing it is accounting for");
});

test("stores provenance on internalContext, not as a dimension", async () => {
  await internalComplete({
    kind: "shadow-candidate", router: fakeRouter(),
    messages: [{ role: "user", content: "x" }],
    context: { campaignId: "c1", application: "checkout" },
  });
  await _flushForTests();

  assert.deepEqual(written[0].internalContext, { campaignId: "c1", application: "checkout" });
  assert.equal(written[0].application, null, "provenance must not leak into the dimension");
});

test("rejects an unknown kind rather than writing an unclassifiable record", async () => {
  await assert.rejects(
    () => internalComplete({ kind: "not-a-kind", router: fakeRouter(), messages: [] }),
    /unknown kind/
  );
  assert.equal(written.length, 0);
});

test("every kind in the schema enum is accepted", async () => {
  for (const kind of RequestRecord.INTERNAL_KINDS) {
    await internalComplete({ kind, router: fakeRouter(), messages: [{ role: "user", content: "x" }] });
  }
  await _flushForTests();
  assert.deepEqual(written.map((r) => r.internalKind), RequestRecord.INTERNAL_KINDS);
});
