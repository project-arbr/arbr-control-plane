import React, { useCallback, useEffect, useRef, useState } from "react";
import { api, fmt } from "../api.js";
import { Badge, Card, Spinner } from "../components/ui.jsx";

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtCtx(n) {
  if (!n) return null;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}K tokens`;
  return `${n} tokens`;
}

// Provider display labels — covers common LiteLLM provider IDs so they show
// a human-readable name in the sidebar. Anything not listed falls back to a
// simple title-case transform of the provider ID.
const PROVIDER_LABELS = {
  "openai":       "OpenAI",
  "anthropic":    "Anthropic",
  "gemini":       "Google Gemini",
  "bedrock-nova": "Amazon Bedrock",
  "deepseek":     "DeepSeek",
  "moonshot":     "Moonshot AI",
  "xai":          "xAI",
  "groq":         "Groq",
  "mistral":      "Mistral AI",
  "cohere":       "Cohere",
  "azure":        "Azure OpenAI",
  "azure-ai":     "Azure AI Studio",
  "vertex-ai":    "Vertex AI",
  "together-ai":  "Together AI",
  "fireworks":    "Fireworks AI",
  "perplexity":   "Perplexity",
  "cerebras":     "Cerebras",
  "sambanova":    "SambaNova",
  "databricks":   "Databricks",
  "deepinfra":    "DeepInfra",
  "ollama":       "Ollama",
  "anyscale":     "Anyscale",
  "openrouter":   "OpenRouter",
  "novita":       "Novita AI",
  "replicate":    "Replicate",
  "snowflake":    "Snowflake",
  "dashscope":    "Alibaba (DashScope)",
  "cloudflare":   "Cloudflare AI",
  "watsonx":      "IBM watsonx",
  "nebius":       "Nebius AI",
  "lambda-ai":    "Lambda AI",
  "hyperbolic":   "Hyperbolic",
  "minimax":      "MiniMax",
  "volcengine":   "Volcengine",
};

function providerLabel(id) {
  return PROVIDER_LABELS[id] ??
    id.split(/[-_]/).map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");
}

function tierTone(tier) {
  return tier === "premium" ? "violet" : tier === "mid" ? "indigo" : "teal";
}

function StatusDot({ live }) {
  return (
    <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${live ? "bg-arbr-green-600" : "bg-gray-300"}`} />
  );
}

function Field({ label, children }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-gray-700">{label}</span>
      {children}
    </label>
  );
}

const INPUT = "w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm focus:border-arbr-green-600 focus:outline-none focus:ring-1 focus:ring-arbr-green-600";
const BTN   = "rounded-md px-3 py-1.5 text-sm font-medium transition-colors";
const BTN_PRIMARY = `${BTN} bg-arbr-green-600 text-white hover:bg-arbr-green-700`;
const BTN_GHOST   = `${BTN} border border-gray-300 text-gray-700 hover:bg-gray-50`;
const BTN_DANGER  = `${BTN} text-red-600 hover:bg-red-50`;

// ── ModelBenchmarkPanel ───────────────────────────────────────────────────────

const BENCH_DIMS = ["coding", "reasoning", "writing", "analysis", "language", "general", "data"];

function BenchmarkBar({ dim, value }) {
  const pct = value != null ? Math.round(value * 100) : null;
  return (
    <div className="flex items-center gap-3 text-xs">
      <span className="w-16 text-right text-gray-500 capitalize flex-shrink-0">{dim}</span>
      <div className="flex-1 h-1.5 rounded-full bg-gray-200 overflow-hidden">
        {pct != null && (
          <div className="h-1.5 rounded-full bg-arbr-green-600 transition-all" style={{ width: `${pct}%` }} />
        )}
      </div>
      <span className="w-8 font-mono text-gray-600 flex-shrink-0">{pct != null ? pct : "—"}</span>
    </div>
  );
}

function ModelBenchmarkPanel({ model }) {
  const caps   = model.capabilities || {};
  const hasCaps = BENCH_DIMS.some((d) => caps[d] != null);

  if (!hasCaps) return null;

  return (
    <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
          {model.livebenchSyncedAt ? "LiveBench scores" : "LMSYS Arena score (general only)"}
        </span>
        <span className="text-xs text-gray-400 font-mono truncate max-w-[240px]"
              title={model.livebenchModelName || model.lmsysModelName}>
          {model.livebenchModelName || model.lmsysModelName || ""}
        </span>
      </div>
      {BENCH_DIMS.map((d) => (
        <BenchmarkBar key={d} dim={d} value={caps[d]} />
      ))}
      <p className="text-xs text-gray-400 pt-1">
        {model.livebenchSyncedAt
          ? `LiveBench · synced ${new Date(model.livebenchSyncedAt).toLocaleString()}`
          : model.lmsysSyncedAt
            ? `LMSYS Arena (Elo-based) · synced ${new Date(model.lmsysSyncedAt).toLocaleString()}`
            : ""}
      </p>
    </div>
  );
}

// ── ModelMetaPanel ────────────────────────────────────────────────────────────

