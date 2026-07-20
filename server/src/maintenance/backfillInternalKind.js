// One-off relabel of records written before `internalKind` existed.
//
// The AI task classifier used to log its own calls as a synthetic application named
// "arbr-internal" (gateway/handler.js). Nothing read that sentinel, so those records
// showed up as a fake application in every dimension view. This converts them to the
// real discriminator and clears the fake dimensions.
//
// Safe to run on every boot:
//   • idempotent — the predicate stops matching after the first pass
//   • matches nothing on a fresh install
//   • a single indexed updateMany, not a cursor
//   • failure degrades to CURRENT behaviour, never worse: exclusion keys on
//     `internalKind: null`, which already matches these records, so an unmigrated
//     record simply stays visible exactly as it is today
const RequestRecord = require("../models/RequestRecord");
const Recommendation = require("../models/Recommendation");

const LEGACY_APPLICATION = "arbr-internal";

async function backfillInternalKind() {
  try {
    const { modifiedCount } = await RequestRecord.updateMany(
      { application: LEGACY_APPLICATION, internalKind: null },
      {
        $set: {
          internalKind: "classifier",
          internalContext: { migratedFrom: LEGACY_APPLICATION },
          // Clear the fake dimensions so no group-by can surface them. The only value
          // being discarded is the constant above, preserved in internalContext.
          application: null,
          workflow: null,
          department: null,
          taskType: null,
        },
      }
    );

    // Recommendations generated against the fake application. Pending ones would clear
    // themselves on the next recompute, but accepted/dismissed ones persist forever.
    const { deletedCount } = await Recommendation.deleteMany({
      dedupeKey: new RegExp(`:${LEGACY_APPLICATION}:`),
    });

    if (modifiedCount || deletedCount) {
      console.log(
        `[migrate] internal spend: relabelled ${modifiedCount} request record(s), ` +
        `removed ${deletedCount} stale recommendation(s)`
      );
    }
    return { modifiedCount, deletedCount };
  } catch (err) {
    // Never block boot. An unmigrated record behaves exactly as it does today.
    console.error("[migrate] internal-spend backfill failed (non-fatal):", err.message);
    return { modifiedCount: 0, deletedCount: 0, error: err.message };
  }
}

module.exports = { backfillInternalKind, LEGACY_APPLICATION };
