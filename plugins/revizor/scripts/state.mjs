#!/usr/bin/env node
// Revizor — run state (RUN/state.json) and "what to do next" for the orchestrator (scenarios of skills/full, quick, rivals, recheck).
// Only this module writes state.json: other scripts import createState/updateState/setDone from here.
// Also the site-address parser (parseSiteUrl): every address printed inside a command goes through it.
//
//   node state.mjs --run "<RUN>" --get [key]
//   node state.mjs --run "<RUN>" --set lens:copy=ok [--set verify:copy=failed]      (step keys only; flags never)
//   node state.mjs --run "<RUN>" --next [--json]
//   node state.mjs --run "<RUN>" --reset lens:copy | --replan

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as U from './lib/util.mjs';

export const SCHEMA_VERSION = 3;
export const STAGES = ['init', 'pipeline', 'brief', 'lenses', 'skeptic', 'critic1', 'round2', 'critic2', 'scores', 'strategy', 'editor', 'report', 'done', 'blocked'];
export const DONE_VALUES = ['todo', 'running', 'ok', 'failed', 'partial', 'skipped', 'blocked'];
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const LENSES = ['product', 'facts', 'ux', 'visual', 'typography', 'color', 'mobile', 'a11y', 'copy', 'seo-tech', 'seo-content',
  'perf', 'stability', 'forms', 'security', 'privacy', 'legal'];
export const AGENT_LENSES = [...LENSES, 'visitor', 'ecommerce', 'i18n'];
export const QUICK_TOPICS = ['product', 'facts', 'visitor', 'ux', 'visual', 'typography', 'color', 'mobile', 'a11y', 'copy', 'seo', 'seo-tech',
  'seo-content', 'perf', 'stability', 'forms', 'security', 'privacy', 'legal', 'ecommerce', 'i18n', 'health'];
export const PAGES_BY_DEPTH = { lite: 3, standard: 4, deep: 30 };

// Presets: agents per depth (an array with several lenses = one revizor:group agent)
export const PRESET_GROUPS = {
  lite: [['product', 'facts', 'ux', 'forms'], ['visual', 'typography', 'color', 'mobile'], ['a11y', 'perf', 'stability'],
    ['copy', 'seo-tech', 'seo-content'], ['security', 'privacy', 'legal'], ['visitor']],
  standard: [['product'], ['facts'], ['visitor'], ['ux', 'forms'], ['visual', 'typography', 'color'], ['mobile'], ['a11y'], ['copy'],
    ['seo-tech', 'seo-content'], ['perf', 'stability'], ['security', 'privacy', 'legal']],
  deep: [...LENSES.map(l => [l]), ['visitor']],
};
// Skeptics by method (knowledge/checklists/skeptic.md)
const SKEPTIC_STD = {
  shots: ['visual', 'typography', 'color', 'mobile', 'visitor', 'ux'],
  measures: ['a11y', 'perf', 'stability', 'seo-tech', 'forms', 'security', 'privacy'],
  text: ['copy', 'facts', 'seo-content', 'product', 'ecommerce', 'i18n'],
  legal: ['legal'],
};
const SKEPTIC_LITE = {
  'shots-measures': [...SKEPTIC_STD.shots, ...SKEPTIC_STD.measures],
  'text-facts-legal': [...SKEPTIC_STD.text, 'legal'],
};
// Pipeline stages a quick topic needs (crawl and snapshot always)
export const TOPIC_STAGES = {
  product: ['seo', 'forms'], facts: ['seo', 'forms', 'textscan'], visitor: ['mobile'], ux: ['mobile', 'forms'], visual: ['vision'],
  typography: [], color: ['vision'], mobile: ['mobile'], a11y: ['a11y'], copy: ['textscan'], seo: ['seo', 'headers', 'textscan'],
  'seo-tech': ['seo', 'headers'], 'seo-content': ['seo', 'textscan'], perf: ['headers', 'perf'], stability: ['headers'],
  forms: ['forms', 'privacy'], security: ['headers', 'domain', 'textscan'], privacy: ['privacy', 'forms'], legal: ['privacy', 'forms', 'textscan'],
  ecommerce: ['seo', 'forms'], i18n: ['seo', 'textscan'],
};
// balanced: these roles keep the session model, the rest run on sonnet
const INHERIT_BALANCED = new Set(['visitor', 'product', 'critic', 'editor', 'scorer', 'strategist', 'scout']);

// ---------- cost model (knowledge/cost.md: «ориентир, уточняется замерами») ----------
const COST_FALLBACK = {
  version: 1, measured: false,
  pipeline_min: { fixed: [2, 4], per_page: [1, 2], quick_per_page: [0.5, 1.5], health: [3, 6], rivals_per_site: [2, 4] },
  agent_min: { lens: [8, 15], group: [15, 30], skeptic: [5, 12], scout: [4, 8], critic: [6, 12], editor: [10, 20], editor_quick: [5, 10],
    strategist: [8, 15], scorer: [4, 8], 'rival-analyst': [5, 10], rechecker: [5, 12], fix: [2, 4] },
  load_levels: { low_max_agents: 4, medium_max_agents: 12 },
  subscriptions: {
    pro: { depth: 'lite', models: 'economy', parallel: 3 }, max5: { depth: 'standard', models: 'balanced', parallel: 6 },
    max20: { depth: 'standard', models: 'max', parallel: 6 }, api: { depth: 'standard', models: 'balanced', parallel: 6 },
  },
};
let COST = null;
/** Numbers of knowledge/cost.md (machine-readable block <!-- revizor:cost {…} -->), built-in fallback. */
export function costModel() {
  if (COST) return COST;
  let blk = null;
  try { blk = U.knowledgeBlock(readFileSync(join(ROOT, 'knowledge', 'cost.md'), 'utf8'), 'cost'); } catch { /* fallback */ }
  COST = { ...COST_FALLBACK, ...(blk || {}), source: blk ? 'knowledge/cost.md' : 'built-in' };
  for (const k of ['pipeline_min', 'agent_min', 'load_levels', 'subscriptions']) COST[k] = { ...COST_FALLBACK[k], ...((blk || {})[k] || {}) };
  return COST;
}
export const SUBSCRIPTIONS = ['pro', 'max5', 'max20', 'api'];

