// Webhook notifier — fire-and-forget POST to a configured URL for real-time alerts.
// Events: cap_breach, provider_error (future), new_application (future).
// Never throws into the caller — network failures are logged and swallowed.
const Settings = require("../models/Settings");
const { createBoundedTtlCache } = require("../utils/boundedTtlCache");

// In-memory dedup: prevents duplicate cap_breach pings within a 5-minute window.
// The TTL is the dedup window, so a live entry means "already sent recently" and
// entries prune themselves. Bounded because the dedup key falls back to a slice
// of the payload, which is not guaranteed stable across callers.
const DEDUP_WINDOW_MS = 5 * 60 * 1000;
const recentlySent = createBoundedTtlCache({ ttlMs: DEDUP_WINDOW_MS, maxEntries: 1000 });

async function notify(event, payload) {
  try {
    const settings = await Settings.get();
    const url = settings.webhookUrl;
    if (!url) return;

    // Dedup: same event+key → suppress for the window.
    const dedupKey = `${event}:${payload.key || JSON.stringify(payload).slice(0, 80)}`;
    if (recentlySent.has(dedupKey)) return;
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
