// Coerce a bare-string `messages` into the array both gateways expect. The arbr-client SDKs
// document `messages` as accepting "a bare string" (→ one user message) and normalize it
// client-side (clients/js/src/index.js, clients/python __init__.py). Applying the same
// coercion server-side honors that documented contract for callers hitting the raw HTTP API
// or porting from the SDK docs, instead of returning "messages array is required".
//
// Only a string is transformed; arrays (and any other shape) pass through unchanged so the
// existing validation still rejects genuinely-invalid bodies.
function normalizeMessages(messages) {
  if (typeof messages === "string") return [{ role: "user", content: messages }];
  return messages;
}

module.exports = { normalizeMessages };
