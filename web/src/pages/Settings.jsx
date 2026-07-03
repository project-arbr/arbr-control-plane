import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, Badge, Spinner, Toggle, Tabs, useTabParam } from "../components/ui.jsx";

// ── Key row — inline edit of name + application ───────────────────────────────

function expiryBadge(expiresAt) {
  if (!expiresAt) return null;
  const exp = new Date(expiresAt);
  const daysLeft = Math.ceil((exp - Date.now()) / 86400000);
  if (daysLeft < 0) return <Badge tone="red">Expired</Badge>;
  if (daysLeft <= 7) return <Badge tone="amber">Expires in {daysLeft}d</Badge>;
  return <span className="text-xs text-gray-400">{exp.toLocaleDateString()}</span>;
}

function KeyRow({ k, onToggle, onRevoke, onSave, onRotate }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm]       = useState({ name: k.name, application: k.application });
  const [saving, setSaving]   = useState(false);
  const [rotating, setRotating] = useState(false);

  async function save() {
    if (!form.name.trim() || !form.application.trim()) return;
    setSaving(true);
    try { await onSave({ name: form.name.trim(), application: form.application.trim() }); setEditing(false); }
    finally { setSaving(false); }
  }

  async function rotate() {
    if (!window.confirm(`Rotate key "${k.name}"? The old key will stop working immediately.`)) return;
    setRotating(true);
    try { await onRotate(); } finally { setRotating(false); }
  }

  return (
    <tr className="border-t border-gray-100">
      <td className="py-2 font-mono text-xs text-gray-600">{k.prefix}</td>
      <td className="py-2">
        {editing
          ? <input className="input w-36" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          : <span className="text-arbr-charcoal">{k.name}</span>}
      </td>
      <td className="py-2">
        {editing
          ? <input className="input w-40" value={form.application} onChange={(e) => setForm({ ...form, application: e.target.value })} />
          : <Badge tone="charcoal">{k.application}</Badge>}
      </td>
      <td className="py-2 text-gray-600">{k.rpm ? `${k.rpm}/min` : "—"}</td>
      <td className="py-2 text-xs text-gray-500 max-w-[160px]">
        {k.defaultModel && <div className="truncate" title={k.defaultModel}>↳ {k.defaultModel}</div>}
        {k.allowedModels?.length > 0
          ? <div className="truncate" title={k.allowedModels.join(", ")}>{k.allowedModels.length} allowed</div>
          : <div className="text-gray-300">unrestricted</div>}
      </td>
      <td className="py-2">{expiryBadge(k.expiresAt) ?? <span className="text-xs text-gray-300">never</span>}</td>
      <td className="py-2 text-gray-500">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}</td>
      <td className="py-2"><Toggle checked={k.enabled} onChange={onToggle} label="enable key" /></td>
      <td className="py-2 text-right">
        <div className="flex items-center justify-end gap-2">
          {editing ? (
            <>
              <button className="btn-secondary text-xs" disabled={saving} onClick={save}>{saving ? "…" : "Save"}</button>
              <button className="btn-ghost text-xs" onClick={() => { setEditing(false); setForm({ name: k.name, application: k.application }); }}>Cancel</button>
            </>
          ) : (
            <button className="btn-ghost text-xs" onClick={() => setEditing(true)}>Edit</button>
          )}
          <button className="btn-ghost text-xs" disabled={rotating} onClick={rotate}>{rotating ? "…" : "Rotate"}</button>
          <button className="btn-ghost text-xs" onClick={onRevoke}>Revoke</button>
        </div>
      </td>
    </tr>
  );
}

// ── API keys tab ──────────────────────────────────────────────────────────────

