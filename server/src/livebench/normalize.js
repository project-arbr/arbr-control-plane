// Shared model-name normalizer used by livebench/sync.js and lmsys/sync.js.
// Strips provider prefixes, date suffixes, effort qualifiers, and converts
// dots to dashes so Arbr model IDs can be fuzzy-matched against benchmark
// leaderboard names that use different conventions.

function normalize(name) {
  return name
    .toLowerCase()
    // Strip Arbr provider prefixes that appear in Bedrock cross-account model IDs
    .replace(/^(?:zai\.|moonshotai\.|qwen\.|google\.|meta\.|anthropic\.|deepseek\.|us\.deepseek\.)/, "")
    // Bedrock "us.amazon." → keep "amazon." for matching against leaderboard names
    .replace(/^us\.amazon\./, "amazon.")
    // Strip remaining leading "us." (e.g. us.deepseek.r1 → deepseek-r1)
    .replace(/^us\./, "")
    // Dots → dashes (e.g. deepseek.v3.2 → deepseek-v3-2)
    .replace(/\./g, "-")
    // Effort qualifiers (LiveBench appends these)
    .replace(/-(?:x?high|medium|low)-effort$/i, "")
    // Date suffixes: -YYYY-MM-DD, -YYYYMMDD, -MMDD
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-\d{4}$/, "")
    .replace(/-\d{2}-\d{2}$/, "")
    // Common model-name suffixes
    .replace(/-(?:preview|snapshot|instruct|v\d+)$/i, "")
    .trim();
}

// Fuzzy match: returns true when normalized names overlap as prefix.
// e.g. our "gemini-2.5-pro" matches LB "gemini-2-5-pro-preview-05-06"
function prefixMatch(a, b) {
  return a.startsWith(b) || b.startsWith(a);
}

module.exports = { normalize, prefixMatch };
