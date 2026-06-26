const mongoose = require("mongoose");

const schema = new mongoose.Schema({
  applicationName: { type: String, required: true, unique: true, index: true },
  killSwitchEnabled: { type: Boolean, default: false },
  killSwitchMessage: { type: String, default: null },
  modelOptOut: { type: [String], default: [] },
  aiPolicyAssignments: { type: mongoose.Schema.Types.Mixed, default: null }, // null = use global
}, { collection: "applicationconfigs", timestamps: true });

module.exports = mongoose.model("ApplicationConfig", schema);
