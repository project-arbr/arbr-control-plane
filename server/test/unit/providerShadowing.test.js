"use strict";
// Regression tests for a custom provider that shadows a built-in provider id.
//
// Reported symptom: `mistral` was usable as a user-added custom provider (the catalog page
// pre-fills it) before it became a built-in. Once both existed under the same id,
// connections.effective() resolved the CUSTOM row's API key — it merges custom providers
// last, overwriting the built-in entry — while the gateway read the BUILT-IN's baseURL.
// The key and the endpoint came from different records, so an operator pointing `mistral`
// at an on-prem deployment had their key and prompts sent to api.mistral.ai instead.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveBaseURL } = require("../../src/providers/connections");
const { toRouterConfig } = require("../../src/providers/router");
const { openAICompatBaseURL } = require("../../src/gateway/openaiCompat");

const ON_PREM = "http://mistral.internal:8000/v1";

// A custom-provider entry as connections.compute() shapes it (baseURL set, no default model).
const customEntry = (baseURL, apiKey = "sk-custom") => ({
  credential: { apiKey }, defaultModel: null, authType: "apiKey", source: "stored", baseURL,
});
// A built-in entry as connections.compute() shapes it (no baseURL field at all).
const builtInEntry = (defaultModel, apiKey = "sk-builtin") => ({
  credential: { apiKey }, defaultModel, authType: "apiKey", source: "env",
});

test("a custom provider shadowing a built-in id keeps its own baseURL", () => {
  assert.equal(resolveBaseURL("mistral", customEntry(ON_PREM)), ON_PREM);
});

test("an unshadowed built-in still resolves to its static baseURL", () => {
  assert.equal(
    resolveBaseURL("mistral", builtInEntry("mistral-small-latest")),
    "https://api.mistral.ai/v1"
  );
});

test("a native provider has no compat baseURL", () => {
  assert.equal(resolveBaseURL("anthropic", builtInEntry("claude-haiku-4-5")), null);
  assert.equal(resolveBaseURL("gemini", builtInEntry("gemini-2.5-flash")), null);
});

test("a trailing slash is stripped so ${baseURL}/chat/completions stays well-formed", () => {
  assert.equal(resolveBaseURL("mistral", customEntry("http://host:8000/v1/")), "http://host:8000/v1");
});

test("a genuine custom provider (no built-in of that id) is unaffected", () => {
  assert.equal(resolveBaseURL("my-llm", customEntry("https://llm.example.com/v1")), "https://llm.example.com/v1");
  assert.equal(resolveBaseURL("my-llm", { credential: { apiKey: "k" } }), null);
});

test("the gateway dispatches a shadowed compat provider to the custom endpoint", () => {
  const eff = { providers: { mistral: customEntry(ON_PREM) } };
  assert.equal(openAICompatBaseURL("mistral", eff), ON_PREM);
});

test("the gateway still dispatches an unshadowed built-in to the vendor API", () => {
  const eff = { providers: { mistral: builtInEntry("mistral-small-latest") } };
  assert.equal(openAICompatBaseURL("mistral", eff), "https://api.mistral.ai/v1");
});

test("openai keeps its api.openai.com default when nothing overrides it", () => {
  const eff = { providers: { openai: builtInEntry("gpt-4o-mini") } };
  assert.equal(openAICompatBaseURL("openai", eff), "https://api.openai.com/v1");
});

test("the router pairs the key and the endpoint from the SAME record", () => {
  // The actual defect: apiKey came from the custom row, baseURL from the built-in.
  const cfg = toRouterConfig("mistral", customEntry(ON_PREM, "sk-onprem"));
  assert.equal(cfg.apiKey, "sk-onprem");
  assert.equal(cfg.baseURL, ON_PREM, "custom key must not be sent to the built-in's host");
});
