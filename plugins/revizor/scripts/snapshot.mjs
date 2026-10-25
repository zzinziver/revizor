#!/usr/bin/env node
// Revizor — snapshot: ONE browser load per page × width (shots, page files, collectors run on every load):
// DOMContentLoaded + bounded wait for load/network quiet → fold shot as is → overlays noted → slow scroll (lazy content,
// scroll-reveal blocks are noted) → second look for late pop-ups (shot as is: <w>-fold-late.jpg) → overlays hidden,
// off-screen fixed layers hidden, fixed → absolute, sticky → relative, revealed blocks and content-visibility:auto
// forced visible → chunk shots via clip+scale (+ -full.jpg if ≤ 8000 px and more than one chunk, + frames of an inner
// scroller) → restore → raw.html (fetch), dom.html → collectors from scripts/collectors/*.mjs on the same load →
// page.json / text.md. Collectors' finalize runs once every pair is captured.
// A pair whose collectors were cut by the time budget is captured again on the next call (at most twice).
// A collector that hangs (timeout) ends that load: the remaining collectors run on a fresh load of the page.
// Fresh browser profile per width (shared cache/antibot cookies spoil the mobile pass). Light colour scheme (lib/cdp).

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as U from './lib/util.mjs';
import * as IMG from './lib/img.mjs';
import { Browser, localeOf } from './lib/cdp.mjs';

const HELP = `
snapshot.mjs — кадры, HTML и коллекторы для каждой пары «страница × ширина» → RUN/snapshot/<pid>/

  node snapshot.mjs --run "<RUN>" [--pages home,p01] [--widths 390,768,1440] [--depth lite|standard|deep]
                    [--budget-sec 480] [--no-collectors | --collectors meta,text] [--redo] [--accept-blocked]
                    [--retry-blocked] [--allow-load-posts] [--lang ru|en]

  Ширины по умолчанию: 1440, 390 (телефон: касания, DPR 2), 768; в deep ещё 1280 и 1024.
  На каждую пару: <w>-fold.jpg (первый экран как есть, с cookie-баннером), куски <w>.part-NN.jpg
  (1440 → ширина 1000 px, кусок 1600 CSS px; 390 → ширина 600 px, кусок 1800 CSS px), <w>-full.jpg (если ≤ 8000 px
  и кусков больше одного), shots/index.json, page.json, text.md, raw.html (как видит робот), dom.html (после JS).
  Перед кусками закреплённые слои (fixed/sticky) переводятся в обычный поток — на кусках они стоят на своём месте
  первого экрана; закреплённые слои за краем экрана (закрытое выдвижное меню) скрываются. Блоки, которые появляются
  при прокрутке (AOS, WOW, свои IntersectionObserver), и блоки content-visibility:auto на кусках показаны видимыми.
  Страница длиннее 25 000 CSS px снимается до этой высоты (пометка «обрезано»). Если документ — один экран, а
  содержимое прокручивается внутри блока, добавляются кадры этого блока <w>.inner-NN.jpg.
  Загрузка: DOMContentLoaded (до 45 с), потом до 15 с ждём load и тишину сети, затем медленная прокрутка.
  Cookie-баннер, «Ваш город?» и открывшиеся сами попапы снимаются как есть на первом экране, на кусках скрыты CSS
  (что скрыто — в page.json → loads.<w>.hidden_for_shots и в сводке). Попап или баннер, открывшийся позже
  первого кадра, снимается отдельным кадром <w>-fold-late.jpg (kind "fold", late: true), поле appeared_after_ms —
  «появился не позже, чем через N мс после начала загрузки». «Принять» не нажимается никогда.
  Цветовая схема — светлая (не зависит от темы компьютера), см. loads.<w>.emulated_color_scheme.
  Коллекторы (scripts/collectors/*.mjs) работают на той же загрузке; их finalize — когда сняты все пары.
  Если у страницы сменился адрес (crawl выбрал другие страницы) — её старый снимок удаляется целиком.
  Ошибки JS, которые вызвала наша страховка (обрезанные запросы), лежат отдельно: loads.<w>.induced_exceptions.
  --redo            переснять уже снятые пары выбранных страниц (старые кадры и raw.html этих ширин удаляются)
  --accept-blocked  не останавливаться, если главная или > 30 % страниц (не меньше двух) закрыты защитой
  --retry-blocked   снова попробовать пары, которые в прошлый раз были закрыты или упали
Свободный браузер ждём в пределах бюджета («жду свободный браузер»); не дождались — код 75, причина slot_wait.
Коды выхода: 0 готово · 75 частично (повторите ту же команду) · 3 сайт закрыт (антибот/401/403/недоступен) · 2 ошибка окружения · 1 сбой.
`;

const HELP_EN = `
snapshot.mjs — shots, HTML and collectors for every "page × width" pair → RUN/snapshot/<pid>/

  node snapshot.mjs --run "<RUN>" [--pages home,p01] [--widths 390,768,1440] [--depth lite|standard|deep]
                    [--budget-sec 480] [--no-collectors | --collectors meta,text] [--redo] [--accept-blocked]
                    [--retry-blocked] [--allow-load-posts] [--lang ru|en]

  Default widths: 1440, 390 (phone: touch, DPR 2), 768; deep adds 1280 and 1024.
  Per pair: <w>-fold.jpg (first screen as is, cookie banner included), parts <w>.part-NN.jpg
  (1440 → 1000 px wide, part 1600 CSS px; 390 → 600 px wide, part 1800 CSS px), <w>-full.jpg (if ≤ 8000 px
  and more than one part), shots/index.json, page.json, text.md, raw.html (as a robot sees it), dom.html (after JS).
  Before the parts, pinned layers (fixed/sticky) go back to normal flow — on the parts they stay where they are on
  the first screen; pinned layers outside the screen (a closed slide-out menu) are hidden. Scroll-reveal blocks
  (AOS, WOW, custom IntersectionObserver) and content-visibility:auto blocks are shown visible on the parts.
  A page taller than 25 000 CSS px is shot up to that height (marked "cut"). If the document is one screen and the
  content scrolls inside a block, shots of that block <w>.inner-NN.jpg are added.
  Load: DOMContentLoaded (up to 45 s), then up to 15 s for load and network quiet, then a slow scroll.
  Cookie banner, "Your city?" and self-opened pop-ups are shot as is on the first screen and hidden by CSS on the parts
  (what was hidden — page.json → loads.<w>.hidden_for_shots and the summary). A pop-up or banner that opens after
  the first shot gets its own shot <w>-fold-late.jpg (kind "fold", late: true); appeared_after_ms means
  "appeared no later than N ms after the load started". "Accept" is never clicked.
  Color scheme is light (independent of the computer theme), see loads.<w>.emulated_color_scheme.
  Collectors (scripts/collectors/*.mjs) run on the same load; their finalize runs when all pairs are shot.
  If a page's address changed (crawl selected other pages), its old snapshot is removed entirely.
  JS errors caused by our safety net (cut requests) are kept apart: loads.<w>.induced_exceptions.
  --redo            reshoot already shot pairs of the selected pages (old shots and raw.html of these widths are removed)
  --accept-blocked  do not stop when the home page or > 30 % of pages (at least two) are behind protection
  --retry-blocked   retry pairs that were blocked or failed last time
Waits for a free browser within the budget; if none — exit 75, reason slot_wait.
Exit codes: 0 done · 75 partial (repeat the same command) · 3 site closed (anti-bot/401/403/unreachable) · 2 environment error · 1 failure.
`;

const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'no-collectors', 'redo', 'accept-blocked', 'allow-load-posts', 'retry-blocked'] });
U.helpAndExit(U.langOf(args) === 'en' ? HELP_EN : HELP, args);
const lang = U.langOf(args);
const T = (ru, en) => (lang === 'en' ? en : ru);
const run = U.requireRun(args);
const budgetSec = Number(args['budget-sec']) > 0 ? Number(args['budget-sec']) : 480;
const T0 = Date.now();
const deadline = T0 + budgetSec * 1000;
const secLeft = () => (deadline - Date.now()) / 1000;

const readOpt = p => (existsSync(p) ? U.readJSON(p, null) : null);
const pagesDoc = readOpt(join(run, 'pages.json'));
if (!pagesDoc?.selected?.length) { console.error(U.msg('no_pages', lang)); process.exit(2); }
const state = readOpt(join(run, 'state.json')) || {};
const flags = state.flags || {};
const brief = readOpt(join(run, 'brief.json')) || readOpt(join(run, 'brief.input.json')) || {};
const depth = String(args.depth || flags.depth || brief.depth || 'standard');
const onlyPids = U.listArg(args.pages);
const selected = pagesDoc.selected.filter(s => !onlyPids.length || onlyPids.includes(s.pid));
const widths = (U.listArg(args.widths).map(Number).filter(n => n >= 200 && n <= 4000).length
  ? U.listArg(args.widths).map(Number).filter(n => n >= 200 && n <= 4000)
  : depth === 'deep' ? [1440, 390, 768, 1280, 1024] : [1440, 390, 768]);
const PRIMARY = widths.includes(1440) ? 1440 : Math.max(...widths);
const useCollectors = !args['no-collectors'] && args.collectors !== 'none';
const onlyCollectors = typeof args.collectors === 'string' ? U.listArg(args.collectors) : [];
const acceptBlocked = !!(args['accept-blocked']);
const allowLoadPosts = !!(args['allow-load-posts'] || flags.allow_load_posts || flags['allow-load-posts'] || flags.allowLoadPosts);
// Accept-Language: an international site is reviewed as its foreign visitor sees it (explicit market first)
const marketOf = v => String((v && typeof v === 'object' ? v.value : v) || '').toLowerCase();
// crawl's own guess counts only when it saw no Russian-market signal at all (domain, lang, Cyrillic, roubles, +7)
const detectedIntl = marketOf(pagesDoc.market) === 'intl' && !(pagesDoc.market?.scores?.ru > 0) ? 'intl' : '';
const market = marketOf(flags.market) && marketOf(flags.market) !== 'auto' ? marketOf(flags.market) : marketOf(brief.market) || detectedIntl;
const acceptLanguage = market === 'intl' ? 'en-US,en;q=0.9' : undefined;
const MAX_DOC = 25000;           // CSS px captured at most
const LOAD_WAIT_MS = 15000;      // after DOMContentLoaded: wait for load + network quiet at most this long
const FULL_MAX_PX = 8000;        // -full.jpg only up to this many image px
const LATE_LOOK_MS = 3000;       // second look for pop-ups no earlier than this after the fold shot
const JPEG_Q = 70;

function viewportFor(w) {
  const known = { 390: [844, true, 2], 360: [780, true, 2], 375: [812, true, 2], 414: [896, true, 2], 430: [932, true, 2],
    768: [1024, false, 1], 1024: [768, false, 1], 1280: [800, false, 1], 1366: [768, false, 1], 1440: [900, false, 1], 1536: [864, false, 1], 1920: [1080, false, 1] };
  const k = known[w];
  const mobile = k ? k[1] : w < 600;
  const dpr = k ? k[2] : (mobile ? 2 : 1);
  const height = k ? k[0] : (mobile ? Math.round(w * 2.16) : Math.round(w * 0.625));
  const targetW = mobile ? 600 : Math.min(w, 1000);   // image width of chunks
  const chunkCss = mobile ? 1800 : 1600;
  return { width: w, height, mobile, dpr, imgPerCss: targetW / w, clipScale: targetW / w / dpr, chunkCss };
}

