// Unit tests — run a throwaway in-process mock gateway per test. No network,
// no live providers, no external deps. `npm test` (node --test).
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { createClient, asLangChainModel, GatewayError } = require("../src/index.js");

const OK_RESPONSE = {
  requestId: "req-1",
  model: "gpt-4o-mini",
  modelRequested: "auto",
  provider: "openai",
  routingDecision: "passthrough",
  classifiedBy: "keyword",
  cacheHit: false,
  text: "hello from the gateway",
  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
};

// Start a mock gateway. handler(req, bodyJson) -> { status, body } | object (200).
function mockGateway(t, handler) {
  const seen = []; // { method, url, body }
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      seen.push({ method: req.method, url: req.url, body, auth: req.headers.authorization || null });
      const out = handler ? handler(req, body, seen.length) : null;
      const status = out?.status ?? 200;
      const payload = out?.body ?? out ?? OK_RESPONSE;
      if (out?.delayMs) {
        setTimeout(() => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(JSON.stringify(payload));
        }, out.delayMs);
        return;
      }
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      t.after(() => new Promise((r) => server.close(r)));
      resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, seen });
    });
  });
}

test("chat: returns the gateway response and sends merged metadata", async (t) => {
  const { baseUrl, seen } = await mockGateway(t);
  const client = createClient({ baseUrl, application: "unit-app", department: "eng" });
  const res = await client.chat({ messages: [{ role: "user", content: "hi" }], taskType: "faq" });

  assert.equal(res.text, "hello from the gateway");
  assert.equal(res.routingDecision, "passthrough");
  assert.equal(res.classifiedBy, "keyword");

  const sent = seen[0];
  assert.equal(sent.url, "/v1/chat");
  assert.equal(sent.body.application, "unit-app");
  assert.equal(sent.body.department, "eng");
  assert.equal(sent.body.taskType, "faq");
  assert.deepEqual(sent.body.messages, [{ role: "user", content: "hi" }]);
});

test("chat: normalizes a bare string, LangChain messages, and content parts", async (t) => {
  const { baseUrl, seen } = await mockGateway(t);
  const client = createClient({ baseUrl });

  await client.chat({ messages: "just a string" });
  assert.deepEqual(seen[0].body.messages, [{ role: "user", content: "just a string" }]);

  const lcSystem = { _getType: () => "system", content: "be brief" };
  const lcAi = { _getType: () => "ai", content: [{ text: "prev " }, "answer"] };
  await client.chat({ messages: [lcSystem, lcAi, { role: "user", content: "next?" }] });
  assert.deepEqual(seen[1].body.messages, [
    { role: "system", content: "be brief" },
    { role: "assistant", content: "prev answer" },
    { role: "user", content: "next?" },
  ]);
});

test("chat: per-call metadata overrides constructor defaults", async (t) => {
  const { baseUrl, seen } = await mockGateway(t);
  const client = createClient({ baseUrl, application: "default-app", workflow: "default-wf" });
  await client.chat({ messages: "x", application: "override-app" });
  assert.equal(seen[0].body.application, "override-app");
  assert.equal(seen[0].body.workflow, "default-wf");
});

test("chat: retries a 500 then succeeds", async (t) => {
  const { baseUrl, seen } = await mockGateway(t, (req, body, n) =>
    n === 1 ? { status: 500, body: { error: "boom" } } : null
  );
  const client = createClient({ baseUrl, retries: 2 });
  const res = await client.chat({ messages: "x" });
  assert.equal(res.text, OK_RESPONSE.text);
  assert.equal(seen.length, 2);
});

test("chat: retries a 429 then succeeds", async (t) => {
  const { baseUrl, seen } = await mockGateway(t, (req, body, n) =>
    n === 1 ? { status: 429, body: { error: "rate_limited" } } : null
  );
  const client = createClient({ baseUrl, retries: 1 });
  const res = await client.chat({ messages: "x" });
  assert.equal(res.requestId, "req-1");
  assert.equal(seen.length, 2);
});

test("chat: does NOT retry a 400 — bad_request", async (t) => {
  const { baseUrl, seen } = await mockGateway(t, () => ({
    status: 400, body: { error: "messages array is required" },
  }));
  const client = createClient({ baseUrl, retries: 3 });
  await assert.rejects(
    () => client.chat({ messages: "x" }),
    (err) => err instanceof GatewayError && err.code === "bad_request" && err.status === 400 && !err.retryable
  );
  assert.equal(seen.length, 1);
});

test("chat: 503 demo_mode maps to code demo_mode", async (t) => {
  const { baseUrl } = await mockGateway(t, () => ({
    status: 503, body: { error: "demo_mode", message: "No provider keys configured" },
  }));
  const client = createClient({ baseUrl, retries: 0 });
  await assert.rejects(
    () => client.chat({ messages: "x" }),
    (err) => err instanceof GatewayError && err.code === "demo_mode" && err.status === 503
  );
});

test("chat: 502 provider_error maps to code provider_error", async (t) => {
  const { baseUrl } = await mockGateway(t, () => ({
    status: 502, body: { error: "provider_error", message: "all providers failed" },
  }));
  const client = createClient({ baseUrl, retries: 0 });
  await assert.rejects(
    () => client.chat({ messages: "x" }),
    (err) => err instanceof GatewayError && err.code === "provider_error"
  );
});

