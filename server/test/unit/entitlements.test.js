"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { entitlementsFor, feature, limit, ALL_ON } = require("../../src/cloud/entitlements");

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
