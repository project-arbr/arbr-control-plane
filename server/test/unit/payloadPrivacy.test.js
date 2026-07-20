"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const Settings = require("../../src/models/Settings");
const { payloadFields } = require("../../src/logging/logger");
const { projectText } = require("../../src/eval/dataset");
const { shadowPayload } = require("../../src/eval/shadow");

test("production privacy defaults are metadata-only, masked, and 30 days", () => {
  assert.deepEqual(Settings.privacyDefaults(true), {
    retentionDays: 30,
    piiMaskingEnabled: true,
    captureRequestPayloads: false,
  });
  assert.deepEqual(Settings.privacyDefaults(false), {
    retentionDays: 90,
    piiMaskingEnabled: false,
    captureRequestPayloads: true,
  });
});

test("metadata-only logging strips payloads from every gateway record shape", () => {
  const flows = {
    native: { messages: [{ role: "user", content: "native secret" }], responseText: "native response" },
    openaiCompat: { messages: [{ role: "user", content: "compat secret" }], responseText: "compat response" },
    streaming: { messages: [{ role: "user", content: "stream secret" }], responseText: "assembled stream" },
    embeddings: { messages: [{ role: "user", content: "embedding secret" }], responseText: null },
  };

  for (const [name, record] of Object.entries(flows)) {
    assert.deepEqual(
      payloadFields(record, { captureRequestPayloads: false }),
      { messages: undefined, responseText: null },
      `${name} must not retain payload text`
    );
  }
});

test("metadata-only mode strips request-derived and shadow eval payloads", () => {
  const record = {
    messages: [{ role: "user", content: "partner prompt" }],
    responseText: "production response",
  };
  assert.deepEqual(
    projectText(record, "raw_allowed", false, [], false),
    { messages: null, productionResponse: null }
  );
  assert.deepEqual(
    shadowPayload(
      { messages: record.messages, prodText: record.responseText, candidateText: "candidate response" },
      { captureRequestPayloads: false }
    ),
    { messages: null, prodResponse: null, candidateResponse: null }
  );
});

test("opted-in payloads are masked before request and shadow-eval storage", () => {
  const record = {
    messages: [{ role: "user", content: "email partner@example.com" }],
    responseText: "call 415-555-1212",
  };
  const request = payloadFields(record, { captureRequestPayloads: true, piiMaskingEnabled: true });
  assert.ok(!JSON.stringify(request).includes("partner@example.com"));
  assert.ok(!JSON.stringify(request).includes("415-555-1212"));

  const shadow = shadowPayload(
    { messages: record.messages, prodText: record.responseText, candidateText: "email candidate@example.com" },
    { captureRequestPayloads: true, piiMaskingEnabled: true }
  );
  assert.ok(!JSON.stringify(shadow).includes("partner@example.com"));
  assert.ok(!JSON.stringify(shadow).includes("candidate@example.com"));
});
