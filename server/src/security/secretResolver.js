// Resolves credential-shaped env var values that may hold a secret-manager
// reference instead of a literal. A no-op for every existing deployment: a
// literal value is returned unchanged. Cloud-agnostic — PROVIDERS_REGISTRY
// holds one entry per backing store; adding AWS/Azure later means writing
// one file implementing the same { matches, resolve } shape and appending it
// here, with zero changes to anything below.
const { parseSecretRef } = require("./secretRef");
const gcpSecretManager = require("./secretProviders/gcpSecretManager");

const PROVIDERS_REGISTRY = [gcpSecretManager];

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // secret rotation isn't hot-path

// envVarName -> { value, ref } | undefined. Resolved values only ever live
// here — never logged, never serialized in any API response.
const _cache = new Map();
let _timer = null;

function findProvider(rawValue) {
  return PROVIDERS_REGISTRY.find((p) => p.matches(rawValue));
}

// Resolves one env var's raw value. Literal values pass through untouched
// (the common case). Returns the resolved value; throws on a ref that fails
// to resolve — callers decide whether that's fatal.
async function resolveOne(envVarName, rawValue) {
  const ref = parseSecretRef(rawValue);
  if (!ref) {
    _cache.delete(envVarName); // a literal never counts as "was a secret ref"
    return rawValue;
  }
  const provider = findProvider(rawValue);
  if (!provider) throw new Error(`[secrets] no provider registered for scheme "${ref.scheme}"`);
  const value = await provider.resolve(rawValue);
  _cache.set(envVarName, { value, ref: rawValue });
  return value;
}

// Resolves every name in the list (reading process.env fresh). Collects
// failures instead of throwing per-item — the caller (production boot vs.
// dev warn) decides what a failure means.
async function refreshAll(envVarNames) {
  const resolved = [];
  const failures = [];
  for (const name of envVarNames) {
    const raw = process.env[name];
    if (raw === undefined) continue; // unset — nothing to resolve, existing behavior
    try {
      await resolveOne(name, raw);
      resolved.push(name);
    } catch (err) {
      failures.push({ name, error: err.message });
    }
  }
  return { resolved, failures };
}

// Sync cache read — the hot-path accessor every credential reader calls on
// every request. Returns undefined when there's nothing resolved (literal
// value, unset var, or a failed resolve), so callers fall through to
// process.env[name] exactly as they do today.
function getResolved(envVarName) {
  return _cache.get(envVarName)?.value;
}

// True if the cached entry for this name came from a resolved secret-manager
// reference (for the Connections UI's source label) — never exposes the ref
// itself, just the boolean.
function wasSecretRef(envVarName) {
  return _cache.has(envVarName);
}

// The value every credential reader should actually use: the resolved
// value if there is one, else the raw env var IF it's a genuine literal —
// but never the raw ref string itself when resolution hasn't happened yet
// or failed (e.g. dev mode, where a failure only warns rather than refusing
// to start). Without this, a still-unresolved "gcp-sm://..." string would
// be silently accepted as if it were the credential itself.
function resolvedOrLiteral(envVarName) {
  const resolved = getResolved(envVarName);
  if (resolved !== undefined) return resolved;
  const raw = process.env[envVarName];
  return parseSecretRef(raw) ? undefined : raw;
}

function startPeriodicRefresh(envVarNames, intervalMs = DEFAULT_INTERVAL_MS) {
  if (_timer) return;
  const connections = require("../providers/connections"); // lazy: avoid a require-time cycle
  _timer = setInterval(async () => {
    await refreshAll(envVarNames);
    connections.invalidate();
  }, intervalMs);
  if (_timer.unref) _timer.unref();
}

function stopPeriodicRefresh() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

// Boot-time fail-closed check (pure, sync — easy to unit-test in isolation
// from the rest of index.js's start() sequence, which also connects Mongo
// and binds the HTTP port). In production, any resolution failure refuses
// to start; outside production, a failure is just a warning, matching
// today's existing behavior for a missing/blank var.
function assertResolvedOrThrow(failures, isProduction) {
  if (isProduction && failures.length) {
    throw new Error("[secrets] Refusing to start — could not resolve:\n  - " +
      failures.map((f) => `${f.name}: ${f.error}`).join("\n  - "));
  }
  for (const f of failures) {
    console.warn(`[secrets] could not resolve ${f.name}: ${f.error} — treating as unset.`);
  }
}

module.exports = {
  resolveOne, refreshAll, getResolved, wasSecretRef, resolvedOrLiteral,
  startPeriodicRefresh, stopPeriodicRefresh, assertResolvedOrThrow,
  PROVIDERS_REGISTRY,
};
