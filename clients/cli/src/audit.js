"use strict";

const fs = require("fs");
const readline = require("readline");
const { planRecommendations } = require("./vendor/recommendEngine");
const pricing = require("./vendor/pricingTable");

// Parse a newline-delimited JSON file into an array of raw request records.
// Each line reuses Arbr's own RequestRecord field names (server/src/models/RequestRecord.js):
// taskType, model, provider, promptTokens, completionTokens, totalCost are the fields this
// tool reads; everything else on the line is ignored. Blank lines are skipped. A malformed
// line throws with its 1-based line number so a bad export is easy to locate and fix.
async function parseJsonl(path) {
  const records = [];
  const stream = fs.createReadStream(path, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`${path}:${lineNo}: not valid JSON (${err.message})`);
    }
    records.push(parsed);
  }
  return records;
}

// Reduce raw RequestRecord-shaped lines into the {taskType, model, requests,
// promptTokens, completionTokens, currentCost} shape planRecommendations expects.
// `application` is deliberately left undefined on every group — an individual audit
// has no team/app concept, so planRecommendations always takes its global-fallback
// path rather than trying to scope a recommendation to an application.
function aggregateGroups(records) {
  const byKey = new Map();
  let totalRequests = 0;
  let totalCost = 0;

  for (const r of records) {
    const taskType = r.taskType || "unknown";
    const model = r.model || r.modelRequested || "unknown";
    const provider = r.provider || pricing.getModel(model)?.provider || "unknown";
    const promptTokens = Number(r.promptTokens) || 0;
    const completionTokens = Number(r.completionTokens) || 0;
    const cost = Number(r.totalCost) || 0;

    totalRequests += 1;
    totalCost += cost;

    const key = `${taskType}|${model}|${provider}`;
    if (!byKey.has(key)) {
      byKey.set(key, { taskType, model, provider, requests: 0, promptTokens: 0, completionTokens: 0, currentCost: 0 });
    }
    const g = byKey.get(key);
    g.requests += 1;
    g.promptTokens += promptTokens;
    g.completionTokens += completionTokens;
    g.currentCost += cost;
  }

  return { groups: [...byKey.values()], totalRequests, totalCost };
}

// Aggregate -> planRecommendations, shared by every input source (a local JSONL
// file, or records fetched directly from a live Arbr instance's export API).
// opts.cheapTaskTypes overrides the default set from the vendored pricing table.
function runAuditFromRecords(records, opts = {}) {
  const { groups, totalRequests, totalCost } = aggregateGroups(records);

  const cheapTaskTypes = opts.cheapTaskTypes
    ? new Set(opts.cheapTaskTypes.map((t) => String(t).toLowerCase()))
    : pricing.CHEAP_TASK_TYPES;

  const recommendations = planRecommendations(groups, cheapTaskTypes, {
    isPremium: pricing.isPremium,
    suggestLightTarget: pricing.suggestLightTarget,
    costFor: pricing.costFor,
    minRequests: opts.minRequests,
  });

  const flaggedCost = recommendations.reduce((s, r) => s + r.currentCost, 0);
  const flaggedSavings = recommendations.reduce((s, r) => s + r.projectedSavings, 0);

  return {
    totalRequests,
    totalCost,
    groups,
    recommendations,
    flaggedCost,
    flaggedSavings,
    overusePct: totalCost > 0 ? (flaggedSavings / totalCost) * 100 : 0,
  };
}

// Full local-file pipeline: parse a JSONL file -> runAuditFromRecords.
async function runAudit(path, opts = {}) {
  const records = await parseJsonl(path);
  return runAuditFromRecords(records, opts);
}

module.exports = { parseJsonl, aggregateGroups, runAudit, runAuditFromRecords };
