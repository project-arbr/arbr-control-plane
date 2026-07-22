---
name: arbr-github-audit
description: Audit the Arbr Control Plane repo for (1) docs that have drifted from the actual implementation, (2) GitHub repo configuration best practices, and (3) open-source project hygiene. Use when the user asks to audit, review, or check the repo's docs/GitHub setup/OSS readiness, or invokes /arbr-github-audit directly.
---

# Arbr GitHub & OSS Audit

A repeatable audit of `project-arbr/arbr-control-plane` across three dimensions: documentation
accuracy, GitHub repository configuration, and open-source project hygiene. This is a **report
first, fix on approval** skill — run the checks, present a prioritized list of findings (must-fix
vs. nice-to-have, each with the file/setting and why it matters), and only make changes the user
has agreed to. Don't silently "fix" things while auditing.

Treat every check below as something to actually run, not something to eyeball from memory — this
repo moves fast (dozens of PRs per session), so anything not verified against the live repo in this
run is stale by definition.

## Before you start

```sh
cd /Users/prasanna/Documents/Gyde/arbr-ai-control-plane
git fetch origin main --quiet
git status --short          # don't audit against a dirty tree
gh repo view project-arbr/arbr-control-plane --json defaultBranchRef,visibility >/dev/null  # confirm gh auth works
```

Run every doc/code comparison against `origin/main`, not local `main` — this session has
repeatedly found PRs that show `merged: true` on GitHub but whose code never reached `main` (see
"Known gotchas" below). Trust `git cat-file`, not the PR API, for "is this actually there."

---

## Phase 0 — Baseline: GitHub's own community-profile check

Fast, authoritative, and easy to forget exists. Run it first:

```sh
gh api repos/project-arbr/arbr-control-plane/community/profile --jq '{health: .health_percentage, files: .files | map_values(.url != null)}'
```

This tells you directly whether GitHub sees a README, LICENSE, CODE_OF_CONDUCT, CONTRIBUTING,
SECURITY, an issue template, and a PR template. If any show `false`, that's a must-fix before
anything else — it's the baseline every other check assumes is true.

---

## Phase 1 — Documentation accuracy

For each doc below: read it, then verify its *specific factual claims* against the current code —
not just "does this doc exist," but "is what it says still true." Cite the file:line that proves
or disproves each claim you check; don't assert without looking.

