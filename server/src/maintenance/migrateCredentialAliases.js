// One-off migration to the multi-key provider-credential layout.
//
// Before: `provider` carried a UNIQUE index, so a provider had exactly one credential.
// After:  the unique index is {provider, alias}, so a provider can hold several keys and a
//         routing rule can pin one of them.
//
// Two things have to happen, and Mongoose does neither on its own. It will happily declare the
// new compound index while leaving the old unique `provider_1` in place — and that stale index
// is what rejects the SECOND key for a provider with a duplicate-key error, long after this code
// appeared to succeed.
//
// Safe to run on every boot:
//   • idempotent — the backfill predicate stops matching, and the drop is skipped once gone
//   • matches nothing on a fresh install (the collection does not exist yet)
//   • concurrent replicas race harmlessly (the loser gets IndexNotFound)
//
// Unlike backfillInternalKind, failure here is NOT swallowed quietly. A failed relabel is
// cosmetic; a failed index drop silently blocks every second key an operator tries to add. It
// still must not block boot: single-key deploys keep working exactly as they do today.
const ProviderCredential = require("../models/ProviderCredential");

const LEGACY_INDEX_KEY = JSON.stringify({ provider: 1 });
const NAMESPACE_NOT_FOUND = 26;
const INDEX_NOT_FOUND = 27;

async function migrateCredentialAliases() {
  const out = { backfilled: 0, droppedLegacyIndex: false, error: null };
  try {
    // 1. Rows written before `alias` existed are the provider's default key.
    const { modifiedCount } = await ProviderCredential.updateMany(
      { $or: [{ alias: { $exists: false } }, { alias: null }, { alias: "" }] },
      { $set: { alias: "default", isDefault: true } }
    );
    out.backfilled = modifiedCount || 0;

    // 2. Drop the legacy single-field unique index.
    const coll = ProviderCredential.collection;
    let indexes;
    try {
      indexes = await coll.indexes();
    } catch (err) {
      // Fresh install: the collection has never been written to, so there is no legacy index
      // and nothing to backfill. Just make sure the new index exists.
      if (err.code === NAMESPACE_NOT_FOUND || err.codeName === "NamespaceNotFound") {
        await ProviderCredential.createIndexes();
        return out;
      }
      throw err;
    }

    // Match on SHAPE (unique + exactly {provider:1}), not on the name `provider_1`. A
    // deliberately re-added NON-unique index on provider is legitimate and must survive.
    const legacy = indexes.find((i) => i.unique && JSON.stringify(i.key) === LEGACY_INDEX_KEY);
    if (legacy) {
      try {
        await coll.dropIndex(legacy.name);
        out.droppedLegacyIndex = true;
      } catch (err) {
        // Another replica dropped it first between our read and our write. Benign.
        if (err.code !== INDEX_NOT_FOUND && err.codeName !== "IndexNotFound") throw err;
      }
    }

    // 3. Build {provider, alias} now rather than waiting on a later autoIndex pass, so the
    //    very next setCredential() can write a second alias.
    await ProviderCredential.createIndexes();

    if (out.backfilled || out.droppedLegacyIndex) {
      console.log(
        `[migrate] provider credentials: ${out.backfilled} row(s) given alias "default"` +
        `${out.droppedLegacyIndex ? ", legacy unique provider index dropped" : ""}`
      );
    }
    return out;
  } catch (err) {
    console.error(
      "[migrate] provider-credential alias migration FAILED. Existing credentials keep working, " +
      "but adding a SECOND key for a provider will fail with a duplicate-key error until this " +
      "succeeds. Restart to retry. Cause:", err.message
    );
    out.error = err.message;
    return out;
  }
}

module.exports = { migrateCredentialAliases };
