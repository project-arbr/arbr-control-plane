// Helpers for the routing "why" record (RequestRecord.routingExplain).
//
// Overrides chain: a model swapped in by the allowed-set check can itself be
// opted out, a budget cap can downgrade whatever routing chose, and a failure can
// then move it again. A single `override` field kept only the last of those, so
// every earlier step vanished from the request detail and a model nobody asked for
// appeared with nothing explaining how it got there.
//
// `overrides` is the full ordered chain. `override` is kept pointing at the last
// entry so records written before this change, the OTel attributes, and any other
// existing reader keep working untouched.
function pushOverride(explain, ov) {
  if (!explain) return;
  (explain.overrides = explain.overrides || []).push(ov);
  explain.override = ov;
}

module.exports = { pushOverride };
