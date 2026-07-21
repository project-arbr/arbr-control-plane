"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const attrs = require("../../src/telemetry/attributes");

const base = {
  requestId: "req-1", timestamp: new Date("2026-01-01T00:00:00Z"),
  application: "checkout", workflow: "wf", userId: "u1", department: "eng",
  provider: "openai", model: "gpt-4o-mini", modelRequested: "auto",
  taskType: "summarisation", promptTokens: 100, completionTokens: 20,
  totalCost: 0.0012, inputCost: 0.001, outputCost: 0.0002, knownPricing: true,
  latencyMs: 240, status: "success", routingDecision: "ai", classifiedBy: "ai",
};

test("span name uses the served model, not the requested 'auto'", () => {
  assert.equal(attrs.spanName(base), "chat gpt-4o-mini");
  assert.equal(attrs.spanName({ ...base, taskType: "embedding", model: "text-embedding-3-small" }),
    "embeddings text-embedding-3-small");
});

test("maps gen_ai.* and arbr.* attributes", () => {
  const a = attrs.attributesFor(base);
  assert.equal(a["gen_ai.operation.name"], "chat");
  assert.equal(a["gen_ai.request.model"], "auto");
  assert.equal(a["gen_ai.response.model"], "gpt-4o-mini");
  assert.equal(a["gen_ai.usage.input_tokens"], 100);
  assert.equal(a["gen_ai.usage.output_tokens"], 20);
  assert.equal(a["gen_ai.usage.cost"], 0.0012);
  assert.equal(a["gen_ai.system"], "openai");
  assert.equal(a["gen_ai.provider.name"], "openai");
  assert.equal(a["user.id"], "u1");
  assert.equal(a["arbr.application"], "checkout");
  assert.equal(a["arbr.routing.decision"], "ai");
  assert.equal(a["arbr.cost.total_usd"], 0.0012);
  assert.equal(a["arbr.status"], "success");
});

test("maps provider ids to semconv values", () => {
  assert.equal(attrs.providerName("bedrock-nova"), "aws.bedrock");
  assert.equal(attrs.providerName("gemini"), "gcp.gemini");
  assert.equal(attrs.providerName("some-custom-provider"), "some-custom-provider"); // passthrough
  assert.equal(attrs.providerName(undefined), undefined);
});

test("omits null/undefined/empty attributes rather than emitting 'null'", () => {
  const a = attrs.attributesFor({ requestId: "r", model: "m", status: "success", application: null, userId: undefined, workflow: "" });
  assert.ok(!("arbr.application" in a));
  assert.ok(!("user.id" in a));
  assert.ok(!("arbr.workflow" in a));
});

test("captures content only when enabled, and clamps it", () => {
  const rec = { ...base, messages: [{ role: "user", content: "x".repeat(5000) }], responseText: "y".repeat(5000) };
  assert.ok(!("gen_ai.input.messages" in attrs.attributesFor(rec)), "off by default");
  const a = attrs.attributesFor(rec, { captureContent: true, contentMaxChars: 100 });
  assert.equal(a["gen_ai.input.messages"].length, 100);
  assert.equal(a["gen_ai.output.messages"].length, 100);
});

test("status: success is UNSET, failure and blocked are ERROR", () => {
  assert.equal(attrs.spanStatus(base).code, "UNSET");
  assert.equal(attrs.spanStatus({ ...base, status: "failure", errorMessage: "boom" }).code, "ERROR");
  assert.equal(attrs.spanStatus({ ...base, status: "blocked" }).code, "ERROR");
});

test("errorType normalises blocked and failed", () => {
  assert.equal(attrs.errorType({ status: "blocked", errorMessage: "budget cap exceeded" }), "budget_exceeded");
  assert.equal(attrs.errorType({ status: "blocked", errorMessage: "guardrail_violation" }), "guardrail_violation");
  assert.equal(attrs.errorType({ status: "failure", errorMessage: "upstream 502" }), "provider_error");
  assert.equal(attrs.errorType({ status: "success" }), undefined);
});

test("timing floors zero-latency records to 1ms and falls back when no timestamp", () => {
  const t1 = attrs.timing({ timestamp: new Date("2026-01-01T00:00:00Z"), latencyMs: 0 });
  assert.equal(t1.endMs - t1.startMs, 1, "zero latency renders as 1ms");
  const now = 1_000_000;
  const t2 = attrs.timing({ latencyMs: 50 }, now); // no timestamp (embeddings/realtime shape)
  assert.equal(t2.startMs, now - 50);
  assert.equal(t2.endMs, now);
});

test("sampling: honors a sampled parent, never drops failures, respects ratio", () => {
  const success = { status: "success" };
  const failure = { status: "failure" };
  const sampledParent = { sampled: true };
  assert.equal(attrs.shouldSample(success, sampledParent, 0), true, "sampled parent wins over ratio 0");
  assert.equal(attrs.shouldSample(failure, null, 0), true, "failures never dropped");
  assert.equal(attrs.shouldSample(success, null, 1), true);
  assert.equal(attrs.shouldSample(success, null, 0), false);
  assert.equal(attrs.shouldSample(success, null, 0.5, () => 0.4), true);  // rng below ratio
  assert.equal(attrs.shouldSample(success, null, 0.5, () => 0.9), false); // rng above ratio
});
