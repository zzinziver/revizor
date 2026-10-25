#!/usr/bin/env node
// Revizor — pipeline: deterministic measurement conveyor with a time budget and resume.
// crawl → snapshot (+collectors) → seo ∥ headers ∥ domain → mobile → a11y → forms → vision → privacy → textscan → perf (alone)
// → baseline (old site, --baseline) → seo-bots (bot user agents, last: a protection may ban the IP for a "fake Googlebot") → check.
// Every stage is a child `node <stage>.mjs` with its own --budget-sec. Exit 75 of a stage = partial: the next call repeats it.
// A stage whose script is not installed is skipped with the mark "не установлен". Progress line after every stage.
// Availability gate: home page behind anti-bot / 401 / 403 / timeout, or real protection on ≥ 2 pages and > 30 % of them
// → PIPELINE BLOCKED (code 3). crawl/snapshot failing once → PIPELINE PARTIAL (repeat), twice → PIPELINE FAILED.

import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import tls from 'node:tls';
import * as U from './lib/util.mjs';

const HELP = `
pipeline.mjs — все замеры по очереди, с бюджетом времени и продолжением

  node pipeline.mjs --run "<RUN>" [--url https://example.ru] [--stages crawl,snapshot,seo] [--light | --health]
                    [--pages N | --pages home,p01] [--page /contacts] [--pages-from "<pages.json>"] [--depth lite|standard|deep]
                    [--redo snapshot,seo] [--accept-blocked] [--probe] [--allow-load-posts] [--budget-sec 480] [--lang ru|en]

  Порядок: crawl → snapshot (+коллекторы) → seo, headers, domain (параллельно) → mobile → a11y → forms (390 и 1440) →
           vision → privacy → textscan → perf (один) → baseline (старый сайт, если задан --baseline при init-run) →
           seo-bots (запросы от имени роботов — последними) → check (проверка комплекта).
  Каждая стадия — отдельный node-процесс со своим --budget-sec. Стадия ответила 75 (не успела) — конвейер
  останавливается с PIPELINE PARTIAL, следующий вызов продолжает её. Скрипта стадии нет — «не установлен», дальше.
  Тяжёлые стадии (сетевая группа, perf, baseline) не начинаются, если в вызове осталось меньше 90 с, — их начнёт
  следующий вызов с полным бюджетом. Стадия, которая два-три вызова подряд не продвигается, принимается как есть
  (crawl — частичный pages.json) или помечается ошибкой. Ожидание свободного браузера не считается застреванием.
  Флаги без командной строки берутся из state.json (их пишет init-run.mjs).
  --stages        только эти стадии (в порядке конвейера); check добавляется сам. В режиме full часть стадий —
                  не весь конвейер: state.json отметит pipeline=partial, следующий вызов без --stages доделает остальное
  --light         лёгкий снимок для режима rivals: crawl (4 стр.), snapshot 390+1440, seo, headers
  --health        мониторинг: crawl (6 стр.), snapshot 1440+390 без коллекторов, domain, health → measure/health.json
                  и report/diff.json (сравнение с последним завершённым прогоном хоста с теми же страницами)
  --pages N       число страниц для crawl; --pages home,p01 — только эти страницы для остальных стадий
  --page P        ровно эти страницы (путь или адрес; можно несколько раз)
  --pages-from F  страницы и их pid из прошлого pages.json (recheck, --resume)
  --redo a,b      переделать уже готовые стадии
  --probe         передать headers.mjs проверку служебных путей — только если в брифе limits.probe = true

Сбой crawl или snapshot: первый раз — PIPELINE PARTIAL (повторите ту же команду), второй раз — PIPELINE FAILED.
BLOCKED (ворота доступности): главная закрыта антиботом, паролем (401), запретом (403) или не открывается,
либо защита от ботов закрыла не меньше двух страниц и больше 30 % снятых. Вход и кабинет с 401/403 — не защита:
они просто уходят в not_checked. Защиту и капчу не обходим. Что можно сделать:
  · включить VPN и повторить ту же команду (закрытые страницы будут сняты заново);
  · продолжить по доступным страницам: та же команда с --accept-blocked (закрытые уйдут в not_checked);
  · снять самим в своей сети: node snapshot.mjs --run "<RUN>" --accept-blocked, затем та же команда pipeline
    с --accept-blocked (свежий удачный снимок не сбрасывается);
  · прислать скриншоты 390 и 1440 в папку RUN/manual/ (<страница>-390.jpg, <страница>-1440.jpg).
Вывод: строка прогресса после каждой стадии, в конце PIPELINE DONE (код 0) / PIPELINE PARTIAL (код 75 — повторите
ту же команду) / PIPELINE BLOCKED <причина> (код 3) / PIPELINE FAILED <стадия> (код 1). Копия — RUN/stdout/pipeline.md,
итог по стадиям (с последней ошибкой каждой) — RUN/pipeline.json.
`;

const HELP_EN = `
pipeline.mjs — all measurements in order, with a time budget and resume

  node pipeline.mjs --run "<RUN>" [--url https://example.com] [--stages crawl,snapshot,seo] [--light | --health]
                    [--pages N | --pages home,p01] [--page /contacts] [--pages-from "<pages.json>"] [--depth lite|standard|deep]
                    [--redo snapshot,seo] [--accept-blocked] [--probe] [--allow-load-posts] [--budget-sec 480] [--lang ru|en]

  Order: crawl → snapshot (+collectors) → seo, headers, domain (in parallel) → mobile → a11y → forms (390 and 1440) →
         vision → privacy → textscan → perf (alone) → baseline (old site, if --baseline was given to init-run) →
         seo-bots (requests as robots — last) → check (set completeness).
  Every stage is a separate node process with its own --budget-sec. A stage that exits 75 (out of time) stops the
  pipeline with PIPELINE PARTIAL; the next call continues it. A stage script is missing — "not installed", go on.
  Heavy stages (network group, perf, baseline) do not start with less than 90 s left in the call — the next call
  starts them with a full budget. A stage that makes no progress for two or three calls in a row is accepted as is
  (crawl — partial pages.json) or marked failed. Waiting for a free browser is not a stall.
  Flags missing on the command line are taken from state.json (written by init-run.mjs).
  --stages        only these stages (in pipeline order); check is added automatically. In full mode a subset is
                  not the whole pipeline: state.json marks pipeline=partial, the next call without --stages does the rest
  --light         light snapshot for rivals mode: crawl (4 pages), snapshot 390+1440, seo, headers
  --health        monitoring: crawl (6 pages), snapshot 1440+390 without collectors, domain, health → measure/health.json
                  and report/diff.json (comparison with the last finished run of the host with the same pages)
  --pages N       page count for crawl; --pages home,p01 — only these pages for the other stages
  --page P        exactly these pages (path or address; repeatable)
  --pages-from F  pages and their pids from an earlier pages.json (recheck, --resume)
  --redo a,b      redo stages that are already done
  --probe         let headers.mjs probe service paths — only if the brief has limits.probe = true

crawl or snapshot failure: first time — PIPELINE PARTIAL (repeat the same command), second time — PIPELINE FAILED.
BLOCKED (availability gate): the home page is behind anti-bot, a password (401), a ban (403) or does not open,
or bot protection closed at least two pages and over 30 % of those shot. Login and account pages with 401/403 are not
protection: they go to not_checked. Protection and captchas are never bypassed. Options:
  · turn on a VPN and repeat the same command (closed pages are shot again);
  · continue with the available pages: the same command with --accept-blocked (closed ones go to not_checked);
  · shoot on your own network: node snapshot.mjs --run "<RUN>" --accept-blocked, then the same pipeline command
    with --accept-blocked (a fresh successful snapshot is kept);
  · put 390 and 1440 screenshots into RUN/manual/ (<page>-390.jpg, <page>-1440.jpg).
Output: a progress line after every stage, at the end PIPELINE DONE (exit 0) / PIPELINE PARTIAL (exit 75 — repeat
the same command) / PIPELINE BLOCKED <reason> (exit 3) / PIPELINE FAILED <stage> (exit 1). Copy — RUN/stdout/pipeline.md,
per-stage result (with the last error of each) — RUN/pipeline.json.
`;

