// App bootstrap: connect Mongo, mount the gateway + admin API, start listening.
const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const mongoose = require("mongoose");
const { config, describe, assertProductionReady } = require("./config");
const registry = require("./pricing/registry");
const { TASK_CATALOG } = require("./classify/classifier");
const { handleChat } = require("./gateway/handler");
const { handleOpenAICompat } = require("./gateway/openaiCompat");
const { handleEmbeddings } = require("./gateway/embeddings");
const { handleUpgrade } = require("./gateway/wsAuth");
const { purgeOldRecords } = require("./maintenance/purge");
const errorAlertMonitor = require("./routing/errorAlertMonitor");
const canaryMonitor = require("./routing/canaryMonitor");
const evalWorker = require("./eval/worker");
const { supportsTools } = require("./gateway/capabilities");
const auth = require("./gateway/auth");
const adminAuth = require("./api/adminAuth");
const adminRateLimit = require("./api/adminRateLimit");
const csrf = require("./api/csrf");
const apiRoutes = require("./api/routes");
const authRoutes = require("./api/routes/auth");
const connections = require("./providers/connections");

// Built dashboard (created by `npm --prefix web run build`). When present, the
// server serves it on the same port — single-port production / Docker.
const WEB_DIST = path.resolve(__dirname, "../../web/dist");

