// Pure realised-savings math, split out from aggregate.js (which imports Mongo models) so it can
// be unit-tested without a database.
//
// groups: [{ requested, served, requests, promptTokens, completionTokens, actualCost }]
//   — substitution groups where the requested model differs from the served model.
// priceOf(modelId, promptTokens, completionTokens): baseline total cost at the REQUESTED model,
//   or null when that model is unknown/unpriceable.
function computeRealisedSavings(groups, priceOf) {
  let totalSaved = 0, substitutedRequests = 0;
  const rows = [];
  for (const g of groups || []) {
    const requested = g.requested;
    if (!requested || requested === "auto") continue; // no baseline for auto/absent requests
    const baselineCost = priceOf(requested, g.promptTokens, g.completionTokens);
    if (baselineCost == null) continue;                // unknown requested model — can't price
    const saved = baselineCost - g.actualCost;
    rows.push({ requested, served: g.served, requests: g.requests, baselineCost, actualCost: g.actualCost, saved });
    totalSaved += saved;
    substitutedRequests += g.requests;
  }
  rows.sort((a, b) => b.saved - a.saved);
  return { totalSaved, substitutedRequests, rows };
}

module.exports = { computeRealisedSavings };
