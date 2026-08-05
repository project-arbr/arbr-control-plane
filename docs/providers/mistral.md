# Mistral AI

Provider ID: `mistral`

OpenAI-compatible API. Arbr routes to Mistral's direct API, transparently proxying
requests so tools, streaming, and `response_format` pass through unchanged.

## Connect

::: code-group

```env [.env]
MISTRAL_API_KEY=...
```

```
Dashboard: Models → Mistral AI → API Key
```

:::

## Built-in models

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `mistral-medium-latest` | Mistral Medium | mid | $1.50 | $7.50 |
| `mistral-large-latest` | Mistral Large 3 | mid | $0.50 | $1.50 |
| `mistral-small-latest` | Mistral Small | light | $0.15 | $0.60 |

Default model: `mistral-small-latest`

## Example

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "mistral",
    "model": "mistral-small-latest",
    "messages": [{ "role": "user", "content": "Explain REST APIs in one paragraph." }]
  }'
```

## Notes

- Mistral's API is OpenAI-compatible; Arbr routes to `https://api.mistral.ai/v1`
  automatically, so tools, streaming, and `response_format` are proxied raw
- On an existing install, Mistral models only enter the registry once you run
  **Sync Models** (Models page). Until then calls still route fine, but they log at
  `$0` — cost tracking needs a registry entry
- **Known pricing drift:** LiteLLM's catalog still prices `mistral-small-latest` as
  Mistral Small 3.2 ($0.06 / $0.18), but the alias now resolves to Small 4 at
  $0.15 / $0.60. After a sync the dashboard will under-report Mistral Small spend by
  ~3×. Sync overwrites pricing on every run, so correcting the entry by hand does not
  stick — the values above are the accurate ones until the upstream catalog catches up