const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'light', 'health', 'accept-blocked', 'no-check', 'probe', 'allow-load-posts', 'regions'], multi: ['page'] });
U.helpAndExit(U.langOf(args) === 'en' ? HELP_EN : HELP, args);
const lang = U.langOf(args);
const T = (ru, en) => (lang === 'en' ? en : ru);
const run = U.requireRun(args);
const ROOT_SCRIPTS = dirname(fileURLToPath(import.meta.url));
const budgetSec = Number(args['budget-sec']) > 0 ? Number(args['budget-sec']) : 480;
const T0 = Date.now();
const deadline = T0 + budgetSec * 1000;
const secLeft = () => (deadline - Date.now()) / 1000;
const readOpt = p => (existsSync(p) ? U.readJSON(p, null) : null);
const fmtSec = s => { s = Math.round(s); return s >= 60 ? T(`${Math.floor(s / 60)} мин ${s % 60} с`, `${Math.floor(s / 60)}m ${s % 60}s`) : T(`${s} с`, `${s}s`); };
const fwd = x => String(x).replace(/\\/g, '/');

// ---------- state.json (format: see state.mjs) ----------
// Written through state.mjs (the only writer of state.json); a local fallback with the same lock file
// is kept for a plugin copy without state.mjs. Keys: done["pipeline:<stage>"] = todo|running|ok|partial|failed|skipped,
// done.pipeline = ok|partial|blocked|failed; "failed" counts an attempt (as state.mjs setDone does).
// Own bookkeeping: pipeline_plan, pipeline_progress (stall detection), pipeline_errors, pipeline_blocked_at, pipeline_redo,
// pipeline_runs (calls and total ms per stage; attempts counts only failed calls).
const STATE = join(run, 'state.json');
let ST = null;
try { if (existsSync(join(ROOT_SCRIPTS, 'state.mjs'))) ST = await import(pathToFileURL(join(ROOT_SCRIPTS, 'state.mjs')).href); } catch { ST = null; }
function defaultState() {
  return { plugin_version: U.VERSION, schema_version: 3, run, mode: String(args.mode || 'full'), flags: {}, stage: 'init', done: {}, attempts: {}, updated: U.nowIso() };
}
const normState = s => (s && typeof s === 'object' ? Object.assign(s, { done: s.done || {}, attempts: s.attempts || {}, flags: s.flags || {} }) : null);
function stateRead() {
  const s = ST?.readState ? ST.readState(run) : readOpt(STATE);
  return normState(s ? { ...s } : null) || defaultState();
}
async function stateUpdate(fn) {
  if (ST?.updateState) {
    if (!ST.readState(run)) await ST.createState(run, { mode: String(args.mode || 'full'), flags: {} });
    return ST.updateState(run, s => fn(normState(s)) || s);
  }
  return U.withFileLock(join(run, 'state.json.lock'), async () => {
    const cur = stateRead();
    const next = fn(cur) || cur;
    next.updated = U.nowIso();
    U.writeJSON(STATE, next);
    return next;
  });
}
const KEY = st => `pipeline:${st}`;
// finished = the stage's process has just ended: a --redo of it is no longer "fresh" (done when ok)
async function setStage(st, status, finished = false, extra = null) {
  return stateUpdate(s => {
    s.done[KEY(st)] = status;
    (s.since ||= {})[KEY(st)] = U.nowIso();
    if (status === 'failed') s.attempts[KEY(st)] = (s.attempts[KEY(st)] || 0) + 1;
    if (extra?.attempts != null) s.attempts[KEY(st)] = extra.attempts;
    if (extra?.error) (s.pipeline_errors ||= {})[st] = String(extra.error).slice(0, 420);
    // history across calls: how many calls ran the stage and their total time (pipeline.json shows it)
    if (finished && Number.isFinite(extra?.ms)) { const h = ((s.pipeline_runs ||= {})[st] ||= { calls: 0, ms: 0 }); h.calls++; h.ms += Math.round(extra.ms); }
    if (finished && s.pipeline_redo?.[st]) { if (status === 'ok') delete s.pipeline_redo[st]; else s.pipeline_redo[st] = 'started'; }
    return s;
  });
}

// ---------- flags: command line first, then state.flags (written by init-run in snake_case) ----------
let state = stateRead();
const flag = (...names) => {
  for (const n of names) if (args[n] !== undefined && args[n] !== null) return args[n];
  const f = state.flags || {};
  for (const n of names) {
    for (const k of [n, n.replace(/-/g, '_'), n.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]) {
      if (f[k] !== undefined && f[k] !== null && !(Array.isArray(f[k]) && !f[k].length)) return f[k];
    }
  }
  return undefined;
};
const mode = String(args.mode || state.mode || 'full');
const depth = String(flag('depth') || 'standard');
const light = !!args.light, health = !!args.health;
// --light/--health keep their own page count (4/6): state.flags.pages (20 for rivals/standard) must not override it,
// only an explicit --pages on the command line does
const pagesArg = light || health ? args.pages : flag('pages');
const isCount = v => v !== undefined && v !== null && /^\d+$/.test(String(v));
const pagesCount = isCount(pagesArg) ? Number(pagesArg) : light ? 4 : health ? 6 : null;
const pidFilter = pagesArg !== undefined && pagesArg !== null && !isCount(pagesArg) && pagesArg !== true ? U.listArg(pagesArg) : [];
const explicitPages = U.listArg(flag('page'));
const acceptBlocked = !!flag('accept-blocked');
const briefDoc = readOpt(join(run, 'brief.json')) || readOpt(join(run, 'brief.input.json')) || {};
const baselineUrl = (() => { const b = flag('baseline') ?? briefDoc.baseline; return b && b !== true ? String(b) : null; })();

// ---------- plan ----------
const CORE = ['crawl', 'snapshot', 'seo', 'headers', 'domain', 'mobile', 'a11y', 'forms', 'vision', 'privacy', 'textscan', 'perf'];
const KNOWN = [...CORE, 'baseline', 'seo-bots', 'health'];
const NETWORK = new Set(['seo', 'headers', 'domain']);
const HEAVY = new Set(['perf', 'baseline']);
const INTERNAL = new Set(['health', 'check']);
const scriptOf = st => join(ROOT_SCRIPTS, `${st === 'seo-bots' ? 'seo' : st}.mjs`);
// The bot comparison goes last when seo.mjs can run it alone (--bots-only); otherwise it stays inside seo (--as-bot).
const seoBotsOnly = (() => { try { return /['"]bots-only['"]/.test(readFileSync(scriptOf('seo'), 'utf8')); } catch { return false; } })();
const fullModes = mode === 'full' || mode === 'recheck';
const fullPlan = () => [...CORE, ...(baselineUrl && mode === 'full' ? ['baseline'] : []), ...(mode === 'full' && seoBotsOnly ? ['seo-bots'] : [])];
let plan;
if (args.stages && args.stages !== true) {
  const want = U.listArg(args.stages).map(s => s.toLowerCase());
  const bad = want.filter(s => !KNOWN.includes(s) && s !== 'check');
  if (bad.length) { console.error(T(`Неизвестные стадии: ${bad.join(', ')}. Есть: ${[...KNOWN, 'check'].join(', ')}`, `Unknown stages: ${bad.join(', ')}. Known: ${[...KNOWN, 'check'].join(', ')}`)); process.exit(2); }
  plan = KNOWN.filter(s => want.includes(s));
} else if (health) plan = ['crawl', 'snapshot', 'domain', 'health'];
else if (light) plan = ['crawl', 'snapshot', 'seo', 'headers'];
else plan = fullPlan();
if (!args['no-check']) plan.push('check');
const subsetOfFull = !!(args.stages && args.stages !== true) && fullModes && !light && !health;
const asBotWithSeo = mode === 'full' && !light && !health && !seoBotsOnly;
const redo = new Set(U.listArg(args.redo).map(s => s.toLowerCase()));
const isLocalHost = h => !h || h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::1]';

// ---------- child processes ----------
function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { child.kill('SIGTERM'); } catch {} setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000).unref(); }
}
function runChild(st, extra, budget, { runDir = run, tag = st, script = scriptOf(st) } = {}) {
  return new Promise(res => {
    const argv = [script, '--run', runDir, '--budget-sec', String(Math.max(30, Math.floor(budget))), '--lang', lang, ...extra];
    const t1 = Date.now();
    const child = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    let out = '', errTail = '', killed = false;
    child.stdout.on('data', d => { out += d.toString(); if (out.length > 200000) out = out.slice(-200000); });
    let buf = '';
    child.stderr.on('data', d => {
      const s = d.toString(); errTail = (errTail + s).slice(-4000); buf += s;
      const lines = buf.split(/\r?\n/); buf = lines.pop();
      for (const l of lines) if (l.trim()) process.stderr.write(`[${tag}] ${l}\n`);
    });
    const hard = setTimeout(() => { killed = true; U.progress(T(`[${tag}] не уложился в бюджет — останавливаю`, `[${tag}] over budget — stopping`)); killTree(child); }, (Math.max(30, budget) + 60) * 1000);
    child.on('error', e => { clearTimeout(hard); res({ code: 1, out, err: String(e.message), ms: Date.now() - t1 }); });
    child.on('close', (code, signal) => {
      clearTimeout(hard); if (buf.trim()) process.stderr.write(`[${tag}] ${buf}\n`);
      res({ code: code ?? (signal ? 1 : 0), signal, out, err: errTail + (killed ? '\n' + T('остановлен: не уложился в бюджет + 60 с', 'killed: budget + 60 s exceeded') : ''), ms: Date.now() - t1, killed });
    });
  });
}
// the last meaningful line of a failed child (stack frames skipped)
const lastErrLine = r => ((r.err || '') + '\n' + (r.out || '')).split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^at\s|^\^+$|^node:internal|^Node\.js v/.test(l)).slice(-1)[0]?.slice(0, 200) || `code ${r.code}`;
const errTail3 = r => (r.err || r.out || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).slice(-3).map(l => l.slice(0, 200));

