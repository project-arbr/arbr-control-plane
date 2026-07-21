// W3C Trace Context parsing. Pure and dependency-free, so it unit-tests without
// loading the OpenTelemetry SDK.
//
//   traceparent = version "-" trace-id "-" parent-id "-" trace-flags
//     version:     2 hex   (ff is reserved / invalid)
//     trace-id:   32 hex   (must not be all zero)
//     parent-id:  16 hex   (must not be all zero)
//     trace-flags: 2 hex   (bit 0 = sampled)
const RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "00000000000000000000000000000000";
const ZERO_SPAN = "0000000000000000";

// Returns { traceId, spanId, traceFlags, sampled } or null if absent / malformed.
function parseTraceparent(header) {
  if (!header || typeof header !== "string") return null;
  const m = RE.exec(header.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, spanId, flags] = m;
  if (version === "ff") return null;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  const traceFlags = parseInt(flags, 16);
  return { traceId, spanId, traceFlags, sampled: (traceFlags & 0x1) === 1 };
}

module.exports = { parseTraceparent };
