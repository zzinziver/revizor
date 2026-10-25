// Revizor collector «axe»: runs axe-core (default rules + target-size 2.5.8 + experimental label-content-name-mismatch
// 2.5.3) on the same page load as snapshot.mjs.
// axe-core is downloaded by Node (never by the reviewed page) at a pinned version, checked against a
// sha256 baked in below, cached per machine (~/.cache/revizor or %LOCALAPPDATA%\revizor) and injected
// with Runtime.evaluate into the ISOLATED world of lib/cdp (same DOM, own JS globals): the site's CSP cannot block it,
// no request goes through the page, and the page cannot pre-define window.axe or patch the builtins axe relies on.
// The version inside the page is compared with the pinned one; a mismatch is an error, never a result.
// No network and no cache → the collector reports not_checked and contrast/a11y keep working without it.
//
// Collector interface (called by snapshot.mjs, see its --help): meta, collect(page, ctx), finalize(all, ctx) → { files, lines, summary }.
// collect() puts the compact axe result into ctx.cache ('axe') for collectors/contrast.mjs.
// Standalone: node collectors/axe.mjs --prefetch   (download into the cache, for setup/doctor)

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { writeJSON, log as runLog, logExternal, measureHeader, nowIso, progress } from '../lib/util.mjs';

export const AXE_VERSION = '4.10.3';
export const AXE_SHA256 = '880970c081707360e64f34cea25ff91892f5bc95675b0776925b9709dd8a68bb';
export const AXE_URLS = [
  `https://cdnjs.cloudflare.com/ajax/libs/axe-core/${AXE_VERSION}/axe.min.js`,
  `https://cdn.jsdelivr.net/npm/axe-core@${AXE_VERSION}/axe.min.js`,
  `https://unpkg.com/axe-core@${AXE_VERSION}/axe.min.js`,
];
export const AXE_URL = AXE_URLS[0];                 // doctor.mjs checks these
export const AXE_FALLBACK_URLS = AXE_URLS.slice(1);
export const AXE_LICENSE = 'axe-core © Deque Systems, MPL-2.0 (downloaded at run time, not bundled)';

export const meta = { name: 'axe', widths: [390, 1440], order: 40, timeoutMs: 150000 };

const EXAMPLES_PER_PAGE = 5;
const EXAMPLES_PER_RULE = 15;
const RAW_NODES_PER_RULE = 300; // measure/axe/<pid>-<width>.json
const IMPACT_RANK = { critical: 0, serious: 1, moderate: 2, minor: 3 };

// ---------- cache & download ----------
export function axeCacheDir() { // same places doctor.mjs looks in
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) return join(process.env.LOCALAPPDATA, 'revizor');
  return join(homedir(), '.cache', 'revizor');
}
export function axeCachePath() { return join(axeCacheDir(), `axe-${AXE_VERSION}.js`); }

const sha = buf => createHash('sha256').update(buf).digest('hex');

function readCached() {
  const p = axeCachePath();
  if (!existsSync(p)) return null;
  const buf = readFileSync(p);
  return sha(buf) === AXE_SHA256 ? buf.toString('utf8') : null; // tampered or truncated → download again
}

/** Cache state for doctor/setup: { path, version, exists, ok, sha256? , error? } — ok only with the pinned sha256. */
export function axeCacheStatus() {
  const path = axeCachePath();
  if (!existsSync(path)) return { path, version: AXE_VERSION, exists: false, ok: false };
  try { const got = sha(readFileSync(path)); return { path, version: AXE_VERSION, exists: true, ok: got === AXE_SHA256, sha256: got }; }
  catch (e) { return { path, version: AXE_VERSION, exists: true, ok: false, error: String(e.message || e).slice(0, 160) }; }
}

