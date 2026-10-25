#!/usr/bin/env node
// Revizor — lint-findings.mjs: the script layer of finding checks (format: knowledge/findings-format.md).
// Per finding: schema (validate.mjs), places on snapshot pages, shot exists, box inside the frame (JPEG header size,
// box_space aware), every «quote» in evidence is verbatim on THAT page (text.md / raw.html / dom.html; ё→е, quotes,
// dashes, nbsp, case), `before` of text lenses is on the page, tone stop-words (knowledge/tone.md «Запрещено»).
// --cards: competitor cards (rivals/<host>/card.json). Writes verify/<lens>.lint.json (or verify/cards.lint.json).
// The skeptic reads it first; merge.mjs uses it as a gate (and lints the skeptic's own additions with lintFinding).

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as U from './lib/util.mjs';
import { imageSize } from './lib/img.mjs';
import * as V from './validate.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let LANG = 'ru';
export function setLang(l) { LANG = l === 'en' ? 'en' : 'ru'; V.setLang(LANG); }
const M = (ru, en) => (LANG === 'en' ? en : ru);

// Codes that keep a finding out of the report until the skeptic confirms it (merge.mjs).
export const BLOCKING_CODES = ['quote_not_found', 'quote_other_page', 'before_not_found', 'no_known_place', 'schema_fatal'];
// Codes merge.mjs repairs by dropping the broken reference (the finding stays).
export const REPAIRABLE_CODES = ['shot_missing', 'shot_outside_run', 'box_not_in_shot', 'box_out_of_bounds', 'pid_unknown'];
// Lenses whose `before` is site text: it must be on the page verbatim.
export const TEXT_LENSES = ['copy', 'facts', 'seo-content'];
// Bump when the checks change: older verify/<lens>.lint.json files are then recomputed.
export const LINT_REV = 5;
// Bump when the word index (normalisation, hashing) changes: verify/lint-index/ is then rebuilt.
const INDEX_REV = 2;

// ---------- text normalisation for quote matching ----------
export function normQ(s) { // the same result as util.normText after the extra rules below, in fewer passes
  return String(s ?? '')
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\*\*|__/g, '')
    .replace(/\u2026/g, '...')
    .toLowerCase()
    .replace(/\u0451/g, '\u0435')
    .replace(/[\u2019\u2018\u201A\u201B\u00B4\u00AB\u00BB\u201E\u201C\u201D"']/g, '"')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\s\u00A0\u202F\u2011]+/g, ' ')
    .trim();
}
const ENT = { nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", hellip: '…',
  rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', bdquo: '„', sbquo: '‚', thinsp: ' ', ensp: ' ', emsp: ' ', shy: '', times: '×', minus: '−',
  copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•', rarr: '→', larr: '←', numero: '№', euro: '€', rub: '₽' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch { return m; } }
    const v = ENT[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}
// Text search only (not structure): strip scripts/styles/tags so a quote split by inline tags still matches.
function htmlText(html, sep) {
  return decodeEntities(String(html).replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<br\s*\/?>/gi, ' ').replace(/<\/?(p|div|li|ul|ol|h[1-6]|section|article|header|footer|nav|main|tr|td|th|table|option|button|label)\b[^>]*>/gi, ' ').replace(/<[^>]+>/g, sep));
}
function collectStrings(v, out, budget = { n: 0 }) {
  if (budget.n > 4e6) return out;
  if (typeof v === 'string') { out.push(v); budget.n += v.length; }
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out, budget);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) collectStrings(x, out, budget);
  return out;
}
const readText = p => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
const pageUrlKey = u => { try { const x = new URL(String(u)); return (x.host + x.pathname).replace(/\/+$/, '').toLowerCase(); } catch { return ''; } };

// ---------- word index: a quote can only be in a text that has all of its whole words ----------
// Word characters: a fast path for ASCII, Latin-1/Extended and Cyrillic, a regexp for the rest. Any definition works
// as long as pages and quotes use the same one: an inner word of a quote found in a text is a whole word there too.
// Words are kept as 30-bit FNV-1a hashes (small integers for V8): a collision only lets a text through to the exact substring check.
const WORD_RE = /[\p{L}\p{N}]/u;
const wordCache = new Map();
function slowWord(c) {
  let v = wordCache.get(c);
  if (v === undefined) { v = WORD_RE.test(String.fromCharCode(c)); wordCache.set(c, v); }
  return v;
}
const isWordCode = c => (c < 128 ? (c >= 48 && c <= 57) || (c >= 97 && c <= 122) || (c >= 65 && c <= 90)
  : (c >= 0x400 && c <= 0x52F) || (c >= 0xC0 && c <= 0x24F && c !== 0xD7 && c !== 0xF7) || (c > 0x24F && slowWord(c)));
