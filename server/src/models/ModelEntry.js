const mongoose = require("mongoose");

const modelEntrySchema = new mongoose.Schema(
  {
    id:           { type: String, required: true, unique: true, trim: true },
    provider:     { type: String, required: true, trim: true },
    label:        { type: String, default: "" },
    inputPer1M:   { type: Number, required: true, min: 0 },
    outputPer1M:  { type: Number, required: true, min: 0 },
    tier:         { type: String, enum: ["light", "mid", "premium"], required: true },
    builtIn:       { type: Boolean, default: false },
    enabled:       { type: Boolean, default: true },
    bestUsedFor:   { type: String, default: "" },
    releaseDate:   { type: String, default: "" },
    contextWindow: { type: Number, default: null },
    capabilities: {
      coding:    { type: Number, default: null },
      reasoning: { type: Number, default: null },
      writing:   { type: Number, default: null },
      analysis:  { type: Number, default: null },
      language:  { type: Number, default: null },
      general:   { type: Number, default: null },
      data:      { type: Number, default: null },
    },
    livebenchSyncedAt:  { type: Date,   default: null },
    livebenchModelName: { type: String, default: null },
    lmsysSyncedAt:      { type: Date,   default: null },
    lmsysModelName:     { type: String, default: null },
    litellmSyncedAt:         { type: Date,    default: null },
    supportsVision:          { type: Boolean, default: null },
    supportsReasoning:       { type: Boolean, default: null },
    supportsFunctionCalling: { type: Boolean, default: null },
    supportsPdfInput:        { type: Boolean, default: null },
    supportsPromptCaching:   { type: Boolean, default: null },
    supportsResponseSchema:  { type: Boolean, default: null },
    supportsVideoInput:      { type: Boolean, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("ModelEntry", modelEntrySchema);
