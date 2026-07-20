# Anthropic

Provider ID: `anthropic`

## Connect

::: code-group

```env [.env]
ANTHROPIC_API_KEY=sk-ant-...
```

```
Dashboard: Models → Anthropic → API Key
```

:::

## Built-in models

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `claude-opus-4-8` | Claude Opus 4.8 | premium | $5.00 | $25.00 |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | mid | $3.00 | $15.00 |
| `claude-haiku-4-5` | Claude Haiku 4.5 | light | $1.00 | $5.00 |

Default model: `claude-haiku-4-5`

## Example

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "anthropic",
    "model": "claude-haiku-4-5",
    "messages": [
      { "role": "system", "content": "You are a helpful assistant." },
      { "role": "user", "content": "What is 2 + 2?" }
    ]
  }'
```

## Notes

- **Opus 4.8** rejects `temperature` and sampling parameters — Arbr detects this automatically and omits them for compatible model IDs
- Claude models on Anthropic and on Bedrock have separate entries — `claude-haiku-4-5` goes to the Anthropic API; `anthropic.claude-3-5-sonnet-20241022-v2:0` goes to Bedrock
