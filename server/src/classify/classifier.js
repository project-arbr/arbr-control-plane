// Task classification. Manual taskType (passed by the application) is ALWAYS
// trusted first. Otherwise a deterministic keyword heuristic maps the prompt to
// one of the scope's task types. When the keyword pass is inconclusive AND the
// caller opts in (useLLM), a single cheap LLM call classifies the request and the
// result is cached — so automated routing has an accurate task type to act on
// without paying for classification on every request.

const crypto = require("crypto");

// 30 built-in task types grouped by complexity tier.
// tier: "light" = fast & cheap, "mid" = balanced, "premium" = deep reasoning.
const TASK_CATALOG = [
  // ── Light ──────────────────────────────────────────────────────────────────
  { id: "faq",                tier: "light",   label: "FAQ answer",           description: "Answer a short factual or how-to question" },
  { id: "translation",        tier: "light",   label: "Translation",          description: "Translate text between languages" },
  { id: "summarisation",      tier: "light",   label: "Summarisation",        description: "Condense text into key points or a short summary" },
  { id: "classification",     tier: "light",   label: "Classification",       description: "Classify or label text (sentiment, category, spam detection)" },
  { id: "code-autocomplete",  tier: "light",   label: "Code autocomplete",    description: "Suggest the next line(s) of code from surrounding context" },
  { id: "syntax-check",       tier: "light",   label: "Syntax check",         description: "Identify syntax errors or invalid patterns in a code snippet" },
  { id: "variable-rename",    tier: "light",   label: "Variable rename",      description: "Suggest better, more descriptive names for variables or functions" },
  { id: "comment-generation", tier: "light",   label: "Comment generation",   description: "Add inline comments explaining what a block of code does" },
  { id: "regex-generation",   tier: "light",   label: "Regex generation",     description: "Write a regular expression to match a described pattern" },
  { id: "error-explanation",  tier: "light",   label: "Error explanation",    description: "Explain what a compiler or runtime error message means" },
  // ── Mid ────────────────────────────────────────────────────────────────────
  { id: "extraction",         tier: "mid",     label: "Data extraction",      description: "Pull structured fields from unstructured text or documents" },
  { id: "content generation", tier: "mid",     label: "Content generation",   description: "Write marketing copy, blog posts, or other creative text" },
  { id: "support response",   tier: "mid",     label: "Support response",     description: "Draft a helpful reply to a customer support ticket or complaint" },
  { id: "coding",             tier: "mid",     label: "Code generation",      description: "Write a function, class, or script from a natural language description" },
  { id: "unit-test",          tier: "mid",     label: "Unit test generation", description: "Write unit tests for a given function, class, or module" },
  { id: "code-review",        tier: "mid",     label: "Code review",          description: "Review a code diff for bugs, style issues, and improvements" },
  { id: "documentation",      tier: "mid",     label: "Documentation",        description: "Write docstrings, READMEs, or API documentation for code" },
  { id: "sql-query",          tier: "mid",     label: "SQL query writing",    description: "Translate a natural language question into a SQL query" },
  { id: "api-integration",    tier: "mid",     label: "API integration",      description: "Write code to call a third-party API with authentication" },
  { id: "data-transformation",tier: "mid",     label: "Data transformation",  description: "Write code to reshape, clean, or transform data structures" },
  // ── Premium ────────────────────────────────────────────────────────────────
  { id: "reasoning",                tier: "premium", label: "Reasoning",                description: "Multi-step reasoning, proof, or step-by-step deduction" },
  { id: "document analysis",        tier: "premium", label: "Document analysis",        description: "Analyse long documents, contracts, or reports in depth" },
  { id: "architecture-design",      tier: "premium", label: "Architecture design",      description: "Design a system, service, or database architecture" },
  { id: "security-audit",           tier: "premium", label: "Security audit",           description: "Review code or infrastructure for security vulnerabilities" },
  { id: "performance-optimization", tier: "premium", label: "Performance optimisation", description: "Profile, diagnose, and improve slow code or queries" },
  { id: "algorithm-design",         tier: "premium", label: "Algorithm design",         description: "Design or improve a core algorithm for correctness or efficiency" },
  { id: "large-refactor",           tier: "premium", label: "Large-scale refactor",     description: "Plan and execute a refactor spanning multiple files or modules" },
  { id: "migration-planning",       tier: "premium", label: "Migration planning",       description: "Plan a database schema or API version migration strategy" },
  { id: "spec-to-code",             tier: "premium", label: "Spec to code",             description: "Generate a complete feature implementation from a requirements spec" },
  { id: "root-cause-analysis",      tier: "premium", label: "Root cause analysis",      description: "Trace production errors across logs, traces, and code to find the root cause" },
];

