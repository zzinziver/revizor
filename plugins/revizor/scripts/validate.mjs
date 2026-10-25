#!/usr/bin/env node
// Revizor — validate.mjs: parse + schema check of the JSON files agents write (formats: knowledge/findings-format.md and the agent files).
// Agents call it right after Write and fix every error before answering the orchestrator.
// Also a library: merge, lint-findings, finalize and show import the schema from here.
//
//   node validate.mjs --file "<RUN>/findings/copy.json" [--type findings] [--json] [--lang en]
//   node validate.mjs --run "<RUN>" --all [--json]

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as U from './lib/util.mjs';

// ---------- language of messages ----------
let LANG = 'ru';
export function setLang(l) { LANG = l === 'en' ? 'en' : 'ru'; }
const M = (ru, en) => (LANG === 'en' ? en : ru);

// ---------- vocabularies ----------
const FALLBACK_LENSES = ['product', 'facts', 'ux', 'visual', 'typography', 'color', 'mobile', 'a11y', 'copy', 'seo-tech', 'seo-content',
  'perf', 'stability', 'forms', 'security', 'privacy', 'legal', 'visitor', 'ecommerce', 'i18n'];
let lensesFromState = null;
try { const st = await import('./state.mjs'); if (Array.isArray(st.AGENT_LENSES)) lensesFromState = st.AGENT_LENSES; } catch { /* fallback */ }
export const KNOWN_LENSES = lensesFromState || FALLBACK_LENSES;

export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'];
export const sevRank = s => SEVERITIES.indexOf(s);                       // -1 = unknown
export const maxSeverity = list => list.filter(s => sevRank(s) >= 0).sort((a, b) => sevRank(a) - sevRank(b))[0] || null;
export const EFFORTS = ['S', 'M', 'L'];
export const CONFIDENCES = ['high', 'medium', 'low'];
export const VERDICTS = ['confirmed', 'adjusted', 'rejected', 'needs_device'];
export const BOX_SPACES = ['css', 'image'];
export const ID_RE = /^[a-z0-9-]+-(r2-|v)?\d{2,3}$/;
export const UID_RE = /^R-[0-9a-f]{8}$/;
export const RID_RE = /^P[0-3]-\d{2,3}$/;
const METHOD_TOKEN = '(?:script:[a-z0-9-]+|probe|axe|fetch|screenshot|dom|manual)';
export const METHOD_RE = new RegExp(`^${METHOD_TOKEN}(?:\\s*[+,;/]\\s*${METHOD_TOKEN})*(?:\\s*\\(.*\\))?$`, 'i');
// fix_place and owner: Russian contract values + English equivalents for --lang en runs
export const FIX_PLACES = ['шаблон', 'общий css', 'блок cms', 'настройки платформы', 'сервер', 'контент', 'внешний сервис',
  'template', 'global css', 'cms block', 'platform settings', 'server', 'content', 'external service'];
export const OWNERS = ['владелец в cms', 'разработчик', 'копирайтер', 'внешний сервис', 'решение владельца',
  'owner in cms', 'developer', 'copywriter', 'external service', 'owner decision'];
const normEnum = s => U.normText(String(s ?? '')).replace(/\s+/g, ' ');
export const inSet = (v, set) => set.includes(normEnum(v));
// evidence: only shortened or rephrased by the editor (finalize refuses new «quotes» and new numbers)
export const REWRITE_FIELDS = ['title', 'problem', 'fix', 'impact', 'after', 'before', 'scenario', 'evidence'];
// Fields that merge.mjs and finalize.mjs set: a lens must not write them (merge strips them).
export const SERVICE_FIELDS = ['uid', 'rid', 'verdict', 'verdict_detail', 'verdict_conflict', 'verdicts_by_member', 'severity_trail', 'severity_lens',
  'merged_from', 'lenses', 'absorbed', 'requires_check', 'critic_raised', 'critic_wants', 'cluster', 'lint', 'lint_repairs', 'schema_issues', 'verify',
  'after_rejected', 'original', 'rewritten', 'text_from', 'box_image', 'box_note', 'crop', 'source', 'files', 'drop_reason', 'stripped'];
const RECHECK_STATUSES = ['fixed', 'partial', 'not_fixed', 'regressed', 'not_applicable', 'cannot_check'];
const BLOCK_TYPES = ['hero', 'demo', 'services', 'steps', 'pricing', 'trust', 'calculator', 'comparison', 'mascot', 'nav', 'form', 'other'];
const CARD_KINDS = ['take', 'adapt', 'avoid'];
// recheck: uid of the registry (R-1a2b3c4d) or a reference to a report number when the run has no uid yet (rid:P1-03)
export const RECHECK_UID_RE = /^(?:R-[0-9a-f]{8}|rid:P[0-3]-\d{2,3})$/;

