// Deterministic rule matching + the auto-mode routing-mode setting. No inference here.
//
// Enabled rules are cached in memory and refreshed on a short interval (and on
// explicit invalidation when the console toggles a rule), so the synchronous
// match step stays well under the live-path overhead target.
const Rule = require("../models/Rule");
const Settings = require("../models/Settings");
const pricing = require("../pricing/registry");

let _rulesCache = { rules: [], loadedAt: 0 };
const RULES_TTL_MS = 5000;

// How many condition fields a rule sets — a rule matching task+app+workflow is more
// specific than one matching task alone, and should win a priority tie. Pure.
function specificity(rule) {
  const c = rule.condition || {};
  return (c.taskType ? 1 : 0) + (c.application ? 1 : 0) + (c.workflow ? 1 : 0);
}

// Deterministic total order: priority desc, then specificity desc, then _id asc.
// Iterating this order and taking the first match makes rule precedence explicit
// instead of dependent on Mongo's natural (insertion) order. Pure.
function sortRules(rules) {
  return [...rules].sort((a, b) =>
    (b.priority || 0) - (a.priority || 0) ||
    specificity(b) - specificity(a) ||
    String(a._id).localeCompare(String(b._id))
  );
}

async function refreshRules() {
  const rules = sortRules(await Rule.find({ enabled: true }).lean());
  _rulesCache = { rules, loadedAt: Date.now() };
  return rules;
}

// Warn at most once a minute per rule about an unroutable target, so a
// misconfigured rule is visible in the logs without flooding them.
const WARN_EVERY_MS = 60_000;
const _warned = new Map();
function warnUnroutable(rule) {
  const sig = String(rule._id);
  const last = _warned.get(sig) || 0;
  if (Date.now() - last < WARN_EVERY_MS) return;
  _warned.set(sig, Date.now());
  console.warn(
    `[ruleEngine] skipping rule ${sig}: target provider "${rule.target.provider}" is not connected. ` +
    `Falling through to the next rule / policy / default.`
  );
}

// Is a rule's target servable right now? A rule to a provider that is not connected
// can only fail at the provider, so it is skipped and routing falls through rather
// than dead-ending on a 502. An unknown model on a LIVE provider is left servable —
// that is a legitimate pass-through, exactly as an explicit client pin would be.
function targetServable(rule, eff) {
  if (!eff || !eff.liveIds) return true; // no context to validate against — preserve old behavior
  return eff.liveIds.includes(rule.target.provider);
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

// Returns the target {provider, model, qualityGate, ...} of the first matching enabled
// rule whose target is servable, or null. Rules are pre-sorted (priority, specificity,
// _id), so "first match" is deterministic. `ctx.eff` (optional) lets a rule whose target
// provider is offline be skipped so routing falls through instead of dead-ending on a 502.
async function findRoute(ctx) {
  const rules = await getEnabledRules();
  for (const rule of rules) {
    if (!matches(rule, ctx)) continue;
    if (!targetServable(rule, ctx.eff)) { warnUnroutable(rule); continue; }
    return {
      provider: rule.target.provider,
      model: rule.target.model,
      ruleId: rule._id,
      condition: rule.condition,
      note: rule.note,
      qualityGate: rule.qualityGate || "ungated",
    };
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
  Settings.invalidateCache();
  return next;
}

module.exports = {
  findRoute,
  getRoutingMode,
  setRoutingMode,
  invalidate,
  refreshRules,
  _specificity: specificity, // pure, exported for tests
  _sortRules: sortRules,
  _targetServable: targetServable,
};
