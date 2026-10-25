#!/usr/bin/env node
// Revizor — show.mjs: print full findings on request (for the critic and the editor, who work from report/digest.md).
//   node show.mjs --run "<RUN>" --ids copy-03,mobile-01 | --lens copy | --cluster c02 | --rejected [--json]
//   node show.mjs --run "<RUN>" --get <file> [--path a.b[k=v]] [--pick …] | --colors <shot> --box x,y,w,h — run files without node -e
// Reads report/candidates.json (or report/findings.json for rid/uid); without candidates.json builds them in memory.

import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as U from './lib/util.mjs';
import * as V from './validate.mjs';

let LANG = 'ru';
const M = (ru, en) => (LANG === 'en' ? en : ru);
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const short = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const yes = v => (v ? M('да', 'yes') : M('нет', 'no'));

function trailLine(t) {
  if (!Array.isArray(t) || !t.length) return null;
  const who = { lens: M('линза', 'lens'), skeptic: M('скептик', 'skeptic'), critic: M('критик', 'critic'), editor: M('редактор', 'editor') };
  return t.map(x => `${who[x.by] || x.by} ${x.to}${x.why && x.from ? ` (${short(x.why, 90)})` : ''}`).join(' → ');
}
function placeLine(w) {
  if (!isObj(w)) return String(w);
  const parts = [`${w.pid || w.url || '?'}@${w.viewport ?? 'all'}`];
  for (const k of ['block', 'selector', 'state']) if (w[k]) parts.push(String(w[k]));
  if (w.url && w.pid) parts.push(w.url);
  if (w.shot) parts.push(`${w.shot}${V.validBox(w.box) ? ` [${w.box.join(', ')}] ${w.box_space || 'css'}` : ''}`);
  else if (V.validBox(w.box)) parts.push(`[${w.box.join(', ')}] ${w.box_space || 'css'}`);
  if (w.crop?.shot) parts.push(`${M('кроп', 'crop')} ${w.crop.shot} [${w.crop.box.join(', ')}]`);
  return parts.join(' · ');
}

