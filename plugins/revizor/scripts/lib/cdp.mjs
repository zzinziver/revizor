// Revizor — minimal zero-dependency Chrome DevTools Protocol client.
// Needs Node >= 22 (global fetch + WebSocket) and any Chromium-based browser
// (Chrome, Edge, Chromium, Brave, Yandex Browser). Set REVIZOR_BROWSER to force a path.
//
// SAFETY NET (read before changing anything here — see knowledge/conduct.md):
//  1. Every request of every target (page, its iframes, workers, popups) passes through Fetch interception.
//  2. Non-GET/HEAD/OPTIONS requests are cut: no form, chat or API write can leave a review run
//     (opt-in allowLoadPosts lets SPA content load during goto() only — never during interactions).
//  3. Analytics/ad counters, call-tracking, chat and callback widgets are cut: our visits must not reach
//     search-engine crawl queues, burn call-tracking numbers or ping operators. Attempts are recorded.
//  4. Document navigations to risky GET URLs (/logout, /cart/add, ?action=delete…) are cut.
//  5. In the 'interact' phase navigations are cut and recorded when blockNavigation is on (default in scripts).
//     Form submissions are cut in EVERY phase, also during goto(): form.submit() is a no-op in the page, the submit
//     event loses its default action, and a submission that still starts (Page.frameRequestedNavigation reason
//     formSubmission*, or any non-GET document request) is failed in Fetch. GET → blocked.navigation, POST → blocked.write
//     (reason 'form'; via 'page' when stopped inside the page).
//  6. Popups/new windows are closed before they load anything.
//  7. tap()/click() refuse iframes and submit buttons; private-network hosts are refused unless allowed
//     (util.isPrivateIp also knows IPv4 inside IPv6: ::ffff:7f00:1, 64:ff9b::a00:1, 2002:…).
//  8. Fresh temporary profile per launch; removed on close, on exit and on signals; stale ones are swept.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, platform, homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isRiskyGet, resolvesPrivate, isAllowedPrivate, isPrivateIp, hostOf, staleProfileDirs, serviceNameEn } from './util.mjs';

export const ANALYTICS_BLOCKLIST = [
  '*mc.yandex.ru*', '*mc.yandex.com*', '*metrika.yandex*', '*an.yandex.ru*', '*yandex.ru/ads*',
  '*google-analytics.com*', '*analytics.google.com*', '*googletagmanager.com*',
  '*doubleclick.net*', '*googleadservices.com*', '*googlesyndication.com*',
  '*connect.facebook.net*', '*facebook.com/tr*', '*vk.com/rtrg*', '*top-fwz1.mail.ru*',
  '*counter.yadro.ru*', '*top.mail.ru*', '*static.hotjar.com*', '*script.hotjar.com*',
  '*clarity.ms*', '*cdn.amplitude.com*', '*api.amplitude.com*', '*api2.amplitude.com*',
  '*plausible.io/api*', '*/matomo.js*', '*/piwik.js*', '*segment.io*', '*cdn.segment.com*', '*tiktok.com/i18n/pixel*',
  '*analytics.tiktok.com*', '*snap.licdn.com*', '*bat.bing.com*', '*ct.pinterest.com*', '*mixpanel.com*',
];

// Call-tracking (reserves a substitute phone number per visit), chats (notify operators), callbacks.
export const WIDGET_BLOCKLIST = [
  // call-tracking
  '*roistat.com*', '*calltouch.ru*', '*comagic.ru*', '*uiscom.ru*', '*callibri.ru*', '*mango-office.ru*', '*alloka.ru*',
  '*ringostat.*', '*calltracking.ru*', '*callbackkiller.*', '*telphin.ru/ct*',
  // chats & callbacks
  '*jivosite.com*', '*jivo.ru*', '*code.jivo.ru*', '*bitrix24.*/b*/crm/site_button*', '*bitrix24.*/b*/crm/form*', '*carrotquest.io*',
  '*talk-me.ru*', '*livetex.ru*', '*chatra.io*', '*tawk.to*', '*widget.intercom.io*', '*crisp.chat*', '*verbox.ru*',
  '*envybox.io*', '*callbackhunter.com*', '*leadback.ru*', '*perezvoni.com*', '*marquiz.ru/api*', '*getsitecontrol.com*',
];
export const WIDGET_NAMES = [
  ['roistat', 'Roistat (коллтрекинг)'], ['calltouch', 'Calltouch (коллтрекинг)'], ['comagic', 'CoMagic (коллтрекинг)'], ['uiscom', 'UIS (коллтрекинг)'],
  ['callibri', 'Callibri (коллтрекинг)'], ['mango-office', 'Mango Office (коллтрекинг)'], ['alloka', 'Alloka (коллтрекинг)'], ['ringostat', 'Ringostat (коллтрекинг)'],
  ['jivo', 'Jivo (чат)'], ['bitrix24', 'Битрикс24 (виджет/форма)'], ['carrotquest', 'Carrot quest (чат)'], ['talk-me', 'Talk-Me (чат)'], ['livetex', 'LiveTex (чат)'],
  ['chatra', 'Chatra (чат)'], ['tawk.to', 'Tawk.to (чат)'], ['intercom', 'Intercom (чат)'], ['crisp', 'Crisp (чат)'], ['verbox', 'Verbox (чат)'],
  ['envybox', 'Envybox (обратный звонок)'], ['callbackhunter', 'Callbackhunter (обратный звонок)'], ['leadback', 'LeadBack (обратный звонок)'],
  ['perezvoni', 'Perezvoni (обратный звонок)'], ['marquiz', 'Marquiz (квиз)'], ['getsitecontrol', 'GetSiteControl (попапы)'],
];

export function checkNode() {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22 || typeof WebSocket === 'undefined') {
    throw new Error(`Node ${process.versions.node}: нужен Node.js 22 или новее (https://nodejs.org), после установки перезапустите Claude. / Node.js 22+ is required.`);
  }
}

