// Central served-model governance guard.
//
// Routing can change the served model at several points AFTER the initial pick —
// canary diversion, an allowed-set swap, an opt-out swap, a budget downgrade, and
// provider fallback. Historically only the first pick was checked against the app's
// allowed-models / opt-out list and the request's vision needs, so a fallback or a
// downgrade could serve a model the app is restricted from, or a text-only model for
// an image request (surfacing as a 502). This module is the single place those checks
// live, so every mutation point validates the same way.
//
// See docs/routing-spec.md (§Known gaps) for why this exists.
const pricing = require("../pricing/registry");

// True when any message carries image content (OpenAI multimodal shape).
function hasVisionContent(messages) {
  return Array.isArray(messages) && messages.some(
    (m) => Array.isArray(m.content) && m.content.some((c) => c && c.type === "image_url")
  );
}

// Vision support is asserted only when the registry says so: a model absent from the
// registry, or present with a null flag (unknown), counts as NOT known-capable.
function isVisionCapable(modelId) {
  const m = pricing.getModel(modelId);
  return !!m && m.supportsVision === true;
}

// Build the governance context for a request once, from the app config and body.
// allowedModels is the API key's allow-list (empty = unrestricted); modelOptOut is
// the app's blocked-model list; requireVision is set when the request has an image.
function governanceFor({ appConfig = {}, appDbConfig = null, messages } = {}) {
  return {
    allowedModels: appConfig.allowedModels || [],
    modelOptOut: (appDbConfig && appDbConfig.modelOptOut) || [],
    requireVision: hasVisionContent(messages),
  };
}

// Verdict for serving `model` under a governance context: { ok: true } or
// { ok: false, reason }. reason ∈ allowed | optout | vision | unpriced.
//
// requirePriced additionally rejects a model with no positive price. Use it for
// AUTOMATIC targets (fallback candidates, budget downgrades) so an unpriced model is
// never auto-selected — it logs $0 and its spend cannot be enforced (the #232 class).
// An explicit user choice is never priced-gated.
function checkModel(model, ctx = {}) {
  const { allowedModels = [], modelOptOut = [], requireVision = false, requirePriced = false } = ctx;
  if (allowedModels.length && !allowedModels.includes(model)) return { ok: false, reason: "allowed" };
  if (modelOptOut.length && modelOptOut.includes(model)) return { ok: false, reason: "optout" };
  if (requireVision && !isVisionCapable(model)) return { ok: false, reason: "vision" };
  if (requirePriced) {
    const m = pricing.getModel(model);
    if (!m || !(m.inputPer1M > 0)) return { ok: false, reason: "unpriced" };
  }
  return { ok: true };
}

module.exports = { hasVisionContent, isVisionCapable, governanceFor, checkModel };
