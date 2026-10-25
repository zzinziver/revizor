#!/usr/bin/env node
// Revizor a11y.mjs — accessibility checks that need a live browser and real keyboard input:
//  keyboard Tab ×N at 1440 and 390 (focus ring before/after styles, 2.4.11 via elementFromPoint centre+corners,
//  traps, focus on invisible elements, tabindex>0, iframe stops), skip link, dialog/menu opened from the keyboard
//  (focus moved in, Tab stays inside, Esc, focus returned, axe on the open dialog), linear reading of the
//  accessibility tree (role · name · state) for header / first screen / form / footer, reflow at 320 CSS px,
//  zoom 200 % (720×450), text spacing 1.4.12, prefers-reduced-motion (getAnimations before/after),
//  auto-moving content > 5 s without pause, zoom blocked, iframes without title.
// axe itself runs as a snapshot collector (collectors/axe.mjs); here it is only used on an opened dialog.
// All page-side code runs in the isolated world of lib/cdp (same DOM, own JS globals): the site cannot fake results.
// Safety: lib/cdp.mjs (non-GET cut, counters cut, navigations aborted, interaction guard after every key and click).
// Keys: Tab and Esc anywhere. Enter/Space/arrows only when the focus is verified to be on the element and the element
// is on the white list of toggles: <summary>, [aria-expanded], [aria-controls], [aria-haspopup], role=tab,
// data-(bs-)toggle, accordion/collapse classes, burger, a #hash link to a hidden block of this page, or (second tier)
// a plain button / «#» link with popup|modal|callback… in class/id/data-* or an opener name («Записаться») — and never
// a submit button, anything in a form or next to contact fields, anything in a cookie/consent banner, tel:/mailto:,
// javascript: links with code, links to other pages, or names of actions (send, pay, buy, order, vote, like…).
// Enter on a skip link (#hash) and on a strict close button (× / «Закрыть», type=button) of an opened window.
// One mouse click only to tell «opens by click but not by keyboard» (2.1.1): white-listed trigger, nothing else under
// the point (elementFromPoint), lib/cdp refusals (submit, consent-accept, contact form, iframe).

import { join } from 'node:path';
import { Browser } from './lib/cdp.mjs';
import {
  parseArgs, listArg, langOf, helpAndExit, requireRun, loadPages, loadBrief, readJSON, writeJSON, log as runLog,
  measureHeader, progress, sleep, hostOf, resolvesPrivate, allowPrivateHost, acquireBrowserSlot, detectAntibot, printAndSaveSummary, nowIso,
} from './lib/util.mjs';
import { loadAxe, runAxe, wcagRefs, wcagLevel } from './collectors/axe.mjs';

const HELP = `
node a11y.mjs --run "<RUN>" [--pages home,p01] [--widths 1440,390] [--tabs 60] [--max-pages 12] [--budget-sec 480] [--no-dialog-axe] [--allow-load-posts] [--lang ru|en]

Доступность в живом браузере: клавиатура (Tab ×60 на 1440 и 390, видимость фокуса, 2.4.11, ловушки,
skip-link, попап, меню, раскрывашки и вкладки с клавиатуры, Esc, возврат фокуса, подсказки 1.4.13,
смена контекста при фокусе 3.2.1), чтение дерева доступности, reflow 320, зум 200 %, интервалы 1.4.12,
reduced motion, автодвижение, автозвук, запрет зума, iframe без title, мусорные alt, «Подробнее» без контекста.
Нажимает Enter/пробел только на переключателях из белого списка и только когда фокус на них
(ARIA, data-toggle, #ссылка на скрытый блок; обычная кнопка — если в классе popup/modal/callback
или в имени «Записаться», «Оставить заявку»); формы, кнопки отправки и cookie-баннеры не трогает.
Остальные кнопки без ARIA не нажимаются, их число — в «Не проверено».
Пишет measure/a11y.json, сводку в stdout и RUN/stdout/a11y.md. Код 75 — частичный результат (бюджет или slot_wait — браузер занят),
повторный вызов с тем же --run продолжит. --max-pages 0 — все страницы из pages.json.
`;
const HELP_EN = `
node a11y.mjs --run "<RUN>" [--pages home,p01] [--widths 1440,390] [--tabs 60] [--max-pages 12] [--budget-sec 480] [--no-dialog-axe] [--allow-load-posts] [--lang ru|en]

Accessibility in a live browser: keyboard (Tab x60 at 1440 and 390, focus visibility, 2.4.11, traps, skip link,
popup, menu, disclosures and tabs from the keyboard, Esc, focus return, tooltips 1.4.13, context change on focus
3.2.1), linear reading of the accessibility tree, reflow 320, zoom 200 %, text spacing 1.4.12, reduced motion,
auto-moving content, autoplay sound, blocked zoom, iframes without title, junk alt, «read more» without context.
Presses Enter/Space only on white-listed toggles with verified focus (ARIA, data-toggle, #link to a hidden block;
a plain button with popup/modal/callback in its class or an opener name such as «Book»); never touches forms,
submit buttons or cookie banners. Other buttons without ARIA are not pressed; their count goes to «Not checked».
Writes measure/a11y.json, a summary to stdout and RUN/stdout/a11y.md. Exit 75 = partial result (budget or slot_wait — browser busy), run the same
command again to continue. --max-pages 0 = every page of pages.json.
`;

const SKIP_RE = /пропуст|перейти к (содерж|основн|контент)|к содержимому|к основному|skip|jump to|main content/i;
const GENERIC_LINK_RE = /^(подробнее|подробней|читать далее|читать|далее|узнать больше|узнать|ещё|еще|тут|здесь|перейти|смотреть|смотреть все|more|read more|learn more|details|click here|here|see more|view more)$/i;
const AX_INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'listbox', 'option', 'treeitem']);
const AX_NAME_FROM_CONTENT = new Set(['link', 'button', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'treeitem', 'cell', 'columnheader', 'rowheader', 'checkbox', 'radio', 'switch', 'LabelText', 'legend', 'caption', 'figcaption', 'tooltip', 'listitem']);
const AX_ANNOUNCE = new Set([...AX_INTERACTIVE, 'heading', 'image', 'img', 'list', 'navigation', 'banner', 'main', 'contentinfo', 'complementary', 'region', 'form', 'search', 'dialog', 'alertdialog', 'alert', 'status', 'table', 'grid', 'tablist', 'menu', 'menubar', 'tree', 'progressbar', 'Iframe', 'iframe', 'video', 'audio', 'figure', 'group', 'radiogroup', 'meter', 'math']);
const LANDMARKS = ['banner', 'navigation', 'main', 'contentinfo', 'complementary', 'search', 'region', 'form'];

const TXT = {
  ru: {
    title: 'a11y', pages: 'страниц', tabs: 'нажатий Tab', written: 'Записано', partial: 'Частичный результат: повторите тот же вызов, продолжит с места остановки.', partialSlot: 'Частичный результат: браузер занят другими проверками (slot_wait), повторите тот же вызов.',
    none: 'нет', unnamed: '(без имени)', text: 'текст', nothing: 'нарушений этого вида нет',
    checks: {
      'focus-not-visible': 'Фокус не виден (стили не меняются или кольцо цвета фона)', 'focus-ring-contrast': 'Кольцо фокуса < 3:1 к фону', 'focus-obscured': 'Фокус закрыт целиком другим слоем (2.4.11)',
      'focus-on-hidden': 'Фокус уходит на невидимый элемент', 'keyboard-trap': 'Ловушка фокуса', 'skip-link-missing': 'Нет ссылки «Перейти к содержанию»', 'skip-link-broken': 'Ссылка «Перейти к содержанию» не работает',
      'tabindex-positive': 'tabindex > 0 ломает порядок', 'iframe-tab-stops': 'iframe забирает много остановок Tab', 'focusable-in-aria-hidden': 'Фокусируемое внутри aria-hidden',
      'toggle-no-keyboard': 'Попап/меню не открывается с клавиатуры', 'dialog-focus-not-moved': 'При открытии попапа фокус не переходит в него', 'dialog-focus-escapes': 'Tab уходит из открытого попапа на страницу под ним',
      'toggle-esc': 'Esc не закрывает попап/меню', 'toggle-focus-not-returned': 'После закрытия фокус не возвращается к кнопке', 'toggle-content-unreachable': 'Пункты открытого меню не достигаются с клавиатуры', 'dialog-axe': 'axe в открытом попапе',
      'reflow-320': 'Горизонтальная прокрутка на 320 CSS px (reflow)', 'zoom-200': 'Зум 200 %: переполнение или обрезка', 'zoom-blocked': 'Масштабирование запрещено', 'text-spacing': 'Интервалы 1.4.12: текст обрезается или наезжает',
      'motion-no-pause': 'Автодвижение дольше 5 с без паузы', 'reduced-motion-ignored': 'prefers-reduced-motion не действует', 'autoplay-audio': 'Звук включается сам',
      'iframe-no-title': 'iframe без title', 'unnamed-controls': 'Элементы управления без имени (скринридер)', 'images-no-name': 'Картинки без текстовой альтернативы', 'generic-link-text': 'Одинаковые ссылки без контекста',
      'lang-missing': 'Нет lang у html', 'title-missing': 'Пустой title', 'no-main-landmark': 'Нет области main', 'headings': 'Заголовки: нет H1 / несколько H1 / скачки уровней', 'media-no-captions': 'Видео без субтитров',
      'skip-link-recommended': 'Нет ссылки пропуска (main есть — рекомендация)', 'generic-link-text-context': 'Одинаковые ссылки, смысл только из контекста (карточка, абзац)', 'focus-caret-only': 'Поле ввода: фокус виден только по мигающему курсору',
      'focus-changes-context': 'Фокус сам меняет контекст (переход, новое окно)', 'aria-expanded-stale': 'aria-expanded не меняется при открытии', 'images-junk-alt': 'Мусорный alt («img», имя файла)', 'tooltip-esc': 'Подсказка по фокусу не закрывается Esc',
    },
  },
  en: {
    title: 'a11y', pages: 'pages', tabs: 'Tab presses', written: 'Written', partial: 'Partial result: run the same command again to continue.', partialSlot: 'Partial result: browser busy with other checks (slot_wait), run the same command again.',
    none: 'none', unnamed: '(no name)', text: 'text', nothing: 'no issues of this kind',
    checks: {
      'focus-not-visible': 'Focus not visible (no style change, or a ring of the background colour)', 'focus-ring-contrast': 'Focus ring < 3:1', 'focus-obscured': 'Focus fully hidden by another layer (2.4.11)',
      'focus-on-hidden': 'Focus goes to an invisible element', 'keyboard-trap': 'Keyboard trap', 'skip-link-missing': 'No skip link', 'skip-link-broken': 'Skip link does not work',
      'tabindex-positive': 'tabindex > 0 breaks order', 'iframe-tab-stops': 'iframe takes many Tab stops', 'focusable-in-aria-hidden': 'Focusable inside aria-hidden',
      'toggle-no-keyboard': 'Popup/menu does not open from the keyboard', 'dialog-focus-not-moved': 'Focus does not move into the opened popup', 'dialog-focus-escapes': 'Tab leaves the open popup',
      'toggle-esc': 'Esc does not close the popup/menu', 'toggle-focus-not-returned': 'Focus not returned to the trigger', 'toggle-content-unreachable': 'Opened menu items are not reachable by keyboard', 'dialog-axe': 'axe inside the open popup',
      'reflow-320': 'Horizontal scroll at 320 CSS px (reflow)', 'zoom-200': 'Zoom 200 %: overflow or clipping', 'zoom-blocked': 'Zoom is blocked', 'text-spacing': 'Text spacing 1.4.12: text clipped or overlapping',
      'motion-no-pause': 'Auto-moving content > 5 s without pause', 'reduced-motion-ignored': 'prefers-reduced-motion has no effect', 'autoplay-audio': 'Audio plays automatically',
      'iframe-no-title': 'iframe without title', 'unnamed-controls': 'Controls without a name (screen reader)', 'images-no-name': 'Images without a text alternative', 'generic-link-text': 'Identical links without context',
      'lang-missing': 'No lang on html', 'title-missing': 'Empty title', 'no-main-landmark': 'No main landmark', 'headings': 'Headings: no H1 / several H1 / skipped levels', 'media-no-captions': 'Video without captions',
      'skip-link-recommended': 'No skip link (main exists — recommendation)', 'generic-link-text-context': 'Identical links, purpose only from context (card, paragraph)', 'focus-caret-only': 'Text field: focus shown only by the caret',
      'focus-changes-context': 'Focus alone changes context (navigation, new window)', 'aria-expanded-stale': 'aria-expanded does not change on opening', 'images-junk-alt': 'Junk alt («img», file name)', 'tooltip-esc': 'Tooltip on focus is not dismissed by Esc',
    },
  },
};

// Levels are not inflated: a check is A/AA only when the script proves the failure; patterns that WCAG lets pass
// through another technique are 'bp' (best practice) or the AAA criterion they really belong to.
//  skip-link-missing: A only without main (with main, ARIA11 landmarks satisfy 2.4.1 → skip-link-recommended, bp);
//  generic-link-text: A only for links with no programmatic context (H80/H81/G53); with a card heading or a sentence
//  around them → generic-link-text-context, 2.4.9 AAA; tabindex-positive and toggle-focus-not-returned: bp (axe and
//  the ARIA APG treat them as practice); focus-caret-only: the caret counts as a 2.4.7 indicator → bp;
//  dialog-axe: wcag and level from the axe rules found (set per item).
const WCAG = {
  'focus-not-visible': ['2.4.7', 'AA'], 'focus-ring-contrast': ['1.4.11', 'AA'], 'focus-obscured': ['2.4.11', 'AA'], 'focus-on-hidden': ['2.4.7', 'AA'], 'focus-caret-only': ['2.4.7', 'bp'],
  'keyboard-trap': ['2.1.2', 'A'], 'skip-link-missing': ['2.4.1', 'A'], 'skip-link-recommended': ['2.4.1', 'bp'], 'skip-link-broken': ['2.4.1', 'A'], 'tabindex-positive': ['2.4.3', 'bp'], 'iframe-tab-stops': ['2.4.3', 'bp'],
  'focusable-in-aria-hidden': ['4.1.2', 'A'], 'toggle-no-keyboard': ['2.1.1', 'A'], 'dialog-focus-not-moved': ['2.4.3', 'A'], 'dialog-focus-escapes': ['2.4.3', 'A'], 'toggle-esc': ['2.1.2', 'bp'],
  'toggle-focus-not-returned': ['2.4.3', 'bp'], 'toggle-content-unreachable': ['2.4.3', 'A'], 'dialog-axe': [null, 'bp'], 'reflow-320': ['1.4.10', 'AA'], 'zoom-200': ['1.4.4', 'AA'], 'zoom-blocked': ['1.4.4', 'AA'], 'text-spacing': ['1.4.12', 'AA'],
  'motion-no-pause': ['2.2.2', 'A'], 'reduced-motion-ignored': ['2.3.3', 'AAA'], 'autoplay-audio': ['1.4.2', 'A'], 'iframe-no-title': ['4.1.2', 'A'], 'unnamed-controls': ['4.1.2', 'A'],
  'images-no-name': ['1.1.1', 'A'], 'images-junk-alt': ['1.1.1', 'A'], 'generic-link-text': ['2.4.4', 'A'], 'generic-link-text-context': ['2.4.9', 'AAA'], 'lang-missing': ['3.1.1', 'A'], 'title-missing': ['2.4.2', 'A'],
  'no-main-landmark': ['1.3.1', 'bp'], 'headings': ['1.3.1', 'bp'], 'media-no-captions': ['1.2.2', 'A'],
  'focus-changes-context': ['3.2.1', 'A'], 'aria-expanded-stale': ['4.1.2', 'A'], 'tooltip-esc': ['1.4.13', 'AA'],
};

