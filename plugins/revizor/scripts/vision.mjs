#!/usr/bin/env node
// Revizor — vision.mjs: how the first screen looks to people who see colour differently, in dark theme and
// browser auto-dark, in Windows contrast themes (forced-colors), with "increase contrast", and on paper.
// First screen of the home page and 2 key pages at 390 (touch) and 1440, plus print of important pages.
// Read-only: no clicks, no typing, no query params; emulation only (Chromium), so results are estimates.
// Page probes run in an isolated world (the page can't replace getComputedStyle & co.).
//
//   node vision.mjs --run "<RUN>" [--pages home,p01 [--subset]] [--widths 390,1440] [--print-pages p03] [--url <url>]
//                   [--budget-sec 480] [--fresh] [--lang ru|en]

import { join, relative, sep } from 'node:path';
import { existsSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { Browser } from './lib/cdp.mjs';
import * as U from './lib/util.mjs';
import { imageStats, contactSheet, imageSize } from './lib/img.mjs';

const NAME = 'vision';
const HELP = `
vision.mjs — цвет глазами разных людей, тёмная тема, контрастные режимы, печать (линза color; данные для a11y и mobile)

  node vision.mjs --run "<RUN>" [флаги]

Что делает (только чтение, эмуляция в Chromium):
  · первый экран главной и 2 страниц из pages.json (цены, услуги, контакты) на 390 и 1440: обычный вид и 6 симуляций зрения
    (protanopia, deuteranopia, tritanopia, achromatopsia, blurredVision, reducedContrast);
    полноэкранная заставка скрывается до кадров (overlay_hidden);
  · prefers-color-scheme: dark — тёмная тема есть, только если кадр заметно меняется (разница кадров > 12 или
    color-scheme: dark при заметной разнице); правило в CSS без эффекта — dark_rules_no_effect; что ломается:
    новые пары с низким контрастом, логотип, theme-color;
  · 390: авто-затемнение браузера (алгоритм Chrome; пометка «эмуляция»), если своей тёмной темы нет;
  · 1440: forced-colors: active (контрастная тема Windows) — пропадают ли иконки-кнопки, кнопки без рамки;
  · prefers-contrast: more — меняется ли что-нибудь;
  · ссылки в тексте, которые отличаются только цветом (контраст с текстом < 3:1, неразличимы при дальтонизме);
  · яркость кадров (lib/img imageStats): средняя светлота, доля чистого белого и чёрного;
  · 390: вспышки (WCAG 2.3.1, оценка) — 12 кадров первого экрана, если там что-то движется; фактическая частота
    кадров в sample_hz, ниже 7 Гц — confidence: low;
  · печать важных страниц (контакты, цены, меню): PDF первого листа (его и смотреть — Read читает PDF), кадр print
    без экранных фонов и со светлым текстом, затемнённым как в Chrome; число листов; light_text — по печатным
    цветам; что обрезано по ширине листа;
  · лист-контакт всех режимов на страницу и ширину.

Два режима --pages:
  · конвейер зовёт с --pages без --subset → фильтр основного файла с продолжением: из переданных страниц
    берётся свой набор (главная + 2 страницы: цены, услуги, контакты; печать — контакты/цены/меню), результат в measure/vision.json
    (замеры других страниц в нём сохраняются), код 75 — повтор той же команды продолжит;
  · перемер части страниц агентом — --pages <pid,…> --subset (флаг --subset последним): меряются ровно эти
    страницы, результат в отдельный measure/vision.subset-<время>.json, основной файл не трогается
    (печать — только если задан --print-pages).

Флаги:
  --run <папка>          папка прогона (обязательно)
  --pages a,b            страницы (см. «Два режима --pages»)
  --subset               записать в measure/vision.subset-<время>.json, основной файл не трогать
  --widths 390,1440      ширины (по умолчанию обе; всегда subset)
  --print-pages a,b      страницы для печати (по умолчанию контакты/цены/меню, иначе главная; всегда subset)
  --url <адрес>          если pages.json ещё нет: одна страница
  --allow-load-posts     разрешить POST-запросы самой страницы при загрузке (SPA)
  --budget-sec N         стоп до таймаута (по умолчанию 480); частичный результат и код 75, повтор продолжит
                         (единица со сбоем повторяется один раз)
  --fresh                начать заново
  --lang ru|en           язык сводки и полей-пояснений
Пишет: measure/vision.json, measure/vision/*.jpg|pdf, stdout/vision.md
  (subset — stdout/vision.subset-<время>.md). Коды: 0 готово, 75 частично (бюджет или slot_wait — браузер занят), 2 аргументы, 1 сбой.
`;
const HELP_EN = `
vision.mjs — colour as different people see it, dark theme, contrast modes, print (lens color; data for a11y and mobile)

  node vision.mjs --run "<RUN>" [flags]

What it does (read-only, Chromium emulation):
  · first screen of home + 2 pages from pages.json (prices, services, contacts) at 390 and 1440: normal and 6 vision simulations
    (protanopia, deuteranopia, tritanopia, achromatopsia, blurredVision, reducedContrast);
    a full-screen splash is hidden before the shots (overlay_hidden);
  · prefers-color-scheme: dark — a dark theme exists only when the shot changes noticeably (shot diff > 12, or
    color-scheme: dark with a noticeable diff); CSS rules without effect — dark_rules_no_effect; what breaks:
    new low-contrast pairs, logo, theme-color;
  · 390: browser auto-dark (Chrome's algorithm, marked "emulation") when there is no own dark theme;
  · 1440: forced-colors: active (Windows contrast theme) — icon buttons that vanish, borderless buttons;
  · prefers-contrast: more — does anything change;
  · links in text marked by colour only (contrast with text < 3:1, indistinct for colour-blind people);
  · shot brightness (lib/img imageStats): mean lightness, share of pure white and black;
  · 390: flashes (WCAG 2.3.1, estimate) — 12 frames of the first screen when something moves; the real frame
    rate is in sample_hz, below 7 Hz — confidence: low;
  · print of important pages (contacts, prices, menu): PDF of the first sheet (look at it — Read opens PDFs), a print
    shot without screen backgrounds and with light text darkened like Chrome does; sheet count; light_text — by
    printed colours; what is cut at the paper width;
  · a contact sheet of all modes per page and width.

Two --pages modes:
  · the pipeline passes --pages without --subset → a filter of the main file with resume: its own set is picked
    from the given pages (home + 2 pages: prices, services, contacts; print — contacts/prices/menu), results go to measure/vision.json
    (other pages' data is kept), exit 75 — rerun to continue;
  · an agent re-measuring some pages — --pages <pid,…> --subset (--subset last): exactly these pages, results go to
    a separate measure/vision.subset-<time>.json, the main file is not touched (print only with --print-pages).

Flags:
  --run <dir>            run folder (required)
  --pages a,b            pages (see "Two --pages modes")
  --subset               write measure/vision.subset-<time>.json, leave the main file alone
  --widths 390,1440      widths (default both; always a subset)
  --print-pages a,b      pages to print (default contacts/prices/menu, else home; always a subset)
  --url <url>            no pages.json yet: one page
  --allow-load-posts     let the page's own POSTs through during load (SPA)
  --budget-sec N         stop before the timeout (default 480); partial result and exit 75, a rerun continues
                         (a failed unit is retried once)
  --fresh                start over
  --lang ru|en           language of the summary and explanation fields
Writes: measure/vision.json, measure/vision/*.jpg|pdf, stdout/vision.md
  (subset — stdout/vision.subset-<time>.md). Exit: 0 done, 75 partial (budget or slot_wait — browser busy), 2 args, 1 failure.
`;
let LANG = 'ru';
let ALLOW_POSTS = false;
const tabOpts = () => ({ blockNavigation: true, allowLoadPosts: ALLOW_POSTS });

const SIMS = ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia', 'blurredVision', 'reducedContrast'];
const PAPER = { w: 718, h: 1047 }; // printable A4 area in CSS px (96 dpi, 1 cm margins of Page.printToPDF)
const T = {
  ru: {
    title: 'vision.mjs — цвет, тёмная тема, контрастные режимы, печать', partial: 'ЧАСТИЧНО (бюджет времени) — повторите тот же вызов, продолжит', partialSubset: 'ЧАСТИЧНО (бюджет времени) — subset не продолжается: уменьшите --pages или увеличьте --budget-sec', partialSlot: 'ЧАСТИЧНО — браузер занят другими проверками (slot_wait), повторите тот же вызов',
    pages: 'Страницы', dark: 'Тёмная тема', yes: 'есть', no: 'нет', newLow: 'новых пар с низким контрастом', logoLost: 'логотип теряется',
    autodark: 'Авто-затемнение (эмуляция)', forced: 'Контрастная тема Windows', vanished: 'иконок-кнопок пропало', noBorder: 'кнопок без рамки',
    more: 'prefers-contrast: more', changes: 'меняет вид', nochange: 'ничего не меняет', links: 'Ссылки в тексте только цветом',
    bright: 'Яркость первого экрана', white: 'чистого белого', print: 'Печать', sheets: 'Листы-контакты', written: 'Записано', errors: 'Ошибки',
    notChecked: 'Не проверено', themeColor: 'theme-color ≠ фон', lowLight: 'низкий контраст в светлой', sheetsN: 'шт.',
    unchanged: 'без изменений', perSec: '/с', iconsLost: 'иконок-кнопок теряется', flash: 'Вспышки (WCAG 2.3.1, оценка)', none: 'нет', moving: 'движение есть', static: 'первый экран статичный',
    lowRate: 'частота кадров ниже 7 Гц — оценка ненадёжна', noEffect: 'правила dark в CSS без эффекта', overlay: 'Полноэкранная заставка скрыта перед кадрами', pdf: 'смотреть PDF', retried: 'повторено после сбоя',
    pureBlack: 'Чистый чёрный ≥ 40 % первого экрана', forcedRules: '@media (forced-colors) есть', rulesExist: 'правила есть', below3: 'контраст с текстом < 3:1', onText: 'на тексте',
    indistinct: 'неразличимы', sheetsShort: 'л.', expected: 'ожидали', printCss: 'print-стили', lightText: 'светлый текст', stickyLayers: 'липких слоёв', cut: 'обрезано справа', blank: 'похоже на пустые листы', fullFail: 'вся страница не напечаталась (сбой браузера), есть первый лист',
  },
  en: {
    title: 'vision.mjs — colour, dark theme, contrast modes, print', partial: 'PARTIAL (time budget) — rerun the same command to continue', partialSubset: 'PARTIAL (time budget) — a subset does not resume: pass fewer --pages or a larger --budget-sec', partialSlot: 'PARTIAL — browser busy with other checks (slot_wait), rerun the same command',
    pages: 'Pages', dark: 'Dark theme', yes: 'yes', no: 'no', newLow: 'new low-contrast pairs', logoLost: 'logo lost',
    autodark: 'Auto-dark (emulation)', forced: 'Windows contrast theme', vanished: 'icon buttons vanished', noBorder: 'borderless buttons',
    more: 'prefers-contrast: more', changes: 'changes the page', nochange: 'changes nothing', links: 'Links in text marked by colour only',
    bright: 'First-screen brightness', white: 'pure white', print: 'Print', sheets: 'Contact sheets', written: 'Written', errors: 'Errors',
    notChecked: 'Not checked', themeColor: 'theme-color ≠ background', lowLight: 'low contrast in light', sheetsN: '',
    unchanged: 'no change', perSec: '/s', iconsLost: 'icon buttons lost', flash: 'Flashes (WCAG 2.3.1, estimate)', none: 'none', moving: 'motion on', static: 'first screen is static',
    lowRate: 'frame rate below 7 Hz — low confidence', noEffect: 'dark CSS rules without effect', overlay: 'Full-screen splash hidden before shots', pdf: 'see the PDF', retried: 'retried after a failure',
    pureBlack: 'Pure black ≥ 40 % of first screen', forcedRules: '@media (forced-colors) present', rulesExist: 'rules present', below3: 'contrast with text < 3:1', onText: 'on text',
    indistinct: 'indistinct', sheetsShort: 'p.', expected: 'expected', printCss: 'print CSS', lightText: 'light text', stickyLayers: 'sticky layers', cut: 'cut on the right', blank: 'blank sheets suspected', fullFail: 'whole-page print failed (browser crash), first sheet saved',
  },
};

// ---------- colour maths (Machado et al. 2009, severity 1.0, linear RGB) ----------
const CVD = {
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
  tritanopia: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
};
const toLin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const fromLin = v => { v = Math.min(1, Math.max(0, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055); };
function simulate(rgb, type) {
  const l = rgb.slice(0, 3).map(toLin);
  if (type === 'achromatopsia') { const y = 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2]; return [y, y, y].map(fromLin); }
  const m = CVD[type]; return m.map(r => fromLin(r[0] * l[0] + r[1] * l[1] + r[2] * l[2]));
}
function toLab(rgb) {
  const [r, g, b] = rgb.map(toLin);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
const deltaE = (a, b) => { const p = toLab(a), q = toLab(b); return Math.round(Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]) * 10) / 10; };

