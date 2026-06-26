# Roadmap

This is a **directional** roadmap, not a set of commitments or dates. It exists to tell
contributors where help is most welcome. Priorities will shift; if something here matters
to you, open or comment on an issue.

Want to help? Look for [`good first issue`][gfi] and [`help wanted`][hw] labels.

## Themes

### Hardening & contributor experience
Make the project safe and easy to contribute to: a linter, a server-side test suite,
reproducible Docker builds, and orientation docs ([ARCHITECTURE.md](ARCHITECTURE.md)).

### Observability
A metrics endpoint (Prometheus / OpenTelemetry) for request counts, latency, cost, and
routing decisions; richer per-request error surfacing in the dashboard.

### More providers
Additional provider adapters (e.g. Cohere, Mistral, Vertex AI) via the existing
`providers/llm-router/` pattern, each with a `docs/providers/` page.

### Deployment options
Beyond single-VM docker-compose: a Helm chart / Kubernetes manifests, and an automated
(scheduled) LiteLLM catalog sync so the model registry doesn't drift.

### Routing & policy
Improvements to the routing scoring engine and budget enforcement, informed by real usage.

## How to propose changes

- Small, scoped change → open a PR (see [CONTRIBUTING.md](CONTRIBUTING.md)).
- Larger or design-sensitive change → open an issue or a Discussion first so we can agree on
  the approach before code.

[gfi]: https://github.com/project-arbr/arbr-control-plane/labels/good%20first%20issue
[hw]: https://github.com/project-arbr/arbr-control-plane/labels/help%20wanted
