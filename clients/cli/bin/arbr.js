#!/usr/bin/env node
"use strict";

const path = require("path");
const fs = require("fs");
const { runAudit } = require("../src/audit");
const { renderReport } = require("../src/report");

const HELP = `arbr — audit a log of past LLM requests for premium-model overuse.

Usage:
  arbr audit <file.jsonl> [--out <report.html>] [--cheap-task-types a,b,c]
  arbr audit --demo [--out <report.html>]

Options:
  --out <path>              where to write the HTML report (default: ./arbr-audit-report.html)
  --cheap-task-types <csv>  comma-separated task types to treat as "should be cheap"
                             (default: classification, extraction, summarisation,
                             translation, faq, support response)
  --demo                    run against the bundled sample log instead of a file
  -h, --help                show this help

Input format: one JSON object per line (JSONL), reusing Arbr's own request-log field
names — taskType, model, provider, promptTokens, completionTokens, totalCost. If you
already run Arbr, export your RequestRecord collection into this shape for a real audit.
See README.md for the full field list and an export example.
`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--cheap-task-types") args.cheapTaskTypes = argv[++i];
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

async function main() {
  const argv = process.argv.slice(2);
  const [cmd, ...rest] = argv;

  if (!cmd || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    process.exit(cmd ? 0 : 1);
  }

  if (cmd !== "audit") {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(HELP);
    process.exit(1);
  }

  const args = parseArgs(rest);
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

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
  fs.writeFileSync(outPath, renderReport(result));
  console.log(`\nReport written to ${outPath}`);
}

main();
