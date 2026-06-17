# Deployment

One standalone instance per organisation — the same model as a LiteLLM proxy or shared MLflow tracking server. A single VM with Docker Compose; TLS terminated by nginx or an ALB.

## Architecture

```
                  https://arbr.yourco.com (TLS at the proxy)
                                 │
              nginx / AWS ALB ───┤  443 → 127.0.0.1:4100
                                 │
apps ─── POST /v1/chat ──────────┤        ┌────────────────────────┐
(ARBR_GATEWAY_URL + ab_… key)   ├──────► │  Arbr Control Plane    │ ──► MongoDB
browsers ── dashboard ───────────┤  :4100  │  gateway + API + UI    │
(ARBR_ADMIN_KEY login)          │        └────────────────────────┘
```

Everything on **one port** (default 4100): the gateway (`/v1/chat`), the admin API (`/api/*`), the dashboard (`/`), and `/health`.

## Authentication model

| Credential | Protects | Where |
|---|---|---|
| **Gateway API keys** (`ab_…`) | `POST /v1/chat*` — data plane | Dashboard → Settings → API keys |
| **Admin key** (`ARBR_ADMIN_KEY`) | Dashboard + `/api/*` — control plane | Server environment |

- Unset `ARBR_ADMIN_KEY` → open dashboard (local dev only; boot log warns)
- With it set → login screen; key sent as `Authorization: Bearer` on every admin call
- `GET /api/status` also accepts a gateway key (healthchecks work without admin credential)
- `GET /health` is public (liveness only)

## Single-VM deployment (recommended)

```sh
git clone https://github.com/gyde-ai/arbr
cd arbr/control-plane
cp .env.example .env
# Set in .env:
#   ARBR_ADMIN_KEY=<generate with the command below>
#   ARBR_ENCRYPTION_KEY=<generate>
#   SEED_ON_BOOT=false          ← REQUIRED in production
#   OPENAI_API_KEY=sk-...       ← at least one provider key
docker compose up -d
curl -s localhost:4100/health   # → {"ok":true}
```

Generate strong keys:
```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

After boot: sign in → Settings → API keys → create a key per app → flip **Require API keys** on.

## nginx (TLS via certbot)

Bind the app to loopback in `docker-compose.yml` (`127.0.0.1:4100:4100`), then:

```nginx
server {
    listen 443 ssl;
    server_name arbr.yourco.com;
    ssl_certificate     /etc/letsencrypt/live/arbr.yourco.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/arbr.yourco.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;    # LLM calls can be slow
    }

    # SSE streaming — disable nginx buffering for the completions endpoint
    location /v1/chat/completions {
        proxy_pass http://127.0.0.1:4100;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        chunked_transfer_encoding on;
    }
}
```

`certbot --nginx -d arbr.yourco.com` handles the cert. Only 443 (and 80 for ACME) needs to be open.

## AWS ALB

1. DNS: `arbr.yourco.com` → ALB. Add hostname to ACM cert.
2. ALB listener 443: host-header rule `arbr.yourco.com` → target group → instance:4100.
3. Security groups: ALB SG allows 443; **instance SG allows 4100 from ALB SG only** — 4100 is never internet-reachable directly.
4. ALB idle timeout ≥ 300s (for slow LLM calls and SSE streams).

## Apps on the same VPC

Point apps at the **internal** address (`http://10.x.x.x:4100`) — gateway traffic stays off the internet. Only humans need the public hostname.

## Production checklist

- [ ] `ARBR_ADMIN_KEY` set (dashboard/admin API locked)
- [ ] `ARBR_ENCRYPTION_KEY` set (dashboard-stored provider keys encrypted)
- [ ] `SEED_ON_BOOT=false` (seeding **wipes request records** — demo only)
- [ ] Gateway API keys issued per application; **Require API keys** flipped ON
- [ ] TLS at the proxy; port 4100 not internet-reachable directly
- [ ] MongoDB not publicly bound; backups scheduled (`mongodump` cron or Atlas)
- [ ] Provider keys via environment / secret manager (env takes precedence over dashboard-stored)
- [ ] Budgets configured with **Block/Downgrade** actions for cost protection

## Operational notes

- **Single instance by design (today).** The response cache, per-key rate-limit windows, and caches are in-process. Two instances behind an ALB each keep their own (budgets/keys/rules are Mongo-backed and shared; enforcement counters aren't). Scale vertically first.
- **Restarts are cheap** — all durable state is in MongoDB. `docker compose restart` loses only in-memory caches.
- **Upgrades:** `git pull && docker compose build app && docker compose up -d app`
- **Logs:** `docker compose logs -f app`
- **Status monitoring:** use a gateway key to watch `breachedCaps` and provider liveness at `/api/status`
