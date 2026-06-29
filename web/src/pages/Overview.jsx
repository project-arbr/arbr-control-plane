import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Stat, Card, Table, Spinner, Tabs, useTabParam } from "../components/ui.jsx";
import ByDimension from "./ByDimension.jsx";
import RequestsTable from "../components/RequestsTable.jsx";

const TABS = [
  ["summary",    "Summary"],
  ["dimensions", "By dimension"],
  ["requests",   "Requests"],
];

function Summary() {
  const [data, setData] = useState(null);
  const [byProvider, setByProvider] = useState([]);
  const [byTask, setByTask] = useState([]);
  const [err, setErr] = useState(null);

  useEffect(() => {
    Promise.all([api.overview(), api.by("provider"), api.by("taskType")])
      .then(([o, p, t]) => { setData(o); setByProvider(p); setByTask(t); })
      .catch((e) => setErr(e.message));
  }, []);

  if (err) return <div className="text-red-600">{err}</div>;
  if (!data) return <Spinner />;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total requests" value={fmt.num(data.totalRequests)} />
        <Stat label="Total cost" value={fmt.usd(data.totalCost)} />
        <Stat label="Avg cost / request" value={fmt.usd(data.avgCostPerRequest)} />
        <Stat label="Avg latency" value={fmt.ms(data.avgLatency)} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Stat label="Cache hit rate" value={`${((data.cacheHitRate || 0) * 100).toFixed(1)}%`} />
        <Stat label="Cached tokens" value={fmt.num(data.cachedReadTokens)} />
        <Stat label="Cache savings" value={fmt.usd(data.cacheSavingUsd)} />
      </div>

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