// A title must name a number or a concrete place.
const MARK_RE = /[\p{N}«»“"`]|(?:^|\s)\/[\p{L}\p{N}_-]|\.(?:jpe?g|png|svg|webp|pdf|js|css|xml|txt|json)(?![\p{L}])/u;
// Acronyms count only when they name a place or an object on the site (SEO, UX, UI are areas, not places)
const ACRONYM_RE = /(?<![\p{L}\p{N}])(?:CTA|FAQ|CSP|HSTS|OG|SPF|DKIM|DMARC|CAA|CORS|COOP|CORP|COEP|TLS|SSL|HTTPS?|DNS|MX|LCP|CLS|INP|TTFB|FCP|TBT|SRI|API|URL|CDN|PDF|SVG|PNG|JPE?G|WEBP|AVIF|GIF|CSS|JS|HTML|XML|RSS|UTM|ИНН|ОГРН|ОГРНИП|КПП|БИК)(?![\p{L}\p{N}])/u;
// Places: stem + a short ending, then a word boundary (so «поле» does not match «полезный», «почта» not «почти»)
const E3 = '\\p{L}{0,3}', E4 = '\\p{L}{0,4}';
const PLACE_RE = new RegExp('(?<![\\p{L}])(?:' + [
  `главн${E3}`, `страниц${E3}`, `шапк${E3}`, `подвал${E3}`, `футер${E3}`, `хедер${E3}`, `перв${E3}\\s+экран${E3}`, `экран${E3}`, 'меню', `бургер${E3}`,
  'форм(?:а|ы|е|у|ой|ам|ами|ах)?', `кнопк${E3}`, `карточк${E3}`, `попап${E3}`, 'всплывающ\\p{L}{0,4}', 'окн(?:о|а|е|у|ом|ами|ах)', 'окон',
  'блок(?:а|е|у|ом|и|ов|ам|ами|ах)?', `раздел${E3}`, `слайдер${E3}`, `баннер${E3}`, 'видео', 'фото(?:графи\\p{L}{0,3})?', `картин${E3}`, `логотип${E3}`,
  'пол(?:е|я|ю|ем|ей|ям|ями|ях)', `ссылк${E3}`, 'ссылок', `заголов${E4}`, `подзаголов${E4}`, `абзац${E3}`, 'спис(?:ок|ка|ке|ку|ком|ки|ков)',
  `таблиц${E3}`, `политик${E3}`, `оферт${E3}`, `согласи${E3}`, `корзин${E3}`, `каталог${E3}`, `оформлени${E3}`, `контакт${E3}`, `отзыв${E3}`,
  'цен(?:а|е|у|ы|ой|ам|ами|ах)?', `прайс${E3}`, `тариф${E3}`, `калькулятор${E3}`, `вкладк${E3}`, 'вкладок', `аккордеон${E3}`, `галере${E3}`,
  `иконк${E3}`, 'иконок', `фавикон${E3}`, `адрес${E3}`, `телефон${E3}`, 'почт(?:а|ы|е|у|ой)', `домен${E3}`, `поддомен${E3}`, `сертификат${E3}`,
  'карт(?:а|ы|е|у|ой)', `чат${E3}`, `виджет${E3}`, `чекбокс${E3}`, `фильтр${E3}`, `пагинаци${E3}`, `крошк${E3}`, `меню${E3}`, `навигаци${E3}`,
  `кабинет${E3}`, 'вход(?:а|е|у|ом)?', `регистраци${E3}`, `стать(?:я|и|е|ю|ей|ям|ях)`, `блог${E3}`, `лендинг${E3}`, `анкет${E3}`,
  'cookie', 'куки', 'robots(?:\\.txt)?', 'sitemap', 'canonical', 'hreflang', 'title', 'description', 'alt', 'meta', 'json-ld', 'og:',
  'header', 'footer', 'hero', 'menu', 'burger', 'forms?', 'buttons?', 'cards?', 'popups?', 'modals?', 'sections?', 'fields?', 'links?', 'headings?',
  'checkout', 'cart', 'catalog', 'banners?', 'pages?', 'tabs?', 'tables?', 'sliders?', 'logo', 'prices?', 'pricing', 'contacts?', 'policy',
  'images?', 'photos?', 'videos?', 'icons?', 'favicon', 'breadcrumbs?', 'navigation', 'nav', 'checkbox(?:es)?', 'widgets?', 'chat',
].join('|') + ')(?![\\p{L}])', 'iu');

// ---------- small helpers ----------
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const isStr = v => typeof v === 'string';
const nonEmpty = v => isStr(v) && v.trim().length > 0;
const isBoolOrNull = v => v === undefined || v === null || typeof v === 'boolean';
const glen = s => [...String(s)].length;
export function validBox(b) {
  return Array.isArray(b) && b.length === 4 && b.every(v => typeof v === 'number' && Number.isFinite(v)) && b[2] > 0 && b[3] > 0 && b[0] >= -2 && b[1] >= -2;
}
export function validViewport(v) {
  if (typeof v === 'number') return v >= 200 && v <= 4000;
  return isStr(v) && /^(all|\d{3,4}(x\d{3,4})?)$/i.test(v.trim());
}
export function titlePlaceOk(t) { const s = String(t || ''); return MARK_RE.test(s) || ACRONYM_RE.test(s) || PLACE_RE.test(s); }

/** Lens and round from a findings/verify file name: copy.json, copy.part2.json, copy.r2.json, seo-tech.r2.part1.json. */
export function parseLensFileName(name) {
  const m = String(name).match(/^([a-z0-9-]+?)((?:\.r2)?)((?:\.part\d+)?)((?:\.r2)?)\.json$/);
  if (!m) return null;
  return { lens: m[1], round: (m[2] || m[4]) ? 2 : 1, part: m[3] ? Number(m[3].slice(5)) : 0 };
}

// ---------- JSON parsing with a useful message ----------
export function parseJsonText(text) {
  if (text == null) return { ok: false, error: M('файл пустой', 'empty file') };
  let t = String(text).replace(/^﻿/, '');
  if (!t.trim()) return { ok: false, error: M('файл пустой', 'empty file') };
  if (/^\s*```/.test(t)) return { ok: false, error: M('в начале файла ``` — уберите обёртку Markdown, нужен чистый JSON', 'file starts with ``` — remove the Markdown fence, plain JSON only') };
  try { return { ok: true, data: JSON.parse(t) }; }
  catch (e) {
    const msg = String(e.message || e);
    const pm = msg.match(/position (\d+)/);
    let where = '', hint = '';
    if (pm) {
      const pos = Number(pm[1]);
      const before = t.slice(0, pos);
      const line = before.split('\n').length, col = pos - before.lastIndexOf('\n');
      const lineText = (t.split('\n')[line - 1] || '').trim().slice(0, 140);
      where = M(` (строка ${line}, столбец ${col}: ${lineText})`, ` (line ${line}, column ${col}: ${lineText})`);
      const prev = before.replace(/\s+$/, '').slice(-1);
      const ch = t[pos];
      if (pos >= t.replace(/\s+$/, '').length) hint = M('файл оборван: не хватает закрывающих скобок (запись прервалась?)', 'file is cut off: closing brackets are missing');
      else if (prev === ',' && (ch === '}' || ch === ']')) hint = M('лишняя запятая перед закрывающей скобкой', 'trailing comma before a closing bracket');
      else if (ch === "'") hint = M('строки и ключи — только в двойных кавычках', 'strings and keys need double quotes');
      else if (ch === '/') hint = M('комментарии в JSON недопустимы', 'comments are not allowed in JSON');
      else if (/[\p{L}\p{N}]/u.test(ch || '') && prev === '"') hint = M('кавычка внутри строки не экранирована: пишите \\" или «ёлочки»', 'unescaped quote inside a string: use \\" or typographic quotes');
      else if (prev === '}' || prev === ']' || prev === '"') hint = M('не хватает запятой между элементами', 'missing comma between items');
    }
    if (/Unexpected end of JSON/i.test(msg)) hint = M('файл оборван: не хватает закрывающих скобок (запись прервалась?)', 'file is cut off: closing brackets are missing');
    if (!hint) {
      // Russian text instead of the English message of Node; English runs keep the original
      if (/Expected double-quoted property name/i.test(msg)) hint = M('ключ должен быть в двойных кавычках', 'keys need double quotes');
      else if (/Expected ',' or/i.test(msg)) hint = M('не хватает запятой или закрывающей скобки', 'a comma or a closing bracket is missing');
      else if (/non-whitespace character after JSON/i.test(msg)) hint = M('после JSON лишний текст (два объекта подряд?)', 'extra text after the JSON (two objects in a row?)');
      else if (/Bad control character/i.test(msg)) hint = M('перевод строки или табуляция внутри строки — пишите \\n', 'a line break or tab inside a string — write \\n');
      else if (/Bad escaped character|Bad Unicode escape/i.test(msg)) hint = M('неверная обратная косая черта внутри строки — пишите \\\\', 'bad backslash escape inside a string — write \\\\');
      else if (/Unexpected token/i.test(msg)) { const c = (msg.match(/Unexpected token '?(.)/) || [])[1]; hint = M(`неожиданный символ${c ? ` «${c}»` : ''}`, `unexpected character${c ? ` "${c}"` : ''}`); }
      else hint = M('синтаксическая ошибка', '');
    }
    const node = LANG === 'en' ? msg.split('\n')[0].slice(0, 160) : '';
    return { ok: false, error: `${M('JSON не разбирается', 'JSON does not parse')}: ${[node, hint].filter(Boolean).join(' — ')}${where}` };
  }
}
export function readJsonFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { return { ok: false, error: `${M('не читается', 'cannot read')}: ${e.message}` }; }
  return parseJsonText(text);
}

// ---------- result collector ----------
class Report {
  constructor(file) { this.file = file; this.errors = []; this.warnings = []; }
  err(path, msg, code = 'schema') { this.errors.push({ path, msg, code }); }
  warn(path, msg, code = 'schema') { this.warnings.push({ path, msg, code }); }
}

// ---------- finding ----------
/**
 * checkFinding(f, path, { lens, idKind: 'lens'|'r2'|'verifier' }) → { errors, warnings, fatal }
 * fatal = the item cannot be a finding at all (no id/title/severity/evidence/where) — merge rejects it.
 */
/** Does `id` belong to `lens` for this kind of file? lens: copy-01; r2: copy-r2-01; verifier: copy-v01. */
export function idOfLens(id, lens, idKind = 'lens') {
  if (typeof id !== 'string' || !lens) return false;
  const tail = idKind === 'r2' ? 'r2-\\d{2,3}' : idKind === 'verifier' ? 'v\\d{2,3}' : '\\d{2,3}';
  const l = String(lens).replace(/[^a-z0-9-]/g, '');
  return l === lens && new RegExp('^' + l + '-' + tail + '$').test(id);
}

export function checkFinding(f, path = 'finding', opts = {}) {
  const r = new Report();
  let fatal = false;
  const E = (p, m, fat = false, code = null) => { r.err(`${path}${p}`, m, code || (fat ? 'schema_fatal' : 'schema')); if (fat) fatal = true; };
  const W = (p, m) => r.warn(`${path}${p}`, m);
  if (!isObj(f)) { E('', M('находка должна быть объектом', 'a finding must be an object'), true); return { ...r, fatal }; }
  // id
  if (!nonEmpty(f.id)) E('.id', M('нет id', 'missing id'), true);
  else {
    if (!ID_RE.test(f.id)) E('.id', M(`«${f.id}» не по образцу <линза>-NN (второй круг <линза>-r2-NN, скептик <линза>-vNN)`, `"${f.id}" does not match <lens>-NN (round two <lens>-r2-NN, skeptic <lens>-vNN)`));
    if (opts.lens) {
      const want = opts.idKind === 'r2' ? `${opts.lens}-r2-NN` : opts.idKind === 'verifier' ? `${opts.lens}-vNN` : `${opts.lens}-NN`;
      if (!idOfLens(f.id, opts.lens, opts.idKind || 'lens')) {
        if (opts.idKind === 'lens' && /-r2-\d+$/.test(f.id)) E('.id', M('id вида -r2- — только в файле второго круга <линза>.r2.json', '-r2- ids belong to <lens>.r2.json only'), false, 'id_foreign');
        else E('.id', M(`id должен быть вида «${want}» — находка с чужим id не попадёт в отчёт`, `id must look like "${want}" — a finding with a foreign id is left out of the report`), false, 'id_foreign');
      }
    }
  }
  const svc = SERVICE_FIELDS.filter(k => f[k] !== undefined);
  if (svc.length) W('', M(`служебные поля (${svc.join(', ')}) ставит merge.mjs — уберите, они будут сброшены`, `service fields (${svc.join(', ')}) are set by merge.mjs — remove them, they are dropped`));
  // title
  if (!nonEmpty(f.title)) E('.title', M('нет title', 'missing title'), true);
  else {
    if (glen(f.title) > 100) E('.title', M(`длиннее 100 знаков (${glen(f.title)})`, `longer than 100 chars (${glen(f.title)})`));
    if (!titlePlaceOk(f.title)) E('.title', M('в заголовке нет ни цифры, ни конкретного места (страница, блок, кнопка, «цитата», H1…)', 'title has neither a number nor a concrete place (page, block, button, "quote", H1…)'));
  }
  // enums
  if (!SEVERITIES.includes(f.severity)) E('.severity', M(`«${f.severity ?? ''}» — нужно P0, P1, P2 или P3`, `"${f.severity ?? ''}" — must be P0, P1, P2 or P3`), true);
  if (!EFFORTS.includes(f.effort)) E('.effort', M(`«${f.effort ?? ''}» — нужно S, M или L`, `"${f.effort ?? ''}" — must be S, M or L`));
  if (!CONFIDENCES.includes(f.confidence)) E('.confidence', M(`«${f.confidence ?? ''}» — нужно high, medium или low`, `"${f.confidence ?? ''}" — must be high, medium or low`));
  if (!nonEmpty(f.category)) E('.category', M('нет category', 'missing category'));
  // where
  if (!Array.isArray(f.where) || !f.where.length) E('.where', M('нужен массив where хотя бы с одним местом', 'where must be a non-empty array'), true);
  else if (!f.where.some(isObj)) E('.where', M('в where нет ни одного места-объекта { pid, viewport, selector… }', 'where has no place object { pid, viewport, selector… }'), true);
  else f.where.forEach((w, i) => {
    const p = `.where[${i}]`;
    if (!isObj(w)) { E(p, M('место должно быть объектом { pid, viewport, selector… } — строка или null будет выброшена', 'a place must be an object { pid, viewport, selector… } — a string or null is dropped')); return; }
    if (!nonEmpty(w.pid) && !nonEmpty(w.url)) E(p, M('нужен pid (home, p01…) или url', 'needs pid (home, p01…) or url'));
    if (w.pid !== undefined && w.pid !== null && !isStr(w.pid)) E(`${p}.pid`, M('pid — строка', 'pid must be a string'));
    if (w.viewport !== undefined && w.viewport !== null && !validViewport(w.viewport)) E(`${p}.viewport`, M(`«${w.viewport}» — нужно 390, 768, 1440, all, другое число или 1366x657`, `"${w.viewport}" — must be 390, 768, 1440, all, a number or 1366x657`));
    if (w.box !== undefined && w.box !== null && !validBox(w.box)) E(`${p}.box`, M('box — 4 числа [x, y, w, h], w и h больше 0', 'box must be 4 numbers [x, y, w, h] with w, h > 0'));
    if (w.box_space !== undefined && w.box_space !== null && !BOX_SPACES.includes(w.box_space)) E(`${p}.box_space`, M('box_space — css или image', 'box_space must be css or image'));
    if (w.box_space === 'image' && !nonEmpty(w.shot)) E(`${p}.shot`, M('для box_space: image нужен shot — кадр, с которого взята рамка', 'box_space: image needs shot — the frame the box was taken from'));
    if (w.shot !== undefined && w.shot !== null && !isStr(w.shot)) E(`${p}.shot`, M('shot — путь к кадру строкой', 'shot must be a path string'));
    if (w.selector !== undefined && w.selector !== null && !isStr(w.selector)) E(`${p}.selector`, M('selector — строка', 'selector must be a string'));
  });
  // evidence and texts
  if (!nonEmpty(f.evidence)) E('.evidence', M('пустое evidence — без доказательства это не находка', 'empty evidence — no evidence, no finding'), true);
  else if (f.evidence.trim().length < 12) W('.evidence', M('слишком короткое доказательство', 'evidence is too short'));
  if (!isStr(f.method) || !METHOD_RE.test(f.method.trim())) E('.method', M(`«${f.method ?? ''}» — нужно script:<имя>, probe, axe, fetch, screenshot, dom или manual (несколько — через +)`, `"${f.method ?? ''}" — must be script:<name>, probe, axe, fetch, screenshot, dom or manual (several joined with +)`));
  for (const k of ['problem', 'impact', 'fix']) if (!nonEmpty(f[k])) E(`.${k}`, M(`нет ${k}`, `missing ${k}`));
  for (const k of ['norm', 'scenario']) if (!nonEmpty(f[k])) W(`.${k}`, M(`нет ${k}`, `missing ${k}`));
  for (const k of ['before', 'after', 'norm', 'scenario', 'fix_check', 'category']) if (f[k] !== undefined && f[k] !== null && !isStr(f[k])) E(`.${k}`, M(`${k} — строка`, `${k} must be a string`));
  if (f.fix_place === undefined || f.fix_place === null || f.fix_place === '') W('.fix_place', M('нет fix_place (по нему реестр группирует правки)', 'missing fix_place (the registry groups fixes by it)'));
  else if (!inSet(f.fix_place, FIX_PLACES)) E('.fix_place', M(`«${f.fix_place}» — одно из: шаблон, общий CSS, блок CMS, настройки платформы, сервер, контент, внешний сервис`, `"${f.fix_place}" — one of: template, global CSS, CMS block, platform settings, server, content, external service`));
  if (f.owner === undefined || f.owner === null || f.owner === '') W('.owner', M('нет owner', 'missing owner'));
  else if (!inSet(f.owner, OWNERS)) E('.owner', M(`«${f.owner}» — одно из: владелец в CMS, разработчик, копирайтер, внешний сервис, решение владельца`, `"${f.owner}" — one of: owner in CMS, developer, copywriter, external service, owner decision`));
  // flags
  for (const k of ['fix_verified', 'needs_decision', 'needs_device_check', 'owner_known', 'taste', 'sitewide']) if (!isBoolOrNull(f[k])) E(`.${k}`, M(`${k} — true или false`, `${k} must be true or false`));
  if (f.confidence === 'low' && !f.needs_device_check && !f.needs_decision) E('.confidence', M('confidence: low только вместе с needs_device_check или needs_decision = true', 'confidence: low requires needs_device_check or needs_decision = true'));
  if (f.taste === true && SEVERITIES.includes(f.severity) && sevRank(f.severity) < 3) E('.severity', M('вкусовое (taste: true) — не выше P3', 'taste: true findings must be P3'));
  if (f.fix_verified === true && !nonEmpty(f.fix_check)) E('.fix_check', M('fix_verified: true — опишите проверку в fix_check (probe --css …)', 'fix_verified: true needs fix_check (probe --css …)'));
  // "after" frame of a verified fix (knowledge/findings-format.md): fix_shot (path from RUN), fix_box [x,y,w,h], fix_box_space css|image, fix_viewport; report passes them as is
  checkFixShot(f, E, W);
  if (f.tags !== undefined && f.tags !== null && !(Array.isArray(f.tags) && f.tags.every(isStr))) E('.tags', M('tags — массив строк', 'tags must be an array of strings'));
  if (f.q !== undefined && f.q !== null && !(isStr(f.q) && /^[ВвBbQq]\d{1,2}$/.test(f.q.trim()))) E('.q', M('q — null или номер вопроса владельца (В1, В2…)', 'q must be null or an owner question id (Q1, Q2…)'));
  if (f.pages_affected_estimate !== undefined && f.pages_affected_estimate !== null && !(typeof f.pages_affected_estimate === 'number' && f.pages_affected_estimate >= 0)) E('.pages_affected_estimate', M('число или null', 'number or null'));
  return { errors: r.errors, warnings: r.warnings, fatal };
}

/** fix_shot / fix_box / fix_box_space / fix_viewport of a finding: types and consistency (never fatal). */
function checkFixShot(f, E, W) {
  const has = k => f[k] !== undefined && f[k] !== null;
  if (has('fix_shot')) {
    if (!nonEmpty(f.fix_shot)) E('.fix_shot', M('fix_shot — путь к кадру «после» от RUN строкой (probe/fix-color-01.jpg)', 'fix_shot must be a path string from RUN (probe/fix-color-01.jpg)'));
    else if (isAbsolute(f.fix_shot) || /^[a-z]:|(^|[\\/])\.\.([\\/]|$)/i.test(f.fix_shot.trim())) E('.fix_shot', M('fix_shot — путь от RUN без «..» и диска (probe/fix-color-01.jpg)', 'fix_shot must be relative to RUN, without ".." or a drive (probe/fix-color-01.jpg)'));
    else if (!/\.(jpe?g|png|webp)$/i.test(f.fix_shot.trim())) W('.fix_shot', M('fix_shot — кадр .jpg или .png', 'fix_shot should be a .jpg or .png frame'));
    if (f.fix_verified !== true) W('.fix_shot', M('кадр «после» есть, а fix_verified не true — в отчёте пары «было / стало» не будет', 'an "after" frame without fix_verified: true — the report shows no before/after pair'));
  }
  if (has('fix_box') && !validBox(f.fix_box)) E('.fix_box', M('fix_box — 4 числа [x, y, w, h], w и h больше 0', 'fix_box must be 4 numbers [x, y, w, h] with w, h > 0'));
  if (has('fix_box_space') && !BOX_SPACES.includes(f.fix_box_space)) E('.fix_box_space', M('fix_box_space — css или image', 'fix_box_space must be css or image'));
  if (has('fix_viewport') && !validViewport(f.fix_viewport)) E('.fix_viewport', M(`«${f.fix_viewport}» — ширина кадра «после»: 390, 768, 1440 или другое число`, `"${f.fix_viewport}" — width of the "after" frame: 390, 768, 1440 or another number`));
  if (!has('fix_shot') && (has('fix_box') || has('fix_box_space') || has('fix_viewport'))) W('.fix_shot', M('рамка или ширина кадра «после» без fix_shot — отчёт их не покажет', 'an "after" box or width without fix_shot — the report ignores them'));
  if (f.fix_verified === true && !has('fix_shot') && (f.severity === 'P0' || f.severity === 'P1')) W('.fix_shot', M('P0–P1 с fix_verified: true без fix_shot — в отчёте не будет пары «было / стало»', 'P0–P1 with fix_verified: true but no fix_shot — the report shows no before/after pair'));
}

// ---------- document validators: each returns Report ----------
function checkArrayOf(r, doc, key, fields, { max, warnMissing = false } = {}) {
  const v = doc[key];
  if (v === undefined || v === null) { if (warnMissing) r.warn(key, M(`нет ${key}`, `missing ${key}`)); return; }
  if (!Array.isArray(v)) { r.err(key, M(`${key} — массив`, `${key} must be an array`)); return; }
  v.forEach((x, i) => {
    if (fields.length === 0) return;
    if (!isObj(x)) { r.err(`${key}[${i}]`, M('элемент — объект', 'item must be an object')); return; }
    for (const fld of fields) if (!nonEmpty(x[fld])) r.err(`${key}[${i}].${fld}`, M(`нет ${fld}`, `missing ${fld}`));
  });
  if (max && v.length > max) r.err(key, M(`не больше ${max} (сейчас ${v.length})`, `at most ${max} (now ${v.length})`));
}

export function checkFindingsDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  r.items = [];
  if (!isObj(doc)) { r.err('', M('ожидается объект { lens, findings: [...] }', 'expected an object { lens, findings: [...] }'), 'schema_fatal'); r.fatalDoc = true; return r; }
  const lens = ctx.lens || doc.lens;
  if (!nonEmpty(doc.lens)) r.err('lens', M('нет lens', 'missing lens'));
  else if (ctx.lens && doc.lens !== ctx.lens) r.err('lens', M(`lens «${doc.lens}» не совпадает с именем файла (${ctx.lens})`, `lens "${doc.lens}" does not match the file name (${ctx.lens})`));
  if (lens && !KNOWN_LENSES.includes(lens)) r.err('lens', M(`неизвестная линза «${lens}»`, `unknown lens "${lens}"`));
  if (!nonEmpty(doc.agent)) r.warn('agent', M('нет agent', 'missing agent'));
  const round = ctx.round || 1;
  if (doc.round !== undefined && doc.round !== round) r.err('round', M(`round ${doc.round}, а файл ${round === 2 ? 'второго' : 'первого'} круга`, `round ${doc.round}, but the file is round ${round}`));
  if (!isObj(doc.coverage)) r.warn('coverage', M('нет coverage (pages, viewports, states, screenshots_viewed…)', 'missing coverage (pages, viewports, states, screenshots_viewed…)'));
  else {
    const c = doc.coverage;
    for (const k of ['pages', 'viewports', 'states']) if (c[k] !== undefined && !Array.isArray(c[k])) r.err(`coverage.${k}`, M('массив', 'must be an array'));
    for (const k of ['checklist_done', 'checklist_total', 'screenshots_viewed']) if (c[k] !== undefined && c[k] !== null && typeof c[k] !== 'number') r.err(`coverage.${k}`, M('число', 'must be a number'));
  }
  if (!Array.isArray(doc.findings)) { r.err('findings', M('нужен массив findings (пусть пустой)', 'findings must be an array (may be empty)'), 'schema_fatal'); r.fatalDoc = true; }
  checkArrayOf(r, doc, 'strengths', ['what', 'why'], { max: 3 });
  checkArrayOf(r, doc, 'for_other_lenses', ['lens', 'note']);
  checkArrayOf(r, doc, 'open_questions', ['question']);
  checkArrayOf(r, doc, 'clean_checks', ['check', 'result']);
  if (doc.not_checked !== undefined && !Array.isArray(doc.not_checked)) r.err('not_checked', M('массив', 'must be an array'));
  if (doc.skills_used !== undefined && !Array.isArray(doc.skills_used)) r.err('skills_used', M('массив', 'must be an array'));
  if (Array.isArray(doc.findings)) {
    const seen = new Set();
    doc.findings.forEach((f, i) => {
      const p = `findings[${i}]${isObj(f) && f.id ? ` (${f.id})` : ''}`;
      const res = checkFinding(f, p, { lens, idKind: round === 2 ? 'r2' : 'lens' });
      r.errors.push(...res.errors); r.warnings.push(...res.warnings);
      if (isObj(f) && f.id) { if (seen.has(f.id)) r.err(`${p}.id`, M(`повтор id «${f.id}» в файле`, `duplicate id "${f.id}" in the file`)); seen.add(f.id); }
      r.items.push({ index: i, id: isObj(f) ? f.id : undefined, fatal: res.fatal, errors: res.errors, warnings: res.warnings });
    });
  }
  return r;
}

export function checkVerifyDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc)) { r.err('', M('ожидается объект { lens, verdicts: [...] }', 'expected an object { lens, verdicts: [...] }'), 'schema_fatal'); r.fatalDoc = true; return r; }
  const lens = ctx.lens || doc.lens;
  if (!nonEmpty(doc.lens)) r.err('lens', M('нет lens', 'missing lens'));
  else if (ctx.lens && doc.lens !== ctx.lens) r.err('lens', M(`lens «${doc.lens}» не совпадает с именем файла (${ctx.lens})`, `lens "${doc.lens}" does not match the file name (${ctx.lens})`));
  if (doc.checked !== undefined && typeof doc.checked !== 'number') r.err('checked', M('число', 'must be a number'));
  if (!Array.isArray(doc.verdicts)) { r.err('verdicts', M('нужен массив verdicts', 'verdicts must be an array'), 'schema_fatal'); r.fatalDoc = true; }
  else {
    const seen = new Set();
    doc.verdicts.forEach((v, i) => {
      const p = `verdicts[${i}]${isObj(v) && v.id ? ` (${v.id})` : ''}`;
      if (!isObj(v)) { r.err(p, M('вердикт — объект', 'a verdict must be an object')); return; }
      if (!nonEmpty(v.id)) r.err(`${p}.id`, M('нет id находки', 'missing finding id'));
      else { if (seen.has(v.id)) r.err(`${p}.id`, M('второй вердикт на ту же находку', 'second verdict for the same finding')); seen.add(v.id); }
      if (v.verdict === 'refuted') r.err(`${p}.verdict`, M('«refuted» → пишите «rejected»', '"refuted" → write "rejected"'));
      else if (!VERDICTS.includes(v.verdict)) r.err(`${p}.verdict`, M(`«${v.verdict ?? ''}» — confirmed, adjusted, rejected или needs_device`, `"${v.verdict ?? ''}" — confirmed, adjusted, rejected or needs_device`));
      if (v.severity_after !== undefined && v.severity_after !== null && !SEVERITIES.includes(v.severity_after)) r.err(`${p}.severity_after`, M('P0–P3 или null', 'P0–P3 or null'));
      for (const k of ['fix_ok', 'text_ok']) if (!isBoolOrNull(v[k])) r.err(`${p}.${k}`, M('true, false или null', 'true, false or null'));
      if (!nonEmpty(v.how)) r.err(`${p}.how`, M('нет how — чем перепроверил', 'missing how — what you re-measured with'));
      if (['adjusted', 'rejected', 'needs_device'].includes(v.verdict) && !nonEmpty(v.note)) r.err(`${p}.note`, M('для adjusted/rejected/needs_device нужна note: почему и что поправлено', 'adjusted/rejected/needs_device need a note: why and what changed'));
    });
  }
  checkArrayOf(r, doc, 'wrong_clean_checks', ['check', 'why']);
  checkArrayOf(r, doc, 'wrong_strengths', ['what', 'why']);
  if (doc.added_by_verifier !== undefined && doc.added_by_verifier !== null) {
    if (!Array.isArray(doc.added_by_verifier)) r.err('added_by_verifier', M('массив', 'must be an array'));
    else {
      if (doc.added_by_verifier.length > 5) r.warn('added_by_verifier', M(`больше 5 добавленных (${doc.added_by_verifier.length})`, `more than 5 added (${doc.added_by_verifier.length})`));
      doc.added_by_verifier.forEach((f, i) => {
        const fl = lens && isObj(f) && isStr(f.id) && !f.id.startsWith(`${lens}-`) ? (f.id.match(/^(.+?)-v\d+$/) || [])[1] : lens;
        const res = checkFinding(f, `added_by_verifier[${i}]${isObj(f) && f.id ? ` (${f.id})` : ''}`, { lens: fl, idKind: 'verifier' });
        r.errors.push(...res.errors); r.warnings.push(...res.warnings);
      });
    }
  }
  return r;
}

export function checkCriticDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc)) { r.err('', M('ожидается объект', 'expected an object'), 'schema_fatal'); r.fatalDoc = true; return r; }
  if (typeof doc.round !== 'number') r.err('round', M('round — число', 'round must be a number'));
  if (doc.mode !== undefined && !['review', 'strategy', 'rivals'].includes(doc.mode)) r.err('mode', M('review, strategy или rivals', 'review, strategy or rivals'));
  if (doc.coverage_table !== undefined) {
    if (!Array.isArray(doc.coverage_table)) r.err('coverage_table', M('массив', 'must be an array'));
    else doc.coverage_table.forEach((c, i) => { if (!isObj(c) || !nonEmpty(c.pid) || !isObj(c.cells)) r.err(`coverage_table[${i}]`, M('нужны pid и cells {…}', 'needs pid and cells {…}')); });
  } else if ((doc.mode || 'review') === 'review') r.warn('coverage_table', M('нет обязательной матрицы coverage_table', 'missing the mandatory coverage_table'));
  checkArrayOf(r, doc, 'gaps', ['lens', 'task']);
  if (Array.isArray(doc.gaps)) doc.gaps.forEach((g, i) => { if (isObj(g) && !['high', 'medium'].includes(g.priority)) r.err(`gaps[${i}].priority`, M('high или medium', 'high or medium')); });
  if (Array.isArray(doc.gaps) && doc.gaps.length > 10) r.warn('gaps', M(`задач второго круга больше 10 (${doc.gaps.length})`, `more than 10 round-two tasks (${doc.gaps.length})`));
  checkArrayOf(r, doc, 'closed_result', ['task', 'result']);
  if (doc.severity_fixes !== undefined) {
    if (!Array.isArray(doc.severity_fixes)) r.err('severity_fixes', M('массив', 'must be an array'));
    else doc.severity_fixes.forEach((s, i) => {
      const p = `severity_fixes[${i}]`;
      if (!isObj(s)) { r.err(p, M('объект', 'must be an object')); return; }
      if (!nonEmpty(s.id)) r.err(`${p}.id`, M('нет id', 'missing id'));
      if (!SEVERITIES.includes(s.to)) r.err(`${p}.to`, M('P0–P3', 'P0–P3'));
      if (s.from !== undefined && s.from !== null && !SEVERITIES.includes(s.from)) r.err(`${p}.from`, M('P0–P3', 'P0–P3'));
      if (SEVERITIES.includes(s.from) && SEVERITIES.includes(s.to) && sevRank(s.to) > sevRank(s.from)) r.err(`${p}.to`, M('критик только повышает важность; понижение — задача скептику', 'the critic only raises severity; lowering is the skeptic\'s job'));
      else if (SEVERITIES.includes(s.from) && s.from === s.to) r.warn(`${p}.to`, M('from = to — поправка ничего не меняет', 'from = to — the fix changes nothing'));
      if (!nonEmpty(s.why)) r.err(`${p}.why`, M('нет why', 'missing why'));
    });
  }
  checkArrayOf(r, doc, 'weak_wording', ['id', 'why']);
  checkArrayOf(r, doc, 'contradictions', ['note']);
  if (Array.isArray(doc.handoffs_decided)) doc.handoffs_decided.forEach((h, i) => { if (isObj(h) && h.decision !== undefined && !['task', 'rejected'].includes(h.decision)) r.err(`handoffs_decided[${i}].decision`, M('task или rejected', 'task or rejected')); });
  if (doc.verdict !== undefined && !/^(ещ[её] круг нужен|достаточно|another round|enough)$/i.test(String(doc.verdict).trim())) r.err('verdict', M('«ещё круг нужен» или «достаточно»', '"another round" or "enough"'));
  return r;
}

export function checkEditorialDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc)) { r.err('', M('ожидается объект { merge, drop, severity, rewrite, order_hint, external_drop }', 'expected an object { merge, drop, severity, rewrite, order_hint, external_drop }'), 'schema_fatal'); r.fatalDoc = true; return r; }
  const known = new Set(['merge', 'drop', 'severity', 'rewrite', 'order_hint', 'external_drop', 'note', 'notes']);
  for (const k of Object.keys(doc)) if (!known.has(k)) r.warn(k, M('неизвестный ключ — будет пропущен', 'unknown key — ignored'));
  if (doc.merge !== undefined) {
    if (!Array.isArray(doc.merge)) r.err('merge', M('массив', 'must be an array'));
    else doc.merge.forEach((m, i) => {
      const p = `merge[${i}]`;
      if (!isObj(m)) { r.err(p, M('объект', 'must be an object')); return; }
      if (!nonEmpty(m.keep)) r.err(`${p}.keep`, M('нет keep', 'missing keep'));
      if (!Array.isArray(m.absorb) || !m.absorb.length || !m.absorb.every(nonEmpty)) r.err(`${p}.absorb`, M('absorb — непустой массив id', 'absorb must be a non-empty array of ids'));
      if (m.title !== undefined && (!nonEmpty(m.title) || glen(m.title) > 100)) r.err(`${p}.title`, M('title — строка до 100 знаков', 'title must be a string up to 100 chars'));
    });
  }
  if (doc.drop !== undefined) {
    if (!Array.isArray(doc.drop)) r.err('drop', M('массив', 'must be an array'));
    else doc.drop.forEach((d, i) => { if (!isObj(d) || !nonEmpty(d.id) || !nonEmpty(d.why)) r.err(`drop[${i}]`, M('нужны id и why', 'needs id and why')); });
  }
  if (doc.severity !== undefined) {
    if (!Array.isArray(doc.severity)) r.err('severity', M('массив', 'must be an array'));
    else doc.severity.forEach((s, i) => {
      if (!isObj(s) || !nonEmpty(s.id) || !SEVERITIES.includes(s.to) || !nonEmpty(s.why)) r.err(`severity[${i}]`, M('нужны id, to (P0–P3) и why', 'needs id, to (P0–P3) and why'));
      if (isObj(s) && s.verdict_ref !== undefined && s.verdict_ref !== null && !isStr(s.verdict_ref)) r.err(`severity[${i}].verdict_ref`, M('строка вида verify/<линза>.json#<id>', 'a string like verify/<lens>.json#<id>'));
    });
  }
  if (doc.rewrite !== undefined) {
    if (!isObj(doc.rewrite)) r.err('rewrite', M('объект { "<id>": { поля } }', 'an object { "<id>": { fields } }'));
    else for (const [id, v] of Object.entries(doc.rewrite)) {
      if (!isObj(v)) { r.err(`rewrite.${id}`, M('объект с полями', 'an object of fields')); continue; }
      for (const [k, t] of Object.entries(v)) {
        if (!REWRITE_FIELDS.includes(k)) r.warn(`rewrite.${id}.${k}`, M(`поле не переписывается (можно: ${REWRITE_FIELDS.join(', ')})`, `field cannot be rewritten (allowed: ${REWRITE_FIELDS.join(', ')})`));
        else if (!isStr(t)) r.err(`rewrite.${id}.${k}`, M('строка', 'must be a string'));
        else if (k === 'title' && glen(t) > 100) r.err(`rewrite.${id}.title`, M(`длиннее 100 знаков (${glen(t)})`, `longer than 100 chars (${glen(t)})`));
      }
    }
  }
  for (const k of ['order_hint', 'external_drop']) if (doc[k] !== undefined && !(Array.isArray(doc[k]) && doc[k].every(nonEmpty))) r.err(k, M('массив id', 'an array of ids'));
  return r;
}

export function checkSummaryDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc)) { r.err('', M('ожидается объект', 'expected an object'), 'schema_fatal'); r.fatalDoc = true; return r; }
  for (const k of ['title', 'site', 'date', 'verdict_line']) if (!nonEmpty(doc[k])) r.err(k, M(`нет ${k}`, `missing ${k}`));
  if (doc.audience !== undefined && !['owner', 'team', 'external'].includes(doc.audience)) r.err('audience', 'owner | team | external');
  if (doc.lang !== undefined && !['ru', 'en'].includes(doc.lang)) r.err('lang', 'ru | en');
  if (!Array.isArray(doc.essence) || doc.essence.length < 1) r.err('essence', M('массив из 3–6 выводов', 'an array of 3–6 conclusions'));
  else if (doc.essence.length > 6) r.warn('essence', M(`выводов больше 6 (${doc.essence.length})`, `more than 6 conclusions (${doc.essence.length})`));
  if (Array.isArray(doc.traffic_lights)) doc.traffic_lights.forEach((t, i) => { if (!isObj(t) || !['red', 'yellow', 'green'].includes(t.status)) r.err(`traffic_lights[${i}].status`, 'red | yellow | green'); });
  checkArrayOf(r, doc, 'top_actions', ['rid', 'action']);
  if (Array.isArray(doc.top_actions)) doc.top_actions.forEach((t, i) => { if (isObj(t) && nonEmpty(t.rid) && !RID_RE.test(t.rid)) r.err(`top_actions[${i}].rid`, M('rid вида P0-01', 'rid like P0-01')); });
  if (Array.isArray(doc.quick_wins) && doc.quick_wins.length > 10) r.err('quick_wins', M(`быстрых побед не больше 10 (${doc.quick_wins.length})`, `at most 10 quick wins (${doc.quick_wins.length})`));
  checkArrayOf(r, doc, 'strengths', ['what', 'why'], { max: 6 });
  checkArrayOf(r, doc, 'decisions', ['question']);
  if (doc.counts !== undefined && !(isObj(doc.counts) && SEVERITIES.every(s => typeof doc.counts[s] === 'number'))) r.err('counts', M('{ P0, P1, P2, P3 } числами', '{ P0, P1, P2, P3 } as numbers'));
  // cross-check with report/findings.json when available
  if (ctx.run) {
    const fj = U.readJSON(join(ctx.run, 'report', 'findings.json'), null);
    if (fj && Array.isArray(fj.items)) {
      const rids = new Set(fj.items.map(x => x.rid));
      const refs = [...(doc.top_actions || []).map(t => t?.rid), ...(doc.quick_wins || []), ...(doc.decisions || []).flatMap(d => d?.rids || [])].filter(isStr);
      for (const rid of refs) if (!rids.has(rid)) r.err('rid', M(`${rid} нет в report/findings.json`, `${rid} is not in report/findings.json`));
      if (isObj(doc.counts)) for (const s of SEVERITIES) { const n = fj.items.filter(x => x.severity === s).length; if (typeof doc.counts[s] === 'number' && doc.counts[s] !== n) r.err(`counts.${s}`, M(`${doc.counts[s]}, а в findings.json ${n}`, `${doc.counts[s]}, but findings.json has ${n}`)); }
    }
  }
  return r;
}

// Characters unsafe inside "…" in Bash or PowerShell (same set as state.mjs encUnsafe); "&" is harmless inside quotes.
const SHELL_UNSAFE = /[$`'"()|;!\\<>{}^\s‘-‟«»]/g;
const encShell = s => String(s).replace(SHELL_UNSAFE, c => { const e = encodeURIComponent(c); return e !== c ? e : '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'); });
const CARD_HOST_RE = /^[a-z0-9._-]+$/; // util.hostKey form: punycode, port as _8080
/** Why a competitor address is unsafe or not a site address, or null. */
export function cardUrlProblem(raw) {
  const s = String(raw).trim();
  let u = null;
  try { u = new URL(s); } catch { /* not a URL */ }
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname) return M('нужен адрес сайта вида https://…', 'a site address https://… is required');
  if (u.username || u.password) return M('в адресе логин или пароль — уберите их', 'the address has a login or password — remove them');
  if (!/^[a-z0-9.-]+$/.test(u.hostname) && !/^\[[0-9a-f:.]+\]$/.test(u.hostname)) return M('в имени сайта недопустимые символы', 'the host name has characters a site address cannot have');
  if (new RegExp(SHELL_UNSAFE.source).test(s)) { return M(`символы $ \` ' " ( ) ; | ! \\ < > { } ^, пробелы и кавычки в адресе кодируйте %XX: ${encShell(s).slice(0, 200)}`, `percent-encode $ \` ' " ( ) ; | ! \\ < > { } ^, spaces and quotes: ${encShell(s).slice(0, 200)}`); }
  return null;
}

export function checkCardDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc)) { r.err('', M('ожидается объект карточки', 'expected a card object'), 'schema_fatal'); r.fatalDoc = true; return r; }
  for (const k of ['url', 'host']) if (!nonEmpty(doc[k])) r.err(k, M(`нет ${k}`, `missing ${k}`));
  // a card address may reach a command line later: punycode host only, shell characters %XX-encoded
  if (nonEmpty(doc.url)) { const bad = cardUrlProblem(doc.url); if (bad) r.err('url', bad); }
  if (nonEmpty(doc.host) && !CARD_HOST_RE.test(doc.host.trim())) r.err('host', M(`«${encShell(doc.host).slice(0, 60)}» — папка сайта: латиница в нижнем регистре, цифры, «.», «-», «_» (кириллический домен — в punycode xn--…)`, `"${encShell(doc.host).slice(0, 60)}" — site folder: lowercase latin, digits, ".", "-", "_" (a Cyrillic domain in punycode xn--…)`));
  if (!isObj(doc.facts)) r.err('facts', M('нужен объект facts (null — не проверено, false — проверено, нет)', 'facts object required (null = not checked, false = checked, absent)'));
  else for (const [k, v] of Object.entries(doc.facts)) if (isStr(v) && /^(\?|не видно|не известно|неизвестно|нет данных|не проверено|не проверял[аи]?|unknown|n\/a|not checked|not visible|tbd|-|—)$/i.test(v.trim())) r.err(`facts.${k}`, M(`«${v}» — вместо догадки пишите null`, `"${v}" — write null instead of a guess`));
  if (!Array.isArray(doc.finds)) r.err('finds', M('нужен массив finds', 'finds must be an array'));
  else {
    const seen = new Set();
    doc.finds.forEach((f, i) => {
      const p = `finds[${i}]${isObj(f) && f.id ? ` (${f.id})` : ''}`;
      if (!isObj(f)) { r.err(p, M('объект', 'must be an object')); return; }
      if (!isStr(f.id) || !/^r-\d{2,3}$/.test(f.id)) r.err(`${p}.id`, M('id вида r-01', 'id like r-01'));
      else { if (seen.has(f.id)) r.err(`${p}.id`, M('повтор id', 'duplicate id')); seen.add(f.id); }
      if (!CARD_KINDS.includes(f.kind)) r.err(`${p}.kind`, 'take | adapt | avoid');
      if (!nonEmpty(f.what)) r.err(`${p}.what`, M('нет what', 'missing what'));
      else if (U.words(f.what).length > 15) r.err(`${p}.what`, M(`больше 15 слов (${U.words(f.what).length})`, `more than 15 words (${U.words(f.what).length})`));
      if (!nonEmpty(f.why)) r.err(`${p}.why`, M('нет why', 'missing why'));
      else if (U.words(f.why).length > 20) r.err(`${p}.why`, M(`больше 20 слов (${U.words(f.why).length})`, `more than 20 words (${U.words(f.why).length})`));
      if (f.quote !== undefined && f.quote !== null && !isStr(f.quote)) r.err(`${p}.quote`, M('строка', 'must be a string'));
      if (!nonEmpty(f.shot)) r.err(`${p}.shot`, M('нужен ровно один кадр', 'exactly one frame is required'));
      if (!validBox(f.crop)) r.err(`${p}.crop`, M('crop — 4 числа [x, y, w, h] в пикселях кадра', 'crop must be 4 numbers [x, y, w, h] in frame pixels'));
      if (!BLOCK_TYPES.includes(f.block_type)) r.err(`${p}.block_type`, BLOCK_TYPES.join(' | '));
      if (!(Number.isInteger(f.strength) && f.strength >= 1 && f.strength <= 5)) r.err(`${p}.strength`, M('целое 1–5', 'integer 1–5'));
    });
  }
  for (const k of ['strong', 'weak', 'not_visible']) if (doc[k] !== undefined && !Array.isArray(doc[k])) r.err(k, M('массив', 'must be an array'));
  return r;
}

