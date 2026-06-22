import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Card, Badge, Spinner, Toggle, Tabs, useTabParam } from "../components/ui.jsx";

const TIER_TONE = { premium: "amber", mid: "charcoal", light: "green" };
const TIERS = ["light", "mid", "premium"];

const emptyForm = () => ({ id: "", provider: "", label: "", tier: "mid", inputPer1M: "", outputPer1M: "" });

function ModelRow({ m, providers, targetSet, onSaved, onDeleted }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const startEdit = () => { setDraft({ label: m.label || "", tier: m.tier, inputPer1M: m.inputPer1M, outputPer1M: m.outputPer1M }); setEditing(true); setErr(null); };
  const cancelEdit = () => setEditing(false);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api.updateModel(m.id, { label: draft.label, tier: draft.tier, inputPer1M: Number(draft.inputPer1M), outputPer1M: Number(draft.outputPer1M) });
      setEditing(false);
      await onSaved();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const del = async () => {
    if (!confirm(`Delete model "${m.id}"?`)) return;
    setBusy(true);
    try { await api.deleteModel(m.id); await onDeleted(); }
    catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  if (editing) {
    return (
      <tr className="border-t border-gray-100 bg-gray-50">
        <td className="py-2 pr-2">
          <div className="text-xs font-medium text-gyde-charcoal">{m.id}</div>
          <input className="input mt-1 w-full text-xs" placeholder="Label (display name)" value={draft.label} onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))} />
        </td>
        <td className="py-2 pr-2">
          <select className="input text-xs" value={draft.tier} onChange={(e) => setDraft((d) => ({ ...d, tier: e.target.value }))}>
            {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </td>
        <td className="py-2 pr-2 text-right">
          <input type="number" min="0" step="0.01" className="input w-20 text-right text-xs" value={draft.inputPer1M} onChange={(e) => setDraft((d) => ({ ...d, inputPer1M: e.target.value }))} />
        </td>
        <td className="py-2 text-right">
          <input type="number" min="0" step="0.01" className="input w-20 text-right text-xs" value={draft.outputPer1M} onChange={(e) => setDraft((d) => ({ ...d, outputPer1M: e.target.value }))} />
        </td>
        <td className="py-2 pl-2">
          <div className="flex gap-1">
            <button className="btn-secondary text-xs" disabled={busy} onClick={save}>Save</button>
            <button className="btn-ghost text-xs" disabled={busy} onClick={cancelEdit}>✕</button>
          </div>
          {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
        </td>
      </tr>
    );
  }

  return (
    <tr key={m.id} className="border-t border-gray-100">
      <td className="py-1.5 pr-2">
        <div className="font-medium text-gyde-charcoal">
          {m.label || m.id}
          {targetSet.has(m.id) && <span className="ml-1"><Badge tone="green">↓ target</Badge></span>}
          {!m.builtIn && <span className="ml-1"><Badge tone="gray">custom</Badge></span>}
        </div>
        <div className="text-xs text-gray-400">{m.id}</div>
      </td>
      <td className="py-1.5 pr-2"><Badge tone={TIER_TONE[m.tier] || "gray"}>{m.tier}</Badge></td>
      <td className="py-1.5 text-right tabular-nums text-gray-600">${m.inputPer1M}</td>
      <td className="py-1.5 text-right tabular-nums text-gray-600">${m.outputPer1M}</td>
      <td className="py-1.5 pl-2">
        <div className="flex gap-1 justify-end">
          <button className="btn-ghost text-xs" onClick={startEdit}>Edit</button>
          {!m.builtIn && <button className="btn-ghost text-xs text-red-500" disabled={busy} onClick={del}>Delete</button>}
        </div>
        {err && <div className="mt-1 text-xs text-red-600">{err}</div>}
      </td>
    </tr>
  );
}

