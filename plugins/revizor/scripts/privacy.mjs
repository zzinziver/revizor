#!/usr/bin/env node
// Revizor — privacy.mjs: what a first visit gives away before any click. Fresh browser profile per page, no clicks:
// cookies (Network.getAllCookies), localStorage/sessionStorage/IndexedDB/Cache Storage/service workers, third-party
// hosts → categories (built-in list, util.classifyThirdParty), ATTEMPTS of counters / call tracking / chats that the
// safety net cut (page.blocked — data, not errors), cookie banner on 1440 and on a 390 phone (buttons, is there a
// "Reject", equal prominence), cross-border transfer (foreign services and a foreign CDN in front of the whole site),
// session recording and field masking, fingerprinting APIs and permission requests at load, embeds, policy vs reality.
// --reject-test: one more fresh profile, a real click ONLY on a reject button from the dictionary («Отклонить»,
// «Только необходимые», «Reject», «Decline» and close synonyms), never "Accept"; no such button → no_reject_button.
//
// Also a module: perf.mjs imports the consent dictionaries and the in-page banner finder (BANNER_LIB) from here,
// so both scripts recognise the same cookie banners. main() runs only when the file is executed directly.
//
//   node privacy.mjs --run "<RUN>" [--pages home,p03] [--max-pages 3] [--reject-test] [--wait-sec 4] [--width 1440]
//                    [--budget-sec 480] [--fresh] [--lang ru|en]

import { join, relative, sep, resolve } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Browser } from './lib/cdp.mjs';
import { parseHtml, closeDomTab } from './lib/dom.mjs';
import * as U from './lib/util.mjs';

const NAME = 'privacy';
const HELP = `
privacy.mjs — приватность первого захода: cookie, хранилища, сторонние сервисы, баннер, отказ (линза privacy; данные для forms, security, legal)

  node privacy.mjs --run "<RUN>" [флаги]

Что делает (только чтение; новый профиль браузера на каждую страницу; без кликов):
  · cookie после загрузки (все домены): имя, домен, срок, флаги, первая/сторонняя, к какому сервису относится;
  · localStorage и sessionStorage: ключи и размер (значения не сохраняем; помечаем «похоже на e-mail/телефон/токен»),
    IndexedDB, Cache Storage, service worker;
  · сторонние хосты: что за сервис (аналитика, реклама, запись сессий, чат, коллтрекинг, шрифты, видео, карты…),
    сколько запросов, загружен или только попытка (счётчики, коллтрекинг и чаты страховка не пускает — их попытки
    записываются, это данные о том, что сайт отправил бы посетителю до согласия);
  · cookie-баннер на 1440 и отдельно на телефоне 390×844 (banner_390): найден ли, текст, кнопки (принять / отклонить /
    настроить / закрыть) и ссылки отдельно, «Отклонить» не мельче «Принять», ссылка на политику, доля экрана;
  · трансграничная передача: зарубежные сервисы, которым уходит хотя бы IP и адрес страницы (по встроенному справочнику),
    и зарубежный CDN/прокси перед всем сайтом (по заголовкам ответа: first_party_infra);
  · запись сессий (Вебвизор, Hotjar, Clarity и др.: по попыткам и коду на странице) и маскировка полей с ПДн;
  · fingerprinting: чтение canvas вне документа, WebGL renderer, OfflineAudioContext, перебор шрифтов;
    запросы разрешений при загрузке (геолокация, уведомления, камера, push, буфер обмена);
  · встройки (YouTube, карты, соцсети) и nocookie-варианты; Google Consent Mode в коде;
  · политика конфиденциальности: какие найденные сервисы и cookie в ней не названы (только страницы своего сайта).
  --reject-test: ещё один новый профиль, реальный клик ТОЛЬКО по кнопке отказа из словаря («Отклонить», «Только
    необходимые», «Reject», «Decline» и близкие); «Принять» и «Принять только необходимые» не нажимаются никогда;
    перед кликом — проверка, что под точкой та же кнопка отказа; затем: что загрузилось после отказа, новые cookie,
    пропал ли баннер, помнит ли сайт выбор после перезагрузки. Если сайт сохраняет выбор запросом на сервер
    (POST или фоновый запрос), страховка его отрезает → choice_remembered: null, «проверить вручную».

Флаги:
  --run <папка>      папка прогона (обязательно)
  --pages a,b        страницы (по умолчанию главная + страницы с формами/контактами, всего --max-pages)
  --max-pages N      по умолчанию 3
  --reject-test      проверка отказа (в full включает pipeline)
  --wait-sec N       сколько ждать после загрузки отложенные скрипты (по умолчанию 4)
  --width N          ширина окна (по умолчанию 1440)
  --no-mobile        без второго осмотра баннера на 390 px
  --allow-load-posts пропускать не-GET во время загрузки (SPA)
  --url <адрес>      если pages.json ещё нет: одна страница
  --budget-sec N     стоп до таймаута (по умолчанию 480); частичный результат и код 75, повтор продолжит
  --fresh            начать заново;  --lang ru|en  язык сводки
Пишет: measure/privacy.json, stdout/privacy.md. Коды: 0 готово, 75 частично, 2 аргументы/окружение, 1 сбой или ни одна страница не загрузилась.
`;

// ---------- consent dictionaries (shared with perf.mjs) ----------
// cookie wording only: a form's "consent to personal data processing" is not a cookie banner.
// \b does not work next to Cyrillic letters in JS — letter lookarounds with the u flag instead.
export const COOKIE_RE = /cookie|(?<!\p{L})кук(?:и|ам|ами|ах|ой|у|а)?(?!\p{L})|gdpr|consent to (?:the )?(?:use of )?cookies|cookie consent|файл(?:ы|ов|ами|ах) cookie|метрическ(?:ие|их) (?:программ|данн)/iu;
// "accept" buttons — never pressed by any Revizor script (matched against normalised text: lower case, ё→е, trimmed)
export const ACCEPT_RE = /^(?:(?:я )?(?:принять|принимаю|согласен|согласна|согласиться|соглашаюсь|разрешить|accept|allow|agree|i agree|i accept)(?:(?: и| and|,| &)? (?:все|всё|all|закрыть|close|продолжить|continue))*(?: (?:cookie|cookies|куки|файлы cookie|cookie-файлы))?|(?:хорошо|ок|ok|okay|понятно|ясно|да|yes|got it|i understand|understood|continue|продолжить)(?:,? (?:спасибо|понятно|thanks|thank you))?)$/iu;
// the only buttons the reject test may click (no "accept" word in any of them)
export const REJECT_RE = /^(?:(?:отклонить|отказаться|запретить|не принимать|не соглашаюсь|не согласен|не согласна|reject|decline|deny|refuse|disagree)(?: (?:все|всё|all|необязательные|дополнительные|опциональные|остальные|optional|non-essential|nonessential|non-necessary|additional|others?))?(?: (?:cookie|cookies|куки|файлы cookie|cookie-файлы))?|отказаться от (?:всех|необязательных|дополнительных)(?: cookie| куки| файлов cookie)?|(?:только|лишь) (?:необходимые|обязательные|технические|функциональные|основные)(?: cookie| куки| файлы cookie)?|only (?:necessary|essential|required|strictly necessary)(?: cookies)?|(?:strictly )?(?:necessary|essential|required)(?: cookies)? only|use (?:only )?(?:necessary|essential) cookies(?: only)?|продолжить без (?:согласия|cookie|куки|принятия)|continue without (?:accepting|agreeing|consent|cookies)|нет(?:,? спасибо)?|no(?:,? thanks)?)$/iu;
// a reject option named "Accept …": counts as a reject option, never clicked (it starts with "accept")
export const REJECT_EQUIV_RE = /^(?:принять|разрешить|accept|allow)(?: только)? (?:необходимые|обязательные|технические|функциональные|necessary|essential|required|strictly necessary)(?: cookie| cookies| куки| файлы cookie)?(?: only)?$|^(?:accept|allow) only (?:necessary|essential|required)(?: cookies)?$/iu;
const SETTINGS_RE = /(настро|параметр|подробн|выбрать|управл|customi[sz]e|settings|preferences|manage|options|more info|learn more)/iu;
const CLOSE_RE = /^(?:×|✕|✖|x|закрыть|close|dismiss)$/iu;
const MASK_SEL = '.ym-disable-keys, .ym-hide-content, [data-hj-suppress], .data-hj-suppress, [data-clarity-mask], .fs-exclude, .fs-mask, [data-private], .smartlook-hide';
export const reSrc = re => [re.source, re.flags];
export const RE_SRC = { cookie: reSrc(COOKIE_RE), accept: reSrc(ACCEPT_RE), reject: reSrc(REJECT_RE), equiv: reSrc(REJECT_EQUIV_RE), settings: reSrc(SETTINGS_RE), close: reSrc(CLOSE_RE), mask: MASK_SEL };
export const normText = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s ]+/g, ' ').replace(/^[\s«»"'.,:;!?()\-–—]+|[\s«»"'.,:;!?()\-–—✓✔→×✕✖]+$/g, '').trim();

// In-page helper (runs in the page's isolated world; passed by source into DOM_SCAN here and INP_CANDS in perf.mjs).
// blocks(): cookie/consent blocks — the deepest element with cookie wording, lifted to the banner container: up while
// the ancestor adds controls or is a thin wrapper, its text stays ≤ 1.6× + 200 chars, and it holds no page structure
// (main, nav, h1, h2, form…), whatever its position. Controls (button, [role=button], input buttons, <a> without a real
// address) and links (<a> to another address) are kept apart.
export function BANNER_LIB(src) {
  const rx = k => new RegExp(src[k][0], src[k][1]);
  const COOKIE = rx('cookie');
  const SIG = /cookie|consent|gdpr|(?:^|[\s_-])cmp(?:[\s_-]|$)|onetrust|cookiebot|usercentrics|didomi|cookieyes|complianz|iubenda|termly|privacy-?banner|cookie-?law|cc-?(?:banner|window)/i;
  const parentOf = el => el.parentElement || (el.parentNode && el.parentNode.host) || null;
  const sig = el => { let c = el.className; c = typeof c === 'string' ? c : (c && c.baseVal) || ''; return ((el.id || '') + ' ' + c + ' ' + ((el.getAttribute && el.getAttribute('aria-label')) || '')).toLowerCase(); };
  const norm = s => String(s || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s ]+/g, ' ').replace(/^[\s«»"'.,:;!?()\-–—]+|[\s«»"'.,:;!?()\-–—✓✔→×✕✖]+$/g, '').trim();
  const visible = el => { const r = el.getBoundingClientRect(); if (r.width < 2 || r.height < 2) return false; const cs = getComputedStyle(el); return cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) > 0.05; };
  const tlen = el => String(el.innerText || '').length;
  const sel = el => { const p = []; let c = el; for (let d = 0; c && c.nodeType === 1 && d < 4; d++) { if (c.id && /^[A-Za-z][\w-]{0,40}$/.test(c.id)) { p.unshift('#' + c.id); break; }
    let s = c.tagName.toLowerCase(); const cn = typeof c.className === 'string' ? c.className.split(/\s+/).filter(x => /^[A-Za-z_][\w-]{0,40}$/.test(x)).slice(0, 2) : []; if (cn.length) s += '.' + cn.join('.'); p.unshift(s); if (c.tagName === 'BODY') break; c = parentOf(c); } return p.join(' > ').slice(0, 160); };
  const realHref = a => { const h = String(a.getAttribute('href') || '').trim(); return !!h && h[0] !== '#' && !/^javascript:/i.test(h); };
  const isBtn = el => {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'A') return !realHref(el);
    if (el.matches('button, [role=button], input[type=button], input[type=submit]')) return true;
    if (el.hasAttribute('tabindex') && el.getAttribute('tabindex') !== '-1' && !el.querySelector('button, a, input, [tabindex]')) { const t = String(el.innerText || '').trim(); return t.length > 0 && t.length <= 40; }
    return false;
  };
  const controls = el => { const out = []; for (const c of el.querySelectorAll('button, [role=button], input[type=button], input[type=submit], a, [tabindex]')) { if (isBtn(c) && !out.some(o => o.contains(c))) out.push(c); if (out.length >= 20) break; } return out; };
  const linksIn = el => [...el.querySelectorAll('a[href]')].filter(realHref).slice(0, 10);
  const STRUCT = 'main, nav, h1, h2, form, details, article, header, footer, [role=tablist], [role=navigation], [role=main]';
  const hasStruct = el => el.matches(STRUCT) || !!el.querySelector(STRUCT);
  const lift = el => {
    const base = Math.max(tlen(el), 1); let cur = el, n = controls(el).length;
    for (let a = parentOf(el), d = 0; a && a.nodeType === 1 && d < 8; a = parentOf(a), d++) {
      if (a === document.body || a === document.documentElement) break;
      const at = tlen(a); if (at > base * 1.6 + 200) break;
      if (hasStruct(a) && !hasStruct(cur)) break;
      const an = controls(a).length; const pos = getComputedStyle(a).position;
      if (an > n || at <= tlen(cur) + 40 || pos === 'fixed' || pos === 'sticky') { cur = a; n = an; if (pos === 'fixed' || pos === 'sticky') break; } else break;
    }
    return cur;
  };
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|HTML|BODY|HEAD|SVG|PATH|IFRAME)$/i;
  const all = () => { const out = []; const walk = root => { for (const el of root.querySelectorAll('*')) { if (out.length > 12000) return; out.push(el); if (el.shadowRoot) walk(el.shadowRoot); } }; walk(document); return out; };
  const blocks = ({ needVisible = true, firstScreen = false, withSig = false } = {}) => {
    const vh = innerHeight; const found = [];
    const add = el => { if (found.some(f => f === el || f.contains(el))) return; for (let k = found.length - 1; k >= 0; k--) if (el.contains(found[k])) found.splice(k, 1); found.push(el); };
    for (const el of all()) {
      if (SKIP.test(el.tagName)) continue;
      const tc = el.textContent || '';
      let b = null;
      if (tc.length <= 8000 && COOKIE.test(tc) && ![...el.children].some(c => !SKIP.test(c.tagName) && COOKIE.test(c.textContent || ''))) {
        const t = el.innerText || '';
        if (t && t.length <= 2500 && COOKIE.test(t) && (!needVisible || visible(el))) b = lift(el);
      }
      // consent platforms by their id/class (hidden ones too: they may slide in later)
      if (!b && withSig && SIG.test(sig(el)) && tlen(el) <= 2500 && !hasStruct(el) && controls(el).length) b = el;
      if (!b) continue;
      if (needVisible && !visible(b)) continue;
      if (firstScreen) { const r = b.getBoundingClientRect(); if (r.bottom <= 0 || r.top >= vh) continue; }
      add(b);
    }
    return found.map(el => ({ el, text: String(el.innerText || '').replace(/\s+/g, ' ').trim(), controls: controls(el), links: linksIn(el) }));
  };
  return { blocks, controls, linksIn, isBtn, realHref, norm, visible, sig, sel, parentOf, COOKIE };
}

