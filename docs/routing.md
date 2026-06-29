# Routing

Arbr's routing layer sits between the request and the provider. It works on a clear precedence — **the developer's pin wins**, and automation only applies when the app defers.

## Routing modes

Set in **Settings → Routing → Automated routing**:

| Mode | What happens when `model: "auto"` |
|---|---|
| **Off** | Rules → default model (no automation) |
| **Cost guardrail** | Rules → guardrail policy (downgrade premium→light on cheap task types) → default |
| **AI routing** | Rules → AI-generated task→model map (AI classifies the task, then routes it) → default |

## Routing precedence

Every request is evaluated top-to-bottom; the first match wins:

### 1. Budget enforcement

If a budget **Block** cap is breached for the request's scope (application, provider, department), the request is rejected with HTTP 429.

If a **Downgrade** cap is breached, the request is forced to the provider's light-tier model, overriding everything below — including developer pins.

See [Budgets](/budgets).

### 2. Explicit pin (developer wins)

If the caller specifies a `model` whose provider is connected:
- The model is used **as-is**
- All routing policies are **skipped**
- `routingDecision: "explicit"`

This works even for models not in the registry — Arbr routes to the provider with the exact model string you sent (pass-through). Cost is logged as `$0` until you add a pricing entry.

### 3. Auto routing (when `model: "auto"` or omitted)

When no explicit model is pinned, the router evaluates in order:

**a. Cache** — identical `(served_model, messages)` → returns the stored response. `routingDecision: "cache"`

**b. Human routing rules** — the first enabled rule whose condition matches the request wins. Rules are editable in **Settings → Routing rules**. `routingDecision: "rule"`

**c. Automated routing** (if enabled):
  - *Cost guardrail*: if the task type is "cheap" (classification, extraction, summarisation, etc.) and the default model is premium, downgrade to the provider's light model. `routingDecision: "auto"`
  - *AI policy*: the AI-generated task→model map routes the request based on its classified task type. `routingDecision: "ai"`

**d. Default** — the configured default provider + model. `routingDecision: "passthrough"`

### 4. Fallback

If the routed provider fails, Arbr tries other live providers in order. `routingDecision: "fallback"`

## Routing rules

Human-approved rules are applied before any automation. Each rule has:

- **Condition** — match on `taskType`, `application`, `workflow`, `department`, or `userId`
- **Action** — route to a specific `provider` + `model`
- **Enabled toggle** — off by default when created from a Recommendation

Create rules in **Settings → Routing rules** or accept them from **Recommendations**.

## Task classification

When `taskType` is not sent by the caller, Arbr classifies it against the **latest user turn** (not the first, so classification stays current in multi-turn conversations):

| Method | When | `classifiedBy` |
|---|---|---|
| Provided | Caller set `taskType` | `"provided"` |
| Keyword | Rule-based keyword match on the message | `"keyword"` |
| AI | AI routing mode + no keyword match | `"ai"` |

Known cheap task types: `classification`, `extraction`, `summarisation`, `translation`, `faq`, `support response`.

The classifier also outputs a **difficulty score (1–10)** and a **confidence (0–1)**. Both are stored on the `RequestRecord` for observability. Low-confidence results (`< 0.5`) do not drive difficulty-based routing changes.

## Difficulty-aware routing

Within a task type, not all requests are equally hard. Once AI routing mode is on, Arbr adjusts the model pick based on difficulty:

| Difficulty | Routing adjustment |
|---|---|
| Easy (score ≤ 3) | Re-picks within the task type's tier toward a **cheaper** model |
| Normal (4–7) | Uses the policy's default pick as-is |
| Hard (score ≥ 8) | Re-picks toward a **stronger** model within the available set |

This only applies when the AI policy has a pick for the task type; unmapped tasks are pass-through as before.

## Routing explainability

Every `RequestRecord` includes a `routingExplain` object that captures the non-derivable "why" behind the decision — which rule matched, which policy entry was used, whether a difficulty adjustment overrode the default, and what fallback was taken. This is visible in the **Requests** drilldown on the dashboard.

## AI routing policy

When AI routing mode is on, Arbr uses an AI-generated `{taskType → model}` map. To regenerate it:

1. Go to **Settings → Routing → AI routing policy**
2. Click **Regenerate** — uses the default model to produce the map
3. Review and edit the map
4. Enable AI routing mode to activate it

::: warning Gemini thinking models
`gemini-2.5-flash` with thinking mode can fail JSON generation. Use `gpt-4o-mini` or another model as your default when generating the AI routing policy.
:::

## The developer's pin in practice

```sh
# This model is always honored — routing policies don't apply
curl -X POST http://localhost:4100/v1/chat \
  -d '{ "model": "gpt-4o", "messages": "Draft a legal summary..." }'

# This defers to the router — rules + automation apply
curl -X POST http://localhost:4100/v1/chat \
  -d '{ "model": "auto", "messages": "Classify: card was declined." }'
```

The **Requests** page shows `routingDecision`, `classifiedBy`, `difficulty`, and `routingExplain` for every call via the request drilldown.
