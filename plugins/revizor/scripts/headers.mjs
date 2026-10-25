#!/usr/bin/env node
// Revizor — headers.mjs: passive security facts (TLS, HTTP headers, CSP, cookies, libraries, SRI,
// source maps, compression/cache, error page, mixed content, CORS, domains of third-party scripts).
// Active path checks only with --probe AND brief.json limits.probe === true.
// Writes RUN/measure/headers.json and RUN/stdout/headers.md.

import tls from 'node:tls';
import { Resolver } from 'node:dns/promises';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, X509Certificate } from 'node:crypto';
import * as U from './lib/util.mjs';
import { Browser } from './lib/cdp.mjs';

const HELP = `
headers.mjs — пассивная проверка безопасности: TLS (версия, срок, издатель, SAN, цепочка, TLS 1.0/1.1),
HTTP/2 (ALPN), HTTP/3 (alt-svc), заголовки безопасности и разбор CSP (заголовок и <meta http-equiv>),
COOP/CORP, cookies, раскрытие версий, клиентские библиотеки и известные уязвимые версии, SRI у CDN,
source maps по sourceMappingURL, сжатие и кэш по типам, страница ошибки, смешанный контент, CORS у найденных API,
домены сторонних скриптов (зарегистрированы ли — системный DNS; срок — RDAP только при stage=live),
ключи и токены в своих JS сайта (secrets[]: тип, файл, длина, первые 4 знака — значение не сохраняется; публичные
ключи для браузера помечены public), причина недоверия к сертификату (неполная цепочка — проверка по AIA,
неизвестный корневой центр, срок, имя) и сверка с Chromium этой машины.

  node headers.mjs --run "<RUN>" [--pages home,p01,p02] [--max-pages 3] [--probe] [--stage live|beta|prototype]
                   [--url <адрес, если нет pages.json>] [--budget-sec 480] [--lang ru|en]

  --probe   GET 13 служебных путей: /.git/HEAD, /.git/config, /.env, /.DS_Store, /backup.zip, /backup.tar.gz,
            /dump.sql, /phpinfo.php, /server-status, /nginx_status, /.htaccess, /composer.json, /package.json;
            для WordPress ещё /readme.html, /xmlrpc.php, /wp-json/wp/v2/users, для Битрикса /bitrix/admin/.
            Читается не больше 2 КБ ответа: только наличие и размер, содержимое не сохраняется. Работает, только если
            в RUN/brief.json стоит limits.probe = true (навык ставит после подтверждения владельца): в журналах защиты
            это похоже на сканирование.
В браузере открываются главная и ещё 2 страницы (из --pages или pages.json); --max-pages меняет число.
Внешние сервисы — только при stage=live и публичном адресе, каждый вызов записывается в log.md: RDAP (срок
регистрации ≤ 5 незнакомых доменов сторонних скриптов) и dns.google (NS ≤ 5 доменов скриптов, на которые системный
DNS не ответил определённо, например за VPN). Список уязвимых версий встроен, дата сверки — в сводке.
Пишет: measure/headers.json, stdout/headers.md. Код 75 — частичный результат, повторите тот же вызов;
код 2 — браузер не запускается (ошибка окружения). Вызов с --pages перезаписывает measure/headers.json целиком.
`;

const args = U.parseArgs(process.argv.slice(2), { boolean: ['probe', 'help'] });
U.helpAndExit(HELP, args);
const lang = U.langOf(args);
const L = (ru, en) => (lang === 'en' ? en : ru);
// an unknown flag is an error: a flag this version lacks must not silently re-run everything and overwrite headers.json
{
  const KNOWN_FLAGS = new Set(['_', 'run', 'lang', 'help', 'budget-sec', 'pages', 'url', 'stage', 'mode', 'audience', 'probe', 'max-pages']);
  const bad = Object.keys(args).filter(k => !KNOWN_FLAGS.has(k));
  if (bad.length) { console.error(L(`headers.mjs: неизвестные флаги: ${bad.map(k => '--' + k).join(', ')} (см. --help)`, `headers.mjs: unknown flags: ${bad.map(k => '--' + k).join(', ')} (see --help)`)); process.exit(2); }
}
const RUN = U.requireRun(args);
const budgetSec = Math.max(20, Number(args['budget-sec'] ?? 480) || 480);
const deadline = Date.now() + budgetSec * 1000 - Math.min(20000, budgetSec * 100);
const timeLeft = () => deadline - Date.now();
const OUT = U.runPath(RUN, 'measure', 'headers.json');

// ---------- inputs ----------
let pagesJson = U.readJSON(join(RUN, 'pages.json'), null);
const briefJson = U.readJSON(join(RUN, 'brief.json'), null); // the only source of the --probe permission
const briefAny = briefJson || U.readJSON(join(RUN, 'brief.input.json'), null) || {};
const MAX_PAGES = Math.max(1, Number(args['max-pages'] ?? 3) || 3);
let selected;
if (pagesJson) selected = U.loadPages(RUN, U.listArg(args.pages).length ? args : {}).filter(p => !p.blocked);
else if (args.url && args.url !== true) { const u = U.normalizeUrl(args.url); selected = [{ pid: 'home', url: u }]; pagesJson = { final_origin: new URL(u).origin, selected }; }
else { console.error(L('Нет pages.json и не задан --url.', 'No pages.json and no --url given.')); process.exit(2); }
if (!selected.length) { console.error(L('Нет страниц для проверки.', 'No pages to check.')); process.exit(2); }
// headers are the same across a site: home + a couple of other templates is enough (pipeline may pass all 20 pids)
{
  const h = selected.find(p => p.pid === 'home');
  const rest = selected.filter(p => p !== h);
  const seenTpl = new Set();
  const firstOfTemplate = rest.filter(p => { const t = p.template || p.pid; if (seenTpl.has(t)) return false; seenTpl.add(t); return true; });
  const others = rest.filter(p => !firstOfTemplate.includes(p));
  selected = [...(h ? [h] : []), ...firstOfTemplate, ...others].slice(0, MAX_PAGES);
}
const home = selected.find(p => p.pid === 'home') || selected[0];
const origin = pagesJson.final_origin || new URL(home.url).origin;
const host = U.hostOf(origin);
// the reviewed site itself may be local (demo, dev server, *.test): allow it, nothing else private
const isLocal = host === 'localhost' || host.endsWith('.localhost') || U.isPrivateIp(host.replace(/^\[|\]$/g, '')) || await U.resolvesPrivate(host);
if (isLocal) U.allowPrivateHost(host);
const isHttps = origin.startsWith('https:');
const tlsPort = Number(new URL(origin).port) || 443;
// --probe: the flag AND the owner's permission recorded in brief.json (the skill asks before setting it)
const probeAllowed = !!args.probe && briefJson?.limits?.probe === true;
// external service (RDAP) policy, same as domain.mjs: live stage and a public host only
const stage = (args.stage && args.stage !== true ? String(args.stage) : null) || briefAny.stage || null;
const extAllowed = !isLocal && !/^[\d.:[\]]+$/.test(host) && (stage ? stage === 'live' : !(pagesJson?.beta_signals || []).length) && briefAny.external_services?.rdap !== false;