// ---------- read / write ----------
export function statePath(run) { return join(run, 'state.json'); }
export function readState(run) {
  try { return JSON.parse(readFileSync(statePath(run), 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
export function pluginVersion() {
  try { return JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version || U.VERSION; } catch { return U.VERSION; }
}
function writeAtomic(p, data) {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  for (let i = 0; ; i++) {
    try { renameSync(tmp, p); return; }
    catch (e) { if (i >= 20) { rmSync(tmp, { force: true }); throw e; } const until = Date.now() + 50; while (Date.now() < until) { /* antivirus lock on Windows */ } }
  }
}
/** Read-modify-write under a lock. mutator(state) may change it in place or return a new object. */
export async function updateState(run, mutator) {
  return U.withFileLock(statePath(run) + '.lock', async () => {
    const cur = readState(run);
    if (!cur) throw new Error(`Нет state.json в ${run} — сначала init-run.mjs.`);
    const next = (await mutator(cur)) || cur;
    next.updated = U.nowIso();
    writeAtomic(statePath(run), next);
    return next;
  });
}
/** Used by init-run.mjs only. */
export async function createState(run, { mode, flags }) {
  return U.withFileLock(statePath(run) + '.lock', async () => {
    const now = U.nowIso();
    const s = { plugin_version: pluginVersion(), schema_version: SCHEMA_VERSION, run, mode, flags, stage: 'init', done: {}, attempts: {}, started: now, updated: now };
    writeAtomic(statePath(run), s);
    return s;
  });
}
/** setDone(run, {'lens:copy': 'ok'}) — for scripts (doctor, pipeline, memory). "failed" counts an attempt. */
export async function setDone(run, pairs) {
  return updateState(run, s => {
    s.done ||= {}; s.attempts ||= {};
    for (const [k, v] of Object.entries(pairs)) {
      if (!DONE_VALUES.includes(v)) throw new Error(`Недопустимое значение ${k}=${v} (можно: ${DONE_VALUES.join(', ')})`);
      s.done[k] = v;
      (s.since ||= {})[k] = U.nowIso();
      if (v === 'failed') s.attempts[k] = (s.attempts[k] || 0) + 1;
      if (k === 'final' && v === 'ok') s.stage = 'done';
    }
  });
}
/** After an interruption nothing is really running any more; a failed environment check is run again (the person may have installed things). */
export async function resetRunning(run) {
  return updateState(run, s => {
    for (const [k, v] of Object.entries(s.done || {})) if (v === 'running') s.done[k] = 'todo';
    if ((s.done || {}).doctor === 'failed') s.done.doctor = 'todo';
    s.resumed = U.nowIso();
  });
}

// ---------- --set: step keys only ----------
// Agents call `state.mjs --set` and they read texts of foreign sites, so --set must not reach run flags
// (probe, allow_load_posts, url, out…): those come only from init-run with an explicit flag or answer of the person.
const PLAIN_KEYS = new Set(['doctor', 'estimate', 'questions', 'candidates', 'pipeline', 'stage_question', 'scout', 'brief', 'brief_saved',
  'rivals_light', 'rivals_snap', 'lint', 'lint:2', 'lint_cards', 'merge', 'merge:2', 'merge:final', 'merge:ids', 'editor', 'report', 'final', 'memory', 'topic',
  'privacy_reject', 'reruns']);
export function allowedSetKey(key) {
  if (PLAIN_KEYS.has(key)) return true;
  let m;
  if ((m = key.match(/^(lens|r2|fix):([a-z0-9-]+)$/))) return AGENT_LENSES.includes(m[2]);
  if ((m = key.match(/^verify:([a-z0-9-]+)$/))) return AGENT_LENSES.includes(m[1]) || ['r2', 'recheck', 'ids'].includes(m[1]);
  return /^critic:(1|2|strategy|rivals)$/.test(key) || /^strategy:(seo|site|rivals)$/.test(key) || /^scorer:(strict|market)$/.test(key)
    || /^card:[a-z0-9][a-z0-9._-]{0,120}$/.test(key) || /^recheck:[a-z0-9][a-z0-9_-]{0,40}$/.test(key);
}
const SET_HELP = 'lens:<линза>, r2:<линза>, verify:<линза|r2|recheck|ids>, merge:ids, critic:1|2|strategy|rivals, strategy:seo|site|rivals, scorer:strict|market, card:<хост>, recheck:<группа>, scout, editor, report, final, questions, estimate, pipeline, lint, merge…';
/** Apply "key=value" pairs to done[] (step keys only). final=ok also marks the run finished. */
export function applyPairs(s, pairs, { run = '<RUN>' } = {}) {
  const applied = [];
  for (const raw of pairs) {
    const eq = raw.indexOf('=');
    if (eq < 1) throw new Error(`Нужно ключ=значение: «${raw}»`);
    const key = raw.slice(0, eq).trim(), v = raw.slice(eq + 1).trim();
    if (key.startsWith('flags.')) throw new Error(`Флаги прогона через state.mjs не меняются (их задаёт init-run по слову человека). Спеллер: node "${fwd(join(ROOT, 'scripts', 'init-run.mjs'))}" --run "${fwd(run)}" --answer spell=on|off; другое — новый прогон с нужными флагами.`);
    if (key.startsWith('attempts.')) throw new Error(`Счётчик попыток вручную не меняется. Начать ключ заново: --reset ${key.slice(9) || '<ключ>'}`);
    if (key === 'stage' || key === 'mode' || key === 'plan') throw new Error(`«${key}» ставит сам state.mjs --next (или init-run), не --set.`);
    if (!allowedSetKey(key)) throw new Error(`Неизвестный ключ «${key}». Можно: ${SET_HELP}`);
    if (!DONE_VALUES.includes(v)) throw new Error(`${key}: одно из ${DONE_VALUES.join(', ')}`);
    (s.done ||= {})[key] = v;
    (s.since ||= {})[key] = U.nowIso();
    if (v === 'failed') (s.attempts ||= {})[key] = ((s.attempts || {})[key] || 0) + 1;
    if (key === 'final' && v === 'ok') s.stage = 'done';
    applied.push(`${key}=${v}`);
  }
  return applied;
}

// ---------- site addresses ----------
// Addresses come from people, search results and agents that read foreign sites; they are printed inside "…" in commands
// the orchestrator runs. So: only http(s), host only [a-z0-9._-] after punycode (or an IPv6 literal), and characters that
// a shell treats specially inside double quotes (and a few more) are percent-encoded in the path and the query.
// Tracking parameters cut from a typed address; a site's own parameters (?from=2020) stay.
const TRACKING_PARAM = /^(utm_[a-z]+|yclid|gclid|fbclid|ysclid|_openstat|roistat|mc_cid|mc_eid)$/i;
const HOST_OK = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;
const V6_OK = /^\[[0-9a-f:.]+\]$/;
const UNSAFE_CH = /[$`'"()|;!\\<>{}^\s‘-‟«»]/g;
/** Percent-encode characters that are not safe inside "…" in Bash or PowerShell (and quotes of any kind). */
export function encUnsafe(s) {
  return String(s).replace(UNSAFE_CH, c => { const e = encodeURIComponent(c); return e !== c ? e : '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'); });
}
// IPv6 literal → 8 numbers | null (a dotted IPv4 tail is folded into two groups)
function v6groups(s) {
  let t = s;
  const dm = t.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (dm) { const b = dm.slice(2).map(Number); if (b.some(x => x > 255)) return null; t = dm[1] + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16); }
  const parts = t.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':') : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':') : [];
  const fill = parts.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (parts.length === 1 && head.length !== 8)) return null;
  const all = [...head, ...Array(fill).fill('0'), ...tail];
  if (all.length !== 8 || !all.every(x => /^[0-9a-f]{1,4}$/.test(x))) return null;
  return all.map(x => parseInt(x, 16));
}
/** IPv4 hidden in an IPv6 literal: ::ffff:7f00:1, ::ffff:127.0.0.1, ::7f00:1 (compatible), 64:ff9b::7f00:1 (NAT64) → '127.0.0.1' | null */
export function embeddedV4(h) {
  const s = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!s.includes(':')) return null;
  const g = v6groups(s);
  if (!g) return null;
  const v4 = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  if (g.slice(0, 5).every(x => x === 0) && (g[5] === 0xffff || (g[5] === 0 && g[6] !== 0))) return v4;
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every(x => x === 0)) return v4;
  return null;
}
/** A literal private address, including IPv4 inside IPv6 forms (util.isPrivateIp sees only the dotted ::ffff: form). */
export function isPrivateLiteral(h) {
  const s = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!s) return false;
  if (U.isPrivateIp(s)) return true;
  const v4 = embeddedV4(s);
  return !!v4 && U.isPrivateIp(v4);
}
// A local dev host gets http:// when typed without a scheme (localhost:3000, 127.0.0.1:8080, 192.168.0.10, [::1]:5173, intranet name)
export function isLocalHostname(h) {
  h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!h) return false;
  if (h === 'localhost' || /\.(localhost|local|test|internal|lan|home\.arpa)$/.test(h)) return true;
  if (/^[\d.]+$/.test(h) || h.includes(':')) return isPrivateLiteral(h);
  return !h.includes('.'); // single-label name: intranet
}
/**
 * Site address from what a person (or a search, or an agent) gave → { url, warnings, error }.
 * Only http(s); no scheme → https:// (local hosts and an explicit :80 → http://); login and password are cut out;
 * tracking parameters removed; the result is safe to print inside "…" in a command.
 */
export function parseSiteUrl(input, lang = 'ru') {
  const en = lang === 'en';
  const warnings = [];
  // «http:/site» and «http:site» are typos of «http://site»
  const s = String(input || '').trim().replace(/^(https?):\/?(?!\/)/i, '$1://');
  if (!s) return { url: null, warnings, error: null };
  const scheme = s.match(/^([a-z][a-z0-9+.-]*):/i);
  const hostPort = /^[a-z0-9.-]+:\d+([/?#]|$)/i.test(s) && !s.includes('://');
  const knownScheme = scheme && /^(mailto|tel|sms|javascript|vbscript|data|file|ftps?|sftp|ssh|wss?|about|blob|chrome|edge|view-source|intent|tg|viber|whatsapp|skype|market|itms-apps)$/i.test(scheme[1]);
  // login:password@host without a scheme (the last @ ends the login part; a password may contain @)
  const credsNoScheme = !knownScheme && !s.includes('://') && /^[^/\s]*@[^/@\s]+(?:[/?#]|$)/.test(s);
  if (scheme && !/^https?$/i.test(scheme[1]) && (knownScheme || (!hostPort && !credsNoScheme))) {
    const shown = (knownScheme && !s.includes('://') ? s : s.replace(/^([a-z][a-z0-9+.-]*:\/\/)?[^/\s]*@/i, '$1***@')).slice(0, 60); // never echo a password
    return { url: null, warnings, error: en ? `Need a site address http(s)://…, not «${shown}».` : `Нужен адрес сайта вида http(s)://…, а не «${shown}».` };
  }
  const hadScheme = /^https?:\/\//i.test(s);
  let u;
  try { u = new URL(hadScheme ? s : 'http://' + s); } catch { return { url: null, warnings, error: null }; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname) return { url: null, warnings, error: null };
  if (u.hostname.endsWith('.')) u.hostname = u.hostname.replace(/\.+$/, '');
  const hn = u.hostname.toLowerCase();
  if (!HOST_OK.test(hn) && !V6_OK.test(hn)) {
    return { url: null, warnings, error: en ? `The host name «${encUnsafe(hn).slice(0, 60)}» has characters a site address cannot have.` : `В имени сайта «${encUnsafe(hn).slice(0, 60)}» есть недопустимые символы.` };
  }
  // an explicit :80 typed without a scheme stays http (URL drops the default port, so look at the input)
  const typedPort = hadScheme ? null : (s.match(/^(?:[^/?#@]*@)?(?:\[[^\]]*\]|[^/?#:@]*):(\d+)(?:[/?#]|$)/) || [])[1];
  if (!hadScheme && !isLocalHostname(u.hostname) && typedPort !== '80') u.protocol = 'https:';
  if (u.username || u.password) {
    u.username = ''; u.password = '';
    warnings.push(en ? 'Removed the login and password from the address: Revizor never signs in with credentials and does not store them. For a closed beta use --stage beta or send screenshots.'
      : 'Убрал из адреса логин и пароль: Ревизор не входит под учётными данными и не хранит их. Закрытую бету — с --stage beta или скриншотами.');
  }
  u.hash = '';
  const dropped = [...u.searchParams.keys()].filter(k => TRACKING_PARAM.test(k));
  for (const k of dropped) u.searchParams.delete(k);
  if (dropped.length) warnings.push(en ? `Removed tracking parameters from the address: ${dropped.join(', ')}.` : `Убрал из адреса метки: ${dropped.join(', ')} — их не открываем.`);
  return { url: `${u.protocol}//${u.host}${encUnsafe(u.pathname)}${encUnsafe(u.search)}`, warnings, error: null };
}
/** Address safe for a command line, or null (bad scheme, bad host). */
export function safeUrl(input) { return parseSiteUrl(typeof input === 'string' ? input : input?.url).url; }
/** A --page value (path or address) safe to print inside "…" in a command, or null. A bare word is a path. */
export function safePage(input, lang = 'ru') {
  const s = String(input || '').trim();
  if (!s) return null;
  const first = s.split(/[/?#]/)[0];
  const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) || (!s.startsWith('/') && (/\./.test(first) || /:\d+$/.test(first) || /^localhost$/i.test(first)));
  if (isUrl) return parseSiteUrl(s, lang).url;
  let u;
  try { u = new URL(s.startsWith('/') && !s.startsWith('//') ? s : '/' + s.replace(/^\/+/, ''), 'http://page.invalid'); } catch { return null; }
  if (u.host !== 'page.invalid') return null;
  return encUnsafe(u.pathname) + encUnsafe(u.search);
}

// ---------- helpers over RUN files ----------
const fwd = p => String(p).replace(/\\/g, '/');
const qq = s => `"${fwd(s)}"`;
function nodeCmd(script, ...args) { return ['node', qq(join(ROOT, 'scripts', `${script}.mjs`)), ...args.filter(Boolean)].join(' '); }
function j(run, rel) { return U.readJSON(join(run, rel), null); }
function mtime(p) { try { return statSync(p).mtimeMs; } catch { return 0; } }
function ls(dir) { try { return readdirSync(dir); } catch { return []; } }
function dirSize(dir) {
  let n = 0;
  for (const name of ls(dir)) { const p = join(dir, name); try { const st = statSync(p); n += st.isDirectory() ? dirSize(p) : st.size; } catch {} }
  return n;
}
const STALE_RUNNING_MS = 45 * 60 * 1000; // an agent "running" longer than this is presumed dead
const val = (s, k) => {
  const v = (s.done || {})[k] || 'todo';
  if (v === 'running' && Date.now() - new Date((s.since || {})[k] || s.updated || 0).getTime() > STALE_RUNNING_MS) return 'todo';
  return v;
};
const sinceMs = (s, k) => { const t = Date.parse((s.since || {})[k] || ''); return Number.isNaN(t) ? 0 : t; };
function newestIn(run, dirs) { return Math.max(0, ...dirs.flatMap(d => ls(join(run, d)).map(n => mtime(join(run, d, n))))); }
const okv = v => v === 'ok' || v === 'skipped';
const finalFailed = (s, k) => val(s, k) === 'failed' && ((s.attempts || {})[k] || 0) >= 2;

// ---------- findings files: present, valid by the validate.mjs schema? ----------
let V = null; // validate.mjs — loaded lazily: it imports this module itself
/** Load the schema of validate.mjs (call before nextStep; without it a file only has to parse). */
export async function loadValidator() {
  if (V === null) { try { V = await import('./validate.mjs'); } catch { V = false; } }
  return V;
}
const FSTAT = new Map();
function lensFiles(run, lens, round) {
  const e = lens.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&');
  const re = round === 2 ? new RegExp(`^${e}(\\.r2(\\.part\\d+)?|\\.part\\d+\\.r2)\\.json$`) : new RegExp(`^${e}(\\.part\\d+)?\\.json$`);
  return ls(join(run, 'findings')).filter(n => re.test(n)).sort().map(n => join(run, 'findings', n));
}
/** → { state: 'ok'|'invalid'|'missing', fatal, errors [], files [], mtime } */
export function findingsStatus(run, lens, round = 1) {
  const files = lensFiles(run, lens, round);
  if (!files.length) return { state: 'missing', fatal: false, errors: [], files, mtime: 0 };
  const times = files.map(mtime);
  const key = `${files.join('|')}@${times.join(',')}@${V ? 1 : 0}`;
  if (FSTAT.has(key)) return FSTAT.get(key);
  const errors = []; let fatal = false;
  for (const f of files) {
    if (V) {
      const r = V.validateFile(f, { type: 'findings', run });
      if (!r.ok) { if (r.fatalDoc || !r.data) fatal = true; for (const e of r.errors) errors.push(`${basename(f)}${e.path ? ' · ' + e.path : ''}: ${e.msg}`); }
    } else {
      let d = null;
      try { d = JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { /* broken */ }
      if (!d || !Array.isArray(d.findings)) { fatal = true; errors.push(`${basename(f)}: JSON не читается или нет массива findings`); }
    }
  }
  const res = { state: errors.length ? 'invalid' : 'ok', fatal, errors, files, mtime: Math.max(...times) };
  FSTAT.set(key, res);
  return res;
}
/**
 * One lens of one round → { st, k, fs }:
 *   ok — valid file; accepted — file still has schema errors after one fix (merge takes what passes);
 *   fix — file has schema errors: one cheap «fix only» job; rerun — no file; running; failed — gave up (2 failures); skipped.
 */
export function lensState(s, run, lens, round = 1) {
  const k = round === 2 ? `r2:${lens}` : `lens:${lens}`;
  const v = val(s, k);
  if (v === 'skipped') return { st: 'skipped', k };
  const fs = findingsStatus(run, lens, round);
  if (fs.state === 'ok') return { st: 'ok', k, fs };
  if (finalFailed(s, k)) return { st: 'failed', k, fs };
  if (v === 'running') return { st: 'running', k, fs };
  if (fs.state === 'missing') return { st: 'rerun', k, fs };
  const fix = (s.fix || {})[k];
  if (fix && (fs.mtime > fix.mtime || (['ok', 'partial'].includes(v) && sinceMs(s, k) > Date.parse(fix.issued)))) return { st: fs.fatal ? 'failed' : 'accepted', k, fs };
  return { st: 'fix', k, fs };
}
const SETTLED = new Set(['ok', 'accepted', 'failed', 'skipped']);
const USABLE = new Set(['ok', 'accepted']);
function lensSettled(s, run, lens, round = 1) { return SETTLED.has(lensState(s, run, lens, round).st); }
function lensOk(s, run, lens, round = 1) { return USABLE.has(lensState(s, run, lens, round).st); }

function severities(run, lens) {
  const out = new Set();
  for (const f of lensFiles(run, lens, 1)) for (const x of U.readJSON(f, null)?.findings || []) out.add(x.severity);
  return out;
}
function countFindings(run) {
  const c = { P0: 0, P1: 0, P2: 0, P3: 0 };
  for (const f of ls(join(run, 'findings'))) {
    if (!f.endsWith('.json')) continue;
    const d = j(run, `findings/${f}`);
    for (const x of d?.findings || []) if (c[x.severity] !== undefined) c[x.severity]++;
  }
  return c;
}
function modelFor(roles, models = 'balanced') {
  if (models === 'economy') return 'sonnet';
  if (models === 'max') return 'inherit';
  return roles.some(r => INHERIT_BALANCED.has(r)) ? 'inherit' : 'sonnet';
}

// Conditional lenses (ecommerce, i18n) from brief.json and pages.json
export function conditionals(run) {
  const brief = j(run, 'brief.json') || j(run, 'brief.input.json') || {};
  const pages = j(run, 'pages.json') || {};
  const why = {};
  const tpl = [...Object.keys(pages.by_template || {}), ...(pages.selected || []).map(p => p.template || '')].join(' ').toLowerCase();
  let ecommerce = false;
  if (brief.vertical === 'shop' || pages.vertical_guess === 'shop') { ecommerce = true; why.ecommerce = 'тип сайта — магазин'; }
  else if (/\b(cart|basket|korzina|checkout|product|catalog)\b/.test(tpl)) { ecommerce = true; why.ecommerce = 'есть шаблоны каталога/карточки/корзины'; }
  const langs = new Set([...(pages.languages || []).map(l => l.lang), ...((brief.site || {}).languages || [])].filter(Boolean));
  let i18n = false;
  if (langs.size > 1) { i18n = true; why.i18n = `языковых версий: ${langs.size}`; }
  else if ((brief.market || {}).value === 'intl' && [...langs][0] && [...langs][0] !== 'ru') { i18n = true; why.i18n = 'зарубежный рынок, контент не на русском'; }
  return { ecommerce, i18n, why };
}

/** Agents of the lens phase. Stored in state.plan on first use so the list stays stable. */
export function computePlan(s, run) {
  const f = s.flags || {};
  const depth = PRESET_GROUPS[f.depth] ? f.depth : 'standard';
  let groups, cond = { ecommerce: false, i18n: false, why: {} };
  if (s.mode === 'quick') {
    const t = f.topic;
    groups = !t || t === 'health' ? [] : t === 'seo' ? [['seo-tech', 'seo-content']] : t === 'forms' ? [['forms', 'ux']] : [[t]];
  } else {
    groups = PRESET_GROUPS[depth].map(g => [...g]);
    cond = conditionals(run);
    const forced = new Set(f.lenses || []);
    for (const c of ['ecommerce', 'i18n']) {
      if (!cond[c] && !forced.has(c)) continue;
      const host = c === 'ecommerce' ? 'product' : 'copy';
      const g = depth === 'lite' ? groups.find(x => x.includes(host)) : null;
      if (g) g.push(c); else groups.push([c]);
    }
    if (f.lenses?.length) groups = groups.map(g => g.filter(l => f.lenses.includes(l)));
    if (f.skip?.length) groups = groups.map(g => g.filter(l => !f.skip.includes(l)));
    groups = groups.filter(g => g.length);
  }
  const agents = groups.map(g => agentFor(g, f.models, s.mode === 'quick' && f.topic === 'forms' ? 'ux — только сценарии форм' : undefined));
  return { agents, lenses: groups.flat(), conditionals: cond, computed: U.nowIso() };
}
function agentFor(g, models, note) {
  return { id: g.length === 1 ? g[0] : `group:${g.join('+')}`, type: g.length === 1 ? `revizor:${g[0]}` : 'revizor:group', lenses: g, model: modelFor(g, models), note };
}

function skepticAgents(s, okLenses, run, depthOverride) {
  const f = s.flags || {};
  const depth = depthOverride || f.depth;
  if (s.mode === 'quick') okLenses = okLenses.filter(l => { const v = severities(run, l); return v.has('P0') || v.has('P1'); });
  else if (depth === 'lite') okLenses = okLenses.filter(l => severities(run, l).has('P0'));
  const make = (name, lenses, scope) => ({ id: `skeptic:${name}`, type: 'revizor:skeptic', lenses, scope, model: modelFor(['skeptic'], f.models), method: name });
  if (s.mode === 'quick') return okLenses.length ? [make('quick', okLenses, 'P0-P1')] : [];
  if (depth === 'deep') return okLenses.map(l => make(l, [l], 'P0-P2'));
  const map = depth === 'lite' ? SKEPTIC_LITE : SKEPTIC_STD;
  const scope = depth === 'lite' ? 'P0' : 'P0-P1 (+P2 выборочно, не меньше 3)';
  const out = [];
  const placed = new Set();
  for (const [name, members] of Object.entries(map)) {
    const ls2 = okLenses.filter(l => members.includes(l));
    ls2.forEach(l => placed.add(l));
    if (ls2.length) out.push(make(name, ls2, scope));
  }
  const rest = okLenses.filter(l => !placed.has(l));
  if (rest.length) out.push(make('other', rest, scope));
  return out;
}

// ---------- estimate (knowledge/cost.md) ----------
const mid = r => (r[0] + r[1]) / 2;
const add = (a, b, n = 1) => [a[0] + b[0] * n, a[1] + b[1] * n];
const round5 = x => Math.max(5, Math.round(x / 5) * 5);
function wavesTime(items, parallel, timeOf) {
  let t = [0, 0];
  for (let i = 0; i < items.length; i += parallel) {
    const w = items.slice(i, i + parallel).map(timeOf);
    t = add(t, [Math.max(...w.map(x => x[0])), Math.max(...w.map(x => x[1]))]);
  }
  return t;
}
function loadWord(n, models, lang = 'ru') {
  const L = costModel().load_levels;
  let lvl = n <= L.low_max_agents ? 0 : n <= L.medium_max_agents ? 1 : 2;
  if (models === 'max' && lvl < 2) lvl++;
  return { level: ['low', 'medium', 'high'][lvl], word: (lang === 'en' ? ['low', 'medium', 'high'] : ['низкая', 'средняя', 'высокая'])[lvl] };
}
/** Estimate of a full/quick run for a depth: { depth, agents, lens_agents, minutes: [lo, hi], load, pages, parts } */
export function estimateRun(s, run, { depth, lang = 'ru' } = {}) {
  const f = s.flags || {};
  const C = costModel();
  const A = C.agent_min;
  const parallel = Math.max(1, Math.min(20, Number(f.parallel) || 6));
  const mode = s.mode === 'quick' ? 'quick' : 'full';
  if (depth === 'health' || (mode === 'quick' && f.topic === 'health')) { // also «only quick checks» offered in the full brief
    const t = add(C.pipeline_min.health, A.editor_quick);
    return { depth: 'health', agents: 1, lens_agents: 0, minutes: [round5(t[0]), round5(t[1])], load: loadWord(1, f.models, lang), pages: 6 };
  }
  const d = depth || (PRESET_GROUPS[f.depth] ? f.depth : 'standard');
  const plan = computePlan({ ...s, flags: { ...f, depth: d } }, run);
  const pageList = (f.page || []).length;
  const pages = mode === 'quick' ? (pageList || 3) : pageList || (d === f.depth && Number(f.pages) > 0 ? Number(f.pages) : PAGES_BY_DEPTH[d]);
  let t = add(C.pipeline_min.fixed, mode === 'quick' ? C.pipeline_min.quick_per_page : C.pipeline_min.per_page, pages);
  const lensTime = a => (a.lenses.length > 1 ? A.group : A.lens);
  t = add(t, wavesTime(plan.agents, parallel, lensTime));
  const skeptics = mode === 'quick' ? (plan.agents.length ? 1 : 0) : d === 'lite' ? 2 : d === 'deep' ? plan.lenses.length : 4;
  if (skeptics) t = add(t, wavesTime(Array(skeptics).fill(0), parallel, () => A.skeptic));
  let agents = plan.agents.length + skeptics + 1; // + editor
  t = add(t, mode === 'quick' ? A.editor_quick : A.editor);
  if (mode === 'full') {
    agents += 1; t = add(t, A.scout);
    const critics = d === 'deep' ? 2 : 1;
    agents += critics; t = add(t, A.critic, critics);
    const ext = f.audience === 'external';
    if (f.scores && !ext) { agents += 2; t = add(t, A.scorer); }
    if (f.strategy && !ext) { agents += 3; t = add(t, A.strategist); t = add(t, A.critic); }
  }
  const extra = mode === 'full' && d !== 'lite' && !(plan.conditionals.ecommerce && plan.conditionals.i18n) && !existsSync(join(run, 'pages.json')) ? 2 : 0;
  return { depth: d, agents, agents_extra_max: extra, lens_agents: plan.agents.length, minutes: [round5(t[0]), round5(t[1])],
    load: loadWord(agents, f.models, lang), pages, parallel, parts: Number(f.parts) > 1 ? Number(f.parts) : 0, source: C.source, measured: !!C.measured };
}
const DEPTH_WORD = { ru: { lite: 'облегчённо', standard: 'стандарт', deep: 'глубоко' }, en: { lite: 'light', standard: 'standard', deep: 'deep' } };
function estimateLine(e, lang = 'ru') {
  const name = `${DEPTH_WORD[lang === 'en' ? 'en' : 'ru'][e.depth] || e.depth} (${e.depth})`;
  if (lang === 'en') return `${name}: agents ≈ ${e.agents}${e.agents_extra_max ? ` (+0–${e.agents_extra_max} by site type)` : ''}, ≈ ${e.minutes[0]}–${e.minutes[1]} min, load on the limit: ${e.load.word}`;
  return `${name}: агентов ≈ ${e.agents}${e.agents_extra_max ? ` (+0–${e.agents_extra_max} по типу сайта)` : ''}, ≈ ${e.minutes[0]}–${e.minutes[1]} мин, нагрузка на лимит: ${e.load.word}`;
}
/** Estimate of a rivals or recheck run: { agents, minutes, load, sites | groups, pages } */
export function estimateOther(s, run, lang = 'ru') {
  const f = s.flags || {};
  const C = costModel(), A = C.agent_min, PM = C.pipeline_min;
  const parallel = Math.max(1, Math.min(20, Number(f.parallel) || 6));
  if (s.mode === 'rivals') {
    const sites = [...new Set([...(f.prev_run_fresh ? [] : [f.url]), ...(f.urls || [])].filter(Boolean).map(u => U.hostKey(u)))].length;
    const cards = sites; // a card per captured site (ours too, when there is no fresh run of it)
    let t = add([0, 0], PM.rivals_per_site, sites);
    t = add(t, wavesTime(Array(cards).fill(0), parallel, () => A['rival-analyst']));
    t = add(add(add(t, A.strategist), A.critic), A.editor);
    const agents = cards + 3;
    return { mode: 'rivals', sites, agents, minutes: [round5(t[0]), round5(t[1])], load: loadWord(agents, f.models, lang) };
  }
  // recheck: pages and groups of the old run
  const oldPages = (j(run, 'pages.from.json') || (f.from_run ? U.readJSON(join(f.from_run, 'pages.json'), null) : null) || {}).selected || [];
  let groups = (j(run, 'recheck/plan.json') || {}).groups?.length;
  if (!groups && f.from_run) {
    const items = U.readJSON(join(f.from_run, 'report', 'findings.json'), null)?.items || [];
    groups = new Set(items.map(x => (x.lenses || [])[0] || x.lens).filter(Boolean)).size || null;
  }
  groups = Math.min(Math.max(groups || 4, 1), 12);
  const pages = oldPages.length || PAGES_BY_DEPTH.standard;
  let t = add(PM.fixed, PM.per_page, pages);
  t = add(t, wavesTime(Array(groups + 1).fill(0), parallel, () => A.rechecker));
  t = add(add(t, A.skeptic), A.editor);
  const agents = groups + 3; // groups + fresh + skeptic + editor
  return { mode: 'recheck', groups, pages, agents, minutes: [round5(t[0]), round5(t[1])], load: loadWord(agents, f.models, lang) };
}
/** Minutes left (midpoint), for the progress line. null when unknown. */
function remainingMinutes(s, run) {
  if (!['full', 'quick'].includes(s.mode)) return null;
  const f = s.flags || {};
  const C = costModel(), A = C.agent_min;
  const parallel = Math.max(1, Math.min(20, Number(f.parallel) || 6));
  const e = estimateRun(s, run, {});
  let m = 0;
  const pv = val(s, 'pipeline');
  if (pv !== 'ok') {
    const pipe = f.topic === 'health' ? mid(C.pipeline_min.health) : mid(C.pipeline_min.fixed) + mid(s.mode === 'quick' ? C.pipeline_min.quick_per_page : C.pipeline_min.per_page) * e.pages;
    m += pv === 'partial' ? pipe / 2 : pipe;
  }
  if (f.topic === 'health') return Math.round(m + (existsSync(join(run, 'report', 'report.html')) ? 0 : mid(A.editor_quick)));
  if (s.mode === 'full' && !j(run, 'brief.json')) m += mid(A.scout);
  const plan = s.plan || computePlan(s, run);
  const left = plan.agents.filter(a => !a.lenses.every(l => lensSettled(s, run, l)));
  m += mid(wavesTime(left, parallel, a => (a.lenses.length > 1 ? A.group : A.lens)));
  const anyVerify = ls(join(run, 'verify')).some(n => n.endsWith('.json') && !n.endsWith('.lint.json'));
  if (!anyVerify && !existsSync(join(run, 'critic', 'round-1.json'))) {
    const sk = s.mode === 'quick' ? 1 : f.depth === 'lite' ? 2 : f.depth === 'deep' ? plan.lenses.length : 4;
    m += mid(wavesTime(Array(sk).fill(0), parallel, () => A.skeptic));
  }
  if (s.mode === 'full' && !existsSync(join(run, 'critic', 'round-1.json'))) m += mid(A.critic);
  const main = join(run, 'report', 'report.html');
  if (!existsSync(main)) m += mid(s.mode === 'quick' ? A.editor_quick : A.editor);
  return Math.round(m);
}

// ---------- the scenario ----------
function header(s, run, extra = {}) {
  const f = s.flags || {};
  const brief = j(run, 'brief.json') || {};
  const market = (brief.market || {}).value || f.market || 'auto';
  const lines = [`ROOT=${fwd(ROOT)}`, `RUN=${fwd(run)}`];
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== null && v !== '') lines.push(`${k}=${v}`);
  lines.push(`PROFILE=${f.profile || 'standard'} · AUDIENCE=${f.audience || 'owner'} · MARKET=${market} · VERTICAL=${brief.vertical || f.vertical || 'auto'} · DEPTH=${f.depth || 'standard'} · LANG=${brief.lang || f.lang || 'ru'}`);
  const manual = join(run, 'manual');
  if (ls(manual).some(n => /\.(jpe?g|png|webp)$/i.test(n))) lines.push(`MANUAL_SHOTS=${fwd(manual)} — сайт не пустил скрипты к части страниц, смотри эти кадры (<страница>-390.jpg, <страница>-1440.jpg)`);
  if ((f.page || []).length) {
    const pids = ((j(run, 'pages.json') || {}).selected || []).map(p => p.pid).filter(Boolean);
    lines.push(`PAGES=${pids.join(',') || f.page.join(',')} — только страницы из --page; главной (pid home) в прогоне нет, первая страница — ${pids[0] || 'p01'}`);
  }
  return lines;
}
function agentLine(a, i) {
  const bits = [`${i + 1}. ${a.type}`];
  if (a.type === 'revizor:group' || a.type === 'revizor:skeptic') bits.push(`LENSES=${a.lenses.join(',')}`);
  if (a.method) bits.push(`METHOD=${a.method}`);
  if (a.scope) bits.push(`SCOPE=${a.scope}`);
  if (a.mode) bits.push(`MODE=${a.mode}`);
  if (a.task === 'fix') bits.push(`TASK=fix — только исправить ${a.file} по ошибкам validate (ревью не повторять, находки не добавлять); ошибки: ${a.errors.join('; ').slice(0, 260)}`);
  if (a.extra) bits.push(a.extra);
  if (a.note) bits.push(`(${a.note})`);
  bits.push(`model ${a.model}`);
  return '  ' + bits.join(' · ');
}
const FALLBACK = 'Тип агента не найден → general-purpose с промтом «Прочитай <ROOT>/agents/<id>.md и действуй как этот агент» (id без «revizor:»).';

function wave(s, agents, settledFn, busy = 0) {
  const parallel = Math.max(1, Math.min(20, Number(s.flags?.parallel) || 6));
  const pending = agents.filter(a => !settledFn(a));
  return { pending, now: pending.slice(0, Math.max(0, parallel - busy)), parallel };
}

function agentsStep(s, run, { id, stage, title, agents, settled, keyOf, round = 1, extraHeader = {}, after = [] }) {
  const all = wave(s, agents, settled);
  if (!all.pending.length) return null;
  const running = all.pending.filter(a => keyOf(a).some(k => val(s, k) === 'running'));
  const w = wave(s, agents, a => settled(a) || running.includes(a), running.length);
  if (!w.now.length) return { id, stage, title, wait: true, agents: [], lines: [`Ещё работают: ${running.map(a => a.id).join(', ')}. Дождитесь их ответа, потом снова --next. Если сессия прерывалась — init-run.mjs --resume сбросит «running».`] };
  const retry = w.now.filter(a => a.task !== 'fix' && keyOf(a).some(k => val(s, k) === 'failed'));
  const fixes = w.now.filter(a => a.task === 'fix');
  const k0 = keyOf(w.now[0]);
  const lines = [
    `Запустите одним сообщением агентов: ${w.now.length} (Agent; не больше ${w.parallel} одновременно; в очереди ${w.pending.length}).`,
    retry.length ? `Повтор после сбоя: ${retry.map(a => a.id).join(', ')} (второй сбой — пропуск, тема уйдёт в «не проверено»).` : null,
    fixes.length ? `Исправление файлов: ${fixes.map(a => a.id.replace(/^fix:/, '')).join(', ')} — короткая задача TASK=fix (validate нашёл ошибки схемы); второй раз с ошибками — merge возьмёт то, что проходит.` : null,
    'Первые строки промта каждого агента (общие):',
    ...header(s, run, { ROUND: round, ...extraHeader }).map(x => '  ' + x),
    'Агенты (их строки LENSES=…, METHOD=…, SCOPE=…, MODE=…, TASK=…, GROUP=…, HOST=… — добавить в промт сразу после ROUND; model — параметр Agent):',
    ...w.now.map(agentLine),
    FALLBACK,
    running.length ? `Ещё работают (не запускать повторно): ${running.map(a => a.id).join(', ')}.` : null,
    `Агент упал или не записал файл → --set <ключ>=failed на каждый его ключ; для 1-го: ${nodeCmd('state', '--run', qq(run), ...k0.flatMap(k => ['--set', `${k}=failed`]))}`,
    ...after,
  ].filter(x => x !== null);
  return { id, stage, title, lines, agents: w.now.map(a => ({ ...a, keys: keyOf(a) })) };
}

function cmdStep(id, stage, title, commands, lines = []) { return { id, stage, title, commands, lines }; }

function reportFiles(s, run) {
  const r = p => fwd(join(run, 'report', p));
  if (s.mode === 'rivals') return [r('rivals.html'), r('rivals.xlsx')];
  if (s.mode === 'recheck') {
    const x = ls(join(run, 'report')).filter(n => /^registry-recheck-.*\.xlsx$/.test(n)).sort().pop();
    return [r('recheck.html'), x ? r(x) : r('registry-recheck-<дата>.xlsx')];
  }
  const out = [r('report.html'), r('registry.xlsx')];
  if (s.flags?.pdf) out.push(r('report.pdf'));
  return out;
}

// Which pipeline stage failed, how many times, and its last error line (pipeline.json → stages[].last_error, then stdout copies).
// Attempts: the most of the stage's own count and pipeline=failed marks (a crash without «PIPELINE …» leaves the stage at 1).
function pipelineFailure(s, run) {
  const pj = j(run, 'pipeline.json') || {};
  const stages = pj.stages || {};
  const cand = Object.entries(stages).filter(([, v]) => v && v.status === 'failed').map(([k]) => k);
  const order = ['crawl', 'snapshot', ...cand];
  const stage = order.find(x => cand.includes(x)) || ['crawl', 'snapshot'].find(x => val(s, `pipeline:${x}`) === 'failed') || null;
  const stageAtt = stage ? Math.max((s.attempts || {})[`pipeline:${stage}`] || 0, Number(stages[stage]?.attempts) || 0) : 0;
  const att = Math.max(stageAtt, (s.attempts || {}).pipeline || 0, 1);
  let last = stage ? String(stages[stage]?.last_error || stages[stage]?.error || '').split(/\r?\n/).map(x => x.trim()).find(Boolean) || '' : '';
  const read = p => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
  if (stage && !last) {
    const pl = read(join(run, 'stdout', 'pipeline.md')).split(/\r?\n/).filter(l => new RegExp(`\\]\\s${stage}\\s—`).test(l)).pop() || '';
    last = pl.includes(' · ') ? pl.slice(pl.lastIndexOf(' · ') + 3) : '';
    if (!last) last = read(join(run, 'stdout', `${stage}.md`)).split(/\r?\n/).map(x => x.trim()).filter(Boolean).pop() || '';
  }
  return { stage, attempts: att, last: last.slice(0, 200) };
}

// Agents of the lens phase that still have work: missing files → (narrowed) reruns, schema errors → cheap fix jobs.
function lensJobs(s, run, agents, round = 1) {
  const jobs = [];
  const f = s.flags || {};
  for (const a of agents) {
    const st = a.lenses.map(l => ({ l, ...lensState(s, run, l, round) }));
    const redo = st.filter(x => x.st === 'rerun' || x.st === 'running').map(x => x.l);
    if (redo.length) jobs.push(redo.length === a.lenses.length ? a : { ...agentFor(redo, f.models, a.note), extra: a.extra });
    for (const x of st.filter(y => y.st === 'fix')) {
      jobs.push({ id: `fix:${x.l}`, type: `revizor:${x.l}`, lenses: [x.l], task: 'fix', model: 'sonnet',
        file: `findings/${basename(x.fs.files[0] || `${x.l}.json`)}${x.fs.files.length > 1 ? ` (+${x.fs.files.length - 1})` : ''}`, errors: x.fs.errors.slice(0, 3) });
    }
  }
  return jobs;
}
const r2LensesOf = (s, run) => {
  const c = j(run, 'critic/round-1.json');
  if (s.mode !== 'full' || !c || s.flags?.depth === 'lite' || !/ещ[её]\s*круг|more round|another round/i.test(String(c.verdict || ''))) return [];
  const known = new Set((s.plan || computePlan(s, run)).lenses);
  return [...new Set((c.gaps || []).map(g => g.lens).filter(l => known.has(l)))];
};
// Parts (--parts N, «по частям» in skills/full): lens agents split into N chunks; a pause after each chunk, --resume goes on
function partsOf(agents, n) {
  const size = Math.ceil(agents.length / n);
  const out = [];
  for (let i = 0; i < agents.length; i += size) out.push(agents.slice(i, i + size));
  return out;
}
function settledAt(s, run, lenses) {
  return Math.max(0, ...lenses.map(l => Math.max(sinceMs(s, `lens:${l}`), findingsStatus(run, l, 1).mtime || 0)));
}

// A competitor counts as captured only when rivals.mjs finished it (capture.json complete; a closed site is complete too)
function captureDone(run, h, full = false) {
  const c = j(run, `rivals/${h}/capture.json`);
  return !!(c && c.complete && (!full || c.mode === 'full' || c.blocked));
}
const GROUP_WORDS = { direct: 'прямой', comparable: 'сопоставимый', benchmark: 'ориентир' };
// Lenses do not run measurement scripts; they write «оркестратору: перезапустить <скрипт> …» into notes/<lens>.md
const PIPE_STAGES = ['crawl', 'snapshot', 'seo', 'headers', 'domain', 'mobile', 'a11y', 'forms', 'vision', 'privacy', 'textscan', 'perf'];
export function rerunRequests(run) {
  const out = [];
  for (const n of ls(join(run, 'notes')).filter(x => x.endsWith('.md')).sort()) {
    let text = '';
    try { text = readFileSync(join(run, 'notes', n), 'utf8'); } catch { continue; }
    for (const m of text.matchAll(/оркестратору:\s*перезапустить\s+([^\n«»"]{2,160})/gi)) {
      const t = m[1].trim().replace(/[.;,]+$/, '');
      const w = t.toLowerCase();
      const s0 = (w.match(/^([a-z0-9-]+)(?:\.mjs)?\b/) || [])[1];
      const stage = /^(контраст|снимок)|snapshot/.test(w) ? 'snapshot' : PIPE_STAGES.includes(s0) ? s0 : null;
      // what else the request names: pages (pipeline reruns a stage on all pages) and flags we act on
      const pids = [...new Set(w.match(/\b(home|p\d{2,3})\b/g) || [])];
      out.push({ lens: n.replace(/\.md$/, ''), text: t.slice(0, 120), stage, reject: /--reject-test/.test(w), spell: /--spell\b/.test(w), pids });
    }
  }
  return out;
}

// Findings the editor (editorial.json → notes) or the critic (critic/round-N.json) send back to a skeptic:
// «нужна перепроверка: <id> — …», «нужна проверка скептиком: <id>, критик хочет <P>». Only ids of the findings format.
const RECHECK_ASK = /нужна\s+(?:пере)?проверка(?:\s+скептиком)?\s*:\s*([^\n]{1,400})/gi;
const FINDING_ID = /\b[a-z][a-z0-9-]*-(?:r2-|v)?\d{2,3}\b/g;
export const lensOfId = id => String(id).replace(/-(?:r2-|v)?\d{2,3}$/, '');
export function recheckIds(run) {
  const texts = [];
  const walk = v => { if (typeof v === 'string') texts.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') Object.values(v).forEach(walk); };
  const ed = j(run, 'report/editorial.json');
  if (ed) walk([ed.note, ed.notes]);
  for (const n of ls(join(run, 'critic')).filter(x => /^round-\d+\.json$/.test(x)).sort()) walk(j(run, `critic/${n}`));
  const ids = new Set();
  for (const t of texts) {
    for (const m of t.matchAll(RECHECK_ASK)) {
      const head = m[1].split(/\s[—–-]\s|[.;]/)[0]; // ids go before the reason
      for (const id of head.match(FINDING_ID) || []) if (AGENT_LENSES.includes(lensOfId(id))) ids.add(id);
    }
  }
  return [...ids].slice(0, 30);
}

/** The ordered steps of a mode. Each returns null when done/not applicable, or a step object. */
function stepsFor(s, run, lang = 'ru') {
  const f = s.flags || {};
  const mode = s.mode || 'full';
  const brief = () => j(run, 'brief.json');
  const briefIn = () => j(run, 'brief.input.json') || {};
  const pages = () => j(run, 'pages.json');
  const R = qq(run);
  // doctor reads the site address from state.json itself: no address in the printed command
  const resumeHint = `/revizor:${mode === 'quick' ? 'quick' : mode} --resume ${f.host_key || f.host || '<хост>'}`;
  const stopLine = what => `«Прогон остановлен на этапе ${what}. Всё сохранено в ${fwd(run)}. Продолжить: ${resumeHint}».`;
  const steps = [];

  // 1. environment
  steps.push(() => {
    if (okv(val(s, 'doctor'))) return null;
    if (val(s, 'doctor') === 'failed') return { id: 'setup', stage: 'blocked', title: 'нет окружения', stop: true,
      lines: ['Не хватает Node 22, браузера или записи в папку отчётов — прогон не начинаем (урезанного режима нет).', 'Покажите человеку строки установки из сводки doctor и предложите /revizor:setup.',
        `После установки и перезапуска Claude: ${nodeCmd('doctor', '--run', R)}`] };
    return cmdStep('doctor', 'init', 'проверка окружения', [nodeCmd('doctor', '--run', R)],
      ['Нет правил разрешений → одна строка: «будут вопросы о разрешениях; ответьте „разрешать всегда“ для node-скриптов Ревизора или запустите /revizor:setup».',
        'Есть строка о новой версии → покажите её человеку одной строкой.']);
  });

  if (mode === 'quick') steps.push(() => {
    if (f.topic) return null;
    return { id: 'topic', stage: 'init', title: 'тема', ask: true,
      lines: ['Тема не задана. Спросите AskUserQuestion: мобильная, скорость, тексты, SEO, доступность, формы + «Другое».',
        `Ответ: ${nodeCmd('init-run', '--run', R, '--answer', 'topic=<тема>')} (темы: ${QUICK_TOPICS.join(', ')}).`] };
  });

  if (mode === 'rivals') steps.push(() => {
    if ((f.urls || []).length || okv(val(s, 'candidates'))) return null;
    return { id: 'candidates', stage: 'init', title: 'список конкурентов', ask: true,
      lines: [subs === 'pro'
        ? 'Конкурентов в команде нет. По нише и региону (WebSearch/WebFetch) соберите до 6 кандидатов (подписка Pro: каждый сайт — отдельный агент): прямые, сопоставимые и 1–2 мировых ориентира.'
        : 'Конкурентов в команде нет. По нише и региону (WebSearch/WebFetch) соберите 8–15 кандидатов: прямые, сопоставимые и 2–3 мировых ориентира.',
        'Спросите AskUserQuestion: «Взять эти» / «Дам свой список».',
        `Ответ — только файлом (адреса пришли из поиска или от человека, в командную строку их не подставлять): Write ${fwd(join(run, 'answers', 'rivals.json'))} — { "urls": ["https://…", "…"], "groups": { "<хост>": "прямой|сопоставимый|ориентир" } }`,
        `Затем: ${nodeCmd('init-run', '--run', R, '--answer-file', qq(join(run, 'answers', 'rivals.json')))}`] };
  });

  // 2. estimate (rivals, recheck): one block of lines, then estimate=ok
  if (mode === 'rivals' || mode === 'recheck') steps.push(() => {
    if (okv(val(s, 'estimate'))) return null;
    if (mode === 'rivals' && (!(f.urls || []).length || val(s, 'rivals_snap') !== 'todo' || ls(join(run, 'rivals')).length)) return null;
    if (mode === 'recheck' && val(s, 'pipeline') !== 'todo') return null; // runs of older versions: no estimate mid-way
    const e = estimateOther(s, run, lang);
    const C = costModel();
    const lines = [`Смета — ориентир по knowledge/cost.md${C.measured ? '' : ', уточняется замерами'}:`,
      mode === 'rivals'
        ? `  сайтов ${e.sites}: снимок скриптом (лимит не тратит), затем агентов ≈ ${e.agents} (по одному на сайт, стратег, критик, редактор); всего ≈ ${e.minutes[0]}–${e.minutes[1]} мин, нагрузка на лимит: ${e.load.word}`
        : `  страниц ${e.pages} (как в проверяемом прогоне), групп правок ≈ ${e.groups}: агентов ≈ ${e.agents} (перепроверка по группам, свежий взгляд, скептик, редактор); всего ≈ ${e.minutes[0]}–${e.minutes[1]} мин, нагрузка на лимит: ${e.load.word}`];
    if (mode === 'rivals' && subs === 'pro' && e.sites > 6) lines.push('Подписка Pro: каждый сайт — отдельный агент; бережнее взять до 6 конкурентов.');
    lines.push('Покажите человеку одним сообщением строки сметы и «Не закрывайте вкладку и не усыпляйте компьютер; ноутбук — на зарядку. В соседних вкладках работать можно».');
    return { id: 'estimate', stage: 'init', title: 'смета', commands: [nodeCmd('state', '--run', R, '--set', 'estimate=ok')], lines, estimate: e };
  });

  // 2. estimate — always in full (also with --no-questions): agents, minutes, load on the limit, presets
  const subs = f.subscription && costModel().subscriptions[f.subscription] ? f.subscription : null;
  const recDepth = subs ? costModel().subscriptions[subs].depth : (f.depth || 'standard');
  const estAll = () => ['lite', 'standard', 'deep'].map(d => estimateRun(s, run, { depth: d, lang }));
  if (mode === 'full') steps.push(() => {
    if (okv(val(s, 'estimate')) || okv(val(s, 'questions')) || val(s, 'pipeline') !== 'todo') return null; // runs of older versions: no estimate mid-way
    const cur = f.depth || 'standard';
    const ests = estAll();
    const health = estimateRun(s, run, { depth: 'health', lang });
    const C = costModel();
    const star = d => (d === recDepth ? '★ ' : '');
    const lines = [`Смета — ориентир по knowledge/cost.md${C.measured ? '' : ', уточняется замерами'}; сейчас выбрано ${cur}${f.parallel ? `, агентов одновременно ${f.parallel}` : ''}:`,
      ...ests.map(e => `  ${star(e.depth)}${estimateLine(e, lang)}${e.depth === cur ? ' ← выбрано' : ''}`),
      `  только быстрые проверки (замеры скриптами и короткий отчёт, 1 агент): ≈ ${health.minutes[0]}–${health.minutes[1]} мин, нагрузка: ${health.load.word}`];
    const MODEL_WORD = { economy: 'все агенты на Sonnet', balanced: 'темы на Sonnet, критик и редактор на модели сессии', max: 'все агенты на модели сессии' };
    if (subs === 'pro') lines.push('Подписка Pro: ★ облегчённо, все агенты на Sonnet, по 3 одновременно. Прогон может остановиться по лимиту — это штатно: всё сохранено, продолжение — ' + resumeHint + ' после сброса лимита. Стандарт и «глубоко» на Pro — по частям: в ответах брифа "parts": 3'
      + (f.no_questions ? ` (вопросы отключены — командой: ${nodeCmd('init-run', '--run', R, '--answer', 'depth=standard', '--answer', 'parts=3')}).` : '.'));
    else if (subs) { const P = C.subscriptions[subs]; lines.push(`Подписка ${subs}: по умолчанию ${DEPTH_WORD.ru[P.depth] || P.depth}, ${MODEL_WORD[P.models] || P.models}, агентов одновременно ${P.parallel}.`); }
    else lines.push('Подписка не указана (/revizor:setup спросит её один раз). На Pro рекомендуем «облегчённо»: стандарт и «глубоко» быстро съедают лимит.');
    if (Number(f.parts) > 1) lines.push(`По частям: ${f.parts} части линз; после каждой — пауза, продолжение — ${resumeHint}.`);
    lines.push('Покажите человеку одним сообщением строки сметы и «Не закрывайте вкладку и не усыпляйте компьютер; ноутбук — на зарядку. В соседних вкладках работать можно».');
    if (f.no_questions) lines.push('Вопросы отключены — выбор объёма не спрашиваем, идём с выбранным.');
    return { id: 'estimate', stage: 'init', no: 2, title: 'смета', commands: [nodeCmd('state', '--run', R, '--set', 'estimate=ok')],
      lines, estimate: { current: cur, recommended: recDepth, presets: ests, health } };
  });

  if (mode === 'full') steps.push(() => {
    if (f.no_questions || okv(val(s, 'questions'))) return null;
    const bi = briefIn();
    const ask = [...(bi.ask || [])];
    if (!ask.includes('depth')) ask.splice(Math.min(ask.length, ask.includes('do_not_touch') ? ask.length - 1 : ask.length), 0, 'depth');
    while (ask.length > 4) ask.splice(ask.indexOf('do_not_touch') >= 0 ? ask.indexOf('do_not_touch') : ask.length - 1, 1);
    const e = Object.fromEntries(estAll().map(x => [x.depth, x]));
    const NAMES = { lite: 'Облегчённо', standard: 'Стандарт', deep: 'Глубоко' };
    const opt = d => `«${d === recDepth ? '★ ' : ''}${NAMES[d]} (${d}, ≈ ${e[d].agents} агентов, ≈ ${e[d].minutes[0]}–${e[d].minutes[1]} мин)»`;
    const order = [recDepth, ...['lite', 'standard', 'deep'].filter(d => d !== recDepth)];
    const Q = {
      brief_last_ok: '«Бриф прошлого раза актуален?» → "brief_last_ok": "yes" | "no"',
      main_action: 'главное действие на сайте (варианты с главной + своё) → "main_action": "<текст>"',
      audience: 'кому отчёт: «Себе (я владелец)» / «Своей команде, с техническими деталями» / «Чужой команде или клиенту — вежливо, без внутренней кухни» → "audience": "owner" | "team" | "external"',
      depth: `объём (сейчас ${f.depth || 'standard'}), ровно 4 варианта: ${order.map(opt).join(' / ')} / «Только быстрые проверки (1 агент)»; «Отмена» — через «Другое» → "depth": "lite" | "standard" | "deep" | "quick"`
        + (subs === 'pro' && !(Number(f.parts) > 1) ? '; на Pro при "standard" или "deep" добавьте в тот же файл "parts": 3 (по частям, с паузами под лимит)' : ''),
      do_not_touch: 'необязательный текст «Есть то, что трогать не надо или уже решено?» → "do_not_touch": ["<текст>"]',
    };
    const af = join(run, 'answers', 'brief.json');
    return { id: 'questions', stage: 'init', no: 2, title: 'бриф', ask: true,
      lines: [f.profile === 'strict' ? 'Профиль strict: вопросы по одному.' : 'Один AskUserQuestion, не больше 4 вопросов:',
        ...ask.map(k => '  - ' + (Q[k] || k)),
        `Ответы — одним файлом, текст человека в командную строку не подставлять: Write ${fwd(af)} — JSON только с ключами, на которые есть ответ, например { "audience": "owner", "depth": "lite", "main_action": "…", "do_not_touch": ["…"] }.`,
        `Затем: ${nodeCmd('init-run', '--run', R, '--answer-file', qq(af))} (отмечает questions=ok). "depth": "quick" — прогон станет быстрой проверкой health.`,
        `Без ответов: ${nodeCmd('state', '--run', R, '--set', 'questions=skipped')}. «Отмена» → та же команда, и прогон не продолжать.`] };
  });

  // arguments of pipeline.mjs for this run (extra stages: reruns asked by lenses in quick)
  const pipelineArgs = (extraStages = []) => {
    const args = ['--run', R];
    if (mode === 'quick') {
      if (f.topic === 'health') args.push('--health');
      // quick privacy: privacy.mjs runs once, separately, with --reject-test (pipeline adds it only in full)
      else args.push('--stages', [...new Set(['crawl', 'snapshot', ...(TOPIC_STAGES[f.topic] || []).filter(x => !(f.topic === 'privacy' && x === 'privacy')), ...extraStages])].join(','));
    }
    if (mode === 'recheck' && existsSync(join(run, 'pages.from.json'))) args.push('--pages-from', qq(join(run, 'pages.from.json')));
    const pageList = (f.page || []).map(pg => safePage(pg)).filter(Boolean); // init-run stores them safe; checked again before printing
    if (pageList.length) for (const pg of pageList) args.push('--page', `"${pg}"`);
    else if (f.pages && !(mode === 'quick' && f.topic === 'health')) args.push('--pages', String(f.pages)); // health has its own 6 pages
    if (f.probe) args.push('--probe');
    if (f.allow_load_posts) args.push('--allow-load-posts');
    return args;
  };

  // pipeline
  steps.push(() => {
    if (mode === 'rivals') return null; // rivals snapshot instead
    const p = val(s, 'pipeline');
    if (p === 'ok') return null;
    const args = pipelineArgs();
    const cmd = nodeCmd('pipeline', ...args);
    const cmdAccept = nodeCmd('pipeline', ...args, '--accept-blocked');
    if (f.accept_blocked) args.push('--accept-blocked');
    const cmdNow = nodeCmd('pipeline', ...args);
    const std = ['Bash/PowerShell с timeout 600000. Код 75 (PIPELINE PARTIAL) — та же команда ещё раз. PIPELINE DONE — снова --next. PIPELINE BLOCKED (код 3) и PIPELINE FAILED (код 1) — снова --next (он скажет, что дальше).',
      `Код 1 без строки PIPELINE … (скрипт упал сам) → ${nodeCmd('state', '--run', R, '--set', 'pipeline=failed')}, затем снова --next: он даст один повтор, на втором сбое — стоп и вопрос человеку.`,
      `PIPELINE DONE, а --next снова предлагает замеры → ${nodeCmd('state', '--run', R, '--set', 'pipeline=ok')}.`];
    if (p === 'failed') {
      const pf = pipelineFailure(s, run);
      const st = pf.stage; // null: no pipeline.json, the failed stage is unknown
      if (pf.attempts >= 2) return { id: 'pipeline_failed', stage: 'blocked', title: 'замеры не идут', stop: true, ask: true,
        lines: [st ? `Замеры дважды упали на стадии ${st}${pf.last ? `: «${pf.last}»` : ''}. Без неё остальные замеры бессмысленны, повторять ту же команду не нужно.`
            : 'Замеры дважды упали, стадию определить не удалось (pipeline.json нет) — смотрите stdout/pipeline.md. Повторять ту же команду не нужно.',
          `Подробности: ${[st ? fwd(join(run, 'stdout', `${st}.md`)) : null, fwd(join(run, 'stdout', 'pipeline.md')), fwd(join(run, 'log.md'))].filter(Boolean).join(', ')}. Частые причины: нет сети или VPN пропускает только браузер, сайт лежит, браузер не стартует.`,
          'Покажите человеку стадию и 3–5 последних строк её stdout, спросите AskUserQuestion «Замеры не идут»: «Повторить» (поправил сеть, включил VPN) / «Пришлю скриншоты» / «Остановиться».',
          `  Повторить → команда: ${st ? nodeCmd('pipeline', ...args, '--redo', st) : cmdNow} — затем снова --next.`,
          `  Пришлю скриншоты → файлы в ${fwd(join(run, 'manual'))}/ (<страница>-390.jpg, <страница>-1440.jpg); без замеров полного отчёта не будет — скажите это прямо и остановитесь.`,
          `  Остановиться → ${stopLine('замеров')}`] };
      return cmdStep('pipeline', 'pipeline', 'замеры', [cmdNow],
        [st ? `Повтор после сбоя: стадия ${st} упала${pf.last ? ` («${pf.last}»)` : ''}. Вторая неудача — стоп и вопрос человеку.`
          : 'Повтор после сбоя (стадия неизвестна: pipeline.json нет). Вторая неудача — стоп и вопрос человеку.', ...std]);
    }
    if (p === 'blocked') {
      const pj = j(run, 'pipeline.json') || {};
      const why = (pj.blocked || {}).why || 'антибот, пароль (401), запрет (403) или таймаут';
      const acc = nodeCmd('init-run', '--run', R, '--answer', 'accept_blocked=yes');
      // the person chose «continue with the reachable pages» after this block: run the pipeline with --accept-blocked
      const acceptedAfter = f.accept_blocked && (Date.parse(f.accept_blocked_at || '') || 0) > (Date.parse(pj.generated || '') || 0);
      if (acceptedAfter) return cmdStep('pipeline', 'pipeline', 'замеры', [cmdNow], ['Продолжаем по доступным страницам (закрытые уйдут в «не проверено»).', ...std]);
      // no page opened even with «continue with the reachable ones»: screenshots alone give no review (lenses need pages.json)
      if (f.accept_blocked) return { id: 'pipeline_blocked', stage: 'blocked', title: 'доступных страниц нет', stop: true, ask: true,
        lines: [`Замеры остановлены даже с продолжением по доступным страницам: ${why}. Ни одна страница не открылась, обход защиты не предлагать.`,
          'Скажите прямо: без открытых страниц ревью не будет, одни скриншоты его не заменят. Спросите AskUserQuestion: «Включу VPN и повторю» / «Сниму сам у себя» / «Остановиться».',
          `  Включу VPN → после «готово»: ${cmd}`,
          `  Сниму сам → человеку в своём терминале, в сети, где сайт открывается: ${nodeCmd('snapshot', '--run', R, '--accept-blocked')}; после «готово»: ${cmdAccept}`,
          `  Остановиться → ${stopLine('замеров')}`] };
      return { id: 'pipeline_blocked', stage: 'blocked', title: 'сайт не пускает', ask: true,
        lines: [`Замеры остановлены воротами доступности: ${why}. Защиту и капчу не обходим, пароли не вводим.`,
          'Объясните причину простыми словами и спросите AskUserQuestion «Сайт закрыт»: «Включу VPN и повторю» / «Продолжить по доступным страницам» / «Сниму сам у себя» / «Отмена»; скриншоты 390 и 1440 — через «Другое».',
          `  Включу VPN → после «готово»: ${cmd} (закрытые страницы снимутся заново).`,
          `  Продолжить по доступным → ${acc}, затем: ${cmdAccept} (закрытые страницы уйдут в «не проверено»).`,
          `  Сниму сам → человеку в своём терминале, в сети, где сайт открывается: ${nodeCmd('snapshot', '--run', R, '--accept-blocked')}; после «готово»: ${acc}, затем ${cmdAccept}.`,
          `  Скриншоты → файлы в ${fwd(join(run, 'manual'))}/ (<страница>-390.jpg, <страница>-1440.jpg), затем ${acc} и ${cmdAccept}; визуальным агентам строка MANUAL_SHOTS=${fwd(join(run, 'manual'))}.`,
          `  Отмена → ${stopLine('замеров')}`,
          'После команды pipeline — как обычно: код 75 — та же команда, потом снова --next.'] };
    }
    return cmdStep('pipeline', 'pipeline', 'замеры', [cmdNow],
      [...std, p === 'partial' ? 'Прошлый вызов снял не всё (бюджет времени или часть стадий через --stages) — эта команда доделает остальное.' : null].filter(Boolean));
  });

  // quick privacy: inventory + the reject test in one call (privacy-12–14 are not «not checked» then)
  if (mode === 'quick' && f.topic === 'privacy') steps.push(() => {
    if (val(s, 'pipeline') !== 'ok' || okv(val(s, 'privacy_reject')) || finalFailed(s, 'privacy_reject')) return null;
    const pj = j(run, 'measure/privacy.json');
    if (pj && !pj.partial && pj.reject_requested) return null;
    return cmdStep('privacy_reject', 'pipeline', 'приватность и проверка отказа', [nodeCmd('privacy', '--run', R, '--reject-test')],
      ['timeout 600000; код 75 — та же команда ещё раз. Скрипт нажимает только кнопку отказа («Отклонить», «Только необходимые»), «Принять» — никогда.',
        `Упал → ${nodeCmd('state', '--run', R, '--set', 'privacy_reject=failed')}; после второго раза privacy-12–14 уйдут в «не проверено».`]);
  });

  // stage question on beta signals
  steps.push(() => {
    const quickStage = ['seo', 'seo-tech', 'health', 'legal', 'privacy'].includes(f.topic);
    if (!(mode === 'full' || (mode === 'quick' && quickStage))) return null;
    if (f.stage || briefIn().stage || okv(val(s, 'stage_question'))) return null;
    const sig = (pages() || {}).beta_signals || [];
    if (!sig.length) return null;
    if (f.no_questions) return cmdStep('stage_question', 'pipeline', 'стадия сайта', [nodeCmd('init-run', '--run', R, '--answer', 'stage=beta', '--answer', '"stage_why=признаки беты, вопросы отключены"')],
      [`Признаки беты: ${sig.slice(0, 3).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('; ')}. Вопросы отключены — считаем бетой.`]);
    return { id: 'stage_question', stage: 'pipeline', title: 'стадия сайта', ask: true,
      lines: [`Признаки беты: ${sig.slice(0, 3).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join('; ')}.`,
        'Спросите AskUserQuestion: «Боевой сайт» / «Бета перед запуском» / «Прототип».',
        `Ответ: ${nodeCmd('init-run', '--run', R, '--answer', 'stage=live|beta|prototype')}`] };
  });

  // rivals: snapshot of competitors (and ours when there is no fresh run of our host)
  if (mode === 'rivals') steps.push(() => {
    const urls = f.urls || [];
    // every address goes through parseSiteUrl again before it is printed (runs of older versions stored them raw)
    const list = [...new Set([...(f.prev_run_fresh ? [] : [f.url]), ...urls].filter(Boolean).map(safeUrl).filter(Boolean))];
    const hosts = [...new Set(list.map(u => U.hostKey(u)))];
    if (!list.length || finalFailed(s, 'rivals_snap') || hosts.every(h => captureDone(run, h, true))) return null;
    const left = hosts.filter(h => !captureDone(run, h, true));
    return cmdStep('rivals_snap', 'pipeline', 'снимок конкурентов', [nodeCmd('rivals', '--run', R, '--urls', `"${list.join(',')}"`)],
      ['timeout 600000; код 75 — та же команда ещё раз. Шаг готов, когда rivals.mjs снял все сайты полностью (rivals/<host>/capture.json, complete).',
        okv(val(s, 'rivals_snap')) && left.length ? `Отмечено rivals_snap=ok, но не досняты: ${left.join(', ')} — повторите команду.` : null,
        `Не выходит дважды → ${nodeCmd('state', '--run', R, '--set', 'rivals_snap=failed')} (после второго раза — дальше по снятым).`].filter(Boolean));
  });

  // brief: scout (full) or a minimal brief from flags + pages (quick, rivals, recheck)
  steps.push(() => {
    const b = brief();
    if (b && b.url) return null;
    if (mode === 'full' && !finalFailed(s, 'scout')) return { id: 'scout', stage: 'brief', title: 'разведка и бриф',
      lines: ['Запустите одного агента:', ...header(s, run).map(x => '  ' + x), agentLine({ type: 'revizor:scout', lenses: [], model: modelFor(['scout'], f.models) }, 0), FALLBACK,
        'Готово, когда есть brief.json.', `Разведчик упал → ${nodeCmd('state', '--run', R, '--set', 'scout=failed')} (после двух сбоев бриф соберётся без него).`],
      agents: [{ id: 'scout', type: 'revizor:scout', lenses: [], model: modelFor(['scout'], f.models), keys: ['scout'] }] };
    return cmdStep('brief', 'brief', 'бриф без разведчика', [nodeCmd('init-run', '--run', R, '--brief-min')]);
  });

  if (mode === 'full') steps.push(() => {
    if (okv(val(s, 'brief_saved')) || finalFailed(s, 'brief_saved')) return null;
    return cmdStep('brief_saved', 'brief', 'бриф в память сайта', [nodeCmd('memory', '--run', R, '--save-brief')]);
  });

  if (mode === 'full') steps.push(() => {
    const b = brief() || {};
    // the scout found these addresses on the web: only valid http(s) addresses of other hosts reach the command line
    const rl = [...new Set((Array.isArray(b.rivals_light) ? b.rivals_light : []).map(safeUrl).filter(Boolean))].filter(u => U.hostKey(u) !== f.host_key).slice(0, 5);
    if (f.depth === 'lite' || f.no_rivals || !rl.length) return null;
    if (val(s, 'rivals_light') === 'failed' || rl.every(u => captureDone(run, U.hostKey(u)))) return null;
    return cmdStep('rivals_light', 'brief', 'лёгкий снимок конкурентов', [nodeCmd('rivals', '--run', R, '--urls', `"${rl.join(',')}"`, '--light')],
      ['timeout 600000; код 75 — та же команда ещё раз. Шаг готов, когда все сайты сняты (capture.json, complete).', 'Не вышло — ' + nodeCmd('state', '--run', R, '--set', 'rivals_light=failed') + ' и дальше (кадры конкурентов не обязательны).']);
  });

  // lenses (full, quick)
  const plan = () => s.plan || computePlan(s, run);
  if (mode === 'full' || (mode === 'quick' && f.topic !== 'health')) {
    steps.push(() => {
      let agents = plan().agents;
      const parts = Number(f.parts) > 1 && mode === 'full' ? Math.min(Number(f.parts), agents.length) : 0;
      let partNote = null;
      if (parts > 1) {
        const chunks = partsOf(agents, parts);
        const ci = chunks.findIndex(c => c.some(a => !a.lenses.every(l => lensSettled(s, run, l))));
        if (ci < 0) return null;
        const started = chunks[ci].some(a => a.lenses.some(l => val(s, `lens:${l}`) !== 'todo' || findingsStatus(run, l, 1).state !== 'missing'));
        const prevAt = ci > 0 ? settledAt(s, run, chunks.slice(0, ci).flat().flatMap(a => a.lenses)) : 0;
        const goAt = Date.parse(s.resumed || '') || 0; // init-run --resume = «go on with the next part»
        if (ci > 0 && !started && prevAt > goAt) return { id: 'part_pause', stage: 'lenses', title: `часть ${ci} из ${chunks.length} готова`, stop: true,
          lines: [`Линзы части ${ci} из ${chunks.length} готовы; дальше — часть ${ci + 1} (${chunks[ci].map(a => a.id).join(', ')}).`,
            `Скажите человеку: «Часть ${ci} из ${chunks.length} готова, всё сохранено в ${fwd(run)}. Продолжить: ${resumeHint} — сразу или после сброса лимита».`,
            `Продолжить сейчас (если человек так сказал): ${nodeCmd('init-run', '--resume', R)}, затем снова --next.`] };
        agents = chunks[ci];
        partNote = `Часть ${ci + 1} из ${chunks.length} (по частям, --parts ${f.parts}).`;
      }
      const step = agentsStep(s, run, {
        id: 'lenses', stage: 'lenses', title: 'линзы', agents: lensJobs(s, run, agents),
        settled: a => a.lenses.every(l => lensSettled(s, run, l)), keyOf: a => a.lenses.map(l => `lens:${l}`),
        after: ['Готово, когда у каждой линзы есть findings/<lens>.json без ошибок validate и state lens:<id>=ok.'],
      });
      if (step && partNote) step.lines.unshift(partNote);
      return step;
    });
    const okLenses = () => plan().lenses.filter(l => lensOk(s, run, l));
    // reruns of measurements asked by lenses (after the lens wave, before checks and skeptics)
    steps.push(() => {
      if (okv(val(s, 'reruns')) || val(s, 'reruns') === 'failed') return null;
      const req = rerunRequests(run);
      if (!req.length) return null;
      const directPrivacy = mode === 'quick' && req.some(r => r.stage === 'privacy' && r.reject);
      const stages = [...new Set(req.map(r => r.stage).filter(Boolean))].filter(st => !(directPrivacy && st === 'privacy'))
        .sort((a, b) => PIPE_STAGES.indexOf(a) - PIPE_STAGES.indexOf(b)); // conveyor order
      const cmds = [];
      if (stages.length) cmds.push(nodeCmd('pipeline', ...pipelineArgs(mode === 'quick' ? stages : []), '--redo', stages.join(',')));
      if (directPrivacy) cmds.push(nodeCmd('privacy', '--run', R, '--reject-test'));
      const skipped = req.filter(r => !r.stage);
      if (!cmds.length) return null;
      // what is not carried over from a request: pages (a stage is rerun on all pages) and --spell (an external service:
      // only the person switches it on)
      const pids = [...new Set(req.filter(r => r.stage).flatMap(r => r.pids))];
      const spellAsk = req.some(r => r.stage === 'textscan' && r.spell) && (brief() || briefIn()).external_services?.spell !== true;
      return { id: 'reruns', stage: 'lenses', title: 'перезапуск замеров', ask: true, stop: true, // the person answers before the run goes on
        lines: ['Линзы просят перезапустить замеры (сами агенты скрипты замеров не запускают):',
          ...req.filter(r => r.stage).slice(0, 6).map(r => `  ${r.lens}: ${r.text}`),
          skipped.length ? `  не замеры — пропускаю: ${skipped.map(r => `${r.lens}: ${r.text.slice(0, 40)}`).join('; ').slice(0, 200)}` : null,
          pids.length ? `Страницы из просьб (${pids.slice(0, 8).join(', ')}) отдельно не передаются: стадия переснимается целиком, по всем страницам прогона.` : null,
          spellAsk ? (f.private_host ? 'Просьба «--spell» не выполняется: сайт локальный, тексты во внешний Спеллер не отправляем.'
            : `Просьба «--spell» включает Спеллер Яндекса (тексты страниц уходят во внешний сервис) — только по слову человека: спросите отдельно; «да» → ${nodeCmd('init-run', '--run', R, '--answer', 'spell=on')} до перезапуска.`) : null,
          stages.includes('snapshot') ? 'snapshot — снимок всех страниц заново, это долго (десятки минут).' : null,
          `Спросите человека одной строкой: «Перезапустить замеры (${[...stages, ...(directPrivacy ? ['privacy --reject-test'] : [])].join(', ')})? Лимит не тратит, только время».`,
          `  да → по порядку (код 75 — та же команда ещё раз): ${cmds.map((c, i) => `${i + 1}) ${c}`).join('  ')}`,
          `     потом ${nodeCmd('state', '--run', R, '--set', 'reruns=ok')} и снова --next`,
          `  нет → ${nodeCmd('state', '--run', R, '--set', 'reruns=skipped')} и снова --next`,
          // lite has no second round (r2LensesOf), so the critic cannot send a lens back
          mode === 'full' && f.depth !== 'lite' ? 'Критик увидит обновлённые замеры и при нужде отправит линзы во второй круг.' : 'Линзу заново не запускаем: обновлённые замеры увидят скептик и редактор.'].filter(Boolean) };
    });
    steps.push(() => {
      const ls2 = okLenses();
      if (!ls2.length || okv(val(s, 'lint')) || ls2.every(l => existsSync(join(run, 'verify', `${l}.lint.json`)))) return null;
      return cmdStep('lint', 'skeptic', 'автопроверка находок', [nodeCmd('lint-findings', '--run', R)], ['Потом: ' + nodeCmd('state', '--run', R, '--set', 'lint=ok')]);
    });
    steps.push(() => agentsStep(s, run, {
      id: 'skeptics', stage: 'skeptic', title: 'скептики', agents: skepticAgents(s, okLenses(), run),
      settled: a => a.lenses.every(l => okv(val(s, `verify:${l}`)) || finalFailed(s, `verify:${l}`) || !!j(run, `verify/${l}.json`)),
      keyOf: a => a.lenses.map(l => `verify:${l}`),
      after: ['Скептик упал → находки его линз пойдут как unverified (P0–P1 с пометкой «требует проверки»; в external снимаются).'],
    }));
    steps.push(() => {
      const cand = join(run, 'report', 'candidates.json');
      if (mode === 'full' && existsSync(cand) && j(run, 'critic/round-1.json')) return null; // the critic already worked on it; later merges are merge:2 / editor
      if ((okv(val(s, 'merge')) && existsSync(cand)) || (existsSync(cand) && mtime(cand) >= newestIn(run, ['findings', 'verify']))) return null;
      return cmdStep('merge', 'critic1', 'сведение находок', [nodeCmd('merge', '--run', R)], ['Потом: ' + nodeCmd('state', '--run', R, '--set', 'merge=ok')]);
    });
  }

  if (mode === 'full') {
    const critic = n => j(run, `critic/round-${n}.json`);
    steps.push(() => {
      if (critic(1) || finalFailed(s, 'critic:1')) return null;
      return { id: 'critic1', stage: 'critic1', title: 'критик полноты',
        lines: ['Запустите:', ...header(s, run, { ROUND: 1, MODE: 'review' }).map(x => '  ' + x), agentLine({ type: 'revizor:critic', lenses: [], model: modelFor(['critic'], f.models) }, 0), FALLBACK,
          'Готово, когда есть critic/round-1.json.'],
        agents: [{ id: 'critic:1', type: 'revizor:critic', lenses: [], model: modelFor(['critic'], f.models), keys: ['critic:1'] }] };
    });
    const r2Lenses = () => r2LensesOf(s, run);
    steps.push(() => agentsStep(s, run, {
      id: 'round2', stage: 'round2', title: 'второй круг', round: 2,
      agents: lensJobs(s, run, r2Lenses().map(l => ({ ...agentFor([l], f.models), extra: 'задачи — critic/round-1.json → gaps' })), 2),
      settled: a => lensSettled(s, run, a.lenses[0], 2), keyOf: a => [`r2:${a.lenses[0]}`],
      after: ['Файлы второго круга — findings/<lens>.r2.json (validate). Готово → state r2:<lens>=ok.'],
    }));
    steps.push(() => {
      const ls2 = r2Lenses().filter(l => lensOk(s, run, l, 2));
      if (!ls2.length || okv(val(s, 'lint:2'))) return null;
      return cmdStep('lint2', 'round2', 'автопроверка второго круга', [nodeCmd('lint-findings', '--run', R)], ['Потом: ' + nodeCmd('state', '--run', R, '--set', 'lint:2=ok')]);
    });
    steps.push(() => {
      const ls2 = r2Lenses().filter(l => lensOk(s, run, l, 2));
      if (!ls2.length || okv(val(s, 'verify:r2')) || finalFailed(s, 'verify:r2') || ls2.every(l => j(run, `verify/${l}.r2.json`))) return null;
      return agentsStep(s, run, {
        id: 'verify2', stage: 'round2', title: 'скептик второго круга', round: 2,
        agents: [{ id: 'skeptic:r2', type: 'revizor:skeptic', lenses: ls2, scope: 'новые P0-P1', model: modelFor(['skeptic'], f.models) }],
        settled: () => false, keyOf: () => ['verify:r2'], after: ['Вердикты — verify/<lens>.r2.json. Готово → state verify:r2=ok.'],
      });
    });
    steps.push(() => {
      const cand = join(run, 'report', 'candidates.json');
      if (!r2Lenses().some(l => lensOk(s, run, l, 2)) || okv(val(s, 'merge:2')) || (existsSync(cand) && mtime(cand) >= newestIn(run, ['findings', 'verify']))) return null;
      return cmdStep('merge2', 'round2', 'сведение после второго круга', [nodeCmd('merge', '--run', R)], ['Потом: ' + nodeCmd('state', '--run', R, '--set', 'merge:2=ok')]);
    });
    steps.push(() => {
      if (f.depth !== 'deep' || !r2Lenses().length || critic(2) || finalFailed(s, 'critic:2')) return null;
      return { id: 'critic2', stage: 'critic2', title: 'критик, второй проход',
        lines: ['Запустите:', ...header(s, run, { ROUND: 2, MODE: 'review' }).map(x => '  ' + x), agentLine({ type: 'revizor:critic', lenses: [], model: modelFor(['critic'], f.models) }, 0), FALLBACK],
        agents: [{ id: 'critic:2', type: 'revizor:critic', lenses: [], model: modelFor(['critic'], f.models), keys: ['critic:2'] }] };
    });
    // merge again so strategists and scorers see the critic's severity fixes (the editor merges anyway)
    steps.push(() => {
      if (!((f.strategy || f.scores) && f.audience !== 'external') || okv(val(s, 'merge:final'))) return null;
      const cand = join(run, 'report', 'candidates.json');
      if (existsSync(cand) && mtime(cand) >= newestIn(run, ['findings', 'verify', 'critic'])) return null;
      return cmdStep('merge_final', 'critic1', 'сведение с поправками критика', [nodeCmd('merge', '--run', R)], ['Потом: ' + nodeCmd('state', '--run', R, '--set', 'merge:final=ok')]);
    });
    // 7a strategies
    steps.push(() => {
      if (!f.strategy || f.audience === 'external' || existsSync(join(run, 'report', 'strategy.json'))) return null;
      const todo = ['seo', 'site'].filter(m => !okv(val(s, `strategy:${m}`)) && !finalFailed(s, `strategy:${m}`));
      if (todo.length) return agentsStep(s, run, {
        id: 'strategy', stage: 'strategy', title: 'стратегии',
        agents: todo.map(m => ({ id: `strategy:${m}`, type: 'revizor:strategist', lenses: [], mode: m, model: modelFor(['strategist'], f.models) })),
        settled: () => false, keyOf: a => [a.id], after: ['Готово → state strategy:seo=ok / strategy:site=ok.'],
      });
      if (okv(val(s, 'critic:strategy')) || finalFailed(s, 'critic:strategy')) return null;
      return agentsStep(s, run, {
        id: 'strategy_critic', stage: 'strategy', title: 'критик стратегий',
        agents: [{ id: 'critic:strategy', type: 'revizor:critic', lenses: [], mode: 'strategy', model: modelFor(['critic'], f.models) }],
        settled: () => false, keyOf: () => ['critic:strategy'], after: ['Итог — report/strategy.json.'],
      });
    });
    // 7b scores
    steps.push(() => {
      if (!f.scores || f.audience === 'external') return null;
      const todo = ['strict', 'market'].filter(c => !existsSync(join(run, 'report', `scores-${c}.json`)) && !okv(val(s, `scorer:${c}`)) && !finalFailed(s, `scorer:${c}`));
      if (!todo.length) return null;
      return agentsStep(s, run, {
        id: 'scores', stage: 'scores', title: 'оценки', agents: todo.map(c => ({ id: `scorer:${c}`, type: 'revizor:scorer', lenses: [], mode: c, model: modelFor(['scorer'], f.models) })),
        settled: () => false, keyOf: a => [a.id], after: ['Файлы — report/scores-strict.json и report/scores-market.json.'],
      });
    });
  }

  // rivals: cards → lint → summary → strategist → critic
  if (mode === 'rivals') {
    const hosts = () => {
      const list = [...(f.prev_run_fresh ? [] : [f.url]), ...(f.urls || [])].filter(Boolean);
      return [...new Set(list.map(u => U.hostKey(u)))].filter(h => captureDone(run, h));
    };
    const groupOf = h => { const g = (f.rival_groups || {})[h]; return g ? (GROUP_WORDS[g] || g) : null; };
    steps.push(() => agentsStep(s, run, {
      id: 'cards', stage: 'lenses', title: 'карточки конкурентов',
      agents: hosts().map(h => ({ id: `card:${h}`, type: 'revizor:rival-analyst', lenses: [], extra: `HOST=${h}${groupOf(h) ? ` · GROUP=${groupOf(h)}` : ''}`, model: modelFor(['rival-analyst'], f.models) })),
      settled: a => okv(val(s, a.id)) || finalFailed(s, a.id) || !!j(run, `rivals/${a.id.slice(5)}/card.json`), keyOf: a => [a.id],
      after: ['Готово, когда есть rivals/<host>/card.json.'],
    }));
    steps.push(() => {
      if (okv(val(s, 'lint_cards'))) return null;
      return cmdStep('lint_cards', 'skeptic', 'проверка карточек', [nodeCmd('lint-findings', '--run', R, '--cards')],
        ['Битые карточки — поправить или снять (повтор rival-analyst по этому хосту). Потом: ' + nodeCmd('state', '--run', R, '--set', 'lint_cards=ok')]);
    });
    steps.push(() => existsSync(join(run, 'rivals', 'summary.json')) ? null
      : cmdStep('summarize', 'strategy', 'свод «у N из M»', [nodeCmd('rivals', '--run', R, '--summarize')]));
    steps.push(() => {
      if (existsSync(join(run, 'rivals', 'ideas.json')) || okv(val(s, 'strategy:rivals')) || finalFailed(s, 'strategy:rivals')) return null;
      return agentsStep(s, run, { id: 'strategist', stage: 'strategy', title: 'идеи и направления',
        agents: [{ id: 'strategy:rivals', type: 'revizor:strategist', lenses: [], mode: 'rivals', model: modelFor(['strategist'], f.models) }],
        settled: () => false, keyOf: () => ['strategy:rivals'], after: ['Файлы — rivals/matrix.json, rivals/best-of.json, rivals/ideas.json.'] });
    });
    steps.push(() => {
      if (okv(val(s, 'critic:rivals')) || finalFailed(s, 'critic:rivals')) return null;
      return agentsStep(s, run, { id: 'critic_rivals', stage: 'critic1', title: 'критик идей',
        agents: [{ id: 'critic:rivals', type: 'revizor:critic', lenses: [], mode: 'rivals', model: modelFor(['critic'], f.models) }],
        settled: () => false, keyOf: () => ['critic:rivals'], after: ['Готово → state critic:rivals=ok.'] });
    });
  }

  // recheck: plan → recheckers → skeptic → collect → memory
  if (mode === 'recheck') {
    const from = f.from ? qq(f.from) : qq(run);
    steps.push(() => existsSync(join(run, 'recheck', 'plan.json')) ? null
      : cmdStep('recheck_plan', 'lenses', 'план перепроверки', [nodeCmd('recheck', '--run', R, '--from', from)]));
    steps.push(() => {
      const planJ = j(run, 'recheck/plan.json') || {};
      const groups = (planJ.groups || []).map(g => ({ id: `recheck:${g.id}`, type: 'revizor:rechecker', lenses: [], mode: 'plan', extra: `GROUP=${g.id}${g.lens ? ` (${g.lens})` : ''}`, model: modelFor(['rechecker'], f.models) }));
      groups.push({ id: 'recheck:fresh', type: 'revizor:rechecker', lenses: [], mode: 'fresh', model: modelFor(['rechecker'], f.models) });
      return agentsStep(s, run, { id: 'recheckers', stage: 'lenses', title: 'перепроверка по группам', agents: groups,
        settled: a => okv(val(s, a.id)) || finalFailed(s, a.id) || !!j(run, `recheck/${a.id.slice(8)}.json`), keyOf: a => [a.id],
        after: ['Файлы — recheck/<group>.json и recheck/fresh.json.'] });
    });
    steps.push(() => {
      if (okv(val(s, 'verify:recheck')) || finalFailed(s, 'verify:recheck') || j(run, 'verify/recheck.json')) return null;
      return agentsStep(s, run, { id: 'recheck_skeptic', stage: 'skeptic', title: 'скептик по исправленному',
        agents: [{ id: 'verify:recheck', type: 'revizor:skeptic', lenses: [], mode: 'recheck', scope: 'все fixed P0-P1 и все regressed', model: modelFor(['skeptic'], f.models) }],
        settled: () => false, keyOf: () => ['verify:recheck'], after: ['Готово → state verify:recheck=ok.'] });
    });
    steps.push(() => existsSync(join(run, 'recheck', 'result.json')) ? null
      : cmdStep('recheck_collect', 'editor', 'сбор итогов', [nodeCmd('recheck', '--run', R, '--collect')]));
    steps.push(() => {
      if (okv(val(s, 'memory')) || finalFailed(s, 'memory')) return null;
      const x = ls(join(run, 'report')).filter(n => /^registry-recheck-.*\.xlsx$/.test(n)).sort().pop();
      const src = x ? join(run, 'report', x) : (f.from && /\.xlsx$/i.test(f.from) ? f.from : null);
      if (!src) return null;
      return cmdStep('memory', 'editor', '«не будем исправлять» в память', [nodeCmd('memory', '--run', R, '--from-registry', qq(src))]);
    });
  }

  // editor and report
  steps.push(() => {
    const main = mode === 'rivals' ? 'rivals.html' : mode === 'recheck' ? 'recheck.html' : 'report.html';
    const mainPath = join(run, 'report', main);
    // the step opens again: after an explicit --reset editor (until editor=ok), and once after the recheck by ids (merge:ids
    // newer than the editor's last pass)
    const reopened = !!(s.reopen || {}).editor && !okv(val(s, 'editor'));
    const afterIds = mode === 'full' && okv(val(s, 'merge:ids')) && sinceMs(s, 'merge:ids') > Math.max(sinceMs(s, 'editor'), mtime(mainPath));
    if (existsSync(mainPath) && !reopened && !afterIds && (okv(val(s, 'report')) || okv(val(s, 'editor')) || !['running', 'failed'].includes(val(s, 'editor')))) return null;
    if (finalFailed(s, 'editor')) return { id: 'editor_failed', stage: 'editor', title: 'отчёт не собрался', stop: true,
      lines: ['Редактор дважды не довёл отчёт. Покажите человеку, что есть: report/candidates.json, report/digest.md, и последнюю ошибку report.mjs.',
        `Повторить вручную: ${nodeCmd('state', '--run', R, '--reset', 'editor')} и снова --next.`] };
    const m = mode === 'quick' ? (f.topic === 'health' ? 'health' : 'quick') : mode;
    return agentsStep(s, run, { id: 'editor', stage: 'editor', title: afterIds ? 'редактор, второй проход' : 'редактор и отчёт',
      agents: [{ id: 'editor', type: 'revizor:editor', lenses: [], mode: m, model: modelFor(['editor'], f.models) }],
      settled: () => false, keyOf: () => ['editor'],
      after: [afterIds ? `Скептик перепроверил находки по просьбе, свод обновлён: редактор ещё раз доводит ${main} (тот же промт) и ставит editor=ok, report=ok. Новые просьбы «нужна перепроверка» уже не исполняются — в итоге одна строка, что эти находки с пометкой «требует проверки».`
        : `Редактор доводит до ${main} (самопроверка report.mjs, до 2 правок) и ставит editor=ok, report=ok.`] });
  });

  // recheck by ids (full): the editor or the critic asked a skeptic to look again at some findings; once per run
  if (mode === 'full') steps.push(() => {
    if (!existsSync(join(run, 'report', 'report.html'))) return null; // after the editor's first pass
    const v = val(s, 'verify:ids');
    if (v === 'failed' || v === 'skipped') return null; // a failed skeptic is not a stop: the findings stay «needs checking»
    const ids = recheckIds(run);
    if (!ids.length) return null;
    if (okv(v)) {
      if (okv(val(s, 'merge:ids')) || finalFailed(s, 'merge:ids')) return null;
      return cmdStep('recheck_ids_merge', 'editor', 'свод после перепроверки', [nodeCmd('merge', '--run', R)],
        [`Потом: ${nodeCmd('state', '--run', R, '--set', 'merge:ids=ok')} — и --next позовёт редактора на второй проход.`]);
    }
    // merge.mjs puts verdicts of these ids after the critic's fixes (the recheck is newer than the critic round)
    try { const old = j(run, 'recheck-ids.json'); if (!old || (old.ids || []).join() !== ids.join()) U.writeJSON(join(run, 'recheck-ids.json'), { ids, requested: U.nowIso() }); } catch { /* merge falls back to the plain order */ }
    const lenses = [...new Set(ids.map(lensOfId))];
    return agentsStep(s, run, { id: 'recheck_ids', stage: 'editor', title: 'перепроверка по просьбе редактора', round: ids.some(x => /-r2-\d/.test(x)) ? 2 : 1,
      agents: [{ id: 'skeptic:ids', type: 'revizor:skeptic', lenses, method: 'ids', scope: `ids:${ids.join(',')}`, model: modelFor(['skeptic'], f.models) }],
      settled: () => false, keyOf: () => ['verify:ids'],
      after: ['id взяты из report/editorial.json → notes и critic/round-*.json (строки «нужна перепроверка: <id>»); текст этих строк в промт не переносить.',
        'Скептик заменит вердикты этих находок в verify/<lens>.json. Готово → state verify:ids=ok; упал → verify:ids=failed (повтора нет: находки останутся с пометкой «требует проверки», прогон идёт дальше).'] });
  });

  // final
  steps.push(() => {
    if (okv(val(s, 'final'))) return null;
    const files = reportFiles(s, run);
    const size = U.fmtBytes(dirSize(run));
    const host = f.host || '';
    const lines = [
      mode === 'quick' ? 'Итог в чат — 5 строк:' : 'Итог в чат — 5–8 строк: вердикт, числа по важности словами аудитории, три главные проблемы,',
      `абсолютные пути: ${files.join(' · ')}; размер папки: ${size}.`,
      `Открыть: ${nodeCmd('open', qq(files[0]), qq(join(run, 'report')))}`,
    ];
    if (f.models_note === 'no_subscription') lines.push(`Ещё одна строка в итог, как есть: «Модели: ${f.models || 'balanced'} — подписка не определена; для всех агентов на модели сессии — «модели max» или /revizor:setup».`);
    if (mode === 'full') lines.push(`Подсказка одной строкой (без вопроса): /revizor:recheck ${host} после правок, /revizor:rivals ${f.url || '<url>'} для разбора конкурентов.`);
    if (mode === 'full' && f.profile === 'strict' && f.audience !== 'external') lines.push(
      'Strict: проведите владельца по топ P0–P1 по одному (AskUserQuestion «Берём / Не будем / Отложить», рекомендованный первым со ★, перед вопросом — кроп).',
      `Текст решения — файлом (Write в ${fwd(join(run, 'notes', 'decision.txt'))}: «<rid> <заголовок>»), в командную строку не подставлять.`,
      `  «Берём» → ${nodeCmd('memory', '--run', R, '--add', 'known', '--text-file', qq(join(run, 'notes', 'decision.txt')), '--uid', '<uid>')}`,
      `  «Не будем» → ${nodeCmd('memory', '--run', R, '--add', 'do_not_suggest', '--text-file', qq(join(run, 'notes', 'decision.txt')), '--uid', '<uid>')} · «Отложить» → ничего не пишем.`);
    lines.push(`Потом: ${nodeCmd('state', '--run', R, '--set', 'final=ok')}`);
    return { id: 'final', stage: 'report', title: 'итог', lines, commands: [] };
  });
  return steps;
}

const STAGE_NO = {
  full: { init: 1, pipeline: 3, brief: 4, lenses: 5, skeptic: 6, critic1: 7, round2: 7, critic2: 7, strategy: 7, scores: 7, editor: 8, report: 8, blocked: 3 },
  quick: { init: 1, pipeline: 2, brief: 2, lenses: 3, skeptic: 4, critic1: 4, editor: 5, report: 5, blocked: 2 },
  rivals: { init: 1, pipeline: 2, brief: 2, lenses: 3, skeptic: 3, strategy: 4, critic1: 4, editor: 5, report: 5, blocked: 2 },
  recheck: { init: 1, pipeline: 2, brief: 2, lenses: 3, skeptic: 4, editor: 5, report: 5, blocked: 2 },
};
const STAGE_TOTAL = { full: 8, quick: 5, rivals: 5, recheck: 5 };

/**
 * Bring done[] in line with the files before choosing a step (called by --next under the state lock):
 * an agent that reported ok without a usable file counts as failed; a file with schema errors gets one fix job.
 * → list of changes (for the log).
 */
export function reconcile(s, run) {
  const changes = [];
  if (!['full', 'quick'].includes(s.mode)) return changes;
  const plan = s.plan;
  if (!plan) return changes;
  const now = U.nowIso();
  const pairs = [...plan.lenses.map(l => [l, 1]), ...r2LensesOf(s, run).map(l => [l, 2])];
  for (const [l, round] of pairs) {
    const x = lensState(s, run, l, round);
    const k = x.k, v = (s.done || {})[k];
    if (x.st === 'rerun' && ['ok', 'partial'].includes(v)) {
      s.done[k] = 'failed'; (s.since ||= {})[k] = now; (s.attempts ||= {})[k] = ((s.attempts || {})[k] || 0) + 1;
      changes.push(`${k}: отметка ${v}, а файла findings нет → failed`);
    } else if (x.st === 'fix' && !(s.fix || {})[k]) {
      (s.fix ||= {})[k] = { mtime: x.fs.mtime, issued: now, errors: x.fs.errors.slice(0, 5) };
      if (['ok', 'partial'].includes(v)) s.done[k] = 'todo';
      changes.push(`${k}: файл с ошибками схемы → одна задача на исправление`);
    } else if (x.st === 'accepted' && v !== 'partial') {
      s.done[k] = 'partial'; (s.since ||= {})[k] = now;
      changes.push(`${k}: после исправления остались ошибки схемы → partial (merge возьмёт, что проходит)`);
    } else if (x.st === 'failed' && x.fs?.state === 'invalid' && !finalFailed(s, k)) {
      s.done[k] = 'failed'; (s.since ||= {})[k] = now; (s.attempts ||= {})[k] = Math.max(2, (s.attempts || {})[k] || 0);
      changes.push(`${k}: файл не разбирается и после исправления → failed`);
    }
  }
  return changes;
}

/** → { done, id, stage, stage_no, stage_total, title, lines, commands, agents, progress } */
export function nextStep(s, run, { lang = 'ru' } = {}) {
  const mode = STAGE_NO[s.mode] ? s.mode : 'full';
  if (s.mode !== 'rivals' && s.mode !== 'recheck' && !s.plan && (j(run, 'brief.json') || s.mode === 'quick')) s.plan = computePlan(s, run);
  let step = null;
  for (const fn of stepsFor(s, run, lang)) { step = fn(); if (step) break; }
  const plan = s.plan;
  const progress = { findings: countFindings(run) };
  if (plan && plan.lenses.length) progress.lenses = { ok: plan.lenses.filter(l => lensOk(s, run, l)).length, total: plan.lenses.length,
    failed: plan.lenses.filter(l => lensState(s, run, l).st === 'failed') };
  if (!step) return { done: true, id: 'done', stage: 'done', stage_no: STAGE_TOTAL[mode], stage_total: STAGE_TOTAL[mode], title: 'прогон завершён', lines: [], commands: [], agents: [], progress };
  try { const m = remainingMinutes(s, run); if (m !== null && m > 0) progress.minutes_left = m; } catch { /* estimate is optional */ }
  return { done: false, stage_no: step.no || STAGE_NO[mode][step.stage] || 1, stage_total: STAGE_TOTAL[mode], commands: [], agents: [], ...step, progress };
}

const TITLE_EN = { doctor: 'environment check', setup: 'no environment', topic: 'topic', candidates: 'list of competitors', estimate: 'estimate', questions: 'brief',
  pipeline: 'measurements', pipeline_failed: 'measurements fail', pipeline_blocked: 'the site blocks us', stage_question: 'site stage', rivals_snap: 'competitor snapshots', scout: 'scout and brief',
  brief: 'brief without scout', brief_saved: 'brief to site memory', rivals_light: 'light competitor snapshots', lenses: 'lenses', part_pause: 'part done', lint: 'finding checks',
  privacy_reject: 'privacy and the reject test', reruns: 'measurement reruns',
  skeptics: 'skeptics', merge: 'merging findings', critic1: 'completeness critic', round2: 'second round', lint2: 'second-round checks', verify2: 'second-round skeptic',
  merge2: 'merge after round two', critic2: 'critic, second pass', merge_final: 'merge with critic fixes', strategy: 'strategies', strategy_critic: 'strategy critic',
  scores: 'scores', cards: 'competitor cards', lint_cards: 'card checks', summarize: 'summary', strategist: 'ideas and directions', critic_rivals: 'ideas critic',
  recheck_ids: 'recheck by ids', recheck_ids_merge: 'merge after the recheck by ids',
  recheck_plan: 'recheck plan', recheckers: 'recheck by groups', recheck_skeptic: 'skeptic on fixes', recheck_collect: 'collecting results', memory: 'won’t-fix rows to memory',
  editor: 'editor and report', editor_failed: 'report failed', final: 'summary', done: 'run finished' };
function progressLine(n, lang) {
  const c = n.progress.findings;
  const found = Object.values(c).some(Boolean) ? (lang === 'en' ? ` · found: P0 ${c.P0}, P1 ${c.P1}, P2 ${c.P2}, P3 ${c.P3}` : ` · найдено: P0 ${c.P0}, P1 ${c.P1}, P2 ${c.P2}, P3 ${c.P3}`) : '';
  const l = n.progress.lenses ? (lang === 'en' ? ` · lenses ${n.progress.lenses.ok}/${n.progress.lenses.total}` : ` · линзы ${n.progress.lenses.ok}/${n.progress.lenses.total}`) : '';
  const left = n.progress.minutes_left ? (lang === 'en' ? ` · rough time left ~${n.progress.minutes_left} min` : ` · ориентир до конца ~${n.progress.minutes_left} мин`) : '';
  return (lang === 'en' ? `Stage ${n.stage_no} of ${n.stage_total} · ${TITLE_EN[n.id] || n.title}` : `Этап ${n.stage_no} из ${n.stage_total} · ${n.title}`) + l + found + left;
}

// ---------- CLI ----------
const HELP = `
state.mjs — состояние прогона Ревизора (RUN/state.json) и следующий шаг сценария.

  node state.mjs --run "<RUN>" --get [ключ]           весь state.json или одно поле (stage, flags.audience, lens:copy…)
  node state.mjs --run "<RUN>" --set ключ=значение…    атомарно; можно несколько --set
        ключи шагов: ${SET_HELP}
        значения: todo|running|ok|failed|partial|skipped|blocked
        «failed» считает попытку: после двух неудач --next больше не предлагает повтор. final=ok — прогон завершён.
        Флаги прогона (flags.*), счётчики попыток и этап через --set не меняются: флаги задаёт init-run (--answer).
  node state.mjs --run "<RUN>" --next [--json]        что делать дальше (сценарии full, quick, rivals, recheck по mode)
  node state.mjs --run "<RUN>" --reset <ключ>         забыть статус и попытки ключа
  node state.mjs --run "<RUN>" --replan               пересчитать состав линз (после смены --lenses/--skip или брифа)
  --lang ru|en   язык сводки
Коды: 0 — готово, 2 — ошибка аргументов, запрещённый ключ или нет state.json, 1 — сбой.
`;

async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['next', 'json', 'replan', 'help'], multi: ['set', 'reset'] });
  U.helpAndExit(HELP, args);
  const lang = U.langOf(args);
  if (!args.run || args.run === true) { console.error(U.msg('need_run', lang)); process.exit(2); }
  const run = resolve(String(args.run));
  if (!existsSync(statePath(run))) { console.error(lang === 'en' ? `No state.json in ${run} — run init-run.mjs first.` : `Нет state.json в ${run} — сначала init-run.mjs.`); process.exit(2); }

  const sets = [...(args.set === undefined ? [] : Array.isArray(args.set) ? args.set : [args.set]), ...args._.filter(x => typeof x === 'string' && x.includes('='))]
    .filter(x => typeof x === 'string');
  if (sets.length) {
    let applied;
    try { await updateState(run, s => { applied = applyPairs(s, sets, { run }); }); }
    catch (e) { console.error(e.message); process.exit(2); }
    U.printAndSaveSummary(run, 'state', [`state: ${applied.join(', ')}`]);
    return;
  }
  if (args.reset) {
    const keys = U.listArg(args.reset);
    // reopen marks an explicit restart: a step that is otherwise finished by its files (editor: report.html) opens again
    await updateState(run, s => { for (const k of keys) { delete (s.done || {})[k]; delete (s.attempts || {})[k]; delete (s.fix || {})[k]; (s.reopen ||= {})[k] = U.nowIso(); } });
    U.printAndSaveSummary(run, 'state', [`state: сброшено ${keys.join(', ')}`]);
    return;
  }
  if (args.replan) {
    const s2 = await updateState(run, s => { s.plan = computePlan(s, run); });
    U.printAndSaveSummary(run, 'state', [`План: ${s2.plan.agents.map(a => a.id).join(', ')}`]);
    return;
  }
  if (args.next) {
    await loadValidator();
    let n, changes = [];
    const ul = args.lang ? lang : ((readState(run) || {}).flags?.lang === 'en' ? 'en' : 'ru'); // progress is shown to the person
    await updateState(run, s => {
      if (s.mode !== 'rivals' && s.mode !== 'recheck' && !s.plan && (j(run, 'brief.json') || s.mode === 'quick')) s.plan = computePlan(s, run);
      changes = reconcile(s, run);
      n = nextStep(s, run, { lang: ul });
      const newStage = n.done ? 'done' : n.stage;
      if (STAGES.includes(newStage)) s.stage = newStage;
    });
    for (const c of changes) U.log(run, `state --next: ${c}`);
    if (args.json) { process.stdout.write(JSON.stringify(n, null, 2) + '\n'); return; }
    const out = [`NEXT ${n.id}`, progressLine(n, ul)];
    if (n.done) out.push(ul === 'en' ? 'Run finished. Nothing left to do.' : 'Прогон завершён, шагов не осталось.');
    if (n.progress.lenses?.failed?.length) out.push(`Не отработали (в summary.not_checked): ${n.progress.lenses.failed.join(', ')}`);
    for (const c of n.commands || []) out.push(`> ${c}`);
    out.push(...(n.lines || []));
    if (!n.done && !n.stop && !n.wait) out.push(`Затем снова: ${nodeCmd('state', '--run', qq(run), '--next')}`);
    U.printAndSaveSummary(run, 'state', out);
    return;
  }
  const s = readState(run);
  if (args.get && args.get !== true) {
    const k = String(args.get);
    let v;
    if (k in s) v = s[k];
    else if (k.startsWith('flags.')) v = (s.flags || {})[k.slice(6)];
    else if (k.startsWith('attempts.')) v = (s.attempts || {})[k.slice(9)];
    else v = (s.done || {})[k] ?? 'todo';
    process.stdout.write((typeof v === 'object' ? JSON.stringify(v, null, 2) : String(v)) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(s, null, 2) + '\n');
}

const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
