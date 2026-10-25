#!/usr/bin/env node
// Revizor — crawl: robots, sitemaps, menus (2 levels), templates, stack, market, beta signals,
// page selection → RUN/pages.json (fields: the "result" object near the end of this file).
// HTML is parsed in the browser (DOMParser in a blank tab); regexps only for robots and sitemaps.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import * as U from './lib/util.mjs';
import { Browser } from './lib/cdp.mjs';

const HELP = `
crawl.mjs — карта сайта и выбор страниц для снимка → RUN/pages.json

  node crawl.mjs --run "<RUN>" [--url https://example.ru] [--pages 20] [--page /contacts --page /prices]
                 [--pages-from "<старый pages.json>"] [--depth lite|standard|deep] [--mode full|quick|rivals|recheck]
                 [--budget-sec 480] [--lang ru|en]

  --url         адрес сайта; без него берётся из brief.input.json / brief.json / state.json
  --pages N     сколько страниц выбрать (lite 3 · standard 4: главная + услуга или цены, контакты или запись, первый пункт меню · deep 30; quick 3)
  --page P      взять ровно эти страницы (путь или адрес; можно несколько раз или через запятую). Главная
                входит, только если указана сама (--page /). Адреса другого сайта отбрасываются.
  --pages-from  взять страницы и их pid из прошлого pages.json (recheck, --resume)
  --market ru|intl  язык запросов (Accept-Language): intl — английский; по умолчанию из state/брифа, иначе русский
  --budget-sec  бюджет времени; не успел — частичный pages.json и код 75, повторный вызов продолжит с места
                остановки (главная, robots, sitemap, меню и проверенные страницы берутся из RUN/.cache/crawl.json)

Обход вежливый: только GET, robots.txt соблюдается (кроме случая «Disallow: /» — это признак беты),
опасные адреса (/logout, /cart/add, ?action=…) не открываются, ≤ 2 запроса к хосту, пауза 350+ мс.
Адреса во внутренней сети открываются, только если сам --url внутренний (демо, локальный сервер).
Повторный crawl в том же RUN сохраняет pid за теми же адресами.
Браузер ждём в пределах бюджета («жду свободный браузер»); не дождались — код 75, причина slot_wait.
Коды выхода: 0 готово · 75 частично · 2 ошибка аргументов/окружения · 1 сбой.
`;

const HELP_EN = `
crawl.mjs — site map and page selection for the snapshot → RUN/pages.json

  node crawl.mjs --run "<RUN>" [--url https://example.com] [--pages 20] [--page /contacts --page /prices]
                 [--pages-from "<old pages.json>"] [--depth lite|standard|deep] [--mode full|quick|rivals|recheck]
                 [--budget-sec 480] [--lang ru|en]

  --url         site address; without it, taken from brief.input.json / brief.json / state.json
  --pages N     how many pages to select (lite 3 · standard 4: home + service or prices, contacts or booking, first menu item · deep 30; quick 3)
  --page P      take exactly these pages (path or address; repeat or comma-separate). The home page is
                included only when named (--page /). Addresses of another site are dropped.
  --pages-from  take pages and their pids from an earlier pages.json (recheck, --resume)
  --market ru|intl  request language (Accept-Language): intl = English; default from state/brief, else Russian
  --budget-sec  time budget; out of time — partial pages.json and exit 75, the next call resumes where it
                stopped (home, robots, sitemap, menus and checked pages come from RUN/.cache/crawl.json)

Polite crawl: GET only, robots.txt is respected (except "Disallow: /" — a beta signal),
risky addresses (/logout, /cart/add, ?action=…) are not opened, ≤ 2 requests per host, 350+ ms pause.
Private-network addresses are opened only when --url itself is private (demo, local server).
A repeated crawl in the same RUN keeps the same pids for the same addresses.
Waits for a free browser within the budget; if none — exit 75, reason slot_wait.
Exit codes: 0 done · 75 partial · 2 arguments/environment error · 1 failure.
`;

const args = U.parseArgs(process.argv.slice(2), { boolean: ['help'], multi: ['page'] });
U.helpAndExit(U.langOf(args) === 'en' ? HELP_EN : HELP, args);
const lang = U.langOf(args);
const T = (ru, en) => (lang === 'en' ? en : ru);
const run = U.requireRun(args);
const budgetSec = Number(args['budget-sec']) > 0 ? Number(args['budget-sec']) : 480;
const T0 = Date.now();
const deadline = T0 + budgetSec * 1000;
const secLeft = () => (deadline - Date.now()) / 1000;
const done = [];        // finished steps, for "resume"
let requests = 0;       // requests to the reviewed site (for log.md)

// ---------- inputs ----------
const readOpt = p => (existsSync(p) ? U.readJSON(p, null) : null);
const briefIn = readOpt(join(run, 'brief.input.json')) || readOpt(join(run, 'brief.json')) || {};
const state = readOpt(join(run, 'state.json')) || {};
const flags = state.flags || {};
const mode = String(args.mode || state.mode || briefIn.mode || 'full');
const depth = String(args.depth || flags.depth || briefIn.depth || 'standard');
let input = args.url && args.url !== true ? args.url : (briefIn.url || flags.url || state.url || readOpt(join(run, 'pages.json'))?.site);
if (!input) { console.error(U.msg('need_url', lang)); process.exit(2); }
try { input = U.normalizeUrl(input); } catch { console.error(T('Не разобрал адрес: ', 'Bad URL: ') + input); process.exit(2); }
const defaultPages = mode === 'quick' ? 3 : ({ lite: 3, standard: 4, deep: 30 }[depth] || 4);
const pagesArg = Number(args.pages) > 0 ? Number(args.pages) : (Number(flags.pages) > 0 ? Number(flags.pages) : defaultPages);
const maxPages = Math.max(1, Math.min(200, Math.floor(pagesArg)));
const explicitPages = U.listArg(args.page).concat(args.page ? [] : U.listArg(flags.page));
const pagesFrom = args['pages-from'] && args['pages-from'] !== true ? String(args['pages-from']) : null;
const marketOf = v => String((v && typeof v === 'object' ? v.value : v) || '').toLowerCase();
const marketFlag = [args.market, flags.market, briefIn.market].map(marketOf).find(v => v && v !== 'auto' && v !== 'true') || null;
// Accept-Language of every request: an international site is crawled as its foreign visitor sees it
const acceptLanguage = marketFlag === 'intl' ? 'en-US,en;q=0.9' : undefined;

// Private/local addresses: only when the reviewed site itself (--url) is local (demo, dev server, office network).
// A public site redirecting into a private network, a --page or --pages-from on another host are refused.
const isLoopback = h => h === 'localhost' || h.endsWith('.localhost') || h === '[::1]' || h === '::1' || /^127\./.test(h);
let inputIsLocal = false;
async function allowInputHost(url) {
  const h = U.hostOf(url);
  if (!h) return false;
  inputIsLocal = isLoopback(h) || await U.resolvesPrivate(h);
  if (!inputIsLocal) return false;
  U.allowPrivateHost(h);
  if (isLoopback(h)) for (const a of ['localhost', '127.0.0.1', '[::1]']) U.allowPrivateHost(a);
  return true;
}
// the local site redirected to another host of the same private network (e.g. a dev server alias)
async function allowRedirectHost(url) {
  if (!inputIsLocal) return;
  const h = U.hostOf(url);
  if (h && (isLoopback(h) || await U.resolvesPrivate(h))) U.allowPrivateHost(h);
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
// DOMContentLoaded (≤ 45 s), then ≤ 12 s for the load event and network quiet (some sites never go quiet).
async function loadPage(pg, url) {
  const t0 = Date.now();
  const r = await pg.goto(url, { timeout: 45000, waitUntil: 'domcontentloaded' });
  if (!r.ok) return r;
  pg.setPhase('load');
  const until = Date.now() + 12000;
  let complete = false;
  while (Date.now() < until) {
    complete = (await pg.evaluate('document.readyState').catch(() => '')) === 'complete';
    if (complete && pg.inflight.size <= 1 && Date.now() - pg.lastNetActivity > 800) break;
    await U.sleep(200);
  }
  pg.setPhase('interact');
  const fin = await pg.evaluate('location.href').catch(() => null);
  return { ...r, ms: Date.now() - t0, timedOut: !complete, finalUrl: fin || r.finalUrl };
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

// ---------- URL helpers ----------
const TRACK = /^(utm_[a-z_]+|yclid|ysclid|gclid|fbclid|_openstat|openstat|from|ref|etext|_ga|_gl|mc_[a-z]+|cm_id|clid|roistat[a-z_]*|rs|referrer)$/i;
const FILE_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|zip|rar|7z|gz|docx?|xlsx?|pptx?|odt|rtf|mp4|mp3|avi|mov|webm|m4a|wav|xml|txt|json|csv|css|js|mjs|woff2?|ttf|eot|otf|apk|exe|dmg|msi)$/i;
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|odt|rtf)$/i;
const LANG_CODES = new Set(['en', 'ru', 'de', 'fr', 'es', 'it', 'pt', 'uk', 'ua', 'be', 'by', 'kk', 'kz', 'zh', 'cn', 'ja', 'ko', 'tr', 'ar', 'he', 'pl', 'cs', 'nl', 'fi', 'sv', 'no', 'da', 'et', 'lv', 'lt', 'ka', 'hy', 'az', 'uz', 'ky', 'tg', 'mn', 'vi', 'th', 'id', 'ms', 'hi', 'fa', 'ro', 'bg', 'sr', 'hr', 'sl', 'sk', 'hu', 'el']);

function canon(u, base) {
  try {
    const x = new URL(u, base);
    if (!/^https?:$/.test(x.protocol)) return null;
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (TRACK.test(k)) x.searchParams.delete(k);
    return x.toString();
  } catch { return null; }
}
let siteKey = '';     // host[:port] without www — what counts as "this site"
const keyOf = u => { try { return U.stripWww(new URL(u).host.toLowerCase()); } catch { return ''; } };
const isSame = u => keyOf(u) === siteKey;
const pathOf = u => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
const isPagination = u => { try { const x = new URL(u); return /\/page\/\d+\/?$/i.test(x.pathname) || [...x.searchParams.keys()].some(k => /^(page|p|pagen_\d+|paged|start|offset)$/i.test(k)); } catch { return false; } };

function templateOf(u) {
  let x; try { x = new URL(u); } catch { return 'other'; }
  let segs = x.pathname.split('/').filter(Boolean);
  const q = [...x.searchParams.keys()].length ? '?' : '';
  if (isPagination(u)) return 'pagination';
  let prefix = '';
  if (segs.length && /^[a-z]{2}(-[a-z]{2})?$/i.test(segs[0]) && LANG_CODES.has(segs[0].slice(0, 2).toLowerCase())) {
    prefix = '/' + segs[0].toLowerCase();
    segs = segs.slice(1);
  }
  if (!segs.length) return (prefix ? prefix + '/' : 'home') + q;
  const itemLike = s => /\d{3,}/.test(s) || (s.match(/[-_]/g) || []).length >= 3 || s.length > 40;
  if (segs.length === 1) return prefix + '/' + (itemLike(segs[0]) ? '*' : segs[0].toLowerCase().replace(/\.(html?|php|aspx?)$/, '')) + q;
  return prefix + '/' + segs[0].toLowerCase() + '/*'.repeat(segs.length - 1) + q;
}

