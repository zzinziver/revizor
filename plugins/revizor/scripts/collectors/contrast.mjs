// Revizor collector «contrast». Runs after «axe» on the same page load.
// All page-side code runs in the isolated world of lib/cdp (same DOM, own JS globals: the site cannot fake the data).
//  1. axe color-contrast violations → table rows (method axe), after a visibility check: text nobody sees
//     (back face of a flip card, clip-path, clipped by an ancestor) is dropped, text covered by a layer → medium.
//  2. axe color-contrast incomplete (text over img/video/background-image/gradient/overlap, ≤ 60 per page):
//     per viewport frame: wait for the effects the scroll started (≤ 1 s), read colours again, then two shots,
//     text visible and text transparent (text-shadow kept: a halo is the glyph background) → pixels that differ are
//     the glyphs → the background under exactly those pixels (10th/90th percentile of luminance, canvas in the tool tab)
//     → worst contrast with the text colour (method pixel-sample, confidence medium; low with a moving background,
//     animated text or text-shadow). Self-check: a colour that should leave a glyph mask but leaves none → skipped
//     'not-painted'. Under mix-blend-mode / colour filters the colour of the painted glyphs is used (axe and computed
//     styles cannot see blending): such text is always sampled. Long frames are split into chunks (≤ 12 s each);
//     what does not fit is skipped as 'sampling-timeout' and the page is marked partial. Without axe (offline): own scan of plain text by computed colours + the same sampling.
//  3. CSS.forcePseudoState hover / focus(+focus-visible) on buttons: text contrast in that state, focus ring 3:1.
//  4. Placeholders (4.5:1), non-text 3:1 (field borders, icon-only buttons).
//  5. APCA (owner's rule): light text on a darker background, thin (≤ 300) or small (< 16 px) text gets apca_check
//     { why, lc, need, pass }; text that passes WCAG is read by computed colours (apcaText) and kept when it fails APCA.
//  One row per element × state; finalize() merges widths and pages
//  and returns { files, lines, summary } like the other collectors.
// The page is restored afterwards (styles, attributes, forced states, scroll).

import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { writeJSON, measureHeader, progress, sleep } from '../lib/util.mjs';

export const meta = { name: 'contrast', widths: [390, 1440], order: 50, timeoutMs: 120000 };

const MAX_SAMPLED = 60;        // pixel-sampled text elements per page × width
const MAX_BUTTONS = 16;        // hover/focus checks per page × width
const MAX_CROPS = 8;           // evidence crops per page × width
const SAMPLE_MS = 20000;       // time cap for pixel sampling of default-state text per page × width
const STATE_MS = 8000;         // time cap for pixel sampling of hover/focus states
const MAX_APCA_ROWS = 60;      // APCA-only rows (pass WCAG, fail APCA) per page × width
const APCA_CROPS = 4;          // evidence crops for APCA-only rows per page × width (own budget, besides MAX_CROPS)
const SKIP_REASONS = new Set(['nonBmp', 'shortTextContent']); // icon glyphs, 1-char content: not text to read

// ---------- colour maths (Node side) ----------
const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export function ratioRaw(a, b) { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); }
const show = r => Math.floor(r * 100) / 100; // floor: 4.499 is shown as 4.49 and fails
const blend = (fg, bg) => { const a = fg[3] ?? 1; return [0, 1, 2].map(i => Math.round(fg[i] * a + bg[i] * (1 - a))); };
const hex = c => c ? '#' + c.slice(0, 3).map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('') : null;
const fromHex = h => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h || '')); if (!m) return null; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1]; };

/** APCA-W3 0.0.98G Lc (negative: light text on a darker background). */
export function apcaLc(txt, bg) {
  const Y = ([r, g, b]) => 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.0721750 * (b / 255) ** 2.4;
  const clamp = y => (y > 0.022 ? y : y + (0.022 - y) ** 1.414);
  const yt = clamp(Y(txt)), yb = clamp(Y(bg));
  if (Math.abs(yb - yt) < 0.0005) return 0;
  let out;
  if (yb > yt) { const s = (yb ** 0.56 - yt ** 0.57) * 1.14; out = s < 0.1 ? 0 : s - 0.027; }
  else { const s = (yb ** 0.65 - yt ** 0.62) * 1.14; out = s > -0.1 ? 0 : s + 0.027; }
  return Math.round(out * 1000) / 10;
}

const isLarge = (px, w) => px >= 23.95 || (px >= 18.66 && w >= 700); // 18 pt / 14 pt bold (1 pt = 4/3 px)
const normFor = (kind, large) => (kind === 'non-text' || kind === 'focus-ring' ? 3 : large ? 3 : 4.5);

/**
 * Extra APCA check (owner's rule): text that is light on a darker background (dark), thin (weight ≤ 300) or small (< 16 px).
 * Thresholds on |Lc|: body text 75, large (WCAG sense) 60; thin one step up (90 / 75); under 14 px 90.
 * Returns { why, lc, need, pass } or null when the rule does not apply (non-text, no colours, regular text on a light background).
 */
export function apcaCheck(kind, fgRgb, bgRgb, px, weight, large) {
  if ((kind !== 'text' && kind !== 'placeholder') || !fgRgb || !bgRgb || !px) return null;
  const lc = apcaLc(fgRgb, bgRgb);
  const w = weight || 400;
  const why = [];
  if (lc < 0) why.push('dark'); // reverse polarity: the text is lighter than its background
  if (w <= 300) why.push('thin');
  if (px < 16) why.push('small');
  if (!why.length) return null;
  let need = large ? 60 : 75;
  if (w <= 300) need = large ? 75 : 90;
  if (px < 14) need = 90;
  return { why, lc, need, pass: Math.abs(lc) >= need };
}
const apcaFail = r => !!(r.apca_check && !r.apca_check.pass);
const apcaGap = a => Math.abs(a.lc) / a.need;

