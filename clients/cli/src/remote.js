"use strict";

// Fetches request records directly from a running Arbr instance's own export API
// (GET /api/requests/export — unbounded, cursor-streamed CSV, admin-key gated) so
// `arbr audit` can point at a live deployment without a manual mongoexport step.
// This reuses an endpoint Arbr's own admin dashboard already exposes; nothing here
// is a new server-side capability, just a client for an existing one.

// Minimal CSV parser: handles quoted fields, embedded commas, and "" as an escaped
// quote within a quoted field (RFC4180-ish). Does NOT handle newlines embedded
// inside a quoted field — acceptable here because /api/requests/export's fixed
// column set is ids/enums/numbers/ISO timestamps, never free text (messages and
// responseText are excluded from the export specifically).
function parseCsvLine(line) {
  const fields = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  fields.push(cur);
  return fields;
}

function parseCsv(text) {
  const lines = text.split(/\r\n|\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const values = parseCsvLine(line);
    const row = {};
    header.forEach((h, i) => { row[h] = values[i]; });
    return row;
  });
}

// baseUrl: e.g. "https://arbr.gyde.ai". adminKey: sent as `Authorization: Bearer`,
// the same transport Arbr's own dashboard uses (server/src/api/authUtil.js).
// opts.from / opts.to: optional ISO date strings, forwarded as query params to
// avoid pulling a long-running instance's entire history unbounded by default.
async function fetchRemoteRecords(baseUrl, adminKey, opts = {}) {
  const url = new URL("/api/requests/export", baseUrl);
  if (opts.from) url.searchParams.set("from", opts.from);
  if (opts.to) url.searchParams.set("to", opts.to);

  const headers = {};
  if (adminKey) headers.authorization = `Bearer ${adminKey}`;

  let res;
  try {
    res = await fetch(url, { headers });
  } catch (err) {
    throw new Error(`could not reach ${url.origin}: ${err.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${url} returned ${res.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
  }

  const csv = await res.text();
  const rows = parseCsv(csv);

  // Coerce numeric columns; everything else (taskType, model, provider, ...) stays
  // a string, matching what audit.js's aggregateGroups already expects.
  return rows.map((r) => ({
    ...r,
    promptTokens: Number(r.promptTokens) || 0,
    completionTokens: Number(r.completionTokens) || 0,
    totalCost: Number(r.totalCost) || 0,
  }));
}

module.exports = { parseCsv, fetchRemoteRecords };
