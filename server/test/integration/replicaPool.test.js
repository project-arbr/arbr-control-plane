"use strict";
/**
 * Replica pools end to end: /v1/chat/completions → pooled custom providers → fake
 * OpenAI-compatible upstreams. Covers load spreading, failover when a member disappears,
 * cooldown, draining via the admin API, the all-draining 503, streaming retry, and that a
 * client error is not retried. Uses MONGO_URI_TEST or a local mongod; skips without one.
 */
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const mongoose = require("mongoose");

process.env.ARBR_ADMIN_KEY = "";
process.env.ARBR_REPLICA_COOLDOWN_MS = "60000";

let agent, skip = false, RequestRecord, replicaPool;
const MODEL = "pool-test-model";

// A fake vLLM: answers chat completions in the mode it is set to, counting requests.
function fakeUpstream(name) {
  const u = { name, mode: "ok", hits: 0, server: null, port: 0 };
  u.server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      u.hits += 1;
      if (u.mode === "503") { res.writeHead(503, { "Content-Type": "application/json" }); return res.end('{"error":{"message":"busy"}}'); }
      if (u.mode === "400") { res.writeHead(400, { "Content-Type": "application/json" }); return res.end('{"error":{"message":"bad request"}}'); }
      const body = JSON.parse(raw || "{}");
      if (u.mode === "slow") return setTimeout(() => { u.mode = "ok"; respond(body); }, 400);
      respond(body);
    });
    function respond(body) {
      const usage = { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 };
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: `hi from ${name}` } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: `hi from ${name}` }, finish_reason: "stop" }], usage }));
    }
  });
  return u;
}
const listen = (u) => new Promise((r) => u.server.listen(0, "127.0.0.1", () => { u.port = u.server.address().port; r(); }));
const ups = { a: fakeUpstream("a"), b: fakeUpstream("b") };

