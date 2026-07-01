// Minimal CSV cell serialiser — handles quoting, escaping, null/Date coercion.
function csvCell(v) {
  if (v == null) return "";
  if (v instanceof Date) return v.toISOString();
  const s = String(v);
  return (s.includes(",") || s.includes('"') || s.includes("\n"))
    ? `"${s.replace(/"/g, '""')}"`
    : s;
}

module.exports = { csvCell };
