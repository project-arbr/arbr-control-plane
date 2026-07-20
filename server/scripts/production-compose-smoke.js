// Validate the fully merged self-hosted production Compose profile. This catches
// security regressions that are invisible when reviewing an override file alone
// (notably Compose appending rather than replacing the base profile's ports).
const assert = require("assert").strict;
const { execFileSync } = require("child_process");
const path = require("path");

const repoRoot = path.resolve(__dirname, "../..");

const output = execFileSync(
  "docker",
  ["compose", "-f", "docker-compose.yml", "-f", "docker-compose.prod.yml", "config", "--format", "json"],
  { cwd: repoRoot, encoding: "utf8" }
);
const app = JSON.parse(output).services.app;

assert.equal(app.environment.NODE_ENV, "production", "production profile must set NODE_ENV=production");
assert.equal(app.environment.SEED_ON_BOOT, "false", "production profile must disable demo seeding");
assert.deepEqual(
  app.ports.map(({ host_ip: hostIp, published, target }) => ({ hostIp, published, target })),
  [{ hostIp: "127.0.0.1", published: "4100", target: 4100 }],
  "production profile must expose port 4100 on loopback only"
);

console.log("Production Compose profile is fail-closed and loopback-only.");