export function checkRecheckPlanDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc) || !Array.isArray(doc.groups)) { r.err('groups', M('ожидается { from, groups: [...] }', 'expected { from, groups: [...] }'), 'schema_fatal'); r.fatalDoc = true; return r; }
  if (!nonEmpty(doc.from)) r.err('from', M('нет from', 'missing from'));
  doc.groups.forEach((g, i) => {
    if (!isObj(g) || !nonEmpty(g.id)) { r.err(`groups[${i}]`, M('нужен id', 'needs id')); return; }
    if (!Array.isArray(g.uids)) r.err(`groups[${i}].uids`, M('массив uid', 'an array of uids'));
    else g.uids.forEach((u, k) => { if (!RECHECK_UID_RE.test(String(u))) r.err(`groups[${i}].uids[${k}]`, M('uid вида R-1a2b3c4d (или rid:P1-03)', 'uid like R-1a2b3c4d (or rid:P1-03)')); });
    if (g.pages !== undefined && !Array.isArray(g.pages)) r.err(`groups[${i}].pages`, M('массив', 'must be an array'));
  });
  return r;
}

export function checkRecheckGroupDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc) || !Array.isArray(doc.items)) { r.err('items', M('ожидается { items: [...], new: [...] }', 'expected { items: [...], new: [...] }'), 'schema_fatal'); r.fatalDoc = true; return r; }
  doc.items.forEach((it, i) => {
    const p = `items[${i}]`;
    if (!isObj(it)) { r.err(p, M('объект', 'must be an object')); return; }
    if (!RECHECK_UID_RE.test(String(it.uid))) r.err(`${p}.uid`, M('uid вида R-1a2b3c4d (или rid:P1-03)', 'uid like R-1a2b3c4d (or rid:P1-03)'));
    if (!RECHECK_STATUSES.includes(it.status)) r.err(`${p}.status`, RECHECK_STATUSES.join(' | '));
    if (!nonEmpty(it.evidence)) r.err(`${p}.evidence`, M('нет evidence', 'missing evidence'));
    if (it.box !== undefined && it.box !== null && !validBox(it.box)) r.err(`${p}.box`, M('4 числа', '4 numbers'));
  });
  if (doc.new !== undefined) {
    if (!Array.isArray(doc.new)) r.err('new', M('массив находок', 'an array of findings'));
    else doc.new.forEach((f, i) => { const res = checkFinding(f, `new[${i}]`, {}); r.errors.push(...res.errors); r.warnings.push(...res.warnings); });
  }
  return r;
}

