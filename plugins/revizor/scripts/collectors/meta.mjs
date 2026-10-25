// Revizor collector «meta» — the base of snapshot/<pid>/page.json.
// Collector interface: export meta { name, widths, order }, collect(page, ctx) → data of one page × width,
// finalize(all, ctx) → { files, lines, summary }; snapshot.mjs calls them on its own loads.
// Runs on the snapshot's own load (after the slow scroll and the return to the top): no extra page loads.
// Besides collect/finalize it exports helpers shared by the other collectors:
//   ensureHelpers(page)  — installs window.__revizorH (regions header/main/footer, visibility, selectors)
//   ev(page, fn, ...args) — runs fn in the isolated world (the site's scripts can't see or spoof the helpers)
//   loadInfo, writeMeasureMerged, updatePageJson, getCssAnalysis, primaryOf
// Nothing here touches the site: only reads of the DOM, CDP reads and files inside RUN.

import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { readJSON, writeJSON, insideRun, withFileLock, nowIso, VERSION, hostOf, stripWww } from '../lib/util.mjs';

export const meta = { name: 'meta', widths: [390, 1440], order: 10 };

export const HELPERS_VERSION = 4;

// Evaluate in the isolated world of lib/cdp (same DOM, own JS globals): page scripts can't replace
// getComputedStyle, plant a fake window.__revizorH or read ours. Falls back to the main world only when the
// isolated context can't be created (old lib/cdp, odd page); the world sticks to the page object.
// Timeouts and errors of our own code are thrown as they are: the function may still be running in the page,
// a second run in the main world would scroll twice and lose the protection of the isolated world.
const WORLD_FAIL = /^(Page\.createIsolatedWorld|Page\.getFrameTree):|Cannot find (default )?(execution )?context/i;
export async function ev(page, fn, ...args) {
  if (page.__rvWorld !== 'main' && typeof page.evaluateIsolated === 'function') {
    try { const r = await page.evaluateIsolated(fn, ...args); page.__rvWorld = 'iso'; return r; }
    catch (e) {
      const msg = String(e && e.message);
      if (!WORLD_FAIL.test(msg) || /^Runtime\.evaluate: timeout/.test(msg)) throw e;
      page.__rvWorld = 'main';
      if (fn !== revizorHelpers) await page.evaluate(revizorHelpers, HELPERS_VERSION);
    }
  }
  return page.evaluate(fn, ...args);
}
export const worldOf = page => (page.__rvWorld === 'iso' ? 'isolated' : 'main');

