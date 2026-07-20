// Admin API routes — policy
const express = require("express");
const RequestRecord = require("../../models/RequestRecord");
const policyEngine = require("../../routing/policy");
const { requireRole } = require("../rbac");
const { TASK_TYPES } = require("../../classify/classifier");
const pricing = require("../../pricing/registry");

const router = express.Router();

// ── automated-routing policy (editable knobs behind the cost guardrail) ──
router.get("/policy", async (_req, res, next) => {
  try {
    const d = await policyEngine.describe();
    // Merge built-in task types with any app-provided task types observed in traffic.
    const observed = (await RequestRecord.distinct("taskType", RequestRecord.CUSTOMER_ONLY)).filter(Boolean).map((x) => String(x).toLowerCase());
    const allTypes = [...new Set([...TASK_TYPES, ...observed])].sort();
    res.json({ ...d, taskTypes: allTypes });
  } catch (e) { next(e); }
});

router.put("/policy", requireRole("administrator"), async (req, res, next) => {
  try {
    const body = req.body || {};
    // Validate task types against built-in catalog + any task types observed in traffic.
    let cheapTaskTypes;
    if (Array.isArray(body.cheapTaskTypes)) {
      const observed = (await RequestRecord.distinct("taskType", RequestRecord.CUSTOMER_ONLY)).filter(Boolean).map((x) => String(x).toLowerCase());
      const known = new Set([...TASK_TYPES, ...observed]);
      cheapTaskTypes = body.cheapTaskTypes.map((x) => String(x).toLowerCase()).filter((x) => known.has(x));
    }
    // Validate targets: each must be a known model that belongs to its provider key.
    let lightTargets;
    if (body.lightTargets && typeof body.lightTargets === "object") {
      lightTargets = {};
      for (const [provider, model] of Object.entries(body.lightTargets)) {
        const m = pricing.getModel(model);
        if (m && m.provider === provider) lightTargets[provider] = model;
      }
    }
    const saved = await policyEngine.setPolicy({ cheapTaskTypes, lightTargets, mode: body.mode });
    res.json(saved);
  } catch (e) { next(e); }
});


module.exports = router;