async function download(lang) {
  const tried = [];
  for (const url of AXE_URLS) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 30000);
      let res;
      try { res = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'revizor-axe-fetch' } }); }
      finally { clearTimeout(t); }
      if (!res.ok) { tried.push(`${new URL(url).host}: HTTP ${res.status}`); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      const got = sha(buf);
      if (got !== AXE_SHA256) { tried.push(`${new URL(url).host}: sha256 ${got.slice(0, 12)}… ≠ ожидаемого`); continue; }
      mkdirSync(axeCacheDir(), { recursive: true });
      const p = axeCachePath(), tmp = p + '.tmp-' + process.pid;
      writeFileSync(tmp, buf); renameSync(tmp, p);
      return { source: buf.toString('utf8'), host: new URL(url).host, tried };
    } catch (e) { tried.push(`${new URL(url).host}: ${e.name === 'AbortError' ? 'таймаут 30 с' : e.message}`); }
  }
  return { error: (lang === 'en' ? 'axe-core download failed: ' : 'axe-core не скачался: ') + tried.join('; '), tried };
}

let loading = null;
/**
 * loadAxe({ run, brief, lang }) → { source, version, from: 'cache'|'cdn'|'file' } | { error, offline? }
 * Policy: the download sends nothing about the reviewed site (only a GET of a public file), it is skipped
 * when REVIZOR_OFFLINE=1 or brief.external_services.axe === false. Every real download is logged to RUN/log.md.
 * REVIZOR_AXE_FILE=<path> uses a local axe file instead (any version, logged).
 */
export function loadAxe({ run, brief = {}, lang = 'ru' } = {}) {
  if (!loading) loading = (async () => {
    const local = process.env.REVIZOR_AXE_FILE;
    if (local && existsSync(local)) {
      const source = readFileSync(local, 'utf8');
      const ver = (source.match(/axe v(\d+\.\d+\.\d+)/) || [])[1] || 'unknown';
      if (run) runLog(run, `axe: локальный файл REVIZOR_AXE_FILE (axe ${ver}), сверка sha256 пропущена`);
      return { source, version: ver, from: 'file' };
    }
    const cached = readCached();
    if (cached) return { source: cached, version: AXE_VERSION, from: 'cache' };
    if (process.env.REVIZOR_OFFLINE === '1' || brief?.external_services?.axe === false) {
      return { error: lang === 'en' ? 'axe-core is not cached and downloads are off (offline mode)' : 'axe-core нет в кэше, а скачивание выключено (офлайн)', offline: true };
    }
    const d = await download(lang);
    if (d.error) { if (run) logExternal(run, 'CDN axe-core', `попытка скачать axe-core ${AXE_VERSION} (файл библиотеки, без данных сайта) не удалась: ${d.error}`, d.tried?.length || AXE_URLS.length); return d; }
    if (run) logExternal(run, `CDN axe-core (${d.host})`, `GET axe-core ${AXE_VERSION} (файл библиотеки, без данных сайта), sha256 сверен, кэш ${axeCachePath()}`, 1);
    return { source: d.source, version: AXE_VERSION, from: 'cdn' };
  })();
  return loading;
}

// ---------- running axe in the isolated world ----------
// Same DOM as the page, separate JS globals: window.axe, Array.prototype, elementFromPoint… of this world are ours.
// lib/cdp re-creates the world after each navigation, so axe is injected once per document.
async function evalIso(page, expression, timeoutMs = 120000) {
  if (typeof page.isolatedContextId !== 'function') throw new Error('lib/cdp without isolated worlds: axe is not run in the page world');
  const once = async () => page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, contextId: await page.isolatedContextId() }, timeoutMs);
  let r;
  try { r = await once(); }
  catch (e) { // the world was destroyed without a navigation event (rare): make lib/cdp create a fresh one, once
    if (!/context/i.test(String(e.message))) throw e;
    page._iso = null; r = await once();
  }
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
  return r.result?.value;
}

/**
 * Inject axe into the isolated world (once per document) and check the version that is really there.
 * AMD/CommonJS names are shadowed so axe always lands on window.axe of that world.
 */
