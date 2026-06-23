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

function firstUserText(messages) {
  if (!Array.isArray(messages)) return "";
  const m = messages.find((x) => (x.role || "user").toLowerCase() === "user") || messages[0];
  if (!m) return "";
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map((c) => (typeof c === "string" ? c : c && c.text ? c.text : "")).join(" ");
  }
  return String(m.content || "");
}

// Returns { taskType, source: "manual" | "auto", confidence }.
// confidence: manual = 1.0, a keyword hit = 0.9, the safe-default fallthrough = 0.3.
function classify({ taskType, messages }) {
  if (taskType && String(taskType).trim()) {
    return { taskType: String(taskType).trim().toLowerCase(), source: "manual", confidence: 1.0 };
  }
  const text = firstUserText(messages).toLowerCase();
  for (const [type, keywords] of RULES) {
    if (keywords.some((kw) => text.includes(kw))) {
      return { taskType: type, source: "auto", confidence: 0.9 };
    }
  }
  return { taskType: "content generation", source: "auto", confidence: 0.3 }; // safe default
}

// ── LLM fallback ──────────────────────────────────────────────────────────────

// Tiny in-memory cache so identical inputs aren't re-classified (bounds cost).
const LLM_CACHE_MAX = 2000;
const _llmCache = new Map(); // sha(firstUserText) -> taskType
function cacheKey(messages) {
  return crypto.createHash("sha256").update(firstUserText(messages)).digest("hex");
}

function normalizeLabel(text) {
  const t = String(text || "").toLowerCase();
  // Find the first known task type that appears in the response.
  for (const type of TASK_TYPES) {
    if (t.includes(type)) return type;
  }
  return null;
}

// One LLM call on the DEFAULT model → a task type from TASK_TYPES, or null.
async function classifyWithLLM({ messages, router, eff }) {
  if (!router || !eff || !eff.defaultProvider) return null;
  const text = firstUserText(messages).slice(0, 800);
  const prompt =
    `You are a task classifier. Classify the user request into EXACTLY ONE of these task types:\n` +
    `${TASK_TYPES.join(", ")}\n` +
    `Respond with only the task type, nothing else.\n\nRequest:\n"""${text}"""`;
  const result = await router.complete({
    messages: [{ role: "user", content: prompt }],
    providerOverride: eff.defaultProvider,
    modelOverride: eff.defaultModel,
    temperature: 0,
    maxTokens: 256, // headroom for "thinking" models (e.g. Gemini 2.5)
  });
  const label = normalizeLabel(result.text);
  if (!label) return null;
  return {
    label,
    provider: result.providerId || eff.defaultProvider,
    model: result.modelId || eff.defaultModel,
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
    return { taskType: String(taskType).trim().toLowerCase(), method: "provided", confidence: 1.0, llm: null };
  }
  if (useLLM && router && eff && (eff.liveIds || []).length) {
    const key = cacheKey(messages);
    const hit = _llmCache.get(key);
    if (hit) return { taskType: hit, method: "ai", confidence: 0.8, llm: null };
    try {
      const r = await classifyWithLLM({ messages, router, eff });
      if (r && r.label) {
        if (_llmCache.size >= LLM_CACHE_MAX) _llmCache.delete(_llmCache.keys().next().value);
        _llmCache.set(key, r.label);
        return {
          taskType: r.label,
          method: "ai",
          confidence: 0.8,
          llm: { provider: r.provider, model: r.model, usage: r.usage, latencyMs: r.latencyMs },
        };
      }
    } catch (_e) {
      // fall through to keyword — never block the request
    }
  }
  const kw = classify({ taskType: null, messages });
  return { taskType: kw.taskType, method: "keyword", confidence: kw.confidence, llm: null };
}

module.exports = { classify, classifyTask, classifyWithLLM, TASK_TYPES, TASK_CATALOG };
