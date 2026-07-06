// Pure aggregation of raw result rows → the cost-vs-quality summary (unit-tested).
// quality = mean score over SCORED rows (unscored categories excluded, not counted as 0).
// Derives, vs always-premium: quality retained % and cost %.

function latencyPct(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function summarize(rows) {
  const acc = {};
  for (const r of rows) {
    const b = acc[r.baseline] || (acc[r.baseline] = { n: 0, errors: 0, scoredN: 0, scoreSum: 0, costSum: 0, unpriced: 0, cat: {}, latencies: [] });
    b.n++;
    if (r.error) { b.errors++; continue; }
    if (r.priced === false) b.unpriced++;
    b.costSum += Number(r.costUsd) || 0;
    if (r.latencyMs != null) b.latencies.push(Number(r.latencyMs));
    if (r.scored) {
      b.scoredN++; b.scoreSum += Number(r.score) || 0;
      const c = b.cat[r.category] || (b.cat[r.category] = { n: 0, sum: 0 });
      c.n++; c.sum += Number(r.score) || 0;
    }
  }
  const out = {};
  for (const k of Object.keys(acc)) {
    const b = acc[k];
    const sorted = [...b.latencies].sort((a, x) => a - x);
    out[k] = {
      baseline: k, n: b.n, errors: b.errors, scoredN: b.scoredN, unpriced: b.unpriced,
      quality: b.scoredN ? b.scoreSum / b.scoredN : null,
      totalCost: b.costSum,
      costPerQuery: b.n ? b.costSum / b.n : 0,
      latencyP50: latencyPct(sorted, 0.5),
      latencyP95: latencyPct(sorted, 0.95),
      latencyMax: sorted.length ? sorted[sorted.length - 1] : null,
      byCategory: Object.fromEntries(Object.keys(b.cat).map((cat) => [cat, b.cat[cat].n ? b.cat[cat].sum / b.cat[cat].n : null])),
    };
  }
  const prem = out["always-premium"];
  for (const k of Object.keys(out)) {
    if (prem && prem.quality) out[k].qualityRetainedPct = out[k].quality != null ? (out[k].quality / prem.quality) * 100 : null;
    if (prem && prem.costPerQuery > 0) out[k].costVsPremiumPct = (out[k].costPerQuery / prem.costPerQuery) * 100;
  }
  return out;
}

module.exports = { summarize };
