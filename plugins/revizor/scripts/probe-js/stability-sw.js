// Revizor built-in probe stability-sw.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/stability-sw.js" --no-shot
// service worker registrations and what CacheStorage holds; local reads only, no network requests
await new Promise(r => setTimeout(r, 3000));
const out = { supported: 'serviceWorker' in navigator, controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller), registrations: [], caches: [], this_page_cached: false, html_like_cached: [] };
if (out.supported) {
  const regs = await navigator.serviceWorker.getRegistrations();
  out.registrations = regs.map(r => {
    const w = r.active || r.waiting || r.installing || {};
    return { scope: r.scope, script: w.scriptURL || null, state: w.state || null, waiting: !!r.waiting, update_via_cache: r.updateViaCache };
  });
}
if (window.caches) {
  const names = await caches.keys();
  const htmlLike = u => { try { const x = new URL(u); return x.origin === location.origin && (/\/$/.test(x.pathname) || /\.html?$/.test(x.pathname) || !/\.[a-z0-9]{2,5}$/i.test(x.pathname)); } catch (e) { return false; } };
  for (const name of names.slice(0, 10)) {
    const reqs = await (await caches.open(name)).keys();
    const urls = reqs.map(q => q.url);
    out.caches.push({ name, entries: urls.length, sample: urls.slice(0, 8).map(u => u.replace(location.origin, '')) });
    out.html_like_cached.push(...urls.filter(htmlLike).slice(0, 5).map(u => u.replace(location.origin, '')));
  }
  out.this_page_cached = !!(await caches.match(location.href, { ignoreSearch: true }));
}
return out;
