// POST /v1/ingest — observe-only ingestion (F-01). Reports request-metadata
// events that already happened elsewhere (a partner's own OpenAI-compatible
// gateway, a LiteLLM callback, etc.) so recommendations/analytics/budgets see
// real traffic without moving it through Arbr's own gateway first. No live
// provider call happens here — this endpoint only records what already
// occurred, so gateway/handler.js's enforcement() (block/downgrade) never
// applies; there's nothing left to block.
const pricing = require("../pricing/registry");
const logger = require("../logging/logger");

const MAX_BATCH_SIZE = 500;

// Namespaced per-key so two different integrations can't collide on the same
// partner-chosen id, reusing RequestRecord.requestId's existing global-unique
// index for dedup rather than a new compound constraint.
function namespacedRequestId(keyId, externalRequestId) {
  return `ingest:${keyId}:${externalRequestId}`;
}

function validateEvent(event) {
  if (!event || typeof event !== "object") return "event must be an object";
  if (!event.requestId || typeof event.requestId !== "string") return "requestId is required";
  if (!event.model || typeof event.model !== "string") return "model is required";
  if (event.status && !["success", "failure", "blocked"].includes(event.status)) {
    return "status must be one of: success, failure, blocked";
  }
  return null;
}

async function handleIngest(req, res) {
  // Ingestion needs per-key attribution to scope dedup and trust `application` —
  // require a real key here even in deployments where Settings.requireApiKey is
  // off for the live gateway (auth.middleware otherwise allows anonymous calls).
  if (!req.apiKey) {
    return res.status(401).json({ error: { message: "A gateway API key is required for ingestion." } });
  }

  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events : null;
  if (!events || events.length === 0) {
    return res.status(400).json({ error: { message: "events must be a non-empty array" } });
  }
  if (events.length > MAX_BATCH_SIZE) {
    return res.status(400).json({ error: { message: `events must not exceed ${MAX_BATCH_SIZE} per call` } });
  }

  const keyId = req.apiKey._id;
  const defaultApplication = req.apiKey.application || null;
  const accepted = [];
  const duplicates = [];
  const rejected = [];

  for (const event of events) {
    const externalRequestId = event && typeof event.requestId === "string" ? event.requestId : null;
    const validationError = validateEvent(event);
    if (validationError) {
      rejected.push({ requestId: externalRequestId, error: validationError });
      continue;
    }

    const requestId = namespacedRequestId(keyId, externalRequestId);
    const known = pricing.getModel(event.model);
    const provider = event.provider || known?.provider || null;

    try {
      await logger.writeOrThrow({
        requestId,
        externalRequestId,
        source: "ingested",
        timestamp: event.timestamp ? new Date(event.timestamp) : new Date(),
        application: event.application || defaultApplication,
        workflow: event.workflow || null,
        userId: event.userId || null,
        department: event.department || null,
        provider,
        model: event.model,
        modelRequested: event.modelRequested || event.model,
        taskType: event.taskType || null,
        promptTokens: Number(event.promptTokens) || 0,
        completionTokens: Number(event.completionTokens) || 0,
        totalTokens: Number(event.totalTokens) || 0,
        latencyMs: Number(event.latencyMs) || 0,
        status: event.status || "success",
        errorMessage: event.errorMessage || null,
        knownPricing: !!known,
        routingDecision: "external",
        classifiedBy: "provided",
        cacheHit: false,
        messages: event.messages || null,
        responseText: typeof event.responseText === "string" ? event.responseText : null,
      });
      accepted.push(externalRequestId);
    } catch (err) {
      if (err && err.code === 11000) {
        duplicates.push(externalRequestId);
      } else {
        rejected.push({ requestId: externalRequestId, error: err.message });
      }
    }
  }

  res.json({ accepted, duplicates, rejected });
}

module.exports = { handleIngest, namespacedRequestId, validateEvent, MAX_BATCH_SIZE };
