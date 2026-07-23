"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseCsv, fetchRemoteRecords } = require("../src/remote");

test("parseCsv handles a plain header + rows", () => {
  const csv = "a,b,c\n1,2,3\n4,5,6\n";
  const rows = parseCsv(csv);
  assert.deepEqual(rows, [{ a: "1", b: "2", c: "3" }, { a: "4", b: "5", c: "6" }]);
});

test("parseCsv handles quoted fields with embedded commas and escaped quotes", () => {
  const csv = 'taskType,application\n"classification","acme, inc."\n"say ""hi""",plain\n';
  const rows = parseCsv(csv);
  assert.deepEqual(rows, [
    { taskType: "classification", application: "acme, inc." },
    { taskType: 'say "hi"', application: "plain" },
  ]);
});

test("parseCsv returns an empty array for an empty or header-only export", () => {
  assert.deepEqual(parseCsv(""), []);
  assert.deepEqual(parseCsv("a,b,c\n"), []);
});

test("fetchRemoteRecords hits /api/requests/export with a Bearer admin key and coerces numeric fields", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  let capturedUrl, capturedHeaders;
  global.fetch = async (url, init) => {
    capturedUrl = url;
    capturedHeaders = init.headers;
    const csv = "taskType,model,provider,promptTokens,completionTokens,totalCost\n" +
      "classification,claude-opus-4-8,anthropic,500,100,0.0075\n";
    return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
  };

  const records = await fetchRemoteRecords("https://arbr.gyde.ai", "sk-test-key", { from: "2026-07-01", to: "2026-07-23" });

  assert.equal(capturedUrl.pathname, "/api/requests/export");
  assert.equal(capturedUrl.searchParams.get("from"), "2026-07-01");
  assert.equal(capturedUrl.searchParams.get("to"), "2026-07-23");
  assert.equal(capturedHeaders.authorization, "Bearer sk-test-key");

  assert.equal(records.length, 1);
  assert.equal(records[0].taskType, "classification");
  assert.equal(records[0].promptTokens, 500);
  assert.equal(records[0].completionTokens, 100);
  assert.equal(records[0].totalCost, 0.0075);
});

test("fetchRemoteRecords throws a readable error on a non-2xx response", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async () => new Response("unauthorized", { status: 401 });

  await assert.rejects(
    () => fetchRemoteRecords("https://arbr.gyde.ai", "wrong-key"),
    /401/
  );
});

test("fetchRemoteRecords throws a readable error when the host is unreachable", async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });

  global.fetch = async () => { throw new Error("ECONNREFUSED"); };

  await assert.rejects(
    () => fetchRemoteRecords("https://nope.invalid", "key"),
    /could not reach/
  );
});
