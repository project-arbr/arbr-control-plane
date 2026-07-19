// Multi-replica-safe RPM limiter using fixed 60s windows in MongoDB.
//
// Atomic $inc on (key, windowStart). Slight concurrent overshoot is possible
// (same as any distributed counter without reservations); far tighter than a
// per-process in-memory sliding window that diverges across replicas.
//
// Falls back to an in-memory window if Mongo is unavailable so a DB blip does
// not open the gateway to unlimited traffic (fail-closed locally at least).
const RateBucket = require("../models/RateBucket");

const WINDOW_MS = 60_000;

// Pure helpers (unit-tested).
function windowStart(now = Date.now()) {
  return Math.floor(now / WINDOW_MS) * WINDOW_MS;
}

function isOverLimit(count, rpm) {
  if (!rpm || rpm <= 0) return false;
  return count > rpm;
}

// In-memory fallback: key -> { windowStart, count }
const _mem = new Map();

function overRpmLimitMemory(key, rpm, now = Date.now()) {
  if (!rpm || rpm <= 0) return false;
  const ws = windowStart(now);
  let entry = _mem.get(key);
  if (!entry || entry.windowStart !== ws) {
    entry = { windowStart: ws, count: 0 };
    _mem.set(key, entry);
  }
  entry.count += 1;
  return isOverLimit(entry.count, rpm);
}

/**
 * Atomically consume one request against `key`'s RPM budget.
 * Returns true if the caller is OVER the limit (should 429).
 */
async function overRpmLimit(key, rpm, now = Date.now()) {
  if (!rpm || rpm <= 0) return false;
  const ws = windowStart(now);
  try {
    const doc = await RateBucket.findOneAndUpdate(
      { key, windowStart: ws },
      {
        $inc: { count: 1 },
        $setOnInsert: { expiresAt: new Date(ws + WINDOW_MS * 2) },
      },
      { upsert: true, returnDocument: "after" }
    ).lean();
    return isOverLimit(doc.count, rpm);
  } catch (err) {
    console.warn("[rateLimit] Mongo unavailable, using in-memory fallback:", err.message);
    return overRpmLimitMemory(key, rpm, now);
  }
}

// Test helpers.
function _resetMemory() {
  _mem.clear();
}

module.exports = {
  overRpmLimit,
  windowStart,
  isOverLimit,
  WINDOW_MS,
  _overRpmLimitMemory: overRpmLimitMemory,
  _resetMemory,
};
