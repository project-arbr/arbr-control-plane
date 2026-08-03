// Plain-English narration of WHY a model was served, built from routingExplain
// (captured at decision time) plus the flat record fields. The single source of
// truth for routing narration — used by the Requests drawer AND the Routing-page
// dry-run explainer, so a preview reads exactly like a real request's explanation.
// Falls back gracefully on older records that predate routingExplain.
// See docs/routing-spec.md.
export function explainRouting(r) {
  const x = r.routingExplain || {};
  const d = r.routingDecision;
  const lines = [];
  const clsBits = [
    r.taskType,
    r.difficulty ? `${r.difficulty}${r.difficultyScore ? ` ${r.difficultyScore}/10` : ""}` : null,
    r.confidence != null ? `confidence ${Number(r.confidence).toFixed(2)}` : null,
  ].filter(Boolean).join(", ");

  if (d === "explicit") {
    lines.push(`The client explicitly requested ${r.model}, so Arbr served it directly without applying a routing policy.`);
  } else if (d === "rule") {
    const c = x.rule?.condition || {};
    const on = [c.taskType && `task ${c.taskType}`, c.application && `app ${c.application}`, c.workflow && `workflow ${c.workflow}`].filter(Boolean).join(", ");
    lines.push(`A routing rule${on ? ` (matching ${on})` : ""} directed this request to ${r.model}.`);
    if (x.rule?.note) lines.push(`Rule note: ${x.rule.note}`);
  } else if (d === "ai") {
    lines.push(`Auto-routing: Arbr classified this as ${clsBits || "unknown"}, and the ${x.policy?.source || "global"} AI policy mapped it to ${r.model}.`);
    if (x.policy?.adjustedByDifficulty && x.policy?.base) {
      lines.push(`The policy's base pick was ${x.policy.base}; difficulty${x.policy.effDifficulty ? ` (${x.policy.effDifficulty})` : ""} adjusted it to ${r.model}.`);
    }
  } else if (d === "auto") {
    lines.push(`Guardrail auto-routing substituted ${r.model} based on the task type (${r.taskType || "—"}).`);
  } else if (d === "cache") {
    lines.push(`Served from Arbr's response cache — an identical earlier request to ${r.model} was reused, with no new model call.`);
  } else if (d === "fallback") {
    lines.push(`The primary model failed, so Arbr fell back to ${r.model}.`);
  } else if (d === "budget") {
    lines.push(`A budget cap was breached, so Arbr overrode the routing.`);
  } else {
    lines.push(x.defaultScope === "app"
      ? `No rule or policy matched, so Arbr served this application's default model, ${r.model}.`
      : `No model was pinned and no rule or policy matched, so Arbr served the default model, ${r.model}.`);
  }

  // Overrides chain. Older records carry only the single `override`; newer ones
  // carry the whole ordered `overrides`. Narrating every step is what makes a
  // model the caller never asked for traceable back to the rule that picked it.
  const chain = x.overrides?.length ? x.overrides : (x.override ? [x.override] : []);
  for (const ov of chain) {
    if (ov?.type === "budget" && ov.action === "downgrade") {
      lines.push(`Budget override: cap "${ov.cap?.scope}" (${ov.cap?.period}, $${ov.cap?.limit}) was over limit, so ${ov.from} was downgraded to ${ov.to}.`);
    } else if (ov?.type === "budget" && ov.action === "block") {
      lines.push(`Budget cap "${ov.cap?.scope}" (${ov.cap?.period}, $${ov.cap?.limit}) was over limit; the request was blocked.`);
    } else if (ov?.type === "fallback") {
      lines.push(`Fallback: ${ov.from} failed, so Arbr retried on ${ov.to}.`);
    } else if (ov?.type === "allowed") {
      lines.push(`${ov.from} is not in this API key's allowed-model set, so Arbr served the key's default, ${ov.to}.`);
    } else if (ov?.type === "optout") {
      lines.push(`${ov.from} is opted out for this application, so Arbr served ${ov.to} instead.`);
    } else if (ov?.type === "canary") {
      lines.push(`A canary experiment routed this from ${ov.from} to ${ov.to}.`);
    }
  }

  if (x.allowedViolation) {
    lines.push(`Warning: ${x.allowedViolation.model} was served even though it is not in this key's allowed-model set (${(x.allowedViolation.allowed || []).join(", ")}). The opt-out fallback resolves from the global default, which does not know about the key's allowed set. Narrow the opt-out list or set an allowed key default so the two cannot disagree.`);
  }

  if (x.classificationUsed === false && r.taskType && (d === "explicit" || d === "passthrough" || d === "cache")) {
    lines.push(`Classification ran (${r.taskType}${r.difficulty ? `, ${r.difficulty}` : ""}) but did not influence routing.`);
  }
  return lines;
}
