// Pure-logic smoke test for the policy impact projector (no DB / no provider keys).
// Run: npm run smoke:simulate
const { projectImpact } = require("../src/routing/policySim");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", msg); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;

// Fake pricing: cost = (prompt+completion)/1e6 * rate; unknown model -> null.
const RATE = { cheap: 1, mid: 5, premium: 10 };
const priceOf = (m, p, c) => (RATE[m] != null ? ((p + c) / 1e6) * RATE[m] : null);
// Fake capability per model.
const CAP = { cheap: 0.4, mid: 0.7, premium: 0.95 };
const capOf = (_t, m) => (CAP[m] != null ? CAP[m] : null);

const rows = [
  { taskType: "coding", servedModel: "premium", requests: 10, promptTokens: 900000, completionTokens: 100000, actualCost: 10 },
  { taskType: "faq",    servedModel: "mid",     requests: 20, promptTokens: 400000, completionTokens: 0,      actualCost: 2 },
];
const r = projectImpact(rows, { coding: "cheap", faq: "cheap" }, priceOf, capOf);
ok(near(r.current.cost, 12), `current cost = 12 (got ${r.current.cost})`);
ok(near(r.projected.cost, 1.4), `projected cost = 1.4 at cheap (got ${r.projected.cost})`);
ok(near(r.current.capabilityIndex, (10 * 0.95 + 20 * 0.7) / 30), "current capability index = traffic-weighted");
ok(near(r.projected.capabilityIndex, 0.4), "projected capability index = 0.4 (all cheap)");
ok(r.rows[0].taskType === "coding" && near(r.rows[0].saved, 9), "rows sorted by saved desc (coding saves 9)");

// Unmapped task -> keeps current served model (no change for that slice).
const r2 = projectImpact([{ taskType: "x", servedModel: "mid", requests: 1, promptTokens: 1000000, completionTokens: 0, actualCost: 5 }], {}, priceOf, capOf);
ok(near(r2.projected.cost, 5), "unmapped task -> served model, no cost change");

// Unpriceable proposed model -> keep actual cost (don't zero it out).
const r3 = projectImpact([{ taskType: "y", servedModel: "mid", requests: 1, promptTokens: 1000000, completionTokens: 0, actualCost: 5 }], { y: "ghost" }, priceOf, capOf);
ok(near(r3.projected.cost, 5), "unpriceable proposed -> keep actual cost");

// Empty input is safe.
const r4 = projectImpact([], {}, priceOf, capOf);
ok(r4.current.cost === 0 && r4.projected.cost === 0 && r4.rows.length === 0, "empty -> zeros, no rows");

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
