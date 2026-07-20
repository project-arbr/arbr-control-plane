import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Card, Badge, Spinner } from "../components/ui.jsx";

const EVAL_TONE  = { not_started: "gray", dataset_ready: "gray", running: "amber", passed: "green", failed: "red", overridden: "amber" };
const EVAL_LABEL = { not_started: "No eval", dataset_ready: "Dataset ready", running: "Evaluating…", passed: "Eval passed", failed: "Eval failed", overridden: "Overridden" };

const pct = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

// Derive 3-step workflow state from evalStatus.
function stepsFromEvalStatus(evalStatus) {
  const s = evalStatus || "not_started";
  return [
    {
      id: "dataset", label: "Build dataset",
      status: ["dataset_ready", "running", "passed", "failed", "overridden"].includes(s) ? "done" : "active",
    },
    {
      id: "eval", label: "Run eval",
      status: s === "running" ? "running" : s === "failed" ? "failed" : ["passed", "overridden"].includes(s) ? "done" : s === "dataset_ready" ? "active" : "idle",
    },
    {
      id: "canary", label: "Start canary",
      status: s === "passed" ? "active" : "idle",
    },
  ];
}

const DOT_CLASS = {
  done:    "w-6 h-6 rounded-full bg-arbr-accent-600 text-white flex items-center justify-center text-xs font-medium",
  active:  "w-6 h-6 rounded-full border-2 border-arbr-accent-600 text-arbr-accent-600 flex items-center justify-center text-xs font-medium",
  running: "w-6 h-6 rounded-full border-2 border-amber-400 text-amber-500 flex items-center justify-center text-xs font-medium animate-pulse",
  failed:  "w-6 h-6 rounded-full border-2 border-red-400 text-red-500 flex items-center justify-center text-xs font-medium",
  idle:    "w-6 h-6 rounded-full border-2 border-gray-200 text-gray-300 flex items-center justify-center text-xs font-medium",
};
const DOT_TEXT = {
  done: "text-arbr-accent-700 font-medium", active: "text-arbr-accent-600 font-medium",
  running: "text-amber-600", failed: "text-red-600", idle: "text-gray-300",
};

function StepTracker({ steps }) {
  return (
    <div className="flex items-center">
      {steps.map((step, i) => (
        <React.Fragment key={step.id}>
          <div className="flex items-center gap-2 shrink-0">
            <div className={DOT_CLASS[step.status]}>
              {step.status === "done" ? "✓" : i + 1}
            </div>
            <span className={`text-xs ${DOT_TEXT[step.status]}`}>{step.label}</span>
          </div>
          {i < steps.length - 1 && (
            <div className={`flex-1 h-px mx-3 min-w-8 ${step.status === "done" ? "bg-arbr-accent-200" : "bg-gray-100"}`} />
          )}
        </React.Fragment>
      ))}
    </div>
  );
}

function QualitySummary({ s }) {
  if (!s) return null;
  return (
    <div className="flex flex-wrap gap-2">
      <Badge tone="gray">{fmt.num(s.judged)} judged</Badge>
      <Badge tone={s.worseRate > 0.05 ? "red" : "green"}>worse {pct(s.worseRate)}</Badge>
      {s.criticalFailRate != null && <Badge tone={s.criticalFailRate > 0 ? "red" : "gray"}>critical {pct(s.criticalFailRate)}</Badge>}
      <Badge tone="gray">format {pct(s.formatPassRate)}</Badge>
      <Badge tone="charcoal">cost -{pct(s.costSavingPct)}</Badge>
      {s.avgLatencyDeltaPct != null && <Badge tone="gray">latency {s.avgLatencyDeltaPct > 0 ? "+" : ""}{pct(s.avgLatencyDeltaPct)}</Badge>}
    </div>
  );
}

