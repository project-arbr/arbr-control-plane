import React, { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { api, fmt } from "../api.js";
import { Card, Toggle, Badge, Table, Spinner, Tabs, useTabParam } from "../components/ui.jsx";

const TABS = [
  ["guardrails",       "Guardrails"],
  ["observability",    "Observability"],
  ["general",         "General Settings"],
];

// ── Shared save helpers ────────────────────────────────────────────────────────

function SaveRow({ saving, ok, err }) {
  return (
    <div className="mt-4 flex items-center gap-3 border-t border-gray-100 pt-4">
      <button className="btn-secondary text-sm" type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </button>
      {ok  && <span className="text-sm text-arbr-green-600">Saved.</span>}
      {err && <span className="text-sm text-red-600">{err}</span>}
    </div>
  );
}

function SettingRow({ label, sub, children }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="flex-1">
        <div className="text-sm font-medium text-arbr-charcoal">{label}</div>
        {sub && <div className="mt-0.5 text-xs text-gray-500">{sub}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

// ── Guardrails tab ─────────────────────────────────────────────────────────────

function OutputGuardrailsCard({ gov, setGov, save, saving, ok, err }) {
  const [apps, setApps]             = useState([]);
  const [newName, setNewName]       = useState("");
  const [newPattern, setNewPattern] = useState("");
  const [newApp, setNewApp]         = useState("*");
  const [patternErr, setPatternErr] = useState("");

  useEffect(() => {
    api.facets().then((f) => setApps(f.applications || [])).catch(() => {});
  }, []);

  function validatePattern(val) {
    try { new RegExp(val); setPatternErr(""); return true; }
    catch { setPatternErr("Invalid regular expression"); return false; }
  }

  function addRule() {
    if (!newPattern) return;
    if (!validatePattern(newPattern)) return;
    setGov({
      ...gov,
      outputGuardrailRules: [
        ...(gov.outputGuardrailRules || []),
        { name: newName || newPattern, pattern: newPattern, application: newApp || "*" },
      ],
    });
    setNewName(""); setNewPattern(""); setNewApp("*"); setPatternErr("");
  }

  function updateRule(i, field, value) {
    const updated = [...gov.outputGuardrailRules];
    updated[i] = { ...updated[i], [field]: value };
    setGov({ ...gov, outputGuardrailRules: updated });
  }

  function removeRule(i) {
    setGov({ ...gov, outputGuardrailRules: gov.outputGuardrailRules.filter((_, j) => j !== i) });
  }

  const AppSelect = ({ value, onChange }) => (
    <select className="input w-40 text-xs" value={value || "*"} onChange={(e) => onChange(e.target.value)}>
      <option value="*">All applications</option>
      {apps.map((a) => <option key={a} value={a}>{a}</option>)}
    </select>
  );

  return (
    <Card title="Output Guardrails">
      <div className="divide-y divide-gray-100">
        <SettingRow
          label="Block responses matching deny-list rules"
          sub="Applied to every model response before it is returned to the caller. Fires a 422 guardrail_violation error with the matched rule name."
        >
          <Toggle
            checked={!!gov.outputGuardrailsEnabled}
            onChange={(v) => setGov({ ...gov, outputGuardrailsEnabled: v })}
            label="output guardrails"
          />
        </SettingRow>

        <div className="py-3">
          <div className="label mb-2">Deny-list rules</div>
          {(gov.outputGuardrailRules || []).length === 0 && (
            <p className="mb-2 text-xs text-gray-400">No rules yet. Add a keyword or regex pattern below.</p>
          )}

          {/* Column headers */}
          {(gov.outputGuardrailRules || []).length > 0 && (
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium text-gray-400">
              <span className="w-32">Name</span>
              <span className="flex-1">Pattern / keyword</span>
              <span className="w-40">Application</span>
              <span className="w-14" />
            </div>
          )}

          <div className="space-y-2">
            {(gov.outputGuardrailRules || []).map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  className="input w-32 text-xs"
                  placeholder="Rule name"
                  value={r.name || ""}
                  onChange={(e) => updateRule(i, "name", e.target.value)}
                />
                <input
                  className="input flex-1 font-mono text-xs"
                  placeholder="keyword or regex"
                  value={r.pattern || ""}
                  onChange={(e) => updateRule(i, "pattern", e.target.value)}
                />
                <AppSelect value={r.application} onChange={(v) => updateRule(i, "application", v)} />
                <button
                  type="button"
                  className="btn-ghost text-xs text-red-500 hover:text-red-700 w-14"
                  onClick={() => removeRule(i)}
                >
                  Remove
                </button>
              </div>
            ))}

            {/* Add new rule row */}
            <div className="flex items-start gap-2 pt-2 border-t border-gray-100">
              <input
                className="input w-32 text-xs"
                placeholder="Rule name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <div className="w-48 shrink">
                <input
                  className={`input w-full font-mono text-xs ${patternErr ? "border-red-400" : ""}`}
                  placeholder="keyword or regex"
                  value={newPattern}
                  onChange={(e) => { setNewPattern(e.target.value); if (patternErr) validatePattern(e.target.value); }}
                />
                {patternErr && <div className="mt-0.5 text-xs text-red-500">{patternErr}</div>}
              </div>
              <AppSelect value={newApp} onChange={setNewApp} />
              <button
                type="button"
                className="btn-outline text-xs shrink-0 whitespace-nowrap px-3"
                onClick={addRule}
                disabled={!newPattern}
              >
                + Add
              </button>
            </div>
          </div>
          <div className="mt-2 text-xs text-gray-400">
            Rules are tested case-insensitively in order. Plain keywords and JavaScript-compatible regular expressions are both supported.
          </div>
        </div>

        <SettingRow
          label="Mask PII in responses"
          sub="Redacts PII (credit card, SSN, Aadhaar, email, phone + custom patterns) from the text returned to callers — not just stored logs."
        >
          <Toggle
            checked={!!gov.maskPiiInResponses}
            onChange={(v) => setGov({ ...gov, maskPiiInResponses: v })}
            label="PII response masking"
          />
        </SettingRow>
      </div>
      <form onSubmit={(e) => { e.preventDefault(); save({ outputGuardrailsEnabled: gov.outputGuardrailsEnabled, outputGuardrailRules: gov.outputGuardrailRules, maskPiiInResponses: gov.maskPiiInResponses }); }}>
        <SaveRow saving={saving} ok={ok} err={err} />
      </form>
    </Card>
  );
}

function GuardrailsTab({ gov, setGov, save, saving, ok, err }) {
  const isKilled = !!gov.maintenanceMode?.enabled;
  return (
    <div className="space-y-5">

      {/* Kill Switch */}
      <Card>
        <div className={`-mx-6 -mt-6 mb-4 rounded-t-lg px-6 py-3 ${isKilled ? "bg-red-50 border-b border-red-200" : "bg-gray-50 border-b border-gray-100"}`}>
          <div className="flex items-center gap-3">
            <span className={`inline-flex h-2 w-2 rounded-full ${isKilled ? "bg-red-500 animate-pulse" : "bg-arbr-green-500"}`} />
            <span className={`text-sm font-semibold ${isKilled ? "text-red-700" : "text-arbr-charcoal"}`}>
              {isKilled ? "Gateway halted — all /v1/* requests returning 503" : "Gateway active"}
            </span>
          </div>
        </div>

        <h3 className="mb-3 text-base font-semibold text-arbr-charcoal">Global Kill Switch</h3>
        <div className="divide-y divide-gray-100">
          <SettingRow
            label="Halt all gateway traffic"
            sub="Immediately returns 503 to every /v1/* request. Use during incidents or planned maintenance."
          >
            <Toggle
              checked={isKilled}
              onChange={(v) => setGov({ ...gov, maintenanceMode: { ...gov.maintenanceMode, enabled: v } })}
              label="maintenance mode"
            />
          </SettingRow>
          <div className="py-3">
            <div className="label mb-1">Message shown to callers</div>
            <input
              className="input w-full max-w-lg"
              value={gov.maintenanceMode?.message || ""}
              disabled={!isKilled}
              onChange={(e) => setGov({ ...gov, maintenanceMode: { ...gov.maintenanceMode, message: e.target.value } })}
              placeholder="Service temporarily unavailable for maintenance."
            />
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save("kill")({ maintenanceMode: gov.maintenanceMode }); }}>
          <SaveRow saving={saving.kill} ok={ok.kill} err={err.kill} />
        </form>
      </Card>

      {/* Request Limits */}
      <Card title="Request Limits">
        <div className="divide-y divide-gray-100">
          <div className="py-3">
            <div className="label mb-1">Max tokens per request</div>
            <input
              className="input w-40"
              type="number"
              min="1"
              placeholder="unlimited"
              value={gov.maxTokensGuardrail || ""}
              onChange={(e) => setGov({ ...gov, maxTokensGuardrail: e.target.value ? Number(e.target.value) : null })}
            />
            <div className="mt-1 text-xs text-gray-400">
              Requests exceeding this are silently clamped, not rejected.
            </div>
          </div>
          <div className="py-3">
            <div className="label mb-1">Global rate limit (requests / minute)</div>
            <input
              className="input w-40"
              type="number"
              min="1"
              placeholder="unlimited"
              value={gov.globalRpmGuardrail || ""}
              onChange={(e) => setGov({ ...gov, globalRpmGuardrail: e.target.value ? Number(e.target.value) : null })}
            />
            <div className="mt-1 text-xs text-gray-400">
              Shared ceiling across all API keys combined. Per-key limits are set in Settings → API Keys.
            </div>
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save("limits")({ maxTokensGuardrail: gov.maxTokensGuardrail, globalRpmGuardrail: gov.globalRpmGuardrail }); }}>
          <SaveRow saving={saving.limits} ok={ok.limits} err={err.limits} />
        </form>
      </Card>

      {/* Privacy & Content */}
      <Card title="Privacy & Content">
        <div className="divide-y divide-gray-100">
          <SettingRow
            label="Require API key authentication"
            sub="When off, unauthenticated requests are accepted from any caller."
          >
            <Toggle
              checked={!!gov.requireApiKey}
              onChange={(v) => setGov({ ...gov, requireApiKey: v })}
              label="require API key"
            />
          </SettingRow>

          <div className="py-3">
            <SettingRow
              label="Mask PII in stored logs"
              sub="Redacts common PII patterns before writing to MongoDB. The original text still reaches the AI model."
            >
              <Toggle
                checked={!!gov.piiMaskingEnabled}
                onChange={(v) => setGov({ ...gov, piiMaskingEnabled: v })}
                label="PII masking"
              />
            </SettingRow>
            {gov.piiMaskingEnabled && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {["Credit card", "SSN (US)", "Aadhaar", "Email", "Phone"].map((p) => (
                  <Badge key={p} tone="charcoal">{p}</Badge>
                ))}
                <span className="text-xs text-gray-400 self-center ml-1">built-in patterns</span>
              </div>
            )}
          </div>

          {/* Custom PII patterns */}
          <div className="py-3">
            <div className="label mb-2">Custom PII patterns</div>
            <div className="space-y-2">
              {(gov.customPiiPatterns || []).map((p, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    className="input w-32"
                    placeholder="Name"
                    value={p.name}
                    onChange={(e) => {
                      const updated = [...gov.customPiiPatterns];
                      updated[i] = { ...updated[i], name: e.target.value };
                      setGov({ ...gov, customPiiPatterns: updated });
                    }}
                  />
                  <input
                    className="input flex-1 font-mono text-xs"
                    placeholder="regex pattern"
                    value={p.pattern}
                    onChange={(e) => {
                      const updated = [...gov.customPiiPatterns];
                      updated[i] = { ...updated[i], pattern: e.target.value };
                      setGov({ ...gov, customPiiPatterns: updated });
                    }}
                  />
                  <button
                    type="button"
                    className="btn-ghost text-xs text-red-500 hover:text-red-700"
                    onClick={() => setGov({ ...gov, customPiiPatterns: gov.customPiiPatterns.filter((_, j) => j !== i) })}
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="btn-outline text-xs"
                onClick={() => setGov({ ...gov, customPiiPatterns: [...(gov.customPiiPatterns || []), { name: "", pattern: "" }] })}
              >
                + Add pattern
              </button>
            </div>
          </div>

          <div className="py-3">
            <SettingRow
              label="Store request & response payloads"
              sub={gov.captureRequestPayloads ? "Prompt and response text are stored in request logs." : "Payload text is NOT stored. Costs, latency, and routing metadata are always logged."}
            >
              <Toggle
                checked={gov.captureRequestPayloads !== false}
                onChange={(v) => setGov({ ...gov, captureRequestPayloads: v })}
                label="capture payloads"
              />
            </SettingRow>
            {gov.captureRequestPayloads === false && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
                Request and response text will not be saved. You cannot view prompt/response content in the Requests drilldown.
              </div>
            )}
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save("privacy")({ requireApiKey: gov.requireApiKey, piiMaskingEnabled: gov.piiMaskingEnabled, customPiiPatterns: gov.customPiiPatterns, captureRequestPayloads: gov.captureRequestPayloads }); }}>
          <SaveRow saving={saving.privacy} ok={ok.privacy} err={err.privacy} />
        </form>
      </Card>

      {/* Output Guardrails */}
      <OutputGuardrailsCard
        gov={gov} setGov={setGov}
        save={save("output")}
        saving={saving.output} ok={ok.output} err={err.output}
      />
    </div>
  );
}