export async function injectAxe(page, source, expectVersion = null) {
  const has = await evalIso(page, 'window.axe && typeof window.axe.run === "function" && window.axe.version || null', 10000).catch(() => null);
  if (has && (!expectVersion || has === expectVersion)) return has;
  await evalIso(page, `(function (define, module, exports, require) {\n${source}\n}).call(window, undefined, undefined, undefined, undefined); void 0;`, 60000);
  const v = await evalIso(page, 'window.axe && typeof window.axe.run === "function" && window.axe.version || null', 10000);
  if (!v) throw new Error('axe did not initialise in the isolated world');
  if (expectVersion && v !== expectVersion) throw new Error(`axe version in the page ${v} ≠ pinned ${expectVersion}`);
  return v;
}

// 2.5.8 target size is off by default in axe 4.10; label-content-name-mismatch (2.5.3) is experimental — both on.
export const AXE_RULES = { 'frame-tested': { enabled: false }, 'target-size': { enabled: true }, 'label-content-name-mismatch': { enabled: true } };

/**
 * runAxe(page, source, { context: 'document' | '<css selector>', timeoutMs, version })
 * → { version, url, ms, violations:[rule], incomplete:[rule], passes: n, inapplicable: n }
 * rule = { id, impact, tags, help, helpUrl, description, nodes:[{ target, html, impact, summary, box, data?, reason? }] }
 * box = [x, y, w, h] CSS px of the document at the current width. version: the pinned version to insist on
 * (default AXE_VERSION; pass the version of REVIZOR_AXE_FILE when a local file is used).
 */
export async function runAxe(page, source, { context = 'document', timeoutMs = 100000, version = AXE_VERSION } = {}) {
  await injectAxe(page, source, version);
  const ctxExpr = context === 'document' ? 'document' : JSON.stringify(context);
  const expression = `(async () => {
    const t0 = performance.now();
    const r = await window.axe.run(${ctxExpr}, { resultTypes: ['violations', 'incomplete'], iframes: false, elementRef: false,
      selectors: true, ancestry: false, xpath: false, absolutePaths: false, performanceTimer: false,
      rules: ${JSON.stringify(AXE_RULES)} });
    const resolve = t => { try { let el = document.querySelector(t[0]); for (let i = 1; el && i < t.length; i++) el = el.shadowRoot && el.shadowRoot.querySelector(t[i]); return el; } catch (e) { return null; } };
    const box = el => { if (!el || !el.getBoundingClientRect) return null; const b = el.getBoundingClientRect(); return [Math.round(b.left + scrollX), Math.round(b.top + scrollY), Math.round(b.width), Math.round(b.height)]; };
    const cut = (s, n) => { s = String(s || '').replace(/\\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
    const pack = list => list.map(rule => ({ id: rule.id, impact: rule.impact, tags: rule.tags, help: rule.help, helpUrl: rule.helpUrl, description: cut(rule.description, 300),
      nodes: rule.nodes.map(n => {
        const checks = [].concat(n.any || [], n.all || [], n.none || []);
        const c = checks.find(x => x && x.data && typeof x.data === 'object') || {};
        const out = { target: n.target, html: cut(n.html, 300), impact: n.impact, summary: cut(n.failureSummary, 400), box: box(resolve(n.target)) };
        if (rule.id === 'color-contrast' || rule.id === 'color-contrast-enhanced' || rule.id === 'link-in-text-block') { out.data = c.data || null; out.reason = (c.data && c.data.messageKey) || null; }
        else { const m = checks.find(x => x && x.message); if (m) out.message = cut(m.message, 240); }
        return out;
      }) }));
    return { version: window.axe.version, url: location.href, ms: Math.round(performance.now() - t0), iframes: document.querySelectorAll('iframe, frame').length,
      violations: pack(r.violations), incomplete: pack(r.incomplete), passes: r.passes.length, inapplicable: r.inapplicable.length };
  })()`;
  const res = await evalIso(page, expression, timeoutMs);
  if (!res || (version && res.version !== version)) throw new Error(`axe result version ${res?.version ?? '—'} ≠ pinned ${version}`);
  return res;
}

