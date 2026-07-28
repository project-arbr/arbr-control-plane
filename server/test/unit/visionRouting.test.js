"use strict";
// Regression tests for vision requests routed to a non-vision model.
//
// Reported: images sent to accounti-onboarding were AI-routed to
// nvidia/nemotron-content-safety-reasoning-4b (a text-only safety model, absent
// from the LiteLLM catalog so supportsVision is null), which 502'd at the
// provider. Vision requests Arbr routes itself must now fail fast with a 400.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { hasVisionContent, isVisionCapable } = require("../../src/gateway/handler");

const imageMsg = {
  role: "user",
  content: [
    { type: "text", text: "What is in this document?" },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ],
};

test("hasVisionContent detects the OpenAI multimodal image shape", () => {
  assert.equal(hasVisionContent([imageMsg]), true);
});

test("hasVisionContent is false for plain string content", () => {
  assert.equal(hasVisionContent([{ role: "user", content: "hi" }]), false);
});

test("hasVisionContent is false for array content with no image part", () => {
  assert.equal(hasVisionContent([{ role: "user", content: [{ type: "text", text: "hi" }] }]), false);
});

test("hasVisionContent tolerates missing/empty messages", () => {
  assert.equal(hasVisionContent(undefined), false);
  assert.equal(hasVisionContent([]), false);
  assert.equal(hasVisionContent([{ role: "user" }]), false);
});

// The crux of the bug: the reported model is absent from the registry, so
// getModel returns null and isVisionCapable must report NOT capable — the guard
// then rejects rather than letting it 502 downstream. (Unit cache is empty, so
// every id is unknown here, which is precisely the "not affirmatively capable" case.)
test("isVisionCapable is false for a model unknown to the registry", () => {
  assert.equal(isVisionCapable("nvidia/nemotron-content-safety-reasoning-4b"), false);
  assert.equal(isVisionCapable("anything-not-synced"), false);
});
