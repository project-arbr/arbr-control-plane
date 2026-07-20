# Google Gemini

Provider ID: `gemini`

## Connect

::: code-group

```env [.env]
GEMINI_API_KEY=...
```

```
Dashboard: Settings → Connections → Google Gemini → API Key
```

:::

Get your key at [aistudio.google.com](https://aistudio.google.com).

## Built-in models

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `gemini-2.5-pro` | Gemini 2.5 Pro | premium | $1.25 | $10.00 |
| `gemini-2.5-flash` | Gemini 2.5 Flash | light | $0.30 | $2.50 |
| `gemini-2.5-flash-lite` | Gemini 2.5 Flash Lite | light | $0.10 | $0.40 |

Default model: `gemini-2.5-flash`

## Example

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "gemini",
    "model": "gemini-2.5-flash",
    "messages": [{ "role": "user", "content": "Translate to French: The database is down." }]
  }'
```

## Notes

- `gemini-2.5-flash` is a strong cost-effective default for most tasks
- The thinking variant (`gemini-2.5-flash:thinking`) can cause JSON generation to fail — prefer `gpt-4o-mini` or similar when using Arbr's AI routing policy generation