// ---------------------------------------------------------------------------------------------
// In-page helpers (serialized with toString, so no closures over Node variables).
function revizorHelpers(V) {
  if (window.__revizorH && window.__revizorH.v === V) { window.__revizorH.reset(); return V; }
  const H = { v: V };
  let styleCache, clipCache, kindCache, ownCache, fixedCache, decoCache, inlineCache, blockTextCache;
  H.reset = () => {
    styleCache = new WeakMap(); clipCache = new WeakMap(); kindCache = new WeakMap(); ownCache = new WeakMap(); fixedCache = new WeakMap();
    decoCache = new WeakMap(); inlineCache = new WeakMap(); blockTextCache = new WeakMap(); H._reg = null; H._ctl = null; H._cv = null; H._clipsX = null;
  };
  H.reset();
  H.cs = el => { let c = styleCache.get(el); if (!c) { c = getComputedStyle(el); styleCache.set(el, c); } return c; };
  H.vw = () => document.documentElement.clientWidth || innerWidth;
  // visual viewport: on a phone a page without meta viewport is laid out 980 px wide and shown at scale ≈ 0.4
  H.vv = () => {
    const v = window.visualViewport;
    const scale = v && v.scale > 0 && v.scale < 0.98 ? v.scale : 1;
    return { scale, w: v ? v.width : H.vw(), h: v ? v.height : innerHeight, x: v ? v.offsetLeft : 0, y: v ? v.offsetTop : 0 };
  };
  // the outermost light-DOM node of el (crosses shadow roots up to their hosts)
  H.light = el => { let n = el; for (let i = 0; n && i < 20; i++) { const r = n.getRootNode && n.getRootNode(); if (r && r.host) n = r.host; else break; } return n; };
  H.parentX = el => el.parentElement || (el.parentNode && el.parentNode.host) || null; // parent across a shadow root
  H.inFixed = el => {
    if (!el || el.nodeType !== 1 || el === document.body || el === document.documentElement) return false;
    if (fixedCache.has(el)) return fixedCache.get(el);
    const v = H.cs(el).position === 'fixed' || H.inFixed(H.parentX(el));
    fixedCache.set(el, v);
    return v;
  };
  H.pageClipsX = () => {
    if (H._clipsX === null) { const x = v => v === 'hidden' || v === 'clip'; H._clipsX = x(H.cs(document.documentElement).overflowX) || (!!document.body && x(H.cs(document.body).overflowX)); }
    return H._clipsX;
  };
  H.scrollW = () => Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0);
  // content-visibility other than visible clips like overflow:hidden (paint containment)
  H.cvClips = c => !!c.contentVisibility && c.contentVisibility !== 'visible';
  // decorative for assistive tech: aria-hidden="true" on the element or an ancestor (shadow hosts included)
  H.deco = el => {
    if (!el || el.nodeType !== 1) return false;
    if (decoCache.has(el)) return decoCache.get(el);
    const v = el.getAttribute('aria-hidden') === 'true' || H.deco(H.parentX(el));
    decoCache.set(el, v);
    return v;
  };
  H.docH = () => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
  H.clean = (s, n = 200) => String(s == null ? '' : s).replace(/[\s\u00a0]+/g, ' ').trim().slice(0, n);
  H.box = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)]; };
  H.cls = el => { const c = el && el.getAttribute && el.getAttribute('class'); return c ? String(c) : ''; };
  const IDENT = /^[A-Za-z_][\w-]*$/;
  const DYN = /^(active|open|opened|show|shown|visible|hover|focus|is-|js-|aos|animated|lazy|loaded)/;
  H.sel = el => {
    if (!el || el.nodeType !== 1) return null;
    const parts = [];
    for (let cur = el, d = 0; cur && cur.nodeType === 1 && d < 6; cur = cur.parentElement, d++) {
      const tag = cur.tagName.toLowerCase();
      if (tag === 'html' || tag === 'body') { parts.unshift(tag); break; }
      if (cur.id && IDENT.test(cur.id) && cur.id.length <= 48) {
        let uniq = false; try { uniq = document.querySelectorAll('#' + CSS.escape(cur.id)).length === 1; } catch {}
        if (uniq) { parts.unshift(tag + '#' + cur.id); break; }
      }
      let piece = tag;
      const classes = H.cls(cur).split(/\s+/).filter(c => IDENT.test(c) && c.length <= 32 && !DYN.test(c)).slice(0, 2);
      if (classes.length) piece += '.' + classes.join('.');
      const p = cur.parentElement;
      if (p) { const same = []; for (const c of p.children) if (c.tagName === cur.tagName) same.push(c); if (same.length > 1) piece += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')'; }
      parts.unshift(piece);
    }
    while (parts.length > 1 && parts.join(' > ').length > 240) parts.shift();
    return parts.join(' > ');
  };
  // has a layout box (not display:none / closed <details> / content-visibility:hidden up the chain)
  H.rendered = el => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility()) return false;
    return el.getClientRects().length > 0;
  };
  H.opaque = el => !el.checkVisibility || el.checkVisibility({ opacityProperty: true, visibilityProperty: true, checkOpacity: true, checkVisibilityCSS: true });
  const hides = v => v === 'hidden' || v === 'clip';
  // null, or { zero, by }: the element lies outside an ancestor that hides overflow (accordion, slider: by = that
  // ancestor) or off the page (by = 'offscreen': left/top of the document; right of the window for fixed layers such
  // as an off-canvas menu with translateX(100%); right of the page's scroll width — or of the window when the page
  // clips overflow-x — for the rest). Clipping ancestors are checked first, so a slide pushed out of a full-width
  // slider is «clip», not «offscreen». A card in a strip with overflow-x:auto|scroll is reachable by a swipe: it is
  // not clipped, and the page edges are checked on that strip, not on the card.
  H.clipped = el => {
    if (clipCache.has(el)) return clipCache.get(el);
    let res = null;
    const r = el.getBoundingClientRect();
    const fixed = H.inFixed(el);
    const pageRight = () => (H.pageClipsX() ? H.vw() : H.scrollW()) - 1;
    if (r.width <= 1 && r.height <= 1) res = { zero: true, by: 'self' };
    else if (fixed && (r.right <= 0 || r.bottom <= 0 || r.top >= innerHeight - 1 || r.left >= innerWidth - 1)) res = { zero: false, by: 'offscreen' };
    let strip = null, rr = r; // above a scrollable strip the strip's own box is what ancestors may clip
    if (!res && H.cs(el).position !== 'fixed') {
      for (let a = el.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) {
        const c = H.cs(a);
        const cv = H.cvClips(c);
        const hx = cv || hides(c.overflowX), hy = cv || hides(c.overflowY);
        if (hx || hy) {
          const ar = a.getBoundingClientRect();
          if ((hx && (rr.right <= ar.left + 1 || rr.left >= ar.right - 1)) || (hy && (rr.bottom <= ar.top + 1 || rr.top >= ar.bottom - 1))) {
            res = { zero: ar.width < 2 || ar.height < 2, by: a }; break;
          }
        }
        if (!strip && !hx && (c.overflowX === 'auto' || c.overflowX === 'scroll') && a.scrollWidth > a.clientWidth + 1) { strip = a; rr = a.getBoundingClientRect(); }
        if (c.position === 'fixed') break;
      }
    }
    if (!res && !fixed && (rr.right <= 0 || r.bottom + scrollY <= 0 || rr.left + scrollX >= pageRight())) res = { zero: false, by: 'offscreen' };
    clipCache.set(el, res);
    return res;
  };
  H.shown = (el, opts) => {
    const o = opts || {};
    if (!H.rendered(el)) return false;
    if (o.opacity !== false && !H.opaque(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    return !H.clipped(el);
  };
  // ---- regions: header / main / footer (semantic tags first, then class names, then geometry)
  H.regions = () => {
    if (H._reg) return H._reg;
    const vw = H.vw(), vh = innerHeight;
    // content height (scrollHeight of a short page equals the window height)
    let docH = 1;
    if (document.body) for (const c of document.body.children) { const b = c.getBoundingClientRect().bottom + scrollY; if (b > docH) docH = Math.round(b); }
    if (docH <= 1) docH = H.docH();
    const topOf = el => el.getBoundingClientRect().top + scrollY;
    const fixedish = el => { const p = H.cs(el).position; return p === 'fixed' || p === 'sticky'; };
    const outermost = list => list.filter(e => !list.some(o => o !== e && o.contains(e)));
    const q = s => { try { return [...document.querySelectorAll(s)]; } catch { return []; } };
    let how = { header: null, footer: null, main: null };
    let header = q('header, [role="banner"]').filter(e => e.getAttribute('role') === 'banner' || topOf(e) < 400 || fixedish(e))
      .filter(e => e.getAttribute('role') === 'banner' || !e.closest('article, footer, [role="contentinfo"], dialog, [role="dialog"]'));
    header = outermost(header); if (header.length) how.header = 'tag';
    if (!header.length) {
      const re = /(^|[\s_-])(site-?header|page-?header|header|navbar|topbar|top-bar|masthead|t-menu\w*|t228|t-header|uc-header|menu-?top|top-?menu|main-?menu|nav-?bar)([\s_-]|$)/i;
      const c = q('[class*="header" i], [id*="header" i], [class*="navbar" i], [class*="menu" i], [id*="menu" i], nav')
        .filter(e => re.test(H.cls(e) + ' ' + (e.id || '')) || e.tagName === 'NAV')
        .filter(e => { const r = e.getBoundingClientRect(); return (topOf(e) < 300 || fixedish(e)) && r.height < Math.max(vh * 0.6, 320) && (r.width >= vw * 0.6 || fixedish(e) || !H.rendered(e)) && e.querySelector('a, button'); });
      header = outermost(c); if (header.length) how.header = 'class';
    }
    if (!header.length) {
      // the widest short box around the first link at the top; the climb stops at the content itself
      // (main, article, section, or a box holding the H1 or main): on a page without a header the header stays empty
      // A box of text with one link in it (an intro paragraph) is not a header: at least two links or buttons, and
      // a navigation or mostly link text (a logo with a menu; a phone and an address may stand beside them).
      const navLike = p => {
        const acts = p.querySelectorAll('a[href], button, [role="button"]');
        if (acts.length < 2) return false;
        if (p.querySelector('nav, [role="navigation"]')) return true;
        const all = (p.innerText || '').replace(/\s+/g, '').length;
        let inLinks = 0; for (const x of acts) inLinks += (x.innerText || '').replace(/\s+/g, '').length;
        return all <= 120 || inLinks >= all * 0.4;
      };
      const a = q('a[href]').find(x => H.rendered(x) && topOf(x) < 150);
      if (a) {
        let best = null;
        for (let p = a.parentElement; p && p !== document.body; p = p.parentElement) {
          if (p.matches('main, [role="main"], article, section') || p.querySelector('h1, main, [role="main"]')) break;
          const r = p.getBoundingClientRect();
          if (r.height >= 320) break;
          if (r.width >= vw * 0.6 && navLike(p)) best = p;
        }
        if (best) { header = [best]; how.header = 'geometry'; }
      }
    }
    let footer = q('footer, [role="contentinfo"]').filter(e => e.getAttribute('role') === 'contentinfo' || !e.closest('article, dialog, [role="dialog"], blockquote'));
    if (footer.length > 1) footer = footer.filter(e => e.getAttribute('role') === 'contentinfo' || topOf(e) > docH * 0.4 || !H.rendered(e));
    footer = outermost(footer); if (footer.length) how.footer = 'tag';
    if (!footer.length) {
      const re = /(^|[\s_-])(site-?footer|page-?footer|footer|t-footer|uc-footer|podval)([\s_-]|$)/i;
      footer = outermost(q('[class*="footer" i], [id*="footer" i], [class*="podval" i]').filter(e => re.test(H.cls(e) + ' ' + (e.id || '')) && topOf(e) > docH * 0.5));
      if (footer.length) how.footer = 'class';
    }
    if (!footer.length && document.body) {
      const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: n => /©|\(c\)\s*\d{4}|все права защищены|all rights reserved/i.test(n.nodeValue) ? 1 : 3 });
      let last = null, n; while ((n = tw.nextNode())) last = n;
      if (last && last.parentElement && topOf(last.parentElement) > docH * 0.5) {
        let f = last.parentElement;
        for (let p = f.parentElement; p && p !== document.body; p = p.parentElement) { if (p.getBoundingClientRect().height > docH * 0.35) break; f = p; }
        footer = [f]; how.footer = 'copyright';
      }
    }
    const mains = outermost(q('main, [role="main"]').filter(e => H.rendered(e)));
    const main = mains[0] || null; if (main) how.main = 'tag';
    H._reg = { header, footer, main, how };
    return H._reg;
  };
  H.regionOf = el => {
    const R = H.regions();
    const n = H.light(el); // text inside a custom element's shadow root belongs where its host is
    for (const h of R.header) if (h.contains(n)) return 'header';
    for (const f of R.footer) if (f.contains(n)) return 'footer';
    if (R.main) return R.main.contains(n) ? 'main' : 'other';
    return 'main';
  };
  // ---- why hidden content is hidden: details | tab | accordion | popup | tooltip | menu | slider | null
  const POPUP_RE = /(^|[\s_-])(popup|pop-up|modal|lightbox|fancybox|mfp-wrap|dialog|t-popup|uc-popup)([\s_-]|$)/i;
  // a digit may follow the word («drawer2», «mobile-nav3»), then a separator or the end («mobile-nav__list»)
  const MENU_RE = /(^|[\s_-])(offcanvas|off-canvas|drawer|mobile-?menu|menu-?mobile|mob-?menu|mobile-?nav|nav-?mobile|mob-?nav|burger-?menu|menu-?burger|side-?menu|side-?nav|sidenav|t-menuburger|t450)\d*([\s_-]|$)/i;
  const SLIDER_RE = /(swiper|slick|carousel|glide|splide|owl-|flickity|embla|keen-slider|slider|t-slds|(^|[\s_-])slides?([\s_-]|$))/i;
  const ACC_RE = /(accordion|accordeon|collaps|spoiler|faq|answer|expand|toggle|tab-?pane|tab-?panel|tab-?content|tabs?__(content|panel|pane|body|item)|t-?tabs)/i;
  const STATE_CLS = /^(active|is-active|current|cur|on|selected|is-selected|show|shown|visible|is-visible|open|opened|is-open|hidden|hide|d-none|in|fade|js-.*)$/i;
  // ids referenced by aria-controls → role of the controlling element (built once per reset)
  H.controlled = () => {
    if (H._ctl) return H._ctl;
    const m = new Map();
    for (const c of document.querySelectorAll('[aria-controls]')) for (const id of String(c.getAttribute('aria-controls')).split(/\s+/)) if (id && !m.has(id)) m.set(id, c.getAttribute('role') || c.tagName.toLowerCase());
    H._ctl = m;
    return m;
  };
  // a shown sibling of the same tag with the same set of non-state classes (the hidden one's set may be a part of
  // the shown one's): the other tab or slide of the same set. «pane» / «pane cur» and «tab-1» / «tab-2» are twins;
  // adaptive copies «lead lead--m» / «lead lead--d» (one hidden by @media) are not.
  const STATE_SUFFIX = /(--|__|_|-)(active|current|cur|open|opened|selected|shown|visible|hidden|show|hide|on|off)$/i;
  const classKeys = el => [...new Set(H.cls(el).split(/\s+/).filter(x => x && !STATE_CLS.test(x) && !STATE_SUFFIX.test(x)).map(x => x.replace(/\d+$/, '')))];
  H.shownTwin = a => {
    const p = a.parentElement;
    if (!p || p.children.length < 2 || p.children.length > 80) return null;
    const mine = classKeys(a);
    if (!mine.length) return null;
    for (const s of p.children) {
      if (s === a || s.tagName !== a.tagName) continue;
      const theirs = classKeys(s);
      if (!mine.every(x => theirs.includes(x))) continue;
      if (H.rendered(s) && H.opaque(s) && !H.clipped(s)) return s;
    }
    return null;
  };
  const overlapShare = (a, b) => {
    if (!a.getClientRects().length) return 0;
    const r = a.getBoundingClientRect(), s = b.getBoundingClientRect();
    const w = Math.min(r.right, s.right) - Math.max(r.left, s.left), h = Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top);
    const min = Math.min(r.width * r.height, s.width * s.height);
    return w > 0 && h > 0 && min > 0 ? (w * h) / min : 0;
  };
  // kind given by the element itself (no ancestors), cached: cheap enough for every node of a hidden subtree
  H.ownKind = a => {
    if (!a || a.nodeType !== 1) return null;
    if (ownCache.has(a)) return ownCache.get(a);
    const k = ownKindRaw(a);
    ownCache.set(a, k);
    return k;
  };
  const ownKindRaw = a => {
    const tag = a.tagName, role = a.getAttribute('role');
    if (tag === 'DETAILS' && !a.open) return 'details';
    if (role === 'tabpanel') return 'tab';
    if (tag === 'DIALOG' || role === 'dialog' || role === 'alertdialog' || a.getAttribute('aria-modal') === 'true') return 'popup';
    if (role === 'tooltip') return 'tooltip';
    if (a.id && H.controlled().has(a.id)) return H.controlled().get(a.id) === 'tab' ? 'tab' : 'accordion';
    const name = H.cls(a) + ' ' + (a.id || '');
    if (name.length > 1) {
      if (MENU_RE.test(name)) return 'menu';
      if (POPUP_RE.test(name)) return 'popup';
      if (SLIDER_RE.test(name)) return 'slider';
      if (ACC_RE.test(name)) return /tab/i.test(name) && !/table/i.test(name) && !/accordion|faq/i.test(name) ? 'tab' : 'accordion';
    }
    const prev = a.previousElementSibling;
    if (prev && prev.getAttribute('aria-expanded') === 'false') return 'accordion';
    // no markup: judge by the shape around an element that hides its own content
    const c = H.cs(a);
    // a layer of a fixed panel pushed off the screen (translateX(±100%)) with links or buttons: an off-canvas menu
    if (H.inFixed(a) && a.querySelector('a[href], button, [role="button"]')) { const cl = H.clipped(a); if (cl && cl.by === 'offscreen') return 'menu'; }
    const zeroH = (c.height === '0px' || c.maxHeight === '0px') && (hides(c.overflowY) || hides(c.overflow));
    const selfHidden = c.display === 'none' || c.visibility === 'hidden' || parseFloat(c.opacity) < 0.05 || zeroH;
    if (!selfHidden) return null;
    const twin = H.shownTwin(a);
    if (twin) return overlapShare(a, twin) > 0.5 || SLIDER_RE.test(H.cls(a.parentElement) + ' ' + H.cls(a.parentElement && a.parentElement.parentElement)) ? 'slider' : 'tab';
    if (zeroH && prev && H.rendered(prev)) { const t = (prev.innerText || '').trim().length; if (t > 0 && t <= 200) return 'accordion'; }
    // a hidden layer over the page with something to act on: a popup
    if (c.position === 'fixed' && a.querySelector('button, a[href], form, input, h1, h2, h3, h4, [role="button"]')) return 'popup';
    // a hidden absolute box with a heading and a form or a button (a window positioned over its section)
    if (c.position === 'absolute' && c.display === 'none' && a.querySelector('form, input, button, [role="button"]') && a.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')) return 'popup';
    return null;
  };
  H.collapsedKind = el => {
    if (kindCache.has(el)) return kindCache.get(el);
    let kind = null;
    const d = el.closest('details:not([open])');
    const sum = el.closest('summary');
    if (d && !(sum && sum.parentElement === d)) kind = 'details';
    else for (let a = el; a && a !== document.body; a = H.parentX(a)) { kind = H.ownKind(a); if (kind) break; }
    if (!kind && (H.regionOf(el) === 'header' || el.closest('nav, [role="navigation"], [role="menu"], [role="menubar"]'))) kind = 'menu';
    kindCache.set(el, kind);
    return kind;
  };
  // element that directly holds the first visible text of el (for CDP font queries)
  H.textHolder = el => {
    if (!el) return null;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeValue.trim() ? 1 : 3 });
    const n = tw.nextNode();
    return n ? n.parentElement : el;
  };
  // ---- a link inside a sentence (WCAG 2.5.8 exception): an inline link that shares a line with text of its block
  // that belongs to no link or button. Separators («·», «|», «/», «—») and <br> carry no letters and do not count;
  // a link alone on its line (a column of footer links) is not inline.
  const INTERACTIVE = 'a, button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input, select, textarea';
  const blockTexts = b => {
    let list = blockTextCache.get(b);
    if (list) return list;
    list = [];
    const rg = document.createRange();
    const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, { acceptNode: n => /[\p{L}\p{N}]/u.test(n.nodeValue) ? 1 : 3 });
    let n, k = 0;
    while ((n = tw.nextNode()) && k++ < 600) {
      const p = n.parentElement;
      if (!p) continue;
      const own = p.closest(INTERACTIVE);
      if (own && b.contains(own)) continue;
      rg.selectNodeContents(n);
      const r = rg.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) list.push({ n, top: r.top, bottom: r.bottom });
    }
    blockTextCache.set(b, list);
    return list;
  };
  H.inlineInText = a => {
    if (!a || a.nodeType !== 1) return false;
    if (inlineCache.has(a)) return inlineCache.get(a);
    let res = false;
    const d = H.cs(a).display;
    if (d === 'inline' || d === 'contents') {
      let b = a.parentElement;
      while (b && (H.cs(b).display === 'inline' || H.cs(b).display === 'contents')) b = b.parentElement;
      const rects = [...a.getClientRects()].filter(r => r.width > 0 && r.height > 0);
      if (b && rects.length) {
        const top = Math.min(...rects.map(r => r.top)), bot = Math.max(...rects.map(r => r.bottom));
        const rg = document.createRange();
        outer: for (const t of blockTexts(b)) {
          if (t.bottom < top - 1 || t.top > bot + 1) continue;
          const re = /[\p{L}\p{N}]+/gu; let m, w = 0;
          while ((m = re.exec(t.n.nodeValue)) && w++ < 400) {
            rg.setStart(t.n, m.index); rg.setEnd(t.n, m.index + m[0].length);
            for (const wr of rg.getClientRects()) {
              if (wr.width <= 0) continue;
              for (const r of rects) {
                const ov = Math.min(r.bottom, wr.bottom) - Math.max(r.top, wr.top);
                if (ov > Math.min(r.height, wr.height) * 0.5) { res = true; break outer; }
              }
            }
          }
        }
      }
    }
    inlineCache.set(a, res);
    return res;
  };
  // in-page anchor target of an href «#id» (null when the href is not a same-page anchor or the id is malformed)
  H.anchorTarget = raw => {
    const s = String(raw || '').trim();
    if (!s.startsWith('#') || s.length < 2) return null;
    let id = s.slice(1);
    try { id = decodeURIComponent(id); } catch { /* «#sale-50%»: keep as written */ }
    return document.getElementById(id) || document.getElementsByName(id)[0] || null;
  };
  // ---- content-visibility:auto subtrees far from the screen are skipped: innerText is empty there and CDP has no
  // fonts for them. unskip() renders them for a moment (inline !important), the returned function puts them back.
  H.cvAuto = () => {
    if (!H._cv) {
      H._cv = [];
      const all = document.body ? document.body.getElementsByTagName('*') : [];
      for (let i = 0; i < all.length && i < 60000; i++) if (H.cs(all[i]).contentVisibility === 'auto') H._cv.push(all[i]);
    }
    return H._cv;
  };
  H.unskip = (list) => {
    const els = (list || H.cvAuto()).filter(el => el.isConnected);
    const saved = els.map(el => [el, el.style.getPropertyValue('content-visibility'), el.style.getPropertyPriority('content-visibility')]);
    for (const el of els) el.style.setProperty('content-visibility', 'visible', 'important');
    return () => { for (const [el, v, p] of saved) { if (v) el.style.setProperty('content-visibility', v, p); else el.style.removeProperty('content-visibility'); } };
  };
  // cv:auto ancestors of el (for unskip of one element)
  H.cvAncestors = el => { const out = []; for (let a = el; a && a.nodeType === 1; a = H.parentX(a)) if (H.cs(a).contentVisibility === 'auto') out.push(a); return out; };
  // text of el even when it sits in a skipped content-visibility:auto subtree
  H.textOf = el => {
    const t = el.innerText;
    if (t && t.trim()) return t;
    if (el.checkVisibility && el.checkVisibility() && !el.checkVisibility({ contentVisibilityAuto: true })) return el.textContent || '';
    return t || '';
  };
  Object.defineProperty(window, '__revizorH', { value: H, configurable: true, writable: true, enumerable: false });
  return V;
}

