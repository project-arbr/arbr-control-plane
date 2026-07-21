// Parses a credential-shaped env var's raw string value into a secret-manager
// reference, if it looks like one — a generic `scheme://resource` shape,
// anchored at the start of the string. NOT tied to a hardcoded scheme
// allowlist: which schemes are actually usable is entirely a function of
// which providers are registered in secretResolver.js's PROVIDERS_REGISTRY,
// so adding a new cloud (aws-sm://, azure-kv://) never requires touching
// this file. A real credential literal (API key, admin key, etc.) never
// takes this shape in practice, so this can't misidentify one.
const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i;

// value -> { scheme, resource } | null
function parseSecretRef(value) {
  if (typeof value !== "string") return null;
  const m = SCHEME_PATTERN.exec(value);
  return m ? { scheme: m[1], resource: m[2] } : null;
}

module.exports = { parseSecretRef };