export function renderItem(it) {
  const out = [];
  const head = [`── ${it.id}`];
  if (it.rid) head.push(`${it.rid} ${it.uid || ''}`.trim());
  const chain = Array.isArray(it.severity_trail) ? it.severity_trail.filter(x => x && x.to).map(x => x.to) : [];
  const steps = chain.filter((s, i) => i === 0 || s !== chain[i - 1]);
  head.push(steps.length > 1 ? `${it.severity} (${steps.join('→')})` : String(it.severity));
  if (it.critic_wants) head.push(it.critic_wants.late ? M(`критик хотел ${it.critic_wants.to}, скептик позже задал ${it.severity}`, `critic wanted ${it.critic_wants.to}, the skeptic later set ${it.severity}`)
    : M(`критик хотел ${it.critic_wants.to}, нет проверки`, `critic wanted ${it.critic_wants.to}, not verified`));
  head.push(Array.isArray(it.lenses) && it.lenses.length > 1 ? it.lenses.join('+') : it.lens);
  head.push(`${it.verdict || 'unverified'}${it.source === 'verifier' ? M(' (добавил скептик)', ' (added by the skeptic)') : ''}`);
  if (it.verdict_conflict) head.push(M('скептики разошлись', 'conflicting verdicts'));
  if (it.requires_check) head.push(M('требует проверки', 'needs checking'));
  if (it.cluster) head.push(`${M('кластер', 'cluster')} ${it.cluster}`);
  out.push(head.join(' · '));
  out.push(`${M('Заголовок', 'Title')}: ${it.title}`);
  const flags = [it.category, `effort ${it.effort ?? '—'}`, `confidence ${it.confidence ?? '—'}`];
  for (const k of ['taste', 'needs_decision', 'needs_device_check', 'sitewide', 'owner_known']) if (it[k]) flags.push(k);
  if (it.pages_affected_estimate) flags.push(`${M('страниц ≈', 'pages ≈')} ${it.pages_affected_estimate}`);
  if (it.q) flags.push(it.q);
  out.push(`${M('Тема', 'Category')}: ${flags.filter(Boolean).join(' · ')}`);
  const where = Array.isArray(it.where) ? it.where : [];
  out.push(`${M('Где', 'Where')} (${where.length}):`);
  for (const w of where.slice(0, 10)) out.push(`  - ${placeLine(w)}`);
  if (where.length > 10) out.push(`  … ${M('ещё', 'more')} ${where.length - 10}`);
  out.push(`${M('Доказательство', 'Evidence')}: ${short(it.evidence, 1500)}`);
  out.push(`${M('Метод · норма', 'Method · norm')}: ${it.method ?? '—'} · ${it.norm ?? '—'}`);
  if (it.scenario) out.push(`${M('Сценарий', 'Scenario')}: ${it.scenario}`);
  out.push(`${M('Проблема', 'Problem')}: ${it.problem ?? '—'}`);
  out.push(`${M('Влияние', 'Impact')}: ${it.impact ?? '—'}`);
  out.push(`${M('Правка', 'Fix')}: ${it.fix ?? '—'}`);
  out.push(`  ${M('место', 'place')}: ${it.fix_place ?? '—'} · ${M('кто', 'who')}: ${it.owner ?? '—'} · ${M('проверена подменой', 'verified by substitution')}: ${yes(it.fix_verified)}${it.fix_check ? ` (${it.fix_check})` : ''}${it.fix_ok === false ? ` · ${M('скептик: правка не годится', 'skeptic: fix not usable')}` : ''}`);
  if (it.before || it.after || it.after_rejected) out.push(`${M('Было → стало', 'Before → after')}: ${it.before ?? '—'} → ${it.after ?? '—'}${it.after_rejected ? ` (${M('снято скептиком', 'dropped by the skeptic')}: «${short(it.after_rejected, 200)}»)` : ''}`);
  if (it.verify) out.push(`${M('Скептик', 'Skeptic')}: ${it.verdict} · ${M('как', 'how')}: ${short(it.verify.how, 300)}${it.verify.note ? ` · ${short(it.verify.note, 300)}` : ''}${it.verify.text_ok === false ? ' · text_ok=false' : ''} · ${it.verify.file || ''}`);
  const tl = trailLine(it.severity_trail);
  if (tl) out.push(`${M('Важность', 'Severity')}: ${tl}`);
  if (Array.isArray(it.merged_from) && it.merged_from.length > 1) out.push(`${M('Слито из', 'Merged from')}: ${it.merged_from.join(', ')}`);
  for (const a of (it.absorbed || []).slice(0, 6)) out.push(`  + ${a.id} (${a.lens}, ${a.severity}, ${a.verdict}): ${short(a.title, 100)}`);
  if (it.text_from) out.push(`${M('Текст, вердикт и флаги — у', 'Text, verdict and flags of')} ${it.text_from} (${M('самая высокая важность среди слитых', 'the highest severity of the merged')})`);
  if (it.lint?.errors?.length) out.push(`Lint: ${it.lint.errors.map(e => `${e.code} ${e.field}`).join('; ')}`);
  if (it.lint_repairs?.length) out.push(`${M('Снято lint', 'Removed by lint')}: ${it.lint_repairs.map(r => r.field).join(', ')}`);
  if (it.schema_issues?.length) out.push(`${M('Схема', 'Schema')}: ${it.schema_issues.slice(0, 5).join('; ')}`);
  if (it.fixups?.length) out.push(`${M('Поправлено merge', 'Fixed by merge')}: ${it.fixups.join('; ')}`);
  if (it.stripped?.length) out.push(`${M('Служебные поля линзы сброшены', 'Lens service fields dropped')}: ${it.stripped.join(', ')}`);
  if (it.critic_notes?.length) out.push(`${M('Критик о формулировке', 'Critic on wording')}: ${it.critic_notes.join('; ')}`);
  if (it.rewritten?.length) out.push(`${M('Переписано редактором', 'Rewritten by the editor')}: ${it.rewritten.join(', ')}`);
  if (it.files?.length) out.push(`${M('Файл', 'File')}: ${it.files.join(', ')}`);
  return out;
}
function renderRejected(r) {
  return [`── ${r.id ?? '—'} · ${r.severity ?? '—'} · ${r.lens} · ${M('ОТКЛОНЕНО', 'REJECTED')} (${r.by})`, `${M('Заголовок', 'Title')}: ${r.title ?? '—'}`, `${M('Почему', 'Why')}: ${r.why ?? '—'}${r.how ? ` · ${M('как', 'how')}: ${short(r.how, 200)}` : ''}`];
}