// ---------- in-page helpers ----------
const HELPERS = `(() => {
  if (window.__rvC) return true;
  const list = [];
  const idOf = el => { let k = list.indexOf(el); if (k < 0) { list.push(el); k = list.length - 1; } return k; };
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = s => {
    if (!s) return null; s = String(s).trim();
    let m = /^rgba?\\(\\s*([\\d.]+)[,\\s]+([\\d.]+)[,\\s]+([\\d.]+)(?:\\s*[,\\/]\\s*([\\d.]+)(%?))?\\s*\\)$/i.exec(s);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : (m[5] ? +m[4] / 100 : +m[4])];
    if (s === 'transparent') return [0, 0, 0, 0];
    try { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; } catch (e) { return null; }
  };
  const blend = (fg, bg) => { const a = fg[3] ?? 1; return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)); };
  const sel = el => {
    if (!el || el.nodeType !== 1) return '';
    const okId = id => id && /^[A-Za-z][\\w-]*$/.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1;
    if (okId(el.id)) return '#' + el.id;
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 6; e = e.parentElement) {
      if (e !== el && okId(e.id)) { parts.unshift('#' + e.id); }
      else {
        let p = e.tagName.toLowerCase();
        const cls = [...e.classList].filter(c => /^[A-Za-z_][\\w-]*$/.test(c) && c.length < 40).slice(0, 2);
        if (cls.length) p += '.' + cls.join('.');
        const par = e.parentElement;
        if (par) { const same = [...par.children].filter(c => c.tagName === e.tagName); if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(e) + 1) + ')'; }
        parts.unshift(p);
      }
      const s = parts.join(' > ');
      try { if (document.querySelectorAll(s).length === 1) return s; } catch (e2) {}
      if (parts[0].startsWith('#') || e === document.body) break;
    }
    return parts.join(' > ');
  };
  const text = el => String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const opacity = el => { let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity || '1'); return o; };
  const visible = el => {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false;
    return opacity(el) >= 0.05;
  };
  const docBox = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)]; };
  const bgWalk = el => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { image: /gradient/.test(cs.backgroundImage) ? 'gradient' : 'image', at: sel(e) };
      const c = rgba(cs.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
    }
    let base = [255, 255, 255];
    if (layers.length && layers[layers.length - 1][3] >= 0.999) base = layers.pop().slice(0, 3);
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return { color: base.map(Math.round) };
  };
  const textNodes = el => {
    const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.nodeValue.trim());
    if (own.length) return own;
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); const out = []; let n;
    while ((n = w.nextNode()) && out.length < 20) if (n.nodeValue.trim()) out.push(n);
    return out;
  };
  const lineRects = el => {
    const rects = [];
    for (const n of textNodes(el)) { const rg = document.createRange(); rg.selectNodeContents(n); for (const r of rg.getClientRects()) if (r.width >= 1 && r.height >= 1) rects.push(r); }
    if (!rects.length) { const r = el.getBoundingClientRect(); if (r.width >= 1) rects.push(r); }
    return rects.slice(0, 12);
  };
  const fgOf = el => {
    const cs = getComputedStyle(el);
    let c = rgba(cs.color); const fill = rgba(cs.webkitTextFillColor);
    if (fill && cs.webkitTextFillColor !== cs.color) {
      if (fill[3] === 0 && /text/.test(cs.backgroundClip || cs.webkitBackgroundClip || '')) return { gradientText: true };
      c = fill;
      // transparent fill with -webkit-text-stroke: the glyphs are drawn by the stroke colour (axe reads it the same way)
      const sc = rgba(cs.webkitTextStrokeColor);
      if (fill[3] === 0 && (parseFloat(cs.webkitTextStrokeWidth) || 0) > 0 && sc && sc[3] > 0) c = sc;
    }
    return { fg: c, font_px: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400, shadow: cs.textShadow && cs.textShadow !== 'none' };
  };
  const overMedia = el => {
    const rs = lineRects(el); if (!rs.length) return null;
    const r = rs[0]; const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null;
    const stack = document.elementsFromPoint(x, y);
    let i = stack.findIndex(e => e === el || el.contains(e)); if (i < 0) return null;
    for (let j = i + 1; j < stack.length; j++) {
      const e = stack[j]; if (e.contains(el)) { const cs = getComputedStyle(e); if (cs.backgroundImage !== 'none') return /gradient/.test(cs.backgroundImage) ? 'gradient' : 'image'; const c = rgba(cs.backgroundColor); if (c && c[3] >= 0.999) return null; continue; }
      const t = e.tagName;
      if (/^(IMG|VIDEO|CANVAS|PICTURE|IFRAME|OBJECT|EMBED)$/.test(t) || t.toLowerCase() === 'svg') return t === 'VIDEO' ? 'video' : 'img';
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') return /gradient/.test(cs.backgroundImage) ? 'gradient' : 'image';
      const c = rgba(cs.backgroundColor); if (c && c[3] >= 0.999) return 'overlap';
    }
    return null;
  };
  const resolve = t => { try { let el = document.querySelector(t[0]); for (let i = 1; el && i < t.length; i++) el = el.shadowRoot && el.shadowRoot.querySelector(t[i]); return el; } catch (e) { return null; } };
  const isFixed = el => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === 'fixed') return true; } return false; };
  // running animations of the element and its ancestors: finite ones are awaited before a shot,
  // infinite ones that change the ink (opacity, colour, filter) make the reading unstable
  const INK = /^(opacity|color|filter|visibility|webkitTextFillColor|fill|all)$/i;
  const animOf = el => {
    const fin = [], ink = [];
    for (let e = el, n = 0; e && e.nodeType === 1 && n < 10; e = e.parentElement, n++) {
      for (const a of (e.getAnimations ? e.getAnimations() : [])) {
        if (a.playState !== 'running') continue;
        const t = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
        if (t.endTime !== Infinity && t.iterations !== Infinity) { fin.push(a); continue; }
        let props = [];
        try { props = a.transitionProperty ? [a.transitionProperty] : (a.effect.getKeyframes() || []).flatMap(f => Object.keys(f)); } catch (x) { /* */ }
        if (props.some(p => INK.test(p))) ink.push(a);
      }
    }
    return { fin, ink };
  };
  // why a text element is not seen although axe measured it: back face of a flip card, clip-path, clipped by an ancestor
  const hiddenHow = el => {
    if (!el || !el.isConnected) return 'gone';
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return 'display';
    if (cs.visibility !== 'visible') return 'visibility';
    if (opacity(el) < 0.05) return 'opacity';
    const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return 'size';
    let m = new DOMMatrix(); let bf = false;
    for (let e = el, n = 0; e && e.nodeType === 1 && n < 8; e = e.parentElement, n++) {
      const s = getComputedStyle(e);
      if (s.backfaceVisibility === 'hidden') bf = true;
      if (s.transform && s.transform !== 'none') { try { m = new DOMMatrix(s.transform).multiply(m); } catch (x) { /* */ } }
      if (/inset\\(\\s*(50|100)%|circle\\(\\s*0(px)?\\s*(at|\\))/.test(s.clipPath || '')) return 'clip-path';
      if (/rect\\(\\s*0(px)?[,\\s]+0(px)?[,\\s]+0(px)?/.test(s.clip || '')) return 'clip';
    }
    if (bf && m.m33 < 0) return 'backface';
    for (let p = el.parentElement, n = 0; p && p !== document.body && n < 20; p = p.parentElement, n++) {
      const pc = getComputedStyle(p);
      if (/(hidden|clip)/.test(pc.overflow + pc.overflowX + pc.overflowY)) {
        const pr = p.getBoundingClientRect();
        if (pr.width < 2 || pr.height < 2 || r.right <= pr.left || r.left >= pr.right || r.bottom <= pr.top || r.top >= pr.bottom) return 'clipped';
      }
    }
    return null;
  };
  // a blend mode or a colour filter on the element or an ancestor: the painted colour is not the computed one
  const blendOf = el => {
    for (let e = el, n = 0; e && e.nodeType === 1 && n < 14; e = e.parentElement, n++) {
      const s = getComputedStyle(e);
      if (s.mixBlendMode && s.mixBlendMode !== 'normal') return 'mix-blend-mode:' + s.mixBlendMode;
      if (/invert|hue-rotate|grayscale|sepia|saturate|contrast|brightness/.test(s.filter || '')) return 'filter:' + String(s.filter).slice(0, 40);
    }
    return null;
  };
  const info = k => {
    const el = list[k]; if (!el) return { k, gone: true };
    const f = fgOf(el);
    return { k, sel: sel(el), text: text(el), visible: visible(el), box: docBox(el), fixed: isFixed(el), opacity: opacity(el), ...f,
      fg: f.fg, overMedia: overMedia(el), disabled: !!(el.closest('[disabled],[aria-disabled="true"]')), inkAnim: animOf(el).ink.length > 0, ariaHidden: !!el.closest('[aria-hidden="true"]'), blend: blendOf(el) };
  };
  window.__rvC = {
    list, idOf, rgba, sel, text, visible, bgWalk, info, lineRects, resolve, docBox, fgOf, overMedia,
    el: k => list[k],
    infoMany: ks => ks.map(k => info(k)),
    hiddenHow: ks => ks.map(k => hiddenHow(list[k])),
    mark: (ks, attr, on) => { for (const k of ks) { const el = list[k]; if (el) on ? el.setAttribute(attr, '') : el.removeAttribute(attr); } return true; },
    // wait (≤ maxMs) for finite animations/transitions on the elements and their ancestors: fade-ins started by the scroll
    settle: (ks, maxMs) => {
      const fin = []; let ink = 0;
      for (const k of ks) { const el = list[k]; if (!el) continue; const a = animOf(el); fin.push(...a.fin); ink += a.ink.length; }
      const uniq = [...new Set(fin)];
      if (!uniq.length) return Promise.resolve({ waited: 0, ink });
      return Promise.race([Promise.all(uniq.map(a => a.finished.catch(() => 0))), new Promise(r => setTimeout(r, maxMs))])
        .then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r({ waited: uniq.length, ink })))));
    },
    fromTargets: targets => targets.map(t => { const el = resolve(t); return el ? info(idOf(el)) : null; }),
    viewportRects: ks => ks.map(k => {
      const el = list[k]; if (!el || !visible(el)) return { k, rects: [], covered: false, gone: true };
      const rects = lineRects(el).map(r => { const x0 = Math.max(0, r.left), y0 = Math.max(0, r.top), x1 = Math.min(innerWidth, r.right), y1 = Math.min(innerHeight, r.bottom); return x1 - x0 >= 1 && y1 - y0 >= 1 ? [x0, y0, x1 - x0, y1 - y0] : null; }).filter(Boolean);
      let covered = 0, coverer = null;
      for (const [x, y, w, h] of rects.slice(0, 3)) {
        const hit = document.elementFromPoint(x + w / 2, y + h / 2);
        if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) { covered++; coverer = coverer || sel(hit); }
      }
      return { k, rects, covered: rects.length > 0 && covered === Math.min(3, rects.length), coverer };
    }),
    hide: (ks, on) => { for (const k of ks) { const el = list[k]; if (el) on ? el.setAttribute('data-rv-hide', '') : el.removeAttribute('data-rv-hide'); } },
    style: (on) => {
      let s = document.getElementById('__rv_contrast_style');
      if (!on) { if (s) s.remove(); return; }
      if (!s) { s = document.createElement('style'); s.id = '__rv_contrast_style';
        // text-shadow stays: a dense halo/outline is the background of the glyphs (WCAG 1.4.3), so it must be in the hidden shot
        s.textContent = '[data-rv-hide],[data-rv-hide] *{color:transparent!important;-webkit-text-fill-color:transparent!important;-webkit-text-stroke-color:transparent!important;caret-color:transparent!important;text-decoration-color:transparent!important}' +
          '[data-rv-nt],[data-rv-nt] *,[data-rv-ps],[data-rv-ps] *,[data-rv-ps]::before,[data-rv-ps]::after{transition:none!important}html,body{scroll-behavior:auto!important}';
        (document.head || document.documentElement).appendChild(s); }
    },
    // Own scan for offline mode: plain text by computed colours; text over media → pixel candidates.
    scanText: (maxChecked, maxFails, maxCands) => {
      const fails = [], cands = [], skipped = []; let checked = 0;
      const all = document.body ? document.body.querySelectorAll('*') : [];
      for (const el of all) {
        if (checked >= maxChecked) break;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH|OPTION|IFRAME|CANVAS|VIDEO|AUDIO)$/i.test(el.tagName)) continue;
        if (![...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())) continue;
        if (!visible(el) || el.closest('[disabled],[aria-disabled="true"]')) continue;
        checked++;
        const f = fgOf(el); if (f.gradientText || !f.fg) continue;
        // same visibility test as for axe rows: back face of a flip card, clip-path, clipped by an ancestor
        const hid = hiddenHow(el);
        if (hid) { if (skipped.length < 50) skipped.push({ sel: sel(el), how: hid }); continue; }
        // a transparent fill without a stroke (fgOf takes the stroke colour when there is one) has no ink to measure
        if (f.fg[3] === 0) { if (skipped.length < 50) skipped.push({ sel: sel(el), how: f.shadow ? 'transparent-fill-shadow' : 'transparent-fill' }); continue; }
        const media = overMedia(el);
        const bw = bgWalk(el);
        const bl = blendOf(el);
        if (media || bw.image || bl) { if (cands.length < maxCands) cands.push({ k: idOf(el), reason: bl ? 'blend-mode' : media || bw.image }); continue; }
        if (fails.length < maxFails) fails.push({ k: idOf(el), sel: sel(el), text: text(el), box: docBox(el), fg: f.fg, opacity: opacity(el), bg: bw.color, font_px: f.font_px, weight: f.weight });
      }
      return { checked, fails, cands, skipped };
    },
    // APCA scan: plain-background text that is light on a darker background, thin (weight ≤ 300) or small (< 16 px).
    // axe reports only WCAG failures, so passing text is read here by computed colours; media/gradients/blend are skipped.
    apcaText: (maxChecked, maxOut) => {
      const out = []; let checked = 0;
      const Yp = c => 0.2126 * (c[0] / 255) ** 2.4 + 0.7152 * (c[1] / 255) ** 2.4 + 0.0722 * (c[2] / 255) ** 2.4;
      for (const el of (document.body ? document.body.querySelectorAll('*') : [])) {
        if (checked >= maxChecked || out.length >= maxOut) break;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH|OPTION|IFRAME|CANVAS|VIDEO|AUDIO)$/i.test(el.tagName)) continue;
        if (![...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim().length > 1)) continue;
        if (!visible(el) || el.closest('[disabled],[aria-disabled="true"]')) continue;
        checked++;
        const f = fgOf(el); if (f.gradientText || !f.fg || f.fg[3] === 0) continue;
        const bw = bgWalk(el); if (bw.image) continue;
        const o = opacity(el);
        const fe = blend([f.fg[0], f.fg[1], f.fg[2], (f.fg[3] ?? 1) * o], bw.color);
        const dark = Yp(fe) > Yp(bw.color);
        if (!dark && f.weight > 300 && f.font_px >= 16) continue; // cheap filter first, layout queries after
        if (hiddenHow(el) || blendOf(el) || overMedia(el)) continue;
        out.push({ k: idOf(el), sel: sel(el), text: text(el), box: docBox(el), fixed: isFixed(el), fg: f.fg, opacity: o, bg: bw.color, font_px: f.font_px, weight: f.weight });
      }
      return { checked, items: out };
    },
    // visible text under a blend mode / colour filter (axe and computed colours cannot judge it): pixel candidates
    blendText: (max) => {
      const out = [];
      for (const el of (document.body ? document.body.querySelectorAll('*') : [])) {
        if (out.length >= max) break;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH|OPTION|IFRAME|CANVAS|VIDEO|AUDIO)$/i.test(el.tagName)) continue;
        if (![...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim().length > 1)) continue;
        if (!visible(el) || !blendOf(el)) continue;
        out.push(idOf(el));
      }
      return out;
    },
    buttons: (max) => {
      const q = 'button, input[type=button], input[type=submit], input[type=reset], [role=button], a[class*="btn" i], a[class*="button" i], a[href]';
      const out = [];
      for (const el of document.querySelectorAll(q)) {
        if (!visible(el) || el.closest('[disabled],[aria-disabled="true"]')) continue;
        const t = text(el); if (!t) continue;
        const cs = getComputedStyle(el);
        const ownBg = rgba(cs.backgroundColor); const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingLeft);
        const buttonLike = el.tagName !== 'A' || (ownBg && ownBg[3] > 0.5 && pad >= 6) || cs.backgroundImage !== 'none' || /btn|button/i.test(el.className);
        if (!buttonLike) continue;
        const r = el.getBoundingClientRect();
        let te = [...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim()) ? el : null;
        if (!te) for (const d of el.querySelectorAll('*')) { if ([...d.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim()) && visible(d)) { te = d; break; } }
        if (!te) continue;
        out.push({ k: idOf(el), kt: idOf(te), first: r.top + scrollY < innerHeight, area: r.width * r.height });
      }
      out.sort((a, b) => (b.first - a.first) || (b.area - a.area));
      return out.slice(0, max).map(o => ({ k: o.k, kt: o.kt }));
    },
    sig: (ks, kts) => ks.map((k, i) => {
      const el = list[k]; if (!el) return null; const cs = getComputedStyle(el); const te = list[kts ? kts[i] : k] || el;
      return { k, fg: fgOf(te), bg: rgba(cs.backgroundColor), bgimg: cs.backgroundImage !== 'none', outline: [cs.outlineStyle, parseFloat(cs.outlineWidth) || 0, rgba(cs.outlineColor), parseFloat(cs.outlineOffset) || 0],
        shadow: cs.boxShadow, border: cs.borderTopColor + '|' + cs.borderBottomColor + '|' + cs.borderTopWidth, deco: cs.textDecorationLine,
        parentBg: el.parentElement ? bgWalk(el.parentElement) : { color: [255, 255, 255] }, opacity: opacity(el) };
    }),
    nonText: (maxEach) => {
      const ph = [], inputs = [], icons = [];
      const fieldQ = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=reset]):not([type=image]):not([type=range]):not([type=color]):not([type=file]), textarea, select';
      for (const el of document.querySelectorAll(fieldQ)) {
        if (!visible(el) || el.disabled) continue;
        const cs = getComputedStyle(el);
        const parentBg = el.parentElement ? bgWalk(el.parentElement) : { color: [255, 255, 255] };
        const own = rgba(cs.backgroundColor);
        const fieldBg = parentBg.color ? (own && own[3] > 0 ? blend(own, parentBg.color) : parentBg.color) : null;
        const labelled = !!(el.labels && el.labels.length) || el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || el.hasAttribute('title');
        if (el.placeholder && !el.value && ph.length < maxEach) {
          const pcs = getComputedStyle(el, '::placeholder');
          let pc = rgba(pcs.color); const po = parseFloat(pcs.opacity || '1'); if (pc) pc = [pc[0], pc[1], pc[2], (pc[3] ?? 1) * po];
          ph.push({ k: idOf(el), sel: sel(el), text: el.placeholder.slice(0, 60), fg: pc, bg: fieldBg && fieldBg.map(Math.round), font_px: parseFloat(cs.fontSize), weight: parseInt(cs.fontWeight, 10) || 400, labelled, box: docBox(el), parentImage: parentBg.image || null });
        }
        if (inputs.length < maxEach) {
          // the visible box of a field may be drawn by a wrapper of the same size (site builders): the field and such
          // wrappers are all candidates, the best boundary wins (Node side)
          const fr = el.getBoundingClientRect(); const boxes = [el];
          // (a phone field with a country flag: the wrapper is wider than the input, the same height)
          for (let p = el.parentElement, n = 0; p && p !== document.body && n < 3; p = p.parentElement, n++) { const r = p.getBoundingClientRect(); if (r.width <= Math.max(fr.width + 24, fr.width * 1.6) && r.height <= fr.height + 24) boxes.push(p); else break; }
          const alts = boxes.map(b => {
            const bs = b === el ? cs : getComputedStyle(b);
            const sides = [['Bottom', bs.borderBottomStyle, bs.borderBottomWidth, bs.borderBottomColor], ['Top', bs.borderTopStyle, bs.borderTopWidth, bs.borderTopColor], ['Left', bs.borderLeftStyle, bs.borderLeftWidth, bs.borderLeftColor]];
            const side = sides.find(s => s[1] !== 'none' && s[1] !== 'hidden' && parseFloat(s[2]) >= 1);
            const sh = bs.boxShadow && bs.boxShadow !== 'none' ? rgba((bs.boxShadow.match(/rgba?\\([^)]*\\)|#[0-9a-f]{3,8}\\b|oklch\\([^)]*\\)|hsla?\\([^)]*\\)/i) || [])[0]) : null;
            const outer = b === el ? parentBg : (b.parentElement ? bgWalk(b.parentElement) : { color: [255, 255, 255] });
            const ob = rgba(bs.backgroundColor);
            const fill = outer.color ? (ob && ob[3] > 0 ? blend(ob, outer.color) : outer.color) : null;
            return { by: b === el ? null : sel(b), border: side ? rgba(side[3]) : null, shadow: sh && sh[3] > 0 ? sh : null, border_px: side ? parseFloat(side[2]) : 0, fieldBg: fill && fill.map(Math.round), parentBg: outer.color || null, parentImage: outer.image || null };
          });
          inputs.push({ sel: sel(el), box: docBox(el), ...alts[0], ownBg: own, alts: alts.slice(1) });
        }
      }
      for (const el of document.querySelectorAll('button, a[href], [role=button]')) {
        if (icons.length >= maxEach) break;
        if (!visible(el) || text(el)) continue;
        const icon = el.querySelector('svg, i, span[class*="icon" i]'); if (!icon || !visible(icon)) continue;
        let c = null;
        if (icon.tagName.toLowerCase() === 'svg') {
          const shape = icon.querySelector('path, circle, rect, polygon, polyline, line, ellipse, use');
          const scs = getComputedStyle(shape || icon);
          c = rgba(scs.fill) && rgba(scs.fill)[3] > 0 ? rgba(scs.fill) : rgba(scs.stroke);
        } else c = rgba(getComputedStyle(icon).color);
        if (!c || c[3] === 0) continue;
        const cs = getComputedStyle(el); const own = rgba(cs.backgroundColor);
        const parentBg = bgWalk(el.parentElement || el);
        const bg = own && own[3] >= 0.999 && cs.backgroundImage === 'none' ? own.slice(0, 3) : (parentBg.color || null);
        icons.push({ sel: sel(el), box: docBox(el), fg: c, bg: bg && bg.map(Math.round), image: !bg ? (parentBg.image || 'image') : null, opacity: opacity(icon) });
      }
      return { ph, inputs, icons };
    },
    cleanup: () => { for (const el of document.querySelectorAll('[data-rv-hide],[data-rv-ps],[data-rv-nt]')) { el.removeAttribute('data-rv-hide'); el.removeAttribute('data-rv-ps'); el.removeAttribute('data-rv-nt'); } const s = document.getElementById('__rv_contrast_style'); if (s) s.remove(); },
  };
  return true;
})()`;

