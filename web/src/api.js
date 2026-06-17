// Tiny fetch wrapper for the control-plane API.
// Admin auth: when the instance has ARBR_ADMIN_KEY set, the key entered at
// login is stored locally and sent as a Bearer token on every call.
const TOKEN_KEY = "arbr_admin_key";

export function getAdminToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setAdminToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* ignore */ }
}
export function clearAdminToken() {
  try { localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

async function req(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getAdminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`/api${path}`, {
    headers,
    ...options,
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).message || ""; } catch { /* ignore */ }
    const err = new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

function qs(params = {}) {
  const entries = Object.entries(params).filter(([, v]) => v != null && v !== "");
  return entries.length ? "?" + new URLSearchParams(entries).toString() : "";
}

export const api = {
  status: () => req("/status"),

  overview: (filter) => req(`/analytics/overview${qs(filter)}`),
  by: (dimension, filter) => req(`/analytics/by/${dimension}${qs(filter)}`),
  facets: () => req("/analytics/facets"),

  requests: (filter) => req(`/requests${qs(filter)}`),

  recommendations: (status) => req(`/recommendations${qs({ status })}`),
  recompute: () => req("/recommendations/recompute", { method: "POST" }),
  acceptRecommendation: (id) => req(`/recommendations/${id}/accept`, { method: "POST" }),
  dismissRecommendation: (id) => req(`/recommendations/${id}/dismiss`, { method: "POST" }),

  models: () => req("/models"),
  createModel: (body) => req("/models", { method: "POST", body: JSON.stringify(body) }),
  updateModel: (id, body) => req(`/models/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteModel: (id) => req(`/models/${encodeURIComponent(id)}`, { method: "DELETE" }),

  rules: () => req("/rules"),
  createRule: (body) => req("/rules", { method: "POST", body: JSON.stringify(body) }),
  updateRule: (id, body) => req(`/rules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRule: (id) => req(`/rules/${id}`, { method: "DELETE" }),

  routingMode: () => req("/routing-mode"),
  setRoutingMode: (mode) => req("/routing-mode", { method: "PUT", body: JSON.stringify({ mode }) }),

  aiPolicy: () => req("/ai-policy"),
  setAiPolicy: (assignments) => req("/ai-policy", { method: "PUT", body: JSON.stringify({ assignments }) }),
  regenerateAiPolicy: () => req("/ai-policy/regenerate", { method: "POST" }),

  clearCache: () => req("/cache/clear", { method: "POST" }),

  policy: () => req("/policy"),
  setPolicy: (body) => req("/policy", { method: "PUT", body: JSON.stringify(body) }),

  keys: () => req("/keys"),
  createKey: (body) => req("/keys", { method: "POST", body: JSON.stringify(body) }),
  updateKey: (id, body) => req(`/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  revokeKey: (id) => req(`/keys/${id}`, { method: "DELETE" }),
  requireApiKey: () => req("/require-api-key"),
  setRequireApiKey: (on) => req("/require-api-key", { method: "PUT", body: JSON.stringify({ on }) }),

  caps: () => req("/caps"),
  createCap: (body) => req("/caps", { method: "POST", body: JSON.stringify(body) }),
  updateCap: (id, body) => req(`/caps/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteCap: (id) => req(`/caps/${id}`, { method: "DELETE" }),

  connections: () => req("/connections"),
  setProviderCredential: (provider, credential) => req(`/connections/${provider}`, { method: "PUT", body: JSON.stringify(credential) }),
  removeProviderKey: (provider) => req(`/connections/${provider}`, { method: "DELETE" }),
  setDefaultProvider: (provider) => req("/default-provider", { method: "PUT", body: JSON.stringify({ provider }) }),
  setDefaultModel: (model) => req("/default-model", { method: "PUT", body: JSON.stringify({ model }) }),
  testProvider: (provider) => req(`/connections/${provider}/test`, { method: "POST" }),
};

export const fmt = {
  usd: (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  num: (n) => (Number(n) || 0).toLocaleString(),
  ms: (n) => `${Math.round(Number(n) || 0)} ms`,
  date: (d) => new Date(d).toLocaleString(),
};
