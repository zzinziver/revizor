#!/usr/bin/env node
// Revizor — finalize.mjs: report/candidates.json + report/editorial.json → report/findings.json.
// Applies the editor's decisions under the rules: a drop that names a duplicate is a merge; a confirmed/adjusted
// finding or a P0–P1 without a verdict leaves only through a merge; merges only of related findings (one cluster,
// element, overlapping box, page + category, or category + similar title); the merged finding shows ONE member — the
// highest severity, then the best verdict — with its text, verdict, confidence and flags (a weaker kept finding cannot
// dress a stronger one, an unverified member cannot borrow a verdict, a confirmed member cannot be hidden); severity is
// lowered only by the skeptic (merge.mjs), so the editor cannot go below any member's level; raising is free (taste
// stays ≤ P3); rewritten texts bring no new numbers or quotes. Assigns rid (P0-01…) and a permanent uid, converts boxes
// taken from frame parts to document CSS px and adds crop hints. For external: unverifiable findings go to
// report/external-dropped.json (this script is its only writer). Final check: every confirmed|adjusted candidate is in
// exactly one merged_from, nothing is lost silently, and for external none of the reportable ones is dropped.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as U from './lib/util.mjs';
import * as V from './validate.mjs';
import { extractQuotes, normQ, setLang as setLintLang, TEXT_LENSES, PageTexts, locateQuote } from './lint-findings.mjs';
import { selSignal, pageKeyer, titleSimilarity, iou } from './merge.mjs';

let LANG = 'ru';
const M = (ru, en) => (LANG === 'en' ? en : ru);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const arr = v => (Array.isArray(v) ? v : []);
const clone = v => JSON.parse(JSON.stringify(v));
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const lensOrder = l => { const i = V.KNOWN_LENSES.indexOf(l); return i < 0 ? 99 : i; };
const CONFIRMED = new Set(['confirmed', 'adjusted']);
const VERDICT_RANK = { confirmed: 0, adjusted: 1, needs_device: 2, unverified: 3 };
// text of a finding: taken together from one member (never mixed)
const TEXT_FIELDS = ['title', 'evidence', 'problem', 'impact', 'fix', 'scenario', 'before', 'after', 'after_rejected', 'method', 'norm', 'fix_check', 'fix_verified', 'fix_ok', 'fix_place', 'owner', 'effort', 'category'];
const ID_IN_TEXT = /(?<![a-z0-9-])[a-z0-9]+(?:-[a-z0-9]+)*-(?:r2-|v)?\d{2,3}(?![a-z0-9])/g;

function placeKey(w) { return isObj(w) ? [w.pid ?? w.url ?? '', w.viewport ?? '', w.selector ?? '', w.state ?? '', w.block ?? ''].map(x => String(x).toLowerCase().trim()).join('|') : ''; }
// numbers of a text: severity labels (P0) are not numbers, digit groups (1 500) are one number
const numbersOf = s => new Set((String(s ?? '').replace(/(?<![\p{L}\p{N}])P[0-3](?![\p{N}])/gu, ' ').replace(/(\d)[\s  ](?=\d{3}(?!\d))/g, '$1')
  .match(/\d+(?:[.,]\d+)?/g) || []).map(n => n.replace(',', '.')));

/** A finding the external report can show: confirmed by the skeptic, no device check, not low confidence. */
const reportable = m => CONFIRMED.has(m.verdict) && !m.needs_device_check && m.confidence !== 'low' && !m.verdict_conflict;
/** Can the external report show this member's text (as a standalone finding of severity `sev`)? */
const showableExternal = (m, sev) => !m.needs_device_check && m.verdict !== 'needs_device' && m.confidence !== 'low' && !m.verdict_conflict
  && (CONFIRMED.has(m.verdict) || V.sevRank(sev) > 1);
const finalVerdict = v => (v === 'confirmed' || v === 'adjusted' ? v : 'unverified');
// fields that state facts: an editor's rewrite brings no new numbers or quotes into them
const CLAIM_FIELDS = ['title', 'problem', 'impact', 'scenario', 'evidence', 'before'];

/** Convert boxes and add crop hints. Mutates where[]. → number of converted boxes. */
export function fixBoxes(run, it) {
  let converted = 0;
  for (const w of arr(it.where)) {
    if (!isObj(w) || !V.validBox(w.box)) continue;
    const vp = /^\d+$/.test(String(w.viewport ?? '')) ? Number(w.viewport) : null;
    if (w.box_space === 'image') {
      const ref = w.shot ? U.shotRef(run, w.shot, w.pid) : null;
      const css = ref?.entry ? U.boxImageToCss(ref.entry, w.box) : null;
      w.crop = ref?.exists ? { shot: ref.rel, box: w.box.map(Math.round) } : null;
      if (css) { w.box_image = w.box; w.box = css; w.box_space = 'css'; converted++; }
      else w.box_note = ref?.entry ? M('кадр прокрутки внутри блока — рамка в пикселях кадра', 'inner-scroll frame — box in frame pixels')
        : M('кадр не из снимка страниц — рамка в пикселях кадра', 'not a snapshot frame — box in frame pixels');
      continue;
    }
    const ref = w.shot ? U.shotRef(run, w.shot, w.pid) : null;
    if (ref?.exists && !ref.entry) {
      // probe/, measure/mobile/…: own scale (DPR 2); a CSS box cannot be mapped onto this frame
      w.box_space = 'css'; w.crop = null;
      w.box_note = M('рамка CSS на кадре не из снимка — кропа нет; дайте box_space: image', 'CSS box on a non-snapshot frame — no crop; use box_space: image');
      continue;
    }
    // CSS box: crop hint on the named frame when the box is there, else the best part of this page and width
    let crop = null;
    if (ref?.entry && ref.exists) {
      const ib = U.boxCssToImage(ref.entry, w.box);
      const iw = Number(ref.entry.img_w) || Infinity, ih = Number(ref.entry.img_h) || Infinity;
      if (ib && ib[0] < iw && ib[1] < ih && ib[0] + ib[2] > 0 && ib[1] + ib[3] > 0) {
        const x0 = Math.max(0, ib[0]), y0 = Math.max(0, ib[1]);
        crop = { shot: ref.rel, box: [x0, y0, Math.min(iw, ib[0] + ib[2]) - x0, Math.min(ih, ib[1] + ib[3]) - y0] };
      }
    }
    if (!crop && w.pid && vp) { const s = U.shotForCssBox(run, w.pid, vp, w.box); if (s) crop = { shot: s.rel, box: s.box }; }
    w.box_space = 'css';
    w.crop = crop;
  }
  return converted;
}

