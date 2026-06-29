# Configuration

All configuration is via environment variables. Nothing is required to start — the app runs in demo mode with no keys.

Copy `.env.example` to `.env` and set what you need.

## Core

| Variable | Default | Description |
|---|---|---|
| `PORT` | `4100` | HTTP port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind. Use `127.0.0.1` on a bare VM behind a same-host reverse proxy. |
| `MONGO_URI` | `mongodb://localhost:27017/arbr-control-plane` | MongoDB connection string |
| `CORS_ORIGIN` | `http://localhost:5173` | Allowed origin for the Vite dev server (local dev only; ignored in single-port mode) |

## Authentication

| Variable | Default | Description |
|---|---|---|
| `ARBR_ADMIN_KEY` | — (open) | **Required in production.** Master key for the dashboard and admin API (`/api/*`). Unset = open (local dev; boot log warns). |
| `ARBR_ENCRYPTION_KEY` | dev fallback | **Required in production.** Encrypts dashboard-stored provider keys at rest. Unset = dev fallback key (boot log warns). |

Generate strong keys:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Providers

All provider keys are optional. Set at least one to enable live gateway calls.

| Variable | Provider |
|---|---|
| `OPENAI_API_KEY` | OpenAI |
| `OPENAI_BASE_URL` | OpenAI base URL override — set to your LiteLLM proxy or any OpenAI-compatible endpoint |
| `ANTHROPIC_API_KEY` | Anthropic |
| `GEMINI_API_KEY` | Google Gemini |
| `AWS_ACCESS_KEY_ID` | Amazon Bedrock |
| `AWS_SECRET_ACCESS_KEY` | Amazon Bedrock |
| `AWS_REGION` | Amazon Bedrock (default: `us-east-1`) |
| `DEEPSEEK_API_KEY` | DeepSeek |
| `MOONSHOT_API_KEY` | Moonshot AI (Kimi) |
| `XAI_API_KEY` | xAI (Grok) |
| `GROQ_API_KEY` | Groq |

Environment variables take **precedence** over dashboard-stored keys.

## Routing defaults

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_PROVIDER` | first live provider | Initial default-provider preference. Runtime-selectable in Settings → Connections (takes precedence). |
| `ARBR_DEFAULT_MAX_TOKENS` | `4096` | Completion token ceiling applied when the caller omits `max_tokens`. The gateway also clamps this value to each model's known output ceiling (e.g. 8192 for `nova-lite`), so setting a higher value is safe — it is capped per-model automatically. |

## Docker / seeding

| Variable | Default | Description |
|---|---|---|
| `SEED_ON_BOOT` | `false` | Docker only. Set to `true` to load the synthetic demo dataset on container start. **⚠️ WARNING: seeding wipes existing request records — never use in production.** |
| `WEB_PORT` | `5173` | Vite dev server port (local dev only) |

## Runtime settings

These are **not** environment variables — they're managed in the dashboard and stored in MongoDB:

- Routing mode (off / guardrail / AI)
- Require API keys toggle
- Default provider and model per provider
- Budgets (caps)
- Gateway API keys
- Routing rules
- AI routing policy
