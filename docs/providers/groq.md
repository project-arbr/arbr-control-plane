# Groq

Provider ID: `groq`

Groq provides extremely fast inference for open-source models using its LPU hardware.

## Connect

::: code-group

```env [.env]
GROQ_API_KEY=...
```

```
Dashboard: Models → Groq → API Key
```

:::

## Built-in models

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `llama-3.3-70b-versatile` | Llama 3.3 70B (Groq) | mid | $0.59 | $0.79 |
| `llama-3.1-8b-instant` | Llama 3.1 8B (Groq) | light | $0.05 | $0.08 |

Default model: `llama-3.3-70b-versatile`

## Example

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "groq",
    "model": "llama-3.1-8b-instant",
    "messages": "What is the capital of France?"
  }'
```

## Notes

- `llama-3.1-8b-instant` is one of the fastest and cheapest available models — ideal as a light-tier target in cost guardrail configurations
- Groq's API is OpenAI-compatible; Arbr routes to `https://api.groq.com/openai/v1` automatically