- **`README.md`**
  - Provider list matches `server/src/config.js`'s `PROVIDERS` registry exactly (names, count).
  - Every `curl`/`npm`/`docker compose` command in Quickstart actually works against current code
    (route paths, script names in `package.json`, env var names in `.env.example`).
  - The "Not yet (by design or on the roadmap)" section — re-read every bullet against the actual
    code. A bullet claiming something is missing when it's actually shipped is worse than no
    bullet at all (this exact mistake is what triggered an external LLM review to conclude the
    whole project was less mature than it is — see the "closed-loop evaluation" bullet fixed in
    PR #194). Conversely, don't let a bullet quietly go stale in the other direction either —
    something newly *actually* missing (a deprecation, a removed feature) needs to show up here.
  - Badges (npm version, license, node version, brand guidelines) still point at real, current
    targets.
  - The dashboard screenshot (`docs/media/dashboard.png`) still resembles the current UI — nav
    groups, card labels. If the sidebar/nav has changed since the image was captured, it's stale
    (this has happened before — see PR #187's fix and the process in that session for
    regenerating it: seed demo data, headless Chrome screenshot, crop to match).
- **`CHANGELOG.md`**
  - Latest version section matches `package.json`'s `"version"` field.
  - Everything merged to `main` since the last tagged release is captured under `[Unreleased]` (or
    has already been folded into a cut release) — cross-reference `gh pr list --state merged
    --base main` against the changelog's PR-number citations to find gaps.
  - The `[Unreleased]`/versioned compare links at the bottom point at the right tags.
- **`ARCHITECTURE.md`** — the request-flow diagram and module map match what's actually in
  `server/src/`. New subsystems added since this was last touched (check `git log -1 --format=%ad
  -- ARCHITECTURE.md`) — telemetry, secret resolution, ops readiness, etc. — should be reflected
  if they change the architectural picture, not just be "a feature," e.g. a new top-level
  `server/src/<area>/` directory.
- **`SECURITY.md`** — the "Scope" section should name every current identity/credential surface
  (auth modes, credential storage, secret-manager resolution, any route that could leak a
  credential or captured payload). Check `git log -1 --format=%ad -- SECURITY.md` — if it hasn't
  moved since a major identity/security feature shipped, it's almost certainly stale.
- **`CONTRIBUTING.md`, `DEPLOYMENT.md`, `TESTING.md`, `ROADMAP.md`** — spot-check setup commands
  and prerequisites (Node version, Mongo version pin) against `package.json`'s `engines` field and
  whatever's actually required to run tests locally today.
- **`docs/*.md` (VitePress site)** — run `npm run docs:build` and read the output for warnings.
  Check `docs/.vitepress/config.mjs`'s sidebar for pages that exist on disk but aren't linked, or
  links that 404. Spot-check `docs/api-reference.md` and `docs/configuration.md` against the real
  route list in `server/src/api/routes/` and `server/src/config.js` — these two drift fastest.

---

## Phase 2 — GitHub repository configuration

Check each of these against the live repo via `gh api`/`gh repo view`, not assumption:

```sh
# Metadata
gh repo view project-arbr/arbr-control-plane --json description,homepageUrl,repositoryTopics,licenseInfo

# Branch protection on main
gh api repos/project-arbr/arbr-control-plane/branches/main/protection

# Security features
gh api repos/project-arbr/arbr-control-plane --jq '.security_and_analysis'
gh api repos/project-arbr/arbr-control-plane/private-vulnerability-reporting
gh api repos/project-arbr/arbr-control-plane/vulnerability-alerts   # 204 = enabled, 404 = not

# Social preview (no API for this — check manually if link unfurls look right; the asset
# assets/brand/arbr-social-preview.png already exists and should be uploaded via
# Settings -> General -> Social preview if it hasn't been)

# Releases vs tags
git tag -l
gh release list
# every real tag should have a matching Release; if tags exist with no Release, that's the gap
# fixed once already in PR #195 — check it hasn't regressed (a tag pushed without `gh release
# create` afterward).
```

Checklist:
- [ ] `homepageUrl` is set (projectarbr.org)
- [ ] Description is accurate and current
- [ ] Topics are present and relevant (not empty)
- [ ] `required_status_checks` exists on `main`'s protection and lists real, PR-triggered checks
      — see "Known gotchas" below for which checks must **never** be added here
- [ ] `required_pull_request_reviews` requires at least 1 approval + code-owner review
- [ ] `secret_scanning` + `secret_scanning_push_protection` enabled
- [ ] `vulnerability-alerts` enabled (required before Dependabot security updates can be)
- [ ] `dependabot_security_updates` enabled
- [ ] Private vulnerability reporting enabled
- [ ] Social preview image actually uploaded (manual check — no API)
- [ ] Every pushed `v*` tag has a corresponding `gh release` entry

---

## Phase 3 — Issue tracker hygiene

The tracker drifts out of sync with what's actually shipped constantly — this is the single
highest-signal, lowest-effort category, and the one most likely to make outside observers
(including LLMs asked to review the project) think the repo is behind where it actually is.

```sh
gh issue list --state open --limit 50
```

For each open issue: read its acceptance criteria / description, then check whether the linked
code area now satisfies it (grep for the function/env var/config the issue names). If every
criterion is met, it's a close, with a comment linking the PR(s) that shipped it — don't just
close silently. If it's partially met, comment with what shipped and what's still open, and leave
it open. Do not close an issue whose ask is genuinely still outstanding just because *related*
work landed nearby (e.g. OTel tracing shipping does not close a metrics-endpoint issue — different
signal type, check the actual ask).

---

## Phase 4 — Open-source project hygiene

Beyond the community-profile checklist in Phase 0:

- **Versioning discipline** — `package.json`'s version, the latest git tag, and the latest
  `CHANGELOG.md` section should all agree. If `main` has accumulated substantial unreleased work
  (check `git log v<latest-tag>..origin/main --oneline | wc -l` — more than a handful of feature
  PRs is a signal), that's a real gap even if the changelog is technically accurate, because
  nothing's been tagged/released to match it.
- **CODEOWNERS** (`.github/CODEOWNERS`) still names real, current maintainers/teams.
- **Issue/PR templates** (`.github/ISSUE_TEMPLATE/`, `.github/pull_request_template.md`) still ask
  for information that matches the current contribution workflow.
- **Dependabot** (`.github/dependabot.yml`) covers every real package ecosystem in the repo (root
  npm, `web/`, `clients/js`, `clients/python`, Docker) — check for a manifest that exists on disk
  but isn't in a dependabot update group.
- **License clarity** — `LICENSE` is MIT for code; `assets/brand/BRAND.md` correctly carves out
  the trademark exception for the name/logo. Don't let these drift apart (e.g. someone adding a
  blanket "all rights reserved" note anywhere).
- **Client SDKs** (`clients/js`, `clients/python`) — version independently per `CHANGELOG.md`'s own
  header note; check they're not stuck on a version that predates a gateway change they depend on
  (e.g. a new endpoint the SDK doesn't wrap yet).

---

## Known gotchas (learned the hard way — check these every time)

- **Stacked-PR-squash trap.** A PR can show `merged: true` on GitHub while its actual commit never
  reached `main` — this happens when PR B's base is PR A's feature branch, and A gets
  squash-merged without B being retargeted first. Recurred 4 times in one project. Before trusting
  any "this shipped" claim: `git cat-file -e origin/main:<a file the PR added>`. If that fails, the
  PR's merged flag lied. Recovery is a cherry-pick of the stranded commit onto a fresh branch off
  current `main`.
- **The GHAS "CodeQL" diff-check has a standing false positive**: `js/missing-token-validation`
  flags `server/src/index.js`'s `cookieParser()` line because CodeQL's model doesn't recognize the
  `csrf-csrf` library (only the deprecated `csurf`). It resurfaces on any PR that shifts line
  numbers in `index.js`, even unrelated ones. Never add the GHAS `CodeQL` check to required status
  checks — it's non-deterministic-looking but is actually a permanent, known false positive on
  real, working CSRF protection.
- **`Publish image (green main)`** (in `ci.yml`) only runs `if: github.event_name == 'push' &&
  github.ref == 'refs/heads/main'` — it never runs on a PR. Adding it to required status checks
  would permanently block every PR (the check would never even start). The *workflow* job named
  "Analyze (JavaScript/TypeScript)" (from `codeql.yml`, distinct from the GHAS "CodeQL" check
  above) does run on PRs and is safe to require.
- **`docker-compose.gcp.yml` is `.gitignore`d** — it lives only on the VM, never in git. A fix that
  edits this file will never actually ship. Anything that should apply to every deployment (log
  rotation, resource limits) belongs in the base `docker-compose.yml` instead.
- **A GitHub branch-protection PUT is a full replace, not a merge.** Fetch the current protection
  JSON first and carry forward every field you're not intentionally changing — an incomplete PUT
  silently disables settings you didn't mean to touch.

---

## Reporting the findings

Present results grouped by phase, each finding as: what's wrong, the file/setting that proves it,
and must-fix vs. nice-to-have. Skip a phase's section entirely if it turned up nothing — don't
manufacture filler findings to look thorough. End with a short prioritized action list and ask
which items to act on before making any changes (docs edits go through a normal branch + PR;
repo-setting changes via `gh api`/`gh repo edit` are usually fine to apply directly once approved,
same as the settings changes made in this session's audit).
