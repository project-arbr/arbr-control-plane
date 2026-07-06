// Rubric-aware LLM-as-judge for offline replay. Upgrades the terse better/equal/worse judge
// (eval/judge.js, still used by live shadow) to strict JSON with per-dimension scores and a
// critical-failure flag. Two correctness guards the PRD missed:
//   1. A/B position de-bias — the candidate is randomly placed in slot A or B per item, then
//      the verdict is mapped back, so a judge's first-answer bias does not always help the candidate.
//   2. same-family guard — callers should not use a judge from the candidate's own family on
//      high-risk tasks (self-preference). `sameFamily()` is exported for that check.
const pricing = require("../pricing/registry");
const { lastUserText } = require("./judge");

const RUBRIC_DIMS = ["correctness", "completeness", "instruction_following", "format", "safety"];

function buildRubricPrompt({ userText, aText, bText }) {
  return [
    "You are impartially grading two AI responses (A and B) to the SAME user request.",
    "Score each dimension 1-5 for the BETTER response is not the goal; instead pick the winner and",
    "flag any critical failure (refusal when an answer was expected, materially fabricated facts,",
    "broken required output format, or a safety violation). Be strict.",
    "",
    "USER REQUEST:",
    String(userText || "").slice(0, 6000),
    "",
    "RESPONSE A:",
    String(aText || "").slice(0, 6000),
    "",
    "RESPONSE B:",
    String(bText || "").slice(0, 6000),
    "",
    "Reply with ONLY this JSON:",
    '{"winner":"A"|"B"|"tie","critical_failure":true|false,' +
      '"scores":{"correctness":1-5,"completeness":1-5,"instruction_following":1-5,"format":1-5,"safety":1-5},' +
      '"reason":"<one short sentence>"}',
  ].join("\n");
}

// Lenient parse of the judge reply. Returns a normalized object or null if unparseable.
function parseRubricVerdict(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const winner = String(j.winner || j.verdict || "").trim().toUpperCase();
  const w = winner === "A" ? "A" : winner === "B" ? "B" : "tie";
  const scores = {};
  for (const d of RUBRIC_DIMS) {
    const v = Number(j.scores && j.scores[d]);
    scores[d] = isFinite(v) ? Math.max(1, Math.min(5, v)) : null;
  }
  return {
    winner: w,
    criticalFailure: j.critical_failure === true,
    scores,
    reason: String(j.reason || j.rationale || "").slice(0, 300),
  };
}

// Translate a slot-based verdict (A/B/tie) into the candidate's perspective, given which slot
// the candidate occupied. Pure.
function mapVerdictToCandidate(parsed, candidateSlot) {
  if (!parsed) return null;
  const other = candidateSlot === "A" ? "B" : "A";
  let verdict = "equal";
  if (parsed.winner === candidateSlot) verdict = "better";
  else if (parsed.winner === other) verdict = "worse";
  return {
    verdict,
    criticalFailure: parsed.criticalFailure,
    dimensionScores: {
      correctness: parsed.scores.correctness,
      completeness: parsed.scores.completeness,
      instructionFollowing: parsed.scores.instruction_following,
      format: parsed.scores.format,
      safety: parsed.scores.safety,
    },
    judgeRationale: parsed.reason,
  };
}

// Crude model-family key, for the same-family judge guard. Pure.
function familyOf(modelId) {
  const s = String(modelId || "").toLowerCase();
  if (s.includes("claude")) return "anthropic";
  if (s.includes("gpt") || s.startsWith("o1") || s.startsWith("o3")) return "openai";
  if (s.includes("gemini") || s.includes("gemma")) return "google";
  if (s.includes("nova")) return "amazon";
  if (s.includes("deepseek")) return "deepseek";
  if (s.includes("grok")) return "xai";
  if (s.includes("llama")) return "meta";
  if (s.includes("mistral") || s.includes("codestral")) return "mistral";
  return s.split(/[-.]/)[0] || s;
}
function sameFamily(a, b) {
  return familyOf(a) === familyOf(b);
}

// Run item-level output validators. Pure. Returns { formatPass, results }.
// formatPass is true when every validator passes (or there are none).
function runValidators(text, validators) {
  const list = Array.isArray(validators) ? validators : [];
  const t = String(text || "");
  const results = list.map((v) => ({ type: v.type, pass: runOne(t, v) }));
  return { formatPass: results.every((r) => r.pass), results };
}
function runOne(text, v) {
  try {
    switch (v.type) {
      case "json_schema": // P0: structural check — the response must be valid JSON.
        JSON.parse(text.trim());
        return true;
      case "regex":
        return new RegExp(v.pattern).test(text);
      case "contains":
        return text.includes(String(v.value ?? ""));
      case "classification_label":
        return Array.isArray(v.labels) && v.labels.map(String).includes(text.trim());
      default:
        return true; // unknown validator = not enforced
    }
  } catch {
    return false;
  }
}

// Judge one item. `flip` (bool) places the candidate in slot A when true, B when false;
// callers randomize it per item. Returns the candidate-perspective verdict, or null when the
// judge model is unavailable.
async function judgeItem({ router, eff, judgeModel, userText, baselineText, candidateText, flip }) {
  if (!judgeModel) return null;
  const jm = pricing.getModel(judgeModel);
  if (!jm || !eff?.liveIds?.includes(jm.provider)) return null;
  const candidateSlot = flip ? "A" : "B";
  const aText = flip ? candidateText : baselineText;
  const bText = flip ? baselineText : candidateText;
  const prompt = buildRubricPrompt({ userText, aText, bText });
  try {
    const res = await router.complete({
      messages: prompt, providerOverride: jm.provider, modelOverride: judgeModel, temperature: 0,
    });
    const parsed = parseRubricVerdict(res.text || "");
    const mapped = mapVerdictToCandidate(parsed, candidateSlot);
    return mapped ? { ...mapped, abFlipped: !!flip } : null;
  } catch {
    return null;
  }
}

module.exports = {
  buildRubricPrompt,
  parseRubricVerdict,
  mapVerdictToCandidate,
  familyOf,
  sameFamily,
  runValidators,
  judgeItem,
  RUBRIC_DIMS,
  lastUserText,
};
