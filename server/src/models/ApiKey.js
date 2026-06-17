// Gateway API keys (virtual keys). The full secret ("ka_" + 32 hex) is shown
// ONCE at creation; only its sha256 hash is stored. A key binds requests to an
// application — attribution becomes trusted instead of self-reported.
const mongoose = require("mongoose");

const apiKeySchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    application: { type: String, required: true, index: true },
    keyHash: { type: String, required: true, unique: true },
    // Display-only identifier, e.g. "ka_…a1b2" (never enough to reconstruct).
    prefix: { type: String, required: true },
    enabled: { type: Boolean, default: true },
    // Requests per minute (null = unlimited). Enforced in-memory at the gateway.
    rpm: { type: Number, default: null },
    createdAt: { type: Date, default: Date.now },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { collection: "api_keys" }
);

module.exports = mongoose.model("ApiKey", apiKeySchema);