export function checkScoresDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc)) { r.err('', M('ожидается объект', 'expected an object'), 'schema_fatal'); return r; }
  if (!(typeof doc.overall === 'number' && doc.overall >= 0 && doc.overall <= 10)) r.err('overall', M('число 0–10', 'a number 0–10'));
  if (!isObj(doc.areas)) r.err('areas', M('объект { направление: оценка }', 'an object { area: score }'));
  else {
    for (const [k, v] of Object.entries(doc.areas)) if (!(typeof v === 'number' && v >= 0 && v <= 10)) r.err(`areas.${k}`, M('число 0–10', 'a number 0–10'));
    const nums = Object.values(doc.areas).filter(v => typeof v === 'number' && v >= 0 && v <= 10);
    if (nums.length && typeof doc.overall === 'number') {
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      if (Math.abs(mean - doc.overall) > 0.1 + 1e-9) r.warn('overall', M(`overall ${doc.overall}, а среднее по areas ${mean.toFixed(2)} (report.mjs считает среднее)`, `overall ${doc.overall}, but the mean of areas is ${mean.toFixed(2)} (report.mjs uses the mean)`));
    }
  }
  if (doc.top_drivers !== undefined && !Array.isArray(doc.top_drivers)) r.err('top_drivers', M('массив rid', 'an array of rids'));
  return r;
}
export function checkStrategyDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc)) { r.err('', M('ожидается объект { seo, site }', 'expected an object { seo, site }'), 'schema_fatal'); return r; }
  for (const part of ['seo', 'site']) {
    const s = doc[part];
    if (s === undefined || s === null) continue;
    if (!isObj(s)) { r.err(part, M('объект', 'must be an object')); continue; }
    if (s.periods !== undefined) {
      if (!Array.isArray(s.periods)) r.err(`${part}.periods`, M('массив', 'must be an array'));
      else s.periods.forEach((p, i) => {
        if (!isObj(p) || !nonEmpty(p.when) || !Array.isArray(p.actions)) { r.err(`${part}.periods[${i}]`, M('нужны when и actions', 'needs when and actions')); return; }
        p.actions.forEach((a, k) => { if (!isObj(a) || !nonEmpty(a.what)) r.err(`${part}.periods[${i}].actions[${k}]`, M('нет what', 'missing what')); });
      });
    }
  }
  return r;
}
export function checkEditsDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!Array.isArray(doc)) { r.err('', M('ожидается массив правок', 'expected an array of edits'), 'schema_fatal'); return r; }
  doc.forEach((e, i) => {
    if (!isObj(e)) { r.err(`[${i}]`, M('объект', 'must be an object')); return; }
    if (!['drop', 'severity', 'replace_text'].includes(e.op)) r.err(`[${i}].op`, 'drop | severity | replace_text');
    if (!nonEmpty(e.rid)) r.err(`[${i}].rid`, M('нет rid', 'missing rid'));
    if (e.op === 'severity' && !SEVERITIES.includes(e.to)) r.err(`[${i}].to`, 'P0–P3');
    if (e.scope !== undefined && !['one', 'all'].includes(e.scope)) r.err(`[${i}].scope`, 'one | all');
    if (!nonEmpty(e.why)) r.err(`[${i}].why`, M('нет why', 'missing why'));
  });
  return r;
}
function checkLooseArrayDoc(key) {
  return (doc, ctx = {}) => {
    const r = new Report(ctx.file);
    const arr = Array.isArray(doc) ? doc : isObj(doc) ? doc[key] : null;
    if (!Array.isArray(arr)) r.err(key, M('ожидается массив', 'expected an array'), 'schema_fatal');
    return r;
  };
}
function checkIdeasDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  const arr = Array.isArray(doc) ? doc : isObj(doc) ? doc.ideas : null;
  if (!Array.isArray(arr)) { r.err('ideas', M('ожидается массив идей', 'expected an array of ideas'), 'schema_fatal'); return r; }
  arr.forEach((x, i) => {
    if (!isObj(x)) { r.err(`[${i}]`, M('объект', 'must be an object')); return; }
    if (!nonEmpty(x.title)) r.err(`[${i}].title`, M('нет title', 'missing title'));
    else if (U.words(x.title).length > 8) r.err(`[${i}].title`, M('больше 8 слов', 'more than 8 words'));
    if (nonEmpty(x.propose) && U.words(x.propose).length > 25) r.err(`[${i}].propose`, M('больше 25 слов', 'more than 25 words'));
    if (x.effort !== undefined && !EFFORTS.includes(x.effort)) r.err(`[${i}].effort`, 'S | M | L');
    for (const k of ['benefit', 'ease']) if (x[k] !== undefined && !(Number.isInteger(x[k]) && x[k] >= 1 && x[k] <= 5)) r.err(`[${i}].${k}`, '1–5');
  });
  return r;
}
function checkMatrixDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc) || !Array.isArray(doc.sites) || !Array.isArray(doc.rows)) r.err('', M('ожидается { sites: [...], rows: [...] }', 'expected { sites: [...], rows: [...] }'), 'schema_fatal');
  else doc.rows.forEach((row, i) => { if (!isObj(row) || !nonEmpty(row.param) || !isObj(row.values)) r.err(`rows[${i}]`, M('нужны param и values', 'needs param and values')); });
  return r;
}
function checkCandidatesDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc) || !Array.isArray(doc.items)) r.err('items', M('ожидается { items: [...] } (пишет merge.mjs)', 'expected { items: [...] } (written by merge.mjs)'), 'schema_fatal');
  return r;
}
function checkFinalDoc(doc, ctx = {}) {
  const r = new Report(ctx.file);
  if (!isObj(doc) || !Array.isArray(doc.items)) { r.err('items', M('ожидается { items: [...] } (пишет finalize.mjs)', 'expected { items: [...] } (written by finalize.mjs)'), 'schema_fatal'); return r; }
  const rids = new Set(), uids = new Set();
  doc.items.forEach((x, i) => {
    if (!RID_RE.test(String(x?.rid))) r.err(`items[${i}].rid`, M('rid вида P0-01', 'rid like P0-01'));
    else { if (rids.has(x.rid)) r.err(`items[${i}].rid`, M('повтор rid', 'duplicate rid')); rids.add(x.rid); }
    if (!UID_RE.test(String(x?.uid))) r.err(`items[${i}].uid`, M('uid вида R-1a2b3c4d', 'uid like R-1a2b3c4d'));
    else { if (uids.has(x.uid)) r.err(`items[${i}].uid`, M('повтор uid', 'duplicate uid')); uids.add(x.uid); }
  });
  return r;
}

