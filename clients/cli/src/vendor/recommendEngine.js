// Vendored from server/src/recommend/engine.js (buildDoc + planRecommendations only —
// the MongoDB-backed recompute()/analyze() IO wrappers are deliberately left out).
// Kept in sync manually, same pattern as server/src/providers/llm-router/. This CLI
// ships standalone (npx/global install), outside the monorepo checkout, so it cannot
// `require("../../../server/src/...")` at runtime.
//
// Reads aggregated (taskType, model) groups and flags cases where a PREMIUM model is
// handling a CHEAP task type. For each, it re-prices the same tokens at a lighter
// model and reports the projected saving. No quality guess is made: the flag compares
// task type + model tier against the price table, never answer quality.

// Minimum requests in a group before we bother recommending.
const MIN_REQUESTS = 20;

// Build one recommendation doc. Pure. `grp` carries requests/tokens/cost for the scope.
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
    requestCount: grp.requests,
    currentCost: cost, projectedCost: projected, projectedSavings: saving,
    dedupeKey: application ? `premium_overuse:${application}:${taskType}:${model}` : `premium_overuse:${taskType}:${model}`,
  };
}

// Plan recommendations from per-(application, taskType, model, provider) groups. Pure.
// For each (taskType, model): emit an APP-SCOPED rec for every app that individually clears
// minRequests (so a downgrade proven for one app doesn't silently apply to others). Only when
// NO single app qualifies but the combined volume does, fall back to ONE global rec — so the two
// never overlap. A standalone audit with no `application` field on any group always takes the
// global-fallback path, which is exactly the flat, no-team-context view an individual needs.
function planRecommendations(groups, cheapTaskTypes, { isPremium, suggestLightTarget, costFor, minRequests = MIN_REQUESTS }) {
  const cheap = cheapTaskTypes instanceof Set
    ? cheapTaskTypes : new Set((cheapTaskTypes || []).map((x) => String(x).toLowerCase()));

  const byTM = new Map(); // taskType|model|provider -> { taskType, model, provider, apps:[], total }
  for (const g of groups) {
    const key = `${g.taskType}|${g.model}|${g.provider}`;
    if (!byTM.has(key)) byTM.set(key, { taskType: g.taskType, model: g.model, provider: g.provider, apps: [],
      total: { requests: 0, promptTokens: 0, completionTokens: 0, currentCost: 0 } });
    const e = byTM.get(key);
    e.apps.push(g);
    for (const f of ["requests", "promptTokens", "completionTokens", "currentCost"]) e.total[f] += g[f] || 0;
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

module.exports = { planRecommendations, MIN_REQUESTS };
