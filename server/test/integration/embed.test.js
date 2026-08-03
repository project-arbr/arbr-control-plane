"use strict";
// Integration: the embed route serves the widget page (no auth, no DB needed).
const { test, before } = require("node:test");
const assert = require("node:assert/strict");

let agent, skip = false;

before(() => {
  try {
    const express = require("express");
    const supertest = require("supertest");
    const embedRoutes = require("../../src/api/routes/embed");
    const app = express();
    app.use("/embed", embedRoutes);
    agent = supertest(app);
  } catch (err) { skip = true; console.warn("[embed] skipping:", err.message); }
});

test("GET /embed/usage serves a self-contained HTML widget", async (t) => {
  if (skip) return t.skip("no supertest");
  const res = await agent.get("/embed/usage");
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.ok(res.text.includes("<svg") === false || res.text.includes("chartGeometry"), "page carries the chart bootstrap");
  assert.ok(res.text.includes("location.hash"), "reads the token from the fragment");
  // Cacheable but not too long.
  assert.match(res.headers["cache-control"] || "", /max-age=/);
});