export const CHECKERS = {
  findings: checkFindingsDoc, verify: checkVerifyDoc, critic: checkCriticDoc, editorial: checkEditorialDoc, summary: checkSummaryDoc,
  card: checkCardDoc, 'recheck-plan': checkRecheckPlanDoc, 'recheck-group': checkRecheckGroupDoc, scores: checkScoresDoc,
  strategy: checkStrategyDoc, edits: checkEditsDoc, ideas: checkIdeasDoc, matrix: checkMatrixDoc, 'best-of': checkLooseArrayDoc('items'),
  candidates: checkCandidatesDoc, final: checkFinalDoc,
};

/** Kind of an agent file by its RUN-relative path (forward slashes); null = not ours to check. */
export function kindOfPath(rel) {
  const p = String(rel).replace(/\\/g, '/');
  const name = p.split('/').pop();
  if (/(^|\/)findings\/[^/]+\.json$/.test(p)) return 'findings';
  if (/(^|\/)verify\/[^/]+\.lint\.json$/.test(p)) return 'lint';
  if (/(^|\/)verify\/recheck\.json$/.test(p)) return 'verify-recheck';
  if (/(^|\/)verify\/[^/]+\.json$/.test(p)) return 'verify';
  if (/(^|\/)critic\/round-\d+\.json$/.test(p)) return 'critic';
  if (/(^|\/)report\/editorial\.json$/.test(p)) return 'editorial';
  if (/(^|\/)report\/summary\.json$/.test(p)) return 'summary';
  if (/(^|\/)report\/scores-[a-z]+\.json$/.test(p)) return 'scores';
  if (/(^|\/)report\/strategy\.json$/.test(p)) return 'strategy';
  if (/(^|\/)report\/edits\.json$/.test(p)) return 'edits';
  if (/(^|\/)report\/candidates\.json$/.test(p)) return 'candidates';
  if (/(^|\/)report\/findings\.json$/.test(p)) return 'final';
  if (/(^|\/)rivals\/[^/]+\/card\.json$/.test(p)) return 'card';
  if (/(^|\/)rivals\/matrix\.json$/.test(p)) return 'matrix';
  if (/(^|\/)rivals\/best-of\.json$/.test(p)) return 'best-of';
  if (/(^|\/)rivals\/ideas\.json$/.test(p)) return 'ideas';
  if (/(^|\/)recheck\/plan\.json$/.test(p)) return 'recheck-plan';
  if (/(^|\/)recheck\/result\.json$/.test(p)) return null;
  if (/(^|\/)recheck\/[^/]+\.json$/.test(p)) return 'recheck-group';
  if (name === 'card.json') return 'card';
  return undefined; // unknown — guess from content
}
function kindOfContent(d) {
  if (Array.isArray(d)) return d.some(x => isObj(x) && 'op' in x) ? 'edits' : null;
  if (!isObj(d)) return null;
  if (Array.isArray(d.findings)) return 'findings';
  if (Array.isArray(d.verdicts)) return 'verify';
  if ('severity_fixes' in d || 'coverage_table' in d || 'gaps' in d) return 'critic';
  if (['merge', 'drop', 'rewrite', 'external_drop', 'order_hint'].some(k => k in d)) return 'editorial';
  if (Array.isArray(d.finds)) return 'card';
  if ('verdict_line' in d || 'essence' in d) return 'summary';
  if (Array.isArray(d.groups)) return 'recheck-plan';
  if (Array.isArray(d.items) && d.items.some(x => isObj(x) && 'rid' in x)) return 'final';
  if (Array.isArray(d.items)) return 'recheck-group';
  if ('overall' in d) return 'scores';
  return null;
}

