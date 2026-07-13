// POST /v1/embeddings — OpenAI-compatible embeddings endpoint.
//
// Dispatches to:
//   - Gemini: REST API directly (batchEmbedContents / embedContent), maps
//             `dimensions` → `outputDimensionality`
//   - OpenAI and any OpenAI-compat provider: proxies to ${baseURL}/embeddings
//
// No routing engine — caller always pins the model (no "auto" for embeddings).
// Logs every call to RequestRecord for observability parity with chat.

const { v4: uuidv4 } = require("uuid");
const connections = require("../providers/connections");
const { PROVIDERS } = require("../config");
const logger = require("../logging/logger");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// Map embedding model IDs to their provider.
// Embedding models are not in the ModelEntry registry (only chat models are synced),
// so we infer from well-known prefixes.
const PROVIDER_RE = [
  [/^(gemini-embedding|text-multilingual-embedding|embedding-\d)/i, "gemini"],
  [/^(text-embedding-|text-search-|ada-0|text-similarity)/i,       "openai"],
];
function inferProvider(modelId) {
  for (const [re, p] of PROVIDER_RE) if (re.test(modelId)) return p;
  return null;
}

// ── Gemini embedding via REST ─────────────────────────────────────────────────

async function embedWithGemini(model, inputs, dims, apiKey) {
  const makeReq = (text) => ({
    model:   `models/${model}`,
    content: { parts: [{ text }] },
    ...(dims != null && { outputDimensionality: dims }),
  });

  if (inputs.length === 1) {
    const res = await fetch(
      `${GEMINI_BASE}/${model}:embedContent`,
      {
        method:  "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body:    JSON.stringify(makeReq(inputs[0])),
      }
    );
    if (!res.ok) {
      const txt = await res.text().catch(() => res.status);
      throw new Error(`Gemini embedContent failed ${res.status}: ${txt}`);
    }
    const data = await res.json();
    return {
      embeddings:   [data.embedding.values],
      promptTokens: data.embedding?.statistics?.tokenCount || 0,
    };
  }

  // Batch
  const res = await fetch(
    `${GEMINI_BASE}/${model}:batchEmbedContents`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body:    JSON.stringify({ requests: inputs.map(makeReq) }),
    }
  );
  if (!res.ok) {
    const txt = await res.text().catch(() => res.status);
    throw new Error(`Gemini batchEmbedContents failed ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return {
    embeddings:   data.embeddings.map((e) => e.values),
    promptTokens: 0, // batch endpoint does not return per-request token counts
  };
}

// ── OpenAI / compat embedding via proxy ──────────────────────────────────────

async function embedWithOpenAICompat(model, inputs, dims, baseURL, apiKey) {
  const input = inputs.length === 1 ? inputs[0] : inputs;
  const res = await fetch(`${baseURL}/embeddings`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input,
      ...(dims != null && { dimensions: dims }),
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => res.status);
    throw new Error(`Embeddings API failed ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return {
    embeddings:   data.data.map((d) => d.embedding),
    promptTokens: data.usage?.prompt_tokens || 0,
  };
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handleEmbeddings(req, res) {
  const _reqStart = Date.now();
  const requestId = uuidv4();
  const body = req.body || {};

  // Validate
  if (!body.model) {
    return res.status(400).json({ error: { message: "model is required" } });
  }
  if (body.input == null) {
    return res.status(400).json({ error: { message: "input is required" } });
  }

  const model  = body.model;
  const inputs = Array.isArray(body.input) ? body.input : [body.input];
  const dims   = body.dimensions ?? null;

  // Attribution — same field priority as openaiCompat.js
  const meta = {
    application: req.apiKey?.application || body.application || "unknown",
    workflow:    req.headers["x-arbr-workflow"] || body["x-arbr-workflow"] || "embedding",
    userId:      body.user || req.headers["x-arbr-user-id"] || req.apiKey?.userId || null,
    department:  body["x-arbr-department"] || req.headers["x-arbr-department"] || req.apiKey?.department || null,
  };

  // Resolve provider from model ID
  const provider = inferProvider(model);
  if (!provider) {
    return res.status(400).json({
      error: {
        message: `Cannot determine provider for model "${model}". ` +
          `Supported prefixes: gemini-embedding-*, text-embedding-*, ada-*.`,
      },
    });
  }

  const eff = await connections.effective();
  if (!eff.providers[provider]) {
    return res.status(503).json({
      error: {
        message: `Provider "${provider}" is not connected. ` +
          `Add a credential in Settings → Connections.`,
      },
    });
  }

  const cred      = eff.providers[provider].credential;
  const _llmStart = Date.now();
  let embeddings, promptTokens;

  try {
    if (provider === "gemini") {
      ({ embeddings, promptTokens } = await embedWithGemini(model, inputs, dims, cred.apiKey));
    } else {
      // OpenAI-compat: get baseURL from static config (known providers) or
      // from the custom-provider record stored alongside the credential.
      const baseURL =
        PROVIDERS[provider]?.baseURL ||
        eff.providers[provider].baseURL ||
        "https://api.openai.com/v1";
      ({ embeddings, promptTokens } = await embedWithOpenAICompat(
        model, inputs, dims, baseURL, cred.apiKey
      ));
    }
  } catch (err) {
    setImmediate(() => logger.write({
      requestId, ...meta,
      provider, model, modelRequested: model, taskType: "embedding",
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
      latencyMs:        Date.now() - _reqStart,
      gatewayOverheadMs: _llmStart - _reqStart,
      status: "failure", errorMessage: err.message,
      routingDecision: "explicit", classifiedBy: "provided", cacheHit: false,
    }));
    return res.status(502).json({ error: { message: err.message } });
  }

  const latencyMs = Date.now() - _reqStart;

  res.set({
    "X-Arbr-Request-ID": requestId,
    "X-Arbr-Model":      model,
    "X-Arbr-Provider":   provider,
  });

  res.json({
    object: "list",
    data:   embeddings.map((embedding, index) => ({ object: "embedding", index, embedding })),
    model,
    usage:  { prompt_tokens: promptTokens, total_tokens: promptTokens },
  });

  // Log non-blocking — same pattern as /v1/chat and /v1/chat/completions
  setImmediate(() => logger.write({
    requestId, ...meta,
    provider, model, modelRequested: model, taskType: "embedding",
    promptTokens, completionTokens: 0, totalTokens: promptTokens,
    latencyMs, gatewayOverheadMs: _llmStart - _reqStart,
    status: "success", routingDecision: "explicit", classifiedBy: "provided", cacheHit: false,
    messages:     inputs.map((text) => ({ role: "user", content: text })),
    responseText: null,
  }));
}

module.exports = { handleEmbeddings };