function ModelTiers() {
  const [models, setModels] = useState(null);
  const [targets, setTargets] = useState({});
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => Promise.all([
    api.models(),
    api.policy().then((p) => p.effective?.lightTargets || {}).catch(() => ({})),
  ]).then(([m, t]) => { setModels(m); setTargets(t); }).catch(() => setModels([]));

  useEffect(() => { load(); }, []);

  const knownProviders = models ? [...new Set(models.map((m) => m.provider))] : [];

  const create = async () => {
    setBusy(true); setErr(null);
    try {
      await api.createModel({ ...form, inputPer1M: Number(form.inputPer1M), outputPer1M: Number(form.outputPer1M) });
      setForm(emptyForm()); setAdding(false);
      await load();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  if (!models) return <Spinner />;

  const targetSet = new Set(Object.values(targets));
  const byProvider = {};
  for (const m of models) (byProvider[m.provider] ||= []).push(m);
  const tierRank = (t) => ["premium", "mid", "light"].indexOf(t);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-600">
          DB-backed model registry. Prices are USD / 1M tokens and drive cost tracking, tiering, and the
          routing guardrail. <Badge tone="green">↓ target</Badge> = provider's light-tier downgrade target.
        </p>
        {!adding && (
          <button className="btn-secondary shrink-0" onClick={() => { setAdding(true); setErr(null); }}>+ Add model</button>
        )}
      </div>

      {adding && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="text-sm font-medium text-gyde-charcoal mb-3">New model entry</div>
          <div className="flex flex-wrap gap-3 items-end">
            <Field label="Model ID">
              <input className="input w-56" placeholder="gpt-4o" value={form.id} onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))} />
            </Field>
            <Field label="Provider">
              <input className="input w-36" list="provider-list" placeholder="openai" value={form.provider} onChange={(e) => setForm((f) => ({ ...f, provider: e.target.value }))} />
              <datalist id="provider-list">{knownProviders.map((p) => <option key={p} value={p} />)}</datalist>
            </Field>
            <Field label="Label (optional)">
              <input className="input w-40" placeholder="Display name" value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </Field>
            <Field label="Tier">
              <select className="input w-28" value={form.tier} onChange={(e) => setForm((f) => ({ ...f, tier: e.target.value }))}>
                {TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
            <Field label="Input $/1M">
              <input type="number" min="0" step="0.01" className="input w-24" placeholder="0.00" value={form.inputPer1M} onChange={(e) => setForm((f) => ({ ...f, inputPer1M: e.target.value }))} />
            </Field>
            <Field label="Output $/1M">
              <input type="number" min="0" step="0.01" className="input w-24" placeholder="0.00" value={form.outputPer1M} onChange={(e) => setForm((f) => ({ ...f, outputPer1M: e.target.value }))} />
            </Field>
            <button className="btn-secondary" disabled={busy || !form.id.trim() || !form.provider.trim()} onClick={create}>Add</button>
            <button className="btn-ghost" disabled={busy} onClick={() => { setAdding(false); setErr(null); setForm(emptyForm()); }}>Cancel</button>
          </div>
          {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
        </div>
      )}

      <table className="w-full table-fixed text-sm">
        <colgroup>
          <col className="w-[36%]" />
          <col className="w-[12%]" />
          <col className="w-[15%]" />
          <col className="w-[15%]" />
          <col className="w-[22%]" />
        </colgroup>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-400">
            <th className="py-1 font-medium">Model</th>
            <th className="py-1 font-medium">Tier</th>
            <th className="py-1 text-right font-medium">Input /1M</th>
            <th className="py-1 text-right font-medium">Output /1M</th>
            <th className="py-1" />
          </tr>
        </thead>
        <tbody>
          {Object.keys(byProvider).sort().map((prov) => (
            <React.Fragment key={prov}>
              <tr>
                <td colSpan={5} className="pt-4 pb-1 text-sm font-medium text-gyde-charcoal">{prov}</td>
              </tr>
              {byProvider[prov].sort((a, b) => tierRank(a.tier) - tierRank(b.tier)).map((m) => (
                <ModelRow key={m.id} m={m} providers={knownProviders} targetSet={targetSet}
                  onSaved={load} onDeleted={load} />
              ))}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function emptyCred(p) {
  if (p.authType === "aws") return { region: p.regionDefault || "us-east-1", accessKeyId: "", secretAccessKey: "" };
  return { apiKey: "" };
}

function ProviderRow({ p, onChanged }) {
  const [cred, setCred] = useState(emptyCred(p));
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState(null);
  const [err, setErr] = useState(null);

  const set = (field, v) => setCred((c) => ({ ...c, [field]: v }));

  // Enough fields filled to save?
  const required = p.authType === "aws" ? ["accessKeyId", "secretAccessKey"] : ["apiKey"];
  const ready = required.every((f) => (cred[f] || "").trim());

  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.setProviderCredential(p.provider, cred); setCred(emptyCred(p)); await onChanged(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true); setErr(null);
    try { await api.removeProviderKey(p.provider); await onChanged(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const runTest = async () => {
    setBusy(true); setTest(null);
    try { setTest(await api.testProvider(p.provider)); }
    finally { setBusy(false); }
  };

  const statusBadge = p.source === "env"
    ? <Badge tone="green">live · from env</Badge>
    : p.source === "stored"
      ? <Badge tone="green">live · ••••{p.last4}</Badge>
      : <Badge tone="gray">not configured</Badge>;

  return (
    <div className="border-b border-gray-100 py-4 last:border-b-0">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-gyde-charcoal">{p.label}</span>
            {statusBadge}
            {p.authType === "aws" && <Badge tone="charcoal">AWS</Badge>}
          </div>
          <div className="mt-1 text-xs text-gray-500">
            default model: {p.defaultModel}{p.region ? ` · region ${p.region}` : ""}
          </div>
          {p.source === "env" && (
            <div className="mt-1 text-xs text-gray-400">Set via environment variable — managed outside the app (takes precedence).</div>
          )}
          {test && (
            <div className={`mt-2 text-xs ${test.ok ? "text-gyde-green-700" : "text-red-600"}`}>
              {test.ok ? `Test OK · ${test.model} · "${test.sample}"` : `Test failed: ${test.message}`}
            </div>
          )}
          {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
        </div>
        {!p.editable && <button className="btn-outline shrink-0" disabled={busy} onClick={runTest}>Test</button>}
      </div>

      {p.editable && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          {p.authType === "aws" ? (
            <>
              <Field label="Region">
                <input className="input w-32" value={cred.region} onChange={(e) => set("region", e.target.value)} placeholder="us-east-1" />
              </Field>
              <Field label="Access key ID">
                <input className="input w-48" value={cred.accessKeyId} onChange={(e) => set("accessKeyId", e.target.value)} placeholder="AKIA…" />
              </Field>
              <Field label="Secret access key">
                <input type="password" className="input w-56" value={cred.secretAccessKey} onChange={(e) => set("secretAccessKey", e.target.value)} placeholder={p.source === "stored" ? "replace…" : "secret…"} />
              </Field>
            </>
          ) : (
            <Field label="API key">
              <input type="password" className="input w-72" value={cred.apiKey} onChange={(e) => set("apiKey", e.target.value)} placeholder={p.source === "stored" ? "replace key…" : "paste API key…"} />
            </Field>
          )}
          <button className="btn-secondary" disabled={busy || !ready} onClick={save}>Save</button>
          {p.source === "stored" && (
            <>
              <button className="btn-outline" disabled={busy} onClick={runTest}>Test</button>
              <button className="btn-ghost" disabled={busy} onClick={remove}>Remove</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      {children}
    </div>
  );
}

function CustomProviders({ onChanged }) {
  const [providers, setProviders] = useState(null);
  const [adding, setAdding] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState({ id: "", label: "", baseURL: "", apiKey: "" });
  const [editForm, setEditForm] = useState({ label: "", baseURL: "", apiKey: "" });
  const [testModel, setTestModel] = useState({});
  const [testResult, setTestResult] = useState({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => api.customProviders().then(setProviders).catch(() => setProviders([]));
  useEffect(() => { load(); }, []);

  const add = async () => {
    setBusy(true); setErr(null);
    try {
      await api.addCustomProvider(form);
      setForm({ id: "", label: "", baseURL: "", apiKey: "" });
      setAdding(false);
      await load(); onChanged?.();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const save = async (id) => {
    setBusy(true); setErr(null);
    try {
      await api.updateCustomProvider(id, editForm);
      setEditId(null);
      await load(); onChanged?.();
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };

  const remove = async (id) => {
    if (!confirm(`Delete custom provider "${id}"? All models registered against it will stop routing.`)) return;
    setBusy(true);
    try { await api.removeCustomProvider(id); await load(); onChanged?.(); }
    finally { setBusy(false); }
  };

  const runTest = async (id) => {
    setBusy(true);
    setTestResult((r) => ({ ...r, [id]: null }));
    try {
      const result = await api.testCustomProvider(id, testModel[id] || "");
      setTestResult((r) => ({ ...r, [id]: result }));
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          Any OpenAI-compatible endpoint: OpenRouter, Together AI, Fireworks, a local Ollama, etc.
          Add a provider here, then register models against it in the Models tab.
        </p>
        {!adding && (
          <button className="btn-secondary shrink-0" onClick={() => { setAdding(true); setErr(null); }}>
            + Add provider
          </button>
        )}
      </div>

      {adding && (
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="text-sm font-medium text-gyde-charcoal mb-3">New custom provider</div>
          <div className="flex flex-wrap gap-3 items-end">
            <Field label="Provider ID (slug)">
              <input className="input w-36" placeholder="openrouter" value={form.id}
                onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))} />
            </Field>
            <Field label="Label">
              <input className="input w-44" placeholder="OpenRouter" value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} />
            </Field>
            <Field label="Base URL">
              <input className="input w-72" placeholder="https://openrouter.ai/api/v1" value={form.baseURL}
                onChange={(e) => setForm((f) => ({ ...f, baseURL: e.target.value }))} />
            </Field>
            <Field label="API key">
              <input type="password" className="input w-56" placeholder="paste key…" value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))} />
            </Field>
            <button className="btn-secondary"
              disabled={busy || !form.id.trim() || !form.label.trim() || !form.baseURL.trim() || !form.apiKey.trim()}
              onClick={add}>Add</button>
            <button className="btn-ghost" disabled={busy} onClick={() => { setAdding(false); setErr(null); }}>Cancel</button>
          </div>
          {err && <div className="mt-2 text-xs text-red-600">{err}</div>}
        </div>
      )}

      {providers === null ? <Spinner /> : providers.length === 0 && !adding ? (
        <div className="py-4 text-center text-sm text-gray-400">No custom providers yet.</div>
      ) : providers.map((p) => (
        <div key={p.id} className="border-b border-gray-100 py-3 last:border-b-0">
          {editId === p.id ? (
            <div className="flex flex-wrap gap-3 items-end">
              <Field label="Label">
                <input className="input w-44" value={editForm.label}
                  onChange={(e) => setEditForm((f) => ({ ...f, label: e.target.value }))} />
              </Field>
              <Field label="Base URL">
                <input className="input w-72" value={editForm.baseURL}
                  onChange={(e) => setEditForm((f) => ({ ...f, baseURL: e.target.value }))} />
              </Field>
              <Field label="New API key (leave blank to keep)">
                <input type="password" className="input w-56" placeholder="new key…" value={editForm.apiKey}
                  onChange={(e) => setEditForm((f) => ({ ...f, apiKey: e.target.value }))} />
              </Field>
              <button className="btn-secondary" disabled={busy} onClick={() => save(p.id)}>Save</button>
              <button className="btn-ghost" disabled={busy} onClick={() => setEditId(null)}>Cancel</button>
              {err && <div className="w-full text-xs text-red-600">{err}</div>}
            </div>
          ) : (
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-gyde-charcoal">{p.label}</span>
                  <Badge tone="green">live · ••••{p.last4}</Badge>
                  <Badge tone="charcoal">custom</Badge>
                  {!p.enabled && <Badge tone="gray">disabled</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-gray-500">
                  id: <span className="font-mono">{p.id}</span> · {p.baseURL}
                </div>
                {testResult[p.id] && (
                  <div className={`mt-1.5 text-xs ${testResult[p.id].ok ? "text-gyde-green-700" : "text-red-600"}`}>
                    {testResult[p.id].ok
                      ? `Test OK · "${testResult[p.id].sample}"`
                      : `Test failed: ${testResult[p.id].message}`}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <input className="input w-36 text-xs" placeholder="model for test"
                  value={testModel[p.id] || ""}
                  onChange={(e) => setTestModel((m) => ({ ...m, [p.id]: e.target.value }))} />
                <button className="btn-outline text-xs" disabled={busy} onClick={() => runTest(p.id)}>Test</button>
                <button className="btn-ghost text-xs" onClick={() => {
                  setEditId(p.id);
                  setEditForm({ label: p.label, baseURL: p.baseURL, apiKey: "" });
                  setErr(null);
                }}>Edit</button>
                <button className="btn-ghost text-xs text-red-500" disabled={busy} onClick={() => remove(p.id)}>Delete</button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

const SUBTABS = [
  ["connections", "Connections"],
  ["budgets", "Budgets"],
  ["keys", "API keys"],
];

function ApiKeys({ onChange }) {
  const [keys, setKeys] = useState(null);
  const [required, setRequired] = useState(false);
  const [name, setName] = useState("");
  const [application, setApplication] = useState("");
  const [rpm, setRpm] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [allowedModels, setAllowedModels] = useState("");
  const [created, setCreated] = useState(null); // { key, name } — shown once
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () =>
    Promise.all([api.keys(), api.requireApiKey()])
      .then(([k, r]) => { setKeys(k); setRequired(r.requireApiKey); })
      .catch((e) => setErr(e.message));
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
      });
      setCreated({ key: res.key, name: res.name, application: res.application });
      setName(""); setApplication(""); setRpm(""); setDefaultModel(""); setAllowedModels("");
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const copyKey = async () => {
    try { await navigator.clipboard.writeText(created.key); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch {}
  };
  const toggleKey = async (k) => { await api.updateKey(k._id, { enabled: !k.enabled }); await load(); };
  const revoke = async (id) => { await api.revokeKey(id); await load(); };
  const toggleRequired = async (on) => { await api.setRequireApiKey(on); setRequired(on); onChange?.(); };

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Gateway API keys bind every call to an <strong>application</strong> — attribution becomes trusted
        instead of self-reported — and can carry a per-key rate limit. Keys authenticate
        <code className="mx-1 rounded bg-gray-100 px-1">POST /v1/chat</code> via
        <code className="mx-1 rounded bg-gray-100 px-1">Authorization: Bearer ab_…</code>.
      </p>

      <div className="flex items-center justify-between rounded-lg border border-gray-200 p-4">
        <div>
          <div className="text-sm font-medium text-gyde-charcoal">Require API keys</div>
          <div className="text-xs text-gray-500">
            When on, anonymous gateway calls are rejected (401). Leave off until every integrated app has a key.
          </div>
        </div>
        <Toggle checked={required} onChange={toggleRequired} label="require API keys" />
      </div>

      {created && (
        <div className="rounded-lg border border-gyde-green-200 bg-gyde-green-50 p-4">
          <div className="text-sm font-medium text-gyde-charcoal">Key created: {created.name}</div>
          <div className="mt-1 text-xs text-gray-600">
            Copy it now — <strong>this is the only time it will be shown.</strong>
          </div>
          <div className="mt-2 flex items-center gap-2">
            <code className="rounded bg-white px-2 py-1 text-sm">{created.key}</code>
            <button className="btn-secondary" onClick={copyKey}>{copied ? "Copied" : "Copy"}</button>
            <button className="btn-ghost" onClick={() => setCreated(null)}>Dismiss</button>
          </div>
          <div className="mt-4 border-t border-gyde-green-200 pt-4">
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
              `const arbr = createClient({ application: "${created.application || 'my-app'}" });`,
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
              <th className="py-1 font-medium">Last used</th>
              <th className="py-1 font-medium">On</th>
              <th className="py-1" />
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k._id} className="border-t border-gray-100">
                <td className="py-2 font-mono text-xs text-gray-600">{k.prefix}</td>
                <td className="py-2 text-gyde-charcoal">{k.name}</td>
                <td className="py-2"><Badge tone="charcoal">{k.application}</Badge></td>
                <td className="py-2 text-gray-600">{k.rpm ? `${k.rpm}/min` : "—"}</td>
                <td className="py-2 text-xs text-gray-500 max-w-[160px]">
                  {k.defaultModel && <div className="truncate" title={k.defaultModel}>↳ {k.defaultModel}</div>}
                  {k.allowedModels?.length > 0
                    ? <div className="truncate" title={k.allowedModels.join(", ")}>{k.allowedModels.length} allowed</div>
                    : <div className="text-gray-300">unrestricted</div>}
                </td>
                <td className="py-2 text-gray-500">{k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "never"}</td>
                <td className="py-2"><Toggle checked={k.enabled} onChange={() => toggleKey(k)} label="enable key" /></td>
                <td className="py-2 text-right"><button className="btn-ghost" onClick={() => revoke(k._id)}>Revoke</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Budgets() {
  const [caps, setCaps] = useState(null);
  const [apps, setApps] = useState([]);
  const [providers, setProviders] = useState([]);
  const [dimension, setDimension] = useState("application");
  const [value, setValue] = useState("");
  const [period, setPeriod] = useState("month");
  const [limit, setLimit] = useState("");
  const [action, setAction] = useState("alert");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => api.caps().then(setCaps).catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    api.facets().then((f) => setApps(f.applications || [])).catch(() => {});
    api.models().then((m) => setProviders([...new Set(m.map((x) => x.provider))])).catch(() => {});
  }, []);

  const valueOptions = dimension === "application" ? apps : dimension === "provider" ? providers : [];
  useEffect(() => { setValue(valueOptions[0] || ""); }, [dimension, apps, providers]);

  const add = async () => {
    setErr(null);
    if (!(Number(limit) > 0)) return setErr("Enter a limit greater than 0.");
    if (dimension !== "global" && !value) return setErr("Pick a value for the scope.");
    setBusy(true);
    try {
      await api.createCap({
        dimension: dimension === "global" ? null : dimension,
        value: dimension === "global" ? null : value,
        period,
        limit: Number(limit),
        action,
      });
      setLimit("");
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  const toggle = async (c) => { await api.updateCap(c._id, { enabled: !c.enabled }); await load(); };
  const remove = async (id) => { await api.deleteCap(id); await load(); };

  const scopeLabel = (c) => (c.dimension ? `${c.dimension}: ${c.value}` : "global (all spend)");

  return (
    <div className="space-y-6">
      <p className="text-sm text-gray-600">
        Spend is summed over a rolling window (day = last 24h, month = last 30d). Each budget has an
        <strong> action</strong> on breach: <em>Alert</em> just flags it (here and in the header);
        <em> Downgrade</em> forces the provider's light model while breached; <em>Block</em> rejects requests
        in scope (429) until the window rolls past. Downgrade/Block apply to <strong>all</strong> requests in
        scope — including developer-pinned models. Enforcement updates within ~30s of a change.
      </p>

      <div className="flex flex-wrap items-end gap-3 border-b border-gray-100 pb-5">
        <div>
          <div className="label mb-1">Scope</div>
          <select className="input" value={dimension} onChange={(e) => setDimension(e.target.value)}>
            <option value="application">Application</option>
            <option value="provider">Provider</option>
            <option value="global">Global (all spend)</option>
          </select>
        </div>
        {dimension !== "global" && (
          <div>
            <div className="label mb-1">{dimension === "application" ? "Application" : "Provider"}</div>
            <select className="input w-48" value={value} onChange={(e) => setValue(e.target.value)}>
              {valueOptions.length === 0 && <option value="">(none yet)</option>}
              {valueOptions.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>
        )}
        <div>
          <div className="label mb-1">Period</div>
          <select className="input" value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="month">per month (30d)</option>
            <option value="day">per day (24h)</option>
          </select>
        </div>
        <div>
          <div className="label mb-1">Limit (USD)</div>
          <input className="input w-32" type="number" min="0" step="0.01" placeholder="100" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">On breach</div>
          <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="alert">Alert only</option>
            <option value="downgrade">Downgrade to light model</option>
            <option value="block">Block requests</option>
          </select>
        </div>
        <button className="btn-secondary" disabled={busy} onClick={add}>Add budget</button>
        {err && <div className="w-full text-xs text-red-600">{err}</div>}
      </div>

      {caps === null ? <Spinner /> : caps.length === 0 ? (
        <div className="py-6 text-center text-sm text-gray-400">No budgets yet. Add one above.</div>
      ) : (
        <div className="space-y-3">
          {caps.map((c) => {
            const pct = Math.min(1, c.pct || 0);
            const barTone = c.breached ? "bg-red-500" : pct > 0.8 ? "bg-amber-500" : "bg-gyde-green-600";
            return (
              <div key={c._id} className="rounded-lg border border-gray-200 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gyde-charcoal">{scopeLabel(c)}</span>
                    <Badge tone="gray">{c.period === "day" ? "per day" : "per month"}</Badge>
                    {c.breached && <Badge tone="red">{c.action === "block" ? "blocking" : c.action === "downgrade" ? "downgrading" : "over budget"}</Badge>}
                    {!c.enabled && <Badge tone="gray">disabled</Badge>}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-gray-600">
                      {fmt.usd(c.spent)} / {fmt.usd(c.limit)} ({Math.round((c.pct || 0) * 100)}%)
                    </span>
                    <select
                      className="input"
                      value={c.action || "alert"}
                      onChange={async (e) => { await api.updateCap(c._id, { action: e.target.value }); await load(); }}
                    >
                      <option value="alert">Alert</option>
                      <option value="downgrade">Downgrade</option>
                      <option value="block">Block</option>
                    </select>
                    <Toggle checked={c.enabled} onChange={() => toggle(c)} label="enable budget" />
                    <button className="btn-ghost" onClick={() => remove(c._id)}>Delete</button>
                  </div>
                </div>
                <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-gray-100">
                  <div className={`h-full ${barTone}`} style={{ width: `${Math.round(pct * 100)}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function Settings({ onChange }) {
  const [data, setData] = useState(null);
  const [customProvs, setCustomProvs] = useState([]);
  const [err, setErr] = useState(null);
  const [tab, setTab] = useTabParam(SUBTABS);

  const [models, setModels] = useState([]);

  const load = () => Promise.all([
    api.connections(),
    api.customProviders().catch(() => []),
  ]).then(([d, cp]) => { setData(d); setCustomProvs(cp); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); api.models().then(setModels).catch(() => {}); }, []);
  const refresh = async () => { await load(); onChange?.(); };
  const setDefault = async (provider) => { await api.setDefaultProvider(provider); await refresh(); };
  const setModel = async (model) => { await api.setDefaultModel(model); await refresh(); };

  if (err) return <div className="text-red-600">{err}</div>;
  if (!data) return <Spinner />;

  const liveProviders = [
    ...data.providers.filter((p) => p.configured),
    ...customProvs.filter((p) => p.enabled).map((p) => ({ provider: p.id, label: p.label })),
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gyde-charcoal">Settings</h1>
        <p className="text-sm text-gray-500">Provider connections and the model price / tier table.</p>
      </div>

      <Tabs tabs={SUBTABS} active={tab} onChange={setTab} />

      {tab === "connections" && (
        <>
          <Card title="Providers">
            <p className="mb-2 text-sm text-gray-500">
              Add a provider credential to enable live gateway calls — no restart needed. Credentials are
              stored encrypted server-side and never shown again. Environment variables take precedence.
            </p>
            {data.providers.map((p) => <ProviderRow key={p.provider} p={p} onChanged={refresh} />)}
          </Card>

          <Card title="Custom providers">
            <CustomProviders onChanged={refresh} />
          </Card>

          <Card title="Default provider & model">
            <p className="mb-3 text-sm text-gray-600">
              Used when a request sends <code className="rounded bg-gray-100 px-1">model: "auto"</code> or names none.
              The default model applies to the default provider.
            </p>
            <div className="flex flex-wrap items-end gap-4">
              <div>
                <div className="label mb-1">Provider</div>
                <select
                  className="input w-56"
                  value={data.defaultProvider || ""}
                  onChange={(e) => setDefault(e.target.value || null)}
                  disabled={liveProviders.length === 0}
                >
                  {liveProviders.length === 0 && <option value="">No live providers</option>}
                  {liveProviders.map((p) => <option key={p.provider} value={p.provider}>{p.label}</option>)}
                </select>
              </div>
              <div>
                <div className="label mb-1">Model</div>
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

          <Card title="Production note">
            <p className="text-sm text-gray-600">
              For production, prefer environment variables or a secrets manager for provider credentials, and
              set <code className="rounded bg-gray-100 px-1">ARBR_ENCRYPTION_KEY</code> so dashboard-stored
              credentials are encrypted under your own secret rather than the dev fallback.
            </p>
          </Card>
        </>
      )}

      {tab === "budgets" && (
        <Card title="Cost caps">
          <Budgets />
        </Card>
      )}

      {tab === "keys" && (
        <Card title="Gateway API keys">
          <ApiKeys onChange={onChange} />
        </Card>
      )}
    </div>
  );
}
