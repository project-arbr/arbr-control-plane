# Design-partner demo fixture

A scripted, ~10-minute walkthrough of the full optimization lifecycle — opportunity → eval →
canary → promote → measured outcome, plus a rollback — that runs entirely without a live
provider key. Use it to show a design partner the complete product story live, not a tour of
already-finished dashboard pages.

## How this works without any provider key

Two things make this possible:

1. **Traffic, dashboards, and every stage transition already work on stored data alone** — the
   Recommendations page, canary guardrail table, and evidence report (`GET
   /recommendations/:id/report`) all render entirely from what's in MongoDB. Nothing needs a
   live call to be *displayed*.
2. **"Run eval" is the one step that normally needs a live provider** (to get a candidate
   model's real response and judge it). For fixture recommendations only, the server detects
   there's no live provider configured and synthesizes a result instead — using the exact same
   pass/fail gating logic production uses (`aggregate()` + `evaluateRun()`), just fed synthetic
   per-item data. The button in the real UI still does something real; it just isn't a live
   LLM call for this one demo-only case.

## Setup

```sh
npm run demo:seed
```

**Prerequisite: payload capture must be on** (it's the dev default — `captureRequestPayloads`
under Settings → Observability). The seed script writes real, replayable synthetic traffic so
"Build eval dataset" samples genuine documents through the real dataset builder; if payload
capture is off, that step will fail with the same message it would for any real recommendation
("Turn on payload capture..."). This is the only prerequisite — no provider keys needed.

This creates 3 recommendations, visible on the **Recommendations** page:

| Recommendation | Starts at | What it's for |
|---|---|---|
| `demo-fixture:happy-path` | Opportunity | Walk live to a passing eval → canary → promote |
| `demo-fixture:failing-candidate` | Opportunity | Walk live to a failing eval (quality gate blocks it) |
| `demo-fixture:rollback-scenario` | Canary running, already breaching | Trigger a live manual rollback |

## The script (~10 minutes)

**1. The opportunity (1 min).** Open `demo-fixture:happy-path`. Point out the projected
savings, the model substitution (`gpt-4o` → `gpt-4o-mini`), and the request count — this
recommendation was generated from real (synthetic) traffic, the same way a real one would be.

**2. Build the dataset, run the eval (2 min).** Click **Build eval dataset**, then **Run
offline eval**. The result lands in seconds: **passed**, with a real summary (worse-rate,
cost saving, latency delta) computed by the same gating logic that decides every real eval.

**3. The failing candidate (2 min).** Switch to `demo-fixture:failing-candidate`. Build its
dataset, run its eval — this one **fails**, with real reasons (`worse-rate X% exceeds Y%`,
etc.). This is the point: a bad substitution gets caught before it ever reaches production
traffic. Try **Accept as rule** without an override — the gate blocks it (`409 eval_required`).

**4. Roll out the passing one (2 min).** Back on `demo-fixture:happy-path`: click **Start
canary** (or **Accept as rule** first, then **Enable rule** — both paths exist). Watch the
card's stage badge move to *Canary running* and the guardrail table appear — configured
threshold beside the live value, with a red/green status dot per row, same as what an active
canary shows for real traffic.

**5. Promote (1 min).** Click **Promote**. The stage badge moves to *Live*. Expand **Show
measured outcome** — projected vs. realised savings, latency, and error rate, with the
approximation caveat always visible (realised savings will read close to $0 here, honestly,
since no live traffic has actually flowed through the promoted rule during the demo — point
this out as the real, non-fabricated behavior it is).

**6. Export the evidence (1 min).** Click **Report (.md)** on the same card — a durable,
regenerable record of the whole journey: scope, eval summary, rollout history, and the outcome
section, all in one file.

**7. The rollback (1 min).** Switch to `demo-fixture:rollback-scenario` — already at *Canary
running* with a breached guardrail (a genuinely elevated error rate baked into its seeded
traffic, not just a fabricated number). Click **Roll back**, enter a reason. The stage moves
to *Rolled back*, with the reason visible on the card.

## Reset

```sh
npm run demo:reset
```

Deletes only documents created by this fixture (every one is tagged `isDemoFixture: true`
internally) — safe to run in a database that also has real recommendations; nothing else is
touched. Idempotent: `demo:seed` can be re-run any number of times without duplicating data.

## Troubleshooting

- **"Create a ready eval dataset first" / dataset build fails immediately** — payload capture
  is off. Enable it under Settings → Observability and re-run `npm run demo:seed`, or just
  retry the "Build eval dataset" click once it's on (the seeded traffic doesn't need
  re-creating).
- **A recommendation from `demo:seed` is missing after `demo:reset`** — that's the point; reset
  is meant to remove it. Re-run `demo:seed`.
