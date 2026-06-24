# Contributing to Arbr Control Plane

Thanks for your interest in contributing! Please read the
[Project Arbr Contributing Guidelines](https://github.com/project-arbr/.github/blob/main/CONTRIBUTING.md)
for the full workflow. This document covers repo-specific setup.

## Local development

```bash
# Prerequisites: Node 20+, MongoDB running locally (or Docker)
git clone https://github.com/project-arbr/arbr-control-plane.git
cd arbr-control-plane
cp .env.example .env          # fill in at minimum ARBR_ADMIN_KEY and MONGO_URI
npm install
npm run dev                   # starts server (port 4100) + dashboard (port 5173)
```

With Docker Compose (no local MongoDB needed):

```bash
docker compose up             # demo mode with seeded data
```

## Project structure

```
server/src/
  gateway/      — /v1/chat request handling + OpenAI-compat endpoint
  providers/    — LLM provider adapters (OpenAI, Anthropic, Gemini, …)
  routing/      — Rule engine, AI policy, cost guardrail
  api/          — Admin REST routes (/api/*)
  models/       — Mongoose schemas
web/src/        — React + Vite dashboard
clients/        — JS and Python SDKs (published separately)
docs/           — VitePress documentation site
```

## Commit format

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add Mistral provider support
fix: correct token count for streaming responses
docs: update quickstart with Docker Compose steps
chore: bump mongoose to 8.5
```

Types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `ci`

## Pull request checklist

- [ ] Changes are scoped to one concern
- [ ] `npm run dev` works end-to-end with your change
- [ ] No API keys, `.env` values, or secrets committed
- [ ] Commit messages follow Conventional Commits format
- [ ] PR description explains *why*, not just *what*

## Reporting bugs

Open a [GitHub issue](https://github.com/project-arbr/arbr-control-plane/issues/new/choose).
For security vulnerabilities, use
[GitHub Security Advisories](https://github.com/project-arbr/arbr-control-plane/security/advisories/new)
— not public issues.

## License

By contributing, you agree your contributions are licensed under the
[Apache License 2.0](LICENSE).
