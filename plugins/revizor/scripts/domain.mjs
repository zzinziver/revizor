#!/usr/bin/env node
// Revizor — domain.mjs: DNS, mail auth (MX/SPF/DMARC/DKIM), CAA, domain expiry (RDAP / WHOIS on port 43),
// security.txt, subdomains from Certificate Transparency (crt.sh) → test stands open to robots, dangling CNAMEs,
// optional availability from regions (check-host.net). External services only for stage=live and a public host.
// Writes RUN/measure/domain.json and RUN/stdout/domain.md.

import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { Resolver } from 'node:dns/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as U from './lib/util.mjs';
import { Browser } from './lib/cdp.mjs';

const HELP = `
domain.mjs — домен и инфраструктура: DNS (A/AAAA/CNAME/NS), почта (MX, SPF с подсчётом DNS-lookup, DMARC,
DKIM по частым селекторам), CAA, DNSSEC, срок регистрации (RDAP; для .ru/.su/.рф и зон без RDAP — WHOIS, порт 43),
security.txt, поддомены из crt.sh (≤ 300 имён, ≤ 20 GET по живым) → тестовые стенды открыты роботу? висящие CNAME.

  node domain.mjs --run "<RUN>" [--url <адрес, если нет pages.json>] [--regions] [--stage live|beta|prototype]
                  [--no-crtsh] [--sub-gets 20] [--budget-sec 480] [--lang ru|en]

  --regions   одна HTTP-проверка главной с узлов check-host.net (разные страны)
  --sub-gets  сколько GET по живым поддоменам (по умолчанию и максимум 20); поддомен с частным адресом
              (хотя бы одним) не открывается; поддомен с редиректом на основной сайт — правильная настройка
Адрес на домене платформы (github.io, tilda.ws, workers.dev, website.yandexcloud.net…): почта, CAA, DNSSEC,
срок домена и crt.sh не проверяются — это настройки платформы. Доступность по IPv6 — TCP-соединение по AAAA,
только если у этой машины есть IPv6.
Внешние сервисы (RDAP, WHOIS, crt.sh, dns.google, check-host.net) — только при stage=live и публичном адресе;
каждый вызов записывается в log.md. Стадия берётся из --stage, brief.json или brief.input.json; признаки беты из
pages.json без явной стадии выключают внешние сервисы.
Пишет: measure/domain.json, stdout/domain.md. Код 75 — частичный результат, повторите тот же вызов.
`;

const args = U.parseArgs(process.argv.slice(2), { boolean: ['regions', 'crtsh', 'help'] });
U.helpAndExit(HELP, args);
const lang = U.langOf(args);
const L = (ru, en) => (lang === 'en' ? en : ru);
// an unknown flag is an error: a flag this version lacks must not silently re-run everything and overwrite domain.json
{
  const KNOWN_FLAGS = new Set(['_', 'run', 'lang', 'help', 'budget-sec', 'pages', 'url', 'stage', 'mode', 'audience', 'regions', 'crtsh', 'sub-gets']);
  const bad = Object.keys(args).filter(k => !KNOWN_FLAGS.has(k));
  if (bad.length) { console.error(L(`domain.mjs: неизвестные флаги: ${bad.map(k => '--' + k).join(', ')} (см. --help)`, `domain.mjs: unknown flags: ${bad.map(k => '--' + k).join(', ')} (see --help)`)); process.exit(2); }
}
const RUN = U.requireRun(args);
const budgetSec = Math.max(20, Number(args['budget-sec'] ?? 480) || 480);
const deadline = Date.now() + budgetSec * 1000 - Math.min(20000, budgetSec * 100);
const timeLeft = () => deadline - Date.now();
const OUT = U.runPath(RUN, 'measure', 'domain.json');
const SUB_GETS = Math.min(20, Math.max(0, Number(args['sub-gets'] ?? 20) || 0));

// ---------- inputs ----------
const pagesJson = U.readJSON(join(RUN, 'pages.json'), null);
const brief = U.readJSON(join(RUN, 'brief.json'), null) || U.readJSON(join(RUN, 'brief.input.json'), null) || {};
let siteUrl = pagesJson?.final_origin || pagesJson?.site || brief.url || (args.url && args.url !== true ? args.url : null);
if (!siteUrl) { console.error(L('Нет pages.json и не задан --url.', 'No pages.json and no --url given.')); process.exit(2); }
siteUrl = U.normalizeUrl(siteUrl);
const origin = new URL(siteUrl).origin;
const host = U.hostOf(origin).replace(/^\[|\]$/g, '');
const isIp = /^[\d.]+$/.test(host) || host.includes(':');
// a public-looking name that resolves to a private address (intranet, hosts file) is treated as local: nothing leaves the machine
const isLocal = host === 'localhost' || host.endsWith('.localhost') || (isIp && U.isPrivateIp(host)) || /\.(local|lan|internal|test|example|invalid)$/.test(host)
  || (!isIp && await U.resolvesPrivate(host));
if (isLocal) U.allowPrivateHost(host);
const mainTitle = (pagesJson?.selected || []).find(p => p.pid === 'home')?.title || null;

// registrable domain: util knows multi-label zones (co.uk, com.ru…) and hosting platforms where every subdomain has
// another owner (github.io, gitlab.io, workers.dev, website.yandexcloud.net…); a few more builders are added here.
// On such a platform the platform's DNS, mail and certificates are not the client's: those checks are skipped.
const PLATFORM_EXTRA = /(^|\.)(taplink\.ws|craftum\.io|ucoz\.(?:ru|net|com|org|ua|kz|lv)|business\.site)$/i;
function apexOf(h) {
  if (isIp) return h;
  const pm = h.match(PLATFORM_EXTRA);
  if (pm) { const parts = h.split('.'); return parts.slice(-(pm[2].split('.').length + 1)).join('.'); }
  return U.registrableDomain(h);
}
const apex = apexOf(host);
const tld = apex.split('.').pop();
const platformSub = !isIp && (U.isPlatformHost(host) || PLATFORM_EXTRA.test(host));

// ---------- external-service policy ----------
const stageArg = args.stage && args.stage !== true ? String(args.stage) : null;
const stage = stageArg || brief.stage || null;
const betaSignals = pagesJson?.beta_signals || [];
const ext = (() => {
  if (isLocal || isIp) return { allowed: false, why: L('локальный адрес или IP', 'local address or IP') };
  if (stage && stage !== 'live') return { allowed: false, why: L(`стадия ${stage}`, `stage ${stage}`) };
  if (!stage && betaSignals.length) return { allowed: false, why: L(`признаки беты (${betaSignals.slice(0, 3).join(', ')}); запустите с --stage live, если сайт боевой`, `beta signals (${betaSignals.slice(0, 3).join(', ')}); pass --stage live if this is production`) };
  return { allowed: true, why: stage ? `stage=${stage}` : L('стадия не задана, публичный адрес — считаем боевым', 'no stage given, public host — treated as live') };
})();
const crtshAllowed = ext.allowed && args.crtsh !== false && brief.external_services?.crtsh !== false && !platformSub;
const regionsAllowed = ext.allowed && (args.regions === true || brief.external_services?.regions === true);
const used = []; // external calls of this run (also in log.md)
function external(service, what, count = 1) { used.push({ service, what, count }); U.logExternal(RUN, service, what, count); }

