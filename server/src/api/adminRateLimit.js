// Rate limit for the admin API (/api/*). Mirrors the data-plane global RPM
// guardrail (gateway/auth.js) using the same Mongo-backed, multi-replica-safe
// counter (routing/rateLimit.js). Keyed by source IP rather than the admin
// key itself: the admin surface shares one credential, so per-key limiting
// wouldn't distinguish callers — this exists to blunt DB-hammering (an
// accidental loop, a leaked key), not to throttle normal dashboard use.
const { overRpmLimit } = require("../routing/rateLimit");
const { config } = require("../config");

async function middleware(req, res, next) {
  try {
    if (await overRpmLimit(`admin-ip:${req.ip}`, config.adminRpmGuardrail)) {
      return res.status(429).json({
        error: "rate_limited",
        message: `Admin API rate limit of ${config.adminRpmGuardrail} req/min reached for this source.`,
      });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { middleware };
