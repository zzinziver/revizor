#!/usr/bin/env node
// Revizor forms.mjs — forms, popups with forms, consents and analytics by code.
// Every form of a page, visible or hidden (popups, accordions), plus contact fields outside <form>:
//  fields (type, name, autocomplete, inputmode, label vs placeholder, required by attribute / platform / asterisk,
//  masks by code), consents (checkbox, pre-checked, text, policy link, ads/cookie inside a required consent,
//  consent by clicking), action / endpoint (host, https, third-party service), method (GET with personal data),
//  anti-spam, «thank you» page or message, checkValidity() WITHOUT submitting.
// Popups are opened only by toggle buttons with real input: page.tap at phone widths, page.click at desktop widths.
// Never tapped by this script itself (before lib/cdp gets a say): submit buttons, anything inside a form (also link-styled
// «send» buttons), buttons in a block with visible input fields (forms without <form> send by fetch/JSONP/new Image()
// with a plain GET), «send / call me back» buttons without a popup link, buttons covered by another element.
// lib/cdp refuses submit / contact-form / consent-accept / iframe taps, aborts navigations, cuts non-GET requests and,
// for 3 s after each tap, background requests. A tap cut by it is «blocked_by_guard», never «the button does nothing».
// Per opened popup: frame, submit button in the window (390×844 and 360×640), focus moved in, scroll lock, closing by
// Esc / close button / backdrop. DOM is read in an isolated world (page.evaluateIsolated); the page's JS world is touched
// only to read which mask libraries are loaded and to run the platform validator. Iframe forms: listed read-only.
// Analytics by code and by blocked attempts (counters are cut by lib/cdp): counter IDs, double init, goals in
// code (reachGoal, gtag event, dataLayer), session recording and field masking, UTM/ClientID hidden fields.
// tel:/mailto:/messenger links. Calculators (fields outside contact forms) are listed for the facts lens
// (they are checked with probe.mjs --fill). Thank-you pages named by forms: one GET, indexable or not.

import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Browser } from './lib/cdp.mjs';
import { parseHtml } from './lib/dom.mjs';
import * as U from './lib/util.mjs';

const HELP = `
forms.mjs — формы, попапы с формами, согласия и аналитика по коду → RUN/measure/forms.json

  node forms.mjs --run "<RUN>" [--pages home,p01] [--widths 390] [--max-pages 12] [--max-taps 14] [--no-shots]
                 [--no-thanks] [--budget-sec 480] [--allow-load-posts] [--lang ru|en]
  node forms.mjs --run "<RUN>" --url https://example.ru/contacts   одна страница, если pages.json ещё нет

Что делает на каждой странице (одна загрузка на ширину, по умолчанию 390 — телефон с касаниями):
  · все формы, видимые и скрытые (попапы, аккордеоны), и поля с контактами вне <form>: тип, name, autocomplete,
    inputmode, подпись (видимая / только подсказка в поле / нет), обязательность (атрибут, правило платформы,
    звёздочка), маска по коду, согласия (галочка, стоит ли заранее, текст, ссылка на политику, реклама или cookie
    внутри обязательного согласия, согласие «нажимая кнопку…»), куда уходят данные (домен, https, сторонний
    сервис), метод (GET с личными данными), антиспам, «спасибо»; checkValidity() — без отправки;
  · кнопки, открывающие попапы, нажимаются реальным касанием (только переключатели: не submit, не ссылки на другие
    страницы, не кнопки и ссылки внутри формы, не кнопки в блоке с полями ввода, не «Отправить / Перезвоните» без
    ссылки на попап, не перекрытые другим элементом; одинаковые кнопки на других страницах не повторяются): что
    открылось, кадр попапа, видна ли кнопка отправки на 390×844 и 360×640, ушёл ли фокус в попап, закрывается ли Esc,
    крестиком, касанием фона; касание, оборванное страховкой, — «blocked_by_guard», не «кнопка не работает»;
  · формы во фреймах (запись, конструкторы форм, CRM): поля, согласие, кнопка — только чтение, без нажатий;
  · аналитика по коду и по заблокированным попыткам загрузки: счётчики и их номера, двойная инициализация, цели в
    коде, запись сессий (Вебвизор, Hotjar, Clarity) и скрыты ли поля от записи, UTM/ClientID в скрытых полях;
  · ссылки tel:, mailto:, мессенджеры; калькуляторы (поля вне форм с контактами) — перечень для линзы facts.
Ничего не отправляется: кнопки отправки не нажимаются; страховка lib/cdp обрывает не-GET запросы, переходы, а 3 с после
касания — фоновые запросы и запросы с параметрами; счётчики и чаты заблокированы. DOM читается в изолированном мире.
Пишет measure/forms.json и кадры попапов measure/forms/*.jpg; сводка — в stdout и RUN/stdout/forms.md.
Коды: 0 готово · 75 частично (бюджет или slot_wait — браузер занят; повторите ту же команду — продолжит) · 2 ошибка аргументов/окружения · 1 сбой.
`;
const HELP_EN = `
forms.mjs — forms, popups with forms, consents and analytics by code → RUN/measure/forms.json

  node forms.mjs --run "<RUN>" [--pages home,p01] [--widths 390] [--max-pages 12] [--max-taps 14] [--no-shots]
                 [--no-thanks] [--budget-sec 480] [--allow-load-posts] [--lang ru|en]
  node forms.mjs --run "<RUN>" --url https://example.com/contact   one page when there is no pages.json yet

Per page (one load per width, default 390 — a phone with touch): every form, shown or hidden, and contact fields
outside <form> (types, autocomplete, labels vs placeholders, required, masks, consents, endpoint, method, anti-spam,
thank-you), checkValidity() without submitting; popup toggles are tapped with real input (never submit buttons, links
to other pages, buttons or links inside a form, buttons in a block with input fields, «send / call me» buttons without
a popup link, covered buttons): what opened, a frame, submit button within 390×844 and 360×640, focus, Esc / close /
backdrop; a tap cut by the safety net is «blocked_by_guard», not a dead button; iframe forms listed read-only;
analytics by code and by blocked attempts (counter IDs, double init, goals, session recording and field masking,
UTM/ClientID hidden fields); tel:/mailto:/messenger links; calculators listed for the facts lens.
Nothing is ever sent: send buttons are never pressed; lib/cdp cuts non-GET requests, navigations and, for 3 s after a
tap, background requests and requests with parameters; counters and chats are blocked. DOM is read in an isolated world.
Writes measure/forms.json and popup frames measure/forms/*.jpg. Exit: 0 done · 75 partial (budget or slot_wait — browser busy; rerun to continue) · 2 bad args · 1 failure.
`;