function ApiKeys({ onChange }) {
  const [keys, setKeys]               = useState(null);
  const [name, setName]               = useState("");
  const [application, setApplication] = useState("");
  const [rpm, setRpm]                 = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [allowedModels, setAllowedModels] = useState("");
  const [expiresAt, setExpiresAt]     = useState("");
  const [created, setCreated]         = useState(null);
  const [copied, setCopied]           = useState(false);
  const [busy, setBusy]               = useState(false);
  const [err, setErr]                 = useState(null);

  const load = () => api.keys().then(setKeys).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setErr(null);
    if (!name.trim() || !application.trim()) return setErr("Name and application are required.");
    setBusy(true);
    try {
      const parsedAllowed = allowedModels.split(",").map((s) => s.trim()).filter(Boolean);
      const res = await api.createKey({
        name: name.trim(),
        application: application.trim(),
        rpm: rpm ? Number(rpm) : null,
        defaultModel: defaultModel.trim() || null,
        allowedModels: parsedAllowed,
        expiresAt: expiresAt || null,
      });
      setCreated({ key: res.key, name: res.name, application: res.application });
      setName(""); setApplication(""); setRpm(""); setDefaultModel(""); setAllowedModels(""); setExpiresAt("");
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const rotate = async (k) => {
    const res = await api.rotateKey(k._id);
    setCreated({ key: res.key, name: res.name, application: res.application });
    await load();
  };

  const copyKey = async () => {
    try { await navigator.clipboard.writeText(created.key); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  const toggleKey = async (k) => { await api.updateKey(k._id, { enabled: !k.enabled }); await load(); };
  const revoke = async (id) => { await api.revokeKey(id); await load(); };

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Gateway API keys bind every call to an <strong>application</strong> — attribution becomes trusted
        instead of self-reported — and can carry a per-key rate limit. Keys authenticate{" "}
        <code className="mx-1 rounded bg-gray-100 px-1">POST /v1/chat</code> via{" "}
        <code className="mx-1 rounded bg-gray-100 px-1">Authorization: Bearer ab_…</code>.
      </p>

      {created && (
        <div className="rounded-lg border border-arbr-green-200 bg-arbr-green-50 p-4">
          <div className="text-sm font-medium text-arbr-charcoal">Key created: {created.name}</div>
          <div className="mt-1 text-xs text-gray-600">
            Copy it now — <strong>this is the only time it will be shown.</strong>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded bg-white px-2 py-1 text-sm">{created.key}</code>
            <button className="btn-secondary" onClick={copyKey}>{copied ? "Copied" : "Copy"}</button>
            <button className="btn-ghost" onClick={() => setCreated(null)}>Dismiss</button>
          </div>
          <div className="mt-4 border-t border-arbr-green-200 pt-4">
            <div className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">Share with your developer</div>
            <pre className="rounded bg-white p-3 text-xs leading-relaxed text-gray-700 overflow-x-auto whitespace-pre">{[
              `# .env`,
              `ARBR_GATEWAY_URL=${window.location.origin}`,
              `ARBR_API_KEY=${created.key}`,
              ``,
              `# Install`,
              `npm install arbr-client          # JavaScript`,
              `pip install arbr-client          # Python`,
              ``,
              `# Quick start (JS)`,
              `const { createClient } = require("arbr-client");`,
              `const arbr = createClient({ application: "${created.application || "my-app"}" });`,
              `const res = await arbr.chat("Hello", { model: "auto" });`,
              `console.log(res.text, res.model);`,
            ].join("\n")}</pre>
            <button
              className="btn-ghost mt-2 text-xs"
              onClick={() => navigator.clipboard.writeText([
                `ARBR_GATEWAY_URL=${window.location.origin}`,
                `ARBR_API_KEY=${created.key}`,
              ].join("\n")).catch(() => {})}
            >Copy env vars</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3 border-b border-gray-100 pb-5">
        <div>
          <div className="label mb-1">Name</div>
          <input className="input w-44" placeholder="e.g. tester-laptop" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">Application (attribution)</div>
          <input className="input w-48" placeholder="e.g. tester-app" value={application} onChange={(e) => setApplication(e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">Rate limit (req/min, optional)</div>
          <input className="input w-40" type="number" min="1" placeholder="unlimited" value={rpm} onChange={(e) => setRpm(e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">Default model (optional)</div>
          <input className="input w-48" placeholder="global default" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">Allowed models (optional, comma-separated)</div>
          <input className="input w-72" placeholder="leave blank = unrestricted" value={allowedModels} onChange={(e) => setAllowedModels(e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">Expires at (optional)</div>
          <input className="input w-40" type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
        </div>
        <button className="btn-secondary" disabled={busy} onClick={create}>Create key</button>
        {err && <div className="w-full text-xs text-red-600">{err}</div>}
      </div>

      {keys === null ? <Spinner /> : keys.length === 0 ? (
        <div className="py-6 text-center text-sm text-gray-400">No API keys yet. Create one above.</div>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
              <th className="py-1 font-medium">Key</th>
              <th className="py-1 font-medium">Name</th>
              <th className="py-1 font-medium">Application</th>
              <th className="py-1 font-medium">Rate limit</th>
              <th className="py-1 font-medium">Models</th>
              <th className="py-1 font-medium">Expires</th>
              <th className="py-1 font-medium">Last used</th>
              <th className="py-1 font-medium">On</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <KeyRow key={k._id} k={k} onToggle={() => toggleKey(k)} onRevoke={() => revoke(k._id)}
                onSave={(patch) => api.updateKey(k._id, patch).then(() => load())}
                onRotate={() => rotate(k)} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ── Subtabs ───────────────────────────────────────────────────────────────────

const SUBTABS = [
  ["general", "General"],
  ["keys",    "API keys"],
];

// ── Settings page ─────────────────────────────────────────────────────────────

export default function Settings({ onChange }) {
  const [data, setData]           = useState(null);
  const [customProvs, setCustomProvs] = useState([]);
  const [models, setModels]       = useState([]);
  const [required, setRequired]   = useState(false);
  const [about, setAbout]         = useState(null);
  const [err, setErr]             = useState(null);
  const [tab, setTab]             = useTabParam(SUBTABS);

  const load = () => Promise.all([
    api.connections(),
    api.customProviders().catch(() => []),
    api.requireApiKey(),
  ]).then(([d, cp, req]) => {
    setData(d);
    setCustomProvs(cp);
    setRequired(req.requireApiKey);
  }).catch((e) => setErr(e.message));

  useEffect(() => {
    load();
    api.models().then(setModels).catch(() => {});
    api.about().then(setAbout).catch(() => {});
  }, []);

  const refresh = async () => { await load(); onChange?.(); };
  const setDefault = async (provider) => { await api.setDefaultProvider(provider); await refresh(); };
  const setModel = async (model) => { await api.setDefaultModel(model); await refresh(); };
  const toggleRequired = async (on) => { await api.setRequireApiKey(on); setRequired(on); onChange?.(); };

  if (err) return <div className="text-red-600">{err}</div>;
  if (!data) return <Spinner />;

  const liveProviders = [
    ...data.providers.filter((p) => p.configured),
    ...customProvs.filter((p) => p.enabled).map((p) => ({ provider: p.id, label: p.label })),
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-arbr-charcoal">Settings</h1>
        <p className="mt-1 text-sm text-gray-500">Gateway configuration and API key management.</p>
      </div>

      <Tabs tabs={SUBTABS} active={tab} onChange={setTab} />

      {tab === "general" && (
        <>
          <Card title="Default gateway">
            <p className="mb-4 text-sm text-gray-600">
              Used when a request sends <code className="rounded bg-gray-100 px-1">model: "auto"</code> or
              names no model. Configure providers and models in the{" "}
              <a href="/models" className="text-arbr-green-600 hover:underline">Models</a> page.
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <div className="label mb-1">Default provider</div>
                <select
                  className="input w-56"
                  value={data.defaultProvider || ""}
                  onChange={(e) => setDefault(e.target.value || null)}
                  disabled={liveProviders.length === 0}
                >
                  {liveProviders.length === 0 && <option value="">No live providers</option>}
                  {liveProviders.map((p) => (
                    <option key={p.provider} value={p.provider}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <div className="label mb-1">Default model</div>
                <select
                  className="input w-64"
                  value={data.defaultModel || ""}
                  onChange={(e) => setModel(e.target.value)}
                  disabled={!data.defaultProvider}
                >
                  {models.filter((m) => m.provider === data.defaultProvider).map((m) => (
                    <option key={m.id} value={m.id}>{m.id} ({m.tier})</option>
                  ))}
                </select>
              </div>
            </div>
          </Card>

          <Card title="Security">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-arbr-charcoal">Require API keys</div>
                <div className="mt-0.5 text-xs text-gray-500">
                  When on, anonymous gateway calls are rejected (401). Leave off until every integrated app has a key.
                </div>
              </div>
              <Toggle checked={required} onChange={toggleRequired} label="require API keys" />
            </div>
          </Card>

          <Card title="About">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Control plane</dt>
                <dd className="mt-0.5 font-mono text-arbr-charcoal">
                  {about ? `v${about.version}` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">JS SDK (npm)</dt>
                <dd className="mt-0.5 font-mono text-arbr-charcoal">
                  {about ? `arbr-client@${about.sdkJs}` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Python SDK (PyPI)</dt>
                <dd className="mt-0.5 font-mono text-arbr-charcoal">
                  {about ? `arbr-client@${about.sdkPython}` : "—"}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Gateway URL</dt>
                <dd className="mt-0.5 font-mono text-gray-600 break-all">{window.location.origin}</dd>
              </div>
              <div>
                <dt className="text-xs font-medium uppercase tracking-wide text-gray-400">Node.js</dt>
                <dd className="mt-0.5 font-mono text-gray-600">{about?.nodeVersion ?? "—"}</dd>
              </div>
            </dl>
          </Card>
        </>
      )}

      {tab === "keys" && (
        <Card title="Gateway API keys">
          <ApiKeys onChange={onChange} />
        </Card>
      )}
    </div>
  );
}
