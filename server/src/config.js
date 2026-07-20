// Central config + provider registry. Reads .env and reports, at boot, which
// providers are live vs demo-only. NO key is required to start.
//
// Providers differ in how they authenticate:
//   - apiKey providers (openai, anthropic, gemini): a single API key
//   - aws providers (bedrock-nova / Amazon Nova): accessKeyId + secretAccessKey + region
// The registry below captures that so the rest of the system stays generic.
require("dotenv").config();

const PROVIDERS = {
  openai: {
    label: "OpenAI",
    authType: "apiKey",
    fields: ["apiKey"],
    env: { apiKey: "OPENAI_API_KEY" },
    defaultModel: "gpt-4o-mini",
    // OPENAI_BASE_URL overrides the API endpoint — set it to your LiteLLM/proxy URL
    // to route all OpenAI-provider requests through that proxy instead.
    baseURL: process.env.OPENAI_BASE_URL || undefined,
  },
  anthropic: {
    label: "Anthropic",
    authType: "apiKey",
    fields: ["apiKey"],
    env: { apiKey: "ANTHROPIC_API_KEY" },
    defaultModel: "claude-haiku-4-5",
  },
  gemini: {
    label: "Google Gemini",
    authType: "apiKey",
    fields: ["apiKey"],
    env: { apiKey: "GEMINI_API_KEY" },
    defaultModel: "gemini-2.5-flash",
  },
  "bedrock-nova": {
    label: "Amazon Bedrock",
    authType: "aws",
    fields: ["accessKeyId", "secretAccessKey", "region"],
    required: ["accessKeyId", "secretAccessKey"], // region defaults if omitted
    env: {
      accessKeyId: "AWS_ACCESS_KEY_ID",
      secretAccessKey: "AWS_SECRET_ACCESS_KEY",
      region: "AWS_REGION",
    },
    regionDefault: "us-east-1",
    defaultModel: "us.amazon.nova-lite-v1:0",
  },
  deepseek: {
    label: "DeepSeek",
    authType: "apiKey",
    fields: ["apiKey"],
    env: { apiKey: "DEEPSEEK_API_KEY" },
    defaultModel: "deepseek-chat",
    baseURL: "https://api.deepseek.com/v1",
  },
  moonshot: {
    label: "Moonshot AI (Kimi)",
    authType: "apiKey",
    fields: ["apiKey"],
    env: { apiKey: "MOONSHOT_API_KEY" },
    defaultModel: "moonshot-v1-8k",
    baseURL: "https://api.moonshot.cn/v1",
  },
  xai: {
    label: "xAI (Grok)",
    authType: "apiKey",
    fields: ["apiKey"],
    env: { apiKey: "XAI_API_KEY" },
    defaultModel: "grok-3-mini",
    baseURL: "https://api.x.ai/v1",
  },
  groq: {
    label: "Groq",
    authType: "apiKey",
    fields: ["apiKey"],
    env: { apiKey: "GROQ_API_KEY" },
    defaultModel: "llama-3.3-70b-versatile",
    baseURL: "https://api.groq.com/openai/v1",
  },
  // LiteLLM Proxy — only registered when LITELLM_BASE_URL is set. Absent from
  // KNOWN_PROVIDERS entirely when unconfigured, so it never enters the fallback
  // chain or the Connections page. Operators register models against it via
  // POST /api/models with { provider: "litellm" }.
  ...(process.env.LITELLM_BASE_URL ? {
    litellm: {
      label: "LiteLLM Proxy",
      authType: "apiKey",
      fields: ["apiKey"],
      env: { apiKey: "LITELLM_API_KEY" },
      defaultModel: process.env.LITELLM_DEFAULT_MODEL || undefined,
      baseURL: process.env.LITELLM_BASE_URL,
    },
  } : {}),
};

const KNOWN_PROVIDERS = Object.keys(PROVIDERS);
const DEFAULT_MODELS = Object.fromEntries(
  KNOWN_PROVIDERS.map((id) => [id, PROVIDERS[id].defaultModel])
);

// The non-region (secret) field used for masking / change detection.
function primaryField(id) {
  return PROVIDERS[id].authType === "aws" ? "secretAccessKey" : "apiKey";
}