// Every measurement runs in the isolated world of lib/cdp: same DOM, own JS globals — the page cannot fake
// getComputedStyle, elementFromPoint or our helper object. A navigation in between drops the world (and the
// helpers with their element list): the call then fails and the collector reports an error, never mixed data.
async function isoId(page) {
  if (typeof page.isolatedContextId !== 'function') throw new Error('lib/cdp without isolated worlds');
  return page.isolatedContextId();
}
async function evalJSON(page, expression, timeoutMs = 60000, byValue = true) {
  const once = async () => page.send('Runtime.evaluate', { expression, returnByValue: byValue, awaitPromise: byValue, contextId: await isoId(page) }, timeoutMs);
  let r;
  try { r = await once(); }
  catch (e) { if (!/context/i.test(String(e.message))) throw e; page._iso = null; r = await once(); }
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return byValue ? r.result?.value : r.result;
}
const call = (page, fn, ...args) => evalJSON(page, `window.__rvC.${fn}(...${JSON.stringify(args)})`);

// ---------- tool tab: background under the glyphs ----------
// vis: two shots with text (before and after the hidden one: pixels that differ between them move on their own —
// carousels, spinning reels, video — and are never taken as glyphs), hidden: shots with transparent text (2 for video).
// groups: per element { rects (CSS-px viewport), video }. Text over video uses the whole middle band of each line
// in every hidden shot (the background changes in time), other text uses the glyph mask.
// The work is split so a heavy frame on a big page never hits the CDP timeout: one call decodes the frame's shots and
// keeps them in the tool tab, then elements are sampled in chunks; each chunk stops itself after CHUNK_MS (the rest of
// the chunk comes back as { timeout: true }) and the CDP call has its own TOOL_CALL_MS limit. Pixels are packed into
// one Float64 per sample (quantised luminance × 2^24 + rgb) and sorted as a typed array — no per-pixel objects.
const CHUNK = 4;             // elements per tool call
const CHUNK_MS = 12000;      // in-page time budget of one call
const TOOL_CALL_MS = 20000;  // CDP limit of one call (safety net)
const MAX_SAMPLES = 60000;   // pixels per element and shot
async function toolEval(tool, fn, args, timeoutMs = TOOL_CALL_MS) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const r = await tool.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
  if (r.exceptionDetails) throw new Error('tool: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result?.value;
}

