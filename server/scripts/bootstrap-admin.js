// Mint the first Administrator user for OIDC / trusted-header auth modes.
// Run once per deployment before anyone can sign in — there is no HTTP
// endpoint for this on purpose (it would need auth to protect it, which is
// exactly the chicken-and-egg problem this script exists to solve).
//
//   node server/scripts/bootstrap-admin.js --email=you@company.com
//
// Idempotent: re-running with the same email just (re-)promotes that user to
// administrator and clears any disabledAt, rather than failing.
require("dotenv").config();
const mongoose = require("mongoose");
const { config } = require("../src/config");
const User = require("../src/models/User");

async function main() {
  const emailArg = process.argv.find((a) => a.startsWith("--email="));
  const email = emailArg && emailArg.slice("--email=".length).trim().toLowerCase();
  if (!email) {
    console.error("Usage: node server/scripts/bootstrap-admin.js --email=you@company.com");
    process.exit(1);
  }

  await mongoose.connect(config.mongoUri);
  const user = await User.findOneAndUpdate(
    { email },
    { $set: { role: "administrator", disabledAt: null } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  console.log(`[bootstrap-admin] ${user.email} is now an administrator (id: ${user._id}).`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error("[bootstrap-admin] failed:", err);
  process.exit(1);
});
