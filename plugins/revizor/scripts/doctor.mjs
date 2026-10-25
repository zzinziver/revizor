#!/usr/bin/env node
// Revizor — environment check before a run: Node, browser, run folder, disk, network by two paths
// (Node fetch vs browser → proxy/VPN hint), axe-core in the cache (version + sha256, prefetch), machine speed,
// system language, permission rules, plugin update. REVIZOR_OFFLINE=1 — no network beyond the reviewed site.
// The first lines use only old syntax and dynamic imports, so an old Node still gets a readable answer.

const argv = process.argv.slice(2);
const EN = argv.some((a, i) => a === '--lang=en' || (a === '--lang' && argv[i + 1] === 'en'));
const nodeMajor = Number(process.versions.node.split('.')[0]);
const OFFLINE = process.env.REVIZOR_OFFLINE === '1';

function installLines(os, needNode, needBrowser, en) {
  const L = [];
  let distro = '';
  if (os === 'linux') {
    try { const t = require_fs().readFileSync('/etc/os-release', 'utf8'); distro = ((t.match(/^ID=(.*)$/m) || [])[1] || '') + ' ' + ((t.match(/^ID_LIKE=(.*)$/m) || [])[1] || ''); } catch (e) { /* unknown */ }
    distro = distro.replace(/"/g, '').toLowerCase();
  }
  if (needNode) {
    if (os === 'win32') L.push(en ? 'Install Node.js: in PowerShell or Terminal run  winget install OpenJS.NodeJS.LTS  (no winget: the LTS .msi from https://nodejs.org/en/download)'
      : 'Установите Node.js: в PowerShell или «Терминале» выполните  winget install OpenJS.NodeJS.LTS  (если winget нет — установщик LTS .msi с https://nodejs.org/en/download)');
    else if (os === 'darwin') L.push(en ? 'Install Node.js: download the LTS .pkg installer from https://nodejs.org/en/download and run it.'
      : 'Установите Node.js: скачайте установщик LTS .pkg с https://nodejs.org/en/download и запустите его.');
    else if (/ubuntu|debian/.test(distro)) L.push(en ? 'Install Node.js 22+: the LTS archive for Linux from https://nodejs.org/en/download (instructions on that page) or the version manager nvm (https://github.com/nvm-sh/nvm), then  nvm install 22. The distro apt package is often older than 22. apt packages of NodeSource: https://github.com/nodesource/distributions (read the setup script before running it).'
      : 'Установите Node.js 22+: архив LTS для Linux с https://nodejs.org/en/download (инструкция там же) или менеджер версий nvm (https://github.com/nvm-sh/nvm), затем  nvm install 22. Пакет apt из дистрибутива обычно старше 22. Пакеты apt от NodeSource: https://github.com/nodesource/distributions (скрипт установки сначала прочитайте).');
    else if (/fedora|rhel|centos/.test(distro)) L.push(en ? 'Install Node.js: sudo dnf install nodejs22 (check node --version is 22+)' : 'Установите Node.js: sudo dnf install nodejs22 (проверьте, что node --version не ниже 22)');
    else if (/arch/.test(distro)) L.push(en ? 'Install Node.js: sudo pacman -S nodejs' : 'Установите Node.js: sudo pacman -S nodejs');
    else if (/alpine/.test(distro)) L.push(en ? 'Install Node.js: apk add nodejs' : 'Установите Node.js: apk add nodejs');
    else L.push(en ? 'Install Node.js 22 or newer with your package manager or nvm: https://nodejs.org/en/download/package-manager'
      : 'Установите Node.js 22 или новее пакетным менеджером или через nvm: https://nodejs.org/en/download/package-manager');
  }
  if (needBrowser) {
    if (os === 'win32') L.push(en ? 'Browser: Microsoft Edge is usually there; otherwise  winget install Google.Chrome' : 'Браузер: обычно уже есть Microsoft Edge; если нет —  winget install Google.Chrome');
    else if (os === 'darwin') L.push(en ? 'Browser: install Google Chrome from https://www.google.com/chrome/ (Safari will not do).' : 'Браузер: установите Google Chrome с https://www.google.com/chrome/ (Safari не подходит).');
    else if (/ubuntu/.test(distro)) L.push(en ? 'Browser: sudo snap install chromium' : 'Браузер: sudo snap install chromium');
    else if (/debian/.test(distro)) L.push(en ? 'Browser: sudo apt-get install -y chromium' : 'Браузер: sudo apt-get install -y chromium');
    else if (/fedora|rhel|centos/.test(distro)) L.push(en ? 'Browser: sudo dnf install chromium' : 'Браузер: sudo dnf install chromium');
    else if (/arch/.test(distro)) L.push(en ? 'Browser: sudo pacman -S chromium' : 'Браузер: sudo pacman -S chromium');
    else L.push(en ? 'Browser: install Google Chrome or Chromium, or set REVIZOR_BROWSER to its path.' : 'Браузер: установите Google Chrome или Chromium либо укажите путь в переменной REVIZOR_BROWSER.');
  }
  if (needNode) L.push(en ? 'After installing, fully quit and reopen Claude — otherwise it will not see Node.' : 'После установки полностью закройте и снова откройте Claude — иначе он не увидит Node.');
  else L.push(en ? 'After installing, run the check again: /revizor:setup' : 'После установки повторите проверку: /revizor:setup');
  return L;
}
let fsMod = null;
function require_fs() { return fsMod; }

if (!(nodeMajor >= 22) || typeof WebSocket === 'undefined') {
  fsMod = await import('node:fs');
  const lines = [
    EN ? `Node ${process.versions.node}: Revizor needs Node.js 22 or newer.` : `Node ${process.versions.node}: Ревизору нужен Node.js 22 или новее.`,
    ...installLines(process.platform, true, false, EN),
  ];
  if (argv.includes('--json')) process.stdout.write(JSON.stringify({ tool: 'doctor', ok: false, checks: [{ id: 'node', status: 'fail', text: lines[0] }], install: lines.slice(1) }, null, 2) + '\n');
  else process.stdout.write(lines.join('\n') + '\n');
  process.exit(2);
}

fsMod = await import('node:fs');
const { existsSync, readdirSync, statSync, writeFileSync, rmSync, readFileSync, statfsSync } = fsMod;
const { join, resolve, relative, isAbsolute } = await import('node:path');
const os = await import('node:os');
const { execFileSync } = await import('node:child_process');
const U = await import('./lib/util.mjs');
const { pluginVersion, setDone, ROOT, costModel, SUBSCRIPTIONS, isPrivateLiteral } = await import('./state.mjs');

const HELP = `
doctor.mjs — проверка окружения Ревизора.
  node doctor.mjs [--run "<RUN>"] [--url <адрес сайта>] [--out <папка прогонов>] [--json] [--lang ru|en] [--no-update-check] [--no-browser]
Проверяет: Node ≥ 22; браузер на базе Chromium стартует (слоты заняты другим прогоном — предупреждение, не провал);
запись в папку прогонов; свободное место (< 2 ГБ — предупреждение); сеть двумя путями (Node и браузер; расхождение =
VPN/прокси только для браузера); axe-core в кэше (версия и sha256; нет — скачивает в кэш, данные сайта не уходят);
скорость машины; язык системы; правила разрешений allow/ask/deny в ~/.claude/settings*.json и .claude/settings*.json
(только чтение); новую версию плагина (GitHub, кэш на сутки в ~/.revizor/, без сети — молча).
REVIZOR_OFFLINE=1 — без сети за пределами сайта: axe не скачивает, обновления и example.com не проверяет.
С --run: копия сводки в RUN/stdout/doctor.md, RUN/doctor.json, state doctor=ok|failed (папки без state.json — код 2).
--json: ещё paths { home, revizor_config, claude_user_settings, plugin_root }.

  node doctor.mjs --add-rules --dry-run|--yes [--out <папка>] [--json]
      узкие правила разрешений в ~/.claude/settings.json: по одному на скрипт этой версии —
      Bash(node "<плагин>/scripts/<имя>.mjs" *) (на Windows ещё PowerShell), Edit/Write/Read(<папка отчётов>/**),
      Read(<плагин>/**); никогда node:* и * в пути. --dry-run — только показать; --yes — дописать недостающие
      (после согласия человека). После обновления плагина — повторить (путь версии меняется).
  node doctor.mjs --write-config [--subscription pro|max5|max20|api] [--profile …] [--audience …] [--lang …]
                  [--depth …] [--models …] [--parallel N] [--scores|--no-scores] [--spell auto|on|off] [--out <папка>] [--json]
      ~/.revizor/config.json: depth, models, parallel пишутся, только если заданы (человек выбрал сам → user_set);
      иначе действует пресет подписки (Pro → lite, economy, 3).
Коды: 0 — можно запускать (предупреждения допустимы), 2 — нет Node 22, браузера, записи в папку, неверный --run или аргумент, 1 — сбой.
`;

const REPO_API = 'https://api.github.com/repos/zzinziver/revizor/releases/latest';
const DEFAULT_NET_URL = 'https://example.com/';
const SLOW_MS = 300;          // min of 6 runs of benchMs(); slow laptops take ~350–550
const LOW_DISK = 2 * 1024 ** 3;
const SLOT_WAIT_MS = 90000;

function benchMs() {
  // mixed JS work: allocation, sort, arithmetic, JSON — the kind of work a page and our scripts do
  const t0 = performance.now();
  let acc = 0;
  const arr = [];
  for (let i = 0; i < 200000; i++) arr.push({ i, s: 'x' + (i % 97), v: Math.sqrt(i) });
  arr.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.v - b.v));
  for (let i = 0; i < 3e6; i++) acc = (acc + i * 7) % 1000003;
  acc += JSON.parse(JSON.stringify(arr.slice(0, 50000))).length;
  return { ms: performance.now() - t0, acc };
}
const BENCH_SRC = `(${benchMs.toString()})`;

