import React from "react";
import { useSearchParams } from "react-router-dom";

// Underline sub-navigation. `tabs` is an array of [key, label]. Controlled.
export function Tabs({ tabs, active, onChange }) {
  return (
    <div className="flex gap-1 border-b border-gray-200">
      {tabs.map(([k, label]) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className={`-mb-px border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
            active === k
              ? "border-arbr-green-600 text-arbr-charcoal"
              : "border-transparent text-gray-500 hover:text-arbr-charcoal"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// Sub-tab state backed by the ?tab= query param, so deep links and redirects can
// target a specific sub-tab. Falls back to the first tab for unknown values.
export function useTabParam(tabs, defaultKey) {
  const [params, setParams] = useSearchParams();
  const keys = tabs.map(([k]) => k);
  const def = defaultKey || keys[0];
  const raw = params.get("tab");
  const active = keys.includes(raw) ? raw : def;
  const setActive = (k) => {
    const next = new URLSearchParams(params);
    if (k === def) next.delete("tab");
    else next.set("tab", k);
    setParams(next, { replace: true });
  };
  return [active, setActive];
}

export function Card({ title, action, children, className = "" }) {
  return (
    <div className={`card p-6 ${className}`}>
      {(title || action) && (
        <div className="mb-4 flex items-center justify-between">
          {title && <h3 className="text-base font-semibold text-arbr-charcoal">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

export function Stat({ label, value, sub }) {
  return (
    <div className="card p-6">
      <div className="label">{label}</div>
      <div className="mt-2 text-3xl font-bold text-arbr-charcoal">{value}</div>
      {sub && <div className="mt-1 text-sm text-gray-500">{sub}</div>}
    </div>
  );
}

const BADGE_TONES = {
  green: "bg-arbr-green-50 text-arbr-green-700 border-arbr-green-200",
  charcoal: "bg-gray-100 text-arbr-charcoal border-gray-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
  teal: "bg-teal-50 text-teal-700 border-teal-200",
  red: "bg-red-50 text-red-700 border-red-200",
  gray: "bg-gray-50 text-gray-500 border-gray-200",
};

export function Badge({ tone = "gray", children }) {
  return (
    <span className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${BADGE_TONES[tone] || BADGE_TONES.gray}`}>
      {children}
    </span>
  );
}

export function Table({ columns, rows, empty = "No data.", onRowClick }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left">
            {columns.map((c) => (
              <th key={c.key} className="bg-gray-50 px-3 py-2 font-semibold text-arbr-charcoal first:rounded-tl-lg last:rounded-tr-lg">
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={columns.length} className="px-3 py-8 text-center text-gray-400">{empty}</td></tr>
          ) : (
            rows.map((row, i) => (
              <tr key={i}
                className={`border-b border-gray-100 hover:bg-arbr-green-50${onRowClick ? " cursor-pointer" : ""}`}
                onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className="px-3 py-2 text-gray-700">
                    {c.render ? c.render(row) : row[c.key]}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? "bg-arbr-green-600" : "bg-gray-300"}`}
      aria-pressed={checked}
      aria-label={label}
    >
      <span className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}

export function Spinner() {
  return <div className="text-sm text-gray-400">Loading…</div>;
}

export function ConfirmDialog({ title, message, confirmLabel = "Confirm", onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-gray-200 bg-white p-6 shadow-xl">
        <h3 className="text-base font-semibold text-arbr-charcoal">{title}</h3>
        {message && <p className="mt-2 text-sm text-gray-500">{message}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button className="btn-ghost text-sm" onClick={onCancel}>Cancel</button>
          <button className="btn-secondary text-sm" onClick={onConfirm}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

// Right-side slide-over panel. Click the backdrop or Close to dismiss.
export function Drawer({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div
        className="h-full w-full max-w-2xl overflow-y-auto border-l border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 flex items-center justify-between border-b border-gray-200 bg-white px-5 py-3">
          <h3 className="text-base font-semibold text-arbr-charcoal">{title}</h3>
          <button className="btn-ghost text-sm" onClick={onClose}>Close</button>
        </div>
        <div className="space-y-4 p-5">{children}</div>
      </div>
    </div>
  );
}

export function CodeBlock({ code, lang }) {
  const [copied, setCopied] = React.useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard unavailable */ }
  };
  return (
    <div className="relative">
      {lang && <span className="absolute left-3 top-2 text-[10px] uppercase tracking-wide text-gray-400">{lang}</span>}
      <button
        onClick={copy}
        className="absolute right-2 top-2 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-500 hover:border-arbr-green-600 hover:text-arbr-charcoal"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="overflow-x-auto rounded-lg border border-gray-200 bg-gray-900 px-4 pb-4 pt-7 text-xs leading-relaxed text-gray-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}
