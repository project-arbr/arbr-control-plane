// POST /v1/chat/completions — OpenAI-compatible endpoint.
// Accepts the standard OpenAI chat body (model, messages, stream, max_tokens, temperature).
// Routing uses the same precedence logic as /v1/chat; response format is OpenAI-shaped.
// Streaming (stream: true) uses SSE: "data: {...}\n\n" chunks, ending with "data: [DONE]\n\n".
const { v4: uuidv4 } = require("uuid");
const { getRouter } = require("../providers/router");
const { resolveRoute, invokeWithFallback } = require("./handler");
const capEngine = require("../routing/capEngine");
const pricing = require("../pricing/registry");
const logger = require("../logging/logger");
const { PROVIDERS } = require("../config");

// Providers whose wire protocol IS the OpenAI chat API. For these we transparently proxy the
// raw request/response (preserving tools, tool_calls, vision content, response_format, and
// streaming) instead of round-tripping through LangChain, which drops everything but text.
const OPENAI_COMPAT_PROVIDERS = new Set(["openai", "deepseek", "moonshot", "xai", "groq"]);

// Resolved chat-completions base URL for an OpenAI-compatible provider, or null if the provider
// is native (anthropic/gemini/bedrock) and must use the LangChain path.
function openAICompatBaseURL(providerId) {
  if (!OPENAI_COMPAT_PROVIDERS.has(providerId)) return null;
  const base = PROVIDERS[providerId]?.baseURL || (providerId === "openai" ? "https://api.openai.com/v1" : null);
  return base ? base.replace(/\/+$/, "") : null;
}

const DEMO_503 = {
  error: {
    message:
      "No provider keys configured — add a key in the dashboard (Settings → Connections).",
    type: "server_error",
    code: "demo_mode",
  },
};

// LangChain chunk content → string (handles string, array, or empty).
function chunkText(chunk) {
  if (!chunk || chunk.content == null) return "";
  if (typeof chunk.content === "string") return chunk.content;
  if (Array.isArray(chunk.content)) {
    return chunk.content
      .map((c) => (typeof c === "string" ? c : (c && c.text) ? c.text : ""))
      .join("");
  }
  return "";
}

// Convert { role, content } messages to LangChain BaseMessages.
function toLcMessages(messages) {
  const { SystemMessage, HumanMessage, AIMessage } = require("@langchain/core/messages");
  return messages.map((m) => {
    const role = (m.role || "user").toLowerCase();
    if (role === "system") return new SystemMessage(m.content || "");
    if (role === "assistant" || role === "ai") return new AIMessage(m.content || "");
    return new HumanMessage(m.content || "");
  });
}

