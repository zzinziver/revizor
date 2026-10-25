#!/usr/bin/env node
// Revizor — create a run folder <out>/<host>/<YYYY-MM-DD-HHMM>[-mode]/ with state.json, brief.input.json, log.md, stdout/
// (settings priority: see --help). Also: --resume, --list, --answer (brief answers), --brief-min.

import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as U from './lib/util.mjs';
import { createState, readState, updateState, resetRunning, nextStep, loadValidator, costModel, AGENT_LENSES, QUICK_TOPICS, SCHEMA_VERSION, statePath,
  parseSiteUrl, safePage, isPrivateLiteral } from './state.mjs';
import { readMemory } from './memory.mjs';
import { readXlsx } from './lib/xlsx.mjs';

const MODES = ['full', 'quick', 'rivals', 'recheck'];
const VERTICALS = ['auto', 'landing', 'local-services', 'shop', 'saas', 'finance', 'media', 'portfolio', 'nonprofit', 'medical', 'education', 'gov', 'other'];
const ENUMS = {
  profile: ['standard', 'strict'], audience: ['owner', 'team', 'external'], lang: ['auto', 'ru', 'en'], depth: ['lite', 'standard', 'deep'],
  models: ['economy', 'balanced', 'max'], market: ['auto', 'ru', 'intl'], vertical: VERTICALS, spell: ['auto', 'on', 'off'],
};
const DEFAULTS = { profile: 'standard', audience: 'owner', lang: 'auto', depth: 'standard', models: 'balanced', scores: false, parallel: 6, spell: 'auto', market: 'auto', vertical: 'auto', report_css: null };
const PAGES_BY_DEPTH = { lite: 3, standard: 4, deep: 30 };
const RESUME_HOURS = 48;
const FRESH_DAYS = 30;

const T = {
  ru: {
    profile: { standard: 'обычный', strict: 'строгий' }, audience: { owner: 'себе (владелец)', team: 'своей команде', external: 'чужой команде/клиенту' },
    depth: { lite: 'облегчённая', standard: 'стандартная', deep: 'глубокая' }, on: 'вкл.', off: 'выкл.',
    models: { economy: 'все агенты на Sonnet', balanced: 'темы на Sonnet, критик и редактор на модели сессии', max: 'все агенты на модели сессии' },
    sub: { pro: 'Pro', max5: 'Max 5×', max20: 'Max 20×', api: 'API / Team' }, lang: { ru: 'русский', en: 'английский' },
  },
  en: {
    profile: { standard: 'standard', strict: 'strict' }, audience: { owner: 'owner', team: 'team', external: 'external' },
    depth: { lite: 'light', standard: 'standard', deep: 'deep' }, on: 'on', off: 'off',
    models: { economy: 'all agents on Sonnet', balanced: 'topics on Sonnet, critic and editor on the session model', max: 'all agents on the session model' },
    sub: { pro: 'Pro', max5: 'Max 5×', max20: 'Max 20×', api: 'API / Team' }, lang: { ru: 'Russian', en: 'English' },
  },
};

const HELP = `
init-run.mjs — создать папку прогона Ревизора и всё, что нужно для старта.

Новый прогон:
  node init-run.mjs --url <адрес> [--mode full|quick|rivals|recheck] [флаги — /revizor:setup или README] [--new] [--json]
    --topic <тема>            для quick (${QUICK_TOPICS.join(', ')})
    --urls a,b,c              для rivals — адреса конкурентов; --groups "a.example:прямой,b.example:ориентир" — группы (GROUP= в промте)
    --from <RUN|xlsx|хост>    для recheck — что перепроверяем (pid берутся из старого pages.json)
    --depth --models --pages N --page <путь|url> --profile --audience --lang --market --vertical --stage
    --scores --strategy --baseline <url> --pdf --lenses a,b --skip a,b --no-questions --no-rivals --probe
    --spell/--no-spell --allow-load-posts --parallel N --brief <файл md|json> --keep-raw --out <папка>
    --subscription pro|max5|max20|api   пресет по подписке (Pro → lite, economy, 3 агента одновременно)
    --parts 2-4               полное ревью по частям: пауза после каждой части линз, продолжение — --resume
    --no-scores               без оценок (перекрывает config)
    --user-config "profile=…,audience=…,lang=…"   значения userConfig плагина (их подставляет навык)
  Адрес без схемы → https:// (localhost, 127.0.0.1, 192.168.*, *.local, *.test → http://); логин и пароль из адреса
  вырезаются с предупреждением; схемы кроме http(s) — ошибка (код 2).
  Печатает первой строкой RUN=<абсолютный путь>. Есть незавершённый прогон хоста того же режима моложе 48 ч —
  печатает UNFINISHED=<путь> и ничего не создаёт (продолжить: --resume <путь>; начать заново: тот же вызов с --new).

Продолжить:      node init-run.mjs --resume [<RUN>|<хост>] [--mode …]   → RUN=… и где остановились;
                 моложе 48 ч нет, есть старше — RESUME OLD=<путь> (спросить человека, продолжать ли)
Список:          node init-run.mjs --list [<хост>] [--mode full] [--done] [--limit 10] [--json]
Ответы брифа:    node init-run.mjs --run <RUN> --answer key=value [--answer …] | --answer-file <ответы.json>
                 свободный текст человека — только файлом: { "main_action": "…", "do_not_touch": ["…"] }
                 ключи: main_action, purpose, region, site_audience, audience, depth, lang, stage, stage_why, market, vertical,
                 do_not_touch, decision, known_issues, do_not_suggest, notes, goal, fact (имя=значение), urls, topic,
                 brief_last_ok (yes|no), scores, strategy, pdf, spell (on|off|auto), search (on|off — запросы с доменом), groups (хост:прямой|сопоставимый|ориентир,…),
                 accept_blocked (yes — продолжать по доступным страницам), parts (2-4|0), engine (yandex|google|both), device (iphone|android|both|none),
                 subscription (pro|max5|max20|api — пресет заново для глубины, моделей и числа агентов, которых человек не выбирал),
                 depth=quick — вместо полного ревью быстрая проверка health
Бриф без разведчика (quick, rivals, recheck):  node init-run.mjs --run <RUN> --brief-min
Приоритет настроек: флаг → ~/.revizor/config.json → пресет подписки → userConfig → по умолчанию (depth, models,
parallel из config, которых человек сам не выбирал — нет в config.user_set, — уступают пресету подписки). Неизвестное значение → по умолчанию + предупреждение.
Коды: 0 — готово, 2 — ошибка аргументов, 1 — сбой.
`;