// Pairs of neighbouring words are indexed too, so a retelling with the page's words in another order is cut by the
// index without loading the text. The first and the last word of a quote may be cut mid-word: the first one is the end
// of a page word, the last one is its beginning. So pairs are kept in four kinds: word+word, word+first 3 letters of the
// next, last 3 letters+next word, last 3+first 3. A collision only lets a text through to the exact check.
const pairHash = (k, a, b) => (Math.imul(a ^ Math.imul(k, 0x27D4EB2D) ^ 0x5bd1e995, 0x9E3779B1) ^ Math.imul(b + 0x7F4A7C15, 0x85EBCA77)) & 0x3fffffff;
const fnv3 = (a, b, c) => Math.imul(Math.imul(Math.imul(0x811c9dc5 ^ a, 16777619) ^ b, 16777619) ^ c, 16777619) & 0x3fffffff;
/** Calls fn(hash, length, first3, last3) for every word of s (first3/last3: hashes of 3 letters, -1 for shorter words). */
function scanWords(s, fn) {
  let h = 0x811c9dc5, len = 0, p3 = -1, c1 = 0, c2 = 0, c3 = 0;
  for (let i = 0, n = s.length; i < n; i++) {
    const c = s.charCodeAt(i);
    const w = c < 128 ? (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || (c >= 65 && c <= 90) : (c >= 0x400 && c <= 0x52F) || isWordCode(c);
    if (w) { h = Math.imul(h ^ c, 16777619); c1 = c2; c2 = c3; c3 = c; if (++len === 3) p3 = h & 0x3fffffff; }
    else if (len) { fn(h & 0x3fffffff, len, p3, len >= 3 ? fnv3(c1, c2, c3) : -1); h = 0x811c9dc5; len = 0; p3 = -1; }
  }
  if (len) fn(h & 0x3fffffff, len, p3, len >= 3 ? fnv3(c1, c2, c3) : -1);
}
/** Index of a text: a Set of word hashes and of the four kinds of neighbour pairs. */
function wordHashes(s, out = new Set()) {
  let px = -1, ps3 = -1;
  scanWords(s, (x, len, p3, s3) => {
    out.add(x);
    if (px !== -1) {
      out.add(pairHash(0, px, x));
      if (p3 !== -1) out.add(pairHash(1, px, p3));
      if (ps3 !== -1) { out.add(pairHash(2, ps3, x)); if (p3 !== -1) out.add(pairHash(3, ps3, p3)); }
    }
    px = x; ps3 = s3;
  });
  return out;
}
/** What a text must have to contain this normalised fragment: whole words and pairs (a cut first/last word counts
 *  by its 3 letters at the cut side; inner words of a fragment found in a text are whole and neighbours there too). */
function needWords(frag) {
  const ws = [];
  scanWords(frag, (x, len, p3, s3) => ws.push({ x, len, p3, s3 }));
  const n = ws.length;
  const cutFirst = !!frag && isWordCode(frag.charCodeAt(0)), cutLast = !!frag && isWordCode(frag.charCodeAt(frag.length - 1));
  const whole = i => !((i === 0 && cutFirst) || (i === n - 1 && cutLast));
  const need = [];
  for (let i = 0; i < n; i++) if (whole(i)) need.push(ws[i].x);
  for (let i = 1; i < n; i++) {
    const a = ws[i - 1], b = ws[i], aw = whole(i - 1), bw = whole(i);
    if (aw && bw) need.push(pairHash(0, a.x, b.x));
    else if (aw) { if (b.p3 !== -1) need.push(pairHash(1, a.x, b.p3)); }
    else if (bw) { if (a.s3 !== -1) need.push(pairHash(2, a.s3, b.x)); }
    else if (a.s3 !== -1 && b.p3 !== -1) need.push(pairHash(3, a.s3, b.p3));
  }
  return need;
}
// Texts without spaces are indexed by 3-character pieces instead: every piece of a quote must be in the text.
const gram = (s, i) => (Math.imul(Math.imul(s.charCodeAt(i), 0x9E3779B1) ^ s.charCodeAt(i + 1), 0x85EBCA77) ^ s.charCodeAt(i + 2)) & 0x3fffffff;
function gramHashes(s, out) {
  const add = out instanceof Set ? x => out.add(x) : x => out.push(x);
  for (let i = 0, n = s.length - 2; i < n; i++) add(gram(s, i));
  return out;
}
/** A normalised quote → { frags, needs } (parts around «…» must all be in one text). */
export function quoteFragments(q) {
  const frags = String(q).split(/\s*(?:…|\.\.\.)\s*|\n+/).map(normQ).filter(f => f.length >= 2);
  return { frags, needs: frags.map(needWords) };
}
/** The same quote with spaces removed (for texts where the HTML glued or split words around inline tags). */
function spaceless(qf) {
  if (!qf.ns) { const frags = qf.frags.map(f => f.replace(/ /g, '')).filter(f => f.length >= 2); qf.ns = { frags, needs: frags.map(f => [...new Set(gramHashes(f, []))]) }; }
  return qf.ns;
}

/** A built index: sorted 30-bit hashes in an Int32Array (4 bytes per entry; a Set would take ~30). */
class HashIndex {
  constructor(arr) { this.arr = arr; }
  static from(set) { return new HashIndex(Int32Array.from(set).sort()); }
  has(x) {
    const a = this.arr;
    let lo = 0, hi = a.length - 1;
    while (lo <= hi) { const mid = (lo + hi) >>> 1, v = a[mid]; if (v === x) return true; if (v < x) lo = mid + 1; else hi = mid - 1; }
    return false;
  }
}

export class LintTimeout extends Error { constructor() { super('lint deadline'); this.name = 'LintTimeout'; } }
// Texts are kept in a small LRU (by characters); word sets stay. A text is re-read only when its word set matches.
class TextStore {
  constructor(budget) { this.budget = budget; this.used = 0; this.lru = new Map(); this.deadline = 0; }
  put(src, t) {
    if (this.lru.has(src)) { this.used -= this.lru.get(src); this.lru.delete(src); }
    src.text = t; this.lru.set(src, t.length); this.used += t.length;
    for (const [old, n] of this.lru) {
      if (this.used <= this.budget || old === src) break;
      this.lru.delete(old); this.used -= n; old.text = null;
    }
  }
  touch(src) { if (this.lru.has(src)) { const n = this.lru.get(src); this.lru.delete(src); this.lru.set(src, n); } }
}
/** One text of a page with its index. nospace: the text without spaces, compared with a spaceless quote. */
class Src {
  constructor(name, load, store, { nospace = false } = {}) {
    this.name = name; this.load = load; this.store = store; this.nospace = nospace;
    this.words = null; this.text = null; this.len = -1;
  }
  getText() {
    if (this.text !== null) { this.store.touch(this); return this.text; }
    if (this.len === 0) return '';
    if (this.store.deadline && Date.now() > this.store.deadline) throw new LintTimeout();
    const t = this.load() || '';
    this.len = t.length;
    if (!this.words) { this.words = HashIndex.from(this.nospace ? gramHashes(t, new Set()) : wordHashes(t, new Set())); this.dirty = true; }
    if (t) this.store.put(this, t);
    return t;
  }
  ensure() { if (!this.words) this.getText(); }
  has(qf) {
    this.ensure();
    if (!this.len) return false;
    const { frags, needs } = this.nospace ? spaceless(qf) : qf;
    if (!frags.length) return false;
    for (const n of needs) for (const w of n) if (!this.words.has(w)) return false;
    const t = this.getText();
    return frags.every(f => t.includes(f));
  }
}

/** Page text sources of one RUN, loaded lazily. Primary (indexed): text.md and visible text of raw/dom.html;
 *  secondary (own pages only): the same text without spaces, HTML source (alt, aria-label, meta, JSON-LD), page.json. */
export class PageTexts {
  /** writeCache: keep word indexes in verify/lint-index/ so a repeated call (after code 75) does not rebuild them. */
  constructor(run, { budgetChars = 16e6, writeCache = false } = {}) {
    this.run = run; this.pages = new Map(); this.store = new TextStore(budgetChars); this._measure = null; this._pids = null; this.writeCache = writeCache;
  }
  /** Loading a text after `ms` (epoch) throws LintTimeout; 0 — no limit. */
  setDeadline(ms) { this.store.deadline = ms || 0; }
  cacheKey(p) {
    if (!p.dir) return null;
    const st = f => { try { const s = statSync(join(p.dir, f)); return `${s.size}:${Math.round(s.mtimeMs)}`; } catch { return '-'; } };
    return [`rev${LINT_REV}.${INDEX_REV}`, ...['text.md', 'raw.html', 'dom.html', 'page.json'].map(st)].join('|');
  }
  cachePath(...parts) { return U.insideRun(this.run, 'verify', 'lint-index', ...parts); }
  loadCache(pid, p) {
    try {
      const meta = U.readJSON(this.cachePath(`${pid}.json`), null);
      if (!meta || meta.key !== this.cacheKey(p)) return;
      const apply = (list, entries) => entries.forEach((e, k) => {
        const s = list[k];
        if (!s || !e || s.name !== e.name || !e.file) return;
        const b = readFileSync(this.cachePath(e.file));
        s.words = new HashIndex(new Int32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)).sort());
        s.len = e.len;
      });
      if (meta.dedup) p.primary.pop();
      p.deduped = true;
      apply(p.primary, meta.primary || []);
      if (Array.isArray(meta.secondary)) { p.secondary = p.makeSecondary(); apply(p.secondary, meta.secondary); }
    } catch { /* a broken cache is rebuilt */ }
  }
  /** Write new word indexes (only with writeCache). */
  flush() {
    if (!this.writeCache) return;
    for (const [pid, p] of this.pages) {
      const all = [...p.primary, ...(p.secondary || [])];
      if (!p.deduped || !all.some(s => s.dirty)) continue;
      try {
        U.ensureDir(this.cachePath());
        const save = (s, k, kind) => {
          if (!s.words) return { name: s.name };
          const file = `${pid}.${kind}${k}.bin`;
          if (s.dirty) { writeFileSync(this.cachePath(file), Buffer.from(s.words.arr.buffer, s.words.arr.byteOffset, s.words.arr.byteLength)); s.dirty = false; }
          return { name: s.name, len: s.len, file };
        };
        U.writeJSON(this.cachePath(`${pid}.json`), { key: this.cacheKey(p), dedup: p.primary.length === 2,
          primary: p.primary.map((s, k) => save(s, k, 'p')), secondary: p.secondary ? p.secondary.map((s, k) => save(s, k, 's')) : null });
      } catch { /* the cache is a convenience */ }
    }
  }
  pids() {
    if (this._pids) return this._pids;
    const set = new Set();
    const pj = U.readJSON(join(this.run, 'pages.json'), null);
    for (const s of Array.isArray(pj?.selected) ? pj.selected : []) if (s?.pid) set.add(String(s.pid));
    try { for (const d of readdirSync(join(this.run, 'snapshot'))) { try { if (statSync(join(this.run, 'snapshot', d)).isDirectory()) set.add(d); } catch {} } } catch {}
    this._pids = [...set];
    const sel = (Array.isArray(pj?.selected) ? pj.selected : []).filter(s => s?.pid);
    this.urls = new Map(sel.map(s => [String(s.pid), s.final_url || s.url]));
    this.urlPids = new Map();
    for (const s of sel) for (const u of [s.url, s.final_url]) { const k = pageUrlKey(u); if (k && !this.urlPids.has(k)) this.urlPids.set(k, String(s.pid)); }
    return this._pids;
  }
  /** pid of a page url from pages.json (url or final_url; scheme, query and the trailing slash ignored) → pid | null */
  pidOfUrl(u) { this.pids(); const k = pageUrlKey(u); return (k && this.urlPids.get(k)) || null; }
  page(pid) {
    let p = this.pages.get(pid);
    if (p) return p;
    let dir = null;
    try { dir = U.insideRun(this.run, 'snapshot', String(pid)); } catch { /* bad pid */ }
    const S = (name, load, o) => new Src(name, dir ? load : () => '', this.store, o);
    const html = f => () => { const h = readText(join(dir, f)); return h ? normQ(htmlText(h, ' ')) : ''; };
    const code = f => () => { const h = readText(join(dir, f)); return h ? normQ(decodeEntities(h)) : ''; };
    const md = () => { const t = readText(join(dir, 'text.md')); return t ? normQ(t) : ''; };
    const primary = [S('text.md', md), S('raw.html', html('raw.html')), S('dom.html', html('dom.html'))];
    p = { dir, primary, secondary: null, deduped: false,
      makeSecondary: () => [
        ...p.primary.slice(1).map(s => S(s.name, () => s.getText().replace(/ /g, ''), { nospace: true })),
        S(`raw.html (${M('код', 'source')})`, code('raw.html')),
        // dom.html with the same visible text as raw.html: its attributes are the same too, skip the second source
        ...(p.primary.length === 3 ? [S(`dom.html (${M('код', 'source')})`, code('dom.html'))] : []),
        S('page.json', () => { const j = dir ? U.readJSON(join(dir, 'page.json'), null) : null; return j ? normQ(collectStrings(j, []).join('\n')) : ''; })] };
    this.pages.set(pid, p);
    if (dir) this.loadCache(pid, p);
    return p;
  }
  primary(pid) {
    const p = this.page(pid);
    if (!p.deduped) { // dom.html often repeats raw.html word for word
      p.deduped = true;
      const [, a, b] = p.primary;
      const ta = a.getText(), tb = b.getText();
      if (ta && ta.length === tb.length && ta === tb) p.primary.pop();
    }
    return p.primary;
  }
  secondary(pid) { const p = this.page(pid); this.primary(pid); return (p.secondary ||= p.makeSecondary()); }
  measureSrc() {
    if (this._measure) return this._measure;
    this._measure = new Src('measure', () => {
      const parts = []; let total = 0;
      try {
        for (const f of readdirSync(join(this.run, 'measure')).sort()) {
          if (!f.endsWith('.json') || total > 40e6) continue;
          const d = U.readJSON(join(this.run, 'measure', f), null);
          if (!d) continue;
          const s = collectStrings(d, []).join('\n');
          total += s.length; parts.push(s);
        }
      } catch { /* no measure folder */ }
      return normQ(parts.join('\n'));
    }, this.store);
    return this._measure;
  }
  /** Where on page `pid` is the quote: → source name or null. */
  findOn(pid, qf, { secondary = true } = {}) {
    for (const s of this.primary(pid)) if (s.has(qf)) return s.name;
    if (secondary) for (const s of this.secondary(pid)) if (s.has(qf)) return s.name;
    return null;
  }
}

