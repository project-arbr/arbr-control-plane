// Runtime tracing overrides, sourced from Settings so an operator can pause tracing
// or retune sampling / content capture without a redeploy.
//
// env (config.js) is the HARD gate — whether the exporter is loaded at all. These
// overrides can only NARROW an env-enabled exporter; they can't turn tracing on when
// the SDK was never loaded (packages can't be required at runtime). emit() reads the
// snapshot synchronously, so it's refreshed on a background interval and eagerly on a
// governance PATCH, never awaited on the hot path.
const config = require("./config");

let Settings = null; // required lazily, only once tracing is actually running
let timer = null;

let snap = {
  softEnabled: true,
  sampleRatio: config.sampleRatio,
  captureContent: config.captureContent,
};

async function refresh() {
  try {
    if (!Settings) Settings = require("../models/Settings");
    const s = await Settings.get();
    const o = (s && s.otel) || {};
    snap = {
      softEnabled: o.enabled !== false, // null/undefined → on
      sampleRatio: o.sampleRatio != null ? o.sampleRatio : config.sampleRatio,
      captureContent: o.captureContent != null ? o.captureContent : config.captureContent,
    };
  } catch {
    // Keep the last good snapshot (env defaults on first failure). A Mongo blip
    // must never take tracing down or flip its behaviour.
  }
}

function start() {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, 5000);
  if (timer.unref) timer.unref();
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function current() {
  return snap;
}

module.exports = { start, stop, refresh, current };