// Protection page: lib/util.detectAntibot decides (protection server + 403/429/503, challenge markers; a captcha widget
// inside an ordinary page with a form is not a block). A long page with a protection word in its code is a normal page.
// A short landing whose form carries a captcha widget is a page, not a wall (no protection-service markers + form fields).
const HARD_CHALLENGE = /cf-chl|challenge-platform|just a moment\.\.\.|ddos-guard|checking your browser|captcha-delivery|\/showcaptcha|servicepipe|variti|qrator/i;
const FORM_FIELDS = /<form[\s>][\s\S]*?<(textarea|select)\b|<form[\s>][\s\S]*?<input\b(?![^>]*type=["']?(hidden|submit|button|image)\b)/i;
function antibotOf(status, headers, body, textLen) {
  if (!status) return null;
  const ab = U.detectAntibot(status, headers || {}, body || '');
  if (ab !== 'challenge' || status >= 400) return ab;
  if ((textLen ?? 0) > 1500) return null;
  if (!HARD_CHALLENGE.test(String(body || '').slice(0, 20000)) && FORM_FIELDS.test(String(body || ''))) return null;
  return ab;
}

// ---------- fetch helpers ----------
async function get(url, opts = {}) {
  const r = await U.politeFetch(url, { lang, ...(acceptLanguage ? { acceptLanguage } : {}), ...opts });
  requests += r.skipped ? 0 : Math.max(1, (r.chain || []).length);
  return r;
}

// Sitemaps with a resumable queue (kept in the cache, so a repeated call continues where it stopped).
// Handles index files and .gz: one polite request (util.politeFetch binary), decompressed here with a ceiling.
async function crawlSitemaps(st, { limitFiles = 30, limitUrls = 50000 } = {}) {
  const { queue, urls, files } = st; const seen = new Set(st.seen || []);
  let stopped = false;
  while (queue.length && files.length < limitFiles && urls.length < limitUrls) {
    if (secLeft() < 40) { stopped = true; break; }
    const sm = queue.shift();
    if (seen.has(sm)) continue; seen.add(sm); st.seen = [...seen];
    if (!isSame(sm)) { files.push({ url: sm, status: null, count: 0, error: 'other_host' }); continue; }
    const r = await get(sm, { accept: 'application/xml,text/xml,*/*', maxBytes: 50 * 1024 * 1024, timeoutMs: 25000, binary: true });
    let text = r.body || '';
    const gz = (r.buf && r.buf.length > 2 && r.buf[0] === 0x1f && r.buf[1] === 0x8b) || (/\.gz($|\?)/i.test(sm) && !/<(urlset|sitemapindex)/i.test(text.slice(0, 2000)));
    if (r.ok && gz && r.buf) {
      try { text = gunzipSync(r.buf, { maxOutputLength: 50 * 1024 * 1024 }).toString('utf8'); }
      catch { text = ''; r.error = r.error || T('gzip: не распаковался или больше 50 МБ', 'gzip: failed to decompress or over 50 MB'); }
    }
    const rec = { url: sm, status: r.status, count: 0, error: r.error || undefined, index: false };
    if (r.ok && text) {
      rec.index = /<sitemapindex/i.test(text);
      const locs = [...text.matchAll(/<(?:sitemap|url)>([\s\S]*?)<\/(?:sitemap|url)>/gi)].map(m => {
        const loc = (m[1].match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i) || [])[1];
        const lastmod = (m[1].match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i) || [])[1];
        return loc ? { loc: U.decodeXml(loc.replace(/^<!\[CDATA\[|\]\]>$/g, '').trim()), lastmod: lastmod?.trim() } : null;
      }).filter(Boolean);
      rec.count = locs.length;
      if (rec.index) for (const l of locs) queue.push(l.loc);
      else for (const l of locs) if (urls.length < limitUrls) urls.push(l);
    }
    files.push(rec);
  }
  st.seen = [...seen];
  st.stopped = stopped; st.pending = queue.length;
  return st;
}

// ---------- in-page extractors (run inside the browser) ----------
function extractRendered() {
  const abs = h => { try { const u = new URL(h, document.baseURI); u.hash = ''; return u.toString(); } catch { return null; } };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const topOf = el => el.getBoundingClientRect().top + scrollY;
  const countLinks = el => el.querySelectorAll('a[href]').length;
  let header = [...document.querySelectorAll('header, [role="banner"]')].find(el => countLinks(el) >= 2 && topOf(el) < 400);
  if (!header) header = [...document.querySelectorAll('nav, [class*="menu" i], [class*="header" i], [id*="header" i], [class*="nav" i]')]
    .find(el => countLinks(el) >= 3 && topOf(el) < 220 && el.getBoundingClientRect().height < innerHeight);
  const footers = [...document.querySelectorAll('footer, [role="contentinfo"], [class*="footer" i], [id*="footer" i]')].filter(el => countLinks(el) >= 1 && !(header && header.contains(el)));
  const footer = footers.length ? footers.reduce((a, b) => (topOf(b) > topOf(a) ? b : a)) : null;
  const levelOf = (a, root) => { let n = 0; for (let e = a.parentElement; e && e !== root; e = e.parentElement) if (e.tagName === 'LI') n++; return Math.max(1, n); };
  const listOf = root => {
    if (!root) return [];
    const out = []; const seen = new Set();
    for (const a of root.querySelectorAll('a[href]')) {
      const href = abs(a.getAttribute('href')); if (!href) continue;
      const text = clean(a.innerText || a.textContent || a.getAttribute('aria-label') || a.title);
      const k = href + '|' + text; if (seen.has(k)) continue; seen.add(k);
      out.push({ text, href, level: levelOf(a, root), hidden: !vis(a) });
      if (out.length >= 300) break;
    }
    return out;
  };
  const areaOf = a => (header && header.contains(a) ? 'header' : footer && footer.contains(a) ? 'footer' : a.closest('nav') ? 'nav' : a.closest('main, [role="main"]') ? 'main' : 'other');
  const links = [];
  for (const a of [...document.querySelectorAll('a[href]')].slice(0, 4000)) {
    const href = abs(a.getAttribute('href')); if (!href) continue;
    links.push({ href, text: clean(a.innerText || a.textContent || a.getAttribute('aria-label') || a.title), area: areaOf(a) });
  }
  const meta = n => document.querySelector(`meta[name="${n}" i]`)?.getAttribute('content') || null;
  const jsonld = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { const j = JSON.parse(s.textContent); const walk = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(walk); if (o['@type']) jsonld.push(...[].concat(o['@type'])); if (o['@graph']) walk(o['@graph']); }; walk(j); } catch { jsonld.push('!parse_error'); }
  }
  const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim();
  return {
    finalUrl: location.href, title: document.title, lang: document.documentElement.getAttribute('lang'),
    robots: meta('robots'), generator: meta('generator'),
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    hreflang: [...document.querySelectorAll('link[rel="alternate"][hreflang]')].map(l => ({ lang: l.getAttribute('hreflang'), href: l.href })),
    header: listOf(header), footer: listOf(footer), links, jsonld,
    textLen: text.length, text: text.slice(0, 8000),
    html: document.documentElement.outerHTML.slice(0, 30000), // for the protection check only
    store: !!document.querySelector('.t-store, [data-record-type="706"], .t706, a[href*="/tproduct/"]'),
    globals: { next: !!window.__NEXT_DATA__ || !!document.getElementById('__next'), nuxt: !!window.__NUXT__ || !!window.$nuxt, gatsby: !!document.getElementById('___gatsby'),
      wp: !!window.wp || !!document.querySelector('link[href*="/wp-content/"],script[src*="/wp-includes/"]'), bx: !!window.BX, shopify: !!window.Shopify,
      tilda: !!document.querySelector('[data-tilda-page-id], .t-records, #allrecords'), wf: !!document.querySelector('[data-wf-site]'), react: !!document.querySelector('[data-reactroot], #root > *'),
      vue: !!document.querySelector('[data-v-app], [data-server-rendered]'), angular: !!document.querySelector('[ng-version]') },
    hasPassword: !!document.querySelector('input[type="password"]'),
  };
}