// Transparent reverse-proxy to an OpenAI-compatible upstream (e.g. LiteLLM). Forwards the raw
// request body (only the model is swapped to the routed one) and relays the response verbatim,
// so tool calls, vision, response_format, and streaming are preserved. Usage/model are parsed
// out for the RequestRecord log without altering the bytes sent to the client.
async function proxyOpenAICompat(ctx) {
  const {
    res, body, served, modelRequested, meta, requestId, timestamp,
    taskType, classifiedBy, routingDecision, eff, baseURL,
  } = ctx;

  const apiKey = eff.providers[served.provider]?.credential?.apiKey || "none";
  const url = `${baseURL}/chat/completions`;
  const upstreamBody = { ...body, model: served.model };
  const start = Date.now();

  const logRecord = (extra) =>
    setImmediate(() =>
      logger.write({
        requestId, timestamp, ...meta,
        provider: served.provider, model: served.model, modelRequested,
        taskType, classifiedBy, routingDecision, cacheHit: false,
        knownPricing: served.knownPricing,
        ...extra,
      })
    );

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(upstreamBody),
    });
  } catch (err) {
    logRecord({ latencyMs: Date.now() - start, status: "failure" });
    return res.status(502).json({
      error: { message: String(err.message || err), type: "server_error", code: "provider_error" },
    });
  }

  // — Non-streaming: relay the JSON body and status verbatim ————————————————————
  if (!body.stream) {
    const data = await upstream.json().catch(() => null);
    const latencyMs = Date.now() - start;
    if (!upstream.ok || !data) {
      logRecord({ latencyMs, status: "failure" });
      return res
        .status(upstream.status || 502)
        .json(data || { error: { message: "Upstream error", type: "server_error" } });
    }
    res.status(upstream.status).json(data);
    const u = data.usage || {};
    logRecord({
      promptTokens: u.prompt_tokens || 0,
      completionTokens: u.completion_tokens || 0,
      totalTokens: u.total_tokens || (u.prompt_tokens || 0) + (u.completion_tokens || 0),
      latencyMs, status: "success",
    });
    return;
  }

  // — Streaming: pipe the upstream SSE through unchanged, parsing usage as it passes ——
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders(); // send headers immediately so the client/proxy knows it's SSE
  let promptTokens = 0, completionTokens = 0;
  try {
    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text().catch(() => "");
      throw new Error(`upstream ${upstream.status}${errText ? `: ${errText.slice(0, 200)}` : ""}`);
    }
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(Buffer.from(value)); // relay exact bytes
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const j = JSON.parse(payload);
          if (j.usage) {
            promptTokens = j.usage.prompt_tokens || promptTokens;
            completionTokens = j.usage.completion_tokens || completionTokens;
          }
        } catch { /* partial/non-JSON keepalive line */ }
      }
    }
    res.end();
    logRecord({
      promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
      latencyMs: Date.now() - start, status: "success",
    });
  } catch (err) {
    try { res.write(`data: ${JSON.stringify({ error: String(err.message || err) })}\n\n`); } catch { /* client gone */ }
    res.end();
    logRecord({ latencyMs: Date.now() - start, status: "failure" });
  }
}

