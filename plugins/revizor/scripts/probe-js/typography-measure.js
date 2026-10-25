// Revizor built-in probe typography-measure.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/typography-measure.js" --no-shot
// typography of running text: chars per line, line height, justify, long caps, tabular digits in prices
const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && +s.opacity > 0.05; };
const name = e => e.id ? '#' + e.id : e.tagName.toLowerCase() + [...e.classList].slice(0, 2).map(c => '.' + c).join('');
// rendered lines of an element: one entry per line with its painted width (fragments of one line are merged)
const lineBoxes = e => { const g = document.createRange(); g.selectNodeContents(e); const fs = parseFloat(getComputedStyle(e).fontSize) || 16;
  const rs = [...g.getClientRects()].filter(x => x.width > 1).sort((a, b) => a.top - b.top || a.left - b.left), out = [];
  for (const r of rs) { const L = out[out.length - 1]; if (L && r.top - L.top <= fs * 0.6) { L.l = Math.min(L.l, r.left); L.r = Math.max(L.r, r.right); } else out.push({ top: r.top, l: r.left, r: r.right }); }
  return out.map(x => x.r - x.l); };
const BLOCK = 'p, li, dd, blockquote';
const paras = [...document.querySelectorAll(BLOCK)].filter(e => vis(e) && !e.querySelector(BLOCK) && (e.innerText || '').trim().length >= 80).slice(0, 60);
const rows = paras.map(e => { const s = getComputedStyle(e), t = e.innerText.trim().replace(/\s+/g, ' '), w = lineBoxes(e), n = Math.max(1, w.length), fs = parseFloat(s.fontSize);
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  // chars per line = widest (full) line × average char width; only meaningful from 2 lines
  const cpl = n >= 2 ? Math.round(Math.max(...w) * t.length / sum) : null;
  const lhNormal = s.lineHeight === 'normal';
  return { sel: name(e), chars: t.length, lines: n, chars_per_line: cpl, font_px: fs,
    line_ratio: lhNormal ? 1.2 : Math.round(parseFloat(s.lineHeight) / fs * 100) / 100, line_height_normal: lhNormal,
    justify: s.textAlign === 'justify', hyphens: s.hyphens, caps: s.textTransform === 'uppercase', sample: t.slice(0, 40) }; });
const multi = rows.filter(r => r.lines >= 2);
const cpl = multi.map(r => r.chars_per_line).sort((a, b) => a - b);
const median = cpl.length ? cpl[cpl.length >> 1] : null;
const hi = innerWidth < 600 ? 60 : 75;
const caps = [...document.querySelectorAll('p, li, a, button, span, div')].filter(e => vis(e) && !e.children.length && getComputedStyle(e).textTransform === 'uppercase' && (e.innerText || '').trim().split(/\s+/).length >= 6).map(e => ({ sel: name(e), words: e.innerText.trim().split(/\s+/).length, sample: e.innerText.trim().slice(0, 40) })).slice(0, 10);
const priceRe = /\d[\d\s ]*([.,]\d+)?\s?(₽|руб|\$|€|£)/;
const prices = [...document.querySelectorAll('body *')].filter(e => vis(e) && !e.children.length && (e.textContent || '').trim().length <= 24 && priceRe.test(e.textContent || '')).slice(0, 40);
const noTnum = prices.filter(e => { const s = getComputedStyle(e); return !/tabular-nums/.test(s.fontVariantNumeric) && !/tnum/.test(s.fontFeatureSettings); }).map(e => ({ sel: name(e), text: e.textContent.trim().slice(0, 30) })).slice(0, 10);
return { width: innerWidth, paragraphs: rows.length, measured: multi.length, chars_per_line_median: median, norm: innerWidth < 600 ? '35–60' : '60–75',
  long_lines: multi.filter(r => r.chars_per_line > hi).sort((a, b) => b.chars_per_line - a.chars_per_line).slice(0, 8),
  lines_100_plus: multi.filter(r => r.chars_per_line >= 100).length,
  tight_leading: multi.filter(r => r.line_ratio < 1.5).sort((a, b) => a.line_ratio - b.line_ratio).slice(0, 8),
  justify_no_hyphens: rows.filter(r => r.justify && r.hyphens !== 'auto').map(r => r.sel).slice(0, 8),
  long_caps: caps, prices: prices.length, prices_without_tnum: noTnum };