// ---------- gate ----------
const REASON = {
  antibot: ['защита от ботов (капча или проверка браузера)', 'anti-bot protection (captcha or browser check)'],
  '401': ['сайт закрыт паролем (401)', 'the site is password-protected (401)'],
  '403': ['доступ запрещён (403): защита сайта или блок по стране/IP', 'access denied (403): protection or country/IP block'],
  timeout: ['сайт не ответил вовремя (таймаут)', 'the site did not respond in time (timeout)'],
  network: ['сайт не открывается (сеть, DNS или сертификат)', 'the site does not open (network, DNS or certificate)'],
  refused_private: ['адрес ведёт во внутреннюю сеть — такие адреса не открываем', 'the address resolves to a private network — refused'],
  refused_risky: ['адрес похож на действие (выход, удаление) — не открываем', 'the URL looks like an action (logout, delete) — refused'],
};
const reasonText = code => { const r = REASON[String(code).replace(/^home: /, '')] || null; return r ? (lang === 'en' ? r[1] : r[0]) : String(code); };

function gateAfterCrawl() {
  const p = readOpt(join(run, 'pages.json'));
  if (!p) return { blocked: 'network', why: T('crawl не записал pages.json', 'crawl wrote no pages.json') };
  if (p.home?.blocked) return { blocked: p.home.blocked, why: `${T('главная', 'home page')}: ${reasonText(p.home.blocked)}` };
  return null;
}
// hard = stop the conveyor: home closed, or real protection (anti-bot) on ≥ 2 pages and > 30 % of the captured ones.
// A login/cabinet page with 401/403 or a slow page is only left out of later stages (soft).
function gateFromSnap(s) {
  if (!s) return null;
  const sum = s.summary || {};
  if (sum.home_blocked) return { blocked: sum.home_blocked, why: `${T('главная', 'home page')}: ${reasonText(sum.home_blocked)}`, pids: sum.blocked_pages || [] };
  const items = s.items || [];
  const gate = sum.gate_pages || [...new Set(items.filter(i => i.blocked === 'antibot').map(i => i.pid))];
  const loaded = [...new Set(items.filter(i => !i.skipped).map(i => i.pid))].length || (s.pages || []).length || 1;
  const share = sum.gate_share ?? Math.round(100 * gate.length / loaded);
  if (gate.length >= 2 && share > 30) return { blocked: 'antibot', why: T(`защита от ботов закрыла ${gate.length} из ${loaded} страниц (${share} %)`, `anti-bot protection closed ${gate.length} of ${loaded} pages (${share}%)`), pids: sum.blocked_pages || gate };
  return sum.blocked_pages?.length ? { soft: true, pids: sum.blocked_pages } : null;
}
const gateAfterSnapshot = () => gateFromSnap(readOpt(join(run, 'snapshot', 'snapshot.json')));

// ---------- arguments per stage ----------
function stageArgs(st, ctx) {
  const a = [];
  const add = (...x) => a.push(...x.map(String));
  const pagesFilter = ctx.pids;
  if (mode) add('--mode', mode);
  if (ctx.siteStage) add('--stage', ctx.siteStage);
  const aud = flag('audience'); if (aud && aud !== true) add('--audience', aud);
  switch (st) {
    case 'crawl': {
      const url = flag('url'); if (url && url !== true) add('--url', url);
      if (pagesCount) add('--pages', pagesCount);
      for (const p of explicitPages) add('--page', p);
      const pf = flag('pages-from'); if (pf && pf !== true) add('--pages-from', pf);
      const mk = flag('market'); if (mk && mk !== true && mk !== 'auto') add('--market', mk);
      add('--depth', depth);
      break;
    }
    case 'snapshot':
      add('--depth', depth);
      if (state.pipeline_redo?.snapshot === 'fresh') add('--redo'); // only on the first call of a redo
      if (light || health) add('--widths', '1440,390');
      if (health) add('--no-collectors');
      if (flag('allow-load-posts')) add('--allow-load-posts');
      if (acceptBlocked) add('--accept-blocked');
      if (retryBlocked) add('--retry-blocked');
      if (pidFilter.length) add('--pages', pidFilter.join(','));
      break;
    case 'seo-bots':
      add('--as-bot', '--bots-only');
      break;
    default:
      if (pagesFilter?.length) add('--pages', pagesFilter.join(','));
      if (st === 'seo' && asBotWithSeo) add('--as-bot');
      if (st === 'headers' && flag('probe')) {
        // service paths are probed only with the owner's consent recorded in the brief
        if (briefDoc.limits?.probe === true) add('--probe');
        else ctx.notes.push(T('--probe пропущен: в брифе нет limits.probe = true (согласие владельца)', '--probe skipped: no limits.probe = true in the brief (owner consent)'));
      }
      if (st === 'domain' && flag('regions')) add('--regions');
      if (st === 'privacy' && mode === 'full' && !light) add('--reject-test');
      if (st === 'forms') add('--widths', '390,1440');
      // first call of a --redo: start the main file over (otherwise pages that left the selection stay in it)
      if (['mobile', 'vision', 'privacy'].includes(st) && state.pipeline_redo?.[st] === 'fresh') add('--fresh');
      if (st === 'textscan') {
        // --spell auto (config/default): on only for a live public site and not for an external audience (--spell flag defaults)
        const sp = String(flag('spell') ?? 'auto').toLowerCase();
        const on = ['true', 'on', 'yes', '1'].includes(sp) ? true : ['false', 'off', 'no', '0'].includes(sp) ? false
          : ctx.siteStage === 'live' && !state.flags?.private_host && flag('audience') !== 'external';
        add(on ? '--spell' : '--no-spell');
      }
      if (flag('allow-load-posts') && ['mobile', 'a11y', 'forms', 'vision', 'privacy', 'perf'].includes(st)) add('--allow-load-posts');
  }
  return a;
}

// ---------- progress of a partial stage (stall detection) ----------
const EXPECT = { seo: ['seo.json', 'links.json'], headers: ['headers.json'], domain: ['domain.json'], mobile: ['mobile.json'], a11y: ['a11y.json'], forms: ['forms.json'],
  vision: ['vision.json'], privacy: ['privacy.json'], textscan: ['textscan.json'], perf: ['perf.json'] };
function progressSig(st) {
  try {
    if (st === 'crawl') { const p = readOpt(join(run, 'pages.json')); return p ? `${p.progress_units ?? ''}|${p.selected?.length ?? 0}|${(p.resume?.unchecked || []).length}` : 'none'; }
    if (st === 'snapshot') { const s = readOpt(join(run, 'snapshot', 'snapshot.json')); return s ? `${s.summary?.loads_all ?? 0}|${(s.errors || []).length}|${s.finalized ? Object.keys(s.finalized).length : 0}` : 'none'; }
    if (st === 'baseline') { const b = join(run, 'baseline'); const p = readOpt(join(b, 'pages.json')); const s = readOpt(join(b, 'snapshot', 'snapshot.json')); return `${p?.progress_units ?? '-'}|${s?.summary?.loads_all ?? '-'}`; }
    if (st === 'seo-bots') { const b = readOpt(join(run, 'measure', 'seo.json'))?.site?.bots; return b ? `${(b.bots || []).length}|${b.partial ? 1 : 0}` : 'none'; }
    return (EXPECT[st] || []).map(f => { const j = readOpt(join(run, 'measure', f)); return j ? `${j.resume?.done?.length ?? ''}|${(j.items || []).length}|${(j.pages || []).length}|${(j.errors || []).length}` : '-'; }).join(';');
  } catch { return null; }
}

