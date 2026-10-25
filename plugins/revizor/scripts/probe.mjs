#!/usr/bin/env node
// Revizor — probe: one live load of one page for lens agents and the skeptic.
// Re-measure a finding, look at a state (dark theme, reduced motion, vision deficiency, no JS, blocked resource),
// tap/click/hover/press keys by real input, type into calculator fields outside contact forms, check a fix by
// substitution (--css as a same-origin stylesheet served by us, --inject-html into the HTML document via
// Fetch.fulfillRequest), read the text of a PDF document. The site itself is never changed.
// Safety: lib/cdp (GET only, counters/widgets cut, navigations aborted and reported, interaction guard, no taps on
// iframes/submit/contact forms) + here: only the reviewed site (or rivals of this run), a richer contact-field check
// for --fill/taps/keys, the guard held for the rest of the page once anything is typed.

import { existsSync, readFileSync, realpathSync, statSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import zlib from 'node:zlib';
import * as U from './lib/util.mjs';
import { Browser } from './lib/cdp.mjs';

const HELP = `
probe.mjs — одна живая загрузка страницы для линз и скептика: замер, состояние, касание, клавиши, ввод, проверка правки
подменой, текст PDF

  node probe.mjs --run "<RUN>" (--url <адрес> | --pid <pid>) [--width 390|768|1440|<n>] [--height <n>] [--mobile | --no-mobile]
     [--dark] [--reduce] [--forced-colors] [--vision protanopia|deuteranopia|tritanopia|achromatopsia|blurredVision|reducedContrast]
     [--no-js] [--block "<шаблон>,…"] [--hide-overlays] [--scroll <y|селектор>]
     [--tap x,y|<селектор>] [--click x,y|<селектор>] [--hover x,y|<селектор>] [--key "Tab,Tab,Escape"] [--wait <мс>]
     [--fill "<селектор>=<значение>,…"] [--read "<селектор>"]
     [--css "<RUN>/probe-js/<файл>.css"] [--inject-html "<RUN>/probe-js/<файл>.html" --at "</head>"|"</body>"|"<!-- метка -->"|"<селектор>"
      [--place replace|inner|before|after|append|prepend]] [--allow-status 404,410]
     [--js "<RUN>/probe-js/<файл>.js" | --js "<ROOT>/scripts/probe-js/<готовый>.js" [--js-args '<JSON>'] | --expr "<выражение JS>"] [--grep-scripts "<регэксп>"] [--before | --no-before]
     [--vitals [--repeat 3]] [--shot <имя.jpg>] [--full] [--no-shot] [--allow-load-posts] [--budget-sec 480] [--lang ru|en]

Адрес: только проверяемый сайт и его поддомены (state.json, pages.json, brief.json этого RUN), старый сайт из brief.baseline;
у ролей конкурентов — сайты из rivals/ этого RUN; PDF с другого домена — если ссылка на него есть в snapshot/*/dom.html.
Служебные пути (/.env, /.git/, /wp-admin, /bitrix/admin, /administrator, /phpmyadmin, /server-status, *.sql, *.bak…) — только
при brief.json → limits.probe: true. Иначе отказ (код 3).
Ширина 390 и любая < 600 — телефон (касания, DPR 2), если не указано --no-mobile. Высота окна — как у snapshot (390 → 844, 1440 → 900).
Координаты x,y — CSS px документа на этой ширине (как поле box находки). Точка вне экрана — страница прокручивается к ней.
Вместо координат можно дать CSS-селектор: берётся первый видимый элемент, касание — в его центр; в ответе target_on_top
показывает, сам ли элемент оказался под пальцем (или его перекрывает слой). Касания и клики — реальным вводом
(Input.dispatch*), не element.click(). Не трогаются: iframe, кнопки отправки, «Принять» в cookie-баннере, кнопки и ссылки
формы с контактами (телефон, почта, имя, маска «+7 (___)», поле с подписью «Ваш телефон» и т. п.). Переход по ссылке
обрывается, адрес печатается в navigations; новые окна закрываются, window.open() не открывает окно (popups — куда вели).
WebSocket страницы не открываются (blocked.websocket). Шаги --tap/--click/--hover/--key/--fill выполняются в порядке флагов; после каждого — пауза --wait (500 мс).

--key      клавиши через запятую: Tab, Shift+Tab, Escape, Enter, Space, ArrowDown/Up/Left/Right, Home, End, PageDown, PageUp;
           повтор — «Tab*5». После каждой — где фокус: keys[].focus { tag, id, text, box, ring, changed: [{ prop, before, after }]
           — чем элемент в фокусе отличается от себя же без фокуса (фон, цвет, подчёркивание, рамка, outline, тень), focus_visible }.
           Enter/Space по кнопке отправки,
           в поле формы и в форме с контактами не нажимаются (refused).
--js       файл — тело async-функции, результат — через return; берётся ТОЛЬКО из <RUN>/probe-js/ (свои пробы) или из
           <ROOT>/scripts/probe-js/ (готовые замеры плагина, копировать не нужно): __BUILTINS__.
--js-args  JSON-объект для кода --js, внутри он — переменная ARGS (по умолчанию {}): например
           --js-args '{"pairs":[["#9a9a9a","#ffffff",4.5]]}' для color-contrast-pick.js, '{"target":"header nav a"}'
           для stability-who-styles.js, '{"file":"hero"}' для perf-lcp-start.js.
--expr     одно выражение JS (можно промис). Код выполняется в странице после всех шагов; ответ — в result. Пока он
           работает, фоновые запросы страницы (fetch, XHR, beacon, адреса с «?») обрываются: fetch из кода не работает.
--grep-scripts  поиск по текстам скриптов, которые страница уже загрузила (и встроенных), без новых запросов:
           scripts [{ url, inline, hits: [{ line, text ≤ 200 }] }]. Регэксп без флагов — без учёта регистра; можно "/…/флаги".
--vitals   проверка скорости: LCP/FCP/CLS и те же LCP/FCP от конца ответа документа (lcp_from_response — меньше шума сети),
           --repeat N загрузок (по умолчанию 3, медианы). С правкой — сравнение «A/A»: «до» идёт через ту же подмену без
           изменений (тот же --at, пустой стиль), разброс «до» между повторами — шум; fix.speed[метрика].verdict = improved
           только если лучше на max(15 %, 2 × шум), иначе noise (или worse).
--css      файл стилей из <RUN>/probe-js/: в загрузке «после» он подключается как файл стилей сайта в конце <head>
           (запрос отдаём мы, до сайта он не доходит). Если CSP сайта не пускает и его — стиль добавляется после загрузки
           через DevTools: вид сравним, скорость «после» нет (fix.vitals_comparable: false).
--inject-html  файл из <RUN>/probe-js/ вставляется в HTML документа до разбора браузером (подмена ответа сервера, сайт не меняется):
           --at "</head>" или "</body>" — перед закрывающим тегом; "<head>"/"<body>" — сразу после открывающего;
           "<!-- rv-fix -->" — вместо содержимого между <!-- rv-fix --> и <!-- /rv-fix -->; иначе — CSS-селектор, --place
           (replace по умолчанию). CSP сайта сохраняется: если она блокирует часть вставки (встроенный стиль или скрипт),
           fix.applied: false и fix.blocked_by: "csp" — в таком виде правка на сайте тоже не заработает.
           С правкой скрипт делает две загрузки — «до» и «после» (before/after: замер, кадр, result, vitals, blocked);
           --no-before — только «после». Без правки --before снимает состояние до шагов (та же загрузка).
--allow-status  подменять и ответ с этими кодами (по умолчанию только 2xx): например правка шаблона страницы 404.
--allow-load-posts  разрешить не-GET во время загрузки (SPA, грузящие контент POST-ом) — только если этот флаг дан прогону
           (brief.json → flags.allow_load_posts). При шагах не-GET всё равно обрываются.
--fill     ввод в поля калькуляторов и фильтров: селектор=значение через запятую («#sum=1 500,50,#term=12» — запятая внутри
           значения не делит пары). Поля с телефоном, почтой, именем, паролем, комментарием (по типу, inputmode, autocomplete,
           подписи, placeholder, маске) и поля форм, где такое поле есть, скрипт не трогает (refused). Текст набирается по
           символу, select и range — скриптом с событиями input/change. Отправки нет. После первого ввода фоновые запросы
           страницы с параметрами обрываются до конца загрузки.
--read     что прочитать (можно несколько раз): текст или value первых 10 совпадений; при --fill — до ввода (read_before) и после (read).
--block    шаблоны адресов через запятую, которые не грузить (например "*/main.*.js,*.woff2") — проверка без скрипта или шрифта.
--hide-overlays  скрыть cookie-баннер, «Ваш город?» и попапы, открывшиеся сами (что скрыто — в hidden_overlays). «Принять» не нажимается.
--scroll   прокрутить до y (CSS px) или до элемента перед шагами и кадром.
--shot     имя кадра в <RUN>/probe/ (по умолчанию <pid|хост>-<ширина>-<время>-<4 знака>.jpg); --full — вся страница (длинная —
           кусками .part-NN с <имя>.index.json); --no-shot — без кадра.
Картинка  адрес на .jpg/.png/.webp/.avif/.svg/.gif/.ico (og:image, иконки; с другого хоста — если ссылка на него есть в
           snapshot/*/dom.html) — без браузера, только GET: status, file_info { content_type, bytes, dims }, кадр — сама картинка.
PDF        адрес на .pdf (или ответ application/pdf) — без браузера: doc_text (текст документа), doc_pages; doc_text: null и
           doc_text_why (encrypted, no_text_layer — скан, encoding — шрифты без таблицы символов, too_big) — тогда проверить нельзя.

Вывод: JSON в stdout (основные поля; копия — <RUN>/stdout/probe-<имя>.md, путь в поле copy), полный ответ — <RUN>/probe/<имя>.json,
кадры — <RUN>/probe/. Поля: url, final_url, status, chain [{ url, status, redirect: http|js|other }], width, mobile, media,
metrics { doc_height, overflow_x_px, offenders, scroll_y }, actions [ { step, kind, target, point_doc, hit, target_on_top, result,
navigations, popups } ], keys [ { step, key, result, focus } ], fill [ { step, selector, value_after, refused } ], read_before,
read, result, before, fix { applied, css_method, blocked_by, reason, csp_violations, vitals_comparable, speed }, shots, vitals,
navigations, popups,
blocked (попытки счётчиков, виджетов, записи, фоновых запросов после действий), console [{ type: error|warning|log-error,
phase: load|interact, text }], console_errors, exceptions (ошибки сайта), exceptions_induced (вызваны нашей страховкой — не
ошибка сайта), scripts, warnings.
Коды: 0 — готово · 1 — страница не загрузилась · 2 — ошибка аргументов/окружения · 3 — адрес отклонён (не проверяемый
сайт, внутренняя сеть, «опасный» GET) или защита от ботов · 75 — не уложился в --budget-sec или браузеры заняты (частичный
ответ записан; ожидание свободного браузера, до 5 мин, в бюджет не входит).
`;

const BOOL = ['help', 'mobile', 'dark', 'reduce', 'forced-colors', 'full', 'no-js', 'before', 'no-shot', 'hide-overlays', 'allow-load-posts', 'vitals'];
// Git Bash (MSYS) rewrites "/x" inside arguments ("</head>", '[href="/x"]') into "C:/Program Files/Git/x": undo it everywhere
const MSYS_RE = /[A-Za-z]:[\/\\]Program Files[\/\\]Git(?=[\/\\])/gi;
const ARGV = process.argv.slice(2).map(a => a.replace(MSYS_RE, ''));
const args = U.parseArgs(ARGV, { boolean: BOOL, multi: ['tap', 'click', 'hover', 'fill', 'read', 'block', 'key'] });
U.helpAndExit(HELP.replace('__BUILTINS__', (() => { try { return readdirSync(join(dirname(fileURLToPath(import.meta.url)), 'probe-js')).filter(n => n.endsWith('.js')).sort().join(', '); } catch { return '—'; } })()), args);
const lang = U.langOf(args);
const T = (ru, en) => (lang === 'en' ? en : ru);
const fail = (code, ru, en) => { console.error(T(ru, en)); process.exit(code); };
const run = U.requireRun(args);
const budgetSec = Number(args['budget-sec']) > 0 ? Number(args['budget-sec']) : 480;
const str = v => (v === undefined || v === null || v === true ? null : String(v));

// ---------- run context ----------
const readOpt = p => { try { return existsSync(p) ? U.readJSON(p, null) : null; } catch { return null; } };
const pagesDoc = readOpt(join(run, 'pages.json'));
const pagesFrom = readOpt(join(run, 'pages.from.json'));
const state = readOpt(join(run, 'state.json')) || {};
const brief = readOpt(join(run, 'brief.json')) || {};
const briefIn = readOpt(join(run, 'brief.input.json')) || {};

let pid = str(args.pid), url = null;
if (pid) {
  const sel = (pagesDoc?.selected || []).find(s => s.pid === pid);
  if (!sel) fail(2, `Нет страницы с pid «${pid}» в pages.json этого прогона.`, `No page with pid "${pid}" in pages.json of this run.`);
  url = sel.url;
} else if (str(args.url)) {
  try { url = U.normalizeUrl(str(args.url)); } catch { fail(2, `Не понял адрес: ${args.url}`, `Bad URL: ${args.url}`); }
  if (!/^https?:/i.test(url)) fail(2, 'Только адреса http(s).', 'Only http(s) URLs.');
  const byUrl = (pagesDoc?.selected || []).find(s => s.url === url || s.final_url === url);
  if (byUrl) pid = byUrl.pid;
} else fail(2, 'Нужен --url <адрес> или --pid <pid>.', 'Need --url <URL> or --pid <pid>.');

// --allow-load-posts only when the run was started with it
const allowLoadPosts = !!args['allow-load-posts'];
if (allowLoadPosts && ![brief.flags?.allow_load_posts, briefIn.flags?.allow_load_posts, state.flags?.allow_load_posts].includes(true)) {
  fail(2, '--allow-load-posts можно только в прогоне, запущенном с этим флагом (brief.json → flags.allow_load_posts). Решает оркестратор: пусть перезапустит прогон с --allow-load-posts или запишет not_checked.',
    '--allow-load-posts needs the run flag (brief.json → flags.allow_load_posts).');
}

// ---------- viewport and media ----------
const width = Number(args.width ?? 1440);
if (!Number.isFinite(width) || width < 200 || width > 4000) fail(2, '--width: число от 200 до 4000.', '--width: a number 200–4000.');
const KNOWN = { 320: [568, true], 360: [780, true], 375: [812, true], 390: [844, true], 414: [896, true], 430: [932, true], 768: [1024, false],
  1024: [768, false], 1280: [800, false], 1366: [768, false], 1440: [900, false], 1536: [864, false], 1920: [1080, false] };
const mobile = args.mobile === undefined ? (KNOWN[width] ? KNOWN[width][1] : width < 600) : !!args.mobile;
const height = Number(args.height) > 0 ? Math.round(Number(args.height)) : (KNOWN[width] ? KNOWN[width][0] : (mobile ? Math.round(width * 2.16) : Math.round(width * 0.625)));
const dpr = Number(args.dpr) > 0 ? Number(args.dpr) : (mobile ? 2 : 1);
const VISION = { none: 'none', protanopia: 'protanopia', deuteranopia: 'deuteranopia', tritanopia: 'tritanopia', achromatopsia: 'achromatopsia',
  blurredvision: 'blurredVision', blurred: 'blurredVision', blur: 'blurredVision', reducedcontrast: 'reducedContrast', 'reduced-contrast': 'reducedContrast' };
const vision = str(args.vision) ? VISION[str(args.vision).toLowerCase().replace(/[\s_]/g, '')] : null;
if (str(args.vision) && !vision) fail(2, `--vision: одно из ${[...new Set(Object.values(VISION))].join(', ')}.`, `--vision: one of ${[...new Set(Object.values(VISION))].join(', ')}.`);
const waitMs = Number(args.wait) >= 0 && args.wait !== undefined && args.wait !== true ? Math.min(15000, Number(args.wait)) : 500;
const blockUrls = U.listArg(args.block);
const allowStatus = U.listArg(args['allow-status']).map(Number).filter(n => n >= 100 && n < 600);

// ---------- files only from RUN/probe-js ----------
const PROBE_JS = join(run, 'probe-js');
// built-in probes of the plugin (read-only, shipped with Revizor): allowed for --js only
const BUILTIN_JS = join(dirname(fileURLToPath(import.meta.url)), 'probe-js');
function probeFile(v, flag, { builtin = false } = {}) {
  if (!str(v)) fail(2, `${flag}: нужен путь к файлу в ${PROBE_JS}.`, `${flag}: needs a file inside ${PROBE_JS}.`);
  const p = isAbsolute(str(v)) ? resolve(str(v)) : resolve(run, str(v));
  const inside = (base, x) => { const rel = relative(base, x); return rel && !rel.startsWith('..') && !isAbsolute(rel); };
  let real;
  try { real = realpathSync(p); } catch { fail(2, `${flag}: файл не найден: ${p}`, `${flag}: file not found: ${p}`); }
  let base; try { base = realpathSync(PROBE_JS); } catch { base = null; }
  let bin = null; if (builtin) { try { bin = realpathSync(BUILTIN_JS); } catch { bin = null; } }
  if (bin && inside(bin, real) && /\.js$/i.test(real) && statSync(real).isFile()) return { abs: real, rel: 'builtin:' + relative(bin, real).split(/[\\/]/).join('/'), builtin: true, text: readFileSync(real, 'utf8').replace(/^\uFEFF/, '') };
  if (!base || !inside(base, real) || !statSync(real).isFile()) {
    fail(2, `${flag}: файлы для probe берутся только из ${PROBE_JS}${builtin ? ` или готовые из ${BUILTIN_JS}` : ''} (это защита: чужой код не исполняется).`, `${flag}: probe reads files only from ${PROBE_JS}${builtin ? ` or built-in ones from ${BUILTIN_JS}` : ''}.`);
  }
  return { abs: real, rel: relative(run, real).split(/[\\/]/).join('/'), text: readFileSync(real, 'utf8').replace(/^\uFEFF/, '') };
}
const jsFile = str(args.js) ? probeFile(args.js, '--js', { builtin: true }) : null;
let jsArgs = {};
if (str(args['js-args'])) {
  try { jsArgs = JSON.parse(str(args['js-args'])); } catch (e) { fail(2, `--js-args: не JSON — ${e.message}`, `--js-args: not JSON — ${e.message}`); }
  if (!jsArgs || typeof jsArgs !== 'object' || Array.isArray(jsArgs)) fail(2, '--js-args: нужен JSON-объект {…}.', '--js-args: a JSON object {…} is expected.');
  if (!jsFile) fail(2, '--js-args работает только с --js.', '--js-args needs --js.');
}
const expr = str(args.expr);
if (jsFile && expr) fail(2, '--js и --expr вместе нельзя — выберите одно.', 'Use either --js or --expr.');
const cssFile = str(args.css) ? probeFile(args.css, '--css') : null;
const injFile = str(args['inject-html']) ? probeFile(args['inject-html'], '--inject-html') : null;
const at = str(args.at) ? String(args.at).replace(MSYS_RE, '') : null;
if (injFile && !at) fail(2, '--inject-html требует --at "</head>" | "</body>" | "<!-- метка -->" | "<селектор>".', '--inject-html needs --at.');
const place = (str(args.place) || 'replace').toLowerCase();
if (!['replace', 'inner', 'before', 'after', 'append', 'prepend'].includes(place)) fail(2, '--place: replace|inner|before|after|append|prepend.', '--place: replace|inner|before|after|append|prepend.');
const hasFix = !!(cssFile || injFile);
// --grep-scripts: "/re/flags" or a plain pattern (case-insensitive)
let grepRe = null;
if (str(args['grep-scripts'])) {
  const g = str(args['grep-scripts']); const m = g.match(/^\/([\s\S]+)\/([a-z]*)$/);
  try { grepRe = m ? new RegExp(m[1], m[2].replace(/[gy]/g, '')) : new RegExp(g, 'i'); }
  catch (e) { fail(2, `--grep-scripts: плохой регэксп — ${e.message}`, `--grep-scripts: bad regexp — ${e.message}`); }
}
const vitalsMode = !!args.vitals;
const repeat = vitalsMode ? Math.max(1, Math.min(7, Number(args.repeat) || 3)) : 1;

// ---------- steps in the order given: --tap/--click/--hover/--key/--fill ----------
// --fill "sel=value,sel2=value2": a comma starts a new pair only when a "selector=" follows
function parseFill(raw) {
  const pairs = [];
  for (const seg of String(raw).split(/,(?=\s*[^,=\s][^,=]*=)/)) {
    let depth = 0, q = null, cut = -1;
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") q = c;
      else if (c === '[' || c === '(') depth++;
      else if (c === ']' || c === ')') depth--;
      else if (c === '=' && depth === 0) { cut = i; break; }
    }
    if (cut <= 0) fail(2, `--fill: не понял «${seg}» — нужно селектор=значение.`, `--fill: cannot parse "${seg}" — use selector=value.`);
    pairs.push({ selector: seg.slice(0, cut).trim(), value: seg.slice(cut + 1).replace(/^\s+|\s+$/g, '').replace(/^"(.*)"$/, '$1') });
  }
  return pairs;
}
const KEYMAP = { tab: ['Tab', 'Tab', 9], enter: ['Enter', 'Enter', 13], return: ['Enter', 'Enter', 13], escape: ['Escape', 'Escape', 27], esc: ['Escape', 'Escape', 27],
  space: [' ', 'Space', 32], arrowdown: ['ArrowDown', 'ArrowDown', 40], arrowup: ['ArrowUp', 'ArrowUp', 38], arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
  arrowright: ['ArrowRight', 'ArrowRight', 39], down: ['ArrowDown', 'ArrowDown', 40], up: ['ArrowUp', 'ArrowUp', 38], left: ['ArrowLeft', 'ArrowLeft', 37],
  right: ['ArrowRight', 'ArrowRight', 39], home: ['Home', 'Home', 36], end: ['End', 'End', 35], pagedown: ['PageDown', 'PageDown', 34], pageup: ['PageUp', 'PageUp', 33] };
