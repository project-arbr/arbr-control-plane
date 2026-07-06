// Pure decision for importing a discovered model id into the registry under a custom
// provider. Dependency-free so it can be unit-tested without a DB.
//
//   existing      — the current ModelEntry row for this id ({ provider, builtIn }), or null
//   providerId    — the custom provider we're importing into
//   connectable   — Set of provider ids that are "owned" (built-in known providers + other live
//                   custom providers) and must NOT be hijacked by a re-point
//
// Returns one of:
//   "create"      — no such id yet → register a fresh row under providerId
//   "skip-exists" — already registered under this provider → no-op
//   "adopt"       — an ORPHANED synced row (e.g. LiteLLM-discovered `nvidia-nim`) → re-point its
//                   provider to providerId so it becomes routable (keeps its pricing/capabilities)
//   "conflict"    — id is owned by a built-in or another connectable provider → refuse (don't hijack)
function classifyModelImport(existing, providerId, connectable) {
  if (!existing) return "create";
  if (existing.provider === providerId) return "skip-exists";
  if (existing.builtIn || (connectable && connectable.has(existing.provider))) return "conflict";
  return "adopt";
}

// An OpenAI-compatible provider's GET /v1/models lists everything it hosts — including
// non-chat models (embeddings, rerankers, retrievers, moderation, OCR, speech, image-gen)
// that 404 on /chat/completions and must not be routed to. Heuristic id filter so discovery
// can default-select only chat-capable models. Conservative: keeps vision/multimodal chat.
// Media-generation ids (image / video / music / audio) also 404 on chat and must not be routed
// to. These slipped in via provider discovery (e.g. Gemini's `lyria-*` music model was registered
// as a light-tier $0 "chat" model and got auto-assigned to an extraction task). Keep additions
// SPECIFIC to media families so we never exclude a real chat model that merely contains a substring.
const NON_CHAT_MODEL = /embed|rerank|retriev|guardrail|moderation|paddleocr|whisper|parakeet|\briva\b|diffusion|sdxl|\bflux\b|\bclip\b|\bocr\b|\btts\b|text-to-speech|speech-to-text|lyria|imagen|\bveo\b|dall-?e|musicgen|audiogen|\bsora\b|stable-?audio|image-generation|video-generation/i;
function isChatLikelyModelId(id) {
  return !NON_CHAT_MODEL.test(String(id || ""));
}

module.exports = { classifyModelImport, isChatLikelyModelId, NON_CHAT_MODEL };