/** Validate one file. → { file, kind, ok, errors, warnings, data, items?, fatalDoc? } */
export function validateFile(abs, { type = null, run = null } = {}) {
  const rel = run ? relFromRun(run, abs) : abs.replace(/\\/g, '/');
  const out = { file: rel, kind: type || kindOfPath(rel) || null, ok: false, errors: [], warnings: [] };
  const pj = readJsonFile(abs);
  if (!pj.ok) { out.errors.push({ path: '', msg: pj.error, code: 'parse' }); out.fatalDoc = true; return out; }
  let kind = type || kindOfPath(rel);
  if (kind === undefined) kind = kindOfContent(pj.data);
  out.kind = kind;
  out.data = pj.data;
  if (kind === 'lint' || kind === null) { out.ok = true; out.skipped = true; return out; }
  if (kind === 'verify-recheck') { // recheck skeptic: verdicts by uid or id — light check
    const v = pj.data;
    if (!isObj(v) || !Array.isArray(v.verdicts)) out.errors.push({ path: 'verdicts', msg: M('нужен массив verdicts', 'verdicts must be an array'), code: 'schema_fatal' });
    out.ok = !out.errors.length; return out;
  }
  if (!kind || !CHECKERS[kind]) { out.errors.push({ path: '', msg: M('не понимаю, что это за файл: укажите --type (findings, verify, critic, editorial, summary, card…)', 'unknown file kind: pass --type (findings, verify, critic, editorial, summary, card…)'), code: 'kind' }); return out; }
  const ctx = { file: rel, run };
  if (kind === 'findings' || kind === 'verify') {
    const pn = parseLensFileName(basename(abs));
    if (pn) { ctx.lens = pn.lens; ctx.round = pn.round; }
    else if (kind === 'findings') out.errors.push({ path: '', msg: M('имя файла — <линза>.json, <линза>.partN.json или <линза>.r2.json', 'file name must be <lens>.json, <lens>.partN.json or <lens>.r2.json'), code: 'name' });
  }
  const rep = CHECKERS[kind](pj.data, ctx);
  out.errors.push(...rep.errors); out.warnings.push(...rep.warnings);
  if (rep.items) out.items = rep.items;
  if (rep.fatalDoc) out.fatalDoc = true;
  out.ok = !out.errors.length;
  return out;
}

