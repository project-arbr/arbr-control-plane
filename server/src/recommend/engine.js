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

// Explain the recommendation landscape so an empty Recompute is never a dead end. Pure.
// groups: [{ taskType, model, provider, requests, promptTokens, completionTokens, currentCost }].
// The key output is `unmarkedOpportunities`: (task type × premium model) groups with a real saving
// that are EXCLUDED only because the task type isn't marked cheap — the money hiding in plain sight.
function analyzeGroups(groups, cheapTaskTypes, { isPremium, suggestLightTarget, costFor, minRequests = MIN_REQUESTS }) {
  const cheap = cheapTaskTypes instanceof Set
    ? cheapTaskTypes
    : new Set((cheapTaskTypes || []).map((x) => String(x).toLowerCase()));

  let analyzedRequests = 0, analyzedCost = 0, flaggedGroups = 0;
  const unmarked = [];
  for (const g of groups) {
    analyzedRequests += g.requests || 0;
    analyzedCost += g.currentCost || 0;
    if ((g.requests || 0) < minRequests) continue;
    if (!isPremium(g.model)) continue;
    const target = suggestLightTarget(g.model);
    if (!target) continue;
    const projected = costFor(target.model, g.promptTokens, g.completionTokens).totalCost;
    const projectedSavings = (g.currentCost || 0) - projected;
    if (projectedSavings <= 0) continue;

    if (cheap.has(String(g.taskType || "").toLowerCase())) { flaggedGroups++; continue; } // already recommended
    unmarked.push({
      taskType: g.taskType, model: g.model, suggestedModel: target.model,
      requests: g.requests, currentCost: g.currentCost || 0, projectedSavings,
    });
  }
  unmarked.sort((a, b) => b.projectedSavings - a.projectedSavings);
  return {
    analyzedRequests, analyzedCost, flaggedGroups,
    unmarkedOpportunities: unmarked,
    unmarkedPotentialSavings: unmarked.reduce((s, u) => s + u.projectedSavings, 0),
    suggestMarkCheap: [...new Set(unmarked.map((u) => String(u.taskType || "").toLowerCase()))],
  };
}

// IO wrapper: aggregate the logged traffic + effective policy, then analyze. Returns the
// analysis plus the current cheapTaskTypes (so the UI can offer a one-click "mark cheap").
async function analyze() {
  const policy = await getEffective();
  const agg = await RequestRecord.aggregate([
    { $match: { status: "success" } },
    { $group: {
        _id: { taskType: "$taskType", model: "$model", provider: "$provider" },
        requests: { $sum: 1 },
        promptTokens: { $sum: "$promptTokens" },
        completionTokens: { $sum: "$completionTokens" },
        currentCost: { $sum: "$totalCost" },
    } },
  ]);
  const groups = agg.map((g) => ({
    taskType: g._id.taskType, model: g._id.model, provider: g._id.provider,
    requests: g.requests, promptTokens: g.promptTokens, completionTokens: g.completionTokens, currentCost: g.currentCost,
  }));
  const a = analyzeGroups(groups, policy.cheapTaskTypes, {
    isPremium: pricing.isPremium, suggestLightTarget: pricing.suggestLightTarget, costFor: pricing.costFor,
  });
  return { ...a, cheapTaskTypes: [...policy.cheapTaskTypes] };
}

module.exports = { recompute, analyze, analyzeGroups };
