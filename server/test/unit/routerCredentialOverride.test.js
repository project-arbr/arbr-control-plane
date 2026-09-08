"use strict";
// Regression tests for pinning a specific provider key at dispatch time.
//
// The failure this guards against: `complete()` walks a fallback chain that can cross
// providers, so a credentialOverride applied to every candidate would post an OpenAI key
// to Anthropic. The override must reach the provider it was pinned for and no other.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createRouter } = require("../../src/providers/llm-router");
const { credentialOverrideFor, toRouterConfig } = require("../../src/providers/router");

// ── credentialOverrideFor ────────────────────────────────────────────────────

const eff = {
  providers: {
    openai: {
      credential: { apiKey: "sk-default" },
      defaultModel: "gpt-4o-mini", authType: "apiKey", source: "stored",
      defaultAlias: "default",
      credentials: {
        default: { credential: { apiKey: "sk-default" }, source: "stored" },
        batch: { credential: { apiKey: "sk-batch" }, source: "stored" },
      },
    },
    "bedrock-nova": {
      credential: { accessKeyId: "AKIA-DEF", secretAccessKey: "sec-def", region: "us-east-1" },
      defaultModel: "us.amazon.nova-lite-v1:0", authType: "aws", source: "stored",
      defaultAlias: "default",
      credentials: {
        default: { credential: { accessKeyId: "AKIA-DEF", secretAccessKey: "sec-def", region: "us-east-1" }, source: "stored" },
        eu: { credential: { accessKeyId: "AKIA-EU", secretAccessKey: "sec-eu", region: "eu-west-1" }, source: "stored" },
      },
    },
  },
};

test("no alias produces no override, so unpinned traffic is untouched", () => {
  assert.equal(credentialOverrideFor(eff, "openai", null), null);
});

test("pinning the alias that IS the default produces no override", () => {
  // Passing an override identical to what the router already holds would be harmless but
  // pointless; returning null keeps the unpinned code path bit-identical.
  assert.equal(credentialOverrideFor(eff, "openai", "default"), null);
});

test("a pinned apiKey alias overrides only the key", () => {
  const o = credentialOverrideFor(eff, "openai", "batch");
  assert.deepEqual(o, { apiKey: "sk-batch" });
  // model and baseURL must NOT be in the override — they come from the router's own config,
  // and overriding the model here would silently defeat modelOverride.
  assert.equal("model" in o, false);
  assert.equal("baseURL" in o, false);
});

test("a pinned aws alias overrides region AND credentials together", () => {
  // Half-applying this would pair one account's keys with another's region.
  const o = credentialOverrideFor(eff, "bedrock-nova", "eu");
  assert.deepEqual(o, {
    region: "eu-west-1",
    credentials: { accessKeyId: "AKIA-EU", secretAccessKey: "sec-eu" },
  });
});

test("an unknown alias produces no override (falls back to the default key)", () => {
  assert.equal(credentialOverrideFor(eff, "openai", "no-such-key"), null);
});

test("an offline provider produces no override", () => {
  assert.equal(credentialOverrideFor(eff, "gemini", "batch"), null);
});

// ── complete(): which key actually goes on the wire ──────────────────────────
//
// Asserting the Authorization header of each upstream attempt is the only way to prove
// this. A local server that 400s makes both providers fail, so complete() walks its whole
// order and we see every key it tried — and rejects fast, with no real network.

const http = require("node:http");

async function withRecordingUpstream(fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization || "");
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "nope", type: "invalid_request_error" } }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    // Two OpenAI-wire providers so both take the same ChatOpenAI path and honour baseURL.
    const router = createRouter({
      providers: {
        openai: { apiKey: "sk-openai-default", model: "m1", baseURL: base },
        deepseek: { apiKey: "sk-deepseek", model: "m2", baseURL: base },
      },
      defaultProvider: "openai",
      fallbackChain: ["deepseek"],
    });
    await fn(router, seen);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("a pinned key IS sent for the provider it was pinned for", async () => {
  await withRecordingUpstream(async (router, seen) => {
    await assert.rejects(() => router.complete({
      messages: [{ role: "user", content: "hi" }],
      providerOverride: "openai",
      credentialOverride: { apiKey: "sk-PINNED" },
    }));
    assert.ok(seen.length > 0, "the upstream should have been called");
    assert.ok(seen.every((h) => h === "Bearer sk-PINNED"),
      `expected only the pinned key on the wire, saw ${JSON.stringify(seen)}`);
  });
});

test("a pinned key is NOT sent to any provider it was not pinned for", async () => {
  await withRecordingUpstream(async (router, seen) => {
    // No providerOverride: complete() walks [default, ...fallbackChain]. The guard
    // (providerId === args.providerOverride) must keep the override off every one of them
    // — otherwise a fallback to a different provider ships the wrong vendor's key.
    await assert.rejects(() => router.complete({
      messages: [{ role: "user", content: "hi" }],
      credentialOverride: { apiKey: "sk-PINNED" },
    }));
    assert.ok(seen.length >= 2, `expected the fallback chain to be walked, saw ${seen.length} call(s)`);
    assert.ok(!seen.includes("Bearer sk-PINNED"),
      `the pinned key leaked to an unpinned provider: ${JSON.stringify(seen)}`);
    assert.ok(seen.includes("Bearer sk-openai-default"));
    assert.ok(seen.includes("Bearer sk-deepseek"));
  });
});

test("an aws override never carries an apiKey field", () => {
  // Half-shaped overrides are how an AWS credential ends up sent as a bearer token.
  const openaiOverride = credentialOverrideFor(eff, "openai", "batch");
  const bedrockOverride = credentialOverrideFor(eff, "bedrock-nova", "eu");
  assert.ok("apiKey" in openaiOverride);
  assert.ok(!("apiKey" in bedrockOverride));
  assert.ok("credentials" in bedrockOverride);
});

test("toRouterConfig still reads entry.credential (the default key)", () => {
  // providerShadowing.test.js depends on this. If toRouterConfig ever starts reading
  // `credentials` instead, a custom provider shadowing a built-in id can pair one record's
  // key with another's baseURL again.
  const cfg = toRouterConfig("openai", eff.providers.openai);
  assert.equal(cfg.apiKey, "sk-default");
  assert.equal(cfg.model, "gpt-4o-mini");
});