function toolLoadShots(vis, hidden) {
  const load = async b64 => {
    const i = new Image(); i.src = 'data:image/jpeg;base64,' + b64; await i.decode();
    const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight;
    const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(i, 0, 0); return x;
  };
  return (async () => {
    const T = { V: await load(vis[0]), V2: vis[1] ? await load(vis[1]) : null, Hs: [] };
    for (const b of hidden) T.Hs.push(await load(b));
    window.__rvT = T; return true;
  })();
}

function toolSampleGroups(groups, vw, budgetMs, maxSamples) {
  const t0 = performance.now();
  const T = window.__rvT; if (!T) return groups.map(() => ({ failed: 'no-shots' }));
  const { V, V2, Hs } = T;
  const LIN = new Float64Array(256); for (let i = 0; i < 256; i++) { const v = i / 255; LIN[i] = v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }
  const k = V.canvas.width / vw; // CSS px → image px (DPR, zoomed-out layout viewport)
  const d3 = (a, b, o) => Math.abs(a[o] - b[o]) + Math.abs(a[o + 1] - b[o + 1]) + Math.abs(a[o + 2] - b[o + 2]);
  const pack = (h, o) => Math.round((0.2126 * LIN[h[o]] + 0.7152 * LIN[h[o + 1]] + 0.0722 * LIN[h[o + 2]]) * 65535) * 16777216 + ((h[o] << 16) | (h[o + 1] << 8) | h[o + 2]);
  const unpack = x => { const c = x % 16777216; return [(c >> 16) & 255, (c >> 8) & 255, c & 255]; };
  return groups.map(({ rects, video }) => {
    if (performance.now() - t0 > budgetMs) return { timeout: true };
    const boxes = []; let area = 0;
    for (const [cx, cy, cw, ch] of rects) {
      const X = Math.max(0, Math.floor(cx * k)), Y = Math.max(0, Math.floor(cy * k));
      const W = Math.min(V.canvas.width - X, Math.ceil(cw * k)), H = Math.min(V.canvas.height - Y, Math.ceil(ch * k));
      if (W >= 1 && H >= 1) { boxes.push([X, Y, W, H]); area += W * H; }
    }
    if (!boxes.length) return null;
    const step = Math.max(1, Math.floor(area / maxSamples));
    const cap = (Math.ceil(area / step) + boxes.length) * Hs.length;
    const glyph = new Float64Array(cap), band = new Float64Array(cap); let ng = 0, nb = 0, noisy = 0, total = 0;
    const ink = new Float64Array(Math.ceil(area / step) + boxes.length); let ni = 0; // glyph pixels of the visible shot: how far from the background × rgb
    for (const [X, Y, W, H] of boxes) {
      const v = V.getImageData(X, Y, W, H).data; const v2 = V2 ? V2.getImageData(X, Y, W, H).data : null;
      const hs = Hs.map(h => h.getImageData(X, Y, W, H).data);
      const y0 = Math.floor(H * 0.25), y1 = Math.ceil(H * 0.75);
      for (let p = 0; p < W * H; p += step) {
        const o = p * 4, h0 = hs[0];
        total++;
        const moving = v2 ? d3(v, v2, o) > 40 : false;
        if (moving) noisy++;
        const isGlyph = !moving && d3(v, h0, o) > 60 && (!v2 || d3(v2, h0, o) > 60);
        if (isGlyph) ink[ni++] = d3(v, h0, o) * 16777216 + ((v[o] << 16) | (v[o + 1] << 8) | v[o + 2]);
        const row = Math.floor(p / W);
        for (const h of hs) {
          if (isGlyph) glyph[ng++] = pack(h, o); else if (row >= y0 && row < y1) band[nb++] = pack(h, o);
        }
      }
      if (performance.now() - t0 > budgetMs * 1.5) return { timeout: true };
    }
    const mask = !video && ng >= 12;
    let use;
    if (video) { use = new Float64Array(ng + nb); use.set(glyph.subarray(0, ng)); use.set(band.subarray(0, nb), ng); }
    else use = mask ? glyph.subarray(0, ng) : band.subarray(0, nb);
    if (!use.length) return null;
    use.sort();
    const at = q => unpack(use[Math.min(use.length - 1, Math.floor(q * (use.length - 1)))]);
    // painted ink: mean of the 15 % glyph pixels farthest from the background (the cores of the strokes)
    let inkRgb = null;
    if (ni >= 12) {
      const sorted = ink.subarray(0, ni).sort(); const from = Math.floor(ni * 0.85); const sum = [0, 0, 0];
      for (let i = from; i < ni; i++) { const c = unpack(sorted[i]); sum[0] += c[0]; sum[1] += c[1]; sum[2] += c[2]; }
      inkRgb = sum.map(x => Math.round(x / (ni - from)));
    }
    return { n: use.length, mask, moving: total ? Math.round(100 * noisy / total) : 0, p10: at(0.1), p50: at(0.5), p90: at(0.9), ink: inkRgb };
  });
}

// vis: two shots with text (before and after the hidden one: pixels that differ between them move on their own —
// carousels, spinning reels, video — and are never taken as glyphs), hidden: shots with transparent text (2 for video).
// groups: per element { rects (CSS-px viewport), video }. Text over video uses the whole middle band of each line
// in every hidden shot (the background changes in time), other text uses the glyph mask.
// → array per group: sample | null (no pixels) | { timeout: true } | { failed }
async function sampleInTool(tool, vis, hidden, groups, vw, until = Infinity) {
  const out = new Array(groups.length).fill(null);
  try { await toolEval(tool, toolLoadShots, [vis, hidden], 30000); }
  catch (e) { progress('contrast: shots not decoded', e.message); return out.map(() => ({ failed: 'decode' })); }
  try {
    for (let i = 0; i < groups.length; i += CHUNK) {
      const n = Math.min(CHUNK, groups.length - i);
      if (Date.now() > until) { for (let j = i; j < groups.length; j++) out[j] = { timeout: true }; break; }
      try {
        const part = await toolEval(tool, toolSampleGroups, [groups.slice(i, i + n), vw, CHUNK_MS, MAX_SAMPLES]);
        (part || []).forEach((p, j) => { out[i + j] = p; });
      } catch (e) {
        progress('contrast: sampling chunk failed', e.message);
        for (let j = i; j < i + n; j++) out[j] = /timeout/i.test(e.message) ? { timeout: true } : { failed: 'error' };
        if (/timeout/i.test(e.message)) { for (let j = i + n; j < groups.length; j++) out[j] = { timeout: true }; break; } // the tab is still busy
      }
    }
  } finally {
    await toolEval(tool, () => { window.__rvT = null; return true; }, [], 10000).catch(() => {});
  }
  return out;
}

async function cropInTool(tool, jpegB64, rect, vw) {
  return toolEval(tool, async (b64, r, vw) => {
    const i = new Image(); i.src = 'data:image/jpeg;base64,' + b64; await i.decode();
    const k = i.naturalWidth / vw; const [x, y, w, h] = r.map(v => v * k); const s = Math.min(1, 800 / w);
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    c.getContext('2d').drawImage(i, x, y, w, h, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.82).split(',')[1];
  }, [jpegB64, rect, vw], 15000);
}

const raf = page => evalJSON(page, 'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))', 5000).catch(() => {});
const shot = async page => (await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 92, fromSurface: true, captureBeyondViewport: false })).data;
const d3 = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

// Viewport frames for a set of elements: fixed ones in one frame, the rest top to bottom, several per frame.
function makeFrames(live, env) {
  const { vh, docH } = env;
  const fixed = live.filter(i => i.fixed);
  const flow = live.filter(i => !i.fixed).sort((a, b) => a.box[1] - b.box[1]);
  const frames = [];
  if (fixed.length) frames.push({ top: 0, items: fixed });
  let cur = null;
  for (const i of flow) {
    const top = i.box[1], bottom = i.box[1] + Math.min(i.box[3], vh * 0.6);
    if (cur && top >= cur.top + vh * 0.15 && bottom <= cur.top + vh * 0.75) { cur.items.push(i); continue; }
    cur = { top: frameTop(env, top, 0.3), items: [i] };
    frames.push(cur);
  }
  return frames;
}
const frameTop = (env, top, at) => Math.max(0, Math.min(Math.round(top - env.vh * at), Math.max(0, env.docH - env.vh)));
const scrollTo = async (page, top) => { await evalJSON(page, `window.scrollTo({ top: ${top}, left: 0, behavior: 'instant' })`); };

/**
 * Cover check without pixels (axe violations): Map k → { covered, coverer } | { gone } | { time }.
 * An element is covered when the centres of its first text lines hit another, unrelated element.
 */
async function coverCheck(page, ks, env, until) {
  const res = new Map();
  if (!ks.length) return res;
  const infos = (await call(page, 'infoMany', ks)).filter(i => i && !i.gone);
  for (const fr of makeFrames(infos, env)) {
    if (Date.now() > until) { for (const i of fr.items) res.set(i.k, { time: true }); continue; }
    await scrollTo(page, fr.top); await sleep(90); await raf(page);
    for (const v of await call(page, 'viewportRects', fr.items.map(i => i.k))) res.set(v.k, v.gone || !v.rects.length ? { gone: true } : { covered: v.covered, coverer: v.coverer });
  }
  await scrollTo(page, 0);
  return res;
}

