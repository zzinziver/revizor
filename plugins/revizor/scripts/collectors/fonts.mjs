// Revizor collector «fonts» — what fonts the page really draws → measure/fonts.json.
// Collector interface: meta, collect(page, ctx), finalize(all, ctx) → { files, lines, summary }; called by snapshot.mjs.
//  · document.fonts: web fonts declared and their status (loaded / unloaded / error), font-display;
//  · @font-face rules from all stylesheets (CDP, cross-origin included): font-display, unicode-range, src;
//  · computed styles by role: h1, h2, h3, body text, button, nav link, input, small print, price;
//  · CSS.getPlatformFontsForNode for h1, h2, text and button: the font that drew the glyphs, and
//    whether a system fallback drew part of them (no Cyrillic, «₽», «№» in the web font);
//  · glyph check of used web fonts by canvas width (Ёё № «» — – − ₽ × ° nbsp);
//  · font files from Resource Timing (sizes, duplicates under several URLs), Google Fonts usage.

import { existsSync } from 'node:fs';
import { ensureHelpers, ev, loadInfo, groupByPid, logDropped, getCssAnalysis, writeMeasureMerged, pageEntry, updatePageJson } from './meta.mjs';
import { nowIso, hostOf, insideRun, readJSON } from '../lib/util.mjs';

export const meta = { name: 'fonts', widths: [390, 1440], order: 16 };

const PLATFORM_ROLES = ['h1', 'h2', 'text', 'button'];
const GLYPHS = ['Ё', 'ё', 'Ж', 'й', '№', '«', '»', '„', '“', '—', '–', '−', '₽', '×', '°', '…', '·'];
// short prepositions, conjunctions and particles that should not end a line (RU typography; EN articles)
const SHORT_WORDS = ['в', 'во', 'и', 'а', 'но', 'на', 'с', 'со', 'к', 'ко', 'о', 'об', 'обо', 'у', 'по', 'за', 'из', 'изо', 'от', 'до', 'не', 'ни', 'да',
  'для', 'без', 'при', 'про', 'под', 'над', 'или', 'ли', 'же', 'бы', 'то', 'что', 'как', 'a', 'an', 'the', 'of', 'to', 'in', 'on', 'and', 'or', 'for', 'at', 'by'];

