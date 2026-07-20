// Identity endpoints — mounted OUTSIDE adminAuth.middleware (see index.js)
// since /login and /callback must be reachable before a session exists.
// /mode and /me are read-only and safe to expose unauthenticated.
const express = require("express");
const router = express.Router();
const { config } = require("../../config");
const identity = require("../identity");
const oidcRouter = require("../authProviders/oidc");

router.get("/mode", (_req, res) => {
  res.json({ mode: config.authMode });
});

router.get("/me", async (req, res, next) => {
  try {
    const user = await identity.resolveUser(req);
    res.json({ user });
  } catch (err) {
    next(err);
  }
});

router.use(oidcRouter);

module.exports = router;
