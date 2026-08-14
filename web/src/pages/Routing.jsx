import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, fmt } from "../api.js";
import { Card, Table, Stat, Toggle, Badge, Spinner, Tabs, useTabParam, ConfirmDialog } from "../components/ui.jsx";
import { explainRouting } from "../lib/routingNarration.js";
import ReasoningDrawer from "../components/ReasoningDrawer.jsx";

// Recommendations moved to its own top-level page (/recommendations).
const TABS = [
  ["rules", "Rules"],
  ["auto", "Automated routing"],
];

function cond(c) {
  const parts = [];
  if (c.taskType) parts.push(`task = ${c.taskType}`);
  if (c.application) parts.push(`app = ${c.application}`);
  if (c.workflow) parts.push(`workflow = ${c.workflow}`);
  return parts.length ? parts.join(" · ") : "—";
}

// Dry-run: "given this hypothetical request, which model would Arbr serve, and why?"
// Runs through the real routing path server-side (no provider call, no billable
// classification) so what it shows is exactly what a live request would get.
const DECISION_TONE = { passthrough: "gray", explicit: "teal", rule: "green", auto: "indigo", ai: "violet", budget: "red", canary: "amber", fallback: "amber" };

// "How routing decides" — the precedence pipeline in plain English, with the steps
// that are active under the CURRENT routing mode highlighted. Read-only; uses data
// the page already loads. Mirrors docs/routing-spec.md §1 (the source of truth).
function PrecedencePanel({ mode, rules }) {
  const enabled = (rules || []).filter((r) => r.enabled).length;
  const broken = (rules || []).filter((r) => r.enabled && r.health?.level === "error").length;
  // active(true/false) drives styling; note explains the current state.
  const steps = [
    { n: 1, label: "Explicit pin", active: true, note: "A model the client names (and Arbr can reach) is served as-is, skipping every policy." },
    { n: 2, label: "Default", active: true, note: "Base pick for auto requests: the key's default, else the global default." },
    { n: 3, label: "Rules", active: enabled > 0, note: enabled > 0 ? `${enabled} enabled rule${enabled === 1 ? "" : "s"}${broken ? ` (${broken} pointing at an offline provider — skipped)` : ""}. Highest priority, then most specific, wins.` : "No enabled rules." },
    { n: 4, label: "AI policy", active: mode === "ai", note: mode === "ai" ? "Active: the policy maps the classified task (with a difficulty adjustment) to a model." : "Inactive (routing mode is not “ai”)." },
    { n: 5, label: "Cost guardrail", active: mode === "guardrail", note: mode === "guardrail" ? "Active: cheap task types are downgraded to a lighter model." : "Inactive (routing mode is not “guardrail”)." },
    { n: 6, label: "Canary", active: true, note: "Auto-routed traffic may be diverted a set % to an eval-approved candidate." },
    { n: 7, label: "Governance", active: true, note: "The chosen model is re-checked against the key's allowed-models, the app's opt-out list, and (for image requests) vision support." },
    { n: 8, label: "Budget", active: true, note: "A breached enforcing cap blocks (429) or downgrades the request." },
    { n: 9, label: "Fallback", active: true, note: "On a provider error, Arbr retries per the configured fallback scope — validated the same way as the primary." },
  ];
  return (
    <details className="rounded-lg border border-gray-200 bg-gray-50 p-1">
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-arbr-charcoal">
        How routing decides · mode: <span className="font-mono">{mode}</span>
      </summary>
      <ol className="space-y-2 px-4 py-3">
        {steps.map((s) => (
          <li key={s.n} className={`flex gap-3 text-sm ${s.active ? "text-gray-700" : "text-gray-400"}`}>
            <span className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${s.active ? "bg-arbr-accent-100 text-arbr-accent-700" : "bg-gray-100 text-gray-400"}`}>{s.n}</span>
            <span><span className="font-medium">{s.label}</span> — {s.note}</span>
          </li>
        ))}
      </ol>
      <p className="px-4 pb-3 text-xs text-gray-400">
        Steps run top to bottom; the first that resolves a model wins (7–9 then adjust it). Full reference: docs/routing-spec.md.
      </p>
    </details>
  );
}

function RouteTester() {
  const [model, setModel] = useState("auto");
  const [taskType, setTaskType] = useState("");
  const [application, setApplication] = useState("");
  const [workflow, setWorkflow] = useState("");
  const [hasImage, setHasImage] = useState(false);
  const [res, setRes] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const run = async () => {
    setBusy(true); setErr(null); setRes(null);
    try {
      const out = await api.explainRoute({
        model: model.trim() || "auto",
        taskType: taskType.trim() || undefined,
        application: application.trim() || undefined,
        workflow: workflow.trim() || undefined,
        hasImage,
      });
      setRes(out);
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const narration = res && !res.rejected ? explainRouting(res) : [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        Preview what routing would do for a hypothetical request, without sending real traffic. Leave{" "}
        <span className="font-mono">model</span> as <span className="font-mono">auto</span> to see how rules and the policy decide.
      </p>
      <p className="text-xs text-gray-400">
        Tip for developers: pass <span className="font-mono">taskType</span> in the request body to skip the AI
        classifier entirely — it is free, deterministic, and avoids a per-request LLM call.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div><div className="label mb-1">Model</div><input className="input w-40" value={model} onChange={(e) => setModel(e.target.value)} placeholder="auto" /></div>
        <div><div className="label mb-1">Task type</div><input className="input w-40" value={taskType} onChange={(e) => setTaskType(e.target.value)} placeholder="(classify)" /></div>
        <div><div className="label mb-1">Application</div><input className="input w-40" value={application} onChange={(e) => setApplication(e.target.value)} placeholder="(any)" /></div>
        <div><div className="label mb-1">Workflow</div><input className="input w-36" value={workflow} onChange={(e) => setWorkflow(e.target.value)} placeholder="(any)" /></div>
        <label className="flex h-9 cursor-pointer items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={hasImage} onChange={(e) => setHasImage(e.target.checked)} /> Has image
        </label>
        <button className="btn-secondary h-9 px-5" disabled={busy} onClick={run}>{busy ? "Previewing…" : "Preview route"}</button>
      </div>
      {err && <div className="text-xs text-red-600">{err}</div>}

      {res?.rejected && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
          <div className="font-medium text-red-800">Rejected · {res.rejected.status} {res.rejected.code}</div>
          <div className="mt-1 text-red-700">{res.rejected.message}</div>
        </div>
      )}

      {res && !res.rejected && (
        <div className="rounded-lg border border-arbr-accent-200 bg-arbr-accent-50 p-4">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-gray-400">Would serve</span>
            <Badge tone="charcoal">{res.provider} · {res.model}</Badge>
            <Badge tone={DECISION_TONE[res.routingDecision] || "gray"}>{res.routingDecision}</Badge>
            {res.classifiedBy && <span className="text-xs text-gray-400">classified: {res.classifiedBy}</span>}
          </div>
          <ul className="space-y-1 text-sm text-gray-700">
            {narration.map((line, i) => <li key={i}>· {line}</li>)}
          </ul>
          {res.budget && (
            <div className="mt-2 text-sm text-red-700">
              {res.budget.action === "block"
                ? `Budget: cap "${res.budget.scope}" (${res.budget.period}, $${res.budget.limit}) is over limit — the request would be blocked (429).`
                : `Budget: cap "${res.budget.scope}" (${res.budget.period}, $${res.budget.limit}) is over limit — would downgrade to ${res.budget.to || "a lighter model"}.`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CreateRuleForm({ models, onCreated }) {
  const [field, setField] = useState("taskType");
  const [value, setValue] = useState("");
  const [provider, setProvider] = useState("");
  const [model, setModel] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [priority, setPriority] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [warn, setWarn] = useState(null);

  const providers = [...new Set(models.map((m) => m.provider))];
  const providerModels = models.filter((m) => m.provider === provider);

  useEffect(() => { if (!provider && providers.length) setProvider(providers[0]); }, [models]);
  useEffect(() => { if (providerModels.length) setModel(providerModels[0].id); }, [provider]);

  const submit = async () => {
    setErr(null); setWarn(null);
    if (!value.trim()) return setErr("Enter a condition value.");
    if (!provider || !model) return setErr("Pick a target provider and model.");
    setBusy(true);
    try {
      const created = await api.createRule({
        condition: { [field]: value.trim() },
        target: { provider, model },
        enabled,
        priority: Number(priority) || 0,
        note: `${field}=${value.trim()} → ${model}`,
      });
      // Surface a target-health warning immediately (offline / unknown / unpriced).
      if (created?.health && created.health.level !== "ok") setWarn(created.health.detail);
      setValue("");
      await onCreated();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
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
          <div className="label mb-1">Equals</div>
          <input className="input w-44" placeholder="e.g. classification" value={value} onChange={(e) => setValue(e.target.value)} />
        </div>
        <div className="flex h-9 items-center px-1 text-sm text-gray-400">→ route to</div>
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
        <div>
          <div className="label mb-1" title="Higher wins when multiple rules match. Ties break by how specific the rule is.">Priority</div>
          <input className="input w-20" type="number" step="1" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </div>
        <label className="flex h-9 cursor-pointer items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable now
        </label>
        <button className="btn-secondary h-9 px-5" disabled={busy} onClick={submit}>{busy ? "Adding…" : "Add rule"}</button>
      </div>
      {err && <div className="text-xs text-red-600">{err}</div>}
      {warn && <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">Rule created, but heads up: {warn}</div>}
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
  // Only connected providers with a routable model — a target on a disconnected provider would
  // render an empty dropdown the user can't fix, and could never route. (`models` is already
  // live + routable from the parent's api.models({ live, routable }).)
  const providers = Object.keys(modelsByProvider).sort();
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
  const [confirmRegen, setConfirmRegen] = useState(false);
  const [expanded, setExpanded] = useState({ light: false, mid: false, premium: false, custom: true });
  const [goal, setGoal] = useState("balanced"); // cost | balanced | quality
  const [sim, setSim] = useState(null);
  const [evidence, setEvidence] = useState(null); // per-task candidate reasoning from the last regenerate
  const [showReasoning, setShowReasoning] = useState(false);
  const [difficultyAdjust, setDifficultyAdjust] = useState(false);
  const load = () => api.aiPolicy().then((p) => { setPol(p); setAssignments({ ...p.assignments }); }).catch((e) => setMsg(e.message));
  useEffect(() => {
    load();
    api.governance().then((g) => setDifficultyAdjust(!!g.aiDifficultyAdjust)).catch(() => {});
  }, []);
  const toggleDifficultyAdjust = async (next) => {
    setDifficultyAdjust(next);
    try { await api.updateGovernance({ aiDifficultyAdjust: next }); setMsg(next ? "Difficulty adjustment on" : "Policy is now authoritative"); setTimeout(() => setMsg(null), 2000); }
    catch (e) { setMsg(e.message); setDifficultyAdjust(!next); }
  };
  if (!pol) return <Spinner />;

  const regen = async () => {
    setConfirmRegen(false);
    setBusy(true); setMsg(`Generating (goal: ${goal})…`); setSim(null); setEvidence(null);
    try {
      const p = await api.regenerateAiPolicy(goal);
      setPol(p);
      setAssignments({ ...p.assignments });
      setSim(p.simulation || null);
      setEvidence(p.evidence || null);
      setMsg(p.generatorModel ? `Done — via ${p.generatorModel}` : "Done");
      setTimeout(() => setMsg(null), 3000);
    }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };
  const resimulate = async () => {
    setBusy(true);
    try { setSim(await api.simulatePolicy(assignments)); }
    catch (e) { setMsg(e.message); }
    finally { setBusy(false); }
  };
  const costDeltaLabel = (s) => { const c = s.current?.cost || 0, p = s.projected?.cost || 0; const pc = c > 0 ? Math.round(((p - c) / c) * 100) : 0; return `${pc > 0 ? "+" : ""}${pc}% vs current`; };
  const capDeltaLabel = (s) => { const c = s.current?.capabilityIndex, p = s.projected?.capabilityIndex; if (c == null || p == null) return null; const d = p - c; return `${d >= 0 ? "+" : ""}${d.toFixed(2)} vs current`; };
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
      {confirmRegen && (
        <ConfirmDialog
          title="Regenerate default policy?"
          message="This will overwrite all current task assignments with AI-generated ones. This cannot be undone."
          confirmLabel="Regenerate"
          onConfirm={regen}
          onCancel={() => setConfirmRegen(false)}
        />
      )}
      {showReasoning && (
        <ReasoningDrawer
          evidence={evidence}
          catalog={pol.taskCatalog || []}
          goal={goal}
          generatorModel={pol.generatorModel}
          onClose={() => setShowReasoning(false)}
        />
      )}
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
      {/* Whether requests may deviate from the policy table at serve time. Off = the policy
          you see is exactly what runs; on = a per-request cost downgrade may pick a cheaper
          model that isn't in the policy. */}
      <label className="flex items-start gap-2 rounded-lg border border-gray-200 p-3 text-xs">
        <input type="checkbox" className="mt-0.5" checked={difficultyAdjust}
          onChange={(e) => toggleDifficultyAdjust(e.target.checked)} />
        <span>
          <span className="font-medium">Auto-adjust model by request difficulty</span>
          <span className="ml-1 text-gray-500">
            (cost). When off (default), every request routes to the model this policy assigns for
            its task — the table below is exactly what runs. When on, a request the classifier
            rates easier than usual may be downgraded to a cheaper model that isn&apos;t
            necessarily in the policy.
          </span>
        </span>
      </label>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-secondary" disabled={busy} onClick={() => setConfirmRegen(true)}>{busy ? "Generating…" : "Generate with AI"}</button>
        <button className="btn-outline" disabled={busy} onClick={save}>Save edits</button>
        {evidence && Object.keys(evidence).length > 0 && (
          <button className="btn-ghost" disabled={busy} onClick={() => setShowReasoning(true)}>View reasoning</button>
        )}
        {pol.generatedAt && (
          <span className="text-xs text-gray-500">
            generated {new Date(pol.generatedAt).toLocaleString()}{pol.generatorModel ? ` · ${pol.generatorModel}` : ""}
          </span>
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
            <Stat label="Capability index" value={sim.projected?.capabilityIndex == null ? "—" : Number(sim.projected.capabilityIndex).toFixed(2)} sub={capDeltaLabel(sim)} />
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
                <span className="text-sm font-medium text-arbr-charcoal">{pol.customTaskTypes.length} tasks</span>
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
                        <td className="px-4 py-2 font-mono text-sm font-medium text-arbr-charcoal">{taskId}</td>
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
  ["ai", "Default AI policy", "An AI-generated task → model map decides; per-request AI classification when no task type is sent."],
];

export default function Routing({ onChange }) {
  const navigate = useNavigate();
  // Recommendations is now its own page; send old ?tab=recommendations bookmarks there.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tab") === "recommendations") {
      navigate("/recommendations", { replace: true });
    }
  }, [navigate]);
  const [tab, setTab] = useTabParam(TABS);
  const [rules, setRules] = useState(null);
  const [models, setModels] = useState([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [mode, setMode] = useState("off");
  const [cacheMsg, setCacheMsg] = useState(null);
  const [err, setErr] = useState(null);

  const load = () =>
    // Only connected providers' CHAT-CAPABLE models — a rule/policy targeting an unconnected
    // provider would never route, and a media/embedding model (e.g. Lyria) can't serve chat.
    // (The Models page manages the full registry; routing targets the live, routable ones.)
    Promise.all([api.rules(), api.routingMode(), api.models({ live: true, routable: true })])
      .then(([r, rm, m]) => { setRules(r); setMode(rm.routingMode); setModels(m); })
      .catch((e) => setErr(e.message))
      .finally(() => setLoadingModels(false));
  useEffect(() => { load(); }, []);

  const toggleRule = async (id, enabled) => { await api.updateRule(id, { enabled }); await load(); };
  const removeRule = async (id) => { await api.deleteRule(id); await load(); };
  const changeMode = async (m) => { await api.setRoutingMode(m); setMode(m); onChange?.(); };
  const clearCache = async () => { await api.clearCache(); setCacheMsg("Cache cleared"); setTimeout(() => setCacheMsg(null), 1500); };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-arbr-charcoal">Routing</h1>
        <p className="text-sm text-gray-500">
          How requests are routed. A developer-pinned, connected model is honored as-is. When the model is
          <code className="mx-1 rounded bg-gray-100 px-1">auto</code>/omitted/unavailable, the router decides:
          explicit → cache → rules → automated routing → default.
        </p>
      </div>

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {tab === "rules" && (
        <>
          <PrecedencePanel mode={mode} rules={rules} />

          <Card title="Test a route">
            <RouteTester />
          </Card>

          <Card title="Create a rule">
            <p className="mb-3 text-sm text-gray-600">
              Map a condition to a target model. The gateway applies it deterministically — no quality guess.
              Rules always override automated routing.
            </p>
            {loadingModels ? <Spinner /> : models.length === 0 ? (
              <div className="py-4 text-sm text-gray-500">
                No connected providers yet. Connect one under <span className="font-medium text-arbr-charcoal">Models</span> to create routing rules.
              </div>
            ) : <CreateRuleForm models={models} onCreated={load} />}
          </Card>

          <Card title="Rules">
            {rules === null ? <Spinner /> : (
              <Table
                empty="No rules yet. Create one above, or accept a recommendation."
                columns={[
                  { key: "enabled", header: "On", render: (r) => (
                    <Toggle checked={r.enabled} onChange={(v) => toggleRule(r._id, v)} label="enable rule" />
                  ) },
                  { key: "priority", header: "Priority", render: (r) => (
                    <span className="font-mono text-gray-500" title="Higher wins when multiple rules match">{r.priority ?? 0}</span>
                  ) },
                  { key: "condition", header: "When", render: (r) => cond(r.condition) },
                  { key: "target", header: "Route to", render: (r) => (
                    <div className="flex items-center gap-2">
                      <Badge tone="charcoal">{r.target.provider} · {r.target.model}</Badge>
                      {r.health && r.health.level === "error" && (
                        <span title={r.health.detail}><Badge tone="red">offline</Badge></span>
                      )}
                      {r.health && r.health.level === "warn" && (
                        <span title={r.health.detail}><Badge tone="amber">{r.health.reason === "unpriced" ? "unpriced" : "unknown"}</Badge></span>
                      )}
                    </div>
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
                <label key={k} className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 ${mode === k ? "border-arbr-accent-600 bg-arbr-accent-50" : "border-gray-200 hover:border-gray-300"}`}>
                  <input type="radio" name="routingMode" className="mt-1" checked={mode === k} onChange={() => changeMode(k)} />
                  <div>
                    <div className="text-sm font-medium text-arbr-charcoal">{label}</div>
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
            <Card title="Default AI routing policy">
              <p className="mb-4 text-sm text-gray-600">
                The AI assigns a model to each task type from your available models. Regenerate to refresh (it's also
                given any custom task types seen in traffic), or edit any row by hand. When a request arrives without a
                task type, the AI classifies it per-call using the <em>default model</em>. Applications can override
                this policy with their own — see the Applications page.
              </p>
              {models.length === 0 ? <Spinner /> : <AiPolicyEditor models={models} />}
            </Card>
          )}
        </>
      )}

      {err && <div className="text-red-600">{err}</div>}
    </div>
  );
}
