# Operational readiness

A supportable runbook for self-hosted partners: liveness vs. readiness, backup/restore,
disaster recovery, capacity guidance, log rotation, disk alerts, and support-bundle generation.
Upgrade and rollback are covered in [Deploy on GCP](/deployment-gcp#deploying-a-new-version-gated-image-based)
— not repeated here.

## Liveness vs. readiness

- `GET /health` — **liveness**. Always `200` if the process is up; never depends on Mongo. This
  is what `ops/deploy.sh` polls to gate a deploy — don't point an orchestrator's liveness/restart
  probe anywhere else.
- `GET /health/ready` — **readiness**. Returns `503` while draining after SIGTERM/SIGINT (a
  3-second grace window before the server stops accepting new connections, so a
  readiness-polling load balancer has time to notice and stop routing here first) or while Mongo
  is disconnected. Point a load balancer's or orchestrator's readiness probe here — it should
  remove an unhealthy instance from rotation without restarting it. Today's single-VM deployment
  has no managed instance group polling this; it's provided for Cloud Run, a future Kubernetes
  deployment, or any other orchestrator that wants real drain-aware readiness.

```sh
curl -s localhost:4100/health         # {"ok":true,"demoMode":false}
curl -s localhost:4100/health/ready   # {"ok":true,"ready":true,"reason":null}
```

## Backup

```sh
bash ops/backup.sh [output-dir]   # defaults to ./backups
```

Runs `mongodump` inside the `mongo` container (Mongo's data lives on a named Docker volume, not
a bind mount, so this is the supported way to get it out) and writes a single gzipped archive.
Run it before every deploy that touches data, and on a schedule (cron `bash ops/backup.sh` on the
VM, rotated off-box — this script doesn't manage retention itself).

## Restore

```sh
bash ops/restore.sh <backup-file>
```

**Destructive** — drops every existing collection in the target database before restoring.
Prompts for confirmation, restarts the app container afterward, and health-gates the restart the
same way `ops/deploy.sh` does.

### Post-restore verification checklist

Run all of these after any restore — a restore that doesn't pass this isn't done:

- [ ] `curl -s localhost:4100/health` → `{"ok":true,...}`
- [ ] `curl -s localhost:4100/health/ready` → `{"ok":true,"ready":true,"reason":null}`
- [ ] `curl -s -H "Authorization: Bearer $ARBR_ADMIN_KEY" localhost:4100/api/status` → `200`, sane
      `liveProviders`/`routingMode`
- [ ] A known Settings value from before the restore reads back correctly (e.g. `retentionDays`
      via `GET /api/governance`)
- [ ] Row counts look right for at least one collection you can sanity-check (e.g. `Rule` count
      via `GET /api/ops/export`)

## Disaster recovery

Scenario: the VM is lost entirely (deleted, corrupted, region outage).

1. Provision a new VM and follow [Deploy on GCP](/deployment-gcp) from scratch — same firewall
   rules, same `.env`/`docker-compose.gcp.yml` overrides (these are gitignored/untracked, so they
   must be restored from wherever they're kept outside the repo — a secrets manager or a secure
   copy, not committed).
2. Bring the stack up once with `SEED_ON_BOOT=false` so it doesn't seed demo data over a restore.
3. `bash ops/restore.sh <latest-backup>`.
4. Run the post-restore verification checklist above.

## Capacity guidance

Rough sizing for a single-VM deployment (no HA — see the roadmap's P2 "Horizontal scale" item
for multi-replica):

| Signal | Guidance |
|---|---|
| Disk | Mongo data grows with `RequestRecord` volume × `retentionDays` (auto-purged daily past that window — see [Data privacy & retention](/privacy)). Budget headroom for a `mongodump` archive too — `ops/deploy.sh` now refuses to pull a new image past 90% disk usage. |
| RAM | Mongo + Node both fit comfortably in 2GB for pilot traffic; the model registry (~1500+ entries) and semantic-cache embeddings (if enabled) are the main in-memory growth points. |
| CPU | Routing/classification calls to a provider add latency, not CPU load on this box — the gateway itself is I/O-bound. |

## Log rotation

The app logs only to stdout — there's no in-container log file to rotate. The base
`docker-compose.yml` bounds Docker's own `json-file` driver instead (`max-size: 20m`,
`max-file: 5` — capped at ~100MB per container, applied to both `app` and `mongo` via a shared
`x-logging` anchor), which is what actually needed fixing: the default driver has **no** size
cap, and this VM's 20G root disk has hit 100% from unbounded growth before.

## Disk alerts

`ops/deploy.sh` reclaims dangling images before every pull and now refuses to proceed if usage is
still above 90% afterward, with a message pointing at `ops/backup.sh` + cleanup. There's no
continuous background disk monitor — check `df -h` when running `ops/backup.sh` if you want a
manual read outside a deploy.

## Configuration/policy export & import

```sh
curl -s -H "Authorization: Bearer $ARBR_ADMIN_KEY" localhost:4100/api/ops/export > config.json
curl -s -X POST -H "Authorization: Bearer $ARBR_ADMIN_KEY" -H "Content-Type: application/json" \
  --data-binary @config.json localhost:4100/api/ops/import
```

Exports `Settings`, `Rule`, and `Cap` (budgets) — the human-authored policy surface. Deliberately
**excludes** provider credentials (never touches that collection at all — administrator role
required either way), and excludes `RoutingExperiment`/`Recommendation`/eval data, which are
operational history, not config. Import creates fresh documents (new IDs, not an ID-preserving
merge) and forces `isDemoFixture: false` on every imported `Rule`/`Cap`, so a real config restore
is never silently deleted by an unrelated instance's demo-reset. `Rule.sourceRecommendation` may
point at a recommendation that doesn't exist on the target instance after an import — harmless
(reads back as unset), not solved here.

Note: `Settings.webhookUrl` is effectively a bearer token and is included in the export — this
isn't a new exposure, `GET /api/governance` already returns it unmasked to any administrator.

## Support bundle

```sh
curl -s -X POST -H "Authorization: Bearer $ARBR_ADMIN_KEY" localhost:4100/api/ops/support-bundle
```

Returns one JSON object: version/runtime info, the masked config summary, current `Settings`,
disk usage, 24h request/error-rate counts, and the last 50 audit-log entries (projected to
`timestamp`/`action`/`entity`/`entityId`/`actor` only — the audit log's free-form `changes` field
is dropped entirely, not trusted). It never queries provider credentials or raw request records,
so there's no captured prompt/response text or secret to accidentally include — safe to attach
directly to a support request.
