"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { listEmbeddingModels, inferProvider, EMBEDDING_MODELS } = require("../../src/gateway/embeddings");

// Discovery must agree with the resolver: every model /v1/models advertises for embeddings
// has to resolve to a provider the endpoint accepts, or we reintroduce the reported mismatch
// (models listed that /v1/embeddings then rejects).
test("every discoverable embedding model resolves via the endpoint's resolver", () => {
  for (const m of EMBEDDING_MODELS) {
    assert.equal(inferProvider(m.id), m.provider, `${m.id} must resolve to ${m.provider}`);
    assert.ok(Number.isInteger(m.dimensions) && m.dimensions > 0, `${m.id} needs dimensions`);
  }
});

test("listEmbeddingModels is restricted to connected providers", () => {
  const openaiOnly = listEmbeddingModels(["openai"]);
  assert.ok(openaiOnly.length > 0);
  assert.ok(openaiOnly.every((m) => m.provider === "openai"));
  assert.ok(openaiOnly.some((m) => m.id === "text-embedding-3-small"));

  const geminiOnly = listEmbeddingModels(["gemini"]);
  assert.ok(geminiOnly.some((m) => m.id === "gemini-embedding-001"));
  assert.ok(geminiOnly.every((m) => m.provider === "gemini"));

  // No live providers → nothing discoverable.
  assert.equal(listEmbeddingModels([]).length, 0);
  // No filter → the full catalogue.
  assert.equal(listEmbeddingModels().length, EMBEDDING_MODELS.length);
});

test("the nvidia embedding models that broke discovery are NOT advertised", () => {
  // /v1/embeddings can't resolve nvidia/* today, so they must not appear as usable.
  assert.equal(inferProvider("nvidia/nv-embedqa-e5-v5"), null);
  assert.ok(!EMBEDDING_MODELS.some((m) => m.id.startsWith("nvidia/")));
});
