// Pure-logic smoke for shadow-eval (no DB / no provider keys). Run: npm run smoke:eval
const { isSingleShot, shouldSample, parseVerdict, summarizeEvalPairs } = require("../src/eval/logic");

let pass = 0, fail = 0;
const eq = (got, exp, msg) => {
  const g = JSON.stringify(got), e = JSON.stringify(exp);
  if (g === e) { pass++; } else { fail++; console.log(`FAIL: ${msg} — got ${g}, expected ${e}`); }
};

// 1. isSingleShot — the mirror-safety guard.
eq(isSingleShot("just a string prompt", false), true, "string prompt is single-shot");
eq(isSingleShot([{ role: "system", content: "x" }, { role: "user", content: "hi" }], false), true, "system+user is single-shot");
eq(isSingleShot([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "c" }], false), false, "multi-turn (has assistant) not single-shot");
eq(isSingleShot([{ role: "user", content: "a" }, { role: "tool", content: "b" }], false), false, "tool history not single-shot");
eq(isSingleShot([{ role: "user", content: "a" }], true), false, "tools present not single-shot");

// 2. shouldSample — sampling decision.
eq(shouldSample(0.05, 0.1), true, "0.05 < 0.1 samples");
eq(shouldSample(0.5, 0.1), false, "0.5 >= 0.1 skips");
eq(shouldSample(0.5, 0), false, "rate 0 never samples");

// 3. parseVerdict — candidate is B.
eq(parseVerdict('{"winner":"B","reason":"clearer"}').verdict, "better", "B → better");
eq(parseVerdict('{"winner":"A","reason":"more accurate"}').verdict, "worse", "A → worse");
eq(parseVerdict('here is my call: {"winner":"tie","reason":"same"}').verdict, "equal", "tie → equal (embedded)");
eq(parseVerdict("no json here").verdict, "equal", "unparseable → equal fallback");

// 4. summarizeEvalPairs — verdict + cost/latency aggregation.
const pairs = [
  { verdict: "better", prodCost: 0.10, candidateCost: 0.02, prodLatencyMs: 1000, candidateLatencyMs: 800 },
  { verdict: "equal",  prodCost: 0.10, candidateCost: 0.02, prodLatencyMs: 1000, candidateLatencyMs: 800 },
  { verdict: "worse",  prodCost: 0.10, candidateCost: 0.02, prodLatencyMs: 1000, candidateLatencyMs: 800 },
  { verdict: null,     prodCost: 0.10, candidateCost: 0.02, prodLatencyMs: 1000, candidateLatencyMs: 800 }, // not yet judged
];
const s = summarizeEvalPairs(pairs);
eq(s.pairs, 4, "total pairs");
eq(s.judged, 3, "judged count excludes null verdict");
eq([s.better, s.equal, s.worse], [1, 1, 1], "win/tie/loss counts");
eq(Number(s.lossRate.toFixed(4)), 0.3333, "lossRate = 1/3 of judged");
eq(Number(s.costDeltaPct.toFixed(2)), -0.80, "candidate 80% cheaper");
eq(s.avgCandidateLatencyMs, 800, "avg candidate latency");

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
