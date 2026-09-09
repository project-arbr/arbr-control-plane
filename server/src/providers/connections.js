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
const secretResolver = require("../security/secretResolver");
const pricing = require("../pricing/registry");
const { perConnCache } = require("../db/context");

const TTL_MS = 3000;
// Per-connection: each tenant caches ONLY its own decrypted provider credentials. A global cache
// here would serve one tenant's keys to another within the 3s window — the worst possible leak.
const _cache = perConnCache();
function invalidate() { _cache.invalidate(); }

// effective() recomputes every few seconds, so warn at most once a minute per
// distinct problem. Silence here is what made the fallback so hard to diagnose.
const WARN_EVERY_MS = 60_000;
const _warned = new Map(); // signature → last logged at
function warnDiscardedDefault(issue) {
  const sig = `${issue.configured}|${issue.defaultProvider}|${issue.reason}`;
  const last = _warned.get(sig) || 0;
  if (Date.now() - last < WARN_EVERY_MS) return;
  _warned.set(sig, Date.now());
  const detail = issue.reason === "provider-mismatch"
    ? `it belongs to provider "${issue.modelProvider}", not the default provider "${issue.defaultProvider}"`
    : `it is not in this instance's model registry (disabled, never synced, or the registry cache is stale)`;
  console.warn(
    `[connections] default model "${issue.configured}" is being ignored because ${detail}. ` +
    `Serving "${issue.serving}" instead. Fix it in Settings, or run Sync Models.`
  );
}

// Decide which model the default provider actually serves, and report when the
// operator's configured choice cannot be honored. The fallback itself is not the
// bug — serving the provider's built-in default is reasonable — but doing it
// silently is, so the caller gets an `issue` to log and surface. Pure; exported
// for tests.
function decideDefaultModel({ configured, defaultProvider, lookup, providerDefaults }) {
  const fallback = defaultProvider ? providerDefaults[defaultProvider] || null : null;
  if (!configured) return { defaultModel: fallback, issue: null };
  const m = lookup(configured);
  if (m && m.provider === defaultProvider) return { defaultModel: configured, issue: null };
  return {
    defaultModel: fallback,
    issue: {
      configured,
      serving: fallback,
      defaultProvider,
      // not-in-registry usually means the model is disabled, was never synced, or
      // this replica's registry cache predates the import.
      reason: m ? "provider-mismatch" : "not-in-registry",
      modelProvider: m ? m.provider : null,
    },
  };
}

// The OpenAI-compatible base URL for a provider, given its entry from effective().
//
// A user-added custom provider that shadows a built-in id WINS. compute() below already
// resolves the credential from that row, so the endpoint has to come from the same record
// — reading the URL from the built-in while the key comes from the custom row sends the
// operator's key to the wrong host (e.g. an on-prem Mistral deployment silently rerouted
// to api.mistral.ai). 
//
// Returns null when neither has a URL — that's a native provider (anthropic/gemini/
// bedrock) which must take the LangChain path instead.
// Pure; exported for tests.
function resolveBaseURL(providerId, entry) {
  const url = entry?.baseURL || PROVIDERS[providerId]?.baseURL || null;
  return url ? url.replace(/\/+$/, "") : null;
}

// Reserved alias for the credential resolved from environment variables. It is never
// stored, never editable, and always the provider's default when present.
const ENV_ALIAS = "env";
const ALIAS_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;

// Normalize an operator-supplied alias, or throw with a message worth showing.
//
// Lowercasing is not cosmetic: MongoDB's unique index compares bytes, so "Prod-EU" and
// "prod-eu" would happily coexist as two different keys that read identically in the UI
// and in a rule's target.
function normalizeAlias(raw) {
  const alias = String(raw ?? "").trim().toLowerCase();
  if (!alias) throw new Error("alias is required");
  if (alias === ENV_ALIAS) {
    throw new Error(`"${ENV_ALIAS}" is reserved for the credential read from environment variables`);
  }
  if (!ALIAS_RE.test(alias)) {
    throw new Error(
      "alias must start with a letter or digit and contain only letters, digits, dots, " +
      "dashes or underscores (max 40 characters)"
    );
  }
  return alias;
}

// Resolve one provider's credential by alias, against an effective() snapshot.
//
// An absent alias asks for the default. An UNKNOWN alias also gets the default, flagged
// with fellBack — a rule pinning a key that was since deleted or renamed then degrades to
// exactly today's behaviour instead of failing the request. Callers surface fellBack so the
// degradation is visible rather than silent.
//
// Returns null only when the provider itself is not live. Pure; exported for tests.
function credentialFor(eff, providerId, alias) {
  const p = eff?.providers?.[providerId];
  if (!p) return null;
  if (alias) {
    const hit = p.credentials?.[alias];
    if (hit) return { credential: hit.credential, alias, source: hit.source, fellBack: false };
  }
  return { credential: p.credential, alias: p.defaultAlias || null, source: p.source, fellBack: !!alias };
}

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