export async function ensureHelpers(page) {
  await ev(page, revizorHelpers, HELPERS_VERSION);
}

// ---------------------------------------------------------------------------------------------
// Node helpers shared by collectors

// status and final URL of the load (snapshot may pass them in ctx; otherwise from the CDP log)
export function loadInfo(page, ctx = {}) {
  const doc = (page.responses || []).find(r => r.type === 'Document');
  return {
    status: ctx.status ?? ctx.load?.status ?? ctx.goto?.status ?? doc?.status ?? null,
    final_url: ctx.finalUrl ?? ctx.final_url ?? ctx.load?.finalUrl ?? ctx.goto?.finalUrl ?? doc?.url ?? ctx.url ?? null,
  };
}

// primary item of a pid: 1440 if present, else the widest
export function primaryOf(items) {
  const ok = items.filter(x => x && x.data && !x.data.error);
  const pool = ok.length ? ok : items;
  return pool.find(x => x.width === 1440) || [...pool].sort((a, b) => b.width - a.width)[0];
}

// pids of the run's selected pages (ctx.pages: pages.json object or its «selected» array);
// null when no list is given (tests, ad-hoc hosts): then every pid is kept
export function selectedPids(pages) {
  const list = Array.isArray(pages) ? pages : Array.isArray(pages?.selected) ? pages.selected : null;
  const pids = (list || []).map(p => p && p.pid).filter(Boolean);
  return pids.length ? new Set(pids) : null;
}

