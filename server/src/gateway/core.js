// Shared gateway core used by both data-plane entry points:
//   POST /v1/chat              → handler.handleChat
//   POST /v1/chat/completions  → openaiCompat.handleOpenAICompat
//
// Routing, fallback, and app-config resolution live here so the two adapters
// cannot drift on policy. Provider-specific response shaping stays in the adapters.
const {
  resolveRoute,
  invokeWithFallback,
  buildFallbackOrder,
  getAppConfig,
} = require("./handler");

// Standard gateway tracing headers (set before JSON or SSE responses).
function setGatewayHeaders(res, { requestId, model, provider, routing, taskType }) {
  if (requestId) res.setHeader("X-Arbr-Request-ID", requestId);
  if (model) res.setHeader("X-Arbr-Model", model);
  if (provider) res.setHeader("X-Arbr-Provider", provider);
  if (routing) res.setHeader("X-Arbr-Routing", routing);
  if (taskType !== undefined) res.setHeader("X-Arbr-Task-Type", taskType || "");
}

module.exports = {
  resolveRoute,
  invokeWithFallback,
  buildFallbackOrder,
  getAppConfig,
  setGatewayHeaders,
};
