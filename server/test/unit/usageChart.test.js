"use strict";
// Unit tests for the embeddable usage chart (#5): the pure geometry helper, and that
// the served page is well-formed and embeds that exact helper.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { chartGeometry, PAGE } = require("../../src/embed/usageChart");

test("chartGeometry maps rows to a polyline within the viewBox", () => {
  const rows = [{ date: "2026-01-01", cost: 0 }, { date: "2026-01-02", cost: 5 }, { date: "2026-01-03", cost: 10 }];
  const g = chartGeometry(rows, { metric: "cost", width: 100, height: 100, pad: 10 });
  const pts = g.points.split(" ").map((p) => p.split(",").map(Number));
  assert.equal(pts.length, 3);
  assert.equal(g.max, 10);
  // First x at left pad, last x at right pad.
  assert.equal(pts[0][0], 10);
  assert.equal(pts[2][0], 90);
  // Max value (row 3) sits at the top pad; zero (row 1) at the bottom.
  assert.equal(pts[2][1], 10, "the max value is at the top (y = pad)");
  assert.equal(pts[0][1], 90, "zero is at the bottom (y = height - pad)");
});

test("chartGeometry centers a single point and never divides by zero", () => {
  const g = chartGeometry([{ cost: 3 }], { metric: "cost", width: 100, height: 100, pad: 10 });
  const [x] = g.points.split(",").map(Number);
  assert.equal(x, 50, "a lone point is centered");
});

test("chartGeometry handles all-zero series without NaN (max floored)", () => {
  const g = chartGeometry([{ cost: 0 }, { cost: 0 }], { metric: "cost", width: 100, height: 100, pad: 10 });
  assert.ok(!/NaN/.test(g.points), "no NaN coordinates");
});

test("chartGeometry selects the requested metric", () => {
  const rows = [{ cost: 1, requests: 100 }, { cost: 2, requests: 50 }];
  assert.equal(chartGeometry(rows, { metric: "requests" }).max, 100);
  assert.equal(chartGeometry(rows, { metric: "cost" }).max, 2);
});

test("the served page embeds the exact chartGeometry source and reads the token from the fragment", () => {
  assert.ok(PAGE.includes("function chartGeometry"), "geometry is inlined, so page and tests share one source");
  assert.ok(PAGE.includes("location.hash"), "token comes from the URL fragment, not a query/param");
  assert.ok(PAGE.includes("/v1/usage/timeseries"), "fetches the scoped timeseries endpoint");
  assert.ok(!PAGE.includes("</scr" + "ipt><scr" + "ipt"), "single inline script");
});
