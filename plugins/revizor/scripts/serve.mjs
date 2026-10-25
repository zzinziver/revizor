#!/usr/bin/env node
// Revizor — tiny static server for the demo site and selftest.
// Binds 127.0.0.1 only. Logs every request as a JSON line. Never accepts writes: non-GET/HEAD/OPTIONS → 405 (logged,
// so selftest can prove "POST = 0"). <root>/server.json adds "bad" headers on purpose (cookie without flags,
// X-Powered-By, …) so header checks have something to find; the answer files of the demo are never served.

import http from 'node:http';
import { createReadStream, existsSync, statSync, readFileSync, appendFileSync, realpathSync, readdirSync } from 'node:fs';
import { join, resolve, extname, relative, isAbsolute, dirname, basename } from 'node:path';
import * as U from './lib/util.mjs';

const HELP = `
serve.mjs — статический сервер для демо-сайта и самопроверки (слушает только 127.0.0.1)

  node serve.mjs --root "<папка сайта>" [--port 0] [--log "<журнал.jsonl>" | --run "<RUN>"] [--config "<server.json>"]
                 [--ttl 10800] [--quiet] [--lang ru|en]
  node serve.mjs --stats "<журнал.jsonl>" [--fail-on-writes]   сводка по журналу: запросы, методы, не-GET (для selftest и CI);
                                                              с --fail-on-writes код 1, если не-GET > 0

  --port 0     свободный порт (по умолчанию). Первая строка stdout: SERVE http://127.0.0.1:<порт>/
  --log        журнал запросов, по строке JSON: { t, port, method, path, status, bytes, ms, ua, ref, range, body_bytes };
               плюс служебные строки { event: "start"|"stop", … } без method — при подсчёте запросов их пропускать;
               с --run без --log журнал пишется в RUN/serve/requests-<порт>.jsonl (с --run путь --log — только внутри RUN)
  --config     правила «плохих» ответов; по умолчанию <root>/server.json (если есть)
  --ttl N      выключиться через N секунд (по умолчанию 10800 = 3 ч; 0 — не выключаться). --budget-sec — то же самое
  --quiet      не печатать запросы в stderr

server.json (все поля необязательны; ключи путей — точный путь или шаблон со *, "*" — все):
  { "headers":   { "*": { "X-Powered-By": "PHP/5.4.45" }, "/menu.html": { "Cache-Control": "no-store" } },
    "cookies":   { "*": ["PHPSESSID=demo; Path=/"] },                 ← Set-Cookie как есть (без Secure/HttpOnly/SameSite)
    "redirects": { "/old-menu/": { "to": "/menu.html", "status": 301 } },
    "status":    { "/gone.html": 410 },
    "delay_ms":  { "/img/hero.jpg": 800 },
    "soft_404":  true,                                                ← на несуществующий адрес 200 и страница 404
    "not_found_page": "404.html",
    "hide":      ["notes/*"] }                                       ← не отдавать (всегда скрыты: server.json, EXPECTED.md,
                                                                        expected.json, brief.json, *.jsonl, файлы с точки)
Адрес без расширения отдаёт <путь>.html, если такой файл есть; папка — её index.html.
Не-GET (POST, PUT…) не принимаются: ответ 405, запись в журнале. Каталоги не листаются, выход за --root запрещён.
Коды: 0 — остановлен (ttl, Ctrl+C), 2 — ошибка аргументов, 1 — сбой (и --stats --fail-on-writes при записях).
`;

const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'quiet', 'fail-on-writes'] });
U.helpAndExit(HELP, args);
const lang = U.langOf(args);
const T = (ru, en) => (lang === 'en' ? en : ru);

