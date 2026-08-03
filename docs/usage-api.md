# Scoped usage API (read tokens)

Lets a partner app — or an end user directly — read **only their own** usage, without
the admin key and without proxying through a backend. A **read token** is a
scoped, read-only credential: it can read one application's (and optionally one
user's) analytics, and nothing else. It cannot run inference.

## Create a read token

In the console: **Settings → API keys → Type: "Read token (usage only)"**, set the
Application (and optionally a User ID) it is scoped to. The full token is shown once,
prefixed `ab_read_…`.

Via the admin API:

```sh
curl -X POST $ARBR/api/keys \
  -H "Authorization: Bearer $ARBR_ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{ "kind": "read", "name": "alice usage", "application": "acme", "userId": "alice@co" }'
# → { ..., "kind": "read", "key": "ab_read_…" }   (key shown ONCE)
```

Omit `userId` for an application-wide read token.

## Read usage

Authenticate with the read token. The scope is **fixed by the token** — query params
cannot widen it.

```sh
curl https://models.example.com/v1/usage/overview \
  -H "Authorization: Bearer ab_read_…"
```

| Endpoint | Returns |
|---|---|
| `GET /v1/usage/overview` | Headline stats for the scope: total cost, requests, tokens, success rate, cache hit rate. |
| `GET /v1/usage/timeseries?bucket=day` | Cost / request trend. `bucket` ∈ `hour` \| `day` \| `month`. |
| `GET /v1/usage/by-model` | Spend and usage broken down by model. |
| `GET /v1/usage/scope` | The token's own `{ application, userId }`. |

The numbers are the same aggregation the console shows (`analytics/aggregate.js`),
restricted to the token's scope and to customer traffic (Arbr's own internal
overhead is excluded).

## Guarantees

- A read token on the data plane (`/v1/chat`, `/v1/chat/completions`) is rejected
  `401 read_token_on_data_plane` — it can never serve a completion.
- A gateway key on `/v1/usage/*` is rejected `401 invalid_read_token`.
- The scope is server-forced; passing `?application=…&userId=…` does not change what a
  token can see.
- Revoke or rotate a read token exactly like a gateway key (Settings → API keys).

## Embeddable usage chart

Drop a live per-user usage chart into your own app with an `<iframe>` — no rebuild,
no admin key:

```html
<iframe src="https://models.example.com/embed/usage#token=ab_read_…&metric=cost&bucket=day"
        style="width:100%;height:220px;border:0"></iframe>
```

- The read token goes in the URL **fragment** (`#token=…`), which the browser never
  sends to the server or leaks via `Referer` — so it stays out of access logs.
- The page is served by Arbr and fetches `/v1/usage/*` **same-origin**, so there is no
  CORS setup. It renders an inline SVG (no external scripts), scoped to the token.
- Options in the fragment: `metric` (`cost` | `requests`), `bucket`
  (`hour` | `day` | `month`).

Because a read token only ever exposes its own scope, embedding one is as safe as the
token itself.
