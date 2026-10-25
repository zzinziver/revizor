// Revizor — shared helpers for all scripts (Node >= 22, no dependencies).
// Conventions every script follows:
//   node "<ROOT>/scripts/<name>.mjs" --run "<RUN>" [--pages home,p01] [--lang ru|en] [--help]
//   JSON results go to RUN/…, a short human summary (<= 40 lines) goes to stdout, progress to stderr.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, rmSync, statSync, readdirSync, utimesSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { createHash } from 'node:crypto';

export const VERSION = '1.0.1';
export { sleep };

// ---------- arguments ----------
// parseArgs(process.argv.slice(2), { boolean: ['pdf'], multi: ['page'], alias: { p: 'pages' } })
// → { _: [positional…], run: '…', pages: '…', page: ['…'], pdf: true }
export function parseArgs(argv, spec = {}) {
  const bool = new Set(spec.boolean || []);
  const multi = new Set(spec.multi || []);
  const alias = spec.alias || {};
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-') { out._.push(a); continue; }
    a = a.replace(/^--?/, '');
    let key = a, val;
    const eq = a.indexOf('=');
    if (eq >= 0) { key = a.slice(0, eq); val = a.slice(eq + 1); }
    key = alias[key] || key;
    if (key.startsWith('no-') && bool.has(key.slice(3))) { out[key.slice(3)] = false; continue; }
    if (val === undefined) {
      if (bool.has(key)) val = true;
      else if (i + 1 < argv.length && !(argv[i + 1].startsWith('--'))) val = argv[++i];
      else val = true;
    }
    if (bool.has(key) && typeof val === 'string') val = !/^(0|false|no|off)$/i.test(val);
    // Git Bash on Windows rewrites "/contacts" into "C:/Program Files/Git/contacts" — undo it.
    if (typeof val === 'string') val = val.replace(/^[A-Za-z]:[\/\\]Program Files[\/\\]Git(?=[\/\\])/i, '');
    if (multi.has(key)) (out[key] ||= []).push(val); else out[key] = val;
  }
  return out;
}

export function listArg(v) {
  if (v === undefined || v === null || v === true) return [];
  return (Array.isArray(v) ? v : [v]).flatMap(x => String(x).split(',')).map(s => s.trim()).filter(Boolean);
}

// ---------- i18n ----------
const MESSAGES = {
  ru: {
    need_run: 'Нужен аргумент --run "<папка прогона>".',
    need_url: 'Нужен адрес сайта: --url https://example.ru',
    no_pages: 'Нет pages.json — сначала запустите crawl.mjs.',
    done: 'Готово',
    written: 'Записано',
    errors: 'Ошибки',
    not_checked: 'Не проверено',
    antibot: 'Сайт закрылся защитой от ботов (капча/челлендж) — эту страницу не снимали. Капчу не проходим.',
    rate_limited: 'Сайт просит снизить частоту запросов (429) — ждём минуту.',
  },
  en: {
    need_run: 'Missing --run "<run folder>".',
    need_url: 'Missing site URL: --url https://example.com',
    no_pages: 'pages.json not found — run crawl.mjs first.',
    done: 'Done',
    written: 'Written',
    errors: 'Errors',
    not_checked: 'Not checked',
    antibot: 'The site answered with an anti-bot challenge/captcha — page skipped. We never solve captchas.',
    rate_limited: 'Site asked to slow down (429) — waiting a minute.',
  },
};
export function msg(key, lang = 'ru') { return (MESSAGES[lang] || MESSAGES.ru)[key] || MESSAGES.ru[key] || key; }
export function langOf(args) { return args.lang === 'en' ? 'en' : 'ru'; }

