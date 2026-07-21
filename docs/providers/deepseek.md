# DeepSeek

Provider ID: `deepseek`

OpenAI-compatible API. Arbr routes to DeepSeek's direct API.

## Connect

::: code-group

```env [.env]
DEEPSEEK_API_KEY=...
```

```
Dashboard: Models → DeepSeek → API Key
```

:::

## Built-in models

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `deepseek-chat` | DeepSeek Chat | light | $0.27 | $1.10 |
| `deepseek-reasoner` | DeepSeek Reasoner | premium | $0.55 | $2.19 |

Default model: `deepseek-chat`

## Example

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "deepseek",
    "model": "deepseek-chat",
    "messages": [{ "role": "user", "content": "Explain REST APIs in one paragraph." }]
  }'
```