// ---------- WCAG helpers ----------
export function wcagRefs(tags = []) {
  const refs = [];
  for (const t of tags) { const m = /^wcag(\d)(\d)(\d{1,2})$/.exec(t); if (m) refs.push(`${m[1]}.${m[2]}.${m[3]}`); }
  return refs;
}
export function wcagLevel(tags = []) {
  if (tags.some(t => /^wcag2(1|2)?aaa$/.test(t))) return 'AAA';
  if (tags.some(t => /^wcag2(1|2)?aa$/.test(t))) return 'AA';
  if (tags.some(t => /^wcag2(1|2)?a$/.test(t))) return 'A';
  return tags.includes('best-practice') ? 'bp' : null;
}

function cacheSet(cache, key, val) { if (!cache) return; if (typeof cache.set === 'function') cache.set(key, val); try { cache[key] = val; } catch {} }

// ---------- collector ----------
export async function collect(page, ctx) {
  const lang = ctx.lang === 'en' ? 'en' : 'ru';
  const st = ctx.load?.status;
  if (st && st >= 400) { // an error page or an anti-bot wall: its rules say nothing about the site
    const why = lang === 'en' ? `page answered HTTP ${st}` : `страница ответила HTTP ${st}`;
    cacheSet(ctx.cache, 'axe', { unavailable: why });
    return { url: ctx.url, not_checked: why };
  }
  const ax = await loadAxe({ run: ctx.run, brief: ctx.brief, lang });
  if (ax.error) {
    cacheSet(ctx.cache, 'axe', { unavailable: ax.error });
    return { not_checked: ax.error };
  }
  let r;
  try { r = await runAxe(page, ax.source, { version: ax.version === 'unknown' ? null : ax.version }); }
  catch (e) {
    const err = (lang === 'en' ? 'axe failed on the page: ' : 'axe не отработал на странице: ') + e.message.slice(0, 300);
    cacheSet(ctx.cache, 'axe', { unavailable: err });
    return { error: err };
  }
  cacheSet(ctx.cache, 'axe', r);
  // full node list per page × width (for agents who need every node)
  if (ctx.run && ctx.pid) {
    const cap = list => list.map(rule => (rule.nodes.length > RAW_NODES_PER_RULE ? { ...rule, nodes_total: rule.nodes.length, nodes: rule.nodes.slice(0, RAW_NODES_PER_RULE) } : rule));
    try { writeJSON(join(ctx.run, 'measure', 'axe', `${ctx.pid}-${ctx.width}.json`), { pid: ctx.pid, width: ctx.width, url: r.url, axe: r.version, generated: nowIso(), violations: cap(r.violations), incomplete: cap(r.incomplete) }); }
    catch (e) { progress('axe: raw write failed', e.message); }
  }
  const brief = list => list.map(rule => ({
    id: rule.id, impact: rule.impact, tags: rule.tags, help: rule.help, helpUrl: rule.helpUrl, nodes: rule.nodes.length, ...(rule.tags?.includes('experimental') ? { experimental: true } : {}),
    examples: rule.nodes.slice(0, EXAMPLES_PER_PAGE).map(n => ({ selector: n.target.join(' >>> '), html: n.html.slice(0, 200), summary: (n.summary || n.message || '').slice(0, 240), box: n.box })),
  }));
  return { url: r.url, ms: r.ms, axe: r.version, from: ax.from, iframes: r.iframes, violations: brief(r.violations), incomplete: brief(r.incomplete), passes: r.passes, inapplicable: r.inapplicable };
}