/** Inputs newer than candidates.json → [rel paths] (merge.mjs must run again). */
export function staleInputs(run, candMtime) {
  const out = [];
  const scan = (dir, test) => { try { for (const f of readdirSync(join(run, dir))) if (test(f)) { try { if (statSync(join(run, dir, f)).mtimeMs > candMtime + 1) out.push(`${dir}/${f}`); } catch {} } } catch {} };
  scan('findings', f => f.endsWith('.json'));
  scan('verify', f => f.endsWith('.json') && !f.endsWith('.lint.json') && f !== 'recheck.json');
  scan('critic', f => /^round-\d+\.json$/.test(f));
  return out;
}

export function finalize(run, cand, ed, { audience = 'owner', prev = null } = {}) {
  if (!isObj(ed)) ed = {};
  const refused = [], notes = [], warnings = [];
  const refuse = (op, entry, why) => refused.push({ op, entry, why });
  const order = new Map();
  const info = new Map();   // candidate members as merge.mjs left them
  const live = new Map();
  arr(cand.items).forEach((x, i) => {
    if (!isObj(x) || typeof x.id !== 'string' || info.has(x.id)) return;
    const m = clone(x);
    m.where = arr(m.where).filter(isObj);
    m.severity_trail = Array.isArray(m.severity_trail) ? m.severity_trail : [{ by: 'lens', from: null, to: m.severity, why: '' }];
    info.set(m.id, m);
    const it = clone(m);
    it.merged_from = [it.id];
    it.lenses = [it.lens];
    live.set(it.id, it); order.set(it.id, i);
  });
  // ids that exist only as rejected (a rejected duplicate of a live id does not count)
  const rejectedIds = new Set(arr(cand.rejected).map(r => r?.id).filter(id => id && !live.has(id)));
  const home = new Map(); // absorbed id → keep id
  const resolveId = id => { let cur = id, n = 0; while (home.has(cur) && n++ < 1000) cur = home.get(cur); return live.has(cur) ? cur : null; };
  const dropped = [];
  const members = it => it.merged_from.map(id => info.get(id)).filter(Boolean);
  const vrank = m => VERDICT_RANK[m.verdict] ?? 3;
  const pageOf = pageKeyer(run);
  let pageTexts = null;
  const texts = () => (pageTexts ||= new PageTexts(run));

  /** The member a (merged) finding shows: the highest severity, then the best verdict, then the kept one. */
  function leadOf(it) {
    const mem = members(it);
    const sev = V.maxSeverity(mem.map(m => m.severity)) || it.severity;
    return mem.filter(m => m.severity === sev).sort((a, b) => vrank(a) - vrank(b) || (a.id === it.id ? -1 : b.id === it.id ? 1 : 0))[0] || info.get(it.id);
  }
  /** Severity, text, verdict, confidence and flags of a merged finding: all from one member, the lead. Mutates `it`. */
  function derive(it) {
    const mem = members(it);
    if (mem.length < 2) return;
    const before = it.severity;
    const lead = leadOf(it);
    const sev = lead.severity || it.severity;
    // text, verdict and flags travel together: the shown text is the one the shown verdict and flags are about
    for (const f of TEXT_FIELDS) { if (lead[f] === undefined) delete it[f]; else it[f] = clone(lead[f]); }
    if (lead.id !== it.id) it.text_from = lead.id; else delete it.text_from;
    if (it._title) it.title = it._title;
    it.verdict = lead.verdict;
    if (lead.verify) it.verify = { ...lead.verify, from: lead.id }; else delete it.verify;
    if (lead.verdict_conflict) it.verdict_conflict = true; else delete it.verdict_conflict;
    if (lead.critic_wants) it.critic_wants = { ...lead.critic_wants, from: lead.id }; else delete it.critic_wants;
    it.confidence = lead.confidence;
    it.needs_device_check = !!lead.needs_device_check || lead.verdict === 'needs_device';
    it.needs_decision = !!lead.needs_decision;
    it.taste = mem.every(m => m.taste === true);
    it.verdicts_by_member = Object.fromEntries(mem.map(m => [m.id, `${m.verdict} ${m.severity}`]));
    if (sev !== before) { it.severity_trail.push({ by: 'editor', from: before, to: sev, why: M(`слияние: важность, текст и вердикт — от ${lead.id}`, `merge: severity, text and verdict of ${lead.id}`) }); it.severity = sev; }
  }
  /** Would the external report drop this finding? */
  const extDropReason = it => it.needs_device_check ? 'needs_device_check' : it.confidence === 'low' ? 'confidence_low'
    : it.verdict_conflict ? 'unverified' : (!CONFIRMED.has(it.verdict) && (V.sevRank(it.severity) <= 1 || (it.critic_wants && V.sevRank(it.critic_wants.to) <= 1))) ? 'unverified' : null;
  /** Must the skeptic look at it before it may leave the report (P0–P1 without a verdict, conflict, unverified critic raise)? */
  const needsCheck = it => !!it.verdict_conflict || members(it).some(m => m.requires_check)
    || (!CONFIRMED.has(it.verdict) && (V.sevRank(it.severity) <= 1 || (!!it.critic_wants && V.sevRank(it.critic_wants.to) <= 1)));
  /**
   * Are two findings about one thing? → the link or null. Links: one cluster of duplicates (merge.mjs), one element
   * (a selector that names it), overlapping boxes (IoU ≥ 0.5) on one page and width, one page + one category,
   * one category + similar titles (one cause on several pages). One shared page alone is not a link: home is shared by almost all.
   */
  function relation(a, b) {
    const ma = members(a), mb = members(b);
    const cl = new Set(ma.map(m => m.cluster).filter(Boolean));
    if (mb.some(m => m.cluster && cl.has(m.cluster))) return 'cluster';
    const sels = new Set(ma.flatMap(m => m.where.map(w => selSignal(w.selector)).filter(Boolean)));
    if (mb.some(m => m.where.some(w => { const s = selSignal(w.selector); return !!s && sels.has(s); }))) return 'selector';
    const boxes = ms => ms.flatMap(m => m.where.filter(w => V.validBox(w.box) && (w.box_space || 'css') === 'css').map(w => ({ p: pageOf(w), vp: String(w.viewport ?? ''), box: w.box })));
    const bb = boxes(mb);
    if (boxes(ma).some(x => x.p && bb.some(y => y.p === x.p && y.vp === x.vp && iou(x.box, y.box) >= 0.5))) return 'box';
    const cats = new Set(ma.map(m => U.normText(m.category || '')).filter(Boolean));
    if (!mb.some(m => { const c = U.normText(m.category || ''); return !!c && cats.has(c); })) return null;
    const pages = new Set(ma.flatMap(m => m.where.map(pageOf).filter(Boolean)));
    if (mb.some(m => m.where.some(w => { const p = pageOf(w); return !!p && pages.has(p); }))) return 'page+category';
    if (ma.some(x => mb.some(y => titleSimilarity(x.title, y.title) >= 0.3))) return 'category+title';
    return null;
  }
  const unrelatedText = (A, K) => M(`${A.id} и ${K.id} не про одно и то же: нет общего кластера, элемента (selector) или пересечения рамок; одна страница считается только вместе с одной категорией, одна категория — вместе с похожими заголовками`,
    `${A.id} and ${K.id} are not about one thing: no shared cluster, element (selector) or overlapping box; one page counts only with one category, one category only with similar titles`);
  /** Absorb live finding hA into keep K. → error text or null (nothing changed on error). */
  function absorb(keepId, h, why) {
    const K = live.get(keepId), A = live.get(h);
    if (!relation(K, A)) return unrelatedText(A, K);
    if (audience === 'external') {
      const T = clone(K); T.merged_from = [...K.merged_from, ...A.merged_from]; derive(T);
      const hidden = members(T).filter(reportable);
      if (extDropReason(T) && hidden.length) return M(`для external слитая находка ушла бы из отчёта (${extDropReason(T)}) вместе с подтверждённой ${hidden.map(m => m.id).join(', ')}`, `for external the merged finding would leave the report (${extDropReason(T)}) together with confirmed ${hidden.map(m => m.id).join(', ')}`);
    }
    K.merged_from.push(...A.merged_from);
    K.lenses = [...new Set([...K.lenses, ...A.lenses])].sort((x, y) => lensOrder(x) - lensOrder(y));
    const seen = new Set(arr(K.where).map(placeKey));
    for (const w of arr(A.where)) if (isObj(w) && !seen.has(placeKey(w))) { (K.where ||= []).push(w); seen.add(placeKey(w)); }
    if (Array.isArray(A.tags)) K.tags = [...new Set([...arr(K.tags), ...A.tags])];
    K.sitewide = !!(K.sitewide || A.sitewide);
    if (typeof A.pages_affected_estimate === 'number') K.pages_affected_estimate = Math.max(K.pages_affected_estimate || 0, A.pages_affected_estimate);
    K.q = K.q ?? A.q ?? null;
    K.absorbed = [...arr(K.absorbed), { id: A.id, lens: A.lens, title: A.title, severity: A.severity, verdict: A.verdict, evidence: short(A.evidence, 400), severity_trail: A.severity_trail, why: why || null }, ...arr(A.absorbed)];
    for (const id of A.merged_from) home.set(id, keepId);
    live.delete(h);
    derive(K);
    return null;
  }
  /** Numbers and quotes the members already state (lens texts, places, the skeptic's how/note). */
  function claimSources(it, { proposals = true } = {}) {
    const mem = members(it);
    const said = mem.flatMap(m => [m.evidence, m.title, m.problem, m.impact, m.scenario, m.before, m.norm, m.verify?.how, m.verify?.note]).filter(x => typeof x === 'string');
    const extra = mem.flatMap(m => [...(proposals ? [m.fix, m.after] : []), ...m.where.flatMap(w => [w.viewport, w.selector, w.block, w.state]), m.pages_affected_estimate])
      .filter(x => x !== undefined && x !== null).map(String);
    extra.push(String(arr(it.where).length), String(mem.length));
    return { quotes: normQ(said.join('\n')), numbers: new Set([...said, ...extra].flatMap(t => [...numbersOf(t)])) };
  }
  /** New numbers or «quotes» of an editor's text against what the members state → description or null. */
  function newClaims(v, it, field) {
    const src = claimSources(it, { proposals: field !== 'evidence' });
    const newQ = extractQuotes(v).filter(q => !src.quotes.includes(normQ(q)));
    const newN = [...numbersOf(v)].filter(n => !src.numbers.has(n));
    if (!newQ.length && !newN.length) return null;
    return [newQ.length ? M(`цитаты «${newQ.slice(0, 2).map(q => short(q, 40)).join('», «')}»`, `quotes "${newQ.slice(0, 2).map(q => short(q, 40)).join('", "')}"`) : null,
      newN.length ? M(`числа ${newN.slice(0, 5).join(', ')}`, `numbers ${newN.slice(0, 5).join(', ')}`) : null].filter(Boolean).join(' · ');
  }
  const claimRefusal = (field, what) => M(`в ${field} новое — ${what}: этого нет ни в доказательстве и текстах членов, ни у скептика; текст можно только сократить и переформулировать`,
    `new content in ${field} — ${what}: not in the members' evidence and texts nor in the skeptic's notes; the text may only be shortened or rephrased`);

  // 1. merges
  for (const m of arr(ed.merge)) {
    if (!isObj(m) || typeof m.keep !== 'string' || !Array.isArray(m.absorb)) { refuse('merge', m, M('нужны keep и absorb', 'keep and absorb are required')); continue; }
    const keepId = resolveId(m.keep);
    if (!keepId) { refuse('merge', m, rejectedIds.has(m.keep) ? M(`${m.keep} отклонена — оставьте другую находку`, `${m.keep} was rejected — keep another finding`) : M(`нет находки ${m.keep}`, `no finding ${m.keep}`)); continue; }
    let titleOk = true;
    if (m.title !== undefined && !(typeof m.title === 'string' && m.title.trim() && [...m.title.trim()].length <= 100)) { refuse('merge', { keep: m.keep, title: m.title }, M('title — строка до 100 знаков', 'title must be a string up to 100 chars')); titleOk = false; }
    for (const a of m.absorb) {
      if (typeof a !== 'string') continue;
      if (rejectedIds.has(a)) { notes.push(M(`${a} уже отклонена — в слияние не вошла`, `${a} was already rejected — not merged`)); continue; }
      const h = resolveId(a);
      if (!h) { refuse('merge', { keep: m.keep, absorb: a }, M(`нет находки ${a} (или она снята drop)`, `no finding ${a} (or it was dropped)`)); continue; }
      if (h === keepId) continue;
      const err = absorb(keepId, h, null);
      if (err) refuse('merge', { keep: m.keep, absorb: a }, err);
    }
    if (m.title !== undefined && titleOk) {
      const K = live.get(keepId);
      const bad = newClaims(m.title.trim(), K, 'title');
      if (bad) { refuse('merge', { keep: m.keep, title: m.title }, claimRefusal('title', bad)); continue; }
      (K.original ||= {}).title ??= K.title;
      K._title = m.title.trim(); K.title = K._title;
      K.rewritten = [...new Set([...arr(K.rewritten), 'title'])];
    }
  }

  // 2. drops. A duplicate (its kept twin named in why) is merged into the twin: it must be related to it, its places and
  //    evidence stay in the twin's absorbed[], the severity is the max of both. A plain drop only for a finding with schema
  //    issues that is neither confirmed nor waiting for the skeptic (P0–P1 without a verdict, a conflict).
  for (const d of arr(ed.drop)) {
    if (!isObj(d) || typeof d.id !== 'string') { refuse('drop', d, M('нужен id', 'id is required')); continue; }
    if (rejectedIds.has(d.id)) { notes.push(M(`${d.id} уже отклонена — drop не нужен`, `${d.id} was already rejected — no drop needed`)); continue; }
    const h = resolveId(d.id);
    if (!h) { refuse('drop', d, M(`нет находки ${d.id}`, `no finding ${d.id}`)); continue; }
    if (h !== d.id) { refuse('drop', d, M(`${d.id} уже слита в ${h}`, `${d.id} is already merged into ${h}`)); continue; }
    const why = typeof d.why === 'string' ? d.why.trim() : '';
    if (!why) { refuse('drop', d, M('нужна причина why: «дубль <id оставшейся находки>» или ошибки схемы', 'why is required: "duplicate of <kept id>" or schema issues')); continue; }
    const it = live.get(h);
    const twin = [...new Set(why.match(ID_IN_TEXT) || [])].map(resolveId).find(x => x && x !== h) || null;
    if (twin) {
      if (!relation(live.get(twin), it)) { refuse('drop', d, M(`не дубль: ${unrelatedText(it, live.get(twin))}`, `not a duplicate: ${unrelatedText(it, live.get(twin))}`)); continue; }
      const err = absorb(twin, h, why);
      if (err) refuse('drop', d, err);
      else notes.push(M(`${d.id} — дубль ${twin}: drop превращён в слияние (места и доказательство — в ${twin}, absorbed)`, `${d.id} duplicates ${twin}: the drop became a merge (places and evidence are in ${twin}, absorbed)`));
      continue;
    }
    if (members(it).some(m => CONFIRMED.has(m.verdict))) { refuse('drop', d, M(`${d.id} подтверждена скептиком — убрать можно только как дубль: напишите в why id оставшейся находки (станет слиянием)`, `${d.id} is confirmed by the skeptic — it can leave only as a duplicate: name the kept id in why (it becomes a merge)`)); continue; }
    if (needsCheck(it)) { refuse('drop', d, M(`нужна перепроверка скептиком: ${d.id} (${it.severity} без вердикта${it.verdict_conflict ? ', скептики разошлись' : ''}) — такую находку не снимают, её снимает только вердикт rejected; если это дубль — назовите в why id оставшейся`, `needs the skeptic: ${d.id} (${it.severity} without a verdict${it.verdict_conflict ? ', conflicting verdicts' : ''}) — only a rejected verdict removes it; if it is a duplicate, name the kept id in why`)); continue; }
    if (!arr(it.schema_issues).length) { refuse('drop', d, M(`drop — только дубль (укажите в why id оставшейся находки) или находка с ошибками схемы; у ${d.id} их нет`, `drop is only for a duplicate (name the kept id in why) or a finding with schema issues; ${d.id} has none`)); continue; }
    dropped.push({ id: it.id, merged_from: it.merged_from, lens: it.lens, title: it.title, severity: it.severity, verdict: it.verdict, why, dup_of: null, schema_issues: arr(it.schema_issues).slice(0, 5) });
    live.delete(h);
  }

  // 3. severity: raise freely (taste ≤ P3); lowering is the skeptic's — never below any member's level
  for (const s of arr(ed.severity)) {
    if (!isObj(s) || typeof s.id !== 'string' || !V.SEVERITIES.includes(s.to)) { refuse('severity', s, M('нужны id и to (P0–P3)', 'id and to (P0–P3) are required')); continue; }
    const h = resolveId(s.id);
    if (!h) { refuse('severity', s, rejectedIds.has(s.id) ? M(`${s.id} отклонена`, `${s.id} was rejected`) : M(`нет находки ${s.id}`, `no finding ${s.id}`)); continue; }
    const it = live.get(h), cur = it.severity;
    if (s.to === cur) continue;
    const why = typeof s.why === 'string' ? s.why : '';
    if (V.sevRank(s.to) < V.sevRank(cur)) {
      if (it.taste === true && V.sevRank(s.to) < 3) { refuse('severity', s, M(`${s.id} — вкусовое (taste): не выше P3`, `${s.id} is taste: P3 at most`)); continue; }
      it.severity_trail.push({ by: 'editor', from: cur, to: s.to, why: short(why, 300) }); it.severity = s.to; continue;
    }
    // lowering: a verdict_ref, when given, must be the verdict merge.mjs applied
    if (s.verdict_ref !== undefined && s.verdict_ref !== null) {
      const mm = String(s.verdict_ref).trim().replace(/\\/g, '/').match(/^(?:(verify\/[^#]+\.json))?#?([a-z0-9-]+)$/);
      if (!mm) { refuse('severity', s, M(`verdict_ref «${s.verdict_ref}» не по образцу verify/<линза>.json#<id>`, `verdict_ref "${s.verdict_ref}" is not like verify/<lens>.json#<id>`)); continue; }
      const [, file, rid] = mm;
      if (!it.merged_from.includes(rid)) { refuse('severity', s, M(`вердикт ${rid} — про другую находку (эта собрана из ${it.merged_from.join(', ')})`, `verdict ${rid} is about another finding (this one is ${it.merged_from.join(', ')})`)); continue; }
      const applied = info.get(rid)?.verify?.file || null;
      if (!applied) { refuse('severity', s, M(`у ${rid} нет вердикта скептика`, `${rid} has no skeptic verdict`)); continue; }
      if (file && file !== applied && !applied.split(' + ').includes(file)) { refuse('severity', s, M(`вердикт заменён: действует ${applied}`, `the verdict was superseded: ${applied} applies`)); continue; }
    }
    const floor = members(it).filter(m => V.sevRank(m.severity) < V.sevRank(s.to));
    if (floor.length) {
      const reason = m => arr(m.severity_trail).some(x => x.by === 'critic') ? M(`${m.id} ${m.severity} — повышение критика (необратимо)`, `${m.id} ${m.severity} — raised by the critic (final)`)
        : m.verify?.severity_after ? M(`${m.id} ${m.severity} — так решил скептик`, `${m.id} ${m.severity} — set by the skeptic`)
        : M(`${m.id} ${m.severity} — оценка линзы, скептик не понижал`, `${m.id} ${m.severity} — lens rating, not lowered by the skeptic`);
      refuse('severity', s, M(`понижать ${cur}→${s.to} может только скептик (merge.mjs уже применил его вердикты): ${floor.map(reason).join('; ')}`, `only the skeptic lowers ${cur}→${s.to} (merge.mjs already applied the verdicts): ${floor.map(reason).join('; ')}`));
      continue;
    }
    it.severity_trail.push({ by: 'editor', from: cur, to: s.to, why: short(why, 300), ref: s.verdict_ref ?? null });
    it.severity = s.to;
  }

  // 4. rewrites of text fields. title, problem, impact, scenario, evidence, before: no new numbers or quotes;
  //    evidence keeps at least one number or quote; before of copy/facts/seo-content stays site text (a cut of the
  //    old one or verbatim on the page); fix and after are proposals and are not checked.
  const hasFact = s => numbersOf(s).size > 0 || extractQuotes(s).length > 0 || /`[^`]+`/.test(String(s ?? ''));
  for (const [id, fields] of Object.entries(isObj(ed.rewrite) ? ed.rewrite : {})) {
    const h = resolveId(id);
    if (!h) { refuse('rewrite', { id }, rejectedIds.has(id) ? M(`${id} отклонена`, `${id} was rejected`) : M(`нет находки ${id}`, `no finding ${id}`)); continue; }
    if (h !== id) { refuse('rewrite', { id }, M(`${id} слита в ${h} — переписывайте ${h}`, `${id} is merged into ${h} — rewrite ${h}`)); continue; }
    if (!isObj(fields)) { refuse('rewrite', { id }, M('нужен объект полей', 'an object of fields is required')); continue; }
    const it = live.get(h);
    for (const [k, v] of Object.entries(fields)) {
      if (!V.REWRITE_FIELDS.includes(k)) { refuse('rewrite', { id, field: k }, M(`поле ${k} не переписывается (можно: ${V.REWRITE_FIELDS.join(', ')})`, `field ${k} cannot be rewritten (allowed: ${V.REWRITE_FIELDS.join(', ')})`)); continue; }
      if (typeof v !== 'string' || !v.trim()) { refuse('rewrite', { id, field: k }, M('нужна непустая строка', 'a non-empty string is required')); continue; }
      if (k === 'title' && [...v.trim()].length > 100) { refuse('rewrite', { id, field: k }, M(`title длиннее 100 знаков (${[...v.trim()].length})`, `title longer than 100 chars (${[...v.trim()].length})`)); continue; }
      const src = info.get(it.text_from || it.id) || it;
      if (k === 'before' && TEXT_LENSES.includes(src.lens)) {
        // site text: a cut of the old text, or verbatim on the finding's page (as lint checks it)
        const olds = members(it).map(m => m.before).filter(x => typeof x === 'string').map(normQ);
        const strip = s => s.replace(/`[^`]*`/g, ' ').replace(/^[\s«“"„]+|[\s»”"]+$/g, '').trim();
        const nb = strip(v);
        let ok = olds.some(o => o.includes(normQ(v.trim())) || (nb && o.includes(normQ(nb))));
        let where = '';
        if (!ok && nb.replace(/[\s.…]/g, '').length >= 3) {
          const pids = [...new Set(arr(it.where).map(pageOf).filter(Boolean))];
          const loc = locateQuote(texts(), nb, pids);
          ok = !!loc.found;
          if (loc.other) where = M(` (он есть на ${loc.other}, а находка про ${pids.join(', ') || '—'})`, ` (it is on ${loc.other}, but the finding is about ${pids.join(', ') || '—'})`);
        }
        if (!ok) { refuse('rewrite', { id, field: k }, M(`before у ${src.lens} — дословный текст страницы: новое значение не часть старого и не найдено на странице${where}; его можно только сократить`, `before of ${src.lens} is verbatim page text: the new value is not a part of the old one and is not on the page${where}; it may only be cut`)); continue; }
      } else if (CLAIM_FIELDS.includes(k)) {
        const bad = newClaims(v, it, k);
        if (bad) { refuse('rewrite', { id, field: k }, claimRefusal(k, bad)); continue; }
      }
      if (k === 'evidence' && hasFact(it.evidence) && !hasFact(v)) { refuse('rewrite', { id, field: k }, M('в evidence не осталось ни числа, ни цитаты, ни кода — доказательство можно сократить, но факт замера остаётся', 'no number, quote or code is left in evidence — it may be shortened, but the measured fact stays')); continue; }
      if (k === 'title' && !V.titlePlaceOk(v)) warnings.push(M(`${id}: в новом title нет ни цифры, ни места`, `${id}: the new title has neither a number nor a place`));
      (it.original ||= {})[k] ??= it[k] ?? null;
      it[k] = v.trim();
      if (k === 'title') it._title = it.title;
      it.rewritten = [...new Set([...arr(it.rewritten), k])];
    }
  }

  // 5. verdict to the final vocabulary
  for (const it of live.values()) {
    delete it._title;
    if (it.verdict === 'needs_device') { it.verdict = 'unverified'; it.verdict_detail = 'needs_device'; it.needs_device_check = true; }
    if (!['confirmed', 'adjusted', 'unverified'].includes(it.verdict)) it.verdict = 'unverified';
    it.requires_check = (it.verdict === 'unverified' && V.sevRank(it.severity) <= 1) || !!it.verdict_conflict
      || (it.verdict === 'unverified' && !!it.critic_wants && V.sevRank(it.critic_wants.to) <= 1);
    for (const m of members(it)) if (m.verdict === 'adjusted' && /^\s*evidence\s*:/i.test(m.verify?.note || '') && !arr(it.rewritten).includes('title'))
      warnings.push(M(`${it.id}: скептик поправил доказательство ${m.id} (note «${short(m.verify.note, 60)}»), а title не переписан — сверьте цифры в title${arr(it.rewritten).includes('evidence') ? '' : ' и evidence'}`, `${it.id}: the skeptic corrected the evidence of ${m.id} (note "${short(m.verify.note, 60)}") but the title is not rewritten — check its numbers${arr(it.rewritten).includes('evidence') ? '' : ' and the evidence'}`));
    if (it.fix_ok === false && !arr(it.rewritten).includes('fix')) warnings.push(M(`${it.id}: скептик забраковал правку (fix_ok=false), а редактор её не переписал`, `${it.id}: the skeptic rejected the fix (fix_ok=false) and the editor did not rewrite it`));
  }

  // 6. external audience: unverifiable items leave the report (to external-dropped.json)
  const externalDropped = [];
  const extIds = arr(ed.external_drop);
  const DROP_TEXT = { needs_device_check: M('нужна проверка на устройстве', 'needs a device check'), confidence_low: M('низкая уверенность', 'low confidence'),
    unverified: M('P0–P1 без проверки скептиком', 'P0–P1 without a skeptic check'), external_drop: M('решение редактора', 'editor decision') };
  if (audience === 'external') {
    for (const id of extIds) {
      const h = typeof id === 'string' ? resolveId(id) : null;
      if (!h) { if (!rejectedIds.has(id)) refuse('external_drop', { id }, M(`нет находки ${id}`, `no finding ${id}`)); continue; }
      const it = live.get(h);
      const hidden = members(it).filter(reportable);
      if (hidden.length) { refuse('external_drop', { id }, M(`в ${id} подтверждённая без проверки на устройстве: ${hidden.map(m => m.id).join(', ')} — из отчёта не убирается`, `${id} holds confirmed findings with no device check: ${hidden.map(m => m.id).join(', ')} — it stays`)); continue; }
      if (!it.needs_device_check && it.confidence !== 'low' && !extDropReason(it)) { refuse('external_drop', { id }, M(`external_drop — только для needs_device_check или confidence: low; у ${id} их нет`, `external_drop is only for needs_device_check or confidence: low; ${id} has neither`)); continue; }
      const why = extDropReason(it) || 'external_drop';
      externalDropped.push({ ...it, why, drop_reason: DROP_TEXT[why], by: 'editor' }); live.delete(h);
    }
    for (const [h, it] of [...live]) {
      const why = extDropReason(it);
      if (why) { externalDropped.push({ ...it, why, drop_reason: DROP_TEXT[why], by: 'finalize' }); live.delete(h); }
    }
  } else if (extIds.length) notes.push(M(`external_drop пропущен: аудитория ${audience}`, `external_drop ignored: audience is ${audience}`));

  // 7. boxes and crops
  let boxesConverted = 0;
  for (const it of [...live.values(), ...externalDropped]) boxesConverted += fixBoxes(run, it);

  // 8. order and rid
  const hint = new Map(arr(ed.order_hint).map((id, i) => [resolveId(id) || id, i]));
  const items = [...live.values()].sort((a, b) => V.sevRank(a.severity) - V.sevRank(b.severity)
    || (hint.get(a.id) ?? Infinity) - (hint.get(b.id) ?? Infinity) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  const perSev = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const it of items) it.rid = `${it.severity}-${String(++perSev[it.severity]).padStart(2, '0')}`;

  // 9. uid: from the previous findings.json of this run (by any merged id), else a new random one
  const prevUid = new Map();
  for (const p of [...arr(prev?.items), ...arr(prev?.external_dropped)]) if (isObj(p) && V.UID_RE.test(String(p.uid))) for (const id of arr(p.merged_from).length ? p.merged_from : [p.id]) if (!prevUid.has(id)) prevUid.set(id, p.uid);
  const used = new Set();
  const fresh = () => { let u; do u = 'R-' + randomBytes(4).toString('hex'); while (used.has(u)); return u; };
  for (const it of [...items, ...externalDropped]) {
    let u = null;
    for (const id of [it.id, ...it.merged_from]) { const c = prevUid.get(id); if (c && !used.has(c)) { u = c; break; } }
    it.uid = u || fresh();
    used.add(it.uid);
  }

  // 10. the check: confirmed|adjusted candidates are each in exactly one merged_from; nothing is lost silently;
  //     for external no reportable confirmed member is dropped
  const covered = new Map();
  for (const it of [...items, ...externalDropped]) for (const id of it.merged_from) covered.set(id, (covered.get(id) || 0) + 1);
  const droppedIds = new Set(dropped.flatMap(d => d.merged_from));
  const conf = [...info.values()].filter(x => CONFIRMED.has(x.verdict)).map(x => x.id);
  const check = {
    confirmed: conf.length,
    missing_confirmed: conf.filter(id => !covered.has(id)),
    duplicated: [...covered].filter(([, n]) => n > 1).map(([id]) => id),
    lost: [...info.keys()].filter(id => !covered.has(id) && !droppedIds.has(id)),
    external_hidden_confirmed: externalDropped.flatMap(x => members(x).filter(reportable).map(m => m.id)),
    // a merged finding shows text, verdict and flags of one member (the text source)
    mixed_text: items.filter(it => it.merged_from.length > 1).filter(it => {
      const m = info.get(it.text_from || it.id);
      return !m || m.confidence !== it.confidence || finalVerdict(m.verdict) !== it.verdict
        || (!!m.needs_device_check || m.verdict === 'needs_device') !== !!it.needs_device_check;
    }).map(it => it.id),
    // external: a shown finding never carries the text of a member the report could not show on its own
    external_unverifiable_text: audience === 'external' ? items.filter(it => {
      const m = info.get(it.text_from || it.id);
      return it.merged_from.length > 1 && m && !showableExternal(m, it.severity);
    }).map(it => it.id) : [],
  };
  check.ok = !check.missing_confirmed.length && !check.duplicated.length && !check.lost.length && !check.external_hidden_confirmed.length
    && !check.mixed_text.length && !check.external_unverifiable_text.length;

  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const it of items) counts[it.severity]++;
  counts.total = items.length;
  const extCounts = { total: externalDropped.length, unverified_p0_p1: externalDropped.filter(x => x.why === 'unverified').length,
    needs_device_check: externalDropped.filter(x => x.why === 'needs_device_check').length, confidence_low: externalDropped.filter(x => x.why === 'confidence_low').length,
    editor: externalDropped.filter(x => x.by === 'editor').length };
  return {
    findings: {
      tool: 'finalize', version: U.VERSION, run, generated: U.nowIso(), audience,
      counts, items, dropped, rejected: arr(cand.rejected),
      external_dropped: externalDropped.map(x => ({ id: x.id, uid: x.uid, merged_from: x.merged_from, title: x.title, severity: x.severity, why: x.why, drop_reason: x.drop_reason })),
      external_counts: audience === 'external' ? extCounts : null,
      refused, notes, warnings, check,
    },
    externalDropped, extCounts, boxesConverted,
  };
}

