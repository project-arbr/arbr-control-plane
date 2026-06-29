// Pure projection of a proposed taskType->model policy over aggregated traffic. Split out from
// aiPolicy.js so the math is testable without a DB. No dependencies injected as functions:
//   rows:        [{ taskType, servedModel, requests, promptTokens, completionTokens, actualCost }]
//   assignments: { [taskType]: modelId }  (the PROPOSED policy)
//   priceOf(modelId, promptTokens, completionTokens) -> total cost, or null if unpriceable
//   capOf(taskType, modelId) -> capability score 0-1, or null if unknown
//
// A taskType absent from `assignments` keeps its currently-served model (no change for that slice).
// Cost is a real re-pricing; the capability index is a heuristic PROXY, not measured quality.
function projectImpact(rows, assignments, priceOf, capOf) {
  const perTask = {};
  let curCost = 0, projCost = 0, wSum = 0, curCapW = 0, projCapW = 0;

  for (const r of rows || []) {
    const tt = r.taskType;
    const proposed = (assignments && assignments[tt]) || r.servedModel;
    const projected = priceOf(proposed, r.promptTokens, r.completionTokens);
    const projRowCost = projected == null ? (r.actualCost || 0) : projected; // unpriceable -> no change
    curCost += r.actualCost || 0;
    projCost += projRowCost;

    const w = r.requests || 0;
    wSum += w;
    const curCap = capOf(tt, r.servedModel); if (curCap != null) curCapW += w * curCap;
    const projCap = capOf(tt, proposed);     if (projCap != null) projCapW += w * projCap;

    const e = perTask[tt] || (perTask[tt] = { taskType: tt, requests: 0, actualCost: 0, projectedCost: 0, proposedModel: proposed, currentModels: {} });
    e.requests += w;
    e.actualCost += r.actualCost || 0;
    e.projectedCost += projRowCost;
    e.proposedModel = proposed;
    e.currentModels[r.servedModel] = (e.currentModels[r.servedModel] || 0) + w;
  }

  const rowsOut = Object.values(perTask).map((e) => ({
    taskType: e.taskType,
    requests: e.requests,
    currentModel: Object.entries(e.currentModels).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    proposedModel: e.proposedModel,
    actualCost: e.actualCost,
    projectedCost: e.projectedCost,
    saved: e.actualCost - e.projectedCost,
  })).sort((a, b) => b.saved - a.saved);

  return {
    current:   { cost: curCost,  capabilityIndex: wSum ? curCapW / wSum : null },
    projected: { cost: projCost, capabilityIndex: wSum ? projCapW / wSum : null },
    rows: rowsOut,
  };
}

module.exports = { projectImpact };
