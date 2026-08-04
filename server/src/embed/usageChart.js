// Embeddable usage chart — a self-contained page a partner drops into an <iframe>
// to show an end user their own usage, no rebuild and no admin key.
//
// It is served same-origin by Arbr (GET /embed/usage), so its fetches to /v1/usage
// have no CORS problem, and it reads the read token from the URL FRAGMENT
// (#token=ab_read_…), which browsers never send to the server or leak via Referer.
// The token gates the data; the page itself is public.
//
// chartGeometry is pure and unit-tested; the page embeds its exact source via
// toString(), so the rendered chart and the tested math are one and the same.

// Map timeseries rows to an SVG polyline for one metric within a viewBox. Pure.
// rows: [{ date, cost, requests, ... }]. Returns { points, max, width, height, pad }.
function chartGeometry(rows, opts) {
  const o = opts || {};
  const metric = o.metric || "cost";
  const width = o.width || 640;
  const height = o.height || 180;
  const pad = o.pad || 28;
  const n = rows.length;
  const vals = rows.map(function (r) { return Number(r[metric]) || 0; });
  const max = Math.max.apply(null, [1e-9].concat(vals));
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const points = rows.map(function (r, i) {
    const x = pad + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
    const y = pad + innerH - ((Number(r[metric]) || 0) / max) * innerH;
    return x.toFixed(1) + "," + y.toFixed(1);
  }).join(" ");
  return { points: points, max: max, width: width, height: height, pad: pad };
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Usage</title>
<style>
  :root { color-scheme: light dark; }
  html,body { margin:0; font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; }
  .wrap { padding:14px; }
  .head { display:flex; justify-content:space-between; align-items:baseline; gap:10px; flex-wrap:wrap; margin-bottom:8px; }
  .scope { color:#888; font-size:12px; }
  .total { font-size:20px; font-weight:600; }
  .total small { font-size:12px; font-weight:400; color:#888; }
  svg { width:100%; height:auto; display:block; }
  .line { fill:none; stroke:#2f37ff; stroke-width:2; }
  .area { fill:#2f37ff; opacity:.08; }
  .msg { color:#c0392b; padding:14px; }
  .empty { color:#888; padding:14px; }
</style></head><body><div class="wrap" id="root">Loading…</div>
<script>
${chartGeometry.toString()}
(function () {
  var root = document.getElementById("root");
  var h = new URLSearchParams((location.hash || "").replace(/^#/, ""));
  var token = h.get("token");
  var metric = h.get("metric") === "requests" ? "requests" : "cost";
  var bucket = ["hour","day","month"].indexOf(h.get("bucket")) >= 0 ? h.get("bucket") : "day";
  if (!token) { root.innerHTML = '<div class="msg">Missing token. Embed with #token=ab_read_…</div>'; return; }
  var hdr = { Authorization: "Bearer " + token };
  Promise.all([
    fetch("/v1/usage/timeseries?bucket=" + bucket, { headers: hdr }).then(function (r) { if (!r.ok) throw new Error("unauthorized"); return r.json(); }),
    fetch("/v1/usage/scope", { headers: hdr }).then(function (r) { return r.ok ? r.json() : {}; })
  ]).then(function (res) {
    var rows = res[0] || [], scope = res[1] || {};
    if (!rows.length) { root.innerHTML = '<div class="empty">No usage yet.</div>'; return; }
    var g = chartGeometry(rows, { metric: metric });
    var total = rows.reduce(function (s, r) { return s + (Number(r[metric]) || 0); }, 0);
    var totalStr = metric === "cost" ? "$" + total.toFixed(2) : String(Math.round(total));
    var scopeStr = (scope.application || "") + (scope.userId ? " · " + scope.userId : "");
    var area = g.points ? ("M" + g.pad + "," + (g.height - g.pad) + " L" + g.points.replace(/ /g, " L") + " L" + (g.width - g.pad) + "," + (g.height - g.pad) + " Z") : "";
    root.innerHTML =
      '<div class="head"><div class="total">' + totalStr + ' <small>' + metric + ' · last ' + rows.length + ' ' + bucket + 's</small></div>' +
      '<div class="scope">' + scopeStr + '</div></div>' +
      '<svg viewBox="0 0 ' + g.width + ' ' + g.height + '" preserveAspectRatio="none" role="img" aria-label="usage trend">' +
      '<path class="area" d="' + area + '"/>' +
      '<polyline class="line" points="' + g.points + '"/></svg>';
  }).catch(function () {
    root.innerHTML = '<div class="msg">Could not load usage. Check the read token.</div>';
  });
})();
</script></body></html>`;

module.exports = { chartGeometry, PAGE };
