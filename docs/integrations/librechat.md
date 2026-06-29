# Connect LibreChat

[LibreChat](https://www.librechat.ai) is a self-hosted, multi-model chat UI. Because Arbr exposes an
OpenAI-compatible endpoint, you can add Arbr as a **custom endpoint** in LibreChat — every message
your users send is then routed, costed, logged, and governed by Arbr, with no change to LibreChat
itself.

No Arbr code change is required. You add Arbr as a custom endpoint in `librechat.yaml`.

## 1. Create a gateway API key

In the Arbr dashboard, go to **Settings → API keys** and create a key bound to an application
(e.g. `librechat`). The application name is how this traffic shows up in **Overview**, **Requests**,
budgets, and per-app routing policy.

If **Require API keys** is on (the default for a deployed instance), this step is mandatory and the
key also drives attribution. Put the key in LibreChat's `.env`:

```sh
# LibreChat .env
ARBR_API_KEY=ab_…
```

## 2. Add Arbr as a custom endpoint

Edit `librechat.yaml` and add Arbr under `endpoints.custom`:

```yaml
version: 1.2.1
cache: true

endpoints:
  custom:
    - name: "Arbr"
      apiKey: "${ARBR_API_KEY}"
      baseURL: "https://your-arbr-host/v1"
      models:
        default:
          - "claude-haiku-4-5"
          - "gpt-4o"
          - "gemini-2.5-flash"
        fetch: false
      titleConvo: true
      titleModel: "claude-haiku-4-5"
      modelDisplayLabel: "Arbr"
```

- `baseURL` points at your Arbr gateway with the `/v1` suffix — e.g. `http://localhost:4100/v1` for a
  local instance, or `https://your-arbr-host/v1` for a deployed one.
- `apiKey` reads the key from LibreChat's environment via `${ARBR_API_KEY}`.
- `models.default` lists the models the picker offers. Each entry is an Arbr model id — see
  **Models** in the dashboard, or [Model registry](/models), for valid ids.
- Set `models.fetch: true` instead of a `default` list to have LibreChat pull the live model list
  from Arbr's `/v1/models` endpoint automatically.

Restart LibreChat. **Arbr** now appears as an endpoint in the model selector.

::: tip Running both in Docker
If LibreChat runs in a container and Arbr runs on the host, `localhost` won't resolve from inside the
container — use `http://host.docker.internal:4100/v1`. If both run in the same Docker network, use the
Arbr service name, e.g. `http://arbr:4100/v1`.
:::

## Auto-routing works well here

Unlike an agentic coding tool, LibreChat is plain chat — so you can lean on Arbr's routing. Add
`auto` (or any model you've set up routing for) to the model list and let Arbr classify each message
and pick the cheapest model that fits:

```yaml
      models:
        default:
          - "auto"
          - "claude-haiku-4-5"
          - "gpt-4o"
```

Users pick **auto**; Arbr decides the served model per message. The decision shows up per request in
the dashboard. See [Routing](/routing) for how classification and the AI policy choose.

## Avoid truncated replies

LibreChat sends a `max_tokens` derived from the selected model's config. If it sends a small value,
replies get cut off mid-sentence. Two things to check:

- Arbr's default output cap is 4096 tokens (`ARBR_DEFAULT_MAX_TOKENS`) — raise it on the Arbr instance
  if your chats need longer answers. See [Configuration](/configuration).
- In LibreChat, set a sensible `maxOutputTokens` for the endpoint/model so it doesn't request a tiny
  ceiling.

## Verify it's flowing through Arbr

Send a message in LibreChat, then open the Arbr dashboard:

- **Overview / Requests** — filter by application `librechat`; you should see the message with its
  served model, provider, token counts, cost, and latency.
- Click a row to open the **request drilldown** and confirm the routing decision and the
  prompt/response were captured.

If the endpoint doesn't appear or calls fail, check that `baseURL` ends in `/v1`, that `ARBR_API_KEY`
is set in LibreChat's `.env`, and that the key is valid in **Settings → API keys**.

## Related

- [OpenAI-compatible endpoint](/gateway/openai-compat) — the API LibreChat talks to
- [Connect OpenCode](/integrations/opencode) — the same pattern for a terminal coding agent
- [Routing](/routing) — how Arbr picks models, and how `auto` classification works
- [Budgets & governance](/budgets) — caps and kill-switches that apply to LibreChat traffic too