const T = {
  ru: {
    title: 'privacy.mjs — приватность первого захода (новый профиль, без кликов)', titleReject: 'privacy.mjs — приватность первого захода (новый профиль; единственный клик — кнопка отказа)',
    noPages: 'Страницы не загрузились — приватность не проверена (ошибки ниже)', noPagesNc: 'приватность: ни одна страница не загрузилась — проверок нет', partial: 'ЧАСТИЧНО (бюджет времени) — повторите тот же вызов, продолжит',
    banner: 'Cookie-баннер', none: 'нет', found: 'есть', buttons: 'кнопки', reject: '«Отклонить»', noReject: 'кнопки отказа нет', equal: 'не мельче «Принять»', smaller: 'мельче «Принять»',
    equivOnly: 'отказ есть, но назван «Принять …» (', rejectLink: 'отказ — ссылкой на другую страницу',
    phone: 'На телефоне 390', ofScreen: 'экрана', blocksPage: 'закрывает страницу', rejectBelow: '«Отклонить» за пределами первого экрана',
    cookies: 'Cookie', third: 'сторонних', long: 'дольше 13 мес.', storage: 'Хранилища', piiLike: 'похоже на ПДн/токен', before: 'До согласия (попытки и загрузки)',
    attempts: 'Попытки, отрезанные страховкой', cross: 'Зарубежные сервисы', recording: 'Запись сессий', fields: 'полей с ПДн', masked: 'замаскировано', fp: 'Fingerprinting', perms: 'Разрешения при загрузке',
    embeds: 'Встройки', rejectTest: 'Проверка отказа', clicked: 'нажата', after: 'после отказа грузится', afterReload: 'после перезагрузки снова пытаются', remembered: 'выбор запомнен', notRemembered: 'после перезагрузки баннер снова', bannerGone: 'баннер скрылся',
    serverChoice: 'выбор сайт сохраняет запросом на сервер, страховка его отрезала — без отправки не проверить, проверить вручную',
    policy: 'Политика', notNamed: 'не названы', allNamed: 'все найденные сервисы названы', noPolicy: 'ссылку на политику не нашли', consentMode: 'Consent Mode', pages: 'Страницы',
    written: 'Записано', errors: 'Ошибки', notChecked: 'Не проверено', yes: 'да', no: 'нет', notRun: 'не запускали (нужен --reject-test)', notYet: 'ещё не дошли — повторите вызов', wholeSite: 'сайт целиком',
  },
  en: {
    title: 'privacy.mjs — first-visit privacy (fresh profile, no clicks)', titleReject: 'privacy.mjs — first-visit privacy (fresh profile; the only click is the reject button)',
    noPages: 'No page loaded — privacy not checked (errors below)', noPagesNc: 'privacy: no page loaded — nothing checked', partial: 'PARTIAL (time budget) — rerun the same command to continue',
    banner: 'Cookie banner', none: 'none', found: 'found', buttons: 'buttons', reject: '"Reject"', noReject: 'no reject button', equal: 'as prominent as "Accept"', smaller: 'smaller than "Accept"',
    equivOnly: 'a reject option exists but is named "Accept …" (', rejectLink: 'reject is a link to another page',
    phone: 'On a 390 phone', ofScreen: 'of the screen', blocksPage: 'blocks the page', rejectBelow: '"Reject" is outside the first screen',
    cookies: 'Cookies', third: 'third-party', long: 'longer than 13 months', storage: 'Storage', piiLike: 'looks like personal data/token', before: 'Before consent (attempts and loads)',
    attempts: 'Attempts cut by the safety net', cross: 'Foreign services', recording: 'Session recording', fields: 'personal-data fields', masked: 'masked', fp: 'Fingerprinting', perms: 'Permissions at load',
    embeds: 'Embeds', rejectTest: 'Reject test', clicked: 'clicked', after: 'loads after reject', afterReload: 'try again after reload', remembered: 'choice remembered', notRemembered: 'banner again after reload', bannerGone: 'banner hidden',
    serverChoice: 'the site saves the choice with a server request that the safety net cut — cannot be verified without sending it, check manually',
    policy: 'Policy', notNamed: 'not named', allNamed: 'all detected services are named', noPolicy: 'no policy link found', consentMode: 'Consent Mode', pages: 'Pages',
    written: 'Written', errors: 'Errors', notChecked: 'Not checked', yes: 'yes', no: 'no', notRun: 'not run (needs --reject-test)', notYet: 'not reached yet — rerun to continue', wholeSite: 'whole site',
  },
};

// ---------- in-page code ----------
const PRIV_INIT = `(() => { if (window.__rvPriv) return;
  const P = window.__rvPriv = { canvas: {}, webgl: {}, audio: {}, fontSets: {}, perms: [], perm_queries: [], sw: [] };
  const who = () => { try { const st = String(new Error().stack || '').split('\\n').slice(2);
      for (const l of st) { const m = l.match(/(https?:\\/\\/[^\\s()]+?)(?::\\d+){1,2}\\)?\\s*$/); if (m) { const u = m[1].split(/[?#]/)[0]; return u === location.href.split(/[?#]/)[0] ? 'inline' : u.slice(0, 200); } } } catch (e) {} return 'inline'; };
  const bump = (o, k) => { o[k] = (o[k] || 0) + 1; };
  try { const C = HTMLCanvasElement.prototype; for (const k of ['toDataURL', 'toBlob']) { const o = C[k]; C[k] = function () { try { if (!this.isConnected && this.width * this.height > 16) bump(P.canvas, who()); } catch (e) {} return o.apply(this, arguments); }; }
    const X = CanvasRenderingContext2D.prototype; const g = X.getImageData; X.getImageData = function () { try { if (this.canvas && !this.canvas.isConnected) bump(P.canvas, who()); } catch (e) {} return g.apply(this, arguments); };
    const mt = X.measureText; X.measureText = function () { try { const w = who(); const s = (P.fontSets[w] ||= {}); if (Object.keys(s).length < 400) s[String(this.font).replace(/^.*?\\d+(px|pt|em)\\s+/, '')] = 1; } catch (e) {} return mt.apply(this, arguments); }; } catch (e) {}
  try { for (const Ctx of [window.WebGLRenderingContext, window.WebGL2RenderingContext].filter(Boolean)) { const gp = Ctx.prototype.getParameter;
      Ctx.prototype.getParameter = function (p) { try { if (p === 37445 || p === 37446) bump(P.webgl, who()); } catch (e) {} return gp.apply(this, arguments); }; } } catch (e) {}
  try { const O = window.OfflineAudioContext; if (O) { const W = function () { try { bump(P.audio, who()); } catch (e) {} return new O(...arguments); }; W.prototype = O.prototype; window.OfflineAudioContext = W; } } catch (e) {}
  const perm = api => { if (P.perms.length < 30) P.perms.push({ api, by: who(), t: Math.round(performance.now()) }); };
  try { const G = navigator.geolocation; if (G) for (const k of ['getCurrentPosition', 'watchPosition']) { const o = G[k]; G[k] = function () { perm('geolocation'); return o.apply(G, arguments); }; } } catch (e) {}
  try { if (window.Notification && Notification.requestPermission) { const o = Notification.requestPermission; Notification.requestPermission = function () { perm('notifications'); return o.apply(Notification, arguments); }; } } catch (e) {}
  try { const md = navigator.mediaDevices; if (md && md.getUserMedia) { const o = md.getUserMedia; md.getUserMedia = function () { perm('camera/microphone'); return o.apply(md, arguments); }; } } catch (e) {}
  try { if (window.PushManager) { const o = PushManager.prototype.subscribe; PushManager.prototype.subscribe = function () { perm('push'); return o.apply(this, arguments); }; } } catch (e) {}
  try { const cb = navigator.clipboard; if (cb && cb.readText) { const o = cb.readText; cb.readText = function () { perm('clipboard-read'); return o.apply(cb, arguments); }; } } catch (e) {}
  try { const sw = navigator.serviceWorker; if (sw && sw.register) { const o = sw.register; sw.register = function (u) { if (P.sw.length < 10) P.sw.push(String(u).slice(0, 200)); return o.apply(sw, arguments); }; } } catch (e) {}
  try { const pq = navigator.permissions; if (pq && pq.query) { const o = pq.query; pq.query = function (d) { if (P.perm_queries.length < 20) P.perm_queries.push(d && d.name); return o.apply(pq, arguments); }; } } catch (e) {}
})();`;