// Backward-compatible string array used by existing callers.
const TASK_TYPES = TASK_CATALOG.map((t) => t.id);

// Ordered keyword rules — first match wins. Lowercased substring checks.
// More specific (multi-word) phrases come before general catch-alls to avoid
// the general rule stealing matches that belong to a sub-task.
const RULES = [
  // ── High-specificity premium tasks ────────────────────────────────────────
  ["security-audit",                ["security vulnerability", "audit this code", "audit the code", "pen test", "sql injection", "xss vulnerability", "secure this code"]],
  ["performance-optimization",      ["too slow", "performance issue", "optimize this function", "bottleneck", "speed up the code", "make it faster"]],
  ["architecture-design",           ["system design", "design the architecture", "design a microservice", "design a system", "architecture for"]],
  ["root-cause-analysis",           ["root cause", "why did this fail", "production incident", "postmortem", "incident report"]],
  ["algorithm-design",              ["time complexity", "big o notation", "data structure for", "design an algorithm", "optimal algorithm"]],
  ["large-refactor",                ["refactor the codebase", "restructure the project", "reorganize the code", "refactor the entire"]],
  ["migration-planning",            ["migration plan", "database migration", "migrate the database", "migrate from", "breaking change"]],
  ["spec-to-code",                  ["from the spec", "from the prd", "implement this requirement", "based on this requirement", "from this specification"]],
  // ── Mid coding sub-tasks (before general "coding") ────────────────────────
  ["unit-test",                     ["unit test", "write tests for", "test coverage", "test cases for", "write a test for"]],
  ["code-review",                   ["code review", "review this code", "review my code", "check my code for bugs", "feedback on this code"]],
  ["sql-query",                     ["sql query", "write a sql", "select statement", "database query", "write a query for"]],
  ["api-integration",               ["api call", "call this api", "fetch from the api", "integrate with the api", "http request to"]],
  ["data-transformation",           ["transform the data", "reshape the data", "convert this data", "map the array", "flatten the data"]],
  ["documentation",                 ["docstring", "write docs", "write documentation", "write a readme", "api docs for"]],
  // ── Light coding sub-tasks (before general "coding") ──────────────────────
  ["regex-generation",              ["regex", "regular expression", "regexp", "pattern to match"]],
  ["syntax-check",                  ["syntax error", "does this compile", "is this valid syntax", "fix the syntax"]],
  ["variable-rename",               ["rename this variable", "better name for this", "what should i name", "rename the function"]],
  ["comment-generation",            ["add comments", "comment this code", "annotate this code", "add inline comments"]],
  ["code-autocomplete",             ["autocomplete", "complete this code", "continue the code", "next line of code"]],
  ["error-explanation",             ["what does this error mean", "stack trace means", "explain this exception", "what does this warning mean"]],
  // ── General coding catch-all ──────────────────────────────────────────────
  ["coding",                        ["code", "function", "bug", "stack trace", "compile", "refactor", "python", "javascript", "script"]],
  // ── Original non-coding rules ─────────────────────────────────────────────
  ["translation",                   ["translate", "translation", "in french", "in spanish", "into german", "from english to"]],
  ["summarisation",                 ["summarise", "summarize", "summary", "tl;dr", "condense", "key points"]],
  ["extraction",                    ["extract", "pull out", "parse the", "list all the", "find all", "fields from"]],
  ["classification",                ["classify", "categorise", "categorize", "label this", "which category", "sentiment", "is this spam"]],
  ["document analysis",             ["analyse this document", "analyze this document", "review the contract", "from the attached", "this report"]],
  ["support response",              ["customer", "ticket", "refund", "apologise", "apologize", "support request", "respond to the user"]],
  ["faq",                           ["what is", "how do i", "how to", "explain", "?"]],
  ["reasoning",                     ["why", "reason through", "prove", "step by step", "deduce", "plan"]],
  ["content generation",            ["write a", "draft", "generate a", "compose", "create a post", "blog", "marketing"]],
];

