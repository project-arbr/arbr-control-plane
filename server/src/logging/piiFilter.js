// PII pattern detection and redaction for request logs.
// Applied to prompt text BEFORE writing to MongoDB — the model still receives
// the original unmodified prompt; only the stored audit record is masked.
//
// Patterns covered: credit card, SSN (US), Aadhaar (India), email, phone (India/intl).
// Intentionally conservative — false positives are acceptable; false negatives are not.

const PATTERNS = [
  // Credit card: 13–19 digits, optionally separated by spaces or dashes
  { name: "credit_card", re: /\b\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{1,7}\b/g },
  // US SSN: 123-45-6789
  { name: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // Aadhaar: 1234 5678 9012
  { name: "aadhaar", re: /\b\d{4}\s\d{4}\s\d{4}\b/g },
  // Email
  { name: "email", re: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g },
  // Phone: +91-XXXXX-XXXXX, +1 (XXX) XXX-XXXX, 10-digit Indian
  { name: "phone", re: /(\+?\d[\d\s\-().]{7,}\d)/g },
];

function maskPii(text) {
  if (!text || typeof text !== "string") return text;
  let out = text;
  for (const { re } of PATTERNS) {
    out = out.replace(re, "[REDACTED]");
  }
  return out;
}

// Recursively mask PII in a messages array (OpenAI format).
function maskMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== "object") return m;
    if (typeof m.content === "string") return { ...m, content: maskPii(m.content) };
    if (Array.isArray(m.content)) {
      return {
        ...m,
        content: m.content.map((c) =>
          c && c.type === "text" ? { ...c, text: maskPii(c.text) } : c
        ),
      };
    }
    return m;
  });
}

// Cap a string to `max` chars so a huge prompt/response can't bloat a Mongo doc.
function clampText(str, max = 200000) {
  if (typeof str !== "string") return str;
  return str.length > max ? str.slice(0, max) + "…[truncated]" : str;
}

module.exports = { maskPii, maskMessages, clampText };