// Private/local addresses: only the reviewed site itself when it is local (demo, dev server, office network).
// A public site that redirects into a private network is refused (lib/cdp, lib/util).
const isLoopback = h => h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '::1' || /^127\./.test(h);
async function allowSiteHost() {
  const h = U.hostOf(pagesDoc.site || pagesDoc.final_origin || selected[0]?.url || '');
  if (!h) return false;
  const local = isLoopback(h) || await U.resolvesPrivate(h);
  if (!local) return false;
  U.allowPrivateHost(h);
  if (isLoopback(h)) for (const a of ['localhost', '127.0.0.1', '[::1]']) U.allowPrivateHost(a);
  // the site itself is local: its own final host (redirect inside the same private network) is allowed too
  const fh = U.hostOf(pagesDoc.final_origin || '');
  if (fh && fh !== h && (isLoopback(fh) || await U.resolvesPrivate(fh))) U.allowPrivateHost(fh);
  return true;
}

// Windows: Chrome may still hold DevToolsActivePort while lib/cdp reads it (EBUSY/EPERM). That browser is already
// running and nobody owns it: close it through its own DevTools port, remove its profile, launch again.
async function closeOrphanBrowser(profileDir) {
  for (let i = 0; i < 20; i++) {
    try {
      const port = Number(readFileSync(join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
      if (port) {
        const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        await new Promise(res => {
          const ws = new WebSocket(ver.webSocketDebuggerUrl);
          const done = () => { try { ws.close(); } catch {} res(); };
          ws.onopen = () => { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); setTimeout(done, 1500); };
          ws.onerror = done;
        });
        break;
      }
    } catch { /* not ready yet */ }
    await U.sleep(250);
  }
  for (let i = 0; i < 10; i++) { try { rmSync(profileDir, { recursive: true, force: true }); break; } catch { await U.sleep(300); } }
}
async function launchBrowser(opts) {
  for (let i = 0; ; i++) {
    try { return await Browser.launch(opts); }
    catch (e) {
      const msg = String(e?.message || e);
      if (i >= 2 || !/EBUSY|EPERM|EACCES/.test(String(e?.code || '') + msg)) throw e;
      const m = msg.match(/'([^']*revizor-profile-[^'\\/]+)[\\/]DevToolsActivePort'/);
      if (m) await closeOrphanBrowser(m[1]);
      await U.sleep(500 * (i + 1));
    }
  }
}

// Machine-wide browser slot within the time budget: other Revizor checks may hold both slots.
let slotWaitSec = 0;
async function acquireSlot() {
  try { return await U.acquireBrowserSlot({ waitMs: 0 }); } catch { /* both taken — wait below */ }
  const waitSec = Math.max(0, Math.floor(secLeft() - 30));
  const t = Date.now();
  if (waitSec > 0) {
    U.progress(T(`snapshot: жду свободный браузер — заняты другими проверками Ревизора (жду до ${waitSec} с)…`,
      `snapshot: waiting for a free browser — taken by other Revizor checks (up to ${waitSec}s)…`));
    try { const r = await U.acquireBrowserSlot({ waitMs: waitSec * 1000 }); slotWaitSec += Math.round((Date.now() - t) / 1000); return r; } catch { /* timed out */ }
  }
  slotWaitSec += Math.round((Date.now() - t) / 1000);
  return null;
}

// ---------- collectors ----------
const COLL_DIR = join(dirname(fileURLToPath(import.meta.url)), 'collectors');
async function loadCollectors() {
  const list = [], errors = [];
  if (!useCollectors || !existsSync(COLL_DIR)) return { list, errors };
  for (const f of readdirSync(COLL_DIR).filter(f => f.endsWith('.mjs') && !f.startsWith('_')).sort()) {
    try {
      const m = await import(pathToFileURL(join(COLL_DIR, f)).href);
      const meta = m.meta || {};
      const name = String(meta.name || basename(f, '.mjs')).toLowerCase().replace(/[^a-z0-9-]/g, '-');
      if (onlyCollectors.length && !onlyCollectors.includes(name)) continue;
      if (typeof m.collect !== 'function' && typeof m.finalize !== 'function') { errors.push({ file: f, error: T('нет collect/finalize', 'no collect/finalize export') }); continue; }
      const ws = Array.isArray(meta.widths) ? meta.widths.map(Number) : null; // null = every width
      list.push({ name, file: f, widths: ws, order: Number.isFinite(meta.order) ? meta.order : 100, collect: m.collect, finalize: m.finalize, timeoutMs: Number(meta.timeoutMs) || 90000 });
    } catch (e) { errors.push({ file: f, error: String(e?.message || e).slice(0, 300) }); }
  }
  list.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
  return { list, errors };
}

const measureWritten = new Set();
function writeMeasure(name, obj) {
  const n = String(name).toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const doc = { ...U.measureHeader(n, run), partial: false, resume: null, ...(obj || {}) };
  U.writeJSON(U.insideRun(run, 'measure', `${n}.json`), doc);
  measureWritten.add(n);
  return doc;
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what}: timeout ${Math.round(ms / 1000)}s`)), ms).unref?.())]);

// ---------- in-page helpers (self-contained, run in the browser) ----------
const VITALS_INIT = `(() => { try {
  window.__rvVitals = { lcp: null, lcpEl: null, cls: 0, fcp: null };
  new PerformanceObserver(l => { for (const e of l.getEntries()) { window.__rvVitals.lcp = Math.round(e.startTime); const el = e.element;
    window.__rvVitals.lcpEl = el ? el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/)[0] : '') : null; } })
    .observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__rvVitals.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__rvVitals.fcp = Math.round(e.startTime); }).observe({ type: 'paint', buffered: true });
} catch (e) {} })();`;

// Fixed/sticky layers; cookie banner, "your city?" and auto-opened modals are classified.
// startIdx > 0 = second look: layers marked by the first look are skipped, new ones get indices from startIdx.
function scanLayers(startIdx) {
  startIdx = startIdx || 0;
  const vw = document.documentElement.clientWidth || innerWidth, vh = innerHeight;
  const cssPath = el => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(c => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) p += '.' + cls.join('.');
      const sib = e.parentElement ? [...e.parentElement.children].filter(c => c.tagName === e.tagName) : [];
      if (sib.length > 1) p += `:nth-of-type(${sib.indexOf(e) + 1})`;
      parts.unshift(p);
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) { parts[0] = '#' + e.id; break; }
    }
    return parts.join(' > ');
  };
  const all = document.body ? document.body.getElementsByTagName('*') : [];
  const fx = [];
  for (const el of all) { const p = getComputedStyle(el).position; if (p === 'fixed' || p === 'sticky') fx.push(el); }
  const outer = fx.filter(el => !fx.some(o => o !== el && o.contains(el)) && !el.hasAttribute('data-rv-layer'));
  const bodyText = (document.body?.innerText || '').length || 1;
  const label = b => (b.innerText || b.value || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
  const CONSENT_BTN = /^(принять|принимаю|согласен|согласна|соглашаюсь|разрешить|ok|ок|хорошо|понятно|ясно|закрыть|отклонить|отказаться|только необходимые|настроить|настройки|подробнее|accept|agree|allow|got it|i agree|reject|decline|only necessary|customi[sz]e|settings|manage|close)/i;
  const COOKIE_TEXT = /cookie|куки(?![а-яё])|кук(ам|ами|ах)(?![а-яё])|consent|gdpr|согласие на (использование|обработку) (файлов|cookie)|используем (файлы )?cookie/i;
  const out = [];
  let i = startIdx;
  for (const el of outer) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
    const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const share = visible ? Math.round(1000 * iw * ih / (vw * vh)) / 10 : 0;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const sig = [el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('role'), el.getAttribute('aria-label')].join(' ').toLowerCase();
    const btns = [...el.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')].map(label).filter(Boolean);
    const links = el.querySelectorAll('a[href]');
    // a site header or menu that mentions cookies (a bakery called "Cookie", a "Cookies" menu item) is not a banner
    const isNav = /^(header|nav)$/i.test(el.tagName) || /^(navigation|banner|menubar)$/.test(el.getAttribute('role') || '') || links.length >= 8;
    const consentBtn = btns.some(t => CONSENT_BTN.test(t));
    const policyLink = [...links].some(a => /polit|privacy|cookie|konfid|personal|policy|политик|конфиденц|персональн/i.test((a.getAttribute('href') || '') + ' ' + (a.textContent || '')));
    const cookieSig = /cookie|consent|gdpr|\bcmp\b|onetrust|cookiebot|usercentrics/.test(sig);
    let kind = null;
    if (share > 0 && !isNav && text.length < 1500 && ((COOKIE_TEXT.test(text) && (consentBtn || policyLink)) || (cookieSig && (consentBtn || text.length < 400)))) kind = 'cookie';
    else if (share > 0 && !isNav && text.length < 600 && /ваш город|выберите (ваш )?город|ваш регион|город определ|определили (ваш )?город|your (city|region|location)/i.test(text)) kind = 'city';
    else if (share >= 25 && cs.position === 'fixed' && text.length / bodyText < 0.5 && !/^(header|nav|main)$/i.test(el.tagName)
      && (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true' || /modal|popup|pop-up|overlay|lightbox|dialog|subscribe|popmechanic|t-popup|fancybox/.test(sig))) kind = 'modal';
    el.setAttribute('data-rv-layer', String(i));
    out.push({ i, selector: cssPath(el), tag: el.tagName.toLowerCase(), position: cs.position, z: cs.zIndex,
      box: [Math.round(r.left), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)], visible, share_top: share,
      edge: r.top <= 2 ? 'top' : r.bottom >= vh - 2 ? 'bottom' : 'middle', kind, text: text.slice(0, kind ? 400 : 80), buttons: kind ? btns.slice(0, 8) : undefined });
    i++;
  }
  return out;
}
function layerShares() {
  const vw = document.documentElement.clientWidth || innerWidth, vh = innerHeight; const res = {};
  for (const el of document.querySelectorAll('[data-rv-layer]')) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
    const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    res[el.getAttribute('data-rv-layer')] = visible ? Math.round(1000 * iw * ih / (vw * vh)) / 10 : 0;
  }
  return res;
}
// Hide overlays and off-screen fixed layers (display:none), force scroll-revealed blocks and content-visibility:auto
// visible, turn fixed → absolute and sticky → relative keeping their scroll-0 position. Everything is measured
// BEFORE the first change: a converted off-screen drawer would widen the document (and the mobile viewport).
function freezeLayers(hideIdx) {
  const save = el => { if (!el.hasAttribute('data-rv-style')) el.setAttribute('data-rv-style', el.hasAttribute('style') ? el.getAttribute('style') : '\u0000'); };
  const force = (el, props) => { save(el); for (const [k, v] of props) el.style.setProperty(k, v, 'important'); };
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  const vw = document.documentElement.clientWidth || innerWidth, vh = innerHeight;
  const hidden = [];
  const all = document.body ? [...document.body.getElementsByTagName('*')] : [];
  const fx = [], cvAuto = [];
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (cs.position === 'fixed' || cs.position === 'sticky') fx.push({ el, pos: cs.position, display: cs.display, vis: cs.visibility, op: Number(cs.opacity), r: el.getBoundingClientRect() });
    if (cs.contentVisibility === 'auto') cvAuto.push(el);
  }
  // scroll-revealed blocks that hid again when the page went back up (AOS once:false, WOW, own IntersectionObserver)
  let revealed = 0;
  for (const el of document.querySelectorAll('[data-rv-seen]')) {
    if (el.closest('[data-rv-layer]')) continue;
    const cs = getComputedStyle(el);
    if (Number(cs.opacity) >= 0.95 && cs.visibility !== 'hidden') continue;
    force(el, [['opacity', '1'], ['visibility', 'visible'], ['transform', 'none'], ['transition', 'none'], ['animation', 'none']]);
    revealed++;
  }
  for (const el of cvAuto) force(el, [['content-visibility', 'visible']]);
  for (const el of document.querySelectorAll('[data-rv-layer]')) {
    const i = Number(el.getAttribute('data-rv-layer'));
    if (hideIdx.includes(i)) { force(el, [['display', 'none']]); hidden.push(i); }
  }
  let fixed = 0, sticky = 0, offscreen = 0;
  for (const f of fx) {
    const { el, r } = f;
    if (f.display === 'none' || (el.hasAttribute('data-rv-style') && el.style.getPropertyValue('display') === 'none')) continue;
    if (f.pos === 'sticky') {
      force(el, [['position', 'relative'], ['top', 'auto'], ['bottom', 'auto'], ['left', 'auto'], ['right', 'auto']]);
      sticky++;
      continue;
    }
    // fixed and not on the first screen (closed drawer behind the edge, invisible layer) → not shown at all
    const out = r.width === 0 || r.height === 0 || r.right <= 0 || r.left >= vw || r.bottom <= 0 || r.top >= vh || f.vis === 'hidden' || f.op < 0.05;
    if (out) { force(el, [['display', 'none']]); offscreen++; continue; }
    force(el, [['position', 'absolute'], ['top', '0px'], ['left', '0px'], ['bottom', 'auto'], ['right', 'auto'], ['width', r.width + 'px']]);
    if (r.height >= vh - 1) el.style.setProperty('height', r.height + 'px', 'important');
    const r2 = el.getBoundingClientRect();
    el.style.setProperty('top', (r.top - r2.top) + 'px', 'important');
    el.style.setProperty('left', (r.left - r2.left) + 'px', 'important');
    fixed++;
  }
  return { hidden, fixed, sticky, offscreen, revealed, cv_auto: cvAuto.length };
}
function restoreLayers() {
  for (const el of document.querySelectorAll('[data-rv-style]')) {
    const s = el.getAttribute('data-rv-style');
    if (s === '\u0000') el.removeAttribute('style'); else el.setAttribute('style', s);
    el.removeAttribute('data-rv-style');
  }
  for (const el of document.querySelectorAll('[data-rv-layer]')) el.removeAttribute('data-rv-layer');
  for (const el of document.querySelectorAll('[data-rv-scroller]')) el.removeAttribute('data-rv-scroller');
  for (const el of document.querySelectorAll('[data-rv-seen]')) el.removeAttribute('data-rv-seen');
  try { delete window.__rvCand; } catch {}
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  return true;
}
// Slow scroll to the bottom (lazy content). Blocks that are invisible at the top (opacity ≈ 0 or visibility:hidden)
// and become visible on the way are marked data-rv-seen: scroll-reveal libraries hide them again on the way back.
// Carousels (their slides hide and show by themselves) and fixed layers are left out.
async function slowScroll(cap) {
  const step = Math.max(200, Math.round(innerHeight * 0.6));
  const H = () => Math.min(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), cap);
  const SKIP = '.swiper, .swiper-container, .slick-slider, .owl-carousel, .carousel, .splide, .glide, .flickity-enabled, .t-slds, [aria-roledescription="carousel"], [class*="slider" i], [class*="carousel" i], [data-rv-layer]';
  const cand = [];
  const all = document.body ? document.body.getElementsByTagName('*') : [];
  for (let k = 0; k < all.length && k < 40000 && cand.length < 3000; k++) {
    const el = all[k];
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.position === 'fixed' || cs.position === 'sticky') continue;
    const op = Number(cs.opacity);
    if (!(op < 0.1 || cs.visibility === 'hidden')) continue;
    // visibility is inherited: only the topmost hidden element of a subtree is a candidate
    if (op >= 0.1 && el.parentElement && getComputedStyle(el.parentElement).visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    if (el.closest(SKIP)) continue;
    cand.push(el);
  }
  window.__rvCand = cand;
  // visible now, or a running/delayed transition or animation is heading to a visible state (transition-delay,
  // slow fade-ins: a fast scroll leaves the viewport before opacity grows)
  const heading = el => {
    try {
      for (const a of el.getAnimations ? el.getAnimations() : []) {
        const kf = a.effect?.getKeyframes?.() || [];
        const last = kf[kf.length - 1];
        if (!last) continue;
        if ('opacity' in last && Number(last.opacity) >= 0.5) return true;
        if ('visibility' in last && last.visibility === 'visible') return true;
      }
    } catch {}
    return false;
  };
  const check = () => { for (const el of cand) { if (el.hasAttribute('data-rv-seen')) continue; const cs = getComputedStyle(el); if (cs.display !== 'none' && ((Number(cs.opacity) >= 0.5 && cs.visibility !== 'hidden') || heading(el))) el.setAttribute('data-rv-seen', '1'); } };
  let y = 0, guard = 0;
  while (y < H() && guard++ < 300) { y += step; window.scrollTo({ top: y, left: 0, behavior: 'instant' }); await new Promise(r => setTimeout(r, 140)); check(); }
  return { height: H(), candidates: cand.length };
}
// After the idle wait at the bottom: late transitions (delays) have finished → mark them too.
function markRevealed() {
  const cand = window.__rvCand || [];
  let n = 0;
  for (const el of cand) {
    if (!el.isConnected) continue;
    if (!el.hasAttribute('data-rv-seen')) { const cs = getComputedStyle(el); if (Number(cs.opacity) >= 0.5 && cs.visibility !== 'hidden' && cs.display !== 'none') el.setAttribute('data-rv-seen', '1'); }
    if (el.hasAttribute('data-rv-seen')) n++;
  }
  return n;
}
function docMetrics() {
  const de = document.documentElement;
  const h = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
  let inner = null;
  if (h <= innerHeight + 5) {
    for (const el of document.querySelectorAll('body *')) {
      const cs = getComputedStyle(el);
      if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 200 && el.clientHeight > innerHeight * 0.6) {
        for (const o of document.querySelectorAll('[data-rv-scroller]')) o.removeAttribute('data-rv-scroller');
        el.setAttribute('data-rv-scroller', '1');
        const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
        inner = { tag: el.tagName.toLowerCase(), id: el.id || null, selector: el.tagName.toLowerCase() + (el.id ? '#' + el.id : cls.length ? '.' + cls.join('.') : ''),
          scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
        break;
      }
    }
  }
  const ox = v => v === 'hidden' || v === 'clip';
  const clips = ox(getComputedStyle(de).overflowX) || (document.body ? ox(getComputedStyle(document.body).overflowX) : false); // page cuts overflow itself, user sees no h-scroll
  const wider = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0) > (de.clientWidth || innerWidth) + 1;
  return { height: h, width: de.scrollWidth, viewport: [innerWidth, innerHeight], overflow_x: wider && !clips, overflow_clipped: wider && clips, inner_scroll: inner };
}
function pageFacts() {
  const meta = n => document.querySelector(`meta[name="${n}" i]`)?.getAttribute('content') ?? null;
  const prop = n => document.querySelector(`meta[property="${n}" i]`)?.getAttribute('content') ?? null;
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => {
    try { const j = JSON.parse(s.textContent); const types = []; const w = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(w); if (o['@type']) types.push(...[].concat(o['@type'])); if (o['@graph']) w(o['@graph']); }; w(j); return { ok: true, types }; }
    catch (e) { return { ok: false, error: String(e.message).slice(0, 160) }; }
  });
  const host = location.host;
  let internal = 0, external = 0;
  for (const a of document.querySelectorAll('a[href]')) { try { const u = new URL(a.href); if (!/^https?:$/.test(u.protocol)) continue; if (u.host.replace(/^www\./, '') === host.replace(/^www\./, '')) internal++; else external++; } catch {} }
  const imgs = [...document.images];
  const text = clean(document.body?.innerText || '');
  return {
    title: document.title, description: meta('description'), robots: meta('robots'), viewport: meta('viewport'), generator: meta('generator'),
    canonical: document.querySelector('link[rel="canonical"]')?.href || null, lang: document.documentElement.getAttribute('lang'),
    h1: [...document.querySelectorAll('h1')].map(h => clean(h.innerText || h.textContent)).slice(0, 10),
    headings: { h2: document.querySelectorAll('h2').length, h3: document.querySelectorAll('h3').length },
    og: { title: prop('og:title'), description: prop('og:description'), image: prop('og:image'), url: prop('og:url') },
    jsonld, words: text ? text.split(' ').length : 0, text_len: text.length,
    links: { internal, external }, images: { count: imgs.length, no_alt: imgs.filter(i => !i.hasAttribute('alt')).length, lazy: imgs.filter(i => i.loading === 'lazy').length },
    forms: document.forms.length, iframes: [...document.querySelectorAll('iframe')].map(f => f.src || f.getAttribute('data-src') || '').filter(Boolean).slice(0, 20),
    scripts: document.scripts.length,
  };
}
// Visible text by blocks + collapsed content read from the DOM (no clicks). Fallback for the `text` collector.
function pageText() {
  const it = el => (el?.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const header = document.querySelector('header, [role="banner"]');
  const footers = [...document.querySelectorAll('footer, [role="contentinfo"]')];
  const footer = footers[footers.length - 1] || null;
  const main = document.querySelector('main, [role="main"]');
  const blocks = [];
  if (main) {
    if (header && !main.contains(header)) blocks.push(['header', it(header)]);
    blocks.push(['main', it(main)]);
    if (footer && !main.contains(footer)) blocks.push(['footer', it(footer)]);
  } else blocks.push(['page', it(document.body)]);
  const hidden = [];
  const seen = new Set();
  const push = (kind, label, el) => {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length < 20 || seen.has(t)) return; seen.add(t);
    hidden.push({ kind, label: (label || '').replace(/\s+/g, ' ').trim().slice(0, 120), text: t.slice(0, 4000) });
  };
  for (const d of document.querySelectorAll('details:not([open])')) {
    const sum = d.querySelector('summary');
    const clone = d.cloneNode(true); clone.querySelector('summary')?.remove();
    push('details', sum ? sum.textContent : '', clone);
  }
  for (const el of document.querySelectorAll('[role="tabpanel"], [aria-hidden="true"], [hidden], .tab-pane, [class*="accordion" i] [class*="content" i], [class*="collapse" i]')) {
    if (el.closest('nav, header, footer, script, style, template, svg')) continue;
    const cs = getComputedStyle(el);
    const shown = cs.display !== 'none' && cs.visibility !== 'hidden' && el.getBoundingClientRect().height > 2;
    if (shown) continue;
    push(el.getAttribute('role') === 'tabpanel' ? 'tab' : 'hidden', el.getAttribute('aria-label') || el.id || '', el);
    if (hidden.length >= 80) break;
  }
  return { blocks, hidden };
}

function textMarkdown(sel, load, facts, txt, w) {
  const L = lang === 'en'
    ? { url: 'URL', final: 'Final URL', code: 'Status', taken: 'Captured', width: 'width', header: 'Header', main: 'Main content', footer: 'Footer', page: 'Whole page', hidden: 'Hidden on the page (collapsed blocks, tabs — text from the DOM, no clicks)' }
    : { url: 'URL', final: 'Итоговый URL', code: 'Код', taken: 'Снято', width: 'ширина', header: 'Шапка', main: 'Основное содержимое', footer: 'Подвал', page: 'Страница целиком', hidden: 'Скрыто на странице (свёрнутые блоки, вкладки — текст по DOM, без кликов)' };
  const out = [];
  out.push(`# ${facts?.title || sel.url}`, '');
  out.push(`${L.url}: ${sel.url}`);
  if (load?.finalUrl && load.finalUrl !== sel.url) out.push(`${L.final}: ${load.finalUrl}`);
  out.push(`${L.code}: ${load?.status ?? '—'}`);
  out.push(`Title: ${facts?.title ?? '—'}`, `Description: ${facts?.description ?? '—'}`, `H1: ${(facts?.h1 || []).join(' | ') || '—'}`,
    `Canonical: ${facts?.canonical ?? '—'}`, `Robots: ${facts?.robots ?? '—'}`, `${L.taken}: ${U.nowIso()} · ${L.width} ${w}`, '');
  for (const [k, t] of txt?.blocks || []) { out.push(`## ${L[k] || k}`, '', t || '—', ''); }
  if (txt?.hidden?.length) {
    out.push(`## ${L.hidden}`, '');
    for (const h of txt.hidden) { out.push(`### ${h.kind}${h.label ? `: «${h.label}»` : ''}`, '', h.text, ''); }
  }
  return out.join('\n');
}