// ---------- check: is the set complete? ----------
function checkSet(st) {
  const missing = [], suspicious = [], partialFiles = [];
  const pages = readOpt(join(run, 'pages.json'));
  if (!pages && (plan.includes('crawl') || plan.includes('snapshot'))) missing.push('pages.json');
  const snap = readOpt(join(run, 'snapshot', 'snapshot.json'));
  const blocked = new Set(snap?.summary?.blocked_pages || []);
  let shots = 0;
  if (plan.includes('snapshot') && st.snapshot === 'ok' && pages) {
    const widths = snap?.widths || [];
    for (const s of pages.selected || []) {
      if (pidFilter.length && !pidFilter.includes(s.pid)) continue;
      if (blocked.has(s.pid)) { suspicious.push({ pid: s.pid, why: T('закрыта: ', 'closed: ') + reasonText((snap.items || []).find(i => i.pid === s.pid && i.blocked)?.blocked) }); continue; }
      const dir = join(run, 'snapshot', s.pid);
      for (const f of ['page.json', 'raw.html', 'text.md', 'shots/index.json']) if (!existsSync(join(dir, f))) missing.push(`snapshot/${s.pid}/${f}`);
      if (widths.includes(snap?.primary_width) && !existsSync(join(dir, 'dom.html'))) missing.push(`snapshot/${s.pid}/dom.html`);
      for (const w of widths) if (!existsSync(join(dir, 'shots', `${w}-fold.jpg`))) missing.push(`snapshot/${s.pid}/shots/${w}-fold.jpg`);
      try { shots += readdirSync(join(dir, 'shots')).filter(f => f.endsWith('.jpg')).length; } catch {}
      const pj = readOpt(join(dir, 'page.json'));
      if (pj) {
        if ((pj.facts?.text_len ?? 1000) < 30) suspicious.push({ pid: s.pid, why: T('почти нет текста (< 30 знаков) — заглушка или не дорисовалась', 'almost no text (< 30 chars) — placeholder or not rendered') });
        if (pj.status >= 400) suspicious.push({ pid: s.pid, why: T(`код ответа ${pj.status}`, `status ${pj.status}`) });
      }
    }
    for (const m of snap?.measure_written || []) if (!existsSync(join(run, 'measure', `${m}.json`))) missing.push(`measure/${m}.json`);
  }
  for (const [stage, files] of Object.entries(EXPECT)) {
    if (!plan.includes(stage) || st[stage] !== 'ok') continue;
    for (const f of files) {
      const p = join(run, 'measure', f);
      if (!existsSync(p)) { missing.push(`measure/${f}`); continue; }
      const j = readOpt(p);
      if (j?.partial) partialFiles.push(`measure/${f}`);
    }
  }
  // seo-bots merges site.bots into measure/seo.json
  if (plan.includes('seo-bots') && st['seo-bots'] === 'ok') {
    const b = readOpt(join(run, 'measure', 'seo.json'))?.site?.bots;
    if (!b) missing.push('measure/seo.json: site.bots');
    else if (b.partial && !partialFiles.includes('measure/seo.json')) partialFiles.push('measure/seo.json');
  }
  let manual = 0;
  try { manual = readdirSync(join(run, 'manual')).filter(f => /\.(jpe?g|png|webp)$/i.test(f)).length; } catch {}
  return { missing, suspicious, partial_files: partialFiles, shots, manual_shots: manual };
}

// ---------- health (quick monitoring mode, --health) ----------
function tlsInfo(host, port = 443) {
  return new Promise(res => {
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized: false, timeout: 10000 }, () => {
      const c = sock.getPeerCertificate() || {};
      const days = c.valid_to ? Math.floor((Date.parse(c.valid_to) - Date.now()) / 86400000) : null;
      res({ authorized: sock.authorized, error: sock.authorizationError || null, valid_to: c.valid_to || null, days_left: days, issuer: c.issuer?.O || c.issuer?.CN || null, protocol: sock.getProtocol?.() || null });
      sock.end();
    });
    sock.on('timeout', () => { sock.destroy(); res({ error: 'timeout' }); });
    sock.on('error', e => res({ error: e.code || e.message }));
  });
}
function findDeep(obj, test, depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 6) return out;
  for (const [k, v] of Object.entries(obj)) { if (test(k, v)) out.push([k, v]); if (v && typeof v === 'object') findDeep(v, test, depth + 1, out); }
  return out;
}
const pathOfUrl = u => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };
async function buildHealth(dir, { live }) {
  const items = [];
  const add = (key, value, ok, extra = {}) => items.push({ key, value: value ?? null, ok: ok === null ? null : !!ok, ...extra });
  const pages = readOpt(join(dir, 'pages.json'));
  if (!pages) return null;
  for (const s of pages.selected || []) {
    const pj = readOpt(join(dir, 'snapshot', s.pid, 'page.json'));
    const p = pathOfUrl(s.url);
    const st = pj?.status ?? s.status;
    add(`status ${p}`, st, st >= 200 && st < 400, { page: p });
    const f = pj?.facts || {};
    add(`title ${p}`, f.title ?? s.title ?? null, !!(f.title ?? s.title), { page: p });
    if (pj) {
      add(`description ${p}`, f.description ?? null, !!f.description, { page: p });
      const jl = f.jsonld || [];
      add(`jsonld ${p}`, `${jl.length}/${jl.filter(j => !j.ok).length}`, jl.every(j => j.ok), { page: p });
      add(`noindex ${p}`, f.robots ?? null, !/noindex/i.test(f.robots || ''), { page: p });
      // site errors only: exceptions caused by our safety net live in induced_exceptions
      const ex = Object.values(pj.loads || {}).reduce((n, w) => n + (w.exceptions?.length || 0), 0);
      add(`js_errors ${p}`, ex, ex === 0, { page: p });
    }
  }
  add('robots.txt', pages.robots?.status ?? null, pages.robots?.status === 200);
  const smOk = (pages.sitemaps?.files || []).some(f => f.status === 200 && f.count > 0);
  add('sitemap', `${(pages.sitemaps?.files || []).filter(f => f.status === 200).length}/${(pages.sitemaps?.files || []).length} · ${pages.sitemaps?.urls ?? 0}`, smOk);
  const home = readOpt(join(dir, 'snapshot', 'home', 'page.json'));
  if (home) {
    const w = home.loads?.['1440'] || Object.values(home.loads || {})[0] || {};
    if (w.net) add('home weight', w.net.bytes, w.net.bytes < 4 * 1024 * 1024, { unit: 'bytes', note: T('лаборатория, кэш выключен', 'lab, cache disabled') });
    if (w.vitals?.lcp != null) add('home lcp', w.vitals.lcp, w.vitals.lcp < 4000, { unit: 'ms', note: T('лаборатория, без замедления сети', 'lab, no throttling') });
  }
  let host = '';
  try { host = new URL(pages.final_origin || pages.site).hostname; } catch {}
  if (live && host && /^https:/.test(pages.final_origin || pages.site || '') && !isLocalHost(host)) {
    const t = await tlsInfo(host);
    if (t.days_left != null) add('tls days_left', t.days_left, t.days_left > 21 && t.authorized !== false, { issuer: t.issuer, valid_to: t.valid_to, error: t.error });
    else add('tls', t.error, false);
  }
  const dom = readOpt(join(dir, 'measure', 'domain.json'));
  if (dom) {
    const days = findDeep(dom, (k, v) => /days_left|expires_in_days|days_to_expiry/i.test(k) && typeof v === 'number')[0]?.[1];
    const date = findDeep(dom, (k, v) => /expir|paid_till|paid-till/i.test(k) && typeof v === 'string' && !Number.isNaN(Date.parse(v)))[0]?.[1];
    const d = days ?? (date ? Math.floor((Date.parse(date) - Date.now()) / 86400000) : null);
    if (d != null) add('domain days_left', d, d > 30);
    const subs = findDeep(dom, (k, v) => /subdomain/i.test(k) && Array.isArray(v))[0]?.[1] || [];
    const names = [...new Set(subs.map(x => (typeof x === 'string' ? x : x?.name || x?.host || x?.domain)).filter(Boolean))].sort();
    if (names.length || subs.length === 0) add('subdomains', names.length, null, { list: names.slice(0, 300) });
  }
  return { ...U.measureHeader('health', dir), partial: false, resume: null, pages: (pages.selected || []).map(s => s.pid), items,
    summary: { problems: items.filter(i => i.ok === false).length, checks: items.length } };
}
// The previous run to compare with: same host, finished pipeline (done.pipeline = ok), the same pages if possible,
// otherwise the newest one sharing ≥ half of the pages. Unfinished or BLOCKED runs are never compared.
function comparableRun(curPages) {
  const hostDir = dirname(resolve(run));
  const siteOf = pj => U.hostKey(pj?.final_origin || pj?.site || '');
  const curUrls = new Set((curPages.selected || []).map(s => pathOfUrl(s.url)));
  const curT = Date.parse(curPages.generated || 0) || Date.now();
  let sibs = [];
  try {
    sibs = readdirSync(hostDir).map(n => join(hostDir, n)).filter(p => resolve(p) !== resolve(run) && statSync(p).isDirectory())
      .map(p => ({ p, pj: readOpt(join(p, 'pages.json')), st: readOpt(join(p, 'state.json')) }))
      .filter(x => x.pj && siteOf(x.pj) === siteOf(curPages) && x.st?.done?.pipeline === 'ok')
      .map(x => ({ ...x, t: Date.parse(x.pj.generated || 0) || statSync(x.p).mtimeMs })).filter(x => x.t < curT).sort((a, b) => b.t - a.t);
  } catch { return null; }
  let best = null;
  for (const x of sibs) {
    const urls = new Set((x.pj.selected || []).map(s => pathOfUrl(s.url)));
    const common = [...curUrls].filter(u => urls.has(u)).length;
    const same = common === curUrls.size && common === urls.size;
    const overlap = curUrls.size ? common / curUrls.size : 0;
    if (same) return { dir: x.p, same: true, overlap: 1 };
    if (!best && overlap >= 0.5) best = { dir: x.p, same: false, overlap: Math.round(overlap * 100) / 100 };
  }
  return best;
}
async function healthStage() {
  const cur = await buildHealth(run, { live: true });
  if (!cur) return { code: 1, note: T('нет pages.json', 'no pages.json') };
  U.writeJSON(U.insideRun(run, 'measure', 'health.json'), cur);
  const curPages = readOpt(join(run, 'pages.json')) || {};
  const cmp = comparableRun(curPages);
  let prev = null;
  if (cmp) prev = readOpt(join(cmp.dir, 'measure', 'health.json')) || await buildHealth(cmp.dir, { live: false });
  const diff = { from: prev ? cmp.dir : null, same_pages: prev ? cmp.same : null, overlap: prev ? cmp.overlap : null, first_snapshot: !prev,
    appeared: [], fixed: [], unchanged_count: 0, changed: [], not_in_sample: [], new_in_sample: [], new_subdomains: [], generated: U.nowIso() };
  if (prev) {
    const pm = new Map(prev.items.map(i => [i.key, i]));
    const prevPagesSet = new Set(prev.items.filter(i => i.page).map(i => i.page));
    const curPagesSet = new Set(cur.items.filter(i => i.page).map(i => i.page));
    for (const i of cur.items) {
      // a page that was not in the previous sample: nothing to compare with
      if (i.page && !prevPagesSet.has(i.page)) { if (!diff.new_in_sample.includes(i.page)) diff.new_in_sample.push(i.page); continue; }
      const o = pm.get(i.key);
      if (i.ok === false && (!o || o.ok !== false)) diff.appeared.push({ key: i.key, value: i.value, prev: o?.value ?? null });
      else if (i.ok !== false && o?.ok === false) diff.fixed.push({ key: i.key, value: i.value, prev: o.value });
      else if (o) diff.unchanged_count++;
      if (o && JSON.stringify(o.value) !== JSON.stringify(i.value) && i.ok !== false && o.ok !== false && !/weight|lcp|days_left/.test(i.key)) diff.changed.push({ key: i.key, from: o.value, to: i.value });
      if (i.key === 'subdomains' && o?.list) diff.new_subdomains = (i.list || []).filter(n => !o.list.includes(n));
    }
    // problems of pages that are not in this sample are not "fixed" — they were simply not looked at
    for (const o of prev.items) if (o.page && !curPagesSet.has(o.page) && !diff.not_in_sample.includes(o.page)) diff.not_in_sample.push(o.page);
  }
  U.writeJSON(U.insideRun(run, 'report', 'diff.json'), diff);
  const extra = prev && (diff.not_in_sample.length || diff.new_in_sample.length)
    ? T(` · не сравнивались: страниц нет в прошлой выборке ${diff.new_in_sample.length}, нет в этой ${diff.not_in_sample.length}`, ` · not compared: new pages ${diff.new_in_sample.length}, dropped ${diff.not_in_sample.length}`) : '';
  return { code: 0, note: !prev ? T(`проблем ${cur.summary.problems} из ${cur.items.length}; сравнивать не с чем (нет завершённого прогона с теми же страницами)`, `${cur.summary.problems} problems of ${cur.items.length}; nothing comparable to compare with`)
    : T(`проблем ${cur.summary.problems}; новых ${diff.appeared.length}, исправлено ${diff.fixed.length}, без изменений ${diff.unchanged_count}${extra}`, `${cur.summary.problems} problems; new ${diff.appeared.length}, fixed ${diff.fixed.length}, unchanged ${diff.unchanged_count}${extra}`) };
}

