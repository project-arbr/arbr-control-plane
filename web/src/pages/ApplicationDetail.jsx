import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, fmt } from "../api.js";
import { Card, Badge, Spinner, Toggle, Tabs, useTabParam, ConfirmDialog, Stat, Table } from "../components/ui.jsx";
import RequestsTable from "../components/RequestsTable.jsx";

const TABS = [
  ["overview",  "Overview"],
  ["policy",    "Routing policy"],
];

const TIER_CONFIG = [
  { tier: "light",   label: "Light",   badge: "teal",   desc: "Fast, cheap, low-latency tasks" },
  { tier: "mid",     label: "Medium",  badge: "indigo",  desc: "Balanced capability and cost" },
  { tier: "premium", label: "Complex", badge: "violet",  desc: "Deep reasoning and multi-step tasks" },
];

const TIER_TONE = { premium: "violet", mid: "indigo", light: "teal" };

function Chevron({ open }) {
  return (
    <svg className={`h-4 w-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

// ── Allowed-models picker (opt-out = excluded from gateway + AI generation) ────

function ModelPicker({ models, excluded, onChange }) {
  const [query, setQuery] = useState("");

  const byProvider = {};
  for (const m of models) {
    if (!byProvider[m.provider]) byProvider[m.provider] = [];
    byProvider[m.provider].push(m);
  }

  const q = query.toLowerCase();
  const includedCount = models.length - excluded.length;

  const toggle      = (id) => onChange(excluded.includes(id) ? excluded.filter((x) => x !== id) : [...excluded, id]);
  const selectAll   = (ids) => onChange(excluded.filter((x) => !ids.includes(x)));
  const deselectAll = (ids) => onChange([...new Set([...excluded, ...ids])]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      <div className="flex items-center gap-3 border-b border-gray-100 bg-gray-50 px-3 py-2.5">
        <div className="relative flex-1">
          <svg className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            className="input w-full pl-8 py-1 text-xs"
            placeholder="Search models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="shrink-0 text-xs text-gray-500">{includedCount} / {models.length} allowed</span>
        <button className="btn-ghost text-xs shrink-0" onClick={() => onChange([])}>All</button>
        <button className="btn-ghost text-xs shrink-0" onClick={() => onChange(models.map((m) => m.id))}>None</button>
      </div>

      <div className="max-h-56 overflow-y-auto divide-y divide-gray-50">
        {Object.entries(byProvider).map(([prov, provModels]) => {
          const filtered = provModels.filter((m) => !q || m.id.toLowerCase().includes(q) || prov.toLowerCase().includes(q));
          if (!filtered.length) return null;
          const provIds = filtered.map((m) => m.id);
          return (
            <div key={prov}>
              {(() => {
                const allIn  = provIds.every((id) => !excluded.includes(id));
                const someIn = provIds.some((id) => !excluded.includes(id));
                return (
                  <label className="flex cursor-pointer items-center gap-2.5 bg-gray-50/70 px-3 py-1.5 hover:bg-gray-100/60 transition-colors">
                    <input
                      type="checkbox"
                      ref={(el) => { if (el) el.indeterminate = someIn && !allIn; }}
                      checked={allIn}
                      onChange={() => allIn ? deselectAll(provIds) : selectAll(provIds)}
                      className="rounded shrink-0"
                    />
                    <span className="text-xs font-semibold uppercase tracking-wide text-gray-500">{prov}</span>
                    <span className="ml-auto text-xs text-gray-400">
                      {provIds.filter((id) => !excluded.includes(id)).length}/{provIds.length}
                    </span>
                  </label>
                );
              })()}
              {filtered.map((m) => {
                const included = !excluded.includes(m.id);
                return (
                  <label
                    key={m.id}
                    className={`flex cursor-pointer items-center gap-3 py-1.5 pr-3 pl-9 transition-colors hover:bg-gray-50 ${!included ? "opacity-40" : ""}`}
                  >
                    <input type="checkbox" checked={included} onChange={() => toggle(m.id)} className="rounded shrink-0" />
                    <span className="flex-1 font-mono text-xs text-arbr-charcoal truncate">{m.id}</span>
                    <Badge tone={TIER_TONE[m.tier] || "gray"}>{m.tier}</Badge>
                  </label>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Combined routing policy tab ────────────────────────────────────────────────
// modelOptOut drives both gateway enforcement AND AI generation exclusions.

function RoutingPolicyTab({ appName, initialAssignments, initialModelOptOut, models, onSaved }) {
  const [globalPol, setGlobalPol]     = useState(null);
  const [assignments, setAssignments] = useState(initialAssignments || null);
  // excluded = opted-out models: blocked at gateway + excluded from AI generation
  const [excluded, setExcluded]       = useState(initialModelOptOut || []);
  const [expanded, setExpanded]       = useState({ light: false, mid: false, premium: false, custom: true });
  const [busy, setBusy]               = useState(false);
  const [msg, setMsg]                 = useState(null);
  const [allowedMsg, setAllowedMsg]   = useState(null);
  const [confirmGen, setConfirmGen]   = useState(false);
  const [goal, setGoal]               = useState("balanced"); // cost | balanced | quality
  const [sim, setSim]                 = useState(null);        // impact simulation result

  useEffect(() => { api.aiPolicy().then(setGlobalPol).catch((e) => setMsg(e.message)); }, []);

  if (!globalPol) return <Spinner />;

  const usingGlobal = assignments === null;
  const catalog = globalPol.taskCatalog || [];
  const byTier  = { light: [], mid: [], premium: [] };
  for (const task of catalog) { if (byTier[task.tier]) byTier[task.tier].push(task); }

  const effectiveAssignments = usingGlobal ? (globalPol.assignments || {}) : assignments;

  // True when the allowed-models selection differs from what's persisted.
  const allowedDirty =
    JSON.stringify([...excluded].sort()) !== JSON.stringify([...(initialModelOptOut || [])].sort());

  // Simulator delta labels. Cost is a real projection; capability index is a heuristic proxy.
  const pctChange = (cur, proj) => (cur > 0 ? Math.round(((proj - cur) / cur) * 100) : 0);
  const costDeltaLabel = (s) => { const p = pctChange(s.current?.cost || 0, s.projected?.cost || 0); return `${p > 0 ? "+" : ""}${p}% vs current`; };
  const capLabel = (x) => (x == null ? "—" : Number(x).toFixed(2));
  const capDeltaLabel = (s) => {
    const c = s.current?.capabilityIndex, p = s.projected?.capabilityIndex;
    if (c == null || p == null) return null;
    const d = p - c; return `${d >= 0 ? "+" : ""}${d.toFixed(2)} vs current`;
  };

  function dominantModel(tier) {
    const counts = {};
    for (const task of (byTier[tier] || [])) {
      const m = effectiveAssignments[task.id];
      if (m) counts[m] = (counts[m] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
  }

  const setOne      = (t, model) => setAssignments((a) => ({ ...(a || globalPol.assignments || {}), [t]: model }));
  const toggleTier  = (tier) => setExpanded((e) => ({ ...e, [tier]: !e[tier] }));

  // Save both modelOptOut and aiPolicyAssignments together.
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.setAppConfig(appName, { modelOptOut: excluded, aiPolicyAssignments: assignments });
      setMsg("Saved"); setTimeout(() => setMsg(null), 1500);
      onSaved?.();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  // Save the allowed-models opt-out on its own. Independent of the routing policy,
  // so it works even when the app is on the global default policy (no Save button there).
  const saveAllowed = async () => {
    setBusy(true); setAllowedMsg(null);
    try {
      await api.setAppConfig(appName, { modelOptOut: excluded });
      setAllowedMsg("Saved"); setTimeout(() => setAllowedMsg(null), 1500);
      onSaved?.();
    } catch (e) { setAllowedMsg(e.message); }
    finally { setBusy(false); }
  };

  // Generate uses excluded as the exclusion list automatically, optimizing for the chosen goal.
  const generate = async () => {
    setConfirmGen(false);
    setBusy(true); setMsg(`Generating (goal: ${goal})…`); setSim(null);
    try {
      const result = await api.generateAppPolicy(appName, excluded, goal);
      setAssignments(result.assignments);
      setSim(result.simulation || null);
      setMsg(result.generatorModel ? `Done — via ${result.generatorModel}` : "Done");
      setTimeout(() => setMsg(null), 3000);
      onSaved?.();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  // Re-project impact for the current (possibly hand-edited) assignments over recent traffic.
  const resimulate = async () => {
    setBusy(true);
    try { setSim(await api.simulateAppPolicy(appName, effectiveAssignments)); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const resetToGlobal = async () => {
    setBusy(true);
    try {
      await api.setAppConfig(appName, { aiPolicyAssignments: null });
      setAssignments(null);
      setMsg("Reset to global default.");
      onSaved?.();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">

      {/* ── Section 1: Allowed models ── */}
      <Card title="Allowed models">
        <p className="mb-3 text-sm text-gray-500">
          Models deselected here are blocked for this application at the gateway and excluded from AI policy generation.
        </p>
        <ModelPicker models={models} excluded={excluded} onChange={setExcluded} />
        <div className="mt-3 flex items-center gap-3">
          <button className="btn-secondary text-xs" disabled={busy || !allowedDirty} onClick={saveAllowed}>
            {busy ? "Saving…" : "Save allowed models"}
          </button>
          {allowedDirty && <span className="text-xs text-amber-600">Unsaved changes</span>}
          {allowedMsg && <span className="text-xs text-gray-500">{allowedMsg}</span>}
        </div>
      </Card>

      {/* ── Section 2: Routing policy ── */}
      <Card title="Routing policy">
        {confirmGen && (
          <ConfirmDialog
            title="Generate policy with AI?"
            message={`The AI will assign models to all task types using the ${models.length - excluded.length} allowed model${models.length - excluded.length !== 1 ? "s" : ""}. Existing assignments will be overwritten.`}
            confirmLabel="Generate"
            onConfirm={generate}
            onCancel={() => setConfirmGen(false)}
          />
        )}
        <div className="space-y-4">
          {/* Goal selector — generation optimizes the cost/capability blend for this goal */}
          <div className="flex items-center gap-2 text-xs">
            <span className="text-gray-500">Optimize for:</span>
            {["cost", "balanced", "quality"].map((g) => (
              <button key={g} type="button"
                className={goal === g ? "btn-secondary text-xs" : "btn-outline text-xs"}
                disabled={busy} onClick={() => setGoal(g)}>
                {g[0].toUpperCase() + g.slice(1)}
              </button>
            ))}
          </div>
          {/* Action bar */}
          <div className="flex flex-wrap items-center gap-3">
            {usingGlobal ? (
              <>
                <div className="flex-1 text-sm text-gray-500">
                  Using <strong>global default</strong> policy.
                </div>
                <button className="btn-secondary text-xs" disabled={busy} onClick={() => setConfirmGen(true)}>
                  {busy ? "Generating…" : `Generate with AI${excluded.length > 0 ? ` (${models.length - excluded.length} models)` : ""}`}
                </button>
              </>
            ) : (
              <>
                <button className="btn-secondary text-xs" disabled={busy} onClick={save}>Save</button>
                <button className="btn-outline text-xs" disabled={busy} onClick={() => setConfirmGen(true)}>
                  {busy ? "Generating…" : `Regenerate with AI${excluded.length > 0 ? ` (${models.length - excluded.length} models)` : ""}`}
                </button>
                <button className="btn-ghost text-xs" disabled={busy} onClick={resetToGlobal}>Reset to global default</button>
              </>
            )}
            {msg && <span className="text-xs text-gray-500">{msg}</span>}
          </div>

          {/* Impact simulator — projected cost (real) + capability index (heuristic proxy) over recent traffic */}
          {sim && (
            <div className="space-y-2 rounded-lg border border-gray-200 p-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">
                  Projected impact{" "}
                  <span className="text-xs font-normal text-gray-400">
                    (last {sim.windowDays}d · cost is real, capability is an estimate)
                  </span>
                </span>
                <button className="btn-ghost text-xs" disabled={busy} onClick={resimulate}>Re-simulate</button>
              </div>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="Projected cost" value={fmt.usd(sim.projected?.cost)} sub={costDeltaLabel(sim)} />
                <Stat label="Current cost" value={fmt.usd(sim.current?.cost)} />
                <Stat label="Capability index" value={capLabel(sim.projected?.capabilityIndex)} sub={capDeltaLabel(sim)} />
              </div>
              {sim.rows?.length > 0 && (
                <Table
                  columns={[
                    { key: "taskType", header: "Task", render: (r) => r.taskType },
                    { key: "proposedModel", header: "Model", render: (r) => r.proposedModel || "—" },
                    { key: "requests", header: "Reqs", render: (r) => fmt.num(r.requests) },
                    { key: "saved", header: "Saved", render: (r) => fmt.usd(r.saved) },
                  ]}
                  rows={sim.rows.slice(0, 8)}
                />
              )}
            </div>
          )}

          {/* Tier accordions */}
          <div className="space-y-2">
            {TIER_CONFIG.map(({ tier, label, badge, desc }) => {
              const tasks    = byTier[tier] || [];
              const dominant = dominantModel(tier);
              const isOpen   = expanded[tier];
              // filter model options to only allowed models
              const allowedModels = models.filter((m) => !excluded.includes(m.id));
              return (
                <div key={tier} className="overflow-hidden rounded-lg border border-gray-200">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-gray-50"
                    onClick={() => toggleTier(tier)}
                  >
                    <div className="flex items-center gap-3">
                      <Badge tone={badge}>{label}</Badge>
                      <span className="text-sm font-medium text-arbr-charcoal">{tasks.length} tasks</span>
                      <span className="hidden text-xs text-gray-400 sm:inline">{desc}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      {dominant && <span className="hidden truncate font-mono text-xs text-gray-500 sm:block max-w-[180px]">{dominant}</span>}
                      <Chevron open={isOpen} />
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-gray-100">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-400">
                            <th className="w-1/4 px-4 py-2 font-medium">Task</th>
                            <th className="px-4 py-2 font-medium">Description</th>
                            <th className="w-60 px-4 py-2 font-medium">Model</th>
                          </tr>
                        </thead>
                        <tbody>
                          {tasks.map((task) => (
                            <tr key={task.id} className="border-t border-gray-100">
                              <td className="px-4 py-2 font-medium text-arbr-charcoal">{task.label}</td>
                              <td className="px-4 py-2 text-xs text-gray-500">{task.description}</td>
                              <td className="px-4 py-2">
                                <select
                                  className="input w-full"
                                  value={effectiveAssignments[task.id] || ""}
                                  onChange={(e) => setOne(task.id, e.target.value)}
                                  disabled={usingGlobal}
                                >
                                  <option value="">(use default)</option>
                                  {allowedModels.map((m) => (
                                    <option key={m.id} value={m.id}>{m.id} ({m.tier})</option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Custom task types */}
          {globalPol.customTaskTypes?.length > 0 && !usingGlobal && (
            <div className="overflow-hidden rounded-lg border border-gray-200">
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-gray-50"
                onClick={() => toggleTier("custom")}
              >
                <div className="flex items-center gap-3">
                  <Badge tone="charcoal">Custom</Badge>
                  <span className="text-sm font-medium text-arbr-charcoal">{globalPol.customTaskTypes.length} tasks</span>
                  <span className="hidden text-xs text-gray-400 sm:inline">Task types seen in traffic, not in built-in catalog</span>
                </div>
                <Chevron open={expanded.custom} />
              </button>
              {expanded.custom && (
                <div className="border-t border-gray-100">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-400">
                        <th className="w-1/4 px-4 py-2 font-medium">Task type</th>
                        <th className="w-60 px-4 py-2 font-medium">Model</th>
                      </tr>
                    </thead>
                    <tbody>
                      {globalPol.customTaskTypes.map((taskId) => (
                        <tr key={taskId} className="border-t border-gray-100">
                          <td className="px-4 py-2 font-mono text-sm font-medium text-arbr-charcoal">{taskId}</td>
                          <td className="px-4 py-2">
                            <select
                              className="input w-full"
                              value={assignments?.[taskId] || ""}
                              onChange={(e) => setOne(taskId, e.target.value)}
                            >
                              <option value="">(use default)</option>
                              {models.filter((m) => !excluded.includes(m.id)).map((m) => (
                                <option key={m.id} value={m.id}>{m.id} ({m.tier})</option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

// ── Overview tab ───────────────────────────────────────────────────────────────

function AppOverview({ appName }) {
  const [stats, setStats] = useState(null);
  const [err, setErr]     = useState(null);

  useEffect(() => {
    api.overview({ application: appName }).then(setStats).catch((e) => setErr(e.message));
  }, [appName]);

  if (err) return <div className="text-red-600 text-sm">{err}</div>;
  if (!stats) return <Spinner />;

  const successRate = stats.totalRequests > 0
    ? (((stats.totalRequests - stats.failures) / stats.totalRequests) * 100).toFixed(1) + "%"
    : "—";

  const cards = [
    { label: "Total requests", value: fmt.num(stats.totalRequests) },
    { label: "Total cost",     value: fmt.usd(stats.totalCost), sub: `${fmt.usd(stats.avgCostPerRequest)} / req` },
    { label: "Total tokens",   value: fmt.num(stats.totalTokens) },
    { label: "Avg latency",    value: fmt.ms(stats.avgLatency) },
    { label: "Success rate",   value: successRate,
      highlight: stats.failures > 0 && stats.totalRequests > 0 && (stats.failures / stats.totalRequests) > 0.05,
      sub: stats.failures > 0 ? `${fmt.num(stats.failures)} failed` : null },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {cards.map(({ label, value, sub, highlight }) => (
        <div key={label} className={`card px-5 py-4 ${highlight ? "border-red-200 bg-red-50" : ""}`}>
          <div className="label">{label}</div>
          <div className={`mt-1 text-2xl font-bold ${highlight ? "text-red-600" : "text-arbr-charcoal"}`}>{value}</div>
          {sub && <div className="mt-0.5 text-xs text-gray-400">{sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ApplicationDetail() {
  const { name } = useParams();
  const appName  = decodeURIComponent(name || "");

  const [config, setConfig]     = useState(null);
  const [models, setModels]     = useState([]);
  const [killMsg, setKillMsg]   = useState("");
  const [killBusy, setKillBusy] = useState(false);
  const [err, setErr]           = useState(null);
  const [tab, setTab]           = useTabParam(TABS);

  const loadConfig = () =>
    api.appConfig(appName)
      .then((c) => { setConfig(c); setKillMsg(c.killSwitchMessage || ""); })
      .catch((e) => setErr(e.message));

  useEffect(() => {
    Promise.all([loadConfig(), api.models({ live: true }).then(setModels).catch(() => {})]);
  }, [appName]);

  const toggleKill = async (enabled) => {
    setKillBusy(true);
    try {
      const c = await api.setAppConfig(appName, { killSwitchEnabled: enabled, killSwitchMessage: killMsg || null });
      setConfig(c);
    } catch (e) { setErr(e.message); }
    finally { setKillBusy(false); }
  };

  const saveKillMsg = async () => {
    setKillBusy(true);
    try {
      const c = await api.setAppConfig(appName, { killSwitchMessage: killMsg || null });
      setConfig(c);
    } catch (e) { setErr(e.message); }
    finally { setKillBusy(false); }
  };

  const isKilled = config?.killSwitchEnabled ?? false;

  return (
    <div className="space-y-6">
      {/* Breadcrumb + header */}
      <div>
        <div className="text-xs text-gray-400 mb-1">
          <Link to="/applications" className="hover:text-arbr-charcoal">Applications</Link>
          <span className="mx-1">/</span>
          <span>{appName}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-arbr-charcoal">{appName}</h1>
            {isKilled && (
              <span className="mt-1 inline-flex items-center rounded text-xs font-medium text-red-600 bg-red-100 px-2 py-0.5">
                Disconnected — all requests blocked
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-gray-500">{isKilled ? "Disconnected" : "Active"}</span>
            <Toggle checked={!isKilled} onChange={(active) => toggleKill(!active)} label="connected" disabled={killBusy} />
          </div>
        </div>

        {isKilled && (
          <div className="mt-3 flex items-center gap-3">
            <input
              className="input w-80"
              placeholder="Custom message shown to callers (optional)"
              value={killMsg}
              onChange={(e) => setKillMsg(e.target.value)}
            />
            <button className="btn-outline text-xs" disabled={killBusy} onClick={saveKillMsg}>Save message</button>
          </div>
        )}
      </div>

      {err && <div className="text-red-600 text-sm">{err}</div>}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "overview" && (
        <div className="space-y-6">
          <AppOverview appName={appName} />
          <RequestsTable
            fixedFilters={{ application: appName }}
            hiddenFilterKeys={["application"]}
            showStats={false}
          />
        </div>
      )}

      {tab === "policy" && (
        config === null ? <Spinner /> : (
          <RoutingPolicyTab
            appName={appName}
            initialAssignments={config.aiPolicyAssignments}
            initialModelOptOut={config.modelOptOut || []}
            models={models}
            onSaved={loadConfig}
          />
        )
      )}
    </div>
  );
}