function fontRolesInPage(L) {
  const H = window.__revizorH;
  const q = s => { try { return [...document.querySelectorAll(s)]; } catch { return []; } };
  // first shown element of the list; one that is transparent (an inactive slide with opacity 0) only when no opaque one exists
  const firstShown = (list, pred) => {
    let faint = null;
    for (const el of list) {
      if ((!pred || pred(el)) && H.shown(el, { opacity: false })) { if (H.opaque(el)) return el; if (!faint) faint = el; }
    }
    return faint;
  };
  const ownText = el => { let s = ''; for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue; return s.trim(); };
  const R = H.regions();
  const inMain = el => H.regionOf(el) === 'main';
  const vs = H.vv().scale; // < 1: a phone page without meta viewport, the screen shows CSS sizes × vs
  const roles = {
    h1: firstShown(q('h1')),
    h2: firstShown(q('h2')),
    h3: firstShown(q('h3')),
    text: null, // chosen below: the most common size of body text, not the first long paragraph (that may be a footnote)
    button: firstShown(q('button, a, [role="button"], input[type="submit" i]'), el => {
      if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.getAttribute('role') === 'button') return (H.textOf(el) || el.value || '').trim().length > 1;
      const cs = H.cs(el); const bg = cs.backgroundColor;
      return /(^|[\s_-])(btn|button|cta)([\s_-]|$)/i.test(H.cls(el)) || (bg && !/rgba\(0, 0, 0, 0\)|transparent/.test(bg) && parseFloat(cs.paddingLeft) >= 8 && (H.textOf(el) || '').trim().length > 1);
    }),
    nav: firstShown(q('header a, nav a, [role="navigation"] a').concat(R.header.flatMap(h => [...h.querySelectorAll('a')])), el => (H.textOf(el) || '').trim().length > 1),
    input: firstShown(q('input:not([type="hidden" i]):not([type="checkbox" i]):not([type="radio" i]):not([type="submit" i]):not([type="button" i]), textarea, select')),
    footer: firstShown(R.footer.flatMap(f => [...f.querySelectorAll('p, span, div, a, small, li')]), el => ownText(el).length >= 10),
    // a price: short own text with a currency, not a heading that mentions a price
    price: firstShown(q('body *'), el => el.children.length <= 2 && !el.closest('h1, h2, h3, h4, h5, h6, [role="heading"]') && ownText(el).length <= 60 && /\d[\d\s .,]*\s?(₽|руб|р\.|\$|€|£)/i.test(ownText(el))),
  };
  {
    // body text role: weighted mode of the font size over shown paragraphs of main, then the first block of that size
    const cands = [];
    for (const el of q('p, li, dd, article div, main div, section div')) {
      if (cands.length >= 400) break;
      const t = ownText(el).length;
      if (t < 40 || !inMain(el) || el.closest('h1,h2,h3,h4,button,a,nav') || H.deco(el) || !H.shown(el, { opacity: false })) continue;
      cands.push([el, t, parseFloat(H.cs(el).fontSize) || 0, H.opaque(el)]);
    }
    // transparent blocks (inactive slides, opacity 0) are not on the frame: used only when nothing else is there
    if (cands.some(c => c[3])) for (let i = cands.length - 1; i >= 0; i--) if (!cands[i][3]) cands.splice(i, 1);
    const by = {};
    for (const [, t, fs] of cands) by[fs] = (by[fs] || 0) + t;
    const best = Object.entries(by).sort((a, b) => b[1] - a[1])[0];
    if (best) roles.text = (cands.find(c => c[2] === +best[0] && c[1] >= 60) || cands.find(c => c[2] === +best[0]))[0];
  }
  if (!roles.text) roles.text = firstShown(q('p, li'), el => ownText(el).length >= 20 && !H.deco(el)) || (document.body ? H.textHolder(document.body) : null);
  // line boxes of the element's text (Range rects grouped by top)
  const lineCount = el => {
    try { const rg = document.createRange(); rg.selectNodeContents(el); const tops = new Set([...rg.getClientRects()].filter(x => x.width > 1).map(x => Math.round(x.top))); return tops.size || null; } catch { return null; }
  };
  const describe = el => {
    if (!el) return null;
    const holder = el.matches('input, textarea, select') ? el : H.textHolder(el);
    const cs = H.cs(holder);
    const fs = parseFloat(cs.fontSize);
    const lh = cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight);
    const r = holder.getBoundingClientRect();
    const lines = lh ? Math.max(1, Math.round(r.height / lh)) : null;
    const byRects = holder.matches('input, textarea, select') ? null : lineCount(holder);
    // line-height: normal → ratio estimated from a block holder's height (≈ 1.1–1.25 for most fonts)
    const blockish = !/^inline/.test(cs.display);
    const inner = r.height - ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((a, k) => a + (parseFloat(cs[k]) || 0), 0);
    const est = !lh && byRects && blockish && fs && inner > 0 ? Math.round(100 * (inner / byRects) / fs) / 100 : null;
    const txt = (H.textOf(holder) || '').replace(/\s+/g, ' ').trim();
    return { selector: H.sel(el), tag: el.tagName.toLowerCase(), text: H.clean(H.textOf(el) || el.value || '', 50),
      family: cs.fontFamily, family_first: (cs.fontFamily.split(',')[0] || '').replace(/["']/g, '').trim(),
      size: fs, size_on_screen: vs < 1 ? Math.round(fs * vs * 10) / 10 : undefined, weight: cs.fontWeight, style: cs.fontStyle, line_height: lh ?? (cs.lineHeight === 'normal' ? 'normal' : null),
      line_ratio: lh && fs ? Math.round(100 * lh / fs) / 100 : est, line_ratio_estimated: est !== null || undefined,
      letter_spacing: cs.letterSpacing, transform: cs.textTransform, variant_numeric: cs.fontVariantNumeric, feature_settings: cs.fontFeatureSettings,
      synthesis: cs.fontSynthesis, lines: lines ?? byRects, lines_by_rects: byRects,
      // average characters per line of a multi-line text block (norm: 35–60 on a phone, 60–75 on a desktop)
      chars_per_line: byRects && byRects >= 2 && txt.length >= 80 ? Math.round(txt.length / byRects) : null,
      width_px: Math.round(r.width), region: H.regionOf(el), transparent: !H.opaque(el) || undefined };
  };
  // chars by first family and by weight over shown text (a page with 4+ families is a finding)
  const fam = {}, weights = {}, italic = { chars: 0 };
  let total = 0, smallest = null, smallestFs = Infinity;
  const usedGlyphs = {};
  const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeValue.trim() ? 1 : 3 });
  const seen = new WeakMap(); let n, steps = 0;
  while ((n = tw.nextNode()) && steps++ < 60000) {
    const p = n.parentElement; if (!p) continue;
    let ok = seen.get(p);
    if (ok === undefined) { ok = !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(p.tagName) && H.rendered(p) && H.opaque(p); seen.set(p, ok); }
    if (!ok) continue;
    const c = n.nodeValue.replace(/\s+/g, '').length; if (!c) continue;
    const cs = H.cs(p);
    const f = (cs.fontFamily.split(',')[0] || '').replace(/["']/g, '').trim();
    fam[f] = (fam[f] || 0) + c; weights[cs.fontWeight] = (weights[cs.fontWeight] || 0) + c;
    // checked glyphs that this family really has to draw on the page
    for (const g of L.glyphs || []) if (n.nodeValue.includes(g)) (usedGlyphs[f] ||= new Set()).add(g);
    if (cs.fontStyle !== 'normal') italic.chars += c;
    total += c;
    // «small print» role: the smallest shown text of at least 10 characters (not clipped away)
    const fsz = parseFloat(cs.fontSize) || 0;
    if (c >= 10 && fsz && fsz < smallestFs && !H.clipped(p) && !H.deco(p)) { smallestFs = fsz; smallest = p; }
  }
  roles.small = smallest;
  const out = {}; H._fontEls = {};
  for (const [k, el] of Object.entries(roles)) { out[k] = describe(el); if (el) H._fontEls[k] = el.matches('input, textarea, select') ? el : H.textHolder(el); }
  if (document.body) { // the body rule itself (inherited default), not the first text holder
    const cs = H.cs(document.body), fs = parseFloat(cs.fontSize), lh = cs.lineHeight === 'normal' ? null : parseFloat(cs.lineHeight);
    out.body = { selector: 'body', tag: 'body', family: cs.fontFamily, family_first: (cs.fontFamily.split(',')[0] || '').replace(/["']/g, '').trim(), size: fs, weight: cs.fontWeight,
      style: cs.fontStyle, line_height: lh, line_ratio: lh && fs ? Math.round(100 * lh / fs) / 100 : null, letter_spacing: cs.letterSpacing, variant_numeric: cs.fontVariantNumeric };
  }
  const faces = [];
  try { for (const f of document.fonts) faces.push({ family: f.family.replace(/["']/g, ''), style: f.style, weight: f.weight, display: f.display, unicode_range: f.unicodeRange === 'U+0-10FFFF' ? null : f.unicodeRange.slice(0, 300), status: f.status }); } catch {}
  const usedFamilies = [...new Set([...faces.filter(f => f.status === 'loaded' || f.status === 'loading').map(f => f.family), ...Object.keys(fam)].map(x => x.toLowerCase()))];
  const pageText = document.body ? document.body.innerText || '' : '';
  return { roles: out, visual_scale: vs < 1 ? Math.round(vs * 1000) / 1000 : 1, families_by_chars: fam, weights_by_chars: weights, italic_chars: italic.chars, total_chars: total, document_fonts: faces.slice(0, 120), used_families: usedFamilies.slice(0, 60),
    glyphs_used: Object.fromEntries(Object.entries(usedGlyphs).map(([f, s]) => [f, [...s]])),
    fonts_status: document.fonts ? document.fonts.status : null, has_cyrillic: /[А-Яа-яЁё]/.test(pageText),
    google_css: q('link[href*="fonts.googleapis.com"], link[href*="fonts.bunny.net"], link[href*="use.typekit.net"], link[href*="fonts.yandex"]').map(l => l.href.slice(0, 400)) };
}

// Line breaks as rendered on this width (Range rects of every word): a short preposition at the end of a line,
// a number torn from its unit or a range torn in two («2–» / «4 дня», «3» / «000 ₽», «₽» alone), a dash opening
// a line, one word alone on the last line of a heading. Headings, button-like elements and short blocks with numbers.
function lineBreaksInPage(o) {
  const H = window.__revizorH;
  const SHORT = new Set(o.short);
  const els = [], kinds = new Map();
  const add = (el, kind) => { if (els.length >= o.maxEls || kinds.has(el)) return; if (!H.shown(el, { opacity: false })) return; els.push(el); kinds.set(el, kind); };
  for (const el of document.querySelectorAll('h1, h2, h3, h4, [role="heading"]')) add(el, 'heading');
  for (const el of document.querySelectorAll('button, [role="button"], a, input[type="submit" i]')) {
    if (els.length >= o.maxEls) break;
    const t = (el.innerText || '').trim();
    if (!t || t.length > 80 || el.closest('h1, h2, h3, h4')) continue;
    if (el.tagName === 'A') {
      const cs = H.cs(el);
      const filled = cs.backgroundColor && !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor);
      if (!/(^|[\s_-])(btn|button|cta)([\s_-]|$)/i.test(H.cls(el)) && !filled) continue;
    }
    add(el, 'button');
  }
  // short text blocks with digits: only blocks whose children are inline (prices, phones, «3 000 ₽»), one per text
  const inlineKids = el => [...el.children].every(c => c.tagName === 'BR' || /^inline/.test(H.cs(c).display));
  const insideAdded = el => { for (let a = el.parentElement; a; a = a.parentElement) if (kinds.has(a)) return true; return false; };
  for (const el of document.querySelectorAll('p, li, td, th, dd, dt, span, strong, b, div, small')) {
    if (els.length >= o.maxEls) break;
    if (el.children.length > 3 || kinds.has(el)) continue;
    const t = el.textContent || '';
    if (t.length > 200 || !/\d/.test(t)) continue;
    if (/^inline/.test(H.cs(el).display) || !inlineKids(el) || insideAdded(el)) continue;
    add(el, 'number');
  }
  const strip = s => s.replace(/^[«"„“(\[]+|[»"“”)\].,:;!?…]+$/g, '').toLowerCase();
  const rg = document.createRange();
  const out = [];
  let checked = 0;
  for (const el of els) {
    const words = [];
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeValue.trim() ? 1 : 3 });
    let n;
    while ((n = tw.nextNode()) && words.length < 80) {
      const re = /[^ \t\n\r\f]+/g; // a no-break space glues words: it is not a break opportunity
      let m;
      while ((m = re.exec(n.nodeValue)) && words.length < 80) {
        rg.setStart(n, m.index); rg.setEnd(n, m.index + m[0].length);
        const rs = [...rg.getClientRects()].filter(r => r.width > 0 && r.height > 0);
        if (rs.length) words.push({ w: m[0], top: rs[0].top, h: rs[0].height });
      }
    }
    if (words.length < 2) continue;
    checked++;
    const lines = []; let cur = [words[0]];
    for (let i = 1; i < words.length; i++) {
      const prev = cur[cur.length - 1], w = words[i];
      if (w.top > prev.top + Math.max(2, prev.h * 0.5)) { lines.push(cur); cur = [w]; } else cur.push(w);
    }
    lines.push(cur);
    if (lines.length < 2) continue;
    const issues = [];
    for (let li = 0; li < lines.length - 1; li++) {
      const last = lines[li][lines[li].length - 1].w, next = lines[li + 1][0].w;
      if (SHORT.has(strip(last))) issues.push({ type: 'hanging', word: last, line: li + 1 });
      if ((/\d$/.test(last) && /^(\d|₽|руб|р\.|%|°|км|м(?!\p{L})|кг|г\.|мин|ч(?!\p{L})|сек|шт|€|\$|£|млн|млрд|тыс)/iu.test(next)) || (/\d[–-]$/.test(last) && /^\d/.test(next)))
        issues.push({ type: 'split_number', at: last + ' / ' + next, line: li + 1 });
      else if (/^(₽|руб\.?|%)$/i.test(next)) issues.push({ type: 'unit_alone', at: last + ' / ' + next, line: li + 1 });
      if (/^[—–]$/.test(next)) issues.push({ type: 'dash_starts_line', at: last + ' / ' + next, line: li + 2 });
    }
    const lastLine = lines[lines.length - 1];
    // one word alone on the last line of a heading of 3+ words (words glued by a no-break space count apart:
    // «и кофе» on its own line is a deliberate glue, not a widow)
    const realWords = s => s.split(/\s+/).filter(x => /[\p{L}\p{N}]/u.test(x)).length;
    const totalWords = words.reduce((a, w) => a + realWords(w.w), 0);
    if (kinds.get(el) === 'heading' && totalWords >= 3 && lastLine.length === 1 && realWords(lastLine[0].w) === 1 && lines.length >= 2 && strip(lastLine[0].w).length <= 12)
      issues.push({ type: 'widow', word: lastLine[0].w, line: lines.length });
    if (issues.length) out.push({ kind: kinds.get(el), selector: H.sel(el), tag: el.tagName.toLowerCase(), text: H.clean(H.textOf(el) || el.value || '', 90), lines: lines.length, region: H.regionOf(el), box: H.box(el), issues });
  }
  const count = t => out.reduce((a, x) => a + x.issues.filter(i => i.type === t).length, 0);
  return { checked, elements: els.length, capped: els.length >= o.maxEls,
    counts: { hanging: count('hanging'), split_number: count('split_number'), unit_alone: count('unit_alone'), dash_starts_line: count('dash_starts_line'), widow: count('widow') },
    items: out.slice(0, 40) };
}

// canvas: does the web font have these glyphs, or does a fallback draw them?
async function glyphCheckInPage(families, glyphs) {
  const c = document.createElement('canvas').getContext('2d');
  const res = {};
  for (const fam of families) {
    const quoted = '"' + fam.replace(/"/g, '') + '"';
    try { await Promise.race([document.fonts.load('32px ' + quoted, glyphs.join('')), new Promise(r => setTimeout(r, 3000))]); } catch {}
    const missing = [];
    for (const g of glyphs) {
      let same = 0;
      for (const fb of ['monospace', 'serif']) {
        c.font = '32px ' + fb; const w0 = c.measureText(g).width;
        c.font = '32px ' + quoted + ', ' + fb; const w1 = c.measureText(g).width;
        if (Math.abs(w0 - w1) < 0.01) same++;
      }
      if (same === 2) missing.push(g);
    }
    let loaded = false; try { loaded = document.fonts.check('32px ' + quoted); } catch {}
    res[fam] = { missing, checked: glyphs.length, loaded };
  }
  return res;
}

function fontFilesInPage() {
  const out = [];
  try {
    for (const e of performance.getEntriesByType('resource')) {
      if (!/\.(woff2?|ttf|otf|eot)(\?|#|$)/i.test(e.name) && !/fonts\.gstatic\.com\//.test(e.name)) continue;
      out.push({ url: e.name.slice(0, 400), transfer: e.transferSize || 0, encoded: e.encodedBodySize || 0, ms: Math.round(e.duration), start: Math.round(e.startTime) });
    }
  } catch {}
  return out;
}

// role elements inside a skipped content-visibility:auto section have no platform fonts: render them for the query.
// After the unskip the layout is forced (a box read on each role element) and one frame is awaited, so the text
// of the section is laid out and painted before CDP asks which fonts drew it.
async function unskipRoleEls(roles) {
  const H = window.__revizorH;
  const els = roles.map(r => H._fontEls && H._fontEls[r]).filter(Boolean);
  const list = [...new Set(els.flatMap(el => H.cvAncestors(el)))];
  H._undoFontCv = list.length ? H.unskip(list) : null;
  for (const el of els) { try { void el.getBoundingClientRect(); } catch {} }
  await new Promise(r => { let done = false; const end = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => end()); setTimeout(end, 150); });
  return list.length;
}
async function nextFrame() { await new Promise(r => { let done = false; const end = () => { if (!done) { done = true; r(); } }; requestAnimationFrame(() => end()); setTimeout(end, 150); }); const H = window.__revizorH; for (const el of Object.values(H._fontEls || {})) { try { void el.getBoundingClientRect(); } catch {} } return true; }
function restoreRoleEls() { const H = window.__revizorH; if (H._undoFontCv) { H._undoFontCv(); H._undoFontCv = null; } return true; }

async function platformFonts(page) {
  const res = {};
  try {
    await page.send('DOM.enable').catch(() => {});
    await page.send('DOM.getDocument', { depth: 0 });
    await page.send('CSS.enable').catch(() => {});
  } catch (e) { return { error: String(e.message).slice(0, 200) }; }
  // the helpers live in the isolated world when ev() chose it: look the elements up there
  let contextId;
  if (page.__rvWorld === 'iso' && typeof page.isolatedContextId === 'function') { try { contextId = await page.isolatedContextId(); } catch {} }
  const unskipped = await ev(page, unskipRoleEls, PLATFORM_ROLES).catch(() => 0);
  if (unskipped) res._unskipped_cv = unskipped;
  const query = async role => {
    let objectId = null;
    try {
      const r = await page.send('Runtime.evaluate', { expression: `(window.__revizorH && window.__revizorH._fontEls && window.__revizorH._fontEls[${JSON.stringify(role)}]) || null`, returnByValue: false, ...(contextId ? { contextId } : {}) });
      objectId = r.result && r.result.objectId;
      if (!objectId) return null;
      const { nodeId } = await page.send('DOM.requestNode', { objectId });
      if (!nodeId) return null;
      const { fonts } = await page.send('CSS.getPlatformFontsForNode', { nodeId });
      return (fonts || []).map(f => ({ family: f.familyName, postscript: f.postScriptName || null, custom: !!f.isCustomFont, glyphs: f.glyphCount }));
    } catch (e) { return { error: String(e.message).slice(0, 160) }; }
    finally { if (objectId) page.send('Runtime.releaseObject', { objectId }).catch(() => {}); }
  };
  try {
    for (const role of PLATFORM_ROLES) {
      let list = await query(role);
      if (list === null) continue;
      // an empty answer: the text was not laid out yet — one more frame, then ask again
      if (Array.isArray(list) && !list.length) { await ev(page, nextFrame).catch(() => {}); list = await query(role); res._retried = (res._retried || 0) + 1; }
      res[role] = Array.isArray(list) && !list.length ? { empty: true, why: 'no-layout' } : list;
    }
  } finally { await ev(page, restoreRoleEls).catch(() => {}); }
  return res;
}

// a web font that blocks text while loading (local()-only faces are metric fallbacks, not downloads)
const noDisplay = f => /url\(/i.test(f.src || '') && (!f.display || f.display === 'auto' || f.display === 'block');

const GENERIC_FAMILIES = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'ui-rounded', '-apple-system', 'blinkmacsystemfont', 'emoji', 'math', 'fangsong', 'inherit', 'initial']);

export async function collect(page, ctx = {}) {
  await ensureHelpers(page);
  const errors = [];
  const roles = await ev(page, fontRolesInPage, { glyphs: GLYPHS });
  const platform = await platformFonts(page).catch(e => ({ error: String(e.message).slice(0, 200) }));
  let css = null;
  try { css = await getCssAnalysis(page, ctx); } catch (e) { errors.push('css: ' + String(e.message).slice(0, 160)); }
  const webFamilies = new Set([...(roles.document_fonts || []).map(f => f.family), ...((css && css.font_faces) || []).map(f => f.family)].map(s => String(s).toLowerCase()));
  // used web fonts (top by chars + role fonts)
  const used = [...new Set([
    ...Object.entries(roles.families_by_chars).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f]) => f),
    ...Object.values(roles.roles).filter(Boolean).map(r => r.family_first),
  ])].filter(f => f && webFamilies.has(f.toLowerCase()) && !GENERIC_FAMILIES.has(f.toLowerCase())).slice(0, 6);
  let glyphs = {};
  try { glyphs = await ev(page, glyphCheckInPage, used, GLYPHS); } catch (e) { errors.push('glyphs: ' + String(e.message).slice(0, 160)); }
  // missing glyphs that the page text set in this family actually contains (the others never show up)
  for (const [f, g] of Object.entries(glyphs || {})) {
    const usedHere = (roles.glyphs_used || {})[f] || [];
    g.used = usedHere;
    g.missing_used = (g.missing || []).filter(x => usedHere.includes(x));
  }
  const files = await ev(page, fontFilesInPage).catch(() => []);
  let lineBreaks = null;
  try { lineBreaks = await ev(page, lineBreaksInPage, { short: SHORT_WORDS, maxEls: 400 }); } catch (e) { errors.push('line breaks: ' + String(e.message).slice(0, 160)); }

  // platform fonts → fallback detection per role
  const platformSummary = {};
  for (const [role, list] of Object.entries(platform || {})) {
    if (role.startsWith('_')) continue;
    const cssFirst = roles.roles[role] ? roles.roles[role].family_first : null;
    // { empty: true, why: 'no-layout' } or { error }: the role stays unchecked (summary.platform_unchecked)
    if (!Array.isArray(list)) {
      if (list && list.empty && !(roles.roles[role] && roles.roles[role].text)) continue; // no text to draw (an icon-only button)
      platformSummary[role] = { ...list, css_first: cssFirst }; continue;
    }
    const total = list.reduce((a, f) => a + (f.glyphs || 0), 0);
    const main = [...list].sort((a, b) => b.glyphs - a.glyphs)[0] || null;
    const cssWeb = cssFirst && webFamilies.has(cssFirst.toLowerCase());
    const matchesCss = f => cssFirst && (f.family || '').toLowerCase().replace(/\s+/g, '') .includes(cssFirst.toLowerCase().replace(/\s+/g, '').slice(0, 12));
    // system fonts that drew part of a web-font text: the fallback (a web font's internal name may differ from CSS — it is custom)
    const fb = cssWeb ? list.filter(f => !f.custom && !matchesCss(f)) : [];
    const fallbackGlyphs = fb.reduce((a, f) => a + f.glyphs, 0);
    platformSummary[role] = { css_first: cssFirst, css_is_webfont: !!cssWeb, drawn_by: main ? main.family : null, drawn_custom: main ? main.custom : null,
      glyphs_total: total, fallback_glyphs: fallbackGlyphs, fallback_families: [...new Set(fb.sort((a, b) => b.glyphs - a.glyphs).map(f => f.family))], fonts: list };
  }

  // duplicates: same file name under several URLs
  const byName = {};
  for (const f of files) { const name = f.url.split(/[?#]/)[0].split('/').pop(); (byName[name] ||= []).push(f.url); }
  const dupes = Object.entries(byName).filter(([, u]) => new Set(u).size > 1).map(([name, urls]) => ({ name, urls: [...new Set(urls)].slice(0, 6) }));
  // @font-face rules: «used» = a face of a family the page draws with (loaded/loading in document.fonts or with characters)
  const usedFam = new Set(roles.used_families || []);
  const ff = ((css && css.font_faces) || []).map(f => ({ ...f, used: usedFam.has(String(f.family).toLowerCase()) }));
  const li = loadInfo(page, ctx);
  const docStatus = {};
  for (const f of roles.document_fonts || []) docStatus[f.status] = (docStatus[f.status] || 0) + 1;
  return {
    final_url: li.final_url, captured: nowIso(),
    roles: roles.roles, families_by_chars: roles.families_by_chars, weights_by_chars: roles.weights_by_chars, italic_chars: roles.italic_chars, total_chars: roles.total_chars,
    has_cyrillic: roles.has_cyrillic, fonts_status: roles.fonts_status, visual_scale: roles.visual_scale,
    // the full lists are the same on every page: finalize moves them once to summary.font_faces / summary.document_fonts
    document_fonts: roles.document_fonts, document_fonts_status: docStatus,
    font_faces: ff.slice(0, 120), font_faces_count: ff.length, font_faces_no_display: ff.filter(f => f.used && noDisplay(f)).length,
    platform: platformSummary, glyphs, line_breaks: lineBreaks,
    files: { count: files.length, bytes_known: files.reduce((a, f) => a + (f.transfer || f.encoded || 0), 0), size_unknown: files.filter(f => !f.transfer && !f.encoded).length,
      hosts: [...new Set(files.map(f => hostOf(f.url)))], duplicates: dupes, list: files.slice(0, 40) },
    google_fonts: { css: roles.google_css, gstatic_files: files.filter(f => /fonts\.gstatic\.com/.test(f.url)).length,
      display_swap: roles.google_css.length ? roles.google_css.every(u => /display=(swap|optional|fallback)/.test(u)) : null,
      css2: roles.google_css.some(u => /\/css2\?/.test(u)), subset_cyrillic: roles.google_css.length ? roles.google_css.some(u => /subset=[^&]*cyrillic|\/css2\?/.test(u)) : null },
    css_unreadable: css ? css.unreadable : null,
    errors,
  };
}

// ---------------------------------------------------------------------------------------------
export async function finalize(all, ctx = {}) {
  if (!ctx.run) throw new Error('fonts.finalize: ctx.run is required');
  const lang = ctx.lang === 'en' ? 'en' : 'ru';
  const items = [], errors = [];
  const groups = groupByPid(all, ctx.pages);
  logDropped(ctx, 'fonts', groups);
  for (const [pid, its] of groups) {
    for (const x of its) {
      if (!x.data || x.data.error) { errors.push({ pid, width: x.width, error: x.data ? x.data.error : 'no data' }); continue; }
      items.push({ pid, url: x.url || pageEntry(ctx.pages, pid)?.url || x.data.final_url, width: x.width, ...x.data });
      for (const e of x.data.errors || []) errors.push({ pid, width: x.width, error: e });
    }
  }
  // @font-face rules and document.fonts are the same on every page × width: one deduplicated list in summary
  // (with what an earlier resumed call already put there); items keep counts only
  const measurePath = insideRun(ctx.run, 'measure', 'fonts.json');
  const prevSummary = existsSync(measurePath) ? (readJSON(measurePath, {}).summary || {}) : {};
  const faces = new Map(), docFonts = new Map();
  const addFace = f => { const k = `${f.family}|${f.weight}|${f.style}|${f.src}`; const o = faces.get(k); if (o) o.used = o.used || !!f.used; else faces.set(k, { ...f }); };
  const RANK = { error: 3, loaded: 2, loading: 1, unloaded: 0 };
  const addDoc = f => {
    const k = `${f.family}|${f.weight}|${f.style}|${f.unicode_range || ''}`; const o = docFonts.get(k);
    if (!o) docFonts.set(k, { ...f });
    else if ((RANK[f.status] ?? 0) > (RANK[o.status] ?? 0)) o.status = f.status; // error anywhere wins, then loaded
  };
  for (const f of Array.isArray(prevSummary.font_faces) ? prevSummary.font_faces : []) addFace(f);
  for (const f of Array.isArray(prevSummary.document_fonts) ? prevSummary.document_fonts : []) addDoc(f);
  for (const it of items) { for (const f of it.font_faces || []) addFace(f); for (const f of it.document_fonts || []) addDoc(f); }
  const facesList = [...faces.values()].slice(0, 200), docList = [...docFonts.values()].slice(0, 200);

  const summaryFn = list => {
    const fam = {};
    for (const it of list) for (const [f, c] of Object.entries(it.families_by_chars || {})) fam[f] = (fam[f] || 0) + c;
    const fallbacks = [], unchecked = [], missing = {}, missingUsed = {}, sizes = {}, unloaded = [], breaks = {}, breakSamples = [];
    for (const it of list) {
      for (const [role, p] of Object.entries(it.platform || {})) {
        if (role.startsWith('_') || !p) continue;
        if (p.fallback_glyphs > 0) fallbacks.push({ pid: it.pid, width: it.width, role, css_first: p.css_first, drawn_by: p.drawn_by, fallback_families: p.fallback_families || [], fallback_glyphs: p.fallback_glyphs, glyphs_total: p.glyphs_total });
        // CDP gave no fonts (text not laid out) or failed: the role is not checked, it is not «clean»
        else if (p.empty || p.error) unchecked.push({ pid: it.pid, width: it.width, role, why: p.empty ? (p.why || 'empty') : String(p.error).slice(0, 80) });
      }
      // a font that never loaded «misses» every glyph: listed apart, not as missing glyphs
      for (const [f, g] of Object.entries(it.glyphs || {})) {
        if (g.loaded === false) { if (!unloaded.includes(f)) unloaded.push(f); continue; }
        if (g.missing && g.missing.length) missing[f] = [...new Set([...(missing[f] || []), ...g.missing])];
        if (g.missing_used && g.missing_used.length) missingUsed[f] = [...new Set([...(missingUsed[f] || []), ...g.missing_used])];
      }
      const lb = it.line_breaks;
      if (lb && lb.counts) {
        for (const [k, v] of Object.entries(lb.counts)) breaks[k] = (breaks[k] || 0) + v;
        for (const x of lb.items || []) for (const iss of x.issues) if (breakSamples.length < 20) breakSamples.push({ pid: it.pid, width: it.width, type: iss.type, kind: x.kind, text: x.text.slice(0, 60), at: iss.word || iss.at, selector: x.selector });
      }
      for (const r of ['h1', 'h2', 'h3', 'text', 'button', 'nav', 'input', 'small']) if (it.roles && it.roles[r]) ((sizes[r] ||= {})[it.width] ||= []).push(it.roles[r].size);
    }
    const range = a => a && a.length ? [Math.min(...a), Math.max(...a)] : null;
    const sizeRanges = {};
    for (const [r, byW] of Object.entries(sizes)) sizeRanges[r] = Object.fromEntries(Object.entries(byW).map(([w, a]) => [w, range(a)]));
    return {
      families_by_chars: Object.fromEntries(Object.entries(fam).sort((a, b) => b[1] - a[1]).slice(0, 12)),
      families_count: Object.keys(fam).filter(f => fam[f] > 50).length,
      // «X Fallback» faces are metric-adjusted local() fallbacks (Next.js and similar), not downloaded fonts
      web_families: [...new Set(docList.map(f => f.family))].filter(f => !/\sFallback$/i.test(f)).slice(0, 20),
      fallbacks: fallbacks.slice(0, 30), platform_unchecked: unchecked.slice(0, 30), missing_glyphs: missing, missing_glyphs_used: missingUsed, glyph_check_not_loaded: unloaded,
      line_breaks: { counts: breaks, samples: breakSamples, note: 'headless Chrome with the fonts of this machine: confirm on the screenshot of the same width' },
      font_faces_total: faces.size,
      // only faces of families the page draws with: a declared but unused face blocks nothing
      font_faces_no_display: facesList.filter(f => f.used && noDisplay(f)).map(f => ({ family: f.family, weight: f.weight, display: f.display || null, sheet: f.sheet })).slice(0, 20),
      failed_faces: [...new Set(docList.filter(f => f.status === 'error').map(f => `${f.family} ${f.weight} ${f.style}`))],
      files_max: Math.max(0, ...list.map(it => it.files?.count || 0)), duplicates: [...new Map(list.flatMap(it => it.files?.duplicates || []).map(d => [d.name, d])).values()].slice(0, 10),
      google_fonts: list.some(it => (it.google_fonts?.css || []).length || it.google_fonts?.gstatic_files),
      sizes_px: sizeRanges,
      font_faces: facesList, document_fonts: docList,
    };
  };
  // short summary per page in snapshot/<pid>/page.json (key «fonts»); the full record stays in measure/fonts.json
  for (const [pid, its] of groupByPid(items.map(it => ({ pid: it.pid, width: it.width, data: it })))) {
    const byW = {};
    for (const { width, data: it } of its) {
      const r = it.roles || {};
      const pick = k => r[k] ? { family: r[k].family_first, size: r[k].size, size_on_screen: r[k].size_on_screen, weight: r[k].weight, line_ratio: r[k].line_ratio } : null;
      byW[width] = { h1: pick('h1'), h2: pick('h2'), text: pick('text'), small: pick('small'), button: pick('button'), input: pick('input'),
        visual_scale: it.visual_scale && it.visual_scale < 1 ? it.visual_scale : undefined,
        fallback_roles: Object.entries(it.platform || {}).filter(([, p]) => p && p.fallback_glyphs > 0).map(([role, p]) => ({ role, drawn_by: p.drawn_by, fallback_families: p.fallback_families || [], fallback_glyphs: p.fallback_glyphs })),
        // roles whose drawing font the browser did not report: not checked, not «no fallback»
        unchecked_roles: Object.entries(it.platform || {}).filter(([role, p]) => !role.startsWith('_') && p && (p.empty || p.error)).map(([role]) => role),
        line_breaks: it.line_breaks ? it.line_breaks.counts : null };
    }
    const prim = its.find(x => x.width === 1440) || its[its.length - 1];
    const fam = Object.entries(prim.data.families_by_chars || {}).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([family, chars]) => ({ family, chars }));
    try {
      await updatePageJson(ctx.run, pid, { fonts: { families: fam, web: [...new Set((prim.data.document_fonts || []).map(f => f.family))].filter(f => !/\sFallback$/i.test(f)).slice(0, 10),
        missing_glyphs_used: Object.fromEntries(Object.entries(prim.data.glyphs || {}).filter(([, g]) => g.loaded !== false && g.missing_used && g.missing_used.length).map(([f, g]) => [f, g.missing_used])),
        by_width: byW, more: 'measure/fonts.json' } });
    } catch (e) { errors.push({ pid, error: 'page.json: ' + String(e.message).slice(0, 160) }); }
  }
  for (const it of items) { delete it.font_faces; delete it.document_fonts; }
  const out = writeMeasureMerged(ctx, 'fonts', { items, errors, summaryFn });
  const s = out.summary;
  const lines = [];
  const top = Object.entries(s.families_by_chars || {}).slice(0, 3).map(([f, c]) => `${f} ${c}`).join(', ');
  const fbText = f => `${f.pid}@${f.width} ${f.role} (${(f.fallback_families || []).join(', ') || f.drawn_by})`;
  const miss = Object.entries(s.missing_glyphs_used || {});
  const missText = miss.slice(0, 2).map(([f, g]) => `${f} (${g.join(' ')})`).join(', ') + (miss.length > 2 ? ' …' : '');
  const uc = s.platform_unchecked || [];
  const ucText = uc.slice(0, 3).map(x => `${x.pid}@${x.width} ${x.role}`).join(', ') + (uc.length > 3 ? ' …' : '');
  const lb = s.line_breaks.counts;
  const torn = (lb.split_number || 0) + (lb.unit_alone || 0);
  const en = lang === 'en';
  // the first line carries every problem in short (the snapshot summary surely shows the first line of each
  // collector, the second only when there is room); details follow on the next lines
  const head = [en ? `fonts: by chars — ${top || '—'}; web fonts ${s.web_families.length}; files up to ${s.files_max}`
    : `шрифты: по знакам — ${top || '—'}; веб-шрифтов ${s.web_families.length}; файлов до ${s.files_max}`];
  if (s.fallbacks.length) head.push(en ? `fallback font in roles: ${s.fallbacks.length}` : `запасной шрифт в ролях: ${s.fallbacks.length}`);
  if (miss.length) head.push(en ? `glyphs missing from the font: ${missText}` : `нет знаков в шрифте: ${missText}`);
  if (torn) head.push(en ? `torn numbers ${torn}` : `разорванных чисел ${torn}`);
  if (uc.length) head.push(en ? `roles with fonts not checked: ${uc.length}` : `шрифт ролей не проверен: ${uc.length}`);
  lines.push(head.join('; '));
  if (en) {
    if (s.fallbacks.length) lines.push(`fallback font drew part of the text: ${s.fallbacks.slice(0, 3).map(fbText).join('; ')}`);
    if (uc.length) lines.push(`the browser gave no fonts (text not laid out), role not checked: ${ucText}`);
    if (miss.length > 2) lines.push(`glyphs missing from the font but present in the text: ${miss.map(([f, g]) => `${f}: ${g.join(' ')}`).join('; ')}`);
    if ((lb.hanging || 0) + torn + (lb.widow || 0)) lines.push(`line breaks: short words at line ends ${lb.hanging || 0}, torn numbers ${torn}, one word on the last line of a heading ${lb.widow || 0}`);
  } else {
    if (s.fallbacks.length) lines.push(`часть текста нарисована запасным шрифтом: ${s.fallbacks.slice(0, 3).map(fbText).join('; ')}`);
    if (uc.length) lines.push(`браузер не отдал шрифты (текст не разложен), роль не проверена: ${ucText}`);
    if (miss.length > 2) lines.push(`в шрифте нет знаков, которые есть в тексте: ${miss.map(([f, g]) => `${f}: ${g.join(' ')}`).join('; ')}`);
    if ((lb.hanging || 0) + torn + (lb.widow || 0)) lines.push(`переносы: коротких слов в конце строки ${lb.hanging || 0}, разорванных чисел ${torn}, одно слово в последней строке заголовка ${lb.widow || 0}`);
  }
  if (ctx.log) try { ctx.log('fonts: measure/fonts.json'); } catch {}
  return { files: ['measure/fonts.json'], lines, summary: { pages: new Set(items.map(i => i.pid)).size, fallbacks: s.fallbacks.length, platform_unchecked: uc.length, missing_glyphs_used: Object.keys(s.missing_glyphs_used).length, font_faces_no_display: s.font_faces_no_display.length } };
}
