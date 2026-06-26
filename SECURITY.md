# Security Policy

## Reporting a vulnerability

Please **do not** open public issues for security vulnerabilities.

Report them privately through GitHub Security Advisories:
[Report a vulnerability](https://github.com/project-arbr/arbr-control-plane/security/advisories/new).

We aim to acknowledge reports within 3 business days and to provide a remediation
timeline after triage. Please give us a reasonable window to release a fix before any
public disclosure (coordinated disclosure).

When reporting, include where possible:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if available)
- Affected version / commit
- Any suggested remediation

## Scope

This project is an LLM gateway and control plane. Areas of particular interest:

- The admin API and dashboard authentication (`ARBR_ADMIN_KEY`)
- Encryption of provider credentials at rest (`ARBR_ENCRYPTION_KEY`)
- The OpenAI-compatible and native gateway endpoints
- Any path that could leak stored provider keys

## Supported versions

This project is pre-1.0 and moves quickly. Security fixes are applied to the latest
release on `main`. Pin a released version for production and upgrade promptly when
advisories are published.

## Deployment hardening

`ARBR_ENCRYPTION_KEY` **must** be set in production — the server refuses to boot with
`NODE_ENV=production` if it is missing, because the development fallback key is public.
See `.env.example` and the deployment docs for the full production checklist.