// Protection page: lib/util decides (status + protection server, challenge markers; a captcha widget inside an
// ordinary page with a form is not a block). A long page with a protection word somewhere in its code is a normal page.
// A short landing whose form carries a captcha widget (SmartCaptcha, reCAPTCHA) is a page, not a wall: without the
// challenge markers of protection services and with real form fields it is not a block.
const HARD_CHALLENGE = /cf-chl|challenge-platform|just a moment\.\.\.|ddos-guard|checking your browser|captcha-delivery|\/showcaptcha|servicepipe|variti|qrator/i;
const FORM_FIELDS = /<form[\s>][\s\S]*?<(textarea|select)\b|<form[\s>][\s\S]*?<input\b(?![^>]*type=["']?(hidden|submit|button|image)\b)/i;
function challengeOf(status, headers, html, textLen) {
  const ab = U.detectAntibot(status || 0, headers || {}, html || '');
  if (ab !== 'challenge' || (status || 200) >= 400) return ab;
  if (textLen > 1500) return null;
  const head = String(html || '').slice(0, 20000);
  if (!HARD_CHALLENGE.test(head) && FORM_FIELDS.test(String(html || ''))) return null;
  return ab;
}

// ---------- page.json merge ----------
// page.json "blocked" uses the same shape as the meta collector: { <kind>: { n, sample: [{ url, method, type, phase, service }] } }
// (union over all widths; reads arrays from cdp.mjs or an older {n, sample} entry).
function mergeBlocked(into, b) {
  const out = {};
  const asList = v => (Array.isArray(v) ? v : Array.isArray(v?.sample) ? v.sample : []);
  for (const k of new Set([...Object.keys(into || {}), ...Object.keys(b || {})])) {
    const list = [];
    for (const it of [...asList(into?.[k]), ...asList(b?.[k])]) {
      if (!it?.url || list.some(x => x.url === it.url && x.method === it.method)) continue;
      list.push({ url: String(it.url).slice(0, 500), method: it.method, type: it.type, phase: it.phase, ...(it.service ? { service: it.service } : {}) });
    }
    const prevN = typeof into?.[k]?.n === 'number' ? into[k].n : 0;
    if (list.length || prevN) out[k] = { n: Math.max(list.length, prevN), sample: list.slice(0, 50) };
  }
  return out;
}

// ---------- old captures: a pid that now means another URL, --redo ----------
const PID_DIR = /^(home|p\d{2,})$/;
function shotFilesOf(w) { return f => f === `${w}-fold.jpg` || f === `${w}-fold-late.jpg` || f === `${w}-full.jpg` || f.startsWith(`${w}.part-`) || f.startsWith(`${w}.inner-`); }
function clearWidths(pid, ws) {
  const dir = U.insideRun(run, 'snapshot', pid);
  const pj = readOpt(join(dir, 'page.json'));
  const loaded = Object.keys(pj?.loads || {}).map(Number);
  // every captured width is redone → start the page from scratch
  if (!loaded.length || loaded.every(w => ws.includes(w))) { rmSync(dir, { recursive: true, force: true }); return 'all'; }
  const shots = join(dir, 'shots');
  if (existsSync(shots)) for (const f of readdirSync(shots)) if (ws.some(w => shotFilesOf(w)(f))) rmSync(join(shots, f), { force: true });
  const coll = join(dir, 'collect');
  if (existsSync(coll)) for (const f of readdirSync(coll)) if (ws.some(w => f.endsWith(`-${w}.json`))) rmSync(join(coll, f), { force: true });
  const idx = join(shots, 'index.json');
  if (existsSync(idx)) U.writeJSON(idx, (U.readJSON(idx, []) || []).filter(e => !ws.includes(Number(e.width))));
  if (pj) { for (const w of ws) delete pj.loads[String(w)]; pj.shot_widths = Object.keys(pj.loads).map(Number).sort((a, b) => a - b); U.writeJSON(join(dir, 'page.json'), pj); }
  rmSync(join(dir, 'raw.html'), { force: true }); // fetched again on the first new load
  if (ws.includes(PRIMARY)) { rmSync(join(dir, 'dom.html'), { force: true }); rmSync(join(dir, 'text.md'), { force: true }); }
  return 'widths';
}

// ---------- main ----------
async function main() {
  U.cleanupStaleProfiles();
  await allowSiteHost();

  const snapIndexPath = U.insideRun(run, 'snapshot', 'snapshot.json');
  const prev = readOpt(snapIndexPath);
  const items = new Map();            // "pid@w" → item
  for (const it of prev?.items || []) items.set(`${it.pid}@${it.width}`, it);
  const cleaned = [], redone = [];
  // pages.json is the truth: folders of pids it no longer lists are leftovers of another crawl
  const allPids = new Set(pagesDoc.selected.map(s => s.pid));
  const snapRoot = U.insideRun(run, 'snapshot');
  if (existsSync(snapRoot)) for (const d of readdirSync(snapRoot)) {
    if (!PID_DIR.test(d) || allPids.has(d)) continue;
    try { if (statSync(join(snapRoot, d)).isDirectory()) { rmSync(U.insideRun(run, 'snapshot', d), { recursive: true, force: true }); cleaned.push(d); } } catch {}
  }
  for (const [k, it] of items) { const s = pagesDoc.selected.find(x => x.pid === it.pid); if (!s || s.url !== it.url) items.delete(k); }
  // a pid that now stands for another URL: its old capture (shots, raw.html, collect/) is removed entirely
  for (const s of pagesDoc.selected) {
    const dir = U.insideRun(run, 'snapshot', s.pid);
    if (!existsSync(dir)) continue;
    const pj = readOpt(join(dir, 'page.json'));
    if (pj?.url && pj.url !== s.url) { rmSync(dir, { recursive: true, force: true }); cleaned.push(s.pid); for (const k of [...items.keys()]) if (k.startsWith(s.pid + '@')) items.delete(k); }
  }
  if (args.redo) for (const s of selected) {
    if (existsSync(U.insideRun(run, 'snapshot', s.pid))) { clearWidths(s.pid, widths); redone.push(s.pid); }
    for (const w of widths) items.delete(`${s.pid}@${w}`);
  }
  if (cleaned.length) U.log(run, `snapshot: удалены старые снимки страниц, которых больше нет под этими pid: ${[...new Set(cleaned)].join(', ')}`);
  // after "PIPELINE BLOCKED" the user may have switched on a VPN: closed pages are tried again
  if (args['retry-blocked']) for (const [k, it] of items) if (it.blocked || it.error) items.delete(k);

  const { list: collectors, errors: collErrors } = await loadCollectors();
  const errors = [...(prev?.errors || []).filter(e => e.kind !== 'collector_import' && (!e.pid || items.has(`${e.pid}@${e.width}`)))];
  for (const e of collErrors) errors.push({ kind: 'collector_import', error: `${e.file}: ${e.error}` });

  const todo = [];
  for (const w of widths) for (const s of selected) if (!items.has(`${s.pid}@${w}`)) todo.push({ s, w });
  const blockedPids = new Set([...items.values()].filter(it => it.blocked).map(it => it.pid));
  const loadTimes = [];
  const incAttempts = { ...(prev?.incomplete_attempts || {}) };
  let partial = false, blockedStop = null, browser = null, release = null, curW = null, tool = null, stopReason = null;
  const popupsBefore = () => (browser ? browser.popups.length : 0);

  const closeBrowser = async () => { try { await browser?.close(); } catch {} browser = null; tool = null; curW = null; };
  const openBrowser = async (w) => {
    await closeBrowser();
    browser = await launchBrowser();
    tool = await browser.newPage({ acceptLanguage });
    curW = w;
  };

  const selPids = new Set(selected.map(s => s.pid));
  // gate: home closed, or real protection (anti-bot) on ≥ 2 pages and > 30 % of the loaded pages
  const gateOf = (all) => {
    const loaded = [...new Set(all.filter(i => !i.skipped).map(i => i.pid))];
    const gate = [...new Set(all.filter(i => i.gate).map(i => i.pid))];
    return { gate, loaded, share: loaded.length ? Math.round(100 * gate.length / loaded.length) : 0 };
  };
  const writeIndex = (finalized) => {
    const all = [...items.values()];
    // the index covers every page captured so far (an earlier call may have taken other --pages / --widths);
    // loads_* count only what this call was asked for
    const idxPids = pagesDoc.selected.map(s => s.pid).filter(p => selPids.has(p) || all.some(i => i.pid === p));
    const allWidths = [...new Set([...widths, ...all.map(i => i.width)])].sort((a, b) => a - b);
    const mine = all.filter(i => selPids.has(i.pid) && widths.includes(i.width));
    const blockedPages = [...new Set(all.filter(i => i.blocked).map(i => i.pid))];
    const g = gateOf(all);
    const doc = {
      ...U.measureHeader('snapshot', run), partial,
      resume: partial ? { done: all.map(i => `${i.pid}@${i.width}`), ...(stopReason ? { reason: stopReason, waited_sec: slotWaitSec } : {}) } : null,
      pages: idxPids, widths: allWidths, primary_width: PRIMARY, call: { pages: selected.map(s => s.pid), widths },
      emulated_color_scheme: 'light', accept_language: acceptLanguage || 'ru-RU,ru;q=0.9,en;q=0.8',
      // what the page saw as the visitor's region: navigator.language and Intl time zone (the IP of the machine is not emulated)
      locale: localeOf(acceptLanguage), timezone: /^ru(-|$)/i.test(localeOf(acceptLanguage)) ? 'Europe/Moscow' : null,
      summary: { loads_total: selected.length * widths.length, loads_done: mine.length, loads_all: all.length, shots: mine.reduce((n, i) => n + (i.shots || 0), 0), shots_all: all.reduce((n, i) => n + (i.shots || 0), 0),
        blocked_pages: blockedPages, blocked_share: idxPids.length ? Math.round(100 * blockedPages.length / idxPids.length) : 0,
        gate_pages: g.gate, gate_share: g.share,
        home_blocked: all.find(i => i.pid === 'home' && i.blocked)?.blocked || null, stopped_blocked: blockedStop,
        late_popups: [...new Set(all.filter(i => i.late_popup).map(i => i.pid))], slot_wait_sec: slotWaitSec || 0 },
      items: all.sort((a, b) => a.pid.localeCompare(b.pid) || a.width - b.width), errors,
      not_checked: blockedPages.map(pid => ({ pid, why: all.find(i => i.pid === pid && i.blocked)?.blocked })),
      collectors: collectors.map(c => ({ name: c.name, file: c.file, widths: c.widths || 'all', order: c.order, finalize: !!c.finalize })),
      measure_written: [...new Set([...(prev?.measure_written || []), ...measureWritten])],
      finalized: finalized || (todo.length ? null : prev?.finalized) || null,
      incomplete_attempts: incAttempts,
      cleaned: [...new Set(cleaned)], redone,
    };
    U.writeJSON(snapIndexPath, doc);
    return doc;
  };

  try {
    if (todo.length) {
      release = await acquireSlot();
      if (!release) { partial = true; stopReason = 'slot_wait'; }
      for (const { s, w } of release ? todo : []) {
        if (blockedStop) break;
        if (blockedPids.has(s.pid)) {
          const b = [...items.values()].find(i => i.pid === s.pid && i.blocked);
          items.set(`${s.pid}@${w}`, { pid: s.pid, url: s.url, width: w, status: null, blocked: b?.blocked, ...(b?.gate ? { gate: true } : {}), skipped: 'blocked_on_other_width', shots: 0 });
          continue;
        }
        // the first load of a call always runs when ≥ 20 s are left, so repeated calls always make progress
        const est = loadTimes.length ? Math.max(...loadTimes.slice(-5)) : 25;
        if (loadTimes.length ? secLeft() < est * 1.2 + 15 : secLeft() < 20) { partial = true; break; }
        if (curW !== w || !browser || browser.closed) {
          U.progress(T(`snapshot: ширина ${w} — новый профиль браузера`, `snapshot: width ${w} — fresh browser profile`));
          await openBrowser(w);
        }
        const t1 = Date.now();
        let item;
        try {
          item = await captureOne(browser, tool, s, w, collectors, popupsBefore());
        } catch (e) {
          const msg = String(e?.message || e);
          if (/CDP closed|Target closed|websocket|Session with given id not found/i.test(msg) && secLeft() > est + 20) {
            U.progress(T(`snapshot: браузер упал на ${s.pid}@${w}, перезапускаю…`, `snapshot: browser crashed on ${s.pid}@${w}, restarting…`));
            await openBrowser(w);
            try { item = await captureOne(browser, tool, s, w, collectors, popupsBefore()); }
            catch (e2) { item = { pid: s.pid, url: s.url, width: w, error: String(e2?.message || e2).slice(0, 300), shots: 0 }; }
          } else item = { pid: s.pid, url: s.url, width: w, error: msg.slice(0, 300), shots: 0 };
        }
        item.ms = Date.now() - t1;
        loadTimes.push(item.ms / 1000);
        if (item.budget_cut?.length) {
          const key = `${s.pid}@${w}`;
          incAttempts[key] = (incAttempts[key] || 0) + 1;
          if (incAttempts[key] < 2) {
            U.progress(T(`snapshot: ${key} — не хватило времени на коллекторы (${item.budget_cut.join(', ')}), пересниму при следующем вызове`,
              `snapshot: ${key} — out of time for collectors (${item.budget_cut.join(', ')}), will redo on the next call`));
            partial = true; writeIndex(null); break;
          }
        }
        items.set(`${s.pid}@${w}`, slim(item));
        if (item.error) errors.push({ pid: s.pid, width: w, error: item.error });
        if (item.blocked) blockedPids.add(s.pid);
        U.progress(`snapshot: ${s.pid}@${w} ${item.status ?? '—'} · ${item.shots || 0} ${T('кадров', 'shots')} · ${(item.ms / 1000).toFixed(1)} ${T('с', 's')}${item.blocked ? ' · ' + T('ЗАКРЫТО', 'BLOCKED') + ': ' + item.blocked : ''}${item.late_popup ? ' · ' + T('поздний попап', 'late pop-up') : ''}${item.error ? ' · ' + T('ошибка', 'error') + ': ' + item.error.slice(0, 120) : ''}`);
        // availability gate: home closed, or real protection on ≥ 2 pages and > 30 % of loaded pages
        if (!acceptBlocked) {
          if (s.pid === 'home' && item.blocked) blockedStop = `home: ${item.blocked}`;
          else {
            const g = gateOf([...items.values()]);
            if (g.gate.length >= 2 && g.share > 30) blockedStop = `${g.gate.length}/${g.loaded.length} ${T('страниц', 'pages')}`;
          }
        }
        writeIndex(null);
      }
    }
    const remaining = widths.flatMap(w => selected.map(s => `${s.pid}@${w}`)).filter(k => !items.has(k));
    if (remaining.length && !blockedStop) partial = true;

    // finalize collectors once every requested pair is done
    let finalized = null;
    const finBy = [];      // [{ name, lines }] — the first line of every collector goes into the summary
    if (!partial && !blockedStop && collectors.some(c => c.finalize) && (todo.length || !prev?.finalized?.complete)) {
      finalized = {};
      let finTool = null, finBrowser = null;
      const getToolPage = async () => {
        if (tool && browser && !browser.closed) return tool;
        if (!finTool) {
          if (!release) release = await acquireSlot();
          if (!release) throw new Error('slot_wait');
          finBrowser = await launchBrowser(); finTool = await finBrowser.newPage({ acceptLanguage });
        }
        return finTool;
      };
      try {
        for (const c of collectors.filter(c => c.finalize)) {
          if (secLeft() < 12) { partial = true; break; }
          const all = [];
          for (const it of items.values()) {
            const f = U.insideRun(run, 'snapshot', it.pid, 'collect', `${c.name}-${it.width}.json`);
            if (existsSync(f)) all.push({ pid: it.pid, width: it.width, url: it.url, data: U.readJSON(f, null) });
          }
          const ctxF = { run, lang, brief, pages: pagesDoc.selected, pages_doc: pagesDoc, widths, pids: selected.map(s => s.pid), util: U, img: IMG, deadline,
            log: line => U.log(run, String(line).startsWith(c.name) ? line : `${c.name}: ${line}`), writeMeasure, measureHeader: (tool, extra) => U.measureHeader(tool, run, extra), getToolPage,
            snapshotDir: pid => U.insideRun(run, 'snapshot', pid) };
          try {
            const res = await withTimeout(Promise.resolve(c.finalize(all, ctxF)), Math.max(10000, Math.min(120000, (secLeft() - 8) * 1000)), `${c.name}.finalize`);
            finalized[c.name] = 'ok';
            const ls = res && (Array.isArray(res.lines) ? res.lines : Array.isArray(res.summary) ? res.summary : null);
            if (ls) finBy.push({ name: c.name, lines: ls.filter(l => typeof l === 'string' && l.trim() && !/^\s/.test(l) && !/^(home|p\d{2,}):/.test(l)) });
          }
          catch (e) {
            if (String(e?.message) === 'slot_wait') { partial = true; stopReason = 'slot_wait'; break; }
            finalized[c.name] = 'error: ' + String(e?.message || e).slice(0, 200); errors.push({ kind: 'collector_finalize', collector: c.name, error: String(e?.message || e).slice(0, 300) });
          }
        }
      } finally { try { await finBrowser?.close(); } catch {} }
      finalized = { at: U.nowIso(), complete: !partial, ...finalized };
    }
    const doc = writeIndex(finalized);
    const errDigest = writeErrorsDigest();

    // summary
    const all = [...items.values()].filter(i => selPids.has(i.pid) && widths.includes(i.width));
    const sec = Math.round((Date.now() - T0) / 1000);
    const status = blockedStop ? T('ОСТАНОВЛЕНО: сайт закрыт', 'STOPPED: site is closed') : partial ? T('ЧАСТИЧНО', 'PARTIAL') : T('готово', 'done');
    // stdout ≤ 40 lines: the page list shrinks first; the first line of every collector and the failures always stay
    const lines = [];
    lines.push(`snapshot: ${status} · ${T('за', 'in')} ${sec} ${T('с', 's')} · ${T('пар «страница × ширина»', 'page × width pairs')} ${all.length}/${selected.length * widths.length} · ${T('кадров', 'shots')} ${all.reduce((n, i) => n + (i.shots || 0), 0)}`);
    lines.push(`${T('Ширины', 'Widths')}: ${widths.join(', ')} · ${T('страниц', 'pages')}: ${selected.length} · ${T('схема светлая', 'light scheme')}${acceptLanguage ? ' · Accept-Language: en' : ''}`);
    if (stopReason === 'slot_wait') lines.push(T(`Не дождался свободного браузера за ${slotWaitSec} с (slot_wait): оба заняты другими проверками Ревизора. Повторите ту же команду.`,
      `No free browser within ${slotWaitSec}s (slot_wait): both taken by other Revizor checks. Run the same command again.`));
    if (blockedStop) lines.push(T(`Защита/пароль: ${blockedStop}. Капчу и защиту не проходим.`, `Protection/password: ${blockedStop}. Captchas are never solved.`));
    const bl = doc.summary.blocked_pages;
    if (bl.length) lines.push(`${T('Закрыты', 'Blocked')}: ${bl.join(', ')} (${doc.summary.blocked_share} %${doc.summary.gate_pages.length ? `; ${T('защита от ботов', 'anti-bot')}: ${doc.summary.gate_pages.join(', ')}` : ''})`);
    if (doc.cleaned.length) lines.push(T(`Удалены старые снимки (адрес pid сменился или pid больше нет): ${doc.cleaned.join(', ')}`, `Old captures removed (pid now means another URL or is gone): ${doc.cleaned.join(', ')}`));
    const byPid = new Map();
    for (const it of all) { const a = byPid.get(it.pid) || []; a.push(it); byPid.set(it.pid, a); }
    const pageLines = [];
    for (const [pid, arr] of byPid) {
      const s = selected.find(x => x.pid === pid);
      const st = arr.find(i => i.width === PRIMARY)?.status ?? arr[0]?.status ?? '—';
      const h = arr.find(i => i.width === PRIMARY)?.doc_height ?? arr[0]?.doc_height;
      const flags2 = [...new Set(arr.flatMap(i => [i.blocked && `${T('закрыто', 'blocked')}: ${i.blocked}`, i.error && T('ошибка', 'error'), i.truncated && T('обрезано', 'truncated'), i.overflow_x && `${T('гориз. скролл', 'h-scroll')} @${i.width}`, i.overflow_clipped && `${T('шире экрана, обрезано страницей', 'wider than screen, cut by the page')} @${i.width}`, i.inner_shots && T('прокрутка внутри блока', 'inner scroller'), i.timed_out && T('долго грузится', 'slow load'), i.cookie && 'cookie', i.late_popup && T('поздний попап', 'late pop-up'), i.revealed && T('появление при прокрутке', 'scroll reveal'), i.collector_hung && `${T('завис коллектор', 'collector hung')} ${i.collector_hung}`]).filter(Boolean))];
      pageLines.push(`  ${pid.padEnd(4)} ${String(st).padEnd(3)} ${(s?.url || '').replace(/^https?:\/\/[^/]+/, '').slice(0, 48).padEnd(48)} ${h ? h + ' px' : ''} ${flags2.join(' · ')}`.trimEnd());
    }
    const collLines = [];
    if (collectors.length) collLines.push(`${T('Коллекторы', 'Collectors')}: ${collectors.map(c => c.name).join(', ')}${finalized ? ' · finalize ✓' : ''}`);
    else collLines.push(T('Коллекторов нет — сделан только снимок.', 'No collectors installed — snapshot only.'));
    // failed collectors: collect errors per page × width and finalize errors
    const failedColl = new Map();
    for (const it of all) for (const n of it.collectors_failed || []) { const a = failedColl.get(n) || []; a.push(`${it.pid}@${it.width}`); failedColl.set(n, a); }
    for (const [n, v] of Object.entries(finalized || {})) if (typeof v === 'string' && v.startsWith('error')) { const a = failedColl.get(n) || []; a.push('finalize'); failedColl.set(n, a); }
    if (failedColl.size) collLines.push(`${T('Коллекторы с ошибкой', 'Collectors with errors')}: ${[...failedColl].map(([n, a]) => `${n} (${a.slice(0, 4).join(', ')}${a.length > 4 ? ` +${a.length - 4}` : ''})`).join('; ')} — ${T('подробно', 'details')}: page.json → collector_status`);
    const firstOf = finBy.map(f => f.lines[0]).filter(Boolean);
    const extraOf = finBy.flatMap(f => f.lines.slice(1, 2));
    const hiddenKinds = {};
    for (const it of all) for (const h of it.hidden_for_shots || []) { const k = h.split(':')[0]; (hiddenKinds[k] ||= new Set()).add(it.pid); }
    const KIND = { cookie: T('cookie-баннер', 'cookie banner'), city: T('«Ваш город?»', '"your city?"'), modal: T('всплывающее окно', 'pop-up') };
    const head = lines.splice(0);
    if (Object.keys(hiddenKinds).length) lines.push(T('Сняты как есть на первом экране, на кусках скрыты CSS: ', 'Shot as is on the first screen, hidden by CSS on chunks: ')
      + Object.entries(hiddenKinds).map(([k, set]) => `${KIND[k] || k} (${[...set].slice(0, 6).join(', ')}${set.size > 6 ? '…' : ''})`).join('; '));
    if (doc.summary.late_popups.length) lines.push(T(`Открылось позже первого кадра (снято отдельно, <ширина>-fold-late.jpg): ${doc.summary.late_popups.join(', ')}`, `Opened after the first shot (separate frame <width>-fold-late.jpg): ${doc.summary.late_popups.join(', ')}`));
    if (collErrors.length) lines.push(`${T('Коллекторы не загрузились', 'Collectors failed to load')}: ${collErrors.map(e => e.file).join(', ')}`);
    const errN = errors.filter(e => e.pid).length;
    if (errN) lines.push(`${T('Ошибок загрузки', 'Load errors')}: ${errN} (${T('подробно в', 'see')} snapshot/snapshot.json)`);
    const es = errDigest?.summary;
    if (es && (es.exceptions || es.console_errors || es.failed || es.http_errors || es.induced_exceptions)) lines.push(T(
      `Ошибки страниц (snapshot/errors.json): JS ${es.exceptions} на ${es.pages_with_exceptions} стр. · консоль ${es.console_errors} · не загрузилось ${es.failed} · HTTP ≥ 400 ${es.http_errors}${es.induced_exceptions ? ` · от нашей страховки ${es.induced_exceptions} (не ошибки сайта)` : ''}`,
      `Page errors (snapshot/errors.json): JS ${es.exceptions} on ${es.pages_with_exceptions} pages · console ${es.console_errors} · failed ${es.failed} · HTTP ≥ 400 ${es.http_errors}${es.induced_exceptions ? ` · caused by our safety net ${es.induced_exceptions} (not site errors)` : ''}`));
    lines.push(`${T('Записано', 'Written')}: ${join(run, 'snapshot')}`);
    if (partial && !blockedStop && stopReason !== 'slot_wait') lines.push(T('Не успел за бюджет — запустите ту же команду ещё раз, продолжу с места остановки.', 'Out of budget — run the same command again to continue.'));
    const tail = lines.splice(0);
    const fixed = head.length + collLines.length + firstOf.length + tail.length;
    const room = Math.max(0, 40 - fixed);
    const extras = extraOf.slice(0, Math.max(0, Math.min(4, room - Math.min(pageLines.length, 8) - 1)));
    const pageRoom = room - extras.length;
    const shownPages = pageLines.length > pageRoom ? pageLines.slice(0, Math.max(0, pageRoom - 1)) : pageLines;
    lines.push(...head, ...shownPages);
    if (shownPages.length < pageLines.length) lines.push(T(`  …и ещё ${pageLines.length - shownPages.length} стр. (snapshot/snapshot.json)`, `  …and ${pageLines.length - shownPages.length} more (snapshot/snapshot.json)`));
    lines.push(...collLines, ...firstOf.map(l => '  ' + String(l).slice(0, 220)), ...extras.map(l => '  ' + String(l).slice(0, 220)), ...tail);
    U.printAndSaveSummary(run, 'snapshot', lines);
    U.log(run, `snapshot: ${all.length}/${selected.length * widths.length} пар, кадров ${all.reduce((n, i) => n + (i.shots || 0), 0)}, запросов браузера к сайту ${requestsToSite}${partial ? ', частично' : ''}${stopReason ? ` (${stopReason} ${slotWaitSec} с)` : ''}${blockedStop ? `, остановлено: ${blockedStop}` : ''}`);
    return blockedStop ? 3 : partial ? 75 : 0;
  } finally {
    await closeBrowser();
    release?.();
  }
}

// DOMContentLoaded (≤ 45 s), then up to LOAD_WAIT_MS for the load event and network quiet: many sites never go
// quiet (a hanging pixel, long polling) and waiting the full 45 s on every width gains nothing.
async function loadInto(page, url) {
  const tLoad = Date.now();
  const load = await page.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' });
  let complete = false;
  if (load.ok) {
    page.setPhase('load'); // same rules as during goto (client redirects allowed, --allow-load-posts honoured)
    const until = Date.now() + LOAD_WAIT_MS;
    while (Date.now() < until) {
      complete = (await page.evaluate('document.readyState').catch(() => '')) === 'complete';
      if (complete && page.inflight.size <= 1 && Date.now() - page.lastNetActivity > 800) break;
      await U.sleep(200);
    }
    page.setPhase('interact');
    load.ms = Date.now() - tLoad;
    const fin = await page.evaluate('location.href').catch(() => null);
    if (fin) load.finalUrl = fin;
  }
  load.complete = complete;
  return load;
}

let requestsToSite = 0;
const countSiteRequests = (page, s) => { const h = U.stripWww(U.hostOf(s.url)); requestsToSite += page.responses.filter(r => U.stripWww(U.hostOf(r.url)) === h).length; };

// Run collectors on a page; a collector that times out (not because of the budget) leaves the page busy:
// the ones after it are returned in `rest` and run on a fresh load.
async function runCollectors(page, list, makeCtx, s, w, isPrimary, snapDir) {
  const collected = {}, budgetCut = [], rest = [];
  let hung = null;
  for (const c of list) {
    if (hung) { rest.push(c); continue; }
    if (secLeft() < 10) { collected[c.name] = 'skipped: budget'; budgetCut.push(c.name); continue; }
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' })).catch(() => {});
    const ctx = { ...makeCtx(page), log: line => U.log(run, `${c.name} ${s.pid}@${w}: ${line}`) };
    const tmo = Math.min(c.timeoutMs, Math.max(5000, (secLeft() - 8) * 1000));
    try {
      const data = await withTimeout(Promise.resolve(c.collect(page, ctx)), tmo, `${c.name}.collect`);
      if (data !== undefined) U.writeJSON(U.insideRun(run, 'snapshot', s.pid, 'collect', `${c.name}-${w}.json`), data ?? null);
      if (c.name === 'text' && data && typeof data.markdown === 'string' && isPrimary) U.writeText(join(snapDir, 'text.md'), data.markdown);
      collected[c.name] = 'ok';
    } catch (e) {
      collected[c.name] = 'error: ' + String(e?.message || e).slice(0, 200);
      if (/timeout/i.test(String(e?.message))) { if (tmo < c.timeoutMs) budgetCut.push(c.name); else hung = c.name; }
    }
  }
  return { collected, budgetCut, rest, hung };
}

// One load of one page at one width.
async function captureOne(browser, tool, s, w, collectors, popups0) {
  const vp = viewportFor(w);
  const snapDir = U.insideRun(run, 'snapshot', s.pid);
  const shotsDir = U.ensureDir(U.insideRun(run, 'snapshot', s.pid, 'shots'));
  const isPrimary = w === PRIMARY;
  // raw HTML once per page (what a robot sees without JS)
  const rawPath = join(snapDir, 'raw.html');
  let raw = null;
  if (!existsSync(rawPath)) {
    const r = await U.politeFetch(s.url, { lang, maxBytes: 8 * 1024 * 1024, timeoutMs: 30000, ...(acceptLanguage ? { acceptLanguage } : {}) });
    requestsToSite += Math.max(1, (r.chain || []).length);
    U.writeText(rawPath, r.body || '');
    raw = { status: r.status || null, final_url: r.url, chain: r.chain || [], bytes: r.bytes || 0, error: r.error || null, skipped: r.skipped || null,
      headers: Object.fromEntries(Object.entries(r.headers || {}).filter(([k]) => ['content-type', 'server', 'x-powered-by', 'x-robots-tag', 'cache-control', 'content-language', 'link', 'last-modified', 'etag', 'vary'].includes(k))) };
  }

  const pageOpts = { blockNavigation: true, allowLoadPosts, ...(acceptLanguage ? { acceptLanguage } : {}) };
  let page = await browser.newPage(pageOpts);
  const net = new Map();
  page.on('Network.requestWillBeSent', p => { if (!net.has(p.requestId)) net.set(p.requestId, { url: p.request.url, type: p.type || null, status: null, bytes: 0 }); });
  page.on('Network.responseReceived', p => { const n = net.get(p.requestId); if (n) { n.status = p.response.status; n.mime = p.response.mimeType; n.type = p.type || n.type; } });
  page.on('Network.loadingFinished', p => { const n = net.get(p.requestId); if (n) n.bytes = p.encodedDataLength || 0; });
  const mainPage = page;
  try {
    await page.setViewport({ width: vp.width, height: vp.height, mobile: vp.mobile, deviceScaleFactor: vp.dpr });
    await page.addInitScript(VITALS_INIT);
    const tNav = Date.now();
    const load = await loadInto(page, s.url);
    const item = { pid: s.pid, url: s.url, width: w, status: load.status ?? null, final_url: load.finalUrl || null, load_ms: load.ms, timed_out: load.ok ? !load.complete : !!load.timedOut, shots: 0, emulated_color_scheme: 'light' };
    if (!load.ok) {
      item.blocked = load.refused ? `refused_${load.refused}` : /AUTH/i.test(load.error || '') ? '401' : /TIMED_OUT|timeout/i.test(load.error || '') ? 'timeout' : 'network';
      item.error = load.error || load.refused;
      await writePage(s, w, item, { raw, load, page });
      return item;
    }
    await U.sleep(600);
    const doc = page.responses.find(r => r.type === 'Document');
    const docHeaders = Object.fromEntries(Object.entries(doc?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    // Chromium's own verdict on the connection (secure / insecure / neutral) — headers.mjs compares its TLS check with it
    if (doc?.security) item.security_state = doc.security;
    if (doc?.protocol) item.protocol = doc.protocol;
    const probe = await page.evaluate(() => ({ html: document.documentElement.outerHTML.slice(0, 30000), textLen: (document.body?.innerText || '').trim().length })).catch(() => ({ html: '', textLen: 0 }));
    const ab = challengeOf(item.status, docHeaders, probe.html, probe.textLen);
    // gate = real protection; 401/403 of a login/cabinet page without protection signs only leaves the page out
    if (ab) { item.blocked = 'antibot'; item.antibot = ab; item.gate = true; }
    else if (item.status === 401) item.blocked = '401';
    else if (item.status === 403) item.blocked = '403';
    else if (!item.status && probe.textLen < 30) item.blocked = 'timeout';

    // 1. first screen as is
    const index = [];
    const foldFile = `${w}-fold.jpg`;
    await page.screenshot({ path: join(shotsDir, foldFile), format: 'jpeg', quality: JPEG_Q });
    const foldAt = Date.now();
    const fs0 = IMG.imageSize(join(shotsDir, foldFile));
    index.push({ file: foldFile, width: w, y0: 0, y1: vp.height, scale: vp.dpr, kind: 'fold', img_w: fs0?.w, img_h: fs0?.h });
    item.vitals = await page.evaluate(() => window.__rvVitals || null).catch(() => null);
    if (item.blocked) {
      item.shots = 1;
      U.writeJSON(join(shotsDir, `index.json`), mergeIndex(join(shotsDir, 'index.json'), w, index));
      countSiteRequests(page, s);
      await writePage(s, w, item, { raw, load, net, page });
      return item;
    }

    // 2. layers at the top (cookie banner, city, modals, sticky), slow scroll (lazy content, scroll reveal), shares
    const layers = await page.evaluate(scanLayers, 0).catch(() => []);
    const sc = await page.evaluate(slowScroll, MAX_DOC).catch(() => null);
    const idleUntil = Date.now() + 5000;
    while (Date.now() < idleUntil && !(page.inflight.size <= 1 && Date.now() - page.lastNetActivity > 700)) await U.sleep(100);
    const seenN = await page.evaluate(markRevealed).catch(() => 0);
    // measured before anything is frozen: a converted off-screen layer must not count as horizontal scroll
    const metrics1 = await page.evaluate(docMetrics).catch(() => ({ height: sc?.height || vp.height }));
    await page.evaluate((y) => window.scrollTo({ top: y, left: 0, behavior: 'instant' }), Math.max(0, Math.round(metrics1.height / 2 - vp.height / 2))).catch(() => {});
    await U.sleep(350);
    const mid = await page.evaluate(layerShares).catch(() => ({}));
    for (const l of layers) l.share_mid = mid[String(l.i)] ?? null;
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' })).catch(() => {});
    await U.sleep(400);
    await page.evaluate(() => Promise.race([Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; }))), new Promise(r => setTimeout(r, 3000))])).catch(() => {});

    // 2b. second look: cookie banners of async consent platforms and "subscribe" pop-ups open seconds after load
    const wait = LATE_LOOK_MS - (Date.now() - foldAt);
    if (wait > 0) await U.sleep(wait);
    const lateAll = await page.evaluate(scanLayers, layers.length ? Math.max(...layers.map(l => l.i)) + 1 : 0).catch(() => []);
    const late = lateAll.filter(l => l.kind);
    if (late.length) {
      const after = Date.now() - tNav;
      for (const l of late) { l.late = true; l.appeared_after_ms = after; l.share_mid = null; }
      if (late.some(l => l.visible && l.share_top > 0)) {
        const lateFile = `${w}-fold-late.jpg`;
        await page.screenshot({ path: join(shotsDir, lateFile), format: 'jpeg', quality: JPEG_Q });
        const ls = IMG.imageSize(join(shotsDir, lateFile));
        index.push({ file: lateFile, width: w, y0: 0, y1: vp.height, scale: vp.dpr, kind: 'fold', late: true, img_w: ls?.w, img_h: ls?.h });
      }
      layers.push(...late);
      item.late_popup = true;
    }

    // 3. hide overlays, freeze fixed/sticky, show revealed blocks, capture chunks
    const hideIdx = layers.filter(l => l.kind).map(l => l.i);
    const frozen = await page.evaluate(freezeLayers, hideIdx).catch(e => ({ error: e.message, hidden: [], fixed: 0, sticky: 0, offscreen: 0, revealed: 0, cv_auto: 0 }));
    const metrics = await page.evaluate(docMetrics).catch(() => metrics1);
    const fullH = Math.max(vp.height, Math.min(metrics.height || vp.height, MAX_DOC));
    item.doc_height = metrics.height; item.truncated = (metrics.height || 0) > MAX_DOC; item.overflow_x = !!metrics1.overflow_x; item.overflow_clipped = !!metrics1.overflow_clipped;
    if (metrics.inner_scroll) item.inner_scroll = metrics.inner_scroll;
    for (const f of readdirSync(shotsDir)) if (f.startsWith(`${w}.part-`) || f.startsWith(`${w}.inner-`) || f === `${w}-full.jpg`) rmSync(join(shotsDir, f), { force: true });
    if (!late.length) rmSync(join(shotsDir, `${w}-fold-late.jpg`), { force: true });
    let k = 0;
    // chunk plan; a short tail (< 30 % of a chunk) joins the previous chunk while it stays ≤ 4000 image px
    const plan = [];
    for (let y = 0; y < fullH; y += vp.chunkCss) plan.push([y, Math.min(vp.chunkCss, fullH - y)]);
    if (plan.length > 1) {
      const [, hl] = plan[plan.length - 1], prevC = plan[plan.length - 2];
      if (hl < vp.chunkCss * 0.3 && (prevC[1] + hl) * vp.imgPerCss <= 4000) { prevC[1] += hl; plan.pop(); }
    }
    for (const [y, h] of plan) {
      const file = `${w}.part-${String(++k).padStart(2, '0')}.jpg`;
      await page.screenshot({ path: join(shotsDir, file), format: 'jpeg', quality: JPEG_Q, clip: { x: 0, y, width: vp.width, height: h, scale: vp.clipScale } });
      const sz = IMG.imageSize(join(shotsDir, file));
      index.push({ file, width: w, y0: y, y1: y + h, scale: Math.round(vp.imgPerCss * 10000) / 10000, kind: 'part', img_w: sz?.w, img_h: sz?.h });
    }
    // one chunk = the whole page already: no duplicate -full.jpg
    if (plan.length > 1 && fullH * vp.imgPerCss <= FULL_MAX_PX) {
      const file = `${w}-full.jpg`;
      await page.screenshot({ path: join(shotsDir, file), format: 'jpeg', quality: JPEG_Q, clip: { x: 0, y: 0, width: vp.width, height: fullH, scale: vp.clipScale } });
      const sz = IMG.imageSize(join(shotsDir, file));
      index.push({ file, width: w, y0: 0, y1: fullH, scale: Math.round(vp.imgPerCss * 10000) / 10000, kind: 'full', img_w: sz?.w, img_h: sz?.h });
    }
    // app-like layout: the document is one screen and the content scrolls inside an element → screen-sized frames of
    // that element (kind "inner"; y0/y1 are the element's scrollTop, not document coordinates)
    if (metrics.inner_scroll) {
      const isc = await page.evaluate(() => { const el = document.querySelector('[data-rv-scroller]'); return el ? { h: el.scrollHeight, ch: el.clientHeight } : null; }).catch(() => null);
      if (isc && isc.ch > 0) {
        const step = Math.max(200, Math.round(isc.ch * 0.9));
        let n = 0, last = -1;
        for (let top = 0; top < isc.h && n < 12; top += step) {
          // the element clamps scrollTop at the bottom: record where it really is
          const at = await page.evaluate(t => { const el = document.querySelector('[data-rv-scroller]'); if (!el) return null; el.scrollTo({ top: t, left: 0, behavior: 'instant' }); return Math.round(el.scrollTop); }, top).catch(() => null);
          if (at === null || at <= last) break;
          last = at;
          await U.sleep(350);
          const file = `${w}.inner-${String(++n).padStart(2, '0')}.jpg`;
          // the visible screen at the chunk image width (600 / 1000 px)
          await page.screenshot({ path: join(shotsDir, file), format: 'jpeg', quality: JPEG_Q, clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale: vp.clipScale } });
          const sz = IMG.imageSize(join(shotsDir, file));
          index.push({ file, width: w, y0: at, y1: Math.min(at + isc.ch, isc.h), scale: Math.round(vp.imgPerCss * 10000) / 10000, kind: 'inner', scroller: metrics.inner_scroll.selector, img_w: sz?.w, img_h: sz?.h });
          if (at + isc.ch >= isc.h) break;
        }
        await page.evaluate(() => { const el = document.querySelector('[data-rv-scroller]'); if (el) el.scrollTo({ top: 0, left: 0, behavior: 'instant' }); }).catch(() => {});
        item.inner_shots = n;
      }
    }
    await page.evaluate(restoreLayers).catch(() => {});
    item.shots = index.length;
    U.writeJSON(join(shotsDir, 'index.json'), mergeIndex(join(shotsDir, 'index.json'), w, index));
    item.layers = layers.map(l => ({ selector: l.selector, tag: l.tag, position: l.position, edge: l.edge, box: l.box, share_top: l.share_top, share_mid: l.share_mid, kind: l.kind, text: l.text, buttons: l.buttons, ...(l.late ? { late: true, appeared_after_ms: l.appeared_after_ms } : {}) }));
    item.hidden_for_shots = layers.filter(l => l.kind).map(l => ({ kind: l.kind, selector: l.selector, text: l.text.slice(0, 160), ...(l.late ? { late: true, appeared_after_ms: l.appeared_after_ms } : {}) }));
    item.frozen = { fixed: frozen.fixed, sticky: frozen.sticky, offscreen_hidden: frozen.offscreen || 0, revealed: frozen.revealed || 0, content_visibility_auto: frozen.cv_auto || 0 };
    if (frozen.revealed) item.revealed = frozen.revealed;
    item.reveal_candidates = sc?.candidates ?? null; item.reveal_seen = seenN || 0;
    const cookie = layers.find(l => l.kind === 'cookie');
    item.cookie = cookie ? { selector: cookie.selector, text: cookie.text, buttons: cookie.buttons, box: cookie.box, share: cookie.share_top, ...(cookie.late ? { late: true } : {}) } : null;

    // 4. dom.html, facts, text (primary width)
    const facts = await page.evaluate(pageFacts).catch(e => ({ error: e.message }));
    item.facts = facts;
    if (isPrimary) {
      const html = await page.evaluate(() => (document.doctype ? new XMLSerializer().serializeToString(document.doctype) + '\n' : '') + document.documentElement.outerHTML).catch(() => '');
      U.writeText(join(snapDir, 'dom.html'), html);
    }

    // 5. collectors on this very load
    const loadStart = Date.now();
    const cache = new Map();
    const makeCtx = (pg) => ({ run, pid: s.pid, url: s.url, width: w, mobile: vp.mobile, lang, brief, pages: pagesDoc.selected, pages_doc: pagesDoc, page_entry: s, deadline,
      viewport: { width: vp.width, height: vp.height, dpr: vp.dpr, mobile: vp.mobile }, shotsDir, dir: snapDir, measureDir: U.insideRun(run, 'measure'),
      toolPage: tool, cache, util: U, img: IMG, layers: item.layers, blocked: pg.blocked,
      load: { status: item.status, finalUrl: item.final_url, ms: item.load_ms, timedOut: item.timed_out },
      writeMeasure, measureHeader: (t, extra) => U.measureHeader(t, run, extra),
      writeFile: (rel, content) => { const p = U.insideRun(snapDir, rel); typeof content === 'string' ? U.writeText(p, content) : U.writeJSON(p, content); return p; },
      hideOverlays: () => pg.evaluate((sels) => { for (const sel of sels) for (const el of document.querySelectorAll(sel)) { if (!el.hasAttribute('data-rv-style')) el.setAttribute('data-rv-style', el.hasAttribute('style') ? el.getAttribute('style') : '\u0000'); el.style.setProperty('display', 'none', 'important'); } return sels.length; }, item.hidden_for_shots.map(h => h.selector)),
      restoreOverlays: () => pg.evaluate(restoreLayers) });
    const mine = collectors.filter(c => c.collect && (!c.widths || c.widths.includes(w)));
    const r1 = await runCollectors(page, mine, makeCtx, s, w, isPrimary, snapDir);
    const collected = { ...r1.collected };
    const budgetCut = [...r1.budgetCut];
    if (!r1.hung) await page.evaluate(restoreLayers).catch(() => {});
    if (r1.rest.length) {
      // the page is busy with a hung script: close it, the rest runs on a fresh load (no new shots)
      U.progress(T(`snapshot: ${s.pid}@${w} — коллектор ${r1.hung} завис, остальные (${r1.rest.map(c => c.name).join(', ')}) — на новой загрузке`,
        `snapshot: ${s.pid}@${w} — collector ${r1.hung} hung, the rest (${r1.rest.map(c => c.name).join(', ')}) run on a fresh load`));
      item.collector_hung = r1.hung;
      countSiteRequests(page, s);
      await page.close();
      if (secLeft() < 40) { for (const c of r1.rest) { collected[c.name] = 'skipped: budget'; budgetCut.push(c.name); } }
      else {
        const p2 = await browser.newPage(pageOpts);
        try {
          await p2.setViewport({ width: vp.width, height: vp.height, mobile: vp.mobile, deviceScaleFactor: vp.dpr });
          const l2 = await loadInto(p2, s.url);
          if (!l2.ok) for (const c of r1.rest) collected[c.name] = 'error: ' + T('повторная загрузка не удалась', 'reload failed');
          else {
            await U.sleep(400);
            await p2.evaluate(slowScroll, MAX_DOC).catch(() => null);
            await p2.evaluate(restoreLayers).catch(() => {});
            await U.sleep(300);
            const r2 = await runCollectors(p2, r1.rest, makeCtx, s, w, isPrimary, snapDir);
            Object.assign(collected, r2.collected); budgetCut.push(...r2.budgetCut);
            for (const c of r2.rest) collected[c.name] = 'skipped: ' + T(`страница зависла на ${r2.hung}`, `page hung on ${r2.hung}`);
            item.collectors_reloaded = r1.rest.map(c => c.name);
          }
          countSiteRequests(p2, s);
        } finally { await p2.close(); }
      }
    } else countSiteRequests(page, s);
    if (budgetCut.length) item.budget_cut = budgetCut;
    item.collectors = collected;
    if (isPrimary) {
      const tp = join(snapDir, 'text.md');
      const fresh = existsSync(tp) && statSync(tp).mtimeMs >= loadStart - 1;
      if (!fresh) {
        const txt = r1.hung ? null : await page.evaluate(pageText).catch(() => null);
        U.writeText(tp, textMarkdown(s, { status: item.status, finalUrl: item.final_url }, facts, txt, w));
      }
    }
    item.popups = Math.max(0, browser.popups.length - popups0);
    await writePage(s, w, item, { raw, load, net, page: mainPage });
    return item;
  } finally {
    await mainPage.close();
  }
}

