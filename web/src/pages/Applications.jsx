import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmt } from "../api.js";
import { Spinner, Toggle } from "../components/ui.jsx";

// ── icons ─────────────────────────────────────────────────────────────────────

function IconGrid() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="1" y="1" width="6" height="6" rx="1" />
      <rect x="9" y="1" width="6" height="6" rx="1" />
      <rect x="1" y="9" width="6" height="6" rx="1" />
      <rect x="9" y="9" width="6" height="6" rx="1" />
    </svg>
  );
}

function IconList() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="1" y1="4" x2="15" y2="4" />
      <line x1="1" y1="8" x2="15" y2="8" />
      <line x1="1" y1="12" x2="15" y2="12" />
    </svg>
  );
}

// ── shared status helpers ─────────────────────────────────────────────────────

function statusBadge(isKilled, neverUsed) {
  if (isKilled) {
    return (
      <span className="inline-flex items-center rounded text-xs font-medium text-red-600 bg-red-100 px-1.5 py-0.5">
        Disconnected
      </span>
    );
  }
  if (neverUsed) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-400">
        <span className="h-1.5 w-1.5 rounded-full bg-gray-300 inline-block" />
        Waiting for first request
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-arbr-green-700">
      <span className="h-1.5 w-1.5 rounded-full bg-arbr-green-600 inline-block" />
      Active
    </span>
  );
}

// ── card view ─────────────────────────────────────────────────────────────────