// ---------------------------------------------------------------------------------------------
// in-page helpers (serialised with toString — must stay self-contained)
function PAGE_HELPERS() {
  if (window.__rvf) return;
  const H = {};
  const T = (s, n = 200) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const q = (s, root) => { try { return [...(root || document).querySelectorAll(s)]; } catch (e) { return []; } };
  const cs = el => getComputedStyle(el);
  const cls = el => (el && typeof el.className === 'string' ? el.className : (el && el.getAttribute && el.getAttribute('class')) || '');
  const PII = ['phone', 'email', 'name', 'telegram', 'address', 'birth', 'passport', 'card'];
  // word starts only: «акци» must not fire inside «редакции», «правил» inside «правильно»
  const CONSENT = /(?<![\p{L}])(?:соглас|персональн|обработк|политик|конфиденц|оферт|правил(?:а|о|ами|ах|ам)?(?![\p{L}])|услови(?:я|й|е|ями|ях|ям)(?![\p{L}])|рассылк|реклам|cookie|куки|privacy|consent|terms|policy|agree|newsletter|marketing|152-?фз)/iu;
  const M_PD = /(?<![\p{L}])(?:персональн\p{L}*|обработк\p{L}*|personal data)/iu;
  const M_POLICY = /(?<![\p{L}])(?:политик\p{L}*|конфиденциальн\p{L}*|privacy|policy)(?![\p{L}])/iu;
  const M_ADS = /(?<![\p{L}])(?:реклам\p{L}*|рассылк\p{L}*|маркетинг\p{L}*|акци(?:я|и|ю|ей|ях|ями|онн\p{L}*)|новост\p{L}*|спецпредложени\p{L}*|newsletters?|marketing|promotions?|promo)(?![\p{L}])/iu;
  const M_COOKIE = /(?<![\p{L}])(?:cookies?|куки|кукис)(?![\p{L}])/iu;
  const M_OFFER = /(?<![\p{L}])(?:оферт\p{L}*|terms|услови\p{L}* (?:использования|оказания|обслуживания|оферты|соглашения|договора)|правил\p{L}* (?:сайта|оказания|пользования|предоставления))(?![\p{L}])/iu;
  const TEXT_FIELDS = 'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]):not([type=search]), textarea';
  const POP = /(^|[\s_-])(popup|pop-up|modal|lightbox|fancybox|mfp-wrap|dialog|t-popup|uc-popup|offcanvas|off-canvas|drawer)([\s_-]|$)/i;
  H.shown = el => {
    if (!el || !el.isConnected || el.closest('[data-rvf-hidden]')) return false;
    try { if (el.checkVisibility && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false; } catch (e) { /* old engine */ }
    const r = el.getBoundingClientRect();
    return r.width >= 1 && r.height >= 1;
  };
  H.sel = el => {
    if (!el || el.nodeType !== 1) return '';
    const okId = id => id && /^[A-Za-z][\w-]*$/.test(id) && document.querySelectorAll('#' + CSS.escape(id)).length === 1;
    if (okId(el.id)) return '#' + el.id;
    const parts = [];
    for (let e = el; e && e.nodeType === 1 && parts.length < 7; e = e.parentElement) {
      if (e !== el && okId(e.id)) parts.unshift('#' + e.id);
      else {
        let p = e.tagName.toLowerCase();
        const c = [...e.classList].filter(x => /^[A-Za-z_][\w-]*$/.test(x) && x.length < 40 && !/^(rvf|data-rvf)/.test(x)).slice(0, 2);
        if (c.length) p += '.' + c.join('.');
        const par = e.parentElement;
        if (par) { const same = [...par.children].filter(x => x.tagName === e.tagName); if (same.length > 1) p += ':nth-of-type(' + (same.indexOf(e) + 1) + ')'; }
        parts.unshift(p);
      }
      const s = parts.join(' > ');
      try { if (document.querySelectorAll(s).length === 1) return s; } catch (e2) { /* invalid */ }
      if (parts[0].startsWith('#') || e === document.body) break;
    }
    return parts.join(' > ');
  };
  H.box = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)]; };
  H.vbox = el => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
  // a popup-ish class/id token; triggers and in-page form wrappers («open-popup», «js-popup-open», «btn-modal»,
  // «modal-link», «popup-form») are not layers
  const popTok = a => (cls(a) + ' ' + (a.id || '')).split(/\s+/).some(t => t && POP.test(t)
    && !/(^|[_-])(open|show|js|btn|button|trigger|toggle|link|call|form)([_-]|$)/i.test(t));
  H.popupOf = el => {
    // the element itself counts only by tag and role: a trigger or a form named «popup-…» sits in the page
    for (let a = el; a && a !== document.body && a.nodeType === 1; a = a.parentElement) {
      if (a.tagName === 'DIALOG' || a.matches('[role=dialog],[role=alertdialog],[aria-modal=true]') || (a !== el && popTok(a))) return a;
    }
    return null;
  };
  H.region = el => {
    if (H.popupOf(el)) return 'popup';
    if (el.closest('header,[role=banner]')) return 'header';
    if (el.closest('nav,[role=navigation]')) return 'nav';
    if (el.closest('footer,[role=contentinfo]')) return 'footer';
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) { const p = cs(a).position; if (p === 'fixed' || p === 'sticky') return 'sticky'; }
    return el.closest('main,[role=main]') ? 'main' : 'other';
  };
  H.hiddenIn = el => {
    if (H.shown(el)) return null;
    if (H.popupOf(el)) return 'popup';
    if (el.closest('details:not([open])')) return 'details';
    for (let a = el; a && a !== document.body; a = a.parentElement) if (/(accordion|collaps|spoiler|tab-?pane|tab-?panel|tabs?__(content|panel|pane))/i.test(cls(a))) return 'accordion/tab';
    if (el.closest('nav,header')) return 'menu';
    return 'hidden';
  };
  const isSubmit = el => { const t = (el.getAttribute('type') || '').toLowerCase(); const f = el.closest('form'); return (el.tagName === 'BUTTON' && (t === 'submit' || (!t && !!f))) || (el.tagName === 'INPUT' && ['submit', 'image'].includes(t)); };
  H.labelOf = el => {
    const out = { text: null, visible: false, how: null };
    const cand = [];
    if (el.labels) for (const l of el.labels) cand.push([l, 'label']);
    const wrap = el.closest('label'); if (wrap && !cand.some(c => c[0] === wrap)) cand.push([wrap, 'label']);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) for (const id of lb.split(/\s+/)) { const e = document.getElementById(id); if (e) cand.push([e, 'labelledby']); }
    for (const [l, how] of cand) {
      const t = T(l.innerText || l.textContent, 300);
      if (!t) continue;
      if (!out.text) { out.text = t; out.how = how; }
      if (H.shown(l)) { out.text = t; out.how = how; out.visible = true; break; }
    }
    if (!out.text) { // titles that sit next to the field (constructors: .t-input-title, .form-label…)
      const grp = el.closest('.t-input-group, .form-group, .form-field, .form-item, .form__item, .field, .input-group, [class*="field" i], [class*="input-wrap" i]');
      if (grp) {
        const t = q('.t-input-title, .t-input-group__title, label, legend, [class*="title" i], [class*="label" i]', grp).find(x => !x.contains(el) && !x.querySelector('input, select, textarea') && T(x.innerText));
        if (t) { out.text = T(t.innerText, 300); out.visible = H.shown(t); out.how = 'group'; }
      }
    }
    return out;
  };
  H.masking = el => {
    const out = new Set();
    for (let a = el; a && a.nodeType === 1; a = a.parentElement) {
      const c = ' ' + cls(a) + ' ';
      if (c.includes(' ym-disable-keys ')) out.add('ym-disable-keys');
      if (c.includes(' ym-hide-content ')) out.add('ym-hide-content');
      if (c.includes(' ym-record-keys ')) out.add('ym-record-keys');
      if (a.hasAttribute('data-hj-suppress')) out.add('data-hj-suppress');
      if (a.hasAttribute('data-hj-allow')) out.add('data-hj-allow');
      if (a.getAttribute('data-clarity-mask') === 'true') out.add('data-clarity-mask');
      if (a.getAttribute('data-clarity-unmask') === 'true') out.add('data-clarity-unmask');
    }
    return [...out];
  };
  H.maskOf = el => {
    for (const a of ['data-mask', 'data-tilda-mask', 'data-inputmask', 'data-inputmask-mask', 'data-phonemask', 'data-masked', 'mask', 'im-insert', 'data-mask-format', 'data-phone-mask'])
      if (el.hasAttribute(a)) return { kind: 'attr', detail: a + (el.getAttribute(a) ? '=' + T(el.getAttribute(a), 40) : '') };
    const c = cls(el);
    if (/t-input-phonemask|js-phonemask/.test(c)) return { kind: 'tilda-phonemask', detail: null };
    if (el.closest('.iti') || (el.parentElement && el.parentElement.querySelector('.iti__flag-container, .iti__country-container'))) return { kind: 'intl-tel-input', detail: 'country list' };
    if (/mask/i.test(c)) return { kind: 'class', detail: T(c, 60) };
    const ph = el.getAttribute('placeholder') || '';
    if (/[_#Xx9]{2,}/.test(ph) && /[-()\s]/.test(ph)) return { kind: 'placeholder-pattern', detail: T(ph, 40) };
    if (el.getAttribute('pattern')) return { kind: 'pattern', detail: T(el.getAttribute('pattern'), 60) };
    return null;
  };
  const KINDS = [
    ['password', t => t === 'password'],
    ['search', (t, h) => t === 'search' || /^(q|s|search|query|text_search)$/i.test(h.name) || /поиск|search|найти/i.test(h.ph)],
    ['consent', (t, h) => t === 'checkbox' && CONSENT.test(h.label)],
    ['file', t => t === 'file'],
    ['email', (t, h) => t === 'email' || /e-?mail|почт/i.test(h.all)],
    ['phone', (t, h) => t === 'tel' || /phone|(^|[^a-z])tel([^a-z]|$)|телеф|моб|номер тел/i.test(h.all)],
    ['telegram', (t, h) => /telegram|телеграм|(^|[^a-z])tg([^a-z]|$)|никнейм|(^|[^а-я])ник([^а-я]|$)/i.test(h.all)],
    ['company', (t, h) => /company|organi[sz]ation|организац|компани/i.test(h.all)],
    ['name', (t, h) => /(^|[^a-z])(name|fio|fullname|firstname|lastname|surname|first_name|last_name|your-name)([^a-z]|$)|(^|[^а-я])имя|фио|фамили/i.test(h.all)],
    ['address', (t, h) => /address|street|адрес|улиц/i.test(h.all)],
    ['birth', (t, h) => /birth|bday|рожден|возраст/i.test(h.all)],
    ['passport', (t, h) => /passport|паспорт|snils|снилс|(^|[^a-zа-я])инн([^a-zа-я]|$)/i.test(h.all)],
    ['card', (t, h) => /cc-number|card.?number|номер карт|cvv|cvc/i.test(h.all)],
    ['message', (t, h) => h.tag === 'textarea' || /message|comment|сообщ|коммент|вопрос/i.test(h.all)],
  ];
  const EXP = { phone: ['tel', 'tel-national'], email: ['email'], name: ['name', 'given-name', 'family-name', 'additional-name', 'nickname'], address: ['street-address', 'address-line1', 'address-level2', 'postal-code'],
    company: ['organization'], birth: ['bday'], telegram: ['username', 'nickname'] };
  H.field = el => {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
    const lab = H.labelOf(el);
    const aria = T(el.getAttribute('aria-label'), 120) || null;
    const ph = el.getAttribute('placeholder');
    const h = { tag, name: el.getAttribute('name') || '', ph: ph || '', label: lab.text || '',
      all: [type, el.getAttribute('name'), el.id, el.getAttribute('autocomplete'), ph, lab.text, aria, el.getAttribute('data-tilda-rule')].filter(Boolean).join(' ') };
    const kind = (KINDS.find(([, f]) => f(type, h)) || ['other'])[0];
    // custom checkboxes are drawn by their label while the input itself is hidden
    const rr = el.getBoundingClientRect();
    const onScreenX = rr.right > 0 && rr.left < innerWidth + 1;
    const shown = (H.shown(el) && onScreenX) || (['checkbox', 'radio'].includes(type) && !!lab.visible);
    const labelKind = lab.visible ? 'visible' : aria || el.getAttribute('aria-labelledby') ? 'aria-only' : ph ? 'placeholder-only' : el.getAttribute('title') ? 'title-only' : lab.text ? 'hidden-label' : 'none';
    const required = { attr: el.required === true || el.hasAttribute('required'), aria: el.getAttribute('aria-required') === 'true',
      platform: el.getAttribute('data-tilda-req') === '1' || el.hasAttribute('data-required') || /(^|\s)(required|js-required|is-required|wpcf7-validates-as-required)(\s|$)/.test(cls(el)) || el.hasAttribute('data-rule-required') || el.hasAttribute('data-val-required') || el.getAttribute('data-validate') === 'required',
      asterisk: /\*/.test(lab.text || '') || /\*\s*$/.test(ph || '') };
    const ac = el.getAttribute('autocomplete');
    const exp = EXP[kind] || null;
    const toks = String(ac || '').toLowerCase().split(/\s+/);
    let fontPx = null; try { fontPx = parseFloat(cs(el).fontSize) || null; } catch (e) { /* detached */ }
    const r = el.getBoundingClientRect();
    return { tag, type, kind, pii: PII.includes(kind), name: el.getAttribute('name'), id: el.id || null, sel: H.sel(el), label: lab.text ? T(lab.text, 120) : null, label_visible: !!lab.visible, label_kind: labelKind,
      aria_label: aria, placeholder: ph ? T(ph, 120) : null, required, autocomplete: ac, autocomplete_expected: exp ? exp[0] : null,
      autocomplete_ok: exp ? (ac ? toks.some(t => exp.includes(t)) : false) : null, inputmode: el.getAttribute('inputmode'), pattern: el.getAttribute('pattern'),
      maxlength: el.getAttribute('maxlength'), minlength: el.getAttribute('minlength'), mask: H.maskOf(el),
      accept: type === 'file' ? el.getAttribute('accept') : undefined, multiple: type === 'file' ? el.multiple : undefined,
      checked_default: ['checkbox', 'radio'].includes(type) ? (el.hasAttribute('checked') || el.checked) : undefined,
      prefilled: !['checkbox', 'radio', 'select', 'file'].includes(type) && !!el.value ? true : undefined,
      options: tag === 'select' ? el.options.length : undefined, shown, font_px: fontPx, size: [Math.round(r.width), Math.round(r.height)], masked: H.masking(el), disabled: el.disabled || undefined };
  };
  H.consent = root => {
    const boxes = q('input[type=checkbox]', root).map(cb => {
      const lab = H.labelOf(cb);
      let text = lab.text || '';
      if (!text && cb.parentElement) text = T(cb.parentElement.innerText, 400);
      if (!CONSENT.test(text)) return null;
      const lroot = (cb.labels && cb.labels[0]) || cb.closest('label') || cb.parentElement;
      return { sel: H.sel(cb), text: T(text, 300), checked_default: cb.hasAttribute('checked') || cb.checked,
        required: cb.required || cb.getAttribute('aria-required') === 'true' || cb.getAttribute('data-tilda-req') === '1',
        links: lroot ? q('a[href]', lroot).slice(0, 5).map(a => ({ text: T(a.innerText, 60), href: a.href })) : [],
        mentions: { pd: M_PD.test(text), policy: M_POLICY.test(text), ads: M_ADS.test(text), cookie: M_COOKIE.test(text), offer: M_OFFER.test(text) },
        test_text: /(^|\s)(тест|test|lorem|текст согласия)(\s|$)/i.test(text) || T(text).length < 8, shown: H.shown(cb) || !!lab.visible };
    }).filter(Boolean);
    const byAction = [];
    for (const el of q('p, span, div, small, label, li', root)) {
      if (byAction.length >= 3 || el.children.length > 4) continue;
      const t = T(el.innerText, 420);
      if (t.length < 20 || t.length > 400) continue;
      if (/(нажимая|отправляя|оставляя|продолжая|заполняя|by (clicking|submitting|continuing|sending))/i.test(t) && /(соглаш|соглас|agree|consent|принима|accept)/i.test(t)) {
        if (byAction.some(b => b.text.includes(t) || t.includes(b.text))) continue;
        byAction.push({ text: t, links: q('a[href]', el).slice(0, 5).map(a => ({ text: T(a.innerText, 60), href: a.href })) });
      }
    }
    const policyLinks = q('a[href]', root).filter(a => /политик|конфиденц|персональн|privacy|policy|соглашени|оферт|terms/i.test(T(a.innerText) + ' ' + a.getAttribute('href'))).slice(0, 5).map(a => ({ text: T(a.innerText, 60), href: a.href }));
    return { checkboxes: boxes, by_action: byAction, policy_links: policyLinks };
  };
  H.antispam = root => {
    const honeypot = q('input', root).filter(i => {
      const t = (i.getAttribute('type') || 'text').toLowerCase();
      if (!['text', 'email', 'url', 'tel'].includes(t)) return false;
      const r = i.getBoundingClientRect();
      const offscreen = !H.shown(i) || r.right <= 0 || r.left >= innerWidth + 50 || r.bottom < -500;
      if (!offscreen) return false;
      return /(hp|honeypot|website|homepage|fax|address2|leave.?blank|b_[a-f0-9]{6,}|_?gotcha|email_?confirm)/i.test((i.name || '') + ' ' + (i.id || '') + ' ' + cls(i)) || (i.getAttribute('tabindex') === '-1' && i.getAttribute('autocomplete') === 'off');
    }).map(i => ({ name: i.name || null, sel: H.sel(i) }));
    const captcha = q('.g-recaptcha, [data-sitekey], .h-captcha, .smart-captcha, .cf-turnstile, iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="smartcaptcha"], iframe[src*="turnstile"]', root).map(e => T(cls(e) || e.tagName, 40)).slice(0, 3);
    const tokens = q('input[type=hidden]', root).filter(i => /csrf|token|nonce|_wpnonce|sessid|form_key|authenticity|requestverification|timestamp/i.test(i.name || '')).map(i => i.name).slice(0, 5);
    return { honeypot, captcha, tokens };
  };
  H.hiddenFields = root => q('input[type=hidden]', root).slice(0, 40).map(i => {
    const n = i.getAttribute('name') || i.id || '';
    const k = /utm/i.test(n) ? 'utm' : /client_?id|_ym_uid|ym_?uid|ymclid|yclid|gclid|fbclid|(^|_)ga($|_)|(^|_)cid$|roistat|metrika/i.test(n) ? 'clientid'
      : /refer|landing|page_?url|pageurl|source_?url|(^|_)url$/i.test(n) ? 'page' : /csrf|token|nonce|sessid|form_key|authenticity/i.test(n) ? 'token'
      : /redirect|_next|success|thank|return/i.test(n) ? 'redirect' : 'other';
    return { name: n || null, kind: k, has_value: !!i.value, value_len: (i.value || '').length, value: k === 'redirect' ? T(i.value, 200) : undefined };
  });
  H.submits = (root, formless) => q(formless ? 'button, input[type=submit], input[type=button], [role=button], a[class*="btn" i], a[class*="button" i]' : 'button, input[type=submit], input[type=image]', root)
    .filter(b => formless || b.tagName !== 'BUTTON' || !b.getAttribute('type') || b.getAttribute('type').toLowerCase() === 'submit')
    .slice(0, 4).map(b => ({ text: T(b.innerText || b.value || b.getAttribute('aria-label'), 80), sel: H.sel(b), shown: H.shown(b) }));
  H.thanks = f => {
    const out = { success_url: null, message: null, redirect_field: null };
    out.success_url = f.getAttribute('data-success-url') || f.getAttribute('data-redirect') || f.getAttribute('data-success-redirect') || null;
    const rf = q('input[type=hidden]', f).find(i => /^(redirect|_next|success_url|return_url|thanks?_?url|_redirect)$/i.test(i.name || ''));
    if (rf && rf.value) out.redirect_field = T(rf.value, 200);
    const scope = f.parentElement || f;
    const box = q('.t-form__successbox, .js-successbox, [class*="success" i], [class*="thank" i], [data-success-message], .wpcf7-response-output', scope)
      .find(e => T(e.innerText || e.getAttribute('data-success-message')));
    if (box) out.message = T(box.innerText || box.getAttribute('data-success-message'), 200);
    if (!out.message && f.getAttribute('data-success-message')) out.message = T(f.getAttribute('data-success-message'), 200);
    for (const k of ['success_url', 'redirect_field']) if (out[k]) { try { out[k] = new URL(out[k], location.href).href; } catch (e) { /* keep raw */ } }
    return out;
  };
  H.headingNear = f => {
    const scope = H.popupOf(f) || f.closest('section, article, .t-rec, [class*="block" i]') || f.parentElement;
    const h = scope && q('h1, h2, h3, h4, [class*="title" i]', scope).find(x => !f.contains(x) && T(x.innerText));
    return h ? T(h.innerText, 100) : null;
  };
  const djb = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(16).padStart(8, '0'); };
  // the widest wrapper (up to 3 levels, never past the popup) that holds only this form: no other form, no other text fields
  H.ownScope = (f, popup) => {
    let best = null;
    for (let a = f.parentElement, k = 0; a && a !== document.body && a !== document.documentElement && k < 3; a = a.parentElement, k++) {
      const otherForm = q('form', a).some(x => x !== f && !f.contains(x) && !x.contains(f));
      const otherFields = q(TEXT_FIELDS, a).some(x => !f.contains(x));
      if (otherForm || otherFields) break;
      best = a;
      if (a === popup) break;
    }
    return best;
  };
  // page-level containers: a climb from a field or a button never goes into them
  H.pageLevel = a => !a || a === document.body || a === document.documentElement || a.tagName === 'MAIN' || a.matches('[role=main]')
    || q(':scope > section, :scope > article, :scope > .t-rec', a).length >= 2 || q('h2', a).length >= 2;
  // a block of the page: the climb stops after it
  H.blockLevel = a => /^(SECTION|ARTICLE|ASIDE|HEADER|FOOTER)$/.test(a.tagName) || a.matches('.t-rec,[role=region],[role=dialog],dialog');
  // helper buttons next to a field (clear «×», show password, country picker): not the send button of the block
  H.helperButton = b => {
    if (b.closest('.iti, .intl-tel-input, [class*="country" i]')) return true;
    const sig = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '') + ' ' + cls(b) + ' ' + (b.id || '')).toLowerCase();
    if (/clear|reset|close|show|hide|toggle|password|eye|country|flag|dial|очист|закры|показ|скры|парол|стран/.test(sig)) return true;
    return !T(b.innerText || b.value || b.textContent || '') && !b.getAttribute('aria-label');
  };
  // contact fields outside <form> (SPA forms): grouped by the nearest container that also holds a real button,
  // never past a block of the page (section, Tilda block) or into a page-level wrapper
  H.formlessGroups = root => {
    const groups = new Set();
    const BTN = 'button, [role=button], input[type=submit], input[type=button], a[href^="javascript"], a[href="#"]';
    for (const el of q('input:not([type=hidden]), textarea', root || document)) {
      if (el.form || el.closest('form')) continue;
      const k = H.field(el).kind;
      if (!['phone', 'email', 'name', 'telegram', 'message'].includes(k)) continue;
      let c = el.parentElement, pick = null, last = null;
      for (let i = 0; i < 14 && c && !H.pageLevel(c); i++, c = c.parentElement) {
        last = c;
        if (q(BTN, c).some(b => !H.helperButton(b))) { pick = c; break; }
        if (H.blockLevel(c)) break;
      }
      // no real button up to the block: the block itself (or the field's wrapper) is the group
      pick = pick || last;
      if (pick) groups.add(pick);
    }
    return [...groups].filter(c => ![...groups].some(o => o !== c && o.contains(c)));
  };
  H.formRecord = (f, formless) => {
    const fieldEls = formless ? q('input:not([type=hidden]), textarea, select', f).filter(el => !el.closest('form'))
      : q('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]):not([type=reset]), textarea, select', f);
    const fields = fieldEls.slice(0, 40).map(H.field);
    const actionAttr = formless ? null : f.getAttribute('action');
    let action = null;
    if (!formless) { try { action = new URL(actionAttr === null ? location.href : actionAttr || location.href, location.href).href; } catch (e) { action = actionAttr; } }
    const popup = H.popupOf(f);
    let consent = H.consent(f);
    if (!consent.checkboxes.length && !consent.by_action.length) {
      // consent text next to the form (outside it): only from a wrapper that holds no other form and no other fields,
      // otherwise the neighbour form's consent and policy link would be credited to this one
      const outer = H.ownScope(f, popup);
      if (outer) { const c2 = H.consent(outer); consent = { checkboxes: [], by_action: c2.by_action, policy_links: consent.policy_links.length ? consent.policy_links : c2.policy_links, outside_form: !!c2.by_action.length || (!consent.policy_links.length && !!c2.policy_links.length) }; }
    }
    // a submit button may override the form method and action (formmethod / formaction), also <button form="id"> outside the form
    let subOverrides = [];
    if (!formless) {
      const isSub = b => { const t = (b.getAttribute('type') || '').toLowerCase(); return (b.tagName === 'BUTTON' && (t === 'submit' || !t)) || (b.tagName === 'INPUT' && ['submit', 'image'].includes(t)); };
      const subs = q('button, input[type=submit], input[type=image]', f).filter(isSub);
      if (f.id) for (const b of q(`button[form="${CSS.escape(f.id)}"], input[form="${CSS.escape(f.id)}"]`)) if (isSub(b) && !subs.includes(b)) subs.push(b);
      subOverrides = subs.slice(0, 6).map(b => {
        let fa = b.getAttribute('formaction'); if (fa !== null) { try { fa = new URL(fa || location.href, location.href).href; } catch (e) { /* keep raw */ } }
        return { method: (b.getAttribute('formmethod') || '').toLowerCase() || null, action: fa };
      });
    }
    const c = cls(f);
    const platform = /(^|\s)t-form/.test(c) || f.closest('.t-rec') || /tildacdn|tilda/i.test(actionAttr || '') ? 'tilda' : /wpcf7/.test(c) ? 'contact-form-7' : /(^|\s)w-form/.test(c) || f.hasAttribute('data-wf-page-id') ? 'webflow'
      : /bitrix|iblock|b24-form/i.test(c + ' ' + (actionAttr || '') + ' ' + (f.getAttribute('name') || '')) ? 'bitrix' : /wpforms|gform|elementor-form|forminator/i.test(c) ? 'wordpress-plugin' : null;
    const submits = H.submits(f, formless);
    const rec = { sel: H.sel(f), formless, id: f.id || null, name: f.getAttribute('name'), region: H.region(f), in_popup: !!popup, popup_sel: popup ? H.sel(popup) : null,
      shown: H.shown(f), hidden_in: H.hiddenIn(f), box: H.box(f), heading: H.headingNear(f),
      action, action_attr: actionAttr, method: formless ? null : (f.getAttribute('method') || 'get').toLowerCase(), method_set: formless ? null : f.hasAttribute('method'),
      enctype: formless ? null : f.getAttribute('enctype'), novalidate: formless ? null : f.hasAttribute('novalidate'), target: formless ? null : f.getAttribute('target'),
      data_attrs: formless ? [] : [...f.attributes].filter(a => /^data-(success|formactiontype|action|url|endpoint|redirect|tilda)/i.test(a.name)).slice(0, 8).map(a => a.name + '=' + T(a.value, 80)),
      platform, fields, hidden: H.hiddenFields(f), submits, consent, antispam: H.antispam(f), thanks: formless ? null : H.thanks(f) };
    if (!formless) {
      const own = rec.method;
      const ms = subOverrides.length ? [...new Set(subOverrides.map(o => o.method || own))] : [own];
      rec.method_effective = ms.length === 1 ? ms[0] : 'mixed';
      if (subOverrides.some(o => o.method || o.action !== null)) rec.submit_overrides = subOverrides;
    }
    const hp = new Set(rec.antispam.honeypot.map(x => x.sel));
    for (const x of fields) if (hp.has(x.sel)) { x.honeypot = true; x.pii = false; }
    rec.pii = [...new Set(fields.filter(x => x.pii).map(x => x.kind))];
    let host = ''; try { host = action ? new URL(action).hostname : ''; } catch (e) { /* */ }
    // structure + what the visitor reads and must fill: copies of a form that differ in consent or required fields are different forms
    rec.sig = djb([host, rec.method, fields.map(x => x.kind + ':' + (x.name || x.type) + (x.required.attr || x.required.aria || x.required.platform ? '*' : '')).join(','),
      submits.map(s => s.text).join('|'), consent.checkboxes.map(c => c.text.slice(0, 80)).join('|'), consent.by_action.map(c => c.text.slice(0, 80)).join('|'), formless ? 'formless' : 'form'].join('#'));
    return rec;
  };
  H.inventory = rootSel => {
    const root = rootSel ? document.querySelector(rootSel) : document;
    if (!root) return { forms: [] };
    const forms = (root.tagName === 'FORM' ? [root] : q('form', root)).slice(0, 40).map(f => H.formRecord(f, false));
    for (const c of H.formlessGroups(root).slice(0, 10)) forms.push(H.formRecord(c, true));
    return { forms };
  };
  H.validity = sels => {
    const FLAGS = ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort', 'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'];
    const flagsOf = el => { const v = el.validity; return v ? FLAGS.filter(k => v[k]) : []; };
    const out = {};
    for (const s of sels) {
      let f = null; try { f = document.querySelector(s); } catch (e) { /* bad selector */ }
      if (!f) continue;
      const els = f.tagName === 'FORM' ? [...f.elements] : q('input, textarea, select', f);
      let valid = null;
      // checkValidity() fires «invalid» events only; nothing is submitted
      try { valid = f.tagName === 'FORM' ? f.checkValidity() : els.every(el => !el.willValidate || el.checkValidity()); } catch (e) { /* */ }
      const invalid = els.filter(el => el.willValidate && el.validity && !el.validity.valid).slice(0, 20).map(el => ({ name: el.name || el.id || el.type, flags: flagsOf(el) }));
      // platform validators (tildaForm.validate) live in the page's own JS world: see PAGE_WORLD on the node side
      out[s] = { valid, invalid, platform: null };
    }
    return out;
  };
  H.contacts = () => {
    const MESS = /^(https?:\/\/)?(www\.)?(t\.me|telegram\.me|wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|vk\.me|m\.me|ig\.me|max\.ru)|^(tg|whatsapp|viber|skype):|vk\.com\/(write|im)/i;
    const out = { tel: [], mailto: [], messengers: [] };
    for (const a of q('a[href]')) {
      const href = a.getAttribute('href') || '';
      const text = T(a.innerText || a.getAttribute('aria-label') || a.title, 60);
      const base = () => ({ href: href.slice(0, 200), text, region: H.region(a), shown: H.shown(a) });
      if (/^tel:/i.test(href)) {
        const r = base(); const hd = href.replace(/\D/g, ''); const td = text.replace(/\D/g, '');
        r.digits = hd; r.text_digits = td || null; r.format = /^tel:\s*\+/i.test(href) ? 'intl' : /^tel:\s*8/i.test(href) ? 'national-8' : 'other';
        r.mismatch = td.length >= 10 && hd.length >= 10 && td.slice(-10) !== hd.slice(-10);
        if (out.tel.length < 30) out.tel.push(r);
      } else if (/^mailto:/i.test(href)) { if (out.mailto.length < 30) out.mailto.push(base()); }
      else if (MESS.test(href)) {
        const r = base();
        r.service = /t\.me|telegram|^tg:/i.test(href) ? 'telegram' : /whatsapp|wa\.me/i.test(href) ? 'whatsapp' : /viber/i.test(href) ? 'viber' : /vk\.(me|com)/i.test(href) ? 'vk' : /max\.ru/i.test(href) ? 'max' : /skype/i.test(href) ? 'skype' : /m\.me|ig\.me/i.test(href) ? 'meta' : 'other';
        if (out.messengers.length < 30) out.messengers.push(r);
      }
    }
    return out;
  };
  H.calculators = () => {
    const contactForm = f => !!f && q('input, textarea', f).some(el => ['phone', 'email', 'name', 'telegram', 'message'].includes(H.field(el).kind));
    const cand = q('input, select').filter(el => {
      const t = (el.tagName === 'SELECT' ? 'select' : (el.getAttribute('type') || 'text')).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password', 'search', 'email', 'tel'].includes(t)) return false;
      return !['search', 'phone', 'email', 'name', 'telegram', 'message', 'consent', 'password', 'address', 'company'].includes(H.field(el).kind);
    });
    const groups = new Map();
    for (const el of cand) {
      const box = (el.parentElement || el).closest('[class*="calc" i], [id*="calc" i], [data-calc], .t-calc, .t-rec, section, article, form') || el.parentElement;
      if (!groups.has(box)) groups.set(box, []);
      groups.get(box).push(el);
    }
    const out = [];
    for (const [box, els] of groups) {
      const numeric = els.filter(e => ['number', 'range'].includes((e.getAttribute('type') || '').toLowerCase()) || e.tagName === 'SELECT');
      const calcy = /calc|кальк|расч[её]т|рассчит|стоимост|итого|total|price|цена/i.test(cls(box) + ' ' + (box.id || '') + ' ' + T(box.innerText, 400));
      const expr = q('[data-calc-expr], [data-formula], [data-calc-formula]', box).map(e => T(e.getAttribute('data-calc-expr') || e.getAttribute('data-formula') || e.getAttribute('data-calc-formula'), 300)).filter(Boolean);
      if (!((numeric.length || els.length >= 2) && calcy) && !expr.length) continue;
      const form = box.tagName === 'FORM' ? box : box.closest('form');
      const outputs = q('output, [class*="result" i], [class*="total" i], [class*="itog" i], [class*="sum" i], [id*="total" i], [id*="result" i], [class*="price" i], .t-calc', box)
        .filter(e => H.shown(e) && !e.querySelector('input, select') && T(e.innerText)).slice(0, 6).map(e => ({ sel: H.sel(e), text: T(e.innerText, 60) }));
      const head = q('h1, h2, h3, h4', box)[0];
      out.push({ sel: H.sel(box), heading: head ? T(head.innerText, 100) : null, in_form: !!form, in_contact_form: contactForm(form), region: H.region(box), shown: H.shown(box),
        fields: els.slice(0, 12).map(e => { const fr = H.field(e); return { sel: fr.sel, type: fr.type, name: fr.name, label: fr.label || fr.aria_label || fr.placeholder,
          value: (e.type === 'checkbox' || e.type === 'radio') ? (e.checked ? 'checked' : '') : T(e.value, 40), min: e.getAttribute('min'), max: e.getAttribute('max'), step: e.getAttribute('step'),
          options: e.tagName === 'SELECT' ? [...e.options].slice(0, 10).map(o => T(o.textContent, 40) + (o.value !== o.textContent ? ' = ' + T(o.value, 20) : '')) : undefined }; }),
        outputs, expr: expr.slice(0, 3), box: H.box(box) });
      if (out.length >= 10) break;
    }
    return out;
  };
  H.codeDump = () => {
    const inline = []; let total = 0;
    for (const s of q('script:not([src])')) {
      const t = (s.getAttribute('type') || '').toLowerCase();
      if (t && !/javascript|module|ecmascript/.test(t)) continue;
      const c = s.textContent || '';
      if (!c.trim() || total > 1500000) continue;
      total += c.length; inline.push(c.slice(0, 300000));
    }
    const noscripts = q('noscript').map(n => (n.textContent || '').slice(0, 5000));
    const attrs = [];
    for (const el of q('[onclick], [onsubmit], [onchange], [data-goal], [data-ym-goal], [data-metrika-goal], [data-gtm-event], [data-event]')) {
      for (const a of ['onclick', 'onsubmit', 'onchange', 'data-goal', 'data-ym-goal', 'data-metrika-goal', 'data-gtm-event', 'data-event']) {
        const v = el.getAttribute(a);
        if (v && attrs.length < 300) attrs.push({ attr: a, value: v.slice(0, 400), sel: H.sel(el), text: T(el.innerText, 40) });
      }
    }
    return {
      inline, noscripts, attrs, srcs: q('script[src]').map(s => s.src).slice(0, 300),
      iframes: q('iframe').slice(0, 40).map(f => ({ src: (f.getAttribute('src') ? f.src : (f.getAttribute('data-src') || '')).slice(0, 300), title: f.getAttribute('title'), shown: H.shown(f), box: H.box(f), region: H.region(f) })),
      verification: q('meta[name]').map(m => m.getAttribute('name')).filter(n => /verification|verify|validate|msvalidate|mailru-domain/i.test(n)),
      libs: null, // filled from the page world (PAGE_WORLD): the isolated world does not see the site's globals
      captcha_scripts: q('script[src]').map(s => s.src).filter(u => /recaptcha|hcaptcha|smartcaptcha|turnstile/i.test(u)).slice(0, 3),
    };
  };
  // ---- layers and toggles
  H.isOpenLayer = el => {
    if (!H.shown(el)) return false;
    if (el.matches('dialog[open],[role=dialog],[role=alertdialog],[aria-modal=true]')) return true;
    const s = cs(el);
    if (s.position !== 'fixed' && !(s.position === 'absolute' && POP.test(cls(el) + ' ' + (el.id || '')))) return false;
    const r = el.getBoundingClientRect();
    return r.width * r.height >= 0.2 * innerWidth * innerHeight && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;
  };
  H.openLayers = () => {
    const out = [];
    for (const el of document.body.getElementsByTagName('*')) { if (out.length > 40) break; if (H.isOpenLayer(el)) out.push(el); }
    return out.filter(el => !out.some(o => o !== el && o.contains(el)));
  };
  H.autoLayers = () => {
    if (!document.getElementById('__rvf_hide')) { const st = document.createElement('style'); st.id = '__rvf_hide'; st.textContent = '[data-rvf-hidden]{display:none!important}'; document.documentElement.appendChild(st); }
    const COOKIE = /(cookie|куки|кукис|gdpr|consent)/i;
    const out = [];
    for (const el of [...document.body.getElementsByTagName('*')]) {
      const s = cs(el);
      if (s.position !== 'fixed' && s.position !== 'sticky') continue;
      if (!H.shown(el) || (el.parentElement && el.parentElement.closest('[data-rvf-hidden]'))) continue;
      const r = el.getBoundingClientRect();
      const area = Math.max(0, Math.min(r.right, innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, innerHeight) - Math.max(r.top, 0));
      const t = T(el.innerText, 1500);
      let kind = null;
      const headerLike = r.top < 5 && r.height < 130 && !COOKIE.test(t);
      if (!headerLike && r.height < innerHeight * 0.85 && t.length < 1500 && COOKIE.test(t)) kind = 'cookie';
      else if (area >= innerWidth * innerHeight * 0.4 && (el.matches('dialog,[role=dialog],[aria-modal=true]') || POP.test(cls(el) + ' ' + (el.id || '')))) kind = 'modal';
      if (!kind) continue;
      out.push({ kind, sel: H.sel(el), text: T(t, 80), forms: q('form', el).length, fields: q('input:not([type=hidden]), textarea', el).length, box: H.vbox(el) });
      el.setAttribute('data-rvf-hidden', kind);
    }
    return out;
  };
  // Why a candidate must never be tapped: it may itself be the «send» of a form. A button inside a form (also a link
  // styled as a button, <button form="id">), a button in a block with visible text fields (forms without <form> send by
  // fetch / JSONP / new Image() — plain GET, the non-GET safety net does not see them), a «send / call me back» button
  // without an explicit popup link. null = safe to tap.
  const SEND_WORDS = /отправ|(?<![\p{L}])(?:send|submit)(?![\p{L}])|перезвон|жду звонка|жду ответа/iu;
  // actions that change something on the site or reveal a tracked number: never pressed
  const DENY_WORDS = /избранн|нравится|(?<![\p{L}])(?:лайк|like|vote|follow|favou?rite)(?![\p{L}])|показать (?:номер|телефон)|проголосова|в сравнени|сравнить|отписаться|unsubscribe|удалить|delete|выйти|log ?out/iu;
  H.unsafeReason = (el, formless, popupSignal, text) => {
    if (DENY_WORDS.test(text)) return 'site-action';
    // inside a cookie / consent banner (the banner is the privacy script's business)
    for (let a = el, k = 0; a && a !== document.body && k < 8; a = a.parentElement, k++) if (/cookie|consent|gdpr|(?<![a-z])cmp(?![a-z])/i.test((a.id || '') + ' ' + cls(a))) return 'cookie-banner';
    if (el.form instanceof HTMLFormElement) return 'in-form';
    const f = el.closest('form');
    if (f) {
      // the only exception: an in-page link to a block outside this form (a policy popup, an anchor)
      const href = el.tagName === 'A' ? (el.getAttribute('href') || '') : '';
      if (!/^#[^#]/.test(href)) return 'in-form';
      let id = href.slice(1); try { id = decodeURIComponent(id); } catch (e) { /* raw */ }
      const t = document.getElementById(id);
      if (!t || f.contains(t) || t.contains(f) || q(TEXT_FIELDS, t).some(x => x.form === f)) return 'in-form';
    }
    if (formless.some(c => c.contains(el))) return 'formless-block';
    // visible fields outside any <form> in the same block: the button may be their «send» (fetch / new Image()).
    // Fields of a <form> are sent by that form's own button (<button form=id> is caught above). Fields of a formless
    // group that does not hold this button have their own send button. A button with an explicit popup link looks
    // 4 levels up; any other button — up to the block of the page.
    const orphan = x => x !== el && !x.form && !x.closest('form') && H.shown(x) && !formless.some(c => c.contains(x));
    const loose = x => x !== el && !x.form && !x.closest('form') && H.shown(x) && ['phone', 'email', 'name', 'telegram'].includes(H.field(x).kind);
    for (let a = el.parentElement, k = 0; a && !H.pageLevel(a) && k < (popupSignal ? 4 : 10); a = a.parentElement, k++) {
      const fs = q(TEXT_FIELDS, a);
      if (fs.some(orphan) || (!popupSignal && fs.some(loose))) return 'near-fields';
      if (H.blockLevel(a)) break;
    }
    if (SEND_WORDS.test(text) && !popupSignal) return 'send-like';
    return null;
  };
  H.toggles = () => {
    const CTA = /запис|заявк|заказ|оставить|связат|консульт|обратн|звон|перезвон|получить|рассчит|расч[её]т|подобрать|заброниров|бронь|оформить|купить|узнать (цену|стоимость)|задать вопрос|написать нам|напишите|пробн|book|order|request|contact|callback|call me|sign ?up|get (a )?quote|get started|subscribe|enquir|inquir|apply/i;
    const HOOK = /^#(popup|order|modal|form|callback|zayav|zakaz|zapis|feedback|request|contact|lead)/i;
    const groups = new Map();
    const formless = H.formlessGroups(document);
    const els = q('a, button, [role=button], [data-toggle], [data-bs-toggle], [aria-haspopup], [data-fancybox], [data-micromodal-trigger], [data-modal], [data-modal-target], [data-popup], [data-target], [data-src], [data-remodal-target], [onclick]');
    for (const el of els) {
      if (el.closest('[data-rvf-hidden]') || isSubmit(el)) continue;
      const tag = el.tagName, href = el.getAttribute('href');
      // controls of a form are never toggles; links inside a form are judged by unsafeReason below
      if ((el.closest('form') || el.form instanceof HTMLFormElement) && tag !== 'A') continue;
      if (['INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'IFRAME'].includes(tag)) continue;
      const text = T(el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.value, 80);
      const target = el.getAttribute('data-target') || el.getAttribute('data-bs-target') || el.getAttribute('data-src') || el.getAttribute('data-modal') || el.getAttribute('data-modal-target')
        || el.getAttribute('data-micromodal-trigger') || el.getAttribute('data-remodal-target') || el.getAttribute('aria-controls') || el.getAttribute('data-popup') || null;
      const hp = (el.getAttribute('aria-haspopup') || '').toLowerCase();
      const hay = cls(el) + ' ' + (el.id || '');
      if (/burger|hamburger|menu-?toggle|nav-?toggle|navbar-toggler|mobile-?menu|menu-?btn|menu-?button|menu-?icon/i.test(hay) || /^(меню|menu|☰|≡)$/i.test(text) || hp === 'menu') continue;
      let kind = null;
      if (tag === 'A' && href !== null) {
        if (/^javascript:/i.test(href) || href === '#' || href === '') kind = CTA.test(text) || target ? 'dialog' : null;
        else if (href.startsWith('#')) {
          if (HOOK.test(href) || /^#popup:/i.test(href)) kind = 'dialog';
          else {
            let id = href.slice(1); try { id = decodeURIComponent(id); } catch (e) { /* */ }
            const t = document.getElementById(id) || document.getElementsByName(id)[0];
            if (t && H.shown(t)) kind = t.querySelector('form, input, textarea') && CTA.test(text) ? 'anchor-form' : null;
            else if (t) kind = 'dialog';
            else kind = CTA.test(text) ? 'dialog' : null;
          }
        } else continue; // links to other pages are never tapped
      } else {
        const tog = (el.getAttribute('data-toggle') || '') + ' ' + (el.getAttribute('data-bs-toggle') || '');
        if (hp === 'dialog' || hp === 'true' || /modal|popup|dialog|offcanvas/i.test(tog) || el.hasAttribute('data-fancybox') || el.hasAttribute('data-micromodal-trigger') || el.hasAttribute('data-remodal-target') || (target && /^#/.test(target))) kind = 'dialog';
        else if ((tag === 'BUTTON' || el.getAttribute('role') === 'button' || el.hasAttribute('onclick')) && CTA.test(text)) kind = 'dialog';
        else continue;
      }
      if (!kind || !text && !target) continue;
      // buy / add-to-cart buttons without an explicit popup link may change a cart by a background GET: never tapped
      const popupSignal = !!target || (href && /^#(popup|order|modal|form)/i.test(href)) || hp === 'dialog' || el.hasAttribute('data-fancybox') || el.hasAttribute('data-micromodal-trigger');
      if (/в корзину|купить|оформить заказ|оплатить|add to (cart|bag)|buy now|checkout|pay now/i.test(text) && !popupSignal) continue;
      const unsafe = H.unsafeReason(el, formless, popupSignal, text);
      // the same button text may open different popups on different pages: the forms inside the target are part of the key
      const tref = target || (href && href.startsWith('#') && href.length > 1 ? href : null);
      let tsig = '';
      if (tref) {
        let tel = null;
        const hook = /^#popup:/i.test(tref) ? tref : null;
        try { tel = hook ? (document.querySelector(`[data-tooltip-hook="${CSS.escape(hook)}"]`) || document.getElementById(hook.slice(7))) : document.querySelector(tref.startsWith('#') ? '#' + CSS.escape(tref.slice(1)) : tref); } catch (e) { /* not a selector */ }
        if (tel) tsig = q('form', tel).map(f => H.formRecord(f, false).sig).join(',');
      }
      const key = (target || (href && href !== '#' && !/^javascript:/i.test(href) ? href : '') || '') + '|' + text.toLowerCase() + (tsig ? '|' + tsig : '');
      if (!groups.has(key)) groups.set(key, { key, text, kind, target: target || (href && href.startsWith('#') ? href : null), instances: [] });
      const g = groups.get(key);
      if (g.instances.length < 12) g.instances.push({ sel: H.sel(el), region: H.region(el), shown: H.shown(el), box: H.box(el), unsafe: unsafe || undefined });
    }
    return [...groups.values()].sort((a, b) => (a.instances[0].box[1] - b.instances[0].box[1])).slice(0, 40);
  };
  H.prepTap = sel => {
    let el = null; try { el = document.querySelector(sel); } catch (e) { /* */ }
    if (!el) return { ok: false, why: 'not found' };
    if (!H.shown(el)) return { ok: false, why: 'not shown' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    return { ok: true };
  };
  H.tapPoint = sel => {
    let el = null; try { el = document.querySelector(sel); } catch (e) { /* */ }
    if (!el) return { ok: false, why: 'not found' };
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { ok: false, why: 'not shown' };
    // mark the state before the tap (at the same scroll position as the check after it)
    for (const e of q('[data-rvf-pre]')) e.removeAttribute('data-rvf-pre');
    for (const e of q('[data-rvf-shown0]')) e.removeAttribute('data-rvf-shown0');
    for (const e of q('[data-rvf-fshown0]')) e.removeAttribute('data-rvf-fshown0');
    for (const e of q('[data-rvf-layer]')) e.removeAttribute('data-rvf-layer');
    for (const L of H.openLayers()) L.setAttribute('data-rvf-pre', '1');
    for (const f of q('form')) if (H.shown(f)) f.setAttribute('data-rvf-shown0', '1');
    for (const f of q(TEXT_FIELDS)) if (H.shown(f)) f.setAttribute('data-rvf-fshown0', '1');
    const x = Math.round(Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 2)), y = Math.round(Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 2));
    const hit = document.elementFromPoint(x, y);
    const ok = !!hit && (hit === el || el.contains(hit));
    return { ok: true, x, y, hit_ok: ok, covered_by: ok || !hit ? null : H.sel(hit), covered_text: ok || !hit ? null : T(hit.innerText, 40), scroll: Math.round(scrollY) };
  };
  H.submitInView = () => {
    const L = document.querySelector('[data-rvf-layer]') || document;
    const b = q('button[type=submit], input[type=submit], input[type=image], form button:not([type])', L).find(H.shown);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { in_view: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth, text: T(b.innerText || b.value, 60), bottom: Math.round(r.bottom), viewport_h: innerHeight };
  };
  H.afterTap = scroll0 => {
    const fresh = H.openLayers().filter(e => !e.hasAttribute('data-rvf-pre'));
    const formsShown = q('form').filter(f => !f.hasAttribute('data-rvf-shown0') && H.shown(f));
    // a block of fields without <form> shown in place (hidden → shown, not a layer)
    const fieldsShown = q(TEXT_FIELDS).filter(f => !f.hasAttribute('data-rvf-fshown0') && !f.closest('form') && H.shown(f));
    const out = { scrolled: Math.abs(scrollY - scroll0) > 40, forms_shown: formsShown.map(H.sel).slice(0, 5), fields_shown: fieldsShown.map(H.sel).slice(0, 5), layer: null };
    const L = fresh.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return rb.width * rb.height - ra.width * ra.height; })[0];
    if (L) {
      L.setAttribute('data-rvf-layer', '1');
      const forms = q('form', L).filter(H.shown);
      const r = L.getBoundingClientRect();
      const fr = forms[0] ? forms[0].getBoundingClientRect() : null;
      const ae = document.activeElement;
      const bs = cs(document.body), hs = cs(document.documentElement);
      out.layer = { sel: H.sel(L), box: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], text: T(L.innerText, 80),
        kind: L.matches('dialog,[role=dialog],[role=alertdialog],[aria-modal=true]') ? 'dialog' : 'overlay', forms: forms.map(H.sel).slice(0, 5),
        formless_fields: q('input:not([type=hidden]), textarea', L).filter(el => !el.closest('form') && H.shown(el)).length,
        iframes: q('iframe', L).filter(H.shown).map(f => { try { return new URL(f.src, location.href).hostname; } catch (e) { return f.getAttribute('src'); } }).slice(0, 3),
        focus_in: !!ae && ae !== document.body && L.contains(ae),
        scroll_locked: /hidden|clip/.test(bs.overflow + bs.overflowY + hs.overflow + hs.overflowY) || bs.position === 'fixed',
        form_screens: fr ? Math.round(100 * fr.height / innerHeight) / 100 : null,
        content_screens: Math.round(100 * Math.max(L.scrollHeight, r.height, ...[...L.children].map(ch => ch.scrollHeight || 0)) / innerHeight) / 100 };
      out.submit = H.submitInView();
    }
    return out;
  };
  H.layerClosed = () => { const L = document.querySelector('[data-rvf-layer]'); return !L || !H.isOpenLayer(L); };
  H.closeButton = () => {
    const L = document.querySelector('[data-rvf-layer]'); if (!L) return null;
    const c = q('button, a, [role=button], [class*="close" i], [aria-label], [data-dismiss], [data-bs-dismiss], [data-close]', L).filter(e => H.shown(e) && !isSubmit(e)).find(e => {
      const t = T(e.innerText || e.textContent, 30); const lab = (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '');
      return /закры|close/i.test(lab) || /(^|[\s_-])(close|closer|modal__close|popup__close|t-popup__close|mfp-close|fancybox-close|btn-close)([\s_-]|$)/i.test(cls(e)) || e.hasAttribute('data-dismiss') || e.hasAttribute('data-bs-dismiss') || e.hasAttribute('data-close') || /^(×|✕|✖|x|х|закрыть|close)$/i.test(t);
    });
    if (!c) return null;
    let r = c.getBoundingClientRect();
    const inView = rr => rr.left + rr.width / 2 >= 0 && rr.top + rr.height / 2 >= 0 && rr.left + rr.width / 2 < innerWidth && rr.top + rr.height / 2 < innerHeight;
    let scrolled = false;
    if (!inView(r)) { c.scrollIntoView({ block: 'center', inline: 'center' }); r = c.getBoundingClientRect(); scrolled = true; }
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    return { sel: H.sel(c), x, y, on_screen: inView(r), needed_scroll: scrolled, size: [Math.round(r.width), Math.round(r.height)] };
  };
  H.backdropPoint = () => {
    const L = document.querySelector('[data-rvf-layer]'); if (!L) return null;
    for (const [x, y] of [[4, 4], [innerWidth - 5, 4], [4, innerHeight - 5], [innerWidth - 5, innerHeight - 5], [Math.round(innerWidth / 2), 4]]) {
      const e = document.elementFromPoint(x, y);
      if (!e || e.closest('a[href], button, input, select, textarea, label, [role=button], form, iframe')) continue;
      if (e === L || /overlay|backdrop|mask|fade|shade|(^|[\s_-])bg([\s_-]|$)|t-popup(?!__)/i.test(cls(e) + ' ' + (e.id || ''))) return { x, y, sel: H.sel(e) };
    }
    return null;
  };
  window.__rvf = H;
}

// ---------------------------------------------------------------------------------------------
// node side
const HELPERS_SRC = `(${PAGE_HELPERS.toString()})();`;
// DOM reading and measurements run in an isolated world: same DOM, our own JS globals, so page scripts can't spoof
// querySelectorAll, getComputedStyle, elementFromPoint and friends.
async function rv(tab, fn, ...args) {
  return tab.evaluateIsolated(`(async () => { ${HELPERS_SRC} return await window.__rvf.${fn}(...${JSON.stringify(args)}); })()`);
}

// The only reads from the page's own JS world: which mask libraries the site loaded and the platform validator
// (tildaForm.validate checks fields, sends nothing). Run under the interaction guard all the same.
function PAGE_WORLD(sels) {
  const T = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const out = { libs: { inputmask: !!window.Inputmask, imask: !!window.IMask, intlTelInput: !!window.intlTelInput, jqueryMask: !!(window.jQuery && window.jQuery.fn && window.jQuery.fn.mask), tildaForm: !!window.tildaForm }, platform: {} };
  if (!(window.tildaForm && typeof window.tildaForm.validate === 'function')) return out;
  for (const s of sels || []) {
    let f = null; try { f = document.querySelector(s); } catch (e) { /* bad selector */ }
    if (!f || f.tagName !== 'FORM') continue;
    try {
      let r = null;
      try { r = window.tildaForm.validate(f); } catch (e) { if (window.jQuery) r = window.tildaForm.validate(window.jQuery(f)); }
      if (Array.isArray(r)) out.platform[s] = { fn: 'tildaForm.validate', errors: r.length, types: [...new Set(r.flatMap(x => (x && x.type ? [].concat(x.type) : [])))].slice(0, 10) };
    } catch (e) { out.platform[s] = { fn: 'tildaForm.validate', error: T(e && e.message, 100) }; }
  }
  return out;
}
async function pageWorld(tab, sels) {
  tab.guard();
  return tab.evaluate(PAGE_WORLD, sels).catch(() => null);
}
// checkValidity() (isolated world) + the platform validator (page world); nothing is submitted
async function validityOf(tab, sels) {
  const val = await rv(tab, 'validity', sels).catch(() => ({}));
  const want = sels.filter(s => val[s]);
  if (want.length) { const pw = await pageWorld(tab, want); if (pw) for (const s of want) val[s].platform = pw.platform[s] || null; }
  return val;
}

// Forms inside iframes (booking widgets, form builders, CRM forms): listed read-only from an isolated world of each
// frame — fields, consent, submit text. Nothing is tapped or typed there.
function FRAME_FORMS() {
  const T = (s, n = 120) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
  const q = (s, r) => { try { return [...(r || document).querySelectorAll(s)]; } catch (e) { return []; } };
  const shown = el => { const r = el.getBoundingClientRect(); return r.width >= 1 && r.height >= 1 && getComputedStyle(el).visibility !== 'hidden'; };
  const labelOf = el => { const l = (el.labels && el.labels[0]) || el.closest('label'); return l ? T(l.innerText, 80) : null; };
  const kindOf = el => {
    const t = (el.getAttribute('type') || el.tagName).toLowerCase();
    const h = [t, el.name, el.id, el.getAttribute('autocomplete'), el.getAttribute('placeholder'), labelOf(el), el.getAttribute('aria-label')].filter(Boolean).join(' ');
    if (t === 'checkbox') return /соглас|персональн|политик|конфиденц|privacy|consent|agree|terms/i.test(h) ? 'consent' : 'checkbox';
    if (t === 'email' || /e-?mail|почт/i.test(h)) return 'email';
    if (t === 'tel' || /phone|телеф/i.test(h)) return 'phone';
    if (/(^|[^a-z])(name|fio)([^a-z]|$)|имя|фио/i.test(h)) return 'name';
    if (t === 'textarea' || /message|comment|сообщ|коммент/i.test(h)) return 'message';
    return 'other';
  };
  const roots = q('form');
  const loose = q('input:not([type=hidden]), textarea').filter(el => !el.closest('form'));
  if (loose.length) roots.push(document.body);
  return { url: location.href, forms: roots.slice(0, 5).map(f => {
    const fields = q('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]), textarea, select', f).filter(el => f.tagName === 'FORM' || !el.closest('form')).slice(0, 20);
    let action = null; if (f.tagName === 'FORM') { try { action = new URL(f.getAttribute('action') || location.href, location.href).href; } catch (e) { action = f.getAttribute('action'); } }
    const consentBox = fields.find(el => kindOf(el) === 'consent');
    return {
      formless: f.tagName !== 'FORM', action, method: f.tagName === 'FORM' ? (f.getAttribute('method') || 'get').toLowerCase() : null,
      fields: fields.map(el => ({ kind: kindOf(el), type: (el.getAttribute('type') || el.tagName).toLowerCase(), name: el.getAttribute('name'), required: el.required || el.getAttribute('aria-required') === 'true', label: labelOf(el), placeholder: T(el.getAttribute('placeholder'), 60) || null, autocomplete: el.getAttribute('autocomplete'), shown: shown(el) })),
      consent: { checkbox: !!consentBox, prechecked: consentBox ? consentBox.checked : null, text: consentBox ? labelOf(consentBox) : (q('p, span, div, small, label', f).map(e => T(e.innerText, 300)).find(t => t.length < 300 && /(нажимая|отправляя|by (clicking|submitting))/i.test(t) && /(соглас|agree|consent)/i.test(t)) || null),
        policy_links: q('a[href]', f).filter(a => /политик|конфиденц|персональн|privacy|policy|terms|оферт/i.test(T(a.innerText) + ' ' + a.getAttribute('href'))).slice(0, 3).map(a => a.href) },
      submit: T((q('button, input[type=submit]', f).find(shown) || {}).innerText || '', 60) || null,
    };
  }) };
}
async function iframeForms(tab, dumpIframes) {
  const out = [];
  let tree = null;
  try { tree = (await tab.send('Page.getFrameTree', {}, 10000)).frameTree; } catch { /* no tree */ }
  const frames = [];
  const walk = (n, d) => { if (!n || d > 3) return; for (const c of n.childFrames || []) { frames.push(c.frame); walk(c, d + 1); } };
  walk(tree, 0);
  const seen = new Set();
  for (const fr of frames.slice(0, 12)) {
    if (!/^https?:/i.test(fr.url || '') || out.length >= 8) continue;
    const meta = dumpIframes.find(f => f.src && (fr.url.startsWith(f.src) || f.src.startsWith(fr.url.split('#')[0]))) || null;
    const rec = { src: fr.url.slice(0, 300), host: U.hostOf(fr.url), service: serviceOf(fr.url) || classify(fr.url).name, shown: meta ? meta.shown : null, box: meta ? meta.box : null, region: meta ? meta.region : null, forms: null };
    try {
      const { executionContextId } = await tab.send('Page.createIsolatedWorld', { frameId: fr.id, worldName: 'revizor-frame', grantUniveralAccess: false }, 10000);
      const r = await tab.send('Runtime.evaluate', { expression: `(${FRAME_FORMS.toString()})()`, returnByValue: true, contextId: executionContextId }, 10000);
      if (r.exceptionDetails) rec.read_error = String(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'error').slice(0, 120);
      else rec.forms = r.result?.value?.forms || [];
    } catch (e) { rec.read_error = String(e.message || e).slice(0, 120); }
    if (!(rec.forms && rec.forms.length) && !IFRAME_FORM.test(fr.url)) continue; // a video or a map: not a form
    const k = rec.src.split('#')[0]; if (seen.has(k)) continue; seen.add(k);
    out.push(rec);
  }
  // form iframes that never loaded (cut as a widget, lazy src): listed by their src
  for (const f of dumpIframes) {
    if (!IFRAME_FORM.test(f.src) || out.some(o => o.src.split('#')[0].startsWith(f.src.split('#')[0]) || f.src.startsWith(o.src.split('#')[0]))) continue;
    if (out.length >= 10) break;
    out.push({ src: f.src, host: U.hostOf(f.src), service: serviceOf(f.src) || classify(f.src).name, shown: f.shown, box: f.box, region: f.region, forms: null, read_error: 'not loaded' });
  }
  return out;
}
const relRun = (run, p) => relative(run, p).split(sep).join('/');
const shortUrl = u => { try { const x = new URL(u); return (x.pathname + x.search).slice(0, 120) || '/'; } catch { return String(u).slice(0, 120); } };

const SERVICES = [
  [/forms\.tildacdn\.com|tildaapi|tilda\./i, 'Тильда (приём форм)'], [/docs\.google\.com\/forms|forms\.gle/i, 'Google Forms'], [/formspree\.io/i, 'Formspree'], [/typeform\.com/i, 'Typeform'],
  [/hsforms|hubspot/i, 'HubSpot'], [/jotform/i, 'Jotform'], [/forms\.yandex|yandex\.ru\/forms/i, 'Яндекс Формы'], [/api\.telegram\.org/i, 'Telegram Bot API'], [/bitrix24/i, 'Битрикс24'],
  [/amocrm|kommo/i, 'amoCRM/Kommo'], [/getcourse/i, 'GetCourse'], [/list-manage\.com|mailchimp/i, 'Mailchimp'], [/sendpulse/i, 'SendPulse'], [/unisender/i, 'UniSender'],
  [/formcarry/i, 'Formcarry'], [/netlify/i, 'Netlify Forms'], [/wufoo/i, 'Wufoo'], [/cognitoforms/i, 'Cognito Forms'], [/hooks\.zapier|zapier\.com/i, 'Zapier'], [/hook\.\w+\.make\.com|integromat/i, 'Make'],
  [/script\.google\.com/i, 'Google Apps Script'], [/pipedream/i, 'Pipedream'], [/webhook\.site/i, 'webhook.site'], [/marquiz/i, 'Marquiz'], [/yclients/i, 'YCLIENTS'], [/dikidi/i, 'DIKIDI'],
  [/wix/i, 'Wix'], [/squarespace/i, 'Squarespace'], [/ucalc/i, 'uCalc'], [/flexbe/i, 'Flexbe'], [/lpgenerator/i, 'LPgenerator'], [/calendly/i, 'Calendly'], [/tally\.so/i, 'Tally'],
];
const IFRAME_FORM = /docs\.google\.com\/forms|forms\.gle|forms\.yandex|typeform|jotform|tally\.so|ucalc|marquiz|bitrix24|b24-|hsforms|hubspot|calendly|yclients|dikidi|cognitoforms|wufoo|getcourse|tildacdn\.com\/.*form|formdesigner|airtable|forms\.office|formstack/i;
// util helpers shared with privacy/perf; fallbacks keep this script working without them
const classify = url => (typeof U.classifyThirdParty === 'function' ? U.classifyThirdParty(url) : { host: U.hostOf(url), name: U.hostOf(url) || String(url).slice(0, 60), category: 'other', operator: null, known: false });
const thirdParty = (url, site) => (typeof U.isThirdParty === 'function' ? U.isThirdParty(url, site) : U.stripWww(U.hostOf(url)) !== U.stripWww(U.hostOf(site)));
const serviceOf = url => { const s = SERVICES.find(([re]) => re.test(url || '')); return s ? s[1] : null; };

async function scriptBodies(tab, scripts, siteHost) {
  const out = []; let total = 0;
  const site = U.stripWww(siteHost || '');
  for (const s of scripts) {
    if (out.length >= 12 || total > 6e6) break;
    let host = ''; try { host = U.stripWww(new URL(s.url).hostname); } catch { continue; }
    if (!site || !(host === site || host.endsWith('.' + site))) continue;
    try {
      const r = await tab.send('Network.getResponseBody', { requestId: s.id }, 10000);
      const body = (r.base64Encoded ? Buffer.from(r.body, 'base64').toString('utf8') : r.body || '').slice(0, 1500000);
      total += body.length; out.push({ path: shortUrl(s.url), body });
    } catch { /* body evicted or not kept */ }
  }
  return out;
}

function analyzeAnalytics(dump, bodies, blocked, lang) {
  const counters = new Map();
  // id null = the counter is there (code or a blocked load) but its number is not readable: a variable, a builder setting
  const add = (system, id, source) => { const k = system + '|' + (id ?? '?'); const c = counters.get(k) || { system, id: id ?? null, init_count: 0, sources: new Set() }; c.sources.add(source); counters.set(k, c); return c; };
  const goals = []; let ecommerce = false;
  const texts = [...dump.inline.map(t => ['inline', t]), ...dump.attrs.map(a => [`attr ${a.attr}${a.text ? ` «${a.text}»` : ''}`, a.value]), ...bodies.map(b => [`script ${b.path}`, b.body])];
  const ymInit = (c, opts) => {
    c.init_count++;
    if (/webvisor\s*:\s*(?:true|!0|1)/.test(opts)) c.webvisor = true; else if (c.webvisor === undefined) c.webvisor = false;
    const ec = /ecommerce\s*:\s*['"]?([\w$.]+)/.exec(opts); if (ec) { c.ecommerce = ec[1]; ecommerce = true; }
  };
  // ym(window.counterId, 'init', …): the number sits in a variable — look it up in the same code
  const resolveVar = name => {
    const last = (/([A-Za-z_$][\w$]*)['"]?\]?$/.exec(name) || [])[1];
    if (!last) return null;
    const re = new RegExp(`(?<![\\w$])${last.replace(/\$/g, '\\$')}['"]?\\s*[:=]\\s*['"]?(\\d{4,10})(?!\\d)`);
    for (const [, code] of texts) { const m = re.exec(code); if (m) return m[1]; }
    return null;
  };
  for (const [where, code] of texts) {
    for (const m of code.matchAll(/(?<![\w$.])ym\s*\(\s*['"]?(\d{4,10})['"]?\s*,\s*['"]init['"]\s*,\s*(\{[\s\S]{0,800}?\})/g)) ymInit(add('yandex_metrika', m[1], where), m[2]);
    for (const m of code.matchAll(/(?<![\w$.])ym\s*\(\s*((?:window\.)?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[['"][\w$]+['"]\])*)\s*,\s*['"]init['"]\s*,\s*(\{[\s\S]{0,800}?\})/g)) {
      const id = resolveVar(m[1]);
      const c = add('yandex_metrika', id, `${where} (${m[1].slice(0, 40)})`); ymInit(c, m[2]);
      if (!id) c.id_expr = m[1].slice(0, 60);
    }
    for (const m of code.matchAll(/new\s+Ya\.Metrika2?\s*\(\s*\{\s*id\s*:\s*['"]?(\d{4,10})/g)) add('yandex_metrika', m[1], where).init_count++;
    for (const m of code.matchAll(/(?<![\w-])(GTM-[A-Z0-9]{4,10})(?![A-Z0-9])/g)) add('gtm', m[1], where).init_count++;
    for (const m of code.matchAll(/gtag\s*\(\s*['"]config['"]\s*,\s*['"]((?:G|UA|AW|DC)-[A-Z0-9-]{4,20})['"]/g)) add(m[1].startsWith('AW') ? 'google_ads' : 'google_analytics', m[1], where).init_count++;
    for (const m of code.matchAll(/fbq\s*\(\s*['"]init['"]\s*,\s*['"](\d{6,20})['"]/g)) add('meta_pixel', m[1], where).init_count++;
    for (const m of code.matchAll(/VK\.Retargeting\.Init\s*\(\s*['"]([\w-]{4,40})['"]/g)) add('vk_pixel', m[1], where).init_count++;
    for (const m of code.matchAll(/_tmr\.push\s*\(\s*\{\s*id\s*:\s*['"](\d{4,10})['"]/g)) add('top_mail_ru', m[1], where).init_count++;
    for (const m of code.matchAll(/hjid\s*:\s*(\d{4,10})/g)) add('hotjar', m[1], where).init_count++;
    for (const m of code.matchAll(/clarity['"]?\s*,\s*['"]script['"]\s*,\s*['"](\w{6,20})['"]/g)) add('clarity', m[1], where).init_count++;
    for (const m of code.matchAll(/ttq\.load\s*\(\s*['"](\w{6,30})['"]/g)) add('tiktok_pixel', m[1], where).init_count++;
    for (const m of code.matchAll(/(?<![\w$.])ym\s*\(\s*['"]?(\d{4,10})?['"]?\s*,?\s*['"]reachGoal['"]\s*,\s*['"]([^'"]{1,80})['"]/g)) goals.push({ system: 'yandex_metrika', id: m[1] || null, name: m[2], where });
    for (const m of code.matchAll(/yaCounter(\d{4,10})\.reachGoal\s*\(\s*['"]([^'"]{1,80})['"]/g)) goals.push({ system: 'yandex_metrika', id: m[1], name: m[2], where });
    for (const m of code.matchAll(/gtag\s*\(\s*['"]event['"]\s*,\s*['"]([^'"]{1,80})['"]/g)) goals.push({ system: 'gtag', id: null, name: m[1], where });
    for (const m of code.matchAll(/dataLayer\.push\s*\(\s*\{[^}]{0,300}?['"]?event['"]?\s*:\s*['"]([^'"]{1,80})['"]/g)) if (!/^gtm\./.test(m[1])) goals.push({ system: 'dataLayer', id: null, name: m[1], where });
    for (const m of code.matchAll(/fbq\s*\(\s*['"](?:track|trackCustom)['"]\s*,\s*['"]([^'"]{1,80})['"]/g)) goals.push({ system: 'meta_pixel', id: null, name: m[1], where });
    if (/['"]?ecommerce['"]?\s*:\s*\{|['"](?:purchase|add_to_cart|view_item|begin_checkout)['"]/.test(code)) ecommerce = true;
  }
  for (const n of dump.noscripts) {
    for (const m of n.matchAll(/mc\.yandex\.(?:ru|com)\/watch\/(\d{4,10})/g)) add('yandex_metrika', m[1], 'noscript');
    for (const m of n.matchAll(/googletagmanager\.com\/ns\.html\?id=(GTM-[A-Z0-9]{4,10})/g)) add('gtm', m[1], 'noscript');
  }
  const srcCount = {};
  for (const s of dump.srcs) {
    let m;
    if ((m = /googletagmanager\.com\/gtm\.js\?id=(GTM-[A-Z0-9]{4,10})/.exec(s))) { add('gtm', m[1], 'script-src'); srcCount['gtm:' + m[1]] = (srcCount['gtm:' + m[1]] || 0) + 1; }
    if ((m = /googletagmanager\.com\/gtag\/js\?id=((?:G|UA|AW|DC)-[A-Z0-9-]{4,20})/.exec(s))) { add(m[1].startsWith('AW') ? 'google_ads' : 'google_analytics', m[1], 'script-src'); srcCount['gtag:' + m[1]] = (srcCount['gtag:' + m[1]] || 0) + 1; }
    if (/mc\.yandex\.(?:ru|com)\/metrika\/(?:tag|watch)\.js/.test(s)) srcCount.metrika_tag = (srcCount.metrika_tag || 0) + 1;
  }
  // blocked attempts (lib/cdp cut them: counters and widgets never ran)
  const svc = new Map();
  for (const kind of ['analytics', 'widget']) for (const b of blocked[kind] || []) {
    const c = classify(b.url);
    const name = b.service || c.name;
    const e = svc.get(name) || { name, category: c.category, kind, n: 0, phase: new Set() };
    e.n++; e.phase.add(b.phase); svc.set(name, e);
    let m;
    if ((m = /mc\.yandex\.(?:ru|com)\/watch\/(\d{4,10})/.exec(b.url))) add('yandex_metrika', m[1], 'attempt');
    if ((m = /gtm\.js\?id=(GTM-[A-Z0-9]{4,10})/.exec(b.url))) add('gtm', m[1], 'attempt');
    if ((m = /gtag\/js\?id=((?:G|UA|AW)-[A-Z0-9-]{4,20})/.exec(b.url))) add(m[1].startsWith('AW') ? 'google_ads' : 'google_analytics', m[1], 'attempt');
    if ((m = /top-fwz1\.mail\.ru\/(?:counter|js\/code\.js)\?id=(\d{4,10})/.exec(b.url))) add('top_mail_ru', m[1], 'attempt');
    if ((m = /clarity\.ms\/tag\/(\w{6,20})/.exec(b.url))) add('clarity', m[1], 'attempt');
    if ((m = /hotjar-(\d{4,10})\.js/.exec(b.url))) add('hotjar', m[1], 'attempt');
    if (/mc\.yandex\.(?:ru|com)\/metrika\/tag\.js/.test(b.url)) srcCount.metrika_tag_attempts = (srcCount.metrika_tag_attempts || 0) + 1;
  }
  // a counter whose load was blocked but whose number is not in the code: it exists, number unknown
  const SYS_BY_NAME = { 'Яндекс Метрика': 'yandex_metrika', 'Google Analytics': 'google_analytics', 'Google Tag Manager': 'gtm', 'Top Mail.ru': 'top_mail_ru', Hotjar: 'hotjar', 'Microsoft Clarity': 'clarity', 'Meta Pixel': 'meta_pixel', 'Пиксель VK': 'vk_pixel', 'TikTok Pixel': 'tiktok_pixel', 'Google Ads': 'google_ads' };
  for (const s of svc.values()) {
    if (s.kind !== 'analytics') continue;
    const sys = SYS_BY_NAME[s.name] || `other:${s.name}`;
    if (![...counters.values()].some(c => c.system === sys)) add(sys, null, 'attempt');
  }
  // a counter with an unknown number next to known ones of the same system is most likely one of them
  // (init counts are not added up: whether it is a double init or a second counter is unknown)
  for (const [k, c] of counters) if (c.id === null && [...counters.values()].some(o => o !== c && o.system === c.system && o.id)) {
    const known = [...counters.values()].find(o => o !== c && o.system === c.system && o.id);
    for (const s of c.sources) known.sources.add(s); if (c.webvisor) known.webvisor = true;
    counters.delete(k);
  }
  const list = [...counters.values()].map(c => ({ system: c.system, id: c.id, id_expr: c.id_expr, init_count: c.init_count, sources: [...c.sources], webvisor: c.webvisor, ecommerce: c.ecommerce }));
  const dup = [];
  for (const c of list) if (c.init_count > 1) dup.push({ system: c.system, id: c.id, why: lang === 'en' ? `initialised ${c.init_count} times` : `инициализация ${c.init_count} раза` });
  for (const [k, n] of Object.entries(srcCount)) if (n > 1 && !k.endsWith('_attempts')) dup.push({ system: k.split(':')[0], id: k.split(':')[1] || null, why: lang === 'en' ? `script included ${n} times` : `скрипт подключён ${n} раза` });
  const ym = list.filter(c => c.system === 'yandex_metrika');
  if (ym.length > 1) dup.push({ system: 'yandex_metrika', id: ym.map(c => c.id).join(', '), why: lang === 'en' ? 'several Metrika counters (check whether intended)' : 'несколько счётчиков Метрики (проверить, задумано ли)' });
  const ga = list.filter(c => c.system === 'google_analytics'); const gtm = list.filter(c => c.system === 'gtm');
  if (ga.length && gtm.length) dup.push({ system: 'google_analytics', id: ga.map(c => c.id).join(', '), possible: true, why: lang === 'en' ? 'gtag and GTM both present: GA may be sent twice if GTM also has it' : 'есть и gtag, и GTM: если в контейнере тот же GA — двойной счёт (контейнер не проверяли)' });
  const recording = { metrika_webvisor: ym.some(c => c.webvisor === true) ? true : ym.length ? false : null,
    hotjar: list.some(c => c.system === 'hotjar') || [...svc.values()].some(s => /hotjar/i.test(s.name)), clarity: list.some(c => c.system === 'clarity') || [...svc.values()].some(s => /clarity/i.test(s.name)) };
  const uniqGoals = []; const seenG = new Set();
  for (const g of goals) { const k = g.system + '|' + g.name; if (seenG.has(k)) continue; seenG.add(k); uniqGoals.push(g); }
  return { counters: list, duplicates: dup, goals_in_code: uniqGoals.slice(0, 60), ecommerce, recording, verification: dump.verification, mask_libs: dump.libs, captcha_scripts: dump.captcha_scripts,
    attempts: [...svc.values()].map(s => ({ name: s.name, category: s.category, kind: s.kind, n: s.n, phase: [...s.phase] })).sort((a, b) => b.n - a.n), script_tags: srcCount };
}

function summarizeBlocked(bl) {
  const out = {};
  // requests cut after our taps may carry form data in parameters: keep parameter names only
  for (const [k, arr] of Object.entries(bl || {})) if (Array.isArray(arr) && arr.length) out[k] = { n: arr.length, sample: arr.slice(0, 8).map(x => ({ url: ['interact', 'write', 'risky', 'private', 'blocked'].includes(k) ? bareUrl(x.url) : String(x.url).slice(0, 160), phase: x.phase, method: x.method, service: x.service || undefined })) };
  // the guard cuts non-GET requests after a tap as «interact» before the method check: count them apart
  if (out.interact) { const ng = bl.interact.filter(x => x.method && !['GET', 'HEAD', 'OPTIONS'].includes(x.method)).length; if (ng) out.interact.non_get = ng; }
  return out;
}

// merge a form record into the page list by signature (a record seen while shown wins: labels are judged on screen)
function mergeForm(list, rec, extra = {}) {
  const i = list.findIndex(f => f.sig === rec.sig);
  if (i < 0) { list.push({ ...rec, ...extra }); return list[list.length - 1]; }
  const old = list[i];
  if (rec.shown && !old.shown) list[i] = { ...rec, opened_by: old.opened_by, validity: old.validity, ...extra };
  else Object.assign(old, extra);
  return list[i];
}

async function setSize(tab, w, h, mobile) {
  await tab.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: mobile ? 2 : 1, mobile, screenWidth: w, screenHeight: h });
}
async function shot(tab, run, name) {
  const p = U.insideRun(run, 'measure', 'forms', name);
  U.ensureDir(join(run, 'measure', 'forms'));
  await tab.screenshot({ path: p, format: 'jpeg', quality: 60 });
  return relRun(run, p);
}
async function reload(tab, url) {
  const nav = await tab.goto(url, { timeout: 45000 });
  await U.sleep(1000);
  if (nav.ok) await rv(tab, 'autoLayers').catch(() => []);
  return nav.ok;
}

// what the safety net cut after our tap: requests by GET with parameters / fetch / beacon (interact), non-GET (write),
// chats and callbacks (widget), risky GETs, private addresses. Analytics hits after a tap (goals) are not counted.
const GUARD_KINDS = ['interact', 'write', 'widget', 'risky', 'private', 'blocked'];
const blockedCounts = tab => Object.fromEntries([...GUARD_KINDS, 'navigation'].map(k => [k, (tab.blocked[k] || []).length]));
// a cut request without parameter values: they may carry the page's data
const bareUrl = u => { try { const x = new URL(u); const keys = [...new Set(x.searchParams.keys())]; return (x.host + x.pathname).slice(0, 120) + (keys.length ? '?' + keys.slice(0, 6).join('&') : ''); } catch { return String(u).split('?')[0].slice(0, 120); } };
const STATIC_RE = /\.(?:png|jpe?g|gif|webp|avif|svg|ico|bmp|css|js|mjs|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|json|map)$/i;
function cutSince(tab, c0) {
  const out = [];
  for (const k of GUARD_KINDS) for (const x of (tab.blocked[k] || []).slice(c0[k] || 0)) out.push({ kind: k, method: x.method, type: x.type, url: bareUrl(x.url), service: x.service || undefined });
  return out;
}

async function tapOne(tab, inst, pg, w, h, ctx, tag) {
  const mobile = w < 768;
  const r = { sel: inst.sel, region: inst.region };
  const prep = await rv(tab, 'prepTap', inst.sel);
  if (!prep.ok) { r.error = prep.why; return r; }
  await U.sleep(450);
  let pt = await rv(tab, 'tapPoint', inst.sel);
  if (!pt.ok) { r.error = pt.why; return r; }
  if (!pt.hit_ok) { await U.sleep(600); pt = await rv(tab, 'tapPoint', inst.sel); if (!pt.ok) { r.error = pt.why; return r; } } // an animation may still be running
  r.hit_ok = pt.hit_ok;
  // covered: the tap would land on whatever covers the button (a sticky «send», another form's button) — never tap
  if (!pt.hit_ok) { r.covered_by = pt.covered_by; r.covered_text = pt.covered_text; r.effect = 'not-tapped'; return r; }
  const c0 = blockedCounts(tab);
  const t0 = Date.now();
  const t = mobile ? await tab.tap(pt.x, pt.y) : await tab.click(pt.x, pt.y);
  r.input = mobile ? 'tap' : 'click';
  // lib/cdp refused (submit, a button of a contact form or next to contact fields, consent «accept», iframe): not a dead button
  if (t.refused) { r.refused = t.refused; r.effect = 'blocked_by_guard'; return r; }
  await U.sleep(1000);
  const navs = (tab.blocked.navigation || []).slice(c0.navigation);
  const cut = cutSince(tab, c0);
  const after = await rv(tab, 'afterTap', pt.scroll);
  // requests that went through after the tap, except static files (images, styles, fonts, scripts by extension)
  const passed = (ctx.reqLog || []).filter(x => x.t >= t0 && x.type !== 'Document' && !/^(data|blob):/i.test(x.url) && !STATIC_RE.test(x.url.split(/[?#]/)[0]))
    .map(x => ({ type: x.type, url: bareUrl(x.url) }));
  const fieldsShown = after.fields_shown || [];
  r.effect = after.layer ? 'popup' : (after.forms_shown.length || fieldsShown.length) ? 'form-shown' : navs.length ? 'navigation' : after.scrolled ? 'scroll'
    : passed.length ? 'request' : cut.length ? 'blocked_by_guard' : 'none';
  if (passed.length) r.requests = passed.slice(0, 5);
  if (fieldsShown.length) r.fields_shown = fieldsShown;
  if (navs.length) r.navigation = navs.slice(0, 2).map(n => bareUrl(n.url));
  if (cut.length) r.guard_cut = cut.slice(0, 5);
  // non-GET requests are cut by the guard as «interact» too: count them by method
  const writes = cut.filter(x => x.kind === 'write' || (x.kind === 'interact' && x.method && !['GET', 'HEAD', 'OPTIONS'].includes(x.method)));
  if (writes.length) r.write_blocked = writes.slice(0, 3).map(x => ({ method: x.method, url: x.url }));
  if (after.forms_shown.length) r.forms_shown = after.forms_shown;
  if (!after.layer) return r;
  r.layer = after.layer;
  r.submit_view = {};
  if (after.submit) r.submit_view[`${w}x${h}`] = after.submit.in_view;
  r.submit_text = after.submit?.text || null;
  if (ctx.shots) r.shot = await shot(tab, ctx.run, `${pg.pid}-${w}-${tag}.jpg`).catch(() => null);
  try {
    if (mobile) {
      await setSize(tab, 360, 640, true); await U.sleep(400);
      const s2 = await rv(tab, 'submitInView'); if (s2) r.submit_view['360x640'] = s2.in_view;
      await setSize(tab, w, h, true); await U.sleep(300);
    } else if (w >= 1280) {
      await setSize(tab, 1366, 657, false); await U.sleep(400);
      const s2 = await rv(tab, 'submitInView'); if (s2) r.submit_view['1366x657'] = s2.in_view;
      await setSize(tab, w, h, false); await U.sleep(300);
    }
  } catch { /* keep what we have */ }
  // forms inside the popup, judged while shown
  try {
    const inv = await rv(tab, 'inventory', after.layer.sel);
    r.forms = inv.forms.map(f => f.sig);
    for (const f of inv.forms) mergeForm(ctx.pageForms, f, { opened_by: inst.sel });
    const val = await validityOf(tab, inv.forms.filter(f => !f.formless).map(f => f.sel));
    for (const f of inv.forms) { const v = val[f.sel]; if (v) { const m = ctx.pageForms.find(x => x.sig === f.sig); if (m) m.validity = v; } }
  } catch { /* popup changed under us */ }
  // closing: Esc → close button → backdrop
  r.close = { esc: null, button: null, backdrop: null };
  await tab.key('Escape', 'Escape', 27); await U.sleep(500);
  r.close.esc = await rv(tab, 'layerClosed');
  if (!r.close.esc) {
    let cb = await rv(tab, 'closeButton');
    if (cb && cb.needed_scroll) { await U.sleep(450); cb = { ...(await rv(tab, 'closeButton')), needed_scroll: true }; } // smooth scrolling: measure again
    if (cb && cb.on_screen) {
      r.close.button_sel = cb.sel; r.close.button_size = cb.size;
      if (cb.needed_scroll) r.close.button_needed_scroll = true;
      const t2 = mobile ? await tab.tap(cb.x, cb.y) : await tab.click(cb.x, cb.y);
      // the close button sits next to the form fields: lib/cdp refuses it (it can't tell «×» from «send») — not a defect
      if (!t2.refused) { await U.sleep(600); r.close.button = await rv(tab, 'layerClosed'); } else { r.close.button = 'refused'; r.close.button_refused = t2.refused; }
    } else r.close.button = cb ? 'off-screen' : 'not-found';
  }
  if (!(r.close.esc || r.close.button === true)) {
    const bp = await rv(tab, 'backdropPoint');
    if (bp) { const t3 = mobile ? await tab.tap(bp.x, bp.y) : await tab.click(bp.x, bp.y); if (!t3.refused) { await U.sleep(600); r.close.backdrop = await rv(tab, 'layerClosed'); } else r.close.backdrop = 'refused'; }
    else r.close.backdrop = 'no-free-area';
  }
  if (!(r.close.esc || r.close.button === true || r.close.backdrop === true)) r.needs_reload = true;
  return r;
}

async function tapToggles(tab, pg, w, h, ctx, res) {
  const out = [];
  const groups = await rv(tab, 'toggles');
  const tested = ctx.tested.get(w);
  let taps = 0, reloads = 0, stop = false;
  for (const g of groups) {
    const rec = { key: g.key, text: g.text, kind: g.kind, target: g.target, instances: g.instances.length, shown_instances: g.instances.filter(i => i.shown).length, tapped: [] };
    if (g.kind === 'anchor-form') { rec.note = ctx.lang === 'en' ? 'scrolls to a form on this page' : 'прокручивает к форме на этой странице'; out.push(rec); continue; }
    if (tested.has(g.key)) { rec.same_as = tested.get(g.key); out.push(rec); continue; }
    if (stop) { rec.skipped = 'budget'; out.push(rec); continue; }
    // one shown instance per region, up to 3; instances that may send a form are never tapped (see unsafeReason)
    const pick = []; const regions = new Set();
    for (const i of g.instances) if (i.shown && !i.unsafe && !regions.has(i.region) && pick.length < 3) { regions.add(i.region); pick.push(i); }
    const unsafe = g.instances.filter(i => i.shown && i.unsafe);
    if (unsafe.length) rec.unsafe = unsafe.slice(0, 3).map(i => ({ sel: i.sel, region: i.region, why: i.unsafe }));
    if (!pick.length) { rec.skipped = unsafe.length ? 'unsafe' : 'not-shown'; out.push(rec); continue; }
    for (const inst of pick) {
      if (taps >= ctx.maxTaps || Date.now() > ctx.deadline - 25000) { rec.skipped = taps >= ctx.maxTaps ? 'max-taps' : 'budget'; stop = true; break; }
      taps++;
      U.progress(`forms: ${pg.pid}@${w} → «${g.text.slice(0, 40)}» (${inst.region})`);
      let r;
      try { r = await tapOne(tab, inst, pg, w, h, ctx, `t${String(out.length + 1).padStart(2, '0')}-${rec.tapped.length + 1}`); }
      catch (e) { r = { sel: inst.sel, region: inst.region, error: String(e.message || e).slice(0, 200), needs_reload: true }; }
      rec.tapped.push(r);
      if (r.needs_reload || r.effect === 'navigation') {
        if (reloads >= 3) { stop = true; rec.skipped = 'reloads'; break; }
        reloads++;
        if (!(await reload(tab, pg.url))) { stop = true; break; }
      }
    }
    tested.set(g.key, `${pg.pid}@${w}`);
    out.push(rec);
  }
  res.taps = taps; res.reloads = reloads;
  return out;
}

async function checkPage(b, pg, w, ctx) {
  const mobile = w < 768, h = mobile ? 844 : 900;
  const res = { pid: pg.pid, url: pg.url, width: w, viewport: [w, h] };
  const tab = await b.newPage({ blockNavigation: true, allowLoadPosts: ctx.allowLoadPosts });
  const scripts = [];
  tab.on('Network.responseReceived', p => { if (p.type === 'Script' && scripts.length < 300) scripts.push({ id: p.requestId, url: p.response.url }); });
  // requests that got a response (passed the safety net): a tap that fired one did something, even with nothing on screen
  ctx.reqLog = [];
  tab.on('Network.responseReceived', p => { if (ctx.reqLog.length < 3000) ctx.reqLog.push({ t: Date.now(), type: p.type, url: p.response.url }); });
  try {
    await tab.setViewport({ width: w, height: h, mobile, deviceScaleFactor: mobile ? 2 : 1, touch: mobile });
    await tab.emulateMedia({ colorScheme: 'light' });
    await U.sleep(400 + Math.floor(Math.random() * 400));
    const nav = await tab.goto(pg.url, { timeout: 45000 });
    res.status = nav.status ?? null; res.final_url = nav.finalUrl || null; res.load_ms = nav.ms;
    if (!nav.ok) { res.error = nav.refused ? `refused_${nav.refused}` : (nav.error || 'load failed'); return res; }
    await U.sleep(1200);
    const html0 = await tab.evaluateIsolated('document.documentElement ? document.documentElement.outerHTML.slice(0, 30000) : ""').catch(() => '');
    const ab = U.detectAntibot(nav.status || 0, {}, html0);
    if (ab && (nav.status >= 400 || /just a moment|checking your browser|cf-chl|ddos-guard/i.test(html0))) { res.antibot = ab; res.error = 'antibot'; return res; }
    if (nav.status >= 400) { res.error = `http ${nav.status}`; return res; }
    res.auto_layers = await rv(tab, 'autoLayers');
    ctx.pageForms = [];
    const inv = await rv(tab, 'inventory', null);
    for (const f of inv.forms) mergeForm(ctx.pageForms, f);
    res.contacts = await rv(tab, 'contacts');
    res.calculators = await rv(tab, 'calculators');
    const dump = await rv(tab, 'codeDump');
    dump.libs = (await pageWorld(tab, []))?.libs || {};
    const bodies = await scriptBodies(tab, scripts, ctx.siteHost);
    res.iframe_forms = await iframeForms(tab, dump.iframes).catch(() => dump.iframes.filter(f => IFRAME_FORM.test(f.src)).map(f => ({ ...f, host: U.hostOf(f.src), service: serviceOf(f.src) || classify(f.src).name, forms: null })));
    // toggles (real taps), then checkValidity on what is in the DOM now
    res.toggles = await tapToggles(tab, pg, w, h, ctx, res);
    const pending = ctx.pageForms.filter(f => !f.validity && !f.formless).map(f => f.sel);
    if (pending.length) {
      const val = await validityOf(tab, pending);
      for (const f of ctx.pageForms) if (!f.validity && val[f.sel]) f.validity = val[f.sel];
    }
    res.forms = ctx.pageForms;
    res.analytics = analyzeAnalytics(dump, bodies, tab.blocked, ctx.lang);
    res.analytics.script_bodies_read = bodies.map(x => x.path);
    res.blocked = summarizeBlocked(tab.blocked);
    res.widgets_blocked = [...new Set((tab.blocked.widget || []).map(x => x.service || U.hostOf(x.url)).filter(Boolean))].slice(0, 6);
    return res;
  } finally { await tab.close(); }
}

// ---------------------------------------------------------------------------------------------
// issues
const CHECKS = {
  // owners: consents — legal, where the data goes (third party, GET with personal data) — privacy; the forms lens
  // describes them and hands over through for_other_lenses when those lenses are in the run
  'get-with-pii': ['Форма с личными данными отправляется методом GET: данные попадут в адрес страницы', 'Form with personal data uses GET: data ends up in the URL', 'privacy', 'P0'],
  'action-insecure': ['Форма отправляется по http без шифрования', 'Form is sent over plain http', 'security', 'P0'],
  'endpoint-third-party': ['Данные формы уходят стороннему сервису', 'Form data goes to a third-party service', 'privacy', 'info'],
  'label-placeholder-only': ['Поле без видимой подписи: только подсказка внутри поля', 'Field label is only a placeholder', 'forms', 'P2'],
  'label-missing': ['Поле без подписи и без имени для скринридера', 'Field without a label or accessible name', 'a11y', 'P1'],
  'autocomplete-missing': ['Поля имени, телефона, почты без подходящего autocomplete', 'Name/phone/email fields without a matching autocomplete', 'forms', 'P2'],
  'input-type': ['Телефон или почта в поле type=text: на телефоне открывается не та клавиатура', 'Phone or email in a text field: wrong phone keyboard', 'forms', 'P2'],
  'required-not-programmatic': ['Обязательность видна (звёздочка или правило платформы), но не задана атрибутом required или aria-required', 'Required is shown (asterisk or platform rule) but not set with required/aria-required', 'a11y', 'P2'],
  'required-hidden': ['Обязательное поле скрыто от посетителя', 'A required field is hidden', 'forms', 'P2'],
  'no-required': ['В форме с контактами ни одно поле с данными не обязательно: браузер пропустит пустую заявку', 'No contact field is required: the browser lets an empty request through', 'forms', 'P2'],
  'consent-prechecked': ['Галочка согласия стоит заранее', 'Consent checkbox is pre-checked', 'legal', 'P1'],
  'consent-missing': ['Форма с личными данными без согласия и без ссылки на политику', 'Form with personal data has no consent and no policy link', 'legal', 'P0'],
  'consent-none': ['У формы с личными данными есть ссылка на политику, но нет согласия: ни галочки, ни текста согласия', 'Form with personal data links the policy but has no consent (no checkbox, no consent text)', 'legal', 'P0'],
  'consent-no-policy-link': ['Согласие без ссылки на политику обработки данных', 'Consent without a link to the privacy policy', 'legal', 'P2'],
  'consent-bundled': ['В обязательное согласие включены реклама, рассылка или cookie', 'Ads, newsletter or cookies are bundled into a required consent', 'legal', 'P1'],
  'consent-test-text': ['В согласии тестовый или пустой текст', 'Consent text is a test stub or empty', 'legal', 'P1'],
  'file-no-accept': ['Поле загрузки файла без ограничения типов (accept)', 'File field without accept', 'forms', 'P3'],
  'toggle-no-effect': ['Кнопка формы ничего не открывает после касания', 'A form button does nothing when tapped', 'forms', 'P1'],
  'toggle-maybe-widget': ['Кнопка ничего не открыла; на странице заблокирован виджет — что открывает кнопка, проверить руками', 'The button opened nothing; a widget is blocked on the page — check by hand what the button opens', 'forms', 'info'],
  'toggle-request': ['После касания кнопки сайт отправил запрос, на экране ничего не изменилось: что делает кнопка, проверить руками', 'The tap made the site send a request and nothing changed on screen: check by hand what the button does', 'forms', 'info'],
  'toggle-blocked-by-guard': ['Касание кнопки оборвала страховка проверки (запрос, виджет или отказ нажимать): что делает кнопка — проверить руками', 'The tap was cut by the review safety net (a request, a widget or a refusal): check by hand what the button does', 'forms', 'info'],
  'toggle-covered': ['Кнопку формы перекрывает другой элемент: касание попадает не в неё', 'Another element covers the form button: the tap lands elsewhere', 'mobile', 'P1'],
  'popup-submit-hidden': ['В открытом попапе кнопка отправки за краем экрана', 'Submit button is outside the screen in the open popup', 'forms', 'P2'],
  'popup-no-close': ['Попап не закрывается ни Esc, ни крестиком, ни касанием фона', 'Popup closes neither by Esc, nor the close button, nor the backdrop', 'ux', 'P1'],
  'popup-esc': ['Esc не закрывает попап', 'Esc does not close the popup', 'a11y', 'P3'],
  'popup-focus': ['После открытия попапа фокус остаётся на странице', 'Focus stays on the page after the popup opens', 'a11y', 'P3'],
  'auto-popup': ['Попап открывается сам при загрузке страницы', 'A popup opens by itself on load', 'ux', 'info'],
  'tel-mismatch': ['Номер в ссылке tel: не совпадает с номером на экране', 'tel: link number differs from the number on screen', 'facts', 'P1'],
  'tel-national': ['Ссылка tel: в формате 8…, а не +7…', 'tel: link in 8… format instead of +7…', 'forms', 'P3'],
  'analytics-duplicate': ['Счётчик инициализируется дважды или подключён несколько раз', 'A counter is initialised twice or included several times', 'forms', 'P2'],
  'analytics-inconsistent': ['Счётчики есть не на всех проверенных страницах', 'Counters are missing on some checked pages', 'forms', 'P2'],
  'analytics-none': ['Счётчиков аналитики в коде не найдено', 'No analytics counters found in the code', 'forms', 'P2'],
  'recording-unmasked': ['Запись сессий включена, поля с личными данными от записи не скрыты', 'Session recording is on and personal-data fields are not masked', 'privacy', 'P2'],
  'thanks-indexable': ['Страница «Спасибо» открыта для поисковиков', 'Thank-you page is open to search engines', 'seo-tech', 'P3'],
  'iframe-form': ['Форма во фрейме стороннего сервиса: поля перечислены, нажатия и проверка ввода не делались', 'Form inside a third-party iframe: fields listed, no taps and no input checks', 'forms', 'info'],
};

const PD_LINK = /политик|конфиденц|персональн|privacy|policy|152-?фз|gdpr/i;
const PD_TEXT = /(?<![\p{L}])(?:персональн\p{L}*|обработк\p{L}*|политик\p{L}*|конфиденциальн\p{L}*|personal data|privacy|policy)/iu;
function issuesOf(p, lang) {
  const en = lang === 'en';
  const out = [];
  const add = (check, key, evidence, extra = {}) => out.push({ check, pid: p.pid, url: p.url, width: p.width, key, evidence, ...extra });
  const CONTACT = ['phone', 'email', 'telegram', 'address', 'passport', 'card', 'birth'];
  for (const f of p.forms || []) {
    // a lone name or text field outside <form> (a game, a filter) is not a contact form: listed, not judged
    if (f.formless && !f.pii.some(k => CONTACT.includes(k))) continue;
    const fid = f.sel + (f.heading ? ` («${f.heading.slice(0, 40)}»)` : '');
    const vis = f.shown || f.opened_by;
    // formmethod="post" on every submit button overrides a GET form; a mix is still reported (one of the buttons sends GET)
    const effMethod = f.method_effective || f.method;
    if (!f.formless && f.method === 'get' && effMethod !== 'post' && f.pii.length && (f.method_set || f.action_attr !== null))
      add('get-with-pii', f.sig, `${fid}: method=${f.method_set ? 'get' : (en ? 'none (GET by default)' : 'не задан (по умолчанию GET)')}${effMethod === 'mixed' ? (en ? ' (some submit buttons override it with formmethod)' : ' (часть кнопок меняет его через formmethod)') : ''}, ${en ? 'fields' : 'поля'} ${f.pii.join(', ')}, action ${shortUrl(f.action)}`, { selector: f.sel });
    if (!f.formless && f.method !== 'get' && (f.submit_overrides || []).some(o => o.method === 'get') && f.pii.length)
      add('get-with-pii', f.sig, `${fid}: ${en ? 'a submit button has formmethod="get"' : 'у кнопки отправки formmethod="get"'}, ${en ? 'fields' : 'поля'} ${f.pii.join(', ')}`, { selector: f.sel });
    const actions = [f.action, ...(f.submit_overrides || []).map(o => o.action)].filter(Boolean);
    for (const a of [...new Set(actions)]) if (/^http:\/\//i.test(a) && /^https:/i.test(p.final_url || p.url)) add('action-insecure', f.sig + a, `${fid}: action ${a.slice(0, 120)}`, { selector: f.sel });
    for (const a of [...new Set(actions)]) {
      const svc = serviceOf(a);
      let ext = false; try { ext = thirdParty(a, p.final_url || p.url); } catch { /* */ }
      if (ext || svc) add('endpoint-third-party', f.sig + U.hostOf(a), `${fid}: ${svc || U.hostOf(a)} (${U.hostOf(a)})`, { selector: f.sel, service: svc || U.hostOf(a) });
    }
    const fields = f.fields.filter(x => !x.honeypot && !['consent', 'search'].includes(x.kind) && !['checkbox', 'radio'].includes(x.type));
    if (vis) {
      const ph = fields.filter(x => x.shown && x.label_kind === 'placeholder-only');
      if (ph.length) add('label-placeholder-only', f.sig, `${fid}: ${ph.map(x => `«${x.placeholder}»`).join(', ')}`, { selector: f.sel, examples: ph.map(x => x.sel) });
      const none = fields.filter(x => x.shown && x.label_kind === 'none');
      if (none.length) add('label-missing', f.sig, `${fid}: ${none.map(x => x.name || x.type).join(', ')}`, { selector: f.sel, examples: none.map(x => x.sel) });
    }
    const ac = fields.filter(x => x.autocomplete_ok === false && ['phone', 'email', 'name'].includes(x.kind));
    if (ac.length) add('autocomplete-missing', f.sig, `${fid}: ${ac.map(x => `${x.kind} (${x.autocomplete ? `autocomplete="${x.autocomplete}"` : (en ? 'no autocomplete' : 'нет autocomplete')} → ${x.autocomplete_expected})`).join(', ')}`, { selector: f.sel });
    const ty = fields.filter(x => (x.kind === 'phone' && x.type !== 'tel' && !/tel|numeric/.test(x.inputmode || '')) || (x.kind === 'email' && x.type !== 'email' && x.inputmode !== 'email'));
    if (ty.length) add('input-type', f.sig, `${fid}: ${ty.map(x => `${x.kind} type=${x.type}`).join(', ')}`, { selector: f.sel });
    const rq = fields.filter(x => (x.required.asterisk || x.required.platform) && !x.required.attr && !x.required.aria);
    if (rq.length) add('required-not-programmatic', f.sig, `${fid}: ${rq.map(x => `${x.name || x.kind} (${x.required.platform ? (en ? 'platform rule' : 'правило платформы') : (en ? 'asterisk' : 'звёздочка')})`).join(', ')}`, { selector: f.sel });
    if (vis) { const rh = fields.filter(x => !x.shown && (x.required.attr || x.required.aria)); if (rh.length) add('required-hidden', f.sig, `${fid}: ${rh.map(x => x.name || x.kind).join(', ')}`, { selector: f.sel }); }
    if (f.pii.length && !fields.some(x => x.required.attr || x.required.aria || x.required.platform || x.required.asterisk) && f.validity?.valid !== false && !f.validity?.platform?.errors)
      add('no-required', f.sig, `${fid}: ${en ? 'no data field is required' : 'ни одно поле с данными не обязательно'}${f.formless ? (en ? ' (fields outside <form>)' : ' (поля вне <form>)') : `; checkValidity() = ${f.validity ? f.validity.valid : '—'}`}`, { selector: f.sel });
    const files = f.fields.filter(x => x.type === 'file' && !x.accept);
    if (files.length) add('file-no-accept', f.sig, `${fid}: ${files.map(x => x.name || 'file').join(', ')}`, { selector: f.sel });
    const c = f.consent;
    for (const cb of c.checkboxes) {
      if (cb.checked_default) add('consent-prechecked', f.sig + cb.sel, `${fid}: «${cb.text.slice(0, 120)}»`, { selector: cb.sel });
      if ((cb.required || f.consent.checkboxes.length === 1) && (cb.mentions.ads || cb.mentions.cookie) && (cb.mentions.pd || cb.mentions.policy))
        add('consent-bundled', f.sig + cb.sel, `${fid}: «${cb.text.slice(0, 160)}»${cb.required ? (en ? ' (required)' : ' (обязательное)') : ''}`, { selector: cb.sel });
      if (cb.test_text) add('consent-test-text', f.sig + cb.sel, `${fid}: «${cb.text.slice(0, 80)}»`, { selector: cb.sel });
    }
    // the decision is about consent to personal data processing: a checkbox about rules, terms or an offer is listed
    // in consent.checkboxes but does not count here
    const pdLink = l => PD_LINK.test(`${l.text || ''} ${l.href || ''}`);
    const pdBoxes = c.checkboxes.filter(x => x.mentions.pd || x.mentions.policy || x.links.some(pdLink));
    const pdActs = c.by_action.filter(x => PD_TEXT.test(x.text) || (x.links || []).some(pdLink));
    const pdLinks = c.policy_links.filter(pdLink);
    const otherBoxes = c.checkboxes.filter(x => !pdBoxes.includes(x));
    const onlyOther = otherBoxes.length ? `; ${en ? 'only a checkbox about rules/terms' : 'есть только галочка про правила/условия'}: «${otherBoxes[0].text.slice(0, 100)}»` : '';
    if (f.pii.length && !pdBoxes.length && !pdActs.length && !pdLinks.length) add('consent-missing', f.sig, `${fid}: ${en ? 'fields' : 'поля'} ${f.pii.join(', ')}${onlyOther}`, { selector: f.sel });
    else if (f.pii.length && !pdBoxes.length && !pdActs.length)
      add('consent-none', f.sig, `${fid}: ${en ? 'fields' : 'поля'} ${f.pii.join(', ')}; ${en ? 'only a link' : 'есть только ссылка'} ${pdLinks.slice(0, 2).map(l => `«${l.text || shortUrl(l.href)}»`).join(', ')}${c.outside_form ? (en ? ' (next to the form)' : ' (рядом с формой)') : ''}${onlyOther}`, { selector: f.sel });
    else if (f.pii.length && !pdLinks.length && !pdBoxes.some(x => x.links.length) && !pdActs.some(x => (x.links || []).length))
      add('consent-no-policy-link', f.sig, `${fid}: «${(pdBoxes[0]?.text || pdActs[0]?.text || '').slice(0, 120)}»`, { selector: f.sel });
  }
  for (const t of p.toggles || []) for (const r of t.tapped || []) {
    const name = `«${t.text}» (${r.region}, ${r.sel})`;
    if (r.hit_ok === false) add('toggle-covered', t.key + r.sel, `${name}: ${en ? 'the centre hits' : 'в центре кнопки'} ${r.covered_by}${r.covered_text ? ` «${r.covered_text}»` : ''}${en ? ' (not tapped)' : ' (касания не было)'}`, { selector: r.sel });
    if (r.effect === 'blocked_by_guard') {
      const why = r.refused ? `${en ? 'lib/cdp refused to tap' : 'страховка отказалась нажимать'}: ${REFUSAL_TEXT[r.refused]?.[en ? 1 : 0] || r.refused}`
        : `${en ? 'the tap fired requests the safety net cut' : 'касание отправило запросы, страховка их оборвала'}: ${(r.guard_cut || []).slice(0, 2).map(x => `${x.method || ''} ${x.service || x.url}`.trim()).join('; ')}`;
      add('toggle-blocked-by-guard', t.key + r.sel, `${name}: ${why}`, { selector: r.sel });
    } else if (r.effect === 'none' && !r.error && r.hit_ok !== false) {
      // a chat or callback widget cut by lib/cdp at load: the button most likely opens it — not a dead button
      if ((p.widgets_blocked || []).length) add('toggle-maybe-widget', t.key + r.sel, `${name}: ${en ? 'blocked on the page' : 'на странице заблокирован'} ${p.widgets_blocked.join(', ')}`, { selector: r.sel });
      else add('toggle-no-effect', t.key + r.sel, `${name}: ${en ? 'in 1 s no popup, no form or fields, no scroll, no navigation, no request' : 'за 1 с ни попапа, ни формы или полей, ни прокрутки, ни перехода, ни запроса'}`, { selector: r.sel });
    } else if (r.effect === 'request') {
      add('toggle-request', t.key + r.sel, `${name}: ${(r.requests || []).slice(0, 2).map(x => `${x.type || ''} ${x.url}`.trim()).join('; ')}`, { selector: r.sel });
    }
    if (r.layer) {
      const hidden = Object.entries(r.submit_view || {}).filter(([, v]) => v === false).map(([k]) => k);
      if (hidden.length) add('popup-submit-hidden', t.key, `${name}: «${r.submit_text || 'submit'}» ${en ? 'not in the window at' : 'вне экрана на'} ${hidden.join(', ')}; ${en ? 'popup content' : 'содержимое попапа'} ${r.layer.content_screens} ${en ? 'screens' : 'экрана'}`, { selector: r.layer.sel, shot: r.shot });
      // a refused close button or backdrop was not tried: no verdict on closing
      const untried = r.close && (r.close.button === 'refused' || r.close.backdrop === 'refused');
      if (r.close && !untried && !r.close.esc && r.close.button !== true && r.close.backdrop !== true) add('popup-no-close', t.key, `${name}: Esc ${r.close.esc}, ${en ? 'close button' : 'крестик'} ${r.close.button}, ${en ? 'backdrop' : 'фон'} ${r.close.backdrop}`, { selector: r.layer.sel, shot: r.shot });
      else if (r.close && r.close.esc === false) add('popup-esc', t.key, `${name}: ${en ? 'closed by' : 'закрылся'} ${r.close.button === true ? (en ? 'the close button' : 'крестиком') : (en ? 'the backdrop' : 'касанием фона')}`, { selector: r.layer.sel });
      if (r.layer.focus_in === false) add('popup-focus', t.key, `${name}: ${en ? 'document.activeElement outside the popup' : 'document.activeElement вне попапа'}`, { selector: r.layer.sel });
    }
  }
  for (const a of p.auto_layers || []) if (a.kind === 'modal') add('auto-popup', a.sel, `${a.sel}: «${a.text}»${a.forms ? `, ${en ? 'forms' : 'форм'} ${a.forms}` : ''}`, { selector: a.sel });
  for (const t of p.contacts?.tel || []) {
    if (t.mismatch) add('tel-mismatch', t.href, `${t.href} ${en ? 'vs on screen' : '— на экране'} «${t.text}»`, {});
    if (t.format === 'national-8') add('tel-national', t.href, `${t.href} «${t.text}»`, {});
  }
  const an = p.analytics;
  if (an) {
    for (const d of an.duplicates) add('analytics-duplicate', `${d.system}|${d.id}|${d.why}`, `${d.system} ${d.id || ''}: ${d.why}`, { possible: !!d.possible });
    const rec = an.recording.metrika_webvisor || an.recording.hotjar || an.recording.clarity;
    if (rec) {
      const pii = (p.forms || []).flatMap(f => f.fields.filter(x => x.pii && !x.masked.some(m => /disable-keys|hide-content|hj-suppress|clarity-mask/.test(m))));
      if (pii.length) add('recording-unmasked', 'rec', `${[an.recording.metrika_webvisor ? (en ? 'Metrika Webvisor' : 'Вебвизор Метрики') : null, an.recording.hotjar ? 'Hotjar' : null, an.recording.clarity ? 'Clarity' : null].filter(Boolean).join(', ')}; ${en ? 'unmasked fields' : 'поля без маскировки'}: ${[...new Set(pii.map(x => x.name || x.kind))].slice(0, 6).join(', ')}`, {});
    }
  }
  for (const fr of p.iframe_forms || []) {
    const fs = (fr.forms || []).filter(x => x.fields.length);
    const desc = fs.length ? fs.slice(0, 2).map(x => `${en ? 'fields' : 'поля'} ${[...new Set(x.fields.filter(y => y.kind !== 'consent').map(y => y.kind))].join(', ')}${x.consent.checkbox ? (x.consent.prechecked ? (en ? ', consent checkbox PRE-CHECKED' : ', галочка согласия СТОИТ ЗАРАНЕЕ') : (en ? ', consent checkbox' : ', галочка согласия')) : x.consent.text ? (en ? ', consent text' : ', текст согласия') : (en ? ', no consent seen' : ', согласия не видно')}`).join('; ')
      : fr.read_error ? (en ? `not read (${fr.read_error})` : `не прочитан (${fr.read_error})`) : (en ? 'no form fields inside' : 'полей формы внутри нет');
    add('iframe-form', fr.src, `${fr.service || fr.host || U.hostOf(fr.src)}: ${desc}; ${fr.src.slice(0, 90)}`, { selector: null });
  }
  return out;
}
const REFUSAL_TEXT = {
  submit: ['кнопка отправки формы', 'a submit button'], 'contact-form': ['кнопка в форме с контактами или рядом с полем телефона/почты', 'a button of a contact form or next to a phone/email field'],
  'consent-accept': ['кнопка «Принять» в баннере cookie', 'a cookie «accept» button'], iframe: ['внутри фрейма', 'inside an iframe'], link: ['ссылка', 'a link'], nothing: ['под точкой касания ничего нет', 'nothing under the tap point'],
};

function aggregate(issues, lang) {
  const by = new Map();
  for (const i of issues) {
    let a = by.get(i.check);
    if (!a) { const c = CHECKS[i.check] || [i.check, i.check, 'forms', 'info']; a = { check: i.check, title: lang === 'en' ? c[1] : c[0], lens: c[2], severity_hint: c[3], count_total: 0, pages: [], keys: new Map() }; by.set(i.check, a); }
    let w = a.keys.get(i.key);
    if (!w) { w = { pids: [], url: i.url, width: i.width, selector: i.selector ?? null, evidence: i.evidence, examples: i.examples, shot: i.shot, service: i.service, possible: i.possible || undefined }; a.keys.set(i.key, w); a.count_total++; }
    if (!w.pids.includes(i.pid)) w.pids.push(i.pid);
    if (!a.pages.includes(i.pid)) a.pages.push(i.pid);
  }
  const order = { P0: 0, P1: 1, P2: 2, P3: 3, info: 4 };
  return [...by.values()].map(a => ({ check: a.check, title: a.title, lens: a.lens, severity_hint: a.severity_hint, count_total: a.count_total, pages: a.pages, sitewide: a.pages.length > 1,
    where: [...a.keys.values()].slice(0, 25) })).sort((x, y) => (order[x.severity_hint] ?? 9) - (order[y.severity_hint] ?? 9) || y.pages.length - x.pages.length);
}

function pickPages(all, max, run) {
  if (!max || all.length <= max) return { take: all, rest: [] };
  const score = p => {
    const pj = U.readJSON(join(run, 'snapshot', p.pid, 'page.json'), null);
    let s = 0;
    if (p.pid === 'home') s += 100;
    if (pj) s += (pj.forms?.length || 0) * 10 + (pj.popup_triggers || 0) * 5 + (pj.formless_fields ? 3 : 0);
    if (/контакт|contact|форм|form|заявк|запис|zapis|order|заказ|calc|кальк|price|цен|услуг|корзин|cart|checkout|вход|login|signin|book/i.test(`${p.url} ${p.why || ''} ${p.title || ''}`)) s += 20;
    return s;
  };
  const sorted = [...all].sort((a, b) => score(b) - score(a));
  const take = []; const seenT = new Set();
  for (const p of sorted) { if (take.length >= max) break; if (score(p) >= 20 || !seenT.has(p.template)) { take.push(p); seenT.add(p.template); } }
  for (const p of sorted) { if (take.length >= max) break; if (!take.includes(p)) take.push(p); }
  return { take, rest: all.filter(p => !take.includes(p)) };
}

async function checkThanks(browser, urls, ctx) {
  const out = [];
  for (const { url, from } of urls.slice(0, 3)) {
    if (!U.sameSite(url, ctx.siteUrl)) { out.push({ url, from, skipped: 'other site' }); continue; }
    if (U.isRiskyGet(url)) { out.push({ url, from, skipped: 'risky' }); continue; }
    // parameters of a thank-you URL may be a lead or a conversion mark: such a URL is not opened
    let qs = ''; try { qs = new URL(url).search; } catch { /* */ }
    if (qs) { out.push({ url: url.split('?')[0], from, skipped: 'has-query' }); continue; }
    const r = await U.politeFetch(url, { timeoutMs: 20000, maxBytes: 2 * 1024 * 1024 });
    const rec = { url, from, status: r.status || null, error: r.error || null, x_robots: r.headers?.['x-robots-tag'] || null };
    if (r.ok && r.body) {
      try { const d = await parseHtml(browser, r.body, r.url); rec.robots = d.robots; rec.title = d.title; rec.canonical = d.canonical; } catch (e) { rec.parse_error = String(e.message || e).slice(0, 120); }
    }
    rec.noindex = /noindex/i.test(`${rec.robots || ''} ${rec.x_robots || ''}`);
    out.push(rec);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
async function main() {
  const args = U.parseArgs(process.argv.slice(2), { boolean: ['help', 'allow-load-posts', 'shots', 'thanks'] });
  const lang = U.langOf(args); const en = lang === 'en';
  U.helpAndExit(en ? HELP_EN : HELP, args);
  const run = U.requireRun(args);
  const started = Date.now();
  const budget = Math.max(60, Number(args['budget-sec'] || 480));
  let deadline = started + budget * 1000;
  const W = U.listArg(args.widths).map(Number).filter(w => w >= 240 && w <= 3000);
  const widths = W.length ? W : [390];
  const maxPages = args['max-pages'] === undefined ? 12 : Number(args['max-pages']);
  const maxTaps = Math.max(0, Math.min(40, Number(args['max-taps'] ?? 14)));

  let pagesDoc = null, pagesAll;
  if (existsSync(join(run, 'pages.json'))) { pagesDoc = U.readJSON(join(run, 'pages.json'), {}); pagesAll = U.loadPages(run, args).filter(p => p.url && !p.blocked); }
  else if (args.url && args.url !== true) { let url; try { url = U.normalizeUrl(args.url); } catch { console.error(U.msg('need_url', lang)); process.exit(2); } pagesAll = [{ pid: 'home', url, template: 'url', why: '--url' }]; pagesDoc = { site: url, final_origin: new URL(url).origin }; }
  else { console.error(en ? 'No pages.json and no --url.' : 'Нет pages.json и не задан --url.'); process.exit(2); }
  if (!pagesAll.length) { console.error(en ? 'No pages to check in pages.json.' : 'В pages.json нет страниц для проверки.'); process.exit(2); }
  const { take, rest } = U.listArg(args.pages).length ? { take: pagesAll, rest: [] } : pickPages(pagesAll, maxPages, run);
  const siteUrl = pagesDoc.final_origin || pagesDoc.site || take[0].url;
  const siteHost = U.hostOf(siteUrl);
  // the reviewed site itself may be local (demo, a stand on this machine): allow only its host
  if (siteHost && await U.resolvesPrivate(siteHost)) U.allowPrivateHost(siteHost);

  const outPath = U.insideRun(run, 'measure', 'forms.json');
  const prev = U.readJSON(outPath, null);
  const resume = prev && prev.partial && prev.resume?.done ? prev : null;
  const done = new Set(resume ? resume.resume.done : []);
  const attempts = { ...(resume?.resume?.attempts || {}) };
  const results = resume ? (prev.pages || []).filter(p => done.has(`${p.pid}@${p.width}`)) : [];
  const errors = resume ? (prev.errors || []) : [];
  let thanks = resume && done.has('thanks') ? prev.thanks || [] : null;
  const tested = new Map(widths.map(w => [w, new Map()]));
  for (const p of results) for (const t of p.toggles || []) if (t.tapped?.length && tested.has(p.width)) tested.get(p.width).set(t.key, `${p.pid}@${p.width}`);

  let slotWaitSec = null;
  const write = partial => {
    const out = { ...U.measureHeader('forms', run), partial, resume: partial ? { done: [...done], attempts } : null };
    out.pages = results;
    out.errors = errors;
    out.thanks = thanks || [];
    out.not_checked = [];
    if (slotWaitSec !== null) { out.partial_reason = 'slot_wait'; out.slot_wait_sec = slotWaitSec; out.not_checked.push({ what: 'browser', why: en ? `browser busy with other checks (slot_wait, waited ${slotWaitSec} s) — repeat the call` : `браузер занят другими проверками (slot_wait, ждали ${slotWaitSec} с) — повторите вызов` }); }
    if (rest.length) out.not_checked.push({ what: 'pages', why: en ? `${rest.length} pages over --max-pages ${maxPages}` : `${rest.length} страниц сверх --max-pages ${maxPages}`, pids: rest.map(p => p.pid) });
    out.not_checked.push({ what: 'submit', why: en ? 'forms were never submitted: masks, server validation, CRM delivery, thank-you behaviour after sending and goals firing need a test submission by the owner' : 'формы не отправлялись: маски при вводе, серверная проверка, доставка в CRM, поведение после отправки и срабатывание целей — только тестовой заявкой владельца' });
    out.not_checked.push({ what: 'tag-manager', why: en ? 'GTM and counters were blocked: tags inside the container are not seen' : 'GTM и счётчики заблокированы: что настроено внутри контейнера, не видно' });
    for (const p of results) for (const t of p.toggles || []) if (t.skipped === 'budget' || t.skipped === 'max-taps') out.not_checked.push({ pid: p.pid, width: p.width, what: `toggle «${t.text}»`, why: t.skipped });
    const UNSAFE = { 'in-form': ['внутри формы', 'inside a form'], 'formless-block': ['в блоке с полями без <form>', 'in a block with fields outside <form>'], 'near-fields': ['рядом с полями ввода', 'next to input fields'], 'send-like': ['текст «отправить / перезвоните» без ссылки на попап', '«send / call me» text without a popup link'],
      'site-action': ['действие на сайте (избранное, лайк, показать номер, голос)', 'a site action (favourite, like, reveal a number, vote)'], 'cookie-banner': ['в баннере cookie', 'inside a cookie banner'] };
    const sends = w => ['in-form', 'formless-block', 'near-fields', 'send-like'].includes(w);
    for (const p of results) for (const t of p.toggles || []) if (t.skipped === 'unsafe') { const w = t.unsafe[0].why; out.not_checked.push({ pid: p.pid, width: p.width, what: `toggle «${t.text}»`,
      why: en ? `not tapped: ${UNSAFE[w]?.[1] || w}${sends(w) ? ' — the tap could send a form' : ' — the tap would change something on the site'}` : `не нажималась: ${UNSAFE[w]?.[0] || w}${sends(w) ? ' — касание могло отправить заявку' : ' — касание что-то изменило бы на сайте'}` }); }
    for (const p of results) for (const t of p.toggles || []) for (const r of t.tapped || []) if (r.close && (r.close.button === 'refused' || r.close.backdrop === 'refused') && !r.close.esc && r.close.button !== true && r.close.backdrop !== true)
      out.not_checked.push({ pid: p.pid, width: p.width, what: `popup close «${t.text}»`, why: en ? 'Esc did not close it; the close button / backdrop sits next to form fields and was not tapped — check closing by hand' : 'Esc не закрыл; крестик или фон рядом с полями формы — не нажимались, закрытие проверить руками' });
    for (const p of results) for (const f of p.forms || []) if (f.in_popup && !f.shown && !f.opened_by) out.not_checked.push({ pid: p.pid, width: p.width, what: `form ${f.sel}`, why: en ? 'form in a popup was not seen on screen (no toggle found or not tapped): labels not judged' : 'форма в попапе на экране не оценивалась (кнопка не найдена или не нажата): подписи не проверены' });
    const issues = results.flatMap(p => (p.error ? [] : issuesOf(p, lang)));
    // pages without any counter while others have one (a blocked load of a counter counts: it is on the page)
    const hasCounter = p => !!(p.analytics?.counters?.length || (p.analytics?.attempts || []).some(a => a.kind === 'analytics'));
    const withC = results.filter(p => !p.error && p.analytics && hasCounter(p)), withoutC = results.filter(p => !p.error && p.analytics && !hasCounter(p));
    if (withC.length && withoutC.length) for (const p of withoutC) issues.push({ check: 'analytics-inconsistent', pid: p.pid, url: p.url, width: p.width, key: p.pid, evidence: en ? `no counters on ${p.pid}; present on ${[...new Set(withC.map(x => x.pid))].join(', ')}` : `на ${p.pid} счётчиков нет; есть на ${[...new Set(withC.map(x => x.pid))].join(', ')}` });
    if (!withC.length && withoutC.length) issues.push({ check: 'analytics-none', pid: withoutC[0].pid, url: withoutC[0].url, width: withoutC[0].width, key: 'none', evidence: en ? 'no counter code and no blocked counter requests on the checked pages' : 'ни кода счётчиков, ни заблокированных попыток их загрузки на проверенных страницах' });
    for (const t of thanks || []) if (t.status === 200 && !t.noindex) issues.push({ check: 'thanks-indexable', pid: '*', url: t.url, width: null, key: t.url, evidence: `${shortUrl(t.url)}: 200, ${en ? 'no noindex' : 'без noindex'}${t.title ? `, «${t.title}»` : ''}` });
    out.items = aggregate(issues, lang);
    // unique forms across pages
    const uniq = new Map();
    for (const p of results) for (const f of p.forms || []) { const u = uniq.get(f.sig) || { sig: f.sig, pids: [], pii: f.pii, in_popup: f.in_popup, formless: f.formless, action_host: U.hostOf(f.action || ''), method: f.method, heading: f.heading, platform: f.platform }; if (!u.pids.includes(p.pid)) u.pids.push(p.pid); uniq.set(f.sig, u); }
    out.forms_unique = [...uniq.values()];
    const all = results.filter(p => !p.error);
    const tapped = all.flatMap(p => (p.toggles || []).flatMap(t => t.tapped || []));
    const counters = new Map(); for (const p of all) for (const c of p.analytics?.counters || []) counters.set(c.system + '|' + c.id, c);
    const goals = new Map(); for (const p of all) for (const g of p.analytics?.goals_in_code || []) goals.set(g.system + '|' + g.name, g);
    const attemptsSvc = new Map(); for (const p of all) for (const a of p.analytics?.attempts || []) { const e = attemptsSvc.get(a.name) || { ...a, n: 0 }; e.n += a.n; attemptsSvc.set(a.name, e); }
    out.calculators = all.flatMap(p => (p.calculators || []).map(c => ({ pid: p.pid, width: p.width, ...c,
      probe_example: c.fields[0] && c.outputs[0] && !c.in_contact_form ? `node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid ${p.pid} --width ${p.width} --fill "${c.fields[0].sel}=${c.fields[0].max || c.fields[0].value || 1}" --read "${c.outputs[0].sel}"` : null })));
    out.summary = {
      pages: new Set(all.map(p => p.pid)).size, runs: results.length, widths,
      forms_unique: out.forms_unique.length, forms_with_pii: out.forms_unique.filter(f => f.pii.length).length, forms_in_popups: out.forms_unique.filter(f => f.in_popup).length,
      iframe_forms: new Set(all.flatMap(p => (p.iframe_forms || []).map(f => f.src.split('#')[0]))).size,
      toggles_found: all.reduce((a, p) => a + (p.toggles?.length || 0), 0), taps: tapped.length,
      popups_opened: tapped.filter(t => t.effect === 'popup').length, no_effect: tapped.filter(t => t.effect === 'none' && !t.error).length,
      navigations_cut: tapped.filter(t => t.effect === 'navigation').length, refused: tapped.filter(t => t.refused).length,
      blocked_by_guard: tapped.filter(t => t.effect === 'blocked_by_guard').length, covered_not_tapped: tapped.filter(t => t.effect === 'not-tapped').length,
      unsafe_not_tapped: all.reduce((a, p) => a + (p.toggles || []).filter(t => t.unsafe?.length).length, 0),
      consent: (() => { const u = new Map(); for (const p of all) for (const f of p.forms || []) if (!u.has(f.sig)) u.set(f.sig, f); const fs2 = [...u.values()]; return { checkboxes: fs2.reduce((a, f) => a + f.consent.checkboxes.length, 0), prechecked: fs2.reduce((a, f) => a + f.consent.checkboxes.filter(c => c.checked_default).length, 0), by_click_text: fs2.filter(f => f.consent.by_action.length).length }; })(),
      counters: [...counters.values()].map(c => ({ system: c.system, id: c.id, id_expr: c.id_expr, from_attempt: !c.id && (c.sources || []).every(x => x === 'attempt') ? true : undefined, webvisor: c.webvisor })), goals_in_code: [...goals.values()].length,
      session_recording: { metrika_webvisor: all.some(p => p.analytics?.recording?.metrika_webvisor), hotjar: all.some(p => p.analytics?.recording?.hotjar), clarity: all.some(p => p.analytics?.recording?.clarity) },
      attempts: [...attemptsSvc.values()].map(a => ({ name: a.name, category: a.category, n: a.n })).sort((a, b) => b.n - a.n),
      contacts: { tel: new Set(all.flatMap(p => (p.contacts?.tel || []).map(t => t.href))).size, mailto: new Set(all.flatMap(p => (p.contacts?.mailto || []).map(t => t.href))).size,
        messengers: [...new Set(all.flatMap(p => (p.contacts?.messengers || []).map(t => t.service)))] },
      calculators: out.calculators.length,
      write_attempts_blocked: all.reduce((a, p) => a + (p.blocked?.write?.n || 0) + (p.blocked?.interact?.non_get || 0), 0),
      taps_with_requests: tapped.filter(t => t.effect === 'request').length,
      method: en ? 'one load per page×width in a fresh headless profile with the lib/cdp safety net (non-GET cut, counters/chats blocked, navigations aborted, background requests cut for 3 s after each tap); DOM read in an isolated world; popup toggles opened with real touch (390) or mouse input, never buttons inside forms or next to input fields; iframe forms listed read-only; checkValidity() without submit; analytics from inline code, noscript, script tags, same-site script bodies and blocked attempts'
        : 'одна загрузка на страницу×ширину в новом профиле со страховкой lib/cdp (не-GET обрываются, счётчики и чаты заблокированы, переходы отменяются, фоновые запросы 3 с после касания обрываются); DOM читается в изолированном мире; попапы открываются реальным касанием (390) или мышью, кнопки внутри форм и рядом с полями не нажимаются; формы во фреймах перечисляются без нажатий; checkValidity() без отправки; аналитика — по встроенному коду, noscript, тегам script, телу скриптов своего сайта и заблокированным попыткам',
    };
    U.writeJSON(outPath, out);
    return out;
  };

  const jobs = [];
  for (const pg of take) for (const w of widths) if (!done.has(`${pg.pid}@${w}`)) jobs.push([pg, w]);
  const needThanks = thanks === null && args.thanks !== false;
  let partial = false;
  if (jobs.length || needThanks) {
    let release = null, browser = null;
    try {
      // wait for a browser only within the budget; no slot -> partial + 75 (slot_wait), the same call continues
      const tw = Date.now();
      try { release = await U.acquireBrowserSlot({ waitMs: Math.max(5000, deadline - Date.now() - 15000) }); }
      catch (e) {
        if (e.code !== 'SLOT_TIMEOUT') throw e;
        slotWaitSec = Math.round((Date.now() - tw) / 1000);
        U.log(run, `forms: ждал свободный браузер ${slotWaitSec} с, не дождался (slot_wait)`);
        const out = write(true);
        printSummary(run, out, lang, true);
        process.exit(75);
      }
      try { browser = await Browser.launch(); }
      catch (e) { release(); release = null; console.error(String(e.message || e)); process.exit(2); }
      // tested: width → Map(toggle key → pid@width), so the same header button is not tapped on every page
      const ctx = { run, lang, siteHost, siteUrl, deadline, maxTaps, shots: args.shots !== false, allowLoadPosts: !!args['allow-load-posts'], tested, pageForms: [] };
      let ran = 0;
      for (const [pg, w] of jobs) {
        const need = 45000;
        if (ran && Date.now() + need > deadline - 8000) { partial = true; break; }
        ran++;
        U.progress(`forms: ${pg.pid} @${w}`);
        const key = `${pg.pid}@${w}`;
        const remaining = Math.max(30000, deadline - Date.now() - 6000);
        let r;
        try {
          // a copy per job: a job cut by the budget may still run in the old browser for a moment
          const job = checkPage(browser, pg, w, { ...ctx });
          job.catch(() => {});
          r = await Promise.race([job, U.sleep(remaining).then(() => ({ timeout: true }))]);
        } catch (e) { r = { pid: pg.pid, url: pg.url, width: w, error: String(e.message || e).slice(0, 300) }; }
        if (r.timeout) {
          attempts[key] = (attempts[key] || 0) + 1;
          if (attempts[key] < 2) { partial = true; break; }
          r = { pid: pg.pid, url: pg.url, width: w, error: en ? 'did not finish in two tries (page too slow for the time budget)' : 'не уложилась в две попытки (страница слишком медленная для бюджета времени)' };
          try { await browser.close(); } catch {}
          browser = await Browser.launch();
        }
        if (r.error) errors.push({ pid: pg.pid, width: w, error: r.error });
        results.push(r); done.add(key);
        write(true);
      }
      if (!partial && needThanks && Date.now() < deadline - 20000) {
        const urls = []; const seen = new Set();
        for (const p of results) for (const f of p.forms || []) for (const u of [f.thanks?.success_url, f.thanks?.redirect_field]) if (u && /^https?:/i.test(u) && !seen.has(u)) { seen.add(u); urls.push({ url: u, from: `${p.pid} ${f.sel}` }); }
        thanks = urls.length ? await checkThanks(browser, urls, { siteUrl }) : [];
        done.add('thanks');
      } else if (!partial && needThanks) partial = true;
    } finally {
      if (browser) await browser.close();
      if (release) release();
    }
  }
  const out = write(partial);
  printSummary(run, out, lang, partial);
  process.exit(partial ? 75 : 0);
}

function printSummary(run, out, lang, partial) {
  const en = lang === 'en'; const s = out.summary;
  const L = [];
  // no browser and nothing measured yet: one honest line instead of an empty «no issues» summary
  if (out.partial_reason === 'slot_wait' && !s.runs) {
    L.push(en ? `forms: PARTIAL — browser busy with other checks (slot_wait, waited ${out.slot_wait_sec} s), nothing measured yet; rerun the same command.`
      : `forms: ЧАСТИЧНО — браузер занят другими проверками (slot_wait, ждали ${out.slot_wait_sec} с), замеров ещё нет; повторите ту же команду.`);
    L.push(`${en ? 'Written' : 'Записано'}: ${join(run, 'measure', 'forms.json')}`);
    U.printAndSaveSummary(run, 'forms', L);
    U.log(run, `forms.mjs: slot_wait ${out.slot_wait_sec} s (partial)`);
    return;
  }
  L.push(`forms: ${en ? 'pages' : 'страниц'} ${s.pages} (${s.widths.join(', ')}), ${en ? 'unique forms' : 'уникальных форм'} ${s.forms_unique} (${en ? 'with personal data' : 'с личными данными'} ${s.forms_with_pii}, ${en ? 'in popups' : 'в попапах'} ${s.forms_in_popups}), ${en ? 'iframe forms' : 'форм во фреймах'} ${s.iframe_forms}`);
  L.push(`${en ? 'Toggles' : 'Кнопки-переключатели'}: ${en ? 'found' : 'найдено'} ${s.toggles_found}, ${en ? 'tapped' : 'нажато'} ${s.taps}, ${en ? 'opened a popup' : 'открыли попап'} ${s.popups_opened}, ${en ? 'did nothing' : 'ничего не сделали'} ${s.no_effect}, ${en ? 'navigation cut' : 'переход оборван'} ${s.navigations_cut}${s.blocked_by_guard ? `, ${en ? 'cut by the safety net' : 'оборвано страховкой'} ${s.blocked_by_guard}` : ''}${s.covered_not_tapped ? `, ${en ? 'covered, not tapped' : 'перекрыто, не нажато'} ${s.covered_not_tapped}` : ''}${s.unsafe_not_tapped ? `, ${en ? 'not tapped for safety (could send a form or change the site)' : 'не нажимались ради безопасности (могли отправить заявку или что-то изменить)'} ${s.unsafe_not_tapped}` : ''}`);
  L.push(`${en ? 'Consents' : 'Согласия'}: ${en ? 'checkboxes' : 'галочек'} ${s.consent.checkboxes}, ${en ? 'pre-checked' : 'стоят заранее'} ${s.consent.prechecked}`);
  const sh = { P0: 0, P1: 1, P2: 2, P3: 3, info: 4 };
  for (const it of out.items.slice().sort((a, b) => sh[a.severity_hint] - sh[b.severity_hint]).slice(0, 16)) {
    const w = it.where[0];
    L.push(`- [${it.severity_hint}] ${it.title} ×${it.count_total} [${it.pages.slice(0, 4).join(', ')}]: ${String(w?.evidence || '').slice(0, 170)}`);
  }
  if (!out.items.length) L.push(en ? '- the script found no issues (the lens still reads the forms)' : '- скрипт нарушений не нашёл (линза всё равно читает формы)');
  const ctr = s.counters.map(c => `${c.system} ${c.id ?? (c.id_expr ? (en ? `(number in ${c.id_expr}, not found)` : `(номер в ${c.id_expr}, не найден)`) : (en ? '(only a blocked load, number unknown)' : '(только заблокированная загрузка, номер неизвестен)'))}${c.webvisor ? (en ? ' (webvisor on)' : ' (Вебвизор вкл.)') : ''}`).join(', ');
  L.push(`${en ? 'Analytics' : 'Аналитика'}: ${ctr || (en ? 'no counters in code' : 'счётчиков в коде нет')}; ${en ? 'goals in code' : 'целей в коде'} ${s.goals_in_code}`);
  if (s.attempts.length) L.push(`${en ? 'Blocked attempts' : 'Попытки загрузки (заблокированы)'}: ${s.attempts.slice(0, 8).map(a => `${a.name} ${a.n}`).join(', ')}`);
  L.push(`${en ? 'Links' : 'Ссылки'}: tel ${s.contacts.tel}, mailto ${s.contacts.mailto}${s.contacts.messengers.length ? `, ${en ? 'messengers' : 'мессенджеры'}: ${s.contacts.messengers.join(', ')}` : ''}`);
  if (s.calculators) L.push(`${en ? 'Calculators for the facts lens (probe --fill)' : 'Калькуляторы для линзы facts (probe --fill)'}: ${out.calculators.slice(0, 3).map(c => `${c.pid} ${c.sel}${c.in_contact_form ? (en ? ' (inside a contact form)' : ' (внутри формы с контактами)') : ''}`).join('; ')}`);
  if (out.thanks?.length) L.push(`${en ? 'Thank-you pages' : 'Страницы «спасибо»'}: ${out.thanks.map(t => `${shortUrl(t.url)} ${t.status ?? t.skipped}${t.noindex ? ' noindex' : ''}`).join('; ')}`);
  if (s.write_attempts_blocked) L.push(`${en ? 'Non-GET requests cut by the safety net' : 'Не-GET запросов оборвано страховкой'}: ${s.write_attempts_blocked}`);
  if (out.errors.length) L.push(`${en ? 'Errors' : 'Ошибки'}: ${out.errors.slice(0, 3).map(e => `${e.pid}@${e.width} ${e.error}`).join('; ').slice(0, 200)}`);
  L.push(`${en ? 'Written' : 'Записано'}: ${join(run, 'measure', 'forms.json')}${out.pages.some(p => (p.toggles || []).some(t => (t.tapped || []).some(x => x.shot))) ? (en ? '; popup frames: measure/forms/*.jpg' : '; кадры попапов: measure/forms/*.jpg') : ''}`);
  if (partial && out.partial_reason === 'slot_wait') L.push(en ? `PARTIAL — browser busy with other checks (slot_wait, waited ${out.slot_wait_sec} s), rerun the same command.` : `ЧАСТИЧНО — браузер занят другими проверками (slot_wait, ждали ${out.slot_wait_sec} с), повторите ту же команду.`);
  else if (partial) L.push(en ? 'Partial result: run the same command again to continue.' : 'Частичный результат: повторите ту же команду — продолжит с места остановки.');
  U.printAndSaveSummary(run, 'forms', L);
  U.log(run, `forms.mjs: ${s.runs} ${en ? 'runs' : 'прогонов'}, ${en ? 'forms' : 'форм'} ${s.forms_unique}, ${en ? 'taps' : 'касаний'} ${s.taps}${partial ? ' (partial)' : ''}`);
}

main().catch(e => { console.error(e?.stack || String(e)); process.exit(1); });
