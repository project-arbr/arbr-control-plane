import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Card, Badge, Spinner } from "../components/ui.jsx";

const EVAL_TONE = { not_started: "gray", dataset_ready: "gray", running: "amber", passed: "green", failed: "red", overridden: "amber" };
const EVAL_LABEL = { not_started: "No eval", dataset_ready: "Dataset ready", running: "Evaluating…", passed: "Eval passed", failed: "Eval failed", overridden: "Overridden" };
const pct = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

// Evidence summary line from a run/quality summary.
function QualitySummary({ s }) {
  if (!s) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      <Badge tone="gray">{fmt.num(s.judged)} judged</Badge>
      <Badge tone={s.worseRate > 0.05 ? "red" : "green"}>worse {pct(s.worseRate)}</Badge>
      {s.criticalFailRate != null && <Badge tone={s.criticalFailRate > 0 ? "red" : "gray"}>critical {pct(s.criticalFailRate)}</Badge>}
      <Badge tone="gray">format {pct(s.formatPassRate)}</Badge>
      <Badge tone="green">cost −{pct(s.costSavingPct)}</Badge>
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
        const approver = window.prompt("Approver name:") || "console";
        try { await api.acceptRecommendation(rec._id, { reason, approver }); await onChange(); }
        catch (e2) { setErr(e2.message); }
      } else setErr(e.message);
    } finally { setBusy(false); }
  };

  return (
    <Card>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="text-base font-semibold text-arbr-charcoal">{rec.title}</h3>
            {rec.status === "accepted" && <Badge tone="green">Accepted</Badge>}
            {rec.status === "dismissed" && <Badge tone="gray">Dismissed</Badge>}
            {rec.status === "pending" && <Badge tone="amber">Pending</Badge>}
            <Badge tone={EVAL_TONE[evalStatus]}>{EVAL_LABEL[evalStatus]}</Badge>
          </div>
          <p className="mt-2 text-sm text-gray-600">{rec.reason}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Badge tone="charcoal">{rec.currentModel} → {rec.suggestedModel}</Badge>
            <Badge tone="gray">{fmt.num(rec.requestCount)} requests</Badge>
            {rec.replayableCount != null && (
              <Badge tone={rec.replayableCount === 0 ? "red" : "gray"}>{fmt.num(rec.replayableCount)} replayable</Badge>
            )}
          </div>
          <QualitySummary s={rec.qualitySummary} />
        </div>
        <div className="shrink-0 text-right">
          <div className="label">Projected saving</div>
          <div className="text-2xl font-bold text-arbr-green-600">{fmt.usd(rec.projectedSavings)}</div>
          <div className="text-xs text-gray-500">{fmt.usd(rec.currentCost)} → {fmt.usd(rec.projectedCost)}</div>
        </div>
      </div>

      {rec.status === "pending" && (
        <div className="mt-4 border-t border-gray-100 pt-4">
          {/* Eval-backed flow: prove quality, then roll out under control. */}
          <div className="flex flex-wrap items-center gap-2">
            {(evalStatus === "not_started") && (
              rec.replayableCount === 0 ? (
                <span className="text-sm text-gray-500">
                  No replayable traffic yet — this recommendation's requests have no captured prompts.
                  Turn on payload capture (Settings → Observability); only traffic logged after it is enabled can be evaluated.
                </span>
              ) : (
                <button className="btn-secondary text-sm" disabled={busy}
                  onClick={() => run(() => api.createEvalDataset(rec._id), (d) => `Dataset built: ${d.itemCount} items (${d.riskTier} risk).`)}>
                  Build eval dataset
                </button>
              )
            )}
            {(evalStatus === "dataset_ready" || evalStatus === "failed") && (
              <>
                <select className="input text-sm" value={judge} onChange={(e) => setJudge(e.target.value)} title="Judge model">
                  <option value="">Judge: none</option>
                  {models.map((m) => <option key={m.id} value={m.id}>Judge: {m.label || m.id}</option>)}
                </select>
                <button className="btn-secondary text-sm" disabled={busy}
                  onClick={() => run(() => api.runEval(rec._id, { judgeModel: judge || null }), () => "Offline eval started — refresh in a moment.")}>
                  Run offline eval
                </button>
              </>
            )}
            {evalStatus === "running" && <span className="text-sm text-amber-600">Evaluating… refresh to see the result.</span>}
            {evalStatus === "passed" && (
              <>
                <input className="input text-sm" placeholder="application for rollout" value={application} onChange={(e) => setApplication(e.target.value)} />
                <button className="btn-secondary text-sm" disabled={busy || !application.trim()}
                  onClick={() => run(() => api.createCanary(rec._id, { application: application.trim() }), (x) => `Canary started at ${x.rolloutPct}%.`)}>
                  Start canary
                </button>
              </>
            )}
            <button className="btn-outline text-sm" disabled={busy} onClick={accept}>Accept as rule</button>
            <button className="btn-outline text-sm" disabled={busy} onClick={() => run(() => api.dismissRecommendation(rec._id))}>Dismiss</button>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Accepting creates a routing rule (off until you switch it on). It is gated on a passed eval; without one you'll be asked for an override reason.
          </p>
          {notice && <div className="mt-2 text-sm text-arbr-green-700">{notice}</div>}
          {err && <div className="mt-2 text-sm text-red-600">{err}</div>}
        </div>
      )}
    </Card>
  );
}

// Self-diagnosing empty state: instead of a dead end, explain what was analyzed and surface
// high-spend task types that are excluded only because they aren't marked cheap — with a
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
          <p className="mt-1 text-sm text-gray-400">{analyzed} No premium model is overused on a cheap task — cheap-task traffic is already on lighter models.</p>
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
                <span className="text-sm font-semibold text-arbr-green-600">~{fmt.usd(o.projectedSavings)}</span>
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
    api.models({ live: true }).then((m) => setModels(m || [])).catch(() => {});
  }, []);

  const recompute = async () => {
    setBusy(true); setErr(null);
    try { await api.recompute(); await load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  // One-click: mark the given task types cheap (union with the current set), then recompute.
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
          <p className="text-sm text-gray-500">Costed suggestions. Prove a cheaper model is no worse than the current one, then roll out under control — the system proposes, the human decides.</p>
        </div>
        <button className="btn-primary" onClick={recompute} disabled={busy}>
          {busy ? "Recomputing…" : "Recompute"}
        </button>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {recs === null ? <Spinner /> : recs.length === 0 ? (
        <EmptyState analysis={analysis} busy={busy} onMarkCheap={markCheapAndRecompute} />
      ) : (
        <div className="space-y-4">
          {recs.map((r) => <RecCard key={r._id} rec={r} models={models} onChange={load} />)}
        </div>
      )}
    </div>
  );
}
