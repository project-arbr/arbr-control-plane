"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { requireRole } = require("../../src/api/rbac");

function mockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

test("viewer cannot pass an operator gate", () => {
  const req = { user: { id: "1", email: "v@test", role: "viewer" } };
  const res = mockRes();
  let nextCalled = false;
  requireRole("operator")(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "forbidden");
});

test("operator passes an operator gate but not an administrator gate", () => {
  const req = { user: { id: "1", email: "o@test", role: "operator" } };
  let nextCalled = false;
  requireRole("operator")(req, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);

  const res2 = mockRes();
  nextCalled = false;
  requireRole("administrator")(req, res2, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res2.statusCode, 403);
});

test("administrator passes every gate", () => {
  const req = { user: { id: "1", email: "a@test", role: "administrator" } };
  for (const role of ["viewer", "operator", "administrator"]) {
    let nextCalled = false;
    requireRole(role)(req, mockRes(), () => { nextCalled = true; });
    assert.equal(nextCalled, true, `administrator should pass requireRole("${role}")`);
  }
});

test("missing req.user (unresolved identity) is rejected, not treated as viewer", () => {
  const req = {};
  const res = mockRes();
  let nextCalled = false;
  requireRole("viewer")(req, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});
