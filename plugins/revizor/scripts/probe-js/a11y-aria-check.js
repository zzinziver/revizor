// Revizor built-in probe a11y-aria-check.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/a11y-aria-check.js" --no-shot
// ARIA and semantics the automatic tools often miss: toggles, broken references, nested controls, groups, dialogs, headings vs buttons, iframes, live regions, clickable divs
const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
const name = e => e.id ? '#' + e.id : e.tagName.toLowerCase() + [...e.classList].slice(0, 2).map(c => '.' + c).join('');
const txt = e => (e.getAttribute('aria-label') || e.innerText || e.getAttribute('title') || '').trim().slice(0, 40);
const out = {};
out.toggles_without_expanded = [...document.querySelectorAll('button, [role=button]')].filter(e => vis(e) && /menu|бургер|burger|hamburger|nav|toggle|меню/i.test((e.className || '') + ' ' + txt(e) + ' ' + (e.getAttribute('aria-label') || '')) && !e.hasAttribute('aria-expanded')).map(name).slice(0, 10);
out.broken_refs = [];
for (const a of ['aria-controls', 'aria-labelledby', 'aria-describedby', 'for']) for (const e of document.querySelectorAll(`[${a}]`)) {
  const ids = (e.getAttribute(a) || '').split(/\s+/).filter(Boolean); const miss = ids.filter(id => !document.getElementById(id));
  if (miss.length && out.broken_refs.length < 15) out.broken_refs.push({ el: name(e), attr: a, missing: miss });
}
out.nested_interactive = [...document.querySelectorAll('a, button, [role=button], [role=link]')].filter(e => e.querySelector('a[href], button, input, select, textarea, [role=button], [tabindex]:not([tabindex="-1"])')).map(e => name(e) + ' «' + txt(e) + '»').slice(0, 10);
const groups = new Map(); for (const r of document.querySelectorAll('input[type=radio][name]')) { if (!groups.has(r.name)) groups.set(r.name, r); }
out.radio_groups_unnamed = [...groups].filter(([, r]) => { const fs = r.closest('fieldset'); const rg = r.closest('[role=radiogroup]'); return !(fs && fs.querySelector('legend')) && !(rg && (rg.getAttribute('aria-label') || rg.getAttribute('aria-labelledby'))); }).map(([n]) => n);
out.dialogs_unnamed = [...document.querySelectorAll('[role=dialog], [role=alertdialog], dialog')].filter(d => !d.getAttribute('aria-label') && !d.getAttribute('aria-labelledby')).map(name).slice(0, 10);
// a heading inside a button or link loses its heading role; a heading used as a button has no button role or no keyboard
out.heading_in_control = [...document.querySelectorAll('button h1, button h2, button h3, button h4, button h5, button h6, [role=button] :is(h1,h2,h3,h4,h5,h6), a[href] :is(h1,h2,h3,h4,h5,h6)')].filter(vis).map(h => name(h.closest('button, [role=button], a')) + ' > ' + h.tagName.toLowerCase() + ' «' + txt(h) + '»').slice(0, 10);
out.heading_as_button = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].filter(h => vis(h) && !h.querySelector('button, a[href]') && (h.getAttribute('role') === 'button' || h.hasAttribute('onclick') || getComputedStyle(h).cursor === 'pointer')).map(h => ({ el: name(h), text: txt(h), role: h.getAttribute('role'), tabindex: h.getAttribute('tabindex') })).slice(0, 10);
out.iframes_untitled = [...document.querySelectorAll('iframe')].filter(f => vis(f) && !(f.getAttribute('title') || '').trim() && !(f.getAttribute('aria-label') || '').trim() && f.getAttribute('aria-hidden') !== 'true').map(f => ({ el: name(f), src: (f.getAttribute('src') || '').slice(0, 80) })).slice(0, 10);
out.live_regions = document.querySelectorAll('[aria-live], [role=status], [role=alert], output').length;
out.clickable_without_role = [...document.querySelectorAll('div, span, li, img, svg')].filter(e => vis(e) && (e.hasAttribute('onclick') || getComputedStyle(e).cursor === 'pointer') && !e.closest('a, button, [role], label, summary') && !e.hasAttribute('tabindex') && !(e.parentElement && getComputedStyle(e.parentElement).cursor === 'pointer')).map(e => name(e) + ' «' + txt(e) + '»').slice(0, 12);
out.junk_alt = [...document.images].filter(i => /^(img|image|icon|photo|picture|картинка|изображение|фото|иконка|logo|\S+\.(jpe?g|png|webp|svg|gif))$/i.test((i.getAttribute('alt') || '').trim())).map(i => ({ src: (i.currentSrc || i.src).slice(-60), alt: i.getAttribute('alt') })).slice(0, 12);
out.focusable_in_aria_hidden = [...document.querySelectorAll('[aria-hidden=true] a[href], [aria-hidden=true] button, [aria-hidden=true] input, [aria-hidden=true] [tabindex]:not([tabindex="-1"])')].filter(vis).map(name).slice(0, 10);
out.positive_tabindex = [...document.querySelectorAll('[tabindex]')].filter(e => +e.getAttribute('tabindex') > 0).map(name).slice(0, 10);
out.autoplay_media = [...document.querySelectorAll('video[autoplay], audio[autoplay]')].map(m => ({ el: name(m), muted: m.muted, controls: m.controls, tracks: m.querySelectorAll('track').length }));
out.lang = document.documentElement.getAttribute('lang');
return out;
