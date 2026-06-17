// Live smoke test against a running gateway (default http://localhost:4100).
// NOT part of `npm test` — run explicitly with `npm run smoke`.
// Makes real (billable) provider calls; tags traffic application="sdk-smoke".
"use strict";

const { createClient, asLangChainModel } = require("../src/index.js");

const BASE = process.env.ARBR_GATEWAY_URL || "http://localhost:4100";

async function main() {
  const karya = createClient({ baseUrl: BASE, application: "sdk-smoke" });

  console.log(`gateway: ${BASE}`);
  const s = await karya.status();
  console.log(`status: live=[${s.liveProviders.join(",")}] routingMode=${s.routingMode} default=${s.defaultProvider}/${s.defaultModel}`);
  if (s.demoMode) throw new Error("gateway is in demo mode — add a provider key first");

  // 1) auto — the router decides.
  const auto = await karya.chat({ messages: "Reply with exactly: pong", model: "auto", maxTokens: 200 });
  console.log(`auto:     served=${auto.model} routing=${auto.routingDecision} classifiedBy=${auto.classifiedBy} text=${JSON.stringify(auto.text.slice(0, 40))}`);

  // 2) explicit pin — honored as-is when the provider is connected.
  const pinModel = s.defaultModel;
  const pin = await karya.chat({ messages: "Reply with exactly: pong", model: pinModel, maxTokens: 200 });
  console.log(`explicit: served=${pin.model} routing=${pin.routingDecision} (pinned ${pinModel})`);
  if (pin.routingDecision !== "explicit") throw new Error("expected routingDecision=explicit for a pinned live model");

  // 3) LangChain-style adapter.
  const model = asLangChainModel(karya, { workflow: "smoke", maxTokens: 200 });
  const msg = await model.invoke([{ role: "user", content: "Reply with exactly: pong" }]);
  console.log(`adapter:  content=${JSON.stringify(msg.content.slice(0, 40))} tokens=${msg.usage_metadata.total_tokens}`);

  console.log("\nsmoke OK");
}

main().catch((err) => {
  console.error("smoke FAILED:", err.code || "", err.message);
  process.exit(1);
});
