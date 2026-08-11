import React, { useEffect, useState, useCallback, useRef } from "react";
import { Card, Badge, Spinner } from "../components/ui.jsx";

// The hosted Account page. Data + billing actions are served by the hosted layer (arbr-cloud) at
// non-/api paths, so we use raw fetch here rather than the /api client. In OSS these endpoints don't
// exist and this page is unreachable (no Account nav item — see Layout.jsx).

const fmtNum = (n) => Number(n || 0).toLocaleString();

// Load Razorpay Checkout on demand — only when a hosted user actually clicks Upgrade, so OSS never
// pulls it in.
function loadRazorpay() {
  return new Promise((resolve) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement("script");
    s.src = "https://checkout.razorpay.com/v1/checkout.js";
    s.onload = () => resolve(true);
    s.onerror = () => resolve(false);
    document.body.appendChild(s);
  });
}

async function getAccount() {
  const r = await fetch("/account/data", { credentials: "include" });
  if (!r.ok) throw new Error(r.status === 401 ? "Please sign in." : `HTTP ${r.status}`);
  return r.json();
}

export default function Account() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const autoUpgradedRef = useRef(false); // guard so ?upgrade=1 opens Checkout exactly once

  const load = useCallback(async () => {
    try { setData(await getAccount()); setErr(null); }
    catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // The plan flips via the Razorpay webhook, not the browser — poll until it lands, then reload.
  const pollPlan = useCallback(async (target) => {
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      try { const j = await getAccount(); if (j.plan === target) { setData(j); setMsg(""); setBusy(false); return; } }
      catch { /* keep polling */ }
    }
    setMsg("Still processing — refresh in a moment."); setBusy(false);
  }, []);

  const upgrade = async () => {
    setBusy(true); setMsg("Opening checkout…");
    if (!(await loadRazorpay())) { setMsg("Checkout failed to load — check your connection and retry."); setBusy(false); return; }
    try {
      const r = await fetch("/billing/subscribe", { method: "POST", credentials: "include" });
      const s = await r.json();
      if (!r.ok) throw new Error(s.error || `HTTP ${r.status}`);
      const rzp = new window.Razorpay({
        key: s.keyId, subscription_id: s.subscriptionId, name: s.appName || "Arbr",
        description: "Arbr Paid plan", prefill: { email: s.email },
        handler: () => { setMsg("Payment received — activating your plan…"); pollPlan("paid"); },
        modal: { ondismiss: () => { setBusy(false); setMsg(""); } },
      });
      rzp.on("payment.failed", () => { setBusy(false); setMsg("Payment failed. Please try again."); });
      rzp.open();
    } catch (e) { setBusy(false); setMsg(`Could not start checkout (${e.message}).`); }
  };

  const cancel = async () => {
    if (!window.confirm("Cancel your Paid subscription and move to the Free plan?")) return;
    setBusy(true); setMsg("Cancelling…");
    try {
      const r = await fetch("/billing/cancel", { method: "POST", credentials: "include" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setMsg("Subscription cancelled — updating…"); pollPlan("free");
    } catch (e) { setBusy(false); setMsg(`Could not cancel (${e.message}).`); }
  };

  // Deep-link from the hosted /plans "Subscribe" CTA: it signs the visitor in and lands them here at
  // /account?upgrade=1, so open Checkout automatically. Fire once, and strip the flag so a refresh
  // (or the browser back button) doesn't reopen it.
  useEffect(() => {
    if (autoUpgradedRef.current || !data) return;
    if (new URLSearchParams(window.location.search).get("upgrade") !== "1") return;
    autoUpgradedRef.current = true;
    window.history.replaceState({}, "", window.location.pathname);
    if (data.plan === "free" && data.billingEnabled) upgrade();
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  if (err) return <div className="mx-auto max-w-2xl text-sm text-red-600">Could not load account — {err}</div>;
  if (!data) return <div className="flex justify-center py-16"><Spinner /></div>;

  const q = data.quota || {};
  const unlimited = q.limit == null;
  const used = q.used || 0;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / q.limit) * 100));
  const barColor = pct >= 100 ? "bg-red-500" : pct >= 80 ? "bg-amber-400" : "bg-arbr-charcoal";

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-arbr-charcoal">Account</h1>
        <p className="mt-1 text-sm text-gray-500">Your Arbr plan and usage.</p>
      </div>

      <Card>
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-500">Signed in as</span>
          <span className="text-sm font-medium text-arbr-charcoal">{data.email}</span>
        </div>
        <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3">
          <span className="text-sm text-gray-500">Plan</span>
          <Badge tone={data.plan === "paid" ? "green" : "charcoal"}>{data.planLabel || data.plan}</Badge>
        </div>
      </Card>

      <Card title="Requests this month">
        {unlimited ? (
          <div className="text-lg font-semibold text-arbr-charcoal">Unlimited</div>
        ) : (
          <>
            <div className="text-lg font-semibold text-arbr-charcoal">
              {fmtNum(used)} <span className="text-sm font-normal text-gray-500">of {fmtNum(q.limit)} requests</span>
            </div>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-200">
              <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
            </div>
            <div className="mt-2 text-xs text-gray-500">
              {fmtNum(q.remaining)} remaining · resets each {q.period || "month"}
              {pct >= 100 ? " · quota reached — requests return 429 until reset" : ""}
            </div>
          </>
        )}
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        {data.plan === "free" ? (
          // Send the user to the in-app /plans page (plan comparison + upgrade). That page links back
          // to /account?upgrade=1, where the effect above opens Checkout — one checkout path, reused.
          <a className="btn-primary" href="/plans">Upgrade to Paid</a>
        ) : (
          <button className="btn-outline disabled:opacity-50" disabled={busy} onClick={cancel}>
            Cancel subscription
          </button>
        )}
        {/* Logout lives in the header user menu (avatar → Log out), not on this page. */}
        {msg && <span className="text-sm text-gray-500">{msg}</span>}
      </div>
    </div>
  );
}
