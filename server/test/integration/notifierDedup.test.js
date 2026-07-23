"use strict";
// Cross-replica dedup coverage for the webhook notifier. Before this fix,
// `recentlySent` was an in-memory Map — two replicas (or two concurrent calls
// racing on the same process) could each decide independently that a
// cap_breach webhook hadn't fired recently and both send it. The fix moves
// the claim to an atomic Mongo insert (NotificationDedup, unique on
// dedupKey), so exactly one caller wins regardless of how many "replicas"
// (simulated here as concurrent calls) race for the same event+key.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { MongoMemoryServer } = require("mongodb-memory-server");
const mongoose = require("mongoose");

const Settings = require("../../src/models/Settings");
const NotificationDedup = require("../../src/models/NotificationDedup");
const { notify } = require("../../src/routing/notifier");

let mongod;
let originalFetch;
let sendCount;

before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

after(async () => {
  global.fetch = originalFetch;
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Settings.deleteMany({});
  await NotificationDedup.deleteMany({});
  await Settings.create({ webhookUrl: "https://example.test/webhook" });
  sendCount = 0;
  originalFetch = global.fetch;
  global.fetch = async () => {
    sendCount += 1;
    return { ok: true };
  };
});

test("concurrent notify() calls for the same event+key send exactly once", async () => {
  const payload = { key: "cap-123:month:2026-07" };
  await Promise.all([
    notify("cap_breach", payload),
    notify("cap_breach", payload),
    notify("cap_breach", payload),
    notify("cap_breach", payload),
    notify("cap_breach", payload),
  ]);
  assert.equal(sendCount, 1);
});

test("different keys are not deduped against each other", async () => {
  await Promise.all([
    notify("cap_breach", { key: "cap-A:month:2026-07" }),
    notify("cap_breach", { key: "cap-B:month:2026-07" }),
  ]);
  assert.equal(sendCount, 2);
});

test("a later call within the window is still suppressed (sequential, not just racing)", async () => {
  const payload = { key: "cap-999:month:2026-07" };
  await notify("cap_breach", payload);
  await notify("cap_breach", payload);
  assert.equal(sendCount, 1);
});
