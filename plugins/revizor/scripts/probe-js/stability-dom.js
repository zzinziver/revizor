// Revizor built-in probe stability-dom.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/stability-dom.js" --no-shot
// head tags leaked into body, [hidden] shown, duplicate ids, scripts loaded twice, jQuery version, platform zoom
const q = s => Array.from(document.querySelectorAll(s));
const name = e => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
const out = {};
out.head_leaked = q('body meta[name], body meta[property], body meta[http-equiv], body meta[charset], body title, body link[rel~="canonical"], body link[rel~="icon"], body base')
  .filter(e => !e.closest('svg')).slice(0, 15).map(e => e.outerHTML.slice(0, 160));
out.titles = q('title').filter(e => !e.closest('svg')).length;
out.hidden_shown = q('[hidden]').filter(e => getComputedStyle(e).display !== 'none')
  .slice(0, 15).map(e => ({ el: name(e), display: getComputedStyle(e).display, text: (e.textContent || '').trim().slice(0, 60) }));
const ids = {};
for (const e of q('[id]')) ids[e.id] = (ids[e.id] || 0) + 1;
out.duplicate_ids = Object.entries(ids).filter(([, n]) => n > 1).slice(0, 20).map(([id, n]) => ({ id, n }));
const anchors = [...new Set(q('a[href^="#"]').map(a => a.getAttribute('href').slice(1)).filter(h => h && !/^[!/]/.test(h)))];
out.dead_anchors = anchors.filter(h => { try { return !document.getElementById(decodeURIComponent(h)); } catch (e) { return true; } }).slice(0, 20);
const byFile = {};
for (const s of q('script[src]')) { const f = s.src.split('?')[0].split('/').pop(); (byFile[f] = byFile[f] || []).push(s.src.slice(-120)); }
out.scripts_twice = Object.entries(byFile).filter(([, v]) => v.length > 1).map(([file, v]) => ({ file, n: v.length, src: v }));
out.jquery = window.jQuery && window.jQuery.fn ? window.jQuery.fn.jquery : null;
out.zoom = { html: getComputedStyle(document.documentElement).zoom, body: getComputedStyle(document.body).zoom };
return out;
