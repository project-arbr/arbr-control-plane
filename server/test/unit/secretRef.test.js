"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseSecretRef } = require("../../src/security/secretRef");

test("parses a gcp-sm:// reference into scheme + resource", () => {
  const ref = parseSecretRef("gcp-sm://projects/123/secrets/openai-key/versions/latest");
  assert.deepEqual(ref, { scheme: "gcp-sm", resource: "projects/123/secrets/openai-key/versions/latest" });
});

test("a plain literal API key is never misidentified as a ref", () => {
  assert.equal(parseSecretRef("sk-abc123def456"), null);
  assert.equal(parseSecretRef(""), null);
  assert.equal(parseSecretRef(undefined), null);
  assert.equal(parseSecretRef(null), null);
});

test("'gcp-sm://' with no resource after the prefix is not a valid ref", () => {
  assert.equal(parseSecretRef("gcp-sm://"), null);
});

test("parseSecretRef recognizes ANY scheme://resource shape, not a hardcoded allowlist", () => {
  // Deliberate: which schemes are actually usable is the registry's job
  // (secretResolver.js's PROVIDERS_REGISTRY), not this file's — otherwise
  // adding a cloud adapter would require editing two places instead of one.
  // No credential this codebase reads (API keys, ARBR_ADMIN_KEY, etc.) is
  // ever shaped like a URL, so this can't misidentify a real literal.
  assert.deepEqual(parseSecretRef("aws-sm://arn:aws:secretsmanager:..."), {
    scheme: "aws-sm", resource: "arn:aws:secretsmanager:...",
  });
  assert.deepEqual(parseSecretRef("azure-kv://myvault/mysecret"), {
    scheme: "azure-kv", resource: "myvault/mysecret",
  });
});
