# Cloud secret-manager integration

Environment variables and encrypted-MongoDB credentials work well for a pilot, but a partner's
production environment commonly requires a managed secret store with rotation — no secret value
ever committed to a `.env` file, and no restart needed when a key is rotated.

Any credential-shaped environment variable — a provider API key (`OPENAI_API_KEY`,
`ANTHROPIC_API_KEY`, ...), `ARBR_ADMIN_KEY`, or `ARBR_ENCRYPTION_KEY` — can hold either a literal
value (today's behavior, unchanged) or a reference to a secret in a managed store, resolved
transparently at boot and on a periodic refresh. There's no new UI and no migration: an existing
deployment using literal values keeps working exactly as it does today.

## GCP Secret Manager

The one fully-working adapter today. It matches Arbr's own production target — `arbr.gyde.ai`
runs on a GCE VM — and gets free authentication via the VM's attached service account
(Application Default Credentials), no extra credential configuration.

**1. Grant access.** The runtime service account needs read access to each secret it will
resolve:

```sh
gcloud secrets add-iam-policy-binding openai-key \
  --member="serviceAccount:YOUR-VM-SERVICE-ACCOUNT@PROJECT.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"
```

**2. Point the env var at the secret**, using GCP's own resource-name syntax prefixed with
`gcp-sm://` — copy-pasteable straight from the GCP Console's "Copy resource name" action:

```sh
OPENAI_API_KEY=gcp-sm://projects/123456789/secrets/openai-key/versions/latest
```

That's it — no other configuration. On boot, Arbr resolves every recognized reference before
connecting to Mongo (fail-closed timing, same as the existing `ARBR_ADMIN_KEY`/
`ARBR_ENCRYPTION_KEY` production checks): in production, a resolution failure (missing
permission, wrong secret name, unreachable API) refuses to start with an actionable message; in
dev, it's logged as a warning and treated as if the variable were unset.

## Rotation

A resolved secret is re-checked automatically every 10 minutes, and immediately via:

```sh
curl -X POST https://your-arbr-host/api/secrets/refresh \
  -H "Authorization: Bearer $ARBR_ADMIN_KEY"
```

(administrator role required). Rotating a secret's value in GCP Console and calling this once is
enough — no restart, no data migration. `GET /api/connections` reports `source: "secret-manager"`
for a credential resolved this way, so an operator can see where a credential came from without
ever seeing the secret or its exact reference.

## Adding another store

The resolver is built against a small, cloud-agnostic interface — one file per store:

```js
{ scheme: "aws-sm", matches: (uri) => boolean, resolve: (uri) => Promise<string> }
```

**AWS Secrets Manager** is the natural next adapter: `@aws-sdk/*` is already vendored via
`@langchain/aws` for the Bedrock provider, so there's no new SDK dependency, and the AWS
credential chain (IAM role on the instance, or `AWS_*` env vars) already applies. An `aws-sm://`
scheme against ARNs would follow the exact same shape as `gcp-sm://`.

**Azure Key Vault** would follow the same pattern — an `azure-kv://<vault-name>/<secret-name>`
scheme, resolved via `@azure/identity` + `@azure/keyvault-secrets` using `DefaultAzureCredential`
(picks up a managed identity automatically on an Azure VM, mirroring GCP's ADC). Not implemented
yet; documented here so the shape is settled if/when a partner needs it.

Either adapter is a new file implementing that interface, appended to the resolver's provider
registry — no changes to `envCredentialFor()`, `secrets.js`, `csrf.js`, `semanticCache.js`,
`adminAuth.js`, or the boot sequence that reads them.
