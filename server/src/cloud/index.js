// mountCore — the entry point the hosted layer (arbr-cloud) uses to run the open-source core
// in-process with per-tenant hooks injected. Returns the full Express app (gateway + admin +
// dashboard). The caller mounts it AFTER its own auth middleware (which sets req.account, read by
// resolveTenantDb) and owns HTTP listening / Mongo connections.
//
// In OSS the core boots via `node src/index.js` (start()), which calls buildApp() with the
// single-tenant defaults — this module is only used by the commercial layer.
"use strict";
const { buildApp } = require("../index");

function mountCore({ resolveTenantDb, entitlements } = {}) {
  return buildApp({ resolveTenantDb, entitlements });
}

module.exports = { mountCore };
