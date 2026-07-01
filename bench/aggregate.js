// Aggregate a raw results jsonl into the cost-vs-quality summary + headline numbers.
//   node bench/aggregate.js bench/results/livebench-run.jsonl
const fs = require("fs");
const { summarize } = require("./lib/summarize");

const file = process.argv[2];
if (!file) { console.error("usage: node bench/aggregate.js <results.jsonl>"); process.exit(1); }

const rows = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const s = summarize(rows);

const pct = (n) => (n == null ? "  —  " : `${n.toFixed(1)}%`);
const usd = (n) => `$${(Number(n) || 0).toFixed(4)}`;

console.log(`\nLiveBench router comparison  (${rows.length} rows)\n`);
console.log("baseline          quality   qRetained   $/query    cost%prem   scored  err  unpriced");
for (const k of Object.keys(s)) {
  const b = s[k];
  console.log(
    `${k.padEnd(17)} ${b.quality == null ? "  —  " : (b.quality * 100).toFixed(1) + "%"}`.padEnd(28) +
    `${pct(b.qualityRetainedPct)}`.padEnd(12) +
    `${usd(b.costPerQuery)}`.padEnd(11) +
    `${pct(b.costVsPremiumPct)}`.padEnd(11) +
    `${b.scoredN}`.padEnd(8) + `${b.errors}`.padEnd(5) + `${b.unpriced}`
  );
}

const arbr = s["arbr-auto"];
if (arbr && arbr.qualityRetainedPct != null) {
  console.log(
    `\nHEADLINE: arbr-auto retained ${arbr.qualityRetainedPct.toFixed(1)}% of premium quality ` +
    `at ${arbr.costVsPremiumPct != null ? arbr.costVsPremiumPct.toFixed(1) : "?"}% of premium cost.`
  );
  console.log("Per-category quality (arbr-auto):", JSON.stringify(arbr.byCategory));
}
if (Object.values(s).some((b) => b.unpriced > 0)) {
  console.log("\n⚠ Some rows unpriced (served model not in bench/config.js prices) — scope Arbr's policy to the pool or add prices.");
}

fs.writeFileSync(file.replace(/\.jsonl$/, ".summary.json"), JSON.stringify(s, null, 2));
console.log(`\nSummary → ${file.replace(/\.jsonl$/, ".summary.json")}`);
