// Revizor collector «layout» — layout on this width → measure/layout.json.
// Collector interface: meta, collect(page, ctx), finalize(all, ctx) → { files, lines, summary }; called by snapshot.mjs.
//  · horizontal overflow and its culprit, minding clipping by an ancestor (overflow hidden/clip/auto,
//    content-visibility other than visible);
//  · touch targets: < 24 px (WCAG 2.5.8 AA, with the spacing exception and links inside a sentence excluded) and
//    < 44 px (WCAG 2.5.5 / Apple HIG), gaps < 8 px, hit-test document.elementFromPoint at each center
//    (the page is scrolled so the target sits mid-screen; scroll returns to the top at the end);
//  · share of characters smaller than 12 / 14 / 16 px (decorative aria-hidden text counted apart), form fields < 16 px;
//  · a phone page without meta viewport is shown zoomed out (≈ 0.4): sizes of text and targets are taken
//    as the phone shows them (CSS px × scale), the first screen is judged on the zoomed-out view;
//  · fixed/sticky layers and the share of the visible screen they take at the top and after scrolling;
//  · first screen: is an action button fully visible at the fold heights of this width
//    (390 → 664 Safari with bars and 844; 1280 → 689 laptop window; 1440 → 789 and 900; …), H1 lines;
//  · :hover rules outside @media (hover: hover) — reveal (menus, overlays) and transform (sticky zoom on tap);
//  · page length in screens; cheap design tokens (radii, button heights, eyebrows, colours by frequency).
// Runs last among collectors (order 90) because the hit-test scrolls the page.

import { ensureHelpers, ev, loadInfo, groupByPid, logDropped, getCssAnalysis, writeMeasureMerged, pageEntry } from './meta.mjs';
import { nowIso } from '../lib/util.mjs';

// every width the snapshot may take (default 1440, 390, 768; deep adds 1280 and 1024; --widths adds others)
export const meta = { name: 'layout', widths: [280, 320, 360, 375, 390, 412, 414, 430, 440, 600, 744, 768, 820, 834, 1024, 1280, 1366, 1440, 1536, 1920], order: 90, timeoutMs: 120000 };

// visible heights to judge «first screen» on each width (real browser windows, not only the emulated one)
export const FOLD_HEIGHTS = { 320: [568], 360: [640, 740], 375: [667], 390: [664, 844], 412: [732, 915], 414: [736, 896], 430: [740, 932], 440: [760, 956], 744: [1133], 768: [1024], 820: [1180], 834: [1194], 1024: [657, 768], 1280: [689, 800], 1366: [657], 1440: [789, 900], 1536: [745], 1920: [969, 1080] };