// ---------- CLI ----------
const HELP = `
finalize.mjs — report/candidates.json + report/editorial.json → report/findings.json.

  node finalize.mjs --run "<RUN>" [--audience owner|team|external] [--check] [--json] [--lang ru|en]

editorial.json (пишет редактор, только решения):
  merge [{ keep, absorb: [id…], title? }]   слияние только связанных: один кластер дублей, один элемент (selector),
                                            пересечение рамок, одна страница + одна категория, одна категория +
                                            похожие заголовки (одной общей страницы мало);
                                            важность, текст, вердикт, уверенность и флаги — у одного члена: самая высокая
                                            важность, при равной — лучший вердикт, потом keep (keep задаёт только id;
                                            свой заголовок — title); непроверенная не получает чужой вердикт,
                                            подтверждённая не прячется; в title — только числа и цитаты членов
  drop [{ id, why }]                        дубль: в why — id оставшейся находки, drop становится слиянием (те же правила
                                            связи, места и доказательство остаются в оставшейся); без дубля — только
                                            находка с ошибками схемы, не подтверждённая и не P0–P1 без вердикта
  severity [{ id, to, why, verdict_ref? }]  повышать можно всегда (taste — не выше P3); понижает только скептик
                                            (merge.mjs уже применил его вердикты), ниже уровня любого члена — отказ;
                                            повышение критика необратимо; verdict_ref — только на действующий вердикт
  rewrite { "<id>": { ${V.REWRITE_FIELDS.join(', ')} } }   title ≤ 100 знаков;
                                            title, problem, impact, scenario, evidence, before — без новых чисел и цитат
                                            (сверка с текстами членов и заметками скептика); evidence — с числом,
                                            цитатой или кодом; before у copy, facts, seo-content — только часть старого
                                            или дословный текст страницы; fix и after не сверяются
  order_hint [id…]                          порядок внутри одной важности
  external_drop [id…]                       только для --audience external и только needs_device_check / confidence: low;
                                            P0–P1 без проверки скептиком и «проверить на устройстве» уходят и без списка
Результат: rid (P0-01…) по важности, постоянный uid (R- + 8 hex; при повторном запуске сохраняется по id),
рамки с кусков кадров (box_space: image) переводятся в CSS px документа, у каждого места — crop { shot, box } для отчёта.
Для external снятое пишется в report/external-dropped.json (единственный писатель — этот скрипт).
Код 0 — готово; 4 — часть решений редактора не применена (refused): исправьте editorial.json и запустите снова,
findings.json всё равно записан по правилам; 2 — нет candidates.json или он старее файлов агентов (сначала merge.mjs);
1 — сбой или не прошла проверка «подтверждённое не выброшено» (в неё входит и «текст и вердикт — от одного члена»).
--check — только проверить editorial.json, ничего не записывать. --budget-sec принимается для единообразия (секунды).
`;

