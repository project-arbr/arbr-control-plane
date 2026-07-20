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

// Build one recommendation doc. Pure. `grp` carries requests/tokens/cost/replayable for the scope.
function buildDoc({ application, taskType, model, provider, grp, target, projected, saving }) {
  const cost = grp.currentCost || 0;
  const pct = cost > 0 ? Math.round((saving / cost) * 100) : 0;
  const scope = application ? ` in '${application}'` : "";
  return {
    type: "premium_model_overuse",
    title: `${pct}% of '${taskType}' spend${scope} is on a premium model (${model})`,
    reason:
      `${grp.requests} '${taskType}' requests${scope} ran on ${model} (premium tier). ` +
      `'${taskType}' is a low-complexity task type; re-pricing the same ` +
      `${((grp.promptTokens || 0) + (grp.completionTokens || 0)).toLocaleString()} tokens on ${target.model} ` +
      `would cost $${projected.toFixed(2)} instead of $${cost.toFixed(2)} — ` +
      `an estimated saving of $${saving.toFixed(2)}. ` +
      `Flagged by comparing task type and model tier against the price table, not answer quality.`,
    application: application || null,
    taskType, currentModel: model, currentProvider: provider,
    suggestedModel: target.model, suggestedProvider: target.provider,
    requestCount: grp.requests, replayableCount: grp.replayable || 0,
    currentCost: cost, projectedCost: projected, projectedSavings: saving,
    dedupeKey: application ? `premium_overuse:${application}:${taskType}:${model}` : `premium_overuse:${taskType}:${model}`,
  };
}

// Plan recommendations from per-(application, taskType, model, provider) groups. Pure.
// For each (taskType, model): emit an APP-SCOPED rec for every app that individually clears
// MIN_REQUESTS (so a downgrade proven for one app doesn't silently apply to others). Only when
// NO single app qualifies but the combined volume does, fall back to ONE global rec — so the two
// never overlap (a global rule would otherwise also match the app-scoped ones).
function planRecommendations(groups, cheapTaskTypes, { isPremium, suggestLightTarget, costFor, minRequests = MIN_REQUESTS }) {
  const cheap = cheapTaskTypes instanceof Set
    ? cheapTaskTypes : new Set((cheapTaskTypes || []).map((x) => String(x).toLowerCase()));

  const byTM = new Map(); // taskType|model|provider -> { taskType, model, provider, apps:[], total }
  for (const g of groups) {
    const key = `${g.taskType}|${g.model}|${g.provider}`;
    if (!byTM.has(key)) byTM.set(key, { taskType: g.taskType, model: g.model, provider: g.provider, apps: [],
      total: { requests: 0, promptTokens: 0, completionTokens: 0, currentCost: 0, replayable: 0 } });
    const e = byTM.get(key);
    e.apps.push(g);
    for (const f of ["requests", "promptTokens", "completionTokens", "currentCost", "replayable"]) e.total[f] += g[f] || 0;
  }

  const out = [];
  for (const e of byTM.values()) {
    if (!isPremium(e.model)) continue;
    if (!cheap.has(String(e.taskType || "").toLowerCase())) continue;
    const target = suggestLightTarget(e.model);
    if (!target) continue;
    const mk = (application, grp) => {
      const projected = costFor(target.model, grp.promptTokens, grp.completionTokens).totalCost;
      const saving = (grp.currentCost || 0) - projected;
      return saving > 0 ? buildDoc({ application, taskType: e.taskType, model: e.model, provider: e.provider, grp, target, projected, saving }) : null;
    };
    let emittedAppScoped = false;
    for (const g of e.apps) {
      if (!g.application || g.application === "unknown" || (g.requests || 0) < minRequests) continue;
      const d = mk(g.application, g);
      if (d) { out.push(d); emittedAppScoped = true; }
    }
    if (!emittedAppScoped && e.total.requests >= minRequests) {
      const d = mk(null, e.total);
      if (d) out.push(d);
    }
  }
  return out.sort((a, b) => b.projectedSavings - a.projectedSavings);
}

async function recompute() {
  // Use the effective routing policy so custom cheap task types (added by the user
  // via Routing → Automated routing) are respected — not just the hardcoded defaults.
  const policy = await getEffective();

  // Aggregate token totals per (application, taskType, model, provider) so recommendations can
  // be scoped to the app whose traffic justifies them (routing is already app-aware).
  const agg = await RequestRecord.aggregate([
    // Customer traffic only. Recommending that Arbr downgrade its own classifier is
    // not actionable advice for a customer, and it would be scoped to an application
    // that doesn't exist.
    { $match: { status: "success", ...RequestRecord.CUSTOMER_ONLY } },
    {
      $group: {
        _id: { application: "$application", taskType: "$taskType", model: "$model", provider: "$provider" },
        requests: { $sum: 1 },
        promptTokens: { $sum: "$promptTokens" },
        completionTokens: { $sum: "$completionTokens" },
        currentCost: { $sum: "$totalCost" },
        // Requests an eval could actually replay: captured prompt + response, not a cache hit.
        // (Single-shot is refined at dataset build; this is the readiness estimate.)
        replayable: { $sum: { $cond: [{ $and: [
          { $ne: ["$messages", null] },
          { $gt: [{ $strLenCP: { $ifNull: ["$responseText", ""] } }, 0] },
          { $ne: ["$cacheHit", true] },
        ] }, 1, 0] } },
      },
    },
  ]);

  const groups = agg.map((g) => ({
    application: g._id.application, taskType: g._id.taskType, model: g._id.model, provider: g._id.provider,
    requests: g.requests, promptTokens: g.promptTokens, completionTokens: g.completionTokens,
    currentCost: g.currentCost, replayable: g.replayable,
  }));
  const planned = planRecommendations(groups, policy.cheapTaskTypes, {
    isPremium: pricing.isPremium, suggestLightTarget: pricing.suggestLightTarget, costFor: pricing.costFor,
  });

  const results = [];
  const emittedKeys = [];
  for (const doc of planned) {
    emittedKeys.push(doc.dedupeKey);
    // Upsert by dedupeKey, but never clobber a human decision (accepted/dismissed).
    const existing = await Recommendation.findOne({ dedupeKey: doc.dedupeKey });
    if (existing && existing.status !== "pending") { results.push(existing); continue; }
    const saved = await Recommendation.findOneAndUpdate(
      { dedupeKey: doc.dedupeKey },
      { $set: { ...doc, status: "pending" } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    results.push(saved);
  }
  // Drop stale PENDING recs that current traffic no longer supports (keeps accepted/dismissed).
  // Also clears old global recs superseded by app-scoped ones after this change.
  await Recommendation.deleteMany({ status: "pending", dedupeKey: { $nin: emittedKeys } });

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
    { $match: { status: "success", ...RequestRecord.CUSTOMER_ONLY } },
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

module.exports = { recompute, analyze, analyzeGroups, planRecommendations };