// ── Observability tab ──────────────────────────────────────────────────────────

const ALERT_TONE = (rate) => rate > 10 ? "red" : rate > 2 ? "amber" : "green";

function ProviderHealthCard() {
  const [rows, setRows]     = useState(null);
  const [age, setAge]       = useState(0);
  const intervalRef = useRef(null);

  const load = () => {
    api.providerHealth()
      .then((r) => { setRows(r); setAge(0); })
      .catch(() => {});
  };

  useEffect(() => {
    load();
    intervalRef.current = setInterval(() => {
      setAge((a) => a + 1);
      if (age % 30 === 29) load(); // re-fetch every ~30s
    }, 1000);
    return () => clearInterval(intervalRef.current);
  }, []);

  // Simpler: just re-fetch every 30s
  useEffect(() => {
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);

  return (
    <Card title="Provider health (last 24h)">
      {rows === null ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="text-sm text-gray-400">No traffic in the last 24 hours.</p>
      ) : (
        <Table
          columns={[
            { key: "provider", header: "Provider", render: (r) => <span className="font-mono text-xs">{r.provider}</span> },
            { key: "total",    header: "Requests",  render: (r) => fmt.num(r.total) },
            { key: "errorRate", header: "Error rate", render: (r) => {
              const pct = ((r.errorRate || 0) * 100).toFixed(1);
              return <Badge tone={ALERT_TONE(parseFloat(pct))}>{pct}%</Badge>;
            }},
            { key: "avgLatencyMs", header: "Avg latency", render: (r) => fmt.ms(r.avgLatencyMs) },
            { key: "p50LatencyMs", header: "p50 latency", render: (r) => fmt.ms(r.p50LatencyMs) },
          ]}
          rows={rows}
        />
      )}
      <div className="mt-2 text-xs text-gray-400">Auto-refreshes every 30 s</div>
    </Card>
  );
}