function which(cmd) {
  try {
    const out = execFileSync(platform() === 'win32' ? 'where' : 'which', [cmd], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().split(/\r?\n/).find(Boolean);
    return out && existsSync(out) ? out : null;
  } catch { return null; }
}

export function findBrowser() {
  if (process.env.REVIZOR_BROWSER && existsSync(process.env.REVIZOR_BROWSER)) return process.env.REVIZOR_BROWSER;
  const p = platform();
  const cands = [];
  if (p === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
    for (const r of roots) {
      cands.push(join(r, 'Google/Chrome/Application/chrome.exe'));
      cands.push(join(r, 'Microsoft/Edge/Application/msedge.exe'));
      cands.push(join(r, 'Chromium/Application/chrome.exe'));
      cands.push(join(r, 'BraveSoftware/Brave-Browser/Application/brave.exe'));
      cands.push(join(r, 'Yandex/YandexBrowser/Application/browser.exe'));
    }
  } else if (p === 'darwin') {
    for (const base of ['/Applications', join(homedir(), 'Applications')]) {
      cands.push(join(base, 'Google Chrome.app/Contents/MacOS/Google Chrome'));
      cands.push(join(base, 'Chromium.app/Contents/MacOS/Chromium'));
      cands.push(join(base, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
      cands.push(join(base, 'Brave Browser.app/Contents/MacOS/Brave Browser'));
      cands.push(join(base, 'Yandex.app/Contents/MacOS/Yandex'));
    }
  } else {
    for (const c of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable', 'brave-browser']) {
      const w = which(c); if (w) cands.push(w);
    }
  }
  const found = cands.find(c => c && existsSync(c));
  if (!found) {
    throw new Error('Не найден браузер на базе Chromium (Chrome, Edge, Chromium, Brave, Яндекс Браузер). Установите Google Chrome или укажите путь в REVIZOR_BROWSER. / No Chromium-based browser found; install Google Chrome or set REVIZOR_BROWSER.');
  }
  return found;
}

export function globToRegex(glob) {
  return new RegExp('^' + glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
}
const ANALYTICS_RE = ANALYTICS_BLOCKLIST.map(globToRegex);
const INDUCED_RE = /blocked by review|Failed to fetch|NetworkError|Load failed|ERR_BLOCKED_BY_CLIENT|ERR_FAILED|ERR_ABORTED|net::ERR_|XMLHttpRequest|sendBeacon|ERR_INTERNET_DISCONNECTED|AbortError/i;
const WIDGET_RE = WIDGET_BLOCKLIST.map(globToRegex);
export function widgetName(url, lang) { const u = String(url).toLowerCase(); const hit = WIDGET_NAMES.find(([k]) => u.includes(k)); return hit ? (lang === 'en' ? serviceNameEn(hit[1]) : hit[1]) : null; }

// Only our own temp profiles may ever be deleted.
function isOurProfile(dir) {
  const base = String(dir || '').replace(/[\\/]+$/, '');
  const name = base.split(/[\\/]/).pop() || '';
  return name.startsWith('revizor-profile-') && base.slice(0, -name.length - 1).toLowerCase() === tmpdir().replace(/[\\/]+$/, '').toLowerCase();
}

function rmrf(dir, tries = 24) {
  if (!isOurProfile(dir)) return true;
  for (let i = 0; i < tries; i++) {
    try { rmSync(dir, { recursive: true, force: true }); if (!existsSync(dir)) return true; } catch { /* Windows keeps locks a moment */ }
    const until = Date.now() + 250; while (Date.now() < until) { /* spin */ }
  }
  return !existsSync(dir);
}

// Chrome helpers (crashpad, GPU, renderers) on Windows can outlive the main process and keep the profile locked.
// Kill the whole tree while the parent pid is still known; if the folder is still locked, hand it to a detached
// remover that retries after the locks are gone (the parent script may already have exited by then).
function killTree(proc) {
  if (!proc?.pid) return;
  if (platform() === 'win32' && proc.exitCode === null) {
    try { execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 }); } catch {}
  }
  try { if (proc.exitCode === null) proc.kill('SIGKILL'); } catch {}
}
function removeLater(dir) {
  if (!isOurProfile(dir) || !existsSync(dir)) return;
  try {
    const cmd = platform() === 'win32'
      ? spawn('cmd.exe', ['/d', '/c', `for /l %i in (1,1,12) do (if exist "${dir}" (rmdir /s /q "${dir}" 2>nul & ping -n 6 127.0.0.1 >nul))`], { detached: true, stdio: 'ignore', windowsHide: true })
      : spawn('sh', ['-c', 'for i in 1 2 3 4 5 6; do [ -e "$1" ] || exit 0; rm -rf "$1"; sleep 5; done', 'rv', dir], { detached: true, stdio: 'ignore' });
    cmd.unref();
  } catch {}
}
function disposeProfile(dir) { if (!rmrf(dir)) removeLater(dir); }

// Remove profiles left by crashed runs: owner process gone, or (legacy names without pid) older than maxAgeMs.
export function sweepStaleProfiles(maxAgeMs = 10 * 60 * 1000) {
  for (const p of staleProfileDirs(maxAgeMs)) disposeProfile(p);
}

// Process-wide cleanup: kill browsers and delete their profiles on any exit path.
const LIVE = new Set();
let handlersInstalled = false;
function installHandlers() {
  if (handlersInstalled) return; handlersInstalled = true;
  const cleanupAll = () => { for (const b of LIVE) { killTree(b.proc); if (!rmrf(b.profile, 8)) removeLater(b.profile); } LIVE.clear(); };
  process.on('exit', cleanupAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try { process.on(sig, () => { cleanupAll(); process.exit(130); }); } catch {}
  }
  process.on('uncaughtException', e => { cleanupAll(); console.error(e?.stack || e); process.exit(1); });
}

function uaFor(versionInfo, mobile) {
  const full = String(versionInfo?.Browser || 'Chrome/130.0.0.0').split('/')[1] || '130.0.0.0';
  const major = full.split('.')[0];
  const brands = [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not_A Brand', version: '24' }];
  const fullVersionList = [{ brand: 'Chromium', version: full }, { brand: 'Google Chrome', version: full }, { brand: 'Not_A Brand', version: '24.0.0.0' }];
  if (mobile) return {
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    userAgentMetadata: { brands, fullVersionList, fullVersion: full, platform: 'Android', platformVersion: '14.0.0', architecture: '', model: 'Pixel 8', mobile: true, bitness: '', wow64: false },
  };
  return {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    userAgentMetadata: { brands, fullVersionList, fullVersion: full, platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false },
  };
}

export class Browser {
  static async launch(opts = {}) {
    checkNode();
    sweepStaleProfiles();
    installHandlers();
    const exe = opts.executablePath || findBrowser();
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    let attempt = await Browser._spawn(exe, opts, isRoot);
    if (!attempt.port && !isRoot && /sandbox/i.test(attempt.stderr)) attempt = await Browser._spawn(exe, opts, true);
    if (!attempt.port) throw new Error('Браузер не запустился / browser failed to start: ' + attempt.stderr.slice(-800));
    const ver = await (await fetch(`http://127.0.0.1:${attempt.port}/json/version`)).json();
    const b = new Browser(attempt.proc, attempt.profile, ver, opts);
    LIVE.add(b);
    await b._connect(ver.webSocketDebuggerUrl);
    await b._setupAutoAttach();
    return b;
  }

  static async _spawn(exe, opts, noSandbox) {
    const profile = mkdtempSync(join(tmpdir(), `revizor-profile-${process.pid}-`));
    const args = [
      opts.headless === false ? null : '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      '--disable-sync', '--disable-component-update', '--disable-default-apps', '--disable-background-networking',
      '--mute-audio', '--hide-scrollbars', '--password-store=basic', '--use-mock-keychain',
      // no crash handler process: on Windows it outlives the browser and keeps the profile locked
      '--disable-breakpad', '--disable-crash-reporter',
      // keep cross-origin iframes in-process so their requests go through the same interception
      '--disable-site-isolation-trials',
      '--disable-features=IsolateOrigins,site-per-process,Translate,MediaRouter,OptimizationHints,AutofillServerCommunication',
      noSandbox ? '--no-sandbox' : null,
      ...(opts.args || []),
      'about:blank',
    ].filter(Boolean);
    const proc = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: false, windowsHide: true });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    const portFile = join(profile, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 200 && !port; i++) {
      // Windows may briefly lock the file (EBUSY) while Chrome writes it — retry on the next tick
      try { if (existsSync(portFile)) { const line = readFileSync(portFile, 'utf8').split(/\r?\n/)[0]; if (line) port = Number(line); } } catch { /* retry */ }
      if (!port) await sleep(100);
      if (proc.exitCode !== null) break;
    }
    if (!port) { killTree(proc); disposeProfile(profile); }
    return { proc, profile, port, stderr };
  }

  constructor(proc, profile, version, opts = {}) {
    this.proc = proc; this.profile = profile; this.version = version; this.opts = opts;
    this.id = 0; this.pending = new Map(); this.listeners = new Map(); this.closed = false;
    this.ourTargets = new Map();   // targetId → resolve(sessionId) for pages we create
    this.popups = [];              // windows opened by the site (closed immediately)
    this.creating = 0; this.unclaimed = new Map();
  }

  _connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = e => reject(new Error('CDP websocket error ' + (e?.message || '')));
      ws.onclose = () => { this.closed = true; for (const { reject } of this.pending.values()) reject(new Error('CDP closed')); this.pending.clear(); };
      ws.onmessage = ev => {
        const msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString());
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject, method } = this.pending.get(msg.id); this.pending.delete(msg.id);
          if (msg.error) reject(new Error(`${method}: ${msg.error.message}`)); else resolve(msg.result);
        } else if (msg.method) {
          const key = (msg.sessionId || '') + '|' + msg.method;
          for (const cb of this.listeners.get(key) || []) { try { cb(msg.params, msg.sessionId); } catch {} }
        }
      };
    });
  }

  send(method, params = {}, sessionId, timeoutMs = 60000) {
    if (this.closed) return Promise.reject(new Error('CDP closed'));
    const id = ++this.id;
    const msg = { id, method, params }; if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`${method}: timeout ${timeoutMs}ms`)); } }, timeoutMs);
      this.pending.set(id, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); }, method });
      this.ws.send(JSON.stringify(msg));
    });
  }

  on(sessionId, method, cb) {
    const key = (sessionId || '') + '|' + method;
    if (!this.listeners.has(key)) this.listeners.set(key, new Set());
    this.listeners.get(key).add(cb);
    return () => this.listeners.get(key)?.delete(cb);
  }

  // Browser-level auto-attach: every new top-level target is paused before it loads anything.
  // Pages we create are handed to newPage(); windows opened by the site are recorded and closed.
  async _setupAutoAttach() {
    this.on('', 'Target.attachedToTarget', async (p) => {
      const { sessionId, targetInfo } = p;
      const mine = this.ourTargets.get(targetInfo.targetId);
      if (mine) { mine(sessionId); return; }
      const isPage = targetInfo.type === 'page' || targetInfo.type === 'tab';
      // our own Target.createTarget may report attachment before its response arrives
      if (isPage && this.creating > 0 && !targetInfo.openerId && (!targetInfo.url || targetInfo.url === 'about:blank')) {
        this.unclaimed.set(targetInfo.targetId, sessionId); return;
      }
      if (isPage) {
        this.popups.push({ url: targetInfo.url, opener: targetInfo.openerId || null });
        // a paused popup freezes its opener's renderer (window.open waits): cut every request it makes, release it, close it
        await installInterceptor(this, sessionId, () => ({ blockAll: true }));
        try { await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId); } catch {}
        try { await this.send('Target.closeTarget', { targetId: targetInfo.targetId }); } catch {}
        return;
      }
      // service workers / shared workers: same interception and socket guard, then let them run
      await installInterceptor(this, sessionId, () => ({ phase: 'interact', allowLoadPosts: false, blockNavigation: false, record: null }));
      try { await this.send('Runtime.evaluate', { expression: PAGE_GUARD_SRC('true') }, sessionId); } catch {}
      try { await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId); } catch {}
    });
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  }

  async newPage(opts = {}) {
    this.creating++;
    let targetId, sessionId;
    try {
      ({ targetId } = await this.send('Target.createTarget', { url: 'about:blank' }));
      sessionId = this.unclaimed.get(targetId);
      if (!sessionId) {
        sessionId = await Promise.race([new Promise(r => this.ourTargets.set(targetId, r)), sleep(3000).then(() => null)]);
        this.ourTargets.delete(targetId);
      }
      this.unclaimed.delete(targetId);
      if (!sessionId) ({ sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true }));
    } finally { this.creating--; }
    const page = new Page(this, targetId, sessionId, opts);
    await page._init(opts);
    try { await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId); } catch {}
    return page;
  }

  async close() {
    try { if (!this.closed) await this.send('Browser.close', {}, undefined, 5000); } catch {}
    try { this.ws?.close(); } catch {}
    for (let i = 0; i < 30 && this.proc.exitCode === null; i++) await sleep(100);
    killTree(this.proc);
    disposeProfile(this.profile);
    LIVE.delete(this);
  }
}

