// Revizor — minimal XLSX writer/reader without dependencies (zip via node:zlib).
//
// writeXlsx(path, {
//   sheets: [{
//     name: 'Замечания',
//     columns: [{ header: '№', width: 8 }, { header: 'Важность', width: 10 }, …],
//     rows: [['P0-01', 'P0', …], …],          // strings | numbers | { f: 'COUNTIF(…)' } | null
//     freeze: true, autoFilter: true,
//     validations: [{ col: 'I', list: ['новое', 'в работе', 'исправлено', 'не будем исправлять'] }],
//     cellStyle: (rowIdx, colIdx, value) => 'wrap' | 'p0' | 'p1' | 'p2' | 'p3' | 'bold' | 'header' | undefined,
//   }],
// })
// readXlsx(path) → { sheets: [{ name, rows: [[cell…]] }] }

import { writeFileSync, readFileSync } from 'node:fs';
import zlib from 'node:zlib';

// ---------- zip ----------
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) {
  if (typeof zlib.crc32 === 'function') return zlib.crc32(buf) >>> 0;
  let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0;
}
function dosTime(d = new Date()) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}
function zip(files) { // files: [{ name, data: Buffer|string }]
  const locals = [], centrals = []; let offset = 0; const { time, date } = dosTime();
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(time, 10); lh.writeUInt16LE(date, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12); ch.writeUInt16LE(date, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip/xlsx file');
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), loff = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(loff + 26), lelen = buf.readUInt16LE(loff + 28);
    const data = buf.subarray(loff + 30 + lnlen + lelen, loff + 30 + lnlen + lelen + csize);
    out[name] = method === 8 ? zlib.inflateRawSync(data) : Buffer.from(data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

// ---------- xml helpers ----------
const esc = s => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function colIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; }

// style ids in styles.xml (cellXfs order)
const STYLE = { default: 0, header: 1, wrap: 2, bold: 3, p0: 4, p1: 5, p2: 6, p3: 7, center: 8 };
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="7"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEDEDF0"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFD6D6"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFE4C4"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF6C2"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEEEEEE"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFC8C8D0"/></bottom><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="5" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="6" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="top"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function writeXlsx(path, { sheets, creator = 'Revizor' }) {
  const strings = [], sIndex = new Map();
  const si = s => { s = String(s); if (!sIndex.has(s)) { sIndex.set(s, strings.length); strings.push(s); } return sIndex.get(s); };
  const sheetXml = sheets.map(sh => {
    const cols = sh.columns || [];
    const allRows = [cols.map(c => c.header ?? ''), ...(sh.rows || [])];
    const lastCol = colName(Math.max(cols.length, ...allRows.map(r => r.length)) - 1);
    const rowsXml = allRows.map((row, ri) => {
      const cells = row.map((v, ci) => {
        if (v === null || v === undefined || v === '') return '';
        const ref = colName(ci) + (ri + 1);
        let st = ri === 0 ? 'header' : (sh.cellStyle ? sh.cellStyle(ri - 1, ci, v) : undefined) || (cols[ci]?.style) || 'wrap';
        const s = STYLE[st] ?? 0;
        if (typeof v === 'object' && v.f) return `<c r="${ref}" s="${s}"><f>${esc(v.f)}</f></c>`;
        if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}" s="${s}"><v>${v}</v></c>`;
        return `<c r="${ref}" s="${s}" t="s"><v>${si(v)}</v></c>`;
      }).join('');
      return `<row r="${ri + 1}">${cells}</row>`;
    }).join('');
    const colsXml = cols.length ? `<cols>${cols.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width || 14}" customWidth="1"/>`).join('')}</cols>` : '';
    const views = sh.freeze ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : '';
    const filter = sh.autoFilter && allRows.length > 1 ? `<autoFilter ref="A1:${lastCol}${allRows.length}"/>` : '';
    const dv = (sh.validations || []).length ? `<dataValidations count="${sh.validations.length}">${sh.validations.map(v =>
      `<dataValidation type="list" allowBlank="1" showErrorMessage="0" sqref="${v.col}2:${v.col}${Math.max(allRows.length, 2) + 500}"><formula1>"${esc(v.list.join(','))}"</formula1></dataValidation>`).join('')}</dataValidations>` : '';
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${views}<sheetFormatPr defaultRowHeight="15"/>${colsXml}<sheetData>${rowsXml}</sheetData>${filter}${dv}</worksheet>`;
  });
  const safeName = (n, i) => String(n || `Лист${i + 1}`).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31);
  const files = [
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>` },
    { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>${esc(creator)}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${esc(safeName(s.name, i))}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${sheets.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: STYLES_XML },
    ...sheetXml.map((x, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: x })),
  ];
  files.push({ name: 'xl/sharedStrings.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>` });
  writeFileSync(path, zip(files));
  return path;
}

const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