// collected items grouped by pid (sorted by width). With «pages», pids missing from it are dropped
// (stale collect files of pages no longer selected); their list is in map.dropped.
export function groupByPid(all, pages) {
  const keep = selectedPids(pages);
  const m = new Map(), dropped = new Set();
  for (const it of all || []) {
    if (!it) continue;
    if (keep && !keep.has(it.pid)) { dropped.add(it.pid); continue; }
    if (!m.has(it.pid)) m.set(it.pid, []);
    m.get(it.pid).push(it);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.width - b.width);
  m.dropped = [...dropped];
  return m;
}

// log line about pids dropped by groupByPid (nothing when none)
export function logDropped(ctx, name, groups) {
  if (!groups?.dropped?.length || typeof ctx?.log !== 'function') return;
  ctx.log(`${name}: ${ctx.lang === 'en' ? 'skipped pages not in pages.json' : 'пропущены страницы не из pages.json'}: ${groups.dropped.join(', ')}`);
}

// measure/<name>.json with the common measure header (tool, version, run, generated, partial, resume, pages,
// summary, items, errors, not_checked). Items of page × width pairs not in this call are kept
// (a resumed snapshot passes only what it collected this time).
export function writeMeasureMerged(ctx, name, { items, summaryFn, errors = [], not_checked = [] }) {
  const path = insideRun(ctx.run, 'measure', `${name}.json`);
  const prev = existsSync(path) ? readJSON(path, {}) : {};
  const key = x => `${x.pid}@${x.width ?? ''}`;
  const now = new Set([...items, ...errors].map(key));
  const sel = selectedPids(ctx.pages);
  const live = x => !sel || sel.has(x.pid);
  const kept = (prev.items || []).filter(x => !now.has(key(x)) && live(x));
  const allItems = [...kept, ...items].sort((a, b) => String(a.pid).localeCompare(String(b.pid)) || (a.width || 0) - (b.width || 0));
  const keptErrors = (prev.errors || []).filter(e => !now.has(key(e)) && live(e));
  const out = {
    tool: name, version: VERSION, run: ctx.run, generated: nowIso(),
    partial: !!ctx.partial, resume: ctx.partial ? (ctx.resume || null) : null,
    pages: [...new Set(allItems.map(x => x.pid))],
    summary: summaryFn ? summaryFn(allItems) : {},
    items: allItems, errors: [...keptErrors, ...errors], not_checked,
  };
  if (typeof ctx.writeMeasure === 'function') ctx.writeMeasure(name, out);
  else writeJSON(path, out);
  return out;
}

// read-modify-write of snapshot/<pid>/page.json: our keys replace, other writers' keys stay.
// patch may be a function prev => patch (to merge with what an earlier call wrote).
export async function updatePageJson(run, pid, patch) {
  const path = insideRun(run, 'snapshot', String(pid), 'page.json');
  await withFileLock(path + '.lock', async () => {
    const prev = existsSync(path) ? readJSON(path, {}) : {};
    writeJSON(path, { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) });
  });
  return path;
}

// All stylesheet texts of the main frame through CDP (cross-origin sheets included), cached per load.
export async function getCssTexts(page, ctx = {}) {
  const key = 'revizor:cssTexts';
  if (ctx.cache && ctx.cache.has(key)) return ctx.cache.get(key);
  const headers = [];
  const off = page.on('CSS.styleSheetAdded', p => headers.push(p.header));
  try {
    await page.send('DOM.enable').catch(() => {});
    await page.send('CSS.disable').catch(() => {});
    await page.send('CSS.enable');
    await sleep(200);
  } finally { off(); }
  const out = []; let total = 0;
  for (const h of headers) {
    if (h.origin && h.origin !== 'regular') continue;
    if (page.mainFrameId && h.frameId && h.frameId !== page.mainFrameId) continue;
    if (total > 4e6) { out.push({ url: h.sourceURL || null, skipped: 'limit' }); continue; }
    try {
      const { text } = await page.send('CSS.getStyleSheetText', { styleSheetId: h.styleSheetId }, 20000);
      total += text.length;
      out.push({ url: h.sourceURL || null, inline: !!h.isInline, constructed: !!h.isConstructed, disabled: !!h.disabled, length: text.length, text });
    } catch (e) { out.push({ url: h.sourceURL || null, error: String(e.message).slice(0, 200) }); }
  }
  if (ctx.cache) ctx.cache.set(key, out);
  return out;
}