// ---------- known vulnerable client-side libraries ----------
// Every range: GitHub Advisory Database (github.com/advisories/<GHSA>) / NVD, vendor pages for end of life.
// Checked 24.10.2026. A version match is a hint (P1 at most); P0 only when exploitation is shown on the site.
const VULNS_CHECKED = '2026-10-24';
const VULNS = { // library → affected ranges (gte ≤ version < lt); sev: critical|high|medium|low|eol; cond: extra condition
  jquery: [
    { lt: '1.9.0', ids: 'CVE-2012-6708', sev: 'medium', what: 'XSS: $(строка) разбирает HTML в любом месте строки', src: 'GHSA-2pqj-h3vj-pqgw' },
    { lt: '1.12.2', ids: 'CVE-2015-9251', sev: 'medium', what: 'XSS в ответах cross-domain ajax', src: 'GHSA-rmxg-73gg-4p98' },
    { gte: '1.12.3', lt: '3.0.0', ids: 'CVE-2015-9251', sev: 'medium', what: 'XSS в ответах cross-domain ajax', src: 'GHSA-rmxg-73gg-4p98' },
    { gte: '1.1.4', lt: '3.4.0', ids: 'CVE-2019-11358', sev: 'medium', what: 'prototype pollution в $.extend(true, …)', src: 'GHSA-6c3j-c64m-qhgq' },
    { gte: '1.0.3', lt: '3.5.0', ids: 'CVE-2020-11023', sev: 'medium', what: 'XSS в .html()/.append() (HTML с <option>)', src: 'GHSA-jpcq-cgw6-v4j6' },
    { gte: '1.12.0', lt: '3.5.0', ids: 'CVE-2020-11022', sev: 'medium', what: 'XSS в .html()/.append()', src: 'GHSA-gxr4-xjj5-5px2' },
  ],
  'jquery-ui': [
    { lt: '1.13.0', ids: 'CVE-2021-41182, CVE-2021-41183, CVE-2021-41184', sev: 'medium', what: 'XSS через параметры виджетов', src: 'GHSA-9gj3-hwp5-pmwc' },
    { lt: '1.13.2', ids: 'CVE-2022-31160', sev: 'medium', what: 'XSS в checkboxradio("refresh")', src: 'GHSA-h6gj-6jjq-h8g9' },
  ],
  bootstrap: [
    { gte: '3.0.0', lt: '3.4.1', ids: 'CVE-2019-8331', sev: 'medium', what: 'XSS в tooltip/popover', src: 'GHSA-9v3m-8fp8-mj99' },
    { gte: '4.0.0', lt: '4.3.1', ids: 'CVE-2019-8331', sev: 'medium', what: 'XSS в tooltip/popover', src: 'GHSA-9v3m-8fp8-mj99' },
    { gte: '1.4.0', lt: '3.4.2', ids: 'CVE-2024-6485', sev: 'medium', what: 'XSS в data-loading-text кнопок, исправления нет', src: 'GHSA-vxmc-5x29-h64v' },
    { gte: '3.4.1', lt: '3.4.2', ids: 'CVE-2025-1647', sev: 'medium', what: 'XSS в popover/tooltip, исправления нет', src: 'GHSA-q58r-hwc8-rm9j' },
    { gte: '3.0.0', lt: '5.0.0', ids: 'EOL', sev: 'eol', what: 'Bootstrap 3 не поддерживается с 24.07.2019, Bootstrap 4 — с 01.01.2023', src: 'github.com/twbs/release' },
  ],
  lodash: [
    { gte: '3.7.0', lt: '4.17.19', ids: 'CVE-2020-8203', sev: 'high', what: 'prototype pollution в _.zipObjectDeep', src: 'GHSA-p6mc-m468-83gw' },
    { lt: '4.17.21', ids: 'CVE-2021-23337', sev: 'high', what: 'внедрение кода через _.template', src: 'GHSA-35jh-r3h4-6jhm' },
    { gte: '4.0.0', lt: '4.18.0', ids: 'CVE-2026-4800', sev: 'high', what: 'внедрение кода через imports в _.template', src: 'GHSA-r5fr-rjxr-66jc' },
  ],
  underscore: [
    { gte: '1.3.2', lt: '1.12.1', ids: 'CVE-2021-23358', sev: 'high', what: 'внедрение кода через _.template', src: 'GHSA-cf4h-3jhx-xvhq' },
    { lt: '1.13.8', ids: 'CVE-2026-27601', sev: 'high', what: 'бесконечная рекурсия в _.flatten/_.isEqual (отказ в обслуживании)', src: 'GHSA-qpx9-hpmf-5gmw' },
  ],
  moment: [{ gte: '2.18.0', lt: '2.29.4', ids: 'CVE-2022-31129', sev: 'high', what: 'ReDoS при разборе дат RFC 2822', src: 'GHSA-wc69-rhjr-hc9g' }],
  angularjs: [
    { gte: '1.0.0', lt: '2.0.0', ids: 'EOL', sev: 'eol', what: 'AngularJS 1.x не поддерживается с 31.12.2021, исправлений больше нет', src: 'docs.angularjs.org/misc/version-support-status' },
    { gte: '1.3.0', lt: '1.8.4', ids: 'CVE-2024-21490', sev: 'high', what: 'ReDoS, исправления нет', src: 'GHSA-4w4v-5hc9-xrr2' },
    { gte: '1.2.0', lt: '1.8.4', ids: 'CVE-2026-11998', sev: 'high', what: 'XSS, исправления нет', src: 'GHSA-7x27-g8rg-x87w' },
  ],
  vue: [
    { gte: '2.0.0', lt: '3.0.0', ids: 'EOL', sev: 'eol', what: 'Vue 2 не поддерживается с 31.12.2023', src: 'v2.vuejs.org/lts' },
    { gte: '2.0.0', lt: '3.0.0', ids: 'CVE-2024-9506', sev: 'low', what: 'ReDoS в parseHTML, исправления в 2.x нет', src: 'GHSA-5j4c-8p2g-v4jx' },
  ],
  handlebars: [
    { lt: '4.7.7', ids: 'CVE-2021-23369, CVE-2021-23383', sev: 'critical', what: 'выполнение кода при компиляции чужих шаблонов', src: 'GHSA-f2jv-r9rf-7988' },
    { gte: '4.0.0', lt: '4.7.10', ids: 'CVE-2026-33937, CVE-2026-106445, CVE-2026-106446', sev: 'critical', what: 'выполнение кода при чужом шаблоне или AST', src: 'GHSA-2w6w-674q-4c4q, GHSA-p8wg-vrv2-v86f' },
  ],
  dompurify: [
    { lt: '2.4.2', ids: 'CVE-2024-48910', sev: 'critical', what: 'обход очистки (prototype pollution)', src: 'GHSA-p3vf-v8qc-cwcr' },
    { lt: '2.5.4', ids: 'CVE-2024-45801, CVE-2024-47875', sev: 'high', what: 'обход очистки (вложенность, mXSS)', src: 'GHSA-mmhx-hmjr-r674, GHSA-gx9m-whjm-85jf' },
    { gte: '3.0.0', lt: '3.1.3', ids: 'CVE-2024-45801, CVE-2024-47875', sev: 'high', what: 'обход очистки (вложенность, mXSS)', src: 'GHSA-mmhx-hmjr-r674, GHSA-gx9m-whjm-85jf' },
    { gte: '3.0.0', lt: '3.2.4', ids: 'CVE-2025-26791', sev: 'medium', what: 'mXSS через регэксп шаблонных литералов', src: 'GHSA-vhxf-7vqr-mrjg' },
    { gte: '3.0.0', lt: '3.4.17', ids: 'GHSA-mrv2-3pqr-j5jr, GHSA-cg2g-xh64-v4q7', sev: 'high', what: 'обход очистки в режимах IN_PLACE и SAFE_FOR_TEMPLATES', src: 'GHSA-mrv2-3pqr-j5jr, GHSA-cg2g-xh64-v4q7' },
  ],
  swiper: [
    { lt: '6.5.1', ids: 'CVE-2021-23370', sev: 'medium', what: 'prototype pollution', src: 'GHSA-p3hc-fv2j-rp68' },
    { gte: '6.5.1', lt: '12.1.2', ids: 'CVE-2026-27212', sev: 'critical', what: 'prototype pollution (обход прежнего исправления)', src: 'GHSA-hmx5-qpq5-p643' },
  ],
  nextjs: [
    { gte: '11.1.4', lt: '12.3.5', ids: 'CVE-2025-29927', sev: 'critical', what: 'обход middleware заголовком x-middleware-subrequest', src: 'GHSA-f82v-jwr5-mffw' },
    { gte: '13.0.0', lt: '13.5.9', ids: 'CVE-2025-29927', sev: 'critical', what: 'обход middleware', src: 'GHSA-f82v-jwr5-mffw' },
    { gte: '14.0.0', lt: '14.2.25', ids: 'CVE-2025-29927', sev: 'critical', what: 'обход middleware', src: 'GHSA-f82v-jwr5-mffw' },
    { gte: '15.0.0', lt: '15.2.3', ids: 'CVE-2025-29927', sev: 'critical', what: 'обход middleware', src: 'GHSA-f82v-jwr5-mffw' },
    // React Server Components RCE (bulletin 03.12.2025; CVE-2025-66478 was rejected as a duplicate): App Router only
    ...[['15.0.0', '15.0.5'], ['15.1.0', '15.1.9'], ['15.2.0', '15.2.6'], ['15.3.0', '15.3.6'], ['15.4.0', '15.4.8'], ['15.5.0', '15.5.7'], ['16.0.0', '16.0.7']]
      .map(([gte, lt]) => ({ gte, lt, ids: 'CVE-2025-55182', sev: 'critical', cond: 'app_router', what: 'выполнение кода на сервере без входа (React Server Components)', src: 'nextjs.org/blog/CVE-2025-66478, GHSA-9qr9-h5gf-34mp' })),
    // bulletin 11.12.2025 + addendum: DoS (55184, 67779) and source code exposure (55183), App Router only
    { gte: '13.3.0', lt: '14.2.35', ids: 'CVE-2025-55184, CVE-2025-67779', sev: 'high', cond: 'app_router', what: 'отказ в обслуживании (зависание сервера)', src: 'nextjs.org/blog/security-update-2025-12-11' },
    ...[['15.0.0', '15.0.7'], ['15.1.0', '15.1.11'], ['15.2.0', '15.2.8'], ['15.3.0', '15.3.8'], ['15.4.0', '15.4.10'], ['15.5.0', '15.5.9'], ['16.0.0', '16.0.10']]
      .map(([gte, lt]) => ({ gte, lt, ids: 'CVE-2025-55183, CVE-2025-55184, CVE-2025-67779', sev: 'high', cond: 'app_router', what: 'отказ в обслуживании и раскрытие кода Server Functions', src: 'nextjs.org/blog/security-update-2025-12-11' })),
    // 22.10.2026: Image Optimization RCE (sharp on glibc Linux, SVG) and Server Actions DoS
    { gte: '10.0.0', lt: '15.5.28', ids: 'GHSA-2464-fhr4-w9xw', sev: 'critical', what: 'выполнение кода через Image Optimization (sharp на Linux, SVG)', src: 'GHSA-2464-fhr4-w9xw' },
    { gte: '16.0.0', lt: '16.4.1', ids: 'GHSA-2464-fhr4-w9xw', sev: 'critical', what: 'выполнение кода через Image Optimization (sharp на Linux, SVG)', src: 'GHSA-2464-fhr4-w9xw' },
    { gte: '13.0.0', lt: '15.5.28', ids: 'CVE-2026-94482', sev: 'high', what: 'отказ в обслуживании через Server Actions', src: 'GHSA-p3m5-59mp-jv5r' },
    { gte: '16.0.0', lt: '16.4.1', ids: 'CVE-2026-94482', sev: 'high', what: 'отказ в обслуживании через Server Actions', src: 'GHSA-p3m5-59mp-jv5r' },
    { gte: '9.0.0', lt: '15.0.0', ids: 'EOL', sev: 'eol', what: 'ветки Next.js до 15 не получают исправлений', src: 'nextjs.org/support-policy' },
  ],
};
const BANNERS = [
  ['jquery', /jQuery (?:JavaScript Library )?v?(\d+\.\d+\.\d+)/], ['jquery-ui', /jQuery UI - v(\d+\.\d+\.\d+)/], ['jquery-migrate', /jQuery Migrate (?:- )?v(\d+\.\d+\.\d+)/],
  ['bootstrap', /Bootstrap v(\d+\.\d+\.\d+)/], ['moment', /\/\/! version : (\d+\.\d+\.\d+)/], ['angularjs', /AngularJS v(\d+\.\d+\.\d+)/],
  ['vue', /Vue\.js v(\d+\.\d+\.\d+)/], ['react', /React v(\d+\.\d+\.\d+)/], ['handlebars', /handlebars v(\d+\.\d+\.\d+)/i],
  ['dompurify', /DOMPurify (\d+\.\d+\.\d+)/], ['swiper', /Swiper (\d+\.\d+\.\d+)/], ['underscore', /Underscore\.js (\d+\.\d+\.\d+)/],
  ['lodash', /lodash(?:\.min)?\.js[^\n]*?(\d+\.\d+\.\d+)|@license\s+lodash\s+(\d+\.\d+\.\d+)|Lodash\s+v?(\d+\.\d+\.\d+)/i], ['fancybox', /fancyBox v(\d+\.\d+\.\d+)/i],
];
const URL_LIBS = [['jquery', /\/jquery[.-](\d+\.\d+\.\d+)(?:\.slim)?(?:\.min)?\.js/i], ['jquery-ui', /\/jquery-ui[.-](\d+\.\d+\.\d+)/i], ['bootstrap', /\/bootstrap[@/-](\d+\.\d+\.\d+)/i],
  ['lodash', /\/lodash(?:\.js)?[@/-](\d+\.\d+\.\d+)/i], ['moment', /\/moment(?:\.js)?[@/-](\d+\.\d+\.\d+)/i], ['vue', /\/vue[@/-](\d+\.\d+\.\d+)/i], ['angularjs', /\/angular(?:js)?[@/.-](1\.\d+\.\d+)/i],
  ['jquery', /\/jquery\/(\d+\.\d+\.\d+)\//i], ['swiper', /\/swiper[@/-](\d+\.\d+\.\d+)/i], ['dompurify', /\/dompurify[@/-](\d+\.\d+\.\d+)/i], ['handlebars', /\/handlebars(?:\.js)?[@/-](\d+\.\d+\.\d+)/i]];
const CDN_HOSTS = /(^|\.)(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|code\.jquery\.com|ajax\.googleapis\.com|stackpath\.bootstrapcdn\.com|maxcdn\.bootstrapcdn\.com|netdna\.bootstrapcdn\.com|ajax\.aspnetcdn\.com|yastatic\.net|cdn\.bootcdn\.net|lib\.baomitu\.com)$/i;
const TRACES = [
  [/Traceback \(most recent call last\)/, 'Python traceback'],
  [/(Fatal error|Warning|Notice|Parse error|Deprecated|Uncaught \w+):?\s[^<\n]{0,200}? in \/?[\w\/.\\:-]+\.php(?:<\/b>)? on line/i, 'PHP error'],
  [/\bat [\w$.<>]+ \(?[\w\/.\\:-]+\.(?:js|ts|mjs|cjs):\d+:\d+\)?/, 'Node.js stack'],
  [/\bat (?:java|javax|org\.springframework|org\.apache|com\.sun)\.[\w.$]+\(/, 'Java stack'],
  [/Server Error in '\/' Application|ASP\.NET is configured to show verbose error/i, 'ASP.NET error'],
  [/You're seeing this error because you have <code>DEBUG = True/i, 'Django DEBUG'],
  [/Whoops, looks like something went wrong|Illuminate\\[A-Z]\w+\\\w*Exception/, 'Laravel debug'],
  [/Werkzeug Debugger|werkzeug\.exceptions/i, 'Werkzeug debugger'],
  [/SQLSTATE\[\w+\]|You have an error in your SQL syntax|ORA-\d{5}|PG::\w+Error/i, 'SQL error'],
  [/Stack trace:\s*(<br \/>)?\s*#0 /i, 'stack trace'],
];
const looksHtml = s => /^\s*(<!doctype html|<html|<head|<body)/i.test(String(s || '').slice(0, 500));
const rnd6 = () => [...randomBytes(6)].map(b => String.fromCharCode(97 + (b % 26))).join('');
// query values of API addresses never reach RUN files (tokens, e-mails)
function maskUrl(u) { try { const x = new URL(u); return x.search ? `${x.origin}${x.pathname}?${x.search.slice(1).split('&').map(p => p.replace(/=.*/, '=…')).join('&')}` : u; } catch { return String(u).replace(/\?.*$/, '?…'); } }

// ---------- secrets in the site's own scripts ----------
// Only first-party JS (files and inline scripts). The value never leaves memory: kept are type, place, length and
// the first 4 characters. Keys meant for browsers (publishable, Supabase anon JWT, Google browser keys) are public: true.
const SECRET_RULES = [
  ['private_key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g, false],
  ['aws_access_key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, false],
  ['stripe_secret_key', /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}\b/g, false],
  ['stripe_publishable_key', /\bpk_live_[0-9a-zA-Z]{20,}\b/g, true],
  ['github_token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g, false],
  ['slack_token', /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, false],
  ['slack_webhook', /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,}/g, false],
  ['telegram_bot_token', /\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/g, false],
  ['openai_key', /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9]{48}\b/g, false],
  ['anthropic_key', /\bsk-ant-[a-z0-9]{2,8}-[A-Za-z0-9_-]{60,}/g, false],
  ['sendgrid_key', /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, false],
  ['mailgun_key', /\bkey-[0-9a-f]{32}\b/g, false],
  ['yandex_cloud_api_key', /\bAQVN[A-Za-z0-9_-]{35,40}\b/g, false],
  ['yandex_oauth_token', /\by0_[A-Za-z0-9_-]{50,}\b/g, false],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{35}\b/g, true], // browser keys are public by design: their HTTP-referrer restriction matters
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, null],
  ['generic', /(?:api[_-]?key|apikey|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd)["']?\s*[:=]\s*["']([^"'\s]{12,120})["']/gi, null],
];
const PLACEHOLDER = /^(x+|\*+|\.+|-+|your|change|replace|insert|enter|example|sample|dummy|test|demo|placeholder|password|secret|token|api[_-]?key|null|undefined|none|true|false|<|\$\{|%|{{|process\.env)/i;
function jwtRole(tok) {
  try { const p = JSON.parse(Buffer.from(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); return { role: typeof p.role === 'string' ? p.role.slice(0, 30) : null, claims: Object.keys(p).slice(0, 12) }; } catch { return null; }
}
function scanSecrets(text, where) {
  const found = [];
  const src = String(text || '').slice(0, 6 * 1024 * 1024);
  for (const [type, re, isPublic] of SECRET_RULES) {
    re.lastIndex = 0; let m, n = 0;
    while ((m = re.exec(src)) && n < 10) {
      n++;
      const value = type === 'generic' ? m[1] : m[0];
      const rec = { type, where: maskUrl(where).slice(0, 200), length: value.length, masked: value.slice(0, 4) + '***', public: isPublic === true, confidence: 'high' };
      if (type === 'jwt') {
        const j = jwtRole(value); if (!j) continue;
        rec.role = j.role; rec.claims = j.claims;
        rec.public = j.role === 'anon'; // Supabase-style anon key is meant for browsers; service_role is not
        rec.confidence = j.role === 'service_role' ? 'high' : j.role === 'anon' ? 'high' : 'medium';
      }
      if (type === 'generic') {
        // labels, placeholders and words are not secrets: a real one mixes letters and digits and has no spaces/Cyrillic
        if (PLACEHOLDER.test(value) || /[\sЀ-ӿ]/.test(value) || !/[a-z]/i.test(value) || !/\d/.test(value) || /^(https?:|\/|\.\/)/i.test(value) || /^(.)\1+$/.test(value)) continue;
        rec.confidence = 'low';
      }
      found.push(rec);
    }
  }
  return found;
}

function semver(v) { return String(v || '').split(/[.+-]/).slice(0, 3).map(x => parseInt(x, 10) || 0); }
function cmp(a, b) { const x = semver(a), y = semver(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; }
function vulnsFor(name, version, ctx = {}) {
  return (VULNS[name] || []).filter(r => (!r.gte || cmp(version, r.gte) >= 0) && (!r.lt || cmp(version, r.lt) < 0))
    .filter(r => r.cond !== 'app_router' || ctx.app_router !== false) // unknown router: kept, marked below
    .map(r => ({ ids: r.ids, sev: r.sev, what: r.what, fixed_in: r.sev === 'eol' || /исправления нет/.test(r.what) ? null : r.lt, source: r.src,
      ...(r.cond === 'app_router' ? { condition: ctx.app_router === true ? 'app_router' : 'app_router_unknown' } : {}) }));
}

// ---------- CSP ----------
// A header may carry several policies («, »), the page may add <meta http-equiv>: all of them apply at once,
// so a weakness counts only when no policy closes it. In <meta> frame-ancestors, report-uri/report-to and sandbox are ignored.
const META_IGNORED = ['frame-ancestors', 'report-uri', 'report-to', 'sandbox'];
function parsePolicy(text, source) {
  const d = {};
  for (const part of String(text || '').split(';')) { const t = part.trim().split(/\s+/); if (!t[0]) continue; const k = t[0].toLowerCase(); if (!(k in d)) d[k] = t.slice(1); }
  const ignored = source === 'meta' ? META_IGNORED.filter(k => k in d) : [];
  for (const k of ignored) delete d[k];
  const script = d['script-src'] || d['default-src'] || null;
  const has = (arr, tok) => !!arr && arr.some(x => x.toLowerCase() === tok);
  const nonceOrHash = !!script && script.some(x => /^'(nonce-|sha(256|384|512)-)/i.test(x));
  const strict = has(script, "'strict-dynamic'");
  const objectSrc = d['object-src'] || d['default-src'] || null;
  return { source, directives: Object.keys(d), script_src: script ? script.slice(0, 20) : null, nonce_or_hash: nonceOrHash, strict_dynamic: strict, ignored_in_meta: ignored,
    restricts: !!script, inline_ok: !script || (has(script, "'unsafe-inline'") && !nonceOrHash && !strict), eval_ok: !script || has(script, "'unsafe-eval'"),
    wildcard: !script || script.some(x => ['*', 'http:', 'https:', 'data:'].includes(x.toLowerCase())), object_none: has(objectSrc, "'none'"),
    base_uri: 'base-uri' in d, frame_ancestors: 'frame-ancestors' in d, reporting: 'report-uri' in d || 'report-to' in d, upgrade: 'upgrade-insecure-requests' in d };
}
function analyzeCsp(headerValue, metaValues = []) {
  const pols = [...String(headerValue || '').split(',').map(s => s.trim()).filter(Boolean).map(s => parsePolicy(s, 'header')),
    ...metaValues.map(s => String(s || '').trim()).filter(Boolean).map(s => parsePolicy(s, 'meta'))];
  if (!pols.length) return null;
  const weak = []; const hdr = pols.filter(p => p.source === 'header');
  if (!pols.some(p => p.restricts)) weak.push('no_script_src');
  else {
    if (pols.every(p => p.inline_ok)) weak.push('unsafe_inline');
    if (pols.every(p => p.eval_ok)) weak.push('unsafe_eval');
    if (pols.every(p => p.wildcard)) weak.push('wildcard_source');
  }
  if (!pols.some(p => p.object_none)) weak.push('object_src_not_none');
  if (!pols.some(p => p.base_uri)) weak.push('no_base_uri');
  if (hdr.length && !hdr.some(p => p.frame_ancestors)) weak.push('no_frame_ancestors'); // meta cannot carry it: XFO/header covers that case
  if (hdr.length && !hdr.some(p => p.reporting)) weak.push('no_reporting');
  const main = pols.find(p => p.restricts) || pols[0];
  return { sources: [...new Set(pols.map(p => p.source))], policies: pols.length, directives: [...new Set(pols.flatMap(p => p.directives))],
    script_src: main.script_src, nonce_or_hash: pols.some(p => p.nonce_or_hash), strict_dynamic: pols.some(p => p.strict_dynamic),
    upgrade_insecure: pols.some(p => p.upgrade), frame_ancestors_header: hdr.some(p => p.frame_ancestors),
    ignored_in_meta: [...new Set(pols.flatMap(p => p.ignored_in_meta))], weak };
}
function parseCookie(sc) {
  const parts = String(sc).split(';').map(s => s.trim());
  const [nv, ...attrs] = parts; const name = nv.split('=')[0].trim();
  const a = Object.fromEntries(attrs.map(x => { const i = x.indexOf('='); return i < 0 ? [x.toLowerCase(), true] : [x.slice(0, i).trim().toLowerCase(), x.slice(i + 1).trim()]; }));
  return { name: name.slice(0, 60), secure: !!a.secure, httponly: !!a.httponly, samesite: a.samesite || null, domain: a.domain || null, path: a.path || null,
    persistent: !!(a['max-age'] || a.expires), session_like: /(sess|sid|token|auth|login|jwt|csrf|xsrf)/i.test(name) };
}
// what is wrong with a cookie, by its role: HttpOnly matters for session-like cookies only; browsers default SameSite to Lax,
// so a missing SameSite is noted only for session-like cookies; SameSite=None without Secure is rejected by browsers
function cookieIssues(c) {
  const out = [];
  if (isHttps && !c.secure) out.push('no_secure');
  if (c.session_like && !c.httponly) out.push('no_httponly');
  if (c.session_like && !c.samesite) out.push('no_samesite');
  if (/^none$/i.test(String(c.samesite || '')) && !c.secure) out.push('samesite_none_without_secure');
  return out;
}
function hstsOf(v) {
  if (!v) return null;
  const m = String(v).match(/max-age\s*=\s*"?(\d+)/i);
  return { value: String(v).slice(0, 200), max_age: m ? Number(m[1]) : null, include_subdomains: /includesubdomains/i.test(v), preload: /preload/i.test(v) };
}
function disclosure(headers, generator) {
  const out = [];
  for (const k of ['server', 'x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-generator', 'x-drupal-cache', 'x-runtime', 'x-version', 'via']) {
    const v = headers[k]; if (!v) continue;
    out.push({ header: k, value: String(v).slice(0, 120), has_version: /\d+\.\d+/.test(String(v)) });
  }
  for (const g of generator || []) out.push({ header: 'meta generator', value: String(g).slice(0, 120), has_version: /\d+\.\d+/.test(String(g)) });
  return out;
}
function secHeaders(h) {
  return { hsts: hstsOf(h['strict-transport-security']), csp_header_value: h['content-security-policy'] ? String(h['content-security-policy']).slice(0, 4000) : null,
    csp: analyzeCsp(h['content-security-policy']), csp_report_only: analyzeCsp(h['content-security-policy-report-only']),
    x_frame_options: h['x-frame-options'] || null, x_content_type_options: h['x-content-type-options'] || null, referrer_policy: h['referrer-policy'] || null,
    permissions_policy: h['permissions-policy'] ? String(h['permissions-policy']).slice(0, 300) : null, coop: h['cross-origin-opener-policy'] || null,
    corp: h['cross-origin-resource-policy'] || null, coep: h['cross-origin-embedder-policy'] || null, x_xss_protection: h['x-xss-protection'] || null,
    alt_svc: h['alt-svc'] || null, cache_control: h['cache-control'] || null, content_encoding: h['content-encoding'] || null, vary: h.vary || null };
}

// ---------- browser (one slot) ----------
let browser = null, release = null;
async function getBrowser() {
  if (browser) return browser;
  // seo, headers and domain run in parallel and share 2 machine-wide slots: wait only within our budget
  try { release = await U.acquireBrowserSlot({ waitMs: Math.max(3000, timeLeft() - 15000) }); }
  catch (e) { throw Object.assign(new Error(e.message), { code: 'NO_SLOT' }); }
  for (let k = 0; ; k++) {
    try { browser = await Browser.launch(); break; }
    catch (e) { if (k >= 2) { release(); release = null; throw Object.assign(new Error(e.message), { code: 'LAUNCH' }); } await U.sleep(1500); }
  }
  return browser;
}
async function closeBrowser() {
  const profile = browser?.profile;
  try { if (browser) await browser.close(); } catch {}
  for (let k = 0; profile && existsSync(profile) && k < 10; k++) { try { rmSync(profile, { recursive: true, force: true }); } catch {} await U.sleep(300); }
  try { release?.(); } catch {}
  browser = null; release = null;
}

// ---------- resume ----------
const TRANSIENT = /браузер занят|browser slots busy/i; // notes that only explain why the previous call stopped
const prev = U.readJSON(OUT, null);
const resuming = !!(prev && prev.partial && prev.resume && Array.isArray(prev.resume.done));
const done = new Set(resuming ? prev.resume.done : []);
const keep = k => (resuming ? prev[k] ?? null : null);
const out = {
  ...U.measureHeader('headers', RUN), partial: false, resume: null, site: origin, host, https: isHttps, stage,
  tls: keep('tls'), http3: keep('http3'), home: keep('home'), items: resuming ? (prev.items || []) : [], libraries: keep('libraries') || [],
  vulns_checked: VULNS_CHECKED, sourcemaps: keep('sourcemaps'), cors: keep('cors'), error_page: keep('error_page'), script_domains: keep('script_domains'),
  probe: keep('probe'), cms: keep('cms'), secrets: keep('secrets') || [], secrets_scan: keep('secrets_scan') || { files: 0, bytes: 0, inline: 0 },
  flags: [], errors: resuming ? (prev.errors || []) : [], not_checked: resuming ? (prev.not_checked || []).filter(x => !TRANSIENT.test(x)) : [],
};
const libSeen = new Map((out.libraries || []).map(l => [l.name + '@' + l.version, l]));
const mapCandidates = new Set(resuming ? (prev._maps || []) : []);
const corsCandidates = new Set(resuming ? (prev._cors || []) : []);
const scriptHosts = new Set(resuming ? (prev._script_hosts || []) : []);
const secretsScanned = new Set(resuming ? (prev._secrets_scanned || []) : []); // script URLs without query
function addSecrets(text, where) {
  const key = String(where).replace(/[?#].*$/, '') + (String(where).includes('#inline') ? '#inline' : '');
  if (secretsScanned.has(key)) return;
  secretsScanned.add(key);
  if (key.endsWith('#inline')) out.secrets_scan.inline++; else { out.secrets_scan.files++; out.secrets_scan.bytes += String(text || '').length; }
  for (const f of scanSecrets(text, where)) {
    if (out.secrets.length >= 50) break;
    if (!out.secrets.some(x => x.type === f.type && x.masked === f.masked && x.length === f.length && x.where === f.where)) out.secrets.push(f);
  }
}
const addNotChecked = s => { if (!out.not_checked.includes(s)) out.not_checked.push(s); };
// A step ran out of time. If other work was done in this call, the step stays undone and the next call repeats it;
// if it was the first step of the call, we keep what it got (so every call makes progress) and note the gap.
let cutNote = null;
function cutShort(note) { cutNote = note; }
let appRouter = null; // Next.js App Router seen on a page (window.next.appDir or self.__next_f)
function addLib(name, version, source, url) {
  if (!version) return;
  const key = name + '@' + version;
  const ex = libSeen.get(key);
  if (ex) { if (!ex.sources.includes(source)) ex.sources.push(source); return; }
  const rec = { name, version, sources: [source], url: url ? maskUrl(url).slice(0, 200) : null, vulnerable: [] };
  libSeen.set(key, rec); out.libraries.push(rec);
}
function refreshVulns() { for (const l of out.libraries) l.vulnerable = vulnsFor(l.name, l.version, { app_router: l.name === 'nextjs' ? appRouter : undefined }); }

// ---------- TLS ----------
function certSummary(c) {
  if (!c || !c.subject) return null;
  const to = Date.parse(c.valid_to), from = Date.parse(c.valid_from);
  const days = c.valid_to ? Math.floor((to - Date.now()) / 86400000) : null;
  return { subject_cn: c.subject.CN || null, issuer: [c.issuer?.O, c.issuer?.CN].filter(Boolean).join(' · ') || null, valid_from: c.valid_from, valid_to: c.valid_to,
    days_left: days, hours_left: c.valid_to ? Math.floor((to - Date.now()) / 3600000) : null,
    lifetime_days: Number.isFinite(to - from) ? Math.round((to - from) / 86400000 * 10) / 10 : null,
    san: (c.subjectaltname || '').split(/,\s*/).map(s => s.replace(/^DNS:/, '')).filter(Boolean).slice(0, 50), bits: c.bits || null,
    key: c.asn1Curve ? `EC ${c.asn1Curve}` : c.bits ? `RSA ${c.bits}` : null, self_signed: !!(c.issuer && c.subject && JSON.stringify(c.issuer) === JSON.stringify(c.subject)) };
}
function chainOf(c) {
  const chain = []; const seen = new Set();
  for (let x = c; x && x.fingerprint256 && !seen.has(x.fingerprint256) && chain.length < 6; x = x.issuerCertificate) {
    seen.add(x.fingerprint256); chain.push({ subject: x.subject?.CN || x.subject?.O || null, issuer: x.issuer?.CN || x.issuer?.O || null, valid_to: x.valid_to });
  }
  return chain;
}
function tlsConnect(h, opts = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    let s;
    try {
      s = tls.connect({ host: h, port: tlsPort, servername: /^[\d.]+$/.test(h) ? undefined : h, rejectUnauthorized: false, timeout: 10000, ...opts }, () => {
        const cert = s.getPeerCertificate(true);
        const idErr = tls.checkServerIdentity(h, cert);
        resolve({ ok: true, protocol: s.getProtocol(), alpn: s.alpnProtocol || null, cipher: s.getCipher()?.name || null, authorized: s.authorized,
          auth_error: s.authorizationError ? String(s.authorizationError) : null, hostname_ok: !idErr, cert, ms: Date.now() - started });
        s.end();
      });
    } catch (e) { resolve({ ok: false, code: e.code || 'error', message: e.message }); return; }
    s.on('error', e => resolve({ ok: false, code: e.code || 'error', message: String(e.message || '').slice(0, 200) }));
    s.on('timeout', () => { s.destroy(); resolve({ ok: false, code: 'timeout' }); });
  });
}
async function oldTls(h, ver) {
  const r = await tlsConnect(h, { minVersion: ver, maxVersion: ver, ciphers: 'DEFAULT:@SECLEVEL=0' });
  if (r.ok) return { result: 'accepted', protocol: r.protocol };
  if (r.code === 'ERR_SSL_NO_PROTOCOLS_AVAILABLE' || /no protocols available|no ciphers available/i.test(r.message || '')) return { result: 'cannot_test', why: r.code };
  if (r.code === 'timeout') return { result: 'cannot_test', why: 'timeout' };
  return { result: 'rejected', why: r.code };
}
async function tlsStep() {
  if (!isHttps) { out.tls = { checked: false, why: 'site_is_http' }; return; }
  if (await U.resolvesPrivate(host) && !isLocal) { out.tls = { checked: false, why: 'private_address' }; return; }
  const r = await tlsConnect(host, { ALPNProtocols: ['h2', 'http/1.1'] });
  if (!r.ok) { out.tls = { checked: false, why: r.code, error: r.message }; return; }
  const cert = certSummary(r.cert);
  const www = host.startsWith('www.') ? host.slice(4) : 'www.' + host;
  out.tls = { checked: true, protocol: r.protocol, alpn: r.alpn, http2: r.alpn === 'h2', cipher: r.cipher, authorized: r.authorized, auth_error: r.auth_error,
    hostname_ok: r.hostname_ok, cert, chain: chainOf(r.cert), www_in_san: !!cert?.san.some(n => n === www || (n.startsWith('*.') && www.endsWith(n.slice(1)) && www.split('.').length === n.split('.').length)),
    old: { 'TLSv1.0': await oldTls(host, 'TLSv1'), 'TLSv1.1': await oldTls(host, 'TLSv1.1') } };
  if (!r.authorized || !r.hostname_ok) out.tls.untrusted = await whyUntrusted(r);
}
// Why Node (Mozilla root list) does not trust the certificate. An incomplete chain is confirmed by fetching the missing
// intermediate from the AIA address in the certificate and connecting again with it: browsers that fetch AIA still open
// the site, other clients (some Android, curl, payment callbacks) fail.
async function whyUntrusted(r) {
  const e = String(r.auth_error || '');
  const res = { node_error: e || null, reasons: [] };
  if (!r.hostname_ok) res.reasons.push('name_mismatch');
  if (/CERT_HAS_EXPIRED/.test(e)) res.reasons.push('expired');
  else if (/CERT_NOT_YET_VALID/.test(e)) res.reasons.push('not_yet_valid');
  else if (/DEPTH_ZERO_SELF_SIGNED_CERT/.test(e)) res.reasons.push('self_signed');
  else if (/SELF_SIGNED_CERT_IN_CHAIN/.test(e)) res.reasons.push('unknown_root');
  else if (/UNABLE_TO_VERIFY_LEAF_SIGNATURE|UNABLE_TO_GET_ISSUER_CERT/.test(e)) {
    const aia = (r.cert?.infoAccess?.['CA Issuers - URI'] || []).find(u => /^https?:\/\//i.test(u));
    res.aia_url = aia || null;
    if (aia && timeLeft() > 15000) {
      const g = await U.fetchBytes(aia, { maxBytes: 65536, timeoutMs: 10000, accept: '*/*' });
      U.logExternal(RUN, U.hostOf(aia), L('промежуточный сертификат по адресу AIA из сертификата сайта (без данных сайта)', 'intermediate certificate from the AIA address (no site data)'));
      let pem = null;
      try { pem = new X509Certificate(g.buf).toString(); } catch {}
      if (pem) { const t2 = await tlsConnect(host, { ca: [...tls.rootCertificates, pem] }); res.aia_completes_chain = !!(t2.ok && t2.authorized); }
      else res.aia_completes_chain = null;
    }
    res.reasons.push(res.aia_completes_chain ? 'incomplete_chain' : 'unknown_issuer');
  } else if (e) res.reasons.push('other');
  // national root CAs that are absent from browser root stores
  if ((out.tls?.chain || []).some(c => /Russian Trusted|Минцифр/i.test(`${c.subject} ${c.issuer}`))) res.national_root = 'Russian Trusted Root CA';
  return res;
}

// ---------- home over Node fetch ----------
async function homeStep() {
  const r = await U.politeFetch(home.url, { lang, timeoutMs: 25000 });
  const h = r.headers || {};
  const cookies = [].concat(h['set-cookie'] || []).map(parseCookie);
  out.home = { url: home.url, status: r.status, final_url: r.url, redirects: Math.max(0, (r.chain || []).length - 1), error: r.error || null, antibot: r.antibot || null,
    ...secHeaders(h), cookies, disclosure: disclosure(h, []), server: h.server || null };
  out.http3 = { alt_svc: h['alt-svc'] || null, h3_advertised: /\bh3(-\d+)?=/.test(h['alt-svc'] || ''), method: 'alt-svc' };
  // HSTS on the http→https redirect itself is ignored by browsers — record what the first https answer sends
  if (isHttps && !isLocal) {
    const first = (r.chain || [])[0];
    out.home.first_hop = first ? { url: first.url, status: first.status } : null;
  }
}

// ---------- page loads in the browser ----------
async function pageStep(page) {
  const b = await getBrowser();
  const p = await b.newPage();
  const reqs = new Map(); // requestId → { url, method, type }
  const resps = []; const extraCookies = []; const docHops = [];
  const offs = [
    p.on('Network.requestWillBeSent', e => {
      reqs.set(e.requestId, { url: e.request.url, method: e.request.method, type: e.type });
      // redirects of the main document: their HSTS (https://example.ru → https://www.example.ru)
      if (e.redirectResponse && e.type === 'Document' && (!p.mainFrameId || !e.frameId || e.frameId === p.mainFrameId)) {
        const hh = Object.fromEntries(Object.entries(e.redirectResponse.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
        docHops.push({ url: maskUrl(e.redirectResponse.url).slice(0, 200), status: e.redirectResponse.status, https: /^https:/i.test(e.redirectResponse.url), hsts: hstsOf(hh['strict-transport-security']) });
      }
    }),
    p.on('Network.responseReceived', e => resps.push({ id: e.requestId, url: e.response.url, status: e.response.status, type: e.type, mime: e.response.mimeType,
      protocol: e.response.protocol, security: e.response.securityState || null, headers: Object.fromEntries(Object.entries(e.response.headers || {}).map(([k, v]) => [k.toLowerCase(), v])), size: e.response.encodedDataLength })),
    p.on('Network.loadingFinished', e => { const x = resps.find(r => r.id === e.requestId); if (x) x.size = e.encodedDataLength; }),
    p.on('Network.responseReceivedExtraInfo', e => { const sc = Object.entries(e.headers || {}).find(([k]) => k.toLowerCase() === 'set-cookie'); if (sc) extraCookies.push({ id: e.requestId, value: sc[1] }); }),
  ];
  const rec = { pid: page.pid, url: page.url };
  try {
    await p.setViewport({ width: 1440, height: 900 });
    const g = await p.goto(page.url, { timeout: 40000, idleMs: 1000 });
    rec.status = g.status ?? null; rec.final_url = g.finalUrl || null; rec.load_error = g.ok ? null : (g.error || g.refused);
    rec.redirect_hops = docHops.slice(0, 6);
    // Chromium's own verdict on the certificate (it also fetches missing intermediates by AIA)
    if (!g.ok && /ERR_CERT|ERR_SSL|ERR_BAD_SSL/i.test(String(g.error || ''))) rec.chromium_tls = { trusted: false, error: String(g.error).slice(0, 80) };
    if (!g.ok) return rec;
    await U.sleep(800);
    const docResp = resps.find(r => r.type === 'Document');
    rec.protocol = docResp?.protocol || null;
    if (isHttps && docResp?.security) rec.chromium_tls = { trusted: docResp.security === 'secure', state: docResp.security };
    // page globals (library versions, framework markers) exist only in the page's own JS world
    const globals = await p.evaluate(() => {
      const v = {};
      const safe = f => { try { return f(); } catch (e) { return undefined; } };
      v.jquery = safe(() => window.jQuery && window.jQuery.fn && window.jQuery.fn.jquery);
      v['jquery-ui'] = safe(() => window.jQuery && window.jQuery.ui && window.jQuery.ui.version);
      v['jquery-migrate'] = safe(() => window.jQuery && window.jQuery.migrateVersion);
      v.bootstrap = safe(() => (window.bootstrap && window.bootstrap.Tooltip && window.bootstrap.Tooltip.VERSION) || (window.jQuery && window.jQuery.fn.tooltip && window.jQuery.fn.tooltip.Constructor && window.jQuery.fn.tooltip.Constructor.VERSION));
      v.lodash = safe(() => window._ && typeof window._.cloneDeep === 'function' && window._.VERSION);
      v.underscore = safe(() => window._ && typeof window._.cloneDeep !== 'function' && window._.VERSION);
      v.moment = safe(() => window.moment && window.moment.version);
      v.angularjs = safe(() => window.angular && window.angular.version && window.angular.version.full);
      v.vue = safe(() => window.Vue && window.Vue.version);
      v.react = safe(() => window.React && window.React.version);
      v.nextjs = safe(() => window.next && window.next.version);
      v.handlebars = safe(() => window.Handlebars && window.Handlebars.VERSION);
      v.dompurify = safe(() => window.DOMPurify && window.DOMPurify.version);
      const appRouter = safe(() => (window.next && window.next.appDir === true) || Array.isArray(self.__next_f)) || false;
      return { versions: v, bx: safe(() => !!window.BX) || false, nuxt: safe(() => !!window.__NUXT__) || false, app_router: !!appRouter, next_seen: !!safe(() => window.next) };
    });
    // DOM facts — in the isolated world, so page scripts cannot spoof them
    const dom = await p.evaluateIsolated(() => {
      const abs = s => { try { return new URL(s, location.href).href; } catch (e) { return null; } };
      const scripts = [...document.scripts].filter(s => s.src).map(s => ({ src: s.src, integrity: s.integrity || null, crossorigin: s.crossOrigin || null }));
      const styles = [...document.querySelectorAll('link[rel~="stylesheet"][href]')].map(l => ({ src: l.href, integrity: l.integrity || null }));
      const httpRefs = [];
      if (location.protocol === 'https:') {
        for (const el of document.querySelectorAll('img[src],script[src],iframe[src],video[src],audio[src],source[src],embed[src],object[data],link[rel~="stylesheet"][href],form[action],img[srcset],source[srcset]')) {
          const vals = [el.getAttribute('src'), el.getAttribute('data'), el.tagName === 'LINK' ? el.getAttribute('href') : null, el.tagName === 'FORM' ? el.getAttribute('action') : null, ...(String(el.getAttribute('srcset') || '').split(',').map(s => s.trim().split(/\s+/)[0]))];
          for (const x of vals) if (x && /^http:\/\//i.test(x.trim()) && httpRefs.length < 30) httpRefs.push({ tag: el.tagName.toLowerCase(), url: x.trim().slice(0, 200) });
        }
      }
      const gen = [...document.querySelectorAll('meta[name="generator" i]')].map(m => m.content);
      const cspMeta = [...document.querySelectorAll('meta[http-equiv]')].filter(m => /^content-security-policy$/i.test(m.getAttribute('http-equiv') || '')).map(m => ({ content: (m.getAttribute('content') || '').slice(0, 4000), in_head: !!m.closest('head') }));
      const inline = [...document.scripts].filter(s => !s.src && (!s.type || /javascript|module|json/i.test(s.type))).map(s => s.textContent || '').join(' ;\n').slice(0, 1000000);
      const forms = [...document.forms].map(f => ({ action: abs(f.getAttribute('action') || ''), method: (f.getAttribute('method') || 'get').toLowerCase() })).slice(0, 20);
      const hints = { wordpress: !!document.querySelector('link[href*="/wp-content/"],script[src*="/wp-content/"],script[src*="/wp-includes/"],link[href*="/wp-includes/"]'),
        bitrix: !!document.querySelector('script[src*="/bitrix/"],link[href*="/bitrix/"]'), tilda: !!document.querySelector('script[src*="tildacdn"],link[href*="tildacdn"]'),
        nextjs: !!document.getElementById('__NEXT_DATA__') || !!document.querySelector('script[src*="/_next/"]'), nuxt: !!document.getElementById('__NUXT_DATA__') };
      return { scripts: scripts.slice(0, 150), styles: styles.slice(0, 100), httpRefs, gen, cspMeta, forms, hints, inline };
    });
    rec.generator = dom.gen;
    if (dom.inline) addSecrets(dom.inline, page.url.replace(/#.*/, '') + '#inline-scripts');
    rec.cms_hints = { ...dom.hints, bitrix: dom.hints.bitrix || globals.bx, nuxt: dom.hints.nuxt || globals.nuxt };
    rec.csp_meta = dom.cspMeta.filter(m => m.in_head).map(m => m.content); // a meta CSP outside <head> is ignored by browsers
    if (dom.cspMeta.some(m => !m.in_head)) rec.csp_meta_outside_head = true;
    if (globals.app_router) appRouter = true; else if (globals.next_seen && appRouter === null) appRouter = false;
    rec.next_app_router = globals.next_seen || globals.app_router ? globals.app_router : null;
    for (const [name, ver] of Object.entries(globals.versions)) if (typeof ver === 'string' && /^\d+\.\d+/.test(ver)) addLib(name, ver.trim(), 'runtime', page.url);
    // SRI
    const third = [...dom.scripts, ...dom.styles].filter(s => s.src && /^https?:/i.test(s.src) && !U.sameSite(s.src, origin));
    rec.third_party_hosts = [...new Set(third.map(s => U.hostOf(s.src)))].slice(0, 40);
    rec.third_party_script_hosts = [...new Set(dom.scripts.filter(s => /^https?:/i.test(s.src) && U.isThirdParty(s.src, origin)).map(s => U.hostOf(s.src)))].slice(0, 40);
    for (const h of rec.third_party_script_hosts) if (scriptHosts.size < 40) scriptHosts.add(h);
    rec.sri_missing_cdn = third.filter(s => CDN_HOSTS.test(U.hostOf(s.src)) && !s.integrity).map(s => maskUrl(s.src).slice(0, 200)).slice(0, 20);
    rec.sri_missing_other = third.filter(s => !CDN_HOSTS.test(U.hostOf(s.src)) && !s.integrity).length;
    for (const s of [...dom.scripts, ...dom.styles]) for (const [name, re] of URL_LIBS) { const m = s.src.match(re); if (m) addLib(name, m[1], 'url', s.src); }
    // bodies of scripts/styles: banners and sourceMappingURL
    const bodies = resps.filter(r => (r.type === 'Script' || r.type === 'Stylesheet') && r.status === 200).slice(0, 60);
    for (const r of bodies) {
      let body = '';
      try { const x = await p.send('Network.getResponseBody', { requestId: r.id }, 15000); body = x.base64Encoded ? Buffer.from(x.body, 'base64').toString('utf8') : x.body; } catch { continue; }
      if (r.type === 'Script' && !U.isThirdParty(r.url, origin)) addSecrets(body, r.url);
      const head = body.slice(0, 4000);
      for (const [name, re] of BANNERS) { const m = head.match(re); if (m) { const ver = m.slice(1).find(Boolean); if (ver) addLib(name, ver, 'banner', r.url); } }
      const tail = body.slice(-600);
      const sm = tail.match(/[#@]\s*sourceMappingURL=\s*([^\s'"*]+)/);
      const hdr = r.headers['sourcemap'] || r.headers['x-sourcemap'];
      for (const ref of [sm?.[1], hdr]) {
        if (!ref || /^data:/i.test(ref)) continue;
        // first party = same registrable domain: the site's own CDN subdomain counts
        try { const mu = new URL(ref, r.url).href; if (!U.isThirdParty(mu, origin) && mapCandidates.size < 15) mapCandidates.add(mu); } catch {}
      }
    }
    // compression and caching for first-party resources
    const first = resps.filter(r => U.sameSite(r.url, origin) && r.status === 200 && /^https?:/.test(r.url));
    const textual = r => ['Document', 'Script', 'Stylesheet', 'XHR', 'Fetch'].includes(r.type) || /svg|json|javascript|css|html|xml|text\//i.test(r.mime || '');
    const byType = {};
    for (const r of first) {
      const t = r.type || 'Other'; const st = byType[t] || (byType[t] = { count: 0, bytes: 0, uncompressed: [], short_cache: [], encodings: {} });
      st.count++; st.bytes += r.size || 0;
      const enc = (r.headers['content-encoding'] || 'none').toLowerCase(); st.encodings[enc] = (st.encodings[enc] || 0) + 1;
      if (textual(r) && enc === 'none' && (r.size || 0) > 1500 && st.uncompressed.length < 8) st.uncompressed.push(`${maskUrl(r.url).slice(0, 140)} (${U.fmtBytes(r.size)})`);
      if (['Script', 'Stylesheet', 'Font', 'Image'].includes(t)) {
        const cc = String(r.headers['cache-control'] || '').toLowerCase();
        const ma = Number((cc.match(/max-age=(\d+)/) || [])[1] || 0);
        if ((/no-store|no-cache/.test(cc) || ma < 86400) && !r.headers.expires && st.short_cache.length < 8) st.short_cache.push(`${maskUrl(r.url).slice(0, 140)} (${cc || L('нет Cache-Control', 'no Cache-Control')})`);
      }
    }
    rec.first_party = byType;
    rec.html_cache = docResp ? (docResp.headers['cache-control'] || null) : null;
    const staticSample = first.find(r => r.type === 'Script' || r.type === 'Stylesheet');
    rec.static_sample = staticSample ? { url: maskUrl(staticSample.url).slice(0, 200), hsts: !!staticSample.headers['strict-transport-security'], nosniff: /nosniff/i.test(staticSample.headers['x-content-type-options'] || '') } : null;
    rec.protocols = [...new Set(first.map(r => r.protocol).filter(Boolean))];
    // mixed content
    rec.mixed_content = isHttps ? {
      dom_http_refs: dom.httpRefs, http_responses: resps.filter(r => /^http:\/\//i.test(r.url)).map(r => maskUrl(r.url).slice(0, 200)).slice(0, 20),
      blocked: (p.failed || []).filter(f => /mixed/i.test(String(f.blocked || f.error))).map(f => maskUrl(f.url).slice(0, 200)).slice(0, 20),
      insecure_form_actions: dom.forms.filter(f => /^http:\/\//i.test(f.action || '')).map(f => maskUrl(f.action).slice(0, 200)) } : null;
    // cookies set by first-party responses (names and flags only)
    rec.cookies = extraCookies.filter(c => { const q = resps.find(r => r.id === c.id) || reqs.get(c.id); return q && U.sameSite(q.url, origin); })
      .flatMap(c => String(c.value).split('\n')).map(parseCookie).filter((c, i, a) => a.findIndex(x => x.name === c.name) === i).slice(0, 30);
    // CORS candidates: GET XHR/fetch to same-site endpoints the page itself called
    for (const [id, q] of reqs) {
      if (corsCandidates.size >= 5) break;
      const resp = resps.find(r => r.id === id);
      if (!resp || q.method !== 'GET' || !['XHR', 'Fetch'].includes(q.type) || !U.sameSite(q.url, origin) || U.isRiskyGet(q.url)) continue;
      if (/\/api\/|\/graphql|\/wp-json\//i.test(q.url) || /json/i.test(resp.mime || '')) corsCandidates.add(q.url);
    }
    rec.blocked_by_safety = Object.fromEntries(Object.entries(p.blocked || {}).map(([k, v]) => [k, v.length]).filter(([, n]) => n));
  } finally {
    offs.forEach(f => f());
    await p.close();
  }
  return rec;
}

async function mapsStep() {
  out.sourcemaps = [];
  for (const u of [...mapCandidates].slice(0, 10)) {
    if (timeLeft() < 8000) { cutShort(L('source maps — проверены не все', 'source maps — partially')); break; }
    const r = await U.fetchBytes(u, { maxBytes: 4096, timeoutMs: 15000, accept: 'application/json,*/*' });
    if (r.status === 429) { U.coolDownHost(U.hostOf(r.url || u)); addNotChecked(L('source maps: сайт ответил 429 — остановили', 'source maps: 429 — stopped')); break; }
    const head = r.buf?.toString('utf8') || '';
    out.sourcemaps.push({ url: maskUrl(u).slice(0, 200), status: r.status, bytes: r.total ?? r.bytes, looks_like_map: r.status === 200 && /"(version|mappings|sources)"\s*:/.test(head) && !looksHtml(head), skipped: r.skipped || null });
  }
}

async function corsStep() {
  out.cors = [];
  for (const u of [...corsCandidates].slice(0, 5)) {
    if (timeLeft() < 8000) { cutShort(L('CORS: проверены не все адреса (время)', 'CORS: cut by time')); break; }
    const r = await U.fetchBytes(u, { maxBytes: 2048, timeoutMs: 15000, accept: 'application/json,*/*', headers: { origin: 'https://revizor-cors-check.invalid' } });
    if (r.status === 429) { U.coolDownHost(U.hostOf(r.url || u)); addNotChecked(L('CORS: сайт ответил 429 — остановили', 'CORS: 429 — stopped')); break; }
    const acao = r.headers?.['access-control-allow-origin'] || null; const acac = /true/i.test(r.headers?.['access-control-allow-credentials'] || '');
    const reflects = acao === 'https://revizor-cors-check.invalid';
    out.cors.push({ url: maskUrl(u).slice(0, 200), status: r.status, acao, acac, reflects_origin: reflects, skipped: r.skipped || null,
      verdict: reflects && acac ? 'reflects_with_credentials' : reflects ? 'reflects' : acao === '*' && acac ? 'wildcard_with_credentials' : acao === '*' ? 'wildcard' : acao ? 'fixed' : 'none' });
  }
}

async function errorStep() {
  const u = `${origin}/revizor-404-check-${rnd6()}`;
  const r = await U.politeFetch(u, { lang, timeoutMs: 20000 });
  const body = r.body || '';
  const sigs = TRACES.filter(([re]) => re.test(body)).map(([re, name]) => { const m = body.match(re); return { kind: name, sample: m ? m[0].replace(/\s+/g, ' ').slice(0, 140) : null }; });
  const vers = [...new Set((body.match(/\b(Apache|nginx|Microsoft-IIS|LiteSpeed|openresty|Tomcat|Jetty|PHP)\/\d+(\.\d+)+/gi) || []))].slice(0, 5);
  const h = r.headers || {};
  out.error_page = { url: u, status: r.status, bytes: r.bytes ?? null, traces: sigs, version_strings: vers,
    hsts: !!h['strict-transport-security'], nosniff: /nosniff/i.test(h['x-content-type-options'] || ''), csp: !!h['content-security-policy'], disclosure: disclosure(h, []), md5: r.body ? U.md5(r.body) : null };
}

// ---------- domains of third-party scripts ----------
// A script from a domain nobody owns any more can be re-registered by anyone — and runs on every page of the site.
// System DNS only (NS of the registrable domain + A of the host); RDAP expiry only for unknown domains, stage=live, ≤ 5.
const resolver = new Resolver({ timeout: 4000, tries: 2 });
const dnsCode = async f => { try { const r = await f(); return { ok: true, n: r.length }; } catch (e) { return { ok: false, code: e.code || 'ERR' }; } };
async function scriptDomainsStep() {
  const byDomain = new Map();
  for (const h of scriptHosts) { const d = U.registrableDomain(h); if (!byDomain.has(d)) byDomain.set(d, h); }
  const list = [];
  for (const [domain, h] of [...byDomain.entries()].slice(0, 25)) {
    if (timeLeft() < 8000) { cutShort(L('домены сторонних скриптов — проверены не все', 'third-party script domains — partially')); break; }
    const known = U.classifyThirdParty(h);
    const rec = { domain, host: h, service: known.known ? known.name : null, platform: U.isPlatformHost(h) };
    if (rec.platform) { rec.state = 'platform'; list.push(rec); continue; } // subdomains of a hosting platform: DNS says nothing about the owner
    const ns = await dnsCode(() => resolver.resolveNs(domain));
    const a = await dnsCode(() => resolver.resolve4(h));
    rec.ns = ns.ok ? ns.n : ns.code; rec.a = a.ok ? a.n : a.code;
    if (ns.ok || a.ok) rec.state = 'registered';
    else if (ns.code === 'ENOTFOUND' && a.code === 'ENOTFOUND') { rec.state = 'unregistered'; rec.basis = 'ns_nxdomain'; }
    else if (ns.code === 'ENODATA' && a.code === 'ENOTFOUND') {
      // a resolver that answers only A queries (VPN, proxy) gives ENODATA for every NS; then NXDOMAIN on A of the
      // registrable domain itself means there is no zone (a registered domain without A answers ENODATA, not ENOTFOUND)
      const aa = h === domain ? a : await dnsCode(() => resolver.resolve4(domain));
      rec.apex_a = aa.ok ? aa.n : aa.code;
      if (aa.ok) rec.state = 'registered';
      else if (aa.code === 'ENOTFOUND') { rec.state = 'unregistered'; rec.basis = 'a_nxdomain'; }
      else rec.state = 'unknown';
    } else rec.state = 'unknown';
    list.push(rec);
  }
  // still unknown: ask dns.google for NS (only when external services are allowed, ≤ 5 domains, logged)
  const unk = list.filter(x => x.state === 'unknown');
  if (unk.length && extAllowed) {
    let asked = 0;
    for (const x of unk.slice(0, 5)) {
      if (timeLeft() < 8000) break;
      const r = await U.politeFetch(`https://dns.google/resolve?name=${encodeURIComponent(x.domain)}&type=NS`, { accept: 'application/dns-json', timeoutMs: 10000, retries: 0, lang });
      asked++;
      try {
        const j = JSON.parse(r.body || '');
        if (j.Status === 3) { x.state = 'unregistered'; x.basis = 'doh_nxdomain'; }
        else if (j.Status === 0 && (j.Answer || j.Authority || []).length) { x.state = 'registered'; x.basis = 'doh'; }
      } catch {}
    }
    if (asked) U.logExternal(RUN, 'dns.google', L(`DNS NS-запросы: домены сторонних скриптов, на которые системный DNS не ответил определённо (${asked})`, `DNS NS queries for third-party script domains the system DNS did not answer (${asked})`));
  }
  const left = list.filter(x => x.state === 'unknown');
  if (left.length) addNotChecked(L(`домены сторонних скриптов: DNS не ответил определённо, регистрацию не определили — ${left.slice(0, 5).map(x => x.domain).join(', ')}`,
    `third-party script domains: DNS gave no definite answer, registration unknown — ${left.slice(0, 5).map(x => x.domain).join(', ')}`));
  // expiry: RDAP for a few unknown domains only
  const forRdap = list.filter(x => x.state === 'registered' && !x.service).slice(0, 5);
  if (forRdap.length && !extAllowed) addNotChecked(L(`срок регистрации доменов сторонних скриптов (RDAP выключен: ${isLocal ? 'локальный адрес' : stage ? 'стадия ' + stage : 'признаки беты'})`, 'expiry of third-party script domains (RDAP off)'));
  if (forRdap.length && extAllowed && timeLeft() > 20000) {
    const boot = await U.politeFetch('https://data.iana.org/rdap/dns.json', { accept: 'application/json', timeoutMs: 15000, lang });
    U.logExternal(RUN, 'data.iana.org', L('справочник RDAP-серверов (без данных сайта)', 'RDAP bootstrap list (no site data)'));
    let services = [];
    try { services = JSON.parse(boot.body || '').services || []; } catch {}
    for (const x of forRdap) {
      if (timeLeft() < 8000) break;
      const tld = x.domain.split('.').pop();
      const svc = services.find(([tlds]) => tlds.includes(tld));
      if (!svc) { x.expiry = { checked: false, why: 'no_rdap_for_tld' }; continue; }
      const base = svc[1].find(u => u.startsWith('https:')) || svc[1][0];
      const url = base.replace(/\/?$/, '/') + 'domain/' + encodeURIComponent(x.domain);
      const r = await U.politeFetch(url, { accept: 'application/rdap+json,application/json', timeoutMs: 20000, retries: 0, lang });
      U.logExternal(RUN, U.hostOf(url), L(`RDAP: срок регистрации домена стороннего скрипта ${x.domain}`, `RDAP: expiry of third-party script domain ${x.domain}`));
      try {
        const j = JSON.parse(r.body || '');
        const exp = (j.events || []).find(e => e.eventAction === 'expiration')?.eventDate || null;
        x.expiry = { checked: true, expires: exp, days_left: exp ? Math.floor((Date.parse(exp) - Date.now()) / 86400000) : null };
      } catch { x.expiry = { checked: false, why: `RDAP ${r.status || r.error}` }; }
    }
  }
  out.script_domains = list;
}

// own scripts of the other snapshot pages (headers opens only a few pages itself): ≤ 30 files, ≤ 3 MB each, ≤ 30 MB in all
async function secretsStep() {
  const list = [];
  for (const p of (pagesJson?.selected || [])) {
    let pj; try { pj = U.readJSON(U.insideRun(RUN, 'snapshot', String(p.pid), 'page.json'), null); } catch { pj = null; }
    for (const s of pj?.scripts?.list || []) if (s?.src && /^https?:/i.test(s.src) && !U.isThirdParty(s.src, origin) && !secretsScanned.has(s.src.replace(/[?#].*$/, '')) && !list.includes(s.src)) list.push(s.src);
  }
  let bytes = 0, n = 0;
  for (const u of list) {
    if (n >= 30 || bytes > 30 * 1024 * 1024) { addNotChecked(L(`секреты в скриптах: проверено ${n} файлов из ${list.length} (лимит)`, `secrets: ${n} of ${list.length} files (limit)`)); break; }
    if (timeLeft() < 8000) { cutShort(L('секреты в скриптах — проверены не все файлы', 'secrets — partially')); break; }
    const r = await U.politeFetch(u, { accept: '*/*', timeoutMs: 20000, retries: 0, maxBytes: 3 * 1024 * 1024, lang });
    if (r.status === 429) { addNotChecked(L('секреты в скриптах: сайт ответил 429 — остановили', 'secrets: 429 — stopped')); break; }
    n++;
    if (r.status !== 200 || !r.body || looksHtml(r.body)) { secretsScanned.add(u.replace(/[?#].*$/, '')); continue; }
    bytes += r.bytes || r.body.length;
    addSecrets(r.body, u);
    if (r.truncated) out.secrets_scan.truncated = (out.secrets_scan.truncated || 0) + 1;
  }
  out.secrets_scan.from_snapshot = n;
}

const PROBES = [
  { path: '/.git/HEAD', sig: t => /^ref:\s*refs\//.test(t) || /^[0-9a-f]{40}\s*$/.test(t) },
  { path: '/.git/config', sig: t => /\[core\]/.test(t) && !looksHtml(t) },
  { path: '/.env', sig: t => /^\s*[A-Z][A-Z0-9_]{2,}\s*=/m.test(t) && !looksHtml(t) },
  { path: '/.DS_Store', sig: (t, b) => b.length > 8 && b.readUInt32BE(0) === 1 && b.toString('ascii', 4, 8) === 'Bud1' },
  { path: '/backup.zip', sig: (t, b) => b[0] === 0x50 && b[1] === 0x4b },
  { path: '/backup.tar.gz', sig: (t, b) => b[0] === 0x1f && b[1] === 0x8b },
  { path: '/dump.sql', sig: t => /(CREATE TABLE|INSERT INTO|-- MySQL dump|PostgreSQL database dump)/i.test(t) && !looksHtml(t) },
  { path: '/phpinfo.php', sig: t => /phpinfo\(\)|PHP Version \d/i.test(t) },
  { path: '/server-status', sig: t => /Apache Server Status/i.test(t) },
  { path: '/nginx_status', sig: t => /Active connections:/.test(t) && !looksHtml(t) },
  { path: '/.htaccess', sig: t => /(RewriteEngine|RewriteRule|Deny from|Require all|AuthType)/i.test(t) && !looksHtml(t) },
  { path: '/composer.json', sig: t => /"require"\s*:/.test(t) && !looksHtml(t) },
  { path: '/package.json', sig: t => /"(dependencies|devDependencies|scripts)"\s*:/.test(t) && !looksHtml(t) },
  { path: '/readme.html', cms: 'wordpress', sig: t => /WordPress/i.test(t) },
  { path: '/xmlrpc.php', cms: 'wordpress', sig: t => /XML-RPC server accepts POST requests only/i.test(t) },
  { path: '/wp-json/wp/v2/users', cms: 'wordpress', sig: t => /^\s*\[\s*\{\s*"id"\s*:/.test(t), count: t => (t.match(/"slug"\s*:/g) || []).length },
  { path: '/bitrix/admin/', cms: 'bitrix', sig: t => /bitrix/i.test(t) && /(USER_LOGIN|auth|Авторизация)/i.test(t) },
];
async function probeStep() {
  const cms = out.cms || {};
  const res = { cms: Object.keys(cms).filter(k => cms[k]), paths: [], read_limit_bytes: 2048 };
  for (const pr of PROBES) {
    if (pr.cms && !cms[pr.cms]) continue;
    if (timeLeft() < 8000) { cutShort(L('--probe: проверены не все пути (время)', '--probe: cut by time')); break; }
    // 2 KB are enough for every signature; the rest of the answer is never downloaded
    const r = await U.fetchBytes(origin + pr.path, { maxBytes: 2048, timeoutMs: 15000, accept: '*/*', maxRedirects: 3 });
    if (r.status === 429) { U.coolDownHost(host); addNotChecked(L('--probe: сайт ответил 429 — остановили', '--probe: 429 — stopped')); break; }
    const t = r.buf?.toString('utf8') || '';
    const found = r.status === 200 && !!pr.sig(t, r.buf || Buffer.alloc(0));
    // never keep contents: only presence, size and (for user listings) the count in the first 2 KB
    res.paths.push({ path: pr.path, status: r.status, found, bytes: r.total ?? r.bytes, content_type: r.headers?.['content-type'] || null, redirected: (r.chain || []).length > 1,
      same_as_404: !!(out.error_page?.md5 && r.status === 200 && U.md5(t) === out.error_page.md5), ...(pr.count && found ? { items_at_least: pr.count(t) } : {}), skipped: r.skipped || null });
  }
  out.probe = res;
}

// ---------- flags ----------
const SEV_RANK = { critical: 4, high: 3, medium: 2, low: 1, eol: 1 };
function certFlags(F, t) {
  const c = t.cert; if (!c || c.hours_left == null) return;
  const left = c.hours_left / 24; const life = c.lifetime_days || 90;
  const lifeTxt = L(`срок жизни ${Math.round(life)} дн.`, `lifetime ${Math.round(life)} d`);
  // short-lived certificates (6–47 days) always have few days left: thresholds are relative to the lifetime
  if (left < 0) F('cert-expired', 'high', L(`Сертификат истёк ${Math.ceil(-left)} дн. назад`, 'Certificate expired'));
  else if (left < Math.min(7, life * 0.15)) F('cert-expiring', 'high', L(`Сертификат истекает через ${left < 1 ? c.hours_left + ' ч' : Math.floor(left) + ' дн.'} (${lifeTxt}) — продление не сработало`, `Certificate expires in ${c.hours_left} h (${lifeTxt})`));
  else if (left < Math.min(30, life * 0.25)) F('cert-expiring', 'medium', L(`Сертификат истекает через ${Math.floor(left)} дн. (${lifeTxt}) — проверьте автопродление`, `Certificate expires in ${Math.floor(left)} days (${lifeTxt})`));
}
function buildFlags() {
  const F0 = []; const flag = (code, level, text, where = [], extra = {}) => F0.push({ code, level, text, where, ...extra });
  const t = out.tls;
  if (t?.checked) {
    certFlags(flag, t);
    // Node checks against the Mozilla root list and does not fetch AIA; Chromium of this machine is the second opinion
    const chrome = out.items.find(i => i.pid === home.pid)?.chromium_tls || null;
    const why = t.untrusted?.reasons || [];
    const WHY = { incomplete_chain: L('сервер не отдаёт промежуточный сертификат (цепочка неполная, браузеры достраивают её сами, другие клиенты — нет)', 'incomplete chain (server omits the intermediate)'),
      unknown_issuer: L('издатель не найден в списке доверенных центров', 'issuer not in the trusted list'), unknown_root: L('корневой центр не входит в список доверенных', 'root CA not trusted'),
      self_signed: L('самоподписанный сертификат', 'self-signed certificate'), expired: L('сертификат истёк', 'expired'), not_yet_valid: L('срок действия ещё не начался', 'not yet valid'),
      name_mismatch: L('имя сайта не входит в сертификат (SAN)', 'hostname not in SAN'), other: t.auth_error || '?' };
    const chromeTxt = chrome ? (chrome.trusted ? L('Chromium на этой машине доверяет', 'Chromium on this machine trusts it') : L(`Chromium тоже не открыл (${chrome.error || chrome.state})`, `Chromium refused too (${chrome.error || chrome.state})`)) : L('Chromium не проверял', 'no Chromium check');
    if (!t.authorized || !t.hostname_ok) {
      flag(!t.hostname_ok ? 'cert-hostname' : 'cert-untrusted', chrome?.trusted === false || !t.hostname_ok ? 'high' : 'medium',
        L(`Сертификат не проходит проверку: ${why.map(w => WHY[w] || w).join('; ') || t.auth_error}${t.untrusted?.national_root ? ` (корень ${t.untrusted.national_root} есть не во всех браузерах)` : ''}. ${chromeTxt}.`,
          `Certificate not trusted: ${why.join(', ') || t.auth_error}. ${chromeTxt}.`),
        [], { reasons: why, chromium_trusted: chrome ? chrome.trusted : null,
          hint: L('P0 — только если и Chromium не доверяет; иначе проблема для части клиентов (P1–P2)', 'P0 only when Chromium does not trust it either') });
    }
    for (const [v, x] of Object.entries(t.old || {})) if (x.result === 'accepted') flag('tls-old', 'medium', L(`Сервер принимает ${v} (устаревший протокол)`, `Server accepts ${v}`));
    if (!t.http2) flag('no-http2', 'low', L(`HTTP/2 не согласуется (ALPN: ${t.alpn || 'нет'})`, `No HTTP/2 via ALPN (${t.alpn || 'none'})`));
  }
  const h = out.home;
  const homeItem = out.items.find(i => i.pid === home.pid);
  if (h && isHttps) {
    if (!h.hsts) flag('no-hsts', 'medium', L('Нет Strict-Transport-Security', 'No HSTS'));
    else if (h.hsts.max_age != null && h.hsts.max_age < 15552000) flag('hsts-short', 'low', L(`HSTS max-age ${h.hsts.max_age} < 180 дней`, `HSTS max-age ${h.hsts.max_age} < 180 days`));
    const bare = (homeItem?.redirect_hops || []).filter(x => x.https && !x.hsts && U.hostOf(x.url) !== U.hostOf(homeItem.final_url || h.final_url || origin));
    if (h.hsts && bare.length) flag('hsts-redirect-hop', 'low', L(`Редирект ${bare[0].url} → основной адрес идёт без HSTS: первый заход на этот адрес не защищён`, `Redirect hop ${bare[0].url} has no HSTS`));
  }
  if (h) {
    const csp = h.csp, ro = h.csp_report_only;
    if (!csp && !ro) flag('no-csp', 'low', L('Нет Content-Security-Policy (ни в заголовке, ни в <meta>)', 'No CSP (header or meta)'));
    if (csp?.weak?.length) flag('csp-weak', csp.weak.includes('unsafe_inline') || csp.weak.includes('wildcard_source') ? 'medium' : 'low', L(`CSP слабая (${csp.sources.join('+')}): ${csp.weak.join(', ')}`, `Weak CSP (${csp.sources.join('+')}): ${csp.weak.join(', ')}`));
    if (csp?.ignored_in_meta?.length) flag('csp-meta-ignored', 'low', L(`В <meta> CSP директивы ${csp.ignored_in_meta.join(', ')} не работают — нужен заголовок`, `${csp.ignored_in_meta.join(', ')} are ignored in meta CSP`));
    if (!csp && ro) flag('csp-report-only', 'low', L('CSP только в режиме Report-Only', 'CSP is Report-Only only'));
    if (!h.x_frame_options && !csp?.frame_ancestors_header) flag('no-frame-protection', 'low', L('Нет X-Frame-Options и frame-ancestors в заголовке (кликджекинг)', 'No clickjacking protection'));
    if (!/nosniff/i.test(h.x_content_type_options || '')) flag('no-nosniff', 'low', L('Нет X-Content-Type-Options: nosniff', 'No nosniff'));
    if (!h.referrer_policy) flag('no-referrer-policy', 'low', L('Нет Referrer-Policy', 'No Referrer-Policy'));
    const dis = (h.disclosure || []).filter(d => d.has_version);
    if (dis.length) flag('version-disclosure', 'low', L(`Раскрыты версии: ${dis.map(d => `${d.header}: ${d.value}`).join('; ')}`, `Versions disclosed: ${dis.map(d => `${d.header}: ${d.value}`).join('; ')}`));
  }
  const allCookies = [...(h?.cookies || []), ...out.items.flatMap(i => i.cookies || [])].filter((c, i, a) => a.findIndex(x => x.name === c.name) === i);
  const NAMES = { no_secure: L('нет Secure', 'no Secure'), no_httponly: L('нет HttpOnly', 'no HttpOnly'), no_samesite: L('нет SameSite', 'no SameSite'), samesite_none_without_secure: L('SameSite=None без Secure (браузер отвергнет)', 'SameSite=None without Secure') };
  const weakCookies = allCookies.map(c => ({ c, issues: cookieIssues(c) })).filter(x => x.issues.length);
  if (weakCookies.length) flag('cookie-flags', weakCookies.some(x => x.c.session_like && (x.issues.includes('no_httponly') || x.issues.includes('no_secure'))) ? 'medium' : 'low',
    L(`Cookie: ${weakCookies.slice(0, 6).map(x => `${x.c.name}${x.c.session_like ? ' (похожа на сессию)' : ''} — ${x.issues.map(i => NAMES[i]).join(', ')}`).join('; ')}`,
      `Cookies: ${weakCookies.slice(0, 6).map(x => `${x.c.name} — ${x.issues.map(i => NAMES[i]).join(', ')}`).join('; ')}`));
  for (const lib of out.libraries) {
    if (!lib.vulnerable?.length) continue;
    const top = Math.max(...lib.vulnerable.map(v => SEV_RANK[v.sev] || 1));
    const onlyEol = lib.vulnerable.every(v => v.sev === 'eol');
    flag('vulnerable-library', onlyEol ? 'low' : top >= 4 ? 'high' : top >= 2 ? 'medium' : 'low',
      L(`${lib.name} ${lib.version}: ${lib.vulnerable.map(v => `${v.ids} (${v.what}${v.fixed_in ? ', исправлено в ' + v.fixed_in : ''}${v.condition === 'app_router_unknown' ? ', если App Router' : ''})`).join('; ')}. Обновить до последнего патча ветки.`,
        `${lib.name} ${lib.version}: ${lib.vulnerable.map(v => v.ids).join('; ')}. Update to the latest patch of the branch.`),
      [], { hint: L('совпадение по номеру версии: подсказка не выше P1, P0 — только при доказанной эксплуатации', 'version match only: at most P1; P0 only when exploitation is shown'), vulns_checked: VULNS_CHECKED });
  }
  const sri = [...new Set(out.items.flatMap(i => i.sri_missing_cdn || []))];
  if (sri.length) flag('sri-missing', 'low', L(`Скрипты/стили с публичных CDN без integrity: ${sri.length}`, `CDN assets without SRI: ${sri.length}`), out.items.filter(i => i.sri_missing_cdn?.length).map(i => i.pid));
  const maps = (out.sourcemaps || []).filter(m => m.looks_like_map);
  if (maps.length) flag('sourcemaps-public', 'medium', L(`Открыты source maps: ${maps.length} (исходный код и комментарии видны всем)`, `Public source maps: ${maps.length}`));
  for (const i of out.items) {
    const mc = i.mixed_content;
    if (mc && (mc.dom_http_refs.length || mc.http_responses.length || mc.blocked.length || mc.insecure_form_actions.length)) flag('mixed-content', mc.blocked.length || mc.insecure_form_actions.length ? 'high' : 'medium', L('Смешанный контент: ресурсы или формы по http:// на https-странице', 'Mixed content'), [i.pid]);
    const unc = Object.values(i.first_party || {}).flatMap(x => x.uncompressed);
    if (unc.length) flag('no-compression', 'low', L(`Текстовые ресурсы без сжатия: ${unc.length}`, `Uncompressed text resources: ${unc.length}`), [i.pid]);
    const sc = Object.values(i.first_party || {}).flatMap(x => x.short_cache);
    if (sc.length) flag('short-cache', 'low', L(`Статика с кэшем меньше суток: ${sc.length}`, `Static assets cached < 1 day: ${sc.length}`), [i.pid]);
  }
  for (const c of out.cors || []) {
    if (c.verdict === 'reflects_with_credentials') flag('cors-reflect-credentials', 'high', L(`CORS: ${c.url} отражает любой Origin и разрешает credentials`, `CORS reflects any Origin with credentials: ${c.url}`));
    else if (c.verdict === 'wildcard_with_credentials') flag('cors-wildcard-credentials', 'low', L(`CORS: «*» вместе с credentials (браузер отклонит, конфиг ошибочный): ${c.url}`, `CORS * with credentials: ${c.url}`));
    else if (c.verdict === 'reflects') flag('cors-reflect', 'low', L(`CORS: ${c.url} отражает любой Origin`, `CORS reflects Origin: ${c.url}`));
  }
  for (const d of out.script_domains || []) {
    if (d.state === 'unregistered') flag('script-domain-unregistered', 'high', L(`Скрипт грузится с домена ${d.domain}, которого нет в DNS: его может зарегистрировать кто угодно и выполнять свой код на сайте`, `Script from unregistered domain ${d.domain}`));
    else if (d.expiry?.days_left != null && d.expiry.days_left < 30) flag('script-domain-expiring', 'medium', L(`Домен стороннего скрипта ${d.domain} истекает через ${d.expiry.days_left} дн.`, `Third-party script domain ${d.domain} expires in ${d.expiry.days_left} days`));
  }
  const sec = out.secrets || [];
  const fmtS = list => list.slice(0, 4).map(x => `${x.type} ${x.masked} (${x.length} зн.) в ${x.where}`).join('; ');
  const real = sec.filter(x => !x.public && x.confidence === 'high'), cand = sec.filter(x => !x.public && x.confidence !== 'high'), pub = sec.filter(x => x.public);
  if (real.length) flag('secret-in-js', 'high', L(`В своих скриптах сайта ключи, которые нельзя отдавать в браузер: ${fmtS(real)}`, `Secret keys in the site's own JS: ${real.length}`), [], { hint: L('значение не сохраняли (первые 4 знака); проверить вручную и отозвать ключ', 'value not stored; verify and revoke') });
  if (cand.length) flag('secret-candidate', cand.some(x => x.confidence === 'medium') ? 'medium' : 'low', L(`Похоже на секрет в своих скриптах (проверить вручную): ${fmtS(cand)}`, `Possible secrets in own JS: ${cand.length}`));
  if (pub.length) flag('public-key-in-js', 'info', L(`Публичные ключи для браузера (не секрет; у ключей Google важны ограничения по домену): ${fmtS(pub)}`, `Browser (public) keys: ${pub.length}`));
  const ep = out.error_page;
  if (ep?.traces?.length) flag('error-page-trace', 'high', L(`Страница ошибки показывает отладку: ${ep.traces.map(x => x.kind).join(', ')}`, `Error page leaks debug info: ${ep.traces.map(x => x.kind).join(', ')}`));
  if (ep?.version_strings?.length) flag('error-page-version', 'low', L(`Страница ошибки раскрывает версию: ${ep.version_strings.join(', ')}`, `Error page shows versions: ${ep.version_strings.join(', ')}`));
  for (const p of out.probe?.paths || []) if (p.found) flag('probe-exposed', /\.env|\.git|dump|backup|phpinfo|server-status|DS_Store/.test(p.path) ? 'high' : 'medium',
    L(`Открыт служебный путь ${p.path} (код ${p.status}, ${U.fmtBytes(p.bytes)}${p.items_at_least != null ? `, записей не меньше ${p.items_at_least}` : ''})`, `Exposed path ${p.path}`));
  return F0;
}

// ---------- output ----------
function computeCsp() {
  if (!out.home || out.home.csp_header_value === undefined) return; // a file from an older version: keep its csp
  const homeItem = out.items.find(i => i.pid === home.pid);
  out.home.csp = analyzeCsp(out.home.csp_header_value, homeItem?.csp_meta || []);
}
function writeAll(partial) {
  out.generated = U.nowIso();
  out.partial = partial; out.resume = partial ? { done: [...done] } : null;
  out.pages = out.items.map(i => i.pid);
  refreshVulns();
  computeCsp();
  out.flags = buildFlags();
  const lv = { high: 0, medium: 0, low: 0, info: 0 }; for (const f of out.flags) lv[f.level]++;
  out.summary = { flags: lv, libraries: out.libraries.length, vulnerable_libraries: out.libraries.filter(l => l.vulnerable.length).length, vulns_checked: VULNS_CHECKED,
    probe: !!out.probe, probe_refused: !!args.probe && !probeAllowed };
  const doc = { ...out };
  // what the next call needs to continue; query strings stay out of the file
  if (partial) { doc._maps = [...mapCandidates].map(u => u.replace(/\?.*$/, '')); doc._cors = [...corsCandidates].filter(u => !u.includes('?')); doc._script_hosts = [...scriptHosts]; doc._secrets_scanned = [...secretsScanned]; }
  U.writeJSON(OUT, doc);
}
function summaryLines(partial) {
  const t = out.tls, h = out.home;
  const lines = [`${L('Безопасность (пассивно)', 'Security (passive)')} · ${host}${partial ? L(' · ЧАСТИЧНО', ' · PARTIAL') : ''}`];
  if (t?.checked) lines.push(`TLS: ${t.protocol}, ALPN ${t.alpn || '—'}, ${L('сертификат', 'cert')} ${t.cert?.issuer || '?'} ${L('до', 'until')} ${t.cert?.valid_to || '?'} (${t.cert?.days_left ?? '?'} ${L('дн. из', 'days of')} ${t.cert?.lifetime_days ?? '?'}), ${L('доверие', 'trusted')}: ${t.authorized ? L('да', 'yes') : t.auth_error}; TLS 1.0 ${t.old?.['TLSv1.0']?.result}, 1.1 ${t.old?.['TLSv1.1']?.result}`);
  else if (t) lines.push(`TLS: ${L('не проверяли', 'not checked')} (${t.why})`);
  if (out.http3) lines.push(`HTTP/3 (alt-svc): ${out.http3.h3_advertised ? L('объявлен', 'advertised') : L('нет', 'no')}`);
  if (h) {
    const csp = h.csp;
    lines.push(`${L('Главная', 'Home')}: ${h.status}; HSTS ${h.hsts ? `max-age=${h.hsts.max_age}` : L('нет', 'no')}; CSP ${csp ? `${csp.sources.join('+')}${csp.weak.length ? ', ' + L('слабая', 'weak') + ': ' + csp.weak.join(',') : ''}` : h.csp_report_only ? 'Report-Only' : L('нет', 'no')}; XFO ${h.x_frame_options || L('нет', 'no')}; nosniff ${/nosniff/i.test(h.x_content_type_options || '') ? L('да', 'yes') : L('нет', 'no')}; Referrer-Policy ${h.referrer_policy || L('нет', 'no')}`);
    lines.push(`COOP ${h.coop || '—'}, CORP ${h.corp || '—'}, Permissions-Policy ${h.permissions_policy ? L('есть', 'yes') : L('нет', 'no')}; ${L('раскрытие', 'disclosure')}: ${(h.disclosure || []).map(d => `${d.header}=${d.value}`).join('; ') || L('нет', 'none')}`);
  }
  for (const i of out.items) lines.push(`${i.pid}: ${i.status ?? '—'} ${i.protocol || ''}${i.load_error ? ' ' + i.load_error : ''}; ${L('сторонних хостов', '3rd-party hosts')} ${i.third_party_hosts?.length ?? 0}, SRI CDN ${L('нет у', 'missing')} ${i.sri_missing_cdn?.length ?? 0}${i.mixed_content ? `, mixed ${i.mixed_content.dom_http_refs.length + i.mixed_content.http_responses.length + i.mixed_content.blocked.length}` : ''}`);
  lines.push(`${L('Библиотеки', 'Libraries')}: ${out.libraries.length ? out.libraries.slice(0, 8).map(l => `${l.name} ${l.version}${l.vulnerable.length ? ' ⚠' : ''}`).join(', ') : L('не найдены', 'none found')} · ${L('список уязвимостей от', 'vulnerability list of')} ${VULNS_CHECKED.split('-').reverse().join('.')}`);
  if (out.sourcemaps) lines.push(`Source maps: ${L('найдено ссылок', 'refs')} ${out.sourcemaps.length}, ${L('открыто', 'public')} ${out.sourcemaps.filter(m => m.looks_like_map).length}`);
  if (out.cors?.length) lines.push(`CORS: ${out.cors.map(c => `${c.verdict}`).join(', ')}`);
  if (out.script_domains) lines.push(`${L('Домены сторонних скриптов', '3rd-party script domains')}: ${out.script_domains.length}, ${L('не зарегистрированы', 'unregistered')} ${out.script_domains.filter(d => d.state === 'unregistered').length}, ${L('срок по RDAP', 'RDAP expiry')} ${out.script_domains.filter(d => d.expiry?.checked).length}`);
  lines.push(`${L('Секреты в своих скриптах', 'Secrets in own scripts')}: ${L('файлов', 'files')} ${out.secrets_scan?.files ?? 0}, inline ${out.secrets_scan?.inline ?? 0}; ${L('найдено', 'found')} ${(out.secrets || []).filter(x => !x.public).length}${(out.secrets || []).some(x => x.public) ? L(', публичных ключей ', ', public keys ') + out.secrets.filter(x => x.public).length : ''}`);
  if (out.error_page) lines.push(`${L('Страница ошибки', 'Error page')}: ${out.error_page.status}; ${L('отладка', 'debug')}: ${out.error_page.traces.map(x => x.kind).join(', ') || L('нет', 'none')}`);
  if (out.probe) lines.push(`--probe: ${L('проверено путей', 'paths')} ${out.probe.paths.length}, ${L('открыто', 'exposed')}: ${out.probe.paths.filter(p => p.found).map(p => p.path).join(', ') || '0'}`);
  else if (args.probe && !probeAllowed) lines.push(L('--probe НЕ запускали: в RUN/brief.json нет limits.probe = true (ставит навык после подтверждения владельца сайта).', '--probe NOT run: RUN/brief.json has no limits.probe = true (the skill sets it after the site owner confirms).'));
  else lines.push(L('Служебные пути (--probe) не проверяли: только для своего сайта, по флагу и разрешению в brief.json.', 'Sensitive paths not probed (own site only: flag + brief.json permission).'));
  lines.push(`${L('Подсказки для линзы', 'Flags')}: high ${out.summary.flags.high}, medium ${out.summary.flags.medium}, low ${out.summary.flags.low}`);
  for (const f of out.flags.filter(f => f.level !== 'low').slice(0, 10)) lines.push(`  ${f.level === 'high' ? '!' : '·'} ${f.text}`.slice(0, 220));
  if (out.not_checked.length) lines.push(`${U.msg('not_checked', lang)}: ${out.not_checked.slice(0, 3).join('; ')}`);
  if (out.errors.length) lines.push(`${U.msg('errors', lang)}: ${out.errors.slice(0, 2).map(e => `${e.step || ''} ${e.error}`).join('; ').slice(0, 200)}`);
  lines.push(`${U.msg('written', lang)}: ${OUT}`);
  if (partial && !envError) lines.push(L('Частичный результат (код 75): повторите тот же вызов — продолжу.', 'Partial (exit 75): run the same command again.'));
  if (envError) lines.push(L('Браузер не запускается (код 2): проверьте окружение — node "<ROOT>/scripts/doctor.mjs".', 'Browser does not start (exit 2): check the environment with doctor.mjs.'));
  return lines.slice(0, 40);
}
function finish(partial) {
  writeAll(partial);
  const lines = summaryLines(partial);
  U.writeText(U.runPath(RUN, 'stdout', 'headers.md'), lines.join('\n') + '\n');
  U.printSummary(lines);
  U.log(RUN, L(`headers.mjs: ${partial ? 'частично' : 'готово'}${out.probe ? ' · --probe: ' + out.probe.paths.length + ' путей' : ''}${args.probe && !probeAllowed ? ' · --probe отклонён (нет limits.probe в brief.json)' : ''}`,
    `headers.mjs: ${partial ? 'partial' : 'done'}${out.probe ? ' · --probe: ' + out.probe.paths.length + ' paths' : ''}${args.probe && !probeAllowed ? ' · --probe refused (no limits.probe in brief.json)' : ''}`));
}

// ---------- main ----------
let envError = null;
async function main() {
  U.log(RUN, L(`headers.mjs: старт · ${selected.length} стр.${probeAllowed ? ' · --probe' : ''}${resuming ? ' · продолжение' : ''}`, `headers.mjs: start · ${selected.length} pages${probeAllowed ? ' · --probe' : ''}${resuming ? ' · resume' : ''}`));
  if (args.probe && !probeAllowed) addNotChecked(L('--probe отклонён: в brief.json нет limits.probe = true', '--probe refused: brief.json has no limits.probe = true'));
  let didWork = false;
  const steps = [['tls', tlsStep, 30000], ['home', homeStep, 20000]];
  for (const page of selected) steps.push([`page:${page.pid}`, async () => {
    const rec = await pageStep(page);
    const i = out.items.findIndex(x => x.pid === page.pid); if (i >= 0) out.items[i] = rec; else out.items.push(rec);
    const cms = out.cms || (out.cms = {}); for (const [k, v] of Object.entries(rec.cms_hints || {})) cms[k] = cms[k] || v;
    if ((rec.generator || []).some(g => /wordpress/i.test(g))) cms.wordpress = true;
    if (page.pid === home.pid && out.home) out.home.disclosure = [...(out.home.disclosure || []).filter(d => d.header !== 'meta generator'), ...disclosure({}, rec.generator)];
  }, 50000]);
  steps.push(['maps', mapsStep, 15000], ['cors', corsStep, 15000], ['error', errorStep, 15000], ['script_domains', scriptDomainsStep, 15000], ['secrets', secretsStep, 15000]);
  if (probeAllowed) steps.push(['probe', probeStep, 30000]);
  for (const [key, fn, minMs] of steps) {
    if (done.has(key)) continue;
    if (envError && key.startsWith('page:')) continue; // no browser: the rest of the checks still run
    if (didWork && timeLeft() < minMs) return finish(true);
    if (!key.startsWith('page:')) await closeBrowser(); // free the machine-wide slot as soon as pages are done
    U.progress(`headers: ${key}`);
    cutNote = null;
    try { await fn(); }
    catch (e) {
      // busy browser slots: stop here, the step stays undone and the next call continues
      if (e.code === 'NO_SLOT') { addNotChecked(L('браузер занят другими проверками — повторите вызов', 'browser slots busy — run again')); return finish(true); }
      if (e.code === 'LAUNCH') { envError = e; out.errors.push({ step: key, error: L('браузер не запустился: ', 'browser failed to start: ') + String(e.message || e).slice(0, 200) }); continue; }
      out.errors.push({ step: key, error: String(e.message || e).slice(0, 300) });
    }
    if (cutNote) { if (didWork) { cutNote = null; return finish(true); } addNotChecked(cutNote); cutNote = null; }
    done.add(key); didWork = true;
  }
  if (!probeAllowed && !args.probe) addNotChecked(L('служебные пути (--probe) — только по флагу для своего сайта', 'sensitive paths (--probe) — opt-in for own site'));
  if (out.home?.antibot) addNotChecked(L(`главная ответила защитой от ботов (${out.home.antibot}) — заголовки могут быть от защиты, а не от сайта`, `home answered with an anti-bot challenge (${out.home.antibot}) — headers may belong to the protection layer`));
  if (out.libraries.some(l => l.name === 'nextjs') && appRouter === null) addNotChecked(L('Next.js: App Router или Pages Router — не определили; уязвимости App Router помечены «если App Router»', 'Next.js router type unknown'));
  return finish(!!envError);
}

let code = 0;
try { await main(); code = envError ? 2 : out.partial ? 75 : 0; if (envError) console.error('headers.mjs: ' + (envError.message || envError)); }
catch (e) { console.error('headers.mjs: ' + (e?.stack || e)); try { out.errors.push({ error: String(e.message || e) }); finish(true); } catch {} code = 1; }
finally { await closeBrowser(); }
// Natural exit: on Windows, process.exit() right after fetch() can abort with a libuv assertion (exit 127).
process.exitCode = code;
setTimeout(() => process.exit(code), 3000).unref();
