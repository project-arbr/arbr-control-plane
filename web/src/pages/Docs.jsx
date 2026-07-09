import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, Badge, CodeBlock } from "../components/ui.jsx";

// Grouped by the path a request takes through Arbr — keep in sync with Layout.jsx NAV_GROUPS.
// [stage, one-line purpose, [[screen, what it does], …]]
const SCREENS = [
  ["Connect", "Wire your apps and providers to one gateway.", [
    ["Models", "Connect providers (paste a key), or add any OpenAI-compatible provider (e.g. NVIDIA) and Discover + import its models. Prices/benchmarks sync from the catalog."],
    ["Settings", "Gateway API keys (per application), default provider/model, and Require-API-keys."],
  ]],
  ["See", "Know what you're spending, and where.", [
    ["Overview", "Usage, spend, tokens, success rate and latency (incl. p50/p95), with a cost trend chart. Filter by period."],
    ["Applications", "Per-application view of the same metrics; click a request for the full drilldown (prompt, response, routing)."],
  ]],
  ["Recommend", "Surface where a cheaper model fits — measured from your own traffic.", [
    ["Recommendations", "Costed suggestions where a premium model is handling a cheap task. Advisory until you accept; each can be proven with an eval before it ever routes."],
  ]],
  ["Route", "Send traffic to the right model — on human approval, always reversible.", [
    ["Routing", "Routing mode (off / cost guardrail / AI), human-approved rules, and the AI policy (task→model). Every request records why it was routed the way it was."],
    ["Model Evals", "Prove a candidate before you switch: replay past traffic offline, shadow-evaluate on live traffic (mirrored, not served), then canary with auto-rollback."],
  ]],
  ["Govern", "Set the limits, protect data, and keep a record.", [
    ["Budgets", "Spend caps per application/provider with warning thresholds; a breached cap can alert, downgrade, or block."],
    ["Governance", "Kill switch / maintenance mode, PII masking, max-tokens guardrail, retention, and the alert webhook."],
    ["Audit", "A log of console actions (keys, rules, caps, connections) for accountability."],
  ]],
];

