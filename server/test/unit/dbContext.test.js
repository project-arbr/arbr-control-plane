"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const { currentConnection, runWithConnection, defineModel } = require("../../src/db/context");

// A fake mongoose-like connection: model(name) returns a class with statics, cached per connection.
function makeFakeConn(tag) {
  const conn = { tag, models: {} };
  conn.model = (name) => {
    if (conn.models[name]) return conn.models[name];
    const M = class {
      constructor(doc) { this.doc = doc; this.conn = tag; }
      static whoAmI() { return this === M ? tag : "WRONG_THIS"; } // proves `this === Model`
      static find() { return `${tag}:${name}:find`; }
    };
    conn.models[name] = M;
    return M;
  };
  return conn;
}

test("currentConnection defaults to the global mongoose connection (OSS behavior)", () => {
  assert.equal(currentConnection(), mongoose.connection);
});

test("runWithConnection scopes currentConnection for the duration", () => {
  const a = makeFakeConn("A");
  runWithConnection(a, () => assert.equal(currentConnection(), a));
  // ...and reverts outside.
  assert.equal(currentConnection(), mongoose.connection);
});

test("defineModel resolves to the current connection's model, isolating per connection", () => {
  const Thing = defineModel("Thing", { fake: true });
  runWithConnection(makeFakeConn("A"), () => {
    assert.equal(Thing.find(), "A:Thing:find");
    assert.equal(Thing.whoAmI(), "A");       // static's `this` is the real model, not the proxy
  });
  runWithConnection(makeFakeConn("B"), () => {
    assert.equal(Thing.find(), "B:Thing:find"); // same require(), different DB — the isolation core
  });
});

test("defineModel caches the model within a connection", () => {
  const Thing = defineModel("Thing", { fake: true });
  const conn = makeFakeConn("C");
  runWithConnection(conn, () => {
    const first = Thing.find();
    const second = Thing.find();
    assert.equal(first, second);
    assert.equal(Object.keys(conn.models).length, 1); // compiled once, reused
  });
});

test("defineModel supports `new Model(doc)` via the construct trap", () => {
  const Thing = defineModel("Thing", { fake: true });
  runWithConnection(makeFakeConn("D"), () => {
    const doc = new Thing({ x: 1 });
    assert.deepEqual(doc.doc, { x: 1 });
    assert.equal(doc.conn, "D");
  });
});

test("async work inside runWithConnection keeps the scoped connection across awaits", async () => {
  const a = makeFakeConn("A2");
  await runWithConnection(a, async () => {
    await Promise.resolve();
    assert.equal(currentConnection(), a);
  });
});
