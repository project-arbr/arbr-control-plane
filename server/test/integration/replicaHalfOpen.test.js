"use strict";
/**
 * Half-open recovery, end to end: when a silently dead member's cooldown ends, only ONE request may try
 * it. Reproduces a real-GPU finding (2026-10-08): requests arriving as a frozen host's cooldown expired
 * each paid the connect timeout. Uses MONGO_URI_TEST or a local mongod; skips without one.
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const mongoose = require("mongoose");

process.env.ARBR_ADMIN_KEY = "";
process.env.ARBR_REPLICA_COOLDOWN_MS = "1500";
process.env.ARBR_REPLICA_CONNECT_TIMEOUT_MS = "600";

let agent, skip = false, replicaPool, server, port;
const MODEL = "half-open-model";

before(async () => {
  try {
    const uri = process.env.MONGO_URI_TEST || "mongodb://127.0.0.1:27017/arbr-half-open-test";
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
    await mongoose.connection.db.dropDatabase();
  } catch (err) {
    skip = true;
    console.warn("[replicaHalfOpen] skipping — no Mongo available:", err.message);
    return;
  }
  server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const supertest = require("supertest");
  const { mountCore } = require("../../src/cloud");
  const ModelEntry = require("../../src/models/ModelEntry");
  const pricing = require("../../src/pricing/registry");
  replicaPool = require("../../src/gateway/replicaPool");
  agent = supertest(mountCore());
  // 10.255.255.1 is unroutable: packets vanish, like a frozen or firewalled host.
  for (const [id, base] of [["ho-good", `http://127.0.0.1:${port}/v1`], ["ho-dead", "http://10.255.255.1:8000/v1"]]) {
    const r = await agent.post("/api/custom-providers").send({ id, label: id, baseURL: base, apiKey: "k", pool: "ho" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  await ModelEntry.create({ id: MODEL, provider: "ho-good", label: MODEL, tier: "mid", inputPer1M: 0, outputPer1M: 0 });
  await pricing.reload();
});

after(async () => {
  if (server) server.close();
  if (mongoose.connection.readyState) {
    await mongoose.connection.db.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
  }
});

test("when a dead member's cooldown ends, only one request pays to test it", async (t) => {
  if (skip) return t.skip("no Mongo");
  replicaPool._reset();
  replicaPool.reportFailure("ho-dead", Date.now() - 2000); // its cooldown ended 500 ms ago
  const timings = await Promise.all(Array.from({ length: 10 }, async () => {
    const t0 = Date.now();
    const r = await agent.post("/v1/chat/completions").send({ model: MODEL, messages: [{ role: "user", content: "hi" }] });
    assert.equal(r.status, 200, "every request is served");
    return Date.now() - t0;
  }));
  const slow = timings.filter((ms) => ms >= 550).length;
  assert.equal(slow, 1, `exactly one request waited for the dead member's connect timeout; timings ${timings}`);
  const dead = (await agent.get("/api/replica-pools")).body.find((m) => m.provider === "ho-dead");
  assert.equal(dead.recovering, false);
  assert.ok(dead.cooldownRemainingMs > 0, "the failed trial put it back in cooldown");
});
