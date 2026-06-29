import React, { useEffect, useState, useCallback } from "react";
import { api, fmt } from "../api.js";
import { Card, Table, Badge, Drawer, Stat, CodeBlock } from "./ui.jsx";

const ROUTING_TONE = { passthrough: "gray", explicit: "teal", rule: "green", auto: "indigo", ai: "violet", budget: "red", cache: "charcoal", fallback: "amber" };

const CLASSIFY = {
  provided: { tone: "gray", label: "provided" },
  keyword:  { tone: "gray", label: "rule-based" },
  ai:       { tone: "violet", label: "AI" },
};

const EMPTY_FILTER = { application: "", workflow: "", department: "", model: "", provider: "", taskType: "" };

const PERIODS = [
  { label: "Today",    days: 0 },
  { label: "7 days",   days: 7 },
  { label: "30 days",  days: 30 },
  { label: "All time", days: null },
];

function periodRange(days) {
  if (days === null) return {};
  const to = new Date();
  const from = new Date(to);
  if (days === 0) { from.setHours(0, 0, 0, 0); } else { from.setDate(from.getDate() - days); }
  return { from: from.toISOString(), to: to.toISOString() };
}

function StatCard({ label, value, sub, highlight }) {
  return (
    <div className={`card px-5 py-4 ${highlight ? "border-red-200 bg-red-50" : ""}`}>
      <div className="label">{label}</div>
      <div className={`mt-1 text-2xl font-bold ${highlight ? "text-red-600" : "text-arbr-charcoal"}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-gray-400">{sub}</div>}
    </div>
  );
}

// fixedFilters: values locked in from the parent context (e.g. { application: "my-app" })
// hiddenFilterKeys: filter keys to hide from the UI (e.g. ["application"] when on an app detail page)
export default function RequestsTable({ fixedFilters = {}, hiddenFilterKeys = [], showStats = true, defaultPeriodIndex = 1 }) {
  const [facets, setFacets]   = useState(null);
  const [filter, setFilter]   = useState(EMPTY_FILTER);
  const [activePeriod, setActivePeriod] = useState(defaultPeriodIndex);
  const [data, setData]       = useState(null);
  const [stats, setStats]     = useState(null);
  const [page, setPage]       = useState(1);
  const [err, setErr]         = useState(null);
  const [detail, setDetail]   = useState(null);   // full record for the drilldown
  const [detailOpen, setDetailOpen] = useState(false);

  const openDetail = (row) => {
    setDetailOpen(true); setDetail(null);
    api.request(row.requestId).then(setDetail).catch((e) => setDetail({ _error: e.message }));
  };

  useEffect(() => { api.facets().then(setFacets).catch(() => {}); }, []);

  const range = periodRange(PERIODS[activePeriod].days);

  const load = useCallback(() => {
    setData(null);
    if (showStats) setStats(null);
    const combined = { ...filter, ...fixedFilters, ...range };
    const calls = [api.requests({ ...combined, page, limit: 50 })];
    if (showStats) calls.push(api.overview(combined));
    Promise.all(calls)
      .then(([d, s]) => { setData(d); if (showStats) setStats(s); })
      .catch((e) => setErr(e.message));
  }, [filter, page, activePeriod, JSON.stringify(fixedFilters)]);

  useEffect(() => { load(); }, [load]);

  const setField = (k, v) => { setPage(1); setFilter((f) => ({ ...f, [k]: v })); };

  const ALL_FILTERS = [
    ["application", "Application", facets?.applications],
    ["workflow",    "Workflow",    facets?.workflows],
    ["department",  "Department",  facets?.departments],
    ["model",       "Model",       facets?.models],
    ["provider",    "Provider",    facets?.providers],
    ["taskType",    "Task type",   facets?.taskTypes],
  ];
  const visibleFilters = ALL_FILTERS.filter(([key]) => !hiddenFilterKeys.includes(key));

  const columns = [
    { key: "timestamp",  header: "Time",    render: (r) => <span className="whitespace-nowrap text-gray-500">{fmt.date(r.timestamp)}</span> },
    { key: "application",header: "App" },
    { key: "workflow",   header: "Workflow" },
    { key: "taskType",   header: "Task",    render: (r) => {
      const c = CLASSIFY[r.classifiedBy] || CLASSIFY.keyword;
      return (
        <span className="flex flex-col gap-0.5">
          <span>{r.taskType || "—"}</span>
          <span><Badge tone={c.tone}>{c.label}</Badge></span>
        </span>
      );
    } },
    { key: "model",      header: "Served",  render: (r) => (
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
    { key: "totalTokens",header: "Tokens",  render: (r) => fmt.num(r.totalTokens) },
    { key: "totalCost",  header: "Cost",    render: (r) => fmt.usd(r.totalCost) },
    { key: "latencyMs",  header: "Latency", render: (r) => fmt.ms(r.latencyMs) },
  ];

  const successRate = stats
    ? stats.totalRequests > 0 ? (((stats.totalRequests - stats.failures) / stats.totalRequests) * 100).toFixed(1) + "%" : "—"
    : "—";

  return (
    <div className="space-y-5">
      {/* Period selector + stat cards */}
      <div className="flex items-center justify-end">
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
          {PERIODS.map((p, i) => (
            <button
              key={p.label}
              onClick={() => { setPage(1); setActivePeriod(i); }}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                activePeriod === i ? "bg-white text-arbr-charcoal shadow-sm border border-gray-200" : "text-gray-500 hover:text-arbr-charcoal"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {showStats && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <StatCard label="Total requests" value={stats ? fmt.num(stats.totalRequests) : "—"} sub={PERIODS[activePeriod].label} />
          <StatCard label="Total cost" value={stats ? fmt.usd(stats.totalCost) : "—"} sub={stats ? `${fmt.usd(stats.avgCostPerRequest)} / req` : null} />
          <StatCard label="Total tokens" value={stats ? fmt.num(stats.totalTokens) : "—"} />
          <StatCard label="Avg latency" value={stats ? fmt.ms(stats.avgLatency) : "—"} />
          <StatCard
            label="Success rate"
            value={successRate}
            sub={stats?.failures > 0 ? `${fmt.num(stats.failures)} failed` : null}
            highlight={stats?.failures > 0 && stats?.totalRequests > 0 && (stats.failures / stats.totalRequests) > 0.05}
          />
        </div>
      )}

      {/* Filters */}
      <Card>
        <div className={`grid grid-cols-2 gap-3 ${visibleFilters.length <= 3 ? "md:grid-cols-3" : "md:grid-cols-3 lg:grid-cols-6"}`}>
          {visibleFilters.map(([key, label, options]) => (
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

      {/* Table */}
      <Card>
        {data === null ? (
          <div className="py-8 text-center text-sm text-gray-400">Loading…</div>
        ) : (
          <>
            <Table columns={columns} rows={data.items} empty="No matching requests." onRowClick={openDetail} />
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

      {err && <div className="text-red-600 text-sm">{err}</div>}

      {detailOpen && (
        <Drawer title="Request detail" onClose={() => setDetailOpen(false)}>
          {detail === null ? (
            <div className="py-8 text-center text-sm text-gray-400">Loading…</div>
          ) : detail._error ? (
            <div className="text-sm text-red-600">{detail._error}</div>
          ) : (
            <div className="space-y-5">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Status" value={detail.status} />
                <Stat label="Routing" value={detail.routingDecision} />
                <Stat label="Latency" value={fmt.ms(detail.latencyMs)} />
                <Stat label="Requested → Served" value={detail.modelRequested === detail.model ? detail.model : `${detail.modelRequested} → ${detail.model}`} />
                <Stat label="Task" value={detail.taskType || "—"} sub={`${detail.classifiedBy || "—"}${detail.difficulty ? ` · ${detail.difficulty}${detail.difficultyScore ? ` (${detail.difficultyScore}/10)` : ""}` : ""}${detail.confidence != null ? ` · conf ${Number(detail.confidence).toFixed(2)}` : ""}`} />
                <Stat label="Cost" value={fmt.usd(detail.totalCost)} />
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Prompt tok" value={fmt.num(detail.promptTokens)} sub={detail.cachedReadTokens ? `${fmt.num(detail.cachedReadTokens)} cached` : null} />
                <Stat label="Completion tok" value={fmt.num(detail.completionTokens)} />
                <Stat label="Total tok" value={fmt.num(detail.totalTokens)} />
                <Stat label="Cache saving" value={fmt.usd(detail.cacheSavingUsd)} />
              </div>
              {detail.errorMessage && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{detail.errorMessage}</div>
              )}
              <div>
                <div className="label mb-1">Request payload</div>
                {detail.messages
                  ? <CodeBlock lang="json" code={JSON.stringify(detail.messages, null, 2)} />
                  : <div className="text-xs text-gray-400">(not captured)</div>}
              </div>
              <div>
                <div className="label mb-1">Response</div>
                {detail.responseText
                  ? <CodeBlock code={detail.responseText} />
                  : <div className="text-xs text-gray-400">(not captured)</div>}
              </div>
              <div className="text-xs text-gray-400">{detail.requestId} · {fmt.date(detail.timestamp)}</div>
            </div>
          )}
        </Drawer>
      )}
    </div>
  );
}
