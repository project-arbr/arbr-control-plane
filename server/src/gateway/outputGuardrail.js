// Output guardrail checks applied to model responses before they reach the caller.
//
// check()    — keyword/regex deny-list, scoped per application or all apps.
// maskPii()  — re-exports piiFilter.maskPii for live response PII redaction.
const { maskPii } = require("../logging/piiFilter");

// Returns { blocked: false } or { blocked: true, ruleName: string }.
// Only rules whose application matches (or is "*") are evaluated.
// Invalid regex patterns are silently skipped.
function check(text, rules, application) {
  if (!text || !Array.isArray(rules) || rules.length === 0) return { blocked: false };
  const app = application || "*";
  for (const { name, pattern, application: ruleApp } of rules) {
    if (!pattern) continue;
    const scope = ruleApp || "*";
    if (scope !== "*" && scope !== app) continue;
    try {
      if (new RegExp(pattern, "gi").test(text)) return { blocked: true, ruleName: name || pattern };
    } catch { /* skip invalid regex */ }
  }
  return { blocked: false };
}

module.exports = { check, maskPii };
