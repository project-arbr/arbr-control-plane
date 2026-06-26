import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Card, Table, Toggle, Badge, Spinner } from "../components/ui.jsx";

// Human-readable scope label matching capEngine.describeScope().
function scopeLabel(cap) {
  if (!cap.dimension) return "Global spend";
  const dim = cap.dimension.charAt(0).toUpperCase() + cap.dimension.slice(1);
  return cap.value ? `${dim}: ${cap.value}` : `${dim} (any)`;
}

function actionTone(action) {
  return action === "block" ? "red" : action === "downgrade" ? "amber" : "gray";
}
function actionLabel(action) {
  return action === "block" ? "Block" : action === "downgrade" ? "Downgrade" : "Alert";
}

// Inline progress bar: green → amber (>80%) → red (breached).
function SpendBar({ cap }) {
  const pct = Math.min(cap.pct ?? 0, 100);
  const color = cap.breached ? "bg-red-500" : pct > 80 ? "bg-amber-400" : "bg-arbr-green-600";
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-gray-200">
        <div className={`absolute inset-y-0 left-0 rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs tabular-nums ${cap.breached ? "font-semibold text-red-600" : "text-gray-600"}`}>
        {fmt.usd(cap.spent ?? 0)}
      </span>
    </div>
  );
}

// Row with inline edit + delete confirmation.
function CapRow({ cap, onRefresh }) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState({ limit: cap.limit, period: cap.period, action: cap.action });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const toggle = async (enabled) => {
    setBusy(true);
    try { await api.updateCap(cap._id, { enabled }); await onRefresh(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const save = async () => {
    const lim = parseFloat(form.limit);
    if (!lim || lim <= 0) return setErr("Limit must be a positive number.");
    setBusy(true);
    setErr(null);
    try { await api.updateCap(cap._id, { limit: lim, period: form.period, action: form.action }); await onRefresh(); setEditing(false); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    setBusy(true);
    try { await api.deleteCap(cap._id); await onRefresh(); }
    catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <>
      <tr className={`border-b border-gray-100 ${cap.breached && cap.enabled ? "bg-red-50/40" : "hover:bg-arbr-green-50"}`}>
        <td className="px-3 py-2.5">
          <Toggle checked={cap.enabled} onChange={toggle} label="enabled" />
        </td>
        <td className="px-3 py-2.5 text-sm font-medium text-arbr-charcoal">{scopeLabel(cap)}</td>
        <td className="px-3 py-2.5 text-sm text-gray-600">{cap.period === "day" ? "Daily" : "Monthly"}</td>
        <td className="px-3 py-2.5 text-sm text-gray-600">{fmt.usd(cap.limit)}</td>
        <td className="px-3 py-2.5"><SpendBar cap={cap} /></td>
        <td className="px-3 py-2.5"><Badge tone={actionTone(cap.action)}>{actionLabel(cap.action)}</Badge></td>
        <td className="px-3 py-2.5">
          <div className="flex gap-2">
            <button className="btn-ghost px-2 py-1 text-xs" onClick={() => { setEditing(!editing); setDeleting(false); setErr(null); }}>
              Edit
            </button>
            <button className="btn-ghost px-2 py-1 text-xs text-red-500 hover:text-red-700" onClick={() => { setDeleting(!deleting); setEditing(false); setErr(null); }}>
              Delete
            </button>
          </div>
        </td>
      </tr>

      {editing && (
        <tr className="border-b border-gray-100">
          <td colSpan={7} className="bg-gray-50 px-4 py-3">
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <div className="label mb-1">Limit ($)</div>
                <input className="input w-28" type="number" min="0.01" step="0.01"
                  value={form.limit} onChange={(e) => setForm({ ...form, limit: e.target.value })} />
              </div>
              <div>
                <div className="label mb-1">Period</div>
                <select className="input" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
                  <option value="day">Daily</option>
                  <option value="month">Monthly</option>
                </select>
              </div>
              <div>
                <div className="label mb-1">When hit</div>
                <select className="input" value={form.action} onChange={(e) => setForm({ ...form, action: e.target.value })}>
                  <option value="block">Block requests</option>
                  <option value="downgrade">Downgrade to lighter model</option>
                  <option value="alert">Alert only (no enforcement)</option>
                </select>
              </div>
              <div className="flex gap-2">
                <button className="btn-primary" onClick={save} disabled={busy}>Save</button>
                <button className="btn-outline" onClick={() => { setEditing(false); setErr(null); setForm({ limit: cap.limit, period: cap.period, action: cap.action }); }}>
                  Cancel
                </button>
              </div>
            </div>
            {err && <p className="mt-2 text-xs text-red-600">{err}</p>}
          </td>
        </tr>
      )}

      {deleting && (
        <tr className="border-b border-gray-100">
          <td colSpan={7} className="bg-red-50 px-4 py-3">
            <p className="text-sm text-gray-700">
              Remove <strong>{scopeLabel(cap)}</strong> ({cap.period === "day" ? "daily" : "monthly"} {fmt.usd(cap.limit)} {cap.action})? This cannot be undone.
            </p>
            <div className="mt-2 flex gap-2">
              <button className="btn bg-red-600 text-white hover:bg-red-700 px-3 py-1.5 text-xs" onClick={remove} disabled={busy}>
                {busy ? "Removing…" : "Remove"}
              </button>
              <button className="btn-outline text-xs" onClick={() => setDeleting(false)}>Cancel</button>
            </div>
            {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
          </td>
        </tr>
      )}
    </>
  );
}

function CreateForm({ providers, applications, onCreated }) {
  const [dim, setDim] = useState("application");
  const [value, setValue] = useState("");
  const [period, setPeriod] = useState("day");
  const [limit, setLimit] = useState("");
  const [action, setAction] = useState("block");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Suggest sensible default action when scope type changes.
  const changeDim = (d) => {
    setDim(d);
    setValue("");
    setAction(d === "provider" ? "downgrade" : "block");
  };

  const submit = async () => {
    setErr(null);
    const lim = parseFloat(limit);
    if (!lim || lim <= 0) return setErr("Limit must be a positive number.");
    if (!value.trim()) return setErr("Enter a scope value.");
    setBusy(true);
    try {
      await api.createCap({ dimension: dim, value: value.trim(), period, limit: lim, action });
      setValue("");
      setLimit("");
      await onCreated();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <div className="label mb-1">Scope type</div>
          <select className="input" value={dim} onChange={(e) => changeDim(e.target.value)}>
            <option value="application">Application</option>
            <option value="provider">Provider</option>
          </select>
        </div>

        <div>
          <div className="label mb-1">{dim === "application" ? "Application" : "Provider"}</div>
          {dim === "provider" ? (
            <select className="input" value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">— pick provider —</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>{p.id}</option>
              ))}
            </select>
          ) : applications.length > 0 ? (
            <select className="input w-44" value={value} onChange={(e) => setValue(e.target.value)}>
              <option value="">— pick application —</option>
              {applications.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          ) : (
            <input className="input w-44" placeholder="e.g. support-chat" value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()} />
          )}
        </div>

        <div>
          <div className="label mb-1">Period</div>
          <select className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="day">Daily</option>
            <option value="month">Monthly</option>
          </select>
        </div>

        <div>
          <div className="label mb-1">Limit ($)</div>
          <input className="input w-28" type="number" min="0.01" step="0.01" placeholder="5.00"
            value={limit} onChange={(e) => setLimit(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()} />
        </div>

        <div>
          <div className="label mb-1">When hit</div>
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="block">Block requests</option>
            <option value="downgrade">Downgrade to lighter model</option>
            <option value="alert">Alert only (no enforcement)</option>
          </select>
        </div>

        <button className="btn-primary" onClick={submit} disabled={busy}>
          {busy ? "Adding…" : "Add constraint"}
        </button>
      </div>

      {action === "block" && (
        <p className="text-xs text-gray-500">
          Requests will be rejected with a 429 once the limit is reached. The error message is forwarded to the calling application.
        </p>
      )}
      {action === "downgrade" && (
        <p className="text-xs text-gray-500">
          Requests continue — the router transparently switches to the lightest available model until the window resets.
        </p>
      )}
      {action === "alert" && (
        <p className="text-xs text-gray-500">
          No enforcement — the breach appears in the dashboard and the "budgets over" header badge only.
        </p>
      )}

      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}

export default function Budgets({ onChange }) {
  const [caps, setCaps] = useState(null);
  const [providers, setProviders] = useState([]);
  const [applications, setApplications] = useState([]);

  const load = async () => {
    try {
      const [c, p, f] = await Promise.all([api.caps(), api.gatewayProviders(), api.facets()]);
      setCaps(c.data ?? c);
      setProviders(p.data ?? p);
      // facets returns { applications: [...], providers: [...], ... } — filter out "unknown"
      const apps = (f.applications || []).filter((a) => a && a !== "unknown").sort();
      setApplications(apps);
    } catch { setCaps([]); }
  };

  useEffect(() => { load(); }, []);

  const reload = async () => { await load(); if (onChange) onChange(); };

  if (caps === null) return <Spinner />;

  const active = caps.filter((c) => c.enabled);
  const breached = caps.filter((c) => c.breached && c.enabled);

  const COLUMNS = [
    { key: "enabled", header: "On" },
    { key: "scope",   header: "Scope" },
    { key: "period",  header: "Period" },
    { key: "limit",   header: "Limit" },
    { key: "spent",   header: "Spent this window" },
    { key: "action",  header: "When hit" },
    { key: "actions", header: "" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-arbr-charcoal">Budgets</h1>
        <p className="mt-1 text-sm text-gray-500">
          Stop or downgrade AI requests once a spending threshold is reached. Spend is measured across all
          requests logged in the current daily or monthly rolling window.
        </p>
      </div>

      {/* Summary chips */}
      <div className="flex flex-wrap gap-3">
        <div className="card px-4 py-3 flex items-center gap-3">
          <div>
            <div className="label">Active constraints</div>
            <div className="text-2xl font-bold text-arbr-charcoal">{active.length}</div>
          </div>
        </div>
        <div className={`card px-4 py-3 flex items-center gap-3 ${breached.length > 0 ? "border-red-200 bg-red-50" : ""}`}>
          <div>
            <div className="label">Breached now</div>
            <div className={`text-2xl font-bold ${breached.length > 0 ? "text-red-600" : "text-arbr-charcoal"}`}>
              {breached.length}
            </div>
          </div>
        </div>
      </div>

      {/* Create form */}
      <Card title="Add budget constraint">
        <CreateForm providers={providers} applications={applications} onCreated={reload} />
      </Card>

      {/* List */}
      <Card title={`Budget constraints${caps.length ? ` (${caps.length})` : ""}`}>
        {caps.length === 0 ? (
          <p className="py-8 text-center text-sm text-gray-400">
            No budget constraints yet. Add one above to start enforcing spend limits.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left">
                  {COLUMNS.map((c) => (
                    <th key={c.key} className="bg-gray-50 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
                      {c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {caps.map((cap) => (
                  <CapRow key={cap._id} cap={cap} onRefresh={reload} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {caps.length > 0 && (
          <p className="mt-3 text-xs text-gray-400">
            Spend windows are rolling (last 24 h for daily, last 30 days for monthly). Cache refreshes every 30 s.
          </p>
        )}
      </Card>
    </div>
  );
}
