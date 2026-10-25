// Tests dict-src.mjs and writes the machine-readable line into knowledge/language/{ru,en}-ai-markers.md (with --write).
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DICTS } from './dict-src.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', '..', 'plugins', 'revizor');
// --samples: scan snapshot/*/text.md of your own local runs (folder from REVIZOR_SAMPLES), never committed
const SAMPLES = process.env.REVIZOR_SAMPLES || '';
const LISTS = ['markers', 'hedges', 'superlatives', 'placeholders', 'untranslated', 'outdated'];
const LEVELS = ['P0', 'P1', 'P2', 'P3'];
const CATEGORIES = ['машинный след', 'заглушка', 'канцелярит', 'метатекст', 'усилитель', 'калька', 'не-X-а-Y', 'триада', 'оценка без факта', 'штамп'];
const PREFIX = { markers: 'm', hedges: 'h', superlatives: 's', placeholders: 'p', untranslated: 'u', outdated: 'o' };
const write = process.argv.includes('--write');
const showSamples = process.argv.includes('--samples');

let fail = 0;
const err = s => { fail++; console.log('FAIL ' + s); };
function compile(e) {
  let flags = e.flags || 'giu';
  if (!flags.includes('g')) flags += 'g';
  if (!flags.includes('u')) flags += 'u';
  return new RegExp(e.pattern, flags);
}
const test = (re, s) => { re.lastIndex = 0; return re.test(s); };

const compiled = {};
for (const [lang, d] of Object.entries(DICTS)) {
  const ids = new Set();
  compiled[lang] = {};
  for (const list of LISTS) {
    compiled[lang][list] = [];
    for (const e of d[list]) {
      const idRe = new RegExp(`^${lang}-${PREFIX[list]}-\\d{3}$`);
      if (!idRe.test(e.id)) err(`${e.id}: id не по шаблону ${lang}-${PREFIX[list]}-NNN`);
      if (ids.has(e.id)) err(`${e.id}: повтор id`); ids.add(e.id);
      if (/\\b/.test(e.pattern)) err(`${e.id}: \\b в шаблоне`);
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(e.pattern)) err(`${e.id}: управляющий символ`);
      if (list === 'markers') {
        if (!LEVELS.includes(e.level)) err(`${e.id}: level ${e.level}`);
        if (!CATEGORIES.includes(e.category)) err(`${e.id}: category ${e.category}`);
        if (!e.hint) err(`${e.id}: нет hint`);
      }
      let re;
      try { re = compile(e); } catch (x) { err(`${e.id}: ${x.message}`); continue; }
      if (test(re, '')) err(`${e.id}: совпадает с пустой строкой`);
      for (const s of e._yes) if (!test(re, s)) err(`${e.id}: НЕ СРАБОТАЛ на «${s}»`);
      for (const s of e._no) if (test(re, s)) err(`${e.id}: ЛОЖНОЕ на «${s}»`);
      if (!e._yes.length) err(`${e.id}: нет примеров yes`);
      if (!e._no.length) err(`${e.id}: нет примеров no`);
      compiled[lang][list].push({ e, re });
    }
  }
}

// neutral corpora: P0/P1 markers and placeholders must stay silent
function scanLines(lang, text, label, strict) {
  const hits = [];
  for (const line of text.split(/\r?\n/).filter(Boolean)) {
    for (const list of LISTS) {
      if (list === 'untranslated') continue;
      for (const { e, re } of compiled[lang][list]) {
        re.lastIndex = 0; let m;
        while ((m = re.exec(line))) {
          if (!m[0]) { re.lastIndex++; continue; }
          const lvl = list === 'markers' ? e.level : list === 'placeholders' ? 'P0' : 'P2';
          hits.push({ id: e.id, list, lvl, match: m[0], line });
        }
      }
    }
  }
  for (const h of hits) {
    const bad = strict && (h.lvl === 'P0' || h.lvl === 'P1');
    if (bad) err(`${label}: ${h.id} (${h.lvl}) «${h.match}» в «${h.line.slice(0, 90)}»`);
    else console.log(`  note ${label}: ${h.id} ${h.lvl} «${h.match}»`);
  }
  return hits;
}
console.log('--- нейтральные тексты');
scanLines('ru', readFileSync(join(HERE, 'neutral-ru.txt'), 'utf8'), 'neutral-ru', true);
scanLines('en', readFileSync(join(HERE, 'neutral-en.txt'), 'utf8'), 'neutral-en', true);
const NEUTRAL = 'Студия работает с 9:00 до 21:00. Первое занятие стоит 500 ₽, абонемент на месяц — 4 000 ₽. Адрес: ул. Садовая, 5. Запишитесь по телефону. The studio is open from 9 am.';
for (const lang of ['ru', 'en']) for (const { e, re } of compiled[lang].markers) if ((e.level === 'P0' || e.level === 'P1') && test(re, NEUTRAL)) err(`NEUTRAL textscan: ${e.id}`);