function relFromRun(run, abs) {
  const r = relative(resolve(run), resolve(abs));
  return (!r || r.startsWith('..') || isAbsolute(r) ? resolve(abs) : r).split(/[\\/]/).join('/');
}

/** All agent files of a RUN (findings, verify, critic, report/*, rivals cards, recheck). */
export function agentFiles(run) {
  const out = [];
  const add = (dir, re) => { const d = join(run, dir); if (!existsSync(d)) return; for (const f of readdirSync(d).sort()) if (re.test(f)) out.push(join(d, f)); };
  add('findings', /\.json$/);
  add('verify', /\.json$/);
  add('critic', /^round-\d+\.json$/);
  add('report', /^(editorial|summary|strategy|edits|scores-[a-z]+)\.json$/);
  add('recheck', /\.json$/);
  const rv = join(run, 'rivals');
  if (existsSync(rv)) {
    for (const h of readdirSync(rv).sort()) { const c = join(rv, h, 'card.json'); try { if (statSync(join(rv, h)).isDirectory() && existsSync(c)) out.push(c); } catch {} }
    for (const f of ['matrix.json', 'best-of.json', 'ideas.json']) if (existsSync(join(rv, f))) out.push(join(rv, f));
  }
  return out;
}

/** Cross-file checks of a RUN: duplicate ids across files, verdicts for unknown ids, r2 ids colliding with round one. */
export function crossChecks(results) {
  const errs = [], warns = [];
  const idsByFile = new Map();
  const allIds = new Map(); // id → file
  for (const r of results) {
    if (r.kind !== 'findings' || !r.data || !Array.isArray(r.data.findings)) continue;
    for (const f of r.data.findings) {
      if (!isObj(f) || !isStr(f.id)) continue;
      if (allIds.has(f.id) && allIds.get(f.id) !== r.file) errs.push({ file: r.file, path: f.id, msg: M(`id ${f.id} уже есть в ${allIds.get(f.id)}`, `id ${f.id} is already used in ${allIds.get(f.id)}`), code: 'dup_id' });
      else allIds.set(f.id, r.file);
      (idsByFile.get(r.file) || idsByFile.set(r.file, new Set()).get(r.file)).add(f.id);
    }
  }
  const added = new Set();
  for (const r of results) if (r.kind === 'verify' && isObj(r.data)) for (const f of r.data.added_by_verifier || []) if (isObj(f) && isStr(f.id)) {
    if (allIds.has(f.id) || added.has(f.id)) errs.push({ file: r.file, path: f.id, msg: M(`id ${f.id} уже занят`, `id ${f.id} is already taken`), code: 'dup_id' });
    added.add(f.id);
  }
  for (const r of results) {
    if (r.kind !== 'verify' || !isObj(r.data) || !Array.isArray(r.data.verdicts)) continue;
    for (const v of r.data.verdicts) if (isObj(v) && isStr(v.id) && !allIds.has(v.id) && !added.has(v.id)) warns.push({ file: r.file, path: v.id, msg: M(`вердикт на находку ${v.id}, которой нет в findings/`, `verdict for ${v.id}, which is not in findings/`), code: 'orphan_verdict' });
  }
  return { errors: errs, warnings: warns };
}

