# Budgets & governance

Budgets (caps) enforce spend limits per application, provider, team, or model. A breached cap can alert, downgrade the model, or block the request — with no code changes to any application.

## How budgets work

Each budget tracks rolling spend over a **day** or **month** window. When `spent ≥ limit`:

| Action | What happens |
|---|---|
| **Alert** | Cap appears as "breached" in the dashboard and `/api/status` — no request is affected |
| **Downgrade** | Every request in the capped scope is forced to the provider's light-tier model (overrides even developer pins) |
| **Block** | Requests in the capped scope are rejected with HTTP 429 `budget_exceeded` |

Downgrade and Block are enforced **before** routing — they outrank explicit model pins.

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
| `dimension` | `application` \| `provider` \| `department` \| `workflow` \| `model` \| (omit for global) | What to scope the cap to |
| `value` | string | The specific application/provider/… to cap |
| `period` | `day` \| `month` | Rolling window |
| `limit` | number (USD) | Spend threshold |
| `action` | `alert` \| `downgrade` \| `block` | What to do when breached |

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