// ---------- in-page probes (self-contained) ----------
function PAGE_INFO() {
  const cs = el => getComputedStyle(el);
  const sel = el => { const p = []; let c = el; for (let d = 0; c && c.nodeType === 1 && d < 4; d++) { if (c.id && /^[A-Za-z][\w-]{0,40}$/.test(c.id)) { p.unshift('#' + c.id); break; } let s = c.tagName.toLowerCase(); const cn = typeof c.className === 'string' ? c.className.split(/\s+/).filter(Boolean).slice(0, 2) : []; if (cn.length) s += '.' + cn.map(x => CSS.escape(x)).join('.'); p.unshift(s); if (c.tagName === 'BODY') break; c = c.parentElement; } return p.join(' > ').slice(0, 160); };
  const shown = el => { if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false; const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; };
  const alpha = c => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return 1; const p = m[1].split(/[\s,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const vw = innerWidth, vh = innerHeight;
  const inFold = r => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  const box = r => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  const meta = document.querySelector('meta[name="color-scheme"]');
  const themes = [...document.querySelectorAll('meta[name="theme-color"]')].map(m => ({ content: m.getAttribute('content'), media: m.getAttribute('media') }));
  // links inside running text that differ from the text by colour only
  const links = []; let checked = 0;
  for (const a of document.querySelectorAll('p a[href], li a[href], td a[href], dd a[href], blockquote a[href]')) {
    const s = cs(a); if (s.display !== 'inline' || !shown(a)) continue;
    const par = a.parentElement; const ps = cs(par); const pt = String(par.innerText || '').trim(); const at = String(a.innerText || '').trim();
    if (!at || pt.length < at.length + 15) continue;
    checked++;
    const cue = /underline/.test(s.textDecorationLine) || parseFloat(s.borderBottomWidth) > 0 || (parseInt(s.fontWeight) - parseInt(ps.fontWeight)) >= 300
      || (alpha(s.backgroundColor) > 0.1 && s.backgroundColor !== ps.backgroundColor) || s.fontStyle !== ps.fontStyle || /underline/.test(cs(par).textDecorationLine)
      || (s.backgroundImage && s.backgroundImage !== 'none');
    if (cue) continue;
    if (links.length < 25) links.push({ sel: sel(a), text: at.slice(0, 50), link_color: s.color, text_color: ps.color });
  }
  // icon-only controls in the first screen (forced colours can wipe them)
  const icons = [];
  for (const el of document.querySelectorAll('a[href], button, [role=button]')) {
    if (icons.length >= 10) break;
    if (!shown(el) || String(el.innerText || '').trim()) continue;
    const r = el.getBoundingClientRect(); if (!inFold(r) || r.width < 12 || r.height < 12 || r.width > 90 || r.height > 90) continue;
    const gen = p => !/^(none|normal)$/.test(cs(el, p).content);
    const bars = [...el.querySelectorAll('span, i, div')].some(k => alpha(cs(k).backgroundColor) > 0.5);
    const kind = el.querySelector('svg') ? 'svg' : el.querySelector('img') ? 'img' : cs(el).backgroundImage !== 'none' ? 'background-image'
      : bars ? 'css-shapes (background-color)' : (gen('::before') || gen('::after')) ? 'pseudo' : 'other';
    icons.push({ sel: sel(el), label: el.getAttribute('aria-label') || el.getAttribute('title') || null, kind, box: box(r) });
  }
  // borderless buttons: shape drawn by background only
  let noBorder = 0; const noBorderSamples = [];
  for (const el of document.querySelectorAll('a[href], button, [role=button], input[type=submit], input[type=button]')) {
    if (!shown(el)) continue; const s = cs(el); const r = el.getBoundingClientRect(); if (!inFold(r) && r.top > vh * 2) continue;
    if (alpha(s.backgroundColor) < 0.5 || parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderBottomWidth) > 0) continue;
    const ps = el.parentElement ? cs(el.parentElement) : null; if (ps && ps.backgroundColor === s.backgroundColor) continue;
    if (r.width < 40 || r.height < 24) continue;
    noBorder++; if (noBorderSamples.length < 5) noBorderSamples.push({ sel: sel(el), text: String(el.innerText || '').trim().slice(0, 30), bg: s.backgroundColor });
  }
  const logos = [];
  for (const el of document.querySelectorAll('header img, header svg, [class*="logo" i] img, [class*="logo" i] svg, img[alt*="logo" i], img[src*="logo" i], img[class*="logo" i], a[class*="logo" i] img')) {
    if (logos.length >= 3) break; if (!shown(el)) continue; const r = el.getBoundingClientRect();
    if (r.top > 220 || r.width < 16 || r.height < 10 || logos.some(l => l.el === el)) continue;
    logos.push({ el, sel: sel(el), box: box(r), src: el.tagName === 'IMG' ? String(el.currentSrc || el.src).slice(0, 120) : 'inline svg' });
  }
  const printLinks = document.querySelectorAll('link[rel~="stylesheet"][media*="print" i], style[media*="print" i]').length;
  return { color_scheme_meta: meta ? meta.getAttribute('content') : null, root_color_scheme: cs(document.documentElement).colorScheme, theme_colors: themes,
    body_bg: cs(document.body).backgroundColor, html_bg: cs(document.documentElement).backgroundColor,
    links: { checked, color_only: links }, icons, buttons_no_border: noBorder, buttons_no_border_samples: noBorderSamples,
    logos: logos.map(({ el, ...rest }) => rest), print_links: printLinks, dpr: devicePixelRatio, vw, vh };
}

function TEXT_CONTRAST(screens) {
  const cs = el => getComputedStyle(el);
  const parse = s => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const dark = matchMedia('(prefers-color-scheme: dark)').matches && /dark/.test(cs(document.documentElement).colorScheme);
  const canvas = dark ? [18, 18, 18] : [255, 255, 255];
  const bgOf = el => {
    const stack = [];
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      const s = cs(a); if (s.backgroundImage && s.backgroundImage !== 'none') return null;
      const c = parse(s.backgroundColor); if (c && c[3] > 0) { stack.push(c); if (c[3] >= 0.99) break; }
    }
    let base = canvas.slice();
    for (let i = stack.length - 1; i >= 0; i--) { const c = stack[i]; base = [0, 1, 2].map(k => c[k] * c[3] + base[k] * (1 - c[3])); }
    return base;
  };
  const sel = el => { const p = []; let c = el; for (let d = 0; c && c.nodeType === 1 && d < 3; d++) { if (c.id) { p.unshift('#' + c.id); break; } let s = c.tagName.toLowerCase(); const cn = typeof c.className === 'string' ? c.className.split(/\s+/).filter(Boolean).slice(0, 2) : []; if (cn.length) s += '.' + cn.join('.'); p.unshift(s); c = c.parentElement; } return p.join(' > ').slice(0, 140); };
  const seen = new Set(); const low = []; let checked = 0; const maxY = innerHeight * screens;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.replace(/\s+/g, ' ').trim(); if (t.length < 2) continue;
    const el = n.parentElement; if (!el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT|OPTION)$/.test(el.tagName)) continue; seen.add(el);
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.top + scrollY > maxY) continue;
    const s = cs(el); const fg = parse(s.color); if (!fg) continue; const bg = bgOf(el); if (!bg) continue;
    const col = [0, 1, 2].map(k => fg[k] * fg[3] + bg[k] * (1 - fg[3]));
    const fs = parseFloat(s.fontSize), fw = parseInt(s.fontWeight) || 400;
    const large = fs >= 24 || (fs >= 18.66 && fw >= 700); const need = large ? 3 : 4.5;
    const rt = Math.round(ratio(col, bg) * 100) / 100; checked++;
    if (rt < need) low.push({ sel: sel(el), text: t.slice(0, 50), color: s.color, bg: 'rgb(' + bg.map(Math.round).join(', ') + ')', ratio: rt, need, size: fs });
  }
  low.sort((a, b) => a.ratio - b.ratio);
  return { checked, low_count: low.length, low: low.slice(0, 15) };
}

