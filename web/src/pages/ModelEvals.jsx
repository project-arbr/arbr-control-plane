import React, { useEffect, useState, useCallback } from "react";
import { api, fmt } from "../api.js";
import { Card, Table, Badge, Stat, Drawer, CodeBlock, Spinner, ConfirmDialog } from "../components/ui.jsx";

const VERDICT_TONE = { better: "green", equal: "gray", worse: "red" };
const STATUS_TONE = { active: "green", paused: "amber", done: "gray" };

const pct = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);
const signedPct = (n) => (n == null ? "—" : `${n > 0 ? "+" : ""}${(n * 100).toFixed(1)}%`);

// Small per-section/-row refresh control — evals run async, so re-fetch without a full page reload.
function RefreshButton({ onClick, label = "Refresh" }) {
  return (
    <button className="btn-outline flex items-center gap-1.5 text-xs" onClick={onClick} title="Refresh">
      <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 2v6h-6M3 12a9 9 0 0 1 15-6.7L21 8M3 22v-6h6M21 12a9 9 0 0 1-15 6.7L3 16"/>
      </svg>
      {label}
    </button>
  );
}

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

const EXP_TONE = { draft: "gray", active: "green", paused: "amber", rolled_back: "red", promoted: "charcoal" };

// Translate a run's raw status into a user-facing OUTCOME. Crucially, a completed run whose
// candidate simply didn't clear the quality bar is "Not recommended" (a valid verdict), NOT the
// scary red "Failed" — that's reserved for a run that couldn't actually complete (judge/candidate
// error), or was inconclusive (no verdicts to judge on).
function runOutcome(r) {
  if (r.status === "passed") return { kind: "pass", label: "Safe to switch", tone: "green" };
  if (r.status === "queued") return { kind: "pending", label: "Queued", tone: "gray" };
  if (r.status === "running") return { kind: "pending", label: "Running", tone: "amber" };
  if (r.status === "cancelled") return { kind: "cancelled", label: "Cancelled", tone: "gray" };
  // status === "failed":
  if (r.error) return { kind: "error", label: "Couldn't complete", tone: "red" };
  if ((r.summary?.judged || 0) === 0) return { kind: "inconclusive", label: "Inconclusive", tone: "gray" };
  return { kind: "reject", label: "Not recommended", tone: "amber" };
}

