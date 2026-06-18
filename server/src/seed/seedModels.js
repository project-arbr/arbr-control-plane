// Seed the ModelEntry collection with built-in model pricing.
// Run standalone: node server/src/seed/seedModels.js
// Also called automatically by pricing/registry.js on first boot (empty collection).
//
// Upsert strategy:
//   - Model not in DB          → create with builtIn: true
//   - Model in DB, builtIn     → update pricing/label (prices change over time)
//   - Model in DB, !builtIn    → skip (user-created, never overwritten)

const SEED = [
  // ── Anthropic ──
  { id: "claude-opus-4-8",   label: "Claude Opus 4.8",         provider: "anthropic",    inputPer1M: 5.00,  outputPer1M: 25.00, tier: "premium" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6",       provider: "anthropic",    inputPer1M: 3.00,  outputPer1M: 15.00, tier: "mid"     },
  { id: "claude-haiku-4-5",  label: "Claude Haiku 4.5",        provider: "anthropic",    inputPer1M: 1.00,  outputPer1M: 5.00,  tier: "light"   },

  // ── OpenAI ──
  { id: "gpt-4o",            label: "GPT-4o",                  provider: "openai",       inputPer1M: 2.50,  outputPer1M: 10.00, tier: "premium" },
  { id: "gpt-4o-mini",       label: "GPT-4o Mini",             provider: "openai",       inputPer1M: 0.15,  outputPer1M: 0.60,  tier: "light"   },

  // ── Google Gemini ──
  { id: "gemini-2.5-pro",        label: "Gemini 2.5 Pro",        provider: "gemini",     inputPer1M: 1.25,  outputPer1M: 10.00, tier: "premium" },
  { id: "gemini-2.5-flash",      label: "Gemini 2.5 Flash",      provider: "gemini",     inputPer1M: 0.30,  outputPer1M: 2.50,  tier: "light"   },
  { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", provider: "gemini",     inputPer1M: 0.10,  outputPer1M: 0.40,  tier: "light"   },

  // ── Amazon Bedrock — Nova ──
  { id: "us.amazon.nova-pro-v1:0",   label: "Nova Pro",   provider: "bedrock-nova", inputPer1M: 0.80,  outputPer1M: 3.20,  tier: "mid"   },
  { id: "us.amazon.nova-lite-v1:0",  label: "Nova Lite",  provider: "bedrock-nova", inputPer1M: 0.06,  outputPer1M: 0.24,  tier: "light" },
  { id: "us.amazon.nova-micro-v1:0", label: "Nova Micro", provider: "bedrock-nova", inputPer1M: 0.035, outputPer1M: 0.14,  tier: "light" },

  // ── Amazon Bedrock — cross-inference (third-party models on Bedrock) ──
  { id: "zai.glm-5",                              label: "GLM-5",                       provider: "bedrock-nova", inputPer1M: 1.00,  outputPer1M: 3.20,  tier: "mid"     },
  { id: "zai.glm-4.7-flash",                      label: "GLM-4.7 Flash",               provider: "bedrock-nova", inputPer1M: 0.14,  outputPer1M: 0.14,  tier: "light"   },
  { id: "moonshotai.kimi-k2.5",                   label: "Kimi K2.5",                   provider: "bedrock-nova", inputPer1M: 0.60,  outputPer1M: 3.00,  tier: "mid"     },
  // Converse API uses qwen.qwen3-next-80b-a3b (no -instruct suffix); the -instruct variant
  // is the Chat Completions / bedrock-mantle endpoint name only.
  { id: "qwen.qwen3-next-80b-a3b",                label: "Qwen3 Next",                  provider: "bedrock-nova", inputPer1M: 0.50,  outputPer1M: 1.20,  tier: "light"   },
  { id: "deepseek.v3.2",                          label: "DeepSeek V3.2",               provider: "bedrock-nova", inputPer1M: 0.62,  outputPer1M: 1.85,  tier: "light"   },
  { id: "us.deepseek.r1-v1:0",                    label: "DeepSeek R1",                 provider: "bedrock-nova", inputPer1M: 1.35,  outputPer1M: 5.40,  tier: "premium" },
  { id: "google.gemma-3-12b-it",                  label: "Gemma 3 12B",                 provider: "bedrock-nova", inputPer1M: 0.09,  outputPer1M: 0.29,  tier: "light"   },
  { id: "anthropic.claude-3-5-sonnet-20241022-v2:0", label: "Claude 3.5 Sonnet (Bedrock)", provider: "bedrock-nova", inputPer1M: 3.00, outputPer1M: 15.00, tier: "premium" },
  { id: "meta.llama3-70b-instruct-v1:0",          label: "Llama 3 70B",                 provider: "bedrock-nova", inputPer1M: 0.99,  outputPer1M: 0.99,  tier: "mid"     },
  { id: "meta.llama3-8b-instruct-v1:0",           label: "Llama 3 8B",                  provider: "bedrock-nova", inputPer1M: 0.22,  outputPer1M: 0.22,  tier: "light"   },

  // ── DeepSeek (direct API) ──
  { id: "deepseek-chat",     label: "DeepSeek Chat",           provider: "deepseek",     inputPer1M: 0.27,  outputPer1M: 1.10,  tier: "light"   },
  { id: "deepseek-reasoner", label: "DeepSeek Reasoner",       provider: "deepseek",     inputPer1M: 0.55,  outputPer1M: 2.19,  tier: "premium" },

  // ── Moonshot AI (direct API) ──
  { id: "moonshot-v1-8k",   label: "Moonshot 8K",             provider: "moonshot",     inputPer1M: 0.12,  outputPer1M: 0.12,  tier: "light"   },
  { id: "moonshot-v1-32k",  label: "Moonshot 32K",            provider: "moonshot",     inputPer1M: 0.24,  outputPer1M: 0.24,  tier: "mid"     },
  { id: "moonshot-v1-128k", label: "Moonshot 128K",           provider: "moonshot",     inputPer1M: 0.82,  outputPer1M: 0.82,  tier: "premium" },

  // ── xAI (Grok) ──
  { id: "grok-3",      label: "Grok 3",                       provider: "xai",          inputPer1M: 3.00,  outputPer1M: 15.00, tier: "premium" },
  { id: "grok-3-mini", label: "Grok 3 Mini",                  provider: "xai",          inputPer1M: 0.30,  outputPer1M: 0.50,  tier: "light"   },

  // ── Groq (fast inference) ──
  { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (Groq)", provider: "groq",    inputPer1M: 0.59,  outputPer1M: 0.79,  tier: "mid"   },
  { id: "llama-3.1-8b-instant",    label: "Llama 3.1 8B (Groq)",  provider: "groq",    inputPer1M: 0.05,  outputPer1M: 0.08,  tier: "light" },
];

async function run(ModelEntry) {
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

module.exports = { SEED, run };
