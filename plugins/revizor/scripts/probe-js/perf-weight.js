// Revizor built-in probe perf-weight.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/perf-weight.js" --no-shot
// weight by initiator, third-party hosts, top-10 files and LCP element of this load (no throttling)
await new Promise(r => setTimeout(r, 1500));
const site = location.hostname.replace(/^www\./, '');
const nav = performance.getEntriesByType('navigation')[0] || {};
const res = performance.getEntriesByType('resource');
const by = {}, third = {};
let total = nav.transferSize || 0, zero = 0;
for (const r of res) {
  const t = r.initiatorType || 'other';
  const b = r.transferSize || 0;
  if (!b && r.decodedBodySize) zero++;
  if (!by[t]) by[t] = { n: 0, kb: 0 };
  by[t].n++; by[t].kb += b / 1024; total += b;
  let h = '';
  try { h = new URL(r.name).hostname.replace(/^www\./, ''); } catch (e) {}
  if (h && h !== site && !h.endsWith('.' + site)) { if (!third[h]) third[h] = { n: 0, kb: 0 }; third[h].n++; third[h].kb += b / 1024; }
}
for (const k of Object.keys(by)) by[k].kb = Math.round(by[k].kb);
const top = res.slice().sort((a, b) => (b.transferSize || 0) - (a.transferSize || 0)).slice(0, 10)
  .map(r => ({ file: r.name.split('?')[0].slice(-90), type: r.initiatorType, kb: Math.round((r.transferSize || 0) / 1024) }));
const lcp = await new Promise(done => {
  let last = null;
  try { new PerformanceObserver(l => { const e = l.getEntries(); last = e[e.length - 1]; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  setTimeout(() => done(last ? { ms: Math.round(last.startTime), tag: last.element ? last.element.tagName.toLowerCase() : null, file: last.url ? last.url.split('?')[0].slice(-90) : null } : null), 300);
});
return { total_kb: Math.round(total / 1024), requests: res.length + 1, by_type: by,
  third_party: Object.entries(third).sort((a, b) => b[1].kb - a[1].kb).slice(0, 10).map(([host, v]) => ({ host, n: v.n, kb: Math.round(v.kb) })),
  zero_size_cross_origin: zero, top, lcp, ttfb_ms: Math.round(nav.responseStart || 0), dom_nodes: document.getElementsByTagName('*').length };
