// POST /v1/chat/completions — OpenAI-compatible endpoint.
// Accepts the standard OpenAI chat body (model, messages, stream, max_tokens, temperature).
// Routing uses the same precedence logic as /v1/chat; response format is OpenAI-shaped.
// Streaming (stream: true) uses SSE: "data: {...}\n\n" chunks, ending with "data: [DONE]\n\n".
const { v4: uuidv4 } = require("uuid");
const { getRouter } = require("../providers/router");
const { extractFinishReason } = require("../providers/llm-router");
const { resolveRoute, invokeWithFallback, getAppConfig } = require("./handler");
const capEngine = require("../routing/capEngine");
const pricing = require("../pricing/registry");
const logger = require("../logging/logger");
const { PROVIDERS } = require("../config");
const Settings = require("../models/Settings");

// Set standard gateway tracing headers. Called before res.json() / res.flushHeaders()
// so clients always see which model, provider, and routing decision served the request.
function setGatewayHeaders(res, { requestId, model, provider, routing, taskType }) {
  if (requestId) res.setHeader("X-Arbr-Request-ID", requestId);
  if (model)     res.setHeader("X-Arbr-Model",      model);
  if (provider)  res.setHeader("X-Arbr-Provider",   provider);
  if (routing)   res.setHeader("X-Arbr-Routing",    routing);
  if (taskType !== undefined) res.setHeader("X-Arbr-Task-Type", taskType || "");
}

// Providers whose wire protocol IS the OpenAI chat API. For these we transparently proxy the
// raw request/response (preserving tools, tool_calls, vision content, response_format, and
// streaming) instead of round-tripping through LangChain, which drops everything but text.
const OPENAI_COMPAT_PROVIDERS = new Set(["openai", "deepseek", "moonshot", "xai", "groq", "litellm"]);

// Amazon Nova models on Bedrock support tools via ChatBedrockConverse.bindTools().
// Other Bedrock models (Mistral 7B, Mixtral 8x7B, DeepSeek R1) do not — they share the
// bedrock-nova provider but must be gated out to avoid silent failures.
// Keep in sync with BEDROCK_TOOL_PATTERNS in capabilities.js.
const NATIVE_TOOL_PROVIDERS = new Set(["bedrock-nova"]);
const BEDROCK_CONVERSE_TOOL_PATTERNS = [
  /amazon\.nova/i,
  /anthropic\.claude-3/i,
  /moonshotai\.kimi/i,
  /meta\.llama3/i,
  /cohere\.command-r/i,
  /mistral\.mistral-large/i,
  /mistral\.mistral-small/i,
  /ai21\.jamba/i,
  /writer\.palmyra-x5/i,
];
function isNativeToolModel(providerId, modelId) {
  if (!NATIVE_TOOL_PROVIDERS.has(providerId)) return false;
  if (providerId === "bedrock-nova") {
    const id = modelId || "";
    return BEDROCK_CONVERSE_TOOL_PATTERNS.some((re) => re.test(id));
  }
  return true;
}

