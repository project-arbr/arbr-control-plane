// AI-generated routing policy: a task-type → model assignment the AI produces from
// the available models (and observed custom task types), editable by an operator and
// regeneratable. Used in auto mode when routingMode === "ai". Cached like the rule set.
const Settings = require("../models/Settings");
const RequestRecord = require("../models/RequestRecord");
const pricing = require("../pricing/registry");
const { TASK_TYPES } = require("../classify/classifier");

let _cache = { map: null, at: 0 };
const TTL_MS = 5000;
function invalidate() { _cache.at = 0; }

// Task types apps have actually sent (lowercased), from the request log.
async function observedTaskTypes() {
  const seen = await RequestRecord.distinct("taskType");
  return seen.filter(Boolean).map((t) => String(t).toLowerCase());
}

// Built-in catalog ∪ observed (so custom task types get covered).
async function allTaskTypes() {
  const seen = await observedTaskTypes();
  return [...new Set([...TASK_TYPES, ...seen])];
}

// The current assignments map (cached). { [taskType]: modelId }
async function getEffective() {
  if (_cache.map && Date.now() - _cache.at < TTL_MS) return _cache.map;
  const s = await Settings.get();
  const map = (s.aiPolicy && s.aiPolicy.assignments) || {};
  _cache = { map, at: Date.now() };
  return map;
}

// Resolve a task type to { provider, model } via the map, or null. Liveness is
// checked by the caller (it has the effective live set).
function lookup(map, taskType) {
  const model = map[String(taskType || "").toLowerCase()];
  if (!model) return null;
  const m = pricing.getModel(model);
  return m ? { provider: m.provider, model } : null;
}

// Operator edits — keep only entries whose model is known to the pricing table.
async function setAssignments(assignments) {
  const clean = {};
  for (const [t, model] of Object.entries(assignments || {})) {
    if (pricing.getModel(model)) clean[String(t).toLowerCase()] = model;
  }
  const s = await Settings.get();
  s.aiPolicy = { ...(s.aiPolicy || {}), assignments: clean };
  s.markModified("aiPolicy");
  await s.save();
  invalidate();
  return s.aiPolicy;
}

function parseAssignments(text, validIds, tasks, fallback) {
  let obj = {};
  try {
    const m = String(text || "").match(/\{[\s\S]*\}/);
    if (m) obj = JSON.parse(m[0]);
  } catch { obj = {}; }
  const valid = new Set(validIds);
  const out = {};
  for (const t of tasks) {
    const v = obj[t] || obj[String(t).toLowerCase()];
    out[t] = valid.has(v) ? v : fallback;
  }
  return out;
}

// Ask the default model to assign each task type → an available model.
async function regenerate({ router, eff }) {
  if (!router || !eff || !eff.defaultProvider) throw new Error("no live provider to generate the policy");
  const liveModels = [];
  const liveIdSet = new Set(eff.liveIds);
  for (const m of pricing.listModels()) {
    if (liveIdSet.has(m.provider)) liveModels.push({ id: m.id, tier: m.tier, in: m.inputPer1M, out: m.outputPer1M });
  }
  const tasks = await allTaskTypes();
  const fallback = eff.defaultModel || liveModels[0]?.id;
  const prompt =
    `You are an LLM routing planner. Available models (id, tier, $input/$output per 1M tokens):\n` +
    liveModels.map((m) => `- ${m.id} [${m.tier}] $${m.in}/$${m.out}`).join("\n") +
    `\n\nFor EACH task type below, choose the single best AVAILABLE model id, balancing capability and cost ` +
    `(simple/cheap tasks like classification, extraction, faq, translation → cheap light models; ` +
    `complex tasks like reasoning, coding, document analysis → stronger models). ` +
    `Respond with ONLY a JSON object mapping each task type to one model id, no prose.\n\nTask types:\n` +
    tasks.map((t) => `- ${t}`).join("\n");

  const result = await router.complete({
    messages: [{ role: "user", content: prompt }],
    providerOverride: eff.defaultProvider,
    modelOverride: eff.defaultModel,
    temperature: 0,
    maxTokens: 4096, // headroom so "thinking" default models still emit the full JSON
  });
  const assignments = parseAssignments(result.text, liveModels.map((m) => m.id), tasks, fallback);
  const s = await Settings.get();
  s.aiPolicy = { assignments, generatedAt: new Date(), generatorModel: result.modelId };
  s.markModified("aiPolicy");
  await s.save();
  invalidate();
  return s.aiPolicy;
}

// Full view for the editor: assignments + catalogs + what's unmapped/custom.
async function describe() {
  const s = await Settings.get();
  const ai = s.aiPolicy || {};
  const assignments = ai.assignments || {};
  const observed = await observedTaskTypes();
  const customTaskTypes = observed.filter((t) => !TASK_TYPES.includes(t));
  const taskTypes = [...new Set([...TASK_TYPES, ...observed])];
  const unmapped = taskTypes.filter((t) => !assignments[t]);
  return {
    assignments,
    generatedAt: ai.generatedAt || null,
    generatorModel: ai.generatorModel || null,
    builtInTaskTypes: TASK_TYPES,
    customTaskTypes,
    taskTypes,
    unmapped,
  };
}

module.exports = { getEffective, lookup, setAssignments, regenerate, describe, invalidate };
