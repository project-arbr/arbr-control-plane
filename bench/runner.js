// Benchmark runner: route each item through every baseline via Arbr's gateway, score it, and write
// raw rows to bench/results/. Aggregate with `node bench/aggregate.js <file>`.
//
//   ARBR_BASE_URL=... ARBR_API_KEY=... node bench/runner.js --benchmark livebench --dataset file.jsonl [--limit 50]
//   (--benchmark: livebench | arenahard;  default livebench)
//
// Requires Node 18+ (global fetch) and REAL API keys — every row is a live model call (costs money).
const fs = require("fs");
const path = require("path");
const cfg = require("./config");
const { complete } = require("./lib/gateway");
const { costUsd } = require("./lib/cost");
const { modelFor, seededRand } = require("./lib/router");
const livebench = require("./scorers/livebench");
const arenahard = require("./scorers/arenahard");

const SCORERS = { livebench: 1, arenahard: 1 };

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : def;
}

// Uniform dispatch: arenahard is async (judged via the gateway); livebench is sync exact-answer.
async function scoreRow(benchmark, item, output) {
  return benchmark === "arenahard" ? arenahard.score(cfg, item, output) : livebench.score(item, output);
}

async function main() {
  const benchmark = arg("benchmark", "livebench");
  if (!SCORERS[benchmark]) { console.error(`unknown --benchmark ${benchmark} (livebench|arenahard)`); process.exit(1); }
  const datasetPath = arg("dataset");
  if (!datasetPath) { console.error("--dataset <file.jsonl> is required"); process.exit(1); }
  const limit = Number(arg("limit", "0")) || 0;

  let items = fs.readFileSync(datasetPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  if (limit) items = items.slice(0, limit);

  const outPath = path.join(__dirname, "results", `${benchmark}-${process.env.RUN_TAG || "run"}.jsonl`);
  const out = fs.createWriteStream(outPath, { flags: "w" });
  console.log(`[${benchmark}] running ${items.length} items × ${cfg.baselines.length} baselines → ${outPath}`);

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const prompt = (Array.isArray(item.turns) ? item.turns[0] : item.turns) || item.prompt;
    const messages = [{ role: "user", content: prompt }];
    const rand = seededRand(cfg.seed, i);

    for (const baseline of cfg.baselines) {
      const model = modelFor(baseline, cfg, rand);
      const row = { benchmark, questionId: item.question_id, category: item.category || "general", baseline, requested: model };
      try {
        const r = await complete(cfg, { model, messages });
        const s = await scoreRow(benchmark, item, r.text);
        const c = costUsd(r.servedModel, r.usage, cfg.prices);
        Object.assign(row, {
          servedModel: r.servedModel, routingDecision: r.routingDecision, taskType: r.taskType,
          scored: s.scored, score: s.score, scoreMethod: s.method,
          costUsd: c.usd, priced: c.priced, latencyMs: r.latencyMs,
          promptTokens: r.usage.prompt_tokens || 0, completionTokens: r.usage.completion_tokens || 0,
        });
      } catch (e) {
        Object.assign(row, { error: String(e.message || e) });
      }
      out.write(JSON.stringify(row) + "\n");
    }
    if ((i + 1) % 10 === 0) console.log(`  …${i + 1}/${items.length}`);
  }
  out.end(() => console.log(`Done. Aggregate: node bench/aggregate.js ${outPath}`));
}

main().catch((e) => { console.error(e); process.exit(1); });
