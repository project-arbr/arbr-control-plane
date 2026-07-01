# Arbr routing benchmarks

Arbr is a **router**, so these benchmarks don't produce a leaderboard score — they produce a
**cost-vs-quality curve**: for a fixed quality bar, how much cost Arbr's task-aware routing saves vs
baselines (always-premium, always-light, random, and RouteLLM-OSS). See `METHODOLOGY.md` for the rules
and `PLAN.md` for the phased roadmap. Selected benchmarks: **LiveBench** (built), **Arena-Hard-Auto**,
**SWE-bench Verified**.

## Run LiveBench (Phase 1)

Requires **Node 18+** and **real API keys** — every row is a live model call (costs money).

```sh
# 1. Point at an Arbr instance whose AI policy is scoped to the model pool in bench/config.js,
#    with a gateway key for application "bench".
export ARBR_BASE_URL="https://your-arbr-host/v1"
export ARBR_API_KEY="ab_…"

# 2. Get the LiveBench question set as jsonl (question_id, category, turns, ground_truth).
#    Start small with --limit while validating.
RUN_TAG=smoke node bench/runner.js --dataset path/to/livebench.jsonl --limit 20

# 3. Aggregate → cost-vs-quality table + headline + summary.json
node bench/aggregate.js bench/results/livebench-smoke.jsonl
```

`npm run smoke:bench` validates the pure logic (cost, scoring, aggregation) with no network.

## Honesty notes
- The model pool + prices in `bench/config.js` are disclosed with every result; numbers don't
  generalize across pools/prices.
- Objective LiveBench categories (math/reasoning/data) are scored here; coding/language/IF need
  LiveBench's **official grader** (an explicit integration point — those rows are marked unscored, not
  guessed) before publishing those categories.
- Commit raw `results/*.jsonl` + `*.summary.json` for reproducibility. Report where Arbr loses.
