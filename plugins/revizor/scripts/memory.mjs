#!/usr/bin/env node
// Revizor — per-site memory <out>/<host>/site-memory.json: owner decisions, "do not suggest",
// verified facts, known issues, "do not touch", the last brief. init-run mixes it into brief.input.json.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as U from './lib/util.mjs';
import { readXlsx } from './lib/xlsx.mjs';

export function memoryPath(out, hk) { return join(out, hk, 'site-memory.json'); }
export function readMemory(out, hk) {
  const p = memoryPath(out, hk);
  return existsSync(p) ? U.readJSON(p, null) : null;
}
function emptyMemory(host) {
  return { host, owner_decisions: [], do_not_suggest: [], verified_facts: {}, known_issues: [], do_not_touch: [], brief_last: null, updated: U.nowIso() };
}
async function updateMemory(out, hk, host, mutator) {
  const p = memoryPath(out, hk);
  U.ensureDir(join(out, hk));
  return U.withFileLock(p + '.lock', async () => {
    const m = { ...emptyMemory(host), ...(existsSync(p) ? U.readJSON(p, {}) || {} : {}) };
    for (const k of ['owner_decisions', 'do_not_suggest', 'known_issues', 'do_not_touch']) if (!Array.isArray(m[k])) m[k] = [];
    if (!m.verified_facts || typeof m.verified_facts !== 'object') m.verified_facts = {};
    const res = await mutator(m);
    m.updated = U.nowIso();
    U.writeJSON(p, m);
    return res;
  });
}

const KINDS = { decision: 'owner_decisions', decisions: 'owner_decisions', owner_decisions: 'owner_decisions', do_not_suggest: 'do_not_suggest',
  known: 'known_issues', known_issues: 'known_issues', do_not_touch: 'do_not_touch', fact: 'verified_facts', facts: 'verified_facts', verified_facts: 'verified_facts' };
const today = () => new Date().toISOString().slice(0, 10);
const textOf = it => (typeof it === 'string' ? it : it?.text || '');
function pushUnique(arr, item) {
  const key = item.uid ? `uid:${item.uid}` : U.normText(item.text);
  if (arr.some(x => (x.uid && item.uid ? `uid:${x.uid}` === key : U.normText(textOf(x)) === U.normText(item.text)))) return false;
  arr.push(item); return true;
}

