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

function AiPolicyEditor({ models }) {
  const [pol, setPol] = useState(null);
  const [assignments, setAssignments] = useState({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const load = () => api.aiPolicy().then((p) => { setPol(p); setAssignments({ ...p.assignments }); }).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  if (!pol) return <Spinner />;

  const regen = async () => {
    setBusy(true); setMsg("Generating with the default model…");
    try { const p = await api.regenerateAiPolicy(); setPol(p); setAssignments({ ...p.assignments }); setMsg("Generated"); setTimeout(() => setMsg(null), 1500); }
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

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-secondary" disabled={busy} onClick={regen}>{busy ? "Working…" : "Regenerate with AI"}</button>
        <button className="btn-outline" disabled={busy} onClick={save}>Save edits</button>
        {pol.generatedAt && <span className="text-xs text-gray-500">generated {new Date(pol.generatedAt).toLocaleString()}{pol.generatorModel ? ` · ${pol.generatorModel}` : ""}</span>}
        {msg && <span className="text-xs text-gray-500">{msg}</span>}
      </div>

      {pol.customTaskTypes.length > 0 && (
        <div className="rounded-md border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
          Custom task types seen in traffic (the AI is given these on regenerate): {pol.customTaskTypes.join(", ")}
        </div>
      )}
      {pol.unmapped.length > 0 && (
        <div className="text-xs text-amber-700">Unmapped (using the default model until you regenerate): {pol.unmapped.join(", ")}</div>
      )}

      <table className="w-full table-fixed text-sm">
        <colgroup><col className="w-1/2" /><col className="w-1/2" /></colgroup>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
            <th className="py-1 font-medium">Task type</th><th className="py-1 font-medium">Model</th>
          </tr>
        </thead>
        <tbody>
          {pol.taskTypes.map((t) => (
            <tr key={t} className="border-t border-gray-100">
              <td className="py-1.5 text-gyde-charcoal">
                {t} {!pol.builtInTaskTypes.includes(t) && <Badge tone="indigo">custom</Badge>}
              </td>
              <td className="py-1.5">
                <select className="input w-full max-w-xs" value={assignments[t] || ""} onChange={(e) => setOne(t, e.target.value)}>
                  <option value="">(use default model)</option>
                  {models.map((m) => <option key={m.id} value={m.id}>{m.id} ({m.tier})</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