function FREEZE() {
  for (const v of document.querySelectorAll('video')) { try { v.pause(); } catch {} }
  try { for (const a of document.getAnimations()) a.pause(); } catch {}
  return true;
}

function PRINT_INFO() {
  const cs = el => getComputedStyle(el);
  const shown = el => { if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false; const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1; };
  const sel = el => { const p = []; let c = el; for (let d = 0; c && c.nodeType === 1 && d < 3; d++) { if (c.id) { p.unshift('#' + c.id); break; } let s = c.tagName.toLowerCase(); const cn = typeof c.className === 'string' ? c.className.split(/\s+/).filter(Boolean).slice(0, 2) : []; if (cn.length) s += '.' + cn.join('.'); p.unshift(s); c = c.parentElement; } return p.join(' > ').slice(0, 140); };
  const parse = s => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; return m[1].split(/[\s,/]+/).filter(Boolean).map(Number); };
  const lin = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const fixed = [];
  for (const el of document.body.getElementsByTagName('*')) {
    const s = cs(el); if (s.position !== 'fixed' && s.position !== 'sticky') continue;
    if (!shown(el)) continue; if (fixed.length < 8) fixed.push({ sel: sel(el), text: String(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 40), position: s.position });
  }
  const nav = [...document.querySelectorAll('header, nav, [role=navigation]')].filter(shown).map(el => ({ sel: sel(el), height: Math.round(el.getBoundingClientRect().height) })).slice(0, 5);
  // Backgrounds are dropped on paper by default, and Chrome then darkens light text (Blink TextColorForWhiteBackground:
  // a colour within 255² of white in squared RGB distance gets Color::Dark()); print-color-adjust: exact keeps both.
  // light_text counts text that is still light on white AFTER that adjustment; light_text_screen — by screen colours.
  const exact = el => /exact/.test(cs(el).printColorAdjust || cs(el).webkitPrintColorAdjust || '');
  const printed = c => {
    if ((255 - c[0]) ** 2 + (255 - c[1]) ** 2 + (255 - c[2]) ** 2 > 65025) return c.slice(0, 3);
    const v = Math.max(c[0], c[1], c[2]) / 255.99; const m = v ? Math.max(0, (v - 0.33) / v) : 0;
    return [Math.floor(m * c[0]), Math.floor(m * c[1]), Math.floor(m * c[2])];
  };
  const onWhite = c => { const a = c.length > 3 && !Number.isNaN(c[3]) ? c[3] : 1; return [0, 1, 2].map(k => c[k] * a + 255 * (1 - a)); };
  let light = 0, lightScreen = 0; const lightSamples = []; const seen = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n;
  while ((n = walker.nextNode())) {
    const t = n.textContent.replace(/\s+/g, ' ').trim(); if (t.length < 2) continue;
    const el = n.parentElement; if (!el || seen.has(el) || /^(SCRIPT|STYLE|NOSCRIPT)$/.test(el.tagName)) continue; seen.add(el);
    if (!shown(el)) continue; const c = parse(cs(el).color); if (!c) continue;
    if (1.05 / (L(onWhite(c)) + 0.05) < 3) lightScreen++;
    if (exact(el)) continue; // printed with its own background
    const p = onWhite([...printed(c), c.length > 3 ? c[3] : 1]);
    const ratio = 1.05 / (L(p) + 0.05);
    if (ratio < 3) { light++; if (lightSamples.length < 6) lightSamples.push({ sel: sel(el), text: t.slice(0, 40), color: cs(el).color, printed: 'rgb(' + p.map(Math.round).join(', ') + ')', ratio_on_white: Math.round(ratio * 100) / 100 }); }
  }
  let urlAfter = 0;
  for (const a of [...document.querySelectorAll('a[href^="http"]')].slice(0, 200)) { const c = cs(a, '::after').content; if (c && /http|\//.test(c)) urlAfter++; }
  // content height without the viewport minimum (scrollHeight never drops below the window height)
  let bottom = 0;
  for (const el of document.body.getElementsByTagName('*')) {
    const s = cs(el); if (s.position === 'fixed' || s.display === 'none') continue;
    const r = el.getBoundingClientRect(); if (r.height < 1) continue; bottom = Math.max(bottom, r.bottom + scrollY);
  }
  // what sticks out of the paper width is cut off in the PDF
  const vw = document.documentElement.clientWidth; const wide = [];
  for (const el of document.querySelectorAll('table, img, pre, iframe, video, svg, canvas, [style*="width"]')) {
    if (wide.length >= 5) break; if (!shown(el)) continue; const r = el.getBoundingClientRect();
    if (r.right > vw + 2) wide.push({ sel: sel(el), width: Math.round(r.width), right: Math.round(r.right) });
  }
  return { fixed_visible: fixed, nav_visible: nav, light_text: light, light_text_screen: lightScreen, light_samples: lightSamples, links_show_url: urlAfter,
    height: Math.round(bottom || document.documentElement.scrollHeight), cut_right_px: Math.max(0, document.documentElement.scrollWidth - vw), wide, page_width: vw,
    videos: document.querySelectorAll('video').length, iframes: document.querySelectorAll('iframe').length };
}

// Paper look for the print shot: a screenshot always paints backgrounds, paper doesn't. Drop backgrounds/shadows
// (except print-color-adjust: exact) and darken light text the way Chrome does; PAPER_OFF restores the page.
function PAPER_ON() {
  const cs = el => getComputedStyle(el);
  const parse = s => { const m = String(s).match(/rgba?\(([^)]+)\)/); if (!m) return null; return m[1].split(/[\s,/]+/).filter(Boolean).map(Number); };
  const printed = c => {
    if ((255 - c[0]) ** 2 + (255 - c[1]) ** 2 + (255 - c[2]) ** 2 > 65025) return null;
    const v = Math.max(c[0], c[1], c[2]) / 255.99; const m = v ? Math.max(0, (v - 0.33) / v) : 0;
    return [Math.floor(m * c[0]), Math.floor(m * c[1]), Math.floor(m * c[2]), c.length > 3 ? c[3] : 1];
  };
  const saved = []; let changed = 0, exactN = 0;
  for (const el of document.body ? document.body.getElementsByTagName('*') : []) {
    const s = cs(el);
    if (/exact/.test(s.printColorAdjust || s.webkitPrintColorAdjust || '')) { el.setAttribute('data-rv-exact', ''); exactN++; continue; }
    if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const c = parse(s.color); if (!c) continue; const p = printed(c); if (!p) continue;
    saved.push([el, el.style.getPropertyValue('color'), el.style.getPropertyPriority('color')]);
    el.style.setProperty('color', `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${p[3]})`, 'important'); changed++;
  }
  const st = document.createElement('style'); st.id = '__rv_paper';
  st.textContent = '*:not([data-rv-exact]), *:not([data-rv-exact])::before, *:not([data-rv-exact])::after { background-color: transparent !important; background-image: none !important; box-shadow: none !important; text-shadow: none !important; } html, body { background: #fff !important; }';
  document.documentElement.appendChild(st);
  window.__rvPaper = saved;
  return { text_darkened: changed, exact_elements: exactN };
}
function PAPER_OFF() {
  const st = document.getElementById('__rv_paper'); if (st) st.remove();
  for (const [el, v, p] of window.__rvPaper || []) { if (v) el.style.setProperty('color', v, p); else el.style.removeProperty('color'); }
  for (const el of document.querySelectorAll('[data-rv-exact]')) el.removeAttribute('data-rv-exact');
  window.__rvPaper = null; return true;
}

// A fixed layer over ≥ 85 % of the screen hit by the screen centre, with the page content (h1/main or ≥ 200 chars)
// outside it: splash, age gate, start screen. Hidden before shots — what the visitor sees after closing it.
function OVERLAY_HIDE() {
  const vw = innerWidth, vh = innerHeight; const out = [];
  if (!document.body) return out;
  for (const el of document.body.getElementsByTagName('*')) {
    const s = getComputedStyle(el); if (s.position !== 'fixed' || s.display === 'none' || s.visibility === 'hidden') continue;
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, vw) - Math.max(r.left, 0), h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (w < vw * 0.85 || h < vh * 0.85) continue;
    const c = document.elementFromPoint(vw / 2, vh / 2); if (!c || !el.contains(c)) continue;
    if (String(el.innerText || '').length >= 1500) continue;
    let outside = [...document.querySelectorAll('h1, main, [role=main]')].some(x => !el.contains(x) && !x.contains(el));
    if (!outside) { let n = 0; for (const k of document.body.children) { if (k === el || k.contains(el) || el.contains(k) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(k.tagName)) continue; n += String(k.textContent || '').trim().length; if (n > 200) { outside = true; break; } } }
    if (!outside) continue;
    const cn = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2) : [];
    out.push({ sel: el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cn.length ? '.' + cn.join('.') : ''), text: String(el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
    el.style.setProperty('display', 'none', 'important'); el.setAttribute('data-rv-hidden', 'fullscreen_overlay');
  }
  return out;
}

