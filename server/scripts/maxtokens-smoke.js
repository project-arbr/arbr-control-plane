// Pure-logic smoke test for the per-model max_tokens clamp (no DB / no provider keys).
// Run: npm run smoke:maxtokens
const { clampMaxTokens } = require("../src/pricing/clamp");

let pass = 0, fail = 0;
const eq = (got, exp, msg) => {
  if (got === exp) { pass++; } else { fail++; console.log(`FAIL: ${msg} — got ${got}, expected ${exp}`); }
};

// 1. Over-large request is clamped to the model's ceiling (the OpenCode → gpt-4o case).
eq(clampMaxTokens(32000, 16384), 16384, "32000 clamped to 16384");

// 2. Request within range is left untouched.
eq(clampMaxTokens(8000, 16384), 8000, "8000 within 16384 unchanged");

// 3. Exactly at the cap is left untouched.
eq(clampMaxTokens(16384, 16384), 16384, "16384 at cap unchanged");

// 4. Unknown cap (model not synced) → never clamps, behavior unchanged.
eq(clampMaxTokens(32000, null), 32000, "unknown cap leaves request as-is");
eq(clampMaxTokens(32000, 0), 32000, "zero/falsy cap leaves request as-is");

// 5. No client max_tokens → nothing to clamp (provider/default applies downstream).
eq(clampMaxTokens(undefined, 16384), undefined, "no request value passes through");
eq(clampMaxTokens(null, 16384), null, "null request value passes through");

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
