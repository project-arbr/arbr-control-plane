// Admin / dashboard REST API. Domain modules mounted under /api.
// Gated by api/adminAuth.js when ARBR_ADMIN_KEY is set.
const express = require("express");
const router = express.Router();

router.use(require("./status.js"));
router.use(require("./caps.js"));
router.use(require("./keys.js"));
router.use(require("./connections.js"));
router.use(require("./customProviders.js"));
router.use(require("./models.js"));
router.use(require("./analytics.js"));
router.use(require("./requests.js"));
router.use(require("./recommendations.js"));
router.use(require("./evalBenchmarks.js"));
router.use(require("./evals.js"));
router.use(require("./experiments.js"));
router.use(require("./rules.js"));
router.use(require("./aiPolicy.js"));
router.use(require("./policy.js"));
router.use(require("./sync.js"));
router.use(require("./governance.js"));
router.use(require("./audit.js"));
router.use(require("./providerHealth.js"));
router.use(require("./appConfigs.js"));
router.use(require("./shadow.js"));
router.use(require("./users.js"));
router.use(require("./ops.js"));

module.exports = router;