async function layoutInPage(o) {
  const H = window.__revizorH;
  const tick = ms => new Promise(r => setTimeout(r, ms));
  const q = s => { try { return [...document.querySelectorAll(s)]; } catch { return []; } };
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  await tick(80);
  H.reset();
  const de = document.documentElement, body = document.body;
  if (!body) return { error: 'no body' };
  const W = de.clientWidth || innerWidth, VH = innerHeight;
  // overflow wider than the phone grows the layout viewport (innerWidth/innerHeight) while the scale stays 1
  const zoomOut = o.width && innerWidth > W + 1 ? innerWidth / W : 1;
  const VHu = Math.round(VH / zoomOut); // window height at scale 1
  // a page without meta viewport (or with a fixed width) is laid out ≈ 980 px wide and shown at scale < 1
  const vv = H.vv();
  const S = vv.scale;
  const VVW = vv.w, VVH = vv.h; // what the screen shows, in CSS px
  const vpMeta = document.querySelector('meta[name="viewport" i]');
  const round2 = x => Math.round(x * 100) / 100;
  const SKIPT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE', 'BR', 'WBR']);
  const all = body.getElementsByTagName('*');
  const N = Math.min(all.length, o.maxElements);
  const inFixed = el => H.inFixed(el);
  const transparent = c => /rgba\(0, 0, 0, 0\)|transparent/.test(c || '');
  const errors = [];

  // ---------- overflow
  const sw = Math.max(de.scrollWidth, body.scrollWidth);
  const ox = v => v === 'hidden' || v === 'clip';
  const pageClips = ox(H.cs(de).overflowX) || ox(H.cs(body).overflowX);
  const over = new Set(), overList = [], cutLeft = [], textOver = [], textOverSet = new Set();
  for (let i = 0; i < N; i++) {
    const el = all[i];
    if (SKIPT.has(el.tagName)) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.right > W + 1) { over.add(el); overList.push(el); }
    else {
      if (r.left < -1 && r.right > 4 && cutLeft.length < 40) cutLeft.push(el);
      // the box fits, its own content does not (a long word or URL, white-space: nowrap)
      if (el.scrollWidth > el.clientWidth + 1 && r.left + el.scrollWidth > W + 1 && H.cs(el).overflowX === 'visible' && textOver.length < 200) { textOver.push(el); textOverSet.add(el); }
    }
  }
  // an ancestor that clips the element (overflow other than visible, paint containment, content-visibility)
  const clipOf = el => {
    for (let a = el.parentElement; a && a !== body && a !== de; a = a.parentElement) {
      const c = H.cs(a);
      if (c.overflowX !== 'visible' || /paint|strict|content/.test(c.contain || '') || H.cvClips(c)) {
        const ar = a.getBoundingClientRect();
        if (ar.right <= W + 1 && ar.left >= -1) return { by: a, scroll: c.overflowX === 'auto' || c.overflowX === 'scroll' };
      }
      if (c.position === 'fixed') return { by: a, fixed: true };
    }
    return null;
  };
  // a layer nobody sees (opacity:0, visibility:hidden, a closed menu or popup) is not a culprit to show on a frame;
  // it is named only when nothing visible explains a real horizontal scroll
  const closedLayer = el => {
    if (!H.opaque(el)) return 'invisible';
    for (let a = el, d = 0; a && a !== body && d < 8; a = a.parentElement, d++) { const k = H.ownKind(a); if (k === 'menu' || k === 'popup') return k; }
    return null;
  };
  const roots = [], rootsHidden = [];
  let outsideReal = 0, outsideHidden = 0;
  for (const el of overList) {
    if (inFixed(el)) continue;
    if (clipOf(el)) continue;
    const layer = closedLayer(el);
    if (layer) outsideHidden++; else outsideReal++;
    const p = el.parentElement;
    if (!(p && over.has(p) && !inFixed(p) && !clipOf(p))) (layer ? rootsHidden : roots).push(el);
  }
  for (const el of textOver) {
    if (inFixed(el) || clipOf(el)) continue;
    let childOver = false;
    for (const d of el.getElementsByTagName('*')) if (over.has(d) || textOverSet.has(d)) { childOver = true; break; }
    if (childOver || over.has(el.parentElement)) continue;
    el.__rvContent = true;
    if (closedLayer(el)) { rootsHidden.push(el); outsideHidden++; } else { roots.push(el); outsideReal++; }
  }
  const hiddenSet = new Set(rootsHidden);
  const culpritEls = roots.length || sw - W <= 0 ? roots : rootsHidden;
  for (const el of rootsHidden) if (!culpritEls.includes(el)) delete el.__rvContent;
  const culprits = culpritEls.slice(0, 15).map(el => {
    const r = el.getBoundingClientRect(), c = H.cs(el);
    let deepest = null, maxR = r.right - 0.5;
    for (const d of el.getElementsByTagName('*')) { if (!over.has(d)) continue; const dr = d.getBoundingClientRect(); if (dr.right >= maxR) { maxR = dr.right; deepest = d; } }
    const dd = deepest && deepest !== el ? { selector: H.sel(deepest), tag: deepest.tagName.toLowerCase(), box: H.box(deepest), text: H.clean(H.textOf(deepest) || deepest.getAttribute('alt') || '', 60), white_space: H.cs(deepest).whiteSpace, width_css: H.cs(deepest).width } : null;
    const content = !!el.__rvContent; delete el.__rvContent;
    const right = content ? r.left + el.scrollWidth : r.right;
    return { selector: H.sel(el), tag: el.tagName.toLowerCase(), box: H.box(el), right: Math.round(right), over_px: Math.round(right - W), content_overflow: content || undefined,
      css: { width: c.width, min_width: c.minWidth, max_width: c.maxWidth, white_space: c.whiteSpace, position: c.position, display: c.display,
        transform: c.transform !== 'none' ? c.transform.slice(0, 80) : null, margin: [c.marginLeft, c.marginRight] },
      visible: H.opaque(el), invisible_layer: hiddenSet.has(el) ? closedLayer(el) : undefined, text: H.clean(H.textOf(el) || '', 80), deepest: dd };
  });
  const scrollContainers = [];
  for (let i = 0; i < N && scrollContainers.length < 15; i++) {
    const el = all[i]; const c = H.cs(el);
    if ((c.overflowX === 'auto' || c.overflowX === 'scroll') && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && H.rendered(el))
      scrollContainers.push({ selector: H.sel(el), client_width: el.clientWidth, scroll_width: el.scrollWidth, table: el.tagName === 'TABLE' || !!el.querySelector('table'), text: H.clean(H.textOf(el) || '', 60) });
  }
  const tables = q('table').filter(t => H.rendered(t)).map(t => ({ selector: H.sel(t), width: Math.round(t.getBoundingClientRect().width), wider: t.getBoundingClientRect().width > W + 1, in_scroll: !!clipOf(t) && !!(clipOf(t) || {}).scroll })).filter(t => t.wider).slice(0, 10);
  const overflow = { client_width: W, inner_width: innerWidth, scroll_width: sw, overflow_px: Math.max(0, sw - W), page_clips_x: pageClips,
    viewport_expanded: o.width ? innerWidth > o.width + 1 && S === 1 : false,
    outside_count: outsideReal, outside_hidden_layers: outsideHidden, culprits,
    hidden_layers_outside: rootsHidden.filter(el => !culpritEls.includes(el)).slice(0, 5).map(el => ({ selector: H.sel(el), why: closedLayer(el), right: Math.round(el.getBoundingClientRect().right) })),
    cut_left: cutLeft.filter(el => !inFixed(el) && !clipOf(el) && H.opaque(el) && (H.textOf(el) || '').trim()).slice(0, 8).map(el => ({ selector: H.sel(el), box: H.box(el), text: H.clean(H.textOf(el), 60) })),
    scroll_containers: scrollContainers, wide_tables: tables };

  // ---------- the page may scroll inside a container (html/body overflow hidden, app shell)
  let scroller = null;
  if (H.docH() <= VH + 2) {
    for (let i = 0; i < N; i++) {
      const el = all[i]; const c = H.cs(el);
      if ((c.overflowY === 'auto' || c.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50 && el.clientHeight >= VH * 0.6 && (!scroller || el.scrollHeight > scroller.scrollHeight)) scroller = el;
    }
  }
  const sTop = () => scroller ? scroller.scrollTop : scrollY;
  const sTo = y => scroller ? scroller.scrollTo({ top: y, behavior: 'instant' }) : window.scrollTo({ top: y, left: 0, behavior: 'instant' });
  const sMax = () => scroller ? Math.max(0, scroller.scrollHeight - scroller.clientHeight) : Math.max(0, H.docH() - VH);
  const fullH = () => scroller ? scroller.scrollHeight : H.docH();

  // ---------- text sizes (share of characters, as the screen shows them)
  // decorative text (aria-hidden: running lines, big background words) goes to its own counters
  const mk = () => ({ hist: {}, total: 0, byRegion: {}, small: new Map() });
  const main = mk(), decor = mk();
  const bodyHist = {}, bodyHistCss = {}, colors = {};
  let transformed = 0, steps = 0;
  const vis = new WeakMap();
  // transform scale of a text holder. Box width / layout width covers scale(), the scale property and zoom, but a
  // rotation also changes the box width (a label turned by 90° would read as 2–3 px): when the element or an
  // ancestor is rotated, the scale comes from the transform matrices instead (√(a² + b²) of each, times «scale»)
  const rotCache = new WeakMap(), matCache = new WeakMap();
  const rotated = el => {
    if (!el || el === body || el === de) return false;
    if (rotCache.has(el)) return rotCache.get(el);
    const c = H.cs(el);
    let v = !!c.rotate && c.rotate !== 'none';
    if (!v && c.transform && c.transform !== 'none') { try { const m = new DOMMatrixReadOnly(c.transform); v = Math.abs(m.b) > 1e-3 || Math.abs(m.c) > 1e-3; } catch {} }
    v = v || rotated(el.parentElement);
    rotCache.set(el, v);
    return v;
  };
  const matScale = el => {
    if (!el || el === de) return 1;
    if (matCache.has(el)) return matCache.get(el);
    const c = H.cs(el);
    let k = 1;
    if (c.transform && c.transform !== 'none') { try { const m = new DOMMatrixReadOnly(c.transform); k *= Math.hypot(m.a, m.b) || 1; } catch {} }
    if (c.scale && c.scale !== 'none') { const s = parseFloat(c.scale); if (s > 0) k *= s; }
    k *= matScale(el.parentElement);
    matCache.set(el, k);
    return k;
  };
  const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeValue.trim() ? 1 : 3 });
  let n;
  while ((n = tw.nextNode()) && steps++ < o.maxTextNodes) {
    const p = n.parentElement; if (!p) continue;
    let v = vis.get(p);
    // shown text only: not display:none, not visibility:hidden, not opacity:0 (on itself or up the chain), not clipped
    if (v === undefined) { v = !SKIPT.has(p.tagName) && H.rendered(p) && H.cs(p).visibility !== 'hidden' && H.opaque(p) && !H.clipped(p); vis.set(p, v); }
    if (!v) continue;
    const chars = n.nodeValue.replace(/\s+/g, '').length; if (!chars) continue;
    const css = parseFloat(H.cs(p).fontSize) || 0;
    let fs = css;
    if (p.offsetWidth > 0) {
      const k = rotated(p) ? matScale(p) : p.getBoundingClientRect().width / p.offsetWidth;
      if (k > 0 && Math.abs(k - 1) > 0.03) { fs *= k; transformed += chars; }
    }
    fs *= S;
    const b = Math.round(fs * 2) / 2;
    const bucket = H.deco(p) ? decor : main;
    bucket.hist[b] = (bucket.hist[b] || 0) + chars; bucket.total += chars;
    if (bucket === main) {
      if (p.closest('p, li, dd, blockquote')) { bodyHist[b] = (bodyHist[b] || 0) + chars; const bc = Math.round(css * 2) / 2; bodyHistCss[bc] = (bodyHistCss[bc] || 0) + chars; }
      const col = H.cs(p).color; colors[col] = (colors[col] || 0) + chars;
    }
    if (fs < 12) {
      const reg = H.regionOf(p); bucket.byRegion[reg] = (bucket.byRegion[reg] || 0) + chars;
      const e = bucket.small.get(p) || { chars: 0, size: Math.round(fs * 10) / 10 }; e.chars += chars; bucket.small.set(p, e);
    }
  }
  // aria-hidden over most of the page is a modal state (the page behind a dialog), not decor: count it as text
  const decorIgnored = decor.total > (main.total + decor.total) * 0.5;
  if (decorIgnored) {
    for (const [s, c] of Object.entries(decor.hist)) main.hist[s] = (main.hist[s] || 0) + c;
    main.total += decor.total;
    for (const [r, c] of Object.entries(decor.byRegion)) main.byRegion[r] = (main.byRegion[r] || 0) + c;
    for (const [p, e] of decor.small) main.small.set(p, e);
  }
  const sumLt = (h, lim) => Object.entries(h).filter(([s]) => +s < lim).reduce((a, [, c]) => a + c, 0);
  const share = lim => main.total ? Math.round(1000 * sumLt(main.hist, lim) / main.total) / 10 : 0;
  const mode = h => { let best = null, bc = -1; for (const [s, c] of Object.entries(h)) if (c > bc) { best = +s; bc = c; } return best; };
  const samplesOf = (m, extra) => [...m].sort((a, b) => b[1].chars - a[1].chars).slice(0, 15)
    .map(([p, e]) => ({ selector: H.sel(p), size: e.size, chars: e.chars, region: H.regionOf(p), text: H.clean(H.textOf(p) || '', 70), box: H.box(p), ...extra }));
  const text = { total_chars: main.total, truncated: steps >= o.maxTextNodes, pct_lt12: share(12), pct_lt14: share(14), pct_lt16: share(16),
    chars_lt12: sumLt(main.hist, 12),
    histogram: Object.fromEntries(Object.entries(main.hist).sort((a, b) => +a[0] - +b[0])), body_text_px: mode(bodyHist), lt12_by_region: main.byRegion,
    transformed_chars: transformed, small_samples: samplesOf(main.small, {}),
    scale_applied: S < 1 ? round2(S) : undefined, body_text_css_px: S < 1 ? mode(bodyHistCss) : undefined,
    decorative_chars: decorIgnored ? 0 : decor.total, decorative_lt12_chars: decorIgnored ? 0 : sumLt(decor.hist, 12), decorative_ignored: decorIgnored || undefined,
    decorative_samples: decorIgnored ? [] : samplesOf(decor.small, { decorative: true }).slice(0, 6) };

  // ---------- form fields < 16 px (iOS zooms on focus; the CSS size counts, not the zoomed-out view)
  const NOFIELD = ['hidden', 'checkbox', 'radio', 'submit', 'button', 'reset', 'range', 'color', 'file', 'image'];
  const fieldsAll = q('input, textarea, select').filter(f => !NOFIELD.includes((f.getAttribute('type') || '').toLowerCase()));
  const fieldsShown = fieldsAll.filter(f => H.shown(f, { opacity: false }));
  const small = fieldsShown.filter(f => parseFloat(H.cs(f).fontSize) < 16);
  const smallHidden = fieldsAll.filter(f => !H.shown(f, { opacity: false }) && parseFloat(H.cs(f).fontSize) < 16);
  const fields = { shown: fieldsShown.length, lt16: small.length, lt16_in_hidden: smallHidden.length,
    samples: small.slice(0, 10).map(f => ({ selector: H.sel(f), type: f.getAttribute('type') || f.tagName.toLowerCase(), size: parseFloat(H.cs(f).fontSize), placeholder: f.getAttribute('placeholder'), region: H.regionOf(f) })) };

  // ---------- fixed / sticky layers: their share of what the screen shows (the visual viewport)
  const stickyMeasure = () => {
    const layers = [];
    const v = H.vv();
    const vx = v.x, vy = v.y, vw = v.w, vh = v.h;
    const AL = body.getElementsByTagName('*'); const M = Math.min(AL.length, o.maxElements);
    for (let i = 0; i < M; i++) {
      const el = AL[i]; if (SKIPT.has(el.tagName)) continue;
      const c = H.cs(el);
      if (c.position !== 'fixed' && c.position !== 'sticky') continue;
      let parentLayer = false;
      for (let a = el.parentElement; a && a !== body; a = a.parentElement) { const p = H.cs(a).position; if (p === 'fixed' || p === 'sticky') { parentLayer = true; break; } }
      if (parentLayer) continue;
      if (!H.rendered(el) || !H.opaque(el)) continue;
      const r = el.getBoundingClientRect();
      const top = Math.max(vy, r.top), bot = Math.min(vy + vh, r.bottom), left = Math.max(vx, r.left), right = Math.min(vx + vw, r.right);
      if (bot - top < 2 || right - left < 2) continue;
      if (c.position === 'sticky' && r.top > vy + 2 && r.bottom < vy + vh - 2 && (bot - top) < vh * 0.9 && (right - left) > vw * 0.5 && r.top > vy + vh * 0.3) continue; // sticky still in flow
      const h = bot - top, w = right - left;
      const name = (H.cls(el) + ' ' + (el.id || '')).toLowerCase(), txt = H.clean(H.textOf(el) || '', 120);
      const atTop = r.top <= vy + 2, atBottom = r.bottom >= vy + vh - 2;
      let kind = 'layer';
      if (/cookie|куки|персональных данных|согласие на обработку/i.test(txt)) kind = 'cookie';
      else if (/(chat|jivo|whatsapp|telegram|callback|widget|consult|bitrix|звон)/i.test(name) || (w < vw * 0.3 && /чат|звон|напиш|позвон|whatsapp|telegram|chat|call/i.test(txt + ' ' + (el.getAttribute('aria-label') || '')))) kind = 'widget';
      else if (/наверх|to top|scroll.?top|вверх/i.test(txt + ' ' + name + ' ' + (el.getAttribute('aria-label') || ''))) kind = 'to-top';
      else if (atTop && el.querySelectorAll('a, button').length >= 2) kind = 'header';
      else if (atBottom && w >= vw * 0.8) kind = 'bottom-bar';
      layers.push({ selector: H.sel(el), position: c.position, kind, anchor: atTop ? 'top' : (atBottom ? 'bottom' : 'middle'),
        box_vp: [Math.round(left - vx), Math.round(top - vy), Math.round(w), Math.round(h)], height_share: Math.round(1000 * h / vh) / 10, width_share: Math.round(1000 * w / vw) / 10,
        area_share: Math.round(1000 * (w * h) / (vw * vh)) / 10, z: c.zIndex, text: txt.slice(0, 60) });
    }
    const wide = layers.filter(l => l.width_share >= 50).map(l => [l.box_vp[1], l.box_vp[1] + l.box_vp[3]]).sort((a, b) => a[0] - b[0]);
    let cover = 0, cur = null;
    for (const [a, b] of wide) { if (!cur || a > cur[1]) { if (cur) cover += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b); }
    if (cur) cover += cur[1] - cur[0];
    return { scroll_y: Math.round(sTop()), layers: layers.slice(0, 20), count: layers.length, cover_share: Math.round(1000 * cover / vh) / 10,
      floating: layers.filter(l => l.width_share < 50).length };
  };
  const stickyTop = stickyMeasure();

  // ---------- first screen: action buttons, contacts, H1
  const VERB = /(запис|заказ|купи|покуп|оформ|заявк|получ|позвон|звоните|связат|напиш|рассчит|расч[её]т|подобр|начать|начните|попроб|скача|регистр|подпис|заброн|брон|узнать (цен|стоим)|консультац|в корзину|оплат|выбрат|запиш|book|buy|order|get started|start|sign ?up|register|subscribe|contact|call|try|download|request|quote|join|enrol|apply|reserve|shop|add to cart)/i;
  const mainStems = String(o.mainAction || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4).map(w => w.slice(0, 5));
  const btnLike = el => {
    if (el.tagName === 'BUTTON' || el.tagName === 'INPUT' || el.getAttribute('role') === 'button') return true;
    if (/(^|[\s_-])(btn|button|cta)([\s_-]|$)/i.test(H.cls(el))) return true;
    const c = H.cs(el); const r = el.getBoundingClientRect();
    const bg = c.backgroundColor && !transparent(c.backgroundColor);
    const border = parseFloat(c.borderTopWidth) >= 1 && c.borderTopStyle !== 'none' && parseFloat(c.borderBottomWidth) >= 1;
    const inner = el.firstElementChild && el.children.length === 1 ? H.cs(el.firstElementChild) : null;
    const innerBg = inner && inner.backgroundColor && !transparent(inner.backgroundColor);
    return (bg || border || innerBg) && r.height >= 28 && r.width >= 60;
  };
  const linesOf = el => {
    try { const rg = document.createRange(); rg.selectNodeContents(el); const tops = new Set([...rg.getClientRects()].filter(x => x.width > 1).map(x => Math.round(x.top))); return Math.max(1, tops.size); } catch { return null; }
  };
  const hitAt = (el, x, y) => {
    const h = document.elementFromPoint(x, y);
    if (!h) return 'none';
    if (h === el || el.contains(h)) return 'ok';
    if (h.contains(el)) return H.cs(el).pointerEvents === 'none' ? 'no-pointer' : 'ancestor';
    return 'covered';
  };
  const ctas = [];
  let actionsTotal = 0;
  for (const el of q('a[href], button, input[type="submit" i], input[type="button" i], [role="button"]')) {
    if (!H.shown(el, { opacity: false })) continue;
    const href = (el.getAttribute('href') || '').trim().toLowerCase();
    const text = H.clean(H.textOf(el) || el.value || el.getAttribute('aria-label') || '', 80);
    let kind = null;
    if (href.startsWith('tel:')) kind = 'call';
    else if (/^(https?:\/\/)?(t\.me|wa\.me|api\.whatsapp\.com|vk\.me)\//i.test(href) || href.startsWith('viber:')) kind = 'messenger';
    else if (text && text.length <= 60 && btnLike(el)) kind = VERB.test(text) || mainStems.some(s => text.toLowerCase().includes(s)) ? 'action' : 'button';
    if (!kind) continue;
    if (kind === 'action') actionsTotal++;
    if (ctas.length >= 60) continue; // the list is capped, the count of actions is not
    const r = el.getBoundingClientRect();
    if (kind === 'button' && r.top + scrollY > VVH * 2) continue; // other button-like links: only the first two screens
    const inView = r.top >= 0 && r.bottom <= VH && r.left >= 0 && r.right <= W;
    ctas.push({ kind, text, href: href ? el.getAttribute('href').slice(0, 200) : null, selector: H.sel(el), region: H.regionOf(el), box: H.box(el),
      lines: linesOf(el), main_action_match: mainStems.length ? mainStems.some(s => text.toLowerCase().includes(s)) : null,
      hit: inView ? hitAt(el, r.left + r.width / 2, r.top + r.height / 2) : null });
  }
  const h1 = q('h1').find(h => H.shown(h, { opacity: false })) || null;
  let h1info = null;
  if (h1) {
    const c = H.cs(h1), r = h1.getBoundingClientRect(); const fs = parseFloat(c.fontSize); const lh = c.lineHeight === 'normal' ? fs * 1.2 : parseFloat(c.lineHeight);
    h1info = { text: H.clean(H.textOf(h1), 120), box: H.box(h1), font_px: fs, font_px_on_screen: S < 1 ? round2(fs * S) : undefined, lines: lh ? Math.max(1, Math.round(r.height / lh)) : null, lines_by_rects: linesOf(h1) };
  }
  // First screen is judged on what the screen shows: heights of real windows in screen px (keys of by_height);
  // at scale < 1 (no meta viewport) the same screen holds height / scale CSS px of the page.
  // An overflow that grows the layout viewport at scale 1 also gets the zoomed-out view (by_height_zoomed_out).
  const baseH = (o.foldHeights || []).length ? [...o.foldHeights] : [];
  const screenH = Math.round(VVH * S);
  if (!baseH.some(h => Math.abs(h - screenH) <= 3)) baseH.push(screenH);
  const heights = [...new Set(baseH)].sort((a, b) => a - b);
  const fold = { viewport_h: VHu, visible_css: [Math.round(VVW), Math.round(VVH)], scale: S < 1 ? round2(S) : 1, zoomed_out: zoomOut > 1 ? round2(zoomOut) : null, heights, h1: h1info,
    ctas: [...ctas.filter(c => c.kind !== 'button').slice(0, 20), ...ctas.filter(c => c.kind === 'button').slice(0, 10)],
    has_action: actionsTotal > 0, actions_total: actionsTotal,
    action_in_header: ctas.some(c => c.kind === 'action' && c.region === 'header'),
    first_action: (() => { const c = ctas.find(x => x.kind === 'action' && x.region !== 'header') || ctas.find(x => x.kind === 'action'); return c ? { text: c.text, y: c.box[1], bottom: c.box[1] + c.box[3], region: c.region, selector: c.selector, lines: c.lines } : null; })(),
    by_height: {} };
  const judge = (hgt, wLim) => {
    const fits = c => c.box[1] >= 0 && c.box[1] + c.box[3] <= hgt && c.box[0] >= -1 && c.box[0] + c.box[2] <= wLim + 1 && c.hit !== 'covered';
    return { action_visible: ctas.some(c => c.kind === 'action' && fits(c)), action_outside_header: ctas.some(c => c.kind === 'action' && c.region !== 'header' && fits(c)),
      contact_visible: ctas.some(c => (c.kind === 'call' || c.kind === 'messenger') && fits(c)), h1_visible: h1info ? h1info.box[1] + h1info.box[3] <= hgt : false,
      buttons_visible: ctas.filter(c => c.kind === 'button' && fits(c)).map(c => c.text).slice(0, 8) };
  };
  for (const hgt of heights) fold.by_height[hgt] = judge(Math.round(hgt / S), S < 1 ? VVW : W);
  if (zoomOut > 1 && S === 1) {
    fold.by_height_zoomed_out = {};
    for (const hgt of heights) fold.by_height_zoomed_out[Math.round(hgt * zoomOut)] = judge(Math.round(hgt * zoomOut), innerWidth);
  }

  // ---------- touch targets + hit-test (scrolls)
  const TSEL = 'a[href], button, input:not([type="hidden" i]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="radio"], [role="switch"], [role="menuitem"], [role="option"], [onclick], [tabindex]:not([tabindex="-1"])';
  let targets = q(TSEL).map(t => {
    if (t.tagName === 'INPUT' && /^(checkbox|radio)$/i.test(t.type || '')) {
      const r = t.getBoundingClientRect();
      if ((r.width < 2 || r.height < 2 || !H.opaque(t)) && t.labels && t.labels[0]) return t.labels[0];
    }
    return t;
  });
  targets = [...new Set(targets)];
  const tset = new Set(targets);
  targets = targets.filter(t => { for (let a = t.parentElement; a; a = a.parentElement) if (tset.has(a)) return false; return true; });
  targets = targets.filter(t => H.rendered(t) && H.cs(t).visibility !== 'hidden' && !H.clipped(t)).filter(t => { const r = t.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; });
  const capped = targets.length > o.maxTargets;
  targets = targets.slice(0, o.maxTargets);
  // a link broken over two lines: its bounding box center may sit on another element — use the biggest line box
  const mainRect = el => { const rs = el.getClientRects(); if (rs.length < 2) return el.getBoundingClientRect(); let b = rs[0]; for (const x of rs) if (x.width * x.height > b.width * b.height) b = x; return b; };
  const T = targets.map(t => {
    const r = mainRect(t);
    return { el: t, x: r.left + scrollX, y: r.top + scrollY, w: r.width, h: r.height, cx: r.left + scrollX + r.width / 2, cy: r.top + scrollY + r.height / 2, inline: H.inlineInText(t), fixed: inFixed(t) };
  });
  // sizes and distances are judged as the screen shows them (CSS px × scale)
  const rectDist = (x, y, b) => { const dx = Math.max(b.x - x, 0, x - (b.x + b.w)); const dy = Math.max(b.y - y, 0, y - (b.y + b.h)); return Math.hypot(dx, dy) * S; };
  const edgeDist = (a, b) => { const dx = Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w)); const dy = Math.max(0, b.y - (a.y + a.h), a.y - (b.y + b.h)); return Math.hypot(dx, dy) * S; };
  const byY = T.map((t, i) => i).sort((a, b) => T[a].y - T[b].y);
  for (const t of T) { t.under24 = !t.inline && (t.w * S < 24 || t.h * S < 24); t.under44 = !t.inline && (t.w * S < 44 || t.h * S < 44); t.spacing_ok = true; t.gap = null; }
  for (let ii = 0; ii < byY.length; ii++) {
    const a = T[byY[ii]];
    for (let jj = ii + 1; jj < byY.length; jj++) {
      const b = T[byY[jj]];
      if ((b.y - (a.y + a.h)) * S > 60) break;
      if (a.fixed !== b.fixed) continue;
      const g = edgeDist(a, b);
      if (a.gap === null || g < a.gap) a.gap = g;
      if (b.gap === null || g < b.gap) b.gap = g;
      if (a.under24 && (rectDist(a.cx, a.cy, b) < 12 || (b.under24 && Math.hypot(a.cx - b.cx, a.cy - b.cy) * S < 24))) a.spacing_ok = false;
      if (b.under24 && (rectDist(b.cx, b.cy, a) < 12 || (a.under24 && Math.hypot(a.cx - b.cx, a.cy - b.cy) * S < 24))) b.spacing_ok = false;
    }
  }
  // hit-test: scroll so that targets are in the middle band of the screen
  const remaining = new Set(T.map((t, i) => i));
  const hit = new Array(T.length).fill(null);
  const classify = (t, h) => {
    if (!h) return { s: 'none' };
    if (h === t || t.contains(h)) return { s: 'ok' };
    const lab = h.closest ? h.closest('label') : null;
    if (lab && (lab === t || (lab.control && (lab.control === t || t.contains(lab.control))))) return { s: 'ok' };
    if (h.contains(t)) return { s: H.cs(t).pointerEvents === 'none' ? 'no-pointer' : 'ancestor', by: H.sel(h) };
    const hc = H.cs(h);
    return { s: 'covered', by: H.sel(h), by_tag: h.tagName.toLowerCase(), by_fixed: inFixed(h), by_text: H.clean(H.textOf(h) || '', 40),
      by_transparent: transparent(hc.backgroundColor) && !(H.textOf(h) || '').trim() && hc.backgroundImage === 'none' };
  };
  // first-visit overlays found by snapshot (cookie banner, «your city?», auto-opened popup): their own targets are
  // tested as they are now, then the overlays are hidden for the scroll (as in the chunk shots) and restored at the end
  const overlayEls = [];
  for (const s of o.overlays || []) { try { for (const el of document.querySelectorAll(s.selector)) if (H.rendered(el) && !overlayEls.includes(el)) overlayEls.push(el); } catch {} }
  T.forEach((t, i) => {
    if (!overlayEls.some(ov => ov.contains(t.el))) return;
    t.overlay = true;
    const r = mainRect(t.el), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    if (cy >= 0 && cy < VH && cx >= 0 && cx < innerWidth) hit[i] = classify(t.el, document.elementFromPoint(cx, cy));
    remaining.delete(i);
  });
  const overlaySaved = overlayEls.map(el => [el, el.getAttribute('style')]);
  for (const el of overlayEls) el.style.setProperty('display', 'none', 'important');
  const overlaysHidden = (o.overlays || []).filter(s => overlayEls.some(el => { try { return el.matches(s.selector); } catch { return false; } })).map(s => ({ kind: s.kind, selector: s.selector }));

  const t0 = performance.now();
  const step = Math.max(200, Math.round(VH * 0.5));
  let y = 0, stickyAfter = null, scrollBlocked = false, last = false, maxSw = sw, maxSwAt = 0;
  for (let guard = 0; guard < 400; guard++) {
    sTo(y);
    await tick(o.stepMs);
    if (y > 0 && sTop() === 0) { scrollBlocked = true; break; }
    const sy = sTop();
    // overflow that appears only while scrolling (reveal animations sliding in from the side)
    const swNow = Math.max(de.scrollWidth, body.scrollWidth);
    if (swNow > maxSw) { maxSw = swNow; maxSwAt = Math.round(sy); }
    const lo = sy === 0 ? 0 : VH * 0.2, hi = last ? VH : VH * 0.8;
    for (const i of [...remaining]) {
      const t = T[i];
      const r = mainRect(t.el);
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cy < lo || cy > hi || cx < 0 || cx >= innerWidth) continue;
      hit[i] = classify(t.el, document.elementFromPoint(cx, cy));
      remaining.delete(i);
    }
    const maxY = sMax();
    if (!stickyAfter && sy > 0 && (sy >= VH * 1.5 || sy >= maxY - 2)) stickyAfter = stickyMeasure();
    if ((!remaining.size && (stickyAfter || maxY === 0)) || last || performance.now() - t0 > o.budgetMs) break;
    y = Math.min(y + step, maxY);
    if (y >= maxY) last = true;
  }
  const timedOut = performance.now() - t0 > o.budgetMs;
  for (const [el, st] of overlaySaved) { if (st === null) el.removeAttribute('style'); else el.setAttribute('style', st); }
  sTo(0);
  await tick(100);
  overflow.scroll_max_width = maxSw;
  overflow.appears_on_scroll_px = Math.max(0, maxSw - sw);
  overflow.appears_on_scroll_at = maxSw > sw ? maxSwAt : null;

  const counts = { ok: 0, covered: 0, ancestor: 0, 'no-pointer': 0, none: 0, not_tested: 0 };
  hit.forEach(h => { counts[h ? h.s : 'not_tested']++; });
  const desc = (t, i) => ({ selector: H.sel(t.el), tag: t.el.tagName.toLowerCase(), role: t.el.getAttribute('role'), text: H.clean(H.textOf(t.el) || t.el.value || t.el.getAttribute('aria-label') || t.el.getAttribute('title') || '', 50),
    box: [Math.round(t.x), Math.round(t.y), Math.round(t.w), Math.round(t.h)], size_on_screen: S < 1 ? [Math.round(t.w * S), Math.round(t.h * S)] : undefined,
    region: H.regionOf(t.el), fixed: t.fixed, overlay: t.overlay || undefined, inline: t.inline || undefined, spacing_ok: t.spacing_ok, gap: t.gap === null ? null : Math.round(t.gap), hit: hit[i] ? hit[i].s : 'not_tested' });
  const under24 = T.map((t, i) => [t, i]).filter(([t]) => t.under24);
  const smallList = under24.filter(([t]) => !t.spacing_ok).sort((a, b) => Math.min(a[0].w, a[0].h) - Math.min(b[0].w, b[0].h)).slice(0, 25).map(([t, i]) => desc(t, i));
  const covered = T.map((t, i) => [t, i]).filter(([, i]) => hit[i] && hit[i].s !== 'ok' && hit[i].s !== 'none').slice(0, 25).map(([t, i]) => ({ ...desc(t, i), ...hit[i] }));
  const under44 = T.map((t, i) => [t, i]).filter(([t]) => t.under44);
  const targetsOut = { total: T.length, capped, inline_excluded: T.filter(t => t.inline).length, in_overlays: T.filter(t => t.overlay).length, overlays_hidden_for_scroll: overlaysHidden,
    lt24: under24.filter(([t]) => !t.spacing_ok).length, lt24_spacing_ok: under24.filter(([t]) => t.spacing_ok).length, lt44: under44.length,
    crowded_lt8: T.filter(t => !t.inline && t.gap !== null && t.gap < 8).length,
    scale_applied: S < 1 ? round2(S) : undefined,
    hit: counts, hit_timed_out: timedOut, scroll_blocked: scrollBlocked,
    small: smallList, lt44_sample: under44.filter(([t]) => !t.under24 || t.spacing_ok).slice(0, 10).map(([t, i]) => desc(t, i)), covered,
    inline_sample: T.filter(t => t.inline).slice(0, 5).map(t => ({ selector: H.sel(t.el), text: H.clean(H.textOf(t.el) || '', 50), inline: true })) };

  // ---------- cheap design tokens: radii and heights by element type, eyebrows before H2, colours by frequency
  const tokens = (() => {
    const inc = (m, k, v = 1) => { m[k] = (m[k] || 0) + v; };
    const top = (m, k = 8) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, k).map(([v, n]) => ({ v, n }));
    const rad = c => (c.borderTopLeftRadius === c.borderBottomRightRadius ? c.borderTopLeftRadius : c.borderTopLeftRadius + ' / ' + c.borderBottomRightRadius);
    const rB = {}, hB = {}, rF = {}, hF = {}, rC = {}, bgs = {};
    for (const el of q('button, [role="button"], input[type="submit" i], input[type="button" i], a[href]').slice(0, 2000)) {
      if (el.tagName === 'A' && !btnLike(el)) continue;
      if (!H.shown(el, { opacity: false })) continue;
      const r = el.getBoundingClientRect(); if (r.height < 16 || r.width < 30) continue;
      inc(rB, rad(H.cs(el))); inc(hB, Math.round(r.height));
    }
    for (const f of fieldsShown) { const r = f.getBoundingClientRect(); inc(rF, rad(H.cs(f))); inc(hF, Math.round(r.height)); }
    const M = Math.min(all.length, 8000);
    for (let i = 0; i < M; i++) {
      const el = all[i]; if (SKIPT.has(el.tagName)) continue;
      const c = H.cs(el);
      const hasBg = !transparent(c.backgroundColor);
      if (hasBg || c.boxShadow !== 'none' || parseFloat(c.borderTopWidth) >= 1) {
        const r = el.getBoundingClientRect();
        if (hasBg && r.width >= 2 && r.height >= 2) inc(bgs, c.backgroundColor, Math.round(Math.min(r.width, W) * Math.min(r.height, 4000) / 100));
        // a card: a framed box of medium width holding a picture or a heading
        if (r.width >= 140 && r.width <= Math.min(640, W * 0.7) && r.height >= 100 && el.querySelector('img, picture, h2, h3, h4, [role="heading"]') && H.shown(el, { opacity: false })) inc(rC, rad(c));
      }
    }
    // eyebrow: a short caption right before an H2, small and in caps or tracked out
    const h2s = q('h2').filter(h => H.shown(h, { opacity: false })).slice(0, 80);
    const eyebrows = [];
    for (const h of h2s) {
      let p = h.previousElementSibling;
      if (!p && h.parentElement && h.parentElement.firstElementChild === h) p = h.parentElement.previousElementSibling;
      if (!p || !H.shown(p, { opacity: false })) continue;
      const t = (H.textOf(p) || '').trim();
      if (!t || t.length > 40 || /\n/.test(t)) continue;
      const c = H.cs(p), fs = parseFloat(c.fontSize) || 16, ls = parseFloat(c.letterSpacing) || 0;
      const caps = c.textTransform === 'uppercase' || (t === t.toUpperCase() && /\p{Lu}/u.test(t));
      if (fs <= 14 && (caps || ls >= 0.08 * fs)) eyebrows.push({ text: H.clean(t, 40), size: fs, caps, letter_spacing_em: round2(ls / fs), selector: H.sel(p) });
    }
    return { radius_buttons: top(rB), radius_fields: top(rF), radius_cards: top(rC), button_heights: top(hB), field_heights: top(hF),
      eyebrows: { count: eyebrows.length, h2: h2s.length, norm_max: Math.ceil(h2s.length / 3), samples: eyebrows.slice(0, 4) },
      text_colors_by_chars: top(colors, 10), bg_colors_by_area: top(bgs, 10) };
  })();

  return { viewport: [W, VH], viewport_scale1: [W, VHu], zoomed_out: zoomOut > 1 ? round2(zoomOut) : null,
    visual_viewport: { width: Math.round(VVW), height: Math.round(VVH), scale: round2(S) },
    no_viewport_zoom: S < 1 ? round2(S) : null, viewport_meta: vpMeta ? (vpMeta.getAttribute('content') || '').slice(0, 200) : null,
    dpr: devicePixelRatio || 1, doc_height: fullH(), screens: Math.round(10 * fullH() / VVH) / 10,
    inner_scroller: scroller ? { selector: H.sel(scroller), scroll_height: scroller.scrollHeight, client_height: scroller.clientHeight } : null,
    overflow, text, fields, sticky: { at_top: stickyTop, after_scroll: stickyAfter }, fold, targets: targetsOut, tokens, errors };
}

