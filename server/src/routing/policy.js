// The automated-routing policy: the editable knobs behind the cost guardrail.
// Stored overrides (Settings.policy) are merged over the hardcoded defaults in
// pricing/table.js, so the policy is fully editable from the dashboard while
// unchanged-until-edited. Cached with a short TTL like the rule cache.
const Settings = require("../models/Settings");
const pricing = require("../pricing/registry");

let _cache = { policy: null, loadedAt: 0 };
const TTL_MS = 5000;

// The shipped defaults (mirror pricing/table.js) used when nothing is overridden.
function defaults() {
  return {
    cheapTaskTypes: [...pricing.CHEAP_TASK_TYPES],
    lightTargets: { ...pricing.LIGHT_TARGET_BY_PROVIDER },
    mode: "conservative",
  };
}

function invalidate() {
  _cache.loadedAt = 0;
}

// Effective policy = defaults with any stored overrides applied.
// Returns { cheapTaskTypes: Set, lightTargets: {provider:model}, mode }.
async function getEffective() {
  if (_cache.policy && Date.now() - _cache.loadedAt < TTL_MS) return _cache.policy;
  const s = await Settings.get();
  const p = (s && s.policy) || {};
  const d = defaults();
  const cheap = Array.isArray(p.cheapTaskTypes) && p.cheapTaskTypes.length ? p.cheapTaskTypes : d.cheapTaskTypes;
  const targets = { ...d.lightTargets, ...(p.lightTargets && typeof p.lightTargets === "object" ? p.lightTargets : {}) };
  const eff = {
    cheapTaskTypes: new Set(cheap.map((x) => String(x).toLowerCase())),
    lightTargets: targets,
    mode: p.mode === "aggressive" ? "aggressive" : "conservative",
  };
  _cache = { policy: eff, loadedAt: Date.now() };
  return eff;
}

// Persist overrides. Unknown task types / models are validated by the caller.
async function setPolicy({ cheapTaskTypes, lightTargets, mode }) {
  const s = await Settings.get();
  s.policy = {
    cheapTaskTypes: Array.isArray(cheapTaskTypes) ? cheapTaskTypes.map((x) => String(x).toLowerCase()) : (s.policy && s.policy.cheapTaskTypes) || null,
    lightTargets: lightTargets && typeof lightTargets === "object" ? lightTargets : (s.policy && s.policy.lightTargets) || null,
    mode: mode === "aggressive" ? "aggressive" : "conservative",
  };
  s.markModified("policy");
  await s.save();
  invalidate();
  return s.policy;
}

// For the editor: stored overrides + effective + shipped defaults.
async function describe() {
  const s = await Settings.get();
  const eff = await getEffective();
  return {
    effective: { cheapTaskTypes: [...eff.cheapTaskTypes], lightTargets: eff.lightTargets, mode: eff.mode },
    stored: (s && s.policy) || {},
    defaults: defaults(),
  };
}

module.exports = { getEffective, setPolicy, describe, invalidate, defaults };
