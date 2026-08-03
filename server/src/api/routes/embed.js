// Public embeddable widgets (no auth on the page itself — the read token supplied in
// the URL fragment gates the data). Intentionally framable: no X-Frame-Options is set
// (the app sets none globally), so a partner can drop it into an <iframe>.
const express = require("express");
const { PAGE } = require("../../embed/usageChart");

const router = express.Router();

router.get("/usage", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.type("html").send(PAGE);
});

module.exports = router;