export default function Docs() {
  const [status, setStatus] = useState(null);
  useEffect(() => { api.status().then(setStatus).catch(() => {}); }, []);

  const base = typeof window !== "undefined" ? window.location.origin : "http://localhost:4100";
  const live = status?.liveProviders || [];

  const compatCurl = `# OpenAI-compatible endpoint — drop-in for LibreChat, OpenCode, the openai SDK, LangChain.
curl -X POST ${base}/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer ab_…' \\
  -H 'X-Arbr-User-Id: alice@company.com' \\
  -d '{ "model": "auto", "messages": [{ "role": "user", "content": "Hello" }], "max_tokens": 300 }'
# model: "auto" lets Arbr route; pin a model id (e.g. "gpt-4o") to bypass policy.
# X-Arbr-User-Id: optional — attributes this request to a team member in the dashboard.
# X-Arbr-Department: optional — groups requests by team (e.g. "engineering").`;

  const nativeCurl = `# Native endpoint — richer attribution (application/workflow/department/taskType).
curl -X POST ${base}/v1/chat \\
  -H 'Content-Type: application/json' -H 'Authorization: Bearer ab_…' \\
  -d '{ "application": "my-app", "messages": "Summarise this ticket: …", "model": "auto", "maxTokens": 300 }'`;

  const nodeClient = `// Official JS client (Node >= 18):  npm install arbr-client
const { createClient } = require("arbr-client");
const arbr = createClient({ baseUrl: "${base}", application: "my-app", apiKey: process.env.ARBR_API_KEY });
const res = await arbr.chat({ messages: "Summarise this ticket: …", model: "auto", maxTokens: 300 });
// res.text, res.model, res.routingDecision, res.classifiedBy, res.usage`;

  const pythonClient = `# Official Python client (>= 3.11):  pip install arbr-client
from arbr_client import create_client
arbr = create_client("${base}", application="my-app")   # ARBR_API_KEY from env
res = arbr.chat("Summarise this ticket: ...", model="auto", max_tokens=300)   # + achat() async
# LangChain: from arbr_client.langchain import ArbrChatModel`;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-arbr-charcoal">Documentation</h1>
        <p className="text-sm text-gray-500">
          What Arbr is, and how the console works — following the path a request takes:
          Connect → See → Recommend → Route → Govern.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-500">Gateway:</span>
          <Badge tone="charcoal">{base}/v1/chat/completions</Badge>
          {status && (status.demoMode
            ? <Badge tone="amber">demo mode — add a key in Settings → Connections</Badge>
            : <Badge tone="green">live · {live.join(", ")}</Badge>)}
        </div>
      </div>

      <Card title="What it is">
        <p className="text-sm text-gray-600">
          One OpenAI-compatible gateway every app calls. A model the caller pins is honored as-is; send
          <code className="mx-1 rounded bg-gray-100 px-1">"auto"</code> and Arbr routes to the cheapest
          model that fits the task. Every call is logged, costed, and governed — with
          <strong> human-approved</strong> rules and an AI policy, all reversible from these screens.
        </p>
      </Card>

      <Card title="Getting started — the Connect stage">
        <ol className="ml-4 list-decimal space-y-3 text-sm text-gray-600">
          <li><strong>Run it</strong> — <code>docker compose up</code> (Mongo + app on :4100), or <code>npm run dev</code> locally.</li>
          <li><strong>Connect a provider</strong> — Settings → Connections, or the <strong>Models</strong> page. For any OpenAI-compatible provider (e.g. NVIDIA), add it there and <strong>Discover models</strong> to import them. Keys are stored encrypted.</li>
          <li><strong>Create a gateway API key</strong> — Settings → API keys. Each key is bound to an <em>application</em> (that's your attribution), shown once with a ready-to-paste snippet. Flip <em>Require API keys</em> on when ready.</li>
          <li><strong>Call the gateway</strong>:</li>
        </ol>
        <div className="mt-3"><CodeBlock lang="bash" code={compatCurl} /></div>
        <div className="mt-3"><CodeBlock lang="bash" code={nativeCurl} /></div>
        <p className="mt-3 text-xs text-gray-400">
          That's Connect. From there: <strong>See</strong> your spend, act on a <strong>Recommend</strong>ation,
          shape how you <strong>Route</strong>, and set the guardrails to <strong>Govern</strong> it.
        </p>
      </Card>

      <Card title="The dashboard, stage by stage">
        <p className="mb-3 text-sm text-gray-500">
          The console follows the path a request takes: <strong>Connect → See → Recommend → Route → Govern</strong>.
        </p>
        <div className="space-y-4">
          {SCREENS.map(([stage, hint, items]) => (
            <div key={stage}>
              <div className="label mb-0.5">{stage}</div>
              <div className="mb-1 text-xs text-gray-400">{hint}</div>
              <ul className="space-y-1.5 text-sm text-gray-600">
                {items.map(([name, desc]) => (
                  <li key={name}><strong className="text-arbr-charcoal">{name}</strong> — {desc}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Routing: precedence + explainability">
        <p className="text-sm text-gray-600">
          Precedence (first match wins): <strong>explicit pin</strong> → <strong>rule</strong> →
          <strong> AI policy</strong> (task-type + difficulty → model) → cost guardrail → default. A breached
          budget cap can override with a downgrade or block; identical prior requests can serve from cache.
          Open any request in <strong>Applications</strong> to see a plain-English <em>“why this routing”</em>
          explanation and the full flow (app → classify → route → model → provider).
        </p>
      </Card>

      <Card title="Integrate an app">
        <p className="mb-3 text-sm text-gray-600">
          Point an existing OpenAI-compatible client at <code>{base}/v1</code> with your gateway key, or use a client:
        </p>
        <CodeBlock lang="javascript" code={nodeClient} />
        <div className="mt-3"><CodeBlock lang="python" code={pythonClient} /></div>
      </Card>

      <Card title="Learn more">
        <p className="text-sm text-gray-600">
          Full guides live in the repo's <code>docs/</code> (VitePress): integration walkthroughs for
          <a className="mx-1 text-arbr-green-700 underline" href="https://github.com/project-arbr/arbr-control-plane/tree/main/docs/integrations" target="_blank" rel="noreferrer">OpenCode / LibreChat / NVIDIA</a>,
          plus <a className="mx-1 text-arbr-green-700 underline" href="https://github.com/project-arbr/arbr-control-plane/blob/main/docs/routing.md" target="_blank" rel="noreferrer">routing</a>,
          <a className="mx-1 text-arbr-green-700 underline" href="https://github.com/project-arbr/arbr-control-plane/blob/main/docs/budgets.md" target="_blank" rel="noreferrer">budgets</a>, and the
          <a className="mx-1 text-arbr-green-700 underline" href="https://github.com/project-arbr/arbr-control-plane/blob/main/docs/api-reference.md" target="_blank" rel="noreferrer">API reference</a>.
        </p>
      </Card>
    </div>
  );
}