async function STORAGE() {
  const looks = (k, v) => { v = String(v || '');
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(v)) return 'email';
    if (/(\+7|\b8)[\s(-]*\d{3}[\s)-]*\d{3}[\s-]*\d{2}[\s-]*\d{2}\b/.test(v) || /\+\d{10,14}\b/.test(v)) return 'phone';
    if (/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\./.test(v)) return 'jwt';
    if (/(token|secret|passw|session|auth)/i.test(k)) return 'token-like key';
    return null; };
  const dump = s => { const out = []; try { for (let i = 0; i < Math.min(s.length, 80); i++) { const k = s.key(i); const v = s.getItem(k) || ''; out.push({ key: k.slice(0, 80), size: v.length, looks_like: looks(k, v) }); } } catch (e) { return { error: String(e).slice(0, 80) }; } return out; };
  const res = { local: dump(localStorage), session: dump(sessionStorage), indexeddb: [], cache_storage: [], service_workers: [] };
  try { if (indexedDB.databases) res.indexeddb = (await indexedDB.databases()).map(d => d.name).slice(0, 20); } catch (e) {}
  try { if (window.caches) res.cache_storage = (await caches.keys()).slice(0, 20); } catch (e) {}
  try { if (navigator.serviceWorker) res.service_workers = (await navigator.serviceWorker.getRegistrations()).map(r => r.scope).slice(0, 10); } catch (e) {}
  const P = window.__rvPriv || {};
  return { ...res, priv: { canvas: P.canvas || {}, webgl: P.webgl || {}, audio: P.audio || {}, font_sets: Object.fromEntries(Object.entries(P.fontSets || {}).map(([k, v]) => [k, Object.keys(v).length])),
    perms: P.perms || [], perm_queries: P.perm_queries || [], sw_register: P.sw || [] } };
}

