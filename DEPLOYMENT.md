# Deploying the control plane

How to run this in an organization. The model is the same as a LiteLLM proxy or a shared
MLflow tracking server: **one standalone instance per org (or per environment)** that every
application points at, with the dashboard on the same port.

```
                      https://arbr.yourco.com (TLS at the proxy)
                                   │
                  nginx / AWS ALB ─┤  443 → 127.0.0.1:4100
                                   │
   apps / SIS ── POST /v1/chat ────┤        ┌─────────────────────────┐
   (ARBR_GATEWAY_URL + ab_… key)  ├──────► │  control plane  :4100   │ ──► MongoDB
   browsers ──── dashboard /api ───┤        │  gateway + API + UI     │
   (ARBR_ADMIN_KEY login)         │        └─────────────────────────┘
```

Everything is served by **one process on one port** (`PORT`, default 4100): the gateway
(`/v1/chat`), the admin API (`/api/*`), the dashboard (`/`), and `/health`.

## Authentication model (two keys, two planes)

| Credential | Protects | Set where |
|---|---|---|
| **Gateway API keys** (`ab_…`) | The data plane — `POST /v1/chat`. Per-application; bind attribution; optional rate limit. | Dashboard → Settings → API keys |
| **Admin key** (`ARBR_ADMIN_KEY`) | The dashboard + admin API (`/api/*`) — costs, keys, routing, budgets. | Server environment |

- `ARBR_ADMIN_KEY` **unset** → the dashboard is open (local dev/demo; the boot log warns loudly).
  Never expose an instance in this state beyond localhost.
- With it set, the dashboard shows a sign-in screen; the key is sent as
  `Authorization: Bearer …` on every admin call.
- Exception by design: `GET /api/status` also accepts a valid **gateway** key, so SDK
  healthchecks (`client.status()`) work without the admin credential. `/health` is public
  (liveness only, no data).

Generate strong keys:

```sh
node -e "console.log('admin:', require('crypto').randomBytes(32).toString('hex'))"
```

## Single-VM deployment (recommended)

One small VM (EC2 t3.small class), Docker Compose 2.24.4 or newer, nginx or an ALB in front.

```sh
git clone <repo> && cd control-plane
cp .env.example .env
# In .env, set for production:
#   ARBR_ADMIN_KEY=...          (required)
#   ARBR_ENCRYPTION_KEY=...     (required — encrypts dashboard-stored provider keys)
#   SEED_ON_BOOT=false           (REQUIRED — seeding wipes request records; demo only)
#   provider keys as needed
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
curl -s localhost:4100/health    # → {"ok":true,...}
```

The production profile sets `NODE_ENV=production`, disables demo seeding, binds port 4100
to loopback, and refuses to start unless both required keys are set. It also forces gateway
API-key authentication on. After boot: sign in with the admin key → Settings → API keys →
create a key per application.

### Option A — nginx on the same VM (TLS via certbot)

Bind the app to loopback in `docker-compose.yml` (`127.0.0.1:4100:4100`), then:

```nginx
server {
    listen 443 ssl;
    server_name arbr.yourco.com;
    ssl_certificate     /etc/letsencrypt/live/arbr.yourco.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/arbr.yourco.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;   # LLM calls can be slow
    }
}
```

`certbot --nginx -d arbr.yourco.com` handles the cert. Only 443 (and 80 for the ACME
challenge) need to be open in the security group; 4100 stays loopback-only.

### Option B — AWS ALB (subdomain on your existing load balancer)

1. DNS: `arbr.yourco.com` → your ALB. Add the hostname to the ACM cert (SAN or wildcard).
2. ALB listener 443: host-header rule `arbr.yourco.com` → target group → instance:4100.
3. Security groups: ALB SG allows 443 from your network; **instance SG allows 4100 from the
   ALB SG only** — 4100 is never internet-reachable directly.
4. Optional: ALB **OIDC/Cognito authentication** on that rule gives you SSO in front of the
   dashboard at the infrastructure layer (in addition to the admin key).
5. Set `proxy_read_timeout`-equivalent: ALB idle timeout ≥ 300s for slow LLM calls.

### Option C — no exposure at all (SSM port forwarding)

For a single operator, skip public access entirely:

```sh
aws ssm start-session --target i-xxxxxxxx \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["4100"],"localPortNumber":["4100"]}'
# browse http://localhost:4100
```

No security-group changes, nothing public.

### Apps on the same VPC

Point applications at the **internal** address (`http://10.x.x.x:4100` or private DNS), not
the public URL — gateway traffic stays off the internet and off your ALB bill. Only humans
need the public hostname.

## Production checklist

- [ ] `ARBR_ADMIN_KEY` set (dashboard/admin API locked)
- [ ] `ARBR_ENCRYPTION_KEY` set (dashboard-stored provider keys encrypted with your secret)
- [ ] `SEED_ON_BOOT=false` (seeding **wipes request records** — demo only)
- [ ] Started with `docker-compose.prod.yml` (fail-closed mode; gateway keys forced on)
- [ ] Gateway API keys issued per application
- [ ] TLS at the proxy (Option A/B); 4100 not directly internet-reachable
- [ ] MongoDB not publicly bound (compose default is fine — no host port); backups scheduled
  (`mongodump` cron or a managed Mongo/Atlas)
- [ ] Provider keys via environment/secret manager (env takes precedence over dashboard-stored)
- [ ] Budgets configured with **Block/Downgrade** actions for cost protection

## Operational notes & limits

- **Single instance by design (today).** The response cache, per-key rate-limit windows, and
  rule/policy caches are in-process. Two instances behind a load balancer will each keep their
  own; budgets/keys/rules are Mongo-backed and shared, but enforcement counters and cache hits
  aren't. Scale vertically first; Redis-backed state is the documented future path.
- **Restarts are cheap**: all durable state is in MongoDB. `docker compose restart app` (or
  redeploy the image) loses only the in-memory caches.
- **Upgrades**: `git pull && docker compose build app && docker compose up -d app`.
- **Logs**: stdout (`docker compose logs -f app`); the boot banner prints port, mode
  (demo/live), and whether admin auth is on.
- **Status endpoint** (`/api/status`): use a gateway key from your monitoring system to watch
  `breachedCaps`, `routingMode`, and provider liveness.