const AUDIT_FILTERS = [
  ["", "All events"],
  ["governance", "Governance"],
  ["cap", "Budgets"],
  ["rule", "Rules"],
  ["key", "API Keys"],
  ["model", "Models"],
];

const ENTITY_TONE = {
  governance:    "amber",
  cap:           "red",
  rule:          "teal",
  key:           "indigo",
  model:         "violet",
  appConfig:     "charcoal",
  provider:      "green",
  recommendation:"gray",
};

function badgeTone(action = "") {
  const entity = action.split(".")[0];
  return ENTITY_TONE[entity] || "gray";
}

function RecentEventsCard() {
  const [items, setItems]   = useState(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    api.auditLog({ limit: 20 }).then((d) => setItems(d.items)).catch(() => setItems([]));
  }, []);

  const visible = filter
    ? (items || []).filter((e) => (e.action || "").startsWith(filter))
    : (items || []);

  return (
    <Card title="Recent admin events">
      <div className="mb-3 flex flex-wrap gap-1">
        {AUDIT_FILTERS.map(([key, label]) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
              filter === key
                ? "bg-arbr-charcoal text-white"
                : "border border-gray-200 text-gray-500 hover:border-gray-400 hover:text-arbr-charcoal"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {items === null ? (
        <Spinner />
      ) : visible.length === 0 ? (
        <p className="py-4 text-center text-sm text-gray-400">No events match.</p>
      ) : (
        <div className="divide-y divide-gray-100">
          {visible.slice(0, 15).map((e, i) => (
            <div key={i} className="flex items-start gap-3 py-2.5">
              <span className="w-28 shrink-0 font-mono text-[11px] text-gray-400">
                {fmt.date(e.timestamp)}
              </span>
              <Badge tone={badgeTone(e.action)}>{e.action}</Badge>
              {e.entityId && e.entityId !== "global" && (
                <span className="truncate font-mono text-xs text-gray-500">{e.entityId}</span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="mt-3 border-t border-gray-100 pt-3 text-right">
        <Link to="/audit" className="text-xs text-arbr-green-600 hover:underline">View full audit log →</Link>
      </div>
    </Card>
  );
}

function ObservabilityTab({ gov, setGov, save, saving, ok, err }) {
  return (
    <div className="space-y-5">

      {/* Log Retention */}
      <Card title="Log Retention">
        <div className="py-2">
          <div className="label mb-1">Request log retention (days)</div>
          <input
            className="input w-32"
            type="number"
            min="0"
            placeholder="90"
            value={gov.retentionDays ?? ""}
            onChange={(e) => setGov({ ...gov, retentionDays: e.target.value !== "" ? Number(e.target.value) : null })}
          />
          <div className="mt-1 text-xs text-gray-400">
            Set to 0 for indefinite retention. Purge runs nightly.
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save("retention")({ retentionDays: gov.retentionDays }); }}>
          <SaveRow saving={saving.retention} ok={ok.retention} err={err.retention} />
        </form>
      </Card>

      {/* Alerting & Webhooks */}
      <Card title="Alerting & Webhooks">
        <div className="divide-y divide-gray-100">
          <div className="py-3">
            <div className="label mb-1">Webhook URL</div>
            <input
              className="input w-full max-w-lg"
              type="url"
              placeholder="https://your-endpoint.example.com/arbr-alerts"
              value={gov.webhookUrl || ""}
              onChange={(e) => setGov({ ...gov, webhookUrl: e.target.value || null })}
            />
            <div className="mt-1 text-xs text-gray-400">
              POST alerts: budget cap breach · budget warning · error rate exceeded
            </div>
          </div>

          <div className="py-3 space-y-3">
            <SettingRow
              label="Error rate alerting"
              sub="Fire webhook when rolling 1-hour error rate exceeds threshold."
            >
              <Toggle
                checked={!!gov.alertErrorRateEnabled}
                onChange={(v) => setGov({ ...gov, alertErrorRateEnabled: v })}
                label="error rate alerting"
              />
            </SettingRow>
            {gov.alertErrorRateEnabled && (
              <div className="pl-1">
                <div className="label mb-1">Error rate threshold (%)</div>
                <div className="flex items-center gap-2">
                  <input
                    className="input w-24"
                    type="number"
                    min="0"
                    max="100"
                    step="0.5"
                    value={gov.alertErrorRateThreshold ?? 5}
                    onChange={(e) => setGov({ ...gov, alertErrorRateThreshold: Number(e.target.value) })}
                  />
                  <span className="text-sm text-gray-400">% failure rate over 1 h triggers alert</span>
                </div>
              </div>
            )}
          </div>

          <div className="py-3">
            <div className="label mb-2">Webhook payload example</div>
            <pre className="rounded-md border border-gray-200 bg-gray-900 p-3 font-mono text-[11px] text-gray-300 overflow-x-auto">{`{
  "event": "cap_breach",
  "dimension": "application",
  "value": "support-chat",
  "period": "day",
  "limit": 50.00,
  "spent": 52.41,
  "action": "block",
  "timestamp": "2026-07-01T14:00:00Z"
}`}</pre>
          </div>
        </div>
        <form onSubmit={(e) => { e.preventDefault(); save("alerts")({ webhookUrl: gov.webhookUrl, alertErrorRateEnabled: gov.alertErrorRateEnabled, alertErrorRateThreshold: gov.alertErrorRateThreshold }); }}>
          <SaveRow saving={saving.alerts} ok={ok.alerts} err={err.alerts} />
        </form>
      </Card>

      {/* Provider Health (live, no save) */}
      <ProviderHealthCard />

      {/* Recent admin events (live, no save) */}
      <RecentEventsCard />
    </div>
  );
}

// ── General Settings tab ───────────────────────────────────────────────────────

function SystemInfoCard() {
  const [about, setAbout]   = useState(null);
  const [status, setStatus] = useState(null);

  useEffect(() => {
    api.about().then(setAbout).catch(() => {});
    api.status().then(setStatus).catch(() => {});
  }, []);

  const rows = [
    { label: "Gateway version",  value: about?.version || "—" },
    { label: "Active providers", value: status?.liveProviders?.length != null ? fmt.num(status.liveProviders.length) : "—" },
    { label: "Default model",    value: status?.defaultModel || "—" },
    { label: "Routing mode",     value: status?.routingMode || "—",
      extra: <Link to="/routing" className="ml-2 text-xs text-arbr-green-600 hover:underline">Configure →</Link> },
  ];

  return (
    <Card title="System Information">
      {(!about && !status) ? <Spinner /> : (
        <dl className="divide-y divide-gray-100">
          {rows.map(({ label, value, extra }) => (
            <div key={label} className="flex items-center justify-between py-2.5">
              <dt className="text-sm text-gray-500">{label}</dt>
              <dd className="flex items-center font-mono text-sm text-arbr-charcoal">
                {value}{extra}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  );
}

function GeneralTab({ gov }) {
  return (
    <div className="space-y-5">
      <SystemInfoCard />

      <Card title="Data Export">
        <p className="mb-4 text-sm text-gray-500">
          Download complete logs for compliance, auditing, or offline analysis.
          {gov.retentionDays ? ` Available range: last ${gov.retentionDays} days.` : ""}
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            className="btn-outline text-sm"
            onClick={() => api.exportRequests({})}
          >
            Export request log (CSV)
          </button>
          <button
            className="btn-outline text-sm"
            onClick={() => api.exportAuditLog({})}
          >
            Export audit log (CSV)
          </button>
        </div>
      </Card>
    </div>
  );
}

// ── Root component ─────────────────────────────────────────────────────────────

export default function Governance() {
  const [gov, setGov]     = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [tab, setTab]     = useTabParam(TABS);

  // Per-card save state — each card saves independently
  const [saving, setSaving] = useState({});
  const [ok, setOk]         = useState({});
  const [err, setErr]       = useState({});

  useEffect(() => {
    api.governance().then(setGov).catch((e) => setLoadErr(e.message));
  }, []);

  const save = async (fields, key) => {
    setSaving((s) => ({ ...s, [key]: true }));
    setErr((e) => ({ ...e, [key]: null }));
    setOk((o) => ({ ...o, [key]: false }));
    try {
      const saved = await api.updateGovernance(fields);
      setGov((g) => ({ ...g, ...saved }));
      setOk((o) => ({ ...o, [key]: true }));
      setTimeout(() => setOk((o) => ({ ...o, [key]: false })), 2500);
    } catch (e) {
      setErr((er) => ({ ...er, [key]: e.message }));
    } finally {
      setSaving((s) => ({ ...s, [key]: false }));
    }
  };

  // Build save function factories keyed by card name
  const saveFor = (key) => (fields) => save(fields, key);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-arbr-charcoal">Governance</h1>
        <p className="text-sm text-gray-500">
          Safety guardrails, data controls, observability, and system configuration.
        </p>
      </div>

      {loadErr && <div className="text-red-600 text-sm">{loadErr}</div>}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />

      {!gov ? (
        <div className="py-12 text-center"><Spinner /></div>
      ) : (
        <>
          {tab === "guardrails" && (
            <GuardrailsTab
              gov={gov} setGov={setGov}
              save={saveFor}
              saving={{ kill: saving.kill, limits: saving.limits, privacy: saving.privacy, output: saving.output }}
              ok={{ kill: ok.kill, limits: ok.limits, privacy: ok.privacy, output: ok.output }}
              err={{ kill: err.kill, limits: err.limits, privacy: err.privacy, output: err.output }}
            />
          )}
          {tab === "observability" && (
            <ObservabilityTab
              gov={gov} setGov={setGov}
              save={saveFor}
              saving={{ retention: saving.retention, alerts: saving.alerts }}
              ok={{ retention: ok.retention, alerts: ok.alerts }}
              err={{ retention: err.retention, alerts: err.alerts }}
            />
          )}
          {tab === "general" && (
            <GeneralTab gov={gov} />
          )}
        </>
      )}
    </div>
  );
}