// Apply the provider's default region to an aws credential that lacks one.
function withRegionDefault(id, cred) {
  if (PROVIDERS[id].authType !== "aws" || cred.region) return cred;
  return { ...cred, region: PROVIDERS[id].regionDefault };
}

// Which stored key is the provider's default, when env has not already claimed it.
// Deterministic so a row wrongly carrying isDefault (or two that do) still resolves the
// same way on every replica and every recompute, instead of following cursor order.
function byDefaultPreference(a, b) {
  if (!!b.isDefault !== !!a.isDefault) return b.isDefault ? 1 : -1;
  const aPlain = a.alias === "default", bPlain = b.alias === "default";
  if (aPlain !== bPlain) return bPlain ? 1 : -1;
  const at = a.createdAt ? +new Date(a.createdAt) : 0;
  const bt = b.createdAt ? +new Date(b.createdAt) : 0;
  if (at !== bt) return at - bt;
  return String(a._id).localeCompare(String(b._id));
}

async function compute() {
  const storedByProvider = {};
  for (const c of await ProviderCredential.find().lean()) {
    try {
      (storedByProvider[c.provider] ||= []).push({ ...c, cred: decodeStored(c) });
    } catch { /* skip undecodable */ }
  }
  for (const rows of Object.values(storedByProvider)) rows.sort(byDefaultPreference);
  const settings = await Settings.get();

  const providers = {};
  for (const id of KNOWN_PROVIDERS) {
    const credentials = {};
    for (const row of storedByProvider[id] || []) {
      if (!isComplete(id, row.cred)) continue;
      credentials[row.alias] = {
        credential: withRegionDefault(id, row.cred),
        source: "stored",
        last4: row.last4 || "",
        region: row.region || null,
        isDefault: !!row.isDefault,
        createdAt: row.createdAt || null,
      };
    }

    // Env is merged LAST and wins unconditionally, exactly as it did before multi-key:
    // a deploy that sets OPENAI_API_KEY keeps serving that key for unpinned traffic no
    // matter what is in the database. Merging last also means a legacy row that somehow
    // holds the reserved alias "env" cannot displace the real environment credential.
    const envCred = envCredentialFor(id);
    if (isComplete(id, envCred)) {
      credentials[ENV_ALIAS] = {
        credential: withRegionDefault(id, envCred),
        source: "env",
        last4: (envCred[primaryField(id)] || "").slice(-4),
        region: envCred.region || null,
        isDefault: true,
        createdAt: null,
      };
    }

    const aliases = Object.keys(credentials);
    if (!aliases.length) continue; // provider not configured at all
    const defaultAlias = credentials[ENV_ALIAS]
      ? ENV_ALIAS
      : (storedByProvider[id] || []).find((r) => credentials[r.alias])?.alias || aliases[0];

    providers[id] = {
      // The DEFAULT key. Every pre-multi-key reader (`eff.providers[x].credential`) keeps
      // resolving to exactly what it resolved to before, which is what holds this change
      // to a handful of call sites instead of the whole dispatch layer.
      credential: credentials[defaultAlias].credential,
      defaultModel: DEFAULT_MODELS[id],
      authType: PROVIDERS[id].authType,
      source: credentials[defaultAlias].source,
      defaultAlias,
      credentials,
    };
  }

  // Merge user-added custom providers (OpenAI-compat endpoints stored in MongoDB).
  //
  // A custom row shadowing a built-in id REPLACES it wholesale, aliases included — it does
  // not inherit the built-in's keys. That is providerShadowing.test.js's defect at alias
  // granularity: pinning an alias that only exists on the built-in would pair the built-in's
  // key with this row's baseURL and post the operator's key to the wrong host. An alias pin
  // against a shadowed provider resolves to nothing and falls back to this row's own key.
  for (const cp of await CustomProvider.find({ enabled: true }).lean()) {
    try {
      const apiKey = secrets.decrypt(cp);
      const credential = { apiKey };
      providers[cp.id] = {
        credential,
        defaultModel: null,
        authType: "apiKey",
        source: "stored",
        baseURL: cp.baseURL,
        defaultAlias: "default",
        credentials: {
          default: { credential, source: "stored", last4: cp.last4 || "", region: null, isDefault: true, createdAt: cp.createdAt || null },
        },
        shadowsBuiltin: KNOWN_PROVIDERS.includes(cp.id),
      };
    } catch { /* skip undecodable */ }
  }

  const liveIds = Object.keys(providers);
  const pref = settings.defaultProvider || config.defaultProviderPref;
  const defaultProvider = liveIds.includes(pref) ? pref : (liveIds[0] || null);

  // The chosen default model applies to the default provider; otherwise that
  // provider's built-in default. Falls back if the stored choice no longer fits.
  //
  // A fallback used to happen silently: the operator saw their model in Settings
  // while the gateway served the provider's hardcoded default, with nothing
  // anywhere saying so. The mismatch is now reported (defaultModelIssue) and
  // logged, so it is visible instead of being inferred from odd routing.
  const { defaultModel, issue: defaultModelIssue } = decideDefaultModel({
    configured: settings.defaultModel,
    defaultProvider,
    lookup: (id) => pricing.getModel(id),
    providerDefaults: DEFAULT_MODELS,
  });
  if (defaultModelIssue) warnDiscardedDefault(defaultModelIssue);

  return {
    providers, liveIds, demoMode: liveIds.length === 0,
    defaultProvider, defaultModel, defaultModelIssue,
  };
}