before(async () => {
  try {
    const uri = process.env.MONGO_URI_TEST || "mongodb://127.0.0.1:27017/arbr-replica-pool-test";
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
    await mongoose.connection.db.dropDatabase();
  } catch (err) {
    skip = true;
    console.warn("[replicaPool] skipping — no Mongo available:", err.message);
    return;
  }
  await listen(ups.a);
  await listen(ups.b);
  const supertest = require("supertest");
  const { mountCore } = require("../../src/cloud");
  const ModelEntry = require("../../src/models/ModelEntry");
  const pricing = require("../../src/pricing/registry");
  RequestRecord = require("../../src/models/RequestRecord");
  replicaPool = require("../../src/gateway/replicaPool");
  agent = supertest(mountCore());

  for (const id of ["a", "b"]) {
    const r = await agent.post("/api/custom-providers").send({
      id: `pool-${id}`, label: `Pool ${id}`, baseURL: `http://127.0.0.1:${ups[id].port}/v1`, apiKey: "k", pool: "Qwen Pool",
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.pool, "qwen-pool");
  }
  await ModelEntry.create({ id: MODEL, provider: "pool-a", label: MODEL, tier: "mid", inputPer1M: 0, outputPer1M: 0 });
  await pricing.reload();
});

after(async () => {
  for (const u of Object.values(ups)) u.server.close();
  if (mongoose.connection.readyState) {
    await mongoose.connection.db.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
});

beforeEach(async () => {
  if (skip) return;
  for (const u of Object.values(ups)) { u.mode = "ok"; u.hits = 0; }
  replicaPool._reset();
  for (const id of ["a", "b"]) await agent.patch(`/api/custom-providers/pool-${id}`).send({ draining: false });
});

const maybeSkip = (t) => { if (skip) { t.skip("no Mongo"); return true; } return false; };
const chat = (extra = {}) => agent.post("/v1/chat/completions")
  .send({ model: MODEL, messages: [{ role: "user", content: "hello" }], ...extra });

test("requests spread across both members of the pool", async (t) => {
  if (maybeSkip(t)) return;
  const served = [];
  for (let i = 0; i < 6; i++) {
    const r = await chat();
    assert.equal(r.status, 200);
    served.push(r.headers["x-arbr-provider"]);
  }
  assert.equal(ups.a.hits, 3);
  assert.equal(ups.b.hits, 3);
  assert.deepEqual([...new Set(served)].sort(), ["pool-a", "pool-b"]);
});

test("a member that errors is retried on the other, then skipped while it cools down", async (t) => {
  if (maybeSkip(t)) return;
  ups.a.mode = "503";
  for (let i = 0; i < 4; i++) {
    const r = await chat();
    assert.equal(r.status, 200, "the client never sees the failed member");
    assert.match(r.body.choices[0].message.content, /from b/);
  }
  assert.equal(ups.a.hits, 1, "after one failure pool-a is in cooldown and not tried again");
  const health = (await agent.get("/api/replica-pools")).body;
  const a = health.find((h) => h.provider === "pool-a");
  assert.equal(a.healthy, false);
  assert.ok(a.cooldownRemainingMs > 0);
});

test("a member that has gone away entirely is failed over", async (t) => {
  if (maybeSkip(t)) return;
  const port = ups.a.port;
  await new Promise((r) => ups.a.server.close(r)); // connection refused, like a reclaimed host
  try {
    for (let i = 0; i < 3; i++) {
      const r = await chat();
      assert.equal(r.status, 200);
      assert.equal(r.headers["x-arbr-provider"], "pool-b");
    }
  } finally {
    await new Promise((r) => ups.a.server.listen(port, "127.0.0.1", r));
  }
});

test("draining the routed member moves traffic to the pool; the request log records who served", async (t) => {
  if (maybeSkip(t)) return;
  // The registry routes the model to pool-a; draining it must send everything to pool-b.
  const p = await agent.patch("/api/custom-providers/pool-a").send({ draining: true });
  assert.equal(p.body.draining, true);
  await RequestRecord.deleteMany({ model: MODEL });
  for (let i = 0; i < 4; i++) {
    const r = await chat();
    assert.equal(r.status, 200);
    assert.equal(r.headers["x-arbr-replica-of"], "pool-a");
  }
  assert.equal(ups.a.hits, 0);
  assert.equal(ups.b.hits, 4);
  await new Promise((r) => setTimeout(r, 300)); // the request record is written off the hot path
  const recs = await RequestRecord.find({ model: MODEL }).lean();
  assert.equal(recs.length, 4);
  for (const rec of recs) {
    assert.equal(rec.provider, "pool-b");
    assert.equal(rec.replicaOf, "pool-a");
    assert.equal(rec.replicaAttempts, 1);
    assert.equal(rec.completionTokens, 3, "tokens are metered against the member that served");
  }
});

test("a request already in flight when its member starts draining still completes", async (t) => {
  if (maybeSkip(t)) return;
  ups.a.mode = "slow";
  replicaPool.acquire("pool-b"); // make sure the slow member, a, takes the request
  const inFlight = chat();
  const settled = inFlight.then((r) => r); // supertest sends on then()
  await new Promise((r) => setTimeout(r, 100));
  const p = await agent.patch("/api/custom-providers/pool-a").send({ draining: true });
  assert.equal(p.body.draining, true);
  const r = await settled;
  assert.equal(r.status, 200);
  assert.match(r.body.choices[0].message.content, /from a/);
  replicaPool.release("pool-b");
  const next = await chat();
  assert.equal(next.headers["x-arbr-provider"], "pool-b", "new requests avoid the draining member");
});

test("when every member is draining the gateway answers 503 no_replica_available", async (t) => {
  if (maybeSkip(t)) return;
  await agent.patch("/api/custom-providers/pool-a").send({ draining: true });
  await agent.patch("/api/custom-providers/pool-b").send({ draining: true });
  const r = await chat();
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "no_replica_available");
  assert.equal(ups.a.hits + ups.b.hits, 0);
});

test("a streaming request is retried on another member before any byte reaches the client", async (t) => {
  if (maybeSkip(t)) return;
  ups.a.mode = "503";
  replicaPool.acquire("pool-b"); // b looks busier, so a (failing) is tried first
  const r = await chat({ stream: true }).buffer(true).parse((res, cb) => {
    let d = ""; res.on("data", (c) => { d += c; }); res.on("end", () => cb(null, d));
  });
  assert.equal(r.status, 200);
  assert.match(r.body, /hi from b/);
  assert.doesNotMatch(r.body, /busy/);
  assert.equal(ups.a.hits, 1);
});

test("a client error is relayed, not retried, and does not mark the member unhealthy", async (t) => {
  if (maybeSkip(t)) return;
  ups.a.mode = "400";
  ups.b.mode = "400";
  const r = await chat();
  assert.equal(r.status, 400);
  assert.equal(ups.a.hits + ups.b.hits, 1);
  const health = (await agent.get("/api/replica-pools")).body;
  assert.ok(health.every((h) => h.healthy));
});
