// Eval replay worker. Polls for queued EvalRuns and executes them via replay.executeRun, which
// atomically claims each run (queued → running) so this is safe to run in more than one process.
// Replaces the old in-process setImmediate: a queued run now survives a restart and is picked up
// on the next tick instead of being lost. Bounded concurrency keeps provider load in check.
const EvalRun = require("../models/EvalRun");
const { executeRun } = require("./replay");

const INTERVAL_MS = 5_000;
const MAX_CONCURRENT = 2;

let _timer = null;
let _active = 0;

async function tick() {
  try {
    while (_active < MAX_CONCURRENT) {
      // Peek at the oldest queued run; executeRun does the atomic claim, so a race just no-ops.
      const next = await EvalRun.findOne({ status: "queued" }).sort({ createdAt: 1 }).select({ _id: 1 }).lean();
      if (!next) break;
      _active++;
      executeRun(next._id)
        .catch((e) => console.error("[eval-worker] run failed:", e.message))
        .finally(() => { _active--; });
    }
  } catch { /* must not crash the process */ }
}

function start() {
  if (_timer) return;
  _timer = setInterval(tick, INTERVAL_MS);
  if (_timer.unref) _timer.unref();
}
function stop() { if (_timer) { clearInterval(_timer); _timer = null; } }

module.exports = { start, stop, tick };