// ---------- registry (xlsx) ----------
const normHead = s => U.normText(String(s ?? '')).replace(/[()·.,:;]/g, ' ').replace(/\s+/g, ' ').trim();
const COLS = {
  rid: ['№', 'no', 'n', 'номер', '#', 'rid', 'id'], severity: ['важность', 'severity', 'priority', 'приоритет'],
  section: ['раздел сайта', 'раздел', 'section'], topic: ['тема', 'topic'], what: ['что на сайте', 'что не так', 'проблема', 'замечание', 'issue', 'what'],
  where: ['где url блок', 'где', 'where', 'url'], status: ['статус', 'status', 'состояние'], comment: ['комментарий', 'комментарии', 'comment', 'comments', 'notes', 'примечание'],
  uid: ['uid'],
};
/** Find columns by header synonyms (case, ё/е, punctuation ignored). → { headerRow, cols: { name: index } } */
export function findRegistryColumns(rows, map = COLS) {
  for (let r = 0; r < Math.min(rows.length, 8); r++) {
    const heads = (rows[r] || []).map(normHead);
    const cols = {};
    for (const [name, syn] of Object.entries(map)) {
      const ns = syn.map(normHead);
      let i = heads.findIndex(h => ns.includes(h));
      if (i < 0) i = heads.findIndex(h => h && ns.some(s => s.length > 2 && h.startsWith(s)));
      if (i >= 0) cols[name] = i;
    }
    if (cols.status !== undefined && (cols.what !== undefined || cols.topic !== undefined || cols.rid !== undefined)) return { headerRow: r, cols };
  }
  return null;
}
// «не будем исправлять», «won't fix» / «won’t fix» / «wont fix» / «wontfix» / «will not fix» (raw cell text: normText turns ' into ")
const WONT_FIX = /не\s*будем|не\s*исправля|won["'’`]?t\s*fix|will\s*not\s*fix/i;
export const isWontFix = status => { const raw = String(status ?? '').toLowerCase(); return WONT_FIX.test(raw) || WONT_FIX.test(U.normText(raw)); };
export function registryWontFix(xlsxPath) {
  const book = readXlsx(xlsxPath);
  const order = [...book.sheets].sort((a, b) => (normHead(b.name) === 'замечания') - (normHead(a.name) === 'замечания'));
  let sheet = null, found = null;
  for (const sh of order) { if (sh.name === '_revizor') continue; const f = findRegistryColumns(sh.rows); if (f) { sheet = sh; found = f; break; } }
  if (!sheet) return { error: 'Не нашёл лист с колонкой «Статус».', items: [], meta: {} };
  // hidden sheet: rid → uid, meta
  const hidden = book.sheets.find(s => s.name === '_revizor');
  const ridToUid = {}, meta = {};
  if (hidden) {
    const hr = hidden.rows.findIndex(row => (row || []).some(c => normHead(c) === 'uid') && (row || []).some(c => normHead(c) === 'rid'));
    const f = hr < 0 ? null : { headerRow: hr, cols: { uid: hidden.rows[hr].findIndex(c => normHead(c) === 'uid'), rid: hidden.rows[hr].findIndex(c => normHead(c) === 'rid') } };
    for (const row of hidden.rows) {
      for (let i = 0; i < row.length; i++) {
        const c = row[i];
        if (typeof c !== 'string') continue;
        const m = c.match(/^(site|run_date|plugin_version|schema_version)\s*[:=]\s*(.+)$/i);
        if (m) meta[m[1].toLowerCase()] = m[2].trim();
        else if (/^(site|run_date|plugin_version|schema_version)$/i.test(c) && row[i + 1] != null) meta[c.toLowerCase()] = String(row[i + 1]);
      }
    }
    if (f && f.cols.uid !== undefined && f.cols.rid !== undefined) {
      for (const row of hidden.rows.slice(f.headerRow + 1)) { const rid = row[f.cols.rid], uid = row[f.cols.uid]; if (rid && uid) ridToUid[String(rid).trim()] = String(uid).trim(); }
    }
  }
  const { cols, headerRow } = found;
  const cell = (row, k) => (cols[k] === undefined ? '' : String(row[cols[k]] ?? '').trim());
  const items = [];
  let total = 0;
  for (const row of sheet.rows.slice(headerRow + 1)) {
    if (!row || !row.some(x => x !== null && x !== undefined && x !== '')) continue;
    total++;
    if (!isWontFix(cell(row, 'status'))) continue;
    const rid = cell(row, 'rid'), comment = cell(row, 'comment');
    const head = [cell(row, 'topic') || cell(row, 'section'), cell(row, 'what')].filter(Boolean).join(': ');
    items.push({ text: (head || rid || 'замечание') + (comment ? ` — ${comment}` : ''), uid: cell(row, 'uid') || ridToUid[rid] || null, rid: rid || null, date: today(), source: 'registry' });
  }
  return { items, total, sheet: sheet.name, meta };
}

// ---------- rivals decisions ----------
const MARKS = [
  ['take', /^(беру|берём|берем|да|take|yes|✓|✔|\+)$/i],
  ['no', /^(нет|не\s*беру|не\s*берём|не\s*берем|no|skip|✗|✕|×|-)$/i],
  ['discuss', /^(обсудить|обсуждаем|discuss|\?)$/i],
];
const markOf = w => (MARKS.find(([, re]) => re.test(String(w).trim())) || [])[0] || null;
/** Lines like «беру: r-03 Калькулятор цены», «[нет] r-05 …», «r-07 Отзывы — обсудить». */
export function parseDecisions(text) {
  const out = { take: [], no: [], discuss: [] };
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim();
    if (!line || /^ревизор|^revizor/i.test(line)) continue;
    let m = line.match(/^\[?([^\]:—–-]{1,14}?)\]?\s*[:—–-]\s*(.+)$/) || line.match(/^\[([^\]]{1,14})\]\s*(.+)$/);
    let kind = m ? markOf(m[1]) : null, rest = m ? m[2] : null;
    if (!kind) { const t = line.match(/^(.+?)\s*[:—–-]\s*\[?([^\]:—–-]{1,14})\]?$/); if (t && markOf(t[2])) { kind = markOf(t[2]); rest = t[1]; } }
    if (kind && rest) out[kind].push(rest.trim());
  }
  return out;
}

