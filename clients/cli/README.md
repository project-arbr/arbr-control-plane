# arbr-audit

Audit a log of past LLM requests for premium-model overuse, or wrap a coding agent
live to see what a session costs — no server, no database, no signup.

```sh
npx arbr-audit audit --demo
```

That runs against a bundled sample log and writes `arbr-audit-report.html` — open it
in a browser. On your own data:

```sh
npx arbr-audit audit my-usage.jsonl
```

## What it does

`arbr audit` reads a newline-delimited JSON (JSONL) file of past requests, groups them
by task type and model, and flags groups where a **premium-tier model** is handling a
**task type that's usually cheap work** (classification, extraction, summarisation,
translation, FAQ, support response). For each flagged group, it re-prices the same
token volume at a lighter model on the same provider and reports the projected saving.

This reuses Arbr's actual recommendation logic (`server/src/recommend/engine.js`'s
`planRecommendations`) and static pricing table, vendored into this package so it can
run standalone, outside a full Arbr install — see `src/vendor/` for the vendored
copies and why they're copied rather than imported.

The flag compares task type and model tier against a price table — it never judges
answer quality. Treat every suggestion as something to verify against your own traffic
before switching, not an automatic instruction.

## Input format

One JSON object per line. Field names match Arbr's own request-log schema
(`server/src/models/RequestRecord.js`) — reuse them rather than reshaping your data:

```json
{"taskType": "classification", "model": "claude-opus-4-8", "provider": "anthropic", "promptTokens": 420, "completionTokens": 85, "totalCost": 0.0086}
```

Required per line: `taskType`, `model`, `promptTokens`, `completionTokens`, `totalCost`.
`provider` is optional — if omitted, it's inferred from `model` via the bundled pricing
table when the model is recognized.

Already running Arbr, even solo? Export your `RequestRecord` collection into this same
shape (e.g. `mongoexport --collection=request_records --fields=taskType,model,provider,promptTokens,completionTokens,totalCost` to JSONL) for a real audit instead of the demo.

## Usage

```
arbr audit <file.jsonl> [--out <report.html>] [--cheap-task-types a,b,c]
arbr audit --demo [--out <report.html>]
```

| Flag | Default | Purpose |
|---|---|---|
| `--out <path>` | `./arbr-audit-report.html` | where the HTML report is written |
| `--cheap-task-types <csv>` | classification, extraction, summarisation, translation, faq, support response | override which task types count as "should be cheap" |
| `--demo` | — | run against the bundled sample log instead of a file |

Every run prints a terminal summary immediately, then writes the fuller HTML report —
the same pass over the data produces both.

## `arbr wrap` — live session spend, no log file needed

```sh
arbr wrap claude    # or: codex, opencode, cursor
```

Starts a local proxy on `127.0.0.1` (never reachable from the network), launches the
agent with its API traffic redirected through it, and reports spend + model mix when
the session ends — the terminal summary plus an `arbr-wrap-report.html`, same as
`audit`. **v1 reports spend and model mix only** — it does not run task
classification on live traffic, so it can't produce `audit`'s "switch model X → Y"
recommendations (that needs a task label per request, which live agent traffic
doesn't have). `arbr audit` remains the way to get those.

Per-agent support, and what to know before relying on each:

| Agent | Mechanism | Status |
|---|---|---|
| `claude` | `ANTHROPIC_BASE_URL` env var (Anthropic's documented gateway pattern) | Transparent — no file touched |
| `codex` | Temporary `~/.codex/config.toml` patch (backed up and restored on exit, including on Ctrl-C) | **Unverified against a real install** — a past Codex GitHub issue reported config.toml overrides not always being respected; test it yourself before relying on it. Use `--codex-home <path>` to point at an isolated config dir instead of your real one. |
| `opencode` | `OPENCODE_CONFIG_CONTENT` env var, injecting a new `arbr` provider | Not transparent — you must select a model under `arbr/<model-id>` in the session for it to be observed. **Unverified against a real install**; two open OpenCode issues report custom `baseURL`/`headers` not always reaching the real request. |
| `cursor` | None — Cursor CLI's endpoint override is reported broken upstream | Prints manual IDE setup steps (Settings → Models → Override OpenAI Base URL) instead of automating anything |

The `codex` config patch is written defensively (original content kept in memory,
a timestamped backup file written alongside it, restored in a `finally` block and on
`SIGINT`/`SIGTERM`) but has not been exercised against a real Codex installation as
part of this change — only the file-patching logic itself is unit-tested, against
temp files, never a real `~/.codex`. Treat `codex`/`opencode` wrap support as
best-effort until you've verified it against your installed CLI version.

## Why this exists

Arbr itself is a self-hosted, team-oriented control plane (MongoDB + Docker + a
dashboard) — real infrastructure for observing and governing an organization's LLM
spend. This CLI is deliberately smaller: a zero-infra way for one person to see, in
under a minute, whether their own traffic has an obvious premium-model overuse pattern
— using the same underlying logic Arbr's dashboard uses, without needing to run Arbr
at all.

## Development

```sh
npm test          # unit tests
npm run audit:demo  # exercise the CLI end-to-end against the bundled fixture
```

The two files under `src/vendor/` are manually-synced copies of
`server/src/pricing/table.js` and the pure parts of `server/src/recommend/engine.js`.
If either upstream file changes in a way that affects pricing or the recommendation
algorithm, update the vendored copy here too — there's no build step that does this
automatically, the same tradeoff already made for `server/src/providers/llm-router/`.

`wrap`'s proxy core (`src/wrap.js`) is *not* vendored from `server/src/gateway/
openaiCompat.js` — it follows the same fetch → stream-bytes-back → parse-usage
technique but is freshly written, since Arbr's own native (Anthropic/Gemini/Bedrock)
provider path round-trips through LangChain and doesn't stream token-by-token, so
there was nothing directly reusable for that path.

## License

MIT — see [LICENSE](./LICENSE).
