import React, { useEffect, useState } from "react";
import { api, fmt } from "../api.js";
import { Card, Badge, Spinner } from "../components/ui.jsx";

export default function Recommendations({ embedded = false }) {
  const [recs, setRecs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = () => api.recommendations().then(setRecs).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);

  const recompute = async () => {
    setBusy(true); setErr(null);
    try { await api.recompute(); await load(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const accept = async (id) => { await api.acceptRecommendation(id); await load(); };
  const dismiss = async (id) => { await api.dismissRecommendation(id); await load(); };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          {!embedded && <h1 className="text-2xl font-bold text-gyde-charcoal">Recommendations</h1>}
          <p className="text-sm text-gray-500">Costed optimisation suggestions. The system proposes; the human decides.</p>
        </div>
        <button className="btn-primary" onClick={recompute} disabled={busy}>
          {busy ? "Recomputing…" : "Recompute"}
        </button>
      </div>

      {err && <div className="text-red-600">{err}</div>}
      {recs === null ? <Spinner /> : recs.length === 0 ? (
        <Card>
          <div className="py-8 text-center text-gray-400">
            No recommendations yet. Click <span className="font-medium text-gyde-charcoal">Recompute</span> to analyse the logged data.
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {recs.map((r) => (
            <Card key={r._id}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-gyde-charcoal">{r.title}</h3>
                    {r.status === "accepted" && <Badge tone="green">Accepted</Badge>}
                    {r.status === "dismissed" && <Badge tone="gray">Dismissed</Badge>}
                    {r.status === "pending" && <Badge tone="amber">Pending</Badge>}
                  </div>
                  <p className="mt-2 text-sm text-gray-600">{r.reason}</p>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs">
                    <Badge tone="charcoal">{r.currentModel} → {r.suggestedModel}</Badge>
                    <Badge tone="gray">{fmt.num(r.requestCount)} requests</Badge>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="label">Projected saving</div>
                  <div className="text-2xl font-bold text-gyde-green-600">{fmt.usd(r.projectedSavings)}</div>
                  <div className="text-xs text-gray-500">{fmt.usd(r.currentCost)} → {fmt.usd(r.projectedCost)}</div>
                </div>
              </div>
              {r.status === "pending" && (
                <div className="mt-4 flex gap-2 border-t border-gray-100 pt-4">
                  <button className="btn-secondary" onClick={() => accept(r._id)}>Accept as rule</button>
                  <button className="btn-outline" onClick={() => dismiss(r._id)}>Dismiss</button>
                  <span className="self-center text-xs text-gray-400">Accepting creates a routing rule — off until you switch it on.</span>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
