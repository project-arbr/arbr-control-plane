import React, { useState } from "react";
import { NavLink } from "react-router-dom";
import { getAdminToken } from "../api.js";

// ── Inline icons (16×16 stroke, no external dep) ──────────────────────────────
const Icon = ({ children }) => (
  <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

const icons = {
  overview: (
    <Icon>
      <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
      <rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>
    </Icon>
  ),
  applications: (
    <Icon>
      <polygon points="12 2 2 7 12 12 22 7 12 2"/>
      <polyline points="2 17 12 22 22 17"/>
      <polyline points="2 12 12 17 22 12"/>
    </Icon>
  ),
  routing: (
    <Icon>
      <circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="5.5" r="2.5"/><circle cx="18" cy="18.5" r="2.5"/>
      <path d="M8.5 10.9 15.5 7M8.5 13.1 15.5 17"/>
    </Icon>
  ),
  budgets: (
    <Icon>
      <line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/>
      <line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/>
    </Icon>
  ),
  models: (
    <Icon>
      <rect x="7" y="7" width="10" height="10" rx="1"/>
      <path d="M9 4v3M12 4v3M15 4v3M9 17v3M12 17v3M15 17v3M4 9h3M4 12h3M4 15h3M17 9h3M17 12h3M17 15h3"/>
    </Icon>
  ),
  evals: (
    <Icon>
      <path d="M9 3h6v6.5L19.5 16a2 2 0 0 1-1.75 3H6.25A2 2 0 0 1 4.5 16L9 9.5V3z"/>
      <path d="M8.5 14h7"/>
    </Icon>
  ),
  settings: (
    <Icon>
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </Icon>
  ),
  governance: (
    <Icon>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
    </Icon>
  ),
  audit: (
    <Icon>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
      <rect x="9" y="3" width="6" height="4" rx="1"/>
      <line x1="9" y1="12" x2="15" y2="12"/><line x1="9" y1="16" x2="13" y2="16"/>
    </Icon>
  ),
  docs: (
    <Icon>
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
    </Icon>
  ),
  recommend: (
    <Icon>
      <path d="M9 18h6M10 21h4"/>
      <path d="M12 3a6 6 0 0 0-4 10.5c.6.6 1 1.4 1 2.5h6c0-1.1.4-1.9 1-2.5A6 6 0 0 0 12 3z"/>
    </Icon>
  ),
};

// ── Navigation definition ─────────────────────────────────────────────────────
const NAV_GROUPS = [
  { section: "Connect", hint: "Wire apps & providers to the gateway", items: [
    { to: "/models",   label: "Models",   icon: icons.models },
    { to: "/settings", label: "Settings", icon: icons.settings },
  ] },
  { section: "See", hint: "Know what you're spending, and where", items: [
    { to: "/", label: "Overview", end: true, icon: icons.overview },
    { to: "/applications", label: "Applications", icon: icons.applications },
  ] },
  { section: "Recommend", hint: "Where a cheaper model fits", items: [
    { to: "/recommendations", label: "Recommendations", icon: icons.recommend },
  ] },
  { section: "Route", hint: "Send traffic to the right model", items: [
    { to: "/routing", label: "Routing",     icon: icons.routing },
    { to: "/evals",   label: "Model Evals", icon: icons.evals },
  ] },
  { section: "Govern", hint: "Limits, guardrails, and records", items: [
    { to: "/budgets",    label: "Budgets",    icon: icons.budgets },
    { to: "/governance", label: "Governance", icon: icons.governance },
    { to: "/audit",      label: "Audit",      icon: icons.audit },
  ] },
];
const FOOTER_LINK = { to: "/docs", label: "Docs", icon: icons.docs };

function navClass({ isActive }) {
  return `mx-1 my-0.5 flex items-center gap-2.5 rounded-lg px-3 py-2 text-[13px] font-medium transition-colors ${
    isActive
      ? "bg-arbr-green-50 text-arbr-green-700"
      : "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
  }`;
}

function Wordmark() {
  return (
    <div className="flex items-baseline gap-0.5">
      <span className="text-xl font-bold tracking-tight text-arbr-charcoal">ARBR</span>
      <span className="text-xl font-bold text-arbr-green-600">.</span>
    </div>
  );
}

export default function Layout({ status, onSignOut, children }) {
  const [collapsed, setCollapsed] = useState(new Set());

  function toggleSection(section) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  return (
    <div className="flex min-h-full">
      <aside className="sticky top-0 flex h-screen w-60 flex-col border-r border-gray-100 bg-white">
        <div className="px-5 py-5">
          <Wordmark />
          <div className="mt-1 font-mono text-[10px] text-gray-400">control-plane</div>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          {NAV_GROUPS.map((group, gi) => {
            const isCollapsed = collapsed.has(group.section);
            return (
              <div key={group.section} className={gi > 0 ? "mt-1" : ""}>
                <button
                  onClick={() => toggleSection(group.section)}
                  title={group.hint}
                  className="group flex w-full items-center justify-between rounded-md px-3 py-1.5 text-left transition-colors hover:bg-gray-50"
                >
                  <span className="text-[10.5px] font-semibold uppercase tracking-widest text-gray-400 transition-colors group-hover:text-gray-600">
                    {group.section}
                  </span>
                  <svg
                    className={`h-3 w-3 flex-shrink-0 text-gray-300 transition-transform duration-200 group-hover:text-gray-400 ${
                      isCollapsed ? "-rotate-90" : ""
                    }`}
                    viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <polyline points="6 9 12 15 18 9"/>
                  </svg>
                </button>

                {!isCollapsed && (
                  <div className="mt-0.5 mb-1.5">
                    {group.items.map((item) => (
                      <NavLink key={item.to} to={item.to} end={item.end} className={navClass}>
                        {item.icon}
                        {item.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="px-2 pb-2">
          <NavLink to={FOOTER_LINK.to} className={navClass}>
            {FOOTER_LINK.icon}
            {FOOTER_LINK.label}
          </NavLink>
          {getAdminToken() && onSignOut && (
            <button
              onClick={onSignOut}
              className="mx-1 mt-0.5 flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium text-gray-400 transition-colors hover:bg-gray-50 hover:text-gray-900"
            >
              <svg className="h-4 w-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                <polyline points="16 17 21 12 16 7"/>
                <line x1="21" y1="12" x2="9" y2="12"/>
              </svg>
              Sign out
            </button>
          )}
        </div>

        <div className="px-5 pb-4 pt-1 font-mono text-[10px] text-gray-400">
          Human approves · rules override.
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b border-gray-100 bg-gray-50/80 px-8 py-3 backdrop-blur-sm">
          {status?.demoMode ? (
            <span className="inline-flex items-center rounded-md border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
              Demo — no provider keys
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-arbr-green-200 bg-arbr-green-50 px-2 py-0.5 text-xs font-medium text-arbr-green-700">
              <span className="h-1.5 w-1.5 rounded-full bg-arbr-green-500" />
              {(status?.liveProviders || []).join(", ") || "Live"}
            </span>
          )}
          {status?.breachedCaps > 0 && (
            <span className="inline-flex items-center rounded-md border border-red-200 bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700">
              {status.breachedCaps} budget{status.breachedCaps > 1 ? "s" : ""} over
            </span>
          )}
          {status?.routingMode && status.routingMode !== "off" && (
            <span className="inline-flex items-center rounded-md border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
              {status.routingMode === "ai" ? "AI routing" : "Cost guardrail"}
            </span>
          )}
        </header>
        <main className="flex-1 overflow-y-auto px-8 py-6">{children}</main>
      </div>
    </div>
  );
}
