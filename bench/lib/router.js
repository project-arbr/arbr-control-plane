// Maps a baseline name → the model string to request from the gateway for a given item.
// "arbr-auto" sends "auto" so Arbr's own task-aware policy decides; the others pin a model
// so we get a fixed reference curve. RouteLLM-OSS is a phase-4 adapter (returns its pick).
//
// `rand` is a seeded RNG (index-based) so "random" is reproducible.
function modelFor(baseline, cfg, rand) {
  const { premium, mid, light } = cfg.pool;
  switch (baseline) {
    case "always-premium": return premium;
    case "always-light":   return light;
    case "random":         return [premium, mid, light][Math.floor(rand() * 3)];
    case "arbr-auto":      return "auto";
    default: throw new Error(`unknown baseline: ${baseline}`);
  }
}

// Deterministic per-(baseline,index) RNG so "random" reproduces across runs.
function seededRand(seed, i) {
  let x = (seed * 2654435761 + i * 40503) >>> 0;
  return () => { x = (x * 1103515245 + 12345) >>> 0; return x / 0xffffffff; };
}

module.exports = { modelFor, seededRand };
