// LLM-as-judge: grade a candidate response (B) against the prod response (A) for the same
// request. Returns { verdict: "better"|"equal"|"worse", rationale } from the candidate's
// perspective, or null when no judge model is available. Used by shadow-eval.
const pricing = require("../pricing/registry");
const { parseVerdict } = require("./logic");

function lastUserText(messages) {
  if (typeof messages === "string") return messages;
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return typeof m.content === "string" ? m.content : JSON.stringify(m.content);
  }
  const first = messages.find((m) => m && m.content);
  return first ? (typeof first.content === "string" ? first.content : JSON.stringify(first.content)) : "";
}

async function judge({ router, eff, judgeModel, messages, prodText, candidateText }) {
  if (!judgeModel) return null;
  const jm = pricing.getModel(judgeModel);
  if (!jm || !eff?.liveIds?.includes(jm.provider)) return null; // judge model not live → capture pair only
  const prompt = [
    "You are impartially evaluating two AI responses to the SAME user request. Decide which better",
    "fulfills the request (correctness, completeness, instruction-following). Be strict.",
    "",
    "USER REQUEST:",
    lastUserText(messages),
    "",
    "RESPONSE A (current model):",
    String(prodText || "").slice(0, 6000),
    "",
    "RESPONSE B (candidate model):",
    String(candidateText || "").slice(0, 6000),
    "",
    'Reply with ONLY JSON: {"winner": "A" | "B" | "tie", "reason": "<one short sentence>"}',
  ].join("\n");
  try {
    const res = await router.complete({
      messages: prompt, providerOverride: jm.provider, modelOverride: judgeModel, temperature: 0,
    });
    return parseVerdict(res.text || "");
  } catch {
    return null;
  }
}

module.exports = { judge, lastUserText };
