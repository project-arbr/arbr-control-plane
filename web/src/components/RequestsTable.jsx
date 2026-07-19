import React, { useEffect, useState, useCallback, useRef } from "react";
import { api, fmt } from "../api.js";
import { Card, Table, Badge, Drawer, Stat, CodeBlock } from "./ui.jsx";

const ROUTING_TONE = { passthrough: "gray", explicit: "teal", rule: "green", auto: "indigo", ai: "violet", budget: "red", cache: "charcoal", fallback: "amber" };

const CLASSIFY = {
  provided: { tone: "gray", label: "provided" },
  keyword:  { tone: "gray", label: "rule-based" },
  ai:       { tone: "violet", label: "AI" },
};

// One node in the request-flow strip. Caps width + wraps so long model ids
// (e.g. "moonshotai.kimi-k2.5") don't push the strip off the drawer.
function FlowNode({ label, value, sub }) {
  return (
    <div className="flex max-w-[150px] shrink-0 flex-col items-center rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center">
      <div className="text-[10px] uppercase tracking-wide text-gray-400">{label}</div>
      <div className="break-words text-sm font-medium text-arbr-charcoal">{value}</div>
      {sub && <div className="break-words text-[10px] text-gray-400">{sub}</div>}
    </div>
  );
}

// Plain-English narration of WHY this model was served, built from routingExplain
// (captured at decision time) plus the flat record fields. Falls back gracefully on
// older records that predate routingExplain.
function explainRouting(r) {
  const x = r.routingExplain || {};
  const d = r.routingDecision;
  const lines = [];
  const clsBits = [
    r.taskType,
    r.difficulty ? `${r.difficulty}${r.difficultyScore ? ` ${r.difficultyScore}/10` : ""}` : null,
    r.confidence != null ? `confidence ${Number(r.confidence).toFixed(2)}` : null,
  ].filter(Boolean).join(", ");

  if (d === "explicit") {
    lines.push(`The client explicitly requested ${r.model}, so Arbr served it directly without applying a routing policy.`);
  } else if (d === "rule") {
    const c = x.rule?.condition || {};
    const on = [c.taskType && `task ${c.taskType}`, c.application && `app ${c.application}`, c.workflow && `workflow ${c.workflow}`].filter(Boolean).join(", ");
    lines.push(`A routing rule${on ? ` (matching ${on})` : ""} directed this request to ${r.model}.`);
    if (x.rule?.note) lines.push(`Rule note: ${x.rule.note}`);
  } else if (d === "ai") {
    lines.push(`Auto-routing: Arbr classified this as ${clsBits || "unknown"}, and the ${x.policy?.source || "global"} AI policy mapped it to ${r.model}.`);
    if (x.policy?.adjustedByDifficulty && x.policy?.base) {
      lines.push(`The policy's base pick was ${x.policy.base}; difficulty${x.policy.effDifficulty ? ` (${x.policy.effDifficulty})` : ""} adjusted it to ${r.model}.`);
    }
  } else if (d === "auto") {
    lines.push(`Guardrail auto-routing substituted ${r.model} based on the task type (${r.taskType || "—"}).`);
  } else if (d === "cache") {
    lines.push(`Served from Arbr's response cache — an identical earlier request to ${r.model} was reused, with no new model call.`);
  } else if (d === "fallback") {
    lines.push(`The primary model failed, so Arbr fell back to ${r.model}.`);
  } else if (d === "budget") {
    lines.push(`A budget cap was breached, so Arbr overrode the routing.`);
  } else {
    lines.push(x.defaultScope === "app"
      ? `No rule or policy matched, so Arbr served this application's default model, ${r.model}.`
      : `No model was pinned and no rule or policy matched, so Arbr served the default model, ${r.model}.`);
  }

  const ov = x.override;
  if (ov?.type === "budget" && ov.action === "downgrade") {
    lines.push(`Budget override: cap "${ov.cap?.scope}" (${ov.cap?.period}, $${ov.cap?.limit}) was over limit, so ${ov.from} was downgraded to ${ov.to}.`);
  } else if (ov?.type === "budget" && ov.action === "block") {
    lines.push(`Budget cap "${ov.cap?.scope}" (${ov.cap?.period}, $${ov.cap?.limit}) was over limit; the request was blocked.`);
  } else if (ov?.type === "fallback") {
    lines.push(`Fallback: ${ov.from} failed, so Arbr retried on ${ov.to}.`);
  } else if (ov?.type === "allowed") {
    lines.push(`${ov.from} is not in this API key's allowed-model set, so Arbr served the key's default, ${ov.to}.`);
  } else if (ov?.type === "optout") {
    lines.push(`${ov.from} is opted out for this application, so Arbr served ${ov.to} instead.`);
  }

  if (x.classificationUsed === false && r.taskType && (d === "explicit" || d === "passthrough" || d === "cache")) {
    lines.push(`Classification ran (${r.taskType}${r.difficulty ? `, ${r.difficulty}` : ""}) but did not influence routing.`);
  }
  return lines;
}

