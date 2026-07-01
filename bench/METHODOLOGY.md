# Benchmark methodology

## What is measured
Arbr is a **router**. For each benchmark we compute a **cost-vs-quality curve** across routers on the
identical prompt set + identical model pool:

- **x** = cost per query (USD), computed deterministically from token usage × the published price table
  (`bench/config.js`), **not** read from billing.
- **y** = quality (benchmark-native score over *scored* rows).

**Headline metric** (matches RouteLLM's framing for comparability): *cost reduction at ≥95% of
always-premium quality*, reported overall and **per task type** (Arbr's task-aware differentiator).
Every Arbr routing decision also carries a reason (`routingDecision`/`taskType`) — an explainability
axis baseline routers can't produce.

## Routers compared (baselines)
Same prompts, same pool, run side by side:
- `always-premium` — upper bound on quality, upper bound on cost.
- `always-light` — lower bound on cost, lower bound on quality.
- `random` — seeded random pick (reproducible); the "routing adds nothing" control.
- `routellm` — RouteLLM-OSS router (Phase 4 adapter) — the competitive head-to-head.
- `arbr-auto` — Arbr's task-aware policy (send `model: "auto"`).

The Arbr instance under test **must have its AI policy scoped to exactly the pool** so `arbr-auto` only
routes among the priced models (otherwise rows come back `unpriced` and are flagged).

## Quality scoring
- **LiveBench**: objective categories (math / reasoning / data-analysis) scored by normalized final-answer
  match (faithful to LiveBench's exact-answer scoring). Coding / language / instruction-following require
  LiveBench's **official category graders** — an explicit integration point; until wired those rows are
  `scored:false` and excluded from quality (never scored 0 by guess).
- **Arena-Hard-Auto** (Phase 2): LLM-judged win-rate vs a reference, reusing the shadow-eval judge
  (`server/src/eval/judge.js`); report confidence intervals (judge variance).
- **SWE-bench Verified** (Phase 3): resolved-rate via the official Docker test harness; agentic, so the
  agent's per-step calls route through Arbr.

## Reproducibility & honesty (non-negotiable for publishing)
- Publish the **model pool + per-1M prices**, dataset version, seed, and the harness itself.
- Commit raw `results/*.jsonl` + `*.summary.json`.
- Report **confidence intervals** on judged benchmarks; **report where Arbr loses**.
- Prefer LiveBench / SWE-bench (contamination-resistant); note contamination risk on any MCQ set.
- Costs are provider-price-dependent — a different pool/prices yields different numbers; that's disclosed.
