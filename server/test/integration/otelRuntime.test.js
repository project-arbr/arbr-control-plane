"use strict";
// Runtime controls (PR 2): with the exporter env-enabled, a Settings-backed soft
// switch pauses tracing and a Settings sampleRatio retunes it, both without a restart.
// Uses the same in-process OTLP collector as otelExport.test.js.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

let collector, mongod, telemetry, runtime, logger, Settings;
let spans = [];

function reqId(span) {
  const a = (span.attributes || []).find((x) => x.key === "arbr.request_id");
  return a?.value?.stringValue;
}

before(async () => {
  await new Promise((resolve) => {
    collector = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const p = JSON.parse(body);
          for (const rs of p.resourceSpans || [])
            for (const ss of rs.scopeSpans || [])
              for (const s of ss.spans || []) spans.push(s);
        } catch { /* ignore */ }
        res.writeHead(200); res.end("{}");
      });
    });
    collector.listen(0, "127.0.0.1", resolve);
  });

  process.env.ARBR_OTEL_ENABLED = "true";
  process.env.ARBR_OTEL_ENDPOINT = `http://127.0.0.1:${collector.address().port}/v1/traces`;
  process.env.ARBR_OTEL_SAMPLE_RATIO = "1";

  telemetry = require("../../src/telemetry");
  runtime = require("../../src/telemetry/runtime");
  logger = require("../../src/logging/logger");
  Settings = require("../../src/models/Settings");
  telemetry.init();

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("arbr-otel-rt"));
});

after(async () => {
  await telemetry.shutdown();
  await mongoose.disconnect();
  await mongod.stop();
  await new Promise((r) => collector.close(r));
});

beforeEach(() => { spans = []; });

async function setOtel(patch) {
  await Settings.updateOne({ key: "global" }, { $set: patch }, { upsert: true });
  Settings.invalidateCache();
  await runtime.refresh(); // what PATCH /governance triggers
}

async function emitAndFlush(record) {
  await logger.writeOrThrow({ timestamp: new Date(), provider: "openai", model: "gpt-4o-mini", ...record });
  await telemetry.forceFlush();
  await new Promise((r) => setTimeout(r, 150));
}

test("the soft switch pauses and resumes tracing without a restart", async () => {
  await setOtel({ "otel.enabled": false });
  await emitAndFlush({ requestId: "rt-off", status: "success", latencyMs: 10 });
  assert.equal(spans.find((s) => reqId(s) === "rt-off"), undefined, "no span while paused");

  await setOtel({ "otel.enabled": true });
  await emitAndFlush({ requestId: "rt-on", status: "success", latencyMs: 10 });
  assert.ok(spans.find((s) => reqId(s) === "rt-on"), "span emitted after resume");
});

test("a Settings sampleRatio of 0 drops successes but keeps failures", async () => {
  await setOtel({ "otel.enabled": true, "otel.sampleRatio": 0 });

  await emitAndFlush({ requestId: "rt-drop", status: "success", latencyMs: 10 });
  assert.equal(spans.find((s) => reqId(s) === "rt-drop"), undefined, "success dropped at ratio 0");

  await emitAndFlush({ requestId: "rt-keep", status: "failure", errorMessage: "boom", latencyMs: 0 });
  assert.ok(spans.find((s) => reqId(s) === "rt-keep"), "failure kept even at ratio 0");

  await setOtel({ "otel.sampleRatio": null }); // restore
});
