// Pure max_tokens clamp, kept dependency-free (no mongoose) so both gateway paths and the
// smoke test can use it without a DB. Returns the value to actually send: the requested
// max_tokens capped at `cap`, or the requested value untouched when `cap` is falsy (unknown)
// or the request is already within range.
function clampMaxTokens(requested, cap) {
  if (cap && requested && requested > cap) return cap;
  return requested;
}

module.exports = { clampMaxTokens };
