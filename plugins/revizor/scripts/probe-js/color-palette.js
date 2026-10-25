// Revizor built-in probe color-palette.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/color-palette.js" --no-shot
// palette in use: text, background and border colours by frequency; colour tokens on :root; colour literals outside tokens
const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && +s.opacity > 0.05; };
const clear = c => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);
const T = new Map(), BG = new Map(), BR = new Map(); const add = (m, k, w) => m.set(k, (m.get(k) || 0) + w);
for (const e of [document.documentElement, document.body, ...document.querySelectorAll('body *')]) {
  if (!vis(e)) continue; const s = getComputedStyle(e);
  const own = [...e.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent.trim()).join('');
  if (own) add(T, s.color, own.length);
  if (!clear(s.backgroundColor)) { const r = e.getBoundingClientRect(); add(BG, s.backgroundColor, Math.round(r.width * r.height / 1000)); }
  if (parseFloat(s.borderTopWidth) > 0 && s.borderTopStyle !== 'none' && !clear(s.borderTopColor)) add(BR, s.borderTopColor, 1);
}
const top = (m, n = 12) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([color, weight]) => ({ color, weight }));
const tokens = [], literals = new Map(); let unreadable = 0;
const colorRe = /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
for (const sh of document.styleSheets) {
  let rules; try { rules = sh.cssRules; } catch (e) { unreadable++; continue; }
  const walk = list => { for (const r of list || []) {
    if (r.cssRules && !r.style) { walk(r.cssRules); continue; }
    if (!r.style) continue;
    for (let i = 0; i < r.style.length; i++) { const p = r.style[i], v = r.style.getPropertyValue(p);
      if (p.startsWith('--')) { if (colorRe.test(v) && tokens.length < 60) tokens.push(p + ': ' + v.trim()); colorRe.lastIndex = 0; continue; }
      for (const m of v.match(colorRe) || []) add(literals, m.toLowerCase().replace(/\s+/g, ''), 1); }
  } }; walk(rules);
}
return { text_colors: top(T), background_colors: top(BG), border_colors: top(BR, 8), distinct: { text: T.size, background: BG.size, border: BR.size },
  root_tokens: tokens, literal_colors_outside_tokens: literals.size, literal_examples: top(literals, 15), sheets_unreadable: unreadable };
