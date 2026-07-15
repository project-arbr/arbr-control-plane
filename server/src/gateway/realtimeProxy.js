// Realtime WebSocket proxy — transparent bidirectional relay for OpenAI Realtime API.
//
// Client connects to wss://arbr-host/v1/realtime?model=gpt-realtime-2.1-mini
// with Authorization: Bearer ab_…  The proxy:
//   1. Resolves the real OpenAI key from connections.effective()
//   2. Opens an upstream WS to OpenAI with the real key
//   3. Relays all frames both ways without modification
//   4. Inspects response.done events to accumulate audio token counts
//   5. Writes a RequestRecord on session close (same observability as chat)

const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const connections = require("../providers/connections");
const logger = require("../logging/logger");

const OPENAI_REALTIME_BASE = "wss://api.openai.com/v1/realtime";

// Models handled by this proxy — all OpenAI realtime variants.
const REALTIME_MODEL_RE = /^(gpt-.*realtime|o\d.*realtime)/i;

function inferProvider(model) {
  if (REALTIME_MODEL_RE.test(model)) return "openai";
  return null;
}

async function handleRealtimeSession(req, clientWs) {
  const requestId = uuidv4();
  const sessionStart = Date.now();
  const url = new URL(req.url, "http://localhost");
  const model = url.searchParams.get("model") || "";

  const provider = inferProvider(model);
  if (!provider) {
    clientWs.close(1008, `Unsupported realtime model "${model}". Supported: gpt-*-realtime-*, o[n]-*-realtime-*.`);
    return;
  }

  // Resolve provider credential.
  let cred;
  try {
    const eff = await connections.effective();
    cred = eff.providers[provider]?.credential;
  } catch (err) {
    clientWs.close(1013, "Gateway error resolving provider credentials.");
    return;
  }

  if (!cred?.apiKey) {
    clientWs.close(1013, `Provider "${provider}" is not connected. Add a credential in Settings → Connections.`);
    return;
  }

  // Open upstream WebSocket to OpenAI.
  const upstreamUrl = `${OPENAI_REALTIME_BASE}?model=${encodeURIComponent(model)}`;
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      "Authorization": `Bearer ${cred.apiKey}`,
      "OpenAI-Beta":   "realtime=v1",
    },
  });

  // Token accumulators — extracted from response.done events.
  let audioInputTokens  = 0;
  let audioOutputTokens = 0;
  let textInputTokens   = 0;
  let textOutputTokens  = 0;
  let sessionStatus     = "success";
  let torn              = false;

  const meta = {
    application: req.apiKey?.application || "unknown",
    workflow:    req.headers["x-arbr-workflow"] || "realtime-voice",
    userId:      req.apiKey?.userId     || req.headers["x-arbr-user-id"] || null,
    department:  req.apiKey?.department || req.headers["x-arbr-department"] || null,
  };

  function teardown(status) {
    if (torn) return;
    torn = true;
    if (status) sessionStatus = status;
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
    if (clientWs.readyState === WebSocket.OPEN) clientWs.close();

    const totalInputTokens  = audioInputTokens  + textInputTokens;
    const totalOutputTokens = audioOutputTokens + textOutputTokens;

    setImmediate(() => logger.write({
      requestId, ...meta,
      provider, model, modelRequested: model,
      taskType: "realtime-voice",
      promptTokens:     totalInputTokens,
      completionTokens: totalOutputTokens,
      totalTokens:      totalInputTokens + totalOutputTokens,
      audioInputTokens,
      audioOutputTokens,
      sessionDurationMs: Date.now() - sessionStart,
      latencyMs:         Date.now() - sessionStart,
      status: sessionStatus,
      routingDecision: "explicit", classifiedBy: "provided", cacheHit: false,
    }));
  }

  // ── Upstream → client relay ────────────────────────────────────────────────
  upstream.on("message", (data, isBinary) => {
    // Inspect text frames for response.done to extract token counts.
    if (!isBinary) {
      try {
        const evt = JSON.parse(data);
        if (evt.type === "response.done" && evt.response?.usage) {
          const u = evt.response.usage;
          audioInputTokens  += u.input_token_details?.audio_tokens  ?? 0;
          textInputTokens   += u.input_token_details?.text_tokens   ?? 0;
          audioOutputTokens += u.output_token_details?.audio_tokens ?? 0;
          textOutputTokens  += u.output_token_details?.text_tokens  ?? 0;
        }
      } catch { /* non-JSON frame — ignore */ }
    }
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  upstream.on("close", (code, reason) => {
    if (!torn && clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(code, reason);
    }
    teardown();
  });

  upstream.on("error", (err) => {
    console.error("[realtimeProxy] upstream error:", err.message);
    teardown("failure");
  });

  // ── Client → upstream relay ────────────────────────────────────────────────
  clientWs.on("message", (data, isBinary) => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
    }
  });

  clientWs.on("close", () => {
    teardown();
  });

  clientWs.on("error", (err) => {
    console.error("[realtimeProxy] client error:", err.message);
    teardown("failure");
  });
}

module.exports = { handleRealtimeSession };
