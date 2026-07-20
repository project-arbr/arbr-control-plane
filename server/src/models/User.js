// Human/service identities for the admin dashboard. Roles rank viewer < operator
// < administrator (see api/rbac.js). Auto-provisioned on first successful OIDC /
// trusted-header login (default role: viewer); the first administrator is minted
// by scripts/bootstrap-admin.js, not through the API.
const mongoose = require("mongoose");

const ROLES = ["viewer", "operator", "administrator"];

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    role: { type: String, enum: ROLES, default: "viewer" },
    // OIDC `sub` claim, or the IAP/proxy-forwarded subject. Null for admin-key-only setups.
    oidcSubject: { type: String, default: null },
    createdAt: { type: Date, default: Date.now },
    lastLoginAt: { type: Date, default: null },
    // Set to revoke access immediately; existing sessions are deleted alongside this.
    disabledAt: { type: Date, default: null },
  },
  { collection: "users" }
);

module.exports = mongoose.model("User", userSchema);
module.exports.ROLES = ROLES;
