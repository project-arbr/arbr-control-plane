// Pure-logic smoke test for context-logging masking + size cap (no DB / no keys).
// Run: npm run smoke:logging
const { maskPii, maskMessages, clampText } = require("../src/logging/piiFilter");

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("FAIL:", msg); } };

// maskPii redacts PII in a string (used for responseText).
ok(maskPii("email me at a.b@x.com").includes("[REDACTED]"), "maskPii redacts email");
ok(maskPii("card 4111 1111 1111 1111").includes("[REDACTED]"), "maskPii redacts card");
ok(maskPii("ssn 123-45-6789").includes("[REDACTED]"), "maskPii redacts SSN");
ok(maskPii("hello world") === "hello world", "maskPii leaves clean text");
ok(maskPii(42) === 42, "maskPii passes non-strings through");

// maskMessages redacts within OpenAI-format messages (used for the prompt payload).
const masked = maskMessages([{ role: "user", content: "reach me 9876543210 or x@y.com" }]);
ok(masked[0].content.includes("[REDACTED]"), "maskMessages redacts content");

// clampText caps length and marks truncation; short strings untouched.
const big = "a".repeat(250000);
const capped = clampText(big, 200000);
ok(capped.length <= 200000 + 20 && capped.endsWith("…[truncated]"), "clampText caps + marks");
ok(clampText("short", 200000) === "short", "clampText leaves short text");
ok(clampText(undefined) === undefined, "clampText passes non-strings through");

console.log(`${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
