// Thin client to Arbr's OpenAI-compatible gateway. Returns the served model + routing decision
// (from Arbr's X-Arbr-* response headers) so the harness can attribute cost and explain routing.
// Requires Node 18+ (global fetch).
async function complete(cfg, { model, messages, maxTokens = 1024, temperature = 0 }) {
  const start = Date.now();
  const res = await fetch(`${cfg.gateway.baseURL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.gateway.apiKey}` },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
  });
  const latencyMs = Date.now() - start;
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) {
    const msg = (data && data.error && data.error.message) || `upstream ${res.status}`;
    throw new Error(msg);
  }
  return {
    text: (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || "",
    servedModel: res.headers.get("x-arbr-model") || data.model || model,
    routingDecision: res.headers.get("x-arbr-routing") || null,
    taskType: res.headers.get("x-arbr-task-type") || null,
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0 },
    latencyMs,
  };
}

module.exports = { complete };
