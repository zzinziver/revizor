// Revizor built-in probe stability-sw-code.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/stability-sw-code.js" --no-shot
// run with --url "<service worker script URL>": the browser shows the file as text; read it, no network requests
const t = (document.body && document.body.innerText) || '';
return { bytes: t.length, skip_waiting: /skipWaiting\s*\(/.test(t), clients_claim: /clients\.claim\s*\(/.test(t), workbox: /workbox/i.test(t),
  caches_open: (t.match(/caches\.open\([^)]{0,60}/g) || []).slice(0, 5),
  caches_html: /\.html\b|mode\s*===?\s*['"]navigate|destination\s*===?\s*['"]document|addAll\(\s*\[\s*['"]\/['"]/.test(t),
  cache_first: /cacheFirst|CacheFirst|caches\.match\(/.test(t), network_first: /networkFirst|NetworkFirst/.test(t) };
