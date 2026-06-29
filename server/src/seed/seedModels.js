// Seed the ModelEntry collection with built-in model pricing.
// Run standalone: node server/src/seed/seedModels.js
// Also called automatically by pricing/registry.js on server start when SEED_VERSION changes.
//
// Upsert strategy:
//   - Model not in DB          → create with builtIn: true
//   - Model in DB, builtIn     → update pricing/label (prices change over time)
//   - Model in DB, !builtIn    → skip (user-created, never overwritten)
//
// HOW TO UPDATE: change model data below, then increment SEED_VERSION by 1.
// registry.init() will detect the version mismatch on next server start and re-seed automatically.
const SEED_VERSION = 3;

const SEED = [
  // ── Anthropic ──
  { id: "claude-opus-4-8",   label: "Claude Opus 4.8",         provider: "anthropic",    inputPer1M: 5.00,  outputPer1M: 25.00, tier: "premium", bestUsedFor: "Complex reasoning, long-form analysis, and nuanced generation",   releaseDate: "2025-06", contextWindow: 200000, maxOutputTokens: 32000 },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6",       provider: "anthropic",    inputPer1M: 3.00,  outputPer1M: 15.00, tier: "mid",     bestUsedFor: "Balanced speed and capability for most tasks",                    releaseDate: "2025-04", contextWindow: 200000, maxOutputTokens: 64000 },
  { id: "claude-haiku-4-5",  label: "Claude Haiku 4.5",        provider: "anthropic",    inputPer1M: 1.00,  outputPer1M: 5.00,  tier: "light",   bestUsedFor: "Fast, lightweight tasks and high-volume completions",             releaseDate: "2025-02", contextWindow: 200000, maxOutputTokens: 64000 },

  // ── OpenAI ──
  { id: "gpt-4o",            label: "GPT-4o",                  provider: "openai",       inputPer1M: 2.50,  outputPer1M: 10.00, tier: "premium", bestUsedFor: "Multimodal tasks, vision, and complex reasoning",                 releaseDate: "2024-05", contextWindow: 128000, maxOutputTokens: 16384 },
  { id: "gpt-4o-mini",       label: "GPT-4o Mini",             provider: "openai",       inputPer1M: 0.15,  outputPer1M: 0.60,  tier: "light",   bestUsedFor: "Fast and cost-efficient general tasks",                          releaseDate: "2024-07", contextWindow: 128000, maxOutputTokens: 16384 },

  // ── Google Gemini ──
  { id: "gemini-2.5-pro",        label: "Gemini 2.5 Pro",        provider: "gemini",     inputPer1M: 1.25,  outputPer1M: 10.00, tier: "premium", bestUsedFor: "Advanced reasoning and million-token long context",               releaseDate: "2025-03", contextWindow: 1000000 },
  { id: "gemini-2.5-flash",      label: "Gemini 2.5 Flash",      provider: "gemini",     inputPer1M: 0.30,  outputPer1M: 2.50,  tier: "light",   bestUsedFor: "Speed and efficiency with very long context",                     releaseDate: "2025-01", contextWindow: 1000000 },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", provider: "gemini",     inputPer1M: 0.10,  outputPer1M: 0.40,  tier: "light",   bestUsedFor: "Ultra-fast, cost-effective high-volume completions",              releaseDate: "2025-04", contextWindow: 1000000 },

  // ── Amazon Bedrock — Nova ──
  { id: "us.amazon.nova-pro-v1:0",   label: "Nova Pro",   provider: "bedrock-nova", inputPer1M: 0.80,  outputPer1M: 3.20,  tier: "mid",   bestUsedFor: "Complex enterprise tasks with multimodal inputs",                  releaseDate: "2024-12", contextWindow: 300000, maxOutputTokens: 10000 },
  { id: "us.amazon.nova-lite-v1:0",  label: "Nova Lite",  provider: "bedrock-nova", inputPer1M: 0.06,  outputPer1M: 0.24,  tier: "light", bestUsedFor: "Fast multimodal tasks with cost efficiency",                       releaseDate: "2024-12", contextWindow: 300000, maxOutputTokens: 10000 },
  { id: "us.amazon.nova-micro-v1:0", label: "Nova Micro", provider: "bedrock-nova", inputPer1M: 0.035, outputPer1M: 0.14,  tier: "light", bestUsedFor: "Text-only, lowest latency and cost on Bedrock",                    releaseDate: "2024-12", contextWindow: 128000, maxOutputTokens: 10000 },

  // ── Amazon Bedrock — cross-inference (third-party models on Bedrock) ──
  { id: "zai.glm-5",                              label: "GLM-5",                       provider: "bedrock-nova", inputPer1M: 1.00,  outputPer1M: 3.20,  tier: "mid",     bestUsedFor: "Chinese-English reasoning and generation",                       releaseDate: "2025-03", contextWindow: 128000, maxOutputTokens: 128000 },
  { id: "zai.glm-4.7-flash",                      label: "GLM-4.7 Flash",               provider: "bedrock-nova", inputPer1M: 0.14,  outputPer1M: 0.14,  tier: "light",   bestUsedFor: "Fast Chinese-English tasks",                                     releaseDate: "2025-04", contextWindow: 128000, maxOutputTokens: 32000 },
  { id: "moonshotai.kimi-k2.5",                   label: "Kimi K2.5",                   provider: "bedrock-nova", inputPer1M: 0.60,  outputPer1M: 3.00,  tier: "mid",     bestUsedFor: "Long context reasoning and document analysis",                    releaseDate: "2025-05", contextWindow: 128000 },
  // Converse API uses qwen.qwen3-next-80b-a3b (no -instruct suffix); the -instruct variant
  // is the Chat Completions / bedrock-mantle endpoint name only.
  { id: "qwen.qwen3-next-80b-a3b",                label: "Qwen3 Next",                  provider: "bedrock-nova", inputPer1M: 0.50,  outputPer1M: 1.20,  tier: "light",   bestUsedFor: "Multilingual reasoning, coding, and instruction following",       releaseDate: "2025-05", contextWindow: 131072, maxOutputTokens: 32768 },
  { id: "deepseek.v3.2",                          label: "DeepSeek V3.2",               provider: "bedrock-nova", inputPer1M: 0.62,  outputPer1M: 1.85,  tier: "light",   bestUsedFor: "Cost-efficient coding and general reasoning",                    releaseDate: "2025-05", contextWindow: 128000, maxOutputTokens: 163840 },
  { id: "us.deepseek.r1-v1:0",                    label: "DeepSeek R1",                 provider: "bedrock-nova", inputPer1M: 1.35,  outputPer1M: 5.40,  tier: "premium", bestUsedFor: "Step-by-step chain-of-thought reasoning",                        releaseDate: "2025-01", contextWindow: 128000, maxOutputTokens: 32768 },
  { id: "google.gemma-3-12b-it",                  label: "Gemma 3 12B",                 provider: "bedrock-nova", inputPer1M: 0.09,  outputPer1M: 0.29,  tier: "light",   bestUsedFor: "Lightweight open-weight tasks on AWS infrastructure",             releaseDate: "2025-03", contextWindow: 128000, maxOutputTokens: 8192 },
  { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", label: "Claude 3.5 Sonnet (Bedrock)", provider: "bedrock-nova", inputPer1M: 3.00, outputPer1M: 15.00, tier: "premium", bestUsedFor: "Enterprise tasks on AWS with Claude-class capability",           releaseDate: "2024-10", contextWindow: 200000, maxOutputTokens: 8192 },
  { id: "meta.llama3-70b-instruct-v1:0",          label: "Llama 3 70B",                 provider: "bedrock-nova", inputPer1M: 0.99,  outputPer1M: 0.99,  tier: "mid",     bestUsedFor: "Open-weight reasoning and instruction following",                 releaseDate: "2024-04", contextWindow: 8192, maxOutputTokens: 8192 },
  { id: "meta.llama3-8b-instruct-v1:0",           label: "Llama 3 8B",                  provider: "bedrock-nova", inputPer1M: 0.22,  outputPer1M: 0.22,  tier: "light",   bestUsedFor: "Fast open-weight tasks with minimal cost",                       releaseDate: "2024-04", contextWindow: 8192, maxOutputTokens: 8192 },

  // ── DeepSeek (direct API) ──
  { id: "deepseek-chat",     label: "DeepSeek Chat",           provider: "deepseek",     inputPer1M: 0.27,  outputPer1M: 1.10,  tier: "light",   bestUsedFor: "Cost-efficient coding and conversational AI",                    releaseDate: "2025-01", contextWindow: 64000  },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner",       provider: "deepseek",     inputPer1M: 0.55,  outputPer1M: 2.19,  tier: "premium", bestUsedFor: "Chain-of-thought reasoning and math",                           releaseDate: "2025-01", contextWindow: 64000  },

  // ── Moonshot AI (direct API) ──
  { id: "moonshot-v1-8k",   label: "Moonshot 8K",             provider: "moonshot",     inputPer1M: 0.12,  outputPer1M: 0.12,  tier: "light",   bestUsedFor: "Short-context chat and Q&A",                                     releaseDate: "2024-03", contextWindow: 8000   },
  { id: "moonshot-v1-32k",  label: "Moonshot 32K",            provider: "moonshot",     inputPer1M: 0.24,  outputPer1M: 0.24,  tier: "mid",     bestUsedFor: "Medium-length documents and analysis",                           releaseDate: "2024-03", contextWindow: 32000  },
  { id: "moonshot-v1-128k", label: "Moonshot 128K",           provider: "moonshot",     inputPer1M: 0.82,  outputPer1M: 0.82,  tier: "premium", bestUsedFor: "Long-context document analysis and summarisation",               releaseDate: "2024-03", contextWindow: 128000 },

  // ── xAI (Grok) ──
  { id: "grok-3",      label: "Grok 3",                       provider: "xai",          inputPer1M: 3.00,  outputPer1M: 15.00, tier: "premium", bestUsedFor: "Real-time knowledge, complex reasoning, and coding",              releaseDate: "2025-02", contextWindow: 131072 },
  { id: "grok-3-mini", label: "Grok 3 Mini",                  provider: "xai",          inputPer1M: 0.30,  outputPer1M: 0.50,  tier: "light",   bestUsedFor: "Fast reasoning with chain-of-thought at low cost",               releaseDate: "2025-02", contextWindow: 131072 },

  // ── Groq (fast inference) ──
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", provider: "groq",    inputPer1M: 0.59,  outputPer1M: 0.79,  tier: "mid",   bestUsedFor: "High-throughput balanced tasks with fast inference",               releaseDate: "2024-12", contextWindow: 128000 },
  { id: "llama-3.1-8b-instant",    label: "Llama 3.1 8B (Groq)",  provider: "groq",    inputPer1M: 0.05,  outputPer1M: 0.08,  tier: "light", bestUsedFor: "Ultra-fast, lowest-latency inference for simple tasks",            releaseDate: "2024-07", contextWindow: 128000 },
];

// IDs that were renamed in a past seed and should be retired.
const RETIRED_IDS = ["qwen.qwen3-next-80b-a3b-instruct"];

async function run(ModelEntry) {
  // Disable any retired built-in entries so they stop appearing in the registry.
  for (const id of RETIRED_IDS) {
    await ModelEntry.updateOne({ id, builtIn: true }, { $set: { enabled: false } });
  }

  let created = 0, updated = 0, skipped = 0;
  for (const entry of SEED) {
    const existing = await ModelEntry.findOne({ id: entry.id }).lean();
    if (!existing) {
      await ModelEntry.create({ ...entry, builtIn: true, enabled: true });
      created++;
    } else if (existing.builtIn) {
      await ModelEntry.updateOne({ id: entry.id }, { $set: { ...entry, builtIn: true } });
      updated++;
    } else {
      skipped++;
    }
  }
  console.log(`[seedModels] ${created} created, ${updated} updated, ${skipped} user entries skipped`);
}

// Standalone execution
if (require.main === module) {
  const mongoose = require("mongoose");
  const ModelEntry = require("../models/ModelEntry");
  const uri = process.env.MONGO_URI || "mongodb://localhost:27017/arbr-control-plane";
  mongoose.connect(uri).then(async () => {
    await run(ModelEntry);
    await mongoose.disconnect();
  }).catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { SEED, run, SEED_VERSION };
