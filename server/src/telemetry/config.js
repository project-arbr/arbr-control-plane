// Telemetry configuration, resolved once from the environment.
//
// The master switch is ARBR_OTEL_ENABLED, deliberately NOT OTEL_ENABLED:
// `langsmith` (transitive via @langchain/core) reads OTEL_ENABLED and, when true,
// flips LangChain into its own OTel tracing mode. Reading it here would couple
// this feature to a dependency's behaviour. Installing the OTel packages alone
// activates nothing — only OTEL_ENABLED / LANGSMITH_TRACING_MODE / LANGSMITH_OTEL_ENABLED
// do — so we never read or set those three, and warn if OTEL_ENABLED is present.
//
// Every OTHER knob falls back to the standard OTEL_* names, so Arbr drops into an
// already-instrumented cluster using the env a platform team already injects.

function env(...names) {
  for (const n of names) {
    const v = process.env[n];
    if (v != null && v !== "") return v;
  }
  return undefined;
}

function bool(v, dflt = false) {
  if (v == null || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

function ratio(v, dflt = 1) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : dflt;
}

function posInt(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// OTLP header list: "key1=val1,key2=val2".
function parseHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const pair of String(raw).split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  return out;
}

// A full traces endpoint set explicitly wins. Otherwise we leave `endpointOverride`
// undefined and let the OTLP exporter self-resolve from OTEL_EXPORTER_OTLP_* (it
// correctly appends /v1/traces to a base endpoint; we can't, so we don't try).
const endpointOverride = env("ARBR_OTEL_ENDPOINT", "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") || null;
const otelBase = env("OTEL_EXPORTER_OTLP_ENDPOINT");

const config = {
  enabled: bool(process.env.ARBR_OTEL_ENABLED, false),
  endpointOverride,
  // For the boot banner only.
  endpointDisplay: endpointOverride
    || (otelBase ? `${otelBase.replace(/\/$/, "")}/v1/traces` : "http://localhost:4318/v1/traces (default)"),
  headersOverride: parseHeaders(env("ARBR_OTEL_HEADERS")),
  serviceName: env("ARBR_OTEL_SERVICE_NAME", "OTEL_SERVICE_NAME") || "arbr-control-plane",
  sampleRatio: ratio(process.env.ARBR_OTEL_SAMPLE_RATIO, 1),
  captureContent: bool(process.env.ARBR_OTEL_CAPTURE_CONTENT, false),
  contentMaxChars: posInt(process.env.ARBR_OTEL_CONTENT_MAX_CHARS, 8192),
  // The poisoned variable — detected so init() can warn, never used to configure.
  otelEnabledDetected: bool(process.env.OTEL_ENABLED, false),
};

module.exports = config;
