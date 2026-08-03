// Gateway API keys (virtual keys). The full secret ("ka_" + 32 hex) is shown
// ONCE at creation; only its sha256 hash is stored. A key binds requests to an
// application — attribution becomes trusted instead of self-reported.
const mongoose = require("mongoose");

const apiKeySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    application: { type: String, required: true, index: true },
    // "gateway" (default) — a data-plane key that runs inference at /v1/chat, bound
    // to this application for trusted attribution. "read" — a scoped, read-only usage
    // token: it can read ONLY this application's (+ optional userId's) analytics via
    // /v1/usage, and is rejected on the data plane. Lets a partner app expose
    // self-serve per-user usage without proxying through the admin key.
    kind: { type: String, enum: ["gateway", "read"], default: "gateway", index: true },
    keyHash: { type: String, required: true, unique: true },
    // Display-only identifier, e.g. "ka_…a1b2" (never enough to reconstruct).
    prefix: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    // Requests per minute (null = unlimited). Enforced in-memory at the gateway.
    rpm: { type: Number, default: null },
    // Per-app model restrictions. [] = unrestricted (inherit global routing).
    allowedModels: { type: [String], default: [] },
    // Override the global default model when this key sends model:"auto". null = use global.
    defaultModel: { type: String, default: null },
    // Per-key attribution: attribute every request from this key to a specific user / team.
    // Trusted (unlike self-reported body fields) because it's set at key-creation time.
    userId:     { type: String, default: null },
    department: { type: String, default: null },
    // Optional expiry date. Gateway rejects keys whose expiresAt is in the past.
    expiresAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { collection: "api_keys" }
);

module.exports = mongoose.model("ApiKey", apiKeySchema);
