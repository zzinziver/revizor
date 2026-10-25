#!/usr/bin/env node
// Revizor — rivals: snapshot of competitor sites into RUN/rivals/<host>/ and the "N of M" summary.
// --light (inside /revizor:full): home page only, fold + chunks + full at 390 and 1440, short facts.
// full (/revizor:rivals): home + up to 3 section pages (prices, services, about, contacts…), meta, H1–H3, JSON-LD, stack, CTA and
// their frequency, forms, trackers (attempts — they are blocked), weight and LCP, sitemap by template, text.md.
// --summarize: "у N из M" over card.json → facts (written by rival-analyst), M = sites where the fact was checked (null = not checked).
// Only GET, counters/chats/call-tracking blocked, nothing is clicked, captchas are not solved: a closed site is recorded and skipped.

import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import * as U from './lib/util.mjs';
import * as IMG from './lib/img.mjs';
import { Browser } from './lib/cdp.mjs';

const HELP = `
rivals.mjs — снимок сайтов конкурентов и свод «у N из M»

  node rivals.mjs --run "<RUN>" --urls "https://a.ru,https://b.ru" [--light] [--ours <наш адрес>] [--pages 3]
                  [--widths 1440,390] [--redo] [--budget-sec 480] [--lang ru|en]
  node rivals.mjs --run "<RUN>" --urls-file rivals-urls.json [--light] …   адреса из JSON (["https://…"] или { "urls": [...] },
                  путь от RUN или абсолютный) — сырые адреса не попадают в командную строку; можно вместе с --urls
  node rivals.mjs --run "<RUN>" --summarize [--ours <наш адрес>] [--lang ru|en]

Снимок → RUN/rivals/<хост>/ (хост в punycode без www, порт через «_»):
  capture.json   факты со страниц: meta, H1–H3, JSON-LD, CTA и их частота, формы, контакты, трекеры (попытки — они заблокированы),
                 шрифты, цвета, вес и LCP (лаборатория), стек, sitemap по шаблонам; facts_auto — заготовка для card.json
                 (cta_header, forms, pages_by_template, stack — "unknown", если признаков нет, lcp_mobile, home_screens_390,
                 lead_mechanic, legal_entity_visible), hints — подсказки (цены из текста, текст первого экрана);
                 complete: true — снимок полный; attempts/errors — сбои (после 2 сбоев сайт записан как blocked: "error")
  rivals.json    status: complete | partial (complete — у всех запрошенных сайтов полный снимок, закрытые и сбойные считаются),
                 incomplete — какие ещё нет; sites[хост] { url, status: done|blocked|error|partial|todo, complete, mode }
  shots/         <pid>-<ширина>-fold.jpg (первый экран как есть, с cookie-баннером), <pid>-<ширина>.part-NN.jpg (куски без
                 баннеров), <pid>-<ширина>-full.jpg (если ≤ 8000 px), index.json [{ file, pid, width, y0, y1, scale, kind }]
  text.md        видимый текст главной; text-<pid>.md — других страниц (для проверки цитат карточек)
--light       только главная (fold + куски 390 и 1440), без страниц разделов и sitemap — для /revizor:full.
По умолчанию — главная + до --pages страниц разделов (цены, услуги/каталог, о компании, контакты, кейсы) с той же главной,
robots.txt учитывается для страниц разделов. Сайт под защитой от ботов, паролем или недоступный — запись причины, дальше без него.
Карточку card.json пишет агент rival-analyst. Готовый снимок без --redo не переснимается (лёгкий дополняется до полного).

--summarize   свод по rivals/<хост>/card.json → facts (если карточки нет — по facts_auto из capture.json, с пометкой источника):
              для каждого факта «у N из M» (M — сайты, где факт проверен: null = не проверено, false = проверено, нет;
              текст "unknown" — проверено, нет), частые значения; для чисел — только «замерено у M», медиана и разброс;
              отдельной строкой — наш сайт; группы — по полю card.group (если есть).
              Пишет RUN/rivals/summary.json.
Наш сайт: --ours, иначе адрес прогона (state.json / pages.json). В «у N из M» он не входит.
Шаг снимка выполнен, только когда rivals.json → status = "complete" (не по наличию папки сайта).
Коды: 0 — готово, 75 — не уложился в бюджет или браузеры заняты (повторите ту же команду; ожидание свободного браузера,
до 10 мин, в --budget-sec не входит), 2 — ошибка аргументов/окружения, 1 — сбой.
`;

const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'light', 'summarize', 'redo'] });
U.helpAndExit(HELP, args);
const lang = U.langOf(args);
const T = (ru, en) => (lang === 'en' ? en : ru);
const fail = (code, ru, en) => { console.error(T(ru, en)); process.exit(code); };
const run = U.requireRun(args);
const budgetSec = Number(args['budget-sec']) > 0 ? Number(args['budget-sec']) : 480;
const T0 = Date.now();
let deadline = T0 + budgetSec * 1000; // restarted once a browser slot is taken: waiting for it is not part of the budget
const secLeft = () => (deadline - Date.now()) / 1000;
const readOpt = p => (existsSync(p) ? U.readJSON(p, null) : null);
const fwd = p => String(p).replace(/\\/g, '/');
const str = v => (v === undefined || v === null || v === true ? null : String(v));
const state = readOpt(join(run, 'state.json')) || {};
const pagesDoc = readOpt(join(run, 'pages.json'));
const oursUrl = (() => { const v = str(args.ours) || state.flags?.url || pagesDoc?.site || null; try { return v ? U.normalizeUrl(v) : null; } catch { return null; } })();
const oursKey = oursUrl ? U.hostKey(oursUrl) : null;
const RIVALS = U.insideRun(run, 'rivals');

// ---------- in-page helpers (self-contained) ----------
const VITALS_INIT = `(() => { try {
  window.__rvVitals = { lcp: null, cls: 0, fcp: null };
  new PerformanceObserver(l => { for (const e of l.getEntries()) window.__rvVitals.lcp = Math.round(e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__rvVitals.cls += e.value; }).observe({ type: 'layout-shift', buffered: true });
  new PerformanceObserver(l => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') window.__rvVitals.fcp = Math.round(e.startTime); }).observe({ type: 'paint', buffered: true });
} catch (e) {} })();`;

// fixed/sticky layers: cookie banner, "your city?", auto-opened modals (classified as in snapshot)
function inPageLayers() {
  const vw = document.documentElement.clientWidth || innerWidth, vh = innerHeight;
  const all = document.body ? document.body.getElementsByTagName('*') : [];
  const fx = [];
  for (const el of all) { const p = getComputedStyle(el).position; if (p === 'fixed' || p === 'sticky') fx.push(el); }
  const outer = fx.filter(el => !fx.some(o => o !== el && o.contains(el)));
  const bodyText = (document.body?.innerText || '').length || 1;
  const out = [];
  outer.forEach((el, i) => {
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
    const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const share = visible ? Math.round(1000 * iw * ih / (vw * vh)) / 10 : 0;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const sig = [el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('role'), el.getAttribute('aria-label')].join(' ').toLowerCase();
    let kind = null;
    if (share > 0 && text.length < 2500 && (/cookie|куки|кук[иа]м?\b|consent|gdpr|согласие на (использование|обработку) (файлов|cookie)|используем (файлы )?cookie/i.test(text) || /cookie|consent|gdpr/.test(sig))) kind = 'cookie';
    else if (share > 0 && text.length < 600 && /ваш город|выберите (ваш )?город|ваш регион|город определ|определили (ваш )?город|your (city|region|location)/i.test(text)) kind = 'city';
    else if (share >= 25 && cs.position === 'fixed' && text.length / bodyText < 0.5 && !/^(header|nav|main)$/i.test(el.tagName)
      && (el.getAttribute('role') === 'dialog' || el.getAttribute('aria-modal') === 'true' || /modal|popup|pop-up|overlay|lightbox|dialog|subscribe|t-popup|fancybox/.test(sig))) kind = 'modal';
    el.setAttribute('data-rv-layer', String(i));
    out.push({ i, kind, position: cs.position, share_top: share, text: text.slice(0, kind ? 200 : 60) });
  });
  return out;
}
function inPageFreeze(hideIdx) {
  const save = el => { if (!el.hasAttribute('data-rv-style')) el.setAttribute('data-rv-style', el.hasAttribute('style') ? el.getAttribute('style') : '\u0000'); };
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  for (const el of document.querySelectorAll('[data-rv-layer]')) if (hideIdx.includes(Number(el.getAttribute('data-rv-layer')))) { save(el); el.style.setProperty('display', 'none', 'important'); }
  const fx = (document.body ? [...document.body.getElementsByTagName('*')] : []).filter(el => { const p = getComputedStyle(el).position; return p === 'fixed' || p === 'sticky'; });
  for (const el of fx) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    save(el);
    if (cs.position === 'sticky') { el.style.setProperty('position', 'relative', 'important'); for (const k of ['top', 'bottom', 'left', 'right']) el.style.setProperty(k, 'auto', 'important'); continue; }
    el.style.setProperty('position', 'absolute', 'important');
    el.style.setProperty('top', '0px', 'important'); el.style.setProperty('left', '0px', 'important');
    el.style.setProperty('bottom', 'auto', 'important'); el.style.setProperty('right', 'auto', 'important');
    el.style.setProperty('width', r.width + 'px', 'important');
    if (r.height >= innerHeight - 1) el.style.setProperty('height', r.height + 'px', 'important');
    const r2 = el.getBoundingClientRect();
    el.style.setProperty('top', (r.top - r2.top) + 'px', 'important');
    el.style.setProperty('left', (r.left - r2.left) + 'px', 'important');
  }
  return true;
}
function inPageRestore() {
  for (const el of document.querySelectorAll('[data-rv-style]')) { const s = el.getAttribute('data-rv-style'); if (s === '\u0000') el.removeAttribute('style'); else el.setAttribute('style', s); el.removeAttribute('data-rv-style'); }
  for (const el of document.querySelectorAll('[data-rv-layer]')) el.removeAttribute('data-rv-layer');
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  return true;
}
async function inPageSlowScroll(cap) {
  const step = Math.max(200, Math.round(innerHeight * 0.6));
  const H = () => Math.min(Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), cap);
  let y = 0, guard = 0;
  while (y < H() && guard++ < 250) { y += step; window.scrollTo({ top: y, left: 0, behavior: 'instant' }); await new Promise(r => setTimeout(r, 120)); }
  window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  await new Promise(r => setTimeout(r, 300));
  await Promise.race([Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; }))), new Promise(r => setTimeout(r, 2500))]);
  const de = document.documentElement;
  return { height: Math.max(de.scrollHeight, document.body ? document.body.scrollHeight : 0), overflow_x: de.scrollWidth > (de.clientWidth || innerWidth) + 1, scroll_width: de.scrollWidth };
}