// ---------- resume ----------
const TRANSIENT = /браузер занят|browser slots busy/i; // notes that only explain why the previous call stopped
const prev = U.readJSON(OUT, null);
const resuming = !!(prev && prev.partial && prev.resume && Array.isArray(prev.resume.done));
const done = new Set(resuming ? prev.resume.done : []);
const out = {
  ...U.measureHeader('domain', RUN), partial: false, resume: null, site: origin, host, apex, platform_subdomain: platformSub,
  external: { allowed: ext.allowed, why: ext.why, crtsh: crtshAllowed, regions: regionsAllowed, used: resuming ? (prev.external?.used || []) : used },
  dns: resuming ? prev.dns : null, email: resuming ? prev.email : null, caa: resuming ? prev.caa : null, dnssec: resuming ? prev.dnssec : null,
  registration: resuming ? prev.registration : null, security_txt: resuming ? prev.security_txt : null,
  subdomains: resuming ? prev.subdomains : null, regions: resuming ? prev.regions : null,
  flags: [], errors: resuming ? (prev.errors || []) : [], not_checked: resuming ? (prev.not_checked || []).filter(x => !TRANSIENT.test(x)) : [],
};
if (resuming) used.push(...(prev.external?.used || [])), out.external.used = used;
const addNotChecked = s => { if (!out.not_checked.includes(s)) out.not_checked.push(s); };
// A step ran out of time. If other work was done in this call, the step stays undone and the next call repeats it;
// if it was the first step of the call, we keep what it got (so every call makes progress) and note the gap.
let cutNote = null;
function cutShort(note) { cutNote = note; }

