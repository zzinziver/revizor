#!/usr/bin/env node
// Reference registry files (format: plugins/revizor/knowledge/report-structure.md §8) for the xlsx reader and recheck.mjs tests.
// Run: node make-fixtures.mjs   → registry-owner.xlsx, registry-team.xlsx, registry-edited.xlsx, expected-read.json
// The files are generated with plugins/revizor/scripts/lib/xlsx.mjs; registry-edited.xlsx is then patched by hand-made
// XML edits that office suites do on re-save (inline strings, rich-text runs, renamed/extra columns, sheet order,
// absolute relationship targets). Real files re-saved by Excel / LibreOffice are NOT here — see README.md.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, '..', '..', 'plugins', 'revizor', 'scripts', 'lib', 'xlsx.mjs');
const { writeXlsx, readXlsx } = await import(pathToFileURL(LIB).href);

// ---------- the same findings for all three files (demo site, fictional) ----------
const SITE = 'http://127.0.0.1:8080/';
const ROWS = [
  // rid, uid, severity, section, topic, what, where, fix, who, effort, fix_place, lens, method, norm, confidence, url, selector, viewport, state
  ['P0-01', 'R-1a2b3c4d', 'P0', 'Главная', 'Тексты', 'В отзыве на главной стоит заглушка «[Ваше имя]» вместо имени гостя', '/ · отзывы', 'Вписать имя гостя или убрать отзыв', 'владелец в CMS', 'S', 'контент', 'copy', 'script:textscan', 'машинные следы — P0', 'high', '/', '.review cite', 'all', 'загрузка'],
  ['P1-01', 'R-2b3c4d5e', 'P1', 'Меню', 'Мобильная версия', 'Таблица цен шире экрана на 360 px: 380 px, страница прокручивается вбок', '/menu/ · таблица цен', 'Убрать min-width у .price-table, на узком экране показать строки карточками', 'разработчик', 'M', 'общий CSS', 'mobile', 'script:mobile', 'нет горизонтальной прокрутки на 320–414', 'high', '/menu/', '.price-table', '360', 'загрузка'],
  ['P1-02', 'R-3c4d5e6f', 'P1', 'Главная', 'Формы', 'Форма брони отправляет имя и телефон методом GET — данные попадают в адрес и журналы', '/ · попап брони', 'Поставить method="post" и обработчик на сервере', 'разработчик', 'S', 'шаблон', 'privacy', 'script:forms', 'ПДн в адресе оседают в журналах серверов и аналитики; 152-ФЗ, ст. 19 — меры защиты', 'high', '/', '.modal form', 'all', 'попап'],
  ['P1-03', 'R-4d5e6f70', 'P1', 'Все страницы', 'Приватность', 'Метрика с Вебвизором загружается до согласия на cookie', 'все страницы · head', 'Загружать счётчики только после нажатия «Принять»', 'разработчик', 'M', 'шаблон', 'privacy', 'script:privacy', '152-ФЗ, согласие до обработки', 'medium', '/', 'head script', 'all', 'загрузка'],
  ['P2-01', 'R-5e6f7081', 'P2', 'О нас', 'SEO', 'canonical страницы «О нас» указывает на главную — страница не попадёт в индекс', '/about/ · head', 'Поставить canonical на сам адрес /about/', 'разработчик', 'S', 'шаблон', 'seo-tech', 'script:seo', 'canonical на себя', 'high', '/about/', 'link[rel=canonical]', 'all', 'загрузка'],
  ['P2-02', 'R-6f708192', 'P2', 'Все страницы', 'Доступность', 'Фокус не виден: outline: none на всех элементах без замены', 'все страницы · общий CSS', 'Вернуть кольцо фокуса: :focus-visible { outline: 2px solid #2b1d14; outline-offset: 2px }', 'разработчик', 'S', 'общий CSS', 'a11y', 'script:a11y', 'WCAG 2.4.7 AA', 'high', '/', '*:focus', '1440', 'клавиатура'],
  ['P3-01', 'R-708192a3', 'P3', 'Меню', 'Типографика', 'Прямые кавычки и дефис: Десерт "Наполеон" - по бабушкиному рецепту', '/menu/ · десерты', 'Десерт «Наполеон» — по бабушкиному рецепту', 'копирайтер', 'S', 'контент', 'typography', 'script:textscan', 'русская типографика', 'high', '/menu/', '.dessert h3', 'all', 'загрузка'],
  ['P3-02', 'R-8192a3b4', 'P3', 'Подвал', 'Тексты', 'В подвале «© 2019» — сайт выглядит заброшенным', 'все страницы · подвал', '© 2017–2026 или без года', 'владелец в CMS', 'S', 'блок CMS', 'copy', 'script:textscan', '—', 'high', '/', '.copy', 'all', 'загрузка'],
];
const OWNER_COLS = ['№', 'Важность', 'Раздел сайта', 'Тема', 'Что на сайте', 'Где (URL · блок)', 'Как исправить', 'Кто', 'Трудоёмкость', 'Статус', 'Комментарий', 'Проверено'];
const TEAM_EXTRA = ['Линзы', 'Метод', 'Норма', 'Уверенность', 'uid'];
const SEV = { P0: 'Срочно (P0)', P1: 'Важно (P1)', P2: 'Стоит сделать (P2)', P3: 'Мелочи (P3)' };
const STATUSES = ['новое', 'в работе', 'исправлено', 'не будем исправлять'];
const WIDTH = { '№': 8, 'Важность': 16, 'Раздел сайта': 16, 'Тема': 16, 'Что на сайте': 60, 'Где (URL · блок)': 30, 'Как исправить': 60, 'Кто': 18, 'Трудоёмкость': 12, 'Статус': 18, 'Комментарий': 30, 'Проверено': 14, 'Линзы': 14, 'Метод': 16, 'Норма': 28, 'Уверенность': 12, 'uid': 14 };