export async function finalize(all, ctx) {
  const lang = ctx.lang === 'en' ? 'en' : 'ru';
  const out = { ...measureHeader('axe', ctx.run), partial: false, resume: null };
  const rules = new Map(); // key type|id
  const versions = new Set();
  for (const { pid, width, data } of all) {
    if (!data) continue;
    if (data.not_checked || data.error) {
      out.pages.push({ pid, width, url: data.url || null, checked: false });
      if (data.not_checked) out.not_checked.push({ pid, width, what: 'axe', why: data.not_checked });
      if (data.error) out.errors.push({ pid, width, error: data.error });
      continue;
    }
    // collect() already refused any version other than the pinned one (or the declared local file)
    versions.add(data.axe);
    const v = data.violations.reduce((a, x) => a + x.nodes, 0), inc = data.incomplete.reduce((a, x) => a + x.nodes, 0);
    if (data.iframes) out.not_checked.push({ pid, width, what: 'iframe', why: lang === 'en' ? `${data.iframes} iframe(s): axe does not enter frames (safety rule)` : `iframe: ${data.iframes} — axe внутрь не заходит (правило безопасности)` });
    out.pages.push({ pid, width, url: data.url, checked: true, ms: data.ms, violations: data.violations.length, violation_nodes: v, incomplete: data.incomplete.length, incomplete_nodes: inc, passes: data.passes, raw: `measure/axe/${pid}-${width}.json` });
    for (const type of ['violation', 'incomplete']) {
      for (const rule of data[type === 'violation' ? 'violations' : 'incomplete']) {
        const key = `${type}|${rule.id}`;
        let agg = rules.get(key);
        if (!agg) {
          agg = { rule: rule.id, type, impact: rule.impact, wcag: wcagRefs(rule.tags), level: wcagLevel(rule.tags), tags: rule.tags, help: rule.help, help_url: rule.helpUrl,
            nodes_total: 0, nodes_by_page: {}, pages: [], widths: [], where: [] };
          if (rule.experimental || rule.tags?.includes('experimental')) {
            agg.experimental = true;
            agg.note = lang === 'en' ? 'experimental axe rule: confirm on the screenshot before reporting' : 'экспериментальное правило axe: перед находкой проверить по кадру';
          }
          rules.set(key, agg);
        }
        if (IMPACT_RANK[rule.impact] < (IMPACT_RANK[agg.impact] ?? 9)) agg.impact = rule.impact;
        // the same element is usually found at both widths: per page take the larger count, then sum the pages
        agg.nodes_by_page[pid] = Math.max(agg.nodes_by_page[pid] || 0, rule.nodes);
        agg.nodes_total = Object.values(agg.nodes_by_page).reduce((a, n) => a + n, 0);
        if (!agg.pages.includes(pid)) agg.pages.push(pid);
        if (!agg.widths.includes(width)) agg.widths.push(width);
        agg.where.push({ pid, url: data.url, width, nodes: rule.nodes, examples: rule.examples });
      }
    }
  }
  const items = [...rules.values()].map(a => {
    // keep examples bounded per rule: first pages first, max EXAMPLES_PER_RULE in total
    let left = EXAMPLES_PER_RULE;
    for (const w of a.where) { w.examples = w.examples.slice(0, Math.max(0, Math.min(w.examples.length, left))); left -= w.examples.length; }
    return { ...a, sitewide: a.pages.length > 1 };
  }).sort((x, y) => (x.type === y.type ? 0 : x.type === 'violation' ? -1 : 1) || (IMPACT_RANK[x.impact] ?? 9) - (IMPACT_RANK[y.impact] ?? 9) || y.nodes_total - x.nodes_total);
  out.items = items;
  const viol = items.filter(i => i.type === 'violation');
  const byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const i of viol) byImpact[i.impact] = (byImpact[i.impact] || 0) + 1;
  const axeVersion = versions.size ? [...versions].join(', ') : null;
  out.summary = {
    axe_version: axeVersion, isolated_world: true, rules_extra: Object.keys(AXE_RULES).filter(k => AXE_RULES[k].enabled), pages_checked: new Set(out.pages.filter(p => p.checked).map(p => p.pid)).size, runs: out.pages.filter(p => p.checked).length,
    rules_violated: viol.length, violation_nodes: viol.reduce((a, i) => a + i.nodes_total, 0), by_impact: byImpact,
    rules_incomplete: items.filter(i => i.type === 'incomplete').length,
    top: viol.slice(0, 8).map(i => `${i.rule} (${i.impact}, ${i.nodes_total} ${lang === 'en' ? 'nodes' : 'узл.'}, ${i.pages.length} ${lang === 'en' ? 'pages' : 'стр.'})`),
    note: lang === 'en' ? 'axe covers ~30–40 % of WCAG; keyboard, screen reader and meaning are checked by a11y.mjs and the lens.' : 'axe ловит примерно 30–40 % WCAG; клавиатуру, чтение скринридером и смысл проверяют a11y.mjs и линза.',
  };
  if (typeof ctx.writeMeasure === 'function') ctx.writeMeasure('axe', out);
  else writeJSON(join(ctx.run, 'measure', 'axe.json'), out);
  const lines = lang === 'en'
    ? [`axe ${axeVersion || '—'}: ${out.summary.runs} page×width runs, ${viol.length} rules violated (${out.summary.violation_nodes} nodes), critical ${byImpact.critical}, serious ${byImpact.serious}`]
    : [`axe ${axeVersion || '—'}: проверок страница×ширина ${out.summary.runs}, нарушено правил ${viol.length} (узлов ${out.summary.violation_nodes}), critical ${byImpact.critical}, serious ${byImpact.serious}`];
  if (out.not_checked.length) lines.push((lang === 'en' ? 'not checked: ' : 'не проверено: ') + out.not_checked[0].why);
  const s = out.summary;
  return { files: ['measure/axe.json'], lines, summary: { pages_checked: s.pages_checked, runs: s.runs, rules_violated: s.rules_violated, violation_nodes: s.violation_nodes, rules_incomplete: s.rules_incomplete, not_checked: out.not_checked.length } };
}

