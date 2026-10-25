#!/usr/bin/env node
// Revizor — recheck: plan a re-measurement of past findings and collect the results.
// Findings are matched by the permanent uid (hidden sheet _revizor of registry.xlsx or report/findings.json), never by
// row position or rid. Columns of the registry are found by header text (the user may reorder, rename or add columns).
// The input registry is never overwritten: --collect writes a new report/registry-recheck-<YYYYMMDD>.xlsx where the
// user's columns are carried over by uid and two columns are added: «Проверено ДД.ММ» and «Итог перепроверки».
// For an external registry (meta audience = external) the new file carries no internal process words, paths or codes.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as U from './lib/util.mjs';
import { readXlsx, writeXlsx, colName } from './lib/xlsx.mjs';

const HELP = `
recheck.mjs — перепроверка правок по прошлому ревью

  node recheck.mjs --run "<RUN>" [--from "<старый RUN | registry.xlsx>"] [--group-size 12] [--lang ru|en]
        → RUN/recheck/plan.json: что перепроверять, группами по линзе и методу (для агентов rechecker)
  node recheck.mjs --run "<RUN>" --collect [--lang ru|en]
        → RUN/recheck/result.json + RUN/report/registry-recheck-<ГГГГММДД>.xlsx

--from     папка прошлого прогона (берутся report/findings.json и самый свежий реестр из report/) или файл реестра.
           По умолчанию — то, что записал init-run (state.json → flags.from).
Находки сопоставляются по постоянному uid (скрытый лист _revizor реестра, report/findings.json), не по номеру строки.
Столбцы реестра ищутся по заголовкам (регистр, ё/е, скобки не важны), статусы — без учёта регистра и вида апострофа.
Строки со статусом «не будем исправлять» / «won't fix» не перепроверяются (skipped). Остальные статусы проверяются все:
«исправлено» без перемера не принимается, «новое» могло исправиться молча.

--collect  читает recheck/<группа>.json и recheck/fresh.json агентов rechecker ({ items: [{ uid, status, evidence, shot, box, note }],
           new: [находки] }) и verify/recheck*.json скептика: rejected по fixed → not_fixed; rejected по regressed → not_fixed
           (регрессия не подтвердилась); вердикт новой находки — по ключу "new:<группа>:<номер в массиве new с 0>" (или по её uid):
           rejected — в реестр не идёт (result.json → rejected_new), needs_device — идёт с пометкой.
           Статусы: fixed · partial · not_fixed · regressed · not_applicable · cannot_check (+ unchecked — агент не прислал).
           Входной реестр не перезаписывается. В новый файл переносятся все листы, строки и столбцы пользователя (порядок листов
           тот же; формулы и оформление его столбцов — значениями), добавляются «Проверено ДД.ММ» и «Итог перепроверки», новые
           находки — строками в конце (№ N-01…), «Сводка» пересобирается формулами, скрытый лист _revizor дополняется (uid
           новых строк постоянный: от линзы, заголовка и адреса). Аудитория — из _revizor (audience); для external в реестре
           нет слов процесса, путей и кодов: в «Итоге» — только факт, «Тема» — название направления, «Раздел сайта» — страница.
Коды: 0 — готово, 2 — нет входных данных или ошибка аргументов, 1 — сбой.
`;

const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'collect'] });
U.helpAndExit(HELP, args);
const run = U.requireRun(args);
const readOpt = p => { try { return existsSync(p) ? U.readJSON(p, null) : null; } catch { return null; } };
const state = readOpt(join(run, 'state.json')) || {};
const brief = readOpt(join(run, 'brief.json')) || readOpt(join(run, 'brief.input.json')) || {};
const lang = args.lang === 'en' || (!args.lang && (state.flags?.lang === 'en' || brief.lang === 'en')) ? 'en' : 'ru';
const T = (ru, en) => (lang === 'en' ? en : ru);
const fail = (code, ru, en) => { console.error(T(ru, en)); process.exit(code); };
const fwd = p => String(p).replace(/\\/g, '/');
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = resolve(HERE, '..');
const STRINGS = readOpt(join(PLUGIN, 'templates', 'strings.json')) || {};

// ---------- registry columns (synonyms RU/EN) ----------
const REG_COLS = {
  rid: ['№', 'no', 'n', '#', 'номер', 'rid', 'id'],
  severity: ['важность', 'приоритет', 'severity', 'priority'],
  section: ['раздел сайта', 'раздел', 'site section', 'section'],
  topic: ['тема', 'topic', 'category', 'категория'],
  what: ['что на сайте', 'что не так', 'проблема', 'замечание', 'описание', 'issue', 'problem', 'what'],
  where: ['где (url · блок)', 'где', 'where (url · block)', 'where', 'url', 'адрес', 'страница', 'page'],
  fix: ['как исправить', 'исправление', 'how to fix', 'fix'],
  who: ['кто', 'ответственный', 'who', 'owner'],
  effort: ['трудоёмкость', 'трудозатраты', 'effort'],
  status: ['статус', 'status', 'состояние', 'state'],
  comment: ['комментарий', 'комментарии', 'примечание', 'comment', 'comments', 'notes'],
  checked: ['проверено', 'checked', 'verified'],
  lenses: ['линзы', 'линза', 'lenses', 'lens'],
  method: ['метод', 'method'],
  norm: ['норма', 'norm'],
  confidence: ['уверенность', 'confidence'],
  uid: ['uid'],
};
const HIDDEN_COLS = { uid: ['uid'], rid: ['rid', '№'], url: ['url'], selector: ['selector', 'селектор'], viewport: ['viewport', 'ширина'],
  state: ['state', 'состояние'], method: ['method', 'метод'], lens: ['lens', 'линза'], norm: ['norm', 'норма'] };
