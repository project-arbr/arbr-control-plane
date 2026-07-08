"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { efficiencyOf } = require("../../src/eval/efficiency");

test("nothing judged → all null", () => {
  const e = efficiencyOf({ judged: 0, worseRate: 0 }, 5);
  assert.equal(e.qualityScore, null);
  assert.equal(e.costPer1kUsd, null);
  assert.equal(e.qualityPerDollar, null);
});

test("quality discounts worse-rate and format failures", () => {
  // 10% worse, 100% format pass → quality 0.9
  assert.equal(efficiencyOf({ judged: 100, worseRate: 0.1, formatPassRate: 1 }, 1).qualityScore, 0.9);
  // 0% worse but only 80% format pass → quality 0.8
  assert.equal(efficiencyOf({ judged: 100, worseRate: 0, formatPassRate: 0.8 }, 1).qualityScore, 0.8);
});

test("cost per 1k scales avg cost per judged item", () => {
  // $2 over 100 items = $0.02/item = $20 / 1k
  const e = efficiencyOf({ judged: 100, worseRate: 0, formatPassRate: 1 }, 2);
  assert.equal(e.costPer1kUsd, 20);
  assert.equal(e.qualityPerDollar, +(1 / 20).toFixed(4)); // 0.05
});

test("free candidate (zero cost) ranks first via Infinity, unless quality is zero", () => {
  assert.equal(efficiencyOf({ judged: 50, worseRate: 0, formatPassRate: 1 }, 0).qualityPerDollar, Infinity);
  assert.equal(efficiencyOf({ judged: 50, worseRate: 1, formatPassRate: 1 }, 0).qualityPerDollar, 0); // all-worse, free → 0
});

test("cheaper wins when quality is equal; better quality wins when cost is equal", () => {
  const cheap = efficiencyOf({ judged: 100, worseRate: 0.1, formatPassRate: 1 }, 1);   // q .9, $10/1k
  const pricey = efficiencyOf({ judged: 100, worseRate: 0.1, formatPassRate: 1 }, 4);  // q .9, $40/1k
  assert.ok(cheap.qualityPerDollar > pricey.qualityPerDollar);

  const better = efficiencyOf({ judged: 100, worseRate: 0.02, formatPassRate: 1 }, 2); // q .98
  const worse = efficiencyOf({ judged: 100, worseRate: 0.20, formatPassRate: 1 }, 2);  // q .80
  assert.ok(better.qualityPerDollar > worse.qualityPerDollar);
});
