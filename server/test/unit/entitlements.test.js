"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { entitlementsFor, feature, limit, requireFeature, ALL_ON } = require("../../src/cloud/entitlements");

// Minimal res double capturing status()/json().
function resDouble() {
  return {
    _status: null, _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
  };
}
function run(mw, req) {
  const res = resDouble();
  let nexted = false;
  mw(req, res, () => { nexted = true; });
  return { res, nexted };
}

test("OSS default: no request entitlements => everything allowed", () => {
  assert.equal(entitlementsFor(null), ALL_ON);
  assert.equal(entitlementsFor(undefined), ALL_ON);
  assert.equal(feature(null, "ai_routing"), true);
  assert.equal(feature({}, "anything"), true);
});

test("features:null on an entitlements object still means unrestricted", () => {
  assert.equal(feature({ entitlements: { features: null } }, "sso"), true);
});

test("a features Set restricts to its members", () => {
  const req = { entitlements: { features: new Set(["ai_routing", "webhooks"]) } };
  assert.equal(feature(req, "ai_routing"), true);
  assert.equal(feature(req, "webhooks"), true);
  assert.equal(feature(req, "evals_canary"), false);
  assert.equal(feature(req, "sso"), false);
});

test("limit() reads per-account limits with a fallback", () => {
  const req = { entitlements: { limits: { rpm: 60, monthlySpendUsd: 5 } } };
  assert.equal(limit(req, "rpm", 999), 60);
  assert.equal(limit(req, "monthlySpendUsd"), 5);
  assert.equal(limit(req, "retentionDays", 30), 30); // unset => fallback
  assert.equal(limit(null, "rpm", 999), 999);         // no entitlements => fallback
});

test("requireFeature: OSS default (no entitlements) always calls next()", () => {
  const { res, nexted } = run(requireFeature("ai_routing"), {});
  assert.equal(nexted, true);
  assert.equal(res._status, null);
});

test("requireFeature: allows when the plan includes the feature", () => {
  const req = { entitlements: { features: new Set(["ai_routing"]) } };
  const { nexted, res } = run(requireFeature("ai_routing"), req);
  assert.equal(nexted, true);
  assert.equal(res._status, null);
});

test("requireFeature: 402 upgrade_required when the plan excludes the feature", () => {
  const req = { entitlements: { features: new Set(["ai_routing"]) } };
  const { nexted, res } = run(requireFeature("webhooks"), req);
  assert.equal(nexted, false);
  assert.equal(res._status, 402);
  assert.equal(res._json.error, "upgrade_required");
  assert.equal(res._json.feature, "webhooks");
});

test("requireFeature: free plan (empty feature set) blocks every advanced feature", () => {
  const req = { entitlements: { features: new Set() } };
  for (const key of ["ai_routing", "evals_canary", "guardrails_pii", "webhooks", "embed_widgets", "sso"]) {
    const { nexted, res } = run(requireFeature(key), req);
    assert.equal(nexted, false, `${key} should be blocked`);
    assert.equal(res._status, 402);
  }
});