// ---------- helpers ----------
function rel(run, p) { return relative(run, p).split(sep).join('/'); }
// probes in an isolated world; falls back to the page world if the isolated one can't be created
async function iso(tab, fnSrc, ...args) {
  const expr = `(${fnSrc})(...${JSON.stringify(args)})`;
  try { return await tab.evaluateIsolated(expr); } catch (e) { if (/evaluate:/.test(e.message)) throw e; return tab.evaluate(expr); }
}
function safeName(s) { return String(s).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40); }
function isLocalHost(h) { h = String(h || '').toLowerCase().replace(/^\[|\]$/g, ''); return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || (/^[\d.]+$/.test(h) && U.isPrivateIp(h)); }
async function politePause() { await U.sleep(900 + Math.floor(Math.random() * 500)); }
function statsDiff(a, b) { if (!a || !b) return null; return Math.round((Math.abs(a.meanL - b.meanL) + Math.abs(a.whiteShare - b.whiteShare) + Math.abs(a.blackShare - b.blackShare) + 100 * Math.abs(a.saturationMean - b.saturationMean)) * 10) / 10; }
function slimStats(s) { return s ? { meanL: s.meanL, medianL: s.medianL, whiteShare: s.whiteShare, blackShare: s.blackShare, saturationMean: s.saturationMean, distinctTones: s.distinctTones, palette: s.palette.slice(0, 5) } : null; }