function parseKeys(raw) {
  const out = [];
  for (let part of String(raw).split(',').map(s => s.trim()).filter(Boolean)) {
    let times = 1;
    const rep = part.match(/^(.+?)\s*[*×x]\s*(\d{1,2})$/i);
    if (rep) { part = rep[1]; times = Math.min(50, Number(rep[2])); }
    const shift = /^shift\s*\+\s*/i.test(part);
    const name = part.replace(/^shift\s*\+\s*/i, '').toLowerCase().replace(/[\s_-]/g, '');
    const k = KEYMAP[name];
    if (!k) fail(2, `--key: не знаю клавишу «${part}». Можно: Tab, Shift+Tab, Escape, Enter, Space, ArrowDown/Up/Left/Right, Home, End, PageDown, PageUp.`, `--key: unknown key "${part}".`);
    for (let i = 0; i < times; i++) out.push({ key: k[0], code: k[1], keyCode: k[2], shift, label: (shift ? 'Shift+' : '') + k[1], press: k[1] === 'Enter' || k[1] === 'Space' });
  }
  return out;
}
function stepList(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const m = argv[i].match(/^--(tap|click|hover|fill|key)(?:=([\s\S]*))?$/);
    if (!m) continue;
    let v = m[2];
    if (v === undefined) { v = argv[i + 1]; i++; }
    if (v === undefined || v === '' || (m[2] === undefined && String(v).startsWith('--'))) fail(2, `--${m[1]}: нужно значение.`, `--${m[1]}: needs a value.`);
    if (m[1] === 'fill') for (const p of parseFill(v)) out.push({ kind: 'fill', ...p });
    else if (m[1] === 'key') for (const k of parseKeys(v)) out.push({ kind: 'key', ...k });
    else out.push({ kind: m[1], target: String(v) });
  }
  if (out.filter(s => s.kind === 'key').length > 100) fail(2, '--key: не больше 100 нажатий.', '--key: at most 100 presses.');
  return out;
}
const steps = stepList(ARGV);
const fillCount = steps.filter(s => s.kind === 'fill').length;
const reads = (args.read || []).map(String).filter(Boolean);

// ---------- output names (unique: parallel agents may probe the same page at the same second) ----------
const PROBE_DIR = U.ensureDir(U.insideRun(run, 'probe'));
let base, fmt = 'jpeg';
if (str(args.shot)) {
  const s = str(args.shot);
  if (!/^[\w.-]+\.(jpe?g|png)$/i.test(s) || s.includes('..')) fail(2, '--shot: только имя файла .jpg/.png (буквы, цифры, «.-_»), кадр ляжет в RUN/probe/.', '--shot: a bare .jpg/.png file name.');
  base = s.replace(/\.(jpe?g|png)$/i, '');
  if (/\.png$/i.test(s)) fmt = 'png';
} else {
  const d = new Date(); const p2 = n => String(n).padStart(2, '0');
  base = `${pid || U.hostKey(url)}-${width}${mobile ? 'm' : ''}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, '0')}-${randomBytes(2).toString('hex')}`;
}
const ext = fmt === 'png' ? '.png' : '.jpg';
const relOut = f => `probe/${f}`;
const absOut = f => U.insideRun(run, 'probe', f).split(/[\\/]/).join('/');

// ---------- warnings ----------
const warnings = [];
try {
  const q = new URL(url).searchParams;
  const CACHE_BUST = ['v', 'e', '_', 'nocache', 'cb', 'cachebust', 'ts', 'rnd', 'rand', 't'];
  const bad = [...q.keys()].filter(k => CACHE_BUST.includes(k.toLowerCase()) || /^utm_/i.test(k));
  const known = (pagesDoc?.selected || []).some(s => s.url === url);
  if (bad.length && !known) warnings.push(T(`В адресе метки ${bad.join(', ')} — не добавляйте их: счётчики сдают такие адреса в индекс. Холодную загрузку probe и так делает без кэша.`,
    `The URL has ${bad.join(', ')} parameters — do not add them: counters report such URLs to search engines. probe already loads without cache.`));
} catch { /* bad URL handled above */ }