function ModelMetaPanel({ model }) {
  const rows = [
    model.inputPer1M  != null && ["Price",          `${fmt.usd(model.inputPer1M)} in / ${fmt.usd(model.outputPer1M)} out per 1M tokens`],
    model.bestUsedFor              && ["Best used for",  model.bestUsedFor],
    model.releaseDate              && ["Released",       model.releaseDate],
    model.contextWindow            && ["Context window", fmtCtx(model.contextWindow)],
  ].filter(Boolean);

  const chips = [
    model.toolCallSupported      === true && "Tools",
    model.supportsVision         === true && "Vision",
    model.supportsReasoning      === true && "Reasoning",
    model.supportsPdfInput       === true && "PDF",
    model.supportsPromptCaching  === true && "Caching",
    model.supportsVideoInput     === true && "Video",
    model.supportsResponseSchema === true && "Schema",
  ].filter(Boolean);

  if (!rows.length && !chips.length) return null;

  return (
    <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 space-y-3">
      {rows.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-col">
              <dt className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</dt>
              <dd className="text-gray-800">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {chips.length > 0 && (
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 uppercase tracking-wide">Capabilities</span>
          {chips.map((c) => (
            <span key={c} className="rounded-full bg-arbr-green-50 border border-arbr-green-200 px-2 py-0.5 text-xs font-medium text-arbr-green-700">{c}</span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── ModelTestPanel ────────────────────────────────────────────────────────────

function ModelTestPanel({ modelId }) {
  const [msg, setMsg]       = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr]       = useState("");

  async function run() {
    if (!msg.trim()) return;
    setLoading(true); setErr(""); setResult(null);
    try {
      const r = await api.testModel(modelId, msg.trim());
      if (r.ok) setResult(r);
      else setErr(r.message || "Test failed");
    } catch (e) { setErr(e.message || "Request failed"); }
    finally { setLoading(false); }
  }

  return (
    <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 space-y-3">
      <div className="flex gap-2">
        <input
          className={`${INPUT} flex-1`}
          placeholder="Enter a test message…"
          value={msg}
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
        />
        <button className={BTN_PRIMARY} onClick={run} disabled={loading || !msg.trim()}>
          {loading ? "Running…" : "Run test"}
        </button>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {result && (
        <div className="rounded-lg border border-gray-200 bg-white p-3 space-y-2">
          <p className="text-sm text-gray-800 font-mono whitespace-pre-wrap">{result.text}</p>
          <div className="flex flex-wrap gap-4 text-xs text-gray-500 border-t border-gray-100 pt-2">
            <span>Model: <span className="font-medium text-gray-700">{result.model}</span></span>
            <span>Latency: <span className="font-medium text-gray-700">{result.latencyMs}ms</span></span>
            {result.usage?.inputTokens != null && (
              <span>Tokens: <span className="font-medium text-gray-700">{result.usage.inputTokens} in / {result.usage.outputTokens} out</span></span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── ModelRow ──────────────────────────────────────────────────────────────────

function ModelRow({ model, onRefresh }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing]   = useState(false);
  const [showTest, setShowTest] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm]         = useState({});
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState("");

  function toggleExpand() {
    setExpanded((v) => !v);
    setEditing(false);
    setShowTest(false);
    setDeleting(false);
  }

  function startEdit() {
    setForm({
      label:         model.label || "",
      tier:          model.tier,
      inputPer1M:    model.inputPer1M,
      outputPer1M:   model.outputPer1M,
      bestUsedFor:   model.bestUsedFor || "",
      releaseDate:   model.releaseDate || "",
      contextWindow: model.contextWindow || "",
    });
    setEditing(true);
    setExpanded(false);
    setShowTest(false);
  }

  async function saveEdit() {
    setSaving(true); setErr("");
    try {
      await api.updateModel(model.id, {
        label:         form.label,
        tier:          form.tier,
        inputPer1M:    Number(form.inputPer1M),
        outputPer1M:   Number(form.outputPer1M),
        bestUsedFor:   form.bestUsedFor,
        releaseDate:   form.releaseDate,
        contextWindow: form.contextWindow ? Number(form.contextWindow) : null,
      });
      setEditing(false);
      onRefresh();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  async function doDelete() {
    setSaving(true);
    try { await api.deleteModel(model.id); onRefresh(); }
    catch (e) { setErr(e.message); setSaving(false); }
  }

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      {/* collapsed row — click anywhere to expand */}
      <div
        className="flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50 transition-colors cursor-pointer select-none"
        onClick={toggleExpand}
      >
        <svg
          className={`w-4 h-4 flex-shrink-0 text-gray-400 transition-transform ${expanded || editing ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>

        <div className="flex-1 min-w-0">
          <div className="font-medium text-arbr-charcoal truncate">{model.label || model.id}</div>
          {model.label && <div className="text-xs text-gray-400 truncate font-mono">{model.id}</div>}
        </div>

        <Badge tone={tierTone(model.tier)}>{model.tier}</Badge>
      </div>

      {/* edit form */}
      {editing && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Label">
              <input className={INPUT} value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
            </Field>
            <Field label="Tier">
              <select className={INPUT} value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
                <option value="light">light</option>
                <option value="mid">mid</option>
                <option value="premium">premium</option>
              </select>
            </Field>
            <Field label="Input $/1M">
              <input type="number" min="0" step="0.01" className={INPUT} value={form.inputPer1M} onChange={(e) => setForm({ ...form, inputPer1M: e.target.value })} />
            </Field>
            <Field label="Output $/1M">
              <input type="number" min="0" step="0.01" className={INPUT} value={form.outputPer1M} onChange={(e) => setForm({ ...form, outputPer1M: e.target.value })} />
            </Field>
            <Field label="Best used for">
              <input className={INPUT} value={form.bestUsedFor} onChange={(e) => setForm({ ...form, bestUsedFor: e.target.value })} placeholder="e.g. Fast summarisation tasks" />
            </Field>
            <Field label="Release date">
              <input className={INPUT} value={form.releaseDate} onChange={(e) => setForm({ ...form, releaseDate: e.target.value })} placeholder="e.g. 2025-06" />
            </Field>
            <Field label="Context window (tokens)">
              <input type="number" min="0" className={INPUT} value={form.contextWindow} onChange={(e) => setForm({ ...form, contextWindow: e.target.value })} placeholder="e.g. 128000" />
            </Field>
          </div>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2">
            <button onClick={saveEdit} disabled={saving} className={BTN_PRIMARY}>{saving ? "Saving…" : "Save"}</button>
            <button onClick={() => setEditing(false)} className={BTN_GHOST}>Cancel</button>
          </div>
        </div>
      )}

      {/* expanded card — meta + scores + actions */}
      {expanded && !editing && (
        <div className="border-t border-gray-100">
          <ModelMetaPanel model={model} />
          <ModelBenchmarkPanel model={model} />
          {showTest && <ModelTestPanel modelId={model.id} />}

          {/* action bar */}
          <div className="px-4 py-2.5 bg-gray-50 border-t border-gray-100 flex items-center gap-2">
            <button
              onClick={(e) => { e.stopPropagation(); setShowTest((v) => !v); setDeleting(false); }}
              className={`${BTN} text-xs ${showTest ? "bg-arbr-green-50 text-arbr-green-700 border border-arbr-green-200" : "text-gray-600 hover:bg-gray-100"}`}
            >
              Test
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); startEdit(); }}
              className={`${BTN} text-xs text-gray-600 hover:bg-gray-100`}
            >
              Edit
            </button>
            {!deleting
              ? (
                <button
                  onClick={(e) => { e.stopPropagation(); setDeleting(true); }}
                  className={`${BTN} text-xs ${BTN_DANGER}`}
                >
                  Delete
                </button>
              ) : (
                <span className="flex items-center gap-1 text-xs">
                  <button onClick={doDelete} disabled={saving} className={`${BTN} text-xs bg-red-600 text-white hover:bg-red-700`}>Confirm delete</button>
                  <button onClick={() => setDeleting(false)} className={`${BTN} text-xs text-gray-500`}>Cancel</button>
                </span>
              )
            }
            {err && <p className="text-xs text-red-600 ml-1">{err}</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// ── AddModelForm ──────────────────────────────────────────────────────────────

function AddModelForm({ providerId, models, onSave, onClose }) {
  const [form, setForm]       = useState({ id: "", label: "", tier: "light" });
  const [autoFilled, setAutoFilled] = useState(false);
  const [saving, setSaving]   = useState(false);
  const [err, setErr]         = useState("");

  function lookupAndFill(id) {
    const match = (models || []).find((m) => m.id === id.trim());
    if (!match) { setAutoFilled(false); return; }
    setForm((prev) => ({
      ...prev,
      label: prev.label || match.label || "",
      tier:  match.tier || prev.tier,
    }));
    setAutoFilled(true);
  }

  async function submit(e) {
    e.preventDefault();
    const id    = form.id.trim();
    const label = form.label.trim();
    if (!id)    { setErr("Model ID is required"); return; }
    if (!label) { setErr("Display name is required"); return; }
    setSaving(true); setErr("");
    try {
      // Merge any registry metadata for fields the user didn't supply.
      const existing = (models || []).find((m) => m.id === id);
      await api.createModel({
        id, provider: providerId, label, tier: form.tier,
        inputPer1M:    existing?.inputPer1M    ?? 0,
        outputPer1M:   existing?.outputPer1M   ?? 0,
        bestUsedFor:   existing?.bestUsedFor   ?? "",
        releaseDate:   existing?.releaseDate   ?? "",
        contextWindow: existing?.contextWindow ?? null,
      });
      onSave();
    } catch (e) { setErr(e.message || "Failed to create model"); }
    finally { setSaving(false); }
  }

  const s = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  return (
    <form onSubmit={submit} className="border border-gray-200 rounded-lg bg-gray-50 px-4 py-4 space-y-3">
      <p className="text-sm font-semibold text-arbr-charcoal">Add model</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Model ID *">
          <input
            className={INPUT}
            placeholder="e.g. gpt-4o-mini"
            value={form.id}
            onChange={s("id")}
            onBlur={(e) => lookupAndFill(e.target.value)}
            required
          />
        </Field>
        <Field label="Display name *">
          <div className="relative">
            <input
              className={INPUT}
              placeholder="e.g. GPT-4o Mini"
              value={form.label}
              onChange={(e) => { setAutoFilled(false); s("label")(e); }}
              required
            />
            {autoFilled && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-arbr-green-600 font-medium">
                auto-filled
              </span>
            )}
          </div>
        </Field>
        <Field label="Tier *">
          <select className={INPUT} value={form.tier} onChange={s("tier")}>
            <option value="light">light</option>
            <option value="mid">mid</option>
            <option value="premium">premium</option>
          </select>
        </Field>
      </div>
      {autoFilled && (
        <p className="text-xs text-gray-400">
          Pricing and metadata pre-filled from the model registry.
        </p>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className={BTN_PRIMARY}>{saving ? "Adding…" : "Add model"}</button>
        <button type="button" onClick={onClose} className={BTN_GHOST}>Cancel</button>
      </div>
    </form>
  );
}

// ── ModelList ─────────────────────────────────────────────────────────────────

function ModelList({ providerId, models, onRefresh }) {
  const providerModels = models.filter((m) => m.provider === providerId);
  const [disc, setDisc]       = useState(null);   // array of {id, known, registered} | { error } | null
  const [sel, setSel]         = useState({});     // id -> selected
  const [busy, setBusy]       = useState(false);
  const [summary, setSummary] = useState(null);

  async function discover() {
    setBusy(true); setSummary(null); setDisc(null);
    try {
      const r = await api.discoverProviderModels(providerId);
      if (!r.ok) { setDisc({ error: r.message }); return; }
      setDisc(r.models);
      const s = {};
      r.models.forEach((m) => { if (!m.registered) s[m.id] = true; });  // default: import all not-yet-registered
      setSel(s);
    } catch (e) { setDisc({ error: e.message }); }
    finally { setBusy(false); }
  }

  async function importSelected() {
    const chosen = Object.keys(sel).filter((id) => sel[id]);
    if (!chosen.length) return;
    setBusy(true);
    try {
      const r = await api.importProviderModels(providerId, chosen);
      setSummary(r); setDisc(null); onRefresh();
    } catch (e) { setSummary({ error: e.message }); }
    finally { setBusy(false); }
  }

  const selectedCount = Object.values(sel).filter(Boolean).length;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-gray-700">
          Models <span className="font-normal text-gray-400">({providerModels.length})</span>
        </h3>
        <button onClick={discover} disabled={busy} className={BTN_GHOST}>
          {busy && !disc ? "Discovering…" : "Discover models"}
        </button>
      </div>

      {summary && (
        summary.error
          ? <p className="text-sm text-red-600">{summary.error}</p>
          : <p className="text-sm text-arbr-green-700">Imported: {summary.created} new, {summary.adopted} adopted, {summary.skipped} already present{summary.conflicts?.length ? `, ${summary.conflicts.length} skipped (owned by another provider)` : ""}.</p>
      )}

      {disc && disc.error && <p className="text-sm text-red-600">Discovery failed: {disc.error}</p>}
      {Array.isArray(disc) && (
        <div className="rounded-lg border border-gray-200 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm text-gray-500">{disc.length} models from provider · {selectedCount} selected</span>
            <button onClick={importSelected} disabled={busy || !selectedCount} className={BTN_PRIMARY}>
              {busy ? "Importing…" : `Import selected (${selectedCount})`}
            </button>
          </div>
          <div className="max-h-64 space-y-1 overflow-y-auto">
            {disc.map((m) => (
              <label key={m.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-gray-50">
                <input type="checkbox" checked={!!sel[m.id]} disabled={m.registered}
                  onChange={(e) => setSel((s) => ({ ...s, [m.id]: e.target.checked }))} />
                <span className="font-mono text-gray-700">{m.id}</span>
                {m.registered ? <Badge tone="green">registered</Badge> : m.known && <Badge tone="gray">known pricing</Badge>}
              </label>
            ))}
          </div>
        </div>
      )}

      {providerModels.length === 0 && !disc && (
        <p className="text-sm text-gray-400 py-4 text-center">No models registered. Use “Discover models” to import from the provider.</p>
      )}

      <div className="space-y-2">
        {providerModels.map((m) => (
          <ModelRow key={m.id} model={m} onRefresh={onRefresh} />
        ))}
      </div>
    </div>
  );
}

// ── ProviderConfigureForm ─────────────────────────────────────────────────────

function ProviderConfigureForm({ provider, onSaved, onCancel }) {
  const isAws = provider.authType === "aws";
  const [form, setForm] = useState({
    apiKey: "", accessKeyId: "", secretAccessKey: "", region: provider.region || "us-east-1",
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState("");

  async function submit(e) {
    e.preventDefault();
    setSaving(true); setErr("");
    try {
      const cred = isAws
        ? { accessKeyId: form.accessKeyId, secretAccessKey: form.secretAccessKey, region: form.region }
        : { apiKey: form.apiKey };
      await api.setProviderCredential(provider.provider, cred);
      onSaved();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  const s = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <form onSubmit={submit} className="space-y-3 p-4 bg-gray-50 rounded-lg border border-gray-200">
      {isAws ? (
        <>
          <Field label="Access Key ID">
            <input className={INPUT} placeholder="AKIA…" value={form.accessKeyId} onChange={s("accessKeyId")} required />
          </Field>
          <Field label="Secret Access Key">
            <input type="password" className={INPUT} placeholder="••••••••" value={form.secretAccessKey} onChange={s("secretAccessKey")} required />
          </Field>
          <Field label="Region">
            <input className={INPUT} value={form.region} onChange={s("region")} placeholder="us-east-1" />
          </Field>
        </>
      ) : (
        <Field label="API Key">
          <input type="password" className={INPUT} placeholder="••••••••" value={form.apiKey} onChange={s("apiKey")} required />
        </Field>
      )}
      {err && <p className="text-sm text-red-600">{err}</p>}
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className={BTN_PRIMARY}>{saving ? "Saving…" : "Save"}</button>
        <button type="button" onClick={onCancel} className={BTN_GHOST}>Cancel</button>
      </div>
    </form>
  );
}

// ── BuiltinProviderDetail ─────────────────────────────────────────────────────

function BuiltinProviderDetail({ provider, models, onRefresh }) {
  const [configuring, setConfiguring]     = useState(false);
  const [testResult, setTestResult]       = useState(null);
  const [testing, setTesting]             = useState(false);

  async function testConn() {
    setTesting(true); setTestResult(null);
    try {
      const r = await api.testProvider(provider.provider);
      setTestResult(r);
    } catch { setTestResult({ ok: false, message: "Request failed" }); }
    finally { setTesting(false); }
  }

  async function removeKey() {
    if (!window.confirm("Remove this credential? Requests to this provider will fail until a new key is added.")) return;
    try { await api.removeProviderKey(provider.provider); onRefresh(); }
    catch (e) { alert(e.message); }
  }

  const isLive = provider.configured;

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-arbr-charcoal">{provider.label}</h2>
          <div className="flex items-center gap-2 mt-1">
            <StatusDot live={isLive} />
            <span className="text-sm text-gray-500">
              {isLive
                ? provider.authType === "aws"
                  ? `AWS · ${provider.region || "us-east-1"}`
                  : `API key ····${provider.last4}`
                : "Not configured"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isLive && !configuring && (
            <>
              <button onClick={testConn} disabled={testing} className={BTN_GHOST}>
                {testing ? "Testing…" : "Test connection"}
              </button>
              {provider.editable && (
                <button onClick={removeKey} className={`${BTN} text-red-600 border border-red-200 hover:bg-red-50`}>Remove key</button>
              )}
            </>
          )}
          {!configuring && (
            <button onClick={() => setConfiguring(true)} className={BTN_PRIMARY}>
              {isLive ? "Reconfigure" : "Configure"}
            </button>
          )}
        </div>
      </div>

      {testResult && (
        <div className={`text-sm rounded-lg px-4 py-3 ${testResult.ok ? "bg-arbr-green-50 text-arbr-green-800 border border-arbr-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {testResult.ok ? `✓ Connected · model: ${testResult.model}${testResult.sample ? ` · "${testResult.sample}"` : ""}` : `✗ ${testResult.message}`}
        </div>
      )}

      {configuring && (
        <ProviderConfigureForm
          provider={provider}
          onSaved={() => { setConfiguring(false); onRefresh(); }}
          onCancel={() => setConfiguring(false)}
        />
      )}

      <ModelList providerId={provider.provider} models={models} onRefresh={onRefresh} />
    </div>
  );
}

// ── CustomProviderDetail ──────────────────────────────────────────────────────

function CustomProviderDetail({ provider, models, onRefresh, onDeleted }) {
  const [editing, setEditing]   = useState(false);
  const [form, setForm]         = useState({ label: provider.label, baseURL: provider.baseURL, apiKey: "" });
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState("");
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting]   = useState(false);

  async function saveEdit(e) {
    e.preventDefault();
    setSaving(true); setErr("");
    try {
      const body = { label: form.label, baseURL: form.baseURL };
      if (form.apiKey.trim()) body.apiKey = form.apiKey.trim();
      await api.updateCustomProvider(provider.id, body);
      setEditing(false);
      onRefresh();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  }

  async function toggle() {
    try { await api.updateCustomProvider(provider.id, { enabled: !provider.enabled }); onRefresh(); }
    catch (e) { alert(e.message); }
  }

  async function remove() {
    if (!window.confirm(`Delete custom provider "${provider.label}"? Models registered against it will stop routing.`)) return;
    try { await api.removeCustomProvider(provider.id); onDeleted(); }
    catch (e) { alert(e.message); }
  }

  async function testConn() {
    const firstModel = models.find((m) => m.provider === provider.id);
    setTesting(true); setTestResult(null);
    try {
      const r = await api.testCustomProvider(provider.id, firstModel?.id || null);
      setTestResult(r);
    } catch { setTestResult({ ok: false, message: "Request failed" }); }
    finally { setTesting(false); }
  }

  const s = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="space-y-6">
      {/* header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-arbr-charcoal">{provider.label}</h2>
            <Badge tone="gray">custom</Badge>
            {!provider.enabled && <Badge tone="amber">disabled</Badge>}
          </div>
          <div className="mt-1 space-y-0.5">
            <p className="text-sm text-gray-500 font-mono">{provider.baseURL}</p>
            <p className="text-sm text-gray-400">API key ····{provider.last4}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={testConn} disabled={testing} className={BTN_GHOST}>
            {testing ? "Testing…" : "Test connection"}
          </button>
          <button onClick={toggle} className={BTN_GHOST}>{provider.enabled ? "Disable" : "Enable"}</button>
          <button onClick={() => { setEditing(!editing); setErr(""); }} className={BTN_PRIMARY}>Edit</button>
          <button onClick={remove} className={`${BTN} text-red-600 border border-red-200 hover:bg-red-50`}>Delete</button>
        </div>
      </div>

      {testResult && (
        <div className={`text-sm rounded-lg px-4 py-3 ${testResult.ok ? "bg-arbr-green-50 text-arbr-green-800 border border-arbr-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
          {testResult.ok ? `✓ Connected · "${testResult.sample}"` : `✗ ${testResult.message}`}
        </div>
      )}

      {editing && (
        <form onSubmit={saveEdit} className="p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-3">
          <Field label="Label">
            <input className={INPUT} value={form.label} onChange={s("label")} required />
          </Field>
          <Field label="Base URL">
            <input className={INPUT} value={form.baseURL} onChange={s("baseURL")} required />
          </Field>
          <Field label="New API key (leave blank to keep current)">
            <input type="password" className={INPUT} placeholder="••••••••" value={form.apiKey} onChange={s("apiKey")} />
          </Field>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className={BTN_PRIMARY}>{saving ? "Saving…" : "Save"}</button>
            <button type="button" onClick={() => setEditing(false)} className={BTN_GHOST}>Cancel</button>
          </div>
        </form>
      )}

      <ModelList providerId={provider.id} models={models} onRefresh={onRefresh} />
    </div>
  );
}

// ── CatalogProviderDetail ─────────────────────────────────────────────────────

// Known OpenAI-compatible base URLs and hints for catalog providers.
// url: pre-filled value (empty = account-specific, user must supply)
// hint: shown below the Base URL field to guide the user
const PROVIDER_ENDPOINT_INFO = {
  "nvidia-nim":  { url: "https://integrate.api.nvidia.com/v1", hint: "Free nvapi- key from build.nvidia.com" },
  "mistral":     { url: "https://api.mistral.ai/v1" },
  "cohere":      { url: "https://api.cohere.ai/v1" },
  "together-ai": { url: "https://api.together.xyz/v1" },
  "fireworks":   { url: "https://api.fireworks.ai/inference/v1" },
  "perplexity":  { url: "https://api.perplexity.ai" },
  "cerebras":    { url: "https://api.cerebras.ai/v1" },
  "sambanova":   { url: "https://api.sambanova.ai/v1" },
  "deepinfra":   { url: "https://api.deepinfra.com/v1/openai" },
  "openrouter":  { url: "https://openrouter.ai/api/v1" },
  "novita":      { url: "https://api.novita.ai/v3/openai" },
  "replicate":   { url: "https://api.replicate.com/v1" },
  "nebius":      { url: "https://api.studio.nebius.ai/v1" },
  "lambda-ai":   { url: "https://api.lambdalabs.com/v1" },
  "hyperbolic":  { url: "https://api.hyperbolic.xyz/v1" },
  "minimax":     { url: "https://api.minimax.io/v1" },
  "groq":        { url: "https://api.groq.com/openai/v1" },
  "deepseek":    { url: "https://api.deepseek.com/v1" },
  "xai":         { url: "https://api.x.ai/v1" },
  "moonshot":    { url: "https://api.moonshot.cn/v1" },
  "azure-ai":    { url: "https://models.inference.ai.azure.com" },
  "dashscope":   { url: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
  "anyscale":    { url: "https://api.endpoints.anyscale.com/v1" },
  "volcengine":  { url: "https://ark.cn-beijing.volces.com/api/v3" },
  "databricks":  { url: "", hint: "https://your-workspace.cloud.databricks.com/serving-endpoints — find this in your Databricks workspace settings" },
  "snowflake":   { url: "", hint: "https://your-account.snowflakecomputing.com/api/v2 — find your account URL in Snowflake console" },
  "cloudflare":  { url: "", hint: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1 — replace {account_id} from your Cloudflare dashboard" },
  "watsonx":     { url: "", hint: "https://us-south.ml.cloud.ibm.com — region varies; find your endpoint in IBM Cloud" },
  "vertex-ai":   { url: "", hint: "https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/endpoints/openapi — project-specific" },
};

function CatalogProviderDetail({ provider, models, onRefresh }) {
  const info    = PROVIDER_ENDPOINT_INFO[provider.provider] ?? { url: "", hint: null };
  const [connecting, setConnecting] = useState(false);
  const [form, setForm]             = useState({ baseURL: info.url, apiKey: "" });
  const [saving, setSaving]         = useState(false);
  const [err, setErr]               = useState("");

  const s = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function connect(e) {
    e.preventDefault();
    if (!form.baseURL.trim()) { setErr("Base URL is required"); return; }
    if (!form.apiKey.trim())  { setErr("API key is required");  return; }
    setSaving(true); setErr("");
    try {
      await api.addCustomProvider({
        id:      provider.provider,
        label:   provider.label,
        baseURL: form.baseURL.trim(),
        apiKey:  form.apiKey.trim(),
      });
      onRefresh();
    } catch (e) { setErr(e.message || "Failed to connect"); }
    finally { setSaving(false); }
  }

  const modelCount = models.filter((m) => m.provider === provider.provider).length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-arbr-charcoal">{provider.label}</h2>
            <Badge tone="gray">not connected</Badge>
          </div>
          <p className="mt-1 text-sm text-gray-500">
            {modelCount} models in catalog · add credentials to route traffic through Arbr.
          </p>
        </div>
        {!connecting && (
          <button className={BTN_PRIMARY} onClick={() => setConnecting(true)}>
            Connect
          </button>
        )}
      </div>

      {connecting && (
        <form onSubmit={connect} className="p-4 bg-gray-50 rounded-lg border border-gray-200 space-y-4">
          <div>
            <p className="text-sm font-semibold text-gray-800">Connect {provider.label}</p>
            <p className="mt-0.5 text-xs text-gray-500">
              Arbr proxies requests to this provider's OpenAI-compatible endpoint using your API key.
            </p>
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <label className="font-medium text-gray-700">
              Base URL
              {info.url && <span className="ml-2 text-xs font-normal text-arbr-green-700">· pre-filled with official endpoint</span>}
              {!info.url && <span className="ml-2 text-xs font-normal text-amber-600">· account-specific, see hint below</span>}
            </label>
            <input
              className={INPUT}
              value={form.baseURL}
              onChange={s("baseURL")}
              placeholder={info.hint ? info.hint.split(" — ")[0] : "https://api.example.com/v1"}
              required
            />
            {info.hint && (
              <p className="text-xs text-gray-400 leading-relaxed">{info.hint}</p>
            )}
            {!info.url && !info.hint && (
              <p className="text-xs text-gray-400">The root URL of the provider's OpenAI-compatible API, e.g. https://api.example.com/v1</p>
            )}
          </div>

          <div className="flex flex-col gap-1 text-sm">
            <label className="font-medium text-gray-700">API Key</label>
            <input
              type="password"
              className={INPUT}
              placeholder="Paste your API key"
              value={form.apiKey}
              onChange={s("apiKey")}
              required
            />
            <p className="text-xs text-gray-400">Stored encrypted. Never logged or sent anywhere except to the provider endpoint above.</p>
          </div>

          {err && <p className="text-sm text-red-600">{err}</p>}
          <div className="flex gap-2">
            <button type="submit" disabled={saving} className={BTN_PRIMARY}>
              {saving ? "Connecting…" : "Save & connect"}
            </button>
            <button type="button" onClick={() => { setConnecting(false); setErr(""); }} className={BTN_GHOST}>
              Cancel
            </button>
          </div>
        </form>
      )}

      <ModelList providerId={provider.provider} models={models} onRefresh={onRefresh} />
    </div>
  );
}

// ── AddProviderForm ───────────────────────────────────────────────────────────

function AddProviderForm({ onSaved, onClose }) {
  const [form, setForm] = useState({ id: "", label: "", baseURL: "", apiKey: "" });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState("");

  async function submit(e) {
    e.preventDefault();
    if (!form.id.trim() || !form.label.trim() || !form.baseURL.trim() || !form.apiKey.trim()) {
      setErr("All fields are required"); return;
    }
    setSaving(true); setErr("");
    try { await api.addCustomProvider(form); onSaved(); }
    catch (e) { setErr(e.message || "Failed"); }
    finally { setSaving(false); }
  }

  const s = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <form onSubmit={submit} className="mx-2 mb-2 p-3 bg-gray-50 rounded-lg border border-gray-200 space-y-2">
      <p className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Add custom provider</p>
      <Field label="Provider ID (slug)">
        <input className={INPUT} placeholder="my-provider" value={form.id} onChange={s("id")} required />
        <span className="text-[11px] text-gray-400">Lowercase, no spaces. Used internally to match models.</span>
      </Field>
      <Field label="Display name">
        <input className={INPUT} placeholder="My Provider" value={form.label} onChange={s("label")} required />
      </Field>
      <Field label="Base URL">
        <input className={INPUT} placeholder="https://api.example.com/v1" value={form.baseURL} onChange={s("baseURL")} required />
        <span className="text-[11px] text-gray-400">Root URL of the OpenAI-compatible endpoint (no trailing slash).</span>
      </Field>
      <Field label="API Key">
        <input type="password" className={INPUT} placeholder="Paste your API key" value={form.apiKey} onChange={s("apiKey")} required />
      </Field>
      {err && <p className="text-xs text-red-600">{err}</p>}
      <div className="flex gap-2 pt-1">
        <button type="submit" disabled={saving} className={`${BTN_PRIMARY} text-xs`}>{saving ? "Adding…" : "Add provider"}</button>
        <button type="button" onClick={onClose} className={`${BTN_GHOST} text-xs`}>Cancel</button>
      </div>
    </form>
  );
}

// ── ProviderSidebar ───────────────────────────────────────────────────────────

function ProviderSidebar({ allProviders, selected, onSelect, onRefresh }) {
  const [adding, setAdding] = useState(false);

  return (
    <aside className="w-64 flex-shrink-0 border-r border-gray-200 flex flex-col">
      {/* + Add provider hidden for now */}

      <nav className="flex-1 overflow-y-auto py-2">
        {allProviders.map((p) => (
          <button
            key={`${p.type}:${p.provider}`}
            onClick={() => onSelect(p)}
            className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left transition-colors ${
              selected?.provider === p.provider && selected?.type === p.type
                ? "bg-arbr-green-50 text-arbr-charcoal font-medium"
                : "text-gray-600 hover:bg-gray-50"
            }`}
          >
            <StatusDot live={p.connected} />
            <span className="truncate">{p.label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

// ── Models (page root) ────────────────────────────────────────────────────────

// Build a flat unified provider list from DB models + connection data + custom providers.
// No static list — providers are whatever is in the model registry after sync.
function buildProviderList(models, builtinData, customData) {
  const builtinMap = Object.fromEntries(builtinData.map((b) => [b.provider, b]));
  const customMap  = Object.fromEntries(customData.map((c) => [c.id, c]));

  // Collect unique provider IDs from the model registry
  const providerIds = [...new Set(models.map((m) => m.provider))];

  const known = providerIds.map((id) => {
    const b = builtinMap[id];
    const c = customMap[id];
    if (c) {
      return { provider: id, label: c.label, type: "custom", connected: c.enabled ?? false, ...c };
    }
    return {
      provider:  id,
      label:     b?.label ?? providerLabel(id),
      type:      b ? "builtin" : "catalog",
      connected: b?.configured ?? false,
      ...(b || {}),
    };
  });

  // Also include custom providers that have no models yet
  for (const c of customData) {
    if (!known.find((p) => p.provider === c.id)) {
      known.push({ provider: c.id, label: c.label, type: "custom", connected: c.enabled ?? false, ...c });
    }
  }

  return known.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

export default function Models() {
  const [builtins, setBuiltins]     = useState([]);
  const [customs, setCustoms]       = useState([]);
  const [models, setModels]         = useState([]);
  const [selected, setSelected]     = useState(null);
  const [loading, setLoading]       = useState(true);
  const [benchStatus, setBenchStatus] = useState(null);
  const [syncing, setSyncing]         = useState(false);
  const [syncMsg, setSyncMsg]         = useState(null);

  const load = useCallback(async () => {
    try {
      const [connData, cpData, modData] = await Promise.all([
        api.connections(),
        api.customProviders(),
        api.models(),
      ]);
      setBuiltins(connData.providers || []);
      setCustoms(cpData || []);
      setModels(modData || []);
      setLoading(false);
    } catch { setLoading(false); }
  }, []);

  const loadBenchStatus = useCallback(() => {
    api.benchmarksStatus().then(setBenchStatus).catch(() => {});
  }, []);

  const syncBenchmarks = async () => {
    setSyncing(true); setSyncMsg("Syncing models…");
    try {
      const result = await api.syncBenchmarks();
      setBenchStatus({ lastSyncedAt: new Date().toISOString() });
      const lb      = result.livebench?.matched ?? 0;
      const ls      = result.lmsys?.matched    ?? 0;
      const lt      = result.litellm?.matched  ?? 0;
      const added   = result.litellm?.added    ?? 0;
      const removed = result.litellm?.removed  ?? 0;
      const parts = [
        `${lt} models refreshed`,
        added   > 0 && `${added} new`,
        removed > 0 && `${removed} removed`,
        lb > 0      && `${lb} benchmark scores`,
        ls > 0      && `${ls} LMSYS scores`,
      ].filter(Boolean);
      setSyncMsg(parts.join(" · "));
      await load();
      setTimeout(() => setSyncMsg(null), 7000);
    } catch (e) {
      setSyncMsg(`Sync failed: ${e.message}`);
      setTimeout(() => setSyncMsg(null), 5000);
    } finally { setSyncing(false); }
  };

  useEffect(() => { load(); loadBenchStatus(); }, [load, loadBenchStatus]);

  const allProviders = buildProviderList(models, builtins, customs);

  // Auto-select first connected provider once loaded
  const didAutoSelect = useRef(false);
  useEffect(() => {
    if (didAutoSelect.current || loading) return;
    const first = allProviders.find((p) => p.connected) || allProviders[0];
    if (first) { didAutoSelect.current = true; setSelected(first); }
  }, [loading]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <div className="py-12"><Spinner /></div>;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-arbr-charcoal">Models</h1>
          <p className="mt-1 text-sm text-gray-500">
            Manage provider connections and the model registry.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 flex-shrink-0">
          <button className={BTN_GHOST} disabled={syncing} onClick={syncBenchmarks}>
            {syncing ? "Syncing…" : "Sync Models"}
          </button>
          {syncMsg
            ? <span className="text-xs text-gray-500 text-right">{syncMsg}</span>
            : <span className="text-xs text-gray-400 text-right">
                {benchStatus?.lastSyncedAt
                  ? `Last synced ${new Date(benchStatus.lastSyncedAt).toLocaleString()}`
                  : "Not yet synced"}
              </span>
          }
        </div>
      </div>

      <div className="flex min-h-[600px] rounded-xl border border-gray-200 bg-white overflow-hidden">
        <ProviderSidebar
          allProviders={allProviders}
          selected={selected}
          onSelect={setSelected}
          onRefresh={load}
        />

        <main className="flex-1 min-w-0 overflow-y-auto p-6">
          {!selected && (
            <div className="flex items-center justify-center h-full text-sm text-gray-400">
              Select a provider to view its models.
            </div>
          )}

          {selected?.type === "builtin" && (
            <BuiltinProviderDetail
              key={selected.provider}
              provider={selected}
              models={models}
              onRefresh={load}
            />
          )}

          {selected?.type === "custom" && (
            <CustomProviderDetail
              key={selected.provider}
              provider={selected}
              models={models}
              onRefresh={load}
              onDeleted={() => { setSelected(null); load(); }}
            />
          )}

          {selected?.type === "catalog" && (
            <CatalogProviderDetail
              key={selected.provider}
              provider={selected}
              models={models}
              onRefresh={load}
            />
          )}
        </main>
      </div>
    </div>
  );
}
