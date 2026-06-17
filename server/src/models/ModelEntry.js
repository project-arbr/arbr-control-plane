const mongoose = require("mongoose");

const modelEntrySchema = new mongoose.Schema(
  {
    id:           { type: String, required: true, unique: true, trim: true },
    provider:     { type: String, required: true, trim: true },
    label:        { type: String, default: "" },
    inputPer1M:   { type: Number, required: true, min: 0 },
    outputPer1M:  { type: Number, required: true, min: 0 },
    tier:         { type: String, enum: ["light", "mid", "premium"], required: true },
    builtIn:      { type: Boolean, default: false },
    enabled:      { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ModelEntry", modelEntrySchema);