// ---------- CLI ----------
const HELP = `
validate.mjs — проверяет JSON-файл агента сразу после записи: разбирается ли он и совпадает ли со схемой
(формат находки — knowledge/findings-format.md, §3–§7). Что проверяется в находке:
  - обязательные поля и значения из списков (severity P0–P3, effort S|M|L, confidence high|medium|low…);
  - evidence не пустое; confidence: low только вместе с needs_device_check или needs_decision;
  - taste: true — не выше P3; box — 4 числа [x, y, w, h];
  - id своей линзы: copy-01, во втором круге copy-r2-01, у скептика copy-v01;
  - title до 100 знаков и с цифрой или конкретным местом («кнопка в шапке», «H1», «404», «/menu»).

  node validate.mjs --file "<путь к файлу>" [--type <вид>] [--json] [--lang ru|en]
  node validate.mjs --run "<RUN>" --all [--json] [--lang ru|en]

Вид файла обычно понятен по пути; иначе --type: findings, verify, critic, editorial, summary, card, recheck-plan,
recheck-group, scores, strategy, edits, ideas, matrix, best-of, candidates, final.
--all проверяет findings/*, verify/*, critic/round-*, report/{editorial,summary,strategy,edits,scores-*},
rivals/*/card.json, rivals/{matrix,best-of,ideas}.json, recheck/* и сверяет файлы между собой (повтор id,
вердикт на неизвестный id).
Код 0 — ошибок нет (предупреждения не мешают), 1 — есть ошибки, 2 — неверные аргументы. Работает секунды,
поэтому --budget-sec не нужен. Пишет только копию сводки в RUN/stdout/validate.md (если папка прогона известна).
`;

function guessRun(abs) { // <RUN>/findings/x.json → <RUN> when it looks like a run folder
  let d = dirname(resolve(abs));
  for (let i = 0; i < 3; i++) {
    if (existsSync(join(d, 'state.json')) || existsSync(join(d, 'pages.json'))) return d;
    d = dirname(d);
  }
  return null;
}

async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['all', 'json', 'help'] });
  U.helpAndExit(HELP, args);
  const lang = U.langOf(args);
  setLang(lang);
  const L = (ru, en) => (lang === 'en' ? en : ru);
  let run = args.run && args.run !== true ? resolve(String(args.run)) : null;
  const type = args.type && args.type !== true ? String(args.type) : null;
  if (type && !CHECKERS[type]) { console.error(L(`Неизвестный --type ${type}. Можно: ${Object.keys(CHECKERS).join(', ')}`, `Unknown --type ${type}. Allowed: ${Object.keys(CHECKERS).join(', ')}`)); process.exit(2); }
  let files = [];
  if (args.file && args.file !== true) {
    const f = run && !isAbsolute(String(args.file)) && !existsSync(resolve(String(args.file))) ? join(run, String(args.file)) : resolve(String(args.file));
    if (!existsSync(f)) { console.error(L(`Файл не найден: ${f}`, `File not found: ${f}`)); process.exit(2); }
    files = [f];
    if (!run) run = guessRun(f);
  } else if (args.all) {
    if (!run) { console.error(L('Для --all нужен --run "<RUN>".', '--all needs --run "<RUN>".')); process.exit(2); }
    if (!existsSync(run)) { console.error(L(`Нет папки прогона: ${run}`, `Run folder not found: ${run}`)); process.exit(2); }
    files = agentFiles(run);
  } else { console.error(L('Нужен --file "<путь>" или --run "<RUN>" --all. Справка: --help', 'Pass --file "<path>" or --run "<RUN>" --all. See --help')); process.exit(2); }

  const results = files.map(f => validateFile(f, { type, run }));
  const cross = args.all ? crossChecks(results) : { errors: [], warnings: [] };
  for (const e of cross.errors) { const r = results.find(x => x.file === e.file); if (r) { r.errors.push({ path: e.path, msg: e.msg, code: e.code }); r.ok = false; } }
  for (const w of cross.warnings) { const r = results.find(x => x.file === w.file); if (r) r.warnings.push({ path: w.path, msg: w.msg, code: w.code }); }
  const checked = results.filter(r => !r.skipped);
  const nErr = checked.reduce((a, r) => a + r.errors.length, 0);
  const nWarn = checked.reduce((a, r) => a + r.warnings.length, 0);

  if (args.json) {
    process.stdout.write(JSON.stringify({ ok: nErr === 0, files: checked.map(({ data, items, ...r }) => r), errors: nErr, warnings: nWarn }, null, 2) + '\n');
    process.exit(nErr ? 1 : 0);
  }
  const lines = [`validate · ${L('файлов', 'files')} ${checked.length} · ${L('ошибок', 'errors')} ${nErr} · ${L('предупреждений', 'warnings')} ${nWarn}`];
  if (!checked.length) lines.push(L('Нечего проверять: нет файлов агентов.', 'Nothing to check: no agent files.'));
  const budget = 36;
  let cut = false;
  const push = s => { if (lines.length >= budget) { cut = true; return false; } lines.push(s); return true; };
  for (const r of checked) {
    if (!r.errors.length && (!r.warnings.length || files.length > 1)) { if (checked.length <= 12) push(`ok  ${r.file} (${r.kind})`); continue; }
    if (!push(`${r.errors.length ? '!!' : 'ok'}  ${r.file} (${r.kind}) — ${L('ошибок', 'errors')} ${r.errors.length}, ${L('предупр.', 'warn.')} ${r.warnings.length}`)) break;
    for (const e of r.errors) if (!push(`    ${e.path ? e.path + ': ' : ''}${e.msg}`)) break;
    if (files.length === 1) for (const w of r.warnings) if (!push(`    (${L('предупр.', 'warn.')}) ${w.path ? w.path + ': ' : ''}${w.msg}`)) break;
  }
  if (nWarn && files.length > 1) lines.push(L(`Предупреждения (${nWarn}) не мешают; список — через --json или --file по одному файлу.`, `Warnings (${nWarn}) do not block; list them with --json or --file per file.`));
  if (cut) lines.push(L(`… не всё поместилось — полный список: тот же вызов с --json`, `… truncated — full list: the same call with --json`));
  lines.push(nErr ? L('Исправьте ошибки и запустите проверку снова.', 'Fix the errors and run the check again.') : L('Схема в порядке.', 'Schema OK.'));
  U.printAndSaveSummary(run, 'validate', lines);
  process.exit(nErr ? 1 : 0);
}

const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
