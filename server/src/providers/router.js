// Builds the vendored llm-router from the EFFECTIVE providers (env + stored).
// Rebuilt automatically when the set of live providers / keys changes, so keys
// added in the dashboard take effect without a restart.
const { createRouter } = require("./llm-router");
const connections = require("./connections");
const { PROVIDERS } = require("../config");

let _router = null;
let _signature = "";

// A signature of the live provider set + creds, so we rebuild only on change.
function signatureOf(eff) {
  return eff.liveIds
    .map((id) => `${id}:${JSON.stringify(eff.providers[id].credential).slice(-12)}`)
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
  return { apiKey: p.credential.apiKey, model: p.defaultModel, baseURL: PROVIDERS[id]?.baseURL };
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

module.exports = { getRouter, toRouterConfig };
