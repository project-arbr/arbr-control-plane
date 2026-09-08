"use strict";
// Unit tests for multi-key credential resolution.
//
// The property that matters most here is what happens to a pin that no longer resolves.
// Rules and application configs reference a key by NAME, and a name can be deleted at any
// time from a different screen. If that dead-ended the request, deleting a key would take
// down every rule that mentioned it. Instead it falls back to the provider's default key
// and says so, which is what `fellBack` is for.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { credentialFor, normalizeAlias } = require("../../src/providers/connections");

// An effective() snapshot as compute() shapes it.
const eff = {
  providers: {
    openai: {
      credential: { apiKey: "sk-env" }, // == credentials.env, the default
      defaultModel: "gpt-4o-mini",
      authType: "apiKey",
      source: "env",
      defaultAlias: "env",
      credentials: {
        "prod-eu": { credential: { apiKey: "sk-prod" }, source: "stored", last4: "prod" },
        batch: { credential: { apiKey: "sk-batch" }, source: "stored", last4: "atch" },
        env: { credential: { apiKey: "sk-env" }, source: "env", last4: "-env" },
      },
    },
    anthropic: {
      credential: { apiKey: "sk-ant-a" },
      defaultModel: "claude", authType: "apiKey", source: "stored",
      defaultAlias: "a",
      credentials: { a: { credential: { apiKey: "sk-ant-a" }, source: "stored" } },
    },
  },
};

test("an exact alias resolves to that key", () => {
  const r = credentialFor(eff, "openai", "prod-eu");
  assert.equal(r.credential.apiKey, "sk-prod");
  assert.equal(r.alias, "prod-eu");
  assert.equal(r.fellBack, false);
});

test("no alias resolves to the provider's default key", () => {
  const r = credentialFor(eff, "openai", null);
  assert.equal(r.credential.apiKey, "sk-env");
  assert.equal(r.alias, "env");
  // Not a fallback — nothing was asked for, so nothing was missed.
  assert.equal(r.fellBack, false);
});

test("an unknown alias falls back to the default key and flags it", () => {
  const r = credentialFor(eff, "openai", "deleted-last-week");
  assert.equal(r.credential.apiKey, "sk-env");
  assert.equal(r.alias, "env");
  assert.equal(r.fellBack, true, "a dangling pin must be reported, not silently honored");
});

test("an alias from a DIFFERENT provider does not leak across providers", () => {
  // "prod-eu" exists on openai but not anthropic. Resolving it against anthropic must
  // yield anthropic's own key, never openai's.
  const r = credentialFor(eff, "anthropic", "prod-eu");
  assert.equal(r.credential.apiKey, "sk-ant-a");
  assert.equal(r.fellBack, true);
});

test("a provider that is not live resolves to null", () => {
  assert.equal(credentialFor(eff, "gemini", "anything"), null);
  assert.equal(credentialFor(eff, "gemini", null), null);
});

test("a missing or malformed snapshot does not throw", () => {
  assert.equal(credentialFor(null, "openai", "x"), null);
  assert.equal(credentialFor({}, "openai", "x"), null);
  assert.equal(credentialFor({ providers: {} }, "openai", null), null);
});

// ── normalizeAlias ───────────────────────────────────────────────────────────

test("aliases are lowercased", () => {
  // MongoDB's unique index compares bytes, so without this "Prod-EU" and "prod-eu" would
  // both persist as separate keys that look identical everywhere they are displayed.
  assert.equal(normalizeAlias("Prod-EU"), "prod-eu");
  assert.equal(normalizeAlias("  Staging  "), "staging");
});

test("valid alias shapes are accepted", () => {
  for (const a of ["default", "prod-eu", "team_1", "v1.2", "a", "0abc"]) {
    assert.equal(normalizeAlias(a), a);
  }
});

test("env is reserved", () => {
  assert.throws(() => normalizeAlias("env"), /reserved/);
  assert.throws(() => normalizeAlias("ENV"), /reserved/);
});

test("invalid aliases are rejected", () => {
  assert.throws(() => normalizeAlias(""), /required/);
  assert.throws(() => normalizeAlias(null), /required/);
  assert.throws(() => normalizeAlias("-leading-dash"), /must start with/);
  assert.throws(() => normalizeAlias("has space"), /must start with/);
  assert.throws(() => normalizeAlias("has/slash"), /must start with/);
  assert.throws(() => normalizeAlias("$ne"), /must start with/);
  assert.throws(() => normalizeAlias("a".repeat(41)), /must start with/);
});