// in-page: parse CSS texts with constructable sheets → hover-only rules and @font-face rules
function analyzeCssInPage(sheets) {
  const res = { sheets: sheets.length, rules: 0, parse_errors: 0, imports: [],
    hover: { total: 0, guarded: 0, unguarded: 0, unguarded_active: 0, reveal: 0, reveal_active: 0, transform: 0, transform_active: 0, samples: [] },
    font_faces: [], hover_reveal_selectors: [] };
  const guardRe = /\(\s*(any-)?hover\s*:\s*hover\s*\)|\(\s*(any-)?pointer\s*:\s*fine\s*\)/i;
  const REVEAL = new Set(['display', 'visibility', 'opacity', 'max-height', 'height', 'clip-path', 'clip', 'pointer-events', 'overflow']);
  const TRANSFORM = new Set(['transform', 'scale', 'translate', 'rotate', 'zoom']);
  const mmCache = new Map();
  const mm = c => { if (!mmCache.has(c)) { let v = true; try { v = matchMedia(c).matches; } catch {} mmCache.set(c, v); } return mmCache.get(c); };
  const samples = [];
  for (const s of sheets) {
    if (!s || typeof s.text !== 'string') continue;
    let sheet;
    try { sheet = new CSSStyleSheet(); sheet.replaceSync(s.text.replace(/@import[^;]*;/g, m => { res.imports.push(m.slice(0, 200)); return ''; })); }
    catch { res.parse_errors++; continue; }
    const walk = (rules, guards) => {
      for (const r of rules) {
        res.rules++;
        if (typeof CSSMediaRule !== 'undefined' && r instanceof CSSMediaRule) { walk(r.cssRules, guards.concat(r.conditionText || r.media.mediaText)); continue; }
        if (r instanceof CSSFontFaceRule) {
          const st = r.style;
          res.font_faces.push({ family: (st.getPropertyValue('font-family') || '').replace(/["']/g, '').trim(), weight: st.getPropertyValue('font-weight') || null,
            style: st.getPropertyValue('font-style') || null, display: st.getPropertyValue('font-display') || null,
            unicode_range: (st.getPropertyValue('unicode-range') || '').slice(0, 300) || null, src: (st.getPropertyValue('src') || '').slice(0, 400), sheet: s.url || (s.inline ? 'inline' : null) });
          continue;
        }
        if (r.cssRules && !(r instanceof CSSStyleRule)) { walk(r.cssRules, guards); continue; } // @supports, @layer, @container
        if (r instanceof CSSStyleRule) {
          const sel = r.selectorText || '';
          if (sel.includes(':hover')) {
            res.hover.total++;
            // selectors of what a hover reveals, «:hover» cut out (text.mjs labels such blocks «on hover»)
            if (res.hover_reveal_selectors.length < 400) {
              let rv = false; for (let i = 0; i < r.style.length; i++) if (REVEAL.has(r.style[i])) { rv = true; break; }
              if (rv) for (const part of sel.split(',')) if (part.includes(':hover')) res.hover_reveal_selectors.push(part.replace(/:hover/g, '').trim().slice(0, 300));
            }
            const guarded = guards.some(g => guardRe.test(g));
            if (guarded) res.hover.guarded++;
            else {
              res.hover.unguarded++;
              const active = guards.every(mm);
              if (active) res.hover.unguarded_active++;
              const props = []; for (let i = 0; i < r.style.length; i++) props.push(r.style[i]);
              // reveal: hover on one element changes visibility of another (".menu:hover .sub {display:block}")
              const descendant = sel.split(',').some(p => /:hover[^\s>+~,]*\s*[\s>+~]\s*\S/.test(p.trim()));
              const isReveal = descendant && props.some(p => REVEAL.has(p));
              const isTransform = props.some(p => TRANSFORM.has(p));
              if (isReveal) { res.hover.reveal++; if (active) res.hover.reveal_active++; }
              if (isTransform) { res.hover.transform++; if (active) res.hover.transform_active++; }
              if ((isReveal || isTransform) && samples.length < 60) samples.push({ kind: isReveal ? 'reveal' : 'transform', active, selector: sel.slice(0, 160), props: props.slice(0, 8), media: guards.slice(-2), sheet: s.url ? String(s.url).split('?')[0].slice(-120) : (s.inline ? 'inline' : null) });
            }
          }
          if (r.cssRules && r.cssRules.length) walk(r.cssRules, guards); // CSS nesting
        }
      }
    };
    try { walk(sheet.cssRules, []); } catch { res.parse_errors++; }
  }
  samples.sort((a, b) => (b.active - a.active) || (a.kind === 'reveal' ? -1 : 1));
  res.hover.samples = samples.slice(0, 15);
  return res;
}

export async function getCssAnalysis(page, ctx = {}) {
  const key = 'revizor:cssAnalysis';
  if (ctx.cache && ctx.cache.has(key)) return ctx.cache.get(key);
  const texts = await getCssTexts(page, ctx);
  const usable = texts.filter(t => typeof t.text === 'string').map(t => ({ url: t.url, inline: t.inline, text: t.text }));
  const res = await ev(page, analyzeCssInPage, usable);
  res.unreadable = texts.filter(t => t.error || t.skipped).map(t => ({ url: t.url, why: t.error || t.skipped })).slice(0, 20);
  if (ctx.cache) ctx.cache.set(key, res);
  return res;
}

// ---------------------------------------------------------------------------------------------
// meta: in-page collection
async function collectMetaInPage(L) {
  const H = window.__revizorH;
  const q = s => { try { return [...document.querySelectorAll(s)]; } catch { return []; } };
  const abs = u => { if (u == null || u === '') return null; try { return new URL(u, document.baseURI).href; } catch { return String(u); } };
  const hostOfU = u => { try { return new URL(u, document.baseURI).hostname; } catch { return null; } };
  const metas = q('meta').slice(0, 200).map(m => ({ name: m.getAttribute('name'), property: m.getAttribute('property'), http_equiv: m.getAttribute('http-equiv'),
    charset: m.getAttribute('charset'), itemprop: m.getAttribute('itemprop'), content: m.getAttribute('content') == null ? null : m.getAttribute('content').slice(0, 500) }));
  const metaBy = key => metas.filter(m => String(m.name || m.property || m.http_equiv || '').toLowerCase() === key).map(m => m.content);
  const prefixed = pre => { const o = {}; for (const m of metas) { const k = String(m.property || m.name || '').toLowerCase(); if (k.startsWith(pre) && o[k] === undefined) o[k] = m.content; } return o; };

  const vp = metaBy('viewport');
  const vpParsed = {};
  if (vp[0]) for (const part of vp[0].split(/[,;]/)) { const [k, v] = part.split('=').map(x => (x || '').trim().toLowerCase()); if (k) vpParsed[k] = v ?? ''; }
  const vh = innerHeight, dpr = devicePixelRatio || 1;

  const headingEls = q('h1, h2, h3, h4, h5, h6, [role="heading"]');
  const headings = headingEls.slice(0, 300).map(h => {
    const lvl = /^H[1-6]$/.test(h.tagName) ? +h.tagName[1] : (+h.getAttribute('aria-level') || 2);
    return { level: lvl, tag: h.tagName.toLowerCase(), text: H.clean(h.innerText || h.textContent, 200), shown: H.shown(h, { opacity: false }), region: H.regionOf(h), y: Math.round(h.getBoundingClientRect().top + scrollY) };
  });

  const jsonld = q('script[type="application/ld+json" i]').slice(0, 30).map(s => {
    const raw = s.textContent || '';
    const o = { bytes: raw.length, ok: false, types: [], error: null, raw: raw.slice(0, 20000) };
    try {
      const data = JSON.parse(raw); o.ok = true;
      const types = new Set();
      const walk = (x, d) => { if (!x || d > 10) return; if (Array.isArray(x)) { x.forEach(y => walk(y, d + 1)); return; } if (typeof x === 'object') { const t = x['@type']; if (t) [].concat(t).forEach(tt => types.add(String(tt))); for (const k of Object.keys(x)) if (k !== '@context') walk(x[k], d + 1); } };
      walk(data, 0); o.types = [...types].slice(0, 50);
    } catch (e) { o.error = String(e.message).slice(0, 200); }
    return o;
  });

  const imgEls = q('img');
  const images = imgEls.slice(0, 400).map(img => {
    const r = img.getBoundingClientRect();
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '';
    const shown = H.shown(img, { opacity: false });
    const extm = src.split(/[?#]/)[0].match(/\.([a-z0-9]{2,5})$/i);
    const format = src.startsWith('data:') ? (src.slice(5, src.indexOf(';')) || 'data') : (extm ? extm[1].toLowerCase() : null);
    const alt = img.getAttribute('alt');
    const pic = img.parentElement && img.parentElement.tagName === 'PICTURE' ? [...img.parentElement.querySelectorAll('source')].map(s => s.getAttribute('type')).filter(Boolean) : null;
    return { src: src.slice(0, 300), alt: alt === null ? null : alt.slice(0, 250), role: img.getAttribute('role'), aria_hidden: img.getAttribute('aria-hidden') === 'true',
      natural: [img.naturalWidth, img.naturalHeight], rendered: [Math.round(r.width), Math.round(r.height)],
      oversize: img.naturalWidth && r.width >= 1 ? Math.round(10 * img.naturalWidth / (r.width * dpr)) / 10 : null,
      format, loading: img.getAttribute('loading'), decoding: img.getAttribute('decoding'), fetchpriority: img.getAttribute('fetchpriority'),
      srcset: !!img.getAttribute('srcset'), sizes: img.getAttribute('sizes'), has_dims: img.hasAttribute('width') && img.hasAttribute('height'),
      in_fold: shown && r.top < vh && r.bottom > 0, shown, broken: !!(src && !src.startsWith('data:') && img.complete && img.naturalWidth === 0),
      lazy_attr_only: !img.getAttribute('src') && !!(img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('data-lazy')),
      picture_sources: pic, region: H.regionOf(img), box: H.box(img) };
  });

  const videos = q('video').slice(0, 30).map(v => ({ src: (v.currentSrc || v.src || (v.querySelector('source') || {}).src || '').slice(0, 300), autoplay: v.autoplay, muted: v.muted, has_muted_attr: v.hasAttribute('muted'),
    playsinline: v.hasAttribute('playsinline') || v.hasAttribute('webkit-playsinline'), loop: v.loop, controls: v.controls, poster: v.getAttribute('poster') ? abs(v.getAttribute('poster')) : null,
    preload: v.getAttribute('preload'), paused: v.paused, shown: H.shown(v, { opacity: false }), box: H.box(v) }));
  const iframes = q('iframe').slice(0, 40).map(f => ({ src: (f.getAttribute('src') ? abs(f.getAttribute('src')) : f.getAttribute('data-src') || null), host: f.getAttribute('src') ? hostOfU(f.getAttribute('src')) : null,
    title: f.getAttribute('title'), loading: f.getAttribute('loading'), shown: H.shown(f, { opacity: false }), box: H.box(f) }));

  const forms = q('form').slice(0, 30).map(f => {
    const fields = [...f.querySelectorAll('input:not([type="hidden" i]), select, textarea')];
    const shown = H.shown(f, { opacity: false });
    return { id: f.id || null, name: f.getAttribute('name'), action: f.hasAttribute('action') ? abs(f.getAttribute('action')) : null, method: (f.getAttribute('method') || 'get').toLowerCase(),
      fields: fields.length, hidden_fields: f.querySelectorAll('input[type="hidden" i]').length,
      required: fields.filter(x => x.required || x.getAttribute('aria-required') === 'true').length,
      contact: !!f.querySelector('input[type="tel" i], input[type="email" i], input[name*="phone" i], input[name*="tel" i], input[name*="mail" i], input[name*="name" i]'),
      shown, hidden_in: shown ? null : H.collapsedKind(f), region: H.regionOf(f), box: H.box(f) };
  });
  const formlessFields = q('input:not([type="hidden" i]), select, textarea').filter(x => !x.form).length;

  const scriptEls = q('script');
  const extScripts = scriptEls.filter(s => s.src);
  const inl = scriptEls.filter(s => !s.src && !/json|template|text\/x-|text\/html/i.test(s.type || ''));
  const scripts = { external: extScripts.length, inline: inl.length, inline_bytes: inl.reduce((a, s) => a + (s.textContent || '').length, 0),
    inline_max: inl.reduce((a, s) => Math.max(a, (s.textContent || '').length), 0),
    list: extScripts.slice(0, 120).map(s => ({ src: s.src.slice(0, 300), host: hostOfU(s.src), async: s.async, defer: s.defer, module: s.type === 'module', nomodule: s.noModule,
      integrity: !!s.integrity, crossorigin: s.getAttribute('crossorigin'), in_head: !!s.closest('head') })) };
  const styleLinks = q('link[rel~="stylesheet" i]');
  const styles = { external: styleLinks.length, inline: q('style').length, inline_bytes: q('style').reduce((a, s) => a + (s.textContent || '').length, 0),
    style_attrs: document.querySelectorAll('[style]').length,
    list: styleLinks.slice(0, 60).map(l => ({ href: abs(l.getAttribute('href')), host: hostOfU(l.getAttribute('href')), media: l.getAttribute('media'), integrity: !!l.integrity })) };
  const hints = q('link[rel~="preload" i], link[rel~="preconnect" i], link[rel~="dns-prefetch" i], link[rel~="prefetch" i], link[rel~="modulepreload" i], link[rel~="prerender" i]')
    .slice(0, 60).map(l => ({ rel: l.getAttribute('rel'), href: abs(l.getAttribute('href')), as: l.getAttribute('as'), crossorigin: l.getAttribute('crossorigin'), fetchpriority: l.getAttribute('fetchpriority') }));
  const icons = q('link[rel~="icon" i], link[rel~="apple-touch-icon" i], link[rel~="apple-touch-icon-precomposed" i], link[rel~="mask-icon" i], link[rel~="manifest" i]')
    .slice(0, 30).map(l => ({ rel: l.getAttribute('rel'), href: abs(l.getAttribute('href')), sizes: l.getAttribute('sizes'), type: l.getAttribute('type') }));
  const alternates = q('link[rel~="alternate" i]').slice(0, 80).map(l => ({ hreflang: l.getAttribute('hreflang'), href: abs(l.getAttribute('href')), type: l.getAttribute('type'), media: l.getAttribute('media') }));
  const canon = q('link[rel~="canonical" i]').map(l => abs(l.getAttribute('href')));

  const comments = []; let commentsTotal = 0;
  try {
    const tw = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
    let n; while ((n = tw.nextNode())) { const t = H.clean(n.nodeValue, 200); if (t.length < 3) continue; commentsTotal++; if (comments.length < 30) comments.push(t); }
  } catch {}

  const uniq = (arr, n) => [...new Set(arr.filter(Boolean).map(x => H.clean(x, 160)))].slice(0, n);
  const a11y = {
    aria_labels: uniq(q('[aria-label]').map(e => e.getAttribute('aria-label')), 200),
    placeholders: uniq(q('input[placeholder], textarea[placeholder]').map(e => e.getAttribute('placeholder')), 100),
    titles: uniq(q('[title]').filter(e => e.tagName !== 'IFRAME' && e.tagName !== 'LINK' && e.tagName !== 'STYLE').map(e => e.getAttribute('title')), 100),
    img_alts: uniq(q('img[alt]').map(e => e.getAttribute('alt')), 200),
  };

  const stack = [];
  const gen = metaBy('generator'); if (gen[0]) stack.push('generator: ' + String(gen[0]).slice(0, 80));
  try {
    if (L.globals.next || document.getElementById('__next') || q('script[src*="/_next/"]').length) stack.push('Next.js');
    if (L.globals.nuxt || document.getElementById('__nuxt') || q('script[src*="/_nuxt/"]').length) stack.push('Nuxt');
    if (document.getElementById('allrecords') || q('script[src*="tildacdn"], link[href*="tildacdn"]').length) stack.push('Tilda');
    if (q('[src*="/wp-content/"], [href*="/wp-content/"], [src*="/wp-includes/"]').length) stack.push('WordPress');
    if (L.globals.bx || q('script[src*="/bitrix/"], link[href*="/bitrix/"]').length) stack.push('Bitrix');
    if (document.documentElement.hasAttribute('data-wf-site') || document.documentElement.hasAttribute('data-wf-page')) stack.push('Webflow');
    if (L.globals.shopify) stack.push('Shopify');
    if (q('script[src*="parastorage.com"]').length) stack.push('Wix');
    if (q('[ng-version]').length) stack.push('Angular');
    if (q('[data-reactroot]').length) stack.push('React');
    if (L.globals.vue || q('[data-v-app], [data-server-rendered="true"]').length) stack.push('Vue');
  } catch {}

  // innerText skips content-visibility:auto sections far from the screen: render them for this read only
  const undoCv = H.unskip();
  const bodyText = document.body ? (document.body.innerText || '') : '';
  undoCv();
  const words = (bodyText.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;

  const perf = await new Promise(resolve => {
    const out = { scope: 'lab, one load with a slow scroll; speed itself is measured by perf.mjs', lcp: null, cls_incl_scroll: null, fcp: null, ttfb: null, dcl: null, load: null };
    try {
      const nav = performance.getEntriesByType('navigation')[0];
      if (nav) Object.assign(out, { ttfb: Math.round(nav.responseStart), dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd),
        doc_transfer: nav.transferSize, doc_encoded: nav.encodedBodySize, doc_decoded: nav.decodedBodySize, redirects: nav.redirectCount, protocol: nav.nextHopProtocol || null });
    } catch {}
    try { const f = performance.getEntriesByName('first-contentful-paint')[0]; if (f) out.fcp = Math.round(f.startTime); } catch {}
    let lcpE = null, cls = 0;
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) lcpE = e; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch {}
    try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value; }).observe({ type: 'layout-shift', buffered: true }); } catch {}
    setTimeout(() => {
      if (lcpE) {
        const el = lcpE.element;
        out.lcp = { ms: Math.round(lcpE.renderTime || lcpE.loadTime || lcpE.startTime), size: lcpE.size, url: lcpE.url ? lcpE.url.slice(0, 300) : null,
          tag: el ? el.tagName.toLowerCase() : null, selector: el ? H.sel(el) : null,
          loading: el && el.getAttribute ? el.getAttribute('loading') : null, fetchpriority: el && el.getAttribute ? el.getAttribute('fetchpriority') : null };
      }
      out.cls_incl_scroll = Math.round(cls * 1000) / 1000;
      try {
        const res = performance.getEntriesByType('resource'); const by = {}; let total = 0, unknown = 0;
        for (const e of res) { const t = e.initiatorType || 'other'; (by[t] ||= { n: 0, bytes: 0 }); by[t].n++; by[t].bytes += e.transferSize || 0; total += e.transferSize || 0; if (!e.transferSize) unknown++; }
        out.resources = { count: res.length, transfer_bytes: total, size_unknown: unknown, by_initiator: by };
      } catch {}
      resolve(out);
    }, 150);
  });

  const titleEls = q('title').filter(t => !t.closest('svg'));
  return {
    title: document.title || null, title_tags: titleEls.length,
    description: metaBy('description')[0] ?? null, description_tags: metaBy('description').length,
    keywords: metaBy('keywords')[0] ? metaBy('keywords')[0].slice(0, 300) : null,
    canonical: canon[0] || null, canonical_all: canon,
    robots: metaBy('robots')[0] ?? null, robots_bots: { googlebot: metaBy('googlebot')[0] ?? null, yandex: metaBy('yandex')[0] ?? null },
    refresh: metaBy('refresh')[0] ?? null, base_href: (q('base[href]')[0] || { getAttribute: () => null }).getAttribute('href'),
    lang: document.documentElement.getAttribute('lang'), xml_lang: document.documentElement.getAttribute('xml:lang'), dir: document.documentElement.getAttribute('dir'),
    content_language: metaBy('content-language')[0] ?? null,
    charset: document.characterSet, doctype: document.doctype ? document.doctype.name : null, quirks: document.compatMode === 'BackCompat',
    viewport: { content: vp[0] ?? null, tags: vp.length, parsed: vpParsed,
      user_scalable_no: /^(no|0)$/.test(vpParsed['user-scalable'] || ''), maximum_scale: vpParsed['maximum-scale'] ? parseFloat(vpParsed['maximum-scale']) : null },
    theme_color: metaBy('theme-color'), color_scheme: metaBy('color-scheme')[0] ?? null, format_detection: metaBy('format-detection')[0] ?? null,
    og: prefixed('og:'), twitter: prefixed('twitter:'),
    verification: metas.map(m => String(m.name || '').toLowerCase()).filter(n => /verification|verify|validate|msvalidate|mailru-domain/.test(n)),
    hreflang: alternates.filter(a => a.hreflang).map(a => ({ lang: a.hreflang, href: a.href })), alternates: alternates.filter(a => !a.hreflang),
    icons, manifest: (icons.find(i => /manifest/i.test(i.rel)) || {}).href || null,
    headings, h1: headings.filter(h => h.level === 1).map(h => h.text), h1_count: headings.filter(h => h.level === 1).length,
    h1_shown: headings.filter(h => h.level === 1 && h.shown).map(h => h.text), headings_shown: headings.filter(h => h.shown).length, headings_total: headingEls.length,
    jsonld, microdata: [...new Set(q('[itemtype]').map(e => e.getAttribute('itemtype')))].slice(0, 30),
    text: { chars: bodyText.replace(/\s+/g, ' ').trim().length, words },
    images: { total: imgEls.length, shown: images.filter(i => i.shown).length, in_fold: images.filter(i => i.in_fold).length,
      no_alt_attr: images.filter(i => i.alt === null).length, empty_alt: images.filter(i => i.alt === '').length, broken: images.filter(i => i.broken).length,
      list: images },
    videos, iframes, forms, formless_fields: formlessFields, scripts, styles, hints,
    links_count: q('a[href]').length, buttons_count: q('button, [role="button"], input[type="submit" i], input[type="button" i]').length,
    // «#order» that points at a block of this page is an anchor, not a popup
    popup_triggers: q('a[href^="#popup" i], a[href^="#order" i], a[href^="#modal" i], a[href^="#form" i], [data-toggle="modal"], [data-bs-toggle="modal"], [aria-haspopup="dialog"]')
      .filter(e => e.tagName !== 'A' || e.getAttribute('data-toggle') || e.getAttribute('data-bs-toggle') || e.getAttribute('aria-haspopup') || !H.anchorTarget(e.getAttribute('href'))).length,
    comments: { total: commentsTotal, sample: comments },
    a11y_strings: a11y, stack_hints: stack,
    doc: { viewport: [innerWidth, innerHeight], visual_viewport: (() => { const v = H.vv(); return { width: Math.round(v.w), height: Math.round(v.h), scale: Math.round(v.scale * 1000) / 1000 }; })(), client_width: document.documentElement.clientWidth, dpr, height: H.docH(), scroll_width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
      nodes: document.getElementsByTagName('*').length, regions: { header: H.regions().how.header, footer: H.regions().how.footer, main: H.regions().how.main } },
    perf,
    meta_tags: metas.filter(m => !/^(og:|twitter:)/i.test(String(m.property || m.name || ''))).slice(0, 80),
  };
}

