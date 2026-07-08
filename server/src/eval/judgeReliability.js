// Judge-the-judge: reliability signals for the LLM-as-judge, computed from a run's per-item
// results. Pure + dependency-free so it unit-tests without a DB. Answers "can I trust these
// verdicts?" — the question DoorDash's whole post is about.
//
//   results: [{ judgeVerdict: "better"|"equal"|"worse"|null, abFlipped: bool }]
//
// Signals:
//  - positionBias: we place the candidate in slot A or B at random per item (abFlipped=true → A),
//    then map the verdict back to the candidate. An UNBIASED judge's candidate-win-rate shouldn't
//    depend on the slot. positionBias = winRate(candidate in A) - winRate(candidate in B); a large
//    magnitude means the judge favors a POSITION, not the better answer. null if a slot is empty.
//  - decisiveness: share of judged items with a non-"equal" verdict. A judge that almost always
//    says "equal" isn't discriminating (low signal), even if unbiased.
//  - verdictDist: raw better/equal/worse counts.
function judgeReliability(results) {
  const judged = (results || []).filter((r) => r && r.judgeVerdict);
  const n = judged.length;
  const dist = { better: 0, equal: 0, worse: 0 };
  for (const r of judged) if (dist[r.judgeVerdict] != null) dist[r.judgeVerdict]++;
  if (!n) return { n: 0, verdictDist: dist, aWinRate: null, bWinRate: null, positionBias: null, decisiveness: null };

  const winRate = (arr) => (arr.length ? arr.filter((r) => r.judgeVerdict === "better").length / arr.length : null);
  const inA = judged.filter((r) => r.abFlipped);   // candidate placed in slot A
  const inB = judged.filter((r) => !r.abFlipped);  // candidate placed in slot B
  const aWinRate = winRate(inA);
  const bWinRate = winRate(inB);
  const positionBias = aWinRate == null || bWinRate == null ? null : +(aWinRate - bWinRate).toFixed(4);
  const decisiveness = +(1 - dist.equal / n).toFixed(4);
  return { n, verdictDist: dist, aWinRate, bWinRate, positionBias, decisiveness };
}

module.exports = { judgeReliability };
