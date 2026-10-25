#!/usr/bin/env node
// Revizor — report.mjs: report/findings.json + report/summary.json (+ scores, strategy, edits) → one-file report.html
// (images as data URIs), registry.xlsx (hidden _revizor sheet), optional report.pdf, report shots for the editor,
// self-checks. Modes rivals and recheck build rivals.html / recheck.html from their own files.
//
//   node report.mjs --run "<RUN>" [--audience owner|team|external] [--lang ru|en] [--pdf] [--scores]
//                   [--mode full|quick|rivals|recheck] [--css f] [--title t] [--logo f] [--open] [--renumber|--no-renumber]
//                   [--status "P0-01=в работе"]… [--no-shots] [--recrop] [--keep-raw] [--no-cleanup] [--budget-sec 480]

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, copyFileSync } from 'node:fs';
import { join, dirname, basename, extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import * as U from './lib/util.mjs';
import { writeXlsx, readXlsx, findColumns } from './lib/xlsx.mjs';
import { imageSize } from './lib/img.mjs';

const NAME = 'report';
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(SCRIPTS);
const TPL = join(ROOT, 'templates');
const KNOW = process.env.REVIZOR_KNOWLEDGE_DIR ? resolve(process.env.REVIZOR_KNOWLEDGE_DIR) : join(ROOT, 'knowledge'); // env: tests only
const SCHEMA_VERSION = 3;
const MAX_SINGLE_MB = Number(process.env.REVIZOR_REPORT_MAX_MB) || 15; // env: tests only
const CROP_VERSION = 2;
// printable A4 area of @page { size: A4; margin: 14mm 12mm } in CSS px
const PAGE_W = 186 * 96 / 25.4, PAGE_H = 269 * 96 / 25.4;

const HELP = `
report.mjs — отчёт: HTML одним файлом, реестр Excel, PDF по желанию, самопроверка

  node report.mjs --run "<RUN>" [флаги]

Берёт report/findings.json и report/summary.json (+ scores-strict/market.json, strategy.json, edits.json, diff.json),
pages.json, brief.json, state.json, кадры snapshot/*/shots. Пишет в report/:
  report.html          один файл: картинки внутри (JPEG q60, кропы ≤ 1000 px), CSP без скриптов, тёмная тема, печать
  registry.xlsx        «Замечания», «По месту правки», «Сводка» (формулы), «Как читать», скрытый «_revizor»
  report.pdf           с --pdf (A4, плоские цвета — без артефактов на iPhone)
  img/                 кропы (кэш; повторный запуск берёт готовые) и img/by-rid.json (номер → файлы кропов)
  shots/               кадры отчёта с раскрытыми <details>: report-390.part-NN.jpg, report-1440.part-NN.jpg,
                       report-390-dark.part-01.jpg, report-pdf.part-NN.jpg (листы PDF: та же раскладка разрывов,
                       число сверяется с PDF; не совпало — подпись «приблизительно»)
  findings.effective.json  находки ровно как в отчёте (после edits.json, снятия для external, перенумерации) —
                       по нему textscan --report --file проверяет язык отчёта
  external-view.json   (external) что report.mjs снял сам и перенумерация для заказчика (старый № → новый, uid → №);
                       external-dropped.json пишет только finalize.mjs, report.mjs его читает
  renumber.json        перенумерация (старый № → новый); с --renumber действует и на следующие запуски
  numbering.json       номера последнего отчёта по аудиториям (rid → uid): по ним правки из edits.json без uid
                       привязываются к находке, и report.mjs дописывает в edits.json её uid
  statuses.json        статусы для реестра из --status
  selfcheck.json       итог самопроверки
  report-files/ + report-files.zip   если HTML вышел больше ${MAX_SINGLE_MB} МБ: версия с папкой картинок
Режим rivals → report/rivals.html + rivals.xlsx (отметки «беру / нет / обсудить», единственный скрипт, CSP по хэшу).
Режим recheck → report/recheck.html по recheck/result.json: «было / стало» кропами одной высоты (старый кадр —
из исходного прогона по uid), регрессии, новые находки. Новый реестр делает recheck.mjs --collect.

Флаги:
  --run <папка>            папка прогона (обязательно)
  --audience owner|team|external   кому отчёт (по умолчанию из state.json/summary.json, иначе owner)
  --lang ru|en             язык подписей (по умолчанию как в summary.json/state.json)
  --mode full|quick|rivals|recheck  (по умолчанию из state.json)
  --pdf / --no-pdf         PDF из того же HTML (по умолчанию флаг прогона)
  --scores / --no-scores   оценки (только owner и team; нужны report/scores-*.json)
  --css <файл>             свой CSS поверх стиля (по умолчанию report_css из настроек); с ним отчёт только светлый
  --title "<текст>"        свой заголовок
  --logo <файл>            логотип png/jpg/svg/webp ≤ 2 МБ
  --renumber               перенумеровать без дыр после edits.json → renumber.json; держится и в следующих
                           запусках; --no-renumber — вернуть номера finalize.mjs
  --status "P0-01=в работе"  статус строки реестра (новое / в работе / исправлено / не будем исправлять);
                           флаг можно повторять или писать через «;»; статусы хранятся в report/statuses.json
  --open                   открыть отчёт и папку
  --no-shots               не снимать кадры отчёта (только для черновых повторов; редактору нужны кадры)
  --recrop                 пересобрать кропы, не брать из кэша report/img
  --keep-raw / --no-cleanup  не удалять промежуточные кадры (*.part-NN.jpg, inner, mobile/*.jpg, dom.html, collect/, verify/lint-index/)
  --budget-sec N           стоп до таймаута (по умолчанию 480): частичный результат и код 75, повтор продолжит
Коды: 0 — готово и самопроверка пройдена; 1 — самопроверка нашла ошибки (файлы записаны, список в selfcheck.json) или сбой;
      2 — нет нужных файлов/аргументов; 75 — частично (бюджет времени).
`;

// ---------------------------------------------------------------- small helpers
let LANG = 'ru';
const M = (ru, en) => (LANG === 'en' ? en : ru);
const BIDI = /[\u202a-\u202e\u2066-\u2069\u200e\u200f]/g;
const CTRL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;
function esc(s) {
  return String(s ?? '').replace(BIDI, '').replace(CTRL, '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const isStr = v => typeof v === 'string' && v.trim() !== '';
const arr = v => (Array.isArray(v) ? v : v === undefined || v === null || v === '' ? [] : [v]);
const fwd = p => String(p).split(sep).join('/');
const sha = (s, n = 12) => createHash('sha1').update(String(s)).digest('hex').slice(0, n);
const validBox = b => Array.isArray(b) && b.length === 4 && b.every(n => typeof n === 'number' && Number.isFinite(n));
function fill(tpl, vars = {}) { return String(tpl ?? '').replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)); }
// one pass: a {{token}} inside the data is never substituted again
function replaceAllTokens(tpl, map) { return tpl.replace(/\{\{(\w+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(map, k) ? String(map[k]) : m)); }
function fmtDate(iso, lang = LANG) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return String(iso || '');
  const p = n => String(n).padStart(2, '0');
  return lang === 'en' ? `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` : `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()}`;
}
function fmtNum(n, lang, digits = 1) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const s = Number.isInteger(n) && digits === 0 ? String(n) : n.toFixed(digits);
  return lang === 'en' ? s : s.replace('.', ',');
}
function fmtB(n, lang) { const t = U.fmtBytes(n); return lang === 'en' ? t.replace('КБ', 'KB').replace('МБ', 'MB').replace('ГБ', 'GB').replace(/(\d) Б$/, '$1 B') : t; }
function fileSize(p) { try { return statSync(p).size; } catch { return 0; } }
function dirSize(p) {
  let n = 0;
  try { for (const e of readdirSync(p, { withFileTypes: true })) { const q = join(p, e.name); n += e.isDirectory() ? dirSize(q) : fileSize(q); } } catch {}
  return n;
}
function readMaybe(p, fb = null) { try { return existsSync(p) ? U.readJSON(p) : fb; } catch (e) { return { __error: e.message }; } }
function safeHref(u) {
  try { const x = new URL(String(u)); return x.protocol === 'http:' || x.protocol === 'https:' ? x.toString() : null; } catch { return null; }
}
function shortPath(u) {
  try { const x = new URL(String(u)); let p = decodeURI(x.pathname + x.search); if (p.length > 60) p = p.slice(0, 57) + '…'; return p || '/'; } catch { return String(u || ''); }
}
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
const sevNum = s => (/^P[0-3]$/.test(String(s)) ? Number(String(s)[1]) : 3);
const ridNum = r => { const m = String(r || '').match(/^P([0-3])-(\d+)$/); return m ? Number(m[2]) : 9999; };
const RID_RE = /(?<![\w-])P[0-3]-\d{2,3}(?![\w-])/g;

// ---------------------------------------------------------------- strings, knowledge
let STR = null;
function loadStrings(lang) {
  const all = U.readJSON(join(TPL, 'strings.json'));
  STR = all[lang] || all.ru;
  return STR;
}
function tr(path, vars) {
  const v = path.split('.').reduce((o, k) => (o && typeof o === 'object' && k in o ? o[k] : undefined), STR);
  return typeof v === 'string' ? fill(v, vars) : v;
}

// glossary: <!-- revizor:glossary {"LCP":"…"} --> (or {"ru":{…},"en":{…}}); fallback — rows «| term | meaning |»
function loadGlossary(lang) {
  const p = join(KNOW, 'glossary.md');
  if (!existsSync(p)) return null;
  const md = readFileSync(p, 'utf8');
  let map = {};
  const blocks = lang === 'en' ? [/<!--\s*revizor:glossary-en\s*(\{[\s\S]*?\})\s*-->/, /<!--\s*revizor:glossary\s*(\{[\s\S]*?\})\s*-->/] : [/<!--\s*revizor:glossary\s*(\{[\s\S]*?\})\s*-->/];
  for (const re of blocks) {
    const m = md.match(re);
    if (m) { try { map = JSON.parse(m[1]); } catch { map = {}; } }
    if (Object.keys(map).length) break;
  }
  if (map && (typeof map[lang] === 'object' || typeof map.ru === 'object') && !Array.isArray(map[lang])) map = map[lang] || map.ru || {};
  if (!Object.keys(map).length) {
    for (const line of md.split(/\r?\n/)) {
      const r = line.match(/^\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/);
      if (!r || /^[-: ]+$/.test(r[1]) || /^(термин|term)$/i.test(r[1])) continue;
      map[r[1].replace(/\*\*/g, '').trim()] = r[2].trim();
    }
  }
  // pure numbers («301») would also hit phone numbers and prices — no hint for them
  const entries = Object.entries(map).filter(([k, v]) => isStr(k) && isStr(v) && k.length <= 40 && !/^[\d\s.,-]+$/.test(k))
    .map(([term, meaning]) => ({ term: term.trim(), meaning: String(meaning).replace(/\s+/g, ' ').trim(), exact: /[A-ZА-ЯЁ]/.test(term) && term === term.toUpperCase() }));
  if (!entries.length) return null;
  entries.sort((a, b) => b.term.length - a.term.length);
  const byLow = new Map(entries.map(e => [e.term.toLowerCase(), e]));
  const reEsc = s => esc(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${entries.map(e => reEsc(e.term)).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return { entries, byLow, re, used: new Map() };
}
// apply to text parts of already escaped html (never inside tags); one <abbr> per term per scope
function applyGlossary(html, gl, scope) {
  if (!gl || !scope) return html;
  return html.split(/(<[^>]+>)/).map((part, i) => (i % 2 ? part : part.replace(gl.re, m => {
    const e = gl.byLow.get(m.toLowerCase());
    if (!e || (e.exact && m !== esc(e.term)) || scope.has(e.term)) return m;
    scope.add(e.term); gl.used.set(e.term, e.meaning);
    return `<abbr title="${esc(e.meaning)}">${m}</abbr>`;
  }))).join('');
}

// forbidden words by audience: tone.md <!-- revizor:forbidden {"all":[…],"owner":[…],"team":[…],"external":[…]} -->
// (literals, 'word*' stems and '/regexp/flags' via util.compileStopTerm). The fallback is used only without tone.md.
const FORBIDDEN_FALLBACK = {
  all: ['возможно', 'наверное', 'по-видимому', 'видимо', 'стоит рассмотреть', 'можно рассмотреть', 'можно улучшить', 'стоит поработать', 'стоит подумать',
    'очевидно', 'грубая ошибка', 'халтура', 'важно отметить', 'стоит отметить', 'следует отметить', 'забыли', 'не позаботились',
    'maybe', 'perhaps', 'consider improving', 'could be improved', 'obviously', 'it is important to note', 'sloppy'],
  owner: [], team: [],
  external: ['не проверено', 'не проверяли', 'не удалось проверить', 'нужна ручная проверка', 'требует подтверждения', 'предварительно', 'релиз', 'условие выпуска',
    '/(?<![\\p{L}-])агент(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?![\\p{L}-])/iu', 'ревизор', 'ревизора', 'ревизором', 'revizor', 'claude', 'anthropic',
    'not checked', 'could not check', '/(?<![\\p{L}-])agents?(?![\\p{L}-])/iu'],
};
// traces of the tool in text for another company: run files, shot names, field = value, CLI flags, @width
const RUN_FILES = 'mobile|seo|links|links-blocks|headers|domain|privacy|a11y|axe|contrast|forms|textscan|textscan-report|perf|vision|layout|fonts|meta|page|pages|brief|state|findings|summary|candidates|editorial|digest|handoffs|strategy|scores-strict|scores-market|text|raw|dom|index|pipeline|snapshot|selfcheck|external-dropped|renumber|numbering|result|plan';
// [rule, hint ru, hint en]
const TRACE_RULES = [
  [`/(?<![\\p{L}\\p{N}_.\\/-])(?:${RUN_FILES})\\.(?:json|jsonl|md|html)(?![\\p{L}\\p{N}_])/iu`, 'файл замера или прогона', 'measurement or run file'],
  ['/(?<![\\p{L}\\p{N}_-])[\\w-]+\\.mjs(?![\\p{L}\\p{N}_])/iu', 'имя скрипта', 'script name'],
  ['/(?<![\\p{L}\\p{N}_])\\d{3,4}(?:x\\d{3,4})?(?:-fold|-full|\\.part-\\d+|\\.inner-\\d+)\\.(?:jpe?g|png)/iu', 'имя кадра снимка', 'snapshot frame name'],
  ['/(?<![\\p{L}\\p{N}_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+\\s*(?:=|:|→)\\s*[\\p{L}\\p{N}"\'\\[{-]/u', 'поле замера = значение', 'measurement field = value'],
  ['/(?<![\\p{L}\\p{N}_])[a-z][a-z0-9]*(?:_[a-z0-9]+){2,}(?![\\p{L}\\p{N}_])/u', 'поле замера', 'measurement field'],
  ['/(?<![\\p{L}\\p{N}_-])--(?:pid|url|width|css|js|expr|tap|click|hover|shot|full|pages?|run|budget-sec|mobile|dark|reduce|inject-html|fill|read|vision|block|audience|lang|renumber|keep-raw|probe|as-bot|redo|max-pages|report|file|spell|mode|scores|pdf|ids|lens)(?![\\p{L}\\p{N}_-])/u', 'флаг команды', 'command flag'],
  ['/(?<![\\p{L}\\p{N}@.])@\\d{3,4}(?![\\p{L}\\p{N}])/u', 'запись ширины вида @390', 'width note like @390'],
];
// always on for external, whatever tone.md says: paths, lens codes, hashes, method codes, scores
const CODE_EXTERNAL = [
  ['/(?<![\\p{L}\\p{N}])[0-9a-f]{32}(?![\\p{L}\\p{N}])/i', 'хэш', 'hash'],
  ['/(?<![A-Za-z])[A-Za-z]:[\\\\/][^\\s]*/u', 'путь на диске', 'disk path'],
  ['/(?<![\\p{L}\\w./-])(?:snapshot|measure|findings|verify|critic|notes|stdout|probe-js|probe|recheck)\\/[\\w.\\/-]+/u', 'путь в папке прогона', 'run folder path'],
  ['/(?<![\\w-])(?:product|facts|visitor|ux|visual|typography|color|mobile|a11y|copy|seo-tech|seo-content|perf|stability|forms|security|privacy|legal|ecommerce|i18n|health)-(?:r2-|v)?\\d{2,3}(?![\\w-])/u', 'внутренний код находки', 'internal finding code'],
  ['/(?<![\\w-])(?:script|revizor):[a-z-]+/u', 'код метода', 'method code'],
  // a score: «X из 10» next to «оценка / балл / score» («оценка удобства — 6 из 10», «6/10 баллов»);
  // «на 6 из 10 страниц» and «рейтинг 4,8 на картах» are facts, not scores
  ['/(?:оценк\\p{L}*|балл\\p{L}*|score\\w*)[^.!?\\n]{0,40}?(?<![\\d,.])\\d{1,2}(?:[,.]\\d)?\\s*(?:из|of|\\/)\\s*10(?![\\d,.]?\\d)|(?<![\\d,.])\\d{1,2}(?:[,.]\\d)?\\s*(?:из|of|\\/)\\s*10(?!\\d)[^.!?\\n]{0,20}?(?:балл\\p{L}*|оценк\\p{L}*|score\\w*|points?)/iu', 'оценка «X из 10»', 'a score «X of 10»'],
  ...TRACE_RULES,
];
function compileForbidden(entry) { // used only if util.compileStopTerm is missing
  try {
    if (entry && typeof entry === 'object') return { label: entry.hint || entry.pattern, re: new RegExp(entry.pattern, (entry.flags || 'iu').replace(/g/g, '')) };
    const s = String(entry);
    const m = s.match(/^\/(.+)\/([a-z]*)$/s);
    if (m) return { label: s, re: new RegExp(m[1], m[2].includes('u') ? m[2].replace(/g/g, '') : m[2].replace(/g/g, '') + 'u') };
    const lit = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return { label: s, re: new RegExp(`(?<![\\p{L}\\p{N}])${lit}(?![\\p{L}\\p{N}])`, 'iu') };
  } catch { return null; }
}
const compileTerm = typeof U.compileStopTerm === 'function' ? U.compileStopTerm : compileForbidden;
const TRACE_COMPILED = TRACE_RULES.map(([r]) => compileTerm(r)).filter(Boolean);
function loadForbidden(audience, extraLiterals = []) {
  const p = join(KNOW, 'tone.md');
  let src = null, from = 'fallback', note = null;
  if (existsSync(p)) {
    const md = readFileSync(p, 'utf8');
    const m = md.match(/<!--\s*revizor:forbidden\s*(\{[\s\S]*?\})\s*-->/);
    if (m) { try { src = JSON.parse(m[1]); from = 'tone.md'; } catch (e) { note = e.message; } }
    else note = M('нет блока <!-- revizor:forbidden … -->', 'no <!-- revizor:forbidden … --> block');
  }
  if (!src) src = FORBIDDEN_FALLBACK;
  const rules = []; const seen = new Set();
  const push = (e, kind, hint = null) => {
    const k = JSON.stringify(e); if (seen.has(k)) return; seen.add(k);
    const r = compileTerm(e); if (!r) return;
    rules.push({ ...r, ...(hint ? { label: hint } : {}), kind });
  };
  for (const e of arr(src.all)) push(e, 'tone');
  for (const e of arr(src[audience])) push(e, 'audience'); // site terms may excuse these
  if (audience === 'external') for (const [e, ru, en] of CODE_EXTERNAL) push(e, 'code', M(ru, en));
  for (const e of extraLiterals) push(e, 'date');
  return { from, note, rules };
}
// words of the site itself (text.md of all pages + brief.site.terms): a tool word that is a site term is not a trace
function siteVocab(run, brief) {
  const parts = [];
  for (const t of [...arr(brief?.site?.terms), ...arr(brief?.site_terms)]) if (isStr(t)) parts.push(t);
  const snap = join(run, 'snapshot');
  let total = 0;
  if (existsSync(snap)) for (const pid of readdirSync(snap)) {
    const f = join(snap, pid, 'text.md');
    if (total > 3e6 || !existsSync(f)) continue;
    try { const t = readFileSync(f, 'utf8'); total += t.length; parts.push(t.slice(0, 500000)); } catch {}
  }
  const norm = s => ' ' + String(s).toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
  const text = norm(parts.join(' '));
  return { has: w => { const n = norm(w).trim(); return n.length >= 3 && /^[\p{L} ]+$/u.test(n) && text.includes(` ${n} `); } };
}
// balanced «…» (nested «Кофейня «Зёрна»» is one quote) and “…” spans: [[start, end), …]
function quoteSpans(s) {
  const spans = [];
  for (const [open, close] of [['«', '»'], ['“', '”']]) {
    let depth = 0, start = -1;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === open) { if (depth++ === 0) start = i; }
      else if (s[i] === close && depth > 0) { if (--depth === 0) spans.push([start, i + 1]); }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const sp of spans) if (!out.length || sp[0] >= out[out.length - 1][1]) out.push(sp); // outer one wins
  return out;
}
function mapQuotes(s, fn) {
  let res = '', at = 0;
  for (const [a, b] of quoteSpans(s)) { res += s.slice(at, a) + fn(s.slice(a, b)); at = b; }
  return res + s.slice(at);
}
// drop quotes from the site («…», “…”, „…“, "…") and code spans before scanning our own text
function stripQuoted(s) {
  return mapQuotes(String(s ?? ''), () => ' ').replace(/„[^„“”]*[“”]/g, ' ').replace(/"[^"\n]*"/g, ' ').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}
// evidence = «fact in words [source]»: the bracketed tail is the technical part (files, fields, commands)
function splitEvidence(s) {
  let fact = String(s ?? '').trim(); const src = [];
  for (let n = 0; n < 4; n++) {
    let end = fact.length; while (end > 0 && /[\s.;,]/.test(fact[end - 1])) end--;
    if (fact[end - 1] !== ']') break;
    let depth = 0, i = end - 1;
    for (; i >= 0; i--) { if (fact[i] === ']') depth++; else if (fact[i] === '[' && --depth === 0) break; }
    if (i < 0) break;
    const tail = fact.slice(end);
    src.unshift(fact.slice(i, end));
    fact = fact.slice(0, i).trimEnd();
    if (/[.!?…]/.test(tail) && fact && !/[.!?…:]$/.test(fact)) fact += '.';
  }
  return { fact, source: src.join(' ') };
}
const hasTrace = text => { const t = stripQuoted(text); return TRACE_COMPILED.some(r => r.re.test(t)) || /(?<![\p{L}\w./-])(?:snapshot|measure|findings|verify|critic|notes|stdout|probe-js|probe)\/[\w./-]+/u.test(t); };

// ---------------------------------------------------------------- rich text (escaped, tiny markdown, site quotes, glossary)
function rich(text, gl, scope) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!src) return '';
  const parts = src.split(/```[a-z0-9-]*\n?([\s\S]*?)```/i);
  let out = '';
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { out += `<pre><code>${esc(parts[i].replace(/\n$/, ''))}</code></pre>`; continue; }
    const seg = parts[i].trim();
    if (!seg) continue;
    out += seg.split(/\n{2,}/).map(par => inlineBlock(par, gl, scope)).join('');
  }
  return out;
}
// numbers of findings shown in this report: «см. P1-03» in any text becomes a link to the card or row
let LINK_RIDS = new Set();
let CUR_AUD = 'owner';
function linkRids(html) {
  if (!LINK_RIDS.size) return html;
  return html.split(/(<[^>]+>)/).map((part, i) => (i % 2 ? part : part.replace(RID_RE, m => (LINK_RIDS.has(m) ? `<a class="rid" href="#${m}">${m}</a>` : m)))).join('');
}
// quotes from the site get <q class="site">: the external check and the tone check skip them
const markQuotes = h => mapQuotes(h, m => `<q class="site">${m}</q>`);
function inline(line, gl, scope) {
  return line.split(/(`[^`\n]+`)/).map((p, i) => (i % 2 ? `<code>${esc(p.slice(1, -1))}</code>`
    : linkRids(applyGlossary(markQuotes(esc(p)).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>'), gl, scope)))).join('');
}
function inlineBlock(par, gl, scope) {
  const lines = par.split('\n');
  let html = '', list = [], listTag = 'ul', textLines = [];
  const flushText = () => { if (textLines.length) { html += `<p>${textLines.map(l => inline(l, gl, scope)).join('<br>')}</p>`; textLines = []; } };
  const flushList = () => { if (list.length) { html += `<${listTag}>${list.map(l => `<li>${inline(l, gl, scope)}</li>`).join('')}</${listTag}>`; list = []; } };
  for (const l of lines) {
    const m = l.match(/^\s*([-•*]|\d+[.)])\s+(.*)$/);
    if (m) {
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      flushText(); if (list.length && tag !== listTag) flushList();
      listTag = tag; list.push(m[2]);
    } else { flushList(); textLines.push(l); }
  }
  flushText(); flushList();
  return html;
}
const plain = (text, gl, scope) => inline(String(text ?? '').replace(/\s*\n\s*/g, ' ').trim(), gl, scope);

// ---------------------------------------------------------------- html safety: real tags and attribute names
function decodeEntities(s) {
  return String(s ?? '').replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32)).replace(/&#(\d+);?/g, (_, d) => String.fromCodePoint(Number(d) || 32))
    .replace(/&colon;/gi, ':').replace(/&tab;|&newline;/gi, '').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
// tokenizer of our own output: data is escaped, so every «<» here starts a tag we wrote; contents of
// <style>/<script>/<textarea>/<title> are skipped; attribute values are read whole (quoted or not)
function parseTags(html) {
  const out = []; const n = html.length; const low = html.toLowerCase();
  let i = 0;
  while (i < n) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) { const e = html.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    const m = /^<(\/?)([a-zA-Z][\w:-]*)/.exec(html.slice(lt, lt + 80));
    if (!m) { i = lt + 1; continue; }
    const closing = m[1] === '/'; const name = m[2].toLowerCase();
    let j = lt + m[0].length; const attrs = [];
    while (j < n) {
      while (j < n && /\s/.test(html[j])) j++;
      if (j >= n) break;
      if (html[j] === '>') { j++; break; }
      if (html[j] === '/') { j++; continue; }
      let k = j; while (k < n && !/[\s=>/]/.test(html[k])) k++;
      if (k === j) { j++; continue; }
      const an = low.slice(j, k); j = k;
      while (j < n && /\s/.test(html[j])) j++;
      let av = null;
      if (html[j] === '=') {
        j++; while (j < n && /\s/.test(html[j])) j++;
        const q = html[j];
        if (q === '"' || q === "'") { const e = html.indexOf(q, j + 1); av = html.slice(j + 1, e < 0 ? n : e); j = e < 0 ? n : e + 1; }
        else { let k2 = j; while (k2 < n && !/[\s>]/.test(html[k2])) k2++; av = html.slice(j, k2); j = k2; }
      }
      attrs.push({ name: an, value: av });
    }
    out.push({ name, closing, attrs, at: lt });
    i = j;
    if (!closing && ['style', 'script', 'textarea', 'title'].includes(name)) { const e = low.indexOf(`</${name}`, i); i = e < 0 ? n : e; }
  }
  return out;
}
function activeContent(html) {
  const problems = []; let scripts = 0;
  for (const t of parseTags(html)) {
    if (t.closing) continue;
    if (t.name === 'script') scripts++;
    if (['iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'form', 'base', 'link'].includes(t.name)) problems.push(`<${t.name}>`);
    if (t.name === 'meta' && t.attrs.some(a => a.name === 'http-equiv' && /refresh/i.test(a.value || ''))) problems.push('<meta http-equiv=refresh>');
    for (const a of t.attrs) {
      if (/^on/.test(a.name)) problems.push(`<${t.name} ${a.name}=…>`);
      if (['href', 'src', 'action', 'formaction', 'xlink:href', 'poster', 'data', 'background'].includes(a.name)) {
        const v = decodeEntities(a.value || '').replace(/[\u0000-\u0020]+/g, '').toLowerCase();
        if (/^(?:javascript|vbscript):|^data:text\/html/.test(v)) problems.push(`<${t.name} ${a.name}=${v.slice(0, 20)}…>`);
      }
    }
  }
  return { scripts, problems };
}

// ---------------------------------------------------------------- zip (report-files.zip)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
}
function zipWrite(entries) { // [{ name, data: Buffer, store? }]
  const locals = [], centrals = []; let offset = 0;
  const d = new Date(); const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1); const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8'); const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const store = !!e.store; const comp = store ? raw : zlib.deflateRawSync(raw, { level: 9 }); const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(store ? 0 : 8, 10); ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals); const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// ---------------------------------------------------------------- settings
function settings(args, run) {
  const state = readMaybe(join(run, 'state.json'), {}) || {};
  const flags = state.flags || {};
  const summary = readMaybe(join(run, 'report', 'summary.json'), null);
  const warnings = [];
  const pick = (v, ok, ...fb) => { for (const x of [v, ...fb]) if (x !== undefined && x !== null && x !== true && ok.includes(String(x))) return String(x); return ok[0]; };
  const lang = pick(args.lang, ['ru', 'en'], summary && !summary.__error ? summary.lang : undefined, flags.lang);
  LANG = lang;
  if (args.audience && !['owner', 'team', 'external'].includes(String(args.audience))) warnings.push(M(`--audience ${args.audience}: не понял, беру из прогона`, `--audience ${args.audience}: unknown, using the run's audience`));
  const audience = pick(args.audience, ['owner', 'team', 'external'], summary && !summary.__error ? summary.audience : undefined, flags.audience);
  const mode = pick(args.mode, ['full', 'quick', 'rivals', 'recheck'], state.mode, summary && !summary.__error ? summary.mode : undefined);
  const bool = (a, f) => (a === true || a === false ? a : !!f);
  return {
    state, flags, warnings, audience, lang, mode,
    pdf: bool(args.pdf, flags.pdf),
    scores: audience !== 'external' && bool(args.scores, flags.scores),
    css: isStr(args.css) ? resolve(String(args.css)) : (isStr(flags.report_css) ? flags.report_css : null),
    title: isStr(args.title) ? String(args.title) : null,
    logo: isStr(args.logo) ? resolve(String(args.logo)) : null,
    renumber: args.renumber === true ? true : args.renumber === false ? false : null,
    statusArgs: arr(args.status).flatMap(s => String(s).split(';')).map(s => s.trim()).filter(Boolean),
    open: !!args.open, shots: args.shots !== false, recrop: !!args.recrop,
    keepRaw: !!args['keep-raw'] || !!flags.keep_raw || args.cleanup === false,
    budgetMs: Math.max(30, Number(args['budget-sec']) || 480) * 1000,
  };
}

// ---------------------------------------------------------------- findings: normalise, edits, renumber, audience
function normItems(raw) {
  return arr(raw).filter(x => x && typeof x === 'object').map((it, i) => {
    const severity = /^P[0-3]$/.test(String(it.severity)) ? String(it.severity) : 'P3';
    const where = arr(it.where).filter(w => w && typeof w === 'object');
    const lenses = arr(it.lenses).length ? arr(it.lenses).map(String) : [it.lens || String(it.id || '').replace(/-(?:r2-|v)?\d+$/, '')].filter(Boolean);
    return { ...it, severity, s: sevNum(severity), where, lenses, _i: i };
  });
}
function sortItems(items) { return items.sort((a, b) => a.s - b.s || ridNum(a.rid) - ridNum(b.rid) || a._i - b._i); }
function assignMissingRids(items, warnings) {
  const used = new Set(items.map(i => i.rid).filter(Boolean));
  let missing = 0;
  for (const s of [0, 1, 2, 3]) {
    let n = Math.max(0, ...items.filter(i => i.s === s && /^P[0-3]-\d+$/.test(i.rid || '')).map(i => ridNum(i.rid)));
    for (const it of items.filter(i => i.s === s && !/^P[0-3]-\d+$/.test(i.rid || ''))) {
      let r; do { r = `P${s}-${String(++n).padStart(2, '0')}`; } while (used.has(r));
      it.rid = r; used.add(r); missing++;
    }
  }
  if (missing) warnings.push(M(`у ${missing} находок не было rid — выдал по порядку (finalize.mjs должен их ставить)`, `${missing} findings had no rid — numbered in order (finalize.mjs should set them)`));
}

const TEXT_FIELDS = ['title', 'problem', 'evidence', 'impact', 'fix', 'before', 'after', 'scenario', 'norm'];
// edits target a finding by uid; an edit with only rid means the number in the LAST report of this audience
// (numbering.json), else the number of finalize.mjs. Resolved edits get the uid written back (pinned).
function applyEdits(items, edits, errors, lastNumbering) {
  const log = [], dropped = [], pinned = [];
  const byUid = new Map(items.filter(i => isStr(i.uid)).map(i => [i.uid, i]));
  const lastMap = lastNumbering && typeof lastNumbering.rid_to_uid === 'object' ? lastNumbering.rid_to_uid : null;
  for (const [k, e] of arr(edits).entries()) {
    if (!e || typeof e !== 'object') continue;
    const tag = `edits[${k}] ${e.op || '?'} ${e.uid || e.rid || ''}`.trim();
    let base = null;
    if (isStr(e.uid)) base = byUid.get(e.uid) || null;
    else if (isStr(e.rid)) {
      const via = lastMap && lastMap[e.rid] ? byUid.get(lastMap[e.rid]) : null;
      base = via || items.find(i => i.rid === e.rid || i.uid === e.rid || i.id === e.rid) || null;
      if (base && isStr(base.uid)) { e.uid = base.uid; pinned.push(k); }
    }
    if (!base) { errors.push({ rule: 'edits', where: tag, text: M(`нет находки ${e.uid || e.rid}`, `no finding ${e.uid || e.rid}`) }); continue; }
    const targets = e.scope === 'all' && isStr(base.category) ? items.filter(i => i.category === base.category) : [base];
    if (e.op === 'drop') {
      for (const t of targets) { const idx = items.indexOf(t); if (idx >= 0) { items.splice(idx, 1); dropped.push({ rid: t.rid, uid: t.uid, id: t.id, why: e.why || '' }); } }
      log.push(`${tag}: ${M('снято', 'dropped')} ${targets.length}`);
    } else if (e.op === 'severity') {
      if (!/^P[0-3]$/.test(String(e.to))) { errors.push({ rule: 'edits', where: tag, text: M(`важность «${e.to}» не P0–P3`, `severity «${e.to}» is not P0–P3`) }); continue; }
      for (const t of targets) { t.severity_trail = [...arr(t.severity_trail), { by: 'edits', from: t.severity, to: e.to, why: e.why || '' }]; t.severity = String(e.to); t.s = sevNum(t.severity); }
      log.push(`${tag}: ${M('важность', 'severity')} → ${e.to} (${targets.length})`);
    } else if (e.op === 'replace_text') {
      if (!isStr(e.from)) { errors.push({ rule: 'edits', where: tag, text: M('нет from', 'no from') }); continue; }
      const fields = isStr(e.field) ? [e.field] : TEXT_FIELDS;
      let hits = 0;
      for (const t of targets) for (const f of fields) {
        if (typeof t[f] !== 'string') continue;
        const n = t[f].split(e.from).length - 1;
        if (!n) continue;
        if (e.scope !== 'all' && n !== 1) { errors.push({ rule: 'edits', where: `${tag} ${f}`, text: M(`«${e.from}» найдено ${n} раз, нужно ровно 1`, `«${e.from}» found ${n} times, exactly 1 needed`) }); continue; }
        t[f] = t[f].split(e.from).join(String(e.to ?? '')); hits += n;
      }
      if (!hits) errors.push({ rule: 'edits', where: tag, text: M(`«${String(e.from).slice(0, 60)}» не найдено`, `«${String(e.from).slice(0, 60)}» not found`) });
      else log.push(`${tag}: ${M('замен', 'replaced')} ${hits}`);
    } else errors.push({ rule: 'edits', where: tag, text: M(`неизвестная операция ${e.op}`, `unknown op ${e.op}`) });
  }
  return { log, dropped, pinned };
}
function renumber(items) {
  sortItems(items);
  const map = {}; const cnt = [0, 0, 0, 0];
  for (const it of items) { const nr = `P${it.s}-${String(++cnt[it.s]).padStart(2, '0')}`; if (it.rid && it.rid !== nr) map[it.rid] = nr; it.rid = nr; }
  return map;
}
// rewrite «P1-36» references in strings (one pass); a number of a removed finding becomes ⟦P1-36⟧ (self-check error)
function remapRefs(obj, map, removed = new Set()) {
  if (!obj || (!Object.keys(map).length && !removed.size)) return obj;
  const walk = v => {
    if (typeof v === 'string') return v.replace(RID_RE, m => map[m] || (removed.has(m) ? `⟦${m}⟧` : m));
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(obj);
}
function remapItems(items, map, removed) {
  if (!Object.keys(map).length && !removed.size) return;
  for (const it of items) for (const k of TEXT_FIELDS) if (typeof it[k] === 'string') it[k] = remapRefs(it[k], map, removed);
}
// lens ids («mobile-03») → numbers of this report, for scores and strategy written before finalize
const LENS_ID_RE = /(?<![\w-])(?:product|facts|visitor|ux|visual|typography|color|mobile|a11y|copy|seo-tech|seo-content|perf|stability|forms|security|privacy|legal|ecommerce|i18n|health|seo)-(?:r2-|v)?\d{2,3}(?![\w-])/g;
function idsToRids(obj, idToRid, unknown) {
  if (!obj) return obj;
  const walk = v => {
    if (typeof v === 'string') return v.replace(LENS_ID_RE, m => { const r = idToRid.get(m); if (!r) unknown.add(m); return r || m; });
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(obj);
}

// ---------------------------------------------------------------- page names, places, words
function pagesIndex(run) {
  const pj = readMaybe(join(run, 'pages.json'), {}) || {};
  const map = new Map();
  for (const p of arr(pj.selected)) if (p && p.pid) map.set(p.pid, p);
  return { map, doc: pj };
}
function pageLabel(pages, pid, url) {
  if (pid === 'home') return tr('home');
  const p = pages.map.get(pid);
  let t = p && isStr(p.title) ? p.title : '';
  if (t) t = t.split(/\s+[|—–·]\s+|\s+-\s+/)[0].trim();
  if (t && t.length > 48) t = t.slice(0, 46).trimEnd() + '…';
  return t || shortPath(url || p?.url || '') || pid || '';
}
function vpLabel(v) {
  const s = String(v ?? '').trim();
  if (!s || s === 'all') return '';
  if (/^\d+x\d+$/i.test(s)) return s.replace(/x/i, '×') + ' px';
  return /^\d+$/.test(s) ? `${s} px` : s;
}
function whoWord(owner, platform) {
  const o = String(owner || '').toLowerCase();
  if (!o) return '';
  const x = CUR_AUD === 'external' ? '_external' : CUR_AUD === 'team' ? '_team' : '';
  if (/cms|владелец в|конструктор/.test(o)) return isStr(platform) && !/^custom$/i.test(platform) ? tr('who.cms' + x, { platform }) : tr('who.cms_generic' + x);
  if (/разраб|dev/.test(o)) return tr('who.dev');
  if (/копирайт|copy/.test(o)) return tr('who.copy');
  if (/внешн|extern/.test(o)) return tr('who.ext');
  if (/решени|decision/.test(o)) return tr('who.decision');
  return String(owner);
}
function effortWord(e, aud) {
  if (!/^[SML]$/.test(String(e))) return '';
  const w = tr(`effort_words.${e}`) || '';
  return aud === 'team' ? `${e} · ${w}` : w;
}
function methodWord(m) {
  const k = String(m || '').split(':')[0].toLowerCase();
  return tr(`methods.${k}`) || String(m || '');
}
const NORM_FOR_PEOPLE = /(WCAG|ФЗ|закон|GDPR|ГОСТ|ст\.\s*\d|Article|EAA|ADA|CCPA|152|38-ФЗ)/i;

// ---------------------------------------------------------------- crops
function shotIndex(dir, cache) {
  if (cache.has(dir)) return cache.get(dir);
  const ix = readMaybe(join(dir, 'index.json'), null);
  const list = Array.isArray(ix) ? ix : [];
  cache.set(dir, list);
  return list;
}
// → { src (abs), srcRel, rect [x,y,w,h] img px, frame|null, outW, key, viewport, kind } | { error }
// where.crop from finalize.mjs ({ shot, box } in image px) is used first: one calculation for all.
// aspect (h/w) and outW force the size: two crops with the same aspect and outW have the same height.
function planCrop(run, w0, idxCache, { maxOut = 1000, aspect = null, outW: forceOut = null } = {}) {
  let w = w0 || {};
  if (w.crop && isStr(w.crop.shot) && validBox(w.crop.box)) w = { ...w, shot: w.crop.shot, box: w.crop.box, box_space: 'image' };
  let rel = isStr(w.shot) ? String(w.shot).replace(/\\/g, '/').replace(/^\.?\//, '') : null;
  const vpNum = /^\d+/.test(String(w.viewport || '')) ? Number(String(w.viewport).match(/^\d+/)[0]) : null;
  const box = validBox(w.box) ? w.box.map(Number) : null;
  const boxImage = w.box_space === 'image';
  let entry = null;
  // no shot named: look in snapshot/<pid>/shots/index.json for this width
  if (!rel && isStr(w.pid) && vpNum) {
    const dir = join(run, 'snapshot', w.pid, 'shots');
    const entries = shotIndex(dir, idxCache).filter(e => e.width === vpNum && e.kind !== 'inner');
    if (entries.length) rel = `snapshot/${w.pid}/shots/${(entries.find(e => e.kind === 'fold') || entries[0]).file}`;
  }
  if (!rel) return { error: M('нет кадра', 'no shot') };
  let abs;
  try { abs = U.insideRun(run, rel); } catch { return { error: M(`кадр вне папки прогона: ${rel}`, `shot outside the run folder: ${rel}`) }; }
  const dir = dirname(abs);
  const all = shotIndex(dir, idxCache);
  entry = all.find(e => e.file === basename(abs)) || null;
  // a CSS box may sit better in another shot of the same width (fold has DPR 2; parts cover the rest)
  if (box && !boxImage && all.length) {
    const width = entry?.width || vpNum;
    const same = all.filter(e => e.width === width && e.kind !== 'inner');
    const contains = e => box[1] >= e.y0 - 1 && box[1] + box[3] <= e.y1 + 1;
    const pref = ['fold', 'full', 'part'];
    const exists = e => existsSync(join(dir, e.file));
    let best = entry && contains(entry) && exists(entry) ? entry : null;
    if (!best) best = same.filter(e => contains(e) && exists(e)).sort((a, b) => pref.indexOf(a.kind) - pref.indexOf(b.kind))[0] || null;
    if (!best) best = same.filter(e => box[1] >= e.y0 && box[1] < e.y1 && exists(e)).sort((a, b) => pref.indexOf(a.kind) - pref.indexOf(b.kind))[0] || null;
    if (best && best !== entry) { entry = best; abs = join(dir, best.file); rel = fwd(relative(run, abs)); }
  }
  let imgW = entry?.img_w, imgH = entry?.img_h;
  if ((!imgW || !imgH) && existsSync(abs)) { try { const sz = imageSize(abs); if (sz) { imgW = sz.w; imgH = sz.h; } } catch {} }
  if (!imgW || !imgH) return { error: M(`кадра нет на диске: ${rel}`, `shot missing on disk: ${rel}`), srcRel: rel, missing: true, key: null };
  const scale = entry?.scale || (vpNum ? imgW / vpNum : 1);
  const y0 = entry && entry.kind !== 'inner' ? entry.y0 || 0 : 0;
  const cssW = vpNum || entry?.width || Math.round(imgW / scale);
  const mobile = cssW <= 480;
  let frame = null;
  if (box) frame = boxImage ? box : [box[0] * scale, (box[1] - y0) * scale, box[2] * scale, box[3] * scale];
  if (frame && (frame[0] >= imgW || frame[1] >= imgH || frame[0] + frame[2] <= 0 || frame[1] + frame[3] <= 0)) return { error: M(`рамка за пределами кадра ${rel}`, `box outside the shot ${rel}`), srcRel: rel };
  const ctxW = Math.min(imgW, (mobile ? cssW : 600) * scale);
  let rect;
  if (frame) {
    const pad = Math.max(16, Math.min(120, 0.3 * Math.max(frame[2], frame[3]) / scale)) * scale;
    let rw = Math.min(imgW, Math.max(frame[2] + 2 * pad, ctxW));
    let rh;
    if (aspect) { rh = rw * aspect; if (rh > imgH) { rh = imgH; rw = Math.min(imgW, rh / aspect); } }
    else {
      const maxH = Math.min(imgH, rw * (mobile ? 1.6 : 0.85));
      const minH = Math.min(imgH, rw * (mobile ? 0.55 : 0.32));
      rh = Math.max(minH, Math.min(maxH, frame[3] + 2 * pad));
    }
    const rx = Math.max(0, Math.min(imgW - rw, frame[0] + frame[2] / 2 - rw / 2));
    let ry = frame[3] + 2 * pad > rh ? frame[1] - pad : frame[1] + frame[3] / 2 - rh / 2;
    ry = Math.max(0, Math.min(imgH - rh, ry));
    rect = [rx, ry, rw, rh].map(Math.round);
  } else {
    let rw = imgW; let rh = Math.min(imgH, Math.round(rw * (aspect || (mobile ? 1.5 : 0.62))));
    if (aspect && rw * aspect > imgH) rw = Math.min(imgW, Math.round(imgH / aspect));
    rect = [0, 0, rw, rh].map(Math.round);
  }
  const outW = forceOut ? Math.round(forceOut) : Math.min(maxOut, rect[2]);
  const kind = entry?.kind || (/fold/.test(rel) ? 'fold' : 'full');
  const key = sha(JSON.stringify({ v: CROP_VERSION, rel, rect, frame: frame && frame.map(n => Math.round(n)), outW }));
  return { src: abs, srcRel: rel, rect, frame: frame && frame.map(n => Math.round(n)), outW, key, cssW, kind, viewport: vpNum || cssW };
}

async function makeCrops(ctx, jobs) {
  // jobs: [{ key, src, rect, frame, outW }] — cached in report/img/index.json
  const imgDir = U.insideRun(ctx.run, 'report', 'img');
  U.ensureDir(imgDir);
  const idxPath = join(imgDir, 'index.json');
  const index = readMaybe(idxPath, {}) || {};
  const todo = [];
  for (const j of jobs) {
    const file = `c-${j.key}.jpg`;
    j.file = join(imgDir, file);
    const st = existsSync(j.src) ? statSync(j.src) : null;
    const rec = index[j.key];
    const fresh = rec && existsSync(j.file) && (!st || (rec.size === st.size && Math.abs((rec.mtime || 0) - st.mtimeMs) < 2));
    // --recrop: a crop made since this --recrop run began (also before a time-budget stop) counts as fresh
    const recropped = !ctx.recrop || (rec && (rec.made || 0) >= ctx.recropSince);
    if (fresh && recropped) { j.cached = true; continue; }
    if (!st) { if (existsSync(j.file)) { j.cached = true; continue; } j.error = M('нет кадра', 'no shot'); continue; }
    todo.push(j);
  }
  if (todo.length) {
    const page = await ctx.toolPage();
    if (!page) { for (const j of todo) j.error = M('браузер не запустился', 'browser did not start'); }
    else {
      const bySrc = new Map();
      for (const j of todo) { if (!bySrc.has(j.src)) bySrc.set(j.src, []); bySrc.get(j.src).push(j); }
      for (const [src, list] of bySrc) {
        if (Date.now() > ctx.deadline) { ctx.partial = true; break; }
        const ext = extname(src).toLowerCase();
        const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        const du = `data:${mime};base64,${readFileSync(src).toString('base64')}`;
        let res;
        try {
          res = await page.evaluate(async (src, jobs, q) => {
            const img = new Image();
            await new Promise((ok, no) => { img.onload = ok; img.onerror = () => no(new Error('image load failed')); img.src = src; });
            return jobs.map(j => {
              const [rx, ry, rw, rh] = j.rect; const k = j.outW / rw;
              const c = document.createElement('canvas');
              c.width = Math.max(1, Math.round(rw * k)); c.height = Math.max(1, Math.round(rh * k));
              const g = c.getContext('2d');
              g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
              g.drawImage(img, rx, ry, rw, rh, 0, 0, c.width, c.height);
              if (j.frame) {
                const [fx, fy, fw, fh] = j.frame; const lw = 3;
                g.strokeStyle = '#d93025'; g.lineWidth = lw;
                g.strokeRect((fx - rx) * k - lw / 2, (fy - ry) * k - lw / 2, fw * k + lw, fh * k + lw);
              }
              return c.toDataURL('image/jpeg', q);
            });
          }, du, list.map(j => ({ rect: j.rect, frame: j.frame, outW: j.outW })), 0.6);
        } catch (e) { for (const j of list) j.error = e.message; continue; }
        const st = statSync(src);
        list.forEach((j, i) => {
          const d = res[i]; if (!d) { j.error = M('пустой кроп', 'empty crop'); return; }
          writeFileSync(j.file, Buffer.from(d.slice(d.indexOf(',') + 1), 'base64'));
          index[j.key] = { file: basename(j.file), src: fwd(relative(ctx.run, src)), size: st.size, mtime: st.mtimeMs, rect: j.rect, made: Date.now() };
          j.made = true;
        });
      }
    }
  }
  U.writeJSON(idxPath, index);
  return jobs;
}

// ---------------------------------------------------------------- browser (one per run of report.mjs)
function browserCtx(ctx) {
  const st = { b: null, release: null, page: null, failed: null };
  return {
    async browser() {
      if (st.b || st.failed) return st.b;
      try {
        const { Browser } = await import('./lib/cdp.mjs');
        const t = Date.now();
        U.progress(M('report.mjs: жду свободный слот браузера (не больше 2 на машину)…', 'report.mjs: waiting for a browser slot (max 2 per machine)…'));
        // never wait past the time budget: the caller then stops with code 75 and the rerun continues
        try { st.release = await U.acquireBrowserSlot({ waitMs: Math.max(10000, ctx.deadline - Date.now()) }); }
        catch (e) { ctx.partial = true; throw e; }
        if (Date.now() - t > 3000) U.progress(`report.mjs: ${M('слот получен через', 'slot after')} ${Math.round((Date.now() - t) / 1000)} s`);
        st.b = await Browser.launch();
      } catch (e) { st.failed = e.message; if (st.release) { st.release(); st.release = null; } }
      return st.b;
    },
    async toolPage() {
      if (st.page) return st.page;
      const b = await this.browser();
      if (!b) return null;
      st.page = await b.newPage({ blockNavigation: true });
      return st.page;
    },
    error() { return st.failed; },
    async close() {
      try { if (st.b) await st.b.close(); } catch {}
      st.b = null; st.page = null;
      if (st.release) { st.release(); st.release = null; }
    },
  };
}

const OPEN_DETAILS = "document.querySelectorAll('details').forEach(d => { d.open = true; })";
// report shots: full height in slices via clip+scale (390 → 600 px wide, 1800 CSS px per slice; 1440 → 1000 px, 1600 CSS px),
// all <details> open (the editor must see the tables); PDF sheets: the same fragmentation engine (multi-column
// boxes of the A4 printable area, print media) — the count is compared with the real PDF
async function shootReport(ctx, htmlPath, prefix, { pdfPath = null, dark = true } = {}) {
  const b = await ctx.br.browser();
  if (!b) return { error: ctx.br.error() || M('браузер не запустился', 'browser did not start') };
  const shotsDir = U.ensureDir(U.insideRun(ctx.run, 'report', 'shots'));
  // a rerun after a time-budget stop at this stage keeps the pieces already shot of the same HTML (and the PDF);
  // otherwise old pieces go. Every run makes at least one new piece, so reruns always advance.
  let hash = ''; try { hash = createHash('sha1').update(readFileSync(htmlPath)).digest('hex'); } catch {}
  const rs = ctx.resumeShots;
  const resume = !!(rs && hash && rs.hash === hash && rs.prefix === prefix);
  const prog = ctx.shotProg = { prefix, hash, pdf: !!(resume && rs.pdf && pdfPath && existsSync(pdfPath)), made: 0, kept: 0 };
  ctx.shotsLate = () => prog.made > 0 && Date.now() > ctx.deadline;
  if (!resume) for (const f of readdirSync(shotsDir)) if (f.startsWith(prefix + '-') && /\.(jpg|png)$/.test(f)) rmSync(join(shotsDir, f), { force: true });
  const have = f => { if (resume && existsSync(f)) { prog.kept++; return true; } return false; };
  const page = await b.newPage({ blockNavigation: true });
  const out = { files: [], pdfPages: null, sheets: null };
  const url = pathToFileURL(htmlPath).href;
  try {
    const plan = [
      { w: 390, h: 844, mobile: true, outW: 600, part: 1800, name: `${prefix}-390` },
      { w: 1440, h: 900, mobile: false, outW: 1000, part: 1600, name: `${prefix}-1440` },
    ];
    for (const p of plan) {
      if (ctx.shotsLate()) { ctx.partial = true; break; }
      await page.setViewport({ width: p.w, height: p.h, mobile: p.mobile, deviceScaleFactor: 1, touch: p.mobile });
      await page.emulateMedia({ colorScheme: 'light' });
      await page.goto(url, { allowRisky: true, waitUntil: 'load', timeout: 30000 });
      await page.evaluate(OPEN_DETAILS);
      // a phone must not scroll sideways: the template keeps every block inside 390 px
      if (p.mobile) out.overflow390 = await page.evaluate('Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth)').catch(() => null);
      // height to shoot: up to the last block of <main> + 24 px (main's bottom padding alone made a blank last part)
      const H = Math.min(60 * p.part, await page.evaluate(`(() => {
        const sh = Math.ceil(document.documentElement.scrollHeight), last = document.querySelector('main')?.lastElementChild;
        return last ? Math.min(sh, Math.ceil(last.getBoundingClientRect().bottom + scrollY + 24)) : sh;
      })()`));
      const scale = p.outW / p.w;
      const minTail = Math.round(p.part / 4); // a shorter remainder joins the previous part instead of its own strip
      for (let y = 0, k = 1, ph; y < H; y += ph, k++) {
        ph = H - y - p.part < minTail ? H - y : p.part;
        const f = join(shotsDir, `${p.name}.part-${String(k).padStart(2, '0')}.jpg`);
        if (!have(f)) {
          if (ctx.shotsLate()) { ctx.partial = true; break; }
          await page.screenshot({ path: f, clip: { x: 0, y, width: p.w, height: ph, scale }, format: 'jpeg', quality: 72 });
          prog.made++;
        }
        out.files.push(f);
      }
      if (ctx.partial) break;
      const fd = join(shotsDir, `${p.name}-dark.part-01.jpg`);
      if (p.mobile && dark && have(fd)) out.files.push(fd);
      else if (p.mobile && dark) { // dark theme check: first slice only
        if (ctx.shotsLate()) { ctx.partial = true; break; }
        await page.emulateMedia({ colorScheme: 'dark' });
        const f = fd; prog.made++;
        await page.screenshot({ path: f, clip: { x: 0, y: 0, width: p.w, height: Math.min(p.part, H), scale }, format: 'jpeg', quality: 72 });
        out.files.push(f);
        await page.emulateMedia({ colorScheme: 'light' });
      }
    }
    if (pdfPath && !ctx.partial && !prog.pdf && ctx.shotsLate()) ctx.partial = true;
    if (pdfPath && !ctx.partial) {
      await page.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      await page.send('Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      let buf;
      if (prog.pdf) buf = readFileSync(pdfPath);
      else {
        await page.emulateMedia({ colorScheme: 'light' });
        await page.goto(url, { allowRisky: true, waitUntil: 'load', timeout: 30000 });
        await page.evaluate(OPEN_DETAILS);
        buf = await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
        prog.pdf = true; prog.made++;
      }
      Object.assign(out, pdfInfo(buf));
      out.sheets = await shootSheets(page, url, shotsDir, prefix, out.files, ctx, have);
      await page.emulateMedia({});
    }
  } catch (e) { out.error = e.message; }
  finally { await page.close(); }
  return out;
}
function pdfInfo(buf) {
  const t = buf.toString('latin1');
  const pages = (t.match(/\/Type\s*\/Page(?![s\w])/g) || []).length || null;
  const boxes = [...t.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/g)];
  return { pdfPages: pages, pdfSizeOk: boxes.length ? boxes.every(m => Number(m[1]) <= 596 && Number(m[2]) <= 843) : null };
}
async function shootSheets(page, url, shotsDir, prefix, files, ctx, have = () => false) {
  const G = 46; // gap between sheets ≈ the 12 mm side margin: overflow past the sheet edge stays visible
  await page.setViewport({ width: Math.ceil(PAGE_W), height: Math.ceil(PAGE_H), mobile: false, deviceScaleFactor: 1 });
  await page.emulateMedia({ printMedia: true, colorScheme: 'light' });
  await page.goto(url, { allowRisky: true, waitUntil: 'load', timeout: 30000 });
  const n = await page.evaluate(`(() => {
    ${OPEN_DETAILS};
    const s = document.createElement('style');
    s.textContent = 'html,body{margin:0!important;padding:0!important;background:#fff!important;overflow:visible!important;height:auto!important}' +
      'main{column-width:${PAGE_W}px;column-gap:${G}px;column-fill:auto;height:${PAGE_H}px;width:${PAGE_W}px;max-width:none!important;margin:0!important;padding:0!important;box-sizing:content-box}';
    document.head.appendChild(s);
    const m = document.querySelector('main');
    return Math.max(1, Math.round((m.scrollWidth + ${G}) / (${PAGE_W} + ${G})));
  })()`);
  const count = Math.min(Number(n) || 1, 80);
  for (let k = 0; k < count; k++) {
    const x = Math.max(0, k * (PAGE_W + G) - G / 2);
    const f = join(shotsDir, `${prefix}-pdf.part-${String(k + 1).padStart(2, '0')}.jpg`);
    if (have(f)) { files.push(f); continue; }
    if (ctx.shotsLate()) { ctx.partial = true; break; }
    if (ctx.shotProg) ctx.shotProg.made++;
    await page.screenshot({ path: f, clip: { x, y: 0, width: PAGE_W + (k ? G : G / 2), height: PAGE_H, scale: 1 }, format: 'jpeg', quality: 72 });
    files.push(f);
  }
  return count;
}

// ---------------------------------------------------------------- log.md: «Что отправлялось во внешние сервисы»
function externalFromLog(run) {
  const p = join(run, 'log.md');
  if (!existsSync(p)) return { rows: [], text: '' };
  const text = readFileSync(p, 'utf8');
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/\[external\]\s+(.+?)\s+·\s+(.+?)\s+·\s+(\d+)\s*$/);
    if (!m) continue;
    const r = rows.get(m[1]) || { service: m[1], what: new Set(), count: 0 };
    r.what.add(m[2]); r.count += Number(m[3]) || 0; rows.set(m[1], r);
  }
  const list = [...rows.values()].map(r => ({ service: r.service, what: [...r.what].slice(0, 3).join('; ') + (r.what.size > 3 ? ` (+${r.what.size - 3})` : ''), count: r.count }));
  return { rows: list, text };
}
// scripts log their calls in log.md; agents' requests (WebSearch/WebFetch…) come from the editor in
// summary.external_services — one table, one row per service, «what» joined without repeats.
// log.md is the only source for what scripts sent: a summary line about a service already in the log
// is the editor restating it and is skipped (otherwise the table shows every script service twice).
// Summary lines: «service · what · N» (the editor checklist format), legacy «service — what» / «service: what», or objects.
function parseExternalLine(x) {
  if (typeof x !== 'string') {
    const n = Number.isFinite(Number(x?.count)) && x?.count !== null && x?.count !== '' ? Number(x.count) : null;
    return { service: String(x?.service || x?.name || ''), what: String(x?.what || x?.text || ''), count: n };
  }
  const s = x.trim();
  const dot = s.split(/\s+·\s+/);
  if (dot.length >= 2) {
    const last = dot[dot.length - 1].match(/^(\d+)(?:\s*(?:раз[а]?|запрос\S*|requests?|times?))?$/i);
    const mid = last ? dot.slice(1, -1) : dot.slice(1);
    return { service: dot[0], what: mid.join(' · '), count: last ? Number(last[1]) : null };
  }
  const service = s.split(/\s+[—–-]\s+|:\s+/)[0];
  return { service, what: s.slice(service.length).replace(/^\s*(?:[—–-]|:)\s*/, ''), count: null };
}
function mergeExternal(logRows, summaryList) {
  const key = s => String(s || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\s*\([^)]*\)\s*$/, '').replace(/[\s/]+$/, '').trim();
  const rows = new Map(logRows.map(r => [key(r.service), { service: r.service, what: r.what ? [r.what] : [], count: r.count, fromLog: true }]));
  for (const x of arr(summaryList)) {
    const { service, what, count: n } = parseExternalLine(x);
    if (!isStr(service)) continue;
    const k = key(service);
    if (rows.get(k)?.fromLog) continue;
    const r = rows.get(k) || { service: service.trim(), what: [], count: null };
    if (isStr(what) && !r.what.some(w => w.toLowerCase().includes(what.toLowerCase().trim()))) r.what.push(what.trim());
    if (n !== null) r.count = (r.count ?? 0) + n;
    rows.set(k, r);
  }
  return [...rows.values()].map(r => ({ service: r.service, what: r.what.join('; '), count: r.count }));
}
function writeLogSection(run, rows, lang) {
  const p = join(run, 'log.md');
  let text = existsSync(p) ? readFileSync(p, 'utf8') : '';
  text = text.replace(/\n?<!-- revizor:external -->[\s\S]*?<!-- \/revizor:external -->\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  const head = lang === 'en' ? '## Sent to external services' : '## Что отправлялось во внешние сервисы';
  const body = rows.length
    ? [`| ${lang === 'en' ? 'Service' : 'Сервис'} | ${lang === 'en' ? 'What' : 'Что'} | ${lang === 'en' ? 'Requests' : 'Запросов'} |`, '|---|---|---|',
      ...rows.map(r => `| ${r.service} | ${String(r.what || '').replace(/\|/g, '/')} | ${r.count ?? '—'} |`)].join('\n')
    : (lang === 'en' ? 'Nothing was sent.' : 'Ничего не отправлялось.');
  text = text.replace(/\s*$/, '\n') + `\n<!-- revizor:external -->\n${head}\n\n${body}\n<!-- /revizor:external -->\n`;
  U.writeText(p, text);
}

// ---------------------------------------------------------------- HTML pieces
function sevLabel(s, aud, { withCode = true } = {}) {
  const words = tr(`sev.${aud}`) || tr('sev.owner');
  if (aud === 'owner' && withCode) return `${words[s]} (P${s})`;
  return words[s];
}
function section(id, title, inner, { count = null } = {}) {
  if (!inner) return '';
  return `<section class="block" id="${esc(id)}"><h2>${esc(title)}${count !== null ? ` <span class="cnt">${esc(count)}</span>` : ''}</h2>\n${inner}\n</section>\n`;
}
function ridLink(rid, known) {
  if (!isStr(rid)) return '';
  return known.has(rid) ? `<a class="rid" href="#${esc(rid)}">${esc(rid)}</a>` : `<span class="rid">${esc(rid)}</span>`;
}
function ulist(items, render, cls = 'list-plain') {
  const li = arr(items).map(render).filter(Boolean);
  return li.length ? `<ul class="${cls}">${li.map(x => `<li>${x}</li>`).join('')}</ul>` : '';
}

function whereHtml(it, ctx, { max = 3, selector = false } = {}) {
  const ws = it.where;
  const parts = ws.slice(0, max).map(w => {
    const href = safeHref(w.url);
    const label = pageLabel(ctx.pages, w.pid, w.url);
    const path = href ? shortPath(href) : '';
    const bits = [];
    const lab = `<span class="site">${esc(label)}</span>${path && path !== '/' && label !== path ? ` <span class="nowrap">${esc(path)}</span>` : ''}`;
    bits.push(href ? `<a href="${esc(href)}" rel="noopener noreferrer">${lab}</a>` : lab);
    if (isStr(w.block)) bits.push(esc(w.block));
    if (vpLabel(w.viewport)) bits.push(esc(vpLabel(w.viewport)));
    if (isStr(w.state) && !/^загрузка$|^load$/i.test(w.state)) bits.push(esc(w.state));
    if (selector && isStr(w.selector)) bits.push(`<code>${esc(w.selector)}</code>`);
    return bits.join(' · ');
  });
  let s = parts.join('<br>');
  if (ws.length > max) s += `<br>${esc(tr('card.more_places', { n: ws.length - max }))}`;
  const extra = [];
  if (it.sitewide) extra.push(tr('card.sitewide'));
  if (typeof it.pages_affected_estimate === 'number') extra.push(tr('card.pages_est', { n: it.pages_affected_estimate }));
  if (extra.length) s += (s ? ' · ' : '') + esc(extra.join(', '));
  return s;
}
function whereText(it, ctx, max = 5) {
  const lines = it.where.slice(0, max).map(w => [w.url || pageLabel(ctx.pages, w.pid, w.url), w.block, vpLabel(w.viewport), isStr(w.state) && !/^загрузка$|^load$/i.test(w.state) ? w.state : ''].filter(isStr).join(' · '));
  if (it.where.length > max) lines.push(tr('card.more_places', { n: it.where.length - max }));
  if (it.sitewide) lines.unshift(tr('all_site'));
  return lines.join('\n');
}

function figureHtml(crop, ctx, w, { label = null } = {}) {
  if (!crop || !crop.file || crop.error) return '';
  const src = ctx.imgSrc(crop.file);
  if (!src) return '';
  const sz = (() => { try { return imageSize(crop.file); } catch { return null; } })();
  const page = w ? pageLabel(ctx.pages, w.pid, w.url) : '';
  const tail = [vpLabel(crop.viewport || w?.viewport), crop.kind === 'fold' ? tr('card.fold') : ''].filter(isStr).join(' · ');
  const mobile = Number(crop.viewport || crop.cssW || 9999) <= 480;
  const cap = [label ? `<b>${esc(label)}</b>` : '', page ? `<span class="site">${esc(page)}</span>` : '', tail ? esc(tail) : ''].filter(Boolean).join(' · ');
  const alt = [label || tr('card.shot'), [page, tail].filter(isStr).join(' · ')].filter(isStr).join(': ');
  return `<figure class="fig${mobile ? ' fig-m' : ''}"><img src="${src}" alt="${esc(alt)}"${sz ? ` width="${sz.w}" height="${sz.h}"` : ''}>${cap ? `<figcaption>${cap}</figcaption>` : ''}</figure>`;
}
function evidenceHtml(it, ctx, gl, scope) {
  const ev = it._ev || splitEvidence(it.evidence);
  if (ctx.aud === 'external') return ev.hidden ? '' : rich(ev.fact, gl, scope);
  return rich(ev.fact, gl, scope) + (ev.source ? `<p class="src">${esc(ev.source)}</p>` : '');
}

function cardHtml(it, ctx) {
  const aud = ctx.aud; const gl = ctx.gl; const scope = new Set();
  const figs = ctx.cropsFor(it).slice(0, 2).map(c => figureHtml(c.crop, ctx, c.w)).filter(Boolean);
  const pair = ctx.pairFor ? ctx.pairFor(it) : null;
  const who = whoWord(it.owner, ctx.platform);
  const eff = effortWord(it.effort, aud);
  const headRight = [who && `${tr('card.who')}: ${who}`, eff && `${tr('card.effort')}: ${eff}`].filter(Boolean).join(' · ');
  const flags = [];
  if (it.needs_decision) flags.push(`<span class="flag warn">${esc(tr('card.decision'))}</span>`);
  if (aud !== 'external' && it.needs_device_check) flags.push(`<span class="flag warn">${esc(tr('card.device'))}</span>`);
  if (aud !== 'external' && (it.verdict === 'unverified' || it.requires_check) && it.s <= 1) flags.push(`<span class="flag warn">${esc(tr('card.unverified'))}</span>`);
  const f = (cls, label, html) => (html ? `<div class="f ${cls}"><b>${esc(label)}</b>${html}</div>` : '');
  let txt = `<div class="where">${whereHtml(it, ctx, { selector: aud === 'team' })}</div>`;
  txt += f('f-problem', tr('card.problem'), rich(it.problem, gl, scope));
  txt += f('f-evidence', tr('card.evidence'), evidenceHtml(it, ctx, gl, scope));
  txt += f('f-impact', tr('card.impact'), rich(it.impact, gl, scope));
  if (aud === 'team') txt += f('f-scenario', tr('card.scenario'), rich(it.scenario, gl, scope));
  txt += f('f-fix', tr('card.fix'), rich(it.fix, gl, scope));
  if (isStr(it.before) || isStr(it.after)) {
    txt += `<div class="pair">${isStr(it.before) ? `<div class="was site"><b>${esc(tr('card.before'))}</b>${rich(it.before, null, null)}</div>` : '<div></div>'}` +
      `${isStr(it.after) ? `<div class="now"><b>${esc(tr('card.after'))}</b>${rich(it.after, gl, scope)}</div>` : '<div></div>'}</div>`;
  }
  if (it.fix_verified) txt += `<p class="verified">${esc(tr('card.verified'))}${aud === 'team' && isStr(it.fix_check) ? `: <code>${esc(it.fix_check)}</code>` : ''}</p>`;
  const tech = [];
  if (aud === 'owner') {
    if (isStr(it.method)) tech.push(`${tr('card.method')}: ${esc(methodWord(it.method))}`);
    if (isStr(it.norm)) tech.push(`${tr('card.norm')}: ${plain(it.norm, gl, scope)}`);
    if (isStr(it.verdict) && tr(`verdict.${it.verdict}`)) tech.push(`${tr('card.verdict')}: ${esc(tr(`verdict.${it.verdict}`))}`);
  } else if (aud === 'team') {
    if (isStr(it.method)) tech.push(`${tr('card.method')}: <code>${esc(it.method)}</code>`);
    if (isStr(it.norm)) tech.push(`${tr('card.norm')}: ${plain(it.norm, gl, scope)}`);
    if (isStr(it.confidence)) tech.push(`${tr('card.confidence')}: ${esc(tr(`confidence.${it.confidence}`) || it.confidence)}`);
    if (isStr(it.verdict)) tech.push(`${tr('card.verdict')}: ${esc(tr(`verdict.${it.verdict}`) || it.verdict)}`);
    if (it.lenses.length) tech.push(`${tr('card.lenses')}: ${esc(it.lenses.join(', '))}`);
    const trail = arr(it.severity_trail).filter(x => x && x.from !== x.to).map(x => `${x.from}→${x.to}${x.by ? ` (${x.by})` : ''}`);
    if (trail.length) tech.push(`${tr('card.trail')}: ${esc(trail.join(', '))}`);
    if (isStr(it.uid)) tech.push(`uid: <code>${esc(it.uid)}</code>`);
  } else if (isStr(it.norm) && NORM_FOR_PEOPLE.test(it.norm)) tech.push(`${tr('card.norm')}: ${plain(it.norm, gl, scope)}`);
  const body = figs.length ? `<div class="body"><div class="txt">${txt}</div><div class="pics">${figs.join('')}</div></div>` : `<div class="body"><div class="txt">${txt}</div></div>`;
  const pairHtml = pair ? `<div class="shotpair">${figureHtml(pair.before.crop, ctx, pair.before.w, { label: tr('card.fix_pair_before') })}${figureHtml(pair.after.crop, ctx, pair.after.w, { label: tr('card.fix_pair_after') })}</div>` : '';
  return `<article class="card s${it.s}${figs.length ? ' has-img' : ''}" id="${esc(it.rid)}">` +
    `<div class="head"><span class="sev s${it.s}">${esc(sevLabel(it.s, aud, { withCode: false }))}</span><a class="rid" href="#${esc(it.rid)}">${esc(it.rid)}</a>${headRight ? `<span class="who">${esc(headRight)}</span>` : ''}</div>` +
    `<h3>${plain(it.title, gl, scope)}</h3>${flags.length ? `<div class="flags">${flags.join('')}</div>` : ''}${body}${pairHtml}` +
    `${tech.length ? `<div class="tech">${tech.map(x => `<span>${x}</span>`).join('')}</div>` : ''}</article>`;
}

function rowsTable(items, ctx, { sevCol = false } = {}) {
  const gl = ctx.gl;
  const th = [tr('cols.rid'), ...(sevCol ? [tr('cols.sev')] : []), tr('cols.what'), tr('cols.where'), tr('cols.fix'), tr('cols.who')];
  const rows = items.map(it => {
    const scope = new Set();
    const tds = [`<td class="c-rid"><a class="rid" href="#${esc(it.rid)}">${esc(it.rid)}</a></td>`];
    if (sevCol) tds.push(`<td class="c-sev"><span class="sev s${it.s}">${esc(sevLabel(it.s, ctx.aud, { withCode: false }))}</span></td>`);
    tds.push(`<td data-l="${esc(tr('cols.what'))}"><span class="t">${plain(it.title, gl, scope)}</span>${it.needs_decision ? ` <span class="flag warn">${esc(tr('card.decision'))}</span>` : ''}</td>`);
    tds.push(`<td data-l="${esc(tr('cols.where'))}" class="small">${whereHtml(it, ctx, { max: 2 })}</td>`);
    tds.push(`<td data-l="${esc(tr('cols.fix'))}">${rich(it.fix, gl, scope)}${isStr(it.after) ? `<p class="small"><b>${esc(tr('card.after'))}:</b> ${plain(it.after, gl, scope)}</p>` : ''}</td>`);
    tds.push(`<td data-l="${esc(tr('cols.who'))}" class="small">${esc(whoWord(it.owner, ctx.platform))}</td>`);
    return `<tr id="${esc(it.rid)}">${tds.join('')}</tr>`;
  });
  return `<table class="tbl stack"><thead><tr>${th.map(h => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}
function detailsGroup(id, title, count, inner, open = false) {
  return `<details class="group" id="${esc(id)}"${open ? ' open' : ''}><summary>${esc(title)} <span class="cnt">${esc(count)}</span></summary><div class="in">${inner}</div></details>`;
}

// ---------------------------------------------------------------- main report (full / quick)
async function buildMain(run, cfg, ctx) {
  const rep = U.insideRun(run, 'report');
  const fpath = join(rep, 'findings.json');
  if (!existsSync(fpath)) return { fatal: M('Нет report/findings.json — сначала finalize.mjs.', 'report/findings.json not found — run finalize.mjs first.') };
  const fj = readMaybe(fpath, null);
  if (!fj || fj.__error) return { fatal: `report/findings.json: ${fj?.__error || M('не читается', 'unreadable')}` };
  const errors = []; const warnings = cfg.warnings;
  let summary = readMaybe(join(rep, 'summary.json'), null);
  if (!summary || summary.__error) { errors.push({ rule: 'summary', where: 'report/summary.json', text: summary?.__error || M('нет summary.json — редактор пишет его до report.mjs', 'no summary.json — the editor writes it before report.mjs') }); summary = {}; }
  const brief = readMaybe(join(run, 'brief.json'), {}) || {};
  const editorial = readMaybe(join(rep, 'editorial.json'), {}) || {};
  ctx.pages = pagesIndex(run);
  ctx.platform = brief.platform?.name || null;
  ctx.aud = cfg.audience;

  // items
  const original = normItems(fj.items);
  let items = original.map(x => ({ ...x }));
  sortItems(items);
  assignMissingRids(items, warnings);
  const dupe = items.map(i => i.rid).filter((r, i, a) => a.indexOf(r) !== i);
  if (dupe.length) errors.push({ rule: 'rid', where: 'findings.json', text: M(`повторяются номера: ${[...new Set(dupe)].join(', ')}`, `duplicate numbers: ${[...new Set(dupe)].join(', ')}`) });

  // edits.json (recipient comments as data): resolved by uid, rid-only edits get their uid written back
  const numPath = join(rep, 'numbering.json');
  const numbering = readMaybe(numPath, {}) || {};
  const editsPath = join(rep, 'edits.json');
  const edits = readMaybe(editsPath, null);
  let editInfo = { log: [], dropped: [], pinned: [] };
  if (edits && !edits.__error) {
    const list = Array.isArray(edits) ? edits : arr(edits.edits);
    editInfo = applyEdits(items, list, errors, numbering[cfg.audience] && !numbering[cfg.audience].__error ? numbering[cfg.audience] : null);
    if (editInfo.pinned.length) U.writeJSON(editsPath, Array.isArray(edits) ? list : { ...edits, edits: list });
  } else if (edits?.__error) errors.push({ rule: 'edits', where: 'report/edits.json', text: edits.__error });
  const editDropped = new Set(editInfo.dropped.map(d => d.rid));

  // renumbering: --renumber turns it on and it stays on (renumber.json persist), --no-renumber turns it off
  const renPath = join(rep, 'renumber.json');
  const renPrev = readMaybe(renPath, null);
  const doRenumber = cfg.renumber === true || (cfg.renumber === null && !!renPrev && !renPrev.__error && renPrev.persist === true);
  if (cfg.renumber === false && existsSync(renPath)) rmSync(renPath, { force: true });
  let rmap = {};
  if (doRenumber) {
    rmap = renumber(items);
    U.writeJSON(renPath, { generated: U.nowIso(), persist: true, map: rmap, dropped: [...editDropped], by_uid: Object.fromEntries(items.filter(i => isStr(i.uid)).map(i => [i.uid, i.rid])) });
    remapItems(items, rmap, editDropped);
    summary = remapRefs(summary, rmap, editDropped);
  } else if (items.some(i => /^P[0-3]-/.test(i.rid) && Number(i.rid[1]) !== i.s)) {
    warnings.push(M('после правок номер и важность расходятся (например P1-… с важностью P2) — запустите с --renumber', 'after edits numbers and severities disagree (e.g. P1-… with severity P2) — run with --renumber'));
  }
  sortItems(items);

  // audience filter; external is renumbered without gaps (uid stays). external-dropped.json belongs to
  // finalize.mjs (read only); what report.mjs removes itself and the renumbering go to external-view.json
  const extDrop = new Set(arr(editorial.external_drop).map(String));
  const droppedExt = [];
  let emap = {};
  const extPath = join(rep, 'external-dropped.json');
  const viewPath = join(rep, 'external-view.json');
  let finalizeDropped = [];
  if (cfg.audience !== 'external') rmSync(viewPath, { force: true });
  if (cfg.audience === 'external') {
    items = items.filter(it => {
      const why = it.needs_device_check ? 'needs_device_check' : it.confidence === 'low' ? 'confidence_low'
        : (it.verdict === 'unverified' || it.requires_check) && it.s <= 1 ? 'unverified' : it.external_drop || extDrop.has(it.id) || extDrop.has(it.rid) ? 'external_drop' : null;
      if (why) droppedExt.push({ rid: it.rid, uid: it.uid || null, id: it.id || null, title: it.title, why, needs_device_check: !!it.needs_device_check, by: 'report.mjs' });
      return !why;
    });
    const ridGaps = [0, 1, 2, 3].some(s => { const r = items.filter(i => i.s === s).map(i => ridNum(i.rid)); return r.some((n, k) => n !== k + 1); });
    if (droppedExt.length || ridGaps) {
      emap = renumber(items);
      const removed = new Set(droppedExt.map(d => d.rid));
      remapItems(items, emap, removed);
      summary = remapRefs(summary, emap, removed);
    }
    const finExt = readMaybe(extPath, null);
    finalizeDropped = finExt && !finExt.__error ? arr(finExt.items).filter(x => x && typeof x === 'object') : [];
    U.writeJSON(viewPath, { tool: 'report', generated: U.nowIso(), audience: 'external',
      dropped: droppedExt, renumber: emap, uid_to_rid: Object.fromEntries(items.filter(i => isStr(i.uid)).map(i => [i.uid, i.rid])) });
    const devDropped = [...finalizeDropped.filter(x => x.needs_device_check), ...droppedExt.filter(x => x.needs_device_check)];
    if (devDropped.length && !arr(summary.device_checks).length) warnings.push(M(`снятых для заказчика находок «проверить на устройстве»: ${devDropped.length}, а в summary.device_checks нет ни одного совета — добавьте «проверьте…»`, `«check on a device» findings removed for the client: ${devDropped.length}, but summary.device_checks is empty — add advice`));
  }
  const known = new Set(items.map(i => i.rid));
  LINK_RIDS = known;
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const it of items) counts[it.severity]++;

  // evidence: fact + [source]; external sees the fact only, and not even that if it still has traces of the tool
  const hiddenEvidence = [];
  for (const it of items) {
    it._ev = splitEvidence(it.evidence);
    if (cfg.audience === 'external' && (!isStr(it._ev.fact) || hasTrace(it._ev.fact))) { it._ev.hidden = true; if (isStr(it.evidence)) hiddenEvidence.push(it.rid); }
  }
  if (hiddenEvidence.length) warnings.push(M(`«Факт» не показан заказчику у ${hiddenEvidence.join(', ')}: в нём файлы, поля или команды вне [скобок] — линза или редактор переписывает evidence`, `«Fact» hidden from the client in ${hiddenEvidence.join(', ')}: files, fields or commands outside [brackets] — rewrite evidence`));

  // statuses for the registry (--status P0-01="в работе"), kept by uid in statuses.json
  const statuses = setStatuses(rep, cfg, items, errors);

  // scores / strategy / diff: numbers after renumbering, lens ids → numbers
  const idToRid = new Map();
  for (const it of items) for (const id of [it.id, ...arr(it.merged_from)]) if (isStr(id) && !idToRid.has(String(id))) idToRid.set(String(id), it.rid);
  const unknownIds = new Set();
  const scores = cfg.scores ? ['strict', 'market'].map(c => {
    const raw = readMaybe(join(rep, `scores-${c}.json`), null);
    if (!raw || raw.__error) return { c, d: raw };
    const d = idsToRids(remapRefs(raw, rmap, editDropped), idToRid, unknownIds);
    d.top_drivers = arr(d.top_drivers).map(String).filter(r => known.has(r));
    return { c, d };
  }).filter(x => x.d && !x.d.__error) : [];
  if (cfg.scores && !scores.length) warnings.push(M('оценки включены, но report/scores-*.json нет — блок оценок пропущен', 'scores are on, but report/scores-*.json is missing — scores block skipped'));
  let strategy = cfg.audience !== 'external' ? readMaybe(join(rep, 'strategy.json'), null) : null;
  if (strategy && !strategy.__error) strategy = idsToRids(remapRefs(strategy, rmap, editDropped), idToRid, unknownIds);
  if (unknownIds.size) warnings.push(M(`в оценках или стратегии коды без находки в отчёте: ${[...unknownIds].slice(0, 8).join(', ')}`, `codes without a finding in scores or strategy: ${[...unknownIds].slice(0, 8).join(', ')}`));
  const diff = readMaybe(join(rep, 'diff.json'), null);

  // glossary, external services
  const gl = loadGlossary(cfg.lang);
  if (!gl) warnings.push(M('knowledge/glossary.md нет — отчёт без подсказок к терминам', 'knowledge/glossary.md missing — no term hints'));
  ctx.gl = gl;
  const ext = externalFromLog(run);
  ext.rows = mergeExternal(ext.rows, summary.external_services);
  writeLogSection(run, ext.rows, cfg.lang);

  // which findings become cards
  const nonTaste = items.filter(i => !i.taste);
  const taste = items.filter(i => i.taste);
  let cards, groups;
  const g = s => nonTaste.filter(i => i.s === s);
  if (cfg.audience === 'owner') {
    const top = nonTaste.filter(i => i.s <= 1);
    cards = top.slice(0, 30);
    const more = top.slice(30);
    groups = [];
    if (more.length) groups.push({ id: 'grp-more', title: tr('rest_more'), items: more, sev: true });
    for (const s of [2, 3]) if (g(s).length) groups.push({ id: `grp-p${s}`, title: sevLabel(s, 'owner'), items: g(s) });
  } else if (cfg.audience === 'team') {
    cards = nonTaste.filter(i => i.s <= 2);
    groups = g(3).length ? [{ id: 'grp-p3', title: sevLabel(3, 'team'), items: g(3), open: true }] : [];
  } else {
    cards = nonTaste.filter(i => i.s <= 1);
    groups = g(2).length ? [{ id: 'grp-p2', title: sevLabel(2, 'external'), items: g(2) }] : [];
  }
  // a number mentioned outside a collapsed group opens that group (links would land in a closed <details>)
  const referenced = new Set();
  const collect = v => { if (typeof v === 'string') { for (const m of v.matchAll(RID_RE)) referenced.add(m[0]); } else if (Array.isArray(v)) v.forEach(collect); else if (v && typeof v === 'object') Object.values(v).forEach(collect); };
  collect(cfg.audience === 'external' ? { verdict_line: summary.verdict_line, essence: summary.essence, goals_answers: summary.goals_answers, traffic_lights: summary.traffic_lights, strengths: summary.strengths, device_checks: summary.device_checks } : summary);
  for (const it of cards) for (const k of TEXT_FIELDS) collect(it[k]);
  for (const x of scores) collect(x.d.top_drivers);
  if (strategy && !strategy.__error) collect(strategy);
  for (const gr of groups) if (gr.items.some(i => referenced.has(i.rid))) gr.open = true;

  // crops for cards (≤ 60 cards with pictures); verified fixes with fix_shot get a «before / after» pair
  const idxCache = new Map(); const cropJobs = []; const cropMap = new Map(); const pairMap = new Map(); const cropErr = [];
  for (const it of cards.slice(0, 60)) {
    const list = [];
    const withShot = it.where.filter(w => isStr(w.shot) || (w.box && w.pid) || (w.crop && isStr(w.crop.shot)));
    let rest = withShot;
    if (it.fix_verified && isStr(it.fix_shot) && withShot.length) {
      const bw = withShot[0];
      const b0 = planCrop(run, bw, idxCache, { maxOut: 600 });
      if (b0.key) {
        const fw = { shot: it.fix_shot, box: it.fix_box, box_space: it.fix_box_space === 'image' ? 'image' : 'css', viewport: it.fix_viewport || bw.viewport, pid: bw.pid, url: bw.url };
        const a0 = planCrop(run, fw, idxCache, { aspect: b0.rect[3] / b0.rect[2], outW: b0.outW });
        if (a0.key) { pairMap.set(it.rid, { before: { w: bw, crop: b0 }, after: { w: fw, crop: a0 } }); cropJobs.push(b0, a0); rest = withShot.slice(1); }
        else cropErr.push(`${it.rid} fix_shot: ${a0.error}`);
      }
    } else if (it.fix_verified && !isStr(it.fix_shot) && it.s <= 1) ctx.noFixShot = (ctx.noFixShot || 0) + 1;
    for (const w of rest) {
      if (list.length >= 2) break;
      const c = planCrop(run, w, idxCache);
      if (c.error && !c.key) { cropErr.push(`${it.rid}: ${c.error}`); continue; }
      list.push({ w, crop: c }); cropJobs.push(c);
    }
    // mobile crop first: on a phone it goes right under the title
    list.sort((a, b) => (Number(a.crop.viewport) <= 480 ? 0 : 1) - (Number(b.crop.viewport) <= 480 ? 0 : 1));
    cropMap.set(it.rid, list);
  }
  const uniq = [...new Map(cropJobs.map(j => [j.key, j])).values()];
  await makeCrops(ctx, uniq);
  ctx.say(M(`кропы: ${uniq.length}, из кэша ${uniq.filter(j => j.cached).length}`, `crops: ${uniq.length}, cached ${uniq.filter(j => j.cached).length}`));
  const byKey = new Map(uniq.map(u => [u.key, u]));
  const link = c => { const j = byKey.get(c.key); if (j) { c.file = j.file; c.error = j.error; } };
  for (const list of cropMap.values()) for (const x of list) link(x.crop);
  for (const p of pairMap.values()) { link(p.before.crop); link(p.after.crop); }
  for (const j of uniq) if (j.error) cropErr.push(`${j.srcRel}: ${j.error}`);
  if (cropErr.length) warnings.push(M(`кропы: ${cropErr.length} не вышло (${cropErr.slice(0, 3).join('; ')}${cropErr.length > 3 ? '; …' : ''})`, `crops: ${cropErr.length} failed (${cropErr.slice(0, 3).join('; ')}${cropErr.length > 3 ? '; …' : ''})`));
  // frames any finding points to stay on disk after cleanup (another audience may need other crops later)
  ctx.keepSrc = new Set();
  for (const it of original) for (const w of it.where) {
    if (!isStr(w.shot) && !(w.box && w.pid) && !(w.crop && isStr(w.crop.shot))) continue;
    const c = planCrop(run, w, idxCache);
    if (c.src) ctx.keepSrc.add(resolve(c.src));
  }
  if (ctx.partial) return { partial: true, stage: 'crops' };
  const okFile = c => c && c.file && !c.error && existsSync(c.file);
  ctx.cropsFor = it => (cropMap.get(it.rid) || []).filter(x => okFile(x.crop));
  ctx.pairFor = it => { const p = pairMap.get(it.rid); return p && okFile(p.before.crop) && okFile(p.after.crop) ? p : null; };
  // img/by-rid.json: number → crop files (strict review and the editor open them directly)
  const byRid = {};
  for (const it of cards) {
    const c = ctx.cropsFor(it).map(x => `img/${basename(x.crop.file)}`);
    const p = ctx.pairFor(it);
    if (c.length || p) byRid[it.rid] = { uid: it.uid || null, crops: c, ...(p ? { pair: { before: `img/${basename(p.before.crop.file)}`, after: `img/${basename(p.after.crop.file)}` } } : {}) };
  }
  U.writeJSON(join(rep, 'img', 'by-rid.json'), { generated: U.nowIso(), audience: cfg.audience, items: byRid });

  // ---------- HTML
  const site = brief.url || cfg.flags.url || summary.site || '';
  const host = brief.host || cfg.flags.host || U.hostOf(site) || summary.site || '';
  const title = cfg.title || summary.title || fill(tr('default_title'), { site: host });
  const runDate = summary.date || fmtDate(cfg.state.started || brief.started);
  const render = (imgMode) => {
    ctx.imgSrc = file => {
      if (!file || !existsSync(file)) return null;
      return imgMode === 'data' ? `data:image/jpeg;base64,${readFileSync(file).toString('base64')}` : `img/${basename(file)}`;
    };
    if (gl) gl.used = new Map();
    const body = renderMain({ cfg, ctx, summary, brief, items, cards, groups, taste, counts, known, scores, strategy, diff, ext, title, site, host, runDate, gl });
    return pageHtml('report.html', { cfg, title, body, imgMode });
  };
  let html = render('data');
  const htmlPath = join(rep, 'report.html');
  U.writeText(htmlPath, html);
  const htmlBytes = Buffer.byteLength(html);
  let filesVariant = null;
  const filesDir = join(rep, 'report-files');
  if (htmlBytes > MAX_SINGLE_MB * 1024 * 1024) {
    warnings.push(M(`report.html ${U.fmtBytes(htmlBytes)} — больше ${MAX_SINGLE_MB} МБ: для пересылки есть report-files.zip или PDF`, `report.html ${fmtB(htmlBytes, 'en')} — over ${MAX_SINGLE_MB} MB: send report-files.zip or the PDF`));
    rmSync(filesDir, { recursive: true, force: true });
    U.ensureDir(join(filesDir, 'img'));
    const h2 = render('files');
    U.writeText(join(filesDir, 'report.html'), h2);
    const used = [...new Set([...h2.matchAll(/src="img\/(c-[0-9a-f]+\.jpg)"/g)].map(m => m[1]))];
    for (const f of used) copyFileSync(join(rep, 'img', f), join(filesDir, 'img', f));
    writeFileSync(join(rep, 'report-files.zip'), zipWrite([{ name: 'report.html', data: Buffer.from(h2, 'utf8') }, ...used.map(f => ({ name: `img/${f}`, data: readFileSync(join(filesDir, 'img', f)), store: true }))]));
    filesVariant = { dir: filesDir, zip: join(rep, 'report-files.zip'), images: used.length };
  } else { rmSync(filesDir, { recursive: true, force: true }); rmSync(join(rep, 'report-files.zip'), { force: true }); }
  ctx.say(`HTML ${U.fmtBytes(htmlBytes)}`);

  // the findings exactly as shown (textscan --report --file checks this), and the numbers of this report
  const effPath = join(rep, 'findings.effective.json');
  U.writeJSON(effPath, { tool: 'report', version: U.VERSION, generated: U.nowIso(), audience: cfg.audience, lang: cfg.lang, renumbered: doRenumber, external_renumber: emap,
    items: items.map(({ s, _i, _ev, ...it }) => (cfg.audience === 'external' ? { ...forExternal(it), evidence: _ev?.hidden ? '' : _ev?.fact || '' } : it)) });
  numbering[cfg.audience] = { generated: U.nowIso(), rid_to_uid: Object.fromEntries(items.filter(i => isStr(i.uid)).map(i => [i.rid, i.uid])) };
  for (const k of Object.keys(numbering)) if (!['owner', 'team', 'external'].includes(k)) delete numbering[k];
  U.writeJSON(numPath, numbering);

  // ---------- XLSX
  const xlsxPath = join(rep, 'registry.xlsx');
  let xlsxInfo = null;
  try { xlsxInfo = writeRegistry(xlsxPath, { cfg, ctx, items, summary, brief, site, runDate, statuses }); }
  catch (e) { errors.push({ rule: 'xlsx', where: 'registry.xlsx', text: e.message }); }

  // ---------- shots + PDF
  let shots = null;
  const pdfPath = cfg.pdf ? join(rep, 'report.pdf') : null;
  if (cfg.shots || cfg.pdf) {
    if (Date.now() > ctx.deadline && !ctx.resumeShots) return { partial: true, stage: 'shots' };
    if (cfg.shots) shots = await shootReport(ctx, htmlPath, 'report', { pdfPath, dark: !cfg.css });
    else shots = await pdfOnly(ctx, htmlPath, pdfPath);
    if (ctx.partial) return { partial: true, stage: 'shots' };
    if (shots.error) (cfg.pdf ? errors : warnings).push(cfg.pdf ? { rule: 'pdf', where: 'report.pdf', text: shots.error } : M(`кадры отчёта: ${shots.error}`, `report shots: ${shots.error}`));
    if (cfg.pdf && shots.pdfSizeOk === false) errors.push({ rule: 'pdf', where: 'report.pdf', text: M('страница PDF больше A4', 'a PDF page is larger than A4') });
    if (shots.overflow390 > 1) warnings.push(M(`на телефоне (390 px) отчёт шире экрана на ${shots.overflow390} px — это ошибка шаблона Ревизора, не сайта; откройте отчёт на компьютере`, `on a phone (390 px) the report is ${shots.overflow390} px wider than the screen — a Revizor template bug, not the site's; open the report on a computer`));
  }
  if (ctx.noFixShot) warnings.push(M(`проверенные правки P0–P1 без кадра «после» (fix_shot), пары «было / стало» картинками нет: ${ctx.noFixShot}`, `verified P0–P1 fixes without an «after» frame (fix_shot), no before/after pictures: ${ctx.noFixShot}`));

  ctx.say(M('кадры отчёта и PDF готовы, самопроверка', 'report shots and PDF done, self-check'));
  // ---------- self-checks
  const check = selfCheck({ run, cfg, ctx, html, xlsxPath, items, original, summary, counts, editInfo, droppedExt, strategy, brief, runDate, host, effPath, errors, warnings });
  return { ok: !check.errors.length, check, items, counts, htmlPath, htmlBytes, xlsxPath, xlsxInfo, pdfPath, shots, filesVariant, cards: cards.length,
    crops: [...cropMap.values()].flat().filter(x => okFile(x.crop)).length + [...pairMap.keys()].length * 2, droppedExt, finalizeDropped, editInfo, rmap, emap, ext, warnings: check.warnings };
}

// service fields of findings.json never leave for another company (even in internal files of report/)
const SERVICE_FIELDS = ['files', 'lint', 'lint_repairs', 'schema_issues', 'absorbed', 'verdicts_by_member', 'text_from', 'critic_wants', 'stripped', 'fixups', 'run'];
function forExternal(it) {
  const o = { ...it };
  for (const k of SERVICE_FIELDS) delete o[k];
  if (o.verify && typeof o.verify === 'object') { const { how, note, ...v } = o.verify; o.verify = v; }
  if (Array.isArray(o.severity_trail)) o.severity_trail = o.severity_trail.map(x => (x && typeof x === 'object' ? { by: x.by, from: x.from, to: x.to } : x));
  return o;
}

function setStatuses(rep, cfg, items, errors) {
  const p = join(rep, 'statuses.json');
  const doc = readMaybe(p, {}) || {};
  const map = doc.__error ? {} : { ...(doc.by_uid || {}) };
  if (!cfg.statusArgs.length) return map;
  const all = U.readJSON(join(TPL, 'strings.json'));
  const lists = [arr(all.ru?.xlsx?.statuses), arr(all.en?.xlsx?.statuses)];
  const norm = s => String(s ?? '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[«»"'“”]/g, '').replace(/\s+/g, ' ');
  for (const a of cfg.statusArgs) {
    const m = a.match(/^\s*(P[0-3]-\d{2,3}|R-[0-9a-f]{8})\s*[=:]\s*(.+)$/i);
    if (!m) { errors.push({ rule: 'status', where: `--status ${a}`, text: M('нужно вида P0-01="в работе"', 'expected P0-01="in progress"') }); continue; }
    const it = items.find(i => i.rid === m[1].toUpperCase() || i.uid === m[1]);
    if (!it || !isStr(it.uid)) { errors.push({ rule: 'status', where: `--status ${a}`, text: M(`нет находки ${m[1]} в этом отчёте (или у неё нет uid)`, `no finding ${m[1]} in this report (or it has no uid)`) }); continue; }
    let idx = -1;
    for (const l of lists) { const k = l.findIndex(x => norm(x) === norm(m[2])); if (k >= 0) { idx = k; break; } }
    if (idx < 0) { errors.push({ rule: 'status', where: `--status ${a}`, text: M(`статус «${m[2]}» не из списка: ${lists[0].join(' / ')}`, `status «${m[2]}» is not one of: ${lists[1].join(' / ')}`) }); continue; }
    map[it.uid] = { status: idx, rid: it.rid, set: U.nowIso() };
  }
  U.writeJSON(p, { generated: U.nowIso(), by_uid: map });
  return map;
}