// ---------- DNS ----------
const resolver = new Resolver({ timeout: 4000, tries: 2 });
// Some VPN/proxy setups run a local DNS that answers only A queries (MX/TXT/NS → ENODATA).
// Taking that at face value gives false «no SPF / no DMARC / no MX», so we detect it once and switch to DoH.
let dnsMode = null; // 'system' | 'limited'
let dohCalls = 0, dohLogged = 0;
const DOH_LIMIT = 160;
async function detectResolver() {
  if (dnsMode) return dnsMode;
  try { dnsMode = (await resolver.resolveMx('gmail.com')).length ? 'system' : 'limited'; } catch { dnsMode = 'limited'; }
  return dnsMode;
}
function flushDoh() { if (dohCalls > dohLogged) { external('dns.google', L(`DNS-запросы (MX, TXT, NS, CNAME, CAA) по домену ${apex}${out.subdomains?.status === 'ok' ? ' и поддоменам' : ''}`, `DNS queries (MX, TXT, NS, CNAME, CAA) for ${apex}${out.subdomains?.status === 'ok' ? ' and subdomains' : ''}`), dohCalls - dohLogged); dohLogged = dohCalls; } }
const DOH_TYPES = { A: 1, AAAA: 28, CNAME: 5, MX: 15, TXT: 16, NS: 2, CAA: 257 };
async function doh(name, type) {
  if (!ext.allowed) return { records: [], error: 'resolver_limited' };
  if (dohCalls >= DOH_LIMIT) return { records: [], error: 'doh_limit' };
  dohCalls++;
  const r = await U.politeFetch(`https://dns.google/resolve?name=${encodeURIComponent(name)}&type=${type}`, { accept: 'application/dns-json', timeoutMs: 10000, retries: 0, lang });
  try {
    const j = JSON.parse(r.body || '');
    if (j.Status === 3) return { records: [], nx: true, via: 'dns.google' };
    if (j.Status !== 0) return { records: [], error: 'doh_status_' + j.Status };
    const ans = (j.Answer || []).filter(a => a.type === DOH_TYPES[type]).map(a => a.data);
    if (type === 'MX') return { via: 'dns.google', records: ans.map(d => { const [p, e] = String(d).trim().split(/\s+/); return { priority: +p, exchange: (e || '').replace(/\.$/, '') }; }) };
    if (type === 'TXT') return { via: 'dns.google', records: ans.map(d => String(d).replace(/^"|"$/g, '').replace(/"\s*"/g, '')) };
    if (type === 'CAA') return { via: 'dns.google', records: ans.map(d => { const m = String(d).match(/^(\d+)\s+(\w+)\s+"?([^"]*)"?/); return m ? { critical: +m[1], tag: m[2], value: m[3] } : { raw: String(d) }; }) };
    return { via: 'dns.google', records: ans.map(d => String(d).replace(/\.$/, '')) };
  } catch { return { records: [], error: 'doh_failed' }; }
}
async function q(name, type) {
  if (dnsMode === 'limited' && type !== 'A') return doh(name, type);
  try {
    let r;
    switch (type) {
      case 'A': r = await resolver.resolve4(name); break;
      case 'AAAA': r = await resolver.resolve6(name); break;
      case 'CNAME': r = await resolver.resolveCname(name); break;
      case 'MX': r = (await resolver.resolveMx(name)).map(m => ({ priority: m.priority, exchange: m.exchange })); break;
      case 'TXT': r = (await resolver.resolveTxt(name)).map(parts => parts.join('')); break;
      case 'NS': r = await resolver.resolveNs(name); break;
      case 'CAA': r = (await resolver.resolveCaa(name)).map(c => ({ critical: c.critical, tag: Object.keys(c).find(k => k !== 'critical'), value: c.issue ?? c.issuewild ?? c.iodef ?? Object.values(c).find(v => typeof v === 'string') })); break;
      default: return { records: [] };
    }
    return { records: r };
  } catch (e) {
    if (['ENODATA', 'ENOTFOUND', 'NXDOMAIN'].includes(e.code)) return { records: [], nx: e.code === 'ENOTFOUND' };
    if (type === 'CAA' && e.code === 'ENOTIMP') return { records: [], error: 'ENOTIMP' };
    const d = await doh(name, type);
    return d.error ? { records: [], error: d.error === 'resolver_limited' ? (e.code || e.message) : d.error } : d;
  }
}

async function dnsStep() {
  await detectResolver();
  const [a, aaaa, cname, ns] = await Promise.all([q(host, 'A'), q(host, 'AAAA'), q(host, 'CNAME'), q(apex, 'NS')]);
  const rec = { a: a.records, aaaa: aaaa.records, cname: cname.records, ns: ns.records, errors: [a, aaaa, cname, ns].map(x => x.error).filter(Boolean),
    private_a: a.records.filter(ip => U.isPrivateIp(ip)), ipv6: aaaa.error ? null : aaaa.records.length > 0 };
  if (apex !== host) { const [aa, a6] = await Promise.all([q(apex, 'A'), q(apex, 'AAAA')]); rec.apex = { a: aa.records, aaaa: a6.records }; }
  const www = host.startsWith('www.') ? null : 'www.' + host;
  if (www) { const [wa, wc] = await Promise.all([q(www, 'A'), q(www, 'CNAME')]); rec.www = { name: www, a: wa.records, cname: wc.records, resolves: wa.records.length > 0 || wc.records.length > 0 }; }
  rec.resolver = dnsMode;
  if (dnsMode === 'limited') rec.note = ext.allowed
    ? L('Системный DNS отвечает только на A-запросы (похоже на VPN или прокси) — MX, TXT, NS, CNAME, CAA запрошены через dns.google.', 'System DNS answers only A queries (VPN/proxy?) — other types via dns.google.')
    : L('Системный DNS отвечает только на A-запросы (похоже на VPN или прокси), внешние сервисы выключены — почта, NS, CAA и IPv6 не проверены.', 'System DNS answers only A queries and external services are off — mail, NS, CAA, IPv6 not checked.');
  if (dnsMode === 'limited' && !ext.allowed) addNotChecked(L('почта (MX/SPF/DMARC/DKIM), NS, CAA, IPv6 — системный DNS отдаёт только A-записи', 'mail, NS, CAA, IPv6 — system DNS answers only A'));
  rec.ipv6_reach = await ipv6Reach(rec.aaaa);
  out.dns = rec;
}

// An AAAA record that points nowhere breaks the site for visitors on IPv6 networks: try a TCP connection to it,
// only when this machine has a global IPv6 address itself (otherwise the answer says nothing about the site).
function machineHasIpv6() {
  for (const list of Object.values(networkInterfaces())) for (const a of list || []) if (!a.internal && (a.family === 'IPv6' || a.family === 6) && /^[23]/.test(a.address)) return true;
  return false;
}
async function ipv6Reach(aaaa) {
  const ip = (aaaa || []).find(x => !U.isPrivateIp(x));
  if (!ip) return { checked: false, why: (aaaa || []).length ? 'private_only' : 'no_aaaa' };
  if (!machineHasIpv6()) return { checked: false, why: 'no_ipv6_on_this_machine', ip };
  const port = Number(new URL(origin).port) || (origin.startsWith('https:') ? 443 : 80);
  const site = await tcp6(ip, port);
  if (site.ok) return { checked: true, ok: true, ip, port, ms: site.ms };
  // a failure counts only when IPv6 works from here: control connection to a public DNS resolver (port 443)
  const control = await tcp6('2606:4700:4700::1111', 443);
  if (!control.ok) return { checked: false, why: 'no_ipv6_route_here', ip, error: site.error };
  return { checked: true, ok: false, ip, port, error: site.error };
}
function tcp6(ip, port) {
  return new Promise(resolve => {
    const started = Date.now();
    const s = net.connect({ host: ip, port, family: 6, timeout: 6000 });
    s.once('connect', () => { resolve({ ok: true, ms: Date.now() - started }); s.destroy(); });
    s.once('timeout', () => { s.destroy(); resolve({ ok: false, error: 'timeout' }); });
    s.once('error', e => resolve({ ok: false, error: e.code || e.message }));
  });
}

// ---------- mail ----------
async function spfInfo(domain) {
  const tq = await q(domain, 'TXT');
  const txt = tq.records;
  const spf = txt.filter(t => /^v=spf1(\s|$)/i.test(t.trim()));
  const res = { records: spf.length, record: spf[0] || null, lookups: 0, all: null, includes: [], errors: [], unverified: tq.error || null };
  if (spf.length > 1) res.errors.push('multiple_spf_records');
  if (!spf.length) return res;
  let queries = 0;
  // main = the domain's own policy chain (top record and its redirect= targets): only there «all» is the verdict
  async function walk(rec, depth, main) {
    const hasAll = /(^|\s)[+?~-]?all(\s|$)/i.test(rec);
    for (const term of rec.trim().split(/\s+/).slice(1)) {
      const m = term.match(/^([+?~-]?)(include|a|mx|ptr|exists|redirect|all|ip4|ip6|exp)(?:[:=](.*))?$/i);
      if (!m) { if (term) res.errors.push(`unknown_term:${term.slice(0, 40)}`); continue; }
      const mech = m[2].toLowerCase(), arg = m[3];
      if (mech === 'all') { if (main) res.all = (m[1] || '+') + 'all'; continue; }
      if (mech === 'redirect' && hasAll) continue; // RFC 7208: redirect is ignored when «all» is present
      if (['include', 'a', 'mx', 'ptr', 'exists', 'redirect'].includes(mech)) res.lookups++;
      if (mech === 'ptr') res.errors.push('ptr_used');
      if ((mech === 'include' || mech === 'redirect') && arg && depth < 8 && queries < 25) {
        if (depth === 0) res.includes.push(arg);
        queries++;
        const sub = (await q(arg, 'TXT')).records.find(t => /^v=spf1(\s|$)/i.test(t.trim()));
        if (!sub) res.errors.push(`include_without_spf:${arg}`); else await walk(sub, depth + 1, main && mech === 'redirect');
      }
    }
  }
  await walk(spf[0], 0, true);
  if (res.lookups > 10) res.errors.push('too_many_lookups');
  return res;
}
const DKIM_SELECTORS = ['default', 'mail', 'dkim', 'google', 'selector1', 'selector2', 'yandex', 'k1', 's1', 's2', 'smtp', 'mx', 'mailru', 'sendgrid', 'zoho', 'unisender', 'beget', 'timeweb', 'protonmail', 'fm1'];
async function emailStep() {
  if (platformSub) { // mail, CAA and DNSSEC of a hosting platform are the platform's, not the client's
    out.email = null; out.caa = null; out.dnssec = { checked: false, why: 'platform' };
    addNotChecked(L('почта (MX/SPF/DMARC/DKIM), CAA, DNSSEC — адрес на домене платформы, это её настройки', 'mail, CAA, DNSSEC — platform subdomain'));
    return;
  }
  const mx = await q(apex, 'MX');
  const mxs = (mx.records || []).sort((a, b) => a.priority - b.priority);
  const nullMx = mxs.length === 1 && (mxs[0].exchange === '' || mxs[0].exchange === '.');
  const spf = await spfInfo(apex);
  const dq = await q('_dmarc.' + apex, 'TXT');
  const dm = dq.records.find(t => /^v=DMARC1/i.test(t.trim())) || null;
  const tags = dm ? Object.fromEntries(dm.split(';').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim()]; })) : null;
  const dkimFound = [], dkimNull = [], dkimRecs = new Set(); let dkimErr = null;
  for (let k = 0; k < DKIM_SELECTORS.length; k += 5) {
    const batch = DKIM_SELECTORS.slice(k, k + 5);
    const rs = await Promise.all(batch.map(s => q(`${s}._domainkey.${apex}`, 'TXT')));
    rs.forEach((r, i) => {
      if (r.error) dkimErr = r.error;
      const rec = r.records.find(t => /v=DKIM1|(^|;)\s*p=/i.test(t));
      if (!rec) return;
      dkimRecs.add(rec);
      if (/(^|;)\s*p=\s*(;|$)/i.test(rec)) dkimNull.push(batch[i]); else dkimFound.push(batch[i]); // empty p= is a revoked/null key
    });
  }
  const dkimWildcard = dkimFound.length + dkimNull.length === DKIM_SELECTORS.length && dkimRecs.size === 1;
  out.email = {
    mx: mxs.slice(0, 10), null_mx: nullMx, accepts_mail: mx.error ? null : mxs.length > 0 && !nullMx,
    unverified: [mx.error && 'mx', spf.unverified && 'spf', dq.error && 'dmarc', dkimErr && 'dkim'].filter(Boolean),
    spf, dmarc: dm ? { record: dm.slice(0, 300), p: tags.p || null, sp: tags.sp || null, pct: tags.pct || null, rua: !!tags.rua, ruf: !!tags.ruf, adkim: tags.adkim || null, aspf: tags.aspf || null } : null,
    dkim: { found: dkimWildcard ? [] : dkimFound, null_keys: dkimWildcard ? [] : dkimNull, wildcard: dkimWildcard, tried: DKIM_SELECTORS.length,
      note: dkimWildcard ? L('на любой селектор отвечает одна запись (wildcard) — выводов о DKIM не делаем', 'wildcard record for every selector — no DKIM conclusion') : dkimFound.length ? null : L('селектор не угадан — DKIM не удалось проверить (это не значит, что его нет)', 'selector not guessed — DKIM could not be verified (does not mean it is missing)') },
  };
  // CAA (inherits from parents up to the apex)
  let caa = null, from = null;
  for (let n = host; n && n.split('.').length >= apex.split('.').length; n = n.split('.').slice(1).join('.')) {
    const r = await q(n, 'CAA');
    if (r.error === 'ENOTIMP') { caa = null; from = 'not_supported'; break; }
    if (r.error) { caa = null; from = 'error:' + r.error; break; }
    if (r.records.length) { caa = r.records; from = n; break; }
    if (n === apex) break;
  }
  out.caa = { records: caa || [], inherited_from: from, any_ca: !caa?.length && !(from === 'not_supported' || String(from).startsWith('error:')) };
  // DNSSEC: AD flag from a validating public resolver
  if (ext.allowed) {
    const r = await U.politeFetch(`https://dns.google/resolve?name=${encodeURIComponent(apex)}&type=DS`, { accept: 'application/dns-json', timeoutMs: 10000, lang });
    external('dns.google', L(`DS-запись (DNSSEC) домена ${apex}`, `DS record (DNSSEC) of ${apex}`));
    try { const j = JSON.parse(r.body || ''); out.dnssec = { ds: (j.Answer || []).some(a => a.type === 43), ad: !!j.AD }; } catch { out.dnssec = { error: 'doh_failed' }; }
  } else out.dnssec = { checked: false };
}