// ---------- in-page helpers (serialised with toString, must be self-contained) ----------
function installHelpers() {
  if (window.__rvA) return true;
  const cv = document.createElement('canvas'); cv.width = cv.height = 1; const cx = cv.getContext('2d', { willReadFrequently: true });
  const rgba = s => {
    if (!s) return null; s = String(s).trim();
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i.exec(s);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : (m[5] ? +m[4] / 100 : +m[4])];
    if (s === 'transparent') return [0, 0, 0, 0];
    try { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#000'; cx.fillStyle = s; cx.fillRect(0, 0, 1, 1); const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; } catch (e) { return null; }
  };
  const blend = (fg, bg) => { const a = fg[3] ?? 1; return [0, 1, 2].map(i => fg[i] * a + bg[i] * (1 - a)); };
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const lum = c => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.floor(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
  const bgWalk = el => {
    const layers = [];
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return { image: true };
      const c = rgba(cs.backgroundColor);
      if (c && c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
    }
    let base = [255, 255, 255];
    if (layers.length && layers[layers.length - 1][3] >= 0.999) base = layers.pop().slice(0, 3);
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return { color: base };
  };
  const sel = el => {
    if (!el || el.nodeType !== 1) return '';
    const okId = id => id && /^[A-Za-z][\w-]*$/.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1;
    if (okId(el.id)) return '#' + el.id;
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 6; e = e.parentElement) {
      if (e !== el && okId(e.id)) parts.unshift('#' + e.id);
      else {
        let p = e.tagName.toLowerCase();
        const cls = [...e.classList].filter(c => /^[A-Za-z_][\w-]*$/.test(c) && c.length < 40).slice(0, 2);
        if (cls.length) p += '.' + cls.join('.');
        const par = e.parentElement;
        if (par) { const same = [...par.children].filter(c => c.tagName === e.tagName); if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(e) + 1) + ')'; }
        parts.unshift(p);
      }
      const s = parts.join(' > ');
      try { if (document.querySelectorAll(s).length === 1) return s; } catch (e2) { /* invalid */ }
      if (parts[0].startsWith('#') || e === document.body) break;
    }
    return parts.join(' > ');
  };
  const T = s => String(s || '').replace(/\s+/g, ' ').trim();
  const name = el => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const n = T(lb.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(e => e.innerText || e.textContent).join(' ')); if (n) return n.slice(0, 80); }
    const al = T(el.getAttribute('aria-label')); if (al) return al.slice(0, 80);
    if (el.labels && el.labels.length) { const n = T([...el.labels].map(l => l.innerText).join(' ')); if (n) return n.slice(0, 80); }
    const tx = T(el.innerText); if (tx) return tx.slice(0, 80);
    const img = el.querySelector && el.querySelector('img[alt]'); if (img && T(img.alt)) return T(img.alt).slice(0, 80);
    return T(el.getAttribute('title') || el.value || el.getAttribute('placeholder') || el.getAttribute('alt')).slice(0, 80);
  };
  const region = el => el.closest('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]') ? 'dialog'
    : el.closest('header,[role=banner]') ? 'header' : el.closest('nav,[role=navigation]') ? 'nav' : el.closest('main,[role=main]') ? 'main'
    : el.closest('footer,[role=contentinfo]') ? 'footer' : 'other';
  const hiddenWhy = el => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') return 'display';
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return 'visibility';
    let o = 1; for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const c = getComputedStyle(e); if (c.display === 'none') return 'display'; o *= parseFloat(c.opacity || '1'); }
    if (o < 0.05) return 'opacity';
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return 'size';
    if (/rect\(\s*0/.test(cs.clip) || /inset\(\s*(50|100)%/.test(cs.clipPath)) return 'clipped';
    for (let p = el.parentElement, n = 0; p && p !== document.body && n < 20; p = p.parentElement, n++) {
      const pc = getComputedStyle(p);
      if (/(hidden|clip)/.test(pc.overflow + pc.overflowX + pc.overflowY)) {
        const pr = p.getBoundingClientRect();
        if (pr.width < 2 || pr.height < 2 || r.right <= pr.left || r.left >= pr.right || r.bottom <= pr.top || r.top >= pr.bottom) return 'clipped';
      }
    }
    return null;
  };
  const docBox = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)]; };
  const sig = el => {
    const cs = getComputedStyle(el); const pb = getComputedStyle(el, '::before'), pa = getComputedStyle(el, '::after');
    // up to 3 ancestors: an indicator drawn by :focus-within on a wrapper (span > a inside a framed card) counts
    const anc = [];
    for (let q = el.parentElement, n = 0; q && q !== document.body && n < 3; q = q.parentElement, n++) {
      const c = getComputedStyle(q); anc.push([c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.backgroundColor, c.borderTopColor, c.borderBottomColor, c.borderTopWidth].join(' '));
    }
    const kids = [];
    for (const d of el.querySelectorAll('*')) {
      if (kids.length >= 4) break;
      const c = getComputedStyle(d);
      kids.push([c.outlineStyle, c.outlineWidth, c.outlineColor, c.boxShadow, c.backgroundColor, c.color, c.borderBottomColor, c.textDecorationLine, c.opacity, c.transform].join(' '));
    }
    return {
      outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, shadow: cs.boxShadow, bg: cs.backgroundColor + ' ' + cs.backgroundImage, color: cs.color,
      border: [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor, cs.borderTopWidth, cs.borderBottomWidth].join(' '),
      deco: cs.textDecorationLine + ' ' + cs.textDecorationColor + ' ' + cs.textDecorationThickness, transform: cs.transform,
      pseudo: [pb.content, pb.opacity, pb.backgroundColor, pb.transform, pb.width, pb.borderBottomColor, pa.content, pa.opacity, pa.backgroundColor, pa.transform, pa.width, pa.borderBottomColor].join('|'),
      parent: anc.join('|'),
      kids: kids.join('|'),
    };
  };
  const FOC = 'a[href], area[href], button, input:not([type=hidden]), select, textarea, iframe, summary, [tabindex], [contenteditable=""], [contenteditable=true], audio[controls], video[controls]';
  const base = new WeakMap();
  // a visually hidden native checkbox/radio drawn by its label: focus is shown (or not) on the label
  const proxyOf = el => {
    if (el.tagName !== 'INPUT' || !/^(checkbox|radio)$/i.test(el.type || '')) return null;
    const lb = (el.labels && el.labels[0]) || el.closest('label');
    return lb && !hiddenWhy(lb) ? lb : null;
  };
  // submit by properties, not attributes: <button form="id"> outside the form and a button without type inside one
  const isSubmit = el => {
    if (el.tagName === 'BUTTON') return el.type === 'submit' && !!(el.form || el.closest('form'));
    if (el.tagName === 'INPUT') return /^(submit|image)$/i.test(el.type || '');
    return false;
  };
  const CONTACT_Q = 'input[type=tel], input[type=email], input[name*=phone i], input[name*=tel i], input[name*=mail i], input[name*=name i], textarea';
  // consent managers by their usual containers ('cmp-' alone is also a CMS component prefix: cmp-accordion)
  const CONSENT_RE = /cookie|consent|gdpr|privacy-banner|согласи|qc-cmp|cmp-?(container|banner|ui|wrapper|modal|dialog|popup)|onetrust|cookiebot|usercentrics|didomi/i;
  const ACTION_RE = /отправ|оплат|купить|заказать|оформить|подписа|подтверд|в корзин|избранн|нрав|лайк|голос|показать (номер|телефон)|позвон|удалить|выйти|send|submit|\bpay|\bbuy|\border\b|checkout|subscribe|confirm|add to (cart|bag|basket)|wishlist|favou?rite|\blike\b|\bvote|show (phone|number)|\bcall\b|delete|remove|log ?out|sign ?out/i;
  // a «formless form»: the nearest block (≤ 4 ancestors) with a contact field is small — a few controls, like a lead
  // form without <form>; a big wrapper that happens to hold a form somewhere further down is not one
  const nearContact = el => {
    for (let n = el.parentElement, k = 0; n && k < 4 && n !== document.body; n = n.parentElement, k++) {
      if (!n.querySelector(CONTACT_Q)) continue;
      return n.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role=button]').length <= 10;
    }
    return false;
  };
  // why an element must never get Enter/Space/click from us (null = may be pressed if it is a white-listed toggle)
  const noPress = el => {
    if (!el || el.nodeType !== 1) return 'gone';
    if (isSubmit(el)) return 'submit';
    if (el.form || el.closest('form')) return 'in-form';
    if (nearContact(el)) return 'near-contact-fields';
    for (let n = el, k = 0; n && n.nodeType === 1 && k < 8; n = n.parentElement, k++) {
      if (CONSENT_RE.test((n.id || '') + ' ' + (typeof n.className === 'string' ? n.className : '') + ' ' + (n.getAttribute('aria-label') || ''))) return 'consent-banner';
    }
    const href = el.getAttribute('href');
    if (href !== null) {
      if (/^(tel|mailto|sms|viber|whatsapp|tg|skype):/i.test(href)) return 'contact-link';
      if (/^javascript:/i.test(href) && !/^javascript:\s*(void\s*\(?\s*0\s*\)?)?\s*;?\s*$/i.test(href)) return 'javascript-code';
      if (!href.startsWith('#') && !/^javascript:/i.test(href)) return 'link';
    }
    if (ACTION_RE.test(name(el))) return 'action-name';
    return null;
  };
  const dialogish = c => !!c && (c.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]') || /modal|popup|dialog|lightbox/i.test((typeof c.className === 'string' ? c.className : '') + ' ' + c.id));
  // White list of toggles → 'dialog' | 'menu' | 'disclosure' | 'tab' | null. Structure only (ARIA, <summary>, role=tab,
  // data-toggle, accordion/collapse/burger classes, #hash to a hidden block) — never a verb in the name.
  const kindOf = el => strongKind(el) || (weakOpener(el) ? 'dialog' : null);
  // Second tier: a plain button or a «#» / no-href link that opens a lead popup by JS without ARIA, data-toggle or
  // #hash. Only a narrow dictionary of opener words in class / id / data-* or in the name; ACTION_RE names, forms,
  // contact fields and consent banners are refused by noPress before.
  const OPEN_CLS_RE = /popup|modal|dialog|lightbox|fancybox|callback|js-open|open-?(form|popup|modal)/i;
  const OPEN_NAME_RE = /записаться|забронировать|обратн\S* звон|оставить заявку|связаться|\bbook\b|\bcontact\b|request a call/i;
  const plainControl = el => {
    const tag = el.tagName, role = (el.getAttribute('role') || '').toLowerCase(), href = el.getAttribute('href');
    return tag === 'BUTTON' || role === 'button' || (tag === 'A' && (href === null || href === '#' || /^javascript:/i.test(href)));
  };
  const weakOpener = el => {
    if (!el || el.nodeType !== 1 || noPress(el) || !plainControl(el)) return false;
    const data = [...el.attributes].filter(a => a.name.startsWith('data-')).map(a => a.name + ' ' + a.value).join(' ');
    return OPEN_CLS_RE.test([typeof el.className === 'string' ? el.className : '', el.id, data].join(' ')) || OPEN_NAME_RE.test(name(el));
  };
  const strongKind = el => {
    if (noPress(el)) return null;
    const tag = el.tagName, role = (el.getAttribute('role') || '').toLowerCase();
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'IFRAME') return null;
    if (tag === 'SUMMARY') return 'disclosure';
    if (role === 'tab') return 'tab';
    const hp = (el.getAttribute('aria-haspopup') || '').toLowerCase();
    const exp = el.hasAttribute('aria-expanded');
    const ctl = (el.getAttribute('aria-controls') || '').split(/\s+/).map(id => id && document.getElementById(id)).find(Boolean) || null;
    const dt = (el.getAttribute('data-toggle') || el.getAttribute('data-bs-toggle') || '').toLowerCase();
    const href = el.getAttribute('href');
    let hashTarget = null;
    if (tag === 'A' && href && href.startsWith('#') && href.length > 1) {
      let id = href.slice(1); try { id = decodeURIComponent(id); } catch (e) { /* */ }
      hashTarget = document.getElementById(id) || null;
      if (hashTarget && !hiddenWhy(hashTarget)) hashTarget = null; // an anchor to visible content is navigation, not a toggle
    }
    const popupHash = tag === 'A' && /^#(popup|modal|dialog)[:\-_]/i.test(href || '');
    const control = tag === 'BUTTON' || role === 'button' || tag === 'A';
    if (!control && !exp && !ctl) return null; // a plain div/span is a toggle only with ARIA
    if (tag === 'A' && !hashTarget && !popupHash && !exp && !ctl && !dt && role !== 'button') return null;
    const cls = typeof el.className === 'string' ? el.className : '';
    const hay = [cls, el.id, el.getAttribute('aria-label') || ''].join(' ');
    const nm = name(el);
    if (hp === 'dialog' || dt === 'modal' || dialogish(ctl) || popupHash || (hashTarget && dialogish(hashTarget))) return 'dialog';
    const burger = /burger|hamburger|menu-?toggle|nav-?toggle|navbar-toggler|offcanvas|mobile-?menu|menu-?btn|menu-?button|menu-?icon/i.test(hay) || /^(меню|menu|☰|≡)$/i.test(nm);
    if (hp === 'menu' || hp === 'true' || burger || (ctl && ctl.matches('nav,[role=navigation],[role=menu],[role=menubar]')) || (exp && /меню|menu|навигац|navigation|каталог|catalog/i.test(nm))) return 'menu';
    if (exp || ctl || hashTarget || dt === 'collapse' || dt === 'dropdown' || /accordion|collaps|spoiler|expander|disclosure/i.test(hay)) return 'disclosure';
    return null;
  };
  const isOpenLayer = el => {
    if (hiddenWhy(el)) return false;
    if (el.matches('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')) return true;
    const cs = getComputedStyle(el);
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const r = el.getBoundingClientRect();
    return r.width * r.height >= 0.2 * innerWidth * innerHeight && r.bottom > 0 && r.top < innerHeight;
  };
  const layers = () => {
    const out = [];
    for (const el of document.querySelectorAll('body *')) { if (out.length > 40) break; if (isOpenLayer(el)) out.push(el); }
    return out.filter(el => !out.some(o => o !== el && o.contains(el) && !el.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]')));
  };
  let layersBefore = [];
  const motionPos = new WeakMap();
  const pauseNear = el => {
    for (let p = el, n = 0; p && n < 4; p = p.parentElement, n++) {
      for (const b of p.querySelectorAll('button, [role=button], a[href]')) if (/пауз|pause|stop|стоп|останов|play|воспроизв/i.test(name(b) + ' ' + (b.className || ''))) return true;
    }
    return false;
  };
  const inLayer = el => { for (let e = el; e && e.nodeType === 1; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };
  const textLeafs = max => {
    const out = [];
    for (const el of document.body.querySelectorAll('*')) {
      if (out.length >= max) break;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION|svg)$/i.test(el.tagName)) continue;
      if (![...el.childNodes].some(n => n.nodeType === 3 && n.nodeValue.trim())) continue;
      if (getComputedStyle(el).display === 'inline' || hiddenWhy(el) || inLayer(el)) continue;
      out.push(el);
    }
    return out;
  };
  // How many px of the own text lines of an element are cut by overflow clipping (own box or clipping ancestors),
  // separately across (x) and down (y), with the element that cuts.
  const textCut = el => {
    const rects = [];
    for (const n of el.childNodes) if (n.nodeType === 3 && n.nodeValue.trim()) { const rg = document.createRange(); rg.selectNodeContents(n); for (const q of rg.getClientRects()) if (q.width >= 1 && q.height >= 1) rects.push(q); }
    if (!rects.length) return null;
    const L = Math.min(...rects.map(q => q.left)), R = Math.max(...rects.map(q => q.right)), Tp = Math.min(...rects.map(q => q.top)), B = Math.max(...rects.map(q => q.bottom));
    const out = { x: 0, y: 0, byX: null, byY: null };
    for (let e = el, n = 0; e && e !== document.documentElement && n < 25; e = e.parentElement, n++) {
      const cs = getComputedStyle(e);
      const cx = /(hidden|clip)/.test(cs.overflowX), cy = /(hidden|clip)/.test(cs.overflowY);
      if (e === el && cs.textOverflow === 'ellipsis' && e.scrollWidth > e.clientWidth + 2 && e.scrollWidth - e.clientWidth > out.x) { out.x = e.scrollWidth - e.clientWidth; out.byX = e; }
      if (!cx && !cy) continue;
      const r = e.getBoundingClientRect();
      if (cx) { const v = Math.max(r.left - L, R - r.right); if (v > out.x) { out.x = v; out.byX = e; } }
      if (cy) { const v = Math.max(r.top - Tp, B - r.bottom); if (v > out.y) { out.y = v; out.byY = e; } }
    }
    out.x = Math.round(Math.max(0, out.x)); out.y = Math.round(Math.max(0, out.y));
    return out.x || out.y ? out : null;
  };
  const clipState = () => {
    const m = new Map();
    for (const el of textLeafs(800)) {
      if (el.getAnimations && el.getAnimations({ subtree: true }).some(a => a.playState === 'running' && a.effect && a.effect.getComputedTiming && a.effect.getComputedTiming().iterations === Infinity)) continue;
      const c = textCut(el); if (c) m.set(el, c);
    }
    return m;
  };
  // containers that already scroll sideways (sliders, marquees, tab strips): cutting across is their design
  const scrollers = new WeakSet();
  const markScrollers = () => { for (const el of document.body.querySelectorAll('*')) { const cs = getComputedStyle(el); if (/(hidden|clip|auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 20) scrollers.add(el); } };
  let clipBase = null, leafBase = null;
  window.__rvA = {
    sel, name, region, hiddenWhy, docBox,
    noSmooth() {
      if (!document.getElementById('__rv_a11y_style')) { const s = document.createElement('style'); s.id = '__rv_a11y_style'; s.textContent = 'html,body{scroll-behavior:auto!important}'; (document.head || document.documentElement).appendChild(s); }
      return true;
    },
    settle() {
      const a = document.activeElement; if (!a || a === document.body) return Promise.resolve(0);
      const anims = [];
      for (let e = a, n = 0; e && e.nodeType === 1 && n < 4; e = e.parentElement, n++) for (const x of (e.getAnimations ? e.getAnimations() : [])) {
        const t = x.effect && x.effect.getComputedTiming ? x.effect.getComputedTiming() : {};
        if (x.playState === 'running' && Number.isFinite(t.endTime) && t.endTime < 1500) anims.push(x.finished.catch(() => 0));
      }
      if (!anims.length) return Promise.resolve(0);
      return Promise.race([Promise.all(anims), new Promise(r => setTimeout(r, 700))]).then(() => new Promise(r => requestAnimationFrame(() => r(anims.length))));
    },
    snapshotBase() {
      // styles of every focusable element without focus (the focused one is blurred for a moment)
      const a = document.activeElement; const had = a && a !== document.body && a !== document.documentElement;
      if (had) a.blur();
      let n = 0; for (const el of document.querySelectorAll(FOC)) { if (++n > 2500) break; base.set(el, sig(el)); const lb = proxyOf(el); if (lb) base.set(lb, sig(lb)); }
      if (had) a.focus({ preventScroll: true });
      return n;
    },
    tabbableCount() { let n = 0; for (const el of document.querySelectorAll(FOC)) if (el.tabIndex >= 0 && !el.disabled && !el.closest('[inert]') && !hiddenWhy(el)) n++; return n; },
    resetStart(keepDialog) {
      // a window that opened by itself and took focus stays focused: that is where a keyboard user starts
      const a = document.activeElement;
      if (keepDialog && a && a !== document.body) {
        const d = a.closest('dialog[open],[aria-modal=true],[role=dialog],[role=alertdialog]');
        if (d && !hiddenWhy(d)) return { kept: sel(a), dialog: sel(d) };
      }
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      const t = document.createElement('span'); t.tabIndex = -1; t.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;';
      document.body.prepend(t); t.focus({ preventScroll: true }); t.remove();
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      return true;
    },
    stop() {
      let el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { none: true };
      while (el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
        let host = ''; try { host = new URL(el.src, location.href).host; } catch (e) { /* */ }
        return { iframe: true, sel: sel(el), title: el.getAttribute('title') || '', host, box: docBox(el), region: region(el) };
      }
      const cs0 = getComputedStyle(el);
      const hidden0 = hiddenWhy(el);
      const proxy = hidden0 ? proxyOf(el) : null;
      const t = proxy || el; // what the user actually sees
      const r = t.getBoundingClientRect(); const cs = getComputedStyle(t);
      const hidden = (proxy ? hiddenWhy(proxy) : hidden0) || ((r.right <= 0 || r.bottom <= 0 || r.left >= innerWidth || r.top >= innerHeight) ? 'offscreen' : null);
      const b = base.get(t); const now = sig(t);
      const changed = b ? Object.keys(now).filter(k => now[k] !== b[k]) : [];
      // outline is drawn outside over the parent background (inside, over its own background, with a negative offset);
      // an outline or shadow of the background colour (below 1.1:1) shows nothing
      let ring = 'none', ringRatio = null;
      const vsBg = (c, onSelf) => { const bg = bgWalk(onSelf ? t : (t.parentElement || t)); return c && c[3] > 0 && bg.color ? ratio(blend(c, bg.color), bg.color) : null; };
      const hasOutline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
      if (hasOutline && (!b || now.outline !== b.outline)) {
        if (cs.outlineStyle === 'auto') ring = 'browser-default';
        else { const rr = vsBg(rgba(cs.outlineColor), parseFloat(cs.outlineOffset) < 0); if (rr === null || rr >= 1.1) { ring = 'outline'; ringRatio = rr; } else { ring = 'invisible'; ringRatio = rr; } }
      }
      if ((ring === 'none' || ring === 'invisible') && changed.includes('shadow') && cs.boxShadow !== 'none') {
        const rr = vsBg(rgba((cs.boxShadow.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|oklch\([^)]*\)|hsla?\([^)]*\)/i) || [])[0]), / inset/.test(cs.boxShadow));
        if (rr === null || rr >= 1.1) { ring = 'box-shadow'; ringRatio = rr; } else { ring = 'invisible'; ringRatio = rr; }
      }
      if (ring === 'none' || ring === 'invisible') {
        const was = ring;
        if (changed.includes('border')) ring = 'border';
        else if (changed.includes('bg')) ring = 'background';
        else if (changed.includes('color')) ring = 'color';
        else if (changed.includes('deco')) ring = 'underline';
        else if (changed.includes('pseudo')) ring = 'pseudo';
        else if (changed.includes('parent')) ring = 'parent';
        else if (changed.includes('kids')) ring = 'child';
        else if (changed.includes('transform')) ring = 'transform';
        else ring = was;
      }
      if (ring !== 'outline' && ring !== 'box-shadow' && ring !== 'invisible') ringRatio = null;
      // a text field with no other change still shows the blinking caret (accepted for 2.4.7, weak): own category
      const textEntry = (el.tagName === 'INPUT' && /^(text|email|tel|search|url|password|number|date|datetime-local|month|week|time)$/i.test(el.type || '')) || el.tagName === 'TEXTAREA' || !!el.isContentEditable;
      if ((ring === 'none' || ring === 'invisible') && textEntry && !el.readOnly && !/^transparent$|rgba\([^)]*,\s*0\)$/.test(cs0.caretColor || '')) ring = 'caret-only';
      const tip = [...document.querySelectorAll('[role=tooltip]')].find(x => !hiddenWhy(x));
      let covered = 0, inView = 0, coverer = null, coverFixed = false;
      if (!hidden) {
        const ins = 2;
        const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + ins, r.top + ins], [r.right - ins, r.top + ins], [r.left + ins, r.bottom - ins], [r.right - ins, r.bottom - ins]];
        for (const [x, y] of pts) {
          if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
          inView++;
          const hit = document.elementFromPoint(x, y);
          if (hit && hit !== t && hit !== el && !t.contains(hit) && !hit.contains(t)) {
            covered++;
            if (!coverer) { coverer = sel(hit); for (let e = hit; e && e.nodeType === 1; e = e.parentElement) { const p = getComputedStyle(e).position; if (p === 'fixed' || p === 'sticky') { coverFixed = true; coverer = sel(e); break; } } }
          }
        }
      }
      const obscured = hidden ? null : inView === 0 ? 'offscreen' : covered === inView ? 'full' : covered > 0 ? 'partial' : 'none';
      return {
        sel: sel(el), tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || null, name: name(el), region: region(el), box: docBox(t),
        ring, ringRatio, changed: changed.join(','), nobase: !b, hidden, obscured, coverer, coverFixed, tabindex: el.getAttribute('tabindex'),
        proxy: proxy ? sel(proxy) : null,
        inAriaHidden: !!el.closest('[aria-hidden="true"]'), href: el.getAttribute('href'), kind: kindOf(el), weak: !strongKind(el) && weakOpener(el), submit: isSubmit(el),
        buttonLike: el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || (rgba(cs0.backgroundColor) || [0, 0, 0, 0])[3] > 0.5,
        textEntry, tooltip: tip ? sel(tip) : null, top: Math.round(r.top + scrollY),
      };
    },
    tooltipShown(s) { const t = document.querySelector(s); return !!(t && !hiddenWhy(t)); },
    // focus the element and say whether the focus is really there (Enter/Space go only to a verified focus)
    focusOn(s) {
      const el = document.querySelector(s); if (!el) return { ok: false, why: 'gone' };
      if (document.activeElement !== el) el.focus({ preventScroll: false });
      return { ok: document.activeElement === el, why: document.activeElement === el ? null : 'focus-elsewhere' };
    },
    focusIs(s) { const el = document.querySelector(s); return !!el && document.activeElement === el; },
    href() { return location.href.split('#')[0]; },
    findToggles() {
      const out = {}; const refused = {}; const unclassified = { count: 0, examples: [] };
      for (const el of document.querySelectorAll('button, [role=button], [role=tab], summary, a[href^="#"], a[href^="javascript:"], a:not([href])[tabindex], [aria-expanded], [aria-controls], [aria-haspopup]')) {
        if (hiddenWhy(el) || el.tabIndex < 0) continue;
        const strong = strongKind(el);
        const k = strong || (weakOpener(el) ? 'dialog' : null);
        if (!k) {
          const why = noPress(el); if (why) { refused[why] = (refused[why] || 0) + 1; continue; }
          // a plain button / «#» link we could not classify: not pressed, counted so silence is not read as «no issues»
          if (plainControl(el)) { unclassified.count++; if (unclassified.examples.length < 3) unclassified.examples.push({ sel: sel(el), name: name(el).slice(0, 60) }); }
          continue;
        }
        // a structural (ARIA, data-toggle, #hash) trigger beats a dictionary one of the same kind
        if (!out[k] || (out[k].weak && strong)) out[k] = { sel: sel(el), name: name(el), kind: k, weak: !strong };
      }
      return { found: out, refused, unclassified };
    },
    prepToggle(s) {
      const el = document.querySelector(s);
      if (!el) return { ok: false, why: 'gone' };
      const why = noPress(el); if (why) return { ok: false, why };
      if (!kindOf(el)) return { ok: false, why: 'not-white-listed' };
      if (hiddenWhy(el)) return { ok: false, why: 'hidden' };
      layersBefore = layers();
      el.focus({ preventScroll: false });
      return { ok: document.activeElement === el, why: document.activeElement === el ? null : 'focus-elsewhere', expanded: el.getAttribute('aria-expanded'), controls: el.getAttribute('aria-controls'), tag: el.tagName.toLowerCase() };
    },
    // where to click a toggle: its centre, and only if nothing else is under that point
    clickPoint(s) {
      const el = document.querySelector(s); if (!el) return { ok: false, why: 'gone' };
      const why = noPress(el); if (why) return { ok: false, why };
      if (!kindOf(el)) return { ok: false, why: 'not-white-listed' };
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return { ok: false, why: 'offscreen' };
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(hit === el || el.contains(hit))) return { ok: false, why: 'covered', coverer: hit ? sel(hit) : null };
      return { ok: true, x: Math.round(x), y: Math.round(y) };
    },
    // disclosure (summary, aria-expanded/controls, accordion, #hash to a hidden block): is its panel shown, what does ARIA say
    discState(s) {
      const el = document.querySelector(s); if (!el) return { ok: false, why: 'gone' };
      const why = noPress(el); if (why) return { ok: false, why };
      let target = null;
      if (el.tagName === 'SUMMARY') target = el.parentElement && el.parentElement.tagName === 'DETAILS' ? el.parentElement : null;
      else {
        const href = el.getAttribute('href') || '';
        const id = (el.getAttribute('aria-controls') || '').split(/\s+/)[0] || (href.startsWith('#') ? href.slice(1) : '');
        if (id) { try { target = document.getElementById(decodeURIComponent(id)); } catch (e) { target = document.getElementById(id); } }
        if (!target) target = el.nextElementSibling || (el.parentElement && el.parentElement.nextElementSibling) || null;
      }
      const shown = target ? (target.tagName === 'DETAILS' ? target.open : !hiddenWhy(target) && target.getBoundingClientRect().height > 2) : null;
      return { ok: true, tag: el.tagName.toLowerCase(), expanded: el.getAttribute('aria-expanded'), has_expanded: el.hasAttribute('aria-expanded'), shown, target: target ? sel(target) : null,
        guessed: !!target && el.tagName !== 'SUMMARY' && !el.getAttribute('aria-controls') && !(el.getAttribute('href') || '').startsWith('#'), focus: document.activeElement === el };
    },
    // tabs: which tab of the list is selected and where the focus is
    tabState(s) {
      const el = document.querySelector(s); if (!el) return { ok: false, why: 'gone' };
      const list = el.closest('[role=tablist]') || el.parentElement;
      const tabs = list ? [...list.querySelectorAll('[role=tab]')].filter(t => !hiddenWhy(t)) : [];
      const a = document.activeElement;
      return { ok: true, tabs: tabs.length, selected: (tabs.find(t => t.getAttribute('aria-selected') === 'true') || null) && sel(tabs.find(t => t.getAttribute('aria-selected') === 'true')),
        focus: a && a !== document.body ? sel(a) : null, focusOnTab: !!(a && tabs.includes(a)), focusIndex: tabs.indexOf(a), index: tabs.indexOf(el) };
    },
    afterToggle(s) {
      const el = document.querySelector(s);
      const now = layers();
      const fresh = now.filter(l => !layersBefore.includes(l));
      let container = fresh.find(l => l.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]')) || fresh[0] || null;
      const exp = el && el.getAttribute('aria-expanded');
      const ctl = el && el.getAttribute('aria-controls') && document.getElementById(el.getAttribute('aria-controls'));
      if (!container && ctl && !hiddenWhy(ctl)) container = ctl;
      const opened = !!container || exp === 'true';
      window.__rvA._container = container; window.__rvA._trigger = el;
      const a = document.activeElement;
      let overlay = false;
      if (container) { const cs = getComputedStyle(container); const r = container.getBoundingClientRect(); overlay = (cs.position === 'fixed' || cs.position === 'absolute') && r.width * r.height >= 0.2 * innerWidth * innerHeight; }
      return { opened, overlay, how: container ? (container === ctl ? 'aria-controls' : container.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]') ? 'dialog' : 'layer') : exp === 'true' ? 'aria-expanded' : null,
        container: container ? sel(container) : null, expanded: exp, focusInside: !!(container && a && container.contains(a)), active: a && a !== document.body ? sel(a) : null,
        modal: !!(container && container.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]')) };
    },
    where() {
      const c = window.__rvA._container, t = window.__rvA._trigger; const a = document.activeElement;
      if (!a || a === document.body) return { none: true };
      return { inside: !!(c && c.contains(a)), onTrigger: a === t, sel: sel(a), iframe: a.tagName === 'IFRAME' };
    },
    // a close button of the opened window: <button type=button> or role=button (never a link, never a submit),
    // named or drawn as «close / ×». «Back», «Cancel» are not used: they can be links away or «cancel the booking».
    closeControl() {
      const c = window.__rvA._container; if (!c) return { found: false };
      for (const b of c.querySelectorAll('button, [role=button]')) {
        if (b.tabIndex < 0 || hiddenWhy(b) || isSubmit(b)) continue;
        if (b.tagName === 'BUTTON' && b.type !== 'button') continue;
        if (b.tagName === 'A' || b.hasAttribute('href')) continue;
        const nm = name(b), cls = typeof b.className === 'string' ? b.className : '';
        if (/^(закрыть|close|✕|×|✖|x)$/i.test(nm.trim()) || (/close|закры/i.test(cls + ' ' + (b.getAttribute('aria-label') || '')) && !ACTION_RE.test(nm))) return { found: true, sel: sel(b) };
      }
      // a close «button» drawn as span/div/img (or tabindex=-1): the mouse closes the window, the keyboard cannot
      for (const b of c.querySelectorAll('span, div, i, img, svg, a:not([href]), button, [role=button]')) {
        if (b.tabIndex >= 0 || hiddenWhy(b) || b.children.length > 2) continue;
        const txt = (b.textContent || '').trim(), cls = typeof b.className === 'string' ? b.className : (b.getAttribute('class') || '');
        if (!(/^(✕|×|✖|x|закрыть|close)$/i.test(txt) || /(^|[\s_-])(close|закры)/i.test(cls + ' ' + (b.getAttribute('aria-label') || '')))) continue;
        const r = b.getBoundingClientRect(); if (r.width < 4 || r.height < 4 || r.width > 120 || r.height > 120) continue;
        return { found: false, fake: { sel: sel(b), tag: b.tagName.toLowerCase(), named: !!(b.getAttribute('aria-label') || b.getAttribute('title') || b.getAttribute('alt')) } };
      }
      return { found: false };
    },
    isOpen() {
      const c = window.__rvA._container, t = window.__rvA._trigger; const a = document.activeElement;
      const open = c ? (c.isConnected && !hiddenWhy(c) && !(c.tagName === 'DIALOG' && !c.open)) : (t && t.getAttribute('aria-expanded') === 'true');
      return { open: !!open, focusOnTrigger: !!(t && (a === t || t.contains(a))), active: a && a !== document.body ? sel(a) : null, expanded: t ? t.getAttribute('aria-expanded') : null };
    },
    skipInfo(href) {
      const id = decodeURIComponent((href || '').replace(/^#/, ''));
      const t = id ? (document.getElementById(id) || document.getElementsByName(id)[0]) : null;
      window.__rvA._skipTarget = t || null;
      return { target: id, exists: !!t, targetSel: t ? sel(t) : null };
    },
    skipResult() {
      const t = window.__rvA._skipTarget; const a = document.activeElement;
      const inT = !!(t && a && (t === a || t.contains(a)));
      const after = !!(t && a && a !== document.body && (t.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING));
      return { hash: location.hash, active: a && a !== document.body ? sel(a) : null, inTarget: inT, afterTarget: after, targetTop: t ? Math.round(t.getBoundingClientRect().top) : null };
    },
    basics() {
      const vps = [...document.querySelectorAll('meta[name="viewport" i]')].map(m => m.getAttribute('content') || '');
      const v = {}; for (const part of (vps[vps.length - 1] || '').split(/[,;]/)) { const [k, val] = part.split('=').map(s => (s || '').trim().toLowerCase()); if (k) v[k] = val; }
      const us = v['user-scalable'], ms = v['maximum-scale'] !== undefined ? parseFloat(v['maximum-scale']) : null;
      const ta = [getComputedStyle(document.documentElement).touchAction, document.body ? getComputedStyle(document.body).touchAction : 'auto'];
      const iframes = [...document.querySelectorAll('iframe, frame')].map(f => {
        let host = ''; try { host = new URL(f.src || 'about:blank', location.href).host; } catch (e) { /* */ }
        return { sel: sel(f), title: T(f.getAttribute('title')), aria: T(f.getAttribute('aria-label')), host, box: docBox(f), visible: !hiddenWhy(f), ariaHidden: f.getAttribute('aria-hidden') === 'true', tabindex: f.getAttribute('tabindex') };
      });
      const media = [...document.querySelectorAll('video, audio')].map(m => ({ sel: sel(m), tag: m.tagName.toLowerCase(), autoplay: m.autoplay, muted: m.muted, loop: m.loop, controls: m.controls,
        playing: !m.paused && !m.ended, duration: Number.isFinite(m.duration) ? Math.round(m.duration) : null, box: docBox(m), visible: !hiddenWhy(m),
        captions: !!m.querySelector('track[kind=captions], track[kind=subtitles]'), audio_bytes: typeof m.webkitAudioDecodedByteCount === 'number' ? m.webkitAudioDecodedByteCount : null })).slice(0, 20);
      const help = [...document.querySelectorAll('a[href^="tel:"], a[href^="mailto:"], a[href*="t.me/"], a[href*="wa.me/"], a[href*="api.whatsapp.com"], a[href*="vk.me/"], a[href*="viber:"], a[href*="max.ru/"]')]
        .filter(a => !hiddenWhy(a)).slice(0, 16).map(a => { const h = a.getAttribute('href'); return { kind: h.startsWith('tel:') ? 'tel' : h.startsWith('mailto:') ? 'mail' : 'messenger', region: region(a), y: docBox(a)[1] }; });
      // 1.1.1: alt that says nothing («img», «фото», a file or camera name)
      const JUNK = /^(img|image|images|icon|иконка|picture|pic|photo|фото|фотография|картинка|изображение|image description|untitled|без названия|null|undefined|alt|графика|\d+|[-_.\s*]+)$/i;
      const junk = [...document.querySelectorAll('img[alt], [role=img][aria-label]')].filter(i => !hiddenWhy(i) && !i.closest('[aria-hidden=true]')).map(i => ({ i, a: T(i.getAttribute('alt') ?? i.getAttribute('aria-label')) }))
        .filter(({ a }) => a && (JUNK.test(a) || /\.(jpe?g|png|webp|gif|svg|avif|bmp|tiff?)$/i.test(a) || /^(img|dsc|dscn|dscf|image|photo|screenshot|снимок|scr|pxl|mvimg)[-_ ]?\d{2,}/i.test(a)))
        .slice(0, 12).map(({ i, a }) => ({ sel: sel(i), alt: a.slice(0, 60), box: docBox(i) }));
      // 2.5.7: carousels and sliders — is there anything besides dragging (arrows, dots/tabs)?
      const SLIDER_Q = '.swiper, .swiper-container, .slick-slider, .glide, .splide, .owl-carousel, .flickity-enabled, .keen-slider, .embla, [class*="carousel" i], [class*="slider" i], [role=slider], [aria-roledescription=carousel]';
      const sliders = [...document.querySelectorAll(SLIDER_Q)].filter(e => !hiddenWhy(e) && !(e.parentElement && e.parentElement.closest(SLIDER_Q)) && e.getBoundingClientRect().height > 40).slice(0, 8).map(e => {
        const scope = e.parentElement || e;
        const btns = [...scope.querySelectorAll('button, [role=button], a[href^="#"], a:not([href])')].filter(b => !hiddenWhy(b));
        const arrows = btns.some(b => /prev|next|arrow|назад|вперед|вперёд|следующ|предыдущ|стрелк|‹|›|←|→|❮|❯/i.test(name(b) + ' ' + (typeof b.className === 'string' ? b.className : '')));
        const dots = !!scope.querySelector('[class*="pagination" i] button, [class*="pagination" i] [role=button], [class*="dots" i] button, [class*="bullet" i], [role=tab]');
        return { sel: sel(e), kind: e.getAttribute('role') === 'slider' ? 'slider' : 'carousel', arrows, dots, keyboard: e.getAttribute('role') === 'slider' ? e.tabIndex >= 0 : null, box: docBox(e) };
      });
      // 1.3.4: orientation-only layouts
      let orientRules = 0, orientHides = false;
      const walkO = (list, inO) => { for (const r of list) { const o = inO || !!(r.media && /orientation\s*:\s*(portrait|landscape)/i.test(r.media.mediaText)); if (o && !inO) orientRules++; if (o && r.selectorText && /^(html|body|main|#app|#root|#__next|\.page|\.wrapper)$/i.test(r.selectorText.trim()) && /display\s*:\s*none|visibility\s*:\s*hidden/i.test(r.cssText)) orientHides = true; if (r.cssRules) try { walkO(r.cssRules, o); } catch (e) { /* */ } } };
      for (const sh of document.styleSheets) { try { walkO(sh.cssRules, false); } catch (e) { /* cross-origin sheet */ } }
      const bodyText = (document.body ? document.body.textContent : '').slice(0, 300000);
      const orientation = { media_rules: orientRules, hides_page: orientHides, rotate_message: /поверните (устройство|телефон|экран)|переверните (устройство|телефон)|rotate your (device|phone|screen)|turn your (device|phone)/i.test(bodyText),
        lock_in_inline_js: [...document.querySelectorAll('script:not([src])')].some(s => /orientation\.lock\s*\(/.test(s.textContent || '')) };
      const mainEl = [...document.querySelectorAll('main, [role=main]')].find(m => !hiddenWhy(m));
      return {
        lang: document.documentElement.getAttribute('lang') || '', title: T(document.title), dir: document.documentElement.getAttribute('dir') || null, main: !!mainEl,
        junk_alt: junk, sliders, orientation,
        viewport: { content: vps[vps.length - 1] || null, count: vps.length, user_scalable: us ?? null, maximum_scale: ms, blocks_zoom: us === 'no' || us === '0' || (ms !== null && ms < 2) },
        touch_action: ta, touch_blocks_zoom: ta.some(t => t === 'none' || (/pan-/.test(t) && !/pinch-zoom|manipulation/.test(t))),
        iframes, media, aria_live: document.querySelectorAll('[aria-live]:not([aria-live=off]), [role=status], [role=alert], [role=log], output').length,
        tabindex_positive: [...document.querySelectorAll('[tabindex]')].filter(e => e.tabIndex > 0).slice(0, 10).map(e => ({ sel: sel(e), tabindex: e.tabIndex })),
        help_links: help,
      };
    },
    root(kind, i = 0) {
      const vis = e => !hiddenWhy(e);
      if (kind === 'header') return [...document.querySelectorAll('header, [role=banner]')].find(e => !e.closest('main, article, [role=main]') && vis(e)) || null;
      if (kind === 'footer') return [...document.querySelectorAll('footer, [role=contentinfo]')].filter(e => !e.closest('article') && vis(e)).pop() || null;
      if (kind === 'form') return [...document.querySelectorAll('form, [role=form]')].find(f => vis(f) && f.querySelector('input:not([type=hidden]), textarea, select')) || null;
      if (kind === 'first-scope') return document.querySelector('main, [role=main]') || document.body;
      return null;
    },
    // outermost elements of the first-screen scope that lie outside the first viewport (+ the header): their subtrees are
    // left out of the first-screen reading, so one wrapper around the whole page does not pull in the footer
    belowFold() {
      window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      const H = innerHeight, W = innerWidth, out = [];
      const hdr = window.__rvA.root('header'); if (hdr) out.push(hdr);
      const walk = el => {
        for (const c of el.children) {
          if (out.length >= 400) return;
          if (c === hdr) continue;
          const cs = getComputedStyle(c);
          if (cs.display === 'contents') { walk(c); continue; }
          const r = c.getBoundingClientRect();
          if (r.top >= H || r.right <= 0 || r.left >= W || (r.bottom <= 0 && r.height > 0)) { out.push(c); continue; }
          if (r.bottom > H && cs.position !== 'fixed') walk(c);
        }
      };
      walk(window.__rvA.root('first-scope'));
      return out;
    },
    // links named «more / details»: is there programmatic context (H80 heading of the card, H81/G53 sentence, list item, cell)?
    genericLinks(src) {
      const RX = new RegExp(src, 'i'); const out = [];
      for (const a of document.querySelectorAll('a[href], [role=link]')) {
        if (out.length >= 200) break;
        if (hiddenWhy(a) || a.closest('[aria-hidden=true]')) continue;
        const nm = name(a).toLowerCase(); if (!RX.test(nm)) continue;
        let ctx = null;
        const lbl = T(a.getAttribute('aria-label')).toLowerCase(), ttl = T(a.getAttribute('title')).toLowerCase();
        if (a.getAttribute('aria-describedby') || (lbl && lbl !== nm) || (ttl && ttl !== nm)) ctx = 'described';
        const blk = a.closest('p, li, td, th, dd, figcaption');
        if (!ctx && blk && T(blk.innerText).length > nm.length + 15) ctx = 'sentence';
        if (!ctx) {
          // the heading must belong to this link alone: a block that holds another link with the same name and one
          // section heading for both («Подробнее» ×2 under «Услуги») gives no context that tells them apart
          for (let p = a.parentElement, n = 0; p && p !== document.body && n < 4; p = p.parentElement, n++) {
            const same = [...p.querySelectorAll('a[href], [role=link]')].some(o => o !== a && name(o).toLowerCase() === nm);
            const h = [...p.querySelectorAll('h1,h2,h3,h4,h5,h6,[role=heading]')].find(x => x !== a && !a.contains(x) && !hiddenWhy(x) && (x.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING));
            if (h) { if (!same) ctx = 'heading'; break; }
            if (same) break;
          }
        }
        out.push({ name: nm, href: a.getAttribute('href') || '', ctx, sel: sel(a) });
      }
      return out;
    },
    motionSnap() {
      const anims = (document.getAnimations ? document.getAnimations() : []).filter(a => a.playState === 'running');
      const list = anims.slice(0, 300).map(a => {
        const t = a.effect && a.effect.target; const tm = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
        const el = t && t.nodeType === 1 ? t : null; const r = el ? el.getBoundingClientRect() : null;
        return { sel: el ? sel(el) : null, type: a.constructor && a.constructor.name, name: a.animationName || a.transitionProperty || a.id || '',
          infinite: tm.iterations === Infinity || tm.endTime === Infinity, total: Number.isFinite(tm.endTime) ? Math.round(tm.endTime) : null,
          visible: !!(el && !hiddenWhy(el)), area: r ? Math.round(r.width * r.height) : 0 };
      });
      let n = 0;
      for (const el of document.body.querySelectorAll('*')) { if (++n > 6000) break; const cs = getComputedStyle(el); motionPos.set(el, cs.transform + '|' + el.scrollLeft + '|' + el.scrollTop + '|' + cs.left + '|' + cs.marginLeft); }
      return { running: anims.length, list };
    },
    motionRebase() {
      let n = 0;
      for (const el of document.body.querySelectorAll('*')) { if (++n > 6000) break; const cs = getComputedStyle(el); motionPos.set(el, cs.transform + '|' + el.scrollLeft + '|' + el.scrollTop + '|' + cs.left + '|' + cs.marginLeft); }
      return n;
    },
    motionDiff() {
      const changed = []; let n = 0;
      for (const el of document.body.querySelectorAll('*')) {
        if (++n > 6000) break;
        const prev = motionPos.get(el); if (prev === undefined) continue;
        const cs = getComputedStyle(el); const now = cs.transform + '|' + el.scrollLeft + '|' + el.scrollTop + '|' + cs.left + '|' + cs.marginLeft;
        if (now !== prev && !hiddenWhy(el)) { const r = el.getBoundingClientRect(); if (r.width * r.height >= 2500) changed.push(el); }
      }
      const outer = changed.filter(el => !changed.some(o => o !== el && o.contains(el)));
      return outer.slice(0, 12).map(el => ({ sel: sel(el), box: docBox(el), pause: pauseNear(el), text: T(el.innerText).slice(0, 60) }));
    },
    pauseFor(s) { const el = document.querySelector(s); return el ? pauseNear(el) : false; },
    reducedMotionRules() {
      let rules = 0, closed = 0;
      const walk = list => { for (const r of list) { if (r.media && /prefers-reduced-motion/.test(r.media.mediaText)) rules++; if (r.cssRules) try { walk(r.cssRules); } catch (e) { /* */ } } };
      for (const s of document.styleSheets) { try { walk(s.cssRules); } catch (e) { closed++; } }
      return { rules, closed };
    },
    overflow() {
      const vw = document.documentElement.clientWidth, sw = document.documentElement.scrollWidth;
      const culprits = [];
      // a box inside an ancestor that clips or scrolls sideways (marquee, slider track) does not widen the page:
      // only that ancestor can (it is a candidate itself when it is too wide)
      const contained = el => { for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') return true; return false; };
      if (sw > vw + 1) {
        for (const el of document.body.querySelectorAll('*')) {
          const r = el.getBoundingClientRect(); if (r.right <= vw + 1 || r.width < 1 || r.height < 1) continue;
          if (hiddenWhy(el) || contained(el)) continue;
          culprits.push(el);
        }
      }
      const rootClip = [document.documentElement, document.body].some(e => e && /(hidden|clip)/.test(getComputedStyle(e).overflowX));
      const set = new Set(culprits);
      const top = culprits.filter(el => { for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false; return true; })
        .map(el => { const r = el.getBoundingClientRect(); return { sel: sel(el), right: Math.round(r.right), width: Math.round(r.width), exempt: /^(TABLE|PRE|CODE|VIDEO|CANVAS|IFRAME|svg)$/i.test(el.tagName) || el.getAttribute('role') === 'img' }; })
        .sort((a, b) => b.right - a.right).slice(0, 6);
      let fixedPx = 0;
      for (const el of document.body.querySelectorAll('*')) {
        const p = getComputedStyle(el).position; if (p !== 'fixed' && p !== 'sticky') continue;
        if (hiddenWhy(el)) continue;
        let inner = false; for (let q = el.parentElement; q && q !== document.body; q = q.parentElement) { const qp = getComputedStyle(q).position; if (qp === 'fixed' || qp === 'sticky') { inner = true; break; } }
        if (inner) continue;
        const r = el.getBoundingClientRect(); const h = Math.max(0, Math.min(innerHeight, r.bottom) - Math.max(0, r.top));
        if (r.width >= innerWidth * 0.5) fixedPx += h;
      }
      return { vw, sw, overflow: sw > vw + 1, root_clips_x: rootClip, culprits: top, fixed_share: Math.round(100 * Math.min(1, fixedPx / innerHeight)) };
    },
    clipBaseline() { markScrollers(); clipBase = clipState(); return clipBase.size; },
    clipList() { return [...clipState()].map(([el, c]) => ({ sel: sel(el), x: c.x, y: c.y, byY: c.byY ? sel(c.byY) : null })); },
    // text blocks whose own lines are now cut by overflow clipping (and were not cut, or cut less, before)
    clipNew() {
      const now = clipState(); const out = [];
      for (const [el, c] of now) {
        const b = (clipBase && clipBase.get(el)) || { x: 0, y: 0 };
        const dx = c.byX && scrollers.has(c.byX) ? 0 : c.x - b.x, dy = c.y - b.y;
        if (dx > 2 || dy > 2) out.push({ sel: sel(el), cut_px: Math.max(c.x, c.y), was_px: Math.max(b.x, b.y), dir: dy >= dx ? 'down' : 'across', by: sel(dy >= dx ? c.byY : c.byX), text: T(el.innerText).slice(0, 50), box: docBox(el) });
      }
      return out.slice(0, 10).concat(out.length > 10 ? [{ more: out.length - 10 }] : []);
    },
    leafBaseline(max) { const ls = textLeafs(max); leafBase = new Map(ls.map(el => [el, el.getBoundingClientRect()])); return ls.length; },
    overlapNew() {
      if (!leafBase) return [];
      const els = [...leafBase.keys()].filter(el => el.isConnected);
      const rs = els.map(el => el.getBoundingClientRect());
      const hit = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      const out = [];
      for (let i = 0; i < els.length && out.length < 10; i++) for (let j = i + 1; j < els.length && out.length < 10; j++) {
        if (els[i].contains(els[j]) || els[j].contains(els[i])) continue;
        if (hit(rs[i], rs[j]) > 20 && hit(leafBase.get(els[i]), leafBase.get(els[j])) <= 1) out.push({ a: sel(els[i]), b: sel(els[j]), text: T(els[i].innerText).slice(0, 40) });
      }
      return out;
    },
    spacing(on) {
      let s = document.getElementById('__rv_spacing');
      if (!on) { if (s) s.remove(); return true; }
      if (!s) { s = document.createElement('style'); s.id = '__rv_spacing'; s.textContent = '*{line-height:1.5!important;letter-spacing:.12em!important;word-spacing:.16em!important}p{margin-bottom:2em!important}'; (document.head || document.documentElement).appendChild(s); }
      return true;
    },
  };
  return true;
}

// ---------- keyboard ----------
const KEYS = { Tab: [9, 'Tab'], Enter: [13, 'Enter'], Escape: [27, 'Escape'], Space: [32, 'Space'], ArrowRight: [39, 'ArrowRight'], ArrowLeft: [37, 'ArrowLeft'] };
async function press(page, key, { shift = false } = {}) {
  // every key except Tab is a possible «press»: open the lib/cdp interaction guard (background XHR/fetch/beacon and
  // requests with parameters are cut for 3 s), like page.key()/click()/tap() do
  if (key !== 'Tab' && typeof page.guard === 'function') page.guard();
  const [code, codeName] = KEYS[key];
  const k = key === 'Space' ? ' ' : key;
  const text = key === 'Enter' ? '\r' : key === 'Space' ? ' ' : undefined;
  const mods = shift ? 8 : 0;
  await page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: k, code: codeName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: mods, ...(text ? { text, unmodifiedText: text } : {}) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: codeName, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code, modifiers: mods });
}
// Second opinion before Enter/Space on a toggle: the lib/cdp refusals of tap/click/key (submit, consent «accept»,
// contact form or contact fields nearby, tel:/mailto:, iframe) for the focused element. Our white list ran first;
// links are allowed here because noPress already refused every link that is not «#» / javascript:void.
async function libRefusal(page) {
  if (typeof page.hitInfo !== 'function' || typeof page._refusal !== 'function') return null;
  const info = await page.hitInfo(0, 0, true).catch(() => null);
  if (!info || info.none) return 'nothing';
  return page._refusal(info, { allowLink: true });
}
// Helpers live in the isolated world (lib/cdp page.evaluateIsolated): the page cannot pre-define window.__rvA or patch
// what they use. If the world is gone (the page navigated, e.g. Esc → history.back()), the call fails loudly.
const MISSING = '__rv_no_helpers__';
async function A(page, expr) {
  const v = await page.evaluateIsolated(`window.__rvA ? window.__rvA.${expr} : ${JSON.stringify(MISSING)}`);
  if (v === MISSING) throw new Error('page-changed: the page navigated, helpers are gone');
  return v;
}
const J = v => JSON.stringify(v);

async function prepare(page) {
  await page.evaluateIsolated(installHelpers);
  await A(page, 'noSmooth()');
}

async function load(page, url, lang, quick = false) {
  const nav = await page.goto(url, quick ? { timeout: 25000, waitUntil: 'load' } : { timeout: 45000, idleMs: 700 });
  if (!nav.ok) return { error: nav.refused ? `refused: ${nav.refused}` : nav.error || 'load failed' };
  if (nav.status && nav.status >= 400) {
    const html = await page.evaluateIsolated('document.documentElement.outerHTML.slice(0, 20000)').catch(() => '');
    const ab = detectAntibot(nav.status, {}, html);
    return { error: ab ? (lang === 'en' ? 'anti-bot challenge, page skipped' : 'защита от ботов, страница пропущена') : `HTTP ${nav.status}`, status: nav.status, antibot: !!ab };
  }
  await sleep(500);
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await prepare(page);
  const href = await A(page, 'href()').catch(() => String(nav.finalUrl || url).split('#')[0]);
  page.__rvHref = href; // the address this load is about: Esc or a key that leaves it is detected against it
  return { ok: true, status: nav.status, finalUrl: nav.finalUrl };
}

// After Esc (and other keys): did the page go somewhere else (history.back(), location change that lib/cdp could not cut)?
async function leftPage(page) {
  const now = await page.evaluateIsolated('location.href.split("#")[0]').catch(() => null);
  return !!(now && page.__rvHref && now !== page.__rvHref);
}

async function tabWalk(page, n) {
  const start = await A(page, 'resetStart(true)');
  await A(page, 'snapshotBase()');
  const tabbable = await A(page, 'tabbableCount()');
  const stops = [];
  let trap = null, wrapped = false, iframeRun = 0, iframeMax = 0, iframeStops = 0, checkFrom = 0, left = false;
  const escaped = []; // cycles inside a window that Esc let us out of (a modal that keeps focus is correct)
  const contextChanges = []; // 3.2.1: a Tab press alone tried to navigate or opened a window
  const tooltips = []; // 1.4.13: tooltips shown on focus, dismissed by Esc?
  let prevTip = null;
  const sels = () => stops.slice(checkFrom).filter(s => s.sel && !s.iframe);
  // attempts of the top document to go somewhere (cut by lib/cdp as «navigation», or inside the guard window as
  // «interact»/«risky» with type Document); same host only, so a lazy iframe of another site is not counted
  const host = (() => { try { return new URL(page.__rvHref).host; } catch { return ''; } })();
  const docTries = () => { const out = []; for (const k of ['navigation', 'interact', 'risky']) for (const e of page.blocked?.[k] || []) if (e.type === 'Document' && (k === 'navigation' || (() => { try { return new URL(e.url).host === host; } catch { return false; } })())) out.push(e); return out; };
  for (let i = 0; i < n; i++) {
    const nav0 = docTries().length, pop0 = page.b?.popups?.length || 0;
    await press(page, 'Tab');
    await sleep(40);
    await A(page, 'settle()').catch(() => 0);
    const st = await A(page, 'stop()').catch(e => ({ error: e.message }));
    st.i = i;
    stops.push(st);
    if (/page-changed/.test(st.error || '')) { left = true; break; }
    const tries = docTries();
    const navTried = tries.length > nav0, popup = (page.b?.popups?.length || 0) > pop0;
    if ((navTried || popup) && contextChanges.length < 6) contextChanges.push({ i, sel: st.sel || null, name: st.name || null, what: navTried ? 'navigation' : 'new-window', url: navTried ? tries[tries.length - 1]?.url : page.b.popups[page.b.popups.length - 1]?.url });
    if (st.iframe) { iframeStops++; iframeRun++; iframeMax = Math.max(iframeMax, iframeRun); continue; } else iframeRun = 0;
    if (st.none || st.error) continue;
    if (st.tooltip && st.tooltip !== prevTip && tooltips.length < 3) {
      // a tooltip appeared with this focus: Esc must hide it and keep the focus where it is (1.4.13 «dismissible»)
      await press(page, 'Escape'); await sleep(200);
      if (await leftPage(page)) { left = true; break; }
      const stillShown = await A(page, `tooltipShown(${J(st.tooltip)})`).catch(() => null);
      const focusKept = await A(page, `focusIs(${J(st.sel)})`).catch(() => null);
      tooltips.push({ i, sel: st.sel, name: st.name, tooltip: st.tooltip, esc_hides: stillShown === null ? null : !stillShown, focus_kept: focusKept });
    }
    prevTip = st.tooltip || null;
    const since = sels();
    let cycle = null;
    if (since.length > 3 && st.sel === since[0].sel) {
      // back at the first stop: the whole page was walked, or focus goes round inside a window
      const seen = new Set(since.map(s => s.sel));
      if (since.some(s => s.region === 'dialog') && tabbable > seen.size + 2) cycle = [...seen];
      else { wrapped = true; break; }
    } else if (since.length >= 14) {
      // last 14 stops go round ≤ 4 elements while the page has more
      const recent = since.slice(-14); const uniq = new Set(recent.map(s => s.sel));
      const seen = new Set(stops.filter(s => s.sel && !s.iframe).map(s => s.sel));
      if (uniq.size <= 4 && tabbable > seen.size + 2) cycle = [...uniq];
    }
    if (cycle) {
      const cyc = { cycle, after: since[0].i, region: since.find(s => cycle.includes(s.sel))?.region || null };
      // Esc must let the user out; then the walk goes on
      await press(page, 'Escape'); await sleep(350);
      if (await leftPage(page)) { left = true; break; }
      const out = [];
      for (let j = 0; j < 4 && i < n - 1; j++) {
        await press(page, 'Tab'); await sleep(40); i++;
        const s2 = await A(page, 'stop()').catch(e => ({ error: e.message })); s2.i = i; s2.after_esc = true; stops.push(s2);
        if (s2.sel) out.push(s2.sel);
      }
      cyc.esc_exits = out.some(x => !cyc.cycle.includes(x));
      if (!cyc.esc_exits) { trap = cyc; break; }
      escaped.push(cyc); checkFrom = stops.length - out.length;
    }
  }
  return { tabbable, stops, trap, escaped, wrapped, iframeStops, iframeMax, start, contextChanges, tooltips, left };
}

function summarizeWalk(w) {
  const real = w.stops.filter(s => s.sel && !s.iframe && !s.error);
  const onPage = real.filter(s => s.region !== 'dialog'); // order on the page itself, without a window that opened by itself
  const uniq = new Map(); for (const s of real) if (!uniq.has(s.sel)) uniq.set(s.sel, s);
  const u = [...uniq.values()];
  const visibleStops = u.filter(s => !s.hidden);
  const none = s => s.ring === 'none' || s.ring === 'invisible';
  // repeated block before the content: leading stops in header/nav; without such landmarks — leading stops in the
  // top 200 px of the page (a header built from plain divs)
  let lead = 0;
  const semantic = onPage.some(s => s.region === 'header' || s.region === 'nav');
  for (const s of onPage) {
    if (SKIP_RE.test(s.name || '')) continue;
    if (semantic ? (s.region === 'header' || s.region === 'nav') : ((s.top ?? 9999) < 200 && s.region !== 'main')) lead++; else break;
  }
  return {
    tabs_pressed: w.stops.length, tabbable_on_page: w.tabbable, unique: u.length, wrapped: w.wrapped, trap: w.trap, escaped: w.escaped || [],
    started_in_dialog: w.start && w.start.kept ? w.start : null,
    iframe_stops: w.iframeStops, iframe_longest_run: w.iframeMax,
    // stops without a baseline style snapshot (created after it, inside shadow DOM) are «unknown», never «no ring»
    no_ring: visibleStops.filter(s => none(s) && !s.nobase), ring_unknown: visibleStops.filter(s => none(s) && s.nobase),
    caret_only: visibleStops.filter(s => s.ring === 'caret-only'),
    ring_low: visibleStops.filter(s => s.ring !== 'invisible' && s.ringRatio !== null && s.ringRatio < 3),
    obscured_full: visibleStops.filter(s => s.obscured === 'full'), obscured_partial: visibleStops.filter(s => s.obscured === 'partial'),
    hidden: u.filter(s => s.hidden), aria_hidden: u.filter(s => s.inAriaHidden),
    first_in_main: onPage.findIndex(s => s.region === 'main'), first_button: onPage.findIndex(s => s.buttonLike && s.region !== 'header' && s.region !== 'nav' && !SKIP_RE.test(s.name || '')),
    lead_block: lead, lead_by: semantic ? 'header/nav' : 'top-200px',
    positive_tabindex: u.filter(s => Number(s.tabindex) > 0).map(s => s.sel),
    context_changes: w.contextChanges || [], tooltips: w.tooltips || [], left_page: !!w.left,
  };
}
const compactStop = s => s.iframe ? { i: s.i, iframe: true, sel: s.sel, title: s.title, host: s.host }
  : s.sel ? { i: s.i, sel: s.sel, tag: s.tag, name: s.name, region: s.region, box: s.box, ring: s.ring, ring_ratio: s.ringRatio, hidden: s.hidden, obscured: s.obscured, coverer: s.coverer, kind: s.kind || undefined, proxy: s.proxy || undefined, after_esc: s.after_esc || undefined, nobase: s.nobase || undefined, tooltip: s.tooltip || undefined }
  : s.error ? { i: s.i, error: String(s.error).slice(0, 120) } : { i: s.i, none: true };
// «more / details» links grouped by name; only names used ≥ 2 times for ≥ 2 different targets matter.
function summarizeGeneric(list) {
  const by = new Map();
  for (const l of list || []) {
    const g = by.get(l.name) || { text: l.name, count: 0, hrefs: new Set(), no_context: 0, contexts: {}, examples: [], with_context: [] };
    g.count++; g.hrefs.add(l.href);
    if (!l.ctx) { g.no_context++; if (g.examples.length < 4) g.examples.push(l.sel); }
    else { g.contexts[l.ctx] = (g.contexts[l.ctx] || 0) + 1; if (g.with_context.length < 3) g.with_context.push(l.sel); }
    by.set(l.name, g);
  }
  return [...by.values()].filter(g => g.count >= 2 && g.hrefs.size >= 2)
    .map(g => ({ text: g.text, count: g.count, targets: g.hrefs.size, no_context: g.no_context, contexts: g.contexts, examples: g.examples.concat(g.with_context).slice(0, 4) }));
}
const ex = (list, k = 6) => list.slice(0, k).map(s => ({ selector: s.sel, name: s.name, box: s.box, ring: s.ring, ...(s.coverer ? { coverer: s.coverer } : {}), ...(s.ringRatio != null ? { ring_ratio: s.ringRatio } : {}), ...(s.hidden ? { hidden: s.hidden } : {}), ...(s.proxy ? { shown_by: s.proxy } : {}) }));

async function skipLinkTest(page, walkRes) {
  const real = walkRes.stops.filter(s => s.sel && !s.iframe).slice(0, 3);
  const idx = real.findIndex(s => s.tag === 'a' && (s.href || '').startsWith('#') && SKIP_RE.test(s.name || ''));
  if (idx < 0) return { present: false };
  const st = real[idx];
  const info = await A(page, `skipInfo(${JSON.stringify(st.href)})`);
  const out = { present: true, index: st.i, selector: st.sel, name: st.name, visible_on_focus: !st.hidden && st.obscured !== 'full', target: info.target, target_exists: info.exists };
  if (!info.exists) return { ...out, works: false };
  await A(page, 'resetStart()');
  for (let i = 0; i <= st.i; i++) await press(page, 'Tab');
  const on = await A(page, 'stop()');
  if (on.sel !== st.sel) return { ...out, works: null, note: 'not reproduced' };
  await press(page, 'Enter'); await sleep(350);
  const r1 = await A(page, 'skipResult()');
  await press(page, 'Tab'); await sleep(60);
  const r2 = await A(page, 'skipResult()');
  return { ...out, focus_moved: r1.inTarget, next_tab_inside: r2.inTarget || r2.afterTarget, works: !!(r1.inTarget || r2.inTarget || r2.afterTarget) };
}

// Popup or menu opened from the keyboard on a fresh load. Every Enter/Space goes only to a verified focus on a
// white-listed trigger (prepToggle). Fallback: one real click, only when nothing else is under the trigger centre.
async function toggleTest(page, url, lang, t, axe) {
  const res = { kind: t.kind, trigger: { selector: t.sel, name: t.name, ...(t.weak ? { by: 'dictionary' } : {}) } };
  const ld = await load(page, url, lang, true);
  if (!ld.ok) return { ...res, error: ld.error };
  const prep = await A(page, `prepToggle(${J(t.sel)})`);
  if (!prep.ok) return { ...res, skipped: prep.why || 'focus failed' };
  res.expanded_before = prep.expanded;
  const lr = await libRefusal(page);
  if (lr) return { ...res, skipped: 'lib-refused', refused: lr };
  await press(page, 'Enter'); await sleep(700);
  if (await leftPage(page)) return { ...res, navigated: true, note: 'the page went to another address after Enter' };
  let st = await A(page, `afterToggle(${J(t.sel)})`);
  res.opened_with = st.opened ? 'Enter' : null;
  res.keys = ['Enter'];
  if (!st.opened && prep.tag !== 'a') {
    // Space only if the focus is still on the trigger (Enter may have moved it into something that opened after all)
    const p2 = await A(page, `prepToggle(${J(t.sel)})`);
    const lr2 = p2.ok ? await libRefusal(page) : null;
    if (lr2) res.space_skipped = 'lib-refused: ' + lr2;
    else if (p2.ok) {
      await press(page, 'Space'); await sleep(700); res.keys.push('Space');
      if (await leftPage(page)) return { ...res, navigated: true, note: 'the page went to another address after Space' };
      st = await A(page, `afterToggle(${J(t.sel)})`);
      if (st.opened) res.opened_with = 'Space';
    } else res.space_skipped = p2.why || 'focus moved';
  }
  res.opened = st.opened; res.container = st.container; res.how = st.how; res.modal = st.modal; res.overlay = st.overlay;
  if (!st.opened) {
    // the keyboard did not open it: one real click tells whether it opens at all (then it is a 2.1.1 issue).
    // Fresh load; the trigger must be the element under its own centre; lib/cdp refuses submit/consent/contact/iframe.
    const ld2 = await load(page, url, lang, true);
    if (ld2.ok) {
      const p3 = await A(page, `prepToggle(${J(t.sel)})`);
      const c = p3.ok || p3.why === 'focus-elsewhere' ? await A(page, `clickPoint(${J(t.sel)})`) : { ok: false, why: p3.why };
      if (!c.ok) { res.click_skipped = c.why; if (c.coverer) res.click_coverer = c.coverer; }
      else {
        const clk = await page.click(c.x, c.y);
        res.clicked = true;
        if (clk.refused) res.click_refused = clk.refused;
        else { await sleep(700); res.opened_by_click = (await A(page, `afterToggle(${J(t.sel)})`).catch(() => ({ opened: null }))).opened; }
      }
    }
    res.not_a_toggle = res.opened_by_click === false ? true : res.opened_by_click ? false : null;
    return res;
  }
  res.expanded_after = st.expanded;
  // 4.1.2: the trigger says aria-expanded, the block opened, but the attribute did not become "true"
  if (prep.expanded !== null && st.expanded !== 'true') res.expanded_stale = true;
  res.focus_moved_in = st.focusInside;
  const seq = [];
  for (let i = 0; i < 15; i++) { await press(page, 'Tab'); await sleep(40); seq.push(await A(page, 'where()').catch(e => ({ none: true, error: e.message }))); }
  const real = seq.filter(s => !s.none);
  res.tab_inside = real.filter(s => s.inside).length; res.tab_outside = real.filter(s => !s.inside && !s.onTrigger).length;
  res.escaped = st.container ? res.tab_outside > 0 : null;
  res.first_outside = real.find(s => !s.inside && !s.onTrigger)?.sel || null;
  const cc = await A(page, 'closeControl()');
  res.close_control = cc.found ? cc.sel : null;
  if (cc.fake) res.close_not_keyboard = cc.fake; // a close icon only the mouse can use
  if (st.container) {
    try { const tr = await axTree(page, lang); const root = await tr.rootOf('window.__rvA._container'); res.reading = root ? tr.linear(root, 30) : null; if (root === null) res.reading_note = 'container is not in the accessibility tree (aria-hidden?)'; }
    catch (e) { res.reading_error = e.message.slice(0, 160); }
  }
  if (axe && st.container && (st.modal || t.kind === 'dialog')) {
    try {
      const r = await runAxe(page, axe.source, { context: st.container, timeoutMs: 60000, version: axe.version === 'unknown' ? null : axe.version });
      res.axe = r.violations.map(v => ({ rule: v.id, impact: v.impact, nodes: v.nodes.length, wcag: wcagRefs(v.tags), level: wcagLevel(v.tags), example: v.nodes[0]?.target?.join(' >>> ') || null }));
    } catch (e) { res.axe_error = e.message.slice(0, 200); }
  }
  await press(page, 'Escape'); await sleep(500);
  if (await leftPage(page)) { res.navigated_on_esc = true; res.esc_closes = null; return res; }
  const after = await A(page, 'isOpen()');
  res.esc_closes = !after.open;
  res.focus_returned = after.open ? null : after.focusOnTrigger;
  res.focus_after_close = after.active;
  if (after.open && cc.found) {
    // the close button from the keyboard: Enter only after the focus is verified on it (strict close button, see closeControl)
    const f = await A(page, `focusOn(${J(cc.sel)})`);
    if (f.ok) {
      await press(page, 'Enter'); await sleep(500);
      if (await leftPage(page)) { res.navigated_on_close = true; return res; }
      const a2 = await A(page, 'isOpen()');
      res.close_control_works = !a2.open;
      if (!a2.open) res.focus_returned = a2.focusOnTrigger;
    } else res.close_control_works = null;
  }
  res.trap = !!(st.container && res.tab_inside > 0 && res.tab_outside === 0 && !res.esc_closes && !res.close_control);
  return res;
}

// Disclosure (summary, aria-expanded/controls, accordion, #hash panel) on the current load: Enter (Space for buttons
// if Enter does nothing) with a verified focus, then the same key again to put it back. Records whether it opens from
// the keyboard and whether aria-expanded follows the panel (4.1.2).
async function disclosureTest(page, t) {
  const res = { kind: 'disclosure', trigger: { selector: t.sel, name: t.name } };
  const b = await A(page, `discState(${J(t.sel)})`);
  if (!b.ok) return { ...res, skipped: b.why };
  const f = await A(page, `focusOn(${J(t.sel)})`);
  if (!f.ok) return { ...res, skipped: f.why || 'focus' };
  let key = 'Enter';
  await press(page, key); await sleep(450);
  if (await leftPage(page)) return { ...res, navigated: true };
  let a = await A(page, `discState(${J(t.sel)})`);
  const changed = x => (x.shown !== b.shown && x.shown !== null) || x.expanded !== b.expanded;
  if (!changed(a) && b.tag !== 'a' && b.tag !== 'summary' && (await A(page, `focusIs(${J(t.sel)})`))) {
    key = 'Space'; await press(page, key); await sleep(450);
    if (await leftPage(page)) return { ...res, navigated: true };
    a = await A(page, `discState(${J(t.sel)})`);
  }
  Object.assign(res, { key, opened: changed(a), shown_before: b.shown, shown_after: a.shown, expanded_before: b.expanded, expanded_after: a.expanded, has_expanded: b.has_expanded, panel: a.target, panel_guessed: b.guessed });
  // ARIA out of step: the panel changed but aria-expanded did not follow (only when we know the panel for sure)
  if (b.has_expanded && !b.guessed && a.shown !== null && b.shown !== a.shown && a.expanded !== String(a.shown)) res.expanded_stale = true;
  // put it back as it was
  if (res.opened && (await A(page, `focusIs(${J(t.sel)})`))) { await press(page, key); await sleep(300); }
  return res;
}

// Tabs: focus a tab and press → (APG: arrows move between tabs; Tab alone would go into the panel).
async function tabsTest(page, t) {
  const res = { kind: 'tab', trigger: { selector: t.sel, name: t.name } };
  const s0 = await A(page, `tabState(${J(t.sel)})`);
  if (!s0.ok || s0.tabs < 2) return { ...res, skipped: s0.why || 'single tab' };
  const f = await A(page, `focusOn(${J(t.sel)})`);
  if (!f.ok) return { ...res, skipped: f.why || 'focus' };
  await press(page, 'ArrowRight'); await sleep(300);
  if (await leftPage(page)) return { ...res, navigated: true };
  const s1 = await A(page, `tabState(${J(t.sel)})`);
  Object.assign(res, { tabs: s0.tabs, arrows_move_focus: s1.focusOnTab && s1.focusIndex !== s0.index, selection_follows: s1.selected !== s0.selected });
  if (s1.focusOnTab && s1.focusIndex !== s0.index) { await press(page, 'ArrowLeft'); await sleep(200); }
  return res;
}

// ---------- accessibility tree ----------
// One fetch of the full tree → linear reading «role · name · state» of any DOM subtree (what a screen reader
// would announce, in document order). rootOf(expr): expr is evaluated in the page and must return an element.
async function axTree(page, lang) {
  const t = TXT[lang];
  await page.send('DOM.enable').catch(() => {});
  await page.send('Accessibility.enable').catch(() => {});
  const { nodes } = await page.send('Accessibility.getFullAXTree', {}, 90000);
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  const byBackend = new Map(); for (const n of nodes) if (n.backendDOMNodeId && !byBackend.has(n.backendDOMNodeId)) byBackend.set(n.backendDOMNodeId, n);
  const prop = (n, k) => (n.properties || []).find(p => p.name === k)?.value?.value;
  const cut = s => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > 80 ? s.slice(0, 79) + '…' : s; };
  const states = n => {
    const out = [];
    const lv = prop(n, 'level'); if (lv) out.push(`level=${lv}`);
    for (const k of ['expanded', 'checked', 'pressed', 'selected']) { const v = prop(n, k); if (v !== undefined && v !== null) out.push(`${k}=${v}`); }
    for (const k of ['required', 'invalid', 'disabled', 'readonly', 'modal']) { const v = prop(n, k); if (v === true || (k === 'invalid' && v && v !== 'false')) out.push(k); }
    const hp = prop(n, 'hasPopup'); if (hp && hp !== 'false') out.push(`haspopup=${hp}`);
    if (n.value?.value) out.push(`value=«${cut(n.value.value).slice(0, 30)}»`);
    return out.join(', ');
  };
  // skip: backend DOM ids whose subtrees are left out (outside the first screen)
  const linear = (root, max = 40, skip = null) => {
    const lines = [];
    const walk = (n, consumed) => {
      if (!n || lines.length >= max) return;
      if (skip && n.backendDOMNodeId && skip.has(n.backendDOMNodeId)) return;
      const role = n.role?.value || ''; const nm = cut(n.name?.value);
      let c = consumed;
      if (!n.ignored) {
        if (role === 'StaticText') { if (!consumed && nm) lines.push(`${t.text} · «${nm}»`); }
        else if (AX_ANNOUNCE.has(role)) {
          // landmarks, lists and groups are announced by role; «(no name)» matters only for controls and images
          const needsName = AX_INTERACTIVE.has(role) || role === 'image' || role === 'img' || role === 'heading' || role === 'dialog' || role === 'Iframe' || role === 'iframe';
          lines.push([role, nm ? `«${nm}»` : needsName ? t.unnamed : null, states(n)].filter(Boolean).join(' · '));
          if (AX_NAME_FROM_CONTENT.has(role) && nm) c = true;
        }
      }
      for (const id of n.childIds || []) walk(byId.get(id), c);
    };
    walk(root, false);
    return lines;
  };
  // expressions are evaluated in the isolated world (where window.__rvA lives)
  const rootOf = async expr => {
    try {
      const contextId = await page.isolatedContextId();
      const { result } = await page.send('Runtime.evaluate', { expression: expr, returnByValue: false, contextId });
      if (!result?.objectId) return undefined;
      const { node } = await page.send('DOM.describeNode', { objectId: result.objectId });
      return byBackend.get(node.backendNodeId) || null; // null: element exists but is not in the tree (aria-hidden, display:none)
    } catch { return undefined; }
  };
  // backend ids of the elements of an array returned by expr
  const backendIds = async expr => {
    const ids = new Set();
    try {
      const contextId = await page.isolatedContextId();
      const { result } = await page.send('Runtime.evaluate', { expression: expr, returnByValue: false, contextId });
      if (!result?.objectId) return ids;
      const { result: props } = await page.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
      for (const p of props || []) {
        if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue;
        try { const { node } = await page.send('DOM.describeNode', { objectId: p.value.objectId }); if (node?.backendNodeId) ids.add(node.backendNodeId); } catch { /* gone */ }
      }
    } catch { /* no isolated world */ }
    return ids;
  };
  return { nodes, prop, cut, linear, rootOf, backendIds };
}

async function axReading(page, lang) {
  const { nodes, prop, cut, linear, rootOf, backendIds } = await axTree(page, lang);
  const axRoot = expr => rootOf(`window.__rvA.${expr}`);
  const regions = {};
  for (const key of ['header', 'form', 'footer']) { const r = await axRoot(`root("${key}")`); regions[key] = r ? linear(r, 40) : null; }
  // first screen: main (or body) without the header, only the parts that lie in the first viewport, ≤ 40 lines
  const scope = await axRoot('root("first-scope")');
  const below = scope ? await backendIds('window.__rvA.belowFold()') : null;
  const first = scope ? linear(scope, 40, below) : [];
  regions.first_screen = first.length ? first : null;
  // whole-tree statistics
  const live = nodes.filter(n => !n.ignored);
  const unnamed = { button: 0, link: 0, field: 0, other: 0 }; const unnamedEx = [];
  const images = { unnamed: 0, total: 0, svg_unnamed: 0 }; const unnamedImg = [];
  const headings = []; const landmarks = {}; const linkNames = new Map();
  for (const n of live) {
    const role = n.role?.value || ''; const nm = cut(n.name?.value);
    if (AX_INTERACTIVE.has(role) && !nm && role !== 'option') {
      const k = role === 'button' ? 'button' : role === 'link' ? 'link' : ['textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'listbox'].includes(role) ? 'field' : 'other';
      unnamed[k]++; if (unnamedEx.length < 8 && n.backendDOMNodeId) unnamedEx.push({ role, backend: n.backendDOMNodeId });
    }
    if (role === 'image' || role === 'img') { images.total++; if (!nm) unnamedImg.push(n); }
    if (role === 'heading' && headings.length < 60) headings.push({ level: prop(n, 'level') || null, text: nm });
    if (LANDMARKS.includes(role) && (role !== 'region' && role !== 'form' || nm)) landmarks[role] = (landmarks[role] || 0) + 1;
    if (role === 'link' && nm) linkNames.set(nm.toLowerCase(), (linkNames.get(nm.toLowerCase()) || 0) + 1);
  }
  for (const n of unnamedImg.slice(0, 300)) {
    let svg = false;
    try { const { node } = await page.send('DOM.describeNode', { backendNodeId: n.backendDOMNodeId }); const at = node.attributes || []; svg = node.nodeName.toLowerCase() === 'svg' && !at.some((v, i) => i % 2 === 0 && v === 'role'); } catch { /* */ }
    if (svg) { images.svg_unnamed++; images.total--; }
    else { images.unnamed++; if (unnamedEx.length < 12 && n.backendDOMNodeId) unnamedEx.push({ role: n.role?.value, backend: n.backendDOMNodeId }); }
  }
  const isoCtx = await page.isolatedContextId().catch(() => null);
  for (const e of unnamedEx) {
    try {
      const { object } = await page.send('DOM.resolveNode', { backendNodeId: e.backend, ...(isoCtx ? { executionContextId: isoCtx } : {}) });
      const r = await page.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function () { return [window.__rvA.sel(this), window.__rvA.docBox(this), (this.outerHTML || "").slice(0, 160)]; }', returnByValue: true });
      [e.selector, e.box, e.html] = r.result.value; delete e.backend;
    } catch { delete e.backend; }
  }
  const generic = [...linkNames.entries()].filter(([k, v]) => v >= 2 && GENERIC_LINK_RE.test(k)).map(([text, count]) => ({ text, count }));
  const h1 = headings.filter(h => h.level === 1).length;
  const skips = []; for (let i = 1; i < headings.length; i++) if (headings[i].level && headings[i - 1].level && headings[i].level - headings[i - 1].level > 1) skips.push(`H${headings[i - 1].level}→H${headings[i].level} «${headings[i].text.slice(0, 40)}»`);
  return { nodes: nodes.length, regions, unnamed, unnamed_examples: unnamedEx, images, headings: headings.slice(0, 40), h1_count: h1, heading_skips: skips.slice(0, 6), landmarks, generic_links: generic };
}

// ---------- one page × width ----------
// opt.tested: Map of toggles already tested at this width on earlier pages (a sitewide burger is tested once).
async function checkPage(browser, pg, width, opt) {
  const { lang, tabs, axe, deadline } = opt;
  const mobile = width < 768;
  const t0 = Date.now();
  const res = { pid: pg.pid, url: pg.url, width, checked_at: nowIso(), not_checked: [], phases_ms: {} };
  let tp = Date.now();
  const phase = name => { const now = Date.now(); res.phases_ms[name] = now - tp; tp = now; };
  const page = await browser.newPage({ disableCache: false, allowLoadPosts: !!opt.allowLoadPosts });
  try {
    await page.setViewport({ width, height: mobile ? 844 : 900, mobile });
    const ld = await load(page, pg.url, lang);
    if (!ld.ok) { res.error = ld.error; res.status = ld.status ?? null; return res; }
    res.status = ld.status;
    await page.scrollThrough({ step: 700, pause: 90, max: 25000 });
    phase('load');
    await A(page, 'resetStart(true)');
    res.basics = await A(page, 'basics()');
    // motion, part 1 (desktop): what runs now; the page is left alone until part 2
    const m0 = Date.now();
    const motion0 = !mobile ? await A(page, 'motionSnap()') : null;
    try { res.ax = await axReading(page, lang); } catch (e) { res.not_checked.push(`ax: ${e.message.slice(0, 160)}`); }
    try { res.links_generic = summarizeGeneric(await A(page, `genericLinks(${J(GENERIC_LINK_RE.source)})`)); } catch (e) { res.not_checked.push(`generic links: ${e.message.slice(0, 120)}`); }
    if (motion0) {
      // part 2: re-baseline ≥ 2.5 s later (entrance effects are over by then), compare after 3.5 s without input
      const wait = 2500 - (Date.now() - m0); if (wait > 0) await sleep(wait);
      await A(page, 'motionRebase()');
      await sleep(3500);
      const moving = await A(page, 'motionDiff()');
      const longAnims = motion0.list.filter(a => a.visible && a.area >= 2500 && (a.infinite || (a.total && a.total > 5000)));
      for (const a of longAnims) if (a.sel && !moving.some(m => m.sel === a.sel)) moving.push({ sel: a.sel, css: a.name, infinite: a.infinite, pause: await A(page, `pauseFor(${JSON.stringify(a.sel)})`).catch(() => false) });
      res.motion = { running_animations: motion0.running, long_or_infinite: longAnims.length, moving: moving.slice(0, 10), autoplay_media: (res.basics.media || []).filter(m => m.autoplay || m.playing) };
    }
    phase('ax+motion');
    // keyboard walk
    const walk = await tabWalk(page, tabs);
    const sum = summarizeWalk(walk);
    res.keyboard = {
      tabs_pressed: sum.tabs_pressed, tabbable_on_page: sum.tabbable_on_page, unique: sum.unique, wrapped: sum.wrapped, trap: sum.trap,
      dialog_cycles_left_by_esc: sum.escaped, started_in_dialog: sum.started_in_dialog,
      iframe_stops: sum.iframe_stops, iframe_longest_run: sum.iframe_longest_run, first_in_main: sum.first_in_main, first_button: sum.first_button,
      lead_block: sum.lead_block, lead_by: sum.lead_by,
      no_ring: sum.no_ring.length, ring_unknown: sum.ring_unknown.length, caret_only: sum.caret_only.length, ring_low_contrast: sum.ring_low.length, obscured_full: sum.obscured_full.length, obscured_partial: sum.obscured_partial.length,
      hidden: sum.hidden.length, in_aria_hidden: sum.aria_hidden.length, positive_tabindex: sum.positive_tabindex,
      context_changes: sum.context_changes, tooltips: sum.tooltips, left_page: sum.left_page || undefined,
      examples: { no_ring: ex(sum.no_ring), ring_unknown: ex(sum.ring_unknown, 3), caret_only: ex(sum.caret_only, 4), ring_low: ex(sum.ring_low), obscured_full: ex(sum.obscured_full), obscured_partial: ex(sum.obscured_partial, 3), hidden: ex(sum.hidden), in_aria_hidden: ex(sum.aria_hidden) },
      stops: walk.stops.map(compactStop),
    };
    if (walk.left) {
      // the page went away during the walk (Esc → history.back() and the like): start the rest from a fresh load
      res.not_checked.push(lang === 'en' ? 'keyboard: the page left its address after Esc — walk stopped, page reloaded' : 'клавиатура: после Esc страница ушла на другой адрес — обход остановлен, страница перезагружена');
      const lr = await load(page, pg.url, lang, true);
      if (!lr.ok) { res.error = lr.error; return res; }
    }
    res.skip_link = await skipLinkTest(page, walk).catch(e => ({ error: e.message.slice(0, 160) }));
    if (!res.skip_link.present) {
      const any = await page.evaluateIsolated(`[...document.querySelectorAll('a[href^="#"]')].some(a => ${SKIP_RE}.test(a.innerText || a.getAttribute('aria-label') || ''))`).catch(() => false);
      res.skip_link.exists_elsewhere = any;
    }
    phase('keyboard');
    // text spacing 1.4.12 (both widths), on this load before any toggle is opened
    await A(page, 'resetStart()');
    await A(page, 'clipBaseline()'); await A(page, 'leafBaseline(500)');
    await A(page, 'spacing(true)'); await sleep(350);
    res.text_spacing = { clipped_new: await A(page, 'clipNew()'), overlap_new: await A(page, 'overlapNew()') };
    await A(page, 'spacing(false)'); await sleep(200);
    if (!mobile) {
      // reflow at 320 CSS px (= 1280 px at 400 %) and zoom 200 % (= 1440 px at 200 %): the CSS viewport shrinks the same way
      await A(page, 'clipBaseline()');
      await page.setViewport({ width: 320, height: 256, mobile: false, deviceScaleFactor: 1 }); await sleep(700);
      res.reflow_320 = { ...(await A(page, 'overflow()')), clipped_new: await A(page, 'clipNew()') };
      await page.setViewport({ width: 720, height: 450, mobile: false, deviceScaleFactor: 1 }); await sleep(600);
      res.zoom_200 = { ...(await A(page, 'overflow()')), clipped_new: await A(page, 'clipNew()') };
      await page.setViewport({ width, height: 900, mobile: false }); await sleep(300);
    }
    phase('layout');
    // toggles from the white list (see kindOf): the ones reachable by Tab win. Disclosure and tabs are tried on this
    // load and put back; popup and menu get a fresh load each.
    const toggles = [];
    const fromWalk = {};
    for (const s of walk.stops) if (s.kind && (!fromWalk[s.kind] || (fromWalk[s.kind].weak && !s.weak))) fromWalk[s.kind] = { sel: s.sel, name: s.name, kind: s.kind, weak: !!s.weak };
    const ft = await A(page, 'findToggles()').catch(() => ({ found: {}, refused: {}, unclassified: { count: 0, examples: [] } }));
    const found = { ...ft.found };
    for (const [k, v] of Object.entries(fromWalk)) if (!(v.weak && found[k] && !found[k].weak)) found[k] = v; // reachable by Tab wins, structure beats dictionary
    res.toggles_refused = ft.refused; // candidates we did not press and why (submit, in-form, consent-banner, action-name…)
    res.toggles_unclassified = ft.unclassified || { count: 0, examples: [] };
    if (res.toggles_unclassified.count) res.not_checked.push(lang === 'en' ? `buttons without ARIA not pressed: ${res.toggles_unclassified.count} (${res.toggles_unclassified.examples.map(e => `«${e.name}»`).join(', ')})` : `кнопки без ARIA не нажимались: ${res.toggles_unclassified.count} (${res.toggles_unclassified.examples.map(e => `«${e.name}»`).join(', ')})`);
    const seen = k => { const key = `${k}|${found[k].sel}|${found[k].name}`; const same = opt.tested?.get(key); return { key, same }; };
    for (const k of ['disclosure', 'tab']) {
      if (!found[k]) continue;
      const { key, same } = seen(k);
      if (same) { toggles.push({ kind: k, trigger: { selector: found[k].sel, name: found[k].name }, same_as: same }); continue; }
      if (Date.now() > deadline - 20000) { res.not_checked.push(`toggle ${k}: budget`); continue; }
      const r = await (k === 'tab' ? tabsTest(page, found[k]) : disclosureTest(page, found[k])).catch(e => ({ kind: k, trigger: { selector: found[k].sel }, error: e.message.slice(0, 200) }));
      toggles.push(r);
      if (!r.error && !r.skipped) opt.tested?.set(key, `${pg.pid}@${width}`);
      if (r.navigated) { const lr = await load(page, pg.url, lang, true); if (!lr.ok) { res.error = lr.error; break; } }
    }
    for (const k of ['dialog', 'menu']) {
      if (!found[k]) continue;
      const { key, same } = seen(k);
      if (same) { toggles.push({ kind: k, trigger: { selector: found[k].sel, name: found[k].name }, same_as: same }); continue; }
      if (Date.now() > deadline - 20000) { res.not_checked.push(`toggle ${k}: budget`); continue; }
      const r = await toggleTest(page, pg.url, lang, found[k], opt.dialogAxe ? axe : null).catch(e => ({ kind: k, trigger: { selector: found[k].sel }, error: e.message.slice(0, 200) }));
      toggles.push(r);
      if (!r.error && !r.skipped) opt.tested?.set(key, `${pg.pid}@${width}`);
    }
    res.toggles = toggles;
    phase('toggles');
    if (!mobile) {
      // prefers-reduced-motion: reload with the media feature and compare long/infinite CSS animations
      const before = (motion0?.list || []).filter(a => a.visible && (a.infinite || (a.total && a.total > 5000)));
      if (!before.length && !(res.motion?.moving || []).length) { if (res.motion) res.motion.reduce = { skipped: 'nothing moves' }; }
      else if (Date.now() < deadline - 15000) {
        await page.emulateMedia({ reducedMotion: 'reduce' });
        const l3 = await load(page, pg.url, lang, true);
        if (l3.ok) {
          await page.scrollThrough({ step: 900, pause: 70, max: 20000 }); await sleep(400);
          const m1 = await A(page, 'motionSnap()');
          const rules = await A(page, 'reducedMotionRules()');
          const after = m1.list.filter(a => a.visible && (a.infinite || (a.total && a.total > 5000)));
          res.motion = res.motion || {};
          res.motion.reduce = { running_before: motion0?.running ?? null, running_after: m1.running, long_before: before.length, long_after: after.length,
            responds: before.length ? after.length < before.length : null, still_moving: after.slice(0, 5).map(a => a.sel), media_rules: rules.rules, closed_sheets: rules.closed,
            note: lang === 'en' ? 'JS-driven motion (carousels) is not re-measured under reduce' : 'движение на JS (карусели) под reduce не перемеряется' };
        }
        await page.emulateMedia({});
      } else res.not_checked.push('reduced-motion: budget');
      phase('reduced-motion');
    }
    return res;
  } finally {
    res.ms = Date.now() - t0;
    res.blocked = Object.fromEntries(Object.entries(page.blocked).map(([k, v]) => [k, v.length]).filter(([, v]) => v));
    await page.close();
  }
}

// ---------- page×width result → issues ----------
function issuesOf(p, lang) {
  const out = [];
  // extra: { level, wcag, confidence } overrides the table for this occurrence (dialog-axe takes them from axe rules)
  const add = (check, count, evidence, examples = [], extra = {}) => { if (count) out.push({ check, pid: p.pid, url: p.url, width: p.width, count, evidence, examples, ...extra }); };
  const en = lang === 'en';
  const k = p.keyboard;
  if (k) {
    const inv = (k.examples.no_ring || []).filter(x => x.ring === 'invisible').length;
    add('focus-not-visible', k.no_ring, (en ? `${k.no_ring} of ${k.unique} Tab stops show no visible focus` : `${k.no_ring} из ${k.unique} остановок Tab без видимого фокуса`) + (inv ? (en ? ` (examples with a ring of the background colour: ${inv})` : ` (в примерах кольцо цвета фона: ${inv})`) : '')
      + (k.ring_unknown ? (en ? `; ${k.ring_unknown} more without a baseline snapshot are not counted` : `; ещё ${k.ring_unknown} без снимка «до фокуса» не считались`) : ''), k.examples.no_ring);
    add('focus-caret-only', k.caret_only, en ? `${k.caret_only} text fields show focus only by the blinking caret (accepted for 2.4.7, hard to notice)` : `${k.caret_only} полей ввода показывают фокус только мигающим курсором (для 2.4.7 обычно засчитывается, но заметить трудно)`, k.examples.caret_only, { confidence: 'medium' });
    const cc = k.context_changes || [];
    add('focus-changes-context', cc.length, en ? `a Tab press alone tried to change context: ${cc.map(c => `${c.what} on «${c.name || c.sel || '?'}»`).join('; ')}` : `одно нажатие Tab пыталось сменить контекст: ${cc.map(c => `${c.what === 'navigation' ? 'переход' : 'новое окно'} на «${c.name || c.sel || '?'}»`).join('; ')}`, cc.map(c => ({ selector: c.sel, name: c.name, url: c.url })), { confidence: 'medium' });
    const tipsBad = (k.tooltips || []).filter(t => t.esc_hides === false);
    add('tooltip-esc', tipsBad.length, en ? `tooltip shown on focus stays after Esc (${tipsBad.length})` : `подсказка, появившаяся при фокусе, не закрывается Esc (${tipsBad.length})`, tipsBad.map(t => ({ selector: t.sel, name: t.name, tooltip: t.tooltip })));
    add('focus-ring-contrast', k.ring_low_contrast, en ? `${k.ring_low_contrast} focus rings below 3:1` : `колец фокуса ниже 3:1: ${k.ring_low_contrast}`, k.examples.ring_low);
    add('focus-obscured', k.obscured_full, en ? `${k.obscured_full} focused elements fully covered (centre and 4 corners)` : `${k.obscured_full} элементов в фокусе закрыты целиком (центр и 4 угла)`, k.examples.obscured_full);
    add('focus-on-hidden', k.hidden, en ? `${k.hidden} Tab stops land on invisible elements` : `${k.hidden} остановок Tab на невидимых элементах`, k.examples.hidden);
    add('focusable-in-aria-hidden', k.in_aria_hidden, en ? `${k.in_aria_hidden} focusable elements inside aria-hidden` : `${k.in_aria_hidden} фокусируемых внутри aria-hidden`, k.examples.in_aria_hidden);
    if (k.trap && !k.trap.esc_exits) add('keyboard-trap', 1, en ? `focus cycles through ${k.trap.cycle.length} elements from Tab #${k.trap.after + 1}, Esc does not let out` : `фокус ходит по кругу между ${k.trap.cycle.length} элементами с ${k.trap.after + 1}-го нажатия Tab, Esc не выпускает`, k.trap.cycle.map(s => ({ selector: s })));
    add('tabindex-positive', k.positive_tabindex.length, en ? `tabindex > 0 on ${k.positive_tabindex.length} elements` : `tabindex > 0 у ${k.positive_tabindex.length} элементов`, k.positive_tabindex.map(s => ({ selector: s })));
    if (k.iframe_longest_run >= 8) add('iframe-tab-stops', k.iframe_longest_run, en ? `one iframe takes ${k.iframe_longest_run} Tab presses in a row` : `iframe забирает ${k.iframe_longest_run} нажатий Tab подряд`, []);
  }
  const s = p.skip_link;
  // 2.4.1: a repeated block of ≥ 5 Tab stops before the content. Without a skip link and without main it fails (A);
  // with main the landmark is a sufficient technique (ARIA11) — the skip link is then a recommendation
  const hasMain = p.basics ? !!p.basics.main : !!p.ax?.landmarks?.main;
  if (s && !s.present && k && (k.lead_block ?? 0) >= 5) {
    if (!hasMain) add('skip-link-missing', 1, en ? `no skip link and no main: ${k.lead_block} Tab stops in the repeated block (${k.lead_by}) before the content` : `нет ни ссылки пропуска, ни main: ${k.lead_block} остановок Tab в повторяющемся блоке (${k.lead_by}) до содержимого`);
    else add('skip-link-recommended', 1, en ? `no skip link; ${k.lead_block} Tab stops before the content, main exists (2.4.1 met by landmarks)` : `нет ссылки пропуска; до содержимого ${k.lead_block} остановок Tab, main есть (2.4.1 закрыт ориентирами)`);
  }
  if (s && s.present && s.works === false) add('skip-link-broken', 1, en ? `skip link «${s.name}» → #${s.target}: target ${s.target_exists ? 'exists, focus does not move' : 'not found'}` : `«${s.name}» → #${s.target}: ${s.target_exists ? 'цель есть, фокус не переходит' : 'цели нет на странице'}`, [{ selector: s.selector }]);
  if (s && s.present && s.visible_on_focus === false) add('skip-link-broken', 1, en ? 'skip link stays invisible when focused' : 'ссылка пропуска не появляется при фокусе', [{ selector: s.selector }]);
  for (const t of p.toggles || []) {
    const ex1 = [{ selector: t.trigger?.selector, name: t.trigger?.name }];
    // for an opened window: also where it is and its mouse-only close icon, so the finding points at the window itself
    const exWin = [...ex1, ...(t.container ? [{ selector: t.container, role: 'container' }] : []), ...(t.close_not_keyboard ? [{ selector: t.close_not_keyboard.sel, role: 'close-not-keyboard' }] : [])];
    const fakeClose = t.close_not_keyboard ? (en ? `; the close icon ${t.close_not_keyboard.tag} is mouse-only${t.close_not_keyboard.named ? '' : ', no name'}` : `; крестик — ${t.close_not_keyboard.tag} только для мыши${t.close_not_keyboard.named ? '' : ', без имени'}`) : '';
    const what = t.kind === 'dialog' ? (en ? 'popup' : 'попап') : t.kind === 'menu' ? (en ? 'menu' : 'меню') : t.kind === 'tab' ? (en ? 'tab' : 'вкладка') : (en ? 'disclosure' : 'раскрывающийся блок');
    if (t.error || t.skipped || t.same_as || t.navigated) continue;
    if (t.expanded_stale) add('aria-expanded-stale', 1, en ? `${what} «${t.trigger?.name}»: the block opened, aria-expanded stayed «${t.expanded_after ?? t.expanded_before}»` : `${what} «${t.trigger?.name}»: блок открыт, а aria-expanded остался «${t.expanded_after ?? t.expanded_before}»`, ex1);
    if (t.kind === 'disclosure' || t.kind === 'tab') continue; // data for the lens: opened, keys, arrows_move_focus
    if (!t.opened) { if (t.opened_by_click) add('toggle-no-keyboard', 1, en ? `${what} «${t.trigger?.name}» opens on click but not with Enter or Space` : `${what} «${t.trigger?.name}» открывается кликом, но не Enter и не пробелом`, ex1); continue; }
    const dialogLike = t.modal || t.kind === 'dialog';
    if (dialogLike && !t.focus_moved_in) add('dialog-focus-not-moved', 1, en ? `${what} opened, focus stayed on the page` : `${what} открылся, фокус остался на странице`, ex1);
    if (dialogLike && t.escaped) add('dialog-focus-escapes', 1, en ? `Tab leaves the open ${what}: ${t.tab_outside} of 15 stops behind it (first ${t.first_outside})` : `Tab уходит из открытого окна: ${t.tab_outside} из 15 остановок за ним (первая ${t.first_outside})`, ex1);
    if (!dialogLike && t.container && t.tab_inside === 0) add('toggle-content-unreachable', 1, en ? `${what} opened, its items are not reached in 15 Tab presses` : `${what} открылось, но его пункты не достигаются за 15 нажатий Tab`, ex1);
    if (t.trap) add('keyboard-trap', 1, en ? `${what} «${t.trigger?.name}»: Tab cycles inside, Esc does not close, no keyboard close button${fakeClose}` : `${what} «${t.trigger?.name}»: Tab ходит внутри, Esc не закрывает, кнопки закрытия с клавиатуры нет${fakeClose}`, exWin);
    else if (t.esc_closes === false && (dialogLike || t.overlay)) add('toggle-esc', 1, en ? `Esc does not close the ${what}${t.close_control ? ' (close button works from the keyboard)' : fakeClose}` : `Esc не закрывает ${what}${t.close_control ? ' (кнопка закрытия с клавиатуры есть)' : fakeClose}`, exWin);
    if (t.focus_returned === false) add('toggle-focus-not-returned', 1, en ? `after closing, focus is on ${t.focus_after_close || 'body'}` : `после закрытия фокус на ${t.focus_after_close || 'body'}, не на кнопке`, ex1);
    if (t.axe?.length) {
      // level and criteria of the rules axe found (best practice rules stay bp)
      const rank = { A: 0, AA: 1, AAA: 2, bp: 3 };
      const lv = t.axe.map(v => v.level || 'bp').sort((x, y) => (rank[x] ?? 3) - (rank[y] ?? 3))[0] || 'bp';
      const refs = [...new Set(t.axe.flatMap(v => v.wcag || []))];
      add('dialog-axe', t.axe.reduce((a, v) => a + v.nodes, 0), (en ? 'axe in the open popup: ' : 'axe в открытом окне: ') + t.axe.map(v => `${v.rule}${v.level ? ` (${v.level})` : ''} ×${v.nodes}`).join(', '), t.axe.map(v => ({ selector: v.example, rule: v.rule, level: v.level, wcag: v.wcag })), { level: lv, wcag: refs.join(', ') || null });
    }
  }
  const b = p.basics;
  if (b) {
    if (b.viewport.blocks_zoom || b.touch_blocks_zoom) add('zoom-blocked', 1, b.viewport.blocks_zoom ? `meta viewport: «${b.viewport.content}»${b.viewport.count > 1 ? (en ? ` (viewport tags: ${b.viewport.count})` : ` (тегов viewport: ${b.viewport.count})`) : ''}` : `touch-action: ${b.touch_action.join(' / ')}`);
    const noTitle = b.iframes.filter(f => f.visible && !f.ariaHidden && !f.title && !f.aria);
    add('iframe-no-title', noTitle.length, (en ? 'iframes without title: ' : 'iframe без title: ') + noTitle.map(f => f.host || 'about:blank').join(', '), noTitle.map(f => ({ selector: f.sel, box: f.box })));
    if (!b.lang) add('lang-missing', 1, en ? '<html> has no lang' : '<html> без lang');
    if (!b.title) add('title-missing', 1, en ? 'document title is empty' : 'title пустой');
    // by attributes too: a headless browser may block autoplay with sound, then «playing» alone would miss it
    // a <video autoplay> without muted is often a silent background clip: it counts when it decoded sound, otherwise low confidence
    const longish = m => m.loop || m.duration === null || m.duration > 3;
    const audio = b.media.filter(m => !m.muted && longish(m) && (m.autoplay || m.playing) && (m.tag === 'audio' || m.audio_bytes > 0));
    const videoUnknown = b.media.filter(m => !m.muted && longish(m) && m.tag === 'video' && m.autoplay && !(m.audio_bytes > 0) && !m.playing);
    add('autoplay-audio', videoUnknown.length, en ? 'video with autoplay and without muted did not start here — whether it has sound is unknown' : 'видео с autoplay без muted здесь не запустилось — есть ли в нём звук, неизвестно', videoUnknown.map(m => ({ selector: m.sel, tag: m.tag })), { confidence: 'low' });
    add('autoplay-audio', audio.length, en ? 'media starts with sound on load (autoplay without muted' + (audio.some(m => m.loop) ? ', loop' : '') + ')' : 'медиа включается со звуком при загрузке (autoplay без muted' + (audio.some(m => m.loop) ? ', loop' : '') + ')',
      audio.map(m => ({ selector: m.sel, tag: m.tag, autoplay: m.autoplay, loop: m.loop, playing: m.playing, duration: m.duration, controls: m.controls })));
    const junk = b.junk_alt || [];
    add('images-junk-alt', junk.length, (en ? 'alt says nothing: ' : 'alt ни о чём: ') + junk.slice(0, 4).map(j => `«${j.alt}»`).join(', '), junk.map(j => ({ selector: j.sel, alt: j.alt, box: j.box })));
    const vids = b.media.filter(m => m.tag === 'video' && m.visible && !m.captions && (m.controls || m.duration > 10) && !m.muted);
    add('media-no-captions', vids.length, en ? 'video with sound and no captions track' : 'видео со звуком без дорожки субтитров', vids.map(m => ({ selector: m.sel })));
  }
  const ax = p.ax;
  if (ax) {
    const un = ax.unnamed.button + ax.unnamed.link + ax.unnamed.field + ax.unnamed.other;
    add('unnamed-controls', un, en ? `no accessible name: buttons ${ax.unnamed.button}, links ${ax.unnamed.link}, fields ${ax.unnamed.field}` : `без имени: кнопок ${ax.unnamed.button}, ссылок ${ax.unnamed.link}, полей ${ax.unnamed.field}`, ax.unnamed_examples.filter(e => e.role !== 'image' && e.role !== 'img'));
    add('images-no-name', ax.images.unnamed, en ? `${ax.images.unnamed} of ${ax.images.total} images are read without a name` : `${ax.images.unnamed} из ${ax.images.total} картинок без текстовой альтернативы`, ax.unnamed_examples.filter(e => e.role === 'image' || e.role === 'img'));
    if (!ax.landmarks.main) add('no-main-landmark', 1, en ? 'no <main> / role=main' : 'нет <main> или role=main');
    if (ax.h1_count !== 1 || ax.heading_skips.length) add('headings', 1, `H1: ${ax.h1_count}` + (ax.heading_skips.length ? '; ' + ax.heading_skips.slice(0, 3).join('; ') : ''));
  }
  // 2.4.4 only for links with no programmatic context; with a card heading / sentence around them it is 2.4.9 (AAA)
  for (const g of p.links_generic || []) {
    if (g.no_context) add('generic-link-text', g.no_context, en ? `«${g.text}» ×${g.count} to ${g.targets} different pages, ${g.no_context} with no heading, sentence or list item around` : `«${g.text}» ×${g.count} на ${g.targets} разных страниц, у ${g.no_context} нет ни заголовка, ни фразы, ни пункта списка рядом`, g.examples.map(x => ({ selector: x })));
    else add('generic-link-text-context', g.count, en ? `«${g.text}» ×${g.count}: purpose only from context (${Object.keys(g.contexts).join(', ')})` : `«${g.text}» ×${g.count}: смысл только из контекста (${Object.keys(g.contexts).join(', ')})`, g.examples.map(x => ({ selector: x })));
  }
  if (p.reflow_320 && (p.reflow_320.overflow || p.reflow_320.clipped_new?.length)) {
    const r = p.reflow_320; const real = (r.culprits || []).filter(c => !c.exempt); const cut = (r.clipped_new || []).filter(c => c.sel);
    const parts = [];
    if (r.overflow && real.length) parts.push(r.root_clips_x ? (en ? `content is ${r.sw} px wide at 320 px and html/body cut it off without a scrollbar` : `контент шириной ${r.sw} px при окне 320 px, html/body обрезают его без прокрутки`) : (en ? `page is ${r.sw} px wide at 320 px` : `ширина страницы ${r.sw} px при окне 320 px`));
    if (cut.length) parts.push(en ? `text cut off in ${cut.length} blocks (up to ${Math.max(...cut.map(c => c.cut_px))} px)` : `текст обрезан в ${cut.length} блоках (до ${Math.max(...cut.map(c => c.cut_px))} px)`);
    if (parts.length) add('reflow-320', 1, parts.join('; '), real.map(c => ({ selector: c.sel, width: c.width, right: c.right })).concat(cut.map(c => ({ selector: c.sel, text: c.text, cut_px: c.cut_px, box: c.box }))));
  }
  if (p.zoom_200 && (p.zoom_200.overflow || p.zoom_200.clipped_new?.length)) {
    const z = p.zoom_200; const real = (z.culprits || []).filter(c => !c.exempt);
    const cut = z.clipped_new.filter(c => c.sel);
    const parts = [];
    if (z.overflow && real.length) parts.push(en ? `horizontal scroll: page ${z.sw} px wide at 720 px` : `горизонтальная прокрутка: страница ${z.sw} px при окне 720 px`);
    if (cut.length) parts.push(en ? `text cut off in ${cut.length} blocks (up to ${Math.max(...cut.map(c => c.cut_px))} px)` : `текст обрезан в ${cut.length} блоках (до ${Math.max(...cut.map(c => c.cut_px))} px)`);
    if (parts.length) add('zoom-200', 1, parts.join('; '),
      real.map(c => ({ selector: c.sel, width: c.width })).concat(cut.map(c => ({ selector: c.sel, text: c.text, cut_px: c.cut_px, box: c.box }))));
  }
  if (p.text_spacing && (p.text_spacing.clipped_new.length || p.text_spacing.overlap_new.length)) {
    const ts = p.text_spacing;
    add('text-spacing', ts.clipped_new.filter(c => c.sel).length + ts.overlap_new.length, en ? `clipped ${ts.clipped_new.filter(c => c.sel).length}, overlapping ${ts.overlap_new.length}` : `обрезано ${ts.clipped_new.filter(c => c.sel).length}, наложений ${ts.overlap_new.length}`,
      ts.clipped_new.filter(c => c.sel).map(c => ({ selector: c.sel, text: c.text, cut_px: c.cut_px, box: c.box })).concat(ts.overlap_new.map(o => ({ selector: o.a, with: o.b, text: o.text }))));
  }
  if (p.motion) {
    const nop = (p.motion.moving || []).filter(m => !m.pause);
    const rd = p.motion.reduce;
    const tail = rd && rd.responds === true ? (en ? '; with prefers-reduced-motion the CSS animations stop' : '; при prefers-reduced-motion CSS-анимации останавливаются') : '';
    add('motion-no-pause', nop.length, (en ? `${nop.length} blocks move on their own for more than 5 s without a pause button` : `${nop.length} блоков двигаются сами дольше 5 с без кнопки паузы`) + tail, nop.map(m => ({ selector: m.sel, text: m.text, box: m.box })));
    if (p.motion.reduce && p.motion.reduce.responds === false) add('reduced-motion-ignored', p.motion.reduce.long_after, en ? `with reduce ${p.motion.reduce.long_after} of ${p.motion.reduce.long_before} long animations keep running; media rules: ${p.motion.reduce.media_rules}` : `при reduce продолжают идти ${p.motion.reduce.long_after} из ${p.motion.reduce.long_before} долгих анимаций; правил @media: ${p.motion.reduce.media_rules}`, p.motion.reduce.still_moving.map(s => ({ selector: s })));
  }
  return out;
}

function aggregate(issues, lang) {
  const by = new Map();
  const rank = { A: 0, AA: 1, AAA: 2, bp: 3 };
  const conf = { high: 0, medium: 1, low: 2 };
  for (const i of issues) {
    let a = by.get(i.check);
    if (!a) { const [wcag, level] = WCAG[i.check] || [null, null]; a = { check: i.check, title: TXT[lang].checks[i.check] || i.check, wcag, level, confidence: null, count_total: 0, pages: [], widths: [], where: [] }; by.set(i.check, a); }
    // per-occurrence level (dialog-axe): the item keeps the strongest one; criteria are joined
    if (i.level && (a._lv === undefined || (rank[i.level] ?? 3) < (rank[a._lv] ?? 3))) { a._lv = i.level; a.level = i.level; }
    if (i.wcag) a.wcag = [...new Set([...(a.wcag ? String(a.wcag).split(', ') : []), ...String(i.wcag).split(', ')])].filter(Boolean).join(', ');
    const c = i.confidence || 'high';
    if (a.confidence === null || (conf[c] ?? 0) < (conf[a.confidence] ?? 0)) a.confidence = c;
    a.count_total += i.count;
    if (!a.pages.includes(i.pid)) a.pages.push(i.pid);
    if (!a.widths.includes(i.width)) a.widths.push(i.width);
    a.where.push({ pid: i.pid, url: i.url, width: i.width, count: i.count, evidence: i.evidence, examples: (i.examples || []).slice(0, 6), ...(i.confidence ? { confidence: i.confidence } : {}), ...(i.level ? { level: i.level } : {}) });
  }
  const order = { A: 0, AA: 1, bp: 2, AAA: 3 };
  return [...by.values()].map(({ _lv, ...a }) => ({ ...a, sitewide: a.pages.length > 1 })).sort((x, y) => (order[x.level] ?? 9) - (order[y.level] ?? 9) || y.pages.length - x.pages.length);
}

// headless Chrome blocks autoplay with sound without a user gesture: allow it so autoplay-audio sees real playback
// (lib/cdp starts the browser with --mute-audio: nothing is heard)
const LAUNCH = { args: ['--autoplay-policy=no-user-gesture-required'] };

// 3.2.6 data for the lens: per width, the order of help mechanisms (phone, mail, messenger) by region on pages that have them
function helpConsistency(results) {
  const out = {};
  for (const p of results) {
    const hl = p.basics?.help_links; if (!hl || !hl.length) continue;
    const by = {};
    for (const h of [...hl].sort((a, b) => a.y - b.y)) { by[h.region] ||= []; if (!by[h.region].includes(h.kind)) by[h.region].push(h.kind); }
    const sig = Object.entries(by).map(([r, ks]) => `${r}:${ks.join(',')}`).join(' | ');
    const w = out[p.width] ||= { pages_with_help: 0, patterns: {} };
    w.pages_with_help++; (w.patterns[sig] ||= []).push(p.pid);
  }
  for (const w of Object.values(out)) {
    const pats = Object.entries(w.patterns).sort((a, b) => b[1].length - a[1].length);
    w.main = pats[0]?.[0] || null; w.differs = pats.slice(1).map(([sig, pids]) => ({ sig, pids }));
    w.patterns = Object.fromEntries(pats);
  }
  return out;
}

function pickPages(all, max) {
  if (!max || all.length <= max) return { take: all, rest: [] };
  const take = []; const seen = new Set();
  const push = p => { if (take.length < max && !take.includes(p)) take.push(p); };
  push(all.find(p => p.pid === 'home') || all[0]);
  for (const p of all) if (p.template && !seen.has(p.template)) { seen.add(p.template); push(p); }
  for (const p of all) if (/контакт|contact|форм|form|заявк|запис|корзин|cart|checkout|вход|login|signin|price|цен|услуг/i.test(`${p.url} ${p.why || ''} ${p.title || ''}`)) push(p);
  for (const p of all) push(p);
  return { take, rest: all.filter(p => !take.includes(p)) };
}

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2), { boolean: ['dialog-axe', 'help', 'allow-load-posts'] });
  const lang = langOf(args);
  helpAndExit(lang === 'en' ? HELP_EN : HELP, args);
  const run = requireRun(args);
  const started = Date.now();
  const budget = Math.max(60, Number(args['budget-sec'] || 480));
  const deadline = started + budget * 1000;
  const tabs = Math.max(10, Math.min(200, Number(args.tabs || 60)));
  const widths = listArg(args.widths).map(Number).filter(Boolean);
  const W = widths.length ? widths : [1440, 390];
  const maxPages = args['max-pages'] === undefined ? 12 : Number(args['max-pages']);
  const brief = loadBrief(run);
  const pagesAll = loadPages(run, args).filter(p => p.url && !p.blocked);
  if (!pagesAll.length) { console.error(lang === 'en' ? 'No pages to check in pages.json.' : 'В pages.json нет страниц для проверки.'); process.exit(2); }
  const { take, rest } = listArg(args.pages).length ? { take: pagesAll, rest: [] } : pickPages(pagesAll, maxPages);
  // the reviewed site itself may be local (demo, staging on this machine): allow only its host
  const pj = readJSON(join(run, 'pages.json'), {});
  const siteHost = hostOf(pj.final_origin || pj.site || take[0].url);
  if (siteHost && await resolvesPrivate(siteHost)) allowPrivateHost(siteHost);

  const outPath = join(run, 'measure', 'a11y.json');
  const prev = readJSON(outPath, null);
  const resume = prev && prev.partial && prev.resume?.done ? prev : null;
  const done = new Set(resume ? resume.resume.done : []);
  const attempts = { ...(resume?.resume?.attempts || {}) }; // page×width cut by the budget: tried again once, then recorded as an error
  const results = resume ? prev.pages.filter(p => done.has(`${p.pid}@${p.width}`)) : [];
  const errors = resume ? (prev.errors || []) : [];

  let axe = null; // { source, version } — axe runs in the isolated world and its version is checked (collectors/axe.mjs)
  if (args['dialog-axe'] !== false) {
    const ax = await loadAxe({ run, brief, lang });
    if (!ax.error) axe = { source: ax.source, version: ax.version };
  }
  const jobs = [];
  for (const pg of take) for (const w of W) if (!done.has(`${pg.pid}@${w}`)) jobs.push([pg, w]);
  // toggles tested per width (restored from a partial result on resume)
  const tested = new Map(W.map(w => [w, new Map()]));
  for (const p of results) for (const t of p.toggles || []) if (!t.error && !t.same_as && t.trigger && tested.has(p.width)) tested.get(p.width).set(`${t.kind}|${t.trigger.selector}|${t.trigger.name}`, `${p.pid}@${p.width}`);

  let slotWait = null; // seconds waited for a free browser when none came (partial_reason slot_wait)
  const write = (partial) => {
    const out = { ...measureHeader('a11y', run), partial, resume: partial ? { done: [...done], attempts } : null };
    if (partial && slotWait !== null) { out.partial_reason = 'slot_wait'; out.slot_wait_sec = slotWait; }
    out.pages = results;
    out.errors = errors;
    out.not_checked = [];
    if (slotWait !== null) out.not_checked.push({ what: 'slot_wait', why: lang === 'en' ? `browser busy with other checks (slot_wait, waited ${slotWait} s) — repeat the call` : `браузер занят другими проверками (slot_wait, ждали ${slotWait} с) — повторите вызов` });
    if (rest.length) out.not_checked.push({ what: 'pages', why: lang === 'en' ? `${rest.length} pages over --max-pages ${maxPages}` : `${rest.length} страниц сверх --max-pages ${maxPages}`, pids: rest.map(p => p.pid) });
    if (!axe && args['dialog-axe'] !== false) out.not_checked.push({ what: 'dialog-axe', why: lang === 'en' ? 'axe-core unavailable' : 'axe-core недоступен' });
    out.not_checked.push({ what: 'screen-reader', why: lang === 'en' ? 'no real screen reader (NVDA/VoiceOver): reading is taken from the accessibility tree' : 'настоящим скринридером (NVDA/VoiceOver) не проверялось: чтение взято из дерева доступности' });
    for (const p of results) for (const n of p.not_checked || []) out.not_checked.push({ pid: p.pid, width: p.width, what: n });
    const issues = results.flatMap(p => (p.error ? [] : issuesOf(p, lang)));
    out.items = aggregate(issues, lang);
    out.summary = {
      pages: new Set(results.map(p => p.pid)).size, runs: results.length, tabs_pressed: results.reduce((a, p) => a + (p.keyboard?.tabs_pressed || 0), 0),
      checks_failed: out.items.length, by_level: out.items.reduce((a, i) => { a[i.level] = (a[i.level] || 0) + 1; return a; }, {}),
      skip_link: { present: results.filter(p => p.skip_link?.present).length, works: results.filter(p => p.skip_link?.works).length, of: results.length },
      blocked_by_safety: results.reduce((a, p) => { for (const [k, v] of Object.entries(p.blocked || {})) a[k] = (a[k] || 0) + v; return a; }, {}),
      toggles: { tested: results.reduce((a, p) => a + (p.toggles || []).filter(t => !t.same_as && !t.skipped && !t.error).length, 0), clicked: results.reduce((a, p) => a + (p.toggles || []).filter(t => t.clicked).length, 0),
        refused: results.reduce((a, p) => { for (const [k, v] of Object.entries(p.toggles_refused || {})) a[k] = (a[k] || 0) + v; return a; }, {}),
        unclassified: results.reduce((a, p) => a + (p.toggles_unclassified?.count || 0), 0) },
      consistent_help: helpConsistency(results),
      method: lang === 'en' ? 'all page code in an isolated JS world; real key events via CDP: Tab and Esc anywhere; Enter/Space/arrows only with verified focus on white-listed toggles (summary, aria-expanded/controls/haspopup, role=tab, data-toggle, accordion, burger, #hash to a hidden block, a plain button or «#» link with popup/modal/callback in class/id/data-* or an opener name such as «Записаться»; never submit, form, contact fields, cookie banner, tel:/mailto:, javascript: code, action names); Enter on a verified skip link and a strict close button; one real mouse click per toggle that did not open from the keyboard, only if nothing else is under its centre (lib/cdp also refuses submit, consent, contact form, iframe); the lib/cdp guard cuts background requests after every press. Styles before/after focus (element, 3 ancestors, children), elementFromPoint at centre+corners, Accessibility.getFullAXTree, viewport 320×256 and 720×450 for zoom, injected 1.4.12 spacing, emulated prefers-reduced-motion, autoplay allowed by a browser flag (sound muted at the output).'
        : 'весь код в странице — в изолированном JS-мире; реальные нажатия через CDP: Tab и Esc везде; Enter/пробел/стрелки — только при проверенном фокусе на переключателе из белого списка (summary, aria-expanded/controls/haspopup, role=tab, data-toggle, аккордеон, бургер, #якорь на скрытый блок; никогда — отправка, форма, поля контактов, cookie-баннер, tel:/mailto:, javascript: с кодом, имена действий); Enter на проверенной ссылке пропуска и строгой кнопке закрытия; один настоящий клик мышью на переключатель, который не открылся с клавиатуры, и только если под его центром нет другого элемента (lib/cdp ещё отказывает submit, согласию cookie, контактной форме, iframe); после каждого нажатия страховка lib/cdp обрывает фоновые запросы. Стили до/после фокуса (элемент, 3 предка, дети), elementFromPoint в центре и углах, Accessibility.getFullAXTree, окна 320×256 и 720×450 для зума, подмена интервалов 1.4.12, эмуляция prefers-reduced-motion, автовоспроизведение разрешено флагом браузера (звук на выходе выключен).',
    };
    writeJSON(outPath, out);
    return out;
  };

  let partial = false;
  let release = null;
  if (jobs.length) {
    // wait for a browser only within the budget; no slot -> partial + 75 (slot_wait), the same call continues
    const tw = Date.now();
    try { release = await acquireBrowserSlot({ waitMs: Math.max(5000, deadline - Date.now() - 15000) }); }
    catch (e) {
      if (e.code !== 'SLOT_TIMEOUT') throw e;
      slotWait = Math.round((Date.now() - tw) / 1000); partial = true;
      runLog(run, `a11y: ждал свободный браузер ${slotWait} с, не дождался (slot_wait)`);
    }
  }
  if (release) {
    let browser = null;
    try {
      try { browser = await Browser.launch(LAUNCH); }
      catch (e) { release(); release = null; console.error(String(e.message || e)); process.exit(2); } // no browser: environment error
      let ran = 0;
      for (const [pg, w] of jobs) {
        // typical time: desktop 15–60 s, phone 5–25 s; the first job of a call always runs, so every call moves forward
        const need = w >= 768 ? 40000 : 25000;
        if (ran && Date.now() + need > deadline - 8000) { partial = true; break; }
        ran++;
        progress(`a11y: ${pg.pid} @${w}`);
        const key = `${pg.pid}@${w}`;
        const remaining = Math.max(30000, deadline - Date.now() - 6000);
        let r;
        try {
          const job = checkPage(browser, pg, w, { lang, tabs, axe, deadline, dialogAxe: args['dialog-axe'] !== false, allowLoadPosts: !!args['allow-load-posts'], tested: tested.get(w) });
          job.catch(() => {});
          r = await Promise.race([job, sleep(remaining).then(() => ({ timeout: true }))]);
        } catch (e) { r = { pid: pg.pid, url: pg.url, width: w, error: String(e.message || e).slice(0, 300) }; }
        if (r.timeout) {
          attempts[key] = (attempts[key] || 0) + 1;
          if (attempts[key] < 2) { partial = true; break; }
          r = { pid: pg.pid, url: pg.url, width: w, error: lang === 'en' ? 'did not finish in two tries (page too slow for the time budget)' : 'не уложилась в две попытки (страница слишком медленная для бюджета времени)' };
          // the half-done job may still hold the tab: a fresh browser for the rest
          try { await browser.close(); } catch {}
          browser = await Browser.launch(LAUNCH);
        }
        if (r.error) errors.push({ pid: pg.pid, width: w, error: r.error });
        results.push(r); done.add(`${pg.pid}@${w}`);
        write(true);
      }
    } finally {
      if (browser) await browser.close();
      if (release) release();
    }
  }
  const out = write(partial);
  printAndSave(run, out, lang, partial);
  process.exit(partial ? 75 : 0);
}

function printAndSave(run, out, lang, partial) {
  const t = TXT[lang]; const en = lang === 'en';
  const s = out.summary;
  const lines = [];
  lines.push(`a11y: ${t.pages} ${s.pages}, ${en ? 'page×width runs' : 'прогонов страница×ширина'} ${s.runs}, ${t.tabs} ${s.tabs_pressed}`);
  const find = c => out.items.find(i => i.check === c);
  let shownLines = 0;
  const line = (c, extra = '') => {
    const i = find(c); if (!i || shownLines >= 30) return; // keep the tail (skip link, safety, written) inside 40 lines
    shownLines++;
    const byPid = new Map(); for (const w of i.where) { if (!byPid.has(w.pid)) byPid.set(w.pid, { widths: [], evidence: w.evidence }); byPid.get(w.pid).widths.push(w.width); }
    const shown = [...byPid.entries()].slice(0, 2).map(([pid, v]) => `${pid}@${v.widths.join('/')} ${v.evidence}`).join('; ').slice(0, 220);
    lines.push(`- ${i.title} [${i.wcag || '—'}${i.level ? ' ' + i.level : ''}]: ${shown}${byPid.size > 2 ? (en ? ` (+${byPid.size - 2} pages)` : ` (+${byPid.size - 2} стр.)`) : ''}${extra}`);
  };
  for (const c of ['keyboard-trap', 'focus-not-visible', 'focus-obscured', 'focus-on-hidden', 'focus-ring-contrast', 'toggle-no-keyboard', 'dialog-focus-not-moved', 'dialog-focus-escapes', 'toggle-esc', 'toggle-focus-not-returned', 'toggle-content-unreachable',
    'focus-changes-context', 'aria-expanded-stale', 'tooltip-esc',
    'skip-link-missing', 'skip-link-broken', 'zoom-blocked', 'reflow-320', 'zoom-200', 'text-spacing', 'motion-no-pause', 'reduced-motion-ignored', 'autoplay-audio', 'iframe-no-title', 'unnamed-controls', 'images-no-name', 'images-junk-alt',
    'generic-link-text', 'headings', 'no-main-landmark', 'lang-missing', 'title-missing', 'focusable-in-aria-hidden', 'dialog-axe', 'media-no-captions',
    'skip-link-recommended', 'generic-link-text-context', 'focus-caret-only', 'tabindex-positive', 'iframe-tab-stops']) line(c);
  if (s.toggles && (s.toggles.tested || s.toggles.unclassified || Object.keys(s.toggles.refused || {}).length)) lines.push(`${en ? 'Toggles pressed' : 'Переключателей нажато'}: ${s.toggles.tested}${s.toggles.clicked ? (en ? `, clicked ${s.toggles.clicked}` : `, кликом ${s.toggles.clicked}`) : ''}; ${en ? 'not pressed' : 'не нажимали'}: ${Object.entries(s.toggles.refused || {}).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}${s.toggles.unclassified ? (en ? `; buttons without ARIA not pressed: ${s.toggles.unclassified}` : `; кнопки без ARIA не нажимались: ${s.toggles.unclassified}`) : ''}`);
  if (!out.items.length && s.runs) lines.push(en ? '- no issues found by the script (the lens still checks meaning, names and order by eye)' : '- скрипт нарушений не нашёл (смысл имён и порядок линза смотрит сама)');
  lines.push(`${en ? 'Skip link' : 'Ссылка пропуска'}: ${s.skip_link.present}/${s.skip_link.of}, ${en ? 'works' : 'работает'} ${s.skip_link.works}`);
  if (Object.keys(s.blocked_by_safety).length) lines.push(`${en ? 'Blocked by safety net' : 'Отрезано страховкой'}: ${Object.entries(s.blocked_by_safety).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (out.errors.length) lines.push(`${en ? 'Errors' : 'Ошибки'}: ${out.errors.slice(0, 3).map(e => `${e.pid}@${e.width} ${e.error}`).join('; ').slice(0, 200)}`);
  const nc = out.not_checked.filter(n => n.what !== 'screen-reader');
  if (nc.length) lines.push(`${en ? 'Not checked' : 'Не проверено'}: ${nc.slice(0, 4).map(n => (n.pid ? `${n.pid}@${n.width} ` : '') + (n.why || n.what)).join('; ').slice(0, 220)}`);
  lines.push(`${t.written}: ${join(run, 'measure', 'a11y.json')}`);
  if (partial) lines.push(out.partial_reason === 'slot_wait' ? t.partialSlot : t.partial);
  printAndSaveSummary(run, 'a11y', lines);
  runLog(run, `a11y.mjs: ${s.runs} ${en ? 'runs' : 'прогонов'}, ${out.items.length} ${en ? 'issue types' : 'видов нарушений'}${partial ? ' (partial)' : ''}`);
}

main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
