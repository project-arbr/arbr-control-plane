"use strict";
// End-to-end: a real in-process OTLP/HTTP collector (port 0, torn down after),
// the enabled telemetry module, and the actual logger seam. Exercises the whole
// path without booting index.js — logger.writeOrThrow is called directly.
//
// telemetry/config reads env at require-time, so telemetry (and logger, which
// requires it) are required lazily in before(), AFTER the collector port is known
// and the enable flag is set.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const mongoose = require("mongoose");
const { MongoMemoryServer } = require("mongodb-memory-server");

const TRACE = "0af7651916cd43dd8448eb211c80319c";
const PARENT = "b7ad6b7169203331";

let collector, mongod, telemetry, logger, RequestRecord;
const spans = [];

function attrMap(span) {
  return Object.fromEntries((span.attributes || []).map((a) => [
    a.key,
    a.value.stringValue ?? a.value.intValue ?? a.value.doubleValue ?? a.value.boolValue,
  ]));
}

before(async () => {
  await new Promise((resolve) => {
    collector = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        try {
          const payload = JSON.parse(body);
          for (const rs of payload.resourceSpans || [])
            for (const ss of rs.scopeSpans || [])
              for (const s of ss.spans || []) spans.push(s);
        } catch { /* ignore */ }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      });
    });
    collector.listen(0, "127.0.0.1", resolve);
  });

  process.env.ARBR_OTEL_ENABLED = "true";
  process.env.ARBR_OTEL_ENDPOINT = `http://127.0.0.1:${collector.address().port}/v1/traces`;
  process.env.ARBR_OTEL_SAMPLE_RATIO = "1";

  telemetry = require("../../src/telemetry");     // reads the env set just above
  logger = require("../../src/logging/logger");   // requires telemetry (now cached, enabled)
  RequestRecord = require("../../src/models/RequestRecord");
  telemetry.init();

  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri("arbr-otel"));
});

after(async () => {
  await telemetry.shutdown();
  await mongoose.disconnect();
  await mongod.stop();
  await new Promise((r) => collector.close(r));
});

test("telemetry initialised with the collector endpoint", () => {
  assert.equal(telemetry.isEnabled(), true);
});

test("a gateway record writes to Mongo AND emits a span parented to the caller", async () => {
  await logger.writeOrThrow({
    requestId: "otel-req-1",
    timestamp: new Date(),
    application: "checkout",
    provider: "openai",
    model: "gpt-4o-mini",
    modelRequested: "auto",
    taskType: "summarisation",
    promptTokens: 120,
    completionTokens: 30,
    latencyMs: 210,
    status: "success",
    routingDecision: "ai",
    // W3C trace context off the (simulated) incoming request — the headline feature.
    _traceparent: `00-${TRACE}-${PARENT}-01`,
  });

  // The record persisted, and the transport-only field was NOT stored.
  const doc = await RequestRecord.findOne({ requestId: "otel-req-1" }).lean();
  assert.ok(doc, "RequestRecord was written");
  assert.equal(doc._traceparent, undefined, "the trace context is not stored on the record");

  await telemetry.forceFlush();
  await new Promise((r) => setTimeout(r, 200));

  const span = spans.find((s) => attrMap(s)["arbr.request_id"] === "otel-req-1");
  assert.ok(span, "a span was exported to the collector");
  assert.equal(span.traceId, TRACE, "span nests in the caller's trace");
  assert.equal(span.parentSpanId ?? span.parentSpanID, PARENT, "parented to the caller's span");
  assert.equal(span.kind, 3, "CLIENT span");
  assert.equal(span.name, "chat gpt-4o-mini", "named with the served model");
  const a = attrMap(span);
  assert.equal(a["gen_ai.request.model"], "auto");
  assert.equal(a["gen_ai.response.model"], "gpt-4o-mini");
  assert.equal(a["gen_ai.system"], "openai");
  assert.equal(a["arbr.routing.decision"], "ai");
});

test("a record with no traceparent still exports, as a root span", async () => {
  await logger.writeOrThrow({
    requestId: "otel-req-2", timestamp: new Date(), application: "support",
    provider: "anthropic", model: "claude-haiku-4-5", modelRequested: "claude-haiku-4-5",
    promptTokens: 10, completionTokens: 5, latencyMs: 90, status: "success",
  });
  await telemetry.forceFlush();
  await new Promise((r) => setTimeout(r, 200));

  const span = spans.find((s) => attrMap(s)["arbr.request_id"] === "otel-req-2");
  assert.ok(span, "root span exported");
  assert.ok(!span.parentSpanId || span.parentSpanId === "" || span.parentSpanId === "0000000000000000",
    "no parent (root span)");
});

test("a failed record exports an ERROR span with error.type", async () => {
  await logger.writeOrThrow({
    requestId: "otel-req-3", timestamp: new Date(), application: "checkout",
    provider: "openai", model: "gpt-4o", modelRequested: "gpt-4o",
    status: "failure", errorMessage: "upstream 502 from provider", latencyMs: 0,
  });
  await telemetry.forceFlush();
  await new Promise((r) => setTimeout(r, 200));

  const span = spans.find((s) => attrMap(s)["arbr.request_id"] === "otel-req-3");
  assert.ok(span, "failure span exported");
  assert.equal(span.status.code, 2, "OTel status ERROR");
  assert.equal(attrMap(span)["error.type"], "provider_error");
});