// ---------- registration: RDAP / WHOIS ----------
function whois(server, query, timeoutMs = 12000) {
  return new Promise(resolve => {
    let data = '', settled = false;
    const done_ = v => { if (!settled) { settled = true; resolve(v); } };
    const s = net.connect({ host: server, port: 43, timeout: timeoutMs }, () => s.write(query + '\r\n'));
    s.setEncoding('utf8');
    s.on('data', d => { data += d; if (data.length > 200000) s.destroy(); });
    s.on('end', () => done_({ ok: true, text: data }));
    s.on('close', () => done_({ ok: !!data, text: data, error: data ? null : 'closed' }));
    s.on('timeout', () => { s.destroy(); done_({ ok: false, error: 'timeout' }); });
    s.on('error', e => done_({ ok: false, error: e.code || e.message }));
  });
}
function parseWhois(text) {
  const g = re => { const m = text.match(re); return m ? m[1].trim() : null; };
  const expires = g(/^\s*(?:paid-till|Registry Expiry Date|Registrar Registration Expiration Date|Expiration Date|Expiry Date|Expiration Time|expires|expire|renewal date)\s*:\s*(.+)$/im);
  const created = g(/^\s*(?:created|Creation Date|Registered on|Registration Time|registered)\s*:\s*(.+)$/im);
  const registrar = g(/^\s*(?:registrar|Registrar|Sponsoring Registrar)\s*:\s*(.+)$/im);
  const state = g(/^\s*state\s*:\s*(.+)$/im);
  const freeDate = g(/^\s*free-date\s*:\s*(.+)$/im);
  const statuses = [...text.matchAll(/^\s*(?:Domain Status|status)\s*:\s*([^\s]+)/gim)].map(m => m[1]).slice(0, 10);
  const notFound = /No entries found|NOT FOUND|No match for|Domain not found|is free/i.test(text) && !expires;
  return { expires, created, registrar: registrar ? registrar.slice(0, 80) : null, state, free_date: freeDate, statuses, not_found: notFound };
}
function daysTo(d) { const t = Date.parse(String(d || '').replace(/^(\d{4})\.(\d\d)\.(\d\d)/, '$1-$2-$3')); return Number.isNaN(t) ? null : Math.floor((t - Date.now()) / 86400000); }
async function registrationStep() {
  if (isLocal || isIp) { out.registration = { checked: false, why: 'local' }; return; }
  if (platformSub) { out.registration = { checked: false, why: L('адрес на домене платформы — срок домена ведёт платформа', 'platform subdomain') }; return; }
  if (!ext.allowed) { out.registration = { checked: false, why: ext.why }; addNotChecked(L(`срок домена (внешний сервис выключен: ${ext.why})`, `domain expiry (external off: ${ext.why})`)); return; }
  const whoisZones = { ru: 'whois.tcinet.ru', su: 'whois.tcinet.ru', 'xn--p1ai': 'whois.tcinet.ru' };
  if (!whoisZones[tld]) {
    const boot = await U.politeFetch('https://data.iana.org/rdap/dns.json', { accept: 'application/json', timeoutMs: 15000, lang });
    external('data.iana.org', L('справочник RDAP-серверов (без данных сайта)', 'RDAP bootstrap list (no site data)'));
    let base = null;
    try { const j = JSON.parse(boot.body || ''); for (const [tlds, urls] of j.services || []) if (tlds.includes(tld)) { base = urls.find(u => u.startsWith('https:')) || urls[0]; break; } } catch {}
    if (base) {
      const url = base.replace(/\/?$/, '/') + 'domain/' + encodeURIComponent(apex);
      const r = await U.politeFetch(url, { accept: 'application/rdap+json,application/json', timeoutMs: 20000, lang });
      external(U.hostOf(url), L(`RDAP-запрос домена ${apex}`, `RDAP query for ${apex}`));
      try {
        const j = JSON.parse(r.body || '');
        const ev = a => (j.events || []).find(e => e.eventAction === a)?.eventDate || null;
        const reg = (j.entities || []).find(e => (e.roles || []).includes('registrar'));
        const fn = reg?.vcardArray?.[1]?.find(x => x[0] === 'fn')?.[3] || null;
        out.registration = { checked: true, method: 'rdap', server: U.hostOf(url), status_code: r.status, expires: ev('expiration'), created: ev('registration'), last_changed: ev('last changed'),
          days_left: daysTo(ev('expiration')), registrar: fn ? String(fn).slice(0, 80) : null, statuses: (j.status || []).slice(0, 10), nameservers: (j.nameservers || []).map(n => n.ldhName).slice(0, 6) };
        return;
      } catch { out.errors.push({ step: 'rdap', error: `RDAP ${r.status || r.error}` }); }
    }
  }
  // WHOIS (port 43): ru/su/рф directly, others via IANA referral
  let server = whoisZones[tld] || null;
  if (!server) {
    const iana = await whois('whois.iana.org', tld);
    external('whois.iana.org', L(`WHOIS-справка по зоне .${tld}`, `WHOIS referral for .${tld}`));
    if (!iana.ok) { out.registration = { checked: false, why: `whois.iana.org: ${iana.error}` }; addNotChecked(L('срок домена: WHOIS (порт 43) недоступен', 'domain expiry: WHOIS port 43 unreachable')); return; }
    server = (iana.text.match(/^\s*(?:refer|whois)\s*:\s*(\S+)/im) || [])[1] || null;
  }
  if (!server) { out.registration = { checked: false, why: L('нет WHOIS-сервера зоны', 'no WHOIS server for TLD') }; addNotChecked(L('срок домена: у зоны нет RDAP и WHOIS', 'domain expiry: no RDAP/WHOIS for TLD')); return; }
  const w = await whois(server, apex);
  external(server, L(`WHOIS-запрос домена ${apex}`, `WHOIS query for ${apex}`));
  if (!w.ok) { out.registration = { checked: false, why: `${server}: ${w.error}` }; addNotChecked(L(`срок домена: WHOIS ${server} не ответил (${w.error}) — находку о сроке не ставить`, `domain expiry: WHOIS ${server} failed (${w.error})`)); return; }
  const p = parseWhois(w.text); // only dates, registrar and statuses are kept — never names, e-mails or phones
  out.registration = { checked: true, method: 'whois', server, expires: p.expires, days_left: daysTo(p.expires), created: p.created, registrar: p.registrar, state: p.state,
    free_date: p.free_date, statuses: p.statuses, not_found: p.not_found };
  if (!p.expires && !p.not_found) addNotChecked(L('срок домена: в ответе WHOIS нет даты окончания', 'domain expiry: no date in WHOIS answer'));
}

// ---------- security.txt ----------
async function securityTxtStep() {
  const res = { found: false };
  for (const path of ['/.well-known/security.txt', '/security.txt']) {
    const r = await U.politeFetch(origin + path, { accept: 'text/plain,*/*', timeoutMs: 15000, lang });
    const body = r.body || '';
    const html = /^\s*(<!doctype html|<html|<head|<body)/i.test(body.slice(0, 300));
    if (r.status === 200 && !html && /^\s*Contact\s*:/im.test(body)) {
      const exp = (body.match(/^\s*Expires\s*:\s*(.+)$/im) || [])[1] || null;
      Object.assign(res, { found: true, path, content_type: r.headers?.['content-type'] || null, contact: (body.match(/^\s*Contact\s*:/gim) || []).length,
        expires: exp ? exp.trim() : null, expired: exp ? Date.parse(exp) < Date.now() : null, signed: /BEGIN PGP SIGNED MESSAGE/.test(body), canonical: /^\s*Canonical\s*:/im.test(body) });
      break;
    }
    res[path] = r.status;
  }
  out.security_txt = res;
}

