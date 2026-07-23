"use strict";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function money(n) {
  return `$${Number(n).toFixed(2)}`;
}

function pct(n) {
  return `${Math.round(n)}%`;
}

// Renders a single self-contained HTML file — no external fonts, scripts, or
// stylesheets, so it opens correctly offline and is safe to send as a standalone
// attachment. Uses the same design-token pattern (paper/ink/amber/blue, light+dark
// via prefers-color-scheme) as Arbr's other shareable reports, scoped to system fonts
// to keep this package small and independent of network access at render time.
function renderReport(result, opts = {}) {
  const { totalRequests, totalCost, recommendations, flaggedCost, flaggedSavings, overusePct } = result;
  const generatedAt = opts.generatedAt || new Date();

  const rows = recommendations.map((r) => `
    <tr>
      <td>${esc(r.taskType)}</td>
      <td class="num">${esc(r.currentModel)} <span class="arrow">&#8594;</span> ${esc(r.suggestedModel)}</td>
      <td class="num">${r.requestCount.toLocaleString()}</td>
      <td class="num">${money(r.currentCost)}</td>
      <td class="num tone-amber">${money(r.projectedSavings)}</td>
    </tr>`).join("");

  const emptyState = recommendations.length === 0
    ? `<p class="empty">No premium-model overuse found in this log — either the traffic is already
       well-routed, or there isn't enough volume yet in any one (task type, model) group to be sure
       (each group needs at least ${result.minRequests || 20} requests before it's flagged).</p>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arbr Audit Report</title>
<style>
  :root {
    --paper: #EEF0F3; --surface: #FFFFFF; --ink: #14171C; --ink-soft: #3B404A;
    --muted: #6B7280; --line: rgba(20,23,28,0.13);
    --amber: #B36A16; --amber-bg: #F6E6D0; --blue: #2F6FA6;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #12141A; --surface: #1A1D24; --ink: #EDEEF2; --ink-soft: #C7CBD4;
      --muted: #8B93A3; --line: rgba(231,233,238,0.14);
      --amber: #E9A23B; --amber-bg: #3A2E19; --blue: #7FB0DE;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.5;
  }
  .num { font-family: ui-monospace, "SFMono-Regular", "Roboto Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .page { max-width: 760px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
  .eyebrow { font-size: 0.72rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); margin: 0 0 0.6rem; }
  h1 { font-size: clamp(1.6rem, 4vw, 2.1rem); margin: 0 0 2rem; letter-spacing: -0.01em; }
  .stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); margin-bottom: 2.2rem; }
  .stat { background: var(--surface); padding: 1rem 1.1rem; }
  .stat-value { font-size: 1.35rem; font-weight: 700; }
  .stat-value.tone-amber { color: var(--amber); }
  .stat-label { font-size: 0.76rem; color: var(--muted); margin-top: 0.25rem; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); }
  th, td { text-align: left; padding: 0.65rem 0.8rem; border-top: 1px solid var(--line); font-size: 0.88rem; }
  th { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); border-top: none; }
  .arrow { color: var(--muted); }
  .tone-amber { color: var(--amber); font-weight: 600; }
  .empty { color: var(--ink-soft); background: var(--surface); border: 1px solid var(--line); padding: 1rem 1.2rem; }
  footer { margin-top: 2rem; font-size: 0.78rem; color: var(--muted); border-top: 1px solid var(--line); padding-top: 1rem; }
  .overflow { overflow-x: auto; }
</style>
</head>
<body>
<div class="page">
  <p class="eyebrow">Arbr Audit</p>
  <h1>Where your LLM spend is going, and what it could cost instead</h1>

  <div class="stat-row">
    <div class="stat">
      <div class="stat-value num">${totalRequests.toLocaleString()}</div>
      <div class="stat-label">requests analyzed</div>
    </div>
    <div class="stat">
      <div class="stat-value num">${money(totalCost)}</div>
      <div class="stat-label">total spend in this log</div>
    </div>
    <div class="stat">
      <div class="stat-value num tone-amber">${money(flaggedSavings)}</div>
      <div class="stat-label">projected savings found (${pct(overusePct)} of spend)</div>
    </div>
  </div>

  ${emptyState}
  ${recommendations.length > 0 ? `
  <div class="overflow">
    <table>
      <thead>
        <tr><th>Task type</th><th>Model</th><th>Requests</th><th>Current cost</th><th>Projected saving</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>` : ""}

  <footer>
    Generated by <span class="num">arbr audit</span> on ${esc(generatedAt.toISOString().slice(0, 10))}.
    Flags compare task type and model tier against a static price table, not answer quality —
    verify a suggested downgrade against your own traffic before switching.
  </footer>
</div>
</body>
</html>`;
}

module.exports = { renderReport };