function sheets({ team }) {
  const cols = team ? [...OWNER_COLS, ...TEAM_EXTRA] : OWNER_COLS;
  const rows = ROWS.map(r => {
    const base = [r[0], SEV[r[2]], r[3], r[4], r[5], r[6], r[7], r[8], r[9], 'новое', '', ''];
    return team ? [...base, r[11], r[12], r[13], r[14], r[1]] : base;
  });
  const statusCol = String.fromCharCode(65 + cols.indexOf('Статус'));
  const byPlace = [];
  for (const place of [...new Set(ROWS.map(r => r[10]))]) {
    byPlace.push([place, '', '']);
    for (const r of ROWS.filter(x => x[10] === place)) byPlace.push(['', r[0], r[5]]);
  }
  const n = ROWS.length + 1;
  return [
    { name: 'Замечания', columns: cols.map(h => ({ header: h, width: WIDTH[h] || 14 })), rows, freeze: true, autoFilter: true,
      validations: [{ col: statusCol, list: STATUSES }],
      cellStyle: (ri, ci) => (ci === 1 ? String(rows[ri][1]).match(/P\d/)?.[0].toLowerCase() : undefined) },
    { name: 'По месту правки', columns: [{ header: 'Место правки', width: 22 }, { header: '№', width: 8 }, { header: 'Что на сайте', width: 80 }], rows: byPlace },
    { name: 'Сводка', columns: [{ header: 'Показатель', width: 30 }, { header: 'Значение', width: 14 }], rows: [
      ['Всего замечаний', { f: `COUNTA('Замечания'!A2:A${n})` }],
      ...['P0', 'P1', 'P2', 'P3'].map(p => [SEV[p], { f: `COUNTIF('Замечания'!B2:B${n},"*${p}*")` }]),
      ['Исправлено', { f: `COUNTIF('Замечания'!${statusCol}2:${statusCol}${n},"исправлено")` }],
      ['Не будем исправлять', { f: `COUNTIF('Замечания'!${statusCol}2:${statusCol}${n},"не будем исправлять")` }],
    ] },
    { name: 'Как читать', columns: [{ header: 'Как читать реестр', width: 100 }], rows: [
      ['Одна строка — одно замечание. Важность: Срочно (P0) → Мелочи (P3).'],
      ['Столбец «Статус» — выберите из списка: новое, в работе, исправлено, не будем исправлять.'],
      ['«Не будем исправлять» + комментарий — Ревизор больше не предложит это при следующих проверках.'],
      ['После правок запустите /revizor:recheck и укажите этот файл.'],
    ] },
    { name: '_revizor', columns: ['uid', 'rid', 'url', 'selector', 'viewport', 'state', 'method', 'lens', 'norm'].map(h => ({ header: h, width: 16 })), rows: [
      ...ROWS.map(r => [r[1], r[0], SITE.replace(/\/$/, '') + r[15], r[16], r[17], r[18], r[12], r[11], r[13]]),
      ['_meta', `site=${SITE}`, 'run_date=2026-10-24', 'plugin_version=1.0.0', 'schema_version=3'],
    ] },
  ];
}