// Runs in the isolated world (the page can't fake what we read); LIB is BANNER_LIB passed by source.
function DOM_SCAN(re, LIB) {
  const B = LIB(re);
  const rx = k => new RegExp(re[k][0], re[k][1]);
  const ACCEPT = rx('accept'), REJECT = rx('reject'), EQUIV = rx('equiv'), SETTINGS = rx('settings'), CLOSE = rx('close');
  const vw = innerWidth, vh = innerHeight; const sel = B.sel, norm = B.norm, visible = B.visible;
  for (const e of document.querySelectorAll('[data-rv-btn]')) e.removeAttribute('data-rv-btn');
  const kindOf = (el, text) => { const n = norm(text);
    if (REJECT.test(n)) return 'reject'; if (EQUIV.test(n)) return 'reject_equivalent'; if (ACCEPT.test(n)) return 'accept';
    if (CLOSE.test(n) || /закрыть|close|dismiss/i.test(el.getAttribute('aria-label') || '')) return 'close'; if (SETTINGS.test(n)) return 'settings'; return 'other'; };
  const label = b => (b.innerText || b.value || b.getAttribute('aria-label') || b.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  // banner: among cookie blocks on the first screen, the one with the most decisive controls (accept/reject/close/settings), then the shortest
  let best = null;
  for (const blk of B.blocks({ needVisible: true, firstScreen: true, withSig: true })) {
    const ctl = blk.controls.filter(visible);
    const kinds = ctl.map(c => kindOf(c, label(c)));
    const decisive = kinds.filter(k => k !== 'other').length;
    const lk = blk.links.filter(visible);
    if (!ctl.length && !lk.length) continue;
    if (!B.COOKIE.test(blk.text) && !decisive) continue; // a consent container by class only must offer a choice
    const score = decisive * 10 + ctl.length - blk.text.length / 5000;
    if (!best || score > best.score) best = { ...blk, ctl, lk, score };
  }
  let banner = null;
  if (best) {
    const el = best.el;
    const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
    const iw = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)), ih = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const btns = best.ctl.slice(0, 12).map((b, i) => {
      const text = label(b); const br = b.getBoundingClientRect(); const bcs = getComputedStyle(b);
      b.setAttribute('data-rv-btn', String(i));
      return { i, text, kind: kindOf(b, text), tag: b.tagName.toLowerCase(), x: Math.round(br.left + br.width / 2), y: Math.round(br.top + br.height / 2),
        w: Math.round(br.width), h: Math.round(br.height), in_view: br.top >= 0 && br.bottom <= vh && br.left >= 0 && br.right <= vw,
        bg: bcs.backgroundColor, color: bcs.color, weight: bcs.fontWeight, border: bcs.borderTopWidth !== '0px' && bcs.borderTopStyle !== 'none' };
    });
    const links = best.lk.slice(0, 8).map(a => { const text = label(a); const n = norm(text); return { text, href: a.href, kind: REJECT.test(n) ? 'reject' : ACCEPT.test(n) ? 'accept' : /политик|конфиденц|персональн|cookie|куки|privacy|policy|подробн/i.test(text + ' ' + a.href) ? 'policy' : 'link' }; });
    const acc = btns.find(b => b.kind === 'accept'), rej = btns.find(b => b.kind === 'reject');
    const filled = b => { const m = String(b.bg).match(/rgba?\(([^)]+)\)/); if (!m) return false; const p = m[1].split(/[\s,/]+/).filter(Boolean); return p.length < 4 || parseFloat(p[3]) > 0.1; };
    let prominence = null;
    if (acc && rej) { const aa = acc.w * acc.h, ra = rej.w * rej.h; const ratio = Math.round(100 * Math.min(aa, ra) / Math.max(1, Math.max(aa, ra))) / 100;
      prominence = { accept_area: aa, reject_area: ra, ratio, accept_filled: filled(acc), reject_filled: filled(rej), equal: ratio >= 0.6 && (filled(acc) === filled(rej) || (!filled(acc) && filled(rej))) }; }
    const policy = links.find(l => l.kind === 'policy');
    const lockScroll = /hidden|clip/.test(getComputedStyle(document.documentElement).overflow + getComputedStyle(document.body).overflow);
    const rejLink = links.find(l => l.kind === 'reject');
    banner = { found: true, selector: sel(el), position: cs.position, place: r.bottom >= vh * 0.8 ? 'bottom' : r.top <= vh * 0.2 ? 'top' : 'middle', share_pct: Math.round(1000 * iw * ih / (vw * vh)) / 10,
      text: best.text.slice(0, 400), buttons: btns, links, has_accept: !!acc, has_reject: !!rej || !!rejLink, reject_is_link: !rej && !!rejLink,
      has_reject_equivalent: btns.some(b => b.kind === 'reject_equivalent'), reject_text: rej ? rej.text : rejLink ? rejLink.text : null, accept_text: acc ? acc.text : null,
      reject_in_view: rej ? rej.in_view : null,
      has_settings: btns.some(b => b.kind === 'settings'), close_only: !acc && !rej && btns.some(b => b.kind === 'close'), prominence, policy_link: policy ? policy.href : null,
      blocks_page: iw * ih >= 0.5 * vw * vh || lockScroll, in_shadow: !document.contains(el),
      mentions: { analytics: /аналитик|метрик|статистик|analytics|statistic/i.test(best.text), ads: /реклам|маркетинг|ads|advertis|marketing/i.test(best.text), third: /третьи|сторонн|партн|third part|partners/i.test(best.text) } };
  }
  const cmpFrame = [...document.querySelectorAll('iframe')].find(f => /consent|cmp|privacy-mgmt|sp_message|cookie/i.test((f.src || '') + ' ' + (f.id || '') + ' ' + (f.title || '')) && visible(f));
  if (!banner && cmpFrame) banner = { found: true, in_iframe: true, selector: sel(cmpFrame), src: cmpFrame.src, buttons: [], links: [], has_accept: null, has_reject: null };
  // policy links anywhere
  const policyLinks = []; const seenP = new Set();
  for (const a of document.querySelectorAll('a[href]')) {
    const t = (a.innerText || a.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    if (!/политик|конфиденц|персональн|обработк[аи] данных|privacy|cookie policy|куки/i.test(t + ' ' + a.getAttribute('href'))) continue;
    if (!/^https?:/i.test(a.href) || seenP.has(a.href.split('#')[0])) continue;
    seenP.add(a.href.split('#')[0]); policyLinks.push({ href: a.href.split('#')[0], text: t.slice(0, 80) }); if (policyLinks.length >= 4) break;
  }
  // inline code signatures (counters configured on the page even when their scripts are cut)
  const code = [...document.scripts].filter(s => !s.src).map(s => s.textContent || '').join('\n').slice(0, 3000000);
  const sig = {
    metrika_inline: /\bym\s*\(\s*\d+\s*,\s*['"]init['"]/.test(code) || /mc\.yandex\.(ru|com)\/(metrika|watch)/.test(code), webvisor: /webvisor\s*['"]?\s*:\s*(true|1|!0)/i.test(code),
    gtag: /gtag\s*\(\s*['"]config['"]/.test(code), gtm: /googletagmanager\.com\/gtm\.js|GTM-[A-Z0-9]{4,}/.test(code), fb_pixel: /fbq\s*\(\s*['"]init['"]/.test(code),
    vk_pixel: /VK\.Retargeting|vk\.com\/rtrg|top-fwz1\.mail\.ru/.test(code), top_mail: /_tmr\b|top-fwz1\.mail\.ru/.test(code), tiktok: /ttq\.load\s*\(/.test(code),
    hotjar: /hjid\s*:\s*\d+|_hjSettings/.test(code), clarity: /clarity\.ms\/tag|\bclarity\s*\(\s*['"]/.test(code), smartlook: /smartlook\s*\(\s*['"]init/.test(code),
    fullstory: /_fs_org|fullstory\.com/.test(code), logrocket: /LogRocket\.init/.test(code), mouseflow: /_mfq\b/.test(code),
    consent_mode: /gtag\s*\(\s*['"]consent['"]\s*,\s*['"]default['"]/.test(code), consent_default_denied: /gtag\s*\(\s*['"]consent['"]\s*,\s*['"]default['"][\s\S]{0,400}?(ad_storage|analytics_storage)['"]?\s*:\s*['"]denied/.test(code),
  };
  // personal-data fields and masking markers (fields in hidden popups count too)
  const fields = [...document.querySelectorAll('input, textarea')].filter(f => {
    const t = (f.getAttribute('type') || 'text').toLowerCase(); if (['hidden', 'submit', 'button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset'].includes(t)) return false;
    const n = [f.name, f.id, f.getAttribute('placeholder'), f.getAttribute('autocomplete'), f.getAttribute('aria-label')].join(' ');
    return ['tel', 'email', 'password'].includes(t) || f.tagName === 'TEXTAREA' || /phone|tel|mail|name|fio|фио|имя|телефон|почт|фамил|passport|паспорт|card|карт|address|адрес|birth|рожд/i.test(n); });
  const MASK = re.mask;
  const fieldInfo = fields.slice(0, 60).map(f => ({ sel: sel(f), type: f.tagName === 'TEXTAREA' ? 'textarea' : (f.getAttribute('type') || 'text').toLowerCase(), masked: !!f.closest(MASK) || f.matches(MASK), visible: visible(f) }));
  const embeds = [...document.querySelectorAll('iframe[src], embed[src], object[data]')].slice(0, 30).map(f => ({ src: f.src || f.data || null, loading: f.getAttribute('loading'), visible: visible(f) }));
  return { banner: banner || { found: false }, policy_links: policyLinks, sig, fields: fieldInfo, fields_total: fields.length, mask_markers: document.querySelectorAll(MASK).length, embeds };
}
const SCAN_EXPR = `(${DOM_SCAN.toString()})(${JSON.stringify(RE_SRC)}, ${BANNER_LIB.toString()})`;
const scanPage = page => page.evaluateIsolated(SCAN_EXPR);

// where the reject button is now; waits until it stops moving (sliding banners), scrolls it into view if needed
function BTN_POS(i) {
  const el = document.querySelector('[data-rv-btn="' + i + '"]'); if (!el) return null;
  let r = el.getBoundingClientRect();
  if (r.top > innerHeight || r.bottom < 0) { el.scrollIntoView({ block: 'center', behavior: 'instant' }); r = el.getBoundingClientRect(); }
  const x = r.left + r.width / 2, y = r.top + r.height / 2; const at = document.elementFromPoint(x, y);
  return { x, y, w: r.width, h: r.height, hit: !!at && (at === el || el.contains(at)) };
}
function UNDER(x, y) { const at = document.elementFromPoint(x, y); const b = at && at.closest ? at.closest('[data-rv-btn]') : null; return b ? b.getAttribute('data-rv-btn') : null; }

// ---------- helpers ----------
const rel = (run, p) => relative(run, p).split(sep).join('/');
const isLocalHost = h => !h || h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '[::1]' || h === '::1';
const svcName = x => { const c = U.classifyThirdParty(x.url); return c.known ? c.name : (x.service || c.host); };
const shortUrl = u => { try { const x = new URL(u); return (x.host + x.pathname + (x.search ? '?…' : '')).slice(0, 160); } catch { return String(u).slice(0, 160); } };
const samePage = (href, base) => { try { if (/^javascript:/i.test(href)) return true; const a = new URL(href, base), b = new URL(base); return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search; } catch { return false; } };
const COOKIE_NAMES = [
  [/^_ym_|^_ym\d|^yandexuid$|^yuidss$|^ymex$|^yabs-|^i$|^yp$|^ys$/, 'Яндекс Метрика/Яндекс', 'analytics'], [/^_ga($|_)|^_gid$|^_gat|^__utm/, 'Google Analytics', 'analytics'],
  [/^_gcl_|^IDE$|^NID$|^__Secure-3P|^DSID$|^test_cookie$/, 'Google (реклама)', 'ads'], [/^_fbp$|^_fbc$|^fr$/, 'Meta', 'ads'], [/^tmr_|^_tmr/, 'Top Mail.ru / VK', 'analytics'],
  [/^_hj/, 'Hotjar', 'recording'], [/^_clck$|^_clsk$|^CLID$|^MUID$|^ANONCHK$/, 'Microsoft Clarity', 'recording'], [/^roistat/, 'Roistat', 'calltracking'], [/^_ct|^calltouch/i, 'Calltouch', 'calltracking'],
  [/^jv_|^jivo/i, 'Jivo', 'chat'], [/^__cf_bm$|^cf_clearance$|^__cflb$|^_cfuvid$/, 'Cloudflare (защита)', 'security'], [/^__ddg/, 'DDoS-Guard (защита)', 'security'],
  [/consent|cookieconsent|cookie_notice|cookielawinfo|cmplz_|OptanonConsent|OptanonAlertBoxClosed|CookieConsent|euconsent|cookie_accept|cookies_accepted|cookie-agree/i, 'согласие', 'consent'],
  [/^PHPSESSID$|^JSESSIONID$|^ASP\.NET_SessionId$|^laravel_session$|^XSRF-TOKEN$|^csrftoken$|^sessionid$|^BITRIX_SM_|^wordpress_|^wp-settings|^connect\.sid$|^session$|^sid$/i, 'сессия/функции сайта', 'functional'],
];
function cookieKind(c, siteHost) {
  const hit = COOKIE_NAMES.find(([re]) => re.test(c.name));
  const dom = String(c.domain || '').replace(/^\./, '');
  const third = U.isThirdParty(dom, siteHost);
  const svc = third ? U.classifyThirdParty(dom) : null;
  return { service: hit ? hit[1] : svc && svc.known ? svc.name : null, category: hit ? hit[2] : svc && svc.known ? svc.category : 'unknown', third_party: third };
}

// A CDN / reverse proxy in front of the whole site: every visitor's IP, page addresses, cookies and form data pass through it.
// Recognised by response headers of the document. operator: 'foreign' | 'ru' (where the company running it is based).
const INFRA = [
  [h => /cloudflare/i.test(h.server || '') || !!h['cf-ray'], 'Cloudflare', 'foreign', 'cf-ray / server: cloudflare'],
  [h => !!h['x-amz-cf-id'] || /cloudfront/i.test((h.via || '') + ' ' + (h['x-cache'] || '')), 'Amazon CloudFront', 'foreign', 'x-amz-cf-id / via: cloudfront'],
  [h => !!h['x-fastly-request-id'] || (/cache-/i.test(h['x-served-by'] || '') && /varnish/i.test(h.via || '')), 'Fastly', 'foreign', 'x-served-by / x-fastly-request-id'],
  [h => !!h['x-vercel-id'] || /vercel/i.test(h.server || ''), 'Vercel', 'foreign', 'x-vercel-id'],
  [h => !!h['x-nf-request-id'] || /netlify/i.test(h.server || ''), 'Netlify', 'foreign', 'x-nf-request-id'],
  [h => /akamai/i.test(h.server || '') || !!h['x-akamai-transformed'] || !!h['akamai-grn'], 'Akamai', 'foreign', 'server: AkamaiGHost / x-akamai-*'],
  [h => !!h['x-azure-ref'], 'Azure Front Door', 'foreign', 'x-azure-ref'],
  [h => !!h['x-github-request-id'], 'GitHub Pages', 'foreign', 'x-github-request-id'],
  [h => !!h['x-sucuri-id'], 'Sucuri', 'foreign', 'x-sucuri-id'],
  [h => /^(gws|google frontend|gse)$/i.test(h.server || '') || /\bgoogle\b/i.test(h.via || ''), 'Google Cloud', 'foreign', 'server / via: google'],
  [h => /ddos-guard/i.test(h.server || ''), 'DDoS-Guard', 'ru', 'server: ddos-guard'],
  [h => /qrator/i.test(h.server || ''), 'Qrator', 'ru', 'server: qrator'],
  [h => /stormwall/i.test(h.server || ''), 'StormWall', 'ru', 'server: stormwall'],
  [h => /ngenix/i.test((h.server || '') + ' ' + (h['x-cdn'] || '')), 'NGENIX', 'ru', 'server / x-cdn: ngenix'],
  [h => /cdnvideo/i.test(h.server || ''), 'CDNvideo', 'ru', 'server: cdnvideo'],
];
function detectInfra(headers) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const hit = INFRA.find(([test]) => { try { return test(h); } catch { return false; } });
  return hit ? { provider: hit[1], operator: hit[2], evidence: hit[3] } : null;
}

function netCollector(page) {
  const reqs = new Map(); const st = { t0: null };
  const offs = [
    page.on('Network.requestWillBeSent', p => { if (/^(data|blob):/i.test(p.request.url)) return;
      const r = reqs.get(p.requestId) || { start: p.timestamp }; r.url = p.request.url; r.type = p.type || r.type; r.method = p.request.method; if (st.t0 === null && p.type === 'Document') st.t0 = p.timestamp; reqs.set(p.requestId, r); }),
    page.on('Network.responseReceived', p => { const r = reqs.get(p.requestId); if (r) { r.status = p.response.status; const sc = Object.entries(p.response.headers || {}).find(([k]) => k.toLowerCase() === 'set-cookie'); if (sc) r.set_cookie = true; } }),
    page.on('Network.loadingFailed', p => { const r = reqs.get(p.requestId); if (r) { r.failed = p.errorText; r.cut = /BLOCKED_BY_CLIENT|ERR_ABORTED/i.test(p.errorText || ''); } }),
    page.on('Network.loadingFinished', p => { const r = reqs.get(p.requestId); if (r) r.done = true; }),
    // Set-Cookie is visible only in the extra-info event; blocked cookies (SameSite, third-party rules) are listed there too
    page.on('Network.responseReceivedExtraInfo', p => { const r = reqs.get(p.requestId); if (!r) return;
      if (Object.keys(p.headers || {}).some(k => k.toLowerCase() === 'set-cookie')) r.set_cookie = true;
      if ((p.blockedCookies || []).length) r.cookies_blocked = (r.cookies_blocked || 0) + p.blockedCookies.length; }),
  ];
  return { reqs, st, off: () => offs.forEach(f => { try { f(); } catch {} }) };
}

function thirdPartyTable(col, siteUrl, since = 0) {
  const by = new Map();
  for (const r of col.reqs.values()) {
    if (r.start < since) continue;
    if (!U.isThirdParty(r.url, siteUrl)) continue;
    const c = U.classifyThirdParty(r.url);
    const key = c.known ? `${c.name}|${c.host}` : c.host;
    const x = by.get(key) || { host: c.host, name: c.name, category: c.category, operator: c.operator, known: c.known, requests: 0, loaded: 0, attempted_cut: 0, types: new Set(), first_ms: null, set_cookie: false };
    x.requests++; if (r.cut) x.attempted_cut++; else if (!r.failed) x.loaded++;
    x.types.add(r.type || 'Other'); if (r.set_cookie) x.set_cookie = true; if (r.cookies_blocked) x.cookies_blocked_by_browser = (x.cookies_blocked_by_browser || 0) + r.cookies_blocked;
    const ms = col.st.t0 !== null ? Math.round((r.start - col.st.t0) * 1000) : null; if (ms !== null && (x.first_ms === null || ms < x.first_ms)) x.first_ms = ms;
    by.set(key, x);
  }
  return [...by.values()].map(x => ({ ...x, types: [...x.types] })).sort((a, b) => (a.first_ms ?? 1e9) - (b.first_ms ?? 1e9));
}

async function getCookies(page) {
  try { return (await page.send('Network.getAllCookies')).cookies || []; } catch { try { return (await page.send('Storage.getCookies')).cookies || []; } catch { return []; } }
}
function slimCookies(list, siteUrl) {
  const now = Date.now() / 1000; const host = U.hostOf(siteUrl);
  return list.slice(0, 150).map(c => { const k = cookieKind(c, host); const days = c.session || !(c.expires > 0) ? null : Math.round((c.expires - now) / 86400);
    return { name: c.name.slice(0, 80), domain: c.domain, path: c.path, session: !!c.session || !(c.expires > 0), days, http_only: !!c.httpOnly, secure: !!c.secure, same_site: c.sameSite || null,
      size: c.size, partitioned: !!c.partitionKey, ...k }; });
}

async function openFresh(ctx, url, { mobile = false } = {}) {
  const b = await Browser.launch();
  const page = await b.newPage({ blockNavigation: true, allowLoadPosts: ctx.allowLoadPosts });
  if (mobile) await page.setViewport({ width: 390, height: 844, mobile: true, deviceScaleFactor: 3 });
  else await page.setViewport({ width: ctx.width, height: 900, mobile: false, deviceScaleFactor: 1 });
  await page.addInitScript(PRIV_INIT);
  await page.emulateMedia({ colorScheme: 'light' }).catch(() => {}); // headless inherits the OS dark mode otherwise
  const col = netCollector(page);
  const t1 = Date.now();
  const g = await page.goto(url, { timeout: 45000, waitUntil: 'load' });
  return { b, page, col, g, load_ms: Date.now() - t1 };
}

function summarizeFp(priv) {
  const host = u => (u === 'inline' ? 'inline' : U.hostOf(u) || u);
  const agg = o => { const m = {}; for (const [k, v] of Object.entries(o || {})) { const h = host(k); m[h] = (m[h] || 0) + v; } return Object.entries(m).map(([by, calls]) => ({ by, calls })); };
  return { canvas_readback: agg(priv.canvas), webgl_renderer: agg(priv.webgl), offline_audio: agg(priv.audio),
    font_probe: Object.entries(priv.font_sets || {}).filter(([, n]) => n >= 20).map(([k, n]) => ({ by: host(k), fonts: n })) };
}
const slimBanner = b => b ? { ...b, buttons: (b.buttons || []).map(({ i, x, y, ...rest }) => rest) } : b;

async function inspectPage(pg, ctx) {
  const item = { pid: pg.pid, url: pg.url };
  const { b, page, col, g, load_ms } = await openFresh(ctx, pg.url);
  try {
    item.load_ms = load_ms;
    if (!g.ok) { item.error = g.refused || g.error || 'load failed'; return item; }
    item.status = g.status; item.final_url = g.finalUrl;
    const doc = page.responses.find(r => r.type === 'Document');
    item.first_party_infra = detectInfra(doc?.headers);
    await U.sleep(ctx.waitMs);
    const st = await page.evaluate(STORAGE).catch(e => ({ error: e.message }));
    const dom = await scanPage(page).catch(e => ({ error: e.message, banner: { found: null } }));
    const cookies = slimCookies(await getCookies(page), pg.url);
    const tp = thirdPartyTable(col, pg.url);
    item.banner = slimBanner(dom.banner);
    if (dom.error) item.scan_error = String(dom.error).slice(0, 200);
    item.cookies = cookies;
    item.cookies_count = cookies.length; item.cookies_third_party = cookies.filter(c => c.third_party).length;
    item.storage = st.error ? { error: st.error } : { local: st.local, session: st.session, indexeddb: st.indexeddb, cache_storage: st.cache_storage, service_workers: st.service_workers, sw_register_calls: st.priv.sw_register };
    item.third_party = tp;
    item.attempts = { analytics: page.blocked.analytics.slice(0, 40).map(x => ({ service: svcName(x), url: shortUrl(x.url), type: x.type })),
      widget: page.blocked.widget.slice(0, 40).map(x => ({ service: svcName(x), url: shortUrl(x.url), type: x.type })),
      writes_cut: page.blocked.write.length, navigations_cut: page.blocked.navigation.length };
    const tracking = new Set(['analytics', 'ads', 'recording', 'tag-manager', 'calltracking', 'chat', 'callback', 'social', 'video', 'widget']);
    // + any known third-party service whose domain already left cookies in the browser (maps, reviews widgets, embeds)
    const cookieApex = new Set(cookies.filter(c => c.third_party).map(c => U.registrableDomain(String(c.domain).replace(/^\./, ''))));
    const withCookies = tp.filter(t => t.known && t.category !== 'platform' && cookieApex.has(U.registrableDomain(t.host))).map(t => t.name);
    item.before_consent = [...new Set([...tp.filter(t => tracking.has(t.category)).map(t => t.name), ...withCookies, ...item.attempts.analytics.map(a => a.service), ...item.attempts.widget.map(a => a.service)])];
    const s = dom.sig || {};
    const recTools = [...new Set([...tp.filter(t => t.category === 'recording').map(t => t.name), s.webvisor ? 'Вебвизор (Яндекс Метрика)' : null, s.hotjar ? 'Hotjar' : null, s.clarity ? 'Microsoft Clarity' : null,
      s.smartlook ? 'Smartlook' : null, s.fullstory ? 'FullStory' : null, s.logrocket ? 'LogRocket' : null, s.mouseflow ? 'Mouseflow' : null].filter(Boolean))];
    item.recording = { tools: recTools, webvisor_inline: !!s.webvisor, pii_fields: dom.fields_total ?? null, masked: (dom.fields || []).filter(f => f.masked).length, mask_markers: dom.mask_markers ?? null,
      fields: (dom.fields || []).slice(0, 15), note: ctx.lang === 'en' ? 'some services mask fields by default; without access to the counter settings it is a question for the owner'
        : 'маскировку по умолчанию часть сервисов включает сама; без доступа к настройкам счётчика — вопрос владельцу' };
    item.code_signatures = s;
    item.consent_mode = { found: !!s.consent_mode, default_denied: s.consent_mode ? !!s.consent_default_denied : null };
    if (!st.error) { item.fingerprinting = summarizeFp(st.priv); item.permissions = st.priv.perms; item.permission_queries = st.priv.perm_queries; }
    item.embeds = (dom.embeds || []).filter(e => e.src && /^https?:/i.test(e.src)).map(e => { const c = U.classifyThirdParty(e.src); return { src: shortUrl(e.src), host: c.host, name: c.name, category: c.category,
      third_party: U.isThirdParty(e.src, pg.url), nocookie: /youtube-nocookie\.com/i.test(e.src) ? true : /youtube\.com/i.test(e.src) ? false : null, loading: e.loading, visible: e.visible }; });
    item.policy_links = dom.policy_links || [];
    col.off();
    return item;
  } finally { await b.close(); }
}

// The banner on a phone (390×844, touch, mobile UA) in its own fresh profile: share of the screen, buttons, reject in view.
async function phoneBanner(pg, ctx) {
  const res = { pid: pg.pid, url: pg.url, width: 390, height: 844 };
  const { b, page, g } = await openFresh(ctx, pg.url, { mobile: true });
  try {
    if (!g.ok) { res.error = g.refused || g.error || 'load failed'; return res; }
    await U.sleep(ctx.waitMs);
    const dom = await scanPage(page).catch(e => ({ error: e.message, banner: { found: null } }));
    if (dom.error) res.error = String(dom.error).slice(0, 200);
    const bn = dom.banner || { found: false };
    Object.assign(res, { found: bn.found ?? null, in_iframe: !!bn.in_iframe, selector: bn.selector || null, place: bn.place || null, share_pct: bn.share_pct ?? null, blocks_page: bn.blocks_page ?? null,
      buttons: (bn.buttons || []).map(x => ({ text: x.text, kind: x.kind, w: x.w, h: x.h, in_view: x.in_view })), links: bn.links || [],
      has_accept: bn.has_accept ?? null, has_reject: bn.has_reject ?? null, has_reject_equivalent: bn.has_reject_equivalent ?? null, reject_in_view: bn.reject_in_view ?? null, prominence: bn.prominence || null });
    return res;
  } finally { await b.close(); }
}

async function stablePos(page, i) {
  let prev = null;
  for (let k = 0; k < 8; k++) {
    const p = await page.evaluateIsolated(BTN_POS, i).catch(() => null);
    if (!p) return null;
    if (prev && Math.abs(p.x - prev.x) <= 1 && Math.abs(p.y - prev.y) <= 1 && Math.abs(p.w - prev.w) <= 1 && Math.abs(p.h - prev.h) <= 1) return p;
    prev = p; await U.sleep(300);
  }
  return { ...prev, moving: true };
}

async function rejectTest(pg, ctx) {
  const res = { pid: pg.pid, url: pg.url, status: null };
  const { b, page, col, g } = await openFresh(ctx, pg.url);
  try {
    if (!g.ok) { res.status = 'error'; res.error = g.refused || g.error; return res; }
    await U.sleep(ctx.waitMs);
    const dom = await scanPage(page).catch(e => ({ error: e.message }));
    const ban = dom.banner || { found: false };
    res.banner_found = !!ban.found;
    if (!ban.found) { res.status = 'no_banner'; return res; }
    if (ban.in_iframe) { res.status = 'banner_in_iframe'; res.note = ctx.lang === 'en' ? 'the banner is in a frame — the safety net does not touch frames' : 'баннер во фрейме — касаться фреймов страховка не даёт'; return res; }
    res.buttons = (ban.buttons || []).map(x => ({ text: x.text, kind: x.kind }));
    const btn = (ban.buttons || []).find(x => x.kind === 'reject');
    if (!btn) {
      if (ban.reject_is_link) { res.status = 'reject_is_link'; res.note = ctx.lang === 'en' ? 'reject is a link to another address — following it would navigate; not clicked' : 'отказ — ссылка на другой адрес, переход страховка обрывает; не нажимали'; }
      else if (ban.has_reject_equivalent) { res.status = 'reject_equivalent_only'; res.note = ctx.lang === 'en' ? 'the only reject option is named "Accept …" — never clicked' : 'отказ назван «Принять …» — такие кнопки не нажимаются никогда'; }
      else res.status = 'no_reject_button';
      return res;
    }
    res.button = { text: btn.text, tag: btn.tag };
    // the button must be on screen, steady, and on top at its centre
    const pos = await stablePos(page, btn.i);
    if (!pos || !pos.hit) { res.status = 'reject_not_clickable'; res.note = ctx.lang === 'en' ? 'the reject button is covered or off screen' : 'кнопка отказа перекрыта или вне экрана'; return res; }
    const before = { cookies: new Set((await getCookies(page)).map(c => `${c.name}@${c.domain}`)), local: await page.evaluate('(() => { try { return Object.keys(localStorage); } catch (e) { return []; } })()').catch(() => []),
      blockedA: page.blocked.analytics.length, blockedW: page.blocked.widget.length };
    // right before the click: what is under the point must still be this reject button (sliding / re-laid-out banners)
    const hi = await page.hitInfo(pos.x, pos.y).catch(() => null);
    const under = await page.evaluateIsolated(UNDER, pos.x, pos.y).catch(() => null);
    const ht = normText(hi?.text);
    const moved = !hi || hi.none || under !== String(btn.i) || !REJECT_RE.test(ht) || ACCEPT_RE.test(ht) || REJECT_EQUIV_RE.test(ht) || hi.isConsentAccept || hi.isSubmit || hi.isIframe
      || (hi.isLink && hi.href && !samePage(hi.href, page.responses.find(r => r.type === 'Document')?.url || pg.url));
    if (moved) { res.status = 'reject_moved'; res.under = { text: hi?.text || null, btn: under }; res.note = ctx.lang === 'en' ? 'something else is under the reject button point now — not clicked' : 'под точкой кнопки отказа уже другое — не нажимали'; return res; }
    const clickTs = await page.evaluate('performance.timeOrigin + performance.now()').catch(() => Date.now());
    const reqCount0 = col.reqs.size;
    const tStart = [...col.reqs.values()].reduce((m, r) => Math.max(m, r.start), 0);
    const w0 = page.blocked.write.length, i0 = (page.blocked.interact || []).length, n0 = page.blocked.navigation.length, r0 = page.blocked.risky.length;
    const c = await page.click(pos.x, pos.y);
    if (c.refused) { res.status = 'refused_' + c.refused; return res; }
    res.clicked_at = new Date(clickTs).toISOString();
    await U.sleep(3000);
    // requests our safety net cut after the click: the site may save the choice this way (POST /consent, a GET with parameters, a reload)
    const cut = [...page.blocked.write.slice(w0).map(x => ({ ...x, cut: 'write' })), ...(page.blocked.interact || []).slice(i0).map(x => ({ ...x, cut: 'interact' })),
      ...page.blocked.navigation.slice(n0).map(x => ({ ...x, cut: 'navigation' })), ...page.blocked.risky.slice(r0).map(x => ({ ...x, cut: 'risky' }))];
    res.writes_after_click = cut.slice(0, 10).map(x => ({ method: x.method, url: shortUrl(x.url), type: x.type || null, cut: x.cut }));
    const after = await scanPage(page).catch(() => null);
    res.banner_hidden = after ? !after.banner.found || after.banner.selector !== ban.selector : null;
    const cookiesAfter = await getCookies(page);
    res.new_cookies = slimCookies(cookiesAfter.filter(x => !before.cookies.has(`${x.name}@${x.domain}`)), pg.url).map(x => ({ name: x.name, domain: x.domain, days: x.days, service: x.service, category: x.category, third_party: x.third_party }));
    const localAfter = await page.evaluate('(() => { try { return Object.keys(localStorage); } catch (e) { return []; } })()').catch(() => []);
    res.new_local_keys = localAfter.filter(k => !before.local.includes(k)).slice(0, 20);
    res.after_reject = { third_party: thirdPartyTable(col, pg.url, tStart + 0.0001).map(t => ({ name: t.name, host: t.host, category: t.category, loaded: t.loaded, attempted_cut: t.attempted_cut })),
      attempts: [...page.blocked.analytics.slice(before.blockedA), ...page.blocked.widget.slice(before.blockedW)].map(x => ({ service: svcName(x), url: shortUrl(x.url) })).slice(0, 20),
      requests: col.reqs.size - reqCount0 };
    // reload in the same profile: is the choice remembered, do trackers still try to load?
    const a0 = page.blocked.analytics.length, wd0 = page.blocked.widget.length;
    const g2 = await page.goto(pg.url, { timeout: 45000, waitUntil: 'load' });
    if (g2.ok) {
      await U.sleep(ctx.waitMs);
      const d2 = await scanPage(page).catch(() => null);
      res.reload = { banner_again: d2 ? !!d2.banner.found : null,
        attempts: [...page.blocked.analytics.slice(a0), ...page.blocked.widget.slice(wd0)].map(x => ({ service: svcName(x), url: shortUrl(x.url) })).slice(0, 20),
        cookies_third_party: slimCookies(await getCookies(page), pg.url).filter(x => x.third_party).length };
      // the banner is gone after reload → remembered. It is back and we cut the request that may have saved the choice → unknown.
      if (res.reload.banner_again === false) res.choice_remembered = true;
      else if (res.reload.banner_again === true) res.choice_remembered = cut.length ? null : false;
      else res.choice_remembered = null;
    } else { res.reload = { error: g2.refused || g2.error }; res.choice_remembered = null; }
    res.reload_reliable = !cut.length;
    if (cut.length) {
      const w = cut.find(x => x.method && x.method !== 'GET') || cut[0]; // name the POST when there is one
      res.note = (ctx.lang === 'en' ? `the site saves the choice with ${w.method || 'GET'} ${shortUrl(w.url)}; the safety net cut it — check manually (choice memory and trackers after reload are not reliable here)`
        : `выбор сайт сохраняет запросом ${w.method || 'GET'} ${shortUrl(w.url)}, страховка его отрезала — проверить вручную (запоминание выбора и трекеры после перезагрузки здесь ненадёжны)`);
      res.choice_check = 'manual';
    }
    res.status = 'ok';
    col.off();
    return res;
  } finally { await b.close(); }
}

const ALIASES = {
  'Яндекс Метрика': /метрик|metrika|metrica/i, 'Google Analytics': /google analytics|гугл аналитик|analytics\.google|google-analytics/i, 'Google Tag Manager': /tag manager|googletagmanager|диспетчер тегов/i,
  'Google Fonts': /google fonts|fonts\.google|шрифты google|гугл шрифт/i, 'Google Ads': /google ads|doubleclick|adwords/i, 'Пиксель VK': /\bvk\b|вконтакте|vk\.com|пиксел/i, 'Meta Pixel': /facebook|meta|пиксел/i,
  'Top Mail.ru': /mail\.ru|top\.mail|рейтинг mail/i, 'reCAPTCHA': /recaptcha|капч/i, 'YouTube': /youtube|ютуб/i, 'Яндекс Карты': /яндекс[\s.]*карт|yandex[\s.]*map/i, 'Google Maps': /google maps|карты google|гугл карт/i,
  'Microsoft Clarity': /clarity/i, 'Вебвизор (Яндекс Метрика)': /вебвизор|webvisor/i, 'Telegram': /telegram|телеграм/i, 'Яндекс (статика)': /яндекс|yandex/i,
};
function mentions(name, text) {
  const a = ALIASES[name];
  if (a) return a.test(text);
  const tokens = String(name).toLowerCase().replace(/\(.*?\)/g, ' ').split(/[\s/]+/).filter(t => t.length >= 3 && !/^(пиксель|сеть|рекламная|статика|видео|карты|без|cookie)$/.test(t));
  return tokens.length ? tokens.some(t => text.toLowerCase().includes(t)) : false;
}

async function policyCheck(items, ctx) {
  const links = []; const seen = new Set();
  for (const it of items) for (const l of it.policy_links || []) { if (!seen.has(l.href) && U.sameSite(l.href, it.url) && !U.isRiskyGet(l.href)) { seen.add(l.href); links.push(l); } }
  if (!links.length) return { found: false, pages: [] };
  const pick = links.filter(l => /политик|конфиденц|privacy/i.test(l.text + l.href)).concat(links).filter((l, i, a) => a.indexOf(l) === i).slice(0, 2);
  const services = [...new Set(items.flatMap(it => [...(it.third_party || []).filter(t => t.known && !['platform', 'cdn', 'consent'].includes(t.category)).map(t => t.name),
    ...(it.attempts?.analytics || []).map(a => a.service), ...(it.attempts?.widget || []).map(a => a.service), ...(it.recording?.tools || [])]))].filter(Boolean);
  const anyForeign = items.some(it => (it.third_party || []).some(t => t.operator === 'foreign'));
  const b = await Browser.launch();
  const pages = [];
  try {
    for (const l of pick) {
      const r = await U.politeFetch(l.href, { maxBytes: 4 * 1024 * 1024, timeoutMs: 20000 });
      if (!r.ok || !r.body) { pages.push({ url: l.href, status: r.status, error: r.error || null }); continue; }
      const d = await parseHtml(b, r.body, r.url || l.href).catch(e => ({ error: e.message }));
      const text = String(d.text || '');
      const named = {}; for (const s of services) named[s] = mentions(s, text);
      pages.push({ url: l.href, status: r.status, words: d.word_count ?? null, title: d.title || null,
        mentions: { cookie: /cookie|куки/i.test(text), recording: /вебвизор|webvisor|запис[ьи] (сеанс|сесси|действ)|session record/i.test(text), cross_border: /трансгранич|cross-border|третьи стран|за пределы (рф|российской)/i.test(text),
          analytics: /аналитик|метрик|analytics/i.test(text) }, services: named, missing: Object.entries(named).filter(([, v]) => !v).map(([k]) => k), js_rendered_suspect: (d.word_count ?? 0) < 80 });
    }
    await closeDomTab(b).catch(() => {});
  } finally { await b.close(); }
  return { found: true, links: links.slice(0, 4), services_detected: services, any_foreign: anyForeign, pages };
}

// ---------- summary ----------
function buildSummary(out, lang) {
  const L = T[lang] || T.ru;
  const it = out.items.filter(i => !i.error);
  const uniq = a => [...new Set(a.filter(Boolean))];
  const cookies = new Map(); for (const i of it) for (const c of i.cookies || []) cookies.set(`${c.name}@${c.domain}`, c);
  const cs = [...cookies.values()];
  const banners = it.filter(i => i.banner && i.banner.found);
  const tps = it.flatMap(i => i.third_party || []);
  const infra = it.map(i => i.first_party_infra).find(Boolean) || null;
  const foreign = uniq([...(infra && infra.operator === 'foreign' ? [`${infra.provider} (${L.wholeSite})`] : []),
    ...tps.filter(t => t.operator === 'foreign').map(t => t.name),
    ...it.flatMap(i => [...(i.attempts?.analytics || []), ...(i.attempts?.widget || [])]).map(a => U.THIRD_PARTY_SERVICES.find(s => s[1] === a.service)?.[3] === 'foreign' ? a.service : null)]);
  const rt = out.reject_test; const b390 = out.banner_390;
  return {
    pages: it.map(i => i.pid),
    banner_pages: banners.map(i => i.pid), banner_has_reject: banners.length ? banners.some(i => i.banner.has_reject) : null, banner_has_accept: banners.length ? banners.some(i => i.banner.has_accept) : null,
    banner_has_reject_equivalent: banners.length ? banners.some(i => i.banner.has_reject_equivalent) : null,
    reject_equal_prominence: banners.find(i => i.banner.prominence)?.banner.prominence.equal ?? null, banner_blocks_page: banners.some(i => i.banner.blocks_page),
    banner_390: b390 ? { pid: b390.pid, found: b390.found ?? null, share_pct: b390.share_pct ?? null, blocks_page: b390.blocks_page ?? null, buttons: b390.buttons || [],
      prominence: b390.prominence || null, has_reject: b390.has_reject ?? null, reject_in_view: b390.reject_in_view ?? null, error: b390.error || undefined } : null,
    banner_390_found: b390 ? b390.found ?? null : null, banner_390_share_pct: b390?.found ? b390.share_pct ?? null : null, banner_390_blocks_page: b390?.found ? b390.blocks_page ?? null : null,
    banner_390_reject_in_view: b390?.found ? b390.reject_in_view ?? null : null,
    cookies_total: cs.length, cookies_third_party: cs.filter(c => c.third_party).length, cookies_long_lived: cs.filter(c => c.days !== null && c.days > 395).map(c => c.name).slice(0, 20),
    cookies_tracking: cs.filter(c => ['analytics', 'ads', 'recording', 'calltracking'].includes(c.category)).map(c => c.name).slice(0, 20),
    cookies_no_secure_on_https: cs.filter(c => !c.secure && /^https:/i.test(out.site || '')).map(c => c.name).slice(0, 20),
    trackers_before_consent: uniq(it.flatMap(i => i.before_consent || [])),
    attempts_cut: uniq(it.flatMap(i => [...(i.attempts?.analytics || []), ...(i.attempts?.widget || [])].map(a => a.service))),
    third_party_hosts: uniq(tps.map(t => t.host)).length, cross_border: foreign, first_party_infra: infra,
    recording_tools: uniq(it.flatMap(i => i.recording?.tools || [])), pii_fields: it.reduce((a, i) => a + (i.recording?.pii_fields || 0), 0), pii_masked: it.reduce((a, i) => a + (i.recording?.masked || 0), 0),
    fingerprinting: uniq(it.flatMap(i => [...(i.fingerprinting?.canvas_readback || []), ...(i.fingerprinting?.webgl_renderer || []), ...(i.fingerprinting?.offline_audio || []), ...(i.fingerprinting?.font_probe || [])].map(x => x.by))),
    permissions_at_load: uniq(it.flatMap(i => (i.permissions || []).map(p => p.api))),
    storage_pii_like: uniq(it.flatMap(i => [...(i.storage?.local || []), ...(i.storage?.session || [])].filter(k => k && k.looks_like).map(k => `${k.key} (${k.looks_like})`))),
    service_workers: uniq(it.flatMap(i => i.storage?.service_workers || [])).length,
    embeds_tracking: uniq(it.flatMap(i => (i.embeds || []).filter(e => e.third_party && ['video', 'maps', 'social'].includes(e.category) && e.nocookie !== true).map(e => e.name))),
    consent_mode: it.some(i => i.consent_mode?.found) ? (it.some(i => i.consent_mode.default_denied) ? 'default_denied' : 'found') : null,
    reject_test: rt ? rt.status : null, after_reject_loads: rt?.after_reject ? uniq([...rt.after_reject.third_party.filter(t => ['analytics', 'ads', 'recording', 'tag-manager', 'calltracking', 'chat'].includes(t.category)).map(t => t.name), ...rt.after_reject.attempts.map(a => a.service)]) : null,
    after_reject_reload: rt?.reload?.attempts ? uniq(rt.reload.attempts.map(a => a.service)) : null,
    choice_remembered: rt?.choice_remembered ?? null, reject_writes_cut: rt?.writes_after_click ? rt.writes_after_click.length : null, choice_check: rt?.choice_check || null,
    policy_found: out.policy ? out.policy.found : null, policy_missing: out.policy?.pages ? uniq(out.policy.pages.flatMap(p => p.missing || [])) : null,
  };
}

function summaryLines(out, lang, outFile) {
  const L = T[lang]; const s = out.summary; const lines = [];
  const num = x => (x === null || x === undefined) ? '—' : (lang === 'en' ? String(x) : String(x).replace('.', ','));
  lines.push(`${out.reject_requested ? L.titleReject : L.title}${out.partial ? ' — ' + L.partial : ''}`);
  if (!out.partial && !s.pages.length) { // nothing loaded: no "none" lines that read like a clean result
    lines.push(L.noPages);
    if (out.errors.length) lines.push(`${L.errors}: ${out.errors.length} — ${out.errors.slice(0, 3).map(e => `${e.pid}: ${String(e.error).slice(0, 90)}`).join('; ')}`);
    lines.push(`${L.written}: ${outFile}`);
    return lines;
  }
  lines.push(`${L.pages}: ${s.pages.join(', ') || '—'} · ${out.width} px · ${lang === 'en' ? 'wait' : 'ожидание'} ${out.wait_sec} ${lang === 'en' ? 's' : 'с'}`);
  const b = out.items.find(i => i.banner && i.banner.found)?.banner;
  if (b) {
    const p = b.prominence;
    lines.push(`${L.banner}: ${L.found} (${b.place || '—'}, ${num(b.share_pct)} %) · ${L.buttons}: ${(b.buttons || []).map(x => `«${x.text}»`).join(', ').slice(0, 160) || '—'}`);
    const rejBit = b.has_reject ? (b.reject_is_link ? L.rejectLink : `${L.reject} ${L.found}${p ? ' · ' + (p.equal ? L.equal : L.smaller) + ` (${lang === 'en' ? 'area ratio' : 'площадь'} ${num(p.ratio)})` : ''}`)
      : b.has_reject_equivalent ? `${L.equivOnly}«${(b.buttons || []).find(x => x.kind === 'reject_equivalent')?.text || ''}»)` : L.noReject;
    lines.push(`  ${rejBit}${b.policy_link ? ` · ${lang === 'en' ? 'policy link' : 'ссылка на политику'} ${L.yes}` : ''}${b.blocks_page ? ` · ${L.blocksPage}` : ''}`);
  } else lines.push(`${L.banner}: ${L.none}`);
  const m = out.banner_390;
  if (m) lines.push(m.error ? `${L.phone}: ${m.error.slice(0, 80)}` : !m.found ? `${L.phone}: ${L.banner.toLowerCase()} ${L.none}`
    : `${L.phone}: ${num(m.share_pct)} % ${L.ofScreen}${m.blocks_page ? ` · ${L.blocksPage}` : ''}${m.has_reject && m.reject_in_view === false ? ` · ${L.rejectBelow}` : ''}${!m.has_reject ? ` · ${L.noReject}` : ''}`);
  lines.push(`${L.cookies}: ${s.cookies_total} (${L.third} ${s.cookies_third_party}; ${L.long}: ${s.cookies_long_lived.length ? s.cookies_long_lived.slice(0, 5).join(', ') : L.none})`);
  const st = out.items.flatMap(i => [...(i.storage?.local || []), ...(i.storage?.session || [])]).length;
  lines.push(`${L.storage}: ${lang === 'en' ? 'localStorage/sessionStorage keys' : 'ключей в localStorage/sessionStorage'} ${st}${s.storage_pii_like.length ? ` · ${L.piiLike}: ${s.storage_pii_like.slice(0, 4).join(', ')}` : ''}${s.service_workers ? ` · service worker ${s.service_workers}` : ''}`);
  lines.push(`${L.before}: ${s.trackers_before_consent.length ? s.trackers_before_consent.slice(0, 10).join(', ') : L.none}`);
  if (s.attempts_cut.length) lines.push(`${L.attempts}: ${s.attempts_cut.slice(0, 10).join(', ')}`);
  lines.push(`${L.cross}: ${s.cross_border.length ? s.cross_border.slice(0, 10).join(', ') : L.none}`);
  lines.push(`${L.recording}: ${s.recording_tools.length ? s.recording_tools.join(', ') : L.none} · ${L.fields} ${s.pii_fields}, ${L.masked} ${s.pii_masked}`);
  lines.push(`${L.fp}: ${s.fingerprinting.length ? s.fingerprinting.slice(0, 6).map(x => x === 'inline' ? (lang === 'en' ? 'page code' : 'код на странице') : x).join(', ') : L.none} · ${L.perms}: ${s.permissions_at_load.length ? s.permissions_at_load.join(', ') : L.none}`);
  if (s.embeds_tracking.length) lines.push(`${L.embeds}: ${s.embeds_tracking.join(', ')}`);
  if (s.consent_mode) lines.push(`${L.consentMode}: ${s.consent_mode}`);
  const r = out.reject_test;
  if (!r) lines.push(`${L.rejectTest}: ${out.reject_requested ? L.notYet : L.notRun}`);
  else if (r.status !== 'ok') lines.push(`${L.rejectTest}: ${r.status}${r.buttons ? ` (${r.buttons.map(x => `«${x.text}»`).join(', ').slice(0, 120)})` : ''}`);
  else {
    const memory = r.choice_check === 'manual' && r.choice_remembered !== true ? L.serverChoice : r.choice_remembered === true ? L.remembered : r.choice_remembered === false ? L.notRemembered : '—';
    lines.push(`${L.rejectTest}: «${r.button.text}» ${L.clicked} · ${L.bannerGone}: ${r.banner_hidden ? L.yes : L.no} · ${L.after}: ${s.after_reject_loads?.length ? s.after_reject_loads.join(', ') : L.none}`);
    lines.push(`  ${memory}${s.after_reject_reload?.length && r.reload_reliable !== false ? ` · ${L.afterReload}: ${s.after_reject_reload.join(', ')}` : ''}`);
  }
  if (out.policy) lines.push(out.policy.found ? `${L.policy}: ${out.policy.pages.map(p => p.error ? `${shortUrl(p.url)} — ${p.status || p.error}` : `${shortUrl(p.url)} — ${p.missing.length ? `${L.notNamed}: ${p.missing.slice(0, 6).join(', ')}` : L.allNamed}`).join('; ')}` : `${L.policy}: ${L.noPolicy}`);
  if (out.errors.length) lines.push(`${L.errors}: ${out.errors.length} — ${out.errors.slice(0, 3).map(e => `${e.pid}: ${String(e.error).slice(0, 70)}`).join('; ')}`);
  if (out.not_checked.length) lines.push(`${L.notChecked}: ${out.not_checked.slice(0, 3).join('; ').slice(0, 260)}`);
  lines.push(`${L.written}: ${outFile}`);
  return lines.slice(0, 40);
}

// ---------- main ----------
async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'fresh', 'reject-test', 'allow-load-posts', 'mobile'] });
  U.helpAndExit(HELP, args);
  const lang = U.langOf(args);
  const run = U.requireRun(args);
  const T0 = Date.now();
  const budgetMs = Math.max(30, Number(args['budget-sec']) || 480) * 1000;
  const pagesDoc = existsSync(join(run, 'pages.json')) ? U.readJSON(join(run, 'pages.json'), {}) : null;
  const brief = U.readJSON(join(run, 'brief.json'), null) || U.readJSON(join(run, 'brief.input.json'), {}) || {};

  let all;
  if (pagesDoc) all = U.loadPages(run, {});
  else if (args.url && args.url !== true) all = [{ pid: 'home', url: U.normalizeUrl(args.url), template: 'home' }];
  else { console.error(lang === 'en' ? 'No pages.json and no --url.' : 'Нет pages.json и не задан --url.'); process.exit(2); }
  const snap = U.readJSON(join(run, 'snapshot', 'snapshot.json'), null);
  const closed = new Set(snap?.summary?.blocked_pages || []);
  all = all.filter(p => p && p.url && !p.blocked && !closed.has(p.pid));
  const only = U.listArg(args.pages);
  if (only.length) all = all.filter(p => only.includes(p.pid));
  if (!all.length) { console.error(lang === 'en' ? 'No pages to check.' : 'Нет страниц для проверки.'); process.exit(2); }
  for (const p of all) { const h = U.hostOf(p.url); if (isLocalHost(h)) U.allowPrivateHost(h); }
  const maxPages = Math.max(1, Number(args['max-pages']) || 3);
  const home = all.find(p => p.pid === 'home') || all[0];
  // home + pages with forms / contacts first (within --pages, if given), at most --max-pages
  const formsOf = p => { const pj = U.readJSON(join(run, 'snapshot', p.pid, 'page.json'), null); return (pj?.forms?.length ?? pj?.facts?.forms ?? 0) + (pj?.formless_fields?.length ?? 0); };
  const contactRe = /(kontakt|contact|zapis|order|zakaz|form|feedback|obratn|booking|bron|signup|register)/i;
  const rest = all.filter(p => p !== home).map(p => ({ p, score: (formsOf(p) > 0 ? 2 : 0) + (contactRe.test(`${p.template || ''} ${p.url} ${p.why || ''}`) ? 1 : 0) })).sort((a, b) => b.score - a.score).map(x => x.p);
  const pages = [home, ...rest].slice(0, maxPages);
  const width = Math.max(320, Math.min(2560, Number(args.width) || 1440));
  const waitSec = Math.max(0, Math.min(20, Number(args['wait-sec'] ?? 4)));
  const ctx = { run, lang, width, waitMs: waitSec * 1000, allowLoadPosts: !!args['allow-load-posts'] };
  const market = pagesDoc?.market?.value || brief.market?.value || null;

  const outFile = U.insideRun(run, 'measure', 'privacy.json');
  let out = null, keep = null;
  if (!args.fresh && existsSync(outFile)) {
    const prev = U.readJSON(outFile, null);
    if (prev && prev.partial && prev.resume && Array.isArray(prev.resume.done)) out = prev;
    else if (prev && !prev.partial && only.length && Array.isArray(prev.items)) keep = prev; // --pages on a finished file: re-check these, keep the rest
  }
  if (!out) out = { ...U.measureHeader(NAME, run), partial: false, resume: { done: [] }, site: pagesDoc?.final_origin || home.url, market, width, wait_sec: waitSec,
    method: lang === 'en' ? 'headless Chromium via CDP, fresh profile per page, no clicks; the banner is also read on a 390×844 phone; counters/call tracking/chats are cut by the safety net and recorded as attempts; reject test clicks only a reject button after checking what is under the point'
      : 'headless Chromium через CDP, новый профиль на страницу, без кликов; баннер снят и на телефоне 390×844; счётчики, коллтрекинг и чаты отрезаны страховкой и записаны как попытки; проверка отказа нажимает только кнопку отказа после проверки, что под точкой именно она',
    items: [], banner_390: null, reject_test: null, policy: null };
  out.not_checked = (out.not_checked || []).filter(x => !/браузер занят|browser slots busy/i.test(x)); // a note of the previous call only
  if (keep) {
    const ids = new Set(pages.map(p => p.pid));
    out.items = keep.items.filter(i => !ids.has(i.pid));
    out.banner_390 = keep.banner_390 || null; out.reject_test = keep.reject_test || null; out.policy = keep.policy || null;
  }
  const done = new Set(out.resume?.done || []);
  const units = [...pages.map(p => ({ id: `page:${p.pid}`, kind: 'page', pg: p }))];
  if (args.mobile !== false) units.push({ id: 'banner390', kind: 'banner390' });
  if (args['reject-test']) { units.push({ id: 'reject', kind: 'reject' }); out.reject_requested = true; }
  units.push({ id: 'policy', kind: 'policy' });
  const est = { page: 25000, banner390: 20000, reject: 40000, policy: 15000 }; const durations = { ...(out.resume?.durations || {}) };
  const estOf = u => { const d = durations[u.kind]; return d && d.length ? d.reduce((a, x) => a + x, 0) / d.length : est[u.kind]; };
  const bannerPage = () => { const t = out.items.find(i => i.banner && i.banner.found && !i.error) || out.items.find(i => !i.error); return t ? pages.find(p => p.pid === t.pid) || home : home; };

  const writeOut = partial => {
    out.partial = partial; out.resume = partial ? { done: [...done], durations } : null; out.generated = U.nowIso();
    out.pages = out.items.map(i => i.pid); out.summary = buildSummary(out, lang);
    U.writeJSON(outFile, out);
  };
  U.log(run, `privacy: старт, страниц ${pages.length} (${pages.map(p => p.pid).join(',')}), ширина ${width}${args['reject-test'] ? ', проверка отказа' : ''}`);
  let release = null, partial = false;
  try {
    try { release = await U.acquireBrowserSlot({ waitMs: Math.max(20000, Math.min(10 * 60000, budgetMs - 60000)) }); }
    catch (e) { out.not_checked.push(lang === 'en' ? 'browser slots busy — rerun to continue' : 'браузер занят другими проверками — повторите вызов, продолжит'); partial = true; throw e; }
    let ranHere = 0;
    for (const u of units) {
      if (done.has(u.id)) continue;
      const left = budgetMs - (Date.now() - T0);
      // the first block of a call runs when ≥ 25 s are left, so a small budget still moves forward
      if (left < estOf(u) * 1.3 + 8000 && (ranHere || left < 25000)) { partial = true; break; }
      ranHere++;
      const t1 = Date.now(); U.progress(`privacy: ${u.id}`);
      try {
        if (u.kind === 'page') {
          const item = await inspectPage(u.pg, ctx);
          out.items = out.items.filter(i => i.pid !== item.pid); out.items.push(item);
          if (item.error) out.errors.push({ pid: item.pid, error: item.error });
        } else if (u.kind === 'banner390') {
          out.banner_390 = await phoneBanner(bannerPage(), ctx);
          const host = out.items.find(i => i.pid === out.banner_390.pid); if (host) host.banner_390 = out.banner_390; // on the page too
        } else if (u.kind === 'reject') {
          out.reject_test = await rejectTest(bannerPage(), ctx);
        } else if (u.kind === 'policy') {
          out.policy = await policyCheck(out.items, ctx);
        }
      } catch (e) { out.errors.push({ pid: u.pg?.pid || u.id, error: e.message.slice(0, 200) }); }
      (durations[u.kind] ||= []).push(Date.now() - t1);
      done.add(u.id); writeOut(true);
    }
  } catch (e) { if (!partial) out.errors.push({ pid: '-', error: e.message.slice(0, 300) }); }
  finally { if (release) { const r = release; release = null; r(); } }

  const nc = new Set(out.not_checked); const addNc = s => { if (!nc.has(s)) { nc.add(s); out.not_checked.push(s); } };
  addNc(lang === 'en' ? 'scripts of counters, call tracking and chats did not run (cut by the safety net): cookies they would set are not in the list — see attempts' : 'скрипты счётчиков, коллтрекинга и чатов не выполнялись (страховка): их cookie в списке нет — смотрите попытки');
  addNc(lang === 'en' ? 'banners shown only to visitors from some countries (by IP) may differ' : 'баннер для посетителей из других стран (по IP) может отличаться');
  if (args.mobile === false) addNc(lang === 'en' ? 'the banner on a phone was not checked (--no-mobile)' : 'баннер на телефоне не смотрели (--no-mobile)');
  if (!args['reject-test']) addNc(lang === 'en' ? 'reject test not run (--reject-test)' : 'проверку отказа не запускали (--reject-test)');
  if (out.reject_test?.choice_check === 'manual') addNc(lang === 'en' ? 'whether the site remembers "Reject": it saves the choice with a server request the safety net cut — check manually in a browser' : 'запоминает ли сайт «Отклонить»: выбор уходит запросом на сервер, страховка его отрезала — проверить вручную в браузере');
  if (!units.every(u => done.has(u.id))) partial = true;
  const noPages = !partial && !out.items.some(i => !i.error);
  if (noPages) addNc(T[lang].noPagesNc);
  writeOut(partial);
  const lines = summaryLines(out, lang, rel(run, outFile));
  U.printAndSaveSummary(run, NAME, lines);
  U.log(run, `privacy: ${partial ? 'частично' : 'готово'} за ${Math.round((Date.now() - T0) / 1000)} с, страниц ${out.items.length}${out.reject_test ? ', отказ: ' + out.reject_test.status : ''}`);
  process.exitCode = partial ? 75 : noPages ? 1 : 0;
}

// run only when executed directly (perf.mjs imports the dictionaries and BANNER_LIB from this file)
const isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    let a = resolve(process.argv[1]), b = fileURLToPath(import.meta.url);
    try { a = realpathSync(a); } catch {} try { b = realpathSync(b); } catch {}
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch { return false; }
})();
if (isMain) {
  main().catch(e => { console.error(e?.stack || e); process.exitCode = /Node|браузер|browser/i.test(String(e?.message)) ? 2 : 1; })
    .finally(() => { setTimeout(() => process.exit(process.exitCode ?? 0), 3000).unref(); });
}
