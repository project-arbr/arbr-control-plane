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
const pricing = require("../pricing/registry");

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
  };
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
  console.log("Done. Start the server and open the dashboard; click 'Recompute' on Recommendations.");
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