async function effective() {
  const c = _cache.get();
  if (c && Date.now() - c.at < TTL_MS) return c.value;
  const value = await compute();
  _cache.set({ value, at: Date.now() });
  return value;
}

// Per-provider status for the Settings page (never returns secrets).
async function statuses() {
  const settings = await Settings.get();
  const eff = await effective();

  const list = KNOWN_PROVIDERS.map((id) => {
    const spec = PROVIDERS[id];
    const live = eff.providers[id];
    // Whether the env credential came from a managed secret store — the boolean only,
    // never the reference itself.
    const envIsSecretRef = secretResolver.wasSecretRef(spec.env[primaryField(id)]);
    const sourceLabel = (s) => (s === "env" && envIsSecretRef ? "secret-manager" : s);

    // One row per key. Env sorts first (it is always the default and cannot be removed),
    // then stored keys by the same deterministic order compute() used.
    const entries = Object.entries(live?.credentials || {});
    const keys = entries
      .map(([alias, e]) => ({
        alias,
        source: sourceLabel(e.source),
        last4: e.last4 || "",
        region: e.region || null,
        isDefault: alias === live.defaultAlias,
        editable: e.source !== "env",
        createdAt: e.createdAt || null,
      }))
      .sort((a, b) => {
        if (a.editable !== b.editable) return a.editable ? 1 : -1;
        if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
        return a.alias.localeCompare(b.alias);
      });

    // These five keep describing the DEFAULT key, byte-identically to pre-multi-key, so
    // existing console code and any script reading this endpoint is unaffected.
    const defaultKey = keys.find((k) => k.isDefault) || null;
    const source = live ? sourceLabel(live.source) : null;

    return {
      provider: id,
      label: spec.label,
      authType: spec.authType,
      fields: spec.fields,
      defaultModel: spec.defaultModel,
      regionDefault: spec.regionDefault || null,
      configured: !!live,
      source,
      editable: live ? live.source !== "env" : true,
      last4: defaultKey?.last4 || "",
      region: defaultKey?.region || null,
      // New: the full key list, and whether a custom provider has shadowed this id (in
      // which case these aliases are inert — see the shadowing note in compute()).
      keys,
      shadowedByCustom: !!live?.shadowsBuiltin,
    };
  });

  return {
    providers: list,
    defaultProvider: eff.defaultProvider,
    // The model actually served. When it differs from what was configured,
    // defaultModelIssue explains why so the dashboard can say so out loud.
    defaultModel: eff.defaultModel,
    defaultModelIssue: eff.defaultModelIssue || null,
    settingsDefault: settings.defaultProvider || null,
    demoMode: eff.demoMode,
  };
}

// The boot migration (maintenance/migrateCredentialAliases) runs only on the connection that
// was current at boot. A tenant database provisioned later would never get its legacy unique
// index dropped, and its second key would fail with an unreadable E11000. Run it once per
// connection, lazily, on the first write.
const _migrated = perConnCache();
async function ensureMigrated() {
  if (_migrated.get()) return;
  const { migrateCredentialAliases } = require("../maintenance/migrateCredentialAliases");
  await migrateCredentialAliases();
  _migrated.set(true);
}

