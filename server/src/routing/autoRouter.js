// Automated routing — the live, policy-approved cost guardrail. Deterministic and
// subordinate to human rules: the gateway consults this only in auto mode, when no
// explicit rule matched and the policy is enabled.
//
// The policy (editable from the dashboard) decides:
//   - cheapTaskTypes: which task types are eligible
//   - lightTargets:   the downgrade target model per provider
//   - mode: "conservative" downgrades only PREMIUM models; "aggressive" downgrades
//           anything strictly costlier than the target (e.g. light → lightest).
// It never upgrades and never cross-grades, and stays fully reversible.
const pricing = require("../pricing/registry");

function totalPrice(m) {
  return m.inputPer1M + m.outputPer1M;
}

// Returns { provider, model } to serve instead of the requested model, or null
// to leave the request untouched (passthrough). `policy` is the effective policy
// from routing/policy.js (cheapTaskTypes:Set, lightTargets:{}, mode).
function selectAutoRoute({ taskType, requested }, policy) {
  if (!policy || !requested || !requested.model) return null;
  if (!policy.cheapTaskTypes.has(String(taskType || "").toLowerCase())) return null;

  const current = pricing.getModel(requested.model);
  if (!current) return null;

  const target = policy.lightTargets[current.provider];
  if (!target || target === requested.model) return null;
  const targetModel = pricing.getModel(target);
  if (!targetModel) return null;

  if (policy.mode === "aggressive") {
    // Downgrade anything strictly more expensive than the target (no upgrades).
    if (totalPrice(current) <= totalPrice(targetModel)) return null;
  } else {
    // Conservative (default): only downgrade premium-tier models.
    if (current.tier !== "premium") return null;
  }

  return { provider: current.provider, model: target };
}

module.exports = { selectAutoRoute };
