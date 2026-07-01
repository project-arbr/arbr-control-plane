import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, Badge, CodeBlock } from "../components/ui.jsx";

// One row per left-nav menu — keep in sync with Layout.jsx NAV_GROUPS so the docs track the product.
const SCREENS = [
  ["Monitor", [
    ["Overview", "Usage, spend, tokens, success rate and latency (incl. p50/p95), with a cost trend chart. Filter by period."],
    ["Applications", "Per-application view of the same metrics; click a request for the full drilldown (prompt, response, routing)."],
  ]],
  ["Control", [
    ["Routing", "Routing mode (off / cost guardrail / AI), human-approved rules, and the AI policy (task→model). Every request records why it was routed the way it was."],
    ["Budgets", "Spend caps per application/provider/etc. with warning thresholds; a breached cap can alert, downgrade, or block."],
    ["Models", "Connect providers (paste a key), or add any OpenAI-compatible provider (e.g. NVIDIA) and Discover + import its models. Prices/benchmarks sync from the catalog."],
    ["Model Evals", "Shadow-evaluate a candidate model on your own live traffic (mirrored, not served), judged vs current, with a safe-to-switch verdict."],
    ["Settings", "Gateway API keys (per application), default provider/model, Require-API-keys, and governance (webhook, retention, PII masking, max-tokens guardrail)."],
  ]],
  ["Governance", [
    ["Governance", "Kill switch / maintenance mode, PII masking, retention, and the alert webhook."],
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
  -d '{ "model": "auto", "messages": [{ "role": "user", "content": "Hello" }], "max_tokens": 300 }'
# model: "auto" lets Arbr route; pin a model id (e.g. "gpt-4o") to bypass policy.`;

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
          What Arbr is, how each screen works, and how to point an app at the gateway.
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

      <Card title="Getting started">
        <ol className="ml-4 list-decimal space-y-3 text-sm text-gray-600">
          <li><strong>Run it</strong> — <code>docker compose up</code> (Mongo + app on :4100), or <code>npm run dev</code> locally.</li>
          <li><strong>Connect a provider</strong> — Settings → Connections, or the <strong>Models</strong> page. For any OpenAI-compatible provider (e.g. NVIDIA), add it there and <strong>Discover models</strong> to import them. Keys are stored encrypted.</li>
          <li><strong>Create a gateway API key</strong> — Settings → API keys. Each key is bound to an <em>application</em> (that's your attribution), shown once with a ready-to-paste snippet. Flip <em>Require API keys</em> on when ready.</li>
          <li><strong>Call the gateway</strong>:</li>
        </ol>
        <div className="mt-3"><CodeBlock lang="bash" code={compatCurl} /></div>
        <div className="mt-3"><CodeBlock lang="bash" code={nativeCurl} /></div>
      </Card>

      <Card title="The dashboard, screen by screen">
        <p className="mb-3 text-sm text-gray-500">Every left-nav menu, and what it does:</p>
        <div className="space-y-4">
          {SCREENS.map(([group, items]) => (
            <div key={group}>
              <div className="label mb-1">{group}</div>
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