/** «…» quotes of an evidence string (backticked code is ignored; “…” only when there are no «…»). */
export function extractQuotes(evidence) {
  const s = String(evidence || '').replace(/`[^`]*`/g, ' ');
  let qs = [...s.matchAll(/«([^«»]{1,600})»/g)].map(m => m[1]);
  if (!qs.length) qs = [...s.matchAll(/“([^“”]{1,600})”/g)].map(m => m[1]);
  // pattern names like «не X, а Y» or «от N ₽» are not site text (short ones only: a long «quote» with N is checked)
  return qs.map(q => q.trim()).filter(q => q.replace(/[\s.…]/g, '').length >= 3 && !(/(?:^|\s)[XYZN](?=$|[\s,.;:!?])/u.test(q) && U.words(q).length <= 5));
}
/** Our own text without site quotes and code (tone checks skip them). */
export function stripQuoted(s) {
  return String(s ?? '').replace(/«[^«»]*»/g, ' ').replace(/“[^“”]*”/g, ' ').replace(/„[^„“”]*[“”]/g, ' ').replace(/"[^"\n]*"/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ');
}

/** Where is a quote: on one of `pids`, in measurements, or on another page. */
export function locateQuote(texts, q, pids) {
  const qf = quoteFragments(q);
  if (!qf.frags.length) return { skip: true };
  const known = texts.pids();
  const own = pids.filter(p => known.includes(p));
  const scope = own.length ? own : known; // place without a snapshot page → the whole site
  for (const pid of scope) { const n = texts.findOn(pid, qf); if (n) return { found: n, pid }; }
  // text of another page beats measurements (they repeat page texts): a quote from a foreign page is an error
  if (own.length) for (const pid of known) if (!own.includes(pid) && texts.findOn(pid, qf, { secondary: false })) return { other: pid };
  if (texts.measureSrc().has(qf)) return { found: 'measure', pid: null }; // console errors, headers, robots…
  return { found: null };
}

// ---------- tone stop-words ----------
const BUILTIN_STOP = {
  all: ['возможно', 'наверное', 'вероятно', 'по-видимому', 'по всей видимости', 'кажется,', 'стоит рассмотреть', 'можно рассмотреть',
    'рекомендуется рассмотреть', 'можно улучшить', 'имеет смысл', 'желательно бы', 'не исключено', 'как бы', 'очевидно', 'грубая ошибка',
    'ужасн*', 'кошмар*', 'позор*', 'безобразн*', 'отвратительн*', 'катастрофическ*', 'является', 'являются', 'важно отметить',
    'стоит отметить', 'позволяет', 'позволяют', 're:данн(ый|ая|ое|ого|ой|ом|ых|ую)',
    '/(?<![\\p{L}])ключев(?:ой|ая|ое|ого|ом|ому|ую|ые|ых|ым|ыми)(?![\\p{L}])(?!\\s+(?:ставк|слов|запрос|фраз))/iu',
    'maybe', 'perhaps', 'probably', 'it seems', 'consider', 'might want to', 'could be improved', 'obviously', 'terrible', 'awful',
    'horrible', 'leverage', 'utilize', 'seamless', 'robust', 'delve', 'crucial', 'it is important to note'],
  owner: [], team: [],
  external: ['ревизор*', 'revizor', 'claude', '/(?<![\\p{L}-])агент(?:а|у|ом|е|ы|ов|ам|ами|ах)?(?![\\p{L}-])/iu', 'нейросет*', 'не проверено',
    'не удалось проверить', 'not checked', '/(?<![\\p{L}-])agents?(?![\\p{L}-])/iu'],
};
/** Lists from tone.md text: { all, owner, team, external } or null (JSON block first, else the list under «Запрещено»). */
export function parseStopList(t) {
  if (!t) return null;
  const j = U.knowledgeBlock(t, 'forbidden');
  if (j) return j;
  const sec = t.split(/\n(?=#{1,4}\s)/).find(s => /^#{1,4}\s[^\n]*запрещено/i.test(s.trim()));
  if (!sec) return null;
  const words = [...sec.matchAll(/^\s*[-*]\s+(.+)$/gm)].flatMap(x => x[1].replace(/\s+[—–]\s.*$/, '').split(/[,;]/))
    .map(w => w.replace(/[`«»"]/g, '').trim()).filter(w => w && w.length < 40);
  return words.length ? { all: words } : null;
}
export function loadStopWords(audience = 'owner') {
  const parsed = parseStopList(readText(join(PLUGIN_ROOT, 'knowledge', 'tone.md')));
  const lists = parsed || BUILTIN_STOP, src = parsed ? 'tone.md' : 'builtin';
  const arr = v => (Array.isArray(v) ? v : []);
  const terms = [...new Map([...arr(lists.all), ...arr(lists[audience])].map(e => [JSON.stringify(e), e])).values()];
  return { src, list: terms.map(e => { const x = U.compileStopTerm(e); return x && { term: x.label, re: x.re, hint: e && typeof e === 'object' && typeof e.hint === 'string' ? e.hint : null }; }).filter(Boolean) };
}
/** Stop-terms in our own text → ["«matched words»" (hint)…]: the words to remove, never the raw pattern. */
function toneHits(stop, text) {
  const s = stripQuoted(text);
  if (!s.trim()) return [];
  const out = [];
  for (const x of stop.list) {
    x.re.lastIndex = 0;
    const m = s.match(new RegExp(x.re.source, x.re.flags.replace('g', '')));
    if (!m) continue;
    const frag = m[0].replace(/\s+/g, ' ').trim();
    const shown = `«${frag.length > 40 ? frag.slice(0, 39) + '…' : frag}»`;
    out.push(x.hint ? `${shown} (${x.hint})` : shown);
  }
  return [...new Set(out)];
}

