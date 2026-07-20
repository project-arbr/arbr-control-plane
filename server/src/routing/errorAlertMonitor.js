// Periodic monitor that fires a webhook when the rolling 1-hour error rate exceeds
// the configured threshold. Runs every 5 minutes; deduplicates to at most one alert
// per 30 minutes (same suppression pattern as cap notifier).
const RequestRecord = require("../models/RequestRecord");
const Settings = require("../models/Settings");

const INTERVAL_MS = 5 * 60 * 1000;   // check every 5 minutes
const WINDOW_MS   = 60 * 60 * 1000;  // rolling 1-hour window
const DEDUP_MS    = 30 * 60 * 1000;  // suppress repeat alerts for 30 minutes

let _lastFired = 0;
let _timer     = null;

async function check() {
  try {
    const s = await Settings.get();
    if (!s.alertErrorRateEnabled || !s.webhookUrl) return;

    const since = new Date(Date.now() - WINDOW_MS);
    const [row] = await RequestRecord.aggregate([
      // Customer traffic only — Arbr's own internal calls failing is an operator
      // concern, not a reason to alert someone about *their* error rate.
      { $match: { timestamp: { $gte: since }, ...RequestRecord.CUSTOMER_ONLY } },
      { $group: {
          _id: null,
          total:    { $sum: 1 },
          failures: { $sum: { $cond: [{ $eq: ["$status", "failure"] }, 1, 0] } },
      }},
    ]);
    if (!row || row.total === 0) return;

    const rate = (row.failures / row.total) * 100;
    if (rate < (s.alertErrorRateThreshold ?? 5)) return;
    if (Date.now() - _lastFired < DEDUP_MS) return;

    _lastFired = Date.now();
    const payload = {
      event: "error_rate_exceeded",
      errorRate: Math.round(rate * 10) / 10,
      threshold: s.alertErrorRateThreshold ?? 5,
      failures: row.failures,
      total: row.total,
      window: "1h",
      timestamp: new Date().toISOString(),
    };

    fetch(s.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {});
  } catch { /* errors must not crash the process */ }
}

function start() {
  if (_timer) return;
  _timer = setInterval(check, INTERVAL_MS);
  if (_timer.unref) _timer.unref(); // don't block process exit
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = { start, stop };