test("chat: per-attempt timeout → GatewayError code timeout", async (t) => {
  const { baseUrl } = await mockGateway(t, () => ({ delayMs: 500, body: OK_RESPONSE }));
  const client = createClient({ baseUrl, retries: 0, timeoutMs: 60 });
  await assert.rejects(
    () => client.chat({ messages: "x" }),
    (err) => err instanceof GatewayError && err.code === "timeout" && err.retryable
  );
});

test("chat: unreachable host → GatewayError code network", async (t) => {
  const client = createClient({ baseUrl: "http://127.0.0.1:9", retries: 0, timeoutMs: 2000 });
  await assert.rejects(
    () => client.chat({ messages: "x" }),
    (err) => err instanceof GatewayError && err.code === "network" && err.retryable
  );
});

test("chat: caller AbortSignal → code aborted, not retried", async (t) => {
  const { baseUrl, seen } = await mockGateway(t, () => ({ delayMs: 300, body: OK_RESPONSE }));
  const client = createClient({ baseUrl, retries: 3 });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30);
  await assert.rejects(
    () => client.chat({ messages: "x", signal: ctrl.signal }),
    (err) => err instanceof GatewayError && err.code === "aborted" && !err.retryable
  );
  assert.equal(seen.length, 1);
});

test("chat: validates input before any network call", async () => {
  const client = createClient({ baseUrl: "http://127.0.0.1:9" });
  await assert.rejects(() => client.chat({}), (e) => e.code === "invalid_input");
  await assert.rejects(() => client.chat({ messages: [] }), (e) => e.code === "invalid_input");
  assert.throws(() => createClient({ baseUrl: "" }), (e) => e.code === "invalid_input");
});

test("stream: yields chunks that concatenate to the full text; returns the response", async (t) => {
  const { baseUrl } = await mockGateway(t);
  const client = createClient({ baseUrl });
  const it = client.stream({ messages: "x" });
  let text = "";
  let final;
  for (;;) {
    const { value, done } = await it.next();
    if (done) { final = value; break; }
    text += value.text;
  }
  assert.equal(text, OK_RESPONSE.text);
  assert.equal(final.requestId, "req-1");
});

test("chat: apiKey option sends Authorization header (and none when absent)", async (t) => {
  const { baseUrl, seen } = await mockGateway(t);
  const withKey = createClient({ baseUrl, apiKey: "ka_testkey123" });
  await withKey.chat({ messages: "x" });
  assert.equal(seen[0].auth, "Bearer ka_testkey123");

  const withoutKey = createClient({ baseUrl });
  await withoutKey.chat({ messages: "x" });
  assert.equal(seen[1].auth, null);
});

test("chat: 401 invalid_api_key — typed, not retried", async (t) => {
  const { baseUrl, seen } = await mockGateway(t, () => ({
    status: 401, body: { error: "invalid_api_key", message: "Unknown key" },
  }));
  const client = createClient({ baseUrl, apiKey: "ka_bad", retries: 3 });
  await assert.rejects(
    () => client.chat({ messages: "x" }),
    (err) => err instanceof GatewayError && err.code === "invalid_api_key" && err.status === 401 && !err.retryable
  );
  assert.equal(seen.length, 1);
});

test("chat: 429 budget_exceeded — typed, NOT retried (unlike rate limits)", async (t) => {
  const { baseUrl, seen } = await mockGateway(t, () => ({
    status: 429, body: { error: "budget_exceeded", message: "over budget" },
  }));
  const client = createClient({ baseUrl, retries: 3 });
  await assert.rejects(
    () => client.chat({ messages: "x" }),
    (err) => err instanceof GatewayError && err.code === "budget_exceeded" && !err.retryable
  );
  assert.equal(seen.length, 1);
});

test("status: GETs /api/status", async (t) => {
  const { baseUrl, seen } = await mockGateway(t, (req) =>
    req.url === "/api/status"
      ? { body: { demoMode: false, liveProviders: ["openai"], routingMode: "ai", defaultProvider: "openai", defaultModel: "gpt-4o-mini", breachedCaps: 0 } }
      : { status: 404, body: {} }
  );
  const client = createClient({ baseUrl });
  const s = await client.status();
  assert.equal(s.routingMode, "ai");
  assert.equal(seen[0].method, "GET");
});

test("asLangChainModel: invoke returns an AIMessage-shaped result; stream yields .content", async (t) => {
  const { baseUrl, seen } = await mockGateway(t);
  const client = createClient({ baseUrl, application: "lc-app" });
  const model = asLangChainModel(client, { workflow: "answer-drafting", taskType: "support response" });

  const msg = await model.invoke([{ _getType: () => "human", content: "help" }]);
  assert.equal(msg.content, OK_RESPONSE.text);
  assert.deepEqual(msg.usage_metadata, { input_tokens: 10, output_tokens: 5, total_tokens: 15 });
  assert.equal(msg.response_metadata.gateway, true);
  assert.equal(msg._getType(), "ai");
  assert.equal(seen[0].body.workflow, "answer-drafting");
  assert.equal(seen[0].body.application, "lc-app");

  let streamed = "";
  for await (const chunk of model.stream("again")) streamed += chunk.content;
  assert.equal(streamed, OK_RESPONSE.text);
});
