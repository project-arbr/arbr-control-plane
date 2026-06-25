import React, { useEffect, useState } from "react";
import { api } from "../api.js";
import { Card, Toggle } from "../components/ui.jsx";

export default function Governance() {
  const [gov, setGov]       = useState(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState(null);
  const [ok, setOk]         = useState(false);

  useEffect(() => {
    api.governance().then(setGov).catch((e) => setErr(e.message));
  }, []);

  const save = async () => {
    setErr(null); setOk(false); setSaving(true);
    try {
      const saved = await api.updateGovernance(gov);
      setGov(saved); setOk(true); setTimeout(() => setOk(false), 2500);
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gyde-charcoal">Governance</h1>
        <p className="text-sm text-gray-500">
          Safety controls, data lifecycle, and alerting for responsible AI usage.
        </p>
      </div>

      {!gov ? (
        <div className="py-8 text-center text-sm text-gray-400">Loading…</div>
      ) : (
        <>
          <Card title="Maintenance mode">
            <p className="mb-4 text-sm text-gray-600">
              When enabled, all AI gateway requests (<code className="rounded bg-gray-100 px-1">/v1/*</code>)
              are rejected with 503. Use this to suspend all LLM calls during incidents or planned maintenance.
            </p>
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-gyde-charcoal">Enable maintenance mode</div>
                  <div className="mt-0.5 text-xs text-gray-500">All gateway calls return 503 while this is on.</div>
                </div>
                <Toggle
                  checked={!!gov.maintenanceMode?.enabled}
                  onChange={(v) => setGov({ ...gov, maintenanceMode: { ...gov.maintenanceMode, enabled: v } })}
                  label="maintenance mode"
                />
              </div>
              <div>
                <div className="label mb-1">Message shown to callers</div>
                <input
                  className="input w-full max-w-lg"
                  value={gov.maintenanceMode?.message || ""}
                  onChange={(e) => setGov({ ...gov, maintenanceMode: { ...gov.maintenanceMode, message: e.target.value } })}
                  placeholder="Service temporarily unavailable for maintenance."
                />
              </div>
            </div>
          </Card>

          <Card title="Token guardrail">
            <p className="mb-4 text-sm text-gray-600">
              Hard cap on <code className="rounded bg-gray-100 px-1">max_tokens</code> per request.
              Requests that exceed the limit are silently clamped. Leave blank to disable.
            </p>
            <div>
              <div className="label mb-1">Global max tokens</div>
              <input
                className="input w-40"
                type="number"
                min="1"
                placeholder="unlimited"
                value={gov.maxTokensGuardrail || ""}
                onChange={(e) => setGov({ ...gov, maxTokensGuardrail: e.target.value ? Number(e.target.value) : null })}
              />
            </div>
          </Card>

          <Card title="Webhook notifications">
            <p className="mb-4 text-sm text-gray-600">
              POST alerts to your endpoint when a budget cap is first breached. Deliveries are
              deduplicated — at most one notification per event per 5 minutes.
            </p>
            <div>
              <div className="label mb-1">Webhook URL</div>
              <input
                className="input w-full max-w-lg"
                type="url"
                placeholder="https://your-endpoint.example.com/arbr-alerts"
                value={gov.webhookUrl || ""}
                onChange={(e) => setGov({ ...gov, webhookUrl: e.target.value || null })}
              />
            </div>
          </Card>

          <Card title="Data retention">
            <p className="mb-4 text-sm text-gray-600">
              Request records are automatically deleted after this many days. Set to 0 to keep records indefinitely.
            </p>
            <div>
              <div className="label mb-1">Retention (days)</div>
              <input
                className="input w-32"
                type="number"
                min="0"
                placeholder="90"
                value={gov.retentionDays ?? ""}
                onChange={(e) => setGov({ ...gov, retentionDays: e.target.value !== "" ? Number(e.target.value) : null })}
              />
              <div className="mt-1 text-xs text-gray-400">Default: 90 days. Purge runs daily.</div>
            </div>
          </Card>

          <Card title="PII masking">
            <p className="mb-4 text-sm text-gray-600">
              Scan message text for common PII patterns (credit card numbers, Aadhaar, email, phone) and
              replace matches with <code className="rounded bg-gray-100 px-1">[REDACTED]</code> before
              storing request records. The original text is still sent to the AI model — only the audit
              trail is masked.
            </p>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium text-gyde-charcoal">Enable PII masking in logs</div>
                <div className="mt-0.5 text-xs text-gray-500">
                  Applies to: credit card, SSN, Aadhaar, email addresses, phone numbers.
                </div>
              </div>
              <Toggle
                checked={!!gov.piiMaskingEnabled}
                onChange={(v) => setGov({ ...gov, piiMaskingEnabled: v })}
                label="PII masking"
              />
            </div>
          </Card>

          <div className="flex items-center gap-3">
            <button className="btn-secondary" disabled={saving} onClick={save}>
              {saving ? "Saving…" : "Save"}
            </button>
            {ok  && <span className="text-sm text-gyde-green-600">Saved.</span>}
            {err && <span className="text-sm text-red-600">{err}</span>}
          </div>
        </>
      )}
    </div>
  );
}