// Fetch interception for one CDP session (page, iframe, worker). ctx() returns the live policy of the owning page.
async function installInterceptor(browser, sessionId, ctx) {
  const send = (m, p) => browser.send(m, p, sessionId);
  browser.on(sessionId, 'Fetch.requestPaused', async p => {
    const { requestId, request } = p;
    const method = (request.method || 'GET').toUpperCase();
    const url = request.url;
    const c = ctx();
    // Aborted keeps the current document for blocked navigations (BlockedByClient would commit an error page)
    const reason = p.resourceType === 'Document' ? 'Aborted' : 'BlockedByClient';
    const rec = (kind, extra = {}) => c.record?.(kind, { method, url: url.slice(0, 500), type: p.resourceType, phase: c.phase, ...extra });
    try {
      // Response stage exists only while a page.interceptDocument() hook is on; the request already passed every check below
      if (p.responseStatusCode !== undefined || p.responseErrorReason !== undefined) {
        if (c.onResponse) await c.onResponse(p, send); else await send('Fetch.continueRequest', { requestId });
        return;
      }
      if (c.blockAll) { await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }); return; }
      // our own answers (page.serveLocal): served here, the request never leaves the machine
      const local = c.local?.get(url);
      if (local) {
        local.served++;
        await send('Fetch.fulfillRequest', { requestId, responseCode: local.status, responseHeaders: local.headers, body: local.body });
        return;
      }
      if (!c.allowAnalytics && ANALYTICS_RE.some(r => r.test(url))) { rec('analytics'); await send('Fetch.failRequest', { requestId, errorReason: reason }); return; }
      if (!c.allowWidgets && WIDGET_RE.some(r => r.test(url))) {
        const service = widgetName(url);
        rec('widget', { service, service_en: service ? serviceNameEn(service) : null }); await send('Fetch.failRequest', { requestId, errorReason: reason }); return;
      }
      if (c.extraBlock?.some(r => r.test(url))) { rec('blocked'); await send('Fetch.failRequest', { requestId, errorReason: reason }); return; }
      // A public page must not make our browser reach into the user's network (router, intranet, localhost).
      const rh = hostOf(url);
      if (rh && !isAllowedPrivate(rh) && (rh === 'localhost' || rh.endsWith('.localhost') || isPrivateIp(rh.replace(/^\[|\]$/g, '')))) {
        rec('private'); await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); return;
      }
      const isDoc = p.resourceType === 'Document';
      const safe = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
      // Form submissions are never sent, in any phase: a page may submit a form by itself while loading
      // (form.submit() in an inline script, a GET search form, a self-posting iframe). POST documents are always forms.
      if (isDoc && !safe) { rec('write', { reason: 'form' }); await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }); return; }
      if (isDoc && !p.redirectedRequestId && c.formNav && await c.formNav(url)) {
        rec('navigation', { reason: 'form' }); await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }); return;
      }
      // Interaction guard: for a few seconds after OUR tap/click/key (and while probe runs injected code) any background
      // request the page fires may be a lead sent by GET (fetch, beacon, JSONP, new Image().src with the form data).
      // Cut XHR/fetch/beacon/EventSource and anything with a query string; static files without parameters still load.
      if (c.guardUntil > Date.now()) {
        const bg = p.resourceType === 'XHR' || p.resourceType === 'Fetch' || p.resourceType === 'Ping' || p.resourceType === 'EventSource' || p.resourceType === 'Other';
        if (bg || url.includes('?')) { rec('interact'); await send('Fetch.failRequest', { requestId, errorReason: reason }); return; }
      }
      // allowLoadPosts: only requests of the NEW document (after commit) — never unload beacons of the previous page
      if (!safe && !(c.allowLoadPosts && c.phase === 'load' && c.committed)) { rec('write'); await send('Fetch.failRequest', { requestId, errorReason: reason }); return; }
      if (isDoc && !p.redirectedRequestId && c.navTarget !== url && isRiskyGet(url)) { rec('risky'); await send('Fetch.failRequest', { requestId, errorReason: reason }); return; }
      // After load, fetch/XHR GETs to risky URLs come from our interactions or injected code (probe --js) — cut them too.
      // During load the site's own requests are left alone (blocking them would break the page we review).
      if (!isDoc && c.phase === 'interact' && (p.resourceType === 'XHR' || p.resourceType === 'Fetch') && isRiskyGet(url)) {
        rec('risky'); await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }); return;
      }
      if (isDoc && c.blockNavigation && c.phase === 'interact' && !p.redirectedRequestId && (!c.mainFrameId || p.frameId === c.mainFrameId)) {
        rec('navigation'); await send('Fetch.failRequest', { requestId, errorReason: 'Aborted' }); return;
      }
      await send('Fetch.continueRequest', { requestId });
    } catch { /* request already gone */ }
  });
  try { await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }); } catch { /* some worker types have no Fetch */ }
}

