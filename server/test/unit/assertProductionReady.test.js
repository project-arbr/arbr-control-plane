"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

// config.js loads dotenv and freezes env at require-time for some fields;
// we re-require after mutating NODE_ENV / keys carefully.
function loadConfig() {
  delete require.cache[require.resolve("../../src/config")];
  return require("../../src/config");
}

const orig = {
  NODE_ENV: process.env.NODE_ENV,
  ARBR_ADMIN_KEY: process.env.ARBR_ADMIN_KEY,
  ARBR_ENCRYPTION_KEY: process.env.ARBR_ENCRYPTION_KEY,
};

after(() => {
  if (orig.NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = orig.NODE_ENV;
  if (orig.ARBR_ADMIN_KEY === undefined) delete process.env.ARBR_ADMIN_KEY;
  else process.env.ARBR_ADMIN_KEY = orig.ARBR_ADMIN_KEY;
  if (orig.ARBR_ENCRYPTION_KEY === undefined) delete process.env.ARBR_ENCRYPTION_KEY;
  else process.env.ARBR_ENCRYPTION_KEY = orig.ARBR_ENCRYPTION_KEY;
  delete require.cache[require.resolve("../../src/config")];
});

test("assertProductionReady is a no-op outside production", () => {
  process.env.NODE_ENV = "development";
  delete process.env.ARBR_ADMIN_KEY;
  delete process.env.ARBR_ENCRYPTION_KEY;
  const { assertProductionReady } = loadConfig();
  assert.doesNotThrow(() => assertProductionReady());
});

test("assertProductionReady fails closed without admin + encryption keys", () => {
  process.env.NODE_ENV = "production";
  delete process.env.ARBR_ADMIN_KEY;
  delete process.env.ARBR_ENCRYPTION_KEY;
  const { assertProductionReady } = loadConfig();
  assert.throws(() => assertProductionReady(), /ARBR_ADMIN_KEY/);
});

test("assertProductionReady passes when both secrets set", () => {
  process.env.NODE_ENV = "production";
  process.env.ARBR_ADMIN_KEY = "test-admin-key";
  process.env.ARBR_ENCRYPTION_KEY = "test-enc-key-not-for-prod";
  const { assertProductionReady } = loadConfig();
  assert.doesNotThrow(() => assertProductionReady());
});
