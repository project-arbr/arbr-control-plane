"use strict";
// The classifier's spend must be accounted by the classifier itself, not by whichever
// gateway happened to call it.
//
// Regression: resolveRoute is shared by /v1/chat and /v1/chat/completions, but only the
// native handler destructured `cls` and logged the classification call. The
// OpenAI-compatible gateway — LibreChat, OpenCode, any OpenAI SDK client — made the same
// billable call and logged nothing. Accounting now lives inside classifyTask, so neither
// gateway can forget.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const logger = require("../../src/logging/logger");
const { classifyTask } = require("../../src/classify/classifier");
const { _flushForTests } = require("../../src/internal/complete");

const realWrite = logger.write;
let written;
beforeEach(() => { written = []; logger.write = async (r) => { written.push(r); }; });
afterEach(() => { logger.write = realWrite; });

// The classifier caches by prompt hash, so vary the text per test to force a real call.
let n = 0;
const uniqueMessages = () => [{ role: "user", content: `please summarise this unique document ${n++}` }];

function fakeRouter() {
  return {
    async complete() {
      return {
        text: '{"taskType":"summarisation","difficulty":3,"confidence":0.9}',
        providerId: "openai", modelId: "gpt-4o-mini", latencyMs: 12,
        usage: { inputTokens: 80, outputTokens: 12, totalTokens: 92 },
      };
    },
  };
}
const eff = { defaultProvider: "openai", defaultModel: "gpt-4o-mini", liveIds: ["openai"] };

test("classifying records the call's own spend", async () => {
  const cls = await classifyTask({
    messages: uniqueMessages(), router: fakeRouter(), eff, useLLM: true, application: "checkout",
  });
  await _flushForTests();

  assert.equal(cls.method, "ai", "the LLM classifier should have run");
  assert.equal(written.length, 1, "the classification call must be accounted exactly once");
  assert.equal(written[0].internalKind, "classifier");
  assert.equal(written[0].promptTokens, 80);
  assert.equal(written[0].application, null, "never attributed to the triggering app");
  assert.deepEqual(written[0].internalContext, { application: "checkout" },
    "but the triggering app is kept as provenance");
});

test("a provided taskType makes no billable call", async () => {
  await classifyTask({ taskType: "coding", messages: uniqueMessages(), router: fakeRouter(), eff, useLLM: true });
  await _flushForTests();
  assert.equal(written.length, 0, "trusting the caller's taskType must cost nothing");
});

test("keyword-only mode makes no billable call", async () => {
  await classifyTask({ messages: uniqueMessages(), router: fakeRouter(), eff, useLLM: false });
  await _flushForTests();
  assert.equal(written.length, 0);
});

// Structural guard: the old sentinel-writing block must not come back in either gateway.
// Both paths share resolveRoute, so a call-site log in one of them is a bug by construction.
test("neither gateway writes classifier records itself", () => {
  const gateway = path.resolve(__dirname, "../../src/gateway");
  for (const file of ["handler.js", "openaiCompat.js"]) {
    const src = fs.readFileSync(path.join(gateway, file), "utf8");
    assert.ok(
      !src.includes("arbr-internal"),
      `${file} still references the legacy arbr-internal sentinel`
    );
    assert.ok(
      !src.includes("auto-classifier"),
      `${file} appears to log classifier spend itself; it belongs in classify/classifier.js`
    );
  }
});
