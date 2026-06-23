// Fetches the latest LiveBench leaderboard CSV and writes benchmark-derived
// capability scores (0–1) into ModelEntry.capabilities in MongoDB.
//
// Dimensions mapping from LiveBench categories (0–100 scale → 0–1):
//   coding    = avg(average_coding, average_agentic_coding) / 100
//   reasoning = (0.7 × average_reasoning + 0.3 × average_math) / 100
//   writing   = average_instruction_following / 100
//   analysis  = avg(average_data_analysis, average_reasoning) / 100
//   language  = average_language / 100
//   general   = mean(all six averages) / 100
//   data      = average_data_analysis / 100
//
// Models not present in LiveBench are skipped (they fall back to the hardcoded
// MODEL_CAPABILITIES table in aiPolicy.js).

const ModelEntry = require("../models/ModelEntry");
const Settings   = require("../models/Settings");

// Known release dates in descending order. Used as fallback when GitHub API
// is unavailable. Extend this list when LiveBench publishes a new leaderboard.
const KNOWN_DATES = [
  "2026_01_08",
  "2025_12_23",
  "2025_11_25",
  "2025_05_30",
  "2025_04_25",
  "2025_04_02",
  "2024_11_25",
  "2024_08_31",
  "2024_07_26",
  "2024_06_24",
];

// Discover the latest available date by querying the LiveBench GitHub repo.
// Returns a date string like "2026_01_08" or null if the API is unreachable.
async function discoverLatestDate() {
  try {
    const res = await fetch(
      "https://api.github.com/repos/LiveBench/LiveBench/contents/",
      { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "arbr-control-plane" } }
    );
    if (!res.ok) return null;
    const files = await res.json();
    const dates = files
      .filter((f) => /^table_\d{4}_\d{2}_\d{2}\.csv$/.test(f.name))
      .map((f) => f.name.replace("table_", "").replace(".csv", ""))
      .sort()
      .reverse();
    return dates[0] || null;
  } catch {
    return null;
  }
}

// Download and parse the LiveBench CSV for a given date string ("YYYY_MM_DD").
// Returns { version, rows } or throws.
async function fetchCsv(date) {
  const url = `https://livebench.ai/table_${date}.csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`LiveBench CSV not available for ${date} (${res.status})`);
  const text = await res.text();
  const lines = text.trim().split("\n");
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map((line) => {
    const vals = line.split(",");
    return Object.fromEntries(headers.map((h, i) => [h, vals[i]?.trim().replace(/^"|"$/g, "")]));
  });
  return { version: date, rows };
}

// Normalize a model name for fuzzy matching:
//   - lowercase
//   - strip effort qualifiers (-low-effort, -medium-effort, -high-effort, -xhigh-effort)
//   - strip date patterns  (-YYYY-MM-DD  or  -MMDD at the end)
//   - strip common suffixes (-preview, -snapshot, -instruct, -v1, -v2, etc.)
function normalize(name) {
  return name
    .toLowerCase()
    .replace(/-(?:x?high|medium|low)-effort$/i, "")
    .replace(/-\d{4}-\d{2}-\d{2}$/, "")
    .replace(/-\d{4}$/, "")
    .replace(/-\d{2}-\d{2}$/, "")
    .replace(/-(?:preview|snapshot|instruct|v\d+)$/i, "")
    .replace(/-\d{8}$/, "")
    .trim();
}

// Map a LiveBench row's category averages to Arbr's 7 capability dimensions.
// All values normalized to 0–1; null fields are treated as 0 in calculations.
function toCapabilities(row) {
  const n = (col) => {
    const v = parseFloat(row[col]);
    return isFinite(v) ? v : 0;
  };

  const coding    = n("average_coding");
  const agCoding  = n("average_agentic_coding");
  const reasoning = n("average_reasoning");
  const math      = n("average_math");
  const dataAnal  = n("average_data_analysis");
  const language  = n("average_language");
  const instFollow= n("average_instruction_following");

  // Compute general as mean of the six primary categories.
  const categories = [coding, agCoding, reasoning, math, dataAnal, language, instFollow];
  const validCats  = categories.filter((v) => v > 0);
  const generalRaw = validCats.length ? validCats.reduce((a, b) => a + b, 0) / validCats.length : 0;

  const clamp = (v) => Math.min(1, Math.max(0, v));
  return {
    coding:    clamp((coding + agCoding) / 2 / 100),
    reasoning: clamp((0.7 * reasoning + 0.3 * math) / 100),
    writing:   clamp(instFollow / 100),
    analysis:  clamp((dataAnal + reasoning) / 2 / 100),
    language:  clamp(language / 100),
    general:   clamp(generalRaw / 100),
    data:      clamp(dataAnal / 100),
  };
}

// Main export — fetch and apply LiveBench scores to all ModelEntry documents.
async function run() {
  // 1. Discover latest CSV date.
  let version = await discoverLatestDate();
  let rows;
  let lastErr;

  if (version) {
    try { ({ rows } = await fetchCsv(version)); } catch (e) { lastErr = e; version = null; }
  }

  // Fall back through known dates until one works.
  if (!rows) {
    for (const date of KNOWN_DATES) {
      try { ({ version, rows } = await fetchCsv(date)); break; } catch (e) { lastErr = e; }
    }
  }

  if (!rows) throw lastErr || new Error("No LiveBench CSV could be fetched");

  // 2. Build a lookup: normalizedName → { capabilities, originalName }.
  const lbIndex = {};
  for (const row of rows) {
    const name = row.model || row[Object.keys(row)[0]];
    if (!name) continue;
    const key = normalize(name);
    // Keep the row with more non-zero category fields (some rows are subtotals).
    const caps = toCapabilities(row);
    if (!lbIndex[key] || Object.values(caps).filter(Boolean).length >
        Object.values(toCapabilities(lbIndex[key].row)).filter(Boolean).length) {
      lbIndex[key] = { caps, originalName: name, row };
    }
  }

  // 3. Match each ModelEntry to a LiveBench row.
  const models = await ModelEntry.find({}).lean();
  const now    = new Date();
  let matched  = 0;
  const skipped = [];

  for (const model of models) {
    const ourKey = normalize(model.id);

    // Try exact match first, then prefix-overlap.
    let entry = lbIndex[ourKey];
    if (!entry) {
      for (const [lbKey, lbEntry] of Object.entries(lbIndex)) {
        if (lbKey.startsWith(ourKey) || ourKey.startsWith(lbKey)) {
          entry = lbEntry;
          break;
        }
      }
    }

    if (!entry) { skipped.push(model.id); continue; }

    await ModelEntry.updateOne(
      { id: model.id },
      { $set: { capabilities: entry.caps, livebenchSyncedAt: now, livebenchModelName: entry.originalName } }
    );
    matched++;
  }

  // 4. Persist sync metadata.
  await Settings.findOneAndUpdate(
    { key: "global" },
    { $set: { livebenchSyncedAt: now, livebenchVersion: version } },
    { upsert: true }
  );

  console.log(`[livebench] synced ${matched}/${models.length} models from version ${version}`);
  return { matched, total: models.length, version, skipped };
}

module.exports = { run };