async function handleOpenAICompat(req, res) {
  const body = req.body || {};

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({
      error: { message: "messages array is required", type: "invalid_request_error" },
    });
  }

  const { router, eff } = await getRouter();
  if (!router) return res.status(503).json(DEMO_503);

  const requestId = uuidv4();
  const timestamp = new Date();
  const meta = {
    application: req.apiKey?.application || "openai-compat",
    workflow: "completion",
    userId: req.apiKey?.userId || null,
    department: "openai-compat",
  };

  // Normalize max_tokens → maxTokens for the routing layer.
  const normalized = { ...body, maxTokens: body.max_tokens };
  const modelRequested = (body.model || "auto").trim();

  const appConfig = {
    allowedModels: req.apiKey?.allowedModels || [],
    defaultModel: req.apiKey?.defaultModel || null,
  };
  let served, routingDecision, taskType, classifiedBy;
  try {
    ({ served, routingDecision, taskType, classifiedBy } =
      await resolveRoute(normalized, { router, eff, application: meta.application, workflow: meta.workflow, appConfig }));
  } catch (err) {
    if (err.code === "model_not_allowed") {
      return res.status(403).json({ error: { message: err.message, type: "invalid_request_error", code: "model_not_allowed" } });
    }
    throw err;
  }

  // Budget enforcement.
  const enf = await capEngine.enforcement({ application: meta.application, provider: served.provider });
  if (enf) {
    if (enf.action === "block") {
      return res.status(429).json({
        error: { message: "Budget cap exceeded — request blocked.", type: "rate_limit_error", code: "budget_exceeded" },
      });
    }
    const target = pricing.suggestLightTarget(served.model);
    if (target) { served = { provider: target.provider, model: target.model }; routingDecision = "budget"; }
  }

  // Transparent passthrough for OpenAI-compatible providers (e.g. LiteLLM): forward the raw
  // body so tools/tool_calls/vision/response_format/streaming survive intact. Native providers
  // (anthropic/gemini/bedrock) fall through to the LangChain path below.
  const compatBaseURL = openAICompatBaseURL(served.provider);

  // Detect tools / vision before falling through to the LangChain path, which strips both.
  // Surface a clear 501 instead of silently degrading the response.
  if (!compatBaseURL) {
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const hasVision = body.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url")
    );
    if (hasTools || hasVision) {
      const features = [hasTools && "tools", hasVision && "vision"].filter(Boolean).join(" and ");
      return res.status(501).json({
        error: {
          message:
            `Provider "${served.provider}" does not support ${features} on /v1/chat/completions. ` +
            `Route to an OpenAI-compatible provider (openai, deepseek, moonshot, xai, groq), or ` +
            `front Bedrock/Gemini with a LiteLLM proxy and configure it as the "openai" provider.`,
          type: "not_implemented_error",
          code: "capability_not_supported",
        },
      });
    }
  }

  if (compatBaseURL) {
    return proxyOpenAICompat({
      res, body, served, modelRequested, meta, requestId, timestamp,
      taskType, classifiedBy, routingDecision, eff, baseURL: compatBaseURL,
    });
  }

  if (body.stream) {
    // — SSE streaming ——————————————————————————————————————————————————————————
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders(); // send headers immediately so the client/proxy knows it's SSE

    let promptTokens = 0, completionTokens = 0;
    const start = Date.now();
    try {
      const model = router.getModel({
        providerOverride: served.provider,
        modelOverride: served.model,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
      });
      const lcMessages = toLcMessages(body.messages);

      for await (const chunk of await model.stream(lcMessages)) {
        const delta = chunkText(chunk);
        if (delta) {
          completionTokens += delta.split(/\s+/).length; // rough count
          res.write(
            `data: ${JSON.stringify({
              id: `chatcmpl-${requestId}`,
              object: "chat.completion.chunk",
              model: served.model,
              choices: [{ index: 0, delta: { content: delta }, finish_reason: null }],
            })}\n\n`
          );
        }
        // Capture usage from the final chunk if the provider emits it.
        if (chunk.usage_metadata) {
          promptTokens = chunk.usage_metadata.input_tokens || promptTokens;
          completionTokens = chunk.usage_metadata.output_tokens || completionTokens;
        }
      }

      res.write(`data: ${JSON.stringify({
        id: `chatcmpl-${requestId}`,
        object: "chat.completion.chunk",
        model: served.model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();

      const latencyMs = Date.now() - start;
      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: served.provider, model: served.model, modelRequested,
          taskType, classifiedBy,
          promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
          latencyMs, status: "success", routingDecision, cacheHit: false,
          knownPricing: served.knownPricing,
        })
      );
    } catch (err) {
      res.write(`data: ${JSON.stringify({ error: String(err.message || err) })}\n\n`);
      res.end();
      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: served.provider, model: served.model, modelRequested,
          taskType, classifiedBy, latencyMs: Date.now() - start,
          status: "failure", routingDecision, cacheHit: false,
        })
      );
    }
    return;
  }

  // — Non-streaming ——————————————————————————————————————————————————————————————
  let invocation;
  try {
    invocation = await invokeWithFallback(router, eff, {
      provider: served.provider,
      model: served.model,
      messages: body.messages,
      temperature: body.temperature,
      maxTokens: body.max_tokens,
    });
  } catch (err) {
    setImmediate(() =>
      logger.write({
        requestId, timestamp, ...meta,
        provider: served.provider, model: served.model, modelRequested,
        taskType, classifiedBy, latencyMs: 0, status: "failure", routingDecision,
      })
    );
    return res.status(502).json({
      error: { message: String(err.message || err), type: "server_error", code: "provider_error" },
    });
  }

  const { result, usedFallback } = invocation;
  if (usedFallback) routingDecision = "fallback";

  res.json({
    id: `chatcmpl-${requestId}`,
    object: "chat.completion",
    model: result.modelId,
    choices: [{
      index: 0,
      message: { role: "assistant", content: result.text },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens:     result.usage?.inputTokens  || 0,
      completion_tokens: result.usage?.outputTokens || 0,
      total_tokens:      result.usage?.totalTokens  || 0,
    },
  });

  setImmediate(() =>
    logger.write({
      requestId, timestamp, ...meta,
      provider: result.providerId, model: result.modelId, modelRequested,
      taskType, classifiedBy,
      promptTokens:     result.usage?.inputTokens  || 0,
      completionTokens: result.usage?.outputTokens || 0,
      totalTokens:      result.usage?.totalTokens  || 0,
      latencyMs: result.latencyMs, status: "success", routingDecision, cacheHit: false,
      knownPricing: served.knownPricing,
    })
  );
}

module.exports = { handleOpenAICompat };
