const mongoose = require("mongoose");
const { defineModel } = require("../db/context");

const customProviderSchema = new mongoose.Schema(
  {
    id:         { type: String, required: true, unique: true, index: true },
    label:      { type: String, required: true },
    baseURL:    { type: String, required: true },
    ciphertext: { type: String, required: true },
    iv:         { type: String, required: true },
    tag:        { type: String, required: true },
    last4:      { type: String, default: "" },
    enabled:    { type: Boolean, default: true },
    // Replica pool (gateway/replicaPool.js): custom providers with the same pool name serve the
    // same models and share traffic. Empty = not pooled.
    pool:       { type: String, default: "", trim: true },
    // A draining pool member takes no new requests; requests already in flight finish.
    draining:   { type: Boolean, default: false },
  },
  { collection: "custom_providers", timestamps: true }
);

module.exports = defineModel("CustomProvider", customProviderSchema);
