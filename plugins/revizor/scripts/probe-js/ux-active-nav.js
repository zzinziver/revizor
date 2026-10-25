// Revizor built-in probe ux-active-nav.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/ux-active-nav.js" --no-shot
// Active menu item: is the link to the current page marked, and does it look different from its neighbours
const here = location.href.split('#')[0].replace(/\/$/, '');
const pick = el => { const cs = getComputedStyle(el); return { color: cs.color, bg: cs.backgroundColor, weight: cs.fontWeight, deco: cs.textDecorationLine, border: cs.borderBottomWidth + ' ' + cs.borderBottomStyle, opacity: cs.opacity }; };
const isCurrent = a => {
  const ac = a.getAttribute('aria-current');
  if (ac && ac !== 'false') return true;
  const raw = a.getAttribute('href') || '';
  if (raw.startsWith('#') || /#./.test(a.href)) return false; // anchor links point to blocks, not to this page as a section
  return a.href.split('#')[0].replace(/\/$/, '') === here;
};
const res = [];
for (const nav of document.querySelectorAll('header, nav, [role=navigation]')) {
  const links = [...nav.querySelectorAll('a[href]')].filter(a => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
  if (links.length < 2) continue;
  const cur = links.filter(isCurrent);
  for (const a of cur) {
    if (res.some(x => x.el === a)) continue;
    const me = pick(a);
    const others = links.filter(x => x !== a && !cur.includes(x)).slice(0, 4).map(pick);
    const diff = others.length ? Object.keys(me).filter(k => others.every(o => o[k] !== me[k])) : [];
    res.push({ el: a, text: (a.innerText || '').trim().slice(0, 40), aria_current: a.getAttribute('aria-current'), looks_different_by: diff, me, neighbour: others[0] || null });
  }
  if (res.length >= 6) break;
}
return { url: here, active: res.map(({ el, ...x }) => x), none_marked: res.length === 0 };