// Burger at 390 without clicks: toggle button + the menu it controls (or a hidden menu container).
function extractBurger() {
  const abs = h => { try { const u = new URL(h, document.baseURI); u.hash = ''; return u.toString(); } catch { return null; } };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const onScreen = el => { const r = el.getBoundingClientRect(); return vis(el) && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight; };
  const sig = el => [el.getAttribute('aria-label'), typeof el.className === 'string' ? el.className : el.getAttribute('class'), el.id, el.getAttribute('title'), el.getAttribute('data-target'), el.getAttribute('data-bs-target'), (el.innerText || '').slice(0, 30)].join(' ').toLowerCase();
  const RE = /burger|hamburger|menu|меню|nav-?toggle|navbar-toggler|toggle-?nav|☰|≡|offcanvas|mobile-?nav|drawer/;
  const toggles = [...document.querySelectorAll('button, [role="button"], a, div, span, label, svg')].filter(el => {
    if (!onScreen(el)) return false;
    const r = el.getBoundingClientRect();
    if (r.top > 220 || r.width > 140 || r.height > 140) return false;
    return RE.test(sig(el));
  });
  toggles.sort((a, b) => (b.hasAttribute('aria-controls') - a.hasAttribute('aria-controls')) || ((b.tagName === 'BUTTON') - (a.tagName === 'BUTTON')));
  const toggle = toggles[0] || null;
  const listOf = root => { const out = []; const seen = new Set(); for (const a of root.querySelectorAll('a[href]')) { const href = abs(a.getAttribute('href')); if (!href) continue; const text = clean(a.textContent || a.getAttribute('aria-label')); const k = href + '|' + text; if (seen.has(k)) continue; seen.add(k); out.push({ text, href }); if (out.length >= 200) break; } return out; };
  let root = null, source = 'none';
  if (toggle) {
    const id = toggle.getAttribute('aria-controls') || (toggle.getAttribute('data-target') || toggle.getAttribute('data-bs-target') || '').replace(/^#/, '');
    if (id) { const t = document.getElementById(id); if (t && t.querySelectorAll('a[href]').length) { root = t; source = 'aria-controls'; } }
  }
  if (!root) {
    const cands = [...document.querySelectorAll('nav, [class*="burger" i], [class*="mobile" i][class*="menu" i], [class*="offcanvas" i], [class*="drawer" i], [id*="mobile" i], [class*="menu" i], [class*="t450" i], [class*="t280" i]')]
      .filter(el => el.querySelectorAll('a[href]').length >= 3 && !onScreen(el));
    cands.sort((a, b) => b.querySelectorAll('a[href]').length - a.querySelectorAll('a[href]').length);
    if (cands[0]) { root = cands[0]; source = 'hidden-container'; }
  }
  const b = toggle ? toggle.getBoundingClientRect() : null;
  return {
    toggle: toggle ? { tag: toggle.tagName.toLowerCase(), label: clean(toggle.getAttribute('aria-label') || toggle.innerText || toggle.getAttribute('title')), box: [Math.round(b.left), Math.round(b.top + scrollY), Math.round(b.width), Math.round(b.height)], aria_controls: toggle.getAttribute('aria-controls') } : null,
    source, links: root ? listOf(root) : [],
  };
}

// DOMParser in a blank tab: raw HTML → fields. Parsed documents never run scripts or load resources.
function parseRaw(html, base) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  let b = base;
  try { const be = d.querySelector('base[href]'); if (be) b = new URL(be.getAttribute('href'), base).toString(); } catch {}
  const abs = h => { try { const u = new URL(h, b); u.hash = ''; return u.toString(); } catch { return null; } };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
  const meta = n => d.querySelector(`meta[name="${n}" i]`)?.getAttribute('content') || null;
  const sig = new Set();
  const walk = (el, depth) => {
    if (depth > 3) return;
    for (const c of el.children) {
      const tag = c.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template', 'svg', 'link', 'meta'].includes(tag)) continue;
      const cls = (c.getAttribute('class') || '').split(/\s+/).filter(Boolean)[0] || '';
      sig.add(depth + ':' + tag + '.' + cls.replace(/\d+/g, '#'));
      walk(c, depth + 1);
    }
  };
  if (d.body) walk(d.body, 0);
  const area = a => (a.closest('header, [role="banner"]') ? 'header' : a.closest('footer, [role="contentinfo"]') ? 'footer' : a.closest('nav') ? 'nav' : 'main');
  const links = [...d.querySelectorAll('a[href]')].slice(0, 4000).map(a => ({ href: abs(a.getAttribute('href')), text: clean(a.textContent || a.getAttribute('aria-label')), area: area(a) })).filter(l => l.href);
  const jsonld = [];
  for (const s of d.querySelectorAll('script[type="application/ld+json"]')) {
    try { const j = JSON.parse(s.textContent); const w = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(w); if (o['@type']) jsonld.push(...[].concat(o['@type'])); if (o['@graph']) w(o['@graph']); }; w(j); } catch { jsonld.push('!parse_error'); }
  }
  for (const s of d.querySelectorAll('script, style, noscript, template')) s.remove();
  const text = (d.body?.textContent || '').replace(/\s+/g, ' ').trim();
  return {
    title: clean(d.title), h1: [...d.querySelectorAll('h1')].map(h => clean(h.textContent)).slice(0, 5),
    robots: meta('robots'), generator: meta('generator'), lang: d.documentElement.getAttribute('lang'),
    canonical: (() => { const c = d.querySelector('link[rel="canonical"]'); return c ? abs(c.getAttribute('href')) : null; })(),
    hreflang: [...d.querySelectorAll('link[rel="alternate"][hreflang]')].map(l => ({ lang: l.getAttribute('hreflang'), href: abs(l.getAttribute('href')) })),
    links, jsonld, sig: [...sig].sort(), textLen: text.length, text: text.slice(0, 4000),
  };
}

// ---------- classification ----------
const KEY_RULES = [
  ['contacts', /kontakt|contact|svyaz|kak-proehat|where|контакт|связ|как (до)?ехать|адрес/i],
  ['prices', /(^|[\/_-])(ceny|cena|price|prices|pricing|tarif|tariffs|tarify|stoimost|prajs|prais|price-list)([\/_.-]|$)|цен[аыу]|тариф|стоимост|прайс/i],
  ['services', /uslug|services?([\/_.-]|$)|catalog|katalog|shop([\/_.-]|$)|magazin|products?([\/_.-]|$)|napravlen|kursy|courses|programs?([\/_.-]|$)|услуг|каталог|магазин|направлени|курсы|программ/i],
  ['about', /o-nas|o_nas|onas|o-kompanii|about|company|kompaniya|o-studii|o-shkole|team|komanda|о нас|о компании|о студии|о школе|кто мы|команда/i],
  ['policy', /politik|privacy|policy|konfiden|personal|soglasie|oferta|offer|terms|cookie|политик|конфиденц|персональн|оферт|соглашени|условия/i],
  ['cart', /(^|[\/_-])(cart|basket|korzina)([\/_.-]|$)|корзин/i],
  ['login', /(^|[\/_-])(login|signin|sign-in|auth|lk|account|cabinet|kabinet|profile)([\/_.-]|$)|вход|войти|личный кабинет/i],
  ['delivery', /dostavk|oplat|delivery|shipping|payment|vozvrat|доставк|оплат|возврат/i],
  ['faq', /(^|[\/_-])faq([\/_.-]|$)|voprosy|вопрос/i],
];
// booking a visit (for the few-pages default: «contacts or booking»)
const BOOKING_RE = /(^|[/_-])(zapis|booking|book|signup|sign-up|reserv|bron)([/_.-]|$)|запис|бронир/i;
const KEY_LABEL = { contacts: 'контакты', prices: 'цены', services: 'услуги/каталог', product: 'карточка', article: 'статья', about: 'о компании', policy: 'политика', cart: 'корзина', login: 'вход', delivery: 'доставка/оплата', faq: 'вопросы', input: 'адрес из команды', lang: 'языковая версия' };
const KEY_LABEL_EN = { contacts: 'contacts', prices: 'prices', services: 'services/catalog', product: 'product card', article: 'article', about: 'about', policy: 'policy', cart: 'cart', login: 'login', delivery: 'delivery/payment', faq: 'FAQ', input: 'URL from the command', lang: 'language version' };
const PRODUCT_ROOT = /^\/(catalog|katalog|product|products|shop|tovar|tovary|goods|item|items|p|magazin|store)$/i;
const ARTICLE_ROOT = /^\/(blog|news|novosti|stati|statyi|articles?|journal|zhurnal|media|press|posts?|insights|poleznoe|sovety|guides?)$/i;

