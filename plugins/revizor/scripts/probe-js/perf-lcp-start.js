// Revizor built-in probe perf-lcp-start.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/perf-lcp-start.js" --no-shot
// LCP file timing in this load, counted from the end of the document response (less network noise); no throttling
await new Promise(r => setTimeout(r, 1500));
const FILE = ARGS.file || 'hero'; // part of the LCP file name: --js-args '{"file":"<part>"}'
const nav = performance.getEntriesByType('navigation')[0] || {};
const base = nav.responseEnd || 0;
const e = performance.getEntriesByType('resource').find(r => r.name.includes(FILE));
const lcp = await new Promise(done => {
  let last = null;
  try { new PerformanceObserver(l => { const x = l.getEntries(); last = x[x.length - 1]; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (err) {}
  setTimeout(() => done(last ? last.startTime : null), 300);
});
const r = v => (v == null ? null : Math.round(v - base));
return { file: e ? e.name.split('?')[0].slice(-80) : null, file_start_from_response_ms: e ? r(e.startTime) : null, file_end_from_response_ms: e ? r(e.responseEnd) : null,
  lcp_from_response_ms: r(lcp), response_end_ms: Math.round(base) };
