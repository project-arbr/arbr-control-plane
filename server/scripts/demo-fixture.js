// F-06: design-partner demo fixture. Seeds 3 recommendations that walk the full
// opportunity → dataset → eval → canary → promote → outcome journey (plus a rollback), all
// without a live provider key — see server/src/eval/demoFixture.js for how "Run eval" stays
// live-clickable without one. See docs/demo-fixture.md for the facilitator script.
//
//   node server/scripts/demo-fixture.js seed
//   node server/scripts/demo-fixture.js reset
//
// Idempotent (upsert by a fixed dedupeKey per fixture row) and scoped: reset only ever
// deletes documents with isDemoFixture:true, never touching real data in the same database.
require("dotenv").config();
const mongoose = require("mongoose");
const { config } = require("../src/config");
const RequestRecord = require("../src/models/RequestRecord");
const Recommendation = require("../src/models/Recommendation");
const EvalDataset = require("../src/models/EvalDataset");
const EvalRun = require("../src/models/EvalRun");
const EvalResult = require("../src/models/EvalResult");
const RoutingExperiment = require("../src/models/RoutingExperiment");
const Rule = require("../src/models/Rule");
const ModelEntry = require("../src/models/ModelEntry");
const registry = require("../src/pricing/registry");
const demoFixture = require("../src/eval/demoFixture");

// Deterministic PRNG — same LCG shape as seed/seed.js's rnd(), independent instance so this
// script's output never depends on seed.js having run first (or at all).
let _s = 7331;
function rnd() { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; }

const CURRENT_MODEL = "gpt-4o";
const SUGGESTED_MODEL = "gpt-4o-mini";
const APPLICATION = "demo-support-chat";
const TASK_TYPE = "classification";
const TICKETS = [
  "My card was declined at checkout, can you help?",
  "I was charged twice for the same order.",
  "How do I reset my password?",
  "The app crashes when I open the settings page.",
  "Can I get a refund for my last purchase?",
  "My shipment says delivered but I never received it.",
  "I want to cancel my subscription.",
  "The discount code isn't applying at checkout.",
];

// Registered directly rather than via registry.init()'s LiteLLM sync — the demo must not
// depend on outbound network access. Real OpenAI list prices, so F-05's evidence report
// never flags "unknown pricing" for this fixture.
async function ensureModelsRegistered() {
  await ModelEntry.findOneAndUpdate(
    { id: CURRENT_MODEL },
    { id: CURRENT_MODEL, provider: "openai", inputPer1M: 5, outputPer1M: 15, tier: "premium", enabled: true },
    { upsert: true }
  );
  await ModelEntry.findOneAndUpdate(
    { id: SUGGESTED_MODEL },
    { id: SUGGESTED_MODEL, provider: "openai", inputPer1M: 0.15, outputPer1M: 0.6, tier: "light", enabled: true },
    { upsert: true }
  );
  await registry.reload();
}

// Real, replayable traffic (status:success, single-shot messages+responseText) so the demo's
// "Build eval dataset" step samples genuine documents through the real eval/dataset.js builder
// — no short-circuit needed there, only "Run eval" needs one (see eval/demoFixture.js).
async function seedTraffic(dedupeKeyPrefix, count = 60) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const ticket = TICKETS[i % TICKETS.length];
    rows.push({
      requestId: `${dedupeKeyPrefix}-req-${i}`,
      timestamp: new Date(Date.now() - rnd() * 6 * 86400000),
      application: APPLICATION, taskType: TASK_TYPE,
      provider: "openai", model: CURRENT_MODEL, modelRequested: CURRENT_MODEL,
      promptTokens: 60 + Math.floor(rnd() * 40), completionTokens: 10 + Math.floor(rnd() * 15),
      totalCost: 0.008 + rnd() * 0.004, latencyMs: 500 + rnd() * 300,
      status: "success", cacheHit: false, knownPricing: true, routingDecision: "passthrough",
      classifiedBy: "provided",
      messages: [{ role: "user", content: ticket }],
      responseText: "support response category",
      isDemoFixture: true,
    });
  }
  await RequestRecord.deleteMany({ requestId: { $regex: `^${dedupeKeyPrefix}-req-` } });
  await RequestRecord.insertMany(rows);
}