function AppCard({ app, stats, config, onToggleKill }) {
  const isKilled = config?.killSwitchEnabled ?? false;
  const isActive = !isKilled;
  const neverUsed = !stats || stats.requests === 0;
  const successRate = stats && stats.requests > 0
    ? (((stats.requests - (stats.failures || 0)) / stats.requests) * 100).toFixed(1) + "%"
    : "—";

  return (
    <div className={`card flex flex-col gap-4 p-5 transition-all ${isKilled ? "border-red-200 bg-red-50/30" : neverUsed ? "border-gray-200 bg-gray-50/40" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={`/applications/${encodeURIComponent(app)}`} className="text-base font-semibold text-arbr-charcoal hover:text-arbr-green-700 hover:underline truncate block">
            {app}
          </Link>
          <div className="mt-1">{statusBadge(isKilled, neverUsed)}</div>
        </div>
        <Toggle checked={isActive} onChange={() => onToggleKill(app, !isKilled)} label="connected" />
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="label">Requests</div>
          <div className="font-semibold text-arbr-charcoal">{stats ? fmt.num(stats.requests) : "—"}</div>
        </div>
        <div>
          <div className="label">Cost</div>
          <div className="font-semibold text-arbr-charcoal">{stats ? fmt.usd(stats.cost) : "—"}</div>
        </div>
        <div>
          <div className="label">Success</div>
          <div className={`font-semibold ${stats?.failures > 0 ? "text-red-600" : "text-arbr-charcoal"}`}>{successRate}</div>
        </div>
        <div>
          <div className="label">Avg latency</div>
          <div className="font-semibold text-arbr-charcoal">{stats ? fmt.ms(stats.avgLatency) : "—"}</div>
        </div>
      </div>

      <Link to={`/applications/${encodeURIComponent(app)}`} className="mt-auto text-xs text-arbr-green-600 hover:underline self-start">
        View details →
      </Link>
    </div>
  );
}

// ── list view ─────────────────────────────────────────────────────────────────

function AppRow({ app, stats, config, onToggleKill }) {
  const isKilled = config?.killSwitchEnabled ?? false;
  const isActive = !isKilled;
  const neverUsed = !stats || stats.requests === 0;
  const successRate = stats && stats.requests > 0
    ? (((stats.requests - (stats.failures || 0)) / stats.requests) * 100).toFixed(1) + "%"
    : "—";

  return (
    <tr className={`border-b border-gray-100 last:border-0 transition-colors hover:bg-gray-50/60 ${isKilled ? "bg-red-50/20" : neverUsed ? "bg-gray-50/30" : ""}`}>
      <td className="py-3 pl-4 pr-3">
        <Link to={`/applications/${encodeURIComponent(app)}`} className="font-medium text-arbr-charcoal hover:text-arbr-green-700 hover:underline">
          {app}
        </Link>
      </td>
      <td className="py-3 px-3">{statusBadge(isKilled, neverUsed)}</td>
      <td className="py-3 px-3 text-sm text-arbr-charcoal tabular-nums">{stats ? fmt.num(stats.requests) : "—"}</td>
      <td className="py-3 px-3 text-sm text-arbr-charcoal tabular-nums">{stats ? fmt.usd(stats.cost) : "—"}</td>
      <td className={`py-3 px-3 text-sm tabular-nums ${stats?.failures > 0 ? "text-red-600 font-medium" : "text-arbr-charcoal"}`}>{successRate}</td>
      <td className="py-3 px-3 text-sm text-arbr-charcoal tabular-nums">{stats ? fmt.ms(stats.avgLatency) : "—"}</td>
      <td className="py-3 pl-3 pr-4">
        <div className="flex items-center justify-end gap-3">
          <Link to={`/applications/${encodeURIComponent(app)}`} className="text-xs text-arbr-green-600 hover:underline whitespace-nowrap">
            View →
          </Link>
          <Toggle checked={isActive} onChange={() => onToggleKill(app, !isKilled)} label="connected" />
        </div>
      </td>
    </tr>
  );
}

function AppTable({ apps, statsMap, configMap, onToggleKill, label }) {
  return (
    <div className="space-y-2">
      {label && (
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-gray-600">{label}</h2>
          <span className="text-xs text-gray-400">— key created, no requests yet</span>
        </div>
      )}
      <div className="card overflow-hidden p-0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50/60">
              <th className="py-2.5 pl-4 pr-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Application</th>
              <th className="py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Status</th>
              <th className="py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Requests</th>
              <th className="py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Cost</th>
              <th className="py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Success</th>
              <th className="py-2.5 px-3 text-xs font-medium text-gray-500 uppercase tracking-wide">Avg latency</th>
              <th className="py-2.5 pl-3 pr-4" />
            </tr>
          </thead>
          <tbody>
            {apps.map((app) => (
              <AppRow
                key={app}
                app={app}
                stats={statsMap[app] || null}
                config={configMap[app] || null}
                onToggleKill={onToggleKill}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── view toggle button ────────────────────────────────────────────────────────

function ViewToggle({ view, onChange }) {
  return (
    <div className="inline-flex items-center rounded-md border border-gray-200 bg-gray-50 p-0.5 gap-0.5">
      <button
        onClick={() => onChange("card")}
        className={`inline-flex items-center rounded px-2 py-1.5 transition-colors ${view === "card" ? "bg-white shadow-sm text-arbr-charcoal" : "text-gray-400 hover:text-gray-600"}`}
        title="Card view"
      >
        <IconGrid />
      </button>
      <button
        onClick={() => onChange("list")}
        className={`inline-flex items-center rounded px-2 py-1.5 transition-colors ${view === "list" ? "bg-white shadow-sm text-arbr-charcoal" : "text-gray-400 hover:text-gray-600"}`}
        title="List view"
      >
        <IconList />
      </button>
    </div>
  );
}

// ── page ─────────────────────────────────────────────────────────────────────

export default function Applications() {
  const [apps, setApps] = useState(null);
  const [newApps, setNewApps] = useState([]);
  const [statsMap, setStatsMap] = useState({});
  const [configMap, setConfigMap] = useState({});
  const [view, setView] = useState(() => localStorage.getItem("arbr:apps:view") || "card");
  const [err, setErr] = useState(null);

  const load = () => {
    Promise.all([
      api.facets(),
      api.by("application"),
      api.appConfigs(),
    ])
      .then(([facets, byApp, configs]) => {
        setApps(facets.applications || []);
        setNewApps(facets.newApplications || []);
        const sm = {};
        (byApp || []).forEach((row) => { sm[row.key] = row; });
        setStatsMap(sm);
        const cm = {};
        (configs || []).forEach((c) => { cm[c.applicationName] = c; });
        setConfigMap(cm);
      })
      .catch((e) => setErr(e.message));
  };

  useEffect(() => { load(); }, []);

  const changeView = (v) => {
    setView(v);
    localStorage.setItem("arbr:apps:view", v);
  };

  const toggleKill = async (appName, enabled) => {
    try {
      const cfg = await api.setAppConfig(appName, { killSwitchEnabled: enabled });
      setConfigMap((m) => ({ ...m, [appName]: cfg }));
    } catch (e) {
      setErr(e.message);
    }
  };

  if (err) return <div className="text-red-600">{err}</div>;

  const hasAny = apps !== null && (apps.length > 0 || newApps.length > 0);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-arbr-charcoal">Applications</h1>
          <p className="text-sm text-gray-500">Per-application traffic overview and controls.</p>
        </div>
        {hasAny && <ViewToggle view={view} onChange={changeView} />}
      </div>

      {apps === null ? (
        <Spinner />
      ) : !hasAny ? (
        <div className="card p-10 text-center">
          <div className="text-sm text-gray-500">No applications seen yet.</div>
          <div className="mt-1 text-xs text-gray-400">Apps appear here as they make requests through the gateway.</div>
        </div>
      ) : (
        <div className="space-y-8">
          {apps.length > 0 && (
            view === "card" ? (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                {apps.map((app) => (
                  <AppCard key={app} app={app} stats={statsMap[app] || null} config={configMap[app] || null} onToggleKill={toggleKill} />
                ))}
              </div>
            ) : (
              <AppTable apps={apps} statsMap={statsMap} configMap={configMap} onToggleKill={toggleKill} />
            )
          )}

          {newApps.length > 0 && (
            view === "card" ? (
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <h2 className="text-sm font-semibold text-gray-600">Newly added</h2>
                  <span className="text-xs text-gray-400">— key created, no requests yet</span>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {newApps.map((app) => (
                    <AppCard key={app} app={app} stats={null} config={configMap[app] || null} onToggleKill={toggleKill} />
                  ))}
                </div>
              </div>
            ) : (
              <AppTable
                apps={newApps}
                statsMap={statsMap}
                configMap={configMap}
                onToggleKill={toggleKill}
                label="Newly added"
              />
            )
          )}
        </div>
      )}
    </div>
  );
}