const HELP = `
show.mjs — полные находки по запросу (критику и редактору; они работают по report/digest.md).

  node show.mjs --run "<RUN>" --ids copy-03,mobile-01      по id (или rid P1-03, или uid R-1a2b3c4d)
  node show.mjs --run "<RUN>" --lens copy [--severity P0,P1] [--verdict unverified]
  node show.mjs --run "<RUN>" --cluster c02                 все находки кластера дублей
  node show.mjs --run "<RUN>" --rejected [--lens copy]      отклонённые и почему
  [--from candidates|findings] [--max 10] [--json] [--lang ru|en]

Чтение файлов прогона без node -e, python и jq:
  node show.mjs --run "<RUN>" --get <файл в RUN> [--path <путь>] [--pick f1,f2] [--keys] [--chars 6000] [--compact]
      часть JSON: путь a.b[0].c, [*] — все элементы, [key=value] — элементы с этим значением, имя после массива —
      поле каждого элемента. Примеры: --get measure/perf.json --path "items[pid=home].mobile";
      --get findings/a11y.json --path findings --pick id,severity,method,where; --get measure/fonts.json --keys.
      Длинный ответ обрезается по --chars с подсказкой.
  node show.mjs --run "<RUN>" --colors <кадр в RUN> --box x,y,w,h [--box x,y]   цвета области кадра (пиксели кадра):
      median, darkest, lightest, palette — например цвет рамки фокуса или фона под текстом. Точка — x,y.
Текст страниц (text.md, raw.html, dom.html) ищи Grep-ом: \\s в шаблоне находит и неразрывный пробел,
кусок вокруг слова — -o с шаблоном «.{0,200}слово.{0,300}». Правка своих JSON — Edit (Write — целиком).

Источник: report/candidates.json; rid/uid и --from findings — report/findings.json. Без candidates.json свод
собирается в памяти (ничего не записывается). Печатает полные находки (это данные, а не сводка, поэтому строк
больше 40). По --ids — все запрошенные; по фильтрам — не больше --max (по умолчанию 10), остальные — списком id
«ещё N». В --json: total (сколько подошло), shown, more (id не показанных). Копия вывода — RUN/stdout/show.md.
`;

