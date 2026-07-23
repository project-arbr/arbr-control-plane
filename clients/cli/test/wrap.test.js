"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  startProxy, parseAnthropicSSE, parseOpenAISSE, parseNonStreamingUsage,
} = require("../src/wrap");

// --- pure SSE/usage parsing --------------------------------------------------

test("parseAnthropicSSE takes input_tokens from message_start and output_tokens from message_delta", () => {
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-4-8","usage":{"input_tokens":120,"output_tokens":1}}}',
    "",
    'event: content_block_delta',
    'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
    "",
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}',
    "",
    'event: message_stop',
    'data: {"type":"message_stop"}',
    "",
  ].join("\n");
  const usage = parseAnthropicSSE(sse);
  assert.equal(usage.promptTokens, 120);
  assert.equal(usage.completionTokens, 42);
});

test("parseOpenAISSE reads usage only from the final chunk (stream_options.include_usage)", () => {
  const sse = [
    'data: {"id":"1","choices":[{"delta":{"content":"a"}}],"usage":null}',
    "",
    'data: {"id":"1","choices":[{"delta":{"content":"b"}}],"usage":null}',
    "",
    'data: {"id":"1","choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":80,"completion_tokens":12}}',
    "",
    "data: [DONE]",
    "",
  ].join("\n");
  const usage = parseOpenAISSE(sse);
  assert.equal(usage.promptTokens, 80);
  assert.equal(usage.completionTokens, 12);
});

test("parseOpenAISSE returns zeros when the client never requested usage", () => {
  const sse = 'data: {"id":"1","choices":[{"delta":{"content":"a"}}]}\n\ndata: [DONE]\n';
  const usage = parseOpenAISSE(sse);
  assert.equal(usage.promptTokens, 0);
  assert.equal(usage.completionTokens, 0);
});

test("parseNonStreamingUsage reads Anthropic and OpenAI response shapes", () => {
  assert.deepEqual(
    parseNonStreamingUsage("anthropic", { usage: { input_tokens: 10, output_tokens: 5 } }),
    { promptTokens: 10, completionTokens: 5 }
  );
  assert.deepEqual(
    parseNonStreamingUsage("openai", { usage: { prompt_tokens: 20, completion_tokens: 8 } }),
    { promptTokens: 20, completionTokens: 8 }
  );
});

// --- full proxy round trip, against a mocked upstream (never a real API) ----

function fakeSSEResponse(lines) {
  const body = lines.join("\n") + "\n";
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

async function postJson(port, path, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) } },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

test("proxy forwards a streaming Anthropic request and records usage/cost", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async () => fakeSSEResponse([
    'data: {"type":"message_start","message":{"usage":{"input_tokens":100,"output_tokens":1}}}',
    'data: {"type":"message_delta","usage":{"output_tokens":50}}',
  ]);

  const records = [];
  const server = await startProxy({ wire: "anthropic", onRecord: (r) => records.push(r) });
  const port = server.address().port;
  try {
    const res = await postJson(port, "/v1/messages", { model: "claude-opus-4-8", stream: true, messages: [] });
    assert.equal(res.status, 200);
    assert.match(res.body, /message_start/); // bytes passed through untouched
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(records.length, 1);
  assert.equal(records[0].model, "claude-opus-4-8");
  assert.equal(records[0].provider, "anthropic");
  assert.equal(records[0].promptTokens, 100);
  assert.equal(records[0].completionTokens, 50);
  assert.ok(records[0].totalCost > 0);
});

test("proxy forwards a non-streaming OpenAI request and records usage/cost", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async () => new Response(
    JSON.stringify({ id: "x", choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 30, completion_tokens: 6 } }),
    { status: 200, headers: { "content-type": "application/json" } }
  );

  const records = [];
  const server = await startProxy({ wire: "openai", onRecord: (r) => records.push(r) });
  const port = server.address().port;
  try {
    const res = await postJson(port, "/chat/completions", { model: "gpt-4o-mini", stream: false, messages: [] });
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.id, "x"); // untouched passthrough
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(records.length, 1);
  assert.equal(records[0].model, "gpt-4o-mini");
  assert.equal(records[0].provider, "openai");
  assert.equal(records[0].promptTokens, 30);
  assert.equal(records[0].completionTokens, 6);
});

test("proxy binds to 127.0.0.1 only, not 0.0.0.0", async () => {
  const server = await startProxy({ wire: "anthropic", onRecord: () => {} });
  try {
    assert.equal(server.address().address, "127.0.0.1");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