// Resolved chat-completions base URL for an OpenAI-compatible provider, or null if the provider
// is native (anthropic/gemini/bedrock) and must use the LangChain path.
// `eff` is passed so custom providers (whose baseURL lives in MongoDB) are recognized.
function openAICompatBaseURL(providerId, eff) {
  if (OPENAI_COMPAT_PROVIDERS.has(providerId)) {
    const base = PROVIDERS[providerId]?.baseURL || (providerId === "openai" ? "https://api.openai.com/v1" : null);
    return base ? base.replace(/\/+$/, "") : null;
  }
  // Custom (user-added) providers: eff carries their baseURL; they're never native.
  if (!NATIVE_TOOL_PROVIDERS.has(providerId)) {
    const base = eff?.providers?.[providerId]?.baseURL;
    return base ? base.replace(/\/+$/, "") : null;
  }
  return null;
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

// Convert OpenAI-format messages to LangChain BaseMessages.
// Handles all roles including "tool" (multi-turn tool results) and "assistant"
// with tool_calls (prior assistant turns in a multi-turn tool flow).
// Null/undefined elements are filtered out so a malformed LibreChat history
// never causes "Cannot read properties of undefined (reading 'role')".
function toLcMessages(messages) {
  const { SystemMessage, HumanMessage, AIMessage, ToolMessage } = require("@langchain/core/messages");
  return messages.filter((m) => m != null).map((m) => {
    const role = (m.role || "user").toLowerCase();
    if (role === "system") return new SystemMessage(m.content || "");
    if (role === "tool") {
      return new ToolMessage({
        content: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
        tool_call_id: m.tool_call_id || "",
      });
    }
    if (role === "assistant" || role === "ai") {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
        return new AIMessage({
          content: m.content || "",
          tool_calls: m.tool_calls.map((tc) => ({
            name: tc.function?.name || "",
            args: (() => { try { return JSON.parse(tc.function?.arguments || "{}"); } catch { return {}; } })(),
            id: tc.id || "",
            type: "tool_call",
          })),
        });
      }
      return new AIMessage(m.content || "");
    }
    return new HumanMessage(m.content || "");
  });
}

// Bind OpenAI-format tool definitions to a LangChain model. Passes through tool_choice
// when explicitly set (omits "auto"/"none" since some providers reject those values).
function buildBoundModel(model, body) {
  const tools = body.tools;
  if (!tools?.length) return model;
  const opts = {};
  if (body.tool_choice && body.tool_choice !== "auto" && body.tool_choice !== "none") {
    opts.tool_choice = body.tool_choice;
  }
  return model.bindTools(tools, opts);
}

// Convert LangChain AIMessage.tool_calls to OpenAI tool_calls array format.
function translateToolCalls(toolCalls) {
  if (!toolCalls?.length) return undefined;
  return toolCalls.map((tc, i) => ({
    id: tc.id || `call_${i}`,
    type: "function",
    function: {
      name: tc.name,
      arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args ?? {}),
    },
  }));
}

// Transparent reverse-proxy to an OpenAI-compatible upstream (e.g. LiteLLM). Forwards the raw
// request body (only the model is swapped to the routed one) and relays the response verbatim,
// so tool calls, vision, response_format, and streaming are preserved. Usage/model are parsed
// out for the RequestRecord log without altering the bytes sent to the client.
async function proxyOpenAICompat(ctx) {
  const {
    res, body, served, modelRequested, meta, requestId, timestamp,
    taskType, classifiedBy, difficulty, difficultyScore, confidence, routingDecision, eff, baseURL,
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
        taskType, classifiedBy, difficulty, difficultyScore, confidence, routingDecision, cacheHit: false,
        knownPricing: served.knownPricing,
        messages: body.messages,
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
    logRecord({ latencyMs: Date.now() - start, status: "failure", errorMessage: String(err.message || err) });
    return res.status(502).json({
      error: { message: String(err.message || err), type: "server_error", code: "provider_error" },
    });
  }

  // — Non-streaming: relay the JSON body and status verbatim ————————————————————
  if (!body.stream) {
    const data = await upstream.json().catch(() => null);
    const latencyMs = Date.now() - start;
    if (!upstream.ok || !data) {
      const errMsg = data?.error?.message || `upstream ${upstream.status}`;
      logRecord({ latencyMs, status: "failure", errorMessage: errMsg });
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
      cachedReadTokens: (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) || 0,
      responseText: data.choices?.[0]?.message?.content || null,
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
  let promptTokens = 0, completionTokens = 0, cachedReadTokens = 0, respText = "";
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
            cachedReadTokens = (j.usage.prompt_tokens_details && j.usage.prompt_tokens_details.cached_tokens) || cachedReadTokens;
          }
          const piece = j.choices?.[0]?.delta?.content;
          if (typeof piece === "string") respText += piece;
        } catch { /* partial/non-JSON keepalive line */ }
      }
    }
    res.end();
    logRecord({
      promptTokens, completionTokens, totalTokens: promptTokens + completionTokens,
      cachedReadTokens,
      responseText: respText || null,
      latencyMs: Date.now() - start, status: "success",
    });
  } catch (err) {
    try { res.write(`data: ${JSON.stringify({ error: String(err.message || err) })}\n\n`); } catch { /* client gone */ }
    res.end();
    logRecord({ latencyMs: Date.now() - start, status: "failure", errorMessage: String(err.message || err) });
  }
}

