// Scheduled maintenance: purge RequestRecord documents older than the configured
// retention window. Runs once per day on startup via setInterval in index.js.
const RequestRecord = require("../models/RequestRecord");
const Settings = require("../models/Settings");

async function purgeOldRecords() {
  try {
    const settings = await Settings.get();
    const days = settings.retentionDays;
    if (!days || days <= 0) return; // 0 / null = keep forever
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { deletedCount } = await RequestRecord.deleteMany({ timestamp: { $lt: cutoff } });
    if (deletedCount > 0) {
      console.log(`[purge] deleted ${deletedCount} request records older than ${days} days`);
    }
  } catch (err) {
    console.error("[purge] failed:", err.message);
  }
}

module.exports = { purgeOldRecords };