export function readXlsx(path) {
  const files = unzip(readFileSync(path));
  const shared = [];
  const sst = files['xl/sharedStrings.xml']?.toString('utf8') || '';
  for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join('')));
  const wb = files['xl/workbook.xml']?.toString('utf8') || '';
  const rels = files['xl/_rels/workbook.xml.rels']?.toString('utf8') || '';
  const relMap = Object.fromEntries([...rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map(m => [m[1], m[2].replace(/^\/?xl\//, '')]));
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map(m => {
    const sa = m[1];
    const name = (sa.match(/\bname="([^"]*)"/) || [])[1] || '';
    const rid = (sa.match(/\br:id="([^"]+)"/) || [])[1];
    const hidden = /\bstate="(hidden|veryHidden)"/.test(sa);
    const xml = files['xl/' + relMap[rid]]?.toString('utf8') || '';
    const rows = [];
    let rowSeq = 0;
    // handles <row r="5"/> (empty, self-closing) and rows without r= (some writers omit it)
    for (const r of xml.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const rn = +((r[1].match(/\br="(\d+)"/) || [])[1] || (rowSeq + 1));
      rowSeq = rn;
      const row = [];
      let colSeq = -1;
      for (const c of (r[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1]; const refM = attrs.match(/\br="([A-Z]+)\d+"/); const t = (attrs.match(/\bt="([^"]+)"/) || [])[1];
        const ref = refM ? refM[1] : null;
        const inner = c[2] || ''; const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        let val = null;
        if (t === 's') val = shared[+v] ?? '';
        else if (t === 'inlineStr') val = unesc([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(x => x[1]).join(''));
        else if (t === 'str' || t === 'b' || t === 'e') val = v === undefined ? null : unesc(v);
        else val = v === undefined ? null : (isNaN(+v) ? unesc(v) : +v);
        colSeq = ref ? colIndex(ref) : colSeq + 1;
        row[colSeq] = val;
      }
      rows[rn - 1] = row;
    }
    return { name: unesc(name), hidden, rows: Array.from(rows, r => r || []) };
  });
  return { sheets };
}

// ---------- columns by headers ----------
// A registry edited in Excel/LibreOffice/Google Sheets may have moved, renamed or extra columns: never trust positions.
// findColumns(rows, synonyms?, { maxHeaderRows }) → { row, cols: { key: colIndex }, missing: [key], headers: [text] }
//   rows      — readXlsx(...).sheets[i].rows
//   synonyms  — { key: ['Header', 'синоним', …] }; omitted → registry columns (knowledge/report-structure.md, section 8, RU + EN).
//   Matching ignores case, ё/е, extra spaces, nbsp and text in brackets: «Где (URL · блок)» = «где».
//   Exact match wins over a prefix match («Проверено» before «Проверено 24.10»); the first column wins among equals.
//   The header row is the one (among the first maxHeaderRows) that matches the most keys; row = -1 when none matched.
export function findColumns(rows, synonyms = null, { maxHeaderRows = 10 } = {}) {
  const syn = synonyms || {
    rid: ['№', 'номер', 'no', 'no.', '#', 'id', 'rid', 'number'],
    severity: ['важность', 'приоритет', 'severity', 'priority'],
    section: ['раздел сайта', 'раздел', 'страница', 'site section', 'section', 'page'],
    topic: ['тема', 'topic', 'area'],
    what: ['что на сайте', 'проблема', 'замечание', 'issue', 'what', 'problem'],
    where: ['где', 'где (url · блок)', 'место', 'where', 'location'],
    fix: ['как исправить', 'исправление', 'решение', 'fix', 'how to fix'],
    who: ['кто', 'исполнитель', 'ответственный', 'who', 'owner'],
    effort: ['трудоёмкость', 'трудоемкость', 'объём работы', 'effort'],
    status: ['статус', 'status', 'state'],
    comment: ['комментарий', 'комментарии', 'comment', 'comments', 'notes'],
    checked: ['проверено', 'дата проверки', 'checked', 'verified'],
    recheck_result: ['итог перепроверки', 'recheck result'],
    lenses: ['линзы', 'линза', 'lenses', 'lens'],
    method: ['метод', 'method'],
    norm: ['норма', 'norm', 'standard'],
    confidence: ['уверенность', 'confidence'],
    uid: ['uid'],
  };
  const norm = s => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[   ]/g, ' ')
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/[«»"'“”:*]/g, ' ').replace(/\s+/g, ' ').trim();
  const keys = Object.keys(syn);
  const want = Object.fromEntries(keys.map(k => [k, [...new Set((syn[k] || []).map(norm).filter(Boolean))]]));
  const isPrefix = (h, s) => h.length > s.length && h.startsWith(s) && /[\s\d.,;:—–-]/.test(h[s.length]);
  const matchRow = row => {
    const heads = Array.from(row || [], norm);
    const cols = {}; const used = new Set();
    for (const pass of ['exact', 'prefix']) {
      for (const k of keys) {
        if (k in cols) continue;
        for (let ci = 0; ci < heads.length && !(k in cols); ci++) {
          const h = heads[ci];
          if (!h || used.has(ci)) continue;
          if (want[k].some(s => (pass === 'exact' ? h === s : isPrefix(h, s)))) { cols[k] = ci; used.add(ci); }
        }
      }
    }
    return cols;
  };
  let best = { row: -1, cols: {} };
  const limit = Math.min(maxHeaderRows, (rows || []).length);
  for (let ri = 0; ri < limit; ri++) {
    const cols = matchRow(rows[ri]);
    if (Object.keys(cols).length > Object.keys(best.cols).length) best = { row: ri, cols };
  }
  return { row: best.row, cols: best.cols, missing: keys.filter(k => !(k in best.cols)),
    headers: best.row >= 0 ? Array.from(rows[best.row] || [], v => (v === null || v === undefined ? '' : String(v))) : [] };
}