// Runs in every document of the page before its scripts. WebSocket handshakes and WebTransport bypass Fetch
// interception entirely, so they are refused at construction; window.open is stubbed (popups are also closed at
// the target level). Attempts are reported through the __rvGuard binding.
const PAGE_GUARD_SRC = (blockSockets) => `(() => {
  const report = (kind, url, method) => { try { const b = globalThis.__rvGuard; if (typeof b === 'function') b(JSON.stringify({ kind, url: String(url).slice(0, 300), method })); } catch {} };
  const lock = (obj, name, value) => { try { Object.defineProperty(obj, name, { value, writable: false, configurable: false }); } catch { try { obj[name] = value; } catch {} } };
  if (${blockSockets}) for (const name of ['WebSocket', 'WebTransport']) {
    const Orig = globalThis[name]; if (typeof Orig !== 'function') continue;
    const Fake = function (url) { report(name === 'WebSocket' ? 'websocket' : 'webtransport', url); throw new DOMException('blocked by review: ' + name, 'SecurityError'); };
    Fake.prototype = Orig.prototype; lock(globalThis, name, Fake);
  }
  if (typeof window !== 'undefined') lock(window, 'open', function (url) { report('popup', url); return null; });
  // Forms are never submitted by the browser: form.submit() is a no-op, the submit event loses its default action
  // (the site's own handlers still run; their fetch/XHR goes through the network guard). Backed up by installInterceptor.
  if (typeof window !== 'undefined' && typeof HTMLFormElement === 'function') {
    const where = (f, s) => { try { const a = (s && s.getAttribute && s.getAttribute('formaction')) || f.getAttribute('action') || ''; return new URL(a, document.baseURI).href; } catch { return String(location.href); } };
    const how = (f, s) => String((s && s.getAttribute && s.getAttribute('formmethod')) || f.getAttribute('method') || 'get').toUpperCase();
    const P = HTMLFormElement.prototype;
    lock(P, 'submit', function () { report('form', where(this), how(this)); });
    addEventListener('submit', e => { const f = e.target; if (!(f instanceof HTMLFormElement)) return; if (how(f, e.submitter) === 'DIALOG') return; e.preventDefault(); report('form', where(f, e.submitter), how(f, e.submitter)); }, true);
  }
})();`;

export class Page {
  constructor(browser, targetId, sessionId, opts = {}) {
    this.b = browser; this.targetId = targetId; this.sessionId = sessionId; this.opts = opts;
    this.inflight = new Map(); this.lastNetActivity = Date.now();
    this.responses = []; this.console = []; this.exceptions = []; this.inducedExceptions = []; this.failed = [];
    this.blocked = { analytics: [], widget: [], write: [], risky: [], navigation: [], blocked: [] };
    this.phase = 'load';        // 'load' while goto() runs, 'interact' afterwards
    this.navTarget = null;
    this.mobile = false;
    this._formNavs = new Map(); // url → time of a form-submission navigation request (Page.frameRequestedNavigation)
    this._docHooks = [];        // interceptDocument() hooks
    this._local = new Map();    // serveLocal() answers
  }

  // Back-compat views
  get blockedWrites() { return this.blocked.write; }
  get navigations() { return this.blocked.navigation; }