// ---------- baseline: light capture of the old site (--baseline) into RUN/baseline/ ----------
async function baselineStage() {
  const bdir = U.ensureDir(U.insideRun(run, 'baseline'));
  const bp = readOpt(join(bdir, 'pages.json'));
  if (!bp || bp.partial) {
    const r = await runChild('crawl', ['--url', baselineUrl, '--pages', '11', '--depth', 'lite', '--mode', 'full'], secLeft() - 15, { runDir: bdir, tag: 'baseline' });
    if (r.code === 75) return { code: 75, note: T('старый сайт: crawl частично', 'old site: crawl partial'), out: r.out };
    if (r.code !== 0) return { code: 1, note: T('старый сайт: crawl — ', 'old site: crawl — ') + lastErrLine(r), r };
    if (secLeft() < 40) return { code: 75, note: T('старый сайт: страницы выбраны, кадры — в следующем вызове', 'old site: pages selected, shots in the next call') };
  }
  const r2 = await runChild('snapshot', ['--widths', '1440,390', '--collectors', 'meta,text', '--accept-blocked', '--depth', 'lite'], secLeft() - 15, { runDir: bdir, tag: 'baseline' });
  if (r2.code === 75) return { code: 75, note: T('старый сайт: снимок частично', 'old site: snapshot partial'), out: r2.out };
  if (r2.code !== 0 && r2.code !== 3) return { code: 1, note: T('старый сайт: snapshot — ', 'old site: snapshot — ') + lastErrLine(r2), r: r2 };
  const bpp = readOpt(join(bdir, 'pages.json')) || {};
  const bs = readOpt(join(bdir, 'snapshot', 'snapshot.json')) || {};
  U.log(run, `pipeline: baseline ${baselineUrl} → baseline/ (${bpp.selected?.length || 0} стр., кадров ${bs.summary?.shots_all ?? 0})`);
  return { code: 0, note: T(`старый сайт: ${bpp.selected?.length || 0} стр., кадров ${bs.summary?.shots_all ?? 0}${bs.summary?.blocked_pages?.length ? `, закрыто ${bs.summary.blocked_pages.length}` : ''} → baseline/`,
    `old site: ${bpp.selected?.length || 0} pages, ${bs.summary?.shots_all ?? 0} shots${bs.summary?.blocked_pages?.length ? `, ${bs.summary.blocked_pages.length} closed` : ''} → baseline/`) };
}