function shortBrief(b) {
  const site = b.site || {};
  return { url: b.url || null, date: today(), lang: b.lang || null, audience: b.audience || null, vertical: b.vertical || null,
    market: b.market ? { value: b.market.value, search_engines: b.market.search_engines || [] } : null, stage: b.stage || null,
    platform: b.platform ? { name: b.platform.name, version: b.platform.version || null } : null,
    site: { purpose: site.purpose || null, main_action: site.main_action || null, audience: site.audience || null, region: site.region || null, languages: site.languages || [] } };
}

const HELP = `
memory.mjs — память сайта Ревизора: <out>/<хост>/site-memory.json (общая для всех прогонов хоста).

Чей сайт:  --run "<RUN>"  или  --host <хост|адрес> [--out <папка прогонов>]
  --get [--json]                                  что помним
  --add decision|do_not_suggest|fact|known|do_not_touch --text "…" | --text-file <файл> [--source user] [--uid R-…]
        текст с сайта или из отчёта (заголовок находки) — только --text-file: в командной строке он не нужен
        fact: --text "Телефон=+7 000 000-00-00" (имя=значение)
  --remove <вид> --text "…"                        забыть запись (для fact — имя)
  --from-registry <registry.xlsx>                  строки со статусом «не будем исправлять» (+ комментарий) → do_not_suggest
  --decisions "<текст>" | --decisions-file <файл>  отметки из отчёта конкурентов: строки «беру: …», «нет: …», «обсудить: …»
        беру → owner_decisions, нет → do_not_suggest, обсудить — не сохраняем (только счёт)
  --save-brief [<brief.json>]                      краткий бриф в brief_last (с --run берётся RUN/brief.json)
  --lang ru|en
Коды: 0 — готово, 2 — ошибка аргументов, 1 — сбой.
`;

// --text "…" or --text-file <file> (UTF-8, first 2000 chars, line breaks → spaces): texts from sites never go through the command line
function textArg(args, en) {
  if (args['text-file'] && args['text-file'] !== true) {
    const f = resolve(String(args['text-file']));
    try { return readFileSync(f, 'utf8').replace(/^﻿/, '').replace(/\s+/g, ' ').trim().slice(0, 2000); }
    catch (e) { console.error(en ? `--text-file: cannot read ${f}: ${e.message}` : `--text-file: не читается ${f}: ${e.message}`); process.exit(2); }
  }
  return args.text && args.text !== true ? String(args.text).trim() : '';
}

