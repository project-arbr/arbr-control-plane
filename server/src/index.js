// App bootstrap: connect Mongo, mount the gateway + admin API, start listening.
const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const { config, describe } = require("./config");
const registry = require("./pricing/registry");
const { handleChat } = require("./gateway/handler");
const { handleOpenAICompat } = require("./gateway/openaiCompat");
const auth = require("./gateway/auth");
const adminAuth = require("./api/adminAuth");
const apiRoutes = require("./api/routes");

// Built dashboard (created by `npm --prefix web run build`). When present, the
// server serves it on the same port — single-port production / Docker.
const WEB_DIST = path.resolve(__dirname, "../../web/dist");

async function start() {
  await mongoose.connect(config.mongoUri);
  await registry.init(); // seed ModelEntry if empty + warm in-memory cache

  const app = express();
  // Behind a reverse proxy (nginx/ALB) this yields correct client IPs + proto.
  app.set("trust proxy", true);
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: "2mb" }));

  // Liveness.
  app.get("/health", (_req, res) => res.json({ ok: true, demoMode: config.demoMode }));

  // The unified AI gateway — one endpoint for all AI requests.
  // API-key auth (data plane only): validates presented keys, binds attribution,
  // enforces per-key rate limits; anonymous calls allowed until requireApiKey is on.
  app.post("/v1/chat", auth.middleware, handleChat);

  // OpenAI-compatible endpoint — any client that speaks the OpenAI spec can use Arbr.
  app.post("/v1/chat/completions", auth.middleware, handleOpenAICompat);

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

  app.listen(config.port, config.host, () => {
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
