import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, Table, Toggle, Badge, Spinner, Tabs, useTabParam } from "../components/ui.jsx";
import Recommendations from "./Recommendations.jsx";

const TABS = [
  ["rules", "Rules"],
  ["auto", "Automated routing"],
  ["recommendations", "Recommendations"],
];

function cond(c) {
  const parts = [];
  if (c.taskType) parts.push(`task = ${c.taskType}`);
  if (c.application) parts.push(`app = ${c.application}`);
  if (c.workflow) parts.push(`workflow = ${c.workflow}`);
  return parts.length ? parts.join(" · ") : "—";
}

function CreateRuleForm({ models, onCreated }) {
  const [field, setField] = useState("taskType");
  const [value, setValue] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const providers = [...new Set(models.map((m) => m.provider))];
  const providerModels = models.filter((m) => m.provider === provider);

  useEffect(() => { if (!provider && providers.length) setProvider(providers[0]); }, [models]);
  useEffect(() => { if (providerModels.length) setModel(providerModels[0].id); }, [provider]);

  const submit = async () => {
    setErr(null);
    if (!value.trim()) return setErr("Enter a condition value.");
    if (!provider || !model) return setErr("Pick a target provider and model.");
    setBusy(true);
    try {
      await api.createRule({
        condition: { [field]: value.trim() },
        target: { provider, model },
        enabled,
        note: `${field}=${value.trim()} → ${model}`,
      });
      setValue("");
      await onCreated();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div>
        <div className="label mb-1">When</div>
        <select className="input" value={field} onChange={(e) => setField(e.target.value)}>
          <option value="taskType">task type</option>
          <option value="application">application</option>
          <option value="workflow">workflow</option>
        </select>
      </div>
      <div>
        <div className="label mb-1">equals</div>
        <input className="input w-44" placeholder="e.g. classification" value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
      <div className="self-center pb-2 text-gray-400">→ route to</div>
      <div>
        <div className="label mb-1">Provider</div>
        <select className="input" value={provider} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>
      <div>
        <div className="label mb-1">Model</div>
        <select className="input w-56" value={model} onChange={(e) => setModel(e.target.value)}>
          {providerModels.map((m) => <option key={m.id} value={m.id}>{m.id} ({m.tier})</option>)}
        </select>
      </div>
      <label className="flex items-center gap-2 self-center pb-1 text-sm text-gray-600">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        enable now
      </label>
      <button className="btn-secondary" disabled={busy} onClick={submit}>{busy ? "Adding…" : "Add rule"}</button>
      {err && <div className="w-full text-xs text-red-600">{err}</div>}
    </div>
  );
}

function PolicyEditor({ models }) {
  const [pol, setPol] = useState(null);
  const [mode, setMode] = useState("conservative");
  const [cheap, setCheap] = useState([]);
  const [targets, setTargets] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () =>
    api.policy().then((p) => {
      setPol(p);
      setMode(p.effective.mode);
      setCheap(p.effective.cheapTaskTypes);
      setTargets({ ...p.effective.lightTargets });
    }).catch(() => {});
  useEffect(() => { load(); }, []);

  if (!pol) return <Spinner />;

  const modelsByProvider = {};
  for (const m of models) (modelsByProvider[m.provider] ||= []).push(m);
  const providers = Object.keys(pol.effective.lightTargets).sort();
  const toggleTask = (t) => setCheap((c) => (c.includes(t) ? c.filter((x) => x !== t) : [...c, t]));

  const save = async () => {
    setBusy(true); setMsg(null);
    try { await api.setPolicy({ cheapTaskTypes: cheap, lightTargets: targets, mode }); setMsg("Saved"); setTimeout(() => setMsg(null), 1500); await load(); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };
  const resetDefaults = async () => {
    setBusy(true); setMsg(null);
    const d = pol.defaults;
    try { await api.setPolicy({ cheapTaskTypes: d.cheapTaskTypes, lightTargets: d.lightTargets, mode: d.mode }); setMsg("Reset to defaults"); setTimeout(() => setMsg(null), 1500); await load(); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-5">
      <div>
        <div className="label mb-1">Mode</div>
        <select className="input w-full max-w-md" value={mode} onChange={(e) => setMode(e.target.value)}>
          <option value="conservative">Conservative — only downgrade premium-tier models</option>
          <option value="aggressive">Aggressive — downgrade anything costlier than the target (e.g. light → lightest)</option>
        </select>
      </div>

      <div>
        <div className="label mb-2">Eligible task types (downgraded when matched)</div>
        <div className="flex flex-wrap gap-x-5 gap-y-2">
          {pol.taskTypes.map((t) => (
            <label key={t} className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={cheap.includes(t)} onChange={() => toggleTask(t)} />
              {t}
            </label>
          ))}
        </div>
      </div>

      <div>
        <div className="label mb-2">Downgrade target per provider</div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {providers.map((prov) => (
            <div key={prov} className="flex items-center gap-2">
              <span className="w-28 shrink-0 text-sm text-gray-600">{prov}</span>
              <select className="input flex-1" value={targets[prov] || ""} onChange={(e) => setTargets((t) => ({ ...t, [prov]: e.target.value }))}>
                {(modelsByProvider[prov] || []).map((m) => (
                  <option key={m.id} value={m.id}>{m.id} ({m.tier})</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-3 border-t border-gray-100 pt-3">
        <button className="btn-secondary" disabled={busy} onClick={save}>Save policy</button>
        <button className="btn-ghost" disabled={busy} onClick={resetDefaults}>Reset to defaults</button>
        {msg && <span className="text-xs text-gray-500">{msg}</span>}
      </div>
    </div>
  );
}

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

function AiPolicyEditor({ models }) {
  const [pol, setPol] = useState(null);
  const [assignments, setAssignments] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [expanded, setExpanded] = useState({ light: false, mid: false, premium: false, custom: true });
  const [lbStatus, setLbStatus] = useState(null);

  const load = () => api.aiPolicy().then((p) => { setPol(p); setAssignments({ ...p.assignments }); }).catch((e) => setMsg(e.message));
  const loadLbStatus = () => api.livebenchStatus().then(setLbStatus).catch(() => {});
  useEffect(() => { load(); loadLbStatus(); }, []);
  if (!pol) return <Spinner />;

  const syncLivebench = async () => {
    setBusy(true); setMsg("Syncing from LiveBench…");
    try {
      const result = await api.syncLivebench();
      setLbStatus({ syncedAt: new Date().toISOString(), version: result.version });
      setMsg(`LiveBench: ${result.matched} of ${result.total} models updated (v${result.version?.replace(/_/g, "-")})`);
      setTimeout(() => setMsg(null), 5000);
    }
    catch (e) { setMsg(`Sync failed: ${e.message}`); }
    finally { setBusy(false); }
  };
  const regen = async () => {
    setBusy(true); setMsg("Generating policy with AI…");
    try {
      const p = await api.regenerateAiPolicy();
      setPol(p);
      setAssignments({ ...p.assignments });
      setMsg(p.generatorModel ? `Done — via ${p.generatorModel}` : "Done");
      setTimeout(() => setMsg(null), 3000);
    }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setMsg(null);
    try { const p = await api.setAiPolicy(assignments); setPol(p); setAssignments({ ...p.assignments }); setMsg("Saved"); setTimeout(() => setMsg(null), 1500); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };
  const setOne = (t, model) => setAssignments((a) => ({ ...a, [t]: model }));
  const toggleTier = (tier) => setExpanded((e) => ({ ...e, [tier]: !e[tier] }));

  // Group catalog tasks by tier; catalog comes from API so old servers return undefined.
  const catalog = pol.taskCatalog || [];
  const byTier = { light: [], mid: [], premium: [] };
  for (const task of catalog) {
    if (byTier[task.tier]) byTier[task.tier].push(task);
  }

  // The model most frequently assigned to tasks within a tier (shown in header).
  function dominantModel(tier) {
    const counts = {};
    for (const task of (byTier[tier] || [])) {
      const m = assignments[task.id];
      if (m) counts[m] = (counts[m] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? top[0] : null;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-secondary" disabled={busy} onClick={regen}>{busy ? "Generating…" : "Generate with AI"}</button>
        <button className="btn-outline" disabled={busy} onClick={syncLivebench}>Sync from LiveBench</button>
        <button className="btn-outline" disabled={busy} onClick={save}>Save edits</button>
        {pol.generatedAt && (
          <span className="text-xs text-gray-500">
            generated {new Date(pol.generatedAt).toLocaleString()}{pol.generatorModel ? ` · ${pol.generatorModel}` : ""}
          </span>
        )}
        {msg && <span className="text-xs text-gray-500">{msg}</span>}
      </div>
      <div className="text-xs text-gray-400">
        {lbStatus?.syncedAt
          ? `LiveBench scores: synced ${new Date(lbStatus.syncedAt).toLocaleString()}${lbStatus.version ? ` · v${lbStatus.version.replace(/_/g, "-")}` : ""}`
          : "LiveBench scores: not synced — using built-in capability scores"}
      </div>

      {pol.unmapped.length > 0 && (
        <div className="text-xs text-amber-700">
          Unmapped tasks (using default model until you regenerate): {pol.unmapped.join(", ")}
        </div>
      )}

      {/* Three expandable tier cards */}
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
                              value={assignments[task.id] || ""}
                              onChange={(e) => setOne(task.id, e.target.value)}
                            >
                              <option value="">(use default)</option>
                              {models.map((m) => (
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

      {/* Custom task types observed in traffic — shown as a 4th expandable tier */}
      {pol.customTaskTypes.length > 0 && (() => {
        const dominated = Object.entries(
          pol.customTaskTypes.reduce((acc, t) => { const m = assignments[t]; if (m) acc[m] = (acc[m] || 0) + 1; return acc; }, {})
        ).sort((a, b) => b[1] - a[1])[0];
        return (
          <div className="overflow-hidden rounded-lg border border-gray-200">
            <button
              type="button"
              className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-gray-50"
              onClick={() => toggleTier("custom")}
            >
              <div className="flex items-center gap-3">
                <Badge tone="charcoal">Custom</Badge>
                <span className="text-sm font-medium text-gyde-charcoal">{pol.customTaskTypes.length} tasks</span>
                <span className="hidden text-xs text-gray-400 sm:inline">Task types seen in traffic, not in the built-in catalog</span>
              </div>
              <div className="flex items-center gap-3">
                {dominated && <span className="hidden truncate font-mono text-xs text-gray-500 sm:block max-w-[180px]">{dominated[0]}</span>}
                <Chevron open={expanded.custom} />
              </div>
            </button>
            {expanded.custom && (
              <div className="border-t border-gray-100">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-left text-xs uppercase tracking-wide text-gray-400">
                      <th className="w-1/4 px-4 py-2 font-medium">Task type</th>
                      <th className="px-4 py-2 font-medium">Status</th>
                      <th className="w-60 px-4 py-2 font-medium">Model</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pol.customTaskTypes.map((taskId) => (
                      <tr key={taskId} className="border-t border-gray-100">
                        <td className="px-4 py-2 font-mono text-sm font-medium text-gyde-charcoal">{taskId}</td>
                        <td className="px-4 py-2 text-xs text-gray-500">
                          {assignments[taskId]
                            ? "AI-evaluated · scored as mid tier"
                            : <span className="text-amber-600">Unassigned — click Generate with AI</span>}
                        </td>
                        <td className="px-4 py-2">
                          <select
                            className="input w-full"
                            value={assignments[taskId] || ""}
                            onChange={(e) => setOne(taskId, e.target.value)}
                          >
                            <option value="">(use default)</option>
                            {models.map((m) => (
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
      })()}
    </div>
  );
}

const MODE_OPTIONS = [
  ["off", "Off", "Auto-mode requests just use the default model (after any matching rule)."],
  ["guardrail", "Cost guardrail", "Heuristic: downgrade premium models on cheap task types per the policy below."],
  ["ai", "AI policy", "An AI-generated task → model map decides; per-request AI classification when no task type is sent."],
];

export default function Routing({ onChange }) {
  const [tab, setTab] = useTabParam(TABS);
  const [rules, setRules] = useState(null);
  const [models, setModels] = useState([]);
  const [mode, setMode] = useState("off");
  const [cacheMsg, setCacheMsg] = useState(null);
  const [err, setErr] = useState(null);

  const load = () =>
    Promise.all([api.rules(), api.routingMode(), api.models()])
      .then(([r, rm, m]) => { setRules(r); setMode(rm.routingMode); setModels(m); })
      .catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const toggleRule = async (id, enabled) => { await api.updateRule(id, { enabled }); await load(); };
  const removeRule = async (id) => { await api.deleteRule(id); await load(); };
  const changeMode = async (m) => { await api.setRoutingMode(m); setMode(m); onChange?.(); };
  const clearCache = async () => { await api.clearCache(); setCacheMsg("Cache cleared"); setTimeout(() => setCacheMsg(null), 1500); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gyde-charcoal">Routing</h1>
        <p className="text-sm text-gray-500">
          How requests are routed. A developer-pinned, connected model is honored as-is. When the model is
          <code className="mx-1 rounded bg-gray-100 px-1">auto</code>/omitted/unavailable, the router decides:
          explicit → cache → rules → automated routing → default.
        </p>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "rules" && (
        <>
          <Card title="Create a rule">
            <p className="mb-3 text-sm text-gray-600">
              Map a condition to a target model. The gateway applies it deterministically — no quality guess.
              Rules always override automated routing.
            </p>
            {models.length === 0 ? <Spinner /> : <CreateRuleForm models={models} onCreated={load} />}
          </Card>

          <Card title="Rules">
            {rules === null ? <Spinner /> : (
              <Table
                empty="No rules yet. Create one above, or accept a recommendation."
                columns={[
                  { key: "enabled", header: "On", render: (r) => (
                    <Toggle checked={r.enabled} onChange={(v) => toggleRule(r._id, v)} label="enable rule" />
                  ) },
                  { key: "condition", header: "When", render: (r) => cond(r.condition) },
                  { key: "target", header: "Route to", render: (r) => (
                    <Badge tone="charcoal">{r.target.provider} · {r.target.model}</Badge>
                  ) },
                  { key: "note", header: "Note", render: (r) => <span className="text-gray-500">{r.note || "—"}</span> },
                  { key: "actions", header: "", render: (r) => (
                    <button className="btn-ghost" onClick={() => removeRule(r._id)}>Delete</button>
                  ) },
                ]}
                rows={rules}
              />
            )}
          </Card>
        </>
      )}

      {tab === "auto" && (
        <>
          <Card title="Automated routing">
            <p className="mb-3 text-sm text-gray-600">
              Decides the model in <strong>auto mode</strong> — when the caller sends
              <code className="mx-1 rounded bg-gray-100 px-1">model: "auto"</code>, no model, or an unavailable one
              (a pinned, connected model is always honored as-is, and a matching rule always wins first).
            </p>
            <div className="space-y-2">
              {MODE_OPTIONS.map(([k, label, desc]) => (
                <label key={k} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${mode === k ? "border-gyde-green-600 bg-gyde-green-50" : "border-gray-200 hover:border-gray-300"}`}>
                  <input type="radio" name="routingMode" className="mt-1" checked={mode === k} onChange={() => changeMode(k)} />
                  <div>
                    <div className="text-sm font-medium text-gyde-charcoal">{label}</div>
                    <div className="text-xs text-gray-500">{desc}</div>
                  </div>
                </label>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3 border-t border-gray-100 pt-3">
              <button className="btn-secondary" onClick={clearCache}>Clear response cache</button>
              <span className="text-xs text-gray-500">
                {cacheMsg || "Repeat (identical) requests are served from cache before routing runs — clear it when testing."}
              </span>
            </div>
          </Card>

          {mode === "guardrail" && (
            <Card title="Cost-guardrail policy">
              <p className="mb-4 text-sm text-gray-600">
                Which task types are eligible, the downgrade target per provider, and how aggressively to downgrade.
                (Full model tiers &amp; pricing live under <em>Settings → Models</em>.)
              </p>
              {models.length === 0 ? <Spinner /> : <PolicyEditor models={models} />}
            </Card>
          )}

          {mode === "ai" && (
            <Card title="AI routing policy">
              <p className="mb-4 text-sm text-gray-600">
                The AI assigns a model to each task type from your available models. Regenerate to refresh (it's also
                given any custom task types seen in traffic), or edit any row by hand. When a request arrives without a
                task type, the AI classifies it per-call using the <em>default model</em>.
              </p>
              {models.length === 0 ? <Spinner /> : <AiPolicyEditor models={models} />}
            </Card>
          )}
        </>
      )}

      {tab === "recommendations" && <Recommendations embedded />}

      {err && <div className="text-red-600">{err}</div>}
    </div>
  );
}