function RoutingExplanation({ r }) {
  const lines = explainRouting(r);
  return (
    <div className="rounded-lg border border-arbr-accent-200 bg-arbr-accent-50 p-4">
      <div className="mb-1 flex items-center gap-2">
        <span className="label">Why this routing</span>
        <Badge tone={ROUTING_TONE[r.routingDecision]}>{r.routingDecision}</Badge>
      </div>
      <ul className="space-y-1 text-sm text-arbr-charcoal">
        {lines.map((l, i) => <li key={i}>{l}</li>)}
      </ul>
    </div>
  );
}
const FlowArrow = () => <span className="shrink-0 text-gray-300">→</span>;

// Visualizes a single request's actual path: app → Arbr (classify → route) → model → provider,
// built entirely from the logged record. No backend dependency.
function RequestFlow({ r }) {
  const classify = CLASSIFY[r.classifiedBy] || CLASSIFY.keyword;
  const classifySub = [
    classify.label,
    r.difficulty ? `${r.difficulty}${r.difficultyScore ? ` ${r.difficultyScore}/10` : ""}` : null,
    r.confidence != null ? `conf ${Number(r.confidence).toFixed(2)}` : null,
  ].filter(Boolean).join(" · ");
  const changed = r.modelRequested && r.modelRequested !== r.model;
  return (
    <div className="flex items-center gap-2 overflow-x-auto pb-1">
      <FlowNode label="App" value={r.application || "—"} />
      <FlowArrow />
      <FlowNode label="Classify" value={r.taskType || "—"} sub={classifySub} />
      <FlowArrow />
      <div className="flex shrink-0 flex-col items-center gap-1 px-1">
        <span className="text-[10px] uppercase tracking-wide text-gray-400">Route</span>
        <Badge tone={ROUTING_TONE[r.routingDecision]}>{r.routingDecision}</Badge>
      </div>
      <FlowArrow />
      {r.cacheHit && (<><FlowNode label="Cache" value="hit" /><FlowArrow /></>)}
      <FlowNode
        label="Model"
        value={changed
          ? <span><span className="text-gray-400 line-through">{r.modelRequested}</span> → {r.model}</span>
          : (r.model || "—")}
      />
      <FlowArrow />
      <FlowNode label="Provider" value={r.provider || "—"} />
      {r.status !== "success" && <span className="shrink-0"><Badge tone="red">{r.status}</Badge></span>}
    </div>
  );
}

const EMPTY_FILTER = { application: "", workflow: "", department: "", model: "", provider: "", taskType: "", status: "", requestId: "" };

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
  const [searchInput, setSearchInput] = useState(""); // raw requestId input (debounced into filter)
  const [activePeriod, setActivePeriod] = useState(defaultPeriodIndex);
  const [data, setData]       = useState(null);
  const [stats, setStats]     = useState(null);
  const [page, setPage]       = useState(1);
  const [err, setErr]         = useState(null);
  const [detail, setDetail]   = useState(null);   // full record for the drilldown
  const [detailOpen, setDetailOpen] = useState(false);

  const debounceRef = useRef(null);
  const onSearchChange = (val) => {
    setSearchInput(val);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      setFilter((f) => ({ ...f, requestId: val.trim() }));
    }, 400);
  };

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

      {/* Search + status row */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            className="input w-full pl-8"
            placeholder="Search by request ID…"
            value={searchInput}
            onChange={(e) => onSearchChange(e.target.value)}
          />
        </div>
        <div className="shrink-0">
          <select
            className="input"
            value={filter.status}
            onChange={(e) => { setPage(1); setFilter((f) => ({ ...f, status: e.target.value })); }}
          >
            <option value="">All statuses</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="blocked">Blocked</option>
          </select>
        </div>
      </div>

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
                <button
                  className="btn-outline"
                  onClick={() => api.exportRequests({ ...filter, ...fixedFilters, ...range })}
                  title="Download all matching records as CSV"
                >
                  Export CSV
                </button>
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
              <RoutingExplanation r={detail} />
              <RequestFlow r={detail} />
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Status" value={detail.status} />
                <Stat label="Latency" value={fmt.ms(detail.latencyMs)} />
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
