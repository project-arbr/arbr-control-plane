// Admin API routes — users (F-04: per-user roles + revocation)
const express = require("express");
const User = require("../../models/User");
const Session = require("../../models/Session");
const { requireRole } = require("../rbac");
const { logAction } = require("../auditLogger");

const router = express.Router();

function userView(u) {
  return {
    _id: u._id, email: u.email, role: u.role,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt, disabledAt: u.disabledAt,
  };
}

router.get("/users", requireRole("administrator"), async (_req, res, next) => {
  try {
    const users = await User.find().sort({ email: 1 }).lean();
    res.json(users.map(userView));
  } catch (e) { next(e); }
});

router.patch("/users/:id/role", requireRole("administrator"), async (req, res, next) => {
  try {
    const role = req.body && req.body.role;
    if (!User.ROLES.includes(role)) {
      return res.status(400).json({ error: "invalid_role", message: `role must be one of: ${User.ROLES.join(", ")}` });
    }
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    const from = user.role;
    user.role = role;
    await user.save();
    setImmediate(() => logAction("user.role.update", "user", String(user._id), { email: user.email, from, to: role }, req.user));
    res.json(userView(user));
  } catch (e) { next(e); }
});

// Disabling deletes existing sessions immediately — revocation for THIS user only,
// no one else's access changes (the whole point of moving off the shared admin key).
router.post("/users/:id/disable", requireRole("administrator"), async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    if (String(user._id) === String(req.user.id)) {
      return res.status(400).json({ error: "cannot_disable_self", message: "Ask another administrator to disable this account." });
    }
    user.disabledAt = new Date();
    await user.save();
    await Session.deleteMany({ userId: user._id });
    setImmediate(() => logAction("user.disable", "user", String(user._id), { email: user.email }, req.user));
    res.json(userView(user));
  } catch (e) { next(e); }
});

router.post("/users/:id/enable", requireRole("administrator"), async (req, res, next) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: "not_found" });
    user.disabledAt = null;
    await user.save();
    setImmediate(() => logAction("user.enable", "user", String(user._id), { email: user.email }, req.user));
    res.json(userView(user));
  } catch (e) { next(e); }
});

module.exports = router;
