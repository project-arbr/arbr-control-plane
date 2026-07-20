// Admin API routes — sync
const express = require("express");
const aiPolicy = require("../../routing/aiPolicy");
const pricing = require("../../pricing/registry");
const Settings = require("../../models/Settings");

const router = express.Router();

// ── LiveBench benchmark score sync ───────────────────────────────────────────
router.post("/livebench/sync", async (_req, res, next) => {
  try {
    const result = await require("../../livebench/sync").run();
    await pricing.reload();
    aiPolicy.invalidate();
    res.json(result);
  } catch (e) { next(e); }
});

router.get("/livebench/status", async (_req, res, next) => {
  try {
    const s = await Settings.get();
    res.json({ syncedAt: s.livebenchSyncedAt || null, version: s.livebenchVersion || null });
  } catch (e) { next(e); }
});

// ── LMSYS Arena Elo sync ─────────────────────────────────────────────────────
router.post("/lmsys/sync", async (_req, res, next) => {
  try {
    const result = await require("../../lmsys/sync").run();
    await pricing.reload();
    aiPolicy.invalidate();
    res.json(result);
  } catch (e) { next(e); }
});

router.get("/lmsys/status", async (_req, res, next) => {
  try {
    const s = await Settings.get();
    res.json({ syncedAt: s.lmsysSyncedAt || null, version: s.lmsysVersion || null });
  } catch (e) { next(e); }
});

// ── LiteLLM pricing/spec sync ────────────────────────────────────────────────
router.post("/litellm/sync", async (_req, res, next) => {
  try {
    const result = await require("../../litellm/sync").run();
    await pricing.reload();
    res.json(result);
  } catch (e) { next(e); }
});

router.get("/litellm/status", async (_req, res, next) => {
  try {
    const s = await Settings.get();
    res.json({ syncedAt: s.litellmSyncedAt || null, version: s.litellmVersion || null });
  } catch (e) { next(e); }
});

// ── Consolidated benchmark + pricing sync (single-button flow) ────────────────
router.post("/benchmarks/sync", async (_req, res, next) => {
  try {
    // LiteLLM (pricing) runs first — no ordering dependency
    const lt = await require("../../litellm/sync").run().catch((e) => ({ error: e.message }));
    // LiveBench then LMSYS sequentially — LMSYS skips models LiveBench already covered
    const lb = await require("../../livebench/sync").run().catch((e) => ({ error: e.message }));
    const ls = await require("../../lmsys/sync").run().catch((e) => ({ error: e.message }));
    await pricing.reload();
    aiPolicy.invalidate();
    res.json({ litellm: lt, livebench: lb, lmsys: ls });
  } catch (e) { next(e); }
});

router.get("/benchmarks/status", async (_req, res, next) => {
  try {
    const s = await Settings.get();
    const dates = [s.livebenchSyncedAt, s.lmsysSyncedAt, s.litellmSyncedAt].filter(Boolean);
    const lastSyncedAt = dates.length ? new Date(Math.max(...dates.map((d) => new Date(d)))) : null;
    res.json({
      lastSyncedAt,
      livebench: { syncedAt: s.livebenchSyncedAt || null, version: s.livebenchVersion || null },
      lmsys:     { syncedAt: s.lmsysSyncedAt     || null, version: s.lmsysVersion     || null },
      litellm:   { syncedAt: s.litellmSyncedAt   || null, version: s.litellmVersion   || null },
    });
  } catch (e) { next(e); }
});


module.exports = router;