// ---------- tiny zip (read + write) for the "re-saved" variant ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function unzip(buf) {
  let e = buf.length - 22; while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  const count = buf.readUInt16LE(e + 10); let p = buf.readUInt32LE(e + 16); const out = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const ds = loff + 30 + buf.readUInt16LE(loff + 26) + buf.readUInt16LE(loff + 28);
    const data = buf.subarray(ds, ds + csize);
    out.push({ name, data: method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data) });
    p += 46 + nlen + elen + clen;
  }
  return out;
}
function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8'), raw = f.data, comp = zlib.deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x5958, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x5958, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, name, comp); centrals.push(ch, name); off += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// hide the _revizor sheet in a file written by writeXlsx (writeXlsx has no "hidden" option)
function hideRevizorSheet(path) {
  const files = unzip(readFileSync(path));
  const wb = files.find(f => f.name === 'xl/workbook.xml');
  wb.data = Buffer.from(wb.data.toString('utf8').replace(/<sheet name="_revizor"/, '<sheet state="hidden" name="_revizor"'), 'utf8');
  writeFileSync(path, zip(files));
}

// ---------- write ----------
const owner = join(HERE, 'registry-owner.xlsx'), team = join(HERE, 'registry-team.xlsx'), edited = join(HERE, 'registry-edited.xlsx');
writeXlsx(owner, { sheets: sheets({ team: false }) }); hideRevizorSheet(owner);
writeXlsx(team, { sheets: sheets({ team: true }) }); hideRevizorSheet(team);

