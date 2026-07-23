"use strict";

const http = require("http");
const pricing = require("./vendor/pricingTable");
const { aggregateGroups } = require("./audit");
const { launchClaude, launchOpenCode, launchCodex, printCursorInstructions } = require("./wrapAgents");

const WIRE_BY_AGENT = { claude: "anthropic", codex: "openai", opencode: "openai", cursor: "openai" };
const AUTOMATED_AGENTS = new Set(["claude", "codex", "opencode"]);

// Fixed real upstreams. v1 only proxies each provider's single chat/completion
// endpoint (Anthropic's /v1/messages, OpenAI's /v1/chat/completions) — a wrapped
// agent calling any other endpoint (e.g. a models-list call) gets forwarded to the
// same fixed path, which is a known v1 limitation, not a bug: coding-agent traffic
// is overwhelmingly one repeated call shape, and getting that one shape right well
// is more useful than a half-generic router.
const UPSTREAMS = {
  anthropic: "https://api.anthropic.com/v1/messages",
  openai: "https://api.openai.com/v1/chat/completions",
};

// Anthropic SSE: usage arrives split across two events — message_start carries
// input_tokens (and a starting output_tokens, usually 0), message_delta carries the
// final output_tokens once generation stops. Take the max seen for each field so
// either a delta or a cumulative-count SSE implementation is handled the same way.
function parseAnthropicSSE(text) {
  let promptTokens = 0, completionTokens = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }
    const usage = evt?.message?.usage || evt?.usage;
    if (!usage) continue;
    if (typeof usage.input_tokens === "number") promptTokens = Math.max(promptTokens, usage.input_tokens);
    if (typeof usage.output_tokens === "number") completionTokens = Math.max(completionTokens, usage.output_tokens);
  }
  return { promptTokens, completionTokens };
}

// OpenAI SSE only carries a `usage` object in the final chunk, and only when the
// caller's request included `stream_options: {include_usage: true}`. If the client
// didn't ask for it, usage stays 0 for that call — cost then reports as $0 for it,
// same "unknown" convention Arbr's own server uses for unpriced calls.
function parseOpenAISSE(text) {
  let promptTokens = 0, completionTokens = 0;
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }
    if (evt.usage) {
      promptTokens = evt.usage.prompt_tokens || promptTokens;
      completionTokens = evt.usage.completion_tokens || completionTokens;
    }
  }
  return { promptTokens, completionTokens };
}

function parseNonStreamingUsage(wire, json) {
  const usage = json.usage || {};
  if (wire === "anthropic") {
    return { promptTokens: usage.input_tokens || 0, completionTokens: usage.output_tokens || 0 };
  }
  return { promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0 };
}

// Forward one request to the real provider, streaming the response straight back to
// the client untouched (same technique as server/src/gateway/openaiCompat.js's
// proxyOpenAICompat: read the upstream body with a reader, write each chunk to the
// client immediately, and separately accumulate the text to parse usage from after
// the fact — the bytes the client sees are never altered).
async function forwardRequest({ wire, requestHeaders, requestBody, res, onRecord }) {
  let parsedBody = {};
  try { parsedBody = JSON.parse(requestBody || "{}"); } catch { /* leave empty */ }
  const model = parsedBody.model || "unknown";
  const isStreaming = parsedBody.stream === true;
  const upstreamUrl = UPSTREAMS[wire];

  const headers = { "content-type": "application/json" };
  if (wire === "anthropic") {
    if (requestHeaders["x-api-key"]) headers["x-api-key"] = requestHeaders["x-api-key"];
    if (requestHeaders["anthropic-version"]) headers["anthropic-version"] = requestHeaders["anthropic-version"];
    if (requestHeaders["authorization"]) headers["authorization"] = requestHeaders["authorization"];
  } else {
    if (requestHeaders["authorization"]) headers["authorization"] = requestHeaders["authorization"];
  }

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, { method: "POST", headers, body: requestBody });
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `arbr wrap: upstream fetch failed: ${err.message}` } }));
    return;
  }

  res.writeHead(upstreamRes.status, {
    "content-type": upstreamRes.headers.get("content-type") || "application/json",
  });

  if (!upstreamRes.body) {
    res.end();
    return;
  }

  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  let fullText = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    res.write(Buffer.from(value));
    fullText += decoder.decode(value, { stream: true });
  }
  res.end();

  let promptTokens = 0, completionTokens = 0;
  try {
    if (isStreaming) {
      const parsed = wire === "anthropic" ? parseAnthropicSSE(fullText) : parseOpenAISSE(fullText);
      promptTokens = parsed.promptTokens; completionTokens = parsed.completionTokens;
    } else {
      const parsed = parseNonStreamingUsage(wire, JSON.parse(fullText));
      promptTokens = parsed.promptTokens; completionTokens = parsed.completionTokens;
    }
  } catch { /* leave usage at 0 rather than crash the proxy over a parse issue */ }

  const { totalCost } = pricing.costFor(model, promptTokens, completionTokens);
  onRecord({ model, provider: wire, promptTokens, completionTokens, totalCost });
}

// Starts the local proxy. Binds to 127.0.0.1 ONLY — this must never be reachable
// from the network, since it forwards real provider credentials.
function startProxy({ wire, onRecord }) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      forwardRequest({ wire, requestHeaders: req.headers, requestBody: body, res, onRecord }).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `arbr wrap: ${err.message}` } }));
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

// Full session: start the proxy, launch the agent (or print manual instructions for
// cursor), wait for it to finish, then build the same result shape `runAudit`
// returns — `recommendations` stays empty (v1 never runs task classification on live
// traffic; see report.js's `mode: "wrap"` copy, which explains this instead of
// implying overuse detection ran).
async function runWrapSession(agentName, opts = {}) {
  if (!WIRE_BY_AGENT[agentName]) {
    throw new Error(`Unknown agent: ${agentName} (supported: claude, codex, opencode, cursor)`);
  }

  const records = [];
  const server = await startProxy({ wire: WIRE_BY_AGENT[agentName], onRecord: (r) => records.push(r) });
  const port = server.address().port;
  console.log(`arbr wrap: local proxy listening on 127.0.0.1:${port} (${agentName})`);

  try {
    if (agentName === "cursor") {
      printCursorInstructions(port);
      await new Promise((resolve) => {
        process.once("SIGINT", () => { console.log("\narbr wrap: stopping."); resolve(); });
      });
    } else {
      const child = agentName === "claude" ? launchClaude(port)
        : agentName === "codex" ? launchCodex(port, opts)
        : launchOpenCode(port);
      await new Promise((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", () => resolve());
      });
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  const { groups, totalRequests, totalCost } = aggregateGroups(records);
  return {
    totalRequests, totalCost, groups,
    recommendations: [], flaggedCost: 0, flaggedSavings: 0, overusePct: 0,
  };
}

module.exports = {
  startProxy, parseAnthropicSSE, parseOpenAISSE, parseNonStreamingUsage, UPSTREAMS,
  runWrapSession, AUTOMATED_AGENTS,
};
