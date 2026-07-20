# Observe-only ingestion

`POST /v1/ingest` reports metadata for calls that already happened elsewhere — a
partner's own OpenAI-compatible gateway, a LiteLLM deployment, or any other
in-house proxy — without moving that traffic through Arbr's gateway. No live
provider call happens; Arbr only records what already occurred, so this is a
zero-risk way to get cost visibility, budgets, and recommendations from
existing production traffic before switching a base URL.

## Request

```
POST /v1/ingest
Authorization: Bearer <gateway API key>
Content-Type: application/json
```

```json
{
  "events": [
    {
      "requestId": "partner-abc-123",
      "timestamp": "2026-07-20T18:04:00Z",
      "application": "support-bot",
      "provider": "openai",
      "model": "gpt-4o-mini",
      "modelRequested": "gpt-4o",
      "taskType": "support response",
      "promptTokens": 120,
      "completionTokens": 40,
      "latencyMs": 830,
      "status": "success"
    }
  ]
}
```

Only `requestId` and `model` are required per event; every other field is
optional. `messages` and `responseText` may be included but are never
required — see [Data privacy and retention](/privacy) for how payload
capture is gated. Up to 500 events per call.

Cost is always derived server-side from `model` + token counts using Arbr's
own pricing table — a caller-supplied cost is never trusted, matching how
live gateway traffic is priced. An unrecognized `model` is still recorded,
with `knownPricing:false` and $0 cost, the same as a live request to a model
Arbr doesn't have pricing for.

## Response

```json
{ "accepted": ["partner-abc-123"], "duplicates": [], "rejected": [] }
```

Each event resolves independently into `accepted`, `duplicates`, or
`rejected` — one malformed event in a batch doesn't fail the rest.
`rejected` entries include the reason: `{ "requestId": "...", "error": "..." }`.

## Idempotency

Dedup is scoped per API key and keyed on the caller's `requestId` — re-posting
the same `requestId` on the same key is reported as a `duplicate` and never
creates a second record or double-counts spend. Two different keys may reuse
the same `requestId` value without colliding.

## Visibility and budgets

Ingested requests are tagged `source: "ingested"` and are visible by default
alongside gateway-routed traffic in analytics and `GET /api/requests` — this
is deliberately different from Arbr's own internal overhead traffic, which is
excluded by default. Filter with `?source=ingested` or `?source=gateway`, or
use the source filter on the Requests page. Ingested spend counts toward
budget caps exactly like live gateway spend; only enforcement (blocking or
downgrading) never applies here, since the call already happened.

## LiteLLM callback example

LiteLLM supports custom Python callbacks that fire after each request with
usage and cost data. Map its fields to the shape above and POST on success:

```python
import time
import requests
from litellm.integrations.custom_logger import CustomLogger

class ArbrIngestLogger(CustomLogger):
    def log_success_event(self, kwargs, response_obj, start_time, end_time):
        usage = response_obj.get("usage", {})
        requests.post(
            "https://your-arbr-host/v1/ingest",
            headers={"Authorization": "Bearer <gateway API key>"},
            json={"events": [{
                "requestId": kwargs.get("litellm_call_id"),
                "timestamp": kwargs.get("start_time"),
                "application": kwargs.get("metadata", {}).get("application"),
                "model": kwargs.get("model"),
                "promptTokens": usage.get("prompt_tokens", 0),
                "completionTokens": usage.get("completion_tokens", 0),
                "latencyMs": int((end_time - start_time) * 1000),
                "status": "success",
            }]},
            timeout=5,
        )

import litellm
litellm.callbacks = [ArbrIngestLogger()]
```
