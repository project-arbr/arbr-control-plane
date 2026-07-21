// The only file that touches @opentelemetry/*. Everything is lazy: nothing is
// required until init() runs with tracing enabled, so a default (disabled) boot
// never loads the SDK — zero cost, zero memory, and no chance of touching a global.
// All the logic lives in the pure siblings; this is the thin SDK edge.
const config = require("./config");
const { parseTraceparent } = require("./traceContext");
const attrs = require("./attributes");

let _sdk = null;    // { api, provider, tracer } once initialized
let _lastErrAt = 0; // rate-limit exporter error logs (a dead collector must not flood stdout)

function init() {
  if (_sdk || !config.enabled) return;
  try {
    const api = require("@opentelemetry/api");
    const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
    const { BatchSpanProcessor, AlwaysOnSampler } = require("@opentelemetry/sdk-trace-base");
    const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
    const { resourceFromAttributes } = require("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME } = require("@opentelemetry/semantic-conventions");

    // No url/headers passed unless overridden — the exporter self-resolves the
    // standard OTEL_EXPORTER_OTLP_* env (it appends /v1/traces to a base endpoint).
    const exporter = new OTLPTraceExporter({
      ...(config.endpointOverride ? { url: config.endpointOverride } : {}),
      ...(Object.keys(config.headersOverride).length ? { headers: config.headersOverride } : {}),
    });

    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName }),
      // Sampling is decided in emit() (so failures/blocks and sampled parents are
      // never dropped), so the SDK sampler is always-on.
      sampler: new AlwaysOnSampler(),
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          maxQueueSize: 2048,
          maxExportBatchSize: 512,
          scheduledDelayMillis: 5000,
          exportTimeoutMillis: 30000,
        }),
      ],
      // Hard backstop against oversized content attributes (collectors drop big spans).
      spanLimits: { attributeValueLengthLimit: config.contentMaxChars, attributeCountLimit: 96 },
    });

    // Deliberately NOT provider.register() — we hold a provider-local tracer and
    // never install a global context manager or propagator, so nothing else in the
    // process is affected by tracing being on.
    const tracer = provider.getTracer("arbr-control-plane");
    _sdk = { api, provider, tracer };
  } catch (err) {
    console.error("[telemetry] init failed, tracing disabled:", err.message);
    _sdk = null;
  }
}

function isEnabled() {
  return !!_sdk;
}

// emit(record, { traceparent }) — synchronous, and never throws into the caller.
function emit(record, ctx = {}) {
  if (!_sdk) return;
  try {
    const parent = parseTraceparent(ctx.traceparent);
    if (!attrs.shouldSample(record, parent, config.sampleRatio)) return;
    const { api, tracer } = _sdk;

    // Anchor to ROOT_CONTEXT (we're in a detached setImmediate with no meaningful
    // ambient context). Parent to the caller's span when a traceparent is present,
    // so the LLM call nests inside their distributed trace; otherwise a root span.
    let context = api.ROOT_CONTEXT;
    if (parent) {
      context = api.trace.setSpanContext(api.ROOT_CONTEXT, {
        traceId: parent.traceId,
        spanId: parent.spanId,
        traceFlags: parent.sampled ? api.TraceFlags.SAMPLED : api.TraceFlags.NONE,
        isRemote: true,
      });
    }

    const { startMs, endMs } = attrs.timing(record);
    const span = tracer.startSpan(
      attrs.spanName(record),
      {
        kind: api.SpanKind.CLIENT,
        startTime: startMs,
        attributes: attrs.attributesFor(record, {
          captureContent: config.captureContent,
          contentMaxChars: config.contentMaxChars,
        }),
      },
      context,
    );

    const st = attrs.spanStatus(record);
    if (st.code === "ERROR") {
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: st.message });
      const et = attrs.errorType(record);
      if (et) span.setAttribute("error.type", et);
    }
    span.end(endMs);
  } catch (err) {
    const now = Date.now();
    if (now - _lastErrAt > 60_000) {
      console.error("[telemetry] emit failed:", err.message);
      _lastErrAt = now;
    }
  }
}

async function forceFlush() {
  if (!_sdk) return;
  try { await _sdk.provider.forceFlush(); } catch { /* best effort */ }
}

async function shutdown() {
  if (!_sdk) return;
  const p = _sdk;
  _sdk = null;
  try { await p.provider.shutdown(); } catch { /* best effort */ }
}

module.exports = { init, isEnabled, emit, forceFlush, shutdown };
