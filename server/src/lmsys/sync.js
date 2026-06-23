// Fetches Elo ratings from the LMSYS Chatbot Arena leaderboard (via HuggingFace
// datasets server API) and writes a `general` capability score (0–1) for models
// that were NOT already covered by the LiveBench sync.
//
// Elo → 0-1: general = clamp((elo - 1000) / 500, 0, 1)
//   Elo 1000 → 0.0  (weak baseline)
//   Elo 1250 → 0.5  (mid-range)
//   Elo 1500 → 1.0  (top tier)
//
// Only writes capabilities.general — never overwrites other dimensions or
// models that already have livebenchSyncedAt set.

const ModelEntry                 = require("../models/ModelEntry");
const Settings                   = require("../models/Settings");
const { normalize, prefixMatch } = require("../livebench/normalize");

const HF_API_URL =
  "https://datasets-server.huggingface.co/rows" +
  "?dataset=lmarena-ai%2Fleaderboard-dataset&config=text&split=latest&offset=0&length=500";

async function fetchLeaderboard() {
  const res = await fetch(HF_API_URL, {
    headers: { "User-Agent": "arbr-control-plane" },
  });
  if (!res.ok) throw new Error(`LMSYS HuggingFace API returned ${res.status}`);
  const json = await res.json();
  // rows is an array of { row_idx, row: { model, rating, organization, ... } }
  return (json.rows || []).map((r) => r.row || r);
}

async function run() {
  const rows = await fetchLeaderboard();

  // Build lookup: normalizedName → { elo, originalName }
  const lbIndex = {};
  for (const row of rows) {
    const name = row.model || row.model_name;
    const elo  = parseFloat(row.rating || row.elo_rating);
    if (!name || !isFinite(elo)) continue;
    const key = normalize(name);
    // If a model appears multiple times keep the highest Elo (most recent usually wins)
    if (!lbIndex[key] || elo > lbIndex[key].elo) {
      lbIndex[key] = { elo, originalName: name };
    }
  }

  // Only update models that LiveBench hasn't covered yet
  const models = await ModelEntry.find({ livebenchSyncedAt: null }).lean();
  const now    = new Date();
  let matched  = 0;
  const skipped = [];

  for (const model of models) {
    const ourKey = normalize(model.id);

    let entry = lbIndex[ourKey];
    if (!entry) {
      for (const [lbKey, lbEntry] of Object.entries(lbIndex)) {
        if (prefixMatch(ourKey, lbKey)) { entry = lbEntry; break; }
      }
    }

    if (!entry) { skipped.push(model.id); continue; }

    const general = Math.min(1, Math.max(0, (entry.elo - 1000) / 500));

    await ModelEntry.updateOne(
      { id: model.id },
      {
        $set: {
          "capabilities.general": general,
          lmsysSyncedAt:          now,
          lmsysModelName:         entry.originalName,
        },
      }
    );
    matched++;
  }

  // Persist sync metadata
  const version = new Date().toISOString().slice(0, 10);
  await Settings.findOneAndUpdate(
    { key: "global" },
    { $set: { lmsysSyncedAt: now, lmsysVersion: version } },
    { upsert: true }
  );

  console.log(`[lmsys] synced ${matched}/${models.length} models (LiveBench-covered models skipped)`);
  return { matched, total: models.length, version, skipped };
}

module.exports = { run };