async function start() {
  // Fail closed before any network bind when running as production.
  assertProductionReady();

  await mongoose.connect(config.mongoUri);
  await registry.init(); // seed ModelEntry if empty + warm in-memory cache

  // Production: force data-plane API keys on so anonymous /v1 calls are rejected.
  if (config.isProduction) {
    const Settings = require("./models/Settings");
    const s = await Settings.get();
    if (!s.requireApiKey) {
      s.requireApiKey = true;
      await s.save();
      Settings.invalidateCache();
      console.warn("[boot] production: requireApiKey forced ON (data-plane keys required).");
    }
  }

  const app = express();
  // Behind a reverse proxy (nginx/ALB) this yields correct client IPs + proto.
  app.set("trust proxy", true);
  app.use(cors({
    origin: config.corsOrigin,
    // Sessions (F-04) ride in an httpOnly cookie — the browser only attaches it
    // cross-origin (Vite :5173 → server :4100 in dev) when both this and the
    // fetch call (see web/src/api.js) opt into credentialed requests.
    credentials: true,
    exposedHeaders: ["X-Arbr-Request-ID", "X-Arbr-Model", "X-Arbr-Provider", "X-Arbr-Routing", "X-Arbr-Task-Type"],
  }));
  app.use(express.json({ limit: "2mb" }));
  app.use(cookieParser());
  // Mounted globally so every route is structurally CSRF-protected; only
  // requests carrying a session cookie are actually validated (see csrf.js).
  app.use(csrf.protection);

  // Liveness. `demoMode` reflects the EFFECTIVE provider state (env creds +
  // dashboard-connected creds), matching the console and gateway routing — not
  // just the boot-time env snapshot. Falls back to the boot flag if the
  // connection store is momentarily unavailable: liveness must never depend on
  // the DB being reachable.
  app.get("/health", async (_req, res) => {
    let demoMode = config.demoMode;
    try { demoMode = (await connections.effective()).demoMode; } catch { /* keep boot-time fallback */ }
    res.json({ ok: true, demoMode });
  });

  // The unified AI gateway — one endpoint for all AI requests.
  // API-key auth (data plane only): validates presented keys, binds attribution,
  // enforces per-key rate limits; anonymous calls allowed until requireApiKey is on.
  app.post("/v1/chat", auth.middleware, handleChat);

  // OpenAI-compatible endpoint — any client that speaks the OpenAI spec can use Arbr.
  app.post("/v1/chat/completions", auth.middleware, handleOpenAICompat);

  // OpenAI-compatible embeddings endpoint — routes to the appropriate provider
  // (Gemini or OpenAI-compat) based on the model ID, with full observability.
  app.post("/v1/embeddings", auth.middleware, handleEmbeddings);

  // OpenAI-compatible model discovery — returns only models whose provider is
  // currently connected (live), with a toolCallSupported flag so clients know
  // whether to enable the Search / function-calling UI for each model.
  //
  // Tool call support rules (mirrors openaiCompat.js):
  //   • OpenAI-compat providers (openai/deepseek/moonshot/xai/groq/litellm): yes — raw proxy
  //   • bedrock-nova + Amazon Nova model IDs: yes — via ChatBedrockConverse.bindTools()
  //   • Everything else (gemini/anthropic/non-Nova bedrock): no — returns 501 today
  app.get("/v1/models", auth.middleware, async (_req, res) => {
    try {
      const eff = await connections.effective();
      const liveSet = new Set(eff.liveIds);
      const models = registry.listModels().filter((m) => liveSet.has(m.provider));
      res.json({
        object: "list",
        data: models.map((m) => ({
          id: m.id,
          object: "model",
          created: m.createdAt ? Math.floor(new Date(m.createdAt).getTime() / 1000) : 0,
          owned_by: m.provider,
          provider: m.provider,
          label: m.label || m.id,
          tier: m.tier,
          inputPer1M: m.inputPer1M,
          outputPer1M: m.outputPer1M,
          toolCallSupported: supportsTools(m.provider, m.id),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: "internal_error", message: String(err.message || err) });
    }
  });

  // Task type discovery — lists all supported task types with tier and description.
  app.get("/v1/task-types", auth.middleware, (_req, res) => {
    res.json({ object: "list", data: TASK_CATALOG });
  });

  // Provider discovery — lists which providers are live (no credentials exposed).
  app.get("/v1/providers", auth.middleware, async (_req, res) => {
    try {
      const eff = await connections.effective();
      const allModels = registry.listModels();
      const data = eff.liveIds.map((id) => {
        const providerModels = allModels.filter((m) => m.provider === id).map((m) => m.id);
        return { id, models: providerModels };
      });
      res.json({ object: "list", data });
    } catch (err) {
      res.status(500).json({ error: "internal_error", message: String(err.message || err) });
    }
  });

  // Identity endpoints (login/callback/logout/mode/me) — must be reachable
  // before a session exists, so mounted ahead of adminAuth.middleware.
  app.use("/api/auth", adminRateLimit.middleware, authRoutes);

  // Dashboard / admin API — master-key or per-user identity gated (see
  // adminAuth.js), rate-limited per source IP (see adminRateLimit.js).
  app.use("/api", adminRateLimit.middleware, adminAuth.middleware, apiRoutes);

  // Serve the built dashboard if it exists (single-port mode).
  const hasWeb = fs.existsSync(path.join(WEB_DIST, "index.html"));
  if (hasWeb) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api|v1|health).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST, "index.html"));
    });
  }

  // Error handler. Respects a thrown error's own status (e.g. csrf-csrf's
  // ForbiddenError is a real 403, not a server fault) instead of flattening
  // everything to 500.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error("[api] error:", err);
    res.status(status).json({ error: err.code || "internal_error", message: String(err.message || err) });
  });

  // Daily purge of request records older than the configured retention window.
  // Runs immediately on startup (catches any overdue records), then every 24h.
  purgeOldRecords();
  setInterval(purgeOldRecords, 24 * 60 * 60 * 1000);

  // Error-rate alerting: checks rolling 1-hour error rate every 5 min and fires
  // the governance webhook when the threshold is exceeded.
  errorAlertMonitor.start();

  // Canary auto-rollback: every 5 min, roll back any active routing experiment that
  // breaches its guardrails (error rate, latency, cost saving, shadow worse-rate).
  canaryMonitor.start();

  // Eval replay worker: picks up queued eval runs (survives restarts; setImmediate did not).
  evalWorker.start();

  const server = http.createServer(app);
  server.on("upgrade", handleUpgrade);
  server.listen(config.port, config.host, () => {
    console.log("\n" + describe() + "\n");
    console.log(`  ready:       http://localhost:${config.port}`);
    console.log(`  gateway:     POST http://localhost:${config.port}/v1/chat`);
    console.log(`  api:         http://localhost:${config.port}/api/status`);
    if (hasWeb) console.log(`  dashboard:   http://localhost:${config.port}/`);
    else console.log(`  dashboard:   run "npm run dev" (Vite on :${process.env.WEB_PORT || 5173})`);
    console.log("");
  });
}

start().catch((err) => {
  console.error("Failed to start Arbr Control Plane:", err);
  process.exit(1);
});
