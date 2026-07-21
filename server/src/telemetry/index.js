// Telemetry facade. The app imports this; it delegates to the lazy OTel edge.
//
// emit() is a synchronous no-op when disabled (one boolean test, no allocation),
// so leaving tracing off costs nothing on the request path.
const config = require("./config");
const otel = require("./otel");
const runtime = require("./runtime");

let _started = false;

function init() {
  if (_started) return;
  _started = true;

  if (config.otelEnabledDetected) {
    console.warn(
      "[telemetry] OTEL_ENABLED=true detected. Arbr ignores it (use ARBR_OTEL_ENABLED); " +
      "note that variable also switches @langchain/core into LangSmith-OTel mode.",
    );
  }
  if (!config.enabled) return;

  otel.init();
  if (otel.isEnabled()) {
    console.log(
      `[telemetry] OTLP trace export ON → ${config.endpointDisplay} ` +
      `(sample ${config.sampleRatio}, content ${config.captureContent ? "on" : "off"})`,
    );
  }
}

function emit(record, ctx) {
  if (config.enabled) otel.emit(record, ctx);
}

function isEnabled() {
  return config.enabled && otel.isEnabled();
}

const forceFlush = () => otel.forceFlush();
const shutdown = () => otel.shutdown();

// Re-read the Settings-backed runtime overrides now, instead of waiting for the poll.
// Called from PATCH /governance so a dashboard change takes effect immediately.
const refreshRuntime = () => (config.enabled ? runtime.refresh() : Promise.resolve());

module.exports = { init, emit, isEnabled, forceFlush, shutdown, refreshRuntime, config };
