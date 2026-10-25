// Revizor built-in probe product-cta-map.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/product-cta-map.js" --no-shot
// Action buttons, forms, calls and messengers: first screen at two window heights, longest stretch without an action, page end
const W = innerWidth, VH = innerHeight;
const H = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
const PHONE = W < 600;
const FOLDS = [...new Set([...(PHONE ? [664, 844] : [789, 900]), VH])].sort((a, b) => a - b);
const SCREEN = PHONE ? 844 : 900; // one screen for gap counts, as in mobile.json
// Action words match at a word start only: "Доставка" and "Состав" are not "оставить"
const ACT = /(?<!\p{L})(записат|запиш|запись(?!\p{L})|онлайн-запис|заявк|заказат|закаж|сделать заказ|заказ звонк|купит|купи(?!\p{L})|в корзину|оформит|позвон|перезвон|звоните|обратн\p{L}* звон|связат|свяж|напиш|рассчит|расч[её]т стоим|расч[её]т цен|подобрат|подбер|заброн|бронир|оставит|оставьт|начать|начните|попробов|попробуй|подключит|подключи(?!\p{L})|открыть сч|открыть карт|открыть вклад|консультаци[юя](?!\p{L})|получит|узнать цен|узнать стоим|зарегистр|регистрац|оплатит|хочу(?!\p{L})|присоедин|book(?!\p{L})|order (now|online)|place (an )?order|buy(?!\p{L})|add to (cart|bag|basket)|get started|sign ?up|register(?!\p{L})|subscribe|contact us|get (a |your )?quote|request (a )?(call|quote|demo|callback)|try (it )?(free|now|for free)|start (free|now|your|a )|call (us|now|back)|reserve|apply(?!\p{L})|enrol|get in touch|schedule (a|an|your)|join(?!\p{L}))/iu;
const contactKind = href => {
  const h = (href || '').trim().toLowerCase();
  if (h.startsWith('tel:')) return 'call';
  if (/^(viber|whatsapp|tg|skype):/.test(h)) return 'messenger';
  if (/^(https?:)?\/\/(www\.)?(t\.me|telegram\.me|wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|vk\.me|m\.me|ig\.me)\//.test(h)) return 'messenger';
  return null;
};
const fill = c => c && !/rgba\(0, 0, 0, 0\)|transparent/.test(c);
const btnLike = (el, r, cs) => {
  if (/^(BUTTON|INPUT)$/.test(el.tagName) || el.getAttribute('role') === 'button') return true;
  if (/(^|[\s_-])(btn|button|cta)([\s_-]|$)/i.test(typeof el.className === 'string' ? el.className : '')) return true;
  const border = parseFloat(cs.borderTopWidth) >= 1 && cs.borderTopStyle !== 'none' && parseFloat(cs.borderBottomWidth) >= 1;
  const inner = el.children.length === 1 ? getComputedStyle(el.firstElementChild) : null;
  return (fill(cs.backgroundColor) || border || (inner && fill(inner.backgroundColor))) && r.height >= 28 && r.width >= 60;
};
// Site footer: the footer that ends lowest; a <footer> inside a card higher up is not the site footer
const fc = [...document.querySelectorAll('footer, [role=contentinfo]')].map(f => ({ f, r: f.getBoundingClientRect() })).filter(o => o.r.height > 0);
let foot = null;
if (fc.length) { const maxB = Math.max(...fc.map(o => o.r.bottom)); foot = fc.filter(o => o.r.bottom >= maxB - 50).sort((a, b) => a.r.top - b.r.top)[0].f; }
if (foot && H - (foot.getBoundingClientRect().bottom + scrollY) > SCREEN) foot = null;
const footTop = foot ? Math.round(foot.getBoundingClientRect().top + scrollY) : H;
const posOf = el => { for (let n = el; n && n !== document.body; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === 'fixed' || p === 'sticky') return [p, n]; } return [null, null]; };
const regionOf = (el, fixed) => {
  if (foot && foot.contains(el)) return 'footer';
  const hd = el.closest('header, [role=banner], nav, [role=navigation]');
  if (hd && (fixed || hd.getBoundingClientRect().top + scrollY < 300)) return 'header';
  return 'main';
};
const coveredAt = (el, r) => {
  if (r.top < 0 || r.bottom > VH || r.left < 0 || r.right > W) return null; // only what is inside the window now
  const h = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return !!h && h !== el && !el.contains(h) && !h.contains(el);
};
const seen = new Set(), out = [];
const add = (el, kind, text, extra = {}) => {
  const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  if (r.width < 8 || r.height < 8 || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return;
  const [pos, holder] = posOf(el), fixed = pos === 'fixed';
  const y = Math.round(fixed ? r.top : r.top + scrollY);
  const key = kind + '|' + text + '|' + y;
  if (seen.has(key)) return; seen.add(key);
  out.push({ kind, text, box: [Math.round(r.left), y, Math.round(r.width), Math.round(r.height)], fixed: pos,
    anchor: fixed ? (holder.getBoundingClientRect().bottom >= VH - 2 ? 'bottom' : 'top') : null, region: regionOf(el, !!pos), covered: coveredAt(el, r), ...extra });
};
for (const el of document.querySelectorAll('a[href], button, [role=button], input[type=submit], input[type=button]')) {
  if (out.length >= 80) break;
  const href = el.getAttribute('href');
  const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim();
  const ck = contactKind(href);
  if (ck) { add(el, ck, t.slice(0, 60) || href.slice(0, 60), { href: href.slice(0, 120) }); continue; }
  if (!t || t.length > 60 || !ACT.test(t)) continue;
  const r = el.getBoundingClientRect();
  add(el, 'action', t, { href: href ? href.slice(0, 120) : null, button_like: btnLike(el, r, getComputedStyle(el)) });
}
for (const f of document.querySelectorAll('form')) {
  const inputs = [...f.querySelectorAll('input, textarea, select')].filter(i => !/^(hidden|submit|button|checkbox|radio|search|reset|image)$/i.test(i.type || ''));
  if (!inputs.length || f.getAttribute('role') === 'search') continue;
  const hd = f.querySelector('h1, h2, h3, legend') || f.closest('section, div')?.querySelector('h2, h3');
  add(f, 'form', (hd?.innerText || inputs[0].name || 'form').replace(/\s+/g, ' ').trim().slice(0, 60), { fields: inputs.length });
}
out.sort((a, b) => a.box[1] - b.box[1]);
const fits = (o, f) => o.region !== 'footer' && o.covered !== true && (o.fixed === 'fixed' ? (o.anchor === 'bottom' || o.box[1] + o.box[3] <= f) : o.box[1] >= 0 && o.box[1] + o.box[3] <= f);
const first_screen = {};
for (const f of FOLDS) {
  const vis = out.filter(o => fits(o, f));
  first_screen[f] = {
    action: vis.some(o => o.kind === 'action' || o.kind === 'form'),
    outside_header: vis.some(o => (o.kind === 'action' || o.kind === 'form') && o.region !== 'header'),
    buttons: vis.filter(o => o.kind === 'action' && o.button_like).map(o => o.text),
    links: vis.filter(o => o.kind === 'action' && !o.button_like).map(o => o.text),
    forms: vis.filter(o => o.kind === 'form').length,
    contacts: vis.filter(o => o.kind === 'call' || o.kind === 'messenger').map(o => o.href),
    covered: out.filter(o => o.covered === true && o.region !== 'footer' && o.box[1] + o.box[3] <= f).map(o => o.text),
  };
}
const ysOf = kinds => out.filter(o => kinds.includes(o.kind) && !o.fixed && o.region !== 'footer' && o.box[1] < footTop).map(o => o.box[1]);
const gap = ys => { let max = 0, from = 0, prev = 0; for (const y of [...ys, footTop]) { if (y - prev > max) { max = y - prev; from = prev; } prev = Math.max(prev, y); } return [+(max / SCREEN).toFixed(1), from]; };
const ys = ysOf(['action', 'form']), ysc = ysOf(['action', 'form', 'call', 'messenger']);
const [g1, g1y] = gap(ys), [g2, g2y] = gap(ysc);
const last = ys.length ? ys[ys.length - 1] : null;
return {
  width: W, vh: VH, screen_px: SCREEN, doc_height: H, screens: +(H / SCREEN).toFixed(1), footer_found: !!foot, footer_top: footTop,
  first_screen,
  sticky_action: out.filter(o => o.fixed && o.kind === 'action' && o.region !== 'footer').map(o => o.text),
  sticky_contact: out.filter(o => o.fixed && (o.kind === 'call' || o.kind === 'messenger')).map(o => o.href),
  max_gap_screens: g1, max_gap_from_y: g1y, max_gap_screens_with_contacts: g2, max_gap_with_contacts_from_y: g2y,
  last_action_y: last, screens_from_last_action_to_footer: last === null ? null : +((footTop - last) / SCREEN).toFixed(1),
  counts: { action: out.filter(o => o.kind === 'action').length, form: out.filter(o => o.kind === 'form').length,
    call: out.filter(o => o.kind === 'call').length, messenger: out.filter(o => o.kind === 'messenger').length },
  items: out.slice(0, 40),
};
