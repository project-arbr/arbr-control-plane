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
      link: https://github.com/project-arbr/arbr-control-plane

# The five stages a request takes through Arbr: Connect → See → Recommend → Route → Govern.
features:
  - icon: 🔌
    title: Connect
    details: One drop-in, OpenAI-compatible gateway (POST /v1/chat/completions) every app calls without code changes — real SSE streaming included. Connect Anthropic, OpenAI, Gemini, Bedrock, DeepSeek, Moonshot, xAI (Grok) and Groq, or any LiteLLM proxy for hundreds more. Provider keys stay encrypted server-side, never in your app.
  - icon: 🔍
    title: See
    details: Every call logged with model, cost, latency, and routing decision. Spend legible by application, team, workflow, model, and task type — in a live dashboard.
  - icon: 💡
    title: Recommend
    details: Costed recommendations surface premium-model overuse on cheap tasks, with the dollar saving — measured from your own traffic, advisory until a human accepts.
  - icon: 🎯
    title: Route
    details: Developers pin the model they want; it's honored as-is. On "auto", the gateway applies human-approved rules and policies — and you can prove a cheaper model is no worse before it routes. All reversible in seconds.
  - icon: 🛡️
    title: Govern
    details: Budgets block or downgrade spend that breaches its cap, per application, team, or provider. Guardrails, PII masking, and an audit log keep it safe and accountable.
---
