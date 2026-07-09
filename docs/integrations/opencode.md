# Connect OpenCode

[OpenCode](https://opencode.ai) is a terminal-based AI coding agent. Because Arbr exposes an
OpenAI-compatible endpoint, OpenCode can send every request through Arbr — so all of your agentic
coding traffic is routed, costed, logged, and governed alongside the rest of your AI usage.

No Arbr code change is required. You add Arbr as a custom provider in OpenCode's config.

## 1. Create a gateway API key

In the Arbr dashboard, go to **Settings → API keys** and create a key bound to an application
(e.g. `opencode`). The application name is how this traffic shows up in **Overview**, **Requests**,
budgets, and per-app routing policy — so give it a name you'll recognise.

If **Require API keys** is on (the default for a deployed instance), this step is mandatory and the
key also drives attribution. Copy the key (`ab_…`) and export it:

```sh
export ARBR_API_KEY="ab_…"
```

## 2. Add Arbr as a provider in `opencode.json`

OpenCode reads `opencode.json` from your project root (or `~/.config/opencode/opencode.json` for a
global config). Register Arbr as an OpenAI-compatible provider:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "arbr": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Arbr",
      "options": {
        "baseURL": "https://your-arbr-host/v1",
        "apiKey": "{env:ARBR_API_KEY}"
      },
      "models": {
        "claude-haiku-4-5": { "name": "Claude Haiku 4.5 (via Arbr)" },
        "gpt-4o":           { "name": "GPT-4o (via Arbr)" },
        "bedrock-nova-pro": { "name": "Nova Pro (via Arbr)" }
      }
    }
  }
}
```

- `baseURL` points at your Arbr gateway with the `/v1` suffix — e.g. `http://localhost:4100/v1` for a
  local instance, or `https://your-arbr-host/v1` for a deployed one.
- `apiKey` reads the key from the environment via `{env:ARBR_API_KEY}` so it never lands in the file.
- `models` lists the models you want OpenCode to offer. Each key is an Arbr model id — see
  **Models** in the dashboard, or [Model registry](/models), for valid ids.

## 3. Select an Arbr model

Pick a model in OpenCode (the picker shows them as `arbr/<model>`), or pin one in config:

```json
{
  "model": "arbr/claude-haiku-4-5"
}
```

That's it — OpenCode now drives every request through Arbr.

## Pin a tool-capable model — don't use `auto`

::: warning Use a pass-through, tool-capable model
OpenCode is agentic: it leans heavily on **tool calls** (read file, edit, run command). Pin a model
that preserves tool calls end to end — the OpenAI-compatible providers (OpenAI / LiteLLM proxy) and
**Bedrock Nova** are reliable here.

Avoid routing OpenCode through `"auto"`. Auto-routing may land the request on a path that collapses
or drops `tool_calls`, which leaves the agent unable to act on the response. For an agent, pin a
specific tool-capable model rather than letting the classifier choose.
:::

If you want Arbr to still apply budgets and logging while keeping tool calls intact, pin an explicit
model id (as above) instead of `auto`. You keep observability and governance; OpenCode keeps its
tools.

## Give the agent enough output room

Agentic edits can be large. Arbr's default output cap is 4096 tokens
(`ARBR_DEFAULT_MAX_TOKENS`). If OpenCode responses get truncated mid-edit, either raise that on the
Arbr instance or have OpenCode send a larger `max_tokens`. See [Configuration](/configuration).

## Verify it's flowing through Arbr

Run a prompt in OpenCode, then open the Arbr dashboard:

- **Overview / Requests** — filter by application `opencode`; you should see the request with its
  served model, provider, token counts, cost, and latency.
- Click a row to open the **request drilldown** and confirm the routing decision and the
  prompt/response were captured.

If nothing shows up, check that `baseURL` ends in `/v1`, that `ARBR_API_KEY` is exported in the same
shell OpenCode runs in, and that the key is valid in **Settings → API keys**.

## Team usage — per-developer attribution

When a team shares one Arbr key, send a `X-Arbr-User-Id` header to attribute each developer's
requests separately in the dashboard. The `@ai-sdk/openai-compatible` provider supports default
headers via `options.headers`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "arbr": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Arbr",
      "options": {
        "baseURL": "https://your-arbr-host/v1",
        "apiKey": "{env:ARBR_API_KEY}",
        "headers": {
          "X-Arbr-User-Id": "{env:ARBR_USER_ID}"
        }
      }
    }
  }
}
```

Each developer exports their own identifier before launching OpenCode:

```sh
export ARBR_API_KEY="ab_…"        # shared team key
export ARBR_USER_ID="alice@company.com"   # each dev sets their own
```

After that, **Overview → Applications → opencode** shows a per-developer cost and request
breakdown with no additional key management. You can also set `X-Arbr-Department` the same
way to group by team (e.g. `"engineering"` or `"product"`).

## Related

- [OpenAI-compatible endpoint](/gateway/openai-compat) — the API OpenCode talks to
- [Routing](/routing) — how Arbr picks models, and how explicit pins override auto
- [Budgets & governance](/budgets) — caps and kill-switches that apply to OpenCode traffic too
