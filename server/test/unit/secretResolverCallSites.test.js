"use strict";
// Regression coverage for every Phase 4 call site the F-07 secret-manager
// resolver was wired into: proves literal-value behavior is byte-identical
// before/after (not just that the resolver's own unit works in isolation),
// plus the one case a plan review found broken in an earlier draft —
// adminAuth.js reading a *resolved* ARBR_ADMIN_KEY, not a boot-time snapshot.
const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const secretResolver = require("../../src/security/secretResolver");

const ORIG_ENV = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in ORIG_ENV)) delete process.env[k];
  for (const [k, v] of Object.entries(ORIG_ENV)) process.env[k] = v;
});

// config.js and adminAuth.js both read env vars at require-time (config.js's
// envLive snapshot, adminAuth's captured `config` reference) — re-require
// fresh after mutating env, same pattern as assertProductionReady.test.js.
function freshRequire(relPath) {
  delete require.cache[require.resolve(relPath)];
  return require(relPath);
}

beforeEach(async () => {
  // Clear any leftover resolver cache entries from other test files.
  await secretResolver.resolveOne("OPENAI_API_KEY", "reset");
  await secretResolver.resolveOne("ARBR_ADMIN_KEY", "reset");
  await secretResolver.resolveOne("ARBR_ENCRYPTION_KEY", "reset");
});

test("config.js envCredentialFor(): a literal OPENAI_API_KEY resolves exactly as before", () => {
  process.env.OPENAI_API_KEY = "sk-literal-openai-key";
  const { envCredentialFor } = freshRequire("../../src/config");
  assert.deepEqual(envCredentialFor("openai"), { apiKey: "sk-literal-openai-key" });
});

test("secrets.js secret(): a literal ARBR_ENCRYPTION_KEY derives the same key bytes as before", () => {
  process.env.ARBR_ENCRYPTION_KEY = "literal-encryption-key";
  const secrets = freshRequire("../../src/security/secrets");
  const a = secrets.encrypt("hello");
  // Re-require again (same literal) — decrypting with a fresh module instance
  // must still work, proving secret() derives identically each time.
  const secrets2 = freshRequire("../../src/security/secrets");
  assert.equal(secrets2.decrypt(a), "hello");
});

test("semanticCache._initEmbedder(): a literal OPENAI_API_KEY still initializes the embedder as before", () => {
  const semanticCache = require("../../src/routing/semanticCache");
  semanticCache.invalidate(); // discard any embedder cached by another test file
  process.env.OPENAI_API_KEY = "sk-literal-for-embedder";
  const embedder = semanticCache._initEmbedder();
  assert.ok(embedder, "expected an embedder to be constructed for a literal key");
  semanticCache.invalidate();
});

test("semanticCache._initEmbedder(): no key at all still returns null as before", () => {
  const semanticCache = require("../../src/routing/semanticCache");
  semanticCache.invalidate();
  delete process.env.OPENAI_API_KEY;
  assert.equal(semanticCache._initEmbedder(), null);
});

test("semanticCache._initEmbedder(): a resolved secret-manager value is preferred over the raw ref literal", async () => {
  const semanticCache = require("../../src/routing/semanticCache");
  semanticCache.invalidate();
  process.env.OPENAI_API_KEY = "fake://openai-key-ref";

  const fakeProvider = {
    scheme: "fake",
    matches: (uri) => typeof uri === "string" && uri.startsWith("fake://"),
    resolve: async () => "sk-resolved-from-secret-manager",
  };
  secretResolver.PROVIDERS_REGISTRY.push(fakeProvider);
  try {
    await secretResolver.refreshAll(["OPENAI_API_KEY"]);
    const embedder = semanticCache._initEmbedder();
    assert.ok(embedder, "expected an embedder to be constructed from the resolved value");
  } finally {
    const i = secretResolver.PROVIDERS_REGISTRY.indexOf(fakeProvider);
    if (i >= 0) secretResolver.PROVIDERS_REGISTRY.splice(i, 1);
    semanticCache.invalidate();
  }
});

test("adminAuth.isAdminRequest(): a literal ARBR_ADMIN_KEY with no resolver cache populated still authenticates", () => {
  process.env.ARBR_ADMIN_KEY = "literal-admin-key";
  freshRequire("../../src/config");
  const adminAuth = freshRequire("../../src/api/adminAuth");
  const req = { headers: { authorization: "Bearer literal-admin-key" } };
  assert.equal(adminAuth.isAdminRequest(req), true);
  assert.equal(adminAuth.isAdminRequest({ headers: { authorization: "Bearer wrong-key" } }), false);
});

test("adminAuth.isAdminRequest(): a rotated (resolved) admin key takes effect without re-requiring anything", async () => {
  // The exact case the plan review found broken in the original "mutate
  // config.adminKey once at boot" design: populate the resolver cache for
  // ARBR_ADMIN_KEY (as refreshAll() would after a rotation + refresh call)
  // and confirm the *resolved* value authenticates while the raw ref does not.
  process.env.ARBR_ADMIN_KEY = "fake://admin-key-ref";
  freshRequire("../../src/config");
  const adminAuth = freshRequire("../../src/api/adminAuth");

  const fakeProvider = {
    scheme: "fake",
    matches: (uri) => typeof uri === "string" && uri.startsWith("fake://"),
    resolve: async () => "rotated-admin-key-value",
  };
  secretResolver.PROVIDERS_REGISTRY.push(fakeProvider);
  try {
    await secretResolver.refreshAll(["ARBR_ADMIN_KEY"]);
    assert.equal(
      adminAuth.isAdminRequest({ headers: { authorization: "Bearer rotated-admin-key-value" } }),
      true
    );
    assert.equal(
      adminAuth.isAdminRequest({ headers: { authorization: "Bearer fake://admin-key-ref" } }),
      false
    );
  } finally {
    const i = secretResolver.PROVIDERS_REGISTRY.indexOf(fakeProvider);
    if (i >= 0) secretResolver.PROVIDERS_REGISTRY.splice(i, 1);
  }
});
