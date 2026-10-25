#!/usr/bin/env node
// Revizor — perf.mjs: lab speed of key pages. Runs alone (takes every browser slot, all or nothing), last in the pipeline.
// Phone: 390×844 DPR 3, CPU×4, Slow 4G (DevTools throttling, Lighthouse "mobile" values); desktop: 1440×900 without throttling.
// Medians of several cold loads (fresh browser profile per load, HTTP cache on), LCP/CLS/INP/long tasks with our own
// PerformanceObservers (Page.addScriptToEvaluateOnNewDocument, no web-vitals). A load counts as finished only when the
// first-screen images, fonts, styles and scripts have arrived (or 30 s on the phone → settled:false). INP from real taps on
// a whitelist of toggles (summary, aria-expanded/controls, tabs, collapse, burger), never inside a cookie banner. Weight by
// type, top-15, images/fonts/video, render-blocking, LCP chain (is the file in the initial HTML), main-thread time by origin
// (CPU profile: own code / site platform / third parties), third parties (repeat with every third-party host blocked),
// cache/compression, warm cache, bfcache, JS heap and DOM size, idle main thread, white screen (filmstrip), PSI (one try).
// Every request still passes the Revizor safety net (Fetch interception) → "interception": true; compare relative values.
//
//   node perf.mjs --run "<RUN>" [--pages home,p03] [--max-pages 3] [--runs 3] [--stage live|beta|prototype]
//                 [--no-psi] [--psi-pages home,p03] [--no-inp] [--no-film] [--budget-sec 480] [--fresh] [--lang ru|en]

