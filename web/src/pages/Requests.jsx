import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Card, Table, Badge, Spinner } from "../components/ui.jsx";

const ROUTING_TONE = { passthrough: "gray", explicit: "teal", rule: "green", auto: "indigo", ai: "violet", budget: "red", cache: "charcoal", fallback: "amber" };

// How the task type was determined.
const CLASSIFY = {
  provided: { tone: "gray", label: "provided" },
  keyword: { tone: "gray", label: "rule-based" },
  ai: { tone: "violet", label: "AI" },
};

const EMPTY_FILTER = { application: "", workflow: "", department: "", model: "", provider: "", taskType: "" };

export default function Requests() {
  const [facets, setFacets] = useState(null);
  const [filter, setFilter] = useState(EMPTY_FILTER);
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [err, setErr] = useState(null);

  useEffect(() => { api.facets().then(setFacets).catch(() => {}); }, []);
  useEffect(() => {
    setData(null);
    api.requests({ ...filter, page, limit: 50 }).then(setData).catch((e) => setErr(e.message));
  }, [filter, page]);

  const setField = (k, v) => { setPage(1); setFilter((f) => ({ ...f, [k]: v })); };

  const FILTERS = [
    ["application", "Application", facets?.applications],
    ["workflow", "Workflow", facets?.workflows],
    ["department", "Department", facets?.departments],
    ["model", "Model", facets?.models],
    ["provider", "Provider", facets?.providers],
    ["taskType", "Task type", facets?.taskTypes],
  ];

  const columns = [
    { key: "timestamp", header: "Time", render: (r) => <span className="whitespace-nowrap text-gray-500">{fmt.date(r.timestamp)}</span> },
    { key: "application", header: "App" },
    { key: "workflow", header: "Workflow" },
    { key: "taskType", header: "Task", render: (r) => {
      const c = CLASSIFY[r.classifiedBy] || CLASSIFY.keyword;
      return (
        <span className="flex flex-col gap-0.5">
          <span>{r.taskType || "—"}</span>
          <span><Badge tone={c.tone}>{c.label}</Badge></span>
        </span>
      );
    } },
    { key: "model", header: "Served", render: (r) => (
      r.modelRequested && r.modelRequested !== r.model
        ? <span><span className="text-gray-400 line-through">{r.modelRequested}</span> → <span className="font-medium">{r.model}</span></span>
        : <span>{r.model}</span>
    ) },
    { key: "routingDecision", header: "Routing", render: (r) => (
      <span className="flex flex-wrap gap-1">
        <Badge tone={ROUTING_TONE[r.routingDecision]}>{r.routingDecision}</Badge>
        {r.status === "blocked" && <Badge tone="red">blocked</Badge>}
        {r.status === "failure" && <Badge tone="amber">failed</Badge>}
      </span>
    ) },
    { key: "totalTokens", header: "Tokens", render: (r) => fmt.num(r.totalTokens) },
    { key: "totalCost", header: "Cost", render: (r) => fmt.usd(r.totalCost) },
    { key: "latencyMs", header: "Latency", render: (r) => fmt.ms(r.latencyMs) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gyde-charcoal">Requests</h1>
        <p className="text-sm text-gray-500">One record per request — model requested vs served, routing decision, cost.</p>
      </div>

      <Card>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
          {FILTERS.map(([key, label, options]) => (
            <div key={key}>
              <div className="label mb-1">{label}</div>
              <select className="input w-full" value={filter[key]} onChange={(e) => setField(key, e.target.value)}>
                <option value="">All</option>
                {(options || []).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          ))}
        </div>
      </Card>

      <Card>
        {data === null ? <Spinner /> : (
          <>
            <Table columns={columns} rows={data.items} empty="No matching requests." />
            <div className="mt-4 flex items-center justify-between text-sm text-gray-500">
              <span>{fmt.num(data.total)} records</span>
              <div className="flex items-center gap-2">
                <button className="btn-outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Prev</button>
                <span>Page {page}</span>
                <button className="btn-outline" disabled={page * data.limit >= data.total} onClick={() => setPage((p) => p + 1)}>Next</button>
              </div>
            </div>
          </>
        )}
      </Card>
      {err && <div className="text-red-600">{err}</div>}
    </div>
  );
}