// sample runs (local only, never copied anywhere): what fires on real pages
if (showSamples && SAMPLES) {
  console.log('--- образцы прогонов (только для просмотра)');
  for (const run of readdirSync(SAMPLES)) {
    const snap = join(SAMPLES, run, 'snapshot');
    if (!existsSync(snap)) continue;
    for (const pid of readdirSync(snap)) {
      const f = join(snap, pid, 'text.md');
      if (!existsSync(f)) continue;
      const hits = scanLines('ru', readFileSync(f, 'utf8'), `${run}/${pid}`, false);
      if (!hits.length) console.log(`  ${run}/${pid}: чисто`);
    }
  }
}

// JSON line
const lines = {};
for (const [lang, d] of Object.entries(DICTS)) {
  const json = { version: 1, lang };
  for (const list of LISTS) json[list] = d[list].map(({ _yes, _no, ...rest }) => rest);
  const s = JSON.stringify(json);
  if (s.includes('-->') || s.includes('<!--') || s.includes('--')) err(`${lang}: в JSON есть «--»`);
  const line = `<!-- revizor:dict ${s} -->`;
  // same extraction as textscan.mjs
  const all = [...line.matchAll(/<!--\s*revizor:dict\s+(\{[\s\S]*?\})\s*-->/g)];
  try { const back = JSON.parse(all[all.length - 1][1]); if (JSON.stringify(back) !== s) err(`${lang}: JSON не совпал после разбора`); } catch (x) { err(`${lang}: JSON не разбирается: ${x.message}`); }
  lines[lang] = line;
  console.log(`${lang}: ${LISTS.map(l => `${l} ${d[l].length}`).join(', ')}; строка ${line.length} знаков`);
}

// own prose: the language files themselves, quotes and code stripped (same idea as textscan --report)
if (process.argv.includes('--prose')) {
  console.log('--- свой текст справочников (без цитат и кода)');
  const strip = s => s.replace(/«[^»]*»|"[^"\n]*"|“[^”]*”|„[^“”]*[“”]|`[^`]*`/g, m => ' '.repeat(m.length));
  for (const name of ['ru-ai-markers.md', 'en-ai-markers.md', 'clarity-ru.md', 'ux-copy.md', 'typography-ru.md', 'NOTICE.md']) {
    const f = join(PLUGIN, 'knowledge', 'language', name);
    if (!existsSync(f)) { console.log(`  нет ${name}`); continue; }
    const text = readFileSync(f, 'utf8').split(/\r?\n/).filter(l => !l.startsWith('<!-- revizor:dict')).map(strip).join('\n');
    const hits = [];
    for (const line of text.split('\n')) for (const list of ['markers', 'hedges']) for (const { e, re } of compiled.ru[list].filter(x => !["ru-m-008", "ru-m-009"].includes(x.e.id))) {
      re.lastIndex = 0; let m;
      while ((m = re.exec(line))) { if (!m[0]) { re.lastIndex++; continue; } hits.push(`${e.id} ${list === 'markers' ? e.level : 'hedge'} «${m[0]}» :: ${line.trim().slice(0, 100)}`); }
    }
    console.log(`  ${name}: ${hits.length ? hits.length + ' мест' : 'чисто'}`);
    for (const h of hits) console.log('    ' + h);
  }
}

if (fail) { console.log(`ИТОГ: ошибок ${fail}`); process.exit(1); }
console.log('ИТОГ: все примеры прошли');
if (write) {
  for (const lang of ['ru', 'en']) {
    const f = join(PLUGIN, 'knowledge', 'language', `${lang}-ai-markers.md`);
    if (!existsSync(f)) { console.log(`нет ${f} — пропуск`); continue; }
    let body = readFileSync(f, 'utf8').split(/\r?\n/).filter(l => !l.startsWith('<!-- revizor:dict')).join('\n').replace(/\s+$/, '');
    // "Read с `limit: N`" must cover exactly the prose (text lines + the blank line before the dictionary)
    const n = body.split('\n').length + 1;
    body = body.replace(/limit: \d+/, `limit: ${n}`);
    writeFileSync(f, body + '\n\n' + lines[lang] + '\n', 'utf8');
    const total = readFileSync(f, 'utf8').split('\n');
    if (!total[n].startsWith('<!-- revizor:dict')) err(`${lang}: строка ${n + 1} не словарь`);
    console.log(`записано: ${f} (текст ${n} строк, словарь — строка ${n + 1})`);
  }
}