/** Evidence crops for computed rows (APCA-only): scroll to the frame, one shot, cut the text lines; sets item.row.crop. */
async function cropRows(page, tool, items, env, ctx, cropState, until) {
  try {
    for (const fr of makeFrames(items, env)) {
      if (Date.now() > until) break;
      await scrollTo(page, fr.top); await sleep(120); await raf(page);
      const vr = await call(page, 'viewportRects', fr.items.map(i => i.k));
      const b64 = await shot(page);
      for (const v of vr) {
        const it = fr.items.find(i => i.k === v.k);
        if (!it || v.gone || v.covered || !v.rects.length) continue;
        try {
          const x0 = Math.max(0, Math.min(...v.rects.map(q => q[0])) - 16), y0 = Math.max(0, Math.min(...v.rects.map(q => q[1])) - 16);
          const x1 = Math.min(env.vw, Math.max(...v.rects.map(q => q[0] + q[2])) + 16), y1 = Math.min(env.vh, Math.max(...v.rects.map(q => q[1] + q[3])) + 16);
          const out = await cropInTool(tool, b64, [x0, y0, x1 - x0, y1 - y0], env.vw);
          const rel = join('measure', 'contrast', `${ctx.pid}-${ctx.width}-${String(++cropState.n).padStart(2, '0')}.jpg`);
          mkdirSync(join(ctx.run, 'measure', 'contrast'), { recursive: true });
          writeFileSync(join(ctx.run, rel), Buffer.from(out, 'base64'));
          it.row.crop = rel.split('\\').join('/');
        } catch (e) { progress('contrast: crop failed', e.message); }
      }
    }
  } finally { await scrollTo(page, 0).catch(() => {}); }
}

/**
 * Pixel engine: for element indices ks returns Map k → { info, sample, rects, crop? } | { skipped }.
 * Groups elements into viewport frames. Per frame: scroll, wait for the effects the scroll started (≤ 1 s), read the
 * colours again as they are now, then one shot with text and one with transparent text (two if over video).
 */
async function pixelSample(page, tool, ks, env, ctx, cropState, until = Infinity) {
  const res = new Map();
  if (!ks.length) return res;
  const infos = (await call(page, 'infoMany', ks)).filter(Boolean);
  const live = infos.filter(i => !i.gone && i.visible && !i.gradientText && i.fg);
  for (const i of infos) if (!live.includes(i)) res.set(i.k, { skipped: i.gradientText ? 'gradient-text' : 'invisible' });
  const { vh } = env;
  const frames = makeFrames(live, env);
  for (let fi = 0; fi < frames.length; fi++) {
    const fr = frames[fi];
    if (Date.now() > until) { for (const i of fr.items) if (!res.has(i.k) || res.get(i.k).skipped === 'covered') res.set(i.k, { skipped: 'time' }); continue; }
    let fks = fr.items.map(i => i.k);
    await call(page, 'mark', fks, 'data-rv-nt', true); // no transitions on the sampled text while it is hidden and shown
    try {
      await scrollTo(page, fr.top);
      await sleep(140); await raf(page);
      await call(page, 'settle', fks, 1000).catch(() => null);
      // colours, opacity and visibility as they are on this frame (a caption may have faded out when its cover came into view)
      const fresh = new Map((await call(page, 'infoMany', fks)).filter(Boolean).map(i => [i.k, i]));
      const items = [];
      for (const i of fr.items) {
        const f = fresh.get(i.k);
        if (!f || f.gone || !f.visible || !f.fg || f.gradientText) { res.set(i.k, { skipped: f?.gradientText ? 'gradient-text' : 'invisible-now' }); continue; }
        if (f.fg[3] === 0 && !f.blend) { res.set(i.k, { skipped: 'transparent-fill' }); continue; } // no ink colour: nothing to compare
        items.push({ ...f, box: i.box });
      }
      fks = items.map(i => i.k);
      if (!fks.length) continue;
      const vr = await call(page, 'viewportRects', fks);
      const vis = await shot(page);
      await call(page, 'hide', fks, true);
      await raf(page);
      const hidden = [await shot(page)];
      const video = new Set(items.filter(i => i.overMedia === 'video').map(i => i.k));
      if (video.size) { await sleep(1200); hidden.push(await shot(page)); }
      await call(page, 'hide', fks, false);
      await raf(page);
      const vis2 = await shot(page);
      // covered or gone elements are not sampled at all (they are retried or skipped below)
      const toSample = vr.filter(v => !v.gone && v.rects.length && !v.covered);
      let samples = [];
      try { samples = await sampleInTool(tool, [vis, vis2], hidden, toSample.map(v => ({ rects: v.rects, video: video.has(v.k) })), env.vw, until); }
      catch (e) { progress('contrast: sampling failed', e.message); samples = toSample.map(() => ({ failed: 'error' })); }
      const byK = new Map(toSample.map((v, n) => [v.k, samples[n]]));
      vr.forEach(v => {
        const info = items.find(i => i.k === v.k);
        const sm = byK.get(v.k);
        if (v.gone || !v.rects.length) { res.set(v.k, { skipped: 'offscreen' }); return; }
        if (v.covered) {
          // one retry in its own frame with the element at 45 % of the viewport height
          if (!fr.retry && info && !info.fixed) frames.push({ top: frameTop(env, info.box[1], 0.45), items: [info], retry: true });
          res.set(v.k, { skipped: 'covered', coverer: v.coverer }); return;
        }
        if (sm?.timeout) { res.set(v.k, { skipped: 'sampling-timeout', partial: true }); return; }
        if (sm?.failed) { res.set(v.k, { skipped: 'sampling-failed', partial: true }); return; }
        if (!sm) { res.set(v.k, { skipped: 'no-pixels' }); return; }
        // blend mode / colour filter: the computed colour is not what is on screen — take the ink from the glyph pixels
        if (info.blend) {
          if (!sm.ink || !sm.mask) { res.set(v.k, { skipped: 'blend-no-mask' }); return; }
          res.set(v.k, { info: { ...info, fg: [...sm.ink, 1], opacity: 1, painted: info.blend }, sample: sm, rects: v.rects }); return;
        }
        // self-check: the computed colour should leave a glyph mask on this background; no mask → the text is not
        // painted the way the styles say (faded, covered by a translucent layer, drawn by a canvas) — no figure from it
        if (!video.has(v.k) && !sm.mask) {
          const fg = info.fg; const a = (fg[3] ?? 1) * (info.opacity ?? 1);
          if (d3(blend([fg[0], fg[1], fg[2], a], sm.p50), sm.p50) > 90) { res.set(v.k, { skipped: 'not-painted' }); return; }
        }
        res.set(v.k, { info, sample: sm, rects: v.rects });
      });
    // evidence crops for failures, cut from the shot with visible text
    for (const v of vr) {
      const r = res.get(v.k); if (!r || !r.sample || cropState.left <= 0) continue;
      const w = worst(r.info, r.sample);
      if (w.ratio >= normFor('text', isLarge(r.info.font_px, r.info.weight))) continue;
      try {
        const xs = v.rects.map(q => q[0]), ys = v.rects.map(q => q[1]);
        const x0 = Math.max(0, Math.min(...xs) - 16), y0 = Math.max(0, Math.min(...ys) - 16);
        const x1 = Math.min(env.vw, Math.max(...v.rects.map(q => q[0] + q[2])) + 16), y1 = Math.min(vh, Math.max(...v.rects.map(q => q[1] + q[3])) + 16);
        const b64 = await cropInTool(tool, vis, [x0, y0, x1 - x0, y1 - y0], env.vw);
        const rel = join('measure', 'contrast', `${ctx.pid}-${ctx.width}-${String(++cropState.n).padStart(2, '0')}.jpg`);
        mkdirSync(join(ctx.run, 'measure', 'contrast'), { recursive: true });
        writeFileSync(join(ctx.run, rel), Buffer.from(b64, 'base64'));
        r.crop = rel.split('\\').join('/'); cropState.left--;
      } catch (e) { progress('contrast: crop failed', e.message); }
    }
    } finally {
      await call(page, 'mark', fr.items.map(i => i.k), 'data-rv-nt', false).catch(() => {});
    }
  }
  await scrollTo(page, 0);
  return res;
}

function worst(info, s) {
  const fg = info.fg; const a = (fg[3] ?? 1) * (info.opacity ?? 1);
  const f = [fg[0], fg[1], fg[2], a];
  const lo = blend(f, s.p10), hi = blend(f, s.p90);
  const r1 = ratioRaw(lo, s.p10), r2 = ratioRaw(hi, s.p90);
  return r1 <= r2 ? { ratio: r1, bg: s.p10, fgEff: lo } : { ratio: r2, bg: s.p90, fgEff: hi };
}

const sampleNote = r => [r.info.overMedia === 'video' ? 'video' : r.sample.mask ? null : 'no-glyph-mask', r.sample.moving >= 20 ? 'moving-background' : null,
  r.info.shadow ? 'text-shadow' : null, r.info.inkAnim ? 'animated-text' : null, r.info.ariaHidden ? 'aria-hidden' : null, r.info.painted ? 'painted-colour ' + r.info.painted : null].filter(Boolean).join(', ') || undefined;
// medium: the sample is clean; low: the background moves, the text itself is animated, or a text-shadow takes part
// (WCAG counts a dense halo as the glyph background — the figure needs a look at the crop or on a device)
const sampleConfidence = r => (r.sample.moving >= 20 || r.info.inkAnim || r.info.shadow ? 'low' : 'medium');

function row(base) {
  const large = base.large ?? isLarge(base.font_px || 0, base.weight || 400);
  const norm = base.norm ?? normFor(base.kind, large);
  const ratio = show(base.ratioRaw);
  const out = { kind: base.kind, state: base.state || 'default', selector: base.selector, text: base.text || '', fg: base.fg, bg: base.bg, ratio, norm, pass: base.ratioRaw >= norm,
    large: base.kind === 'text' || base.kind === 'placeholder' ? large : undefined, font_px: base.font_px ? Math.round(base.font_px * 10) / 10 : undefined, weight: base.weight,
    method: base.method, source: base.source, confidence: base.confidence || 'high', reason: base.reason || null, box: base.box || null };
  if (base.bg_range) out.bg_range = base.bg_range;
  if (base.crop) out.crop = base.crop;
  if (base.note) out.note = base.note;
  if (base.needs_device_check) out.needs_device_check = true;
  if (base.fgRgb && base.bgRgb) out.apca = apcaLc(base.fgRgb, base.bgRgb);
  const ac = apcaCheck(base.kind, base.fgRgb, base.bgRgb, base.font_px, base.weight, large);
  if (ac) out.apca_check = ac;
  return out;
}
const RELIABLE = new Set(['high', 'medium']);

const cacheGet = (cache, key) => (cache && typeof cache.get === 'function' ? cache.get(key) : undefined) ?? cache?.[key];

