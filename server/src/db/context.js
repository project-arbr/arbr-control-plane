// Request-scoped database context — the P0 seam that lets the hosted layer (arbr-cloud) serve
// many accounts from ONE process by giving each request its own Mongo connection
// (database-per-tenant), while the open-source single-tenant product is completely unchanged.
//
// How it stays a no-op for OSS: model access resolves against `currentConnection()`, which is the
// single global mongoose connection UNLESS a caller has explicitly entered `runWithConnection(conn)`.
// OSS never enters one, so every model uses the global connection exactly as before. Only the cloud
// request middleware wraps a request in a per-tenant connection.
//
// Nothing here is wired into the default boot path — a model must opt in via `defineModel()`
// (done in the follow-up migration). This module only provides the primitives, and is safe to add.
"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const mongoose = require("mongoose");

const _als = new AsyncLocalStorage();

// The connection the current request's model access should use. Falls back to the global
// mongoose connection when no per-request connection is active (OSS, background jobs, boot).
function currentConnection() {
  return _als.getStore() || mongoose.connection;
}

// Run `fn` (and everything it awaits) with `conn` as the request-scoped connection.
function runWithConnection(conn, fn) {
  return _als.run(conn, fn);
}

// The model for `name`, compiled on whatever connection is current, cached per connection
// (mongoose caches compiled models on the connection, so this is a lookup after first use).
function modelForCurrent(name, schema) {
  const conn = currentConnection();
  return conn.models[name] || conn.model(name, schema);
}

// Drop-in replacement for `mongoose.model(name, schema)` inside a model module. Returns a Proxy
// that forwards every access to the CURRENT connection's model — so existing call sites
// (`const X = require("../models/X"); X.findOne(...)`) become request-scoped with no change.
//   - statics/query helpers keep `this === Model` (bound in the get trap),
//   - `new Model()` works (construct trap),
//   - `Model(...)` as a function works (apply trap),
//   - `doc instanceof Model` works (getPrototypeOf trap).
function defineModel(name, schema) {
  // Eagerly compile on the connection current at module-load time — the GLOBAL connection in OSS
  // and in every existing test. This matches the old `mongoose.model(name, schema)` timing exactly,
  // so index builds (e.g. NotificationDedup's unique dedup index) start at require-time and are not
  // raced by code that relies on them right after first use. Per-tenant connections still compile
  // lazily on their first access.
  modelForCurrent(name, schema);
  const handler = {
    get(_t, prop) {
      const M = modelForCurrent(name, schema);
      const v = M[prop];
      return typeof v === "function" ? v.bind(M) : v;
    },
    set(_t, prop, value) {
      modelForCurrent(name, schema)[prop] = value;
      return true;
    },
    has(_t, prop) {
      return prop in modelForCurrent(name, schema);
    },
    construct(_t, args) {
      const M = modelForCurrent(name, schema);
      return new M(...args);
    },
    apply(_t, _thisArg, args) {
      const M = modelForCurrent(name, schema);
      return M(...args);
    },
    getPrototypeOf() {
      return Object.getPrototypeOf(modelForCurrent(name, schema));
    },
  };
  // The Proxy target is a function so the construct/apply traps are permitted.
  return new Proxy(function () {}, handler);
}

module.exports = { currentConnection, runWithConnection, modelForCurrent, defineModel, _als };