// ---------- subdomains (crt.sh) ----------
const TEST_LIKE = /(^|[.-])(dev|develop|test|testing|stage|staging|stg|beta|demo|preprod|pre|uat|qa|sandbox|old|new|tmp|temp|preview|v2|next|draft|rc)(\d*)([.-]|$)/i;
// panels and tools: an open login page there is a different story from a test copy of the site
const ADMIN_LIKE = /(^|[.-])(admin|adm|crm|git|gitlab|jenkins|ci|panel|cms|cpanel|webmail|phpmyadmin|pma|grafana|kibana)(\d*)([.-]|$)/i;
const subKind = (n) => { const p = n.slice(0, -apex.length); return ADMIN_LIKE.test(p) ? 'admin' : TEST_LIKE.test(p) ? 'test' : 'other'; };
const TAKEOVER = [
  [/\.github\.io$/i, /There isn't a GitHub Pages site here/i, 'GitHub Pages'], [/\.herokuapp\.com$|\.herokudns\.com$/i, /No such app|no-such-app/i, 'Heroku'],
  [/\.s3[.-][\w.-]*amazonaws\.com$|\.s3\.amazonaws\.com$/i, /NoSuchBucket|The specified bucket does not exist/i, 'AWS S3'],
  [/\.azurewebsites\.net$|\.cloudapp\.net$|\.trafficmanager\.net$|\.blob\.core\.windows\.net$/i, /404 Web Site not found|The resource you are looking for has been removed/i, 'Azure'],
  [/\.netlify\.app$|\.netlify\.com$/i, /Not Found - Request ID/i, 'Netlify'], [/\.vercel\.app$|vercel-dns\.com$/i, /The deployment could not be found|DEPLOYMENT_NOT_FOUND/i, 'Vercel'],
  [/\.myshopify\.com$/i, /Sorry, this shop is currently unavailable/i, 'Shopify'], [/\.wordpress\.com$/i, /Do you want to register/i, 'WordPress.com'],
  [/\.ghost\.io$/i, /The thing you were looking for is no longer here/i, 'Ghost'], [/\.surge\.sh$/i, /project not found/i, 'Surge'],
  [/\.bitbucket\.io$/i, /Repository not found/i, 'Bitbucket'], [/\.pantheonsite\.io$/i, /The gods are wise/i, 'Pantheon'],
  [/\.zendesk\.com$/i, /Help Center Closed/i, 'Zendesk'], [/\.webflow\.io$|proxy-ssl\.webflow\.com$/i, /The page you are looking for doesn't exist or has been moved/i, 'Webflow'],
  [/\.fastly\.net$/i, /Fastly error: unknown domain/i, 'Fastly'], [/\.helpscoutdocs\.com$/i, /No settings were found for this company/i, 'Help Scout'],
  [/\.pages\.dev$/i, null, 'Cloudflare Pages'], [/\.tilda\.ws$/i, null, 'Tilda'], [/\.fly\.dev$/i, null, 'Fly.io'], [/\.onrender\.com$/i, null, 'Render'],
];
async function crtshStep() {
  const sub = { source: 'crt.sh', status: null, names_total: 0, names: [] };
  out.subdomains = sub;
  if (!crtshAllowed) { sub.status = 'not_checked'; sub.why = !ext.allowed ? ext.why : platformSub ? 'platform' : L('crt.sh выключен', 'crt.sh disabled'); addNotChecked(L(`поддомены (crt.sh): ${sub.why}`, `subdomains (crt.sh): ${sub.why}`)); return; }
  const url = `https://crt.sh/?q=${encodeURIComponent('%.' + apex)}&output=json`;
  // fetchBytes: the 25 s timeout covers the body too, and big domains are cut at 20 MB instead of loading everything
  const CAP = 20 * 1024 * 1024;
  let r = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) { if (timeLeft() < 45000) break; await U.sleep(10000); }
    r = await U.fetchBytes(url, { accept: 'application/json', timeoutMs: 25000, maxBytes: CAP });
    external('crt.sh', L(`поиск сертификатов по домену ${apex}`, `certificate search for ${apex}`));
    if (r.status === 200 && r.bytes) break;
  }
  if (!(r && r.status === 200 && r.bytes)) { sub.status = 'unavailable'; sub.error = r?.error || `HTTP ${r?.status}`; addNotChecked(L('поддомены: crt.sh недоступен (вывод «поддоменов нет» не делаем)', 'subdomains: crt.sh unavailable')); return; }
  let rows, text = r.buf.toString('utf8');
  try { rows = JSON.parse(text); }
  catch {
    // truncated answer: keep the complete records before the cut
    const cut = text.lastIndexOf('},');
    try { rows = cut > 0 ? JSON.parse(text.slice(0, cut + 1) + ']') : null; } catch { rows = null; }
    if (!Array.isArray(rows)) { sub.status = 'bad_json'; addNotChecked(L('поддомены: crt.sh вернул неполный ответ', 'subdomains: crt.sh answer truncated')); return; }
    sub.truncated = true;
    addNotChecked(L(`поддомены: ответ crt.sh обрезан на ${Math.round(CAP / 1048576)} МБ — список неполный`, `subdomains: crt.sh answer cut at ${Math.round(CAP / 1048576)} MB`));
  }
  text = null;
  const names = new Set();
  for (const row of rows) for (const n of String(row.name_value || '').split(/\s+/)) {
    const x = n.toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (x && (x === apex || x.endsWith('.' + apex)) && /^[a-z0-9.-]+$/.test(x)) names.add(x);
  }
  sub.status = 'ok';
  sub.names_total = names.size;
  sub.wildcard = rows.some(row => String(row.name_value || '').includes('*.'));
  const prio = n => (subKind(n) === 'other' ? 1 : 0);
  sub.names = [...names].filter(n => n !== host).sort((a, b) => prio(a) - prio(b) || a.localeCompare(b)).slice(0, 300).map(n => ({ name: n, kind: subKind(n), test_like: subKind(n) === 'test' }));
  if (names.size > 300) addNotChecked(L(`поддомены: взяли 300 из ${names.size}`, `subdomains: 300 of ${names.size}`));
}

async function subDnsStep() {
  const sub = out.subdomains; if (!sub || sub.status !== 'ok') return;
  const list = sub.names;
  const limited = dnsMode === 'limited'; // system DNS answers only A: CNAME/AAAA via DoH within its budget
  await U.mapLimit(list, limited ? 4 : 10, async it => {
    if (it.dns) return;
    let a, aaaa = { records: [] }, cn = { records: [] };
    if (!limited) [a, aaaa, cn] = await Promise.all([q(it.name, 'A'), q(it.name, 'AAAA'), q(it.name, 'CNAME')]);
    else { a = await q(it.name, 'A'); if (dohCalls < DOH_LIMIT - 10) cn = await q(it.name, 'CNAME'); else it.cname_unknown = true; }
    if (cn.error) it.cname_unknown = true;
    it.cname = cn.records[0] || null;
    it.ips = [...a.records, ...aaaa.records].slice(0, 4);
    it.private = it.ips.some(ip => U.isPrivateIp(ip)); // a mixed public+private answer could still route a GET into the user's network
    if (it.cname) {
      const [ta, t6] = limited ? [await doh(it.cname, 'A'), { records: [] }] : await Promise.all([q(it.cname, 'A'), q(it.cname, 'AAAA')]);
      it.cname_dead = !ta.error && ta.records.length === 0 && t6.records.length === 0 && (ta.nx || t6.nx);
      const tk = TAKEOVER.find(([re]) => re.test(it.cname));
      if (tk) it.service = tk[2];
    }
    it.dns = it.ips.length ? (it.private ? 'private' : 'live') : it.cname_dead ? 'dangling' : 'no_records';
  });
  const unknown = list.filter(x => x.cname_unknown).length;
  if (unknown) addNotChecked(L(`поддомены: CNAME не проверены у ${unknown} из ${list.length} (системный DNS отдаёт только A-записи)`, `subdomains: CNAME unknown for ${unknown}/${list.length}`));
  sub.live = list.filter(x => x.dns === 'live').length;
  sub.private = list.filter(x => x.dns === 'private').map(x => x.name).slice(0, 20);
  sub.dangling = list.filter(x => x.dns === 'dangling').map(x => ({ name: x.name, cname: x.cname, service: x.service || null })).slice(0, 20);
  sub.no_records = list.filter(x => x.dns === 'no_records').length;
}