// Offline eval-run detail: pass/fail, aggregate summary, and the worst candidate examples.
function RunDetail({ id, onClose }) {
  const [run, setRun] = useState(null);
  const [results, setResults] = useState(null);

  const load = useCallback(() => {
    api.evalRun(id).then(setRun).catch((e) => setRun({ _error: e.message }));
    api.evalRunResults(id).then(setResults).catch(() => setResults([]));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const exportCsv = () => {
    const rows = results || [];
    const head = ["verdict", "criticalFailure", "formatPass", "candidateCost", "candidateLatencyMs", "judgeRationale"];
    const body = rows.map((r) => head.map((k) => JSON.stringify(r[k] ?? "")).join(","));
    const blob = new Blob([[head.join(","), ...body].join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = `eval-run-${id}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
  };

  if (!run) return <Drawer title="Eval run" onClose={onClose}><Spinner /></Drawer>;
  if (run._error) return <Drawer title="Eval run" onClose={onClose}><div className="text-sm text-red-600">{run._error}</div></Drawer>;
  const s = run.summary || {};

  return (
    <Drawer title={`Eval run · ${run.candidateModel}`} onClose={onClose}>
      <div className="space-y-5">
        <div className="flex justify-end"><RefreshButton onClick={load} /></div>
        {(() => {
          const o = runOutcome(run);
          const bg = o.tone === "green" ? "bg-green-50 text-arbr-green-700"
            : o.tone === "red" ? "bg-red-50 text-red-700"
            : o.tone === "amber" ? "bg-amber-50 text-amber-800"
            : "bg-gray-50 text-gray-600";
          const blurb = {
            pass: "The candidate met every quality bar — safe to switch for this traffic.",
            reject: "The eval ran and reached a verdict: the candidate didn't clear the bar to switch, so it isn't recommended for this traffic. (This is a result, not an error.)",
            inconclusive: "The eval ran but produced no quality verdicts (e.g. no judge was selected), so there's nothing to conclude.",
            error: "The eval couldn't complete — see the reason below.",
            cancelled: "This run was cancelled before finishing.",
            pending: "This run hasn't finished yet.",
          }[o.kind];
          return (
            <div className={`rounded-lg p-3 text-sm ${bg}`}>
              <div className="font-medium">
                {o.kind === "pass" ? "✓ " : o.kind === "error" ? "✗ " : ""}{o.label}
                {run.exploratory && o.kind !== "error" ? " · exploratory" : ""}
              </div>
              {blurb && <div className="mt-1 text-xs font-normal">{blurb}</div>}
              {run.exploratory && (o.kind === "reject" || o.kind === "pass") && (
                <div className="mt-1 text-xs font-normal">
                  Directional signal on {fmt.num(run.summary?.judged ?? 0)} judged item(s), not a promotion-grade result.
                </div>
              )}
              {o.kind === "error" && run.error && <div className="mt-1 text-xs font-normal">{run.error}</div>}
              {o.kind !== "error" && run.failures?.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-xs font-normal">{run.failures.map((f, i) => <li key={i}>{f}</li>)}</ul>
              )}
            </div>
          );
        })()}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Judged" value={fmt.num(s.judged)} sub={`${fmt.num(s.total)} total`} />
          <Stat label="Worse-rate" value={pct(s.worseRate)} sub={`critical ${pct(s.criticalFailRate)}`} />
          <Stat label="Format pass" value={pct(s.formatPassRate)} />
          <Stat label="Cost saving" value={pct(s.costSavingPct)} sub={`latency ${signedPct(s.avgLatencyDeltaPct)}`} />
        </div>
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs text-gray-600">
          {run.baselineModel} → {run.candidateModel} · judge {run.judgeModel || "none"} · {run.riskTier} risk · est. cost {fmt.usd(run.estimatedCostUsd)} · actual {fmt.usd(run.actualCostUsd)}
          {run.fidelity === "masked" && <span className="ml-1 text-amber-600">· masked dataset (lower-fidelity: candidate saw redacted prompts vs the original baseline)</span>}
        </div>
        <div className="flex items-center justify-between">
          <div className="label">Worst candidate examples</div>
          <button className="btn-outline text-xs" onClick={exportCsv}>Export CSV</button>
        </div>
        {results === null ? <Spinner /> : results.length === 0 ? <div className="text-xs text-gray-400">No results.</div> : (
          <div className="space-y-3">
            {results.slice(0, 20).map((r) => (
              <div key={r._id} className="rounded-lg border border-gray-200 p-3">
                <div className="flex items-center gap-2">
                  {r.judgeVerdict ? <Badge tone={VERDICT_TONE[r.judgeVerdict]}>{r.judgeVerdict}</Badge> : <Badge tone="gray">unjudged</Badge>}
                  {r.criticalFailure && <Badge tone="red">critical</Badge>}
                  {!r.formatPass && <Badge tone="amber">format fail</Badge>}
                  {r.error && <span className="text-xs text-red-600">{r.error}</span>}
                </div>
                {r.judgeRationale && <p className="mt-2 text-sm text-gray-600">{r.judgeRationale}</p>}
                {r.candidateResponse && <CodeBlock code={r.candidateResponse} />}
              </div>
            ))}
          </div>
        )}
      </div>
    </Drawer>
  );
}

// Create an eval directly — replay an application's traffic through any candidate model, judged
// against the baseline. Doesn't require a recommendation, so users can test models on a hunch.
function NewEval({ models, apps, onCreated }) {
  const [form, setForm] = useState({ application: "", baselineModel: "", candidateModel: "", judgeModel: "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [baselineOptions, setBaselineOptions] = useState(null); // models with replayable traffic for the app
  const [loadingBase, setLoadingBase] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  // When the application changes, load the models that actually served its replayable traffic —
  // those (and only those) are valid baselines. Reset any stale baseline pick.
  useEffect(() => {
    const app = form.application.trim();
    setForm((f) => (f.baselineModel ? { ...f, baselineModel: "" } : f));
    if (!app) { setBaselineOptions(null); return; }
    let cancelled = false;
    setLoadingBase(true);
    const t = setTimeout(() => {
      api.evalTrafficModels({ application: app })
        .then((rows) => { if (!cancelled) setBaselineOptions(rows || []); })
        .catch(() => { if (!cancelled) setBaselineOptions([]); })
        .finally(() => { if (!cancelled) setLoadingBase(false); });
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [form.application]);

  const submit = async () => {
    setErr(null); setNotice(null); setBusy(true);
    try {
      const { run } = await api.createEval({
        application: form.application.trim(),
        baselineModel: form.baselineModel,
        candidateModel: form.candidateModel,
        judgeModel: form.judgeModel || null,
      });
      setNotice(`Eval started (${run.status}) — it appears below; refresh in a moment for the verdict.`);
      setForm({ application: "", baselineModel: "", candidateModel: "", judgeModel: "" });
      onCreated();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const valid = form.application.trim() && form.baselineModel && form.candidateModel && form.baselineModel !== form.candidateModel;
  return (
    <div className="mb-4 rounded-lg border border-gray-200 bg-gray-50/70 p-4">
      <div className="text-sm font-semibold text-arbr-charcoal">New eval</div>
      <p className="mb-3 mt-0.5 text-xs text-gray-500">
        Replay an application's recent single-shot traffic through a candidate model and judge it against the
        baseline. Works for any candidate — it doesn't have to be recommended.
      </p>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div>
          <div className="label mb-1">Application</div>
          <input className="input w-full" list="eval-run-apps" placeholder="e.g. gyde-chat-client"
            value={form.application} onChange={(e) => set("application", e.target.value)} />
          <datalist id="eval-run-apps">{apps.map((a) => <option key={a} value={a} />)}</datalist>
        </div>
        <div>
          <div className="label mb-1">Baseline (current)</div>
          <select className="input w-full" value={form.baselineModel}
            disabled={!form.application.trim() || loadingBase || (baselineOptions != null && baselineOptions.length === 0)}
            onChange={(e) => set("baselineModel", e.target.value)}>
            <option value="">{!form.application.trim() ? "Pick an application first" : loadingBase ? "Loading…" : "Select…"}</option>
            {(baselineOptions || []).map((o) => (
              <option key={o.model} value={o.model}>{o.model} ({fmt.num(o.count)} replayable)</option>
            ))}
          </select>
        </div>
        <div>
          <div className="label mb-1">Candidate (to test)</div>
          <select className="input w-full" value={form.candidateModel} onChange={(e) => set("candidateModel", e.target.value)}>
            <option value="">Select…</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </div>
        <div>
          <div className="label mb-1">Judge <span className="text-gray-400">(optional)</span></div>
          <select className="input w-full" value={form.judgeModel} onChange={(e) => set("judgeModel", e.target.value)}>
            <option value="">No judge (format checks only)</option>
            {models.map((m) => <option key={m.id} value={m.id}>{m.label || m.id}</option>)}
          </select>
        </div>
      </div>
      {form.application.trim() && !loadingBase && baselineOptions != null && baselineOptions.length === 0 && (
        <div className="mt-2 text-xs text-amber-600">
          No replayable traffic for <b>{form.application.trim()}</b> in the last 60 days — nothing to evaluate yet (needs requests logged with payload capture on).
        </div>
      )}
      {err && <div className="mt-3 text-sm text-red-600">{err}</div>}
      {notice && <div className="mt-3 text-sm text-arbr-green-700">{notice}</div>}
      <div className="mt-3">
        <button className="btn-secondary text-sm" disabled={busy || !valid} onClick={submit}>
          {busy ? "Starting…" : "Run eval"}
        </button>
      </div>
    </div>
  );
}

// All evals — created here directly or from a recommendation.
function EvalRunsSection({ models, apps }) {
  const [runs, setRuns] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => { api.evalRuns().then(setRuns).catch(() => setRuns([])); }, []);
  useEffect(() => { load(); }, [load]);
  const del = async (r) => { setConfirmDel(null); await api.deleteEvalRun(r._id).catch(() => {}); load(); };
  // Re-run: start a fresh eval with the same application, baseline, candidate and judge.
  const rerun = async (r) => {
    setErr(null);
    try {
      await api.createEval({ application: r.application, baselineModel: r.baselineModel, candidateModel: r.candidateModel, judgeModel: r.judgeModel || null });
      load();
    } catch (e) { setErr(e.message); }
  };
  const cols = [
    { key: "candidateModel", header: "Baseline → candidate", render: (r) => <span>{r.baselineModel} → <b>{r.candidateModel}</b></span> },
    { key: "application", header: "Application", render: (r) => r.application || <span className="text-gray-400">any</span> },
    { key: "status", header: "Outcome", render: (r) => {
      const o = runOutcome(r);
      return (
        <span className="flex items-center gap-1.5">
          <Badge tone={o.tone}>{o.label}</Badge>
          {r.exploratory && <Badge tone="gray">exploratory</Badge>}
        </span>
      );
    } },
    { key: "worse", header: "Worse-rate", render: (r) => pct(r.summary?.worseRate) },
    { key: "saving", header: "Cost saving", render: (r) => pct(r.summary?.costSavingPct) },
    { key: "risk", header: "Risk", render: (r) => r.riskTier },
    { key: "actions", header: "", render: (r) => (
      <span className="flex gap-2" onClick={(e) => e.stopPropagation()}>
        <button className="btn-outline text-xs" onClick={() => setOpenId(r._id)}>Evidence</button>
        {r.application && <button className="btn-outline text-xs" onClick={() => rerun(r)}>Re-run</button>}
        <button className="btn-outline text-xs text-red-600" onClick={() => setConfirmDel(r)}>Delete</button>
      </span>
    ) },
  ];
  return (
    <Card title="Evals" action={<RefreshButton onClick={load} />}>
      <NewEval models={models} apps={apps} onCreated={load} />
      {err && <div className="mb-3 text-sm text-red-600">{err}</div>}
      {runs === null ? <Spinner /> : <Table columns={cols} rows={runs} empty="No evals yet — create one above, or run one from a recommendation." onRowClick={(r) => setOpenId(r._id)} />}
      {openId && <RunDetail id={openId} onClose={() => setOpenId(null)} />}
      {confirmDel && (
        <ConfirmDialog
          title="Delete eval?"
          message={`This removes the eval ${confirmDel.baselineModel} → ${confirmDel.candidateModel} and its results.`}
          confirmLabel="Delete"
          onConfirm={() => del(confirmDel)}
          onCancel={() => setConfirmDel(null)}
        />
      )}
    </Card>
  );
}

// Live canary experiments with rollback / promote controls.
function CanarySection() {
  const [exps, setExps] = useState(null);
  const [err, setErr] = useState(null);
  const load = useCallback(() => { api.routingExperiments().then(setExps).catch(() => setExps([])); }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (fn) => { setErr(null); try { await fn(); load(); } catch (e) { setErr(e.message); } };
  const rollback = (id) => act(() => api.rollbackExperiment(id, "manual rollback from dashboard"));
  const promote = (id) => act(() => api.promoteExperiment(id, "console"));

  const cols = [
    { key: "models", header: "Baseline → candidate", render: (e) => <span>{e.baselineModel} → <b>{e.candidateModel}</b></span> },
    { key: "scope", header: "Scope", render: (e) => <span className="text-xs text-gray-500">{[e.scope?.application, e.scope?.taskType].filter(Boolean).join(" · ") || "any"}</span> },
    { key: "rollout", header: "Rollout", render: (e) => `${e.rolloutPct}%` },
    { key: "status", header: "Status", render: (e) => <Badge tone={EXP_TONE[e.status]}>{e.status}</Badge> },
    { key: "metrics", header: "Live (err / save)", render: (e) => e.lastMetrics ? <span className="text-xs">{pct(e.lastMetrics.candErrorRate)} / {pct(e.lastMetrics.costSavingPct)}</span> : <span className="text-gray-400">—</span> },
    { key: "actions", header: "", render: (e) => (
      <span className="flex gap-2" onClick={(ev) => ev.stopPropagation()}>
        {(e.status === "active" || e.status === "paused") && <button className="btn-outline text-xs" onClick={() => promote(e._id)}>Promote</button>}
        {(e.status === "active" || e.status === "paused") && <button className="btn-outline text-xs text-red-600" onClick={() => rollback(e._id)}>Roll back</button>}
        {e.status === "rolled_back" && e.rollbackReason && <span className="text-xs text-red-600">{e.rollbackReason}</span>}
      </span>
    ) },
  ];
  return (
    <Card title="Canary experiments" action={<RefreshButton onClick={load} />}>
      <p className="mb-3 text-sm text-gray-500">Eval-approved candidates rolled out to a deterministic slice of auto-routed traffic. Auto-rolls-back on guardrail breach; promote to make it a rule.</p>
      {err && <div className="mb-2 text-sm text-red-600">{err}</div>}
      {exps === null ? <Spinner /> : <Table columns={cols} rows={exps} empty="No canary experiments — start one from a passed recommendation." />}
    </Card>
  );
}

// Pipeline stage header, so the page order reads as the actual flow:
// offline eval → shadow → canary → promote.
function StageHeading({ n, title, desc }) {
  return (
    <div className="border-b border-gray-100 pb-1 pt-2">
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-arbr-green-600">Stage {n}</span>
        <span className="text-base font-semibold text-arbr-charcoal">{title}</span>
      </div>
      <p className="mt-0.5 text-xs text-gray-500">{desc}</p>
    </div>
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
    // Candidate + judge get CALLED during a run, so only offer connected, chat-capable models.
    api.models({ live: true, routable: true }).then((m) => setModels(m || [])).catch(() => {});
    api.facets().then((f) => setApps(f?.applications || [])).catch(() => {});
  }, [load]);

  // Activating a shadow campaign is gated on a passed offline eval (or an override). If the gate
  // blocks it (409), explain why and offer to start it anyway with a recorded override reason.
  const setStatus = async (c, status) => {
    setErr(null);
    try {
      await api.updateEvalCampaign(c._id, { status });
      load();
    } catch (e) {
      if (e.status === 409 && status === "active") {
        const reason = window.prompt(`This shadow campaign can't start yet:\n\n${e.message}\n\nEnter an override reason to start it anyway (or Cancel):`);
        if (!reason) return;
        const approver = window.prompt("Approver name:") || "console";
        try { await api.updateEvalCampaign(c._id, { status, override: { reason, approver } }); load(); }
        catch (e2) { setErr(e2.message); }
      } else setErr(e.message);
    }
  };
  const remove = async (c) => { setConfirmDel(null); await api.deleteEvalCampaign(c._id); load(); };

  const columns = [
    { key: "application", header: "Application", render: (c) => <span className="font-medium">{c.application}</span> },
    { key: "candidateModel", header: "Candidate" },
    { key: "judgeModel", header: "Judge", render: (c) => c.judgeModel || <span className="text-gray-400">none</span> },
    { key: "status", header: "Status", render: (c) => (
      <span className="flex flex-col gap-0.5">
        <span><Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge></span>
        {c.status === "paused" && c.statusReason && (
          <span className="max-w-[240px] text-[10px] leading-tight text-gray-400">{c.statusReason}</span>
        )}
      </span>
    ) },
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
        <p className="mt-1 text-sm text-gray-500">Prove a cheaper model is no worse than the current one before it becomes a rule. The stages below follow that flow — offline eval → shadow → canary → promote.</p>
      </div>

      <StageHeading n="1" title="Offline eval" desc="Replay past traffic through a candidate and judge it against the baseline. No production impact." />
      <EvalRunsSection models={models} apps={apps} />

      <StageHeading n="2" title="Shadow" desc="Mirror a sample of live traffic to the candidate without serving it, judged against the current model — a real-traffic check with no user impact." />
      <NewCampaign models={models} apps={apps} onCreated={load} />
      <Card title="Campaigns" action={<RefreshButton onClick={load} />}>
        {err && <div className="mb-3 text-sm text-red-600">{err}</div>}
        {campaigns === null ? <Spinner /> : <Table columns={columns} rows={campaigns} empty="No campaigns yet." onRowClick={(c) => setOpenId(c._id)} />}
      </Card>

      <StageHeading n="3" title="Canary" desc="Send a small slice of real traffic to a proven candidate, auto-rolling back on breach; promote to make it a rule." />
      <CanarySection />

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
