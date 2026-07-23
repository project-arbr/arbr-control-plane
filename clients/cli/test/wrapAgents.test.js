"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { patchCodexConfig } = require("../src/wrapAgents");

// Every test here operates on a throwaway temp directory — never the real
// ~/.codex — so this suite can never touch a developer's actual Codex config.
function tempConfigPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbr-cli-codex-test-"));
  return path.join(dir, "config.toml");
}

test("patchCodexConfig backs up and can restore an existing config unchanged", () => {
  const configPath = tempConfigPath();
  const original = [
    'model = "gpt-5.6-sol"',
    'model_reasoning_effort = "high"',
    "",
    '[projects."/some/path"]',
    'trust_level = "trusted"',
    "",
  ].join("\n");
  fs.writeFileSync(configPath, original);

  const { restore, backupPath } = patchCodexConfig(configPath, 54321);

  assert.ok(fs.existsSync(backupPath));
  assert.equal(fs.readFileSync(backupPath, "utf8"), original);

  const patched = fs.readFileSync(configPath, "utf8");
  assert.match(patched, /model_provider = "arbr_wrap"/);
  assert.match(patched, /\[model_providers\.arbr_wrap\]/);
  assert.match(patched, /base_url = "http:\/\/127\.0\.0\.1:54321\/v1"/);
  // The root-level override must land BEFORE the first [section], not after —
  // appending it after an existing [section] would silently belong to that
  // section instead of the root table in real TOML.
  const providerLine = patched.indexOf('model_provider = "arbr_wrap"');
  const firstSection = patched.indexOf('[projects');
  assert.ok(providerLine < firstSection, "model_provider must precede the first [section]");
  // Original content must still be present, untouched.
  assert.match(patched, /model = "gpt-5\.6-sol"/);
  assert.match(patched, /trust_level = "trusted"/);

  restore();
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
});

test("patchCodexConfig replaces a pre-existing model_provider line instead of duplicating it", () => {
  const configPath = tempConfigPath();
  const original = 'model_provider = "openai"\nmodel = "gpt-5"\n';
  fs.writeFileSync(configPath, original);

  const { restore } = patchCodexConfig(configPath, 1234);
  const patched = fs.readFileSync(configPath, "utf8");
  const matches = patched.match(/model_provider\s*=/g) || [];
  assert.equal(matches.length, 1, "must not leave two model_provider keys");
  assert.match(patched, /model_provider = "arbr_wrap"/);

  restore();
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
});

test("patchCodexConfig creates then fully removes a config that didn't exist before", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "arbr-cli-codex-test-"));
  const configPath = path.join(dir, "config.toml");
  assert.ok(!fs.existsSync(configPath));

  const { restore, backupPath } = patchCodexConfig(configPath, 999);
  assert.ok(fs.existsSync(configPath));
  assert.equal(backupPath, null); // nothing to back up if there was no original file

  restore();
  assert.ok(!fs.existsSync(configPath), "restore must remove a file arbr created from nothing");
});

test("patchCodexConfig handles a config with no [section] headers at all", () => {
  const configPath = tempConfigPath();
  const original = 'model = "gpt-5"\n';
  fs.writeFileSync(configPath, original);

  const { restore } = patchCodexConfig(configPath, 4321);
  const patched = fs.readFileSync(configPath, "utf8");
  assert.match(patched, /model_provider = "arbr_wrap"/);
  assert.match(patched, /\[model_providers\.arbr_wrap\]/);

  restore();
  assert.equal(fs.readFileSync(configPath, "utf8"), original);
});
