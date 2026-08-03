// Side-effect-free route preview.
//
// Given a hypothetical request (a model, a task type, an application, a workflow,
// whether it carries an image), return the model Arbr WOULD serve and the full
// precedence trace — without calling a provider, classifying via a billable LLM, or
// logging anything. It reuses the real resolveRoute (in dryRun mode), so the preview
// cannot drift from what live traffic actually does. Budget enforcement is previewed
// on top with a read-only cap check.
//
// Powers POST /api/routing/explain and the Routing page's "Test a route" panel.
const { resolveRoute } = require("../gateway/handler");
const capEngine = require("./capEngine");
const pricing = require("../pricing/registry");

// A synthetic request body. When hasImage is set we include an image part so the
// vision guard is exercised exactly as it would be for a real multimodal request.
function previewBody({ model, provider, taskType, hasImage }) {
  const content = hasImage
    ? [{ type: "text", text: "(dry run)" }, { type: "image_url", image_url: { url: "https://example.invalid/preview.png" } }]
    : "(dry run)";
  const body = { model: model || "auto", messages: [{ role: "user", content }] };
  if (provider) body.provider = provider;
  if (taskType) body.taskType = taskType;
  return body;
}

async function explainRoute(input, { eff, appConfig = {}, appDbConfig = null } = {}) {
  const { application = null, workflow = null, userId = null } = input || {};
  const body = previewBody(input || {});

  // dryRun: no billable classification, no provider call, no logging. resolveRoute
  // already performs no I/O beyond DB-cache reads, so this is a pure decision.
  const r = await resolveRoute(body, {
    router: null, eff, application, workflow, userId, appConfig, appDbConfig, dryRun: true,
  });

  // Budget preview: would an enforcing cap block or downgrade this served model?
  // Read-only — enforcement() only reads CapSpend counters.
  let budget = null;
  const enf = await capEngine.enforcement({ application, provider: r.served.provider }).catch(() => null);
  if (enf && enf.action === "block") {
    budget = { action: "block", scope: capEngine.describeScope(enf.cap), period: enf.cap.period, limit: enf.cap.limit };
  } else if (enf && enf.action === "downgrade") {
    const target = pricing.suggestLightTarget(r.served.model);
    budget = { action: "downgrade", to: target ? target.model : null, scope: capEngine.describeScope(enf.cap), period: enf.cap.period, limit: enf.cap.limit };
  }

  // Shaped like a RequestRecord so the dashboard's existing routing narration renders
  // it directly (single narration source of truth, per docs/routing-spec.md).
  return {
    model: r.served.model,
    provider: r.served.provider,
    routingDecision: r.routingDecision,
    taskType: r.taskType,
    classifiedBy: r.classifiedBy,
    difficulty: r.difficulty,
    difficultyScore: r.difficultyScore,
    confidence: r.confidence,
    routingExplain: r.explain,
    overrides: r.explain.overrides || null,
    budget,
  };
}

module.exports = { explainRoute, previewBody };
