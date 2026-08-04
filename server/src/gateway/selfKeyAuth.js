// Express middleware for self-service key management (/v1/key/*). The presented key
// authenticates itself (proof of possession); the request may then view, rotate, or
// revoke ONLY that key. Works for both gateway keys and read tokens.
const auth = require("./auth");

async function middleware(req, res, next) {
  try {
    req.selfKey = await auth.resolveAnyKey(req.headers.authorization || "");
    return next();
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: "invalid_key", message: err.message });
    }
    return next(err);
  }
}

module.exports = { middleware };