// tiny DOMParser extraction for subdomain pages (tab with scripts disabled)
let browser = null, tab = null, release = null;
async function openTab() {
  if (tab) return;
  // seo and headers usually hold the two machine-wide slots at this moment: wait only within our budget
  try { release = await U.acquireBrowserSlot({ waitMs: Math.max(3000, timeLeft() - 15000) }); }
  catch (e) { throw Object.assign(new Error(e.message), { code: 'NO_SLOT' }); }
  for (let k = 0; ; k++) { try { browser = await Browser.launch(); break; } catch (e) { if (k >= 2) { release(); release = null; throw Object.assign(new Error(e.message), { code: 'LAUNCH' }); } await U.sleep(1500); } }
  tab = await browser.newPage();
  await tab.send('Emulation.setScriptExecutionDisabled', { value: true });
}
async function parseMin(html, url) {
  await openTab();
  return tab.evaluate((html, url) => {
    const d = new DOMParser().parseFromString(html, 'text/html');
    const robots = [...d.querySelectorAll('meta')].filter(m => /^(robots|googlebot|yandex)$/i.test(m.getAttribute('name') || '')).map(m => m.getAttribute('content') || '').join(',');
    const t = d.querySelector('title');
    return { title: t ? t.textContent.replace(/\s+/g, ' ').trim().slice(0, 120) : '', robots, text_len: (d.body ? d.body.textContent : '').replace(/\s+/g, ' ').trim().length,
      password: !!d.querySelector('input[type="password" i]') };
  }, html, url);
}
async function closeBrowser() {
  const profile = browser?.profile;
  try { if (browser) await browser.close(); } catch {}
  for (let k = 0; profile && existsSync(profile) && k < 10; k++) { try { rmSync(profile, { recursive: true, force: true }); } catch {} await U.sleep(300); }
  try { release?.(); } catch {}
  browser = null; tab = null; release = null;
}

async function subHttpStep() {
  const sub = out.subdomains; if (!sub || sub.status !== 'ok') return;
  const www = 'www.' + U.stripWww(host);
  const cand = sub.names.filter(x => (x.dns === 'live' || (x.dns !== 'private' && x.service)) && x.name !== www && x.name !== U.stripWww(host)).slice(0, 40);
  if (!cand.length || !SUB_GETS) { sub.http = sub.http || []; if (cand.length) addNotChecked(L(`поддомены: страницы не открывали (--sub-gets 0), живых ${cand.length}`, `subdomains: pages not opened (--sub-gets 0), live ${cand.length}`)); return; }
  // take the browser before any GET: a busy machine then costs nothing, and a resumed run never repeats GETs
  await openTab();
  let gets = sub.http_gets || 0; sub.http = sub.http || []; // ≤ 20 GET per run, a resumed call included
  for (const it of cand) {
    if (gets >= SUB_GETS || sub.http.some(h => h.name === it.name)) continue;
    if (timeLeft() < 10000) { cutShort(L('поддомены: проверены не все (время)', 'subdomains: cut by time')); break; }
    let r = await U.politeFetch(`https://${it.name}/`, { timeoutMs: 12000, retries: 0, maxBytes: 600000, lang }); gets++;
    let scheme = 'https';
    if (!r.status && !r.skipped && gets < SUB_GETS) { r = await U.politeFetch(`http://${it.name}/`, { timeoutMs: 12000, retries: 0, maxBytes: 600000, lang }); gets++; scheme = 'http'; }
    const h = r.headers || {};
    const finalHost = r.url ? U.hostOf(r.url) : null;
    const redirected = !!finalHost && finalHost !== it.name;
    const kind = it.kind || subKind(it.name);
    const rec = { name: it.name, kind, test_like: kind === 'test', status: r.status, final_url: r.url, error: r.error || null, skipped: r.skipped || null,
      auth: r.status === 401 || !!h['www-authenticate'], x_robots_tag: h['x-robots-tag'] || null,
      redirects_to: redirected ? finalHost : null, redirect_to_main: redirected && U.sameSite(r.url, origin) };
    if (it.service) { const tk = TAKEOVER.find(([re]) => re.test(it.cname || '')); rec.service = it.service; rec.takeover_fingerprint = !!(tk?.[1] && r.body && tk[1].test(r.body.slice(0, 50000))); }
    if (redirected) {
      // old./new./v2. → the main site is the right setup: the robots verdict belongs to the target, not to this name
      rec.verdict = 'redirects'; rec.open_to_robots = null;
    } else if (r.status === 200 && r.body && /html/i.test(h['content-type'] || '')) {
      try { const p = await parseMin(r.body, r.url); rec.title = p.title; rec.meta_robots = p.robots || null; rec.same_as_main = !!(mainTitle && p.title && p.title === mainTitle); rec.login_form = p.password; }
      catch (e) { if (e.code === 'NO_SLOT' || e.code === 'LAUNCH') throw e; rec.parse_error = e.message; }
      rec.noindex = /noindex|none/i.test(`${rec.x_robots_tag || ''},${rec.meta_robots || ''}`);
      if (kind !== 'other' && !rec.noindex && gets < SUB_GETS) {
        // robots.txt of this very name (not of wherever it led)
        const rb = await U.politeFetch(`${scheme}://${it.name}/robots.txt`, { timeoutMs: 10000, retries: 0, maxRedirects: 5, accept: 'text/plain,*/*', lang }); gets++;
        if (rb.url && U.hostOf(rb.url) !== it.name) rec.robots_disallow_all = null; // robots.txt lives elsewhere: unknown
        else if (rb.status === 200 && rb.body && !/^\s*</.test(rb.body)) { const pr = U.parseRobots(rb.body); const base = `${scheme}://${it.name}/`; rec.robots_disallow_all = !U.robotsAllows(pr, base, 'Googlebot') && !U.robotsAllows(pr, base, 'YandexBot'); }
        else rec.robots_disallow_all = false;
      }
      // unknown when the page could not be parsed (meta robots unread)
      rec.open_to_robots = rec.auth || rec.noindex || rec.robots_disallow_all === true ? false : (rec.parse_error || rec.robots_disallow_all === null) ? null : true;
      rec.verdict = rec.auth ? 'auth' : rec.open_to_robots ? 'open' : rec.open_to_robots === false ? 'closed' : 'unknown';
    } else rec.verdict = rec.auth ? 'auth' : r.status ? `status_${r.status}` : 'error';
    sub.http.push(rec);
  }
  sub.http_gets = gets;
  const opened = cand.filter(c => sub.http.some(h => h.name === c.name)).length;
  if (opened < cand.length && gets >= SUB_GETS) addNotChecked(L(`поддомены: открыли ${opened} из ${cand.length} живых (лимит ${SUB_GETS} GET)`, `subdomains: opened ${opened} of ${cand.length} live (limit ${SUB_GETS} GETs)`));
}

// ---------- regions (check-host.net) ----------
async function regionsStep() {
  if (!regionsAllowed) { if (args.regions) addNotChecked(L(`регионы: внешний сервис выключен (${ext.why})`, `regions: external off (${ext.why})`)); return; }
  const start = await U.politeFetch(`https://check-host.net/check-http?host=${encodeURIComponent(origin + '/')}&max_nodes=8`, { accept: 'application/json', timeoutMs: 20000, retries: 0, lang });
  let j; try { j = JSON.parse(start.body || ''); } catch { out.regions = { error: `HTTP ${start.status}` }; external('check-host.net', L(`HTTP-проверка главной ${origin}/ (не началась)`, `HTTP check of ${origin}/ (did not start)`)); return; }
  const nodes = j.nodes || {}; let polls = 0, res = {};
  for (let k = 0; k < 4; k++) {
    await U.sleep(k === 0 ? 6000 : 5000);
    const r = await U.politeFetch(`https://check-host.net/check-result/${encodeURIComponent(j.request_id)}`, { accept: 'application/json', timeoutMs: 15000, retries: 0, lang }); polls++;
    try { res = JSON.parse(r.body || '{}'); } catch {}
    if (Object.values(res).every(v => v !== null)) break;
  }
  external('check-host.net', L(`HTTP-проверка главной ${origin}/ с ${Object.keys(nodes).length} узлов`, `HTTP check of ${origin}/ from ${Object.keys(nodes).length} nodes`), 1 + polls);
  out.regions = { request_id: j.request_id, nodes: Object.entries(nodes).map(([node, info]) => {
    const v = res[node]?.[0];
    return { node: node.split('.')[0], country: info?.[1] || info?.[0] || null, city: info?.[2] || null, ok: v ? v[0] === 1 : null, seconds: v && typeof v[1] === 'number' ? Math.round(v[1] * 100) / 100 : null,
      code: v ? (v[3] ?? null) : null, message: v ? String(v[2] ?? v[1] ?? '').slice(0, 60) : L('нет ответа', 'pending') };
  }) };
}

