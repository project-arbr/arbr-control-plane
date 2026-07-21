// Encrypt provider API keys at rest (AES-256-GCM). Keys entered via the dashboard
// are stored encrypted; they are never returned to the browser.
//
// The encryption key comes from ARBR_ENCRYPTION_KEY. Outside production, an insecure
// dev fallback is used so the demo runs key-free — with a warning. In production the
// fallback is refused: booting without ARBR_ENCRYPTION_KEY throws, because this is an
// open-source project and the fallback value is public, so storing provider keys under
// it would make them trivially decryptable by anyone. Set ARBR_ENCRYPTION_KEY (any
// strong string) in real deployments.
const crypto = require("crypto");
const secretResolver = require("./secretResolver");

// Public, intentionally-insecure constant: safe to ship only because it is refused in production.
const DEV_FALLBACK = "arbr-dev-insecure-encryption-key-change-me";
let warned = false;

function secret() {
  const s = secretResolver.resolvedOrLiteral("ARBR_ENCRYPTION_KEY");
  if (s && s.trim()) return s.trim();

  // Never silently fall back to the public dev key in production — fail loud and early.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "[secrets] ARBR_ENCRYPTION_KEY is required in production. Without it, stored " +
        "provider keys would be encrypted under a public, well-known dev key. Set " +
        "ARBR_ENCRYPTION_KEY to a strong random string and restart."
    );
  }

  if (!warned) {
    console.warn(
      "[secrets] ARBR_ENCRYPTION_KEY is not set — using an insecure dev key for " +
        "stored provider keys. This is refused in production; set ARBR_ENCRYPTION_KEY there."
    );
    warned = true;
  }
  return DEV_FALLBACK;
}

// 32-byte key derived from the secret.
function keyBytes() {
  return crypto.createHash("sha256").update(secret()).digest();
}

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ct.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
  };
}

function decrypt({ ciphertext, iv, tag }) {
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  const pt = Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]);
  return pt.toString("utf8");
}

// Mask a key for display: show last 4 chars only.
function mask(key) {
  if (!key) return "";
  const tail = key.slice(-4);
  return `••••••••${tail}`;
}

module.exports = { encrypt, decrypt, mask };