function RecCard({ rec, models, onChange }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [notice, setNotice] = useState(null);
  const [judge, setJudge] = useState("");
  const [application, setApplication] = useState(rec.application || "");
  const evalStatus = rec.evalStatus || "not_started";

  const run = async (fn, ok) => {
    setBusy(true); setErr(null); setNotice(null);
    try { const r = await fn(); if (ok) setNotice(ok(r)); await onChange(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const accept = async () => {
    setBusy(true); setErr(null);
    try { await api.acceptRecommendation(rec._id); await onChange(); }
    catch (e) {
      if (e.status === 409) {
        const reason = window.prompt("This recommendation has not passed an eval. Enter an override reason to accept anyway (or Cancel):");
        if (!reason) { setBusy(false); return; }
        // Approver is derived server-side from the signed-in user — no longer prompted here.
        try { await api.acceptRecommendation(rec._id, { reason }); await onChange(); }
        catch (e2) { setErr(e2.message); }
      } else setErr(e.message);
    } finally { setBusy(false); }
  };

  // Collapsed card for accepted/dismissed recommendations.
  if (rec.status !== "pending") {
    const tone = rec.status === "accepted" ? "green" : "gray";
    const via = rec.acceptedVia || (rec.evalStatus === "passed" ? "passed" : rec.evalStatus === "overridden" ? "overridden" : null);
    const gated = via === "passed";
    return (
      <Card>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0 overflow-hidden">
            <Badge tone={tone}>{rec.status === "accepted" ? "Accepted" : "Dismissed"}</Badge>
            {rec.status === "accepted" && (
              <Badge tone={gated ? "green" : "amber"}>{gated ? "Quality-gated" : "Ungated"}</Badge>
            )}
            <span className="text-sm text-arbr-charcoal font-mono truncate">
              {rec.currentModel} → {rec.suggestedModel}
            </span>
            {rec.taskType && <span className="text-xs text-gray-400 truncate hidden sm:block">· {rec.taskType}</span>}
            {rec.application && <span className="text-xs text-gray-400 truncate hidden sm:block">· {rec.application}</span>}
          </div>
          <div className="shrink-0 text-right">
            <span className={`text-sm font-semibold ${gated ? "text-green-600" : "text-amber-600"}`}>
              {fmt.usd(rec.projectedSavings)}
            </span>
            <div className="text-[10px] uppercase tracking-wide text-gray-400">
              {gated ? "quality-held" : "projected only"}
            </div>
          </div>
        </div>
      </Card>
    );
  }

  const steps = stepsFromEvalStatus(evalStatus);
  const noReplayable = rec.replayableCount === 0;

  return (
    <Card>
      {/* Section 1: Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="label mb-1">Recommendation</div>
          <h3 className="text-base font-semibold text-arbr-charcoal">
            {rec.taskType || rec.title}
          </h3>
          <p className="mt-0.5 text-xs text-gray-400">
            {fmt.num(rec.requestCount)} requests
            {rec.application ? ` · ${rec.application}` : ""}
            {rec.replayableCount != null && (
              <span className={rec.replayableCount === 0 ? " text-red-500" : ""}>
                {" "}· {fmt.num(rec.replayableCount)} replayable
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Badge tone="amber">Pending</Badge>
          <Badge tone={EVAL_TONE[evalStatus]}>{EVAL_LABEL[evalStatus]}</Badge>
        </div>
      </div>

      {/* Section 2: Model substitution + Savings */}
      <div className="mt-4 pt-4 border-t border-gray-100 flex gap-6">
        <div className="flex-1 min-w-0">
          <div className="label mb-2">Model substitution</div>
          <div className="flex flex-col items-start gap-1.5">
            <span className="inline-block bg-gray-100 text-arbr-charcoal rounded px-2 py-1 text-xs font-mono">
              {rec.currentModel}
            </span>
            <span className="text-xs text-arbr-accent-600 pl-2 leading-none select-none">↓</span>
            <span className="inline-block bg-arbr-accent-50 text-arbr-accent-700 border border-arbr-accent-200 rounded px-2 py-1 text-xs font-mono">
              {rec.suggestedModel}
            </span>
          </div>
        </div>
        <div className="border-l border-gray-100 pl-6 shrink-0 text-right">
          <div className="label mb-1">Projected saving</div>
          <div className={`text-3xl font-bold ${evalStatus === "passed" ? "text-green-600" : "text-amber-600"}`}>
            {fmt.usd(rec.projectedSavings)}
          </div>
          <div className="mt-0.5 text-xs text-gray-500">{fmt.usd(rec.currentCost)} → {fmt.usd(rec.projectedCost)}</div>
          <div className="mt-0.5 text-xs text-gray-400">{fmt.num(rec.requestCount)} requests</div>
          <div className="mt-1 text-[10px] uppercase tracking-wide text-gray-400">
            {evalStatus === "passed" ? "eval-backed" : "ungated until eval passes"}
          </div>
        </div>
      </div>

      {/* Section 3: Evaluation workflow */}
      <div className="mt-4 pt-4 border-t border-gray-100">
        <div className="label mb-3">Evaluation workflow</div>
        <StepTracker steps={steps} />
        <div className="mt-4">
          {evalStatus === "not_started" && (
            noReplayable ? (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
                No replayable traffic yet — captured prompts are required to build a dataset.
                Turn on payload capture in <strong>Settings → Observability</strong>; only traffic logged after it is enabled can be evaluated.
              </p>
            ) : (
              <button className="btn-secondary text-sm" disabled={busy}
                onClick={() => run(() => api.createEvalDataset(rec._id), (d) => `Dataset built: ${d.itemCount} items (${d.riskTier} risk).`)}>
                Build eval dataset
              </button>
            )
          )}
          {(evalStatus === "dataset_ready" || evalStatus === "failed") && (
            <div className="flex flex-wrap items-center gap-2">
              <select className="input text-sm" value={judge} onChange={(e) => setJudge(e.target.value)}>
                <option value="">Judge: none</option>
                {models.map((m) => <option key={m.id} value={m.id}>Judge: {m.label || m.id}</option>)}
              </select>
              <button className="btn-secondary text-sm" disabled={busy}
                onClick={() => run(() => api.runEval(rec._id, { judgeModel: judge || null }), () => "Offline eval started — refresh in a moment.")}>
                Run offline eval
              </button>
            </div>
          )}
          {evalStatus === "running" && (
            <span className="text-sm text-amber-600">Evaluating… refresh to see the result.</span>
          )}
          {evalStatus === "passed" && (
            <div className="flex flex-wrap items-center gap-2">
              <input className="input text-sm" placeholder="application for rollout" value={application}
                onChange={(e) => setApplication(e.target.value)} />
              <button className="btn-secondary text-sm" disabled={busy || !application.trim()}
                onClick={() => run(() => api.createCanary(rec._id, { application: application.trim() }), (x) => `Canary started at ${x.rolloutPct}%.`)}>
                Start canary
              </button>
            </div>
          )}
          {notice && <p className="mt-2 text-sm text-arbr-accent-700">{notice}</p>}
          {err    && <p className="mt-2 text-sm text-red-600">{err}</p>}
        </div>
        {rec.qualitySummary && (
          <div className="mt-3 pt-3 border-t border-gray-100">
            <QualitySummary s={rec.qualitySummary} />
          </div>
        )}
      </div>

      {/* Section 4: Decisions */}
      <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button className="btn-outline text-sm" disabled={busy} onClick={accept}>Accept as rule</button>
          <button className="btn-outline text-sm" disabled={busy}
            onClick={() => run(() => api.dismissRecommendation(rec._id))}>Dismiss</button>
        </div>
        <p className="text-xs text-gray-400">
          Accepting creates a routing rule (off until you switch it on).
          Gated on a passed eval; without one you'll be asked for an override reason.
        </p>
      </div>
    </Card>
  );
}

// Self-diagnosing empty state: surface high-spend task types not yet marked cheap — with a
// one-click "mark cheap & recompute". Falls back gracefully if the analysis endpoint is absent.
function EmptyState({ analysis, busy, onMarkCheap }) {
  if (!analysis) {
    return (
      <Card>
        <div className="py-8 text-center text-gray-400">
          No recommendations yet. Click <span className="font-medium text-arbr-charcoal">Recompute</span> to analyse the logged data.
        </div>
      </Card>
    );
  }
  const opps = analysis.unmarkedOpportunities || [];
  const analyzed = `Analysed ${fmt.num(analysis.analyzedRequests)} requests (${fmt.usd(analysis.analyzedCost)}).`;

  if (opps.length === 0) {
    return (
      <Card>
        <div className="py-8 text-center text-gray-500">
          <div className="text-arbr-charcoal font-medium">Nothing to optimise right now.</div>
          <p className="mt-1 text-sm text-gray-400">{analyzed} No premium model is overused on a cheap task.</p>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <div className="space-y-4">
        <div>
          <h3 className="text-base font-semibold text-arbr-charcoal">
            {fmt.usd(analysis.unmarkedPotentialSavings)} of potential savings is hidden
          </h3>
          <p className="mt-1 text-sm text-gray-600">
            {analyzed} These high-spend task types run on a premium model but aren't marked <b>cheap</b>, so they're
            excluded from recommendations. Mark them cheap to evaluate a cheaper model (nothing reroutes until an eval passes and you approve).
          </p>
        </div>
        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {opps.slice(0, 8).map((o, i) => (
            <div key={i} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-arbr-charcoal">{o.taskType || "—"}</span>
                  <Badge tone="charcoal">{o.model} → {o.suggestedModel}</Badge>
                  <span className="text-xs text-gray-400">{fmt.num(o.requests)} req · {fmt.usd(o.currentCost)} spent</span>
                </div>
              </div>
              <div className="flex items-center gap-3 shrink-0">
                <span className="text-sm font-semibold text-arbr-accent-600">~{fmt.usd(o.projectedSavings)}</span>
                <button className="btn-outline text-xs" disabled={busy} onClick={() => onMarkCheap([o.taskType])}>
                  Mark cheap
                </button>
              </div>
            </div>
          ))}
        </div>
        <button className="btn-primary text-sm" disabled={busy}
          onClick={() => onMarkCheap(analysis.suggestMarkCheap || opps.map((o) => o.taskType))}>
          {busy ? "Working…" : `Mark all ${(analysis.suggestMarkCheap || []).length} cheap & recompute`}
        </button>
      </div>
    </Card>
  );
}

export default function Recommendations({ embedded = false }) {
  const [recs, setRecs] = useState(null);
  const [models, setModels] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = async () => {
    try {
      const [r, a] = await Promise.all([api.recommendations(), api.recommendationsAnalysis().catch(() => null)]);
      setRecs(r); setAnalysis(a);
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => {
    load();
    api.models({ live: true, routable: true }).then((m) => setModels(m || [])).catch(() => {});
  }, []);

  const recompute = async () => {
    setBusy(true); setErr(null);
    try { await api.recompute(); await load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const markCheapAndRecompute = async (taskTypes) => {
    setBusy(true); setErr(null);
    try {
      const merged = [...new Set([...(analysis?.cheapTaskTypes || []), ...taskTypes.map((t) => String(t).toLowerCase())])];
      await api.setPolicy({ cheapTaskTypes: merged });
      await api.recompute();
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          {!embedded && <h1 className="text-2xl font-bold text-arbr-charcoal">Recommendations</h1>}
          <p className="text-sm text-gray-500">
            Costed suggestions. Prove a cheaper model is no worse than the current one, then roll out under control — the system proposes, the human decides.
          </p>
        </div>
        <button className="btn-primary" onClick={recompute} disabled={busy}>
          {busy ? "Recomputing…" : "Recompute"}
        </button>
      </div>

      {err && <div className="text-red-600">{err}</div>}

      {recs === null ? (
        <Spinner />
      ) : recs.length === 0 ? (
        <EmptyState analysis={analysis} busy={busy} onMarkCheap={markCheapAndRecompute} />
      ) : (
        <div className="space-y-4">
          {recs.map((r) => <RecCard key={r._id} rec={r} models={models} onChange={load} />)}
        </div>
      )}
    </div>
  );
}
