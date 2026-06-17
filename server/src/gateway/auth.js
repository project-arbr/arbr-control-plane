// Gateway API-key auth for /v1/* (the data plane). The dashboard/admin API stays
// local-trust this phase.
//
// Behaviour:
//   - A presented key is ALWAYS validated: invalid/revoked → 401.
//   - A valid key binds the request's `application` (trusted attribution — it
//     overrides whatever the body claims) and enforces the key's rpm limit.
//   - No key: allowed while Settings.requireApiKey is false (default, so existing
//     integrations keep working); 401 once an operator flips it on.
const crypto = require("crypto");
const ApiKey = require("../models/ApiKey");
const Settings = require("../models/Settings");

const KEY_TTL_MS = 5000;
let _cache = { byHash: new Map(), at: 0 };

function invalidate() {
  _cache.at = 0;
}

function hashKey(rawKey) {
  return crypto.createHash("sha256").update(rawKey).digest("hex");
}

async function _keysByHash() {
  if (Date.now() - _cache.at < KEY_TTL_MS) return _cache.byHash;
  const docs = await ApiKey.find({ enabled: true, revokedAt: null }).lean();
  _cache = { byHash: new Map(docs.map((d) => [d.keyHash, d])), at: Date.now() };
  return _cache.byHash;
}

// In-memory per-key sliding window for rpm limits. { keyHash -> number[] (ms timestamps) }
const _windows = new Map();
function overRpmLimit(keyHash, rpm) {
  if (!rpm || rpm <= 0) return false;
  const now = Date.now();
  const cutoff = now - 60_000;
  let arr = _windows.get(keyHash);
  if (!arr) _windows.set(keyHash, (arr = []));
  while (arr.length && arr[0] < cutoff) arr.shift();
  if (arr.length >= rpm) return true;
  arr.push(now);
  return false;
}

// Throttled lastUsedAt stamping (at most once per minute per key, async).
const _lastStamped = new Map();
function stampLastUsed(keyDoc) {
  const prev = _lastStamped.get(keyDoc.keyHash) || 0;
  if (Date.now() - prev < 60_000) return;
  _lastStamped.set(keyDoc.keyHash, Date.now());
  setImmediate(() =>
    ApiKey.updateOne({ _id: keyDoc._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {})
  );
}

async function requireApiKeyOn() {
  const s = await Settings.get();
  return !!s.requireApiKey;
}

async function setRequireApiKey(on) {
  const s = await Settings.get();
  s.requireApiKey = !!on;
  await s.save();
  return s.requireApiKey;
}

// Express middleware for the data plane.
async function middleware(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : null;

    if (raw) {
      const keys = await _keysByHash();
      const doc = keys.get(hashKey(raw));
      if (!doc) {
        return res.status(401).json({ error: "invalid_api_key", message: "Unknown, disabled, or revoked API key." });
      }
      if (overRpmLimit(doc.keyHash, doc.rpm)) {
        return res.status(429).json({
          error: "rate_limited",
          message: `API key "${doc.name}" is over its ${doc.rpm} requests/minute limit.`,
        });
      }
      stampLastUsed(doc);
      req.apiKey = doc; // handler uses doc.application as trusted attribution
      return next();
    }

    if (await requireApiKeyOn()) {
      return res.status(401).json({
        error: "invalid_api_key",
        message: "An API key is required (Authorization: Bearer ka_…). Create one in Settings → API keys.",
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { middleware, hashKey, invalidate, requireApiKeyOn, setRequireApiKey };
