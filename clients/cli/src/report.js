"use strict";

const fs = require("fs");
const path = require("path");

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

function fontDataUri(filename) {
  const buf = fs.readFileSync(path.join(__dirname, "..", "assets", "fonts", filename));
  return buf.toString("base64");
}

// The Arbr wordmark, inlined so the report never depends on loading an external
// image — outlined paths, no font dependency of its own (see assets/brand/BRAND.md).
// fill="currentColor" so it follows --ink automatically in both themes, matching
// how the wordmark SVGs already ship as ink-on-light / white-on-dark variants.
const WORDMARK_SVG = `<svg viewBox="0 0 554.65 131.4" fill="currentColor" role="img" aria-label="Arbr" style="height:1.1rem;width:auto;display:block">
  <polygon points="24.71 104.9 38.4 104.9 74.29 36.71 109.93 104.67 122.43 104.67 80.33 23.57 68.34 23.57 24.71 104.9"/>
  <path d="M177.89,104.94h11.37V33.67h36.36c8.97,0,16.25,7.27,16.25,16.25h0c0,8.97-7.27,16.25-16.25,16.25h-21.26l38.48,38.48h15.23l-28.26-29.23c13.38-2.58,23.7-11.71,23.42-27.24-.85-14.54-9.33-25.2-23.25-25.96h-51.84s-.25,82.73-.25,82.73Z"/>
  <path d="M380.49,61.21c12.4-9.94,10.89-26.07,2.88-33.09,0,0-4.07-5.09-13.91-5.85l-54.22-.21v82.69h54.22s23.59-.85,23.42-22.66c.37-10.31-3.91-17.15-12.39-20.88ZM326.42,33.79h39.53c6.38,0,11.54,5.17,11.54,11.54,0,3.19-1.29,6.07-3.38,8.16-2.09,2.09-4.98,3.38-8.16,3.38h-39.53v-23.08ZM378.35,89.62c-2.3,2.31-5.48,3.73-8.99,3.73h-42.93v-25.46h42.93c7.03,0,12.72,5.7,12.72,12.73,0,3.51-1.42,6.7-3.73,8.99Z"/>
  <path d="M449.76,104.94h11.37V33.67h36.36c8.97,0,16.25,7.27,16.25,16.25h0c0,8.97-7.27,16.25-16.25,16.25h-21.26l38.48,38.48h15.23l-28.26-29.23c13.38-2.58,23.7-11.71,23.42-27.24-.85-14.54-9.33-25.2-23.25-25.96h-51.84s-.25,82.73-.25,82.73Z"/>
</svg>`;

// Sums groups (whatever their taskType) down to one row per model — the bar-chart
// data both audit and wrap use, independent of whether task-based overuse detection
// ran at all.
function aggregateByModel(groups) {
  const byModel = new Map();
  for (const g of groups || []) {
    const key = g.model || "unknown";
    if (!byModel.has(key)) byModel.set(key, { model: key, requests: 0, cost: 0 });
    const m = byModel.get(key);
    m.requests += g.requests || 0;
    m.cost += g.currentCost || 0;
  }
  return [...byModel.values()].sort((a, b) => b.cost - a.cost);
}

function renderBars(byModel) {
  const max = Math.max(...byModel.map((m) => m.cost), 0.0001);
  return byModel.map((m) => `
    <div class="bar-row">
      <div class="bar-label">${esc(m.model)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max((m.cost / max) * 100, 2)}%"></div></div>
      <div class="bar-value">${money(m.cost)}</div>
    </div>`).join("");
}

