# Budgets & governance

Budgets (caps) enforce spend limits per application, provider, department, workflow, model, or **end user**. A breached cap can alert, downgrade the model, or block the request — with no code changes to any application.

## How budgets work

Each budget tracks rolling spend over a **day** or **month** window. When `spent ≥ limit`:

| Action | What happens |
|---|---|
| **Alert** | No request is affected. The breach shows in the dashboard and `/api/status`, and a `cap_breach` webhook fires (plus `cap_warning` at the warn threshold). Use this for per-user usage notifications. |
| **Downgrade** | Every request in the capped scope is forced to the provider's light-tier model (overrides even developer pins) |
| **Block** | Requests in the capped scope are rejected with HTTP 429 `budget_exceeded` |

Downgrade and Block are enforced **before** routing — they outrank explicit model pins. Every action, including `alert`, fires `cap_warning` / `cap_breach` webhooks (see [Alert webhooks](#alert-webhooks)).

## Creating a budget

**Dashboard:** Settings → Budgets → **+ Add cap**

**Admin API:**
```sh
curl -X POST http://localhost:4100/api/caps \
  -H 'Content-Type: application/json' \
  -d '{
    "dimension": "application",
    "value": "support-chat",
    "period": "month",
    "limit": 50.00,
    "action": "downgrade"
  }'
```

Fields:
| Field | Values | Description |
|---|---|---|
| `dimension` | `application` \| `provider` \| `department` \| `workflow` \| `model` \| `user` \| (omit for global) | What to scope the cap to |
| `value` | string | The specific application/provider/department/workflow/model, or the end-user id, to cap |
| `period` | `day` \| `month` | Rolling window |
| `limit` | number (USD) | Spend threshold |
| `action` | `alert` \| `downgrade` \| `block` | What to do when breached |
| `warningThreshold` | number, 0–1 (default `0.8`) | Fraction of `limit` at which a `cap_warning` webhook fires, ahead of the breach. Applies to every action, including `alert`. |

The `user` dimension caps an individual end user's spend. Attribution comes from the request's trusted `userId` — a per-user gateway key binds it, otherwise it falls back to the caller-supplied `user` / `x-arbr-user-id`. For hard `block` enforcement, use per-user keys so the identity cannot be spoofed; for `alert` (the common per-user case) the self-reported id is fine.

## Examples

**Cap the "support-chat" app at $50/month, downgrade if breached:**
```json
{ "dimension": "application", "value": "support-chat", "period": "month", "limit": 50, "action": "downgrade" }
```

**Cap all OpenAI spend at $200/month, alert only:**
```json
{ "dimension": "provider", "value": "openai", "period": "month", "limit": 200, "action": "alert" }
```

**Global daily cap — block everything over $20/day:**
```json
{ "period": "day", "limit": 20, "action": "block" }
```

**Alert an end user near their monthly quota (self-serve usage notification):**
```json
{ "dimension": "user", "value": "user_1a2b3c", "period": "month", "limit": 10, "action": "alert", "warningThreshold": 0.8 }
```
This fires `cap_warning` at $8 and `cap_breach` at $10 without changing routing — a downstream app turns those webhooks into an in-product "80% of your monthly usage" notice.

## Alert webhooks

Set a **Webhook URL** in Settings. When a cap crosses its warn threshold or its limit, Arbr POSTs a JSON event to that URL. This is how per-user usage alerts reach a downstream app — there is no built-in email.

`cap_warning` (fired once per warn threshold crossing, deduped ~5 min):
```json
{
  "event": "cap_warning",
  "dimension": "user",
  "value": "user_1a2b3c",
  "period": "month",
  "limit": 10,
  "spent": 8.12,
  "ratio": 0.812,
  "action": "alert"
}
```

`cap_breach` (fired when `spent ≥ limit`):
```json
{
  "event": "cap_breach",
  "dimension": "user",
  "value": "user_1a2b3c",
  "period": "month",
  "limit": 10,
  "spent": 10.40,
  "action": "alert"
}
```

Every event body also carries a `timestamp` (ISO 8601) and an internal `key` used for cross-replica dedup (the same event is suppressed for ~5 minutes). For a per-user cap, `dimension` is `"user"` and `value` is the end-user id — map that to your own user record to notify the right person.

## Gateway API keys

Gateway API keys (`ab_…`) authenticate data-plane calls and bind attribution. Each key can carry:
- **Application** — attribution for every call made with this key
- **Rate limit (RPM)** — max requests per minute; returns 429 `rate_limited` when exceeded

Create keys in **Settings → API keys**. Keys are shown **once** at creation (SHA-256 hash stored, raw key never retained).

Once all apps have keys, flip **Require API keys** on — anonymous calls to `POST /v1/chat` are then rejected.

## Admin key

`ARBR_ADMIN_KEY` gates the dashboard and all `/api/*` routes. Unset = open (local dev only).

```sh
# Generate a strong admin key
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set in `.env` before exposing the instance beyond localhost.

## Monitoring breached caps

The `/api/status` endpoint (accepted by both admin key and gateway key) reports `breachedCaps`:

```sh
curl http://localhost:4100/api/status \
  -H 'Authorization: Bearer ab_…'
# → { "breachedCaps": 1, "routingMode": "guardrail", "liveProviders": ["openai", "anthropic"], ... }
```

Use this in your monitoring system to page when caps are hit.
