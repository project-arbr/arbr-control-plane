# Changelog

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
