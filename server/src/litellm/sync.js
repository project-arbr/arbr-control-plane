// Fetches the LiteLLM model price/spec JSON and updates ModelEntry pricing,
// context window, and capability flags (supportsVision, supportsReasoning).
//
// Source: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
// No auth required. 2,874+ models, updated weekly.
//
// Does NOT touch: tier, label, builtIn, enabled — Arbr owns those.

const ModelEntry = require("../models/ModelEntry");
const Settings   = require("../models/Settings");

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

const GITHUB_COMMITS_URL =
  "https://api.github.com/repos/BerriAI/litellm/commits?path=model_prices_and_context_window.json&per_page=1";

// Provider prefixes to try when matching our model IDs against LiteLLM keys.
// Tried in order; first match wins.
const PROVIDER_PREFIXES = [
  "",           // direct match  (gpt-4o, claude-opus-4-8)
  "bedrock/",   // Bedrock cross-inference (bedrock/us.amazon.nova-micro-v1:0)
  "groq/",      // Groq fast-inference (groq/llama-3.3-70b-versatile)
  "xai/",       // xAI  (xai/grok-3)
  "moonshot/",  // Moonshot direct (moonshot/moonshot-v1-8k)
  "deepseek/",  // DeepSeek direct (deepseek/deepseek-chat)
  "gemini/",    // Gemini direct  (gemini/gemini-2.5-pro)
  "vertex_ai/", // Vertex AI  (vertex_ai/gemini-2.5-pro)
  "anthropic/", // Anthropic direct (anthropic/claude-opus-4-8)
  "openai/",    // OpenAI  (openai/gpt-4o)
];

async function fetchVersion() {
  try {
    const res = await fetch(GITHUB_COMMITS_URL, {
      headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "arbr-control-plane" },
    });
    if (!res.ok) return null;
    const commits = await res.json();
    return commits[0]?.sha?.slice(0, 8) || null;
  } catch {
    return null;
  }
}

async function run() {
  const [version, res] = await Promise.all([
    fetchVersion(),
    fetch(LITELLM_URL, { headers: { "User-Agent": "arbr-control-plane" } }),
  ]);

  if (!res.ok) throw new Error(`LiteLLM JSON fetch failed: ${res.status}`);
  const data = await res.json();

  const models  = await ModelEntry.find({}).lean();
  const now     = new Date();
  let matched   = 0;
  const skipped = [];

  for (const model of models) {
    let entry = null;

    for (const prefix of PROVIDER_PREFIXES) {
      const key = prefix + model.id;
      if (data[key] && data[key].mode === "chat") { entry = data[key]; break; }
    }

    if (!entry) { skipped.push(model.id); continue; }

    const update = { litellmSyncedAt: now };

    const inputCost  = parseFloat(entry.input_cost_per_token);
    const outputCost = parseFloat(entry.output_cost_per_token);
    if (isFinite(inputCost)  && inputCost  > 0) update.inputPer1M  = inputCost  * 1_000_000;
    if (isFinite(outputCost) && outputCost > 0) update.outputPer1M = outputCost * 1_000_000;

    const maxIn = parseInt(entry.max_input_tokens, 10);
    if (isFinite(maxIn) && maxIn > 0) update.contextWindow = maxIn;

    if (entry.supports_vision    != null) update.supportsVision    = !!entry.supports_vision;
    if (entry.supports_reasoning != null) update.supportsReasoning = !!entry.supports_reasoning;

    await ModelEntry.updateOne({ id: model.id }, { $set: update });
    matched++;
  }

  await Settings.findOneAndUpdate(
    { key: "global" },
    { $set: { litellmSyncedAt: now, litellmVersion: version || "unknown" } },
    { upsert: true }
  );

  console.log(`[litellm] synced ${matched}/${models.length} models`);
  return { matched, total: models.length, version, skipped };
}

module.exports = { run };