// ---------- standalone: prefetch into the cache ----------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const lang = process.argv.includes('--lang') && process.argv[process.argv.indexOf('--lang') + 1] === 'en' ? 'en' : 'ru';
  if (process.argv.includes('--help')) {
    process.stdout.write(`node collectors/axe.mjs --prefetch [--lang en]\n  ${lang === 'en' ? 'Downloads' : 'Скачивает'} axe-core ${AXE_VERSION} → ${axeCachePath()} (sha256 ${AXE_SHA256.slice(0, 16)}…)\n`);
    process.exit(0);
  }
  if (process.argv.includes('--prefetch')) {
    // REVIZOR_OFFLINE=1: no download — only report whether the cache is usable
    if (process.env.REVIZOR_OFFLINE === '1' && !process.env.REVIZOR_AXE_FILE) {
      const st = axeCacheStatus();
      process.stdout.write(st.ok ? `axe-core ${AXE_VERSION}: ${lang === 'en' ? 'cached' : 'в кэше'} → ${st.path}\n`
        : (lang === 'en' ? `axe-core ${AXE_VERSION}: not in the cache, downloads are off (REVIZOR_OFFLINE=1)\n` : `axe-core ${AXE_VERSION}: в кэше нет, скачивание выключено (REVIZOR_OFFLINE=1)\n`));
      process.exit(st.ok ? 0 : 1);
    }
    const r = await loadAxe({ lang });
    if (r.error) { process.stdout.write(r.error + '\n'); process.exit(1); }
    process.stdout.write(`axe-core ${r.version}: ${r.from === 'cache' ? (lang === 'en' ? 'already cached' : 'уже в кэше') : (lang === 'en' ? 'downloaded' : 'скачан')} → ${axeCachePath()}\n`);
    process.exit(0);
  }
}