// ---------- files ----------
/** findings files grouped by lens: { lens: [{ name, abs, round, part, mtime }] } */
export function lensFiles(run) {
  const dir = join(run, 'findings');
  const out = {};
  let names = [];
  try { names = readdirSync(dir).filter(f => f.endsWith('.json')).sort(); } catch { return out; }
  for (const name of names) {
    const pn = V.parseLensFileName(name);
    const abs = join(dir, name);
    let mtime = 0; try { mtime = statSync(abs).mtimeMs; } catch {}
    const lens = pn ? pn.lens : name.replace(/\.json$/, '');
    (out[lens] ||= []).push({ name, rel: `findings/${name}`, abs, round: pn?.round || 1, part: pn?.part || 0, mtime, badName: !pn });
  }
  for (const l of Object.keys(out)) out[l].sort((a, b) => a.round - b.round || a.part - b.part);
  return out;
}

// ---------- lint of one finding ----------
const tol = n => Math.max(4, Math.round(n * 0.01));
function boxIssue(box, w, h) {
  const [x, y, bw, bh] = box;
  if (x >= w || y >= h || x + bw <= 0 || y + bh <= 0) return 'outside';
  if (x < -tol(w) || y < -tol(h) || x + bw > w + tol(w) || y + bh > h + tol(h)) return 'over';
  return null;
}
const sizeCache = new Map();
function frameSize(abs) {
  let mt = 0; try { mt = statSync(abs).mtimeMs; } catch { return null; }
  const c = sizeCache.get(abs);
  if (c && c.mt === mt) return c.size;
  let size = null; try { size = imageSize(abs); } catch { size = null; }
  sizeCache.set(abs, { mt, size });
  return size;
}
const shortQ = q => (q.length > 80 ? q.slice(0, 77) + '…' : q);

/**
 * lintFinding(run, fd, { texts, stop, lens, file, schema }) → { id, file, severity, errors, warnings, quotes, blocking }
 * Checks of one finding without the schema (pass schema: { errors, warnings } from validate to merge them in).
 */
