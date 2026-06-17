// A provider credential entered via the dashboard, stored encrypted at rest.
// One document per provider. The ciphertext holds a JSON credential object
// ({ apiKey } for apiKey providers; { accessKeyId, secretAccessKey, region } for
// AWS providers). Secrets never leave the server.
const mongoose = require("mongoose");

const providerCredentialSchema = new mongoose.Schema(
  {
    provider: { type: String, required: true, unique: true, index: true }, // openai | anthropic | gemini | bedrock-nova
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    last4: { type: String, default: "" }, // masked display of the primary secret
    region: { type: String, default: null }, // non-secret; shown for AWS providers
  },
  { collection: "provider_credentials", timestamps: true }
);

module.exports = mongoose.model("ProviderCredential", providerCredentialSchema);