// ---------- files ----------
export function ensureDir(p) { mkdirSync(p, { recursive: true }); return p; }
export function readJSON(p, fallback = undefined) {
  try { return JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')); }
  catch (e) { if (fallback !== undefined) return fallback; throw new Error(`Не читается JSON ${p}: ${e.message}`); }
}
export function writeJSON(p, data) { // atomic
  ensureDir(dirname(p));
  const tmp = p + '.tmp-' + process.pid;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  renameSync(tmp, p);
  return p;
}
export function writeText(p, text) { ensureDir(dirname(p)); writeFileSync(p, text, 'utf8'); return p; }
export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
export function md5(buf) { return createHash('md5').update(buf).digest('hex'); }

// ---------- run folder ----------
export function requireRun(args) {
  const lang = langOf(args);
  if (!args.run || args.run === true) { console.error(msg('need_run', lang)); process.exit(2); }
  const run = resolve(String(args.run));
  ensureDir(run);
  return run;
}
export function runPath(run, ...p) { return join(run, ...p); }
export function loadPages(run, args = {}) {
  const p = join(run, 'pages.json');
  if (!existsSync(p)) { console.error(msg('no_pages', langOf(args))); process.exit(2); }
  const pages = readJSON(p);
  const only = listArg(args.pages);
  const sel = pages.selected || [];
  return only.length ? sel.filter(x => only.includes(x.pid)) : sel;
}
export function loadBrief(run) { return readJSON(join(run, 'brief.json'), {}); }

export function log(run, line) {
  try { appendFileSync(join(run, 'log.md'), `- ${new Date().toISOString()} ${line}\n`, 'utf8'); } catch { /* ignore */ }
}
export function progress(...a) { process.stderr.write(a.join(' ') + '\n'); }

export function measureHeader(tool, run, extra = {}) {
  return { tool, version: VERSION, run, generated: new Date().toISOString(), pages: [], summary: {}, items: [], errors: [], not_checked: [], ...extra };
}

// ---------- URLs ----------
export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('empty url');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  u.hash = '';
  if (!u.pathname) u.pathname = '/';
  return u.toString();
}
export function hostOf(url) { try { return new URL(url).hostname.toLowerCase(); } catch { return ''; } }
export function stripWww(h) { return h.replace(/^www\./, ''); }
export function sameSite(a, b) { return stripWww(hostOf(a)) === stripWww(hostOf(b)); }
export function pidFor(index) { return index === 0 ? 'home' : 'p' + String(index).padStart(2, '0'); }
export function runDirName(url, date = new Date()) {
  const p = n => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}`;
  return `${stripWww(hostOf(url)).replace(/[^a-z0-9.-]/gi, '_')}-${stamp}`;
}

// ---------- polite fetch ----------
export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
export const BOT_UA = {
  yandex: 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
  google: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  telegram: 'TelegramBot (like TwitterBot)',
  facebook: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
};

const hostState = new Map(); // host → { active, last, coolUntil }
function hostEntry(host) {
  const st = hostState.get(host) || { active: 0, last: 0, coolUntil: 0 };
  hostState.set(host, st);
  return st;
}
// Waits until the host has a free slot, the minimal gap has passed and no cool-down is active.
// The check and the increment happen without an await in between, so concurrent callers can't both pass.
async function hostSlot(host, { maxPerHost = 2, minGapMs = 350 } = {}) {
  const st = hostEntry(host);
  while (true) {
    const now = Date.now();
    if (st.coolUntil > now) { await sleep(Math.min(st.coolUntil - now, 5000)); continue; }
    if (st.active >= maxPerHost) { await sleep(50); continue; }
    const gap = now - st.last;
    if (gap < minGapMs) { await sleep(minGapMs - gap + Math.floor(Math.random() * 200)); continue; }
    break;
  }
  st.active++; st.last = Date.now();
  return () => { st.active--; st.last = Date.now(); };
}
// After 429 / anti-bot pressure: pause ALL requests of this process to the host.
export function coolDownHost(host, ms = 60000) { const st = hostEntry(host); st.coolUntil = Math.max(st.coolUntil, Date.now() + ms); }

/**
 * politeFetch(url, opts) — GET/HEAD only. Follows redirects manually and records the chain.
 * opts: { method:'GET'|'HEAD', ua, headers, timeoutMs, maxRedirects, maxBytes, retries, accept }
 * → { ok, status, url (final), chain:[{url,status,location}], headers:{}, body (string|undefined), bytes, ms, error, antibot }
 */
export async function politeFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') throw new Error('politeFetch: only GET/HEAD are allowed');
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxRedirects = opts.maxRedirects ?? 10;
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  let retries = opts.retries ?? 1;
  const chain = [];
  let current = url;
  const started = Date.now();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const skip = await safetySkip(current, opts);
    if (skip) return { ok: false, status: 0, url: current, chain, headers: {}, error: `skipped_${skip}`, skipped: skip, ms: Date.now() - started };
    const release = await hostSlot(hostOf(current), opts);
    const dispatcher = opts.allowPrivate ? undefined : await pinnedDispatcher();
    let res;
    // one timer covers headers AND body: a slow body must not hang the caller
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      res = await fetch(current, {
        method, redirect: 'manual', signal: ctl.signal, ...(dispatcher ? { dispatcher } : {}),
        headers: { 'user-agent': opts.ua || CHROME_UA, 'accept': opts.accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'accept-language': opts.acceptLanguage || 'ru-RU,ru;q=0.9,en;q=0.8', ...(opts.headers || {}) },
      });
    } catch (e) {
      clearTimeout(t); release();
      const fe = fetchErr(e, timeoutMs);
      if (fe.skipped) return { ok: false, status: 0, url: current, chain, headers: {}, ...fe, ms: Date.now() - started };
      if (retries-- > 0) { await sleep(1500); hop--; continue; }
      return { ok: false, status: 0, url: current, chain, headers: {}, ...fe, ms: Date.now() - started };
    }
    release();
    const headers = Object.fromEntries(res.headers.entries());
    if (res.headers.getSetCookie) headers['set-cookie'] = res.headers.getSetCookie();
    const loc = res.headers.get('location');
    chain.push({ url: current, status: res.status, location: loc || undefined });
    if (res.status === 429) {
      coolDownHost(hostOf(current), 60000); // every caller of this host waits, not only this one
      if (retries-- > 0) {
        clearTimeout(t); try { await res.body?.cancel(); } catch {}
        progress(msg('rate_limited', opts.lang));
        hop--; chain.pop(); continue; // hostSlot() now waits out the cool-down
      }
    }
    if (res.status >= 300 && res.status < 400 && loc) {
      clearTimeout(t); try { await res.body?.cancel(); } catch {}
      current = new URL(loc, current).toString();
      continue;
    }
    let body, bytes = 0, truncated = false, bodyError = null;
    if (method === 'GET' && res.body) {
      const chunks = []; let kept = 0;
      try {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (kept < maxBytes) { const part = value.subarray(0, maxBytes - kept); chunks.push(part); kept += part.length; }
          if (bytes >= maxBytes) { truncated = true; try { await reader.cancel(); } catch {} break; }
        }
      } catch (e) { bodyError = e.name === 'AbortError' ? `body timeout ${timeoutMs}ms` : e.message; }
      const all = Buffer.concat(chunks);
      body = all.toString('utf8');
      if (opts.binary) { clearTimeout(t); return { ok: res.ok && !bodyError, status: res.status, url: current, chain, headers, body, buf: all, bytes, truncated, ms: Date.now() - started, antibot: null, ...(bodyError ? { error: bodyError } : {}) }; }
    }
    clearTimeout(t);
    const antibot = detectAntibot(res.status, headers, body);
    return { ok: res.ok && !bodyError, status: res.status, url: current, chain, headers, body, bytes, truncated, ms: Date.now() - started, antibot, ...(bodyError ? { error: bodyError } : {}) };
  }
  return { ok: false, status: 0, url: current, chain, headers: {}, error: 'too many redirects', ms: Date.now() - started };
}

// Hosts that may resolve to private addresses (only the reviewed site itself when it is local, e.g. the demo).
const ALLOWED_PRIVATE = new Set();
// A site on loopback (local dev server, the demo) may use its loopback neighbours (another port, localhost vs
// 127.0.0.1) — they are the same machine the user asked us to review. Other private addresses stay blocked.
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];
export function allowPrivateHost(host) {
  if (!host) return;
  const h = String(host).toLowerCase();
  ALLOWED_PRIVATE.add(h);
  if (LOOPBACK.includes(h) || /^127\./.test(h) || h.endsWith('.localhost')) LOOPBACK.forEach(x => ALLOWED_PRIVATE.add(x));
}
export function isAllowedPrivate(host) { return ALLOWED_PRIVATE.has(String(host || '').toLowerCase()); }
// DNS pinning: safetySkip() resolves the host once, then fetch() resolves it again — a host with a short TTL could
// answer "public" to the check and "127.0.0.1" to the connection. The guarded dispatcher re-checks the very addresses
// the socket connects to. Node bundles undici without exporting it: its Agent class is taken from the global
// dispatcher, which a pre-aborted fetch creates without touching the network. No Agent → plain fetch (check above only).
let guardedDispatcher; // undefined: not built yet; null: unavailable
async function pinnedDispatcher() {
  if (guardedDispatcher !== undefined) return guardedDispatcher;
  guardedDispatcher = null;
  try {
    const S = Symbol.for('undici.globalDispatcher.1');
    if (!globalThis[S]) await fetch('http://127.0.0.1:9/', { signal: AbortSignal.abort() }).catch(() => {});
    const Agent = globalThis[S]?.constructor;
    if (typeof Agent !== 'function') return null;
    const dns = await import('node:dns');
    const lookup = (host, o, cb) => {
      if (typeof o === 'function') { cb = o; o = {}; }
      dns.lookup(host, { ...o, all: true }, (err, addrs) => {
        if (err) return cb(err);
        const h = String(host).toLowerCase();
        if (!isAllowedPrivate(h) && addrs.some(a => isPrivateIp(a.address))) {
          return cb(Object.assign(new Error(`${host} resolved to a private address`), { code: 'EREVIZOR_PRIVATE' }));
        }
        if (o.all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
      });
    };
    guardedDispatcher = new Agent({ connect: { lookup } });
  } catch { guardedDispatcher = null; }
  return guardedDispatcher;
}
// error_code for callers: ENOTFOUND, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, EREVIZOR_PRIVATE…
function errCode(e) { return e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.code || (e?.name === 'AbortError' ? 'TIMEOUT' : null); }
function fetchErr(e, timeoutMs, opts) {
  const code = errCode(e);
  if (code === 'EREVIZOR_PRIVATE') return { error: 'skipped_private', skipped: 'private', error_code: code };
  return { error: e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message, error_code: code };
}
async function safetySkip(url, opts = {}) {
  if (!opts.allowRisky && isRiskyGet(url)) return 'risky';
  const h = hostOf(url);
  if (!opts.allowPrivate && !isAllowedPrivate(h) && await resolvesPrivate(h)) return 'private';
  return null;
}

export function detectAntibot(status, headers = {}, body = '') {
  const b = (body || '').slice(0, 20000).toLowerCase();
  const server = String(headers.server || '').toLowerCase();
  const denied = status === 403 || status === 503 || status === 429;
  if (denied && /(cloudflare|ddos-guard|qrator|stormwall|variti|servicepipe)/.test(server)) return server;
  if (String(body || '').length >= 60000) return null; // big real pages are not challenge walls
  // challenge pages of anti-bot services
  if (/cf-chl|challenge-platform|just a moment\.\.\.|ddos-guard|checking your browser|captcha-delivery|\/showcaptcha|servicepipe|variti|qrator/.test(b)) return 'challenge';
  // a captcha widget inside an ordinary page (a form with SmartCaptcha/reCAPTCHA) is not a block:
  // count it only on a denied status or on a near-empty page that is nothing but the captcha
  if (/smartcaptcha|smart-captcha|g-recaptcha|hcaptcha|cf-turnstile/.test(b)) {
    const text = b.replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // a short landing whose form carries the captcha is a page, not a wall
    const formWithFields = /<form[\s\S]*?<(input|textarea|select)\b(?![^>]*type\s*=\s*["']?(hidden|submit)\b)/.test(b);
    if (denied || (text.length < 300 && !formWithFields)) return 'challenge';
  }
  return null;
}

// ---------- safety: risky GETs and private addresses ----------
// On badly built sites a plain GET can act: /logout, /cart/add?id=, ?action=delete, /unsubscribe?token=…
// Such URLs are never opened by crawl, link checks, probe or navigations.
const RISKY_PATH = /(^|[\/_.-])(log-?out|sign-?out|exit|vyhod|vihod|delete|remove|udalit|unsubscribe|otpisat|confirm|podtverd|activate|activation|vote|golos|like|rate|reserve|bron|book(ing)?-?confirm|checkout|oformlenie|order\/(new|create|confirm)|cart\/(add|remove|clear|delete)|basket\/(add|remove|clear)|korzina\/(add|udal)|add-?to-?cart|wishlist\/(add|remove)|compare\/(add|remove)|subscribe|callback\/send|send-?form|download\/token)([\/_.?-]|$)/i;
const RISKY_QUERY = /(^|[?&])(action|act|do|op|cmd|token|logout|delete|remove|add2basket|add-to-cart|add_to_cart|confirm|unsubscribe|vote|ajax_action|sessid)=/i;
// /order/5/cancel, /unsub/x, /oauth/authorize, /resend; bare ?logout / ?exit
const RISKY_PATH_2 = /(^|[/_.-])(cancel|unsub|oauth|authorize|resend)([/_.?-]|$)/i;
const RISKY_QUERY_2 = /(^|[?&])(logout|log-out|signout|sign-out|exit)(&|=|$)/i;
// with parameters only: /promo/apply?code=x, /auth/callback?code=1 (a bare /callback is usually a "call me back" page)
const RISKY_PATH_Q = /(^|[/_.-])(apply|callback)([/_.?-]|$)/i;
export function isRiskyGet(url) {
  try {
    const u = new URL(url);
    return RISKY_PATH.test(u.pathname) || RISKY_QUERY.test(u.search) || RISKY_PATH_2.test(u.pathname) || RISKY_QUERY_2.test(u.search)
      || (u.search.length > 1 && RISKY_PATH_Q.test(u.pathname));
  } catch { return true; }
}

// Canonical form of an IP literal through the WHATWG URL parser: '0x7f.1' → '127.0.0.1', '::ffff:127.0.0.1' →
// '::ffff:7f00:1', '0:0:0:0:0:0:0:1' → '::1'. Returns null when the string is not an IP literal.
function canonicalIp(ip) {
  let s = String(ip || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, ''); // zone id: fe80::1%eth0
  if (!s) return null;
  if (s.includes(':')) {
    try { const h = new URL(`http://[${s}]/`).hostname; return { v: 6, s: h.replace(/^\[|\]$/g, '') }; } catch { return null; }
  }
  if (!/^[0-9a-fx.]+$/.test(s)) return null;
  try { const h = new URL(`http://${s}/`).hostname; return /^\d+\.\d+\.\d+\.\d+$/.test(h) ? { v: 4, s: h } : null; } catch { return null; }
}
function v6Words(s) { // canonical IPv6 → 8 numbers
  const [head, tail = null] = s.split('::');
  const part = x => (x ? x.split(':').map(w => parseInt(w, 16)) : []);
  const a = part(head), b = tail === null ? [] : part(tail);
  return tail === null ? a : [...a, ...new Array(8 - a.length - b.length).fill(0), ...b];
}
const v4Of = (hi, lo) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join('.');
function isPrivateV4(s) {
  const [a, b, c] = s.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||           // this-net, private, loopback, multicast + reserved
    (a === 100 && b >= 64 && b <= 127) ||                           // CGNAT 100.64/10
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||              // 192.0.0/24 IETF, 192.0.2/24 TEST-NET-1
    (a === 192 && b === 88 && c === 99) ||                          // 6to4 relay anycast
    (a === 198 && (b === 18 || b === 19)) ||                        // 198.18/15 benchmarking
    (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113); // TEST-NET-2/3
}
/**
 * isPrivateIp(ip) — true for addresses outside the public internet: loopback, private, link-local, CGNAT, reserved,
 * and every IPv6 form that carries such an IPv4 inside (::ffff:7f00:1, ::127.0.0.1, 64:ff9b::a00:1, 2002:7f00:1::…).
 * Accepts brackets and any spelling the URL parser understands; a non-IP string → false.
 */
