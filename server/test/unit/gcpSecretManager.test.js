"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const gcpSecretManager = require("../../src/security/secretProviders/gcpSecretManager");

const RESOURCE = "projects/123/secrets/openai-key/versions/latest";
const URI = `gcp-sm://${RESOURCE}`;

test("matches() only accepts gcp-sm:// references", () => {
  assert.equal(gcpSecretManager.matches(URI), true);
  assert.equal(gcpSecretManager.matches("sk-a-literal-key"), false);
  assert.equal(gcpSecretManager.matches("aws-sm://arn:..."), false);
});

test("_resolveResource returns the secret payload as utf8, via an injected fake client", async () => {
  const fakeClient = {
    accessSecretVersion: async ({ name }) => {
      assert.equal(name, RESOURCE);
      return [{ payload: { data: Buffer.from("super-secret-value", "utf8") } }];
    },
  };
  const value = await gcpSecretManager._resolveResource(RESOURCE, fakeClient);
  assert.equal(value, "super-secret-value");
});

test("PERMISSION_DENIED maps to an actionable message naming the IAM role, never a value", async () => {
  const err = new Error("original grpc message with no secret in it");
  err.code = 7; // PERMISSION_DENIED
  const fakeClient = { accessSecretVersion: async () => { throw err; } };
  await assert.rejects(
    () => gcpSecretManager._resolveResource(RESOURCE, fakeClient),
    (thrown) => {
      assert.match(thrown.message, /secretAccessor/);
      assert.match(thrown.message, new RegExp(RESOURCE.replace(/\//g, "\\/")));
      return true;
    }
  );
});

test("NOT_FOUND maps to an actionable message", async () => {
  const err = new Error("not found");
  err.code = 5; // NOT_FOUND
  const fakeClient = { accessSecretVersion: async () => { throw err; } };
  await assert.rejects(
    () => gcpSecretManager._resolveResource(RESOURCE, fakeClient),
    /check the secret name and version/
  );
});

test("an unmapped error code falls back to the raw error message", async () => {
  const err = new Error("some other transient failure");
  err.code = 14; // UNAVAILABLE, not specially handled
  const fakeClient = { accessSecretVersion: async () => { throw err; } };
  await assert.rejects(
    () => gcpSecretManager._resolveResource(RESOURCE, fakeClient),
    /some other transient failure/
  );
});

test("no attempted secret value ever appears in a thrown error's message", async () => {
  // There is nothing to leak here (only the resource name is passed in), but
  // assert the invariant explicitly so a future refactor can't regress it.
  const err = new Error("boom");
  err.code = 7;
  const fakeClient = { accessSecretVersion: async () => { throw err; } };
  try {
    await gcpSecretManager._resolveResource(RESOURCE, fakeClient);
    assert.fail("expected a rejection");
  } catch (thrown) {
    assert.ok(!thrown.message.includes("payload"));
  }
});
