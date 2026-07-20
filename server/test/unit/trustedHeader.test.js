"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { config } = require("../../src/config");
const trustedHeader = require("../../src/api/authProviders/trustedHeader");

function withProxyConfig(overrides, fn) {
  const original = { ...config.trustedHeader };
  Object.assign(config.trustedHeader, { strategy: "proxy" }, overrides);
  try { return fn(); } finally { Object.assign(config.trustedHeader, original); }
}

test("proxy strategy rejects when no shared secret is configured", async () => {
  const identity = await withProxyConfig({ proxySecret: null }, () =>
    trustedHeader.verify({ headers: { "x-arbr-proxy-secret": "anything", "x-forwarded-email": "a@test" } })
  );
  assert.equal(identity, null);
});

test("proxy strategy rejects a wrong secret", async () => {
  const identity = await withProxyConfig({ proxySecret: "correct" }, () =>
    trustedHeader.verify({ headers: { "x-arbr-proxy-secret": "wrong", "x-forwarded-email": "a@test" } })
  );
  assert.equal(identity, null);
});

test("proxy strategy rejects a missing email header even with the right secret", async () => {
  const identity = await withProxyConfig({ proxySecret: "correct" }, () =>
    trustedHeader.verify({ headers: { "x-arbr-proxy-secret": "correct" } })
  );
  assert.equal(identity, null);
});

test("proxy strategy accepts a correct secret + forwarded email", async () => {
  const identity = await withProxyConfig({ proxySecret: "correct" }, () =>
    trustedHeader.verify({ headers: { "x-arbr-proxy-secret": "correct", "x-forwarded-email": "Alice@Test.com" } })
  );
  assert.deepEqual(identity, { email: "Alice@Test.com", sub: null });
});

test("proxy strategy header names are case-insensitive by config value", async () => {
  const original = { ...config.trustedHeader };
  Object.assign(config.trustedHeader, {
    strategy: "proxy",
    proxySecret: "correct",
    proxyHeader: "X-Forwarded-Email",
    proxySecretHeader: "X-Arbr-Proxy-Secret",
  });
  try {
    // Node lowercases incoming header names, so config values must be matched case-insensitively.
    const identity = await trustedHeader.verify({
      headers: { "x-arbr-proxy-secret": "correct", "x-forwarded-email": "bob@test.com" },
    });
    assert.deepEqual(identity, { email: "bob@test.com", sub: null });
  } finally {
    Object.assign(config.trustedHeader, original);
  }
});

test("iap strategy rejects when no audience is configured", async () => {
  const original = { ...config.trustedHeader };
  Object.assign(config.trustedHeader, { strategy: "iap", iapAudience: null });
  try {
    const identity = await trustedHeader.verify({ headers: { "x-goog-iap-jwt-assertion": "not-a-real-jwt" } });
    assert.equal(identity, null);
  } finally {
    Object.assign(config.trustedHeader, original);
  }
});

test("iap strategy rejects a malformed/unsigned token without throwing", async () => {
  const original = { ...config.trustedHeader };
  Object.assign(config.trustedHeader, { strategy: "iap", iapAudience: "test-audience" });
  try {
    const identity = await trustedHeader.verify({ headers: { "x-goog-iap-jwt-assertion": "not-a-real-jwt" } });
    assert.equal(identity, null);
  } finally {
    Object.assign(config.trustedHeader, original);
  }
});
