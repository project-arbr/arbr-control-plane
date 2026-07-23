#!/usr/bin/env node
"use strict";

const path = require("path");
const fs = require("fs");
const { runAudit } = require("../src/audit");
const { renderReport } = require("../src/report");
const { runWrapSession } = require("../src/wrap");

const HELP = `arbr — audit a log of past LLM requests, or wrap a coding agent live.

Usage:
  arbr audit <file.jsonl> [--out <report.html>] [--cheap-task-types a,b,c]
  arbr audit --demo [--out <report.html>]
  arbr wrap <claude|codex|opencode|cursor> [--out <report.html>] [--codex-home <path>]

Audit options:
  --out <path>              where to write the HTML report (default: ./arbr-audit-report.html)
  --cheap-task-types <csv>  comma-separated task types to treat as "should be cheap"
                             (default: classification, extraction, summarisation,
                             translation, faq, support response)
  --demo                    run against the bundled sample log instead of a file

Wrap options:
  --out <path>       where to write the HTML report (default: ./arbr-wrap-report.html)
  --codex-home <path> override ~/.codex for the wrapped session (codex only)

  -h, --help                show this help

Audit input format: one JSON object per line (JSONL), reusing Arbr's own request-log
field names — taskType, model, provider, promptTokens, completionTokens, totalCost.
If you already run Arbr, export your RequestRecord collection into this shape for a
real audit. See README.md for the full field list and an export example.

Wrap reports spend and model mix only (no task classification yet, so no
premium-overuse recommendations — use \`arbr audit\` on a classified log for those).
Claude Code and Codex are wrapped transparently; OpenCode requires selecting a model
under the injected "arbr/" provider in-session; Cursor's CLI has no reliable
redirect today, so it prints manual IDE setup instructions instead. See README.md.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--cheap-task-types") args.cheapTaskTypes = argv[++i];
    else if (a === "--codex-home") args.codexHome = argv[++i];
    else if (a === "--demo") args.demo = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else args._.push(a);
  }
  return args;
}

function printSummary(result) {
  const { totalRequests, totalCost, recommendations, flaggedSavings, overusePct } = result;
  console.log(`Analyzed ${totalRequests.toLocaleString()} requests, $${totalCost.toFixed(2)} total spend.`);
  if (recommendations.length === 0) {
    console.log("No premium-model overuse found (or not enough volume yet in any one group).");
    return;
  }
  console.log(`Found $${flaggedSavings.toFixed(2)} in projected savings (${Math.round(overusePct)}% of spend).`);
  console.log("");
  for (const r of recommendations.slice(0, 5)) {
    console.log(`  ${r.title} — switch to ${r.suggestedModel}, save $${r.projectedSavings.toFixed(2)}`);
  }
  if (recommendations.length > 5) {
    console.log(`  ...and ${recommendations.length - 5} more (see the full report).`);
  }
}

function printWrapSummary(result) {
  const { totalRequests, totalCost, groups } = result;
  console.log(`\nSession done: ${totalRequests.toLocaleString()} requests, $${totalCost.toFixed(2)} total spend.`);
  const byModel = new Map();
  for (const g of groups) {
    const m = byModel.get(g.model) || { requests: 0, cost: 0 };
    m.requests += g.requests; m.cost += g.currentCost;
    byModel.set(g.model, m);
  }
  for (const [model, m] of [...byModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(`  ${model}: ${m.requests.toLocaleString()} requests, $${m.cost.toFixed(2)}`);
  }
}

async function runAuditCommand(rest) {
  const args = parseArgs(rest);
  if (args.help) { console.log(HELP); process.exit(0); }

  const inputPath = args.demo
    ? path.join(__dirname, "..", "fixtures", "sample.jsonl")
    : args._[0];

  if (!inputPath) {
    console.error("Error: provide a log file, e.g. `arbr audit my-export.jsonl`, or use --demo.\n");
    console.log(HELP);
    process.exit(1);
  }
  if (!args.demo && !fs.existsSync(inputPath)) {
    console.error(`Error: file not found: ${inputPath}`);
    process.exit(1);
  }

  const opts = {};
  if (args.cheapTaskTypes) opts.cheapTaskTypes = args.cheapTaskTypes.split(",").map((s) => s.trim());

  let result;
  try {
    result = await runAudit(inputPath, opts);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  printSummary(result);

  const outPath = args.out || "arbr-audit-report.html";
  fs.writeFileSync(outPath, renderReport(result, { mode: "audit" }));
  console.log(`\nReport written to ${outPath}`);
}

async function runWrapCommand(rest) {
  const args = parseArgs(rest);
  if (args.help) { console.log(HELP); process.exit(0); }

  const agentName = args._[0];
  if (!agentName) {
    console.error("Error: provide an agent, e.g. `arbr wrap claude`.\n");
    console.log(HELP);
    process.exit(1);
  }

  let result;
  try {
    result = await runWrapSession(agentName, { codexHome: args.codexHome });
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }

  printWrapSummary(result);

  const outPath = args.out || "arbr-wrap-report.html";
  fs.writeFileSync(outPath, renderReport(result, { mode: "wrap" }));
  console.log(`\nReport written to ${outPath}`);
}

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd === "audit") return runAuditCommand(rest);
  if (cmd === "wrap") return runWrapCommand(rest);

  console.error(`Unknown command: ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}

main();
