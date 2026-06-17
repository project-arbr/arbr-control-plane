// Task classification. Manual taskType (passed by the application) is ALWAYS
// trusted first. Otherwise a deterministic keyword heuristic maps the prompt to
// one of the scope's task types. When the keyword pass is inconclusive AND the
// caller opts in (useLLM), a single cheap LLM call classifies the request and the
// result is cached — so automated routing has an accurate task type to act on
// without paying for classification on every request.

const crypto = require("crypto");

const TASK_TYPES = [
  "summarisation",
  "classification",
  "extraction",
  "translation",
  "content generation",
  "reasoning",
  "coding",
  "faq",
  "document analysis",
  "support response",
];

// Ordered keyword rules — first match wins. Lowercased substring checks.
const RULES = [
  ["coding", ["code", "function", "bug", "stack trace", "compile", "refactor", "python", "javascript", "sql query"]],
  ["translation", ["translate", "translation", "in french", "in spanish", "into german", "from english to"]],
  ["summarisation", ["summarise", "summarize", "summary", "tl;dr", "condense", "key points"]],
  ["extraction", ["extract", "pull out", "parse the", "list all the", "find all", "fields from"]],
  ["classification", ["classify", "categorise", "categorize", "label this", "which category", "sentiment", "is this spam"]],
  ["document analysis", ["analyse this document", "analyze this document", "review the contract", "from the attached", "this report"]],
  ["support response", ["customer", "ticket", "refund", "apologise", "apologize", "support request", "respond to the user"]],
  ["faq", ["what is", "how do i", "how to", "explain", "?"]],
  ["reasoning", ["why", "reason through", "prove", "step by step", "deduce", "plan"]],
  ["content generation", ["write a", "draft", "generate a", "compose", "create a post", "blog", "marketing"]],
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

module.exports = { classify, classifyTask, TASK_TYPES };
