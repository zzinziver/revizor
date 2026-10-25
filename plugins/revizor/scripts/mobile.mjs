#!/usr/bin/env node
// Revizor — mobile.mjs: responsive layout and touch checks for the `mobile` lens (also feeds ux, a11y, color).
// One touch load (390) and one desktop load (1440) per page, then resize sweeps; overflow found on resize is
// confirmed by a fresh load. Burger is opened by real touch: candidates are checked with page.hitInfo first and
// links to other addresses, tel:/mailto:, form controls are never tapped (lib/cdp also refuses iframes, submit,
// consent "accept" and contact-form buttons); navigation from taps is cut by lib/cdp.
// Nothing is typed, nothing is submitted, no query params are added. Measurements run in an isolated world.
//
//   node mobile.mjs --run "<RUN>" [--pages home,p01 [--subset]] [--depth lite|standard|deep] [--widths 360,1366x657]
//                   [--checks sizes,targets,burger,code,nav,landscape] [--url <url>] [--budget-sec 480] [--lang ru|en]

import { join, relative, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { Browser } from './lib/cdp.mjs';
import * as U from './lib/util.mjs';
import { imageStats } from './lib/img.mjs';

const NAME = 'mobile';
const HELP = `
mobile.mjs — мобильная вёрстка и совместимость (линза mobile; данные для ux, a11y, color)

  node mobile.mjs --run "<RUN>" [флаги]

Что делает (только чтение, без отправок и без меток в адресах):
  · ширины 280–1920: переполнение и виновник (с учётом обрезки предком), текст, обрезанный предком
    (clipped_content), кнопка действия в первом экране (844 и 664 px — видимая часть в Safari iPhone);
    переполнение, найденное при смене ширины, подтверждается новой загрузкой; переполнение во время прокрутки;
  · окна ноутбуков 1280×689, 1366×657, 1536×745 (deep: +1440×789, 1920×969, 744, планшеты 1024×1366 и 1180×820
    с тачем): кадр первого экрана, кнопка действия в окне, мелкий текст и zoom/scale платформы;
  · 390: цели касания (24 px — WCAG 2.5.8 AA, 44 px — Apple/2.5.5) и hit-test elementFromPoint в центре каждой
    (включая div/span с cursor: pointer), мелкий текст (доли знаков < 12/14/16 px), поля < 16 px, липкие слои,
    полноэкранная заставка (fullscreen_overlay: скрывается, замеры — после неё), видео, 100vh, длина в экранах,
    таблицы шире экрана (прокрутка или обрезка), вес страницы для слабых телефонов (узлы DOM, память JS);
  · бургер: реальное касание только переключателя (перед касанием hitInfo; ссылки на другой адрес, tel:/mailto:
    и кнопки форм пропускаются), кадр, блокировка прокрутки, закрытие (Esc, мимо, крестик, повторное касание),
    пункты, реальная зона нажатия (сетка elementFromPoint ±30 px); нет на главной — запасная страница;
    с какой ширины видно полное меню (full_menu_from_px); кадр шапки на 320 и 360;
  · альбомная 844×390; hover-only правила; моушн в CSS (transition: all, анимации размеров, ease-in, scale(0));
    риски Safari/iOS по коду CSS/JS/HTML (с версией iOS и тем, кого это отрезает);
  · навигация: top H1/H2 первого экрана по страницам, якоря на другие страницы (1 / 2,5 / 5 с; у конца
    страницы — page_end), белая вспышка.

Два режима --pages:
  · конвейер зовёт с --pages без --subset → фильтр основного файла с продолжением: меряются только эти
    страницы, результат в measure/mobile.json (замеры других страниц в нём сохраняются), код 75 — повтор
    той же команды продолжит;
  · перемер части страниц агентом — --pages <pid,…> --subset (флаг --subset последним): результат в отдельный
    measure/mobile.subset-<время>.json, основной файл не трогается.

Флаги:
  --run <папка>        папка прогона (обязательно)
  --pages a,b          только эти pid (см. «Два режима --pages»)
  --subset             записать в measure/mobile.subset-<время>.json, основной файл не трогать
  --widths 360,1366x657  только эти размеры (ширина или ширина×высота; всегда subset)
  --checks …           sizes,targets,burger,code,nav,landscape (всегда subset)
  --depth …            lite|standard|deep (по умолчанию из brief.json / state.json, иначе standard)
  --url <адрес>        если pages.json ещё нет: проверить одну страницу
  --allow-load-posts   разрешить POST-запросы самой страницы при загрузке (SPA); при касаниях — никогда
  --budget-sec N       стоп до таймаута (по умолчанию 480); частичный результат и код 75, повтор продолжит
                       (единица со сбоем повторяется один раз)
  --fresh              начать заново, не продолжать частичный прогон
  --lang ru|en         язык сводки и полей-пояснений
Пишет: measure/mobile.json, measure/mobile/*.jpg, stdout/mobile.md
  (subset — stdout/mobile.subset-<время>.md). Коды: 0 готово, 75 частично (бюджет или slot_wait — браузер занят), 2 аргументы, 1 сбой.
`;
const HELP_EN = `
mobile.mjs — mobile layout and compatibility (lens mobile; data for ux, a11y, color)

  node mobile.mjs --run "<RUN>" [flags]

What it does (read-only, no submits, no query params added):
  · widths 280–1920: overflow and its culprit (ancestor clipping respected), text clipped by an ancestor
    (clipped_content), main action in the first screen (844 and 664 px — visible part in iPhone Safari);
    overflow found on resize is confirmed by a fresh load; overflow during scrolling;
  · laptop windows 1280×689, 1366×657, 1536×745 (deep: +1440×789, 1920×969, 744, touch tablets 1024×1366 and
    1180×820): first-screen shot, main action in the window, small text and platform zoom/scale;
  · 390: touch targets (24 px — WCAG 2.5.8 AA, 44 px — Apple/2.5.5) with elementFromPoint hit-test at each centre
    (div/span with cursor: pointer included), small text (share of characters < 12/14/16 px), inputs < 16 px,
    sticky layers, full-screen splash (fullscreen_overlay: hidden, measured after it), videos, 100vh,
    page length in screens, tables wider than the screen, weight for weak phones (DOM nodes, JS heap);
  · burger: real touch of a toggle only (hitInfo before the tap; links to other addresses, tel:/mailto: and form
    buttons are skipped), shot, scroll lock, closing (Esc, outside, close button, toggle), items, real tap zone;
    no burger on home — a fallback page; width where the full menu appears (full_menu_from_px); header shots 320/360;
  · landscape 844×390; hover-only rules; motion in CSS; Safari/iOS risks in CSS/JS/HTML (iOS version, who is cut off);
  · navigation: H1/H2 top per page, cross-page anchors (1 / 2.5 / 5 s; near the page end — page_end), white flash.

Two --pages modes:
  · the pipeline passes --pages without --subset → a filter of the main file with resume: only these pages
    are measured, results go to measure/mobile.json (other pages' data is kept), exit 75 — rerun to continue;
  · an agent re-measuring some pages — --pages <pid,…> --subset (--subset last): results go to a separate
    measure/mobile.subset-<time>.json, the main file is not touched.

Flags:
  --run <dir>          run folder (required)
  --pages a,b          only these pids (see "Two --pages modes")
  --subset             write measure/mobile.subset-<time>.json, leave the main file alone
  --widths 360,1366x657  only these sizes (width or width×height; always a subset)
  --checks …           sizes,targets,burger,code,nav,landscape (always a subset)
  --depth …            lite|standard|deep (default from brief.json / state.json, else standard)
  --url <url>          no pages.json yet: check one page
  --allow-load-posts   let the page's own POSTs through during load (SPA); never during taps
  --budget-sec N       stop before the timeout (default 480); partial result and exit 75, a rerun continues
                       (a failed unit is retried once)
  --fresh              start over
  --lang ru|en         language of the summary and explanation fields
Writes: measure/mobile.json, measure/mobile/*.jpg, stdout/mobile.md
  (subset — stdout/mobile.subset-<time>.md). Exit: 0 done, 75 partial (budget or slot_wait — browser busy), 2 args, 1 failure.
`;

// ---------- sizes ----------
const TOUCH_SIZES = { 280: 653, 320: 568, 360: 800, 375: 667, 390: 844, 414: 896, 430: 932, 440: 956, 600: 960, 744: 1133, 768: 1024, 834: 1194 };
const DESKTOP_SIZES = [[1024, 768], [1280, 689], [1366, 657], [1536, 745], [1920, 1080]];
// touch tablets from 981 px: hover menus in the header must open by touch (deep only)
const TABLET_SIZES = [[1024, 1366], [1180, 820]];
const LAPTOP_WINDOWS = new Set(['1280x689', '1366x657', '1536x745', '1440x789', '1920x969']);
// visible area of the page in iPhone Safari with toolbars (screen 844 → ~664, Pro Max 932 → ~740)
const BROWSER_VISIBLE = { 390: 664, 430: 740 };
const CONFIRM_ORDER = [360, 375, 320, 414, 390, 430, 440, 280, 600, 744, 768, 834, 1024, 1280, 1366, 1536, 1920];
const HEADER_SHOT_WIDTHS = new Set([320, 360]);

function plan(depth) {
  let touch = [280, 320, 360, 375, 414, 430, 440, 600, 768, 834];
  let desk = DESKTOP_SIZES.slice();
  let tablet = [];
  if (depth === 'lite') { touch = [320, 360, 375, 414, 768]; desk = [[1280, 689], [1366, 657], [1536, 745]]; }
  if (depth === 'deep') { touch = [...touch, 744].sort((a, b) => a - b); desk = [...desk, [1440, 789], [1920, 969]]; tablet = TABLET_SIZES.slice(); }
  return { touch, desk, tablet, landscapePages: depth === 'deep' ? 5 : depth === 'lite' ? 1 : 3, anchors: depth === 'deep' ? 5 : 3, flashes: depth === 'deep' ? 5 : 3,
    confirmMax: depth === 'lite' ? 2 : 3, burgerPerTemplate: depth === 'deep' };
}
// language of in-page explanation strings (set in main before any measurement)
let LANG = 'ru';

// ---------- messages ----------
const T = {
  ru: {
    title: 'mobile.mjs — мобильная вёрстка и совместимость', pages: 'Страниц', partial: 'ЧАСТИЧНО (бюджет времени) — повторите тот же вызов, продолжит', partialSubset: 'ЧАСТИЧНО (бюджет времени) — subset не продолжается: уменьшите --pages или увеличьте --budget-sec', partialSlot: 'ЧАСТИЧНО — браузер занят другими проверками (slot_wait), повторите тот же вызов',
    overflow: 'Переполнение по ширине', none: 'нет', confirmed: 'подтв. загрузкой', resizeOnly: 'только при смене ширины', unconfirmed: 'не перепроверяли',
    fold390: 'Кнопка действия в первом экране 390', foldLaptop: 'Кнопка действия в окне ноутбука', missing: 'нет на страницах',
    targets: 'Цели касания 390', fail24: 'мельче 24 × 24, и круг 24 px вокруг центра задевает соседние цели или их круги (2.5.8)', below44: 'меньше 44 px',
    blocked: 'перекрыты (hit-test)', invisible: 'из них невидимым слоем', iosPe: 'внутри контейнера с pointer-events:none (риск iPhone)',
    text: 'Мелкий текст 390 (доля знаков, макс. по страницам)', inputs: 'Поля < 16 px (iOS увеличит страницу при фокусе)',
    sticky: 'Липкие слои: макс. доля экрана', landscape: 'в альбомной',
    burger: 'Бургер', notFound: 'не найден', opens: 'открывается', notOpens: 'НЕ открывается', lock: 'фон заблокирован', noLock: 'фон прокручивается',
    closes: 'закрывается', items: 'пунктов', hover: 'Правила :hover без @media (hover: hover)', reveal: 'показ контента', stick: 'залипающий transform',
    vh: 'Правил с 100vh', video: 'Видео с риском на iPhone', safari: 'Риски Safari/iOS по коду', nav: 'Навигация',
    spread: 'разброс top заголовка', anchors: 'якоря на другие страницы', flash: 'белая вспышка', shots: 'Кадры', errors: 'Ошибки',
    written: 'Записано', notChecked: 'Не проверено', viewport: 'meta viewport',
    below: 'ниже первого экрана:', noCta: 'кнопки действия нет в первых 3 экранах', lostVs1440: 'видна на 1440×900, но не в окне', rescale: 'текст мельчает (масштаб платформы)',
    tables: 'Таблицы шире экрана 390', clipped: 'обрезана', pageOverflow: 'вылезает за экран', heavy: 'Тяжёлая страница (узлов DOM > 1 500)', motion: 'Моушн в CSS',
    layoutAnim: 'анимаций размеров/положения', longUi: 'долгих (> 0,5 с) переходов UI', thirdParty: 'сторонний', guarded: 'с проверкой',
    foldBrowser: 'выше 844, но ниже 664 px (видимая часть Safari):', scrollOverflow: 'Переполнение во время прокрутки (анимации)', atY: 'на прокрутке',
    clippedContent: 'Текст обрезан предком (overflow: hidden/clip)', overlayFs: 'Полноэкранная заставка (скрыта, замеры после неё)',
    burgerLink: 'кандидат оказался ссылкой — не нажимали', burgerSkipped: 'пропущено кандидатов-ссылок', fullMenu: 'полное меню с', fallback: 'на странице',
    tablets: 'Планшеты с тачем', submenuTap: 'подменю в шапке', opensTap: 'открывается касанием', notOpensTap: 'НЕ открывается касанием', linkParent: 'пункт-ссылка, касание не проверяли',
    pageEnd: 'у конца страницы (page_end, не ошибка)', retried: 'повторено после сбоя', mutedProp: 'muted только свойством (нет атрибута)', noPlaysinline: 'без playsinline',
  },
  en: {
    title: 'mobile.mjs — mobile layout and compatibility', pages: 'Pages', partial: 'PARTIAL (time budget) — rerun the same command to continue', partialSubset: 'PARTIAL (time budget) — a subset does not resume: pass fewer --pages or a larger --budget-sec', partialSlot: 'PARTIAL — browser busy with other checks (slot_wait), rerun the same command',
    overflow: 'Horizontal overflow', none: 'none', confirmed: 'confirmed by reload', resizeOnly: 'on resize only', unconfirmed: 'not re-checked',
    fold390: 'Main action in first screen @390', foldLaptop: 'Main action in laptop window', missing: 'missing on',
    targets: 'Touch targets @390', fail24: 'smaller than 24 × 24 with a 24 px circle around the centre touching other targets or their circles (2.5.8)', below44: 'below 44 px',
    blocked: 'covered (hit-test)', invisible: 'by an invisible layer', iosPe: 'inside pointer-events:none container (iPhone risk)',
    text: 'Small text @390 (share of characters, max over pages)', inputs: 'Inputs < 16 px (iOS zooms on focus)',
    sticky: 'Sticky layers: max share of screen', landscape: 'landscape',
    burger: 'Burger', notFound: 'not found', opens: 'opens', notOpens: 'does NOT open', lock: 'background locked', noLock: 'background scrolls',
    closes: 'closes by', items: 'items', hover: ':hover rules without @media (hover: hover)', reveal: 'content reveal', stick: 'sticky transform',
    vh: 'Rules with 100vh', video: 'Videos risky on iPhone', safari: 'Safari/iOS risks in code', nav: 'Navigation',
    spread: 'heading top spread', anchors: 'cross-page anchors', flash: 'white flash', shots: 'Shots', errors: 'Errors',
    written: 'Written', notChecked: 'Not checked', viewport: 'meta viewport',
    below: 'below the first screen:', noCta: 'no action button in the first 3 screens', lostVs1440: 'visible at 1440×900 but not in the window', rescale: 'text shrinks (platform rescale)',
    tables: 'Tables wider than 390', clipped: 'clipped', pageOverflow: 'overflows the page', heavy: 'Heavy page (DOM nodes > 1,500)', motion: 'Motion in CSS',
    layoutAnim: 'size/position animations', longUi: 'long (> 0.5 s) UI transitions', thirdParty: 'third-party', guarded: 'guarded',
    foldBrowser: 'above 844 but below 664 px (Safari visible area):', scrollOverflow: 'Overflow during scrolling (animations)', atY: 'at scroll',
    clippedContent: 'Text clipped by an ancestor (overflow: hidden/clip)', overlayFs: 'Full-screen splash (hidden, measured after it)',
    burgerLink: 'candidate is a link — not tapped', burgerSkipped: 'link candidates skipped', fullMenu: 'full menu from', fallback: 'on page',
    tablets: 'Touch tablets', submenuTap: 'header submenu', opensTap: 'opens by touch', notOpensTap: 'does NOT open by touch', linkParent: 'parent is a link, tap not tested',
    pageEnd: 'near the page end (page_end, not an error)', retried: 'retried after a failure', mutedProp: 'muted by property only (no attribute)', noPlaysinline: 'no playsinline',
  },
};

// ---------- Safari / iOS risks found in code ----------
// min = first iOS/Safari version with support (caniuse). iPhone 6s/7 stay on iOS 15, iPhone 8/X on iOS 16, iPhone XS/XR on iOS 18.
// kind 'html' rules are counted from the DOM (meta of each page), not from files.
const SAFARI_RULES = [
  { id: 'css-aspect-ratio', kind: 'css', re: /(^|[;{\s])aspect-ratio\s*:/g, min: '15.0', ru: 'aspect-ratio — на iOS 14 блок без высоты (картинки и видео схлопываются)', en: 'aspect-ratio (iOS 14: boxes collapse)' },
  { id: 'css-has', kind: 'css', re: /:has\(/g, min: '15.4', ru: ':has() — селектор по содержимому', en: ':has() selector', guard: /@supports[^{]*selector\(\s*:has/ },
  { id: 'css-dvh', kind: 'css', special: 'dvh', min: '15.4', ru: 'единицы dvh/svh/lvh — без запасного vh высота блока пропадёт', en: 'dvh/svh/lvh units (no vh fallback → no height)' },
  { id: 'css-overscroll', kind: 'css', re: /overscroll-behavior(-x|-y|-inline|-block)?\s*:/g, min: '16.0', ru: 'overscroll-behavior — на iOS 15 фон под открытым меню и попапом прокручивается', en: 'overscroll-behavior (iOS 15: page behind menus scrolls)' },
  { id: 'css-light-dark', kind: 'css', re: /light-dark\(/g, min: '17.5', ru: 'light-dark() — цвет не применится, свойство пропадёт целиком', en: 'light-dark() (the whole declaration is dropped)', guard: /@supports[^{]*light-dark/ },
  { id: 'css-layer', kind: 'css', re: /@layer\b/g, min: '15.4', ru: '@layer — на старых iOS стили внутри слоя не применяются', en: '@layer cascade layers' },
  { id: 'css-oklch', kind: 'css', re: /\b(oklch|oklab)\(/g, min: '15.4', ru: 'цвета oklch()/oklab()', en: 'oklch()/oklab() colors' },
  { id: 'css-mask-noprefix', kind: 'css', special: 'mask', min: '15.4', ru: 'mask без -webkit-mask', en: 'mask without -webkit-mask' },
  { id: 'css-container', kind: 'css', re: /@container\b/g, min: '16.0', ru: '@container — контейнерные запросы', en: '@container queries' },
  { id: 'css-overflow-clip', kind: 'css', re: /overflow(-x|-y)?\s*:\s*clip\b/g, min: '16.0', ru: 'overflow: clip', en: 'overflow: clip' },
  { id: 'css-subgrid', kind: 'css', re: /\bsubgrid\b/g, min: '16.0', ru: 'subgrid', en: 'subgrid' },
  { id: 'css-color-mix', kind: 'css', re: /color-mix\(/g, min: '16.2', ru: 'color-mix() — цвет не применится', en: 'color-mix()', guard: /@supports[^{]*color-mix/ },
  { id: 'css-property', kind: 'css', re: /@property\b/g, min: '16.4', ru: '@property', en: '@property' },
  { id: 'css-nesting', kind: 'css', re: /[{;]\s*&[\s.:#[>+~]/g, min: '16.5', ru: 'вложенные правила CSS (&) — на старых iOS правило пропадает', en: 'native CSS nesting (&)' },
  { id: 'css-text-wrap', kind: 'css', re: /text-wrap(-style)?\s*:\s*(balance|pretty)/g, min: '17.5', ru: 'text-wrap: balance/pretty (без вреда, просто не сработает)', en: 'text-wrap: balance/pretty (harmless)', harmless: true },
  { id: 'css-starting-style', kind: 'css', re: /@starting-style\b/g, min: '17.5', ru: '@starting-style (анимация появления не сыграет)', en: '@starting-style', harmless: true },
  { id: 'css-backdrop-noprefix', kind: 'css', special: 'backdrop', min: '18.0', ru: 'backdrop-filter без -webkit-backdrop-filter: на iOS до 18 размытия нет, текст на прозрачной плашке может не читаться', en: 'backdrop-filter without -webkit- prefix' },
  { id: 'css-scroll-timeline', kind: 'css', re: /\b(animation-timeline|scroll-timeline(-name)?|view-timeline(-name)?)\s*:/g, min: '26', ru: 'анимации по прокрутке (animation-timeline): блок, который стартует невидимым, на iPhone до iOS 26 не появится', en: 'scroll-driven animations', guard: /@supports[^{]*(animation-timeline|scroll-timeline)/ },
  { id: 'css-anchor', kind: 'css', re: /\b(anchor-name|position-anchor)\s*:|[\s(]anchor\(/g, min: '26', ru: 'якорное позиционирование CSS (anchor-name)', en: 'CSS anchor positioning' },
  { id: 'css-bg-fixed', kind: 'css', re: /background(-attachment)?\s*:(?:url\([^)]*\)|[^;{}])*?\bfixed\b/g, min: null, ru: 'background-attachment: fixed — на iPhone не работает (фон прокручивается или растягивается)', en: 'background-attachment: fixed (ignored on iOS)' },
  { id: 'css-zoom', kind: 'css', re: /(^|[;{\s])zoom\s*:\s*(?!1\s*[;}!]|normal|100%|reset|unset|initial)[\d.]+%?/g, min: null, ru: 'свойство zoom — Safari и Chrome считают его по-разному', en: 'zoom property (Safari and Chrome differ)' },
  { id: 'js-showmodal', kind: 'js', re: /\.showModal\(/g, min: '15.4', ru: 'dialog.showModal() — окно не откроется', en: 'dialog.showModal()' },
  { id: 'js-inert', kind: 'js', re: /\.inert\s*=|setAttribute\(\s*["']inert["']/g, min: '15.5', ru: 'inert из скрипта — фон под окном останется нажимаемым', en: 'inert set from script' },
  { id: 'js-structuredclone', kind: 'js', re: /\bstructuredClone\(/g, min: '15.4', ru: 'structuredClone()', en: 'structuredClone()', guardName: 'structuredClone' },
  { id: 'js-at', kind: 'js', re: /\.at\(-\d+\)/g, min: '15.4', ru: '.at(-N) у массивов и строк', en: 'Array/String .at()' },
  { id: 'js-hasown', kind: 'js', re: /\bObject\.hasOwn\(/g, min: '15.4', ru: 'Object.hasOwn()', en: 'Object.hasOwn()' },
  { id: 'js-findlast', kind: 'js', re: /\.findLast(Index)?\(/g, min: '15.4', ru: 'findLast()', en: 'findLast()' },
  { id: 'js-broadcast', kind: 'js', re: /new BroadcastChannel\(/g, min: '15.4', ru: 'BroadcastChannel', en: 'BroadcastChannel' },
  { id: 'js-tosorted', kind: 'js', re: /\.(toSorted|toReversed|toSpliced)\(/g, min: '16.0', ru: 'toSorted()/toReversed()', en: 'toSorted()/toReversed()' },
  { id: 'js-abort-timeout', kind: 'js', re: /AbortSignal\.timeout\(/g, min: '16.0', ru: 'AbortSignal.timeout()', en: 'AbortSignal.timeout()' },
  { id: 'js-popover', kind: 'js', re: /\.(showPopover|togglePopover|hidePopover)\(/g, min: '17.0', ru: 'Popover API — меню/подсказки не откроются', en: 'Popover API' },
  { id: 'js-groupby', kind: 'js', re: /\b(Object|Map)\.groupBy\(/g, min: '17.4', ru: 'Object.groupBy()', en: 'Object.groupBy()' },
  { id: 'js-with-resolvers', kind: 'js', re: /Promise\.withResolvers\(/g, min: '17.4', ru: 'Promise.withResolvers()', en: 'Promise.withResolvers()' },
  { id: 'js-view-transition', kind: 'js', re: /startViewTransition\(/g, min: '18.0', ru: 'View Transitions (startViewTransition)', en: 'View Transitions', guardName: 'startViewTransition' },
  { id: 'js-ric', kind: 'js', re: /\brequestIdleCallback\(/g, min: null, ru: 'requestIdleCallback() — в Safari его долго не было; без запасного пути скрипт падает', en: 'requestIdleCallback() (long missing in Safari)', guardName: 'requestIdleCallback' },
  { id: 'js-connection', kind: 'js', re: /navigator\.connection\b/g, min: null, ru: 'navigator.connection — в Safari нет: правило «медленная сеть → без видео» на iPhone не сработает', en: 'navigator.connection (absent in Safari)' },
  { id: 'js-vibrate', kind: 'js', re: /navigator\.vibrate\(/g, min: null, ru: 'navigator.vibrate() — на iPhone нет', en: 'navigator.vibrate() (absent on iPhone)', harmless: true },
  { id: 'js-install-prompt', kind: 'js', re: /beforeinstallprompt/g, min: null, ru: 'кнопка «Установить приложение» через beforeinstallprompt — на iPhone не появится', en: 'beforeinstallprompt install button (never fires on iPhone)', harmless: true },
  { id: 'js-ios-branch', kind: 'js', re: /iP(hone|ad|od)/g, min: null, ru: 'в коде есть ветки для iPhone/iPad: на iPhone поведение отличается от снятого в Chromium', en: 'iOS-specific code branches', info: true },
  { id: 'html-dialog', kind: 'html', meta: 'dialog', min: '15.4', ru: 'элемент <dialog> — на старых iOS окно видно сразу или не открывается', en: '<dialog> element' },
  { id: 'html-inert', kind: 'html', meta: 'inert', min: '15.5', ru: 'атрибут inert — фон под окном останется нажимаемым и читаемым', en: 'inert attribute' },
  { id: 'html-popover', kind: 'html', meta: 'popover', min: '17.0', ru: 'атрибут popover — меню/подсказки видны сразу или не открываются', en: 'popover attribute' },
];

function riskLevel(min) {
  if (!min) return 'check';
  const v = parseFloat(min);
  return v >= 26 ? 'high' : v >= 16 ? 'medium' : 'low';
}
// who is cut off: devices stuck on an older iOS plus everyone who has not updated to `min`
function excludedDevices(min, lang) {
  if (!min) return null;
  const v = parseFloat(min); const en = lang === 'en';
  if (v >= 26) return en ? 'iPhone XS/XR and older (stuck on iOS 18) and anyone not on iOS 26' : 'iPhone XS/XR и старше (остались на iOS 18) и все, кто не обновился до iOS 26';
  if (v >= 18) return en ? `iPhone 8/X and older (stuck on iOS 16) and anyone still on iOS 17 or below ${min}` : `iPhone 8/X и старше (остались на iOS 16) и все, кто остался на iOS 17 или ниже ${min}`;
  if (v >= 17) return en ? `iPhone 8/X and older (stuck on iOS 16) and anyone on iOS below ${min}` : `iPhone 8/X и старше (остались на iOS 16) и все на iOS ниже ${min}`;
  if (v >= 16) return en ? `iPhone 6s/7/SE 1st gen (stuck on iOS 15) and anyone on iOS below ${min}` : `iPhone 6s/7/SE 1-го поколения (остались на iOS 15) и все на iOS ниже ${min}`;
  return en ? `iOS below ${min}` : `iOS ниже ${min}`;
}
// cut a line for stdout at a word boundary
function cut(s, n) { s = String(s || ''); if (s.length <= n) return s; const k = s.lastIndexOf(' ', n - 1); return s.slice(0, k > n * 0.6 ? k : n - 1).replace(/[\s,;:—–-]+$/, '') + '…'; }

function stripComments(s) { return s.replace(/\/\*[\s\S]*?\*\//g, ' '); }
function blocksOf(css) { // rough rule bodies: text between "{" and the next "}"
  const out = []; let i = 0;
  while (i < css.length) { const a = css.indexOf('{', i); if (a < 0) break; const b = css.indexOf('}', a); if (b < 0) break; out.push(css.slice(a + 1, b)); i = b + 1; }
  return out;
}
function sampleAround(text, idx, n = 90) {
  return text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + n - 40)).replace(/\s+/g, ' ').trim();
}
function jsGuarded(text, name) {
  if (!name) return false;
  const re = new RegExp(`typeof\\s+(window\\.|self\\.|globalThis\\.)?${name}\\b|["']${name}["']\\s*in\\b|(window|self|globalThis)\\.${name}\\s*(\\?|&&|\\|\\||\\)\\s*\\?)`);
  return re.test(text);
}
function scanCode(kind, text) {
  const hits = {};
  const src = kind === 'css' ? stripComments(text) : text;
  for (const r of SAFARI_RULES) {
    if (r.kind !== kind) continue;
    let count = 0, sample = null, unguarded = 0;
    if (r.special === 'dvh') { // guarded when the same rule body also has a plain vh fallback
      for (const b of blocksOf(src)) {
        if (!/\d(dvh|svh|lvh|dvw|svw|lvw|dvmin|dvmax|svmin|svmax|lvmin|lvmax)\b/.test(b)) continue;
        count++; if (!/\d(vh)\b/.test(b)) unguarded++; if (!sample) sample = b.replace(/\s+/g, ' ').trim().slice(0, 90);
      }
      if (count) hits[r.id] = { count, sample, guarded: unguarded === 0 };
      continue;
    }
    if (r.special === 'backdrop' || r.special === 'mask') {
      const has = r.special === 'backdrop' ? /(^|[^-\w])backdrop-filter\s*:/ : /(^|[;{\s])mask(-image)?\s*:/;
      const pref = r.special === 'backdrop' ? /-webkit-backdrop-filter\s*:/ : /-webkit-mask(-image)?\s*:/;
      for (const b of blocksOf(src)) if (has.test(b) && !pref.test(b)) { count++; if (!sample) sample = b.replace(/\s+/g, ' ').trim().slice(0, 90); }
    } else {
      r.re.lastIndex = 0; let m;
      while ((m = r.re.exec(src))) { count++; if (!sample) sample = sampleAround(src, m.index); if (count > 500) break; }
    }
    if (count) hits[r.id] = { count, sample, guarded: !!(r.guard && r.guard.test(src)) || jsGuarded(src, r.guardName) };
  }
  if (kind === 'css') {
    hits._text_size_adjust = /text-size-adjust\s*:/.test(src);
    hits._safe_area = /env\(\s*safe-area-inset/.test(src);
  }
  return hits;
}

// ---------- in-page helpers (serialized into the page; must be self-contained) ----------
function PAGE_HELPERS() {
  if (window.__rvm) return;
  const H = {};
  const EN = window.__rvLang === 'en';
  const cs = el => getComputedStyle(el);
  const TSEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=button], [role=link], [role=tab], [role=checkbox], [role=radio], [role=switch], [role=menuitem], [role=option], [onclick], label[for], [tabindex]:not([tabindex="-1"])';
  H.TSEL = TSEL;
  H.sel = (el) => {
    if (!el || el.nodeType !== 1) return '';
    const parts = []; let cur = el;
    for (let d = 0; cur && cur.nodeType === 1 && d < 4; d++) {
      if (cur.id && /^[A-Za-z][\w-]{0,40}$/.test(cur.id) && document.querySelectorAll('#' + CSS.escape(cur.id)).length === 1) { parts.unshift('#' + cur.id); break; }
      let s = cur.tagName.toLowerCase();
      const cn = typeof cur.className === 'string' ? cur.className : '';
      const cls = cn.split(/\s+/).filter(c => c && c.length < 40 && !/^(js-|is-|has-)/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map(c => CSS.escape(c)).join('.');
      const par = cur.parentElement;
      if (par) { const same = [...par.children].filter(x => x.tagName === cur.tagName); if (same.length > 1) s += `:nth-of-type(${same.indexOf(cur) + 1})`; }
      parts.unshift(s);
      if (cur.tagName === 'BODY') break;
      cur = par;
    }
    return parts.join(' > ').slice(0, 200);
  };
  H.txt = (el, n = 60) => String(el.innerText || el.value || (el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('alt'))) || '').replace(/\s+/g, ' ').trim().slice(0, n);
  H.box = r => [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)];
  H.alpha = c => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return 1; const p = m[1].split(/[\s,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  H.effOpacity = el => { let o = 1; for (let a = el; a && a.nodeType === 1; a = a.parentElement) { o *= parseFloat(cs(a).opacity); if (!(o >= 0.02)) return 0; } return o; };
  H.shown = el => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    return H.effOpacity(el) >= 0.05;
  };
  H.fixedChain = el => { for (let a = el; a && a.nodeType === 1; a = a.parentElement) { const p = cs(a).position; if (p === 'fixed' || p === 'sticky') return p; } return null; };
  H.peNoneAncestor = el => { for (let a = el.parentElement; a && a.nodeType === 1 && a !== document.documentElement; a = a.parentElement) if (cs(a).pointerEvents === 'none') return H.sel(a); return null; };
  H.describe = el => {
    if (!el || el.nodeType !== 1) return null;
    const s = cs(el); const op = H.effOpacity(el); const text = H.txt(el, 40);
    const media = el.querySelector && el.querySelector('img, svg, video, canvas, picture, iframe');
    const borderless = !parseFloat(s.borderTopWidth) && !parseFloat(s.borderLeftWidth) && !parseFloat(s.borderBottomWidth);
    const invisible = op < 0.05 || (H.alpha(s.backgroundColor) < 0.02 && s.backgroundImage === 'none' && !text && !media && borderless && s.boxShadow === 'none'
      && !/^(IMG|SVG|VIDEO|CANVAS|IFRAME|INPUT|TEXTAREA|SELECT|PICTURE)$/i.test(el.tagName));
    return { sel: H.sel(el), tag: el.tagName.toLowerCase(), text, opacity: Math.round(op * 100) / 100, bg: s.backgroundColor, bg_image: s.backgroundImage !== 'none',
      pe: s.pointerEvents, position: s.position, z: s.zIndex, fixed: H.fixedChain(el), invisible, iframe: el.tagName === 'IFRAME' };
  };
  H.scrollTo = y => { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); return Math.round(scrollY); };
  H.raf = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  H.meta = () => {
    const m = document.querySelector('meta[name=viewport]'); const c = m ? m.getAttribute('content') || '' : null;
    return { viewport: c, device_width: !!c && /width\s*=\s*device-width/i.test(c), user_scalable_no: !!c && /user-scalable\s*=\s*(no|0)\b/i.test(c),
      max_scale: c ? ((c.match(/maximum-scale\s*=\s*([\d.]+)/i) || [])[1] || null) : null, fit_cover: !!c && /viewport-fit\s*=\s*cover/i.test(c),
      popover: document.querySelectorAll('[popover]').length, dialog: document.querySelectorAll('dialog').length, inert: document.querySelectorAll('[inert]').length,
      lang: document.documentElement.getAttribute('lang') || null };
  };
  H.firstHeading = () => {
    const vh = innerHeight;
    const hs = [...document.querySelectorAll('h1, h2')].filter(e => H.shown(e) && e.getBoundingClientRect().top + scrollY < vh);
    const h = hs.find(e => e.tagName === 'H1') || hs[0];
    if (!h) return null;
    const r = h.getBoundingClientRect();
    return { tag: h.tagName.toLowerCase(), text: H.txt(h, 60), top: Math.round(r.top + scrollY), left: Math.round(r.left), height: Math.round(r.height), font_size: parseFloat(cs(h).fontSize), sel: H.sel(h) };
  };
  // the button shape drawn by a pseudo-element or by a child (svg, span with background) under the label
  H.drawnShape = (el, r) => {
    for (const p of ['::before', '::after']) {
      const ps = getComputedStyle(el, p); if (!ps.content || ps.content === 'none') continue;
      if (H.alpha(ps.backgroundColor) > 0.3 || ps.backgroundImage !== 'none' || (parseFloat(ps.borderTopWidth) >= 1 && ps.borderTopStyle !== 'none')) return true;
    }
    const area = r.width * r.height; if (!area) return false;
    for (const k of el.querySelectorAll(':scope > *, :scope > * > *')) {
      const kr = k.getBoundingClientRect(); if (kr.width * kr.height < area * 0.6) continue;
      const ks = cs(k);
      if (/^(svg|img|canvas)$/i.test(k.tagName) || H.alpha(ks.backgroundColor) > 0.3 || ks.backgroundImage !== 'none' || (parseFloat(ks.borderTopWidth) >= 1 && ks.borderTopStyle !== 'none')) return true;
    }
    return false;
  };
  const CTA_RE = /(запис|купить|куплю|заказ|оформ|заявк|позвон|звонок|связат|напиш|получить|попроб|начать|брон|рассчит|подобр|узнать (цен|стоим)|консультац|в корзину|оплат|подписат|скачать|регистр|sign ?up|get started|buy|order|book|contact|call|try|subscribe|request|demo|download|register|join|apply|quote|start)/i;
  H.fold = (mainAction) => {
    const vh = innerHeight, vw = innerWidth;
    const main = String(mainAction || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4).map(w => w.slice(0, 6));
    const cands = [];
    for (const el of document.querySelectorAll('a[href], button, [role=button], input[type=submit], input[type=button]')) {
      if (el.closest('[data-rv-ov], [data-rv-hidden]') || !H.shown(el)) continue;
      const r = el.getBoundingClientRect(); if (r.top + scrollY > vh * 3) continue;
      const t = H.txt(el, 60); const tl = t.toLowerCase(); const href = el.getAttribute('href') || '';
      if (/^(принять|принимаю|согласен|ок|ok|понятно|хорошо|accept|agree|got it|закрыть|close|×|✕|меню|menu)$/i.test(t)) continue;
      let score = 0;
      if (CTA_RE.test(t)) score += 5;
      if (main.length && main.some(w => tl.includes(w))) score += 6;
      if (/^(tel:|mailto:|https?:\/\/(wa\.me|t\.me|api\.whatsapp|vk\.me))/i.test(href)) score += 4;
      // looks like a button: filled, or outlined (border, picture or shadow) with padding
      const s = cs(el); const ps = el.parentElement ? cs(el.parentElement) : null;
      const filled = H.alpha(s.backgroundColor) > 0.3 && (!ps || s.backgroundColor !== ps.backgroundColor);
      const outlined = (parseFloat(s.borderTopWidth) >= 1 && s.borderTopStyle !== 'none' && parseFloat(s.borderBottomWidth) >= 1) || s.backgroundImage !== 'none' || (s.boxShadow && s.boxShadow !== 'none')
        || H.drawnShape(el, r);
      const padded = parseFloat(s.paddingLeft) >= 8 && r.height >= 28 && /block|flex|grid|table/.test(s.display);
      if (filled || (outlined && padded)) score += 2;
      if (padded) score += 1;
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') score += 1;
      const chrome = el.closest('header, nav, [role=navigation], [role=banner]');
      if (chrome && !CTA_RE.test(t)) score -= 3;
      if (!chrome && r.top >= 0 && r.top < vh) score += 1; // buttons of the first screen's content (hero)
      if (el.closest('footer')) score -= 5;
      if (t.length > 50 || t.length < 2) score -= 2;
      if (score < 4) continue;
      cands.push({ el, r, t, score });
    }
    cands.sort((a, b) => b.score - a.score || a.r.top - b.r.top);
    const desc = c => {
      if (!c) return null;
      const r = c.el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      let covered = null;
      if (cy >= 0 && cy <= vh && cx >= 0 && cx <= vw) { const hit = document.elementFromPoint(cx, cy); if (hit && !H.hitOk(c.el, hit)) covered = H.describe(hit); }
      return { text: c.t, sel: H.sel(c.el), score: c.score, box: H.box(r), top: Math.round(r.top), bottom: Math.round(r.bottom), in_fold: r.top >= 0 && r.bottom <= vh, partly: r.top < vh && r.bottom > vh, covered_by: covered };
    };
    const inFold = cands.filter(c => c.r.top >= 0 && c.r.bottom <= vh);
    const h1 = [...document.querySelectorAll('h1')].find(H.shown);
    let h1d = null;
    if (h1) { const r = h1.getBoundingClientRect(); const lh = parseFloat(cs(h1).lineHeight) || parseFloat(cs(h1).fontSize) * 1.2; h1d = { text: H.txt(h1, 60), box: H.box(r), top: Math.round(r.top), bottom: Math.round(r.bottom), in_fold: r.top < vh && r.bottom > 0, lines: Math.max(1, Math.round(r.height / lh)) }; }
    return { vw, vh, cta: desc(cands[0]), cta_in_fold: inFold.length > 0, in_fold: inFold.slice(0, 3).map(desc), h1: h1d };
  };
  H.overflow = (W) => {
    const de = document.documentElement; const body = document.body;
    const sw = Math.max(de.scrollWidth, body ? body.scrollWidth : 0); const iw = innerWidth;
    const px = Math.max(0, Math.max(sw, iw) - W);
    const rootClip = { html: /hidden|clip/.test(cs(de).overflowX), body: body ? /hidden|clip/.test(cs(body).overflowX) : false };
    const fits = r => r.right + scrollX <= W + 1 && r.left + scrollX >= -1;
    // a non-visible overflow box (or paint containment) that itself fits the screen hides what sticks out of it
    const clippedBy = (el, self) => {
      for (let a = self ? el : el.parentElement; a && a !== body && a !== de; a = a.parentElement) {
        const as = cs(a);
        if ((/(hidden|clip|auto|scroll)/.test(as.overflowX) || /paint|strict|content/.test(as.contain)) && fits(a.getBoundingClientRect())) return true;
      }
      return false;
    };
    // fixed layers do not add to the page's scroll width: kept apart, never named as the culprit
    const over = new Set(); const textOver = new Map(); const fixedWide = []; let offcanvas = 0;
    const all = body ? body.getElementsByTagName('*') : [];
    for (const el of all) {
      const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
      const L = r.left + scrollX, R = r.right + scrollX;
      if (R <= W + 1 && L >= -1) continue;
      const s = cs(el); if (s.visibility === 'hidden' || s.display === 'contents') continue;
      if (clippedBy(el, false)) continue;
      const fixed = H.fixedChain(el) === 'fixed';
      if ((L >= W - 1 || R <= 1) && (fixed || H.effOpacity(el) < 0.05 || s.visibility !== 'visible')) { offcanvas++; continue; }
      if (fixed) { if (fixedWide.length < 3 && !fixedWide.some(f => f.el.contains(el))) fixedWide.push({ el, r }); continue; }
      over.add(el);
    }
    // text wider than its own box (a long word in an H1 with width: 100%): the box fits, the glyphs do not
    let scanned = 0;
    for (const el of all) {
      if (++scanned > 8000) break;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|svg|SVG|OPTION|SELECT|TEXTAREA)$/.test(el.tagName)) continue;
      const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim());
      if (!own.length) continue;
      const inOver = over.has(el);
      const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || (!inOver && !fits(r))) continue;
      let right = -Infinity, left = Infinity;
      for (const n of own) {
        const rg = document.createRange(); rg.selectNodeContents(n); const tr = rg.getBoundingClientRect();
        if (tr.width < 1) continue; right = Math.max(right, tr.right + scrollX); left = Math.min(left, tr.left + scrollX);
      }
      if (right <= W + 1 && left >= -1) continue;
      if (inOver) { if (right > r.right + scrollX + 1 || left < r.left + scrollX - 1) textOver.set(el, { right: Math.round(right), left: Math.round(left) }); continue; }
      const s = cs(el); if (s.visibility !== 'visible' || H.effOpacity(el) < 0.05 || H.fixedChain(el) === 'fixed') continue;
      if (clippedBy(el, true)) continue;
      over.add(el); textOver.set(el, { right: Math.round(right), left: Math.round(left) });
    }
    const culprits = [];
    for (const el of over) {
      if (over.has(el.parentElement)) continue;
      const r = el.getBoundingClientRect(); const s = cs(el); const why = []; const tx = textOver.get(el);
      if (r.width > W + 1) why.push(`${EN ? 'wider than the screen' : 'шире экрана'}: ${Math.round(r.width)}px`);
      if (tx) why.push(`${EN ? 'text wider than its box' : 'текст шире блока'}: +${Math.max(tx.right - W, -tx.left)}px`);
      if (parseFloat(s.minWidth) > W) why.push(`min-width ${s.minWidth}`);
      if (/nowrap|pre/.test(s.whiteSpace)) why.push(`white-space: ${s.whiteSpace}`);
      if (s.transform && s.transform !== 'none') why.push('transform');
      if (parseFloat(s.marginLeft) < 0 || parseFloat(s.marginRight) < 0) why.push(EN ? 'negative margin' : 'отрицательный margin');
      if (/absolute|fixed/.test(s.position)) why.push(`position: ${s.position}`);
      if (/^(IMG|VIDEO|IFRAME|TABLE|PRE|SVG|CANVAS)$/i.test(el.tagName)) why.push(el.tagName.toLowerCase());
      if ([...el.childNodes].some(n => n.nodeType === 3 && /\S{28,}/.test(n.textContent))) why.push(EN ? 'long word or URL' : 'длинное слово или адрес');
      culprits.push({ sel: H.sel(el), tag: el.tagName.toLowerCase(), text: H.txt(el, 50), box: H.box(r), right: tx ? tx.right : Math.round(r.right + scrollX), left: tx ? tx.left : Math.round(r.left + scrollX), fixed: false, ...(tx ? { text_overflow: true } : {}), why });
      if (culprits.length >= 10) break;
    }
    culprits.sort((a, b) => (b.right - W) - (a.right - W));
    const fixed_wide = fixedWide.map(({ el, r }) => ({ sel: H.sel(el), tag: el.tagName.toLowerCase(), box: H.box(r), right: Math.round(r.right), min_width: cs(el).minWidth }));
    return { scroll_width: sw, inner_width: iw, px, root_clip: rootClip, count: over.size, offcanvas, culprits, fixed_wide };
  };
  // Text cut off on the right by a non-scrolling ancestor (overflow-x: hidden/clip): the reader never sees the end.
  // Skipped: marquees/carousels (transform, animation, slider classes, rows of same-size siblings), ellipsis/line-clamp,
  // aria-hidden duplicates, text that starts outside the box (off-screen slides).
  const SLIDER_RE = /(swiper|slick|carousel|slider|splide|glide|owl|marquee|ticker|track|scroller|flickity|embla|keen)/i;
  H.clipped = (W) => {
    const out = []; let count = 0; let scanned = 0;
    const body = document.body; if (!body) return { count: 0, items: [] };
    for (const el of body.getElementsByTagName('*')) {
      if (++scanned > 6000) break;
      if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|svg|OPTION|SELECT|TEXTAREA|INPUT)$/.test(el.tagName)) continue;
      const own = [...el.childNodes].filter(n => n.nodeType === 3 && n.textContent.trim().length >= 3);
      // tables have their own check (H.tables: scrolls / clipped)
      if (!own.length || !H.shown(el) || el.closest('[aria-hidden="true"], [data-rv-hidden], table')) continue;
      const s = cs(el); if (s.visibility !== 'visible' || /ellipsis/.test(s.textOverflow) || s.webkitLineClamp !== 'none' && s.webkitLineClamp) continue;
      const rg = document.createRange(); let tr = null;
      for (const n of own) { rg.selectNodeContents(n); const q = rg.getBoundingClientRect(); if (q.width < 1) continue; tr = tr ? { left: Math.min(tr.left, q.left), right: Math.max(tr.right, q.right), top: Math.min(tr.top, q.top), bottom: Math.max(tr.bottom, q.bottom) } : { left: q.left, right: q.right, top: q.top, bottom: q.bottom }; }
      if (!tr) continue;
      let clip = null, skip = false;
      for (let a = el; a && a !== body && a !== document.documentElement; a = a.parentElement) {
        const as = cs(a);
        if ((as.transform && as.transform !== 'none') || (as.animationName && as.animationName !== 'none') || SLIDER_RE.test(String(a.className && a.className.baseVal !== undefined ? a.className.baseVal : a.className) + ' ' + a.id)
          || /ellipsis/.test(as.textOverflow) || /snap/.test(as.scrollSnapType || '')) { skip = true; break; }
        if (a !== el && /(auto|scroll)/.test(as.overflowX)) break; // scrolls: the reader can swipe to the end
        if (a !== el && /(hidden|clip)/.test(as.overflowX)) { clip = a; break; }
      }
      if (skip || !clip) continue;
      const cr = clip.getBoundingClientRect();
      if (!(tr.right > cr.right + 8 && tr.left < cr.right - 8)) continue;
      const par = clip.parentElement;
      if (par) { const sib = [...par.children].filter(x => x.tagName === clip.tagName); if (sib.length >= 3 && sib.every(x => Math.abs(x.getBoundingClientRect().width - cr.width) < 2) && SLIDER_RE.test(String(par.className))) continue; }
      count++;
      if (out.length < 10) out.push({ sel: H.sel(el), text: H.txt(el, 60), clip_sel: H.sel(clip), clip_overflow: cs(clip).overflowX, hidden_px: Math.round(tr.right - cr.right), box: H.box(el.getBoundingClientRect()),
        clip_right: Math.round(cr.right + scrollX), beyond_screen: Math.round(Math.max(0, tr.right - W)) });
    }
    return { count, items: out };
  };
  H.scrollSample = async (step, pause, maxY, W) => {
    let max = 0, atY = null, culprits = null; const sticky = [];
    const h = () => Math.min(document.documentElement.scrollHeight, maxY);
    for (let y = 0; y < h(); y += step) {
      H.scrollTo(y); await new Promise(r => setTimeout(r, pause));
      const sw = Math.max(document.documentElement.scrollWidth, innerWidth);
      if (sw - W > max) { max = sw - W; atY = Math.round(scrollY); if (!culprits) culprits = H.overflow(W).culprits.slice(0, 3); }
    }
    H.scrollTo(0); await new Promise(r => setTimeout(r, 250));
    return { max_px: Math.max(0, max), at_y: atY, culprits };
  };
  // A fixed layer over ≥ 85 % of the screen that the centre of the screen hits, while the page content (h1/main or
  // ≥ 200 characters) lives outside it: splash screen, age gate, start screen, full-screen popup or cookie wall.
  // A whole page inside one fixed scroll container is not an overlay.
  H.isFullscreenOverlay = (el, r, vw, vh) => {
    if (cs(el).position !== 'fixed') return false;
    const w = Math.min(r.right, vw) - Math.max(r.left, 0), h = Math.min(r.bottom, vh) - Math.max(r.top, 0);
    if (w < vw * 0.85 || h < vh * 0.85) return false;
    const c = document.elementFromPoint(vw / 2, vh / 2); if (!c || !el.contains(c)) return false;
    if (String(el.innerText || '').length >= 1500) return false;
    if ([...document.querySelectorAll('h1, main, [role=main]')].some(x => !el.contains(x) && !x.contains(el))) return true;
    let outside = 0;
    for (const k of document.body.children) { if (k === el || k.contains(el) || el.contains(k) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(k.tagName)) continue; outside += String(k.textContent || '').trim().length; if (outside > 200) return true; }
    return false;
  };
  // hide=false only marks cookie banners and modal overlays (data-rv-ov) so the first-screen check can skip their buttons;
  // a full-screen overlay is hidden in both modes: under it nothing of the page can be measured
  H.hideOverlays = (hide = true) => {
    const vh = innerHeight, vw = innerWidth; const out = [];
    if (!document.getElementById('__rv_hide')) { const st = document.createElement('style'); st.id = '__rv_hide'; st.textContent = '[data-rv-hidden]{display:none!important}'; document.documentElement.appendChild(st); }
    const COOKIE = /(cookie|куки|кукис|gdpr|consent)/i; const PD = /персональн\S*\s+данн/i; const ACCEPT = /(принять|согласен|соглашаюсь|понятно|хорошо|accept|agree|got it|\bok\b|\bок\b)/i;
    for (const el of document.body.getElementsByTagName('*')) {
      const s = cs(el); if (s.position !== 'fixed' && s.position !== 'sticky') continue;
      if (el.parentElement && H.fixedChain(el.parentElement)) continue;
      if (!H.shown(el) || el.hasAttribute('data-rv-hidden')) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const t = String(el.innerText || '').slice(0, 1500);
      const btns = [...el.querySelectorAll('button, a, [role=button]')].map(b => H.txt(b, 30));
      let kind = null;
      const headerLike = r.top < 5 && r.height < 130 && !COOKIE.test(t);
      if (!headerLike && r.height < vh * 0.85 && t.length < 1500 && (COOKIE.test(t) || (PD.test(t) && btns.some(b => ACCEPT.test(b))))) kind = 'cookie';
      else if (H.isFullscreenOverlay(el, r, vw, vh)) kind = 'fullscreen_overlay';
      else if (area >= vw * vh * 0.5 && (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true' || /(modal|popup|overlay|lightbox)/i.test(String(el.className) + ' ' + el.id))) kind = 'modal';
      if (kind) {
        const hideIt = hide || kind === 'fullscreen_overlay';
        const rec = { kind, sel: H.sel(el), text: H.txt(el, 60), box: H.box(r), hidden: hideIt, buttons: kind === 'fullscreen_overlay' ? btns.filter(Boolean).slice(0, 4) : undefined };
        el.setAttribute(hideIt ? 'data-rv-hidden' : 'data-rv-ov', kind); // after reading the text: innerText of a hidden box glues words
        out.push(rec);
      }
    }
    return out;
  };
  H.sticky = () => {
    const vh = innerHeight, vw = innerWidth; const out = [];
    for (const el of document.body.getElementsByTagName('*')) {
      const s = cs(el); if (s.position !== 'fixed' && s.position !== 'sticky') continue;
      if (el.hasAttribute('data-rv-hidden')) continue;
      if (el.parentElement && H.fixedChain(el.parentElement)) continue;
      if (!H.shown(el)) continue;
      const r = el.getBoundingClientRect(); if (r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
      if (s.position === 'sticky') { const t = parseFloat(s.top), b = parseFloat(s.bottom); const stuck = (!isNaN(t) && Math.abs(r.top - t) < 2 && scrollY > 0) || (!isNaN(b) && Math.abs(vh - r.bottom - b) < 2); if (!stuck) continue; }
      const top = Math.max(0, r.top), bot = Math.min(vh, r.bottom), h = bot - top; if (h < 4) continue;
      let background = false, fullscreen = false;
      if (h >= vh * 0.85) { const c = document.elementFromPoint(vw / 2, vh / 2); background = !(c && el.contains(c)); fullscreen = !background && r.width >= vw * 0.85; }
      out.push({ sel: H.sel(el), position: s.position, top: Math.round(top), bottom: Math.round(bot), height: Math.round(h), width: Math.round(r.width), share: Math.round(1000 * h / vh) / 10,
        edge: r.top < 4 ? 'top' : (r.bottom > vh - 4 ? 'bottom' : 'middle'), z: s.zIndex, text: H.txt(el, 40), background, wide: r.width >= vw * 0.5,
        kind: fullscreen ? 'fullscreen_overlay' : undefined });
    }
    // full-screen layers (splash, page in a fixed container) are not "sticky bars": counted apart
    const bars = out.filter(x => !x.background && !x.kind);
    const iv = bars.filter(x => x.wide).map(x => [x.top, x.bottom]).sort((a, b) => a[0] - b[0]);
    let cov = 0, cur = null;
    for (const [a, b] of iv) { if (!cur || a > cur[1]) { if (cur) cov += cur[1] - cur[0]; cur = [a, b]; } else cur[1] = Math.max(cur[1], b); }
    if (cur) cov += cur[1] - cur[0];
    return { share: Math.round(1000 * cov / vh) / 10, wide: bars.filter(x => x.wide).length, floating: bars.filter(x => !x.wide).length, fullscreen: out.filter(x => x.kind).length, layers: out.slice(0, 12) };
  };
  // clickable div/span without a role (handlers via addEventListener): topmost element with cursor: pointer,
  // not inside and not around a regular target
  H.pointerTargets = (limit = 200) => {
    const out = []; let scanned = 0;
    for (const el of document.body.getElementsByTagName('*')) {
      if (++scanned > 8000 || out.length >= limit) break;
      if (/^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY|LABEL|svg|SVG|path|HTML|BODY|IMG)$/.test(el.tagName)) continue;
      if (cs(el).cursor !== 'pointer') continue;
      const p = el.parentElement; if (p && cs(p).cursor === 'pointer') continue; // cursor is inherited: keep the topmost
      if (el.closest(TSEL) || el.querySelector(TSEL)) continue;
      out.push(el);
    }
    return out;
  };
  H.collectTargets = () => {
    const vw = innerWidth; const els = [...document.querySelectorAll(TSEL)]; const set = new Set(els);
    const ptr = new Set(H.pointerTargets());
    for (const el of ptr) { els.push(el); set.add(el); }
    const out = []; window.__rvT = [];
    for (const el of els) {
      let p = el.parentElement, nested = false; while (p) { if (set.has(p)) { nested = true; break; } p = p.parentElement; }
      if (nested || !H.shown(el) || el.closest('[inert]') || el.hasAttribute('data-rv-hidden') || el.closest('[data-rv-hidden]')) continue;
      const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2; if (cx < 0 || cx > vw) continue;
      let inline = false;
      if (el.tagName === 'A' && cs(el).display === 'inline') { const blk = el.parentElement; const tl = blk ? String(blk.innerText || '').trim().length : 0; inline = tl > H.txt(el, 500).length + 15; }
      const i = window.__rvT.push(el) - 1;
      out.push({ i, tag: el.tagName.toLowerCase(), sel: H.sel(el), text: H.txt(el, 40), box: H.box(r), w: Math.round(r.width), h: Math.round(r.height), inline,
        fixed: H.fixedChain(el), pe_none_anc: H.peNoneAncestor(el), href: el.tagName === 'A' ? String(el.getAttribute('href') || '').slice(0, 120) : null,
        kind: ptr.has(el) ? 'pointer' : undefined });
      if (out.length >= 700) break;
    }
    return out;
  };
  H.hitOk = (el, hit) => !!(hit && (hit === el || el.contains(hit) || (hit.tagName === 'LABEL' && hit.control === el) || (el.tagName === 'LABEL' && el.control && (hit === el.control || el.control.contains(hit))) || (hit.closest && hit.closest('label') && hit.closest('label').control === el)));
  // centre of the element; a link wrapped over two lines is tested on its first line box
  H.center = el => { const rs = el.getClientRects(); const r = rs.length > 1 && cs(el).display === 'inline' ? rs[0] : el.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };
  H.hitTest = async (idxs) => {
    const vh = innerHeight, vw = innerWidth; const res = {};
    const check = el => { const [cx, cy] = H.center(el); if (cy < 0 || cy > vh || cx < 0 || cx > vw) return { off: true, cy }; const hit = document.elementFromPoint(cx, cy); return { ok: H.hitOk(el, hit), hit, cx, cy }; };
    const rec = (c) => c.off ? { ok: null, why: 'offscreen' } : c.ok ? { ok: true } : { ok: false, cover: H.describe(c.hit), at: [Math.round(c.cx), Math.round(c.cy)], scroll_y: Math.round(scrollY) };
    const items = idxs.map(i => ({ i, el: window.__rvT[i] })).filter(x => x.el && x.el.isConnected);
    const fixedOnes = items.filter(x => H.fixedChain(x.el) === 'fixed'); const flow = items.filter(x => H.fixedChain(x.el) !== 'fixed');
    H.scrollTo(0); await H.raf();
    for (const x of fixedOnes) res[x.i] = rec(check(x.el));
    const sorted = flow.map(x => { const r = x.el.getBoundingClientRect(); return { ...x, y: r.top + scrollY + r.height / 2 }; }).sort((a, b) => a.y - b.y);
    const band = Math.max(120, Math.floor(vh * 0.5));
    let k = 0;
    while (k < sorted.length) {
      const y0 = sorted[k].y; H.scrollTo(Math.max(0, y0 - vh * 0.25)); await H.raf();
      const lim = y0 + band;
      for (; k < sorted.length && sorted[k].y <= lim; k++) {
        const x = sorted[k]; let c = check(x.el);
        if (c.off) { H.scrollTo(Math.max(0, scrollY + c.cy - vh / 2)); await H.raf(); c = check(x.el); }
        if (!c.off && !c.ok && c.hit && H.fixedChain(c.hit)) { H.scrollTo(Math.max(0, scrollY + c.cy - vh * 0.5)); await H.raf(); const c2 = check(x.el); if (!c2.off) c = c2; }
        res[x.i] = rec(c);
      }
    }
    H.scrollTo(0);
    return res;
  };
  H.targetCenter = (i, ratio) => { const el = window.__rvT[i]; if (!el) return null; const r0 = el.getBoundingClientRect(); H.scrollTo(Math.max(0, r0.top + scrollY - innerHeight * (ratio || 0.4))); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, scroll_y: Math.round(scrollY), box: [r.left, r.top, r.width, r.height] }; };
  H.textSizes = () => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); const seen = new Map(); const by = { lt12: 0, lt14: 0, lt16: 0 }; let total = 0; const samples = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = n.textContent.replace(/\s+/g, ' ').trim(); if (!t) continue;
      const el = n.parentElement; if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|OPTION)$/.test(el.tagName)) continue;
      let fs = seen.get(el); if (fs === undefined) { fs = H.shown(el) ? parseFloat(cs(el).fontSize) * (el.currentCSSZoom || 1) : 0; seen.set(el, fs); } // CSS zoom shrinks the rendered size
      if (!fs) continue;
      const len = t.length; total += len;
      if (fs < 12) by.lt12 += len; if (fs < 14) by.lt14 += len; if (fs < 16) by.lt16 += len;
      if (fs < 12 && len >= 3) samples.push({ text: t.slice(0, 60), size: fs, sel: H.sel(el), box: H.box(el.getBoundingClientRect()), chars: len });
    }
    samples.sort((a, b) => b.chars - a.chars);
    const inputs = [...document.querySelectorAll('input, select, textarea')]
      .filter(e => !/^(hidden|checkbox|radio|submit|button|image|reset|range|color|file)$/i.test(e.type || '') && H.shown(e))
      .map(e => ({ sel: H.sel(e), type: e.type || e.tagName.toLowerCase(), size: parseFloat(cs(e).fontSize), name: String(e.name || e.placeholder || '').slice(0, 40), box: H.box(e.getBoundingClientRect()) }))
      .filter(x => x.size < 16);
    const sh = v => total ? Math.round(1000 * v / total) / 10 : 0;
    return { chars: total, lt12: sh(by.lt12), lt14: sh(by.lt14), lt16: sh(by.lt16), samples: samples.slice(0, 8), inputs_lt16: inputs.slice(0, 12), inputs_lt16_count: inputs.length };
  };
  H.videos = () => [...document.querySelectorAll('video')].slice(0, 30).map(v => ({
    sel: H.sel(v), src: String(v.currentSrc || v.getAttribute('src') || (v.querySelector('source') || {}).src || '').slice(0, 160),
    // iOS autoplays from markup only with the muted ATTRIBUTE; frameworks often set just the property
    autoplay: v.autoplay || v.hasAttribute('autoplay'), muted: v.muted || v.defaultMuted || v.hasAttribute('muted'), muted_attr: v.hasAttribute('muted'),
    playsinline: v.playsInline || v.hasAttribute('playsinline') || v.hasAttribute('webkit-playsinline'), loop: v.loop, controls: v.controls, poster: !!v.getAttribute('poster'),
    playing: !v.paused && !v.ended && v.readyState > 2, preload: v.preload, shown: H.shown(v), box: H.box(v.getBoundingClientRect()) }));
  H.length = () => ({ height: document.documentElement.scrollHeight, screens: Math.round(10 * document.documentElement.scrollHeight / innerHeight) / 10 });
  H.anchorsOut = () => {
    const strip = h => h.replace(/^www\./, ''); const here = location.origin + location.pathname + location.search; const out = []; const seen = new Set();
    for (const a of document.querySelectorAll('a[href*="#"]')) {
      let u; try { u = new URL(a.getAttribute('href'), location.href); } catch { continue; }
      if (!/^https?:$/.test(u.protocol) || !u.hash || u.hash.length < 2 || /^#[!/]/.test(u.hash)) continue;
      if (u.origin + u.pathname + u.search === here || strip(u.hostname) !== strip(location.hostname)) continue;
      if (seen.has(u.href)) continue; seen.add(u.href);
      out.push({ href: u.href, text: H.txt(a, 40), in_nav: !!a.closest('header, nav, footer, [role=navigation]') });
      if (out.length >= 15) break;
    }
    return out;
  };
  H.inlineScripts = () => [...document.scripts].filter(s => !s.src && (!s.type || /javascript|module/i.test(s.type))).map(s => s.textContent || '').filter(t => t.length > 20).slice(0, 40);
  // ---- burger ----
  const BURGER_RE = /(burger|hamburger|menu|nav-?toggle|navbar-toggler|toggle-?nav|offcanvas|drawer|меню|mobile-?nav|menu-?btn|menu-?icon|sandwich)/i;
  // never a menu toggle, whatever the class says (favourites, likes, show phone, votes, cart, login)
  const DENY_RE = /(избранн|нрав|лайк|like|favou?rite|wishlist|показать (номер|телефон)|голос|vote|корзин|cart|basket|купить|buy|заказ|order|войти|вход|login|log in|sign in|регистр|поиск|search)/i;
  // a link that leaves the document (not "#…"/javascript:) or opens a phone/mail app
  const leaves = a => { const h = String(a.getAttribute('href') || '').trim(); if (!h || /^(#|javascript:)/i.test(h)) return false; if (/^(tel|mailto|sms|callto|viber|whatsapp|tg):/i.test(h)) return true;
    try { const u = new URL(h, location.href); return !(u.origin === location.origin && u.pathname === location.pathname && u.search === location.search); } catch { return true; } };
  H.findBurger = () => {
    const vw = innerWidth; const cands = []; const seen = new Set();
    for (const el0 of document.querySelectorAll('button, [role=button], a, div, span, label, i, svg')) {
      const r = el0.getBoundingClientRect(); if (r.top > 220 || r.bottom < 0 || r.width < 12 || r.height < 12 || r.width > 130 || r.height > 130) continue;
      if (el0.closest('[data-rv-hidden]') || !H.shown(el0)) continue;
      const el = el0.closest('button, a, [role=button], label') || el0; if (seen.has(el)) continue;
      const cn = typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '';
      const attrs = [el.id, cn, el.getAttribute('aria-label') || '', el.getAttribute('title') || '', el.getAttribute('data-target') || '', el.getAttribute('data-toggle') || '', el.getAttribute('aria-controls') || ''].join(' ');
      let score = 0; const txt = String(el.innerText || '').trim();
      if (DENY_RE.test(`${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''} ${txt.slice(0, 40)}`)) continue;
      // a box holding a real link is a link, not a toggle: the tap would land on the link
      if (el.tagName === 'A' ? leaves(el) : [...el.querySelectorAll('a[href]')].some(leaves)) continue;
      if (el.closest('form')) continue;
      const kids = [...el.querySelectorAll('span, i, div')].filter(k => { const kr = k.getBoundingClientRect(); return kr.height > 0 && kr.height <= 6 && kr.width >= 10 && kr.width <= 60; });
      const bars = kids.length >= 2 && kids.length <= 4;
      const hasSvg = !!(el.querySelector('svg') || el.tagName.toLowerCase() === 'svg');
      const word = /^(меню|menu)$/i.test(txt);
      // div/span/i/svg: a class name alone is not enough — needs bars, aria state, the word "menu" or an icon
      const plain = !/^(BUTTON|A|LABEL)$/.test(el.tagName) && el.getAttribute('role') !== 'button';
      if (plain && !(bars || el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls') || word || hasSvg)) continue;
      // a labelled dropdown of the header ("Services", "Catalog ▾") is a submenu toggle, not the burger
      if (txt.length > 2 && !word && !BURGER_RE.test(`${attrs} ${txt}`) && !bars) continue;
      if (BURGER_RE.test(attrs)) score += 5;
      if (word) score += 4;
      if (el.hasAttribute('aria-expanded')) score += 3;
      if (el.hasAttribute('aria-controls')) score += 2;
      if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') score += 2;
      if (el.tagName === 'LABEL' && el.control && el.control.type === 'checkbox') score += 2;
      if (bars) score += 4;
      if (hasSvg) score += 1;
      if (r.left > vw / 2) score += 1;
      if (score >= 5) { seen.add(el); const rr = el.getBoundingClientRect(); cands.push({ el, score, area: rr.width * rr.height }); }
    }
    cands.sort((a, b) => b.score - a.score || a.area - b.area);
    window.__rvB = cands.map(c => c.el);
    return cands.slice(0, 3).map((c, k) => H.burgerInfo(k, c.score));
  };
  // burger present and how many header links are visible (for the width where the full menu appears)
  H.navState = () => {
    const vh = innerHeight, vw = innerWidth;
    const prev = window.__rvB; const b = H.findBurger(); window.__rvB = prev;
    // header_links: inside header/nav; top_links: any link in the top 160 px (builders put menus in plain divs)
    let links = 0, top = 0;
    for (const a of document.querySelectorAll('a[href]')) {
      if (a.closest('[data-rv-hidden]') || !H.shown(a)) continue;
      const r = a.getBoundingClientRect(); const cy = r.top + r.height / 2; const cx = r.left + r.width / 2;
      if (cy < 0 || cy > Math.min(160, vh) || cx < 0 || cx > vw || !H.txt(a, 30)) continue;
      top++; if (a.closest('header, nav, [role=navigation], [role=banner]')) links++;
    }
    return { burger: b.length > 0 && b[0].on_screen, burger_sel: b[0] ? b[0].sel : null, header_links: links, top_links: top };
  };
  // header items with a hidden submenu (≥ 2 links): toggle-like parents can be tapped, link parents only reported
  H.headerSubmenus = () => {
    const out = []; window.__rvSM = [];
    for (const li of document.querySelectorAll('header li, nav li, [role=navigation] li, [role=menubar] > *')) {
      const sub = [...li.children].find(k => k.querySelectorAll && k.querySelectorAll('a[href]').length >= 2 && !H.shown(k.querySelector('a[href]')));
      if (!sub) continue;
      const parent = [...li.children].find(k => k !== sub && (k.matches('a, button, [role=button], [role=menuitem], summary, span, div') && H.shown(k)));
      if (!parent) continue;
      const r = parent.getBoundingClientRect(); if (r.top > 220 || r.width < 8) continue;
      // only whitelisted toggles are tapped: button, summary, role=button, aria-expanded/aria-controls, "#…" links
      const isLink = parent.tagName === 'A' && parent.hasAttribute('href');
      const toggle = isLink ? !leaves(parent) : (/^(BUTTON|SUMMARY)$/.test(parent.tagName) || parent.getAttribute('role') === 'button' || parent.hasAttribute('aria-expanded') || parent.hasAttribute('aria-controls'));
      const i = window.__rvSM.push({ parent, sub }) - 1;
      out.push({ i, sel: H.sel(parent), text: H.txt(parent, 30), href: parent.getAttribute('href'), toggle, center: [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)] });
      if (out.length >= 8) break;
    }
    return out;
  };
  H.submenuShown = (i) => { const x = (window.__rvSM || [])[i]; if (!x) return null; return [...x.sub.querySelectorAll('a[href]')].filter(H.shown).length; };
  H.here = () => location.href;
  H.burgerInfo = (k, score) => {
    const el = window.__rvB && window.__rvB[k]; if (!el) return null;
    const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = (cy >= 0 && cy <= innerHeight) ? document.elementFromPoint(cx, cy) : null;
    return { k, score, sel: H.sel(el), tag: el.tagName.toLowerCase(), text: H.txt(el, 30), box: H.box(r), center: [Math.round(cx), Math.round(cy)], w: Math.round(r.width), h: Math.round(r.height),
      fixed: H.fixedChain(el), expanded: el.getAttribute('aria-expanded'), pe: cs(el).pointerEvents, pe_none_anc: H.peNoneAncestor(el),
      on_screen: cy >= 0 && cy <= innerHeight, hit_ok: hit ? H.hitOk(el, hit) : null, hit_cover: hit && !H.hitOk(el, hit) ? H.describe(hit) : null,
      sig: [String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className), el.getAttribute('aria-expanded'), el.getAttribute('aria-label'), el.innerHTML.length].join('|') };
  };
  H.visibleLinks = () => {
    const vh = innerHeight, vw = innerWidth; const out = []; window.__rvL = [];
    for (const el of document.querySelectorAll('a[href], button, [role=menuitem], [role=link]')) {
      if (el.closest('[data-rv-hidden]') || !H.shown(el)) continue;
      const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx < 0 || cx > vw || cy < 0 || cy > vh) continue;
      const i = window.__rvL.push(el) - 1;
      out.push({ i, key: String(el.getAttribute('href') || '') + '|' + H.txt(el, 40), text: H.txt(el, 40), href: el.getAttribute('href'), sel: H.sel(el), box: H.box(r), w: Math.round(r.width), h: Math.round(r.height), center: [Math.round(cx), Math.round(cy)] });
      if (out.length > 300) break;
    }
    return out;
  };
  H.checkLinks = (idxs) => idxs.map(i => {
    const el = window.__rvL[i]; if (!el) return { i, ok: null };
    const [cx, cy] = H.center(el);
    const hit = document.elementFromPoint(cx, cy); const ok = H.hitOk(el, hit);
    return { i, ok, cover: ok ? null : H.describe(hit), pe_none_anc: H.peNoneAncestor(el), pe: cs(el).pointerEvents };
  });
  H.panel = (idxs) => {
    const els = idxs.map(i => window.__rvL[i]).filter(Boolean); if (!els.length) return null;
    let p = els[0].parentElement;
    while (p && !els.every(e => p.contains(e))) p = p.parentElement;
    if (!p) return null;
    window.__rvP = p; const r = p.getBoundingClientRect(); const s = cs(p);
    return { sel: H.sel(p), box: H.box(r), position: s.position, overflow_y: s.overflowY, scroll_top: Math.round(p.scrollTop), scroll_height: p.scrollHeight, client_height: p.clientHeight,
      covers: Math.round(1000 * (Math.min(r.bottom, innerHeight) - Math.max(r.top, 0)) * (Math.min(r.right, innerWidth) - Math.max(r.left, 0)) / (innerWidth * innerHeight)) / 10 };
  };
  H.scrollerOf = () => { // the element that scrolls inside the menu panel (or the panel itself)
    const p = window.__rvP; if (!p) return { panel_scroll: 0 };
    let best = p, bestH = p.scrollHeight - p.clientHeight;
    for (const e of p.querySelectorAll('*')) { const d = e.scrollHeight - e.clientHeight; if (d > bestH && /(auto|scroll)/.test(cs(e).overflowY)) { best = e; bestH = d; } }
    window.__rvS = best; return { panel_scroll: Math.round(best.scrollTop), scrollable: bestH > 4 && /(auto|scroll)/.test(cs(best).overflowY) };
  };
  H.panelScroll = () => Math.round((window.__rvS || {}).scrollTop || 0);
  H.lockState = () => {
    const h = cs(document.documentElement), b = cs(document.body);
    return { scroll_y: Math.round(scrollY), html_overflow: h.overflowY, body_overflow: b.overflowY, body_position: b.position, body_top: b.top, touch_action: b.touchAction };
  };
  H.backdrop = () => {
    const vh = innerHeight, vw = innerWidth; let best = null;
    for (const el of document.body.getElementsByTagName('*')) {
      const s = cs(el); if (s.position !== 'fixed' && s.position !== 'absolute') continue;
      if (window.__rvP && (el === window.__rvP || window.__rvP.contains(el) || el.contains(window.__rvP))) continue;
      const r = el.getBoundingClientRect(); if (r.width < vw * 0.6 || r.height < vh * 0.6 || !H.shown(el)) continue;
      const a = H.alpha(s.backgroundColor); if (a < 0.1) continue;
      if (!best || a > best.alpha) best = { sel: H.sel(el), color: s.backgroundColor, alpha: Math.round(a * 100) / 100 };
    }
    return best;
  };
  H.outsidePoint = () => {
    const vw = innerWidth, vh = innerHeight; const p = window.__rvP; const pr = p ? p.getBoundingClientRect() : null;
    const pts = [[vw * 0.08, vh * 0.92], [vw * 0.92, vh * 0.92], [vw * 0.5, vh * 0.96], [vw * 0.05, vh * 0.5], [vw * 0.95, vh * 0.5], [vw * 0.5, vh * 0.75]];
    for (const [x, y] of pts) {
      // geometry, not elementFromPoint: a panel with pointer-events:none would let the probe through
      if (pr && x >= pr.left && x <= pr.right && y >= pr.top && y <= pr.bottom) continue;
      const el = document.elementFromPoint(x, y); if (!el) continue;
      if (p && p.contains(el)) continue;
      if (el.closest(TSEL) || el.closest('iframe, form')) continue;
      return { x: Math.round(x), y: Math.round(y), on: H.describe(el) };
    }
    return null;
  };
  H.closeButton = () => {
    const p = window.__rvP; if (!p) return null;
    for (const el of p.querySelectorAll('button, [role=button], a, span, div, i')) {
      if (!H.shown(el)) continue;
      const a = [el.getAttribute('aria-label'), el.getAttribute('title'), String(el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className), el.id, String(el.innerText || '').trim()].join(' ');
      if (!/(close|закры|^\s*[×✕✖]\s*$)/i.test(a)) continue;
      if (el.tagName === 'A' && el.getAttribute('href') && !/^(#|javascript:)/i.test(el.getAttribute('href'))) continue;
      const r = el.getBoundingClientRect(); if (r.width > 120 || r.height > 120) continue;
      return { sel: H.sel(el), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    return null;
  };
  H.stillVisible = (keys) => {
    const vh = innerHeight, vw = innerWidth; const set = new Set(keys); let n = 0;
    for (const el of document.querySelectorAll('a[href], button, [role=menuitem], [role=link]')) {
      const key = String(el.getAttribute('href') || '') + '|' + H.txt(el, 40); if (!set.has(key)) continue;
      if (!H.shown(el)) continue; const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      if (cx >= 0 && cx <= vw && cy >= 0 && cy <= vh) n++;
    }
    return n;
  };
  // real tap zone of the burger: grid of elementFromPoint ±30 px around its centre
  H.zone = (k) => {
    const el = window.__rvB && window.__rvB[k]; if (!el) return null;
    const r = el.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let n = 0, hit = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let dx = -30; dx <= 30; dx += 5) for (let dy = -30; dy <= 30; dy += 5) {
      const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      n++; if (H.hitOk(el, document.elementFromPoint(x, y))) { hit++; x0 = Math.min(x0, dx); x1 = Math.max(x1, dx); y0 = Math.min(y0, dy); y1 = Math.max(y1, dy); }
    }
    return { points: n, hits: hit, zone_w: hit ? x1 - x0 + 5 : 0, zone_h: hit ? y1 - y0 + 5 : 0, grid_max: 65, drawn_w: Math.round(r.width), drawn_h: Math.round(r.height) };
  };
  // tables wider than the screen: scrollable wrapper (ok-ish), clipped wrapper (data cut off) or page overflow
  H.tables = () => {
    const vw = innerWidth; const out = [];
    for (const t of document.querySelectorAll('table')) {
      if (!H.shown(t)) continue; const r = t.getBoundingClientRect();
      if (r.width <= vw - 2 && t.scrollWidth <= t.clientWidth + 2) continue;
      let wrap = null;
      for (let a = t.parentElement; a && a !== document.body && a !== document.documentElement; a = a.parentElement) { const s = cs(a); if (/(auto|scroll|hidden|clip)/.test(s.overflowX)) { wrap = a; break; } }
      const ws = wrap ? cs(wrap).overflowX : null;
      out.push({ sel: H.sel(t), width: Math.round(Math.max(r.width, t.scrollWidth)), cols: t.rows[0] ? t.rows[0].cells.length : 0, rows: t.rows.length, box: H.box(r),
        wrapper: ws, wrapper_sel: wrap ? H.sel(wrap) : null, state: !wrap ? 'page_overflow' : /(auto|scroll)/.test(ws) ? 'scrolls' : 'clipped' });
      if (out.length >= 10) break;
    }
    return out;
  };
  // zoom / scale(…) on big blocks: platforms that "rescale" the layout to the window shrink text on laptops
  H.scaleInfo = () => {
    const vw = innerWidth; const z = el => parseFloat(cs(el).zoom) || 1; const scaled = []; let count = 0;
    for (const el of document.body.getElementsByTagName('*')) {
      const s = cs(el); const zz = parseFloat(s.zoom) || 1; let sx = 1;
      if (s.transform && s.transform !== 'none') { const m = s.transform.match(/^matrix\(([^)]+)\)/); if (m) { const p = m[1].split(',').map(Number); sx = Math.hypot(p[0], p[1]); } }
      if (Math.abs(sx - 1) < 0.02 && Math.abs(zz - 1) < 0.02) continue;
      const r = el.getBoundingClientRect(); if (r.width < vw * 0.6 || r.height < 40 || !H.shown(el)) continue;
      if (el.parentElement && scaled.some(x => x.el.contains(el))) continue;
      count++; if (scaled.length < 5) scaled.push({ el, sel: H.sel(el), scale: Math.round(sx * zz * 1000) / 1000, by: Math.abs(zz - 1) >= 0.02 ? 'zoom' : 'transform' });
    }
    return { html_zoom: z(document.documentElement), body_zoom: document.body ? z(document.body) : 1, scaled_blocks: count, scaled: scaled.map(({ el, ...x }) => x) };
  };
  H.anims = () => {
    try { const a = document.getAnimations(); return { total: a.length, running: a.filter(x => x.playState === 'running').length,
      infinite: a.filter(x => x.effect && x.effect.getTiming && x.effect.getTiming().iterations === Infinity && x.playState === 'running').length }; } catch { return null; }
  };
  H.weight = () => ({ dom_nodes: document.getElementsByTagName('*').length, images: document.images.length, iframes: document.querySelectorAll('iframe').length });
  window.__rvm = H;
}

// ---------- node-side helpers ----------
const HELPERS_SRC = `(${PAGE_HELPERS.toString()})();`;
// measurements run in an isolated world: the page can't replace elementFromPoint, getComputedStyle & co.
async function rv(tab, fn, ...args) {
  const expr = `(async () => { window.__rvLang = ${JSON.stringify(LANG)}; ${HELPERS_SRC} return await window.__rvm.${fn}(...${JSON.stringify(args)}); })()`;
  return tab.evaluateIsolated(expr);
}
let ALLOW_POSTS = false; // --allow-load-posts: the page's own POSTs during load only (lib/cdp never lets them through on taps)
const tabOpts = () => ({ blockNavigation: true, allowLoadPosts: ALLOW_POSTS });
function rel(run, p) { return relative(run, p).split(sep).join('/'); }
function safeName(s) { return String(s).replace(/[^a-z0-9_-]+/gi, '_').slice(0, 40); }
function isLocalHost(h) { h = String(h || '').toLowerCase().replace(/^\[|\]$/g, ''); return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || (/^[\d.]+$/.test(h) && U.isPrivateIp(h)); }
async function politePause() { await U.sleep(900 + Math.floor(Math.random() * 500)); }

async function openTab(b, url, { w, h, mobile, dpr, landscape = false, settle = 700 }) {
  const tab = await b.newPage(tabOpts());
  const scripts = [];
  tab.on('Network.responseReceived', p => { if (p.type === 'Script' && scripts.length < 120) scripts.push({ id: p.requestId, url: p.response.url, status: p.response.status }); });
  await tab.setViewport({ width: w, height: h, mobile, deviceScaleFactor: dpr ?? (mobile ? 2 : 1), touch: mobile });
  await tab.emulateMedia({ colorScheme: 'light' }); // headless inherits the OS dark mode otherwise
  if (landscape) await setSize(tab, w, h, true, true);
  await politePause();
  const nav = await tab.goto(url, { timeout: 45000 });
  if (nav.ok) {
    await U.sleep(settle);
    const html = await tab.evaluate('document.documentElement ? document.documentElement.outerHTML.slice(0, 30000) : ""').catch(() => '');
    nav.antibot = U.detectAntibot(nav.status || 0, {}, html);
  }
  return { tab, nav, scripts };
}
async function setSize(tab, w, h, mobile, landscape = false) {
  await tab.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile, screenWidth: w, screenHeight: h,
    screenOrientation: landscape ? { type: 'landscapePrimary', angle: 90 } : (mobile ? { type: 'portraitPrimary', angle: 0 } : { type: 'landscapePrimary', angle: 0 }) });
  if (tab.mobile !== mobile) { await tab.send('Emulation.setTouchEmulationEnabled', mobile ? { enabled: true, maxTouchPoints: 5 } : { enabled: false }); }
}
async function shot(tab, run, file, clip = null) {
  const abs = join(run, 'measure', 'mobile', file);
  U.ensureDir(join(run, 'measure', 'mobile'));
  await tab.screenshot({ path: abs, format: 'jpeg', quality: 60, ...(clip ? { clip } : {}) });
  return rel(run, abs);
}
async function swipe(tab, x, y0, y1, steps = 8) {
  await tab.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0, id: 1 }] });
  for (let k = 1; k <= steps; k++) { await tab.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y0 + (y1 - y0) * k / steps), id: 1 }] }); await U.sleep(16); }
  await tab.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

// WCAG 2.5.8: a target smaller than 24×24 passes when a 24 px diameter circle around its centre touches neither another
// target nor the circle of another undersized target.
function targetNorms(list) {
  const c = t => [t.box[0] + t.box[2] / 2, t.box[1] + t.box[3] / 2];
  const small = t => t.w < 24 || t.h < 24;
  const distToRect = (p, b) => { const dx = Math.max(b[0] - p[0], 0, p[0] - (b[0] + b[2])); const dy = Math.max(b[1] - p[1], 0, p[1] - (b[1] + b[3])); return Math.hypot(dx, dy); };
  const fail24 = [], below44 = [];
  for (const t of list) {
    if (t.inline) continue;
    if (t.w < 44 || t.h < 44) below44.push(t);
    if (!small(t)) continue;
    const ci = c(t); let spaced = true;
    for (const o of list) {
      if (o === t || o.inline) continue;
      if (small(o) ? Math.hypot(ci[0] - c(o)[0], ci[1] - c(o)[1]) < 24 : distToRect(ci, o.box) < 12) { spaced = false; break; }
    }
    if (!spaced) fail24.push(t);
  }
  return { fail24, below44 };
}

// ---------- page measurement ----------
async function measureTouchLoad(b, tool, pg, ctx) {
  const { run, P, checks, mainAction } = ctx;
  const res = { w: 390, h: 844 };
  const { tab, nav, scripts } = await openTab(b, pg.url, { w: 390, h: 844, mobile: true });
  try {
    res.status = nav.status ?? null; res.final_url = nav.finalUrl || null; res.load_ms = nav.ms;
    if (!nav.ok) throw new Error(nav.refused ? `refused_${nav.refused}` : (nav.error || 'load failed'));
    if (nav.antibot) { res.antibot = nav.antibot; return { res, blocked: 'antibot' }; }
    if (nav.status >= 400) { res.http_error = nav.status; return { res, blocked: 'http_' + nav.status }; }
    // marks cookie banners/popups; a full-screen splash is hidden right away (nothing can be measured under it)
    const marked = await rv(tab, 'hideOverlays', false);
    const fs = marked.filter(o => o.kind === 'fullscreen_overlay');
    if (fs.length) res.overlay_fullscreen = fs[0];
    res.heading = await rv(tab, 'firstHeading');
    res.fold = await rv(tab, 'fold', mainAction);
    if (fs.length) res.fold.overlay_hidden = 'fullscreen_overlay';
    if (res.fold.cta) { const vis = BROWSER_VISIBLE[390]; res.fold.cta.in_fold_browser = res.fold.cta.top >= 0 && res.fold.cta.bottom <= vis; res.fold.browser_visible_h = vis; }
    res.meta = await rv(tab, 'meta');
    res.overlays = [...fs, ...(await rv(tab, 'hideOverlays'))];
    res.sticky_top = await rv(tab, 'sticky');
    res.overlays_note = LANG === 'en'
      ? 'fold@390 is taken before cookie banners and popups are hidden (a full-screen splash is hidden first); other measurements — after'
      : 'fold@390 снят до скрытия cookie-баннера и попапов (полноэкранная заставка скрыта сразу); остальные замеры — после';
    // step 250 px: animated stamps/marquees stick out of the screen only for a moment
    res.anim_overflow = await rv(tab, 'scrollSample', 250, 90, 16000, 390);
    res.overflow = await rv(tab, 'overflow', 390);
    res.clipped = await rv(tab, 'clipped', 390);
    res.length = await rv(tab, 'length');
    res.tables = await rv(tab, 'tables');
    res.animations = await rv(tab, 'anims');
    // weak phones: DOM size and JS heap after the scroll pass (Lighthouse warns from 1 500 nodes)
    res.weight = await rv(tab, 'weight');
    try {
      await tab.send('Performance.enable');
      const m = Object.fromEntries(((await tab.send('Performance.getMetrics')).metrics || []).map(x => [x.name, x.value]));
      res.weight.js_heap_mb = m.JSHeapUsedSize ? Math.round(m.JSHeapUsedSize / 1048576 * 10) / 10 : null;
      await tab.send('Performance.disable');
    } catch { /* metrics are optional */ }
    await rv(tab, 'scrollTo', Math.round(844 * 1.5)); await U.sleep(450);
    res.sticky_scrolled = await rv(tab, 'sticky');
    await rv(tab, 'scrollTo', 0); await U.sleep(200);
    if (checks.has('targets')) {
      const list = await rv(tab, 'collectTargets');
      const hits = await rv(tab, 'hitTest', list.map(t => t.i));
      const norms = targetNorms(list);
      const blocked = list.filter(t => hits[t.i] && hits[t.i].ok === false).map(t => ({ ...pick(t), cover: hits[t.i].cover, at: hits[t.i].at, scroll_y: hits[t.i].scroll_y }));
      for (const bl of blocked.slice(0, 3)) {
        try {
          const c = await rv(tab, 'targetCenter', bl.i, 0.4); await U.sleep(250);
          bl.shot = await shot(tab, run, `${safeName(pg.pid)}-390-blocked-${bl.i}.jpg`);
          bl.shot_scroll_y = c.scroll_y; bl.shot_box = c.box.map(v => Math.round(v * 2)); bl.shot_scale = 2;
        } catch { /* shot is optional */ }
      }
      await rv(tab, 'scrollTo', 0);
      res.targets = {
        total: list.length, inline_links: list.filter(t => t.inline).length, pointer: list.filter(t => t.kind === 'pointer').length,
        fail_24: norms.fail24.length, fail_24_items: norms.fail24.slice(0, 15).map(pick),
        below_44: norms.below44.length, below_44_items: norms.below44.slice(0, 10).map(pick),
        blocked: blocked.length, blocked_items: blocked.slice(0, 15), invisible_cover: blocked.filter(x => x.cover && x.cover.invisible).length,
        ios_pe_none: list.filter(t => t.pe_none_anc && !(hits[t.i] && hits[t.i].ok === false)).length,
        ios_pe_none_items: list.filter(t => t.pe_none_anc && !(hits[t.i] && hits[t.i].ok === false)).slice(0, 10).map(t => ({ ...pick(t), container: t.pe_none_anc })),
        offscreen: Object.values(hits).filter(h => h.ok === null).length,
      };
    }
    res.text = await rv(tab, 'textSizes');
    res.video = await rv(tab, 'videos');
    res.anchors_out = await rv(tab, 'anchorsOut');
    // code for Safari risks, hover-only, 100vh
    if (checks.has('code')) await collectCode(tab, tool, scripts, pg, ctx);
    // width sweep on the same document
    res.nav_state = await rv(tab, 'navState'); // 390: burger present, header links (for full_menu_from_px)
    res.sizes = [];
    if (checks.has('sizes')) {
      for (const w of P.touch) {
        if (ctx.only && !ctx.only.has(w)) continue;
        const h = TOUCH_SIZES[w] || 800;
        await setSize(tab, w, h, true); await U.sleep(500); await rv(tab, 'scrollTo', 0); await U.sleep(120);
        const o = await rv(tab, 'overflow', w); const f = await rv(tab, 'fold', mainAction); const len = await rv(tab, 'length');
        const row = { w, h, mode: 'touch', fresh: false, overflow: slimOverflow(o), fold: slimFold(f), screens: len.screens, nav: await rv(tab, 'navState') };
        if (w <= 440) { const cl = await rv(tab, 'clipped', w); row.clipped = cl.count; if (cl.count) row.clipped_items = cl.items.slice(0, 3); }
        if (f.cta && BROWSER_VISIBLE[w]) row.fold.cta_in_fold_browser = f.cta.top >= 0 && f.cta.bottom <= BROWSER_VISIBLE[w];
        // cramped header (logo + phone + burger) is visible only on a shot of the narrowest widths
        if (pg.pid === ctx.homePid && HEADER_SHOT_WIDTHS.has(w)) { try { row.header_shot = await shot(tab, run, `${safeName(pg.pid)}-${w}-header.jpg`, { x: 0, y: 0, width: w, height: 200 }); } catch {} }
        if (o.px > 0 || o.culprits.some(c => !c.fixed)) row.shot = await overflowShot(tab, run, pg, w, o);
        res.sizes.push(row);
      }
    }
    // landscape phone (rotation of the same document)
    if (ctx.landscapeSet.has(pg.pid) && checks.has('landscape')) {
      await setSize(tab, 844, 390, true, true); await U.sleep(600); await rv(tab, 'scrollTo', 0); await U.sleep(150);
      const o = await rv(tab, 'overflow', 844); const f = await rv(tab, 'fold', mainAction); const st = await rv(tab, 'sticky');
      await rv(tab, 'scrollTo', 600); await U.sleep(400); const st2 = await rv(tab, 'sticky'); await rv(tab, 'scrollTo', 0); await U.sleep(200);
      res.landscape = { w: 844, h: 390, overflow: slimOverflow(o), fold: slimFold(f), sticky_share_top: st.share, sticky_share_scrolled: st2.share, sticky_layers: st2.layers.slice(0, 5),
        shot: await shot(tab, run, `${safeName(pg.pid)}-844x390-fold.jpg`) };
    }
    // deep: touch tablets from 981 px — does a hover menu of the header open by touch?
    if (checks.has('sizes') && P.tablet.length && pg.pid === ctx.homePid) {
      res.tablets = [];
      for (const [w, h] of P.tablet) {
        if (ctx.only && !ctx.only.has(w)) continue;
        try { res.tablets.push(await tabletRow(tab, run, pg, w, h, ctx)); } catch (e) { res.tablets.push({ w, h, error: e.message.slice(0, 120) }); }
      }
    }
    res.blocked_actions = { navigation: tab.blocked.navigation.length, write: tab.blocked.write.length, interact: (tab.blocked.interact || []).length };
    return { res };
  } finally { await tab.close(); }
}

function pick(t) { return { i: t.i, tag: t.tag, sel: t.sel, text: t.text, box: t.box, w: t.w, h: t.h, ...(t.kind ? { kind: t.kind } : {}) }; }
function slimOverflow(o) { return { px: o.px, scroll_width: o.scroll_width, inner_width: o.inner_width, root_clip: o.root_clip, count: o.count, culprits: o.culprits.slice(0, 5), ...(o.fixed_wide && o.fixed_wide.length ? { fixed_wide: o.fixed_wide } : {}) }; }
function slimFold(f) { return { vw: f.vw, vh: f.vh, cta_in_fold: f.cta_in_fold, cta: f.cta, h1_in_fold: f.h1 ? f.h1.in_fold : null, h1_lines: f.h1 ? f.h1.lines : null }; }
async function overflowShot(tab, run, pg, w, o) {
  const c = o.culprits.find(x => !x.fixed) || o.culprits[0]; if (!c) return null;
  const y = await rv(tab, 'scrollTo', Math.max(0, c.box[1] - 80)); await U.sleep(250);
  const file = await shot(tab, run, `${safeName(pg.pid)}-${w}-overflow.jpg`);
  await rv(tab, 'scrollTo', 0);
  return { file, scroll_y: y, culprit: c.sel };
}

// What a tap would hit is not a toggle: a link to another address, tel:/mailto:, a form control, a consent button.
// lib/cdp lets links through when navigation is blocked, so this check is ours.
function unsafeTap(hi) {
  if (!hi || hi.none) return 'nothing';
  if (hi.isIframe) return 'iframe';
  if (hi.isSubmit) return 'submit';
  if (hi.isConsentAccept) return 'consent';
  if ((hi.contactForm || hi.nearContact) && hi.isControl && !hi.isField) return 'contact-form';
  if (hi.inForm && hi.isControl) return 'form'; // buttons/links of a form (a div inside a page-wide form is fine)
  if (hi.isField) return 'field';
  if (hi.isLink && hi.href) {
    if (/^(tel|mailto|sms|callto|viber|whatsapp|tg):/i.test(hi.href)) return 'tel/mailto';
    if (/^javascript:/i.test(hi.href)) return null;
    if (hi.leaves) return 'link';
  }
  return null;
}
async function hitFor(tab, x, y) {
  const hi = await tab.hitInfo(x, y).catch(() => null);
  if (hi && hi.isLink && hi.href) { // same document + hash = a toggle; anything else leaves the page
    const here = await rv(tab, 'here').catch(() => '');
    try { const u = new URL(hi.href), h = new URL(here); hi.leaves = !(u.origin === h.origin && u.pathname === h.pathname && u.search === h.search); } catch { hi.leaves = true; }
  }
  return hi;
}

async function tabletRow(tab, run, pg, w, h, ctx) {
  await setSize(tab, w, h, true); await U.sleep(600); await rv(tab, 'scrollTo', 0); await U.sleep(150);
  const o = await rv(tab, 'overflow', w); const f = await rv(tab, 'fold', ctx.mainAction); const nav = await rv(tab, 'navState');
  const subs = await rv(tab, 'headerSubmenus');
  const row = { w, h, mode: 'tablet', overflow: slimOverflow(o), fold: slimFold(f), nav, submenus: subs.length, submenu_items: subs.slice(0, 4).map(s => ({ sel: s.sel, text: s.text, toggle: s.toggle })) };
  const t = subs.find(s => s.toggle);
  if (t) {
    const hi = await hitFor(tab, t.center[0], t.center[1]); const bad = unsafeTap(hi);
    if (bad) row.submenu_tap = { sel: t.sel, skipped: bad };
    else {
      const navBefore = tab.blocked.navigation.length;
      const r = await tab.tap(t.center[0], t.center[1]); await U.sleep(600);
      const shown = r.refused ? null : await rv(tab, 'submenuShown', t.i);
      row.submenu_tap = { sel: t.sel, refused: r.refused || undefined, opened: shown === null ? null : shown >= 2, links_shown: shown, navigation: tab.blocked.navigation.length > navBefore || undefined };
      row.shot = await shot(tab, run, `${safeName(pg.pid)}-${w}x${h}-tablet-submenu.jpg`);
      await tab.key('Escape', 'Escape', 27); await U.sleep(300);
      // still open: the same toggle closes it, so the next width starts from the same state
      if (shown >= 2 && (await rv(tab, 'submenuShown', t.i)) >= 2) { const h2 = await hitFor(tab, t.center[0], t.center[1]); if (!unsafeTap(h2)) { await tab.tap(t.center[0], t.center[1]); await U.sleep(400); } }
    }
  } else if (subs.length) row.submenu_tap = { sel: subs[0].sel, skipped: 'link_parent' };
  if (!row.shot) row.shot = await shot(tab, run, `${safeName(pg.pid)}-${w}x${h}-tablet.jpg`);
  return row;
}

async function measureDesktopLoad(b, pg, ctx) {
  const { run, P, checks, mainAction } = ctx;
  const res = { w: 1440, h: 900 };
  const { tab, nav } = await openTab(b, pg.url, { w: 1440, h: 900, mobile: false });
  try {
    res.status = nav.status ?? null;
    if (!nav.ok) throw new Error(nav.refused ? `refused_${nav.refused}` : (nav.error || 'load failed'));
    if (nav.antibot || nav.status >= 400) { res.blocked = nav.antibot || nav.status; return res; }
    const marked = await rv(tab, 'hideOverlays', false);
    const fs = marked.filter(o => o.kind === 'fullscreen_overlay');
    if (fs.length) res.overlay_fullscreen = fs[0];
    res.heading = await rv(tab, 'firstHeading');
    res.fold = slimFold(await rv(tab, 'fold', mainAction));
    if (fs.length) res.fold.overlay_hidden = 'fullscreen_overlay';
    res.nav_state = await rv(tab, 'navState');
    res.sizes = [];
    if (checks.has('sizes')) {
      // laptop windows first: fold as the visitor sees it (cookie banner included)
      for (const [w, h] of P.desk) {
        if (ctx.only && !(ctx.only.has(w) && (ctx.only.get(w) === null || ctx.only.get(w) === h))) continue;
        await setSize(tab, w, h, false); await U.sleep(550); await rv(tab, 'scrollTo', 0); await U.sleep(150);
        const f = await rv(tab, 'fold', mainAction); const o = await rv(tab, 'overflow', w); const st = await rv(tab, 'sticky');
        const tx = await rv(tab, 'textSizes'); const sc = await rv(tab, 'scaleInfo');
        const row = { w, h, mode: 'desktop', fresh: false, window: LAPTOP_WINDOWS.has(`${w}x${h}`), overflow: slimOverflow(o), fold: slimFold(f), sticky_share: st.share,
          text: { lt12: tx.lt12, lt14: tx.lt14 }, scale: sc, nav: await rv(tab, 'navState') };
        if (row.window) row.shot = await shot(tab, run, `${safeName(pg.pid)}-${w}x${h}-fold.jpg`);
        if (o.px > 0) row.overflow_shot = await overflowShot(tab, run, pg, w, o);
        res.sizes.push(row);
      }
      await setSize(tab, 1440, 900, false); await U.sleep(500); await rv(tab, 'scrollTo', 0);
    }
    res.overlays = await rv(tab, 'hideOverlays');
    res.overflow = slimOverflow(await rv(tab, 'overflow', 1440));
    const tx = await rv(tab, 'textSizes');
    res.text = { lt12: tx.lt12, lt14: tx.lt14 }; res.scale = await rv(tab, 'scaleInfo');
    // platform rescale: text on a laptop window much smaller than at 1440
    res.rescale = (res.sizes || []).filter(s => s.window && s.text && (s.text.lt12 - res.text.lt12 >= 10 || (s.scale && s.scale.scaled_blocks && (!res.scale.scaled_blocks || s.scale.scaled.some(x => x.scale < 0.95)))))
      .map(s => ({ w: s.w, h: s.h, lt12: s.text.lt12, lt12_1440: res.text.lt12, scaled: s.scale ? s.scale.scaled.slice(0, 3) : [] }));
    if (checks.has('targets')) {
      const list = await rv(tab, 'collectTargets');
      const hits = await rv(tab, 'hitTest', list.map(t => t.i));
      const blocked = list.filter(t => hits[t.i] && hits[t.i].ok === false).map(t => ({ ...pick(t), cover: hits[t.i].cover, at: hits[t.i].at, scroll_y: hits[t.i].scroll_y }));
      for (const bl of blocked.slice(0, 2)) {
        try { const c = await rv(tab, 'targetCenter', bl.i, 0.4); await U.sleep(250); bl.shot = await shot(tab, run, `${safeName(pg.pid)}-1440-blocked-${bl.i}.jpg`); bl.shot_scroll_y = c.scroll_y; bl.shot_box = c.box.map(Math.round); bl.shot_scale = 1; } catch {}
      }
      res.targets = { total: list.length, blocked: blocked.length, blocked_items: blocked.slice(0, 15), invisible_cover: blocked.filter(x => x.cover && x.cover.invisible).length };
    }
    return res;
  } finally { await tab.close(); }
}

async function confirmOverflow(b, pg, w, h, mobile) {
  const { tab, nav } = await openTab(b, pg.url, { w, h, mobile });
  try {
    if (!nav.ok) return { error: nav.error || 'load failed' };
    await rv(tab, 'scrollSample', 600, 90, 20000, w);
    const o = await rv(tab, 'overflow', w);
    return { px: o.px, culprits: o.culprits.slice(0, 3) };
  } finally { await tab.close(); }
}

// ---------- code scan (CSS via CDP CSS domain, JS via response bodies) ----------
async function collectCss(tab) {
  const heads = [];
  const off = tab.on('CSS.styleSheetAdded', p => heads.push(p.header));
  try { await tab.send('DOM.enable'); await tab.send('CSS.enable'); await U.sleep(300); } catch { off(); return []; }
  off();
  const out = [];
  for (const h of heads) {
    if (h.origin && h.origin !== 'regular') continue;
    try { const { text } = await tab.send('CSS.getStyleSheetText', { styleSheetId: h.styleSheetId }); if (text) out.push({ url: h.sourceURL || '', inline: !!h.isInline, text }); } catch {}
  }
  try { await tab.send('CSS.disable'); } catch {}
  return out;
}

function CSS_ANALYZER(text) { // runs in the blank tool tab
  const out = { hover_total: 0, hover_guarded: 0, reveal: [], transform: [], reveal_count: 0, transform_count: 0, vh: [], vh_count: 0, parse_error: null,
    motion: { transition_all: 0, transition_all_samples: [], layout: 0, layout_samples: [], ease_in: 0, long: 0, long_samples: [], keyframes_layout: 0, keyframes_scale0: 0, keyframes_samples: [] } };
  let sheet;
  try { sheet = new CSSStyleSheet(); sheet.replaceSync(text); } catch (e) { out.parse_error = String(e && e.message || e).slice(0, 100); return out; }
  const GUARD = /\(\s*(any-)?hover\s*:\s*hover\s*\)|\(\s*(any-)?pointer\s*:\s*fine\s*\)/i;
  const REVEAL = /^(display|visibility|opacity|max-height|height|transform|translate|scale|clip-path|pointer-events|left|right|top|bottom)$/;
  const MOVE = /^(transform|translate|scale|rotate|top|margin-top|box-shadow)$/;
  const LAYOUT = /^(width|height|max-height|min-height|top|left|right|bottom|margin(-\w+)?|padding(-\w+)?)$/;
  const M = out.motion;
  const secs = v => String(v || '').split(',').map(s => { s = s.trim(); return s.endsWith('ms') ? parseFloat(s) / 1000 : parseFloat(s) || 0; });
  // motion rules (transition: all, layout properties, ease-in, long UI transitions) — data for the visual lens
  const motion = (r, sel) => {
    const prop = r.style.getPropertyValue('transition-property'); const dur = secs(r.style.getPropertyValue('transition-duration'));
    if (!prop || !dur.some(d => d > 0)) return;
    const props = prop.split(',').map(s => s.trim());
    if (props.includes('all')) { M.transition_all++; if (M.transition_all_samples.length < 6) M.transition_all_samples.push(sel.slice(0, 100)); }
    const lay = props.filter(p => LAYOUT.test(p));
    if (lay.length) { M.layout++; if (M.layout_samples.length < 6) M.layout_samples.push({ sel: sel.slice(0, 100), props: lay.slice(0, 4) }); }
    if (/(^|,)\s*ease-in\s*(,|$)/.test(r.style.getPropertyValue('transition-timing-function'))) M.ease_in++;
    const mx = Math.max(...dur);
    if (mx > 0.5 && /(:hover|:focus|:active|btn|button|link|menu|nav)/i.test(sel)) { M.long++; if (M.long_samples.length < 6) M.long_samples.push({ sel: sel.slice(0, 100), seconds: mx }); }
  };
  const walk = (rules, conds) => {
    for (const r of rules) {
      if (typeof CSSKeyframesRule !== 'undefined' && r instanceof CSSKeyframesRule) {
        let lay = false, s0 = false;
        for (const k of r.cssRules) {
          for (let i = 0; i < k.style.length; i++) if (LAYOUT.test(k.style[i])) lay = true;
          if (/^(from|0%)$/.test(String(k.keyText).trim()) && /scale\(\s*0\s*\)|scale\(\s*0\s*,\s*0\s*\)/.test(k.style.getPropertyValue('transform'))) s0 = true;
        }
        if (lay) M.keyframes_layout++; if (s0) M.keyframes_scale0++;
        if ((lay || s0) && M.keyframes_samples.length < 6) M.keyframes_samples.push({ name: r.name, layout: lay, scale0: s0 });
        continue;
      }
      if (r instanceof CSSStyleRule) {
        const sel = r.selectorText || ''; const props = []; for (let i = 0; i < r.style.length; i++) props.push(r.style[i]);
        motion(r, sel);
        if (sel.includes(':hover')) {
          out.hover_total++;
          if (conds.some(c => GUARD.test(c))) out.hover_guarded++;
          else for (const s of sel.split(',')) {
            if (!s.includes(':hover')) continue;
            const after = s.slice(s.lastIndexOf(':hover') + 6);
            const otherEl = /[\s>+~]\s*\S/.test(after.replace(/^[^\s>+~]*/, ''));
            const item = { sel: s.trim().slice(0, 140), props: props.slice(0, 6), media: conds.join(' ').slice(0, 100) };
            if (otherEl && props.some(p => REVEAL.test(p))) { out.reveal_count++; if (out.reveal.length < 8) out.reveal.push(item); }
            else if (!otherEl && props.some(p => MOVE.test(p))) { out.transform_count++; if (out.transform.length < 8) out.transform.push(item); }
          }
        }
        for (const p of ['height', 'min-height', 'max-height']) {
          const v = r.style.getPropertyValue(p);
          if (/\b100vh\b/.test(v)) { out.vh_count++; if (out.vh.length < 8) out.vh.push({ sel: sel.slice(0, 120), prop: p, value: v.slice(0, 60), media: conds.join(' ').slice(0, 100) }); }
        }
        if (r.cssRules && r.cssRules.length) walk(r.cssRules, conds);
      } else if (typeof CSSMediaRule !== 'undefined' && r instanceof CSSMediaRule) {
        walk(r.cssRules, conds.concat(r.conditionText || r.media.mediaText || ''));
      } else if (r.cssRules) {
        walk(r.cssRules, conds.concat(r.conditionText || ''));
      }
    }
  };
  walk(sheet.cssRules, []);
  return out;
}

async function collectCode(tab, tool, scripts, pg, ctx) {
  const { out } = ctx; const files = out.code_files; const siteHost = U.stripWww(U.hostOf(pg.url));
  const firstParty = url => { const h = U.stripWww(U.hostOf(url)); return !url || h === siteHost || h.endsWith('.' + siteHost); };
  let budgetBytes = 14 * 1024 * 1024;
  const sheets = await collectCss(tab);
  for (const s of sheets) {
    const key = s.inline || !s.url ? `inline-css:${U.md5(s.text).slice(0, 12)}` : s.url;
    if (files[key]) { files[key].pages = [...new Set([...files[key].pages, pg.pid])].slice(0, 30); continue; }
    if (s.text.length > 3 * 1024 * 1024 || budgetBytes <= 0) continue;
    budgetBytes -= s.text.length;
    const hits = scanCode('css', s.text);
    let css = null;
    try { css = await tool.evaluate(`(${CSS_ANALYZER.toString()})(${JSON.stringify(s.text)})`); } catch (e) { css = { parse_error: e.message.slice(0, 100) }; }
    files[key] = { url: s.inline ? `${pg.url} <style>` : s.url, kind: 'css', first_party: s.inline || firstParty(s.url), bytes: s.text.length, pages: [pg.pid], hits, css };
  }
  for (const sc of scripts) {
    if (!sc.url || files[sc.url] || budgetBytes <= 0 || sc.status >= 400) continue;
    let body = null;
    try { const r = await tab.send('Network.getResponseBody', { requestId: sc.id }); body = r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body; } catch { continue; }
    if (!body || body.length > 4 * 1024 * 1024) continue;
    budgetBytes -= body.length;
    files[sc.url] = { url: sc.url, kind: 'js', first_party: firstParty(sc.url), bytes: body.length, pages: [pg.pid], hits: scanCode('js', body) };
  }
  let inl = [];
  try { inl = await rv(tab, 'inlineScripts'); } catch {}
  for (const t of inl) {
    const key = `inline-js:${U.md5(t).slice(0, 12)}`;
    if (files[key]) continue;
    files[key] = { url: `${pg.url} <script>`, kind: 'js', first_party: true, bytes: t.length, pages: [pg.pid], hits: scanCode('js', t) };
  }
}

function aggregateCode(out, lang) {
  const files = Object.values(out.code_files);
  const safari = [];
  for (const r of SAFARI_RULES) {
    if (r.kind === 'html') { // counted from the DOM of each page
      const withIt = out.items.filter(i => i.touch && i.touch.meta && i.touch.meta[r.meta] > 0);
      if (!withIt.length) continue;
      safari.push({ id: r.id, kind: 'html', what: lang === 'en' ? r.en : r.ru, min_ios: r.min, level: riskLevel(r.min), excludes: excludedDevices(r.min, lang), first_party: true, guarded: false,
        files: 0, count: withIt.reduce((a, i) => a + i.touch.meta[r.meta], 0), where: withIt.slice(0, 6).map(i => ({ url: i.url, pid: i.pid, count: i.touch.meta[r.meta] })) });
      continue;
    }
    const where = files.filter(f => f.hits && f.hits[r.id]).map(f => ({ url: f.url, first_party: f.first_party, count: f.hits[r.id].count, sample: f.hits[r.id].sample, guarded: f.hits[r.id].guarded, pages: f.pages.slice(0, 5) }));
    if (!where.length) continue;
    safari.push({ id: r.id, kind: r.kind, what: lang === 'en' ? r.en : r.ru, min_ios: r.min, level: r.info ? 'info' : r.harmless ? 'harmless' : riskLevel(r.min),
      excludes: excludedDevices(r.min, lang), first_party: where.some(w => w.first_party), guarded: where.every(w => w.guarded), files: where.length, count: where.reduce((a, w) => a + w.count, 0), where: where.slice(0, 6) });
  }
  const order = { high: 0, medium: 1, check: 2, low: 3, harmless: 4, info: 5 };
  safari.sort((a, b) => (order[a.level] - order[b.level]) || (b.first_party - a.first_party));
  const cssFiles = files.filter(f => f.kind === 'css');
  const sum = (k) => cssFiles.reduce((a, f) => a + ((f.css && f.css[k]) || 0), 0);
  const samples = (k) => cssFiles.flatMap(f => ((f.css && f.css[k]) || []).map(x => ({ ...x, url: f.url, first_party: f.first_party }))).slice(0, 12);
  const meta = out.items.map(i => i.touch && i.touch.meta).filter(Boolean)[0] || null;
  const hasTsa = cssFiles.some(f => f.hits && f.hits._text_size_adjust);
  const hasSafe = cssFiles.some(f => f.hits && f.hits._safe_area);
  out.code = {
    files_scanned: files.length, css_files: cssFiles.length, js_files: files.length - cssFiles.length,
    safari,
    hover_only: { total: sum('hover_total'), guarded: sum('hover_guarded'), reveal: sum('reveal_count'), transform: sum('transform_count'), reveal_samples: samples('reveal'), transform_samples: samples('transform') },
    vh100: { rules: sum('vh_count'), samples: samples('vh') },
    motion: (() => {
      const ms = cssFiles.map(f => ({ m: f.css && f.css.motion, f })).filter(x => x.m);
      const add = k => ms.reduce((a, x) => a + (x.m[k] || 0), 0);
      const smp = k => ms.flatMap(x => (x.m[k] || []).map(s => (typeof s === 'string' ? { sel: s } : s)).map(s => ({ ...s, url: x.f.url, first_party: x.f.first_party }))).slice(0, 8);
      return { transition_all: add('transition_all'), transition_all_samples: smp('transition_all_samples'), layout_transitions: add('layout'), layout_samples: smp('layout_samples'),
        ease_in: add('ease_in'), long_ui: add('long'), long_samples: smp('long_samples'), keyframes_layout: add('keyframes_layout'), keyframes_scale0: add('keyframes_scale0'), keyframes_samples: smp('keyframes_samples'),
        norm: lang === 'en' ? 'transform/opacity only; no transition: all; UI up to 300 ms, modals 200–500 ms; enter with ease-out, no ease-in; never start from scale(0)'
          : 'только transform/opacity; без transition: all; UI до 300 мс, модалки 200–500 мс; появление ease-out, без ease-in; старт не с scale(0)' };
    })(),
    text_size_adjust: hasTsa,
    safe_area: { viewport_fit_cover: !!(meta && meta.fit_cover), env_used: hasSafe, risk: !!(meta && meta.fit_cover) && !hasSafe },
    html: { popover: out.items.reduce((a, i) => a + ((i.touch && i.touch.meta && i.touch.meta.popover) || 0), 0), dialog: out.items.reduce((a, i) => a + ((i.touch && i.touch.meta && i.touch.meta.dialog) || 0), 0) },
    parse_errors: cssFiles.filter(f => f.css && f.css.parse_error).map(f => ({ url: f.url, error: f.css.parse_error })).slice(0, 5),
  };
}

// ---------- burger ----------
async function burgerTest(b, pg, w, h, ctx) {
  const { run } = ctx;
  const res = { pid: pg.pid, url: pg.url, w, h, found: false };
  const { tab, nav } = await openTab(b, pg.url, { w, h, mobile: true });
  try {
    if (!nav.ok || nav.antibot || nav.status >= 400) { res.error = nav.error || nav.antibot || `http ${nav.status}`; return res; }
    res.overlays = await rv(tab, 'hideOverlays');
    if (res.overlays.some(o => o.kind === 'fullscreen_overlay')) res.overlay_hidden = 'fullscreen_overlay';
    const cands = await rv(tab, 'findBurger');
    // hitInfo before any touch: a candidate that would land on a link to another address, tel:/mailto:,
    // a form control or a consent button is skipped (lib/cdp lets links through when navigation is blocked)
    res.skipped = [];
    let c = null;
    for (const cand of cands) {
      if (!cand || !cand.on_screen) { if (cand) res.skipped.push({ sel: cand.sel, reason: 'offscreen' }); continue; }
      const hi = await hitFor(tab, cand.center[0], cand.center[1]);
      const bad = unsafeTap(hi);
      if (bad) { res.skipped.push({ sel: cand.sel, reason: bad, hit: hi && !hi.none ? `${String(hi.targetTag || '').toLowerCase()} ${hi.text || ''}`.trim().slice(0, 60) : null }); continue; }
      c = cand; break;
    }
    if (!res.skipped.length) delete res.skipped;
    if (!c) {
      const vis = await rv(tab, 'visibleLinks');
      res.header_links = vis.filter(x => x.box[1] < 160).length;
      res.reason = cands.length ? 'only_unsafe_candidates' : 'no_candidate';
      return res;
    }
    const K = c.k;
    res.found = true; res.toggle = c; res.alternatives = cands.filter(x => x && x.k !== K).map(x => x.sel);
    // when the toggle stays on screen after scrolling, test from y=400: a lock via body{position:fixed} resets the page to the top
    let y0 = 0;
    if (c.fixed) {
      await rv(tab, 'scrollTo', 400); await U.sleep(350);
      const c2 = await rv(tab, 'burgerInfo', K, c.score);
      if (c2 && c2.on_screen && c2.hit_ok) { y0 = await rv(tab, 'scrollTo', 400); c = c2; } else { await rv(tab, 'scrollTo', 0); await U.sleep(250); c = await rv(tab, 'burgerInfo', K, c.score); }
    }
    res.start_scroll_y = y0;
    res.toggle_hit_ok = c.hit_ok; res.toggle_cover = c.hit_cover;
    res.toggle_zone = await rv(tab, 'zone', K).catch(() => null);
    const before = await rv(tab, 'visibleLinks');
    const beforeKeys = new Set(before.map(x => x.key));
    const lock0 = await rv(tab, 'lockState');
    // the point may have changed after scrolling: check it again
    const hi0 = await hitFor(tab, c.center[0], c.center[1]); const bad0 = unsafeTap(hi0);
    if (bad0) { res.found = false; res.reason = bad0 === 'link' || bad0 === 'tel/mailto' ? 'link' : bad0; return res; }
    const here0 = await rv(tab, 'here');
    const navBefore = tab.blocked.navigation.length;
    const t = await tab.tap(c.center[0], c.center[1]);
    if (t.refused) { res.refused = t.refused; return res; }
    await U.sleep(800);
    res.navigation_attempts = tab.blocked.navigation.slice(navBefore).map(n => n.url).slice(0, 3);
    // a document navigation (cut by lib/cdp) or an SPA route change: it was a link, not a menu toggle
    const here1 = await rv(tab, 'here').catch(() => here0);
    if (res.navigation_attempts.length || (here1 && here1.split('#')[0] !== here0.split('#')[0])) {
      res.found = false; res.reason = 'link'; res.route_changed = here1 !== here0 || undefined; return res;
    }
    let after = await rv(tab, 'visibleLinks');
    let added = after.filter(x => !beforeKeys.has(x.key) && !(Math.abs(x.center[0] - c.center[0]) < 8 && Math.abs(x.center[1] - c.center[1]) < 8));
    const c1 = await rv(tab, 'burgerInfo', K, c.score);
    res.expanded_before = c.expanded; res.expanded_after = c1 ? c1.expanded : null;
    res.opened = added.length >= 2 || (c.expanded !== 'true' && c1 && c1.expanded === 'true');
    res.open_shot = await shot(tab, run, `burger-${safeName(pg.pid)}-${w}-open.jpg`);
    if (!res.opened) return res;
    res.icon_changes = !!(c1 && c1.sig !== c.sig);
    res.toggle_reachable_open = c1 ? c1.hit_ok : null;
    const idxs = added.map(x => x.i).slice(0, 40);
    const checks = await rv(tab, 'checkLinks', idxs);
    res.items = added.slice(0, 40).map((x, k) => ({ text: x.text, href: x.href, box: x.box, w: x.w, h: x.h, ok: checks[k] ? checks[k].ok : null, cover: checks[k] ? checks[k].cover : null, pe_none_anc: checks[k] ? checks[k].pe_none_anc : null }));
    res.items_count = added.length;
    res.items_blocked = res.items.filter(x => x.ok === false).length;
    res.items_small = res.items.filter(x => x.h < 24 || x.w < 24).length;
    res.items_ios_pe_none = res.items.filter(x => x.ok && x.pe_none_anc).length;
    res.toggle_ios_pe_none = c.pe_none_anc;
    res.panel = await rv(tab, 'panel', idxs);
    res.backdrop = await rv(tab, 'backdrop');
    const lock1 = await rv(tab, 'lockState');
    const cssLocked = /hidden|clip/.test(lock1.html_overflow) || /hidden|clip/.test(lock1.body_overflow) || lock1.body_position === 'fixed' || /none/.test(lock1.touch_action);
    res.lock = { before: lock0, open: lock1, css_locked: cssLocked, method: lock1.body_position === 'fixed' ? 'body position:fixed' : cssLocked ? 'overflow:hidden' : null, scroll_reset_on_open: y0 > 0 && lock1.scroll_y === 0 };
    // swipe test: does the page behind the menu scroll?
    await rv(tab, 'scrollerOf');
    const panelBefore = await rv(tab, 'panelScroll');
    const sx = Math.round(w / 2), sy0 = Math.round(h * 0.8), sy1 = Math.round(h * 0.3);
    const hi = await tab.hitInfo(sx, sy0).catch(() => null);
    if (hi && !hi.isIframe && !hi.isSubmit && !hi.isField) {
      tab.guard(); // our gesture: background requests fired by it are cut
      await swipe(tab, sx, sy0, sy1); await U.sleep(500);
      const lock2 = await rv(tab, 'lockState'); const panelAfter = await rv(tab, 'panelScroll');
      res.lock.background_scrolled = Math.abs(lock2.scroll_y - lock1.scroll_y) > 5; res.lock.background_delta = lock2.scroll_y - lock1.scroll_y;
      res.lock.menu_scrolled = Math.abs(panelAfter - panelBefore) > 2;
      if (res.lock.background_scrolled) { await rv(tab, 'scrollTo', lock1.scroll_y); await U.sleep(250); }
    } else res.lock.swipe = 'skipped_unsafe_point';
    // closing methods; reopen between them
    const keys = added.map(x => x.key);
    const isClosed = async () => (await rv(tab, 'stillVisible', keys)) <= 1;
    const safeTap = async (x, y) => { const h2 = await hitFor(tab, x, y); const bad = unsafeTap(h2); if (bad) return { refused: bad }; return tab.tap(x, y); };
    const reopen = async () => {
      const ci = await rv(tab, 'burgerInfo', K, c.score); if (!ci || !ci.on_screen) return false;
      const r = await safeTap(ci.center[0], ci.center[1]); if (r.refused) return false;
      await U.sleep(800); return !(await isClosed());
    };
    res.close = {};
    await tab.key('Escape', 'Escape', 27); await U.sleep(600);
    res.close.escape = await isClosed();
    if (res.close.escape && !(await reopen())) { res.close.reopen_failed = true; }
    if (!(await isClosed())) {
      await rv(tab, 'panel', (await rv(tab, 'visibleLinks')).filter(x => keys.includes(x.key)).map(x => x.i));
      const pt = await rv(tab, 'outsidePoint');
      if (pt) { const r = await safeTap(pt.x, pt.y); await U.sleep(600); res.close.outside = r.refused ? null : await isClosed(); res.close.outside_point = [pt.x, pt.y]; if (r.refused) res.close.outside_refused = r.refused; }
      else res.close.outside = 'no_free_point';
      if (res.close.outside === true && !(await reopen())) res.close.reopen_failed = true;
    }
    if (!(await isClosed())) {
      const cb = await rv(tab, 'closeButton');
      if (cb) { const r = await safeTap(cb.x, cb.y); await U.sleep(600); res.close.close_button = r.refused ? null : await isClosed(); res.close.close_button_sel = cb.sel; }
      else res.close.close_button = 'not_found';
      if (res.close.close_button === true && !(await reopen())) res.close.reopen_failed = true;
    }
    if (!(await isClosed())) {
      const ci = await rv(tab, 'burgerInfo', K, c.score);
      if (ci && ci.on_screen && ci.hit_ok) { const r = await safeTap(ci.center[0], ci.center[1]); await U.sleep(700); res.close.toggle = r.refused ? null : await isClosed(); }
      else res.close.toggle = ci && ci.on_screen ? 'covered' : 'offscreen';
    }
    const lock3 = await rv(tab, 'lockState');
    res.lock.scroll_after_close = lock3.scroll_y;
    res.lock.scroll_restored = Math.abs(lock3.scroll_y - lock1.scroll_y) <= 5 || Math.abs(lock3.scroll_y - y0) <= 5;
    res.navigation_attempts = tab.blocked.navigation.map(n => n.url).slice(0, 3);
    const nl = ctx.navLists && ctx.navLists.burger;
    if (Array.isArray(nl) && nl.length) {
      const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
      const got = new Set(res.items.map(x => norm(x.text))); const exp = new Set(nl.map(x => norm(x.text)));
      res.nav_lists_compare = { expected: nl.length, measured: res.items_count, missing: [...exp].filter(x => !got.has(x)).slice(0, 10), extra: [...got].filter(x => !exp.has(x)).slice(0, 10) };
    }
    return res;
  } finally { await tab.close(); }
}

// ---------- navigation between pages ----------
function ANCHOR_SAMPLE(hash) {
  let id = hash.slice(1); try { id = decodeURIComponent(id); } catch {}
  const el = document.getElementById(id) || document.getElementsByName(id)[0];
  const pt = Math.round(performance.now());
  if (!el) return { found: false, scroll_y: Math.round(scrollY), pt };
  const r = el.getBoundingClientRect(); let hb = 0;
  for (const e of document.body.getElementsByTagName('*')) {
    const s = getComputedStyle(e); if (s.position !== 'fixed' && s.position !== 'sticky') continue;
    const q = e.getBoundingClientRect(); if (q.top <= 2 && q.bottom > 0 && q.bottom < innerHeight * 0.5 && q.width > innerWidth * 0.5) hb = Math.max(hb, q.bottom);
  }
  // the target near the end of the page can't reach the top: the scroll is at its maximum
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
  return { found: true, top: Math.round(r.top), scroll_y: Math.round(scrollY), max_scroll: Math.round(maxScroll), at_end: scrollY >= maxScroll - 2, visible: r.top < innerHeight && r.bottom > 0,
    header_bottom: Math.round(hb), under_header: r.top < hb - 2, pt };
}

async function anchorTest(b, href, w, h, mobile) {
  const tab = await b.newPage(tabOpts());
  try {
    await tab.setViewport({ width: w, height: h, mobile, deviceScaleFactor: mobile ? 2 : 1, touch: mobile });
    await tab.emulateMedia({ colorScheme: 'light' });
    const hash = new URL(href).hash;
    await politePause();
    const navP = tab.goto(href, { timeout: 30000 });
    const samples = []; const t0 = Date.now();
    for (const t of [1000, 2500, 5000]) {
      while (Date.now() - t0 < 32000) {
        const pt = await tab.evaluate('/^https?:/.test(location.href) && document.body ? performance.now() : -1').catch(() => -1);
        if (pt >= t) break;
        await U.sleep(pt < 0 ? 100 : Math.max(40, Math.min(300, t - pt)));
      }
      const s = await tab.evaluate(`(${ANCHOR_SAMPLE.toString()})(${JSON.stringify(hash)})`).catch(e => ({ error: e.message.slice(0, 120) }));
      samples.push({ t, ...s });
    }
    const nav = await navP;
    const last = samples[samples.length - 1] || {};
    let verdict = 'ok';
    if (!last.found) verdict = 'not_found';
    else if (last.under_header) verdict = 'under_header';
    else if (last.top < -5) verdict = 'past';
    else if (last.top > 220) verdict = last.at_end && last.visible ? 'page_end' : 'too_low';
    const first = samples[0] || {};
    const moving = first.found && last.found && Math.abs((first.scroll_y || 0) - (last.scroll_y || 0)) > 300;
    return { href, w, h, status: nav.status ?? null, samples, verdict, moving_at_1s: !!moving, corridor: [-5, 220] };
  } finally { await tab.close(); }
}

// Runs in every new document of the flash tab: background under the screen centre on each frame for 1.5 s.
function FLASH_PROBE() {
  const out = []; window.__rvFlash = out; const t0 = performance.now();
  const alpha = c => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return 0; const p = m[1].split(/[\s,/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; };
  const bgAt = () => {
    let el = document.elementFromPoint(innerWidth / 2, innerHeight / 2) || document.body || document.documentElement;
    for (; el && el.nodeType === 1; el = el.parentElement) {
      const s = getComputedStyle(el);
      if (s.backgroundImage && s.backgroundImage !== 'none') return 'image';
      if (alpha(s.backgroundColor) > 0.5) return s.backgroundColor;
    }
    if (document.body) { // body background propagates to the canvas when <html> has none
      const s = getComputedStyle(document.body);
      if (s.backgroundImage && s.backgroundImage !== 'none') return 'image';
      if (alpha(s.backgroundColor) > 0.5) return s.backgroundColor;
    }
    return 'canvas';
  };
  const tick = () => { try { out.push([Math.round(performance.now() - t0), bgAt()]); } catch {} if (performance.now() - t0 < 1500) requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
}
function lumOf(c) { // canvas = default white page; image = unknown
  if (c === 'canvas') return 1; const p = U.parseColor(c); if (!p) return null;
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
}

async function flashTest(b, tool, run, a, bpg, w, h, mobile) {
  const tab = await b.newPage(tabOpts());
  try {
    await tab.setViewport({ width: w, height: h, mobile, deviceScaleFactor: 1, touch: mobile });
    await tab.emulateMedia({ colorScheme: 'light' });
    await tab.addInitScript(`(${FLASH_PROBE.toString()})()`);
    await politePause();
    const n1 = await tab.goto(a.url, { timeout: 45000 }); if (!n1.ok) return { from: a.pid, to: bpg.pid, error: n1.error };
    await U.sleep(600);
    let committed = null;
    const off = tab.on('Page.frameNavigated', p => { if (!p.frame.parentId && !committed) committed = Date.now(); });
    await politePause();
    const navP = tab.goto(bpg.url, { timeout: 45000 });
    const t0 = Date.now();
    while (!committed && Date.now() - t0 < 30000) await U.sleep(10);
    let flashFile = null, flash = null;
    if (committed) {
      const wait = 100 - (Date.now() - committed); if (wait > 0) await U.sleep(wait);
      const abs = join(run, 'measure', 'mobile', `flash-${safeName(a.pid)}-${safeName(bpg.pid)}-100ms.jpg`);
      await Promise.race([tab.screenshot({ path: abs, format: 'jpeg', quality: 50 }).catch(() => null), U.sleep(4000)]);
      if (existsSync(abs)) { flashFile = rel(run, abs); flash = await imageStats(tool, abs).catch(() => null); }
    }
    off();
    await navP; await U.sleep(1200);
    const finAbs = join(run, 'measure', 'mobile', `flash-${safeName(a.pid)}-${safeName(bpg.pid)}-final.jpg`);
    await tab.screenshot({ path: finAbs, format: 'jpeg', quality: 50 });
    const fin = await imageStats(tool, finAbs).catch(() => null);
    const timeline = (await tab.evaluate('window.__rvFlash || []').catch(() => [])).slice(0, 200);
    const lums = timeline.map(([t, c]) => [t, lumOf(c)]).filter(([, l]) => l !== null);
    let white = false, why = null, darkAfter = null;
    if (lums.length) {
      const first = lums[0][1], last = lums[lums.length - 1][1];
      if (first > 0.8 && last < 0.25) { white = true; why = 'light_first_frames_dark_page'; darkAfter = (lums.find(([, l]) => l < 0.25) || [null])[0]; }
    }
    if (!white && flash && fin) {
      if (fin.meanL < 50 && flash.whiteShare > 60) { white = true; why = 'dark_page_white_frame'; }
      else if (flash.whiteShare > 95 && fin.whiteShare < 50) { white = true; why = 'blank_white_frame'; }
    }
    const sample = timeline.filter((_, k) => k === 0 || timeline[k - 1][1] !== timeline[k][1]).slice(0, 8);
    return { from: a.pid, to: bpg.pid, w, h, committed: !!committed, frame_100ms: flashFile, final: rel(run, finAbs),
      white_100ms: flash ? flash.whiteShare : null, meanL_100ms: flash ? flash.meanL : null, white_final: fin ? fin.whiteShare : null, meanL_final: fin ? fin.meanL : null,
      bg_timeline: sample, dark_after_ms: darkAfter, white_flash: white, why,
      method: LANG === 'en' ? 'background under the screen centre on every frame of the new page (1.5 s) + a shot 100 ms after the document switch (Chromium)' : 'фон под центром экрана на каждом кадре новой страницы (1,5 с) + кадр через 100 мс после смены документа (Chromium)' };
  } finally { await tab.close(); }
}

// ---------- summary ----------
function spreadOf(vals) { const v = vals.filter(x => typeof x === 'number'); return v.length >= 2 ? Math.max(...v) - Math.min(...v) : null; }
function navHeadings(out) {
  const res = {};
  for (const key of ['390', '1440']) {
    const rows = out.items.map(i => ({ pid: i.pid, template: i.template, h: key === '390' ? i.touch && i.touch.heading : i.desktop && i.desktop.heading })).filter(r => r.h);
    const inner = rows.filter(r => r.pid !== 'home');
    const byT = {};
    for (const r of rows) (byT[r.template || 'other'] ||= []).push(r);
    const templates = Object.fromEntries(Object.entries(byT).filter(([, v]) => v.length >= 2).map(([k, v]) => [k, { spread: spreadOf(v.map(r => r.h.top)), pages: v.map(r => `${r.pid}:${r.h.tag}@${r.h.top}`) }]));
    res[key] = { pages: rows.map(r => ({ pid: r.pid, tag: r.h.tag, top: r.h.top, text: r.h.text })), spread_inner: spreadOf(inner.map(r => r.h.top)), by_template: templates,
      flag: (spreadOf(inner.map(r => r.h.top)) || 0) > 8 || Object.values(templates).some(t => (t.spread || 0) > 8) };
  }
  return res;
}

// width where the full menu appears: the burger is gone and ≥ 3 header links are visible (home page sweep)
function fullMenu(out) {
  const i = out.items.find(x => x.pid === out.home_pid) || out.items[0];
  if (!i) return null;
  const rows = [];
  const add = (w, nav) => { if (nav && !rows.some(r => r.w === w)) rows.push({ w, burger: !!nav.burger, links: nav.header_links || 0, top: nav.top_links ?? nav.header_links ?? 0 }); };
  add(390, i.touch?.nav_state);
  for (const s of i.touch?.sizes || []) add(s.w, s.nav);
  for (const s of i.desktop?.sizes || []) add(s.w, s.nav);
  add(1440, i.desktop?.nav_state);
  if (rows.length < 2) return null;
  rows.sort((a, b) => a.w - b.w);
  const withBurger = rows.filter(r => r.burger).map(r => r.w);
  const full = rows.filter(r => !r.burger && (r.links >= 3 || r.top >= 4)).map(r => r.w);
  const lastBurger = withBurger.length ? Math.max(...withBurger) : null;
  const from = full.find(w => lastBurger === null || w > lastBurger) ?? null;
  // neither a burger nor a menu: navigation is missing at this width
  const noNav = rows.filter(r => !r.burger && r.links < 3 && r.top < 3 && (lastBurger !== null || full.length)).map(r => r.w);
  return { pid: i.pid, full_menu_from_px: from, last_burger_px: lastBurger, no_nav_widths: noNav, widths: rows.map(r => `${r.w}:${r.burger ? 'burger' : r.links}`) };
}

function buildSummary(out) {
  const items = out.items.filter(i => i.touch);
  const ovf = [];
  for (const i of out.items) {
    const rows = [];
    if (i.touch && i.touch.overflow) rows.push({ w: 390, fresh: true, ...i.touch.overflow });
    if (i.desktop && i.desktop.overflow) rows.push({ w: 1440, fresh: true, ...i.desktop.overflow });
    for (const s of [...(i.touch?.sizes || []), ...(i.desktop?.sizes || [])]) rows.push({ w: s.w, h: s.h, fresh: false, confirmed: s.confirmed, ...s.overflow });
    // one line per page and width: the fresh load wins over the resize row of the same width
    for (const r of rows) {
      if (!(r.px > 0)) continue;
      const c = (r.culprits || []).find(x => !x.fixed);
      const row = { pid: i.pid, w: r.w, px: r.px, confirmed: r.fresh ? true : r.confirmed ?? null, culprit: c ? c.sel : null };
      const k = ovf.findIndex(o => o.pid === i.pid && o.w === r.w);
      if (k < 0) ovf.push(row); else if (ovf[k].confirmed !== true && row.confirmed === true) ovf[k] = row;
    }
  }
  const t = items.map(i => i.touch.targets).filter(Boolean);
  const d = out.items.map(i => i.desktop && i.desktop.targets).filter(Boolean);
  // CTA below the first screen vs no action button at all in the first three screens (the latter is product's topic)
  const laptopNoCta = []; const foldNoCta = []; const foldBrowser = []; const noCta390 = []; const noCta1440 = []; const laptopLost = []; let laptopCtaSeen = 0;
  for (const i of out.items) {
    if (i.touch && i.touch.fold) {
      const f = i.touch.fold;
      if (!f.cta) noCta390.push(i.pid); else if (!f.cta_in_fold) foldNoCta.push(i.pid);
      else if (f.cta.in_fold_browser === false) foldBrowser.push(i.pid); // within 844 but below Safari's visible 664
    }
    const deskCta = i.desktop && i.desktop.fold ? i.desktop.fold.cta : null;
    if (i.desktop && i.desktop.fold && !deskCta) noCta1440.push(i.pid);
    for (const s of (i.desktop?.sizes || [])) {
      if (!s.window || !s.fold || !s.fold.cta) continue;
      laptopCtaSeen++;
      if (s.fold.cta_in_fold) continue;
      laptopNoCta.push(`${i.pid}@${s.w}x${s.h}`);
      if (i.desktop.fold.cta_in_fold) laptopLost.push(`${i.pid}@${s.w}x${s.h}`);
    }
  }
  const tables = items.flatMap(i => (i.touch.tables || []).filter(t => t.state !== 'scrolls').map(t => ({ pid: i.pid, sel: t.sel, width: t.width, state: t.state })));
  const rescale = out.items.flatMap(i => (i.desktop?.rescale || []).map(r => `${i.pid}@${r.w}x${r.h}`));
  const heavy = items.filter(i => i.touch.weight && i.touch.weight.dom_nodes > 1500).map(i => ({ pid: i.pid, dom_nodes: i.touch.weight.dom_nodes, js_heap_mb: i.touch.weight.js_heap_mb ?? null }));
  // iOS starts autoplay from markup only with playsinline and the muted ATTRIBUTE
  const videoRisk = items.flatMap(i => (i.touch.video || []).filter(v => v.autoplay && (!v.playsinline || !(v.muted_attr ?? v.muted))).map(v => ({ pid: i.pid, sel: v.sel, playsinline: v.playsinline, muted: v.muted, muted_attr: v.muted_attr ?? null,
    why: [!v.playsinline ? 'no_playsinline' : null, !(v.muted_attr ?? v.muted) ? (v.muted ? 'muted_property_only' : 'not_muted') : null].filter(Boolean) })));
  // overflow that appears only while scrolling (animated stamps, marquees): wider than at rest
  const scrollOvf = items.filter(i => i.touch.anim_overflow && i.touch.anim_overflow.max_px > ((i.touch.overflow && i.touch.overflow.px) || 0) + 2)
    .map(i => ({ pid: i.pid, px: i.touch.anim_overflow.max_px, at_y: i.touch.anim_overflow.at_y, culprit: (i.touch.anim_overflow.culprits || []).find(c => !c.fixed)?.sel || null }));
  const clipped = [];
  for (const i of items) {
    for (const c of (i.touch.clipped?.items || [])) clipped.push({ pid: i.pid, w: 390, sel: c.sel, text: c.text, hidden_px: c.hidden_px, clip: c.clip_sel });
    if (!i.touch.clipped?.count) { // narrower phones only
      const row = (i.touch.sizes || []).filter(s => s.clipped).sort((a, b) => a.w - b.w)[0];
      for (const c of (row?.clipped_items || [])) clipped.push({ pid: i.pid, w: row.w, sel: c.sel, text: c.text, hidden_px: c.hidden_px, clip: c.clip_sel });
    }
  }
  const overlayFs = out.items.filter(i => i.touch?.overlay_fullscreen || i.desktop?.overlay_fullscreen)
    .map(i => { const o = i.touch?.overlay_fullscreen || i.desktop?.overlay_fullscreen; return { pid: i.pid, sel: o.sel, text: o.text, buttons: o.buttons || [] }; });
  const anchorsBad = (out.nav.anchors || []).filter(a => a.verdict !== 'ok' && a.verdict !== 'page_end');
  const flashes = (out.nav.flash || []).filter(f => f.white_flash);
  const viewportIssues = items.filter(i => i.touch.meta && (!i.touch.meta.viewport || !i.touch.meta.device_width || i.touch.meta.user_scalable_no || (i.touch.meta.max_scale && parseFloat(i.touch.meta.max_scale) < 2))).map(i => ({ pid: i.pid, viewport: i.touch.meta.viewport }));
  // burger: the first opened result at 390 (home or the fallback page), else what home gave
  const b390 = out.burger.filter(b => b.w === 390);
  const b0 = b390.find(b => b.found && b.opened) || b390.find(b => b.found) || b390[0] || out.burger[0] || null;
  const fm = fullMenu(out);
  const home = out.items.find(x => x.pid === out.home_pid);
  const tablets = (home?.touch?.tablets || []).map(r => ({ w: r.w, h: r.h, burger: r.nav ? r.nav.burger : null, header_links: r.nav ? r.nav.header_links : null, submenus: r.submenus ?? null,
    submenu_tap: r.submenu_tap ? (r.submenu_tap.skipped ? `skipped:${r.submenu_tap.skipped}` : r.submenu_tap.opened === true ? 'opened' : r.submenu_tap.opened === false ? 'not_opened' : 'refused') : null, error: r.error || undefined }));
  return {
    pages: out.items.length, pages_ok: items.length,
    overflow: ovf.slice(0, 40), overflow_pages: [...new Set(ovf.map(o => o.pid))],
    overflow_during_scroll: scrollOvf.slice(0, 10),
    clipped_content: clipped.slice(0, 15), clipped_pages: [...new Set(clipped.map(c => c.pid))],
    overlay_fullscreen: overlayFs,
    fold_no_cta_390: foldNoCta, fold_no_cta_390_browser: foldBrowser, no_cta_390: noCta390, no_cta_1440: noCta1440, laptop_no_cta: laptopNoCta.slice(0, 30), laptop_lost_cta: laptopLost.slice(0, 30), laptop_cta_rows: laptopCtaSeen,
    tables_390: tables.slice(0, 10), rescale_laptop: rescale.slice(0, 20), heavy_dom: heavy.slice(0, 10),
    motion: out.code && out.code.motion ? { transition_all: out.code.motion.transition_all, layout: out.code.motion.layout_transitions + out.code.motion.keyframes_layout, ease_in: out.code.motion.ease_in, long_ui: out.code.motion.long_ui, scale0: out.code.motion.keyframes_scale0 } : null,
    targets: { total: t.reduce((a, x) => a + x.total, 0), pointer: t.reduce((a, x) => a + (x.pointer || 0), 0), fail_24: t.reduce((a, x) => a + x.fail_24, 0), below_44: t.reduce((a, x) => a + x.below_44, 0),
      blocked_390: t.reduce((a, x) => a + x.blocked, 0), blocked_1440: d.reduce((a, x) => a + x.blocked, 0),
      invisible_cover: t.reduce((a, x) => a + x.invisible_cover, 0) + d.reduce((a, x) => a + x.invisible_cover, 0), ios_pe_none: t.reduce((a, x) => a + x.ios_pe_none, 0) },
    small_text_max: items.reduce((m, i) => Math.max(m, i.touch.text ? i.touch.text.lt12 : 0), 0),
    small_text_lt14_max: items.reduce((m, i) => Math.max(m, i.touch.text ? i.touch.text.lt14 : 0), 0),
    inputs_lt16: items.reduce((a, i) => a + (i.touch.text ? i.touch.text.inputs_lt16_count : 0), 0),
    sticky_max: { top: Math.max(0, ...items.map(i => i.touch.sticky_top?.share || 0)), scrolled: Math.max(0, ...items.map(i => i.touch.sticky_scrolled?.share || 0)),
      landscape: Math.max(0, ...items.map(i => i.touch.landscape?.sticky_share_scrolled || 0)), floating: Math.max(0, ...items.map(i => i.touch.sticky_scrolled?.floating || 0)) },
    burger: b0 ? { page: b0.pid, w: b0.w, found: b0.found, opened: b0.opened ?? null, reason: b0.reason || null, skipped: (b0.skipped || []).map(s => `${s.reason}: ${s.sel}`).slice(0, 3),
      fallback_for: b0.fallback_for || null, overlay_hidden: b0.overlay_hidden || null,
      tried: b390.map(b => `${b.pid}:${b.found ? (b.opened ? 'opened' : 'not_opened') : (b.reason || 'not_found')}`),
      background_scrolled: b0.lock ? b0.lock.background_scrolled ?? null : null, close: b0.close || null, items: b0.items_count ?? null,
      items_blocked: b0.items_blocked ?? null, toggle_zone: b0.toggle_zone ? [b0.toggle_zone.zone_w, b0.toggle_zone.zone_h] : null, ios_pe_none: (b0.items_ios_pe_none || 0) + (b0.toggle_ios_pe_none ? 1 : 0) } : null,
    full_menu_from_px: fm ? fm.full_menu_from_px : null, menu_widths: fm,
    tablets,
    hover_only: out.code ? { reveal: out.code.hover_only.reveal, transform: out.code.hover_only.transform } : null,
    vh100_rules: out.code ? out.code.vh100.rules : null,
    video_risk: videoRisk.slice(0, 10),
    safari: out.code ? out.code.safari.filter(s => s.level !== 'info').map(s => ({ id: s.id, level: s.level, min_ios: s.min_ios, first_party: s.first_party, guarded: s.guarded })) : null,
    viewport_issues: viewportIssues,
    nav: { heading_spread_390: out.nav.headings?.['390']?.spread_inner ?? null, heading_spread_1440: out.nav.headings?.['1440']?.spread_inner ?? null,
      heading_flag: !!(out.nav.headings?.['390']?.flag || out.nav.headings?.['1440']?.flag),
      anchors_tested: (out.nav.anchors || []).length, anchors_page_end: (out.nav.anchors || []).filter(a => a.verdict === 'page_end').length,
      anchors_bad: anchorsBad.map(a => ({ href: a.href, w: a.w, verdict: a.verdict })), white_flash: flashes.map(f => `${f.from}→${f.to}`) },
    retried: out.retried || [],
  };
}

function summaryLines(out, lang, outFile) {
  const L = T[lang]; const s = out.summary; const lines = [];
  lines.push(`${L.title}${out.partial ? ' — ' + (out.partial_reason === 'slot_wait' ? L.partialSlot : out.subset ? L.partialSubset : L.partial) : ''}`);
  lines.push(`${L.pages}: ${s.pages} (${cut(out.pages.join(', '), 120)}) · depth ${out.depth}${out.subset ? ' · subset' : ''}`);
  const ov = s.overflow;
  if (!ov.length) lines.push(`${L.overflow}: ${L.none}`);
  else {
    lines.push(`${L.overflow}: ${ov.length} (${s.overflow_pages.join(', ')})`);
    for (const o of ov.slice(0, 5)) lines.push(`  · ${o.pid} @${o.w}: +${o.px}px ${o.confirmed === true ? L.confirmed : o.confirmed === false ? L.resizeOnly : L.unconfirmed} ${o.culprit ? '← ' + cut(o.culprit, 70) : ''}`);
  }
  if (s.overflow_during_scroll.length) lines.push(`${L.scrollOverflow}: ${s.overflow_during_scroll.slice(0, 3).map(o => `${o.pid} +${o.px}px ${L.atY} ${o.at_y}${o.culprit ? ' ← ' + cut(o.culprit, 50) : ''}`).join('; ')}`);
  if (s.clipped_content.length) lines.push(`${L.clippedContent}: ${s.clipped_content.length} (${s.clipped_pages.join(', ')}) · ${s.clipped_content.slice(0, 2).map(c => `${c.pid}@${c.w} «${cut(c.text, 30)}» −${c.hidden_px}px`).join('; ')}`);
  if (s.overlay_fullscreen.length) lines.push(`${L.overlayFs}: ${s.overlay_fullscreen.map(o => `${o.pid} ${cut(o.sel, 40)}${o.text ? ` «${cut(o.text, 30)}»` : ''}`).join('; ')}`);
  // "ok" only where a main action exists at all
  const f390 = [];
  if (s.fold_no_cta_390.length) f390.push(`${L.below} ${s.fold_no_cta_390.join(', ')}`);
  if (s.fold_no_cta_390_browser.length) f390.push(`${L.foldBrowser} ${s.fold_no_cta_390_browser.join(', ')}`);
  if (s.no_cta_390.length) f390.push(`${L.noCta}: ${s.no_cta_390.join(', ')}`);
  if (!s.fold_no_cta_390.length && !s.fold_no_cta_390_browser.length && s.no_cta_390.length < s.pages_ok) f390.unshift('ok');
  lines.push(`${L.fold390}: ${f390.join(' · ') || '—'}`);
  const fl = [];
  if (s.laptop_no_cta.length) fl.push(`${L.below} ${s.laptop_no_cta.slice(0, 6).join(', ')}`);
  else if (s.laptop_cta_rows) fl.push('ok');
  if (s.laptop_lost_cta.length) fl.push(`${L.lostVs1440}: ${s.laptop_lost_cta.length}`);
  if (s.no_cta_1440.length) fl.push(`${L.noCta} (1440): ${s.no_cta_1440.join(', ')}`);
  if (s.rescale_laptop.length) fl.push(`${L.rescale}: ${s.rescale_laptop.slice(0, 4).join(', ')}`);
  lines.push(`${L.foldLaptop}: ${fl.join(' · ') || '—'}`);
  const tg = s.targets;
  lines.push(`${L.targets}: ${tg.total}${tg.pointer ? ` (cursor:pointer ${tg.pointer})` : ''} · ${L.fail24}: ${tg.fail_24} · ${L.below44}: ${tg.below_44}`);
  lines.push(`  ${L.blocked}: 390 — ${tg.blocked_390}, 1440 — ${tg.blocked_1440} (${L.invisible}: ${tg.invisible_cover}) · ${L.iosPe}: ${tg.ios_pe_none}`);
  lines.push(`${L.text}: <12px ${s.small_text_max}% · <14px ${s.small_text_lt14_max}% · ${L.inputs}: ${s.inputs_lt16}`);
  lines.push(`${L.sticky}: ${s.sticky_max.top}% → ${s.sticky_max.scrolled}% · ${L.landscape} ${s.sticky_max.landscape}%`);
  if (s.burger) {
    const bb = s.burger;
    const cl = bb.close ? ['escape', 'outside', 'close_button', 'toggle'].filter(k => bb.close[k] === true).join('/') : '';
    let st;
    if (!bb.found) st = bb.reason === 'link' ? `${L.notFound} (${L.burgerLink})` : L.notFound;
    else if (bb.opened) st = `${L.opens}, ${L.items} ${bb.items}, ${bb.background_scrolled ? L.noLock : bb.background_scrolled === false ? L.lock : '?'}${cl ? `, ${L.closes}: ${cl}` : ''}${bb.items_blocked ? `, ${L.blocked}: ${bb.items_blocked}` : ''}${bb.ios_pe_none ? `, ${L.iosPe}: ${bb.ios_pe_none}` : ''}`;
    else st = L.notOpens;
    const extra = [];
    if (bb.page && (bb.fallback_for || bb.page !== out.home_pid)) extra.push(`${L.fallback} ${bb.page}`);
    if (bb.skipped.length) extra.push(`${L.burgerSkipped}: ${bb.skipped.length}`);
    if (!bb.opened && bb.tried.length > 1) extra.push(bb.tried.join(', '));
    if (s.full_menu_from_px) extra.push(`${L.fullMenu} ${s.full_menu_from_px}px`);
    lines.push(`${L.burger}: ${st}${extra.length ? ' · ' + extra.join(' · ') : ''}`);
  }
  if (s.tablets.length) lines.push(`${L.tablets}: ${s.tablets.map(t => `${t.w}×${t.h} ${t.burger ? 'burger' : `links ${t.header_links ?? '—'}`}${t.submenu_tap ? `, ${L.submenuTap}: ${t.submenu_tap === 'opened' ? L.opensTap : t.submenu_tap === 'not_opened' ? L.notOpensTap : /link_parent/.test(t.submenu_tap) ? L.linkParent : t.submenu_tap}` : ''}`).join('; ')}`);
  if (s.hover_only) lines.push(`${L.hover}: ${L.reveal} ${s.hover_only.reveal}, ${L.stick} ${s.hover_only.transform} · ${L.vh}: ${s.vh100_rules}`);
  if (s.video_risk.length) lines.push(`${L.video}: ${s.video_risk.length} (${[...new Set(s.video_risk.flatMap(v => v.why))].map(w => w === 'no_playsinline' ? L.noPlaysinline : w === 'muted_property_only' ? L.mutedProp : w).join(', ')})`);
  if (s.tables_390.length) lines.push(`${L.tables}: ${s.tables_390.slice(0, 4).map(t => `${t.pid} ${t.width}px ${t.state === 'clipped' ? L.clipped : L.pageOverflow}`).join('; ')}`);
  if (s.heavy_dom.length) lines.push(`${L.heavy}: ${s.heavy_dom.slice(0, 4).map(h => `${h.pid} ${h.dom_nodes}${h.js_heap_mb ? ` / ${h.js_heap_mb} MB` : ''}`).join('; ')}`);
  if (s.motion) lines.push(`${L.motion}: transition: all ${s.motion.transition_all}, ${L.layoutAnim} ${s.motion.layout}, ease-in ${s.motion.ease_in}, ${L.longUi} ${s.motion.long_ui}, scale(0) ${s.motion.scale0}`);
  if (s.viewport_issues.length) lines.push(`${L.viewport}: ${s.viewport_issues.map(v => `${v.pid} «${cut(String(v.viewport), 50)}»`).join('; ')}`);
  if (out.code && out.code.safari.length) {
    lines.push(`${L.safari}: ${out.code.safari.length}`);
    for (const r of out.code.safari.filter(r => r.level !== 'info' && r.level !== 'harmless').slice(0, 6)) lines.push(`  · [${r.level}] ${cut(r.what, 80)}${r.min_ios ? ` (iOS ${r.min_ios}+)` : ''}${r.first_party ? '' : ` · ${L.thirdParty}`}${r.guarded ? ` · ${L.guarded}` : ''}`);
  }
  const n = s.nav;
  if (out.nav.headings || out.nav.anchors || out.nav.flash) lines.push(`${L.nav}: ${L.spread} 390 ${n.heading_spread_390 ?? '—'}px / 1440 ${n.heading_spread_1440 ?? '—'}px · ${L.anchors} ${n.anchors_tested - n.anchors_bad.length}/${n.anchors_tested} ok${n.anchors_page_end ? ` (${n.anchors_page_end} ${L.pageEnd})` : ''} · ${L.flash}: ${n.white_flash.length ? n.white_flash.join(', ') : L.none}`);
  else lines.push(`${L.nav}: ${L.notChecked.toLowerCase()}`);
  for (const a of n.anchors_bad.slice(0, 3)) lines.push(`  · ${a.verdict} @${a.w}: ${cut(a.href, 90)}`);
  if (s.retried.length) lines.push(`${L.retried}: ${s.retried.slice(0, 5).join(', ')}`);
  if (out.errors.length) lines.push(`${L.errors}: ${out.errors.length} — ${out.errors.slice(0, 3).map(e => `${e.pid}: ${cut(String(e.error), 60)}`).join('; ')}`);
  if (out.not_checked.length) lines.push(`${L.notChecked}: ${cut(out.not_checked.slice(0, 4).join('; '), 300)}`);
  lines.push(`${L.written}: ${outFile}`);
  // keep within 40 lines: the last line (where it is written) always stays
  return lines.length > 40 ? [...lines.slice(0, 39), lines[lines.length - 1]] : lines;
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

  let pages, pagesDoc = null;
  if (existsSync(join(run, 'pages.json'))) { pagesDoc = U.readJSON(join(run, 'pages.json'), {}); pages = U.loadPages(run, args); }
  else if (args.url && args.url !== true) { pages = [{ pid: 'home', url: U.normalizeUrl(args.url), template: 'home' }]; }
  else { console.error(lang === 'en' ? 'No pages.json and no --url.' : 'Нет pages.json и не задан --url.'); process.exit(2); }
  pages = pages.filter(p => p && p.url && !p.blocked);
  if (!pages.length) { console.error(lang === 'en' ? 'No pages to check.' : 'Нет страниц для проверки.'); process.exit(2); }
  for (const p of pages) { const h = U.hostOf(p.url); if (isLocalHost(h)) U.allowPrivateHost(h); }
  const pidFilter = U.listArg(args.pages);

  const brief = U.loadBrief(run);
  const state = U.readJSON(join(run, 'state.json'), {});
  const depth = ['lite', 'standard', 'deep'].includes(args.depth) ? args.depth : (brief.depth || state.flags?.depth || 'standard');
  const P = plan(depth);
  const ALL_CHECKS = ['sizes', 'targets', 'burger', 'code', 'nav', 'landscape'];
  const checksArg = U.listArg(args.checks);
  const checks = new Set(checksArg.length ? checksArg : ALL_CHECKS);
  // --widths 360 or 360x700: width → height (null = the standard height for this width)
  let only = null;
  const widthsArg = U.listArg(args.widths);
  if (widthsArg.length) {
    only = new Map();
    for (const s of widthsArg) { const [ws, hs] = s.toLowerCase().split('x'); const w = Number(ws), h = Number(hs) || null; if (w >= 200 && w <= 4000) only.set(w, h); }
    if (!only.size) { console.error(lang === 'en' ? 'Bad --widths (example: 360,1366x657).' : 'Неверный --widths (пример: 360,1366x657).'); process.exit(2); }
    for (const [w, h] of only) {
      if (TABLET_SIZES.some(([tw, th]) => tw === w && th === h)) { if (!P.tablet.some(([tw, th]) => tw === w && th === h)) P.tablet.push([w, h]); continue; }
      if (w < 1024) { TOUCH_SIZES[w] = h || TOUCH_SIZES[w] || 800; if (!P.touch.includes(w)) P.touch.push(w); }
      else if (h ? !P.desk.some(([dw, dh]) => dw === w && dh === h) : !P.desk.some(([dw]) => dw === w)) P.desk.push([w, h || 900]);
    }
    P.touch.sort((a, b) => a - b);
  }
  // --pages alone filters the main file (pipeline, resume); --subset, --widths, --checks write a separate file
  const subset = !!(args.subset || only || checksArg.length);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const outFile = join(run, 'measure', subset ? `mobile.subset-${stamp}.json` : 'mobile.json');
  // a subset never overwrites the shared summary other agents read first
  const stdoutFile = join(run, 'stdout', subset ? `${NAME}.subset-${stamp}.md` : `${NAME}.md`);
  U.ensureDir(join(run, 'measure', 'mobile'));
  // the site's home comes from pages.json, not from the filtered list: a filter without it must not move the burger
  const allSel = (pagesDoc && Array.isArray(pagesDoc.selected) && pagesDoc.selected.length) ? pagesDoc.selected : pages;
  const realHome = allSel.find(p => p.pid === 'home') || allSel[0] || pages[0];
  const home = pages.find(p => p.pid === realHome.pid) || pages[0];
  const pidSet = new Set(pages.map(p => p.pid));

  // resume a partial main file; a finished one + --pages: re-measure these pages, keep the others
  let out = null, mergeNote = null;
  if (!subset && !args.fresh && existsSync(outFile)) {
    const prev = U.readJSON(outFile, null);
    if (prev && prev.tool === NAME && Array.isArray(prev.items)) {
      if (prev.partial && prev.resume && Array.isArray(prev.resume.done)) out = prev;
      else if (pidFilter.length) {
        out = prev; mergeNote = true;
        const keepDone = (prev.done || []).filter(u => !(u.startsWith('page:') && pidSet.has(u.slice(5))) && !(u === 'burger' && pidSet.has(realHome.pid)) && !(u.startsWith('nav:') && pages.length >= 2));
        out.resume = { done: keepDone };
        out.errors = (out.errors || []).filter(e => !pidSet.has(e.pid));
        out.not_checked = (out.not_checked || []).filter(x => ![...pidSet].some(pid => String(x).startsWith(pid + ':')));
        out.attempts = {};
      }
    }
  }
  if (!out) {
    out = { ...U.measureHeader(NAME, run), partial: false, resume: null, depth, plan: { touch: P.touch, desktop: P.desk.map(([w, h]) => `${w}x${h}`), tablet: P.tablet.map(([w, h]) => `${w}x${h}`), laptop_windows: [...LAPTOP_WINDOWS].filter(k => P.desk.some(([w, h]) => `${w}x${h}` === k)) },
      norms: lang === 'en'
        ? { target_aa: '24×24 CSS px (WCAG 2.2 SC 2.5.8, AA); a target smaller than 24 × 24 passes if a circle of 24 px diameter around its centre does not touch other targets or their circles', target_comfort: '44×44 (Apple HIG, WCAG 2.5.5 AAA); Material — 48', text: 'share of characters < 12/14/16 px', input_ios_zoom: 'iOS zooms the page on focus of an input < 16 px', anchor_corridor: 'target top −5…220 px after 5 s; near the page end — page_end', browser_fold: 'iPhone Safari shows ~664 of 844 px (toolbars)' }
        : { target_aa: '24×24 CSS px (WCAG 2.2 SC 2.5.8, AA); цель мельче 24 × 24 проходит, если круг диаметром 24 px вокруг её центра не задевает соседние цели и их круги', target_comfort: '44×44 (Apple HIG, WCAG 2.5.5 AAA); Material — 48', text: 'доля знаков < 12/14/16 px', input_ios_zoom: 'iOS увеличивает страницу при фокусе на поле < 16 px', anchor_corridor: 'top цели −5…220 px через 5 с; у конца страницы — page_end', browser_fold: 'Safari на iPhone показывает ~664 из 844 px (панели браузера)' },
      method: lang === 'en'
        ? 'headless Chromium via CDP: mobile emulation (Android Chrome UA, touch, DPR 2), real taps via Input.dispatchTouchEvent after hitInfo, elementFromPoint in an isolated world; Safari/iOS — from code, no WebKit'
        : 'headless Chromium через CDP: мобильная эмуляция (Android Chrome UA, touch, DPR 2), реальные касания Input.dispatchTouchEvent после hitInfo, elementFromPoint в изолированном мире; Safari/iOS — по коду, без WebKit',
      items: [], burger: [], code_files: {}, code: null, nav: {}, done: [], attempts: {}, retried: [] };
    out.resume = { done: [] };
  }
  out.attempts ||= {}; out.retried ||= [];
  if (subset) out.subset = { pages: pidFilter, widths: widthsArg, checks: checksArg };
  if (!mergeNote || pidSet.has(realHome.pid) || !out.home_pid) out.home_pid = home.pid;
  const done = new Set(out.resume.done || []);
  const L = T[lang];

  const mainAction = brief.site?.main_action || '';
  const keyRe = /(price|prices|pricing|tarif|ceny|tseny|stoimost|uslug|services|catalog|katalog|product|kontakt|contact)/i;
  const landscapePids = ['home', ...pages.filter(p => p.pid !== 'home' && keyRe.test(`${p.template || ''} ${p.url} ${p.why || ''}`)).map(p => p.pid), ...pages.map(p => p.pid)];
  const landscapeSet = new Set([...new Set(landscapePids)].filter(pid => pages.some(p => p.pid === pid)).slice(0, P.landscapePages));
  const ctx = { run, P, checks, only, mainAction, out, lang, landscapeSet, navLists: pagesDoc?.nav_lists || null, homePid: out.home_pid };

  const units = [];
  units.push(`page:${home.pid}`);
  if (checks.has('burger')) units.push('burger');
  for (const p of pages) if (p !== home) units.push(`page:${p.pid}`);
  if (checks.has('nav') && (!subset || checksArg.includes('nav'))) units.push('nav:anchors', 'nav:flash');

  const est = { page: 35000, burger: 30000, 'nav:anchors': 45000, 'nav:flash': 25000 };
  const durations = [];
  let releaseSlot = null, b = null, tool = null, progressed = 0;
  const writeOut = (partial) => {
    out.partial = partial; out.resume = partial ? { done: [...done] } : null; out.done = [...done];
    out.generated = U.nowIso(); out.pages = out.items.map(i => i.pid);
    out.summary = buildSummary(out);
    U.writeJSON(outFile, out);
  };

  // one unit; returns true when it failed (a retry may help: load timeout, crashed tab)
  const runUnit = async (unit, attempt) => {
    const kind = unit.startsWith('page:') ? 'page' : unit;
    const err = (pid, error) => out.errors.push({ pid, unit, attempt, error });
    let failed = false;
    if (kind === 'page') {
      const pg = pages.find(p => `page:${p.pid}` === unit);
      const item = { pid: pg.pid, url: pg.url, template: pg.template || null };
      try {
        const tr = await measureTouchLoad(b, tool, pg, ctx);
        item.touch = tr.res; if (tr.blocked) { item.blocked = tr.blocked; out.not_checked.push(`${pg.pid}: ${tr.blocked}`); }
      } catch (e) { failed = true; err(pg.pid, 'touch: ' + e.message.slice(0, 200)); }
      if (!item.blocked && (checks.has('sizes') || checks.has('targets') || checks.has('nav'))) {
        try { item.desktop = await measureDesktopLoad(b, pg, ctx); } catch (e) { failed = true; err(pg.pid, 'desktop: ' + e.message.slice(0, 200)); }
      }
      if (item.touch?.overlay_fullscreen || item.desktop?.overlay_fullscreen) {
        const o = item.touch?.overlay_fullscreen || item.desktop?.overlay_fullscreen;
        out.not_checked.push(lang === 'en'
          ? `${pg.pid}: full-screen splash ${o.sel} hidden; the first screen and all measurements are taken after it (what a visitor sees first — snapshot shot)`
          : `${pg.pid}: полноэкранная заставка ${o.sel} скрыта; первый экран и все замеры — после неё (что посетитель видит сначала — кадр snapshot)`);
      }
      // confirm overflow found on resize with a fresh load
      if (!item.blocked && checks.has('sizes')) {
        const rows = [...(item.touch?.sizes || []), ...(item.desktop?.sizes || [])].filter(r => r.overflow && r.overflow.px > 0);
        rows.sort((x, y) => CONFIRM_ORDER.indexOf(x.w) - CONFIRM_ORDER.indexOf(y.w));
        for (const r of rows.slice(0, P.confirmMax)) {
          try { const c = await confirmOverflow(b, pg, r.w, r.h, r.mode === 'touch'); r.confirmed = !c.error && c.px > 0; r.confirm = c; } catch (e) { r.confirm = { error: e.message.slice(0, 100) }; }
        }
      }
      const idx = out.items.findIndex(i => i.pid === item.pid);
      if (idx >= 0) out.items[idx] = item; else out.items.push(item);
    } else if (unit === 'burger') {
      const targets = [[home, 390, 844], [home, 834, 1194]];
      if (P.burgerPerTemplate) { const seenT = new Set([home.template]); for (const p of pages) if (p !== home && p.template && !seenT.has(p.template)) { seenT.add(p.template); targets.push([p, 390, 844]); } }
      out.burger = [];
      for (const [pg, w, h] of targets) {
        if (only && !only.has(w)) continue;
        try { const r = await burgerTest(b, pg, w, h, ctx); if (w !== 390 && !r.found) continue; out.burger.push(r); }
        catch (e) { failed = true; err(pg.pid, `burger@${w}: ` + e.message.slice(0, 200)); }
      }
      // no burger / not opened / candidates were links on home: one more page (another template first)
      const h390 = out.burger.find(r => r.pid === home.pid && r.w === 390);
      if ((!only || only.has(390)) && (!h390 || !h390.found || !h390.opened)) {
        const alt = pages.find(p => p !== home && p.template && p.template !== home.template && !out.burger.some(r => r.pid === p.pid)) || pages.find(p => p !== home && !out.burger.some(r => r.pid === p.pid));
        if (alt) {
          try { const r = await burgerTest(b, alt, 390, 844, ctx); r.fallback_for = home.pid; out.burger.push(r); }
          catch (e) { err(alt.pid, 'burger@390 (fallback): ' + e.message.slice(0, 200)); }
        }
      }
    } else if (unit === 'nav:anchors') {
      const cands = [];
      for (const i of out.items) for (const a of (i.touch?.anchors_out || [])) if (!cands.some(c => c.href === a.href)) cands.push({ ...a, from: i.pid });
      cands.sort((x, y) => (y.in_nav - x.in_nav));
      const pickA = []; const seenPath = new Set();
      for (const c of cands) { const p = c.href.split('#')[0]; if (seenPath.has(p) && cands.length > P.anchors) continue; if (U.isRiskyGet(c.href)) continue; seenPath.add(p); pickA.push(c); if (pickA.length >= P.anchors) break; }
      out.nav.anchors = [];
      for (const a of pickA) {
        for (const [w, h, m] of [[390, 844, true], [1440, 900, false]]) {
          try { out.nav.anchors.push({ ...(await anchorTest(b, a.href, w, h, m)), text: a.text, from: a.from }); }
          catch (e) { err(a.from, `anchor ${a.href}: ` + e.message.slice(0, 150)); }
        }
      }
      if (!pickA.length) out.not_checked.push(lang === 'en' ? 'cross-page anchors: none found' : 'якоря на другие страницы: ссылок не нашли');
    } else if (unit === 'nav:flash') {
      out.nav.flash = [];
      const okPages = pages.filter(p => out.items.some(i => i.pid === p.pid && i.touch && !i.blocked));
      const pairs = [];
      for (let k = 0; k + 1 < okPages.length && pairs.length < P.flashes; k++) pairs.push([okPages[k], okPages[k + 1]]);
      for (const [a, c] of pairs) {
        try { out.nav.flash.push(await flashTest(b, tool, run, a, c, 390, 844, true)); }
        catch (e) { err(a.pid, 'flash: ' + e.message.slice(0, 150)); }
      }
      if (!pairs.length) out.not_checked.push(lang === 'en' ? 'white flash: needs 2+ pages' : 'белая вспышка: нужно 2+ страниц');
    }
    return failed;
  };

  let partial = false, slotBusy = false;
  try {
    // wait for a browser only within the budget; no slot -> partial + 75 (slot_wait), the same call continues
    delete out.partial_reason; delete out.slot_wait_sec; out.not_checked = (out.not_checked || []).filter(x => !/slot_wait/.test(String(x)));
    const tw = Date.now();
    try { releaseSlot = await U.acquireBrowserSlot({ waitMs: Math.max(5000, budgetMs - (Date.now() - T0) - 15000) }); }
    catch (e) {
      if (e.code !== 'SLOT_TIMEOUT') throw e;
      slotBusy = true; out.slot_wait_sec = Math.round((Date.now() - tw) / 1000); out.partial_reason = 'slot_wait';
      out.not_checked.push(lang === 'en' ? `browser busy with other checks (slot_wait, waited ${out.slot_wait_sec} s) — repeat the call` : `браузер занят другими проверками (slot_wait, ждали ${out.slot_wait_sec} с) — повторите вызов`);
      U.log(run, `mobile: ждал свободный браузер ${out.slot_wait_sec} с, не дождался (slot_wait)`);
      throw e;
    }
    b = await Browser.launch();
    tool = await b.newPage({ blockNavigation: true });
    U.log(run, `mobile: старт, страниц ${pages.length}, depth ${depth}${subset ? ', subset' : pidFilter.length ? ', фильтр --pages' : ''}${ALLOW_POSTS ? ', allow-load-posts' : ''}`);
    // pass 1 — all units; pass 2 — units that failed once (a second failure is final)
    let queue = units.filter(u => !done.has(u));
    for (let pass = 1; pass <= 2 && queue.length && !partial; pass++) {
      const retry = [];
      for (const unit of queue) {
        const kind = unit.startsWith('page:') ? 'page' : unit;
        const avg = durations.length ? durations.reduce((a, x) => a + x, 0) / durations.length : est[kind];
        const need = kind === 'page' ? Math.max(avg, 15000) : est[kind];
        if (progressed > 0 && Date.now() - T0 + need * 1.15 > budgetMs - 8000) { partial = true; break; }
        const t1 = Date.now();
        U.progress(`mobile: ${unit}${pass > 1 ? ' (retry)' : ''}`);
        const attempt = (out.attempts[unit] || 0) + 1; out.attempts[unit] = attempt;
        let failed;
        try { failed = await runUnit(unit, attempt); } catch (e) { failed = true; out.errors.push({ pid: unit, unit, attempt, error: e.message.slice(0, 200) }); }
        if (failed && attempt < 2) retry.push(unit);
        else {
          done.add(unit);
          if (!failed && attempt > 1) { out.errors = out.errors.filter(e => e.unit !== unit); if (!out.retried.includes(unit)) out.retried.push(unit); }
        }
        if (kind === 'page') durations.push(Date.now() - t1);
        progressed++;
        if (b.closed) { // a crashed browser takes the next units down with it: start a fresh one
          U.progress('mobile: browser crashed, relaunching');
          try { await b.close(); } catch {}
          b = await Browser.launch(); tool = await b.newPage({ blockNavigation: true });
        }
        if (!subset) writeOut(true);
      }
      queue = retry;
    }
    if (checks.has('nav')) out.nav.headings = navHeadings(out);
    if (checks.has('code')) aggregateCode(out, lang);
    if (!out.not_checked.some(x => /Safari|WebKit/.test(x))) out.not_checked.push(lang === 'en'
      ? 'real Safari/WebKit, Firefox and Yandex Browser: not run (Chromium only); iOS risks are estimated from code — check on a device'
      : 'настоящий Safari/WebKit, Firefox и Яндекс Браузер не запускали (только Chromium); риски iOS — оценка по коду, проверить на устройстве');
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
    if (releaseSlot) releaseSlot();
  }
  writeOut(partial);
  const lines = summaryLines(out, lang, rel(run, outFile) + (subset ? ' · ' + rel(run, stdoutFile) : ''));
  U.writeText(stdoutFile, lines.join('\n') + '\n');
  U.printSummary(lines);
  U.log(run, `mobile: ${partial ? 'частично' : 'готово'} за ${Math.round((Date.now() - T0) / 1000)} с, страниц ${out.items.length}`);
  process.exitCode = partial ? 75 : 0;
}

main().catch(e => { console.error(e?.stack || e); process.exitCode = 1; });
