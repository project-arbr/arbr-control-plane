// Thin re-export — domain modules live in api/routes/.
// Must use explicit /index path: require("./routes") would resolve to THIS file (routes.js)
// before the routes/ directory, creating a circular empty export.
module.exports = require("./routes/index.js");