// ---------- which hosts this run may open ----------
const within = (h, b) => h === b || h.endsWith('.' + b);
function runHosts() {
  const site = new Set(), rivals = new Set();
  const add = (set, u) => {
    if (!u || typeof u !== 'string') return;
    try { const h = new URL(U.normalizeUrl(u)).hostname.toLowerCase().replace(/\.$/, ''); if (h) set.add(U.stripWww(h)); } catch { /* not a URL */ }
  };
  for (const v of [state.flags?.url, state.flags?.baseline, pagesDoc?.site, pagesDoc?.final_origin, pagesFrom?.site, pagesFrom?.final_origin,
    brief.url, briefIn.url, brief.baseline, briefIn.baseline]) add(site, v);
  for (const doc of [pagesDoc, pagesFrom]) for (const s of doc?.selected || []) { add(site, s.url); add(site, s.final_url); }
  const rj = readOpt(join(run, 'rivals', 'rivals.json'));
  for (const s of Object.values(rj?.sites || {})) add(rivals, s?.url);
  try {
    for (const d of readdirSync(join(run, 'rivals'), { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const c = readOpt(join(run, 'rivals', d.name, 'capture.json'));
      add(rivals, c?.url);
      for (const p of c?.pages || []) add(rivals, p?.url);
    }
  } catch { /* no rivals yet */ }
  for (const u of [...(Array.isArray(brief.rivals_light) ? brief.rivals_light : []), ...(Array.isArray(briefIn.rivals_light) ? briefIn.rivals_light : [])]) add(rivals, typeof u === 'string' ? u : u?.url);
  for (const u of U.listArg(Array.isArray(state.flags?.urls) ? state.flags.urls.map(x => (typeof x === 'string' ? x : x?.url)).filter(Boolean) : state.flags?.urls)) add(rivals, u);
  return { site, rivals };
}
// static files the page itself uses (og:image, pictures, icons): fetched as files, no browser, any host when linked
const STATIC_EXT = /\.(jpe?g|png|webp|avif|svg|gif|ico)$/i;
// a document (PDF) or a static file on another host is allowed when the reviewed site links to it exactly as given
// (pages.json → documents, snapshot DOM / raw HTML): the address and its parameters come from the site, not from us
function linkedFromSite(u) {
  if ((pagesDoc?.documents || []).some(d => d?.url === u)) return 'pages.json → documents';
  const variants = [u, u.replace(/&/g, '&amp;')];
  try {
    const snap = join(run, 'snapshot');
    for (const d of readdirSync(snap, { withFileTypes: true }).slice(0, 40)) {
      if (!d.isDirectory()) continue;
      for (const f of ['dom.html', 'raw.html']) {
        const p = join(snap, d.name, f);
        if (!existsSync(p) || statSync(p).size > 8 * 1024 * 1024) continue;
        const html = readFileSync(p, 'utf8');
        if (variants.some(v => html.includes(v))) return `snapshot/${d.name}/${f}`;
      }
    }
  } catch { /* no snapshot */ }
  return null;
}
function hostPolicy(u) {
  const { site, rivals } = runHosts();
  if (!site.size && !rivals.size) return { ok: false, why: 'unknown_site' };
  const h = U.stripWww(U.hostOf(u));
  if ([...site].some(b => within(h, b))) return { ok: true, by: 'site' };
  if ([...rivals].some(b => within(h, b))) return { ok: true, by: 'rivals' };
  let isDoc = false; try { isDoc = /\.pdf$/i.test(new URL(u).pathname) || STATIC_EXT.test(new URL(u).pathname); } catch { /* no */ }
  const link = isDoc ? linkedFromSite(u) : null;
  if (link) return { ok: true, by: link };
  return { ok: false, why: 'other_host', site: [...site].slice(0, 3) };
}

// service paths (secrets, admin panels, dumps) are opened only when the run allows the --probe checks
const SERVICE_PATH = /(^|\/)(\.env(\.[\w-]+)?|\.git|\.svn|\.hg|\.DS_Store|\.htaccess|\.htpasswd|wp-admin|wp-login\.php|xmlrpc\.php|administrator|phpmyadmin|pma|server-status|server-info|phpinfo\.php|composer\.(json|lock)|package\.json|backup\.(zip|tar|gz|rar|7z)|dump\.sql)(\/|$)|\/bitrix\/admin(\/|$)|\/wp-json\/wp\/v2\/users|\.(sql|bak|old|orig|swp)$/i;
const isServicePath = u => { try { const p = decodeURIComponent(new URL(u).pathname); return SERVICE_PATH.test(p); } catch { return true; } };
const serviceAllowed = [brief.limits?.probe, briefIn.limits?.probe, state.flags?.probe].includes(true);

// ---------- local site allowance ----------
async function allowLocal(u) {
  const h = U.hostOf(u);
  if (!h || !(await U.resolvesPrivate(h))) return;
  const site = pagesDoc?.final_origin || pagesDoc?.site || state.flags?.url || null;
  let siteHost = null; try { siteHost = site ? new URL(U.normalizeUrl(site)).host.toLowerCase() : null; } catch { /* none */ }
  const loopback = h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::1]' || h === '::1';
  if ((siteHost && siteHost === new URL(u).host.toLowerCase()) || (!siteHost && loopback)) U.allowPrivateHost(h);
}

// ---------- in-page code, isolated world ----------
// Every helper below runs through iso(): same DOM, separate JS globals, so the page cannot fake what we measure or check.
// rvLib() is prepended to each call: visibility, the contact-field check and the form scope.
function rvLib() {
  const clean = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const vis = e => {
    if (!e || !e.getBoundingClientRect) return false;
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.01;
  };
  const WORDS = new RegExp('(?<![\\p{L}\\p{N}])(?:' + ['телефон\\p{L}*', 'тел', 'моб', 'мобильн\\p{L}*', 'сотов\\p{L}*', 'whats\\s?app', 'ватсап\\p{L}*', 'вотсап\\p{L}*',
    'вайбер\\p{L}*', 'viber', 'телеграм\\p{L}*', 'telegram', 'почт\\p{L}*', 'e-?mail', 'имейл\\p{L}*', 'емейл\\p{L}*', 'мейл\\p{L}*', 'имя', 'имени', 'фамили\\p{L}*',
    'отчеств\\p{L}*', 'фио', 'fio', 'ник', 'никнейм\\p{L}*', 'логин\\p{L}*', 'пароль', 'пароля', 'комментари\\p{L}*', 'сообщени\\p{L}*', 'контакт\\p{L}*',
    'phone\\p{L}*', 'mobile', 'cell', 'tel', 'mail', 'name', 'first\\s?name', 'last\\s?name', 'surname', 'full\\s?name', 'nick\\p{L}*', 'login', 'password',
    'contacts?', 'message', 'comments?', 'связ\\p{L}*', 'обращ\\p{L}*', 'номер\\p{L}*', 'зовут', 'звон\\p{L}*', 'перезвон\\p{L}*', 'адрес\\p{L}*',
    'client\\p{L}*', 'клиент\\p{L}*', 'address', 'call\\s?back'].join('|') + ')(?![\\p{L}\\p{N}])', 'iu');
  // phone-like text or mask: "+7 (___) ___-__-__", "+7 (999) 999-99-99", "8 900 000 00 00", "(___) ___"
  const PHONE = /(\+\s?\d{1,3}|(?<![\d])8)[\s\-]*\(?\s*[\d_X#*•]{3}\s*\)?[\s\-]*[\d_X#*•]{3}[\s\-]*[\d_X#*•]{2}[\s\-]*[\d_X#*•]{2}/i;
  const MASK = /\(\s*[_X#*•9]{3}\s*\)|_{2,}\s*-\s*_{2}|^\s*\+?\d?\s*\(?\s*_{3}/i;
  const split = t => String(t).replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, '$1 $2').replace(/[_.\[\]]+/g, ' ');
  const SKIP_ATTR = /^(class|style|value|src|href|pattern|min|max|step|size|maxlength|minlength|tabindex|type|inputmode|autocomplete|required|disabled|readonly|checked|selected|rows|cols|form|list|accept|dir|lang|spellcheck|autofocus|data-rv-fill)$/i;
  const FIELDS = 'input,textarea,select,[contenteditable=""],[contenteditable="true"]';
  const labelsOf = el => {
    const out = [];
    try { for (const l of el.labels || []) out.push(l.innerText || l.textContent); } catch (e) { /* no labels */ }
    const lb = el.getAttribute('aria-labelledby');
    if (lb) for (const id of lb.split(/\s+/)) { const x = document.getElementById(id); if (x) out.push(x.textContent); }
    const cl = el.closest('label'); if (cl) out.push(cl.textContent);
    // text right before the field (or before its wrapper, up to 3 levels) while that block holds no other field
    let a = el;
    for (let k = 0; a && k < 3 && out.length < 8; k++, a = a.parentElement) {
      let s = a.previousElementSibling, n = 0;
      while (s && n < 2) {
        if (s.querySelector && s.querySelector('input,select,textarea')) break;
        const t = clean(s.innerText || s.textContent);
        if (t) { if (t.length <= 80) out.push(t); break; }
        s = s.previousElementSibling; n++;
      }
      let p = a.previousSibling;
      while (p && p.nodeType === 3 && !clean(p.textContent)) p = p.previousSibling;
      if (p && p.nodeType === 3) out.push(p.textContent);
      if (a.parentElement && a.parentElement.querySelectorAll('input,select,textarea').length > 1) break;
    }
    return out.map(clean).filter(t => t && t.length <= 160);
  };
  const isContactField = el => {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (!/^(INPUT|TEXTAREA|SELECT)$/.test(tag) && !el.isContentEditable) return false;
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'INPUT' && /^(hidden|submit|button|image|reset|checkbox|radio|range|color|file)$/.test(type)) return false;
    if (tag === 'TEXTAREA' || (tag !== 'INPUT' && tag !== 'SELECT' && el.isContentEditable)) return true;
    if (/^(tel|email|password)$/.test(type)) return true;
    const im = (el.getAttribute('inputmode') || '').toLowerCase();
    if (im === 'tel' || im === 'email') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/(^|\s)(tel(-[\w-]+)?|email|name|given-name|family-name|additional-name|nickname|username|new-password|current-password|honorific-prefix|honorific-suffix|organization|street-address|address-line\d|postal-code|bday(-\w+)?|cc-[\w-]+|impp)(\s|$)/.test(ac)) return true;
    const ph = el.getAttribute('placeholder') || '';
    if (ph.includes('@') || PHONE.test(ph) || MASK.test(ph)) return true;
    const texts = [ph, ...labelsOf(el)];
    for (const a of el.attributes) if (!SKIP_ATTR.test(a.name)) texts.push(a.value);
    return texts.some(t => t && String(t).length <= 160 && (WORDS.test(split(t)) || PHONE.test(t) || MASK.test(t) || /^[^@\s]{1,30}@[^@\s]{1,40}$/.test(String(t).trim())));
  };
  const describe = f => (f ? { tag: f.tagName.toLowerCase(), type: f.getAttribute('type') || null, name: f.getAttribute('name') || null, id: f.id || null,
    placeholder: (f.getAttribute('placeholder') || '').slice(0, 40) || null } : null);
  // the form of an element (or a formless block up to `levels` ancestors) and whether it holds a contact field
  const scopeOf = (el, levels = 6, needButton = false) => {
    const form = (el.form instanceof HTMLFormElement ? el.form : null) || (el.closest ? el.closest('form') : null);
    if (form) { const hit = [...form.querySelectorAll(FIELDS)].find(isContactField); return { scope: 'form', contact: !!hit, field: describe(hit) }; }
    for (let a = el.parentElement, k = 0; a && k < levels && !/^(BODY|HTML|MAIN)$/.test(a.tagName); a = a.parentElement, k++) {
      const hit = [...a.querySelectorAll(FIELDS)].find(f => f !== el && !f.closest('form') && vis(f) && isContactField(f));
      if (!hit) continue;
      if (needButton && !a.querySelector('button, [type=submit], [type=button], [role=button], a[href], [onclick]')) continue;
      return { scope: 'block', contact: true, field: describe(hit), levels: k + 1 };
    }
    return { scope: null, contact: false, field: null };
  };
  return { clean, vis, isContactField, scopeOf, describe };
}
const iso = (page, fn, ...a) => page.evaluateIsolated(`(() => { const RV = (${rvLib.toString()})(); return (${fn.toString()})(RV, ...${JSON.stringify(a)}); })()`);

function inPageMetrics(RV) {
  const de = document.documentElement; const cw = de.clientWidth || innerWidth;
  const sw = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
  const h = Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0);
  const path = el => {
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return '#' + el.id;
    const parts = [];
    for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) {
      let p = e.tagName.toLowerCase();
      const cls = (typeof e.className === 'string' ? e.className : '').trim().split(/\s+/).filter(c => /^[A-Za-z_][\w-]*$/.test(c)).slice(0, 2);
      if (cls.length) p += '.' + cls.join('.');
      parts.unshift(p);
      if (e.id && /^[A-Za-z][\w-]*$/.test(e.id)) { parts[0] = '#' + e.id; break; }
    }
    return parts.join(' > ');
  };
  const offenders = [];
  if (sw > cw + 1 && document.body) {
    const all = document.body.getElementsByTagName('*');
    const hits = [];
    for (let i = 0; i < all.length && i < 8000; i++) {
      const el = all[i]; const r = el.getBoundingClientRect();
      if (r.width === 0 || r.right <= cw + 1) continue;
      let clipped = false;
      for (let a = el.parentElement; a && a !== document.body && a !== de; a = a.parentElement) {
        const ox = getComputedStyle(a).overflowX;
        if (ox !== 'visible' && a.getBoundingClientRect().right <= cw + 1) { clipped = true; break; }
      }
      if (!clipped) hits.push(el);
    }
    const top = hits.filter(el => !hits.some(o => o !== el && o.contains(el)));
    for (const el of top.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right).slice(0, 5)) {
      const r = el.getBoundingClientRect();
      offenders.push({ selector: path(el), right: Math.round(r.right), over_px: Math.round(r.right - cw), box: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)], text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
    }
  }
  return { url: location.href, title: document.title, doc_height: h, doc_width: sw, client_width: cw, viewport: [innerWidth, innerHeight],
    overflow_x_px: Math.max(0, sw - cw), offenders, scroll_y: Math.round(scrollY), ready: document.readyState,
    text_len: (document.body?.innerText || '').trim().length };
}

function inPageHideOverlays(RV) {
  const vw = document.documentElement.clientWidth || innerWidth, vh = innerHeight;
  const all = document.body ? document.body.getElementsByTagName('*') : [];
  const fx = [];
  for (const el of all) { const p = getComputedStyle(el).position; if (p === 'fixed' || p === 'sticky') fx.push(el); }
  const outer = fx.filter(el => !fx.some(o => o !== el && o.contains(el)));
  const bodyText = (document.body?.innerText || '').length || 1;
  const out = [];
  for (const el of outer) {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05)) continue;
    const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const share = Math.round(1000 * iw * ih / (vw * vh)) / 10;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const sig = [el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('role'), el.getAttribute('aria-label')].join(' ').toLowerCase();
    let kind = null;
    if (share > 0 && text.length < 2500 && (/cookie|куки|кук[иа]м?\b|consent|gdpr|согласие на (использование|обработку) (файлов|cookie)|используем (файлы )?cookie/i.test(text) || /cookie|consent|gdpr/.test(sig))) kind = 'cookie';
    else if (share > 0 && text.length < 600 && /ваш город|выберите (ваш )?город|ваш регион|город определ|определили (ваш )?город|your (city|region|location)/i.test(text)) kind = 'city';
    else if (share >= 25 && cs.position === 'fixed' && text.length / bodyText < 0.5 && !/^(header|nav|main)$/i.test(el.tagName)
      && (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true' || /modal|popup|pop-up|overlay|lightbox|dialog|subscribe|fancybox/.test(sig))) kind = 'modal';
    if (!kind) continue;
    el.style.setProperty('display', 'none', 'important');
    out.push({ kind, tag: el.tagName.toLowerCase(), text: text.slice(0, 120) });
  }
  return out;
}

function inPageLocate(RV, sel) {
  let els;
  try { els = [...document.querySelectorAll(sel)]; } catch (e) { return { error: 'bad_selector' }; }
  const el = els.find(RV.vis);
  if (!el) return { error: els.length ? 'not_visible' : 'not_found', count: els.length };
  const r = el.getBoundingClientRect();
  window.__rvTarget = el;
  return { count: els.length, x: Math.round(r.left + r.width / 2 + scrollX), y: Math.round(r.top + r.height / 2 + scrollY), w: Math.round(r.width), h: Math.round(r.height),
    tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 80) };
}

