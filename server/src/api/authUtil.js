// Shared constant-time comparison for bearer/shared-secret checks. Hashing both
// sides first means crypto.timingSafeEqual (which requires equal-length buffers)
// never rejects on a length mismatch before comparing content.
const crypto = require("crypto");

function timingSafeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function bearerOf(req) {
  const header = req.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : null;
}

module.exports = { timingSafeEqual, bearerOf };