// Build a credential object for a provider from environment variables, or null
// if its required fields are not all present.
function envCredentialFor(id) {
  const spec = PROVIDERS[id];
  const required = spec.required || spec.fields;
  const cred = {};
  for (const field of spec.fields) {
    const val = process.env[spec.env[field]];
    if (val && val.trim()) cred[field] = val.trim();
  }
  if (spec.authType === "aws" && !cred.region) cred.region = spec.regionDefault;
  const haveAll = required.every((f) => cred[f]);
  return haveAll ? cred : null;
}

// All env-configured providers → { id: credential }.
function envCredentials() {
  const out = {};
  for (const id of KNOWN_PROVIDERS) {
    const cred = envCredentialFor(id);
    if (cred) out[id] = cred;
  }
  return out;
}

const envLive = envCredentials();
const envLiveIds = Object.keys(envLive);

// Fallback scope when a provider call fails:
//   same-provider — retry the provider's default model only (default; no residency surprise)
//   cross-provider — legacy: walk remaining live providers (availability over locality)
//   none — fail the request; no automatic fallback
const FALLBACK_SCOPES = new Set(["same-provider", "cross-provider", "none"]);
const rawFallback = (process.env.ARBR_FALLBACK_SCOPE || "same-provider").trim().toLowerCase();
const fallbackScope = FALLBACK_SCOPES.has(rawFallback) ? rawFallback : "same-provider";

const isProduction = process.env.NODE_ENV === "production";

// Admin identity mode. "adminkey" (default) is today's single-shared-secret
// behavior — unchanged, so local dev/tests never need to configure OIDC.
// "oidc" and "trusted-header" add real per-user identity (see api/rbac.js,
// api/authProviders/); the admin key still works alongside either as a
// break-glass credential (api/adminAuth.js).
const AUTH_MODES = new Set(["adminkey", "oidc", "trusted-header"]);
const rawAuthMode = (process.env.ARBR_AUTH_MODE || "adminkey").trim().toLowerCase();
const authMode = AUTH_MODES.has(rawAuthMode) ? rawAuthMode : "adminkey";

