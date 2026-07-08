import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Stat, Card, Table, Spinner, Tabs, useTabParam } from "../components/ui.jsx";
import ByDimension from "./ByDimension.jsx";
import RequestsTable from "../components/RequestsTable.jsx";
import TrendChart from "../components/TrendChart.jsx";

const TABS = [
  ["summary",    "Summary"],
  ["dimensions", "By dimension"],
  ["requests",   "Requests"],
];

function Summary() {
  const [data, setData] = useState(null);
  const [latency, setLatency] = useState(null);
  const [byProvider, setByProvider] = useState([]);
  const [byTask, setByTask] = useState([]);
  const [savings, setSavings] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    Promise.all([api.overview(), api.latencyPercentiles(), api.by("provider"), api.by("taskType"), api.realisedSavings()])
      .then(([o, l, p, t, s]) => { setData(o); setLatency(l); setByProvider(p); setByTask(t); setSavings(s); })
      .catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="text-red-600">{err}</div>;
  if (!data) return <Spinner />;

  const ms = (v) => v != null ? fmt.ms(v) : "—";
  const latRows = [
    { label: "Total latency",     p50: latency?.p50,         p95: latency?.p95,         p99: latency?.p99         },
    { label: "Gateway overhead",  p50: latency?.overheadP50, p95: latency?.overheadP95, p99: latency?.overheadP99 },
    ...(latency?.ttftP50 != null
      ? [{ label: "TTFT (streaming)", p50: latency?.ttftP50, p95: latency?.ttftP95, p99: null }]
      : []),
  ];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total requests" value={fmt.num(data.totalRequests)} />
        <Stat label="Total cost" value={fmt.usd(data.totalCost)}
          sub={data.unknownPricingRequests ? `excludes ${fmt.num(data.unknownPricingRequests)} unpriced req` : undefined} />
        <Stat label="Avg cost / request" value={fmt.usd(data.avgCostPerRequest)} />
        <Stat label="Realised savings" value={fmt.usd(savings?.totalSaved)} />
      </div>

      <Card title="Latency breakdown">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100">
              <th className="pb-2 text-left text-xs font-semibold uppercase tracking-wider text-gray-400">Metric</th>
              <th className="pb-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">Median</th>
              <th className="pb-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">95%ile</th>
              <th className="pb-2 text-right text-xs font-semibold uppercase tracking-wider text-gray-400">99%ile</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {latRows.map(({ label, p50, p95, p99 }) => (
              <tr key={label}>
                <td className="py-2.5 text-gray-700">{label}</td>
                <td className="py-2.5 text-right font-mono text-gray-600">{ms(p50)}</td>
                <td className="py-2.5 text-right font-mono text-gray-600">{ms(p95)}</td>
                <td className="py-2.5 text-right font-mono text-gray-600">{ms(p99)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {latency?.overheadP99 > 500 && (
          <p className="mt-3 text-xs text-gray-400">
            High 99%ile gateway overhead reflects AI task classification — the gateway makes a short LLM call to determine task type when AI routing is on.
            Pin <code className="rounded bg-gray-100 px-1">taskType</code> in your requests to skip it.
          </p>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Cache hit rate" value={`${((data.cacheHitRate || 0) * 100).toFixed(1)}%`} />
        <Stat label="Cached tokens" value={fmt.num(data.cachedReadTokens)} />
        <Stat label="Cache savings" value={fmt.usd(data.cacheSavingUsd)} />
      </div>

      <TrendChart />

      {savings?.rows?.length > 0 && (
        <Card title="Realised savings by substitution">
          <p className="mb-3 text-sm text-gray-500">
            Requests that asked for one model but were served a different one (downgrades, rules,
            opt-outs). Savings re-price the served tokens at the requested model. Excludes
            <span className="font-mono"> auto</span> requests (no requested baseline).
          </p>
          <Table
            columns={[
              { key: "requested", header: "Requested", render: (r) => r.requested },
              { key: "served", header: "Served", render: (r) => r.served },
              { key: "requests", header: "Requests", render: (r) => fmt.num(r.requests) },
              { key: "saved", header: "Saved", render: (r) => fmt.usd(r.saved) },
            ]}
            rows={savings.rows}
          />
        </Card>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Spend by provider">
          <Table
            columns={[
              { key: "key", header: "Provider", render: (r) => r.key || "—" },
              { key: "requests", header: "Requests", render: (r) => fmt.num(r.requests) },
              { key: "cost", header: "Cost", render: (r) => fmt.usd(r.cost) },
            ]}
            rows={byProvider}
          />
        </Card>
        <Card title="Spend by task type">
          <Table
            columns={[
              { key: "key", header: "Task type", render: (r) => r.key || "—" },
              { key: "requests", header: "Requests", render: (r) => fmt.num(r.requests) },
              { key: "cost", header: "Cost", render: (r) => fmt.usd(r.cost) },
            ]}
            rows={byTask}
          />
        </Card>
      </div>
    </div>
  );
}

export default function Overview() {
  const [tab, setTab] = useTabParam(TABS);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-arbr-charcoal">Overview</h1>
        <p className="text-sm text-gray-500">Total AI usage and cost across the organisation.</p>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "summary" && <Summary />}
      {tab === "dimensions" && <ByDimension embedded />}
      {tab === "requests" && <RequestsTable />}
    </div>
  );
}
