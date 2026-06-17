// Encrypt provider API keys at rest (AES-256-GCM). Keys entered via the dashboard
// are stored encrypted; they are never returned to the browser.
//
// The encryption key comes from ARBR_ENCRYPTION_KEY. If unset, a dev fallback is
// used so the demo still runs — but a warning is printed, because storing keys
// under a known dev secret is not safe for production. Set ARBR_ENCRYPTION_KEY
// (any strong string) in real deployments.
const crypto = require("crypto");

const DEV_FALLBACK = "arbr-dev-insecure-encryption-key-change-me";
let warned = false;

function secret() {
  const s = process.env.ARBR_ENCRYPTION_KEY;
  if (s && s.trim()) return s.trim();
  if (!warned) {
    console.warn(
      "[secrets] ARBR_ENCRYPTION_KEY is not set — using an insecure dev key for " +
        "stored provider keys. Set ARBR_ENCRYPTION_KEY before production."
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
