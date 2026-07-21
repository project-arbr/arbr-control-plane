// Tiny fetch wrapper for the control-plane API.
//
// Identity (F-04): the normal path is a server-side session, carried in an
// httpOnly cookie the browser sends automatically (credentials: "include") —
// nothing to store or attach here. ARBR_ADMIN_KEY is a break-glass fallback
// for adminkey-mode deployments / scripts; when a key was entered at login
// it's still sent as a Bearer token, but it no longer sits in the normal
// per-request path once a real auth mode is configured (see Login.jsx).
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

// CSRF token for cookie-authenticated (oidc) sessions — a no-op in adminkey
// mode, where there's no session cookie for the server to validate against.
// Cached after first fetch; reset on logout since it's bound to the session.
let csrfToken = null;
export function resetCsrfToken() { csrfToken = null; }
async function ensureCsrfToken() {
  if (csrfToken) return csrfToken;
  try {
    const res = await fetch("/api/auth/csrf", { credentials: "include" });
    if (res.ok) csrfToken = (await res.json()).csrfToken || null;
  } catch { /* no session — server will skip CSRF validation anyway */ }
  return csrfToken;
}

async function req(path, options = {}) {
  const headers = { "Content-Type": "application/json" };
  const token = getAdminToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const method = (options.method || "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    const csrf = await ensureCsrfToken();
    if (csrf) headers["x-csrf-token"] = csrf;
  }
  const res = await fetch(`/api${path}`, {
    headers,
    credentials: "include",
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
  about: () => req("/about"),

  // Identity (F-04). authMode/currentUser are safe unauthenticated — used by
  // Login.jsx to decide what to render before a session exists.
  authMode: () => req("/auth/mode"),
  currentUser: () => req("/auth/me"),
  logout: () => req("/auth/logout", { method: "POST" }),

  users: () => req("/users"),
  setUserRole: (id, role) => req(`/users/${id}/role`, { method: "PATCH", body: JSON.stringify({ role }) }),
  disableUser: (id) => req(`/users/${id}/disable`, { method: "POST" }),
  enableUser: (id) => req(`/users/${id}/enable`, { method: "POST" }),

  // Gateway discovery endpoints (same auth as /v1/chat — usable by SDK clients).
  gatewayModels: () => fetch("/v1/models", { headers: { "Content-Type": "application/json" } }).then((r) => r.json()),
  gatewayProviders: () => fetch("/v1/providers", { headers: { "Content-Type": "application/json" } }).then((r) => r.json()),

  overview: (filter) => req(`/analytics/overview${qs(filter)}`),
  internalSpend: (filter) => req(`/analytics/internal-spend${qs(filter)}`),
  timeseries: (filter) => req(`/analytics/timeseries${qs(filter)}`),
  latencyPercentiles: (filter) => req(`/analytics/latency-percentiles${qs(filter)}`),
  providerHealth: () => req("/analytics/provider-health"),
  by: (dimension, filter) => req(`/analytics/by/${dimension}${qs(filter)}`),
  realisedSavings: (filter) => req(`/analytics/realised-savings${qs(filter)}`),
  savingsTrust: () => req("/analytics/savings-trust"),
  facets: () => req("/analytics/facets"),

  requests: (filter) => req(`/requests${qs(filter)}`),
  request: (id) => req(`/requests/${encodeURIComponent(id)}`),
  exportRequests: (filter) => {
    const url = `/api/requests/export${qs(filter)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "requests.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  recommendations: (status) => req(`/recommendations${qs({ status })}`),
  recommendationsAnalysis: () => req("/recommendations/analysis"),
  recompute: () => req("/recommendations/recompute", { method: "POST" }),
  acceptRecommendation: (id, override) => req(`/recommendations/${id}/accept`, { method: "POST", body: JSON.stringify(override ? { override } : {}) }),
  dismissRecommendation: (id) => req(`/recommendations/${id}/dismiss`, { method: "POST" }),

  // Eval-backed routing (P0–P3): dataset → offline run → shadow → canary.
  createEvalDataset: (id, body = {}) => req(`/recommendations/${id}/create-eval-dataset`, { method: "POST", body: JSON.stringify(body) }),
  runEval: (id, body = {}) => req(`/recommendations/${id}/run-eval`, { method: "POST", body: JSON.stringify(body) }),
  startShadow: (id, body = {}) => req(`/recommendations/${id}/start-shadow`, { method: "POST", body: JSON.stringify(body) }),
  createCanary: (id, body = {}) => req(`/recommendations/${id}/create-canary`, { method: "POST", body: JSON.stringify(body) }),
  overrideRecommendation: (id, body) => req(`/recommendations/${id}/override`, { method: "POST", body: JSON.stringify(body) }),
  recommendationOutcome: (id) => req(`/recommendations/${id}/outcome`),
  // F-05: evidence export. Server sets Content-Disposition, so a plain anchor click
  // downloads it directly — same pattern as exportRequests/exportAuditLog.
  exportRecommendationReport: (id, format = "json") => {
    const url = `/api/recommendations/${id}/report${format === "markdown" ? "?format=markdown" : ""}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${id}-evidence-report.${format === "markdown" ? "md" : "json"}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },
  evalDatasets: (recommendationId) => req(`/evals/datasets${qs({ recommendationId })}`),
  evalDataset: (id) => req(`/evals/datasets/${id}`),
  createEval: (body) => req("/evals", { method: "POST", body: JSON.stringify(body) }),
  evalTrafficModels: ({ application } = {}) => req(`/evals/traffic-models${qs({ application })}`),
  evalRuns: (recommendationId) => req(`/evals/runs${qs({ recommendationId })}`),

  // Reusable benchmarks ("DashBench"): a named frozen set, scored against many candidates.
  acceptanceStats: () => req("/analytics/acceptance"),
  benchmarks: () => req("/eval-benchmarks"),
  benchmark: (id) => req(`/eval-benchmarks/${id}`),
  createBenchmark: (body) => req("/eval-benchmarks", { method: "POST", body: JSON.stringify(body) }),
  runBenchmark: (id, body) => req(`/eval-benchmarks/${id}/run`, { method: "POST", body: JSON.stringify(body) }),
  deleteBenchmark: (id) => req(`/eval-benchmarks/${id}`, { method: "DELETE" }),
  // Curation: pin cases + set per-case severity.
  benchmarkItems: (id) => req(`/eval-benchmarks/${id}/items`),
  addBenchmarkItem: (id, body) => req(`/eval-benchmarks/${id}/items`, { method: "POST", body: JSON.stringify(body) }),
  setEvalItemSeverity: (itemId, severity) => req(`/eval-items/${itemId}`, { method: "PATCH", body: JSON.stringify({ severity }) }),
  deleteEvalItem: (itemId) => req(`/eval-items/${itemId}`, { method: "DELETE" }),
  evalRun: (id) => req(`/evals/runs/${id}`),
  deleteEvalRun: (id) => req(`/evals/runs/${id}`, { method: "DELETE" }),
  evalRunResults: (id) => req(`/evals/runs/${id}/results`),
  setResultVerdict: (resultId, verdict) => req(`/evals/results/${resultId}`, { method: "PATCH", body: JSON.stringify({ verdict }) }),

  // Routing experiments (canary rollout).
  routingExperiments: (status) => req(`/routing-experiments${qs({ status })}`),
  createRoutingExperiment: (body) => req("/routing-experiments", { method: "POST", body: JSON.stringify(body) }),
  routingExperiment: (id) => req(`/routing-experiments/${id}`),
  updateRoutingExperiment: (id, body) => req(`/routing-experiments/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  rollbackExperiment: (id, reason) => req(`/routing-experiments/${id}/rollback`, { method: "POST", body: JSON.stringify({ reason }) }),
  // approvedBy is derived server-side from the signed-in user, not sent from here.
  promoteExperiment: (id) => req(`/routing-experiments/${id}/promote`, { method: "POST" }),

  models: ({ live, routable } = {}) => {
    const q = [live && "live=true", routable && "routable=true"].filter(Boolean).join("&");
    return req(`/models${q ? `?${q}` : ""}`);
  },
  createModel: (body) => req("/models", { method: "POST", body: JSON.stringify(body) }),
  updateModel: (id, body) => req(`/models/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteModel: (id) => req(`/models/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testModel: (id, message) => req(`/models/${encodeURIComponent(id)}/test`, { method: "POST", body: JSON.stringify({ message }) }),

  rules: () => req("/rules"),
  createRule: (body) => req("/rules", { method: "POST", body: JSON.stringify(body) }),
  updateRule: (id, body) => req(`/rules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteRule: (id) => req(`/rules/${id}`, { method: "DELETE" }),

  routingMode: () => req("/routing-mode"),
  setRoutingMode: (mode) => req("/routing-mode", { method: "PUT", body: JSON.stringify({ mode }) }),

  aiPolicy: () => req("/ai-policy"),
  setAiPolicy: (assignments) => req("/ai-policy", { method: "PUT", body: JSON.stringify({ assignments }) }),
  regenerateAiPolicy: (goal = "balanced", windowDays) => req("/ai-policy/regenerate", { method: "POST", body: JSON.stringify({ goal, windowDays }) }),
  simulatePolicy: (assignments, windowDays) => req("/ai-policy/simulate", { method: "POST", body: JSON.stringify({ assignments, windowDays }) }),

  syncBenchmarks:   () => req("/benchmarks/sync",  { method: "POST" }),
  benchmarksStatus: () => req("/benchmarks/status"),
  // individual sync endpoints kept for debugging
  syncLivebench:   () => req("/livebench/sync",  { method: "POST" }),
  livebenchStatus: () => req("/livebench/status"),
  syncLmsys:       () => req("/lmsys/sync",      { method: "POST" }),
  lmsysStatus:     () => req("/lmsys/status"),
  syncLitellm:     () => req("/litellm/sync",    { method: "POST" }),
  litellmStatus:   () => req("/litellm/status"),

  clearCache: () => req("/cache/clear", { method: "POST" }),
  clearSemanticCache: () => req("/cache/semantic/clear", { method: "POST" }),
  semanticCacheStats: () => req("/cache/semantic/stats"),

  policy: () => req("/policy"),
  setPolicy: (body) => req("/policy", { method: "PUT", body: JSON.stringify(body) }),

  keys: () => req("/keys"),
  createKey: (body) => req("/keys", { method: "POST", body: JSON.stringify(body) }),
  updateKey: (id, body) => req(`/keys/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  revokeKey: (id) => req(`/keys/${id}`, { method: "DELETE" }),
  rotateKey: (id) => req(`/keys/${id}/rotate`, { method: "POST" }),
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

  customProviders: () => req("/custom-providers"),
  addCustomProvider: (body) => req("/custom-providers", { method: "POST", body: JSON.stringify(body) }),
  updateCustomProvider: (id, body) => req(`/custom-providers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  removeCustomProvider: (id) => req(`/custom-providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testCustomProvider: (id, model) => req(`/custom-providers/${encodeURIComponent(id)}/test`, { method: "POST", body: JSON.stringify({ model }) }),
  discoverProviderModels: (id) => req(`/custom-providers/${encodeURIComponent(id)}/models`),
  importProviderModels: (id, models) => req(`/custom-providers/${encodeURIComponent(id)}/models`, { method: "POST", body: JSON.stringify({ models }) }),

  governance: () => req("/governance"),
  updateGovernance: (body) => req("/governance", { method: "PATCH", body: JSON.stringify(body) }),

  auditLog: (params) => req(`/audit${qs(params)}`),
  exportAuditLog: (filter) => {
    const url = `/api/audit/export${qs(filter)}`;
    const a = document.createElement("a");
    a.href = url;
    a.download = "audit-log.csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  },

  appConfigs: () => req("/app-configs"),
  appConfig: (app) => req(`/app-configs/${encodeURIComponent(app)}`),
  setAppConfig: (app, body) => req(`/app-configs/${encodeURIComponent(app)}`, { method: "PUT", body: JSON.stringify(body) }),
  generateAppPolicy: (app, excludeModels = [], goal = "balanced", windowDays) => req(`/app-configs/${encodeURIComponent(app)}/generate-policy`, { method: "POST", body: JSON.stringify({ excludeModels, goal, windowDays }) }),
  simulateAppPolicy: (app, assignments, windowDays) => req(`/app-configs/${encodeURIComponent(app)}/simulate`, { method: "POST", body: JSON.stringify({ assignments, windowDays }) }),
  setAppDefaultPolicy: (app) => req(`/app-configs/${encodeURIComponent(app)}/set-default-policy`, { method: "POST" }),

  // Shadow-eval campaigns
  evalCampaigns: () => req("/eval/campaigns"),
  evalCampaign: (id) => req(`/eval/campaigns/${id}`),
  createEvalCampaign: (body) => req("/eval/campaigns", { method: "POST", body: JSON.stringify(body) }),
  updateEvalCampaign: (id, body) => req(`/eval/campaigns/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
  deleteEvalCampaign: (id) => req(`/eval/campaigns/${id}`, { method: "DELETE" }),
  evalCampaignPairs: (id) => req(`/eval/campaigns/${id}/pairs`),
};

export const fmt = {
  usd: (n) => `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
  num: (n) => (Number(n) || 0).toLocaleString(),
  ms: (n) => `${Math.round(Number(n) || 0)} ms`,
  date: (d) => new Date(d).toLocaleString(),
};
