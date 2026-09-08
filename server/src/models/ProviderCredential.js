// A provider credential entered via the dashboard, stored encrypted at rest.
// MANY documents per provider, one per alias — an operator can hold a prod key and a
// staging key for the same provider and pin either from a routing rule. The ciphertext
// holds a JSON credential object ({ apiKey } for apiKey providers; { accessKeyId,
// secretAccessKey, region } for AWS providers). Secrets never leave the server.
const mongoose = require("mongoose");
const { defineModel } = require("../db/context");

const providerCredentialSchema = new mongoose.Schema(
  {
    // NOT unique and NOT independently indexed: the compound index below is unique on
    // {provider, alias} and serves a bare find({provider}) as its prefix. Declaring
    // `index: true` here would ask for a NON-unique `provider_1` while the pre-multi-key
    // UNIQUE `provider_1` may still exist on disk, and Mongo rejects the pair with
    // IndexOptionsConflict (85) — surfaced only as an async model `error` event, leaving
    // every index unbuilt. maintenance/migrateCredentialAliases.js drops the legacy one.
    provider: { type: String, required: true }, // openai | anthropic | gemini | bedrock-nova
    // Operator-facing name for this key. Defaults to "default" so pre-multi-key callers
    // (and the two tests that construct a credential directly) keep working untouched.
    // "env" is reserved for the credential resolved from environment variables.
    alias: { type: String, required: true, default: "default", trim: true },
    // At most one true per provider. Enforced in setDefaultCredential rather than by a
    // partial unique index: a duplicate degrades harmlessly because compute() sorts
    // deterministically, and a second index is one more thing to migrate around.
    isDefault: { type: Boolean, default: false },
    ciphertext: { type: String, required: true },
    iv: { type: String, required: true },
    tag: { type: String, required: true },
    last4: { type: String, default: "" }, // masked display of the primary secret
    region: { type: String, default: null }, // non-secret; shown for AWS providers
  },
  { collection: "provider_credentials", timestamps: true }
);

providerCredentialSchema.index({ provider: 1, alias: 1 }, { unique: true });

module.exports = defineModel("ProviderCredential", providerCredentialSchema);
