// LiveBench scorer.
//
// LiveBench ships per-category graders; for objective categories (math / reasoning / data-analysis)
// the ground truth is a scalar answer, so we extract the model's final answer and normalize-match —
// faithful to LiveBench's exact-answer scoring for those. Coding / language / instruction-following
// need LiveBench's OFFICIAL category graders (test execution, edit-distance, IF-checkers); those are
// left as an explicit integration point and are NOT silently scored here (they return scored:false so
// aggregate excludes them until the official grader is wired). This keeps published numbers honest.
const OBJECTIVE_CATEGORIES = new Set(["math", "reasoning", "data_analysis"]);

function normalize(s) {
  return String(s || "").toLowerCase().replace(/\$|\\boxed\{|\}|,|\s+/g, "").trim();
}

// Pull the model's final answer: \boxed{...}, "answer: X", or the last non-empty line.
function extractAnswer(text) {
  const t = String(text || "");
  const boxed = t.match(/\\boxed\{([^}]*)\}/);
  if (boxed) return boxed[1];
  const ans = t.match(/(?:final answer|answer)\s*[:=]\s*(.+)/i);
  if (ans) return ans[1].split("\n")[0];
  const lines = t.trim().split("\n").filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1] : "";
}

// item: { category, ground_truth, ... } from the LiveBench dataset. output: model text.
// Returns { scored, score (0..1|null), method }.
function score(item, output) {
  const cat = item.category;
  if (!OBJECTIVE_CATEGORIES.has(cat)) {
    return { scored: false, score: null, method: `official-grader-required:${cat}` };
  }
  const got = normalize(extractAnswer(output));
  const gt = normalize(item.ground_truth);
  return { scored: true, score: got && got === gt ? 1 : 0, method: "exact-answer" };
}

module.exports = { score, OBJECTIVE_CATEGORIES };