function osName() {
  const p = process.platform;
  if (p === 'win32') return `Windows ${os.release()}`;
  if (p === 'darwin') return `macOS ${os.release()}`;
  return `Linux ${os.release()}`;
}
function sh(cmd, args, timeout = 4000) {
  try { return execFileSync(cmd, args, { timeout, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString('utf8'); } catch { return ''; }
}

// System proxy that the browser uses but Node fetch ignores
function proxyInfo() {
  const env = {};
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) if (process.env[k]) env[k.toUpperCase()] = true;
  const info = { env: Object.keys(env), node_uses_env: process.env.NODE_USE_ENV_PROXY === '1', system: null };
  if (process.platform === 'win32') {
    const out = sh('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings']);
    const en = /ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(out);
    const auto = /AutoConfigURL\s+REG_SZ\s+\S+/i.test(out);
    if (en || auto) info.system = auto ? 'pac' : 'manual';
  } else if (process.platform === 'darwin') {
    const out = sh('scutil', ['--proxy']);
    if (/HTTPSEnable\s*:\s*1|HTTPEnable\s*:\s*1|ProxyAutoConfigEnable\s*:\s*1|SOCKSEnable\s*:\s*1/.test(out)) info.system = 'manual';
  }
  return info;
}

// ---------- permission rules (read only) ----------
// Counts only rules that really cover Revizor's node scripts: all Bash/PowerShell, node:* / node *, or the path rule that
// /revizor:setup writes (node "<plugin>/scripts/*.mjs" *). A rule for one exact command does not count. deny > ask > allow.
const fwdl = p => String(p).replace(/\\/g, '/').toLowerCase();
const fwd = p => String(p).replace(/\\/g, '/');
const SCRIPTS_DIR = join(ROOT, 'scripts');
/** Top-level scripts of this installed version that a session runs (lib/ and collectors/ are imported; build-claude-ai is for developers). */
const NOT_FOR_SESSIONS = new Set(['build-claude-ai.mjs']);
function scriptNames() { try { return readdirSync(SCRIPTS_DIR).filter(n => n.endsWith('.mjs') && !NOT_FOR_SESSIONS.has(n)).sort(); } catch { return []; } }
// → 'all' | 'node' | 'revizor' (wildcard over a scripts folder) | { exact: '<name>.mjs' } (this version) | { stale: '<dir>' } | null
function coversNode(rule) {
  const s = String(rule).trim();
  if (/^(Bash|PowerShell)(\(\s*\*?\s*\))?$/.test(s)) return 'all';
  const m = s.match(/^(Bash|PowerShell)\((.*)\)$/s);
  if (!m) return null;
  const inner = m[2].trim();
  if (/^node(\.exe)?(:\*|\s+\*|\*)$/i.test(inner)) return 'node';
  // a wildcard over a scripts folder counts only for this plugin (its own scripts folder or a …revizor…/scripts path)
  const w = inner.match(/^node(?:\.exe)?\s+"?([^"]*[\\/]scripts)[\\/]\*\.mjs"?\s*(?:\*|:\*)?$/i);
  if (w) return fwdl(w[1]) === fwdl(SCRIPTS_DIR) || /revizor/i.test(w[1]) ? 'revizor' : null;
  const e = inner.match(/^node(?:\.exe)?\s+"([^"*]+)[\\/]([a-z0-9-]+\.mjs)"\s*(?:\*|:\*)$/i);
  if (e) {
    if (fwdl(e[1]) === fwdl(SCRIPTS_DIR)) return { exact: e[2].toLowerCase() };
    if (/revizor/i.test(e[1]) && /[\\/]scripts$/i.test(e[1])) return { stale: fwd(e[1]) };
  }
  return null;
}
// Paths in permission rules: inside home → ~/…, Windows drive → //c/…, other absolute → //… (Claude Code rule syntax)
function rulePath(p) {
  const abs = resolve(p);
  const rel = relative(os.homedir(), abs);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return '~/' + fwd(rel);
  const d = fwd(abs).match(/^([A-Za-z]):\/(.*)$/);
  if (d) return `//${d[1].toLowerCase()}/${d[2]}`;
  return '/' + fwd(abs);
}
/** Narrow rules for this installed version: one per script, exact path, never node:* (decision 24.10). */
function revizorRules(out) {
  const rules = [];
  for (const n of scriptNames()) {
    rules.push(`Bash(node "${fwd(join(SCRIPTS_DIR, n))}" *)`);
    if (process.platform === 'win32') rules.push(`PowerShell(node "${fwd(join(SCRIPTS_DIR, n))}" *)`);
  }
  const o = rulePath(out);
  rules.push(`Edit(${o}/**)`, `Write(${o}/**)`, `Read(${o}/**)`, `Read(${rulePath(ROOT)}/**)`);
  return rules;
}
const claudeUserSettings = () => join(os.homedir(), '.claude', 'settings.json');
function outForms(out) {
  const home = os.homedir();
  const forms = new Set([fwdl(out)]);
  const rel = relative(home, out);
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) forms.add('~/' + fwdl(rel));
  const d = fwdl(out).match(/^([a-z]):\/(.*)$/);
  if (d) forms.add(`//${d[1]}/${d[2]}`);
  return [...forms];
}
function coversWrite(rule, out) {
  const s = String(rule).trim();
  const m = s.match(/^(Edit|Write)(?:\((.*)\))?$/s);
  if (!m) return false;
  const inner = (m[2] || '').trim();
  if (!inner || ['*', '**', '/**', '//**', '~/**'].includes(inner)) return true;
  const base = fwdl(inner).replace(/\/\*\*?$/, '').replace(/\/+$/, '');
  return !!base && outForms(out).some(f => f === base || f.startsWith(base + '/'));
}
function permissionInfo(out) {
  const files = [join(os.homedir(), '.claude', 'settings.json'), join(os.homedir(), '.claude', 'settings.local.json'),
    join(process.cwd(), '.claude', 'settings.json'), join(process.cwd(), '.claude', 'settings.local.json')];
  const res = { files_read: 0, node_rule: [], node_ask: [], node_deny: [], edit_rule: [], wide_rules: [], ask_scripts: [], deny_scripts: [], exact_scripts: 0, scripts_total: scriptNames().length, stale_dirs: [], mode: null };
  const home = os.homedir();
  const short = f => f.startsWith(home) ? '~' + f.slice(home.length).replace(/\\/g, '/') : '<проект>' + f.slice(process.cwd().length).replace(/\\/g, '/');
  const push = (arr, f) => { if (!arr.includes(short(f))) arr.push(short(f)); };
  const exact = new Set();
  for (const f of [...new Set(files)]) {
    if (!existsSync(f)) continue;
    let perm;
    try { perm = (JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')) || {}).permissions || {}; } catch { continue; }
    res.files_read++;
    // bypassPermissions asks nothing; dontAsk refuses everything not allowed (rules are still needed)
    if (perm.defaultMode && ['bypassPermissions', 'dontAsk'].includes(perm.defaultMode)) res.mode = perm.defaultMode;
    for (const r of perm.allow || []) {
      const c = coversNode(r);
      if (c && typeof c === 'string') { push(res.node_rule, f); if (!res.wide_rules.includes(String(r).trim())) res.wide_rules.push(String(r).trim()); }
      else if (c?.exact) exact.add(c.exact);
      else if (c?.stale && !res.stale_dirs.includes(c.stale)) res.stale_dirs.push(c.stale);
      if (coversWrite(r, out)) push(res.edit_rule, f);
    }
    // ask/deny: a general rule (node:*, Bash) or a rule on one script of this version
    for (const [list, arr, names] of [[perm.ask, res.node_ask, res.ask_scripts], [perm.deny, res.node_deny, res.deny_scripts]]) {
      for (const r of list || []) {
        const c = coversNode(r);
        if (typeof c === 'string') push(arr, f);
        else if (c?.exact && !names.includes(c.exact)) names.push(c.exact);
      }
    }
  }
  res.exact_scripts = exact.size;
  return res;
}

function semverGt(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
}
async function updateInfo(current, run) {
  if (argv.includes('--no-update-check') || process.env.REVIZOR_NO_UPDATE_CHECK === '1') return { current, skipped: true };
  if (OFFLINE) return { current, skipped: true, offline: true };
  const cacheFile = join(U.revizorHome(), 'update-check.json');
  let cache = existsSync(cacheFile) ? U.readJSON(cacheFile, null) : null;
  if (!cache || Date.now() - new Date(cache.checked).getTime() > 24 * 3600e3) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 5000);
      let res;
      try { res = await fetch(REPO_API, { signal: ctl.signal, headers: { 'user-agent': 'revizor-doctor', accept: 'application/vnd.github+json' } }); } finally { clearTimeout(t); }
      if (run) U.logExternal(run, 'api.github.com', 'запрос номера последней версии плагина (данные сайта не передаются)', 1);
      if (res.status === 200) {
        const j = await res.json();
        const notes = String(j.body || '').split(/\r?\n/).map(x => x.replace(/^[#*\s-]+/, '').trim()).find(Boolean) || '';
        cache = { checked: U.nowIso(), latest: String(j.tag_name || '').replace(/^v/, '') || null, notes: notes.slice(0, 140), url: j.html_url || null };
      } else if (res.status === 404) cache = { checked: U.nowIso(), latest: null, notes: '', url: null };
      else return { current, skipped: true };
      try { U.ensureDir(U.revizorHome()); U.writeJSON(cacheFile, cache); } catch { /* cache is optional */ }
    } catch { return { current, skipped: true }; } // offline: silently
  }
  return { current, latest: cache.latest, newer: !!(cache.latest && semverGt(cache.latest, current)), notes: cache.notes, url: cache.url };
}

// axe-core: the cache is trusted only with the pinned version and sha256 (collectors/axe.mjs); no cache → prefetch
// through the collector itself (it logs the download to RUN/log.md and respects REVIZOR_OFFLINE / external_services.axe).
async function axeInfo(run, brief, lang) {
  let m;
  try { m = await import('./collectors/axe.mjs'); } catch (e) { return { ok: false, missing_collector: true, error: String(e.message || e).slice(0, 160) }; }
  let path = m.axeCachePath(), cacheState = 'none';
  if (typeof m.axeCacheStatus === 'function') { // single source of truth: pinned version + sha256
    const st = m.axeCacheStatus(); path = st.path || path;
    cacheState = st.ok ? 'ok' : st.exists ? 'bad' : 'none';
  } else if (existsSync(path)) { try { cacheState = U.sha256(readFileSync(path)) === m.AXE_SHA256 ? 'ok' : 'bad'; } catch { cacheState = 'bad'; } }
  const base = { version: m.AXE_VERSION, path, cache: cacheState };
  if (cacheState === 'ok' && !process.env.REVIZOR_AXE_FILE) return { ok: true, from: 'cache', ...base };
  if (!process.env.REVIZOR_AXE_FILE && (OFFLINE || brief?.external_services?.axe === false)) return { ok: false, offline: true, ...base };
  const r = await m.loadAxe({ run, brief: brief || {}, lang });
  if (r.error) return { ok: false, error: String(r.error).slice(0, 200), ...base };
  return { ok: true, from: r.from, ...base, version: r.version || m.AXE_VERSION };
}

const pathsInfo = () => ({ home: fwd(os.homedir()), revizor_config: fwd(join(U.revizorHome(), 'config.json')), claude_user_settings: fwd(claudeUserSettings()), plugin_root: fwd(ROOT) });
function outOf(args) {
  const cfg = U.readRevizorConfig().config;
  return args.out && args.out !== true ? resolve(String(args.out)) : (cfg.out ? resolve(String(cfg.out)) : U.defaultOutDir());
}

// --add-rules --dry-run | --yes: narrow allow rules into ~/.claude/settings.json (only with the person's consent: --yes)
function addRules(args, en) {
  const out = outOf(args);
  const rules = revizorRules(out);
  const file = claudeUserSettings();
  let doc = {}, broken = null;
  if (existsSync(file)) { try { doc = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) || {}; if (typeof doc !== 'object' || Array.isArray(doc)) broken = 'not an object'; } catch (e) { broken = e.message; } }
  const allow = Array.isArray(doc?.permissions?.allow) ? doc.permissions.allow : [];
  const have = new Set(allow);
  const missing = rules.filter(r => !have.has(r));
  const stale = allow.filter(r => coversNode(r)?.stale).length;
  let written = false, code = 0, err = null;
  if (args.yes && missing.length) {
    if (broken) { err = broken; code = 2; }
    else {
      doc.permissions = doc.permissions && typeof doc.permissions === 'object' ? doc.permissions : {};
      doc.permissions.allow = [...allow, ...missing];
      U.ensureDir(join(os.homedir(), '.claude'));
      const tmp = `${file}.tmp-${process.pid}`;
      writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      fsMod.renameSync(tmp, file);
      written = true;
    }
  }
  const res = { tool: 'doctor', action: 'add-rules', file: fwd(file), out: fwd(out), rules, missing, written, dry_run: !args.yes, stale_rules: stale, error: err, paths: pathsInfo() };
  if (args.json) { process.stdout.write(JSON.stringify(res, null, 2) + '\n'); process.exitCode = code; return; }
  const names = scriptNames();
  const lines = [
    en ? `Permission rules for Revizor ${fwd(SCRIPTS_DIR)} (no node:*, no wildcard in the path):` : `Правила разрешений для Ревизора ${fwd(SCRIPTS_DIR)} (без node:*, без * в пути):`,
    `  Bash${process.platform === 'win32' ? ' + PowerShell' : ''}(node "${fwd(SCRIPTS_DIR)}/<имя>.mjs" *) — ${names.length}: ${names.map(n => n.replace(/\.mjs$/, '')).join(', ')}`,
    ...rules.filter(r => !/^(Bash|PowerShell)\(/.test(r)).map(r => '  ' + r),
    en ? `Missing in ${fwd(file)}: ${missing.length} of ${rules.length}. Full list: --json` : `Нет в ${fwd(file)}: ${missing.length} из ${rules.length}. Полный список: --json`,
    stale ? (en ? `Rules of other plugin versions: ${stale} — remove them in /permissions if you like.` : `Правил прошлых версий плагина: ${stale} — их можно удалить в /permissions.`) : null,
    err ? (en ? `${fwd(file)} is not valid JSON (${err}) — not touched. Add the rules by hand: /permissions → Allow.` : `${fwd(file)} не читается как JSON (${err}) — файл не трогаю. Добавьте правила вручную: /permissions → Allow.`)
      : written ? (en ? `Written: ${missing.length} rules.` : `Записано правил: ${missing.length}.`)
        : args.yes ? (en ? 'All rules are already there.' : 'Все правила уже есть.') : (en ? 'Dry run: nothing written. Write after the person agrees: --add-rules --yes' : 'Пробный вывод: ничего не записано. Записать после согласия человека: --add-rules --yes'),
  ];
  U.printAndSaveSummary(null, 'doctor', lines);
  process.exitCode = code;
}

// --write-config: ~/.revizor/config.json deterministically. depth/models/parallel are written only when given (the person chose
// them: they go to user_set); otherwise the subscription preset decides at run time.
function writeConfig(args, en) {
  const R = U.readRevizorConfig();
  const cfg = R.error ? {} : { ...R.config };
  const errs = [];
  const ENUM = { profile: ['standard', 'strict'], audience: ['owner', 'team', 'external'], lang: ['auto', 'ru', 'en'], depth: ['lite', 'standard', 'deep'],
    models: ['economy', 'balanced', 'max'], spell: ['auto', 'on', 'off'] };
  const given = k => args[k] !== undefined && args[k] !== true && args[k] !== '';
  const userSet = new Set(Array.isArray(cfg.user_set) ? cfg.user_set : []);
  if (given('subscription')) {
    const v = String(args.subscription).trim().toLowerCase().replace(/\s+/g, '').replace(/[x×х]$/, '');
    const sub = { pro: 'pro', max5: 'max5', max20: 'max20', api: 'api', team: 'api', enterprise: 'api' }[v] || null;
    if (!sub) errs.push(`subscription=${args.subscription}: pro|max5|max20|api`);
    else { cfg.subscription = sub; for (const k of ['depth', 'models', 'parallel']) if (!given(k)) { delete cfg[k]; userSet.delete(k); } }
  }
  for (const [k, list] of Object.entries(ENUM)) {
    if (!given(k)) continue;
    const v = String(args[k]).toLowerCase();
    if (!list.includes(v)) { errs.push(`${k}=${args[k]}: ${list.join('|')}`); continue; }
    cfg[k] = v; if (['depth', 'models'].includes(k)) userSet.add(k);
  }
  if (given('parallel')) { const n = Math.round(Number(args.parallel)); if (n >= 1 && n <= 20) { cfg.parallel = n; userSet.add('parallel'); } else errs.push(`parallel=${args.parallel}: 1–20`); }
  if (typeof args.scores === 'boolean') cfg.scores = args.scores;
  if (given('out')) cfg.out = fwd(resolve(String(args.out)));
  else if (!cfg.out) cfg.out = fwd(U.defaultOutDir());
  if (errs.length) { console.error((en ? 'Not written: ' : 'Не записал: ') + errs.join('; ')); process.exitCode = 2; return; }
  cfg.user_set = [...userSet];
  cfg.updated = U.nowIso();
  U.ensureDir(U.revizorHome());
  U.writeJSON(R.path, cfg);
  const preset = cfg.subscription ? costModel().subscriptions[cfg.subscription] : null;
  const eff = k => (userSet.has(k) || !preset ? cfg[k] : preset[k]) ?? '—';
  const res = { tool: 'doctor', action: 'write-config', file: fwd(R.path), config: cfg, effective: { depth: eff('depth'), models: eff('models'), parallel: eff('parallel') }, was_broken: !!R.error, paths: pathsInfo() };
  if (args.json) { process.stdout.write(JSON.stringify(res, null, 2) + '\n'); return; }
  // plain words for the person instead of the config codes (owner, lite, economy…)
  const W = en ? {
    sub: { pro: 'Pro', max5: 'Max 5×', max20: 'Max 20×', api: 'API / Team' }, depth: { lite: 'light', standard: 'standard', deep: 'deep' },
    models: { economy: 'all agents on Sonnet', balanced: 'topics on Sonnet, critic and editor on the session model', max: 'all agents on the session model' },
    profile: { standard: 'usual strictness', strict: 'strict taste' }, audience: { owner: 'for yourself', team: 'for your team', external: 'for another team or a client' },
    lang: { auto: 'as the system', ru: 'Russian', en: 'English' },
  } : {
    sub: { pro: 'Pro', max5: 'Max 5×', max20: 'Max 20×', api: 'API / Team' }, depth: { lite: 'облегчённый', standard: 'стандартный', deep: 'глубокий' },
    models: { economy: 'все агенты на Sonnet', balanced: 'темы на Sonnet, критик и редактор на модели сессии', max: 'все агенты на модели сессии' },
    profile: { standard: 'обычная строгость', strict: 'строгий вкус' }, audience: { owner: 'себе', team: 'своей команде', external: 'чужой команде или клиенту' },
    lang: { auto: 'как в системе', ru: 'русский', en: 'английский' },
  };
  U.printAndSaveSummary(null, 'doctor', [
    (en ? 'Settings saved: ' : 'Настройки сохранены: ') + fwd(R.path) + (R.error ? (en ? ' (the old file was broken — rewritten)' : ' (старый файл был битый — переписан)') : ''),
    `${en ? 'subscription' : 'подписка'} ${W.sub[cfg.subscription] || '—'} · ${en ? 'volume' : 'объём'} ${W.depth[eff('depth')] || eff('depth')} · ${W.models[eff('models')] || eff('models')} · ${en ? 'agents at once' : 'агентов одновременно'} ${eff('parallel')}${preset ? (en ? ' (where not chosen — by the subscription)' : ' (где не выбрано — по подписке)') : ''}`,
    `${W.profile[cfg.profile || 'standard']} · ${en ? 'report' : 'отчёт'} ${W.audience[cfg.audience || 'owner']} · ${en ? 'language' : 'язык'} ${W.lang[cfg.lang || 'auto']} · ${en ? 'reports folder' : 'папка отчётов'} ${cfg.out}`,
  ]);
}

async function main() {
  const args = U.parseArgs(argv, { boolean: ['help', 'json', 'no-update-check', 'no-browser', 'add-rules', 'dry-run', 'yes', 'write-config', 'scores'] });
  U.helpAndExit(HELP, args);
  const en = U.langOf(args) === 'en' || EN;
  const lang = en ? 'en' : 'ru';
  if (args['add-rules']) return addRules(args, en);
  if (args['write-config']) return writeConfig(args, en);
  const run = args.run && args.run !== true ? resolve(String(args.run)) : null;
  if (args.run === true) { console.error(U.msg('need_run', lang)); process.exit(2); }
  if (run && !existsSync(join(run, 'state.json'))) {
    console.error(en ? `No state.json in ${run} — not a Revizor run folder (create one with init-run.mjs).` : `В ${run} нет state.json — это не папка прогона Ревизора (её создаёт init-run.mjs).`);
    process.exit(2);
  }
  const st = run ? U.readJSON(join(run, 'state.json'), null) : null;
  const briefIn = run ? (U.readJSON(join(run, 'brief.json'), null) || U.readJSON(join(run, 'brief.input.json'), null)) : null;
  const checks = [];
  const add = (id, status, text, data) => { checks.push({ id, status, text, ...(data ? { data } : {}) }); };
  const result = { tool: 'doctor', version: U.VERSION, generated: U.nowIso(), os: { platform: process.platform, name: osName(), arch: process.arch }, offline: OFFLINE, paths: pathsInfo() };

  // Node
  add('node', 'ok', `Node ${process.versions.node}`);

  // run folder root
  const cfgR = U.readRevizorConfig();
  const out = args.out && args.out !== true ? resolve(String(args.out)) : (st?.flags?.out || (cfgR.config.out ? resolve(cfgR.config.out) : U.defaultOutDir()));
  let writable = false, free = null;
  try {
    U.ensureDir(out);
    const probe = join(out, `.revizor-write-test-${process.pid}`);
    writeFileSync(probe, 'ok'); rmSync(probe, { force: true }); writable = true;
  } catch (e) { add('out', 'fail', en ? `Cannot write to ${out}: ${e.code || e.message}. Choose another folder: /revizor:setup or --out.` : `Нет записи в ${out}: ${e.code || e.message}. Выберите другую папку: /revizor:setup или --out.`); }
  try { const sfs = statfsSync(out); free = Number(sfs.bavail) * Number(sfs.bsize); } catch { /* unknown */ }
  if (writable) {
    const freeTxt = free === null ? '' : (en ? `, free ${U.fmtBytes(free).replace(/ГБ$/, 'GB').replace(/МБ$/, 'MB').replace(/КБ$/, 'KB').replace(/Б$/, 'B')}` : `, свободно ${U.fmtBytes(free)}`);
    add('out', free !== null && free < LOW_DISK ? 'warn' : 'ok', (en ? `Reports folder: ${out.replace(/\\/g, '/')} — writable` : `Папка отчётов: ${out.replace(/\\/g, '/')} — запись есть`) + freeTxt
      + (free !== null && free < LOW_DISK ? (en ? '. Less than 2 GB left: a full run takes hundreds of MB.' : '. Меньше 2 ГБ: полный прогон занимает сотни мегабайт.') : ''));
  }
  if (cfgR.error) add('config', 'warn', en ? `~/.revizor/config.json is broken (${cfgR.error}) — run /revizor:setup.` : `~/.revizor/config.json не читается (${cfgR.error}) — запустите /revizor:setup.`);
  result.out = { path: out, writable, free_bytes: free };

  // site URL for the network check (the same parsing as init-run: local hosts without a scheme → http)
  let netUrl = DEFAULT_NET_URL;
  const siteArg = args.url && args.url !== true ? String(args.url) : st?.flags?.url;
  if (siteArg) {
    try { const { parseSiteUrl } = await import('./init-run.mjs'); const p = parseSiteUrl(siteArg, lang); if (p.url) netUrl = p.url; }
    catch { try { netUrl = U.normalizeUrl(siteArg); } catch { /* keep default */ } }
  }
  const netHost = U.hostOf(netUrl);
  if (isPrivateLiteral(netHost) || await U.resolvesPrivate(netHost)) U.allowPrivateHost(netHost); // the reviewed site itself may be local
  const skipNet = OFFLINE && !siteArg; // example.com is outside the site: not in offline mode
  const nodeNet = skipNet ? null : await U.politeFetch(netUrl, { timeoutMs: 12000, retries: 0, maxBytes: 200000 });
  if (run && !siteArg && !skipNet) U.logExternal(run, 'example.com', 'проверка сети (GET главной, без данных сайта)', 1);

  // machine speed (Node)
  const runs = []; for (let k = 0; k < 6; k++) runs.push(benchMs().ms);
  const nodeBench = Math.round(Math.min(...runs));

  // browser: found? start, network via browser, speed inside a page. Busy slots (another run) are a warning, not «no browser».
  let browserNet = null, browserBench = null, browserName = null;
  if (!args['no-browser']) {
    let exe = null, cdp = null;
    try { cdp = await import('./lib/cdp.mjs'); exe = cdp.findBrowser(); }
    catch (e) {
      const parts = String(e.message).split(' / ');
      add('browser', 'fail', en ? `Browser: not found — ${(parts[1] || parts[0]).trim().slice(0, 160)}` : `Браузер: не найден — ${parts[0].trim().slice(0, 160)}`);
    }
    if (exe) {
      let release = null;
      try { release = await U.acquireBrowserSlot({ waitMs: 3000 }); } catch { /* busy */ }
      if (!release) {
        process.stderr.write(en ? `Both browser slots are busy (another Revizor run) — waiting up to ${SLOT_WAIT_MS / 1000} s…\n` : `Оба слота браузера заняты другим прогоном Ревизора — жду свободный до ${SLOT_WAIT_MS / 1000} с…\n`);
        try { release = await U.acquireBrowserSlot({ waitMs: SLOT_WAIT_MS }); } catch { /* still busy */ }
      }
      if (!release) {
        add('browser', 'warn', en ? `Browser: found (${exe.replace(/\\/g, '/')}), but both browser slots are busy with another Revizor run — start not checked; try again later.`
          : `Браузер: найден (${exe.replace(/\\/g, '/')}), но оба слота заняты другим прогоном Ревизора — запуск не проверял; повторите позже.`, { busy: true });
      } else {
        const t0 = Date.now();
        let b;
        try {
          b = await cdp.Browser.launch({ executablePath: exe });
          const startMs = Date.now() - t0;
          browserName = String(b.version?.Browser || '').replace('/', ' ');
          if (!skipNet) {
            const page = await b.newPage();
            // the network check needs only the document status: no site scripts (no form sends started by the page)
            await page.send('Emulation.setScriptExecutionDisabled', { value: true }).catch(() => {});
            const g = await page.goto(netUrl, { timeout: 25000, waitUntil: 'domcontentloaded' });
            browserNet = { ok: !!g.ok && !g.refused && (g.status === null || g.status < 500), status: g.status ?? null, ms: g.ms, error: g.error || g.refused || null };
            await page.close();
          }
          try {
            const bl = await b.newPage();
            const ms = [];
            for (let k = 0; k < 3; k++) ms.push(await bl.evaluate(`${BENCH_SRC}().ms`));
            browserBench = Math.round(Math.min(...ms));
            await bl.close();
          } catch { /* bench is optional */ }
          add('browser', 'ok', en ? `Browser: ${browserName} — starts in ${(startMs / 1000).toFixed(1)} s (${exe.replace(/\\/g, '/')})` : `Браузер: ${browserName} — стартует за ${(startMs / 1000).toFixed(1).replace('.', ',')} с (${exe.replace(/\\/g, '/')})`);
        } catch (e) {
          const parts = String(e.message).split(' / ');
          add('browser', 'fail', en ? `Browser: does not start — ${(parts[1] || parts[0]).trim().slice(0, 160)}` : `Браузер: не стартует — ${parts[0].trim().slice(0, 160)}`);
        } finally { try { if (b) await b.close(); } catch { /* closed */ } release(); }
      }
    }
  } else add('browser', 'info', en ? 'Browser check skipped (--no-browser).' : 'Браузер не проверял (--no-browser).');

  // network verdict
  const px = proxyInfo();
  let vpnSuspected = false;
  const host = netHost;
  if (skipNet) add('network', 'info', en ? 'Offline mode (REVIZOR_OFFLINE=1): the network check through example.com skipped — give --url of the site to check it.'
    : 'Офлайн-режим (REVIZOR_OFFLINE=1): сеть через example.com не проверял — для проверки дайте --url сайта.');
  else {
    const nOk = !!nodeNet.ok || (nodeNet.status >= 200 && nodeNet.status < 500 && nodeNet.status !== 0);
    if (nOk && (browserNet?.ok ?? true)) add('network', 'ok', en ? `Network: ${host} opens from Node (${nodeNet.status}, ${(nodeNet.ms / 1000).toFixed(1)} s)${browserNet ? ` and from the browser (${browserNet.status ?? '—'})` : ''}`
      : `Сеть: ${host} открывается из Node (${nodeNet.status}, ${(nodeNet.ms / 1000).toFixed(1).replace('.', ',')} с)${browserNet ? ` и из браузера (${browserNet.status ?? '—'})` : ''}`);
    else if (!nOk && browserNet?.ok) {
      vpnSuspected = true;
      add('network', 'warn', en ? `Network: the browser opens ${host}, Node does not (${nodeNet.error || nodeNet.status}). A VPN or proxy works for the browser only: switch the VPN to TUN / "all traffic" mode, or set HTTPS_PROXY and NODE_USE_ENV_PROXY=1, then restart Claude.`
        : `Сеть: браузер открывает ${host}, а Node — нет (${nodeNet.error || nodeNet.status}). VPN или прокси работает только для браузера: включите в VPN режим TUN («весь трафик») или задайте HTTPS_PROXY и NODE_USE_ENV_PROXY=1, затем перезапустите Claude.`);
    } else if (nOk && browserNet && !browserNet.ok) {
      add('network', 'warn', en ? `Network: Node opens ${host}, the browser does not (${browserNet.error || browserNet.status}) — a browser proxy or the site blocks headless browsers.`
        : `Сеть: Node открывает ${host}, а браузер — нет (${browserNet.error || browserNet.status}): прокси браузера или сайт не пускает автоматический браузер.`);
    } else add('network', 'fail', en ? `Network: ${host} does not open (${nodeNet.error || nodeNet.status}). Check the internet connection or VPN.` : `Сеть: ${host} не открывается (${nodeNet.error || nodeNet.status}). Проверьте интернет или VPN.`);
    if (nodeNet.antibot) add('antibot', 'warn', en ? `${host} answers with an anti-bot page (${nodeNet.antibot}) — part of the checks may be blocked.` : `${host} отвечает защитой от ботов (${nodeNet.antibot}) — часть проверок может не пройти.`);
    result.network = { url: netUrl, node: { ok: nOk, status: nodeNet.status, ms: nodeNet.ms, error: nodeNet.error || null, antibot: nodeNet.antibot || null }, browser: browserNet, proxy: px, vpn_suspected: false };
  }
  if ((px.env.length && !px.node_uses_env) || px.system) {
    if (px.env.length && !px.node_uses_env) vpnSuspected = true;
    add('proxy', 'info', en ? `Proxy: ${[px.system ? `system (${px.system})` : null, px.env.length ? `variables ${px.env.join(', ')}` : null].filter(Boolean).join(', ')}${px.env.length && !px.node_uses_env ? '; Node ignores them without NODE_USE_ENV_PROXY=1' : ''}.`
      : `Прокси: ${[px.system ? `системный (${px.system === 'pac' ? 'PAC-файл' : 'вручную'})` : null, px.env.length ? `переменные ${px.env.join(', ')}` : null].filter(Boolean).join(', ')}${px.env.length && !px.node_uses_env ? '; Node их не использует без NODE_USE_ENV_PROXY=1' : ''}.`);
  }
  result.network ||= { url: netUrl, node: null, browser: browserNet, proxy: px, skipped: 'offline' };
  result.network.vpn_suspected = vpnSuspected;

  // axe-core
  const axe = await axeInfo(run, briefIn, lang);
  result.axe = axe;
  const axeCmd = `node "${fwd(join(SCRIPTS_DIR, 'collectors', 'axe.mjs'))}" --prefetch`;
  if (axe.ok) add('axe', 'ok', axe.from === 'file' ? (en ? `axe-core: local file REVIZOR_AXE_FILE (version ${axe.version}, no sha256 check)` : `axe-core: локальный файл REVIZOR_AXE_FILE (версия ${axe.version}, sha256 не сверял)`)
    : axe.from === 'cdn' ? (en ? `axe-core ${axe.version}: downloaded to the cache, sha256 verified (no site data sent)` : `axe-core ${axe.version}: скачан в кэш, sha256 сверен (данные сайта не уходят)`)
      : (en ? `axe-core ${axe.version}: in the cache, sha256 verified` : `axe-core ${axe.version}: есть в кэше, sha256 сверен`));
  else if (axe.missing_collector) add('axe', 'warn', en ? 'axe collector is not installed — axe rules will be marked as not checked.' : 'Коллектор axe не установлен — правила axe пойдут в «не проверено».');
  else if (axe.offline) add('axe', 'warn', en ? `axe-core ${axe.version} is not in the cache${axe.cache === 'bad' ? ' (the cached file does not match sha256)' : ''}, downloads are off (offline mode) — axe rules will be marked as not checked. Without REVIZOR_OFFLINE: ${axeCmd}`
    : `axe-core ${axe.version} нет в кэше${axe.cache === 'bad' ? ' (файл в кэше не совпал по sha256)' : ''}, скачивание выключено (офлайн-режим) — правила axe пойдут в «не проверено». Без REVIZOR_OFFLINE: ${axeCmd}`);
  else add('axe', 'warn', en ? `axe-core ${axe.version} did not download (${axe.error}) — axe rules will be marked as not checked.` : `axe-core ${axe.version} не скачался (${axe.error}) — правила axe пойдут в «не проверено».`);

  // machine
  const cpus = os.cpus()?.length || 0;
  const memGb = Math.round(os.totalmem() / 1024 ** 3);
  const slow = nodeBench > SLOW_MS || (browserBench !== null && browserBench > SLOW_MS * 1.3) || cpus < 4 || memGb < 4;
  result.machine = { bench_ms: nodeBench, browser_bench_ms: browserBench, threshold_ms: SLOW_MS, cpus, mem_gb: memGb, slow, machine_slow: slow };
  add('machine', slow ? 'warn' : 'ok', slow
    ? (en ? `Slow machine (test ${nodeBench} ms, norm up to ${SLOW_MS}; ${cpus} cores, ${memGb} GB): lab speed numbers will look worse; no P0–P1 on lab speed alone. Fewer agents at once helps (--parallel 3).`
      : `Машина медленная (тест ${nodeBench} мс при норме до ${SLOW_MS}; ядер ${cpus}, памяти ${memGb} ГБ): лабораторная скорость сайта выйдет хуже настоящей, P0–P1 по ней одной не ставим. Поможет меньше агентов сразу (--parallel 3).`)
    : (en ? `Machine speed: test ${nodeBench} ms (${cpus} cores, ${memGb} GB)` : `Скорость машины: тест ${nodeBench} мс (ядер ${cpus}, памяти ${memGb} ГБ)`));

  // language
  const sl = U.systemLang();
  result.lang = sl;
  add('lang', 'ok', en ? `System language: ${sl.locale || 'unknown'} → report in ${sl.lang === 'ru' ? 'Russian' : 'English'} unless asked otherwise` : `Язык системы: ${sl.locale || 'не определён'} → отчёт ${sl.lang === 'ru' ? 'на русском' : 'на английском'}, если не попросят иначе`);

  // permissions
  const perm = permissionInfo(out);
  result.permissions = perm;
  if (perm.node_deny.length) add('permissions', 'warn', en ? `Permissions: a deny rule for node in ${perm.node_deny.join(', ')} — Revizor scripts will be refused. Remove it or narrow it (for example only node -e).`
    : `Разрешения: правило deny для node в ${perm.node_deny.join(', ')} — скрипты Ревизора будут запрещены. Уберите его или сузьте (например, только node -e).`);
  else if (perm.deny_scripts.length) add('permissions', 'warn', en ? `Permissions: a deny rule for ${perm.deny_scripts.join(', ')} — these steps will be refused and the run will stop there. Remove the rule in /permissions.`
    : `Разрешения: правило deny на ${perm.deny_scripts.join(', ')} — эти шаги будут запрещены, прогон на них встанет. Уберите правило в /permissions.`);
  else if (perm.mode === 'bypassPermissions') add('permissions', 'ok', en ? 'Permissions: mode bypassPermissions (no questions)' : 'Разрешения: режим bypassPermissions (без вопросов)');
  else if (perm.node_ask.length) add('permissions', 'warn', en ? `Permissions: an ask rule for node in ${perm.node_ask.join(', ')} — there will be a question for every script; answer "always allow" or run /revizor:setup.`
    : `Разрешения: правило ask для node в ${perm.node_ask.join(', ')} — вопрос будет на каждый скрипт; отвечайте «разрешать всегда» или запустите /revizor:setup.`);
  else if (perm.ask_scripts.length) add('permissions', 'warn', en ? `Permissions: an ask rule for ${perm.ask_scripts.join(', ')} — a question on every call of these scripts; remove the rule in /permissions.`
    : `Разрешения: правило ask на ${perm.ask_scripts.join(', ')} — вопрос на каждый вызов этих скриптов; уберите правило в /permissions.`);
  else if (perm.node_rule.length) add('permissions', 'warn', en ? `Permissions: a too wide rule (${perm.wide_rules.slice(0, 2).join(', ')} in ${perm.node_rule.join(', ')}) — other commands pass without a question too, not only Revizor ones. Replace it with narrow ones: /revizor:setup (or doctor --add-rules --dry-run, then --yes) and remove the wide one in /permissions.`
    : `Разрешения: слишком широкое правило (${perm.wide_rules.slice(0, 2).join(', ')} в ${perm.node_rule.join(', ')}) — так без вопроса пройдут и чужие команды, не только Ревизора. Замените на узкие: /revizor:setup (или doctor --add-rules --dry-run, затем --yes), широкое уберите в /permissions.`);
  else if (perm.scripts_total && perm.exact_scripts >= perm.scripts_total) add('permissions', 'ok', en ? `Permissions: rules for all ${perm.scripts_total} scripts of this version` : `Разрешения: правила есть для всех ${perm.scripts_total} скриптов этой версии`);
  else if (perm.mode === 'dontAsk') add('permissions', 'warn', en ? `Permissions: mode dontAsk refuses everything not allowed — ${perm.exact_scripts ? `${perm.scripts_total - perm.exact_scripts} of ${perm.scripts_total} Revizor scripts` : 'Revizor scripts'} will be refused. /revizor:setup adds narrow rules.`
    : `Разрешения: режим dontAsk запрещает всё, чего нет в allow, — ${perm.exact_scripts ? `${perm.scripts_total - perm.exact_scripts} из ${perm.scripts_total} скриптов Ревизора` : 'скрипты Ревизора'} будут запрещены. Узкие правила добавит /revizor:setup.`);
  else if (perm.exact_scripts) add('permissions', 'warn', en ? `Permissions: rules cover ${perm.exact_scripts} of ${perm.scripts_total} scripts — the rest will ask; /revizor:setup adds the missing ones.`
    : `Разрешения: правила есть для ${perm.exact_scripts} из ${perm.scripts_total} скриптов — на остальные будут вопросы; недостающие добавит /revizor:setup.`);
  else if (perm.stale_dirs.length) add('permissions', 'warn', en ? `Permissions: the rules are for another plugin version (${perm.stale_dirs[0]}) — after an update run /revizor:setup again to add rules for this one.`
    : `Разрешения: правила написаны для другой версии плагина (${perm.stale_dirs[0]}) — после обновления повторите /revizor:setup, он добавит правила для этой.`);
  else add('permissions', 'warn', en ? 'No permission rule for node: there will be permission questions; answer "always allow" for Revizor node scripts or run /revizor:setup.'
    : 'Правил разрешений для node нет: будут вопросы о разрешениях; ответьте «разрешать всегда» для node-скриптов Ревизора или запустите /revizor:setup.');
  if (perm.mode !== 'bypassPermissions' && !perm.edit_rule.length) add('permissions_write', 'info', en ? `No Edit/Write rule for the reports folder: agents will ask before writing files to the run folder (${out.replace(/\\/g, '/')}). /revizor:setup adds a narrow rule.`
    : `Правила Edit/Write для папки отчётов нет: агенты будут спрашивать разрешение на запись файлов в папку прогона (${out.replace(/\\/g, '/')}). Узкое правило добавит /revizor:setup.`);

  // housekeeping: dead slots and leftover profiles
  let cleaned = 0, leftovers = 0;
  const slotDir = join(os.tmpdir(), 'revizor-slots');
  for (const n of (() => { try { return readdirSync(slotDir); } catch { return []; } })()) {
    const f = join(slotDir, n);
    try { const pid = parseInt(readFileSync(f, 'utf8'), 10); /* «<pid> <token>» */ if (pid && pid !== process.pid) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { rmSync(f, { force: true }); cleaned++; } } } } catch { /* busy */ }
  }
  for (const n of (() => { try { return readdirSync(os.tmpdir()); } catch { return []; } })()) {
    if (!n.startsWith('revizor-profile-')) continue;
    try { if (Date.now() - statSync(join(os.tmpdir(), n)).mtimeMs > 2 * 3600e3) leftovers++; } catch { /* in use or gone */ }
  }
  if (cleaned || leftovers) add('cleanup', 'info', en ? `Housekeeping: freed ${cleaned} stuck browser slot(s); abandoned temp browser profiles: ${leftovers} (removed on the next browser start).`
    : `Уборка: освобождено зависших слотов браузера — ${cleaned}; брошенных временных профилей браузера — ${leftovers} (удалятся при следующем запуске браузера).`);

  // update
  const upd = await updateInfo(pluginVersion(), run);
  result.update = upd;
  if (upd.newer) add('update', 'info', en ? `Version ${upd.latest} is out${upd.notes ? ` (what's new: ${upd.notes})` : ''}. Update: /plugin marketplace update revizor, then /reload-plugins`
    : `Есть версия ${upd.latest}${upd.notes ? ` (что нового: ${upd.notes})` : ''}. Обновить: /plugin marketplace update revizor, затем /reload-plugins`);
  if (OFFLINE) add('offline', 'info', en ? 'Offline mode (REVIZOR_OFFLINE=1): the axe CDN and plugin updates were not checked.' : 'Офлайн-режим (REVIZOR_OFFLINE=1): CDN axe и обновления не проверял.');

  // verdict
  const needBrowser = checks.some(c => c.id === 'browser' && c.status === 'fail');
  const fatal = checks.some(c => c.status === 'fail' && ['node', 'browser', 'out'].includes(c.id));
  result.ok = !fatal;
  result.checks = checks;
  result.install = needBrowser ? installLines(process.platform, false, true, en) : [];
  if (run) { try { U.writeJSON(join(run, 'doctor.json'), result); await setDone(run, { doctor: fatal ? 'failed' : 'ok' }); } catch { /* state optional */ } }

  if (args.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exitCode = fatal ? 2 : 0; return; }
  const icon = { ok: '✔', warn: '⚠', fail: '✖', info: 'ℹ' };
  const lines = [en ? `Revizor: environment check (${result.os.name}, ${process.arch})` : `Ревизор: проверка окружения (${result.os.name}, ${process.arch})`,
    ...checks.map(c => `${icon[c.status] || '-'} ${c.text}`), ...result.install,
    fatal ? (en ? 'Result: cannot start a review — fix the lines marked ✖ (/revizor:setup helps).' : 'Итог: запускать ревью нельзя — исправьте строки с ✖ (поможет /revizor:setup).')
      : (en ? 'Result: ready to review.' : 'Итог: можно запускать ревью.')];
  U.printAndSaveSummary(run, 'doctor', lines);
  process.exitCode = fatal ? 2 : 0;
}

main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