async function upsertRec(dedupeKey, over) {
  return Recommendation.findOneAndUpdate(
    { dedupeKey },
    {
      dedupeKey, type: "premium_model_overuse", taskType: TASK_TYPE,
      application: APPLICATION, currentModel: CURRENT_MODEL, currentProvider: "openai",
      suggestedModel: SUGGESTED_MODEL, suggestedProvider: "openai",
      isDemoFixture: true,
      ...over,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
}

async function seed() {
  await ensureModelsRegistered();

  // Rec 1 — the happy path: opportunity → live eval (synthesizes to PASS) → canary → promote.
  await seedTraffic("demo-fixture-happy", 60);
  await upsertRec("demo-fixture:happy-path", {
    title: "Demo: classification on gpt-4o", reason: "Cheap task type running on a premium model.",
    requestCount: 60, currentCost: 0.72, projectedCost: 0.05, projectedSavings: 0.67,
    replayableCount: 60, status: "pending", evalStatus: "not_started", demoFixtureOutcome: "pass",
  });

  // Rec 2 — the failing candidate: same shape, synthesizes to FAIL when "Run eval" is clicked.
  await seedTraffic("demo-fixture-failing", 60);
  await upsertRec("demo-fixture:failing-candidate", {
    title: "Demo: classification on gpt-4o (candidate fails quality gate)",
    reason: "Cheap task type running on a premium model.",
    requestCount: 60, currentCost: 0.72, projectedCost: 0.05, projectedSavings: 0.67,
    replayableCount: 60, status: "pending", evalStatus: "not_started", demoFixtureOutcome: "fail",
  });

  // Rec 3 — pre-baked at canary_running with a genuine guardrail breach, for a live MANUAL
  // rollback demo (no live provider needed for that route either).
  const rec3 = await upsertRec("demo-fixture:rollback-scenario", {
    title: "Demo: classification on gpt-4o (canary in progress, breaching)",
    reason: "Cheap task type running on a premium model.",
    requestCount: 60, currentCost: 0.72, projectedCost: 0.05, projectedSavings: 0.67,
    replayableCount: 60, status: "accepted", acceptedVia: "passed", evalStatus: "passed",
  });
  if (!rec3.evalDatasetId) {
    const dataset = await EvalDataset.create({
      name: "demo rollback dataset", recommendationId: rec3._id,
      scope: { application: APPLICATION, taskType: TASK_TYPE, currentModel: CURRENT_MODEL },
      baselineModel: CURRENT_MODEL, candidateModel: SUGGESTED_MODEL,
      riskTier: "low", piiMode: "masked", itemCount: 200, status: "ready",
      isDemoFixture: true,
    });
    // synthesizeRun() sets rec.evalStatus/qualitySummary/evalRunId and saves; evalDatasetId is
    // this route's own responsibility (mirrors create-eval-dataset's split of duties).
    const run = await demoFixture.synthesizeRun({ rec: rec3, dataset, outcome: "pass" });
    rec3.evalDatasetId = dataset._id;

    const rule = await Rule.create({
      condition: { taskType: TASK_TYPE, application: APPLICATION },
      target: { provider: "openai", model: SUGGESTED_MODEL },
      enabled: false, sourceRecommendation: rec3._id, qualityGate: "passed",
      note: rec3.title, isDemoFixture: true,
    });

    const experiment = await RoutingExperiment.create({
      evalRunId: run._id, recommendationId: rec3._id,
      scope: { application: APPLICATION, taskType: TASK_TYPE },
      baselineModel: CURRENT_MODEL, candidateModel: SUGGESTED_MODEL, candidateProvider: "openai",
      rolloutPct: 20, status: "active", metricsWindowMinutes: 60,
      guardrails: { maxErrorRateIncrease: 0.02, maxLatencyRegressionPct: 0.25, maxWorseRate: 0.1, minCostSavingPct: 0.1 },
      lastMonitoredAt: new Date(),
      lastMetrics: { candTotal: 30, candErrorRate: 0.35, baseErrorRate: 0.02, latencyRegressionPct: 0.4, costSavingPct: 0.9, worseRate: null },
      isDemoFixture: true,
    });
    rec3.experimentId = experiment._id;
    await rec3.save();
    await demoFixture.synthesizeCanaryBreach({ rec: rec3, experiment });
    void rule; // created for the dashboard's disabled-rule linkage; not read further here
  }

  console.log("Demo fixture seeded:");
  console.log("  - demo-fixture:happy-path        (opportunity — walk it live to a passing eval + canary)");
  console.log("  - demo-fixture:failing-candidate (opportunity — walk it live to a failing eval)");
  console.log("  - demo-fixture:rollback-scenario (canary_running, guardrail already breached — click Roll back)");
  console.log("Reset with: node server/scripts/demo-fixture.js reset");
}

async function reset() {
  const [rr, rec, ds, run, res, exp, rule] = await Promise.all([
    RequestRecord.deleteMany({ isDemoFixture: true }),
    Recommendation.deleteMany({ isDemoFixture: true }),
    EvalDataset.deleteMany({ isDemoFixture: true }),
    EvalRun.deleteMany({ isDemoFixture: true }),
    EvalResult.deleteMany({ isDemoFixture: true }),
    RoutingExperiment.deleteMany({ isDemoFixture: true }),
    Rule.deleteMany({ isDemoFixture: true }),
  ]);
  console.log("Demo fixture reset — deleted:", {
    requestRecords: rr.deletedCount, recommendations: rec.deletedCount, evalDatasets: ds.deletedCount,
    evalRuns: run.deletedCount, evalResults: res.deletedCount, routingExperiments: exp.deletedCount, rules: rule.deletedCount,
  });
}

async function main() {
  const mode = process.argv[2];
  if (mode !== "seed" && mode !== "reset") {
    console.error("Usage: node server/scripts/demo-fixture.js seed|reset");
    process.exit(1);
  }
  await mongoose.connect(config.mongoUri);
  if (mode === "seed") await seed();
  else await reset();
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