// short record of one load for snapshot/snapshot.json (the full record lives in page.json → loads.<width>)
function slim(it) {
  const o = {};
  for (const k of ['pid', 'url', 'width', 'status', 'final_url', 'blocked', 'gate', 'antibot', 'error', 'skipped', 'shots', 'ms', 'doc_height', 'truncated', 'overflow_x', 'overflow_clipped', 'timed_out', 'inner_shots', 'late_popup', 'revealed', 'collector_hung']) if (it[k] !== undefined && it[k] !== null && it[k] !== false) o[k] = it[k];
  if (it.cookie) o.cookie = true;
  if (it.hidden_for_shots?.length) o.hidden_for_shots = it.hidden_for_shots.map(h => `${h.kind}: ${h.selector}${h.late ? ' (late)' : ''}`).slice(0, 6);
  if (it.collectors) o.collectors_failed = Object.entries(it.collectors).filter(([, v]) => v !== 'ok').map(([k]) => k);
  return o;
}

const KIND_ORDER = { fold: 0, full: 1, part: 2, inner: 3 };
function mergeIndex(path, w, entries) {
  const old = existsSync(path) ? U.readJSON(path, []) : [];
  return [...(Array.isArray(old) ? old : []).filter(e => e.width !== w), ...entries].sort((a, b) => a.width - b.width || (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || (a.late ? 1 : 0) - (b.late ? 1 : 0) || a.y0 - b.y0 || String(a.file).localeCompare(String(b.file)));
}

// snapshot/errors.json — compact digest for the stability/perf/security lenses (page.json of a real site is hundreds of KB):
// per page, unique entries with the widths where they were seen, capped. Site errors and errors provoked by our
// safety net (cut POST/beacon → "Failed to fetch") are kept apart.
function writeErrorsDigest() {
  const CAP = { exceptions: 10, console: 10, failed: 15, http: 15, induced: 3 };
  const pages = [];
  const sum = { pages: 0, pages_with_exceptions: 0, exceptions: 0, induced_exceptions: 0, console_errors: 0, console_warnings: 0, failed: 0, http_errors: 0 };
  const add = (map, key, w, mk) => { const e = map.get(key) || mk(); if (!e.widths.includes(w)) e.widths.push(w); map.set(key, e); };
  for (const s of pagesDoc.selected) {
    const pj = readOpt(U.insideRun(run, 'snapshot', s.pid, 'page.json'));
    if (!pj?.loads) continue;
    const exc = new Map(), ind = new Map(), con = new Map(), fail = new Map(), http = new Map();
    let warnings = 0;
    for (const [ws, ld] of Object.entries(pj.loads)) {
      const w = Number(ws);
      for (const x of ld.exceptions || []) { const t = String(x).split('\n')[0].slice(0, 300); add(exc, t, w, () => ({ text: t, widths: [] })); }
      for (const x of ld.induced_exceptions || []) { const t = String(x).split('\n')[0].slice(0, 200); add(ind, t, w, () => ({ text: t, widths: [] })); }
      for (const c of ld.console || []) {
        if (c.type === 'warning') { warnings++; continue; }
        const t = String(c.text || '').slice(0, 300); add(con, c.type + '|' + t, w, () => ({ type: c.type, text: t, widths: [] }));
      }
      for (const f of ld.failed || []) { const u = String(f.url || '').slice(0, 300); add(fail, u + '|' + f.error, w, () => ({ url: u, error: f.error || null, widths: [] })); }
      for (const e of ld.net?.errors || []) { const u = String(e.url || '').slice(0, 300); add(http, u, w, () => ({ url: u, status: e.status, type: e.type || null, widths: [] })); }
    }
    const counts = { exceptions: exc.size, induced_exceptions: ind.size, console_errors: con.size, console_warnings: warnings, failed: fail.size, http_errors: http.size };
    sum.pages++; if (exc.size) sum.pages_with_exceptions++;
    sum.exceptions += exc.size; sum.induced_exceptions += ind.size; sum.console_errors += con.size; sum.console_warnings += warnings; sum.failed += fail.size; sum.http_errors += http.size;
    pages.push({ pid: s.pid, url: s.url, status: pj.status ?? null, widths: pj.shot_widths || [], counts,
      exceptions: [...exc.values()].slice(0, CAP.exceptions), console: [...con.values()].slice(0, CAP.console),
      failed: [...fail.values()].slice(0, CAP.failed), http_errors: [...http.values()].slice(0, CAP.http),
      induced_exceptions: { n: ind.size, sample: [...ind.values()].slice(0, CAP.induced) } });
  }
  const doc = { ...U.measureHeader('snapshot-errors', run), partial: false, resume: null,
    note: 'exceptions/console/failed/http_errors — ошибки сайта; induced_exceptions — вызваны страховкой Ревизора (обрезанные запросы), не ошибки сайта. Полные данные — snapshot/<pid>/page.json → loads.<ширина>.',
    pages: pages.map(p => p.pid), summary: sum, items: pages };
  try { U.writeJSON(U.insideRun(run, 'snapshot', 'errors.json'), doc); } catch { return null; }
  return doc;
}

// page.json is shared with collectors (meta, links write their keys in finalize under the same lock file).
// Snapshot keys: loads.<width> (everything about one load), widths (array), blocked, blocked_counts, raw, files,
// facts (short page facts, fallback when there is no meta collector), antibot, collector_status, status, final_url, title.
// Identity (pid, url, template, why) always comes from pages.json, never from an older page.json.
async function writePage(s, w, item, ctx) {
  const p = U.insideRun(run, 'snapshot', s.pid, 'page.json');
  await U.withFileLock(p + '.lock', async () => writePageLocked(p, s, w, item, ctx));
}
function writePageLocked(p, s, w, item, { raw, net, page }) {
  const cur = existsSync(p) ? U.readJSON(p, {}) : {};
  const sameUrl = !cur.url || cur.url === s.url;
  const doc = { tool: 'snapshot', version: U.VERSION, ...(sameUrl ? cur : {}), pid: s.pid, url: s.url, template: s.template || null, why: s.why || null };
  doc.loads = doc.loads && typeof doc.loads === 'object' && !Array.isArray(doc.loads) ? doc.loads : {};
  // network summary of this load
  let netSum = null;
  if (net) {
    const all = [...net.values()];
    const host = U.hostOf(s.url).replace(/^www\./, '');
    const byType = {};
    const third = new Map();
    let bytes = 0;
    for (const n of all) {
      bytes += n.bytes || 0;
      const t = n.type || 'Other'; (byType[t] ||= { n: 0, bytes: 0 }); byType[t].n++; byType[t].bytes += n.bytes || 0;
      const h = U.hostOf(n.url).replace(/^www\./, '');
      if (h && h !== host && !h.endsWith('.' + host)) third.set(h, (third.get(h) || 0) + (n.bytes || 0));
    }
    netSum = { requests: all.length, bytes, by_type: byType,
      errors: all.filter(n => n.status >= 400).map(n => ({ url: n.url.slice(0, 300), status: n.status, type: n.type })).slice(0, 40),
      third_party: [...third].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([h, b]) => ({ host: h, bytes: b })) };
  }
  const blockedUrls = new Set(Object.values(page?.blocked || {}).flat().map(b => b.url));
  doc.loads[String(w)] = {
    ...item,
    // ERR_BLOCKED_BY_CLIENT comes from our own interception (counters, widgets) — not a site error
    console: page ? page.console.filter(c => !/ERR_BLOCKED_BY_CLIENT/.test(c.text)).slice(0, 50) : [],
    console_blocked_by_revizor: page ? page.console.filter(c => /ERR_BLOCKED_BY_CLIENT/.test(c.text)).length : 0,
    // site errors only; errors provoked by our cut requests ("Failed to fetch" after a blocked POST) are kept apart
    exceptions: page ? page.exceptions.slice(0, 30) : [],
    induced_exceptions: page ? (page.inducedExceptions || []).slice(0, 30) : [],
    failed: page ? page.failed.filter(f => !blockedUrls.has(String(f.url).slice(0, 500))).slice(0, 50) : [],
    net: netSum,
  };
  if (raw) doc.raw = raw;
  doc.files = { raw: 'raw.html', dom: existsSync(U.insideRun(run, 'snapshot', s.pid, 'dom.html')) ? 'dom.html' : null, text: existsSync(U.insideRun(run, 'snapshot', s.pid, 'text.md')) ? 'text.md' : null, shots: 'shots/index.json' };
  doc.shot_widths = Object.keys(doc.loads).map(Number).sort((a, b) => a - b);
  if (!Array.isArray(doc.widths)) doc.widths = doc.shot_widths; // meta.finalize replaces it with the widths it collected
  doc.blocked = mergeBlocked(doc.blocked || {}, page?.blocked);
  doc.blocked_counts = Object.fromEntries(Object.entries(doc.blocked).map(([k, v]) => [k, v.n]));
  const prim = doc.loads[String(PRIMARY)] || Object.values(doc.loads)[0];
  doc.final_url = prim?.final_url ?? doc.final_url ?? null;
  doc.status = prim?.status ?? doc.status ?? null;
  doc.antibot = Object.values(doc.loads).map(x => x.blocked).find(Boolean) || null;
  if (prim?.facts && !prim.facts.error) { doc.facts = prim.facts; doc.title = prim.facts.title ?? doc.title ?? null; }
  doc.emulated_color_scheme = 'light';
  doc.collector_status = Object.fromEntries(Object.entries(doc.loads).flatMap(([ww, x]) => Object.entries(x.collectors || {}).map(([n, st]) => [`${n}@${ww}`, st])));
  doc.captured = U.nowIso();
  U.writeJSON(p, doc);
}

main().then(code => process.exit(code || 0)).catch(e => {
  console.error(T('snapshot: сбой — ', 'snapshot: failure — ') + (e?.stack || e));
  try { U.log(run, `snapshot: сбой ${String(e?.message || e).slice(0, 200)}`); } catch {}
  process.exit(/браузер|browser|Chromium|Node\.js 22/i.test(String(e?.message)) ? 2 : 1);
});
