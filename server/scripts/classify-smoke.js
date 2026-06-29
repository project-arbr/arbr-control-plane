// Pure-logic smoke test for the classifier (no DB / no provider keys needed).
// Run: npm run smoke:classify
const c = require("../src/classify/classifier");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", msg); } };

// Latest user turn drives classification (not the first turn of a conversation).
const convo = [
  { role: "user", content: "translate hello to french" },
  { role: "assistant", content: "bonjour" },
  { role: "user", content: "now write me a python web scraper for this site" },
];
ok(c.lastUserText(convo).includes("python web scraper"), "lastUserText = latest user turn");
ok(c.firstUserText(convo).includes("translate"), "firstUserText = first turn (unchanged)");
ok(c.classify({ messages: convo }).taskType === "coding", "classify uses latest turn -> coding");

// Difficulty: easy vs hard instances of the SAME task family route to different tiers.
ok(c.tierForTask("coding") === "mid", "coding default tier = mid");
ok(c.estimateDifficulty("rename this var", "coding") === "light", "trivial coding -> light");
ok(c.estimateDifficulty(
  "design and implement an end-to-end distributed scheduler, step by step, across multiple services",
  "coding") === "premium", "complex multi-step coding -> premium");

// Difficulty label normalization.
ok(c.normalizeDifficulty("HARD") === "premium", "normalize HARD -> premium");
ok(c.normalizeDifficulty("easy") === "light", "normalize easy -> light");
ok(c.normalizeDifficulty("medium") === "mid", "normalize medium -> mid");
ok(c.normalizeDifficulty("banana") === null, "normalize junk -> null");

// No keyword match -> safe default.
ok(c.classify({ messages: [{ role: "user", content: "zxcv qwer" }] }).taskType === "content generation",
  "no match -> content generation default");

// ── 1-10 difficulty score ──
// scoreToTier boundaries (1-3 light, 4-7 mid, 8-10 premium).
ok(c.scoreToTier(1) === "light" && c.scoreToTier(3) === "light", "scoreToTier 1,3 -> light");
ok(c.scoreToTier(4) === "mid" && c.scoreToTier(7) === "mid", "scoreToTier 4,7 -> mid");
ok(c.scoreToTier(8) === "premium" && c.scoreToTier(10) === "premium", "scoreToTier 8,10 -> premium");

// LLM-score normalization: number clamps to 1-10; tier words map; junk -> null.
ok(c.normalizeDifficultyScore(8) === 8, "normalizeScore 8 -> 8");
ok(c.normalizeDifficultyScore("12") === 10, "normalizeScore 12 -> clamp 10");
ok(c.normalizeDifficultyScore(0) === 1, "normalizeScore 0 -> clamp 1");
ok(c.normalizeDifficultyScore("hard") === 9, "normalizeScore 'hard' -> 9 (premium)");
ok(c.normalizeDifficultyScore("banana") === null, "normalizeScore junk -> null");

// Keyword score: trivial low, complex high; both within 1-10.
const easyScore = c.estimateDifficultyScore("rename this var", "coding");
const hardScore = c.estimateDifficultyScore(
  "design and implement an end-to-end distributed scheduler, step by step, across multiple services", "coding");
ok(easyScore >= 1 && easyScore <= 3, `trivial coding score in light band (got ${easyScore})`);
ok(hardScore >= 8 && hardScore <= 10, `complex coding score in premium band (got ${hardScore})`);

// ROUTING PARITY: scoreToTier(estimateDifficultyScore(...)) == old estimateDifficulty tier.
for (const [text, tt] of [["rename this var", "coding"], ["design a distributed scheduler step by step across multiple services", "coding"], ["what is 2+2", "faq"]]) {
  ok(c.scoreToTier(c.estimateDifficultyScore(text, tt)) === c.estimateDifficulty(text, tt),
    `parity: score buckets to same tier as estimateDifficulty ("${text.slice(0,20)}...")`);
}

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
