// Replica pools: several OpenAI-compatible custom providers that serve the same models.
//
// A custom provider can name a `pool`. Every enabled custom provider with the same pool name is
// treated as a replica of the others: the same model ids, behind different endpoints (for
// example one vLLM server per GPU host). Routing still resolves a model to ONE provider through
// the registry; dispatch then spreads requests across that provider's pool and fails over
// between members. A provider without a pool behaves exactly as before.
//
// Per member, in this process:
//   - in-flight count     → new requests go to the healthy member with the fewest in flight
//   - consecutive failures → after `failThreshold` failures the member cools down for
//                            `cooldownMs` and is skipped, so requests stop paying its timeout
//   - draining (stored on the CustomProvider row) → no new requests; in-flight ones finish
//
// Health is per gateway process (like the response cache). Draining is persisted, so every
// gateway process honours it once its connections cache refreshes (a few seconds).
const net = require("net");
const { config } = require("../config");

const state = new Map(); // providerId -> { inFlight, fails, downUntil, served, failed }
const rotation = new Map(); // pool -> counter used to break ties between equally loaded members

function entry(id) {
  let s = state.get(id);
  if (!s) {
    s = { inFlight: 0, fails: 0, downUntil: 0, served: 0, failed: 0, lastOk: 0, trialUntil: 0 };
    state.set(id, s);
  }
  return s;
}

function poolOf(providerId, eff) {
  const p = eff?.providers?.[providerId];
  return p && p.baseURL && p.pool ? p.pool : null;
}

// Every live member of the provider's pool, including the provider itself. [providerId] when
// the provider has no pool.
function members(providerId, eff) {
  const pool = poolOf(providerId, eff);
  if (!pool) return [providerId];
  return Object.keys(eff.providers).filter((id) => poolOf(id, eff) === pool).sort();
}

// How long one request holds the single trial of a recovering member. It is cleared as soon as that
// request reports success or failure; the expiry only covers a request that never reports back.
const TRIAL_MS = 60000;

// A member is recovering when its cooldown has ended but it has not answered since it failed.
function recovering(s, now) {
  return s.downUntil > 0 && s.downUntil <= now && s.fails >= config.replicaFailThreshold;
}

// The order in which dispatch should try members for one request.
//   - draining members are never tried
//   - a recovering member gets exactly ONE trial request at a time (half-open): the request that
//     claims it tries it first; every other request skips it until the trial reports back. Without
//     this, every request arriving as a frozen member's cooldown ends paid its connect timeout.
//   - healthy members next, fewest in flight first; ties rotate so load spreads evenly
//   - members in cooldown (and recovering members whose trial is taken) come last, soonest-to-recover
//     first, so a request still has a chance when every member has recently failed
// Returns [] only when every member is draining.
function order(providerId, eff, now = Date.now()) {
  const pool = poolOf(providerId, eff);
  if (!pool) return [providerId];
  const live = members(providerId, eff).filter((id) => !eff.providers[id].draining);
  const turn = rotation.get(pool) || 0;
  rotation.set(pool, turn + 1);
  const rank = (id) => (live.indexOf(id) - (turn % live.length) + live.length) % live.length;
  const trial = [], waiting = [];
  for (const id of live) {
    const s = entry(id);
    if (!recovering(s, now)) continue;
    if (s.trialUntil > now) {
      waiting.push(id);
    } else if (!trial.length) {
      s.trialUntil = now + TRIAL_MS; // this request claims the trial
      trial.push(id);
    } else {
      waiting.push(id); // one trial per request; the next request takes the next recovering member
    }
  }
  const healthy = live.filter((id) => entry(id).downUntil <= now && !recovering(entry(id), now))
    .sort((a, b) => entry(a).inFlight - entry(b).inFlight || rank(a) - rank(b));
  const cooling = live.filter((id) => entry(id).downUntil > now || waiting.includes(id))
    .sort((a, b) => entry(a).downUntil - entry(b).downUntil);
  return [...trial, ...healthy, ...cooling];
}

function acquire(id) { entry(id).inFlight += 1; }
function release(id) { const s = entry(id); s.inFlight = Math.max(0, s.inFlight - 1); }

function reportSuccess(id) {
  const s = entry(id);
  s.fails = 0;
  s.downUntil = 0;
  s.trialUntil = 0;
  s.served += 1;
  s.lastOk = Date.now();
}

// A host that has been paused or firewalled often drops packets instead of refusing the
// connection, and fetch would then wait minutes before failing. Before sending to a pool member
// that has not answered recently, check that its port accepts a TCP connection within
// `replicaConnectTimeoutMs`. Members that answered in the last 2 s skip the check, so under
// steady load it costs nothing. Resolves true/false; never throws.
const RECENT_OK_MS = 2000;
function reachable(id, baseURL, now = Date.now()) {
  if (now - entry(id).lastOk < RECENT_OK_MS) return Promise.resolve(true);
  let host, port;
  try {
    const u = new URL(baseURL);
    host = u.hostname;
    port = Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  } catch {
    return Promise.resolve(true); // not a URL we can probe; let fetch decide
  }
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(config.replicaConnectTimeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

function reportFailure(id, now = Date.now()) {
  const s = entry(id);
  s.fails += 1;
  s.failed += 1;
  s.trialUntil = 0;
  if (s.fails >= config.replicaFailThreshold) s.downUntil = now + config.replicaCooldownMs;
}

// While a request to a pool member waits for its response, check every `replicaInflightProbeMs`
// that the member still accepts TCP connections. A host that was paused or cut off mid-request
// otherwise leaves the request hanging until the OS gives up (minutes). A slow but healthy member
// is never interrupted: only a failed probe aborts. Returns a function that stops the watch; call
// it as soon as the response headers arrive, so a body already streaming is never aborted.
function watchInFlight(id, baseURL, controller) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy || controller.signal.aborted) return;
    busy = true;
    try {
      if (!(await reachable(id, baseURL))) {
        controller.abort(new Error(`replica ${id} stopped answering mid-request (no TCP connection)`));
      }
    } finally {
      busy = false;
    }
  }, config.replicaInflightProbeMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Upstream statuses worth retrying on another member: the replica errored, is overloaded,
// restarting or gone (a vLLM engine that has died answers 500). Other 4xx are the request's
// own fault and would fail the same way everywhere.
function retryableStatus(status) {
  return status === 429 || status >= 500;
}

// Read-only view for the admin API: one row per pooled custom provider.
function snapshot(eff, now = Date.now()) {
  return Object.keys(eff?.providers || {})
    .filter((id) => poolOf(id, eff))
    .sort()
    .map((id) => {
      const s = entry(id);
      return {
        provider: id,
        pool: poolOf(id, eff),
        draining: !!eff.providers[id].draining,
        healthy: s.downUntil <= now && !recovering(s, now),
        recovering: recovering(s, now),
        cooldownRemainingMs: Math.max(0, s.downUntil - now),
        inFlight: s.inFlight,
        consecutiveFailures: s.fails,
        served: s.served,
        failed: s.failed,
      };
    });
}

function _reset() { state.clear(); rotation.clear(); }

module.exports = {
  members, order, acquire, release, reportSuccess, reportFailure, reachable, watchInFlight, retryableStatus, snapshot, _reset,
};
