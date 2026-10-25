#!/usr/bin/env node
// Revizor — seo.mjs: technical SEO measurements per page and per site.
// Facts only (no findings): the seo-tech / seo-content lenses turn them into findings.
// Writes RUN/measure/seo.json, RUN/measure/links.json, RUN/stdout/seo.md.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { lookup } from 'node:dns/promises';
import * as U from './lib/util.mjs';
import { Browser } from './lib/cdp.mjs';

const HELP = `
seo.mjs — техническое SEO: коды и цепочки, title/description (нормы Яндекса и Google), H1 и иерархия,
canonical, robots meta и X-Robots-Tag, hreflang, lang, OG/Twitter, JSON-LD, alt, внутренние ссылки,
по сайту: http→https, www, слэш, index.html, дубли, robots.txt, sitemap, soft-404, иконки, llms.txt.

  node seo.mjs --run "<RUN>" [--pages home,p01] [--as-bot [--bots-only]] [--links-max 300] [--no-links]
               [--sitemap-sample 30] [--stage live|beta|prototype] [--url <адрес, если нет pages.json>]
               [--budget-sec 480] [--lang ru|en]

  --as-bot          по 1 запросу к главной с UA роботов: YandexBot, YandexMobileBot, Googlebot (компьютер и смартфон),
                    TelegramBot, facebookexternalhit, vkShare, WhatsApp (8 запросов + 1 обычный); сравнение
                    нормализованное (title, H1, canonical, robots, ссылки по Жаккару ≥ 0,9, длина текста ±10 %, спам-слова).
                    Защита сайта может забанить IP за «поддельного робота» — запускать последним, после perf.
  --bots-only       только сравнение с роботами (включает --as-bot): берёт готовый measure/seo.json, дописывает
                    site.bots, подсказки и ручные проверки, страницы и ссылки не трогает. Без seo.json — код 2.
                    Сводка — stdout/seo-bots.md, строка «Боты» обновляется и в stdout/seo.md.
  --links-max N     сколько адресов проверять в measure/links.json (по умолчанию 300, из них до 20 — повторный
                    GET внутренних страниц для поиска «не найдено» с кодом 200)
  --no-links        не проверять ссылки
  --sitemap-sample  сколько адресов из sitemap проверить по коду ответа (по умолчанию 30)
  --stage           стадия сайта, пишется в seo.json для линзы (на бете noindex и Disallow ожидаемы)
  --url             без pages.json: страница открывается нашим браузером с выполнением скриптов сайта
                    (ещё одна загрузка), остальное — запросами без JS.
Внешние сервисы не используются: все запросы идут только к проверяемому сайту и адресам из его ссылок.
Вежливость: ≤ 2 запроса к хосту одновременно, пауза 350+ мс; ответ 429 — минута паузы всему хосту,
второй 429 от хоста — его ссылки дальше не проверяем.
Читает: pages.json, snapshot/<pid>/dom.html и text.md (если есть), brief.json.
Пишет: measure/seo.json, measure/links.json, stdout/seo.md. seo.json сохраняется после каждого шага.
Код 75 — частичный результат, повторите тот же вызов. Вызов с --pages перезаписывает measure/seo.json целиком.
`;

const args = U.parseArgs(process.argv.slice(2), { boolean: ['as-bot', 'bots-only', 'links', 'help'] });
U.helpAndExit(HELP, args);
const lang = U.langOf(args);
const L = (ru, en) => (lang === 'en' ? en : ru);
// an unknown flag is an error: a flag this version lacks must not silently re-run everything and overwrite seo.json
{
  const KNOWN_FLAGS = new Set(['_', 'run', 'lang', 'help', 'budget-sec', 'pages', 'url', 'stage', 'mode', 'audience',
    'as-bot', 'bots-only', 'links', 'links-max', 'sitemap-sample']);
  const bad = Object.keys(args).filter(k => !KNOWN_FLAGS.has(k));
  if (bad.length) { console.error(L(`seo.mjs: неизвестные флаги: ${bad.map(k => '--' + k).join(', ')} (см. --help)`, `seo.mjs: unknown flags: ${bad.map(k => '--' + k).join(', ')} (see --help)`)); process.exit(2); }
}
const BOTS_ONLY = !!args['bots-only'];
if (BOTS_ONLY) args['as-bot'] = true;
const RUN = U.requireRun(args);
const budgetSec = Math.max(20, Number(args['budget-sec'] ?? 480) || 480);
const T0 = Date.now();
const deadline = T0 + budgetSec * 1000 - Math.min(20000, budgetSec * 100);
const timeLeft = () => deadline - Date.now();
const LINKS_MAX = Math.max(0, Number(args['links-max'] ?? 300) || 0);
const DO_LINKS = args.links !== false && LINKS_MAX > 0;
const SITEMAP_SAMPLE = Math.max(0, Number(args['sitemap-sample'] ?? 30) || 0);
const OUT = U.runPath(RUN, 'measure', 'seo.json');
const OUT_LINKS = U.runPath(RUN, 'measure', 'links.json');

// ---------- norms (both engines, always) ----------
const NORMS = {
  title: { yandex: [30, 70], google: [50, 60] },
  description: { yandex: [120, 170], yandex_max: 250, google: [150, 160] },
};
// robots.txt tokens of AI crawlers, each from the operator's own documentation, checked 24.10.2026.
// purpose: training | search | user (fetch on a person's request) | control (no crawling, only a robots.txt switch).
// robots: yes — obeys robots.txt; no — the operator says user fetches may ignore it; own_group — ignores «User-agent: *».
// Not listed: tokens without an official page (anthropic-ai is gone from Anthropic's page; Bytespider has none).
const AI_BOTS_CHECKED = '2026-10-24';
const AI_BOTS = [
  { bot: 'GPTBot', op: 'OpenAI', purpose: 'training', robots: 'yes', src: 'developers.openai.com/api/docs/bots' },
  { bot: 'OAI-SearchBot', op: 'OpenAI', purpose: 'search', robots: 'yes', src: 'developers.openai.com/api/docs/bots' },
  { bot: 'ChatGPT-User', op: 'OpenAI', purpose: 'user', robots: 'no', src: 'developers.openai.com/api/docs/bots' },
  { bot: 'ClaudeBot', op: 'Anthropic', purpose: 'training', robots: 'yes', src: 'support.claude.com/en/articles/8896518' },
  { bot: 'Claude-SearchBot', op: 'Anthropic', purpose: 'search', robots: 'yes', src: 'support.claude.com/en/articles/8896518' },
  { bot: 'Claude-User', op: 'Anthropic', purpose: 'user', robots: 'yes', src: 'support.claude.com/en/articles/8896518' },
  { bot: 'PerplexityBot', op: 'Perplexity', purpose: 'search', robots: 'yes', src: 'docs.perplexity.ai/guides/bots' },
  { bot: 'Perplexity-User', op: 'Perplexity', purpose: 'user', robots: 'no', src: 'docs.perplexity.ai/guides/bots' },
  { bot: 'Google-Extended', op: 'Google', purpose: 'control', robots: 'yes', src: 'developers.google.com/search/docs/crawling-indexing/google-common-crawlers' },
  { bot: 'Google-CloudVertexBot', op: 'Google', purpose: 'training', robots: 'yes', src: 'developers.google.com/search/docs/crawling-indexing/google-common-crawlers' },
  { bot: 'Applebot-Extended', op: 'Apple', purpose: 'control', robots: 'yes', src: 'support.apple.com/en-us/119829' },
  { bot: 'CCBot', op: 'Common Crawl', purpose: 'training', robots: 'yes', src: 'commoncrawl.org/ccbot' },
  { bot: 'meta-externalagent', op: 'Meta', purpose: 'training', robots: 'yes', src: 'developers.facebook.com/docs/sharing/webmasters/web-crawlers' },
  { bot: 'meta-webindexer', op: 'Meta', purpose: 'search', robots: 'yes', src: 'developers.facebook.com/docs/sharing/webmasters/web-crawlers' },
  { bot: 'Amazonbot', op: 'Amazon', purpose: 'training', robots: 'yes', src: 'developer.amazon.com/amazonbot' },
  { bot: 'DuckAssistBot', op: 'DuckDuckGo', purpose: 'search', robots: 'yes', src: 'duckduckgo.com/duckduckgo-help-pages/results/duckassistbot' },
  // Yandex: answers with YandexGPT and «Поиск с Алисой»; a control token that ignores «User-agent: *» — only its own group counts
  { bot: 'YandexAdditional', op: 'Яндекс', purpose: 'control', robots: 'own_group', src: 'yandex.ru/support/webmaster/ru/robot-workings/check-yandex-robots' },
  { bot: 'YandexAdditionalBot', op: 'Яндекс', purpose: 'control', robots: 'own_group', src: 'yandex.ru/support/webmaster/ru/robot-workings/check-yandex-robots' },
];
// --as-bot user agents (official strings; checked 24.10.2026). TelegramBot, vkShare (VK link previews) and WhatsApp
// (link previews) have no official page with the string — these are the ones public bot directories record.
const BOTS_AS = [
  ['YandexBot', 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)'],
  ['YandexMobileBot', 'Mozilla/5.0 (iPhone; CPU iPhone OS 8_1 like Mac OS X) AppleWebKit/600.1.4 (KHTML, like Gecko) Version/8.0 Mobile/12B411 Safari/600.1.4 (compatible; YandexMobileBot/3.0; +http://yandex.com/bots)'],
  ['Googlebot', 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/130.0.0.0 Safari/537.36'],
  ['Googlebot Smartphone', 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'],
  ['TelegramBot', 'TelegramBot (like TwitterBot)'],
  ['facebookexternalhit', 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)'],
  ['vkShare', 'Mozilla/5.0 (compatible; vkShare; +http://vk.com/dev/Share)'],
  ['WhatsApp', 'WhatsApp/2.23.20.0 A'],
];
const GENERIC_ANCHORS = new Set(['подробнее', 'подробно', 'читать далее', 'читать полностью', 'читать', 'далее', 'узнать больше',
  'узнать подробнее', 'подробнее о', 'смотреть', 'смотреть все', 'здесь', 'тут', 'ссылка', 'перейти', 'ещё', 'еще', 'больше',
  'read more', 'learn more', 'more', 'click here', 'here', 'details', 'see more', 'view more', 'continue reading', '→', '>']);
const SPAM_WORDS = [
  ['казино', false], ['casino', false], ['игровые автоматы', false], ['слоты', false], ['ставки на спорт', false],
  ['букмекер', false], ['1xbet', false], ['вавада', false], ['vavada', false], ['viagra', false], ['виагра', false],
  ['cialis', false], ['порно', false], ['porn', false], ['эскорт', false], ['escort', false], ['проститутк', false],
  ['займ', true], ['микрозайм', true], ['кредит без отказа', true],
];
const LOCAL_BUSINESS = new Set(['LocalBusiness', 'Restaurant', 'CafeOrCoffeeShop', 'BarOrPub', 'Bakery', 'FastFoodRestaurant', 'FoodEstablishment',
  'Store', 'ClothingStore', 'ElectronicsStore', 'FlowerShop', 'FurnitureStore', 'GroceryStore', 'HardwareStore', 'JewelryStore', 'BookStore',
  'PetStore', 'SportingGoodsStore', 'ToyStore', 'AutoPartsStore', 'MedicalBusiness', 'MedicalClinic', 'Dentist', 'Physician', 'Pharmacy',
  'Optician', 'BeautySalon', 'HairSalon', 'NailSalon', 'DaySpa', 'HealthAndBeautyBusiness', 'HealthClub', 'SportsActivityLocation',
  'ExerciseGym', 'ProfessionalService', 'LegalService', 'Attorney', 'Notary', 'AccountingService', 'FinancialService', 'BankOrCreditUnion',
  'InsuranceAgency', 'RealEstateAgent', 'TravelAgency', 'AutoRepair', 'AutoDealer', 'AutomotiveBusiness', 'HomeAndConstructionBusiness',
  'Electrician', 'Plumber', 'Locksmith', 'MovingCompany', 'GeneralContractor', 'EducationalOrganization', 'School', 'Preschool',
  'ChildCare', 'LodgingBusiness', 'Hotel', 'Hostel', 'EntertainmentBusiness', 'MusicVenue', 'NightClub', 'DryCleaningOrLaundry',
  'EmploymentAgency', 'Library', 'TouristInformationCenter', 'AnimalShelter', 'VeterinaryCare', 'MusicSchool', 'DanceSchool']);
const BAD_LANG_CODES = { ua: 'uk', jp: 'ja', cn: 'zh', kz: 'kk', by: 'be', gr: 'el', se: 'sv', dk: 'da', cz: 'cs', ee: 'et', si: 'sl', rs: 'sr', 'en-uk': 'en-GB' };

// ---------- small helpers ----------
const clean = s => String(s ?? '').replace(/[­​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
const len = s => [...clean(s)].length;
const normKey = s => U.normText(clean(s)).replace(/[.,!?;:()«»"'…–—-]/g, ' ').replace(/\s+/g, ' ').trim();
const digits = s => String(s ?? '').replace(/\D+/g, '');
const uniq = a => [...new Set(a)];
function normRange(n, [lo, hi]) { return n === 0 ? 'missing' : n < lo ? 'short' : n > hi ? 'long' : 'ok'; }
function keyOf(u) { // comparison key: host without www, path without trailing slash, query without tracking params
  try {
    const x = new URL(u);
    for (const k of [...x.searchParams.keys()]) if (/^(utm_|yclid$|gclid$|fbclid$|_openstat$|ysclid$)/i.test(k)) x.searchParams.delete(k);
    let p = x.pathname.replace(/\/+$/, '') || '/';
    try { p = decodeURI(p); } catch {}
    return U.stripWww(x.hostname.toLowerCase()) + (x.port ? ':' + x.port : '') + p + (x.search || '');
  } catch { return null; }
}
const stripHash = u => { try { const x = new URL(u); x.hash = ''; return x.toString(); } catch { return null; } };
const rnd6 = () => [...randomBytes(6)].map(b => String.fromCharCode(97 + (b % 26))).join('');
function jaccard(a, b) { const A = new Set(a), B = new Set(b); if (!A.size && !B.size) return 1; let i = 0; for (const x of A) if (B.has(x)) i++; return i / (A.size + B.size - i); }
function readText(p) { try { return readFileSync(p, 'utf8'); } catch { return null; } }
function hostIsLocal(h) { return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::1]' || h === '::1' || U.isPrivateIp(h); }
function imageDims(b) {
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), type: 'png' };
  if (b.toString('ascii', 0, 3) === 'GIF') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8), type: 'gif' };
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP' && b.length >= 30) {
    const c = b.toString('ascii', 12, 16);
    if (c === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3), type: 'webp' };
    if (c === 'VP8 ') return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff, type: 'webp' };
    if (c === 'VP8L') { const v = b.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1, type: 'webp' }; }
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xd8 || m === 0x01 || m === 0xff || (m >= 0xd0 && m <= 0xd7)) { i += (m === 0xff ? 1 : 2); continue; }
      const l = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7), type: 'jpeg' };
      i += 2 + l;
    }
    return { type: 'jpeg' };
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) { // ICO: the largest of its images (0 in the entry = 256)
    const count = b.readUInt16LE(4); let w = 0, h = 0; const all = [];
    for (let k = 0; k < count && 6 + 16 * k + 1 < b.length && k < 20; k++) { const ew = b[6 + 16 * k] || 256, eh = b[7 + 16 * k] || 256; all.push(`${ew}x${eh}`); if (ew * eh > w * h) { w = ew; h = eh; } }
    return { w: w || 256, h: h || 256, type: 'ico', count, sizes: all };
  }
  if (/<svg[\s>]/i.test(b.toString('utf8', 0, Math.min(b.length, 4096)))) return { type: 'svg' };
  return null;
}
const looksHtml = s => /^\s*(<!doctype html|<html|<head|<body)/i.test(String(s || '').slice(0, 500));