export async function collect(page, ctx = {}) {
  await ensureHelpers(page);
  const width = ctx.width || null;
  let hover = null;
  try {
    const css = await getCssAnalysis(page, ctx);
    // reveal_selectors: what a :hover rule shows (selectors with «:hover» cut out, first 50); text.md marks such
    // blocks «[свёрнуто] показывается при наведении мыши»
    hover = { ...css.hover, reveal_selectors: (css.hover_reveal_selectors || []).slice(0, 50), sheets: css.sheets, unreadable: css.unreadable };
  } catch (e) { hover = { error: String(e.message).slice(0, 200) }; }
  const foldHeights = FOLD_HEIGHTS[width] || [];
  const brief = ctx.brief || {};
  const overlays = (ctx.layers || []).filter(l => l && l.kind && l.selector).map(l => ({ kind: l.kind, selector: l.selector }));
  const data = await ev(page, layoutInPage, {
    width, foldHeights, overlays, mainAction: brief.site && brief.site.main_action ? brief.site.main_action : '',
    maxElements: 40000, maxTextNodes: 80000, maxTargets: 600, stepMs: 70,
    // hit-test budget: 15 s, less when the snapshot passes its own deadline (epoch ms)
    budgetMs: ctx.deadline ? Math.max(2000, Math.min(15000, ctx.deadline - Date.now() - 5000)) : 15000,
  });
  const li = loadInfo(page, ctx);
  return { final_url: li.final_url, captured: nowIso(), mobile: !!ctx.mobile, ...data, hover };
}

