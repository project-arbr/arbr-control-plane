// Rotate an API key: revoke the old one and mint a replacement with identical
// settings — including its kind ("gateway" | "read") and scope (application, userId).
// Shared by the operator rotate endpoint (routes/keys.js) and the self-service rotate
// endpoint (routes/selfKey.js) so the two can never drift — an earlier copy of this
// logic forgot `kind`, which would silently downgrade a rotated read token to a
// gateway key. Returns { doc, secret }; the secret is shown exactly once.
const crypto = require("crypto");
const ApiKey = require("../models/ApiKey");
const auth = require("../gateway/auth");

async function rotateKey(old) {
  await ApiKey.findByIdAndUpdate(old._id, { enabled: false, revokedAt: new Date() });
  const isRead = old.kind === "read";
  const secret = (isRead ? "ab_read_" : "ab_") + crypto.randomBytes(16).toString("hex");
  const doc = await ApiKey.create({
    name: old.name,
    application: old.application,
    kind: old.kind || "gateway",
    keyHash: auth.hashKey(secret),
    prefix: `${isRead ? "ab_read_…" : "ab_…"}${secret.slice(-4)}`,
    rpm: old.rpm,
    userId: old.userId || null,
    department: old.department || null,
    allowedModels: old.allowedModels || [],
    defaultModel: old.defaultModel || null,
    expiresAt: old.expiresAt || null,
  });
  auth.invalidate();
  return { doc, secret };
}

module.exports = { rotateKey };