// credential: object whose shape depends on the provider's authType.
// opts.alias defaults to "default", so the pre-multi-key two-argument call is unchanged.
async function setCredential(provider, credential, opts = {}) {
  const spec = PROVIDERS[provider];
  if (!spec) throw new Error(`unknown provider "${provider}"`);
  if (!credential || typeof credential !== "object") throw new Error("credential is required");
  const alias = opts.alias == null ? "default" : normalizeAlias(opts.alias);

  const cred = {};
  for (const f of spec.fields) {
    if (credential[f] != null && String(credential[f]).trim()) cred[f] = String(credential[f]).trim();
  }
  const required = spec.required || spec.fields;
  const missing = required.filter((f) => !cred[f]);
  if (missing.length) throw new Error(`missing fields: ${missing.join(", ")}`);
  if (spec.authType === "aws" && !cred.region) cred.region = spec.regionDefault;

  await ensureMigrated();

  // The provider's first stored key is its default, or the caller asked for it explicitly.
  const existing = await ProviderCredential.countDocuments({ provider });
  const makeDefault = !!opts.makeDefault || existing === 0;

  const enc = secrets.encrypt(JSON.stringify(cred));
  try {
    if (makeDefault) await ProviderCredential.updateMany({ provider }, { $set: { isDefault: false } });
    await ProviderCredential.findOneAndUpdate(
      { provider, alias },
      { $set: { ...enc, last4: (cred[primaryField(provider)] || "").slice(-4), region: cred.region || null, ...(makeDefault ? { isDefault: true } : {}) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  } catch (err) {
    // A duplicate-key error on {provider} rather than {provider, alias} means the legacy
    // unique index is still on disk. Raw E11000 text is unintelligible here.
    if (err?.code === 11000) {
      throw new Error(
        "Could not save this key: the provider-credential index migration has not completed, " +
        "so this provider still allows only one key. Restart the server and try again."
      );
    }
    throw err;
  }
  invalidate();
}

// No alias removes EVERY stored key for the provider, preserving what
// DELETE /api/connections/:provider has always meant ("disconnect this provider"). Removing
// only the default would leave the provider live on a key the operator believed was gone.
async function removeCredential(provider, alias) {
  if (alias == null) {
    await ProviderCredential.deleteMany({ provider });
    invalidate();
    return;
  }
  const target = await ProviderCredential.findOne({ provider, alias }).lean();
  if (!target) throw new Error(`no key "${alias}" for provider "${provider}"`);
  await ProviderCredential.deleteOne({ _id: target._id });
  // Promote a successor so the provider does not go dark just because its default was removed.
  if (target.isDefault) {
    const rest = await ProviderCredential.find({ provider }).lean();
    const next = rest.sort(byDefaultPreference)[0];
    if (next) await ProviderCredential.updateOne({ _id: next._id }, { $set: { isDefault: true } });
  }
  invalidate();
}

// Mark a stored key as the provider's default. Because an env credential outranks anything
// in the database, this can succeed while changing nothing that serves traffic — the return
// value says which key is actually effective so the caller can be honest about it.
async function setDefaultCredential(provider, alias) {
  const normalized = normalizeAlias(alias);
  const target = await ProviderCredential.findOne({ provider, alias: normalized }).lean();
  if (!target) throw new Error(`no key "${normalized}" for provider "${provider}"`);
  await ProviderCredential.updateMany({ provider }, { $set: { isDefault: false } });
  await ProviderCredential.updateOne({ _id: target._id }, { $set: { isDefault: true } });
  invalidate();
  const eff = await effective();
  return { alias: normalized, effectiveDefault: eff.providers[provider]?.defaultAlias || normalized };
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
  if (model != null) {
    const m = pricing.getModel(model);
    if (!m) throw new Error(`unknown model "${model}"`);
    // Reject a model the gateway would then refuse to use. Without this the save
    // succeeds, Settings shows the model, and requests quietly get the provider's
    // built-in default instead.
    const { defaultProvider } = await effective();
    if (defaultProvider && m.provider !== defaultProvider) {
      throw Object.assign(
        new Error(
          `Model "${model}" belongs to provider "${m.provider}", but the default provider is ` +
          `"${defaultProvider}". Change the default provider first, or pick a model from "${defaultProvider}".`
        ),
        { code: "default_model_provider_mismatch", status: 400 }
      );
    }
  }
  const s = await Settings.get();
  s.defaultModel = model || null;
  await s.save();
  invalidate();
}

module.exports = {
  effective, statuses, setCredential, removeCredential, setDefaultCredential,
  setDefaultProvider, setDefaultModel, invalidate,
  KNOWN: KNOWN_PROVIDERS,
  ENV_ALIAS,
  decideDefaultModel, // pure, exported for tests
  resolveBaseURL,     // pure, exported for tests
  credentialFor,      // pure, exported for tests
  normalizeAlias,     // pure, exported for tests
};
