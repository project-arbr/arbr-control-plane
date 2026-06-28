// Pure-logic smoke test for realised-savings math (no DB / no provider keys).
// Run: npm run smoke:savings
const { computeRealisedSavings } = require("../src/analytics/savings");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", msg); } };

// Fake pricing: gpt-4o = $10/1M in+out combined for simplicity; cheap = $1/1M; unknown = null.
const RATES = { "gpt-4o": 10, "gpt-4o-mini": 1, "claude": 10 };
const priceOf = (model, p, c) => (RATES[model] != null ? ((p + c) / 1e6) * RATES[model] : null);

const groups = [
  // Requested gpt-4o, served the mini: 1M tokens. baseline $10, actual $1 → saved $9.
  { requested: "gpt-4o", served: "gpt-4o-mini", requests: 5, promptTokens: 600000, completionTokens: 400000, actualCost: 1 },
  // auto → no baseline, skipped.
  { requested: "auto", served: "gpt-4o-mini", requests: 50, promptTokens: 100000, completionTokens: 0, actualCost: 0.1 },
  // unknown requested model → skipped (can't price).
  { requested: "mystery-model", served: "gpt-4o-mini", requests: 3, promptTokens: 100000, completionTokens: 0, actualCost: 0.1 },
];

const r = computeRealisedSavings(groups, priceOf);
ok(Math.abs(r.totalSaved - 9) < 1e-9, `totalSaved = 9 (got ${r.totalSaved})`);
ok(r.substitutedRequests === 5, `substitutedRequests counts only priced substitutions (got ${r.substitutedRequests})`);
ok(r.rows.length === 1, `auto + unknown rows excluded (got ${r.rows.length})`);
ok(r.rows[0].requested === "gpt-4o" && r.rows[0].served === "gpt-4o-mini", "row pairs requested→served");

// Empty / null input is safe.
ok(computeRealisedSavings([], priceOf).totalSaved === 0, "empty groups → 0");
ok(computeRealisedSavings(null, priceOf).rows.length === 0, "null groups → no rows");

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
