// Shared helpers for admin API route modules.
const analytics = require("../../analytics/aggregate");
const capEngine = require("../../routing/capEngine");

// Rolling window start for a cap period (dashboard / analytics rolling window).
function capWindowStart(period) {
  return capEngine.windowStart(period);
}

// A cap enriched with its current spend / breach status.
// Every enabled cap (including alert) accumulates a hard CapSpend counter, and that
// counter is what drives enforcement AND the cap_warning/cap_breach webhooks. Read it
// so the Budgets UI matches exactly what the gateway acts on. Disabled caps aren't
// counted, so fall back to the analytics rolling window for a display estimate.
async function capStatus(cap) {
  let spent;
  if (cap.enabled) {
    spent = await capEngine.getSpend(cap);
  } else {
    spent = await analytics.spend({
      // The friendly "user" dimension maps to the record field "userId".
      dimension: cap.dimension === "user" ? "userId" : cap.dimension,
      value: cap.value,
      from: capWindowStart(cap.period),
      // Must mirror capEngine._matches, or the Budgets page shows a different
      // number than the one being enforced: global caps see Arbr's own overhead,
      // scoped caps do not.
      includeInternal: !cap.dimension,
    });
  }
  const pct = cap.limit > 0 ? spent / cap.limit : 0;
  return { ...cap, spent, pct, breached: cap.enabled && spent >= cap.limit };
}

module.exports = { capWindowStart, capStatus };
