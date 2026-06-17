// Standalone smoke test for the vendored router + Anthropic adapter.
// Proves the service has no dependency on the rest of Karya/.
//
//   ANTHROPIC_API_KEY=sk-ant-... node server/scripts/smoke-router.js
//
require("dotenv").config();
const { createRouter } = require("../src/providers/llm-router");

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Set ANTHROPIC_API_KEY to run the live smoke test.");
    process.exit(1);
  }
  const router = createRouter({
    providers: { anthropic: { model: "claude-haiku-4-5", apiKey } },
    defaultProvider: "anthropic",
  });
  const result = await router.complete({
    messages: [{ role: "user", content: "Reply with exactly: pong" }],
    maxTokens: 16,
  });
  console.log(JSON.stringify({ text: result.text, modelId: result.modelId, usage: result.usage }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