// Bring a document point into the visual viewport and translate it to input coordinates. On a phone page that is
// wider than the screen the layout viewport (elementFromPoint) is larger than the visual one (Input.dispatch*) and the
// two are offset: client = input / scale + visualViewport.offset. window.scrollTo moves only the layout viewport there,
// so when the point is still outside the visual viewport the target (or a 1×1 marker) is scrolled into view.
function inPageCenter(RV, x, y, useTarget) {
  const V = () => window.visualViewport || { scale: 1, offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight };
  const inView = () => { const vv = V(); const vx = x - scrollX - vv.offsetLeft, vy = y - scrollY - vv.offsetTop; return vx >= 0 && vy >= 0 && vx < vv.width - 1 && vy < vv.height - 1; };
  let how = null;
  if (!inView()) { const vv = V(); window.scrollTo({ top: Math.max(0, y - vv.height / 2), left: Math.max(0, x - vv.width / 2), behavior: 'instant' }); how = 'scrollTo'; }
  if (!inView()) {
    const t = useTarget && window.__rvTarget && window.__rvTarget.isConnected ? window.__rvTarget : null;
    if (t) { t.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); how = 'scrollIntoView'; }
    else {
      const m = document.createElement('div');
      m.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:1px;height:1px;pointer-events:none;visibility:hidden`;
      document.documentElement.appendChild(m);
      m.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      m.remove(); how = 'marker';
    }
  }
  const vv = V();
  const cx = x - scrollX, cy = y - scrollY;
  return { cx: Math.round(cx), cy: Math.round(cy), ix: Math.round((cx - vv.offsetLeft) * vv.scale), iy: Math.round((cy - vv.offsetTop) * vv.scale),
    scroll_y: Math.round(scrollY), vv: [Math.round(vv.scale * 1000) / 1000, Math.round(vv.offsetLeft), Math.round(vv.offsetTop)], visible: inView(), how };
}

function inPageOnTop(RV, x, y) {
  const t = window.__rvTarget; const e = document.elementFromPoint(x, y);
  if (!t || !e) return null;
  if (t === e || t.contains(e)) return true;
  return e.contains(t) && e.matches('a, button, [role="button"], label, summary, [onclick]');
}

// a control (button, link, label…) under the point that belongs to a form or block with a contact field is never pressed
function inPageControlContact(RV, x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return { refuse: false };
  const ctl = el.closest('button, a[href], [role="button"], [role="link"], [role="menuitem"], input, summary, label, [onclick]');
  if (!ctl) return { refuse: false };
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(ctl.tagName) && !/^(submit|button|image|reset)$/i.test(ctl.getAttribute('type') || '')) return { refuse: false };
  const sc = RV.scopeOf(ctl, 4, false);
  return sc.contact ? { refuse: true, scope: sc.scope, field: sc.field } : { refuse: false };
}

// prepare a field for typing; refuse contact fields and fields of contact forms (or formless contact blocks)
function inPageFillPrep(RV, sel, idx) {
  let els;
  try { els = [...document.querySelectorAll(sel)]; } catch (e) { return { error: 'bad_selector' }; }
  const el = els.find(RV.vis) || els[0];
  if (!el) return { error: 'not_found' };
  const self = RV.isContactField(el);
  const sc = self ? null : RV.scopeOf(el, 6, true);
  const tag = el.tagName.toLowerCase(); const type = (el.getAttribute('type') || '').toLowerCase();
  const kind = tag === 'select' ? 'select' : tag === 'textarea' ? 'text' : ['checkbox', 'radio'].includes(type) ? type : type === 'range' ? 'range'
    : ['date', 'time', 'datetime-local', 'month', 'week', 'color', 'file', 'hidden', 'submit', 'button', 'image', 'reset'].includes(type) ? 'other'
    : el.isContentEditable ? 'other' : (tag === 'input' ? 'text' : 'other');
  el.setAttribute('data-rv-fill', String(idx));
  let target = el;
  if (!RV.vis(el) && el.id) { const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (lab && RV.vis(lab)) target = lab; }
  if (!RV.vis(target) && el.closest('label') && RV.vis(el.closest('label'))) target = el.closest('label');
  window.__rvTarget = target;
  const r = target.getBoundingClientRect();
  return { tag, type, kind, contact: self || !!(sc && sc.contact), contact_why: self ? 'field' : sc && sc.contact ? 'form' : null, contact_field: sc && sc.contact ? sc.field : null,
    x: Math.round(r.left + r.width / 2 + scrollX), y: Math.round(r.top + r.height / 2 + scrollY), value: el.value ?? null, checked: el.checked ?? null, visible: RV.vis(el) };
}
function inPageFieldState(RV, idx) {
  const el = document.querySelector(`[data-rv-fill="${idx}"]`);
  if (!el) return null;
  return { focused: document.activeElement === el, value: el.value ?? null, checked: el.checked ?? null, valid: el.checkValidity ? el.checkValidity() : null,
    message: el.validationMessage || null, len: String(el.value ?? '').length };
}
function inPageFocus(RV, idx) { const el = document.querySelector(`[data-rv-fill="${idx}"]`); if (el) el.focus(); return !!el && document.activeElement === el; }
function inPageBlur(RV, idx) { const el = document.querySelector(`[data-rv-fill="${idx}"]`); if (el && document.activeElement === el) el.blur(); return true; }
function inPageSetValue(RV, idx, value, kind) { // select / range: no native typing possible
  const el = document.querySelector(`[data-rv-fill="${idx}"]`);
  if (!el) return { error: 'gone' };
  if (kind === 'select') {
    const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
    const opt = [...el.options].find(o => o.value === value) || [...el.options].find(o => norm(o.textContent) === norm(value)) || [...el.options].find(o => norm(o.textContent).includes(norm(value)));
    if (!opt) return { error: 'no_option', options: [...el.options].slice(0, 20).map(o => o.textContent.trim().slice(0, 40)) };
    el.value = opt.value;
  } else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { value: el.value };
}
function inPageRead(RV, sel) {
  let els;
  try { els = [...document.querySelectorAll(sel)]; } catch (e) { return { error: 'bad_selector' }; }
  return { count: els.length, items: els.slice(0, 10).map(el => {
    const isField = /^(INPUT|SELECT|TEXTAREA|OUTPUT)$/.test(el.tagName);
    return { text: isField ? null : ((el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300)), value: isField ? String(el.value ?? '').slice(0, 300) : undefined, visible: RV.vis(el) };
  }) };
}
function inPageScroll(RV, v) {
  if (/^\d+$/.test(v)) { window.scrollTo({ top: Number(v), left: 0, behavior: 'instant' }); return { y: Math.round(scrollY) }; }
  let el; try { el = document.querySelector(v); } catch (e) { return { error: 'bad_selector' }; }
  if (!el) return { error: 'not_found' };
  el.scrollIntoView({ block: 'start', behavior: 'instant' });
  return { y: Math.round(scrollY) };
}
// our stylesheet (<link data-rv-probe> from the substituted HTML or a late <style>): present and parsed?
function inPageCssState(RV) {
  const el = document.querySelector('[data-rv-probe="css"]');
  if (!el) return { present: false };
  let rules = null; try { rules = el.sheet ? el.sheet.cssRules.length : null; } catch (e) { rules = -1; }
  return { present: true, tag: el.tagName.toLowerCase(), loaded: !!el.sheet, rules };
}
function inPageAddStyle(RV, css) {
  const s = document.createElement('style');
  s.setAttribute('data-rv-probe', 'css-late');
  s.textContent = css;
  (document.head || document.documentElement).appendChild(s);
  const loaded = !!s.sheet;
  if (!loaded) s.remove(); // blocked by CSP: leave nothing behind
  return { loaded };
}
// styles of focusable elements before a key press: after it, the focused one is compared with itself unfocused
function inPageStyleSnap(RV) {
  const PROPS = ['backgroundColor', 'color', 'textDecorationLine', 'textDecorationColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
    'borderTopWidth', 'outlineStyle', 'outlineWidth', 'outlineColor', 'boxShadow', 'fontWeight', 'transform'];
  const snap = new WeakMap(); let n = 0;
  for (const el of document.querySelectorAll('a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"], [role="button"], [role="link"], [role="tab"], [role="menuitem"]')) {
    if (n++ > 800) break;
    if (el === document.activeElement) continue; // the one focused now is not "unfocused"
    const cs = getComputedStyle(el); const o = {};
    for (const p of PROPS) o[p] = cs[p];
    snap.set(el, o);
  }
  window.__rvSnap = { map: snap, props: PROPS };
  return n;
}
// where the keyboard focus is; for Enter/Space — whether pressing would submit or touch a contact form
function inPageFocusInfo(RV, press, keyName) {
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return { tag: a ? a.tagName.toLowerCase() : null, none: true };
  const r = a.getBoundingClientRect(); const cs = getComputedStyle(a);
  const info = { tag: a.tagName.toLowerCase(), id: a.id || null, role: a.getAttribute('role'), type: a.getAttribute('type') || null,
    text: RV.clean(a.innerText || a.value || a.getAttribute('aria-label') || a.getAttribute('title') || '').slice(0, 60),
    box: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)], visible: RV.vis(a),
    in_view: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
    ring: { outline: cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 ? `${cs.outlineStyle} ${cs.outlineWidth} ${cs.outlineColor}` : null, shadow: cs.boxShadow !== 'none' ? cs.boxShadow.slice(0, 80) : null } };
  if (!press) {
    // what changed on focus compared with the same element unfocused (snapshot before the key)
    const s = window.__rvSnap; const before = s && s.map.get(a);
    if (before) {
      const NAMES = { backgroundColor: 'background-color', color: 'color', textDecorationLine: 'text-decoration', textDecorationColor: 'text-decoration-color', borderTopColor: 'border-color',
        borderRightColor: 'border-color', borderBottomColor: 'border-color', borderLeftColor: 'border-color', borderTopWidth: 'border-width', outlineStyle: 'outline', outlineWidth: 'outline',
        outlineColor: 'outline', boxShadow: 'box-shadow', fontWeight: 'font-weight', transform: 'transform' };
      const changed = []; const seen = new Set();
      for (const p of s.props) {
        if (before[p] === cs[p] || seen.has(NAMES[p])) continue;
        if (p === 'outlineColor' && cs.outlineStyle === 'none') continue;
        // colours that only follow the text colour of an invisible border / absent underline are not a visible change
        if (/^border\w+Color$/.test(p) && parseFloat(cs.borderTopWidth) === 0 && parseFloat(before.borderTopWidth) === 0) continue;
        if (p === 'textDecorationColor' && cs.textDecorationLine === 'none') continue;
        seen.add(NAMES[p]); changed.push({ prop: NAMES[p], before: String(before[p]).slice(0, 60), after: String(cs[p]).slice(0, 60) });
      }
      info.changed = changed;
      info.focus_visible = changed.length > 0;
    } else info.changed = null; // the element had focus before the key or was not in the snapshot
    return info;
  }
  const type = (a.getAttribute('type') || '').toLowerCase();
  const form = (a.form instanceof HTMLFormElement ? a.form : null) || a.closest('form');
  const label = (a.innerText || a.value || a.getAttribute('aria-label') || '').trim().toLowerCase();
  let consent = /cookie|куки/.test(label);
  for (let n = a, k = 0; n && k < 6 && !consent; n = n.parentElement, k++) consent = /cookie|consent|gdpr|cmp|согласи/.test(((n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : '')).toLowerCase());
  if ((a.tagName === 'BUTTON' && (type === 'submit' || (!type && form))) || (a.tagName === 'INPUT' && ['submit', 'image'].includes(type))) info.refuse = 'submit';
  else if (keyName === 'Enter' && form && /^(INPUT|SELECT)$/.test(a.tagName)) info.refuse = 'implicit-submit';
  else if (consent && /^(принять|принимаю|согласен|согласна|разрешить|ok|ок|хорошо|понятно|accept|agree|allow|got it|yes)/.test(label)) info.refuse = 'consent-accept';
  else if (RV.isContactField(a) || RV.scopeOf(a, 4, false).contact) info.refuse = 'contact-form';
  return info;
}

// ---------- main-world init: vitals, CSP violations ----------
// Runs before page scripts in every frame.
function pageInit() {
  try {
    window.__rvVitals = { lcp: null, cls: 0, fcp: null };
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__rvVitals.lcp = Math.round(e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__rvVitals.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__rvVitals.fcp = Math.round(e.startTime); }).observe({ type: 'paint', buffered: true });
  } catch (e) { /* old engine */ }
  try {
    window.__rvCsp = [];
    document.addEventListener('securitypolicyviolation', e => {
      const a = window.__rvCsp;
      if (Array.isArray(a) && a.length < 60) a.push({ directive: e.effectiveDirective || e.violatedDirective, blocked: String(e.blockedURI || '').slice(0, 200), sample: String(e.sample || '').slice(0, 80) });
    }, true);
  } catch (e) { /* no CSP events */ }
  // window.open() and WebSocket are locked by lib/cdp (PAGE_GUARD_SRC): attempts land in page.blocked.popup / .websocket
}
const INIT = `(${pageInit.toString()})();`;

// ---------- HTML substitution (lib/cdp: page.interceptDocument + page.serveLocal) ----------
function inPageSubstitute(html, sel, snippet, place) { // runs in a scriptless tool tab (main world of about:blank)
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let el; try { el = doc.querySelector(sel); } catch (e) { return { error: 'bad_selector' }; }
  if (!el) return { error: 'not_found' };
  const where = { replace: 'outer', inner: 'inner', before: 'beforebegin', after: 'afterend', append: 'beforeend', prepend: 'afterbegin' }[place] || 'outer';
  if (where === 'outer') el.outerHTML = snippet;
  else if (where === 'inner') el.innerHTML = snippet;
  else el.insertAdjacentHTML(where, snippet);
  const dt = doc.doctype ? `<!DOCTYPE ${doc.doctype.name}${doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : ''}${doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : ''}>\n` : '';
  return { html: dt + doc.documentElement.outerHTML };
}
function decodeHtml(buf, contentType) {
  let cs = (String(contentType || '').match(/charset=([\w-]+)/i) || [])[1];
  if (!cs) { const head = buf.subarray(0, 4096).toString('latin1'); cs = (head.match(/<meta[^>]+charset=["']?([\w-]+)/i) || [])[1]; }
  try { return new TextDecoder(cs || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}
async function transformHtml(html, snippet, toolPage, aa = false) {
  const a = at.trim();
  const tag = a.match(/^<(\/?)(head|body)>$/i);
  // A/A base: the same path without a change (a tag or a marker — the HTML as is; a selector — the same DOMParser round trip)
  if (aa && (tag || /^<!--/.test(a))) return { html, where: `${a} (A/A)` };
  if (aa) {
    const r = await toolPage.evaluate(inPageSubstitute, html, a, '', 'append');
    return r?.error ? { error: r.error } : { html: r.html, where: `${a} (A/A)` };
  }
  if (tag) {
    const re = new RegExp(tag[1] ? `</${tag[2]}\\s*>` : `<${tag[2]}(\\s[^>]*)?>`, 'i');
    const m = html.match(re);
    if (!m) return { error: T(`в HTML нет ${a}`, `no ${a} in the HTML`) };
    const i = m.index + (tag[1] ? 0 : m[0].length);
    return { html: html.slice(0, i) + snippet + html.slice(i), where: a };
  }
  const mark = a.match(/^<!--\s*(.+?)\s*-->$/);
  if (mark) {
    const name = mark[1].replace(/^\//, '');
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const open = new RegExp(`<!--\\s*${esc}\\s*-->`), close = new RegExp(`<!--\\s*/${esc}\\s*-->`);
    const mo = html.match(open);
    if (!mo) return { error: T(`в HTML нет метки <!-- ${name} -->`, `no <!-- ${name} --> marker in the HTML`) };
    const start = mo.index + mo[0].length;
    const rest = html.slice(start);
    const mc = rest.match(close);
    return mc ? { html: html.slice(0, start) + snippet + rest.slice(mc.index), where: `<!-- ${name} -->…<!-- /${name} -->` }
      : { html: html.slice(0, start) + snippet + rest, where: `<!-- ${name} -->` };
  }
  const r = await toolPage.evaluate(inPageSubstitute, html, a, snippet, place);
  if (r?.error === 'not_found') return { error: T(`селектор «${a}» не найден в HTML от сервера (блок может рисовать JS — тогда --css или вставка скрипта перед </body>)`, `selector "${a}" not found in the server HTML (the block may be rendered by JS)`) };
  if (r?.error) return { error: T(`плохой селектор «${a}»`, `bad selector "${a}"`) };
  return { html: r.html, where: `${a} (${place})` };
}
function insertCssLink(html, href) {
  const tag = `<link rel="stylesheet" href="${href}" data-rv-probe="css">`;
  let m = html.match(/<\/head\s*>/i);
  if (m) return { html: html.slice(0, m.index) + tag + html.slice(m.index), where: '</head>' };
  m = html.match(/<body(\s[^>]*)?>/i);
  if (m) return { html: html.slice(0, m.index) + tag + html.slice(m.index), where: '<body>' };
  return { html: tag + html, where: 'start' };
}
// Through the official lib/cdp hooks: page.interceptDocument replaces the first main-frame HTML response (2xx or
// --allow-status) after the safety net has passed the request; page.serveLocal answers our stylesheet URL, so it never
// reaches the site.
async function enableSubstitution(page, browser, want, aa = false) {
  const info = { substituted: false, where: null, error: null, css_url: null, css_served: 0, inject: null, aa };
  const cssBody = aa ? '' : (cssFile?.text || '');
  if (typeof page.interceptDocument !== 'function' || typeof page.serveLocal !== 'function') {
    info.error = T('подмена недоступна: в lib/cdp.mjs нет interceptDocument/serveLocal', 'substitution unavailable: lib/cdp.mjs has no interceptDocument/serveLocal');
    return info;
  }
  let tool = null, done = false, css = null;
  const hook = await page.interceptDocument(async doc => {
    if (done || !doc.main) return;
    const code = doc.status || 0;
    const okStatus = (code >= 200 && code < 300) || allowStatus.includes(code);
    if (!okStatus) {
      if (code) info.error = T(`ответ ${code} — подмена только для 2xx (добавьте --allow-status ${code})`, `response ${code} — only 2xx is substituted (add --allow-status ${code})`);
      return;
    }
    if (doc.mime && !/html/i.test(doc.mime)) return;
    done = true;
    try {
      let html = decodeHtml(await doc.body(), doc.header('content-type'));
      const where = [];
      if (want.inject) {
        if (!tool && !/^<\/?(head|body)>$/i.test(at.trim()) && !/^<!--/.test(at.trim())) {
          tool = await browser.newPage({ blockNavigation: true });
          await tool.send('Emulation.setScriptExecutionDisabled', { value: true });
        }
        const t = await transformHtml(html, injFile.text, tool, aa);
        // a second tab steals focus: touch input to a background tab is never acknowledged
        if (tool) { try { await tool.close(); } catch { /* ignore */ } tool = null; }
        if (t.error) info.inject = { ok: false, error: t.error };
        else { html = t.html; where.push(t.where); info.inject = { ok: true, where: t.where }; }
      }
      if (want.css) {
        info.css_url = new URL(`__revizor-probe-${randomBytes(4).toString('hex')}.css`, doc.url).href;
        css = page.serveLocal(info.css_url, { body: cssBody, contentType: 'text/css; charset=utf-8' });
        const t = insertCssLink(html, info.css_url);
        html = t.html; where.push(`css ${t.where}`);
      }
      if (!where.length) { info.error = info.inject?.error || 'nothing to insert'; return; }
      info.substituted = true; info.where = where.join(' + ');
      return { body: html, status: code, contentType: 'text/html; charset=utf-8' };
    } catch (e) {
      info.error = String(e?.message || e).slice(0, 200);
    }
  });
  Object.defineProperty(info, 'css_served', { enumerable: true, get: () => css?.served || 0 });
  info.closeTool = async () => {
    try { await tool?.close(); } catch { /* ignore */ }
    if (!info.substituted && !info.error && hook.errors.length) info.error = hook.errors[0];
  };
  return info;
}

// --css in the "after" load: our stylesheet from the HTML; if it is not there (CSP, not HTML) — a late <style>, then DevTools
async function ensureCss(page, sub) {
  const viol = await page.evaluate('window.__rvCsp || []').catch(() => []);
  const st = await iso(page, inPageCssState).catch(() => null);
  if (st?.present && st.loaded) return { applied: true, method: 'stylesheet', at_load: true, rules: st.rules };
  const cspHit = !!sub?.css_url && (viol || []).some(v => v.blocked && v.blocked.startsWith(sub.css_url));
  const why = !sub ? 'no_substitution' : !sub.substituted ? (sub.error || 'not_html') : cspHit ? 'csp' : st?.present ? 'not_loaded' : 'removed_by_page';
  const s2 = await iso(page, inPageAddStyle, cssFile.text).catch(e => ({ error: e.message }));
  await U.sleep(250);
  if (s2?.loaded) return { applied: true, method: 'style', at_load: false, late_why: why };
  try {
    await page.send('DOM.enable'); await page.send('CSS.enable');
    const { styleSheetId } = await page.send('CSS.createStyleSheet', { frameId: page.mainFrameId });
    await page.send('CSS.setStyleSheetText', { styleSheetId, text: cssFile.text });
    await U.sleep(250);
    return { applied: true, method: 'devtools', at_load: false, late_why: why, inline_blocked: s2?.loaded === false ? 'csp' : null };
  } catch (e) {
    return { applied: false, blocked_by: why === 'csp' || s2?.loaded === false ? 'csp' : why, error: String(e?.message || e).slice(0, 160) };
  }
}

// ---------- PDF text without libraries: objects (also in object streams), Flate, ToUnicode CMaps, text operators ----------
function pdfInflate(b) {
  try { return zlib.inflateSync(b); } catch { /* try lenient */ }
  try { return zlib.inflateSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { /* raw */ }
  try { return zlib.inflateRawSync(b, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { return null; }
}
function pdfA85(b) {
  const s = b.toString('latin1').replace(/^\s*<~/, '').replace(/~>[\s\S]*$/, '').replace(/\s+/g, '');
  const out = []; let grp = [];
  for (const ch of s) {
    if (ch === 'z' && !grp.length) { out.push(0, 0, 0, 0); continue; }
    grp.push(ch.charCodeAt(0) - 33);
    if (grp.length === 5) { let n = 0; for (const d of grp) n = n * 85 + d; out.push((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255); grp = []; }
  }
  if (grp.length) { const k = grp.length; while (grp.length < 5) grp.push(84); let n = 0; for (const d of grp) n = n * 85 + d; out.push(...[(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].slice(0, k - 1)); }
  return Buffer.from(out);
}
// one PDF value parser for object bodies and content streams: dict → {…}, array, '/Name', number, { ref }, { str: Buffer }, { op }
function pdfLexer(src, start = 0) {
  let i = start;
  const DELIM = '()<>[]{}/% \t\r\n\f\0';
  const ws = () => {
    while (i < src.length) {
      const c = src[i];
      if (c === '%') { while (i < src.length && src[i] !== '\n' && src[i] !== '\r') i++; }
      else if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\0') i++;
      else break;
    }
  };
  const REF = /\s+(\d+)\s+R(?=[\s\/<>\[\]()%]|$)/y;
  const val = (depth = 0) => {
    ws();
    if (i >= src.length) return undefined;
    const c = src[i];
    if (depth > 60) { i++; return null; }
    if (c === '<' && src[i + 1] === '<') {
      i += 2; const o = {};
      for (let guard = 0; guard < 100000; guard++) {
        ws();
        if (i >= src.length) return o;
        if (src[i] === '>' && src[i + 1] === '>') { i += 2; return o; }
        const k = val(depth + 1);
        if (typeof k !== 'string' || k[0] !== '/') continue;
        o[k.slice(1)] = val(depth + 1);
      }
      return o;
    }
    if (c === '[') {
      i++; const a = [];
      for (let guard = 0; guard < 1000000; guard++) { ws(); if (i >= src.length) return a; if (src[i] === ']') { i++; return a; } const v = val(depth + 1); if (v !== undefined) a.push(v); }
      return a;
    }
    if (c === '(') {
      i++; let d = 1; const out = [];
      while (i < src.length && d > 0) {
        const ch = src[i];
        if (ch === '\\') {
          const n = src[i + 1]; i += 2;
          if (n === 'n') out.push(10); else if (n === 'r') out.push(13); else if (n === 't') out.push(9); else if (n === 'b') out.push(8); else if (n === 'f') out.push(12);
          else if (n >= '0' && n <= '7') { let oct = n; while (oct.length < 3 && src[i] >= '0' && src[i] <= '7') oct += src[i++]; out.push(parseInt(oct, 8) & 255); }
          else if (n === '\r') { if (src[i] === '\n') i++; }
          else if (n === '\n' || n === undefined) { /* line continuation */ }
          else out.push(n.charCodeAt(0) & 255);
          continue;
        }
        if (ch === '(') d++;
        else if (ch === ')') { d--; if (!d) { i++; break; } }
        out.push(ch.charCodeAt(0) & 255); i++;
      }
      return { str: Buffer.from(out) };
    }
    if (c === '<') {
      const j = src.indexOf('>', i + 1); const end = j < 0 ? src.length : j;
      let hex = src.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, ''); if (hex.length % 2) hex += '0';
      i = end + 1; return { str: Buffer.from(hex, 'hex') };
    }
    if (c === '/') {
      let j = i + 1; while (j < src.length && !DELIM.includes(src[j])) j++;
      const name = src.slice(i + 1, j).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
      i = j; return '/' + name;
    }
    let j = i; while (j < src.length && !DELIM.includes(src[j])) j++;
    if (j === i) { i++; return null; } // stray delimiter
    const tok = src.slice(i, j); i = j;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
      if (/^\d+$/.test(tok)) { REF.lastIndex = i; const m = REF.exec(src); if (m) { i = REF.lastIndex; return { ref: Number(tok) }; } }
      return Number(tok);
    }
    if (tok === 'true') return true; if (tok === 'false') return false; if (tok === 'null') return null;
    return { op: tok };
  };
  return { val, get pos() { return i; }, set pos(v) { i = v; }, get end() { return i >= src.length; } };
}
function pdfUtf16(hex) {
  let h = hex; while (h.length % 4) h = '0' + h;
  let s = ''; for (let k = 0; k < h.length; k += 4) s += String.fromCharCode(parseInt(h.slice(k, k + 4), 16));
  return s;
}
function pdfCMap(text) {
  const map = new Map(); let bytes = 0;
  for (const m of text.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)) for (const h of m[1].matchAll(/<([0-9a-fA-F]+)>/g)) bytes = Math.max(bytes, Math.ceil(h[1].length / 2));
  for (const m of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]*)>/g)) map.set(parseInt(p[1], 16), pdfUtf16(p[2]));
  for (const m of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const p of m[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]*)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(p[1], 16), hi = parseInt(p[2], 16);
      if (!(hi >= lo) || hi - lo > 65535) continue;
      if (p[3] !== undefined) {
        const h = p[3] || '0000'; const tail = Math.min(h.length, 4); const head = h.slice(0, h.length - tail); const start = parseInt(h.slice(-tail), 16);
        for (let c = lo; c <= hi; c++) map.set(c, pdfUtf16(head + (start + c - lo).toString(16).padStart(tail, '0')));
      } else { const arr = [...p[4].matchAll(/<([0-9a-fA-F]*)>/g)].map(x => x[1]); for (let c = lo; c <= hi && c - lo < arr.length; c++) map.set(c, pdfUtf16(arr[c - lo])); }
    }
  }
  if (!bytes) bytes = [...map.keys()].some(k => k > 255) ? 2 : 1;
  return { map, bytes };
}
const PDF_GLYPHS = { space: ' ', period: '.', comma: ',', hyphen: '-', colon: ':', semicolon: ';', quotesingle: "'", quotedbl: '"', parenleft: '(', parenright: ')', slash: '/',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', question: '?', exclam: '!', at: '@', percent: '%', ampersand: '&',
  endash: '–', emdash: '—', quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”', guillemotleft: '«', guillemotright: '»', numbersign: '#', plus: '+', equal: '=' };
const WIN_EXTRA = { 0x80: '€', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x95: '•', 0x96: '–', 0x97: '—', 0x99: '™' };
function pdfText(buf, { maxChars = 300000, maxPages = 400 } = {}) {
  if (!buf || buf.subarray(0, 1024).toString('latin1').indexOf('%PDF-') < 0) return { text: null, why: 'not_pdf' };
  const s = buf.toString('latin1');
  if (/\/Encrypt\s*(\d+\s+\d+\s+R|<<)/.test(s)) return { text: null, why: 'encrypted' };
  // objects: direct ones (a later definition wins: incremental updates), then members of object streams
  const objs = new Map();
  const head = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = head.exec(s))) {
    const num = Number(m[1]); const startBody = head.lastIndex;
    const nextEnd = s.indexOf('endobj', startBody); const nextStream = s.indexOf('stream', startBody);
    if (nextEnd < 0) break;
    if (nextStream >= 0 && nextStream < nextEnd && /^stream\r?\n/.test(s.slice(nextStream, nextStream + 8)) && s.slice(startBody, nextStream).includes('<<')) {
      const dictSrc = s.slice(startBody, nextStream);
      const dataStart = nextStream + (s[nextStream + 6] === '\r' ? 8 : 7);
      const lm = dictSrc.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/);
      let dataEnd = -1;
      if (lm) { const e = dataStart + Number(lm[1]); if (/^\s*endstream/.test(s.slice(e, e + 24))) dataEnd = e; }
      if (dataEnd < 0) { dataEnd = s.indexOf('endstream', dataStart); if (dataEnd < 0) break; while (dataEnd > dataStart && (s[dataEnd - 1] === '\n' || s[dataEnd - 1] === '\r')) dataEnd--; }
      let dict = {}; try { dict = pdfLexer(dictSrc).val() || {}; } catch { dict = {}; }
      objs.set(num, { v: dict, stream: buf.subarray(dataStart, dataEnd) });
      const after = s.indexOf('endobj', dataEnd);
      head.lastIndex = after < 0 ? s.length : after + 6;
      continue;
    }
    let v = null; try { v = pdfLexer(s.slice(startBody, nextEnd)).val(); } catch { v = null; }
    objs.set(num, { v, stream: null });
    head.lastIndex = nextEnd + 6;
  }
  const decode = o => {
    if (!o?.stream) return null;
    if (o.decoded !== undefined) return o.decoded;
    let data = o.stream;
    const f = o.v?.Filter; const filters = Array.isArray(f) ? f : f ? [f] : [];
    for (const name of filters) {
      if (name === '/FlateDecode' || name === '/Fl') data = data && pdfInflate(data);
      else if (name === '/ASCIIHexDecode' || name === '/AHx') data = Buffer.from(data.toString('latin1').replace(/>[\s\S]*$/, '').replace(/[^0-9a-fA-F]/g, ''), 'hex');
      else if (name === '/ASCII85Decode' || name === '/A85') data = pdfA85(data);
      else data = null;
      if (!data) break;
    }
    o.decoded = data && data.length <= 40 * 1024 * 1024 ? data : null;
    return o.decoded;
  };
  for (const [, o] of [...objs]) {
    if (o.v?.Type !== '/ObjStm') continue;
    const data = decode(o); if (!data) continue;
    const t = data.toString('latin1'); const n = Number(o.v.N) || 0; const first = Number(o.v.First) || 0;
    const nums = t.slice(0, first).trim().split(/\s+/).map(Number);
    for (let k = 0; k < n; k++) {
      const num = nums[2 * k], off = nums[2 * k + 1], next = k + 1 < n ? nums[2 * k + 3] : t.length - first;
      if (!Number.isFinite(num) || objs.has(num)) continue;
      let v = null; try { v = pdfLexer(t.slice(first + off, first + next)).val(); } catch { v = null; }
      objs.set(num, { v, stream: null });
    }
  }
  const R = x => { for (let k = 0; k < 20 && x && typeof x === 'object' && 'ref' in x; k++) x = objs.get(x.ref)?.v; return x; };
  const fontCache = new Map();
  const fontOf = ref => {
    const key = ref && typeof ref === 'object' && 'ref' in ref ? ref.ref : null;
    if (key !== null && fontCache.has(key)) return fontCache.get(key);
    const fd = R(ref) || {};
    const f = { type0: fd.Subtype === '/Type0', cmap: null, bytes: fd.Subtype === '/Type0' ? 2 : 1, diff: null, winAnsi: fd.Encoding === '/WinAnsiEncoding' };
    const tu = fd.ToUnicode && typeof fd.ToUnicode === 'object' && 'ref' in fd.ToUnicode ? objs.get(fd.ToUnicode.ref) : null;
    const tud = tu && decode(tu);
    if (tud) { const cm = pdfCMap(tud.toString('latin1')); if (cm.map.size) { f.cmap = cm.map; f.bytes = f.type0 ? Math.max(2, cm.bytes) : cm.bytes; } }
    const enc = R(fd.Encoding);
    if (enc && typeof enc === 'object' && Array.isArray(enc.Differences)) {
      f.diff = new Map(); let code = 0;
      for (const d of enc.Differences) {
        if (typeof d === 'number') code = d;
        else if (typeof d === 'string') { const g = d.slice(1); const u = /^uni([0-9A-F]{4})$/i.exec(g); f.diff.set(code++, u ? String.fromCharCode(parseInt(u[1], 16)) : PDF_GLYPHS[g] ?? (g.length === 1 ? g : '')); }
      }
      if (enc.BaseEncoding === '/WinAnsiEncoding') f.winAnsi = true;
    }
    if (key !== null) fontCache.set(key, f);
    return f;
  };
  const show = (font, b) => {
    if (!b || !b.length) return '';
    if (!font) return b.toString('latin1');
    let out = '';
    if (font.cmap) {
      const nb = font.bytes || 1;
      for (let k = 0; k + nb <= b.length; k += nb) {
        const code = nb === 2 ? b[k] * 256 + b[k + 1] : nb === 1 ? b[k] : b.readUIntBE(k, Math.min(nb, 4));
        const u = font.cmap.get(code);
        out += u !== undefined ? u : (nb === 1 ? (font.diff?.get(code) ?? (code >= 32 && code < 127 ? String.fromCharCode(code) : '')) : '');
      }
      return out;
    }
    if (font.type0) return '\uFFFD'.repeat(Math.ceil(b.length / 2)); // CIDs without a ToUnicode table: unreadable
    for (const c of b) out += font.diff?.get(c) ?? (font.winAnsi ? WIN_EXTRA[c] : undefined) ?? (c >= 32 && c !== 127 && !(c >= 128 && c < 160) ? String.fromCharCode(c) : '');
    return out;
  };
  let chars = 0, pages = 0;
  const parts = [];
  const push = t => { if (!t || chars >= maxChars) return; parts.push(t); chars += t.length; };
  const nl = () => { const last = parts[parts.length - 1]; if (last && !last.endsWith('\n')) push('\n'); };
  const runContent = (data, res, depth) => {
    if (!data || depth > 4 || chars >= maxChars) return;
    const fonts = R(R(res)?.Font) || {};
    const xobj = R(R(res)?.XObject) || {};
    const src = data.toString('latin1');
    const lx = pdfLexer(src);
    // word gaps: most producers draw spaces as glyphs; a gap made only by moving the pen gets a space when the move is
    // clearly longer than the text just drawn (glyph width ≈ 0.55 of the font size)
    let ops = [], font = null, lastY = null, size = 12, scale = 1, runChars = 0, runEndX = null;
    const lastWs = () => { const last = parts[parts.length - 1]; return !last || /\s$/.test(last); };
    const drawn = t => { push(t); runChars = [...(t || '')].length; if (runEndX !== null) runEndX += runChars * size * 0.55 * scale; };
    for (let guard = 0; guard < 3000000 && !lx.end && chars < maxChars; guard++) {
      const v = lx.val();
      if (v === undefined) break;
      if (!v || typeof v !== 'object' || !('op' in v)) { ops.push(v); if (ops.length > 64) ops.shift(); continue; }
      const op = v.op;
      if (op === 'BI') { const e = src.indexOf('EI', lx.pos); lx.pos = e < 0 ? src.length : e + 2; ops = []; continue; } // inline image
      if (op === 'Tf') { font = fontOf(fonts[String(ops[ops.length - 2] || '').slice(1)]); size = Math.abs(Number(ops[ops.length - 1])) || size; }
      else if (op === 'Tj') drawn(show(font, ops[ops.length - 1]?.str));
      else if (op === "'") { nl(); drawn(show(font, ops[ops.length - 1]?.str)); }
      else if (op === '"') { nl(); drawn(show(font, ops[ops.length - 1]?.str)); }
      else if (op === 'TJ') {
        const arr = ops[ops.length - 1];
        if (Array.isArray(arr)) { let t = ''; for (const e of arr) { if (e && e.str) t += show(font, e.str); else if (typeof e === 'number' && e < -180 && !t.endsWith(' ')) t += ' '; } drawn(t); }
      } else if (op === 'Td' || op === 'TD') {
        const ty = Number(ops[ops.length - 1]) || 0, tx = Number(ops[ops.length - 2]) || 0;
        if (Math.abs(ty) > 0.5) nl();
        else if (tx > runChars * size * 0.55 * 1.3 + size * 0.3 && !lastWs()) push(' ');
        if (runEndX !== null) runEndX = null; // the pen moved relative to the line start: Tm-based tracking no longer applies
        runChars = 0;
      } else if (op === 'T*') { nl(); runChars = 0; }
      else if (op === 'Tm') {
        const [a, b, , , e, f] = ops.slice(-6).map(Number);
        const y = f, x = e;
        scale = Math.hypot(a, b) || 1;
        if (lastY !== null && Math.abs(y - lastY) > 0.5) nl();
        else if (runEndX !== null && x - runEndX > size * scale * 0.3 && !lastWs()) push(' ');
        lastY = y; runEndX = x; runChars = 0;
      }
      else if (op === 'Do') {
        const xo = xobj[String(ops[ops.length - 1] || '').slice(1)];
        const xref = xo && typeof xo === 'object' && 'ref' in xo ? objs.get(xo.ref) : null;
        if (xref?.v?.Subtype === '/Form') runContent(decode(xref), xref.v.Resources || res, depth + 1);
      }
      ops = [];
    }
  };
  // pages in document order: catalog → /Pages → /Kids; fallback — objects of /Type /Page by number
  const pageList = [];
  const rootRef = [...s.matchAll(/\/Root\s+(\d+)\s+\d+\s+R/g)].pop();
  const walk = (node, inherited, depth) => {
    if (!node || depth > 40 || pageList.length >= maxPages) return;
    const n = R(node); if (!n || typeof n !== 'object') return;
    const res = n.Resources !== undefined ? n.Resources : inherited;
    if (n.Type === '/Pages' || Array.isArray(n.Kids)) { for (const k of n.Kids || []) walk(k, res, depth + 1); return; }
    pageList.push({ node: n, res });
  };
  if (rootRef) walk(R({ ref: Number(rootRef[1]) })?.Pages, null, 0);
  if (!pageList.length) for (const [, o] of [...objs].sort((a, b) => a[0] - b[0])) if (o.v?.Type === '/Page' && pageList.length < maxPages) pageList.push({ node: o.v, res: o.v.Resources });
  for (const p of pageList) {
    if (chars >= maxChars) break;
    pages++;
    const c = p.node.Contents;
    const list = Array.isArray(c) ? c : c ? [c] : [];
    const datas = list.map(x => (x && typeof x === 'object' && 'ref' in x ? decode(objs.get(x.ref)) : null)).filter(Boolean);
    runContent(datas.length ? Buffer.concat(datas.flatMap(d => [d, Buffer.from('\n')])) : null, p.res, 0);
    nl(); push('\n');
  }
  const text = parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  const nonSpace = text.replace(/\s/g, '');
  const letters = (nonSpace.match(/[\p{L}\p{N}]/gu) || []).length;
  const bad = (nonSpace.match(/[\uFFFD\u0000-\u001F]/g) || []).length;
  const out = { pages: pageList.length, chars: text.length, truncated: chars >= maxChars };
  if (nonSpace.length < 20 * Math.max(1, Math.min(pageList.length, 3))) return { ...out, text: null, why: 'no_text_layer' };
  // one short word glued to itself many times (falsefalse…) means a broken decode, not a text layer
  const loops = [...nonSpace.matchAll(/(\p{L}{3,12}?)\1{3,}/gu)].reduce((n, m) => n + m[0].length, 0);
  if (letters / nonSpace.length < 0.55 || bad / nonSpace.length > 0.05 || loops / nonSpace.length > 0.2) return { ...out, text: null, why: 'encoding' };
  return { ...out, text };
}

async function pdfProbe(u, out) {
  const r = await U.fetchBytes(u, { maxBytes: 30 * 1024 * 1024, timeoutMs: 60000, accept: 'application/pdf,*/*' });
  out.pdf = true;
  out.status = r.status || null;
  out.final_url = r.url || u;
  out.chain = (r.chain || []).map(c => ({ url: c.url, status: c.status, ...(c.status >= 300 && c.status < 400 ? { redirect: 'http' } : {}) }));
  if (!r.ok) { out.error = r.error || `HTTP ${r.status}`; out.doc_text = null; out.doc_text_why = r.skipped ? `refused_${r.skipped}` : 'load_failed'; return 1; }
  if (r.truncated) { out.doc_text = null; out.doc_text_why = 'too_big'; out.doc_bytes = r.total ?? null; return 0; }
  out.doc_bytes = r.bytes;
  let t;
  try { t = pdfText(r.buf); } catch (e) { t = { text: null, why: 'parse_error', error: String(e?.message || e).slice(0, 160) }; }
  out.doc_pages = t.pages ?? null;
  if (t.text) {
    const f = `${base}.pdf.txt`;
    U.writeText(U.insideRun(run, 'probe', f), t.text);
    out.doc_text = t.text.length > 100000 ? t.text.slice(0, 100000) : t.text;
    out.doc_chars = t.text.length;
    out.doc_text_file = relOut(f);
    if (t.truncated || t.text.length > 100000) out.warnings.push(T('Текст PDF длинный: в JSON — первые 100 000 знаков, весь — в doc_text_file.', 'Long PDF text: the JSON keeps 100,000 chars, all of it is in doc_text_file.'));
  } else {
    out.doc_text = null;
    out.doc_text_why = t.why;
    out.warnings.push(T(`Текст PDF не прочитан (${t.why}): проверить документ скриптом нельзя — not_checked, не «документ пустой».`, `PDF text not read (${t.why}): mark not_checked, not "empty document".`));
  }
  return 0;
}

// ---------- a static file (og:image, picture, icon): GET as a file — code, type, size, dimensions, the image as the frame ----------
function rasterSize(b) {
  if (!b || b.length < 24) return null;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  if (b.toString('latin1', 0, 4) === 'GIF8') return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16);
    if (kind === 'VP8X') return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && b.length > 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && b.length > 25) { const v = b.readUInt32LE(21); return { w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) }; }
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1], len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
      i += 2 + len;
    }
    return null;
  }
  const t = b.toString('utf8', 0, Math.min(b.length, 4096));
  if (/<svg[\s>]/i.test(t)) {
    const w = (t.match(/<svg[^>]*\swidth=["']?([\d.]+)/i) || [])[1], h = (t.match(/<svg[^>]*\sheight=["']?([\d.]+)/i) || [])[1];
    const vb = (t.match(/viewBox=["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i) || []);
    return { w: Number(w || vb[1]) || null, h: Number(h || vb[2]) || null, svg: true };
  }
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return { w: b[6] || 256, h: b[7] || 256, icons: b.readUInt16LE(4) };
  return null;
}
async function staticProbe(u, out) {
  const r = await U.fetchBytes(u, { maxBytes: 15 * 1024 * 1024, timeoutMs: 45000, accept: 'image/avif,image/webp,image/svg+xml,image/*,*/*;q=0.8' });
  out.static = true;
  out.status = r.status || null;
  out.final_url = r.url || u;
  out.chain = (r.chain || []).map(c => ({ url: c.url, status: c.status, ...(c.status >= 300 && c.status < 400 ? { redirect: 'http' } : {}) }));
  if (!r.ok && !r.status) { out.error = r.error || 'load failed'; return r.skipped ? 3 : 1; }
  const h = Object.fromEntries(Object.entries(r.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  out.file_info = { content_type: h['content-type'] || null, bytes: r.total ?? r.bytes ?? null, truncated: !!r.truncated, cache_control: h['cache-control'] || null,
    dims: r.truncated ? null : rasterSize(r.buf) };
  if (r.status >= 400) { out.error = `HTTP ${r.status}`; return 1; }
  const ext = (String(out.file_info.content_type).match(/image\/(jpeg|png|webp|gif|avif|svg\+xml|x-icon|vnd\.microsoft\.icon)/) || [])[1];
  const fext = { jpeg: '.jpg', png: '.png', webp: '.webp', gif: '.gif', avif: '.avif', 'svg+xml': '.svg', 'x-icon': '.ico', 'vnd.microsoft.icon': '.ico' }[ext];
  if (fext && !r.truncated && !args['no-shot']) {
    const f = `${base}${fext}`;
    writeFileSync(U.insideRun(run, 'probe', f), r.buf);
    out.shots = [{ file: relOut(f), abs: absOut(f), kind: 'image' }];
  }
  if (!fext) warnings.push(T(`Ответ не картинка (${out.file_info.content_type || 'тип не указан'}).`, `The response is not an image (${out.file_info.content_type || 'no type'}).`));
  return 0;
}

// ---------- browser session helpers ----------
// windows opened by the site have an opener or a real address; the browser's own start tab (about:blank) is not one
const sitePopups = list => list.filter(p => p.opener || (p.url && p.url !== 'about:blank')).map(p => p.url || 'about:blank');
const counts = b => Object.fromEntries(Object.entries(b || {}).map(([k, v]) => [k, Array.isArray(v) ? v.length : 0]));
const KEYCODES = { ' ': 32, ',': 188, '.': 190, '-': 189 };
const holdGuard = page => { page.__rvHold = true; page.guard(24 * 3600 * 1000); };
const releaseGuard = page => { if (!page.__rvHold) page.guardUntil = Date.now() + 3000; };

// Real input at a document point. Our own checks look at the element under the client point (the one that will get the
// event): iframe, submit, a control of a contact form; lib/cdp's guard runs as well (submit, consent «Принять», contact form).
async function realInput(page, kind, docX, docY, useTarget = false) {
  const c = await iso(page, inPageCenter, docX, docY, useTarget).catch(e => ({ error: e.message }));
  if (c.error) return { refused: 'error', error: c.error };
  await U.sleep(120);
  const out = { point_view: [c.cx, c.cy], point_input: [c.ix, c.iy], vv: c.vv };
  if (!c.visible) return { ...out, refused: 'offscreen' };
  const info = await page.hitInfo(c.cx, c.cy).catch(() => null);
  out.info = info;
  out.on_top = await iso(page, inPageOnTop, c.cx, c.cy).catch(() => null);
  if (!info || info.none) return { ...out, refused: 'nothing' };
  if (info.isIframe) return { ...out, refused: 'iframe' };
  if (info.isSubmit) return { ...out, refused: 'submit' };
  if (info.isConsentAccept) return { ...out, refused: 'consent-accept' };
  if (kind !== 'hover') {
    const cc = await iso(page, inPageControlContact, c.cx, c.cy).catch(() => null);
    if (cc?.refuse) return { ...out, refused: 'contact-form', contact_field: cc.field };
  }
  if (kind === 'hover') { page.guard(); await page.hover(c.ix, c.iy); return { ...out, ok: true }; }
  const r = kind === 'tap' ? await page.tap(c.ix, c.iy) : await page.click(c.ix, c.iy);
  return r.ok ? { ...out, ok: true } : { ...out, refused: r.refused, cdp_guard: r.info || null };
}
async function typeText(page, text) {
  for (const ch of String(text)) {
    const kc = /\d/.test(ch) ? 48 + Number(ch) : KEYCODES[ch];
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, ...(kc ? { windowsVirtualKeyCode: kc } : {}) });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, ...(kc ? { windowsVirtualKeyCode: kc } : {}) });
  }
}
// window.open() calls refused by the lib guard (page.blocked.popup), resolved against the page address
const openedUrls = (page, from = 0, base) => (page.blocked.popup || []).slice(from).map(x => {
  try { return new URL(String(x.url ?? ''), base || undefined).href.slice(0, 300); } catch { return String(x.url ?? '').slice(0, 300); }
});
// LCP/FCP also from the end of the document response: the server and the network drop out of the comparison
function withResponse(v, timing) {
  if (!v) return v;
  const re = timing?.response_end;
  const o = { ...v, cls: typeof v.cls === 'number' ? Math.round(v.cls * 10000) / 10000 : v.cls };
  if (re > 0) { o.response_end = re; if (v.lcp != null) o.lcp_from_response = Math.max(0, v.lcp - re); if (v.fcp != null) o.fcp_from_response = Math.max(0, v.fcp - re); }
  return o;
}
// --grep-scripts: texts of scripts the page already has (Debugger.getScriptSource), no new requests
async function grepScripts(page, list, docUrl) {
  const seen = new Set(), out = [];
  let scanned = 0, bytes = 0;
  for (const s of list) {
    const key = `${s.url}|${s.hash || s.id}`;
    if (seen.has(key)) continue; seen.add(key);
    if (bytes > 40 * 1024 * 1024 || out.length >= 30) break;
    let src = '';
    try { src = (await page.send('Debugger.getScriptSource', { scriptId: s.id }, 15000))?.scriptSource || ''; } catch { continue; }
    scanned++; bytes += src.length;
    const re = new RegExp(grepRe.source, grepRe.flags.includes('g') ? grepRe.flags : grepRe.flags + 'g');
    const hits = [];
    for (const m of src.matchAll(re)) {
      if (hits.length >= 10) break;
      const before = src.slice(0, m.index);
      const line = (before.match(/\n/g) || []).length + 1 + (s.line || 0);
      const col = m.index - before.lastIndexOf('\n') - 1;
      const from = Math.max(0, m.index - 80);
      hits.push({ line, col, text: src.slice(from, Math.min(src.length, m.index + Math.max(m[0].length, 1) + 80)).replace(/\s+/g, ' ').slice(0, 200) });
      if (!m[0].length) re.lastIndex++;
    }
    if (hits.length) out.push({ url: s.url, inline: !!docUrl && s.url.split('#')[0] === String(docUrl).split('#')[0], hits });
  }
  return { pattern: `/${grepRe.source}/${grepRe.flags}`, scanned, matched: out.length, items: out };
}
// --vitals with a fix: medians, A/A noise (spread of the base runs), verdict per metric
function speedVerdict(baseRuns, fixRuns) {
  const METRICS = [['lcp_from_response', 30], ['fcp_from_response', 30], ['lcp', 30], ['fcp', 30], ['cls', 0.01]];
  const out = {};
  for (const [m, floor] of METRICS) {
    const b = baseRuns.map(v => v?.[m]).filter(x => typeof x === 'number');
    const a = fixRuns.map(v => v?.[m]).filter(x => typeof x === 'number');
    if (!b.length || !a.length) { out[m] = { verdict: 'not_measured' }; continue; }
    const mb = U.median(b), ma = U.median(a);
    const noise = b.length > 1 ? Math.max(...b) - Math.min(...b) : null;
    const need = Math.max(Math.abs(mb) * 0.15, (noise ?? 0) * 2, floor);
    const r = x => (m === 'cls' ? Math.round(x * 10000) / 10000 : Math.round(x));
    out[m] = { before: b.map(r), after: a.map(r), median_before: r(mb), median_after: r(ma), aa_noise: noise === null ? null : r(noise), threshold: r(need),
      verdict: mb - ma > need ? 'improved' : ma - mb > need ? 'worse' : 'noise' };
    if (b.length < 2) out[m].note = T('один прогон «до»: шум не оценён, нужен --repeat ≥ 2', 'one base run: noise unknown, use --repeat ≥ 2');
  }
  const main = ['lcp_from_response', 'fcp_from_response'].map(k => out[k]?.verdict);
  out.fix_verified = main.includes('improved') && !main.includes('worse') && out.cls?.verdict !== 'worse';
  out.verdict = out.fix_verified ? 'improved' : main.includes('worse') ? 'worse' : 'noise';
  return out;
}
function navChain(navs) {
  const chain = [];
  navs.filter(n => n.final).forEach((n, i, list) => {
    for (const h of n.hops) chain.push({ url: h.url, status: h.status, redirect: 'http' });
    const e = { url: n.final.url, status: n.final.status };
    if (i < list.length - 1) e.redirect = list[i + 1].initiator === 'script' ? 'js' : 'other';
    chain.push(e);
  });
  return chain;
}

// withFix — the fix substituted; aa — the same substitution path without a change (A/A base for speed checks);
// light — one more repeat of --vitals: load and vitals only (no steps, code, shots); grep — scan loaded scripts
async function session(browser, { withFix, aa = false, light = false, grep = false, label, shotName }) {
  const rec = { label, warnings: [] };
  const page = await browser.newPage({ blockNavigation: true, allowLoadPosts, blockUrls });
  const scripts = [];
  if (grep) {
    page.on('Debugger.scriptParsed', p => { if (p.url && !/^(chrome|devtools|extensions)::?/.test(p.url) && scripts.length < 600) scripts.push({ id: p.scriptId, url: p.url, line: p.startLine || 0, hash: p.hash }); });
    await page.send('Debugger.enable', { maxScriptsCacheSize: 64 * 1024 * 1024 }).catch(() => {});
    await page.send('Debugger.setSkipAllPauses', { skip: true }).catch(() => {}); // "debugger;" traps must not freeze the page
  }
  const navs = [];
  page.on('Network.requestWillBeSent', p => {
    if (p.type !== 'Document' || (page.mainFrameId && p.frameId !== page.mainFrameId)) return;
    if (p.redirectResponse) { const n = navs.find(x => x.id === p.requestId); if (n) n.hops.push({ url: p.redirectResponse.url, status: p.redirectResponse.status }); }
    else if (!navs.some(x => x.id === p.requestId)) navs.push({ id: p.requestId, initiator: p.initiator?.type || null, hops: [], final: null });
  });
  page.on('Network.responseReceived', p => {
    if (p.type !== 'Document') return;
    const n = navs.find(x => x.id === p.requestId); if (n && !n.final) n.final = { url: p.response.url, status: p.response.status };
  });
  let sub = null;
  try {
    await page.setViewport({ width, height, mobile, deviceScaleFactor: dpr });
    if (args.dark || args.reduce || args['forced-colors']) await page.emulateMedia({ colorScheme: args.dark ? 'dark' : undefined, reducedMotion: args.reduce ? 'reduce' : undefined, forcedColors: args['forced-colors'] ? 'active' : undefined });
    if (vision && vision !== 'none') await page.emulateVision(vision);
    if (args['no-js']) await page.send('Emulation.setScriptExecutionDisabled', { value: true });
    await page.addInitScript(INIT);
    if (withFix || aa) sub = await enableSubstitution(page, browser, { css: !!cssFile, inject: !!injFile }, !withFix);

    const tLoad = Date.now();
    // with --allow-load-posts goto() waits for network quiet: POST is allowed only while it runs
    const load = await page.goto(url, { timeout: 45000, waitUntil: allowLoadPosts ? 'networkidle' : 'domcontentloaded' });
    page.opts.allowLoadPosts = false;
    rec.status = load.status ?? null;
    rec.chain = navChain(navs);
    if (!load.ok) {
      rec.error = load.refused ? `refused_${load.refused}` : (load.error || 'load failed');
      rec.refused = load.refused || null;
      return rec;
    }
    // bounded wait for load + network quiet (as snapshot)
    page.setPhase('load');
    let complete = false;
    const until = Date.now() + 15000;
    while (Date.now() < until) {
      complete = (await page.evaluate('document.readyState').catch(() => '')) === 'complete';
      if (complete && page.inflight.size <= 1 && Date.now() - page.lastNetActivity > 800) break;
      await U.sleep(200);
    }
    page.setPhase('interact');
    const consoleAtLoad = page.console.length;
    rec.load_ms = Date.now() - tLoad; rec.timed_out = !complete;
    rec.timing = await page.evaluate(() => { const n = performance.getEntriesByType('navigation')[0]; return n ? { response_end: Math.round(n.responseEnd), dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd) } : null; }).catch(() => null);
    if (light) {
      await U.sleep(600);
      rec.vitals = withResponse(await page.evaluate(() => window.__rvVitals || null).catch(() => null), rec.timing);
      return rec;
    }
    rec.final_url = await page.evaluate('location.href').catch(() => load.finalUrl || url);
    rec.chain = navChain(navs);
    await page.send('Page.bringToFront').catch(() => {});
    await U.sleep(400);
    if (sub) {
      rec.substitution = { substituted: sub.substituted, where: sub.where, error: sub.error, inject: sub.inject, css_url: sub.css_url ? sub.css_url.replace(/^.*\//, '') : null };
      if (injFile && !sub.inject?.ok) rec.warnings.push(T(`подмена HTML не сработала: ${sub.inject?.error || sub.error || 'ответ сервера не HTML'}`, `HTML substitution failed: ${sub.inject?.error || sub.error || 'not an HTML response'}`));
    }

    const doc = page.responses.find(r => r.type === 'Document');
    rec.doc_mime = doc?.mime || null;
    const docHeaders = Object.fromEntries(Object.entries(doc?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const quick = await iso(page, () => ({ html: document.documentElement.outerHTML.slice(0, 30000), textLen: (document.body?.innerText || '').trim().length })).catch(() => ({ html: '', textLen: 0 }));
    rec.antibot = U.detectAntibot(rec.status || 0, docHeaders, '') ||
      (quick.textLen < 400 && /cf-chl|challenge-platform|just a moment|checking your browser|ddos-guard|smartcaptcha|captcha-delivery|проверка браузера|вы не робот|are you a robot/i.test(quick.html) ? 'challenge' : null);

    if (withFix && cssFile) rec.css = await ensureCss(page, sub);
    if (args['hide-overlays']) rec.hidden_overlays = await iso(page, inPageHideOverlays).catch(() => []);
    if (str(args.scroll)) {
      const s = await iso(page, inPageScroll, str(args.scroll)).catch(e => ({ error: e.message }));
      if (s?.error) rec.warnings.push(`--scroll: ${s.error}`);
      await U.sleep(300);
    }
    if (!hasFix && args.before === true && steps.length) rec.before = await measure(page, `${shotName}-before`); // state before the steps, same load

    // steps in the given order
    rec.actions = []; rec.fill = []; rec.keys = [];
    if (reads.length && fillCount) rec.read_before = Object.fromEntries(await Promise.all(reads.map(async s => [s, await iso(page, inPageRead, s).catch(e => ({ error: e.message }))])));
    let n = 0, fi = 0;
    for (const st of steps) {
      n++;
      try {
        if (st.kind === 'fill') { rec.fill.push({ step: n, ...(await doFill(page, st, fi++)) }); continue; }
        if (st.kind === 'key') { rec.keys.push({ step: n, ...(await doKey(page, st)) }); continue; }
        rec.actions.push({ step: n, ...(await doPointer(page, browser, st)) });
      } catch (e) {
        // the page stopped answering (input never acknowledged): record it and stop the steps, the rest still gets measured
        const err = { step: n, kind: st.kind, target: st.target || st.selector || st.label, result: `error:${String(e?.message || e).slice(0, 160)}` };
        (st.kind === 'fill' ? rec.fill : st.kind === 'key' ? rec.keys : rec.actions).push(err);
        rec.warnings.push(T(`Шаг ${n} (${st.kind}) не выполнен: страница не ответила — дальнейшие шаги пропущены.`, `Step ${n} (${st.kind}) failed: the page did not answer — the remaining steps were skipped.`));
        break;
      }
    }
    if (reads.length) rec.read = Object.fromEntries(await Promise.all(reads.map(async s => [s, await iso(page, inPageRead, s).catch(e => ({ error: e.message }))])));

    const m = await measure(page, shotName);
    Object.assign(rec, m);
    rec.vitals = withResponse(await page.evaluate(() => window.__rvVitals || null).catch(() => null), rec.timing);
    if (grep) rec.scripts = await grepScripts(page, scripts, rec.final_url);
    rec.csp_violations = await page.evaluate('Array.isArray(window.__rvCsp) ? window.__rvCsp : []').catch(() => []);
    rec.opened = openedUrls(page, 0, rec.final_url || await page.evaluate('location.href').catch(() => '')).map(u => `${u} (window.open)`);
    const docNavs = list => list.filter(x => x.type === 'Document' || !x.type).map(x => x.url);
    rec.navigations = [...page.blocked.navigation.map(x => x.url), ...docNavs(page.blocked.risky).map(u => `${u} (${T('опасный адрес', 'risky URL')})`),
      ...(page.blocked.interact || []).filter(x => x.type === 'Document').map(x => `${x.url} (${T('документ или фрейм с параметрами после действия — оборван', 'a document or frame with parameters after an action — cut')})`)];
    rec.blocked = counts(page.blocked);
    rec.blocked_samples = Object.fromEntries(Object.entries(page.blocked).filter(([, v]) => v.length).map(([k, v]) => [k, v.slice(0, 5).map(x => `${x.method || x.type || ''} ${x.url}`.trim().slice(0, 200))]));
    rec.console = page.console.map((c, i) => ({ type: c.type === 'assert' ? 'error' : c.type, phase: i < consoleAtLoad ? 'load' : 'interact', text: c.text.slice(0, 240) }))
      .filter(c => !/ERR_BLOCKED_BY_CLIENT/.test(c.text)).slice(0, 25);
    rec.console_errors = rec.console.filter(c => c.type !== 'warning').slice(0, 15).map(c => c.text.slice(0, 200));
    rec.exceptions = page.exceptions.slice(0, 10).map(e => e.slice(0, 300));
    if (page.inducedExceptions?.length) rec.exceptions_induced = { count: page.inducedExceptions.length, samples: page.inducedExceptions.slice(0, 3).map(e => e.slice(0, 160)) };
    rec.failed = page.failed.filter(f => !/BLOCKED_BY_CLIENT|ERR_ABORTED/i.test(f.error || '')).slice(0, 10).map(f => `${f.error} ${f.url}`.slice(0, 200));
    return rec;
  } finally {
    try { await sub?.closeTool?.(); } catch { /* ignore */ }
    await page.close();
  }

  // measure + result + shots of the current state
  async function measure(pg, name) {
    const out = {};
    out.metrics = await iso(pg, inPageMetrics).catch(e => ({ error: e.message }));
    if (jsFile || expr) {
      const code = jsFile ? `(async (ARGS) => {\n${jsFile.text}\n})(${JSON.stringify(jsArgs)})` : expr;
      pg.guard(120000); // background requests of the page are cut while our code runs
      try { out.result = await pg.evaluate(code); if (out.result === undefined) out.result = null; }
      catch (e) { out.result = null; out.result_error = String(e?.message || e).replace(/^evaluate: /, '').slice(0, 500); }
      finally { releaseGuard(pg); }
    }
    if (!args['no-shot']) out.shots = await shoot(pg, name, out.metrics);
    return out;
  }
}

async function doPointer(page, browser, a) {
  const navBefore = page.blocked.navigation.length, riskyBefore = page.blocked.risky.length, popBefore = browser.popups.length, wrBefore = page.blocked.write.length;
  const intBefore = (page.blocked.interact || []).length;
  const openBefore = (page.blocked.popup || []).length;
  const urlBefore = await page.evaluate('location.href').catch(() => null);
  const item = { kind: a.kind, target: a.target };
  let dx, dy;
  const xy = a.target.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;x ]\s*(-?\d+(?:\.\d+)?)\s*$/i);
  if (xy) {
    dx = Number(xy[1]); dy = Number(xy[2]);
    await iso(page, () => { window.__rvTarget = null; return true; }).catch(() => {});
  } else {
    const loc = await iso(page, inPageLocate, a.target).catch(e => ({ error: e.message }));
    if (loc.error) { item.result = `error:${loc.error}`; return item; }
    dx = loc.x; dy = loc.y; item.element = { tag: loc.tag, text: loc.text, size: [loc.w, loc.h], matches: loc.count };
  }
  item.point_doc = [dx, dy];
  if (a.kind === 'tap' && !mobile) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }).catch(() => {});
  const r = await realInput(page, a.kind, dx, dy, !xy);
  item.point_view = r.point_view; item.point_input = r.point_input;
  if (r.vv && (r.vv[1] || r.vv[2] || r.vv[0] !== 1)) item.visual_viewport = r.vv;
  if (!xy) item.target_on_top = r.on_top;
  item.hit = r.info || null;
  item.result = r.ok ? 'ok' : `refused:${r.refused}`;
  if (r.contact_field) item.contact_field = r.contact_field;
  await U.sleep(waitMs);
  item.navigations = [...page.blocked.navigation.slice(navBefore).map(x => x.url),
    ...page.blocked.risky.slice(riskyBefore).filter(x => x.type === 'Document').map(x => `${x.url} (${T('опасный адрес', 'risky URL')})`),
    ...(page.blocked.interact || []).slice(intBefore).filter(x => x.type === 'Document').map(x => `${x.url} (${T('документ или фрейм с параметрами после действия — оборван', 'a document or frame with parameters after an action — cut')})`)];
  // a window opened by target=_blank is attached as about:blank before it loads: the link address says where it led
  item.popups = [...sitePopups(browser.popups.slice(popBefore)).map(u => (u === 'about:blank' && r.info?.href ? r.info.href : u)),
    ...openedUrls(page, openBefore, urlBefore).map(u => `${u} (window.open)`)];
  item.writes_blocked = page.blocked.write.length - wrBefore;
  item.background_cut = (page.blocked.interact || []).length - intBefore;
  const urlAfter = await page.evaluate('location.href').catch(() => null);
  if (urlAfter && urlAfter !== urlBefore) item.url_after = urlAfter;
  return item;
}

async function doFill(page, f, i) {
  const it = { selector: f.selector, value: f.value };
  const prep = await iso(page, inPageFillPrep, f.selector, i).catch(e => ({ error: e.message }));
  if (prep.error) { it.error = prep.error; return it; }
  it.kind = prep.kind; it.value_before = prep.value;
  if (prep.contact) { it.refused = prep.contact_why === 'field' ? 'contact_field' : 'contact_form'; if (prep.contact_field) it.contact_field = prep.contact_field; return it; }
  if (prep.kind === 'other') { it.refused = 'unsupported_field'; return it; }
  await U.sleep(120);
  if (prep.kind === 'select' || prep.kind === 'range') {
    holdGuard(page);
    const r = await iso(page, inPageSetValue, i, f.value, prep.kind).catch(e => ({ error: e.message }));
    if (r.error) { it.error = r.error; if (r.options) it.options = r.options; }
    it.method = 'script (input/change)';
  } else if (prep.kind === 'checkbox' || prep.kind === 'radio') {
    const want = !/^(0|false|off|no|нет|unchecked)$/i.test(f.value.trim());
    if (prep.checked !== want) {
      const r = await realInput(page, 'click', prep.x, prep.y, true);
      holdGuard(page);
      it.method = 'click';
      if (!r.ok) it.refused = r.refused;
    } else it.method = 'already';
  } else {
    const r = await realInput(page, 'click', prep.x, prep.y, true);
    it.method = 'click + keys';
    it.point_view = r.point_view;
    if (r.info && !r.info.none) it.hit = `${r.info.tag}${r.info.text ? ' «' + r.info.text.slice(0, 30) + '»' : ''}`;
    if (!r.ok) { it.refused = r.refused; return it; }
    holdGuard(page); // typed data must not leave: background requests with parameters stay cut until the page closes
    let st = await iso(page, inPageFieldState, i).catch(() => null);
    if (!st?.focused) { it.focused_by_script = true; await iso(page, inPageFocus, i).catch(() => false); st = await iso(page, inPageFieldState, i).catch(() => null); }
    await page.key('End', 'End', 35);
    for (let k = 0; k < (st?.len || 0) + 2; k++) await page.key('Backspace', 'Backspace', 8);
    await typeText(page, f.value);
    await iso(page, inPageBlur, i).catch(() => {});
  }
  await U.sleep(Math.max(200, Math.min(waitMs, 1500)));
  const after = await iso(page, inPageFieldState, i).catch(() => null);
  if (after) { it.value_after = after.value; it.valid = after.valid; if (after.message) it.validation_message = after.message; if (prep.kind === 'checkbox' || prep.kind === 'radio') it.checked = after.checked; }
  return it;
}

async function doKey(page, k) {
  const it = { key: k.label };
  const pre = await iso(page, inPageFocusInfo, k.press, k.code).catch(() => null);
  if (k.press && pre?.refuse) { it.result = `refused:${pre.refuse}`; it.focus = pre; return it; }
  await iso(page, inPageStyleSnap).catch(() => 0);
  page.guard(); // a key press on a focused control is a press too
  const mods = k.shift ? 8 : 0;
  const text = k.code === 'Enter' ? '\r' : k.code === 'Space' ? ' ' : undefined;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: mods, ...(text ? { text, unmodifiedText: text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: mods });
  await U.sleep(Math.min(waitMs, 400));
  it.result = 'ok';
  it.focus = await iso(page, inPageFocusInfo, false, k.code).catch(() => null);
  return it;
}

async function shoot(page, name, metrics) {
  const files = [];
  if (!args.full) {
    const f = `${name}${ext}`;
    await page.screenshot({ path: U.insideRun(run, 'probe', f), format: fmt, quality: fmt === 'png' ? undefined : 75 });
    files.push({ file: relOut(f), abs: absOut(f), kind: 'viewport', scroll_y: metrics?.scroll_y ?? null, scale: dpr });
    return files;
  }
  // whole page: one image up to 4000 px high, otherwise chunks (as snapshot: 1440 → 1000 px wide, 390 → 600 px)
  const H = Math.max(height, Math.min(Number(metrics?.doc_height) || height, 25000));
  const targetW = mobile ? 600 : Math.min(width, 1000);
  const imgPerCss = targetW / width, clipScale = imgPerCss / dpr;
  const chunkCss = mobile ? 1800 : 1600;
  const index = [];
  if (H * imgPerCss <= 4000) {
    const f = `${name}${ext}`;
    await page.screenshot({ path: U.insideRun(run, 'probe', f), format: fmt, quality: fmt === 'png' ? undefined : 75, clip: { x: 0, y: 0, width, height: H, scale: clipScale } });
    files.push({ file: relOut(f), abs: absOut(f), kind: 'full', y0: 0, y1: H, scale: Math.round(imgPerCss * 10000) / 10000 });
    return files;
  }
  let k = 0;
  const plan = [];
  for (let y = 0; y < H; y += chunkCss) plan.push([y, Math.min(chunkCss, H - y)]);
  // a short tail (< 30 % of a chunk) joins the previous chunk while it stays ≤ 4000 image px (as snapshot)
  if (plan.length > 1 && plan[plan.length - 1][1] < chunkCss * 0.3 && (plan[plan.length - 2][1] + plan[plan.length - 1][1]) * imgPerCss <= 4000) { plan[plan.length - 2][1] += plan.pop()[1]; }
  for (const [y, h] of plan) {
    const f = `${name}.part-${String(++k).padStart(2, '0')}${ext}`;
    await page.screenshot({ path: U.insideRun(run, 'probe', f), format: fmt, quality: fmt === 'png' ? undefined : 75, clip: { x: 0, y, width, height: h, scale: clipScale } });
    const e = { file: relOut(f), abs: absOut(f), kind: 'part', y0: y, y1: y + h, scale: Math.round(imgPerCss * 10000) / 10000 };
    files.push(e); index.push({ file: f, width, y0: y, y1: y + h, scale: e.scale, kind: 'part' });
  }
  U.writeJSON(U.insideRun(run, 'probe', `${name}.index.json`), index);
  return files;
}

// ---------- fix verdict: applied for real, or why not ----------
function violationsNew(after, before, ownUrl) {
  const key = v => `${v.directive}|${/^(inline|eval|wasm-eval|data|blob)$/.test(v.blocked) ? v.blocked : v.blocked.replace(/[?#].*$/, '')}`;
  const left = new Map();
  for (const v of before || []) left.set(key(v), (left.get(key(v)) || 0) + 1);
  const out = [];
  for (const v of after || []) {
    if (ownUrl && v.blocked && v.blocked.startsWith(ownUrl)) continue;
    const k = key(v); const n = left.get(k) || 0;
    if (n > 0) left.set(k, n - 1); else out.push(v);
  }
  return out;
}
function fixVerdict(fix, r, b, twoLoads) {
  const reasons = [];
  if (cssFile) {
    const c = r.css || {};
    fix.css_method = c.method || null;
    if (!c.applied) reasons.push({ by: c.blocked_by || 'not_applied', text: c.blocked_by === 'csp' ? T('CSP сайта не пустила стиль ни файлом, ни встроенным, ни через DevTools', 'the site CSP blocked the stylesheet in every way')
      : T(`стиль не подключился (${c.blocked_by || c.error || 'причина неизвестна'})`, `the stylesheet was not applied (${c.blocked_by || c.error || 'unknown'})`) });
    else if (!c.at_load) {
      fix.vitals_comparable = false;
      warnings.push(c.late_why === 'csp' || c.inline_blocked === 'csp'
        ? T('CSP сайта не пускает наш стиль как файл/встроенный: он добавлен через DevTools после загрузки. Вид «после» сравним, LCP/CLS «после» — нет. В настоящей правке кладите CSS в файл стилей сайта.',
          'The site CSP blocks our stylesheet: it was added through DevTools after load. Visuals are comparable, LCP/CLS "after" are not. Put the real fix into the site stylesheet.')
        : T(`Стиль добавлен после загрузки (${c.late_why}): вид «после» сравним, LCP/CLS «после» — нет.`, `The stylesheet was added after load (${c.late_why}): visuals comparable, LCP/CLS "after" are not.`));
    } else fix.vitals_comparable = true;
  }
  if (injFile) {
    const s = r.substitution || {};
    if (!s.inject?.ok) reasons.push({ by: 'substitution', text: s.inject?.error || s.error || T('ответ сервера не HTML', 'not an HTML response') });
    else {
      const fresh = violationsNew(r.csp_violations, twoLoads ? b?.csp_violations : [], r.substitution?.css_url ? null : null)
        .filter(v => !(s.css_url && v.blocked.includes(s.css_url)));
      if (fresh.length) {
        fix.csp_violations = fresh.slice(0, 10);
        reasons.push({ by: 'csp', text: T(`CSP сайта заблокировала часть вставки (${[...new Set(fresh.map(v => `${v.directive}: ${v.blocked || '—'}`))].slice(0, 3).join('; ')}) — в таком виде правка на сайте не заработает: вынесите стиль/скрипт в файл или добавьте nonce/hash`,
          `the site CSP blocked part of the insertion (${[...new Set(fresh.map(v => `${v.directive}: ${v.blocked || '—'}`))].slice(0, 3).join('; ')})`) });
        if (!twoLoads) warnings.push(T('Без загрузки «до» нарушения CSP самого сайта не отличить от вставки — повторите без --no-before.', 'Without the "before" load own CSP violations of the site cannot be told apart — rerun without --no-before.'));
      }
    }
  }
  fix.applied = reasons.length === 0;
  if (!fix.applied) { fix.blocked_by = reasons[0].by; fix.reason = reasons.map(x => x.text).join('; '); }
  return fix;
}

// ---------- output ----------
let finalOut = null;
function emit(out, code) {
  finalOut = out;
  const file = `${base}.json`;
  out.copy = `stdout/probe-${base}.md`;
  try { U.writeJSON(U.insideRun(run, 'probe', file), out); out.file = relOut(file); out.file_abs = absOut(file); } catch { /* still print */ }
  // stdout: one top-level key per line (valid JSON, ≤ 40 lines); big values are cut — the full answer is in the file
  const KEYS = ['tool', 'copy', 'url', 'pid', 'final_url', 'status', 'chain', 'width', 'mobile', 'error', 'antibot', 'partial', 'allowed_by', 'fix', 'before', 'metrics',
    'actions', 'keys', 'fill', 'read_before', 'read', 'result', 'result_error', 'scripts', 'static', 'file_info', 'pdf', 'doc_text', 'doc_text_why', 'doc_pages', 'doc_text_file', 'shots', 'navigations', 'popups',
    'hidden_overlays', 'blocked', 'console', 'exceptions', 'exceptions_induced', 'vitals', 'vitals_runs', 'warnings', 'file'];
  const cut = (v, n) => { const s = JSON.stringify(v); return s && s.length > n ? JSON.stringify({ truncated: true, preview: s.slice(0, n) }) : s; };
  let entries = KEYS.filter(k => (out[k] !== undefined && out[k] !== null && !(Array.isArray(out[k]) && !out[k].length)) || (k === 'doc_text' && out.pdf));
  // ≤ 40 lines with the braces: the least needed keys stay only in the file
  const omitted = [];
  for (const k of ['mobile', 'width', 'pid', 'hidden_overlays', 'exceptions_induced', 'read_before', 'doc_pages', 'allowed_by', 'popups', 'chain', 'vitals_runs', 'console', 'keys', 'metrics']) {
    if (entries.length <= 37) break;
    if (entries.includes(k)) { entries = entries.filter(x => x !== k); omitted.push(k); }
  }
  const view = { ...out };
  if (omitted.length) { entries.push('only_in_file'); view.only_in_file = omitted; }
  const lines = ['{', ...entries.map((k, i) => `  ${JSON.stringify(k)}: ${cut(view[k], k === 'result' || k === 'doc_text' ? 3000 : 1600)}${i < entries.length - 1 ? ',' : ''}`), '}'];
  // own copy per call (stdout/probe-<name>.md): parallel agents never read each other's answer
  U.printAndSaveSummary(run, `probe-${base}`, lines);
  U.log(run, `probe: ${pid || url} @${width}${mobile ? ' mobile' : ''}${steps.length ? ` · шагов ${steps.length}` : ''}${hasFix ? ' · правка подменой' : ''}${out.pdf ? ' · PDF' : ''} → ${out.error ? 'ошибка ' + out.error : out.status ?? '—'}${out.partial ? ' · частично' : ''}`);
  process.exit(code);
}

async function main() {
  const out = { tool: 'probe', version: U.VERSION, run, generated: U.nowIso(), url, pid: pid || null, width, height, mobile, dpr,
    media: { dark: !!args.dark, reduce: !!args.reduce, forced_colors: !!args['forced-colors'], vision: vision || null, no_js: !!args['no-js'], hide_overlays: !!args['hide-overlays'], blocked_urls: blockUrls },
    warnings };
  if (hasFix) out.fix = { css: cssFile?.rel || null, inject: injFile ? { file: injFile.rel, at, place } : null };
  // refusals before any network: action-like GET, another host, private network (unless it is the reviewed local site)
  if (U.isRiskyGet(url)) return { out: { ...out, error: 'refused_risky', refused: 'risky', warnings: [...warnings, T('Адрес похож на действие (выход, удаление, корзина) — не открываем.', 'The URL looks like an action (logout, delete, cart) — refused.')] }, code: 3 };
  if (isServicePath(url) && !serviceAllowed) return { out: { ...out, error: 'refused_service_path', refused: 'service_path', warnings: [...warnings, T('Служебный путь (секреты, админка, дамп) — открывается только при brief.json → limits.probe: true. Такие проверки делает headers.mjs --probe по решению оркестратора.', 'A service path (secrets, admin, dump) — only with brief.json → limits.probe: true.')] }, code: 3 };
  const pol = hostPolicy(url);
  if (!pol.ok) {
    const msg = pol.why === 'unknown_site'
      ? T('Не знаю, какой сайт проверяется: в RUN нет state.json, pages.json или brief.json. probe открывает только проверяемый сайт.', 'Unknown reviewed site: no state.json, pages.json or brief.json in RUN.')
      : T(`Адрес не с проверяемого сайта (${U.hostOf(url)}; проверяется ${pol.site.join(', ')}): probe открывает только этот сайт и его поддомены, у ролей конкурентов — сайты из rivals/ этого прогона.`,
        `Not the reviewed site (${U.hostOf(url)}; reviewed: ${pol.site.join(', ')}): probe opens only that site and its subdomains, rivals — sites from rivals/ of this run.`);
    return { out: { ...out, error: 'refused_host', refused: 'host', warnings: [...warnings, msg] }, code: 3 };
  }
  if (pol.by !== 'site') out.allowed_by = pol.by;
  await allowLocal(url);
  if (!U.isAllowedPrivate(U.hostOf(url)) && await U.resolvesPrivate(U.hostOf(url))) return { out: { ...out, error: 'refused_private', refused: 'private', warnings: [...warnings, T('Адрес ведёт во внутреннюю сеть — не открываем (кроме самого проверяемого сайта, если он локальный).', 'The address is in a private network — refused (except the reviewed site itself when it is local).')] }, code: 3 };

  // a picture or icon: no browser, the file itself (GET only, the address as the site gives it)
  let isStatic = false; try { isStatic = STATIC_EXT.test(new URL(url).pathname); } catch { /* no */ }
  if (isStatic) {
    // parameters only as the site itself gives them (the exact address is in its HTML): nothing of ours rides along
    if (new URL(url).search && !linkedFromSite(url)) return { out: { ...out, error: 'refused_query', refused: 'query', warnings: [...warnings, T('У адреса картинки параметры, которых нет в HTML сайта — не открываем. Дайте адрес ровно как на странице (или без «?…»).', 'The image URL has parameters not found in the site HTML — refused. Use the address exactly as on the page.')] }, code: 3 };
    if (steps.length || hasFix || jsFile || expr) warnings.push(T('Для картинки шаги, правка и код не выполняются — только файл.', 'For an image only the file is fetched: steps, fixes and code are ignored.'));
    const code = await staticProbe(url, out);
    return { out, code };
  }
  // a PDF address: no browser, the text is read from the file
  let isPdf = false; try { isPdf = /\.pdf$/i.test(new URL(url).pathname); } catch { /* no */ }
  if (isPdf) {
    const t = setTimeout(() => emit({ ...out, partial: true, error: T(`не уложился в ${budgetSec} с`, `over ${budgetSec}s budget`) }, 75), budgetSec * 1000);
    t.unref?.();
    const code = await pdfProbe(url, out);
    clearTimeout(t);
    return { out, code };
  }

  // a browser slot: waiting for it (≤ 5 min) is not part of --budget-sec
  U.cleanupStaleProfiles();
  let release = null;
  const slotNote = setTimeout(() => U.progress(T('probe: жду свободный браузер (заняты другими проверками)…', 'probe: waiting for a free browser slot…')), 1500);
  try { release = await U.acquireBrowserSlot({ waitMs: 5 * 60 * 1000 }); }
  catch { clearTimeout(slotNote); return { out: { ...out, partial: true, error: 'browser_busy', warnings: [...warnings, T('Все браузеры заняты 5 минут — повторите команду позже.', 'All browser slots busy for 5 minutes — retry later.')] }, code: 75 }; }
  clearTimeout(slotNote);
  // out of budget → partial answer and exit 75; a browser that is still starting is not tracked by lib/cdp yet,
  // so the exit waits (≤ 15 s) until the launch has finished and the exit handler can close it
  let launching = false;
  const onBudget = (waited = 0) => {
    if (launching && waited < 15000) { setTimeout(() => onBudget(waited + 250), 250); return; }
    emit({ ...out, partial: true, resume: null, error: T(`не уложился в ${budgetSec} с`, `over ${budgetSec}s budget`) }, 75);
  };
  const watchdog = setTimeout(onBudget, budgetSec * 1000);
  watchdog.unref?.();
  let browser = null;
  try {
    launching = true;
    try { browser = await Browser.launch(); } finally { launching = false; }
    const twoLoads = hasFix && args.before !== false;
    let b = null;
    // --vitals: the very first load of a fresh browser is slower (connections, code caches) — a warm-up load is not counted
    if (vitalsMode) await session(browser, { withFix: false, aa: hasFix, light: true, label: 'warm-up' }).catch(() => null);
    if (twoLoads) {
      // "before" goes through the same substitution path without a change (A/A): only the fix differs between the loads
      b = await session(browser, { withFix: false, aa: true, label: 'before', shotName: `${base}-before` });
      out.before = { status: b.status, error: b.error, metrics: b.metrics, result: b.result, result_error: b.result_error, shots: b.shots, actions: b.actions?.length ? b.actions : undefined,
        keys: b.keys?.length ? b.keys : undefined, fill: b.fill?.length ? b.fill : undefined, read: b.read, vitals: b.vitals, blocked: b.blocked, blocked_samples: b.blocked_samples,
        csp_violations: b.csp_violations?.length || 0 };
      if (b.error) warnings.push(T(`загрузка «до» не удалась: ${b.error}`, `"before" load failed: ${b.error}`));
    }
    const r = await session(browser, { withFix: hasFix, grep: !!grepRe, label: 'after', shotName: base });
    if (r.before && !out.before) out.before = { ...r.before, note: T('то же состояние до шагов, та же загрузка', 'same load, before the steps') };
    for (const k of ['status', 'final_url', 'chain', 'load_ms', 'timed_out', 'antibot', 'error', 'refused', 'metrics', 'result', 'result_error', 'actions', 'keys', 'fill', 'read_before', 'read',
      'shots', 'navigations', 'hidden_overlays', 'blocked', 'blocked_samples', 'console', 'console_errors', 'exceptions', 'exceptions_induced', 'failed', 'vitals', 'timing', 'scripts']) if (r[k] !== undefined) out[k] = r[k];
    // target=_blank windows are attached as about:blank: the actions already hold the link address
    const actPopups = (r.actions || []).flatMap(x => x.popups || []);
    out.popups = [...new Set([...sitePopups(browser.popups).filter(u => u !== 'about:blank' || !actPopups.length), ...actPopups, ...(r.opened || [])])];
    warnings.push(...(r.warnings || []));
    if (hasFix) { fixVerdict(out.fix, r, b, twoLoads); out.fix.loads = twoLoads ? 2 : 1; if (r.substitution) out.fix.substitution = r.substitution; }
    // --vitals: more loads (interleaved before/after), medians and the A/A verdict
    if (vitalsMode && !r.error) {
      const baseRuns = twoLoads && b?.vitals ? [b.vitals] : [], fixRuns = r.vitals ? [r.vitals] : [];
      for (let k = 1; k < repeat; k++) {
        if (twoLoads) { const bb = await session(browser, { withFix: false, aa: true, light: true, label: `before-${k + 1}` }); if (bb.vitals) baseRuns.push(bb.vitals); }
        const rr = await session(browser, { withFix: hasFix, light: true, label: `after-${k + 1}` }); if (rr.vitals) fixRuns.push(rr.vitals);
      }
      if (hasFix && twoLoads) {
        out.fix.speed = { runs: Math.min(baseRuns.length, fixRuns.length), ...speedVerdict(baseRuns, fixRuns) };
        out.fix.loads = baseRuns.length + fixRuns.length;
        if (out.fix.vitals_comparable === false) { out.fix.speed.verdict = 'not_comparable'; out.fix.speed.fix_verified = false; }
      } else {
        const med = k => { const xs = fixRuns.map(v => v?.[k]).filter(x => typeof x === 'number'); return xs.length ? (k === 'cls' ? Math.round(U.median(xs) * 10000) / 10000 : Math.round(U.median(xs))) : null; };
        out.vitals_runs = { runs: fixRuns.length, median: Object.fromEntries(['lcp', 'fcp', 'cls', 'lcp_from_response', 'fcp_from_response', 'response_end'].map(k => [k, med(k)])), values: fixRuns };
      }
    }
    for (const k of ['actions', 'keys', 'fill']) if (Array.isArray(out[k]) && !out[k].length) delete out[k];
    clearTimeout(watchdog);
    // the address answered with a PDF (or the browser gave it to the download manager): read the file instead
    if (r.doc_mime === 'application/pdf' || (r.error && /ERR_ABORTED|download/i.test(r.error))) {
      const probePdf = await U.fetchBytes(out.final_url || url, { maxBytes: 8, timeoutMs: 15000 }).catch(() => null);
      if (probePdf?.buf && probePdf.buf.toString('latin1').startsWith('%PDF')) {
        delete out.error; delete out.refused;
        const code = await pdfProbe(out.final_url || url, out);
        return { out, code };
      }
    }
    const code = out.refused ? 3 : out.error ? 1 : out.antibot ? 3 : 0;
    if (out.antibot) warnings.push(T('Страница закрыта защитой от ботов — капчу не проходим; замеры относятся к странице проверки.', 'The page is an anti-bot challenge — not solved; measurements describe the challenge page.'));
    return { out, code };
  } catch (e) {
    // a failure after launch still gives a JSON answer (what was collected so far + the error)
    clearTimeout(watchdog);
    const m = String(e?.message || e);
    if (/браузер|browser failed|Chromium|Node\.js 22/i.test(m)) throw e;
    return { out: { ...out, error: `failure: ${m.slice(0, 200)}`, partial: true }, code: 1 };
  } finally {
    try { await browser?.close(); } catch { /* ignore */ }
    release?.();
  }
}

main().then(({ out, code }) => emit(out, code)).catch(e => {
  const m = String(e?.message || e);
  console.error(T('probe: сбой — ', 'probe: failure — ') + (e?.stack || m));
  try { U.log(run, `probe: сбой ${m.slice(0, 200)}`); } catch { /* ignore */ }
  if (!finalOut) process.exit(/браузер|browser|Chromium|Node\.js 22|слота/i.test(m) ? 2 : 1);
});
