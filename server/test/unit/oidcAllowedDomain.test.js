"use strict";
// Guards shared OAuth clients (e.g. one already registered for a public-signup
// app) from letting any Google account reach arbr — see ARBR_OIDC_ALLOWED_DOMAINS.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isAllowedEmailDomain } = require("../../src/api/authProviders/oidc");

test("no allowlist configured means no restriction", () => {
  assert.equal(isAllowedEmailDomain("anyone@example.com", []), true);
});

test("accepts an email in the allowlist", () => {
  assert.equal(isAllowedEmailDomain("alice@gyde.ai", ["gyde.ai"]), true);
});

test("rejects an email outside the allowlist", () => {
  assert.equal(isAllowedEmailDomain("alice@gmail.com", ["gyde.ai"]), false);
});

test("domain match is case-insensitive on the email side", () => {
  assert.equal(isAllowedEmailDomain("Alice@GYDE.AI", ["gyde.ai"]), true);
});

test("supports multiple allowed domains", () => {
  const allowed = ["gyde.ai", "partner.com"];
  assert.equal(isAllowedEmailDomain("bob@partner.com", allowed), true);
  assert.equal(isAllowedEmailDomain("bob@other.com", allowed), false);
});

test("a bare domain name is not treated as a suffix match (no subdomain bypass)", () => {
  // "notgyde.ai" must not pass an allowlist of "gyde.ai" via naive suffix checks.
  assert.equal(isAllowedEmailDomain("eve@notgyde.ai", ["gyde.ai"]), false);
});