const config = {
  port: Number(process.env.PORT) || 4100,
  host: process.env.HOST || "0.0.0.0",
  corsOrigin: (process.env.CORS_ORIGIN || "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/arbr-control-plane",
  // Master admin key for the dashboard / admin API (LiteLLM master-key style).
  // Unset = open admin (local dev / demo) with a loud boot warning.
  // Required in production (see assertProductionReady).
  adminKey: process.env.ARBR_ADMIN_KEY || null,
  // Admin API (/api/*) shares one credential, so per-key limiting can't distinguish
  // callers — this caps requests per source IP instead. Generous default; it exists
  // to blunt DB-hammering (accidental loops, a leaked key), not to throttle normal use.
  adminRpmGuardrail: Number(process.env.ARBR_ADMIN_RPM_GUARDRAIL) || 600,

  // Per-user identity (F-04). See AUTH_MODES above.
  authMode,
  oidc: {
    issuer: process.env.ARBR_OIDC_ISSUER || null,
    clientId: process.env.ARBR_OIDC_CLIENT_ID || null,
    clientSecret: process.env.ARBR_OIDC_CLIENT_SECRET || null,
    redirectUri: process.env.ARBR_OIDC_REDIRECT_URI || null,
  },
  trustedHeader: {
    // "iap" verifies a signed Google IAP JWT; "proxy" trusts a forwarded-identity
    // header gated by a shared secret. Only meaningful when authMode is "trusted-header".
    strategy: (process.env.ARBR_TRUSTED_HEADER_STRATEGY || "proxy").trim().toLowerCase(),
    iapAudience: process.env.ARBR_IAP_AUDIENCE || null,
    proxyHeader: process.env.ARBR_PROXY_AUTH_HEADER || "x-forwarded-email",
    proxySecretHeader: process.env.ARBR_PROXY_SECRET_HEADER || "x-arbr-proxy-secret",
    proxySecret: process.env.ARBR_PROXY_AUTH_SECRET || null,
  },
  sessionTtlHours: Number(process.env.ARBR_SESSION_TTL_HOURS) || 12,

  isProduction,
  // Provider-error fallback policy (see invokeWithFallback).
  fallbackScope,

  // Env snapshot at boot. The RUNTIME source of truth for which providers are
  // live is connections.effective() (env creds + dashboard-stored creds merged).
  envLive,
  liveProviderIds: envLiveIds,
  demoMode: envLiveIds.length === 0,
  defaultProviderPref: process.env.DEFAULT_PROVIDER || null,

  defaultModels: DEFAULT_MODELS,
};

// Fail closed in production: no open admin API, no public encryption fallback.
// Call from index.js before listen. Throws with a multi-line message.
function assertProductionReady() {
  if (!config.isProduction) return;
  const missing = [];
  if (!config.adminKey) missing.push("ARBR_ADMIN_KEY (admin/dashboard API must not be open)");
  if (!process.env.ARBR_ENCRYPTION_KEY || !String(process.env.ARBR_ENCRYPTION_KEY).trim()) {
    missing.push("ARBR_ENCRYPTION_KEY (required to encrypt provider keys at rest)");
  }
  if (config.authMode === "oidc") {
    if (!config.oidc.issuer) missing.push("ARBR_OIDC_ISSUER (required when ARBR_AUTH_MODE=oidc)");
    if (!config.oidc.clientId) missing.push("ARBR_OIDC_CLIENT_ID (required when ARBR_AUTH_MODE=oidc)");
    if (!config.oidc.clientSecret) missing.push("ARBR_OIDC_CLIENT_SECRET (required when ARBR_AUTH_MODE=oidc)");
    if (!config.oidc.redirectUri) missing.push("ARBR_OIDC_REDIRECT_URI (required when ARBR_AUTH_MODE=oidc)");
  }
  if (config.authMode === "trusted-header") {
    if (config.trustedHeader.strategy === "iap" && !config.trustedHeader.iapAudience) {
      missing.push("ARBR_IAP_AUDIENCE (required when ARBR_TRUSTED_HEADER_STRATEGY=iap)");
    }
    if (config.trustedHeader.strategy === "proxy" && !config.trustedHeader.proxySecret) {
      missing.push("ARBR_PROXY_AUTH_SECRET (required when ARBR_TRUSTED_HEADER_STRATEGY=proxy)");
    }
  }
  if (missing.length) {
    throw new Error(
      "[config] Refusing to start in production without:\n  - " +
        missing.join("\n  - ") +
        "\nSet these env vars and restart. For local demo, leave NODE_ENV unset."
    );
  }
}

// MONGO_URI may embed credentials (mongodb://user:pass@host/db) — never log it verbatim.
function maskMongoUri(uri) {
  return String(uri).replace(/:\/\/([^:@/]+):([^@/]+)@/, "://$1:****@");
}

function describe() {
  const lines = [];
  lines.push(`Arbr Control Plane`);
  lines.push(`  port:        ${config.port}`);
  lines.push(`  mongo:       ${maskMongoUri(config.mongoUri)}`);
  lines.push(`  env:         ${config.isProduction ? "production" : "development"}`);
  if (config.adminKey) {
    lines.push(`  admin auth:  ON — dashboard + admin API require ARBR_ADMIN_KEY`);
  } else {
    lines.push(`  admin auth:  OFF (dev) — dashboard/admin API are OPEN. Set ARBR_ADMIN_KEY`);
    lines.push(`               before exposing this instance beyond localhost.`);
  }
  if (config.authMode === "oidc") {
    lines.push(`  identity:    OIDC — issuer ${config.oidc.issuer || "(unset)"}`);
  } else if (config.authMode === "trusted-header") {
    lines.push(`  identity:    trusted-header (${config.trustedHeader.strategy})`);
  } else {
    lines.push(`  identity:    admin-key only — no per-user identity (set ARBR_AUTH_MODE=oidc`);
    lines.push(`               or trusted-header for individual accountable access)`);
  }
  lines.push(`  fallback:    ${config.fallbackScope}`);
  if (config.demoMode) {
    lines.push(`  mode:        DEMO at boot — no provider keys in env.`);
    lines.push(`               Add keys in the dashboard (Settings → Connections) or to`);
    lines.push(`               .env to enable live gateway calls (POST /v1/chat). All`);
    lines.push(`               dashboards work on seeded data without any keys.`);
  } else {
    lines.push(`  mode:        LIVE — providers: ${config.liveProviderIds.join(", ")}`);
  }
  return lines.join("\n");
}

module.exports = {
  config,
  describe,
  assertProductionReady,
  PROVIDERS,
  KNOWN_PROVIDERS,
  DEFAULT_MODELS,
  primaryField,
  envCredentialFor,
  envCredentials,
  maskMongoUri,
};
