// Deterministic cost from usage + the published price table. Pure (unit-tested).
function costUsd(model, usage, prices) {
  const p = prices[model];
  if (!p) return { usd: 0, priced: false }; // unknown model → flag so it's visible, not silently $0
  const inTok = (usage && usage.prompt_tokens) || 0;
  const outTok = (usage && usage.completion_tokens) || 0;
  const usd = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
  return { usd, priced: true };
}

module.exports = { costUsd };