async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['check', 'json', 'help'] });
  U.helpAndExit(HELP, args);
  const lang = U.langOf(args);
  LANG = lang; V.setLang(lang); setLintLang(lang);
  if (!args.run || args.run === true) { console.error(U.msg('need_run', lang)); process.exit(2); }
  const run = resolve(String(args.run));
  const candPath = join(run, 'report', 'candidates.json');
  if (!existsSync(candPath)) { console.error(M('Нет report/candidates.json — сначала node merge.mjs --run "<RUN>".', 'report/candidates.json not found — run merge.mjs first.')); process.exit(2); }
  const cj = V.readJsonFile(candPath);
  if (!cj.ok || !isObj(cj.data) || !Array.isArray(cj.data.items)) { console.error(M(`report/candidates.json не читается: ${cj.error || 'нет items'} — перезапустите merge.mjs.`, `report/candidates.json is unreadable: ${cj.error || 'no items'} — re-run merge.mjs.`)); process.exit(2); }
  let candMt = 0; try { candMt = statSync(candPath).mtimeMs; } catch {}
  const stale = staleInputs(run, candMt);
  if (stale.length || cj.data.partial) {
    U.printAndSaveSummary(run, 'finalize', [M(`report/candidates.json устарел: после merge.mjs изменились ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ` и ещё ${stale.length - 5}` : ''}${cj.data.partial ? ' (свод частичный)' : ''}.`, `report/candidates.json is stale: ${stale.slice(0, 5).join(', ')}${stale.length > 5 ? ` and ${stale.length - 5} more` : ''} changed after merge.mjs${cj.data.partial ? ' (partial merge)' : ''}.`),
      M('Сначала node merge.mjs --run "<RUN>", затем finalize снова. findings.json не записан.', 'Run merge.mjs first, then finalize again. findings.json was not written.')]);
    process.exit(2);
  }
  const edPath = join(run, 'report', 'editorial.json');
  let ed = {}, edNote = null, edErrors = [];
  if (existsSync(edPath)) {
    const ej = V.readJsonFile(edPath);
    if (!ej.ok) { U.printAndSaveSummary(run, 'finalize', [M(`report/editorial.json: ${ej.error}`, `report/editorial.json: ${ej.error}`), M('Исправьте файл и запустите снова (код 4). findings.json не записан.', 'Fix the file and run again (exit 4). findings.json was not written.')]); process.exit(4); }
    ed = isObj(ej.data) ? ej.data : {};
    edErrors = V.checkEditorialDoc(ej.data, { file: 'report/editorial.json' }).errors;
    if (!isObj(ej.data)) edErrors.push({ path: '', msg: M('ожидается объект — решения не применены', 'an object is expected — no decisions applied') });
  } else edNote = M('editorial.json нет — свод без решений редактора', 'no editorial.json — finalising without editor decisions');
  const brief = U.readJSON(join(run, 'brief.json'), null) || {};
  const state = U.readJSON(join(run, 'state.json'), null) || {};
  const audience = ['owner', 'team', 'external'].includes(args.audience) ? args.audience : (brief.audience || state.flags?.audience || 'owner');
  const outPath = U.insideRun(run, 'report', 'findings.json');
  const prev = U.readJSON(outPath, null);
  const { findings, externalDropped, extCounts, boxesConverted } = finalize(run, cj.data, ed, { audience, prev });

  if (!args.check) {
    U.writeJSON(outPath, findings);
    const extPath = U.insideRun(run, 'report', 'external-dropped.json');
    if (audience === 'external') U.writeJSON(extPath, { tool: 'finalize', version: U.VERSION, generated: findings.generated, counts: extCounts,
      items: externalDropped.map(x => ({ ...x, rid: null })) });
    else if (existsSync(extPath)) rmSync(extPath, { force: true });
    U.log(run, `finalize.mjs: ${findings.counts.total} находок (P0 ${findings.counts.P0}, P1 ${findings.counts.P1}, P2 ${findings.counts.P2}, P3 ${findings.counts.P3}), отказано решений ${findings.refused.length}, проверка ${findings.check.ok ? 'ok' : 'НЕ ПРОШЛА'}`);
  }
  const code = !findings.check.ok ? 1 : (findings.refused.length || edErrors.length) ? 4 : 0;
  if (args.json) { process.stdout.write(JSON.stringify({ counts: findings.counts, refused: findings.refused, check: findings.check, warnings: findings.warnings, external: findings.external_counts }, null, 2) + '\n'); process.exit(code); }
  const c = findings.counts, ch = findings.check;
  const mergesApplied = findings.items.filter(i => i.merged_from.length > 1).length;
  const lines = [
    `finalize${args.check ? M(' (проверка, без записи)', ' (check only, nothing written)') : ''} · ${M('аудитория', 'audience')} ${audience} · ${M('находок', 'findings')} ${c.total}: P0 ${c.P0} · P1 ${c.P1} · P2 ${c.P2} · P3 ${c.P3}`,
    `${M('Слияний', 'Merges')} ${mergesApplied} · ${M('снято drop', 'dropped')} ${findings.dropped.length} · ${M('переписано', 'rewritten')} ${findings.items.filter(i => i.rewritten?.length).length} · ${M('рамок пересчитано с кадров', 'boxes converted from frames')} ${boxesConverted}`,
  ];
  if (audience === 'external') lines.push(M(`Снято для external: ${extCounts.total} — P0–P1 без проверки: ${extCounts.unverified_p0_p1} · проверить на устройстве: ${extCounts.needs_device_check} · низкая уверенность: ${extCounts.confidence_low}${extCounts.editor ? ` (по списку редактора ${extCounts.editor})` : ''} → report/external-dropped.json`,
    `Removed for external: ${extCounts.total} — P0–P1 without a check: ${extCounts.unverified_p0_p1} · device check: ${extCounts.needs_device_check} · low confidence: ${extCounts.confidence_low}${extCounts.editor ? ` (editor list ${extCounts.editor})` : ''} → report/external-dropped.json`));
  lines.push(`${M('Проверка «подтверждённое не выброшено»', 'Check "nothing confirmed is lost"')}: ${ch.ok ? 'ok' : M('НЕ ПРОШЛА', 'FAILED')} (confirmed|adjusted ${ch.confirmed}${ch.missing_confirmed.length ? `, ${M('потеряны', 'missing')}: ${ch.missing_confirmed.join(', ')}` : ''}${ch.duplicated.length ? `, ${M('в двух местах', 'twice')}: ${ch.duplicated.join(', ')}` : ''}${ch.lost.length ? `, ${M('пропали', 'lost')}: ${ch.lost.join(', ')}` : ''}${ch.external_hidden_confirmed.length ? `, ${M('спрятаны от external', 'hidden from external')}: ${ch.external_hidden_confirmed.join(', ')}` : ''}${ch.mixed_text.length ? `, ${M('текст и вердикт от разных членов', 'text and verdict of different members')}: ${ch.mixed_text.join(', ')}` : ''}${ch.external_unverifiable_text.length ? `, ${M('для external текст непроверяемого члена', 'external shows the text of an unverifiable member')}: ${ch.external_unverifiable_text.join(', ')}` : ''})`);
  if (edNote) lines.push(edNote);
  for (const e of edErrors.slice(0, 5)) lines.push(`  editorial ${e.path}: ${e.msg}`);
  if (edErrors.length > 5) lines.push(M(`  … и ещё ${edErrors.length - 5} ошибок editorial.json (validate.mjs --file покажет все)`, `  … and ${edErrors.length - 5} more editorial.json errors (validate.mjs --file shows all)`));
  if (findings.refused.length) {
    lines.push(M(`Не применено решений редактора: ${findings.refused.length} (код 4) — исправьте editorial.json и запустите снова:`, `Editor decisions refused: ${findings.refused.length} (exit 4) — fix editorial.json and run again:`));
    for (const r of findings.refused.slice(0, 12)) lines.push(`  ${r.op} ${short(JSON.stringify(r.entry), 70)} — ${r.why}`);
    if (findings.refused.length > 12) lines.push(M(`  … и ещё ${findings.refused.length - 12} — все в report/findings.json → refused`, `  … and ${findings.refused.length - 12} more — see report/findings.json → refused`));
  }
  for (const w of findings.warnings.slice(0, 5)) lines.push(`  ${M('внимание', 'note')}: ${w}`);
  if (findings.warnings.length > 5) lines.push(M(`  … и ещё ${findings.warnings.length - 5} предупреждений (report/findings.json → warnings)`, `  … and ${findings.warnings.length - 5} more warnings (report/findings.json → warnings)`));
  for (const n of findings.notes.slice(0, 4)) lines.push(`  ${n}`);
  const rc = findings.items.filter(i => i.requires_check).length;
  if (rc) lines.push(M(`Требуют проверки (P0–P1 без вердикта, спор вердиктов): ${rc} — в отчёте с пометкой «требует проверки»`, `Need checking (P0–P1 without a verdict, conflicting verdicts): ${rc} — marked in the report`));
  for (const it of findings.items.slice(0, 4)) lines.push(`  ${it.rid} ${it.uid} · ${short(it.title, 80)}${it.merged_from.length > 1 ? ` (${it.merged_from.join('+')})` : ''}`);
  if (!args.check) lines.push(`→ report/findings.json${audience === 'external' ? ' · report/external-dropped.json' : ''}`);
  U.printAndSaveSummary(run, 'finalize', lines);
  process.exit(code);
}

const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
