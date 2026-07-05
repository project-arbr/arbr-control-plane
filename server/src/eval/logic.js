// Pure shadow-eval logic — dependency-free (no mongoose/pricing) so it can be unit-tested
// without a DB. Shared by shadow.js, judge.js, and the API routes.

// Single-shot = safe to mirror: no tools, and no prior assistant/tool turns (one-and-done).
// Multi-turn / agentic traffic is skipped (a mirrored candidate would want side-effecting actions).
function isSingleShot(messages, hasTools) {
  if (hasTools) return false;
  if (typeof messages === "string") return true;
  if (!Array.isArray(messages)) return false;
  return !messages.some((m) => m && (m.role === "tool" || m.role === "assistant"));
}

// Sampling decision (pure): mirror when rand < rate.
function shouldSample(rand, rate) {
  return rand < (Number(rate) || 0);
}

// Lenient parse of the judge's reply into a candidate-perspective verdict (B = candidate).
function parseVerdict(text) {
  const raw = String(text || "");
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      const w = String(j.winner || j.verdict || "").trim().toUpperCase();
      const reason = j.reason || j.rationale || "";
      if (w === "B") return { verdict: "better", rationale: reason };
      if (w === "A") return { verdict: "worse", rationale: reason };
      if (w === "TIE" || w === "EQUAL" || w === "SAME") return { verdict: "equal", rationale: reason };
    } catch { /* fall through */ }
  }
  return { verdict: "equal", rationale: raw.slice(0, 300) };
}

// Aggregate a campaign's pairs into a verdict summary (win/tie/loss, cost + latency delta).
function summarizeEvalPairs(pairs) {
  const judged = pairs.filter((p) => p.verdict);
  const better = judged.filter((p) => p.verdict === "better").length;
  const equal  = judged.filter((p) => p.verdict === "equal").length;
  const worse  = judged.filter((p) => p.verdict === "worse").length;
  const n = pairs.length;
  const sum = (f) => pairs.reduce((a, p) => a + (Number(f(p)) || 0), 0);
  const prodCost = sum((p) => p.prodCost), candidateCost = sum((p) => p.candidateCost);
  const prodLat = sum((p) => p.prodLatencyMs), candLat = sum((p) => p.candidateLatencyMs);
  return {
    pairs: n, judged: judged.length, better, equal, worse,
    winRate:  judged.length ? better / judged.length : null,
    lossRate: judged.length ? worse  / judged.length : null,
    prodCost, candidateCost,
    costDeltaPct: prodCost > 0 ? (candidateCost - prodCost) / prodCost : null,
    avgProdLatencyMs: n ? prodLat / n : 0,
    avgCandidateLatencyMs: n ? candLat / n : 0,
  };
}

// Is `now` inside a campaign's [start, end] window? null bound = open on that side. Pure.
function withinWindow(now, startDate, endDate) {
  const t = now instanceof Date ? now.getTime() : Number(now);
  if (startDate && t < new Date(startDate).getTime()) return false;
  if (endDate && t > new Date(endDate).getTime()) return false;
  return true;
}

// Does this request fall within a campaign's scope filters? A null scope field = "any". The
// baseline model (the model prod actually served) must match campaign.baselineModel when set.
// Pure.
function campaignMatches(campaign, { taskType, workflow, baselineModel }) {
  if (!campaign) return false;
  const scope = campaign.scope || {};
  if (scope.taskType && String(scope.taskType).toLowerCase() !== String(taskType || "").toLowerCase()) return false;
  if (scope.workflow && scope.workflow !== workflow) return false;
  if (campaign.baselineModel && campaign.baselineModel !== baselineModel) return false;
  return true;
}

module.exports = {
  isSingleShot, shouldSample, parseVerdict, summarizeEvalPairs, withinWindow, campaignMatches,
};
