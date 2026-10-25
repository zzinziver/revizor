#!/usr/bin/env node
// Revizor — merge.mjs: findings/* + verify/* + critic/* → report/candidates.json, report/digest.md, report/handoffs.json.
// Never fails on a broken file: it goes to rejected_files.
// Severity: final = skeptic.severity_after ?? lens.severity; the critic only raises and only verified findings;
// lowering is the skeptic's job; events are applied by round (verdicts of round N, then the critic of round N);
// a critic raise that came before the first confirming verdict is applied when that verdict comes (unless the skeptic
// set severity_after then); every change is written to severity_trail. P0–P1 without a skeptic verdict → verdict
// "unverified" + requires_check.

import { existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as U from './lib/util.mjs';
import * as V from './validate.mjs';
import { lensFiles, lintLens, lintFinding, lintFileState, PageTexts, loadStopWords, normQ, setLang as setLintLang,
  BLOCKING_CODES, REPAIRABLE_CODES } from './lint-findings.mjs';

let LANG = 'ru';
const M = (ru, en) => (LANG === 'en' ? en : ru);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const arr = v => (Array.isArray(v) ? v : []);
const clone = v => JSON.parse(JSON.stringify(v));
const lensOrder = l => { const i = V.KNOWN_LENSES.indexOf(l); return i < 0 ? 99 : i; };
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const CONFIRMED = new Set(['confirmed', 'adjusted']);
const MAX_CLUSTER = 10;

// ---------- clusters of duplicates ----------
const GENERIC_SEL = new Set(['html', 'body', 'main', 'header', 'footer', 'nav', '*', ':root', 'div', 'a', 'p', 'span', 'img', 'button',
  'section', 'ul', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'form', 'input', 'svg', 'article', 'label', 'select', 'textarea', 'table', 'td', 'tr']);
// classes of site builders and frameworks: the same on every block, so they say nothing about the element
const BUILDER_RE = /^[.#](?:t\d|t-|tn-|tn_|rec\d|js-|wp-|wp_|elementor|et_pb|et-|uk-|b24-|bx-|ui-|css-|sc-|jsx-|svelte-|ng-|v-|chakra-|mui|ant-|tw-|w-|framer-|wixui|comp-|_)/i;
// filler and place words that every other title has: they must not make two titles "similar"
const STOP_STEMS = new Set(['котор', 'можно', 'нужно', 'тольк', 'более', 'менее', 'очень', 'также', 'после', 'перед', 'через', 'когда',
  'чтобы', 'вмест', 'этого', 'этот', 'этой', 'есть', 'with', 'from', 'that', 'this', 'have', 'does', 'into', 'than', 'нет',
  'стран', 'главн', 'перво', 'экран', 'сайт', 'сайта', 'сайте', 'всех', 'везде', 'page', 'pages', 'home', 'site', 'scree', 'width']);
const VIEWPORT_NUMS = new Set(['280', '320', '360', '375', '390', '414', '430', '440', '600', '744', '768', '834', '1024', '1280', '1366', '1440', '1536', '1920']);
/** Words of a title outside site quotes (the element's label is not the problem) + its numbers (except widths). */
function titleKey(title) {
  const t = String(title || '');
  const unq = t.replace(/«[^«»]*»|“[^“”]*”|"[^"]*"|`[^`]*`/g, ' ');
  const stems = U.words(unq).filter(w => w.length >= 4 && !/\d/.test(w)).map(w => w.slice(0, 5)).filter(s => !STOP_STEMS.has(s));
  const nums = (t.match(/\d+(?:[.,]\d+)?/g) || []).filter(n => n.length >= 2 && !VIEWPORT_NUMS.has(n)).map(n => '#' + n.replace(',', '.'));
  return new Set([...stems, ...nums]);
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return n < 2 ? 0 : n / (a.size + b.size - n); // one shared word is not similarity
}
/** Similarity of two titles, 0…1 (the same measure the clusters use). */
export const titleSimilarity = (a, b) => jaccard(titleKey(a), titleKey(b));
const normSel = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
/** A selector that points at a particular element (not a bare tag, not a builder class) → normalised, else null. */
export function selSignal(sel) {
  const s = normSel(sel);
  if (!s || GENERIC_SEL.has(s)) return null;
  const parts = s.split(/\s*[>+~]\s*|\s+/).filter(Boolean);
  const last = parts[parts.length - 1] || '';
  const marks = last.split(/(?=[.#[:])/).filter(x => /^[.#]/.test(x));
  if (!marks.length) return null;
  if (marks.every(c => BUILDER_RE.test(c))) return null;
  return s;
}
const normUrl = u => { try { const x = new URL(u); return (x.host + x.pathname).replace(/\/+$/, '').toLowerCase(); } catch { return ''; } };
/**
 * Page key of a place: its pid, or the pid of its url in pages.json (url / final_url), or the normalised url.
 * A place written as { pid: 'home' } and one written as { url: 'https://site/' } then land on the same page.
 */
export function pageKeyer(run) {
  const map = new Map();
  const pj = run ? U.readJSON(join(run, 'pages.json'), null) : null;
  for (const s of arr(pj?.selected)) if (s?.pid) for (const u of [s.url, s.final_url]) { const k = normUrl(u); if (k && !map.has(k)) map.set(k, String(s.pid)); }
  return w => {
    if (!isObj(w)) return '';
    if (typeof w.pid === 'string' && w.pid) return w.pid;
    const k = typeof w.url === 'string' ? normUrl(w.url) : '';
    return k ? (map.get(k) || k) : '';
  };
}
export function iou(a, b) {
  const x0 = Math.max(a[0], b[0]), y0 = Math.max(a[1], b[1]);
  const x1 = Math.min(a[0] + a[2], b[0] + b[2]), y1 = Math.min(a[1] + a[3], b[1] + b[3]);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const uni = a[2] * a[3] + b[2] * b[3] - inter;
  return uni > 0 ? inter / uni : 0;
}
function components(idx, edges) {
  const parent = new Map(idx.map(i => [i, i]));
  const find = i => { let r = i; while (parent.get(r) !== r) r = parent.get(r); let c = i; while (parent.get(c) !== r) { const n = parent.get(c); parent.set(c, r); c = n; } return r; };
  for (const e of edges) if (parent.has(e.i) && parent.has(e.j)) parent.set(find(e.i), find(e.j));
  const out = new Map();
  for (const i of idx) { const r = find(i); (out.get(r) || out.set(r, []).get(r)).push(i); }
  return [...out.values()];
}
/**
 * Clusters of probable duplicates. An edge needs overlapping boxes or similar titles (≥ 0.6); a shared rare selector,
 * the same category and the same page only add to a weaker title similarity (≥ 0.3). Selectors used by more than
 * 5 findings and builder classes are no signal. Clusters larger than 10 are split by category, then by page.
 * pageOf(place) → page key (pageKeyer): a pid and the url of the same page count as one page.
 */
export function clusterize(items, pageOf = pageKeyer(null)) {
  const info = items.map(it => {
    const where = arr(it.where).filter(isObj);
    return {
      sels: new Set(where.map(w => selSignal(w.selector)).filter(Boolean)),
      pids: new Set(where.map(pageOf).filter(Boolean)),
      cat: U.normText(it.category || ''),
      key: titleKey(it.title),
      boxes: where.filter(w => V.validBox(w.box) && (w.box_space || 'css') === 'css').map(w => ({ pid: pageOf(w), vp: String(w.viewport ?? ''), box: w.box })),
    };
  });
  const selCount = new Map();
  for (const x of info) for (const s of x.sels) selCount.set(s, (selCount.get(s) || 0) + 1);
  const edges = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = info[i], b = info[j];
    const samePage = [...a.pids].some(p => b.pids.has(p));
    const sameCat = !!a.cat && a.cat === b.cat;
    const sel = [...a.sels].find(s => b.sels.has(s) && selCount.get(s) <= 5);
    const box = a.boxes.some(x => b.boxes.some(y => x.pid && x.pid === y.pid && x.vp === y.vp && iou(x.box, y.box) >= 0.5));
    const sim = jaccard(a.key, b.key);
    const score = sim + (sel && samePage ? 0.2 : 0) + (sameCat ? 0.1 : 0) + (samePage ? 0.05 : 0);
    const strong = box || sim >= 0.6;
    if (!strong && !(sim >= 0.3 && score >= 0.6)) continue;
    const why = [];
    if (box) why.push(M('рамки совпадают', 'boxes overlap'));
    if (sim > 0) why.push(M(`похожие заголовки (${sim.toFixed(2)})`, `similar titles (${sim.toFixed(2)})`));
    if (sel && samePage) why.push(M(`один селектор «${short(sel, 40)}»`, `same selector "${short(sel, 40)}"`));
    if (sameCat) why.push(M('одна категория', 'same category'));
    edges.push({ i, j, why, sameCat, samePage, strong });
  }
  const all = items.map((_, i) => i);
  const groups = [];
  const sevSort = g => g.sort((x, y) => V.sevRank(items[x].severity) - V.sevRank(items[y].severity) || x - y);
  for (const g of components(all, edges)) {
    if (g.length <= MAX_CLUSTER) { groups.push(g); continue; }
    for (const s of components(g, edges.filter(e => e.sameCat))) {
      if (s.length <= MAX_CLUSTER) { groups.push(s); continue; }
      for (const t of components(s, edges.filter(e => e.sameCat && e.samePage))) {
        if (t.length <= MAX_CLUSTER) { groups.push(t); continue; }
        sevSort(t);
        for (let k = 0; k < t.length; k += MAX_CLUSTER) groups.push(t.slice(k, k + MAX_CLUSTER));
      }
    }
  }
  const clusters = [];
  for (const idx of groups) {
    if (idx.length < 2) continue;
    const set = new Set(idx);
    const ids = idx.map(i => items[i].id);
    const reasons = [...new Set(edges.filter(e => set.has(e.i) && set.has(e.j)).flatMap(e => e.why.map(w => w.replace(/ \(\d\.\d\d\)$/, ''))))];
    const pids = new Set(idx.flatMap(i => [...info[i].pids]));
    const sitewide = pids.size >= 3 || idx.some(i => items[i].sitewide === true);
    clusters.push({ ids, reason: reasons.join('; '), kind: sitewide ? 'sitewide' : 'duplicate', lenses: [...new Set(idx.map(i => items[i].lens))],
      pids: [...pids], max_severity: V.maxSeverity(idx.map(i => items[i].severity)) });
  }
  clusters.sort((a, b) => V.sevRank(a.max_severity) - V.sevRank(b.max_severity) || b.ids.length - a.ids.length);
  clusters.forEach((c, k) => { c.key = `c${String(k + 1).padStart(2, '0')}`; });
  return clusters.map(({ key, ...c }) => ({ key, ...c }));
}

// ---------- the merge ----------
function listJson(dir, filter) {
  try { return readdirSync(dir).filter(f => f.endsWith('.json') && filter(f)).sort(); } catch { return []; }
}
const lensOfVerifierId = id => (String(id).match(/^(.+)-v\d{2,3}$/) || [])[1] || null;
const errText = errs => short(arr(errs).map(e => `${e.path ? e.path + ': ' : ''}${e.msg}`).join('; '), 500);

/** A lens finding as merge keeps it: service fields dropped, a low confidence without flags gets needs_decision. */
function adopt(fd, extra) {
  const it = clone(fd);
  const stripped = V.SERVICE_FIELDS.filter(k => it[k] !== undefined);
  for (const k of stripped) delete it[k];
  Object.assign(it, extra);
  if (stripped.length) it.stripped = stripped;
  if (it.confidence === 'low' && !it.needs_device_check && !it.needs_decision) {
    it.needs_decision = true;
    (it.fixups ||= []).push(M('confidence: low без флагов → needs_decision: true', 'confidence: low without flags → needs_decision: true'));
  }
  return it;
}

/**
 * buildCandidates(run, { audience, deadline, saveLint }) → { candidates, handoffs, digest } or { partial: true, lint_done, lint_total }
 * (nothing is written except verify/<lens>.lint.json when saveLint is true).
 */
/** ids rechecked on request after the critic (state verify:ids done): from <RUN>/recheck-ids.json, written by state.mjs
 * when it asks for that recheck or by merge.mjs --ids-recheck (manual path). */
export function recheckIdsDone(run) {
  const st = U.readJSON(join(run, 'state.json'), null) || {};
  const req = U.readJSON(join(run, 'recheck-ids.json'), null);
  const ids = Array.isArray(req?.ids) ? req.ids.filter(x => typeof x === 'string') : [];
  const v = st.done?.['verify:ids'];
  return new Set(req?.manual || v === 'ok' || v === 'skipped' ? ids : []);
}

export function buildCandidates(run, opts = {}) {
  const groups = lensFiles(run);
  const items = [], byId = new Map(), rejected = [], rejected_files = [];
  const lensInfo = {};
  const L = l => (lensInfo[l] ||= { files: [], strengths: [], for_other_lenses: [], open_questions: [], not_checked: [], clean_checks: [], coverage: null, design_read: null, skills_used: [] });
  const rejectItem = (f, lens, by, why, extra = {}) => rejected.push({ id: typeof f?.id === 'string' ? f.id : null, lens, title: f?.title ?? null, severity: f?.severity ?? null, by, why: short(why, 400), ...extra });

  // 1. lens files
  for (const [lens, files] of Object.entries(groups)) {
    for (const f of files) {
      try {
        if (f.badName) { rejected_files.push({ file: f.rel, reason: M('имя файла не по схеме <линза>.json / .partN.json / .r2.json', 'file name is not <lens>.json / .partN.json / .r2.json') }); continue; }
        if (!V.KNOWN_LENSES.includes(lens)) { rejected_files.push({ file: f.rel, reason: M(`неизвестная линза «${lens}» (имя файла — <линза>.json)`, `unknown lens "${lens}" (file name must be <lens>.json)`) }); continue; }
        const v = V.validateFile(f.abs, { type: 'findings', run });
        if (!v.data || v.fatalDoc) { rejected_files.push({ file: f.rel, reason: errText(v.errors) }); continue; }
        const doc = v.data, li = L(lens);
        li.files.push(f.rel);
        for (const k of ['strengths', 'for_other_lenses', 'open_questions', 'not_checked', 'clean_checks', 'skills_used']) li[k].push(...arr(doc[k]));
        if (isObj(doc.coverage)) (li.cov ||= []).push({ round: f.round, c: doc.coverage });
        if (typeof doc.design_read === 'string' && !li.design_read) li.design_read = doc.design_read;
        const idKind = f.round === 2 ? 'r2' : 'lens';
        arr(doc.findings).forEach((fd, i) => {
          if (!isObj(fd)) { rejectItem(null, lens, 'schema', M(`findings[${i}] не объект`, `findings[${i}] is not an object`), { file: f.rel }); return; }
          const sch = arr(v.items).find(x => x.index === i) || { errors: [], fatal: false };
          if (sch.fatal) { rejectItem(fd, lens, 'schema', sch.errors.filter(e => e.code === 'schema_fatal').map(e => e.msg).join('; '), { file: f.rel }); return; }
          if (!V.idOfLens(fd.id, lens, idKind)) { rejectItem(fd, lens, 'schema', M(`id «${fd.id}» не линзы ${lens} (нужно ${lens}-${idKind === 'r2' ? 'r2-' : ''}NN) — чужой id не принимается`, `id "${fd.id}" is not of lens ${lens} (${lens}-${idKind === 'r2' ? 'r2-' : ''}NN expected) — foreign ids are refused`), { file: f.rel }); return; }
          if (byId.has(fd.id)) { rejectItem(fd, lens, 'merge', M(`повтор id: уже есть в ${byId.get(fd.id).files[0]}`, `duplicate id: already in ${byId.get(fd.id).files[0]}`), { file: f.rel }); return; }
          const it = adopt(fd, { lens, round: f.round, source: 'lens', files: [f.rel] });
          if (sch.errors.length) it.schema_issues = sch.errors.map(e => `${e.path.replace(/^findings\[\d+\]( \([^)]*\))?\.?/, '')}: ${e.msg}`);
          byId.set(it.id, it); items.push(it);
        });
      } catch (e) { rejected_files.push({ file: f.rel, reason: M(`файл не обработан: ${e.message}`, `file not processed: ${e.message}`) }); }
    }
  }

  // 2. skeptic files: verdicts (resolved per round below) and the skeptic's own findings (linted, not confirmed by default)
  const vdir = join(run, 'verify');
  const vnames = listJson(vdir, f => !f.endsWith('.lint.json') && f !== 'recheck.json')
    .map(n => ({ n, pn: V.parseLensFileName(n) })).sort((a, b) => (a.pn?.round || 1) - (b.pn?.round || 1) || a.n.localeCompare(b.n));
  const vlist = new Map(); // id → [{ verdict…, file, round, flens }]
  const verdict_issues = [], wrong_strengths = [], wrong_clean_checks = [], verify_files = [], added = [];
  for (const { n, pn } of vnames) {
    const rel = `verify/${n}`;
    try {
      const v = V.validateFile(join(vdir, n), { type: 'verify', run });
      if (!v.data || v.fatalDoc) { rejected_files.push({ file: rel, reason: errText(v.errors) }); continue; }
      verify_files.push(rel);
      const doc = v.data, vlens = pn?.lens || (typeof doc.lens === 'string' ? doc.lens : null), round = pn?.round || 1;
      for (const x of arr(doc.verdicts)) {
        if (!isObj(x) || typeof x.id !== 'string') continue;
        const verdict = x.verdict === 'refuted' ? 'rejected' : x.verdict;
        if (!V.VERDICTS.includes(verdict)) { verdict_issues.push({ file: rel, id: x.id, why: M(`вердикт «${x.verdict}» не из списка — пропущен`, `verdict "${x.verdict}" is not allowed — skipped`) }); continue; }
        (vlist.get(x.id) || vlist.set(x.id, []).get(x.id)).push({ verdict, severity_after: V.SEVERITIES.includes(x.severity_after) ? x.severity_after : null,
          fix_ok: typeof x.fix_ok === 'boolean' ? x.fix_ok : null, text_ok: typeof x.text_ok === 'boolean' ? x.text_ok : null,
          how: typeof x.how === 'string' ? x.how : null, note: typeof x.note === 'string' ? x.note : null, file: rel, round, flens: vlens });
      }
      for (const s of arr(doc.wrong_strengths)) if (isObj(s)) wrong_strengths.push({ lens: vlens, ...s });
      for (const c of arr(doc.wrong_clean_checks)) if (isObj(c)) wrong_clean_checks.push({ lens: vlens, ...c });
      arr(doc.added_by_verifier).forEach((fd, i) => {
        const lens = lensOfVerifierId(fd?.id) || vlens || 'unknown';
        const chk = V.checkFinding(fd, `added_by_verifier[${i}]`, { lens, idKind: 'verifier' });
        if (!isObj(fd) || chk.fatal) { rejectItem(isObj(fd) ? fd : null, lens, 'schema', chk.errors.filter(e => e.code === 'schema_fatal').map(e => e.msg).join('; ') || M('не объект', 'not an object'), { file: rel }); return; }
        if (!V.KNOWN_LENSES.includes(lens) || !V.idOfLens(fd.id, lens, 'verifier')) { rejectItem(fd, lens, 'schema', M(`id «${fd.id}» — нужно <линза>-vNN известной линзы`, `id "${fd.id}" — <lens>-vNN of a known lens expected`), { file: rel }); return; }
        if (byId.has(fd.id)) { rejectItem(fd, lens, 'merge', M(`повтор id: уже есть в ${byId.get(fd.id).files[0]}`, `duplicate id: already in ${byId.get(fd.id).files[0]}`), { file: rel }); return; }
        const it = adopt(fd, { lens, round, source: 'verifier', files: [rel] });
        if (chk.errors.length) it.schema_issues = chk.errors.map(e => `${e.path.replace(/^added_by_verifier\[\d+\]( \([^)]*\))?\.?/, '')}: ${e.msg}`);
        it._schema = chk;
        byId.set(it.id, it); items.push(it); added.push(it);
      });
    } catch (e) { rejected_files.push({ file: rel, reason: M(`файл не обработан: ${e.message}`, `file not processed: ${e.message}`) }); }
  }

  // 3. lint: fresh verify/<lens>.lint.json, else computed now (with the deadline; saved for the next call)
  const lintMap = new Map(); const lint_source = {};
  const texts = new PageTexts(run, { writeCache: !!opts.saveLint }), stop = loadStopWords(opts.audience || 'owner');
  const lensesToLint = Object.entries(groups).filter(([lens, files]) => V.KNOWN_LENSES.includes(lens) && files.some(f => !f.badName));
  let lintDone = 0, progressed = false;
  for (const [lens, allFiles] of lensesToLint) {
    const files = allFiles.filter(f => !f.badName);
    const lp = join(run, 'verify', `${lens}.lint.json`);
    let res = null, prevMap = null;
    if (existsSync(lp)) {
      let mt = 0; try { mt = statSync(lp).mtimeMs; } catch {}
      const prev = U.readJSON(lp, null);
      const st = lintFileState(prev, files, mt);
      if (st === 'fresh') { res = prev; lint_source[lens] = 'file'; }
      else if (st === 'partial') prevMap = new Map(prev.items.map(x => [`${x.file}#${x.id}`, x]));
    }
    if (!res) {
      if (opts.deadline && progressed && Date.now() > opts.deadline) return { partial: true, lint_done: lintDone, lint_total: lensesToLint.length, lens };
      progressed = true;
      try {
        res = lintLens(run, lens, { texts, stop, files, deadline: opts.deadline || 0, prev: prevMap });
        res.audience = opts.audience || 'owner';
        if (opts.saveLint) { try { U.writeJSON(U.insideRun(run, 'verify', `${lens}.lint.json`), res); } catch { /* lint is recomputed next time */ } }
        if (res.partial) return { partial: true, lint_done: lintDone, lint_total: lensesToLint.length, lens };
        lint_source[lens] = 'computed';
      } catch (e) { lint_source[lens] = `error: ${e.message}`; continue; }
    }
    lintDone++;
    for (const x of arr(res.items)) if (x && typeof x.id === 'string') lintMap.set(`${x.file}#${x.id}`, x);
  }
  for (const it of added) { // the skeptic's own findings pass the same checks
    const li = lintFinding(run, it, { texts, stop, lens: it.lens, file: it.files[0], schema: it._schema });
    delete it._schema;
    lintMap.set(`${it.files[0]}#${it.id}`, li);
  }
  texts.flush();

  // 4. verdict of each round for each id; disagreeing verdicts of one round are a conflict
  const verdict_conflicts = [];
  const roundVerdicts = new Map(); // id → Map(round → verdict)
  for (const [id, list] of vlist) {
    const byRound = new Map();
    for (const x of list) (byRound.get(x.round) || byRound.set(x.round, []).get(x.round)).push(x);
    const out = new Map();
    for (const [round, xs] of byRound) {
      if (xs.length === 1) { out.set(round, xs[0]); continue; }
      const same = xs.every(x => x.verdict === xs[0].verdict && x.severity_after === xs[0].severity_after);
      const itLens = byId.get(id)?.lens;
      const ownList = xs.filter(x => x.flens && x.flens === itLens);
      if (same) { out.set(round, ownList[0] || xs[xs.length - 1]); continue; }
      const kinds = new Set(xs.map(x => x.verdict === 'rejected' ? 'rejected' : 'kept'));
      const c = { id, round, verdicts: xs.map(x => ({ file: x.file, verdict: x.verdict, severity_after: x.severity_after })) };
      if (kinds.size > 1) { c.resolution = M('отклонено и подтверждено одновременно → без вердикта, требует проверки', 'rejected and confirmed at once → no verdict, needs checking'); out.set(round, { verdict: 'unverified', conflict: true, severity_after: null, file: xs.map(x => x.file).join(' + '), round, how: null, note: null }); }
      else {
        const pick = ownList.length === 1 ? ownList[0] : [...xs].sort((a, b) => V.sevRank(a.severity_after) - V.sevRank(b.severity_after))[0];
        c.resolution = M(`взят ${pick.file}`, `took ${pick.file}`);
        out.set(round, pick);
      }
      verdict_conflicts.push(c);
    }
    roundVerdicts.set(id, out);
  }

  // 5. critic files (parsed now, applied by round together with the verdicts)
  const ignored_severity_fixes = [], contradictions = [], critic_files = [], criticFixes = new Map(); // id → [{ sf, round, rel }]
  const weak = [];
  const cnames = listJson(join(run, 'critic'), f => /^round-\d+\.json$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  for (const n of cnames) {
    const rel = `critic/${n}`;
    try {
      const v = V.validateFile(join(run, 'critic', n), { type: 'critic', run });
      if (!v.data || v.fatalDoc) { rejected_files.push({ file: rel, reason: errText(v.errors) }); continue; }
      const doc = v.data, round = Number.isFinite(Number(doc.round)) && Number(doc.round) > 0 ? Number(doc.round) : Number(n.match(/\d+/)[0]);
      if (!Array.isArray(doc.severity_fixes) && doc.severity_fixes !== undefined) verdict_issues.push({ file: rel, id: null, why: M('severity_fixes не массив — пропущено', 'severity_fixes is not an array — skipped') });
      critic_files.push(rel);
      for (const sf of arr(doc.severity_fixes)) {
        if (!isObj(sf) || typeof sf.id !== 'string') continue;
        if (!V.SEVERITIES.includes(sf.to)) { ignored_severity_fixes.push({ ...sf, round, why_ignored: M('to не P0–P3', 'to is not P0–P3') }); continue; }
        (criticFixes.get(sf.id) || criticFixes.set(sf.id, []).get(sf.id)).push({ sf, round, rel });
      }
      for (const w of arr(doc.weak_wording)) if (isObj(w) && typeof w.id === 'string') weak.push(w);
      for (const c of arr(doc.contradictions)) if (isObj(c)) contradictions.push({ round, ...c });
    } catch (e) { rejected_files.push({ file: rel, reason: M(`файл не обработан: ${e.message}`, `file not processed: ${e.message}`) }); }
  }

  // 6. per finding: events by round (verdict of round N, then the critic of round N), lint gate, repairs
  const kept = [], keptById = new Map(), usedVerdicts = new Set(), lateApplied = new Set();
  // the recheck by ids (editor or critic asked after the critic round) replaces verdicts inside verify/<lens>.json with the
  // same round number; those verdicts are newer than every critic fix and go after them, so a lowering by the skeptic stands
  const idsRecheck = recheckIdsDone(run);
  const preRejected = new Set(rejected.map(r => r.id).filter(Boolean));
  for (const it of items) {
    const rv = roundVerdicts.get(it.id) || new Map();
    if (rv.size) usedVerdicts.add(it.id);
    const lensSev = it.severity;
    const trail = [{ by: it.source === 'verifier' ? 'skeptic' : 'lens', from: null, to: lensSev, round: it.round,
      why: it.source === 'verifier' ? M('добавлено скептиком', 'added by the skeptic') : M('оценка линзы', 'lens rating') }];
    let sev = lensSev, vd = null, conflict = false, criticWants = null, lateWants = null;
    let pending = null; // critic raises of this finding that wait for a confirming verdict: { wants, entries }
    if (it.taste === true && V.sevRank(sev) < 3) { trail.push({ by: 'merge', from: sev, to: 'P3', round: it.round, why: M('вкусовое (taste) — не выше P3', 'taste — P3 at most') }); sev = 'P3'; }
    const lastRound = Math.max(0, ...[...rv.keys()]);
    const events = [...[...rv].map(([round, x]) => ({ round, phase: idsRecheck.has(it.id) && round === lastRound ? 2 : 0, x })), ...arr(criticFixes.get(it.id)).map(c => ({ round: c.round, phase: 1, c }))]
      .sort((a, b) => (a.phase === 2) - (b.phase === 2) || a.round - b.round || a.phase - b.phase);
    for (const ev of events) {
      if (ev.phase !== 1) {
        vd = ev.x; conflict = !!ev.x.conflict;
        if (vd.severity_after && vd.severity_after !== sev && vd.verdict !== 'rejected') {
          let to = vd.severity_after;
          if (it.taste === true && V.sevRank(to) < 3) to = 'P3';
          const pre = ev.phase === 2 ? M('перепроверка по просьбе (после критика): ', 'recheck on request (after the critic): ') : '';
          if (to !== sev) { trail.push({ by: 'skeptic', from: sev, to, round: ev.round, why: short(pre + (vd.note || vd.how || ''), 300), ref: `${vd.file}#${it.id}` }); sev = to; }
        }
        if (pending && vd.verdict === 'rejected') {
          for (const e of pending.entries) e.why_ignored = M(`находка отклонена скептиком (круг ${ev.round})`, `the finding was rejected by the skeptic (round ${ev.round})`);
          pending = null;
        } else if (pending && CONFIRMED.has(vd.verdict) && !conflict) {
          const w = pending.wants;
          if (vd.severity_after) {
            // the skeptic rated the finding after the critic's wish: the skeptic's severity stands, the wish stays visible (↑?)
            for (const e of pending.entries) e.why_ignored = M(`скептик подтвердил находку в круге ${ev.round} уже после поправки критика и сам задал ${vd.severity_after}`, `the skeptic confirmed it in round ${ev.round}, after the critic fix, and set ${vd.severity_after}`);
            if (V.sevRank(w.to) < V.sevRank(sev)) lateWants = { ...w, late: true, note: M('вердикт после поправки критика', 'the verdict came after the critic fix') };
          } else if (V.sevRank(w.to) < V.sevRank(sev)) {
            trail.push({ by: 'critic', from: sev, to: w.to, round: ev.round, why: short(`${w.why} (${M(`применено после вердикта круга ${ev.round}`, `applied after the round ${ev.round} verdict`)})`, 300), ref: w.ref });
            sev = w.to; it.critic_raised = true;
            for (const e of pending.entries) lateApplied.add(e);
          } else for (const e of pending.entries) e.why_ignored = M(`к вердикту круга ${ev.round} важность уже ${sev}`, `by the round ${ev.round} verdict the severity is already ${sev}`);
          pending = null; criticWants = null;
        }
        continue;
      }
      const { sf, round, rel } = ev.c;
      const verified = vd && CONFIRMED.has(vd.verdict);
      if (vd?.verdict === 'rejected') { ignored_severity_fixes.push({ ...sf, round, why_ignored: M('находка отклонена скептиком', 'the finding was rejected by the skeptic') }); continue; }
      if (V.sevRank(sf.to) > V.sevRank(sev)) { ignored_severity_fixes.push({ ...sf, round, why_ignored: M('критик не понижает важность — это делает скептик', 'the critic does not lower severity — that is the skeptic\'s job') }); continue; }
      if (sf.to === sev) continue;
      if (it.taste === true && V.sevRank(sf.to) < 3) { ignored_severity_fixes.push({ ...sf, round, why_ignored: M('вкусовое (taste) — не выше P3', 'taste — P3 at most') }); continue; }
      if (!verified) {
        const entry = { ...sf, round, why_ignored: M('нет вердикта скептика: критик повышает только проверенные', 'no skeptic verdict: the critic raises verified findings only') };
        ignored_severity_fixes.push(entry);
        if (!criticWants || V.sevRank(sf.to) < V.sevRank(criticWants.to)) criticWants = { to: sf.to, why: short(sf.why || '', 200), round, ref: `${rel}#${sf.id}` };
        (pending ||= { wants: null, entries: [] }).entries.push(entry);
        pending.wants = criticWants;
        continue;
      }
      trail.push({ by: 'critic', from: sev, to: sf.to, round, why: short(sf.why || '', 300), ref: `${rel}#${sf.id}` });
      sev = sf.to; it.critic_raised = true;
    }
    const li = lintMap.get(`${it.files[0]}#${it.id}`);
    if (li) it.lint = { errors: arr(li.errors).map(e => ({ code: e.code, field: e.field, msg: e.msg })), warnings: arr(li.warnings).length, quotes: arr(li.quotes) };
    const verdict = vd ? vd.verdict : 'unverified';
    if (verdict === 'rejected') { rejectItem(it, it.lens, 'skeptic', vd.note || vd.how || '', { how: vd.how, verify_file: vd.file, file: it.files[0] }); continue; }
    const blocking = arr(li?.errors).filter(e => BLOCKING_CODES.includes(e.code));
    if (blocking.length && (it.source === 'verifier' || !CONFIRMED.has(verdict))) {
      rejectItem(it, it.lens, 'lint', blocking.map(e => e.msg).join('; '), { file: it.files[0] }); continue;
    }
    // repairs: broken frame/box/place references are dropped, the finding stays
    const repairs = [], dropPlaces = new Set();
    const where = Array.isArray(it.where) ? it.where : [];
    for (const e of arr(li?.errors).filter(e => REPAIRABLE_CODES.includes(e.code))) {
      const m = String(e.field).match(/^where\[(\d+)\]\.(shot|box|pid)$/);
      const k = m ? Number(m[1]) : -1;
      const w = isObj(where[k]) ? where[k] : null;
      if (!w) continue;
      if (m[2] === 'pid') {
        // a page outside the snapshot with its url stays as a place by url; without a url the place goes
        if (typeof w.url === 'string' && w.url.trim()) { repairs.push({ field: e.field, removed: { pid: w.pid }, why: e.msg }); delete w.pid; }
        else dropPlaces.add(k);
        continue;
      }
      if (m[2] === 'shot') { repairs.push({ field: e.field, removed: { shot: w.shot, box: w.box_space === 'image' ? w.box ?? null : null }, why: e.msg }); delete w.shot; if (w.box_space === 'image') { delete w.box; delete w.box_space; } }
      else if (e.code === 'box_not_in_shot' && w.box_space !== 'image') { repairs.push({ field: e.field, removed: { shot: w.shot }, why: e.msg }); delete w.shot; } // the CSS box is fine, the frame is wrong: finalize picks the right part
      else { repairs.push({ field: e.field, removed: { box: w.box }, why: e.msg }); delete w.box; delete w.box_space; }
    }
    const objPlaces = where.filter(isObj).length;
    if (dropPlaces.size && dropPlaces.size < objPlaces) for (const k of dropPlaces) repairs.push({ field: `where[${k}]`, removed: { place: where[k] }, why: M(`страницы ${where[k].pid} нет в снимке`, `page ${where[k].pid} is not in the snapshot`) });
    it.where = where.filter((w, k) => isObj(w) && !(dropPlaces.size < objPlaces && dropPlaces.has(k)));
    if (repairs.length) it.lint_repairs = repairs;
    it.severity = sev;
    it.severity_lens = lensSev;
    it.severity_trail = trail;
    it.verdict = verdict;
    if (conflict) it.verdict_conflict = true;
    if (vd && vd.verdict !== 'unverified') it.verify = { how: vd.how, note: vd.note, fix_ok: vd.fix_ok, text_ok: vd.text_ok, severity_after: vd.severity_after, file: vd.file, round: vd.round };
    if (criticWants && !CONFIRMED.has(verdict)) it.critic_wants = criticWants;
    else if (lateWants && CONFIRMED.has(verdict)) it.critic_wants = lateWants;
    if (it.verdict === 'needs_device') it.needs_device_check = true;
    if (vd?.text_ok === false && typeof it.after === 'string' && it.after) { it.after_rejected = it.after; it.after = null; }
    if (vd?.fix_ok === false) it.fix_ok = false;
    it.requires_check = (it.verdict === 'unverified' || it.verdict === 'needs_device') && V.sevRank(it.severity) <= 1
      || !!it.verdict_conflict || (!!it.critic_wants && !CONFIRMED.has(it.verdict) && V.sevRank(it.critic_wants.to) <= 1);
    kept.push(it); keptById.set(it.id, it);
  }
  // critic raises applied once a later verdict confirmed the finding are no longer "not applied"
  if (lateApplied.size) for (let k = ignored_severity_fixes.length - 1; k >= 0; k--) if (lateApplied.has(ignored_severity_fixes[k])) ignored_severity_fixes.splice(k, 1);
  for (const w of weak) if (keptById.has(w.id)) (keptById.get(w.id).critic_notes ||= []).push(short(w.why || '', 200));
  const rejectedIds = new Set(rejected.map(r => r.id).filter(Boolean));
  for (const [id, fixes] of criticFixes) if (!byId.has(id)) for (const { sf, round } of fixes) ignored_severity_fixes.push({ ...sf, round, why_ignored: preRejected.has(id) || rejectedIds.has(id) ? M('находка отклонена', 'the finding was rejected') : M('нет такой находки', 'no such finding') });
  const orphan_verdicts = [...vlist.keys()].filter(id => !usedVerdicts.has(id) && !rejectedIds.has(id) && !byId.has(id)).map(id => ({ id, file: vlist.get(id)[0].file }));

  // 7. clusters, order, counts
  const clusters = clusterize(kept, pageKeyer(run));
  for (const c of clusters) for (const id of c.ids) keptById.get(id).cluster = c.key;
  kept.sort((a, b) => V.sevRank(a.severity) - V.sevRank(b.severity) || lensOrder(a.lens) - lensOrder(b.lens) || String(a.id).localeCompare(String(b.id)));
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0, total: kept.length, by_lens: {}, by_verdict: { confirmed: 0, adjusted: 0, unverified: 0, needs_device: 0 },
    requires_check: 0, rejected: rejected.length, rejected_files: rejected_files.length, clusters: clusters.length, verdict_conflicts: verdict_conflicts.length };
  for (const it of kept) {
    counts[it.severity] = (counts[it.severity] || 0) + 1;
    counts.by_lens[it.lens] = (counts.by_lens[it.lens] || 0) + 1;
    counts.by_verdict[it.verdict] = (counts.by_verdict[it.verdict] || 0) + 1;
    if (it.requires_check) counts.requires_check++;
  }

  // coverage of a lens: parts of one round repeat totals (max), rounds add up (sum); lists are united
  for (const li of Object.values(lensInfo)) {
    if (!li.cov) continue;
    const byRound = new Map();
    for (const { round, c } of li.cov) {
      const acc = byRound.get(round) || {};
      for (const [k, v] of Object.entries(c)) {
        if (typeof v === 'number') acc[k] = Math.max(acc[k] ?? 0, v);
        else if (Array.isArray(v)) acc[k] = [...new Set([...arr(acc[k]), ...v.map(x => (typeof x === 'object' ? JSON.stringify(x) : x))])];
        else if (acc[k] === undefined) acc[k] = v;
      }
      byRound.set(round, acc);
    }
    const out = {};
    for (const acc of byRound.values()) for (const [k, v] of Object.entries(acc)) {
      if (typeof v === 'number') out[k] = k === 'checklist_total' ? Math.max(out[k] ?? 0, v) : (out[k] ?? 0) + v;
      else if (Array.isArray(v)) out[k] = [...new Set([...arr(out[k]), ...v])];
      else if (out[k] === undefined) out[k] = v;
    }
    li.coverage = out; delete li.cov;
  }

  // 8. handoffs
  const wrongS = new Set(wrong_strengths.map(s => normQ(s.what)));
  const handoffs = { generated: U.nowIso(), to_lens: {}, questions: [], strengths: [], wrong_strengths, wrong_clean_checks, not_checked: [], coverage: {} };
  for (const [lens, li] of Object.entries(lensInfo)) {
    for (const h of li.for_other_lenses) if (isObj(h) && typeof h.lens === 'string' && h.lens) (handoffs.to_lens[h.lens] ||= []).push({ from: lens, note: h.note ?? '' });
    for (const q of li.open_questions) if (isObj(q)) handoffs.questions.push({ from: lens, question: q.question ?? '', why: q.why ?? '' });
    for (const s of li.strengths) if (isObj(s) && !wrongS.has(normQ(s.what))) handoffs.strengths.push({ lens, ...s });
    for (const n of li.not_checked) handoffs.not_checked.push({ lens, item: n });
    handoffs.coverage[lens] = { ...(li.coverage || {}), design_read: li.design_read, files: li.files, skills_used: li.skills_used, clean_checks: li.clean_checks.length };
  }

  const candidates = {
    tool: 'merge', version: U.VERSION, run, generated: U.nowIso(), partial: false,
    items: kept, clusters, counts, rejected, rejected_files,
    ignored_severity_fixes, orphan_verdicts, verdict_issues, verdict_conflicts, contradictions,
    sources: { findings: Object.values(lensInfo).flatMap(l => l.files), verify: verify_files, critic: critic_files, lint: lint_source },
  };
  return { candidates, handoffs, digest: renderDigest(candidates, handoffs) };
}

// ---------- digest.md: one line per finding ----------
const cell = s => String(s ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
export function placeOf(it) {
  const where = arr(it.where).filter(isObj);
  if (!where.length) return '—';
  const w = where[0];
  const p = w.pid || (w.url ? normUrl(w.url) : '?');
  const more = new Set(where.map(x => x.pid || x.url)).size - 1;
  return `${p}@${w.viewport ?? 'all'}${more > 0 ? ` +${more}` : ''}`;
}
export function sevMark(it) {
  const t = arr(it.severity_trail);
  const raised = t.some(x => (x.by === 'critic' || x.by === 'editor') && x.from && V.sevRank(x.to) < V.sevRank(x.from));
  const lowered = t.some(x => x.by === 'skeptic' && x.from && V.sevRank(x.to) > V.sevRank(x.from));
  return `${it.severity}${raised ? '↑' : ''}${lowered ? '↓' : ''}${it.critic_wants ? `↑?${it.critic_wants.to}` : ''}`;
}
function verdictMark(it) {
  return `${it.verdict}${it.requires_check ? '*' : ''}${it.verdict_conflict ? '⚡' : ''}${it.after_rejected ? '~' : ''}${it.fix_ok === false ? '!' : ''}${it.schema_issues?.length ? '?' : ''}${it.source === 'verifier' ? M(' (+скептик)', ' (+skeptic)') : ''}`;
}
function renderDigest(c, h) {
  const n = c.counts;
  const out = [
    `# ${M('Свод находок', 'Findings digest')}`,
    '',
    M(`merge.mjs · ${c.generated}. Строка на находку: id | P | линза | заголовок | страница@ширина | вердикт | кластер. Подробно: node show.mjs --run "<RUN>" --ids <id,…>`,
      `merge.mjs · ${c.generated}. One line per finding: id | P | lens | title | page@width | verdict | cluster. Details: node show.mjs --run "<RUN>" --ids <id,…>`),
    M('Знаки: P1↑ — повышено критиком; P2↓ — понижено скептиком; P2↑?P1 — критик хотел P1, но без проверки скептика не повышено (у confirmed — скептик проверил позже и сам задал важность); * — требует проверки (P0–P1 без вердикта, спор вердиктов или повышение критика без проверки); ⚡ — скептики разошлись в одном круге; ~ — текст «стало» снят скептиком (text_ok=false); ! — правка не годится (fix_ok=false); ? — у находки ошибки схемы (show.mjs покажет какие); (+скептик) — находку добавил скептик.',
      'Marks: P1↑ — raised by the critic; P2↓ — lowered by the skeptic; P2↑?P1 — the critic wanted P1 but the finding is not verified (on a confirmed one: the skeptic checked it later and set the severity); * — needs checking (P0–P1 without a verdict, conflicting verdicts or an unverified critic raise); ⚡ — skeptics disagree within one round; ~ — "after" text dropped by the skeptic (text_ok=false); ! — fix not usable (fix_ok=false); ? — schema errors (see show.mjs); (+skeptic) — added by the skeptic.'),
    '',
    `${M('Итого', 'Total')}: P0 ${n.P0} · P1 ${n.P1} · P2 ${n.P2} · P3 ${n.P3} · ${M('требуют проверки', 'need checking')} ${n.requires_check} · ${M('отклонено', 'rejected')} ${n.rejected} · ${M('битых файлов', 'broken files')} ${n.rejected_files} · ${M('кластеров', 'clusters')} ${n.clusters}`,
    '',
    '| id | P | lens | title | pid@w | verdict | cluster |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const it of c.items) out.push(`| ${cell(it.id)} | ${sevMark(it)} | ${cell(it.lens)} | ${cell(short(it.title, 100))} | ${cell(placeOf(it))} | ${verdictMark(it)} | ${it.cluster || ''} |`);
  if (c.clusters.length) {
    out.push('', `## ${M('Кластеры (кандидаты на слияние)', 'Clusters (merge candidates)')}`, '');
    for (const k of c.clusters) out.push(`- ${k.key} · ${k.kind === 'sitewide' ? M('сквозная', 'sitewide') : M('дубль', 'duplicate')} · ${k.max_severity} · ${k.ids.join(', ')} · ${cell(k.reason)}${k.pids.length ? ` · ${k.pids.join(', ')}` : ''}`);
  }
  if (c.verdict_conflicts.length) {
    out.push('', `## ${M('Скептики разошлись', 'Conflicting verdicts')}`, '');
    for (const v of c.verdict_conflicts) out.push(`- ${v.id} (${M('круг', 'round')} ${v.round}): ${v.verdicts.map(x => `${x.verdict}${x.severity_after ? ' ' + x.severity_after : ''} — ${x.file}`).join('; ')} → ${v.resolution}`);
  }
  if (c.rejected.length) {
    out.push('', `## ${M('Отклонено', 'Rejected')} (${c.rejected.length})`, '', `| id | P | lens | ${M('кем', 'by')} | ${M('почему', 'why')} |`, '|---|---|---|---|---|');
    for (const r of c.rejected) out.push(`| ${cell(r.id ?? '—')} | ${r.severity ?? '—'} | ${cell(r.lens)} | ${r.by} | ${cell(short(r.why, 140))} |`);
  }
  if (c.rejected_files.length) {
    out.push('', `## ${M('Битые файлы', 'Broken files')}`, '');
    for (const r of c.rejected_files) out.push(`- ${r.file} — ${cell(short(r.reason, 300))}`);
  }
  if (c.ignored_severity_fixes.length) {
    out.push('', `## ${M('Поправки важности, которые не применены', 'Severity fixes not applied')}`, '');
    for (const s of c.ignored_severity_fixes) out.push(`- ${s.id}: ${s.from ?? '?'}→${s.to} (${M('круг', 'round')} ${s.round}) — ${s.why_ignored}`);
  }
  if (c.orphan_verdicts.length) out.push('', `${M('Вердикты на неизвестные id', 'Verdicts for unknown ids')}: ${c.orphan_verdicts.map(o => `${o.id} (${o.file})`).join(', ')}`);
  // per-lens coverage line for the critic
  out.push('', `## ${M('Линзы', 'Lenses')}`, '', `| lens | ${M('находок', 'findings')} | ${M('подтв./скорр./без вердикта', 'conf./adj./unverified')} | ${M('кадров просмотрено', 'frames viewed')} | ${M('не проверено', 'not checked')} | ${M('передано другим', 'handoffs')} |`, '|---|---|---|---|---|---|');
  const lenses = [...new Set([...Object.keys(h.coverage), ...c.items.map(i => i.lens)])].sort((a, b) => lensOrder(a) - lensOrder(b));
  for (const l of lenses) {
    const its = c.items.filter(i => i.lens === l);
    const cov = h.coverage[l] || {};
    const cnt = v => its.filter(i => i.verdict === v).length;
    out.push(`| ${l} | ${its.length} | ${cnt('confirmed')}/${cnt('adjusted')}/${cnt('unverified') + cnt('needs_device')} | ${cov.screenshots_viewed ?? '—'} | ${h.not_checked.filter(x => x.lens === l).length} | ${Object.values(h.to_lens).flat().filter(x => x.from === l).length} |`);
  }
  const toLens = Object.entries(h.to_lens);
  if (toLens.length) {
    out.push('', `## ${M('Передано линзам (критику: задача или отказ)', 'Handed to lenses (critic: task or rejection)')}`, '');
    for (const [to, list] of toLens) for (const x of list) out.push(`- → ${to} ${M('от', 'from')} ${x.from}: ${cell(short(x.note, 200))}`);
  }
  return out.join('\n') + '\n';
}

// ---------- CLI ----------
const HELP = `
merge.mjs — свод находок: findings/* + verify/* + critic/* → report/candidates.json, report/digest.md, report/handoffs.json.

  node merge.mjs --run "<RUN>" [--audience owner|team|external] [--ids-recheck <id,…>] [--budget-sec N] [--json] [--lang ru|en]

Правила:
  - вердикт скептика rejected → в rejected[]; без вердикта — verdict unverified, у P0–P1 пометка requires_check;
  - важность = severity_after скептика, иначе линзы; события идут по кругам: вердикты круга N, затем критик круга N;
  - критик только повышает и только находки с confirmed/adjusted; повышение непроверенной не применяется
    (ignored_severity_fixes, пометка ↑? в digest, requires_check, если хотел P0–P1); подтвердил скептик позже
    без severity_after — повышение применяется в этот момент, с severity_after — остаётся пометка ↑?;
    каждое изменение — в severity_trail;
  - перепроверка по id (после критика) идёт последней: её вердикт и severity_after перекрывают повышение критика.
    Какие id перепроверены — <RUN>/recheck-ids.json (пишет state.mjs, когда просит перепроверку; ручной путь —
    --ids-recheck <id,…> записывает этот файл сам);
  - вкусовое (taste) — не выше P3; confidence: low без флагов получает needs_decision: true;
  - id чужой линзы, повтор id, служебные поля линзы (uid, rid, verdict, severity_trail…) не принимаются;
  - блокирующие ошибки lint (${BLOCKING_CODES.join(', ')}): находка линзы — только с confirmed/adjusted;
    находка, добавленная скептиком, проходит те же проверки и с блокирующей ошибкой отклоняется;
    битые ссылки на кадр, рамку, неизвестную страницу снимаются (lint_repairs);
  - text_ok=false → поле after переносится в after_rejected;
  - кластеры дублей: совпадающие рамки или похожие заголовки; селектор, категория, страница — добавка; ≤ 10 в кластере;
  - битые файлы → rejected_files, скрипт не падает.
lint берётся из verify/<lens>.lint.json, если он свежее файлов линзы; иначе считается и сохраняется туда же
(индекс слов страниц — в verify/lint-index/).
Код 0 — готово, 2 — нет папки прогона, 75 — не уложился в --budget-sec (по умолчанию 480; lint сохранён,
повторите тот же вызов — продолжу).
`;

async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['json', 'help'] });
  U.helpAndExit(HELP, args);
  const lang = U.langOf(args);
  LANG = lang; V.setLang(lang); setLintLang(lang);
  if (!args.run || args.run === true) { console.error(U.msg('need_run', lang)); process.exit(2); }
  const run = resolve(String(args.run));
  if (!existsSync(run)) { console.error(M(`Нет папки прогона: ${run}`, `Run folder not found: ${run}`)); process.exit(2); }
  const budgetSec = Math.max(1, Number(args['budget-sec'] ?? 480) || 480);
  const deadline = Date.now() + budgetSec * 1000 - Math.min(5000, budgetSec * 100);
  const brief = U.readJSON(join(run, 'brief.json'), null) || {};
  const state = U.readJSON(join(run, 'state.json'), null) || {};
  const idsArg = U.listArg(args['ids-recheck']);
  if (idsArg.length) U.writeJSON(join(run, 'recheck-ids.json'), { ids: idsArg, manual: true, requested: U.nowIso() });
  const audience = ['owner', 'team', 'external'].includes(args.audience) ? args.audience : (brief.audience || state.flags?.audience || 'owner');
  const built = buildCandidates(run, { audience, deadline, saveLint: true });
  if (built.partial) {
    const lines = [M(`merge · ЧАСТИЧНО: lint посчитан для ${built.lint_done} из ${built.lint_total} линз (остановился на ${built.lens}), результат сохранён в verify/<линза>.lint.json.`,
      `merge · PARTIAL: lint done for ${built.lint_done} of ${built.lint_total} lenses (stopped at ${built.lens}), saved to verify/<lens>.lint.json.`),
    M('report/candidates.json не обновлён. Повторите тот же вызов (код 75) — продолжу с того же места.', 'report/candidates.json was not updated. Run the same command again (exit 75) to continue.')];
    U.log(run, `merge.mjs: partial, lint ${built.lint_done}/${built.lint_total}`);
    if (args.json) process.stdout.write(JSON.stringify({ partial: true, resume: { done: built.lint_done, total: built.lint_total } }, null, 2) + '\n');
    else U.printAndSaveSummary(run, 'merge', lines);
    process.exit(75);
  }
  const { candidates, handoffs, digest } = built;
  U.writeJSON(U.insideRun(run, 'report', 'candidates.json'), candidates);
  U.writeJSON(U.insideRun(run, 'report', 'handoffs.json'), handoffs);
  U.writeText(U.insideRun(run, 'report', 'digest.md'), digest);
  const c = candidates.counts;
  U.log(run, `merge.mjs: находок ${c.total} (P0 ${c.P0}, P1 ${c.P1}, P2 ${c.P2}, P3 ${c.P3}), отклонено ${c.rejected}, битых файлов ${c.rejected_files}, кластеров ${c.clusters}`);
  if (args.json) { process.stdout.write(JSON.stringify({ counts: c, rejected_files: candidates.rejected_files }, null, 2) + '\n'); return; }
  const lines = [
    `merge · ${M('находок', 'findings')} ${c.total}: P0 ${c.P0} · P1 ${c.P1} · P2 ${c.P2} · P3 ${c.P3}`,
    `${M('Вердикты', 'Verdicts')}: confirmed ${c.by_verdict.confirmed} · adjusted ${c.by_verdict.adjusted} · unverified ${c.by_verdict.unverified} · needs_device ${c.by_verdict.needs_device} · ${M('требуют проверки', 'need checking')} ${c.requires_check}${c.verdict_conflicts ? ` · ${M('споров вердиктов', 'verdict conflicts')} ${c.verdict_conflicts}` : ''}`,
    `${M('Отклонено', 'Rejected')} ${c.rejected}: ${M('скептиком', 'skeptic')} ${candidates.rejected.filter(r => r.by === 'skeptic').length} · lint ${candidates.rejected.filter(r => r.by === 'lint').length} · ${M('схема/дубли', 'schema/dups')} ${candidates.rejected.filter(r => r.by === 'schema' || r.by === 'merge').length}`,
    `${M('Кластеров дублей', 'Duplicate clusters')} ${c.clusters} (${M('сквозных', 'sitewide')} ${candidates.clusters.filter(k => k.kind === 'sitewide').length}) · ${M('по линзам', 'by lens')}: ${Object.entries(c.by_lens).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`,
  ];
  const raised = candidates.items.filter(i => i.critic_raised).length;
  const wants = candidates.items.filter(i => i.critic_wants).length;
  if (raised || candidates.ignored_severity_fixes.length) lines.push(`${M('Критик повысил', 'Critic raised')} ${raised}; ${M('не применено поправок', 'fixes not applied')} ${candidates.ignored_severity_fixes.length}${wants ? M(` (из них ${wants} — к непроверенным: ↑? в digest)`, ` (${wants} on unverified findings: ↑? in the digest)`) : ''}`);
  if (candidates.rejected_files.length) {
    const shown = candidates.rejected_files.slice(0, 6);
    lines.push(`${M('Битые файлы', 'Broken files')} (${candidates.rejected_files.length}) — ${M('их находки не вошли', 'their findings are not included')}:`);
    for (const r of shown) lines.push(`  ${r.file}: ${short(r.reason, 160)}`);
    if (candidates.rejected_files.length > shown.length) lines.push(M(`  … и ещё ${candidates.rejected_files.length - shown.length} — список в report/digest.md`, `  … and ${candidates.rejected_files.length - shown.length} more — see report/digest.md`));
  }
  const p0 = candidates.items.filter(i => i.severity === 'P0');
  for (const it of p0.slice(0, 5)) lines.push(`  P0 ${it.id} · ${short(it.title, 90)} · ${it.verdict}${it.requires_check ? '*' : ''}`);
  if (p0.length > 5) lines.push(M(`  … и ещё P0: ${p0.length - 5}`, `  … and ${p0.length - 5} more P0`));
  if (candidates.orphan_verdicts.length) lines.push(`${M('Вердикты на неизвестные id', 'Verdicts for unknown ids')}: ${candidates.orphan_verdicts.map(o => o.id).slice(0, 8).join(', ')}${candidates.orphan_verdicts.length > 8 ? ' …' : ''}`);
  lines.push('→ report/candidates.json · report/digest.md · report/handoffs.json');
  U.printAndSaveSummary(run, 'merge', lines);
}

const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
