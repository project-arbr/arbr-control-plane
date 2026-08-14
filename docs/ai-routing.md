# How Arbr generates and applies an AI routing policy

A precise walk through the `ai` routing mode: the classifier, the deterministic engine that assigns a model
to every task type, how models are vetted against benchmarks, what happens when a benchmark is missing, and
where cost enters the decision.

> Mechanics documented from `control-plane/server/src` — `routing/aiPolicy.js`, `classify/classifier.js`,
> `livebench` · `lmsys` · `eval`, `pricing/registry.js`, `gateway/handler.js`. Prompts are quoted verbatim.

---

## Contents

1. [Three routing modes](#1-three-routing-modes)
2. [The per-request path](#2-the-per-request-path)
3. [Classification & difficulty](#3-classification--difficulty)
4. [What the policy actually is](#4-what-the-policy-actually-is)
5. [Generation — the deterministic engine](#5-generation--the-deterministic-engine)
6. [Gates, goal-as-bar & evidence](#6-gates-goal-as-bar--evidence)
7. [Vetting models — benchmarks become capabilities](#7-vetting-models--benchmarks-become-capabilities)
8. [What if a benchmark isn't available?](#8-what-if-a-benchmark-isnt-available)
9. [How cost enters the decision](#9-how-cost-enters-the-decision)
10. [Proving quality — evals, gates & canary](#10-proving-quality--evals-gates--canary)
11. [Things to know](#11-things-to-know)

Arbr's gateway turns one `POST /v1/chat/completions` into a routing decision. In `ai` mode that decision is
driven by a policy a **deterministic, evidence-based engine** computes ahead of time — a plain map from task
type to model — refined at serve time by a difficulty classifier and gated, separately, by an evidence loop.

---

## 1. Three routing modes

`Settings.routingMode` is one of three values, read per request by `ruleEngine.getRoutingMode()`. It only takes
effect **after** an explicit model pin and any human-written rule — those always win first.

| Mode | What it does | Decision label |
|---|---|---|
| **`off`** | **Passthrough.** Serve the default model (global, or the app's own). No policy consulted. | `passthrough` |
| **`guardrail`** | **Cost guardrail.** Deterministic, downgrade-only — on cheap task types it swaps to a lighter model; never upgrades. | `auto` |
| **`ai`** | **AI policy.** Consults the engine-generated `taskType → model` map, with live classification and an optional per-request difficulty downgrade. | `ai` |

This document is about the **`ai`** mode. The `guardrail` mode is a separate, purely price/tier mechanism
(`routing/autoRouter.js`) — summarised in §9.

---

## 2. The per-request path

Inside `gateway/handler.js → resolveRoute`, a request is resolved in strict precedence. The first branch that
produces a served model wins; the AI policy sits below explicit intent and human rules.

1. **Explicit pin — `model: "…"`** — a named model routes straight to its provider (if known & connected). Skips everything below.
2. **Default — global or per-application** — if no pin, the resolved default. `model: "auto"` defers here and, in `ai` mode, triggers classification.
3. **Human rule — `ruleEngine.findRoute`** — an operator's enabled rule matching taskType / application / workflow overrides the mode branch.
4. **Mode branch — `off` / `guardrail` / `ai`** — only reached when no rule matched. This is where the AI policy is consulted.
5. **Canary divert** — after a model is chosen, an eval-approved canary may deterministically divert a fraction of auto-routed traffic to a challenger (§10).

---

## 3. Classification & difficulty

The policy is keyed by *task type*, so the gateway first labels the request. A caller-supplied `taskType` always
wins (confidence 1.0). Otherwise `classify/classifier.js` runs a fast keyword heuristic (first substring rule
match, confidence 0.9; safe default `"content generation"` at 0.30). In `ai` mode with no supplied type, it
escalates to an LLM classifier on a **cheap** model (temperature 0, cached in-memory):

```text
# LLM classifier prompt — classify/classifier.js : 243–248
You are a task classifier for an AI gateway. Classify the user request and rate its difficulty.
taskType MUST be EXACTLY ONE of: <TASK_TYPES>
difficulty: an integer 1-10 (1 = trivial/short, 5 = moderate, 10 = very complex, multi-step, or deep reasoning).
Return ONLY a JSON object: {"taskType": "...", "difficulty": <1-10>, "confidence": <0-1>}
```

There are **30 built-in task types** in `TASK_CATALOG`, each carrying a default *tier* (light / mid / premium).
Task types that actually appear in a tenant's traffic are unioned in too, so custom types get policy coverage.
The 1–10 difficulty score buckets into tiers (`scoreToTier`):

| Difficulty score | Tier | Meaning |
|---|---|---|
| 1 – 3 | `light` | trivial / short |
| 4 – 7 | `mid` | moderate |
| 8 – 10 | `premium` | complex, multi-step, deep reasoning |

The label you see in a request's detail drawer — e.g. *"content generation, mid, 4/10, conf 0.30"* — is exactly
`taskType`, its tier, the difficulty score, and classifier confidence. A confidence below **0.5** suppresses the
difficulty downgrade (§9).

---

## 4. What the policy actually is

The AI routing policy is not a set of rules or thresholds. It is a **flat map from task type to a single
concrete model id**, persisted on `Settings.aiPolicy` and cached per tenant for 5 seconds:

```js
// stored shape — one model id per task type · models/Settings.js : 28–33
aiPolicy: {
  assignments:       { "faq": "gemini-2.5-flash-lite",
                       "coding": "gemini-2.5-pro",
                       "translation": "claude-haiku-4-5", … },
  generatedAt:       Date,
  generatorModel:    String,   // "deterministic-scorer" — the engine that produced the policy
  capabilityVersion: Number,
}
```

It is regenerated **on demand**, never on a schedule and never from eval feedback. Three triggers:

- An operator clicks **regenerate** (with a goal: cost / quality / balanced).
- The stored `capabilityVersion` is stale — the next read auto-regenerates.
- A **per-application** policy is generated for one app's own assignments.

---

## 5. Generation — the deterministic engine

Generation is **not an LLM call**. It is a reproducible scorer (`aiPolicy.js → _computeAssignments` →
`rankCandidates`) that decides each task's model from real evidence: benchmark capabilities, per-task capability
requirements, and each model's *expected* cost on the tenant's own traffic. Same inputs → same policy, every time.
There is no generator model and no prompt; `generatorModel` is stored as the literal `"deterministic-scorer"`.

For **each** task type the engine runs one pipeline:

```text
# per task — aiPolicy.js → rankCandidates()
1. Candidate pool   → live, priced, chat-capable models, tier-gated (poolFor)
2. Capability gates → drop models below the floor on any dimension the task strongly needs (passesGates)
3. Quality score    → task-weighted capability, 0–1, tagged measured vs estimated (qualityScore)
4. Expected cost    → costFor(model, avgIn, avgOut) from this task's real traffic profile, per 1k requests
5. Conservative     → a premium task drops ESTIMATED models while any MEASURED one qualifies
6. Rank by goal     → cost/balanced: cheapest clearing the quality bar · quality: highest quality
7. Winner + top-3   → assignments[task] = winner; evidence[task] = ranked[0..2] with reasons
```

Every step is deterministic, and each filter **relaxes rather than empties**: if gates or the quality bar would
leave no candidate, that filter is skipped for the task so a model is always assigned.

### Traffic-informed expected cost

Step 4 is why the engine beats a static price table. `taskTokenProfiles(windowDays)` aggregates the tenant's
recent successful **customer** traffic (`RequestRecord`, `CUSTOMER_ONLY`) into an average `{ avgIn, avgOut }` per
task type, and each candidate is priced at *that* profile through `pricing.costFor` — **input and output both**.
A model that's cheap per input token but expensive per output token no longer looks cheap on an output-heavy task.
A task with no traffic yet falls back to a default `{ avgIn: 600, avgOut: 300 }` profile, so a fresh tenant still
gets a sensible policy.

---

## 6. Gates, goal-as-bar & evidence

**Hard capability gates.** For every dimension a task *strongly* needs (`TASK_CAPABILITIES[dim] ≥ 0.7`) a model
must clear a capability floor (`≥ 0.55`) or it never enters the cost comparison (`passesGates`). A coding-heavy
task therefore excludes a cheap generalist that can't code, no matter how cheap it is — the exact failure the
old price-guided prompt allowed.

**Tier pool.** Before gates, candidates are limited to the task's tier band (`poolFor`), so a "light" task never
considers premium models:

| Task tier | Eligible models | In `cost` goal |
|---|---|---|
| `light` | light only | light only |
| `mid` | light + mid | light + mid |
| `premium` | all live models | mid + premium (drops light — premium tasks need real capability) |

**Goal as a quality bar** (not a fuzzy instruction). The operator's goal sets a minimum quality and the ranking objective:

| goal | quality bar | ranking objective |
|---|---|---|
| **cost** | 0.70 | among models clearing gates + bar, pick the **lowest expected cost** |
| **balanced** | 0.80 | lowest expected cost |
| **quality** | none | pick the **highest quality**; expected cost is the tiebreak |

Ties break deterministically: prefer the **measured** model, then lower expected cost / higher quality, then
stable id order — never a coin flip, never an LLM.

**Conservative unknowns.** A model whose capabilities are *estimated* (curated table or keyword-derived, not a
LiveBench/LMSYS sync) is tagged `confidence: "low"` and `needsShadowEval: true`, and is **excluded from
premium-tier tasks whenever a measured model qualifies** — so a keyword-guessed model can't win a high-stakes
task on price alone.

**Evidence output.** `rankCandidates` returns the top-3 candidates per task, each carrying
`{ model, tier, quality, expectedCostPer1k, measured, confidence, needsShadowEval, reason }`. The stored policy
still persists only the winner (`taskType → modelId`), but `POST /api/ai-policy/regenerate` and the per-app
`generate-policy` route return the full `evidence` map so an operator can see *why* each pick won.

> **Deferred (typed seams left in place).** A `taskType × difficulty` 2-D policy (the serve-time difficulty
> downgrade already adapts per request), tenant-eval win-rate weighting inside `qualityScore` (awaiting eval
> volume), and latency/reliability SLAs as additional gates. Each has a seam in the code; none blocks V1.

---

## 7. Vetting models — benchmarks become capabilities

A model's *capabilities* are **7 floats in 0–1** on `ModelEntry.capabilities`: `coding`, `reasoning`, `writing`,
`analysis`, `language`, `general`, `data`. Two public leaderboards populate them.

### LiveBench → the seven dimensions

The latest LiveBench CSV is downloaded and per-task columns (0–100) are grouped and averaged into the
dimensions, e.g.:

```text
# livebench/sync.js → toCapabilities() : 99–107
reasoning: clamp((0.7·logic + 0.3·math) / 100)   // logic > math
coding:    clamp(codingRaw / 100)
analysis:  clamp((data + logic) / 2 / 100)
general:   clamp(mean(all task columns) / 100)
// writing, language, data map from their column groups
```

### LMSYS (Chatbot Arena) → general

Arena Elo is converted to the `general` dimension only, and supplements LiveBench's value:

```text
capabilities.general = clamp( (elo − 1000) / 500 )    // 1000→0.0 · 1250→0.5 · 1500→1.0
```

Model names are reconciled with a shared `normalize()` (lowercase; strip Bedrock prefixes, effort qualifiers,
date and `-preview/-snapshot/-instruct` suffixes; dots→dashes), then matched **exact-normalized first,
prefix-overlap second**. On collisions LiveBench keeps the row with more non-zero categories; LMSYS keeps the
higher Elo.

---

## 8. What if a benchmark isn't available?

A model with no LiveBench/LMSYS row is **not excluded** — it's simply skipped by the sync and its
`capabilities.*` stay `null`. Routability is governed by `enabled` and `chatCapable`, never by benchmark
presence. When the scorer needs capabilities it walks a three-level chain:

1. **Synced benchmark capabilities** — used when `capabilities.coding != null` (real LiveBench/LMSYS data).
2. **Hardcoded `MODEL_CAPABILITIES` table** — ~35 well-known models with hand-set per-dimension scores, for models the leaderboards missed.
3. **Keyword-derived defaults** — `deriveCapabilities()`: every dimension defaults to **0.4**, bumped to **0.7** where the model's name/description matches a domain keyword.

Cost, meanwhile, always has a floor: `tier` is derived purely from price at sync time
(`avg $/1M ≥ 8 → premium · ≥ 0.8 → mid · else light`), so an unbenchmarked model still competes on tier +
derived-caps + price. But an *estimated*-capability model is treated conservatively by the engine (§6): it's
flagged low-confidence and `needsShadowEval`, and it's kept out of premium-tier tasks whenever a measured model
qualifies. Separately, `pricedPool` drops models with no positive input price, so an unpriced model can't win a
task by faking a near-zero cost.

---

## 9. How cost enters the decision

Actual spend is computed by `pricing/registry.js → costFor` from the model's `inputPer1M` / `outputPer1M`, with a
prompt-cache split (cached-read and cache-write rates fall back to the input rate when unset):

```text
total = (uncached·in + cachedRead·readRate + cacheWrite·writeRate)/1e6 + (out·outRate)/1e6
```

Cost then shapes routing in three distinct places:

- **Policy generation** — the engine prices every candidate at its *expected* cost on the task's real traffic (input + output, §5), then for the cost/balanced goals picks the cheapest model that clears the quality bar (§6). The `quality` goal ranks on capability and uses expected cost only to break ties.
- **Guardrail downgrade** — in `guardrail` mode, cheap task types (classification, extraction, summarisation, translation, faq, support-response) downgrade to the provider's light target. *Conservative* downgrades only premium-tier; *aggressive* downgrades anything strictly costlier than the target. Never upgrades.
- **Difficulty downgrade** (opt-in, `aiDifficultyAdjust`) — when a specific request is classified *easier* than its task's usual tier, the policy pick may be swapped for a model in that lower tier **only if it is strictly cheaper**. The generated pick is a ceiling; difficulty can save cost, never raise it.

> **The mental model.** "Route to the cheapest model that still clears the bar." The *bar* is now literal: the
> tier pool (which models are eligible) + the hard capability gates + the goal's quality threshold. *Cheapest* is
> the model's expected cost on the task's real traffic inside that surviving pool. Difficulty can lower the bar for
> an easy request, but never raise it above the operator-approved policy pick.

---

## 10. Proving quality — evals, gates & canary

Quality evidence is a **separate loop** from policy generation. It never edits the generated policy or writes a
live "quality score" onto a model. Instead it gates two promotions: a recommendation becoming an enabled rule,
and a canary rolling out.

### LLM-as-judge

After a response is served, `eval/shadow.js` may (sampled, budgeted, single-shot) replay the request on a
challenger model and have a judge compare them — with the candidate randomly placed in slot A or B to de-bias
position, and a guard so the judge isn't from the candidate's own family:

```text
# Shadow judge prompt (verbatim) — eval/judge.js : 23–37 · temperature 0
You are impartially evaluating two AI responses to the SAME user request. Decide which better
fulfills the request (correctness, completeness, instruction-following). Be strict.

USER REQUEST:
{user text}

RESPONSE A (current model):   {prod text}
RESPONSE B (candidate model): {candidate text}

Reply with ONLY JSON: {"winner": "A" | "B" | "tie", "reason": "<one short sentence>"}
```

The offline path uses a stricter *rubric* judge — five 1–5 scores
(`correctness, completeness, instruction_following, format, safety`) plus a `critical_failure` flag — followed by
a conservative "disprove it" pass that only overturns a *worse* verdict when it's clearly wrong.

### Gates by risk tier

An eval run only **passes** (and lets a recommendation become an enabled rule) if every threshold holds.
Thresholds tighten with the model's risk band (`eval/thresholds.js`):

| risk | min items | max worse-rate | max critical-fail | min format-pass | min cost saving | max latency regression |
|---|---|---|---|---|---|---|
| low | 200 | 5% | 0.5% | 98% | 25% | 20% |
| medium | 300 | 3% | 0.2% | 99% | 20% | 10% |
| high | 500 | 1% | 0% | 99.5% | 15% | 0% |

### Canary — ramp & auto-rollback

A passed eval can spawn a `RoutingExperiment`: a deterministic per-(app, user, workflow) bucket sends
`rolloutPct` of matching auto-routed traffic to the challenger. A monitor re-checks every 5 minutes and
**auto-rolls-back** on any guardrail breach:

| guardrail | rollback when |
|---|---|
| error-rate increase | > 2% vs baseline |
| p95 latency regression | > 25% |
| cost saving | < 10% |
| judged worse-rate | > 10% (min 20 samples) |

The canary is the *only* place eval results touch live routing — as a diverted fraction after a model is chosen,
never by rewriting the policy.

---

## 11. Things to know

- **The policy is a static map, generated on demand.** It's a `taskType → model` assignment the deterministic engine computes when asked — not a model continuously learning from traffic.
- **Generation is deterministic — no LLM, no prompt.** The same evidence produces the same policy every time; `generatorModel` is the literal `"deterministic-scorer"`. (A bounded LLM tie-breaker/explainer is a possible future add-on, but the engine is fully functional without it.)
- **Assignments are ranked on capability + expected cost, not price + tier.** Each candidate is gated on the benchmark capabilities the task needs, scored on task-weighted quality, and priced at its expected input+output cost on the tenant's real traffic — the engine picks the cheapest model that clears the quality bar (or the highest-quality model for the `quality` goal).
- **Human intent always wins.** Explicit pins and operator rules resolve before any mode branch; the AI policy is the fallback for un-pinned, un-ruled traffic.
- **Benchmarks never gate liveness.** A missing benchmark degrades gracefully to a hardcoded table, then keyword defaults, then price-derived tier — a model is never dropped for lacking a score (only for lacking a price).
- **Evidence gates promotion, not generation.** Evals move a recommendation into an enabled rule and govern canary ramp/rollback; they don't rewrite the generated policy.