export function isPrivateIp(ip = '') {
  const c = canonicalIp(ip);
  if (!c) return false;
  if (c.v === 4) return isPrivateV4(c.s);
  const w = v6Words(c.s);
  if (w.length !== 8 || w.some(n => Number.isNaN(n))) return true; // unparsable — refuse
  const [w0, w1, w2, w3, w4, w5, w6, w7] = w;
  const zero = (...xs) => xs.every(x => x === 0);
  if (zero(w0, w1, w2, w3, w4, w5)) return (w6 === 0 && w7 <= 1) || isPrivateV4(v4Of(w6, w7)); // ::, ::1, ::a.b.c.d (compat)
  if (zero(w0, w1, w2, w3, w4) && w5 === 0xffff) return isPrivateV4(v4Of(w6, w7));             // ::ffff:a.b.c.d (mapped)
  if (zero(w0, w1, w2, w3) && w4 === 0xffff && w5 === 0) return isPrivateV4(v4Of(w6, w7));     // ::ffff:0:a.b.c.d (SIIT)
  if (w0 === 0x64 && w1 === 0xff9b) return (w2 !== 0 || w3 !== 0 || w4 !== 0 || w5 !== 0) || isPrivateV4(v4Of(w6, w7)); // NAT64; 64:ff9b:1::/48 local
  if (w0 === 0x2002) return isPrivateV4(v4Of(w1, w2));                                        // 6to4
  if (w0 === 0x2001 && w1 === 0) return true;                                                   // Teredo: tunnels to anything
  if (w0 === 0x2001 && w1 === 0xdb8) return true;                                               // documentation
  if (w0 === 0x100 && zero(w1, w2, w3)) return true;                                            // discard-only 100::/64
  if ((w0 & 0xfe00) === 0xfc00) return true;                                                    // unique local fc00::/7
  if ((w0 & 0xffc0) === 0xfe80 || (w0 & 0xffc0) === 0xfec0) return true;                       // link-local, old site-local
  if ((w0 & 0xff00) === 0xff00) return true;                                                    // multicast
  return false;
}

const dnsCache = new Map();
export async function resolvesPrivate(host) {
  host = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (canonicalIp(host)) return isPrivateIp(host); // any IP spelling: 127.1, 0x7f000001, ::ffff:7f00:1
  if (dnsCache.has(host)) return dnsCache.get(host);
  let res = false;
  try {
    const { lookup } = await import('node:dns/promises');
    const all = await lookup(host, { all: true });
    // any private address is enough to refuse: a mixed answer can still route the request into the user's network
    res = all.some(a => isPrivateIp(a.address));
  } catch { res = false; }
  dnsCache.set(host, res);
  return res;
}

// ---------- concurrency ----------
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { error: e.message }; } }
  });
  await Promise.all(workers);
  return out;
}

// Machine-wide browser slots (≤ 2 headless browsers at once across all Revizor scripts/agents).
const SLOT_DIR = join(tmpdir(), 'revizor-slots');
// Slot file = "<pid> <token>". A slot is ours only while the file still holds our token: release and the heartbeat
// never touch a file that another process has taken over (after a stale sweep), and release runs once.
export function pidAlive(pid) {
  pid = Number(pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function readSlot(f) { try { const [pid, token] = readFileSync(f, 'utf8').trim().split(/\s+/); return { pid: Number(pid), token }; } catch { return null; } }
// A script that needs every slot at once (perf) announces it: others then stop taking freed slots, so it is not
// starved by scripts that grab one slot each. The flag is held by a live pid and refreshed; stale flags are ignored.
const EXCL = join(SLOT_DIR, 'exclusive');
export function announceExclusive() {
  ensureDir(SLOT_DIR);
  try { writeFileSync(EXCL, `${process.pid} ${Date.now()}`); } catch {}
  const beat = setInterval(() => { try { if (readSlot(EXCL)?.pid === process.pid) { const t = new Date(); utimesSync(EXCL, t, t); } } catch {} }, 30000);
  beat.unref?.();
  let done = false;
  const release = () => {
    if (done) return; done = true; clearInterval(beat);
    try { if (readSlot(EXCL)?.pid === process.pid) rmSync(EXCL, { force: true }); } catch {}
    process.removeListener('exit', release);
  };
  process.once('exit', release);
  return release;
}
function exclusiveByOther() {
  try {
    const cur = readSlot(EXCL);
    if (!cur || cur.pid === process.pid) return false;
    if (!pidAlive(cur.pid)) { rmSync(EXCL, { force: true }); return false; }
    return Date.now() - statSync(EXCL).mtimeMs < 10 * 60 * 1000;
  } catch { return false; }
}
function holdsExclusive() { return readSlot(EXCL)?.pid === process.pid; }
// FIFO queue: a waiting process keeps a ticket file queue/<born>-<pid>, refreshed on every poll (1–2 s). A free slot
// goes to the oldest live tickets first: a process takes one only when fewer older tickets wait than slots are free.
// A call with waitMs: 0 has no ticket and yields to every waiter. Tickets of dead pids or not refreshed for 15 s are
// dropped, so a process that stopped waiting never blocks the queue. The holder of the exclusive flag skips the queue.
const QDIR = join(SLOT_DIR, 'queue');
const TICKET_STALE_MS = 15000;
let qBorn = 0, qWaiters = 0, qExitHook = false;
const qFile = () => join(QDIR, `${String(qBorn).padStart(15, '0')}-${process.pid}`);
function ticketTouch() {
  ensureDir(QDIR);
  const f = qFile();
  try { if (existsSync(f)) { const t = new Date(); utimesSync(f, t, t); } else writeFileSync(f, `${process.pid} ${qBorn}`); } catch {}
}
function ticketDrop() { if (qBorn) { try { rmSync(qFile(), { force: true }); } catch {} qBorn = 0; } }
function waitersAhead(born) { // born = Infinity for a call without a ticket
  let n = 0;
  let names = []; try { names = readdirSync(QDIR); } catch { return 0; }
  for (const name of names) {
    const m = /^(\d+)-(\d+)$/.exec(name); if (!m) continue;
    const b = Number(m[1]), pid = Number(m[2]);
    if (pid === process.pid) continue;
    const f = join(QDIR, name);
    let fresh = false; try { fresh = Date.now() - statSync(f).mtimeMs < TICKET_STALE_MS; } catch { continue; }
    if (!fresh || !pidAlive(pid)) { try { rmSync(f, { force: true }); } catch {} continue; }
    if (b < born || (b === born && pid < process.pid)) n++;
  }
  return n;
}
function freeSlots(max, staleMs) {
  let n = 0;
  for (let k = 0; k < max; k++) {
    const f = join(SLOT_DIR, `slot-${k}`);
    try {
      if (!existsSync(f)) { n++; continue; }
      const cur = readSlot(f);
      if ((cur && cur.pid !== process.pid && !pidAlive(cur.pid)) || Date.now() - statSync(f).mtimeMs > staleMs) n++;
    } catch { n++; }
  }
  return n;
}
/**
 * acquireBrowserSlot({ max = 2, staleMs, waitMs }) → release() with .owned() and .slot. At most `max` browsers on the
 * machine across all Revizor processes; waiting callers are served first come, first served (see the queue above).
 * Throws { code: 'SLOT_TIMEOUT' } after waitMs (0 = one try, no place in the queue).
 */
export async function acquireBrowserSlot({ max = Number(process.env.REVIZOR_MAX_BROWSERS || 2), staleMs = 6 * 60 * 1000, waitMs = 15 * 60 * 1000 } = {}) {
  ensureDir(SLOT_DIR);
  const started = Date.now();
  let queued = false;
  const leaveQueue = (got) => {
    if (!queued) return; queued = false; qWaiters--;
    if (got && qWaiters === 0) ticketDrop(); // on timeout the ticket goes stale by itself (a quick retry keeps its place)
  };
  try {
    const r = await acquireLoop();
    leaveQueue(true);
    return r;
  } catch (e) { leaveQueue(false); throw e; }

  async function acquireLoop() {
  while (true) {
    const myTurn = !exclusiveByOther() && (holdsExclusive() || waitersAhead(queued ? qBorn : Infinity) < freeSlots(max, staleMs));
    for (let k = 0; k < max && myTurn; k++) {
      const f = join(SLOT_DIR, `slot-${k}`);
      const token = createHash('sha1').update(`${process.pid}:${k}:${Date.now()}:${Math.random()}`).digest('hex').slice(0, 12);
      try {
        if (existsSync(f)) {
          const cur = readSlot(f);
          const dead = cur && cur.pid !== process.pid && !pidAlive(cur.pid);
          if (dead || Date.now() - statSync(f).mtimeMs > staleMs) rmSync(f, { force: true });
        }
        writeFileSync(f, `${process.pid} ${token}`, { flag: 'wx' });
      } catch { continue; /* taken */ }
      // two processes may sweep the same stale file at once — the later writer wins, the other one backs off
      await sleep(60 + Math.floor(Math.random() * 60));
      if (readSlot(f)?.token !== token) continue;
      let released = false;
      const owned = () => !released && readSlot(f)?.token === token;
      const beat = setInterval(() => {
        if (!owned()) { clearInterval(beat); return; }
        try { const t = new Date(); utimesSync(f, t, t); } catch {}
      }, 60000);
      beat.unref?.();
      const release = () => {
        if (released) return;
        const mine = owned();
        released = true; clearInterval(beat);
        process.removeListener('exit', release);
        if (mine) { try { rmSync(f, { force: true }); } catch {} }
      };
      release.owned = owned;
      release.slot = k;
      process.once('exit', release);
      return release;
    }
    if (Date.now() - started > waitMs) { const e = new Error(`Нет свободного слота браузера ${Math.max(1, Math.round(waitMs / 60000))} мин — другие проверки заняли браузеры; повторите позже или завершите зависшие проверки.`); e.code = 'SLOT_TIMEOUT'; throw e; }
    if (!queued && waitMs > 0) {
      queued = true; qWaiters++;
      // keep the place of a ticket that is still fresh (the caller retries after a short timeout)
      let keep = false; try { keep = qBorn > 0 && Date.now() - statSync(qFile()).mtimeMs < TICKET_STALE_MS; } catch {}
      if (!keep) { if (qBorn) ticketDrop(); qBorn = Date.now(); if (!qExitHook) { qExitHook = true; process.once('exit', ticketDrop); } }
    }
    if (queued) ticketTouch();
    await sleep(1000 + Math.floor(Math.random() * 1000));
  }
  }
}

// Temp browser profiles are named revizor-profile-<pid>-XXXXXX. A profile is swept when its owner process is gone
// (any age over a minute) or, for unnamed/legacy ones, after maxAgeMs. Live owners are never touched.
export function profileOwnerPid(name) { const m = /^revizor-profile-(\d+)-/.exec(name); return m ? Number(m[1]) : null; }
export function staleProfileDirs(maxAgeMs = 10 * 60 * 1000) {
  const out = [];
  try {
    for (const name of readdirSync(tmpdir())) {
      if (!name.startsWith('revizor-profile-')) continue;
      const p = join(tmpdir(), name);
      let age = 0; try { age = Date.now() - statSync(p).mtimeMs; } catch { continue; }
      const pid = profileOwnerPid(name);
      if (pid === process.pid) continue;
      if (pid ? (!pidAlive(pid) && age > 60000) : age > maxAgeMs) out.push(p);
    }
  } catch {}
  return out;
}
export function cleanupStaleProfiles(maxAgeMs) {
  for (const p of staleProfileDirs(maxAgeMs)) { try { rmSync(p, { recursive: true, force: true }); } catch {} }
}

// ---------- robots.txt ----------
export function parseRobots(text = '') {
  const groups = []; let cur = null; const sitemaps = []; const cleanParams = []; let host = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const k = m[1].toLowerCase(), v = m[2].trim();
    if (k === 'user-agent') { if (!cur || cur.rules.length) { cur = { agents: [], rules: [] }; groups.push(cur); } cur.agents.push(v.toLowerCase()); }
    else if (k === 'allow' || k === 'disallow') { if (!cur) { cur = { agents: ['*'], rules: [] }; groups.push(cur); } cur.rules.push({ type: k, path: v }); }
    else if (k === 'sitemap') sitemaps.push(v);
    else if (k === 'clean-param') cleanParams.push(v);
    else if (k === 'host') host = v;
  }
  return { groups, sitemaps, cleanParams, host };
}
function robotsRuleMatch(path, rule) {
  if (!rule) return false;
  const re = new RegExp('^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
  return re.test(path);
}
export function robotsAllows(robots, url, agent = '*') {
  if (!robots) return true;
  const path = (() => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } })();
  const a = agent.toLowerCase();
  const group = robots.groups.find(g => g.agents.some(x => x !== '*' && a.includes(x))) || robots.groups.find(g => g.agents.includes('*'));
  if (!group) return true;
  let best = null;
  for (const r of group.rules) {
    if (r.type === 'disallow' && r.path === '') continue;
    if (robotsRuleMatch(path, r.path) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.type === 'allow'))) best = r;
  }
  return !best || best.type === 'allow';
}

