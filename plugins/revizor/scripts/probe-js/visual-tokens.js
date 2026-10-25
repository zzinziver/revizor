// Revizor built-in probe visual-tokens.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/visual-tokens.js" --no-shot
// visual tokens of the loaded page: buttons, radii, eyebrows, section backgrounds, content edges
const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && +s.opacity > 0.05; };
const name = e => e.id ? '#' + e.id : e.tagName.toLowerCase() + [...e.classList].slice(0, 2).map(c => '.' + c).join('');
const clear = c => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
const tally = (m, k, ex) => { const v = m.get(k) || { n: 0, ex: [] }; v.n++; if (v.ex.length < 3) v.ex.push(ex); m.set(k, v); };
const top = m => [...m].sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, v]) => ({ value: k, n: v.n, ex: v.ex }));
const btns = [...document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button]')].filter(e => {
  if (!vis(e)) return false; const s = getComputedStyle(e), t = (e.innerText || e.value || '').trim();
  return t && t.length < 40 && (!clear(s.backgroundColor) || (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none'));
});
const H = new Map(), R = new Map(), BG = new Map();
for (const b of btns) { const s = getComputedStyle(b); tally(H, Math.round(b.getBoundingClientRect().height), name(b)); tally(R, s.borderTopLeftRadius, name(b)); if (!clear(s.backgroundColor)) tally(BG, s.backgroundColor, name(b)); }
const CR = new Map();
for (const e of document.querySelectorAll('article,li,div,figure,aside')) {
  if (!vis(e)) continue; const s = getComputedStyle(e), r = e.getBoundingClientRect();
  const framed = (!clear(s.backgroundColor) && e.parentElement && getComputedStyle(e.parentElement).backgroundColor !== s.backgroundColor) || parseFloat(s.borderTopWidth) > 0 || s.boxShadow !== 'none';
  if (framed && r.width >= 120 && r.width < innerWidth * 0.95 && r.height >= 60) tally(CR, s.borderTopLeftRadius, name(e));
}
const FR = new Map();
for (const f of document.querySelectorAll('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),select,textarea')) if (vis(f)) tally(FR, getComputedStyle(f).borderTopLeftRadius, name(f));
// eyebrow = a short small caption right before an H2, in caps or tracked out (same rule as layout.json → tokens.eyebrows)
const h2s = [...document.querySelectorAll('h2')].filter(vis);
let eyebrows = 0; const eyEx = [];
for (const h of h2s) {
  let p = h.previousElementSibling; if (!p && h.parentElement && h.parentElement.firstElementChild === h) p = h.parentElement.previousElementSibling;
  if (!p || !vis(p)) continue; const s = getComputedStyle(p), t = (p.innerText || '').trim(), fs = parseFloat(s.fontSize) || 16;
  if (!t || t.length > 40 || /\n/.test(t)) continue;
  const caps = s.textTransform === 'uppercase' || (t === t.toUpperCase() && /\p{Lu}/u.test(t));
  if (fs <= 14 && (caps || (parseFloat(s.letterSpacing) || 0) >= 0.08 * fs)) { eyebrows++; if (eyEx.length < 4) eyEx.push(t); }
}
// sections: outermost <section> or blocks whose class token names a section (section, page-section, section--dark),
// not BEM parts (section__title, section-inner); a builder with other block names → visible top-level blocks of <main>
const SEC = /^(?:[a-z0-9]+[-_])*section(?:--[\w-]+)?$/i;
const cand = [...document.querySelectorAll('section, [class*=section i]')].filter(e => (e.tagName === 'SECTION' || [...e.classList].some(c => SEC.test(c))) && vis(e));
const inCand = new Set(cand);
let sections = cand.filter(e => { for (let p = e.parentElement; p; p = p.parentElement) if (inCand.has(p)) return false; return true; });
let sectionsFrom = 'section';
if (sections.length < 3) {
  let root = document.querySelector('main') || document.body, kids = [...root.children].filter(vis);
  while (kids.length === 1) { root = kids[0]; kids = [...root.children].filter(vis); }
  kids = kids.filter(e => { const r = e.getBoundingClientRect(); return r.height >= 120 && r.width >= innerWidth * 0.5; });
  if (kids.length > sections.length) { sections = kids; sectionsFrom = 'blocks'; }
}
sections = sections.slice(0, 40);
// own background of a section: colour, 'image' (picture or gradient) or 'transparent' (shows what is behind)
const ownBg = e => { const s = getComputedStyle(e); return s.backgroundImage !== 'none' ? 'image' : clear(s.backgroundColor) ? 'transparent' : s.backgroundColor; };
const bgSeq = sections.map(ownBg);
const sameBgInRow = bgSeq.filter((c, i) => i > 0 && c !== 'transparent' && c !== 'image' && c === bgSeq[i - 1]).length;
const transparentInRow = bgSeq.filter((c, i) => i > 0 && c === 'transparent' && bgSeq[i - 1] === 'transparent').length;
const edges = new Map();
for (const sec of sections) { const t = [...sec.querySelectorAll('h1,h2,h3,p')].find(vis); if (t) tally(edges, Math.round(t.getBoundingClientRect().left), name(sec)); }
const lines = e => { const g = document.createRange(); g.selectNodeContents(e); const fs = parseFloat(getComputedStyle(e).fontSize) || 16;
  const tops = [...g.getClientRects()].filter(x => x.width > 1).map(x => x.top).sort((a, b) => a - b); return tops.filter((t, i) => i === 0 || t - tops[i - 1] > fs * 0.6).length; };
const ctaTwoLines = btns.filter(b => lines(b) > 1).map(b => name(b) + ' «' + (b.innerText || '').trim().slice(0, 30) + '»').slice(0, 8);
return { width: innerWidth, buttons: btns.length, button_heights: top(H), button_radii: top(R), button_backgrounds: top(BG), card_radii: top(CR), field_radii: top(FR),
  sections: sections.length, sections_from: sectionsFrom, section_names: sections.map(name).slice(0, 20), h2: h2s.length, eyebrows, eyebrows_norm: Math.ceil(h2s.length / 3), eyebrow_examples: eyEx,
  section_bg: bgSeq, same_bg_in_row: sameBgInRow, transparent_in_row: transparentInRow, content_left_edges: top(edges), cta_two_lines: ctaTwoLines };
