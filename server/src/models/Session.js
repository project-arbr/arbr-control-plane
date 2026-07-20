// Server-side sessions for OIDC-authenticated dashboard users. The opaque _id is
// the value stored in the httpOnly session cookie; nothing else is trusted from
// the client. Deleting a user's session rows (or disabling the User) revokes
// access on their very next request — no waiting for a JWT to expire.
const mongoose = require("mongoose");

const sessionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true }, // opaque random token (see authProviders/oidc.js)
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: "User", index: true },
    createdAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { collection: "sessions" }
);

// Mongo TTL index — expired sessions are purged automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("Session", sessionSchema);
