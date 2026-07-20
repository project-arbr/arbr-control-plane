// Rate limit for the admin API (/api/*), keyed by source IP rather than the
// admin key itself: the admin surface shares one credential, so per-key
// limiting wouldn't distinguish callers. Exists to blunt DB-hammering (an
// accidental loop, a leaked key), not to throttle normal dashboard use.
//
// Uses express-rate-limit (in-memory, per-process) rather than the app's
// Mongo-backed data-plane limiter (routing/rateLimit.js): the admin surface
// is comparatively low-volume and already documented elsewhere as
// single-instance by design, so per-process accuracy is an acceptable
// trade-off for the standard, well-recognized middleware here.
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { config } = require("../config");

const middleware = rateLimit({
  windowMs: 60_000,
  limit: () => config.adminRpmGuardrail, // read live so tests/env can adjust it
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  handler: (req, res) => {
    res.status(429).json({
      error: "rate_limited",
      message: `Admin API rate limit of ${config.adminRpmGuardrail} req/min reached for this source.`,
    });
  },
});

module.exports = { middleware };