async function pdfOnly(ctx, htmlPath, pdfPath) {
  const b = await ctx.br.browser();
  if (!b) return { error: ctx.br.error() || M('браузер не запустился', 'browser did not start') };
  const page = await b.newPage({ blockNavigation: true });
  try {
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(pathToFileURL(htmlPath).href, { allowRisky: true, waitUntil: 'load', timeout: 30000 });
    await page.evaluate(OPEN_DETAILS);
    const buf = await page.pdf({ path: pdfPath, printBackground: true, preferCSSPageSize: true });
    return { files: [], ...pdfInfo(buf) };
  } catch (e) { return { error: e.message }; } finally { await page.close(); }
}

function pageHtml(tplName, { cfg, title, body, imgMode = 'data', script = null, key = '' }) {
  const tpl = readFileSync(join(TPL, tplName), 'utf8');
  let css = readFileSync(join(TPL, 'report.css'), 'utf8');
  let scheme = 'light dark';
  if (cfg.css) {
    // customer CSS: light only (its colours are made for a light page), no «<» at all (cannot leave <style>),
    // no @import (CSP blocks remote loads anyway; fonts only as data: URIs)
    css = css.replace(/\/\*dark\*\/[\s\S]*?\/\*\/dark\*\//g, '') + '\n:root{color-scheme:light}';
    scheme = 'light';
    try { css += '\n' + readFileSync(cfg.css, 'utf8').replace(/</g, '').replace(/@import[^;]*;?/gi, ''); }
    catch (e) { cfg.warnings.push(`--css ${cfg.css}: ${e.message}`); }
  }
  css = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n/g, '\n'); // comments may name the tool
  const img = imgMode === 'data' ? "img-src data:" : "img-src data: 'self' file:";
  let csp = `default-src 'none'; ${img}; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'`;
  if (script !== null) csp += `; script-src 'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;
  const meta = cfg.audience === 'external' ? '' : `<meta name="generator" content="Revizor ${U.VERSION}">\n`;
  return replaceAllTokens(tpl, { lang: cfg.lang, csp, meta, scheme, title: esc(title), css, body, script: script ?? '', key: esc(key) });
}

function logoHtml(cfg) {
  if (!cfg.logo) return '';
  try {
    const ext = extname(cfg.logo).toLowerCase();
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[ext];
    if (!mime) { cfg.warnings.push(M(`--logo: формат ${ext} не поддерживаю (png, jpg, svg, webp)`, `--logo: ${ext} not supported (png, jpg, svg, webp)`)); return ''; }
    const buf = readFileSync(cfg.logo);
    if (buf.length > 2 * 1024 * 1024) { cfg.warnings.push(M('--logo больше 2 МБ — пропустил', '--logo over 2 MB — skipped')); return ''; }
    return `<img class="logo" src="data:${mime};base64,${buf.toString('base64')}" alt="">`;
  } catch (e) { cfg.warnings.push(`--logo: ${e.message}`); return ''; }
}

function renderMain(d) {
  const { cfg, ctx, summary, brief, items, cards, groups, taste, counts, known, scores, strategy, diff, ext, title, site, host, runDate, gl } = d;
  const aud = cfg.audience;
  const out = [];
  const toc = [];
  const MAIN = new Set(['essence', 'top', 'cards', 'rest', 'minor', 'legend']);
  const add = (id, label, html, opts) => { if (!html) return; toc.push([id, label]); out.push(section(id, label, html, opts)); };
  const sc = new Set();

  // header
  const tiles = [0, 1, 2, 3].map(s => `<a class="tile s${s}${counts[`P${s}`] ? '' : ' zero'}" href="#${s <= 1 ? 'cards' : groups.find(x => x.id === `grp-p${s}`) ? `grp-p${s}` : aud === 'external' && s === 3 ? 'minor' : 'cards'}"><div class="n">${counts[`P${s}`]}</div><div class="l"><span class="sev s${s}">${esc(sevLabel(s, aud))}</span></div></a>`);
  tiles.push(`<div class="tile all"><div class="n">${items.length}</div><div class="l">${esc(tr('total'))}</div></div>`);
  const sOver = scores.map(x => Number(x.d.overall)).filter(Number.isFinite);
  if (sOver.length) tiles.push(`<a class="tile score" href="#scores"><div class="n">${fmtNum(sOver.reduce((a, b) => a + b, 0) / sOver.length, cfg.lang)}</div><div class="l">${esc(tr('score'))} ${esc(tr('of10'))}</div></a>`);
  const siteHref = safeHref(site);
  const metaBits = [];
  if (aud !== 'external' && isStr(runDate)) metaBits.push(esc(runDate));
  let head = `<header class="top">${logoHtml(cfg)}<div class="domain">${siteHref ? `<a href="${esc(siteHref)}" rel="noopener noreferrer">${esc(host)}</a>` : esc(host)}${metaBits.length ? ` · ${metaBits.join(' · ')}` : ''}</div>` +
    `<h1>${esc(title)}</h1>${isStr(summary.verdict_line) ? `<p class="verdict">${plain(summary.verdict_line, gl, sc)}</p>` : ''}` +
    `<div class="tiles">${tiles.join('')}</div>`;

  // essence + goals
  const goalsQ = new Map(arr(brief.goals_questions).map(q => [q.id, q.text]));
  let ess = arr(summary.essence).length ? `<ol class="essence">${arr(summary.essence).map(e => `<li>${plain(e, gl, sc)}</li>`).join('')}</ol>` : '';
  const goals = arr(summary.goals_answers).filter(g => g && isStr(g.answer));
  if (goals.length) ess += `<h3 class="sub">${esc(tr('sections.goals'))}</h3>` + ulist(goals, g => `<b>${esc(g.id || '')}${goalsQ.get(g.id) ? ` · ${esc(goalsQ.get(g.id))}` : ''}</b><br>${plain(g.answer, gl, sc)}`);
  add('essence', tr('sections.essence'), ess);
  const legend = `<dl class="legend">${[0, 1, 2, 3].map(s => `<dt><span class="sev s${s}">${esc(sevLabel(s, aud))}</span></dt><dd>${esc(tr('sev_hint')[s])}</dd>`).join('')}</dl><p class="muted small">${esc(tr('legend_note'))}</p>`;
  if (aud === 'external') add('legend', tr('sections.legend'), legend);

  // top actions (owner/team), quick wins
  if (aud !== 'external') {
    const ta = arr(summary.top_actions).filter(a => a && (isStr(a.action) || isStr(a.rid)));
    if (ta.length) add('top', tr('sections.top'), `<table class="tbl stack"><thead><tr><th>${esc(tr('cols.rid'))}</th><th>${esc(tr('cols.action'))}</th><th>${esc(tr('cols.why'))}</th><th>${esc(tr('cols.who'))}</th></tr></thead><tbody>` +
      ta.map(a => `<tr><td class="c-rid">${ridLink(a.rid, known)}</td><td data-l="${esc(tr('cols.action'))}"><span class="t">${plain(a.action || items.find(i => i.rid === a.rid)?.title, gl, sc)}</span></td><td data-l="${esc(tr('cols.why'))}">${plain(a.why, gl, sc)}</td><td data-l="${esc(tr('cols.who'))}" class="small">${esc(whoWord(a.who, ctx.platform))}</td></tr>`).join('') + '</tbody></table>');
    const qw = arr(summary.quick_wins).map(r => (typeof r === 'string' ? r : r?.rid)).filter(r => known.has(r));
    if (qw.length) add('quick', tr('sections.quick'), ulist(qw, r => { const it = items.find(i => i.rid === r); return `${ridLink(r, known)} ${plain(it?.title, gl, sc)}`; }));
  }

  // diff with the previous run (health)
  // first snapshot (no comparable previous run): one line instead of «unchanged: 0»
  const firstSnap = diff && !diff.__error && (diff.first_snapshot === true || ('from' in diff && !diff.from)) && !arr(diff.appeared).length && !arr(diff.fixed).length;
  if (firstSnap) add('diff', tr('diff.title'), `<p class="muted">${esc(tr('diff.first'))}</p>`);
  else if (diff && !diff.__error && (arr(diff.appeared).length || arr(diff.fixed).length || typeof diff.unchanged_count === 'number')) {
    const t = x => (typeof x === 'string' ? x : x?.title || x?.what || x?.key || JSON.stringify(x));
    let h = '';
    if (arr(diff.appeared).length) h += `<h3 class="sub">${esc(tr('diff.appeared', { n: arr(diff.appeared).length }))}</h3>` + ulist(diff.appeared, x => esc(t(x)));
    if (arr(diff.fixed).length) h += `<h3 class="sub">${esc(tr('diff.fixed', { n: arr(diff.fixed).length }))}</h3>` + ulist(diff.fixed, x => esc(t(x)));
    if (typeof diff.unchanged_count === 'number') h += `<p class="muted">${esc(tr('diff.same', { n: diff.unchanged_count }))}</p>`;
    add('diff', tr('diff.title'), h);
  }

  // scores
  if (scores.length) {
    const byC = Object.fromEntries(scores.map(x => [x.c, x.d]));
    const areas = [...new Set(scores.flatMap(x => Object.keys(x.d.areas || {})))];
    const name = a => tr(`lens_names.${a}`) || a;
    const cell = v => (typeof v === 'number' ? fmtNum(v, cfg.lang) : '—');
    let h = `<table class="tbl"><thead><tr><th>${esc(tr('score_area'))}</th><th class="c-num">${esc(tr('score_strict'))}</th><th class="c-num">${esc(tr('score_market'))}</th><th class="c-num">${esc(tr('score_mean'))}</th></tr></thead><tbody>`;
    const row = (label, a, b) => { const vals = [a, b].filter(v => typeof v === 'number'); return `<tr><td>${label}</td><td class="c-num">${cell(a)}</td><td class="c-num">${cell(b)}</td><td class="c-num"><b>${vals.length ? fmtNum(vals.reduce((x, y) => x + y, 0) / vals.length, cfg.lang) : '—'}</b></td></tr>`; };
    h += row(`<b>${esc(tr('score'))}</b>`, byC.strict?.overall, byC.market?.overall);
    for (const a of areas) h += row(esc(name(a)), byC.strict?.areas?.[a], byC.market?.areas?.[a]);
    h += '</tbody></table>';
    if (typeof byC.strict?.overall === 'number' && typeof byC.market?.overall === 'number' && Math.abs(byC.strict.overall - byC.market.overall) >= 1.5)
      h += `<p class="note">${esc(tr('score_spread', { d: fmtNum(Math.abs(byC.strict.overall - byC.market.overall), cfg.lang) }))}</p>`;
    const drivers = [...new Set(scores.flatMap(x => arr(x.d.top_drivers)))].filter(r => known.has(r));
    if (drivers.length) h += `<p>${esc(tr('score_drivers'))}: ${drivers.map(r => ridLink(r, known)).join(', ')}</p>`;
    for (const x of scores) {
      const rat = x.d.rationale && typeof x.d.rationale === 'object' ? Object.entries(x.d.rationale).filter(([, v]) => isStr(v)) : [];
      if (rat.length) h += detailsGroup(`why-${x.c}`, tr(x.c === 'strict' ? 'score_strict' : 'score_market'), '', ulist(rat, ([k, v]) => `<b>${esc(name(k))}.</b> ${plain(v, gl, sc)}`));
    }
    add('scores', tr('sections.scores'), h);
  }

  // traffic lights
  const tl = arr(summary.traffic_lights).filter(x => x && isStr(x.area));
  if (tl.length) add('lights', tr('sections.lights'), `<table class="tbl stack"><tbody>${tl.map(x => `<tr><td class="t">${esc(x.area)}</td><td class="nowrap"><span class="dot ${esc(['red', 'yellow', 'green'].includes(x.status) ? x.status : 'yellow')}"></span>${esc(tr(`lights.${x.status}`) || x.status || '')}</td><td>${plain(x.line, gl, sc)}</td></tr>`).join('')}</tbody></table>`);

  // cards
  const cardsTitle = aud === 'team' ? tr('sections.cards_team') : aud === 'external' ? tr('sections.cards_external') : tr('sections.cards');
  if (cards.length) add('cards', cardsTitle, `<div class="cards">${cards.map(it => cardHtml(it, ctx)).join('\n')}</div>`, { count: cards.length });
  // the rest
  if (groups.length) {
    const inner = groups.map(gr => detailsGroup(gr.id, gr.title, gr.items.length, rowsTable(gr.items, ctx, { sevCol: !!gr.sev }), !!gr.open)).join('\n');
    add('rest', tr('sections.rest'), inner, { count: groups.reduce((n, gr) => n + gr.items.length, 0) });
  }

  // decisions and taste
  if (aud !== 'external') {
    let h = '';
    const dec = arr(summary.decisions).filter(x => x && isStr(x.question));
    if (dec.length) h += ulist(dec, x => `<b>${plain(x.question, gl, sc)}</b>${arr(x.options).map(o => { const rec = /^\s*★/.test(String(o)); return `<div class="opt${rec ? ' rec' : ''}">${rec ? '★ ' : '— '}${plain(String(o).replace(/^\s*★\s*/, ''), gl, sc)}${rec ? ` <span class="muted small">(${esc(tr('decision_rec'))})</span>` : ''}</div>`; }).join('')}${arr(x.rids).length ? `<div class="small muted">${arr(x.rids).map(r => ridLink(r, known)).join(', ')}</div>` : ''}`);
    if (taste.length) h += `<h3 class="sub">${esc(tr('sections.taste'))}</h3>` + `<div id="grp-taste">${rowsTable(taste, ctx, { sevCol: aud === 'team' })}</div>`;
    add('decisions', tr('sections.decisions'), h);
  } else if (taste.length) {
    const byTopic = new Map();
    for (const it of taste) { const k = it.category || it.lenses[0] || '—'; if (!byTopic.has(k)) byTopic.set(k, []); byTopic.get(k).push(it); }
    add('taste', tr('sections.taste_external'), ulist([...byTopic.values()], list => `${list.map(it => `<span id="${esc(it.rid)}" class="rid">${esc(it.rid)}</span>`).join(', ')} · ${plain(list[0].fix || list[0].title, gl, sc)}`));
  }

  // strategy
  if (strategy && !strategy.__error && aud !== 'external') {
    let h = '';
    for (const [k, label] of [['seo', tr('sections.strategy_seo')], ['site', tr('sections.strategy_site')]]) {
      const s = strategy[k]; if (!s || typeof s !== 'object') continue;
      let part = '';
      const periods = arr(s.periods).filter(p => p && arr(p.actions).length);
      if (periods.length) part += `<table class="tbl stack"><thead><tr><th>${esc(tr('cols.when'))}</th><th>${esc(tr('cols.action'))}</th><th>${esc(tr('cols.who'))}</th><th>${esc(tr('cols.effect'))}</th></tr></thead><tbody>` +
        periods.flatMap(p => arr(p.actions).map((a, i) => `<tr><td class="nowrap t" data-l="${esc(tr('cols.when'))}">${i === 0 ? esc(p.when || '') : ''}</td><td data-l="${esc(tr('cols.action'))}">${plain(a.what, gl, sc)}${isStr(a.rid) ? ` ${ridLink(a.rid, known)}` : ''}</td><td class="small" data-l="${esc(tr('cols.who'))}">${esc(whoWord(a.who, ctx.platform))}</td><td data-l="${esc(tr('cols.effect'))}">${plain(a.effect, gl, sc)}</td></tr>`)).join('') + '</tbody></table>';
      const np = arr(s.new_pages).filter(p => p && (isStr(p.url) || isStr(p.intent)));
      if (np.length) part += `<h3 class="sub">${esc(tr('sections.new_pages'))}</h3><table class="tbl stack"><thead><tr><th>${esc(tr('cols.url'))}</th><th>${esc(tr('cols.intent'))}</th><th>${esc(tr('cols.why'))}</th></tr></thead><tbody>` +
        np.map(p => `<tr><td data-l="${esc(tr('cols.url'))}"><code>${esc(p.url || '')}</code></td><td data-l="${esc(tr('cols.intent'))}">${plain(p.intent, gl, sc)}${isStr(p.cluster) ? `<div class="small muted">${esc(p.cluster)}</div>` : ''}</td><td data-l="${esc(tr('cols.why'))}">${plain(p.why, gl, sc)}</td></tr>`).join('') + '</tbody></table>';
      if (arr(s.not_doing).length) part += `<h3 class="sub">${esc(tr('sections.not_doing'))}</h3>` + ulist(s.not_doing, x => plain(typeof x === 'string' ? x : x?.what || x?.text, gl, sc), '');
      if (part) h += `<h3 class="sub">${esc(label)}</h3>${part}`;
    }
    add('strategy', tr('sections.strategy'), h);
  }

  // strengths
  const st = arr(summary.strengths).filter(x => x && isStr(x.what));
  if (st.length) add('strengths', tr('sections.strengths'), ulist(st, x => `<b>${plain(x.what, gl, sc)}</b>${isStr(x.why) ? `<br>${plain(x.why, gl, sc)}` : ''}`));

  // device checks / advice, owner todo, not checked
  const dc = arr(summary.device_checks).map(x => (typeof x === 'string' ? x : x?.text || x?.what)).filter(isStr);
  if (dc.length) add('device', aud === 'external' ? tr('sections.advice') : tr('sections.device'), ulist(dc, x => plain(x, gl, sc)));
  if (aud !== 'external') {
    const todo = arr(summary.owner_todo).map(x => (typeof x === 'string' ? x : x?.text || x?.what)).filter(isStr);
    if (todo.length) add('todo', tr('sections.todo'), ulist(todo, x => plain(x, gl, sc)));
    const nc = arr(summary.not_checked).map(x => (typeof x === 'string' ? x : [x?.what || x?.check, x?.why].filter(isStr).join(' — '))).filter(isStr);
    if (nc.length) add('not-checked', tr('sections.not_checked'), ulist(nc, x => plain(x, gl, sc)));
  }

  // how it was checked
  if (aud === 'external') {
    const m = isStr(summary.method) ? summary.method : '';
    if (m) add('method', tr('sections.method_external'), `<p>${plain(m, gl, sc)}</p>`);
  } else {
    let h = isStr(summary.method) ? `<p>${plain(summary.method, gl, sc)}</p>` : '';
    const pr = summary.process;
    if (pr && typeof pr === 'object') h += `<p class="muted">${esc(tr('process', { found: pr.found ?? '—', confirmed: pr.confirmed ?? '—', adjusted: pr.adjusted ?? '—', rejected: pr.rejected ?? '—', unverified: pr.unverified ?? '—', rounds: pr.rounds ?? 1 }))}</p>`;
    if (typeof summary.memory_applied === 'number' && summary.memory_applied > 0) h += `<p class="muted">${esc(tr('memory_applied', { n: summary.memory_applied }))}</p>`;
    if (cfg.flags?.models_note === 'no_subscription') h += `<p class="muted">${esc(tr('models_default', { models: cfg.flags.models || 'balanced' }))}</p>`;
    const rc = arr(summary.rivals_compared).filter(x => x && isStr(x.url));
    if (rc.length) h += `<h3 class="sub">${esc(tr('sections.rivals'))}</h3>` + ulist(rc, x => { const href = safeHref(x.url); return `${href ? `<a href="${esc(href)}" rel="noopener noreferrer">${esc(U.hostOf(href))}</a>` : esc(x.url)}${isStr(x.why) ? ` — ${plain(x.why, gl, sc)}` : ''}`; });
    h += `<h3 class="sub">${esc(tr('sections.external'))}</h3>`;
    if (ext.rows.length) h += `<table class="tbl stack"><thead><tr><th>${esc(tr('cols.service'))}</th><th>${esc(tr('cols.sent'))}</th><th class="c-num">${esc(tr('cols.count'))}</th></tr></thead><tbody>${ext.rows.map(r => `<tr><td class="t">${esc(r.service)}</td><td class="small" data-l="${esc(tr('cols.sent'))}">${esc(r.what || '—')}</td><td class="c-num" data-l="${esc(tr('cols.count'))}">${esc(r.count ?? '—')}</td></tr>`).join('')}</tbody></table>`;
    else h += `<p class="muted">${esc(tr('external_none'))}</p>`;
    add('method', tr('sections.method'), h);
  }

  // external appendix: every small edit; texts as «Где · Было · Стало», the rest as «Где · Что · Как исправить»
  if (aud === 'external') {
    const p3 = items.filter(i => i.s === 3 && !i.taste);
    if (p3.length) {
      const textual = p3.filter(it => isStr(it.before) && isStr(it.after));
      const other = p3.filter(it => !(isStr(it.before) && isStr(it.after)));
      let h = '';
      if (textual.length) h += `<h3 class="sub">${esc(tr('sections.minor_text'))}</h3><table class="tbl stack"><thead><tr><th>${esc(tr('cols.rid'))}</th><th>${esc(tr('cols.where'))}</th><th>${esc(tr('cols.before'))}</th><th>${esc(tr('cols.after'))}</th></tr></thead><tbody>` +
        textual.map(it => `<tr id="${esc(it.rid)}"><td class="c-rid"><span class="rid">${esc(it.rid)}</span></td><td data-l="${esc(tr('cols.where'))}" class="small">${whereHtml(it, ctx, { max: 2 })}</td>` +
          `<td data-l="${esc(tr('cols.before'))}" class="site">${rich(it.before, null, null)}</td><td data-l="${esc(tr('cols.after'))}">${rich(it.after, gl, new Set())}</td></tr>`).join('') + '</tbody></table>';
      if (other.length) h += `<h3 class="sub">${esc(tr(textual.length ? 'sections.minor_other' : 'sections.minor_edits'))}</h3><table class="tbl stack"><thead><tr><th>${esc(tr('cols.rid'))}</th><th>${esc(tr('cols.where'))}</th><th>${esc(tr('cols.what'))}</th><th>${esc(tr('cols.fix'))}</th></tr></thead><tbody>` +
        other.map(it => `<tr id="${esc(it.rid)}"><td class="c-rid"><span class="rid">${esc(it.rid)}</span></td><td data-l="${esc(tr('cols.where'))}" class="small">${whereHtml(it, ctx, { max: 2 })}</td>` +
          `<td data-l="${esc(tr('cols.what'))}"><span class="t">${plain(it.title, gl, new Set())}</span></td><td data-l="${esc(tr('cols.fix'))}">${rich(it.fix, gl, new Set())}${isStr(it.after) ? `<p class="small"><b>${esc(tr('card.after'))}:</b> ${plain(it.after, gl, new Set())}</p>` : ''}</td></tr>`).join('') + '</tbody></table>';
      add('minor', tr('sections.minor_edits'), `<p class="muted">${esc(tr('minor_note'))}</p>${h}`, { count: p3.length });
    }
  }

  if (aud !== 'external') add('legend', tr('sections.legend'), legend);
  if (gl && gl.used.size) add('terms', tr('sections.terms'), `<p class="muted small">${esc(tr('terms_note'))}</p><table class="tbl"><tbody>${[...gl.used.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `<tr><td class="t nowrap">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table>`);

  // table of contents: on a phone only the main sections
  head += toc.length > 3 ? `<nav class="toc" aria-label="${esc(tr('toc'))}">${toc.map(([id, label]) => `<a href="#${esc(id)}"${MAIN.has(id) ? '' : ' class="minor"'}>${esc(label)}</a>`).join('')}</nav>` : '';
  head += '</header>';
  const foot = aud === 'external' ? '' : `<footer class="foot">${esc(tr('footer', { version: U.VERSION, date: fmtDate() }))}</footer>`;
  return head + '\n' + out.join('') + foot;
}

// ---------------------------------------------------------------- registry.xlsx (knowledge/report-structure.md, section 8)
function writeRegistry(path, { cfg, ctx, items, summary, brief, site, runDate, statuses }) {
  const X = tr('xlsx');
  const aud = cfg.audience;
  const sevCell = s => sevLabel(s, aud);
  const lensName = l => tr(`lens_names.${l}`) || l;
  const headers = [...X.headers, ...(aud === 'team' ? X.headers_team : [])];
  const widths = [8, 16, 18, 16, 52, 36, 52, 16, 14, 18, 30, 12, 14, 16, 22, 12, 13];
  const statusOf = it => { const s = isStr(it.uid) ? statuses[it.uid] : null; return X.statuses[s && Number.isInteger(s.status) ? s.status : 0] || X.statuses[0]; };
  const rows = items.map(it => {
    const sectionName = it.sitewide ? tr('all_site') : pageLabel(ctx.pages, it.where[0]?.pid, it.where[0]?.url);
    const what = [it.title, it.problem].filter(isStr).join('\n');
    const fix = [it.fix, isStr(it.after) ? `${tr('card.after')}: ${it.after}` : ''].filter(isStr).join('\n');
    const base = [it.rid, sevCell(it.s), sectionName, lensName(it.lenses[0] || ''), what, whereText(it, ctx), fix, whoWord(it.owner, ctx.platform), effortWord(it.effort, aud), statusOf(it), '', ''];
    if (aud === 'team') base.push(it.lenses.join(', '), it.method || '', it.norm || '', it.confidence || '', it.uid || '');
    return base;
  });
  const colStatus = colLetter(9);
  const sevStyle = (ri, ci) => (ci === 1 ? `p${items[ri]?.s ?? 3}` : ci === 0 ? 'center' : 'wrap');

  // by fix place, with «how to check»: the page and width, then what must be true (after → norm → fix)
  const placeRows = [];
  const groups = new Map();
  for (const it of items) { const k = isStr(it.fix_place) ? it.fix_place : X.place_other; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(it); }
  for (const [k, list] of groups) {
    placeRows.push([tr(`places.${k}`) || k, '', '', '', '']);
    for (const it of list) {
      const w = it.where[0] || {};
      const vars = { url: it.sitewide && !w.url ? tr('all_site') : (w.url || pageLabel(ctx.pages, w.pid, w.url)), vp: vpLabel(w.viewport) ? `, ${vpLabel(w.viewport)}` : '', state: isStr(w.state) && !/^загрузка$|^load$/i.test(w.state) ? `, ${w.state}` : '' };
      const how = aud === 'team' && isStr(it.fix_check) ? it.fix_check
        : isStr(it.after) ? fill(X.check_after, { ...vars, after: clip(it.after, 90) })
          : isStr(it.norm) ? fill(X.check_norm, { ...vars, norm: clip(it.norm, 120) })
            : fill(X.check_line, vars);
      placeRows.push(['', it.rid, sevCell(it.s), it.title || '', how]);
    }
  }
  const placeIsHead = new Set(); { let r = 0; for (const [, list] of groups) { placeIsHead.add(r); r += 1 + list.length; } }

  // summary with formulas (+ static numbers for readers that do not recalculate)
  const main = `'${X.sheets.main}'`;
  const N = Math.max(rows.length + 500, 1000);
  const rng = c => `${main}!$${c}$2:$${c}$${N}`;
  const sumRows = [[X.total, items.length, { f: `COUNTA(${rng('A')})` }]];
  for (const s of [0, 1, 2, 3]) { const lab = sevCell(s); sumRows.push([lab, items.filter(i => i.s === s).length, { f: `COUNTIF(${rng('B')},"${lab.replace(/"/g, '""')}")` }]); }
  for (const stx of X.statuses) sumRows.push([fill(X.status_row, { s: stx }), items.filter(it => statusOf(it) === stx).length, { f: `COUNTIF(${rng(colStatus)},"${stx.replace(/"/g, '""')}")` }]);

  // how to read
  const legend = [0, 1, 2, 3].map(s => `${sevCell(s)} — ${tr('sev_hint')[s]}`).join('; ');
  const howRows = X.howto.map(([a, b]) => [a, fill(b, { legend })]);
  if (aud !== 'external') howRows.push(X.howto_recheck);

  // hidden _revizor: uid | rid | url | selector | viewport | state | method | lens | norm (+ meta row);
  // the name stays (recheck.mjs finds the sheet by it); for external — no method, lens or plugin version
  const hid = items.map(it => { const w = it.where[0] || {}; return [it.uid || '', it.rid, w.url || '', w.selector || '', String(w.viewport ?? ''), w.state || '', aud === 'external' ? '' : it.method || '', aud === 'external' ? '' : it.lenses.join(','), it.norm || '']; });
  hid.push([]);
  hid.push(['_meta', 'site', site || summary.site || '', 'run_date', aud === 'external' ? '' : runDate || '', ...(aud === 'external' ? [] : ['plugin_version', U.VERSION]), 'schema_version', String(SCHEMA_VERSION), 'audience', aud, 'lang', cfg.lang]);

  writeXlsx(path, {
    creator: aud === 'external' ? (brief.host || summary.site || '') : 'Revizor',
    sheets: [
      { name: X.sheets.main, columns: headers.map((h, i) => ({ header: h, width: widths[i] || 14 })), rows, freeze: true, autoFilter: true,
        validations: [{ col: colStatus, list: X.statuses }], cellStyle: sevStyle },
      { name: X.sheets.place, columns: X.place_headers.map((h, i) => ({ header: h, width: [24, 8, 16, 60, 70][i] })), rows: placeRows, freeze: true,
        cellStyle: (ri) => (placeIsHead.has(ri) ? 'bold' : 'wrap') },
      { name: X.sheets.summary, columns: X.summary_headers.map((h, i) => ({ header: h, width: [34, 20, 14][i] })), rows: sumRows, cellStyle: (ri, ci) => (ci ? 'center' : 'wrap') },
      { name: X.sheets.howto, columns: X.howto_headers.map((h, i) => ({ header: h, width: [28, 100][i] })), rows: howRows },
      { name: '_revizor', hidden: true, columns: ['uid', 'rid', 'url', 'selector', 'viewport', 'state', 'method', 'lens', 'norm'].map(h => ({ header: h, width: 16 })), rows: hid },
    ],
  });
  return { rows: rows.length };
}
function colLetter(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

// ---------------------------------------------------------------- self-check
const TS_CAT_EN = { 'машинный след': 'machine trace', 'заглушка': 'placeholder', 'канцелярит': 'officialese', 'метатекст': 'meta-text', 'усилитель': 'empty intensifier',
  'калька': 'calque', 'не-X-а-Y': 'not-X-but-Y', 'триада': 'rule of three', 'оценка без факта': 'claim without a fact', 'штамп': 'stock phrase' };
// textscan --report --file <findings.effective.json>: the dictionaries over the texts as they are in the report
function runTextscan({ run, cfg, effPath, E, W }) {
  const ts = join(SCRIPTS, 'textscan.mjs');
  if (!existsSync(ts)) { W.push(M('textscan.mjs нет — проверка языка отчёта пропущена', 'textscan.mjs missing — report language check skipped')); return; }
  const outPath = join(run, 'report', 'textscan-report.json');
  rmSync(outPath, { force: true }); // never read a result of an earlier run
  const t0 = Date.now();
  // --report stays for an older textscan without --file: it then scans report/findings.json (warned below)
  const rel = fwd(relative(run, effPath));
  const r = spawnSync(process.execPath, [ts, '--run', run, '--report', '--file', rel, '--lang', cfg.lang], { encoding: 'utf8', timeout: 180000, windowsHide: true });
  const code = r.status ?? (r.error ? r.error.code : null);
  const why = clip(r.stderr || r.stdout || '', 160);
  if (code === 2) { W.push(M(`textscan --file: нет файла или не JSON (${why}) — язык отчёта не проверен`, `textscan --file: no file or not JSON (${why}) — report language not checked`)); return; }
  if (code !== 0 && code !== 4) { W.push(M(`textscan --file завершился с кодом ${code}: язык отчёта не проверен (${why})`, `textscan --file exited with code ${code}: report language not checked (${why})`)); return; }
  const out = readMaybe(outPath, null);
  if (!out || out.__error) { W.push(M(`textscan (код ${code}) не записал report/textscan-report.json — язык отчёта не проверен`, `textscan (code ${code}) wrote no report/textscan-report.json — report language not checked`)); return; }
  let mtime = 0; try { mtime = statSync(outPath).mtimeMs; } catch {}
  if (mtime && mtime < t0 - 2000) { W.push(M('report/textscan-report.json старше этого запуска — язык отчёта не проверен', 'report/textscan-report.json is older than this run — report language not checked')); return; }
  const files = [out.source, ...arr(out.files)].filter(Boolean).map(f => fwd(String(f)));
  const usedEff = files.some(f => f.endsWith('findings.effective.json'));
  if (!usedEff) W.push(M('textscan не понимает --file: проверены тексты report/findings.json, а не то, что в отчёте после правок и снятий — обновите textscan.mjs', 'textscan does not understand --file: it checked report/findings.json, not the texts after edits and drops — update textscan.mjs'));
  const outside = arr(out.outside_report);
  if (outside.length) W.push(M(`textscan: P0–P1 в after находок линз, которых нет в отчёте (не ворота): ${outside.length}`, `textscan: P0–P1 in lens findings outside the report (not a gate): ${outside.length}`));
  const HIDDEN_EXT = /^(?:top_actions|quick_wins|decisions|owner_todo|not_checked)\b/;
  const hits = arr(out.hits || out.items || out.findings).filter(h => {
    const lvl = String(h?.level || h?.severity || '');
    if (!/^P[01]$/.test(lvl)) return false;
    if (h.id === 'ru-m-066') return false;                      // general «не X, а Y»: P2 inside a finding text
    if (/^\*\*[^*]+\*\*$/.test(String(h.match || ''))) return false; // **bold** is rendered, no stars are visible
    const file = fwd(String(h.file || ''));
    if (/^findings\//.test(file)) return false;                 // raw lens files are not the report
    if (usedEff && /report\/findings\.json$/.test(file)) return false;
    if (cfg.audience === 'external' && (/strategy\.json$/.test(file) || (/summary\.json$/.test(file) && HIDDEN_EXT.test(String(h.path || ''))))) return false;
    return true;
  });
  // textscan --report gives categories in Russian whatever --lang is; the self-check speaks the report language
  const cat = h => { const c = String(h.category || h.check || ''); return cfg.lang === 'en' ? TS_CAT_EN[c] || c : c; };
  for (const h of hits.slice(0, 30)) E.push({ rule: 'textscan', where: [h.ref || h.rid || h.id, h.path || h.field, h.file].filter(isStr).join(' ') || M('отчёт', 'report'), text: `${h.level || h.severity} ${cat(h)}: «${String(h.match || h.text || h.quote || '').slice(0, 80)}»${isStr(h.hint) ? ` — ${h.hint}` : ''}` });
}

function selfCheck({ run, cfg, ctx, html, xlsxPath, items, original, summary, counts, editInfo, droppedExt, strategy, brief, runDate, host, effPath, errors, warnings }) {
  const E = errors; const W = warnings;
  // 1. every rid in HTML and XLSX
  const missingHtml = items.filter(it => !html.includes(`id="${it.rid}"`)).map(i => i.rid);
  if (missingHtml.length) E.push({ rule: 'rid_html', where: 'report.html', text: M(`нет в HTML: ${missingHtml.slice(0, 20).join(', ')}`, `missing in HTML: ${missingHtml.slice(0, 20).join(', ')}`) });
  if (existsSync(xlsxPath)) {
    try {
      const wb = readXlsx(xlsxPath);
      const sh = wb.sheets.find(s => s.name === tr('xlsx.sheets.main'));
      const fc = sh ? findColumns(sh.rows) : null;
      if (!sh || !fc || !('rid' in fc.cols)) E.push({ rule: 'rid_xlsx', where: 'registry.xlsx', text: M('не нашёл лист «Замечания» или столбец «№»', 'no «Issues» sheet or «No.» column') });
      else {
        const got = new Set(sh.rows.slice(fc.row + 1).map(r => r[fc.cols.rid]).filter(Boolean).map(String));
        const miss = items.filter(it => !got.has(it.rid)).map(i => i.rid);
        if (miss.length) E.push({ rule: 'rid_xlsx', where: 'registry.xlsx', text: M(`нет в реестре: ${miss.slice(0, 20).join(', ')}`, `missing in the registry: ${miss.slice(0, 20).join(', ')}`) });
        if (got.size !== items.length) E.push({ rule: 'rid_xlsx', where: 'registry.xlsx', text: M(`строк ${got.size}, находок ${items.length}`, `${got.size} rows, ${items.length} findings`) });
      }
      const hidden = wb.sheets.find(s => s.name === '_revizor');
      if (!hidden) E.push({ rule: 'xlsx', where: 'registry.xlsx', text: M('нет листа _revizor', 'no _revizor sheet') });
      else if (hidden.hidden === false) E.push({ rule: 'xlsx', where: 'registry.xlsx', text: M('лист _revizor не скрыт', 'the _revizor sheet is not hidden') });
    } catch (e) { E.push({ rule: 'xlsx', where: 'registry.xlsx', text: M(`не читается: ${e.message}`, `unreadable: ${e.message}`) }); }
  }
  // 2. numbers = summary.counts
  if (summary && summary.counts && typeof summary.counts === 'object') {
    const diff = ['P0', 'P1', 'P2', 'P3'].filter(k => Number(summary.counts[k] ?? -1) !== counts[k]);
    if (diff.length) {
      const text = M(`summary.counts ${diff.map(k => `${k}=${summary.counts[k] ?? '—'}`).join(', ')}, а в отчёте ${diff.map(k => `${k}=${counts[k]}`).join(', ')}`, `summary.counts ${diff.map(k => `${k}=${summary.counts[k] ?? '—'}`).join(', ')}, the report has ${diff.map(k => `${k}=${counts[k]}`).join(', ')}`);
      if (editInfo.log.length || droppedExt.length) W.push(`${text} ${M('(после правок/снятия для external — обновите summary.counts и цифры в тексте)', '(after edits/external drops — update summary.counts and numbers in the text)')}`);
      else E.push({ rule: 'counts', where: 'summary.json', text });
    }
  } else if (summary && Object.keys(summary).length) E.push({ rule: 'counts', where: 'summary.json', text: M('нет counts', 'no counts') });
  // structured summary references point to existing rids
  const known = new Set(items.map(i => i.rid));
  const refs = [...arr(summary.top_actions).map(a => a?.rid), ...arr(summary.quick_wins).map(r => (typeof r === 'string' ? r : r?.rid)), ...arr(summary.decisions).flatMap(d => arr(d?.rids))].filter(isStr);
  const dangling = [...new Set(refs.filter(r => !known.has(r)).map(r => r.replace(/[⟦⟧]/g, '')))];
  if (dangling.length) {
    // external does not show these blocks: a warning; owner/team: an error
    if (cfg.audience === 'external') W.push(M(`summary ссылается на снятые для заказчика: ${dangling.join(', ')} (эти блоки заказчику не показываются)`, `summary refers to findings removed for the client: ${dangling.join(', ')} (these blocks are not shown to the client)`));
    else E.push({ rule: 'refs', where: 'summary.json', text: M(`ссылки на несуществующие номера: ${dangling.join(', ')}`, `references to missing numbers: ${dangling.join(', ')}`) });
  }
  // 3. confirmed findings are not lost (candidates → findings via merged_from)
  const cand = readMaybe(join(run, 'report', 'candidates.json'), null);
  if (cand && !cand.__error && Array.isArray(cand.items)) {
    const confirmed = cand.items.filter(c => c && ['confirmed', 'adjusted'].includes(c.verdict)).map(c => String(c.id));
    // finalize keeps what it removed for external in findings.external_dropped and external-dropped.json
    const extDropped = readMaybe(join(run, 'report', 'external-dropped.json'), null);
    const fjNow = readMaybe(join(run, 'report', 'findings.json'), null);
    const covered = new Set([...original, ...arr(extDropped?.items), ...arr(fjNow?.external_dropped)].flatMap(it => [it?.id, ...arr(it?.merged_from)]).filter(Boolean).map(String));
    const lost = confirmed.filter(id => !covered.has(id));
    if (lost.length) E.push({ rule: 'confirmed', where: 'findings.json', text: M(`подтверждённые находки пропали: ${lost.slice(0, 15).join(', ')}`, `confirmed findings are missing: ${lost.slice(0, 15).join(', ')}`) });
  }
  // 4. language of the report: textscan --report --file on the effective set
  runTextscan({ run, cfg, effPath, E, W });
  // 5. forbidden words for the audience (our text only: quotes from the site and code are skipped)
  const started = cfg.state.started || brief.started || null;
  const dates = cfg.audience === 'external' ? [runDate, started ? fmtDate(started, 'ru') : null, started ? fmtDate(started, 'en') : null].filter(isStr) : [];
  const fb = loadForbidden(cfg.audience, [...new Set(dates)]);
  if (fb.from === 'fallback') W.push(M(`запрет-лист встроенный: knowledge/tone.md${fb.note ? ` (${fb.note})` : ' нет'}`, `built-in stop list: knowledge/tone.md${fb.note ? ` (${fb.note})` : ' missing'}`));
  const vocab = cfg.audience === 'external' ? siteVocab(run, brief) : null;
  const siteExcused = new Set();
  const seenHit = new Set();
  const scan = (where, text, { level = 'error' } = {}) => {
    const s = String(text ?? '');
    for (const m of s.matchAll(/⟦(P[0-3]-\d{2,3})⟧/g)) E.push({ rule: 'refs', where, text: M(`ссылка на ${m[1]}, а эта находка снята из отчёта — перепишите текст`, `refers to ${m[1]}, which was removed from this report — rewrite the text`) });
    // rid mentioned in text must exist in this report (renumbering, drops for external)
    for (const m of s.replace(/⟦[^⟧]*⟧/g, ' ').matchAll(RID_RE)) if (!known.has(m[0])) E.push({ rule: 'refs', where, text: M(`ссылка на ${m[0]}, а такой находки в отчёте нет`, `refers to ${m[0]}, which is not in this report`) });
    const t = stripQuoted(s);
    if (!t.trim()) return;
    for (const r of fb.rules) {
      r.re.lastIndex = 0;
      const m = t.match(r.re);
      if (!m) continue;
      const k = `${where}|${m[0].toLowerCase()}`;
      if (seenHit.has(k)) continue;
      seenHit.add(k);
      if (vocab && r.kind === 'audience' && vocab.has(m[0])) { siteExcused.add(m[0].toLowerCase()); continue; }
      const item = { rule: 'forbidden', where, text: `«${m[0].slice(0, 60)}» (${r.label})` };
      if (level === 'warn') W.push(`${where}: ${item.text}`); else E.push(item);
    }
  };
  const fields = cfg.audience === 'team' ? ['title', 'problem', 'impact', 'fix', 'after', 'scenario'] : ['title', 'problem', 'impact', 'fix', 'after'];
  for (const it of items) {
    for (const f of fields) if (isStr(it[f])) scan(`${it.rid} ${f}`, it[f]);
    // evidence: for external only the fact part, and only if it is shown
    const ev = it._ev || splitEvidence(it.evidence);
    if (cfg.audience === 'external') { if (!ev.hidden && isStr(ev.fact)) scan(`${it.rid} evidence`, ev.fact); }
    else if (isStr(ev.fact)) scan(`${it.rid} evidence`, ev.fact);
    if (cfg.audience === 'external') { if (isStr(it.norm) && NORM_FOR_PEOPLE.test(it.norm)) scan(`${it.rid} norm`, it.norm); for (const w of it.where) if (isStr(w.block)) scan(`${it.rid} where.block`, w.block); }
  }
  const sv = (k, v) => { if (isStr(v)) scan(`summary.${k}`, v); };
  sv('title', summary.title); sv('verdict_line', summary.verdict_line); sv('method', summary.method);
  arr(summary.essence).forEach((x, i) => sv(`essence[${i}]`, x));
  arr(summary.goals_answers).forEach((x, i) => sv(`goals_answers[${i}]`, x?.answer));
  arr(summary.traffic_lights).forEach((x, i) => { sv(`traffic_lights[${i}].line`, x?.line); sv(`traffic_lights[${i}].area`, x?.area); });
  arr(summary.strengths).forEach((x, i) => { sv(`strengths[${i}].what`, x?.what); sv(`strengths[${i}].why`, x?.why); });
  arr(summary.device_checks).forEach((x, i) => sv(`device_checks[${i}]`, typeof x === 'string' ? x : x?.text));
  if (cfg.audience !== 'external') {
    arr(summary.top_actions).forEach((x, i) => { sv(`top_actions[${i}].action`, x?.action); sv(`top_actions[${i}].why`, x?.why); });
    arr(summary.decisions).forEach((x, i) => { sv(`decisions[${i}].question`, x?.question); arr(x?.options).forEach((o, j) => sv(`decisions[${i}].options[${j}]`, o)); });
    arr(summary.owner_todo).forEach((x, i) => sv(`owner_todo[${i}]`, typeof x === 'string' ? x : x?.text));
    if (strategy && !strategy.__error) for (const k of ['seo', 'site']) arr(strategy[k]?.periods).forEach((p, i) => arr(p?.actions).forEach((a, j) => { sv(`strategy.${k}[${i}][${j}].what`, a?.what); sv(`strategy.${k}[${i}][${j}].effect`, a?.effect); }));
  }
  if (isStr(cfg.title)) scan('--title', cfg.title, { level: 'warn' }); // the customer's own title: a warning
  if (siteExcused.size) W.push(M(`слова из запрет-листа есть в тексте самого сайта — считаю терминами сайта: ${[...siteExcused].slice(0, 6).join(', ')}`, `stop-list words found in the site's own text — treated as site terms: ${[...siteExcused].slice(0, 6).join(', ')}`));
  // 6. no scripts, handlers or active content in the page: real tags and attribute names only (site text inside
  //    attribute values — titles in alt — is data, not markup)
  const act = activeContent(html);
  if (act.scripts) E.push({ rule: 'script', where: 'report.html', text: M(`<script> в отчёте: ${act.scripts}`, `<script> in the report: ${act.scripts}`) });
  if (act.problems.length) E.push({ rule: 'script', where: 'report.html', text: M(`активная разметка: ${[...new Set(act.problems)].slice(0, 5).join(', ')}`, `active markup: ${[...new Set(act.problems)].slice(0, 5).join(', ')}`) });
  // 7. external: no traces of the tool in the whole visible text (site quotes, site names and the host are cut first)
  if (cfg.audience === 'external') {
    let visible = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<title>[\s\S]*?<\/title>/gi, ' ')
      .replace(/<(q|span|div|td)\b[^>]*\bclass="[^"]*\bsite\b[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<(code|pre)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<h1>[\s\S]*?<\/h1>/i, cfg.title ? ' ' : '$&')
      .replace(/<[^>]+>/g, ' ');
    visible = decodeEntities(visible);
    for (const h of [host, U.stripWww(String(host || '')), U.hostOf(brief.url || '')].filter(isStr)) visible = visible.split(h).join(' ');
    for (const [re, word] of [[/(?<![\p{L}])ревизор/iu, 'ревизор'], [/revizor/i, 'revizor'], [/claude/i, 'claude'], [/anthropic/i, 'anthropic']]) {
      const m = visible.match(re);
      if (m && !(vocab && vocab.has(word))) E.push({ rule: 'external', where: 'report.html', text: M(`след набора в тексте: «${m[0]}»`, `tool trace in the text: «${m[0]}»`) });
    }
    if (/name="generator"/i.test(html)) E.push({ rule: 'external', where: 'report.html', text: 'meta generator' });
  }
  const res = { ok: !E.length, generated: U.nowIso(), audience: cfg.audience, errors: E, warnings: W };
  U.writeJSON(join(run, 'report', 'selfcheck.json'), res);
  return res;
}

// ---------------------------------------------------------------- cleanup after a good report (what goes away: --keep-raw in --help)
function cleanupRaw(run, keep = new Set()) {
  let files = 0, bytes = 0;
  const kill = p => { const n = statSync(p).isDirectory() ? dirSize(p) : fileSize(p); rmSync(p, { recursive: true, force: true }); files++; bytes += n; };
  const snap = join(run, 'snapshot');
  if (existsSync(snap)) for (const pid of readdirSync(snap)) {
    const pdir = join(snap, pid);
    try { if (!statSync(pdir).isDirectory()) continue; } catch { continue; }
    const shots = join(pdir, 'shots');
    if (existsSync(shots)) for (const f of readdirSync(shots)) if (/\.(part|inner)-\d+\.jpg$/i.test(f) && !keep.has(resolve(join(shots, f)))) kill(join(shots, f));
    if (existsSync(join(pdir, 'dom.html'))) kill(join(pdir, 'dom.html'));
    if (existsSync(join(pdir, 'collect'))) kill(join(pdir, 'collect'));
  }
  // intermediate frames of mobile.mjs (a finding that points to one keeps it)
  const mob = join(run, 'measure', 'mobile');
  if (existsSync(mob)) for (const f of readdirSync(mob)) if (/\.(jpe?g|png)$/i.test(f) && !keep.has(resolve(join(mob, f)))) kill(join(mob, f));
  if (existsSync(join(run, 'verify', 'lint-index'))) kill(join(run, 'verify', 'lint-index')); // word-index cache of lint-findings
  return { files, bytes };
}

// ---------------------------------------------------------------- rivals.html + rivals.xlsx
async function buildRivals(run, cfg, ctx) {
  const rv = join(run, 'rivals');
  if (!existsSync(rv)) return { fatal: M('Нет папки rivals/ — сначала rivals.mjs.', 'rivals/ not found — run rivals.mjs first.') };
  const errors = []; const warnings = cfg.warnings;
  const R = tr('rivals');
  const summaryR = readMaybe(join(rv, 'summary.json'), {}) || {};
  const matrix = readMaybe(join(rv, 'matrix.json'), null);
  const bestof = arr(readMaybe(join(rv, 'best-of.json'), []));
  const ideasRaw = readMaybe(join(rv, 'ideas.json'), []);
  const ideas = arr(Array.isArray(ideasRaw) ? ideasRaw : ideasRaw?.ideas).filter(x => x && isStr(x.title));
  const directions = arr(Array.isArray(ideasRaw) ? readMaybe(join(rv, 'directions.json'), []) : ideasRaw?.directions).filter(Boolean);
  const cards = [];
  for (const h of readdirSync(rv)) { const c = readMaybe(join(rv, h, 'card.json'), null); if (c && !c.__error) cards.push({ host: h, ...c }); }
  const brief = readMaybe(join(run, 'brief.json'), {}) || {};
  ctx.pages = pagesIndex(run); ctx.aud = 'owner'; ctx.gl = loadGlossary(cfg.lang);
  const host = brief.host || cfg.flags.host || U.hostOf(cfg.flags.url || '') || '';
  const title = cfg.title || fill(tr('default_title_rivals'), { site: host });
  ideas.forEach((x, i) => { if (!isStr(x.id)) x.id = `i-${String(i + 1).padStart(2, '0')}`; });
  const blockName = b => (isStr(b) ? (R.block_types && R.block_types[b]) || b : '');

  // crops: finds (crop = region), best-of examples, idea shots
  const idxCache = new Map(); const jobs = [];
  const regionJob = (shot, crop) => {
    if (!isStr(shot)) return null;
    let abs; try { abs = U.insideRun(run, String(shot).replace(/\\/g, '/')); } catch { return null; }
    if (!existsSync(abs)) return null;
    let sz; try { sz = imageSize(abs); } catch { sz = null; }
    if (!sz) return null;
    let rect = validBox(crop) ? crop.map(Number) : [0, 0, sz.w, Math.min(sz.h, Math.round(sz.w * 0.75))];
    const pad = 8;
    rect = [Math.max(0, rect[0] - pad), Math.max(0, rect[1] - pad), rect[2] + 2 * pad, rect[3] + 2 * pad];
    rect[2] = Math.min(sz.w - rect[0], rect[2]); rect[3] = Math.min(sz.h - rect[1], rect[3]);
    if (rect[2] <= 0 || rect[3] <= 0) return null;
    rect = rect.map(Math.round);
    const outW = Math.min(800, rect[2]);
    const j = { src: abs, srcRel: shot, rect, frame: null, outW, key: sha(JSON.stringify({ v: CROP_VERSION, shot, rect, outW })) };
    jobs.push(j); return j;
  };
  const shotOf = s => (typeof s === 'string' ? { shot: s } : s || {});
  for (const c of cards) for (const f of arr(c.finds)) f._job = regionJob(f.shot, f.crop);
  for (const b of bestof) for (const e of arr(b.examples)) e._job = regionJob(e.shot, e.crop);
  for (const i of ideas) {
    const n = shotOf(i.now_shot); i._now = n.shot ? (n.box ? (() => { const c = planCrop(run, { shot: n.shot, box: n.box, viewport: n.viewport }, idxCache, { maxOut: 800 }); if (c.key) jobs.push(c); return c.key ? c : null; })() : regionJob(n.shot, n.crop)) : null;
    i._seen = arr(i.seen_shots).slice(0, 3).map(shotOf).map(s => ({ host: s.host || '', job: regionJob(s.shot, s.crop) }));
  }
  const uniq = [...new Map(jobs.filter(Boolean).map(j => [j.key, j])).values()];
  await makeCrops(ctx, uniq);
  const fileOf = j => { if (!j) return null; const u = uniq.find(x => x.key === j.key); return u && !u.error && existsSync(u.file) ? u.file : null; };
  if (ctx.partial) return { partial: true, stage: 'crops' };
  const img = (j, alt, cap = '') => { const f = fileOf(j); return f ? `<figure><img src="data:image/jpeg;base64,${readFileSync(f).toString('base64')}" alt="${esc(alt)}">${cap ? `<figcaption>${esc(cap)}</figcaption>` : ''}</figure>` : ''; };

  // body
  const gl = ctx.gl; const sc = new Set();
  const out = []; const toc = [];
  const add = (id, label, html, o) => { if (!html) return; toc.push([id, label]); out.push(section(id, label, html, o)); };
  const lines = arr(summaryR.lines).filter(isStr).length ? arr(summaryR.lines).filter(isStr)
    : arr(summaryR.items).map(x => (typeof x === 'string' ? x : x?.line || x?.text)).filter(isStr);
  // a tile: «3 / 4» big, the line without «у 3 из 4» under it (the number is not repeated)
  const tiles = lines.slice(0, 6).map(l => {
    const m = l.match(/\s*[—–-]?\s*(?:(?:у|у\s+них|of)\s+)?(\d+)\s*(?:из|of|\/)\s*(\d+)/i);
    const label = m ? (l.slice(0, m.index) + l.slice(m.index + m[0].length)).replace(/\s+[—–-]\s*$/, '').replace(/\s{2,}/g, ' ').trim() : l;
    return `<div class="tile"><div class="n">${m ? `${esc(m[1])}<span class="of"> / ${esc(m[2])}</span>` : '—'}</div><div class="l">${plain(label || l, gl, sc)}</div></div>`;
  });
  let head = `<header class="top"><div class="domain">${esc(host)} · ${esc(fmtDate(cfg.state.started))}</div><h1>${esc(title)}</h1>${tiles.length ? `<div class="tiles">${tiles.join('')}</div>` : ''}`;
  if (directions.length) add('directions', R.directions, ulist(directions, d => {
    const t = typeof d === 'string' ? d : d.title || d.name || '';
    const rest = typeof d === 'object' ? Object.entries(d).filter(([k, v]) => !['title', 'name', 'id', 'shots'].includes(k) && isStr(v)).map(([, v]) => plain(v, gl, sc)) : [];
    return `<b>${plain(t, gl, sc)}</b>${rest.length ? `<br>${rest.join('<br>')}` : ''}`;
  }));
  const ranked = [...ideas].sort((a, b) => (Number(b.benefit) || 0) * (Number(b.ease) || 0) - (Number(a.benefit) || 0) * (Number(a.ease) || 0));
  const ideaHtml = (x, withMarks) => {
    const shots = [img(x._now, R.now, R.now), ...x._seen.map(s => img(s.job, `${R.seen}: ${s.host}`, `${R.seen}: ${s.host}`))].filter(Boolean);
    const meta = [isStr(x.page) && `${R.page}: ${esc(x.page)}`, isStr(x.who) && esc(x.who), isStr(x.effort) && esc(effortWord(x.effort, 'owner') || x.effort),
      (x.benefit || x.ease) && `${R.benefit} ${esc(x.benefit ?? '—')} · ${R.ease} ${esc(x.ease ?? '—')}`].filter(Boolean).join(' · ');
    const marks = withMarks ? `<div class="marks">${['take', 'no', 'discuss'].map(v => `<label><input type="radio" name="m-${esc(x.id)}" value="${v}" data-idea="${esc(x.id)}" data-title="${esc(x.title)}">${esc(R[v])}</label>`).join('')}</div>` : '';
    return `<article class="idea" id="${esc(x.id)}"><div class="head"><span class="rid">${esc(x.id)}</span> <span class="muted small">${meta}</span></div><h3>${plain(x.title, gl, sc)}</h3>` +
      `${isStr(x.propose) ? `<p><b>${esc(R.propose)}:</b> ${plain(x.propose, gl, sc)}</p>` : ''}${isStr(x.closes) ? `<p><b>${esc(R.closes)}:</b> ${plain(x.closes, gl, sc)}</p>` : ''}` +
      `${isStr(x.evidence) ? `<p class="small"><b>${esc(R.evidence)}:</b> ${plain(x.evidence, gl, sc)}</p>` : ''}${isStr(x.risk) ? `<p class="small muted"><b>${esc(R.risk)}:</b> ${plain(x.risk, gl, sc)}</p>` : ''}` +
      `${shots.length ? `<div class="shots">${shots.join('')}</div>` : ''}${marks}</article>`;
  };
  const top = ranked.slice(0, 10);
  if (top.length) add('top', R.top, `<div class="ideas">${top.map(x => ideaHtml(x, true)).join('')}</div>`, { count: top.length });
  const rest = ranked.slice(10);
  if (rest.length) add('ideas', R.ideas, `<div class="ideas">${rest.map(x => ideaHtml(x, true)).join('')}</div>`, { count: rest.length });
  if (ideas.length) add('marks-box', R.marks, `<div id="marks" class="copybox" data-take="${esc(R.take)}" data-no="${esc(R.no)}" data-discuss="${esc(R.discuss)}" data-copied="${esc(R.copied)}" data-fail="${esc(R.copy_fail)}">` +
    `<p class="muted small">${esc(R.marks_hint)}</p><button type="button" id="marks-copy">${esc(R.copy)}</button> <span id="marks-status" class="muted small"></span><textarea id="marks-text" readonly aria-label="${esc(R.marks)}"></textarea></div>`);
  if (bestof.length) add('bestof', R.bestof, `<div class="ideas">${bestof.map(b => `<article class="idea"><div class="head"><span class="muted small">${esc(blockName(b.block_type))}</span></div><h3>${plain(b.idea, gl, sc)}</h3>` +
    `${isStr(b.for_us) ? `<p>${plain(b.for_us, gl, sc)}</p>` : ''}<div class="shots">${arr(b.examples).map(e => img(e._job, e.host || '', e.host || '')).join('')}</div></article>`).join('')}</div>`);
  if (matrix && !matrix.__error && arr(matrix.rows).length) {
    const sites = arr(matrix.sites).map(String);
    add('matrix', R.matrix, `<div class="scroll-x"><table class="tbl"><thead><tr><th></th>${sites.map((s, i) => `<th${i === 0 ? ' class="ours"' : ''}>${esc(s)}</th>`).join('')}</tr></thead><tbody>` +
      arr(matrix.rows).map(r => `<tr><td class="t">${esc(r.param)}${typeof r.ours_rank === 'number' ? ` <span class="cellrank">${esc(R.rank)} ${r.ours_rank}</span>` : ''}</td>${sites.map(s => `<td>${esc(r.values?.[s] ?? '—')}</td>`).join('')}</tr>`).join('') + '</tbody></table></div>');
  }
  if (cards.length) add('gallery', R.gallery, cards.map(c => {
    const finds = arr(c.finds).map(f => `<div class="find"><div class="k">${esc(R.kind?.[f.kind] || f.kind || '')}${isStr(f.block_type) ? ` · ${esc(blockName(f.block_type))}` : ''}${typeof f.strength === 'number' ? ` · ${f.strength}/5` : ''}</div>${img(f._job, f.what || '')}<p><b>${plain(f.what, gl, sc)}</b></p>${isStr(f.why) ? `<p class="small">${plain(f.why, gl, sc)}</p>` : ''}</div>`).join('');
    const lists = [['strong', R.strong], ['weak', R.weak], ['not_visible', R.not_visible]].map(([k, l]) => (arr(c[k]).length ? `<p class="small"><b>${esc(l)}:</b> ${arr(c[k]).map(x => esc(typeof x === 'string' ? x : x?.what || '')).join('; ')}</p>` : '')).join('');
    const href = safeHref(c.url);
    return `<h3 class="sub" id="site-${esc(c.host)}">${href ? `<a href="${esc(href)}" rel="noopener noreferrer">${esc(c.host)}</a>` : esc(c.host)}</h3>${lists}<div class="gallery">${finds}</div>`;
  }).join(''));
  head += toc.length > 3 ? `<nav class="toc">${toc.map(([id, l]) => `<a href="#${esc(id)}">${esc(l)}</a>`).join('')}</nav>` : '';
  head += '</header>';
  const body = head + out.join('') + `<footer class="foot">${esc(tr('footer', { version: U.VERSION, date: fmtDate() }))}</footer>`;
  const script = readFileSync(join(TPL, 'rivals.js'), 'utf8');
  if (/<\/script/i.test(script)) return { fatal: 'templates/rivals.js: </script>' };
  const html = pageHtml('rivals.html', { cfg, title, body, script, key: sha(host || run, 10) });
  const htmlPath = join(run, 'report', 'rivals.html');
  U.writeText(htmlPath, html);

  // xlsx
  const xlsxPath = join(run, 'report', 'rivals.xlsx');
  const dec = cfg.lang === 'en' ? ['Decision', 'Comment'] : ['Решение', 'Комментарий'];
  writeXlsx(xlsxPath, { creator: 'Revizor', sheets: [
    { name: cfg.lang === 'en' ? 'Ideas' : 'Идеи', freeze: true, autoFilter: true,
      columns: ['id', R.top, R.propose, R.page, R.closes, 'who', 'effort', R.benefit, R.ease, R.evidence, R.risk, ...dec].map((h, i) => ({ header: h, width: [8, 36, 50, 18, 30, 12, 10, 8, 8, 40, 30, 14, 30][i] })),
      rows: ranked.map(x => [x.id, x.title, x.propose || '', x.page || '', x.closes || '', x.who || '', effortWord(x.effort, 'owner') || x.effort || '', x.benefit ?? '', x.ease ?? '', x.evidence || '', x.risk || '', '', '']),
      validations: [{ col: 'L', list: [R.take, R.no, R.discuss] }] },
    { name: cfg.lang === 'en' ? 'Comparison' : 'Сравнение', columns: ['', ...arr(matrix?.sites).map(String)].map(h => ({ header: h, width: 22 })),
      rows: arr(matrix?.rows).map(r => [r.param, ...arr(matrix?.sites).map(s => r.values?.[s] ?? '')]) },
    { name: cfg.lang === 'en' ? 'Best of' : 'Лучшее', columns: [R.block, R.top, R.for_us, R.hosts].map(h => ({ header: h, width: 30 })),
      rows: bestof.map(b => [blockName(b.block_type), b.idea || '', b.for_us || '', arr(b.examples).map(e => e.host).filter(Boolean).join(', ')]) },
    { name: cfg.lang === 'en' ? 'Finds' : 'Находки', freeze: true, autoFilter: true, columns: ['host', 'id', 'kind', R.block, 'what', 'why', 'quote', 'strength'].map(h => ({ header: h, width: h === 'what' || h === 'why' || h === 'quote' ? 40 : 14 })),
      rows: cards.flatMap(c => arr(c.finds).map(f => [c.host, f.id || '', R.kind?.[f.kind] || f.kind || '', blockName(f.block_type), f.what || '', f.why || '', f.quote || '', f.strength ?? ''])) },
  ] });

  let shots = null;
  if (cfg.shots) { shots = await shootReport(ctx, htmlPath, 'rivals', { dark: !cfg.css }); if (shots.error) warnings.push(M(`кадры отчёта: ${shots.error}`, `report shots: ${shots.error}`)); }
  // self-check: exactly one script, its hash in CSP; no handlers or active tags; all idea ids present
  const act = activeContent(html);
  if (act.scripts !== 1) errors.push({ rule: 'script', where: 'rivals.html', text: M(`скриптов ${act.scripts}, нужен 1`, `${act.scripts} scripts, 1 expected`) });
  if (act.problems.length) errors.push({ rule: 'script', where: 'rivals.html', text: M(`активная разметка: ${[...new Set(act.problems)].slice(0, 5).join(', ')}`, `active markup: ${[...new Set(act.problems)].slice(0, 5).join(', ')}`) });
  const missing = ideas.filter(x => !html.includes(`id="${esc(x.id)}"`)).map(x => x.id);
  if (missing.length) errors.push({ rule: 'ids', where: 'rivals.html', text: M(`нет идей: ${missing.join(', ')}`, `missing ideas: ${missing.join(', ')}`) });
  const res = { ok: !errors.length, generated: U.nowIso(), mode: 'rivals', errors, warnings };
  U.writeJSON(join(run, 'report', 'selfcheck.json'), res);
  return { ok: res.ok, check: res, htmlPath, htmlBytes: Buffer.byteLength(html), xlsxPath, shots, ideas: ideas.length, cards: cards.length, warnings };
}

// ---------------------------------------------------------------- recheck.html
async function buildRecheck(run, cfg, ctx) {
  const dir = join(run, 'recheck');
  const result = readMaybe(join(dir, 'result.json'), null);
  if (!result || result.__error) return { fatal: M('Нет recheck/result.json — сначала recheck.mjs --collect.', 'recheck/result.json not found — run recheck.mjs --collect first.') };
  const errors = []; const warnings = cfg.warnings;
  const RC = tr('recheck');
  ctx.pages = pagesIndex(run); ctx.aud = cfg.audience; ctx.gl = loadGlossary(cfg.lang);
  const brief = readMaybe(join(run, 'brief.json'), {}) || {};
  ctx.platform = brief.platform?.name || null;
  let items = arr(result.items);
  if (!items.length) for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    if (!/\.json$/.test(f) || ['plan.json', 'result.json'].includes(f)) continue;
    const g = readMaybe(join(dir, f), null); if (g && !g.__error) items.push(...arr(g.items));
  }
  // originals by uid: the previous run's findings or the registry the recheck started from;
  // a registry inside <RUN>/report/ also gives that run's findings (old frames for «before»)
  const orig = new Map();
  const plan = readMaybe(join(dir, 'plan.json'), {}) || {};
  const from = result.from || plan.from || cfg.flags.from || cfg.flags.from_run || null;
  let srcRun = null;
  if (isStr(from)) {
    try {
      const abs = resolve(from);
      if (/\.xlsx$/i.test(abs) && existsSync(abs)) {
        if (basename(dirname(abs)) === 'report' && existsSync(join(dirname(dirname(abs)), 'report', 'findings.json'))) srcRun = dirname(dirname(abs));
        const wb = readXlsx(abs);
        const hid = wb.sheets.find(s => s.name === '_revizor');
        const main = wb.sheets.find(s => s.name !== '_revizor' && findColumns(s.rows).cols.rid !== undefined);
        const ridToTitle = new Map();
        if (main) { const fc = findColumns(main.rows); for (const r of main.rows.slice(fc.row + 1)) if (r[fc.cols.rid]) ridToTitle.set(String(r[fc.cols.rid]), { title: String(r[fc.cols.what] ?? '').split('\n')[0] }); }
        if (hid) { const fc = findColumns(hid.rows, { uid: ['uid'], rid: ['rid'], url: ['url'] }); for (const r of hid.rows.slice(fc.row + 1)) if (r[fc.cols.uid] && /^R-/.test(String(r[fc.cols.uid]))) { const rid = String(r[fc.cols.rid] ?? ''); orig.set(String(r[fc.cols.uid]), { rid, title: ridToTitle.get(rid)?.title || '', url: r[fc.cols.url] || '', severity: /^P[0-3]/.test(rid) ? rid.slice(0, 2) : 'P3', where: [] }); } }
      } else if (existsSync(join(abs, 'report', 'findings.json'))) srcRun = abs;
      if (srcRun) for (const it of normItems(readMaybe(join(srcRun, 'report', 'findings.json'), {})?.items)) if (it.uid) orig.set(it.uid, { ...(orig.get(it.uid) || {}), ...it });
    } catch (e) { warnings.push(M(`исходный прогон/реестр не прочитан: ${e.message}`, `source run/registry not read: ${e.message}`)); }
  }
  const statuses = ['regressed', 'not_fixed', 'partial', 'fixed', 'cannot_check', 'not_applicable'];
  const norm = items.filter(x => x && isStr(x.uid)).map(x => {
    const o = orig.get(x.uid) || {};
    const severity = /^P[0-3]$/.test(String(x.severity || o.severity)) ? String(x.severity || o.severity) : 'P3';
    return { ...x, rid: x.rid || o.rid || '', title: x.title || o.title || x.uid, severity, s: sevNum(severity), url: x.url || o.where?.[0]?.url || o.url || '', status: statuses.includes(x.status) ? x.status : 'cannot_check', _o: o };
  });
  // «after» = the rechecker's frame; «before» = the old frame of the same finding, same aspect and width
  const idxCache = new Map(); const jobs = [];
  for (const x of norm) {
    if (isStr(x.shot)) { const c = planCrop(run, { shot: x.shot, box: x.box, box_space: x.box_space, viewport: x.viewport }, idxCache, { maxOut: 600 }); if (c.key) { x._crop = c; jobs.push(c); } }
    const ow = arr(x._o.where).find(w => w && (isStr(w.shot) || (w.crop && isStr(w.crop.shot)) || (w.box && w.pid)));
    if (srcRun && ow) {
      const c = planCrop(srcRun, ow, idxCache, x._crop ? { aspect: x._crop.rect[3] / x._crop.rect[2], outW: x._crop.outW } : { maxOut: 600 });
      if (c.key) { x._old = c; jobs.push(c); }
    }
  }
  const newItems = normItems(result.new);
  newItems.forEach((it, i) => { it.rid = it.rid || `N-${String(i + 1).padStart(2, '0')}`; });
  const newCrop = new Map();
  for (const it of newItems) { const w = it.where.find(w => isStr(w.shot)); if (w) { const c = planCrop(run, w, idxCache); if (c.key) { newCrop.set(it.rid, [{ w, crop: c }]); jobs.push(c); } } }
  const uniq = [...new Map(jobs.map(j => [j.key, j])).values()];
  await makeCrops(ctx, uniq);
  if (ctx.partial) return { partial: true, stage: 'crops' };
  const fileOf = c => { const u = c && uniq.find(j => j.key === c.key); return u && !u.error && existsSync(u.file) ? u.file : null; };
  ctx.imgSrc = f => (f && existsSync(f) ? `data:image/jpeg;base64,${readFileSync(f).toString('base64')}` : null);
  ctx.cropsFor = it => (newCrop.get(it.rid) || []).map(x => ({ ...x, crop: { ...x.crop, file: fileOf(x.crop) } })).filter(x => x.crop.file);
  ctx.pairFor = null;

  const gl = ctx.gl; const sc = new Set();
  const host = brief.host || cfg.flags.host || '';
  const title = cfg.title || fill(tr('default_title_recheck'), { site: host });
  const cnt = Object.fromEntries(statuses.map(s => [s, norm.filter(x => x.status === s).length]));
  const tiles = statuses.filter(s => cnt[s] || ['fixed', 'not_fixed'].includes(s)).map(s => `<div class="tile ${s === 'regressed' ? 's0' : s === 'not_fixed' ? 's1' : s === 'fixed' ? 'ok' : 's3'}"><div class="n">${cnt[s]}</div><div class="l">${esc(RC.status[s])}</div></div>`);
  if (newItems.length) tiles.push(`<a class="tile s2" href="#new"><div class="n">${newItems.length}</div><div class="l">${esc(RC.new)}</div></a>`);
  const out = [];
  const head = `<header class="top"><div class="domain">${esc(host)}${cfg.audience !== 'external' ? ` · ${esc(fmtDate(cfg.state.started))}` : ''}</div><h1>${esc(title)}</h1><div class="tiles">${tiles.join('')}</div></header>`;
  const fig = (file, label) => (file ? `<figure class="fig"><img src="${ctx.imgSrc(file)}" alt="${esc(label)}"><figcaption><b>${esc(label)}</b></figcaption></figure>` : '');
  const rowHtml = x => {
    const fNew = fileOf(x._crop), fOld = fileOf(x._old);
    const href = safeHref(x.url);
    const pics = fOld && fNew ? `<div class="shotpair">${fig(fOld, RC.before)}${fig(fNew, RC.after)}</div>` : fNew ? fig(fNew, RC.after) : fOld ? fig(fOld, RC.before) : '';
    return `<tr id="${esc(x.uid)}"><td class="c-rid"><span class="rid">${esc(x.rid || '')}</span></td><td data-l="${esc(tr('cols.what'))}"><span class="t">${plain(x.title, gl, sc)}</span>${href ? `<div class="small"><a href="${esc(href)}" rel="noopener noreferrer">${esc(shortPath(href) === '/' ? tr('home') : shortPath(href))}</a></div>` : ''}</td>` +
      `<td data-l="${esc(RC.note)}">${rich(cfg.audience === 'external' ? splitEvidence(x.evidence).fact : x.evidence, gl, sc)}${isStr(x.note) ? `<p class="small muted">${plain(x.note, gl, sc)}</p>` : ''}${pics}</td></tr>`;
  };
  const table = list => `<table class="tbl stack rc"><thead><tr><th>${esc(tr('cols.rid'))}</th><th>${esc(tr('cols.what'))}</th><th>${esc(RC.note)}</th></tr></thead><tbody>${list.map(rowHtml).join('')}</tbody></table>`;
  const reg = norm.filter(x => x.status === 'regressed');
  if (reg.length) out.push(section('regressions', RC.regressions, table(reg), { count: reg.length }));
  const groupsHtml = statuses.filter(s => s !== 'regressed' && cnt[s]).map(s => detailsGroup(`st-${s}`, RC.status[s], cnt[s], table(norm.filter(x => x.status === s)), s === 'not_fixed' || s === 'partial')).join('');
  if (groupsHtml) out.push(section('items', RC.items, groupsHtml, { count: norm.length }));
  if (newItems.length) out.push(section('new', RC.new, `<div class="cards">${newItems.map(it => cardHtml(it, ctx)).join('')}</div>`, { count: newItems.length }));
  const foot = cfg.audience === 'external' ? '' : `<footer class="foot">${esc(tr('footer', { version: U.VERSION, date: fmtDate() }))}</footer>`;
  const html = pageHtml('report.html', { cfg, title, body: head + out.join('') + foot });
  const htmlPath = join(run, 'report', 'recheck.html');
  U.writeText(htmlPath, html);
  let shots = null;
  if (cfg.shots) { shots = await shootReport(ctx, htmlPath, 'recheck', { dark: !cfg.css }); if (shots.error) warnings.push(M(`кадры отчёта: ${shots.error}`, `report shots: ${shots.error}`)); }
  const act = activeContent(html);
  if (act.scripts) errors.push({ rule: 'script', where: 'recheck.html', text: M('<script> в отчёте', '<script> in the report') });
  if (act.problems.length) errors.push({ rule: 'script', where: 'recheck.html', text: M(`активная разметка: ${[...new Set(act.problems)].slice(0, 5).join(', ')}`, `active markup: ${[...new Set(act.problems)].slice(0, 5).join(', ')}`) });
  const missing = norm.filter(x => !html.includes(`id="${esc(x.uid)}"`)).map(x => x.uid);
  if (missing.length) errors.push({ rule: 'uid', where: 'recheck.html', text: M(`нет: ${missing.slice(0, 10).join(', ')}`, `missing: ${missing.slice(0, 10).join(', ')}`) });
  if (srcRun === null && norm.length) warnings.push(M('исходный прогон не найден — «было» без старых кадров', 'source run not found — «before» without old frames'));
  const res = { ok: !errors.length, generated: U.nowIso(), mode: 'recheck', errors, warnings };
  U.writeJSON(join(run, 'report', 'selfcheck.json'), res);
  return { ok: res.ok, check: res, htmlPath, htmlBytes: Buffer.byteLength(html), shots, counts: cnt, newCount: newItems.length, pairs: norm.filter(x => fileOf(x._old) && fileOf(x._crop)).length, warnings };
}

// ---------------------------------------------------------------- main
async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'pdf', 'scores', 'open', 'renumber', 'keep-raw', 'shots', 'recrop', 'cleanup'], multi: ['status'] });
  U.helpAndExit(HELP, args);
  const run = U.requireRun(args);
  const cfg = settings(args, run);
  loadStrings(cfg.lang);
  CUR_AUD = cfg.audience;
  const en = cfg.lang === 'en';
  const T0 = Date.now();
  const partialPath = join(run, 'report', 'report.partial.json');
  const prevPartial = readMaybe(partialPath, null);
  // --recrop continued after a time-budget stop: crops made since the first attempt are kept
  const recropSince = cfg.recrop && prevPartial && !prevPartial.__error && prevPartial.recrop_since ? Number(prevPartial.recrop_since) : T0;
  const ctx = { run, deadline: T0 + cfg.budgetMs - 15000, recrop: cfg.recrop, recropSince, partial: false, br: null,
    resumeShots: prevPartial && !prevPartial.__error && prevPartial.resume?.stopped_at === 'shots' && prevPartial.shots?.hash ? prevPartial.shots : null };
  ctx.shotsLate = () => Date.now() > ctx.deadline;
  ctx.br = browserCtx(ctx);
  ctx.toolPage = () => ctx.br.toolPage();
  ctx.say = m => U.progress(`report.mjs: ${m} (${Math.round((Date.now() - T0) / 1000)} s)`);
  U.ensureDir(U.insideRun(run, 'report'));
  if (cfg.flags.private_host && cfg.flags.host) U.allowPrivateHost(cfg.flags.host);

  let r;
  try {
    U.progress(`report.mjs: ${cfg.mode}, ${cfg.audience}, ${cfg.lang}`);
    if (cfg.mode === 'rivals') r = await buildRivals(run, cfg, ctx);
    else if (cfg.mode === 'recheck') r = await buildRecheck(run, cfg, ctx);
    else r = await buildMain(run, cfg, ctx);
  } catch (e) {
    await ctx.br.close();
    U.printAndSaveSummary(run, NAME, [`report.mjs — ${en ? 'FAILED' : 'СБОЙ'}: ${e.message}`, ...(e.stack || '').split('\n').slice(1, 4).map(s => '  ' + s.trim())]);
    U.log(run, `report.mjs: ${en ? 'failure' : 'сбой'} ${e.message}`);
    process.exit(1);
  }
  await ctx.br.close();
  if (r.fatal) { U.printAndSaveSummary(run, NAME, [`report.mjs — ${r.fatal}`]); process.exit(2); }
  if (r.partial) {
    const sp = r.stage === 'shots' && ctx.shotProg ? { prefix: ctx.shotProg.prefix, hash: ctx.shotProg.hash, pdf: ctx.shotProg.pdf } : null;
    const tries = r.stage === 'shots' && ctx.resumeShots ? (Number(prevPartial.shots_tries) || 1) + 1 : 1;
    U.writeJSON(partialPath, { partial: true, resume: { done: [r.stage === 'crops' ? 'data' : 'html'], stopped_at: r.stage }, shots: sp, shots_tries: r.stage === 'shots' ? tries : 0,
      recrop_since: cfg.recrop ? recropSince : null, generated: U.nowIso() });
    const sm = ctx.shotProg ? (en ? ` Shots: ${ctx.shotProg.made} new, ${ctx.shotProg.kept} kept.` : ` Кадры: новых ${ctx.shotProg.made}, взято готовых ${ctx.shotProg.kept}.`) : '';
    const tail = r.stage === 'shots'
      ? (tries >= 2 ? (en ? ` Shot pieces are kept; the budget is short for this report: rerun with a larger --budget-sec (e.g. ${Math.round(cfg.budgetMs / 1000) * 2 + 60}).` : ` Готовые куски сохранены, но бюджет мал для этого отчёта: повторите с бо́льшим --budget-sec (например, ${Math.round(cfg.budgetMs / 1000) * 2 + 60}).`)
        : (en ? ' Run the same command again: shot pieces already made are kept.' : ' Повторите ту же команду: готовые куски кадров сохранятся.'))
      : (en ? ' Run the same command again: crops are cached.' : ' Повторите ту же команду: готовые кропы возьмутся из кэша.');
    U.printAndSaveSummary(run, NAME, [(en ? `report.mjs — PARTIAL (time budget, stopped at ${r.stage}).` : `report.mjs — ЧАСТИЧНО (бюджет времени, остановился на этапе ${r.stage}).`) + sm + tail]);
    process.exit(75);
  }
  rmSync(partialPath, { force: true });

  // cleanup of raw frames after a good full/quick report
  let cleaned = null;
  if (r.ok && ['full', 'quick'].includes(cfg.mode) && !cfg.keepRaw) cleaned = cleanupRaw(run, ctx.keepSrc);

  const P = p => fwd(p);
  const lines = [];
  const L = s => sevLabel(s, cfg.audience);
  lines.push(`report.mjs — ${cfg.mode} · ${cfg.audience} · ${cfg.lang} · ${Math.round((Date.now() - T0) / 1000)} ${en ? 's' : 'с'}`);
  if (r.counts && !('fixed' in r.counts)) lines.push(`${en ? 'Findings' : 'Находки'}: ${[0, 1, 2, 3].map(s => `${L(s)} ${r.counts[`P${s}`]}`).join(' · ')} (${en ? 'total' : 'всего'} ${r.items.length})${r.droppedExt?.length ? `; ${en ? 'removed for the client' : 'снято для заказчика'}: ${r.droppedExt.length}${r.emap && Object.keys(r.emap).length ? `, ${en ? 'renumbered' : 'перенумеровано'} ${Object.keys(r.emap).length}` : ''} → report/external-view.json` : ''}${r.finalizeDropped?.length ? `; ${en ? 'removed by finalize' : 'снято finalize'}: ${r.finalizeDropped.length}` : ''}`);
  if (r.counts && 'fixed' in r.counts) lines.push(Object.entries(r.counts).map(([k, v]) => `${tr(`recheck.status.${k}`)} ${v}`).join(' · ') + (r.newCount ? ` · ${tr('recheck.new')} ${r.newCount}` : '') + (r.pairs ? ` · ${en ? 'before/after pairs' : 'пар «было / стало»'} ${r.pairs}` : ''));
  lines.push(`HTML: ${P(r.htmlPath)} (${fmtB(r.htmlBytes, cfg.lang)}${r.cards !== undefined ? `, ${en ? 'cards' : 'карточек'} ${r.cards}` : ''}${r.crops !== undefined ? `, ${en ? 'crops' : 'кропов'} ${r.crops}` : ''}${r.ideas !== undefined ? `, ${en ? 'ideas' : 'идей'} ${r.ideas}` : ''})`);
  if (r.filesVariant) lines.push(`${en ? 'For sending' : 'Для пересылки'}: ${P(r.filesVariant.zip)} (${fmtB(fileSize(r.filesVariant.zip), cfg.lang)})`);
  if (r.xlsxPath && existsSync(r.xlsxPath)) lines.push(`${en ? 'Registry' : 'Реестр'}: ${P(r.xlsxPath)}${r.xlsxInfo ? ` (${r.xlsxInfo.rows} ${en ? 'rows' : 'строк'})` : ''}`);
  if (r.pdfPath) lines.push(existsSync(r.pdfPath) ? `PDF: ${P(r.pdfPath)} (${fmtB(fileSize(r.pdfPath), cfg.lang)}${r.shots?.pdfPages ? `, ${r.shots.pdfPages} ${en ? 'pages' : 'листов'}` : ''})` : `PDF: ${en ? 'not built' : 'не собран'}`);
  if (r.shots?.files?.length) {
    const by = k => r.shots.files.filter(f => basename(f).includes(k)).length;
    const sh = r.shots.sheets, pp = r.shots.pdfPages;
    const sheetsLine = sh ? (pp && sh === pp ? `, ${en ? 'PDF sheets' : 'листы PDF'}: ${sh}` : `, ${en ? `print sheets (approximate; the PDF has ${pp ?? '?'})` : `листы печати (приблизительно; в PDF ${pp ?? '?'})`}: ${sh}`) : '';
    lines.push(`${en ? 'Report shots' : 'Кадры отчёта'}: ${P(join(run, 'report', 'shots'))} — 390: ${by('-390.part')}, 1440: ${by('-1440.part')}${sheetsLine}`);
  }
  if (r.editInfo?.log?.length) lines.push(`edits.json: ${r.editInfo.log.length} ${en ? 'edits applied' : 'правок применено'}${r.editInfo.pinned?.length ? `, ${en ? 'uid written to' : 'uid дописан к'} ${r.editInfo.pinned.length}` : ''}${r.rmap && Object.keys(r.rmap).length ? `; ${en ? 'renumbered' : 'перенумеровано'} ${Object.keys(r.rmap).length} → report/renumber.json` : ''}`);
  const ch = r.check;
  if (ch) {
    if (ch.errors.length) {
      lines.push(`${en ? 'SELF-CHECK FAILED' : 'САМОПРОВЕРКА: ОШИБКИ'} ${ch.errors.length} (report/selfcheck.json):`);
      for (const e of ch.errors.slice(0, 12)) lines.push(`  - [${e.rule}] ${e.where}: ${e.text}`);
      if (ch.errors.length > 12) lines.push(`  … ${en ? 'more' : 'ещё'} ${ch.errors.length - 12}`);
    } else lines.push(en ? 'Self-check: OK' : 'Самопроверка: OK');
    const ws = r.warnings || ch.warnings || [];
    if (ws.length) { lines.push(`${en ? 'Warnings' : 'Предупреждения'}:`); for (const w of ws.slice(0, 7)) lines.push(`  - ${w}`); if (ws.length > 7) lines.push(`  … ${en ? 'more in' : 'ещё в'} report/selfcheck.json: ${ws.length - 7}`); }
  }
  if (cleaned && cleaned.files) lines.push(`${en ? 'Removed raw frames' : 'Удалено промежуточных файлов'}: ${cleaned.files} (${fmtB(cleaned.bytes, cfg.lang)}); ${en ? 'keep them with' : 'оставить —'} --keep-raw`);
  lines.push(`${en ? 'Run folder size' : 'Размер папки прогона'}: ${fmtB(dirSize(run), cfg.lang)}`);
  if (cfg.open && r.htmlPath) {
    try {
      const { openPath } = await import('./open.mjs');
      const o1 = openPath(r.htmlPath); openPath(join(run, 'report'));
      if (!o1.ok) lines.push(`${en ? 'Open it yourself' : 'Откройте сами'}: ${P(r.htmlPath)}`);
    } catch { lines.push(`${en ? 'Open it yourself' : 'Откройте сами'}: ${P(r.htmlPath)}`); }
  }
  U.printAndSaveSummary(run, NAME, lines);
  U.log(run, `report.mjs: ${cfg.mode}/${cfg.audience} ${ch && ch.errors.length ? `${en ? 'self-check errors' : 'самопроверка — ошибок'} ${ch.errors.length}` : en ? 'done' : 'готово'}`);
  process.exit(ch && ch.errors.length ? 1 : 0);
}

const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main();
