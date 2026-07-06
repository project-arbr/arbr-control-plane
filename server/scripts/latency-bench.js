#!/usr/bin/env node
// Standalone latency benchmark for the Arbr gateway.
// Usage:
//   ARBR_GATEWAY_URL=http://localhost:4100 ARBR_API_KEY=ab_... \
//     node server/scripts/latency-bench.js [--requests 50] [--concurrency 5] [--stream] [--model gpt-4o-mini]
//   node server/scripts/latency-bench.js --compare bench/results/latency-A.json bench/results/latency-B.json

const fs   = require("fs");
const path = require("path");
const http  = require("http");
const https = require("https");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function flag(name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return def;
  return argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
}

const COMPARE_IDX = argv.indexOf("--compare");
if (COMPARE_IDX !== -1) {
  const a = argv[COMPARE_IDX + 1];
  const b = argv[COMPARE_IDX + 2];
  if (!a || !b) { console.error("--compare requires two file paths"); process.exit(1); }
  compareResults(a, b);
  process.exit(0);
}

const REQUESTS    = parseInt(flag("requests",    "50"),  10);
const CONCURRENCY = parseInt(flag("concurrency", "5"),   10);
const STREAM      = flag("stream", false) === true || flag("stream", false) === "true";
const MODEL       = flag("model", "gpt-4o-mini");
const WARMUP      = 5;
const PROMPT      = "Reply with exactly three words.";

const BASE_URL = process.env.ARBR_GATEWAY_URL || "http://localhost:4100";
const API_KEY  = process.env.ARBR_API_KEY     || "";

if (!API_KEY) {
  console.error("Set ARBR_API_KEY env var before running.");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function post(url, body, { streaming } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib = parsed.protocol === "https:" ? https : http;
    const data = JSON.stringify(body);
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
          "Authorization": `Bearer ${API_KEY}`,
        },
      },
      (res) => {
        if (streaming) {
          resolve(res); // caller reads the stream
        } else {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => {
            try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
            catch (e) { reject(e); }
          });
        }
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Single request — non-streaming
// ---------------------------------------------------------------------------
async function requestOnce() {
  const start = Date.now();
  const { status, body } = await post(`${BASE_URL}/v1/chat/completions`, {
    model: MODEL,
    messages: [{ role: "user", content: PROMPT }],
    max_tokens: 32,
    temperature: 0,
  });
  const latencyMs = Date.now() - start;
  if (status !== 200) throw new Error(`HTTP ${status}: ${JSON.stringify(body)}`);
  return { latencyMs, ttftMs: null };
}