// network, console and blocked attempts recorded by lib/cdp on this load
function pageLog(page, finalUrl) {
  const resp = page.responses || [];
  const site = stripWww(hostOf(finalUrl || ''));
  const byType = {}, third = {}, protocols = {};
  const bad = [], refused = [];
  // social networks answer robots with 418 / 999 (or 403 / 429): the host refused us, the resource is not broken
  const SOCIAL = /(^|\.)(linkedin\.com|instagram\.com|facebook\.com|fbcdn\.net|x\.com|twitter\.com|tiktok\.com|vk\.com|ok\.ru|t\.me|telegram\.org|youtube\.com|pinterest\.com|threads\.net)$/i;
  for (const r of resp) {
    const t = r.type || 'Other'; byType[t] = (byType[t] || 0) + 1;
    const h = stripWww(hostOf(r.url));
    if (h && site && h !== site && !h.endsWith('.' + site)) third[h] = (third[h] || 0) + 1;
    if (r.protocol) protocols[r.protocol] = (protocols[r.protocol] || 0) + 1;
    if (r.status === 418 || r.status === 999 || (SOCIAL.test(h || '') && (r.status === 403 || r.status === 429))) refused.push({ url: String(r.url).slice(0, 300), status: r.status, type: t, host: h });
    else if (r.status >= 400) bad.push({ url: String(r.url).slice(0, 300), status: r.status, type: t });
  }
  const failed = page.failed || [];
  const ours = failed.filter(f => /BLOCKED_BY_CLIENT/.test(f.error || ''));
  const aborted = failed.filter(f => /ERR_ABORTED/.test(f.error || ''));
  const real = failed.filter(f => !/BLOCKED_BY_CLIENT|ERR_ABORTED/.test(f.error || ''));
  const blocked = {};
  for (const [k, arr] of Object.entries(page.blocked || {})) {
    if (!Array.isArray(arr) || !arr.length) continue;
    blocked[k] = { n: arr.length, sample: arr.slice(0, 25).map(x => ({ url: x.url, phase: x.phase, type: x.type, method: x.method, service: x.service || undefined })) };
  }
  // errors caused by our own blocking (counters, chats) are not the site's errors
  const blockedUrls = Object.values(page.blocked || {}).flatMap(a => Array.isArray(a) ? a.map(x => String(x.url || '').slice(0, 120)) : []).filter(u => u.length > 10);
  const fromBlock = t => /ERR_BLOCKED_BY_CLIENT/.test(t) || blockedUrls.some(u => t.includes(u));
  const cons = page.console || [], exc = page.exceptions || [];
  return {
    network: { requests: resp.length, by_type: byType, protocols, status_4xx_5xx: bad.slice(0, 40), refused_by_host: refused.slice(0, 20), failed: real.slice(0, 30).map(f => ({ url: String(f.url).slice(0, 300), error: f.error })),
      aborted: aborted.length, cut_by_revizor: ours.length,
      third_party_hosts: Object.entries(third).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([host, n]) => ({ host, n })) },
    blocked,
    console: cons.filter(c => !fromBlock(c.text || '')).slice(0, 40),
    exceptions: exc.filter(e => !fromBlock(e || '')).slice(0, 20),
    // exceptions that lib/cdp traced to our own cut requests (page.inducedExceptions) are not the site's errors
    caused_by_blocking: { console: cons.filter(c => fromBlock(c.text || '')).length, exceptions: exc.filter(e => fromBlock(e || '')).slice(0, 5),
      induced_exceptions: (page.inducedExceptions || []).length, induced_sample: (page.inducedExceptions || []).slice(0, 3).map(x => String(x).slice(0, 200)) },
    popups_closed: (page.b && page.b.popups ? page.b.popups.length : 0),
  };
}