  send(method, params = {}, timeoutMs) { return this.b.send(method, params, this.sessionId, timeoutMs); }
  /** fn({url, status, headers, mime, frameId, main}) for every HTML document response of this page (main frame and iframes). */
  onDocumentResponse(fn) {
    return this.on('Network.responseReceived', p => {
      if (p.type !== 'Document') return;
      const r = p.response;
      try { fn({ url: r.url, status: r.status, headers: r.headers, mime: r.mimeType, frameId: p.frameId, main: !this.mainFrameId || p.frameId === this.mainFrameId }); } catch {}
    });
  }
  on(method, cb) { return this.b.on(this.sessionId, method, cb); }

  policy() {
    return {
      phase: this.phase, navTarget: this.navTarget, mainFrameId: this.mainFrameId,
      guardUntil: this.guardUntil || 0, committed: !!this.loadCommitted,
      allowLoadPosts: !!this.opts.allowLoadPosts, allowAnalytics: !!this.opts.allowAnalytics, allowWidgets: !!this.opts.allowWidgets,
      blockNavigation: this.opts.blockNavigation !== false, // ON by default
      extraBlock: (this.opts.blockUrls || []).map(globToRegex),
      record: (kind, item) => this._record(kind, item),
      formNav: url => this._isFormNav(url),
      local: this._local,
      onResponse: this._docHooks.length ? (p, send) => this._onDocResponse(p, send) : null,
    };
  }

  _record(kind, item) { const arr = this.blocked[kind] || (this.blocked[kind] = []); if (arr.length < 500) arr.push(item); }