// registry-edited.xlsx: what a person + an office suite leave behind
//  · statuses typed by hand in other case: «Исправлено», «В РАБОТЕ», «не будем исправлять» + comment
//  · header «Статус» → «Статус » (trailing space), «Комментарий» → «Комментарий заказчика», «Проверено» → «Проверено (дата)»
//  · a user column «Ответственный» inserted between «Кто» and «Трудоёмкость»
//  · cells written as inline strings (t="inlineStr") and as rich-text runs (<r><t>…</t></r>) in sharedStrings
//  · sheet order changed (Сводка first), relationship targets absolute (/xl/worksheets/…), workbook with x: prefix-free XML
{
  const base = sheets({ team: false });
  const s0 = base[0];
  const cols = s0.columns.map(c => c.header);
  const ins = cols.indexOf('Трудоёмкость');
  const headers = [...cols.slice(0, ins), 'Ответственный', ...cols.slice(ins)]
    .map(h => (h === 'Статус' ? 'Статус ' : h === 'Комментарий' ? 'Комментарий заказчика' : h === 'Проверено' ? 'Проверено (дата)' : h));
  const userStatus = { 'P0-01': ['Исправлено', 'убрали отзыв 25.10', '25.10.2026'], 'P1-01': ['В РАБОТЕ', '', ''], 'P1-02': ['новое', '', ''],
    'P1-03': ['не будем исправлять', 'Метрика нужна с первого захода, решение владельца', ''], 'P2-01': ['исправлено', '', '26.10.2026'],
    'P2-02': ['', '', ''], 'P3-01': ['Исправлено ', 'кавычки поправили', ''], 'P3-02': ['не будем исправлять', '', ''] };
  const rows = s0.rows.map(r => {
    const [st, cm, dt] = userStatus[r[0]] || ['', '', ''];
    const row = [...r.slice(0, ins), r[0] === 'P1-01' ? 'Сергей (верстальщик)' : '', ...r.slice(ins)];
    const si = headers.indexOf('Статус '), ci = headers.indexOf('Комментарий заказчика'), di = headers.indexOf('Проверено (дата)');
    row[si] = st; row[ci] = cm; row[di] = dt;
    return row;
  });
  const sh = [{ ...base[2] }, { ...s0, columns: headers.map(h => ({ header: h, width: 16 })), rows, validations: [], cellStyle: undefined }, base[1], base[3], base[4]];
  writeXlsx(edited, { sheets: sh, creator: 'LibreOffice-like' });
  const files = unzip(readFileSync(edited));
  const get = n => files.find(f => f.name === n);
  // sheet2 (Замечания): every text cell of the "Что на сайте" column → inline string; header «Тема» → rich text runs
  const sst = get('xl/sharedStrings.xml');
  let sstXml = sst.data.toString('utf8');
  sstXml = sstXml.replace('<si><t xml:space="preserve">Тема</t></si>', '<si><r><rPr><b/></rPr><t>Те</t></r><r><t>ма</t></r></si>');
  sst.data = Buffer.from(sstXml, 'utf8');
  const shared = [...sstXml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
  const s2 = get('xl/worksheets/sheet2.xml');
  const whatCol = String.fromCharCode(65 + headers.indexOf('Что на сайте'));
  s2.data = Buffer.from(s2.data.toString('utf8').replace(new RegExp(`<c r="(${whatCol}(\\d+))" s="(\\d+)" t="s"><v>(\\d+)</v></c>`, 'g'),
    (m, ref, row, s, v) => (row === '1' ? m : `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${shared[+v]}</t></is></c>`)), 'utf8');
  const rels = get('xl/_rels/workbook.xml.rels');
  rels.data = Buffer.from(rels.data.toString('utf8').replace(/Target="worksheets\//g, 'Target="/xl/worksheets/'), 'utf8');
  const wb = get('xl/workbook.xml');
  wb.data = Buffer.from(wb.data.toString('utf8').replace(/<sheet name="_revizor"/, '<sheet state="hidden" name="_revizor"'), 'utf8');
  writeFileSync(edited, zip(files));
}

// ---------- what a correct reader must get out of each file ----------
const expected = {
  about: 'Что должен прочитать читатель реестра (recheck.mjs --from <xlsx>, memory.mjs --from-registry). Столбцы ищутся по заголовкам (синонимы, регистр, пробелы, ё/е), статусы — без учёта регистра и пробелов по краям.',
  files: {
    'registry-owner.xlsx': { sheet: 'Замечания', rows: ROWS.length, columns: OWNER_COLS, hidden_sheet: '_revizor', uids: ROWS.map(r => ({ rid: r[0], uid: r[1], status: 'новое' })) },
    'registry-team.xlsx': { sheet: 'Замечания', rows: ROWS.length, columns: [...OWNER_COLS, ...TEAM_EXTRA], hidden_sheet: '_revizor', uids: ROWS.map(r => ({ rid: r[0], uid: r[1], status: 'новое' })) },
    'registry-edited.xlsx': { sheet: 'Замечания', rows: ROWS.length, sheet_order: ['Сводка', 'Замечания', 'По месту правки', 'Как читать', '_revizor'], user_columns: ['Ответственный'],
      header_variants: { 'Статус': 'Статус ', 'Комментарий': 'Комментарий заказчика', 'Проверено': 'Проверено (дата)', 'Тема': 'Тема (rich text: «Те» + «ма»)' },
      uids: [
        { rid: 'P0-01', uid: 'R-1a2b3c4d', status: 'исправлено', comment: 'убрали отзыв 25.10', checked: '25.10.2026' },
        { rid: 'P1-01', uid: 'R-2b3c4d5e', status: 'в работе', responsible: 'Сергей (верстальщик)' },
        { rid: 'P1-02', uid: 'R-3c4d5e6f', status: 'новое' },
        { rid: 'P1-03', uid: 'R-4d5e6f70', status: 'не будем исправлять', comment: 'Метрика нужна с первого захода, решение владельца', do_not_suggest: true },
        { rid: 'P2-01', uid: 'R-5e6f7081', status: 'исправлено', checked: '26.10.2026' },
        { rid: 'P2-02', uid: 'R-6f708192', status: 'новое', note: 'пустой статус = новое' },
        { rid: 'P3-01', uid: 'R-708192a3', status: 'исправлено', comment: 'кавычки поправили' },
        { rid: 'P3-02', uid: 'R-8192a3b4', status: 'не будем исправлять', note: 'без комментария: в site-memory не переносится как do_not_suggest' },
      ] },
  },
  revizor_sheet: { columns: ['uid', 'rid', 'url', 'selector', 'viewport', 'state', 'method', 'lens', 'norm'], meta_row: '_meta | site=… | run_date=… | plugin_version=… | schema_version=…' },
};
writeFileSync(join(HERE, 'expected-read.json'), JSON.stringify(expected, null, 2) + '\n');

// self-check with the plugin reader
for (const f of [owner, team, edited]) {
  const x = readXlsx(f);
  const names = x.sheets.map(s => s.name).join(', ');
  const zam = x.sheets.find(s => s.name === 'Замечания');
  console.log(`${f.split(/[\\/]/).pop()}: листы [${names}] · строк в «Замечания» ${zam ? zam.rows.length - 1 : '—'} · заголовки: ${zam ? zam.rows[0].join(' | ') : '—'}`);
}
