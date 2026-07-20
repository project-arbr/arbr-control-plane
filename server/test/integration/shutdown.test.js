"use strict";
// Graceful shutdown. Unlike the other integration suites this boots the REAL
// server process, because the behaviour under test lives in index.js — which
// buildApp() never mounts. Signals can only be exercised against a real process.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawn } = require("child_process");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");
const RequestRecord = require("../../src/models/RequestRecord");
const logger = require("../../src/logging/logger");

const ENTRY = path.resolve(__dirname, "../../src/index.js");
const PORT = 4397;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mongod;
let uri;

before(async () => {
  mongod = await MongoMemoryServer.create();
  uri = mongod.getUri("arbr-shutdown-test");
});

after(async () => {
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  await mongod.stop();
});

test("SIGTERM drains and exits cleanly", async () => {
  const proc = spawn(process.execPath, [ENTRY], {
    cwd: path.resolve(__dirname, "../../.."),
    env: { ...process.env, MONGO_URI: uri, PORT: String(PORT), ARBR_ADMIN_KEY: "", SEED_ON_BOOT: "false" },
  });

  let out = "";
  proc.stdout.on("data", (d) => { out += d.toString(); });
  proc.stderr.on("data", (d) => { out += d.toString(); });
  const exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));

  try {
    for (let i = 0; i < 80 && !out.includes("ready:"); i++) await sleep(250);
    assert.ok(out.includes("ready:"), `server did not boot:\n${out}`);

    const health = await fetch(`http://localhost:${PORT}/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const started = Date.now();
    proc.kill("SIGTERM");
    const code = await Promise.race([exited, sleep(20_000).then(() => "TIMEOUT")]);
    const elapsed = Date.now() - started;

    assert.equal(code, 0, `expected clean exit, got ${code}:\n${out}`);
    assert.match(out, /\[shutdown\] SIGTERM received/);
    assert.match(out, /\[shutdown\] clean/);
    // The force-exit path means something never released the loop.
    assert.doesNotMatch(out, /forcing exit/);
    // Should be roughly the drain, not the 15s force timer.
    assert.ok(elapsed < 10_000, `shutdown took ${elapsed}ms`);
  } finally {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
});

test("the drain window lets a detached logger.write land", async () => {
  // Reproduces the gateway pattern: the response is already sent and the record
  // is written from a setImmediate. Without the drain in index.js this write
  // races Mongo disconnect and is lost — which is the bug the drain fixes.
  await mongoose.connect(uri);
  const requestId = "shutdown-drain-probe";
  await RequestRecord.deleteMany({ requestId });

  setImmediate(() => logger.write({
    requestId,
    timestamp: new Date(),
    application: "shutdown-test",
    provider: "openai",
    model: "gpt-4o-mini",
    promptTokens: 10,
    completionTokens: 5,
    latencyMs: 42,
    status: "success",
  }));

  await sleep(250); // same window as SHUTDOWN_DRAIN_MS
  await mongoose.disconnect();

  await mongoose.connect(uri);
  const found = await RequestRecord.findOne({ requestId }).lean();
  await mongoose.disconnect();

  assert.ok(found, "detached record should have been persisted within the drain window");
  assert.equal(found.model, "gpt-4o-mini");
});
