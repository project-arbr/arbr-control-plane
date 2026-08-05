<!-- Canonical engineering spec for Arbr request routing. This is the source of
truth for how the gateway decides which model serves a request, and the oracle the
routing test-suite asserts against. For the user-facing overview see routing.md;
where the two disagree, THIS file is authoritative and routing.md should be
reconciled to it. -->

# Arbr routing behavior (engineering spec)

Every request to `/v1/chat` or `/v1/chat/completions` runs through one decision
function, `resolveRoute` in [server/src/gateway/handler.js](../server/src/gateway/handler.js),
which returns the `served` `{ provider, model }` plus a `routingExplain` object the
dashboard narrates from. Both endpoints share `resolveRoute`; the per-request
narration strings quoted below come from
[web/src/components/RequestsTable.jsx](../web/src/components/RequestsTable.jsx) and
are the display source of truth.

Terminology:
- **auto mode** — the request did not pin a model (`model: "auto"` or absent), so
  policies apply. **explicit / pinned** — the client named a resolvable model.
- **basis** — the primary reason a model was chosen: `explicit`, `rule`, `ai`,
  `auto` (guardrail), `canary`, `passthrough` (default). Recorded as `explain.basis`.
- **override** — a later step that *changed* the served model, appended to
  `explain.overrides` via `pushOverride` ([gateway/explain.js](../server/src/gateway/explain.js)).

---

## 1. Precedence pipeline

In order. Steps 1–6 pick the model (`explain.basis`); 7–9 can override or reject it;
10–11 run in the gateway after `resolveRoute` returns.

| # | Step | Entry point | Effect |
|---|------|-------------|--------|
| 1 | **Explicit pin** | `resolveExplicit` | A client model resolvable to a live provider is served as-is, skipping every policy. An unresolvable pin is rejected `400` (see §5). |
| 2 | **Default** | `resolveDefault` | Base pick for auto mode: the API key's `defaultModel` if set and live, else the global default (`connections.effective`). Basis `passthrough`. |
| 3 | **Rule** | `ruleEngine.findRoute` | First enabled `Rule` whose conditions match `taskType`/`application`/`workflow`. Basis `rule`. **Rules always beat AI and guardrail.** |
| 4 | **AI policy** (mode `ai`) | `aiPolicy.lookup` + `resolveModel` | The policy's per-task assignment. A difficulty adjustment (§4) may re-pick **only when `Settings.aiDifficultyAdjust` is on** (default off); otherwise the assignment is authoritative. Basis `ai`. |
| 5 | **Cost guardrail** (mode `guardrail`) | `autoRouter.selectAutoRoute` | Downgrades cheap task types to a lighter model. Basis `auto`. |
| 6 | **Canary** (auto only) | `canaryEngine.selectCanary` | Diverts a deterministic % of matching traffic to a candidate. Override `canary`. |
| 7 | **Allowed-models** | handler.js | If the key restricts models and routing landed outside the set → swap to the key default, else `403`. Override `allowed`. |
| 8 | **Opt-out** | handler.js | If the app blocks the resolved model → swap to the global default. Override `optout`. Then an *allowed-violation flag* is recorded if the swap re-entered a disallowed model (serves anyway — see §Known gaps). |
| 9 | **Vision guard** | handler.js | Auto-routed request with image content on a model not known to support vision → `400 vision_not_supported` (never for explicit pins). |
| 10 | **Budget** | `capEngine.enforcement` (in gateway) | Breached enforcing cap → block `429`, or downgrade to the provider's light model. Override `budget`. Outranks explicit pins. |
| 11 | **Fallback** | `invokeWithFallback` / `buildFallbackOrder` | On a provider error, retry per `ARBR_FALLBACK_SCOPE` (§6). Override `fallback`. |

Routing mode is a single global setting (`off` / `guardrail` / `ai`) via
`ruleEngine.getRoutingMode`. In `off` mode only steps 1–3 and 7–11 run (no AI, no
guardrail); a rule can still fire.

---

## 2. Case catalog

Each case: the request, the decision, and the exact narration.

### 2.1 Explicit pin (developer wins)
```json
POST /v1/chat/completions
{ "model": "gpt-4o", "messages": [...] }
```
→ served `gpt-4o` (openai). Basis `explicit`. No policy applied.
> "The client explicitly requested gpt-4o, so Arbr served it directly without applying a routing policy."

