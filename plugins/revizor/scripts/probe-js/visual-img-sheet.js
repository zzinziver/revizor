// Revizor built-in probe visual-img-sheet.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/visual-img-sheet.js" --no-shot
// contact sheet of meaningful pictures on the page: one overlay with thumbnails and captions (file, alt, natural → rendered size)
const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && +s.opacity > 0.05; };
const file = u => { try { return decodeURIComponent(new URL(u, location.href).pathname.split('/').pop()).slice(0, 28); } catch (e) { return String(u).slice(-28); } };
const items = [], seen = new Map();
for (const i of document.images) {
  const r = i.getBoundingClientRect(), src = i.currentSrc || i.src;
  if (!src || !vis(i) || i.naturalWidth < 120 || r.width < 80 || r.height < 60) continue;
  seen.set(src, (seen.get(src) || 0) + 1); if (seen.get(src) > 1) continue;
  items.push({ src, kind: 'img', alt: i.hasAttribute('alt') ? i.getAttribute('alt') : null, natural: [i.naturalWidth, i.naturalHeight], rendered: [Math.round(r.width), Math.round(r.height)], y: Math.round(r.top + scrollY) });
}
for (const e of document.querySelectorAll('body *')) {
  if (items.length >= 60) break;
  const s = getComputedStyle(e), m = s.backgroundImage.match(/url\(["']?([^"')]+)["']?\)/); if (!m) continue;
  const r = e.getBoundingClientRect(); if (!vis(e) || r.width < 160 || r.height < 120) continue;
  const src = new URL(m[1], location.href).href; seen.set(src, (seen.get(src) || 0) + 1); if (seen.get(src) > 1) continue;
  items.push({ src, kind: 'background', alt: e.getAttribute('aria-label'), natural: null, rendered: [Math.round(r.width), Math.round(r.height)], y: Math.round(r.top + scrollY) });
}
items.sort((a, b) => a.y - b.y);
const shown = items.slice(0, 40);
const box = document.createElement('div');
box.setAttribute('style', 'position:fixed!important;inset:0!important;z-index:2147483647!important;background:#fff!important;padding:6px!important;display:grid!important;grid-template-columns:repeat(auto-fill,minmax(168px,1fr))!important;grid-auto-rows:158px!important;gap:6px!important;overflow:hidden!important;font:11px/1.2 Arial,sans-serif!important;color:#111!important');
const loads = [];
shown.forEach((it, n) => {
  const cell = document.createElement('div');
  cell.setAttribute('style', 'display:flex!important;flex-direction:column!important;gap:2px!important;margin:0!important;padding:0!important;min-width:0!important');
  const im = document.createElement('img');
  im.setAttribute('style', 'width:100%!important;height:104px!important;max-width:none!important;object-fit:contain!important;background:#eee!important;display:block!important;margin:0!important;border:0!important');
  loads.push(new Promise(res => { im.onload = im.onerror = res; setTimeout(res, 3000); }));
  im.src = it.src;
  const cap = document.createElement('div');
  cap.setAttribute('style', 'overflow:hidden!important;white-space:nowrap!important;text-overflow:ellipsis!important');
  const dup = seen.get(it.src) > 1 ? ' ×' + seen.get(it.src) : '';
  cap.textContent = (n + 1) + '. ' + file(it.src) + dup;
  const size = document.createElement('div');
  size.setAttribute('style', 'white-space:nowrap!important;color:#111!important');
  size.textContent = (it.natural ? it.natural.join('×') + ' → ' : 'фон, на экране ') + it.rendered.join('×');
  const alt = document.createElement('div');
  alt.setAttribute('style', 'overflow:hidden!important;white-space:nowrap!important;text-overflow:ellipsis!important;color:#555!important');
  alt.textContent = it.alt === null ? 'alt нет' : it.alt === '' ? 'alt=""' : 'alt: ' + it.alt;
  cell.append(im, cap, size, alt); box.append(cell);
});
document.body.append(box);
await Promise.all(loads);
return { pictures: items.length, shown: shown.length, more: Math.max(0, items.length - shown.length),
  repeated: [...seen].filter(([, n]) => n > 1).map(([u, n]) => ({ file: file(u), times: n })),
  list: shown.map((it, n) => ({ n: n + 1, file: file(it.src), kind: it.kind, alt: it.alt, natural: it.natural, rendered: it.rendered, y: it.y })) };
