// Arena-Hard-Auto scorer: LLM-judged pairwise win-rate. Each router's answer (candidate = B) is judged
// against the item's reference answer (A) by the gateway's judge model; win=1, tie=0.5, loss=0.
// Reuses the shadow-eval verdict parser (server/src/eval/logic.js — pure) so verdict handling matches #54.
const { parseVerdict } = require("../../server/src/eval/logic");
const { complete } = require("../lib/gateway");

// Pure: candidate-vs-reference verdict → win score (unit-tested).
function winFromVerdict(verdict) {
  return verdict === "better" ? 1 : verdict === "equal" ? 0.5 : 0;
}

function judgePrompt(prompt, reference, candidate) {
  return [
    "You are impartially judging two assistant answers to the SAME user prompt. Decide which better",
    "answers it (correctness, depth, instruction-following). Be strict and position-unbiased.",
    "", "USER PROMPT:", String(prompt || "").slice(0, 4000),
    "", "ANSWER A (reference):", String(reference || "").slice(0, 6000),
    "", "ANSWER B (candidate):", String(candidate || "").slice(0, 6000),
    "", 'Reply with ONLY JSON: {"winner": "A" | "B" | "tie", "reason": "<one sentence>"}',
  ].join("\n");
}

// Async: judge the candidate output against the item's reference answer via cfg.judgeModel.
async function score(cfg, item, output) {
  const prompt = item.prompt || (Array.isArray(item.turns) ? item.turns[0] : item.turns);
  const reference = item.reference_answer || item.baseline_answer || "";
  if (!reference) return { scored: false, score: null, method: "no-reference-answer" };
  const r = await complete(cfg, {
    model: cfg.judgeModel, temperature: 0,
    messages: [{ role: "user", content: judgePrompt(prompt, reference, output) }],
  });
  const v = parseVerdict(r.text); // { verdict: better|worse|equal }
  return { scored: true, score: winFromVerdict(v.verdict), method: `arena-judge:${v.verdict}` };
}

module.exports = { score, winFromVerdict, judgePrompt };
