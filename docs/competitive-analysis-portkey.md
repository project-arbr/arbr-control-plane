# Competitive Analysis: Portkey AI Gateway vs. Arbr

> **Last updated:** 2026-07-23 (refreshed against currently shipped code — rows 37/53/55/56 and
> the sections referencing them were stale from the prior 2026-07-03 pass)  
> **Purpose:** Product roadmap input — feature gap identification and prioritization

---

## Portkey Full Feature Inventory

### Core Gateway

- Universal API across 1600+ LLMs and providers
- Smart routing: dynamic model switching, workload distribution, configurable failover rules, conditional routing
- Automatic retries with exponential backoff
- Fallback switching between LLMs on failure
- Request timeout handling
- Load balancing across multiple LLM instances
- Canary testing / traffic splitting (route X% of traffic to a new model)
- Exact-match caching
- Semantic caching (embedding-based similarity match)
- Smart batching, provider batch API integration, custom batching
- Multimodal support: vision, audio, image generation
- File upload + file reference in requests
- MCP Gateway support
- Streaming (SSE)

### Guardrails

- **Input guardrails** — prompt injection detection, harmful/off-topic/manipulative prompt filtering (pre-model)
- **Output guardrails** — PII leak prevention, hallucination detection, unreliable response flagging (post-model)
- JSON schema validation
- RegEx pattern matching
- Safety and format enforcement checks
- Logic validation checks
- Embedding request guardrails
- Monitoring-only mode (flag violations without blocking)
- Routing on guardrail verdict: deny request, retry, or switch model
- Custom webhook integration for proprietary guardrail rules
- Partner guardrail integrations: Mistral, Prompt Security, Patronus, Pillar, Lasso, Pangea, Bedrock, Azure, Palo Alto Networks AIRS, Promptfoo, Aporia, Acuvity, Exa

### Observability

- Request/response logging with 40+ metadata fields per record
- Real-time usage monitoring dashboard
- Error tracking and latency analysis
- Cost analysis and FinOps tracking (provider + route spend attribution)
- Token analytics across models, teams, and providers
- Retry, fallback, and timeout event monitoring
- Caching metrics and hit rates
- Structured feedback collection (request and conversation level)
- Weighted feedback for response quality scoring
- 15+ customizable filters on the analytics dashboard
- Agent / multi-step workflow tracing (step-by-step lifecycle)
- OpenTelemetry-compatible export
- Log export to external reporting tools

### Prompt Management

- Centralized prompt dashboard (all providers, one UI)
- Prompt versioning with labeled deployments + rollback to any version
- Dynamic variable templates (interpolate values at call time)
- Shared prompt libraries (team-wide repository)
- Collaborative prompt editing with access control
- Side-by-side prompt comparison across models
- Prompt playground (test any prompt against any model)
- Prompt API endpoints (call prompt by ID from application code)

### Key Management

- Virtual key system (alias → real provider key, stored in vault)
- Key rotation and revocation
- Per-key usage monitoring
- Service account API keys (enterprise tier)
- Granular budget and rate limits per virtual key (enterprise tier)

### Enterprise / Governance

- Role-based access control (RBAC)
- Organization-wide audit logs
- Model/provider allowlisting (network-level guardrails)
- SSO support
- HIPAA, SOC2 Type 2, GDPR compliance
- Private cloud / VPC hosting
- Data lake exports
- Custom BAAs and data isolation
- Alerts capability
- Budget enforcement

### Developer Experience

- OpenAI-compatible API
- MCP Gateway integration
- Azure support
- GitHub workflow integration
- Python and TypeScript SDKs
- Prompt API endpoints

---

## Feature-by-Feature Comparison

### Core Gateway

| # | Feature | Portkey | Arbr | Gap |
|---|---------|---------|------|-----|
| 1 | Universal LLM API | 1600+ providers | ~15 providers + custom BYOP | Partial |
| 2 | Automatic retries | Exponential backoff per provider | Single-fallback retry on failure | Partial |
| 3 | Provider fallback | ✅ | ✅ Falls back to next live provider | Covered |
| 4 | Load balancing (multi-instance) | ✅ Weighted, round-robin | ❌ | Missing |
| 5 | Traffic splitting / canary | ✅ Route X% to model A, Y% to B | ✅ Eval-gated canary rollout with configurable rolloutPct, guardrails, auto-rollback | Covered |
| 6 | Conditional routing | ✅ | ✅ Rule-based + AI policy routing | Covered |
| 7 | Request timeouts | ✅ | ✅ | Covered |
| 8 | Exact-match caching | ✅ | ✅ | Covered |
| 9 | Semantic caching | ✅ | ✅ Embedding-similarity cache, configurable threshold | Covered |
| 10 | Cache TTL configuration | ✅ | ❌ | Missing |
| 11 | Batching API | ✅ | ❌ | Missing |
| 12 | Multimodal (vision, audio) | ✅ | ❌ Text/chat only | Missing |
| 13 | File upload + references | ✅ | ❌ | Missing |
| 14 | MCP Gateway | ✅ | ❌ | Missing |
| 15 | Streaming (SSE) | ✅ | ✅ | Covered |

