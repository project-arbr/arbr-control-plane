// A Map with a TTL and a hard entry cap, for caches keyed on caller-supplied
// strings.
//
// A plain Map guarded by an `expiresAt` check leaks: entries go logically stale
// but stay resident for the process lifetime, so a caller that varies the key on
// every request grows it without bound. Here expired entries are dropped on read
// and an insert at capacity evicts the oldest, so size is bounded by maxEntries
// no matter how many distinct keys are seen.
//
// Eviction is insertion-ordered FIFO (Map preserves insertion order). Refreshing
// an existing key keeps its original position, so eviction order is approximate
// rather than true LRU. That is the same trade-off routing/responseCache.js
// makes, and it is fine when the point is bounding memory rather than maximising
// hit rate.

function createBoundedTtlCache({ ttlMs, maxEntries }) {
  if (!(ttlMs > 0)) throw new Error("boundedTtlCache: ttlMs must be > 0");
  if (!(maxEntries > 0)) throw new Error("boundedTtlCache: maxEntries must be > 0");

  const store = new Map(); // key -> { value, expiresAt }

  // Returns the live entry, or undefined on a miss or expiry. Callers read
  // `.value`. Handing back the entry rather than the value is what lets a cached
  // `null` (a negative cache) be told apart from a miss.
  function getEntry(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      store.delete(key);
      return undefined;
    }
    return entry;
  }

  function get(key) {
    const entry = getEntry(key);
    return entry ? entry.value : undefined;
  }

  function has(key) {
    return getEntry(key) !== undefined;
  }

  function set(key, value) {
    // Refreshing a key already held must not evict anything, so only an insert
    // that actually grows the map counts against the cap.
    if (store.size >= maxEntries && !store.has(key)) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
    store.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  function clear() {
    store.clear();
  }

  return { getEntry, get, has, set, clear, get size() { return store.size; } };
}

module.exports = { createBoundedTtlCache };
