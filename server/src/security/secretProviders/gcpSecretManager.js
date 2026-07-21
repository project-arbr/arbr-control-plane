// GCP Secret Manager SecretProvider. Resource strings are GCP's own
// resource-name syntax (as they appear after the "gcp-sm://" prefix is
// stripped by secretRef.js), e.g. "projects/123/secrets/openai-key/versions/latest".
// Authenticates via Application Default Credentials — free on a GCE VM with
// an attached service account, no extra credential config.
const { parseSecretRef } = require("../secretRef");

let client = null;
function getClient() {
  // Constructed lazily so requiring this module never requires GCP
  // reachability in environments that don't use the gcp-sm:// scheme.
  if (!client) {
    const { SecretManagerServiceClient } = require("@google-cloud/secret-manager");
    client = new SecretManagerServiceClient();
  }
  return client;
}

// Maps a GCP client error to an actionable message. Never includes the
// attempted secret's value — there is none to include, only the resource
// name, which is safe to surface (it names the secret, not its value).
function actionableMessage(resource, err) {
  const code = err && err.code;
  if (code === 7) { // PERMISSION_DENIED
    return `permission denied reading "${resource}" — grant the runtime service account ` +
      "roles/secretmanager.secretAccessor on this secret";
  }
  if (code === 5) { // NOT_FOUND
    return `secret not found: "${resource}" — check the secret name and version`;
  }
  return (err && err.message) || `failed to resolve "${resource}"`;
}

// `client` is injectable (tests pass a fake, never touching the real SDK or
// network); production call sites never pass one, so this always lazily
// constructs the real singleton.
async function resolve(resource, client = getClient()) {
  try {
    const [version] = await client.accessSecretVersion({ name: resource });
    return version.payload.data.toString("utf8");
  } catch (err) {
    throw new Error(actionableMessage(resource, err));
  }
}

module.exports = {
  scheme: "gcp-sm",
  matches: (uri) => parseSecretRef(uri)?.scheme === "gcp-sm",
  resolve: (uri) => resolve(parseSecretRef(uri).resource),
  _resolveResource: resolve, // test-only: accepts an injected fake client
  _actionableMessage: actionableMessage, // test-only
};
