# xAI (Grok)

Provider ID: `xai`

OpenAI-compatible API. xAI's Grok models.

## Connect

::: code-group

```env [.env]
XAI_API_KEY=...
```

```
Dashboard: Models → xAI (Grok) → API Key
```

:::

## Built-in models

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `grok-3` | Grok 3 | premium | $3.00 | $15.00 |
| `grok-3-mini` | Grok 3 Mini | light | $0.30 | $0.50 |

Default model: `grok-3-mini`

## Example

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "xai",
    "model": "grok-3-mini",
    "messages": [{ "role": "user", "content": "What are the key features of a good API?" }]
  }'
```
