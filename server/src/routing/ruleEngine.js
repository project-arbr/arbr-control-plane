// Deterministic rule matching + the auto-mode routing-mode setting. No inference here.
//
// Enabled rules are cached in memory and refreshed on a short interval (and on
// explicit invalidation when the console toggles a rule), so the synchronous
// match step stays well under the live-path overhead target.
const Rule = require("../models/Rule");
const Settings = require("../models/Settings");

let _rulesCache = { rules: [], loadedAt: 0 };
const RULES_TTL_MS = 5000;

async function refreshRules() {
  const rules = await Rule.find({ enabled: true }).lean();
  _rulesCache = { rules, loadedAt: Date.now() };
  return rules;
}

function invalidate() {
  _rulesCache.loadedAt = 0;
}

async function getEnabledRules() {
  if (Date.now() - _rulesCache.loadedAt > RULES_TTL_MS) {
    await refreshRules();
  }
  return _rulesCache.rules;
}

// A rule matches when every non-null condition field equals the request's value.
function matches(rule, ctx) {
  const c = rule.condition || {};
  if (c.taskType && c.taskType.toLowerCase() !== String(ctx.taskType || "").toLowerCase()) return false;
  if (c.application && c.application !== ctx.application) return false;
  if (c.workflow && c.workflow !== ctx.workflow) return false;
  // A rule with no condition fields matches nothing (guards against a blanket rule).
  if (!c.taskType && !c.application && !c.workflow) return false;
  return true;
}

// Returns the target {provider, model} of the first matching enabled rule, or null.
async function findRoute(ctx) {
  const rules = await getEnabledRules();
  for (const rule of rules) {
    if (matches(rule, ctx)) {
      return { provider: rule.target.provider, model: rule.target.model, ruleId: rule._id,
               condition: rule.condition, note: rule.note };
    }
  }
  return null;
}

// Auto-mode routing engine. Migrates the legacy `autoRouting` boolean.
async function getRoutingMode() {
  const s = await Settings.get();
  if (s.routingMode) return s.routingMode;
  return s.autoRouting ? "guardrail" : "off";
}

async function setRoutingMode(mode) {
  const valid = ["off", "guardrail", "ai"];
  const next = valid.includes(mode) ? mode : "off";
  const s = await Settings.get();
  s.routingMode = next;
  s.autoRouting = next !== "off"; // keep legacy field consistent
  await s.save();
  return next;
}

module.exports = {
  findRoute,
  getRoutingMode,
  setRoutingMode,
  invalidate,
  refreshRules,
};