### 2.2 Rule match
Rule: *when task = `support response` → anthropic / claude-haiku-4-5*.
```json
{ "model": "auto", "taskType": "support response", "messages": [...] }
```
→ served `claude-haiku-4-5`. Basis `rule`.
> "A routing rule (matching task support response) directed this request to claude-haiku-4-5."

### 2.3 AI policy, no adjustment
Mode `ai`, policy maps `coding` → `claude-sonnet-4-6`, instance difficulty matches the task tier.
```json
{ "model": "auto", "messages": [{"role":"user","content":"write a function that..."}] }
```
→ classified `coding` (mid), served `claude-sonnet-4-6`. Basis `ai`.
> "Auto-routing: Arbr classified this as coding, mid 6/10, confidence 0.90, and the global AI policy mapped it to claude-sonnet-4-6."

### 2.4 AI policy, difficulty-adjusted (downgrade) — only when `aiDifficultyAdjust` is enabled
Same policy, but the instance is rated *easier* than the task's tier and a cheaper capable model exists. This path runs **only** when the opt-in `aiDifficultyAdjust` setting is on; with it off (default) the policy pick from §2.3 is served unchanged.
> "The policy's base pick was claude-sonnet-4-6; difficulty (light) adjusted it to claude-haiku-4-5."

Note: after #232, difficulty may only substitute a **cheaper, priced** model, and never overrides an explicit assignment with an unrelated/unpriced one.

### 2.5 Cost guardrail
Mode `guardrail`, `summarisation` is a cheap task type, provider's light target is `gpt-4o-mini`.
```json
{ "model": "gpt-4o", "taskType": "summarisation", "messages": [...] }
```
→ served `gpt-4o-mini`. Basis `auto`.
> "Guardrail auto-routing substituted gpt-4o-mini based on the task type (summarisation)."

### 2.6 Canary
Active experiment: baseline `claude-sonnet-4-6` → candidate `claude-opus`, 10% rollout, this user in-bucket.
→ served `claude-opus`. Basis `canary`, override `canary`.
> "A canary experiment routed this from claude-sonnet-4-6 to claude-opus."

### 2.7 Default / passthrough
Auto mode, no rule, mode `off` (or no policy hit).
> global: "No model was pinned and no rule or policy matched, so Arbr served the default model, us.amazon.nova-lite-v1:0."
> per-app: "No rule or policy matched, so Arbr served this application's default model, {model}."

### 2.8 Response-cache hit
An identical earlier request is replayed with no model call. Decision `cache`.
> "Served from Arbr's response cache — an identical earlier request to {model} was reused, with no new model call."

---

## 3. Override chain

Overrides append to `explain.overrides` and chain (an allowed swap can itself be
opted out, then budget-downgraded, then fail over). Each narrates independently.

| Type | Trigger | Narration |
|------|---------|-----------|
| `allowed` | served model not in the key's allowed set | "{from} is not in this API key's allowed-model set, so Arbr served the key's default, {to}." |
| `optout` | served model opted out for the app | "{from} is opted out for this application, so Arbr served {to} instead." |
| `canary` | experiment diversion | "A canary experiment routed this from {from} to {to}." |
| `budget` (downgrade) | enforcing cap over limit | "Budget override: cap \"{scope}\" ({period}, ${limit}) was over limit, so {from} was downgraded to {to}." |
| `budget` (block) | enforcing cap over limit, action block | "Budget cap \"{scope}\" ({period}, ${limit}) was over limit; the request was blocked." |
| `fallback` | primary model call failed | "Fallback: {from} failed, so Arbr retried on {to}." |