import { join, relative, sep } from 'node:path';
import { existsSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { Browser } from './lib/cdp.mjs';
import * as U from './lib/util.mjs';
import { imageStats, contactSheet } from './lib/img.mjs';
import { COOKIE_RE, ACCEPT_RE, BANNER_LIB, RE_SRC as CONSENT_SRC, reSrc, normText } from './privacy.mjs';

const NAME = 'perf';
const HELP = `
perf.mjs — скорость выбранных страниц (линза perf; данные для mobile и stability)

  node perf.mjs --run "<RUN>" [флаги]

Что делает (только чтение; запускается последним и один — занимает все слоты браузера разом или ждёт):
  · телефон 390×844 (DPR 3) с CPU×4 и Slow 4G (как Lighthouse mobile в DevTools: задержка 562,5 мс на запрос,
    1,44 Мбит/с вниз, 0,66 вверх) и компьютер 1440×900 без замедления;
  · главная и первая из выбранных — по 3 холодных загрузки на ширину (новый профиль браузера на каждую, кэш браузера
    включён, как у нового посетителя), медианы; остальные выбранные — по одной;
  · загрузка считается законченной, когда пришли картинки первого экрана, шрифты, стили и скрипты и LCP не меняется;
    не дождались (телефон 30 с, компьютер 15 с) → settled: false и список незавершённых запросов;
    разные элементы LCP в загрузках одной страницы → lcp_inconsistent вместо медианы LCP;
  · LCP (элемент, файл, есть ли файл в исходном HTML, задержка старта загрузки, загрузка, задержка отрисовки), FCP,
    CLS (окна сессий), TBT (по длинным задачам), TTFB, DCL, load;
  · INP: реальные касания только по переключателям (<summary>, aria-expanded, aria-controls, вкладки, collapse,
    аккордеон, бургер), до 10 взаимодействий; перед касанием — проверка, что под точкой: ссылки на другой адрес,
    tel:/mailto:, формы, всё внутри cookie-баннера и кнопки «В избранное», «Нравится», «Показать номер»,
    «Проголосовать», «Принять» не трогаются;
  · главная нить при загрузке (CPU-профиль): свой код / платформа сайта / сторонние — по хостам;
  · вес по типам, вес за первые 3 с и после прокрутки, топ-15 ресурсов, картинки (формат, вес, размер под экран, lazy
    в первом экране), шрифты (font-display, woff2, сторонние), видео (preload, poster), блокирующие CSS/JS в head,
    preload (лишние и мимо LCP), дубли файлов, несжатые текстовые ответы, слабый кэш статики, HTTP/2–3, бюджет веса;
  · сторонние хосты: вес и запросы (по обычной загрузке); повтор на телефоне с блокировкой всех сторонних хостов
    (кроме платформы сайта, шрифтов и хостов с блокирующим CSS) → разница LCP/TBT, только если элемент LCP тот же;
  · повторный заход (прогретый кэш), bfcache («Назад» без перезагрузки) и причины отказа,
    JS-куча и число DOM-узлов после загрузки и после прокрутки, занятость главной нити 5 с в простое (CPU×4),
    белый экран: кадры первого экрана раз в 300 мс до появления содержимого (лист-контакт с подписями времени);
  · PageSpeed Insights (Google): одна попытка на страницу и стратегию, только для боевого публичного сайта (stage=live,
    адрес не ведёт во внутреннюю сеть, главная без 401/403/антибота/noindex), после первой загрузки главной с кодом 200;
    ключ — из PSI_API_KEY (с ключом до 5 страниц); вызов записывается в log.md. Lighthouse заходит на сайт с серверов
    Google вместе со счётчиками сайта;
  · счётчики, коллтрекинг и чаты заблокированы страховкой во всех прогонах: их вклад в скорость видно только в PSI;
  · все запросы идут через перехватчик страховки → "interception": true; абсолютные цифры лаборатории хуже
    настоящих — сравнивать относительно (страница к странице, со сторонними и без), абсолютные брать из PSI/CrUX;
  · медленная машина (doctor.json → machine_slow или свой короткий тест) → в сводке пометка: P0–P1 по одной
    лаборатории не ставить; слот браузера перехвачен во время замера → contended: true.

Флаги:
  --run <папка>        папка прогона (обязательно)
  --pages a,b          какие страницы мерить; при готовом perf.json замеры остальных страниц сохраняются
  --max-pages N        сколько страниц мерить (по умолчанию 3; lite 2, deep 5): главная + страницы разных шаблонов
  --runs N             загрузок на ширину для главной и первой из выбранных (по умолчанию 3, lite 2)
  --stage live|beta|prototype  стадия (PSI только при live); иначе brief.json или признаки беты из pages.json
  --no-psi             без PageSpeed Insights;  --psi-pages a,b — страницы для PSI (по умолчанию главная; с ключом до 5)
  --no-inp, --no-film, --no-third-party  пропустить касания и профиль главной нити / кадры белого экрана / повтор без сторонних
  --allow-load-posts   пропускать не-GET во время загрузки (SPA, которые грузят контент POST-ом)
  --url <адрес>        если pages.json ещё нет: одна страница
  --budget-sec N       стоп до таймаута (по умолчанию 480); один блок не дольше 150 с; частичный результат и код 75,
                       повтор продолжит
  --fresh              начать заново (иначе продолжает частичный perf.json)
  --lang ru|en         язык сводки
Пишет: measure/perf.json, measure/perf/<pid>-film.jpg, stdout/perf.md. Коды: 0 готово, 75 частично, 2 аргументы/окружение, 1 сбой или ни одна загрузка не удалась.
`;

// Lighthouse "mobileSlow4G" with DevTools throttling: RTT 150 ms × 3.75 per request, 1.6 Mbit/s × 0.9, 750 kbit/s × 0.9.
const MOBILE = { key: 'mobile', width: 390, height: 844, dpr: 3, mobile: true, cpu: 4, net: { latency: 562.5, downKbps: 1474.56, upKbps: 675 } };
const DESKTOP = { key: 'desktop', width: 1440, height: 900, dpr: 1, mobile: false, cpu: 1, net: null };
const PROFILE = { m: MOBILE, d: DESKTOP };
const SLOW_MS = 300; // same scale as doctor.mjs bench
const UNIT_CAP_MS = 150000; // one block never runs longer (a Bash call is cut at 600 s)
const SETTLE_CAP = { mobile: 30000, desktop: 15000 };
const NOISE_PCT = 15; // "with / without third parties": a smaller difference is noise
const BUDGET = { mobile_bytes: 1.5 * 1048576, js_bytes: 300 * 1024 };
// words of buttons that act (send, buy, book, reveal a phone, like, vote, add, accept…): never tapped, whatever the markup.
// Cyrillic stems without \b (JS \b does not see Cyrillic letters).
const RISKY_TEXT = /(отправ|заказ|купить|куплю|оплат|в корзину|корзин|подпис|удал|выйти|войти|вход|регистр|брон|записат|запись|позвон|перезвон|звонок|заявк|оформ|скачать|избран|нрав|голос|сравн|добав|показать\s*(номер|телефон)|номер телефона|резерв|приня|принима|соглас|разреш|подтверд|поделит|оцен|задать вопрос|написать|связаться|send|submit|buy|order|pay|checkout|cart|basket|subscribe|delete|remove|log ?out|log ?in|sign|book|call|download|apply|favou?rite|wish|like|vote|compare|\badd\b|reserve|accept|agree|allow|confirm|rate|follow|share|contact|show (phone|number))/i;

const T = {
  ru: {
    title: 'perf.mjs — скорость (лаборатория Chromium; перехват запросов включён — сравнивать относительно)',
    partial: 'ЧАСТИЧНО (бюджет времени) — повторите тот же вызов, продолжит', machine: 'Машина', slow: 'медленная — P0–P1 по одной лаборатории не ставить', normal: 'обычная', test: 'тест',
    phone: 'телефон', desk: 'компьютер', runs: 'загр.', req: 'запр.', in3s: 'за 3 с', afterScroll: 'после прокрутки', s: 'с', ms: 'мс',
    lazy: 'loading=lazy', renderDelay: 'отрисован через', afterFile: 'после загрузки файла', late: 'файл найден поздно (через JS/CSS)', notInHtml: 'файла нет в исходном HTML', loadDelay: 'загрузка файла началась через', preloaded: 'есть preload', hiddenJs: 'страница скрыта до JS',
    lcpDiff: 'разные элементы LCP по загрузкам — медианы нет', unsettled: 'не дождались окончания', inp: 'INP (касания', worst: 'хуже всего', noTaps: 'безопасных переключателей не нашли', allFast: 'все отклики быстрее 16 мс', tapsWord: 'касаний', noTapOk: 'ни одно касание не прошло проверку',
    third: 'сторонние', hosts: ['хост', 'хоста', 'хостов'], without: 'без них', unreliable: 'разница со сторонними и без ненадёжна', noise: 'шум', slowerWithout: 'без них LCP хуже: страница ждёт их скрипты', warm: 'повторный заход', bf: 'bfcache',
    bfYes: 'работает', bfNo: 'нет', white: 'белый экран до', lostFrames: 'точнее нельзя: кадры терялись', flags: 'Флаги', uncompressed: 'несжатых', weakCache: 'слабый кэш', heavyImg: 'картинок > 200 КБ',
    lazyFold: 'lazy в первом экране', fontNoDisplay: 'шрифтов без font-display', blocking: 'блокирующих в head', unusedPreload: 'лишних preload', dom: 'DOM-узлов', heap: 'JS-куча', idle: 'главная нить в простое занята',
    mainThread: 'Главная нить при загрузке (телефон, CPU×4)', own: 'свой код', platform: 'платформа', thirdShort: 'сторонние', other: 'прочее',
    budget: 'Бюджет телефона', overBytes: 'вес больше 1,5 МБ', overJs: 'JS больше 300 КБ', top: 'Топ-3', psi: 'PSI', field: 'поле (CrUX)', noField: 'полевых данных нет', psiOff: 'PSI не запускали',
    counters: 'Заблокированы страховкой во всех прогонах', onlyPsi: 'их вклад виден только в PSI', contended: 'Слот браузера перехватила другая проверка во время замера — время ненадёжно, повторить с --fresh, когда машина свободна',
    noLoads: 'Ни одна загрузка не удалась — скорость не измерена (ошибки ниже)', noLoadsNc: 'скорость: ни одна загрузка страниц не удалась — цифр нет',
    written: 'Записано', errors: 'Ошибки', notChecked: 'Не проверено', more: '… остальное — в measure/perf.json', pages: 'Страницы', none: 'нет', mb: 'МБ', kb: 'КБ',
    reasonLcp: 'с блокировкой и без LCP — разные элементы', reasonSettle: 'часть загрузок не дождалась окончания',
    noteBlock: 'телефон, CPU×4 + Slow 4G; вес сторонних — по обычной загрузке; разница времени считается, только если элемент LCP один и тот же во всех загрузках; меньше 15 % — шум',
    noteInp: 'CPU×4 + Slow 4G, 390 px, касания через CDP только по переключателям', noteFilm: 'кадры раз в ~300 мс под CPU×4 + Slow 4G; кадр «пустой», если ≥ 99,3 % пикселей одного цвета',
    noteMain: 'CPU-профиль загрузки (выборка 1 мс) под CPU×4; счётчики и виджеты, отрезанные страховкой, не выполнялись',
  },
  en: {
    title: 'perf.mjs — speed (Chromium lab; request interception is on — compare relative values)',
    partial: 'PARTIAL (time budget) — rerun the same command to continue', machine: 'Machine', slow: 'slow — no P0–P1 from lab numbers alone', normal: 'normal', test: 'test',
    phone: 'phone', desk: 'desktop', runs: 'loads', req: 'req.', in3s: 'in 3 s', afterScroll: 'after scroll', s: 's', ms: 'ms',
    lazy: 'loading=lazy', renderDelay: 'painted', afterFile: 'after the file arrived', late: 'file discovered late (JS/CSS)', notInHtml: 'file is not in the initial HTML', loadDelay: 'file download started after', preloaded: 'preloaded', hiddenJs: 'page hidden until JS',
    lcpDiff: 'different LCP elements across loads — no median', unsettled: 'not finished', inp: 'INP (taps', worst: 'worst', noTaps: 'no safe toggles found', allFast: 'every response under 16 ms', tapsWord: 'taps', noTapOk: 'no tap passed the safety check',
    third: 'third parties', hosts: ['host', 'hosts', 'hosts'], without: 'without them', unreliable: 'with/without third parties difference is unreliable', noise: 'noise', slowerWithout: 'LCP is worse without them: the page waits for their scripts', warm: 'repeat visit', bf: 'bfcache',
    bfYes: 'works', bfNo: 'no', white: 'white screen until', lostFrames: 'frames were lost in between', flags: 'Flags', uncompressed: 'uncompressed', weakCache: 'weak cache', heavyImg: 'images > 200 KB',
    lazyFold: 'lazy in first screen', fontNoDisplay: 'fonts without font-display', blocking: 'render-blocking in head', unusedPreload: 'unused preloads', dom: 'DOM nodes', heap: 'JS heap', idle: 'main thread busy at idle',
    mainThread: 'Main thread during load (phone, CPU×4)', own: 'own code', platform: 'platform', thirdShort: 'third parties', other: 'other',
    budget: 'Phone budget', overBytes: 'weight over 1.5 MB', overJs: 'JS over 300 KB', top: 'Top 3', psi: 'PSI', field: 'field (CrUX)', noField: 'no field data', psiOff: 'PSI not run',
    counters: 'Blocked by the safety net in every run', onlyPsi: 'their cost shows only in PSI', contended: 'Another check took a browser slot during the measurement — timings unreliable, rerun with --fresh on an idle machine',
    noLoads: 'No page load succeeded — speed not measured (errors below)', noLoadsNc: 'speed: no page load succeeded — no numbers',
    written: 'Written', errors: 'Errors', notChecked: 'Not checked', more: '… the rest is in measure/perf.json', pages: 'Pages', none: 'none', mb: 'MB', kb: 'KB',
    reasonLcp: 'LCP is a different element with and without blocking', reasonSettle: 'some loads did not finish',
    noteBlock: 'phone, CPU×4 + Slow 4G; third-party weight from the normal load; the time difference only when the LCP element is the same in every load; under 15 % is noise',
    noteInp: 'CPU×4 + Slow 4G, 390 px, CDP taps on toggles only', noteFilm: 'frames every ~300 ms under CPU×4 + Slow 4G; a frame is "blank" when ≥ 99.3 % of pixels share one colour',
    noteMain: 'CPU profile of the load (1 ms sampling) under CPU×4; counters and widgets cut by the safety net did not run',
  },
};

// ---------- in-page code (self-contained) ----------
const PERF_INIT = `(() => { if (window.__rvPerf) return;
  const P = window.__rvPerf = { lcp: null, cls: 0, cls_total: 0, fcp: null, longtasks: [], events: [], shifts: [], hidden: [], pageshow: [], raf: 0 };
  const sel = el => { try { const p = []; let c = el; for (let d = 0; c && c.nodeType === 1 && d < 4; d++) { if (c.id && /^[A-Za-z][\\w-]{0,40}$/.test(c.id)) { p.unshift('#' + c.id); break; }
    let s = c.tagName.toLowerCase(); const cn = typeof c.className === 'string' ? c.className.split(/\\s+/).filter(x => /^[A-Za-z_][\\w-]{0,40}$/.test(x)).slice(0, 2) : []; if (cn.length) s += '.' + cn.join('.');
    p.unshift(s); if (c.tagName === 'BODY') break; c = c.parentElement; } return p.join(' > ').slice(0, 160); } catch (e) { return null; } };
  P.sel = sel;
  const obs = (type, fn, extra) => { try { new PerformanceObserver(l => { for (const e of l.getEntries()) { try { fn(e); } catch (x) {} } }).observe(Object.assign({ type, buffered: true }, extra || {})); } catch (e) {} };
  obs('largest-contentful-paint', e => { const el = e.element; P.lcp = { t: Math.round(e.startTime), size: e.size, url: e.url || null, tag: el ? el.tagName.toLowerCase() : null, sel: el ? sel(el) : null,
    loading: el && el.getAttribute ? el.getAttribute('loading') : null, fetchpriority: el && el.getAttribute ? el.getAttribute('fetchpriority') : null,
    text: !e.url && el ? String(el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60) : null }; });
  let win = 0, winStart = -1e9, last = -1e9;
  obs('layout-shift', e => { if (e.hadRecentInput) return; if (e.startTime - last > 1000 || e.startTime - winStart > 5000) { win = 0; winStart = e.startTime; }
    win += e.value; last = e.startTime; P.cls = Math.max(P.cls, win); P.cls_total += e.value;
    if (P.shifts.length < 20 && e.value >= 0.005) P.shifts.push({ t: Math.round(e.startTime), v: Math.round(e.value * 1000) / 1000, src: (e.sources || []).slice(0, 2).map(s => s.node && s.node.nodeType === 1 ? sel(s.node) : (s.node ? s.node.nodeName : null)) }); });
  obs('paint', e => { if (e.name === 'first-contentful-paint') P.fcp = Math.round(e.startTime); });
  obs('longtask', e => { if (P.longtasks.length < 400) P.longtasks.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); });
  obs('event', e => { if (!e.interactionId || P.events.length >= 200) return; P.events.push({ n: e.name, id: e.interactionId, s: Math.round(e.startTime), d: Math.round(e.duration),
    ps: Math.round(e.processingStart), pe: Math.round(e.processingEnd), target: e.target && e.target.nodeType === 1 ? sel(e.target) : null }); }, { durationThreshold: 16 });
  addEventListener('pageshow', e => P.pageshow.push(!!e.persisted));
  try { const raf = window.requestAnimationFrame; window.requestAnimationFrame = function (cb) { P.raf++; return raf.call(window, cb); }; } catch (e) {}
  // big containers hidden (opacity/visibility) at DOMContentLoaded or at load: "white screen until JS"; then watch when they show up
  const seen = []; let ticking = false;
  const tick = () => { let open = 0; seen.forEach((el, i) => { const h = P.hidden[i]; if (h.revealed !== null) return; const cs = getComputedStyle(el);
      if (parseFloat(cs.opacity) >= 0.5 && cs.visibility !== 'hidden') h.revealed = Math.round(performance.now()); else open++; });
    if (open && performance.now() < 25000) setTimeout(tick, 100); else ticking = false; };
  const scan = when => { try {
    const vw = innerWidth, vh = innerHeight; const t0 = Math.round(performance.now());
    const cands = [document.documentElement, document.body]; const kids = el => el ? [...el.children] : [];
    for (const a of kids(document.body)) { cands.push(a); for (const b of kids(a)) { cands.push(b); for (const c of kids(b)) cands.push(c); } }
    for (const el of cands.slice(0, 400)) { if (!el || el.nodeType !== 1 || /^(SCRIPT|STYLE|LINK|META|NOSCRIPT|TEMPLATE)$/.test(el.tagName) || !el.children.length) continue;
      const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
      if (r.width < vw * 0.5 || r.top > vh) continue; // height may be 0 while children are absolutely positioned
      const why = parseFloat(cs.opacity) < 0.05 ? 'opacity' : cs.visibility === 'hidden' ? 'visibility' : null;
      if (why && !seen.some(s => s === el || s.contains(el))) { seen.push(el); P.hidden.push({ sel: sel(el), why, at: t0, when, revealed: null }); } }
    if (seen.length && !ticking) { ticking = true; setTimeout(tick, 50); }
  } catch (e) {} };
  document.addEventListener('DOMContentLoaded', () => scan('dcl'), { once: true });
  addEventListener('load', () => scan('load'), { once: true });
})();`;

function READ_METRICS() {
  const P = window.__rvPerf || { longtasks: [], shifts: [], hidden: [] };
  const nav = performance.getEntriesByType('navigation')[0] || {};
  const r = x => (x === undefined || x === null || Number.isNaN(x)) ? null : Math.round(x);
  const fcp = P.fcp ?? r(performance.getEntriesByName('first-contentful-paint')[0]?.startTime);
  let tbt = 0, longMax = 0;
  for (const t of P.longtasks || []) { if (t.s >= (fcp || 0)) tbt += Math.max(0, t.d - 50); longMax = Math.max(longMax, t.d); }
  let lcpRes = null;
  if (P.lcp && P.lcp.url) {
    const e = performance.getEntriesByName(P.lcp.url).find(x => x.entryType === 'resource');
    if (e) lcpRes = { start: r(e.startTime), end: r(e.responseEnd), initiator: e.initiatorType, transfer: e.transferSize || null, render_blocking: e.renderBlockingStatus || null };
  }
  // images of the first screen that have not arrived yet (lazy ones included): the load is not over while they are on the way
  let vpInc = 0;
  try { for (const img of document.images) { if (img.complete) continue; const b = img.getBoundingClientRect(); if (b.width > 1 && b.height > 1 && b.bottom > 0 && b.top < innerHeight && b.right > 0 && b.left < innerWidth) vpInc++; } } catch (e) {}
  return { ttfb: r(nav.responseStart), dom_interactive: r(nav.domInteractive), dcl: r(nav.domContentLoadedEventEnd), load: r(nav.loadEventEnd), fcp, lcp: P.lcp, lcp_res: lcpRes,
    cls: Math.round((P.cls || 0) * 1000) / 1000, cls_total: Math.round((P.cls_total || 0) * 1000) / 1000, tbt, long_tasks: (P.longtasks || []).length, long_max: longMax,
    doc: { transfer: nav.transferSize ?? null, encoded: nav.encodedBodySize ?? null, decoded: nav.decodedBodySize ?? null, protocol: nav.nextHopProtocol || null, redirects: nav.redirectCount ?? null },
    shifts: (P.shifts || []).slice(0, 8), hidden: P.hidden || [], vp_incomplete: vpInc, now: r(performance.now()) };
}

function DETAIL() {
  const vw = innerWidth, vh = innerHeight, dpr = devicePixelRatio || 1;
  const sel = (window.__rvPerf && window.__rvPerf.sel) || (el => el.tagName.toLowerCase());
  const top = el => { const r = el.getBoundingClientRect(); return { r, y: Math.round(r.top + scrollY) }; };
  const images = [];
  for (const img of [...document.images].slice(0, 300)) {
    const { r, y } = top(img);
    images.push({ src: img.currentSrc || img.src || null, sel: sel(img), w: Math.round(r.width), h: Math.round(r.height), y, nw: img.naturalWidth, nh: img.naturalHeight,
      loading: img.getAttribute('loading'), fetchpriority: img.getAttribute('fetchpriority'), has_dims: img.hasAttribute('width') && img.hasAttribute('height'),
      srcset: !!(img.getAttribute('srcset') || img.closest('picture')), visible: r.width > 1 && r.height > 1 });
  }
  const videos = [...document.querySelectorAll('video')].slice(0, 20).map(v => { const { r, y } = top(v); const src = v.currentSrc || v.getAttribute('src') || (v.querySelector('source') ? v.querySelector('source').src : null);
    return { src, sel: sel(v), poster: v.getAttribute('poster'), preload: v.getAttribute('preload'), autoplay: v.autoplay, muted: v.muted, playsinline: v.playsInline, loop: v.loop,
      y, in_fold: r.top < vh && r.bottom > 0, w: Math.round(r.width), h: Math.round(r.height), paused: v.paused }; });
  let faces = [];
  try { faces = [...document.fonts].slice(0, 80).map(f => ({ family: String(f.family).replace(/["']/g, ''), weight: f.weight, style: f.style, display: f.display, status: f.status })); } catch (e) {}
  const links = [...document.querySelectorAll('link[rel]')].filter(l => /(^|\s)(preload|modulepreload|preconnect|dns-prefetch)(\s|$)/i.test(l.rel))
    .slice(0, 40).map(l => ({ rel: l.rel.toLowerCase(), as: l.getAttribute('as'), href: l.href, fetchpriority: l.getAttribute('fetchpriority'), media: l.getAttribute('media') }));
  const headScripts = document.head ? [...document.head.querySelectorAll('script[src]')].filter(s => !s.async && !s.defer && s.type !== 'module').map(s => s.src) : [];
  const headCss = [...document.querySelectorAll('head link[rel~="stylesheet"]')].filter(l => !l.disabled && !/^(print|not all)$/i.test((l.media || '').trim())).map(l => l.href);
  const bodySync = document.body ? [...document.body.querySelectorAll('script[src]')].filter(s => !s.async && !s.defer && s.type !== 'module').length : 0;
  const inlineCss = [...document.querySelectorAll('head style')].reduce((a, s) => a + (s.textContent || '').length, 0);
  const all = document.getElementsByTagName('*');
  let depth = 0; { const st = [[document.documentElement, 1]]; let n = 0; while (st.length && n < 60000) { const [el, d] = st.pop(); n++; if (d > depth) depth = d; for (const c of el.children) st.push([c, d + 1]); } }
  let anim = 0, animInf = 0; try { for (const a of document.getAnimations()) { if (a.playState === 'running') { anim++; const t = a.effect && a.effect.getTiming ? a.effect.getTiming() : null; if (t && t.iterations === Infinity) animInf++; } } } catch (e) {}
  let willChange = 0; for (let i = 0; i < Math.min(all.length, 3000); i++) { const w = getComputedStyle(all[i]).willChange; if (w && w !== 'auto') willChange++; }
  const canvases = [...document.querySelectorAll('canvas')].map(c => c.getBoundingClientRect()).filter(r => r.width > 1);
  const iframes = [...document.querySelectorAll('iframe')].slice(0, 20).map(f => ({ src: f.src || null, loading: f.getAttribute('loading'), y: Math.round(f.getBoundingClientRect().top + scrollY) }));
  return { vw, vh, dpr, images, videos, faces, links, head_scripts: headScripts, head_css: headCss, body_sync_scripts: bodySync, inline_css_bytes: inlineCss,
    dom_nodes: all.length, dom_depth: depth, animations: anim, animations_infinite: animInf, will_change: willChange,
    canvases: canvases.length, canvases_big: canvases.filter(r => r.width * r.height >= 0.5 * vw * vh).length, iframes,
    videos_playing_offscreen: videos.filter(v => !v.paused && !v.in_fold).length, doc_height: document.documentElement.scrollHeight };
}

// INP candidates — runs in the isolated world; LIB is BANNER_LIB from privacy.mjs (same cookie-banner finder).
// Only a whitelist of toggles; nothing inside a cookie/consent block (any position); overlays among those blocks are hidden.
function INP_CANDS(max, src, LIB) {
  const B = LIB(src);
  const RISKY = new RegExp(src.risky[0], src.risky[1]);
  const ACCEPT = new RegExp(src.accept[0], src.accept[1]);
  const sel = B.sel, norm = B.norm;
  for (const e of document.querySelectorAll('[data-rv-inp]')) e.removeAttribute('data-rv-inp');
  for (const e of document.querySelectorAll('[data-rv-consent]')) e.removeAttribute('data-rv-consent');
  const hidden = [], consent = [];
  for (const blk of B.blocks({ needVisible: false, withSig: true })) {
    const el = blk.el; el.setAttribute('data-rv-consent', '1');
    const cs = getComputedStyle(el);
    consent.push({ sel: sel(el), position: cs.position });
    if (/^(fixed|sticky|absolute)$/.test(cs.position) && cs.display !== 'none') { el.style.setProperty('display', 'none', 'important'); hidden.push(sel(el)); }
  }
  // overlays with cookie text the finder skips (text over 2500 chars): any positioned layer without page structure
  const LAYER_STRUCT = 'main, nav, h1, header, footer, article, [role=main], [role=navigation]';
  let scanned = 0;
  for (const el of document.body ? document.body.querySelectorAll('*') : []) {
    if (++scanned > 8000) break;
    if (el.closest('[data-rv-consent]') || el.querySelector('[data-rv-consent]')) continue;
    const tc = el.textContent || ''; if (tc.length > 20000 || !B.COOKIE.test(tc)) continue;
    const cs = getComputedStyle(el); if (!/^(fixed|sticky|absolute)$/.test(cs.position)) continue;
    if (el.matches(LAYER_STRUCT) || el.querySelector(LAYER_STRUCT)) continue;
    el.setAttribute('data-rv-consent', '1'); consent.push({ sel: sel(el), position: cs.position, long_text: true });
    if (cs.display !== 'none') { el.style.setProperty('display', 'none', 'important'); hidden.push(sel(el)); }
  }
  const shown = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width >= 12 && r.height >= 12 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.1; };
  const BURGER = /burger|hamburger|menu-?(?:toggle|btn|button|icon|open|trigger|switch)|nav-?(?:toggle|toggler|btn|button|trigger|icon)|navbar-toggler|offcanvas-toggle|mobile-?menu-?(?:btn|button|toggle|trigger|icon)|menu__(?:toggle|btn|button|burger)/i;
  const MENU_LABEL = /^(?:меню|menu|открыть меню|open menu|navigation|навигация|toggle navigation|главное меню|main menu)$/i;
  const ACC_PARENT = /accordion|faq|spoiler|collapse|vopros|questions?(?:[\s_-]|$)/i;
  const ACC_SELF = /title|head|header|question|trigger|toggle|summary|vopros/i;
  const bars = el => { const k = [...el.children]; if (k.length < 2 || k.length > 4 || String(el.innerText || '').trim()) return false;
    const rs = k.map(c => c.getBoundingClientRect()); return rs.every(r => r.height > 0 && r.height <= 6 && r.width >= 12 && Math.abs(r.width - rs[0].width) <= 8); };
  const kindOf = el => {
    if (el.tagName === 'SUMMARY') return 'summary';
    if (el.getAttribute('role') === 'tab') return 'tab';
    const tg = String(el.getAttribute('data-toggle') || el.getAttribute('data-bs-toggle') || '').toLowerCase();
    const s = B.sig(el); const label = norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || '');
    const burger = BURGER.test(s) || MENU_LABEL.test(label) || bars(el);
    if (/^(?:collapse|tab|pill|dropdown|offcanvas)$/.test(tg)) return burger || tg === 'offcanvas' ? 'burger' : 'collapse';
    if (el.hasAttribute('aria-expanded')) return burger ? 'burger' : 'expanded';
    const ctl = String(el.getAttribute('aria-controls') || '').split(/\s+/)[0];
    if (ctl && document.getElementById(ctl)) return burger ? 'burger' : 'controls';
    if (burger && el.getBoundingClientRect().top < innerHeight * 0.4) return 'burger';
    if (ACC_SELF.test(s)) { for (let a = el.parentElement, d = 0; a && d < 3; a = a.parentElement, d++) if (ACC_PARENT.test(B.sig(a))) return 'accordion'; }
    return null;
  };
  const WEIGHT = { summary: 4, expanded: 4, burger: 4, tab: 3, collapse: 3, controls: 2, accordion: 2 };
  const nodes = document.querySelectorAll('summary, [aria-expanded], [aria-controls], [role=tab], [data-toggle], [data-bs-toggle], button, [role=button], a[href^="#"], [class*=burger i], [class*=hamburger i], [class*=toggle i], [class*=accordion i], [class*=faq i], [class*=spoiler i], [class*=question i]');
  const out = []; const perSel = new Map();
  for (const el of nodes) {
    if (out.length >= 200) break;
    const kind = kindOf(el); if (!kind) continue;
    if (el.closest('form, iframe, [data-rv-consent]')) continue;
    const link = el.closest('a[href]'); if (link && B.realHref(link)) continue; // a link to another address
    if (el.querySelector('a[href]:not([href^="#"]):not([href^="javascript"]), input, select, textarea, iframe, form')) continue; // a block with links inside is the menu itself, not its button
    if (el.matches('[type=submit], input[type=image]') || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
    const text = String(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const n = norm(text);
    // an FAQ question ("Что входит в стоимость?") on a toggle is not an action, even with an action stem inside
    const question = kind !== 'burger' && /\?\s*$/.test(text);
    if ((!question && (RISKY.test(n) || RISKY.test(norm(el.getAttribute('aria-label'))) || RISKY.test(norm(el.getAttribute('title'))))) || ACCEPT.test(n)) continue;
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect(); if (r.width * r.height > innerWidth * innerHeight * 0.4) continue; // a control, not a whole section
    const s = sel(el); const key = s + '|' + n; const c = perSel.get(s) || 0;
    if (c >= 2 || out.some(o => o.key === key)) continue;
    if (out.some(o => o.el.contains(el) || el.contains(o.el))) continue; // nested candidates: the outer one is enough
    perSel.set(s, c + 1);
    out.push({ el, key, kind, score: WEIGHT[kind], text, sel: s, menu: kind === 'burger' });
  }
  // menus open full-screen layers that cover the rest: tap them last
  out.sort((a, b) => (a.menu - b.menu) || (b.score - a.score));
  const pick = out.slice(0, max);
  pick.forEach((c, i) => c.el.setAttribute('data-rv-inp', String(i)));
  return { hidden, consent: consent.slice(0, 10), found: out.length, cands: pick.map((c, i) => ({ i, sel: c.sel, text: c.text, kind: c.kind, score: c.score })) };
}
function INP_POS(i) {
  const el = document.querySelector('[data-rv-inp="' + i + '"]'); if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
  const at = document.elementFromPoint(x, y);
  const hit = !!(at && (at === el || el.contains(at)));
  const consent = !!(at && at.closest && at.closest('[data-rv-consent]'));
  // full-screen fixed layers now on screen (an opened menu or pop-up covers the next targets)
  let layers = 0; const all = document.body ? document.body.getElementsByTagName('*') : [];
  for (let k = 0; k < Math.min(all.length, 4000); k++) { const e = all[k]; const cs = getComputedStyle(e); if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.1) continue;
    const r2 = e.getBoundingClientRect(); if (r2.width * r2.height >= innerWidth * innerHeight * 0.5) layers++; }
  return { x, y, hit, consent, layers, expanded: el.getAttribute('aria-expanded'), open: el.tagName === 'SUMMARY' && el.parentElement ? el.parentElement.open : null, loc: location.href };
}
// URLs the browser can find in the initial HTML without running scripts (src, srcset, poster, preload href, inline CSS url()).
// DOMParser documents are inert: nothing is fetched or run.
function HTML_REFS(html) {
  const d = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  for (const el of d.querySelectorAll('img, source, video[poster], link[rel~="preload"], input[type=image]')) {
    if (el.closest('noscript')) continue;
    for (const a of ['src', 'srcset', 'poster', 'href', 'imagesrcset']) { const v = el.getAttribute(a); if (v) out.push(v); }
  }
  for (const el of d.querySelectorAll('[style*="url("]')) if (!el.closest('noscript')) out.push(el.getAttribute('style'));
  for (const st of d.querySelectorAll('style')) out.push(st.textContent || '');
  return out.join('\n').slice(0, 3000000);
}

// ---------- helpers ----------
const rel = (run, p) => relative(run, p).split(sep).join('/');
const isLocalHost = h => !h || h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::1]' || h === '::1';
const lower = h => Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), v]));
const round = (x, d = 0) => (x === null || x === undefined || Number.isNaN(x)) ? null : Math.round(x * 10 ** d) / 10 ** d;
const p75 = arr => { const a = arr.filter(x => typeof x === 'number').sort((x, y) => x - y); if (!a.length) return null; return a[Math.min(a.length - 1, Math.ceil(a.length * 0.75) - 1)]; };
const minmax = arr => { const a = arr.filter(x => typeof x === 'number'); return a.length ? [Math.min(...a), Math.max(...a)] : null; };
const shortUrl = u => { try { const x = new URL(u); return (x.host + x.pathname + (x.search ? '?…' : '')).slice(0, 160); } catch { return String(u).slice(0, 160); } };
const fileOf = u => { try { const p = new URL(u).pathname; return decodeURIComponent(p.split('/').filter(Boolean).pop() || '/').slice(0, 60); } catch { return String(u).slice(0, 60); } };
const samePage = (href, base) => { try { if (/^javascript:/i.test(href)) return true; const a = new URL(href, base), b = new URL(base); return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search; } catch { return false; } };
const plural = (n, f, lang) => { if (lang === 'en') return n === 1 ? f[0] : f[1]; const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? f[2] : b === 1 ? f[0] : b >= 2 && b <= 4 ? f[1] : f[2]; };
const TEXT_TYPES = new Set(['Document', 'Script', 'Stylesheet', 'XHR', 'Fetch']);
const STATIC_TYPES = new Set(['Script', 'Stylesheet', 'Image', 'Font', 'Media']);
const lcpKey = r => r?.lcp ? (r.lcp.url || r.lcp.sel || r.lcp.tag || null) : null;
const lcpName = r => r?.lcp ? (r.lcp.url ? fileOf(r.lcp.url) : r.lcp.sel || r.lcp.tag) : null;
const INP_SRC = { ...CONSENT_SRC, risky: reSrc(RISKY_TEXT) };

function cacheTtl(h) {
  const cc = String(h['cache-control'] || '').toLowerCase();
  if (/no-store/.test(cc)) return { ttl: 0, cc, no_store: true };
  const m = cc.match(/(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*(\d+)/);
  if (m) return { ttl: Number(m[1]), cc, immutable: /immutable/.test(cc) };
  if (/no-cache/.test(cc)) return { ttl: 0, cc };
  if (h.expires) { const t = Date.parse(h.expires) - Date.parse(h.date || new Date().toUTCString()); if (!Number.isNaN(t)) return { ttl: Math.max(0, Math.round(t / 1000)), cc: cc || null, expires: true }; }
  return { ttl: null, cc: cc || null };
}

// Network log of one load. st.last = wall time of the last network event (data chunks included).
function netCollector(page) {
  const reqs = new Map(); const st = { t0: null, last: Date.now() };
  const touch = () => { st.last = Date.now(); };
  const offs = [
    page.on('Network.requestWillBeSent', p => {
      touch(); if (/^(data|blob):/i.test(p.request.url)) return;
      const r = reqs.get(p.requestId) || { id: p.requestId, start: p.timestamp, wall: Date.now(), bytes: 0, decoded: 0 };
      if (p.redirectResponse) r.redirects = (r.redirects || 0) + 1;
      r.url = p.request.url; r.method = p.request.method; r.type = p.type || r.type; r.priority = p.request.initialPriority; r.initiator = p.initiator?.type || null;
      if (st.t0 === null && p.type === 'Document') st.t0 = p.timestamp;
      reqs.set(p.requestId, r);
    }),
    page.on('Network.responseReceived', p => { touch(); const r = reqs.get(p.requestId); if (!r) return; const res = p.response;
      r.status = res.status; r.mime = res.mimeType; r.headers = lower(res.headers); r.protocol = res.protocol; r.fromCache = !!(res.fromDiskCache || res.fromPrefetchCache); r.fromSW = !!res.fromServiceWorker; if (p.type) r.type = p.type; }),
    page.on('Network.dataReceived', p => { touch(); const r = reqs.get(p.requestId); if (r) r.decoded += p.dataLength || 0; }),
    page.on('Network.loadingFinished', p => { touch(); const r = reqs.get(p.requestId); if (r) { r.bytes = p.encodedDataLength || 0; r.end = p.timestamp; r.done = true; } }),
    page.on('Network.loadingFailed', p => { touch(); const r = reqs.get(p.requestId); if (r) { r.failed = p.errorText; r.cut = /BLOCKED_BY_CLIENT|ERR_ABORTED/i.test(p.errorText || '') || !!p.blockedReason; r.end = p.timestamp; } }),
    page.on('Network.requestServedFromCache', p => { const r = reqs.get(p.requestId); if (r) r.memCache = true; }),
  ];
  const pending = () => [...reqs.values()].filter(r => !r.done && !r.failed && r.end === undefined);
  return { reqs, st, pending, off: () => offs.forEach(f => { try { f(); } catch {} }) };
}

function netSummary(col, siteUrl, upToSec = null) {
  const by = {}; let bytes = 0, n = 0, b3 = 0; const third = {};
  for (const r of col.reqs.values()) {
    if (r.cut) continue;
    if (upToSec !== null && col.st.t0 !== null && r.start - col.st.t0 > upToSec) continue;
    n++; bytes += r.bytes || 0;
    const t = r.type || 'Other'; (by[t] ||= { n: 0, bytes: 0 }); by[t].n++; by[t].bytes += r.bytes || 0;
    if (col.st.t0 !== null && r.end && r.end - col.st.t0 <= 3) b3 += r.bytes || 0;
    if (U.isThirdParty(r.url, siteUrl)) { const h = U.hostOf(r.url); const x = (third[h] ||= { host: h, n: 0, bytes: 0, script_bytes: 0 }); x.n++; x.bytes += r.bytes || 0; if (t === 'Script') x.script_bytes += r.bytes || 0; }
  }
  return { requests: n, bytes, bytes_3s: b3, by_type: by, third: Object.values(third).sort((a, b) => b.bytes - a.bytes) };
}

async function getMetrics(page) {
  try { const { metrics } = await page.send('Performance.getMetrics'); return Object.fromEntries(metrics.map(m => [m.name, m.value])); } catch { return {}; }
}

async function applyProfile(page, prof, { throttle = true } = {}) {
  await page.setViewport({ width: prof.width, height: prof.height, mobile: prof.mobile, deviceScaleFactor: prof.dpr });
  let net = null;
  if (throttle && prof.net) {
    const params = { offline: false, latency: prof.net.latency, downloadThroughput: Math.round(prof.net.downKbps * 1024 / 8), uploadThroughput: Math.round(prof.net.upKbps * 1024 / 8), connectionType: 'cellular4g' };
    try { await page.send('Network.emulateNetworkConditions', params); net = 'Network.emulateNetworkConditions'; }
    catch { try { await page.send('Network.emulateNetworkConditionsByRule', { offline: false, matchedNetworkConditions: [{ urlPattern: '', latency: params.latency, downloadThroughput: params.downloadThroughput, uploadThroughput: params.uploadThroughput, connectionType: 'cellular4g' }] }); net = 'Network.emulateNetworkConditionsByRule'; } catch { net = 'failed'; } }
  }
  if (throttle && prof.cpu > 1) await page.send('Emulation.setCPUThrottlingRate', { rate: prof.cpu }).catch(() => {});
  return net;
}

// After the load event. Finished when:
//  A) LCP/FCP unchanged 1.5 s, no image/media/font/style/script/document request on the way and 1 s without any network event; or
//  B) LCP unchanged 3 s, every first-screen <img> complete, and nothing that started before LCP settled (image, font, style,
//     script, document) is still on the way — background streams, polling and carousel preloads do not hold the measurement.
// Otherwise up to maxMs → settled:false with the unfinished requests (LCP and weight may be underestimated).
const CRIT_A = new Set(['Document', 'Stylesheet', 'Script', 'Font', 'Image', 'Media']);
const CRIT_B = new Set(['Document', 'Stylesheet', 'Script', 'Font', 'Image']);
async function settle(page, col, { maxMs, deadline = Infinity }) {
  const until = Math.min(Date.now() + Math.max(0, maxMs), deadline);
  let lastKey, steadySince = Date.now(), m = null;
  for (;;) {
    m = await page.evaluate(READ_METRICS).catch(() => m);
    const key = m ? `${m.lcp?.t}|${m.lcp?.url || m.lcp?.sel}|${m.fcp}` : 'none';
    if (key !== lastKey) { lastKey = key; steadySince = Date.now(); }
    const now = Date.now(); const steady = now - steadySince;
    const pend = col.pending();
    const critA = pend.filter(r => CRIT_A.has(r.type));
    if (m && steady >= 1500 && !critA.length && now - col.st.last >= 1000) return { m, settled: true };
    const critB = pend.filter(r => CRIT_B.has(r.type) && r.wall <= steadySince);
    if (m && steady >= 3000 && !(m.vp_incomplete > 0) && !critB.length) return { m, settled: true };
    if (now >= until) return { m, settled: false, pending: critA.slice(0, 8).map(r => ({ url: shortUrl(r.url), type: r.type, received: r.decoded || 0 })), vp_incomplete: m?.vp_incomplete ?? null };
    await U.sleep(Math.min(500, Math.max(50, until - now)));
  }
}

// ---------- units ----------
const leftMs = ctx => ctx.dl - Date.now();
const capT = (ctx, ms, reserve = 0, min = 3000) => Math.max(min, Math.min(ms, leftMs(ctx) - reserve));
async function launch(ctx) { const b = await Browser.launch(); ctx.live = b; return b; }
async function closeLive(ctx, b) { try { await b.close(); } finally { if (ctx.live === b) ctx.live = null; } }

async function newRunPage(b, ctx, extra = {}) {
  // a fresh profile per load is already a cold cache; the HTTP cache stays on, as for a real first-time visitor
  const page = await b.newPage({ blockNavigation: true, allowLoadPosts: ctx.allowLoadPosts, disableCache: false, ...extra });
  await page.send('Performance.enable', { timeDomain: 'timeTicks' }).catch(() => page.send('Performance.enable').catch(() => {}));
  await page.addInitScript(PERF_INIT);
  await page.emulateMedia({ colorScheme: 'light' }).catch(() => {}); // headless inherits the OS dark mode otherwise
  return page;
}

function slimMetrics(m) {
  if (!m) return null;
  return { ttfb: m.ttfb, fcp: m.fcp, lcp: m.lcp ? m.lcp.t : null, cls: m.cls, tbt: m.tbt, dcl: m.dcl, load: m.load, long_tasks: m.long_tasks, long_max: m.long_max };
}

// Is the LCP file findable in the initial HTML (src/srcset/poster/preload/inline CSS)? snapshot/<pid>/raw.html first,
// else the body of this load's document. No extra request to the site.
async function lcpInHtml(page, col, ctx, pg, lcpUrl) {
  let html = null, source = null;
  try { const f = U.insideRun(ctx.run, 'snapshot', pg.pid, 'raw.html'); if (existsSync(f) && statSync(f).size < 8 * 1048576) { html = readFileSync(f, 'utf8'); source = 'snapshot/raw.html'; } } catch {}
  if (html === null) {
    const doc = [...col.reqs.values()].find(r => r.type === 'Document');
    if (doc) { try { const r = await page.send('Network.getResponseBody', { requestId: doc.id }, 15000); html = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body; source = 'document'; } catch {} }
  }
  if (html === null) return { in_initial_html: null, source: null };
  let u; try { u = new URL(lcpUrl, pg.url); } catch { return { in_initial_html: null, source }; }
  const refs = await page.evaluateIsolated(HTML_REFS, html.slice(0, 3000000)).catch(() => null);
  const name = (() => { try { return decodeURIComponent(u.pathname.split('/').pop() || ''); } catch { return u.pathname.split('/').pop() || ''; } })();
  const variants = [u.href, u.href.replace(/^https?:/, ''), u.pathname + u.search, u.pathname].filter(x => x && x.length > 1);
  const has = text => { const t = String(text || '').replace(/&amp;/g, '&'); return variants.some(v => t.includes(v)) || (name.length >= 5 && (t.includes(name) || t.includes(encodeURIComponent(name)))); };
  const inRefs = refs === null ? null : has(refs);
  return { in_initial_html: inRefs, mentioned_in_html: has(html), source };
}

async function loadUnit(u, ctx) {
  const prof = PROFILE[u.prof];
  const b = await launch(ctx);
  const res = { unit: u.id, pid: u.pg.pid, kind: u.kind, prof: prof.key, n: u.n || 1 };
  try {
    const blockUrls = u.blockHosts ? u.blockHosts.flatMap(h => [`*://${h}/*`, `*://${h}:*`]) : undefined;
    const page = await newRunPage(b, ctx, blockUrls ? { blockUrls } : {});
    res.throttle = await applyProfile(page, prof);
    const col = netCollector(page);
    const warn = []; page.on('Log.entryAdded', p => { const t = p.entry?.text || ''; if (/preload/i.test(t) && warn.length < 10) warn.push(t.slice(0, 300)); });
    const t1 = Date.now();
    const g = await page.goto(u.pg.url, { timeout: capT(ctx, prof.net ? 90000 : 45000, u.detail ? 25000 : 6000), waitUntil: 'load' });
    res.load_ms = Date.now() - t1;
    if (!g.ok) { res.error = g.refused || g.error || 'load failed'; return res; }
    res.status = g.status; res.timed_out = !!g.timedOut;
    const s = await settle(page, col, { maxMs: capT(ctx, prof.net ? SETTLE_CAP.mobile : SETTLE_CAP.desktop, u.detail ? 15000 : 2000, 1000), deadline: ctx.dl });
    const m = s.m;
    res.settled = s.settled; if (!s.settled) { res.pending = s.pending || []; res.vp_incomplete = s.vp_incomplete ?? null; }
    res.metrics = slimMetrics(m);
    res.lcp = m?.lcp || null; res.lcp_res = m?.lcp_res || null; res.doc = m?.doc || null; res.shifts = m?.shifts || []; res.hidden = m?.hidden || [];
    res.net = netSummary(col, u.pg.url);
    res.blocked = Object.fromEntries(Object.entries(page.blocked).filter(([, v]) => v.length).map(([k, v]) => [k, v.slice(0, 30).map(x => ({ url: shortUrl(x.url), service: x.service || null }))]));
    if (u.detail) {
      if (m?.lcp?.url) res.lcp_html = await lcpInHtml(page, col, ctx, u.pg, m.lcp.url).catch(() => ({ in_initial_html: null, source: null }));
      const m0 = await getMetrics(page);
      res.memory = { heap_mb: round((m0.JSHeapUsedSize || 0) / 1048576, 1), heap_total_mb: round((m0.JSHeapTotalSize || 0) / 1048576, 1), nodes: m0.Nodes ?? null, listeners: m0.JSEventListeners ?? null,
        documents: m0.Documents ?? null, frames: m0.Frames ?? null, layouts: m0.LayoutCount ?? null, style_recalcs: m0.RecalcStyleCount ?? null,
        task_s: round(m0.TaskDuration, 2), script_s: round(m0.ScriptDuration, 2), layout_s: round(m0.LayoutDuration, 2) };
      if (prof.cpu > 1 && u.idle && leftMs(ctx) > 25000) { // main-thread load at idle, 5 s, CPU×4 kept on (home only)
        const raf0 = await page.evaluate('window.__rvPerf ? window.__rvPerf.raf : 0').catch(() => 0);
        const a = await getMetrics(page); await U.sleep(5000); const z = await getMetrics(page);
        const raf1 = await page.evaluate('window.__rvPerf ? window.__rvPerf.raf : 0').catch(() => 0);
        res.idle = { window_s: 5, busy_pct: a.TaskDuration !== undefined ? round(100 * (z.TaskDuration - a.TaskDuration) / 5, 1) : null,
          script_pct: a.ScriptDuration !== undefined ? round(100 * (z.ScriptDuration - a.ScriptDuration) / 5, 1) : null, raf_per_s: round((raf1 - raf0) / 5, 1), cpu_slowdown: prof.cpu };
      }
      res.detail = await page.evaluate(DETAIL).catch(e => ({ error: e.message.slice(0, 200) }));
      res.requests = [...col.reqs.values()].filter(r => !r.cut).map(r => ({ url: r.url, type: r.type, mime: r.mime, status: r.status, bytes: r.bytes, decoded: r.decoded, protocol: r.protocol,
        headers: r.headers ? { 'content-encoding': r.headers['content-encoding'], 'cache-control': r.headers['cache-control'], expires: r.headers.expires, date: r.headers.date, etag: r.headers.etag ? 1 : undefined, 'last-modified': r.headers['last-modified'] ? 1 : undefined, 'content-type': r.headers['content-type'] } : null,
        from_cache: r.fromCache || r.memCache || false, start_ms: col.st.t0 !== null ? Math.round((r.start - col.st.t0) * 1000) : null, end_ms: col.st.t0 !== null && r.end ? Math.round((r.end - col.st.t0) * 1000) : null,
        priority: r.priority, initiator: r.initiator, failed: r.failed || undefined }));
      res.preload_warnings = warn;
      // after a slow scroll: lazy content, heap
      if (leftMs(ctx) > 15000) {
        await page.scrollThrough({ step: Math.round(prof.height * 1.2), pause: prof.cpu > 1 ? 200 : 120, max: 25000 }).catch(() => {});
        await U.sleep(prof.net ? 1500 : 1000);
        const after = netSummary(col, u.pg.url);
        const m1 = await getMetrics(page);
        res.after_scroll = { bytes: after.bytes, requests: after.requests, heap_mb: round((m1.JSHeapUsedSize || 0) / 1048576, 1), nodes: m1.Nodes ?? null,
          cls_total: (await page.evaluate('window.__rvPerf ? Math.round(window.__rvPerf.cls_total*1000)/1000 : null').catch(() => null)) };
      } else res.cut_by_deadline = 'scroll';
    }
    col.off();
    return res;
  } finally { await closeLive(ctx, b); }
}

async function warmUnit(u, ctx) {
  const prof = PROFILE[u.prof];
  const b = await launch(ctx);
  const res = { unit: u.id, pid: u.pg.pid, kind: 'warm', prof: prof.key };
  try {
    const page = await newRunPage(b, ctx);
    res.throttle = await applyProfile(page, prof);
    const col0 = netCollector(page);
    const g0 = await page.goto(u.pg.url, { timeout: capT(ctx, 90000, 40000), waitUntil: 'load' });
    if (!g0.ok) { res.error = g0.refused || g0.error; return res; }
    await settle(page, col0, { maxMs: capT(ctx, 10000, 30000, 1000), deadline: ctx.dl });
    col0.off();
    const col = netCollector(page);
    const t1 = Date.now();
    const g = await page.goto(u.pg.url, { timeout: capT(ctx, 90000, 8000), waitUntil: 'load' });
    res.load_ms = Date.now() - t1;
    if (!g.ok) { res.error = g.refused || g.error; return res; }
    const s = await settle(page, col, { maxMs: capT(ctx, 15000, 2000, 1000), deadline: ctx.dl });
    res.settled = s.settled;
    res.metrics = slimMetrics(s.m);
    const reqs = [...col.reqs.values()].filter(r => !r.cut);
    res.net = { requests: reqs.length, bytes: reqs.reduce((a, r) => a + (r.bytes || 0), 0),
      from_cache: reqs.filter(r => r.fromCache || r.memCache).length, revalidated_304: reqs.filter(r => r.status === 304).length,
      network_200: reqs.filter(r => r.status === 200 && !r.fromCache && !r.memCache).length };
    col.off();
    return res;
  } finally { await closeLive(ctx, b); }
}

// Self time of a CPU profile by script origin: own code (site domain), site platform (constructor/CMS CDN), third parties by host.
function profileByOrigin(profile, siteUrl, lang) {
  const nodes = new Map((profile?.nodes || []).map(n => [n.id, n]));
  const samples = profile?.samples || [], deltas = profile?.timeDeltas || [];
  const self = new Map();
  for (let i = 0; i < samples.length; i++) { const dt = deltas[i + 1] ?? 0; if (dt > 0) self.set(samples[i], (self.get(samples[i]) || 0) + dt); }
  const groups = new Map(), scripts = new Map(); let js = 0, gc = 0, program = 0, idle = 0;
  for (const [id, us] of self) {
    const cf = nodes.get(id)?.callFrame || {}; const fn = cf.functionName || '';
    if (fn === '(idle)') { idle += us; continue; }
    if (fn === '(program)') { program += us; continue; }
    if (fn === '(garbage collector)') { gc += us; continue; }
    js += us;
    const url = cf.url || '';
    let key, g;
    if (!/^https?:/i.test(url)) { key = 'other'; g = { group: 'other', name: lang === 'en' ? 'built-in / no file' : 'встроенное / без файла' }; }
    else if (!U.isThirdParty(url, siteUrl)) { key = 'first_party'; g = { group: 'first_party', host: U.hostOf(url) }; }
    else { const c = U.classifyThirdParty(url); if (c.category === 'platform') { key = 'platform:' + c.name; g = { group: 'platform', name: c.name, host: c.host }; } else { key = 'third:' + c.host; g = { group: 'third_party', name: c.name, host: c.host, category: c.category }; } }
    const x = groups.get(key) || { ...g, us: 0 }; x.us += us; groups.set(key, x);
    if (url) scripts.set(url, (scripts.get(url) || 0) + us);
  }
  const ms = us => Math.round(us / 1000);
  const gs = [...groups.values()];
  const share = grp => js ? round(100 * gs.filter(x => x.group === grp).reduce((a, x) => a + x.us, 0) / js, 1) : null;
  const by = gs.sort((a, b) => b.us - a.us).map(({ us, ...x }) => ({ ...x, ms: ms(us), pct: js ? round(100 * us / js, 1) : null }));
  return { window: 'load', samples: samples.length, js_ms: ms(js), gc_ms: ms(gc), program_ms: ms(program), idle_ms: ms(idle),
    first_party_pct: share('first_party'), platform_pct: share('platform'), third_party_pct: share('third_party'), other_pct: share('other'),
    by_origin: by.slice(0, 15), top_scripts: [...scripts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([url, us]) => ({ url: shortUrl(url), ms: ms(us), third_party: U.isThirdParty(url, siteUrl) })) };
}

// what is under the point right before a tap: anything that is not a plain toggle on this page is skipped
function tapRisk(hi, loc, kind) {
  if (!hi || hi.none) return 'nothing';
  if (hi.isIframe) return 'iframe';
  if (hi.isSubmit || hi.inForm || hi.contactForm || hi.nearContact) return 'form';
  if (hi.isConsentAccept) return 'consent';
  if (hi.href) {
    if (/^(tel|mailto|sms|whatsapp|viber|tg|skype|intent|callto):/i.test(hi.href)) return 'contact-link';
    if (!samePage(hi.href, loc)) return 'link';
  }
  const t = normText(hi.text);
  const question = kind && kind !== 'burger' && /\?\s*$/.test(String(hi.text || ''));
  if ((RISKY_TEXT.test(t) && !question) || ACCEPT_RE.test(t) || COOKIE_RE.test(t)) return 'risky-text';
  return null;
}

async function inpUnit(u, ctx) {
  const prof = MOBILE;
  const b = await launch(ctx);
  const res = { unit: u.id, pid: u.pg.pid, kind: 'inp', prof: prof.key, taps: [], hidden_layers: [] };
  try {
    const page = await newRunPage(b, ctx);
    res.throttle = await applyProfile(page, prof);
    const col = netCollector(page);
    // CPU profile of the load: whose scripts keep the main thread busy
    let profiling = false;
    try { await page.send('Profiler.enable'); await page.send('Profiler.setSamplingInterval', { interval: 1000 }); await page.send('Profiler.start'); profiling = true; } catch {}
    const g = await page.goto(u.pg.url, { timeout: capT(ctx, 90000, 40000), waitUntil: 'load' });
    if (!g.ok) { res.error = g.refused || g.error; return res; }
    await settle(page, col, { maxMs: capT(ctx, 15000, 35000, 1000), deadline: ctx.dl });
    if (profiling) {
      try { const { profile } = await page.send('Profiler.stop', {}, 30000); res.main_thread = profileByOrigin(profile, ctx.siteOf(u.pg), ctx.lang); }
      catch (e) { res.main_thread = { error: String(e.message).slice(0, 120) }; }
      await page.send('Profiler.disable').catch(() => {});
    }
    const expr = `(${INP_CANDS.toString()})(8, ${JSON.stringify(INP_SRC)}, ${BANNER_LIB.toString()})`;
    const found = await page.evaluateIsolated(expr).catch(e => ({ error: e.message }));
    if (found.error) { res.error = found.error.slice(0, 200); return res; }
    res.hidden_layers = found.hidden; res.consent_blocks = found.consent; res.candidates = found.cands.length; res.candidates_found = found.found;
    res.candidate_list = found.cands.map(c => ({ sel: c.sel, text: c.text, kind: c.kind }));
    let interactions = 0;
    const until = Math.min(Date.now() + 70000, ctx.dl - 5000);
    const check = async (i, kind) => { const pos = await page.evaluateIsolated(INP_POS, i).catch(() => null); if (!pos) return { pos: null, why: 'gone' };
      if (!pos.hit || pos.x < 0 || pos.y < 0 || pos.x > prof.width || pos.y > prof.height) return { pos, why: 'covered' };
      if (pos.consent) return { pos, why: 'consent' };
      const hi = await page.hitInfo(pos.x, pos.y).catch(() => null);
      return { pos, why: tapRisk(hi, pos.loc, kind), hi }; };
    for (const c of found.cands) {
      if (interactions >= 10 || Date.now() > until) break;
      const first = await page.evaluateIsolated(INP_POS, c.i).catch(() => null);
      if (!first) { res.taps.push({ sel: c.sel, text: c.text, kind: c.kind, result: 'gone' }); continue; }
      await U.sleep(350);
      const { pos, why } = await check(c.i, c.kind);
      if (why) { res.taps.push({ sel: c.sel, text: c.text, kind: c.kind, result: 'skipped:' + why }); continue; }
      const nav0 = page.blocked.navigation.length;
      const events0 = await page.evaluate('window.__rvPerf ? window.__rvPerf.events.length : 0').catch(() => null);
      const t = await page.tap(pos.x, pos.y);
      if (t.refused) { res.taps.push({ sel: c.sel, text: c.text, kind: c.kind, result: 'refused:' + t.refused }); continue; }
      interactions++;
      await U.sleep(900);
      const after = await page.evaluateIsolated(INP_POS, c.i).catch(() => null);
      const overlay = !!after && after.layers > pos.layers;
      const changed = !!after && (after.expanded !== pos.expanded || after.open !== pos.open || overlay);
      const tap = { sel: c.sel, text: c.text, kind: c.kind, result: 'ok', changed, overlay, events_from: events0, navigation_cut: page.blocked.navigation.length > nav0 };
      if (changed && after.hit && interactions < 10) { // close it again: a second, comparable interaction (same checks first)
        const again = await check(c.i, c.kind);
        if (!again.why) { const t2 = await page.tap(again.pos.x, again.pos.y); if (t2.ok) { interactions++; tap.closed = true; await U.sleep(900); } }
      }
      if (overlay && !tap.closed) { // an opened layer would cover the next targets: Escape, as a visitor would
        await page.key('Escape', 'Escape', 27).catch(() => {}); await U.sleep(600);
        const z = await page.evaluateIsolated(INP_POS, c.i).catch(() => null);
        tap.closed_by_escape = !!z && z.layers <= pos.layers;
      }
      res.taps.push(tap);
    }
    const ev = await page.evaluate('window.__rvPerf ? window.__rvPerf.events : []').catch(() => []);
    const byId = new Map();
    for (const e of ev) { const x = byId.get(e.id); if (!x || e.d > x.d) byId.set(e.id, e); }
    res.interactions = [...byId.values()].sort((a, b) => a.s - b.s).map(e => ({ name: e.n, ms: e.d, input_delay: Math.max(0, e.ps - e.s), processing: Math.max(0, e.pe - e.ps), presentation: Math.max(0, e.s + e.d - e.pe), target: e.target }));
    res.navigations_cut = page.blocked.navigation.length; res.writes_cut = page.blocked.write.length; res.requests_cut_after_taps = (page.blocked.interact || []).length;
    col.off();
    return res;
  } finally { await closeLive(ctx, b); }
}

async function filmUnit(u, ctx) {
  const prof = MOBILE;
  const b = await launch(ctx);
  const res = { unit: u.id, pid: u.pg.pid, kind: 'film', prof: prof.key, frames: [] };
  const dir = U.insideRun(ctx.run, 'measure', 'perf', `film-${u.pg.pid}`);
  try {
    U.ensureDir(dir);
    const page = await newRunPage(b, ctx);
    res.throttle = await applyProfile(page, prof);
    const t0 = Date.now();
    let done = false, g = null;
    const nav = page.goto(u.pg.url, { timeout: capT(ctx, 60000, 20000), waitUntil: 'load' }).then(x => { g = x; done = true; });
    const files = [];
    let k = 0, doneAt = null, same = 0, prevData = null, firstLen = null;
    const stopAt = Math.min(t0 + 12000, ctx.dl - 15000);
    while (Date.now() < stopAt) {
      if (done && doneAt === null) doneAt = Date.now();
      if (doneAt !== null && Date.now() - doneAt > 800) break;
      if (same >= 5 && firstLen !== null && prevData && prevData.length > firstLen * 1.5) break; // content painted and steady
      const t = Date.now() - t0;
      try {
        const { data } = await page.send('Page.captureScreenshot', { format: 'jpeg', quality: 50, clip: { x: 0, y: 0, width: prof.width, height: prof.height, scale: 0.25 } }, 1500);
        if (firstLen === null) firstLen = data.length;
        same = data === prevData ? same + 1 : 0; prevData = data;
        const f = join(dir, `f-${String(k++).padStart(2, '0')}.jpg`);
        writeFileSync(f, Buffer.from(data, 'base64'));
        files.push({ t, f });
      } catch { res.capture_failed = (res.capture_failed || 0) + 1; /* a frame is lost while the document commits */ }
      const wait = 300 - ((Date.now() - t0) - t);
      if (wait > 0) await U.sleep(wait);
    }
    await Promise.race([nav.catch(() => {}), U.sleep(Math.max(1000, leftMs(ctx) - 12000))]);
    res.load = g ? { ok: g.ok, ms: g.ms, status: g.status } : null;
    const m = await page.evaluate(READ_METRICS).catch(() => null);
    res.fcp = m?.fcp ?? null; res.lcp = m?.lcp?.t ?? null; res.hidden = m?.hidden || [];
    await page.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    const tool = await b.newPage({ blockNavigation: true });
    for (const x of files) {
      try {
        const s = await imageStats(tool, x.f, { sampleStep: 6, paletteSize: 2 });
        const dom = s.palette[0] || { hex: null, share: 0 };
        res.frames.push({ t: x.t, blank: dom.share >= 99.3, dominant: dom.hex, share: dom.share }); // a short line of text is ~2–4 % of the frame
      } catch { /* skip frame */ }
    }
    const firstContent = res.frames.find(f => !f.blank);
    const lastBlank = firstContent ? [...res.frames].reverse().find(f => f.blank && f.t < firstContent.t) : res.frames[res.frames.length - 1];
    res.first_content_ms = firstContent ? firstContent.t : null;
    res.last_blank_ms = lastBlank && lastBlank.blank ? lastBlank.t : null;
    // the switch happened between the last blank and the first content frame; a wide gap (lost frames) makes the moment uncertain
    const gap = res.first_content_ms !== null && res.last_blank_ms !== null ? res.first_content_ms - res.last_blank_ms : null;
    res.blank_until_ms = !res.frames.length ? null : !res.frames[0].blank ? 0 : firstContent ? (gap !== null && gap > 700 ? null : firstContent.t) : res.frames[res.frames.length - 1].t;
    if (gap !== null && gap > 700) res.uncertain_gap_ms = gap;
    if (files.length) {
      const pick = files.length > 18 ? files.filter((_, i) => i % Math.ceil(files.length / 18) === 0) : files;
      const out = U.insideRun(ctx.run, 'measure', 'perf', `${u.pg.pid}-film.jpg`);
      const cap = t => `${(t / 1000).toFixed(1).replace('.', ctx.lang === 'en' ? '.' : ',')} ${ctx.lang === 'en' ? 's' : 'с'}`;
      try { await contactSheet(tool, pick.map(x => ({ path: x.f, label: cap(x.t) })), { out, cols: 6, thumbWidth: 160, gap: 10 }); res.sheet = rel(ctx.run, out); res.sheet_times_ms = pick.map(x => x.t); } catch (e) { res.sheet_error = e.message.slice(0, 120); }
    }
    return res;
  } finally { await closeLive(ctx, b); try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

async function bfcacheUnit(u, ctx) {
  const b = await launch(ctx);
  const res = { unit: u.id, pid: u.pg.pid, kind: 'bfcache', prof: 'desktop', away: shortUrl(u.away) };
  try {
    const page = await newRunPage(b, ctx);
    await applyProfile(page, DESKTOP, { throttle: false });
    const notUsed = []; page.on('Page.backForwardCacheNotUsed', p => notUsed.push(...(p.notRestoredExplanations || [])));
    const g = await page.goto(u.pg.url, { timeout: capT(ctx, 45000, 25000), waitUntil: 'load' });
    if (!g.ok) { res.error = g.refused || g.error; return res; }
    const doc = page.responses.find(r => r.type === 'Document');
    const dh = lower(doc?.headers);
    res.no_store = /no-store/i.test(dh['cache-control'] || '');
    try {
      const { result } = await page.send('Runtime.evaluate', { expression: 'window' });
      const { listeners } = await page.send('DOMDebugger.getEventListeners', { objectId: result.objectId });
      const types = (listeners || []).map(l => l.type);
      res.unload_listeners = types.filter(t => t === 'unload').length; res.beforeunload_listeners = types.filter(t => t === 'beforeunload').length;
    } catch { res.unload_listeners = null; }
    res.onunload = await page.evaluate('typeof window.onunload === "function"').catch(() => null);
    await U.sleep(800);
    const g2 = await page.goto(u.away, { timeout: capT(ctx, 45000, 8000), waitUntil: 'load' });
    if (!g2.ok) { res.error = 'away: ' + (g2.refused || g2.error); return res; }
    await U.sleep(500);
    const hist = await page.send('Page.getNavigationHistory');
    const prev = hist.entries[hist.currentIndex - 1];
    if (!prev) { res.error = 'no history entry'; return res; }
    page.setPhase('load'); // "Back" may reload the page: allow that one document request
    try { await page.send('Page.navigateToHistoryEntry', { entryId: prev.id }); await U.sleep(2000); } finally { page.setPhase('interact'); }
    const ps = await page.evaluate('window.__rvPerf ? window.__rvPerf.pageshow : null').catch(() => null);
    res.restored = Array.isArray(ps) ? ps.includes(true) : null;
    res.reasons = notUsed.map(x => ({ type: x.type, reason: x.reason }));
    res.page_reasons = res.reasons.filter(x => x.type !== 'Circumstantial').map(x => x.reason);
    return res;
  } finally { await closeLive(ctx, b); }
}

// ---------- PSI ----------
function parsePsi(j) {
  const lr = j.lighthouseResult || {}; const a = lr.audits || {};
  const num = id => (a[id] && typeof a[id].numericValue === 'number') ? Math.round(a[id].numericValue * (id === 'cumulative-layout-shift' ? 1000 : 1)) / (id === 'cumulative-layout-shift' ? 1000 : 1) : null;
  const field = le => {
    if (!le || !le.metrics || !Object.keys(le.metrics).length) return null;
    const m = le.metrics; const g = k => m[k] ? { p75: m[k].percentile, category: m[k].category } : null;
    return { lcp_ms: g('LARGEST_CONTENTFUL_PAINT_MS'), inp_ms: g('INTERACTION_TO_NEXT_PAINT'), cls: m.CUMULATIVE_LAYOUT_SHIFT_SCORE ? { p75: m.CUMULATIVE_LAYOUT_SHIFT_SCORE.percentile / 100, category: m.CUMULATIVE_LAYOUT_SHIFT_SCORE.category } : null,
      fcp_ms: g('FIRST_CONTENTFUL_PAINT_MS'), ttfb_ms: g('EXPERIMENTAL_TIME_TO_FIRST_BYTE'), overall: le.overall_category || null, origin_fallback: !!le.origin_fallback };
  };
  const findNode = o => { if (!o || typeof o !== 'object') return null; if (o.type === 'node' && (o.selector || o.snippet)) return { selector: o.selector || null, snippet: String(o.snippet || '').slice(0, 200) };
    for (const v of Object.values(o)) { const r = findNode(v); if (r) return r; } return null; };
  const opps = Object.values(a).filter(x => x && x.score !== null && x.score < 0.9 && ((x.details && x.details.type === 'opportunity' && (x.details.overallSavingsMs > 0 || x.details.overallSavingsBytes > 0)) || (x.metricSavings && Object.values(x.metricSavings).some(v => v > 0))))
    .map(x => ({ id: x.id, title: x.title, savings_ms: Math.round(x.details?.overallSavingsMs || 0), savings_bytes: Math.round(x.details?.overallSavingsBytes || 0), metric_savings: x.metricSavings || null }))
    .sort((p, q) => (q.savings_ms - p.savings_ms) || (q.savings_bytes - p.savings_bytes)).slice(0, 10);
  return { score: typeof lr.categories?.performance?.score === 'number' ? Math.round(lr.categories.performance.score * 100) : null,
    lab: { fcp_ms: num('first-contentful-paint'), lcp_ms: num('largest-contentful-paint'), tbt_ms: num('total-blocking-time'), cls: num('cumulative-layout-shift'), si_ms: num('speed-index'), tti_ms: num('interactive') },
    field: field(j.loadingExperience), origin_field: field(j.originLoadingExperience), lcp_element: findNode(a['largest-contentful-paint-element']?.details) || null,
    opportunities: opps, runtime_error: lr.runtimeError ? { code: lr.runtimeError.code, message: String(lr.runtimeError.message || '').slice(0, 200) } : null,
    warnings: (lr.runWarnings || []).slice(0, 3).map(w => String(w).slice(0, 200)), lighthouse_version: lr.lighthouseVersion || null, fetched: lr.fetchTime || null,
    final_url: lr.finalDisplayedUrl || lr.finalUrl || null, benchmark_index: lr.environment?.benchmarkIndex ?? null };
}
async function psiCall(run, pg, strategy, lang, key) {
  const q = new URLSearchParams({ url: pg.url, strategy, category: 'performance', locale: lang === 'en' ? 'en' : 'ru' });
  if (key) q.set('key', key);
  U.logExternal(run, 'PageSpeed Insights (Google)', lang === 'en' ? `page address ${pg.url}, ${strategy}${key ? ', own API key' : ''}; Lighthouse loads the page from Google servers together with the site's counters`
    : `адрес страницы ${pg.url}, ${strategy}${key ? ', со своим ключом' : ''}; Lighthouse загрузит страницу с серверов Google вместе со счётчиками сайта`, 1);
  const t0 = Date.now();
  const r = await U.politeFetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${q}`, { accept: 'application/json', timeoutMs: 100000, retries: 0, maxBytes: 40 * 1024 * 1024 });
  const base = { pid: pg.pid, url: pg.url, strategy, ms: Date.now() - t0, api_key: !!key };
  if (!r.ok) {
    let reason = r.error || `HTTP ${r.status}`;
    try { const j = JSON.parse(r.body || '{}'); if (j.error?.message) reason = `HTTP ${r.status}: ${String(j.error.message).replace(/key=[^&\s]+/g, 'key=…').slice(0, 200)}`; } catch {}
    if (r.status === 429) reason = lang === 'en' ? (key ? 'HTTP 429: the PSI_API_KEY quota is used up' : 'HTTP 429: the shared keyless Google quota is used up — set PSI_API_KEY (free PageSpeed Insights API key)')
      : (key ? 'HTTP 429: квота ключа PSI_API_KEY исчерпана' : 'HTTP 429: общая квота Google без ключа исчерпана — задайте PSI_API_KEY (бесплатный ключ PageSpeed Insights API)');
    return { ...base, status: r.status === 429 ? 'quota' : 'error', error: reason };
  }
  try { return { ...base, status: 'ok', ...parsePsi(JSON.parse(r.body)) }; }
  catch (e) { return { ...base, status: 'error', error: 'bad JSON: ' + e.message.slice(0, 100) }; }
}

// External service policy for PSI: live stage, public address (DNS included), home not closed (401/403, anti-bot, noindex).
async function psiPolicyOf({ args, host, stage, brief, state, pagesDoc, run, home, lang }) {
  const en = lang === 'en'; const no = (e, r) => ({ allowed: false, why: en ? e : r });
  if (args.psi === false) return no('--no-psi', 'флаг --no-psi');
  if (process.env.REVIZOR_OFFLINE === '1') return no('REVIZOR_OFFLINE=1', 'REVIZOR_OFFLINE=1');
  if (isLocalHost(host) || /^[\d.]+$/.test(host) || host.includes(':') || state.flags?.private_host) return no('local or private address', 'локальный или внутренний адрес');
  if (await U.resolvesPrivate(host)) return no('the site address resolves into a private network', 'адрес сайта ведёт во внутреннюю сеть');
  if (stage !== 'live') return no(`stage ${stage}`, `стадия ${stage}`);
  if (brief.external_services && brief.external_services.psi === false) return no('brief: psi off', 'в брифе PSI выключен');
  const hp = pagesDoc?.home || pagesDoc?.selected?.find(p => p.pid === home.pid) || null;
  const hs = hp?.status ?? null;
  if (hs === 401 || hs === 403) return no(`home answers ${hs}`, `главная отвечает ${hs}`);
  if (hp?.raw?.antibot || hp?.blocked) return no('anti-bot or closed access on the home page', 'антибот или закрытый доступ на главной');
  const seo = U.readJSON(join(run, 'measure', 'seo.json'), null);
  const sh = seo?.items?.find(i => i.pid === home.pid);
  const pj = U.readJSON(join(run, 'snapshot', home.pid, 'page.json'), null);
  if (sh?.robots?.noindex === true || /noindex/i.test(String(pj?.robots || ''))) return no('the home page is closed from indexing (noindex)', 'главная закрыта от индексации (noindex)');
  return { allowed: true, why: `stage=${stage}`, note: en ? 'Lighthouse loads the page from Google servers with the site counters running' : 'Lighthouse загружает страницу с серверов Google, счётчики сайта при этом работают' };
}

// ---------- analysis ----------
function analyzeDetail(run0, siteUrl) {
  if (!run0 || !run0.detail || run0.detail.error) return null;
  const d = run0.detail; const reqs = run0.requests || [];
  const byUrl = new Map();
  for (const r of reqs) { const x = byUrl.get(r.url); if (!x) byUrl.set(r.url, { ...r }); else { x.bytes += r.bytes || 0; x.decoded += r.decoded || 0; } }
  const third = u => U.isThirdParty(u, siteUrl);
  const KB = 1024;
  // images
  const imgs = d.images.map(i => { const n = byUrl.get(i.src); return { ...i, bytes: n?.bytes ?? null, mime: n?.mime ?? null }; });
  const modern = m => /image\/(webp|avif|svg)/i.test(m || '');
  const img = { count: imgs.length, bytes: imgs.reduce((a, i) => a + (i.bytes || 0), 0),
    heavy: imgs.filter(i => i.bytes > 200 * KB).map(i => ({ url: shortUrl(i.src), bytes: i.bytes, mime: i.mime, sel: i.sel })).slice(0, 15),
    not_modern: imgs.filter(i => i.bytes > 50 * KB && i.mime && !modern(i.mime)).map(i => ({ url: shortUrl(i.src), bytes: i.bytes, mime: i.mime })).slice(0, 15),
    oversized: imgs.filter(i => i.visible && i.nw && i.w && (i.nw * i.nh) / Math.max(1, i.w * d.dpr * i.h * d.dpr) >= 2.5 && i.bytes > 30 * KB)
      .map(i => ({ url: shortUrl(i.src), natural: [i.nw, i.nh], shown: [i.w, i.h], dpr: d.dpr, bytes: i.bytes, srcset: i.srcset })).slice(0, 15),
    lazy_in_fold: imgs.filter(i => i.visible && i.loading === 'lazy' && i.y < d.vh).map(i => ({ url: shortUrl(i.src), sel: i.sel, y: i.y })).slice(0, 10),
    eager_below_fold: imgs.filter(i => i.visible && i.loading !== 'lazy' && i.y > d.vh * 2).length,
    no_dimensions: imgs.filter(i => i.visible && !i.has_dims).length };
  // fonts
  const preloadHrefs = new Set(d.links.filter(l => /preload/.test(l.rel)).map(l => l.href));
  const fontReqs = reqs.filter(r => r.type === 'Font');
  const fonts = { files: fontReqs.length, bytes: fontReqs.reduce((a, r) => a + (r.bytes || 0), 0),
    list: fontReqs.map(r => ({ url: shortUrl(r.url), bytes: r.bytes, format: (/(woff2|woff|ttf|otf|eot)(\?|$)/i.exec(r.url)?.[1] || r.mime || '').toLowerCase(), third_party: third(r.url), preloaded: preloadHrefs.has(r.url), host: U.hostOf(r.url) })).slice(0, 20),
    faces: d.faces.length, families: [...new Set(d.faces.map(f => f.family))].slice(0, 20),
    display: d.faces.reduce((a, f) => { a[f.display || 'auto'] = (a[f.display || 'auto'] || 0) + 1; return a; }, {}),
    no_display: [...new Set(d.faces.filter(f => !f.display || f.display === 'auto' || f.display === 'block').map(f => f.family))].slice(0, 15),
    not_woff2: fontReqs.filter(r => !/woff2/i.test(r.url) && !/woff2/i.test(r.mime || '')).map(r => shortUrl(r.url)).slice(0, 10),
    third_party_hosts: [...new Set(fontReqs.filter(r => third(r.url)).map(r => U.hostOf(r.url)))], failed: d.faces.filter(f => f.status === 'error').map(f => f.family).slice(0, 10) };
  // video
  const videos = d.videos.map(v => { const tot = reqs.filter(r => r.url === v.src).reduce((a, r) => a + (r.bytes || 0), 0); return { ...v, src: v.src ? shortUrl(v.src) : null, bytes: tot || null }; });
  // render-blocking
  const rb = { css: d.head_css.map(h => ({ url: shortUrl(h), bytes: byUrl.get(h)?.bytes ?? null, end_ms: byUrl.get(h)?.end_ms ?? null, third_party: third(h) })),
    js: d.head_scripts.map(h => ({ url: shortUrl(h), bytes: byUrl.get(h)?.bytes ?? null, end_ms: byUrl.get(h)?.end_ms ?? null, third_party: third(h) })),
    body_sync_scripts: d.body_sync_scripts, inline_css_bytes: d.inline_css_bytes };
  // preload
  const lcpUrl = run0.lcp?.url || null;
  const pre = d.links.filter(l => /preload/.test(l.rel));
  const preload = { links: pre.map(l => ({ as: l.as, url: shortUrl(l.href), fetchpriority: l.fetchpriority })).slice(0, 15),
    preconnect: d.links.filter(l => /preconnect|dns-prefetch/.test(l.rel)).map(l => U.hostOf(l.href)).slice(0, 10),
    unused_warnings: (run0.preload_warnings || []).filter(w => /not used/i.test(w)).map(w => shortUrl((w.match(/https?:\/\/\S+/) || [w])[0])).slice(0, 10),
    lcp_preloaded: lcpUrl ? preloadHrefs.has(lcpUrl) : null,
    image_preload_not_lcp: lcpUrl ? pre.filter(l => l.as === 'image' && l.href !== lcpUrl).map(l => shortUrl(l.href)).slice(0, 5) : [] };
  // top-15
  const top = [...byUrl.values()].sort((a, b) => (b.bytes || 0) - (a.bytes || 0)).slice(0, 15).map(r => ({ url: shortUrl(r.url), file: fileOf(r.url), type: r.type, bytes: r.bytes, decoded: r.decoded,
    host: U.hostOf(r.url), third_party: third(r.url), encoding: r.headers?.['content-encoding'] || null, cache: r.headers ? cacheTtl(r.headers).ttl : null, end_ms: r.end_ms }));
  // compression & cache
  const uncompressed = reqs.filter(r => r.status === 200 && !r.from_cache && (TEXT_TYPES.has(r.type) || /svg|json|javascript|css|html|xml|text\//i.test(r.mime || ''))
    && (r.decoded || 0) > 1400 && !/gzip|br|deflate|zstd|compress/i.test(r.headers?.['content-encoding'] || '') && !/^image\/(png|jpe?g|gif|webp|avif)/i.test(r.mime || ''))
    .map(r => ({ url: shortUrl(r.url), type: r.type, decoded: r.decoded, third_party: third(r.url) }));
  const weak = [];
  for (const r of reqs) {
    if (!STATIC_TYPES.has(r.type) || r.status !== 200 || r.from_cache || !r.headers) continue;
    const c = cacheTtl(r.headers);
    if (c.ttl === null || c.ttl < 7 * 86400) weak.push({ url: shortUrl(r.url), type: r.type, ttl_s: c.ttl, cache_control: c.cc, third_party: third(r.url) });
  }
  const docReq = reqs.find(r => r.type === 'Document');
  const protocols = {}; for (const r of reqs) if (!third(r.url) && r.protocol) protocols[r.protocol] = (protocols[r.protocol] || 0) + 1;
  // duplicates: same file name and decoded size from different URLs, or one URL loaded twice
  const dupKey = new Map(); for (const r of reqs) { if (!['Script', 'Stylesheet'].includes(r.type)) continue; const k = `${fileOf(r.url)}|${r.decoded}`; (dupKey.get(k) || dupKey.set(k, []).get(k)).push(r.url); }
  const duplicates = [...dupKey.values()].filter(v => v.length > 1).map(v => v.map(shortUrl)).slice(0, 10);
  return { images: img, fonts, videos, render_blocking: rb, preload, top, duplicates,
    cache_compression: { uncompressed: uncompressed.slice(0, 20), uncompressed_count: uncompressed.length, uncompressed_first_party: uncompressed.filter(x => !x.third_party).length,
      weak_cache: weak.slice(0, 20), weak_cache_count: weak.length, weak_cache_first_party: weak.filter(x => !x.third_party).length,
      html_cache_control: docReq?.headers?.['cache-control'] ?? null, html_etag: !!docReq?.headers?.etag, html_last_modified: !!docReq?.headers?.['last-modified'],
      html_encoding: docReq?.headers?.['content-encoding'] || null, protocols },
    dom: { nodes: d.dom_nodes, depth: d.dom_depth, iframes: d.iframes.map(f => ({ src: f.src ? shortUrl(f.src) : null, loading: f.loading, y: f.y })) },
    motion: { animations: d.animations, animations_infinite: d.animations_infinite, will_change: d.will_change, canvases: d.canvases, canvases_big: d.canvases_big, videos_playing_offscreen: d.videos_playing_offscreen },
    doc_height: d.doc_height };
}

function lcpAnalysis(r) {
  if (!r || !r.lcp) return null;
  const l = r.lcp; const res = r.lcp_res; const html = r.lcp_html || null;
  const flags = [];
  if (l.loading === 'lazy') flags.push('lazy_on_lcp');
  const renderDelay = res && typeof res.end === 'number' ? Math.max(0, l.t - res.end) : null;
  if (renderDelay !== null && renderDelay >= 800) flags.push('render_delay');
  const ttfb = r.metrics?.ttfb ?? null;
  const loadDelay = res && typeof res.start === 'number' && typeof ttfb === 'number' ? Math.max(0, res.start - ttfb) : null;
  const loadMs = res && typeof res.start === 'number' && typeof res.end === 'number' ? Math.max(0, res.end - res.start) : null;
  if (html && html.in_initial_html === false && l.url && !(res && res.initiator === 'css')) flags.push('not_in_initial_html');
  if ((res && /^(script|xmlhttprequest|fetch|other)$/.test(res.initiator || '')) || flags.includes('not_in_initial_html')) flags.push('late_discovery');
  if (res && res.initiator === 'css') flags.push('css_background');
  if (loadDelay !== null && loadDelay >= 1000) flags.push('load_delay');
  // a container hidden at DOMContentLoaded and shown later than 1 s, or later than the LCP file arrived, holds LCP back
  const hidden = (r.hidden || []).filter(h => h.revealed !== null && (h.revealed > 1000 || (res && typeof res.end === 'number' && h.revealed > res.end)));
  if (hidden.length) flags.push('hidden_until_js');
  return { ms: l.t, tag: l.tag, sel: l.sel, url: l.url ? shortUrl(l.url) : null, text: l.text, size: l.size, loading: l.loading, fetchpriority: l.fetchpriority,
    resource: res ? { start_ms: res.start, end_ms: res.end, initiator: res.initiator, bytes: res.transfer, render_blocking: res.render_blocking } : null,
    in_initial_html: html ? html.in_initial_html : null, mentioned_in_html: html ? html.mentioned_in_html ?? null : null, html_source: html ? html.source : null,
    ttfb_ms: ttfb, load_delay_ms: loadDelay, load_ms: loadMs, render_delay_ms: renderDelay, settled: r.settled !== false, flags };
}

function chooseBlockHosts(base, siteUrl) {
  // every third-party host of the first phone load, except the site's own platform/CDN and hosts serving render-blocking CSS
  const hosts = (base?.net?.third || []).map(t => t.host);
  const cssHosts = new Set((base?.detail?.head_css || []).filter(h => U.isThirdParty(h, siteUrl)).map(h => U.hostOf(h)));
  const block = [], kept = [];
  for (const h of hosts) {
    const c = U.classifyThirdParty(h);
    if (c.category === 'platform') kept.push({ host: h, why: 'platform' });
    else if (cssHosts.has(h)) kept.push({ host: h, why: 'render-blocking css' });
    else if (c.category === 'fonts') kept.push({ host: h, why: 'fonts' }); // part of the design, not a widget
    else block.push(h);
  }
  return { block, kept };
}

const diff = (a, b) => (typeof a === 'number' && typeof b === 'number') ? round(a - b, 3) : null;
const significant = (base, d) => (typeof base === 'number' && typeof d === 'number' && base > 0) ? Math.abs(d) >= base * NOISE_PCT / 100 : null;

// medians over the loads that finished (settled); different LCP elements → no LCP median, the list instead
function agg(list) {
  if (!list.length) return null;
  const settled = list.filter(r => r.settled !== false);
  const use = settled.length ? settled : list;
  const k = f => use.map(r => r.metrics[f]);
  const n = f => use.map(r => r.net?.[f]);
  const keys = [...new Set(use.map(lcpKey).filter(Boolean))];
  const inconsistent = keys.length > 1;
  const md = (arr, d = 0) => round(U.median(arr), d); // a median of two loads is their mean: keep it readable
  return { runs: list.length, settled_runs: settled.length, unsettled: list.length - settled.length, unsettled_only: !settled.length,
    median: { ttfb: md(k('ttfb')), fcp: md(k('fcp')), lcp: inconsistent ? null : md(k('lcp')), cls: md(k('cls'), 4), tbt: md(k('tbt')), dcl: md(k('dcl')), load: md(k('load')),
      bytes: md(n('bytes')), bytes_3s: md(n('bytes_3s')), requests: md(n('requests')) },
    range: { lcp: minmax(k('lcp')), fcp: minmax(k('fcp')), tbt: minmax(k('tbt')), ttfb: minmax(k('ttfb')) },
    ttfb_p90: (() => { const a = k('ttfb').filter(x => typeof x === 'number').sort((x, y) => x - y); return a.length ? a[Math.min(a.length - 1, Math.ceil(a.length * 0.9) - 1)] : null; })(),
    timed_out: list.filter(r => r.timed_out).length,
    lcp_element: !inconsistent && keys[0] ? lcpName(use.find(r => lcpKey(r) === keys[0])) : null,
    lcp_inconsistent: inconsistent ? use.map(r => ({ unit: r.unit, ms: r.metrics.lcp, element: lcpName(r), tag: r.lcp?.tag || null })) : null };
}

function buildItems(out, pages, siteOf, lang) {
  const L = T[lang];
  const items = [];
  for (const pg of pages) {
    const runs = out.runs.filter(r => r.pid === pg.pid);
    if (!runs.length) continue;
    const siteUrl = siteOf(pg);
    const loads = p => runs.filter(r => r.kind === 'load' && r.prof === p && r.metrics && !r.error);
    const mob = loads('mobile'), desk = loads('desktop');
    const firstM = runs.find(r => r.kind === 'load' && r.prof === 'mobile' && r.detail);
    const firstD = runs.find(r => r.kind === 'load' && r.prof === 'desktop' && r.detail);
    const by = r => r ? Object.fromEntries(Object.entries(r.net?.by_type || {}).map(([t, v]) => [t, v])) : null;
    const item = { pid: pg.pid, url: pg.url, template: pg.template || null, tier: pg.tier,
      mobile: agg(mob), desktop: agg(desk),
      lcp: { mobile: lcpAnalysis(firstM || mob[0]), desktop: lcpAnalysis(firstD || desk[0]) },
      weight: { mobile: firstM ? { bytes: firstM.net.bytes, requests: firstM.net.requests, bytes_3s: firstM.net.bytes_3s, after_scroll: firstM.after_scroll?.bytes ?? null, by_type: by(firstM), settled: firstM.settled !== false } : null,
        desktop: firstD ? { bytes: firstD.net.bytes, requests: firstD.net.requests, bytes_3s: firstD.net.bytes_3s, after_scroll: firstD.after_scroll?.bytes ?? null, by_type: by(firstD), settled: firstD.settled !== false } : null },
      shifts: (firstM?.shifts || []).slice(0, 5), hidden_until_js: (firstM?.hidden || []).filter(h => h.revealed === null || h.revealed > 200),
      detail: { mobile: analyzeDetail(firstM, siteUrl), desktop: analyzeDetail(firstD, siteUrl) },
      memory: firstM?.memory || firstD?.memory ? { mobile: firstM?.memory || null, mobile_after_scroll: firstM?.after_scroll ? { heap_mb: firstM.after_scroll.heap_mb, nodes: firstM.after_scroll.nodes } : null,
        desktop: firstD?.memory || null, desktop_after_scroll: firstD?.after_scroll ? { heap_mb: firstD.after_scroll.heap_mb, nodes: firstD.after_scroll.nodes } : null } : null,
      idle: firstM?.idle || null,
      blocked_by_safety: firstM?.blocked || firstD?.blocked || {},
      unsettled_loads: runs.filter(r => r.settled === false).map(r => ({ unit: r.unit, pending: r.pending || [], vp_incomplete: r.vp_incomplete ?? null })),
      contended: runs.some(r => r.contended) || undefined };
    // weight budget of the phone (norm: ≤ 1.5 MB per page, JS ≤ 300 KB compressed)
    if (firstM?.net) { const js = firstM.net.by_type?.Script?.bytes ?? 0;
      item.budget = { bytes: firstM.net.bytes, bytes_limit: BUDGET.mobile_bytes, bytes_ok: firstM.net.bytes <= BUDGET.mobile_bytes, js_bytes: js, js_limit: BUDGET.js_bytes, js_ok: js <= BUDGET.js_bytes }; }
    // third parties: weight from the normal load; time difference only for the same LCP element in every load
    const base = firstM || mob[0];
    if (base) {
      const tp = (base.net?.third || []).map(t => ({ ...t, ...(({ name, category, operator }) => ({ name, category, operator }))(U.classifyThirdParty(t.host)) }));
      const tb = runs.filter(r => r.kind === 'block3p' && r.metrics && !r.error);
      item.third_party = { hosts: tp.slice(0, 25), host_count: tp.length, bytes: tp.reduce((a, t) => a + t.bytes, 0), requests: tp.reduce((a, t) => a + t.n, 0),
        share_bytes_pct: base.net.bytes ? round(100 * tp.reduce((a, t) => a + t.bytes, 0) / base.net.bytes, 1) : null, block_test: null };
      if (tb.length) {
        const bt = agg(tb);
        const blocked = new Set(tb[0].blocked_hosts || []);
        const btp = tp.filter(t => blocked.has(t.host));
        const weight = { bytes: btp.reduce((a, t) => a + t.bytes, 0), requests: btp.reduce((a, t) => a + t.n, 0), script_bytes: btp.reduce((a, t) => a + (t.script_bytes || 0), 0), source: 'normal load' };
        const keysAll = new Set([...mob, ...tb].map(lcpKey).filter(Boolean));
        const unsettled = [...mob, ...tb].filter(r => r.settled === false).length;
        const why = keysAll.size > 1 ? L.reasonLcp : unsettled ? L.reasonSettle : !item.mobile ? 'no phone loads' : null;
        const m = item.mobile?.median;
        const delta = why ? null : { lcp: diff(m.lcp, bt.median.lcp), fcp: diff(m.fcp, bt.median.fcp), tbt: diff(m.tbt, bt.median.tbt), bytes: weight.bytes, requests: weight.requests };
        item.third_party.block_test = { runs: tb.length, blocked_hosts: tb[0].blocked_hosts || [], kept: tb[0].kept_hosts || [], median_blocked: bt.median,
          lcp_same_element: keysAll.size <= 1, settled_all: !unsettled, weight, noise_pct: NOISE_PCT, note: L.noteBlock,
          delta, delta_unreliable: why, delta_significant: delta ? { lcp: significant(m.lcp, delta.lcp), fcp: significant(m.fcp, delta.fcp), tbt: significant(m.tbt, delta.tbt) } : null,
          // LCP got clearly worse with third parties blocked: the page waits for their scripts (a dependency, not a speed-up)
          slower_without_third_party: delta ? (typeof delta.lcp === 'number' && delta.lcp < 0 && significant(m.lcp, delta.lcp) === true) : null,
          lcp_elements: why ? [...mob, ...tb].map(r => ({ unit: r.unit, element: lcpName(r), ms: r.metrics?.lcp ?? null, settled: r.settled !== false })) : undefined };
      }
    }
    const warm = runs.find(r => r.kind === 'warm' && r.metrics);
    item.warm = warm ? { prof: warm.prof, ...warm.metrics, bytes: warm.net.bytes, requests: warm.net.requests, from_cache: warm.net.from_cache, revalidated_304: warm.net.revalidated_304, network_200: warm.net.network_200, settled: warm.settled !== false } : null;
    const inp = runs.find(r => r.kind === 'inp');
    if (inp) {
      const ms = (inp.interactions || []).map(i => i.ms);
      const worst = (inp.interactions || []).slice().sort((a, b) => b.ms - a.ms)[0] || null;
      item.inp = { inp_ms: ms.length ? Math.max(...ms) : null, p75_ms: p75(ms), interactions: (inp.interactions || []).slice(0, 12), worst, taps: inp.taps || [],
        taps_ok: (inp.taps || []).filter(t => t.result === 'ok').length, candidates: inp.candidates ?? null, hidden_layers: inp.hidden_layers || [], consent_blocks: inp.consent_blocks || [],
        navigations_cut: inp.navigations_cut ?? 0, writes_cut: inp.writes_cut ?? 0, requests_cut_after_taps: inp.requests_cut_after_taps ?? 0, error: inp.error || undefined, note: L.noteInp };
      if (inp.main_thread) item.main_thread = { ...inp.main_thread, note: L.noteMain };
    }
    const film = runs.find(r => r.kind === 'film');
    if (film && !film.error && film.load?.ok !== false && (film.frames || []).length) item.white_screen = { blank_until_ms: film.blank_until_ms ?? null, last_blank_ms: film.last_blank_ms ?? null, first_content_ms: film.first_content_ms ?? null, uncertain_gap_ms: film.uncertain_gap_ms ?? null,
      capture_failed: film.capture_failed || 0, fcp_ms: film.fcp, lcp_ms: film.lcp, frames: (film.frames || []).slice(0, 50),
      sheet: film.sheet || null, sheet_times_ms: film.sheet_times_ms || null, hidden_until_js: (film.hidden || []).filter(h => h.revealed === null || h.revealed > 200), note: L.noteFilm };
    const bf = runs.find(r => r.kind === 'bfcache');
    if (bf) item.bfcache = { restored: bf.restored ?? null, page_reasons: bf.page_reasons || [], reasons: bf.reasons || [], unload_listeners: bf.unload_listeners ?? null, beforeunload_listeners: bf.beforeunload_listeners ?? null,
      onunload: bf.onunload ?? null, no_store: bf.no_store ?? null, away: bf.away, error: bf.error || undefined };
    item.errors = runs.filter(r => r.error).map(r => ({ unit: r.unit, error: String(r.error).slice(0, 160) }));
    items.push(item);
  }
  return items;
}

function buildSummary(out) {
  const it = out.items;
  const pick = (i, p) => i[p]?.median || null;
  const worst = it.filter(i => pick(i, 'mobile')?.lcp != null).sort((a, b) => b.mobile.median.lcp - a.mobile.median.lcp)[0];
  const sum = f => it.reduce((a, i) => a + (f(i) || 0), 0);
  const lf = (i, f) => i.lcp?.mobile?.flags?.includes(f) || false;
  return {
    pages: it.map(i => ({ pid: i.pid, mobile: pick(i, 'mobile'), desktop: pick(i, 'desktop'), lcp_inconsistent: !!i.mobile?.lcp_inconsistent, unsettled: i.mobile?.unsettled || 0,
      inp_ms: i.inp?.inp_ms ?? null, third_party_delta: i.third_party?.block_test?.delta || null,
      bfcache: i.bfcache ? i.bfcache.restored : null, blank_until_ms: i.white_screen?.blank_until_ms ?? null, warm_lcp: i.warm?.lcp ?? null,
      main_thread: i.main_thread && !i.main_thread.error ? { js_ms: i.main_thread.js_ms, first_party_pct: i.main_thread.first_party_pct, platform_pct: i.main_thread.platform_pct, third_party_pct: i.main_thread.third_party_pct } : null })),
    worst_lcp_mobile: worst ? { pid: worst.pid, ms: worst.mobile.median.lcp } : null,
    flags: {
      lcp_lazy: it.filter(i => lf(i, 'lazy_on_lcp') || i.lcp?.desktop?.flags?.includes('lazy_on_lcp')).map(i => i.pid),
      lcp_render_delay: it.filter(i => lf(i, 'render_delay')).map(i => i.pid),
      lcp_late_discovery: it.filter(i => lf(i, 'late_discovery')).map(i => i.pid),
      lcp_not_in_initial_html: it.filter(i => lf(i, 'not_in_initial_html')).map(i => i.pid),
      lcp_inconsistent: it.filter(i => i.mobile?.lcp_inconsistent || i.desktop?.lcp_inconsistent).map(i => i.pid),
      unsettled: it.filter(i => (i.unsettled_loads || []).length).map(i => i.pid),
      hidden_until_js: it.filter(i => (i.hidden_until_js || []).length || (i.white_screen?.hidden_until_js || []).length).map(i => i.pid),
      uncompressed: sum(i => i.detail.mobile?.cache_compression.uncompressed_first_party), weak_cache: sum(i => i.detail.mobile?.cache_compression.weak_cache_first_party),
      heavy_images: sum(i => i.detail.mobile?.images.heavy.length), lazy_in_fold: sum(i => i.detail.mobile?.images.lazy_in_fold.length),
      fonts_no_display: [...new Set(it.flatMap(i => i.detail.mobile?.fonts.no_display || []))].length, render_blocking: sum(i => (i.detail.mobile?.render_blocking.css.length || 0) + (i.detail.mobile?.render_blocking.js.length || 0)),
      unused_preload: sum(i => i.detail.mobile?.preload.unused_warnings.length), dom_nodes_max: Math.max(0, ...it.map(i => i.detail.mobile?.dom.nodes || 0)),
      bfcache_blocked: it.filter(i => i.bfcache && i.bfcache.restored === false).map(i => i.pid),
      idle_busy_max_pct: Math.max(0, ...it.map(i => i.idle?.busy_pct || 0)),
      budget_over: it.filter(i => i.budget && (!i.budget.bytes_ok || !i.budget.js_ok)).map(i => i.pid),
    },
    contended: !!out.contended, loads_ok: (out.runs || []).filter(r => r.kind === 'load' && r.metrics && !r.error).length + (out.kept_items || []).length,
    psi: (out.psi || []).map(p => ({ pid: p.pid, strategy: p.strategy, status: p.status, score: p.score ?? null, lcp_ms: p.lab?.lcp_ms ?? null, field_lcp_ms: p.field?.lcp_ms?.p75 ?? null,
      field_inp_ms: p.field?.inp_ms?.p75 ?? null, field_cls: p.field?.cls?.p75 ?? null, field: p.field ? (p.field.origin_fallback ? 'origin' : 'url') : (p.origin_field ? 'origin' : null) })),
  };
}

// ---------- summary lines ----------
function fmtS(ms, L, lang) { if (ms === null || ms === undefined) return '—'; const s = (ms / 1000).toFixed(ms < 10000 ? 1 : 0); return (lang === 'en' ? s : s.replace('.', ',')) + ' ' + L.s; }
function fmtB(b, L, lang) { if (b === null || b === undefined) return '—'; const mb = b / 1048576; const t = mb >= 1 ? `${mb.toFixed(1)} ${L.mb}` : `${Math.round(b / 1024)} ${L.kb}`; return lang === 'en' ? t : t.replace('.', ','); }
function summaryLines(out, lang, outFile) {
  const L = T[lang]; const lines = [];
  const S = ms => fmtS(ms, L, lang), B = b => fmtB(b, L, lang);
  const MS = ms => (typeof ms === 'number' && ms < 1000) ? `${Math.round(ms)} ${L.ms}` : S(ms);
  const num = x => (x === null || x === undefined) ? '—' : (lang === 'en' ? String(x) : String(x).replace('.', ','));
  const int = x => (typeof x === 'number') ? String(Math.round(x)) : '—';
  lines.push(`${L.title}${out.partial ? ' — ' + L.partial : ''}`);
  const mc = out.machine || {};
  lines.push(`${L.machine}: ${mc.slow ? L.slow : L.normal} (${L.test} ${mc.bench_ms ?? '—'} ${L.ms}, ${mc.source || '—'}) · ${L.pages}: ${out.items.map(i => i.pid).join(', ') || '—'}`);
  if (out.contended) lines.push(L.contended);
  if (!out.summary.loads_ok && !out.partial) { // no successful load: no made-up zeros
    lines.push(L.noLoads);
    if (out.errors.length) lines.push(`${L.errors}: ${out.errors.length} — ${out.errors.slice(0, 3).map(e => `${e.pid}: ${String(e.error).slice(0, 90)}`).join('; ')}`);
    if (!out.psi_policy?.allowed) lines.push(`${L.psiOff}: ${out.psi_policy?.why || '—'}`);
    lines.push(`${L.written}: ${outFile}`);
    return lines;
  }
  const pl = [], tl = []; // page lines are trimmed first so the tail (flags, PSI, path) always fits in 40 lines
  for (const i of out.items) {
    const m = i.mobile?.median, d = i.desktop?.median;
    const uns = x => x?.unsettled ? ` · ${L.unsettled}: ${x.unsettled} ${L.runs}` : '';
    if (m) {
      const lcpPart = i.mobile.lcp_inconsistent ? `LCP — (${L.lcpDiff}: ${i.mobile.lcp_inconsistent.slice(0, 3).map(x => `${String(x.element || x.tag || '—').slice(0, 24)} ${S(x.ms)}`).join('; ')})`
        : `LCP ${S(m.lcp)}${i.mobile.range.lcp && i.mobile.settled_runs > 1 ? ` (${S(i.mobile.range.lcp[0])}–${S(i.mobile.range.lcp[1])})` : ''}`;
      pl.push(`${i.pid} · ${L.phone} ×${i.mobile.runs}: ${lcpPart} · FCP ${S(m.fcp)} · CLS ${num(m.cls)} · TBT ${int(m.tbt)} ${L.ms} · TTFB ${MS(m.ttfb)} · ${B(m.bytes)} / ${int(m.requests)} ${L.req} (${L.in3s}: ${B(m.bytes_3s)})${uns(i.mobile)}`);
    }
    if (d) pl.push(`${i.pid} · ${L.desk} ×${i.desktop.runs}: LCP ${i.desktop.lcp_inconsistent ? '— (' + L.lcpDiff + ')' : S(d.lcp)} · FCP ${S(d.fcp)} · CLS ${num(d.cls)} · TBT ${int(d.tbt)} ${L.ms} · TTFB ${MS(d.ttfb)} · ${B(d.bytes)}${uns(i.desktop)}`);
    const l = i.lcp.mobile;
    if (l) {
      const bits = [];
      if (l.flags.includes('lazy_on_lcp')) bits.push(L.lazy);
      if (l.flags.includes('not_in_initial_html')) bits.push(L.notInHtml);
      else if (l.flags.includes('late_discovery')) bits.push(L.late);
      if (l.flags.includes('load_delay')) bits.push(`${L.loadDelay} ${S(l.load_delay_ms)}`);
      if (l.render_delay_ms !== null && l.render_delay_ms >= 800) bits.push(`${L.renderDelay} ${S(l.render_delay_ms)} ${L.afterFile}`);
      if (l.flags.includes('hidden_until_js')) bits.push(L.hiddenJs);
      pl.push(`${i.pid} · LCP: ${l.tag || '—'} ${l.sel ? l.sel.slice(0, 50) : ''}${l.url ? ` (${l.url.split('/').pop().slice(0, 50)}${l.resource?.bytes ? ', ' + B(l.resource.bytes) : ''})` : l.text ? ` «${l.text.slice(0, 40)}»` : ''}${bits.length ? ' — ' + bits.join('; ') : ''}`);
    }
    if (i.inp) {
      const n = i.inp.interactions.length;
      pl.push(i.inp.inp_ms !== null ? `${i.pid} · ${L.inp}: ${n}): ${i.inp.inp_ms} ${L.ms} (p75 ${i.inp.p75_ms}) · ${L.worst} ${i.inp.worst?.target ? i.inp.worst.target.slice(0, 40) : '—'}`
        : i.inp.error ? `${i.pid} · ${L.inp}): ${i.inp.error.slice(0, 80)}`
          : i.inp.taps_ok ? `${i.pid} · ${L.inp}): ${L.tapsWord} ${i.inp.taps_ok}, ${L.allFast}`
            : `${i.pid} · ${L.inp}): ${i.inp.candidates ? L.noTapOk : L.noTaps}`);
    }
    const mt = i.main_thread;
    if (mt && !mt.error && mt.js_ms >= 50) pl.push(`${i.pid} · ${L.mainThread}: JS ${S(mt.js_ms)} — ${L.own} ${num(mt.first_party_pct ?? 0)} %, ${L.platform} ${num(mt.platform_pct ?? 0)} %, ${L.thirdShort} ${num(mt.third_party_pct ?? 0)} %${mt.other_pct ? `, ${L.other} ${num(mt.other_pct)} %` : ''}`);
    const tp = i.third_party;
    const bt = tp?.block_test;
    if (tp && tp.host_count) {
      let s = `${i.pid} · ${L.third}: ${tp.host_count} ${plural(tp.host_count, L.hosts, lang)}, ${B(tp.bytes)}`;
      if (bt && bt.delta && i.mobile && bt.median_blocked) {
        const noise = k => bt.delta_significant?.[k] === false ? ` (${L.noise})` : '';
        s += ` · ${L.without} (${bt.runs} ${L.runs}): LCP ${S(i.mobile.median.lcp)} → ${S(bt.median_blocked.lcp)}${noise('lcp')}, TBT ${int(i.mobile.median.tbt)} → ${int(bt.median_blocked.tbt)} ${L.ms}${noise('tbt')}${bt.slower_without_third_party ? ` — ${L.slowerWithout}` : ''}`;
      } else if (bt && bt.delta_unreliable) s += ` · ${L.unreliable}: ${bt.delta_unreliable}`;
      pl.push(s);
    }
    const extra = [];
    if (i.warm) extra.push(`${L.warm}: LCP ${S(i.warm.lcp)}, ${B(i.warm.bytes)}`);
    if (i.bfcache) extra.push(`${L.bf}: ${i.bfcache.restored === true ? L.bfYes : i.bfcache.restored === false ? `${L.bfNo}${i.bfcache.page_reasons.length ? ' — ' + i.bfcache.page_reasons.slice(0, 2).join(', ') : ''}` : '—'}`);
    const ws = i.white_screen;
    if (ws) extra.push(ws.blank_until_ms !== null ? `${L.white} ${S(ws.blank_until_ms)}${ws.hidden_until_js?.length ? ` (${L.hiddenJs})` : ''}`
      : ws.last_blank_ms !== null && ws.first_content_ms !== null ? `${L.white} ${S(ws.last_blank_ms)}…${S(ws.first_content_ms)} (${L.lostFrames})` : `${L.white} —`);
    if (i.budget && (!i.budget.bytes_ok || !i.budget.js_ok)) extra.push(`${L.budget}: ${[!i.budget.bytes_ok && L.overBytes, !i.budget.js_ok && L.overJs].filter(Boolean).join(', ')}`);
    if (extra.length) pl.push(`${i.pid} · ${extra.join(' · ')}`);
  }
  const f = out.summary.flags;
  const mem = out.items.map(i => i.memory?.mobile_after_scroll || i.memory?.mobile).filter(Boolean);
  tl.push(`${L.flags}: ${L.uncompressed} ${f.uncompressed} · ${L.weakCache} ${f.weak_cache} · ${L.heavyImg} ${f.heavy_images} · ${L.lazyFold} ${f.lazy_in_fold} · ${L.fontNoDisplay} ${f.fonts_no_display} · ${L.blocking} ${f.render_blocking} · ${L.unusedPreload} ${f.unused_preload}`);
  tl.push(`${L.dom}: ${f.dom_nodes_max || '—'} · ${L.heap}: ${mem.length ? num(Math.max(...mem.map(m => m.heap_mb || 0))) + ' ' + L.mb : '—'} · ${L.idle}: ${num(f.idle_busy_max_pct)} % (CPU×4)`);
  const tops = (out.items[0]?.detail.mobile?.top || []).slice(0, 3);
  if (tops.length) tl.push(`${L.top} (${out.items[0].pid}): ${tops.map(t => `${t.file} ${B(t.bytes)}`).join(' · ')}`);
  if (!out.psi_policy?.allowed) tl.push(`${L.psiOff}: ${out.psi_policy?.why || '—'}`);
  for (const p of (out.psi || []).slice(0, 4)) {
    if (p.status !== 'ok') { tl.push(`${L.psi} ${p.pid} ${p.strategy}: ${p.status} — ${String(p.error || '').slice(0, 100)}`); continue; }
    const fl = p.field || p.origin_field;
    tl.push(`${L.psi} ${p.pid} ${p.strategy}: ${p.score ?? '—'}/100, LCP ${S(p.lab.lcp_ms)}, TBT ${int(p.lab.tbt_ms)} ${L.ms}, CLS ${num(p.lab.cls)} · ${L.field}: ${fl ? `LCP p75 ${S(fl.lcp_ms?.p75)}, INP ${fl.inp_ms?.p75 ?? '—'} ${L.ms}, CLS ${num(fl.cls?.p75)}${p.field ? '' : ' (origin)'}` : L.noField}${p.runtime_error ? ' · ' + p.runtime_error.code : ''}`);
  }
  const bl = [...new Set(out.items.flatMap(i => [...(i.blocked_by_safety.analytics || []), ...(i.blocked_by_safety.widget || [])].map(x => x.service || U.classifyThirdParty('https://' + x.url).name)))];
  if (bl.length) tl.push(`${L.counters}: ${bl.slice(0, 6).join(', ')} — ${L.onlyPsi}`);
  if (out.errors.length) tl.push(`${L.errors}: ${out.errors.length} — ${out.errors.slice(0, 3).map(e => `${e.pid}: ${String(e.error).slice(0, 70)}`).join('; ')}`);
  if (out.not_checked.length) tl.push(`${L.notChecked}: ${out.not_checked.slice(0, 3).join('; ').slice(0, 260)}`);
  tl.push(`${L.written}: ${outFile}`);
  const room = 40 - lines.length - tl.length;
  if (pl.length > room) { pl.length = Math.max(0, room - 1); pl.push(L.more); }
  return [...lines, ...pl, ...tl];
}

// ---------- machine ----------
function benchMs() {
  const t0 = performance.now(); let acc = 0; const arr = [];
  for (let i = 0; i < 200000; i++) arr.push({ i, s: 'x' + (i % 97), v: Math.sqrt(i) });
  arr.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.v - b.v));
  for (let i = 0; i < 3e6; i++) acc = (acc + i * 7) % 1000003;
  acc += JSON.parse(JSON.stringify(arr.slice(0, 50000))).length;
  return performance.now() - t0 + acc * 0;
}
function machineInfo(run) {
  const doc = U.readJSON(join(run, 'doctor.json'), null);
  if (doc?.machine && typeof doc.machine.machine_slow === 'boolean') return { slow: doc.machine.machine_slow, bench_ms: doc.machine.bench_ms ?? null, threshold_ms: doc.machine.threshold_ms ?? SLOW_MS, cpus: doc.machine.cpus ?? null, mem_gb: doc.machine.mem_gb ?? null, source: 'doctor.json' };
  const ms = []; for (let k = 0; k < 3; k++) ms.push(benchMs());
  const bench = Math.round(Math.min(...ms)); const c = cpus()?.length || 0; const mem = Math.round(totalmem() / 1024 ** 3);
  return { slow: bench > SLOW_MS || c < 4 || mem < 4, bench_ms: bench, threshold_ms: SLOW_MS, cpus: c, mem_gb: mem, source: 'perf-bench' };
}

// ---------- browser slots: all or nothing ----------
// Try to take every slot without waiting; if one is busy, give back what we took and retry after a random pause
// (two exclusive scripts never sit on one slot each waiting for the other). owned(): every slot is still ours
// (util slot handles expose owned(); older handles without it count as owned).
const releaseOne = h => { try { if (typeof h === 'function') h(); else h?.release?.(); } catch { /* already released */ } };
function slotSet(handles) {
  let released = false;
  return { count: handles.length,
    release() { if (released) return; released = true; handles.forEach(releaseOne); },
    owned() { return handles.every(h => typeof h?.owned !== 'function' || h.owned() !== false); } };
}
async function acquireAllSlots(until, lang) {
  const max = Math.max(1, Number(process.env.REVIZOR_MAX_BROWSERS || 2));
  let told = false;
  // other scripts stop taking freed slots while we wait for all of them (see util.announceExclusive)
  const excl = U.announceExclusive ? U.announceExclusive() : () => {};
  for (;;) {
    const got = [];
    try { for (let k = 0; k < max; k++) got.push(await U.acquireBrowserSlot({ max, waitMs: 0 })); excl(); return slotSet(got); }
    catch { got.forEach(releaseOne); }
    if (Date.now() > until) { excl(); throw new Error(lang === 'en' ? 'browser slots busy' : 'все слоты браузера заняты другими проверками'); }
    if (!told) { U.progress(lang === 'en' ? 'perf: waiting until every browser slot is free…' : 'perf: жду, пока освободятся все слоты браузера…'); told = true; }
    await U.sleep(500 + Math.floor(Math.random() * 2000)); // a failed try already waited 1–2 s inside acquireBrowserSlot
  }
}

// A block that overruns its deadline is cut: its browser is closed (pending CDP calls fail), the block reports a cut.
async function withWatchdog(fn, ctx, ms) {
  let timer = null; ctx.cut = false;
  const work = fn(); work.catch(() => {});
  const wd = new Promise((_, rej) => { timer = setTimeout(() => { ctx.cut = true; const b = ctx.live; Promise.resolve(b ? b.close() : null).catch(() => {}).finally(() => rej(new Error('cut by deadline'))); }, Math.max(1000, ms)); });
  try { return await Promise.race([work, wd]); } finally { clearTimeout(timer); }
}

// ---------- main ----------
async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'fresh', 'psi', 'inp', 'film', 'third-party', 'allow-load-posts'] });
  U.helpAndExit(HELP, args);
  const lang = U.langOf(args);
  const L = T[lang];
  const run = U.requireRun(args);
  const T0 = Date.now();
  const budgetMs = Math.max(30, Number(args['budget-sec']) || 480) * 1000;
  const deadline = T0 + budgetMs - 15000; // time left to write the file and print the summary
  const state = U.readJSON(join(run, 'state.json'), {});
  const depth = String(args.depth || state.flags?.depth || 'standard');
  const brief = U.readJSON(join(run, 'brief.json'), null) || U.readJSON(join(run, 'brief.input.json'), {}) || {};
  const pagesDoc = existsSync(join(run, 'pages.json')) ? U.readJSON(join(run, 'pages.json'), {}) : null;

  let all;
  if (pagesDoc) all = U.loadPages(run, {});
  else if (args.url && args.url !== true) all = [{ pid: 'home', url: U.normalizeUrl(args.url), template: 'home' }];
  else { console.error(lang === 'en' ? 'No pages.json and no --url.' : 'Нет pages.json и не задан --url.'); process.exit(2); }
  const snap = U.readJSON(join(run, 'snapshot', 'snapshot.json'), null);
  const closed = new Set(snap?.summary?.blocked_pages || []);
  all = all.filter(p => p && p.url && !p.blocked && !closed.has(p.pid));
  const only = U.listArg(args.pages);
  if (only.length) all = all.filter(p => only.includes(p.pid));
  if (!all.length) { console.error(lang === 'en' ? 'No pages to measure.' : 'Нет страниц для замера.'); process.exit(2); }
  for (const p of all) { const h = U.hostOf(p.url); if (isLocalHost(h)) U.allowPrivateHost(h); }

  const maxPages = Math.max(1, Number(args['max-pages']) || (depth === 'lite' ? 2 : depth === 'deep' ? 5 : 3));
  const nRuns = Math.max(1, Math.min(5, Number(args.runs) || (depth === 'lite' ? 2 : 3)));
  // home + key pages of distinct templates (content-heavy first)
  const KEY = [/(product|tovar|item|kartochk)/i, /(catalog|katalog|shop|uslug|services|service)/i, /(price|prices|pricing|tarif|ceny|tseny|stoimost)/i, /(article|blog|news|stati|post)/i, /(kontakt|contact|about|o-nas)/i];
  const home = all.find(p => p.pid === 'home') || all[0];
  const chosen = [home]; const seenT = new Set([home.template || home.pid]);
  for (const re of KEY) for (const p of all) { if (chosen.length >= maxPages) break; if (chosen.includes(p) || seenT.has(p.template || p.pid)) continue; if (re.test(`${p.template || ''} ${p.url} ${p.why || ''}`)) { chosen.push(p); seenT.add(p.template || p.pid); } }
  for (const p of all) { if (chosen.length >= maxPages) break; if (!chosen.includes(p) && !seenT.has(p.template || p.pid)) { chosen.push(p); seenT.add(p.template || p.pid); } }
  for (const p of all) { if (chosen.length >= maxPages) break; if (!chosen.includes(p)) chosen.push(p); }
  const pages = chosen.map((p, i) => ({ ...p, tier: i < 2 ? 'A' : 'B' }));
  const pageIds = new Set(pages.map(p => p.pid));
  const siteOf = () => pagesDoc?.final_origin || pagesDoc?.site || home.url;

  // external services policy (PSI)
  const host = U.hostOf(home.url);
  const stage = (args.stage && args.stage !== true ? String(args.stage) : null) || brief.stage || ((pagesDoc?.beta_signals || []).length ? 'beta' : 'live');
  const psiPolicy = await psiPolicyOf({ args, host, stage, brief, state, pagesDoc, run, home, lang });
  const psiKey = process.env.PSI_API_KEY || process.env.PAGESPEED_API_KEY || null;
  const psiPids = U.listArg(args['psi-pages']);
  const psiPages = psiPids.length ? pages.filter(p => psiPids.includes(p.pid)) : (psiKey ? pages.slice(0, 5) : [home]);
  const psiPlan = []; for (const p of psiPages) { psiPlan.push({ pg: p, strategy: 'mobile' }); if (p.pid === home.pid || psiPids.length) psiPlan.push({ pg: p, strategy: 'desktop' }); }

  const outFile = U.insideRun(run, 'measure', 'perf.json');
  let out = null, keep = null;
  if (!args.fresh && existsSync(outFile)) {
    const prev = U.readJSON(outFile, null);
    if (prev && prev.partial && prev.resume && Array.isArray(prev.resume.done) && Array.isArray(prev.runs)) out = prev;
    else if (prev && !prev.partial && only.length && Array.isArray(prev.items)) keep = prev; // --pages on a finished file: re-measure these, keep the rest
  }
  if (!out) {
    out = { ...U.measureHeader(NAME, run), partial: false, resume: { done: [] }, interception: true,
      method: lang === 'en' ? 'headless Chromium via CDP; own PerformanceObservers (LCP, CLS session windows, long tasks, Event Timing); fresh profile per load (cold cache), the browser HTTP cache stays on; a load ends when first-screen images, fonts, styles and scripts have arrived; the Revizor safety net intercepts every request'
        : 'headless Chromium через CDP; свои PerformanceObserver (LCP, CLS по окнам сессий, длинные задачи, Event Timing); новый профиль на каждую загрузку (холодный кэш), кэш браузера включён; загрузка кончается, когда пришли картинки первого экрана, шрифты, стили и скрипты; страховка Ревизора перехватывает каждый запрос',
      profiles: { mobile: { width: MOBILE.width, height: MOBILE.height, dpr: MOBILE.dpr, cpu_slowdown: MOBILE.cpu, network: { latency_ms: MOBILE.net.latency, down_kbps: MOBILE.net.downKbps, up_kbps: MOBILE.net.upKbps, preset: 'Lighthouse mobileSlow4G, DevTools throttling' } },
        desktop: { width: DESKTOP.width, height: DESKTOP.height, dpr: DESKTOP.dpr, cpu_slowdown: 1, network: null } },
      machine: null, stage, psi_policy: psiPolicy, runs: [], psi: [], items: [] };
    if (keep) {
      out.kept_items = (keep.items || []).filter(i => !pageIds.has(i.pid));
      out.runs = (keep.runs || []).filter(r => !pageIds.has(r.pid));
      out.psi = (keep.psi || []).filter(p => !pageIds.has(p.pid));
      out.machine = keep.machine || null; out.contended = keep.contended || undefined;
    }
  }
  out.psi_policy = psiPolicy; out.stage = stage;
  out.not_checked = (out.not_checked || []).filter(x => !/браузер занят|слоты браузера|browser slots busy|PSI не ответил|PSI did not answer/i.test(x)); // notes of the previous call only
  out.errors = out.errors || [];
  out.machine = out.machine || machineInfo(run);
  const done = new Set(out.resume?.done || []);

  // plan of units, most useful first
  const units = [];
  const add = u => { if (!units.some(x => x.id === u.id)) units.push(u); };
  for (const p of pages) { add({ id: `load:${p.pid}:m:1`, kind: 'load', pg: p, prof: 'm', n: 1, detail: true, idle: p === pages[0] }); add({ id: `load:${p.pid}:d:1`, kind: 'load', pg: p, prof: 'd', n: 1, detail: true }); }
  const A = pages.filter(p => p.tier === 'A');
  const homeP = pages[0];
  const baseId = `load:${homeP.pid}:m:1`;
  const loadN = (p, n) => { add({ id: `load:${p.pid}:m:${n}`, kind: 'load', pg: p, prof: 'm', n }); add({ id: `load:${p.pid}:d:${n}`, kind: 'load', pg: p, prof: 'd', n }); };
  if (nRuns >= 2) loadN(homeP, 2);
  if (args.inp !== false) add({ id: `inp:${homeP.pid}`, kind: 'inp', pg: homeP });
  if (args['third-party'] !== false) add({ id: `block3p:${homeP.pid}:1`, kind: 'block3p', pg: homeP, n: 1, needs: baseId });
  for (let n = 3; n <= nRuns; n++) loadN(homeP, n);
  add({ id: `bfcache:${homeP.pid}`, kind: 'bfcache', pg: homeP });
  if (args.film !== false) add({ id: `film:${homeP.pid}`, kind: 'film', pg: homeP });
  add({ id: `warm:${homeP.pid}`, kind: 'warm', pg: homeP, prof: 'm' });
  for (let n = 2; n <= nRuns; n++) for (const p of A.filter(p => p !== homeP)) loadN(p, n);
  if (args['third-party'] !== false && nRuns > 1) add({ id: `block3p:${homeP.pid}:2`, kind: 'block3p', pg: homeP, n: 2, needs: baseId });
  for (const p of A.filter(p => p !== homeP)) { if (args.inp !== false) add({ id: `inp:${p.pid}`, kind: 'inp', pg: p }); add({ id: `warm:${p.pid}`, kind: 'warm', pg: p, prof: 'm' }); }
  const est = { load_m: 40000, load_d: 12000, inp: 60000, block3p: 35000, warm: 45000, film: 25000, bfcache: 15000 };
  const durations = { ...(out.resume?.durations || {}) }; // estimates survive between calls
  let ranHere = 0; // blocks finished in this call
  const estOf = u => { const k = u.kind === 'load' ? `load_${u.prof}` : u.kind; const d = durations[k]; return d && d.length ? d.reduce((a, x) => a + x, 0) / d.length : est[k]; };
  // next block: the planned one if it fits; otherwise (≥ 25 s left) the cheapest that fits, so every call moves forward
  const pickNext = () => {
    const todo = units.filter(u => !done.has(u.id) && (!u.needs || done.has(u.needs)));
    if (!todo.length) return null;
    const left = deadline - Date.now();
    if (left >= estOf(todo[0]) * 1.2 + 5000) return todo[0];
    if (left < 25000) return null;
    const cheap = todo.slice().sort((a, b) => estOf(a) - estOf(b))[0];
    // nothing done yet in this call: run the cheapest anyway (its timeouts are cut to the deadline), so a small budget still moves forward
    return estOf(cheap) * 1.2 + 3000 <= left || !ranHere ? cheap : null;
  };

  const writeOut = partial => {
    out.partial = partial; out.resume = partial ? { done: [...done], durations } : null;
    out.generated = U.nowIso();
    out.items = [...(out.kept_items || []), ...buildItems(out, pages, siteOf, lang)];
    out.pages = out.items.map(i => i.pid);
    out.summary = buildSummary(out);
    // raw request lists and DOM details are needed only to resume; the finished file keeps the analysed items
    const file = partial ? out : { ...out, kept_items: undefined, runs: out.runs.map(({ requests, detail, ...r }) => r) };
    U.writeJSON(outFile, file);
  };
  const ctx = { run, lang, allowLoadPosts: !!args['allow-load-posts'], siteOf, dl: deadline, live: null };

  // PSI: after the first phone load of the home page answered 200 (not before: no status, no anti-bot check yet)
  let psiPromise = null, psiTodoList = [];
  const maybeStartPsi = () => {
    if (psiPromise || !psiPolicy.allowed) return;
    const first = out.runs.find(r => r.unit === baseId);
    if (!first) return;
    if (first.error || first.status !== 200) { psiPolicy.allowed = false; psiPolicy.why = lang === 'en' ? `the home page answered ${first.status ?? first.error}` : `главная ответила ${first.status ?? first.error}`; out.psi_policy = psiPolicy; return; }
    const have = new Set((out.psi || []).map(p => `${p.pid}:${p.strategy}`));
    psiTodoList = psiPlan.filter(x => !have.has(`${x.pg.pid}:${x.strategy}`));
    if (!psiTodoList.length) return;
    psiPromise = Promise.all(psiTodoList.map(x => psiCall(run, x.pg, x.strategy, lang, psiKey).catch(e => ({ pid: x.pg.pid, url: x.pg.url, strategy: x.strategy, status: 'error', error: e.message.slice(0, 160) }))));
  };

  const runUnit = async u => {
    if (u.kind === 'load') return loadUnit(u, ctx);
    if (u.kind === 'warm') return warmUnit(u, ctx);
    if (u.kind === 'inp') return inpUnit(u, ctx);
    if (u.kind === 'film') return filmUnit(u, ctx);
    if (u.kind === 'bfcache') {
      const other = pages.find(p => p.pid !== u.pg.pid && !p.blocked && U.sameSite(p.url, u.pg.url));
      let away = other?.url;
      if (!away) { try { away = new URL('/robots.txt', u.pg.url).toString(); } catch { away = null; } }
      return away ? bfcacheUnit({ ...u, away }, ctx) : { unit: u.id, pid: u.pg.pid, kind: 'bfcache', error: 'no second page' };
    }
    if (u.kind === 'block3p') {
      const base = out.runs.find(x => x.unit === `load:${u.pg.pid}:m:1`);
      const { block, kept } = chooseBlockHosts(base, siteOf(u.pg));
      if (!base || base.error) return { unit: u.id, pid: u.pg.pid, kind: 'block3p', error: 'no base phone load' };
      if (!block.length) return { unit: u.id, pid: u.pg.pid, kind: 'block3p', skipped: 'no third-party hosts to block', kept_hosts: kept };
      const r = await loadUnit({ ...u, prof: 'm', blockHosts: block }, ctx); r.kind = 'block3p'; r.blocked_hosts = block; r.kept_hosts = kept; return r;
    }
    return { unit: u.id, pid: u.pg.pid, kind: u.kind, error: 'unknown unit' };
  };

  let slots = null, partial = false;
  U.log(run, `perf: старт, страниц ${pages.length} (${pages.map(p => p.pid).join(',')}), загрузок на ширину ${nRuns}, бюджет ${Math.round(budgetMs / 1000)} с, PSI ${psiPolicy.allowed ? 'да (после первой загрузки главной)' : 'нет: ' + psiPolicy.why}`);
  try {
    try { slots = await acquireAllSlots(Math.min(T0 + 10 * 60000, deadline - 25000), lang); }
    catch (e) { out.not_checked.push(lang === 'en' ? 'browser slots busy — rerun to continue' : 'браузер занят другими проверками — повторите вызов, продолжит'); partial = true; throw e; }
    maybeStartPsi();
    for (;;) {
      const u = pickNext(); if (!u) break;
      if (slots.owned() === false) { // another process took a slot: take all of them back before measuring
        U.progress(lang === 'en' ? 'perf: a browser slot was taken by another check — re-acquiring' : 'perf: слот браузера занят другой проверкой — забираю заново');
        out.contended = true; slots.release(); slots = null;
        try { slots = await acquireAllSlots(deadline - 25000, lang); }
        catch { out.not_checked.push(lang === 'en' ? 'browser slots busy — rerun to continue' : 'браузер занят другими проверками — повторите вызов, продолжит'); partial = true; break; }
      }
      const t1 = Date.now();
      ctx.dl = Math.min(deadline, t1 + UNIT_CAP_MS);
      U.progress(`perf: ${u.id}`);
      let r = null, cutBy = null;
      try { r = await withWatchdog(() => runUnit(u), ctx, ctx.dl - t1 + 20000); }
      catch (e) { if (ctx.cut) cutBy = ctx.dl >= deadline ? 'budget' : 'unit'; else out.errors.push({ pid: u.pg.pid, error: `${u.id}: ${String(e.message).slice(0, 200)}` }); }
      const k = u.kind === 'load' ? `load_${u.prof}` : u.kind; (durations[k] ||= []).push(Date.now() - t1); durations[k] = durations[k].slice(-5);
      ranHere++;
      if (r) {
        r.unit_ms = Date.now() - t1;
        if (slots && slots.owned() === false) { r.contended = true; out.contended = true; }
        out.runs = out.runs.filter(x => x.unit !== u.id); out.runs.push(r);
        if (r.error) out.errors.push({ pid: u.pg.pid, error: `${u.id}: ${String(r.error).slice(0, 160)}` });
        done.add(u.id);
      } else if (cutBy === 'budget') { partial = true; writeOut(true); break; }
      else if (cutBy === 'unit') { out.errors.push({ pid: u.pg.pid, error: `${u.id}: ${lang === 'en' ? 'stopped after' : 'остановлен через'} ${UNIT_CAP_MS / 1000} ${L.s}` }); done.add(u.id); }
      else done.add(u.id); // failed with an error: not retried endlessly
      writeOut(true);
      maybeStartPsi();
    }
  } catch (e) {
    if (!partial) out.errors.push({ pid: '-', error: String(e.message).slice(0, 300) });
  } finally { if (slots) slots.release(); }

  if (psiPromise) {
    const left = Math.max(1000, T0 + budgetMs - 3000 - Date.now());
    const res = await Promise.race([psiPromise, U.sleep(left).then(() => null)]);
    if (res) out.psi = [...(out.psi || []).filter(p => !res.some(r => r.pid === p.pid && r.strategy === p.strategy)), ...res];
    else { // one attempt per page and strategy: an unanswered call is recorded, not repeated by the next run
      out.psi = [...(out.psi || []), ...psiTodoList.map(x => ({ pid: x.pg.pid, url: x.pg.url, strategy: x.strategy, status: 'no_answer', error: lang === 'en' ? 'no answer within the time budget' : 'нет ответа за отведённое время' }))];
      out.not_checked.push(lang === 'en' ? 'PSI did not answer within the time budget' : 'PSI не ответил за отведённое время');
    }
  }
  const nc = new Set(out.not_checked);
  const addNc = s => { if (!nc.has(s)) { nc.add(s); out.not_checked.push(s); } };
  addNc(lang === 'en' ? 'Safari/iOS and real phones: Chromium emulation only (CPU×4 + Slow 4G); check on a device' : 'Safari/iOS и настоящие телефоны: только эмуляция в Chromium (CPU×4 + Slow 4G) — проверить на устройстве');
  addNc(lang === 'en' ? 'counters, call tracking and chats are blocked in every run: their cost is not in lab numbers' : 'счётчики, коллтрекинг и чаты заблокированы во всех прогонах — их вклад в лабораторные цифры не входит');
  if (!psiPolicy.allowed) addNc(lang === 'en' ? `PSI/CrUX field data: not requested (${psiPolicy.why})` : `PSI и полевые данные CrUX не запрашивали (${psiPolicy.why})`);
  if (args.inp === false) addNc(lang === 'en' ? 'INP and main-thread time by origin: not measured (--no-inp)' : 'INP и время главной нити по источникам не мерили (--no-inp)');
  const noHtml = out.runs.filter(r => r.detail !== undefined || r.lcp_html !== undefined).filter(r => r.lcp?.url && (!r.lcp_html || r.lcp_html.in_initial_html === null)).map(r => r.pid);
  if (noHtml.length) addNc(lang === 'en' ? `is the LCP file in the initial HTML: not checked for ${[...new Set(noHtml)].join(', ')} (no snapshot raw.html and no document body)` : `есть ли файл LCP в исходном HTML — не проверено для ${[...new Set(noHtml)].join(', ')} (нет snapshot/raw.html и тела документа)`);
  if (out.contended) addNc(lang === 'en' ? 'timings: another check used the browser during the measurement — rerun with --fresh on an idle machine' : 'время: во время замера браузером пользовалась другая проверка — повторить с --fresh на свободной машине');
  const allDone = units.every(u => done.has(u.id));
  if (!allDone) partial = true;
  const noLoads = !partial && !out.runs.some(r => r.kind === 'load' && r.metrics && !r.error);
  if (noLoads) addNc(L.noLoadsNc);
  writeOut(partial);
  const lines = summaryLines(out, lang, rel(run, outFile));
  U.printAndSaveSummary(run, NAME, lines);
  U.log(run, `perf: ${partial ? 'частично' : 'готово'} за ${Math.round((Date.now() - T0) / 1000)} с, загрузок ${out.runs.length}, PSI ${(out.psi || []).filter(p => p.status === 'ok').length}/${(out.psi || []).length}`);
  process.exitCode = partial ? 75 : noLoads ? 1 : 0;
}

main().catch(e => { console.error(e?.stack || e); process.exitCode = /Node|браузер|browser/i.test(String(e?.message)) ? 2 : 1; })
  .finally(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref(); });
