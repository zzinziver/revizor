#!/usr/bin/env node
// Revizor — open a report file or a folder with the system handler (no shell: paths with spaces and Cyrillic are safe).
//   node open.mjs "<file|folder>" ["<file|folder>" …]
// What may open in the person's own browser or apps (outside the safety net of lib/cdp.mjs):
//   · folders;
//   · files inside <RUN>/report/ (our reports: html without site scripts, xlsx, pdf, images, zip);
//   · raster images anywhere inside a RUN (crops and shots: no code in them).
// Never: snapshot/*/raw.html and dom.html (the site's own HTML and scripts), .svg (can carry scripts), files outside a RUN, programs.

import { existsSync, statSync, realpathSync } from 'node:fs';
import { resolve, extname, dirname, join, relative, isAbsolute, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as U from './lib/util.mjs';

const REPORT_EXT = new Set(['.html', '.htm', '.xlsx', '.pdf', '.csv', '.md', '.txt', '.json', '.jpg', '.jpeg', '.png', '.webp', '.zip']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const NEVER = new Set(['raw.html', 'dom.html']);

const HELP = `
open.mjs — открыть отчёт или папку программой по умолчанию.
  node open.mjs "<файл|папка>" ["<файл|папка>" …] [--dry-run] [--lang ru|en]
  --dry-run — только напечатать, чем было бы открыто (для проверок)
Открывает: папки; файлы из <RUN>/report/ (${[...REPORT_EXT].join(' ')}); картинки ${[...IMAGE_EXT].join(' ')} внутри папки прогона.
Не открывает: raw.html и dom.html снимка (HTML и скрипты сайта), .svg, файлы вне папки прогона, программы.
Без графического окружения (сервер, CI) печатает путь.
Коды: 0 — открыто (или напечатан путь), 2 — нет такого пути или файл открывать нельзя.
`;

function hasDisplay() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}
const inside = (parent, child) => { const r = relative(parent, child); return !!r && !r.startsWith('..') && !isAbsolute(r); };
/** Nearest folder up from a file that holds state.json (a RUN). */
function runOf(file) {
  for (let d = dirname(file); ; d = dirname(d)) {
    if (existsSync(join(d, 'state.json'))) return d;
    if (dirname(d) === d) return null;
  }
}
/** → null (allowed) or the reason of a refusal: 'type' | 'site_html' | 'outside_run' */
export function refusal(abs) {
  const ext = extname(abs).toLowerCase();
  const name = basename(abs).toLowerCase();
  if (NEVER.has(name)) return 'site_html';
  if (!REPORT_EXT.has(ext)) return 'type';
  const run = runOf(abs);
  if (!run) return 'outside_run';
  if (inside(join(run, 'report'), abs)) return null;
  if (IMAGE_EXT.has(ext)) return null; // a crop or a shot of the run
  return ext === '.html' || ext === '.htm' ? 'site_html' : 'outside_run';
}

/** Open one path. → { ok, path, how?, refused?, error? } */
export function openPath(p, { dryRun = false } = {}) {
  let abs = resolve(String(p));
  if (!existsSync(abs)) return { ok: false, path: abs, error: 'not_found' };
  try { abs = realpathSync(abs); } catch { /* keep */ } // a link inside report/ must not lead elsewhere
  const dir = statSync(abs).isDirectory();
  if (!dir) { const why = refusal(abs); if (why) return { ok: false, path: abs, refused: why }; }
  if (!hasDisplay()) return { ok: false, path: abs, error: 'no_display' };
  let cmd, args;
  if (process.platform === 'win32') { cmd = 'explorer.exe'; args = [abs]; }
  else if (process.platform === 'darwin') { cmd = 'open'; args = [abs]; }
  else { cmd = 'xdg-open'; args = [abs]; }
  if (dryRun) return { ok: true, path: abs, how: cmd, dry: true };
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', () => {});
    child.unref();
    return { ok: true, path: abs, how: cmd };
  } catch (e) { return { ok: false, path: abs, error: e.message }; }
}

function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'dry-run'] });
  U.helpAndExit(HELP, args);
  const en = U.langOf(args) === 'en';
  const targets = args._.filter(Boolean);
  if (!targets.length) { console.error(en ? 'Give a file or a folder to open.' : 'Укажите файл или папку.'); process.exit(2); }
  const WHY = {
    type: en ? 'not opening this file type' : 'такой тип файла не открываю',
    site_html: en ? 'this is the site\'s own HTML: it would run the site\'s scripts in your browser — open report/report.html instead' : 'это HTML самого сайта: в вашем браузере выполнятся его скрипты — откройте report/report.html',
    outside_run: en ? 'only report files of a Revizor run folder are opened' : 'открываю только файлы отчёта из папки прогона Ревизора',
  };
  const lines = []; let bad = false;
  for (const t of targets) {
    const r = openPath(t, { dryRun: !!args['dry-run'] });
    const p = r.path.replace(/\\/g, '/');
    if (r.ok) lines.push(r.dry ? `${en ? 'Would open' : 'Открыл бы'} (${r.how}): ${p}` : (en ? 'Opened: ' : 'Открыл: ') + p);
    else if (r.error === 'no_display') lines.push((en ? 'No desktop here — open it yourself: ' : 'Здесь нет рабочего стола — откройте сами: ') + p);
    else if (r.refused) { bad = true; lines.push(`${en ? 'Not opening' : 'Не открываю'}: ${p} — ${WHY[r.refused] || r.refused}`); }
    else { bad = true; lines.push((en ? 'Not found: ' : 'Не нашёл: ') + p + (r.error && r.error !== 'not_found' ? ` (${r.error})` : '')); }
  }
  U.printAndSaveSummary(null, 'open', lines);
  if (bad) process.exitCode = 2;
}

const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main();