function messageText(m) {
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((c) => (typeof c === "string" ? c : c && c.text ? c.text : "")).join(" ");
  }
  return String(m.content || "");
}

function firstUserText(messages) {
  if (!Array.isArray(messages)) return "";
  const valid = messages.filter((x) => x != null);
  const m = valid.find((x) => (x.role || "user").toLowerCase() === "user") || valid[0];
  return messageText(m);
}

// The LATEST user turn — what the model is actually being asked right now. Routing must
// classify this, not the first turn of a long conversation (which is stale by turn 2).
function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  const valid = messages.filter((x) => x != null);
  for (let i = valid.length - 1; i >= 0; i--) {
    if ((valid[i].role || "user").toLowerCase() === "user") return messageText(valid[i]);
  }
  return messageText(valid[valid.length - 1]);
}

// ── Difficulty signal ───────────────────────────────────────────────────────
// Each task type has a default tier; an individual request can be easier or harder than
// that. difficulty lets the router right-size the model (cheap for trivial, strong for hard)
// instead of routing every instance of a task type to the same model.
const _TIER_BY_TASK = Object.fromEntries(TASK_CATALOG.map((t) => [t.id, t.tier]));
function tierForTask(taskType) { return _TIER_BY_TASK[String(taskType || "").toLowerCase()] || null; }

const TIER_ORDER = ["light", "mid", "premium"];
function normalizeDifficulty(v) {
  const s = String(v || "").toLowerCase().trim();
  if (["light", "easy", "low", "simple", "trivial"].includes(s)) return "light";
  if (["mid", "medium", "moderate", "normal"].includes(s)) return "mid";
  if (["premium", "hard", "high", "complex", "difficult"].includes(s)) return "premium";
  return null;
}
function clamp01(n) { return Math.max(0, Math.min(1, Number(n))); }