// dark rules: own (first-party) sheets count; a third-party widget's rule is reported apart
async function collectCssFlags(tab, pageUrl = '') {
  const heads = []; const off = tab.on('CSS.styleSheetAdded', p => heads.push(p.header));
  const flags = { dark: false, dark_third_party: false, print: false, page_rule: false, forced: false, more_contrast: false, color_scheme_decl: false, sheets: 0, unreadable: 0 };
  const site = U.stripWww(U.hostOf(pageUrl));
  const own = h => { if (h.isInline || !h.sourceURL || !/^https?:/.test(h.sourceURL)) return true; const x = U.stripWww(U.hostOf(h.sourceURL)); return !site || x === site || x.endsWith('.' + site) || site.endsWith('.' + x); };
  try { await tab.send('DOM.enable'); await tab.send('CSS.enable'); await U.sleep(300); } catch { off(); return flags; }
  off();
  for (const h of heads) {
    if (h.origin && h.origin !== 'regular') continue;
    try {
      const { text } = await tab.send('CSS.getStyleSheetText', { styleSheetId: h.styleSheetId }); if (!text) continue; flags.sheets++;
      const t = text.replace(/\/\*[\s\S]*?\*\//g, ' ');
      if (/prefers-color-scheme\s*:\s*dark/i.test(t)) { if (own(h)) flags.dark = true; else flags.dark_third_party = true; }
      if (/@media[^{]*\bprint\b/i.test(t)) flags.print = true;
      if (/@page\b/i.test(t)) flags.page_rule = true;
      if (/forced-colors|-ms-high-contrast/i.test(t)) flags.forced = true;
      if (/prefers-contrast/i.test(t)) flags.more_contrast = true;
      if (/color-scheme\s*:\s*[^;{}]*dark/i.test(t)) flags.color_scheme_decl = true;
    } catch { flags.unreadable++; }
  }
  try { await tab.send('CSS.disable'); } catch {}
  return flags;
}

async function openTab(b, url, { w, h, mobile, scheme = 'light', autoDark = false, freeze = true }) {
  const tab = await b.newPage(tabOpts());
  await tab.setViewport({ width: w, height: h, mobile, deviceScaleFactor: mobile ? 2 : 1, touch: mobile });
  await tab.emulateMedia({ colorScheme: scheme });
  let autoDarkMethod = null;
  if (autoDark) { try { await tab.send('Emulation.setAutoDarkModeOverride', { enabled: true }); autoDarkMethod = 'chrome-auto-dark'; } catch { autoDarkMethod = null; } }
  await politePause();
  const nav = await tab.goto(url, { timeout: 45000 });
  if (nav.ok) {
    await U.sleep(1200);
    const html = await tab.evaluate('document.documentElement ? document.documentElement.outerHTML.slice(0, 30000) : ""').catch(() => '');
    nav.antibot = U.detectAntibot(nav.status || 0, {}, html);
    nav.overlay = await iso(tab, OVERLAY_HIDE.toString()).catch(() => []);
    if (nav.overlay.length) await U.sleep(200);
    if (freeze) await freezeTab(tab);
  }
  return { tab, nav, autoDarkMethod };
}
async function freezeTab(tab) {
  await tab.evaluate(`(${FREEZE.toString()})()`).catch(() => {});
  try { await tab.send('Animation.enable'); await tab.send('Animation.setPlaybackRate', { playbackRate: 0 }); } catch {}
}

// WCAG 2.3.1 estimate: ~12 frames 100 ms apart, mean L* of the whole first screen and of its quarters.
// A flash = two opposite changes of ≥ 10 L* where the darker frame is below L* 92 (relative luminance 0.8).
async function flashSample(tab, tool, run, base) {
  const moving = await tab.evaluate(`(() => { let a = 0; try { a = document.getAnimations().filter(x => x.playState === 'running').length; } catch (e) {}
    return { animations: a, videos: [...document.querySelectorAll('video')].filter(v => !v.paused && !v.ended).length, canvas: document.querySelectorAll('canvas').length, vw: innerWidth, vh: innerHeight }; })()`).catch(() => null);
  if (!moving) return null;
  const { vw, vh, ...what } = moving;
  if (!what.animations && !what.videos && !what.canvas) return { skipped: 'static', ...what };
  const files = []; const t0 = Date.now();
  try {
    for (let k = 0; k < 12; k++) {
      const t = Date.now();
      const { data } = await tab.send('Page.captureScreenshot', { format: 'jpeg', quality: 50, clip: { x: 0, y: 0, width: vw, height: vh, scale: 0.25 } });
      const abs = join(run, 'measure', 'vision', `_flash-${base}-${String(k).padStart(2, '0')}.jpg`);
      writeFileSync(abs, Buffer.from(data, 'base64')); files.push({ abs, t: t - t0 });
      const wait = 100 - (Date.now() - t); if (wait > 0) await U.sleep(wait);
    }
    const sz = imageSize(files[0].abs); const W = sz ? sz.w : 0, H = sz ? sz.h : 0;
    const regions = { all: null, q1: [0, 0, W / 2, H / 2], q2: [W / 2, 0, W / 2, H / 2], q3: [0, H / 2, W / 2, H / 2], q4: [W / 2, H / 2, W / 2, H / 2] };
    const series = Object.fromEntries(Object.keys(regions).map(k => [k, []]));
    for (const f of files) for (const [k, box] of Object.entries(regions)) {
      const s = await imageStats(tool, f.abs, { box: box && W ? box.map(Math.round) : null, sampleStep: 2 }).catch(() => null);
      series[k].push(s ? s.meanL : null);
    }
    const dur = Math.max(1, files[files.length - 1].t - files[0].t) / 1000;
    const res = {};
    for (const [k, ls] of Object.entries(series)) {
      const v = ls.filter(x => typeof x === 'number'); let maxD = 0; const sig = [];
      for (let i = 1; i < v.length; i++) { const d = v[i] - v[i - 1]; maxD = Math.max(maxD, Math.abs(d)); if (Math.abs(d) >= 10 && Math.min(v[i], v[i - 1]) < 92) sig.push(Math.sign(d)); }
      let flashes = 0; for (let i = 1; i < sig.length; i++) if (sig[i] !== sig[i - 1]) { flashes++; i++; }
      res[k] = { max_delta_L: Math.round(maxD), flashes, per_sec: Math.round(10 * flashes / dur) / 10 };
    }
    const worst = Math.max(...Object.values(res).map(r => r.per_sec));
    // the step equals the speed of captureScreenshot (often 150–300 ms on a busy machine): 3 flashes/s are caught
    // reliably only from ~7 frames per second
    const hz = Math.round(10 * (files.length - 1) / dur) / 10;
    const low = hz < 7;
    return { ...what, frames: files.length, duration_ms: Math.round(dur * 1000), sample_hz: hz, confidence: low ? 'low' : 'normal', regions: res, flashes_per_sec_max: worst, risk: worst >= 3,
      meanL: series.all.map(x => (x === null ? null : Math.round(x))),
      note: LANG === 'en'
        ? `estimate from first-screen frames at ${hz} Hz${low ? ' (below 7 Hz: flashes of 3/s may be missed — check by eye)' : ''}; the whole video was not watched`
        : `оценка по кадрам первого экрана, ${hz} кадров/с${low ? ' (ниже 7 Гц: вспышки 3/с можно пропустить — досмотреть глазами)' : ''}; ролик целиком не смотрели` };
  } finally { for (const f of files) { try { rmSync(f.abs, { force: true }); } catch {} } }
}

async function snap(tab, run, file) {
  const abs = join(run, 'measure', 'vision', file);
  await tab.screenshot({ path: abs, format: 'jpeg', quality: 70 });
  return abs;
}
async function regionUniform(tool, abs, box, dpr) {
  const b = box.map(v => Math.max(0, Math.round(v * dpr)));
  if (b[2] < 2 || b[3] < 2) return null;
  try { const s = await imageStats(tool, abs, { box: b, sampleStep: 1 }); return { uniform: (s.palette[0]?.share || 0) >= 92, top_share: s.palette[0]?.share || 0, tones: s.distinctTones }; }
  catch { return null; }
}

// ---------- units ----------
async function foldUnit(b, tool, pg, w, ctx) {
  const { run, lang } = ctx;
  const mobile = w < 600; const h = mobile ? 844 : 900;
  const base = `${safeName(pg.pid)}-${w}`;
  const item = { pid: pg.pid, url: pg.url, width: w, height: h, shots: {}, sheet: null };
  const files = [];
  const add = (key, abs, label) => { item.shots[key] = rel(run, abs); files.push({ path: abs, label }); };
  // 1) light page: normal, simulations, more contrast, forced colours
  // the phone width also samples motion for flashes (before animations are frozen)
  const A = await openTab(b, pg.url, { w, h, mobile, freeze: !mobile });
  let info, iconsNormal = [];
  try {
    if (!A.nav.ok) throw new Error(A.nav.refused ? `refused_${A.nav.refused}` : (A.nav.error || 'load failed'));
    if (A.nav.antibot || A.nav.status >= 400) { item.blocked = A.nav.antibot || `http ${A.nav.status}`; return item; }
    if (mobile) { item.flash = await flashSample(A.tab, tool, run, base).catch(e => ({ error: e.message.slice(0, 120) })); await freezeTab(A.tab); }
    if (A.nav.overlay && A.nav.overlay.length) item.overlay_hidden = A.nav.overlay[0];
    info = await iso(A.tab, PAGE_INFO.toString());
    const dpr = info.dpr || (mobile ? 2 : 1);
    item.css = await collectCssFlags(A.tab, pg.url);
    const normal = await snap(A.tab, run, `${base}-normal.jpg`); add('normal', normal, lang === 'en' ? 'normal' : 'обычный');
    const sNormal = await imageStats(tool, normal);
    item.brightness = { normal: slimStats(sNormal) };
    for (const ic of info.icons) iconsNormal.push(await regionUniform(tool, normal, ic.box, dpr));
    item.icons = info.icons;
    item.text_contrast_light = await iso(A.tab, TEXT_CONTRAST.toString(), 2).catch(e => ({ error: e.message.slice(0, 100) }));
    for (const t of SIMS) {
      await A.tab.emulateVision(t); await U.sleep(250);
      add(t, await snap(A.tab, run, `${base}-${t}.jpg`), t);
    }
    await A.tab.emulateVision('none');
    await A.tab.emulateMedia({ colorScheme: 'light', contrast: 'more' }); await U.sleep(400);
    const more = await snap(A.tab, run, `${base}-more-contrast.jpg`); add('more_contrast', more, 'prefers-contrast: more');
    const sMore = await imageStats(tool, more);
    item.more_contrast = { has_rules: item.css.more_contrast, diff: statsDiff(sNormal, sMore), changed: (statsDiff(sNormal, sMore) || 0) > 1.5 };
    if (!mobile) {
      await A.tab.emulateMedia({ colorScheme: 'dark', forcedColors: 'active' }); await U.sleep(500);
      const forced = await snap(A.tab, run, `${base}-forced-colors.jpg`); add('forced', forced, 'forced-colors (dark)');
      const icons = [];
      for (let k = 0; k < info.icons.length; k++) {
        const f = await regionUniform(tool, forced, info.icons[k].box, dpr); const n0 = iconsNormal[k];
        icons.push({ ...info.icons[k], uniform_normal: n0 ? n0.uniform : null, uniform_forced: f ? f.uniform : null, vanished: !!(n0 && f && !n0.uniform && f.uniform) });
      }
      item.forced = { has_rules: item.css.forced, icons, vanished: icons.filter(i => i.vanished).length, buttons_no_border: info.buttons_no_border, buttons_no_border_samples: info.buttons_no_border_samples,
        brightness: slimStats(await imageStats(tool, forced)), note: lang === 'en' ? 'emulated in Chromium (dark contrast theme)' : 'эмуляция в Chromium (тёмная контрастная тема)' };
    }
    await A.tab.emulateMedia({ colorScheme: 'light' });
    // links marked by colour only
    const links = info.links.color_only.map(l => {
      const a = U.parseColor(l.link_color), t = U.parseColor(l.text_color); if (!a || !t) return { ...l };
      const contrast = U.wcagContrast(a, t); const sims = {}; const indistinct = [];
      for (const type of ['protanopia', 'deuteranopia', 'tritanopia', 'achromatopsia']) { const d = deltaE(simulate(a, type), simulate(t, type)); sims[type] = d; if (d < 12) indistinct.push(type); }
      return { ...l, contrast, fails_3to1: contrast < 3, delta_e: deltaE(a.slice(0, 3), t.slice(0, 3)), sims_delta_e: sims, indistinct };
    });
    item.links_color_only = { checked: info.links.checked, count: links.length, fails_3to1: links.filter(l => l.fails_3to1).length, items: links.slice(0, 12),
      norm: lang === 'en' ? 'WCAG 1.4.1: a link in text differs by more than colour, or has ≥ 3:1 contrast with the text plus a hover/focus cue' : 'WCAG 1.4.1: ссылка в тексте отличается не только цветом, или контраст с текстом ≥ 3:1 плюс отличие при наведении/фокусе' };
    item.theme = { color_scheme_meta: info.color_scheme_meta, root_color_scheme: info.root_color_scheme, theme_colors: info.theme_colors, body_bg_light: info.body_bg, html_bg_light: info.html_bg };
    item.logos = info.logos;
    if (info.logos.length) item.logo_light = await Promise.all(info.logos.map(l => regionUniform(tool, normal, l.box, dpr)));
  } finally { await A.tab.close(); }

  // 2) dark preference: fresh load so JS that reads matchMedia at start also switches
  const B = await openTab(b, pg.url, { w, h, mobile, scheme: 'dark' });
  let sDark = null, darkAbs = null;
  try {
    if (B.nav.ok && !B.nav.antibot) {
      darkAbs = await snap(B.tab, run, `${base}-dark.jpg`); add('dark', darkAbs, 'prefers-color-scheme: dark');
      sDark = await imageStats(tool, darkAbs);
      const tcDark = await iso(B.tab, TEXT_CONTRAST.toString(), 2).catch(e => ({ error: e.message.slice(0, 100) }));
      const infoDark = await B.tab.evaluate(`(() => { const m = [...document.querySelectorAll('meta[name="theme-color"]')].find(x => !x.media || matchMedia(x.media).matches); return { theme: m ? m.getAttribute('content') : null, body_bg: getComputedStyle(document.body).backgroundColor, html_bg: getComputedStyle(document.documentElement).backgroundColor }; })()`).catch(() => ({}));
      const diff = statsDiff(item.brightness.normal, slimStats(sDark));
      const metaDark = /dark/i.test(String(item.theme.color_scheme_meta || '')) || /dark/i.test(String(item.theme.root_color_scheme || ''));
      // a dark theme exists when the page really changes: a rule in some CSS file is not enough (widgets and
      // libraries ship unused ones); color-scheme: dark counts only together with a noticeable change
      const supported = (diff || 0) > 12 || (metaDark && (diff || 0) > 3);
      const lowLightSel = new Set(((item.text_contrast_light && item.text_contrast_light.low) || []).map(x => x.sel));
      const newLow = ((tcDark && tcDark.low) || []).filter(x => !lowLightSel.has(x.sel));
      item.dark = { supported, signals: { css_rules: item.css.dark, css_rules_third_party: item.css.dark_third_party, meta: item.theme.color_scheme_meta, root_color_scheme: item.theme.root_color_scheme, screenshot_diff: diff },
        dark_rules_no_effect: !supported && !!item.css.dark,
        meanL_light: item.brightness.normal.meanL, meanL_dark: sDark.meanL, white_share_dark: sDark.whiteShare,
        large_white_areas: supported && sDark.whiteShare >= 40,
        low_contrast_light: item.text_contrast_light ? item.text_contrast_light.low_count : null, low_contrast_dark: tcDark ? tcDark.low_count : null, new_low_contrast: newLow.slice(0, 10),
        theme_color_dark: infoDark.theme || null, body_bg_dark: infoDark.body_bg || null };
      item.brightness.dark = slimStats(sDark);
      if (item.logos && item.logos.length) {
        const dpr = mobile ? 2 : 1; const ld = await Promise.all(item.logos.map(l => regionUniform(tool, darkAbs, l.box, dpr)));
        item.dark.logo = item.logos.map((l, k) => ({ sel: l.sel, light_uniform: item.logo_light?.[k]?.uniform ?? null, dark_uniform: ld[k]?.uniform ?? null, lost: !!(item.logo_light?.[k] && ld[k] && !item.logo_light[k].uniform && ld[k].uniform) }));
      }
    } else item.dark = { error: B.nav.error || B.nav.antibot || 'load failed' };
  } finally { await B.tab.close(); }

  // theme-color should match the page background
  const tcMatch = (tc, bg) => { const a = U.parseColor(tc), c = U.parseColor(bg); if (!a || !c || c[3] === 0) return null; return deltaE(a.slice(0, 3), c.slice(0, 3)) < 6; };
  const tcLight = (item.theme.theme_colors.find(t => !t.media || !/dark/i.test(t.media)) || {}).content || null;
  item.theme.theme_color_light = tcLight;
  item.theme.match_light = tcLight ? tcMatch(tcLight, item.theme.body_bg_light !== 'rgba(0, 0, 0, 0)' ? item.theme.body_bg_light : item.theme.html_bg_light) : null;
  if (item.dark && item.dark.theme_color_dark) item.theme.match_dark = tcMatch(item.dark.theme_color_dark, item.dark.body_bg_dark);

  // 3) browser auto-dark (phones: Chrome Android, Samsung Internet, Yandex Browser) when the site has no own dark theme
  if (mobile && item.dark && item.dark.supported === false) {
    const onlyLight = /only\s+light|light\s+only/i.test(String(item.theme.color_scheme_meta || '')) || /only/.test(String(item.theme.root_color_scheme || ''));
    const C = await openTab(b, pg.url, { w, h, mobile, scheme: 'dark', autoDark: !onlyLight });
    try {
      if (C.nav.ok && !C.nav.antibot) {
        let method = C.autoDarkMethod;
        if (!method) {
          await C.tab.evaluate(`(() => { const s = document.createElement('style'); s.textContent = 'html{filter:invert(1) hue-rotate(180deg)!important;background:#fff} img,video,picture,canvas,iframe,[style*="background-image"]{filter:invert(1) hue-rotate(180deg)!important}'; document.documentElement.appendChild(s); })()`).catch(() => {});
          await U.sleep(300); method = 'css-invert';
        }
        const abs = await snap(C.tab, run, `${base}-autodark.jpg`); add('autodark', abs, lang === 'en' ? 'auto-dark (emulation)' : 'авто-затемнение (эмуляция)');
        const s = await imageStats(tool, abs);
        item.autodark = { method: onlyLight ? 'none (color-scheme: only light)' : method, opted_out: onlyLight, brightness: slimStats(s), applied: (statsDiff(item.brightness.normal, slimStats(s)) || 0) > 12,
          note: lang === 'en' ? 'emulation: Samsung Internet and Yandex Browser recolour by their own rules' : 'эмуляция: Samsung Internet и Яндекс Браузер перекрашивают по своим правилам' };
        if (item.logos && item.logos.length) {
          const la = await Promise.all(item.logos.map(l => regionUniform(tool, abs, l.box, 2)));
          item.autodark.logo = item.logos.map((l, k) => ({ sel: l.sel, lost: !!(item.logo_light?.[k] && la[k] && !item.logo_light[k].uniform && la[k].uniform) }));
        }
        // icon-only buttons (burger, search) that dissolve into the darkened background
        const lostIcons = [];
        for (let k = 0; k < (item.icons || []).length; k++) {
          const n0 = iconsNormal[k]; if (!n0 || n0.uniform) continue;
          const d = await regionUniform(tool, abs, item.icons[k].box, 2);
          if (d && d.uniform) lostIcons.push({ sel: item.icons[k].sel, kind: item.icons[k].kind, label: item.icons[k].label, box: item.icons[k].box });
        }
        item.autodark.icons_lost = lostIcons;
      }
    } finally { await C.tab.close(); }
  }
  // contact sheet
  try {
    const sheetAbs = join(run, 'measure', 'vision', `sheet-${base}.jpg`);
    await contactSheet(tool, files, { out: sheetAbs, cols: mobile ? 6 : 4, thumbWidth: mobile ? 220 : 360 });
    item.sheet = rel(run, sheetAbs);
  } catch (e) { item.sheet_error = e.message.slice(0, 120); }
  delete item.logo_light;
  return item;
}

// PDF through an IO stream (a big document in one CDP message is slow and heavy); counts pages on the fly.
const PAGE_RE = /\/Type\s*\/Page(?!s)\b/g;
async function printPdf(tab, opts, { keep = false, maxBytes = 300 * 1024 * 1024 } = {}) {
  const r = await tab.send('Page.printToPDF', { ...opts, transferMode: 'ReturnAsStream' }, 180000);
  const parts = []; let bytes = 0, pages = 0, tail = '', truncated = false;
  try {
    for (;;) {
      const c = await tab.send('IO.read', { handle: r.stream, size: 4 * 1024 * 1024 });
      const buf = Buffer.from(c.data || '', c.base64Encoded ? 'base64' : 'latin1');
      bytes += buf.length; if (keep) parts.push(buf);
      const txt = tail + buf.toString('latin1');
      pages += (txt.match(PAGE_RE) || []).length - (tail.match(PAGE_RE) || []).length;
      tail = txt.slice(-24);
      if (c.eof) break;
      if (bytes > maxBytes) { truncated = true; break; }
    }
  } finally { try { await tab.send('IO.close', { handle: r.stream }); } catch {} }
  return { buf: keep ? Buffer.concat(parts) : null, bytes, pages, truncated };
}

async function printUnit(b, tool, pg, ctx) {
  const { run, lang } = ctx;
  const item = { pid: pg.pid, url: pg.url };
  const A = await openTab(b, pg.url, { w: 1440, h: 900, mobile: false });
  try {
    if (!A.nav.ok) throw new Error(A.nav.error || 'load failed');
    if (A.nav.antibot || A.nav.status >= 400) { item.blocked = A.nav.antibot || `http ${A.nav.status}`; return item; }
    if (A.nav.overlay && A.nav.overlay.length) item.overlay_hidden = A.nav.overlay[0];
    const flags = await collectCssFlags(A.tab, pg.url);
    const printLinks = await A.tab.evaluate(`document.querySelectorAll('link[rel~="stylesheet"][media*="print" i], style[media*="print" i]').length`).catch(() => 0);
    item.has_print_css = flags.print || flags.page_rule || printLinks > 0;
    await A.tab.emulateMedia({ colorScheme: 'light', printMedia: true });
    // A4 at 96 dpi with Chrome's default ~1 cm margins: 718 × 1047 CSS px of printable area
    await A.tab.setViewport({ width: PAPER.w, height: PAPER.h, mobile: false, deviceScaleFactor: 1 });
    await U.sleep(600);
    await A.tab.evaluate('window.scrollTo(0, 0)').catch(() => {});
    const info = await iso(A.tab, PRINT_INFO.toString());
    const abs = join(run, 'measure', 'vision', `print-${safeName(pg.pid)}.jpg`);
    // a screenshot paints screen backgrounds; paper (printBackground: false) doesn't, and Chrome darkens light text
    const paper = await iso(A.tab, PAPER_ON.toString()).catch(() => null);
    await U.sleep(150);
    await A.tab.screenshot({ path: abs, format: 'jpeg', quality: 70 });
    await iso(A.tab, PAPER_OFF.toString()).catch(() => {});
    const s = await imageStats(tool, abs);
    await A.tab.emulateMedia({ colorScheme: 'light' });
    const opts = { printBackground: false, paperWidth: 8.27, paperHeight: 11.69, preferCSSPageSize: true };
    // first sheet first: printing the whole document can crash headless Chromium on heavy pages
    const first = await printPdf(A.tab, { ...opts, pageRanges: '1' }, { keep: true });
    const pdfAbs = join(run, 'measure', 'vision', `print-${safeName(pg.pid)}.pdf`);
    U.ensureDir(join(run, 'measure', 'vision'));
    writeFileSync(pdfAbs, first.buf);
    const expected = Math.max(1, Math.ceil(info.height / PAPER.h));
    Object.assign(item, { shot: rel(run, abs), pdf: rel(run, pdfAbs), pdf_bytes: statSync(pdfAbs).size, pages_total: null, pages_expected: expected, content_height: info.height,
      blank_suspected: null, cut_right_px: info.cut_right_px, wide_elements: info.wide,
      fixed_visible: info.fixed_visible, nav_visible: info.nav_visible, light_text: info.light_text, light_text_screen: info.light_text_screen, light_samples: info.light_samples, links_show_url: info.links_show_url,
      light_text_note: lang === 'en' ? 'light_text — by printed colours (Chrome darkens light text without backgrounds); light_text_screen — by screen colours' : 'light_text — по печатным цветам (Chrome затемняет светлый текст без фонов); light_text_screen — по экранным',
      paper_emulation: paper, shot_note: lang === 'en' ? 'print shot: screen backgrounds removed, light text darkened as in Chrome; the exact look of the first sheet is the PDF' : 'кадр печати: экранные фоны убраны, светлый текст затемнён как в Chrome; точный вид первого листа — PDF',
      videos: info.videos, iframes: info.iframes, brightness: slimStats(s), paper: lang === 'en' ? 'A4, backgrounds not printed (browser default)' : 'A4, фон не печатается (как по умолчанию в браузере)' });
    try {
      const full = await printPdf(A.tab, opts);
      Object.assign(item, { pages_total: full.pages, full_pdf_bytes: full.bytes, full_truncated: full.truncated || undefined, blank_suspected: full.pages > expected + 1 });
    } catch (e) {
      item.full_print_error = (b.closed ? (lang === 'en' ? 'the browser crashed while printing the whole page (Chromium); the first sheet is saved' : 'браузер упал при печати всей страницы (Chromium); первый лист сохранён') : e.message).slice(0, 160);
      if (b.closed) item.browser_crashed = true;
    }
    return item;
  } finally { if (!b.closed) await A.tab.close(); }
}

// ---------- summary ----------
function cut(s, n) { s = String(s || ''); if (s.length <= n) return s; const k = s.lastIndexOf(' ', n - 1); return s.slice(0, k > n * 0.6 ? k : n - 1).replace(/[\s,;:—–-]+$/, '') + '…'; }
function buildSummary(out) {
  const it = out.items.filter(i => !i.blocked && !i.error);
  const darkRows = it.filter(i => i.dark && i.dark.supported !== undefined);
  return {
    pages: [...new Set(out.items.map(i => i.pid))], widths: [...new Set(out.items.map(i => i.width))],
    dark_supported: darkRows.length ? darkRows.some(i => i.dark.supported) : null,
    dark_pages_yes: [...new Set(darkRows.filter(i => i.dark.supported).map(i => i.pid))], dark_pages_no: [...new Set(darkRows.filter(i => !i.dark.supported).map(i => i.pid))],
    dark_rules_no_effect: [...new Set(darkRows.filter(i => i.dark.dark_rules_no_effect).map(i => i.pid))],
    dark_new_low_contrast: darkRows.reduce((a, i) => a + ((i.dark.new_low_contrast || []).length), 0),
    dark_logo_lost: darkRows.filter(i => (i.dark.logo || []).some(l => l.lost)).map(i => `${i.pid}@${i.width}`),
    dark_large_white: darkRows.filter(i => i.dark.large_white_areas).map(i => `${i.pid}@${i.width}`),
    autodark: it.filter(i => i.autodark).map(i => ({ pid: i.pid, method: i.autodark.method, applied: i.autodark.applied, logo_lost: (i.autodark.logo || []).some(l => l.lost), icons_lost: (i.autodark.icons_lost || []).length })),
    flash_risk: it.filter(i => i.flash && i.flash.risk).map(i => ({ pid: i.pid, per_sec: i.flash.flashes_per_sec_max, sample_hz: i.flash.sample_hz ?? null })),
    flash_low_confidence: it.filter(i => i.flash && i.flash.confidence === 'low').map(i => ({ pid: i.pid, sample_hz: i.flash.sample_hz })),
    motion_pages: it.filter(i => i.flash && !i.flash.skipped && !i.flash.error).map(i => i.pid),
    overlay_hidden: [...new Set([...it.filter(i => i.overlay_hidden).map(i => i.pid), ...out.print.filter(p => p.overlay_hidden).map(p => p.pid)])],
    pure_black: it.filter(i => i.brightness?.normal && i.brightness.normal.blackShare >= 40).map(i => `${i.pid}@${i.width}`),
    forced_vanished: it.reduce((a, i) => a + (i.forced ? i.forced.vanished : 0), 0), forced_rules: it.some(i => i.forced && i.forced.has_rules),
    buttons_no_border: Math.max(0, ...it.map(i => (i.forced ? i.forced.buttons_no_border : 0))),
    more_contrast_changes: it.some(i => i.more_contrast && i.more_contrast.changed), more_contrast_rules: it.some(i => i.more_contrast && i.more_contrast.has_rules),
    links_color_only: it.reduce((a, i) => a + (i.links_color_only ? i.links_color_only.count : 0), 0), links_fail_3to1: it.reduce((a, i) => a + (i.links_color_only ? i.links_color_only.fails_3to1 : 0), 0),
    low_contrast_light: it.reduce((a, i) => a + (i.text_contrast_light && i.text_contrast_light.low_count || 0), 0),
    brightness: it.map(i => ({ pid: i.pid, w: i.width, meanL: i.brightness?.normal?.meanL ?? null, white: i.brightness?.normal?.whiteShare ?? null, black: i.brightness?.normal?.blackShare ?? null })),
    theme_color_mismatch: it.filter(i => i.theme && (i.theme.match_light === false || i.theme.match_dark === false)).map(i => `${i.pid}@${i.width}`),
    print: out.print.map(p => ({ pid: p.pid, pdf: p.pdf || null, has_print_css: p.has_print_css ?? null, pages: p.pages_total ?? null, expected: p.pages_expected ?? null, light_text: p.light_text ?? null,
      fixed_visible: p.fixed_visible ? p.fixed_visible.length : null, blank_suspected: p.blank_suspected ?? null, cut_right_px: p.cut_right_px ?? null, full_print_error: p.full_print_error || null, error: p.blocked || p.error || null })),
    sheets: it.map(i => i.sheet).filter(Boolean),
    retried: out.retried || [],
  };
}

function summaryLines(out, lang, outFile) {
  const L = T[lang]; const s = out.summary; const lines = [];
  lines.push(`${L.title}${out.partial ? ' — ' + (out.partial_reason === 'slot_wait' ? L.partialSlot : out.subset ? L.partialSubset : L.partial) : ''}`);
  lines.push(`${L.pages}: ${s.pages.join(', ')} · ${s.widths.join(', ')} px${out.subset ? ' · subset' : ''}`);
  lines.push(`${L.dark}: ${s.dark_supported === null ? '—' : `${L.yes}: ${s.dark_pages_yes.join(', ') || '—'}; ${L.no}: ${s.dark_pages_no.join(', ') || '—'}`}${s.dark_supported ? ` · ${L.newLow}: ${s.dark_new_low_contrast}${s.dark_logo_lost.length ? ` · ${L.logoLost}: ${s.dark_logo_lost.join(', ')}` : ''}${s.dark_large_white.length ? ` · ${L.white} ≥ 40 %: ${s.dark_large_white.join(', ')}` : ''}` : ''}${s.dark_rules_no_effect.length ? ` · ${L.noEffect}: ${s.dark_rules_no_effect.join(', ')}` : ''}`);
  for (const a of s.autodark) lines.push(`${L.autodark}: ${a.pid} — ${a.method}${a.applied ? '' : ` (${L.unchanged})`}${a.logo_lost ? ` · ${L.logoLost}` : ''}${a.icons_lost ? ` · ${L.iconsLost}: ${a.icons_lost}` : ''}`);
  lines.push(`${L.flash}: ${s.flash_risk.length ? s.flash_risk.map(f => `${f.pid} ~${f.per_sec}${L.perSec}`).join(', ') : s.motion_pages.length ? `${L.none} (${L.moving}: ${s.motion_pages.join(', ')})` : `${L.none}, ${L.static}`}${s.flash_low_confidence.length ? ` · ${L.lowRate}: ${s.flash_low_confidence.map(f => `${f.pid} ${f.sample_hz}`).join(', ')}` : ''}`);
  if (s.overlay_hidden.length) lines.push(`${L.overlay}: ${s.overlay_hidden.join(', ')}`);
  if (s.pure_black.length) lines.push(`${L.pureBlack}: ${s.pure_black.join(', ')}`);
  lines.push(`${L.forced}: ${L.vanished} ${s.forced_vanished}, ${L.noBorder} ${s.buttons_no_border}${s.forced_rules ? ` · ${L.forcedRules}` : ''}`);
  lines.push(`${L.more}: ${s.more_contrast_changes ? L.changes : L.nochange}${s.more_contrast_rules ? ` (${L.rulesExist})` : ''}`);
  lines.push(`${L.links}: ${s.links_color_only} (${L.below3}: ${s.links_fail_3to1}) · ${L.lowLight}: ${s.low_contrast_light}`);
  for (const i of out.items.filter(x => x.links_color_only && x.links_color_only.items.length).slice(0, 2)) {
    const l = i.links_color_only.items[0]; lines.push(`  · ${i.pid}@${i.width}: «${cut(l.text, 40)}» ${l.link_color} ${L.onText} ${l.text_color}, ${l.contrast}:1${l.indistinct && l.indistinct.length ? `, ${L.indistinct}: ` + l.indistinct.join('/') : ''}`);
  }
  lines.push(`${L.bright}: ${cut(s.brightness.map(b => `${b.pid}@${b.w} L*${b.meanL} ${L.white} ${b.white}%`).join(' · '), 300)}`);
  if (s.theme_color_mismatch.length) lines.push(`${L.themeColor}: ${s.theme_color_mismatch.join(', ')}`);
  for (const p of s.print) lines.push(p.error ? `${L.print} ${p.pid}: ${p.error}` : `${L.print} ${p.pid}: ${p.pages ?? '—'} ${L.sheetsShort} (${L.expected} ~${p.expected ?? '—'}), ${L.printCss} ${p.has_print_css ? L.yes : L.no}, ${L.lightText} ${p.light_text ?? '—'}, ${L.stickyLayers} ${p.fixed_visible ?? '—'}${p.cut_right_px ? `, ${L.cut} ${p.cut_right_px} px` : ''}${p.blank_suspected ? ` · ${L.blank}` : ''}${p.full_print_error ? ` · ${L.fullFail}` : ''}${p.pdf ? ` · ${L.pdf}: ${p.pdf}` : ''}`);
  lines.push(`${L.sheets}: ${s.sheets.length} ${L.sheetsN} (${s.sheets.slice(0, 3).join(', ')})`);
  if (s.retried.length) lines.push(`${L.retried}: ${s.retried.slice(0, 5).join(', ')}`);
  if (out.errors.length) lines.push(`${L.errors}: ${out.errors.length} — ${out.errors.slice(0, 3).map(e => `${e.pid}: ${cut(String(e.error), 60)}`).join('; ')}`);
  if (out.not_checked.length) lines.push(`${L.notChecked}: ${cut(out.not_checked.slice(0, 3).join('; '), 300)}`);
  lines.push(`${L.written}: ${outFile}`);
  return lines.length > 40 ? [...lines.slice(0, 39), lines[lines.length - 1]] : lines;
}

// home + 2 key pages (distinct templates first, then any key page, then whatever is left) out of `from`
function defaultSelection(from, keyRe) {
  const home = from.find(p => p.pid === 'home') || from[0];
  const keys = []; const seenT = new Set([home.template]);
  const isKey = p => keyRe.test(`${p.template || ''} ${p.url} ${p.why || ''}`);
  for (const p of from) { if (p === home || keys.length >= 2) continue; if (isKey(p) && !seenT.has(p.template || p.pid)) { keys.push(p); seenT.add(p.template || p.pid); } }
  for (const p of from) { if (keys.length >= 2) break; if (p !== home && !keys.includes(p) && isKey(p)) keys.push(p); }
  for (const p of from) { if (keys.length >= 2) break; if (p !== home && !keys.includes(p)) keys.push(p); }
  return [home, ...keys];
}

// ---------- main ----------
async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'fresh', 'subset', 'allow-load-posts'] });
  const lang = U.langOf(args); LANG = lang;
  U.helpAndExit(lang === 'en' ? HELP_EN : HELP, args);
  const run = U.requireRun(args);
  const T0 = Date.now();
  const budgetMs = Math.max(30, Number(args['budget-sec']) || 480) * 1000;
  ALLOW_POSTS = !!args['allow-load-posts'];

  let all;
  if (existsSync(join(run, 'pages.json'))) all = U.loadPages(run, {});
  else if (args.url && args.url !== true) all = [{ pid: 'home', url: U.normalizeUrl(args.url), template: 'home' }];
  else { console.error(lang === 'en' ? 'No pages.json and no --url.' : 'Нет pages.json и не задан --url.'); process.exit(2); }
  all = all.filter(p => p && p.url && !p.blocked);
  if (!all.length) { console.error(lang === 'en' ? 'No pages to check.' : 'Нет страниц для проверки.'); process.exit(2); }
  for (const p of all) { const h = U.hostOf(p.url); if (isLocalHost(h)) U.allowPrivateHost(h); }

  const onlyPids = U.listArg(args.pages);
  const printArg = U.listArg(args['print-pages']);
  const widthsRaw = U.listArg(args.widths);
  const widths = widthsRaw.map(Number).filter(n => n >= 200 && n <= 3000);
  if (widthsRaw.length && widths.length !== widthsRaw.length) { console.error(lang === 'en' ? `Bad --widths ${widthsRaw.join(',')} (example: 390,1440; 200–3000 px)` : `Неверный --widths ${widthsRaw.join(',')} (пример: 390,1440; 200–3000 px)`); process.exit(2); }
  const W = widths.length ? widths : [390, 1440];
  // --pages alone filters the main file (pipeline, resume); --subset, --widths, --print-pages write a separate file
  const subset = !!(args.subset || widths.length || printArg.length);
  const allowed = onlyPids.length ? all.filter(p => onlyPids.includes(p.pid)) : all;
  if (!allowed.length) { console.error(lang === 'en' ? `None of --pages ${onlyPids.join(',')} is in pages.json.` : `Ни одной страницы из --pages ${onlyPids.join(',')} нет в pages.json.`); process.exit(2); }
  const keyRe = /(price|prices|pricing|tarif|ceny|tseny|stoimost|uslug|services|catalog|katalog|product|kontakt|contact|menu)/i;
  // subset with --pages: exactly these pages; otherwise the usual set (home + 2 key pages) out of the allowed ones
  const pages = subset && onlyPids.length ? allowed : defaultSelection(allowed, keyRe);
  const printRe = /(kontakt|contact|price|prices|pricing|tarif|ceny|tseny|prais|menu|schedule|raspisan|ticket|bilet|dogovor|docs|recipe|recept)/i;
  let printPages;
  if (printArg.length) printPages = all.filter(p => printArg.includes(p.pid));
  else if (subset && onlyPids.length) printPages = [];
  else {
    printPages = allowed.filter(p => p.pid !== 'home' && printRe.test(`${p.template || ''} ${p.url} ${p.why || ''}`)).slice(0, 2);
    if (!printPages.length) printPages = [allowed.find(p => p.pid === 'home') || allowed[0]];
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const outFile = join(run, 'measure', subset ? `vision.subset-${stamp}.json` : 'vision.json');
  // a subset never overwrites the shared summary other agents read first
  const stdoutFile = join(run, 'stdout', subset ? `${NAME}.subset-${stamp}.md` : `${NAME}.md`);
  U.ensureDir(join(run, 'measure', 'vision'));

  const units = [];
  for (const p of pages) for (const w of W) units.push({ id: `fold:${p.pid}@${w}`, kind: 'fold', pg: p, w });
  for (const p of printPages) units.push({ id: `print:${p.pid}`, kind: 'print', pg: p });

  // resume a partial main file; a finished one + --pages: re-measure these units, keep the other pages
  let out = null;
  if (!subset && !args.fresh && existsSync(outFile)) {
    const prev = U.readJSON(outFile, null);
    if (prev && prev.tool === NAME && Array.isArray(prev.items)) {
      if (prev.partial && prev.resume && Array.isArray(prev.resume.done)) out = prev;
      else if (onlyPids.length) {
        out = prev; const ids = new Set(units.map(u => u.id)); const pids = new Set(units.map(u => u.pg.pid));
        out.resume = { done: (prev.done || []).filter(id => !ids.has(id)) };
        out.errors = (out.errors || []).filter(e => !ids.has(e.pid)); out.not_checked = (out.not_checked || []).filter(x => ![...pids].some(pid => String(x).startsWith(pid + '@') || String(x).startsWith(pid + ':')));
        out.attempts = {};
      }
    }
  }
  if (!out) out = { ...U.measureHeader(NAME, run), partial: false, resume: { done: [] }, widths: W, simulations: SIMS,
    method: lang === 'en'
      ? 'headless Chromium via CDP: Emulation.setEmulatedVisionDeficiency, setEmulatedMedia (prefers-color-scheme, forced-colors, prefers-contrast, print), setAutoDarkModeOverride; Page.printToPDF. Emulation, not real devices and OS'
      : 'headless Chromium через CDP: Emulation.setEmulatedVisionDeficiency, setEmulatedMedia (prefers-color-scheme, forced-colors, prefers-contrast, print), setAutoDarkModeOverride; Page.printToPDF. Это эмуляция, не настоящие устройства и ОС',
    items: [], print: [], attempts: {}, retried: [] };
  out.attempts ||= {}; out.retried ||= []; out.print ||= [];
  if (subset) out.subset = { pages: onlyPids, widths, print_pages: printArg };
  const done = new Set(out.resume?.done || out.done || []);

  const writeOut = (partial) => {
    out.partial = partial; out.resume = partial ? { done: [...done] } : null; out.done = [...done];
    out.generated = U.nowIso(); out.pages = [...new Set([...out.items.map(i => i.pid), ...out.print.map(p => p.pid)])];
    out.summary = buildSummary(out);
    U.writeJSON(outFile, out);
  };
  const ctx = { run, lang };
  let b = null, tool = null, release = null, partial = false, progressed = 0, slotBusy = false; const durations = [];
  try {
    // wait for a browser only within the budget; no slot -> partial + 75 (slot_wait), the same call continues
    delete out.partial_reason; delete out.slot_wait_sec; out.not_checked = (out.not_checked || []).filter(x => !/slot_wait/.test(String(x)));
    const tw = Date.now();
    try { release = await U.acquireBrowserSlot({ waitMs: Math.max(5000, budgetMs - (Date.now() - T0) - 15000) }); }
    catch (e) {
      if (e.code !== 'SLOT_TIMEOUT') throw e;
      slotBusy = true; out.slot_wait_sec = Math.round((Date.now() - tw) / 1000); out.partial_reason = 'slot_wait';
      out.not_checked.push(lang === 'en' ? `browser busy with other checks (slot_wait, waited ${out.slot_wait_sec} s) — repeat the call` : `браузер занят другими проверками (slot_wait, ждали ${out.slot_wait_sec} с) — повторите вызов`);
      U.log(run, `vision: ждал свободный браузер ${out.slot_wait_sec} с, не дождался (slot_wait)`);
      throw e;
    }
    b = await Browser.launch();
    tool = await b.newPage({ blockNavigation: true });
    U.log(run, `vision: старт, страниц ${pages.length}, ширины ${W.join(',')}${subset ? ', subset' : onlyPids.length ? ', фильтр --pages' : ''}${ALLOW_POSTS ? ', allow-load-posts' : ''}`);
    // pass 1 — all units; pass 2 — units that failed once (a second failure is final)
    let queue = units.filter(u => !done.has(u.id));
    for (let pass = 1; pass <= 2 && queue.length && !partial; pass++) {
      const retry = [];
      for (const u of queue) {
        const avg = durations.length ? durations.reduce((a, x) => a + x, 0) / durations.length : 40000;
        if (progressed > 0 && Date.now() - T0 + avg * 1.2 > budgetMs - 8000) { partial = true; break; }
        const t1 = Date.now(); U.progress(`vision: ${u.id}${pass > 1 ? ' (retry)' : ''}`);
        const attempt = (out.attempts[u.id] || 0) + 1; out.attempts[u.id] = attempt;
        let failed = false;
        try {
          if (u.kind === 'fold') {
            const item = await foldUnit(b, tool, u.pg, u.w, ctx);
            out.items = out.items.filter(i => !(i.pid === item.pid && i.width === item.width)); out.items.push(item);
            if (item.blocked) out.not_checked.push(`${item.pid}@${item.width}: ${item.blocked}`);
            if (item.flash && item.flash.confidence === 'low') out.not_checked.push(lang === 'en'
              ? `${item.pid}@${item.width}: flashes — ${item.flash.sample_hz} frames/s (< 7 Hz), 3 flashes/s may be missed; check by eye`
              : `${item.pid}@${item.width}: вспышки — ${item.flash.sample_hz} кадров/с (< 7 Гц), 3 вспышки/с можно пропустить; досмотреть глазами`);
          } else {
            const item = await printUnit(b, tool, u.pg, ctx);
            out.print = out.print.filter(i => i.pid !== item.pid); out.print.push(item);
          }
        } catch (e) { failed = true; out.errors.push({ pid: u.id, unit: u.id, attempt, error: e.message.slice(0, 200) }); }
        if (b.closed) { // a crashed browser takes the next units down with it: start a fresh one
          U.progress('vision: browser crashed, relaunching');
          try { await b.close(); } catch {}
          b = await Browser.launch(); tool = await b.newPage({ blockNavigation: true });
        }
        if (failed && attempt < 2) retry.push(u);
        else {
          done.add(u.id);
          if (!failed && attempt > 1) { out.errors = out.errors.filter(e => e.unit !== u.id); if (!out.retried.includes(u.id)) out.retried.push(u.id); }
        }
        progressed++; durations.push(Date.now() - t1);
        if (!subset) writeOut(true);
      }
      queue = retry;
    }
    if (!W.some(w => w >= 1024) && !out.not_checked.some(x => /forced-colors/.test(x))) out.not_checked.push(lang === 'en' ? 'forced-colors: only checked at desktop widths' : 'forced-colors: проверяется только на ширине ноутбука');
    if (!out.not_checked.some(x => /Windows|iPhone|устройств|device/.test(x))) out.not_checked.push(lang === 'en'
      ? 'real devices: Windows contrast themes, iOS «Increase contrast», Samsung Internet / Yandex Browser dark modes are emulated, check on a device'
      : 'настоящие устройства: контрастные темы Windows, «Увеличение контраста» iOS, тёмные режимы Samsung Internet и Яндекс Браузера — эмуляция, проверить на устройстве');
  } catch (e) {
    if (!slotBusy) out.errors.push({ pid: '-', error: e.message.slice(0, 300) });
    writeOut(true);
    const lines = summaryLines(out, lang, rel(run, outFile) + (subset ? ' · ' + rel(run, stdoutFile) : ''));
    U.writeText(stdoutFile, lines.join('\n') + '\n');
    U.printSummary(lines);
    if (slotBusy) { process.exitCode = 75; return; }
    console.error(e.message);
    process.exitCode = /браузер|browser|Node/i.test(e.message) ? 2 : 1;
    return;
  } finally {
    try { if (b) await b.close(); } catch {}
    if (release) release();
  }
  writeOut(partial);
  const lines = summaryLines(out, lang, rel(run, outFile) + (subset ? ' · ' + rel(run, stdoutFile) : ''));
  U.writeText(stdoutFile, lines.join('\n') + '\n');
  U.printSummary(lines);
  U.log(run, `vision: ${partial ? 'частично' : 'готово'} за ${Math.round((Date.now() - T0) / 1000)} с`);
  process.exitCode = partial ? 75 : 0;
}

main().catch(e => { console.error(e?.stack || e); process.exitCode = 1; });
