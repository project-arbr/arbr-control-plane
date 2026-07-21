// Pure, dependency-free lifecycle-stage derivation for a Recommendation (no mongoose), so it
// unit-tests without a DB — mirrors eval/thresholds.js's style.
//
// A Recommendation's real lifecycle stage is scattered across 5 collections
// (Recommendation.status/evalStatus, EvalDataset.status, EvalRun.status, EvalCampaign.status,
// RoutingExperiment.status, Rule.enabled+qualityGate). This computes ONE stage fresh from
// whatever's linked right now — never stored, so it can't drift from reality and never fights
// recommend/engine.js's recompute() (which already assumes today's scattered shape and never
// overwrites a human decision).

const STAGES = {
  OPPORTUNITY: "opportunity",
  DATASET_BUILDING: "dataset_building",
  DATASET_READY: "dataset_ready",
  EVALUATING: "evaluating",
  EVAL_FAILED: "eval_failed",
  READY_FOR_ROLLOUT: "ready_for_rollout",
  ACCEPTED_AWAITING_ENABLE: "accepted_awaiting_enable",
  SHADOW_RUNNING: "shadow_running",
  CANARY_RUNNING: "canary_running",
  ROLLED_BACK: "rolled_back",
  PROMOTED_LIVE: "promoted_live",
  DISMISSED: "dismissed",
};

// Per-stage label + next-action. actionKey is one of a fixed set the frontend has a handler
// for: build_dataset | run_eval | accept | start_canary | enable_rule | view_guardrails |
// dismiss | review_rollback | none.
function result(stage, extra, text, actionKey) {
  return { stage, label: LABELS[stage], nextAction: { text, actionKey }, ...extra };
}

const LABELS = {
  [STAGES.OPPORTUNITY]: "Opportunity",
  [STAGES.DATASET_BUILDING]: "Building dataset",
  [STAGES.DATASET_READY]: "Dataset ready",
  [STAGES.EVALUATING]: "Evaluating",
  [STAGES.EVAL_FAILED]: "Eval failed",
  [STAGES.READY_FOR_ROLLOUT]: "Ready for rollout",
  [STAGES.ACCEPTED_AWAITING_ENABLE]: "Accepted — rule disabled",
  [STAGES.SHADOW_RUNNING]: "Shadow running",
  [STAGES.CANARY_RUNNING]: "Canary running",
  [STAGES.ROLLED_BACK]: "Rolled back",
  [STAGES.PROMOTED_LIVE]: "Live",
  [STAGES.DISMISSED]: "Dismissed",
};

// ctx: { rec, dataset, run, campaign, experiment, rules }
// dataset/run/campaign/experiment are plain lean objects or null. rules is the array of ALL
// Rule docs with sourceRecommendation === rec._id (0, 1, or 2 — accept path + canary-promote
// path can each produce one).
function deriveStage(ctx) {
  const { rec, dataset, run, campaign, experiment, rules } = ctx || {};

  if (rec.status === "dismissed") {
    return result(STAGES.DISMISSED, {}, null, "none");
  }

  // Highest precedence: reality on the wire always wins over any stale rec/experiment field.
  const liveRule = (rules || []).find((r) => r.enabled);
  if (liveRule) {
    const since = liveRule.updatedAt ? new Date(liveRule.updatedAt).toLocaleDateString() : "recently";
    return result(STAGES.PROMOTED_LIVE, { rule: liveRule },
      `Live in production since ${since} — review measured savings/latency/errors.`, "none");
  }

  if (experiment) {
    if (experiment.status === "rolled_back") {
      return result(STAGES.ROLLED_BACK, { experiment },
        `Rolled back: ${experiment.rollbackReason || "guardrail breach"}. Review and dismiss, or retry with adjusted scope.`,
        "review_rollback");
    }
    if (experiment.status === "active" || experiment.status === "paused") {
      return result(STAGES.CANARY_RUNNING, { experiment },
        `Canary live at ${experiment.rolloutPct}% — watch guardrail status; promote or roll back.`,
        "view_guardrails");
    }
    // experiment.status === "promoted" but no enabled rule found (race/deleted rule) falls through.
  }

  if (campaign && (campaign.status === "active" || campaign.status === "paused")) {
    return result(STAGES.SHADOW_RUNNING, { campaign },
      "Shadow campaign mirroring traffic — wait for the minPairs/maxLossRate verdict.", "none");
  }

  if (rec.status === "accepted") {
    return result(STAGES.ACCEPTED_AWAITING_ENABLE, { rules },
      "Rule created but disabled — enable it to start routing traffic, or start a canary.",
      "enable_rule");
  }

  if (run) {
    if (run.status === "queued" || run.status === "running") {
      return result(STAGES.EVALUATING, { run }, "Eval is running — refresh to see the result.", "none");
    }
    if (run.status === "failed") {
      return result(STAGES.EVAL_FAILED, { run },
        "Eval failed. Adjust scope/dataset and retry, or accept with an override reason.", "run_eval");
    }
    if (run.status === "passed") {
      return result(STAGES.READY_FOR_ROLLOUT, { run },
        "Eval passed — accept as a rule, or start a canary to prove it on live traffic first.", "accept");
    }
  }
  if (rec.evalStatus === "overridden") {
    return result(STAGES.READY_FOR_ROLLOUT, { override: rec.override },
      "Eval overridden — accept as a rule, or start a canary to prove it on live traffic first.", "accept");
  }

  if (dataset) {
    return dataset.status === "ready"
      ? result(STAGES.DATASET_READY, { dataset }, "Run the offline eval against the built dataset.", "run_eval")
      : result(STAGES.DATASET_BUILDING, { dataset }, "Dataset is being built — check back shortly.", "none");
  }

  if (rec.replayableCount === 0) {
    return result(STAGES.OPPORTUNITY, {},
      "No replayable traffic yet — turn on payload capture, or wait for more traffic, before building a dataset.",
      "none");
  }
  return result(STAGES.OPPORTUNITY, {}, "Build an eval dataset to start proving this substitution.", "build_dataset");
}

module.exports = { STAGES, deriveStage };
