// Pure-logic smoke for custom-provider model import decisions. Run: npm run smoke:import
const { classifyModelImport, isChatLikelyModelId } = require("../src/providers/importLogic");

let pass = 0, fail = 0;
const eq = (got, exp, msg) => {
  if (got === exp) { pass++; } else { fail++; console.log(`FAIL: ${msg} — got ${got}, expected ${exp}`); }
};

const connectable = new Set(["openai", "anthropic", "gemini", "other-custom"]);

// 1. No existing row → create fresh under the provider.
eq(classifyModelImport(null, "nvidia-nim", connectable), "create", "no existing → create");

// 2. Already registered under this provider → skip.
eq(classifyModelImport({ provider: "nvidia-nim", builtIn: false }, "nvidia-nim", connectable), "skip-exists", "same provider → skip-exists");

// 3. Orphaned synced row (not built-in, provider not connectable) → adopt (re-point).
eq(classifyModelImport({ provider: "some-synced-prefix", builtIn: false }, "nvidia-nim", connectable), "adopt", "orphaned synced → adopt");

// 4. Built-in model → never hijack.
eq(classifyModelImport({ provider: "openai", builtIn: true }, "nvidia-nim", connectable), "conflict", "built-in → conflict");

// 5. Owned by another connectable (known) provider → don't hijack.
eq(classifyModelImport({ provider: "openai", builtIn: false }, "nvidia-nim", connectable), "conflict", "known provider owns id → conflict");

// 6. Owned by another live custom provider → don't hijack.
eq(classifyModelImport({ provider: "other-custom", builtIn: false }, "nvidia-nim", connectable), "conflict", "other custom owns id → conflict");

// 7. Chat-likely filter: real chat models pass; embeddings/rerankers/etc. are excluded.
eq(isChatLikelyModelId("meta/llama-3.1-8b-instruct"), true, "llama chat → chat-likely");
eq(isChatLikelyModelId("openai/gpt-oss-20b"), true, "gpt-oss → chat-likely");
eq(isChatLikelyModelId("deepseek-ai/deepseek-r1"), true, "deepseek-r1 → chat-likely");
eq(isChatLikelyModelId("nvidia/nv-embedqa-e5-v5"), false, "embedding → excluded");
eq(isChatLikelyModelId("nvidia/rerank-qa-mistral-4b"), false, "reranker → excluded");
eq(isChatLikelyModelId("nvidia/nemoretriever-parse"), false, "retriever → excluded");
eq(isChatLikelyModelId("stabilityai/stable-diffusion-3"), false, "image-gen → excluded");

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
