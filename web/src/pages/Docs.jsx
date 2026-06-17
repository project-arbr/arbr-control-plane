import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, Badge, CodeBlock } from "../components/ui.jsx";

export default function Docs() {
  const [status, setStatus] = useState(null);
  useEffect(() => { api.status().then(setStatus).catch(() => {}); }, []);

  // The control-plane server origin. In single-port mode this is correct; in
  // local dev the dashboard runs on Vite (:5173) and proxies to the server.
  const base = typeof window !== "undefined" ? window.location.origin : "http://localhost:4100";
  const live = status?.liveProviders || [];
  const exampleProvider = live[0] || "anthropic";

  const curlExample = `curl -X POST ${base}/v1/chat \\
  -H 'Content-Type: application/json' \\
  -d '{
    "application": "my-app",
    "workflow": "answer-drafting",
    "department": "Support",
    "taskType": "support response",
    "provider": "${exampleProvider}",
    "messages": [{ "role": "user", "content": "How do I reset my password?" }],
    "maxTokens": 512
  }'`;

  const nodeClient = `// Official JS client (Node >= 18, zero dependencies):
//   npm install arbr-client   (pre-release: install the packed .tgz from clients/js)
const { createClient } = require("arbr-client");

const arbr = createClient({
  baseUrl: "${base}",          // or set ARBR_GATEWAY_URL
  application: "my-app",       // attribution — shows up in this dashboard
});

const res = await arbr.chat({
  messages: "Summarise this ticket in two sentences: …",
  model: "auto",               // router decides; pin a model id to bypass policies
  maxTokens: 300,
});
// res.text, res.model, res.routingDecision, res.classifiedBy, res.usage
// Built in: retries (network/429/5xx), timeouts, typed GatewayError, AbortSignal.`;

  const pythonClient = `# Official Python client (>= 3.11, zero dependencies):
#   pip install arbr-client            (pre-release: install the wheel from clients/python)
#   pip install "arbr-client[langchain]"   # + real BaseChatModel for LangChain/LangGraph apps
from arbr_client import create_client

arbr = create_client("${base}", application="my-app")   # or set ARBR_GATEWAY_URL

res = arbr.chat("Summarise this ticket: ...", model="auto", max_tokens=300)   # sync
res = await arbr.achat("Summarise this ticket: ...", model="auto")            # async
# res.text, res.model, res.routing_decision, res.classified_by, res.usage
# Built in: retries (network/429/5xx), timeouts, typed GatewayError.

# LangChain/LangGraph apps (full Runnable compat — prompt | llm, .ainvoke, callbacks):
#   from arbr_client.langchain import ArbrChatModel
#   llm = ArbrChatModel(client=arbr, model_name="auto")`;

  const wrapperPattern = `// In an app that already centralises model calls (one factory/chokepoint),
// swap in the gateway behind an env flag — no business-code changes:
const { createClient, asLangChainModel } = require("arbr-client");

function makeModel(opts) {
  if (!process.env.ARBR_GATEWAY_URL) return buildDirectModel(opts); // unchanged path
  const arbr = createClient({ application: "my-app" });
  return asLangChainModel(arbr, opts); // .invoke()/.stream(), AIMessage-shaped results
}
// Unset ARBR_GATEWAY_URL to revert instantly.`;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gyde-charcoal">Documentation</h1>
        <p className="text-sm text-gray-500">
          How to run Arbr, point an app at the gateway, and turn visibility into approved routing.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-500">Gateway:</span>
          <Badge tone="charcoal">{base}/v1/chat</Badge>
          {status && (status.demoMode
            ? <Badge tone="amber">demo mode — add a key in Settings</Badge>
            : <Badge tone="green">live · {live.join(", ")}</Badge>)}
        </div>
      </div>

      <Card title="1 · What it is">
        <p className="text-sm text-gray-600">
          A single gateway every app calls. A model the developer pins is honored as-is; when they send
          <code>"auto"</code> (or no model), the gateway decides. In parallel it logs full metadata, makes spend
          legible, recommends optimisations, and can apply <strong>human-approved</strong> routing rules and an
          automated cost guardrail — both reversible from the dashboard at any time.
        </p>
      </Card>

      <Card title="2 · Run it">
        <p className="mb-2 text-sm text-gray-600">Docker (one command) — Mongo + seeded app on one port:</p>
        <CodeBlock lang="sh" code={`git clone <repo> && cd control-plane
cp .env.example .env      # ready to run; no keys needed for the demo
docker compose up         # dashboard at http://localhost:4100`} />
        <p className="mb-2 mt-4 text-sm text-gray-600">Local (Node + your own MongoDB):</p>
        <CodeBlock lang="sh" code={`npm run setup             # install + seed
npm run dev               # server (:4100) + dashboard (:5173)`} />
      </Card>

      <Card title="3 · Add provider keys">
        <p className="text-sm text-gray-600">
          Open <strong>Settings → Connections</strong> and paste a key (OpenAI, Anthropic, Gemini,
          DeepSeek, Moonshot, xAI, Groq, or Amazon Bedrock / AWS) — it goes live with no restart,
          stored encrypted. Or set the provider env var in <code>.env</code> (env takes precedence).
          Until then the gateway runs in demo mode and only this dashboard works, on seeded data.
        </p>
        <p className="mt-2 text-sm text-gray-600">
          <strong>Gateway API keys</strong> (Settings → API keys): issue per-application keys and send them as
          <code className="mx-1 rounded bg-gray-100 px-1">Authorization: Bearer ab_…</code> — attribution then comes
          from the key, with optional per-key rate limits. Anonymous calls work until you flip
          <em> Require API keys</em> on.
        </p>
      </Card>

      <Card title="4 · Call the gateway">
        <p className="mb-3 text-sm text-gray-600">
          One endpoint for all AI requests: <Badge tone="charcoal">POST /v1/chat</Badge>.
          Send business metadata + messages; get the completion back (and it's logged).
        </p>
        <CodeBlock lang="bash" code={curlExample} />
        <div className="mt-4 grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
          <div>
            <div className="label mb-1">Request fields</div>
            <ul className="space-y-1 text-gray-600">
              <li><code>messages</code> — <span className="text-gray-400">required</span>, [{`{ role, content }`}]</li>
              <li><code>application, workflow, userId, department</code> — attribution</li>
              <li><code>taskType</code> — optional; auto-classified if omitted</li>
              <li><code>provider, model</code> — optional; defaults apply</li>
              <li><code>temperature, maxTokens</code> — optional</li>
            </ul>
          </div>
          <div>
            <div className="label mb-1">Response fields</div>
            <ul className="space-y-1 text-gray-600">
              <li><code>text</code> — the completion</li>
              <li><code>usage</code> — {`{ inputTokens, outputTokens, totalTokens }`}</li>
              <li><code>model</code> / <code>modelRequested</code> — served vs requested</li>
              <li><code>routingDecision</code> — passthrough | rule | cache | fallback</li>
              <li><code>requestId</code></li>
            </ul>
          </div>
        </div>
      </Card>

      <Card title="5 · Integrate an app">
        <p className="mb-3 text-sm text-gray-600">
          Use the official client packages — <code className="rounded bg-gray-100 px-1">arbr-client</code> for
          Node (<code>clients/js</code>) and Python (<code>clients/python</code>) — zero dependencies,
          retries/timeouts/typed errors built in. Other languages: POST to <code>/v1/chat</code> directly.
          Either way, your app no longer needs provider keys — the gateway holds them.
        </p>
        <div className="space-y-4">
          <CodeBlock lang="javascript" code={nodeClient} />
          <CodeBlock lang="python" code={pythonClient} />
        </div>
        <p className="mb-2 mt-4 text-sm text-gray-600">
          If your app already centralises model calls behind one factory, swap the gateway in behind a flag so
          nothing else changes (this is how <code>ai-support-chat-agent</code> is wired):
        </p>
        <CodeBlock lang="javascript" code={wrapperPattern} />
        <p className="mt-2 text-xs text-gray-500">
          Note: the gateway is non-streaming today — the client's <code>stream()</code> is a buffered shim
          (one call, yielded in chunks). Embeddings/voice stay on direct SDKs.
        </p>
      </Card>

      <Card title="6 · See → recommend → route">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-600">
          <li><strong>See</strong> — traffic shows up under <em>Overview</em> and <em>By dimension</em>.</li>
          <li><strong>Recommend</strong> — <em>Recommendations → Recompute</em> surfaces costed optimisations (e.g. premium model on a cheap task).</li>
          <li><strong>Approve</strong> — <em>Accept</em> creates a <em>disabled</em> rule; switch it on in <em>Routing rules</em>. The gateway then serves that task on the cheaper model — your app code never changes.</li>
          <li><strong>Revert</strong> — toggle the rule (or automated routing) off any time; changes apply within seconds.</li>
        </ol>
      </Card>

      <Card title="7 · Routing precedence (the developer's pin wins)">
        <p className="mb-2 text-sm text-gray-600">
          The model the developer asks for is honored when it can be. Each request is evaluated in this order —
          the first match wins:
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-gray-600">
          <li><strong>Budget enforcement</strong> — a breached budget with action <em>Block</em> rejects the request (429); <em>Downgrade</em> forces the provider's light model. Outranks everything below, including pins. Tagged <Badge tone="red">budget</Badge>. (Settings → Budgets)</li>
          <li><strong>Explicit available model</strong> — if the caller pins a <code>model</code> whose provider is connected, it's used as-is and <strong>all policies are skipped</strong>. Tagged <Badge tone="teal">explicit</Badge>.</li>
          <li><strong>Otherwise the router decides</strong> — when <code>model</code> is <code>"auto"</code>, omitted, or its provider isn't connected:
            <ol className="mt-1 list-[lower-alpha] space-y-1 pl-5">
              <li><strong>Cache</strong> — identical (served model + messages) → stored response. <Badge tone="charcoal">cache</Badge></li>
              <li><strong>Human routing rules</strong> — first matching enabled rule wins. <Badge tone="green">rule</Badge></li>
              <li><strong>Automated routing</strong> — by mode (Routing → Automated routing): <em>Cost guardrail</em> downgrades per policy <Badge tone="indigo">auto</Badge>, or <em>AI policy</em> routes per the AI-generated task→model map <Badge tone="violet">ai</Badge>.</li>
              <li><strong>Default</strong> — the configured default provider + model (Settings → Connections). <Badge tone="gray">passthrough</Badge></li>
            </ol>
          </li>
          <li><strong>Fallback</strong> — on a provider error, try other live providers. <Badge tone="amber">fallback</Badge></li>
        </ol>
        <p className="mt-2 text-sm text-gray-600">
          So: pin a model and you get exactly it (when connected); send <code>"auto"</code> (or no model) and Arbr
          optimizes — rules first, then automated routing (cost-guardrail or AI policy), else the default. When no
          task type is sent, the task is inferred: rule-based keywords, or — in AI mode — the AI classifier on the
          default model. The Requests page shows how each was classified.
        </p>
      </Card>

      <Card title="8 · Deploy to production">
        <p className="text-sm text-gray-600">
          One standalone instance per organisation (the LiteLLM-proxy / MLflow-tracking-server model):
          a single VM with Docker Compose, TLS terminated by nginx or your load balancer in front of
          port 4100. Two credentials, two planes — <strong>gateway API keys</strong> (<code>ab_…</code>)
          authenticate applications on <code>/v1/chat</code>; the <strong>admin key</strong>
          (<code className="rounded bg-gray-100 px-1">ARBR_ADMIN_KEY</code>) gates this dashboard and the
          admin API (a sign-in screen appears when it's set). Production checklist: admin key +
          encryption key set, <em>Require API keys</em> on, <code>SEED_ON_BOOT=false</code>, MongoDB
          private + backed up. Full guide with nginx/ALB configs: <strong>DEPLOYMENT.md</strong> in the repo.
        </p>
      </Card>

      <Card title="9 · The record">
        <p className="mb-2 text-sm text-gray-600">One <code>RequestRecord</code> per call is the source of every view and saving:</p>
        <CodeBlock lang="text" code={`requestId, timestamp
application, workflow, userId, department
provider, model, modelRequested, taskType
promptTokens, completionTokens, totalTokens
inputCost, outputCost, totalCost
latencyMs, status, routingDecision, cacheHit`} />
      </Card>
    </div>
  );
}