// ---------- flags ----------
function buildFlags() {
  const F = []; const flag = (code, level, text) => F.push({ code, level, text, where: [] });
  const r = out.registration;
  if (r?.checked && r.days_left != null) {
    if (r.days_left < 30) flag('domain-expiring', 'high', L(`Домен ${apex} истекает через ${r.days_left} дн. (${r.expires})`, `Domain expires in ${r.days_left} days`));
    else if (r.days_left < 60) flag('domain-expiring', 'medium', L(`Домен ${apex} истекает через ${r.days_left} дн. (${r.expires}) — проверьте автопродление`, `Domain expires in ${r.days_left} days`));
  }
  const e = out.email;
  if (e) {
    const un = new Set(e.unverified || []);
    if (e.accepts_mail && !e.spf.record && !un.has('spf')) flag('no-spf', 'medium', L(`У ${apex} есть MX, но нет SPF`, 'MX without SPF'));
    if (e.spf.record && /^\+?all$/.test(e.spf.all || '')) flag('spf-plus-all', 'high', L('SPF разрешает отправку всем (+all)', 'SPF +all'));
    if (e.spf.errors.includes('too_many_lookups')) flag('spf-lookups', 'medium', L(`SPF требует ${e.spf.lookups} DNS-запросов (> 10) — проверка падает`, `SPF needs ${e.spf.lookups} lookups (>10)`));
    if (e.spf.errors.includes('multiple_spf_records')) flag('spf-multiple', 'medium', L('Несколько SPF-записей — ошибка', 'Multiple SPF records'));
    if (!e.dmarc && !un.has('dmarc')) flag('no-dmarc', e.accepts_mail ? 'medium' : 'low', L('Нет DMARC — письма от имени домена легко подделать', 'No DMARC'));
    else if (e.dmarc && e.dmarc.p === 'none') flag('dmarc-none', 'low', L('DMARC p=none — только наблюдение, подделка не блокируется', 'DMARC p=none'));
    if (!e.mx.length && !un.has('mx')) flag('no-mx', 'low', L(`У ${apex} нет MX — адреса @${apex} не принимают почту`, 'No MX'));
  }
  if (out.caa?.any_ca) flag('no-caa', 'info', L('Нет CAA: сертификат может выпустить любой центр', 'No CAA'));
  if (out.security_txt && !out.security_txt.found) flag('no-security-txt', 'info', L('Нет /.well-known/security.txt', 'No security.txt'));
  else if (out.security_txt?.expired) flag('security-txt-expired', 'low', L('security.txt просрочен (Expires в прошлом)', 'security.txt expired'));
  else if (out.security_txt?.found && !out.security_txt.expires) flag('security-txt-no-expires', 'low', L('В security.txt нет обязательного поля Expires (RFC 9116)', 'security.txt has no Expires (required by RFC 9116)'));
  if (out.dns?.ipv6_reach?.checked && !out.dns.ipv6_reach.ok) flag('ipv6-unreachable', 'medium', L(`AAAA-запись ${out.dns.ipv6_reach.ip} есть, но порт ${out.dns.ipv6_reach.port} по IPv6 не отвечает (${out.dns.ipv6_reach.error}) — у посетителей с IPv6 сайт может не открыться`, `AAAA ${out.dns.ipv6_reach.ip} does not answer on port ${out.dns.ipv6_reach.port}`));
  const s = out.subdomains;
  if (s?.dangling?.length) flag('dangling-cname', 'high', L(`Висящие CNAME (цель не резолвится): ${s.dangling.map(d => `${d.name} → ${d.cname}`).slice(0, 5).join(', ')}`, `Dangling CNAMEs: ${s.dangling.map(d => d.name).join(', ')}`));
  for (const h of s?.http || []) {
    if (h.takeover_fingerprint) flag('subdomain-takeover', 'high', L(`${h.name}: CNAME на ${h.service}, а сервис отвечает «проекта нет» — поддомен можно захватить`, `${h.name}: possible takeover (${h.service})`));
    const kind = h.kind || (h.test_like ? 'test' : 'other');
    if (h.verdict === 'redirects') continue; // a redirect to the main site (or elsewhere) is the right setup
    if (kind === 'test' && h.status === 200 && h.open_to_robots) flag('test-stand-open', h.same_as_main ? 'high' : 'medium', L(`Тестовый стенд ${h.name} открыт роботам (нет пароля, noindex и Disallow)${h.same_as_main ? ' и повторяет основной сайт' : ''}`, `Test stand ${h.name} open to robots`));
    if (kind === 'admin' && h.status === 200 && !h.auth) flag('admin-panel-public', h.open_to_robots ? 'medium' : 'low', L(`${h.name}: страница входа в панель открыта из интернета${h.open_to_robots ? ' и доступна для индексации' : ''} — ограничить доступ по IP или VPN`, `${h.name}: admin login page reachable from the internet${h.open_to_robots ? ' and indexable' : ''}`));
  }
  if (s?.private?.length) flag('private-ip-in-dns', 'low', L(`Поддомены указывают на внутренние адреса: ${s.private.slice(0, 5).join(', ')}`, `Subdomains point to private IPs: ${s.private.slice(0, 5).join(', ')}`));
  if (out.dns && out.dns.ipv6 === false) flag('no-ipv6', 'info', L('Нет AAAA (IPv6)', 'No AAAA (IPv6)'));
  if (out.dns?.www && !out.dns.www.resolves) flag('www-no-dns', 'low', L(`${out.dns.www.name} не резолвится — кто наберёт www, увидит ошибку`, `${out.dns.www.name} does not resolve`));
  for (const n of out.regions?.nodes || []) if (n.ok === false) flag('region-fail', 'medium', L(`Из ${n.country}${n.city ? ', ' + n.city : ''} главная не открылась: ${n.message}`, `Home failed from ${n.country}: ${n.message}`));
  return F;
}