// framework globals live in the page's own world (the isolated world does not see them); booleans only
function pageGlobals() {
  const w = window;
  return { next: !!w.__NEXT_DATA__, nuxt: !!w.__NUXT__, bx: !!w.BX, shopify: !!w.Shopify, vue: !!w.__VUE__ };
}

export async function collect(page, ctx = {}) {
  await ensureHelpers(page);
  const globals = await page.evaluate(pageGlobals).catch(() => ({}));
  const data = await ev(page, collectMetaInPage, { globals: globals || {} });
  const li = loadInfo(page, ctx);
  return { ...li, captured: nowIso(), mobile: !!ctx.mobile, world: worldOf(page), ...data, ...pageLog(page, li.final_url || ctx.url) };
}

// ---------------------------------------------------------------------------------------------
const BY_WIDTH_KEYS = ['doc', 'h1_shown', 'headings_shown', 'text', 'perf', 'mobile'];

// page.json keys written by snapshot.mjs for every load: meta never replaces them («blocked» there is the union
// over all loads, «shot_widths» lists every loaded width). «widths» is ours: the widths meta collected.
const SNAPSHOT_KEYS = ['tool', 'version', 'pid', 'url', 'template', 'why', 'loads', 'raw', 'files', 'shot_widths', 'blocked', 'blocked_counts',
  'final_url', 'status', 'antibot', 'facts', 'title', 'collector_status', 'captured'];