export function lintFinding(run, fd, opts = {}) {
  const texts = opts.texts || new PageTexts(run);
  const stop = opts.stop || loadStopWords('owner');
  const lens = opts.lens || null;
  const item = { id: fd?.id ?? '#?', file: opts.file || null, severity: fd?.severity ?? null, errors: [], warnings: [], quotes: [] };
  const E = (code, field, msg) => item.errors.push({ code, field, msg });
  const W = (code, field, msg) => item.warnings.push({ code, field, msg });
  const strip = p => String(p).replace(/^(findings|added_by_verifier)\[\d+\]( \([^)]*\))?\.?/, '');
  for (const e of opts.schema?.errors || []) E(e.code, strip(e.path), e.msg);
  for (const w of opts.schema?.warnings || []) W(w.code, strip(w.path), w.msg);
  if (!fd || typeof fd !== 'object' || Array.isArray(fd)) { item.blocking = item.errors.some(e => BLOCKING_CODES.includes(e.code)); return item; }
  const known = texts.pids();
  const where = Array.isArray(fd.where) ? fd.where.map((w, k) => [w, k]).filter(([w]) => w && typeof w === 'object' && !Array.isArray(w)) : [];
  // pages of the finding: known pids, and the pid of a url-only place when pages.json has that url
  const pids = [...new Set(where.map(([w]) => (typeof w.pid === 'string' && known.includes(w.pid) ? w.pid : texts.pidOfUrl(w.url))).filter(Boolean))];
  // places, frames, boxes
  let unknownPlaces = 0;
  for (const [w, k] of where) {
    const p = `where[${k}]`;
    if (typeof w.pid === 'string' && w.pid && !known.includes(w.pid)) {
      // pid only from pages.json; a page outside the snapshot is given by url
      if (typeof w.url === 'string' && w.url.trim()) E('pid_unknown', `${p}.pid`, M(`страницы «${w.pid}» нет в снимке (pages.json) — pid будет убран, место останется по url`, `page "${w.pid}" is not in the snapshot (pages.json) — the pid is removed, the place stays by url`));
      else { unknownPlaces++; E('pid_unknown', `${p}.pid`, M(`страницы «${w.pid}» нет в снимке (pages.json) — место будет убрано; pid берётся из pages.json, страница вне снимка — url`, `page "${w.pid}" is not in the snapshot (pages.json) — the place is removed; pid comes from pages.json, a page outside the snapshot needs url`)); }
    } else if (typeof w.pid === 'string' && w.url && texts.urls?.get(w.pid)) {
      const a = String(texts.urls.get(w.pid)).replace(/\/+$/, ''), b = String(w.url).replace(/\/+$/, '');
      if (a && b && a !== b && !b.startsWith(a + '#') && !b.startsWith(a + '?')) W('url_mismatch', `${p}.url`, M(`адрес не совпадает с ${w.pid} в pages.json (${a})`, `url differs from ${w.pid} in pages.json (${a})`));
    }
    const vpN = /^\d+$/.test(String(w.viewport ?? '')) ? Number(w.viewport) : null;
    const hasBox = V.validBox(w.box);
    if (typeof w.shot === 'string' && w.shot.trim()) {
      const ref = U.shotRef(run, w.shot, w.pid);
      if (!ref) { E('shot_outside_run', `${p}.shot`, M('путь кадра ведёт за пределы папки прогона', 'the frame path leaves the run folder')); continue; }
      if (!ref.exists) { E('shot_missing', `${p}.shot`, M(`кадра нет: ${ref.rel}`, `frame not found: ${ref.rel}`)); continue; }
      const size = frameSize(ref.abs);
      if (!size) { W('shot_unreadable', `${p}.shot`, M('размер кадра не читается (не JPEG/PNG?)', 'cannot read the frame size (not JPEG/PNG?)')); continue; }
      if (ref.entry && vpN && Number(ref.entry.width) !== vpN) W('viewport_mismatch', `${p}.viewport`, M(`viewport ${vpN}, а кадр снят на ${ref.entry.width}`, `viewport ${vpN}, but the frame is ${ref.entry.width} wide`));
      if (!hasBox) continue;
      if (w.box_space === 'image') {
        const iss = boxIssue(w.box, size.w, size.h);
        if (iss === 'outside') E('box_not_in_shot', `${p}.box`, M(`рамка вне кадра ${size.w}×${size.h}`, `box is outside the ${size.w}×${size.h} frame`));
        else if (iss === 'over') E('box_out_of_bounds', `${p}.box`, M(`рамка выходит за кадр ${size.w}×${size.h}`, `box exceeds the ${size.w}×${size.h} frame`));
      } else if (ref.entry) {
        const ib = U.boxCssToImage(ref.entry, w.box);
        if (!ib) { W('box_inner_css', `${p}.box`, M('кадр прокрутки внутри блока: рамку давайте в пикселях кадра (box_space: image)', 'inner-scroll frame: give the box in frame pixels (box_space: image)')); continue; }
        const iss = boxIssue(ib, size.w, size.h);
        const span = `y ${ref.entry.y0}–${ref.entry.y1} CSS px`;
        if (iss === 'outside') E('box_not_in_shot', `${p}.box`, M(`рамка (CSS) не попадает в этот кадр (${span}); укажите другой кусок или box_space: image`, `the CSS box is not in this frame (${span}); use another part or box_space: image`));
        else if (iss === 'over') W('box_crosses_frame', `${p}.box`, M(`рамка выходит за кадр (${span}) — в отчёте обрежется`, `the box crosses the frame (${span}) — it will be clipped in the report`));
      } else {
        // probe/, measure/mobile/… frames have their own scale (DPR 2): a CSS box cannot be mapped onto them
        E('box_space_needed', `${p}.box`, M(`кадр ${ref.rel} не из снимка страниц: рамку на нём давайте в пикселях кадра (box_space: image), иначе кропа в отчёте не будет`, `frame ${ref.rel} is not a snapshot frame: give the box in frame pixels (box_space: image), otherwise the report has no crop`));
      }
    } else if (hasBox && w.box_space !== 'image' && vpN && typeof w.pid === 'string' && known.includes(w.pid)) {
      const idx = U.readShotsIndex(run, w.pid).filter(e => Number(e.width) === vpN && U.shotKind(e) !== 'inner');
      if (idx.length) {
        const depth = Math.max(...idx.map(e => Number(e.y1) || 0));
        if (w.box[1] > depth + 4) W('box_below_snapshot', `${p}.box`, M(`рамка ниже снятой части страницы (${depth} CSS px)`, `box is below the captured part of the page (${depth} CSS px)`));
      }
    }
  }
  if (where.length && unknownPlaces === where.length) E('no_known_place', 'where', M('ни одной страницы из where нет в снимке и ни у одного места нет url — укажите pid из pages.json или url', 'none of the where pages is in the snapshot and no place has a url — use a pid from pages.json or a url'));
  // quotes on their own page
  const quotes = extractQuotes(fd.evidence);
  for (const q of quotes.slice(0, 20)) {
    const loc = locateQuote(texts, q, pids);
    if (loc.skip) continue;
    const sq = shortQ(q);
    if (loc.found) item.quotes.push({ q: sq, found: loc.found, pid: loc.pid });
    else if (loc.other) { item.quotes.push({ q: sq, found: null, other: loc.other }); E('quote_other_page', 'evidence', M(`цитата «${sq}» есть на ${loc.other}, а находка про ${pids.join(', ') || '—'}: если она и про ${loc.other} — добавьте ${loc.other} в where`, `quote "${sq}" is on ${loc.other}, but the finding is about ${pids.join(', ') || '—'}: if it is about ${loc.other} too, add ${loc.other} to where`)); }
    else { item.quotes.push({ q: sq, found: null }); E('quote_not_found', 'evidence', M(`цитаты «${sq}» нет дословно в text.md/raw.html страницы (если это не текст сайта — оформите в \`…\`)`, `quote "${sq}" is not verbatim in the page text.md/raw.html (if it is not site text, use \`…\`)`)); }
    if (U.words(q).length > 15) W('quote_long', 'evidence', M(`цитата длиннее 15 слов (${U.words(q).length})`, `quote longer than 15 words (${U.words(q).length})`));
  }
  if (typeof fd.evidence === 'string' && fd.evidence.trim() && !/[\p{N}«“`]/u.test(fd.evidence)) W('no_numbers', 'evidence', M('в доказательстве нет ни цифры, ни цитаты, ни кода', 'evidence has no number, quote or code'));
  // `before` of text lenses is site text: it must be on the page as is
  if (lens && TEXT_LENSES.includes(lens) && typeof fd.before === 'string') {
    const b = fd.before.replace(/`[^`]*`/g, ' ').replace(/^[\s«“"„]+|[\s»”"]+$/g, '').trim();
    if (b.replace(/[\s.…]/g, '').length >= 3) {
      const loc = locateQuote(texts, b, pids);
      if (!loc.skip && !loc.found) {
        const sb = shortQ(b);
        if (loc.other) E('before_not_found', 'before', M(`текст before «${sb}» есть на ${loc.other}, а находка про ${pids.join(', ') || '—'} — добавьте ${loc.other} в where`, `before "${sb}" is on ${loc.other}, but the finding is about ${pids.join(', ') || '—'} — add ${loc.other} to where`));
        else E('before_not_found', 'before', M(`текста before «${sb}» нет дословно на странице: в before — только текст сайта как есть (код — в \`…\`)`, `before "${sb}" is not verbatim on the page: before holds site text as is (code goes in \`…\`)`));
      }
    }
  }
  // tone (site quotes and code are skipped; the [source] tail of evidence is technical and cut for external anyway)
  for (const k of ['title', 'problem', 'impact', 'fix', 'evidence', 'after']) {
    const hits = toneHits(stop, k === 'evidence' ? String(fd[k] ?? '').replace(/\[[^\]]*\]/g, ' ') : fd[k]);
    if (hits.length) W('tone', k, M(`слова из стоп-листа тона: ${hits.join(', ')}`, `tone stop-words: ${hits.join(', ')}`));
  }
  item.blocking = item.errors.some(e => BLOCKING_CODES.includes(e.code));
  return item;
}

