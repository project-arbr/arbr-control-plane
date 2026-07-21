// Pure readiness decision, separate from index.js's boot/shutdown wiring so
// it's directly unit-testable with plain values — no app boot required.
// mongoReadyState is mongoose.connection.readyState (0 disconnected,
// 1 connected, 2 connecting, 3 disconnecting).
function computeReadiness({ isShuttingDown, mongoReadyState }) {
  if (isShuttingDown) return { ready: false, reason: "shutting_down" };
  if (mongoReadyState !== 1) return { ready: false, reason: "mongo_disconnected" };
  return { ready: true, reason: null };
}

module.exports = { computeReadiness };
