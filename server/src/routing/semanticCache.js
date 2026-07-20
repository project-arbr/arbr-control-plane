// Semantic response cache. Embeds incoming messages with OpenAI text-embedding-3-small
// (256-dim), stores embedding + response, and finds nearest neighbours on future
// requests using cosine similarity. Falls back silently when OPENAI_API_KEY is not
// set or when an embedding call fails — the exact-match cache still works normally.
//
// Exports:
//   get(messages, threshold, ttlMinutes)  → cached value | null  (async)
//   set(messages, value, ttlMinutes)                             (async, fire-and-forget safe)
//   clear()
//   size()                                → number of live entries
//   cosineSimilarity(a, b)                → 0–1  (exported for tests)
//   _textFromMessages(messages)           → string (exported for tests)

const { OpenAIEmbeddings } = require("@langchain/openai");

const MAX_ENTRIES = 1000;
const _store = new Map(); // key → { embedding: number[], value, expiresAt }
let _seq = 0;
let _embedder = null;
let _embedderInitKey = null;

function _initEmbedder() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  if (_embedder && _embedderInitKey === key) return _embedder;
  _embedder = new OpenAIEmbeddings({
    model: "text-embedding-3-small",
    dimensions: 256,
    openAIApiKey: key,
  });
  _embedderInitKey = key;
  return _embedder;
}

// Call when the OpenAI key changes so the next request re-initialises the embedder.
function invalidate() {
  _embedder = null;
  _embedderInitKey = null;
}

// Returns a number in [0, 1]. Returns 0 when vectors are empty or different lengths.
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom > 0 ? dot / denom : 0;
}

// Build a single string from the message array for embedding.
// All roles included so the model+system context contributes to the fingerprint.
function _textFromMessages(messages) {
  if (!Array.isArray(messages)) return "";
  return messages
    .map((m) => {
      let content = "";
      if (typeof m.content === "string") {
        content = m.content;
      } else if (Array.isArray(m.content)) {
        content = m.content.filter((c) => c.type === "text").map((c) => c.text || "").join(" ");
      }
      return `${m.role || "user"}: ${content}`;
    })
    .join("\n")
    .slice(0, 8000); // text-embedding-3-small token limit is ~8191
}

// Evict expired entries lazily during iteration.
function _evictExpired(now) {
  for (const [k, entry] of _store) {
    if (entry.expiresAt < now) _store.delete(k);
  }
}

async function get(messages, threshold, ttlMinutes) {
  if (_store.size === 0) return null;
  const embedder = _initEmbedder();
  if (!embedder) return null;

  const text = _textFromMessages(messages);
  if (!text) return null;

  let queryVec;
  try {
    queryVec = await embedder.embedQuery(text);
  } catch {
    return null;
  }

  const now = Date.now();
  const thresh = typeof threshold === "number" ? threshold : 0.92;
  _evictExpired(now);

  let best = null, bestSim = -1;
  for (const [, entry] of _store) {
    const sim = cosineSimilarity(queryVec, entry.embedding);
    if (sim > bestSim) { bestSim = sim; best = entry; }
  }

  return bestSim >= thresh ? best.value : null;
}

async function set(messages, value, ttlMinutes) {
  const embedder = _initEmbedder();
  if (!embedder) return;

  const text = _textFromMessages(messages);
  if (!text) return;

  let embedding;
  try {
    embedding = await embedder.embedQuery(text);
  } catch {
    return;
  }

  if (_store.size >= MAX_ENTRIES) {
    const oldest = _store.keys().next().value;
    if (oldest) _store.delete(oldest);
  }

  const ttl = typeof ttlMinutes === "number" && ttlMinutes > 0 ? ttlMinutes : 60;
  _store.set(`sc_${++_seq}`, {
    embedding,
    value,
    expiresAt: Date.now() + ttl * 60 * 1000,
  });
}

function clear() { _store.clear(); }
function size()  { return _store.size; }

module.exports = { get, set, clear, size, cosineSimilarity, invalidate, _textFromMessages };
