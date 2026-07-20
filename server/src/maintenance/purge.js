// Scheduled maintenance: purge RequestRecord documents older than the configured
// retention window. Runs once per day on startup via setInterval in index.js.
// Eval datasets/items/results copy prompt + response text out of request_records, so they are
// purged on the SAME retention window (EvalRun holds only aggregate numbers and is kept for audit).
const RequestRecord = require("../models/RequestRecord");
const EvalDataset = require("../models/EvalDataset");
const EvalItem = require("../models/EvalItem");
const EvalResult = require("../models/EvalResult");
const Settings = require("../models/Settings");

async function purgeOldRecords() {
  try {
    const settings = await Settings.get();
    const days = settings.retentionDays;
    if (!days || days <= 0) return; // 0 / null = keep forever
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    // Intentionally not filtered by internalKind: Arbr's own internal records age out on
  // the same retention window as customer traffic. Don't "fix" this.
  const { deletedCount } = await RequestRecord.deleteMany({ timestamp: { $lt: cutoff } });
    if (deletedCount > 0) {
      console.log(`[purge] deleted ${deletedCount} request records older than ${days} days`);
    }

    // Eval copies of that text age out on the same window (privacy: they carry prompts/responses).
    const evalItems = await EvalItem.deleteMany({ createdAt: { $lt: cutoff } });
    const evalResults = await EvalResult.deleteMany({ createdAt: { $lt: cutoff } });
    const evalDatasets = await EvalDataset.deleteMany({ createdAt: { $lt: cutoff } });
    const evalTotal = (evalItems.deletedCount || 0) + (evalResults.deletedCount || 0) + (evalDatasets.deletedCount || 0);
    if (evalTotal > 0) {
      console.log(`[purge] deleted ${evalTotal} eval docs (items/results/datasets) older than ${days} days`);
    }
  } catch (err) {
    console.error("[purge] failed:", err.message);
  }
}

module.exports = { purgeOldRecords };