// Facts of one page (at scroll 0). width-dependent parts: cta first screen, overflow.
function inPageFacts(isHome) {
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const meta = n => document.querySelector(`meta[name="${n}" i]`)?.getAttribute('content') ?? null;
  const prop = n => document.querySelector(`meta[property="${n}" i]`)?.getAttribute('content') ?? null;
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const heads = sel => [...document.querySelectorAll(sel)].map(h => clean(h.innerText || h.textContent)).filter(Boolean).slice(0, 25);
  const host = location.hostname.replace(/^www\./, '');
  const jsonld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => {
    try { const j = JSON.parse(s.textContent); const types = []; const w = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(w); if (o['@type']) types.push(...[].concat(o['@type'])); if (o['@graph']) w(o['@graph']); }; w(j); return { ok: true, types }; }
    catch (e) { return { ok: false, error: String(e.message).slice(0, 120) }; }
  });
  const header = document.querySelector('header, [role="banner"]');
  const CTA = /(записат|запись|заказ|купить|оформ|заявк|получить|узнать (цен|стоим)|рассчит|подобрат|позвон|перезвон|связат|консультац|попробова|начать|подключ|зарегистр|регистрац|скачать|бронир|в корзину|оплат|sign ?up|get started|start (free|now|trial)|\btry\b|\bbuy\b|\border\b|\bbook\b|contact (us|sales)|request|subscribe|download|\bdemo\b|\bjoin\b|\bapply\b)/i;
  const ctas = new Map();
  for (const el of document.querySelectorAll('a, button, [role="button"], input[type="submit"], input[type="button"]')) {
    const t = clean(el.innerText || el.value || el.getAttribute('aria-label') || '');
    if (!t || t.length > 60 || !CTA.test(t)) continue;
    const key = t.toLowerCase();
    const r = el.getBoundingClientRect(); const v = vis(el);
    const c = ctas.get(key) || { text: t, count: 0, visible: 0, in_header: false, in_first_screen: false, href: null, tag: el.tagName.toLowerCase() };
    c.count++; if (v) c.visible++;
    if ((header && header.contains(el)) || (v && r.top + scrollY < 100 && r.height < 120)) c.in_header = true;
    if (v && r.top + scrollY < innerHeight && r.bottom > 0) c.in_first_screen = true;
    if (!c.href && el.getAttribute('href')) c.href = el.getAttribute('href').slice(0, 200);
    ctas.set(key, c);
  }
  const CONTACT = 'input[type=tel], input[type=email], input[name*=phone i], input[name*=tel i], input[name*=mail i], input[name*=name i], textarea';
  const forms = [...document.forms].map(f => {
    const fields = [...f.querySelectorAll('input, select, textarea')].filter(i => !['hidden', 'submit', 'button', 'image', 'reset'].includes((i.getAttribute('type') || '').toLowerCase()));
    let actionHost = null; try { actionHost = new URL(f.getAttribute('action') || location.href, location.href).hostname; } catch (e) { /* none */ }
    return { n_fields: fields.length, fields: fields.map(i => (i.getAttribute('type') || i.tagName).toLowerCase()).slice(0, 12), contact: !!f.querySelector(CONTACT),
      search: fields.length <= 2 && !!f.querySelector('input[type=search], input[name*=search i], input[name=q], input[name=s]'), visible: vis(f),
      method: (f.getAttribute('method') || 'get').toLowerCase(), action_host: actionHost };
  });
  const SOC = [['telegram', /(^|\.)t\.me$|telegram\.(me|org)$/], ['whatsapp', /wa\.me$|whatsapp\.com$/], ['viber', /viber\.(com|click)$/], ['vk', /(^|\.)vk\.(com|ru)$/], ['max', /(^|\.)max\.ru$/],
    ['instagram', /instagram\.com$/], ['youtube', /youtube\.com$|youtu\.be$/], ['ok', /(^|\.)ok\.ru$/], ['dzen', /dzen\.ru$/], ['tiktok', /tiktok\.com$/], ['facebook', /facebook\.com$/],
    ['x', /(^|\.)(x|twitter)\.com$/], ['linkedin', /linkedin\.com$/], ['rutube', /rutube\.ru$/]];
  const messengers = new Set(); let tel = 0, mail = 0, bots = 0;
  const BOOKING = /yclients|dikidi|bookform|sonline|arnica|appointer|booking\.|calendly|simplybook|onlinezapis|zapis/i;
  const booking = new Set();
  const links = [];
  for (const a of document.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (/^tel:/i.test(href)) { tel++; continue; }
    if (/^mailto:/i.test(href)) { mail++; continue; }
    let u; try { u = new URL(a.href); } catch (e) { continue; }
    if (!/^https?:$/.test(u.protocol)) continue;
    const h = u.hostname.replace(/^www\./, '');
    for (const [name, re] of SOC) if (re.test(h)) messengers.add(name);
    if (/(^|\.)t\.me$|telegram\.me$/.test(h) && /bot(\/|$|\?)/i.test(u.pathname)) bots++;
    if (BOOKING.test(h) && h !== host) booking.add(h);
    if (isHome && h === host && links.length < 400) {
      const zone = a.closest('header, [role=banner]') ? 'header' : a.closest('nav') ? 'nav' : a.closest('footer, [role=contentinfo]') ? 'footer' : 'main';
      links.push({ href: u.origin + u.pathname + u.search, text: clean(a.innerText || a.getAttribute('aria-label') || a.title || '').slice(0, 60), zone });
    }
  }
  const fontOf = el => (el ? getComputedStyle(el).fontFamily.split(',')[0].replace(/["']/g, '').trim() : null);
  const firstCta = [...document.querySelectorAll('a, button')].find(el => vis(el) && CTA.test(clean(el.innerText || '')));
  const fonts = { body: fontOf(document.body), h1: fontOf(document.querySelector('h1')), h2: fontOf(document.querySelector('h2')), cta: fontOf(firstCta),
    loaded: [...new Set([...(document.fonts || [])].filter(f => f.status === 'loaded').map(f => f.family.replace(/["']/g, '')))].slice(0, 10) };
  const colors = { body_bg: getComputedStyle(document.body).backgroundColor, html_bg: getComputedStyle(document.documentElement).backgroundColor, text: getComputedStyle(document.body).color,
    cta_bg: firstCta ? getComputedStyle(firstCta).backgroundColor : null, cta_text: firstCta ? clean(firstCta.innerText).slice(0, 40) : null, root_vars: [] };
  try {
    for (const sh of document.styleSheets) {
      let rules; try { rules = sh.cssRules; } catch (e) { continue; }
      for (const r of rules || []) {
        if (r.selectorText && /(^|,)\s*:root\b/.test(r.selectorText) && r.style) {
          for (let i = 0; i < r.style.length && colors.root_vars.length < 24; i++) {
            const k = r.style[i]; const v = r.style.getPropertyValue(k).trim();
            if (k.startsWith('--') && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(v)) colors.root_vars.push(`${k}: ${v}`);
          }
        }
      }
    }
  } catch (e) { /* cross-origin sheets */ }
  const text = clean(document.body?.innerText || '');
  const prices = [...new Set((text.match(/(?:от\s|from\s)?\d{1,3}(?:[\s  ]?\d{3})*(?:[.,]\d{1,2})?\s?(?:₽|руб\.?|р\.|\$|€|£|USD|EUR)(?:\s?\/\s?(?:мес|месяц|год|час|урок|занятие|шт|mo|month|yr|year|hour))?|[$€£]\s?\d+(?:[.,]\d{1,2})?(?:\s?\/\s?(?:mo|month|yr|year))?/gi) || []).map(clean))].slice(0, 10);
  // text in the first screen (top viewport at scroll 0)
  const fs = []; let fsLen = 0;
  const tw = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let n = tw.nextNode(); n && fsLen < 500; n = tw.nextNode()) {
    const t = clean(n.textContent); if (t.length < 2) continue;
    const el = n.parentElement; if (!el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    const r = el.getBoundingClientRect(); if (r.bottom <= 0 || r.top + scrollY >= innerHeight || !vis(el)) continue;
    if (el.closest('nav, footer, [role="navigation"]')) continue;
    fs.push(t); fsLen += t.length + 1;
  }
  const scriptsSrc = [...document.scripts].map(s => s.src).filter(Boolean).slice(0, 200);
  for (const s of [...scriptsSrc, ...[...document.querySelectorAll('iframe')].map(f => f.src)]) { try { const h = new URL(s).hostname.replace(/^www\./, ''); if (BOOKING.test(h) && h !== host) booking.add(h); } catch (e) { /* bad src */ } }
  const quiz = /marquiz|quiz/i.test(scriptsSrc.join(' ')) || !!document.querySelector('[class*="quiz" i], [id*="quiz" i], [data-marquiz-id]') || /пройдите (тест|опрос)|ответьте на \d+ вопрос/i.test(text);
  // legal entity and a tax number on the page (usually the footer): "ООО «…»", "ИП Фамилия", "ИНН 1234567890"
  const legal = { entity: /(?:^|[^\p{L}])(?:ООО|ОАО|ЗАО|ПАО|АО|ИП|LLC|Ltd\.?|GmbH|Inc\.)\s+[«"“]?[\p{Lu}\d]/u.test(text), tax_id: /(?:ИНН|ОГРНИП|ОГРН)\s*:?\s*\d{10,15}/.test(text) };
  return {
    title: document.title, description: meta('description'), robots: meta('robots'), generator: meta('generator'), lang: document.documentElement.getAttribute('lang'),
    canonical: document.querySelector('link[rel="canonical"]')?.href || null,
    og: { title: prop('og:title'), description: prop('og:description'), image: prop('og:image'), site_name: prop('og:site_name') },
    headings: { h1: heads('h1'), h2: heads('h2'), h3: heads('h3') }, jsonld, words: text ? text.split(' ').length : 0,
    ctas: [...ctas.values()].sort((a, b) => b.count - a.count).slice(0, 20), forms, contacts: { tel_links: tel, mailto_links: mail, messengers: [...messengers], bot_links: bots, booking: [...booking].slice(0, 5) },
    quiz, legal,
    fonts, colors, prices, first_screen_text: fs.join(' ').slice(0, 500), scripts_src: scriptsSrc, links: isHome ? links : undefined,
    images: { count: document.images.length, no_alt: [...document.images].filter(i => !i.hasAttribute('alt')).length }, video: document.querySelectorAll('video').length,
    iframes: [...document.querySelectorAll('iframe')].map(f => f.src).filter(Boolean).slice(0, 10).map(s => { try { return new URL(s).hostname; } catch (e) { return s.slice(0, 80); } }),
  };
}
// Visible text by blocks + collapsed content from the DOM (no clicks) — same idea as snapshot's text.md
function inPageText() {
  const it = el => (el?.innerText || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const header = document.querySelector('header, [role="banner"]');
  const footers = [...document.querySelectorAll('footer, [role="contentinfo"]')];
  const footer = footers[footers.length - 1] || null;
  const main = document.querySelector('main, [role="main"]');
  const blocks = [];
  if (main) {
    if (header && !main.contains(header)) blocks.push(['header', it(header)]);
    blocks.push(['main', it(main)]);
    if (footer && !main.contains(footer)) blocks.push(['footer', it(footer)]);
  } else blocks.push(['page', it(document.body)]);
  const hidden = []; const seen = new Set();
  for (const d of document.querySelectorAll('details:not([open])')) {
    const clone = d.cloneNode(true); const sum = clone.querySelector('summary'); const label = sum ? sum.textContent : ''; sum?.remove();
    const t = (clone.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length >= 20 && !seen.has(t)) { seen.add(t); hidden.push({ label: label.replace(/\s+/g, ' ').trim().slice(0, 100), text: t.slice(0, 3000) }); }
    if (hidden.length >= 40) break;
  }
  return { blocks, hidden };
}

// ---------- helpers ----------
function viewportFor(w) {
  const known = { 390: [844, true, 2], 360: [780, true, 2], 375: [812, true, 2], 414: [896, true, 2], 768: [1024, false, 1], 1024: [768, false, 1], 1280: [800, false, 1], 1366: [768, false, 1], 1440: [900, false, 1], 1920: [1080, false, 1] };
  const k = known[w];
  const mobile = k ? k[1] : w < 600, dpr = k ? k[2] : (mobile ? 2 : 1);
  const height = k ? k[0] : (mobile ? Math.round(w * 2.16) : Math.round(w * 0.625));
  const targetW = mobile ? 600 : Math.min(w, 1000);
  return { width: w, height, mobile, dpr, imgPerCss: targetW / w, clipScale: targetW / w / dpr, chunkCss: mobile ? 1800 : 1600 };
}
const TRACKERS = [
  [/mc\.yandex|metrika\.yandex|yandex\.ru\/metrika/i, 'Яндекс Метрика'], [/googletagmanager\.com/i, 'Google Tag Manager'], [/google-analytics\.com|analytics\.google\.com|gtag\/js/i, 'Google Analytics'],
  [/doubleclick\.net|googleadservices|googlesyndication/i, 'Google Ads'], [/connect\.facebook\.net|facebook\.com\/tr/i, 'Meta Pixel'], [/vk\.com\/rtrg|vk\.com\/js\/api\/openapi/i, 'VK Pixel'],
  [/top-fwz1\.mail\.ru|top\.mail\.ru/i, 'Top@Mail.ru'], [/hotjar/i, 'Hotjar'], [/clarity\.ms/i, 'Microsoft Clarity'], [/amplitude/i, 'Amplitude'], [/segment\.(io|com)/i, 'Segment'],
  [/mixpanel/i, 'Mixpanel'], [/tiktok/i, 'TikTok Pixel'], [/snap\.licdn|linkedin/i, 'LinkedIn Insight'], [/bat\.bing/i, 'Bing UET'], [/plausible/i, 'Plausible'], [/matomo|piwik/i, 'Matomo'],
  [/counter\.yadro|liveinternet/i, 'LiveInternet'], [/roistat/i, 'Roistat'], [/calltouch/i, 'Calltouch'], [/comagic|uiscom/i, 'CoMagic/UIS'], [/callibri/i, 'Callibri'], [/jivo/i, 'Jivo'],
  [/bitrix24/i, 'Битрикс24'], [/carrotquest/i, 'Carrot quest'], [/envybox/i, 'Envybox'], [/marquiz/i, 'Marquiz'], [/intercom/i, 'Intercom'], [/tawk\.to/i, 'Tawk.to'],
];
const trackerName = u => (TRACKERS.find(([re]) => re.test(u)) || [])[1] || null;
const STACK_RULES = [
  ['Tilda', /tildacdn\.com|\.tilda\.ws|data-tilda-|tildastat|id="allrecords"/i], ['WordPress', /\/wp-content\/|\/wp-includes\/|\/wp-json\//i],
  ['Bitrix', /\/bitrix\/(js|templates|cache|components|tools)\/|BX\.setJSList|bx-core/i], ['Webflow', /data-wf-site|webflow\.(js|css)|website-files\.com|\.webflow\.io/i],
  ['Wix', /static\.wixstatic\.com|static\.parastorage\.com|\.wixsite\.com/i], ['Next.js', /__NEXT_DATA__|\/_next\/static\//i], ['Nuxt', /__NUXT__|\/_nuxt\//i],
  ['Shopify', /cdn\.shopify\.com|myshopify\.com|Shopify\.theme/i], ['InSales', /insales\.ru|insales-cdn|InSales\./i], ['Readymag', /readymag\.(com|website)|rm-static/i],
  ['Taplink', /taplink\.(cc|ru|at)/i], ['Craftum', /craftum\.(com|io|ru)/i], ['Joomla', /\/media\/jui\/|\/components\/com_|Joomla!/i], ['Drupal', /Drupal\.settings|\/sites\/default\/files\/|drupal\.js/i],
  ['MODX', /assets\/components\/|MODX/], ['OpenCart', /catalog\/view\/theme|route=common\/home/i], ['Squarespace', /static1\.squarespace\.com|squarespace\.com/i],
  ['Framer', /framerusercontent\.com|framer\.com\/m\//i], ['Gatsby', /id="___gatsby"/i], ['Astro', /<astro-island|astro-[a-z0-9]{8}/i],
];
function detectStack(html, resourceUrls, headers, generator) {
  const hay = String(html || '').slice(0, 400000) + '\n' + (resourceUrls || []).join('\n');
  const score = new Map(), signals = [];
  const add = (n, why, w) => { score.set(n, (score.get(n) || 0) + w); signals.push(`${n}: ${why}`); };
  for (const [n, re] of STACK_RULES) { const m = hay.match(re); if (m) add(n, m[0].slice(0, 50), 2); }
  const g = String(generator || '').toLowerCase();
  for (const [n] of STACK_RULES) if (g && g.includes(n.toLowerCase().replace('.js', ''))) add(n, 'meta generator', 3);
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (/next\.js/i.test(h['x-powered-by'] || '')) add('Next.js', 'x-powered-by', 3);
  if (h['x-wix-request-id']) add('Wix', 'x-wix-request-id', 3);
  if (h['x-shopify-stage'] || h['x-shopid']) add('Shopify', 'header', 3);
  let cms = null, best = 0;
  for (const [k, v] of score) if (v > best) { best = v; cms = k; }
  const cdn = /cloudflare/i.test(h.server || '') || h['cf-ray'] ? 'Cloudflare' : /ddos-guard/i.test(h.server || '') ? 'DDoS-Guard' : /qrator/i.test(h.server || '') ? 'Qrator' : h['x-vercel-id'] ? 'Vercel' : null;
  return { cms, cdn, server: h.server || null, signals: [...new Set(signals)].slice(0, 12) };
}
const KEY_CATS = [
  ['prices', /цен[аыу]|прайс|тариф|стоимост|price|pricing|plans|tarif|prajs|ceny|stoimost/i],
  ['services', /услуг|каталог|продукц|товар|меню|курс|программ|направлен|services|catalog|products|shop|menu|courses|uslugi|katalog/i],
  ['about', /о нас|о компании|о студии|о школе|компания|команда|about|company|team|o-nas|o-kompanii/i],
  ['contacts', /контакт|как добраться|адрес|contact|kontakt/i],
  ['cases', /портфолио|кейс|наши работы|проекты|отзыв|portfolio|cases|projects|reviews|otzyvy/i],
];
function pickKeyPages(links, origin, robots, max) {
  const out = [], used = new Set([origin + '/', origin]);
  for (const [cat, re] of KEY_CATS) {
    if (out.length >= max) break;
    let best = null, bestScore = 0;
    for (const l of links || []) {
      let u; try { u = new URL(l.href); } catch { continue; }
      const path = u.pathname + u.search;
      if (used.has(u.origin + u.pathname) || path === '/' || /\.(pdf|jpe?g|png|zip|docx?|xlsx?)$/i.test(u.pathname) || U.isRiskyGet(l.href)) continue;
      if (robots && !U.robotsAllows(robots, l.href, 'Mozilla')) continue;
      let s = 0;
      if (re.test(l.text)) s += 2;
      if (re.test(decodeURIComponent(u.pathname))) s += 1;
      if (!s) continue;
      if (l.zone === 'header' || l.zone === 'nav') s += 1;
      if (s > bestScore) { bestScore = s; best = { url: u.origin + u.pathname + u.search, why: cat, text: l.text }; }
    }
    if (best) { out.push(best); used.add(new URL(best.url).origin + new URL(best.url).pathname); }
  }
  return out;
}
const templateOf = p => { const segs = p.split('/').filter(Boolean); if (!segs.length) return '/'; return '/' + segs[0] + (segs.length > 1 ? '/*' : ''); };
async function allowIfLocal(url) {
  const h = U.hostOf(url);
  const loop = x => x === 'localhost' || x.endsWith('.localhost') || /^127\./.test(x) || x === '[::1]';
  // only loopback rivals, and only when our own site is local too (demo / selftest)
  if (h && loop(h) && oursUrl && loop(U.hostOf(oursUrl))) U.allowPrivateHost(h);
}
async function launchBrowser() {
  for (let i = 0; ; i++) {
    try { return await Browser.launch(); }
    catch (e) { if (i >= 2 || !/EBUSY|EPERM|EACCES/.test(String(e?.code || '') + String(e?.message || ''))) throw e; await U.sleep(600 * (i + 1)); }
  }
}

// ---------- capture ----------
async function capture() {
  const urls = [];
  // --urls-file: JSON list kept on disk, so raw competitor URLs never pass through a shell command line
  const fileUrls = [];
  if (str(args['urls-file'])) {
    const p = isAbsolute(str(args['urls-file'])) ? str(args['urls-file']) : join(run, str(args['urls-file']));
    const j = existsSync(p) ? U.readJSON(p, null) : null;
    const list = Array.isArray(j) ? j : Array.isArray(j?.urls) ? j.urls : Array.isArray(j?.rivals) ? j.rivals : Array.isArray(j?.competitors) ? j.competitors : null;
    if (!list) fail(2, `--urls-file: не прочитал список адресов из ${fwd(p)} (нужен JSON: ["https://…"] или { "urls": [...] }).`,
      `--urls-file: no URL list in ${fwd(p)} (need JSON: ["https://…"] or { "urls": [...] }).`);
    for (const e of list) { const v = typeof e === 'string' ? e : e?.url || e?.site; if (typeof v === 'string') fileUrls.push(v.trim()); }
  }
  for (const raw of [...U.listArg(args.urls), ...fileUrls]) {
    try { const u = U.normalizeUrl(raw); if (!/^https?:/i.test(u)) continue; if (!urls.some(x => U.hostKey(x) === U.hostKey(u))) urls.push(u); }
    catch { console.error(T(`Пропускаю непонятный адрес: ${raw}`, `Skipping a bad URL: ${raw}`)); }
  }
  if (!urls.length) fail(2, 'Нужен --urls "https://a.ru,https://b.ru" или --urls-file <json>.', 'Need --urls "https://a.com,https://b.com" or --urls-file <json>.');
  const light = !!args.light;
  const widths = (U.listArg(args.widths).map(Number).filter(n => n >= 280 && n <= 2560).length ? U.listArg(args.widths).map(Number).filter(n => n >= 280 && n <= 2560) : [1440, 390]);
  const PRIMARY = widths.includes(1440) ? 1440 : Math.max(...widths);
  const maxKeys = Math.max(0, Math.min(6, Number(args.pages ?? 3)));
  const indexPath = U.insideRun(run, 'rivals', 'rivals.json');
  const index = readOpt(indexPath) || { sites: {} };
  index.sites ||= {};
  let partial = false, busy = false, release = null;
  const done = [];
  const sites = [];
  // --redo is repeated by the orchestrator after a partial call: each host is reset once per redo session
  if (args.redo && (!index.redo || index.redo.finished)) index.redo = { started: U.nowIso(), hosts: [], finished: false };
  for (const url of urls) {
    const hk = U.hostKey(url);
    const dir = U.insideRun(run, 'rivals', hk);
    let cap = readOpt(join(dir, 'capture.json'));
    if (args.redo && !index.redo.hosts.includes(hk)) {
      index.redo.hosts.push(hk);
      if (cap) { try { rmSync(join(dir, 'shots'), { recursive: true, force: true }); } catch { /* ignore */ } cap = null; }
    }
    if (cap?.complete && (cap.mode === 'full' || light)) { sites.push({ url, hk, dir, cap, skip: true }); continue; }
    if (cap?.complete && cap.mode === 'light' && !light) { cap.complete = false; cap.mode = 'full'; } // upgrade: home loads are reused
    sites.push({ url, hk, dir, cap });
  }
  const todo = sites.filter(s => !s.skip);
  try {
    if (todo.length) {
      U.cleanupStaleProfiles();
      const note = setTimeout(() => U.progress(T('rivals: жду свободный браузер (заняты другими проверками)…', 'rivals: waiting for a free browser slot…')), 1500);
      try { release = await U.acquireBrowserSlot({ waitMs: 10 * 60 * 1000 }); }
      catch { release = null; }
      finally { clearTimeout(note); }
      if (release) deadline = Date.now() + budgetSec * 1000;
      else { partial = true; busy = true; }
      for (const s of (release ? todo : [])) {
        if (secLeft() < 40) { partial = true; break; }
        await allowIfLocal(s.url);
        // a site whose capture throws is tried twice in all (attempts are kept in capture.json), then recorded as
        // blocked: "error" and skipped: one broken site must not stop the others or make the caller repeat forever
        for (;;) {
          let browser = null;
          try { browser = await launchBrowser(); s.cap = await captureSite(browser, s, { light, widths, PRIMARY, maxKeys }); break; }
          catch (e) {
            const prev = readOpt(join(s.dir, 'capture.json')) || s.cap || { tool: 'rivals', version: U.VERSION, url: s.url, host: s.hk, ours: s.hk === oursKey, mode: light ? 'light' : 'full', complete: false, done: [], pages: [], blocked: null, errors: [] };
            prev.attempts = (prev.attempts || 0) + 1;
            (prev.errors ||= []).push({ at: U.nowIso(), error: String(e?.message || e).slice(0, 300) });
            if (prev.attempts >= 2) { prev.blocked = 'error'; prev.complete = true; prev.captured = U.nowIso(); try { finishFacts(prev); } catch { /* partial data */ } }
            U.ensureDir(s.dir); U.writeJSON(join(s.dir, 'capture.json'), prev);
            s.cap = prev;
            U.progress(`rivals: ${s.hk} — ${T('сбой снимка', 'capture failed')} (${prev.attempts}/2): ${String(e?.message || e).slice(0, 120)}`);
            if (prev.complete || secLeft() < 40) break;
          } finally { try { await browser?.close(); } catch { /* ignore */ } }
        }
        if (s.cap && !s.cap.complete) { partial = true; break; } // only the budget leaves a capture incomplete
      }
    }
  } finally { release?.(); }

  // index + summary
  const lines = [];
  let i = 0;
  for (const s of sites) {
    const c = s.cap || readOpt(join(s.dir, 'capture.json'));
    const st = !c ? 'todo' : c.blocked === 'error' ? 'error' : c.blocked ? 'blocked' : c.complete ? 'done' : 'partial';
    index.sites[s.hk] = { url: c?.url || s.url, dir: fwd(join('rivals', s.hk)), status: st, complete: !!c?.complete, mode: c?.mode || (light ? 'light' : 'full'), ours: s.hk === oursKey, pages: (c?.pages || []).length,
      shots: (c?.pages || []).reduce((n, p) => n + Object.values(p.widths || {}).reduce((m, w) => m + (w.shots || []).length, 0), 0), blocked: c?.blocked || null, attempts: c?.attempts || undefined };
    if (st === 'done' || st === 'blocked' || st === 'error') done.push(s.hk);
    if (i++ < 30) {
      const fa = c?.facts_auto || {};
      lines.push(`  ${s.hk.slice(0, 32).padEnd(32)} ${({ done: T('готово', 'done'), blocked: T('закрыт', 'closed'), error: T('ошибка', 'error'), partial: T('частично', 'partial'), todo: T('не снят', 'todo') })[st]}`
        + (c?.blocked ? ` · ${c.blocked}` : '')
        + (st === 'done' ? ` · ${T('стр.', 'pages')} ${index.sites[s.hk].pages} · ${T('кадров', 'shots')} ${index.sites[s.hk].shots} · ${fa.stack || T('стек ?', 'stack ?')} · LCP390 ${fa.lcp_mobile ?? '—'} ${T('мс', 'ms')} · CTA ${T('в шапке', 'in header')}: ${fa.cta_header === true ? T('да', 'yes') : fa.cta_header === false ? T('нет', 'no') : '—'}` : '')
        + (s.hk === oursKey ? T(' · наш', ' · ours') : '') + (s.skip ? T(' (уже был)', ' (cached)') : ''));
    }
  }
  index.tool = 'rivals'; index.version = U.VERSION; index.run = run; index.generated = U.nowIso();
  index.partial = partial; index.resume = partial ? { done } : null; index.mode = light ? 'light' : 'full';
  // the step is done only when every requested site has a complete capture (closed and failed sites count as complete)
  index.requested = sites.map(s => s.hk);
  index.incomplete = sites.filter(s => !index.sites[s.hk]?.complete).map(s => s.hk);
  index.status = index.incomplete.length ? 'partial' : 'complete';
  if (index.redo && !partial) index.redo.finished = true;
  U.writeJSON(indexPath, index);
  const mine = sites.map(s => index.sites[s.hk]);
  const nDone = mine.filter(x => x.status === 'done').length, nBlocked = mine.filter(x => x.status === 'blocked').length;
  const head = T(`rivals: ${partial ? 'ЧАСТИЧНО' : 'готово'} · ${light ? 'лёгкий снимок' : 'полный снимок'} · сайтов ${sites.length}: снято ${nDone}, закрыто ${nBlocked} · ${Math.round((Date.now() - T0) / 1000)} с`,
    `rivals: ${partial ? 'PARTIAL' : 'done'} · ${light ? 'light' : 'full'} snapshot · sites ${sites.length}: captured ${nDone}, closed ${nBlocked} · ${Math.round((Date.now() - T0) / 1000)}s`);
  const tail = [`${T('Записано', 'Written')}: ${fwd(RIVALS)}`];
  if (busy) tail.push(T('Все браузеры заняты другими проверками 10 минут — запустите ту же команду позже.', 'All browser slots busy for 10 minutes — run the same command later.'));
  else if (partial) tail.push(T('Не успел за бюджет — запустите ту же команду ещё раз, продолжу с места остановки.', 'Out of budget — run the same command again to continue.'));
  U.printAndSaveSummary(run, 'rivals', [head, ...lines, ...tail]);
  U.log(run, `rivals: ${light ? 'лёгкий' : 'полный'} снимок, сайтов ${sites.length}, снято ${nDone}, закрыто ${nBlocked}${partial ? ', частично' : ''}`);
  return partial ? 75 : 0;
}

async function captureSite(browser, s, { light, widths, PRIMARY, maxKeys }) {
  const shotsDir = U.ensureDir(join(s.dir, 'shots'));
  const cap = s.cap && !s.cap.complete ? s.cap : { tool: 'rivals', version: U.VERSION, url: s.url, host: s.hk, ours: s.hk === oursKey, mode: light ? 'light' : 'full',
    captured: null, complete: false, done: [], pages: [], blocked: null, robots: null, sitemap: null, errors: [] };
  cap.mode = light ? (cap.mode === 'full' ? 'full' : 'light') : 'full';
  const save = () => U.writeJSON(join(s.dir, 'capture.json'), cap);
  const pageOf = (pid, url, why) => { let p = cap.pages.find(x => x.pid === pid); if (!p) { p = { pid, url, why, widths: {} }; cap.pages.push(p); } return p; };
  const home = pageOf('home', s.url, T('главная', 'home'));
  // upgrade light → full of an old capture without the link list: the main width of the home page is loaded again
  if (cap.mode === 'full' && !cap.key_pages && !home.links) { cap.done = cap.done.filter(k => k !== `home@${PRIMARY}`); home.facts = null; }
  const origin = new URL(s.url).origin;
  U.progress(`rivals: ${s.hk} — ${cap.mode === 'light' ? T('лёгкий снимок', 'light') : T('полный снимок', 'full')}`);

  // robots (full only): sitemaps + allow rules for key pages
  if (cap.mode === 'full' && !cap.robots) {
    const r = await U.politeFetch(origin + '/robots.txt', { lang, timeoutMs: 15000, maxBytes: 512 * 1024 });
    const ok = r.ok && /text\/plain/i.test(String(r.headers?.['content-type'] || 'text/plain')) && !/<html/i.test(r.body || '');
    const parsed = ok ? U.parseRobots(r.body || '') : null;
    cap.robots = { status: r.status || null, ok, sitemaps: parsed ? parsed.sitemaps.map(x => { try { return new URL(x, origin).href; } catch { return x; } }) : [], parsed };
    save();
  }
  const robots = cap.robots?.parsed || null;

  // load plan: home at every width, key pages after the home facts are known
  const loadOne = async (pg, w) => {
    const key = `${pg.pid}@${w}`;
    if (cap.done.includes(key)) return true;
    if (secLeft() < 35) return false;
    const vp = viewportFor(w);
    const page = await browser.newPage({ blockNavigation: true });
    const net = new Map();
    page.on('Network.requestWillBeSent', p => { if (!net.has(p.requestId)) net.set(p.requestId, { url: p.request.url, bytes: 0 }); });
    page.on('Network.loadingFinished', p => { const n = net.get(p.requestId); if (n) n.bytes = p.encodedDataLength || 0; });
    const rec = { width: w, shots: [] };
    let cut = false; // a frame skipped for lack of budget: this page@width is not done, the next call takes it again
    try {
      await page.setViewport({ width: vp.width, height: vp.height, mobile: vp.mobile, deviceScaleFactor: vp.dpr });
      await page.addInitScript(VITALS_INIT);
      const t0 = Date.now();
      const load = await page.goto(pg.url, { timeout: 45000, waitUntil: 'domcontentloaded' });
      if (!load.ok) {
        rec.error = load.refused ? `refused_${load.refused}` : load.error || 'load failed';
        rec.blocked = load.refused ? `refused_${load.refused}` : /AUTH/i.test(load.error || '') ? '401' : /TIMED_OUT|timeout/i.test(load.error || '') ? 'timeout' : 'network';
      } else {
        page.setPhase('load');
        const until = Date.now() + 12000;
        while (Date.now() < until) {
          const done = (await page.evaluate('document.readyState').catch(() => '')) === 'complete';
          if (done && page.inflight.size <= 1 && Date.now() - page.lastNetActivity > 800) break;
          await U.sleep(200);
        }
        page.setPhase('interact');
        rec.status = load.status ?? null; rec.load_ms = Date.now() - t0;
        rec.final_url = await page.evaluate('location.href').catch(() => load.finalUrl || pg.url);
        await U.sleep(500);
        const doc = page.responses.find(r => r.type === 'Document');
        const docHeaders = Object.fromEntries(Object.entries(doc?.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
        const q = await page.evaluateIsolated(() => ({ html: document.documentElement.outerHTML.slice(0, 400000), textLen: (document.body?.innerText || '').trim().length })).catch(() => ({ html: '', textLen: 0 }));
        const ab = U.detectAntibot(rec.status || 0, docHeaders, '') || (q.textLen < 400 && /cf-chl|challenge-platform|just a moment|checking your browser|ddos-guard|smartcaptcha|captcha-delivery|проверка браузера|вы не робот|are you a robot/i.test(q.html) ? 'challenge' : null);
        if (ab) rec.blocked = 'antibot'; else if (rec.status === 401) rec.blocked = '401'; else if (rec.status === 403) rec.blocked = '403';
        // first screen as is
        const fold = `${pg.pid}-${w}-fold.jpg`;
        await page.screenshot({ path: U.insideRun(s.dir, 'shots', fold), format: 'jpeg', quality: 70 });
        const fsz = IMG.imageSize(join(shotsDir, fold));
        rec.shots.push({ file: fold, pid: pg.pid, width: w, y0: 0, y1: vp.height, scale: vp.dpr, kind: 'fold', img_w: fsz?.w, img_h: fsz?.h });
        if (!rec.blocked) {
          const layers = await page.evaluateIsolated(inPageLayers).catch(() => []);
          rec.cookie_banner = layers.some(l => l.kind === 'cookie');
          rec.overlays = layers.filter(l => l.kind).map(l => ({ kind: l.kind, share_top: l.share_top, text: l.text }));
          if (w === PRIMARY || !pg.facts) {
            const f = await page.evaluateIsolated(inPageFacts, pg.pid === 'home').catch(e => ({ error: e.message }));
            if (!f.error) {
              const resUrls = page.responses.map(r => r.url);
              f.stack = detectStack(q.html, resUrls, docHeaders, f.generator);
              const trackers = new Set();
              for (const u of [...f.scripts_src, ...Object.values(page.blocked).flat().map(b => b.url)]) { const n = trackerName(u); if (n) trackers.add(n); }
              f.trackers = [...trackers];
              f.blocked_attempts = Object.fromEntries(Object.entries(page.blocked).map(([k, v]) => [k, v.length]).filter(([, n]) => n));
              delete f.scripts_src;
              if (pg.pid === 'home') { pg.links = f.links; }
              delete f.links;
              pg.facts = f;
              const txt = await page.evaluateIsolated(inPageText).catch(() => null);
              writePageText(s, pg, f, rec, txt, w);
            } else cap.errors.push({ pid: pg.pid, width: w, error: f.error });
          } else {
            // width-dependent facts only
            const f = await page.evaluateIsolated(inPageFacts, false).catch(() => null);
            if (f) rec.cta_first_screen = f.ctas.filter(c => c.in_first_screen).map(c => c.text).slice(0, 6);
          }
          if (w === PRIMARY && pg.facts) rec.cta_first_screen = pg.facts.ctas.filter(c => c.in_first_screen).map(c => c.text).slice(0, 6);
          // lazy content, then chunks without overlays and with fixed layers frozen
          const m = await page.evaluateIsolated(inPageSlowScroll, 25000).catch(() => ({ height: vp.height }));
          rec.doc_height = m.height; rec.overflow_x = !!m.overflow_x;
          rec.vitals = await page.evaluate(() => window.__rvVitals || null).catch(() => null);
          await page.evaluateIsolated(inPageFreeze, layers.filter(l => l.kind).map(l => l.i)).catch(() => {});
          const fullH = Math.max(vp.height, Math.min(m.height || vp.height, 25000));
          const plan = [];
          for (let y = 0; y < fullH; y += vp.chunkCss) plan.push([y, Math.min(vp.chunkCss, fullH - y)]);
          if (plan.length > 1 && plan[plan.length - 1][1] < vp.chunkCss * 0.3 && (plan[plan.length - 2][1] + plan[plan.length - 1][1]) * vp.imgPerCss <= 4000) plan[plan.length - 2][1] += plan.pop()[1];
          let k = 0;
          for (const [y, h] of plan) {
            if (secLeft() < 15) { cut = true; break; }
            const f = `${pg.pid}-${w}.part-${String(++k).padStart(2, '0')}.jpg`;
            await page.screenshot({ path: U.insideRun(s.dir, 'shots', f), format: 'jpeg', quality: 70, clip: { x: 0, y, width: vp.width, height: h, scale: vp.clipScale } });
            const sz = IMG.imageSize(join(shotsDir, f));
            rec.shots.push({ file: f, pid: pg.pid, width: w, y0: y, y1: y + h, scale: Math.round(vp.imgPerCss * 10000) / 10000, kind: 'part', img_w: sz?.w, img_h: sz?.h });
          }
          if (fullH * vp.imgPerCss <= 8000 && secLeft() <= 15) cut = true;
          else if (fullH * vp.imgPerCss <= 8000) {
            const f = `${pg.pid}-${w}-full.jpg`;
            await page.screenshot({ path: U.insideRun(s.dir, 'shots', f), format: 'jpeg', quality: 70, clip: { x: 0, y: 0, width: vp.width, height: fullH, scale: vp.clipScale } });
            const sz = IMG.imageSize(join(shotsDir, f));
            rec.shots.push({ file: f, pid: pg.pid, width: w, y0: 0, y1: fullH, scale: Math.round(vp.imgPerCss * 10000) / 10000, kind: 'full', img_w: sz?.w, img_h: sz?.h });
          }
          await page.evaluateIsolated(inPageRestore).catch(() => {});
        }
        const all = [...net.values()];
        rec.net = { requests: all.length, bytes: all.reduce((n, x) => n + (x.bytes || 0), 0) };
        if (!pg.headers) pg.headers = Object.fromEntries(Object.entries(docHeaders).filter(([k]) => ['server', 'x-powered-by', 'content-type', 'cache-control'].includes(k)));
      }
    } finally { await page.close(); }
    if (cut) { U.progress(`rivals: ${s.hk} ${key} — ${T('не хватило бюджета на кадры, сниму при следующем вызове', 'out of budget for frames, next call')}`); return false; }
    pg.widths[String(w)] = rec;
    cap.done.push(key);
    // shots/index.json for the whole host
    const idx = cap.pages.flatMap(p => Object.values(p.widths || {}).flatMap(x => (x.shots || []).map(sh => ({ ...sh, file: sh.file })))).sort((a, b) => a.pid.localeCompare(b.pid) || a.width - b.width || a.y0 - b.y0);
    U.writeJSON(U.insideRun(s.dir, 'shots', 'index.json'), idx);
    save();
    U.progress(`rivals: ${s.hk} ${key} ${rec.status ?? '—'}${rec.blocked ? ' · ' + T('ЗАКРЫТО', 'BLOCKED') + ': ' + rec.blocked : ''} · ${rec.shots.length} ${T('кадров', 'shots')}`);
    if (pg.pid === 'home' && rec.blocked) { cap.blocked = rec.blocked; }
    return true;
  };

  for (const w of widths) {
    if (!(await loadOne(home, w))) return cap;
    if (cap.blocked) break;
    await U.sleep(1000);
  }
  if (cap.blocked) { cap.complete = true; cap.captured = U.nowIso(); finishFacts(cap); save(); return cap; }

  if (cap.mode === 'full') {
    if (!cap.key_pages) {
      const keys = pickKeyPages(home.links || [], origin, robots, maxKeys);
      cap.key_pages = keys;
      keys.forEach((k, i) => pageOf(`p${String(i + 1).padStart(2, '0')}`, k.url, k.why));
      save();
    }
    for (const pg of cap.pages.filter(p => p.pid !== 'home')) {
      for (const w of widths) { if (!(await loadOne(pg, w))) return cap; await U.sleep(1000); }
    }
    if (!cap.sitemap) {
      const seeds = cap.robots?.sitemaps?.length ? cap.robots.sitemaps : [origin + '/sitemap.xml'];
      const sm = await U.fetchSitemaps(seeds.slice(0, 5), { limitFiles: 12, limitUrls: 20000, lang });
      const by = {};
      for (const u of sm.urls) { let p; try { p = new URL(u.loc).pathname; } catch { continue; } const t = templateOf(p); by[t] = (by[t] || 0) + 1; }
      cap.sitemap = { files: sm.files.length, files_ok: sm.files.filter(f => f.status === 200 && f.count > 0).length, urls: sm.urls.length,
        by_template: Object.fromEntries(Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 40)) };
      save();
    }
  }
  cap.complete = true;
  cap.captured = U.nowIso();
  finishFacts(cap);
  save();
  return cap;
}

function writePageText(s, pg, f, rec, txt, w) {
  const L = lang === 'en' ? { url: 'URL', code: 'Status', taken: 'Captured', width: 'width', header: 'Header', main: 'Main content', footer: 'Footer', page: 'Whole page', hidden: 'Collapsed blocks (text from the DOM, no clicks)' }
    : { url: 'URL', code: 'Код', taken: 'Снято', width: 'ширина', header: 'Шапка', main: 'Основное содержимое', footer: 'Подвал', page: 'Страница целиком', hidden: 'Свёрнутые блоки (текст по DOM, без кликов)' };
  const out = [`# ${f.title || pg.url}`, '', `${L.url}: ${pg.url}`, `${L.code}: ${rec.status ?? '—'}`, `Title: ${f.title || '—'}`, `Description: ${f.description || '—'}`,
    `H1: ${(f.headings?.h1 || []).join(' | ') || '—'}`, `${L.taken}: ${U.nowIso()} · ${L.width} ${w}`, ''];
  for (const [k, t] of txt?.blocks || []) out.push(`## ${L[k] || k}`, '', t || '—', '');
  if (txt?.hidden?.length) { out.push(`## ${L.hidden}`, ''); for (const h of txt.hidden) out.push(`### ${h.label || '…'}`, '', h.text, ''); }
  const name = pg.pid === 'home' ? 'text.md' : `text-${pg.pid}.md`;
  U.writeText(U.insideRun(s.dir, name), out.join('\n'));
  pg.text = `rivals/${s.hk}/${name}`;
}

// facts_auto: only what a script can measure; everything that needs judgement stays null for rival-analyst
function finishFacts(cap) {
  const home = cap.pages.find(p => p.pid === 'home') || {};
  const f = home.facts || null;
  const w390 = home.widths?.['390'] || Object.values(home.widths || {}).find(x => x.width < 600) || null;
  const w1440 = home.widths?.['1440'] || null;
  const formsN = f ? f.forms.filter(x => x.n_fields > 0 && !x.search).length : null;
  cap.facts_auto = cap.blocked ? { blocked: cap.blocked } : {
    cta_header: f ? f.ctas.some(c => c.in_header) : null,
    forms: formsN,
    pages_by_template: cap.sitemap ? (cap.sitemap.urls ? cap.sitemap.by_template : {}) : null,
    stack: f ? (f.stack?.cms || 'unknown') : null,
    home_screens_390: w390?.doc_height ? Math.round(10 * w390.doc_height / viewportFor(w390.width || 390).height) / 10 : null,
    lcp_mobile: w390?.vitals?.lcp ?? null,
    lcp_desktop: w1440?.vitals?.lcp ?? null,
    weight_home_kb: w390?.net?.bytes ? Math.round(w390.net.bytes / 1024) : (w1440?.net?.bytes ? Math.round(w1440.net.bytes / 1024) : null),
    trackers: f ? f.trackers : null,
    messengers: f ? f.contacts.messengers : null,
    phone_link: f ? f.contacts.tel_links > 0 : null,
    cookie_banner: w390 || w1440 ? !!(w390?.cookie_banner || w1440?.cookie_banner) : null,
    overflow_390: w390 ? !!w390.overflow_x : null,
    jsonld_types: f ? [...new Set(f.jsonld.flatMap(j => j.types || []))] : null,
    fonts: f ? [...new Set([f.fonts.h1, f.fonts.body].filter(Boolean))] : null,
    cta_first_screen_390: w390 ? (w390.cta_first_screen || []).length > 0 : null,
    // hints for the card (rival-analyst checks them on the frames): ways to leave a request, legal entity + tax id in text
    lead_mechanic: f ? (() => {
      const all = cap.pages.map(p => p.facts).filter(Boolean);
      const m = [];
      if (all.some(x => (x.forms || []).some(fm => fm.contact && !fm.search))) m.push(T('форма', 'form'));
      if (all.some(x => x.quiz)) m.push(T('квиз', 'quiz'));
      if (all.some(x => x.contacts?.bot_links > 0)) m.push(T('бот', 'bot'));
      if (all.some(x => (x.contacts?.messengers || []).some(n => ['telegram', 'whatsapp', 'viber', 'max'].includes(n)))) m.push(T('мессенджер', 'messenger'));
      if (all.some(x => x.contacts?.tel_links > 0)) m.push(T('звонок', 'call'));
      if (all.some(x => (x.contacts?.booking || []).length)) m.push(T('онлайн-запись', 'online booking'));
      return m;
    })() : null,
    legal_entity_visible: f ? cap.pages.some(p => p.facts?.legal?.entity && p.facts?.legal?.tax_id) : null,
  };
  cap.facts_auto_defs = {
    cta_header: T('есть ли в шапке ссылка/кнопка с глаголом действия (записаться, заказать, купить…), 1440', 'an action link/button in the header (1440)'),
    forms: T('число форм на главной хотя бы с одним полем, кроме поиска (включая скрытые в попапах)', 'forms on the home page with at least one field, search excluded (popups included)'),
    pages_by_template: T('адреса sitemap по первому сегменту пути («/blog/*»); {} — sitemap нет или пуст', 'sitemap URLs by first path segment; {} — no sitemap'),
    stack: T('платформа по признакам в HTML/заголовках; "unknown" — признаков нет (свой движок или не распознана); null — главная не снята', 'platform by HTML/headers signals; "unknown" — no signals (custom or not recognised); null — home not captured'),
    home_screens_390: T('длина главной в экранах на 390 (высота документа / 844)', 'home page length in screens at 390 (document height / 844)'),
    lead_mechanic: T('подсказка по коду снятых страниц: форма с контактами, квиз, бот, мессенджер, звонок (tel:), онлайн-запись — сверить по кадрам', 'hint from the captured pages: contact form, quiz, bot, messenger, call, online booking — check on the frames'),
    legal_entity_visible: T('в тексте снятых страниц есть юрлицо/ИП и ИНН/ОГРН (true) или нет (false)', 'a legal entity and a tax id in the text of captured pages'),
    lcp_mobile: T('LCP главной на 390 в лаборатории без замедления сети, мс (сравнивать только между собой)', 'lab LCP at 390, ms, no throttling (compare only with each other)'),
  };
  cap.hints = f ? { prices: f.prices, first_screen_text: f.first_screen_text, h1: f.headings.h1[0] || null, ctas_top: f.ctas.slice(0, 6).map(c => `${c.text} ×${c.count}`) } : null;
}

// ---------- summarize ----------
function summarize() {
  if (!existsSync(RIVALS)) fail(2, 'Нет папки rivals/ — сначала снимок: --urls …', 'No rivals/ folder — capture first with --urls.');
  const hosts = readdirSync(RIVALS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort();
  const sites = [];
  for (const hk of hosts) {
    const card = readOpt(join(RIVALS, hk, 'card.json'));
    const cap = readOpt(join(RIVALS, hk, 'capture.json'));
    if (!card && !cap) continue;
    const facts = {}, source = {};
    const auto = cap?.facts_auto || {};
    const keys = new Set([...Object.keys(card?.facts || {}), ...Object.keys(auto).filter(k => k !== 'blocked')]);
    for (const k of keys) {
      const cv = card?.facts?.[k], av = auto[k];
      if (cv !== undefined && cv !== null) { facts[k] = cv; source[k] = 'card'; }
      else if (av !== undefined && av !== null) { facts[k] = av; source[k] = 'auto'; }
      else facts[k] = null;
    }
    sites.push({ host: hk, url: card?.url || cap?.url || null, ours: hk === oursKey || !!cap?.ours, group: card?.group || null, blocked: cap?.blocked || null, has_card: !!card, facts, source,
      finds: Array.isArray(card?.finds) ? card.finds : [] });
  }
  if (!sites.length) fail(2, 'В rivals/ нет ни card.json, ни capture.json.', 'No card.json or capture.json in rivals/.');
  const rivals = sites.filter(s => !s.ours && !s.blocked);
  const ours = sites.find(s => s.ours) || null;
  const fields = {};
  const allKeys = [...new Set(sites.flatMap(s => Object.keys(s.facts)))].sort();
  const kindOf = vals => { const v = vals.find(x => x !== null && x !== undefined); return v === undefined ? 'unknown' : typeof v === 'boolean' ? 'bool' : typeof v === 'number' ? 'number' : Array.isArray(v) ? 'list' : typeof v === 'object' ? 'object' : 'text'; };
  const fmtNum = n => (Math.round(n * 10) / 10).toLocaleString(lang === 'en' ? 'en-US' : 'ru-RU');
  const statFor = (list, field, kind) => {
    const checked = list.filter(s => s.facts[field] !== null && s.facts[field] !== undefined);
    // "unknown"/"нет"-like text is a checked "no" (e.g. stack: no platform signals)
    const yes = checked.filter(s => { const v = s.facts[field]; return kind === 'bool' ? v === true : kind === 'number' ? v > 0 : kind === 'list' ? v.length > 0 : kind === 'object' ? Object.keys(v).length > 0 : !/^(|unknown|none|нет|не определена|не найдено)$/i.test(String(v).trim()); });
    return { n: yes.length, m: checked.length, yes: yes.map(s => s.host), no: checked.filter(s => !yes.includes(s)).map(s => s.host), not_checked: list.filter(s => !checked.includes(s)).map(s => s.host) };
  };
  for (const field of allKeys) {
    const kind = kindOf(sites.map(s => s.facts[field]));
    const st = statFor(rivals, field, kind);
    // numbers: "N of M" means nothing — only how many were measured, the median and the spread
    const entry = { kind, n: kind === 'number' ? null : st.n, m: st.m, line: kind === 'number' ? T(`замерено у ${st.m}`, `measured on ${st.m}`) : T(`у ${st.n} из ${st.m}`, `${st.n} of ${st.m}`),
      yes: kind === 'number' ? undefined : st.yes, no: kind === 'number' ? undefined : st.no, not_checked: st.not_checked, ours: ours ? (ours.facts[field] ?? null) : null };
    const checked = rivals.filter(s => s.facts[field] !== null && s.facts[field] !== undefined);
    if (kind === 'number') {
      const nums = checked.map(s => Number(s.facts[field])).filter(Number.isFinite).sort((a, b) => a - b);
      if (nums.length) entry.stats = { median: U.median(nums), min: nums[0], max: nums[nums.length - 1] };
      entry.values = checked.map(s => ({ host: s.host, value: s.facts[field] }));
      if (ours && typeof ours.facts[field] === 'number' && nums.length) entry.ours_rank = 1 + nums.filter(x => x < ours.facts[field]).length;
    } else if (kind === 'text') {
      const freq = new Map();
      for (const s of checked) { const v = String(s.facts[field]).trim(); if (!v) continue; const e = freq.get(v.toLowerCase()) || { value: v, count: 0, hosts: [] }; e.count++; e.hosts.push(s.host); freq.set(v.toLowerCase(), e); }
      entry.values = [...freq.values()].sort((a, b) => b.count - a.count).slice(0, 15);
    } else if (kind === 'list' || kind === 'object') {
      const freq = new Map();
      for (const s of checked) {
        const items = kind === 'list' ? s.facts[field] : Object.keys(s.facts[field]);
        for (const x of new Set(items.map(v => (typeof v === 'string' ? v.trim() : JSON.stringify(v))))) { const e = freq.get(x.toLowerCase()) || { value: x, count: 0, hosts: [] }; e.count++; e.hosts.push(s.host); freq.set(x.toLowerCase(), e); }
      }
      entry.values = [...freq.values()].sort((a, b) => b.count - a.count).slice(0, 20).map(e => ({ ...e, line: T(`у ${e.count} из ${checked.length}`, `${e.count} of ${checked.length}`) }));
    }
    const groups = [...new Set(rivals.map(s => s.group).filter(Boolean))];
    if (groups.length > 1) entry.by_group = Object.fromEntries(groups.map(g => {
      const list = rivals.filter(s => s.group === g);
      if (kind === 'number') { const xs = list.map(s => s.facts[field]).filter(x => typeof x === 'number' && Number.isFinite(x)); return [g, { m: xs.length, median: xs.length ? U.median(xs) : null, line: xs.length ? T(`медиана ${fmtNum(U.median(xs))} (замерено у ${xs.length})`, `median ${fmtNum(U.median(xs))} (${xs.length} measured)`) : T('не замерено', 'not measured') }]; }
      const x = statFor(list, field, kind); return [g, { n: x.n, m: x.m, line: T(`у ${x.n} из ${x.m}`, `${x.n} of ${x.m}`) }];
    }));
    entry.sources = { card: rivals.filter(s => s.source[field] === 'card').length, auto: rivals.filter(s => s.source[field] === 'auto').length };
    fields[field] = entry;
  }
  // finds by block type (for best-of)
  const blocks = {};
  for (const s of rivals) for (const f of s.finds) {
    const b = f.block_type || 'other';
    blocks[b] ||= { take: 0, adapt: 0, avoid: 0, hosts: [] };
    if (['take', 'adapt', 'avoid'].includes(f.kind)) blocks[b][f.kind]++;
    if (!blocks[b].hosts.includes(s.host)) blocks[b].hosts.push(s.host);
  }
  const showVal = (v, kind) => (v === null || v === undefined ? T('не проверено', 'not checked') : kind === 'bool' ? (v ? T('да', 'yes') : T('нет', 'no')) : kind === 'number' ? fmtNum(v)
    : kind === 'list' ? (v.length ? v.slice(0, 4).join(', ') : T('нет', 'none')) : kind === 'object' ? (Object.keys(v).length ? Object.keys(v).slice(0, 3).join(', ') : T('нет', 'none')) : String(v).slice(0, 40));
  const lines = [];
  for (const [k, e] of Object.entries(fields)) {
    let l = `${k}: ${e.line}`;
    if (e.not_checked.length) l += T(` (не проверено у ${e.not_checked.length})`, ` (not checked: ${e.not_checked.length})`);
    if (e.stats) l += T(` · медиана ${fmtNum(e.stats.median)} · от ${fmtNum(e.stats.min)} до ${fmtNum(e.stats.max)}`, ` · median ${fmtNum(e.stats.median)} · ${fmtNum(e.stats.min)}–${fmtNum(e.stats.max)}`);
    else if (e.values?.length && e.kind !== 'bool') l += T(' · чаще: ', ' · top: ') + e.values.slice(0, 3).map(v => `${String(v.value).slice(0, 24)} (${v.count})`).join(', ');
    if (ours) l += T(` · у нас: `, ` · ours: `) + showVal(e.ours, e.kind);
    e.summary_line = l;
    lines.push(l);
  }
  const doc = { tool: 'rivals-summary', version: U.VERSION, run, generated: U.nowIso(), ours: ours?.host || null, m_total: rivals.length,
    sites: sites.map(s => ({ host: s.host, url: s.url, ours: s.ours, group: s.group, blocked: s.blocked, has_card: s.has_card, source: s.source })),
    excluded: sites.filter(s => s.blocked && !s.ours).map(s => ({ host: s.host, why: s.blocked })), fields, finds_by_block: blocks, lines };
  U.writeJSON(U.insideRun(run, 'rivals', 'summary.json'), doc);
  U.log(run, `rivals: свод по ${rivals.length} сайтам, фактов ${allKeys.length}`);
  const noCard = rivals.filter(s => !s.has_card).length;
  const out = [T(`rivals: свод «у N из M» · конкурентов ${rivals.length}${ours ? ` + наш (${ours.host})` : ''}${doc.excluded.length ? ` · исключены (закрыты): ${doc.excluded.length}` : ''}${noCard ? ` · без карточки (факты скрипта): ${noCard}` : ''}`,
    `rivals: "N of M" summary · rivals ${rivals.length}${ours ? ` + ours (${ours.host})` : ''}${doc.excluded.length ? ` · excluded (closed): ${doc.excluded.length}` : ''}${noCard ? ` · without card (script facts): ${noCard}` : ''}`)];
  out.push(...lines.slice(0, 34).map(l => '  ' + l.slice(0, 200)));
  if (lines.length > 34) out.push(T(`  …ещё ${lines.length - 34} фактов — в summary.json`, `  …${lines.length - 34} more in summary.json`));
  out.push(`${T('Записано', 'Written')}: ${fwd(join(RIVALS, 'summary.json'))}`);
  U.printAndSaveSummary(run, 'rivals', out);
  return 0;
}

const main = args.summarize ? async () => summarize() : capture;
main().then(code => process.exit(code || 0)).catch(e => {
  console.error(T('rivals: сбой — ', 'rivals: failure — ') + (e?.stack || e));
  try { U.log(run, `rivals: сбой ${String(e?.message || e).slice(0, 200)}`); } catch { /* ignore */ }
  process.exit(/браузер|browser|Chromium|Node\.js 22|слота/i.test(String(e?.message)) ? 2 : 1);
});