// ---------- --get: a part of any JSON file of the run (instead of node -e / jq) ----------
// path: a.b[0].c · [*] every item · [key=value] items whose key equals value (string compare) · a name after an
// array is taken from every item. Examples: items[pid=home].mobile · findings[*].id · summary.font_faces
export function getPath(data, path) {
  const toks = [];
  const re = /\[(\*|\d+|[^\]=]+=[^\]]*)\]|\.?([^.[\]]+)/g;
  let m; while ((m = re.exec(String(path || ''))) !== null) toks.push(m[1] !== undefined ? { br: m[1] } : { name: m[2] });
  let cur = data, many = false;
  const step = (v, t) => {
    if (v === null || v === undefined) return undefined;
    if (t.name !== undefined) return Array.isArray(v) && /^\d+$/.test(t.name) ? v[Number(t.name)] : v[t.name];
    if (t.br === '*') return v;
    if (/^\d+$/.test(t.br)) return Array.isArray(v) ? v[Number(t.br)] : undefined;
    const [k, val] = [t.br.slice(0, t.br.indexOf('=')), t.br.slice(t.br.indexOf('=') + 1).replace(/^["']|["']$/g, '')];
    return Array.isArray(v) ? v.filter(x => x && typeof x === 'object' && String(getPath(x, k)) === val) : undefined;
  };
  for (const t of toks) {
    if (many) { cur = cur.map(x => step(x, t)).filter(x => x !== undefined); if (t.br && t.br !== '*' && !/^\d+$/.test(t.br)) cur = cur.flat(); continue; }
    if (Array.isArray(cur) && t.name !== undefined && !/^\d+$/.test(t.name)) { many = true; cur = cur.map(x => step(x, t)).filter(x => x !== undefined); continue; }
    cur = step(cur, t);
    if (t.br === '*' || (t.br && !/^\d+$/.test(t.br))) many = Array.isArray(cur);
  }
  return cur;
}
function pickFields(v, fields) {
  if (!fields.length) return v;
  const one = x => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(fields.map(f => [f, getPath(x, f)])) : x);
  return Array.isArray(v) ? v.map(one) : one(v);
}
function getMain(run, args) {
  const rel = String(args.get);
  let file;
  try { file = U.insideRun(run, rel); } catch { console.error(M(`--get: файл должен быть внутри папки прогона: ${rel}`, `--get: the file must be inside the run folder: ${rel}`)); process.exit(2); }
  if (!existsSync(file)) { console.error(M(`--get: нет файла ${rel}`, `--get: no file ${rel}`)); process.exit(2); }
  let data;
  try { data = U.readJSON(file); } catch (e) { console.error(M(`--get: не JSON — ${e.message}`, `--get: not JSON — ${e.message}`)); process.exit(2); }
  const path = args.path && args.path !== true ? String(args.path) : '';
  let v = path ? getPath(data, path) : data;
  v = pickFields(v, U.listArg(args.pick));
  if (args.keys) {
    const keysOf = x => (Array.isArray(x) ? { array: x.length, item_keys: x[0] && typeof x[0] === 'object' ? Object.keys(x[0]) : typeof x[0] } : x && typeof x === 'object' ? Object.keys(x) : typeof x);
    v = keysOf(v);
  }
  const max = Math.max(200, Number(args.chars) || 6000);
  let text = v === undefined ? M('(нет такого пути)', '(no such path)') : JSON.stringify(v, null, args.compact ? 0 : 1);
  if (text.length > max) text = text.slice(0, max) + '\n' + M(`… обрезано: всего ${text.length} знаков — сузьте --path, --pick или поднимите --chars`, `… cut: ${text.length} characters in all — narrow --path, --pick or raise --chars`);
  process.stdout.write(text + '\n');
}

// ---------- --colors: colours of regions of a shot (instead of python/PIL) ----------
async function colorsMain(run, args) {
  const rel = String(args.colors);
  let file;
  try { file = U.insideRun(run, rel); } catch { console.error(M(`--colors: кадр должен быть внутри папки прогона: ${rel}`, `--colors: the shot must be inside the run folder: ${rel}`)); process.exit(2); }
  if (!existsSync(file) || !/\.(jpe?g|png|webp)$/i.test(file)) { console.error(M(`--colors: нет кадра ${rel} (jpg, png, webp)`, `--colors: no shot ${rel} (jpg, png, webp)`)); process.exit(2); }
  const boxes = [].concat(args.box || []).filter(x => x !== true).flatMap(b => String(b).split(';'));
  const parsed = boxes.map(b => b.split(',').map(Number)).filter(b => (b.length === 4 || b.length === 2) && b.every(Number.isFinite)).map(b => (b.length === 2 ? [b[0], b[1], 1, 1] : b));
  if (!parsed.length) { console.error(M('--colors: нужен --box x,y,w,h (в пикселях кадра; точка — x,y; несколько — через ;)', '--colors: needs --box x,y,w,h (shot pixels; a point is x,y; several — separated by ;)')); process.exit(2); }
  const { Browser } = await import('./lib/cdp.mjs');
  const { imageStats, sampleBackground, imageSize } = await import('./lib/img.mjs');
  const release = await U.acquireBrowserSlot({ waitMs: 5 * 60 * 1000 });
  const b = await Browser.launch();
  try {
    const page = await b.newPage({ blockNavigation: true });
    const out = { shot: rel, size: imageSize(file), boxes: [] };
    for (const box of parsed) {
      const s = await imageStats(page, file, { box, sampleStep: 1, paletteSize: 4 });
      const bg = await sampleBackground(page, file, box);
      const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
      out.boxes.push({ box, median: hex(bg.median), darkest: hex(bg.darkest), lightest: hex(bg.lightest), palette: s.palette, pixels: bg.n });
    }
    process.stdout.write(JSON.stringify(out, null, 1) + '\n');
  } finally { await b.close(); release?.(); }
}

async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['rejected', 'json', 'help', 'keys', 'compact'], multi: ['box'] });
  U.helpAndExit(HELP, args);
  const lang = U.langOf(args);
  LANG = lang; V.setLang(lang);
  if (!args.run || args.run === true) { console.error(U.msg('need_run', lang)); process.exit(2); }
  const run = resolve(String(args.run));
  if (!existsSync(run)) { console.error(M(`Нет папки прогона: ${run}`, `Run folder not found: ${run}`)); process.exit(2); }
  if (args.get && args.get !== true) return getMain(run, args);
  if (args.colors && args.colors !== true) return colorsMain(run, args);
  const ids = U.listArg(args.ids ?? args.id);
  const lenses = U.listArg(args.lens);
  const cluster = args.cluster && args.cluster !== true ? String(args.cluster) : null;
  const sev = U.listArg(args.severity).map(s => s.toUpperCase());
  const verd = U.listArg(args.verdict);
  let max = Math.max(1, Number(args.max) || 10);
  if (!ids.length && !lenses.length && !cluster && !args.rejected && !sev.length && !verd.length) { console.error(M('Укажите --ids, --lens, --cluster, --severity, --verdict или --rejected. Справка: --help', 'Pass --ids, --lens, --cluster, --severity, --verdict or --rejected. See --help')); process.exit(2); }

  const wantFinal = args.from === 'findings' || ids.some(i => V.RID_RE.test(i) || V.UID_RE.test(i));
  let src = null, note = null;
  if (wantFinal) {
    const f = U.readJSON(join(run, 'report', 'findings.json'), null);
    if (f && Array.isArray(f.items)) src = { items: f.items, rejected: f.rejected || [], clusters: [], name: 'report/findings.json' };
    else note = M('report/findings.json нет — ищу в candidates.json', 'report/findings.json not found — using candidates.json');
  }
  if (!src) {
    const c = U.readJSON(join(run, 'report', 'candidates.json'), null);
    if (c && Array.isArray(c.items)) {
      src = { items: c.items, rejected: c.rejected || [], clusters: c.clusters || [], name: 'report/candidates.json' };
      try {
        const { staleInputs } = await import('./finalize.mjs');
        const st = staleInputs(run, statSync(join(run, 'report', 'candidates.json')).mtimeMs);
        if (st.length) note = M(`внимание: candidates.json старее ${st.slice(0, 3).join(', ')}${st.length > 3 ? ' …' : ''} — перезапустите merge.mjs`, `note: candidates.json is older than ${st.slice(0, 3).join(', ')}${st.length > 3 ? ' …' : ''} — re-run merge.mjs`);
      } catch { /* the note is a convenience */ }
    } else {
      const { buildCandidates } = await import('./merge.mjs');
      const b = buildCandidates(run, {});
      src = { items: b.candidates.items, rejected: b.candidates.rejected, clusters: b.candidates.clusters, name: M('свод в памяти (merge.mjs ещё не запускали)', 'in-memory merge (merge.mjs has not run yet)') };
    }
  }

  let picked = [], rej = [], missing = [];
  if (ids.length) {
    for (const id of ids) {
      const it = src.items.find(x => x.id === id || x.rid === id || x.uid === id) || src.items.find(x => Array.isArray(x.merged_from) && x.merged_from.includes(id));
      if (it) { if (!picked.includes(it)) picked.push(it); continue; }
      const r = src.rejected.find(x => x.id === id);
      if (r) rej.push(r); else missing.push(id);
    }
  } else if (!args.rejected) {
    let list = src.items;
    if (cluster) { const c = src.clusters.find(k => k.key === cluster); list = c ? list.filter(x => c.ids.includes(x.id)) : list.filter(x => x.cluster === cluster); if (!c && !list.length) missing.push(cluster); }
    if (lenses.length) list = list.filter(x => lenses.includes(x.lens) || (x.lenses || []).some(l => lenses.includes(l)));
    if (sev.length) list = list.filter(x => sev.includes(x.severity));
    if (verd.length) list = list.filter(x => verd.includes(x.verdict));
    picked = list;
  }
  if (args.rejected) rej = src.rejected.filter(r => !lenses.length || lenses.includes(r.lens));

  if (ids.length) max = Math.max(max, picked.length, rej.length); // asked by id: everything asked is printed
  if (args.json) {
    const more = picked.slice(max).map(x => x.rid || x.id);
    process.stdout.write(JSON.stringify({ source: src.name, total: picked.length, shown: Math.min(max, picked.length), more, items: picked.slice(0, max), rejected: rej, missing }, null, 2) + '\n');
    return;
  }
  const lines = [`show · ${src.name} · ${M('найдено', 'found')} ${picked.length}${rej.length ? ` · ${M('отклонённых', 'rejected')} ${rej.length}` : ''}${picked.length > max ? ` · ${M('показано', 'shown')} ${max}` : ''}`];
  if (note) lines.push(note);
  if (cluster) { const c = src.clusters.find(k => k.key === cluster); if (c) lines.push(`${M('Кластер', 'Cluster')} ${c.key} (${c.kind}): ${c.reason}`); }
  for (const it of picked.slice(0, max)) lines.push('', ...renderItem(it));
  if (picked.length > max) lines.push('', M(`… ещё ${picked.length - max}: ${picked.slice(max).map(x => x.rid || x.id).join(', ')} (--ids или --max)`, `… ${picked.length - max} more: ${picked.slice(max).map(x => x.rid || x.id).join(', ')} (--ids or --max)`));
  for (const r of rej.slice(0, max)) lines.push('', ...renderRejected(r));
  if (rej.length > max) lines.push('', M(`… ещё отклонённых ${rej.length - max}: ${rej.slice(max).map(x => x.id ?? '—').join(', ')}`, `… ${rej.length - max} more rejected: ${rej.slice(max).map(x => x.id ?? '—').join(', ')}`));
  if (missing.length) lines.push('', `${M('Не найдено', 'Not found')}: ${missing.join(', ')}`);
  if (!picked.length && !rej.length && !missing.length) lines.push(M('Под условия ничего не подошло.', 'Nothing matches.'));
  const text = lines.join('\n') + '\n';
  process.stdout.write(text);
  try { U.writeText(U.insideRun(run, 'stdout', 'show.md'), text); } catch { /* the copy is a convenience */ }
}

const isMain = (() => { try { return resolve(process.argv[1] || '') === fileURLToPath(import.meta.url); } catch { return false; } })();
if (isMain) main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