  // ---- form submissions (see installInterceptor) ----
  // Page.frameRequestedNavigation (reason formSubmissionGet/Post) arrives on the socket before the paused request of
  // the same navigation; the URL is remembered for a few seconds and the request is cut when it shows up.
  _noteNavRequest(p) {
    if (!/^formSubmission/.test(p.reason || '')) return;
    this._formNavs.set(String(p.url).replace(/#.*$/, ''), Date.now());
  }
  async _isFormNav(url) {
    const key = String(url).replace(/#.*$/, '');
    const hit = () => { const t = this._formNavs.get(key); if (t && Date.now() - t < 10000) { this._formNavs.delete(key); return true; } return false; };
    if (hit()) return true;
    // A GET form always produces "?…": give the event a moment in case it is still in flight (never seen, cheap insurance)
    if (!key.includes('?') || key === String(this.navTarget || '').replace(/#.*$/, '')) return false;
    for (let i = 0; i < 3; i++) { await sleep(15); if (hit()) return true; }
    return false;
  }

  /**
   * interceptDocument(fn, { allFrames = false }) — a hook at the Response stage of HTML document requests of this page
   * (main frame by default). The request has already passed the safety net; the hook can only change what the browser
   * receives, never what is sent. fn(doc) gets
   *   { url, status, statusText, headers: [{name,value}], header(name), mime, frameId, main, phase, body(): Promise<Buffer> }
   * and returns nothing (the original response goes on) or a replacement
   *   { body: string|Buffer, status?, headers?: [{name,value}], contentType? }.
   * Default headers are the original ones without Content-Length/-Encoding; a string body is sent as UTF-8
   * (Content-Type becomes "<mime>; charset=utf-8" unless contentType is given). Redirects and failed loads are not shown.
   * The first hook that returns a replacement wins; a hook that throws leaves the original response (error in handle.errors).
   * → handle { off(): Promise, seen, replaced, errors: [] }
   */
  async interceptDocument(fn, { allFrames = false } = {}) {
    const h = { fn, allFrames: !!allFrames, seen: 0, replaced: 0, errors: [], off: async () => {
      const i = this._docHooks.indexOf(h); if (i < 0) return;
      this._docHooks.splice(i, 1); await this._fetchPatterns();
    } };
    this._docHooks.push(h);
    await this._fetchPatterns();
    return h;
  }
  async _fetchPatterns() {
    const patterns = [{ urlPattern: '*', requestStage: 'Request' }];
    if (this._docHooks.length) patterns.push({ urlPattern: '*', resourceType: 'Document', requestStage: 'Response' });
    await this.send('Fetch.enable', { patterns });
  }
  async _onDocResponse(p, send) {
    const { requestId } = p;
    const status = p.responseStatusCode || 0;
    const main = !this.mainFrameId || p.frameId === this.mainFrameId;
    const hooks = this._docHooks.filter(h => main || h.allFrames);
    if (p.responseErrorReason || p.resourceType !== 'Document' || (status >= 300 && status < 400) || !hooks.length) {
      await send('Fetch.continueRequest', { requestId }); return;
    }
    const headers = p.responseHeaders || [];
    const header = n => headers.find(x => x.name.toLowerCase() === String(n).toLowerCase())?.value ?? null;
    const mime = (header('content-type') || '').split(';')[0].trim().toLowerCase();
    let bodyP = null;
    const doc = { url: p.request.url, status, statusText: p.responseStatusText || '', headers, header, mime, frameId: p.frameId, main, phase: this.phase,
      body: () => (bodyP ||= send('Fetch.getResponseBody', { requestId }).then(b => Buffer.from(b.body, b.base64Encoded ? 'base64' : 'utf8'))) };
    for (const h of hooks) {
      h.seen++;
      let r;
      try { r = await h.fn(doc); } catch (e) { if (h.errors.length < 20) h.errors.push(String(e?.message || e).slice(0, 300)); continue; }
      if (!r || r.body === undefined || r.body === null) continue;
      const isStr = typeof r.body === 'string';
      let out = (r.headers || headers).filter(x => !/^(content-length|content-encoding|transfer-encoding)$/i.test(x.name));
      const ct = r.contentType || (isStr ? `${mime || 'text/html'}; charset=utf-8` : null);
      if (ct) out = [...out.filter(x => x.name.toLowerCase() !== 'content-type'), { name: 'Content-Type', value: ct }];
      const body = (isStr ? Buffer.from(r.body, 'utf8') : Buffer.from(r.body)).toString('base64');
      await send('Fetch.fulfillRequest', { requestId, responseCode: r.status || status, responseHeaders: out, body });
      h.replaced++;
      return;
    }
    await send('Fetch.continueRequest', { requestId });
  }

  /**
   * serveLocal(url, { body = '', contentType = 'text/plain; charset=utf-8', status = 200, headers = [] }) — answer this
   * exact URL (any request of this page and its frames) from here; nothing goes to the network. For extra files that a
   * substituted document refers to (probe's stylesheet). → handle { off(), served }
   */
  serveLocal(url, { body = '', contentType = 'text/plain; charset=utf-8', status = 200, headers = [] } = {}) {
    const e = { status, served: 0, body: Buffer.from(body).toString('base64'),
      headers: [...headers.filter(x => x.name.toLowerCase() !== 'content-type'), { name: 'Content-Type', value: contentType }, { name: 'Cache-Control', value: 'no-store' }] };
    this._local.set(String(url), e);
    return { off: () => { if (this._local.get(String(url)) === e) this._local.delete(String(url)); }, get served() { return e.served; } };
  }

  async _init(opts) {
    await Promise.all([
      this.send('Page.enable'), this.send('Runtime.enable'), this.send('Network.enable'),
      this.send('Log.enable').catch(() => {}),
    ]);
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true });
    await this.send('Network.setBypassServiceWorker', { bypass: true }).catch(() => {});
    if (opts.disableCache !== false) await this.send('Network.setCacheDisabled', { cacheDisabled: true });
    try { this.mainFrameId = (await this.send('Page.getFrameTree')).frameTree.frame.id; } catch {}
    this.on('Page.frameNavigated', p => { if (!p.frame.parentId) { this.mainFrameId = p.frame.id; this.loadCommitted = true; this._navSeq = (this._navSeq || 0) + 1; } });
    await installInterceptor(this.b, this.sessionId, () => this.policy());
    const guardSrc = PAGE_GUARD_SRC(opts.allowWebSocket ? 'false' : 'true');
    await this.send('Runtime.addBinding', { name: '__rvGuard' }).catch(() => {});
    this.on('Runtime.bindingCalled', p => this._onGuard(p));
    this.on('Page.frameRequestedNavigation', p => this._noteNavRequest(p));
    // a socket that still got through (e.g. created before the guard) is at least visible
    this.on('Network.webSocketCreated', p => { const arr = this.blocked.websocket_seen || (this.blocked.websocket_seen = []); if (arr.length < 100) arr.push({ url: String(p.url).slice(0, 300), phase: this.phase }); });
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: guardSrc, runImmediately: true }).catch(() => {});
    // children of this page (out-of-process iframes, dedicated workers): same interception
    this.on('Target.attachedToTarget', async (p) => {
      const child = p.sessionId;
      await installInterceptor(this.b, child, () => this.policy());
      // workers and out-of-process frames get the same page-world guard before they run
      const ty = p.targetInfo?.type;
      if (ty === 'iframe') {
        this.b.on(child, 'Page.frameRequestedNavigation', q => this._noteNavRequest(q));
        this.b.on(child, 'Runtime.bindingCalled', q => this._onGuard(q));
        await Promise.all([this.b.send('Page.enable', {}, child), this.b.send('Runtime.addBinding', { name: '__rvGuard' }, child)]).catch(() => {});
        try { await this.b.send('Page.addScriptToEvaluateOnNewDocument', { source: guardSrc, runImmediately: true }, child); } catch {}
      }
      if (ty === 'worker' || ty === 'shared_worker') { try { await this.b.send('Runtime.evaluate', { expression: guardSrc }, child); } catch {} }
      try { await this.b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, child); } catch {}
      try { await this.b.send('Runtime.runIfWaitingForDebugger', {}, child); } catch {}
    });
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }).catch(() => {});
    await this._applyUA(false);
    // Locale and time zone follow the review language (ru-RU, Europe/Moscow by default), not the machine: a phone mask or
    // a currency picked from Intl/navigator would otherwise show the reviewer's region. The IP (VPN) cannot be changed here.
    this.locale = this.opts.locale || localeOf(this.opts.acceptLanguage);
    this.timezone = this.opts.timezone !== undefined ? this.opts.timezone : (/^ru(-|$)/i.test(this.locale) ? 'Europe/Moscow' : null);
    await this.send('Emulation.setLocaleOverride', { locale: this.locale }).catch(() => {});
    if (this.timezone) await this.send('Emulation.setTimezoneOverride', { timezoneId: this.timezone }).catch(() => {});
    // Results must not depend on the OS theme of the machine: light scheme unless asked otherwise.
    this.defaultColorScheme = opts.colorScheme === 'system' ? null : (opts.colorScheme || 'light');
    await this.emulateMedia({}).catch(() => {});
    await this.send('Emulation.setAutoDarkModeOverride', { enabled: false }).catch(() => {});

    this.on('Network.requestWillBeSent', p => { this.inflight.set(p.requestId, p.request.url); this.lastNetActivity = Date.now(); });
    const done = p => { this.inflight.delete(p.requestId); this.lastNetActivity = Date.now(); };
    this.on('Network.loadingFinished', done);
    this.on('Network.loadingFailed', p => { const url = this.inflight.get(p.requestId); done(p); if (url) this.failed.push({ url, error: p.errorText, blocked: p.blockedReason || null }); });
    this.on('Network.responseReceived', p => {
      const r = p.response;
      this.responses.push({ url: r.url, status: r.status, type: p.type, mime: r.mimeType, protocol: r.protocol,
        remoteIP: r.remoteIPAddress, fromCache: r.fromDiskCache, encodedLength: r.encodedDataLength, headers: r.headers, security: r.securityState });
    });
    this.on('Runtime.consoleAPICalled', p => { if (['error', 'warning', 'assert'].includes(p.type)) this.console.push({ type: p.type, text: (p.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 500) }); });
    // Errors that our own safety net provoked (cut POST/beacon/fetch) are not the site's bugs: keep them apart.
    this.on('Runtime.exceptionThrown', p => {
      const text = (p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '').slice(0, 800);
      const cut = ['write', 'risky', 'interact', 'private', 'analytics', 'widget', 'blocked', 'websocket', 'popup'].some(k => this.blocked[k]?.length);
      if (cut && INDUCED_RE.test(text)) this.inducedExceptions.push(text); else this.exceptions.push(text);
    });
    this.on('Log.entryAdded', p => { if (p.entry?.level === 'error') this.console.push({ type: 'log-error', text: (p.entry.text + ' ' + (p.entry.url || '')).slice(0, 500) }); });
  }

  // reports of the page-world guard (PAGE_GUARD_SRC) of this page and its out-of-process frames
  _onGuard(p) {
    if (p.name !== '__rvGuard') return;
    let m; try { m = JSON.parse(p.payload); } catch { return; }
    const url = String(m.url || '').slice(0, 300);
    if (m.kind === 'form') { // a submission stopped inside the page: GET → navigation, POST → write (same split as installInterceptor)
      const method = String(m.method || 'GET').toUpperCase();
      this._record(method === 'GET' ? 'navigation' : 'write', { method, url, type: 'Document', phase: this.phase, reason: 'form', via: 'page' });
      return;
    }
    this._record(m.kind === 'popup' ? 'popup' : 'websocket', { url, type: m.kind, phase: this.phase });
  }

  async _applyUA(mobile) {
    this.mobile = mobile;
    const ua = this.opts.userAgent ? { userAgent: this.opts.userAgent } : uaFor(this.b.version, mobile);
    await this.send('Network.setUserAgentOverride', { ...ua, acceptLanguage: this.opts.acceptLanguage || 'ru-RU,ru;q=0.9,en;q=0.8' }).catch(() => {});
    await this.send('Emulation.setUserAgentOverride', { ...ua, acceptLanguage: this.opts.acceptLanguage || 'ru-RU,ru;q=0.9,en;q=0.8' }).catch(() => {});
  }

  async setViewport({ width, height, mobile = false, deviceScaleFactor = mobile ? 2 : 1, touch = mobile } = {}) {
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile, screenWidth: width, screenHeight: height });
    await this.send('Emulation.setTouchEmulationEnabled', touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
    if (mobile !== this.mobile) await this._applyUA(mobile);
  }

  async emulateMedia({ colorScheme, reducedMotion, forcedColors, contrast, printMedia } = {}) {
    const features = [];
    colorScheme = colorScheme || this.defaultColorScheme;
    if (colorScheme) features.push({ name: 'prefers-color-scheme', value: colorScheme });
    if (reducedMotion) features.push({ name: 'prefers-reduced-motion', value: reducedMotion });
    if (forcedColors) features.push({ name: 'forced-colors', value: forcedColors });
    if (contrast) features.push({ name: 'prefers-contrast', value: contrast });
    await this.send('Emulation.setEmulatedMedia', { media: printMedia ? 'print' : '', features });
  }

  async emulateVision(type) { // none | protanopia | deuteranopia | tritanopia | achromatopsia | blurredVision | reducedContrast
    await this.send('Emulation.setEmulatedVisionDeficiency', { type });
  }

  setPhase(phase) { this.phase = phase; }

  /**
   * goto(url) → { ok, status, finalUrl, ms, timedOut, error?, refused? }
   * Refuses risky GET URLs and private-network hosts (unless allowed via util.allowPrivateHost / opts.allowRisky).
   */
  async goto(url, { timeout = 45000, idleMs = 800, waitUntil = 'networkidle', allowRisky = false } = {}) {
    if (!allowRisky && isRiskyGet(url)) return { ok: false, refused: 'risky', error: 'risky GET url refused', ms: 0 };
    const h = hostOf(url);
    if (!isAllowedPrivate(h) && await resolvesPrivate(h)) return { ok: false, refused: 'private', error: 'private network address refused', ms: 0 };
    this.responses = []; this.failed = []; this.inflight.clear();
    this.phase = 'load'; this.navTarget = url; this.loadCommitted = false; this.guardUntil = 0;
    try { return await this._goto(url, { timeout, idleMs, waitUntil }); }
    finally { this.phase = 'interact'; this.navTarget = null; }
  }

  async _goto(url, { timeout, idleMs, waitUntil }) {
    const started = Date.now();
    let loaded = false, dcl = false;
    const offLoad = this.on('Page.loadEventFired', () => { loaded = true; });
    const offDcl = this.on('Page.domContentEventFired', () => { dcl = true; });
    let nav;
    try { nav = await this.send('Page.navigate', { url }, timeout); }
    catch (e) { offLoad(); offDcl(); return { ok: false, error: e.message, ms: Date.now() - started }; }
    if (nav.errorText) { offLoad(); offDcl(); return { ok: false, error: nav.errorText, ms: Date.now() - started }; }
    while (Date.now() - started < timeout) {
      if (waitUntil === 'domcontentloaded' && dcl) break;
      if (loaded && (waitUntil === 'load' || (this.inflight.size <= 1 && Date.now() - this.lastNetActivity > idleMs))) break;
      await sleep(100);
    }
    offLoad(); offDcl();
    const doc = this.responses.find(r => r.type === 'Document');
    return { ok: true, timedOut: !loaded, ms: Date.now() - started, status: doc?.status ?? null, finalUrl: await this.evaluate('location.href').catch(() => url) };
  }

  async evaluate(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})` : fnOrExpr;
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: false });
    if (r.exceptionDetails) throw new Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }

  // Isolated world: same DOM, separate JS globals. The site can't replace DOMParser, axe, Array.prototype etc. here,
  // so measurements and parsing can't be spoofed by page scripts. Re-created after every navigation.
  async isolatedContextId() {
    if (this._iso && this._iso.frame === this.mainFrameId && this._iso.seq === this._navSeq) return this._iso.id;
    let frameId = this.mainFrameId;
    if (!frameId) frameId = (await this.send('Page.getFrameTree')).frameTree.frame.id;
    const { executionContextId } = await this.send('Page.createIsolatedWorld', { frameId, worldName: 'revizor', grantUniveralAccess: false });
    this._iso = { id: executionContextId, frame: frameId, seq: this._navSeq };
    return executionContextId;
  }

  async evaluateIsolated(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})` : fnOrExpr;
    let contextId = await this.isolatedContextId();
    let r;
    try { r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, contextId }); }
    catch (e) { // context gone (navigation in between) — recreate once
      this._iso = null; contextId = await this.isolatedContextId();
      r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, contextId });
    }
    if (r.exceptionDetails) throw new Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }

  // Run a script before any page script on every navigation (e.g. performance observers).
  async addInitScript(source) { return this.send('Page.addScriptToEvaluateOnNewDocument', { source }); }

  async screenshot({ path, fullPage = false, maxHeight = 16000, clip, format = 'png', quality } = {}) {
    const params = { format, captureBeyondViewport: !!(fullPage || clip), fromSurface: true };
    if (quality && format !== 'png') params.quality = quality;
    if (clip) params.clip = { scale: 1, ...clip };
    else if (fullPage) {
      const m = await this.send('Page.getLayoutMetrics');
      const cs = m.cssContentSize || m.contentSize;
      params.clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.min(Math.ceil(cs.height), maxHeight), scale: 1 };
    }
    const { data } = await this.send('Page.captureScreenshot', params, 90000);
    const buf = Buffer.from(data, 'base64');
    if (path) writeFileSync(path, buf);
    return buf;
  }

  async pdf({ path, landscape = false, printBackground = true, preferCSSPageSize = true } = {}) {
    const { data } = await this.send('Page.printToPDF', { landscape, printBackground, preferCSSPageSize }, 120000);
    const buf = Buffer.from(data, 'base64');
    if (path) writeFileSync(path, buf);
    return buf;
  }

  /** What is under (x, y): tag, role, text, link/submit/iframe flags, contact-form flag. */
  async hitInfo(x, y, focused = false) {
    // isolated world: the page can't fake what is under the point
    return this.evaluateIsolated((x, y, focused) => {
      const el = focused ? (document.activeElement && document.activeElement !== document.body ? document.activeElement : null) : document.elementFromPoint(x, y);
      if (!el) return { none: true };
      const btn = el.closest('button, input, a, [role="button"], [role="link"], summary, label, select, textarea');
      const t = btn || el;
      // t.form also covers <button form="id"> placed outside the form
      const form = (t.form instanceof HTMLFormElement ? t.form : null) || t.closest('form');
      const type = (t.getAttribute('type') || '').toLowerCase();
      const isSubmit = (t.tagName === 'BUTTON' && (type === 'submit' || (!type && !!form))) || (t.tagName === 'INPUT' && ['submit', 'image'].includes(type));
      // "accept cookies / agree" buttons in a consent banner are never pressed
      const label = (t.innerText || t.value || t.getAttribute('aria-label') || '').trim().toLowerCase();
      let consentCtx = /cookie|куки|файл[ыа]? cookie/.test(label);
      for (let n = t, k = 0; n && k < 6 && !consentCtx; n = n.parentElement, k++) {
        const sig = ((n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : '') + ' ' + (n.getAttribute?.('aria-label') || '')).toLowerCase();
        consentCtx = /cookie|consent|gdpr|cmp|privacy-banner|согласи/.test(sig);
      }
      const isConsentAccept = consentCtx && /^(принять|принимаю|согласен|согласна|соглашаюсь|разрешить|ok|ок|хорошо|понятно|accept|agree|allow|got it|i agree|yes)/.test(label);
      const a = t.closest('a[href]');
      const CONTACT = 'input[type=tel], input[type=email], input[name*=phone i], input[name*=tel i], input[name*=mail i], input[name*=name i], textarea';
      const contact = !!form && !!form.querySelector(CONTACT);
      // "formless form": a visible contact input in the same block (up to 4 ancestors) — the button there is a send button.
      // Hidden inputs (the form of a closed popup in the same wrapper) count only for buttons that read as "send":
      // otherwise the button that opens the popup would be refused too.
      const sendLike = /отправ|перезвон|жду звонка|submit|send\b/.test(label);
      const shown = f => { const r = f.getBoundingClientRect(); const cs = getComputedStyle(f); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05; };
      let nearContact = false;
      // a wrapper counts only while it is a small block (≤ 10 controls): a page-wide wrapper with a newsletter field
      // somewhere would otherwise refuse every toggle on the page
      const CONTROLS = 'button, a[href], input, select, textarea, [role="button"], summary';
      // fields of some other <form> are that form's business (contactForm covers buttons inside it);
      // never climb into page-level containers
      for (let n = t.parentElement, k = 0; n && k < 4 && !nearContact; n = n.parentElement, k++) {
        if (n === document.body || /^(MAIN|ARTICLE|BODY|HTML)$/.test(n.tagName) || n.querySelectorAll(CONTROLS).length > 10) break;
        nearContact = [...n.querySelectorAll(CONTACT)].some(f => !(f.form && f.form !== form) && (sendLike || shown(f)));
      }
      const isControl = ['BUTTON', 'A', 'INPUT', 'SUMMARY', 'LABEL'].includes(t.tagName) || /^(button|link)$/.test(t.getAttribute('role') || '');
      return { tag: el.tagName, targetTag: t.tagName, role: t.getAttribute('role'), text: (t.innerText || t.value || t.getAttribute('aria-label') || '').trim().slice(0, 80),
        isIframe: el.tagName === 'IFRAME' || el.tagName === 'FRAME', isSubmit, isLink: !!a, href: a ? a.href : null, inForm: !!form, contactForm: contact,
        nearContact, isControl, isConsentAccept, isField: ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName) && !['submit', 'image', 'button'].includes(type),
        expanded: t.getAttribute('aria-expanded') };
    }, x, y, focused);
  }

  _refusal(info, { allowLink = false, allowIframe = false } = {}) {
    if (!info || info.none) return 'nothing';
    if (info.isIframe && !allowIframe) return 'iframe';
    if (info.isSubmit) return 'submit';
    if (info.isConsentAccept) return 'consent-accept';
    // tel:/mailto:/sms: and messenger app links hand off to another app — never pressed
    if (info.href && /^(tel|mailto|sms|callto|skype|viber|whatsapp|tg|intent):/i.test(info.href)) return 'contact-link';
    // buttons and links inside a contact form, or next to contact inputs without a <form>, can send a lead — never press them
    if ((info.contactForm || info.nearContact) && info.isControl && !info.isField) return 'contact-form';
    if (info.isLink && !allowLink && !(this.opts.blockNavigation !== false)) return 'link';
    return null;
  }

  // Real input — never element.click(): it fires even under invisible overlays.
  // Returns { ok, info } or { refused, info }. Submit buttons and iframes are never touched.
  // Opens the interaction guard (see installInterceptor): background requests / requests with parameters are cut.
  guard(ms = this.opts.interactGuardMs ?? 3000) { this.guardUntil = Math.max(this.guardUntil || 0, Date.now() + ms); }

  async tap(x, y, guard = {}) {
    const info = await this.hitInfo(x, y).catch(() => null);
    const refused = this._refusal(info, guard);
    if (refused) return { refused, info };
    this.guard();
    const tp = [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp });
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return { ok: true, info };
  }

  async click(x, y, guard = {}) {
    const info = await this.hitInfo(x, y).catch(() => null);
    const refused = this._refusal(info, guard);
    if (refused) return { refused, info };
    this.guard();
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    return { ok: true, info };
  }

  async hover(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }

  // Enter/Space on a focused element is a press: same refusals as tap/click. Enter in a field inside a form is an
  // implicit submit — refused too. Tab, arrows, Escape are not presses. Returns { ok, info } or { refused, info }.
  async key(key, code = key, keyCode) {
    let info = null;
    if (/^(Enter|NumpadEnter| |Space|Spacebar)$/.test(key) || /^(Enter|NumpadEnter|Space)$/.test(code)) {
      info = await this.hitInfo(0, 0, true).catch(() => null);
      if (info && !info.none) {
        const isEnter = /Enter/.test(key) || /Enter/.test(code);
        const refused = (isEnter && info.isField && info.inForm) ? 'submit'
          : (info.isField ? null : this._refusal(info, { allowLink: false }));
        if (refused) return { refused, info };
      }
    }
    this.guard();
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
    return { ok: true, info };
  }

  async scrollThrough({ step = 600, pause = 120, max = 30000 } = {}) {
    // trigger lazy-loading and scroll-driven reveals, then return to top
    await this.evaluate(async (step, pause, max) => {
      const h = () => Math.min(document.documentElement.scrollHeight, max);
      for (let y = 0; y < h(); y += step) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, pause)); }
      window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 300));
    }, step, pause, max);
  }

  async close() { try { await this.b.send('Target.closeTarget', { targetId: this.targetId }); } catch {} }
}

// Run fn(browser) and always clean up.
export async function withBrowser(fn, opts) {
  const b = await Browser.launch(opts);
  try { return await fn(b); } finally { await b.close(); }
}

/** Browser locale for an Accept-Language value: its first language tag (ru-RU when none). */
export function localeOf(acceptLanguage) {
  const first = String(acceptLanguage || '').split(',')[0].split(';')[0].trim();
  if (!first) return 'ru-RU';
  return /^[a-z]{2,3}$/i.test(first) ? ({ ru: 'ru-RU', en: 'en-US' }[first.toLowerCase()] || first) : first;
}