// text.md (collectors/text) → only what a visitor sees: no metadata header, no «[скрыто]»/«[невидимо]» lines,
// no screen-reader-only / hidden / tooltip / placeholder sections. «[свёрнуто]» (collapsed, opens without JS) stays.
function visibleFromTextMd(md) {
  if (!md) return null;
  const SKIP = /скрыт|скринридер|невидим|подсказк|placeholder|hidden|screen reader|invisible|tooltip/i;
  const out = []; let section = null;
  for (const raw of String(md).split(/\r?\n/)) {
    const sec = raw.match(/^\*\*\[(.+)\]\*\*\s*$/);
    if (sec) { section = sec[1]; continue; }
    if (section === null || SKIP.test(section)) continue; // header block (Title, Description…) or a hidden section
    let s = raw.trim();
    if (!s || s.startsWith('<!--')) continue;
    if (/^\[(скрыто|невидимо)\]/i.test(s)) continue;
    s = s.replace(/^\[(свёрнуто|декор)\]\s*/i, '').replace(/^[#>*\-|\s]+/, '').replace(/^\\/, '');
    if (s) out.push(s);
  }
  return out.join('\n');
}

// State-changing GET links on top of util.isRiskyGet: /order/5/cancel, /unsub/x, /promo/apply, /auth/callback, /oauth/authorize, /?logout
const EXTRA_RISKY_PATH = /(^|[\/_.-])(cancel|unsub|apply|callback|oauth|authorize|resend)([\/_.?-]|$)/i;
const EXTRA_RISKY_QUERY = /(^|[?&])(logout|log-out|signout|sign-out|exit)(&|=|$)/i;
function EXTRA_RISKY(u) { try { const x = new URL(u); return EXTRA_RISKY_PATH.test(x.pathname) || EXTRA_RISKY_QUERY.test(x.search); } catch { return false; } }

// Values of query parameters that look like secrets (tokens, e-mails, codes) never reach RUN files.
const SECRET_PARAM = /token|key|sig|secret|sess|sid|auth|code|hash|mail|phone|tel|pass|otp|ticket|uid|login|user/i;
// a path segment that looks like a token: 16+ chars, hex, or letters mixed with digits (/unsubscribe/<token>, /reset/<id>)
const tokenSeg = g => g.length >= 16 && (/^[0-9a-f-]+$/i.test(g) || (/[a-z]/i.test(g) && /\d/.test(g)));
function maskUrl(u, all = false) {
  try {
    const x = new URL(u);
    const path = all ? x.pathname.split('/').map(g => (tokenSeg(g) ? '…' : g)).join('/') : x.pathname;
    if (!x.search) return all ? x.origin + path : u;
    const parts = x.search.slice(1).split('&').map(p => { const i = p.indexOf('='); const k = i < 0 ? p : p.slice(0, i); return (all || SECRET_PARAM.test(decodeURIComponent(k))) && i >= 0 ? `${k}=…` : p; });
    return `${x.origin}${path}?${parts.join('&')}`;
  } catch { return String(u).replace(/\?.*$/, '?…'); }
}

// Internal links with a query string: pagination, sorting, filters — duplicates that need Clean-param/canonical.
const PARAM_KIND = [['pagination', /^(page|paged|p|pg|pagen_\d+|start|offset)$/i], ['sort', /^(sort|sort_by|sortby|order|orderby|order_by|dir|direction)$/i],
  ['filter', /^(filter|filters|set_filter|arrfilter.*|f|q|search|s|min_price|max_price|price_from|price_to)$|^filter[.[_]/i]];
function paramLinks(links, final) {
  const res = { total: 0, pagination: 0, sort: 0, filter: 0, other: 0, samples: [] };
  for (const u of uniq(links.map(l => l.url).filter(Boolean))) {
    let x; try { x = new URL(u); } catch { continue; }
    const keys = [...x.searchParams.keys()].filter(k => !/^(utm_|yclid$|gclid$|fbclid$|_openstat$|ysclid$|from$)/i.test(k));
    if (!keys.length || !U.sameSite(u, final)) continue;
    res.total++;
    const kinds = new Set(keys.map(k => (PARAM_KIND.find(([, re]) => re.test(k)) || ['other'])[0]));
    for (const k of kinds) res[k]++;
    if (res.samples.length < 5) res.samples.push(maskUrl(u));
  }
  return res;
}

// hreflang from three sources: <link> in HTML, the Link header, <xhtml:link> in sitemap
function hreflangEntry(lang, href, source) {
  const code = String(lang || '').trim();
  const lc = code.toLowerCase();
  const valid = lc === 'x-default' || /^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?$/i.test(code);
  return { lang: code, href, valid, suggest: BAD_LANG_CODES[lc] || BAD_LANG_CODES[lc.split('-')[0]] || null, ...(source ? { source } : {}) };
}
function linkHeaderAlternates(value, base) {
  const out = [];
  for (const part of String(Array.isArray(value) ? value.join(', ') : value || '').split(/,\s*(?=<)/)) {
    const m = part.match(/^\s*<([^>]+)>(.*)$/); if (!m) continue;
    const rel = (m[2].match(/rel\s*=\s*"?([^";]+)"?/i) || [])[1] || '';
    const hl = (m[2].match(/hreflang\s*=\s*"?([^";,\s]+)"?/i) || [])[1];
    if (!/\balternate\b/i.test(rel) || !hl) continue;
    let href; try { href = new URL(m[1].trim(), base).href; } catch { continue; }
    out.push(hreflangEntry(hl, href, 'header'));
  }
  return out.slice(0, 50);
}
// <url><loc>…</loc><xhtml:link rel="alternate" hreflang="en" href="…"/></url> → Map(keyOf(loc) → entries)
function sitemapAlternates(xml) {
  const map = new Map(); let urlsWith = 0;
  for (const m of String(xml || '').matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
    const loc = (m[1].match(/<loc>\s*([\s\S]*?)\s*<\/loc>/i) || [])[1];
    if (!loc) continue;
    const alts = [];
    for (const l of m[1].matchAll(/<(?:[\w-]+:)?link\b([^>]*)\/?>/gi)) {
      const a = l[1];
      const rel = (a.match(/rel\s*=\s*["']([^"']+)["']/i) || [])[1] || '';
      const hl = (a.match(/hreflang\s*=\s*["']([^"']+)["']/i) || [])[1];
      const href = (a.match(/href\s*=\s*["']([^"']+)["']/i) || [])[1];
      if (/alternate/i.test(rel) && hl && href) alts.push(hreflangEntry(hl, U.decodeXml(href.trim()), 'sitemap'));
    }
    if (alts.length) { urlsWith++; map.set(keyOf(U.decodeXml(loc.trim())), alts.slice(0, 50)); }
  }
  return { map, urlsWith };
}

// robots meta / X-Robots-Tag by search engine. X-Robots-Tag may carry «googlebot: noindex» or several headers joined
// with «, »; directives after a «<bot>:» prefix belong to that bot until the next prefix.
const XRT_PARAM = /^(max-snippet|max-image-preview|max-video-preview|unavailable_after)$/i;
function robotsByEngine(metaRobots, metaGoogle, metaYandex, xrt) {
  const acc = { all: [], google: [], yandex: [], other: [] };
  const engineOf = name => /^googlebot/i.test(name) ? 'google' : /^yandex/i.test(name) ? 'yandex' : 'other';
  let cur = 'all';
  for (const tok of String(xrt || '').split(',').map(s => s.trim()).filter(Boolean)) {
    const m = tok.match(/^([a-z0-9_-]+)\s*:\s*(.*)$/i);
    if (m && !XRT_PARAM.test(m[1])) { cur = engineOf(m[1]); if (m[2]) acc[cur].push(m[2].toLowerCase()); }
    else acc[cur].push(tok.toLowerCase());
  }
  for (const v of metaRobots) acc.all.push(...String(v).toLowerCase().split(',').map(s => s.trim()));
  for (const v of metaGoogle) acc.google.push(...String(v).toLowerCase().split(',').map(s => s.trim()));
  for (const v of metaYandex) acc.yandex.push(...String(v).toLowerCase().split(',').map(s => s.trim()));
  const has = (list, d) => list.some(x => x === d || x === 'none');
  const noindex = { all: has(acc.all, 'noindex'), google: has(acc.all, 'noindex') || has(acc.google, 'noindex'), yandex: has(acc.all, 'noindex') || has(acc.yandex, 'noindex') };
  const nofollow = { all: has(acc.all, 'nofollow'), google: has(acc.all, 'nofollow') || has(acc.google, 'nofollow'), yandex: has(acc.all, 'nofollow') || has(acc.yandex, 'nofollow') };
  return { noindex, nofollow, other_bots: acc.other.length ? acc.other.slice(0, 5) : null };
}

// ---------- in-browser extraction (DOMParser in a tab with scripts disabled) ----------
function EXTRACT(html, pageUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let base = pageUrl;
  const baseEl = doc.querySelector('base[href]');
  if (baseEl) { try { base = new URL(baseEl.getAttribute('href'), pageUrl).href; } catch (e) { /* keep page url */ } }
  const abs = h => { if (h == null) return null; const s = String(h).trim(); if (!s) return null; try { return new URL(s, base).href; } catch (e) { return null; } };
  const clean = s => String(s == null ? '' : s).replace(/[­​-‍⁠﻿]/g, '').replace(/\s+/g, ' ').trim();
  const lower = s => String(s == null ? '' : s).toLowerCase().trim();
  const textOf = root => {
    if (!root) return '';
    const w = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = []; let n, total = 0;
    while ((n = w.nextNode()) && total < 400000) {
      const p = n.parentElement;
      if (p && p.closest('script,style,noscript,template,svg')) continue;
      const s = n.nodeValue; if (s && s.trim()) { parts.push(s); total += s.length; }
    }
    return clean(parts.join(' '));
  };
  const txt = el => clean(el ? el.textContent : '');
  const metas = [...doc.querySelectorAll('meta')];
  const metaName = n => metas.filter(m => lower(m.getAttribute('name')) === n).map(m => m.getAttribute('content') == null ? '' : m.getAttribute('content'));
  const hiddenHint = el => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.hasAttribute('hidden') || e.getAttribute('aria-hidden') === 'true') return 'hidden-attr';
      const st = lower(e.getAttribute('style')).replace(/\s+/g, '');
      if (/display:none|visibility:hidden/.test(st)) return 'inline-style';
      const cls = ' ' + lower(e.getAttribute('class')) + ' ';
      if (/ (sr-only|visually-hidden|screen-reader-text|visuallyhidden) /.test(cls)) return 'sr-only';
      if (e.tagName === 'NOSCRIPT') return 'noscript';
    }
    return null;
  };
  const region = el => {
    if (el.closest('main,[role="main"]')) return 'main';
    if (el.closest('footer,[role="contentinfo"],#t-footer,#footer,.footer,.site-footer')) return 'footer';
    if (el.closest('header,[role="banner"],#t-header,#header,.header,.site-header')) return 'header';
    if (el.closest('nav,[role="navigation"]')) return 'nav';
    return 'body';
  };
  const titles = [...doc.querySelectorAll('title')].filter(t => !t.closest('svg'));
  const linkEls = [...doc.querySelectorAll('link[rel]')].map(l => ({
    rel: lower(l.getAttribute('rel')).split(/\s+/).filter(Boolean), href: l.getAttribute('href'), abs: abs(l.getAttribute('href')),
    hreflang: l.getAttribute('hreflang'), sizes: l.getAttribute('sizes'), type: l.getAttribute('type'), in_head: !!l.closest('head') }));
  const og = {}, tw = {};
  for (const m of metas) {
    const k = lower(m.getAttribute('property') || m.getAttribute('name'));
    const v = m.getAttribute('content');
    if (k.startsWith('og:') || k.startsWith('article:') || k.startsWith('product:')) (og[k] = og[k] || []).push(v == null ? '' : v);
    else if (k.startsWith('twitter:')) (tw[k] = tw[k] || []).push(v == null ? '' : v);
  }
  const headings = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].slice(0, 400).map(h => ({
    level: +h.tagName[1], text: txt(h).slice(0, 160), hidden: hiddenHint(h), region: region(h),
    img_only: !txt(h) && !!h.querySelector('img,svg'), img_alt: clean((h.querySelector('img[alt]') || { getAttribute: () => '' }).getAttribute('alt')).slice(0, 80),
    in_link: !!h.closest('a'), home_link: (() => { const a = h.closest('a') || h.querySelector('a'); if (!a) return false; const u = abs(a.getAttribute('href')); try { return !!u && new URL(u).pathname.replace(/\/+$/, '') === ''; } catch (e) { return false; } })() }));
  const links = [...doc.querySelectorAll('a[href], area[href]')].slice(0, 3000).map(a => {
    const href = a.getAttribute('href') || '';
    const t = txt(a) || clean(a.getAttribute('aria-label')) || clean((a.querySelector('img[alt]') || { getAttribute: () => '' }).getAttribute('alt')) || clean(a.getAttribute('title'));
    return { href: href.slice(0, 600), url: abs(href), text: t.slice(0, 100), rel: lower(a.getAttribute('rel')), target: lower(a.getAttribute('target')), region: region(a), hidden: hiddenHint(a) ? 1 : 0 };
  });
  const images = [...doc.querySelectorAll('img')].slice(0, 800).map(i => ({
    src: abs(i.getAttribute('src') || i.getAttribute('data-src') || i.getAttribute('data-original') || i.getAttribute('data-lazy-src') || ''),
    alt: i.hasAttribute('alt') ? clean(i.getAttribute('alt')).slice(0, 150) : null, region: region(i), in_link: !!i.closest('a'),
    role: lower(i.getAttribute('role')), aria_hidden: i.getAttribute('aria-hidden') === 'true' }));
  const ids = new Set([...doc.querySelectorAll('[id]')].map(e => e.id));
  for (const a of doc.querySelectorAll('a[name]')) ids.add(a.getAttribute('name'));
  const dec = s => { try { return decodeURIComponent(s); } catch (e) { return s; } };
  const broken_anchors = [...new Set(links.filter(l => /^#[^/!]/.test(l.href) && l.href.length > 1 && l.href.toLowerCase() !== '#top' && !ids.has(dec(l.href.slice(1)))).map(l => l.href))].slice(0, 30);
  const mainEl = doc.querySelector('main,[role="main"]');
  const text = textOf(doc.body);
  const items = [...doc.querySelectorAll('[itemscope]')];
  const tels = [...doc.querySelectorAll('a[href^="tel:" i]')].map(a => a.getAttribute('href')).slice(0, 20);
  // site builders that also serve every page at /page<ID>.html mark the page with data-<builder>-page-id
  const pageIds = [];
  const els = doc.querySelectorAll('html,body,body *');
  for (let k = 0; k < els.length && k < 600 && pageIds.length < 3; k++) {
    for (const at of els[k].attributes) if (/^data-[a-z0-9]+-page-id$/i.test(at.name) && /^\d{3,12}$/.test(at.value) && !pageIds.some(p => p.id === at.value)) pageIds.push({ attr: at.name, id: at.value });
  }
  return {
    lang: doc.documentElement.getAttribute('lang'), xml_lang: doc.documentElement.getAttribute('xml:lang'),
    title_count: titles.length, title_in_head: titles.filter(t => t.closest('head')).length, title: clean(titles[0] ? titles[0].textContent : ''),
    descriptions: metaName('description'), robots: metaName('robots'), googlebot: metaName('googlebot'), yandex: metaName('yandex'),
    keywords: metaName('keywords').length > 0, viewport: metaName('viewport')[0] == null ? null : metaName('viewport')[0], generator: metaName('generator'),
    verification: { yandex: metaName('yandex-verification').length, google: metaName('google-site-verification').length, bing: metaName('msvalidate.01').length },
    theme_color: metaName('theme-color')[0] == null ? null : metaName('theme-color')[0],
    refresh: metas.filter(m => lower(m.getAttribute('http-equiv')) === 'refresh').map(m => m.getAttribute('content')),
    canonical: linkEls.filter(l => l.rel.includes('canonical')).map(l => ({ href: l.href, abs: l.abs, in_head: l.in_head })),
    hreflang: linkEls.filter(l => l.rel.includes('alternate') && l.hreflang).map(l => ({ lang: l.hreflang, href: l.abs })),
    icons: linkEls.filter(l => l.rel.some(r => /icon/.test(r)) || l.rel.includes('manifest')).map(l => ({ rel: l.rel.join(' '), href: l.abs, sizes: l.sizes, type: l.type })),
    og, twitter: tw, headings, links, images,
    jsonld: [...doc.querySelectorAll('script')].filter(s => lower(s.getAttribute('type')) === 'application/ld+json').map(s => (s.textContent || '').slice(0, 300000)),
    microdata: { count: items.length, types: [...new Set(items.map(e => e.getAttribute('itemtype')).filter(Boolean))].slice(0, 20) },
    text, text_len: text.length, main_text_len: mainEl ? textOf(mainEl).length : null, has_main: !!mainEl,
    scripts: [...doc.querySelectorAll('script[src]')].map(s => abs(s.getAttribute('src'))).filter(Boolean).slice(0, 150),
    styles: linkEls.filter(l => l.rel.includes('stylesheet')).map(l => l.abs).filter(Boolean).slice(0, 150),
    broken_anchors, tels, page_ids: pageIds,
  };
}

class Tab {
  constructor() { this.browser = null; this.page = null; this.render = null; this.release = null; }
  async open() {
    if (this.page) return;
    // seo, headers and domain run in parallel and share 2 machine-wide browser slots: wait only within our budget
    try { this.release = await U.acquireBrowserSlot({ waitMs: Math.max(3000, timeLeft() - 15000) }); }
    catch (e) { throw Object.assign(new Error(e.message), { code: 'NO_SLOT' }); }
    for (let k = 0; ; k++) { // Windows may briefly lock DevToolsActivePort right after start
      try { this.browser = await Browser.launch(); break; }
      catch (e) { if (k >= 2) { this.release(); this.release = null; throw Object.assign(new Error(e.message), { code: 'LAUNCH' }); } await U.sleep(1500); }
    }
    this.page = await this.browser.newPage();
    await this.page.send('Emulation.setScriptExecutionDisabled', { value: true });
  }
  async parse(html, url) { await this.open(); return this.page.evaluate(EXTRACT, String(html || ''), url); }
  async renderHtml(url) { // fallback when snapshot/<pid>/dom.html is missing (standalone runs)
    await this.open();
    if (!this.render) { this.render = await this.browser.newPage(); await this.render.setViewport({ width: 1440, height: 900 }); }
    const r = await this.render.goto(url, { timeout: 30000, idleMs: 800 });
    if (!r.ok) return { error: r.error || r.refused || 'render failed' };
    await U.sleep(500);
    const html = await this.render.evaluate('"<!DOCTYPE html>" + document.documentElement.outerHTML');
    return { html };
  }
  async close() {
    const profile = this.browser?.profile;
    try { if (this.browser) await this.browser.close(); } catch {}
    for (let k = 0; profile && existsSync(profile) && k < 10; k++) { try { rmSync(profile, { recursive: true, force: true }); } catch {} await U.sleep(300); }
    try { this.release?.(); } catch {}
    this.browser = null; this.page = null; this.render = null;
  }
}
const tab = new Tab();

// ---------- inputs ----------
let pagesJson = U.readJSON(join(RUN, 'pages.json'), null);
const brief = U.readJSON(join(RUN, 'brief.json'), null) || U.readJSON(join(RUN, 'brief.input.json'), {}) || {};
let selected;
if (pagesJson) selected = U.loadPages(RUN, args);
else if (args.url && args.url !== true) {
  const u = U.normalizeUrl(args.url);
  selected = [{ pid: 'home', url: u, template: 'home' }];
  pagesJson = { site: u, final_origin: new URL(u).origin, selected };
} else { console.error(L('Нет pages.json и не задан --url.', 'No pages.json and no --url given.')); process.exit(2); }
if (!selected.length) { console.error(L('В pages.json нет выбранных страниц.', 'pages.json has no selected pages.')); process.exit(2); }
const home = selected.find(p => p.pid === 'home') || selected[0];
let origin = pagesJson.final_origin || (() => { try { return new URL(home.url).origin; } catch { return null; } })();
const siteHost = U.hostOf(origin);
// the reviewed site itself may be local (demo, dev server, *.test): allow it, nothing else private
const siteIsLocal = hostIsLocal(siteHost) || await U.resolvesPrivate(siteHost);
if (siteIsLocal) U.allowPrivateHost(siteHost);
const market = brief?.market?.value || pagesJson?.market?.value || (/\.(ru|su|xn--p1ai|by|kz)$/.test(siteHost) ? 'ru' : 'intl');
const stage = (args.stage && args.stage !== true ? String(args.stage) : null) || brief?.stage || null;
const cms = String(pagesJson?.stack?.cms || '');

// ---------- resume ----------
const TRANSIENT = /браузер занят|browser slots busy/i; // notes that only explain why the previous call stopped
const prev = U.readJSON(OUT, null);
if (BOTS_ONLY && !prev?.items) {
  console.error(L(`seo.mjs --bots-only: нет ${OUT} — сначала запустите seo.mjs без --bots-only.`, `seo.mjs --bots-only: ${OUT} is missing — run seo.mjs without --bots-only first.`));
  process.exit(2);
}
const resuming = !BOTS_ONLY && !!(prev && prev.partial && prev.resume && Array.isArray(prev.resume.done));
const done = new Set(resuming ? prev.resume.done : []);
// --bots-only keeps the whole previous seo.json (items, links summary, partial/resume) and changes only the bot part
const out = BOTS_ONLY ? {
  ...prev, site: prev.site || {}, items: prev.items || [], flags: prev.flags || [], human_checks: prev.human_checks || [],
  errors: prev.errors || [], not_checked: (prev.not_checked || []).filter(x => !TRANSIENT.test(x)),
} : {
  ...U.measureHeader('seo', RUN), partial: false, resume: null, market, stage, norms: NORMS,
  site: resuming ? (prev.site || {}) : {}, items: resuming ? (prev.items || []) : [], flags: [], human_checks: resuming ? (prev.human_checks || []) : [],
  errors: resuming ? (prev.errors || []) : [], not_checked: resuming ? (prev.not_checked || []).filter(x => !TRANSIENT.test(x)) : [],
};
const BOTS_NOTE = ['сравнение отдачи роботам (запустите с --as-bot)', 'bot comparison (run with --as-bot)'];
const prevLinks = U.readJSON(OUT_LINKS, null);
const linkMap = new Map(); // url → item
if (resuming && prevLinks?.items) for (const it of prevLinks.items) linkMap.set(it.url, it);
if (resuming) U.progress(L(`seo: продолжаю прогон (готово: ${done.size} шагов)`, `seo: resuming (${done.size} steps done)`));

let sitemapAlt = new Map(); // keyOf(loc) → hreflang alternates from the first sitemap file (this call only)
const pageText = new Map(); // pid → page text of this call (kept in memory only: duplicate and soft-404 comparisons)
function addNotChecked(what) { if (!out.not_checked.includes(what)) out.not_checked.push(what); }
function addHuman(what) { if (!out.human_checks.includes(what)) out.human_checks.push(what); }
// A step ran out of time. If other work was done in this call, the step stays undone and the next call repeats it;
// if it was the first step of the call, we keep what it got (so every call makes progress) and note the gap.
let cutNote = null;
function cutShort(note) { cutNote = note; }
function flag(code, level, text, where = [], extra = {}) { out.flags.push({ code, level, text, where: [].concat(where).filter(Boolean), ...extra }); }

// ---------- per page ----------
function snapshotFile(pid, name) { const p = join(RUN, 'snapshot', pid, name); return existsSync(p) ? p : null; }

function analyzeJsonLd(blocks, pageUrl, visible, domData) {
  const res = { blocks: blocks.length, parse_errors: [], types: [], nodes: 0, issues: [], mismatches: [], self_rating: [], notes: [],
    norms_source: 'Google Search Central structured-data, Яндекс Вебмастер (микроразметка) — сверено 24.10.2026' };
  const nodes = [];
  const typeOf = n => [].concat(n?.['@type'] || []).map(t => String(t).replace(/^https?:\/\/schema\.org\//i, ''));
  const walk = (n, depth = 0, parentKey = null) => {
    if (!n || typeof n !== 'object' || depth > 6) return;
    if (Array.isArray(n)) { n.forEach(x => walk(x, depth, parentKey)); return; }
    if (n['@type']) nodes.push({ node: n, types: typeOf(n), top: depth === 0 || parentKey === '@graph' });
    for (const [k, v] of Object.entries(n)) if (v && typeof v === 'object') walk(v, depth + 1, k);
  };
  blocks.forEach((raw, i) => {
    const s = String(raw).replace(/^\s*<!--|-->\s*$/g, '').trim();
    if (!s) { res.parse_errors.push({ block: i + 1, error: L('пустой блок', 'empty block') }); return; }
    try { walk(JSON.parse(s)); }
    catch (e) { res.parse_errors.push({ block: i + 1, error: String(e.message).slice(0, 160), snippet: s.slice(0, 120) }); }
  });
  res.nodes = nodes.length;
  res.types = uniq(nodes.flatMap(n => n.types));
  const vis = normKey(visible);
  const visDigits = String(visible || '').replace(/(\d)[\s  .,](?=\d{3}\b)/g, '$1');
  const telDigits = (domData?.tels || []).map(digits);
  const has = (n, k) => { const v = k.split('.').reduce((o, p) => (o && typeof o === 'object' ? (Array.isArray(o) ? o[0]?.[p] : o[p]) : undefined), n); return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length); };
  // level: required → flag; recommended → data only. engines: whose documentation asks for the field.
  const need = (n, t, fields, level = 'required', engines = ['google']) => {
    for (const f of fields) { const alts = f.split('|'); if (!alts.some(a => has(n, a))) res.issues.push({ type: t, field: f, problem: 'missing', level, engines }); }
  };
  const textHas = s => { const k = normKey(s); return k.length >= 3 && vis.includes(k); };
  const ru = market !== 'intl'; // Yandex rules matter for the Russian and mixed markets
  const ORG = t => t === 'Organization' || t === 'Corporation' || LOCAL_BUSINESS.has(t) || /Organization$/.test(t);
  const isNested = (n) => nodes.some(o => o.node !== n && Object.values(o.node).some(v => v === n || (Array.isArray(v) && v.includes(n))));
  for (const { node: n, types, top } of nodes) {
    for (const t of types) {
      // Google Search Central (structured-data/*, checked 24.10.2026): Organization has no required fields;
      // Yandex Webmaster «Адреса и организации»: name, url, address, telephone are required for its snippets.
      if (t === 'Organization' || t === 'Corporation') { need(n, t, ['name', 'url', 'logo'], 'recommended'); if (ru && top) need(n, t, ['name', 'url', 'address', 'telephone'], 'required', ['yandex']); }
      if (LOCAL_BUSINESS.has(t)) { need(n, t, ['name', 'address'], 'required', ru && top ? ['google', 'yandex'] : ['google']); need(n, t, ['telephone', 'openingHoursSpecification|openingHours', 'geo'], 'recommended'); if (ru && top) need(n, t, ['url', 'telephone'], 'required', ['yandex']); }
      if (t === 'Product') {
        need(n, t, ['name']);
        if (!['offers', 'review', 'aggregateRating'].some(k => has(n, k))) res.issues.push({ type: t, field: 'offers|review|aggregateRating', problem: 'missing', level: 'required', engines: ['google'] });
        need(n, t, ['image'], 'recommended'); // required for Google merchant listings (pages that sell)
        if (ru && top) need(n, t, ['description', 'brand', 'image', 'offers'], 'required', ['yandex']);
      }
      if (t === 'Offer') { need(n, t, ['price|priceSpecification.price']); need(n, t, ['priceCurrency|priceSpecification.priceCurrency', 'availability'], 'recommended'); if (ru) need(n, t, ['priceCurrency', 'availability'], 'required', ['yandex']); }
      if (t === 'AggregateOffer') { need(n, t, ['lowPrice', 'priceCurrency']); if (ru) need(n, t, ['availability'], 'required', ['yandex']); }
      if (t === 'AggregateRating') { need(n, t, ['ratingValue', 'reviewCount|ratingCount']); if (top && !isNested(n)) need(n, t, ['itemReviewed']); }
      if (t === 'Review') { need(n, t, ['author', 'reviewRating']); if (top && !isNested(n)) need(n, t, ['itemReviewed']); }
      if (t === 'BreadcrumbList') {
        const items = [].concat(n.itemListElement || []);
        if (!items.length) res.issues.push({ type: t, field: 'itemListElement', problem: 'missing', level: 'required', engines: ['google'] });
        items.forEach((it, i) => {
          if (!has(it, 'position')) res.issues.push({ type: t, field: `itemListElement[${i}].position`, problem: 'missing', level: 'required', engines: ['google'] });
          if (!has(it, 'name') && !(it.item && it.item.name)) res.issues.push({ type: t, field: `itemListElement[${i}].name`, problem: 'missing', level: 'required', engines: ['google'] });
          if (i < items.length - 1 && !has(it, 'item')) res.issues.push({ type: t, field: `itemListElement[${i}].item`, problem: 'missing', level: 'required', engines: ['google'] }); // not needed for the last one
        });
        const last = items[items.length - 1];
        const lastUrl = last ? (typeof last.item === 'string' ? last.item : last.item?.['@id'] || last.item?.url) : null;
        if (lastUrl && keyOf(new URL(lastUrl, pageUrl).href) !== keyOf(pageUrl)) res.mismatches.push({ type: t, field: 'last item', value: String(lastUrl).slice(0, 200), problem: 'not_this_page' });
      }
      if (t === 'FAQPage') {
        // Google stopped showing FAQ rich results (Search Central updates: from 07.05.2026); the markup is still read
        // by other engines and assistants, so structure and visibility are still checked, as recommendations
        if (!res.notes.includes('faq_google_retired')) res.notes.push('faq_google_retired');
        const qs = [].concat(n.mainEntity || []);
        if (!qs.length) res.issues.push({ type: t, field: 'mainEntity', problem: 'missing', level: 'recommended', engines: [] });
        let missingQ = 0, missingA = 0; const samples = [];
        for (const q of qs) {
          const name = q?.name; const ans = q?.acceptedAnswer?.text || (Array.isArray(q?.acceptedAnswer) ? q.acceptedAnswer[0]?.text : null);
          if (!name || !ans) { res.issues.push({ type: 'Question', field: !name ? 'name' : 'acceptedAnswer.text', problem: 'missing', level: 'recommended', engines: [] }); continue; }
          if (!textHas(name)) { missingQ++; if (samples.length < 3) samples.push(clean(name).slice(0, 100)); }
          const ansStart = clean(String(ans).replace(/<[^>]+>/g, ' ')).split(' ').slice(0, 8).join(' ');
          if (!textHas(ansStart)) missingA++;
        }
        if (missingQ || missingA) res.mismatches.push({ type: t, field: 'mainEntity', problem: 'not_visible', questions_total: qs.length, questions_not_found: missingQ, answers_not_found: missingA, samples });
      }
      if (['Article', 'NewsArticle', 'BlogPosting', 'TechArticle'].includes(t)) need(n, t, ['headline', 'author', 'datePublished', 'image'], 'recommended'); // Google: no required fields
      if (t === 'Event' || /Event$/.test(t)) { need(n, t, ['name', 'startDate', 'location']); need(n, t, ['location.address']); if (n.name && !textHas(n.name)) res.mismatches.push({ type: t, field: 'name', value: clean(n.name).slice(0, 100), problem: 'not_visible' }); }
      if (t === 'Person' && top) need(n, t, ['name'], 'recommended');
      if (t === 'VideoObject') need(n, t, ['name', 'thumbnailUrl', 'uploadDate']);
      if (t === 'Course') need(n, t, ['name', 'description']);
      if (t === 'JobPosting') { need(n, t, ['title', 'description', 'datePosted', 'hiringOrganization']); if (!has(n, 'applicantLocationRequirements')) need(n, t, ['jobLocation']); }
      if (t === 'Recipe') { need(n, t, ['name', 'image']); if (market !== 'intl') need(n, t, ['recipeIngredient'], 'required', ['yandex']); }
      if (t === 'HowTo' && !res.notes.includes('howto_retired')) res.notes.push('howto_retired'); // Google removed HowTo rich results in 09.2023
      if (t === 'SoftwareApplication' || t === 'MobileApplication' || t === 'WebApplication') { need(n, t, ['name', 'offers.price']); if (!['review', 'aggregateRating'].some(k => has(n, k))) res.issues.push({ type: t, field: 'aggregateRating|review', problem: 'missing', level: 'required', engines: ['google'] }); }
      if (t === 'ImageObject' && top) need(n, t, ['contentUrl|url'], 'recommended');
      if (t === 'WebSite' && top) need(n, t, ['name|url'], 'recommended');
      // Google: reviews of an organization placed on its own site are not eligible for star snippets
      if (ORG(t) && (has(n, 'aggregateRating') || has(n, 'review'))) res.self_rating.push({ type: t, field: has(n, 'aggregateRating') ? 'aggregateRating' : 'review' });
      if ((t === 'AggregateRating' || t === 'Review') && n.itemReviewed && typeOf(n.itemReviewed).some(ORG)) res.self_rating.push({ type: t, field: 'itemReviewed', reviewed: typeOf(n.itemReviewed)[0] });
      // Google asks for the country and area code in telephone
      if (has(n, 'telephone') && !/^\s*\+/.test(String([].concat(n.telephone)[0]))) res.issues.push({ type: t, field: 'telephone', problem: 'no_country_code', level: 'recommended', engines: ['google'], value: String([].concat(n.telephone)[0]).slice(0, 30) });
      // consistency with visible text
      if ((t === 'Offer' || t === 'AggregateOffer') && visible) {
        for (const k of ['price', 'lowPrice', 'highPrice']) {
          if (!has(n, k)) continue;
          const v = String(n[k]).replace(/[\s ]/g, '').replace(/[.,]0+$/, '');
          const intPart = v.split(/[.,]/)[0];
          if (intPart && intPart !== '0' && !new RegExp('(^|\\D)' + intPart + '(\\D|$)').test(visDigits)) res.mismatches.push({ type: t, field: k, value: String(n[k]), problem: 'not_visible' });
        }
      }
      if (has(n, 'telephone') && visible) {
        const d = digits(n.telephone).slice(-10);
        const inText = d.length >= 7 && (digits(visible).includes(d) || telDigits.some(x => x.endsWith(d)) || (String(visible).match(/\+?\d[\d\s() -]{6,}\d/g) || []).some(m => digits(m).endsWith(d)));
        if (d.length >= 7 && !inText) res.mismatches.push({ type: t, field: 'telephone', value: String(n.telephone).slice(0, 40), problem: 'not_visible' });
      }
      if (t === 'PostalAddress' && has(n, 'streetAddress') && visible) {
        const word = (clean(n.streetAddress).match(/[\p{L}]{4,}/gu) || []).find(w => !/^(улица|ulitsa|street|проспект|переулок|дом|строение|корпус|офис)$/i.test(w));
        const stem = word ? normKey(word).slice(0, Math.max(4, word.length - 2)) : null; // crude stem: «Тверская» ~ «Тверской»
        if (stem && !vis.includes(stem)) res.mismatches.push({ type: t, field: 'streetAddress', value: clean(n.streetAddress).slice(0, 100), problem: 'not_visible', confidence: 'low' });
      }
      if (t === 'AggregateRating' && visible && has(n, 'ratingValue')) {
        const rv = String(n.ratingValue).replace('.', '[.,]');
        if (!new RegExp('(^|[^\\d])' + rv + '([^\\d]|$)').test(String(visible))) res.mismatches.push({ type: t, field: 'ratingValue', value: String(n.ratingValue), problem: 'not_visible' });
      }
    }
  }
  return res;
}

function analyzePage(page, fetchRes, raw, dom, visibleText) {
  const d = dom || raw; // rendered view when we have it
  const final = fetchRes?.url || page.url;
  const item = { pid: page.pid, url: page.url, template: page.template || null };
  item.fetch = fetchRes ? {
    status: fetchRes.status, final_url: final, redirects: Math.max(0, (fetchRes.chain || []).length - 1),
    chain: (fetchRes.chain || []).map(c => ({ url: c.url, status: c.status })), ms: fetchRes.ms, bytes: fetchRes.bytes ?? null,
    content_type: fetchRes.headers?.['content-type'] || null, x_robots_tag: fetchRes.headers?.['x-robots-tag'] || null,
    last_modified: fetchRes.headers?.['last-modified'] || null, antibot: fetchRes.antibot || null, error: fetchRes.error || null,
  } : null;
  item.rendered = dom ? (dom.__source || 'snapshot') : null;
  if (!d) return item;
  // title / description
  const t = d.title || '';
  item.title = { text: t.slice(0, 300), len: len(t), count: d.title_count, raw_text: raw ? raw.title.slice(0, 300) : null,
    changed_by_js: !!(raw && dom && clean(raw.title) !== clean(dom.title)),
    norms: { yandex: normRange(len(t), NORMS.title.yandex), google: normRange(len(t), NORMS.title.google) } };
  const descs = d.descriptions || [];
  const desc = descs[0] ?? null;
  const dl = desc == null ? 0 : len(desc);
  item.description = { text: desc == null ? null : clean(desc).slice(0, 400), len: dl, count: descs.length, empty: desc != null && dl === 0,
    norms: { yandex: dl > NORMS.description.yandex_max ? 'long' : normRange(dl, [NORMS.description.yandex[0], NORMS.description.yandex_max]),
      yandex_ideal: normRange(dl, NORMS.description.yandex), google: normRange(dl, NORMS.description.google) } };
  // headings
  const h1d = (d.headings || []).filter(h => h.level === 1);
  const h1r = raw ? raw.headings.filter(h => h.level === 1) : null;
  const h1Text = h => h.text || (h.img_alt ? `[img: ${h.img_alt}]` : '');
  item.h1 = { count: h1d.length, raw_count: h1r ? h1r.length : null, texts: h1d.map(h1Text).slice(0, 5), raw_texts: h1r ? h1r.map(h1Text).slice(0, 5) : null,
    empty: h1d.filter(h => !h.text && !h.img_alt).length, hidden_hint: h1d.filter(h => h.hidden).map(h => h.hidden),
    logo_like: h1d.filter(h => h.home_link || (h.img_only && h.region === 'header')).length,
    visible_count_hint: h1d.filter(h => !h.hidden).length, same_as_title: h1d.length ? normKey(h1d[0].text) === normKey(t) : null };
  const seq = (d.headings || []).filter(h => !h.hidden);
  const skips = []; let prevLevel = 0;
  for (const h of seq) { if (prevLevel && h.level > prevLevel + 1 && skips.length < 10) skips.push({ from: `h${prevLevel}`, to: `h${h.level}`, text: h.text.slice(0, 80) }); prevLevel = h.level; }
  const firstH2 = seq.findIndex(h => h.level === 2); const firstH3 = seq.findIndex(h => h.level === 3);
  item.headings = { total: seq.length, by_level: [1, 2, 3, 4, 5, 6].map(l => seq.filter(h => h.level === l).length), first: seq[0] ? `h${seq[0].level}` : null,
    skips, h3_before_h2: firstH3 >= 0 && (firstH2 < 0 || firstH3 < firstH2), empty: seq.filter(h => !h.text && !h.img_alt).length,
    cta_like: seq.filter(h => (h.in_link && !h.home_link) || /^(записаться|заказать|оставить заявку|купить|позвонить|узнать цену|получить|book|buy|order|sign up|contact us)/i.test(h.text)).map(h => `h${h.level}: ${h.text.slice(0, 60)}`).slice(0, 5),
    outline: seq.slice(0, 40).map(h => `h${h.level} ${h.text.slice(0, 60)}`) };
  // canonical
  const can = d.canonical || [];
  const c0 = can[0] || null;
  const canRaw = raw ? (raw.canonical[0]?.abs || null) : null;
  item.canonical = { count: can.length, href: c0?.href ?? null, abs: c0?.abs ?? null, absolute: c0 ? /^https?:\/\//i.test(String(c0.href).trim()) : null,
    self: c0?.abs ? keyOf(c0.abs) === keyOf(final) : null, exact_self: c0?.abs ? stripHash(c0.abs) === stripHash(final) : null,
    has_params: c0?.abs ? /\?/.test(c0.abs) : null, in_body: can.some(c => !c.in_head),
    // keyOf() ignores protocol and www, so a self-canonical can still point to http:// or to the other host
    protocol_mismatch: (() => { try { return c0?.abs ? new URL(c0.abs).protocol !== new URL(final).protocol : null; } catch { return null; } })(),
    host_mismatch: (() => { try { return c0?.abs ? new URL(c0.abs).hostname.toLowerCase() !== new URL(final).hostname.toLowerCase() : null; } catch { return null; } })(),
    differs_raw_dom: !!(raw && dom && canRaw !== (c0?.abs || null)), raw_abs: canRaw, distinct: uniq(can.map(c => c.abs)).length };
  // robots
  const robotsMeta = [...(d.robots || []), ...(raw?.robots || [])];
  const xr = item.fetch?.x_robots_tag || '';
  const allR = [...robotsMeta, ...(d.yandex || []), ...(d.googlebot || []), xr].join(',').toLowerCase();
  // per engine: «googlebot: noindex» or <meta name="yandex" content="noindex"> closes the page for one engine only
  const be = robotsByEngine(robotsMeta, [...(d.googlebot || []), ...(raw?.googlebot || [])], [...(d.yandex || []), ...(raw?.yandex || [])], xr);
  const noindexAll = be.noindex.all || (be.noindex.google && be.noindex.yandex);
  item.robots = { meta: uniq(d.robots || []).join(' | ') || null, raw_meta: raw ? uniq(raw.robots).join(' | ') || null : null,
    yandex: uniq(d.yandex || []).join(' | ') || null, googlebot: uniq(d.googlebot || []).join(' | ') || null, x_robots_tag: xr || null,
    noindex: noindexAll, noindex_by: { all: noindexAll, yandex: be.noindex.yandex, google: be.noindex.google },
    nofollow: be.nofollow.all || (be.nofollow.google && be.nofollow.yandex), nofollow_by: be.nofollow, other_bots: be.other_bots,
    noindex_only_in_js: !!(raw && dom && !/noindex/i.test([...(raw.robots || []), ...(raw.googlebot || []), ...(raw.yandex || []), xr].join(',')) && /noindex/i.test([...(dom.robots || []), ...(dom.googlebot || []), ...(dom.yandex || [])].join(','))),
    max_image_preview: (allR.match(/max-image-preview:\s*(\w+)/) || [])[1] || null, meta_refresh: d.refresh?.[0] || null };
  // hreflang, lang
  item.hreflang = (d.hreflang || []).map(h => hreflangEntry(h.lang, h.href));
  // the same can be sent in the HTTP header: Link: <https://…/en/>; rel="alternate"; hreflang="en"
  item.hreflang_header = linkHeaderAlternates(fetchRes?.headers?.link, final);
  const letters = (d.text || '').slice(0, 20000).match(/\p{L}/gu) || [];
  const cyr = letters.filter(c => /[Ѐ-ӿ]/.test(c)).length;
  const cyrShare = letters.length ? cyr / letters.length : null;
  const lv = (d.lang || '').trim();
  const cyrLang = /^(ru|uk|be|bg|kk|sr|mk|ky|tg|mn|ba|tt|ce|cv|os|sah)\b/i.test(lv);
  item.lang = { value: lv || null, valid: lv ? /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(lv) : false, cyrillic_share: cyrShare == null ? null : Math.round(cyrShare * 100) / 100,
    mismatch: !!lv && cyrShare != null && letters.length > 200 && ((cyrShare > 0.6 && !cyrLang) || (cyrShare < 0.1 && cyrLang)) };
  // OG / Twitter
  const og1 = k => (d.og?.[k] || [])[0] ?? null;
  const tw1 = k => (d.twitter?.[k] || [])[0] ?? null;
  const ogNeed = ['og:title', 'og:description', 'og:image', 'og:url', 'og:type'];
  item.og = { title: og1('og:title'), description: og1('og:description'), image: og1('og:image') || og1('og:image:url') || og1('og:image:secure_url'),
    image_abs: (() => { const v = og1('og:image') || og1('og:image:url') || og1('og:image:secure_url'); try { return v ? new URL(v.trim(), final).href : null; } catch { return null; } })(),
    image_relative: (() => { const v = og1('og:image'); return v ? !/^https?:\/\//i.test(v.trim()) : null; })(),
    image_count: (d.og?.['og:image'] || []).length, url: og1('og:url'), type: og1('og:type'), site_name: og1('og:site_name'), locale: og1('og:locale'),
    image_alt: og1('og:image:alt'), image_w: og1('og:image:width'), image_h: og1('og:image:height'),
    missing: ogNeed.filter(k => !og1(k) && !(k === 'og:image' && (og1('og:image:url') || og1('og:image:secure_url')))),
    missing_recommended: ['og:site_name', 'og:locale', 'og:image:alt', 'og:image:width', 'og:image:height'].filter(k => !og1(k)),
    desc_differs: !!(og1('og:description') && desc && normKey(og1('og:description')) !== normKey(desc)),
    url_not_canonical: (() => { try { return !!(og1('og:url') && c0?.abs && keyOf(new URL(og1('og:url'), final).href) !== keyOf(c0.abs)); } catch { return null; } })(),
    in_raw: raw ? !!(raw.og?.['og:title'] || raw.og?.['og:image']) : null };
  item.twitter = { card: tw1('twitter:card'), image: tw1('twitter:image'), title: tw1('twitter:title') };
  // JSON-LD (rendered view, plus raw count)
  item.jsonld = analyzeJsonLd(d.jsonld || [], final, visibleText ?? d.text, d);
  item.jsonld.raw_blocks = raw ? raw.jsonld.length : null;
  item.jsonld.only_in_js = !!(raw && dom && raw.jsonld.length === 0 && dom.jsonld.length > 0);
  item.microdata = d.microdata;
  // images / alt
  const imgs = (d.images || []).filter(i => i.src && !/^data:/.test(i.src) && !i.aria_hidden && i.role !== 'presentation');
  const junk = imgs.filter(i => i.alt && (/\.(jpe?g|png|webp|gif|svg|avif)$/i.test(i.alt) || /^(img|image|photo|фото|картинка|изображение|picture|pic|untitled|dsc|screenshot|снимок)[\s_-]*\d*$/i.test(i.alt) || /^[\w-]*\d{3,}[\w-]*$/.test(i.alt)));
  item.images = { total: imgs.length, no_alt: imgs.filter(i => i.alt === null).length, empty_alt: imgs.filter(i => i.alt === '').length,
    empty_alt_in_link: imgs.filter(i => i.alt === '' && i.in_link).length, junk_alt: junk.length,
    samples_no_alt: imgs.filter(i => i.alt === null).slice(0, 5).map(i => i.src.slice(0, 160)), samples_junk: junk.slice(0, 5).map(i => `${i.alt} ← ${i.src.slice(0, 100)}`) };
  // links
  const links = d.links || [];
  const internal = links.filter(l => l.url && /^https?:/i.test(l.url) && U.sameSite(l.url, final));
  const mainLinks = internal.filter(l => l.region === 'main' || l.region === 'body');
  const generic = {};
  for (const l of links.filter(l => l.region === 'main' || l.region === 'body')) { const k = normKey(l.text); if (GENERIC_ANCHORS.has(k)) generic[k] = (generic[k] || 0) + 1; }
  const rawLinks = raw ? raw.links : links;
  item.links = { total: links.length, internal: internal.length, main_internal: mainLinks.length, main_internal_unique: uniq(mainLinks.map(l => keyOf(l.url))).length,
    has_main: d.has_main, generic_anchors: generic,
    relative_no_slash: uniq(rawLinks.filter(l => l.href && !/^(\/|#|\?|[a-z][a-z0-9+.-]*:)/i.test(l.href.trim())).map(l => l.href.trim())).slice(0, 10),
    broken_anchors: d.broken_anchors || [], blank_no_noopener: links.filter(l => l.target === '_blank' && !/noopener|noreferrer/.test(l.rel) && l.url && !U.sameSite(l.url, final)).length,
    to_service_pages: uniq(internal.filter(l => /\/(thanks|thank-you|thankyou|spasibo|success|404)(\.html?)?\/?$/i.test(new URL(l.url).pathname)).map(l => l.url)).slice(0, 10),
    tracking_params: uniq(internal.filter(l => /[?&](utm_|yclid=|gclid=|fbclid=|from=)/i.test(l.url)).map(l => l.url)).slice(0, 10),
    nofollow_internal: internal.filter(l => /nofollow/.test(l.rel)).length, raw_internal: raw ? raw.links.filter(l => l.url && U.sameSite(l.url, final)).length : null,
    param_links: paramLinks(internal, final) };
  // text: what search robots without JS get. «js_only» = the page is empty without JS (a robot sees almost nothing);
  // «js_added» = JS adds to text that is already in the HTML (widgets, reviews, translations) — normal, low.
  item.text = { raw_len: raw ? raw.text_len : null, dom_len: dom ? dom.text_len : null, main_len: d.main_text_len, raw_main_len: raw ? raw.main_text_len : null };
  if (raw && dom) {
    const domSh = U.shingles(dom.text.slice(0, 60000), 4), rawSh = U.shingles(raw.text.slice(0, 60000), 4);
    let found = 0; for (const s of domSh) if (rawSh.has(s)) found++;
    const coverage = domSh.size ? Math.round(found / domSh.size * 100) / 100 : 1;
    const rawCore = raw.main_text_len ?? raw.text_len;
    item.text.raw_coverage = coverage; // share of rendered 4-word shingles already present in the raw HTML
    item.text.js_only = dom.text_len > 1500 && (coverage < 0.2 || rawCore < 300);
    item.text.js_added = !item.text.js_only && dom.text_len - raw.text_len > 300 && coverage < 0.9 ? dom.text_len - raw.text_len : 0;
  } else { item.text.js_only = false; item.text.js_added = 0; }
  // URL format
  try {
    const p = decodeURI(new URL(final).pathname);
    item.url_format = { cyrillic: /[Ѐ-ӿ]/.test(p), uppercase: /[A-Z]/.test(p), underscore: /_/.test(p), double_slash: /\/\//.test(p), extension: (p.match(/\.(php|aspx?|jsp|cgi)$/i) || [])[1] || null };
  } catch { item.url_format = null; }
  // spam words (raw = what bots without JS read)
  const spamText = (raw?.text || d.text || '').toLowerCase();
  item.spam = SPAM_WORDS.map(([w, ctx]) => ({ word: w, context_dependent: ctx, count: spamText.split(w).length - 1 })).filter(x => x.count > 0);
  item.meta_keywords = !!d.keywords;
  item.generator = d.generator?.[0] || null;
  item.page_ids = (raw?.page_ids?.length ? raw.page_ids : d.page_ids) || [];
  return item;
}

// ---------- checks over the network ----------
// fetchBytes does not pause the host on 429 by itself (politeFetch does): do it here for every byte-limited GET
async function fetchB(u, o) { const r = await U.fetchBytes(u, o); if (r.status === 429) U.coolDownHost(U.hostOf(r.url || u)); return r; }
async function getPage(url) { return U.politeFetch(url, { lang, timeoutMs: 25000 }); }

async function softCheck(url) {
  const r = await getPage(url);
  const first = r.chain?.[0];
  const res = { url, status: r.status, final_url: r.url, redirects: Math.max(0, (r.chain || []).length - 1), error: r.error || null, antibot: r.antibot || null,
    first_status: first?.status ?? r.status, permanent: [301, 308].includes(first?.status) };
  if (r.body && r.status) {
    try {
      const p = await tab.parse(r.body, r.url);
      res.canonical = p.canonical[0]?.abs || null;
      res.title = p.title.slice(0, 120); res.h1 = p.headings.filter(h => h.level === 1).map(h => h.text.slice(0, 100)).slice(0, 3);
      res.text_len = p.text_len; res.internal_links = uniq(p.links.filter(l => l.url && U.sameSite(l.url, r.url)).map(l => keyOf(l.url))).length;
      res.noindex = /noindex/i.test([...(p.robots || []), r.headers?.['x-robots-tag'] || ''].join(','));
      // what a person sees: does the page say «not found»? A bare «404» counts only in title/H1/H2 or next to an
      // error word, and phone numbers are removed first («+7 (495) 404-12-34» is not an error page).
      const noPhones = s => String(s || '').replace(/\+?\d[\d\s()\-.]{6,}\d/g, ' ');
      const head = noPhones([p.title, ...p.headings.filter(h => h.level <= 2).map(h => h.text)].join(' \n '));
      const body = noPhones(p.text.slice(0, 1500));
      const words = /не\s*найден|не\s*существует|нет\s+такой\s+страницы|страница\s+удалена|not\s+found|doesn.t\s+exist|does\s+not\s+exist|no\s+longer\s+available/i;
      res.says_not_found = words.test(head) || words.test(body) || /(^|\D)404(\D|$)/.test(head)
        || /(ошибка|error|код|code|страниц\w*|page)\W{0,15}404(\D|$)|(^|\D)404\W{0,15}(ошибка|error|страниц\w*|page)/i.test(body);
      res._text = p.text.slice(0, 20000);
    } catch (e) { res.parse_error = e.message; }
  }
  return res;
}

async function siteChecks() {
  const site = out.site;
  const homeItem = out.items.find(i => i.pid === home.pid);
  const isHttps = origin.startsWith('https:');
  const hostName = siteHost;
  // http → https
  site.https = isHttps;
  if (isHttps && !hostIsLocal(hostName)) {
    const r = await U.politeFetch(`http://${new URL(origin).host}/`, { method: 'GET', lang, timeoutMs: 15000 });
    const first = r.chain?.[0];
    site.http_to_https = { status: first?.status ?? r.status, first_location: first?.location || null, hops: Math.max(0, (r.chain || []).length - 1),
      final_url: r.url, final_https: /^https:/i.test(r.url || ''), permanent: [301, 308].includes(first?.status), error: r.error || null };
  } else site.http_to_https = { not_applicable: isHttps ? 'local' : 'site_is_http' };
  // www ↔ apex
  if (!hostIsLocal(hostName) && !/^\d+\.\d+\.\d+\.\d+$/.test(hostName)) {
    const alt = hostName.startsWith('www.') ? hostName.slice(4) : 'www.' + hostName;
    let resolves = true;
    try { await lookup(alt); } catch { resolves = false; }
    if (resolves) {
      const r = await U.politeFetch(`${new URL(origin).protocol}//${alt}/`, { method: 'GET', lang, timeoutMs: 15000, maxBytes: 300000 });
      const first = r.chain?.[0];
      site.www = { host: alt, resolves, status: first?.status ?? r.status, final_url: r.url, to_main: U.hostOf(r.url) === hostName,
        permanent: [301, 308].includes(first?.status), hops: Math.max(0, (r.chain || []).length - 1), error: r.error || null };
      if (r.status === 200 && U.hostOf(r.url) !== hostName && r.body) {
        try { const p = await tab.parse(r.body, r.url); site.www.canonical = p.canonical[0]?.abs || null; site.www.canonical_to_main = p.canonical[0]?.abs ? U.hostOf(p.canonical[0].abs) === hostName : false; } catch {}
      }
    } else site.www = { host: alt, resolves: false };
  }
  // soft-404 first: on a catch-all site (every address answers 200) the URL variants below are not copies of a page
  const code = rnd6();
  const probes = [origin + '/revizor-404-check-' + code];
  const seg = selected.map(p => { try { return new URL(p.url).pathname.split('/').filter(Boolean); } catch { return []; } }).find(s => s.length >= 2);
  if (seg) probes.push(`${origin}/${seg[0]}/revizor-404-check-${code}`);
  site.soft404 = [];
  const homeTextKey = pageText.get(home.pid) || null;
  for (const u of probes) {
    if (timeLeft() < 15000) { cutShort(L('soft-404 — не хватило времени', 'soft-404 — out of time')); break; }
    const s = await softCheck(u);
    const sameAsHome = !!(homeItem && s.title && ((normKey(s.title) === normKey(homeItem.title?.text) && normKey((s.h1 || [])[0] || '') === normKey(homeItem.h1?.texts?.[0] || '')) ||
      (homeTextKey && s._text && jaccard(U.shingles(s._text, 4), U.shingles(homeTextKey, 4)) > 0.8)));
    s.same_as_home = sameAsHome;
    s.verdict = s.error ? 'error' : (s.status === 404 || s.status === 410) ? 'ok' : (s.redirects > 0 && s.status === 200) ? 'redirect_to_200' : s.status === 200 ? 'soft404' : s.status >= 500 ? 'server_error' : 'other';
    // what the 200 answer looks like: a copy of the home page, an error page with the wrong code, or some other page
    if (s.status === 200) s.kind = sameAsHome ? 'home_copy' : s.says_not_found ? 'not_found_page_200' : 'other_page_200';
    s.own_template = s.status === 404 || s.status === 410 ? !!(s.h1?.length || s.text_len > 200) && (s.internal_links || 0) >= 3 : null;
    delete s._text; delete s.canonical; delete s.first_status; delete s.permanent;
    site.soft404.push(s);
  }
  // signature of the «not found» page that answers 200 — a variant that looks like it is not a duplicate
  const notFoundSig = site.soft404.filter(s => s.status === 200 && !s.same_as_home && (s.title || s.h1?.length)).map(s => ({ title: normKey(s.title || ''), h1: normKey((s.h1 || [])[0] || '') }));
  // trailing slash, case, index.html, index.php, builder aliases /page<ID>.html
  const inner = selected.find(p => { try { return new URL(p.url).pathname.length > 1 && !/\.\w{2,4}$/.test(new URL(p.url).pathname); } catch { return false; } });
  const variants = [];
  if (inner) {
    const u = new URL(inner.url); u.hash = '';
    const toggled = new URL(u); toggled.pathname = u.pathname.endsWith('/') ? u.pathname.replace(/\/+$/, '') : u.pathname + '/';
    variants.push({ kind: 'slash', from: inner.url, pid: inner.pid, url: toggled.toString() });
    if (/[a-z]/.test(u.pathname)) { const up = new URL(u); up.pathname = u.pathname.toUpperCase(); variants.push({ kind: 'case', from: inner.url, pid: inner.pid, url: up.toString() }); }
  }
  variants.push({ kind: 'index_html', from: origin + '/', pid: home.pid, url: origin + '/index.html' });
  // /index.php only where PHP is already known (CMS from crawl or meta generator) — no guessing paths
  const phpLike = /wordpress|bitrix|битрикс|joomla|drupal|modx|opencart|1c-|umi|netcat|php/i.test(cms + ' ' + (homeItem?.generator || ''));
  if (phpLike) variants.push({ kind: 'index_php', from: origin + '/', pid: home.pid, url: origin + '/index.php' });
  // only where the page itself carries data-<builder>-page-id: such builders also serve it at /page<ID>.html
  for (const it of out.items.filter(i => i.page_ids?.length && i.fetch?.status === 200).slice(0, 2)) {
    const id = it.page_ids[0].id; const fin = it.fetch.final_url || it.url;
    try { if (new URL(fin).pathname !== `/page${id}.html`) variants.push({ kind: 'platform_alias', from: fin, pid: it.pid, url: `${origin}/page${id}.html`, attr: it.page_ids[0].attr }); } catch {}
  }
  site.url_variants = [];
  for (const v of variants) {
    if (timeLeft() < 15000) { cutShort(L('варианты адресов (слэш, регистр, index.html) — не хватило времени', 'URL variants — out of time')); break; }
    const s = await softCheck(v.url);
    const rec = { kind: v.kind, url: v.url, status: s.first_status, final_url: s.final_url, final_status: s.status, permanent: s.permanent, error: s.error, ...(v.attr ? { by_attr: v.attr } : {}) };
    if (s.status === 200 && s.redirects === 0 && s.title !== undefined) {
      const src = out.items.find(i => i.pid === v.pid);
      const srcText = pageText.get(v.pid);
      const sameHead = !!src && normKey(s.title) === normKey(src.title?.text || '') && normKey((s.h1 || [])[0] || '') === normKey(src.h1?.texts?.[0] || '');
      const jac = srcText && s._text ? Math.round(jaccard(U.shingles(s._text, 4), U.shingles(srcText, 4)) * 100) / 100 : null;
      const like404 = s.says_not_found || notFoundSig.some(g => g.title === normKey(s.title) && g.h1 === normKey((s.h1 || [])[0] || ''));
      rec.canonical = s.canonical || null;
      // exact address: for a slash or case variant keyOf() would call /about and /about/ the same page
      rec.canonical_to_original = rec.canonical ? stripHash(rec.canonical) === stripHash(new URL(v.from).href) : false;
      rec.similarity = jac;
      // a duplicate = the same page under another address; the «not found» page with code 200 is the soft-404 problem
      rec.kind_of_answer = like404 && !sameHead ? 'soft404' : (sameHead || (jac != null && jac >= 0.8)) ? 'copy' : 'other_page';
      rec.duplicate = rec.kind_of_answer === 'copy' && !rec.canonical_to_original;
    }
    site.url_variants.push(rec);
  }
}

async function robotsCheck() {
  const site = out.site;
  const r = await U.politeFetch(origin + '/robots.txt', { lang, accept: 'text/plain,*/*', timeoutMs: 15000 });
  const rob = { url: origin + '/robots.txt', status: r.status, final_url: r.url, redirects: Math.max(0, (r.chain || []).length - 1),
    content_type: r.headers?.['content-type'] || null, bytes: r.bytes ?? null, error: r.error || null };
  site.robots = rob;
  if (r.status !== 200 || !r.body || looksHtml(r.body)) { rob.missing = true; rob.html_instead = r.status === 200 && looksHtml(r.body); return null; }
  const text = r.body.slice(0, 500000);
  const parsed = U.parseRobots(text);
  const known = /^(user-agent|allow|disallow|sitemap|clean-param|host|crawl-delay|content-signal|request-rate|visit-time|noindex)$/i;
  const unknown = []; const lines = text.split(/\r?\n/);
  lines.forEach((ln, i) => { const s = ln.replace(/#.*/, '').trim(); if (!s) return; const m = s.match(/^([A-Za-z-]+)\s*:/); if (!m || !known.test(m[1])) { if (unknown.length < 10) unknown.push({ line: i + 1, text: s.slice(0, 100) }); } });
  const groupFor = agent => parsed.groups.find(g => g.agents.some(x => x !== '*' && agent.toLowerCase().includes(x))) || null;
  const star = parsed.groups.find(g => g.agents.includes('*')) || null;
  const disallowAll = g => !!g && g.rules.some(x => x.type === 'disallow' && x.path === '/') && !g.rules.some(x => x.type === 'allow' && (x.path === '/' || x.path === '/$'));
  const cp = parsed.cleanParams.join(' ').toLowerCase();
  rob.lines = lines.length;
  rob.groups = parsed.groups.map(g => ({ agents: g.agents, rules: g.rules.length, disallow_all: disallowAll(g) })).slice(0, 30);
  rob.sitemaps = parsed.sitemaps; rob.sitemap_relative = parsed.sitemaps.filter(s => !/^https?:\/\//i.test(s));
  rob.clean_param = parsed.cleanParams.slice(0, 20);
  rob.clean_param_covers = { utm: /utm/.test(cp), yclid: /yclid/.test(cp), gclid: /gclid/.test(cp), fbclid: /fbclid/.test(cp), from: /(^|[\s&])from([\s&]|$)/.test(cp) };
  rob.host_directive = parsed.host; rob.crawl_delay = /crawl-delay/i.test(text);
  rob.disallow_all = { '*': disallowAll(star), yandex: disallowAll(groupFor('YandexBot') || star), google: disallowAll(groupFor('Googlebot') || star) };
  rob.unknown_lines = unknown;
  rob.cloudflare_managed = /BEGIN Cloudflare Managed|Content-Signal\s*:/i.test(text);
  rob.content_signal = (text.match(/Content-Signal\s*:\s*([^\r\n]+)/i) || [])[1] || null;
  // own_group tokens (Yandex) ignore «User-agent: *»: without their own group they are allowed
  const exactGroup = b => parsed.groups.find(g => g.agents.some(x => x === b.toLowerCase())) || null;
  rob.ai_bots = AI_BOTS.map(b => {
    const explicit = !!(b.robots === 'own_group' ? exactGroup(b.bot) : groupFor(b.bot));
    const allowed = b.robots === 'own_group' ? (explicit ? U.robotsAllows({ groups: [exactGroup(b.bot)] }, origin + '/', b.bot) : true) : U.robotsAllows(parsed, origin + '/', b.bot);
    return { bot: b.bot, operator: b.op, purpose: b.purpose, obeys_robots: b.robots !== 'no', explicit, root_allowed: allowed };
  });
  rob.ai_bots_checked = AI_BOTS_CHECKED;
  rob.yandex_ai = { explicit: rob.ai_bots.some(b => /^YandexAdditional/.test(b.bot) && b.explicit), blocked: rob.ai_bots.some(b => /^YandexAdditional/.test(b.bot) && !b.root_allowed) };
  rob.selected_blocked = selected.map(p => ({ pid: p.pid, url: p.url, yandex: !U.robotsAllows(parsed, p.url, 'YandexBot'), google: !U.robotsAllows(parsed, p.url, 'Googlebot'), any: !U.robotsAllows(parsed, p.url, '*') }))
    .filter(x => x.yandex || x.google || x.any);
  return parsed;
}

async function sitemapCheck(robotsParsed) {
  const site = out.site;
  const seeds = (robotsParsed?.sitemaps || []).map(s => { try { return new URL(s, origin).href; } catch { return null; } }).filter(Boolean);
  const sm = { declared_in_robots: seeds.length > 0, seeds: seeds.slice(0, 10) };
  site.sitemap = sm;
  if (!seeds.length) {
    const r = await U.politeFetch(origin + '/sitemap.xml', { method: 'GET', lang, accept: 'application/xml,text/xml,*/*', timeoutMs: 15000, maxBytes: 2000000 });
    sm.default_status = r.status;
    if (r.status === 200 && r.body && /<(urlset|sitemapindex)[\s>]/i.test(r.body)) seeds.push(origin + '/sitemap.xml');
  }
  if (!seeds.length) { sm.missing = true; return; }
  // the first file: root/declaration/type and hreflang alternates (<xhtml:link>); if it is an index — its first child.
  // fetchSitemaps reads all files again (it does not return alternates), so this is ≤ 2 extra requests of ≤ 3 MB.
  const readXml = async u => {
    const gz = /\.gz($|\?)/i.test(u);
    const r = await U.politeFetch(u, { accept: 'application/xml,text/xml,*/*', timeoutMs: 20000, maxBytes: 3 * 1024 * 1024, binary: gz, lang });
    let text = r.body || '';
    if (gz && r.buf) { try { text = gunzipSync(r.buf).toString('utf8'); } catch { text = ''; } }
    return { r, text };
  };
  const { r: first, text: fh } = await readXml(seeds[0]);
  sm.first = { url: seeds[0], status: first.status, content_type: first.headers?.['content-type'] || null, redirects: Math.max(0, (first.chain || []).length - 1),
    root: (fh.match(/<(urlset|sitemapindex)[\s>]/i) || [])[1] || null, xml_decl: /^\s*<\?xml/i.test(fh), html_instead: looksHtml(fh), gz: /\.gz($|\?)/i.test(seeds[0]) };
  let altText = fh, altFrom = seeds[0];
  if (/<sitemapindex/i.test(fh) && timeLeft() > 40000) {
    const child = (fh.match(/<sitemap>[\s\S]*?<loc>\s*([\s\S]*?)\s*<\/loc>/i) || [])[1];
    if (child) { altFrom = U.decodeXml(child.trim()); altText = (await readXml(altFrom)).text; }
  }
  const alt = sitemapAlternates(altText);
  sm.hreflang = { used: alt.urlsWith > 0, urls_with_alternates: alt.urlsWith, checked_file: altFrom, first_file_only: true,
    // alternates of the selected pages (kept in seo.json: a resumed call checks hreflang from here)
    selected: Object.fromEntries(out.items.map(i => [i.pid, alt.map.get(keyOf(i.fetch?.final_url || i.url))]).filter(([, v]) => v?.length)) };
  sitemapAlt = alt.map;
  // stop 25 s before our own deadline: the rest of the step (sample) needs time and seo.json must be written
  // at least 15 s for the files even late in a short call (the overall deadline already keeps a reserve for writing)
  const res = await U.fetchSitemaps(seeds, { limitUrls: 50000, limitFiles: 30, lang, deadline: Math.max(Date.now() + 15000, deadline - 25000) });
  const { urls, files } = res;
  if (res.partial) {
    sm.partial = true; sm.files_pending = res.pending ?? null;
    cutShort(L(`sitemap: прочитано ${files.length} файлов, ещё ${res.pending ?? '?'} в очереди — не хватило времени`, `sitemap: ${files.length} files read, ${res.pending ?? '?'} pending — out of time`));
  }
  sm.files = files.map(f => ({ url: f.url, status: f.status, count: f.count, index: !!f.index, error: f.error || null })).slice(0, 30);
  sm.urls_total = urls.length;
  sm.too_big = files.filter(f => !f.index && f.count > 50000).map(f => f.url).slice(0, 5); // protocol limit: 50 000 URLs per file
  if (files.length >= 30 && !res.partial) addNotChecked(L('sitemap: прочитаны первые 30 файлов (лимит), остальные не открывали', 'sitemap: first 30 files read (limit)'));
  const keys = new Set(urls.map(u => keyOf(u.loc)));
  const mainHost = siteHost; const mainProto = new URL(origin).protocol;
  const foreign = urls.filter(u => { try { const x = new URL(u.loc); return x.hostname.toLowerCase() !== mainHost || x.protocol !== mainProto; } catch { return true; } });
  sm.foreign_host_or_protocol = { count: foreign.length, sample: foreign.slice(0, 5).map(u => u.loc) };
  sm.with_params = urls.filter(u => /\?/.test(u.loc)).length;
  // lastmod honesty
  const lm = urls.map(u => u.lastmod).filter(Boolean);
  const byDay = {}; for (const x of lm) { const k = String(x).slice(0, 10); byDay[k] = (byDay[k] || 0) + 1; }
  const top = Object.entries(byDay).sort((a, b) => b[1] - a[1])[0];
  const now = Date.now();
  sm.lastmod = { with_lastmod: lm.length, distinct_days: Object.keys(byDay).length, most_common: top ? { day: top[0], share: U.pct(top[1], lm.length) } : null,
    future: lm.filter(x => Date.parse(x) > now + 86400000).length, invalid: lm.filter(x => Number.isNaN(Date.parse(x))).length,
    newest: lm.length ? lm.slice().sort().pop() : null, oldest: lm.length ? lm.slice().sort()[0] : null };
  // selected pages vs sitemap
  const indexable = out.items.filter(i => i.fetch?.status === 200 && !i.robots?.noindex && (i.canonical?.self !== false));
  sm.selected_missing = indexable.filter(i => !keys.has(keyOf(i.fetch.final_url))).map(i => ({ pid: i.pid, url: i.fetch.final_url })).slice(0, 20);
  sm.selected_noindex_listed = out.items.filter(i => i.robots?.noindex && keys.has(keyOf(i.fetch?.final_url || i.url))).map(i => i.pid);
  sm.selected_canonical_other_listed = out.items.filter(i => i.canonical?.self === false && keys.has(keyOf(i.fetch?.final_url || i.url))).map(i => i.pid);
  sm.discovered_by_crawl = pagesJson.discovered ?? null;
  // sample status
  const n = Math.min(SITEMAP_SAMPLE, urls.length);
  const sample = [];
  if (n > 0) { const step = urls.length / n; for (let k = 0; k < n; k++) sample.push(urls[Math.floor(k * step)].loc); }
  sm.sample = [];
  for (const u of sample) {
    if (timeLeft() < 20000) { cutShort(L(`sitemap: проверено ${sm.sample.length} из ${sample.length} адресов выборки — не хватило времени`, `sitemap: sample cut by time (${sm.sample.length}/${sample.length})`)); break; }
    const r = await U.politeFetch(u, { method: 'HEAD', lang, timeoutMs: 15000, retries: 0 });
    let st = r.status, fin = r.url;
    if (!st || st === 405 || st === 501) { const g = await fetchB(u, { maxBytes: 16384, timeoutMs: 15000 }); st = g.status; fin = g.url; if (st === 429) U.coolDownHost(U.hostOf(g.url || u)); }
    sm.sample.push({ url: r.skipped ? maskUrl(u, true) : maskUrl(u), status: st, final_url: fin ? maskUrl(fin) : fin, redirect: !!fin && keyOf(fin) !== keyOf(u), skipped: r.skipped || null });
    if (st === 429) { addNotChecked(L('sitemap: сайт ответил 429 — выборку остановили', 'sitemap: site answered 429 — sample stopped')); break; }
  }
  sm.sample_bad = sm.sample.filter(s => !s.skipped && s.status !== 429 && (s.status !== 200 || s.redirect)).length;
}

async function iconsCheck(homeParsed) {
  const site = out.site;
  const icons = homeParsed?.icons || [];
  const ic = { links: icons.slice(0, 15), theme_color: homeParsed?.theme_color ?? null };
  site.icons = ic;
  const fav = await fetchB(origin + '/favicon.ico', { maxBytes: 65536, timeoutMs: 15000, accept: 'image/*,*/*' });
  const isImg = r => r.status === 200 && !looksHtml(r.buf?.toString('utf8', 0, 300)) && (!!imageDims(r.buf) || /^image\//.test(r.headers?.['content-type'] || ''));
  ic.favicon_ico = { status: fav.status, ok: isImg(fav), content_type: fav.headers?.['content-type'] || null, bytes: fav.total ?? fav.bytes, html_instead: looksHtml(fav.buf?.toString('utf8', 0, 300)),
    dims: fav.status === 200 ? imageDims(fav.buf) : null, redirects: Math.max(0, (fav.chain || []).length - 1), error: fav.error || null };
  ic.has_svg = icons.some(i => /\bicon\b/.test(i.rel) && (/svg/.test(i.type || '') || /\.svg(\?|$)/i.test(i.href || '')));
  ic.has_png_32_or_more = icons.some(i => /\bicon\b/.test(i.rel) && /(32|48|96|192)x/.test(i.sizes || ''));
  const apple = icons.find(i => /apple-touch-icon/.test(i.rel));
  const appleUrl = apple?.href || origin + '/apple-touch-icon.png';
  const ap = await fetchB(appleUrl, { maxBytes: 262144, timeoutMs: 15000, accept: 'image/*,*/*' });
  ic.apple_touch = { declared: !!apple, url: appleUrl, sizes_attr: apple?.sizes || null, status: ap.status, ok: isImg(ap), dims: ap.status === 200 ? imageDims(ap.buf) : null, error: ap.error || null };
  // declared raster icons: real size of up to 2 files (sizes="" is often wrong)
  ic.declared = [];
  for (const i of icons.filter(i => /\bicon\b/.test(i.rel) && !/apple/.test(i.rel) && i.href && !/svg/.test(i.type || '') && !/\.svg(\?|$)/i.test(i.href)).slice(0, 2)) {
    const r = await fetchB(i.href, { maxBytes: 65536, timeoutMs: 15000, accept: 'image/*,*/*' });
    ic.declared.push({ url: maskUrl(i.href), sizes_attr: i.sizes || null, status: r.status, redirects: Math.max(0, (r.chain || []).length - 1), ok: isImg(r), dims: r.status === 200 ? imageDims(r.buf) : null });
  }
  // norms (checked 24.10.2026): Yandex Webmaster «Фавикон» — SVG or 120×120 (also 16×16, 32×32), answer 200 without redirect;
  // Google Search Central «favicon-in-search» — square, ≥ 8×8, better > 48×48; SVG is not in Google's list of formats
  const rasters = [ic.favicon_ico, ...ic.declared].filter(x => x?.ok && x.dims?.w && x.dims?.h);
  const sizesAttr = icons.filter(i => /\bicon\b/.test(i.rel)).flatMap(i => String(i.sizes || '').toLowerCase().split(/\s+/)).map(s => s.split('x').map(Number)).filter(a => a.length === 2 && a[0] > 0);
  const best = Math.max(0, ...rasters.filter(x => x.dims.w === x.dims.h).map(x => x.dims.w), ...sizesAttr.filter(([w, h]) => w === h).map(([w]) => w));
  const anyRedirect = [ic.favicon_ico, ...ic.declared].some(x => x?.redirects > 0);
  // Google also takes rel="apple-touch-icon" as the favicon; Yandex reads rel="icon"
  const apT = ic.apple_touch?.ok ? ic.apple_touch : null;
  const bestG = Math.max(best, apT?.dims?.w && apT.dims.w === apT.dims.h ? apT.dims.w : 0, apT && !apT.dims ? 48 : 0);
  ic.norms = {
    yandex: ic.has_svg || best >= 120 ? 'ok' : best >= 16 ? 'small' : 'missing', yandex_redirect: anyRedirect,
    google: bestG >= 48 ? 'ok' : bestG >= 8 ? 'small' : ic.has_svg ? 'svg_only' : 'missing', best_square_px: best || null, google_best_px: bestG || null,
    source: 'yandex.ru/support/webmaster/ru/search-results/favicon; developers.google.com/search/docs/appearance/favicon-in-search (24.10.2026)' };
  const man = icons.find(i => /\bmanifest\b/.test(i.rel));
  if (man?.href) {
    const m = await U.politeFetch(man.href, { lang, accept: 'application/manifest+json,application/json,*/*', timeoutMs: 15000 });
    const rec = { url: man.href, status: m.status, content_type: m.headers?.['content-type'] || null };
    try {
      const j = JSON.parse(m.body || '');
      const sizes = (j.icons || []).flatMap(i => String(i.sizes || '').split(/\s+/));
      Object.assign(rec, { valid_json: true, name: j.name || null, short_name: j.short_name || null, start_url: j.start_url || null, display: j.display || null,
        theme_color: j.theme_color || null, icon_192: sizes.includes('192x192'), icon_512: sizes.includes('512x512'), icons: (j.icons || []).length });
    } catch { rec.valid_json = false; }
    ic.manifest = rec;
  } else ic.manifest = null;
}

async function llmsCheck() {
  const site = out.site;
  const res = {};
  for (const name of ['llms.txt', 'llms-full.txt']) {
    const r = await U.politeFetch(`${origin}/${name}`, { lang, accept: 'text/plain,text/markdown,*/*', timeoutMs: 15000, maxBytes: 2000000 });
    const ok = r.status === 200 && r.body && !looksHtml(r.body);
    const rec = { status: r.status, present: !!ok, html_instead: r.status === 200 && looksHtml(r.body), content_type: r.headers?.['content-type'] || null, last_modified: r.headers?.['last-modified'] || null };
    if (ok) {
      const b = r.body;
      Object.assign(rec, { bytes: Buffer.byteLength(b), starts_with_h1: /^\s*#\s+\S/.test(b), has_summary: /^>\s+\S/m.test(b), links: (b.match(/\[[^\]]+\]\([^)]+\)/g) || []).length,
        sections: (b.match(/^##\s+/gm) || []).length, years: uniq((b.match(/\b20\d\d\b/g) || [])).sort().slice(-3) });
    }
    res[name] = rec;
  }
  site.llms = res;
}

async function ogImageCheck() {
  const imgs = new Map();
  for (const it of out.items) if (it.og?.image_abs && !imgs.has(it.og.image_abs)) imgs.set(it.og.image_abs, it.pid);
  const list = [...imgs.keys()].slice(0, 10);
  out.site.og_images = [];
  for (const u of list) {
    if (timeLeft() < 15000) { cutShort(L('og:image — проверены не все картинки (время)', 'og:image — cut by time')); break; }
    const r = await fetchB(u, { maxBytes: 3 * 1024 * 1024, timeoutMs: 20000, accept: 'image/*,*/*' });
    const dims = r.status === 200 ? imageDims(r.buf) : null;
    out.site.og_images.push({ url: u, first_pid: imgs.get(u), status: r.status, content_type: r.headers?.['content-type'] || null,
      bytes: r.total ?? (r.truncated ? null : r.bytes), bytes_at_least: r.truncated && r.total == null ? r.bytes : null,
      w: dims?.w ?? null, h: dims?.h ?? null, type: dims?.type ?? null, host: U.hostOf(r.url || u), same_site: U.sameSite(u, origin),
      https: /^https:/i.test(u), redirects: Math.max(0, (r.chain || []).length - 1), error: r.error || null,
      pages: out.items.filter(i => i.og?.image_abs === u).map(i => i.pid) });
  }
}

async function hreflangCheck() {
  // all three sources together; a language with different addresses in different sources is a conflict
  const smSel = out.site.sitemap?.hreflang?.selected || {};
  const all = i => [...(i.hreflang || []).map(h => ({ ...h, source: 'html' })), ...(i.hreflang_header || []), ...(smSel[i.pid] || [])];
  const withAlt = out.items.filter(i => all(i).length).map(i => ({ i, list: all(i) }));
  if (!withAlt.length) { out.site.hreflang = { used: false, sources_checked: ['html', 'header', out.site.sitemap?.hreflang ? 'sitemap' : null].filter(Boolean) }; return; }
  const cache = new Map();
  for (const it of out.items) cache.set(keyOf(it.fetch?.final_url || it.url), { status: it.fetch?.status, hreflang: all(it).map(h => h.href) });
  const targets = uniq(withAlt.flatMap(x => x.list.map(h => h.href)).filter(Boolean)).filter(u => !cache.has(keyOf(u))).slice(0, 10);
  for (const u of targets) {
    if (timeLeft() < 15000) { cutShort(L('hreflang: проверены не все адреса (время)', 'hreflang: cut by time')); break; }
    const r = await getPage(u);
    let hl = [];
    if (r.body) { try { hl = (await tab.parse(r.body, r.url)).hreflang.map(h => h.href); } catch (e) { if (e.code === 'NO_SLOT' || e.code === 'LAUNCH') throw e; } }
    hl.push(...linkHeaderAlternates(r.headers?.link, r.url || u).map(h => h.href), ...(sitemapAlt.get(keyOf(r.url || u)) || []).map(h => h.href));
    cache.set(keyOf(u), { status: r.status, hreflang: hl, final_url: r.url });
  }
  const pages = withAlt.map(({ i, list }) => {
    const self = keyOf(i.fetch?.final_url || i.url);
    const issues = [];
    if (!list.some(h => keyOf(h.href) === self)) issues.push('no_self');
    if (!list.some(h => h.lang.toLowerCase() === 'x-default')) issues.push('no_x_default');
    const byLang = {}; for (const h of list) (byLang[h.lang.toLowerCase()] ||= new Set()).add(keyOf(h.href));
    for (const [lg, set] of Object.entries(byLang)) if (set.size > 1) issues.push(`conflict:${lg}`); // e.g. HTML and sitemap disagree
    const seen = new Set();
    for (const h of list) {
      const k = h.lang.toLowerCase() + ' ' + keyOf(h.href); if (seen.has(k)) continue; seen.add(k);
      if (!h.valid) issues.push(`bad_code:${h.lang}`); else if (h.suggest) issues.push(`wrong_code:${h.lang}→${h.suggest}`);
      const t = cache.get(keyOf(h.href));
      if (!t) continue;
      if (t.status && t.status !== 200) issues.push(`target_${t.status}:${h.href}`);
      if (keyOf(h.href) !== self && t.hreflang && !t.hreflang.some(x => keyOf(x) === self)) issues.push(`no_return:${h.href}`);
    }
    for (const src of ['html', 'header', 'sitemap']) { // duplicates inside one source
      const langs = list.filter(h => (h.source || 'html') === src).map(h => h.lang.toLowerCase()); const dup = langs.filter((x, k) => langs.indexOf(x) !== k);
      if (dup.length) issues.push(`duplicate:${src}:${uniq(dup).join(',')}`);
    }
    return { pid: i.pid, count: Object.keys(byLang).length, sources: uniq(list.map(h => h.source || 'html')), issues: issues.slice(0, 15) };
  });
  out.site.hreflang = { used: true, pages, targets_checked: targets.length, sources_checked: ['html', 'header', out.site.sitemap?.hreflang ? 'sitemap' : null].filter(Boolean) };
}

async function botsCheck() {
  const had = out.site.bots?.bots || []; // all asked already (or stopped by 429): no new requests, not even the baseline
  if (had.length && (BOTS_AS.every(([n]) => had.some(b => b.bot === n)) || had.some(b => b.verdict === 'rate_limited'))) return;
  const homeItem = out.items.find(i => i.pid === home.pid);
  const url = homeItem?.fetch?.final_url || home.url;
  const base = await getPage(url);
  let bp = null; try { bp = base.body ? await tab.parse(base.body, base.url) : null; } catch {}
  const summ = (p, r) => p ? {
    status: r.status, title: normKey(p.title), h1: p.headings.filter(h => h.level === 1).map(h => normKey(h.text)).sort().join(' | '),
    canonical: p.canonical[0]?.abs ? keyOf(p.canonical[0].abs) : null, robots: [...p.robots, r.headers?.['x-robots-tag'] || ''].join(',').toLowerCase().replace(/\s+/g, ''),
    links: uniq(p.links.filter(l => l.url && U.sameSite(l.url, r.url)).map(l => keyOf(l.url)).filter(Boolean)), text_len: p.text_len,
    og_title: !!(p.og['og:title'] || [])[0], og_image: !!(p.og['og:image'] || [])[0], text: p.text.toLowerCase(),
  } : { status: r.status };
  const b = summ(bp, base);
  const bots = [];
  const prevBots = new Map((out.site.bots?.bots || []).map(b => [b.bot, b])); // a resumed call does not ask again
  const was429 = [...prevBots.values()].some(b => b.verdict === 'rate_limited'); // an earlier call got 429: ask nothing more
  for (const [name, ua] of BOTS_AS) {
    if (prevBots.has(name)) { bots.push(prevBots.get(name)); continue; }
    if (was429) break;
    if (timeLeft() < 10000) { cutShort(L('сравнение с ботами — не хватило времени', 'bot comparison — out of time')); break; }
    const r = await U.politeFetch(url, { ua, lang, timeoutMs: 20000, retries: 0 });
    if (r.status === 429) { bots.push({ bot: name, status: 429, verdict: 'rate_limited' }); addNotChecked(L('сравнение с ботами: сайт ответил 429 — остальные UA не запрашивали', 'bot comparison: 429 — stopped')); break; }
    const rec = { bot: name, status: r.status, final_url: r.url, error: r.error || null, antibot: r.antibot || null };
    const baseBlocked = !bp || base.status !== 200 || !!base.antibot;
    if ((r.status === 403 || r.status === 401 || r.status === 429 || r.status === 503 || r.antibot) && baseBlocked) {
      rec.verdict = 'blocked_for_all'; // the ordinary browser request was refused too: not about bots
    } else if (r.status === 403 || r.status === 401 || r.status === 429 || r.status === 503 || r.antibot) {
      rec.verdict = 'bot_ua_blocked';
      addHuman(L(`${name}: сайт ответил ${r.status}${r.antibot ? ' (' + r.antibot + ')' : ''} на запрос с UA робота с нашего IP. Часто так защита отсекает «поддельных» роботов — проверьте отдачу в ${/^Yandex/.test(name) ? 'Вебмастере (Проверка ответа сервера)' : /^Googlebot/.test(name) ? 'Search Console (Проверка URL)' : 'превью ссылки в мессенджере'}.`,
        `${name}: site answered ${r.status} to the bot UA from our IP; WAFs often block fake bots — verify in ${/^Yandex/.test(name) ? 'Yandex Webmaster' : /^Googlebot/.test(name) ? 'Search Console URL Inspection' : 'a messenger link preview'}.`));
    } else if (r.body) {
      let p = null; try { p = await tab.parse(r.body, r.url); } catch {}
      const s = summ(p, r);
      if (p && bp) {
        const diff = [];
        if (s.title !== b.title) diff.push('title');
        if (s.h1 !== b.h1) diff.push('h1');
        if (s.canonical !== b.canonical) diff.push('canonical');
        if (s.robots !== b.robots) diff.push('robots');
        const jac = Math.round(jaccard(s.links, b.links) * 100) / 100;
        if (jac < 0.9) diff.push('links');
        const dl = b.text_len ? Math.round((s.text_len - b.text_len) / b.text_len * 100) : 0;
        if (Math.abs(dl) > 10) diff.push('text_len');
        const spamBot = SPAM_WORDS.filter(([w]) => (s.text.split(w).length - 1) > (b.text.split(w).length - 1)).map(([w]) => w);
        if (spamBot.length) diff.push('spam_words');
        Object.assign(rec, { diff, links_jaccard: jac, text_len_delta_pct: dl, spam_only_for_bot: spamBot, og_title: s.og_title, og_image: s.og_image,
          verdict: diff.length ? 'differs' : 'same', internal: { md5_equal: U.md5(r.body) === U.md5(base.body || '') } });
      } else rec.verdict = bp ? 'parse_error' : 'no_baseline'; // nothing to compare with
    } else rec.verdict = 'error';
    bots.push(rec);
  }
  out.site.bots = { url, baseline_status: base.status, bots };
}

// ---------- links.json ----------
function collectLinks(pid, parsed, pageUrl) {
  for (const l of parsed.links) {
    if (!l.url || !/^https?:/i.test(l.url)) continue;
    const u = stripHash(l.url); if (!u) continue;
    let it = linkMap.get(u);
    if (!it) { it = { url: u, internal: U.sameSite(u, pageUrl), from: [], status: null }; linkMap.set(u, it); }
    if (it.from.length < 30 && !it.from.some(f => f.pid === pid && f.region === l.region)) it.from.push({ pid, region: l.region, text: it.from.length < 3 ? l.text.slice(0, 60) : undefined });
  }
}

// Link verdicts. External sites often answer robots with 401/403/429/439/451/999 or a challenge page: that is
// «blocked», not «broken». Broken = 404/410, a domain that does not exist, refused connection, 5xx after GET.
const BLOCK_CODES = new Set([401, 403, 407, 418, 429, 439, 451, 999]);
// social networks answer robots with 403/418/429/999 or a 4xx login wall: «closed to robots», not a dead link
const SOCIAL = /(^|\.)(vk\.com|vk\.ru|vkvideo\.ru|ok\.ru|linkedin\.com|instagram\.com|facebook\.com|fb\.com|x\.com|twitter\.com|tiktok\.com|threads\.net|t\.me|telegram\.me|pinterest\.[a-z.]+|dzen\.ru|rutube\.ru|youtube\.com|youtu\.be|wa\.me|whatsapp\.com|max\.ru)$/i;
const nxCache = new Map();
async function hostMissing(h) {
  if (!nxCache.has(h)) nxCache.set(h, lookup(h).then(() => false, e => ['ENOTFOUND', 'ENODATA'].includes(e.code) ? true : null));
  return nxCache.get(h);
}
async function linkVerdict(it, r) {
  const st = r.status;
  if (st >= 200 && st < 300) return ['ok', null];
  if (r.antibot) return ['blocked', 'antibot:' + r.antibot];
  if (!it.internal && SOCIAL.test(U.hostOf(r.url || it.url)) && st >= 400 && st !== 404 && st !== 410) return ['blocked', 'social:' + st];
  if (st === 0) {
    const code = r.error_code || '';
    if (/timeout/i.test(r.error || '')) return ['unreachable', 'timeout'];
    if (await hostMissing(U.hostOf(it.url))) return ['broken', 'nxdomain'];
    if (/ECONNREFUSED/.test(code)) return ['broken', 'refused'];
    return ['unreachable', code || String(r.error || 'error').slice(0, 60)];
  }
  if (st === 404 || st === 410) return ['broken', String(st)];
  if (st >= 500) return [st === 503 && !it.internal ? 'blocked' : 'broken', String(st)];
  if (it.internal) return st === 401 ? ['auth', '401'] : st === 429 ? ['blocked', '429'] : ['broken', String(st)];
  return BLOCK_CODES.has(st) ? ['blocked', String(st)] : ['unclear', String(st)];
}

async function checkLinks() {
  const all = [...linkMap.values()];
  const order = all.sort((a, b) => (b.internal - a.internal) || (b.from.length - a.from.length));
  // up to 20 GETs of internal pages for «not found» answered with 200 are part of the same limit
  const probe = (out.site.soft404 || []).find(s => s.verdict === 'soft404' && (s.title || s.h1?.length));
  const reserve = probe ? Math.min(20, Math.floor(LINKS_MAX / 3)) : 0;
  const cap = LINKS_MAX - reserve;
  const todo = order.slice(0, cap).filter(it => it.status === null && !it.skipped && !it.error && !it.masked);
  if (order.length > cap) addNotChecked(L(`ссылки: ещё ${order.length - cap} адресов не проверяли (лимит ${LINKS_MAX})`, `links: ${order.length - cap} more URLs not checked (limit ${LINKS_MAX})`));
  let stopped = false, started = 0;
  const hits429 = new Map(); // host → 429 answers in this call; the second one stops checks of that host
  // our own per-host gate (2 at a time, like util): a worker waits HERE, so after a 429 it re-checks the counter
  // instead of sitting inside politeFetch with a request that will go out anyway
  const gates = new Map();
  const enter = async h => { const g = gates.get(h) || gates.set(h, { n: 0 }).get(h); while (g.n >= 2) await U.sleep(50); g.n++; return () => { g.n--; }; };
  // after the first 429 a host gets one request at a time, only after its pause and only when nothing is in flight;
  // the counter is read right before sending, so the second 429 is the last request to that host
  const inflight = new Map(), coolTill = new Map();
  const note429 = h => { hits429.set(h, (hits429.get(h) || 0) + 1); coolTill.set(h, Date.now() + 60000); };
  const hostQuiet = async h => {
    while ((hits429.get(h) || 0) === 1 && ((inflight.get(h) || 0) > 0 || (coolTill.get(h) || 0) > Date.now())) {
      if (stopped || timeLeft() < 12000) return false;
      await U.sleep(200);
    }
    return true;
  };
  await U.mapLimit(todo, 6, async it => {
    if (stopped || (started >= 12 && timeLeft() < 12000)) { stopped = true; return; }
    const h0 = U.hostOf(it.url);
    const leave = await enter(h0);
    try { await checkOne(it, h0); } finally { leave(); }
  });
  async function checkOne(it, h0) {
    if (stopped || (started >= 12 && timeLeft() < 12000)) { stopped = true; return; }
    // state-changing links are never requested (util's list plus EXTRA_RISKY); decided before any wait
    if (U.isRiskyGet(it.url) || EXTRA_RISKY(it.url)) { it.skipped = 'skipped_risky'; it.status = 0; it.state = 'skipped'; return; }
    if (!(await hostQuiet(h0))) { stopped = true; return; }
    if ((hits429.get(h0) || 0) >= 2) { it.state = 'not_checked'; it.reason = 'rate_limited'; return; }
    inflight.set(h0, (inflight.get(h0) || 0) + 1); // no await between the checks above and this line
    try { await sendOne(it, h0); } finally { inflight.set(h0, inflight.get(h0) - 1); }
  }
  async function sendOne(it, h0) {
    started++;
    const h = await U.politeFetch(it.url, { method: 'HEAD', lang, timeoutMs: 15000, retries: 0, maxRedirects: 8 });
    let r = h, method = 'HEAD';
    if (h.skipped) { it.skipped = h.skipped === 'risky' ? 'skipped_risky' : 'skipped_private'; it.status = 0; it.state = 'skipped'; return; }
    if (h.status === 429) note429(h0); // politeFetch already paused the host
    // any answer other than 2xx on HEAD gets one GET (many servers mishandle HEAD); never after 429
    if ((!h.status || h.status >= 300) && h.status !== 429 && !/timeout/i.test(h.error || '')) {
      const g = await fetchB(it.url, { maxBytes: 32768, timeoutMs: 15000, maxRedirects: 8, accept: 'text/html,*/*' });
      if (g.skipped) { it.skipped = g.skipped === 'risky' ? 'skipped_risky' : 'skipped_private'; it.status = 0; it.state = 'skipped'; return; }
      if (g.status === 429) { U.coolDownHost(U.hostOf(g.url || it.url)); note429(h0); }
      r = { ...g, antibot: U.detectAntibot(g.status, g.headers, g.buf?.toString('utf8') || '') }; method = 'GET';
    }
    it.status = r.status; it.method = method; it.final_url = r.url; it.redirects = Math.max(0, (r.chain || []).length - 1);
    it.ok = r.status >= 200 && r.status < 300;
    const [state, reason] = await linkVerdict(it, r);
    it.state = state; if (reason) it.reason = reason;
    if (state === 'blocked') it.blocked = reason;
    if (r.error) it.error = String(r.error).slice(0, 120);
  }
  if (stopped) return true;
  const limited = [...hits429.entries()].filter(([, n]) => n >= 2).map(([h]) => h);
  if (limited.length) addNotChecked(L(`ссылки: ${limited.slice(0, 3).join(', ')} ответил 429 дважды — его ссылки дальше не проверяли`, `links: ${limited.slice(0, 3).join(', ')} answered 429 twice — rest not checked`));
  // The site answers 200 for missing pages: a 200 link can still be a dead one. Compare with the soft-404 probe.
  if (probe && reserve) {
    const sigH1 = normKey((probe.h1 || [])[0] || ''), sigTitle = normKey(probe.title || '');
    const doneCount = [...linkMap.values()].filter(it => it.soft404_checked).length;
    const cand = [...linkMap.values()].filter(it => it.internal && it.status === 200 && !it.soft404_checked && !it.masked && !limited.includes(U.hostOf(it.url)))
      .sort((a, b) => b.from.filter(f => f.region === 'main' || f.region === 'body').length - a.from.filter(f => f.region === 'main' || f.region === 'body').length)
      .slice(0, Math.max(0, reserve - doneCount));
    for (const [k, it] of cand.entries()) {
      if (k >= 5 && timeLeft() < 12000) return true;
      const g = await fetchB(it.final_url || it.url, { maxBytes: 600000, timeoutMs: 15000, accept: 'text/html,*/*' });
      it.soft404_checked = true;
      if (g.status === 429) { U.coolDownHost(U.hostOf(g.url || it.url)); addNotChecked(L('повторная проверка «не найдено» у ссылок: сайт ответил 429 — остановили', 'soft-404 recheck of links: 429 — stopped')); break; }
      if (g.status !== 200 || !/html/i.test(g.headers?.['content-type'] || '')) continue;
      try {
        const p = await tab.parse(g.buf.toString('utf8'), g.url);
        const h1 = normKey((p.headings.find(h => h.level === 1)?.text || '').slice(0, 100));
        const same = sigH1 ? h1 === sigH1 && (!sigTitle || normKey(p.title.slice(0, 120)) === sigTitle)
          : normKey(p.title.slice(0, 120)) === sigTitle && Math.abs(p.text_len - (probe.text_len || 0)) <= Math.max(50, (probe.text_len || 0) * 0.15);
        if (same) { it.soft404 = true; it.ok = false; it.state = 'broken'; it.reason = 'soft404'; }
      } catch (e) { if (e.code === 'NO_SLOT') return true; }
    }
  }
  return false;
}

function linksDoc(partial) {
  const items = [...linkMap.values()].sort((a, b) => (b.internal - a.internal) || (b.from.length - a.from.length));
  const checked = items.filter(i => i.status !== null);
  const broken = checked.filter(i => i.state === 'broken' || i.soft404);
  const count = st => checked.filter(i => i.state === st).length;
  // secrets in query strings (unsubscribe tokens, e-mails) never reach the RUN files
  const outItems = items.map(i => {
    const all = i.skipped === 'skipped_risky';
    const u = maskUrl(i.url, all);
    const masked = u !== i.url;
    return { ...i, url: u, ...(i.final_url ? { final_url: maskUrl(i.final_url, all) } : {}), ...(masked ? { masked: true } : {}) };
  });
  return {
    ...U.measureHeader('links', RUN), partial, resume: partial ? { done: [...done] } : null, pages: selected.map(p => p.pid),
    summary: { total: items.length, checked: checked.length, broken_internal: broken.filter(i => i.internal).length, broken_external: broken.filter(i => !i.internal).length,
      redirected_internal: checked.filter(i => i.internal && i.redirects > 0).length, blocked: count('blocked'), unreachable: count('unreachable'),
      unclear: count('unclear'), auth: count('auth'), soft404_internal: checked.filter(i => i.internal && i.soft404).length,
      skipped_risky: items.filter(i => i.skipped === 'skipped_risky').length, skipped_private: items.filter(i => i.skipped === 'skipped_private').length, limit: LINKS_MAX },
    states: { ok: 'ответ 2xx', broken: '404/410, домена нет, отказ соединения, 5xx (внутренние: любой 4xx/5xx, кроме 401 и 429), «не найдено» с кодом 200',
      blocked: 'закрыто для роботов: 401/403/407/418/429/439/451/999, челлендж, 503 у внешних, любой 4xx кроме 404/410 у соцсетей — ссылка может быть рабочей', unreachable: 'тайм-аут или сбой соединения — проверить вручную',
      unclear: 'прочий 4xx у внешней ссылки (400, 405, 406…)', auth: 'внутренняя ссылка требует входа (401)', skipped: 'не открывали: опасный GET или частный адрес' },
    items: outItems, errors: [], not_checked: out.not_checked.filter(x => /ссылки|links/i.test(x)),
  };
}

// ---------- flags (hints for the lens; severity is decided by the lens) ----------
function buildFlags() {
  out.flags = [];
  const items = out.items.filter(i => i.title);
  const by = (fn) => items.filter(fn).map(i => i.pid);
  const p = by(i => i.fetch && i.fetch.status && i.fetch.status !== 200);
  if (p.length) flag('status-not-200', 'high', L(`Код ответа не 200: ${p.length} стр.`, `Non-200 status: ${p.length} pages`), p);
  const ch = by(i => i.fetch?.redirects > 1);
  if (ch.length) flag('redirect-chain', 'medium', L('Цепочка из 2+ редиректов до страницы', '2+ redirects before the page'), ch);
  const nt = by(i => !i.title.len); if (nt.length) flag('title-missing', 'high', L('Нет title', 'No title'), nt);
  const mt = by(i => i.title.count > 1); if (mt.length) flag('title-multiple', 'medium', L('Несколько <title>', 'Several <title>'), mt);
  const ty = by(i => i.title.len && i.title.norms.yandex !== 'ok'); if (ty.length) flag('title-length-yandex', 'low', L(`title вне нормы Яндекса ${NORMS.title.yandex.join('–')} знаков`, `title outside Yandex norm ${NORMS.title.yandex.join('–')}`), ty);
  const tg = by(i => i.title.len && i.title.norms.google !== 'ok'); if (tg.length) flag('title-length-google', 'low', L(`title вне нормы Google ${NORMS.title.google.join('–')} знаков`, `title outside Google norm ${NORMS.title.google.join('–')}`), tg);
  const nd = by(i => i.description.count === 0 || i.description.empty); if (nd.length) flag('description-missing', 'medium', L('Нет description или пустой', 'Missing or empty description'), nd);
  const dy = by(i => i.description.len && i.description.norms.yandex !== 'ok'); if (dy.length) flag('description-length-yandex', 'low', L('description вне нормы Яндекса 120–250 знаков', 'description outside Yandex 120–250'), dy);
  const dg = by(i => i.description.len && i.description.norms.google !== 'ok'); if (dg.length) flag('description-length-google', 'low', L('description вне нормы Google 150–160 знаков', 'description outside Google 150–160'), dg);
  for (const [field, code] of [['title', 'title-duplicate'], ['description', 'description-duplicate']]) {
    const groups = {}; for (const i of items) { const t = normKey(i[field]?.text || ''); if (t) (groups[t] ||= []).push(i.pid); }
    const dups = Object.entries(groups).filter(([, v]) => v.length > 1);
    out.site[`${field}_duplicates`] = dups.map(([t, v]) => ({ text: t.slice(0, 120), pids: v }));
    if (dups.length) flag(code, 'medium', L(`Одинаковый ${field} у разных страниц: ${dups.length} групп`, `Duplicate ${field}: ${dups.length} groups`), dups.flatMap(([, v]) => v));
  }
  const h0 = by(i => i.h1.count === 0); if (h0.length) flag('h1-missing', 'high', L('Нет H1', 'No H1'), h0);
  const h2 = by(i => i.h1.visible_count_hint > 1); if (h2.length) flag('h1-multiple', 'medium', L('Больше одного H1', 'More than one H1'), h2);
  const hj = by(i => i.h1.raw_count === 0 && i.h1.count > 0); if (hj.length) flag('h1-js-only', 'high', L('H1 появляется только после JS (в исходном HTML нет)', 'H1 only after JS'), hj);
  const hl = by(i => i.h1.logo_like > 0); if (hl.length) flag('h1-logo', 'medium', L('H1 — логотип или ссылка на главную', 'H1 is the logo / home link'), hl);
  const hs = by(i => i.headings.skips.length || i.headings.h3_before_h2); if (hs.length) flag('headings-skip', 'low', L('Скачки уровней заголовков (H2→H4, H3 раньше H2)', 'Heading level skips'), hs);
  const hc = by(i => i.headings.cta_like.length); if (hc.length) flag('headings-cta', 'low', L('Кнопки и ссылки размечены заголовками', 'CTAs marked up as headings'), hc);
  const c0 = by(i => i.fetch?.status === 200 && !i.canonical.count); if (c0.length) flag('canonical-missing', 'medium', L('Нет canonical', 'No canonical'), c0);
  const cm = by(i => i.canonical.distinct > 1); if (cm.length) flag('canonical-multiple', 'high', L('Несколько разных canonical', 'Conflicting canonicals'), cm);
  const co = by(i => i.canonical.self === false); if (co.length) flag('canonical-other', 'high', L('canonical ведёт на другую страницу', 'canonical points to another page'), co);
  const cr = by(i => i.canonical.absolute === false); if (cr.length) flag('canonical-relative', 'low', L('canonical относительный', 'relative canonical'), cr);
  const cx = by(i => i.canonical.self !== false && (i.canonical.protocol_mismatch || i.canonical.host_mismatch));
  if (cx.length) flag('canonical-protocol-host', 'medium', L('canonical ведёт на ту же страницу, но с другим протоколом или хостом (http/https, www)', 'canonical points to the same page on another protocol or host'), cx);
  const cj = by(i => i.canonical.differs_raw_dom); if (cj.length) flag('canonical-js-changed', 'medium', L('canonical в исходном HTML и после JS разный', 'canonical changed by JS'), cj);
  const ni = by(i => i.robots.noindex); if (ni.length) flag('noindex', 'high', L('Страница закрыта noindex для всех поисковиков (meta или X-Robots-Tag)', 'Page has noindex for all engines'), ni);
  const ng = by(i => !i.robots.noindex && i.robots.noindex_by?.google && !i.robots.noindex_by?.yandex);
  if (ng.length) flag('noindex-google-only', 'medium', L('noindex только для Google (googlebot в meta или X-Robots-Tag), Яндекс страницу индексирует', 'noindex for Google only'), ng);
  const ny = by(i => !i.robots.noindex && i.robots.noindex_by?.yandex && !i.robots.noindex_by?.google);
  if (ny.length) flag('noindex-yandex-only', 'medium', L('noindex только для Яндекса (meta name="yandex" или X-Robots-Tag), Google страницу индексирует', 'noindex for Yandex only'), ny);
  const nj = by(i => i.robots.noindex_only_in_js); if (nj.length) flag('noindex-js', 'medium', L('noindex добавляется скриптом', 'noindex added by JS'), nj);
  const lm = by(i => !i.lang.value); if (lm.length) flag('lang-missing', 'medium', L('Нет атрибута lang у <html>', 'No <html lang>'), lm);
  const lx = by(i => i.lang.mismatch); if (lx.length) flag('lang-mismatch', 'medium', L('lang не совпадает с языком текста', 'lang does not match text'), lx);
  const om = by(i => i.og.missing.length); if (om.length) flag('og-incomplete', 'medium', L('Неполная OG-разметка (title/description/image/url/type)', 'Incomplete Open Graph'), om);
  const or = by(i => i.og.image_relative); if (or.length) flag('og-image-relative', 'medium', L('og:image задан относительным адресом', 'Relative og:image'), or);
  for (const im of out.site.og_images || []) {
    const bad = []; const broken = im.status !== 200;
    if (broken) bad.push(`${L('код', 'status')} ${im.status}`);
    if (im.w && im.h && (im.w < 1200 || im.h < 630)) bad.push(`${im.w}×${im.h} < 1200×630`);
    const bytes = im.bytes ?? im.bytes_at_least;
    if (bytes && bytes > 300 * 1024) bad.push(`${U.fmtBytes(bytes)} > 300 ${L('КБ', 'KB')}`);
    if (im.content_type && !/^image\//.test(im.content_type)) bad.push(im.content_type);
    if (bad.length) flag('og-image-bad', broken ? 'high' : 'low', `og:image ${im.url.slice(0, 80)}: ${bad.join(', ')}`, im.pages);
  }
  const jp = by(i => i.jsonld.parse_errors.length); if (jp.length) flag('jsonld-parse-error', 'high', L('JSON-LD не разбирается (JSON.parse)', 'JSON-LD does not parse'), jp);
  const req = i => i.jsonld.issues.filter(x => x.level === 'required');
  const jr = by(i => req(i).length);
  if (jr.length) {
    const eng = uniq(items.flatMap(i => req(i).flatMap(x => x.engines || [])));
    flag('jsonld-fields-missing', 'medium', L(`В JSON-LD нет обязательных полей (${eng.map(e => e === 'yandex' ? 'по справке Яндекса' : 'по справке Google').join(', ')})`, `JSON-LD required fields missing (${eng.join(', ')})`), jr,
      { sample: items.flatMap(i => req(i).map(x => `${i.pid}: ${x.type}.${x.field} [${(x.engines || []).join(',')}]`)).slice(0, 8) });
  }
  const sr = by(i => i.jsonld.self_rating?.length); if (sr.length) flag('jsonld-self-rating', 'low', L('Рейтинг или отзывы организации о себе в JSON-LD: Google не показывает такие звёзды', 'Self-serving rating in JSON-LD (not eligible for stars in Google)'), sr);
  const jf = by(i => i.jsonld.notes?.includes('faq_google_retired')); if (jf.length) flag('jsonld-faq-retired', 'info', L('FAQPage: Google не показывает FAQ-сниппеты с 07.05.2026 — разметка не даст расширенного сниппета в Google', 'FAQPage: Google no longer shows FAQ rich results'), jf);
  const jm = by(i => i.jsonld.mismatches.length); if (jm.length) flag('jsonld-mismatch', 'high', L('JSON-LD расходится с видимым текстом (цены, телефон, адрес, рейтинг, FAQ, крошки)', 'JSON-LD differs from visible text'), jm);
  const jj = by(i => i.jsonld.only_in_js); if (jj.length) flag('jsonld-js-only', 'low', L('JSON-LD только после JS', 'JSON-LD only after JS'), jj);
  const al = by(i => i.images.no_alt > 0); if (al.length) flag('alt-missing', 'medium', L('Картинки без атрибута alt', 'Images without alt'), al);
  const aj = by(i => i.images.junk_alt > 0); if (aj.length) flag('alt-junk', 'low', L('alt — имя файла или «фото»', 'Junk alt'), aj);
  const ga = by(i => Object.values(i.links.generic_anchors).some(n => n >= 2)); if (ga.length) flag('generic-anchors', 'low', L('Одинаковые ссылки «Подробнее» ×2+', 'Generic anchors ×2+'), ga);
  const rl = by(i => i.links.relative_no_slash.length); if (rl.length) flag('relative-links', 'medium', L('Ссылки без начального «/» (относительные)', 'Relative links without leading slash'), rl);
  const ba = by(i => i.links.broken_anchors.length); if (ba.length) flag('broken-anchors', 'low', L('Якоря на несуществующие id', 'Anchors to missing ids'), ba);
  const js = by(i => i.text.js_only); if (js.length) flag('js-only-content', 'high', L('Без JS страница почти пустая: в исходном HTML < 20 % текста или < 300 знаков основного текста', 'Page is nearly empty without JS'), js);
  const ja = by(i => i.text.js_added > 0); if (ja.length) flag('js-added-content', 'low', L('Часть текста добавляет JS (виджеты, отзывы, переводы), основной текст есть в HTML', 'JS adds some text; main text is in HTML'), ja, { chars: Object.fromEntries(items.filter(i => i.text.js_added > 0).map(i => [i.pid, i.text.js_added])) });
  const tj = by(i => i.title.changed_by_js); if (tj.length) flag('title-js-changed', 'low', L('title в исходном HTML и после JS разный (робот без JS видит первый)', 'title changed by JS'), tj);
  const pl = by(i => i.links.param_links?.pagination || i.links.param_links?.sort || i.links.param_links?.filter);
  if (pl.length) flag('param-links', 'info', L('Внутренние ссылки с параметрами (пагинация, сортировка, фильтры) — нужны canonical/Clean-param', 'Internal links with parameters (pagination, sort, filters)'), pl);
  const sp = by(i => i.spam.some(s => !s.context_dependent)); if (sp.length) flag('spam-words', 'high', L('Спам-слова в тексте (казино, ставки, viagra…) — проверить на взлом', 'Spam words in text'), sp);
  const mk = by(i => i.meta_keywords); if (mk.length) flag('meta-keywords', 'info', L('Есть meta keywords (поисковики не учитывают)', 'meta keywords present'), mk);
  const uf = by(i => i.url_format && (i.url_format.cyrillic || i.url_format.uppercase || i.url_format.underscore)); if (uf.length) flag('url-format', 'low', L('Адрес с кириллицей, заглавными или «_»', 'URL with Cyrillic/uppercase/underscore'), uf);
  const tp = by(i => i.links.tracking_params.length); if (tp.length) flag('internal-utm', 'medium', L('Внутренние ссылки с utm/yclid/from', 'Internal links with tracking params'), tp);
  // site-wide
  const s = out.site;
  if (s.https === false && !hostIsLocal(siteHost)) flag('no-https', 'high', L('Сайт открывается по http:// без https://', 'Site served over http:// only'));
  if (s.http_to_https && s.http_to_https.status !== undefined) {
    const h = s.http_to_https;
    if (!h.final_https) flag('http-no-https-redirect', 'high', L('http:// не переводит на https://', 'http:// does not redirect to https://'));
    else if (!h.permanent || h.hops > 1) flag('http-redirect-weak', 'medium', L(`http→https: код ${h.status}, шагов ${h.hops}`, `http→https: ${h.status}, ${h.hops} hops`));
  }
  if (s.www?.resolves) { if (!s.www.to_main && s.www.status === 200 && !s.www.canonical_to_main) flag('www-duplicate', 'high', L(`${s.www.host} отдаёт 200 без перевода на основной адрес`, `${s.www.host} serves 200 without redirect`)); else if (s.www.to_main && !s.www.permanent) flag('www-redirect-temp', 'low', L(`${s.www.host} → основной: код ${s.www.status}, нужен 301`, `${s.www.host} redirect is ${s.www.status}`)); }
  for (const v of s.url_variants || []) if (v.duplicate) flag(`duplicate-${v.kind}`, 'medium', L(`${v.url} отдаёт ту же страницу с кодом 200 без редиректа и без canonical на основной адрес`, `${v.url} is a 200 copy of the page`));
  for (const sf of s.soft404 || []) {
    if (sf.verdict === 'soft404' || sf.verdict === 'redirect_to_200') flag('soft-404', 'high', L(`Несуществующий адрес отдаёт ${sf.status}${sf.redirects ? ' после редиректа' : ''}${sf.same_as_home ? ' и показывает главную' : ''}: ${sf.url}`, `Missing URL answers ${sf.status}: ${sf.url}`));
    else if (sf.verdict === 'ok' && sf.own_template === false) flag('404-bare', 'low', L('Страница 404 без своего шаблона (нет H1 или ссылок на разделы)', '404 page without own template'));
  }
  if (s.robots?.missing) flag('robots-missing', 'medium', L(`robots.txt не найден (код ${s.robots.status})`, `robots.txt missing (${s.robots.status})`));
  if (s.robots && !s.robots.missing) {
    if (s.robots.disallow_all?.['*'] || s.robots.disallow_all?.yandex || s.robots.disallow_all?.google) flag('robots-disallow-all', 'high', L('robots.txt закрывает весь сайт (Disallow: /)', 'robots.txt disallows everything'));
    if (!s.robots.sitemaps?.length) flag('robots-no-sitemap', 'low', L('В robots.txt нет строки Sitemap', 'No Sitemap line in robots.txt'));
    if (market === 'ru' && !s.robots.clean_param_covers?.utm) flag('robots-no-clean-param', 'low', L('Нет Clean-param для utm/yclid (Яндекс)', 'No Clean-param for utm (Yandex)'));
    if (s.robots.resources_blocked?.length) flag('robots-blocks-resources', 'medium', L('robots.txt закрывает CSS/JS, которые нужны для отрисовки', 'robots.txt blocks CSS/JS'), [], { sample: s.robots.resources_blocked.slice(0, 5) });
    if (s.robots.selected_blocked?.length) flag('robots-blocks-pages', 'high', L('Выбранные страницы закрыты в robots.txt', 'Selected pages disallowed'), s.robots.selected_blocked.map(x => x.pid));
    const nb = out.items.filter(i => i.robots.noindex && s.robots.selected_blocked?.some(x => x.pid === i.pid)).map(i => i.pid);
    if (nb.length) flag('noindex-behind-disallow', 'medium', L('noindex за Disallow: робот его не прочитает', 'noindex behind Disallow'), nb);
  }
  if (s.sitemap?.missing) flag('sitemap-missing', 'medium', L('sitemap.xml не найден', 'No sitemap'));
  if (s.sitemap && !s.sitemap.missing) {
    if (s.sitemap.sample_bad) flag('sitemap-bad-urls', 'medium', L(`В sitemap адреса с кодом ≠ 200 или редиректом: ${s.sitemap.sample_bad} из ${s.sitemap.sample.length} выборки`, `Sitemap URLs not 200: ${s.sitemap.sample_bad}/${s.sitemap.sample.length}`));
    if (s.sitemap.lastmod?.most_common && s.sitemap.lastmod.with_lastmod > 10 && s.sitemap.lastmod.most_common.share >= 90) flag('sitemap-lastmod-same', 'low', L(`lastmod одинаковый у ${s.sitemap.lastmod.most_common.share} % адресов`, `Same lastmod for ${s.sitemap.lastmod.most_common.share}%`));
    if (s.sitemap.selected_missing?.length) flag('sitemap-missing-pages', 'medium', L('Индексируемые страницы не в sitemap', 'Indexable pages missing from sitemap'), s.sitemap.selected_missing.map(x => x.pid));
    if (s.sitemap.selected_noindex_listed?.length) flag('sitemap-noindex', 'medium', L('В sitemap страницы с noindex', 'noindex pages in sitemap'), s.sitemap.selected_noindex_listed);
    if (s.sitemap.foreign_host_or_protocol?.count) flag('sitemap-foreign', 'medium', L(`В sitemap адреса с другим хостом/протоколом: ${s.sitemap.foreign_host_or_protocol.count}`, `Sitemap URLs with other host/protocol: ${s.sitemap.foreign_host_or_protocol.count}`));
    if (s.sitemap.lastmod?.future) flag('sitemap-lastmod-future', 'low', L(`lastmod в будущем: ${s.sitemap.lastmod.future} адр.`, `lastmod in the future: ${s.sitemap.lastmod.future}`));
    if (s.sitemap.first?.html_instead) flag('sitemap-html', 'medium', L(`${s.sitemap.first.url} отдаёт HTML вместо XML`, `${s.sitemap.first.url} returns HTML, not XML`));
    if (s.sitemap.with_params) flag('sitemap-params', 'low', L(`В sitemap адреса с параметрами (?): ${s.sitemap.with_params}`, `Sitemap URLs with parameters: ${s.sitemap.with_params}`));
    if (s.sitemap.too_big?.length) flag('sitemap-too-big', 'medium', L(`Файл sitemap больше 50 000 адресов (предел протокола): ${s.sitemap.too_big.length}`, `Sitemap file over 50,000 URLs: ${s.sitemap.too_big.length}`));
  }
  if (s.icons) {
    if (!s.icons.favicon_ico?.ok && !s.icons.links?.some(i => /\bicon\b/.test(i.rel))) flag('favicon-missing', 'medium', L('Нет favicon (ни ссылки rel=icon, ни /favicon.ico)', 'No favicon'));
    else if (!s.icons.favicon_ico?.ok) flag('favicon-ico-missing', 'low', L(`/favicon.ico не отдаёт картинку (код ${s.icons.favicon_ico?.status}${s.icons.favicon_ico?.html_instead ? ', вместо картинки HTML' : ''})`, '/favicon.ico is not an image'));
    const nm = s.icons.norms;
    if (nm && nm.yandex !== 'ok' && nm.yandex !== 'missing') flag('favicon-yandex-norm', 'low', L(`Фавикон для Яндекса: нет SVG и нет 120×120 (самая крупная ${nm.best_square_px || '?'} px)`, 'Favicon below Yandex recommendation (SVG or 120×120)'));
    if (nm?.yandex_redirect) flag('favicon-redirect', 'low', L('Фавикон отдаётся через редирект — Вебмастер Яндекса считает это ошибкой', 'Favicon served via redirect'));
    if (nm && (nm.google === 'small' || nm.google === 'svg_only')) flag('favicon-google-norm', 'low', nm.google === 'svg_only' ? L('Фавикон только SVG: в списке форматов Google SVG нет, нужна растровая копия (квадрат от 48 px)', 'SVG-only favicon: add a raster one for Google') : L(`Фавикон меньше 48×48 (рекомендация Google): ${nm.google_best_px} px`, `Favicon smaller than 48×48: ${nm.google_best_px}px`));
    if (!s.icons.apple_touch?.ok) flag('apple-touch-missing', 'low', L('Нет apple-touch-icon', 'No apple-touch-icon'));
    else if (s.icons.apple_touch.dims?.w && s.icons.apple_touch.dims.w < 180) flag('apple-touch-small', 'low', L(`apple-touch-icon ${s.icons.apple_touch.dims.w}×${s.icons.apple_touch.dims.h} < 180×180`, 'apple-touch-icon < 180'));
    if (!s.icons.manifest) flag('manifest-missing', 'info', L('Нет manifest', 'No manifest'));
  }
  const hp = (s.hreflang?.pages || []).filter(p => p.issues.length);
  if (hp.length) flag('hreflang-issues', hp.some(p => p.issues.some(x => /^(no_return|target_|conflict|bad_code)/.test(x))) ? 'medium' : 'low',
    L(`hreflang с ошибками (HTML, заголовок Link, sitemap): ${uniq(hp.flatMap(p => p.issues.map(x => x.split(':')[0]))).join(', ')}`, `hreflang issues: ${uniq(hp.flatMap(p => p.issues.map(x => x.split(':')[0]))).join(', ')}`), hp.map(p => p.pid));
  if (s.verification && !s.verification.yandex && !s.verification.google) flag('verification-missing', 'info', L('Нет meta-подтверждений Вебмастера/Search Console на главной (могут быть подтверждены иначе)', 'No webmaster verification meta on home'));
  if (s.orphans?.length) flag('orphans-main', 'medium', L('Страницы без ссылок из основного контента других выбранных страниц', 'Pages without links from main content of other pages'), s.orphans);
  for (const b of s.bots?.bots || []) if (b.verdict === 'differs') flag('bot-differs', b.diff.includes('spam_words') ? 'high' : 'medium', L(`${b.bot}: отдача отличается (${b.diff.join(', ')})`, `${b.bot}: response differs (${b.diff.join(', ')})`), [home.pid]);
  const lk = out.links_summary;
  if (lk?.broken_internal) flag('broken-internal-links', 'high', L(`Битые внутренние ссылки: ${lk.broken_internal}${lk.soft404_internal ? `, из них ${lk.soft404_internal} отдают «не найдено» с кодом 200` : ''}`, `Broken internal links: ${lk.broken_internal}${lk.soft404_internal ? ` (${lk.soft404_internal} soft-404)` : ''}`));
  if (lk?.broken_external) flag('broken-external-links', 'low', L(`Битые внешние ссылки (404/410, домена нет, 5xx): ${lk.broken_external}`, `Broken external links (404/410, no domain, 5xx): ${lk.broken_external}`));
  if (lk?.blocked) flag('links-blocked', 'info', L(`Ссылки, закрытые для роботов (защита сайта, соцсети: 401/403/418/429/439/999, челлендж) — не битые, проверить вручную: ${lk.blocked}`, `Links closed to robots (anti-bot, social networks) — not broken: ${lk.blocked}`));
}

// ---------- write ----------
function writeAll(partial) {
  out.generated = U.nowIso();
  out.partial = partial;
  out.resume = partial ? { done: [...done] } : null;
  out.pages = selected.map(p => p.pid);
  const ld = linksDoc(partial && !done.has('links'));
  out.links_summary = ld.summary;
  buildFlags();
  const lv = { high: 0, medium: 0, low: 0, info: 0 }; for (const f of out.flags) lv[f.level] = (lv[f.level] || 0) + 1;
  out.summary = { pages: out.items.length, flags: lv, links: ld.summary, market };
  for (const it of out.items) delete it._text;
  U.writeJSON(OUT, Object.fromEntries(Object.entries(out).filter(([k]) => !k.startsWith('_'))));
  U.writeJSON(OUT_LINKS, ld); // always: pipeline checks that the file exists (an empty list is a valid answer)
}

function summaryLines(partial) {
  const it = out.items;
  const n = f => it.filter(f).length;
  const s = out.site;
  const codes = {}; for (const i of it) { const c = i.fetch?.status ?? '—'; codes[c] = (codes[c] || 0) + 1; }
  const lines = [];
  lines.push(`SEO · ${siteHost} · ${L('страниц', 'pages')} ${it.length}/${selected.length}${partial ? L(' · ЧАСТИЧНО', ' · PARTIAL') : ''}`);
  lines.push(`${L('Коды', 'Codes')}: ${Object.entries(codes).map(([k, v]) => `${k} ×${v}`).join(', ')}; ${L('цепочек 2+ редиректов', 'chains 2+')}: ${n(i => i.fetch?.redirects > 1)}`);
  const wt = it.filter(i => i.title);
  lines.push(`title: ${L('нет', 'missing')} ${n(i => i.title && !i.title.len)}, ${L('вне нормы Яндекса', 'off Yandex norm')} ${n(i => i.title?.len && i.title.norms.yandex !== 'ok')}/${wt.length}, Google ${n(i => i.title?.len && i.title.norms.google !== 'ok')}/${wt.length}, ${L('групп дублей', 'dup groups')} ${(s.title_duplicates || []).length}`);
  lines.push(`description: ${L('нет/пустой', 'missing/empty')} ${n(i => i.description && (i.description.count === 0 || i.description.empty))}, ${L('вне нормы Яндекса', 'off Yandex')} ${n(i => i.description?.len && i.description.norms.yandex !== 'ok')}, Google ${n(i => i.description?.len && i.description.norms.google !== 'ok')}, ${L('групп дублей', 'dup groups')} ${(s.description_duplicates || []).length}`);
  lines.push(`H1: ${L('нет', 'none')} ${n(i => i.h1 && i.h1.count === 0)}, ${L('больше одного', 'several')} ${n(i => i.h1?.visible_count_hint > 1)}, ${L('только после JS', 'JS only')} ${n(i => i.h1?.raw_count === 0 && i.h1.count > 0)}; ${L('скачки уровней', 'level skips')} ${n(i => i.headings?.skips.length)}`);
  lines.push(`canonical: ${L('нет', 'none')} ${n(i => i.canonical && !i.canonical.count)}, ${L('на другую', 'other')} ${n(i => i.canonical?.self === false)}, ${L('несколько', 'several')} ${n(i => i.canonical?.distinct > 1)}; noindex: ${it.filter(i => i.robots?.noindex).map(i => i.pid).join(', ') || '0'}`);
  if (s.robots) lines.push(`robots.txt: ${s.robots.status}${s.robots.missing ? '' : `, Sitemap ${s.robots.sitemaps?.length ? L('есть', 'yes') : L('нет', 'no')}, Clean-param ${s.robots.clean_param?.length ? L('есть', 'yes') : L('нет', 'no')}, ${L('ИИ-боты закрыты', 'AI bots blocked')}: ${(s.robots.ai_bots || []).filter(b => !b.root_allowed && !/^YandexAdditional/.test(b.bot)).length}/${AI_BOTS.filter(b => !/^YandexAdditional/.test(b.bot)).length}; ${L('ответы Яндекса с нейросетью (YandexAdditional)', 'Yandex AI answers (YandexAdditional)')}: ${s.robots.yandex_ai?.blocked ? L('закрыты', 'blocked') : L('открыты', 'allowed')}${s.robots.yandex_ai?.explicit ? '' : L(' (своей группы нет)', ' (no own group)')}`}`);
  if (s.sitemap) lines.push(s.sitemap.missing ? L('sitemap: не найден', 'sitemap: not found') : `sitemap: ${L('файлов', 'files')} ${s.sitemap.files?.length || 0}, ${L('адресов', 'URLs')} ${s.sitemap.urls_total ?? '—'}, ${L('выборка', 'sample')} ${s.sitemap.sample?.length || 0}: ${L('плохих', 'bad')} ${s.sitemap.sample_bad ?? 0}; ${L('нет в sitemap из выбранных', 'selected missing')} ${s.sitemap.selected_missing?.length || 0}`);
  for (const sf of s.soft404 || []) lines.push(`soft-404: ${sf.verdict} (${L('код', 'code')} ${sf.status}${sf.same_as_home ? L(', как главная', ', same as home') : sf.says_not_found ? L(', текст «не найдено»', ', says «not found»') : ''}${sf.h1?.length ? ', H1 «' + sf.h1[0].slice(0, 40) + '»' : ''})`);
  if (s.http_to_https?.status !== undefined) lines.push(`http→https: ${s.http_to_https.status} ${L('за', 'in')} ${s.http_to_https.hops} ${L('шаг.', 'hops')}${s.www ? `; ${s.www.host}: ${s.www.resolves === false ? L('не резолвится', 'no DNS') : s.www.status + (s.www.to_main ? ' → ' + L('основной', 'main') : '')}` : ''}`);
  if (s.url_variants?.length) lines.push(`${L('Варианты адресов', 'URL variants')}: ${s.url_variants.map(v => `${v.kind} ${v.status}${v.duplicate ? L(' (дубль)', ' (dup)') : ''}`).join(', ')}`);
  lines.push(`JSON-LD: ${L('блоков', 'blocks')} ${it.reduce((a, i) => a + (i.jsonld?.blocks || 0), 0)}, ${L('ошибок разбора', 'parse errors')} ${it.reduce((a, i) => a + (i.jsonld?.parse_errors.length || 0), 0)}, ${L('нет полей', 'missing fields')} ${it.reduce((a, i) => a + (i.jsonld?.issues.length || 0), 0)}, ${L('расхождений с текстом', 'text mismatches')} ${it.reduce((a, i) => a + (i.jsonld?.mismatches.length || 0), 0)}`);
  const ogi = (s.og_images || [])[0];
  lines.push(`OG: ${L('неполная на', 'incomplete on')} ${n(i => i.og?.missing.length)} ${L('стр.', 'pages')}${ogi ? `; og:image ${ogi.w || '?'}×${ogi.h || '?'}, ${U.fmtBytes(ogi.bytes ?? ogi.bytes_at_least)}, ${L('код', 'code')} ${ogi.status}` : ''}`);
  lines.push(`alt: ${L('без alt', 'no alt')} ${it.reduce((a, i) => a + (i.images?.no_alt || 0), 0)} ${L('из', 'of')} ${it.reduce((a, i) => a + (i.images?.total || 0), 0)}; ${L('«Подробнее» ×2+ на', 'generic anchors on')} ${n(i => i.links && Object.values(i.links.generic_anchors).some(x => x >= 2))} ${L('стр.', 'pages')}`);
  if (s.hreflang) lines.push(`hreflang: ${s.hreflang.used ? `${L('страниц', 'pages')} ${s.hreflang.pages.length}, ${L('источники', 'sources')} ${uniq(s.hreflang.pages.flatMap(p => p.sources)).join('+')}, ${L('с ошибками', 'with issues')} ${s.hreflang.pages.filter(p => p.issues.length).length}` : L('нет (HTML, Link, sitemap)', 'none (HTML, Link, sitemap)')}`);
  if (s.orphans) lines.push(`${L('Сироты по <main> среди выбранных', 'Orphans by <main>')}: ${s.orphans.length ? s.orphans.join(', ') : '0'}`);
  if (s.icons) lines.push(`${L('Иконки', 'Icons')}: favicon.ico ${s.icons.favicon_ico?.ok ? L('картинка', 'image') : L('нет картинки', 'no image') + ' (' + s.icons.favicon_ico?.status + ')'}, apple-touch ${s.icons.apple_touch?.ok ? (s.icons.apple_touch.dims?.w ? s.icons.apple_touch.dims.w + '×' + s.icons.apple_touch.dims.h : L('есть', 'yes')) : L('нет картинки', 'no image') + ' (' + s.icons.apple_touch?.status + ')'}${s.icons.norms ? `, ${L('норма', 'norm')} ${L('Яндекс', 'Yandex')} ${s.icons.norms.yandex}, Google ${s.icons.norms.google}` : ''}, manifest ${s.icons.manifest ? s.icons.manifest.status : L('нет', 'none')}; llms.txt ${s.llms?.['llms.txt']?.present ? L('есть', 'yes') : L('нет', 'no')}`);
  const lk = out.links_summary;
  if (lk) lines.push(`${L('Ссылки', 'Links')}: ${L('проверено', 'checked')} ${lk.checked}/${lk.total}, ${L('битых внутр.', 'broken int.')} ${lk.broken_internal}, ${L('внешн.', 'ext.')} ${lk.broken_external}, ${L('закрыто для роботов', 'closed to robots')} ${lk.blocked ?? 0}, ${L('нет ответа', 'no answer')} ${lk.unreachable ?? 0}, ${L('с редиректом внутр.', 'redirected int.')} ${lk.redirected_internal}, ${L('пропущено (риск/частный адрес)', 'skipped risky/private')} ${lk.skipped_risky}/${lk.skipped_private}`);
  if (s.bots) lines.push(`${L('Боты', 'Bots')}: ${s.bots.bots.map(b => `${b.bot} ${b.verdict === 'same' ? L('как браузер', 'same') : b.verdict === 'differs' ? L('отличается', 'differs') + ' (' + b.diff.join(',') + ')' : b.verdict === 'bot_ua_blocked' ? b.status + ' → ' + L('проверить вручную', 'check manually') : b.verdict === 'blocked_for_all' ? b.status + L(' (как и браузеру)', ' (same as browser)') : b.verdict === 'no_baseline' ? L('не с чем сравнить', 'no baseline') : b.verdict}`).join('; ')}`);
  lines.push(`${L('Подсказки для линзы', 'Flags')}: high ${out.summary.flags.high}, medium ${out.summary.flags.medium}, low ${out.summary.flags.low}, info ${out.summary.flags.info}`);
  for (const f of out.flags.filter(f => f.level === 'high').slice(0, 8)) lines.push(`  ! ${f.text}${f.where.length ? ' [' + f.where.slice(0, 6).join(', ') + (f.where.length > 6 ? '…' : '') + ']' : ''}`);
  if (out.not_checked.length) lines.push(`${U.msg('not_checked', lang)}: ${out.not_checked.slice(0, 3).join('; ')}`);
  if (out.errors.length) lines.push(`${U.msg('errors', lang)}: ${out.errors.length} (${out.errors.slice(0, 2).map(e => `${e.pid || ''} ${e.error}`.trim()).join('; ').slice(0, 160)})`);
  lines.push(`${U.msg('written', lang)}: ${OUT} · ${OUT_LINKS}`);
  if (partial) lines.push(L('Частичный результат (код 75): повторите тот же вызов — продолжу с места остановки.', 'Partial (exit 75): run the same command again to continue.'));
  return lines.slice(0, 40);
}

function finish(partial) {
  writeAll(partial);
  const lines = summaryLines(partial);
  U.writeText(U.runPath(RUN, 'stdout', 'seo.md'), lines.join('\n') + '\n');
  U.printSummary(lines);
  U.log(RUN, L(`seo.mjs: ${partial ? 'частично' : 'готово'} · ${out.items.length} стр. · подсказок ${out.flags.length}`, `seo.mjs: ${partial ? 'partial' : 'done'} · ${out.items.length} pages · flags ${out.flags.length}`));
}

// ---------- main ----------
let didWork = false; // every invocation makes progress, even with a tiny --budget-sec
let envError = null;
// seo.json after every step: a call killed from outside (Bash timeout) keeps its work and the next call resumes
function checkpoint() { try { writeAll(true); } catch (e) { U.progress('seo: checkpoint failed: ' + e.message); } }
// busy slots → partial (75), the step stays undone; a browser that does not start → environment error (2)
function stepBrowserError(e) {
  if (e.code === 'NO_SLOT') addNotChecked(L('браузер занят другими проверками — повторите вызов', 'browser slots busy — run again'));
  else { envError = e; out.errors.push({ error: L('браузер не запустился: ', 'browser failed to start: ') + String(e.message || e).slice(0, 200) }); }
  return BOTS_ONLY ? finishBots(true) : finish(true);
}

// ---------- --bots-only: the bot comparison alone, merged into the existing seo.json ----------
let botsPartial = false;
function writeBots(partial) {
  botsPartial = partial;
  if (out.site.bots) { if (partial) out.site.bots.partial = true; else delete out.site.bots.partial; }
  if (!partial && out.site.bots) out.not_checked = out.not_checked.filter(x => !BOTS_NOTE.includes(x));
  out.bots_generated = U.nowIso();
  buildFlags(); // pure over out: items and links_summary come from the previous seo.json
  const lv = { high: 0, medium: 0, low: 0, info: 0 }; for (const f of out.flags) lv[f.level] = (lv[f.level] || 0) + 1;
  out.summary = { ...(out.summary || {}), flags: lv };
  U.writeJSON(OUT, Object.fromEntries(Object.entries(out).filter(([k]) => !k.startsWith('_')))); // links.json stays as it is
}
function botsLine() {
  const s = out.site;
  if (!s.bots) return null;
  return `${L('Боты', 'Bots')}: ${s.bots.bots.map(b => `${b.bot} ${b.verdict === 'same' ? L('как браузер', 'same') : b.verdict === 'differs' ? L('отличается', 'differs') + ' (' + b.diff.join(',') + ')' : b.verdict === 'bot_ua_blocked' ? b.status + ' → ' + L('проверить вручную', 'check manually') : b.verdict === 'blocked_for_all' ? b.status + L(' (как и браузеру)', ' (same as browser)') : b.verdict === 'no_baseline' ? L('не с чем сравнить', 'no baseline') : b.verdict}`).join('; ')}`;
}
function finishBots(partial) {
  writeBots(partial);
  const bl = botsLine();
  const lines = [L(`SEO, сравнение с роботами — ${home.url}`, `SEO, bot comparison — ${home.url}`)];
  lines.push(bl || L('Боты: не проверено', 'Bots: not checked'));
  for (const f of out.flags.filter(f => f.code === 'bot-differs').slice(0, 8)) lines.push(`  ${f.level === 'high' ? '!' : '-'} ${f.text}`);
  for (const h of out.human_checks.filter(h => BOTS_AS.some(([n]) => h.startsWith(n + ':'))).slice(0, 8)) lines.push(`  ? ${h.slice(0, 220)}`);
  const nc = out.not_checked.filter(x => /бот|bot/i.test(x) || TRANSIENT.test(x));
  if (nc.length) lines.push(`${U.msg('not_checked', lang)}: ${nc.slice(0, 3).join('; ')}`);
  const be = out.errors.filter(e => e.pid === 'site:bots' || /браузер|browser/i.test(e.error || ''));
  if (be.length) lines.push(`${U.msg('errors', lang)}: ${String(be[be.length - 1].error).slice(0, 160)}`);
  lines.push(`${U.msg('written', lang)}: ${OUT} (site.bots)`);
  if (partial) lines.push(L('Частичный результат (код 75): повторите тот же вызов — продолжу с места остановки.', 'Partial (exit 75): run the same command again to continue.'));
  U.writeText(U.runPath(RUN, 'stdout', 'seo-bots.md'), lines.join('\n') + '\n');
  // the main summary keeps one up-to-date bots line
  try {
    const mainMd = U.runPath(RUN, 'stdout', 'seo.md');
    if (bl && existsSync(mainMd)) {
      const ml = readFileSync(mainMd, 'utf8').replace(/\n+$/, '').split('\n').filter(l => !/^(Боты|Bots): /.test(l))
        .map(l => (partial ? l : BOTS_NOTE.reduce((acc, n) => acc.replace('; ' + n, '').replace(n + '; ', '').replace(n, ''), l)))
        .filter(l => !/^[^:]{3,20}:\s*$/.test(l));
      const at = ml.findIndex(l => /^(Подсказки для линзы|Flags): /.test(l));
      const fl = out.summary.flags;
      if (at >= 0) ml[at] = `${L('Подсказки для линзы', 'Flags')}: high ${fl.high}, medium ${fl.medium}, low ${fl.low}, info ${fl.info}`;
      ml.splice(at >= 0 ? at : ml.length, 0, bl);
      U.writeText(mainMd, ml.slice(0, 40).join('\n') + '\n');
    }
  } catch (e) { U.progress('seo: seo.md update failed: ' + e.message); }
  U.printSummary(lines.slice(0, 40));
  U.log(RUN, L(`seo.mjs --bots-only: ${partial ? 'частично' : 'готово'} · UA ${out.site.bots?.bots?.length || 0}/${BOTS_AS.length}`, `seo.mjs --bots-only: ${partial ? 'partial' : 'done'} · UA ${out.site.bots?.bots?.length || 0}/${BOTS_AS.length}`));
}
async function mainBots() {
  U.log(RUN, L(`seo.mjs --bots-only: старт · бюджет ${budgetSec} с`, `seo.mjs --bots-only: start · budget ${budgetSec} s`));
  cutNote = null;
  try { await botsCheck(); }
  catch (e) {
    if (e.code === 'NO_SLOT' || e.code === 'LAUNCH') return stepBrowserError(e);
    out.errors.push({ pid: 'site:bots', error: String(e.message || e).slice(0, 300) });
  }
  await tab.close();
  if (cutNote) { addNotChecked(cutNote); cutNote = null; return finishBots(true); }
  return finishBots(false);
}
async function main() {
  U.log(RUN, L(`seo.mjs: старт · ${selected.length} стр. · бюджет ${budgetSec} с${resuming ? ' · продолжение' : ''}`, `seo.mjs: start · ${selected.length} pages · budget ${budgetSec} s${resuming ? ' · resume' : ''}`));
  // HTML is parsed only in the browser: take the slot first, so we never lose half-done steps on a busy machine
  const pagesLeft = selected.some(p => !done.has('page:' + p.pid));
  if (pagesLeft || !done.has('site:basic')) {
    try { await tab.open(); } catch (e) { return stepBrowserError(e); }
  }
  let homeParsed = null;
  // 1) pages
  for (const page of selected) {
    const key = 'page:' + page.pid;
    if (done.has(key)) continue;
    const needMs = snapshotFile(page.pid, 'dom.html') ? 15000 : 50000; // no dom.html → we render the page ourselves
    if (didWork && timeLeft() < needMs) return finish(true);
    U.progress(`seo: ${page.pid} ${page.url}`);
    if (page.blocked) { out.errors.push({ pid: page.pid, error: `blocked: ${page.blocked}` }); done.add(key); continue; }
    try {
      const r = await getPage(page.url);
      let rawHtml = r.body;
      if ((!rawHtml || r.antibot) && snapshotFile(page.pid, 'raw.html')) rawHtml = readText(snapshotFile(page.pid, 'raw.html'));
      const raw = rawHtml ? await tab.parse(rawHtml, r.url || page.url) : null;
      let dom = null;
      const domFile = snapshotFile(page.pid, 'dom.html');
      if (domFile) { dom = await tab.parse(readText(domFile), r.url || page.url); dom.__source = 'snapshot'; }
      else if (r.status === 200 && !r.antibot) {
        const rr = await tab.renderHtml(page.url);
        if (rr.html) { dom = await tab.parse(rr.html, r.url || page.url); dom.__source = 'render'; }
        else out.errors.push({ pid: page.pid, error: 'render: ' + rr.error });
      }
      const tm = snapshotFile(page.pid, 'text.md');
      const visible = tm ? visibleFromTextMd(readText(tm)) : null;
      const item = analyzePage(page, r, raw, dom, visible);
      if (r.truncated) item.fetch.truncated = true;
      const pt = (dom || raw)?.text?.slice(0, 20000);
      if (pt) pageText.set(page.pid, pt);
      if (page.pid === home.pid) homeParsed = dom || raw;
      if (r.antibot) out.errors.push({ pid: page.pid, error: 'antibot: ' + r.antibot });
      const idx = out.items.findIndex(i => i.pid === page.pid);
      if (idx >= 0) out.items[idx] = item; else out.items.push(item);
      const linkSource = dom || raw;
      if (linkSource) collectLinks(page.pid, linkSource, r.url || page.url);
      if (page.pid === home.pid && linkSource) {
        out.site.verification = linkSource.verification;
        out.site.home_resources = { scripts: linkSource.scripts.length, styles: linkSource.styles.length };
        // kept in seo.json: a resumed call needs them without parsing the home page again (no browser, no slot wait)
        out.site.home_head = { icons: linkSource.icons || [], theme_color: linkSource.theme_color ?? null };
        out.site.home_res = [...linkSource.scripts, ...linkSource.styles].filter(u => U.sameSite(u, origin)).map(u => u.replace(/\?.*$/, '')).slice(0, 80);
      }
    } catch (e) {
      if (e.code === 'NO_SLOT' || e.code === 'LAUNCH') return stepBrowserError(e);
      out.errors.push({ pid: page.pid, error: String(e.message || e).slice(0, 300) });
    }
    done.add(key); didWork = true;
    checkpoint();
  }
  if (!homeParsed && out.site.home_head) homeParsed = out.site.home_head; // resumed call: icons from the saved home head
  out._homeRes = out.site.home_res || [];
  // 2) site-level
  const steps = [
    ['site:basic', siteChecks, 40000],
    ['site:robots', async () => {
      const parsed = await robotsCheck();
      out._robotsParsed = parsed;
      if (parsed && out._homeRes) out.site.robots.resources_blocked = out._homeRes.filter(u => !U.robotsAllows(parsed, u, 'Googlebot') || !U.robotsAllows(parsed, u, 'YandexBot')).slice(0, 20);
    }],
    ['site:sitemap', async () => { if (!out._robotsParsed && !done.has('site:robots')) out._robotsParsed = await robotsCheck(); await sitemapCheck(out._robotsParsed || (out.site.robots?.sitemaps ? { sitemaps: out.site.robots.sitemaps } : null)); }, 60000],
    ['site:icons', () => iconsCheck(homeParsed)],
    ['site:llms', llmsCheck],
    ['site:og', ogImageCheck],
    ['site:hreflang', hreflangCheck],
  ];
  if (args['as-bot']) steps.push(['site:bots', botsCheck]);
  // steps that parse HTML keep the browser; the others free the machine-wide slot (it is taken again on demand)
  const NEEDS_BROWSER = new Set(['site:basic', 'site:hreflang', 'site:bots']);
  for (const [key, fn, minMs = 20000] of steps) {
    if (done.has(key)) continue;
    if (didWork && timeLeft() < minMs) return finish(true);
    if (!NEEDS_BROWSER.has(key)) await tab.close();
    U.progress(`seo: ${key}`);
    cutNote = null;
    try { await fn(); }
    catch (e) {
      if (e.code === 'NO_SLOT' || e.code === 'LAUNCH') return stepBrowserError(e);
      out.errors.push({ pid: key, error: String(e.message || e).slice(0, 300) });
    }
    if (cutNote) { if (didWork) { cutNote = null; return finish(true); } addNotChecked(cutNote); cutNote = null; }
    done.add(key); didWork = true;
    checkpoint();
  }
  await tab.close(); // link checks are plain HEAD/GET; the soft-404 recheck takes a slot again if it needs one
  if (!args['as-bot'] && !done.has('site:bots')) addNotChecked(L(...BOTS_NOTE));
  // orphans among selected (links from main/body of other selected pages)
  {
    const sel = new Map(out.items.filter(i => i.fetch?.status === 200 && i.pid !== home.pid).map(i => [keyOf(i.fetch.final_url || i.url), i.pid]));
    const inbound = new Map([...sel.values()].map(p => [p, { main: 0, nav: 0 }]));
    for (const it of linkMap.values()) {
      const pid = sel.get(keyOf(it.url)); if (!pid) continue;
      for (const f of it.from) { if (f.pid === pid) continue; if (f.region === 'main' || f.region === 'body') inbound.get(pid).main++; else inbound.get(pid).nav++; }
    }
    out.site.orphans = [...inbound.entries()].filter(([, v]) => v.main === 0).map(([p]) => p);
    out.site.inbound = Object.fromEntries(inbound);
  }
  // 3) links
  if (DO_LINKS && !done.has('links')) {
    U.progress(`seo: ${L('проверка ссылок', 'checking links')} (${Math.min(linkMap.size, LINKS_MAX)})`);
    const stopped = await checkLinks();
    if (stopped) return finish(true);
    done.add('links');
  } else if (!DO_LINKS) addNotChecked(L('проверка ссылок выключена (--no-links)', 'link check disabled'));
  delete out._robotsParsed; delete out._homeRes;
  return finish(false);
}

let exitCode = 0;
try {
  if (BOTS_ONLY) { await mainBots(); exitCode = envError ? 2 : botsPartial ? 75 : 0; }
  else { await main(); exitCode = envError ? 2 : out.partial ? 75 : 0; }
  if (envError) console.error('seo.mjs: ' + (envError.message || envError));
} catch (e) {
  console.error('seo.mjs: ' + (e?.stack || e));
  try { out.errors.push({ error: String(e.message || e).slice(0, 300) }); if (BOTS_ONLY) finishBots(true); else finish(true); } catch {}
  exitCode = 1;
} finally {
  await tab.close();
}
// Natural exit: on Windows, process.exit() right after fetch() can abort with a libuv assertion (exit 127).
process.exitCode = exitCode;
setTimeout(() => process.exit(exitCode), 3000).unref();
