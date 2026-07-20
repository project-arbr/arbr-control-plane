// Role-rank gate for admin mutations. adminAuth.middleware always sets req.user
// before a route handler runs (see adminAuth.js); this only compares ranks.
const { ROLES } = require("../models/User");

const RANK = Object.fromEntries(ROLES.map((role, i) => [role, i]));

function requireRole(minRole) {
  const minRank = RANK[minRole];
  return (req, res, next) => {
    const rank = RANK[req.user && req.user.role];
    if (rank === undefined || rank < minRank) {
      return res.status(403).json({
        error: "forbidden",
        message: `This action requires the "${minRole}" role or higher.`,
      });
    }
    return next();
  };
}

module.exports = { requireRole, RANK };