async function handleOpenAICompat(req, res) {
  const body = req.body || {};

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return res.status(400).json({
      error: { message: "messages array is required", type: "invalid_request_error" },
    });
  }

  // Maintenance mode (kill-switch): checked before any routing or provider access.
  const settings = await Settings.get();
  if (settings.maintenanceMode?.enabled) {
    const msg = settings.maintenanceMode.message || "Service temporarily unavailable.";
    const errBody = { error: { message: msg, type: "server_error", code: "maintenance_mode" } };
    if (body.stream) {
      res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.flushHeaders();
      res.write(`data: ${JSON.stringify(errBody)}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    return res.status(503).json(errBody);
  }

  // Max-tokens guardrail: clamp body.max_tokens to the configured ceiling.
  if (settings.maxTokensGuardrail && body.max_tokens > settings.maxTokensGuardrail) {
    body.max_tokens = settings.maxTokensGuardrail;
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

  // Per-application config (kill switch, modelOptOut, generated aiPolicyAssignments). Without this
  // the app's own policy + allowed-models opt-out are ignored and routing falls back to the global
  // policy / default — exactly the /v1/chat path's behavior. (parity with handleChat)
  const appCfg = await getAppConfig(meta.application);
  if (appCfg?.killSwitchEnabled) {
    return res.status(503).json({
      error: {
        message: appCfg.killSwitchMessage || `Application "${meta.application}" is temporarily disabled.`,
        type: "server_error", code: "app_kill_switch",
      },
    });
  }

  const appConfig = {
    allowedModels: req.apiKey?.allowedModels || [],
    defaultModel: req.apiKey?.defaultModel || null,
  };
  let served, routingDecision, taskType, classifiedBy, difficulty, difficultyScore, confidence;
  try {
    ({ served, routingDecision, taskType, classifiedBy, difficulty, difficultyScore, confidence } =
      await resolveRoute(normalized, { router, eff, application: meta.application, workflow: meta.workflow, appConfig, appDbConfig: appCfg }));
  } catch (err) {
    if (err.code === "model_not_allowed") {
      return res.status(403).json({ error: { message: err.message, type: "invalid_request_error", code: "model_not_allowed" } });
    }
    throw err;
  }

  // Budget enforcement — mirrors handleChat. SSE clients (LibreChat) need the error in stream
  // format, otherwise the client spins forever waiting for the first data chunk.
  const enf = await capEngine.enforcement({ application: meta.application, provider: served.provider });
  if (enf) {
    if (enf.action === "block") {
      const msg = `Budget exceeded: ${capEngine.describeScope(enf.cap)} is over its `
        + `${enf.cap.period === "day" ? "daily" : "monthly"} limit ($${enf.cap.limit}).`;
      const errBody = { error: { message: msg, type: "rate_limit_error", code: "budget_exceeded" } };
      if (body.stream) {
        res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.flushHeaders();
        res.write(`data: ${JSON.stringify(errBody)}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return res.status(429).json(errBody);
    }
    const target = pricing.suggestLightTarget(served.model);
    if (target) { served = { provider: target.provider, model: target.model }; routingDecision = "budget"; }
  }

  // Transparent passthrough for OpenAI-compatible providers (e.g. LiteLLM): forward the raw
  // body so tools/tool_calls/vision/response_format/streaming survive intact. Native providers
  // (anthropic/gemini/bedrock) fall through to the LangChain path below.
  const compatBaseURL = openAICompatBaseURL(served.provider, eff);

  // Detect tools / vision before falling through to the LangChain path, which strips both.
  // NATIVE_TOOL_PROVIDERS handle tools via .bindTools() — only block vision for them.
  // All other native providers get a 501 for both tools and vision.
  if (!compatBaseURL) {
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    const hasVision = body.messages.some(
      (m) => Array.isArray(m.content) && m.content.some((c) => c.type === "image_url")
    );
    const toolsUnsupported = hasTools && !isNativeToolModel(served.provider, served.model);
    if (toolsUnsupported || hasVision) {
      const features = [toolsUnsupported && "tools", hasVision && "vision"].filter(Boolean).join(" and ");
      const errBody = {
        error: {
          message:
            `Model "${served.model}" does not support ${features} on /v1/chat/completions. ` +
            `Route to an OpenAI-compatible provider (openai, deepseek, moonshot, xai, groq), or ` +
            `front this provider with a LiteLLM proxy.`,
          type: "not_implemented_error",
          code: "capability_not_supported",
        },
      };
      // Return as SSE when the client expects a stream — otherwise it spins forever.
      if (body.stream) {
        res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        res.flushHeaders();
        res.write(`data: ${JSON.stringify(errBody)}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return res.status(501).json(errBody);
    }
  }

  if (compatBaseURL) {
    setGatewayHeaders(res, { requestId, model: served.model, provider: served.provider,
      routing: routingDecision, taskType });
    return proxyOpenAICompat({
      res, body, served, modelRequested, meta, requestId, timestamp,
      taskType, classifiedBy, difficulty, difficultyScore, confidence, routingDecision, eff, baseURL: compatBaseURL,
    });
  }

  // Native tool invocation: owns both turns of a tool flow for NATIVE_TOOL_PROVIDERS.
  //
  // Turn 1 (body.tools present): bind tools, invoke → SSE tool_call deltas or text.
  // Turn 2 (no body.tools but messages include a "tool" role entry): plain invoke with
  //   proper ToolMessage / AIMessage(tool_calls) via toLcMessages → SSE text response.
  //
  // Both turns use toLcMessages (the one in this file, with ToolMessage support) instead
  // of the generic invokeWithFallback path, which uses the older llm-router converter
  // that strips tool_calls and maps "tool" → HumanMessage — breaking Bedrock Converse.
  const hasTurnTools = Array.isArray(body.tools) && body.tools.length > 0;
  const hasToolHistory = body.messages.some((m) => m?.role === "tool");
  if (isNativeToolModel(served.provider, served.model) && (hasTurnTools || hasToolHistory)) {
    const start = Date.now();
    try {
      const model = router.getModel({
        providerOverride: served.provider,
        modelOverride: served.model,
        temperature: body.temperature,
        maxTokens: body.max_tokens,
      });
      // Turn 1: bind tools. Turn 2 (tool result history, no new tools): plain invoke.
      const boundModel = hasTurnTools ? buildBoundModel(model, body) : model;
      const lcMessages = toLcMessages(body.messages);
      const aiMsg = await boundModel.invoke(lcMessages);
      // Only parse tool_calls on turn 1; turn 2 always produces a text answer.
      const toolCalls = hasTurnTools ? translateToolCalls(aiMsg.tool_calls) : undefined;
      const finishReason = toolCalls?.length ? "tool_calls" : (extractFinishReason(aiMsg) || "stop");
      const um = aiMsg.usage_metadata || {};
      const promptTokens = um.input_tokens || 0;
      const completionTokens = um.output_tokens || 0;
      const totalTokens = um.total_tokens || (promptTokens + completionTokens);
      const _utd = um.input_token_details || {};
      const cachedReadTokens = _utd.cache_read || 0;
      const cacheWriteTokens = _utd.cache_creation || 0;

      if (body.stream) {
        // Emit result as SSE so streaming clients receive the turn in OpenAI chunk format.
        // We branch on whether the model returned tool_calls or plain text — the model can
        // always elect not to use a tool and answer directly, so we must handle both.
        setGatewayHeaders(res, { requestId, model: served.model, provider: served.provider,
          routing: routingDecision, taskType });
        res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
                  Connection: "keep-alive", "X-Accel-Buffering": "no" });
        res.flushHeaders();
        const id = `chatcmpl-${requestId}`;
        const base = { id, object: "chat.completion.chunk", model: served.model };

        if (toolCalls?.length) {
          // Tool-call path: null content + one delta chunk per tool call.
          res.write(`data: ${JSON.stringify({
            ...base, choices: [{ index: 0, delta: { role: "assistant", content: null }, finish_reason: null }],
          })}\n\n`);
          for (let i = 0; i < toolCalls.length; i++) {
            const tc = toolCalls[i];
            res.write(`data: ${JSON.stringify({
              ...base, choices: [{ index: 0, delta: {
                tool_calls: [{ index: i, id: tc.id, type: "function",
                  function: { name: tc.function.name, arguments: tc.function.arguments } }],
              }, finish_reason: null }],
            })}\n\n`);
          }
        } else {
          // Text path: model chose to answer without using a tool. Emit content so the
          // client doesn't assemble null + "" → empty bubble.
          const text = chunkText(aiMsg);
          res.write(`data: ${JSON.stringify({
            ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
          })}\n\n`);
          if (text) {
            res.write(`data: ${JSON.stringify({
              ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
            })}\n\n`);
          }
        }

        // Finish chunk — same shape for both paths.
        res.write(`data: ${JSON.stringify({
          ...base,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
        })}\n\n`);

        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        setGatewayHeaders(res, { requestId, model: served.model, provider: served.provider,
          routing: routingDecision, taskType });
        res.json({
          id: `chatcmpl-${requestId}`,
          object: "chat.completion",
          model: served.model,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: toolCalls?.length ? null : chunkText(aiMsg),
              tool_calls: toolCalls,
            },
            finish_reason: finishReason,
          }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
        });
      }

      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: served.provider, model: served.model, modelRequested,
          taskType, classifiedBy, difficulty, difficultyScore, confidence,
          promptTokens, completionTokens, totalTokens, cachedReadTokens, cacheWriteTokens,
          latencyMs: Date.now() - start, status: "success", routingDecision, cacheHit: false,
          knownPricing: served.knownPricing,
          messages: body.messages, responseText: chunkText(aiMsg) || null,
        })
      );
    } catch (err) {
      const errorMessage = String(err.message || err);
      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: served.provider, model: served.model, modelRequested,
          taskType, classifiedBy, latencyMs: Date.now() - start,
          status: "failure", routingDecision, cacheHit: false, errorMessage,
        })
      );
      if (body.stream) {
        // Send error in SSE format so streaming clients don't hang
        if (!res.headersSent) {
          res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
          res.flushHeaders();
        }
        res.write(`data: ${JSON.stringify({ error: { message: errorMessage, type: "server_error", code: "provider_error" } })}\n\n`);
        res.write("data: [DONE]\n\n");
        return res.end();
      }
      return res.status(502).json({
        error: { message: errorMessage, type: "server_error", code: "provider_error" },
      });
    }
    return;
  }

  if (body.stream) {
    // — SSE streaming for native providers (gemini, anthropic, bedrock-nova) ——————————
    // LangChain's model.stream() for thinking models (Gemini 2.5 Pro/Flash, Claude 3.x)
    // filters out thinking tokens per-chunk, producing only the short final-answer text
    // (~71 chars) while model.invoke() assembles the full response correctly (~1988 chars).
    // We use invoke() here for correctness and emit the full response as a single SSE chunk.
    // OpenAI-compat providers (openai, deepseek, groq, …) use proxyOpenAICompat above,
    // which pipes raw upstream SSE bytes and is unaffected by this path.
    setGatewayHeaders(res, { requestId, model: served.model, provider: served.provider,
      routing: routingDecision, taskType });
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const start = Date.now();
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
      const errorMessage = String(err.message || err);
      res.write(`data: ${JSON.stringify({ error: errorMessage })}\n\n`);
      res.end();
      setImmediate(() =>
        logger.write({
          requestId, timestamp, ...meta,
          provider: served.provider, model: served.model, modelRequested,
          taskType, classifiedBy, latencyMs: Date.now() - start,
          status: "failure", routingDecision, cacheHit: false, errorMessage,
        })
      );
      return;
    }

    const { result, usedFallback } = invocation;
    if (usedFallback) routingDecision = "fallback";

    const promptTokens = result.usage?.inputTokens || 0;
    const completionTokens = result.usage?.outputTokens || 0;
    const totalTokens = result.usage?.totalTokens || (promptTokens + completionTokens);
    const cachedReadTokens = result.usage?.cachedReadTokens || 0;
    const cacheWriteTokens = result.usage?.cacheWriteTokens || 0;

    // Role delta on the first chunk (OpenAI protocol).
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      model: result.modelId,
      choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
    })}\n\n`);

    // Full content as a single chunk — clients render it immediately on receipt.
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      model: result.modelId,
      choices: [{ index: 0, delta: { content: result.text }, finish_reason: null }],
    })}\n\n`);

    // Terminal chunk with usage.
    res.write(`data: ${JSON.stringify({
      id: `chatcmpl-${requestId}`,
      object: "chat.completion.chunk",
      model: result.modelId,
      choices: [{ index: 0, delta: {}, finish_reason: result.finishReason || "stop" }],
      usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: totalTokens },
    })}\n\n`);

    res.write("data: [DONE]\n\n");
    res.end();

    setImmediate(() =>
      logger.write({
        requestId, timestamp, ...meta,
        provider: result.providerId, model: result.modelId, modelRequested,
        taskType, classifiedBy, difficulty, difficultyScore, confidence,
        promptTokens, completionTokens, totalTokens, cachedReadTokens, cacheWriteTokens,
        latencyMs: Date.now() - start, status: "success", routingDecision, cacheHit: false,
        knownPricing: served.knownPricing,
        messages: body.messages, responseText: result.text,
      })
    );
    return;
  }

  // — Non-streaming ——————————————————————————————————————————————————————————————
  setGatewayHeaders(res, { requestId, model: served.model, provider: served.provider,
    routing: routingDecision, taskType });
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
    const errorMessage = String(err.message || err);
    setImmediate(() =>
      logger.write({
        requestId, timestamp, ...meta,
        provider: served.provider, model: served.model, modelRequested,
        taskType, classifiedBy, latencyMs: 0, status: "failure", routingDecision,
        errorMessage,
      })
    );
    return res.status(502).json({
      error: { message: errorMessage, type: "server_error", code: "provider_error" },
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
      finish_reason: result.finishReason || "stop",
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
      taskType, classifiedBy, difficulty, difficultyScore, confidence,
      promptTokens:     result.usage?.inputTokens  || 0,
      completionTokens: result.usage?.outputTokens || 0,
      totalTokens:      result.usage?.totalTokens  || 0,
      cachedReadTokens: result.usage?.cachedReadTokens || 0,
      cacheWriteTokens: result.usage?.cacheWriteTokens || 0,
      latencyMs: result.latencyMs, status: "success", routingDecision, cacheHit: false,
      knownPricing: served.knownPricing,
      messages: body.messages, responseText: result.text,
    })
  );
}

module.exports = { handleOpenAICompat };
