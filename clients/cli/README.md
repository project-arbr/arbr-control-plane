# arbr-cli

Audit a log of past LLM requests for premium-model overuse — no server, no database,
no signup. Point it at a file, get a number back.

```sh
npx arbr-cli audit --demo
```

That runs against a bundled sample log and writes `arbr-audit-report.html` — open it
in a browser. On your own data:

```sh
npx arbr-cli audit my-usage.jsonl
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

## License

MIT — see [LICENSE](./LICENSE).