### Guardrails

| # | Feature | Portkey | Arbr | Gap |
|---|---------|---------|------|-----|
| 16 | Input guardrails (pre-model) | ✅ Full suite | ✅ PII masking, max tokens, RPM | Partial |
| 17 | Output guardrails (post-model) | ✅ | ✅ Keyword/regex deny-list checked before returning to caller | Covered |
| 18 | PII detection and masking | ✅ | ✅ 5 built-in + custom regex patterns | Covered |
| 19 | JSON schema validation | ✅ | ❌ | **Missing** |
| 20 | RegEx content filtering | ✅ | ✅ Custom PII patterns cover this partially | Partial |
| 21 | Prompt injection detection | ✅ | ✅ Built-in patterns + custom per-app rules | Covered |
| 22 | Monitoring-only guardrail mode | ✅ | ❌ | Missing |
| 23 | Route on guardrail verdict | ✅ Deny / retry / switch | ✅ Fallback routing exists; not guardrail-triggered | Partial |
| 24 | Custom sync guardrail webhooks | ✅ | ❌ Webhooks are async alerts only | Missing |
| 25 | Partner guardrail integrations | ✅ 12+ partners | ❌ | Missing |

### Observability

| # | Feature | Portkey | Arbr | Gap |
|---|---------|---------|------|-----|
| 26 | Request/response logging | ✅ 40+ fields | ✅ Full RequestRecord with payload toggle | Covered |
| 27 | Real-time dashboard | ✅ | ✅ Analytics with timeseries | Covered |
| 28 | Error tracking | ✅ | ✅ Error rate alerting + status filters | Covered |
| 29 | Latency analysis | ✅ | ✅ p50/p95 + avg | Covered |
| 30 | Cost dashboards | ✅ | ✅ Cost analytics + realised savings | Covered |
| 31 | Token analytics | ✅ | ✅ By model/provider/app/user/department | Covered |
| 32 | Retry/fallback monitoring | ✅ | ✅ `routingDecision` logged on every record | Covered |
| 33 | Caching metrics | ✅ | ✅ `cached` flag + hit analytics | Covered |
| 34 | Feedback collection | ✅ | ❌ No user/app feedback on responses | Missing |
| 35 | Response quality scoring | ✅ Weighted | ❌ | Missing |
| 36 | Agent / workflow tracing | ✅ Step-by-step spans | ❌ No distributed trace spans | Missing |
| 37 | OpenTelemetry export | ✅ | ✅ OTLP trace spans per request, sample-ratio + content-capture controls | Partial — trace export shipped; no aggregate metrics endpoint yet ([#30](https://github.com/project-arbr/arbr-control-plane/issues/30)) |
| 38 | Log export | ✅ | ✅ CSV export for requests + audit log | Partial |
| 39 | Provider health monitoring | ✅ | ✅ Live table with 30s auto-refresh | Covered |
| 40 | Admin audit log | ✅ | ✅ Full audit log + CSV export | Covered |

### Prompt Management

| # | Feature | Portkey | Arbr | Gap |
|---|---------|---------|------|-----|
| 41 | Prompt versioning + rollback | ✅ | ❌ | Missing |
| 42 | Dynamic variable templates | ✅ | ❌ | Missing |
| 43 | Shared prompt library | ✅ | ❌ | Missing |
| 44 | Prompt playground | ✅ | ❌ | Missing |
| 45 | Prompt API endpoints | ✅ | ❌ | Missing |
| 46 | Prompt A/B testing | ✅ | ✅ Shadow eval campaigns | Partial |

### Key Management

| # | Feature | Portkey | Arbr | Gap |
|---|---------|---------|------|-----|
| 47 | Virtual keys / aliases | ✅ | ✅ API keys with `ab_` prefix display | Covered |
| 48 | Per-key rate limiting | ✅ | ✅ Per-key RPM sliding windows | Covered |
| 49 | Per-key cost budgets | ✅ | ✅ Budget caps by dimension | Covered |
| 50 | Key rotation policy | ✅ | ✅ One-click rotation (`POST /api/keys/:id/rotate`) | Covered |
| 51 | Key expiry dates | ✅ | ✅ `expiresAt` on ApiKey, enforced at the gateway | Covered |
| 52 | Per-key usage analytics | ✅ | ✅ Filter analytics by key/app | Covered |

### Enterprise / Governance

| # | Feature | Portkey | Arbr | Gap |
|---|---------|---------|------|-----|
| 53 | Role-based access control | ✅ | ✅ Viewer/operator/administrator roles, per-user identity | Partial — 3 fixed roles, not custom/granular permissions |
| 54 | Multi-tenant workspaces | ✅ | ❌ Single-tenant only (RBAC is roles within one org, not org isolation) | Missing |
| 55 | SSO / SAML | ✅ | ✅ OIDC (Okta, Auth0, Google Workspace, Keycloak, ...) | Partial — SAML specifically not supported |
| 56 | Model/provider allowlist | ✅ Network-level | ✅ Per-app `modelOptOut` deny-list; kill switch | Partial — deny-list, not an explicit allowlist |
| 57 | Alerts | ✅ | ✅ Error rate + budget cap webhooks | Covered |
| 58 | HIPAA / SOC2 / GDPR | ✅ | ❌ No compliance certifications | Missing |
| 59 | Self-hosted / on-premise | ✅ | ✅ Docker-based | Covered |
| 60 | Private cloud / VPC hosting | ✅ Enterprise | ❌ | Missing |

---

## Arbr-Unique Capabilities (Not in Portkey)

These are Arbr's differentiators — the moat that justifies choosing Arbr over Portkey:

| Feature | Description |
|---------|-------------|
| **AI-generated routing policy** | LLM automatically assigns task types → optimal models based on benchmarks and historical data |
| **Cost-aware auto-routing** | Guardrail mode that automatically downgrades to light/mid/premium tier based on task complexity |
| **Per-application routing policy override** | Each app can have its own routing policy, independent of global defaults |
| **Shadow model eval campaigns** | Judge model compares production model vs. candidate model on live traffic; quantified quality delta |
| **Realised savings analytics** | Tracks dollar savings from model substitution over time; shows ROI of routing decisions |
| **Benchmark data integration** | Syncs Livebench, LMSYS, LiteLLM benchmark data; routing decisions informed by external quality scores |
| **AI routing recommendations** | Suggests model changes based on cost/quality analytics; one-click accept |
| **Budget auto-downgrade action** | When budget cap is hit, automatically routes to cheaper model instead of just blocking |
| **Per-task-type difficulty scoring** | Confidence-weighted task classification drives routing intelligence |

---

## Weighted Gap Priority Matrix

Prioritized by **Impact** (closes the Portkey gap / competitive) × **Usefulness** (Arbr users actually benefit) × **Effort**.

### Recently Shipped

The four items formerly listed as Priority 1 have since shipped:

| Feature | What landed |
|---------|-------------|
| **Output guardrails** | Keyword/regex deny-list checked against response text before it returns to the caller, scoped per app. |
| **Semantic caching** | Embedding-similarity match against the recent-request cache, with a configurable threshold. |
| **API key expiry + rotation** | `expiresAt` on the ApiKey model, enforced at the gateway; one-click rotation via the admin API. |
| **Prompt injection detection** | Built-in pattern library plus custom per-app rules, alongside PII masking. |

Separately, **traffic splitting / canary rollout** (previously listed under Priority 2) has
also shipped: eval-gated canary experiments with configurable `rolloutPct`, guardrails
(error rate, latency, cost saving, shadow worse-rate), and automatic rollback on breach.

Three more have shipped since this doc's last pass (previously rows 37/53/55 read "Missing" —
corrected above):

| Feature | What landed |
|---------|-------------|
| **Per-user identity + RBAC** | `ARBR_AUTH_MODE=oidc` or `trusted-header` on top of the existing admin key, with viewer/operator/administrator roles and a per-user audit trail. |
| **SSO (OIDC)** | Login against any OIDC provider (Okta, Auth0, Google Workspace, Keycloak, ...) — see [Accountable admin access](/auth). SAML specifically is still unsupported. |
| **OpenTelemetry trace export** | OTLP spans per gateway request, off by default, with sample-ratio and content-capture controls adjustable at runtime. No Prometheus-style metrics endpoint yet — that's a different signal type and stays open ([#30](https://github.com/project-arbr/arbr-control-plane/issues/30)). |

### Priority 1 — Build Next

Nothing carried over from the prior Priority 1 list — see Priority 2 below for the next
candidates.

### Priority 2 — Next Quarter

| Feature | Why | Effort |
|---------|-----|--------|
| **Cache TTL configuration** | Expose TTL setting in admin UI; reuses existing cache infrastructure. Admins need control over how long cached responses remain valid. | Small (0.5 day) |
| **Feedback collection** | Thumbs up/down per response, piped back to Arbr. Enables quality-weighted analytics and eventual fine-tuning signal. | Medium (1.5 days) |
| **Monitoring-only guardrail mode** | Log guardrail violations without blocking requests. Critical for rolling out new guardrail rules without disrupting production. | Small (0.5 day) |
| **Prompt versioning + templates** | New data model. Call prompt by ID from SDK; version history with rollback. Teams iterating on system prompts have zero visibility today. | Large (4–5 days) |

### Priority 3 — Later

| Feature | Why | Effort |
|---------|-----|--------|
| **Model/provider allowlist per app** | Restrict which models app X can call. Per-app governance control beyond just kill switch. | Small (1 day) |
| **Load balancing across accounts** | Spread load across multiple OpenAI org accounts or Bedrock regions. Needed for high-volume enterprise deployments. | Medium (2 days) |
| **Custom sync guardrail webhooks** | Call your own content moderation service; block or pass based on response. Very enterprise-appealing. | Medium (1.5 days) |
| **OpenTelemetry integration** | Emit spans to Datadog/Jaeger/Honeycomb. Required for orgs with existing observability stacks. | Medium (2 days) |

### Priority 4 — Evaluate Later

| Feature | Why | Effort |
|---------|-----|--------|
| **Agent / multi-step tracing** | Trace spans across multi-call LLM workflows. Growing need as agentic workloads increase. | Large (3–4 days) |
| **Multi-tenant workspaces** | Org-level isolation on top of the RBAC that's already shipped (viewer/operator/administrator). Required for enterprise multi-team deployments where teams shouldn't see each other's data. | Large (5+ days) |
| **Multimodal support** | Vision/audio requests growing rapidly. Adds significant provider-compatibility surface area. | Large (3–4 days) |

### Defer / Skip

| Feature | Why skip |
|---------|----------|
| Batching API | Not core gateway use case; offline workloads are separate infrastructure |
| Fine-tuning pipeline | Arbr routes, doesn't train; out of scope |
| SAML specifically | OIDC (covering Okta, Auth0, Google Workspace, Keycloak) shipped; SAML can still be handled at the reverse-proxy layer (Cloudflare Access, etc.) if a prospect specifically needs it |
| HIPAA / SOC2 certification | Legal/process work, not engineering; depends on company maturity stage |
| Private cloud / VPC hosting | Already self-hostable via Docker; enterprise can run in their own infra |
| Partner guardrail integrations (12+) | Build the hook framework first; partnerships come after adoption |

---

## Strategic Summary

**Where Portkey leads:**
Portkey wins on breadth — 1600+ providers, 12+ guardrail partners, full prompt management, and compliance certifications. RBAC and SSO are no longer clean wins for Portkey (Arbr has per-user roles and OIDC now), but Portkey's are more mature — multi-tenant workspaces and SAML specifically are still Arbr gaps. It's a horizontal platform built for large teams with diverse compliance needs.

**Where Arbr leads:**
Arbr's moat is **routing intelligence** — AI-generated policies, cost-aware downgrade, per-app overrides, shadow eval campaigns, realised savings tracking, and benchmark-integrated decision-making. Portkey has none of this. Portkey routes but doesn't optimize; Arbr routes and learns.

**The gap that matters most:**
Output guardrails, semantic caching, canary rollouts, per-user RBAC/OIDC, and OpenTelemetry
trace export have all shipped since this doc's prior pass, closing most of Arbr's visible gaps
against Portkey. The next-clearest gaps are prompt versioning + templates (see Priority 2) and
multi-tenant workspaces (Priority 4) — those are where Arbr users or enterprise buyers would
see the next measurable value.

**The positioning play:**
Arbr shouldn't try to match Portkey's provider breadth (1600 vs. 15 is a losing race). The winning angle is: *intelligent, cost-optimizing, self-hosted gateway for teams that want their AI spend to be data-driven, not just routed.*
