// Webhook notifier — fire-and-forget POST to a configured URL for real-time alerts.
// Events: cap_breach, provider_error (future), new_application (future).
// Never throws into the caller — network failures are logged and swallowed.
const Settings = require("../models/Settings");
const NotificationDedup = require("../models/NotificationDedup");

// Cross-replica dedup: same event+key suppressed for the window (see
// NotificationDedup's TTL index). Bounded because the dedup key falls back to
// a slice of the payload, which is not guaranteed stable across callers.
async function claimedByThisCall(dedupKey) {
  try {
    await NotificationDedup.create({ dedupKey });
    return true;
  } catch (err) {
    if (err.code === 11000) return false; // another replica already sent this
    throw err;
  }
}

async function notify(event, payload) {
  try {
    const settings = await Settings.get();
    const url = settings.webhookUrl;
    if (!url) return;

    const dedupKey = `${event}:${payload.key || JSON.stringify(payload).slice(0, 80)}`;
    if (!(await claimedByThisCall(dedupKey))) return;

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
