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
| `NODE_ENV` | unset | Standard Node env var, but significant here: set to `production` to run `assertProductionReady()` at boot (refuses to start without `ARBR_ADMIN_KEY`/`ARBR_ENCRYPTION_KEY`, and without required OIDC/trusted-header vars if `ARBR_AUTH_MODE` needs them), force `requireApiKey` on, tighten privacy defaults, and enable secure cookies. Leave unset for local dev/demo. |

## Authentication

| Variable | Default | Description |
|---|---|---|
| `ARBR_ADMIN_KEY` | — (open) | **Required in production.** Master key for the dashboard and admin API (`/api/*`). Unset = open (local dev; boot log warns). Stays valid as a break-glass credential in every `ARBR_AUTH_MODE` below. |
| `ARBR_ENCRYPTION_KEY` | dev fallback | **Required in production.** Encrypts dashboard-stored provider keys at rest. Unset = dev fallback key (boot log warns). |
| `ARBR_AUTH_MODE` | `adminkey` | `adminkey` (shared secret, above) \| `oidc` \| `trusted-header` — adds real per-user identity (roles, a Users page, per-user audit attribution). See [Accountable admin access](/auth) for the full OIDC/IAP/reverse-proxy env vars and setup. |
| `ARBR_ADMIN_RPM_GUARDRAIL` | `600` | Per-source-IP requests/minute cap on the admin API (`/api/*`). The admin API shares one credential, so this limits by IP instead of by key — a blunt guard against accidental hammering or a leaked key, not a normal-use throttle. |
| `ARBR_SESSION_TTL_HOURS` | `12` | Session lifetime for per-user identity (OIDC / trusted-header) logins. |

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
| `LITELLM_BASE_URL` | LiteLLM Proxy — set to register the `litellm` provider. Absent from the connections list entirely when unset. |
| `LITELLM_API_KEY` | LiteLLM Proxy auth |
| `LITELLM_DEFAULT_MODEL` | LiteLLM Proxy — default model for the provider |

Environment variables take **precedence** over dashboard-stored keys.

## Routing defaults

| Variable | Default | Description |
|---|---|---|
| `DEFAULT_PROVIDER` | first live provider | Initial default-provider preference. Runtime-selectable in Settings → General → Default gateway (takes precedence). |
| `ARBR_DEFAULT_MAX_TOKENS` | `4096` | Completion token ceiling applied when the caller omits `max_tokens`. The gateway also clamps this value to each model's known output ceiling (e.g. 8192 for `nova-lite`), so setting a higher value is safe — it is capped per-model automatically. |
| `ARBR_FALLBACK_SCOPE` | `same-provider` | Retry scope when a provider call fails: `same-provider` (retry the provider's own default model only), `cross-provider` (walk every other live provider's default model), or `none` (no automatic fallback). |

## Docker / seeding

| Variable | Default | Description |
|---|---|---|
| `SEED_ON_BOOT` | `true` in the default/demo `docker-compose.yml` profile | Docker only. Set to `true` to load the synthetic demo dataset on container start. Production-oriented overlays (`docker-compose.prod.yml`, the GCP overlay) force this to `false`. **⚠️ WARNING: seeding wipes existing request records — never use in production.** |
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

Production instances start with payload capture disabled, PII masking enabled, and 30-day
retention. See [Data privacy and retention](./privacy.md) before enabling prompt/response capture.
