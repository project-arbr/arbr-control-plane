// Live FX for display currency. Costs are stored in USD everywhere (LiteLLM-native);
// this fetches a USD→currency rate on a schedule and caches it in Settings, so the
// dashboard can show ₹ (or any currency) without changing any stored value.
//
// Failure is handled so a cost figure is never WRONG:
//   - Multiple keyless providers are tried in order.
//   - If all fail but a good rate was fetched before, the last one is kept (stale-ok)
//     and flagged `stale` so the UI can say so.
//   - If a rate was NEVER fetched for the current currency (`available: false`), the
//     UI falls back to showing USD rather than applying a bogus 1:1 rate under a
//     foreign label ("₹1.20" for $1.20 would badly understate cost).
//   - Switching currency resets the cached rate first, so a failed fetch can't
//     misapply the PREVIOUS currency's rate under the new label.
const Settings = require("../models/Settings");

const REFRESH_MS = Number(process.env.ARBR_FX_REFRESH_MS) || 12 * 60 * 60 * 1000; // twice a day
const STALE_MS   = Number(process.env.ARBR_FX_STALE_MS)   || 48 * 60 * 60 * 1000; // 2 days

function num(v) { return typeof v === "number" && v > 0 ? v : null; }

// Ordered, keyless FX providers. `url(currency)` and `parse(json, currency)` per source.
const PROVIDERS = [
  { name: "er-api",
    url: () => process.env.ARBR_FX_URL || "https://open.er-api.com/v6/latest/USD",
    parse: (j, c) => num(j && j.rates && j.rates[c]) },
  { name: "frankfurter",
    url: (c) => `https://api.frankfurter.app/latest?from=USD&to=${c}`,
    parse: (j, c) => num(j && j.rates && j.rates[c]) },
];

// Pure: pull the USD→`currency` rate out of a provider's response. Exported for tests.
function parseRate(json, currency) {
  const rates = json && json.rates;
  return num(rates && rates[String(currency || "").toUpperCase()]);
}

// Pure: USD amount → display amount. rate defaults to 1 (USD / unknown).
function convert(usd, rate) {
  return (Number(usd) || 0) * (Number(rate) > 0 ? Number(rate) : 1);
}

// Try each provider in order; first positive rate wins; null if all fail.
async function fetchRate(currency) {
  for (const p of PROVIDERS) {
    try {
      const resp = await fetch(p.url(currency), { signal: AbortSignal.timeout(8000) });
      if (!resp || !resp.ok) continue;
      const rate = p.parse(await resp.json(), currency);
      if (rate) return rate;
    } catch { /* try the next provider */ }
  }
  return null;
}

// { currency, rate, updatedAt, stale, available }. `available` means a real rate has
// been fetched for this currency (USD is always available at 1). `stale` means it is
// available but older than STALE_MS.
function state(currency, rate, updatedAt) {
  const cur = String(currency || "USD").toUpperCase();
  const available = cur === "USD" || !!updatedAt;
  const stale = cur !== "USD" && (!updatedAt || Date.now() - new Date(updatedAt).getTime() > STALE_MS);
  return { currency: cur, rate: Number(rate) > 0 ? Number(rate) : 1, updatedAt: updatedAt || null, stale, available };
}

// Fetch the rate for the configured currency and cache it. USD short-circuits to 1.
// Keeps the previous rate on total failure; never throws.
async function refreshRate() {
  const s = await Settings.get();
  const currency = (s.currency || "USD").toUpperCase();
  if (currency === "USD") {
    if (s.fxRate !== 1 || s.fxUpdatedAt == null) { s.fxRate = 1; s.fxUpdatedAt = new Date(); await s.save(); Settings.invalidateCache(); }
    return state("USD", 1, s.fxUpdatedAt || new Date());
  }
  const rate = await fetchRate(currency);
  if (rate) {
    s.fxRate = rate; s.fxUpdatedAt = new Date(); await s.save(); Settings.invalidateCache();
    return state(currency, rate, s.fxUpdatedAt);
  }
  console.warn(`[fx] all providers failed for ${currency}; ` +
    (s.fxUpdatedAt ? `keeping last rate ${s.fxRate} (stale)` : "no rate yet — display falls back to USD"));
  return state(currency, s.fxRate || 1, s.fxUpdatedAt || null);
}

// Switch display currency. Reset the cached rate FIRST so a failed fetch cannot
// misapply the previous currency's rate under the new label, then fetch the new one.
async function setCurrency(code) {
  const currency = String(code || "USD").toUpperCase();
  const s = await Settings.get();
  s.currency = currency; s.fxRate = 1; s.fxUpdatedAt = null;
  await s.save(); Settings.invalidateCache();
  return refreshRate();
}

async function getState() {
  try { const s = await Settings.get(); return state((s.currency || "USD").toUpperCase(), s.fxRate || 1, s.fxUpdatedAt || null); }
  catch { return state("USD", 1, new Date()); }
}

let _timer = null;
function startAutoRefresh(ms = REFRESH_MS) {
  if (_timer || !(ms > 0)) return;
  refreshRate().catch(() => {});
  _timer = setInterval(() => refreshRate().catch(() => {}), ms);
  if (_timer.unref) _timer.unref();
}
function stopAutoRefresh() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { parseRate, convert, fetchRate, state, refreshRate, setCurrency, getState, startAutoRefresh, stopAutoRefresh };
