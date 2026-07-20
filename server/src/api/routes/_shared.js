// Shared helpers for admin API route modules.
const analytics = require("../../analytics/aggregate");
const capEngine = require("../../routing/capEngine");

// Rolling window start for a cap period (dashboard / analytics rolling window).
function capWindowStart(period) {
  return capEngine.windowStart(period);
}

// A cap enriched with its current spend / breach status.
// Enforcing caps (block/downgrade) use hard CapSpend counters so the UI matches
// the gateway; alert-only caps use the analytics aggregation.
async function capStatus(cap) {
  let spent;
  if (cap.enabled && (cap.action === "block" || cap.action === "downgrade")) {
    spent = await capEngine.getSpend(cap);
  } else {
    spent = await analytics.spend({
      dimension: cap.dimension,
      value: cap.value,
      from: capWindowStart(cap.period),
    });
  }
  const pct = cap.limit > 0 ? spent / cap.limit : 0;
  return { ...cap, spent, pct, breached: cap.enabled && spent >= cap.limit };
}

module.exports = { capWindowStart, capStatus };
