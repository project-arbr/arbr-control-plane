# Changelog

All notable changes to Arbr Control Plane are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[semver](https://semver.org/). Client SDKs version independently and keep their own
changelogs under `clients/`.

## [Unreleased]

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

### Changed
- Console reoriented around the five stages (Connect, See, Recommend, Route, Govern)
  with a redesigned sidebar and Recommendations page (#98, #111, #112) and a restyle to
  the ARBR monochrome brand (#144-#146).
- Hot-path latency reduced via a Settings cache and parallel pre-LLM fetches (#85).
- Web stack migrated to Tailwind CSS v4 (#70).

### Fixed
- Eval judge was passed a string instead of a messages array, so judging never worked;
  fixed along with re-run support (#108).
- Per-app config (policy, opt-out, kill switch) now applies on `/v1/chat/completions`
  (#39).
- `/api/about` 500 that broke the deploy seed-version check (#89); `/health` demoMode
  now reflects effective provider state (#147).

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

[Unreleased]: https://github.com/project-arbr/arbr-control-plane/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/project-arbr/arbr-control-plane/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/project-arbr/arbr-control-plane/releases/tag/v0.1.0
