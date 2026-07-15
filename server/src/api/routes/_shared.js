// Shared helpers for admin API route modules.
const analytics = require("../../analytics/aggregate");
const capEngine = require("../../routing/capEngine");

// Rolling window start for a cap period (dashboard / analytics rolling window).
function capWindowStart(period) {
  return capEngine.windowStart(period);
}

// A cap enriched with its current spend / breach status.
async function capStatus(cap) {
  const spent = await analytics.spend({
    dimension: cap.dimension,
    value: cap.value,
    from: capWindowStart(cap.period),
  });
  const pct = cap.limit > 0 ? spent / cap.limit : 0;
  return { ...cap, spent, pct, breached: cap.enabled && spent >= cap.limit };
}

module.exports = { capWindowStart, capStatus };
