import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

// Getting-started checklist shown at the top of Overview for new tenants. It reads real setup state
// (no manual ticking) and auto-hides once every step is done, or when the user dismisses it. Works the
// same in OSS and hosted — it keys off signals that exist in both. Steps, in activation order:
//   1. Connect a model      → a provider is live        (status.demoMode === false)
//   2. Create an API key     → ≥1 active key exists       (keys.length > 0; also registers the app)
//   3. Send your first request → any customer traffic      (overview.totalRequests > 0)
//   4. Set up routing        → routing configured         (routingMode !== "off" | defaultModel | rules)
const DISMISS_KEY = "arbr:onboarding:dismissed";

const CheckIcon = () => (
  <svg viewBox="0 0 20 20" className="h-5 w-5" aria-hidden="true">
    <circle cx="10" cy="10" r="10" className="fill-green-600" />
    <path d="M6 10.5l2.5 2.5L14 7.5" fill="none" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const StepNumber = ({ n, active }) => (
  <span
    className={`inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs font-semibold ${
      active ? "border-arbr-charcoal bg-arbr-charcoal text-white" : "border-gray-300 text-gray-400"
    }`}
    aria-hidden="true"
  >
    {n}
  </span>
);

export default function GettingStarted() {
  const [state, setState] = useState(null); // null while loading; then { done: bool[] }
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(DISMISS_KEY) === "1"; } catch { return false; }
  });

  useEffect(() => {
    if (dismissed) return;
    let alive = true;
    Promise.all([
      api.status().catch(() => null),
      api.keys().catch(() => null),
      api.overview().catch(() => null),
      api.rules().catch(() => null),
    ]).then(([s, keys, ov, rules]) => {
      if (!alive) return;
      const liveProvider = !!(s && (s.demoMode === false || (Array.isArray(s.liveProviders) && s.liveProviders.length > 0)));
      const hasKey = Array.isArray(keys) && keys.length > 0;
      const firstRequest = !!(ov && Number(ov.totalRequests) > 0);
      const routingSet =
        !!(s && ((s.routingMode && s.routingMode !== "off") || s.defaultModel)) ||
        (Array.isArray(rules) && rules.length > 0);
      setState({ done: [liveProvider, hasKey, firstRequest, routingSet] });
    });
    return () => { alive = false; };
  }, [dismissed]);

  function dismiss() {
    try { localStorage.setItem(DISMISS_KEY, "1"); } catch { /* ignore */ }
    setDismissed(true);
  }

  if (dismissed || !state) return null;

  const steps = [
    { title: "Connect a model", desc: "Add a provider key so Arbr can route to real models.", to: "/models", cta: "Connect" },
    { title: "Create an API key", desc: "Generate a gateway key for your application.", to: "/settings?tab=keys", cta: "Create key" },
    { title: "Send your first request", desc: "Point your OpenAI-compatible client at the gateway and make a call.", to: "/docs", cta: "View quickstart" },
    { title: "Set up routing", desc: "Add a rule or turn on auto-routing to send each task to the right model.", to: "/routing", cta: "Set up" },
  ];
  const done = state.done;
  const doneCount = done.filter(Boolean).length;
  if (doneCount === steps.length) return null; // all set — auto-hide

  const firstTodo = done.findIndex((d) => !d);

  return (
    <div className="rounded-xl border border-arbr-accent-200 bg-arbr-accent-50 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-arbr-charcoal">Get started with Arbr</h3>
          <p className="mt-1 text-sm text-gray-500">A few steps to route your first request through the gateway.</p>
        </div>
        <button type="button" onClick={dismiss} className="btn-ghost shrink-0 text-sm text-gray-500">Dismiss</button>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-arbr-accent-200">
          <div className="h-full rounded-full bg-arbr-charcoal transition-all" style={{ width: `${(doneCount / steps.length) * 100}%` }} />
        </div>
        <span className="label shrink-0">{doneCount} of {steps.length}</span>
      </div>

      <ul className="mt-5 space-y-2">
        {steps.map((step, i) => {
          const isDone = done[i];
          const isNext = i === firstTodo;
          return (
            <li
              key={step.title}
              className={`flex items-center gap-3 rounded-lg px-3 py-3 ${isNext ? "bg-white shadow-card" : ""}`}
            >
              <span className="shrink-0">{isDone ? <CheckIcon /> : <StepNumber n={i + 1} active={isNext} />}</span>
              <div className="min-w-0 flex-1">
                <div className={`text-sm font-medium ${isDone ? "text-gray-400 line-through" : "text-arbr-charcoal"}`}>{step.title}</div>
                {!isDone && <div className="mt-0.5 text-sm text-gray-500">{step.desc}</div>}
              </div>
              {isDone ? (
                <span className="shrink-0 text-xs font-medium text-green-700">Done</span>
              ) : (
                <Link to={step.to} className={`${isNext ? "btn-primary" : "btn-outline"} shrink-0 text-sm`}>
                  {step.cta}
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