async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'json', 'get'] });
  U.helpAndExit(HELP, args);
  const lang = U.langOf(args);
  const en = lang === 'en';
  let run = null, out, hk, host;
  if (args.run && args.run !== true) {
    run = resolve(String(args.run));
    const st = U.readJSON(join(run, 'state.json'), null);
    if (!st) { console.error(en ? `No state.json in ${run}.` : `Нет state.json в ${run}.`); process.exit(2); }
    out = st.flags?.out || resolve(run, '..', '..'); hk = st.flags?.host_key || U.hostKey(st.flags?.url); host = st.flags?.host || hk;
  } else if (args.host && args.host !== true) {
    hk = U.hostKey(args.host); host = hk;
    if (!hk) { console.error(en ? 'Bad --host.' : 'Не понял --host.'); process.exit(2); }
    out = args.out && args.out !== true ? resolve(String(args.out)) : (U.readRevizorConfig().config.out ? resolve(U.readRevizorConfig().config.out) : U.defaultOutDir());
  } else { console.error(en ? 'Need --run "<RUN>" or --host <host>.' : 'Нужен --run "<RUN>" или --host <хост>.'); process.exit(2); }

  const say = lines => U.printAndSaveSummary(run, 'memory', lines);
  const markState = async (key, value) => { if (!run) return; try { const { setDone } = await import('./state.mjs'); await setDone(run, { [key]: value }); } catch { /* state is optional here */ } };
  const file = memoryPath(out, hk);

  if (args.add && args.add !== true) {
    const kind = KINDS[String(args.add).toLowerCase()];
    const text = textArg(args, en);
    if (!kind || !text) { console.error(en ? '--add <kind> --text "…" (kinds: decision, do_not_suggest, fact, known, do_not_touch)' : '--add <вид> --text "…" (виды: decision, do_not_suggest, fact, known, do_not_touch)'); process.exit(2); }
    const added = await updateMemory(out, hk, host, m => {
      if (kind === 'verified_facts') { const mm = text.match(/^([^=:]+)[=:](.+)$/); const k = mm ? mm[1].trim() : `fact_${Object.keys(m.verified_facts).length + 1}`; m.verified_facts[k] = (mm ? mm[2] : text).trim(); return true; }
      return pushUnique(m[kind], { text, date: today(), source: args.source && args.source !== true ? String(args.source) : 'user', ...(args.uid && args.uid !== true ? { uid: String(args.uid) } : {}) });
    });
    say([added ? (en ? `Saved to ${kind}: ${text.slice(0, 120)}` : `Записал в ${kind}: ${text.slice(0, 120)}`) : (en ? 'Already remembered.' : 'Такое уже помним — не дублирую.'), `→ ${file.replace(/\\/g, '/')}`]);
    return;
  }
  if (args.remove && args.remove !== true) {
    const kind = KINDS[String(args.remove).toLowerCase()];
    const text = textArg(args, en);
    if (!kind || !text) { console.error('--remove <вид> --text "…"'); process.exit(2); }
    const n = await updateMemory(out, hk, host, m => {
      if (kind === 'verified_facts') { const had = text in m.verified_facts; delete m.verified_facts[text]; return had ? 1 : 0; }
      const before = m[kind].length; m[kind] = m[kind].filter(x => U.normText(textOf(x)) !== U.normText(text) && x.uid !== text); return before - m[kind].length;
    });
    say([en ? `Removed: ${n}` : `Удалено записей: ${n}`]);
    return;
  }
  if (args['from-registry'] && args['from-registry'] !== true) {
    const x = resolve(String(args['from-registry']));
    if (!existsSync(x)) { console.error(en ? `File not found: ${x}` : `Файл не найден: ${x}`); process.exit(2); }
    let r;
    try { r = registryWontFix(x); } catch (e) { console.error(en ? `Cannot read the registry: ${e.message}` : `Реестр не читается: ${e.message}`); await markState('memory', 'failed'); process.exit(1); }
    if (r.error) { say([r.error]); await markState('memory', 'failed'); process.exitCode = 1; return; }
    const added = await updateMemory(out, hk, host, m => r.items.filter(it => pushUnique(m.do_not_suggest, it)).length);
    await markState('memory', 'ok');
    say([en ? `Registry «${r.sheet}»: rows ${r.total}, «won't fix» ${r.items.length}, new in do_not_suggest ${added}.` : `Реестр, лист «${r.sheet}»: строк ${r.total}, «не будем исправлять» ${r.items.length}, новых в do_not_suggest ${added}.`,
      ...r.items.slice(0, 10).map(it => `  - ${it.rid ? it.rid + ' ' : ''}${it.text.slice(0, 110)}`), `→ ${file.replace(/\\/g, '/')}`]);
    return;
  }
  if (args.decisions !== undefined || args['decisions-file']) {
    let text = args.decisions && args.decisions !== true ? String(args.decisions) : '';
    if (args['decisions-file'] && args['decisions-file'] !== true) { try { text += '\n' + (await import('node:fs')).readFileSync(resolve(String(args['decisions-file'])), 'utf8'); } catch (e) { console.error(e.message); process.exit(2); } }
    const d = parseDecisions(text);
    if (!d.take.length && !d.no.length && !d.discuss.length) { console.error(en ? 'No marks found. Expected lines like «беру: …», «нет: …», «обсудить: …».' : 'Не нашёл отметок. Ожидаю строки «беру: …», «нет: …», «обсудить: …».'); process.exit(2); }
    const res = await updateMemory(out, hk, host, m => ({
      take: d.take.filter(t => pushUnique(m.owner_decisions, { text: `Берём идею конкурентов: ${t}`, date: today(), source: 'rivals' })).length,
      no: d.no.filter(t => pushUnique(m.do_not_suggest, { text: `Не предлагать (идея конкурентов): ${t}`, date: today(), source: 'rivals' })).length,
    }));
    say([en ? `Take: ${d.take.length} (new ${res.take}) · no: ${d.no.length} (new ${res.no}) · discuss: ${d.discuss.length} (not saved)` : `Берём: ${d.take.length} (новых ${res.take}) · не берём: ${d.no.length} (новых ${res.no}) · обсудить: ${d.discuss.length} (не сохраняю)`, `→ ${file.replace(/\\/g, '/')}`]);
    return;
  }
  if (args['save-brief'] !== undefined) {
    const p = args['save-brief'] !== true ? resolve(String(args['save-brief'])) : (run ? join(run, 'brief.json') : null);
    const b = p ? U.readJSON(p, null) : null;
    if (!b) { console.error(en ? 'No brief.json to save.' : 'Нет brief.json — нечего сохранять.'); await markState('brief_saved', 'failed'); process.exit(2); }
    await updateMemory(out, hk, host, m => { m.brief_last = shortBrief(b); });
    await markState('brief_saved', 'ok');
    say([en ? 'Saved the short brief to site memory (brief_last).' : 'Краткий бриф сохранён в память сайта (brief_last).', `→ ${file.replace(/\\/g, '/')}`]);
    return;
  }
  // --get (default)
  const m = readMemory(out, hk);
  if (args.json) { process.stdout.write(JSON.stringify(m || emptyMemory(host), null, 2) + '\n'); return; }
  if (!m) { say([en ? `No memory for ${hk} yet (${file.replace(/\\/g, '/')}).` : `Для ${hk} памяти пока нет (${file.replace(/\\/g, '/')}).`]); return; }
  const lines = [en ? `Site memory ${hk} (updated ${m.updated}):` : `Память сайта ${hk} (обновлена ${m.updated}):`];
  const show = (title, arr) => { if (!arr?.length) return; lines.push(`${title}: ${arr.length}`); for (const it of arr.slice(0, 6)) lines.push(`  - ${textOf(it).slice(0, 110)}`); };
  show(en ? 'Owner decisions' : 'Решения владельца', m.owner_decisions);
  show(en ? 'Do not suggest' : 'Не предлагать', m.do_not_suggest);
  show(en ? 'Do not touch' : 'Не трогать', m.do_not_touch);
  show(en ? 'Known issues' : 'Известные проблемы', m.known_issues);
  const facts = Object.entries(m.verified_facts || {});
  if (facts.length) { lines.push(`${en ? 'Verified facts' : 'Проверенные факты'}: ${facts.length}`); for (const [k, v] of facts.slice(0, 6)) lines.push(`  - ${k}: ${String(v).slice(0, 100)}`); }
  if (m.brief_last) lines.push(`${en ? 'Last brief' : 'Прошлый бриф'}: ${m.brief_last.date} · ${m.brief_last.site?.main_action || '—'} · ${m.brief_last.vertical || '—'}`);
  say(lines);
}

const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
