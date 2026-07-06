// Realistic prompt/response pairs per task type, so seeded RequestRecords carry believable
// `messages` + `responseText`. Without these the eval flow has nothing to replay (the demo's
// whole point). Covers the five demo task types from the growth brief — support classification,
// FAQ, CRM summaries, legal/contract extraction, code explanation — plus a generic fallback.
// The `extraction` pack is intentionally structured (JSON) so it drives the failure-first story
// (a cheaper model breaking the schema).

const PACKS = {
  classification: [
    { prompt: "Classify this support ticket as one of [billing, technical, account, feedback]:\n\"I was charged twice for my subscription this month.\"", response: "billing" },
    { prompt: "Classify this support ticket as one of [billing, technical, account, feedback]:\n\"The app crashes every time I upload a PDF.\"", response: "technical" },
    { prompt: "Classify this support ticket as one of [billing, technical, account, feedback]:\n\"I can't log in even after resetting my password.\"", response: "account" },
    { prompt: "Classify this support ticket as one of [billing, technical, account, feedback]:\n\"Love the new dashboard, the charts are much clearer.\"", response: "feedback" },
    { prompt: "Classify the sentiment of this review as [positive, neutral, negative]:\n\"Support took three days to reply and never fixed my issue.\"", response: "negative" },
  ],
  faq: [
    { prompt: "How do I reset my password?", response: "Open Settings → Security → Reset password. We email a reset link that stays valid for 30 minutes; follow it to set a new password." },
    { prompt: "What payment methods do you accept?", response: "We accept all major credit cards (Visa, Mastercard, Amex) and ACH bank transfer on annual plans. Invoicing is available for enterprise accounts." },
    { prompt: "Can I export my data?", response: "Yes. Go to Settings → Data → Export to download a CSV or JSON archive of your workspace. Exports include records from the last 90 days by default." },
    { prompt: "How do I invite a teammate?", response: "In Settings → Members, click Invite, enter their email, and pick a role (Admin, Editor, or Viewer). They'll get an email invitation to join the workspace." },
    { prompt: "Is there a free trial?", response: "Yes, a 14-day trial with full features and no credit card required. You can add a payment method any time before it ends to keep your data." },
  ],
  summarisation: [
    { prompt: "Summarise this sales-call note in two sentences:\n\"Spoke with the VP of Ops at Northwind. They're evaluating us against two competitors, main concern is onboarding time. Budget approved for Q3, decision expected in 4 weeks. Asked for a security questionnaire and a reference customer in logistics.\"", response: "Northwind's VP of Ops has Q3 budget approved and will decide within four weeks, weighing us against two competitors mainly on onboarding time. They requested a security questionnaire and a logistics reference customer." },
    { prompt: "Summarise this CRM note in two sentences:\n\"Renewal call with Acme. Usage up 40% YoY, two new teams onboarded. They want volume pricing and SSO before signing a 2-year deal. Champion is supportive; procurement is the bottleneck.\"", response: "Acme's usage grew 40% year over year and they're ready for a two-year renewal, contingent on volume pricing and SSO. Their champion is supportive, but procurement is the main bottleneck." },
    { prompt: "Summarise this support interaction in one sentence:\n\"Customer reported slow report loading; we identified a large date range as the cause and suggested narrowing filters. They confirmed it resolved the issue.\"", response: "The customer's slow report loading was caused by an overly large date range and was resolved by narrowing the filters." },
    { prompt: "Summarise the outcome of this meeting note:\n\"Kickoff with Globex. Agreed on a 6-week pilot, success metric is 20% cost reduction. They assigned two engineers; we provide weekly check-ins.\"", response: "Globex agreed to a six-week pilot targeting a 20% cost reduction, with two of their engineers assigned and weekly check-ins from our side." },
  ],
  "document analysis": [
    { prompt: "Summarise the key obligations in this indemnification clause:\n\"The Vendor shall indemnify, defend and hold harmless the Client from any third-party claims arising out of the Vendor's breach of this Agreement or negligence, up to a cap equal to fees paid in the prior 12 months.\"", response: "The Vendor must indemnify and defend the Client against third-party claims caused by the Vendor's breach or negligence. Liability is capped at the total fees paid in the preceding 12 months." },
    { prompt: "Identify the termination rights in this clause:\n\"Either party may terminate for convenience on 60 days' written notice. The Client may terminate immediately upon a material breach that remains uncured for 15 days after notice.\"", response: "Either party may terminate for convenience with 60 days' written notice. The Client may also terminate immediately for a material breach left uncured 15 days after notice." },
    { prompt: "What does this confidentiality clause require?\n\"Each party shall protect the other's Confidential Information with the same care it uses for its own, and not less than reasonable care, for a period of five years after disclosure.\"", response: "Each party must protect the other's confidential information with at least reasonable care (and no less than the care it gives its own), for five years after disclosure." },
  ],
  coding: [
    { prompt: "Explain what this function does:\n```js\nfunction debounce(fn, ms) {\n  let t;\n  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };\n}\n```", response: "It returns a debounced wrapper around `fn`: each call resets a timer, so `fn` only runs once the wrapper has been idle for `ms` milliseconds. Useful for rate-limiting rapid events like keystrokes or resize handlers." },
    { prompt: "Explain what this SQL query returns:\n```sql\nSELECT customer_id, COUNT(*) AS orders\nFROM orders WHERE created_at > NOW() - INTERVAL '30 days'\nGROUP BY customer_id HAVING COUNT(*) > 5;\n```", response: "It lists each customer who placed more than five orders in the last 30 days, along with their order count. The HAVING clause filters the grouped results to customers above the threshold." },
    { prompt: "What does this Python snippet do?\n```python\nnums = [n for n in range(100) if n % 3 == 0 and n % 5 == 0]\n```", response: "It builds a list of numbers from 0 to 99 that are divisible by both 3 and 5 (i.e. multiples of 15): [0, 15, 30, 45, 60, 75, 90]." },
  ],
  // Structured-output extraction — drives the failure-first demo (JSON/schema breakage).
  extraction: [
    { prompt: "Extract the fields {party, effective_date, termination_notice_days, indemnity} as JSON from:\n\"This Agreement between Acme Inc. and the Client is effective January 1, 2026. Either party may terminate on 30 days notice. The Vendor shall indemnify the Client for third-party claims.\"", response: '{"party":"Acme Inc.","effective_date":"2026-01-01","termination_notice_days":30,"indemnity":true}' },
    { prompt: "Extract {invoice_number, total_usd, due_date} as JSON from:\n\"Invoice INV-4821, amount due $12,450.00, payable by 2026-02-15.\"", response: '{"invoice_number":"INV-4821","total_usd":12450.00,"due_date":"2026-02-15"}' },
    { prompt: "Extract {name, email, company} as JSON from this signature:\n\"Best, Dana Lee — Head of Ops, Globex — dana.lee@globex.com\"", response: '{"name":"Dana Lee","email":"dana.lee@globex.com","company":"Globex"}' },
    { prompt: "Extract {governing_law, cap_months, auto_renew} as JSON from:\n\"This Agreement is governed by the laws of Delaware. Liability is capped at 12 months of fees. The term auto-renews annually unless cancelled.\"", response: '{"governing_law":"Delaware","cap_months":12,"auto_renew":true}' },
  ],
};

const GENERIC = [
  { prompt: "Draft a short, friendly reply confirming we received the customer's request and will follow up within one business day.", response: "Thanks for reaching out! We've received your request and a member of our team will follow up within one business day. We appreciate your patience." },
  { prompt: "Rewrite this sentence to be more concise: \"We are writing to inform you that your order has now been shipped.\"", response: "Your order has shipped." },
];

// Deterministic pick within a task type's pack (index provided by the caller's PRNG).
function getPromptPair(taskType, i) {
  const pack = PACKS[String(taskType || "").toLowerCase()] || GENERIC;
  return pack[i % pack.length];
}

module.exports = { getPromptPair, PACKS };
