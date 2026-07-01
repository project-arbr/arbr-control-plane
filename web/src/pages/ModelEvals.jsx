import React, { useEffect, useState, useCallback } from "react";
import { api, fmt } from "../api.js";
import { Card, Table, Badge, Stat, Drawer, CodeBlock, Spinner, ConfirmDialog } from "../components/ui.jsx";

const VERDICT_TONE = { better: "green", equal: "gray", worse: "red" };
const STATUS_TONE = { active: "green", paused: "amber", done: "gray" };

const pct = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const signedPct = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}%`);

// Create-campaign form. Models come from the registry; application is free-text (any app that sends traffic).
function NewCampaign({ models, apps, onCreated }) {
  const [form, setForm] = useState({ application: "", candidateModel: "", judgeModel: "", sampleRate: 0.1, minPairs: 50, maxLossRate: 0.1 });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async () => {
    setErr(null); setBusy(true);
    try {
      await api.createEvalCampaign({
        application: form.application.trim(),
        candidateModel: form.candidateModel,
        judgeModel: form.judgeModel || null,
        sampleRate: Number(form.sampleRate),
        thresholds: { minPairs: Number(form.minPairs), maxLossRate: Number(form.maxLossRate) },
      });
      setForm({ application: "", candidateModel: "", judgeModel: "", sampleRate: 0.1, minPairs: 50, maxLossRate: 0.1 });
      onCreated();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <Card title="New shadow-eval campaign">
      <p className="mb-4 text-sm text-gray-500">
        Mirror a sampled slice of an application's single-shot traffic to a candidate model without serving it,
        judge candidate-vs-current, and get notified when it's safe to switch.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div>
          <div className="label mb-1">Application</div>
          <input className="input w-full" list="eval-apps" placeholder="e.g. my-pipeline"
            value={form.application} onChange={(e) => set("application", e.target.value)} />
          <datalist id="eval-apps">{apps.map((a) => <option key={a} value={a} />)}</datalist>
        </div>
        <div>
          <div className="label mb-1">Candidate model</div>
          <select className="input w-full" value={form.candidateModel} onChange={(e) => set("candidateModel", e.target.value)}>
            <option value="">Select…</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </div>
        <div>
          <div className="label mb-1">Judge model <span className="text-gray-400">(optional)</span></div>
          <select className="input w-full" value={form.judgeModel} onChange={(e) => set("judgeModel", e.target.value)}>
            <option value="">Capture pairs only (no verdict)</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </div>
        <div>
          <div className="label mb-1">Sample rate</div>
          <input className="input w-full" type="number" step="0.05" min="0" max="1"
            value={form.sampleRate} onChange={(e) => set("sampleRate", e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">Min pairs to notify</div>
          <input className="input w-full" type="number" min="1"
            value={form.minPairs} onChange={(e) => set("minPairs", e.target.value)} />
        </div>
        <div>
          <div className="label mb-1">Max loss rate</div>
          <input className="input w-full" type="number" step="0.05" min="0" max="1"
            value={form.maxLossRate} onChange={(e) => set("maxLossRate", e.target.value)} />
        </div>
      </div>
      {err && <div className="mt-3 text-sm text-red-600">{err}</div>}
      <div className="mt-4">
        <button className="btn-secondary text-sm" disabled={busy || !form.application.trim() || !form.candidateModel} onClick={submit}>
          {busy ? "Creating…" : "Start campaign"}
        </button>
      </div>
    </Card>
  );
}

// Verdict summary + recent pairs for one campaign.
function CampaignDetail({ id, onClose }) {
  const [detail, setDetail] = useState(null);
  const [pairs, setPairs] = useState(null);
  const [pair, setPair] = useState(null);

  useEffect(() => {
    api.evalCampaign(id).then(setDetail).catch((e) => setDetail({ _error: e.message }));
    api.evalCampaignPairs(id).then((d) => setPairs(d.items)).catch(() => setPairs([]));
  }, [id]);

  if (!detail) return <Drawer title="Campaign" onClose={onClose}><Spinner /></Drawer>;
  if (detail._error) return <Drawer title="Campaign" onClose={onClose}><div className="text-sm text-red-600">{detail._error}</div></Drawer>;

  const s = detail.summary || {};
  const pairCols = [
    { key: "timestamp", header: "Time", render: (r) => <span className="whitespace-nowrap text-gray-500">{fmt.date(r.timestamp)}</span> },
    { key: "verdict", header: "Verdict", render: (r) => r.verdict ? <Badge tone={VERDICT_TONE[r.verdict]}>{r.verdict}</Badge> : <span className="text-gray-400">—</span> },
    { key: "cost", header: "Cost (prod → cand)", render: (r) => <span>{fmt.usd(r.prodCost)} → {fmt.usd(r.candidateCost)}</span> },
    { key: "lat", header: "Latency", render: (r) => <span>{fmt.ms(r.prodLatencyMs)} → {fmt.ms(r.candidateLatencyMs)}</span> },
  ];

  return (
    <Drawer title={`Campaign · ${detail.candidateModel}`} onClose={onClose}>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Pairs" value={fmt.num(s.pairs)} sub={`${fmt.num(s.judged)} judged`} />
          <Stat label="Win / tie / loss" value={`${s.better || 0}/${s.equal || 0}/${s.worse || 0}`} sub={`loss ${pct(s.lossRate)}`} />
          <Stat label="Cost delta" value={signedPct(s.costDeltaPct)} sub="candidate vs prod" />
          <Stat label="Latency" value={fmt.ms(s.avgCandidateLatencyMs)} sub={`prod ${fmt.ms(s.avgProdLatencyMs)}`} />
        </div>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          App <b>{detail.application}</b> · candidate <b>{detail.candidateModel}</b> · judge {detail.judgeModel || "none"} ·
          sample {pct(detail.sampleRate)} · notify at {detail.thresholds?.minPairs} pairs, loss ≤ {pct(detail.thresholds?.maxLossRate)}
          {detail.notifiedAt && <span className="ml-1 text-arbr-green-700">· healthy-notification sent</span>}
        </div>
        <div>
          <div className="label mb-1">Recent pairs</div>
          {pairs === null ? <Spinner /> : <Table columns={pairCols} rows={pairs} empty="No pairs yet." onRowClick={setPair} />}
        </div>
      </div>
      {pair && (
        <Drawer title="Eval pair" onClose={() => setPair(null)}>
          <div className="space-y-4">
            <div className="flex items-center gap-2">
              {pair.verdict ? <Badge tone={VERDICT_TONE[pair.verdict]}>{pair.verdict}</Badge> : <Badge tone="gray">unjudged</Badge>}
              <span className="text-sm text-gray-500">{pair.taskType || "—"}</span>
            </div>
            {pair.rationale && <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">{pair.rationale}</div>}
            <div>
              <div className="label mb-1">Prompt</div>
              {pair.messages ? <CodeBlock lang="json" code={JSON.stringify(pair.messages, null, 2)} /> : <div className="text-xs text-gray-400">(not captured)</div>}
            </div>
            <div>
              <div className="label mb-1">Prod response · {pair.prodModel} · {fmt.usd(pair.prodCost)}</div>
              {pair.prodResponse ? <CodeBlock code={pair.prodResponse} /> : <div className="text-xs text-gray-400">(not captured)</div>}
            </div>
            <div>
              <div className="label mb-1">Candidate response · {pair.candidateModel} · {fmt.usd(pair.candidateCost)}</div>
              {pair.candidateResponse ? <CodeBlock code={pair.candidateResponse} /> : <div className="text-xs text-gray-400">(not captured)</div>}
            </div>
          </div>
        </Drawer>
      )}
    </Drawer>
  );
}

export default function ModelEvals() {
  const [campaigns, setCampaigns] = useState(null);
  const [models, setModels] = useState([]);
  const [apps, setApps] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(() => {
    api.evalCampaigns().then(setCampaigns).catch((e) => setErr(e.message));
  }, []);

  useEffect(() => {
    load();
    api.models().then((m) => setModels(m || [])).catch(() => {});
    api.facets().then((f) => setApps(f?.applications || [])).catch(() => {});
  }, [load]);

  const setStatus = async (c, status) => { await api.updateEvalCampaign(c._id, { status }); load(); };
  const remove = async (c) => { setConfirmDel(null); await api.deleteEvalCampaign(c._id); load(); };

  const columns = [
    { key: "application", header: "Application", render: (c) => <span className="font-medium">{c.application}</span> },
    { key: "candidateModel", header: "Candidate" },
    { key: "judgeModel", header: "Judge", render: (c) => c.judgeModel || <span className="text-gray-400">none</span> },
    { key: "status", header: "Status", render: (c) => <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge> },
    { key: "pairCount", header: "Pairs", render: (c) => fmt.num(c.pairCount) },
    { key: "sampleRate", header: "Sample", render: (c) => pct(c.sampleRate) },
    { key: "actions", header: "", render: (c) => (
      <span className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        <button className="btn-outline text-xs" onClick={() => setOpenId(c._id)}>View</button>
        {c.status === "active"
          ? <button className="btn-outline text-xs" onClick={() => setStatus(c, "paused")}>Pause</button>
          : c.status === "paused" && <button className="btn-outline text-xs" onClick={() => setStatus(c, "active")}>Resume</button>}
        <button className="btn-outline text-xs text-red-600" onClick={() => setConfirmDel(c)}>Delete</button>
      </span>
    ) },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-arbr-charcoal">Model Evals</h1>
        <p className="mt-1 text-sm text-gray-500">Safely evaluate a candidate model on your own live traffic before switching.</p>
      </div>

      <NewCampaign models={models} apps={apps} onCreated={load} />

      <Card title="Campaigns">
        {err && <div className="mb-3 text-sm text-red-600">{err}</div>}
        {campaigns === null ? <Spinner /> : <Table columns={columns} rows={campaigns} empty="No campaigns yet." onRowClick={(c) => setOpenId(c._id)} />}
      </Card>

      {openId && <CampaignDetail id={openId} onClose={() => setOpenId(null)} />}
      {confirmDel && (
        <ConfirmDialog
          title="Delete campaign?"
          message={`This removes the campaign and its ${fmt.num(confirmDel.pairCount)} eval pairs.`}
          confirmLabel="Delete"
          onConfirm={() => remove(confirmDel)}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </div>
  );
}
