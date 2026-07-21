# Deploy on GCP

Deploy the Arbr control plane on a single Google Cloud VM — dashboard, gateway, and admin API on one port behind nginx with TLS.

## Step 1 — Create the VM

**Compute Engine → VM Instances → Create Instance**

| Setting | Value |
|---|---|
| Machine type | `e2-medium` (2 vCPU, 4 GB RAM) minimum |
| OS | Ubuntu 22.04 LTS |
| Boot disk | 20 GB SSD |
| Firewall | ✅ Allow HTTP traffic, ✅ Allow HTTPS traffic |

Note the **External IP** — you'll point your domain's DNS A record here.

## Step 2 — SSH into the VM

```sh
gcloud compute ssh YOUR_INSTANCE_NAME --zone YOUR_ZONE
```

## Step 3 — Install Docker

```sh
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker
docker compose version   # must be v2.24.4 or newer
```

## Step 4 — Install nginx + certbot

```sh
sudo apt install -y nginx certbot python3-certbot-nginx
```

## Step 5 — Clone the repo and configure

```sh
git clone https://github.com/project-arbr/arbr-control-plane.git
cd arbr-control-plane
cp .env.example .env
nano .env
```

Set these values before starting the production profile:

```sh
# Generate each key by running this command twice (use a different value for each):
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

```env
ARBR_ADMIN_KEY=<first generated key>
ARBR_ENCRYPTION_KEY=<second generated key>
SEED_ON_BOOT=false
OPENAI_API_KEY=sk-...    # or any other provider key
```

::: tip No provider key yet?
Leave provider keys blank — the server starts in demo mode with seeded data so you can explore the dashboard before adding real keys.
:::

## Step 6 — Start the control plane

`docker-compose.gcp.yml` is gitignored (it's VM/environment-specific) and isn't part of the
clone — create it once:

```sh
cat > docker-compose.gcp.yml <<'EOF'
# GCP override — keeps the app bound to 0.0.0.0:4100 so a GCP load balancer's Google Front
# End can reach it (a VPC firewall restricting :4100 to Google's LB/health-check ranges is
# the real security boundary here, not loopback binding). Also disables demo seeding.
services:
  app:
    environment:
      SEED_ON_BOOT: "false"
EOF
```

```sh
docker compose -f docker-compose.yml -f docker-compose.gcp.yml up -d
curl http://localhost:4100/health   # → {"ok":true,"demoMode":false}
```

Use the `docker-compose.gcp.yml` overlay here, not `docker-compose.prod.yml` — it's what
`ops/deploy.sh` uses for every deploy after this one, so starting with it now avoids the app's
port binding silently changing on the first automated deploy.

Unlike `docker-compose.prod.yml` (which binds port 4100 to loopback), `docker-compose.gcp.yml`
deliberately keeps the base `0.0.0.0:4100` binding. On this topology the real security boundary
is the VPC firewall — ingress on `:4100` restricted to Google's load-balancer/health-check IP
ranges (`130.211.0.0/22`, `35.191.0.0/16`) — not loopback binding, so `0.0.0.0` here is
intentional, not a regression. It still sets `NODE_ENV=production`, which makes ARBR refuse to
start without the admin and encryption keys and forces gateway API-key authentication on.

## Step 7 — Configure nginx

Point your domain's DNS A record at the VM's external IP before running certbot.

```sh
sudo nano /etc/nginx/sites-available/arbr
```

Paste the following (replace `arbr.yourco.com` with your domain):

```nginx
server {
    listen 80;
    server_name arbr.yourco.com;

    # All traffic → control plane
    location / {
        proxy_pass http://127.0.0.1:4100;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
    }

    # SSE streaming — disable nginx buffering for the completions endpoint
    location /v1/chat/completions {
        proxy_pass http://127.0.0.1:4100;
        proxy_http_version 1.1;
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
        chunked_transfer_encoding on;
    }
}
```

```sh
sudo ln -s /etc/nginx/sites-available/arbr /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

## Step 8 — Enable HTTPS

```sh
sudo certbot --nginx -d arbr.yourco.com
```

Certbot edits the nginx config and sets up auto-renewal. Your dashboard is now at **https://arbr.yourco.com**.

## Step 9 — Block port 4100 from the internet

In GCP Console → **VPC Network → Firewall rules** — confirm there is **no rule** allowing ingress on port `4100` from `0.0.0.0/0`. Only ports `80` and `443` should be publicly reachable.

## Step 10 — First login and setup

1. Open **https://arbr.yourco.com** — the login screen appears
2. Enter your `ARBR_ADMIN_KEY` value
3. **Models** page — add at least one provider key
4. **Settings → API Keys** — create a gateway key per developer app; the one-time reveal shows a ready-to-paste snippet for each developer
5. Toggle **Require API Keys** ON once every app has a key — note this may already be on:
   `NODE_ENV=production` (set by the Step 6 compose overlay) forces `requireApiKey` on at boot,
   so depending on when you check, this toggle can read as already-enabled rather than something
   you're switching on here.

## Ongoing operations

```sh
# View live logs
docker compose logs -f app

# Restart the app container
docker compose restart app

# Backup MongoDB
docker compose exec mongo mongodump --out /tmp/backup
docker cp $(docker compose ps -q mongo):/tmp/backup ./backup-$(date +%F)
```

## Deploying a new version (gated, image-based)

Deploys are **manually triggered** but gated and rollback-safe. CI builds and pushes a
`ghcr.io/project-arbr/arbr-control-plane:sha-<short>` (and `:main`) image **only after** the
full test/lint/build suite passes on `main` — so an image existing for a commit means it's
green. `ops/deploy.sh` pulls that prebuilt image (no build on the prod host), health-checks,
and auto-rolls-back on failure.

```sh
cd ~/arbr-ai-control-plane
bash ops/deploy.sh            # deploy the latest green main
bash ops/deploy.sh sha-1a2b3c4   # or pin to a specific commit / a vX.Y.Z tag
```

What it does: verifies the image exists (the green gate) → records the current tag →
pulls + `up -d` the new image → polls `/health` for ~60s → **rolls back to the previous tag
if unhealthy** → posts a success/rollback note to the governance webhook.

The script also carries a legacy conditional re-sync keyed on a `modelSeedVersion` field that's
no longer written by the registry (see [Model registry](/models) for the real LiteLLM-sync
mechanism), so in practice it won't fire. Treat catalog refresh as a manual step today — run it
from the dashboard's **Sync Models** button (Models page) after a deploy if you need current
pricing, rather than relying on the deploy script for it.

> The old build-on-VM path (`git pull && docker compose build app && up -d app`) is
> deprecated — it built on the prod host and had no rollback. Use `ops/deploy.sh`.
>
> Note: this still causes a brief container-recreate blip (no blue-green yet), and it is not
> auto-triggered on merge — a human runs the command.

## Production checklist

- [ ] `ARBR_ADMIN_KEY` set
- [ ] `ARBR_ENCRYPTION_KEY` set
- [ ] `SEED_ON_BOOT=false`
- [ ] Port 4100 not in any public GCP firewall rule
- [ ] TLS certificate issued by certbot
- [ ] At least one provider key configured
- [ ] Started with `docker-compose.gcp.yml` (fail-closed mode; gateway keys forced on; matches what `ops/deploy.sh` uses)
- [ ] Gateway API keys created per app
- [ ] MongoDB volume is on a persistent disk (default in Docker Compose)
- [ ] `docker compose logs` checked for any boot errors