// Renders a single self-contained HTML file — no external fonts, scripts, or
// stylesheets fetched at open time (Inter is embedded as a base64 woff2, read from
// this package's own assets/fonts/ at render time), so it opens correctly offline
// and is safe to send as a standalone attachment. Uses Arbr's actual brand tokens
// (assets/brand/BRAND.md: signal #2f37ff, ink #171817, paper #f3f2ed) rather than an
// ad-hoc palette, and the same typeface (Inter) already used to render Arbr's own
// social-preview card.
//
// opts.mode: "audit" (default) or "wrap" — wrap sessions never run task
// classification in v1, so they skip the recommendations table entirely (it would
// always be empty) and lead with the per-model bar chart instead, with copy that
// doesn't imply overuse detection was attempted.
function renderReport(result, opts = {}) {
  const { totalRequests, totalCost, recommendations, flaggedSavings, overusePct, groups } = result;
  const generatedAt = opts.generatedAt || new Date();
  const mode = opts.mode || "audit";
  const byModel = aggregateByModel(groups);

  const rows = recommendations.map((r) => `
    <tr>
      <td>${esc(r.taskType)}</td>
      <td>${esc(r.currentModel)} <span class="arrow">&#8594;</span> ${esc(r.suggestedModel)}</td>
      <td class="num">${r.requestCount.toLocaleString()}</td>
      <td class="num">${money(r.currentCost)}</td>
      <td class="num tone-signal">${money(r.projectedSavings)}</td>
    </tr>`).join("");

  const emptyState = mode === "audit" && recommendations.length === 0
    ? `<p class="empty">No premium-model overuse found in this log — either the traffic is already
       well-routed, or there isn't enough volume yet in any one (task type, model) group to be sure
       (each group needs at least ${result.minRequests || 20} requests before it's flagged).</p>`
    : "";

  const wrapNote = mode === "wrap"
    ? `<p class="empty">This session's traffic isn't task-classified, so it's reported by spend and
       model mix only — not per-task overuse. Run <strong>arbr audit</strong> on a
       task-labeled log for "switch model X&nbsp;&#8594;&nbsp;Y" recommendations.</p>`
    : "";

  const barsSection = byModel.length > 0 ? `
  <h2>Spend by model</h2>
  <div class="bars">${renderBars(byModel)}</div>` : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${mode === "wrap" ? "Arbr Wrap Report" : "Arbr Audit Report"}</title>
<style>
  @font-face {
    font-family: "Inter"; font-style: normal; font-weight: 400; font-display: swap;
    src: url(data:font/woff2;base64,${fontDataUri("inter-400.woff2")}) format("woff2");
  }
  @font-face {
    font-family: "Inter"; font-style: normal; font-weight: 600; font-display: swap;
    src: url(data:font/woff2;base64,${fontDataUri("inter-600.woff2")}) format("woff2");
  }
  @font-face {
    font-family: "Inter"; font-style: normal; font-weight: 700; font-display: swap;
    src: url(data:font/woff2;base64,${fontDataUri("inter-700.woff2")}) format("woff2");
  }

  :root {
    --paper: #F3F2ED; --surface: #FFFFFF; --ink: #171817; --ink-soft: rgba(23,24,23,0.72);
    --muted: rgba(23,24,23,0.55); --line: rgba(23,24,23,0.12);
    --signal: #2F37FF; --signal-soft: rgba(47,55,255,0.10);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --paper: #15161B; --surface: #1D1E24; --ink: #F3F2ED; --ink-soft: rgba(243,242,237,0.78);
      --muted: rgba(243,242,237,0.55); --line: rgba(243,242,237,0.14);
      --signal: #7B82FF; --signal-soft: rgba(123,130,255,0.16);
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--paper); color: var(--ink);
    font-family: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    line-height: 1.5;
  }
  .num { font-variant-numeric: tabular-nums; }
  .page { max-width: 780px; margin: 0 auto; padding: 3rem 1.5rem 4rem; }
  .brand { display: flex; align-items: center; gap: 0.6rem; color: var(--ink); margin-bottom: 1.8rem; }
  .brand .tag {
    font-size: 0.68rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    color: var(--signal); background: var(--signal-soft); padding: 0.2rem 0.5rem; border-radius: 3px;
  }
  h1 { font-size: clamp(1.7rem, 4vw, 2.3rem); font-weight: 700; margin: 0 0 2rem; letter-spacing: -0.015em; text-wrap: balance; }
  h2 { font-size: 0.78rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-soft); margin: 2.2rem 0 0.9rem; }
  .stat-row { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  .stat { background: var(--surface); padding: 1.2rem 1.2rem 1.1rem; }
  .stat-value { font-size: 1.7rem; font-weight: 700; letter-spacing: -0.01em; }
  .stat-value.tone-signal { color: var(--signal); }
  .stat-label { font-size: 0.78rem; color: var(--muted); margin-top: 0.3rem; }
  .bars { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 1.1rem 1.2rem; }
  .bar-row { display: grid; grid-template-columns: 9rem 1fr 4.5rem; align-items: center; gap: 0.8rem; padding: 0.5rem 0; }
  .bar-row + .bar-row { border-top: 1px solid var(--line); }
  .bar-label { font-size: 0.85rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { height: 8px; background: var(--signal-soft); border-radius: 4px; overflow: hidden; }
  .bar-fill { height: 100%; background: var(--signal); border-radius: 4px; }
  .bar-value { font-size: 0.85rem; font-weight: 600; text-align: right; }
  table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
  th, td { text-align: left; padding: 0.7rem 0.9rem; border-top: 1px solid var(--line); font-size: 0.87rem; }
  th { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; color: var(--muted); border-top: none; }
  .arrow { color: var(--muted); }
  .tone-signal { color: var(--signal); font-weight: 600; }
  .empty { color: var(--ink-soft); background: var(--surface); border: 1px solid var(--line); border-radius: 6px; padding: 1rem 1.2rem; font-size: 0.92rem; }
  footer { margin-top: 2.4rem; font-size: 0.78rem; color: var(--muted); border-top: 1px solid var(--line); padding-top: 1.1rem; }
  footer strong { color: var(--ink-soft); font-weight: 600; }
  .overflow { overflow-x: auto; }
</style>
</head>
<body>
<div class="page">
  <div class="brand">${WORDMARK_SVG}<span class="tag">${mode === "wrap" ? "Wrap" : "Audit"}</span></div>
  <h1>${mode === "wrap" ? "What this session cost, model by model" : "Where your LLM spend is going, and what it could cost instead"}</h1>

  <div class="stat-row">
    <div class="stat">
      <div class="stat-value num">${totalRequests.toLocaleString()}</div>
      <div class="stat-label">requests ${mode === "wrap" ? "this session" : "analyzed"}</div>
    </div>
    <div class="stat">
      <div class="stat-value num">${money(totalCost)}</div>
      <div class="stat-label">total spend ${mode === "wrap" ? "this session" : "in this log"}</div>
    </div>
    <div class="stat">
      ${mode === "wrap" ? `
      <div class="stat-value num">${byModel.length}</div>
      <div class="stat-label">models used this session</div>` : `
      <div class="stat-value num tone-signal">${money(flaggedSavings)}</div>
      <div class="stat-label">projected savings found (${pct(overusePct)} of spend)</div>`}
    </div>
  </div>

  ${barsSection}

  ${wrapNote}
  ${emptyState}
  ${recommendations.length > 0 ? `
  <h2>Flagged recommendations</h2>
  <div class="overflow">
    <table>
      <thead>
        <tr><th>Task type</th><th>Model</th><th>Requests</th><th>Current cost</th><th>Projected saving</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  </div>` : ""}

  <footer>
    Generated by <strong>arbr ${mode === "wrap" ? "wrap" : "audit"}</strong> on ${esc(generatedAt.toISOString().slice(0, 10))}.
    Flags compare task type and model tier against a static price table, not answer quality —
    verify a suggested downgrade against your own traffic before switching.
  </footer>
</div>
</body>
</html>`;
}

module.exports = { renderReport };
