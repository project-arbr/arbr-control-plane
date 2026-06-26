import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, fmt } from "../api.js";
import { Spinner, Toggle } from "../components/ui.jsx";

function AppCard({ app, stats, config, onToggleKill }) {
  const isKilled = config?.killSwitchEnabled ?? false;
  const isActive = !isKilled;
  const successRate = stats && stats.requests > 0
    ? (((stats.requests - (stats.failures || 0)) / stats.requests) * 100).toFixed(1) + "%"
    : "—";

  return (
    <div className={`card flex flex-col gap-4 p-5 transition-all ${isKilled ? "border-red-200 bg-red-50/30" : ""}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link to={`/applications/${encodeURIComponent(app)}`} className="text-base font-semibold text-gyde-charcoal hover:text-gyde-green-700 hover:underline truncate block">
            {app}
          </Link>
          {isKilled ? (
            <span className="mt-1 inline-flex items-center rounded text-xs font-medium text-red-600 bg-red-100 px-1.5 py-0.5">
              Disconnected
            </span>
          ) : (
            <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-gyde-green-700">
              <span className="h-1.5 w-1.5 rounded-full bg-gyde-green-600 inline-block" />
              Active
            </span>
          )}
        </div>
        <Toggle
          checked={isActive}
          onChange={() => onToggleKill(app, !isKilled)}
          label="connected"
        />
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="label">Requests</div>
          <div className="font-semibold text-gyde-charcoal">{stats ? fmt.num(stats.requests) : "—"}</div>
        </div>
        <div>
          <div className="label">Cost</div>
          <div className="font-semibold text-gyde-charcoal">{stats ? fmt.usd(stats.cost) : "—"}</div>
        </div>
        <div>
          <div className="label">Success</div>
          <div className={`font-semibold ${stats?.failures > 0 ? "text-red-600" : "text-gyde-charcoal"}`}>{successRate}</div>
        </div>
        <div>
          <div className="label">Avg latency</div>
          <div className="font-semibold text-gyde-charcoal">{stats ? fmt.ms(stats.avgLatency) : "—"}</div>
        </div>
      </div>

      <Link
        to={`/applications/${encodeURIComponent(app)}`}
        className="mt-auto text-xs text-gyde-green-600 hover:underline self-start"
      >
        View details →
      </Link>
    </div>
  );
}

export default function Applications() {
  const [apps, setApps] = useState(null);
  const [statsMap, setStatsMap] = useState({});
  const [configMap, setConfigMap] = useState({});
  const [err, setErr] = useState(null);

  const load = () => {
    Promise.all([
      api.facets(),
      api.by("application"),
      api.appConfigs(),
    ])
      .then(([facets, byApp, configs]) => {
        setApps(facets.applications || []);
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

  const toggleKill = async (appName, enabled) => {
    try {
      const cfg = await api.setAppConfig(appName, { killSwitchEnabled: enabled });
      setConfigMap((m) => ({ ...m, [appName]: cfg }));
    } catch (e) {
      setErr(e.message);
    }
  };

  if (err) return <div className="text-red-600">{err}</div>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gyde-charcoal">Applications</h1>
        <p className="text-sm text-gray-500">Per-application traffic overview and controls. Apps appear as they generate requests.</p>
      </div>

      {apps === null ? (
        <Spinner />
      ) : apps.length === 0 ? (
        <div className="card p-10 text-center">
          <div className="text-sm text-gray-500">No applications seen yet.</div>
          <div className="mt-1 text-xs text-gray-400">Apps appear here as they make requests through the gateway.</div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {apps.map((app) => (
            <AppCard
              key={app}
              app={app}
              stats={statsMap[app] || null}
              config={configMap[app] || null}
              onToggleKill={toggleKill}
            />
          ))}
        </div>
      )}
    </div>
  );
}