// ---------- --stats: read a journal ----------
if (args.stats) {
  const p = resolve(String(args.stats));
  if (!existsSync(p)) { console.error(T(`Журнал не найден: ${p}`, `Log not found: ${p}`)); process.exit(2); }
  const st = { requests: 0, by_method: {}, by_status: {}, writes: 0, write_paths: [], paths: {} };
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.event) continue;
    st.requests++;
    st.by_method[e.method] = (st.by_method[e.method] || 0) + 1;
    st.by_status[e.status] = (st.by_status[e.status] || 0) + 1;
    st.paths[e.path] = (st.paths[e.path] || 0) + 1;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(e.method)) { st.writes++; if (st.write_paths.length < 20) st.write_paths.push(`${e.method} ${e.path}`); }
  }
  const top = Object.entries(st.paths).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const lines = [
    T(`Журнал: ${p}`, `Log: ${p}`),
    T(`Запросов: ${st.requests} · методы: ${Object.entries(st.by_method).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`, `Requests: ${st.requests} · methods: ${Object.entries(st.by_method).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}`),
    T(`Не-GET (должно быть 0): ${st.writes}${st.write_paths.length ? ' — ' + st.write_paths.join('; ') : ''}`, `Non-GET (must be 0): ${st.writes}${st.write_paths.length ? ' — ' + st.write_paths.join('; ') : ''}`),
    T(`Коды: ${Object.entries(st.by_status).map(([k, v]) => `${k} ${v}`).join(', ')}`, `Statuses: ${Object.entries(st.by_status).map(([k, v]) => `${k} ${v}`).join(', ')}`),
    ...top.map(([k, v]) => `  ${String(v).padStart(4)}  ${k.slice(0, 100)}`),
    'JSON ' + JSON.stringify({ requests: st.requests, writes: st.writes, by_method: st.by_method, by_status: st.by_status }),
  ];
  U.printSummary(lines);
  process.exit(args['fail-on-writes'] && st.writes > 0 ? 1 : 0);
}

// ---------- arguments ----------
if (!args.root || args.root === true) { console.error(T('Нужен --root "<папка сайта>".', 'Missing --root "<site folder>".')); process.exit(2); }
const ROOT = resolve(String(args.root));
if (!existsSync(ROOT) || !statSync(ROOT).isDirectory()) { console.error(T(`Папка не найдена: ${ROOT}`, `Folder not found: ${ROOT}`)); process.exit(2); }
const ROOT_REAL = realpathSync(ROOT);
const portArg = args.port === undefined || args.port === true ? 0 : Number(args.port);
if (!Number.isInteger(portArg) || portArg < 0 || portArg > 65535) { console.error(T('--port: число 0–65535.', '--port: a number 0–65535.')); process.exit(2); }
const ttlRaw = args.ttl ?? args['budget-sec'];
const ttl = ttlRaw === undefined || ttlRaw === true ? 10800 : Number(ttlRaw);
if (!Number.isFinite(ttl) || ttl < 0) { console.error(T('--ttl: число секунд.', '--ttl: seconds.')); process.exit(2); }
const run = args.run && args.run !== true ? resolve(String(args.run)) : null;
if (run && args.log && args.log !== true) {
  try { U.insideRun(run, relative(run, resolve(String(args.log)))); }
  catch { console.error(T('С --run журнал пишется только внутри RUN: уберите --log или укажите путь в RUN.', 'With --run the log must be inside RUN: drop --log or point it inside RUN.')); process.exit(2); }
}

let config = {};
const cfgPath = args.config && args.config !== true ? resolve(String(args.config)) : join(ROOT, 'server.json');
if (existsSync(cfgPath)) {
  try { config = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^﻿/, '')) || {}; }
  catch (e) { console.error(T(`server.json не читается: ${e.message}`, `server.json is not valid JSON: ${e.message}`)); process.exit(2); }
} else if (args.config && args.config !== true) { console.error(T(`Нет файла ${cfgPath}`, `No file ${cfgPath}`)); process.exit(2); }

// path pattern: exact path or glob with * ; "*" = every path
const globRe = g => new RegExp('^' + String(g).split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
const rulesOf = obj => Object.entries(obj && typeof obj === 'object' ? obj : {}).map(([k, v]) => ({ re: k === '*' ? /.*/ : globRe(k), key: k, v }));
const R = {
  headers: rulesOf(config.headers), cookies: rulesOf(config.cookies), redirects: rulesOf(config.redirects),
  status: rulesOf(config.status), delay: rulesOf(config.delay_ms),
};
const ALWAYS_HIDDEN = ['server.json', 'EXPECTED.md', 'expected.json', 'brief.json', '*.jsonl'];
const hidden = [...ALWAYS_HIDDEN, ...(Array.isArray(config.hide) ? config.hide : [])].map(globRe);
const notFoundPage = typeof config.not_found_page === 'string' ? config.not_found_page : '404.html';
const soft404 = !!config.soft_404;
const match = (rules, path) => rules.filter(r => r.re.test(path));

const MIME = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.xml': 'application/xml',
  '.txt': 'text/plain', '.md': 'text/plain', '.csv': 'text/csv', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.pdf': 'application/pdf', '.zip': 'application/zip',
};
const TEXTY = /^(text\/|application\/(json|xml|manifest\+json|javascript)|image\/svg\+xml)/;