// ---------- small helpers ----------
const fwd = p => String(p).replace(/\\/g, '/');
const today = () => new Date().toISOString().slice(0, 10);
function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
function fmtDate(iso) {
  const d = new Date(iso); if (Number.isNaN(+d)) return '—';
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function isDir(p) { try { return statSync(p).isDirectory(); } catch { return false; } }
function ls(p) { try { return readdirSync(p); } catch { return []; } }
const bool = v => v === true || v === 'true' || v === 'yes' || v === 'да' || v === '1' || v === 'on';

// The address parser lives in state.mjs (state checks every address again before printing it in a command)
export { parseSiteUrl };
function normalizeSiteUrl(input, warnings, lang) {
  const r = parseSiteUrl(input, lang);
  warnings.push(...r.warnings);
  if (r.error) warnings.push(r.error);
  return r.url;
}

function userConfigValues(args) {
  const out = {};
  const put = (k, v) => { if (v === undefined || v === null) return; v = String(v).trim(); if (!v || v.includes('${')) return; out[k] = v; };
  for (const k of ['profile', 'audience', 'lang']) put(k, process.env[`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`]);
  if (args['user-config'] && args['user-config'] !== true) {
    for (const part of String(args['user-config']).split(/[,;]/)) { const [k, ...v] = part.split('='); if (k && v.length) put(k.trim(), v.join('=')); }
  }
  return out;
}

// Subscription of the person (flag --subscription or config.subscription from /revizor:setup) → its preset (knowledge/cost.md)
const SUB_ALIASES = [[/^pro$/, 'pro'], [/^max\s*-?\s*5\s*[x×х]?$/, 'max5'], [/^max\s*-?\s*20\s*[x×х]?$/, 'max20'], [/^(api|team|enterprise|teams)$/, 'api']];
function subscriptionOf(v) {
  const s = String(v ?? '').trim().toLowerCase();
  return (SUB_ALIASES.find(([re]) => re.test(s)) || [])[1] || null;
}

// flag → config.json → subscription preset → userConfig → default; unknown → default + warning
function resolveSettings(args, cfg, uc, warnings, lang, sub = null) {
  const set = {}, source = {};
  const check = (key, v) => {
    if (key === 'scores') return typeof v === 'boolean' ? v : bool(v);
    if (key === 'parallel') { const n = Math.round(Number(v)); return n >= 1 && n <= 20 ? n : undefined; }
    if (key === 'report_css') return v ? resolve(String(v)) : null;
    if (key === 'spell') { if (v === true || v === 'on' || v === 'true') return 'on'; if (v === false || v === 'off' || v === 'false') return 'off'; return v === 'auto' ? 'auto' : undefined; }
    const s = String(v).toLowerCase();
    return ENUMS[key]?.includes(s) ? s : undefined;
  };
  for (const key of Object.keys(DEFAULTS)) {
    // a config value of depth/models/parallel the person did not choose himself (not in config.user_set) yields to the subscription
    // preset: an old «parallel: 6» must not override Pro → 3
    const userSet = new Set(Array.isArray(cfg.user_set) ? cfg.user_set : []);
    const cfgVal = sub && key in sub && !userSet.has(key) ? undefined : cfg[key];
    const tries = [['flag', args[key]], ['config', cfgVal], ['subscription', sub ? sub[key] : undefined], ['user_config', uc[key]]];
    let done = false;
    for (const [src, v] of tries) {
      if (v === undefined || v === null || (v === true && key !== 'scores' && key !== 'spell')) continue;
      const ok = check(key, v);
      if (ok === undefined) { warnings.push(lang === 'en' ? `Unknown ${key}=«${v}» (${src}) — ignored.` : `Неизвестное значение ${key}=«${v}» (${{ flag: 'флаг', config: 'config.json', subscription: 'подписка' }[src] || 'userConfig'}) — не использую.`); continue; }
      set[key] = ok; source[key] = src; done = true; break;
    }
    if (!done) { set[key] = DEFAULTS[key]; source[key] = 'default'; }
  }
  return { set, source };
}

// ---------- runs on disk ----------
function outRoot(args, cfg) {
  if (args.out && args.out !== true) return { out: resolve(String(args.out)), source: 'flag' };
  if (cfg.out) return { out: resolve(String(cfg.out)), source: 'config' };
  return { out: U.defaultOutDir(), source: 'default' };
}
/** A run is finished when --next said so, the orchestrator set final=ok, or the editor reported a built report. */
export function runIsDone(s, run) {
  if (!s) return false;
  if (s.stage === 'done' || s.done?.final === 'ok') return true;
  const rep = s.mode === 'rivals' ? 'rivals.html' : s.mode === 'recheck' ? 'recheck.html' : 'report.html';
  return s.done?.report === 'ok' && existsSync(join(run, 'report', rep));
}
/** All runs under out (optionally one host): newest first. */
export function listRuns(out, hostKey = null) {
  const res = [];
  for (const h of hostKey ? [hostKey] : ls(out)) {
    const hd = join(out, h);
    if (!isDir(hd)) continue;
    for (const r of ls(hd)) {
      const run = join(hd, r);
      if (!existsSync(join(run, 'state.json'))) continue;
      const s = readState(run);
      if (!s) continue;
      const rep = s.mode === 'rivals' ? 'rivals.html' : s.mode === 'recheck' ? 'recheck.html' : 'report.html';
      const repPath = join(run, 'report', rep);
      const reg = s.mode === 'recheck' ? ls(join(run, 'report')).filter(n => /^registry-recheck-.*\.xlsx$/.test(n)).sort().pop() : (s.mode === 'rivals' ? 'rivals.xlsx' : 'registry.xlsx');
      const done = runIsDone(s, run);
      res.push({ run, host: h, url: s.flags?.url || null, mode: s.mode, stage: done ? 'done' : s.stage === 'blocked' && s.done?.pipeline === 'failed' ? 'pipeline_failed' : s.stage, done, started: s.started || s.updated,
        updated: s.updated, report: existsSync(repPath) ? repPath : null, registry: reg && existsSync(join(run, 'report', reg)) ? join(run, 'report', reg) : null });
    }
  }
  return res.sort((a, b) => String(b.started).localeCompare(String(a.started)));
}
function unfinished(out, hostKey, mode, hours = RESUME_HOURS) {
  const limit = Date.now() - hours * 3600e3;
  return listRuns(out, hostKey).filter(r => !r.done && (!mode || r.mode === mode) && new Date(r.updated || r.started).getTime() > limit);
}
function whereStopped(run, lang) {
  const s = readState(run);
  if (!s) return '—';
  try {
    const n = nextStep(JSON.parse(JSON.stringify(s)), run);
    const l = n.progress?.lenses;
    return `${n.title}${l ? (lang === 'en' ? `, lenses ${l.ok}/${l.total}` : `, линзы ${l.ok}/${l.total}`) : ''}`;
  } catch { return s.stage; }
}

// ---------- brief.input.json ----------
function emptyLists() {
  return { owner_decisions: [], do_not_suggest: [], do_not_touch: [], known_issues: [], verified_facts: {}, not_a_bug_at_stage: [], human_checks: [] };
}
function mergeMemory(bi, mem) {
  let n = 0;
  for (const k of ['owner_decisions', 'do_not_suggest', 'do_not_touch', 'known_issues']) {
    for (const it of mem[k] || []) { bi[k].push(typeof it === 'string' ? { text: it, source: 'memory' } : { ...it, source: it.source ? `memory:${it.source}` : 'memory' }); n++; }
    if ((mem[k] || []).length) bi.source[k] = 'memory';
  }
  for (const [k, v] of Object.entries(mem.verified_facts || {})) { if (!(k in bi.verified_facts)) { bi.verified_facts[k] = v; n++; } }
  if (Object.keys(mem.verified_facts || {}).length) bi.source.verified_facts = 'memory';
  return n;
}
function mergeBriefFile(bi, file, run, warnings, lang) {
  const p = resolve(String(file));
  if (!existsSync(p)) { warnings.push(lang === 'en' ? `--brief file not found: ${p}` : `Файл --brief не найден: ${p}`); return null; }
  const ext = extname(p).toLowerCase();
  const raw = readFileSync(p, 'utf8').replace(/^﻿/, '');
  const copy = join(run, `brief.source${ext === '.json' ? '.json' : '.md'}`);
  writeFileSync(copy, raw, 'utf8');
  if (ext === '.json') {
    let d;
    try { d = JSON.parse(raw); } catch (e) { warnings.push(lang === 'en' ? `--brief JSON is broken: ${e.message}` : `JSON в --brief не читается: ${e.message}`); return copy; }
    for (const k of ['owner_decisions', 'do_not_suggest', 'do_not_touch', 'known_issues', 'not_a_bug_at_stage', 'human_checks', 'goals_questions']) {
      if (Array.isArray(d[k]) && d[k].length) { (bi[k] ||= []).push(...d[k].map(x => typeof x === 'string' ? (k === 'goals_questions' ? x : { text: x, source: 'user' }) : x)); bi.source[k] = 'user'; }
    }
    if (d.verified_facts && typeof d.verified_facts === 'object') { Object.assign(bi.verified_facts, d.verified_facts); bi.source.verified_facts = 'user'; }
    if (d.site && typeof d.site === 'object') { bi.site = { ...(bi.site || {}), ...d.site }; bi.source.site = 'user'; }
    for (const k of ['stage', 'stage_why', 'vertical', 'market', 'audience', 'notes', 'platform', 'access']) if (d[k] !== undefined && bi[k] === undefined) { bi[k] = d[k]; bi.source[k] = 'user'; }
  } else {
    bi.notes = [bi.notes, raw.slice(0, 20000)].filter(Boolean).join('\n\n');
    bi.source.notes = 'user';
  }
  return copy;
}

// ---------- create ----------
async function create(args, lang) {
  const warnings = [];
  const mode = args.mode && args.mode !== true ? String(args.mode).toLowerCase() : 'full';
  if (!MODES.includes(mode)) { console.error(lang === 'en' ? `--mode: one of ${MODES.join(', ')}` : `--mode: одно из ${MODES.join(', ')}`); process.exit(2); }
  const cfgR = U.readRevizorConfig();
  if (cfgR.error) warnings.push(lang === 'en' ? `~/.revizor/config.json is broken (${cfgR.error}) — defaults used.` : `~/.revizor/config.json не читается (${cfgR.error}) — беру значения по умолчанию.`);
  const cfg = cfgR.config;
  const { out, source: outSource } = outRoot(args, cfg);

  // recheck: what are we rechecking?
  let from = null, fromRun = null, xlsxMeta = null;
  if (mode === 'recheck') {
    const r = resolveRecheckFrom(args, out, lang);
    if (r.error) { console.error(r.error); process.exit(2); }
    const bad = schemaMismatch(r);
    if (bad) {
      console.error(lang === 'en' ? `That run was made by another data format (schema ${bad.schema}${bad.plugin ? `, plugin ${bad.plugin}` : ''}; now ${SCHEMA_VERSION}) — a recheck against it is not possible. Run a full review: /revizor:full <site>.`
        : `Тот прогон сделан другой версией формата (схема ${bad.schema}${bad.plugin ? `, плагин ${bad.plugin}` : ''}; сейчас ${SCHEMA_VERSION}) — перепроверка по нему невозможна. Запустите полное ревью: /revizor:full <сайт>.`);
      process.exit(2);
    }
    ({ from, fromRun, xlsxMeta } = r);
  }

  let urlIn = args.url && args.url !== true ? args.url : args._[0];
  if (!urlIn && fromRun) urlIn = (U.readJSON(join(fromRun, 'brief.json'), null) || U.readJSON(join(fromRun, 'brief.input.json'), null) || {}).url
    || (U.readJSON(join(fromRun, 'pages.json'), null) || {}).final_origin || (readState(fromRun) || {}).flags?.url;
  if (!urlIn && xlsxMeta?.site) urlIn = xlsxMeta.site;
  const parsed = parseSiteUrl(urlIn, lang);
  if (!parsed.url) { console.error(parsed.error || U.msg('need_url', lang)); process.exit(2); }
  const url = parsed.url;
  warnings.push(...parsed.warnings);
  const host = new URL(url).hostname;
  const hk = U.hostKey(url);

  if (!args.new) {
    const unf = unfinished(out, hk, mode);
    if (unf.length) {
      const r = unf[0];
      const lines = [`UNFINISHED=${fwd(r.run)}`,
        lang === 'en' ? `There is an unfinished ${mode} run of this site (${fmtDate(r.started)}, stopped at: ${whereStopped(r.run, lang)}).`
          : `Есть незавершённый прогон этого сайта (${fmtDate(r.started)}, остановился на: ${whereStopped(r.run, lang)}).`,
        lang === 'en' ? `Ask: «Continue» → node "${fwd(fileURLToPath(import.meta.url))}" --resume "${fwd(r.run)}" / «Start over» → the same init-run call with --new.`
          : `Спросите: «Продолжить» → node "${fwd(fileURLToPath(import.meta.url))}" --resume "${fwd(r.run)}" / «Начать заново» → тот же вызов init-run с --new.`];
      if (args.json) process.stdout.write(JSON.stringify({ unfinished: fwd(r.run), stage: r.stage, started: r.started }, null, 2) + '\n');
      else U.printAndSaveSummary(null, 'init-run', lines);
      return;
    }
  }

  const uc = userConfigValues(args);
  let subscription = null;
  for (const [src, v] of [['flag', args.subscription], ['config', cfg.subscription]]) {
    if (v === undefined || v === null || v === true || v === '') continue;
    subscription = subscriptionOf(v);
    if (subscription) break;
    warnings.push(lang === 'en' ? `Unknown subscription «${v}» (${src}) — expected pro, max5, max20 or api.` : `Подписку «${v}» (${src === 'flag' ? 'флаг' : 'config.json'}) не понял — нужно pro, max5, max20 или api.`);
  }
  const subPreset = subscription ? costModel().subscriptions[subscription] : null;
  const { set, source } = resolveSettings({ ...args, spell: args.spell }, cfg, uc, warnings, lang, subPreset);
  const depth = set.depth;
  let parts = 0;
  if (args.parts !== undefined) {
    const n = args.parts === true ? 3 : Math.round(Number(args.parts));
    if (mode !== 'full') warnings.push(lang === 'en' ? '--parts works only for a full review — ignored.' : '--parts — только для полного ревью, не использую.');
    else if (n >= 2 && n <= 4) parts = n;
    else warnings.push(lang === 'en' ? `--parts ${args.parts}: 2–4 — ignored.` : `--parts ${args.parts}: можно 2–4 — не использую.`);
  }

  // lang: flag → config → userConfig → system → ru
  let runLang = set.lang, langWhy = { flag: 'флаг --lang', config: 'config.json', user_config: 'userConfig' }[source.lang];
  if (runLang === 'auto') { const sl = U.systemLang(); runLang = sl.lang; langWhy = sl.why; }

  // pages
  let pages = PAGES_BY_DEPTH[depth];
  if (mode === 'quick') pages = 3;
  if (args.pages && args.pages !== true) {
    const n = Math.round(Number(args.pages));
    if (n >= 1 && n <= 200) pages = n; else warnings.push(lang === 'en' ? `--pages ${args.pages} ignored.` : `--pages ${args.pages} не понял — беру ${pages}.`);
  }
  // --page values are printed inside "…" in pipeline commands: stored already parsed and percent-encoded
  const page = [];
  for (const p of U.listArg(args.page)) {
    const sp = safePage(p, lang);
    if (sp) page.push(sp); else warnings.push(lang === 'en' ? `--page «${String(p).slice(0, 60)}» is not a path or an address of the site — skipped.` : `--page «${String(p).slice(0, 60)}» — не путь и не адрес страницы, пропускаю.`);
  }

  // lenses
  const pickLenses = (v, name) => {
    const ids = [...new Set(U.listArg(v).map(x => x.toLowerCase()).flatMap(x => (x === 'seo' ? ['seo-tech', 'seo-content'] : [x])))];
    const bad = ids.filter(x => !AGENT_LENSES.includes(x));
    if (bad.length) warnings.push(lang === 'en' ? `${name}: unknown lenses ${bad.join(', ')} ignored.` : `${name}: неизвестные линзы ${bad.join(', ')} — пропускаю.`);
    return ids.filter(x => AGENT_LENSES.includes(x));
  };
  const lenses = pickLenses(args.lenses, '--lenses');
  const skip = pickLenses(args.skip, '--skip');

  // quick topic
  let topic = null;
  if (mode === 'quick') {
    const pos = args.url && args.url !== true ? args._[0] : args._[1];
    const t = args.topic && args.topic !== true ? String(args.topic).toLowerCase() : (pos ? String(pos).toLowerCase() : null);
    if (t && QUICK_TOPICS.includes(t)) topic = t;
    else if (t) warnings.push(lang === 'en' ? `Unknown topic «${t}» — ask the user.` : `Тема «${t}» неизвестна — спросите человека.`);
  }

  // rivals
  let urls = [];
  if (mode === 'rivals') {
    const raw = [...U.listArg(args.urls), ...(args.url ? args._ : args._.slice(1))];
    urls = [...new Set(raw.map(x => normalizeSiteUrl(x, warnings, lang)).filter(Boolean))].filter(u => U.hostKey(u) !== hk);
  }

  // stage
  let stage = null;
  if (args.stage && args.stage !== true) {
    const s = String(args.stage).toLowerCase();
    if (['live', 'beta', 'prototype'].includes(s)) stage = s; else warnings.push(lang === 'en' ? `--stage ${s} unknown — will be detected.` : `--stage ${s} не понял — определим по признакам.`);
  }

  // scores and audience
  let scores = set.scores;
  if (scores && set.audience === 'external') { scores = false; warnings.push(lang === 'en' ? 'Scores are not available for an external audience — off.' : 'Оценки для чужой команды недоступны — выключил.'); }
  if (args.strategy && set.audience === 'external') warnings.push(lang === 'en' ? 'Strategies are not included in an external report.' : 'Стратегии в отчёт для чужой команды не попадают.');

  // isPrivateLiteral also catches IPv4 inside IPv6 ([::ffff:7f00:1]) that util.resolvesPrivate misses
  const privateHost = isPrivateLiteral(host) || await U.resolvesPrivate(host);

  // previous runs of this host
  const prev = listRuns(out, hk).filter(r => r.done && existsSync(join(r.run, 'pages.json')));
  const prevRun = prev[0] || null;
  const prevFresh = !!prevRun && Date.now() - new Date(prevRun.started).getTime() < FRESH_DAYS * 86400e3;

  // folders
  // <out>/.gitignore «*» only in a folder that belongs to Revizor: never ignore somebody's project by accident
  const hadIgnore = existsSync(join(out, '.gitignore'));
  const entries = ls(out);
  const looksOurs = n => n.startsWith('.revizor') || (isDir(join(out, n)) && (existsSync(join(out, n, 'site-memory.json')) || ls(join(out, n)).some(r => existsSync(join(out, n, r, 'state.json')))));
  const dedicated = !existsSync(join(out, '.git')) && (entries.length === 0 || entries.every(looksOurs));
  try { U.ensureDir(out); } catch (e) { console.error(lang === 'en' ? `Cannot create ${out}: ${e.message}` : `Не получается создать ${out}: ${e.message}`); process.exit(2); }
  const outIsNew = !hadIgnore && dedicated;
  if (outIsNew) writeFileSync(join(out, '.gitignore'), '*\n', 'utf8');
  if (!hadIgnore && !dedicated) warnings.push(lang === 'en' ? `${fwd(out)} has other files — no .gitignore written there; runs go to ${fwd(join(out, hk))}.`
    : `В ${fwd(out)} есть чужие файлы — .gitignore туда не кладу; прогоны лягут в ${fwd(join(out, hk))}.`);
  const gitRoot = outIsNew || !dedicated ? findGitRoot(out) : null;
  const hostDir = U.ensureDir(join(out, hk));
  let name = stamp() + (mode === 'full' ? '' : `-${mode}`);
  let run = join(hostDir, name);
  for (let i = 2; existsSync(run); i++) run = join(hostDir, `${name}-${i}`);
  U.ensureDir(join(run, 'stdout'));

  const flags = {
    url, host, host_key: hk, out, depth, models: set.models, profile: set.profile, audience: set.audience, lang: runLang, lang_why: langWhy,
    market: set.market, vertical: set.vertical, stage, scores, strategy: !!args.strategy, baseline: args.baseline && args.baseline !== true ? normalizeSiteUrl(args.baseline, warnings, lang) : null,
    pdf: !!args.pdf, lenses, skip, no_questions: !!args['no-questions'], no_rivals: !!args['no-rivals'], probe: !!args.probe,
    spell: set.spell, allow_load_posts: !!args['allow-load-posts'], parallel: set.parallel, brief: null, keep_raw: !!args['keep-raw'],
    pages, page, topic, urls, from, from_run: fromRun, pages_from: null,
    prev_run: prevRun ? prevRun.run : null, prev_run_date: prevRun ? prevRun.started : null, prev_run_fresh: prevFresh,
    private_host: privateHost, report_css: set.report_css, subscription, parts,
    // nobody chose the models and the subscription is unknown: the default is printed now and in the final summary and report
    models_note: !subscription && source.models === 'default' ? 'no_subscription' : null,
    rival_groups: mode === 'rivals' && args.groups && args.groups !== true ? parseGroups(args.groups, warnings) : {}, settings_source: { ...source, out: outSource },
  };

  // brief.input.json
  const bi = { url, host, started: U.nowIso(), mode, depth, models: set.models, profile: set.profile, audience: set.audience, lang: runLang, lang_why: langWhy,
    ...emptyLists(), site: {}, source: {}, limits: { pages, page, probe: flags.probe, private_host: privateHost } };
  for (const k of ['depth', 'models', 'profile', 'audience', 'lang']) if (['flag', 'config', 'subscription', 'user_config'].includes(source[k]) && bi[k] !== 'auto') bi.source[k] = 'user';
  if (set.market !== 'auto') { bi.market = { value: set.market, why: 'флаг --market', search_engines: set.market === 'ru' ? ['yandex', 'google'] : ['google'] }; bi.source.market = 'user'; }
  if (set.vertical !== 'auto') { bi.vertical = set.vertical; bi.source.vertical = 'user'; }
  if (stage) { bi.stage = stage; bi.stage_why = 'флаг --stage'; bi.source.stage = 'user'; }
  if (lenses.length) { bi.lenses = lenses; bi.source.lenses = 'user'; }
  if (skip.length) bi.skip_lenses = skip;
  if (flags.baseline) bi.baseline = flags.baseline;
  if (topic) bi.topic = topic;
  // an empty list «from the user» stops the scout's competitor search for good; lite needs no such mark (the scout and
  // state skip competitors at depth lite), so a later answer depth=standard|deep still gets the light snapshot
  if (flags.no_rivals || mode !== 'full') { bi.rivals_light = []; bi.source.rivals_light = 'user'; }
  if (privateHost) { bi.external_services = { spell: false, psi: false, crtsh: false, regions: false }; bi.source.external_services = 'user'; }
  else if (set.spell !== 'auto') { bi.external_services = { spell: set.spell === 'on' }; bi.source.external_services = 'user'; }
  // WebSearch/WebFetch with the domain or the company name: off for an external audience (like the Speller), on otherwise;
  // an answer of the brief (search=on|off, audience) can switch it
  bi.external_services = { ...(bi.external_services || {}), search: !privateHost && set.audience !== 'external' };
  bi.source['external_services.search'] = 'auto';
  bi.flags = { scores, strategy: flags.strategy, pdf: flags.pdf, no_questions: flags.no_questions, no_rivals: flags.no_rivals, probe: flags.probe, keep_raw: flags.keep_raw, allow_load_posts: flags.allow_load_posts };

  const mem = readMemory(out, hk);
  bi.memory_applied = mem ? mergeMemory(bi, mem) : 0;
  if (mem?.brief_last) bi.brief_last = mem.brief_last;
  if (args.brief && args.brief !== true) { flags.brief = mergeBriefFile(bi, args.brief, run, warnings, lang); }

  // what the brief question still has to ask; the volume is always confirmed: it decides the load on the limit
  const ask = [];
  if (mode === 'full' && !flags.no_questions) {
    if (bi.brief_last) ask.push('brief_last_ok');
    else if (!bi.site.main_action) ask.push('main_action');
    if (!['flag', 'config'].includes(source.audience)) ask.push('audience');
    ask.push('depth');
    if (ask.length < 4) ask.push('do_not_touch');
  }
  bi.ask = ask;

  // recheck: carry pages and brief of the old run
  if (mode === 'recheck' && fromRun) {
    if (existsSync(join(fromRun, 'pages.json'))) { copyFileSync(join(fromRun, 'pages.json'), join(run, 'pages.from.json')); flags.pages_from = join(run, 'pages.from.json'); }
    const ob = U.readJSON(join(fromRun, 'brief.json'), null);
    if (ob) U.writeJSON(join(run, 'brief.json'), { ...ob, mode: 'recheck', started: bi.started, source: { ...(ob.source || {}), copied_from: fwd(fromRun) } });
  }

  U.writeJSON(join(run, 'brief.input.json'), bi);
  writeFileSync(join(run, 'log.md'), `# Журнал прогона\n\nСайт: ${url} · режим ${mode} · начат ${bi.started}\n` +
    'Строки с пометкой [external] — что отправлялось во внешние сервисы (сервис · что · сколько); отчёт собирает их в раздел «Что отправлялось во внешние сервисы».\n\n', 'utf8');
  U.log(run, `init-run: создан прогон ${mode} для ${url} (out: ${outSource})`);
  await createState(run, { mode, flags });

  // summary
  const t = T[lang];
  const memN = bi.memory_applied;
  const lines = [
    `RUN=${fwd(run)}`,
    lang === 'en' ? `Site: ${url} · mode ${mode} · host folder ${hk}` : `Сайт: ${url} · режим ${mode} · папка хоста ${hk}`,
    lang === 'en'
      ? `Settings: profile ${t.profile[set.profile]}, report for ${t.audience[set.audience]}, depth ${t.depth[depth]}, ${t.models[set.models] || set.models}, scores ${scores ? t.on : t.off}, language ${t.lang[runLang] || runLang} (change: /revizor:setup)`
      : `Настройки: профиль ${t.profile[set.profile]}, кому — ${t.audience[set.audience]}, глубина ${t.depth[depth]}, ${t.models[set.models] || set.models}, оценки ${scores ? t.on : t.off}, язык ${t.lang[runLang] || runLang} (изменить: /revizor:setup)`,
    (() => {
      const par = lang === 'en' ? `agents at once: ${set.parallel}` : `агентов одновременно: ${set.parallel}`;
      if (mode === 'rivals') return lang === 'en' ? `Agents at once: ${set.parallel}` : `Агентов одновременно: ${set.parallel}`;
      if (mode === 'recheck') return (lang === 'en' ? 'Pages: the same as in the checked run · ' : 'Страницы: те же, что в проверяемом прогоне · ') + par;
      if (page.length) return (lang === 'en' ? `Pages: only ${page.join(', ')} — the home page is not included · ` : `Страницы: только ${page.join(', ')} — главная в прогон не входит · `) + par;
      return (lang === 'en' ? `Pages: up to ${pages} · ` : `Страниц: до ${pages} · `) + par;
    })(),
    subscription ? (lang === 'en' ? `Subscription: ${t.sub[subscription] || subscription}${subPreset ? ` (unless chosen otherwise: depth ${t.depth[subPreset.depth] || subPreset.depth}, ${t.models[subPreset.models] || subPreset.models}, ${subPreset.parallel} agents at once)` : ''}`
      : `Подписка: ${t.sub[subscription] || subscription}${subPreset ? ` (если не выбрано иное: глубина ${t.depth[subPreset.depth] || subPreset.depth}, ${t.models[subPreset.models] || subPreset.models}, агентов одновременно ${subPreset.parallel})` : ''}`) : null,
    flags.models_note ? (lang === 'en' ? `Models: ${set.models} — subscription not known; all agents on the session model — say «models max» or run /revizor:setup`
      : `Модели: ${set.models} — подписка не определена; для всех агентов на модели сессии — «модели max» или /revizor:setup`) : null,
    parts ? (lang === 'en' ? `In parts: ${parts} (a pause after each part of lenses, continue with --resume)` : `По частям: ${parts} (пауза после каждой части линз, продолжение — --resume)`) : null,
    topic ? (lang === 'en' ? `Topic: ${topic}` : `Тема: ${topic}`) : null,
    urls.length ? (lang === 'en' ? `Competitors: ${urls.length}` : `Конкурентов: ${urls.length}`) : null,
    from ? (lang === 'en' ? `Recheck of: ${fwd(from)}` : `Перепроверяем: ${fwd(from)}`) : null,
    memN ? (lang === 'en' ? `Site memory: ${memN} earlier decisions applied (site-memory.json).` : `Память сайта: учтено прошлых решений — ${memN} (site-memory.json).`) : null,
    ask.length ? (lang === 'en' ? `Brief: ask ${ask.join(', ')}` : `Бриф: спросить — ${ask.map(k => ({ brief_last_ok: 'актуален ли прошлый бриф', main_action: 'главное действие', audience: 'кому отчёт', depth: 'объём', do_not_touch: 'что не трогать' }[k])).join(', ')}`) : null,
    privateHost ? (lang === 'en' ? 'Local site: external services are off.' : 'Сайт локальный: внешние сервисы выключены.') : null,
    gitRoot ? (lang === 'en' ? `OUT_IN_GIT: the run folder is inside a git repository (${fwd(gitRoot)}); ${outIsNew ? 'a .gitignore «*» keeps reports out of commits' : 'reports WILL show up in git'} — confirm once that reports should live there (or --out elsewhere).`
      : `OUT_IN_GIT: папка прогонов внутри git-репозитория (${fwd(gitRoot)}); ${outIsNew ? 'отчёты из коммитов убирает .gitignore «*»' : 'отчёты ПОПАДУТ в git'} — один раз уточните у человека, точно ли класть их туда (или --out в другую папку).`) : null,
    ...warnings.map(w => (lang === 'en' ? 'Warning: ' : 'Предупреждение: ') + w),
    `${lang === 'en' ? 'Next' : 'Дальше'}: node "${fwd(join(dirname(fileURLToPath(import.meta.url)), 'state.mjs'))}" --run "${fwd(run)}" --next`,
  ];
  if (args.json) process.stdout.write(JSON.stringify({ run: fwd(run), host, host_key: hk, url, mode, flags, ask, warnings, out_in_git: gitRoot ? fwd(gitRoot) : null }, null, 2) + '\n');
  else U.printAndSaveSummary(run, 'init-run', lines);
}

function findGitRoot(dir) {
  let d = resolve(dir);
  for (;;) {
    if (existsSync(join(d, '.git'))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// --from for recheck: RUN folder | registry .xlsx | host/url (→ last finished full run)
// schema_version of the old RUN (state.json) or of the registry (_revizor meta) ≠ ours → { schema, plugin } | null
function schemaMismatch(r) {
  const cands = [];
  const st = r.fromRun ? readState(r.fromRun) : null;
  if (st && st.schema_version !== undefined) cands.push({ schema: st.schema_version, plugin: st.plugin_version || null });
  if (r.xlsxMeta?.schema_version) cands.push({ schema: r.xlsxMeta.schema_version, plugin: r.xlsxMeta.plugin_version || null });
  return cands.find(c => Number.isFinite(Number(c.schema)) && Number(c.schema) !== SCHEMA_VERSION) || null;
}
function resolveRecheckFrom(args, out, lang) {
  const v = args.from && args.from !== true ? String(args.from) : (args.url && args.url !== true ? String(args.url) : args._[0]);
  if (!v) return { error: lang === 'en' ? 'recheck needs --from <RUN|registry.xlsx|host>' : 'Для recheck нужен --from <папка прогона | registry.xlsx | хост>.' };
  const p = resolve(v);
  if (isDir(p) && (existsSync(join(p, 'state.json')) || existsSync(join(p, 'pages.json')))) return { from: p, fromRun: p };
  if (existsSync(p) && /\.xlsx$/i.test(p)) {
    let meta = null;
    try { meta = readRegistryMeta(p); } catch { /* still usable by recheck.mjs */ }
    const maybeRun = dirname(dirname(p));
    if (existsSync(join(maybeRun, 'state.json')) || existsSync(join(maybeRun, 'pages.json'))) return { from: p, fromRun: maybeRun, xlsxMeta: meta };
    if (meta?.site) {
      const runs = listRuns(out, U.hostKey(meta.site)).filter(r => r.done && r.mode === 'full');
      const byDate = runs.find(r => meta.run_date && String(r.started).startsWith(String(meta.run_date).slice(0, 10)));
      return { from: p, fromRun: (byDate || runs[0] || {}).run || null, xlsxMeta: meta };
    }
    return { from: p, fromRun: null, xlsxMeta: meta };
  }
  const hk = U.hostKey(v);
  const runs = hk ? listRuns(out, hk).filter(r => r.done && r.mode === 'full') : [];
  if (!runs.length) return { error: lang === 'en' ? `No finished full run found for «${v}» in ${out}.` : `Не нашёл завершённого полного прогона для «${v}» в ${out}. Список: node init-run.mjs --list` };
  return { from: runs[0].run, fromRun: runs[0].run };
}
export function readRegistryMeta(xlsxPath) {
  const book = readXlsx(xlsxPath);
  const sh = book.sheets.find(s => s.name === '_revizor');
  if (!sh) return null;
  const meta = {};
  for (const row of sh.rows) {
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (typeof c !== 'string') continue;
      const m = c.match(/^(site|run_date|plugin_version|schema_version)\s*[:=]\s*(.+)$/i);
      if (m) meta[m[1].toLowerCase()] = m[2].trim();
      else if (/^(site|run_date|plugin_version|schema_version)$/i.test(c) && row[i + 1] !== undefined && row[i + 1] !== null) meta[c.toLowerCase()] = String(row[i + 1]);
    }
  }
  return meta;
}

// ---------- --answer-file: free text of the person never goes through the command line ----------
// JSON: { "main_action": "…", "do_not_touch": ["…", "…"], "groups": { "a.example": "прямой" } } or [ "key=value", … ]
function answerFilePairs(file, lang) {
  let d;
  try { d = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')); }
  catch (e) { return { error: lang === 'en' ? `--answer-file ${file}: ${e.message}` : `--answer-file ${file} не читается как JSON: ${e.message}` }; }
  const pairs = [];
  const one = (k, v) => {
    if (v === null || v === undefined) return;
    if (Array.isArray(v)) { if (k === 'urls') pairs.push(`urls=${v.join(',')}`); else for (const x of v) one(k, x); return; }
    if (typeof v === 'object') { pairs.push(`${k}=${Object.entries(v).map(([a, b]) => `${a}:${b}`).join(',')}`); return; }
    pairs.push(`${k}=${String(v).replace(/[\r\n]+/g, ' ').trim()}`);
  };
  if (Array.isArray(d)) for (const x of d) { if (typeof x === 'string' && x.includes('=')) pairs.push(x); }
  else if (d && typeof d === 'object') for (const [k, v] of Object.entries(d)) one(k, v);
  else return { error: lang === 'en' ? '--answer-file: expected a JSON object' : '--answer-file: нужен JSON-объект { "ключ": "значение" }' };
  return { pairs };
}
const GROUP_ALIASES = [[/^(прям\S*|direct)$/i, 'прямой'], [/^(сопостав\S*|comparable|similar)$/i, 'сопоставимый'], [/^(ориентир\S*|миров\S*|benchmark|reference|global)$/i, 'ориентир']];
/** "a.example:прямой,b.example:ориентир" → { 'a.example': 'прямой', … } (host keys) */
function parseGroups(v, warnings) {
  const map = {};
  for (const part of String(v || '').split(/[,;]/)) {
    if (!part.trim()) continue;
    const m = part.trim().match(/^(.+)[:=]\s*([^:=]+)$/);
    const g = m ? (GROUP_ALIASES.find(([re]) => re.test(m[2].trim())) || [])[1] : null;
    const h = m ? U.hostKey(m[1].trim()) : '';
    if (!g || !h) { warnings.push(`groups: «${part.trim()}» — нужно хост:прямой|сопоставимый|ориентир`); continue; }
    map[h] = g;
  }
  return map;
}

// ---------- --answer ----------
const LIST_KEYS ={ do_not_touch: 'do_not_touch', decision: 'owner_decisions', owner_decisions: 'owner_decisions', known_issues: 'known_issues', known: 'known_issues', do_not_suggest: 'do_not_suggest' };
async function answer(run, pairs, lang) {
  const biPath = join(run, 'brief.input.json');
  const bi = U.readJSON(biPath, null);
  if (!bi) { console.error(lang === 'en' ? 'No brief.input.json in this RUN.' : 'В этом RUN нет brief.input.json.'); process.exit(2); }
  bi.source ||= {}; bi.site ||= {};
  const flagsPatch = {}, donePatch = {}, applied = [], warnings = [];
  let modePatch = null;
  const item = text => ({ text, date: today(), source: 'user' });
  for (const raw of pairs) {
    const eq = raw.indexOf('=');
    if (eq < 1) { warnings.push(`«${raw}» — нужно ключ=значение`); continue; }
    const k = raw.slice(0, eq).trim().toLowerCase(), v = raw.slice(eq + 1).trim();
    const en = (key, list) => { const x = v.toLowerCase(); if (!list.includes(x)) { warnings.push(`${key}=${v}: одно из ${list.join(', ')}`); return null; } return x; };
    if (k === 'main_action' || k === 'purpose' || k === 'region') { bi.site[k] = v; bi.source[`site.${k}`] = 'user'; donePatch.questions = 'ok'; }
    else if (k === 'site_audience') { bi.site.audience = v; bi.source['site.audience'] = 'user'; donePatch.questions = 'ok'; }
    else if (k in LIST_KEYS) { const key = LIST_KEYS[k]; if (v && !/^(нет|no|-|—)$/i.test(v)) { (bi[key] ||= []).push(item(v)); bi.source[key] = 'user'; } donePatch.questions = 'ok'; }
    else if (k === 'audience') {
      const x = en(k, ENUMS.audience);
      if (x) {
        bi.audience = x; bi.source.audience = 'user'; flagsPatch.audience = x; if (x === 'external') flagsPatch.scores = false; donePatch.questions = 'ok';
        // searches with the domain follow the audience unless the person decided them explicitly (search=…)
        if (bi.source['external_services.search'] !== 'user') { bi.external_services = { ...(bi.external_services || {}), search: x !== 'external' && !readState(run)?.flags?.private_host }; bi.source['external_services.search'] = 'auto'; }
      }
    }
    else if (k === 'search') {
      const x = en(k, ['on', 'off', 'yes', 'no', 'да', 'нет']);
      if (x && ['on', 'yes', 'да'].includes(x) && readState(run)?.flags?.private_host) { warnings.push(lang === 'en' ? 'search=on: the site is local — its address does not go to web searches' : 'search=on: сайт локальный — его адрес в веб-поиск не отправляем'); continue; }
      if (x) { bi.external_services = { ...(bi.external_services || {}), search: ['on', 'yes', 'да'].includes(x) }; bi.source['external_services.search'] = 'user'; }
    }
    else if (k === 'depth' && /^(quick|health|быстр\S*)$/i.test(v)) {
      // «only quick checks» from the full brief: the run becomes /revizor:quick health (measurements + one editor)
      const st0 = readState(run);
      if (st0?.mode !== 'full') { warnings.push(lang === 'en' ? 'depth=quick works only in a full review' : 'depth=quick — только в полном ревью'); continue; }
      modePatch = 'quick'; flagsPatch.topic = 'health'; bi.mode = 'quick'; bi.topic = 'health'; bi.rivals_light = []; bi.ask = []; donePatch.questions = 'ok';
    }
    else if (k === 'depth') {
      const x = en(k, ENUMS.depth);
      if (x) { bi.depth = x; bi.source.depth = 'user'; flagsPatch.depth = x; donePatch.questions = 'ok'; flagsPatch.settings_source = { ...(readState(run)?.flags?.settings_source || {}), ...(flagsPatch.settings_source || {}), depth: 'answer' }; }
    }
    else if (k === 'subscription') {
      // the preset (knowledge/cost.md) changes depth, models and parallel the person did not choose (flag, config.user_set, answer)
      const x = subscriptionOf(v);
      if (!x) { warnings.push(lang === 'en' ? `subscription=${v}: one of pro, max5, max20, api` : `subscription=${v}: одно из pro, max5, max20, api`); continue; }
      const st0 = readState(run) || {};
      const ss = { ...(st0.flags?.settings_source || {}), ...(flagsPatch.settings_source || {}) };
      const userSet = new Set(Array.isArray(U.readRevizorConfig().config?.user_set) ? U.readRevizorConfig().config.user_set : []);
      const preset = costModel().subscriptions[x] || {};
      const t = T[lang] || T.ru;
      flagsPatch.subscription = x;
      flagsPatch.models_note = null;
      const changed = [];
      for (const key of ['depth', 'models', 'parallel']) {
        if (preset[key] === undefined || key in flagsPatch) continue;
        if (ss[key] === 'flag' || ss[key] === 'answer' || (ss[key] === 'config' && userSet.has(key))) continue;
        if (key === 'depth' && st0.mode !== 'full') continue;
        if ((st0.flags || {})[key] === preset[key]) continue;
        flagsPatch[key] = preset[key]; ss[key] = 'subscription';
        if (key === 'depth') bi.depth = preset.depth;
        if (key === 'models') bi.models = preset.models;
        changed.push(key === 'parallel' ? (lang === 'en' ? `${preset.parallel} agents at once` : `агентов одновременно ${preset.parallel}`)
          : key === 'depth' ? (lang === 'en' ? `depth ${t.depth[preset.depth] || preset.depth}` : `глубина ${t.depth[preset.depth] || preset.depth}`) : (t.models[preset.models] || preset.models));
      }
      flagsPatch.settings_source = ss;
      applied.push(lang === 'en' ? `subscription ${t.sub[x] || x}${changed.length ? ` (${changed.join(', ')})` : ' (settings unchanged)'}`
        : `подписка ${t.sub[x] || x}${changed.length ? ` (${changed.join(', ')})` : ' (настройки без изменений)'}`);
      continue;
    }
    else if (k === 'spell') {
      const x = en(k, ['on', 'off', 'auto', 'yes', 'no', 'да', 'нет']);
      if (x && ['on', 'yes', 'да'].includes(x) && readState(run)?.flags?.private_host) { warnings.push(lang === 'en' ? 'spell=on: the site is local — its texts do not go to the external Speller' : 'spell=on: сайт локальный — его тексты во внешний Спеллер не отправляем'); continue; }
      if (x) { const val = ['on', 'yes', 'да'].includes(x) ? 'on' : ['off', 'no', 'нет'].includes(x) ? 'off' : 'auto'; flagsPatch.spell = val;
        bi.external_services ||= {}; if (val === 'auto') delete bi.external_services.spell; else { bi.external_services.spell = val === 'on'; bi.source.external_services = 'user'; } }
    }
    else if (k === 'groups') {
      // groups=a.example:прямой,b.example:ориентир — competitor groups for rival-analyst (GROUP=…)
      const st0 = readState(run);
      const got = parseGroups(v, warnings);
      if (!Object.keys(got).length) continue;
      flagsPatch.rival_groups = { ...(st0?.flags?.rival_groups || {}), ...(flagsPatch.rival_groups || {}), ...got };
    }
    else if (k === 'accept_blocked') { flagsPatch.accept_blocked = bool(v.toLowerCase()); flagsPatch.accept_blocked_at = flagsPatch.accept_blocked ? U.nowIso() : null; }
    else if (k === 'parts') {
      const n = /^(no|нет|0|off)$/i.test(v) ? 0 : Math.round(Number(v) || 3);
      if (n !== 0 && (n < 2 || n > 4)) { warnings.push(`parts=${v}: 2–4 или 0`); continue; }
      flagsPatch.parts = n;
    }
    else if (k === 'engine') {
      const x = en(k, ['yandex', 'google', 'both']);
      if (x) { bi.market = { ...(bi.market || {}), search_engines: x === 'both' ? ['yandex', 'google'] : [x] }; bi.source['market.search_engines'] = 'user'; }
    }
    else if (k === 'device') {
      const x = en(k, ['iphone', 'android', 'both', 'none']);
      if (x) {
        bi.devices = x === 'both' ? ['iphone', 'android'] : x === 'none' ? [] : [x]; bi.source.devices = 'user';
        const text = x === 'none' ? (lang === 'en' ? 'The owner has no phone for device checks: write device checks for any phone' : 'Телефона для проверок у владельца нет: проверки на устройстве — для любого телефона')
          : (lang === 'en' ? `The owner can check on ${bi.devices.join(' and ')}` : `Владелец может проверить на устройстве: ${bi.devices.map(d => (d === 'iphone' ? 'iPhone' : 'Android')).join(' и ')}`);
        (bi.human_checks ||= []).push({ text, lens: 'mobile', why: lang === 'en' ? 'answer of the owner' : 'ответ владельца', source: 'user' });
      }
    }
    else if (k === 'lang') { const x = en(k, ['ru', 'en']); if (x) { bi.lang = x; bi.lang_why = 'ответ в брифе'; bi.source.lang = 'user'; flagsPatch.lang = x; } }
    else if (k === 'stage') { const x = en(k, ['live', 'beta', 'prototype']); if (x) { bi.stage = x; bi.stage_why ||= 'ответ владельца'; bi.source.stage = 'user'; flagsPatch.stage = x; donePatch.stage_question = 'ok';
      if (x === 'beta' && bi.source['external_services.search'] !== 'user') { bi.external_services = { ...(bi.external_services || {}), search: false }; bi.source['external_services.search'] = 'auto'; } } }
    else if (k === 'stage_why') { bi.stage_why = v; }
    else if (k === 'market') { const x = en(k, ['ru', 'intl', 'mixed']); if (x) { bi.market = { ...(bi.market || {}), value: x, why: 'ответ владельца' }; bi.source.market = 'user'; } }
    else if (k === 'vertical') { const x = en(k, VERTICALS.slice(1)); if (x) { bi.vertical = x; bi.source.vertical = 'user'; } }
    else if (k === 'notes') { bi.notes = [bi.notes, v].filter(Boolean).join('\n'); bi.source.notes = 'user'; donePatch.questions = 'ok'; }
    else if (k === 'goal') { (bi.goals_questions ||= []).push({ id: `В${bi.goals_questions.length + 1}`, text: v }); bi.source.goals_questions = 'user'; }
    else if (k === 'fact') { const m = v.match(/^([^=:]+)[=:](.+)$/); const key = m ? m[1].trim() : `fact_${Object.keys(bi.verified_facts || {}).length + 1}`; (bi.verified_facts ||= {})[key] = (m ? m[2] : v).trim(); bi.source.verified_facts = 'user'; }
    else if (k === 'urls') { const st = readState(run); const own = st?.flags?.host_key; const list = [...new Set(U.listArg(v).map(x => normalizeSiteUrl(x, warnings, lang)).filter(Boolean))].filter(u => U.hostKey(u) !== own);
      if (!list.length) { warnings.push(lang === 'en' ? 'urls: every address was dropped (our own site or not http(s)) — give addresses of other sites' : 'urls: все адреса отброшены (свой сайт или не http(s)) — дайте адреса других сайтов'); continue; }
      flagsPatch.urls = [...new Set([...(flagsPatch.urls || []), ...list])]; donePatch.candidates = 'ok'; }
    else if (k === 'topic') { const x = en(k, QUICK_TOPICS); if (x) { bi.topic = x; flagsPatch.topic = x; } }
    else if (k === 'brief_last_ok') {
      if (bool(v.toLowerCase()) && bi.brief_last) {
        const bl = bi.brief_last;
        for (const f of ['purpose', 'main_action', 'audience', 'region']) if (bl.site?.[f] && !bi.site[f]) { bi.site[f] = bl.site[f]; bi.source[`site.${f}`] = 'memory'; }
        for (const f of ['vertical', 'market', 'platform']) if (bl[f] && bi[f] === undefined) { bi[f] = bl[f]; bi.source[f] = 'memory'; }
      }
      donePatch.questions = 'ok';
    }
    else if (['scores', 'strategy', 'pdf'].includes(k)) { flagsPatch[k] = bool(v.toLowerCase()); (bi.flags ||= {})[k] = flagsPatch[k]; }
    else { warnings.push(`неизвестный ключ «${k}»`); continue; }
    applied.push(k);
  }
  const st = readState(run);
  if (flagsPatch.scores && (flagsPatch.audience || st?.flags?.audience) === 'external') { flagsPatch.scores = false; warnings.push('оценки для чужой команды недоступны'); }
  if (flagsPatch.depth && st?.flags?.settings_source && !U.listArg(st.flags.page).length && st.mode === 'full' && (st.flags.pages === PAGES_BY_DEPTH[st.flags.depth])) flagsPatch.pages = PAGES_BY_DEPTH[flagsPatch.depth];
  if (flagsPatch.pages) bi.limits = { ...(bi.limits || {}), pages: flagsPatch.pages };
  U.writeJSON(biPath, bi);
  await updateState(run, s => {
    Object.assign(s.flags ||= {}, flagsPatch);
    for (const [k, v] of Object.entries(donePatch)) (s.done ||= {})[k] = v;
    if (modePatch) { s.mode = modePatch; s.flags.pages = 3; s.flags.parts = 0; }
    if (flagsPatch.depth || flagsPatch.models || flagsPatch.parallel || flagsPatch.topic || modePatch) delete s.plan;
  });
  if (modePatch) { U.log(run, 'init-run: по ответу человека полное ревью заменено быстрой проверкой health'); applied.push(lang === 'en' ? 'mode → quick health' : 'режим → быстрая проверка health'); }
  U.printAndSaveSummary(run, 'init-run', [
    lang === 'en' ? `Saved answers: ${applied.join(', ') || '—'}` : `Записал ответы: ${applied.join(', ') || '—'}`,
    ...warnings.map(w => (lang === 'en' ? 'Warning: ' : 'Предупреждение: ') + w),
  ]);
  if (!applied.length && warnings.length) process.exitCode = 2;
}

// ---------- --brief-min (quick, rivals, recheck: no scout) ----------
async function briefMin(run, lang) {
  if (existsSync(join(run, 'brief.json'))) {
    await updateState(run, s => { (s.done ||= {}).brief = 'ok'; });
    U.printAndSaveSummary(run, 'init-run', [lang === 'en' ? 'brief.json already exists.' : 'brief.json уже есть — не трогаю.']);
    return;
  }
  const st = readState(run) || {};
  const f = st.flags || {};
  const bi = U.readJSON(join(run, 'brief.input.json'), {}) || {};
  const pages = U.readJSON(join(run, 'pages.json'), {}) || {};
  const b = { ...emptyLists(), site: {}, source: {}, goals_questions: [], access: { metrika: false, webmaster: false, gsc: false }, network: { vpn_suspected: false, exit_country: null }, rivals_light: [], ...bi };
  b.source = { ...(bi.source || {}) };
  const auto = k => { b.source[k] ||= 'auto'; };
  const stack = pages.stack || {};
  if (!b.platform) { b.platform = { name: stack.cms || 'custom', version: stack.version || null, confidence: stack.cms ? 'medium' : 'low', signals: stack.signals || [], cdn: stack.cdn || null }; auto('platform'); }
  if (!b.vertical) { b.vertical = pages.vertical_guess && VERTICALS.includes(pages.vertical_guess) ? pages.vertical_guess : 'other'; auto('vertical'); }
  if (!b.market?.value) {
    // an answer about search engines alone (engine=…) is kept on top of the computed market
    const tld = (f.host || '').split('.').pop();
    const ru = ['ru', 'xn--p1ai', 'su', 'xn--80asehdb', 'xn--d1acj3b', 'moscow'].includes(tld) || (pages.market?.value === 'ru');
    const computed = pages.market?.value ? { ...pages.market } : { value: ru ? 'ru' : 'intl', why: 'по домену (без разведчика)', search_engines: ru ? ['yandex', 'google'] : ['google'], countries: ru ? ['RU'] : [] };
    b.market = { ...computed, ...(b.market?.search_engines ? { search_engines: b.market.search_engines } : {}) };
    auto('market');
  }
  // beta signals and nobody asked about the stage → beta (as pipeline.mjs decides): no external services, noindex is not P0
  const beta = (pages.beta_signals || []).length > 0;
  if (!b.stage) {
    if (beta) { b.stage = 'beta'; b.stage_why = f.no_questions ? (lang === 'en' ? 'beta signs, questions off' : 'признаки беты, вопросы отключены') : (lang === 'en' ? 'beta signs, stage not asked' : 'признаки беты, стадию не уточняли'); }
    else { b.stage = 'live'; b.stage_why = lang === 'en' ? 'default' : 'по умолчанию'; }
    auto('stage');
  }
  if (!b.site.languages) { b.site.languages = (pages.languages || []).map(l => l.lang).filter(Boolean); if (!b.site.languages.length) b.site.languages = [b.lang || 'ru']; }
  {
    const pub = !f.private_host, live = b.stage === 'live';
    const spell = f.spell === 'on' ? true : f.spell === 'off' ? false : (live && pub && f.audience !== 'external');
    const def = { spell, psi: live && pub, crtsh: live && pub, regions: false, search: pub && f.audience !== 'external' && b.stage !== 'beta' };
    if (!b.external_services) { b.external_services = def; auto('external_services'); }
    else b.external_services = { ...def, ...b.external_services }; // explicit choices of the person (--spell, local site) win
    // a beta domain does not go to web searches unless the person said search=on
    if (b.stage === 'beta' && b.source['external_services.search'] !== 'user') b.external_services.search = false;
  }
  const doc = U.readJSON(join(run, 'doctor.json'), null);
  if (doc?.network && !bi.network) { b.network = { vpn_suspected: !!doc.network.vpn_suspected, exit_country: null }; auto('network'); }
  b.notes ||= lang === 'en' ? 'Brief built automatically (no scout): type, market and stage come from measurements.' : 'Бриф собран автоматически, без разведчика: тип, рынок и стадия — по замерам.';
  delete b.ask;
  U.writeJSON(join(run, 'brief.json'), b);
  await updateState(run, s => { (s.done ||= {}).brief = 'ok'; delete s.plan; });
  U.printAndSaveSummary(run, 'init-run', [lang === 'en' ? `brief.json written (vertical ${b.vertical}, market ${b.market.value}, stage ${b.stage}).` : `brief.json записан (тип ${b.vertical}, рынок ${b.market.value}, стадия ${b.stage}).`]);
}

// ---------- --resume / --list ----------
async function resume(args, lang) {
  const cfg = U.readRevizorConfig().config;
  const { out } = outRoot(args, cfg);
  const v = args.resume === true ? (args.url && args.url !== true ? args.url : args._[0]) : String(args.resume);
  let run = null;
  const mode = args.mode && args.mode !== true ? String(args.mode) : null;
  if (v && isDir(resolve(v)) && existsSync(statePath(resolve(v)))) run = resolve(v);
  else {
    const hk = v ? U.hostKey(v) : null;
    const c = unfinished(out, hk, mode);
    run = c[0]?.run || null;
    if (!run) {
      // older than 48 h: never resumed silently — the person decides (the site may have changed since)
      const old = unfinished(out, hk, mode, Infinity)[0];
      if (old) {
        const self = fwd(fileURLToPath(import.meta.url));
        U.printAndSaveSummary(null, 'init-run', [`RESUME OLD=${fwd(old.run)}`,
          lang === 'en' ? `The only unfinished ${old.mode} run${v ? ` of «${v}»` : ''} is older than ${RESUME_HOURS} h (${fmtDate(old.started)}, stopped at: ${whereStopped(old.run, lang)}); the site may have changed since.`
            : `Незавершённый прогон ${old.mode}${v ? ` для «${v}»` : ''} старше ${RESUME_HOURS} ч (${fmtDate(old.started)}, остановился на: ${whereStopped(old.run, lang)}); сайт мог с тех пор измениться.`,
          lang === 'en' ? `Ask: «Continue it» → node "${self}" --resume "${fwd(old.run)}" / «Start over» → a new run.`
            : `Спросите: «Продолжить его» → node "${self}" --resume "${fwd(old.run)}" / «Начать заново» → новый прогон.`]);
        return;
      }
    }
  }
  if (!run) {
    U.printAndSaveSummary(null, 'init-run', ['RESUME NONE', lang === 'en' ? `No unfinished run younger than ${RESUME_HOURS} h${v ? ` for «${v}»` : ''} in ${fwd(out)}.` : `Незавершённых прогонов моложе ${RESUME_HOURS} ч${v ? ` для «${v}»` : ''} в ${fwd(out)} нет. Список: node init-run.mjs --list`]);
    return;
  }
  const s = readState(run);
  if (runIsDone(s, run)) {
    U.printAndSaveSummary(null, 'init-run', [`RUN=${fwd(run)}`, 'RESUME DONE', lang === 'en' ? 'This run is already finished.' : 'Этот прогон уже завершён.']);
    return;
  }
  await resetRunning(run);
  U.log(run, 'init-run: продолжение прогона (--resume)');
  U.printAndSaveSummary(run, 'init-run', [`RUN=${fwd(run)}`,
    lang === 'en' ? `Resuming ${s.mode} run of ${s.flags?.url} (${fmtDate(s.started)}), stopped at: ${whereStopped(run, lang)}.` : `Продолжаем прогон ${s.mode} для ${s.flags?.url} (${fmtDate(s.started)}), остановился на: ${whereStopped(run, lang)}.`,
    `${lang === 'en' ? 'Next' : 'Дальше'}: node "${fwd(join(dirname(fileURLToPath(import.meta.url)), 'state.mjs'))}" --run "${fwd(run)}" --next`]);
}

function list(args, lang) {
  const cfg = U.readRevizorConfig().config;
  const { out } = outRoot(args, cfg);
  const host = args.list === true ? null : U.hostKey(args.list);
  let runs = listRuns(out, host);
  if (args.mode && args.mode !== true) runs = runs.filter(r => r.mode === String(args.mode));
  if (args.done) runs = runs.filter(r => r.done);
  const limit = Math.max(1, Number(args.limit) || 10);
  runs = runs.slice(0, limit);
  if (args.json) { process.stdout.write(JSON.stringify(runs.map(r => ({ ...r, run: fwd(r.run), report: r.report && fwd(r.report), registry: r.registry && fwd(r.registry) })), null, 2) + '\n'); return; }
  const st = { done: lang === 'en' ? 'done' : 'готов', blocked: lang === 'en' ? 'blocked' : 'сайт не пустил', pipeline_failed: lang === 'en' ? 'measurements fail' : 'замеры не идут' };
  const lines = [lang === 'en' ? `Runs in ${fwd(out)}${host ? ` for ${host}` : ''}:` : `Прогоны в ${fwd(out)}${host ? ` для ${host}` : ''}:`];
  if (!runs.length) lines.push(lang === 'en' ? '  none' : '  нет');
  runs.forEach((r, i) => lines.push(`${i + 1}. ${fmtDate(r.started)} · ${r.host} · ${r.mode} · ${st[r.stage] || (lang === 'en' ? `stopped: ${r.stage}` : `остановлен: ${r.stage}`)} · ${fwd(r.report || r.run)}`));
  U.printAndSaveSummary(null, 'init-run', lines);
}

// ---------- main ----------
async function main() {
  const args = U.parseArgs(process.argv.slice(2), {
    boolean: ['help', 'json', 'new', 'scores', 'strategy', 'pdf', 'no-questions', 'no-rivals', 'probe', 'allow-load-posts', 'keep-raw', 'brief-min', 'done', 'spell', 'no-spell'],
    multi: ['page', 'answer'],
  });
  U.helpAndExit(HELP, args);
  const lang = U.langOf(args);
  await loadValidator(); // «where it stopped» checks findings files by the schema
  // --spell / --no-spell (boolean: a following address is never eaten as the value): spell=true/false
  if (args['no-spell'] === true || args.spell === false) args.spell = 'off'; else if (args.spell === true) args.spell = 'on';
  if (args['no-scores'] === true) args.scores = false;
  if (args.scores === undefined) delete args.scores;
  if (args.list !== undefined) return list(args, lang);
  if (args.resume !== undefined) return resume(args, lang);
  if (args.run && args.run !== true && (args.answer || args['answer-file'] || args['brief-min'])) {
    const run = resolve(String(args.run));
    if (!existsSync(statePath(run))) { console.error(lang === 'en' ? `No state.json in ${run}.` : `Нет state.json в ${run}.`); process.exit(2); }
    if (args.answer || args['answer-file']) {
      const pairs = [...(Array.isArray(args.answer) ? args.answer : args.answer ? [args.answer] : []), ...args._.filter(x => typeof x === 'string' && x.includes('='))].filter(x => typeof x === 'string');
      if (args['answer-file'] && args['answer-file'] !== true) {
        const r = answerFilePairs(resolve(String(args['answer-file'])), lang);
        if (r.error) { console.error(r.error); process.exit(2); }
        pairs.push(...r.pairs);
      }
      await answer(run, pairs, lang);
    }
    if (args['brief-min']) await briefMin(run, lang);
    return;
  }
  return create(args, lang);
}

const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
