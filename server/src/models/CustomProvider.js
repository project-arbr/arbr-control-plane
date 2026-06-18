const mongoose = require("mongoose");

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
  },
  { collection: "custom_providers", timestamps: true }
);

module.exports = mongoose.model("CustomProvider", customProviderSchema);