// ---------- journal ----------
let logPath = null;
function setupLog(port) {
  if (args.log && args.log !== true) {
    logPath = resolve(String(args.log));
    if (run) logPath = U.insideRun(run, relative(run, logPath)); // with --run the journal stays inside RUN
  } else if (run) logPath = U.insideRun(run, 'serve', `requests-${port}.jsonl`);
  if (logPath) U.ensureDir(dirname(logPath));
}
let count = 0, writes = 0;
function journal(entry) {
  count++;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(entry.method)) writes++;
  if (logPath) { try { appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* journal is best effort */ } }
  if (!args.quiet) process.stderr.write(`${entry.method} ${entry.path} → ${entry.status}${entry.bytes ? ` ${entry.bytes} B` : ''}\n`);
}

// ---------- file lookup ----------
function safeFile(urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath); } catch { return null; }
  if (p.includes('\0')) return null;
  const abs = resolve(ROOT, '.' + (p.startsWith('/') ? p : '/' + p));
  const rel = relative(ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/).filter(Boolean);
  if (parts.some(x => x.startsWith('.'))) return null;                      // dotfiles, .git
  const relFwd = parts.join('/');
  if (hidden.some(re => re.test(relFwd) || re.test(basename(relFwd)))) return null;
  return abs;
}
function resolveTarget(urlPath) {
  const abs = safeFile(urlPath);
  if (!abs) return { kind: 'missing' };
  const real = p => { try { const r = realpathSync(p); const rel = relative(ROOT_REAL, r); return rel.startsWith('..') || isAbsolute(rel) ? null : r; } catch { return null; } };
  if (existsSync(abs)) {
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (!urlPath.endsWith('/')) return { kind: 'slash' };
      const idx = join(abs, 'index.html');
      if (existsSync(idx) && real(idx)) return { kind: 'file', file: real(idx) };
      return { kind: 'missing' };
    }
    const r = real(abs);
    return r ? { kind: 'file', file: r } : { kind: 'missing' };
  }
  if (!extname(abs)) { // clean URL → .html
    const alt = abs.replace(/[\\/]+$/, '') + '.html';
    const r = existsSync(alt) ? real(alt) : null;
    if (r && !hidden.some(re => re.test(basename(alt)))) return { kind: 'file', file: r };
  }
  return { kind: 'missing' };
}

// ---------- server ----------
function baseHeaders(path) {
  const h = {};
  for (const r of match(R.headers, path)) Object.assign(h, r.v || {});
  const cookies = match(R.cookies, path).flatMap(r => (Array.isArray(r.v) ? r.v : [r.v])).filter(Boolean).map(String);
  if (cookies.length) h['Set-Cookie'] = cookies;
  return h;
}
const sleepMs = ms => new Promise(r => setTimeout(r, ms));

