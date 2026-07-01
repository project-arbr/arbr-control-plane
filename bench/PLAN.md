# Benchmark roadmap

Goal: publish credible, reproducible **router** benchmarks (cost-vs-quality) that back Arbr's
positioning — explainable, task-aware, production routing — and answer RouteLLM's "2x" with a measured
number on stronger, contamination-resistant benchmarks. See `METHODOLOGY.md`.

Selected: **LiveBench**, **Arena-Hard-Auto**, **SWE-bench Verified**. RouteLLM-OSS stays as a *baseline
router within* these (keeps the head-to-head without adopting its saturated MMLU/GSM8K set).

## Phases (cheapest-first; each yields a publishable artifact)
- **Phase 0 — spec + pool (done):** `PLAN.md`, `METHODOLOGY.md`, `config.js` (pool + prices).
- **Phase 1 — LiveBench harness (this PR):** `runner.js` + `lib/{gateway,cost,router,summarize}.js` +
  `scorers/livebench.js` + `aggregate.js`. Deterministic objective scoring; per-category (→ task types);
  no LLM judge; lowest cost. `smoke:bench` covers the pure logic.
- **Phase 2 — Arena-Hard-Auto (done):** `scorers/arenahard.js` — pairwise LLM-judge via the gateway's
  judge model, reusing `parseVerdict` from `server/src/eval/logic.js`; win/tie/loss vs the item's
  reference answer. Confidence intervals to add when computing full-run numbers.
- **Phase 3 — SWE-bench Verified:** `scorers/swebench.js` + agentic scaffold + official Docker harness;
  resolved-rate vs cost. Heaviest; phase last. (BFCL is a cheaper tool-routing stand-in if it slips.)
- **Phase 4 — RouteLLM-OSS baseline + publish:** `baselines.js` RouteLLM adapter; commit raw results +
  summaries; the head-to-head curve.

## Status
Phases 0–2 built and syntax/logic-validated (`smoke:bench` 15/15). Sample fixtures under `fixtures/`
let you exercise the full pipeline against a real Arbr with tiny cost. Full runs require Node 18 + real
API keys (real cost) + the full datasets — run on a box with keys, not in CI. Phase 3 (SWE-bench) next.
