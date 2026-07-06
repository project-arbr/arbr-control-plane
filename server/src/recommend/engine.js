// Recommendation engine (Phase-1 MVP: one type — premium-model overuse).
//
// Reads the logged data and flags (taskType, model) groups where a PREMIUM model
// is handling a CHEAP task type. For each, it re-prices the same tokens at a
// lighter model and reports the projected saving. Advisory only — a person
// accepts (→ disabled rule) or dismisses. No quality guess is made: the flag
// compares task type + model tier against the price table, never answer quality.
const RequestRecord = require("../models/RequestRecord");
const Recommendation = require("../models/Recommendation");
const pricing = require("../pricing/registry");
const { getEffective } = require("../routing/policy");

// Minimum requests in a group before we bother recommending.
const MIN_REQUESTS = 20;

async function recompute() {
  // Use the effective routing policy so custom cheap task types (added by the user
  // via Routing → Automated routing) are respected — not just the hardcoded defaults.
  const policy = await getEffective();

  // Aggregate token totals per (taskType, model, provider).
  const groups = await RequestRecord.aggregate([
    { $match: { status: "success" } },
    {
      $group: {
        _id: { taskType: "$taskType", model: "$model", provider: "$provider" },
        requests: { $sum: 1 },
        promptTokens: { $sum: "$promptTokens" },
        completionTokens: { $sum: "$completionTokens" },
        currentCost: { $sum: "$totalCost" },
      },
    },
  ]);

  const results = [];
  for (const g of groups) {
    const { taskType, model, provider } = g._id;
    if (g.requests < MIN_REQUESTS) continue;
    if (!pricing.isPremium(model)) continue;
    if (!policy.cheapTaskTypes.has(String(taskType || "").toLowerCase())) continue;

    const target = pricing.suggestLightTarget(model);
    if (!target) continue;

    // Re-price the same tokens at the target model.
    const projected = pricing.costFor(target.model, g.promptTokens, g.completionTokens);
    const projectedSavings = g.currentCost - projected.totalCost;
    if (projectedSavings <= 0) continue;

    const dedupeKey = `premium_overuse:${taskType}:${model}`;
    const pct = Math.round((projectedSavings / g.currentCost) * 100);
    const doc = {
      type: "premium_model_overuse",
      title: `${pct}% of '${taskType}' spend is on a premium model (${model})`,
      reason:
        `${g.requests} '${taskType}' requests ran on ${model} (premium tier). ` +
        `'${taskType}' is a low-complexity task type; re-pricing the same ` +
        `${(g.promptTokens + g.completionTokens).toLocaleString()} tokens on ${target.model} ` +
        `would cost $${projected.totalCost.toFixed(2)} instead of $${g.currentCost.toFixed(2)} — ` +
        `an estimated saving of $${projectedSavings.toFixed(2)}. ` +
        `Flagged by comparing task type and model tier against the price table, not answer quality.`,
      taskType,
      currentModel: model,
      currentProvider: provider,
      suggestedModel: target.model,
      suggestedProvider: target.provider,
      requestCount: g.requests,
      currentCost: g.currentCost,
      projectedCost: projected.totalCost,
      projectedSavings,
      dedupeKey,
    };

    // Upsert by dedupeKey, but never clobber a human decision (accepted/dismissed).
    const existing = await Recommendation.findOne({ dedupeKey });
    if (existing && existing.status !== "pending") {
      results.push(existing);
      continue;
    }
    const saved = await Recommendation.findOneAndUpdate(
      { dedupeKey },
      { $set: { ...doc, status: "pending" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    results.push(saved);
  }

  return results.sort((a, b) => b.projectedSavings - a.projectedSavings);
}

module.exports = { recompute };