// ---------------------------------------------------------------------------
// Single request — streaming (SSE), records TTFT
// ---------------------------------------------------------------------------
async function requestStream() {
  const start = Date.now();
  const res = await post(
    `${BASE_URL}/v1/chat/completions`,
    { model: MODEL, messages: [{ role: "user", content: PROMPT }], max_tokens: 32, temperature: 0, stream: true },
    { streaming: true }
  );
  if (res.statusCode !== 200) {
    const chunks = [];
    for await (const c of res) chunks.push(c);
    throw new Error(`HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString()}`);
  }
  return new Promise((resolve, reject) => {
    let ttftMs = null;
    res.on("data", (chunk) => {
      if (ttftMs === null) {
        const text = chunk.toString();
        // First non-empty SSE data line marks TTFT
        if (text.includes("data:") && !text.includes("data: [DONE]")) {
          ttftMs = Date.now() - start;
        }
      }
    });
    res.on("end", () => resolve({ latencyMs: Date.now() - start, ttftMs }));
    res.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    min:   sorted[0],
    max:   sorted[sorted.length - 1],
    mean:  Math.round(sum / sorted.length),
    p50:   percentile(sorted, 0.5),
    p95:   percentile(sorted, 0.95),
    p99:   percentile(sorted, 0.99),
  };
}

// ---------------------------------------------------------------------------
// Concurrency pool
// ---------------------------------------------------------------------------
async function runPool(n, concurrency, fn) {
  const results = [];
  let running = 0;
  let sent    = 0;

  return new Promise((resolve, reject) => {
    function next() {
      while (running < concurrency && sent < n) {
        const idx = sent++;
        running++;
        fn(idx)
          .then((r) => { results.push(r); })
          .catch((e) => { results.push({ error: e.message }); })
          .finally(() => { running--; if (results.length === n) resolve(results); else next(); });
      }
    }
    next();
  });
}

// ---------------------------------------------------------------------------
// Main bench
// ---------------------------------------------------------------------------
async function main() {
  const reqFn = STREAM ? requestStream : requestOnce;

  process.stdout.write(`Warming up (${WARMUP} requests)…`);
  for (let i = 0; i < WARMUP; i++) {
    await reqFn().catch(() => {});
    process.stdout.write(".");
  }
  console.log(" done.\n");

  console.log(`Running ${REQUESTS} requests (concurrency=${CONCURRENCY}, stream=${STREAM}, model=${MODEL})…`);
  const results = await runPool(REQUESTS, CONCURRENCY, () => reqFn());

  const errors = results.filter((r) => r.error);
  const ok     = results.filter((r) => !r.error);

  if (errors.length) {
    console.warn(`\n${errors.length} errors:`);
    errors.slice(0, 3).forEach((e) => console.warn("  ", e.error));
    if (errors.length > 3) console.warn(`  … and ${errors.length - 3} more`);
  }

  const latencies = ok.map((r) => r.latencyMs);
  const ttfts     = ok.map((r) => r.ttftMs).filter((v) => v !== null);

  const latencyStats = stats(latencies);
  const ttftStats    = ttfts.length ? stats(ttfts) : null;

  console.log("\nLatency (wall-clock, ms):");
  console.log(`  min=${latencyStats.min}  p50=${latencyStats.p50}  p95=${latencyStats.p95}  p99=${latencyStats.p99}  max=${latencyStats.max}  mean=${latencyStats.mean}  n=${latencyStats.count}`);

  if (ttftStats) {
    console.log("\nTTFT (ms):");
    console.log(`  min=${ttftStats.min}  p50=${ttftStats.p50}  p95=${ttftStats.p95}  p99=${ttftStats.p99}  max=${ttftStats.max}  mean=${ttftStats.mean}  n=${ttftStats.count}`);
  }

  // Save results
  const dateStr = new Date().toISOString().slice(0, 10);
  const outDir  = path.join(__dirname, "../../bench/results");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `latency-${dateStr}.json`);
  const record = {
    date: new Date().toISOString(),
    config: { requests: REQUESTS, concurrency: CONCURRENCY, stream: STREAM, model: MODEL },
    errors: errors.length,
    latency: latencyStats,
    ttft: ttftStats,
  };
  fs.writeFileSync(outPath, JSON.stringify(record, null, 2));
  console.log(`\nResults saved → ${outPath}`);
}

// ---------------------------------------------------------------------------
// --compare
// ---------------------------------------------------------------------------
function compareResults(pathA, pathB) {
  const a = JSON.parse(fs.readFileSync(pathA, "utf8"));
  const b = JSON.parse(fs.readFileSync(pathB, "utf8"));

  console.log(`\nComparing latency results:`);
  console.log(`  A: ${pathA}  (${a.date})`);
  console.log(`  B: ${pathB}  (${b.date})\n`);

  const METRICS = ["p50", "p95", "p99", "min", "max", "mean"];
  const pad = (s, n) => String(s).padStart(n);
  const pct = (va, vb) => {
    if (va == null || vb == null) return "n/a";
    const d = ((vb - va) / va) * 100;
    return `${d >= 0 ? "+" : ""}${d.toFixed(1)}%`;
  };

  console.log("Latency (ms):");
  console.log(`  ${"metric".padEnd(8)} ${pad("A", 8)} ${pad("B", 8)} ${"delta".padStart(10)} ${"change".padStart(8)}`);
  for (const m of METRICS) {
    const va = a.latency?.[m];
    const vb = b.latency?.[m];
    const delta = (va != null && vb != null) ? (vb - va) : null;
    console.log(`  ${m.padEnd(8)} ${pad(va ?? "—", 8)} ${pad(vb ?? "—", 8)} ${pad(delta != null ? (delta >= 0 ? "+" + delta : delta) : "—", 10)}ms ${pad(pct(va, vb), 8)}`);
  }

  if (a.ttft || b.ttft) {
    console.log("\nTTFT (ms):");
    console.log(`  ${"metric".padEnd(8)} ${pad("A", 8)} ${pad("B", 8)} ${"delta".padStart(10)} ${"change".padStart(8)}`);
    for (const m of METRICS) {
      const va = a.ttft?.[m];
      const vb = b.ttft?.[m];
      const delta = (va != null && vb != null) ? (vb - va) : null;
      console.log(`  ${m.padEnd(8)} ${pad(va ?? "—", 8)} ${pad(vb ?? "—", 8)} ${pad(delta != null ? (delta >= 0 ? "+" + delta : delta) : "—", 10)}ms ${pad(pct(va, vb), 8)}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
