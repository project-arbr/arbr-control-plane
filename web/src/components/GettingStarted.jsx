import React, { useCallback, useEffect, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { api } from "../api.js";

// Floating, minimizable getting-started checklist. Mounted once in Layout so it persists on every
// console page (not just Overview) — you can keep it open while you work through the steps, and it
// re-reads real setup state on every route change and window focus, so it checks itself off as you go.
// Steps (activation order): connect a model → create an API key → send first request → set up routing.
// Auto-hides (and stops polling) once all steps are done or when dismissed. Works in OSS and hosted.
const DISMISS_KEY = "arbr:onboarding:dismissed";
const COLLAPSE_KEY = "arbr:onboarding:collapsed";
const read = (k) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
const write = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* ignore */ } };

const STEPS = [
  { title: "Connect a model", desc: "Add a provider key so Arbr can route to real models.", to: "/models" },
  { title: "Create an API key", desc: "Generate a gateway key for your application.", to: "/settings?tab=keys" },
  { title: "Send your first request", desc: "Point your OpenAI-compatible client at the gateway.", to: "/docs" },
  { title: "Set up routing", desc: "Send each task to the right model with a rule or auto-routing.", to: "/routing" },
];

const CheckIcon = () => (
  <svg viewBox="0 0 20 20" className="h-5 w-5 shrink-0" aria-hidden="true">
    <circle cx="10" cy="10" r="10" className="fill-green-600" />
    <path d="M6 10.5l2.5 2.5L14 7.5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
const StepNumber = ({ n, active }) => (
  <span className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${active ? "border-arbr-charcoal bg-arbr-charcoal text-white" : "border-gray-300 text-gray-400"}`} aria-hidden="true">{n}</span>
);
const Ring = ({ done, total }) => {
  const r = 8, c = 2 * Math.PI * r, pct = total ? done / total : 0;
  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="shrink-0 text-arbr-charcoal" aria-hidden="true">
      <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.4" />
      <circle cx="10" cy="10" r={r} fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - pct)} transform="rotate(-90 10 10)" />
    </svg>
  );
};

export default function GettingStarted() {
  const location = useLocation();
  const [done, setDone] = useState(null); // bool[] once loaded
  const [dismissed, setDismissed] = useState(() => read(DISMISS_KEY));
  const [collapsed, setCollapsed] = useState(() => read(COLLAPSE_KEY));

  const refresh = useCallback(() => {
    Promise.all([
      api.status().catch(() => null),
      api.keys().catch(() => null),
      api.overview().catch(() => null),
      api.rules().catch(() => null),
    ]).then(([s, keys, ov, rules]) => {
      const d = [
        !!(s && (s.demoMode === false || (Array.isArray(s.liveProviders) && s.liveProviders.length > 0))),
        Array.isArray(keys) && keys.length > 0,
        !!(ov && Number(ov.totalRequests) > 0),
        // Routing = the user actually turned on auto-routing OR created a rule (generic or app-specific).
        // A default model doesn't count — it's auto-set when a provider is connected, so it isn't a
        // signal that the user configured routing.
        !!(s && s.routingMode && s.routingMode !== "off") || (Array.isArray(rules) && rules.length > 0),
      ];
      setDone(d);
      if (d.every(Boolean)) { write(DISMISS_KEY, true); setDismissed(true); } // all set — retire it
    });
  }, []);

  // Re-check on mount, on every route change, and when the tab regains focus — until dismissed.
  useEffect(() => {
    if (dismissed) return;
    refresh();
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [dismissed, refresh, location.pathname]);

  function dismiss() { write(DISMISS_KEY, true); setDismissed(true); }
  function setCollapsedPersist(v) { write(COLLAPSE_KEY, v); setCollapsed(v); }

  if (dismissed || !done) return null;
  const total = STEPS.length;
  const doneCount = done.filter(Boolean).length;
  if (doneCount === total) return null;
  const firstTodo = done.findIndex((d) => !d);

  // Minimized: a small pill with a progress ring.
  if (collapsed) {
    return (
      <button
        type="button"
        onClick={() => setCollapsedPersist(false)}
        className="fixed bottom-4 right-4 z-40 inline-flex items-center gap-2.5 rounded-full border border-arbr-accent-200 bg-white px-4 py-2.5 shadow-menu transition-colors hover:border-gray-300"
      >
        <Ring done={doneCount} total={total} />
        <span className="text-sm font-medium text-arbr-charcoal">Get started</span>
        <span className="label">{doneCount}/{total}</span>
      </button>
    );
  }

  // Expanded: the floating checklist.
  return (
    <div className="fixed bottom-4 right-4 z-40 w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-arbr-accent-200 bg-arbr-accent-50 p-5 shadow-menu">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-arbr-charcoal">Get started with Arbr</h3>
          <p className="mt-0.5 text-xs text-gray-500">Route your first request through the gateway.</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => setCollapsedPersist(true)} aria-label="Minimize" title="Minimize"
            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-white hover:text-gray-700">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 7h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
          <button type="button" onClick={dismiss} aria-label="Dismiss" title="Dismiss"
            className="flex h-7 w-7 items-center justify-center rounded-md text-gray-400 hover:bg-white hover:text-gray-700">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M3.5 3.5l7 7M10.5 3.5l-7 7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-arbr-accent-200">
          <div className="h-full rounded-full bg-arbr-charcoal transition-all" style={{ width: `${(doneCount / total) * 100}%` }} />
        </div>
        <span className="label shrink-0">{doneCount} of {total}</span>
      </div>

      <ul className="mt-3 space-y-1">
        {STEPS.map((step, i) => {
          const isDone = done[i];
          const isNext = i === firstTodo;
          if (isDone) {
            return (
              <li key={step.title} className="flex items-center gap-2.5 px-2 py-2">
                <CheckIcon />
                <span className="flex-1 text-sm text-gray-400 line-through">{step.title}</span>
              </li>
            );
          }
          return (
            <li key={step.title}>
              <Link
                to={step.to}
                className={`flex items-center gap-2.5 rounded-lg px-2 py-2 transition-colors hover:bg-white ${isNext ? "bg-white shadow-card" : ""}`}
              >
                <StepNumber n={i + 1} active={isNext} />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-arbr-charcoal">{step.title}</span>
                  {isNext && <span className="mt-0.5 block text-xs text-gray-500">{step.desc}</span>}
                </span>
                <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0 text-gray-400" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