// ---------- sitemaps ----------
// fetchSitemaps(['https://…/sitemap.xml'], { limitUrls: 50000, limitFiles: 50 })
//   → { urls:[{loc, lastmod, alternates?:[{hreflang, href}]}], files:[{url,status,count,error,error_code?}] }
// alternates: <xhtml:link rel="alternate" hreflang="…" href="…"/> of that <url> (any prefix); only when present.
// opts.deadline (epoch ms): stop early and return { partial: true } so callers can respect --budget-sec.
export async function fetchSitemaps(seeds, { limitUrls = 50000, limitFiles = 50, lang, deadline = 0 } = {}) {
  const queue = [...new Set(seeds)];
  const seen = new Set(); const urls = []; const files = [];
  let partial = false;
  while (queue.length && files.length < limitFiles && urls.length < limitUrls) {
    if (deadline && Date.now() > deadline) { partial = true; break; }
    const sm = queue.shift();
    if (seen.has(sm)) continue; seen.add(sm);
    const isGz = /\.gz($|\?)/i.test(sm);
    const r = await politeFetch(sm, { accept: 'application/xml,text/xml,*/*', lang, maxBytes: 50 * 1024 * 1024, binary: isGz });
    let text = r.body || '';
    if (r.ok && r.buf && (isGz || String(r.headers['content-type'] || '').includes('gzip'))) {
      // same polite, timed, safety-checked request — just decompressed here
      try { text = gunzipSync(r.buf, { maxOutputLength: 50 * 1024 * 1024 }).toString('utf8'); } catch { /* not really gzip — keep as text */ }
    }
    const rec = { url: sm, status: r.status, count: 0, error: r.error, ...(r.error_code ? { error_code: r.error_code } : {}) };
    if (r.ok) {
      const isIndex = /<sitemapindex/i.test(text);
      const locs = [...text.matchAll(/<(?:sitemap|url)>([\s\S]*?)<\/(?:sitemap|url)>/gi)].map(m => {
        const loc = (m[1].match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i) || [])[1];
        const lastmod = (m[1].match(/<lastmod>\s*([\s\S]*?)\s*<\/lastmod>/i) || [])[1];
        if (!loc) return null;
        const it = { loc: decodeXml(loc.trim()), lastmod: lastmod?.trim() };
        const alt = [];
        for (const [tag] of m[1].matchAll(/<(?:[\w-]+:)?link\b[^>]*>/gi)) {
          const attr = n => { const a = tag.match(new RegExp(`\\s${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')); return a ? (a[1] ?? a[2]) : undefined; };
          const rel = attr('rel'), hreflang = attr('hreflang'), href = attr('href');
          if (href && hreflang && (!rel || /alternate/i.test(rel)) && alt.length < 300) alt.push({ hreflang: hreflang.trim(), href: decodeXml(href.trim()) });
        }
        if (alt.length) it.alternates = alt;
        return it;
      }).filter(Boolean);
      rec.count = locs.length; rec.index = isIndex;
      if (isIndex) for (const l of locs) queue.push(l.loc);
      else for (const l of locs) { if (urls.length < limitUrls) urls.push(l); }
    }
    files.push(rec);
  }
  return { urls, files, partial, pending: partial ? queue.length : 0 };
}
export function decodeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

// ---------- text helpers ----------
export function normText(s = '') { // for quote matching: ё→е, quotes, dashes, nbsp, spaces, case
  return String(s).toLowerCase().replace(/ё/g, 'е').replace(/[«»„“”"']/g, '"').replace(/[‐-―−]/g, '-')
    .replace(/[  ⁠‑]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function words(s = '') { return normText(s).split(/[^\p{L}\p{N}-]+/u).filter(Boolean); }
export function shingles(s, n = 5) {
  const w = words(s); const out = new Set();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
}
export function quoteOk(q, maxWords = 15) { return words(q).length <= maxWords; }

// ---------- misc ----------
export function nowIso() { return new Date().toISOString(); }
export function fmtBytes(n) { if (!n && n !== 0) return '—'; const u = ['Б', 'КБ', 'МБ', 'ГБ']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; }
export function pct(a, b) { return b ? Math.round(1000 * a / b) / 10 : 0; }
export function median(arr) { const a = arr.filter(x => typeof x === 'number' && !Number.isNaN(x)).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; }
export function wcagContrast(rgb1, rgb2) { // rgb arrays 0..255
  const L = ([r, g, b]) => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const a = L(rgb1), b = L(rgb2);
  return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
}
export function parseColor(s) { // 'rgb(1, 2, 3)' | 'rgba(1,2,3,0.5)' | '#abc' | '#aabbcc' → [r,g,b,a]
  if (!s) return null; s = String(s).trim();
  let m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i);
  if (m) { let a = m[4] === undefined ? 1 : (m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4])); return [+m[1], +m[2], +m[3], a]; }
  m = s.match(/^#([0-9a-f]{3,8})$/i);
  if (m) { let h = m[1]; if (h.length <= 4) h = [...h].map(c => c + c).join(''); const n = parseInt(h.slice(0, 6), 16); const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1; return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a]; }
  return null;
}
export function blend(fg, bg) { // alpha-composite fg over opaque bg
  const a = fg[3] ?? 1; return [0, 1, 2].map(i => Math.round(fg[i] * a + bg[i] * (1 - a)));
}
export function toHex(rgb) { return '#' + rgb.slice(0, 3).map(x => Math.round(x).toString(16).padStart(2, '0')).join(''); }

export function printSummary(lines) { process.stdout.write(lines.filter(x => x !== null && x !== undefined).slice(0, 40).join('\n') + '\n'); }

export function helpAndExit(text, args) { if (args.help || args.h) { process.stdout.write(text.trim() + '\n'); process.exit(0); } }

// ---------- byte-limited GET (binary-safe) ----------
/**
 * fetchBytes(url, opts) — GET only, same safety as politeFetch (risky/private refused, per-host politeness,
 * manual redirects with chain). Reads at most opts.maxBytes (default 256 KB) and cancels the rest,
 * so a huge file (backup.zip, video) is never downloaded whole.
 * → { ok, status, url, chain, headers, buf (Buffer), bytes, truncated, total (content-length|null), ms, error, skipped }
 */
export async function fetchBytes(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 20000;
  const maxRedirects = opts.maxRedirects ?? 10;
  const maxBytes = opts.maxBytes ?? 256 * 1024;
  const chain = [];
  let current = url;
  const started = Date.now();
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const skip = await safetySkip(current, opts);
    if (skip) return { ok: false, status: 0, url: current, chain, headers: {}, buf: Buffer.alloc(0), bytes: 0, error: `skipped_${skip}`, skipped: skip, ms: Date.now() - started };
    const release = await hostSlot(hostOf(current), opts);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    const dispatcher = opts.allowPrivate ? undefined : await pinnedDispatcher();
    try {
      const res = await fetch(current, {
        method: 'GET', redirect: 'manual', signal: ctl.signal, ...(dispatcher ? { dispatcher } : {}),
        headers: { 'user-agent': opts.ua || CHROME_UA, 'accept': opts.accept || '*/*',
          'accept-language': opts.acceptLanguage || 'ru-RU,ru;q=0.9,en;q=0.8', ...(opts.headers || {}) },
      });
      const headers = Object.fromEntries(res.headers.entries());
      if (res.headers.getSetCookie) headers['set-cookie'] = res.headers.getSetCookie();
      const loc = res.headers.get('location');
      chain.push({ url: current, status: res.status, location: loc || undefined });
      if (res.status === 429) coolDownHost(hostOf(current), 60000); // the next caller of this host waits, as in politeFetch
      if (res.status >= 300 && res.status < 400 && loc) {
        try { await res.body?.cancel(); } catch {}
        current = new URL(loc, current).toString();
        continue;
      }
      const parts = []; let bytes = 0, truncated = false;
      if (res.body) {
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(Buffer.from(value)); bytes += value.length;
          if (bytes >= maxBytes) { truncated = true; try { await reader.cancel(); } catch {} break; }
        }
      }
      const buf = Buffer.concat(parts).subarray(0, maxBytes);
      const cl = Number(headers['content-length']);
      return { ok: res.ok, status: res.status, url: current, chain, headers, buf, bytes, truncated,
        total: Number.isFinite(cl) && cl >= 0 ? cl : (truncated ? null : bytes), ms: Date.now() - started };
    } catch (e) {
      return { ok: false, status: 0, url: current, chain, headers: {}, buf: Buffer.alloc(0), bytes: 0, ...fetchErr(e, timeoutMs), ms: Date.now() - started };
    } finally { clearTimeout(t); release(); }
  }
  return { ok: false, status: 0, url: current, chain, headers: {}, buf: Buffer.alloc(0), bytes: 0, error: 'too many redirects', ms: Date.now() - started };
}

// ---------- journal of what left the machine ----------
// One line per call (or batch) to an external service; report.mjs collects lines tagged [external]
// into the log.md section «Что отправлялось во внешние сервисы».
// logExternal(run, 'crt.sh', 'имя домена example.ru', 1)
export function logExternal(run, service, what, count = 1) {
  log(run, `[external] ${service} · ${String(what).replace(/\s+/g, ' ').slice(0, 300)} · ${count}`);
}

// ---------- settings, run root, host keys, summaries, locks (init-run, state, doctor, memory) ----------
import { homedir as rvHomedir } from 'node:os';
import { execFileSync as rvExecFileSync } from 'node:child_process';

// ~/.revizor — per-user settings (config.json, written by /revizor:setup) and small caches. REVIZOR_HOME overrides (tests, CI).
export function revizorHome() { return process.env.REVIZOR_HOME ? resolve(process.env.REVIZOR_HOME) : join(rvHomedir(), '.revizor'); }

// → { path, exists, config: {…}, error? }  (never throws; a broken file gives config {} + error)
export function readRevizorConfig() {
  const p = join(revizorHome(), 'config.json');
  if (!existsSync(p)) return { path: p, exists: false, config: {} };
  try {
    const c = JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, ''));
    return { path: p, exists: true, config: c && typeof c === 'object' && !Array.isArray(c) ? c : {} };
  } catch (e) { return { path: p, exists: true, config: {}, error: e.message }; }
}

// Default root of runs: <Documents>/Revizor (Windows: the real "Documents", OneDrive included; Linux: xdg-user-dir),
// or ~/Revizor when there is no Documents folder. Absolute path.
let rvDocsCache;
export function defaultOutDir() {
  if (rvDocsCache) return rvDocsCache;
  const home = rvHomedir();
  const cands = [];
  const run = (cmd, args) => { try { return rvExecFileSync(cmd, args, { timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8').replace(/^﻿/, '').trim(); } catch { return ''; } };
  if (process.platform === 'win32') {
    const p = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetFolderPath('MyDocuments')"]);
    if (p) cands.push(p);
  } else if (process.platform !== 'darwin') {
    const p = run('xdg-user-dir', ['DOCUMENTS']);
    if (p && resolve(p) !== resolve(home)) cands.push(p);
  }
  cands.push(join(home, 'Documents'));
  const docs = cands.find(p => { try { return statSync(p).isDirectory(); } catch { return false; } });
  rvDocsCache = resolve(docs ? join(docs, 'Revizor') : join(home, 'Revizor'));
  return rvDocsCache;
}

// Folder name of a site: punycode host, without "www.", port as "_<port>" (":" is not allowed on Windows).
// hostKey('https://www.Кц.рф:8080/a') → 'xn--j1ay.xn--p1ai_8080'; hostKey('localhost:5173') → 'localhost_5173'
export function hostKey(urlOrHost) {
  let s = String(urlOrHost || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
  let h;
  try { h = new URL(s).host.toLowerCase(); } catch { return ''; }
  return h.replace(/[[\]]/g, '').replace(/\.(?=:|$)/, '').replace(/^www\./, '').replace(/:/g, '_').replace(/[^a-z0-9._-]/g, '_');
}

// System language for --lang auto: 'ru' for ru/uk/be/kk locales, otherwise 'en'. → { lang, locale, why }
export function systemLang() {
  let locale = '';
  try { locale = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch {}
  if (process.platform !== 'win32') { // POSIX: LANG/LC_* win over ICU defaults (Git Bash on Windows sets LANG=en_US — ignored there)
    const env = (process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || '').split('.')[0];
    if (env && !/^(C|POSIX)$/i.test(env)) locale = env.replace('_', '-');
  }
  const base = locale.toLowerCase().split(/[-_]/)[0];
  const lang = !base || ['ru', 'uk', 'be', 'kk'].includes(base) ? 'ru' : 'en';
  return { lang, locale: locale || null, why: locale ? `язык системы ${locale}` : 'язык системы не определён' };
}

// Print the summary (≤ 40 lines) to stdout and keep a copy in RUN/stdout/<name>.md (for consoles that mangle UTF-8).
// run may be null/undefined → stdout only. Returns the printed text.
export function printAndSaveSummary(run, name, lines) {
  const text = lines.filter(x => x !== null && x !== undefined).slice(0, 40).join('\n') + '\n';
  process.stdout.write(text);
  if (run) {
    try {
      const p = join(run, 'stdout', `${name}.md`);
      ensureDir(dirname(p));
      const tmp = `${p}.tmp-${process.pid}`;
      writeFileSync(tmp, text, 'utf8');
      try { renameSync(tmp, p); } catch { writeFileSync(p, text, 'utf8'); rmSync(tmp, { force: true }); }
    } catch { /* the copy is a convenience */ }
  }
  return text;
}

// Cross-process lock through an exclusive lock file; a lock older than staleMs is taken over.
// await withFileLock(join(run, 'state.json.lock'), async () => { …read-modify-write… })
export async function withFileLock(lockPath, fn, { timeoutMs = 15000, staleMs = 20000 } = {}) {
  const started = Date.now();
  ensureDir(dirname(lockPath));
  for (;;) {
    try { writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); break; }
    catch (e) {
      if (!['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e;
      try { if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { rmSync(lockPath, { force: true }); continue; } } catch { /* gone already */ }
      if (Date.now() - started > timeoutMs) throw new Error(`Файл занят другим процессом: ${lockPath}`);
      await sleep(40 + Math.floor(Math.random() * 80));
    }
  }
  try { return await fn(); } finally { try { rmSync(lockPath, { force: true }); } catch {} }
}

// ---------- safe output paths ----------
// insideRun(run, 'snapshot', pid, 'page.json') → absolute path; throws if the result escapes RUN
// (e.g. a pid like "../x"). Every collector/script writes only through such paths.
import { relative as pathRelative, isAbsolute as pathIsAbsolute } from 'node:path';
export function insideRun(run, ...parts) {
  const root = resolve(String(run));
  const p = resolve(root, ...parts.map(String));
  const rel = pathRelative(root, p);
  if (!rel || rel.startsWith('..') || pathIsAbsolute(rel)) throw new Error(`Путь вне папки прогона: ${p} / path outside RUN`);
  return p;
}

// ---------- screenshots: shots/index.json and box coordinates (lint-findings, finalize, report) ----------
// A finding's box is [x, y, w, h] in CSS px of the document at that width. A box taken from an image says
// "box_space": "image" + "shot". snapshot/<pid>/shots/index.json: [{ file, width, y0, y1, scale, kind, img_w, img_h }],
// kind fold|full|part|inner; image px = (css - y0) * scale; "inner" frames scroll inside a block → no document mapping.
const rvShotsIndexCache = new Map();
export function shotKind(entry) {
  if (entry?.kind) return entry.kind;
  const f = String(entry?.file || '');
  return /-fold\.jpe?g$/i.test(f) ? 'fold' : /-full\.jpe?g$/i.test(f) ? 'full' : /\.part-\d+\.jpe?g$/i.test(f) ? 'part' : /\.inner-\d+\.jpe?g$/i.test(f) ? 'inner' : 'other';
}
/** readShotsIndex(run, 'home') → entries of snapshot/home/shots/index.json ([] when missing). Cached by mtime. */
export function readShotsIndex(run, pid) {
  let p;
  try { p = insideRun(run, 'snapshot', String(pid), 'shots', 'index.json'); } catch { return []; }
  let mt;
  try { mt = statSync(p).mtimeMs; } catch { return []; }
  const c = rvShotsIndexCache.get(p);
  if (c && c.mt === mt) return c.list;
  const raw = readJSON(p, []);
  const list = Array.isArray(raw) ? raw.filter(e => e && typeof e.file === 'string') : [];
  rvShotsIndexCache.set(p, { mt, list });
  return list;
}
/**
 * shotRef(run, 'snapshot/home/shots/390.part-02.jpg' [, pid]) → { rel, abs, pid, file, entry, exists } or null when the path
 * leaves RUN. Accepts RUN-relative or absolute paths with / or \; a bare file name is looked up in snapshot/<pid>/shots/.
 */
export function shotRef(run, shot, pid = null) {
  if (!shot || typeof shot !== 'string') return null;
  const root = resolve(String(run));
  const s = shot.trim().replace(/\\/g, '/');
  let abs;
  try { abs = insideRun(root, s); } catch { return null; }
  if (!existsSync(abs) && pid && !s.includes('/')) {
    try { const alt = insideRun(root, 'snapshot', String(pid), 'shots', s); if (existsSync(alt)) abs = alt; } catch { /* keep abs */ }
  }
  const rel = pathRelative(root, abs).split(/[\\/]/).join('/');
  const m = rel.match(/^snapshot\/([^/]+)\/shots\/([^/]+)$/);
  const entry = m ? (readShotsIndex(root, m[1]).find(e => e.file === m[2]) || null) : null;
  return { rel, abs, pid: m ? m[1] : null, file: rel.split('/').pop(), entry, exists: existsSync(abs) };
}
function rvShotScale(entry) {
  const sc = Number(entry?.scale);
  if (sc > 0) return sc;
  return entry?.img_w && entry?.width ? Number(entry.img_w) / Number(entry.width) : 0;
}
/** Image-px box on a frame → CSS px of the document. null for "inner"/unknown frames. */
export function boxImageToCss(entry, box) {
  if (!entry || !Array.isArray(box) || box.length !== 4 || box.some(v => !Number.isFinite(Number(v)))) return null;
  const k = shotKind(entry);
  const sc = rvShotScale(entry);
  if (k === 'inner' || k === 'other' || !(sc > 0)) return null;
  const y0 = Number(entry.y0) || 0;
  const [x, y, w, h] = box.map(Number);
  return [x / sc, y0 + y / sc, w / sc, h / sc].map(v => Math.round(v));
}
/** CSS px box of the document → image px on a frame (not clipped). null for "inner"/unknown frames. */
export function boxCssToImage(entry, box) {
  if (!entry || !Array.isArray(box) || box.length !== 4 || box.some(v => !Number.isFinite(Number(v)))) return null;
  const k = shotKind(entry);
  const sc = rvShotScale(entry);
  if (k === 'inner' || k === 'other' || !(sc > 0)) return null;
  const y0 = Number(entry.y0) || 0;
  const [x, y, w, h] = box.map(Number);
  return [x * sc, (y - y0) * sc, w * sc, h * sc].map(v => Math.round(v));
}
/**
 * Best frame of page `pid` at CSS `width` for a CSS box: a part that holds it (or overlaps it most), else the full frame,
 * else the fold frame when the box is in the first screen. → { entry, rel, box (image px, clipped to the frame), whole } | null
 */
export function shotForCssBox(run, pid, width, box) {
  const W = Number(width);
  if (!pid || !W || !Array.isArray(box) || box.length !== 4) return null;
  const [, y, , h] = box.map(Number);
  const list = readShotsIndex(run, pid).filter(e => Number(e.width) === W);
  const overlap = e => Math.max(0, Math.min(y + h, Number(e.y1)) - Math.max(y, Number(e.y0)));
  const pick = kind => {
    const c = list.filter(e => shotKind(e) === kind && overlap(e) > 0);
    c.sort((a, b) => overlap(b) - overlap(a));
    return c[0] || null;
  };
  const e = pick('part') || pick('full') || pick('fold');
  if (!e) return null;
  const ib = boxCssToImage(e, box);
  if (!ib) return null;
  const iw = Number(e.img_w) || Infinity, ih = Number(e.img_h) || Infinity;
  const x0 = Math.max(0, ib[0]), y0 = Math.max(0, ib[1]);
  const x1 = Math.min(iw, ib[0] + ib[2]), y1 = Math.min(ih, ib[1] + ib[3]);
  if (x1 <= x0 || y1 <= y0) return null;
  const whole = x0 === ib[0] && y0 === ib[1] && x1 === ib[0] + ib[2] && y1 === ib[1] + ib[3];
  return { entry: e, rel: `snapshot/${pid}/shots/${e.file}`, box: [x0, y0, x1 - x0, y1 - y0].map(v => Math.round(v)), whole };
}

// ---------- spreadsheet columns by header (recheck, memory, report self-check) ----------
// A user may reorder, rename slightly or add columns in registry.xlsx: columns are found by header text,
// never by position. Case, ё/е, spaces and ()·.,:; are ignored; "Проверено 24.10" matches the synonym "проверено".
export function normHeader(s) {
  return normText(String(s ?? '')).replace(/[()·.,:;]/g, ' ').replace(/\s+/g, ' ').trim();
}
/**
 * findColumns(rows, { status: ['статус', 'status'], what: ['что на сайте', 'issue'] }, { need: ['status'], scan: 8 })
 * → { headerRow, cols: { key: index }, headers: [normalized header…] } or null.
 * Exact header matches win over prefix matches; one column is given to one key only. A row counts as the header
 * row when every `need` key is found and at least `min` keys match (default 2, or need.length when larger).
 */
export function findColumns(rows, synonyms, { need = [], scan = 8, min = 2 } = {}) {
  const keys = Object.keys(synonyms || {});
  const want = Math.max(min, need.length);
  for (let r = 0; r < Math.min((rows || []).length, scan); r++) {
    const heads = (rows[r] || []).map(normHeader);
    const cols = {}, used = new Set();
    for (const pass of ['exact', 'prefix']) {
      for (const k of keys) {
        if (cols[k] !== undefined) continue;
        const ns = (synonyms[k] || []).map(normHeader).filter(Boolean);
        const i = heads.findIndex((h, j) => h && !used.has(j) && (pass === 'exact' ? ns.includes(h) : ns.some(s => s.length > 2 && h.startsWith(s + ' '))));
        if (i >= 0) { cols[k] = i; used.add(i); }
      }
    }
    if (need.every(k => cols[k] !== undefined) && Object.keys(cols).length >= want) return { headerRow: r, cols, headers: heads };
  }
  return null;
}

// ---------- third-party services (perf, privacy; forms/headers may reuse) ----------
// registrableDomain('a.b.example.co.uk') → 'example.co.uk'; IPs and 'localhost' stay as they are.
const RV_MULTI_SUFFIX = new Set(['com.ru', 'net.ru', 'org.ru', 'pp.ru', 'msk.ru', 'spb.ru', 'msk.su', 'spb.su', 'com.ua', 'kiev.ua', 'org.ua', 'co.uk', 'org.uk', 'ac.uk', 'gov.uk',
  'com.au', 'net.au', 'org.au', 'co.nz', 'co.jp', 'co.kr', 'com.br', 'com.tr', 'com.cn', 'com.hk', 'com.sg', 'co.za', 'co.il', 'com.mx', 'com.ar', 'co.in', 'com.kz', 'org.kz', 'com.by', 'com.ge', 'com.am',
  // Russian state/education zones and regional names (PSL): every subdomain is a separate owner
  'ac.ru', 'edu.ru', 'gov.ru', 'int.ru', 'mil.ru', 'adygeya.ru', 'bashkiria.ru', 'bir.ru', 'cbg.ru', 'dagestan.ru', 'grozny.ru', 'kalmykia.ru',
  'kustanai.ru', 'marine.ru', 'mordovia.ru', 'mytis.ru', 'nalchik.ru', 'nov.ru', 'pyatigorsk.ru', 'vladikavkaz.ru', 'vladimir.ru',
  'nov.su', 'tula.su', 'penza.su', 'sochi.su', 'kaluga.su', 'krasnodar.su', 'murmansk.su', 'vologda.su', 'ivanovo.su', 'karelia.su', 'togliatti.su',
  'com.kg', 'com.uz', 'co.uz', 'gov.kz', 'edu.kz', 'gov.by', 'gov.ua', 'edu.ua', 'in.ua', 'co.ua', 'net.ua', 'com.de', 'co.at', 'or.at', 'com.pl', 'co.th']);
// Hosting/platform suffixes where every subdomain belongs to a different owner (excerpt of the Public Suffix List,
// "private" section, plus common Russian hosting). Without it shop.gitlab.io would be treated as gitlab.io.
const RV_PLATFORM_SUFFIX = new Set(['github.io', 'gitlab.io', 'bitbucket.io', 'workers.dev', 'pages.dev', 'vercel.app', 'now.sh', 'netlify.app', 'netlify.com',
  'herokuapp.com', 'web.app', 'firebaseapp.com', 'appspot.com', 'blogspot.com', 'wixsite.com', 'wix.com', 'webflow.io', 'myshopify.com', 'onrender.com',
  'fly.dev', 'azurewebsites.net', 'azurestaticapps.net', 'cloudfront.net', 'amplifyapp.com', 'ngrok.io', 'ngrok-free.app', 'glitch.me', 'repl.co', 'replit.app',
  'surge.sh', 'pythonanywhere.com', 'readthedocs.io', 'carrd.co', 'framer.website', 'framer.app', 'notion.site', 'tilda.ws', 'tilda.website', 'readymag.website',
  'ucoz.ru', 'ucoz.net', 'narod.ru', 'nethouse.ru', 'ukit.me', 'ecwid.com', 'mybigcommerce.com', 'squarespace.com', 'weebly.com', 'jimdosite.com', 'webnode.page',
  'website.yandexcloud.net', 'storage.yandexcloud.net', 's3.amazonaws.com', 'ru.com', 'eu.com', 'us.com', 'uk.com', 'de.com', 'za.com',
  'taplink.cc', 'taplink.ws', 'craftum.io', 'business.site', 'wordpress.com', 'tumblr.com', 'up.railway.app', 'supabase.co', 'lovable.app',
  'myinsales.ru', 'beget.tech', 'timeweb.cloud', 'twc1.net', 'wixstudio.io', 'wixstudio.com', 'bubbleapps.io', 'mystrikingly.com', 'strikingly.com',
  'webflow.io', 'pantheonsite.io', 'deno.dev', 'hashnode.dev', 'substack.com', 'tiiny.site', 'neocities.org',
  'ucoz.com', 'ucoz.org', 'ucoz.ua', 'at.ua', 'my1.ru', '3dn.ru', 'do.am', 'clan.su', 'blogspot.ru', 'livejournal.com', 'diary.ru', 'turbo.site', 'ru.net']);
export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h || /^[\d.]+$/.test(h) || h.includes(':') || !h.includes('.')) return h;
  const p = h.split('.');
  // longest public/platform suffix wins; registrable = suffix + one label
  for (let k = Math.min(p.length - 1, 4); k >= 2; k--) {
    const suf = p.slice(-k).join('.');
    if (RV_PLATFORM_SUFFIX.has(suf) || (k === 2 && RV_MULTI_SUFFIX.has(suf))) return p.slice(-(k + 1)).join('.');
  }
  return p.slice(-2).join('.');
}
export function isPlatformHost(host) {
  const p = String(host || '').toLowerCase().split('.');
  for (let k = Math.min(p.length - 1, 4); k >= 2; k--) if (RV_PLATFORM_SUFFIX.has(p.slice(-k).join('.'))) return true;
  return false;
}
// true when the URL belongs to another registrable domain than the site (subdomains of the site are first party)
export function isThirdParty(url, siteUrlOrHost) {
  const h = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(url)) ? hostOf(url) : String(url || '').toLowerCase();
  const s = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(siteUrlOrHost)) ? hostOf(siteUrlOrHost) : String(siteUrlOrHost || '').toLowerCase();
  if (!h || !s) return false;
  return registrableDomain(h) !== registrableDomain(s);
}
// [host suffix, name, category, operator ('ru' | 'foreign' | null = unknown), optional path regex]
// operator = where the company that runs the service is based, by a built-in list: a hint for the privacy lens, verify before writing it down.
export const THIRD_PARTY_SERVICES = [
  ['mc.yandex.ru', 'Яндекс Метрика', 'analytics', 'ru'], ['mc.yandex.com', 'Яндекс Метрика', 'analytics', 'ru'], ['metrika.yandex.ru', 'Яндекс Метрика', 'analytics', 'ru'],
  ['google-analytics.com', 'Google Analytics', 'analytics', 'foreign'], ['analytics.google.com', 'Google Analytics', 'analytics', 'foreign'],
  ['googletagmanager.com', 'Google Tag Manager', 'tag-manager', 'foreign'], ['top-fwz1.mail.ru', 'Top Mail.ru', 'analytics', 'ru'], ['top.mail.ru', 'Top Mail.ru', 'analytics', 'ru'],
  ['counter.yadro.ru', 'LiveInternet', 'analytics', 'ru'], ['hotjar.com', 'Hotjar', 'recording', 'foreign'], ['hotjar.io', 'Hotjar', 'recording', 'foreign'],
  ['clarity.ms', 'Microsoft Clarity', 'recording', 'foreign'], ['amplitude.com', 'Amplitude', 'analytics', 'foreign'], ['segment.io', 'Segment', 'analytics', 'foreign'],
  ['segment.com', 'Segment', 'analytics', 'foreign'], ['mixpanel.com', 'Mixpanel', 'analytics', 'foreign'], ['plausible.io', 'Plausible', 'analytics', 'foreign'],
  ['statcounter.com', 'StatCounter', 'analytics', 'foreign'], ['smartlook.com', 'Smartlook', 'recording', 'foreign'], ['smartlook.cloud', 'Smartlook', 'recording', 'foreign'],
  ['fullstory.com', 'FullStory', 'recording', 'foreign'], ['mouseflow.com', 'Mouseflow', 'recording', 'foreign'], ['logrocket.com', 'LogRocket', 'recording', 'foreign'],
  ['lr-ingest.io', 'LogRocket', 'recording', 'foreign'], ['nr-data.net', 'New Relic', 'monitoring', 'foreign'], ['newrelic.com', 'New Relic', 'monitoring', 'foreign'],
  ['sentry.io', 'Sentry', 'monitoring', 'foreign'], ['sentry-cdn.com', 'Sentry', 'monitoring', 'foreign'],
  ['doubleclick.net', 'Google Ads', 'ads', 'foreign'], ['googleadservices.com', 'Google Ads', 'ads', 'foreign'], ['googlesyndication.com', 'Google Ads', 'ads', 'foreign'],
  ['an.yandex.ru', 'Рекламная сеть Яндекса', 'ads', 'ru'], ['yabs.yandex.ru', 'Рекламная сеть Яндекса', 'ads', 'ru'], ['adfox.ru', 'ADFOX', 'ads', 'ru'],
  ['connect.facebook.net', 'Meta Pixel', 'ads', 'foreign'], ['facebook.com', 'Meta Pixel', 'ads', 'foreign', /^\/tr/], ['vk.com', 'Пиксель VK', 'ads', 'ru', /^\/rtrg/],
  ['analytics.tiktok.com', 'TikTok Pixel', 'ads', 'foreign'], ['snap.licdn.com', 'LinkedIn Insight', 'ads', 'foreign'], ['bat.bing.com', 'Microsoft Ads', 'ads', 'foreign'],
  ['ct.pinterest.com', 'Pinterest Tag', 'ads', 'foreign'], ['criteo.com', 'Criteo', 'ads', 'foreign'], ['criteo.net', 'Criteo', 'ads', 'foreign'],
  ['roistat.com', 'Roistat', 'calltracking', 'ru'], ['calltouch.ru', 'Calltouch', 'calltracking', 'ru'], ['comagic.ru', 'CoMagic', 'calltracking', 'ru'], ['uiscom.ru', 'UIS', 'calltracking', 'ru'],
  ['callibri.ru', 'Callibri', 'calltracking', 'ru'], ['mango-office.ru', 'Mango Office', 'calltracking', 'ru'], ['alloka.ru', 'Alloka', 'calltracking', 'ru'], ['calltracking.ru', 'Calltracking.ru', 'calltracking', 'ru'],
  ['ringostat.com', 'Ringostat', 'calltracking', null], ['ringostat.net', 'Ringostat', 'calltracking', null],
  ['jivosite.com', 'Jivo', 'chat', 'ru'], ['jivo.ru', 'Jivo', 'chat', 'ru'], ['carrotquest.io', 'Carrot quest', 'chat', 'ru'], ['talk-me.ru', 'Talk-Me', 'chat', 'ru'],
  ['livetex.ru', 'LiveTex', 'chat', 'ru'], ['chatra.io', 'Chatra', 'chat', null], ['tawk.to', 'Tawk.to', 'chat', 'foreign'], ['intercom.io', 'Intercom', 'chat', 'foreign'],
  ['intercomcdn.com', 'Intercom', 'chat', 'foreign'], ['crisp.chat', 'Crisp', 'chat', 'foreign'], ['verbox.ru', 'Verbox', 'chat', 'ru'],
  ['bitrix24.ru', 'Битрикс24', 'chat', null], ['bitrix24.com', 'Битрикс24', 'chat', null], ['bitrix24.by', 'Битрикс24', 'chat', null], ['bitrix24.kz', 'Битрикс24', 'chat', null],
  ['envybox.io', 'Envybox', 'callback', 'ru'], ['callbackhunter.com', 'Callbackhunter', 'callback', 'ru'], ['leadback.ru', 'LeadBack', 'callback', 'ru'], ['perezvoni.com', 'Perezvoni', 'callback', 'ru'],
  ['marquiz.ru', 'Marquiz', 'widget', 'ru'], ['getsitecontrol.com', 'GetSiteControl', 'widget', null],
  ['fonts.googleapis.com', 'Google Fonts', 'fonts', 'foreign'], ['fonts.gstatic.com', 'Google Fonts', 'fonts', 'foreign'], ['use.typekit.net', 'Adobe Fonts', 'fonts', 'foreign'],
  ['p.typekit.net', 'Adobe Fonts', 'fonts', 'foreign'], ['fonts.bunny.net', 'Bunny Fonts', 'fonts', 'foreign'],
  ['youtube.com', 'YouTube', 'video', 'foreign'], ['youtube-nocookie.com', 'YouTube (без cookie)', 'video', 'foreign'], ['ytimg.com', 'YouTube', 'video', 'foreign'],
  ['googlevideo.com', 'YouTube', 'video', 'foreign'], ['vimeo.com', 'Vimeo', 'video', 'foreign'], ['vimeocdn.com', 'Vimeo', 'video', 'foreign'], ['rutube.ru', 'Rutube', 'video', 'ru'],
  ['vkvideo.ru', 'VK Видео', 'video', 'ru'], ['vk.com', 'VK Видео', 'video', 'ru', /^\/video_ext/], ['kinescope.io', 'Kinescope', 'video', null],
  ['api-maps.yandex.ru', 'Яндекс Карты', 'maps', 'ru'], ['yandex.ru', 'Яндекс Карты', 'maps', 'ru', /^\/map-widget/], ['maps.googleapis.com', 'Google Maps', 'maps', 'foreign'],
  ['maps.gstatic.com', 'Google Maps', 'maps', 'foreign'], ['google.com', 'Google Maps', 'maps', 'foreign', /^\/maps/], ['2gis.ru', '2ГИС', 'maps', 'ru'], ['2gis.com', '2ГИС', 'maps', 'ru'],
  ['google.com', 'reCAPTCHA', 'captcha', 'foreign', /^\/recaptcha/], ['gstatic.com', 'reCAPTCHA', 'captcha', 'foreign', /^\/recaptcha/], ['recaptcha.net', 'reCAPTCHA', 'captcha', 'foreign'],
  ['smartcaptcha.yandexcloud.net', 'Яндекс SmartCaptcha', 'captcha', 'ru'], ['hcaptcha.com', 'hCaptcha', 'captcha', 'foreign'], ['challenges.cloudflare.com', 'Cloudflare Turnstile', 'captcha', 'foreign'],
  ['vk.com', 'VK', 'social', 'ru'], ['vk.ru', 'VK', 'social', 'ru'], ['userapi.com', 'VK', 'social', 'ru'], ['ok.ru', 'Одноклассники', 'social', 'ru'],
  ['telegram.org', 'Telegram', 'social', 'foreign'], ['t.me', 'Telegram', 'social', 'foreign'], ['instagram.com', 'Instagram', 'social', 'foreign'], ['cdninstagram.com', 'Instagram', 'social', 'foreign'],
  ['facebook.com', 'Facebook', 'social', 'foreign'], ['fbcdn.net', 'Facebook', 'social', 'foreign'], ['platform.twitter.com', 'X (Twitter)', 'social', 'foreign'], ['twimg.com', 'X (Twitter)', 'social', 'foreign'],
  ['cdnjs.cloudflare.com', 'cdnjs', 'cdn', 'foreign'], ['cdn.jsdelivr.net', 'jsDelivr', 'cdn', 'foreign'], ['unpkg.com', 'unpkg', 'cdn', 'foreign'], ['code.jquery.com', 'jQuery CDN', 'cdn', 'foreign'],
  ['ajax.googleapis.com', 'Google Hosted Libraries', 'cdn', 'foreign'], ['bootstrapcdn.com', 'BootstrapCDN', 'cdn', 'foreign'], ['yastatic.net', 'Яндекс (статика)', 'cdn', 'ru'],
  ['gstatic.com', 'Google (статика)', 'cdn', 'foreign'], ['cloudfront.net', 'Amazon CloudFront', 'cdn', 'foreign'], ['akamaihd.net', 'Akamai', 'cdn', 'foreign'],
  ['tildacdn.com', 'Тильда', 'platform', null], ['tildaapi.com', 'Тильда', 'platform', null], ['tilda.ws', 'Тильда', 'platform', null],
  ['wixstatic.com', 'Wix', 'platform', 'foreign'], ['parastorage.com', 'Wix', 'platform', 'foreign'], ['cdn.shopify.com', 'Shopify', 'platform', 'foreign'],
  ['website-files.com', 'Webflow', 'platform', 'foreign'], ['webflow.com', 'Webflow', 'platform', 'foreign'], ['squarespace-cdn.com', 'Squarespace', 'platform', 'foreign'],
  ['squarespace.com', 'Squarespace', 'platform', 'foreign'], ['readymag.com', 'Readymag', 'platform', null], ['insales-cdn.com', 'InSales', 'platform', 'ru'],
  ['taplink.cc', 'Taplink', 'platform', null],
  ['yookassa.ru', 'ЮKassa', 'payments', 'ru'], ['yoomoney.ru', 'ЮMoney', 'payments', 'ru'], ['cloudpayments.ru', 'CloudPayments', 'payments', 'ru'],
  ['stripe.com', 'Stripe', 'payments', 'foreign'], ['stripe.network', 'Stripe', 'payments', 'foreign'], ['paypal.com', 'PayPal', 'payments', 'foreign'], ['paypalobjects.com', 'PayPal', 'payments', 'foreign'],
  ['cookielaw.org', 'OneTrust', 'consent', 'foreign'], ['onetrust.com', 'OneTrust', 'consent', 'foreign'], ['cookiebot.com', 'Cookiebot', 'consent', 'foreign'], ['usercentrics.eu', 'Usercentrics', 'consent', 'foreign'],
  ['yclients.com', 'YCLIENTS', 'booking', 'ru'], ['dikidi.net', 'DIKIDI', 'booking', 'ru'],
  // generic fallbacks (shorter suffix → lose to the specific rules above)
  ['yandex.ru', 'Яндекс', 'other', 'ru'], ['yandex.com', 'Яндекс', 'other', 'ru'], ['yandex.net', 'Яндекс', 'other', 'ru'], ['ya.ru', 'Яндекс', 'other', 'ru'],
  ['mail.ru', 'Mail.ru (VK)', 'other', 'ru'], ['google.com', 'Google', 'other', 'foreign'], ['googleapis.com', 'Google', 'other', 'foreign'],
  ['googleusercontent.com', 'Google', 'other', 'foreign'], ['cloudflare.com', 'Cloudflare', 'cdn', 'foreign'],
];
export const THIRD_PARTY_CATEGORY_NAMES = {
  analytics: ['аналитика', 'analytics'], recording: ['запись сессий', 'session recording'], ads: ['реклама и пиксели', 'ads and pixels'], 'tag-manager': ['менеджер тегов', 'tag manager'],
  calltracking: ['коллтрекинг', 'call tracking'], chat: ['чат', 'chat'], callback: ['обратный звонок', 'callback'], widget: ['виджет', 'widget'], fonts: ['шрифты', 'fonts'],
  video: ['видео', 'video'], maps: ['карты', 'maps'], social: ['соцсети', 'social'], captcha: ['капча', 'captcha'], cdn: ['CDN библиотек', 'library CDN'],
  platform: ['платформа сайта', 'site platform'], payments: ['оплата', 'payments'], consent: ['баннер согласия', 'consent platform'], booking: ['онлайн-запись', 'booking'],
  monitoring: ['мониторинг ошибок', 'error monitoring'], other: ['другое', 'other'],
};
// English names of services whose built-in name is Russian (here and in lib/cdp WIDGET_NAMES); others stay as they are.
const SERVICE_NAME_EN = {
  'Яндекс Метрика': 'Yandex Metrica', 'Рекламная сеть Яндекса': 'Yandex Advertising Network', 'Пиксель VK': 'VK Pixel', 'Битрикс24': 'Bitrix24',
  'YouTube (без cookie)': 'YouTube (no-cookie)', 'VK Видео': 'VK Video', 'Яндекс Карты': 'Yandex Maps', '2ГИС': '2GIS', 'Яндекс SmartCaptcha': 'Yandex SmartCaptcha',
  'Одноклассники': 'Odnoklassniki', 'Яндекс (статика)': 'Yandex (static files)', 'Google (статика)': 'Google (static files)', 'Тильда': 'Tilda',
  'ЮKassa': 'YooKassa', 'ЮMoney': 'YooMoney', 'Яндекс': 'Yandex',
};
const SERVICE_KIND_EN = { 'коллтрекинг': 'call tracking', 'чат': 'chat', 'обратный звонок': 'callback', 'квиз': 'quiz', 'попапы': 'popups', 'виджет/форма': 'widget/form' };
/** serviceNameEn('Roistat (коллтрекинг)') → 'Roistat (call tracking)'; serviceNameEn('Яндекс Метрика') → 'Yandex Metrica'. */
export function serviceNameEn(name) {
  const s = String(name ?? '');
  if (SERVICE_NAME_EN[s]) return SERVICE_NAME_EN[s];
  const m = /^(.*?)\s*\(([^()]+)\)$/.exec(s);
  if (m && (SERVICE_KIND_EN[m[2]] || SERVICE_NAME_EN[m[1]])) return `${SERVICE_NAME_EN[m[1]] || m[1]} (${SERVICE_KIND_EN[m[2]] || m[2]})`;
  return s;
}
// classifyThirdParty('https://mc.yandex.ru/metrika/tag.js') → { host, name: 'Яндекс Метрика', name_en: 'Yandex Metrica', category: 'analytics', operator: 'ru', known: true }
// Unknown hosts → { host, name: host, name_en: host, category: 'other', operator: null, known: false }. Longest matching suffix wins; path-specific rules first.
// lang 'en' → name is the English one (name_en is always there).
export function classifyThirdParty(urlOrHost, lang) {
  const r = classifyThirdPartyRu(urlOrHost);
  r.name_en = serviceNameEn(r.name);
  if (lang === 'en') r.name = r.name_en;
  return r;
}
function classifyThirdPartyRu(urlOrHost) {
  let host = '', path = '/';
  const s = String(urlOrHost || '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) { try { const u = new URL(s); host = u.hostname.toLowerCase(); path = u.pathname || '/'; } catch { host = ''; } }
  else host = s.toLowerCase();
  host = host.replace(/^www\./, '');
  let best = null;
  for (const [suf, name, category, operator, pathRe] of THIRD_PARTY_SERVICES) {
    if (!(host === suf || host.endsWith('.' + suf))) continue;
    if (pathRe && !pathRe.test(path)) continue;
    const score = suf.length + (pathRe ? 1000 : 0);
    if (!best || score > best.score) best = { score, name, category, operator };
  }
  return best ? { host, name: best.name, category: best.category, operator: best.operator, known: true } : { host, name: host, category: 'other', operator: null, known: false };
}

// ---------- POST to an allow-listed external service (never to the reviewed site) ----------
// The reviewed site only ever gets GET/HEAD (politeFetch, fetchBytes, lib/cdp). Some external services take
// their input only by POST (Yandex Speller: up to 10 000 chars per request). This helper refuses any host that
// is not in EXTERNAL_POST_HOSTS, plain http and redirects. The caller logs every call with logExternal().
// externalPost('https://speller.yandex.net/services/spellservice.json/checkTexts', [['lang','ru,en'], ['text','…']])
// → { ok, status, text, ms, error? }
export const EXTERNAL_POST_HOSTS = Object.freeze(['speller.yandex.net']);
export async function externalPost(url, form, { timeoutMs = 20000, ua = CHROME_UA } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new Error('externalPost: bad url'); }
  if (u.protocol !== 'https:' || !EXTERNAL_POST_HOSTS.includes(u.hostname.toLowerCase())) throw new Error(`externalPost: ${u.hostname} is not an allowed external service`);
  const body = new URLSearchParams();
  for (const [k, v] of (Array.isArray(form) ? form : Object.entries(form || {}))) body.append(String(k), String(v));
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(u.toString(), { method: 'POST', body, redirect: 'error', signal: ctl.signal,
      headers: { 'user-agent': ua, 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', accept: 'application/json, text/plain, */*' } });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, ms: Date.now() - started };
  } catch (e) {
    return { ok: false, status: 0, text: '', error: e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message, ms: Date.now() - started };
  } finally { clearTimeout(t); }
}

// ---------- machine-readable blocks of knowledge/*.md ----------
// knowledgeBlock(md, 'forbidden') reads <!-- revizor:forbidden {JSON} --> (also 'glossary', 'glossary-en', 'dict').
// The name must be followed by whitespace or "{", so 'glossary' never matches 'glossary-en'. → object | null.
export function knowledgeBlock(md, name) {
  const n = String(name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = String(md || '').match(new RegExp(`<!--\\s*revizor:${n}\\s*(\\{[\\s\\S]*?\\})\\s*-->`));
  if (!m) return null;
  try { const j = JSON.parse(m[1]); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}

// compileStopTerm(entry) → { label, re } | null — one entry of a stop list (tone.md «Запрещено» and the like):
//   '/regexp/flags'           regular expression (u is added; g is dropped)
//   're:<regexp>'             regular expression wrapped in letter boundaries, flags iu
//   'word*'                   stem: the word and its endings
//   'word' | 'two words'      literal: whole word, case-insensitive, flexible spaces, е and ё alike
//   { pattern, flags, hint }  dictionary entry
export function compileStopTerm(entry) {
  const fl = f => { const x = String(f || '').replace(/[^dimsuyv]/g, ''); return /[uv]/.test(x) ? x : x + 'u'; };
  try {
    if (entry && typeof entry === 'object') return entry.pattern ? { label: entry.hint || entry.pattern, re: new RegExp(entry.pattern, fl(entry.flags ?? 'iu')) } : null;
    const s = String(entry ?? '').trim();
    if (!s) return null;
    const m = s.match(/^\/(.+)\/([a-z]*)$/s);
    if (m) return { label: s, re: new RegExp(m[1], fl(m[2])) };
    if (s.startsWith('re:')) return { label: s, re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${s.slice(3)})(?![\\p{L}\\p{N}])`, 'iu') };
    const stem = s.endsWith('*');
    const base = (stem ? s.slice(0, -1) : s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[её]/gi, '[её]').replace(/\s+/g, '\\s+');
    return { label: s, re: new RegExp(`(?<![\\p{L}\\p{N}])${base}${stem ? '[\\p{L}-]*' : ''}(?![\\p{L}\\p{N}])`, 'iu') };
  } catch { return null; }
}
