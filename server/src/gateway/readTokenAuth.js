// Express middleware for the scoped, read-only usage API (/v1/usage/*).
//
// Validates a "read" token and attaches its forced analytics scope to the request:
//   req.readScope = { application, userId }
// The scope comes from the token (set at creation, trusted), never from the request,
// so a token can only ever read its own application (+ optional user). This is what
// lets a partner app expose per-end-user usage without the admin key.
const auth = require("./auth");

async function middleware(req, res, next) {
  try {
    const doc = await auth.resolveReadToken(req.headers.authorization || "");
    req.readScope = { application: doc.application, userId: doc.userId || null };
    req.readToken = doc;
    return next();
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: "invalid_read_token", message: err.message });
    }
    return next(err);
  }
}

module.exports = { middleware };
