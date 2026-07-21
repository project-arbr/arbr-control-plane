# OpenTelemetry tracing

Arbr can export one **OpenTelemetry trace span per gateway request**, parented to the
calling application's own distributed trace. Point your apps at the gateway and every LLM
call shows up inline in the traces you already have — Grafana Tempo, Jaeger, Datadog,
Honeycomb, whatever you run — with **no application code changes**, because the gateway
does the emitting.

It is **off by default**. When disabled, the OpenTelemetry SDK is never even loaded, so it
costs nothing to leave off.

## Enable it

```sh
# .env
ARBR_OTEL_ENABLED=true
ARBR_OTEL_ENDPOINT=http://your-collector:4318/v1/traces
```

That is the minimum. On boot the banner confirms it:

```
  tracing:     OTLP → http://your-collector:4318/v1/traces (sample 1)
```

## How trace context works

Arbr reads the incoming **W3C `traceparent`** header off each gateway request and makes its
span a child of the caller's span. So if your application is already instrumented, the LLM
call nests inside the same trace as the surrounding work:

```
your-app: POST /checkout            ← your span
  └─ arbr: chat gpt-4o-mini         ← Arbr emits this, in the same trace
       gen_ai.request.model = auto
       gen_ai.response.model = gpt-4o-mini
       arbr.routing.decision = ai
```

If a request has no `traceparent`, Arbr emits a root span instead, so nothing is lost.

## Configuration

Every variable except the master switch falls back to the standard `OTEL_*` name, so Arbr
drops into an already-instrumented cluster using the environment your platform already sets.

| Variable | Default | Purpose |
|---|---|---|
| `ARBR_OTEL_ENABLED` | `false` | Master switch. Never falls back (see the warning below). |
| `ARBR_OTEL_ENDPOINT` | `http://localhost:4318/v1/traces` | Full traces endpoint. Falls back to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, then `OTEL_EXPORTER_OTLP_ENDPOINT`. |
| `ARBR_OTEL_HEADERS` | none | Exporter headers (e.g. a vendor key), as `key1=val1,key2=val2`. Falls back to `OTEL_EXPORTER_OTLP_HEADERS`. |
| `ARBR_OTEL_SERVICE_NAME` | `arbr-control-plane` | Falls back to `OTEL_SERVICE_NAME`. |
| `ARBR_OTEL_SAMPLE_RATIO` | `1` | Head sampling, 0 to 1. Failures and caller-sampled traces are always kept. |
| `ARBR_OTEL_CAPTURE_CONTENT` | `false` | Put prompt/response text on spans. Also requires payload capture to be on. |
| `ARBR_OTEL_CONTENT_MAX_CHARS` | `8192` | Per-attribute clamp on captured content. |

::: warning Do not set `OTEL_ENABLED`
The master switch is `ARBR_OTEL_ENABLED`, deliberately **not** `OTEL_ENABLED`. That variable
also switches `@langchain/core` into its own LangSmith-OTel tracing mode, so Arbr never reads
it and warns at boot if it finds it set. Installing the OpenTelemetry packages by itself
activates nothing.
:::

## What's on a span

- **GenAI conventions:** `gen_ai.operation.name`, `gen_ai.system` / `gen_ai.provider.name`,
  `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.usage.input_tokens` /
  `output_tokens`, and `gen_ai.usage.cost`.
- **Arbr specifics:** `arbr.routing.decision`, `arbr.task_type`, `arbr.classified_by`,
  `arbr.difficulty`, `arbr.cache.hit`, `arbr.cost.total_usd`, `arbr.latency_ms`,
  `arbr.status`, and more.
- **Status:** a successful call leaves the span status unset; a failure or a budget block
  sets `ERROR` with a normalized `error.type`.

The span is named `{operation} {served-model}` (for example `chat gpt-4o-mini`), using the
model actually served rather than `auto`.

Sampling is decided per request so a caller's sampled trace is never left with a hole, and
failures and budget blocks are never dropped even at a low sample ratio.

## Test it locally

Run a collector (Jaeger's all-in-one exposes OTLP on 4318 and a UI on 16686):

```sh
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one
```

Start Arbr with tracing on, then send a request carrying a `traceparent`:

```sh
curl -X POST http://localhost:4100/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'traceparent: 00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01' \
  -d '{ "application": "demo", "model": "auto",
        "messages": [{ "role": "user", "content": "hello" }] }'
```

Open the Jaeger UI at `http://localhost:16686` and find the trace by that id. The Arbr span
appears under it, named for the served model and carrying the `gen_ai.*` and `arbr.*`
attributes.

## Known limitations

Span duration is Arbr's measured `latencyMs`, not full gateway end-to-end time. Requests
rejected before routing (maintenance mode, a per-app kill switch, demo mode) write no record
and so emit no span. The export queue is per-process and in-memory; a graceful shutdown
(SIGTERM) flushes it, but an ungraceful kill can drop queued spans. See the
[architecture notes](https://github.com/project-arbr/arbr-control-plane/blob/main/ARCHITECTURE.md)
for the full list.
