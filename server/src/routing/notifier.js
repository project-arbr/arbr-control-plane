// Webhook notifier — fire-and-forget POST to a configured URL for real-time alerts.
// Events: cap_breach, provider_error (future), new_application (future).
// Never throws into the caller — network failures are logged and swallowed.
const Settings = require("../models/Settings");

// In-memory dedup: prevents duplicate cap_breach pings within a 5-minute window.
const recentlySent = new Map(); // key → last sent timestamp

async function notify(event, payload) {
  try {
    const settings = await Settings.get();
    const url = settings.webhookUrl;
    if (!url) return;

    // Dedup: same event+key → suppress for 5 minutes.
    const dedupKey = `${event}:${payload.key || JSON.stringify(payload).slice(0, 80)}`;
    const lastSent = recentlySent.get(dedupKey) || 0;
    if (Date.now() - lastSent < 5 * 60 * 1000) return;
    recentlySent.set(dedupKey, Date.now());

    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, timestamp: new Date().toISOString(), ...payload }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error("[notifier] webhook delivery failed:", err.message);
  }
}

module.exports = { notify };