// selected page entry from ctx.pages (pages.json object in snapshot, a plain array in tests)
export function pageEntry(pages, pid) {
  const list = Array.isArray(pages) ? pages : Array.isArray(pages?.selected) ? pages.selected : [];
  return list.find(p => p && p.pid === pid) || null;
}

// union of two «blocked» maps { kind: { n, sample: [{ url, method, … }] } }
function mergeBlockedMaps(a, b) {
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const list = [];
    for (const it of [...(a?.[k]?.sample || []), ...(b?.[k]?.sample || [])]) {
      if (!it?.url || list.some(x => x.url === it.url && x.method === it.method)) continue;
      list.push(it);
    }
    const n = Math.max(list.length, a?.[k]?.n || 0, b?.[k]?.n || 0);
    if (n) out[k] = { n, sample: list.slice(0, 50) };
  }
  return out;
}

function suspectAlt(alt, src) {
  if (!alt) return false;
  const a = alt.trim().toLowerCase();
  const file = String(src || '').split(/[?#]/)[0].split('/').pop().toLowerCase();
  return /\.(jpe?g|png|webp|gif|svg|avif)$/i.test(a) || (file && a === file.replace(/\.[a-z0-9]+$/, '')) ||
    /^(img|image|photo|pic|picture|фото|картинка|изображение|снимок|dsc|img_|untitled|без названия)[\s_\d-]*$/i.test(a);
}

export async function finalize(all, ctx = {}) {
  if (!ctx.run) throw new Error('meta.finalize: ctx.run is required');
  const written = [], lines = [];
  const groups = groupByPid(all, ctx.pages);
  logDropped(ctx, 'meta', groups);
  for (const [pid, items] of groups) {
    const prim = primaryOf(items);
    const d = prim && prim.data ? prim.data : {};
    const base = { ...d };
    for (const k of ['mobile']) delete base[k];
    if (base.images && Array.isArray(base.images.list)) {
      base.images.suspect_alt = base.images.list.filter(i => suspectAlt(i.alt, i.src)).length;
      for (const i of base.images.list) if (suspectAlt(i.alt, i.src)) i.alt_suspect = true;
    }
    const byWidth = {};
    for (const it of items) {
      if (!it.data || it.data.error) { byWidth[it.width] = { error: it.data ? it.data.error : 'no data' }; continue; }
      const o = {};
      for (const k of BY_WIDTH_KEYS) o[k] = it.data[k];
      o.images_in_fold = it.data.images ? it.data.images.in_fold : null;
      o.console_errors = (it.data.console || []).length;
      o.exceptions = (it.data.exceptions || []).length;
      byWidth[it.width] = o;
    }
    const ws = items.filter(x => x.data && !x.data.error);
    const narrow = ws[0], wide = ws[ws.length - 1];
    let parity = null;
    if (narrow && wide && narrow !== wide) {
      const set = a => new Set((a || []).map(x => x.toLowerCase()));
      const h1n = set(narrow.data.h1_shown), h1w = set(wide.data.h1_shown);
      parity = { widths: [narrow.width, wide.width],
        title_same: narrow.data.title === wide.data.title,
        h1_same: h1n.size === h1w.size && [...h1n].every(x => h1w.has(x)),
        h1_shown: { [narrow.width]: narrow.data.h1_shown, [wide.width]: wide.data.h1_shown },
        text_chars: { [narrow.width]: narrow.data.text?.chars ?? null, [wide.width]: wide.data.text?.chars ?? null },
        text_ratio: wide.data.text?.chars ? Math.round(100 * (narrow.data.text?.chars || 0) / wide.data.text.chars) / 100 : null,
        headings_shown: { [narrow.width]: narrow.data.headings_shown, [wide.width]: wide.data.headings_shown } };
    }
    const entry = pageEntry(ctx.pages, pid);
    const patch = {
      pid, url: entry?.url ?? items.find(x => x.url)?.url ?? d.final_url ?? null,
      final_url: d.final_url ?? null, status: d.status ?? null, captured: d.captured ?? nowIso(),
      widths: items.map(x => x.width), meta_widths: items.map(x => x.width), primary_width: prim ? prim.width : null,
      ...base, by_width: byWidth, parity,
      meta_errors: items.filter(x => x.data && x.data.error).map(x => ({ width: x.width, error: x.data.error })),
    };
    const p = await updatePageJson(ctx.run, pid, prev => {
      const out = { ...patch };
      // widths collected by an earlier (resumed) call stay in by_width
      if (prev.by_width && typeof prev.by_width === 'object') {
        out.by_width = { ...prev.by_width, ...patch.by_width };
        out.widths = out.meta_widths = Object.keys(out.by_width).map(Number).sort((a, b) => a - b);
      }
      // snapshot owns these keys: keep its values, add ours only where it wrote nothing
      for (const k of SNAPSHOT_KEYS) if (prev[k] !== undefined && prev[k] !== null) out[k] = prev[k];
      out.blocked = mergeBlockedMaps(prev.blocked, patch.blocked);
      out.blocked_counts = Object.fromEntries(Object.entries(out.blocked).map(([k, v]) => [k, v.n]));
      return out;
    });
    written.push(p);
    const en = ctx.lang === 'en';
    const lcp = d.perf && d.perf.lcp ? `${d.perf.lcp.tag || '?'} ${d.perf.lcp.ms} ${en ? 'ms' : 'мс'}` : '—';
    lines.push(en
      ? `${pid}: ${d.status ?? '—'} · H1 ${d.h1_count ?? 0} · title ${d.title ? d.title.length : 0} chars · JSON-LD ${(d.jsonld || []).length} · images ${d.images?.total ?? 0} (no alt ${d.images?.no_alt_attr ?? 0}) · LCP ${lcp}`
      : `${pid}: ${d.status ?? '—'} · H1 ${d.h1_count ?? 0} · title ${d.title ? d.title.length : 0} зн. · JSON-LD ${(d.jsonld || []).length} · картинки ${d.images?.total ?? 0} (без alt ${d.images?.no_alt_attr ?? 0}) · LCP ${lcp}`);
  }
  if (ctx.log) try { ctx.log(`meta: page.json × ${written.length}`); } catch {}
  return { files: written, lines, summary: { pages: written.length } };
}
