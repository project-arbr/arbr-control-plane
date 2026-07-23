# Changelog

## 0.3.0

- Added `arbr audit --url <base-url> [--admin-key <key>] [--from/--to <date>]` —
  pulls request history directly from a running Arbr instance's own
  `GET /api/requests/export` endpoint over HTTPS instead of requiring a manual
  `mongoexport` + JSONL reshape. Same local analysis either way (`runAuditFromRecords`
  is now shared between the file and remote paths). Prefer `$ARBR_ADMIN_KEY` over
  `--admin-key` to keep the key out of shell history.
- Reworked the HTML report to actually be shareable: real Arbr branding (the inlined
  wordmark, and the `signal`/`ink`/`paper` palette from `assets/brand/BRAND.md`,
  replacing an ad-hoc placeholder palette), Inter embedded as base64 woff2 (the same
  typeface already used to render Arbr's own social-preview card — bundled under
  `assets/fonts/`, added to the package's `files`), and a per-model spend bar chart
  instead of a plain table. Previously the report used only system fonts to keep the
  package smaller; in practice that made it look unfinished, which defeated the
  point of a report meant to be screenshotted or sent to someone.

## 0.2.0

- Added `arbr wrap <claude|codex|opencode|cursor>` — starts a local, loopback-only
  proxy, launches the agent with its traffic redirected through it, and reports
  spend/model-mix on exit (terminal summary + `arbr-wrap-report.html`). v1 does not
  run task classification on live traffic, so it has no premium-overuse
  recommendations — `audit` remains the way to get those. `codex`/`opencode` support
  is best-effort and not yet verified against real installs (see README).
- `report.js` gained a `mode: "audit" | "wrap"` option and a shared per-model spend
  breakdown table, reused by both subcommands.

## 0.1.0

- Initial release: `arbr audit <file.jsonl>` — standalone, zero-infra premium-model
  overuse audit, vendoring Arbr's recommend-engine and pricing-table logic. Prints a
  terminal summary and writes a self-contained HTML report in one pass. `--demo` mode
  runs against a bundled sample log with no input file required.
