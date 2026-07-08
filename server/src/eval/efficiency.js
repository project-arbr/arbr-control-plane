// Quality-per-dollar — the one legible "intelligence per dollar" number for a benchmark run.
// Pure + dependency-free so it unit-tests without a DB. (DoorDash's DashBench lesson: rank
// candidates on YOUR traffic by quality vs cost, and price the model on cost-per-SUCCESSFUL
// response — retries/format failures included — not the sticker rate.)
//
//   summary       — an EvalRun.summary: { judged, worseRate, formatPassRate, ... }
//   actualCostUsd — the candidate's real spend over the replayed items (excludes the judge)
//
// Returns { qualityScore, costPer1kUsd, qualityPerDollar } — any field null when it can't be
// computed (nothing judged, or zero cost). Higher qualityPerDollar is better.
function efficiencyOf(summary, actualCostUsd) {
  const s = summary || {};
  const judged = Number(s.judged) || 0;
  if (judged <= 0) return { qualityScore: null, costPer1kUsd: null, qualityPerDollar: null };

  // Quality = share of judged items where the candidate was NOT worse than the baseline, discounted
  // by how often it produced a usable (format-valid) response. A model that's "as good" but emits
  // malformed output half the time should not rank as high-quality.
  const notWorse = 1 - Math.max(0, Math.min(1, Number(s.worseRate) || 0));
  const formatPass = s.formatPassRate == null ? 1 : Math.max(0, Math.min(1, Number(s.formatPassRate)));
  const qualityScore = +(notWorse * formatPass).toFixed(4);

  // Cost per 1,000 requests = the candidate's average real cost per replayed item, scaled up.
  const cost = Number(actualCostUsd) || 0;
  const costPer1kUsd = cost > 0 ? +((cost / judged) * 1000).toFixed(4) : 0;

  // Quality per dollar (per 1k requests). Free models (cost 0) rank by quality alone → Infinity,
  // which sorts them first; that's intended (free + good is the best deal).
  const qualityPerDollar = costPer1kUsd > 0 ? +(qualityScore / costPer1kUsd).toFixed(4)
    : (qualityScore > 0 ? Infinity : 0);

  return { qualityScore, costPer1kUsd, qualityPerDollar };
}

module.exports = { efficiencyOf };