// raw lower-case text: «won't», «won’t», «wont», «не будем исправлять»
const isWontFix = s => /не\s*будем|не\s*исправля|won\W?t\s*fix|will\s*not\s*fix|wontfix|won\W?t\s*do/i.test(String(s ?? '').toLowerCase());
const STATUSES = ['fixed', 'partial', 'not_fixed', 'regressed', 'not_applicable', 'cannot_check'];
const LABEL = {
  ru: { fixed: 'исправлено', partial: 'частично', not_fixed: 'не исправлено', regressed: 'регрессия', not_applicable: 'неприменимо (страницы или блока нет)',
    cannot_check: 'не удалось проверить', unchecked: 'нет данных перепроверки', skipped: 'не проверяли: не будем исправлять', new: 'новое при перепроверке' },
  en: { fixed: 'fixed', partial: 'partly fixed', not_fixed: 'not fixed', regressed: 'regression', not_applicable: 'not applicable (page or block gone)',
    cannot_check: 'could not check', unchecked: 'no recheck data', skipped: "not checked: won't fix", new: 'new at recheck' },
};
// external: no process words (tone.md → forbidden.external)
const LABEL_EXT = {
  ru: { ...LABEL.ru, regressed: 'стало хуже', not_applicable: 'страницы или блока больше нет', cannot_check: 'уточняется', unchecked: 'уточняется', skipped: 'не будем исправлять', new: 'новое' },
  en: { ...LABEL.en, regressed: 'got worse', not_applicable: 'page or block is gone', cannot_check: 'pending', unchecked: 'pending', skipped: "won't fix", new: 'new' },
};
const sevOf = (...vals) => { for (const v of vals) { const m = String(v ?? '').match(/\bP([0-3])\b/i); if (m) return `P${m[1]}`; } return null; };
const EXT_SEV = [[/первую очередь|first/i, 'P0'], [/^важно|important/i, 'P1'], [/желательно|стоит сделать|desirable|should|worth/i, 'P2'], [/улучшение|мелочи|improvement|minor/i, 'P3'], [/срочно|urgent/i, 'P0']];
const sevFromLabel = s => { const t = String(s || '').trim(); for (const [re, p] of EXT_SEV) if (re.test(t)) return p; return null; };
const normUrl = u => { try { const x = new URL(u); x.hash = ''; return (x.origin + x.pathname.replace(/\/+$/, '') + x.search).toLowerCase(); } catch { return String(u || '').trim().toLowerCase(); } };
const firstUrl = s => (String(s || '').match(/https?:\/\/[^\s·|,;«»"]+/) || [])[0] || null;
const cellStr = v => (v === null || v === undefined ? '' : String(v).trim());
const AUDIENCES = ['owner', 'team', 'external'];
const pickAudience = (...vals) => vals.map(v => String(v || '').toLowerCase().trim()).find(v => AUDIENCES.includes(v)) || 'owner';

// ---------- reading a registry ----------
function readRegistry(path) {
  const book = readXlsx(path);
  const sheets = book.sheets;
  const isMainName = n => ['замечания', 'issues'].includes(U.normHeader(n));
  const order = [...sheets].sort((a, b) => isMainName(b.name) - isMainName(a.name));
  let main = null, found = null;
  for (const sh of order) {
    if (sh.name === '_revizor') continue;
    const f = U.findColumns(sh.rows, REG_COLS, { need: ['status'], min: 3 });
    if (f) { main = sh; found = f; break; }
  }
  if (!main) return { error: T('В реестре не нашёл лист со столбцом «Статус».', 'No sheet with a "Status" column in the registry.') };
  // hidden sheet: uid → url, selector, viewport, state, method, lens, norm; meta "site: …" or "site | …"
  const hidden = sheets.find(s => s.name === '_revizor');
  const byUid = new Map(), ridToUid = new Map(), meta = {};
  let hiddenFound = null;
  const META_KEYS = /^(site|run_date|plugin_version|schema_version|audience|lang|recheck_date)$/i;
  if (hidden) {
    hiddenFound = U.findColumns(hidden.rows, HIDDEN_COLS, { need: ['uid'], min: 2, scan: 12 });
    for (const row of hidden.rows) {
      for (let i = 0; i < (row || []).length; i++) {
        const c = row[i];
        if (typeof c !== 'string') continue;
        const m = c.match(/^(site|run_date|plugin_version|schema_version|audience|lang|recheck_date)\s*[:=]\s*(.+)$/i);
        if (m) meta[m[1].toLowerCase()] = m[2].trim();
        else if (META_KEYS.test(c) && row[i + 1] !== undefined && row[i + 1] !== null) meta[c.toLowerCase()] = String(row[i + 1]);
      }
    }
    if (hiddenFound) {
      const hc = hiddenFound.cols;
      for (const row of hidden.rows.slice(hiddenFound.headerRow + 1)) {
        const uid = cellStr(row?.[hc.uid]);
        if (!/^R-[0-9a-f]{4,}$/i.test(uid)) continue;
        const rec = Object.fromEntries(Object.keys(HIDDEN_COLS).map(k => [k, hc[k] === undefined ? null : (cellStr(row[hc[k]]) || null)]));
        byUid.set(uid, rec);
        if (rec.rid) ridToUid.set(rec.rid, uid);
      }
    }
  }
  const { cols, headerRow } = found;
  const rows = [];
  for (let r = headerRow + 1; r < main.rows.length; r++) {
    const row = main.rows[r] || [];
    if (!row.some(x => x !== null && x !== undefined && String(x).trim() !== '')) continue;
    const get = k => (cols[k] === undefined ? '' : cellStr(row[cols[k]]));
    const rid = get('rid');
    const uid = get('uid') || ridToUid.get(rid) || null;
    rows.push({ r, rid, uid, status: get('status'), comment: get('comment'), severity: get('severity'), topic: get('topic'), section: get('section'),
      what: get('what'), where: get('where'), fix: get('fix'), who: get('who'), method: get('method'), norm: get('norm'), lenses: get('lenses') });
  }
  return { book, main, cols, headerRow, rows, hidden, hiddenFound, byUid, meta };
}

// newest registry inside <RUN>/report: registry-recheck-*.xlsx (by name/time) before registry.xlsx
function newestRegistry(dir) {
  const rep = join(dir, 'report');
  let list = [];
  try { list = readdirSync(rep).filter(n => /^registry(-recheck-[\w-]+)?\.xlsx$/i.test(n)).map(n => ({ n, t: statSync(join(rep, n)).mtimeMs })); } catch { return null; }
  list.sort((a, b) => (/recheck/.test(b.n) - /recheck/.test(a.n)) || b.t - a.t);
  return list.length ? join(rep, list[0].n) : null;
}

// ---------- plan ----------
function sourceOf(from) {
  const p = resolve(from);
  if (!existsSync(p)) fail(2, `Не найдено: ${p}`, `Not found: ${p}`);
  if (statSync(p).isDirectory()) return { kind: 'run', from: p, fromRun: p, registry: newestRegistry(p) };
  if (!/\.xlsx$/i.test(p)) fail(2, '--from: папка прогона или файл .xlsx.', '--from: a run folder or an .xlsx file.');
  let fromRun = null;
  const up = dirname(dirname(p));
  if (existsSync(join(up, 'report', 'findings.json'))) fromRun = up;
  else if (state.flags?.from_run && existsSync(join(String(state.flags.from_run), 'report', 'findings.json'))) fromRun = resolve(String(state.flags.from_run));
  return { kind: 'xlsx', from: p, fromRun, registry: p };
}

function pageMaps() {
  const cur = readOpt(join(run, 'pages.json'));
  const old = readOpt(join(run, 'pages.from.json'));
  const map = new Map();
  // pids of this run when its pages.json exists (a page that dropped out has no pid → probe --url); else the old ones
  for (const doc of cur ? [cur] : [old]) for (const s of doc?.selected || []) for (const u of [s.url, s.final_url]) if (u) map.set(normUrl(u), s.pid);
  const curPids = new Set((cur?.selected || []).map(s => s.pid));
  return { map, curPids, hasCurrent: !!cur };
}

function plan() {
  const from = str(args.from) || state.flags?.from || null;
  if (!from) fail(2, 'Нужен --from <папка прогона | registry.xlsx> (или init-run --mode recheck).', 'Need --from <run folder | registry.xlsx>.');
  const src = sourceOf(from);
  const warnings = [];
  const findings = src.fromRun ? readOpt(join(src.fromRun, 'report', 'findings.json')) : null;
  let reg = null;
  if (src.registry) {
    try { reg = readRegistry(src.registry); } catch (e) { reg = { error: e.message }; }
    if (reg.error) { warnings.push(T(`Реестр не прочитан (${reg.error}) — беру только findings.json.`, `Registry not read (${reg.error}) — using findings.json only.`)); reg = null; }
  }
  if (!findings?.items?.length && !reg?.rows?.length) fail(2, `Нечего перепроверять: нет report/findings.json и реестра в ${fwd(src.from)}.`, `Nothing to recheck: no report/findings.json or registry in ${fwd(src.from)}.`);
  if (reg && !reg.hidden) warnings.push(T('В реестре нет скрытого листа _revizor — сопоставляю по номеру строки (№) и адресу; селекторов и ширин нет.', 'No hidden _revizor sheet — matching by № and URL; no selectors or widths.'));

  // findings.json is the richest source; the registry adds statuses, comments and rows the user kept
  const items = new Map();
  const keyOf = (uid, rid) => uid || (rid ? `rid:${rid}` : null);
  for (const f of findings?.items || []) {
    const key = keyOf(f.uid, f.rid);
    if (!key) continue;
    items.set(key, { uid: key, rid: f.rid || null, title: f.title || '', severity: sevOf(f.severity, f.rid), lens: f.lens || (f.lenses || [])[0] || null,
      lenses: f.lenses || (f.lens ? [f.lens] : []), topic: f.category || null, method: f.method || null, norm: f.norm || null, fix: f.fix || null, fix_check: f.fix_check || null,
      status_before: 'новое', comment: '', where: (f.where || []).map(w => ({ url: w.url || null, pid_old: w.pid || null, selector: w.selector || null, viewport: w.viewport ?? null, state: w.state || null, block: w.block || null })),
      source: 'findings' });
  }
  if (reg) {
    // a registry without _revizor: its rows meet findings.json by rid (the uid of the finding is kept)
    const ridKey = new Map([...items.values()].filter(it => it.rid).map(it => [it.rid, it.uid]));
    for (const row of reg.rows) {
      const key = row.uid || (row.rid && ridKey.get(row.rid)) || keyOf(null, row.rid);
      if (!key) continue;
      const h = row.uid ? reg.byUid.get(row.uid) : null;
      const it = items.get(key) || { uid: key, rid: row.rid || null, title: row.what, severity: sevOf(row.severity, row.rid) || sevFromLabel(row.severity),
        lens: h?.lens || (row.lenses ? row.lenses.split(/[,;\s]+/)[0] : null), lenses: row.lenses ? row.lenses.split(/[,;\s]+/).filter(Boolean) : (h?.lens ? [h.lens] : []),
        topic: row.topic || row.section || null, method: h?.method || row.method || null, norm: h?.norm || row.norm || null, fix: row.fix || null,
        where: [{ url: h?.url || firstUrl(row.where), pid_old: null, selector: h?.selector || null, viewport: h?.viewport || null, state: h?.state || null, block: row.where || null }],
        source: 'registry' };
      it.status_before = row.status || 'новое';
      it.comment = row.comment || '';
      it.registry_row = row.r;
      if (!it.title) it.title = row.what;
      items.set(key, it);
    }
  }

  // pages of this run (same pid as before thanks to crawl --pages-from)
  const pm = pageMaps();
  if (!pm.hasCurrent) warnings.push(T('В этом RUN ещё нет pages.json — страницы взяты из прошлого прогона (pages.from.json).', 'No pages.json in this run yet — pages taken from the previous run.'));
  const pagesMissing = new Set();
  for (const it of items.values()) {
    for (const w of it.where) {
      w.pid = w.url && pm.map.size ? (pm.map.get(normUrl(w.url)) || null) : (w.pid_old && (!pm.hasCurrent || pm.curPids.has(w.pid_old)) ? w.pid_old : null);
      if (!w.pid && w.url) pagesMissing.add(w.url);
    }
  }

  const skipped = [], todo = [];
  for (const it of items.values()) {
    if (isWontFix(it.status_before)) skipped.push({ uid: it.uid, rid: it.rid, title: String(it.title || '').slice(0, 120), status: it.status_before, comment: it.comment || null, why: T('не будем исправлять', "won't fix") });
    else todo.push(it);
  }

  // groups: lens (or topic) → chunks; method of a group = the most common one
  const normMethod = m => {
    const s = String(m || '').toLowerCase().trim();
    if (!s || s === 'manual') return 'screenshot';
    if (s === 'axe') return 'script:axe';
    if (/^script:/.test(s) || ['probe', 'fetch', 'screenshot', 'dom'].includes(s)) return s;
    return s.split(/[|,\s]/)[0] || 'screenshot';
  };
  const size = Math.max(3, Math.min(40, Number(args['group-size']) || 12));
  const byLens = new Map();
  for (const it of todo) {
    const k = it.lens || (it.topic ? `тема:${String(it.topic).toLowerCase().slice(0, 40)}` : 'general');
    if (!byLens.has(k)) byLens.set(k, []);
    byLens.get(k).push(it);
  }
  const SEV_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const groups = [];
  for (const [lensKey, list] of [...byLens].sort((a, b) => b[1].length - a[1].length)) {
    list.sort((a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9));
    for (let i = 0; i < list.length; i += size) {
      const chunk = list.slice(i, i + size);
      const mc = new Map();
      for (const it of chunk) { const m = normMethod(it.method); mc.set(m, (mc.get(m) || 0) + 1); }
      const method = [...mc].sort((a, b) => b[1] - a[1])[0][0];
      const sev = {};
      for (const it of chunk) sev[it.severity || '?'] = (sev[it.severity || '?'] || 0) + 1;
      groups.push({ id: `g${groups.length + 1}`, lens: lensKey.startsWith('тема:') || lensKey === 'general' ? null : lensKey, topic: lensKey.startsWith('тема:') ? lensKey.slice(5) : null,
        method, methods: Object.fromEntries(mc), uids: chunk.map(it => it.uid), pages: [...new Set(chunk.flatMap(it => it.where.map(w => w.pid).filter(Boolean)))], count: chunk.length, severity: sev });
    }
  }
  // audience of the registry: _revizor meta, else the old run (state/brief)
  const oldState = src.fromRun ? readOpt(join(src.fromRun, 'state.json')) : null;
  const oldBrief = src.fromRun ? (readOpt(join(src.fromRun, 'brief.json')) || readOpt(join(src.fromRun, 'brief.input.json'))) : null;
  const meta = { ...(reg?.meta || {}) };
  meta.audience = pickAudience(meta.audience, oldState?.flags?.audience, oldBrief?.audience);
  const doc = { tool: 'recheck', version: U.VERSION, run, generated: U.nowIso(), from: fwd(src.from), from_kind: src.kind, from_run: src.fromRun ? fwd(src.fromRun) : null,
    registry: src.registry ? fwd(src.registry) : null, meta, groups, items: Object.fromEntries(todo.map(it => [it.uid, it])), skipped,
    counts: { total: items.size, to_check: todo.length, skipped: skipped.length, groups: groups.length }, pages_missing: [...pagesMissing].slice(0, 100), warnings };
  U.writeJSON(U.insideRun(run, 'recheck', 'plan.json'), doc);
  U.log(run, `recheck: план — ${todo.length} к перепроверке, ${skipped.length} «не будем исправлять», групп ${groups.length}`);
  const lines = [T(`recheck: план готов · к перепроверке ${todo.length} из ${items.size} · «не будем исправлять» ${skipped.length} · групп ${groups.length} · аудитория ${meta.audience}`,
    `recheck: plan ready · to check ${todo.length} of ${items.size} · won't fix ${skipped.length} · groups ${groups.length} · audience ${meta.audience}`)];
  lines.push(T(`Источник: ${fwd(src.from)}${src.registry && src.registry !== src.from ? ` · реестр ${basename(src.registry)}` : ''}${src.fromRun && src.kind === 'xlsx' ? ` · findings из ${fwd(src.fromRun)}` : ''}`,
    `Source: ${fwd(src.from)}${src.registry && src.registry !== src.from ? ` · registry ${basename(src.registry)}` : ''}`));
  for (const g of groups.slice(0, 24)) lines.push(`  ${g.id.padEnd(4)} ${(g.lens || g.topic || '—').slice(0, 22).padEnd(22)} ${g.method.padEnd(15)} ${String(g.count).padStart(3)} · ${Object.entries(g.severity).map(([k, v]) => `${k}×${v}`).join(' ')} · ${T('стр.', 'pages')} ${g.pages.join(',') || '—'}`);
  if (groups.length > 24) lines.push(T(`  …и ещё ${groups.length - 24} групп`, `  …and ${groups.length - 24} more groups`));
  if (pagesMissing.size) lines.push(T(`Адресов нет среди страниц этого прогона: ${pagesMissing.size} (агент проверит их через probe --url).`, `URLs not among this run's pages: ${pagesMissing.size} (check with probe --url).`));
  for (const w of warnings) lines.push('! ' + w);
  lines.push(`${T('Записано', 'Written')}: ${fwd(join(run, 'recheck', 'plan.json'))}`);
  U.printAndSaveSummary(run, 'recheck', lines);
}

// ---------- collect ----------
function collect() {
  const planDoc = readOpt(join(run, 'recheck', 'plan.json'));
  if (!planDoc) fail(2, 'Нет recheck/plan.json — сначала node recheck.mjs --run … --from ….', 'No recheck/plan.json — run the plan step first.');
  const audience = pickAudience(planDoc.meta?.audience);
  const dir = join(run, 'recheck');
  const results = new Map(), news = [], files = [], bad = [];
  for (const n of readdirSync(dir).filter(n => /\.json$/i.test(n) && !/^(plan|result)\.json$/i.test(n)).sort()) {
    const j = readOpt(join(dir, n));
    if (!j || typeof j !== 'object') { bad.push(n); continue; }
    files.push(n);
    const group = n.replace(/\.json$/i, '');
    for (const it of Array.isArray(j.items) ? j.items : []) {
      if (!it?.uid) continue;
      const status = String(it.status || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
      const rec = { uid: it.uid, status, evidence: it.evidence || null, shot: it.shot || null, box: it.box || null, note: it.note || null, group };
      if (!STATUSES.includes(status)) { rec.note = `${T('неизвестный статус', 'unknown status')} «${it.status}»${rec.note ? '; ' + rec.note : ''}`; rec.status = 'cannot_check'; }
      const prev = results.get(it.uid);
      if (!prev || (prev.status === 'cannot_check' && rec.status !== 'cannot_check')) results.set(it.uid, rec);
    }
    // the skeptic names a new finding "new:<group>:<index in this file's new array>"
    (Array.isArray(j.new) ? j.new : []).forEach((f, idx) => { if (f && typeof f === 'object') news.push({ ...f, _group: group, _idx: idx, _key: `new:${group}:${idx}` }); });
  }
  // skeptic: fixed P0–P1, every regressed, new findings
  const verdicts = new Map();
  let verifyFiles = [];
  try { verifyFiles = readdirSync(join(run, 'verify')).filter(x => /^recheck.*\.json$/i.test(x)).sort((a, b) => (a === 'recheck.json' ? -1 : b === 'recheck.json' ? 1 : a.localeCompare(b))); } catch { /* none */ }
  const warnings = [];
  for (const n of verifyFiles) {
    const v = readOpt(join(run, 'verify', n));
    // a skeptic file that does not parse: its verdicts are lost — say so, the orchestrator reruns the skeptic
    if (!v || typeof v !== 'object' || (v.verdicts !== undefined && !Array.isArray(v.verdicts))) {
      bad.push(`verify/${n}`);
      warnings.push(T(`Файл скептика verify/${n} не читается — его вердикты не применены, перезапусти скептика.`, `Skeptic file verify/${n} does not parse — its verdicts are not applied; rerun the skeptic.`));
      continue;
    }
    for (const x of v?.verdicts || []) { const id = x.uid || x.id; if (id) verdicts.set(String(id), x); }
  }
  const items = [];
  const counts = Object.fromEntries([...STATUSES, 'unchecked', 'skipped'].map(s => [s, 0]));
  let disputed = 0;
  for (const [uid, p] of Object.entries(planDoc.items || {})) {
    const r = results.get(uid);
    const it = { uid, rid: p.rid, title: p.title, severity: p.severity, lens: p.lens, status_before: p.status_before, url: p.where?.[0]?.url || null,
      status: r?.status || 'unchecked', evidence: r?.evidence || null, shot: r?.shot || null, box: r?.box || null, note: r?.note || null, group: r?.group || null };
    const v = verdicts.get(uid);
    if (v) {
      it.skeptic = v.verdict || null;
      if (v.note || v.how) it.skeptic_note = [v.how, v.note].filter(Boolean).join(' — ').slice(0, 400);
      if (v.verdict === 'rejected' && it.status === 'fixed') { it.status = 'not_fixed'; it.note = [T('повторная проверка не подтвердила исправление', 'a second check did not confirm the fix'), it.note].filter(Boolean).join('; '); }
      else if (v.verdict === 'rejected' && it.status === 'regressed') { it.status = 'not_fixed'; it.regression_rejected = true; disputed++; it.note = [T('ухудшение не подтвердилось при повторной проверке', 'the regression was not confirmed by a second check'), it.note].filter(Boolean).join('; '); }
    }
    counts[it.status] = (counts[it.status] || 0) + 1;
    items.push(it);
  }
  counts.skipped = (planDoc.skipped || []).length;
  // new findings: skeptic verdicts by "new:<group>:<index>" or uid, then dedupe by title + first url; the uid is stable
  const usedUids = new Set([...Object.keys(planDoc.items || {}), ...(planDoc.skipped || []).map(s => s.uid)]);
  const stableUid = f => {
    for (let salt = 0; salt < 50; salt++) {
      const h = 'R-' + createHash('sha256').update(`${f.lens || ''}|${U.normText(f.title || '')}|${(f.where || [])[0]?.url || ''}|${salt}`).digest('hex').slice(0, 8);
      if (!usedUids.has(h)) { usedUids.add(h); return h; }
    }
    return 'R-' + createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 8);
  };
  const seen = new Set(), fresh = [], rejectedNew = [];
  for (const f of news) {
    const v = verdicts.get(f._key) || (f.uid ? verdicts.get(String(f.uid)) : null);
    const base = { title: f.title || null, group: f._group, index: f._idx, key: f._key };
    if (v?.verdict === 'rejected') { rejectedNew.push({ ...base, why: [v.how, v.note].filter(Boolean).join(' — ').slice(0, 300) || null }); continue; }
    const k = U.normText(`${f.title || ''}|${f.where?.[0]?.url || ''}`);
    if (seen.has(k)) continue; seen.add(k);
    const g = { ...f, uid: /^R-[0-9a-f]{8}$/i.test(f.uid || '') && !usedUids.has(f.uid) ? f.uid : null, skeptic: v?.verdict || null };
    if (g.uid) usedUids.add(g.uid); else g.uid = stableUid(f);
    if (v?.verdict === 'needs_device') g.needs_device = true;
    if (v && (v.note || v.how)) g.skeptic_note = [v.how, v.note].filter(Boolean).join(' — ').slice(0, 300);
    g.regression = (f.tags || []).some(t => /regress|регресс/i.test(String(t)));
    if (g.regression && !v) g.unverified = true;
    for (const x of ['_group', '_idx', '_key']) delete g[x];
    fresh.push(g);
  }
  // external: what needs a device or is unsure stays out of the client's registry (as report.mjs does with the report)
  const externalDropped = [];
  if (audience === 'external') {
    for (let i = fresh.length - 1; i >= 0; i--) {
      const f = fresh[i];
      if (f.needs_device || f.needs_device_check || f.confidence === 'low') { externalDropped.unshift({ uid: f.uid, title: f.title || null, why: f.needs_device || f.needs_device_check ? 'needs_device' : 'confidence_low' }); fresh.splice(i, 1); }
    }
  }
  const regressions = [...items.filter(i => i.status === 'regressed'), ...fresh.filter(f => f.regression).map(f => ({ uid: f.uid, title: f.title, severity: sevOf(f.severity), new: true, unverified: !!f.unverified }))];
  const groupsMissing = (planDoc.groups || []).map(g => g.id).filter(id => !files.includes(`${id}.json`));

  // new registry
  let xlsxOut = null, xlsxErr = null, extCleaned = 0;
  try { const w = writeRegistry(planDoc, items, fresh, audience); xlsxOut = w.path; extCleaned = w.cleaned; } catch (e) { xlsxErr = String(e?.message || e).slice(0, 300); }

  const doc = { tool: 'recheck', version: U.VERSION, run, generated: U.nowIso(), from: planDoc.from, audience, registry_in: planDoc.registry, registry_out: xlsxOut ? fwd(xlsxOut) : null,
    counts, disputed, items, regressions, new: fresh, rejected_new: rejectedNew, skipped: planDoc.skipped || [], files, bad_files: bad, warnings, groups_missing: groupsMissing,
    external_cleaned: audience === 'external' ? extCleaned : undefined, external_dropped: audience === 'external' ? externalDropped : undefined, registry_error: xlsxErr };
  U.writeJSON(U.insideRun(run, 'recheck', 'result.json'), doc);
  U.log(run, `recheck: итог — исправлено ${counts.fixed}, частично ${counts.partial}, не исправлено ${counts.not_fixed}, регрессий ${regressions.length}, новых ${fresh.length}, новых отклонено ${rejectedNew.length}`);

  const L = LABEL[lang];
  const lines = [T(`recheck: итог · ${items.length} перепроверено, ${counts.skipped} «не будем исправлять» · аудитория ${audience}`, `recheck: result · ${items.length} rechecked, ${counts.skipped} won't fix · audience ${audience}`)];
  lines.push(STATUSES.concat('unchecked').filter(s => counts[s]).map(s => `${L[s].split(' (')[0]} ${counts[s]}`).join(' · ') || '—');
  if (regressions.length) lines.push(T(`Регрессии: ${regressions.length}`, `Regressions: ${regressions.length}`));
  for (const r of regressions.slice(0, 6)) lines.push(`  ! ${r.rid || r.uid} ${String(r.title || '').slice(0, 90)}${r.unverified ? T(' (скептик не смотрел — нужен)', ' (no skeptic verdict yet)') : ''}`);
  if (disputed) lines.push(T(`Регрессия не подтвердилась (скептик), стало «не исправлено»: ${disputed}`, `Regressions rejected by the skeptic (now not fixed): ${disputed}`));
  if (fresh.length) lines.push(T(`Новые находки: ${fresh.length}`, `New findings: ${fresh.length}`));
  for (const f of fresh.slice(0, 5)) lines.push(`  + ${sevOf(f.severity) || '?'} ${String(f.title || '').slice(0, 90)}${f.needs_device ? T(' (на устройстве)', ' (on a device)') : ''}`);
  if (rejectedNew.length) lines.push(T(`Новые, отклонённые скептиком (в реестр не пошли): ${rejectedNew.map(r => r.key).join(', ')}`, `New findings rejected by the skeptic (left out): ${rejectedNew.map(r => r.key).join(', ')}`));
  const notFixedTop = items.filter(i => i.status === 'not_fixed' && /P[01]/.test(i.severity || '')).slice(0, 5);
  if (notFixedTop.length) lines.push(T('Не исправлено из P0–P1:', 'Not fixed among P0–P1:'));
  for (const i of notFixedTop) lines.push(`  - ${i.rid || i.uid} ${String(i.title || '').slice(0, 90)}`);
  if (counts.unchecked) lines.push(T(`Без данных: ${counts.unchecked} (агент не прислал итог${groupsMissing.length ? `; нет файлов групп: ${groupsMissing.join(', ')}` : ''}).`, `No data: ${counts.unchecked}${groupsMissing.length ? ` (missing group files: ${groupsMissing.join(', ')})` : ''}.`));
  if (externalDropped.length) lines.push(T(`Для внешнего реестра не взяты (проверка на устройстве или низкая уверенность): ${externalDropped.length} — result.json → external_dropped.`, `Left out of the external registry (device check or low confidence): ${externalDropped.length}.`));
  if (audience === 'external' && extCleaned) lines.push(T(`Для внешнего реестра из «Итога» убрано строк со служебными словами: ${extCleaned}.`, `External registry: ${extCleaned} result cells with internal words left empty.`));
  if (bad.length) lines.push(T(`Битые файлы: ${bad.join(', ')}`, `Broken files: ${bad.join(', ')}`));
  for (const w of warnings) lines.push('! ' + w);
  lines.push(`${T('Записано', 'Written')}: ${fwd(join(run, 'recheck', 'result.json'))}`);
  lines.push(xlsxOut ? `${T('Реестр', 'Registry')}: ${fwd(xlsxOut)}${planDoc.registry ? T(' (исходный не тронут)', ' (input untouched)') : ''}` : T(`Реестр не записан: ${xlsxErr}`, `Registry not written: ${xlsxErr}`));
  U.printAndSaveSummary(run, 'recheck', lines);
  if (!xlsxOut) process.exitCode = 1;
}

// ---------- names for people: topic, page, external text ----------
function lensName(lens, regLang) { const s = STRINGS[regLang] || STRINGS.ru || {}; return (lens && s.lens_names?.[lens]) || lens || ''; }
function pageLabel(url, regLang) {
  const s = STRINGS[regLang] || STRINGS.ru || {};
  const pages = [...(readOpt(join(run, 'pages.json'))?.selected || []), ...(readOpt(join(run, 'pages.from.json'))?.selected || [])];
  const p = url ? pages.find(x => normUrl(x.url) === normUrl(url) || (x.final_url && normUrl(x.final_url) === normUrl(url))) : null;
  const home = s.home || (regLang === 'en' ? 'Home' : 'Главная');
  if (p?.pid === 'home') return home;
  let t = p?.title ? String(p.title).split(/\s+[|—–·]\s+|\s+-\s+/)[0].trim() : '';
  if (t.length > 48) t = t.slice(0, 46).trimEnd() + '…';
  if (t) return t;
  try { const x = new URL(url); const path = decodeURI(x.pathname); return !path || path === '/' ? home : path; } catch { return ''; }
}
// tone.md forbidden lists (all + audience) through util.compileStopTerm; quotes of the site are not scanned
function forbiddenRules(audience) {
  let src = null;
  try { const md = readFileSync(join(PLUGIN, 'knowledge', 'tone.md'), 'utf8'); src = U.knowledgeBlock(md, 'forbidden'); } catch { src = null; }
  const list = [...(src?.all || []), ...(src?.[audience] || [])];
  if (audience === 'external') list.push('/(?:snapshot|measure|findings|verify|critic|notes|stdout|probe-js|probe|recheck)\\/[\\w.\\/-]+/u', '/(?<![\\w-])(?:script|revizor):[a-z-]+/u', '/(?<![A-Za-z])[A-Za-z]:[\\\\/]/u');
  return list.map(e => U.compileStopTerm(e)).filter(Boolean);
}
const stripQuoted = s => String(s ?? '').replace(/«[^«»]*»/g, ' ').replace(/“[^“”]*”/g, ' ').replace(/"[^"\n]*"/g, ' ').replace(/`[^`]*`/g, ' ');
// the fact only: technical sources in [brackets] (nested brackets too), commands and paths are cut off
function dropBrackets(s) {
  let out = '', depth = 0;
  for (const ch of String(s || '')) {
    if (ch === '[') { depth++; continue; }
    if (ch === ']' && depth > 0) { depth--; continue; }
    if (!depth) out += ch;
  }
  return out;
}
const factOnly = s => dropBrackets(s).replace(/(?:^|\s)(?:node\s+\S+|probe\s+--\S+[^.;]*)/g, ' ').replace(/\s{2,}/g, ' ').trim().replace(/[\s,;·—-]+$/, '');

// ---------- the new registry ----------
const WIDTH = { '№': 8, 'важность': 12, 'раздел сайта': 16, 'тема': 16, 'что на сайте': 50, 'где url блок': 32, 'как исправить': 50, 'кто': 14, 'трудоемкость': 12,
  'статус': 16, 'комментарий': 30, 'проверено': 12, 'итог перепроверки': 50, 'uid': 12, 'линзы': 14, 'метод': 14, 'норма': 24, 'уверенность': 12 };
const widthOf = h => { const n = U.normHeader(h); if (WIDTH[n]) return WIDTH[n]; if (/^(проверено|checked)/.test(n)) return 16; if (/итог|result/.test(n)) return 50; return 16; };
const excelDate = n => { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n * 86400000)); const p = x => String(x).padStart(2, '0'); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`; };

function writeRegistry(planDoc, items, fresh, audience) {
  const now = new Date();
  const p2 = x => String(x).padStart(2, '0');
  const ddmm = `${p2(now.getDate())}.${p2(now.getMonth() + 1)}`;
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  const byUid = new Map(items.map(i => [i.uid, i]));
  const skippedUids = new Set((planDoc.skipped || []).map(s => s.uid));
  // rows without a uid cell meet the plan by rid (the plan keeps the uid from findings.json)
  const ridToKey = new Map([...Object.values(planDoc.items || {}), ...(planDoc.skipped || [])].filter(x => x.rid).map(x => [x.rid, x.uid]));
  const keyOfRow = row => row.uid || (row.rid && ridToKey.get(row.rid)) || (row.rid ? `rid:${row.rid}` : null);
  const ext = audience === 'external';
  const rules = forbiddenRules(audience);
  let cleaned = 0;
  const clean = text => { // external: the fact only, and nothing from the forbidden list
    const t = factOnly(text);
    if (!t) return null;
    if (rules.some(r => r.re.test(stripQuoted(t)))) { cleaned++; return null; }
    return t.slice(0, 600);
  };
  const resultText = (it, en) => {
    if (ext) return clean(it.evidence);
    const parts = [it.evidence, it.note];
    if (audience === 'team' && it.skeptic_note) parts.push(`${en ? 'skeptic' : 'скептик'}: ${it.skeptic_note}`);
    return parts.filter(Boolean).join(' · ').slice(0, 600) || null;
  };
  let reg = null;
  if (planDoc.registry && existsSync(planDoc.registry)) { try { reg = readRegistry(planDoc.registry); if (reg.error) reg = null; } catch { reg = null; } }
  const sheets = [];
  const newHidden = (f, ridV) => { const w = (f.where || [])[0] || {}; return { uid: f.uid, rid: ridV, url: w.url || null, selector: w.selector || null, viewport: w.viewport ?? null, state: w.state || null,
    method: ext ? null : f.method || null, lens: ext ? null : f.lens || null, norm: f.norm || null }; };
  if (reg) {
    const enHeaders = reg.cols.status !== undefined && /^(status|state)$/.test(U.normHeader(reg.main.rows[reg.headerRow][reg.cols.status]));
    const regLang = enHeaders ? 'en' : 'ru';
    const HDR_DATE = enHeaders ? `Checked ${ddmm}` : `Проверено ${ddmm}`, HDR_RES = enHeaders ? 'Recheck result' : 'Итог перепроверки';
    const LL = (ext ? LABEL_EXT : LABEL)[regLang]; // the registry keeps its own language
    const rows = reg.main.rows.map(r => [...(r || [])]);
    const hr = reg.headerRow;
    const header = rows[hr];
    const findCol = name => header.findIndex(h => U.normHeader(h) === U.normHeader(name));
    let cDate = findCol(HDR_DATE); if (cDate < 0) { cDate = Math.max(header.length, 0); header[cDate] = HDR_DATE; }
    let cRes = findCol(HDR_RES); if (cRes < 0) { cRes = header.length; header[cRes] = HDR_RES; }
    const ncol = header.length;
    // date-like numbers (Excel serials) in date columns → text, so they do not turn into 46320
    const dateCols = header.map((h, i) => (/дата|date|проверено|checked|срок|deadline/.test(U.normHeader(h)) ? i : -1)).filter(i => i >= 0);
    for (let r = hr + 1; r < rows.length; r++) for (const c of dateCols) if (typeof rows[r][c] === 'number' && rows[r][c] > 20000 && rows[r][c] < 80000) rows[r][c] = excelDate(rows[r][c]);
    for (const row of reg.rows) {
      const key = keyOfRow(row);
      const target = rows[row.r];
      if (!key || !target) continue;
      if (skippedUids.has(key)) { target[cDate] = LL.skipped; continue; }
      const it = byUid.get(key);
      if (!it) continue;
      // a second recheck on the same day without data for this row keeps what the first one wrote
      if (it.status === 'unchecked' && cellStr(target[cDate])) continue;
      target[cDate] = LL[it.status] || it.status;
      const res = resultText(it, enHeaders);
      target[cRes] = res;
    }
    // new findings as rows at the end
    const c = reg.cols;
    const sevStyle = (() => { const v = String(reg.rows[0]?.severity || ''); return /^P[0-3]$/.test(v) ? 'code' : /\(P[0-3]\)/.test(v) ? 'label' : 'code'; })();
    const SEV_LABELS = (STRINGS[regLang] || STRINGS.ru || {}).sev || {};
    const sevCell = sev => {
      if (sevStyle !== 'label') return sev;
      const labels = SEV_LABELS[ext ? 'external' : 'owner'] || [];
      const n = Number(sev[1]);
      return labels[n] ? `${labels[n]} (${sev})` : sev;
    };
    // new rows continue the N-numbering of earlier rechecks
    const nBase = Math.max(0, ...reg.rows.map(r => Number((String(r.rid).match(/^N-(\d+)$/) || [])[1]) || 0));
    const nRid = i => 'N-' + String(nBase + i + 1).padStart(2, '0');
    fresh.forEach((f, i) => {
      const row = new Array(ncol).fill(null);
      const sev = sevOf(f.severity) || 'P2';
      const w = (f.where || [])[0] || {};
      const set = (k, v) => { if (c[k] !== undefined && v !== undefined && v !== null && v !== '') row[c[k]] = v; };
      set('rid', nRid(i));
      set('severity', sevCell(sev));
      set('section', pageLabel(w.url, regLang) || null); set('topic', lensName(f.lens || f.category, regLang) || null); set('what', f.title || f.problem || null);
      set('where', [w.url, w.block].filter(Boolean).join(' · ') || null); set('fix', f.fix || null); set('who', f.owner || null); set('effort', f.effort || null);
      set('status', enHeaders ? 'new' : 'новое'); set('uid', f.uid);
      if (!ext) { set('lenses', f.lens || null); set('method', f.method || null); set('confidence', f.confidence || null); }
      set('norm', f.norm || null);
      row[cDate] = LL.new + (f.needs_device && !ext ? (enHeaders ? ' (check on a device)' : ' (проверить на устройстве)') : '');
      row[cRes] = ext ? clean(f.evidence) : (String(f.evidence || '').slice(0, 600) || null);
      rows.push(row);
    });
    const statusList = enHeaders ? ['new', 'in progress', 'fixed', "won't fix"] : ['новое', 'в работе', 'исправлено', 'не будем исправлять'];
    const main = { name: reg.main.name, hidden: reg.main.hidden || false,
      columns: rows[0].map(h => ({ header: h ?? '', width: widthOf(h) })).concat(Array.from({ length: Math.max(0, ncol - rows[0].length) }, () => ({ header: '', width: 16 }))),
      rows: rows.slice(1).map(r => Array.from({ length: ncol }, (_, i) => (r[i] === undefined ? null : r[i]))), freeze: hr === 0, autoFilter: hr === 0,
      validations: c.status !== undefined ? [{ col: colName(c.status), list: statusList }] : [],
      cellStyle: (ri, ci, v) => (ci === c.severity && typeof v === 'string' ? ((v.match(/P([0-3])/) || [])[1] !== undefined ? `p${v.match(/P([0-3])/)[1]}` : 'wrap') : 'wrap') };
    if (hr > 0) main.columns = main.columns.map(col => ({ ...col, width: 16 }));
    // sheets in their original order: main replaced, «Сводка» rebuilt with formulas, _revizor extended, the rest copied
    const sevCol = c.severity !== undefined ? colName(c.severity) : null, dateCol = colName(cDate), statusCol = c.status !== undefined ? colName(c.status) : null;
    const q = s => `'${String(s).replace(/'/g, "''")}'`;
    const hiddenSheet = () => {
      const hf = reg.hiddenFound;
      const hrows = reg.hidden ? reg.hidden.rows.map(r => [...(r || [])]) : [['uid', 'rid', 'url', 'selector', 'viewport', 'state', 'method', 'lens', 'norm']];
      const hcols = hf ? hf.cols : { uid: 0, rid: 1, url: 2, selector: 3, viewport: 4, state: 5, method: 6, lens: 7, norm: 8 };
      const width = Math.max(9, hrows[hf?.headerRow ?? 0]?.length || 9);
      const put = (rec) => { const r = new Array(width).fill(null); for (const [k, v] of Object.entries(rec)) if (hcols[k] !== undefined) r[hcols[k]] = v ?? null; hrows.push(r); };
      // no _revizor in the input: keep the uids of rows matched through findings.json, so the next recheck finds them
      if (!reg.hidden) for (const row of reg.rows) { const key = keyOfRow(row); if (key && /^R-/.test(key)) put({ uid: key, rid: row.rid || null, url: byUid.get(key)?.url || firstUrl(row.where) || null }); }
      fresh.forEach((f, fi) => put(newHidden(f, nRid(fi))));
      if (!reg.hidden) hrows.push([], ['_meta', 'site', planDoc.meta?.site || state.flags?.url || '', 'audience', audience, 'plugin_version', U.VERSION, 'schema_version', '3']);
      hrows.push(['recheck_date', now.toISOString().slice(0, 10)]);
      return { name: '_revizor', hidden: true, columns: (hrows[0] || []).map(h => ({ header: h ?? '', width: 18 })), rows: hrows.slice(1) };
    };
    for (const sh of reg.book.sheets) {
      if (sh === reg.main) { sheets.push(main); continue; }
      const n = U.normHeader(sh.name);
      if (n === 'сводка' || n === 'summary') {
        const rowsS = [];
        const main$ = q(reg.main.name);
        if (sevCol) for (const p of ['P0', 'P1', 'P2', 'P3']) rowsS.push([enHeaders ? `Severity ${p}` : `Важность ${p}`, { f: `COUNTIF(${main$}!${sevCol}:${sevCol},"*${p}*")` }]);
        if (statusCol) for (const s of statusList) rowsS.push([enHeaders ? `Status «${s}»` : `Статус «${s}»`, { f: `COUNTIF(${main$}!${statusCol}:${statusCol},"${s.replace(/"/g, '""')}")` }]);
        for (const s of [...STATUSES, 'unchecked', 'skipped', 'new']) {
          const lab = LL[s];
          if (rowsS.some(r => r[0] === `${HDR_DATE}: ${lab}`)) continue;
          rowsS.push([`${HDR_DATE}: ${lab}`, { f: `COUNTIF(${main$}!${dateCol}:${dateCol},"${lab.replace(/"/g, '""')}*")` }]);
        }
        sheets.push({ name: sh.name, hidden: sh.hidden || false, columns: [{ header: enHeaders ? 'Indicator' : 'Показатель', width: 48 }, { header: enHeaders ? 'Count' : 'Количество', width: 14 }], rows: rowsS });
        continue;
      }
      if (sh.name === '_revizor') { sheets.push(hiddenSheet()); continue; }
      const rowsO = sh.rows.map(r => [...(r || [])]);
      if (n === 'как читать' || n === 'how to read') {
        rowsO.push(enHeaders ? [`«${HDR_DATE}», «${HDR_RES}»`, `Recheck result in words and what was seen. Rows N-01… are new findings of the recheck. Formulas and formatting of your own columns are carried over as values.`]
          : [`«${HDR_DATE}», «${HDR_RES}»`, `Итог перепроверки словами и что увидели. Строки N-01… — новые находки перепроверки. Формулы и оформление ваших столбцов перенесены значениями.`]);
      }
      sheets.push({ name: sh.name, hidden: sh.hidden || false, columns: (rowsO[0] || []).map(h => ({ header: h ?? '', width: Math.max(16, Math.min(80, String(h ?? '').length + 4)) })), rows: rowsO.slice(1) });
    }
    if (!reg.hidden) sheets.push(hiddenSheet());
  } else {
    // no registry: build the standard sheet from the plan (owner layout + uid on the hidden sheet)
    const LL = (ext ? LABEL_EXT : LABEL)[lang];
    const HDR_DATE = lang === 'en' ? `Checked ${ddmm}` : `Проверено ${ddmm}`;
    const head = lang === 'en' ? ['No.', 'Severity', 'Site section', 'Topic', 'Issue', 'Where (URL · block)', 'How to fix', 'Who', 'Effort', 'Status', 'Comment', 'Checked', HDR_DATE, 'Recheck result']
      : ['№', 'Важность', 'Раздел сайта', 'Тема', 'Что на сайте', 'Где (URL · блок)', 'Как исправить', 'Кто', 'Трудоёмкость', 'Статус', 'Комментарий', 'Проверено', HDR_DATE, 'Итог перепроверки'];
    const rows = [];
    const hidden = [];
    for (const it of Object.values(planDoc.items || {})) {
      const r = byUid.get(it.uid);
      const w = it.where?.[0] || {};
      rows.push([it.rid || '', it.severity || '', pageLabel(w.url, lang) || w.block || '', lensName(it.lens, lang) || it.topic || '', it.title || '', [w.url, w.block].filter(Boolean).join(' · '), it.fix || '', '', '',
        it.status_before || (lang === 'en' ? 'new' : 'новое'), it.comment || '', '', LL[r?.status || 'unchecked'], r ? resultText(r, lang === 'en') || '' : '']);
      hidden.push([it.uid, it.rid || '', w.url || '', w.selector || '', w.viewport ?? '', w.state || '', ext ? '' : it.method || '', ext ? '' : it.lens || '', it.norm || '']);
    }
    for (const s of planDoc.skipped || []) rows.push([s.rid || '', '', '', '', s.title || '', '', '', '', '', s.status || '', s.comment || '', '', LL.skipped, '']);
    fresh.forEach((f, i) => {
      const w = (f.where || [])[0] || {};
      rows.push([`N-${String(i + 1).padStart(2, '0')}`, sevOf(f.severity) || 'P2', pageLabel(w.url, lang) || '', lensName(f.lens || f.category, lang), f.title || '', [w.url, w.block].filter(Boolean).join(' · '), f.fix || '', f.owner || '', f.effort || '',
        lang === 'en' ? 'new' : 'новое', '', '', LL.new, ext ? clean(f.evidence) || '' : String(f.evidence || '').slice(0, 600)]);
      const h = newHidden(f, `N-${String(i + 1).padStart(2, '0')}`);
      hidden.push([h.uid, h.rid, h.url || '', h.selector || '', h.viewport ?? '', h.state || '', h.method || '', h.lens || '', h.norm || '']);
    });
    sheets.push({ name: lang === 'en' ? 'Issues' : 'Замечания', columns: head.map(h => ({ header: h, width: widthOf(h) })), rows, freeze: true, autoFilter: true,
      validations: [{ col: 'J', list: lang === 'en' ? ['new', 'in progress', 'fixed', "won't fix"] : ['новое', 'в работе', 'исправлено', 'не будем исправлять'] }],
      cellStyle: (ri, ci, v) => (ci === 1 && /^P[0-3]$/.test(String(v)) ? `p${String(v)[1]}` : 'wrap') });
    hidden.push([], ['_meta', 'site', planDoc.meta?.site || state.flags?.url || '', 'audience', audience, 'plugin_version', U.VERSION, 'schema_version', '3'], ['recheck_date', now.toISOString().slice(0, 10)]);
    sheets.push({ name: '_revizor', hidden: true, columns: ['uid', 'rid', 'url', 'selector', 'viewport', 'state', 'method', 'lens', 'norm'].map(h => ({ header: h, width: 18 })), rows: hidden });
  }
  const repDir = U.ensureDir(U.insideRun(run, 'report'));
  let out = join(repDir, `registry-recheck-${stamp}.xlsx`);
  for (let k = 2; existsSync(out) || (planDoc.registry && resolve(out) === resolve(planDoc.registry)); k++) out = join(repDir, `registry-recheck-${stamp}-${k}.xlsx`);
  writeXlsx(U.insideRun(run, 'report', basename(out)), { sheets, creator: ext ? (planDoc.meta?.site || '') : 'Revizor' });
  // the file must keep _revizor hidden: lib/xlsx writes state="hidden" for { hidden: true } — check it was honoured
  const back = readXlsx(out).sheets.find(s => s.name === '_revizor');
  if (back && !back.hidden) throw new Error('лист _revizor записался видимым — обновите lib/xlsx.mjs (поддержка sheet.hidden)');
  return { path: out, cleaned };
}

function str(v) { return v === undefined || v === null || v === true ? null : String(v); }

try {
  if (args.collect) collect(); else plan();
} catch (e) {
  console.error(T('recheck: сбой — ', 'recheck: failure — ') + (e?.stack || e));
  try { U.log(run, `recheck: сбой ${String(e?.message || e).slice(0, 200)}`); } catch { /* ignore */ }
  process.exit(1);
}