// ---------- output ----------
function writeAll(partial) {
  out.generated = U.nowIso(); out.partial = partial; out.resume = partial ? { done: [...done] } : null;
  out.external.used = used;
  out.flags = buildFlags();
  const lv = { high: 0, medium: 0, low: 0, info: 0 }; for (const f of out.flags) lv[f.level]++;
  out.summary = { flags: lv, external_calls: used.reduce((a, x) => a + (x.count || 1), 0) };
  U.writeJSON(OUT, out);
}
function summaryLines(partial) {
  const d = out.dns, e = out.email, r = out.registration, s = out.subdomains;
  const lines = [`${L('Домен', 'Domain')} · ${host} (${L('домен', 'apex')} ${apex})${partial ? L(' · ЧАСТИЧНО', ' · PARTIAL') : ''}`];
  lines.push(`${L('Внешние сервисы', 'External services')}: ${ext.allowed ? L('разрешены', 'allowed') : L('выключены', 'off')} (${ext.why}); ${L('вызовов', 'calls')} ${out.summary.external_calls}`);
  if (d) lines.push(`DNS: A ${d.a.join(', ') || '—'}; AAAA ${d.aaaa.length ? L('есть', 'yes') + (d.ipv6_reach?.checked ? (d.ipv6_reach.ok ? L(' (порт отвечает)', ' (port answers)') : L(' (порт НЕ отвечает)', ' (port does NOT answer)')) : L(' (доступность не проверена)', ' (reachability not checked)')) : d.ipv6 === null ? L('не проверено', 'unverified') : L('нет', 'no')}; CNAME ${d.cname[0] || '—'}; NS ${d.ns.slice(0, 3).join(', ') || '—'}${d.www ? `; ${d.www.name} ${d.www.resolves ? L('резолвится', 'resolves') : L('НЕ резолвится', 'does NOT resolve')}` : ''}`);
  if (e) {
    const un = new Set(e.unverified || []);
    const mxText = un.has('mx') ? L('не проверено', 'unverified') : e.null_mx ? L('null MX (почту не принимает)', 'null MX (no mail)') : e.mx.map(m => m.exchange).slice(0, 3).join(', ') || L('нет', 'none');
    const dk = e.dkim.wildcard ? 'wildcard' : e.dkim.found.length ? e.dkim.found.slice(0, 4).join(', ') : e.dkim.null_keys?.length ? L('пустой ключ (p=)', 'null key') : L('селектор не найден (не проверено)', 'selector not found (unverified)');
    lines.push(`${L('Почта', 'Mail')}: MX ${mxText}; SPF ${un.has('spf') ? L('не проверено', 'unverified') : e.spf.record ? `${e.spf.all || L('без all', 'no all')}, lookup ${e.spf.lookups}` : L('нет', 'none')}; DMARC ${un.has('dmarc') ? L('не проверено', 'unverified') : e.dmarc ? 'p=' + e.dmarc.p : L('нет', 'none')}; DKIM ${dk}`);
    const caaUnknown = /^(error:|not_supported)/.test(String(out.caa?.inherited_from || ''));
    lines.push(`CAA: ${out.caa?.records?.length ? out.caa.records.map(c => `${c.tag} ${c.value}`).slice(0, 3).join('; ') : caaUnknown ? L('не проверено', 'unverified') : L('нет', 'none')}; DNSSEC: ${out.dnssec?.checked === false ? L('не проверяли', 'not checked') : out.dnssec?.ds ? L('есть', 'yes') : L('нет', 'no')}`);
  }
  if (r) lines.push(r.checked ? `${L('Регистрация', 'Registration')} (${r.method}, ${r.server}): ${L('до', 'until')} ${r.expires || '?'} (${r.days_left ?? '?'} ${L('дн.', 'days')}), ${L('регистратор', 'registrar')} ${r.registrar || '—'}${r.state ? ', ' + r.state : ''}` : `${L('Срок домена', 'Domain expiry')}: ${L('не проверен', 'not checked')} (${r.why})`);
  if (out.security_txt) lines.push(`security.txt: ${out.security_txt.found ? `${out.security_txt.path}${out.security_txt.expired ? L(' (просрочен)', ' (expired)') : ''}` : L('нет', 'none')}`);
  if (s) {
    if (s.status === 'ok') {
      lines.push(`${L('Поддомены (crt.sh)', 'Subdomains (crt.sh)')}: ${s.names_total}, ${L('живых', 'live')} ${s.live ?? '—'}, ${L('без записей', 'no records')} ${s.no_records ?? '—'}, ${L('внутренние адреса', 'private')} ${s.private?.length ?? 0}, ${L('висящие CNAME', 'dangling')} ${s.dangling?.length ?? 0}; GET ${s.http_gets ?? 0}`);
      for (const h of (s.http || []).filter(h => h.kind === 'test' || h.kind === 'admin' || h.test_like || h.takeover_fingerprint).slice(0, 6)) lines.push(`  ${h.name}${h.kind === 'admin' ? L(' (панель)', ' (panel)') : ''}: ${h.verdict === 'redirects' ? L('редирект на ', 'redirects to ') + h.redirects_to : h.status || h.error}${h.auth ? L(', пароль', ', auth') : ''}${h.noindex ? ', noindex' : ''}${h.robots_disallow_all ? ', Disallow: /' : ''}${h.open_to_robots ? L(' → ОТКРЫТ роботам', ' → OPEN to robots') : ''}${h.same_as_main ? L(', копия основного', ', mirror of main') : ''}`);
    } else lines.push(`${L('Поддомены', 'Subdomains')}: ${s.status}${s.why ? ' (' + s.why + ')' : ''}${s.error ? ' (' + s.error + ')' : ''}`);
  }
  if (out.regions?.nodes) lines.push(`${L('Регионы', 'Regions')}: ${out.regions.nodes.map(n => `${n.country || n.node} ${n.ok === true ? 'OK' : n.ok === false ? L('сбой', 'fail') : '…'}${n.seconds != null ? ' ' + n.seconds + 's' : ''}`).join('; ')}`);
  lines.push(`${L('Подсказки для линзы', 'Flags')}: high ${out.summary.flags.high}, medium ${out.summary.flags.medium}, low ${out.summary.flags.low}, info ${out.summary.flags.info}`);
  for (const f of out.flags.filter(f => f.level === 'high' || f.level === 'medium').slice(0, 8)) lines.push(`  ${f.level === 'high' ? '!' : '·'} ${f.text}`.slice(0, 220));
  if (out.not_checked.length) lines.push(`${U.msg('not_checked', lang)}: ${out.not_checked.slice(0, 3).join('; ')}`);
  if (out.errors.length) lines.push(`${U.msg('errors', lang)}: ${out.errors.slice(0, 2).map(x => `${x.step || ''} ${x.error}`).join('; ').slice(0, 200)}`);
  lines.push(`${U.msg('written', lang)}: ${OUT}`);
  if (partial) lines.push(L('Частичный результат (код 75): повторите тот же вызов — продолжу.', 'Partial (exit 75): run the same command again.'));
  return lines.slice(0, 40);
}
function finish(partial) {
  writeAll(partial);
  const lines = summaryLines(partial);
  U.writeText(U.runPath(RUN, 'stdout', 'domain.md'), lines.join('\n') + '\n');
  U.printSummary(lines);
  U.log(RUN, L(`domain.mjs: ${partial ? 'частично' : 'готово'} · внешних вызовов ${out.summary.external_calls}`, `domain.mjs: ${partial ? 'partial' : 'done'} · external calls ${out.summary.external_calls}`));
}

// ---------- main ----------
let envError = null;
async function main() {
  U.log(RUN, L(`domain.mjs: старт · ${host} · внешние сервисы: ${ext.allowed ? 'да' : 'нет'} (${ext.why})${resuming ? ' · продолжение' : ''}`, `domain.mjs: start · ${host} · external services: ${ext.allowed ? 'yes' : 'no'} (${ext.why})${resuming ? ' · resume' : ''}`));
  let didWork = false;
  const steps = [['dns', dnsStep, 15000], ['email', emailStep, 20000], ['registration', registrationStep, 30000], ['security_txt', securityTxtStep, 15000]];
  if (isLocal || isIp) { addNotChecked(L('DNS, почта, срок домена и поддомены — локальный адрес', 'DNS, mail, expiry, subdomains — local address')); steps.splice(0, 3); }
  else steps.push(['crtsh', crtshStep, 60000], ['sub_dns', subDnsStep, 30000], ['sub_http', subHttpStep, 40000], ['regions', regionsStep, 40000]);
  for (const [key, fn, minMs] of steps) {
    if (done.has(key)) continue;
    if (didWork && timeLeft() < minMs) return finish(true);
    U.progress(`domain: ${key}`);
    cutNote = null;
    try { await fn(); }
    catch (e) {
      if (e.code === 'NO_SLOT') { flushDoh(); addNotChecked(L('поддомены: браузер занят другими проверками — повторите вызов', 'subdomains: browser slots busy — run again')); return finish(true); }
      if (e.code === 'LAUNCH') { envError = e; flushDoh(); out.errors.push({ step: key, error: L('браузер не запустился: ', 'browser failed to start: ') + String(e.message || e).slice(0, 200) }); continue; }
      out.errors.push({ step: key, error: String(e.message || e).slice(0, 300) });
    }
    flushDoh();
    if (cutNote) { if (didWork) { cutNote = null; return finish(true); } addNotChecked(cutNote); cutNote = null; }
    done.add(key); didWork = true;
  }
  return finish(!!envError);
}

let code = 0;
try { await main(); code = envError ? 2 : out.partial ? 75 : 0; if (envError) console.error('domain.mjs: ' + (envError.message || envError)); }
catch (e) { console.error('domain.mjs: ' + (e?.stack || e)); try { out.errors.push({ error: String(e.message || e) }); finish(true); } catch {} code = 1; }
finally { await closeBrowser(); }
// Natural exit: on Windows, process.exit() right after fetch() can abort with a libuv assertion (exit 127).
process.exitCode = code;
setTimeout(() => process.exit(code), 3000).unref();
