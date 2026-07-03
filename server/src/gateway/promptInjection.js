// Prompt injection detection — checks user/tool message content against a
// deny-list of common injection and jailbreak patterns before the request
// reaches the model. System prompts are trusted and not checked.
//
// check()        — run built-in + custom rules, return { blocked, ruleName }.
// BUILTIN_RULES  — exported so the UI can display the built-in pattern names.

const BUILTIN_RULES = [
  { name: "ignore-instructions",    pattern: "ignore\\s+(all\\s+)?(previous|prior|above)\\s+(instructions?|directives?|commands?)" },
  { name: "disregard-instructions", pattern: "disregard\\s+(all\\s+|your\\s+)?(previous\\s+|prior\\s+|above\\s+)?(instructions?|directives?|commands?)" },
  { name: "forget-instructions",    pattern: "forget\\s+(everything|all)\\s+(you\\s+)?(were\\s+told|your\\s+instructions?|your\\s+training)" },
  { name: "dan-jailbreak",          pattern: "\\bDAN\\s+mode\\b|you\\s+are\\s+now\\s+DAN\\b" },
  { name: "model-token-injection",  pattern: "<\\|im_start\\||<\\|im_end\\||\\[INST\\]|<<SYS>>|\\[\\/INST\\]" },
  { name: "override-guardrails",    pattern: "\\b(override|bypass|ignore)\\s+(the\\s+)?(system\\s+prompt|safety|guardrails?)" },
];

function extractText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c) => c.type === "text").map((c) => c.text || "").join(" ");
  }
  return "";
}

// Returns { blocked: false } or { blocked: true, ruleName: string }.
// Only user and tool messages are checked (system prompts are from the app owner).
// Custom rules support per-application scoping identical to outputGuardrail.js.
function check(messages, customRules, application) {
  if (!Array.isArray(messages) || messages.length === 0) return { blocked: false };

  const combined = messages
    .filter((m) => m.role === "user" || m.role === "tool")
    .map((m) => extractText(m.content))
    .filter(Boolean)
    .join("\n");

  if (!combined) return { blocked: false };

  for (const { name, pattern } of BUILTIN_RULES) {
    try {
      if (new RegExp(pattern, "gi").test(combined)) return { blocked: true, ruleName: name };
    } catch { /* skip */ }
  }

  if (Array.isArray(customRules)) {
    const app = application || "*";
    for (const { name, pattern, application: ruleApp } of customRules) {
      if (!pattern) continue;
      const scope = ruleApp || "*";
      if (scope !== "*" && scope !== app) continue;
      try {
        if (new RegExp(pattern, "gi").test(combined)) return { blocked: true, ruleName: name || pattern };
      } catch { /* skip invalid regex */ }
    }
  }

  return { blocked: false };
}

module.exports = { check, BUILTIN_RULES };
