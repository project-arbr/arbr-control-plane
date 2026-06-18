// Effective provider resolution: merges env credentials with dashboard-stored
// (encrypted) credentials. ENV CREDENTIALS TAKE PRECEDENCE. This is the runtime
// source of truth for which providers are live.
//
// Credentials are provider-shaped:
//   apiKey providers → { apiKey }
//   aws providers    → { accessKeyId, secretAccessKey, region }
//
// Cached briefly and invalidated on any credential / default change.
const {
  config, PROVIDERS, KNOWN_PROVIDERS, DEFAULT_MODELS, primaryField, envCredentialFor,
} = require("../config");
const ProviderCredential = require("../models/ProviderCredential");
const CustomProvider = require("../models/CustomProvider");
const Settings = require("../models/Settings");
const secrets = require("../security/secrets");
const pricing = require("../pricing/registry");

const TTL_MS = 3000;
let _cache = { value: null, at: 0 };
function invalidate() { _cache.at = 0; }

// Decrypt a stored credential doc into a credential object. Handles the legacy
// shape where the ciphertext was a bare API-key string.
function decodeStored(doc) {
  const raw = secrets.decrypt(doc);
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === "object") return obj;
  } catch { /* not JSON — legacy bare key */ }
  return { apiKey: raw };
}

function isComplete(id, cred) {
  if (!cred) return false;
  const spec = PROVIDERS[id];
  const required = spec.required || spec.fields;
  return required.every((f) => cred[f]);
}

async function compute() {
  const stored = {};
  for (const c of await ProviderCredential.find().lean()) {
    try { stored[c.provider] = decodeStored(c); } catch { /* skip undecodable */ }
  }
  const settings = await Settings.get();

  const providers = {};
  for (const id of KNOWN_PROVIDERS) {
    const envCred = envCredentialFor(id);
    let credential = null, source = null;
    if (isComplete(id, envCred)) { credential = envCred; source = "env"; }
    else if (isComplete(id, stored[id])) { credential = stored[id]; source = "stored"; }
    if (!credential) continue;
    // Apply region default for aws.
    if (PROVIDERS[id].authType === "aws" && !credential.region) {
      credential = { ...credential, region: PROVIDERS[id].regionDefault };
    }
    providers[id] = {
      credential,
      defaultModel: DEFAULT_MODELS[id],
      authType: PROVIDERS[id].authType,
      source,
    };
  }

  // Merge user-added custom providers (OpenAI-compat endpoints stored in MongoDB).
  for (const cp of await CustomProvider.find({ enabled: true }).lean()) {
    try {
      const apiKey = secrets.decrypt(cp);
      providers[cp.id] = {
        credential: { apiKey },
        defaultModel: null,
        authType: "apiKey",
        source: "stored",
        baseURL: cp.baseURL,
      };
    } catch { /* skip undecodable */ }
  }

  const liveIds = Object.keys(providers);
  const pref = settings.defaultProvider || config.defaultProviderPref;
  const defaultProvider = liveIds.includes(pref) ? pref : (liveIds[0] || null);

  // The chosen default model applies to the default provider; otherwise that
  // provider's built-in default. Falls back if the stored choice no longer fits.
  let defaultModel = defaultProvider ? DEFAULT_MODELS[defaultProvider] : null;
  if (settings.defaultModel) {
    const m = pricing.getModel(settings.defaultModel);
    if (m && m.provider === defaultProvider) defaultModel = settings.defaultModel;
  }

  return { providers, liveIds, demoMode: liveIds.length === 0, defaultProvider, defaultModel };
}

async function effective() {
  if (_cache.value && Date.now() - _cache.at < TTL_MS) return _cache.value;
  const value = await compute();
  _cache = { value, at: Date.now() };
  return value;
}

// Per-provider status for the Settings page (never returns secrets).
async function statuses() {
  const storedDocs = {};
  for (const c of await ProviderCredential.find().lean()) storedDocs[c.provider] = c;
  const settings = await Settings.get();
  const eff = await effective();

  const list = KNOWN_PROVIDERS.map((id) => {
    const spec = PROVIDERS[id];
    const live = eff.providers[id];
    let source = live ? live.source : null;
    let last4 = "", region = null;
    if (source === "env") {
      const envCred = envCredentialFor(id);
      last4 = (envCred?.[primaryField(id)] || "").slice(-4);
      region = envCred?.region || null;
    } else if (source === "stored") {
      last4 = storedDocs[id]?.last4 || "";
      region = storedDocs[id]?.region || null;
    }
    return {
      provider: id,
      label: spec.label,
      authType: spec.authType,
      fields: spec.fields,
      defaultModel: spec.defaultModel,
      regionDefault: spec.regionDefault || null,
      configured: !!source,
      source,
      editable: source !== "env",
      last4,
      region,
    };
  });

  return {
    providers: list,
    defaultProvider: eff.defaultProvider,
    defaultModel: eff.defaultModel,
    settingsDefault: settings.defaultProvider || null,
    demoMode: eff.demoMode,
  };
}

// credential: object whose shape depends on the provider's authType.
async function setCredential(provider, credential) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`unknown provider "${provider}"`);
  if (!credential || typeof credential !== "object") throw new Error("credential is required");

  const cred = {};
  for (const f of spec.fields) {
    if (credential[f] != null && String(credential[f]).trim()) cred[f] = String(credential[f]).trim();
  }
  const required = spec.required || spec.fields;
  const missing = required.filter((f) => !cred[f]);
  if (missing.length) throw new Error(`missing fields: ${missing.join(", ")}`);
  if (spec.authType === "aws" && !cred.region) cred.region = spec.regionDefault;

  const enc = secrets.encrypt(JSON.stringify(cred));
  await ProviderCredential.findOneAndUpdate(
    { provider },
    { $set: { ...enc, last4: (cred[primaryField(provider)] || "").slice(-4), region: cred.region || null } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  invalidate();
}

async function removeCredential(provider) {
  await ProviderCredential.deleteOne({ provider });
  invalidate();
}

async function setDefaultProvider(provider) {
  if (provider != null) {
    const { liveIds } = await effective();
    if (!liveIds.includes(provider)) throw new Error(`unknown or unconfigured provider "${provider}"`);
  }
  const s = await Settings.get();
  s.defaultProvider = provider || null;
  await s.save();
  invalidate();
}

async function setDefaultModel(model) {
  if (model != null && !pricing.getModel(model)) throw new Error(`unknown model "${model}"`);
  const s = await Settings.get();
  s.defaultModel = model || null;
  await s.save();
  invalidate();
}

module.exports = {
  effective, statuses, setCredential, removeCredential, setDefaultProvider, setDefaultModel, invalidate,
  KNOWN: KNOWN_PROVIDERS,
};