function detectStack(rawHtml, headers, rendered, resourceUrls) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join('; ') : String(v)]));
  const hay = (rawHtml || '').slice(0, 400000) + '\n' + (resourceUrls || []).join('\n');
  const RULES = [
    ['Tilda', /tildacdn\.com|\.tilda\.ws|data-tilda-|tildastat|id="allrecords"/i],
    ['WordPress', /\/wp-content\/|\/wp-includes\/|\/wp-json\//i],
    ['Bitrix', /\/bitrix\/(js|templates|cache|components|tools)\/|BX\.setJSList|bx-core/i],
    ['Webflow', /data-wf-site|webflow\.(js|css)|website-files\.com|\.webflow\.io/i],
    ['Wix', /static\.wixstatic\.com|static\.parastorage\.com|\.wixsite\.com/i],
    ['Next.js', /__NEXT_DATA__|\/_next\/static\//i],
    ['Nuxt', /__NUXT__|\/_nuxt\//i],
    ['Shopify', /cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i],
    ['InSales', /insales\.ru|insales-cdn|InSales\./i],
    ['Readymag', /readymag\.(com|website)|rm-static/i],
    ['Taplink', /taplink\.(cc|ru|at)/i],
    ['Craftum', /craftum\.(com|io|ru)/i],
    ['Joomla', /\/media\/jui\/|\/components\/com_|Joomla!/i],
    ['Drupal', /Drupal\.settings|\/sites\/default\/files\/|drupal\.js/i],
    ['MODX', /assets\/components\/|MODX/],
    ['OpenCart', /catalog\/view\/theme|route=common\/home|index\.php\?route=product/i],
    ['Webasyst', /\/wa-apps\/|\/wa-content\/|\/wa-data\/public\//i],
    ['Ecwid', /app\.ecwid\.com|ecwid\.com\/script\.js|Ecwid\.OnAPILoaded/i],
    ['Flexbe', /flexbe\.(com|ru|cloud)|data-flexbe|flexbe-/i],
    ['Nethouse', /nethouse\.(ru|me)|nethouse-/i],
    ['uKit', /(?:^|[^a-z0-9])ukit\.(com|me|ru)\b|ukit-static|static\.ukit/i],
    ['LPgenerator', /lpgenerator\.(ru|com)|lpg-cdn|lpgenerator-/i],
    ['ГосВеб', /gosweb\.gosuslugi\.ru|gosweb-/i],
    ['Squarespace', /static1\.squarespace\.com|squarespace\.com/i],
    ['Framer', /framerusercontent\.com|framer\.com\/m\//i],
    ['Gatsby', /id="___gatsby"/i],
    ['Astro', /<astro-island|astro-[a-z0-9]{8}/i],
  ];
  const signals = []; const score = new Map();
  const add = (name, why, w = 1) => { score.set(name, (score.get(name) || 0) + w); signals.push(`${name}: ${why}`); };
  for (const [name, re] of RULES) { const m = hay.match(re); if (m) add(name, m[0].slice(0, 60), 2); }
  const gen = rendered?.generator || '';
  let version = null;
  if (gen) {
    signals.push(`generator: ${gen.slice(0, 80)}`);
    const g = gen.toLowerCase();
    const map = [['wordpress', 'WordPress'], ['tilda', 'Tilda'], ['bitrix', 'Bitrix'], ['webflow', 'Webflow'], ['wix', 'Wix'], ['joomla', 'Joomla'], ['drupal', 'Drupal'], ['shopify', 'Shopify'], ['ghost', 'Ghost'], ['hugo', 'Hugo'], ['jekyll', 'Jekyll'], ['astro', 'Astro'], ['framer', 'Framer'], ['modx', 'MODX'], ['next.js', 'Next.js'], ['gatsby', 'Gatsby'], ['docusaurus', 'Docusaurus'], ['squarespace', 'Squarespace'], ['insales', 'InSales'], ['readymag', 'Readymag'], ['craftum', 'Craftum']];
    for (const [k, name] of map) if (g.includes(k)) { add(name, 'meta generator', 3); const v = gen.match(/(\d+(?:\.\d+){0,3})/); if (v) version = v[1]; }
  }
  const xp = h['x-powered-by'] || '';
  if (/next\.js/i.test(xp)) add('Next.js', 'x-powered-by', 3);
  if (/bitrix/i.test(h['x-powered-cms'] || '')) add('Bitrix', 'x-powered-cms', 3);
  if (h['x-drupal-cache'] || /drupal/i.test(h['x-generator'] || '')) add('Drupal', 'заголовок', 3);
  if (h['x-shopify-stage'] || h['x-shopid']) add('Shopify', 'заголовок', 3);
  if (h['x-wix-request-id']) add('Wix', 'x-wix-request-id', 3);
  if (h['x-tilda-server'] || /tilda/i.test(h.server || '')) add('Tilda', 'заголовок', 3);
  const g = rendered?.globals || {};
  if (g.next) add('Next.js', '__NEXT_DATA__/#__next', 2);
  if (g.nuxt) add('Nuxt', '__NUXT__', 2);
  if (g.gatsby) add('Gatsby', '#___gatsby', 2);
  if (g.bx) add('Bitrix', 'window.BX', 2);
  if (g.shopify) add('Shopify', 'window.Shopify', 2);
  if (g.tilda) add('Tilda', '#allrecords', 2);
  if (g.wf) add('Webflow', 'data-wf-site', 2);
  if (g.wp) add('WordPress', 'wp-content/wp-includes', 1);
  let cms = null; let best = 0;
  for (const [k, v] of score) if (v > best) { best = v; cms = k; }
  if (!cms) {
    if (g.react && (rendered?.textLen || 0) > 0 && /<div id="(root|app)">\s*<\/div>/i.test(rawHtml || '')) { cms = 'React SPA'; signals.push('React SPA: пустой #root в исходном HTML'); }
    else if (g.vue) { cms = 'Vue SPA'; signals.push('Vue: data-v-app'); }
    else if (g.angular) { cms = 'Angular'; signals.push('Angular: ng-version'); }
  }
  // shop of a site builder: the platform stays the builder, the shop is a separate mark
  let store = null;
  if (cms === 'Tilda' && (rendered?.store || /t-store|t706|\/tproduct\//i.test(hay))) { store = 'Tilda Store'; signals.push('Tilda Store: блоки магазина (t-store / t706 / /tproduct/)'); }
  if (cms !== 'Ecwid' && /app\.ecwid\.com/i.test(hay)) { store = 'Ecwid'; signals.push('Ecwid: виджет магазина'); }
  // CDN / protection
  let cdn = null;
  const server = h.server || null;
  const cdnRules = [
    ['Cloudflare', () => /cloudflare/i.test(server || '') || h['cf-ray']], ['DDoS-Guard', () => /ddos-guard/i.test(server || '')],
    ['Qrator', () => /qrator/i.test(server || '') || h['x-qrator-request-id']], ['StormWall', () => /stormwall/i.test(server || '')],
    ['Variti', () => /variti/i.test(server || '')], ['ServicePipe', () => /servicepipe/i.test(server || '')],
    ['CloudFront', () => h['x-amz-cf-id']], ['Fastly', () => h['x-fastly-request-id'] || /fastly/i.test(h['x-served-by'] || '')],
    ['Akamai', () => Object.keys(h).some(k => k.startsWith('x-akamai')) || /akamai/i.test(server || '')],
    ['Vercel', () => h['x-vercel-id'] || /vercel/i.test(server || '')], ['Netlify', () => h['x-nf-request-id'] || /netlify/i.test(server || '')],
    ['GitHub Pages', () => h['x-github-request-id'] || /github\.com/i.test(server || '')], ['Ngenix', () => /ngenix/i.test(server || '') || h['x-ngenix-cache']],
    ['CDNvideo', () => /cdnvideo/i.test(server || '') || /cdnvideo/i.test(h['x-cdn'] || '')], ['Yandex Cloud CDN', () => /yandex/i.test(h['x-cdn'] || '')],
  ];
  for (const [name, f] of cdnRules) if (f()) { cdn = name; signals.push(`CDN/защита: ${name}`); break; }
  return { cms, version, cdn, server, powered_by: xp || null, store, signals: [...new Set(signals)].slice(0, 30) };
}

function detectMarket(host, rendered, rawParsed, blockedAnalytics) {
  const why = []; let ru = 0, intl = 0;
  const tld = host.split('.').pop();
  const dom = T(`домен .${tld}`, `domain .${tld}`);
  if (['ru', 'su', 'xn--p1ai', 'by', 'kz', 'xn--80ao21a'].includes(tld) || /\.(msk|spb|com)\.ru$/.test(host)) { ru += 2; why.push(dom); }
  else if (['com', 'net', 'org', 'io', 'co', 'app', 'dev', 'ai'].includes(tld)) { intl += 0.5; why.push(dom); }
  else if (tld && !/^\d+$/.test(tld) && tld !== 'localhost') { intl += 1; why.push(dom); }
  const l = String(rendered?.lang || rawParsed?.lang || '').toLowerCase().slice(0, 2);
  if (l === 'ru') { ru += 2; why.push('lang="ru"'); } else if (l) { intl += 2; why.push(`lang="${l}"`); }
  const text = (rendered?.text || rawParsed?.text || '');
  const cyr = (text.match(/[а-яё]/gi) || []).length, lat = (text.match(/[a-z]/gi) || []).length;
  if (cyr > lat) { ru += 1; why.push(T('текст на кириллице', 'Cyrillic text')); } else if (lat > cyr * 2 && lat > 200) { intl += 1; why.push(T('текст на латинице', 'Latin text')); }
  // no \b with Cyrillic: it is an ASCII word boundary
  if (/₽|(?<![\p{L}])руб(\.|л[а-яё]{1,3})?(?![\p{L}])/iu.test(text)) { ru += 1; why.push(T('цены в рублях', 'prices in roubles')); }
  if (/[$€£]\s?\d|\d\s?[$€£]|\bEUR\b|\bUSD\b/.test(text)) { intl += 1; why.push(T('цены в $/€/£', 'prices in $/€/£')); }
  if (/(?<!\d)(\+7|8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]?\d{2}[\s-]?\d{2}(?!\d)/.test(text)) { ru += 1; why.push(T('телефон +7', 'phone +7')); }
  if ((blockedAnalytics || []).some(b => /yandex/i.test(b.url))) { ru += 1; why.push(T('Яндекс Метрика', 'Yandex Metrica')); }
  let value = 'ru';
  if (ru >= 2 && intl >= 2) value = 'mixed'; else if (intl > ru) value = 'intl';
  const engines = value === 'intl' ? ['google'] : ['yandex', 'google'];
  const countries = value === 'ru' ? ['RU'] : value === 'mixed' ? ['RU'] : [];
  return { value, why: why.join(', '), search_engines: engines, countries, scores: { ru, intl } };
}

function guessVertical(rendered, urls, discovered, jsonld) {
  const text = ((rendered?.text || '') + ' ' + urls.slice(0, 400).join(' ')).toLowerCase();
  const types = (jsonld || []).map(String).join(' ').toLowerCase();
  const S = {};
  const add = (k, n) => { S[k] = (S[k] || 0) + n; };
  const rx = (re, k, w = 1) => { const m = text.match(re); if (m) add(k, Math.min(4, m.length) * w); };
  rx(/в корзину|add to cart|корзин|\/cart|\/basket|оформить заказ|checkout|в наличии|артикул|sku/g, 'shop', 2);
  if (/product|offer/.test(types)) add('shop', 3);
  rx(/записаться|запись на|адрес|часы работы|режим работы|как добраться|мастер|салон|студи|ремонт|услуг/g, 'local-services');
  if (/localbusiness|beautysalon|autorepair|dentist|restaurant|cafe/.test(types)) add('local-services', 3);
  rx(/pricing|sign up|free trial|попробовать бесплатно|тариф|api|интеграци|dashboard|регистрац|saas/g, 'saas');
  if (/softwareapplication|webapplication/.test(types)) add('saas', 3);
  rx(/кредит|вклад|ипотек|банк|страхован|loan|mortgage|deposit|лицензия цб|брокер|инвестиц/g, 'finance', 2);
  if (/bank|financialservice|insurance/.test(types)) add('finance', 3);
  rx(/новости|статьи|news|article|редакци|подписаться на рассылку|журнал/g, 'media');
  if (/newsarticle|newsmediaorganization/.test(types)) add('media', 3);
  rx(/портфолио|portfolio|кейсы|cases|проекты|works|showreel/g, 'portfolio');
  rx(/пожертвов|donat|благотвор|фонд|волонт|nonprofit|ngo/g, 'nonprofit', 2);
  rx(/клиник|врач|медицин|лечени|анализы|приём врача|стоматолог|doctor|clinic|лицензия на медицинскую/g, 'medical', 2);
  if (/medical|physician|hospital|dentist/.test(types)) add('medical', 3);
  rx(/курс[а-я]*|обучени|школ[аы]|урок|занятия|преподават|педагог|course|lesson|education|university|вуз/g, 'education');
  if (/educationalorganization|course/.test(types)) add('education', 3);
  rx(/госуслуг|gov\.ru|администраци|министерств|ведомств|\.gov\b/g, 'gov', 2);
  let best = 'other', bv = 0;
  for (const [k, v] of Object.entries(S)) if (v > bv) { bv = v; best = k; }
  if (discovered <= 6 && best !== 'shop' && bv < 6) best = bv >= 3 ? best : 'landing';
  return { value: best, scores: S };
}

function betaSignals(host, homeRendered, homeRaw, robots, robotsTxtOk, rawHeaders, homeStatus) {
  const out = [];
  const robotsMeta = [homeRendered?.robots, homeRaw?.robots].filter(Boolean).join(', ');
  if (/noindex/i.test(robotsMeta)) out.push({ signal: 'noindex', detail: T(`meta robots на главной: ${robotsMeta}`, `home meta robots: ${robotsMeta}`) });
  const xr = rawHeaders?.['x-robots-tag'];
  if (xr && /noindex/i.test(String(xr))) out.push({ signal: 'x_robots_noindex', detail: `X-Robots-Tag: ${xr}` });
  if (robotsTxtOk && robots) {
    for (const g of robots.groups) {
      const all = g.rules.some(r => r.type === 'disallow' && r.path === '/') && !g.rules.some(r => r.type === 'allow' && r.path === '/');
      if (all && g.agents.some(a => a === '*' || /yandex|googlebot/.test(a))) { out.push({ signal: 'robots_disallow_all', detail: `robots.txt: User-agent ${g.agents.join(', ')} → Disallow: /` }); break; }
    }
  }
  const labels = host.split('.');
  if (labels.length > 2 || /localhost/.test(host)) {
    const sub = labels.slice(0, -2).join('.');
    if (/(^|[.-])(test|testing|dev|develop|beta|stage|staging|stg|preview|demo|qa|uat|sandbox|draft|new|next|tmp|temp)\d*([.-]|$)/i.test(sub)) out.push({ signal: 'subdomain', detail: T(`поддомен «${sub}»`, `subdomain "${sub}"`) });
  }
  if (/\.(tilda\.ws|vercel\.app|netlify\.app|webflow\.io|wixsite\.com|github\.io|pages\.dev|herokuapp\.com|onrender\.com|ngrok(-free)?\.(io|app)|surge\.sh|glitch\.me|web\.app|firebaseapp\.com|framer\.(website|app))$/i.test(host)) out.push({ signal: 'preview_domain', detail: T(`технический домен платформы: ${host}`, `platform preview domain: ${host}`) });
  if (host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || host === '[::1]') out.push({ signal: 'local_host', detail: T('локальный адрес', 'local address') });
  if (homeStatus === 401) out.push({ signal: 'auth', detail: T('главная закрыта паролем (401)', 'home page is password-protected (401)') });
  const text = (homeRendered?.text || homeRaw?.text || '').toLowerCase();
  const ph = text.match(/lorem ipsum|сайт в разработке|сайт находится в разработке|under construction|coming soon|скоро открытие|страница в разработке|тестовая страница|\[ваше имя\]|заглушка/);
  if (ph) out.push({ signal: 'placeholder_text', detail: T(`на главной: «${ph[0]}»`, `on the home page: "${ph[0]}"`) });
  return out;
}

// ---------- main ----------
// "как в прошлом прогоне (как в прошлом прогоне (ключевая: цены))" → "ключевая: цены"
const stripPrev = why => {
  let w = String(why || '');
  for (let i = 0; i < 6; i++) { const m = w.match(/^(?:как в прошлом прогоне|same as previous run)(?: \((.*)\))?$/); if (!m) break; w = m[1] || ''; }
  return w;
};

// Machine-wide browser slot within the time budget: other Revizor checks may hold both slots.
let slotWaitSec = 0;
async function acquireSlot() {
  try { return await U.acquireBrowserSlot({ waitMs: 0 }); } catch { /* both taken — wait below */ }
  const waitSec = Math.max(0, Math.floor(secLeft() - 30));
  const t = Date.now();
  if (waitSec > 0) {
    U.progress(T(`crawl: жду свободный браузер — заняты другими проверками Ревизора (жду до ${waitSec} с)…`,
      `crawl: waiting for a free browser — taken by other Revizor checks (up to ${waitSec}s)…`));
    try { const r = await U.acquireBrowserSlot({ waitMs: waitSec * 1000 }); slotWaitSec += Math.round((Date.now() - t) / 1000); return r; } catch { /* timed out */ }
  }
  slotWaitSec += Math.round((Date.now() - t) / 1000);
  return null;
}

const lowerKeys = o => Object.fromEntries(Object.entries(o || {}).map(([k, v]) => [k.toLowerCase(), v]));
// cache-friendly copy of a parsed raw page (links are only needed to find second-level candidates)
const slimParsed = p => (p && !p.error ? { ...p, links: (p.links || []).slice(0, 2000) } : p || null);

async function main() {
  U.cleanupStaleProfiles();
  const startHost = U.hostOf(input);
  await allowInputHost(input);
  siteKey = keyOf(input);
  const inputKey = siteKey;
  const sameSiteAny = u => isSame(u) || keyOf(u) === inputKey;

  // the previous pages.json of this RUN: the same URL keeps its pid (snapshot folders stay valid)
  const prevDoc = readOpt(join(run, 'pages.json'));
  const prevPid = new Map(), prevPids = new Set();
  for (const s of prevDoc?.selected || []) if (s?.pid && s?.url) { prevPid.set(s.url, s.pid); prevPids.add(s.pid); }

  // old selection for recheck/--resume
  let oldPages = null;
  if (pagesFrom) {
    oldPages = U.readJSON(pagesFrom, null);
    if (!oldPages?.selected?.length) { console.error(T('Не читается --pages-from (нужен pages.json со списком selected): ', 'Cannot read --pages-from (need pages.json with "selected"): ') + pagesFrom); return 2; }
  }

  // cache of an interrupted call (same URL and language, < 6 h): every finished step is reused
  const cachePath = U.insideRun(run, '.cache', 'crawl.json');
  let cache = readOpt(cachePath);
  if (!cache || cache.v !== 2 || cache.input !== input || (cache.al || null) !== (acceptLanguage || null) || Date.now() - Date.parse(cache.saved || 0) > 6 * 3600e3) cache = { v: 2, input, al: acceptLanguage || null };
  cache.parsed ||= {};
  const reqBase = cache.requests || 0;
  const saveCache = () => { cache.saved = U.nowIso(); cache.requests = reqBase + requests; U.writeJSON(cachePath, cache); };

  // 1. home: raw HTML (what a robot sees without JS). Home = origin "/", a deeper --url is added as a key page.
  const homeInput = new URL(input).origin + '/';
  let homeRaw = cache.home_raw, homeRawBody = null;
  if (!homeRaw) {
    U.progress(T('crawl: главная (исходный HTML)…', 'crawl: home page (raw HTML)…'));
    const r = await get(homeInput, { maxBytes: 6 * 1024 * 1024, timeoutMs: 30000 });
    homeRawBody = r.body || '';
    homeRaw = { ok: !!r.ok, status: r.status || 0, url: r.url, chain: r.chain || [], headers: r.headers || {}, body: homeRawBody.slice(0, 1500000),
      antibot: r.antibot || null, error: r.error || null, bytes: r.bytes || 0, skipped: r.skipped || null };
    cache.home_raw = homeRaw; saveCache();
  }
  homeRawBody ??= homeRaw.body || '';
  let finalUrl = homeRaw.url || homeInput;
  if (homeRaw.status && finalUrl !== homeInput) await allowRedirectHost(finalUrl);
  // the site moved to another host: review the final host
  if (homeRaw.status && isSame(finalUrl) === false) siteKey = keyOf(finalUrl);
  const finalOrigin = (() => { try { return new URL(finalUrl).origin; } catch { return new URL(homeInput).origin; } })();
  done.push('home_raw');

  // 2. robots.txt of the final origin
  let robotsRes = cache.robots;
  if (!robotsRes) {
    U.progress('crawl: robots.txt…');
    const r = await get(finalOrigin + '/robots.txt', { accept: 'text/plain,*/*;q=0.5' });
    robotsRes = { ok: !!r.ok, status: r.status || 0, headers: { 'content-type': r.headers?.['content-type'] || '' }, body: (r.body || '').slice(0, 512 * 1024) };
    cache.robots = robotsRes; saveCache();
  }
  const robotsCt = String(robotsRes.headers?.['content-type'] || '');
  const robotsIsText = robotsRes.ok && !/text\/html/i.test(robotsCt) && !/^\s*</.test(robotsRes.body || '');
  const robots = robotsIsText ? U.parseRobots(robotsRes.body || '') : null;
  const robotsBlocksHome = robots ? !U.robotsAllows(robots, finalOrigin + '/', '*') : false;
  const enforceRobots = !!robots && !robotsBlocksHome;
  const robotsOk = u => !enforceRobots || U.robotsAllows(robots, u, '*');
  done.push('robots');

  // 3. browser: rendered home at 1440 and 390 (menus, burger, links, stack signals) — slot within the budget
  const release = await acquireSlot();
  if (!release) {
    saveCache();
    const lines = [T(`crawl: ЧАСТИЧНО · не дождался свободного браузера за ${slotWaitSec} с (slot_wait): оба заняты другими проверками Ревизора.`,
      `crawl: PARTIAL · no free browser within ${slotWaitSec}s (slot_wait): both taken by other Revizor checks.`),
    T('Главная и robots.txt сохранены в RUN/.cache/crawl.json. Повторите ту же команду — продолжу с этого места.', 'Home page and robots.txt are cached in RUN/.cache/crawl.json. Run the same command again to continue.')];
    U.printAndSaveSummary(run, 'crawl', lines);
    U.log(run, `crawl: ждал свободный браузер ${slotWaitSec} с, не дождался (slot_wait)`);
    return 75;
  }
  let browser = null, tool = null;
  const pageOpts = { blockNavigation: true, ...(acceptLanguage ? { acceptLanguage } : {}) };
  // the browser's requests to the site count as load on it too (log.md)
  const siteResponses = pg => pg.responses.filter(r => { const k = keyOf(r.url); return k === siteKey || k === inputKey; }).length;
  try {
    browser = await launchBrowser();
    tool = await browser.newPage(acceptLanguage ? { acceptLanguage } : {});
    let homeLoadedNow = false;
    if (!cache.home_1440) {
      U.progress(T('crawl: главная в браузере (1440)…', 'crawl: home page in the browser (1440)…'));
      const pg = await browser.newPage(pageOpts);
      await pg.setViewport({ width: 1440, height: 900 });
      const hl = await loadPage(pg, homeInput);
      const rec = { load: { ok: !!hl.ok, status: hl.status ?? null, ms: hl.ms ?? null, timedOut: !!hl.timedOut, finalUrl: hl.finalUrl || null, error: hl.error || null, refused: hl.refused || null } };
      if (hl.ok) {
        await U.sleep(500);
        rec.rendered = await pg.evaluate(extractRendered).catch(e => ({ error: e.message }));
        rec.resourceUrls = pg.responses.map(r => r.url).slice(0, 600);
        rec.blockedAnalytics = [...(pg.blocked.analytics || []), ...(pg.blocked.widget || [])].slice(0, 100);
        rec.docHeaders = lowerKeys(pg.responses.find(r => r.type === 'Document')?.headers);
      }
      requests += siteResponses(pg);
      await pg.close();
      cache.home_1440 = rec; saveCache(); homeLoadedNow = true;
    }
    const homeLoad = cache.home_1440.load;
    const rendered = cache.home_1440.rendered || null;
    const resourceUrls = cache.home_1440.resourceUrls || [];
    const blockedAnalytics = cache.home_1440.blockedAnalytics || [];
    const docHeaders = cache.home_1440.docHeaders || {};
    if (rendered?.finalUrl) { finalUrl = rendered.finalUrl; await allowRedirectHost(finalUrl); }
    done.push('home_browser');
    if (!cache.home_390 && homeLoad.ok && secLeft() > (homeLoadedNow ? 60 : 30)) {
      U.progress(T('crawl: главная на 390 (бургер)…', 'crawl: home page at 390 (burger)…'));
      const mp = await browser.newPage(pageOpts);
      await mp.setViewport({ width: 390, height: 844, mobile: true });
      const ml = await loadPage(mp, homeInput);
      let b = null;
      if (ml.ok) { await U.sleep(500); b = await mp.evaluate(extractBurger).catch(e => ({ error: e.message })); }
      requests += siteResponses(mp);
      await mp.close();
      cache.home_390 = { ok: !!ml.ok, burger: b }; saveCache();
    }
    const burger = cache.home_390?.burger || null;
    const burgerDone = !!cache.home_390 || !homeLoad.ok;
    if (burgerDone) done.push('home_390');

    const parse = async (html, base) => {
      if (!html) return null;
      return tool.evaluate(parseRaw, String(html).slice(0, 3 * 1024 * 1024), base).catch(e => ({ error: e.message }));
    };
    if (!cache.home_parsed) { cache.home_parsed = slimParsed(await parse(homeRawBody, homeRaw.url || homeInput)); saveCache(); }
    const homeParsed = cache.home_parsed;

    // 4. sitemaps (state survives an interrupted call)
    let sm = cache.sitemaps;
    if (!sm || sm.stopped) {
      if (!sm) {
        const seeds = robots?.sitemaps?.length ? robots.sitemaps.map(s => canon(s, finalOrigin)).filter(Boolean) : [finalOrigin + '/sitemap.xml'];
        sm = { queue: [...new Set(seeds)], seen: [], urls: [], files: [], fallbackTried: !!robots?.sitemaps?.length };
      }
      U.progress(T(`crawl: sitemap (${sm.queue.length} в очереди)…`, `crawl: sitemaps (${sm.queue.length} queued)…`));
      await crawlSitemaps(sm);
      if (!sm.stopped && !sm.urls.length && !sm.fallbackTried && secLeft() > 60) {
        sm.fallbackTried = true; sm.queue.push(finalOrigin + '/sitemap_index.xml');
        await crawlSitemaps(sm);
      }
      cache.sitemaps = sm; saveCache();
    }
    if (!sm.stopped) done.push('sitemaps');

    // collect candidates: url → { sources:Set, texts:Set, areas:Set }
    const cand = new Map(); const skipped = []; const skippedSeen = new Set(); const documents = [];
    const skip = (url, why) => { if (skippedSeen.has(url)) return; skippedSeen.add(url); if (skipped.length < 200) skipped.push({ url, why }); };
    const addCand = (href, source, text, area) => {
      const u = canon(href, finalUrl);
      if (!u) return null;
      if (!isSame(u)) return null;
      if (FILE_EXT.test(new URL(u).pathname)) { if (DOC_EXT.test(new URL(u).pathname) && documents.length < 60 && !documents.some(d => d.url === u)) documents.push({ url: u, text: text || '' }); return null; }
      if (U.isRiskyGet(u)) { skip(u, 'risky'); return null; }
      if (!robotsOk(u)) { skip(u, 'robots'); return null; }
      let c = cand.get(u);
      if (!c) { c = { sources: new Set(), texts: new Set(), areas: new Set() }; cand.set(u, c); }
      c.sources.add(source); if (text) c.texts.add(text); if (area) c.areas.add(area);
      return u;
    };
    const homeUrl = canon(finalUrl, finalUrl) || finalUrl;
    addCand(homeUrl, 'home');
    for (const l of rendered?.links || homeParsed?.links || []) addCand(l.href, 'home_links', l.text, l.area);
    for (const l of rendered?.header || []) addCand(l.href, l.level > 1 ? 'menu2' : 'menu', l.text, 'header');
    for (const l of rendered?.footer || []) addCand(l.href, 'footer', l.text, 'footer');
    for (const l of burger?.links || []) addCand(l.href, 'burger', l.text, 'burger');
    const smSet = new Set();
    for (const s of sm.urls) { const u = addCand(s.loc, 'sitemap'); if (u) smSet.add(u); }

    // 5. HTML sitemap page
    let sitemapHtml = cache.sitemap_html?.list || [];
    if (!cache.sitemap_html) {
      const smLink = [...(rendered?.links || homeParsed?.links || [])].find(l => /карта сайта|site ?map/i.test(l.text || '') && isSame(l.href || '') && !/\.xml/i.test(l.href || ''));
      if (!smLink) cache.sitemap_html = { list: [] };
      else if (secLeft() > 40 && !U.isRiskyGet(smLink.href)) {
        const r = await get(smLink.href, { maxBytes: 4 * 1024 * 1024 });
        const p = r.ok ? await parse(r.body, r.url) : null;
        if (p?.links) {
          const own = p.links.filter(l => isSame(l.href));
          const body = own.filter(l => l.area === 'main');
          sitemapHtml = (body.length >= 3 ? body : own).map(l => ({ text: l.text, href: l.href })).slice(0, 500);
        }
        cache.sitemap_html = { list: sitemapHtml };
      }
      saveCache();
    }
    for (const l of sitemapHtml) addCand(l.href, 'sitemap_html', l.text);
    if (cache.sitemap_html) done.push('sitemap_html');

    // 6. second level: links of menu pages (raw HTML parsed in the browser); parsed pages are cached
    const parsedPages = new Map(Object.entries(cache.parsed));
    const homeAntibot = antibotOf(homeRaw.status, homeRaw.headers, homeRawBody, homeParsed?.textLen);
    if (homeParsed) parsedPages.set(homeUrl, { status: homeRaw.status, final: homeRaw.url, parsed: homeParsed, antibot: homeAntibot });
    const menuUrls = [...cand.entries()].filter(([u, c]) => (c.sources.has('menu') || c.sources.has('burger')) && u !== homeUrl).map(([u]) => u).slice(0, 12);
    let menusDone = true;
    for (const u of menuUrls) {
      let info = parsedPages.get(u);
      if (!info) {
        if (secLeft() < 45) { menusDone = false; break; }
        const r = await get(u, { maxBytes: 4 * 1024 * 1024 });
        const p = r.ok && /html/i.test(String(r.headers?.['content-type'] || 'html')) ? await parse(r.body, r.url) : null;
        info = { status: r.status, final: r.url, parsed: slimParsed(p), antibot: antibotOf(r.status, r.headers, r.body, p?.textLen), error: r.error, skipped: r.skipped };
        parsedPages.set(u, info); cache.parsed[u] = info;
      }
      for (const l of info.parsed?.links || []) addCand(l.href, 'level2', l.text);
    }
    saveCache();
    if (menusDone) done.push('menus');

    // 7. templates (DOM signatures are added after the checks, when more pages are parsed)
    const byTemplate = {};
    for (const [u, c] of cand) {
      const t = templateOf(u);
      const bt = byTemplate[t] ||= { discovered: 0, in_sitemap: 0, sample: [], estimate: 0, signatures: [] };
      bt.discovered++; if (smSet.has(u) || c.sources.has('sitemap')) bt.in_sitemap++;
      if (bt.sample.length < 5) bt.sample.push(pathOf(u));
    }
    for (const bt of Object.values(byTemplate)) bt.estimate = Math.max(bt.discovered, bt.in_sitemap);

    // 8. selection
    const selected = [];
    const selUrls = new Set();
    const pick = (u, why, key) => {
      if (!u || selUrls.has(u) || selected.length >= maxPages) return false;
      selUrls.add(u); selected.push({ url: u, why, key: key || null, template: templateOf(u) }); return true;
    };
    const L = lang === 'en' ? KEY_LABEL_EN : KEY_LABEL;
    if (oldPages?.selected?.length) {
      for (const s of oldPages.selected) {
        // pages of another site in an old pages.json are not opened (private addresses included)
        if (!s?.url || !sameSiteAny(s.url)) { if (s?.url) skip(s.url, 'other_host'); continue; }
        const prevWhy = stripPrev(s.why);
        selected.push({ url: s.url, why: T('как в прошлом прогоне', 'same as previous run') + (prevWhy ? ` (${prevWhy})` : ''), key: null, template: s.template || templateOf(s.url), pid: s.pid }); selUrls.add(s.url);
      }
    } else if (explicitPages.length) {
      for (const p of explicitPages) {
        const u = canon(p, finalOrigin + '/');
        if (!u) continue;
        if (!sameSiteAny(u)) { skip(u, 'other_host'); continue; }
        if (U.isRiskyGet(u)) { skip(u, 'risky'); continue; }
        pick(u, '--page', 'explicit');
      }
    } else {
      pick(homeUrl, T('главная', 'home page'), 'home');
      const inPath = new URL(input).pathname;
      if (inPath && inPath !== '/' && isSame(input)) pick(canon(input), L.input, 'input');
      const entries = [...cand.entries()].filter(([u]) => u !== homeUrl && templateOf(u) !== 'pagination' && !templateOf(u).endsWith('?'));
      const mainLangPrefix = (() => { const p = new URL(finalUrl).pathname.split('/').filter(Boolean)[0] || ''; return /^[a-z]{2}$/i.test(p) && LANG_CODES.has(p.toLowerCase()) ? '/' + p.toLowerCase() : ''; })();
      const isOtherLang = u => { const t = templateOf(u); const m = t.match(/^\/([a-z]{2})(\/|$)/); return !!m && LANG_CODES.has(m[1]) && '/' + m[1] !== mainLangPrefix && !byTemplate['/' + m[1]]; };
      const rank = ([u, c]) => (c.sources.has('menu') ? 0 : c.sources.has('burger') ? 1 : c.sources.has('footer') ? 2 : c.sources.has('menu2') ? 3 : c.sources.has('home_links') ? 4 : 5) * 1000 + pathOf(u).length;
      const sorted = entries.filter(([u]) => !isOtherLang(u)).sort((a, b) => rank(a) - rank(b));
      // few pages (the standard default is home + 3): the pages a visitor needs most go first —
      // service or prices, contacts or booking, then the first header menu item (menu order stands in for traffic:
      // the script has no visit data)
      if (maxPages <= 4) {
        const navSrc = c => c.sources.has('menu') || c.sources.has('burger') || c.sources.has('footer') || c.sources.has('menu2');
        const findKey = keys => {
          for (const key of keys) {
            const re = key === 'booking' ? BOOKING_RE : KEY_RULES.find(k => k[0] === key)[1];
            const free = sorted.filter(([u]) => !selUrls.has(u));
            const hit = free.find(([, c]) => re.test([...c.texts].join(' ')) && navSrc(c)) || free.find(([u]) => re.test(decodeURIComponent(new URL(u).pathname)));
            if (hit) return [hit[0], key];
          }
          return null;
        };
        const label = key => key === 'booking' ? T('запись', 'booking') : L[key];
        for (const keys of [['prices', 'services'], ['booking', 'contacts']]) {
          const k = findKey(keys);
          if (k) pick(k[0], `${T('ключевая', 'key page')}: ${label(k[1])}`, k[1]);
        }
        const menuOrder = [...(rendered?.header || []).filter(l => !(l.level > 1)), ...(burger?.links || [])].map(l => canon(l.href, finalUrl)).filter(Boolean);
        const firstMenu = menuOrder.find(u => cand.has(u) && u !== homeUrl && !selUrls.has(u) && !isOtherLang(u) && templateOf(u) !== 'pagination');
        if (firstMenu) pick(firstMenu, T('первый пункт меню шапки', 'first header menu item'), 'nav');
      }
      // key pages
      for (const [key, re] of KEY_RULES) {
        const hit = sorted.find(([u, c]) => re.test([...c.texts].join(' ')) && (c.sources.has('menu') || c.sources.has('footer') || c.sources.has('burger') || c.sources.has('menu2')))
          || sorted.find(([u]) => re.test(decodeURIComponent(new URL(u).pathname)));
        if (hit) pick(hit[0], `${T('ключевая', 'key page')}: ${L[key]}`, key);
        if (key === 'services') {
          // product card and article right after services
          const tpls = Object.entries(byTemplate).filter(([t]) => (t.match(/\/\*/g) || []).length >= 1).sort((a, b) => b[1].estimate - a[1].estimate);
          const prod = tpls.find(([t]) => PRODUCT_ROOT.test(t.replace(/(\/\*)+\??$/, '').replace(/^\/[a-z]{2}(?=\/)/, '')) || PRODUCT_ROOT.test(t.split('/*')[0]));
          if (prod) { const u = sorted.find(([x]) => templateOf(x) === prod[0]); if (u) pick(u[0], `${T('ключевая', 'key page')}: ${L.product} (${T('шаблон', 'template')} ${prod[0]}, ~${prod[1].estimate})`, 'product'); }
          const art = tpls.find(([t]) => ARTICLE_ROOT.test(t.split('/*')[0]));
          if (art) { const u = sorted.find(([x]) => templateOf(x) === art[0]); if (u) pick(u[0], `${T('ключевая', 'key page')}: ${L.article} (${T('шаблон', 'template')} ${art[0]}, ~${art[1].estimate})`, 'article'); }
        }
      }
      // other language versions: one home per language (for i18n)
      const langHomes = new Map();
      for (const [u] of entries) { const m = templateOf(u).match(/^\/([a-z]{2})\/$/); if (m && isOtherLang(u) && !langHomes.has(m[1])) langHomes.set(m[1], u); }
      for (const [lc, u] of [...langHomes].slice(0, 2)) pick(u, `${L.lang}: ${lc}`, 'lang');
      // templates with many pages: 1–2 each
      const multi = Object.entries(byTemplate).filter(([t, bt]) => bt.estimate >= 2 && t !== 'home' && t !== 'pagination' && !t.endsWith('?')).sort((a, b) => b[1].estimate - a[1].estimate);
      for (const [t, bt] of multi) {
        const members = sorted.filter(([u]) => templateOf(u) === t);
        const want = bt.estimate >= 10 ? 2 : 1;
        let have = selected.filter(s => s.template === t).length;
        for (const [u] of members) { if (have >= want) break; if (pick(u, `${T('шаблон', 'template')} ${t} (~${bt.estimate} ${T('стр.', 'pages')})`, 'template')) have++; }
      }
      // menu order, footer, the rest — at most 3 pages of one multi-page template
      const perTpl = t => selected.filter(s => s.template === t).length;
      for (const [u, c] of sorted) {
        if (selected.length >= maxPages) break;
        const t = templateOf(u);
        if ((byTemplate[t]?.estimate || 1) >= 2 && perTpl(t) >= 3) continue;
        const src = c.sources.has('menu') ? T('меню шапки', 'header menu') : c.sources.has('burger') ? T('бургер', 'burger menu') : c.sources.has('footer') ? T('подвал', 'footer') : c.sources.has('menu2') ? T('подменю', 'submenu') : c.sources.has('sitemap') ? 'sitemap' : T('ссылка', 'link');
        pick(u, src, 'nav');
      }
    }

    // 9. check selected pages (status, title, redirects); replace dead ones. Results are cached per URL.
    U.progress(T(`crawl: проверяю ${selected.length} выбранных страниц…`, `crawl: checking ${selected.length} selected pages…`));
    const finalSeen = new Map();
    const replacements = [...cand.keys()].filter(u => !selUrls.has(u) && templateOf(u) !== 'pagination' && !templateOf(u).endsWith('?'));
    const out = [];
    let partialCheck = false, sinceSave = 0;
    for (let i = 0; i < selected.length; i++) {
      const s = selected[i];
      let info = parsedPages.get(s.url);
      if (s.url === homeUrl && homeLoad) {
        const st = homeLoad.status ?? homeRaw.status;
        info = { status: st, final: rendered?.finalUrl || homeRaw.url, parsed: { title: rendered?.title ?? homeParsed?.title }, antibot: null };
      } else if (!info) {
        if (secLeft() < 25) { partialCheck = true; out.push({ ...s, status: null, final_url: null, title: null, blocked: null, unchecked: true }); continue; }
        const r = await get(s.url, { maxBytes: 3 * 1024 * 1024 });
        const p = r.ok ? await parse(r.body, r.url) : null;
        info = { status: r.status, final: r.url, parsed: slimParsed(p), antibot: antibotOf(r.status, r.headers, r.body, p?.textLen), error: r.error, skipped: r.skipped };
        parsedPages.set(s.url, info); cache.parsed[s.url] = info;
        if (++sinceSave >= 5) { saveCache(); sinceSave = 0; }
      }
      if (info.skipped) { skip(s.url, info.skipped); selUrls.delete(s.url); }
      const dead = !info.skipped && s.key !== 'explicit' && !oldPages && s.url !== homeUrl && (info.status === 404 || info.status === 410 || (info.status >= 500 && !info.antibot));
      const ext = info.final && !sameSiteAny(info.final);
      const dupe = info.final && finalSeen.has(info.final) && s.url !== homeUrl;
      if (info.skipped || dead || (ext && !oldPages) || (dupe && !oldPages)) {
        if (!info.skipped) skip(s.url, dead ? `status_${info.status}` : ext ? 'external_redirect' : 'duplicate_redirect');
        // replace with the next unchecked candidate (not when the person named the pages: --page / --pages-from)
        while (!explicitPages.length && !oldPages && replacements.length) {
          const r = replacements.shift();
          if (selUrls.has(r)) continue;
          selUrls.add(r); selected.push({ url: r, why: T('замена недоступной', 'replacement'), key: 'nav', template: templateOf(r) });
          break;
        }
        continue;
      }
      if (info.final) finalSeen.set(info.final, s.url);
      let blocked = null;
      if (info.antibot) blocked = 'antibot';
      else if (info.status === 401) blocked = '401';
      else if (info.status === 403) blocked = '403';
      else if (!info.status && info.error) blocked = /timeout/i.test(info.error) ? 'timeout' : 'network';
      const entry = { ...s, status: info.status || null, final_url: info.final && info.final !== s.url ? info.final : null, title: info.parsed?.title ?? null, blocked };
      // a login or cabinet page answering 401/403 is closed by design, not by protection
      if ((blocked === '401' || blocked === '403') && (s.key === 'login' || s.key === 'cart')) entry.auth_page = true;
      out.push(entry);
    }
    saveCache();
    // home in the browser decides the gate
    let homeBlocked = null;
    if (homeLoad) {
      const docStatus = homeLoad.status ?? null;
      const ab = antibotOf(docStatus || 0, docHeaders, rendered?.html || '', rendered?.textLen) || (homeLoad.ok ? null : homeAntibot);
      if (!homeLoad.ok) homeBlocked = homeLoad.refused ? `refused_${homeLoad.refused}` : homeAntibot ? 'antibot' : /AUTH/i.test(homeLoad.error || '') || homeRaw.status === 401 ? '401'
        : homeRaw.status === 403 ? '403' : (/TIMED_OUT|timeout/i.test(homeLoad.error || '') ? 'timeout' : 'network');
      else if (ab) homeBlocked = 'antibot';
      else if (docStatus === 401) homeBlocked = '401';
      else if (docStatus === 403) homeBlocked = '403';
      else if (!docStatus && (rendered?.textLen || 0) < 30) homeBlocked = 'timeout';
    }
    const homeOut = out.find(s => s.url === homeUrl);
    if (homeOut) { homeOut.blocked = homeBlocked; if (homeLoad?.status) homeOut.status = homeLoad.status; }

    // pids: the same URL keeps its pid of the previous pages.json of this RUN; a new URL never takes a pid that meant
    // another URL here (snapshot folders would mix two pages)
    const used = new Set(out.filter(s => s.pid).map(s => s.pid));
    for (const s of out) {
      if (s.pid) continue;
      const p = prevPid.get(s.url);
      if (p && !used.has(p) && (p !== 'home' || s.url === homeUrl)) { s.pid = p; used.add(p); }
    }
    for (const s of out) if (!s.pid && s.url === homeUrl && !used.has('home')) { s.pid = 'home'; used.add('home'); }
    const reserved = new Set([...prevPids].filter(p => !used.has(p)));
    let n = 0;
    for (const s of out) {
      if (s.pid) continue;
      let pid; do { n++; pid = U.pidFor(n); } while (used.has(pid) || reserved.has(pid));
      s.pid = pid; used.add(pid);
    }
    out.sort((a, b) => (a.pid === 'home' ? -1 : b.pid === 'home' ? 1 : a.pid.localeCompare(b.pid)));
    if (!partialCheck) done.push('selected');

    // DOM signatures of every parsed page; one-level addresses with the same layout form a group
    // (flat sites: /uslugi-1, /page123.html — "~K pages of this template" is estimated over the group)
    for (const [u, info] of parsedPages) {
      if (!info.parsed?.sig) continue;
      const bt = byTemplate[templateOf(u)]; if (!bt) continue;
      const h = U.md5(info.parsed.sig.join('|')).slice(0, 8);
      if (!bt.signatures.includes(h) && bt.signatures.length < 5) bt.signatures.push(h);
    }
    const oneLevel = t => /^(\/[a-z]{2})?\/[^/*?]+$/.test(t);
    const oneLevelAll = Object.keys(byTemplate).filter(oneLevel);
    const oneLevelSigned = oneLevelAll.filter(t => byTemplate[t].signatures.length === 1);
    const bySig = new Map();
    for (const t of oneLevelSigned) { const g = bySig.get(byTemplate[t].signatures[0]) || []; g.push(t); bySig.set(byTemplate[t].signatures[0], g); }
    const signatureGroups = [];
    for (const [sig, ts] of bySig) {
      if (ts.length < 2) continue;
      const estimate = Math.max(ts.length, Math.round(ts.length / Math.max(1, oneLevelSigned.length) * oneLevelAll.length));
      signatureGroups.push({ signature: sig, templates: ts.slice(0, 20), parsed: ts.length, estimate });
      for (const t of ts) { byTemplate[t].group = sig; byTemplate[t].group_estimate = estimate; }
    }
    signatureGroups.sort((a, b) => b.estimate - a.estimate);

    // 10. stack, market, vertical, languages, beta
    const stack = detectStack(homeRawBody, { ...(homeRaw.headers || {}), ...docHeaders }, rendered, resourceUrls);
    const host = U.hostOf(finalUrl) || startHost;
    const market = detectMarket(host, rendered, homeParsed, blockedAnalytics);
    const jsonld = rendered?.jsonld || homeParsed?.jsonld || [];
    const vertical = guessVertical(rendered || homeParsed, [...cand.keys()].map(pathOf), cand.size, jsonld);
    const languages = [];
    const pushLang = (lc, url) => { if (!lc || !url) return; if (!languages.some(l => l.lang === lc && l.url === url)) languages.push({ lang: lc, url }); };
    pushLang((rendered?.lang || homeParsed?.lang || '').toLowerCase() || null, homeUrl);
    for (const h of rendered?.hreflang || homeParsed?.hreflang || []) pushLang(String(h.lang).toLowerCase(), h.href);
    for (const l of rendered?.links || []) {
      const t = (l.text || '').trim().toLowerCase();
      if (/^(en|eng|english|ru|rus|русский|de|deutsch|fr|français|es|español|uk|укр|українська|kz|қаз|қазақша|中文|zh)$/i.test(t)) {
        const map = { eng: 'en', english: 'en', rus: 'ru', 'русский': 'ru', deutsch: 'de', 'français': 'fr', 'español': 'es', 'укр': 'uk', 'українська': 'uk', 'қаз': 'kk', 'қазақша': 'kk', kz: 'kk', '中文': 'zh' };
        pushLang(map[t] || t, canon(l.href));
      }
    }
    const beta = betaSignals(host, rendered, homeParsed, robots, robotsIsText, { ...(homeRaw.headers || {}), ...docHeaders }, homeLoad?.status ?? homeRaw.status);

    const selectedSet = new Set(out.map(s => s.url));
    const notSelected = [...cand.keys()].filter(u => !selectedSet.has(u));
    // named pages (--page / --pages-from): an unfinished sitemap does not make the selection partial
    const smPartial = !!sm.stopped && !explicitPages.length && !oldPages;
    const partial = partialCheck || smPartial || !menusDone || !burgerDone;
    const homeIncluded = out.some(s => s.url === homeUrl);
    const totalRequests = reqBase + requests;
    const progressUnits = done.length + Object.keys(cache.parsed).length + (sm.files?.length || 0) + out.filter(s => !s.unchecked).length;
    const result = {
      tool: 'crawl', version: U.VERSION, run, generated: U.nowIso(), partial,
      resume: partial ? { done, unchecked: out.filter(s => s.unchecked).map(s => s.pid), sitemaps_pending: sm.stopped ? (sm.pending || 0) : 0 } : null,
      progress_units: progressUnits,
      site: input, final_origin: (() => { try { return new URL(finalUrl).origin; } catch { return finalOrigin; } })(),
      stack: { cms: stack.cms, version: stack.version, cdn: stack.cdn, server: stack.server, signals: stack.signals, powered_by: stack.powered_by, store: stack.store },
      market: { ...market, accept_language: acceptLanguage || 'ru-RU,ru;q=0.9,en;q=0.8', ...(marketFlag ? { flag: marketFlag } : {}) }, vertical_guess: vertical.value, vertical_scores: vertical.scores,
      beta_signals: beta, languages,
      robots: { url: finalOrigin + '/robots.txt', status: robotsRes.status || null, is_text: robotsIsText, enforced: enforceRobots,
        sitemaps: robots?.sitemaps || [], clean_params: robots?.cleanParams || [], host: robots?.host || null,
        disallow_sample: (robots?.groups.find(g => g.agents.includes('*'))?.rules || []).filter(r => r.type === 'disallow' && r.path).map(r => r.path).slice(0, 15) },
      sitemaps: { files: sm.files.slice(0, 60), urls: sm.urls.length, stopped: !!sm.stopped, pending: sm.pending || 0 },
      nav_lists: {
        header: (rendered?.header || []).map(l => ({ text: l.text, href: l.href, level: l.level, hidden: l.hidden })),
        burger: (burger?.links || []).map(l => ({ text: l.text, href: l.href })),
        footer: (rendered?.footer || []).map(l => ({ text: l.text, href: l.href })),
        sitemap_html: sitemapHtml,
      },
      burger: burger ? { toggle: burger.toggle, source: burger.source, links: (burger.links || []).length } : null,
      home: { url: homeUrl, status: homeLoad?.status ?? homeRaw.status ?? null, final_url: finalUrl, blocked: homeBlocked, title: rendered?.title ?? homeParsed?.title ?? null,
        text_len: rendered?.textLen ?? null, load_ms: homeLoad?.ms ?? null, load_error: homeLoad?.ok === false ? (homeLoad.error || homeLoad.refused) : null,
        raw: { status: homeRaw.status || null, chain: homeRaw.chain || [], antibot: homeAntibot || null, error: homeRaw.error || null, bytes: homeRaw.bytes || 0,
          headers: Object.fromEntries(Object.entries(homeRaw.headers || {}).filter(([k]) => ['content-type', 'server', 'x-powered-by', 'x-robots-tag', 'cache-control', 'content-language', 'link', 'strict-transport-security'].includes(k))) },
        has_password_field: !!rendered?.hasPassword, jsonld_types: jsonld.slice(0, 20) },
      discovered: cand.size, by_template: byTemplate, signature_groups: signatureGroups.slice(0, 10),
      selected: out.map(s => ({ pid: s.pid, url: s.url, template: s.template, why: s.why, status: s.status ?? null, title: s.title ?? null, blocked: s.blocked ?? null, final_url: s.final_url ?? null, ...(s.auth_page ? { auth_page: true } : {}), ...(s.unchecked ? { unchecked: true } : {}) })),
      not_selected_sample: notSelected.slice(0, 40).map(u => ({ url: u, template: templateOf(u) })),
      skipped, documents, popups: browser.popups.length,
      limits: { pages: maxPages, depth, mode, explicit: explicitPages.length ? explicitPages : null, pages_from: pagesFrom, home_included: homeIncluded },
      requests: totalRequests, slot_wait_sec: slotWaitSec || 0,
    };
    U.writeJSON(U.insideRun(run, 'pages.json'), result);
    U.log(run, `crawl: ${totalRequests} запросов к сайту (вместе с браузером), найдено ${cand.size} адресов, выбрано ${out.length}${partial ? ' (частично)' : ''}${acceptLanguage ? ', Accept-Language: en' : ''}`);

    // summary
    const sec = Math.round((Date.now() - T0) / 1000);
    const lines = [];
    lines.push(T(`crawl: ${partial ? 'ЧАСТИЧНО' : 'готово'} за ${sec} с · найдено адресов ${cand.size} · выбрано ${out.length} из ${maxPages}`,
      `crawl: ${partial ? 'PARTIAL' : 'done'} in ${sec}s · URLs found ${cand.size} · selected ${out.length} of ${maxPages}`));
    if (slotWaitSec > 5) lines.push(T(`Ждал свободный браузер ${slotWaitSec} с (были заняты другими проверками Ревизора).`, `Waited ${slotWaitSec}s for a free browser.`));
    lines.push(T(`Главная: ${homeUrl} → код ${result.home.status ?? '—'}${homeBlocked ? ` · НЕДОСТУПНА: ${homeBlocked}` : ''}`, `Home: ${homeUrl} → status ${result.home.status ?? '—'}${homeBlocked ? ` · BLOCKED: ${homeBlocked}` : ''}`));
    if (!homeIncluded && explicitPages.length) lines.push(T('Главная в выборку не входит: взяты ровно страницы из --page (главную добавьте как --page /).', 'Home page is not in the selection: exactly the --page pages are taken (add --page / for the home page).'));
    lines.push(T(`Платформа: ${stack.cms || 'не определена'}${stack.version ? ' ' + stack.version : ''}${stack.store ? ' · магазин: ' + stack.store : ''}${stack.cdn ? ' · CDN/защита: ' + stack.cdn : ''}${stack.server ? ' · server: ' + stack.server : ''}`,
      `Platform: ${stack.cms || 'unknown'}${stack.version ? ' ' + stack.version : ''}${stack.store ? ' · shop: ' + stack.store : ''}${stack.cdn ? ' · CDN/protection: ' + stack.cdn : ''}${stack.server ? ' · server: ' + stack.server : ''}`));
    lines.push(T(`Рынок: ${market.value} (${market.why || '—'}) · тип сайта (догадка): ${vertical.value}${acceptLanguage ? ' · запросы на английском (рынок intl)' : ''}`, `Market: ${market.value} (${market.why || '—'}) · site type (guess): ${vertical.value}${acceptLanguage ? ' · requests in English (intl market)' : ''}`));
    lines.push(`robots.txt: ${robotsRes.status || '—'}${robotsIsText ? '' : T(' (не текст)', ' (not text)')}${robotsBlocksHome ? ' · Disallow: /' : ''} · sitemap: ${sm.files.length} ${T('файл(ов)', 'file(s)')}, ${sm.urls.length} ${T('адресов', 'URLs')}${sm.stopped ? T(' (не всё — бюджет)', ' (incomplete — budget)') : ''}`);
    lines.push(T(`Меню: шапка ${result.nav_lists.header.length}, бургер ${result.nav_lists.burger.length}${burger?.source && burger.source !== 'none' ? ` (${burger.source})` : ''}, подвал ${result.nav_lists.footer.length}, HTML-карта ${sitemapHtml.length}`,
      `Menus: header ${result.nav_lists.header.length}, burger ${result.nav_lists.burger.length}, footer ${result.nav_lists.footer.length}, HTML sitemap ${sitemapHtml.length}`));
    if (languages.length > 1) lines.push(T('Языки: ', 'Languages: ') + languages.map(l => l.lang).join(', '));
    if (beta.length) lines.push(T('Признаки беты: ', 'Beta signs: ') + beta.map(b => b.detail).join('; ').slice(0, 300));
    const tplTop = Object.entries(byTemplate).filter(([, b]) => b.estimate >= 2).sort((a, b) => b[1].estimate - a[1].estimate).slice(0, 5);
    if (tplTop.length) lines.push(T('Шаблоны: ', 'Templates: ') + tplTop.map(([t, b]) => `${t} ~${b.estimate}`).join(' · '));
    if (signatureGroups.length) lines.push(T(`Одинаковая вёрстка у одноуровневых адресов: ${signatureGroups.slice(0, 3).map(g => `${g.templates.slice(0, 3).join(', ')}${g.templates.length > 3 ? '…' : ''} (~${g.estimate} стр.)`).join('; ')}`,
      `Same layout on one-level URLs: ${signatureGroups.slice(0, 3).map(g => `${g.templates.slice(0, 3).join(', ')}${g.templates.length > 3 ? '…' : ''} (~${g.estimate} pages)`).join('; ')}`));
    lines.push(T('Выбрано:', 'Selected:'));
    for (const s of out.slice(0, 20)) lines.push(`  ${s.pid.padEnd(4)} ${String(s.status ?? '—').padEnd(3)} ${pathOf(s.url).slice(0, 60)} — ${s.why}${s.blocked ? ` [${s.blocked}${s.auth_page ? T(', вход — не защита', ', login — not protection') : ''}]` : ''}${s.unchecked ? T(' [не проверена]', ' [unchecked]') : ''}`);
    if (out.length > 20) lines.push(T(`  …и ещё ${out.length - 20}`, `  …and ${out.length - 20} more`));
    const skc = skipped.reduce((m, s) => { const k = s.why.startsWith('status_') ? 'status' : s.why; m[k] = (m[k] || 0) + 1; return m; }, {});
    if (skipped.length) lines.push(T('Пропущено: ', 'Skipped: ') + Object.entries(skc).map(([k, v]) => `${k} ${v}`).join(', '));
    lines.push(T(`Записано: ${join(run, 'pages.json')} · запросов к сайту ${totalRequests}`, `Written: ${join(run, 'pages.json')} · requests to the site ${totalRequests}`));
    if (partial) lines.push(T('Не успел за бюджет — запустите ту же команду ещё раз, продолжу с места остановки (готовое лежит в RUN/.cache/crawl.json).', 'Out of budget — run the same command again to continue (finished steps are cached).'));
    U.printAndSaveSummary(run, 'crawl', lines);
    return partial ? 75 : (process.exitCode || 0);
  } finally {
    try { await browser?.close(); } catch {}
    release();
  }
}

main().then(code => process.exit(code || 0)).catch(e => {
  console.error(T('crawl: сбой — ', 'crawl: failure — ') + (e?.stack || e));
  try { U.log(run, `crawl: сбой ${String(e?.message || e).slice(0, 200)}`); } catch {}
  process.exit(/браузер|browser|Chromium|Node/i.test(String(e?.message)) ? 2 : 1);
});
