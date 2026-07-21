import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmt } from "../api.js";
import { Stat, Card, Table, Spinner } from "../components/ui.jsx";
import RequestsTable from "../components/RequestsTable.jsx";

// Human labels for the internalKind enum — the raw values shouldn't reach users.
const KIND_LABELS = {
  classifier: "Task classification",
  "policy-generation": "Routing policy generation",
  "shadow-candidate": "Shadow campaign — candidate",
  "shadow-judge": "Shadow campaign — judge",
  "eval-replay": "Eval run — candidate replay",
  "eval-judge": "Eval run — judge",
  "eval-disprove": "Eval run — disprove pass",
  "connection-test": "Connection test",
  "model-test": "Model test",
};
const labelFor = (k) => KIND_LABELS[k] || k || "—";

export default function InternalSpend() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.internalSpend().then(setData).catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="text-sm text-red-600">Failed to load: {err}</div>;
  if (!data) return <Spinner />;

  const empty = data.totalRequests === 0;

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-1 flex items-center gap-2 text-sm text-gray-400">
          <Link to="/" className="hover:text-gray-600">Overview</Link>
          <span>/</span>
          <span className="text-gray-600">Arbr overhead</span>
        </div>
        <h1 className="text-xl font-semibold text-gray-900">Arbr overhead</h1>
        <p className="mt-1 max-w-3xl text-sm text-gray-500">
          What the control plane spent on <strong>your</strong> provider keys making calls for
          itself — task classification on the routing path, AI policy generation, eval judging,
          and connection/model tests. This is real money and is included in your total spend, but
          it is kept out of every per-application view because it belongs to no application. To cut
          the largest piece, pin <code className="rounded bg-gray-100 px-1">taskType</code> on your
          requests so the gateway skips the classifier call.
        </p>
      </div>

      {empty ? (
        <Card>
          <p className="text-sm text-gray-500">
            No internal spend recorded yet. Arbr logs overhead when AI routing runs the task
            classifier, when policies are generated, or when evals run.
          </p>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Stat label="Total overhead" value={fmt.usd(data.totalCost)} />
            <Stat label="Internal requests" value={fmt.num(data.totalRequests)} />
            <Stat
              label="Failed calls"
              value={fmt.num(data.failures)}
              sub={data.failures ? "internal calls that errored" : undefined}
            />
          </div>

          <Card title="By kind">
            <Table
              columns={[
                { key: "kind", header: "Kind", render: (r) => labelFor(r.key) },
                { key: "requests", header: "Requests", render: (r) => fmt.num(r.requests) },
                { key: "cost", header: "Cost", render: (r) => fmt.usd(r.cost) },
                { key: "avgLatency", header: "Avg latency", render: (r) => fmt.ms(r.avgLatency) },
                { key: "failures", header: "Failures", render: (r) => fmt.num(r.failures) },
              ]}
              rows={data.byKind}
              empty="No internal spend by kind."
            />
          </Card>

          <Card title="By model">
            <p className="mb-3 text-sm text-gray-500">
              Where the money went. Policy generation and model tests can hit a premium model, so
              this is where an expensive surprise shows up.
            </p>
            <Table
              columns={[
                { key: "model", header: "Model", render: (r) => r.key || "—" },
                { key: "requests", header: "Requests", render: (r) => fmt.num(r.requests) },
                { key: "cost", header: "Cost", render: (r) => fmt.usd(r.cost) },
              ]}
              rows={data.byModel}
              empty="No internal spend by model."
            />
          </Card>

          <Card title="Recent internal calls">
            <RequestsTable fixedFilters={{ internalScope: "internal" }} showStats={false} />
          </Card>
        </>
      )}
    </div>
  );
}
