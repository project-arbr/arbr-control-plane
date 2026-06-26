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
    { to: "/settings", label: "Settings" },
  ] },
  { section: "Governance", items: [
    { to: "/governance", label: "Governance" },
    { to: "/audit",      label: "Audit" },
  ] },
];
const FOOTER_LINK = { to: "/docs", label: "Docs" };

function navClass({ isActive }) {
  return `mx-1 my-0.5 block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
    isActive ? "bg-gyde-green-600 text-white" : "text-gray-600 hover:bg-gyde-green-50 hover:text-gyde-charcoal"
  }`;
}

function Wordmark() {
  return (
    <div className="flex items-baseline gap-0.5">
      <span className="text-xl font-bold tracking-tight text-gyde-charcoal">ARBR</span>
      <span className="text-xl font-bold text-gyde-green-600">.</span>
    </div>
  );
}

export default function Layout({ status, onSignOut, children }) {
  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 flex h-screen w-64 flex-col border-r border-gray-200 bg-white">
        <div className="px-6 py-6">
          <Wordmark />
          <div className="mt-1 text-xs text-gray-500">Control Plane · Phase 1</div>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-3">
          {NAV_GROUPS.map((group) => (
            <div key={group.section} className="mb-4">
              <div className="px-3 pb-1 label">{group.section}</div>
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="border-t border-gray-200 px-3 pt-3 pb-1">
          <NavLink to={FOOTER_LINK.to} className={navClass}>{FOOTER_LINK.label}</NavLink>
        </div>
        <div className="px-6 py-4 text-xs text-gray-400">
          A human approves the policy; rules always override.
          {getAdminToken() && onSignOut && (
            <button onClick={onSignOut} className="mt-2 block text-xs text-gray-500 underline hover:text-gyde-charcoal">
              Sign out
            </button>
          )}
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
              <span className="inline-flex items-center rounded-md border border-gyde-green-200 bg-gyde-green-50 px-2.5 py-1 text-xs font-medium text-gyde-green-700">
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
