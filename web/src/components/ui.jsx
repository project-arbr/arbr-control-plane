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
              ? "border-gyde-green-600 text-gyde-charcoal"
              : "border-transparent text-gray-500 hover:text-gyde-charcoal"
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
          {title && <h3 className="text-base font-semibold text-gyde-charcoal">{title}</h3>}
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
      <div className="mt-2 text-3xl font-bold text-gyde-charcoal">{value}</div>
      {sub && <div className="mt-1 text-sm text-gray-500">{sub}</div>}
    </div>
  );
}

const BADGE_TONES = {
  green: "bg-gyde-green-50 text-gyde-green-700 border-gyde-green-200",
  charcoal: "bg-gray-100 text-gyde-charcoal border-gray-200",
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

export function Table({ columns, rows, empty = "No data." }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 text-left">
            {columns.map((c) => (
              <th key={c.key} className="bg-gray-50 px-3 py-2 font-semibold text-gyde-charcoal first:rounded-tl-lg last:rounded-tr-lg">
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
              <tr key={i} className="border-b border-gray-100 hover:bg-gyde-green-50">
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
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${checked ? "bg-gyde-green-600" : "bg-gray-300"}`}
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
        className="absolute right-2 top-2 rounded-md border border-gray-200 bg-white px-2 py-0.5 text-xs text-gray-500 hover:border-gyde-green-600 hover:text-gyde-charcoal"
      >
        {copied ? "Copied" : "Copy"}
      </button>
      <pre className="overflow-x-auto rounded-lg border border-gray-200 bg-gray-900 px-4 pb-4 pt-7 text-xs leading-relaxed text-gray-100">
        <code>{code}</code>
      </pre>
    </div>
  );
}
