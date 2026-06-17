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
  adminKey: process.env.ARBR_ADMIN_KEY || null,

  // Env snapshot at boot. The RUNTIME source of truth for which providers are
  // live is connections.effective() (env creds + dashboard-stored creds merged).
  envLive,
  liveProviderIds: envLiveIds,
  demoMode: envLiveIds.length === 0,
  defaultProviderPref: process.env.DEFAULT_PROVIDER || null,

  defaultModels: DEFAULT_MODELS,
};

function describe() {
  const lines = [];
  lines.push(`Arbr Control Plane`);
  lines.push(`  port:        ${config.port}`);
  lines.push(`  mongo:       ${config.mongoUri}`);
  if (config.adminKey) {
    lines.push(`  admin auth:  ON — dashboard + admin API require ARBR_ADMIN_KEY`);
  } else {
    lines.push(`  admin auth:  OFF (dev) — dashboard/admin API are OPEN. Set ARBR_ADMIN_KEY`);
    lines.push(`               before exposing this instance beyond localhost.`);
  }
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
  PROVIDERS,
  KNOWN_PROVIDERS,
  DEFAULT_MODELS,
  primaryField,
  envCredentialFor,
  envCredentials,
};
