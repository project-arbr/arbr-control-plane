# Changelog

All notable changes to Arbr Control Plane are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/). Client SDKs version independently and keep their own
changelogs under `clients/`.

## [Unreleased]

## [0.3.0] - 2026-07-22

### Added
- Eval-backed routing: offline replay with recommendation quality-gating (#79), durable
  eval worker with masked-fidelity labeling (#88), reusable benchmarks with a model
  leaderboard and quality-per-dollar view (#115), judge-reliability checks for position
  bias and decisiveness (#119), a "disprove it" precision pass on worse verdicts (#117,
  #120), and severity-weighted benchmark curation with pinned problem cases (#123).
- Canary rollouts and shadow evals: mirror live traffic to a candidate model (#54),
  promote or roll back experiments, gated on passed evals (#84).
- Gateway surface: `POST /v1/embeddings` with Gemini and OpenAI backends (#135) and an
  OpenAI Realtime WebSocket proxy at `POST /v1/realtime` (#137). SDKs released at 0.5.0
  with embeddings support (#136).
- Per-user attribution: `userId` and `department` on API keys (#131), `body.user`
  mapping on the OpenAI-compatible path (#126), and a team usage guide (#129).
- Governance: output guardrail keyword/regex deny-list with per-app scoping (#66) and a
  three-section governance overhaul covering guardrails and observability (#62).
- Observability: latency benchmarking with TTFT and gateway-overhead tracking (#86),
  p50/p95 latency stats with per-app trends and request search (#60), a latency
  breakdown table on Overview (#118), and per-request routing explainability (#44, #48).
- Cost controls: `max_tokens` clamped to each model's output ceiling (#46, #47), budget
  warnings with CSV export and cost trend (#52), goal-driven policy generation with an
  impact simulator (#42), and a 1-10 difficulty score captured per request (#40).
- Engineering: server unit + integration test suite and testing strategy (#58), routing
  benchmark harness across LiveBench, Arena-Hard, and SWE-bench (#63), and a gated,
  image-based, rollback-safe deploy pipeline (#61, #74).
- Security & hardening: CI gates for secret scanning, npm audit, CodeQL, and Trivy image
  scans (#151); graceful shutdown on SIGTERM/SIGINT (#152); a production profile that
  fails closed instead of booting without required secrets (#159); metadata-only logging
  as the production default (#160, #162).
- Guardrails & caching: built-in and custom per-app prompt injection detection (#154), and
  a semantic response cache with a configurable similarity threshold (#155).
- API keys: expiry dates and one-click rotation (#156).
- Access control: OIDC/RBAC accountable admin access with a per-user audit trail (#163),
  an allowed-domains setting for OIDC clients shared with other apps (#165), and SSO/RBAC
  documentation (#170).
- Providers: LiteLLM connection type is now discoverable from the UI (#171).
- Ingestion: an observe-only ingestion API (#172).
- Unified optimization workflow: a recommendation's lifecycle stage (opportunity through
  accepted, shadow, canary, or rolled back) is derived on read from its linked records
  rather than stored, with realised-vs-projected outcome tracking (#180).
- Exportable recommendation evidence report, as JSON or Markdown, assembled on demand from
  every linked dataset, eval run, campaign, experiment, and audit entry (#181).
- Design-partner demo fixture: a full opportunity-to-canary-to-rollback story seeded with
  zero provider keys, using the same production aggregation/judging code as real evals
  (`npm run demo:seed` / `demo:reset`) (#182).
- Internal spend accounting: every LLM call Arbr makes for itself (classification, policy
  generation, judging, eval replay) now goes through one wrapper that tags and prices it,
  keeping it out of customer-facing analytics (#183, #184).
- Cloud secret-manager integration: any credential-shaped env var can hold a `gcp-sm://...`
  reference instead of a literal, resolved transparently at boot and on a periodic or
  on-demand refresh; production fails closed on a resolution failure. AWS/Azure adapters
  are documented against the same interface (#189).
- Operational readiness package: a `/health/ready` readiness check distinct from the
  existing liveness check, backup/restore scripts, config/policy export and import, a
  support-diagnostics bundle with no credentials or captured payloads, a disk-usage guard
  on deploy, and bounded container log growth (#190).
- OpenTelemetry trace export: OTLP spans per request, off by default, with sample-ratio
  and content-capture controls adjustable at runtime from the Governance page (#191, #192,
  #193).
- A projectarbr.org link in the web console's sidebar footer (#186).

### Changed
- Console reoriented around the five stages (Connect, See, Recommend, Route, Govern)
  with a redesigned sidebar and Recommendations page (#98, #111, #112) and a restyle to
  the ARBR monochrome brand (#144-#146).
- Hot-path latency reduced via a Settings cache and parallel pre-LLM fetches (#85).
- Web stack migrated to Tailwind CSS v4 (#70).
- Roughly twenty documentation pages corrected for drift against the actual API, config,
  and pricing (#173, #175-#179); the README's autonomy claims and quickstart walkthrough
  clarified (#194); the README dashboard screenshot refreshed (#187).

### Fixed
- Eval judge was passed a string instead of a messages array, so judging never worked;
  fixed along with re-run support (#108).
- Per-app config (policy, opt-out, kill switch) now applies on `/v1/chat/completions`
  (#39).
- `/api/about` 500 that broke the deploy seed-version check (#89); `/health` demoMode
  now reflects effective provider state (#147).
- Audit page blanked on the new object-shaped `AuditLog.actor` (#164).
- Docker Compose wasn't passing the accountable-admin-access auth env vars through
  (#166).
- Arbr's own AI spend was polluting customer analytics views (#167).
- Sign-out showed the admin-key form even in OIDC/trusted-header mode (#168).
- Sidebar tagline pushed Users out of view without scrolling (#169).
- `handler.js` logged a `semantic_cache` routing decision the schema's enum didn't
  include, silently dropping every semantic-cache-hit log row (#174).
- Sidebar footer links stacked into two rows after adding the projectarbr.org link,
  pushing Users below the fold again; put back on one row (#188).

## [0.2.0] - 2026-06-29

### Added
- Model registry: full catalog sync from LiteLLM plus LiveBench and LMSYS benchmark
  scores, with a Models page for provider management and model testing.
- Discovery endpoints: `GET /v1/models`, `GET /v1/providers`, `GET /v1/task-types`,
  filtered to live providers with tool-call capability flags.
- Custom providers: connect any OpenAI-compatible endpoint from the UI, including a
  LiteLLM proxy type.
- Applications hub: per-app kill switch, routing policy, and model opt-out; Budgets page
  with per-app and per-provider spend caps.
- Analytics: per-user spend and realised-savings visibility (#38); provider prompt-cache
  tokens captured and priced (#37).
- Routing: difficulty-aware classification signal (#36); LLM-based policy generation;
  scoring-engine router replacing the LLM router.
- Bedrock: tool-call support on the Converse API, including streamed tool calls.
- AI governance controls: transparency, safety, audit, and data lifecycle.

### Changed
- Repository prepared for open source under project-arbr (#1); ESLint added and CI
  hardened (#33); dependabot PRs grouped per ecosystem (#17).

### Fixed
- Completions no longer truncate at 1024 tokens; real `finish_reason` reported (#34).
- SSE truncation on `/v1/chat/completions` for native providers; DeepSeek R1 hang and
  ValidationException on Bedrock; crash on null messages with tool-result history.

## [0.1.0] - 2026-06-17

Initial release: OpenAI-compatible gateway (`/v1/chat/completions`) in front of
Anthropic, OpenAI, Google Gemini, AWS Bedrock, and OpenAI-compatible providers;
deterministic human-approved routing rules; spend caps; request logging with cost
attribution; React dashboard; JS and Python client SDKs.

[Unreleased]: https://github.com/project-arbr/arbr-control-plane/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/project-arbr/arbr-control-plane/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/project-arbr/arbr-control-plane/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/project-arbr/arbr-control-plane/releases/tag/v0.1.0
