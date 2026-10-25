// Revizor built-in probe a11y-focus-ring.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/a11y-focus-ring.js" --no-shot
// focus ring check without key presses: focus each visible control from script and compare its look with and without focus
const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && +s.opacity > 0.05; };
const name = e => e.id ? '#' + e.id : e.tagName.toLowerCase() + [...e.classList].slice(0, 2).map(c => '.' + c).join('');
const PROPS = ['outlineStyle', 'outlineWidth', 'outlineColor', 'outlineOffset', 'boxShadow', 'borderTopColor', 'borderBottomColor', 'borderBottomWidth', 'backgroundColor', 'color', 'textDecorationLine'];
const look = e => { const s = getComputedStyle(e); const o = {}; for (const p of PROPS) o[p] = s[p]; return o; };
const ringOn = o => o.outlineStyle !== 'none' && parseFloat(o.outlineWidth) > 0;
const SEL = 'a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex]:not([tabindex="-1"])';
const els = [...document.querySelectorAll(SEL)].filter(e => vis(e) && !e.disabled && !e.closest('[inert], [aria-hidden=true]')).slice(0, 60);
const prev = document.activeElement;
const rows = [];
for (const e of els) {
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  const before = look(e);
  e.focus({ preventScroll: true });
  if (document.activeElement !== e) { rows.push({ el: name(e), focused: false }); continue; }
  for (const a of e.getAnimations ? e.getAnimations() : []) { try { a.finish(); } catch (err) { /* infinite animation */ } }
  const after = look(e), fv = e.matches(':focus-visible');
  const changed = PROPS.filter(p => before[p] !== after[p]);
  const visible = (ringOn(after) && (!ringOn(before) || changed.some(p => p.startsWith('outline')))) || changed.some(p => !p.startsWith('outline'));
  rows.push({ el: name(e), text: (e.innerText || e.value || e.getAttribute('aria-label') || '').trim().slice(0, 30), focused: true, focus_visible: fv, visible, changed });
  e.blur();
}
if (prev && prev.focus) prev.focus({ preventScroll: true });
const focused = rows.filter(r => r.focused);
return { checked: rows.length, focused: focused.length, focus_visible_matched: focused.filter(r => r.focus_visible).length,
  ring_visible: focused.filter(r => r.visible).length, no_ring: focused.filter(r => !r.visible).map(r => r.el + (r.text ? ' «' + r.text + '»' : '')).slice(0, 15),
  how: 'el.focus() из скрипта; :focus-visible срабатывает как после Tab, пока не было касания или клика мышью' };
