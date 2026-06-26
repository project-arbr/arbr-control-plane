import React, { useEffect, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { api, fmt } from "../api.js";
import { Card, Badge, Spinner, Toggle, Tabs, useTabParam } from "../components/ui.jsx";
import RequestsTable from "../components/RequestsTable.jsx";

const TABS = [
  ["overview",  "Overview"],
  ["requests",  "Requests"],
  ["policy",    "Routing policy"],
  ["models",    "Model controls"],
];

const TIER_CONFIG = [
  { tier: "light",   label: "Light",   badge: "teal",   desc: "Fast, cheap, low-latency tasks" },
  { tier: "mid",     label: "Medium",  badge: "indigo",  desc: "Balanced capability and cost" },
  { tier: "premium", label: "Complex", badge: "violet",  desc: "Deep reasoning and multi-step tasks" },
];

function Chevron({ open }) {
  return (
    <svg className={`h-4 w-4 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
    </svg>
  );
}

// ── App-level AI policy editor ─────────────────────────────────────────────────

const TIER_TONE = { premium: "violet", mid: "indigo", light: "teal" };

function ModelPicker({ models, excluded, onChange }) {
  const [query, setQuery] = useState("");

  const byProvider = {};
  for (const m of models) {
    if (!byProvider[m.provider]) byProvider[m.provider] = [];
    byProvider[m.provider].push(m);
  }

  const q = query.toLowerCase();
  const includedCount = models.length - excluded.length;

  const toggle     = (id) => onChange(excluded.includes(id) ? excluded.filter((x) => x !== id) : [...excluded, id]);
  const selectAll  = (ids) => onChange(excluded.filter((x) => !ids.includes(x)));
  const deselectAll = (ids) => onChange([...new Set([...excluded, ...ids])]);

  return (
    <div className="rounded-lg border border-gray-200 bg-white overflow-hidden">
      {/* Header + search */}
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
        <span className="shrink-0 text-xs text-gray-500">{includedCount} / {models.length} included</span>
        <button className="btn-ghost text-xs shrink-0" onClick={() => onChange([])}>All</button>
        <button className="btn-ghost text-xs shrink-0" onClick={() => onChange(models.map((m) => m.id))}>None</button>
      </div>

      {/* Scrollable list */}
      <div className="max-h-64 overflow-y-auto divide-y divide-gray-50">
        {Object.entries(byProvider).map(([prov, provModels]) => {
          const filtered = provModels.filter((m) => !q || m.id.toLowerCase().includes(q) || prov.toLowerCase().includes(q));
          if (!filtered.length) return null;
          const provIds = filtered.map((m) => m.id);
          const allIncluded = provIds.every((id) => !excluded.includes(id));
          return (
            <div key={prov}>
              {/* Provider row */}
              <div className="flex items-center justify-between bg-gray-50/70 px-3 py-1.5">
                <span className="text-xs font-semibold uppercase tracking-wide text-gray-400">{prov}</span>
                <div className="flex gap-2">
                  <button className="text-xs text-gyde-green-600 hover:underline" onClick={() => selectAll(provIds)}>all</button>
                  <button className="text-xs text-gray-400 hover:underline" onClick={() => deselectAll(provIds)}>none</button>
                </div>
              </div>
              {/* Model rows */}
              {filtered.map((m) => {
                const included = !excluded.includes(m.id);
                return (
                  <label
                    key={m.id}
                    className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-gray-50 ${!included ? "opacity-40" : ""}`}
                  >
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() => toggle(m.id)}
                      className="rounded shrink-0"
                    />
                    <span className="flex-1 font-mono text-xs text-gyde-charcoal truncate">{m.id}</span>
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

function AppAiPolicyEditor({ appName, initialAssignments, models, onSaved }) {
  const [globalPol, setGlobalPol]     = useState(null);
  const [assignments, setAssignments] = useState(initialAssignments || null);
  const [expanded, setExpanded]       = useState({ light: false, mid: false, premium: false, custom: true });
  const [busy, setBusy]               = useState(false);
  const [msg, setMsg]                 = useState(null);
  const [showPicker, setShowPicker]   = useState(false);   // model picker for generation
  const [excluded, setExcluded]       = useState([]);      // models to exclude from AI generation

  useEffect(() => { api.aiPolicy().then(setGlobalPol).catch((e) => setMsg(e.message)); }, []);

  if (!globalPol) return <Spinner />;

  const usingGlobal = assignments === null;
  const catalog = globalPol.taskCatalog || [];
  const byTier = { light: [], mid: [], premium: [] };
  for (const task of catalog) { if (byTier[task.tier]) byTier[task.tier].push(task); }

  const effectiveAssignments = usingGlobal ? (globalPol.assignments || {}) : assignments;

  function dominantModel(tier) {
    const counts = {};
    for (const task of (byTier[tier] || [])) {
      const m = effectiveAssignments[task.id];
      if (m) counts[m] = (counts[m] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
  }

  const setOne = (t, model) => setAssignments((a) => ({ ...(a || globalPol.assignments || {}), [t]: model }));
  const toggleTier = (tier) => setExpanded((e) => ({ ...e, [tier]: !e[tier] }));

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

  const generatePolicy = async () => {
    setBusy(true); setMsg("Generating policy with AI…");
    try {
      const result = await api.generateAppPolicy(appName, excluded);
      setAssignments(result.assignments);
      setShowPicker(false);
      setMsg(result.generatorModel ? `Done — via ${result.generatorModel}` : "Done");
      setTimeout(() => setMsg(null), 3000);
      onSaved?.();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.setAppConfig(appName, { aiPolicyAssignments: assignments });
      setMsg("Saved"); setTimeout(() => setMsg(null), 1500);
      onSaved?.();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const promoteToDefault = async () => {
    if (!assignments) return;
    setBusy(true); setMsg(null);
    try {
      await api.setAppDefaultPolicy(appName);
      setMsg("Set as global default."); setTimeout(() => setMsg(null), 2000);
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      {usingGlobal ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <span className="text-sm text-gray-600">Using <strong>global default</strong> AI routing policy.</span>
            <button
              className="btn-secondary text-xs"
              disabled={busy}
              onClick={() => { setShowPicker(true); }}
            >
              Generate custom policy with AI
            </button>
          </div>
          {showPicker && (
            <div className="space-y-3">
              <ModelPicker models={models} excluded={excluded} onChange={setExcluded} />
              <div className="flex items-center gap-3">
                <button className="btn-secondary text-xs" disabled={busy} onClick={generatePolicy}>
                  {busy ? "Generating…" : `Generate${excluded.length > 0 ? ` (${models.length - excluded.length} models)` : ""}`}
                </button>
                <button className="btn-ghost text-xs" disabled={busy} onClick={() => { setShowPicker(false); setExcluded([]); }}>Cancel</button>
                {msg && <span className="text-xs text-gray-500">{msg}</span>}
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <button className="btn-secondary text-xs" disabled={busy} onClick={save}>Save policy</button>
            <button
              className="btn-outline text-xs"
              disabled={busy}
              onClick={() => setShowPicker((v) => !v)}
            >
              {showPicker ? "Hide model picker" : "Regenerate with AI"}
            </button>
            <button className="btn-outline text-xs" disabled={busy} onClick={promoteToDefault}>Set as global default</button>
            <button className="btn-ghost text-xs" disabled={busy} onClick={resetToGlobal}>Reset to global default</button>
            {msg && <span className="text-xs text-gray-500">{msg}</span>}
          </div>
          {showPicker && (
            <div className="space-y-3">
              <ModelPicker models={models} excluded={excluded} onChange={setExcluded} />
              <div className="flex items-center gap-3">
                <button className="btn-secondary text-xs" disabled={busy} onClick={generatePolicy}>
                  {busy ? "Generating…" : `Generate${excluded.length > 0 ? ` (${models.length - excluded.length} models)` : ""}`}
                </button>
                <button className="btn-ghost text-xs" disabled={busy} onClick={() => { setShowPicker(false); setExcluded([]); }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
      {!showPicker && msg && usingGlobal && <span className="text-xs text-gray-500">{msg}</span>}

      <div className="space-y-2">
        {TIER_CONFIG.map(({ tier, label, badge, desc }) => {
          const tasks = byTier[tier] || [];
          const dominant = dominantModel(tier);
          const isOpen = expanded[tier];
          return (
            <div key={tier} className="overflow-hidden rounded-lg border border-gray-200">
              <button
                type="button"
                className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-gray-50"
                onClick={() => toggleTier(tier)}
              >
                <div className="flex items-center gap-3">
                  <Badge tone={badge}>{label}</Badge>
                  <span className="text-sm font-medium text-gyde-charcoal">{tasks.length} tasks</span>
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
                          <td className="px-4 py-2 font-medium text-gyde-charcoal">{task.label}</td>
                          <td className="px-4 py-2 text-xs text-gray-500">{task.description}</td>
                          <td className="px-4 py-2">
                            <select
                              className="input w-full"
                              value={effectiveAssignments[task.id] || ""}
                              onChange={(e) => setOne(task.id, e.target.value)}
                              disabled={usingGlobal}
                            >
                              <option value="">(use default)</option>
                              {models.map((m) => <option key={m.id} value={m.id}>{m.id} ({m.tier})</option>)}
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
              <span className="text-sm font-medium text-gyde-charcoal">{globalPol.customTaskTypes.length} tasks</span>
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
                      <td className="px-4 py-2 font-mono text-sm font-medium text-gyde-charcoal">{taskId}</td>
                      <td className="px-4 py-2">
                        <select
                          className="input w-full"
                          value={assignments?.[taskId] || ""}
                          onChange={(e) => setOne(taskId, e.target.value)}
                        >
                          <option value="">(use default)</option>
                          {models.map((m) => <option key={m.id} value={m.id}>{m.id} ({m.tier})</option>)}
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
  );
}

// ── Model controls (opt-out) ───────────────────────────────────────────────────

function ModelControls({ appName, initialOptOut, models, onSaved }) {
  const [optOut, setOptOut] = useState(initialOptOut || []);
  const [busy, setBusy]     = useState(false);
  const [msg, setMsg]       = useState(null);

  const toggle = (modelId) =>
    setOptOut((prev) => prev.includes(modelId) ? prev.filter((m) => m !== modelId) : [...prev, modelId]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await api.setAppConfig(appName, { modelOptOut: optOut });
      setMsg("Saved"); setTimeout(() => setMsg(null), 1500);
      onSaved?.();
    } catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  const byProvider = {};
  for (const m of models) {
    if (!byProvider[m.provider]) byProvider[m.provider] = [];
    byProvider[m.provider].push(m);
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Models checked here will not be served to this application. If routing resolves to a blocked model,
        the gateway falls back to the default model.
      </p>
      {Object.entries(byProvider).map(([prov, provModels]) => (
        <div key={prov}>
          <div className="label mb-2">{prov}</div>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {provModels.map((m) => (
              <label key={m.id} className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={optOut.includes(m.id)}
                  onChange={() => toggle(m.id)}
                  className="rounded"
                />
                <span className="font-mono text-xs">{m.id}</span>
                <Badge tone={m.tier === "premium" ? "violet" : m.tier === "mid" ? "indigo" : "teal"}>{m.tier}</Badge>
              </label>
            ))}
          </div>
        </div>
      ))}
      <div className="flex items-center gap-3 border-t border-gray-100 pt-3">
        <button className="btn-secondary" disabled={busy} onClick={save}>Save</button>
        {msg && <span className="text-xs text-gray-500">{msg}</span>}
        {optOut.length > 0 && (
          <span className="text-xs text-amber-600">{optOut.length} model{optOut.length > 1 ? "s" : ""} blocked for this app</span>
        )}
      </div>
    </div>
  );
}

// ── Overview tab ───────────────────────────────────────────────────────────────

function AppOverview({ appName }) {
  const [stats, setStats] = useState(null);
  const [err, setErr]     = useState(null);

  useEffect(() => {
    api.overview({ application: appName })
      .then(setStats)
      .catch((e) => setErr(e.message));
  }, [appName]);

  if (err) return <div className="text-red-600 text-sm">{err}</div>;
  if (!stats) return <Spinner />;

  const successRate = stats.totalRequests > 0
    ? (((stats.totalRequests - stats.failures) / stats.totalRequests) * 100).toFixed(1) + "%"
    : "—";

  const cards = [
    { label: "Total requests", value: fmt.num(stats.totalRequests) },
    { label: "Total cost",     value: fmt.usd(stats.totalCost),      sub: `${fmt.usd(stats.avgCostPerRequest)} / req` },
    { label: "Total tokens",   value: fmt.num(stats.totalTokens) },
    { label: "Avg latency",    value: fmt.ms(stats.avgLatency) },
    { label: "Success rate",   value: successRate, highlight: stats.failures > 0 && stats.totalRequests > 0 && (stats.failures / stats.totalRequests) > 0.05,
      sub: stats.failures > 0 ? `${fmt.num(stats.failures)} failed` : null },
  ];

  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {cards.map(({ label, value, sub, highlight }) => (
        <div key={label} className={`card px-5 py-4 ${highlight ? "border-red-200 bg-red-50" : ""}`}>
          <div className="label">{label}</div>
          <div className={`mt-1 text-2xl font-bold ${highlight ? "text-red-600" : "text-gyde-charcoal"}`}>{value}</div>
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

  const [config, setConfig]   = useState(null);
  const [models, setModels]   = useState([]);
  const [killMsg, setKillMsg] = useState("");
  const [killBusy, setKillBusy] = useState(false);
  const [err, setErr]         = useState(null);
  const [tab, setTab]         = useTabParam(TABS);

  const loadConfig = () =>
    api.appConfig(appName)
      .then((c) => { setConfig(c); setKillMsg(c.killSwitchMessage || ""); })
      .catch((e) => setErr(e.message));

  useEffect(() => {
    Promise.all([loadConfig(), api.models().then(setModels).catch(() => {})]);
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
          <Link to="/applications" className="hover:text-gyde-charcoal">Applications</Link>
          <span className="mx-1">/</span>
          <span>{appName}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold text-gyde-charcoal">{appName}</h1>
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

      {tab === "overview" && <AppOverview appName={appName} />}

      {tab === "requests" && (
        <RequestsTable
          fixedFilters={{ application: appName }}
          hiddenFilterKeys={["application"]}
          showStats={false}
        />
      )}

      {tab === "policy" && (
        config === null ? <Spinner /> : (
          <Card title="Application routing policy">
            <AppAiPolicyEditor
              appName={appName}
              initialAssignments={config.aiPolicyAssignments}
              models={models}
              onSaved={loadConfig}
            />
          </Card>
        )
      )}

      {tab === "models" && (
        config === null ? <Spinner /> : (
          <Card title="Model opt-out">
            <ModelControls
              appName={appName}
              initialOptOut={config.modelOptOut || []}
              models={models}
              onSaved={loadConfig}
            />
          </Card>
        )
      )}
    </div>
  );
}
