"use strict";
// MONGO_URI can embed credentials (mongodb://user:pass@host/db) — describe()
// must never print them verbatim (flagged by CodeQL's clear-text-logging
// query once config.js's boot summary was touched for F-04).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { maskMongoUri } = require("../../src/config");

test("masks the password in a credentialed URI", () => {
  assert.equal(
    maskMongoUri("mongodb://dbuser:s3cr3t@cluster0.example.mongodb.net/arbr"),
    "mongodb://dbuser:****@cluster0.example.mongodb.net/arbr"
  );
});

test("leaves a plain, credential-free URI unchanged", () => {
  assert.equal(
    maskMongoUri("mongodb://localhost:27017/arbr-control-plane"),
    "mongodb://localhost:27017/arbr-control-plane"
  );
});

test("masks a mongodb+srv URI the same way", () => {
  assert.equal(
    maskMongoUri("mongodb+srv://admin:hunter2@cluster0.example.mongodb.net/arbr"),
    "mongodb+srv://admin:****@cluster0.example.mongodb.net/arbr"
  );
});
