# Moonshot AI (Kimi)

Provider ID: `moonshot`

OpenAI-compatible API. Moonshot AI's Kimi models offer large context windows at low cost.

## Connect

::: code-group

```env [.env]
MOONSHOT_API_KEY=...
```

```
Dashboard: Settings → Connections → Moonshot AI (Kimi) → API Key
```

:::

## Built-in models

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `moonshot-v1-8k` | Moonshot 8K | light | $0.12 | $0.12 |
| `moonshot-v1-32k` | Moonshot 32K | mid | $0.24 | $0.24 |
| `moonshot-v1-128k` | Moonshot 128K | premium | $0.82 | $0.82 |

Default model: `moonshot-v1-8k`

## Example

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "moonshot",
    "model": "moonshot-v1-8k",
    "messages": [{ "role": "user", "content": "Write a product description for wireless earbuds." }]
  }'
```
