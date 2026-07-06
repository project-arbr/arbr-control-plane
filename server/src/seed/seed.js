// Seed synthetic RequestRecords so the dashboards, analytics and recommendation
// engine have believable data immediately — no provider keys or live traffic
// required. Idempotent: clears request_records + recommendations and reseeds.
//
//   node server/src/seed/seed.js [--count=3000]
//
// Includes a DELIBERATE premium-model-on-classification pattern so the
// recommendation engine produces a non-empty, believable result on first run.
require("dotenv").config();
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const { config } = require("../config");
const RequestRecord = require("../models/RequestRecord");
const Recommendation = require("../models/Recommendation");
const EvalDataset = require("../models/EvalDataset");
const EvalItem = require("../models/EvalItem");
const EvalRun = require("../models/EvalRun");
const EvalResult = require("../models/EvalResult");
const RoutingExperiment = require("../models/RoutingExperiment");
const pricing = require("../pricing/registry");
const recommender = require("../recommend/engine");
const { defaultThresholds } = require("../eval/thresholds");
const { getPromptPair } = require("./promptPacks");

// Deterministic PRNG so seeds are reproducible (no Math.random surprises).
let _s = 1337;
function rnd() {
  _s = (_s * 1103515245 + 12345) & 0x7fffffff;
  return _s / 0x7fffffff;
}
function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
function between(min, max) { return Math.floor(min + rnd() * (max - min + 1)); }

let MODELS = []; // populated after registry.init() in main()

const APPLICATIONS = ["sales-coach", "support-chat", "credit-underwriter", "marketing-studio"];
const WORKFLOWS = {
  "sales-coach": ["live-coaching", "call-summary", "lead-scoring"],
  "support-chat": ["ticket-triage", "answer-drafting", "faq-bot"],
  "credit-underwriter": ["decision-explanation", "doc-review", "risk-summary"],
  "marketing-studio": ["copy-generation", "campaign-ideas", "translation"],
};
const DEPARTMENTS = ["Sales", "Support", "Risk", "Marketing"];
const USERS = Array.from({ length: 18 }, (_, i) => `user-${i + 1}`);

const TASK_TYPES = [
  "classification", "extraction", "summarisation", "translation",
  "content generation", "reasoning", "coding", "faq",
  "document analysis", "support response",
];

function makeRecord(daysAgo) {
  const application = pick(APPLICATIONS);
  const workflow = pick(WORKFLOWS[application]);
  const department = pick(DEPARTMENTS);
  const model = pick(MODELS);
  const provider = pricing.getModel(model).provider;
  const taskType = pick(TASK_TYPES);
  return buildRecord({ application, workflow, department, model, provider, taskType, daysAgo });
}

function buildRecord({ application, workflow, department, model, provider, taskType, daysAgo }) {
  const promptTokens = between(150, 3000);
  const completionTokens = between(40, 900);
  const totalTokens = promptTokens + completionTokens;
  const { inputCost, outputCost, totalCost } = pricing.costFor(model, promptTokens, completionTokens);
  const ts = new Date(Date.now() - daysAgo * 86400000 - between(0, 86400000));
  const failed = rnd() < 0.01;
  // Attach a realistic prompt + response so the record is replayable by the eval flow.
  const pair = getPromptPair(taskType, between(0, 99));
  return {
    requestId: uuidv4(),
    timestamp: ts,
    application, workflow, userId: pick(USERS), department,
    provider, model, modelRequested: model, taskType,
    promptTokens, completionTokens, totalTokens,
    inputCost, outputCost, totalCost,
    latencyMs: between(180, 2400),
    status: failed ? "failure" : "success",
    retryCount: 0,
    routingDecision: "passthrough",
    cacheHit: false,
    messages: [{ role: "user", content: pair.prompt }],
    responseText: pair.response,
  };
}

