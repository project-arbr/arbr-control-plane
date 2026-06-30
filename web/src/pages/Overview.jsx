import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Stat, Card, Table, Spinner, Tabs, useTabParam } from "../components/ui.jsx";
import ByDimension from "./ByDimension.jsx";
import RequestsTable from "../components/RequestsTable.jsx";
import {
  ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer,
} from "recharts";

const TABS = [
  ["summary",    "Summary"],
  ["dimensions", "By dimension"],
  ["requests",   "Requests"],
];

const TREND_PERIODS = [
  { label: "7 days",  days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

function trendRange(days) {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - days);
  return { from: from.toISOString(), to: to.toISOString() };
}

function TrendChart() {
  const [period, setPeriod] = useState(1); // default 30 days
  const [rows, setRows] = useState(null);

  useEffect(() => {
    setRows(null);
    api.timeseries(trendRange(TREND_PERIODS[period].days))
      .then(setRows)
      .catch(() => setRows([]));
  }, [period]);

  return (
    <Card title="Cost & request trend">
      <div className="mb-3 flex items-center justify-between">
        <p className="text-sm text-gray-500">Daily totals — cost (bars) and requests (line).</p>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
          {TREND_PERIODS.map((p, i) => (
            <button
              key={p.label}
              onClick={() => setPeriod(i)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                period === i ? "bg-white text-arbr-charcoal shadow-sm border border-gray-200" : "text-gray-500 hover:text-arbr-charcoal"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      {rows === null ? (
        <div className="flex h-48 items-center justify-center text-sm text-gray-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="flex h-48 items-center justify-center text-sm text-gray-400">No data for this period.</div>
      ) : (
        <ResponsiveContainer width="100%" height={220}>
          <ComposedChart data={rows} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} tickFormatter={(d) => d.slice(5)} />
            <YAxis yAxisId="cost" orientation="left" tick={{ fontSize: 11 }}
              tickFormatter={(v) => `$${v.toFixed(2)}`} width={58} />
            <YAxis yAxisId="reqs" orientation="right" tick={{ fontSize: 11 }} width={44} />
            <Tooltip
              formatter={(value, name) => name === "cost" ? [`$${value.toFixed(4)}`, "Cost"] : [value.toLocaleString(), "Requests"]}
              labelFormatter={(d) => `Date: ${d}`}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Bar yAxisId="cost" dataKey="cost" name="cost" fill="#4ade80" opacity={0.8} radius={[2, 2, 0, 0]} />
            <Line yAxisId="reqs" dataKey="requests" name="requests" type="monotone"
              stroke="#6366f1" strokeWidth={2} dot={false} />
          </ComposedChart>
        </ResponsiveContainer>
      )}
    </Card>
  );
}

function Summary() {
  const [data, setData] = useState(null);
  const [byProvider, setByProvider] = useState([]);
  const [byTask, setByTask] = useState([]);
  const [savings, setSavings] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    Promise.all([api.overview(), api.by("provider"), api.by("taskType"), api.realisedSavings()])
      .then(([o, p, t, s]) => { setData(o); setByProvider(p); setByTask(t); setSavings(s); })
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
        <Stat label="Realised savings" value={fmt.usd(savings?.totalSaved)} />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
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
