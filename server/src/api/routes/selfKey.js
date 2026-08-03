// Self-service key management (/v1/key/*).
//
// The caller authenticates with the key itself (see gateway/selfKeyAuth.js) and can
// view, rotate, or revoke ONLY that key — no operator/admin role needed. This closes
// the gap where a plain end user could not rotate their own (possibly compromised)
// key without asking an admin. Mounted OUTSIDE the /api admin gate.
const express = require("express");
const ApiKey = require("../../models/ApiKey");
const auth = require("../../gateway/auth");
const { rotateKey } = require("../keyRotation");
const { logAction } = require("../auditLogger");

const router = express.Router();

// Non-secret view of the caller's own key.
function selfView(d) {
  return {
    name: d.name, application: d.application, kind: d.kind || "gateway",
    prefix: d.prefix, userId: d.userId || null, department: d.department || null,
    enabled: d.enabled, expiresAt: d.expiresAt || null,
    createdAt: d.createdAt, lastUsedAt: d.lastUsedAt,
  };
}

// GET /v1/key — what am I holding?
router.get("/", (req, res) => res.json(selfView(req.selfKey)));

// POST /v1/key/rotate — revoke this key, mint a replacement with identical settings.
// The old key stops working immediately; the new secret is returned exactly once.
router.post("/rotate", async (req, res, next) => {
  try {
    const old = req.selfKey;
    const { doc, secret } = await rotateKey(old);
    // actor is the key itself (no admin user); audit the self-rotation.
    setImmediate(() => logAction("key.rotate.self", "key", doc._id, { replacedId: old._id, application: doc.application, kind: doc.kind }, null));
    res.json({ ...selfView(doc.toObject ? doc.toObject() : doc), key: secret });
  } catch (e) { next(e); }
});

// POST /v1/key/revoke — disable this key immediately. Irreversible.
router.post("/revoke", async (req, res, next) => {
  try {
    const old = req.selfKey;
    await ApiKey.findByIdAndUpdate(old._id, { enabled: false, revokedAt: new Date() });
    auth.invalidate();
    setImmediate(() => logAction("key.revoke.self", "key", old._id, { application: old.application, kind: old.kind }, null));
    res.json({ revoked: true });
  } catch (e) { next(e); }
});

module.exports = router;