/**
 * lintLens(run, lens, { texts, stop, files, deadline, prev }) → { tool, lens, files, file_errors, items, partial, … }
 * deadline (ms epoch): stop before the next finding and return partial: true; prev: Map "<file>#<id>" → item to reuse.
 */
export function lintLens(run, lens, opts = {}) {
  const texts = opts.texts || new PageTexts(run);
  const stop = opts.stop || loadStopWords('owner');
  const files = opts.files || lensFiles(run)[lens] || [];
  const res = { tool: 'lint-findings', version: U.VERSION, rev: LINT_REV, run, generated: U.nowIso(), lens, files: files.map(f => f.rel), stop_words: stop.src,
    file_errors: [], doc_errors: [], checked: 0, errors: 0, warnings: 0, blocking: 0, partial: false, items: [] };
  let fresh = 0;
  outer: for (const f of files) {
    const v = V.validateFile(f.abs, { type: 'findings', run });
    if (!v.data || v.fatalDoc) { res.file_errors.push({ file: f.rel, error: v.errors.map(e => `${e.path ? e.path + ': ' : ''}${e.msg}`).join('; ') }); continue; }
    for (const e of v.errors.filter(e => !/^findings\[/.test(e.path))) res.doc_errors.push({ file: f.rel, ...e });
    const findings = Array.isArray(v.data.findings) ? v.data.findings : [];
    for (let i = 0; i < findings.length; i++) {
      const fd = findings[i];
      if (!fd || typeof fd !== 'object') continue;
      const key = `${f.rel}#${fd.id ?? `#${i}`}`;
      const old = opts.prev?.get(key);
      if (old) { res.items.push(old); continue; }
      // the deadline counts only after one new finding: every call makes progress, even when indexing pages is slow
      if (opts.deadline && fresh > 0 && Date.now() > opts.deadline) { res.partial = true; break outer; }
      const sch = (v.items || []).find(x => x.index === i) || { errors: [], warnings: [] };
      let item;
      texts.setDeadline(fresh > 0 ? opts.deadline : 0);
      try { item = lintFinding(run, fd, { texts, stop, lens, file: f.rel, schema: sch }); }
      catch (e) { if (e instanceof LintTimeout) { res.partial = true; break outer; } throw e; }
      finally { texts.setDeadline(0); }
      if (fd.id === undefined) item.id = `#${i}`;
      res.items.push(item); fresh++;
    }
  }
  texts.flush();
  res.checked = res.items.length;
  res.errors = res.items.reduce((a, x) => a + x.errors.length, 0) + res.file_errors.length + res.doc_errors.length;
  res.warnings = res.items.reduce((a, x) => a + x.warnings.length, 0);
  res.blocking = res.items.filter(x => x.blocking).length;
  if (res.partial) res.resume = { done: res.items.map(x => `${x.file}#${x.id}`) };
  return res;
}

/** Is a saved verify/<lens>.lint.json still valid for these files? → 'fresh' | 'partial' | null */
export function lintFileState(prev, files, mtimeOfLint) {
  if (!prev || prev.rev !== LINT_REV || !Array.isArray(prev.items)) return null;
  const newest = Math.max(0, ...files.map(f => f.mtime));
  if (!(mtimeOfLint >= newest)) return null;
  if (JSON.stringify(prev.files) !== JSON.stringify(files.map(f => f.rel))) return null;
  return prev.partial ? 'partial' : 'fresh';
}

// ---------- competitor cards (--cards) ----------
function walkFiles(dir, test, depth = 3, out = []) {
  if (depth < 0) return out;
  let list = [];
  try { list = readdirSync(dir); } catch { return out; }
  for (const f of list) {
    const p = join(dir, f);
    let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { if (f !== 'shots') walkFiles(p, test, depth - 1, out); }
    else if (test(f)) out.push(p);
  }
  return out;
}
function textSourcesOf(files) {
  return files.map(p => {
    const t = readText(p) || '';
    const norms = p.endsWith('.html') ? [normQ(htmlText(t, ' ')), normQ(htmlText(t, '')), normQ(decodeEntities(t))] : [normQ(t)];
    return { file: p, norms, words: norms.map(n => wordHashes(n, new Set())) };
  });
}
const srcHas = (s, qf) => s.norms.some((n, k) => qf.needs.every(ws => ws.every(w => s.words[k].has(w))) && qf.frags.every(f => n.includes(f)));
// rivals.mjs: shots/<pid>-<width>-fold.jpg, <pid>-<width>.part-NN.jpg, <pid>-<width>-full.jpg; text.md (home), text-<pid>.md
function rivalPidOfShot(file, entry) {
  if (entry?.pid) return String(entry.pid);
  const m = basename(String(file)).match(/^(.+?)-\d{3,4}(?:-fold|-full|\.part-\d+|\.inner-\d+)?\.(?:jpe?g|png)$/i);
  return m ? m[1] : null;
}
export function lintCards(run) {
  const base = join(run, 'rivals');
  const out = { tool: 'lint-findings', mode: 'cards', version: U.VERSION, run, generated: U.nowIso(), hosts: [], errors: 0, warnings: 0 };
  let hosts = [];
  try { hosts = readdirSync(base).filter(h => { try { return statSync(join(base, h)).isDirectory(); } catch { return false; } }).sort(); } catch { return out; }
  for (const host of hosts) {
    const cardAbs = join(base, host, 'card.json');
    const rec = { host, file: `rivals/${host}/card.json`, errors: [], warnings: [], finds: [] };
    if (!existsSync(cardAbs)) { rec.warnings.push({ code: 'no_card', field: '', msg: M('карточки нет', 'no card') }); out.hosts.push(rec); continue; }
    const v = V.validateFile(cardAbs, { type: 'card', run });
    for (const e of v.errors) rec.errors.push({ code: e.code, field: e.path, msg: e.msg });
    for (const w of v.warnings) rec.warnings.push({ code: w.code, field: w.path, msg: w.msg });
    const card = v.data;
    if (card && Array.isArray(card.finds)) {
      const hostDir = join(base, host);
      const allSrc = textSourcesOf(walkFiles(hostDir, f => f === 'text.md' || /^text-[a-z0-9_-]+\.md$/i.test(f) || f === 'raw.html' || f === 'dom.html'));
      const shotsIdx = U.readJSON(join(hostDir, 'shots', 'index.json'), []);
      card.finds.forEach((f, i) => {
        if (!f || typeof f !== 'object') return;
        const fr = { id: f.id ?? `#${i}`, errors: [], warnings: [] };
        const E = (code, field, msg) => fr.errors.push({ code, field, msg });
        const W = (code, field, msg) => fr.warnings.push({ code, field, msg });
        let own = null; // text sources of the frame's page
        if (typeof f.shot === 'string' && f.shot.trim()) {
          const ref = U.shotRef(run, f.shot);
          if (!ref) E('shot_outside_run', 'shot', M('путь кадра ведёт за пределы папки прогона', 'the frame path leaves the run folder'));
          else if (!ref.rel.startsWith(`rivals/${host}/`)) E('shot_other_site', 'shot', M(`кадр не из rivals/${host}/`, `frame is not from rivals/${host}/`));
          else if (!ref.exists) E('shot_missing', 'shot', M(`кадра нет: ${ref.rel}`, `frame not found: ${ref.rel}`));
          else {
            const size = frameSize(ref.abs);
            if (size && V.validBox(f.crop)) {
              const iss = boxIssue(f.crop, size.w, size.h);
              if (iss === 'outside') E('crop_not_in_shot', 'crop', M(`кроп вне кадра ${size.w}×${size.h}`, `crop is outside the ${size.w}×${size.h} frame`));
              else if (iss === 'over') E('crop_out_of_bounds', 'crop', M(`кроп выходит за кадр ${size.w}×${size.h} (координаты — в пикселях файла)`, `crop exceeds the ${size.w}×${size.h} frame (coordinates are file pixels)`));
            }
            // flat layout of rivals.mjs: the page of a frame is its pid → text.md / text-<pid>.md
            const entry = Array.isArray(shotsIdx) ? shotsIdx.find(e => e?.file === ref.file) : null;
            const pid = rivalPidOfShot(ref.file, entry);
            if (pid) {
              const name = pid === 'home' ? 'text.md' : `text-${pid}.md`;
              const hit = allSrc.filter(s => dirname(s.file) === hostDir && basename(s.file) === name);
              if (hit.length) own = hit;
            }
            // nested layout (a full snapshot per page): nearest folder above the frame with text.md/raw.html
            if (!own) {
              let d = dirname(ref.abs);
              while (d.startsWith(hostDir) && !own) {
                const here = allSrc.filter(s => dirname(s.file) === d && ['text.md', 'raw.html', 'dom.html'].includes(basename(s.file)));
                if (here.length && d !== hostDir) own = here;
                if (d === hostDir) break;
                d = dirname(d);
              }
            }
          }
        }
        if (typeof f.quote === 'string' && f.quote.trim()) {
          const qf = quoteFragments(f.quote);
          const mine = own || allSrc;
          if (!allSrc.length) W('no_text', 'quote', M('у снимка конкурента нет text.md/raw.html — цитату не с чем сверить', 'the competitor snapshot has no text.md/raw.html — nothing to check the quote against'));
          else if (qf.frags.length && !mine.some(s => srcHas(s, qf))) {
            const elsewhere = allSrc.find(s => !mine.includes(s) && srcHas(s, qf));
            if (elsewhere) E('quote_other_page', 'quote', M(`цитата с другой страницы: ${relative(run, elsewhere.file).split(/[\\/]/).join('/')} — возьмите кадр той страницы`, `quote is from another page: ${relative(run, elsewhere.file).split(/[\\/]/).join('/')} — use a frame of that page`));
            else E('quote_not_found', 'quote', M('цитаты нет дословно на странице кадра', 'the quote is not verbatim on the frame page'));
          }
        }
        if (fr.errors.length || fr.warnings.length) rec.finds.push(fr);
      });
    }
    out.hosts.push(rec);
  }
  out.errors = out.hosts.reduce((a, h) => a + h.errors.length + h.finds.reduce((b, f) => b + f.errors.length, 0), 0);
  out.warnings = out.hosts.reduce((a, h) => a + h.warnings.length + h.finds.reduce((b, f) => b + f.warnings.length, 0), 0);
  return out;
}

// ---------- CLI ----------
const HELP = `
lint-findings.mjs — скриптовая проверка находок перед скептиком (формат находки — knowledge/findings-format.md).
По каждой находке:
  - схема (как validate.mjs);
  - pid из where есть в снимке (pages.json); другой pid — ошибка pid_unknown: место с url остаётся по url,
    без url убирается; нет ни одного известного места — no_known_place; кадр shot существует и лежит в папке прогона;
  - рамка box в границах кадра (размер из заголовка JPEG; box_space css пересчитывается по
    snapshot/<pid>/shots/index.json; на кадрах не из снимка — probe/, measure/… — только box_space: image);
  - каждая цитата «…» из evidence дословно есть в text.md / raw.html / dom.html ТОЙ страницы (pid из where;
    нормализация ё→е, кавычек, тире, nbsp, регистра);
  - у линз copy, facts, seo-content поле before — дословный текст страницы;
  - стоп-слова тона в title/problem/impact/fix/evidence/after (knowledge/tone.md, «Запрещено»; цитаты и код не считаются).

  node lint-findings.mjs --run "<RUN>" [--lens copy,mobile] [--force] [--audience owner|team|external] [--budget-sec N] [--lang ru|en]
  node lint-findings.mjs --run "<RUN>" --cards        карточки конкурентов rivals/<host>/card.json (text.md, text-<pid>.md)

Пишет verify/<lens>.lint.json (или verify/cards.lint.json) и сводку в stdout/lint-findings.md.
Индекс слов страниц кладёт в verify/lint-index/ (служебный, его можно удалить): повторный вызов не перестраивает его.
Блокирующие ошибки (merge.mjs не пустит находку в отчёт без confirmed/adjusted скептика): ${BLOCKING_CODES.join(', ')}.
Ремонтируемые (merge уберёт битую ссылку на кадр, рамку или место, находка останется): ${REPAIRABLE_CODES.join(', ')}.
Код, CSS, имена правил и прочий текст не с сайта пишите в \`…\`; в «…» — только дословный текст страницы.
Образцы вроде «не X, а Y» или «от N ₽» (одиночные X, Y, Z, N) цитатами не считаются.
Готовые линзы с неизменёнными файлами пропускаются (повторный вызов продолжает с той же находки); --force — всё заново.
Код 0 — готово (даже если найдены ошибки: они в отчётах lint), 2 — аргументы, 75 — не уложился в --budget-sec
(по умолчанию 480): частичный результат записан, повторите тот же вызов.
`;

async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['cards', 'force', 'json', 'help'] });
  U.helpAndExit(HELP, args);
  const lang = U.langOf(args);
  setLang(lang);
  const L = M;
  if (!args.run || args.run === true) { console.error(U.msg('need_run', lang)); process.exit(2); }
  const run = resolve(String(args.run));
  if (!existsSync(run)) { console.error(L(`Нет папки прогона: ${run}`, `Run folder not found: ${run}`)); process.exit(2); }
  const budgetSec = Math.max(1, Number(args['budget-sec'] ?? 480) || 480);
  const deadline = Date.now() + budgetSec * 1000 - Math.min(5000, budgetSec * 100);

  if (args.cards) {
    const res = lintCards(run);
    U.writeJSON(U.insideRun(run, 'verify', 'cards.lint.json'), res);
    const lines = [`lint --cards · ${L('карточек', 'cards')} ${res.hosts.length} · ${L('ошибок', 'errors')} ${res.errors} · ${L('предупреждений', 'warnings')} ${res.warnings}`];
    if (!res.hosts.length) lines.push(L('Нет папок rivals/<host>/ — нечего проверять.', 'No rivals/<host>/ folders — nothing to check.'));
    let more = 0;
    for (const h of res.hosts) {
      const n = h.errors.length + h.finds.reduce((a, f) => a + f.errors.length, 0);
      if (lines.length > 34) { more += n; continue; }
      lines.push(`${n ? '!!' : 'ok'}  ${h.host} — ${L('ошибок', 'errors')} ${n}`);
      const list = [...h.errors.slice(0, 3).map(e => `    ${e.field ? e.field + ': ' : ''}${e.msg}`), ...h.finds.flatMap(f => f.errors.map(e => `    ${f.id} ${e.field}: ${e.msg}`))];
      for (const s of list) { if (lines.length > 34) { more++; continue; } lines.push(s); }
    }
    if (more) lines.push(L(`… и ещё ${more} — полный список в verify/cards.lint.json`, `… and ${more} more — see verify/cards.lint.json`));
    lines.push(`→ verify/cards.lint.json`);
    U.log(run, `lint-findings --cards: ${res.hosts.length} карточек, ошибок ${res.errors}`);
    U.printAndSaveSummary(run, 'lint-findings', lines);
    return;
  }

  const brief = U.readJSON(join(run, 'brief.json'), null) || U.readJSON(join(run, 'brief.input.json'), null) || {};
  const state = U.readJSON(join(run, 'state.json'), null) || {};
  const audience = ['owner', 'team', 'external'].includes(args.audience) ? args.audience : (brief.audience || state.flags?.audience || 'owner');
  const stop = loadStopWords(audience);
  const all = lensFiles(run);
  const skippedFiles = Object.entries(all).flatMap(([l, fs]) => fs.filter(f => f.badName || !V.KNOWN_LENSES.includes(l)).map(f => f.rel));
  const groups = Object.fromEntries(Object.entries(all).map(([l, fs]) => [l, fs.filter(f => !f.badName && V.KNOWN_LENSES.includes(l))]).filter(([, fs]) => fs.length));
  const only = U.listArg(args.lens);
  const lenses = Object.keys(groups).filter(l => !only.length || only.includes(l));
  const missing = only.filter(l => !groups[l]);
  const texts = new PageTexts(run, { writeCache: true });
  const done = [], results = [];
  let partial = false;
  for (const lens of lenses) {
    const outPath = U.insideRun(run, 'verify', `${lens}.lint.json`);
    let prevMap = null;
    if (!args.force && existsSync(outPath)) {
      const prev = U.readJSON(outPath, null);
      let mt = 0; try { mt = statSync(outPath).mtimeMs; } catch {}
      const st = prev && prev.audience === audience ? lintFileState(prev, groups[lens], mt) : null;
      if (st === 'fresh') { results.push({ ...prev, reused: true }); done.push(lens); continue; }
      if (st === 'partial') prevMap = new Map(prev.items.map(x => [`${x.file}#${x.id}`, x]));
    }
    if (Date.now() > deadline) { partial = true; break; }
    const res = lintLens(run, lens, { texts, stop, files: groups[lens], deadline, prev: prevMap });
    res.audience = audience;
    U.writeJSON(outPath, res);
    results.push(res);
    if (res.partial) { partial = true; break; }
    done.push(lens);
  }
  const tot = k => results.reduce((a, r) => a + (r[k] || 0), 0);
  const lines = [`lint · ${L('линз', 'lenses')} ${done.length}${partial ? `/${lenses.length} ` + L('(ЧАСТИЧНО)', '(PARTIAL)') : ''} · ${L('находок', 'findings')} ${tot('checked')} · ${L('ошибок', 'errors')} ${tot('errors')} (${L('блокирующих находок', 'blocking findings')} ${tot('blocking')}) · ${L('предупреждений', 'warnings')} ${tot('warnings')} · ${L('стоп-слова', 'stop-words')}: ${stop.src}`];
  if (!lenses.length) lines.push(only.length ? L(`Нет файлов findings/ для: ${only.join(', ')}`, `No findings/ files for: ${only.join(', ')}`) : L('В findings/ нет файлов — нечего проверять.', 'findings/ is empty — nothing to check.'));
  if (missing.length && lenses.length) lines.push(L(`Нет файлов для: ${missing.join(', ')}`, `No files for: ${missing.join(', ')}`));
  if (skippedFiles.length) lines.push(L(`Пропущены (имя не <линза>.json или неизвестная линза): ${skippedFiles.slice(0, 4).join(', ')}${skippedFiles.length > 4 ? ` и ещё ${skippedFiles.length - 4}` : ''}`, `Skipped (name is not <lens>.json or unknown lens): ${skippedFiles.slice(0, 4).join(', ')}${skippedFiles.length > 4 ? ` and ${skippedFiles.length - 4} more` : ''}`));
  let hidden = 0;
  for (const r of results) {
    if (lines.length > 32) { hidden += r.errors || 0; continue; }
    lines.push(`${r.errors ? '!!' : 'ok'}  ${r.lens}: ${r.checked} · ${L('ошибок', 'errors')} ${r.errors} · ${L('блок.', 'block.')} ${r.blocking} · ${L('предупр.', 'warn.')} ${r.warnings}${r.reused ? L(' (без изменений)', ' (unchanged)') : ''}${r.partial ? L(' (не досчитано)', ' (unfinished)') : ''} → verify/${r.lens}.lint.json`);
    const list = [...r.file_errors.map(fe => `    ${fe.file}: ${fe.error.slice(0, 200)}`), ...(r.reused ? [] : r.items.flatMap(it => it.errors.map(e => `    ${it.id} ${e.field}: ${e.msg.slice(0, 170)}`)))];
    for (const s of list) { if (lines.length > 32) { hidden++; continue; } lines.push(s); }
  }
  if (hidden) lines.push(L(`… и ещё ${hidden} ошибок — полный список в verify/<линза>.lint.json`, `… and ${hidden} more errors — see verify/<lens>.lint.json`));
  if (partial) lines.push(L('Частичный результат (код 75): повторите тот же вызов — продолжу с непроверенной находки.', 'Partial result (exit 75): run the same command again to continue.'));
  lines.push(L('Блокирующие (цитата или before не найдены, цитата с чужой страницы, нет известной страницы, сломанная схема) — скептику: подтвердить замером или снять.', 'Blocking (quote or before missing, quote from another page, no known page, broken schema) — for the skeptic: confirm by re-measuring or drop.'));
  U.log(run, `lint-findings: линз ${done.length}${partial ? ' (partial)' : ''}, находок ${tot('checked')}, ошибок ${tot('errors')}, блокирующих ${tot('blocking')}`);
  if (args.json) process.stdout.write(JSON.stringify({ partial, resume: partial ? { done } : null, lenses: results.map(r => ({ lens: r.lens, checked: r.checked, errors: r.errors, blocking: r.blocking, warnings: r.warnings, partial: !!r.partial })) }, null, 2) + '\n');
  else U.printAndSaveSummary(run, 'lint-findings', lines);
  process.exit(partial ? 75 : 0);
}

const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