const server = http.createServer(async (req, res) => {
  const t0 = Date.now();
  const method = String(req.method || 'GET').toUpperCase();
  let path = '/';
  try { path = new URL(req.url || '/', 'http://127.0.0.1').pathname; } catch { /* keep "/" */ }
  const entry = { t: new Date().toISOString(), port: server.address()?.port, method, path: String(req.url || '/').slice(0, 500), status: 0, bytes: 0, ms: 0,
    ua: String(req.headers['user-agent'] || '').slice(0, 160), ref: req.headers.referer ? String(req.headers.referer).slice(0, 300) : undefined,
    range: req.headers.range || undefined };
  const finish = (status, bytes = 0) => { entry.status = status; entry.bytes = bytes; entry.ms = Date.now() - t0; journal(entry); };
  try {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      // writes are never accepted: read (and drop) at most 1 MB of the body, answer 405
      let n = 0;
      await new Promise(r => { req.on('data', d => { n += d.length; if (n > 1024 * 1024) req.destroy(); }); req.on('end', r); req.on('close', r); req.on('error', r); });
      entry.body_bytes = n;
      res.writeHead(405, { Allow: 'GET, HEAD, OPTIONS', 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('405 Method Not Allowed\n');
      return finish(405, 24);
    }
    if (method === 'OPTIONS') { res.writeHead(204, { Allow: 'GET, HEAD, OPTIONS' }); res.end(); return finish(204); }
    for (const d of match(R.delay, path)) { const ms = Math.min(30000, Number(d.v) || 0); if (ms > 0) await sleepMs(ms); }
    const redir = match(R.redirects, path)[0];
    if (redir) {
      const to = typeof redir.v === 'string' ? redir.v : redir.v?.to;
      const code = Number(redir.v?.status) || 301;
      res.writeHead(code, { ...baseHeaders(path), Location: to || '/' });
      res.end();
      return finish(code);
    }
    const forced = match(R.status, path)[0];
    const target = resolveTarget(path);
    if (target.kind === 'slash') { res.writeHead(301, { ...baseHeaders(path), Location: path + '/' }); res.end(); return finish(301); }
    let file = target.kind === 'file' ? target.file : null;
    let status = forced ? Number(forced.v) || 200 : 200;
    if (!file) {
      const nf = resolveTarget('/' + notFoundPage);
      status = forced ? status : (soft404 ? 200 : 404);
      if (nf.kind === 'file') file = nf.file;
      else {
        const body = Buffer.from(status === 404 ? '404 Not Found\n' : 'Not Found\n', 'utf8');
        res.writeHead(status, { ...baseHeaders(path), 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': body.length });
        res.end(method === 'HEAD' ? undefined : body);
        return finish(status, method === 'HEAD' ? 0 : body.length);
      }
    }
    const st = statSync(file);
    let type = MIME[extname(file).toLowerCase()] || 'application/octet-stream';
    if (TEXTY.test(type)) type += '; charset=utf-8';
    const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString(), ...baseHeaders(path) };
    let start = 0, end = st.size - 1;
    const m = status === 200 && typeof req.headers.range === 'string' ? req.headers.range.match(/^bytes=(\d*)-(\d*)$/) : null;
    if (m && (m[1] || m[2])) {
      if (m[1]) { start = Number(m[1]); end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1; }
      else { start = Math.max(0, st.size - Number(m[2])); }
      if (start > end || start >= st.size) {
        res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` }); res.end(); return finish(416);
      }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    const len = st.size === 0 ? 0 : end - start + 1;
    headers['Content-Length'] = len;
    res.writeHead(status, headers);
    if (method === 'HEAD' || len === 0) { res.end(); return finish(status, 0); }
    createReadStream(file, { start, end }).on('error', () => res.destroy()).pipe(res);
    res.on('finish', () => finish(status, len));
    res.on('close', () => { if (!entry.status) finish(status, 0); });
  } catch (e) {
    try { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('500\n'); } catch { /* socket gone */ }
    entry.error = String(e?.message || e).slice(0, 200);
    finish(500);
  }
});

function stop(code = 0, why = '') {
  const line = T(`SERVE STOPPED${why ? ' (' + why + ')' : ''} · запросов ${count} · не-GET ${writes}${logPath ? ' · журнал ' + logPath : ''}`,
    `SERVE STOPPED${why ? ' (' + why + ')' : ''} · requests ${count} · non-GET ${writes}${logPath ? ' · log ' + logPath : ''}`);
  process.stdout.write(line + '\n');
  if (logPath) { try { appendFileSync(logPath, JSON.stringify({ event: 'stop', t: new Date().toISOString(), requests: count, writes }) + '\n'); } catch {} }
  server.close();
  setTimeout(() => process.exit(code), 200).unref();
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) { try { process.on(sig, () => stop(0, sig)); } catch { /* not on this OS */ } }

server.on('error', e => { console.error(T(`Сервер не запустился: ${e.message}`, `Server failed: ${e.message}`)); process.exit(e.code === 'EADDRINUSE' || e.code === 'EACCES' ? 2 : 1); });
server.listen(portArg, '127.0.0.1', () => {
  const port = server.address().port;
  setupLog(port);
  const files = (() => { try { return readdirSync(ROOT).length; } catch { return 0; } })();
  process.stdout.write(`SERVE http://127.0.0.1:${port}/\n`);
  process.stdout.write(T(`Папка: ${ROOT} (${files} элементов) · правила: ${existsSync(cfgPath) ? cfgPath : 'нет server.json'} · журнал: ${logPath || 'только stderr'}${ttl ? ` · выключусь через ${ttl} с` : ''}\n`,
    `Root: ${ROOT} (${files} entries) · rules: ${existsSync(cfgPath) ? cfgPath : 'no server.json'} · log: ${logPath || 'stderr only'}${ttl ? ` · stops in ${ttl}s` : ''}\n`));
  if (logPath) { try { appendFileSync(logPath, JSON.stringify({ event: 'start', t: new Date().toISOString(), port, root: ROOT }) + '\n'); } catch {} }
  if (ttl > 0) setTimeout(() => stop(0, 'ttl'), ttl * 1000); // the listening server keeps the process alive until then
});