// ---------- collector ----------
export async function collect(page, ctx) {
  const lang = ctx.lang === 'en' ? 'en' : 'ru';
  const out = { url: ctx.url, rows: [], checked: { text_axe: 0, text_sampled: 0, text_computed: 0, hover: 0, focus: 0, placeholders: 0, inputs: 0, icons: 0, apca: 0 }, skipped: [], not_checked: [] };
  const st = ctx.load?.status;
  if (st && st >= 400) { out.not_checked.push(lang === 'en' ? `page answered HTTP ${st}` : `страница ответила HTTP ${st}`); return out; }
  const t0 = Date.now();
  let tq = t0; out.phases_ms = {};
  // own end: snapshot cuts the collector at min(timeoutMs, time left − 8 s); stop earlier and leave the page clean,
  // so the next collectors on this load never see hidden text, forced :hover/:focus or a scrolled page
  const hardEnd = t0 + Math.min(meta.timeoutMs, Math.max(5000, ctx.deadline ? ctx.deadline - t0 - 8000 : meta.timeoutMs));
  const until = hardEnd - 12000;
  const late = () => Date.now() > until;
  let tool = ctx.toolPage, ownTool = false;
  let forced = []; // nodeIds with a forced pseudo state, reset in finally
  try {
    await evalJSON(page, HELPERS);
    const env = await evalJSON(page, '({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio || 1, docH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) })');
    if (!tool) { tool = await page.b.newPage(); ownTool = true; }
    const cropState = { left: MAX_CROPS, n: 0 };
    const axe = cacheGet(ctx.cache, 'axe');
    const axeOk = axe && !axe.unavailable && Array.isArray(axe.violations);
    const cands = []; // { k, reason, source }

    if (axeOk) {
      const viol = (axe.violations.find(r => r.id === 'color-contrast') || { nodes: [] }).nodes;
      const infos = viol.length ? await call(page, 'fromTargets', viol.map(n => n.target)) : [];
      // axe measures styles, not what is on screen: drop text that nobody sees (back face of a flip card, clip-path,
      // clipped by an ancestor), and mark text covered by another layer at its own scroll position
      const ks = infos.filter(Boolean).map(i => i.k);
      const how = ks.length ? await call(page, 'hiddenHow', ks) : [];
      const hiddenBy = new Map(ks.map((k, i) => [k, how[i]]));
      const cover = !late() ? await coverCheck(page, ks.filter(k => !hiddenBy.get(k)), env, until) : new Map();
      viol.forEach((n, i) => {
        const d = n.data || {}; const inf = infos[i] || {};
        const hid = inf.k !== undefined ? hiddenBy.get(inf.k) : null;
        // axe reads styles: under mix-blend-mode / a colour filter its colours are not the painted ones → pixels decide
        if (!hid && inf.blend && inf.k !== undefined) { cands.push({ k: inf.k, reason: 'blend-mode', source: 'axe-violation' }); return; }
        if (hid) { out.skipped.push({ why: 'axe-not-visible', how: hid, selector: inf.sel || n.target.join(' >>> ') }); return; }
        const cv = inf.k !== undefined ? cover.get(inf.k) : null;
        const fg = fromHex(d.fgColor), bg = fromHex(d.bgColor);
        const px = parseFloat((/\((\d+(?:\.\d+)?)px\)/.exec(d.fontSize || '') || [])[1]) || inf.font_px || 0;
        const w = d.fontWeight === 'bold' ? 700 : (inf.weight || 400);
        const doubt = cv?.covered ? `covered: ${cv.coverer || '?'}` : cv?.gone ? 'not-in-viewport' : inf.inkAnim ? 'animated-text' : null;
        // aria-hidden text is still seen and still under 1.4.3; the mark only helps to tell decoration (incidental) apart
        const mark = [doubt, inf.ariaHidden ? 'aria-hidden' : null].filter(Boolean).join(', ') || undefined;
        out.rows.push(row({ kind: 'text', selector: inf.sel || n.target.join(' >>> '), text: inf.text || '', fg: d.fgColor || null, bg: d.bgColor || null,
          ratioRaw: d.contrastRatio ?? (fg && bg ? ratioRaw(fg, bg) : 0), norm: parseFloat(d.expectedContrastRatio) || undefined, font_px: px, weight: w,
          method: 'axe', source: 'axe-violation', box: n.box || inf.box, fgRgb: fg, bgRgb: bg, confidence: inf.inkAnim ? 'low' : doubt ? 'medium' : 'high', note: mark })); // an animated opacity/colour: the figure depends on the moment axe looked
      });
      out.checked.text_axe = viol.length;
      const inc = (axe.incomplete.find(r => r.id === 'color-contrast') || { nodes: [] }).nodes.filter(n => !SKIP_REASONS.has(n.reason));
      const incInfos = inc.length ? await call(page, 'fromTargets', inc.map(n => n.target)) : [];
      inc.forEach((n, i) => { const inf = incInfos[i]; if (inf && !inf.disabled) cands.push({ k: inf.k, reason: n.reason || 'incomplete', source: 'axe-incomplete' }); });
      const skippedIcons = (axe.incomplete.find(r => r.id === 'color-contrast') || { nodes: [] }).nodes.length - inc.length;
      if (skippedIcons > 0) out.skipped.push({ why: 'nonBmp/short', count: skippedIcons });
    } else {
      out.not_checked.push(lang === 'en' ? `axe unavailable (${axe?.unavailable || 'collector did not run'}): own computed-colour scan instead` : `axe недоступен (${axe?.unavailable || 'коллектор не запускался'}): вместо него свой скан по вычисленным цветам`);
      const s = await call(page, 'scanText', 1500, 200, MAX_SAMPLED);
      out.checked.text_computed = s.checked;
      for (const f of s.fails) {
        const fg = blend([f.fg[0], f.fg[1], f.fg[2], (f.fg[3] ?? 1) * f.opacity], f.bg);
        const r = ratioRaw(fg, f.bg);
        if (r >= normFor('text', isLarge(f.font_px, f.weight))) continue;
        out.rows.push(row({ kind: 'text', selector: f.sel, text: f.text, fg: hex(fg), bg: hex(f.bg), ratioRaw: r, font_px: f.font_px, weight: f.weight,
          method: 'computed', source: 'own-scan', confidence: 'medium', box: f.box, fgRgb: fg, bgRgb: f.bg }));
      }
      for (const c of s.cands) cands.push({ k: c.k, reason: c.reason, source: 'own-scan' });
      for (const h of s.skipped || []) out.skipped.push({ why: 'not-visible', how: h.how, selector: h.sel });
    }

    // text under mix-blend-mode / colour filters: always decided by pixels (≤ 20 per page)
    if (!late()) for (const k of await call(page, 'blendText', 20)) cands.push({ k, reason: 'blend-mode', source: 'blend-scan' });
    // pixel sampling of undecided text (≤ MAX_SAMPLED)
    const uniq = [...new Map(cands.map(c => [c.k, c])).values()];
    if (uniq.length > MAX_SAMPLED) out.not_checked.push(lang === 'en' ? `${uniq.length - MAX_SAMPLED} more undecided text elements were not sampled (limit ${MAX_SAMPLED})` : `ещё ${uniq.length - MAX_SAMPLED} спорных текстовых элементов не сэмплированы (предел ${MAX_SAMPLED})`);
    const take = uniq.slice(0, MAX_SAMPLED);
    await evalJSON(page, 'window.__rvC.style(true)');
    out.phases_ms.prepare = Date.now() - tq; tq = Date.now();
    const sampled = await pixelSample(page, tool, take.map(c => c.k), env, ctx, cropState, Math.min(until, Date.now() + SAMPLE_MS));
    for (const c of take) {
      const r = sampled.get(c.k);
      if (!r || r.skipped) {
        if (r?.skipped === 'time') { out.time_capped = (out.time_capped || 0) + 1; continue; }
        if (r?.partial) { out.partial = true; out.sampling_cut = (out.sampling_cut || 0) + 1; }
        out.skipped.push({ why: r?.skipped || 'n/a', reason: c.reason, coverer: r?.coverer }); continue;
      }
      const w = worst(r.info, r.sample);
      out.checked.text_sampled++;
      out.rows.push(row({ kind: 'text', selector: r.info.sel, text: r.info.text, fg: hex(w.fgEff), bg: hex(w.bg), bg_range: [hex(r.sample.p10), hex(r.sample.p90)], ratioRaw: w.ratio,
        font_px: r.info.font_px, weight: r.info.weight, method: 'pixel-sample', source: c.source, reason: c.reason, confidence: sampleConfidence(r), box: r.info.box, crop: r.crop,
        note: sampleNote(r), needs_device_check: !!r.info.shadow, fgRgb: w.fgEff, bgRgb: w.bg }));
    }

    // hover / focus states of buttons: forced on the control, text colour read from its text element
    out.phases_ms.sample = Date.now() - tq; tq = Date.now();
    const pairs = late() ? [] : await call(page, 'buttons', MAX_BUTTONS);
    if (late()) out.not_checked.push(lang === 'en' ? 'hover/focus states, placeholders, non-text: collector time limit' : 'hover/focus, плейсхолдеры, не-текст: предел времени коллектора');
    if (pairs.length) {
      await page.send('DOM.enable').catch(() => {});
      await page.send('CSS.enable').catch(() => {});
      await page.send('DOM.getDocument', { depth: 0 });
      const nodes = [];
      for (const p of pairs) {
        try {
          const result = await evalJSON(page, `window.__rvC.el(${p.k})`, 10000, false);
          const { nodeId } = await page.send('DOM.requestNode', { objectId: result.objectId });
          if (nodeId) nodes.push({ ...p, nodeId });
        } catch { /* detached */ }
      }
      await call(page, 'mark', nodes.map(n => n.k), 'data-rv-ps', true);
      const ks = nodes.map(n => n.k), kts = nodes.map(n => n.kt);
      const base = await call(page, 'sig', ks, kts);
      const stateUntil = Math.min(until, Date.now() + STATE_MS);
      for (const state of ['hover', 'focus']) {
        if (late()) break;
        forced = nodes.map(n => n.nodeId);
        for (const n of nodes) await page.send('CSS.forcePseudoState', { nodeId: n.nodeId, forcedPseudoClasses: state === 'hover' ? ['hover'] : ['focus', 'focus-visible'] }).catch(() => {});
        await raf(page); await sleep(60);
        const now = await call(page, 'sig', ks, kts);
        const changed = [];
        for (let i = 0; i < now.length; i++) {
          const sg = now[i], b = base[i]; if (!sg || !b || !sg.fg || !sg.fg.fg) continue;
          out.checked[state]++;
          if (state === 'focus') {
            // focus indicator: outline / box-shadow → ring contrast against the surrounding background
            const [ost, ow, oc] = sg.outline;
            const pbg = sg.parentBg.color;
            let ring = null;
            if (ost === 'auto') ring = { type: 'browser-default' };
            else if (ost !== 'none' && ow > 0 && oc && oc[3] > 0) ring = { type: 'outline', color: oc };
            else if (sg.shadow !== 'none' && sg.shadow !== b.shadow) { const m = /rgba?\([^)]*\)/.exec(sg.shadow); if (m) ring = { type: 'box-shadow', color: parseRgb(m[0]) }; }
            if (ring && ring.type !== 'browser-default' && pbg) {
              const rc = blend(ring.color, pbg); const r = ratioRaw(rc, pbg);
              if (r < 3) {
                const inf = await evalJSON(page, `(() => { const i = window.__rvC.info(${sg.k}); return { sel: i.sel, text: i.text, box: i.box }; })()`);
                out.rows.push(row({ kind: 'focus-ring', state: 'focus', selector: inf.sel, text: inf.text, fg: hex(rc), bg: hex(pbg), ratioRaw: r, method: 'computed', source: 'forced-state', box: inf.box, note: ring.type, fgRgb: rc, bgRgb: pbg }));
              }
            } else if (!ring && JSON.stringify([sg.bg, sg.fg.fg, sg.border, sg.deco]) === JSON.stringify([b.bg, b.fg.fg, b.border, b.deco])) {
              out.skipped.push({ why: 'no-focus-style-css', selector: (await evalJSON(page, `window.__rvC.sel(window.__rvC.el(${sg.k}))`)) });
            }
          }
          // text contrast only where the state changes colours (the default state is covered by axe)
          if (JSON.stringify([sg.bg, sg.fg.fg, sg.bgimg]) !== JSON.stringify([b.bg, b.fg.fg, b.bgimg])) changed.push(kts[i]);
        }
        if (changed.length) {
          const px = await pixelSample(page, tool, changed, env, ctx, cropState, stateUntil);
          for (const kt of changed) {
            const r = px.get(kt);
            if (r?.partial) { out.partial = true; out.sampling_cut = (out.sampling_cut || 0) + 1; }
            if (!r || r.skipped) continue;
            const w = worst(r.info, r.sample);
            if (w.ratio >= normFor('text', isLarge(r.info.font_px, r.info.weight))) continue;
            out.rows.push(row({ kind: 'text', state, selector: r.info.sel, text: r.info.text, fg: hex(w.fgEff), bg: hex(w.bg), bg_range: [hex(r.sample.p10), hex(r.sample.p90)], ratioRaw: w.ratio,
              font_px: r.info.font_px, weight: r.info.weight, method: 'pixel-sample', source: 'forced-state', confidence: sampleConfidence(r), box: r.info.box, crop: r.crop,
              note: sampleNote(r), needs_device_check: !!r.info.shadow, fgRgb: w.fgEff, bgRgb: w.bg }));
          }
        }
        for (const n of nodes) await page.send('CSS.forcePseudoState', { nodeId: n.nodeId, forcedPseudoClasses: [] }).catch(() => {});
        forced = [];
      }
    }

    if (out.sampling_cut) out.not_checked.push(lang === 'en' ? `${out.sampling_cut} text elements: pixel sampling cut by its time limit or failed (partial result)` : `${out.sampling_cut} текстовых элементов: сэмплинг пикселей оборван пределом времени или упал (частичный результат)`);
    if (out.time_capped) out.not_checked.push(lang === 'en' ? `${out.time_capped} text elements not sampled: time cap ${SAMPLE_MS / 1000} s` : `${out.time_capped} текстовых элементов не сэмплированы: предел времени ${SAMPLE_MS / 1000} с`);
    // placeholders, field borders, icon-only buttons
    out.phases_ms.states = Date.now() - tq; tq = Date.now();
    const nt = late() ? { ph: [], inputs: [], icons: [] } : await call(page, 'nonText', 20);
    for (const p of nt.ph) {
      if (!p.fg || !p.bg) { out.skipped.push({ why: p.parentImage ? 'placeholder-over-image' : 'placeholder-no-colour', selector: p.sel }); continue; }
      out.checked.placeholders++;
      const fe = blend(p.fg, p.bg); const r = ratioRaw(fe, p.bg);
      out.rows.push(row({ kind: 'placeholder', selector: p.sel, text: p.text, fg: hex(fe), bg: hex(p.bg), ratioRaw: r, font_px: p.font_px, weight: p.weight, method: 'computed', source: 'placeholder', box: p.box,
        note: p.labelled ? undefined : (lang === 'en' ? 'placeholder is the only label' : 'плейсхолдер — единственная подпись'), fgRgb: fe, bgRgb: p.bg }));
    }
    for (const f0 of nt.inputs) {
      // the field and wrappers of its size: the best visible boundary counts
      const all = [f0, ...(f0.alts || [])];
      const cand = all.filter(f => f.parentBg).map(f => {
        const rb = Math.max(f.border ? ratioRaw(blend(f.border, f.parentBg), f.parentBg) : 0, f.shadow ? ratioRaw(blend(f.shadow, f.parentBg), f.parentBg) : 0);
        const rf = f.fieldBg ? ratioRaw(f.fieldBg, f.parentBg) : 0;
        return { f, rb, rf, best: Math.max(rb, rf) };
      }).sort((a, b) => b.best - a.best);
      if (!cand.length) { out.skipped.push({ why: 'field-over-image', selector: f0.sel }); continue; }
      out.checked.inputs++;
      const { f, rb, rf, best } = cand[0];
      if (best >= 3) continue;
      if (all.some(x => !x.parentBg)) { out.skipped.push({ why: 'field-over-image', selector: f0.sel }); continue; } // a wrapper sits on a picture
      const fg = rb >= rf && f.border ? blend(f.border, f.parentBg) : (f.fieldBg || f.parentBg);
      out.rows.push(row({ kind: 'non-text', selector: f0.sel, text: '', fg: hex(fg), bg: hex(f.parentBg), ratioRaw: best, method: 'computed', source: 'field-boundary', box: f0.box, confidence: 'medium',
        note: (lang === 'en' ? `field border ${rb ? show(rb) : '—'}:1, field fill ${show(rf)}:1 vs surrounding` : `рамка поля ${rb ? show(rb) : '—'}:1, заливка поля ${show(rf)}:1 к окружению`)
          + (f.by ? (lang === 'en' ? ` (box drawn by ${f.by})` : ` (рамку рисует ${f.by})`) : '')
          + (lang === 'en' ? '; look at the screenshot: an underline or a label may mark the field' : '; посмотреть кадр: поле может обозначать подчёркивание или подпись'), fgRgb: fg, bgRgb: f.parentBg }));
    }
    for (const ic of nt.icons) {
      if (!ic.bg) { out.skipped.push({ why: 'icon-over-image', selector: ic.sel }); continue; }
      out.checked.icons++;
      const fe = blend([ic.fg[0], ic.fg[1], ic.fg[2], (ic.fg[3] ?? 1) * (ic.opacity ?? 1)], ic.bg);
      const r = ratioRaw(fe, ic.bg);
      if (r >= 3) continue;
      out.rows.push(row({ kind: 'non-text', selector: ic.sel, text: '', fg: hex(fe), bg: hex(ic.bg), ratioRaw: r, method: 'computed', source: 'icon', box: ic.box, note: lang === 'en' ? 'icon-only control' : 'кнопка-иконка без текста', fgRgb: fe, bgRgb: ic.bg }));
    }

    // APCA: text that passes WCAG but is light on dark, thin or small (axe never lists passing text)
    out.phases_ms.nontext = Date.now() - tq; tq = Date.now();
    if (late()) out.not_checked.push(lang === 'en' ? 'APCA check of passing text: collector time limit' : 'проверка APCA для проходящего текста: предел времени коллектора');
    else {
      const seen = new Set(out.rows.map(r => r.selector + '|' + r.state));
      const a = await call(page, 'apcaText', 1500, 300);
      out.checked.apca = a.items.length;
      const crops = [];
      for (const it of a.items) {
        if (seen.has(it.sel + '|default')) continue;
        const fe = blend([it.fg[0], it.fg[1], it.fg[2], (it.fg[3] ?? 1) * it.opacity], it.bg);
        const r = ratioRaw(fe, it.bg);
        if (r < normFor('text', isLarge(it.font_px, it.weight))) continue; // a WCAG failure is axe's (or own-scan's) row
        const ac = apcaCheck('text', fe, it.bg, it.font_px, it.weight, isLarge(it.font_px, it.weight));
        if (!ac || ac.pass) continue;
        const rw = row({ kind: 'text', selector: it.sel, text: it.text, fg: hex(fe), bg: hex(it.bg), ratioRaw: r, font_px: it.font_px, weight: it.weight,
          method: 'computed', source: 'apca-scan', confidence: 'medium', box: it.box, fgRgb: fe, bgRgb: it.bg });
        out.rows.push(rw); seen.add(it.sel + '|default');
        if (crops.length < APCA_CROPS) crops.push({ k: it.k, box: it.box, fixed: it.fixed, row: rw });
        if (out.rows.filter(x => x.source === 'apca-scan').length >= MAX_APCA_ROWS) break;
      }
      if (crops.length && !late()) await cropRows(page, tool, crops, env, ctx, cropState, until);
    }
  } catch (e) {
    out.error = (lang === 'en' ? 'contrast failed: ' : 'контраст не досчитан: ') + String(e.message || e).slice(0, 300);
  } finally {
    // restore the page for the next collectors
    for (const nodeId of forced) await page.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {});
    // (by DOM queries, not through the helper object: it is gone if the world was re-created)
    try { await evalJSON(page, `(() => { for (const el of document.querySelectorAll('[data-rv-hide],[data-rv-ps],[data-rv-nt]')) { el.removeAttribute('data-rv-hide'); el.removeAttribute('data-rv-ps'); el.removeAttribute('data-rv-nt'); }
      const s = document.getElementById('__rv_contrast_style'); if (s) s.remove(); window.scrollTo({ top: 0, left: 0, behavior: 'instant' }); return 0; })()`, 10000); } catch {}
    if (ownTool && tool) await tool.close();
  }
  out.phases_ms.rest = Date.now() - tq;
  out.ms = Date.now() - t0;
  return out;
}

