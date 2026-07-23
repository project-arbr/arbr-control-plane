"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

// --- claude: pure env-var redirection, no file touched. -------------------------
// Documented by Anthropic (code.claude.com/docs/en/llm-gateway-connect):
// ANTHROPIC_BASE_URL redirects every outbound call; the existing credential
// (OAuth session from `claude login`, or ANTHROPIC_API_KEY if set) is sent to that
// URL unchanged, which is why the proxy can just forward whatever auth header
// arrives rather than minting its own.
function launchClaude(port) {
  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}` };
  return spawn("claude", [], { stdio: "inherit", env });
}

// --- opencode: pure env-var redirection, no file touched. ------------------------
// OpenCode has no ANTHROPIC_BASE_URL-style override of its default provider; it
// takes an entirely new provider via config. OPENCODE_CONFIG_CONTENT (inline JSON)
// injects one at launch without writing anything to disk. Caveat, confirmed by
// research (opencode.ai/docs/config + anomalyco/opencode#13219): this content mode
// skips {env:}/{file:} substitution, so the API key must be a literal value in the
// generated JSON — it lives only in the child process's environment, never on disk.
// This also means the wrapped session is NOT a transparent redirect: the user must
// select a model under the injected `arbr/<model-id>` namespace for traffic to
// actually flow through the proxy. v1 only wires up an OpenAI-backed model list;
// see README for that limitation.
function launchOpenCode(port) {
  const apiKey = process.env.OPENAI_API_KEY || "arbr-local-placeholder";
  const config = {
    provider: {
      arbr: {
        npm: "@ai-sdk/openai-compatible",
        name: "Arbr (local wrap proxy)",
        options: { baseURL: `http://127.0.0.1:${port}/v1` },
        apiKey,
        models: {
          "gpt-4o": {}, "gpt-4o-mini": {},
        },
      },
    },
  };
  console.log('In the OpenCode session, select a model under "arbr/" (e.g. "arbr/gpt-4o-mini") to route it through Arbr — other providers are not observed in this session.');
  const env = { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) };
  return spawn("opencode", [], { stdio: "inherit", env });
}

// --- codex: no confirmed env-var override; needs a config.toml edit. ------------
// UNVERIFIED against a real Codex CLI install (see clients/cli/README.md) — a past
// GitHub issue reported config.toml overrides not being respected in an older
// version. Implemented defensively: back up the original file to a sibling
// timestamped path *and* keep it in memory, patch only the minimum needed (root-level
// `model_provider` key + a freshly-appended `[model_providers.arbr_wrap]` table —
// appending a whole new table is always TOML-safe; inserting a bare key is NOT safe
// after any `[section]` header has already opened, hence the root/rest split below),
// and restore unconditionally in a `finally` plus SIGINT/SIGTERM handlers so a killed
// process can't leave the user's real config patched.
function patchCodexConfig(configPath, port) {
  const existed = fs.existsSync(configPath);
  const original = existed ? fs.readFileSync(configPath, "utf8") : "";

  let backupPath = null;
  if (existed) {
    backupPath = `${configPath}.arbr-backup-${Date.now()}`;
    fs.writeFileSync(backupPath, original);
  }

  const lines = existed ? original.split("\n") : [];
  const firstSectionIdx = lines.findIndex((l) => /^\s*\[/.test(l));
  const rootLines = firstSectionIdx === -1 ? lines : lines.slice(0, firstSectionIdx);
  const restLines = firstSectionIdx === -1 ? [] : lines.slice(firstSectionIdx);

  const filteredRoot = rootLines.filter((l) => !/^\s*model_provider\s*=/.test(l));
  const newRoot = [...filteredRoot, 'model_provider = "arbr_wrap"'];

  const patched =
    [...newRoot, ...restLines].join("\n") +
    "\n\n[model_providers.arbr_wrap]\n" +
    'name = "Arbr (local wrap proxy)"\n' +
    `base_url = "http://127.0.0.1:${port}/v1"\n` +
    'env_key = "ARBR_WRAP_KEY"\n' +
    'wire_api = "chat"\n';

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, patched);

  const restore = () => {
    if (existed) fs.writeFileSync(configPath, original);
    else if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
  };
  return { restore, backupPath };
}

function launchCodex(port, { codexHome } = {}) {
  const configPath = path.join(codexHome || path.join(os.homedir(), ".codex"), "config.toml");
  const { restore, backupPath } = patchCodexConfig(configPath, port);

  const cleanup = () => {
    try { restore(); } catch (err) {
      console.error(`arbr wrap: failed to restore ${configPath} — recover manually from ${backupPath}: ${err.message}`);
    }
  };
  const onSignal = () => { cleanup(); process.exit(1); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const env = { ...process.env, ARBR_WRAP_KEY: process.env.OPENAI_API_KEY || "" };
  const child = spawn("codex", [], { stdio: "inherit", env });
  child.on("exit", () => {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    cleanup();
  });
  return child;
}

// --- cursor: no automation path today (confirmed: Cursor CLI's --endpoint/--api-key
// flags are reported broken; headroom's own README independently marks Cursor as
// manual-only for the same reason). Print instructions instead of spawning anything.
function printCursorInstructions(port) {
  console.log(`
Cursor's CLI doesn't currently support redirecting its API traffic reliably, so
this can't be automated the way Claude Code/Codex/OpenCode are. To route Cursor's
IDE traffic through Arbr manually:

  1. Open Cursor → Settings → Models → "Override OpenAI Base URL"
  2. Set it to: http://127.0.0.1:${port}/v1
  3. Use Cursor as normal — this proxy stays running and reports stats on Ctrl-C.
`);
}

module.exports = { launchClaude, launchOpenCode, launchCodex, patchCodexConfig, printCursorInstructions };
