// Semantic cache smoke test — sends two semantically similar (but not identical)
// requests and verifies the second one hits the semantic cache.
//
// Prerequisites:
//   1. Server running on PORT (default 4100)
//   2. OpenAI API key configured (OPENAI_API_KEY in .env)
//   3. Semantic cache enabled in Governance → General Settings
//
// Run: node server/scripts/semantic-cache-smoke.js
//   Or with a custom port: PORT=4100 node server/scripts/semantic-cache-smoke.js

const BASE = `http://localhost:${process.env.PORT || 4100}`;
const API_KEY = process.env.ARBR_API_KEY || null;  // optional — set if requireApiKey is on

const HEADERS = {
  "Content-Type": "application/json",
  ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
};

// Two semantically similar requests — same intent, different wording.
// Measured similarity with text-embedding-3-small (256-dim): ~0.91
const REQUEST_1 = {
  messages: [{ role: "user", content: "What is the capital city of France?" }],
  application: "semantic-cache-smoke",
};
const REQUEST_2 = {
  messages: [{ role: "user", content: "Which city serves as the capital of France?" }],
  application: "semantic-cache-smoke",
};

async function post(body) {
  const res = await fetch(`${BASE}/v1/chat`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, ...json };
}

function label(routingDecision) {
  if (routingDecision === "semantic_cache") return "✅ SEMANTIC CACHE HIT";
  if (routingDecision === "cache")          return "✅ EXACT-MATCH CACHE HIT";
  return `🌐 PROVIDER CALL (${routingDecision})`;
}

(async () => {
  console.log("=== Semantic Cache Smoke Test ===\n");
  console.log(`Server: ${BASE}`);
  console.log(`API key: ${API_KEY ? API_KEY.slice(0, 6) + "…" : "(none)"}\n`);

  // ── Request 1 — should miss cache, call provider ───────────────────────────
  console.log("── Request 1 ─────────────────────────────────────────────");
  console.log(`Prompt: "${REQUEST_1.messages[0].content}"`);
  let r1;
  try {
    r1 = await post(REQUEST_1);
  } catch (e) {
    console.error("❌ Request 1 failed:", e.message);
    process.exit(1);
  }

  if (r1.status >= 400) {
    console.error(`❌ Request 1 error ${r1.status}:`, JSON.stringify(r1));
    process.exit(1);
  }

  console.log(`Routing: ${label(r1.routingDecision)}`);
  console.log(`Model:   ${r1.model}  (${r1.provider})`);
  console.log(`Reply:   ${r1.text?.slice(0, 120)}…`);

  if (r1.routingDecision === "cache" || r1.routingDecision === "semantic_cache") {
    console.log("\n⚠️  Request 1 already hit the cache — clear it first and re-run:");
    console.log(`   curl -s -X POST ${BASE}/api/cache/clear`);
    console.log(`   curl -s -X POST ${BASE}/api/cache/semantic/clear`);
    process.exit(0);
  }

  // Brief pause so the setImmediate cache store has time to embed + store.
  console.log("\nWaiting 3 s for embedding to complete…");
  await new Promise((r) => setTimeout(r, 3000));

  // ── Request 2 — should hit semantic cache ─────────────────────────────────
  console.log("\n── Request 2 ─────────────────────────────────────────────");
  console.log(`Prompt: "${REQUEST_2.messages[0].content}"`);
  let r2;
  try {
    r2 = await post(REQUEST_2);
  } catch (e) {
    console.error("❌ Request 2 failed:", e.message);
    process.exit(1);
  }

  if (r2.status >= 400) {
    console.error(`❌ Request 2 error ${r2.status}:`, JSON.stringify(r2));
    process.exit(1);
  }

  console.log(`Routing: ${label(r2.routingDecision)}`);
  console.log(`Model:   ${r2.model || "(from cache)"}  (${r2.provider || "cached"})`);
  console.log(`Reply:   ${r2.text?.slice(0, 120)}…`);

  // ── Result ─────────────────────────────────────────────────────────────────
  console.log("\n── Result ────────────────────────────────────────────────");
  if (r2.routingDecision === "semantic_cache") {
    console.log("✅ PASS — second request served from semantic cache");
    console.log("   Check Requests log in the dashboard — both entries should be visible:");
    console.log(`   • Request 1: routingDecision = ${r1.routingDecision}`);
    console.log(`   • Request 2: routingDecision = semantic_cache  (cacheHit = true)`);
  } else if (r2.routingDecision === "cache") {
    console.log("✅ Exact-match cache hit (messages were identical enough for SHA-256 match)");
  } else {
    console.log(`⚠️  MISS — second request went to provider (routingDecision = ${r2.routingDecision})`);
    console.log("   Check:");
    console.log("   • Semantic cache is enabled in Governance → General Settings");
    console.log("   • OPENAI_API_KEY is set in .env");
    console.log("   • Threshold is not set too high (default 0.92 works for these prompts)");
    console.log(`   • Semantic cache stats: curl -s ${BASE}/api/cache/semantic/stats`);
  }
})();
