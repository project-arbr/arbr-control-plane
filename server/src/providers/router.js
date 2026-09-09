// Builds the vendored llm-router from the EFFECTIVE providers (env + stored).
// Rebuilt automatically when the set of live providers / keys changes, so keys
// added in the dashboard take effect without a restart.
const { createRouter } = require("./llm-router");
const connections = require("./connections");

let _router = null;
let _signature = "";

// A signature of the live provider set + creds, so we rebuild only on change.
//
// defaultAlias is part of the signature because the credential tail alone is not enough:
// promote a different key to default and, if the two keys happen to share their last 12
// serialized characters, the memoized router keeps serving the old one.
function signatureOf(eff) {
  return eff.liveIds
    .map((id) => `${id}:${eff.providers[id].defaultAlias}:${JSON.stringify(eff.providers[id].credential).slice(-12)}`)
    .sort()
    .join("|") + `#default=${eff.defaultProvider}`;
}

// Translate an effective provider entry into the vendored router's config shape.
function toRouterConfig(id, p) {
  if (p.authType === "aws") {
    return {
      model: p.defaultModel,
      region: p.credential.region,
      credentials: {
        accessKeyId: p.credential.accessKeyId,
        secretAccessKey: p.credential.secretAccessKey,
      },
    };
  }
  return { apiKey: p.credential.apiKey, model: p.defaultModel, baseURL: connections.resolveBaseURL(id, p) };
}

// The partial router config that swaps in a pinned key for `providerId`, or null when the
// pin resolves to the key the router already holds — so unpinned traffic passes undefined
// and takes a code path identical to before multi-key.
//
// Reuses toRouterConfig so the apiKey-vs-aws shape is decided in exactly one place; a second
// copy of that branching is how a pinned AWS key ends up sent as a bearer token.
function credentialOverrideFor(eff, providerId, alias) {
  if (!alias) return null;
  const entry = eff?.providers?.[providerId];
  if (!entry) return null;
  const resolved = connections.credentialFor(eff, providerId, alias);
  if (!resolved || resolved.alias === entry.defaultAlias) return null;
  const cfg = toRouterConfig(providerId, { ...entry, credential: resolved.credential });
  // Only the credential fields — model and baseURL still come from the router's own config.
  return entry.authType === "aws"
    ? { region: cfg.region, credentials: cfg.credentials }
    : { apiKey: cfg.apiKey };
}

// Returns { router, eff } or { router: null, eff } in demo mode.
async function getRouter() {
  const eff = await connections.effective();
  if (eff.demoMode || !eff.defaultProvider) {
    _router = null; _signature = "";
    return { router: null, eff };
  }

  const sig = signatureOf(eff);
  if (_router && sig === _signature) return { router: _router, eff };

  const providers = {};
  for (const id of eff.liveIds) {
    providers[id] = toRouterConfig(id, eff.providers[id]);
  }
  const fallbackChain = eff.liveIds.filter((id) => id !== eff.defaultProvider);

  _router = createRouter({ providers, defaultProvider: eff.defaultProvider, fallbackChain });
  _signature = sig;
  return { router: _router, eff };
}

module.exports = { getRouter, toRouterConfig, credentialOverrideFor, signatureOf };
