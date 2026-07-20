// App bootstrap: connect Mongo, mount the gateway + admin API, start listening.
const http = require("http");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { config, describe } = require("./config");
const registry = require("./pricing/registry");
const { TASK_CATALOG } = require("./classify/classifier");
const { handleChat } = require("./gateway/handler");
const { handleOpenAICompat } = require("./gateway/openaiCompat");
const { handleEmbeddings } = require("./gateway/embeddings");
const { handleUpgrade, closeAll: closeRealtimeSessions } = require("./gateway/wsAuth");
const { purgeOldRecords } = require("./maintenance/purge");
const errorAlertMonitor = require("./routing/errorAlertMonitor");
const canaryMonitor = require("./routing/canaryMonitor");
const evalWorker = require("./eval/worker");
const { supportsTools } = require("./gateway/capabilities");
const auth = require("./gateway/auth");
const adminAuth = require("./api/adminAuth");
const apiRoutes = require("./api/routes");
const connections = require("./providers/connections");

// Built dashboard (created by `npm --prefix web run build`). When present, the
// server serves it on the same port — single-port production / Docker.
const WEB_DIST = path.resolve(__dirname, "../../web/dist");

async function start() {
  await mongoose.connect(config.mongoUri);
  await registry.init(); // seed ModelEntry if empty + warm in-memory cache

  const app = express();
  // Behind a reverse proxy (nginx/ALB) this yields correct client IPs + proto.
  app.set("trust proxy", true);
  app.use(cors({
    origin: config.corsOrigin,
    exposedHeaders: ["X-Arbr-Request-ID", "X-Arbr-Model", "X-Arbr-Provider", "X-Arbr-Routing", "X-Arbr-Task-Type"],
  }));
  app.use(express.json({ limit: "2mb" }));

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

  // Dashboard / admin API — master-key gated when ARBR_ADMIN_KEY is set.
  app.use("/api", adminAuth.middleware, apiRoutes);

  // Serve the built dashboard if it exists (single-port mode).
  const hasWeb = fs.existsSync(path.join(WEB_DIST, "index.html"));
  if (hasWeb) {
    app.use(express.static(WEB_DIST));
    app.get(/^\/(?!api|v1|health).*/, (_req, res) => {
      res.sendFile(path.join(WEB_DIST, "index.html"));
    });
  }

  // Error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error("[api] error:", err);
    res.status(500).json({ error: "internal_error", message: String(err.message || err) });
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

  installShutdownHandlers({ server });
}

// Graceful shutdown.
//
// Ordering matters. Every RequestRecord is written from a detached setImmediate
// scheduled AFTER the response is sent (see logging/logger.js), so stopping the
// process the moment the socket closes loses the log line for the last requests
// served. Draining briefly after server.close() is what makes those writes land.
const SHUTDOWN_DRAIN_MS = 250;
const SHUTDOWN_FORCE_MS = 15_000; // under Kubernetes' 30s default grace period

// The daily purge interval is deliberately not cleared: this always ends in
// process.exit(0), and a 24h timer cannot fire inside the drain window.
function installShutdownHandlers({ server }) {
  let shuttingDown = false;

  async function shutdown(signal) {
    if (shuttingDown) return; // a second Ctrl-C shouldn't re-enter
    shuttingDown = true;
    console.log(`\n[shutdown] ${signal} received — draining…`);

    const force = setTimeout(() => {
      console.error(`[shutdown] still busy after ${SHUTDOWN_FORCE_MS}ms — forcing exit`);
      process.exit(1);
    }, SHUTDOWN_FORCE_MS);
    if (force.unref) force.unref();

    try {
      // 1 · Stop accepting connections; let in-flight responses finish.
      await new Promise((resolve) => server.close(resolve));

      // 2 · server.close() leaves established WebSockets open — end them explicitly.
      const closed = closeRealtimeSessions();
      if (closed > 0) console.log(`[shutdown] closed ${closed} realtime session(s)`);

      // 3 · Let the detached logger.write callbacks for those responses run.
      await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS));

      // 4 · Stop background work before tearing down its dependencies.
      errorAlertMonitor.stop();
      canaryMonitor.stop();
      evalWorker.stop();

      // 5 · Mongo last — the drained writes above need it alive.
      await mongoose.disconnect();
      console.log("[shutdown] clean");
    } catch (err) {
      console.error("[shutdown] error while draining:", err.message);
    }

    clearTimeout(force);
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

start().catch((err) => {
  console.error("Failed to start Arbr Control Plane:", err);
  process.exit(1);
});
