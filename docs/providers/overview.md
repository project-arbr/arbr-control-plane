# Providers

Arbr supports 8 providers out of the box. All use the same connection interface — one credential field (or AWS keys for Bedrock) and a default model.

## Supported providers

| Provider ID | Label | Env var | Default model |
|---|---|---|---|
| `anthropic` | Anthropic | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` |
| `openai` | OpenAI | `OPENAI_API_KEY` | `gpt-4o-mini` |
| `gemini` | Google Gemini | `GEMINI_API_KEY` | `gemini-2.5-flash` |
| `bedrock-nova` | Amazon Bedrock | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY` | `us.amazon.nova-lite-v1:0` |
| `deepseek` | DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| `moonshot` | Moonshot AI (Kimi) | `MOONSHOT_API_KEY` | `moonshot-v1-8k` |
| `xai` | xAI (Grok) | `XAI_API_KEY` | `grok-3-mini` |
| `groq` | Groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |

## Two ways to connect

**Dashboard (runtime, no restart):**
1. Open **Settings → Connections**
2. Click **Connect** next to a provider
3. Paste the key — it's stored encrypted immediately and the provider goes live

**Environment variables (takes precedence over dashboard):**
```env
# .env or your secrets manager
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
```

Both methods can be mixed — env vars override dashboard-stored keys for the same provider.

## Demo mode

If no provider keys are configured, Arbr starts in **demo mode**: every dashboard view, the recommendation engine, and routing controls work on seeded synthetic data. The live gateway path (`POST /v1/chat`) returns 503 until at least one key is added.

## Default provider

The default provider is the one used when `model: "auto"` finds no matching rule. Set it in **Settings → Connections** (runtime) or via the `DEFAULT_PROVIDER` environment variable.

## Provider pages

Each provider has its own page with the exact env var, dashboard field names, seeded models, and working examples:

- [OpenAI](/providers/openai)
- [LiteLLM Proxy](/providers/litellm)
- [Anthropic](/providers/anthropic)
- [Google Gemini](/providers/gemini)
- [Amazon Bedrock](/providers/bedrock)
- [DeepSeek](/providers/deepseek)
- [Moonshot AI](/providers/moonshot)
- [xAI (Grok)](/providers/xai)
- [Groq](/providers/groq)
