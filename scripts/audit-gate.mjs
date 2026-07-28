#!/usr/bin/env node
// Prod-dependency audit gate with a scoped allowlist.
//
// Wraps `npm audit --omit=dev --audit-level=high --json` and fails on any
// high/critical advisory EXCEPT those explicitly allowlisted below, each with a
// reason and a review date. This exists because a raw `npm audit` cannot exempt a
// single advisory, and one finding here is a non-applicable, unpatched one:
// downgrading 7 minor versions to dodge a vulnerability the app cannot reach is a
// worse outcome than a documented exception.
//
// Any advisory NOT in the allowlist still fails the gate, so this does not weaken
// coverage for real, actionable findings. Run from a package directory:
//   node ../scripts/audit-gate.mjs   (cwd = the package to audit)
import { execFileSync } from "node:child_process";

// GHSA id → why it is allowlisted. Keep this list short and revisit the dates.
const ALLOWLIST = {
  "GHSA-qwww-vcr4-c8h2": {
    reason:
      "react-router RSC-mode CSRF bypass. Arbr's web is a Vite SPA using BrowserRouter; " +
      "RSC mode is never enabled, so the advisory is not reachable. No forward-fixed " +
      "react-router has shipped (7.18.1 is latest); the only npm remediation is a " +
      "7-minor downgrade to 7.11.0. Remove this entry once an upstream fix is published.",
    review: "2026-10-01",
  },
};

function runAudit() {
  try {
    // npm audit exits non-zero when it finds anything; we want the JSON regardless.
    return execFileSync("npm", ["audit", "--omit=dev", "--audit-level=high", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    if (err.stdout) return err.stdout; // the report is on stdout even on a non-zero exit
    throw err;
  }
}

const report = JSON.parse(runAudit());
const vulns = report.vulnerabilities || {};

const ghsaOf = (via) => (via.url || "").replace(/\/+$/, "").split("/").pop();
const found = new Set();
for (const v of Object.values(vulns)) {
  if (v.severity !== "high" && v.severity !== "critical") continue;
  for (const via of v.via || []) {
    if (typeof via !== "object") continue; // string vias are parent package names, not advisories
    if (via.severity !== "high" && via.severity !== "critical") continue;
    const id = ghsaOf(via);
    if (id) found.add(id);
  }
}

const unexpected = [...found].filter((id) => !(id in ALLOWLIST));
const allowlistedHit = [...found].filter((id) => id in ALLOWLIST);

for (const id of allowlistedHit) {
  console.log(`allowlisted: ${id} — ${ALLOWLIST[id].reason} (review ${ALLOWLIST[id].review})`);
}

if (unexpected.length) {
  console.error(`\nFAIL: ${unexpected.length} high/critical advisory(ies) not in the allowlist:`);
  for (const id of unexpected) console.error(`  - https://github.com/advisories/${id}`);
  console.error("\nRun `npm audit --omit=dev --audit-level=high` for details.");
  process.exit(1);
}

console.log(`\nOK: no high/critical advisories outside the allowlist (${allowlistedHit.length} allowlisted).`);
