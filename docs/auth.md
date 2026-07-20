# Accountable admin access

By default, the dashboard and admin API (everything under `/api/*`) are gated by a single shared
`ARBR_ADMIN_KEY`. That's fine for a pilot with one operator, but it has no individual identity: any
holder of the key can do anything, revoking one person means rotating the key for everyone, and
every audit log entry is attributed to the literal string `"admin"`.

`ARBR_AUTH_MODE` adds real per-user identity on top of the same gate, with three roles — **viewer**
(read-only), **operator** (day-2 actions: rotate keys, accept eval-gated recommendations, run
evals, start canaries), and **administrator** (secrets, global policy, user management). The admin
key keeps working in every mode as a break-glass credential for bootstrap and server-side
automation (`ops/deploy.sh` health checks, CI) — it's just no longer the everyday human login path.

## Choosing a mode

| `ARBR_AUTH_MODE` | Use when |
|---|---|
| `adminkey` (default) | Local dev, a demo, or a single-operator pilot. Unchanged from today. |
| `oidc` | You want arbr itself to handle login against any OIDC provider (Okta, Auth0, Google Workspace, Keycloak, ...). |
| `trusted-header` | arbr sits behind something that already authenticates the caller — GCP IAP, or an OIDC-aware reverse proxy like `oauth2-proxy` or Cloudflare Access. |

Only one mode is active at a time; pick the one that matches how your deployment is fronted.

## Bootstrapping the first administrator

There's no HTTP endpoint to create the first user — an endpoint like that would itself need to be
protected by the identity system it's bootstrapping. Instead, run this once against your deployed
Mongo instance:

```sh
node server/scripts/bootstrap-admin.js --email=you@company.com
```

It's idempotent: re-running with the same email just (re-)promotes that user and clears any
`disabledAt`. After that, sign in through whichever mode you configured and manage further users
from **Govern → Users** in the dashboard (administrator role required).

## OIDC setup

```sh
ARBR_AUTH_MODE=oidc
ARBR_OIDC_ISSUER=https://your-idp.example.com
ARBR_OIDC_CLIENT_ID=...
ARBR_OIDC_CLIENT_SECRET=...
ARBR_OIDC_REDIRECT_URI=https://arbr.your-domain.com/api/auth/callback
```

Register `ARBR_OIDC_REDIRECT_URI` as an allowed redirect URI with your provider. arbr uses the
standard authorization-code flow with PKCE; no provider-specific configuration is needed beyond
issuer discovery (`{issuer}/.well-known/openid-configuration` must be reachable from the server).

A user's first successful login auto-provisions their account with the **viewer** role — an
existing administrator must promote them before they can mutate anything. Sessions are
server-side (not stateless JWTs): disabling a user in the Users page deletes their sessions
immediately, without touching anyone else's.

**Reusing an OAuth client registered for another app?** Nothing stops it technically — each app
still does its own independent token exchange, so there's no session sharing or leakage between
them. But if that client's consent screen accepts *any* account (common when it's shared with a
public-signup product, since the consent-screen restriction is project-wide, not per-client), set
`ARBR_OIDC_ALLOWED_DOMAINS` (comma-separated) so arbr rejects anyone outside your organization
before they're ever provisioned — even as a `viewer`. Leave it unset only if the client itself is
already restricted to your organization and used by no other, more permissive app.

## GCP IAP setup

If arbr runs behind [Identity-Aware Proxy](https://cloud.google.com/iap) (Cloud Run, GCE, or a
backend service fronted by an HTTPS load balancer with IAP enabled):

```sh
ARBR_AUTH_MODE=trusted-header
ARBR_TRUSTED_HEADER_STRATEGY=iap
ARBR_IAP_AUDIENCE=/projects/PROJECT_NUMBER/global/backendServices/SERVICE_ID
```

arbr verifies the `x-goog-iap-jwt-assertion` header IAP attaches to every request against Google's
published JWKS and the configured audience, then reads the `email` claim. There's no login page —
IAP has already authenticated the caller before the request reaches arbr; a first-time caller is
auto-provisioned as a viewer, same as OIDC.

**IAP audience format** depends on how the backend is fronted — see
[Google's docs](https://cloud.google.com/iap/docs/signed-headers-howto) for the exact string for
your load balancer or Cloud Run service.

## Generic reverse-proxy setup

For any other OIDC-aware proxy in front of arbr (`oauth2-proxy`, Cloudflare Access, an internal
gateway) that can inject a verified identity header:

```sh
ARBR_AUTH_MODE=trusted-header
ARBR_TRUSTED_HEADER_STRATEGY=proxy
ARBR_PROXY_AUTH_HEADER=x-forwarded-email       # header the proxy sets to the authenticated email
ARBR_PROXY_SECRET_HEADER=x-arbr-proxy-secret   # header the proxy also sets, to a shared secret
ARBR_PROXY_AUTH_SECRET=<random secret, e.g. `openssl rand -hex 32`>
```

The shared secret exists so arbr only trusts the identity header when it actually came through your
proxy — configure the proxy to always send it, and **bind arbr to loopback / an internal network
so it can't be reached directly**, bypassing the proxy entirely. Without that network boundary, the
identity header on its own is not a security control.

## What changes for existing admin-key users

Nothing, if you stay on `ARBR_AUTH_MODE=adminkey` (the default) — every existing script, CI job, and
workflow keeps working exactly as before. Switching to `oidc` or `trusted-header` doesn't retire the
key: it remains valid as a break-glass credential (requests using it are recorded as actor
`master-key` in the audit log, never a blank identity), but the dashboard's key-entry login form is
replaced by the sign-in flow for whichever mode is configured.
