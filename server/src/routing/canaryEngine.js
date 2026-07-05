// Hot-path canary selection. Decides whether an AUTO-routed request should be diverted to an
// experiment's candidate model. Cached like the rule set; pure bucketing/matching are separated
// and unit-tested. Every caller path is fail-open: any error here leaves normal routing intact.
const crypto = require("crypto");
const RoutingExperiment = require("../models/RoutingExperiment");

const TTL_MS = 15_000;
let _cache = { experiments: [], at: 0 };

function invalidate() { _cache.at = 0; }

async function activeExperiments() {
  if (Date.now() - _cache.at < TTL_MS) return _cache.experiments;
  const experiments = await RoutingExperiment.find({ status: "active" }).lean().catch(() => []);
  _cache = { experiments, at: Date.now() };
  return experiments;
}

// Deterministic 0-99 bucket for a (user, experiment) pair, so a given user is consistently in or
// out of the canary. Falls back to a stable per-request-context key when userId is absent. Pure.
function bucket(application, workflow, userId, experimentId) {
  const key = `${application || ""}|${workflow || ""}|${userId || "anon"}|${experimentId || ""}`;
  const hex = crypto.createHash("sha256").update(key).digest("hex").slice(0, 8);
  return parseInt(hex, 16) % 100;
}

// Does an experiment apply to this request? Scope null field = any. The request's currently
// served model must equal the experiment's baseline (that's what we divert from). Pure.
function matchExperiment(exp, { application, workflow, taskType, servedModel }) {
  if (!exp || exp.status !== "active") return false;
  if (exp.baselineModel !== servedModel) return false;
  const s = exp.scope || {};
  if (s.application && s.application !== application) return false;
  if (s.workflow && s.workflow !== workflow) return false;
  if (s.taskType && String(s.taskType).toLowerCase() !== String(taskType || "").toLowerCase()) return false;
  return true;
}

// Returns { experiment, toModel } when this request should be served by a candidate, else null.
async function selectCanary(ctx) {
  try {
    const experiments = await activeExperiments();
    for (const exp of experiments) {
      if (!matchExperiment(exp, ctx)) continue;
      if (bucket(ctx.application, ctx.workflow, ctx.userId, String(exp._id)) < (exp.rolloutPct || 0)) {
        return { experiment: exp, toModel: exp.candidateModel };
      }
    }
  } catch { /* fail-open */ }
  return null;
}

module.exports = { selectCanary, activeExperiments, invalidate, bucket, matchExperiment };