// Cheap heuristic difficulty for the keyword path (no LLM estimate available). Starts at the
// task's catalog tier and nudges one step by surface signals.
const HARD_CUES = /\b(step by step|step-by-step|and then|after that|multiple steps|several steps|design|architect|optimi[sz]e|trade-?offs?|edge cases?|end[- ]to[- ]end|across (?:multiple|several)|refactor|migrat|root cause)\b/i;
function estimateDifficulty(text, taskType) {
  const t = text || "";
  let idx = TIER_ORDER.indexOf(tierForTask(taskType) || "mid");
  if (idx < 0) idx = 1;
  const codeBlocks = (t.match(/```/g) || []).length;
  if (t.length < 80 && !HARD_CUES.test(t)) idx = Math.max(0, idx - 1);
  if (HARD_CUES.test(t) || t.length > 1500 || codeBlocks >= 2) idx = Math.min(2, idx + 1);
  return TIER_ORDER[idx];
}

// ── 1-10 difficulty score ─────────────────────────────────────────────────────
// The LLM path emits a genuine 1-10 spectrum; the keyword path can only estimate coarsely.
// Routing still consumes the 3 TIERS — `scoreToTier` is the single place that buckets the score,
// so `scoreToTier(estimateDifficultyScore(...))` is guaranteed to equal the old tier (routing parity).
const TIER_BAND = { light: [1, 3], mid: [4, 7], premium: [8, 10] };
function scoreToTier(score) {
  const n = Number(score);
  if (!isFinite(n)) return "mid";
  if (n <= 3) return "light";
  if (n <= 7) return "mid";
  return "premium";
}
// Normalize an LLM-provided difficulty into a 1-10 integer. Accepts a number, or a tier word
// (light/mid/premium and synonyms) mapped to a representative score; null if unrecognized.
function normalizeDifficultyScore(v) {
  const n = Number(v);
  if (isFinite(n)) return Math.max(1, Math.min(10, Math.round(n)));
  const tier = normalizeDifficulty(v);
  return tier ? { light: 2, mid: 5, premium: 9 }[tier] : null;
}
// Keyword-path score: derive the tier the existing way, then place WITHIN that tier's band by
// prompt length. Stays inside the band, so it always buckets back to the same tier (parity).
function estimateDifficultyScore(text, taskType) {
  const [lo, hi] = TIER_BAND[estimateDifficulty(text, taskType)] || TIER_BAND.mid;
  const frac = Math.max(0, Math.min(1, (text || "").length / 2000));
  return Math.round(lo + frac * (hi - lo));
}

// Last complete {...} JSON block in text. Local copy (a require on aiPolicy would be circular,
// since aiPolicy imports this module for TASK_TYPES/TASK_CATALOG).
function parseJsonBlock(text) {
  let depth = 0, end = -1;
  for (let i = (text || "").length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") { if (depth === 0) end = i; depth++; }
    else if (ch === "{") {
      depth--;
      if (depth === 0 && end !== -1) {
        try { return JSON.parse(text.slice(i, end + 1)); } catch { end = -1; depth = 0; }
      }
    }
  }
  return null;
}

// Pick a cheap, fast model for classification instead of the (possibly premium) default.
function pickClassifierModel(eff) {
  const pricing = require("../pricing/registry");
  const light = eff.defaultModel ? pricing.suggestLightTarget(eff.defaultModel) : null;
  if (light && (eff.liveIds || []).includes(light.provider)) return light;
  return { provider: eff.defaultProvider, model: eff.defaultModel };
}

// Returns { taskType, source: "manual" | "auto", confidence }.
// confidence: manual = 1.0, a keyword hit = 0.9, the safe-default fallthrough = 0.3.
function classify({ taskType, messages }) {
  if (taskType && String(taskType).trim()) {
    return { taskType: String(taskType).trim().toLowerCase(), source: "manual", confidence: 1.0, difficulty: null, difficultyScore: null };
  }
  const text = lastUserText(messages).toLowerCase();
  for (const [type, keywords] of RULES) {
    if (keywords.some((kw) => text.includes(kw))) {
      const difficultyScore = estimateDifficultyScore(text, type);
      return { taskType: type, source: "auto", confidence: 0.9, difficultyScore, difficulty: scoreToTier(difficultyScore) };
    }
  }
  // safe default
  const difficultyScore = estimateDifficultyScore(text, "content generation");
  return { taskType: "content generation", source: "auto", confidence: 0.3, difficultyScore, difficulty: scoreToTier(difficultyScore) };
}

// ── LLM fallback ──────────────────────────────────────────────────────────────

// Tiny in-memory cache so identical inputs aren't re-classified (bounds cost).
const LLM_CACHE_MAX = 2000;
const _llmCache = new Map(); // sha(lastUserText) -> { taskType, difficulty, confidence }
function cacheKey(messages) {
  return crypto.createHash("sha256").update(lastUserText(messages)).digest("hex");
}

function normalizeLabel(text) {
  const t = String(text || "").toLowerCase();
  // Find the first known task type that appears in the response.
  for (const type of TASK_TYPES) {
    if (t.includes(type)) return type;
  }
  return null;
}

// One LLM call on a CHEAP model → { taskType, difficulty, confidence } from TASK_TYPES, or null.
async function classifyWithLLM({ messages, router, eff }) {
  if (!router || !eff || !eff.defaultProvider) return null;
  const text = lastUserText(messages).slice(0, 800);
  const prompt =
    `You are a task classifier for an AI gateway. Classify the user request and rate its difficulty.\n` +
    `taskType MUST be EXACTLY ONE of: ${TASK_TYPES.join(", ")}\n` +
    `difficulty: an integer 1-10 (1 = trivial/short, 5 = moderate, 10 = very complex, multi-step, or deep reasoning).\n` +
    `Return ONLY a JSON object: {"taskType": "...", "difficulty": <1-10>, "confidence": <0-1>}\n\n` +
    `Request:\n"""${text}"""`;
  const m = pickClassifierModel(eff);
  const result = await router.complete({
    messages: [{ role: "user", content: prompt }],
    providerOverride: m.provider,
    modelOverride: m.model,
    temperature: 0,
    maxTokens: 256, // headroom for "thinking" models (e.g. Gemini 2.5)
  });
  const parsed = parseJsonBlock(result.text || "");
  let label = parsed ? normalizeLabel(parsed.taskType) : null;
  const difficultyScore = parsed ? normalizeDifficultyScore(parsed.difficulty) : null;
  const confidence = parsed && parsed.confidence != null && !isNaN(Number(parsed.confidence))
    ? clamp01(parsed.confidence) : null;
  if (!label) label = normalizeLabel(result.text); // fallback: substring scan of raw text
  if (!label) return null;
  return {
    label,
    difficultyScore,
    difficulty: difficultyScore != null ? scoreToTier(difficultyScore) : null, // tier for routing
    confidence,
    provider: result.providerId || m.provider,
    model: result.modelId || m.model,
    usage: result.usage,
    latencyMs: result.latencyMs,
  };
}

// Orchestrator used by the gateway. Returns:
//   { taskType, method: "provided"|"keyword"|"ai", confidence, llm }
// where `llm` describes a billable classification call (for transparent logging).
// A provided taskType is always trusted. Otherwise: when useLLM, the AI classifier
// is primary (default model, cached) and keyword is only the fallback; when useLLM
// is off, the keyword heuristic decides.
async function classifyTask({ taskType, messages, router, eff, useLLM }) {
  if (taskType && String(taskType).trim()) {
    return { taskType: String(taskType).trim().toLowerCase(), method: "provided", confidence: 1.0, difficulty: null, difficultyScore: null, llm: null };
  }
  if (useLLM && router && eff && (eff.liveIds || []).length) {
    const key = cacheKey(messages);
    const hit = _llmCache.get(key);
    if (hit) return { taskType: hit.taskType, method: "ai", confidence: hit.confidence ?? 0.8, difficulty: hit.difficulty || null, difficultyScore: hit.difficultyScore ?? null, llm: null };
    try {
      const r = await classifyWithLLM({ messages, router, eff });
      if (r && r.label) {
        const entry = { taskType: r.label, difficulty: r.difficulty || null, difficultyScore: r.difficultyScore ?? null, confidence: r.confidence };
        if (_llmCache.size >= LLM_CACHE_MAX) _llmCache.delete(_llmCache.keys().next().value);
        _llmCache.set(key, entry);
        return {
          taskType: r.label,
          method: "ai",
          confidence: r.confidence ?? 0.8,
          difficulty: r.difficulty || null,
          difficultyScore: r.difficultyScore ?? null,
          llm: { provider: r.provider, model: r.model, usage: r.usage, latencyMs: r.latencyMs },
        };
      }
    } catch (_e) {
      // fall through to keyword — never block the request
    }
  }
  const kw = classify({ taskType: null, messages });
  return { taskType: kw.taskType, method: "keyword", confidence: kw.confidence, difficulty: kw.difficulty || null, difficultyScore: kw.difficultyScore ?? null, llm: null };
}

module.exports = {
  classify, classifyTask, classifyWithLLM, TASK_TYPES, TASK_CATALOG,
  firstUserText, lastUserText, estimateDifficulty, estimateDifficultyScore,
  normalizeDifficulty, normalizeDifficultyScore, scoreToTier, tierForTask,
};
