# Amazon Bedrock

Provider ID: `bedrock-nova`

Uses AWS credentials (access key + secret, or IAM role). Routes through the Bedrock Converse API and supports both Amazon Nova models and cross-inference third-party models available on Bedrock.

## Connect

::: code-group

```env [.env]
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1   # optional, defaults to us-east-1
```

```
Dashboard: Settings → Connections → Amazon Bedrock → Access Key ID + Secret Key
```

:::

The IAM user or role needs `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` permissions.

## Built-in models

### Amazon Nova

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `us.amazon.nova-pro-v1:0` | Nova Pro | mid | $0.80 | $3.20 |
| `us.amazon.nova-lite-v1:0` | Nova Lite | light | $0.06 | $0.24 |
| `us.amazon.nova-micro-v1:0` | Nova Micro | light | $0.035 | $0.14 |

### Cross-inference (third-party models on Bedrock)

| Model ID | Label | Tier | Input $/1M | Output $/1M |
|---|---|---|---|---|
| `zai.glm-5` | GLM-5 | mid | $1.00 | $3.20 |
| `moonshotai.kimi-k2.5` | Kimi K2.5 | mid | $0.60 | $3.00 |
| `qwen.qwen3-next-80b-a3b-instruct` | Qwen3 Next | light | $0.50 | $1.20 |
| `deepseek.v3.2` | DeepSeek V3.2 | light | $0.62 | $1.85 |
| `us.deepseek.r1-v1:0` | DeepSeek R1 | premium | $1.35 | $5.40 |
| `google.gemma-3-12b-it` | Gemma 3 12B | light | $0.09 | $0.29 |
| `anthropic.claude-3-5-sonnet-20241022-v2:0` | Claude 3.5 Sonnet (Bedrock) | premium | $3.00 | $15.00 |
| `meta.llama3-70b-instruct-v1:0` | Llama 3 70B | mid | $0.99 | $0.99 |
| `meta.llama3-8b-instruct-v1:0` | Llama 3 8B | light | $0.22 | $0.22 |

Default model: `us.amazon.nova-lite-v1:0`

## Example

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "bedrock-nova",
    "model": "us.amazon.nova-lite-v1:0",
    "messages": "Summarise the following meeting notes in 3 bullet points: ..."
  }'
```

## Via LiteLLM

If you prefer to route Bedrock calls through LiteLLM (e.g. for credential management or model aliasing), configure the `openai` provider to point at LiteLLM and use Bedrock model strings:

```env
OPENAI_BASE_URL=http://localhost:8000
OPENAI_API_KEY=your-litellm-master-key
```

```sh
curl -X POST http://localhost:4100/v1/chat \
  -d '{ "provider": "openai", "model": "bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0", "messages": "Hi" }'
```

See [OpenAI / LiteLLM proxy](/providers/openai) and [Streaming](/gateway/streaming) for the full chain guide.
