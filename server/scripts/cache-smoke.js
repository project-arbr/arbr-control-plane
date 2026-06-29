// Pure-logic smoke test for cache-token usage extraction (no DB / no provider keys).
// Run: npm run smoke:cache
const { extractUsage } = require("../src/providers/llm-router");

let pass = 0, fail = 0;
const eq = (got, exp, msg) => {
  if (got === exp) { pass++; } else { fail++; console.log(`FAIL: ${msg} — got ${got}, expected ${exp}`); }
};

// 1. OpenAI via LangChain: input_tokens is TOTAL (incl. cached); detail carries cache_read.
let u = extractUsage({ usage_metadata: { input_tokens: 1000, output_tokens: 50, total_tokens: 1050,
  input_token_details: { cache_read: 800 } } });
eq(u.inputTokens, 1000, "OpenAI/LC inputTokens");
eq(u.cachedReadTokens, 800, "OpenAI/LC cachedRead");
eq(u.cacheWriteTokens, 0, "OpenAI/LC cacheWrite");

// 2. Anthropic via LangChain: cache_read + cache_creation in details.
u = extractUsage({ usage_metadata: { input_tokens: 1200, output_tokens: 40, total_tokens: 1240,
  input_token_details: { cache_read: 900, cache_creation: 100 } } });
eq(u.inputTokens, 1200, "Anthropic/LC inputTokens (total)");
eq(u.cachedReadTokens, 900, "Anthropic/LC cachedRead");
eq(u.cacheWriteTokens, 100, "Anthropic/LC cacheWrite");

// 3. Raw OpenAI fallback (no usage_metadata): prompt_tokens incl. cached.
u = extractUsage({ response_metadata: { usage: { prompt_tokens: 500, completion_tokens: 20, total_tokens: 520,
  prompt_tokens_details: { cached_tokens: 300 } } } });
eq(u.inputTokens, 500, "OpenAI raw inputTokens");
eq(u.cachedReadTokens, 300, "OpenAI raw cachedRead");

// 4. Raw Anthropic fallback: input_tokens EXCLUDES cache → must be added back to a total.
u = extractUsage({ response_metadata: { usage: { input_tokens: 200, output_tokens: 10,
  cache_read_input_tokens: 700, cache_creation_input_tokens: 50 } } });
eq(u.inputTokens, 950, "Anthropic raw inputTokens (200+700+50)");
eq(u.cachedReadTokens, 700, "Anthropic raw cachedRead");
eq(u.cacheWriteTokens, 50, "Anthropic raw cacheWrite");

// 5. No cache info → zeros, input preserved.
u = extractUsage({ usage_metadata: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } });
eq(u.inputTokens, 100, "no-cache inputTokens");
eq(u.cachedReadTokens, 0, "no-cache cachedRead = 0");
eq(u.cacheWriteTokens, 0, "no-cache cacheWrite = 0");

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