// ---------- main ----------
let retryBlocked = false;
async function main() {
  const out = [];          // lines for stdout (≤ 40) — printed as they come and saved at the end
  const say = l => { out.push(l); process.stdout.write(l + '\n'); };
  let ownCapture = false;
  state = await stateUpdate(s => {
    if (!s.mode) s.mode = mode;
    // a new call after BLOCKED: try again from crawl (VPN on, protection lifted), unless the user accepted the block
    // or captured the site in their own network after the block (a fresh snapshot that passes the gate is kept)
    if (s.done.pipeline === 'blocked' && !acceptBlocked) {
      const snap = readOpt(join(run, 'snapshot', 'snapshot.json'));
      const at = Date.parse(s.pipeline_blocked_at || 0) || 0;
      const g = gateFromSnap(snap);
      if (snap && at && Date.parse(snap.generated || 0) > at && !snap.partial && !(g && !g.soft)) {
        s.done[KEY('crawl')] = 'ok'; s.done[KEY('snapshot')] = 'ok'; ownCapture = true;
      } else {
        for (const st of ['crawl', 'snapshot']) { s.done[KEY(st)] = 'todo'; delete s.attempts[KEY(st)]; }
        retryBlocked = true;
      }
    }
    // --redo: the orchestrator repeats the same command after PIPELINE PARTIAL, so a redo that is already under way
    // (marked in pipeline_redo) continues instead of starting over
    s.pipeline_redo ||= {};
    for (const st of redo) {
      if (s.pipeline_redo[st] && ['partial', 'running'].includes(s.done[KEY(st)])) continue;
      s.done[KEY(st)] = 'todo'; delete s.attempts[KEY(st)]; s.pipeline_redo[st] = 'fresh';
      if (s.pipeline_progress) delete s.pipeline_progress[st];
    }
    s.stage = 'pipeline';
    s.pipeline_plan = plan.filter(x => x !== 'check');
    // a run started without init-run: keep the address for the next calls
    if (args.url && args.url !== true && !s.flags.url) s.flags.url = String(args.url);
    if (s.done.pipeline !== 'ok' || redo.size || args.stages) s.done.pipeline = 'partial';
    return s;
  });
  if (ownCapture) say(T('Снимок, сделанный после остановки (своя сеть), проходит ворота — crawl и snapshot не повторяю.', 'A snapshot captured after the stop (own network) passes the gate — crawl and snapshot are kept.'));
  // stages whose script is not installed: reported, never written into state.json (installing it later makes it run)
  const missingSet = new Set(plan.filter(x => !INTERNAL.has(x) && (x === 'baseline' ? !(existsSync(scriptOf('crawl')) && existsSync(scriptOf('snapshot'))) : !existsSync(scriptOf(x)))));
  const st = () => Object.fromEntries(plan.map(x => [x, missingSet.has(x) ? 'missing' : (state.done[KEY(x)] || 'todo')]));
  const total = plan.length;
  const ctx = { pids: pidFilter.length ? pidFilter : null, siteStage: null, notes: [] };
  const stageNo = x => plan.indexOf(x) + 1;
  const timings = {};
  const notesBy = {};
  let partial = false, blocked = null, failed = null, failedTwice = false, startedAny = false; // the first stage of a call may start with ≥ 30 s left
  const bigStart = Math.min(90, Math.max(30, budgetSec * 0.5));
  const STATUS_RU = { ok: 'готово', partial: 'частично', failed: 'ошибка', missing: 'не установлен', skipped: 'пропущено', blocked: 'закрыто' };
  const STATUS_EN = { ok: 'done', partial: 'partial', failed: 'failed', missing: 'not installed', skipped: 'skipped', blocked: 'blocked' };
  const label = s => (lang === 'en' ? STATUS_EN : STATUS_RU)[s] || s;
  const attemptsOf = x => state.attempts[KEY(x)] || 0;
  const finished = x => { const v = st()[x]; return v === 'ok' || v === 'skipped' || v === 'missing' || (v === 'failed' && attemptsOf(x) >= 2); };

  const siteStageNow = () => {
    const fs = flag('stage');
    if (fs && fs !== true) return String(fs);
    const p = readOpt(join(run, 'pages.json'));
    if (!p) return null;
    return (p.beta_signals || []).length ? 'beta' : 'live';
  };
  const applyGate = g => {
    if (!g) return false;
    if (g.soft || acceptBlocked) {
      if (g.pids?.length) {
        const all = (readOpt(join(run, 'pages.json'))?.selected || []).map(s => s.pid);
        const keep = (ctx.pids || all).filter(p => !g.pids.includes(p));
        ctx.excluded = g.pids;
        // "continue with the reachable pages" when none is reachable: still blocked
        if (!keep.length) { blocked = { ...g, why: T(`доступных страниц не осталось — ${g.why || reasonText(g.blocked)}`, `no reachable pages left — ${g.why || reasonText(g.blocked)}`) }; return true; }
        ctx.pids = keep;
      }
      return false;
    }
    blocked = g; return true;
  };

  // pages closed by protection or password (below the gate, or accepted by the user) are left out of later stages
  const refreshExclusions = () => {
    const snap = readOpt(join(run, 'snapshot', 'snapshot.json'));
    const bl = snap?.summary?.blocked_pages || [];
    if (!bl.length) return;
    const all = (readOpt(join(run, 'pages.json'))?.selected || []).map(s => s.pid);
    const keep = (pidFilter.length ? pidFilter : all).filter(p => !bl.includes(p));
    if (keep.length) ctx.pids = keep;
    ctx.excluded = bl;
  };
  if (st().snapshot === 'ok') refreshExclusions();

  // after a partial result: did the stage move? Two (crawl) or three (others) calls in a row without progress →
  // crawl's partial pages.json is accepted, other stages are marked failed. Waiting for a browser slot is not a stall.
  // every script words "no free browser" its own way: slot_wait (crawl, snapshot), "браузер занят другими проверками"
  // (headers, privacy, perf, seo) — in stdout, stderr or the not_checked of its measure file
  const BUSY_RE = /slot_wait|браузер занят|слоты? браузера|свободн(ый|ого) (браузер|слот)|browser slots? (are |is )?busy|no free browser|waiting for a free browser/i;
  const stallCheck = async (x, r) => {
    const notes = (x === 'seo-bots' ? ['seo.json'] : EXPECT[x] || []).map(f => (readOpt(join(run, 'measure', f))?.not_checked || []).map(n => (typeof n === 'string' ? n : JSON.stringify(n))).join(' ')).join(' ');
    const slotWait = BUSY_RE.test(r.out || '') || BUSY_RE.test(String(r.err || '').slice(-1500)) || BUSY_RE.test(notes);
    const sig = progressSig(x);
    let n = 0;
    state = await stateUpdate(s => {
      const pp = (s.pipeline_progress ||= {});
      const prev = pp[x];
      n = slotWait ? (prev?.n || 0) : prev && prev.sig === sig ? (prev.n || 0) + 1 : 0;
      pp[x] = { sig, n, at: U.nowIso() };
      return s;
    });
    return { n, slotWait };
  };

  // a child stopped by us at budget + 60 s did not crash: it overran (often waiting for a browser slot) — partial,
  // and the stall rule decides if it never moves
  const statusOf = r => (r.killed ? 'partial' : r.code === 0 ? 'ok' : r.code === 75 ? 'partial' : r.code === 3 ? 'blocked' : 'failed');
  const KILLED_NOTE = T('остановлен: не уложился в бюджет + 60 с — повторю', 'stopped: over budget + 60 s — will repeat');
  const stdoutCopy = x => join(run, 'stdout', `${x}.md`); // seo-bots writes its own stdout/seo-bots.md
  // line = one meaningful line for the progress line; text = the last 1–2 meaningful lines for pipeline.json → stages.<x>.error
  const failNote = (x, r) => {
    const tail = errTail3(r);
    const meaningful = ((r.err || '') + '\n' + (r.out || '')).split(/\r?\n/).map(l => l.trim()).filter(l => l && !/^at\s|^\^+$|^node:internal|^Node\.js v|^\[/.test(l));
    const text = [...new Set(meaningful.slice(-2))].map(l => l.slice(0, 200)).join('\n') || lastErrLine(r);
    return { line: lastErrLine(r), text, tail, copy: existsSync(stdoutCopy(x)) ? stdoutCopy(x) : null };
  };

  // runs one stage (not the parallel group); returns false to stop the conveyor
  const runStage = async (x) => {
    const cur = st()[x];
    if (cur === 'ok' || cur === 'skipped') return true;
    if (cur === 'failed' && attemptsOf(x) >= 2) {
      // without pages.json and the snapshot nothing else makes sense: stop instead of running the rest blind
      if (x === 'crawl' || x === 'snapshot') { failed = x; failedTwice = true; return false; }
      return true;
    }
    if (INTERNAL.has(x)) return true; // handled separately
    if (cur === 'missing') { say(`[${stageNo(x)}/${total}] ${x} — ${label('missing')}`); return true; }
    if (secLeft() < (startedAny ? (HEAVY.has(x) ? bigStart : 45) : 30)) { partial = true; return false; }
    state = await setStage(x, 'running'); startedAny = true;
    ctx.siteStage = ctx.siteStage || siteStageNow();
    let r;
    if (x === 'baseline') { const t1 = Date.now(); const b = await baselineStage(); r = { code: b.code, out: b.out || '', err: b.r?.err || '', ms: Date.now() - t1, note: b.note }; }
    else r = await runChild(x, stageArgs(x, ctx), secLeft() - 15);
    timings[x] = r.ms;
    let status = statusOf(r);
    let note = r.note || (r.killed ? KILLED_NOTE : '');
    let errInfo = null, stalled = false;
    if (status === 'failed') { errInfo = failNote(x, r); note = note || errInfo.line; }
    if (status === 'partial') {
      const { n, slotWait } = await stallCheck(x, r);
      if (slotWait) note = T('ждал свободный браузер и не дождался (slot_wait) — повторю', 'waited for a free browser (slot_wait) — will repeat');
      else if (x === 'crawl' && n >= 2 && readOpt(join(run, 'pages.json'))?.selected?.length) {
        status = 'ok'; note = T('принял частичный результат: три вызова подряд без продвижения (непроверенные страницы помечены unchecked)', 'accepted the partial result: three calls in a row without progress (unchecked pages are marked)');
      } else if (n >= 3) { status = 'failed'; stalled = true; note = T('нет продвижения за 4 вызова подряд', 'no progress in 4 calls in a row'); errInfo = { line: note, tail: [], copy: null }; }
    }
    const firstFail = status === 'failed' && !stalled && (x === 'crawl' || x === 'snapshot') && attemptsOf(x) < 1;
    // a stalled stage is final at once (attempts = 2): repeating the same call would not move it either
    state = await setStage(x, status === 'blocked' ? 'partial' : status, true, { ms: r.ms, ...(errInfo ? { error: errInfo.text || errInfo.line, ...(stalled ? { attempts: 2 } : {}) } : {}) });
    const tail = status === 'failed' ? '' : summaryLine(x);
    say(`[${stageNo(x)}/${total}] ${x} — ${label(status)} ${T('за', 'in')} ${fmtSec((r.ms || 0) / 1000)}${tail ? ' · ' + tail : ''}${note ? ' · ' + note : ''}`);
    if (status === 'failed' && errInfo) {
      notesBy[x] = errInfo;
      if (!errInfo.copy && errInfo.tail.length) for (const l of errInfo.tail) say(`    ${l}`);
    }
    if (status === 'partial') { partial = true; return false; }
    if (x === 'crawl' || x === 'snapshot') {
      if (status === 'failed') {
        // the first failure of crawl/snapshot is repeated by the next call (a random browser crash must not stop "full")
        if (firstFail) { say(T(`${x} упал — повторю при следующем вызове (вторая неудача остановит замеры).`, `${x} failed — will repeat on the next call (a second failure stops the measurements).`)); partial = true; return false; }
        failed = x; failedTwice = true; return false;
      }
    }
    if (x === 'crawl') {
      ctx.siteStage = siteStageNow();
      if (applyGate(gateAfterCrawl())) return false;
    }
    if (x === 'snapshot') {
      const g = gateAfterSnapshot();
      if (status === 'blocked' && !g) { blocked = { blocked: 'antibot', why: reasonText('antibot') }; return false; }
      if (applyGate(g)) return false;
      if (status === 'blocked') { state = await setStage(x, 'partial'); partial = true; return false; }
      if (status === 'ok') refreshExclusions();
    }
    return true;
  };
  const summaryLine = x => {
    try {
      if (x === 'crawl') { const p = readOpt(join(run, 'pages.json')); return p ? T(`страниц ${p.selected.length} из ${p.discovered} найденных · ${p.stack?.cms || 'платформа не определена'}${p.beta_signals?.length ? ' · признаки беты: ' + p.beta_signals.length : ''}`, `pages ${p.selected.length} of ${p.discovered} found · ${p.stack?.cms || 'platform unknown'}${p.beta_signals?.length ? ' · beta signs: ' + p.beta_signals.length : ''}`) : ''; }
      if (x === 'snapshot') { const s = readOpt(join(run, 'snapshot', 'snapshot.json')); return s ? T(`пар ${s.summary.loads_done}/${s.summary.loads_total} · кадров ${s.summary.shots}${s.summary.blocked_pages?.length ? ' · закрыто: ' + s.summary.blocked_pages.join(',') : ''}`, `pairs ${s.summary.loads_done}/${s.summary.loads_total} · shots ${s.summary.shots}${s.summary.blocked_pages?.length ? ' · blocked: ' + s.summary.blocked_pages.join(',') : ''}`) : ''; }
    } catch {}
    return '';
  };

  try {
    for (let i = 0; i < plan.length; i++) {
      const x = plan[i];
      if (blocked || failed) break;
      if (NETWORK.has(x)) {
        // parallel group: every network stage of the plan that is still to do
        const group = plan.filter(y => NETWORK.has(y));
        i = plan.indexOf(group[group.length - 1]);
        const todo = [];
        for (const y of group) {
          const cur = st()[y];
          if (cur === 'ok' || cur === 'skipped' || (cur === 'failed' && attemptsOf(y) >= 2)) continue;
          if (cur === 'missing') { say(`[${stageNo(y)}/${total}] ${y} — ${label('missing')}`); continue; }
          todo.push(y);
        }
        if (!todo.length) continue;
        // a group started with a thin remainder only answers 75 after a few seconds: leave it to the next call
        if (secLeft() < (startedAny ? bigStart : 30)) { partial = true; break; }
        ctx.siteStage = ctx.siteStage || siteStageNow();
        for (const y of todo) state = await setStage(y, 'running');
        startedAny = true;
        const budget = secLeft() - 15;
        const res = await Promise.all(todo.map(y => runChild(y, stageArgs(y, ctx), budget).then(r => [y, r])));
        for (const [y, r] of res) {
          timings[y] = r.ms;
          let status = r.killed ? 'partial' : r.code === 0 ? 'ok' : r.code === 75 ? 'partial' : 'failed';
          let note = r.killed ? KILLED_NOTE : '', errInfo = null, stalled = false;
          if (status === 'failed') { errInfo = failNote(y, r); note = errInfo.line; }
          if (status === 'partial') {
            const { n, slotWait } = await stallCheck(y, r);
            if (slotWait) note = T('ждал свободный браузер (slot_wait) — повторю', 'waited for a free browser (slot_wait) — will repeat');
            else if (n >= 3) { status = 'failed'; stalled = true; note = T('нет продвижения за 4 вызова подряд', 'no progress in 4 calls in a row'); errInfo = { line: note, tail: [], copy: null }; }
          }
          state = await setStage(y, status, true, { ms: r.ms, ...(errInfo ? { error: errInfo.text || errInfo.line, ...(stalled ? { attempts: 2 } : {}) } : {}) });
          say(`[${stageNo(y)}/${total}] ${y} — ${label(status)} ${T('за', 'in')} ${fmtSec(r.ms / 1000)}${note ? ' · ' + note : ''}`);
          if (status === 'failed' && errInfo) { notesBy[y] = errInfo; if (!errInfo.copy && errInfo.tail.length) for (const l of errInfo.tail) say(`    ${l}`); }
          if (status === 'partial') partial = true;
        }
        if (partial) break;
        continue;
      }
      if (x === 'health') {
        if (st().health === 'ok') continue;
        const t1 = Date.now();
        const r = await healthStage().catch(e => ({ code: 1, note: String(e?.message || e).slice(0, 160) }));
        state = await setStage('health', r.code === 0 ? 'ok' : 'failed', true, r.code === 0 ? null : { error: r.note });
        say(`[${stageNo(x)}/${total}] health — ${label(r.code === 0 ? 'ok' : 'failed')} ${T('за', 'in')} ${fmtSec((Date.now() - t1) / 1000)} · ${r.note}`);
        continue;
      }
      if (x === 'check') continue; // after the loop
      const go = await runStage(x);
      if (!go) break;
    }
    for (const n of ctx.notes) say(n);

    // check (always, cheap)
    let check = null;
    if (plan.includes('check') && !blocked && !failed && !partial) {
      check = checkSet(st());
      state = await setStage('check', 'ok');
      const parts = [];
      parts.push(T(`кадров ${check.shots}`, `shots ${check.shots}`));
      parts.push(check.missing.length ? T(`не хватает ${check.missing.length}: ${check.missing.slice(0, 4).join(', ')}${check.missing.length > 4 ? '…' : ''}`, `missing ${check.missing.length}: ${check.missing.slice(0, 4).join(', ')}${check.missing.length > 4 ? '…' : ''}`) : T('комплект полный', 'set complete'));
      if (check.suspicious.length) parts.push(T(`подозрительных страниц ${check.suspicious.length}`, `suspicious pages ${check.suspicious.length}`));
      if (check.partial_files.length) parts.push(T(`частичных замеров ${check.partial_files.length}`, `partial measures ${check.partial_files.length}`));
      if (check.manual_shots) parts.push(T(`скриншотов человека в manual/: ${check.manual_shots}`, `manual screenshots: ${check.manual_shots}`));
      say(`[${total}/${total}] check — ${parts.join(' · ')}`);
    }

    const sNow = st();
    const missingStages = plan.filter(x => sNow[x] === 'missing');
    const failedStages = plan.filter(x => sNow[x] === 'failed');
    const doneAll = plan.every(x => ['ok', 'missing', 'skipped', 'failed'].includes(sNow[x]) && !(sNow[x] === 'failed' && attemptsOf(x) < 2 && !INTERNAL.has(x)));
    // --stages in full/recheck: the stages asked for are done, the whole conveyor is not
    const restOfFull = subsetOfFull ? fullPlan().filter(x => { const v = state.done[KEY(x)]; const miss = x === 'baseline' ? false : !existsSync(scriptOf(x)); return !(miss || v === 'ok' || v === 'skipped' || (v === 'failed' && attemptsOf(x) >= 2)); }) : [];
    const doc = { tool: 'pipeline', version: U.VERSION, run, generated: U.nowIso(), mode, depth, plan, light, health,
      stages: Object.fromEntries(plan.map(x => [x, { status: sNow[x], attempts: attemptsOf(x), calls: state.pipeline_runs?.[x]?.calls ?? 0, ms: state.pipeline_runs?.[x]?.ms ?? timings[x] ?? null, ms_this_call: timings[x] ?? null, last_error: state.pipeline_errors?.[x] ?? null, ...(sNow[x] === 'failed' ? { error: state.pipeline_errors?.[x] ?? null } : {}) }])),
      site_stage: ctx.siteStage, excluded_pids: ctx.excluded || [], blocked: blocked ? { code: blocked.blocked, why: blocked.why } : null, check,
      as_bot: plan.includes('seo-bots') ? 'after_perf' : asBotWithSeo ? 'with_seo' : 'off', baseline: baselineUrl ? { url: baselineUrl, dir: 'baseline/' } : null,
      subset_of_full: subsetOfFull ? { rest: restOfFull } : null, notes: ctx.notes };
    U.writeJSON(U.insideRun(run, 'pipeline.json'), doc);

    const elapsed = fmtSec((Date.now() - T0) / 1000);
    if (missingStages.length && !blocked) say(T(`Не установлены: ${missingStages.join(', ')} — эти замеры пропущены, линзы увидят это в pipeline.json.`, `Not installed: ${missingStages.join(', ')} — skipped, recorded in pipeline.json.`));
    if (ctx.excluded?.length) say(T(`Исключены закрытые страницы: ${ctx.excluded.join(', ')} (в not_checked).`, `Excluded closed pages: ${ctx.excluded.join(', ')} (in not_checked).`));
    if (blocked) {
      state = await stateUpdate(s => { s.done.pipeline = 'blocked'; s.stage = 'blocked'; s.pipeline_blocked_at = U.nowIso(); return s; });
      U.log(run, `pipeline: BLOCKED — ${blocked.why}`);
      const own = `node "${fwd(join(ROOT_SCRIPTS, 'snapshot.mjs'))}" --run "${fwd(run)}" --accept-blocked`;
      const same = `node "${fwd(join(ROOT_SCRIPTS, 'pipeline.mjs'))}" --run "${fwd(run)}"`;
      say(T('Защиту и капчу не обходим. Варианты:', 'We never bypass protection or solve captchas. Options:'));
      say(T(`  · включить VPN и повторить ту же команду — закрытые страницы снимутся заново;`, `  · enable a VPN and run the same command again — closed pages are captured again;`));
      say(T(`  · продолжить по доступным страницам: ${same} --accept-blocked;`, `  · continue with the reachable pages: ${same} --accept-blocked;`));
      say(T(`  · снять самим в своей сети: ${own}, затем ${same} --accept-blocked;`, `  · capture inside your own network: ${own}, then ${same} --accept-blocked;`));
      say(T(`  · прислать скриншоты 390 и 1440: положить в ${fwd(join(run, 'manual'))}/ (<страница>-390.jpg, <страница>-1440.jpg).`, `  · send 390 and 1440 screenshots: put them into ${fwd(join(run, 'manual'))}/ (<page>-390.jpg, <page>-1440.jpg).`));
      say(`PIPELINE BLOCKED ${blocked.why}`);
      return 3;
    }
    if (failed) {
      state = await stateUpdate(s => { s.done.pipeline = 'failed'; return s; });
      U.log(run, `pipeline: FAILED ${failed}${state.pipeline_errors?.[failed] ? ' — ' + state.pipeline_errors[failed] : ''}`);
      const info = notesBy[failed];
      const where = info?.copy || (existsSync(stdoutCopy(failed)) ? stdoutCopy(failed) : null);
      const lastErr = (state.pipeline_errors?.[failed] || '').split(/\r?\n/).join(' / ');
      say(T(`Стадия ${failed} дважды завершилась ошибкой — без неё остальные замеры бессмысленны.${lastErr ? ` Последняя ошибка: «${lastErr}».` : ''} Подробности: ${where ? fwd(where) + ', ' : ''}${fwd(join(run, 'log.md'))}; повтор: та же команда с --redo ${failed}.`,
        `Stage ${failed} failed twice — the rest makes no sense without it.${lastErr ? ` Last error: "${lastErr}".` : ''} Details: ${where ? fwd(where) + ', ' : ''}${fwd(join(run, 'log.md'))}; retry: the same command with --redo ${failed}.`));
      say(`PIPELINE FAILED ${failed}`);
      return 1;
    }
    if (partial || !doneAll) {
      state = await stateUpdate(s => { s.done.pipeline = 'partial'; return s; });
      say(T(`PIPELINE PARTIAL — прошло ${elapsed}; запустите ту же команду ещё раз, продолжу с места остановки`, `PIPELINE PARTIAL — ${elapsed} elapsed; run the same command again to continue`));
      return 75;
    }
    const MARK = { ok: '✓', failed: '✗', missing: '—', skipped: '·' };
    say(T('Стадии: ', 'Stages: ') + plan.filter(x => x !== 'check').map(x => `${x} ${MARK[sNow[x]] || sNow[x]}`).join(' · ') + T('  (✓ готово, ✗ ошибка, — не установлен)', '  (✓ done, ✗ failed, — not installed)'));
    if (failedStages.length) say(T(`С ошибкой (после 2 попыток): ${failedStages.join(', ')} — эти замеры пойдут в «не проверено».`, `Failed (after 2 attempts): ${failedStages.join(', ')} — goes to "not checked".`));
    if (restOfFull.length) {
      state = await stateUpdate(s => { s.done.pipeline = 'partial'; return s; });
      U.log(run, `pipeline: стадии ${plan.filter(x => x !== 'check').join(', ')} готовы; до полного конвейера: ${restOfFull.join(', ')}`);
      say(T(`PIPELINE DONE (только стадии ${plan.filter(x => x !== 'check').join(', ')}) · ${elapsed}; до полного конвейера осталось: ${restOfFull.join(', ')} — команда без --stages доделает.`,
        `PIPELINE DONE (stages ${plan.filter(x => x !== 'check').join(', ')} only) · ${elapsed}; left for the full conveyor: ${restOfFull.join(', ')} — run without --stages.`));
      return 0;
    }
    state = await stateUpdate(s => { s.done.pipeline = 'ok'; return s; });
    U.log(run, `pipeline: DONE за ${elapsed}${failedStages.length ? `, с ошибкой: ${failedStages.join(', ')}` : ''}`);
    say(T(`PIPELINE DONE · ${elapsed}`, `PIPELINE DONE · ${elapsed}`));
    return 0;
  } finally {
    try { U.writeText(U.insideRun(run, 'stdout', 'pipeline.md'), out.slice(-40).join('\n') + '\n'); } catch {}
  }
}

main().then(code => process.exit(code || 0)).catch(async e => {
  const msg = String(e?.message || e).slice(0, 420);
  console.error(T('pipeline: сбой — ', 'pipeline: failure — ') + (e?.stack || e));
  try { U.log(run, `pipeline: сбой ${msg.slice(0, 200)}`); } catch {}
  // an internal crash is a failed run too: --next must see done.pipeline = failed, a running stage is not left "running"
  let at = 'pipeline';
  try {
    await stateUpdate(s => {
      for (const [k, v] of Object.entries(s.done)) if (k.startsWith('pipeline:') && v === 'running') { s.done[k] = 'failed'; at = k.slice(9); }
      s.done.pipeline = 'failed';
      (s.pipeline_errors ||= {})[at] = msg;
      return s;
    });
  } catch {}
  console.log(`PIPELINE FAILED ${at}`);
  process.exit(1);
});
