# Data privacy and retention

ARBR records cost, latency, model, routing, application, and token metadata for every gateway
request. In production, prompt and response payload capture is **off by default**, PII masking
is on, and request retention defaults to 30 days. Local demo/development mode keeps the
historical demo-friendly defaults.

## Opting in to payload capture

Enable **Governance → Privacy & Content → Store request & response payloads** only after your
data owner confirms that prompts and model outputs may be retained. The dashboard requires an
explicit confirmation and shows a persistent warning while capture is enabled. PII masking is
pattern-based and reduces risk; it is not a guarantee that all sensitive data will be detected.

Metadata-only mode applies to native chat, OpenAI-compatible chat (including streaming),
embeddings, request-derived evaluation datasets, replay results, and shadow-evaluation pairs.
Costs, token counts, latency, attribution, routing decisions, and evaluation verdicts remain
available without storing prompt or response text.

## Retention, deletion, and export

Configure retention under **Governance → Observability → Log Retention**. ARBR purges request
records and text-bearing evaluation items/results/datasets older than the configured window at
startup and every 24 hours. Reducing the window is therefore not an immediate synchronous
deletion; restart ARBR to run the purge immediately, or wait for the next scheduled run.

The Requests CSV export contains operational metadata and does not export prompt or response
payloads. Deleting a benchmark through the API/dashboard also deletes its items, runs, and
results. ARBR does not delete copies already present in external backups or exports.

## Storage responsibilities

`ARBR_ENCRYPTION_KEY` encrypts provider credentials stored through the dashboard. It does **not**
encrypt MongoDB request records or Docker volumes. The operator is responsible for disk/volume
encryption, MongoDB access controls, backup encryption, backup retention, restore testing, and
secure deletion of expired backups. On cloud VMs, use encrypted persistent disks and restrict
MongoDB to the private Compose network or an authenticated managed service.