// ---------------------------------------------------------------------------------------------
export async function finalize(all, ctx = {}) {
  if (!ctx.run) throw new Error('layout.finalize: ctx.run is required');
  const lang = ctx.lang === 'en' ? 'en' : 'ru';
  const items = [], errors = [];
  const groups = groupByPid(all, ctx.pages);
  logDropped(ctx, 'layout', groups);
  for (const [pid, its] of groups) {
    for (const x of its) {
      if (!x.data || x.data.error) { errors.push({ pid, width: x.width, error: x.data ? x.data.error : 'no data' }); continue; }
      items.push({ pid, url: x.url || pageEntry(ctx.pages, pid)?.url || x.data.final_url, width: x.width, ...x.data });
    }
  }
  const summaryFn = list => {
    const ok = list.filter(i => i.overflow);
    const narrow = ok.filter(i => i.width <= 430);
    const max = (arr, f) => arr.reduce((a, i) => (a === null || f(i) > f(a) ? i : a), null);
    const worstSmall = max(narrow, i => i.text ? i.text.pct_lt12 : -1);
    const worstSticky = max(ok, i => Math.max(i.sticky?.at_top?.cover_share || 0, i.sticky?.after_scroll?.cover_share || 0));
    const longest = max(narrow, i => i.screens || 0);
    const noFold = ok.flatMap(i => Object.entries(i.fold?.by_height || {}).filter(([, v]) => !v.action_visible).map(([h]) => ({ pid: i.pid, width: i.width, height: +h, has_action: i.fold?.has_action !== false })));
    return {
      widths: [...new Set(ok.map(i => i.width))].sort((a, b) => a - b),
      overflow: ok.filter(i => i.overflow.overflow_px > 0 || (i.overflow.page_clips_x && i.overflow.culprits.length))
        .map(i => ({ pid: i.pid, width: i.width, px: i.overflow.overflow_px, clipped_by_page: i.overflow.page_clips_x, culprit: i.overflow.culprits[0] ? i.overflow.culprits[0].selector : null, culprit_over_px: i.overflow.culprits[0] ? i.overflow.culprits[0].over_px : null })),
      no_viewport_zoom: ok.filter(i => i.no_viewport_zoom).map(i => ({ pid: i.pid, width: i.width, scale: i.no_viewport_zoom, viewport_meta: i.viewport_meta })),
      small_text_narrow: narrow.map(i => ({ pid: i.pid, width: i.width, pct_lt12: i.text.pct_lt12, pct_lt14: i.text.pct_lt14, pct_lt16: i.text.pct_lt16, body_text_px: i.text.body_text_px, decorative_chars: i.text.decorative_chars || 0 })),
      worst_small_text: worstSmall ? { pid: worstSmall.pid, width: worstSmall.width, pct_lt12: worstSmall.text.pct_lt12 } : null,
      fields_lt16_narrow: narrow.reduce((a, i) => a + (i.fields?.lt16 || 0), 0),
      targets_lt24: ok.reduce((a, i) => a + (i.targets?.lt24 || 0), 0),
      targets_lt24_narrow: narrow.reduce((a, i) => a + (i.targets?.lt24 || 0), 0),
      targets_lt44_narrow: narrow.reduce((a, i) => a + (i.targets?.lt44 || 0), 0),
      hit_covered: ok.reduce((a, i) => a + (i.targets?.hit?.covered || 0) + (i.targets?.hit?.['no-pointer'] || 0) + (i.targets?.hit?.ancestor || 0), 0),
      hit_not_tested: ok.reduce((a, i) => a + (i.targets?.hit?.not_tested || 0), 0),
      // all pairs without a visible action button, then split: no action button on the page at all / it is below the fold
      action_not_in_fold: noFold.map(({ pid, width, height }) => ({ pid, width, height })),
      no_action: ok.filter(i => i.fold && i.fold.has_action === false).map(i => ({ pid: i.pid, width: i.width })),
      action_below_fold: noFold.filter(x => x.has_action).map(({ pid, width, height }) => ({ pid, width, height })),
      sticky_max: worstSticky ? { pid: worstSticky.pid, width: worstSticky.width, at_top: worstSticky.sticky?.at_top?.cover_share ?? null, after_scroll: worstSticky.sticky?.after_scroll?.cover_share ?? null } : null,
      hover_unguarded_active: Math.max(0, ...ok.filter(i => i.width <= 430).map(i => (i.hover?.reveal_active || 0) + (i.hover?.transform_active || 0))),
      longest_narrow: longest ? { pid: longest.pid, width: longest.width, screens: longest.screens } : null,
    };
  };
  const out = writeMeasureMerged(ctx, 'layout', { items, errors, summaryFn });
  const s = out.summary;
  const en = lang === 'en';
  const lines = [];
  // a page that clips overflow-x itself has no horizontal scroll: say «cut», even when scrollWidth is wider
  const ov = s.overflow.slice(0, 2).map(o => !o.clipped_by_page && o.px > 0 ? `${o.pid}@${o.width} +${o.px}px` : `${o.pid}@${o.width} ${en ? 'cut by the page' : 'обрезано страницей'} (+${o.px > 0 ? o.px : (o.culprit_over_px ?? '?')}px)`).join(', ') + (s.overflow.length > 2 ? ` +${s.overflow.length - 2}` : '');
  const pairs = (a, n = 5) => a.slice(0, n).map(x => `${x.pid}@${x.width}${x.height ? '×' + x.height : ''}`).join(', ') + (a.length > n ? ` +${a.length - n}` : '');
  const ws = s.worst_small_text && s.worst_small_text.pct_lt12 > 0 ? s.worst_small_text : null;
  const noActPages = [...new Set(s.no_action.map(x => x.pid))];
  const belowPairs = [...new Set(s.action_below_fold.map(x => `${x.pid}@${x.width}`))];
  // a meta viewport with a fixed width («width=1200») zooms the page out just like a missing one
  const vpFixed = s.no_viewport_zoom.filter(x => x.viewport_meta), vpNone = s.no_viewport_zoom.filter(x => !x.viewport_meta);
  const zoomList = a => a.slice(0, 4).map(x => `${x.pid}@${x.width} ×${x.scale}${x.viewport_meta ? ` (${String(x.viewport_meta).slice(0, 40)})` : ''}`).join(', ');
  // every problem in short on the first line (the snapshot summary surely shows the first line of each collector,
  // the second only when there is room); the lists follow on the next lines
  // (snapshot cuts a line at 220 characters: keep it short)
  const head = [en ? `layout: overflow ${s.overflow.length ? ov : 'none'}; targets < 24 px ${s.targets_lt24}; hit-test ${s.hit_covered}`
    : `раскладка: переполнение ${s.overflow.length ? ov : 'нет'}; цели < 24 px — ${s.targets_lt24}; hit-test — ${s.hit_covered}`];
  if (ws) head.push(en ? `text < 12 px up to ${ws.pct_lt12}% (${ws.pid}@${ws.width})` : `текст < 12 px до ${ws.pct_lt12} % (${ws.pid}@${ws.width})`);
  if (noActPages.length) head.push(en ? `no action button: ${noActPages.length} p.` : `без кнопки действия: ${noActPages.length} стр.`);
  if (belowPairs.length) head.push(en ? `button below the fold: ${belowPairs.length}` : `кнопка ниже экрана: ${belowPairs.length}`);
  if (s.no_viewport_zoom.length) head.push(en ? `zoomed out on phone: ${s.no_viewport_zoom.length}` : `уменьшена на телефоне: ${s.no_viewport_zoom.length}`);
  lines.push(head.join('; '));
  if (en) {
    if (noActPages.length || belowPairs.length) lines.push([noActPages.length ? `no action button on the page: ${pairs(s.no_action)}` : null, belowPairs.length ? `action button below the first screen: ${pairs(s.action_below_fold, 4)}` : null].filter(Boolean).join(' · '));
    if (vpNone.length) lines.push(`no meta viewport — the phone shows the page zoomed out: ${zoomList(vpNone)}`);
    if (vpFixed.length) lines.push(`meta viewport with a fixed width — the phone shows the page zoomed out: ${zoomList(vpFixed)}`);
    if (ws) lines.push(`small text: up to ${ws.pct_lt12}% of characters < 12 px (${ws.pid}@${ws.width})`);
  } else {
    if (noActPages.length || belowPairs.length) lines.push([noActPages.length ? `нет кнопки действия на странице: ${pairs(s.no_action)}` : null, belowPairs.length ? `кнопка действия ниже первого экрана: ${pairs(s.action_below_fold, 4)}` : null].filter(Boolean).join(' · '));
    if (vpNone.length) lines.push(`нет meta viewport — телефон показывает страницу уменьшенной: ${zoomList(vpNone)}`);
    if (vpFixed.length) lines.push(`meta viewport с фиксированной шириной — телефон показывает страницу уменьшенной: ${zoomList(vpFixed)}`);
    if (ws) lines.push(`мелкий текст: до ${ws.pct_lt12} % знаков < 12 px (${ws.pid}@${ws.width})`);
  }
  if (ctx.log) try { ctx.log('layout: measure/layout.json'); } catch {}
  return { files: ['measure/layout.json'], lines, summary: { overflow: s.overflow.length, targets_lt24: s.targets_lt24, hit_covered: s.hit_covered, no_action: s.no_action.length, action_below_fold: s.action_below_fold.length } };
}