// Seed a ready-made eval story so `docker compose up` (no keys) shows the wedge out of the box:
// one PASSED downgrade (approved + a live canary) and one BLOCKED downgrade (failure-first).
// Attaches to the recommendations recompute() produced, so it survives a later Recompute.
async function seedEvalDemo() {
  // ── PASSED: classification, claude-opus-4-8 → claude-haiku-4-5 ──────────────
  const passRec = await Recommendation.findOne({ dedupeKey: "premium_overuse:classification:claude-opus-4-8" });
  if (passRec) {
    const ds = await EvalDataset.create({
      name: "classification: claude-opus-4-8 → claude-haiku-4-5", recommendationId: passRec._id,
      scope: { taskType: "classification" }, baselineModel: "claude-opus-4-8", candidateModel: "claude-haiku-4-5",
      sampling: { method: "stratified", targetCount: 200, dedupeByPromptHash: true },
      riskTier: "low", piiMode: "masked", itemCount: 200, status: "ready",
    });
    const summary = { total: 200, judged: 200, candidateBetter: 41, candidateEqual: 153, candidateWorse: 6,
      worseRate: 0.03, criticalFailRate: 0, formatPassRate: 1, costSavingPct: 0.82, avgLatencyDeltaPct: -0.28,
      prodCost: 4.43, candidateCost: 0.80, p95LatencyDeltaPct: -0.22 };
    const run = await EvalRun.create({
      recommendationId: passRec._id, datasetId: ds._id, taskType: "classification",
      baselineModel: "claude-opus-4-8", candidateModel: "claude-haiku-4-5", judgeModel: "gpt-4o",
      riskTier: "low", status: "passed", thresholds: defaultThresholds("low"), summary, failures: [],
      estimatedCostUsd: 0.9, actualCostUsd: 0.86, startedAt: new Date(), completedAt: new Date(),
    });
    await EvalResult.insertMany([
      { evalRunId: run._id, baselineModel: "claude-opus-4-8", candidateModel: "claude-haiku-4-5", candidateResponse: "billing", judgeVerdict: "equal", formatPass: true, dimensionScores: { correctness: 5, format: 5 }, judgeRationale: "Both correctly label the ticket 'billing'." },
      { evalRunId: run._id, baselineModel: "claude-opus-4-8", candidateModel: "claude-haiku-4-5", candidateResponse: "technical", judgeVerdict: "equal", formatPass: true, dimensionScores: { correctness: 5, format: 5 }, judgeRationale: "Identical, correct classification." },
      { evalRunId: run._id, baselineModel: "claude-opus-4-8", candidateModel: "claude-haiku-4-5", candidateResponse: "account", judgeVerdict: "better", formatPass: true, dimensionScores: { correctness: 5, format: 5 }, judgeRationale: "Candidate picked the more precise label." },
      { evalRunId: run._id, baselineModel: "claude-opus-4-8", candidateModel: "claude-haiku-4-5", candidateResponse: "feedback (positive)", judgeVerdict: "worse", formatPass: true, dimensionScores: { correctness: 3, format: 4 }, judgeRationale: "Candidate added an unrequested sentiment tag; baseline was cleaner." },
    ]);
    passRec.evalStatus = "passed"; passRec.evalDatasetId = ds._id; passRec.evalRunId = run._id; passRec.qualitySummary = summary;

    const exp = await RoutingExperiment.create({
      evalRunId: run._id, recommendationId: passRec._id,
      scope: { application: "support-chat", taskType: "classification" },
      baselineModel: "claude-opus-4-8", candidateModel: "claude-haiku-4-5", candidateProvider: "anthropic",
      rolloutPct: 10, status: "active", metricsWindowMinutes: 60,
      lastMonitoredAt: new Date(),
      lastMetrics: { candTotal: 63, candErrorRate: 0.008, baseErrorRate: 0.011, latencyRegressionPct: -0.26, costSavingPct: 0.8, worseRate: 0.03 },
    });
    passRec.experimentId = exp._id;
    await passRec.save();
  }

  // ── BLOCKED (failure-first): extraction, gpt-4o → gpt-4o-mini ───────────────
  const failRec = await Recommendation.findOne({ dedupeKey: "premium_overuse:extraction:gpt-4o" });
  if (failRec) {
    const ds = await EvalDataset.create({
      name: "extraction: gpt-4o → gpt-4o-mini", recommendationId: failRec._id,
      scope: { taskType: "extraction" }, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini",
      sampling: { method: "stratified", targetCount: 300, dedupeByPromptHash: true },
      riskTier: "medium", piiMode: "masked", itemCount: 300, status: "ready",
    });
    const summary = { total: 300, judged: 300, candidateBetter: 20, candidateEqual: 196, candidateWorse: 84,
      worseRate: 0.28, criticalFailRate: 0.05, formatPassRate: 0.72, costSavingPct: 0.93, avgLatencyDeltaPct: -0.15,
      prodCost: 1.13, candidateCost: 0.07, p95LatencyDeltaPct: -0.10 };
    const run = await EvalRun.create({
      recommendationId: failRec._id, datasetId: ds._id, taskType: "extraction",
      baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", judgeModel: "claude-opus-4-8",
      riskTier: "medium", status: "failed", thresholds: defaultThresholds("medium"), summary,
      failures: ["worse-rate 28.0% exceeds 3.0%", "critical-failure rate 5.0% exceeds 0.2%", "format pass-rate 72.0% below 99.0%"],
      estimatedCostUsd: 1.4, actualCostUsd: 1.31, startedAt: new Date(), completedAt: new Date(),
    });
    await EvalResult.insertMany([
      { evalRunId: run._id, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", candidateResponse: '{"party":"Acme Inc.","effective_date":"Jan 1 2026","indemnity":true}', judgeVerdict: "worse", criticalFailure: true, formatPass: false, validatorResults: [{ type: "json_schema", pass: false }], dimensionScores: { correctness: 2, format: 1 }, judgeRationale: "Dropped termination_notice_days and used a non-ISO date; fails the schema." },
      { evalRunId: run._id, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", candidateResponse: 'Here is the JSON: {"invoice_number":"INV-4821","total_usd":"12,450"}', judgeVerdict: "worse", criticalFailure: true, formatPass: false, validatorResults: [{ type: "json_schema", pass: false }], dimensionScores: { correctness: 2, format: 1 }, judgeRationale: "Wrapped JSON in prose, quoted the number with a comma, and omitted due_date." },
      { evalRunId: run._id, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", candidateResponse: '{"governing_law":"Delaware","cap_months":12,"auto_renew":true}', judgeVerdict: "equal", formatPass: true, validatorResults: [{ type: "json_schema", pass: true }], dimensionScores: { correctness: 5, format: 5 }, judgeRationale: "Correct on the simple case." },
      { evalRunId: run._id, baselineModel: "gpt-4o", candidateModel: "gpt-4o-mini", candidateResponse: '{"name":"Dana Lee","company":"Globex"}', judgeVerdict: "worse", criticalFailure: false, formatPass: false, validatorResults: [{ type: "json_schema", pass: false }], dimensionScores: { correctness: 3, format: 2 }, judgeRationale: "Omitted the required email field." },
    ]);
    failRec.evalStatus = "failed"; failRec.evalDatasetId = ds._id; failRec.evalRunId = run._id; failRec.qualitySummary = summary;
    await failRec.save();
  }
}

async function main() {
  const countArg = process.argv.find((a) => a.startsWith("--count="));
  const count = countArg ? Number(countArg.split("=")[1]) : 3000;

  await mongoose.connect(config.mongoUri);
  await pricing.init(); // seed ModelEntry collection if empty, warm cache
  MODELS = pricing.listModels().map((m) => m.id);
  console.log(`Seeding ${config.mongoUri} with ${MODELS.length} known models ...`);

  await RequestRecord.deleteMany({});
  await Recommendation.deleteMany({});
  // Reset the eval demo collections too, so reseeding is idempotent.
  await Promise.all([
    EvalDataset.deleteMany({}), EvalItem.deleteMany({}), EvalRun.deleteMany({}),
    EvalResult.deleteMany({}), RoutingExperiment.deleteMany({}),
  ]);

  const records = [];

  // 1) Broad realistic background traffic over the last 30 days.
  for (let i = 0; i < count; i++) {
    records.push(makeRecord(between(0, 30)));
  }

  // 2) DELIBERATE premium-overuse pattern: lots of 'classification' on a premium
  //    model (claude-opus-4-8) — the flagship recommendation example.
  for (let i = 0; i < 220; i++) {
    records.push(
      buildRecord({
        application: "support-chat",
        workflow: "ticket-triage",
        department: "Support",
        model: "claude-opus-4-8",
        provider: "anthropic",
        taskType: "classification",
        daysAgo: between(0, 14),
      })
    );
  }
  // A second pattern: 'extraction' on a premium OpenAI model.
  for (let i = 0; i < 120; i++) {
    records.push(
      buildRecord({
        application: "credit-underwriter",
        workflow: "doc-review",
        department: "Risk",
        model: "gpt-4o",
        provider: "openai",
        taskType: "extraction",
        daysAgo: between(0, 14),
      })
    );
  }

  await RequestRecord.insertMany(records);
  console.log(`Inserted ${records.length} request records.`);

  // Generate recommendations from the traffic, then attach a ready-made eval story
  // (one approved downgrade + a live canary, one blocked downgrade) so the eval-backed
  // wedge is visible on first boot without any provider keys.
  const recs = await recommender.recompute();
  console.log(`Computed ${recs.length} recommendations.`);
  await seedEvalDemo();
  console.log("Seeded eval demo: 1 approved (classification, + canary) and 1 blocked (extraction).");

  console.log("Done. Start the server and open the dashboard — Routing → Recommendations and Model Evals.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
