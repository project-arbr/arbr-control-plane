import React from "react";
import { NavLink } from "react-router-dom";
import { getAdminToken } from "../api.js";

// Grouped by workflow: monitor what's happening → control how it routes → configure.
const NAV_GROUPS = [
  { section: "Monitor", items: [
    { to: "/", label: "Overview", end: true },
    { to: "/applications", label: "Applications" },
  ] },
  { section: "Control", items: [
    { to: "/routing",  label: "Routing" },
    { to: "/budgets",  label: "Budgets" },
    { to: "/models",   label: "Models" },
    { to: "/evals",    label: "Model Evals" },
    { to: "/settings", label: "Settings" },
  ] },
  { section: "Governance", items: [
    { to: "/governance", label: "Governance" },
    { to: "/audit",      label: "Audit" },
  ] },
];
const FOOTER_LINK = { to: "/docs", label: "Docs" };

function navClass({ isActive }) {
  return `mx-1 my-0.5 flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive
      ? "bg-arbr-green-600 text-white"
      : "text-gray-400 hover:bg-white/8 hover:text-white"
  }`;
}

function Wordmark() {
  return (
    <div className="flex items-baseline gap-0.5">
      <span className="text-xl font-bold tracking-tight text-white">ARBR</span>
      <span className="text-xl font-bold text-arbr-green-400">.</span>
    </div>
  );
}

export default function Layout({ status, onSignOut, children }) {
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 flex h-screen w-56 flex-col bg-arbr-charcoal">
        <div className="px-5 py-5">
          <Wordmark />
          <div className="mt-1 text-[11px] text-gray-500">Control Plane · Phase 1</div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.section} className={gi > 0 ? "mt-5" : ""}>
              <div className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-widest text-gray-600">
                {group.section}
              </div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="px-2 pb-2">
          <NavLink to={FOOTER_LINK.to} className={navClass}>{FOOTER_LINK.label}</NavLink>
          {getAdminToken() && onSignOut && (
            <button
              onClick={onSignOut}
              className="mx-1 mt-0.5 flex w-full items-center rounded-lg px-3 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-white/8 hover:text-gray-300"
            >
              Sign out
            </button>
          )}
        </div>

        <div className="px-5 pb-4 pt-1 text-[11px] text-gray-600">
          A human approves the policy; rules always override.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-gray-200 bg-white px-8 py-4 shadow-card">
          <div className="text-sm text-gray-500">Enterprise AI control plane</div>
          <div className="flex items-center gap-3">
            {status?.demoMode ? (
              <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                Demo mode — no provider keys
              </span>
            ) : (
              <span className="inline-flex items-center rounded-md border border-arbr-green-200 bg-arbr-green-50 px-2.5 py-1 text-xs font-medium text-arbr-green-700">
                Live · {(status?.liveProviders || []).join(", ")}
              </span>
            )}
            {status?.breachedCaps > 0 && (
              <span className="inline-flex items-center rounded-md border border-red-200 bg-red-50 px-2.5 py-1 text-xs font-medium text-red-700">
                {status.breachedCaps} budget{status.breachedCaps > 1 ? "s" : ""} over
              </span>
            )}
            {status?.routingMode && status.routingMode !== "off" && (
              <span className="inline-flex items-center rounded-md border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-xs font-medium text-indigo-700">
                {status.routingMode === "ai" ? "AI routing" : "Cost guardrail"}
              </span>
            )}
          </div>
        </header>
        <main className="flex-1 overflow-y-auto px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