**Chained example** (the class of bug behind #225): allowed swap → opt-out swap.
Both lines render, so a model the caller never asked for is traceable to the step
that introduced it. `explain.override` still points at the last entry for
back-compat (older records, OTel attributes).

---

## 4. Classifier

`classifyTask` ([server/src/classify/classifier.js](../server/src/classify/classifier.js))
determines `taskType`, `difficulty` (tier), `difficultyScore` (1–10), and `confidence`.

| method | when | confidence | LLM call? |
|--------|------|-----------|-----------|
| `provided` | client sent `taskType` | 1.0 | no |
| `keyword` | matched a built-in keyword rule | 0.9 | no |
| `ai` | LLM classified (cached by input) | model-reported (~0.8) | yes (billable, logged as internal `classifier` spend) |

Task tiers: **light** (fast/cheap), **mid** (balanced), **premium** (deep reasoning) —
see `TASK_CATALOG` in [aiPolicy.js](../server/src/routing/aiPolicy.js).

Difficulty gating: a low-confidence classification does not drive a difficulty
downgrade — `effDifficulty = (confidence == null || confidence >= 0.5) ? difficulty : null`.

**Skip the LLM classifier** by pinning `taskType` in the request body (method
`provided`, confidence 1.0, no billable call, no difficulty). This is the cheapest
and most predictable path for a developer who already knows the task.

---

## 5. Error / status reference

| Status | code | Meaning |
|--------|------|---------|
| 400 | `model_not_found` | Pinned model unknown to the registry and no provider given. Includes `did_you_mean`. (#229) |
| 400 | `provider_not_connected` | Pinned model routes to a provider that isn't connected. (#229) |
| 400 | `vision_not_supported` | Auto-routed image request on a model not known to support vision. Includes `vision_models`. (#231) |
| 400 | (messages) | `messages` array missing or empty. |
| 403 | `model_not_allowed` | Resolved model not in the API key's allowed set and no live key default. |
| 429 | `budget_exceeded` | An enforcing budget cap (action block) is over limit. |
| 501 | `capability_not_supported` | Tools or vision requested on a native provider whose LangChain path can't forward them. |
| 502 | `provider_error` | The provider call failed and all fallback attempts were exhausted. |
| 503 | `demo_mode` | No provider keys configured. |
| 503 | `app_kill_switch` | The application is disconnected (per-app kill switch). |
| 422 | `guardrail_violation` | Output blocked by a content-policy rule. |
| 422 | `prompt_injection_detected` | Request blocked by prompt-injection detection. |

`/v1/chat/completions` wraps these in the OpenAI shape
(`{ error: { message, type, code } }`); `/v1/chat` returns `{ error, code }`.
Unifying these is Phase 2d.

---

## 6. Fallback

On a provider error, `invokeWithFallback` retries per `ARBR_FALLBACK_SCOPE`
(`buildFallbackOrder`):

- **same-provider** (default) — primary, then the same provider's default light model if different.
- **cross-provider** — primary, then every *other* live provider's default model.
- **none** — primary only; a failure is a `502`.

Worked example, `cross-provider`, primary `gpt-4o` fails, live providers openai +
bedrock-nova + anthropic:
`gpt-4o` → `nova-lite` (bedrock default) → `claude-haiku-4-5` (anthropic default) → first success wins, else `502`.

---

## Known gaps → target behavior (Phase 2 hardening)

These are current defects the hardening phase closes. Documented here so the spec
reflects both today's behavior and the intended end state.

1. **Fallback bypasses governance.** `buildFallbackOrder` uses hardcoded
   `config.defaultModels`; `invokeWithFallback` does not re-check allowed-models /
   opt-out / vision, so a fallback can serve a restricted or non-vision model.
   *Target:* validate every fallback candidate; skip a violating one.
2. **Budget-downgrade** (`suggestLightTarget`) skips the same re-validation.
   *Target:* validate the downgrade target too.
3. ~~**Rule targets are served unvalidated**~~ — **closed (#2b, #3c).** `findRoute`
   skips a rule whose target provider is offline (routing falls through instead of
   dead-ending on a 502) and warns. An unknown model on a *live* provider is left
   servable as a legitimate pass-through, matching explicit-pin behavior. The rules
   API and console also surface each rule's target health (offline / unknown /
   unpriced) so a misconfiguration is visible before it bites.
4. ~~**No rule precedence**~~ — **closed (#2b).** Rules are ordered by priority desc,
   then specificity (condition fields set) desc, then `_id`, so overlapping rules
   resolve deterministically.
5. **Hardcoded, unpriced-prone targets** — `config.defaultModels` isn't
   admin-configurable or registry-validated; an unpriced target logs $0. *Target:*
   Settings-backed, registry-validated per-provider targets.
6. **Allowed-violation serves anyway** (step 8) — the opt-out fallback can re-enter a
   disallowed model; today it only flags. *Target:* covered by the unified guard.
7. **Two gateways duplicate** budget/fallback/guardrail/error-mapping. *Target:* one
   shared pipeline (Phase 2d).
8. **No dry-run.** *Target:* `explainRoute` + `POST /api/routing/explain` (Phase 3a).
