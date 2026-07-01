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

module.exports = { classifyModelImport };
