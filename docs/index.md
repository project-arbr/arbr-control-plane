---
layout: home

hero:
  name: "ARBR"
  text: "AI Control Plane"
  tagline: One gateway. Full visibility. Human-approved routing.
  actions:
    - theme: brand
      text: Get started →
      link: /quickstart
    - theme: alt
      text: View on GitHub
      link: https://github.com/gyde-ai/arbr

features:
  - icon: 🔍
    title: Full visibility
    details: Every LLM call logged with model, cost, latency, and routing decision. Spend legible by application, team, workflow, model, and task type — in a live dashboard.
  - icon: 🎯
    title: Human-approved routing
    details: Developers pin the model they want; it's honored as-is. When they say "auto", the gateway applies human-approved rules and automated policies — all reversible in seconds.
  - icon: 💰
    title: Cost governance
    details: Costed recommendations surface premium-model overuse on cheap tasks. Budgets block or downgrade spend that breaches its cap, enforced per application, team, or provider.
  - icon: 🔗
    title: Drop-in compatible
    details: OpenAI-compatible endpoint (POST /v1/chat/completions) — any client that speaks the OpenAI spec works without modification. Real SSE streaming included.
  - icon: 🛡️
    title: Keys stay server-side
    details: Your app never holds provider keys. The gateway holds them encrypted; attribution, rate limits, and governance all bind to your gateway API keys.
  - icon: 🔌
    title: 8 providers, zero lock-in
    details: Anthropic, OpenAI, Google Gemini, Amazon Bedrock, DeepSeek, Moonshot AI, xAI (Grok), and Groq. Or point the OpenAI provider at any LiteLLM proxy for hundreds more.
---