function parseRgb(s) { const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/.exec(s); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : [0, 0, 0, 1]; }

// ---------- finalize: one row per element × state, merged across widths and pages ----------
export async function finalize(all, ctx) {
  const lang = ctx.lang === 'en' ? 'en' : 'ru';
  const out = { ...measureHeader('contrast', ctx.run), partial: false, resume: null };
  const merged = new Map();
  const checked = { text_axe: 0, text_sampled: 0, text_computed: 0, hover: 0, focus: 0, placeholders: 0, inputs: 0, icons: 0, apca: 0 };
  for (const { pid, width, data } of all) {
    if (!data) continue;
    out.pages.push({ pid, width, url: data.url || null, ms: data.ms ?? null, checked: data.checked, rows: data.rows?.length || 0, fails: (data.rows || []).filter(r => !r.pass).length,
      skipped: (data.skipped || []).length, skipped_sample: (data.skipped || []).slice(0, 12), ...(data.partial ? { partial: true, sampling_cut: data.sampling_cut || 0 } : {}) });
    if (data.error) out.errors.push({ pid, width, error: data.error });
    for (const n of data.not_checked || []) out.not_checked.push({ pid, width, what: 'contrast', why: n });
    for (const k of Object.keys(checked)) checked[k] += data.checked?.[k] || 0;
    for (const r of data.rows || []) {
      // one figure per element × state for the whole report: the worst over widths and pages. The text is part of the
      // key: a positional selector (main > p:nth-of-type(2)) names different elements on different pages
      const key = [r.kind, r.state, r.selector, String(r.text || '').slice(0, 40)].join('|');
      let m = merged.get(key);
      const where = { pid, url: data.url, width, ratio: r.ratio, box: r.box, ...(r.crop ? { crop: r.crop } : {}) };
      if (!m) { const { box, crop, ...rest } = r; m = { ...rest, where: [where] }; merged.set(key, m); continue; }
      m.where.push(where);
      const prevApca = m.apca_check;
      if (r.ratio / r.norm < m.ratio / m.norm) {
        const { box, crop, ...rest } = r;
        Object.assign(m, rest);
        if (!r.bg_range) delete m.bg_range;
        if (!r.note) delete m.note;
        if (!r.apca_check) delete m.apca_check;
      }
      // APCA: the worst check over widths and pages (the font is often smaller at 390)
      const cands = [prevApca, r.apca_check, m.apca_check].filter(Boolean);
      if (cands.length) m.apca_check = cands.sort((a, b) => (a.pass - b.pass) || apcaGap(a) - apcaGap(b))[0];
    }
  }
  let rows = [...merged.values()].map(m => ({ ...m, pages_affected: new Set(m.where.map(w => w.pid)).size, sitewide: new Set(m.where.map(w => w.pid)).size > 1 }));
  rows.sort((a, b) => (a.pass - b.pass) || (apcaFail(b) - apcaFail(a)) || (a.ratio / a.norm) - (b.ratio / b.norm));
  const total = rows.length;
  // keep all failures and APCA failures, passes only for undecided (sampled) text and placeholders, ≤ 400 rows
  rows = rows.filter(r => !r.pass || apcaFail(r) || r.method === 'pixel-sample' || r.kind === 'placeholder').slice(0, 400);
  rows.forEach((r, i) => { r.id = 'c-' + String(i + 1).padStart(3, '0'); });
  out.items = rows.map(({ id, ...r }) => ({ id, ...r }));
  const fails = rows.filter(r => !r.pass);
  // low confidence (moving background, animated text, text-shadow): kept as rows to look at, never in worst/pairs
  const sure = fails.filter(r => RELIABLE.has(r.confidence));
  const byKind = {};
  for (const r of rows) { const b = byKind[r.kind] ||= { rows: 0, fail: 0, fail_low: 0 }; b.rows++; if (!r.pass) { b.fail++; if (!RELIABLE.has(r.confidence)) b.fail_low++; } }
  // colour pairs: same fg/bg/norm across elements → one line in the colour table
  const pairs = new Map();
  for (const r of sure) {
    const key = [r.kind, r.state, r.fg, r.bg, r.norm].join('|');
    const p = pairs.get(key) || { kind: r.kind, state: r.state, fg: r.fg, bg: r.bg, ratio: r.ratio, norm: r.norm, elements: 0, pages: new Set(), example: r.selector, ids: [] };
    p.elements++; r.where.forEach(w => p.pages.add(w.pid)); if (p.ids.length < 10) p.ids.push(r.id); p.ratio = Math.min(p.ratio, r.ratio);
    pairs.set(key, p);
  }
  // APCA (dark background, thin, small text): all failures and those that pass WCAG (the extra findings of the rule)
  const apcaRows = rows.filter(r => apcaFail(r) && RELIABLE.has(r.confidence)).sort((a, b) => apcaGap(a.apca_check) - apcaGap(b.apca_check));
  const apcaOnly = apcaRows.filter(r => r.pass);
  const apcaLine = r => `${r.id} ${r.selector} «${(r.text || '').slice(0, 30)}» ${r.fg} ${lang === 'en' ? 'on' : 'на'} ${r.bg}: WCAG ${r.ratio}:1 ${r.pass ? (lang === 'en' ? 'passes' : 'проходит') : (lang === 'en' ? 'fails' : 'не проходит')}, APCA Lc ${r.apca_check.lc} (${lang === 'en' ? 'threshold' : 'порог'} ${r.apca_check.need}; ${r.apca_check.why.join(', ')}; ${r.font_px} px / ${r.weight})`;
  const apcaSum = list => ({ count: list.length, ids: list.slice(0, 20).map(r => r.id), examples: list.slice(0, 5).map(apcaLine) });
  out.summary = {
    apca_fails: apcaSum(apcaRows),
    apca_only_fails: apcaSum(apcaOnly),
    pages_partial: out.pages.filter(p => p.partial).map(p => `${p.pid}@${p.width}`),
    rows_total: total, rows_kept: rows.length, fails: fails.length, fails_reliable: sure.length, fails_low_confidence: fails.length - sure.length, by_kind: byKind, checked,
    methods: rows.reduce((a, r) => { a[r.method] = (a[r.method] || 0) + 1; return a; }, {}),
    pairs: [...pairs.values()].sort((a, b) => b.elements - a.elements).slice(0, 25).map(p => ({ ...p, pages: [...p.pages] })),
    worst: sure.slice(0, 5).map(r => `${r.selector} «${(r.text || '').slice(0, 30)}» ${r.fg} ${lang === 'en' ? 'on' : 'на'} ${r.bg} = ${r.ratio}:1 (${lang === 'en' ? 'norm' : 'норма'} ${r.norm}:1, ${r.state})`),
    confidence_note: lang === 'en' ? 'worst and pairs use high/medium rows only; low rows (moving background, animated text, text-shadow) need a look at the crop or a device (needs_device_check).'
      : 'worst и pairs — только строки high/medium; строки low (движущийся фон, анимированный текст, text-shadow) — смотреть кроп или на устройстве (needs_device_check).',
    norms: lang === 'en' ? 'WCAG 2.2: text 4.5:1, large text (≥24 px or ≥18.66 px bold) 3:1, non-text and focus ring 3:1 (1.4.3, 1.4.11). WCAG 2.2 is the norm; a dark background, thin and small text are also checked by APCA: body text Lc 75 (apca_check: large 60, thin 90/75, under 14 px 90).'
      : 'WCAG 2.2: текст 4,5:1, крупный (от 24 px или от 18,66 px жирный) 3:1, не-текст и кольцо фокуса 3:1 (1.4.3, 1.4.11). WCAG 2.2 — норма; тёмный фон, тонкий и мелкий текст дополнительно по APCA: основной текст Lc 75 (apca_check: крупный 60, тонкий 90/75, мельче 14 px 90).',
    method_note: lang === 'en' ? 'pixel-sample: after the scroll effects settle, text made transparent (its text-shadow stays), 10th/90th percentile of luminance under the glyphs, worst of two; confidence medium, low with a moving background, animated text or text-shadow. Text whose colour leaves no glyph on screen is skipped (not-painted). Under mix-blend-mode or a colour filter the text colour is taken from the painted glyph pixels (note painted-colour); axe rows of text nobody sees (back face, clip-path, clipped) are dropped; covered ones get medium. All measurements run in an isolated JS world.'
      : 'pixel-sample: после эффектов прокрутки текст делается прозрачным (его text-shadow остаётся), 10-й и 90-й перцентили светлоты под глифами, берётся худший; уверенность medium, low при движущемся фоне, анимированном тексте или text-shadow. Текст, цвет которого не оставляет глифов на экране, пропускается (not-painted). Под mix-blend-mode или цветовым фильтром цвет текста берётся с нарисованных глифов (note painted-colour). Строки axe для невидимого текста (оборот карточки, clip-path, обрезан) отброшены, закрытые слоем — medium. Все замеры — в изолированном JS-мире.',
  };
  if (typeof ctx.writeMeasure === 'function') ctx.writeMeasure('contrast', out);
  else writeJSON(join(ctx.run, 'measure', 'contrast.json'), out);
  const lines = lang === 'en'
    ? [`contrast: ${fails.length} failing rows of ${rows.length}, reliable ${sure.length} (sampled ${checked.text_sampled}, hover ${checked.hover}, focus ${checked.focus}, placeholders ${checked.placeholders})`]
    : [`контраст: не проходят ${fails.length} строк из ${rows.length}, надёжных ${sure.length} (сэмплировано ${checked.text_sampled}, hover ${checked.hover}, focus ${checked.focus}, плейсхолдеров ${checked.placeholders})`];
  for (const w of out.summary.worst.slice(0, 3)) lines.push('  ' + w);
  const sa = out.summary.apca_fails, so = out.summary.apca_only_fails;
  if (sa.count) lines.push(lang === 'en' ? `APCA (dark/thin/small text): ${sa.count} rows below the threshold, ${so.count} of them pass WCAG` : `APCA (тёмный фон, тонкий и мелкий текст): ниже порога ${sa.count} строк, из них ${so.count} проходят WCAG`);
  for (const w of so.examples.slice(0, 2)) lines.push('  ' + w);
  const s = out.summary;
  return { files: ['measure/contrast.json'], lines, summary: { rows_total: s.rows_total, rows_kept: s.rows_kept, fails: s.fails, fails_reliable: s.fails_reliable, fails_low_confidence: s.fails_low_confidence, apca_fails: s.apca_fails.count, apca_only_fails: s.apca_only_fails.count, pages_partial: s.pages_partial.length } };
}
