// WebSocket upgrade handler — intercepts HTTP upgrades on /v1/realtime before
// Express sees them, validates the Arbr API key (same logic as HTTP middleware),
// and hands off to the realtime proxy.
const { WebSocketServer } = require("ws");
const { resolveKey } = require("./auth");
const { handleRealtimeSession } = require("./realtimeProxy");
const Settings = require("../models/Settings");

const wss = new WebSocketServer({ noServer: true });

async function handleUpgrade(req, socket, head) {
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/v1/realtime")) {
    socket.destroy();
    return;
  }

  let keyDoc = null;
  try {
    keyDoc = await resolveKey(req.headers.authorization || "");
  } catch (err) {
    socket.write(`HTTP/1.1 ${err.statusCode || 401} Unauthorized\r\n\r\n`);
    socket.destroy();
    return;
  }

  // If anonymous, reject when requireApiKey is on.
  if (!keyDoc) {
    const s = await Settings.get().catch(() => ({ requireApiKey: false }));
    if (s.requireApiKey) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\nAn API key is required.");
      socket.destroy();
      return;
    }
  }

  req.apiKey = keyDoc;
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleRealtimeSession(req, ws);
  });
}

module.exports = { handleUpgrade };
