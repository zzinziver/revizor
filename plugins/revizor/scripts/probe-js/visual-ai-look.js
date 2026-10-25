// Revizor built-in probe visual-ai-look.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/visual-ai-look.js" --no-shot
// template-look signs of the loaded page (visual-52): fonts, palette hints, glass, bento, soft cards, icon rows, chips, emoji, icon sets, glow, centred sections, blobs
const vis = e => { const r = e.getBoundingClientRect(), s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && +s.opacity > 0.05; };
const name = e => e.id ? '#' + e.id : e.tagName.toLowerCase() + [...e.classList].filter(c => c.length < 40).slice(0, 2).map(c => '.' + c).join('');
const txt = e => (e.innerText || '').replace(/\s+/g, ' ').trim();
const rgb = c => { const m = /rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/.exec(c || ''); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null; };
const hsl = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; } return [Math.round(h), +s.toFixed(2), +l.toFixed(2)]; };
const hex = c => '#' + c.slice(0, 3).map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
// colour families a generator tends to pick (rough HSL boxes; the agent checks them on the shot)
const family = c => { const [h, s, l] = hsl(c);
  if (l >= 0.86 && l < 0.98 && s >= 0.15 && h >= 25 && h <= 55) return 'cream';
  if (l < 0.09) return 'near-black';
  if (h >= 200 && h <= 240 && s >= 0.3 && l >= 0.1 && l <= 0.32) return 'navy';
  if ((h <= 18 || h >= 350) && s >= 0.55 && l >= 0.55 && l <= 0.75) return 'coral';
  if (h >= 30 && h <= 48 && s >= 0.7 && l >= 0.45 && l <= 0.62) return 'amber';
  if (h >= 8 && h <= 28 && s >= 0.35 && s <= 0.75 && l >= 0.35 && l <= 0.58) return 'terracotta';
  if (h >= 55 && h <= 90 && s >= 0.15 && s <= 0.5 && l >= 0.25 && l <= 0.5) return 'olive';
  if (h >= 90 && h <= 160 && s >= 0.08 && s <= 0.3 && l >= 0.5 && l <= 0.75) return 'sage';
  if (s >= 0.8 && l >= 0.45 && l <= 0.7 && ((h >= 75 && h <= 190) || (h >= 280 && h <= 330))) return 'neon';
  if (h >= 230 && h <= 290 && s >= 0.45 && l >= 0.3 && l <= 0.7) return 'violet-blue';
  return null; };
const all = [...document.querySelectorAll('body *')].filter(vis);
const css = e => getComputedStyle(e);
// fonts by role and the list of default picks (strict D3 + typography-36)
const DEFAULT = /^(inter|inter tight|manrope|montserrat|unbounded|golos|golos text|golos ui|onest|roboto|roboto flex|rubik|nunito|nunito sans|space grotesk|ibm plex sans|ibm plex mono|ibm plex serif|geist|geist mono|jetbrains mono|plus jakarta sans|dm sans|poppins|playfair display)$/i;
const first = f => String(f || '').split(',')[0].replace(/["']/g, '').trim();
const roleFont = (sel, min = 0) => { const e = [...document.querySelectorAll(sel)].find(x => vis(x) && txt(x).length >= min); return e ? first(css(e).fontFamily) : null; };
const fonts = { h1: roleFont('h1'), h2: roleFont('h2'), text: (() => { const p = [...document.querySelectorAll('p, li')].filter(vis).sort((x, y) => txt(y).length - txt(x).length)[0]; return p ? first(css(p).fontFamily) : null; })(), button: roleFont('button, a[class*=btn i]') };
const fonts_default = [...new Set(Object.values(fonts).filter(f => f && DEFAULT.test(f)))];
const serifHead = /serif/i.test(css(document.querySelector('h1, h2') || document.body).fontFamily) && !/sans-serif/i.test(css(document.querySelector('h1, h2') || document.body).fontFamily);
// small monospaced caps (eyebrows, labels)
const monoCaps = all.filter(e => { const s = css(e), t = txt(e); return t && t.length <= 40 && !e.children.length && parseFloat(s.fontSize) <= 15 && /mono|courier|consolas|menlo/i.test(s.fontFamily) && (s.textTransform === 'uppercase' || (t === t.toUpperCase() && /\p{Lu}/u.test(t))); });
// glass: backdrop-filter blur
const glass = all.filter(e => /blur/.test(css(e).backdropFilter || css(e).webkitBackdropFilter || ''));
// bento: a grid with ≥ 4 items of ≥ 3 different sizes
const bento = all.filter(e => { if (css(e).display !== 'grid') return false; const k = [...e.children].filter(vis); if (k.length < 4) return false;
  const sizes = new Set(k.map(c => { const r = c.getBoundingClientRect(); return Math.round(r.width / 20) + 'x' + Math.round(r.height / 20); })); return sizes.size >= 3; });
// soft cards: radius ≥ 16 px with a soft wide shadow, ≥ 3 siblings alike
const soft = e => { const s = css(e), r = parseFloat(s.borderTopLeftRadius) || 0; const m = /(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/.exec(s.boxShadow || '');
  const a = rgb(s.boxShadow); return r >= 16 && m && +m[3] >= 10 && (!a || a[3] <= 0.2); };
const softRows = [...new Set(all.filter(soft).map(e => e.parentElement))].filter(p => p && [...p.children].filter(soft).length >= 3);
// rows of 3–4 alike blocks, each: small icon (svg/img ≤ 72 px) + heading + ≤ 200 chars
const iconCard = c => { const ic = c.querySelector('svg, img'); if (!ic) return false; const r = ic.getBoundingClientRect(); const h = c.querySelector('h3, h4, h5, strong, b');
  return r.width > 0 && r.width <= 72 && r.height <= 72 && h && txt(c).length <= 200; };
const iconRows = all.filter(e => { const k = [...e.children].filter(vis); return k.length >= 3 && k.length <= 4 && k.every(iconCard); });
// chip above H1: short pill right before the H1 (same parent or the parent's previous block)
const h1 = [...document.querySelectorAll('h1')].find(vis);
let chip = null;
if (h1) { const cands = [h1.previousElementSibling, h1.parentElement && h1.parentElement.previousElementSibling].filter(Boolean);
  for (const c of cands) { const e = [c, ...c.querySelectorAll('*')].find(x => vis(x) && txt(x) && txt(x).length <= 40 && (() => { const s = css(x), r = x.getBoundingClientRect();
    return (parseFloat(s.borderTopLeftRadius) || 0) >= r.height / 2 - 1 && (rgb(s.backgroundColor)?.[3] > 0 || parseFloat(s.borderTopWidth) > 0); })());
    if (e) { chip = { selector: name(e), text: txt(e) }; break; } } }
// emoji as icons: at the start of headings, buttons, list items, short labels
const EMO = /^\s*(\p{Extended_Pictographic}|\p{Regional_Indicator})/u;
const emoji = all.filter(e => /^(H[1-6]|BUTTON|A|LI|SPAN|DIV|P|STRONG)$/.test(e.tagName) && txt(e).length <= 80 && [...e.childNodes].some(n => n.nodeType === 3 && EMO.test(n.nodeValue)));
// stock outline icon sets: library classes / data attributes, or the typical 24×24 stroke-only svg
const LIB = /(lucide|heroicon|feather|tabler|phosphor|ph-|bi-|ionicon|material-symbols|fa-)/i;
const svgs = [...document.querySelectorAll('svg')].filter(vis);
const libs = {}; for (const s of svgs) { const m = LIB.exec((s.getAttribute('class') || '') + ' ' + [...s.attributes].map(a => a.name).join(' ')); if (m) libs[m[1].toLowerCase()] = (libs[m[1].toLowerCase()] || 0) + 1; }
const outline24 = svgs.filter(s => s.getAttribute('viewBox') === '0 0 24 24' && (s.getAttribute('fill') === 'none' || css(s).fill === 'none') && /round/.test((s.getAttribute('stroke-linecap') || '') + css(s).strokeLinecap)).length;
// glow and gradient borders
const glow = all.filter(e => { const s = css(e); const m = /(rgba?\([^)]*\))\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/.exec(s.boxShadow || '') || /(rgba?\([^)]*\))\s+(-?\d+(?:\.\d+)?)px\s+(-?\d+(?:\.\d+)?)px\s+(\d+(?:\.\d+)?)px/.exec(s.textShadow || '');
  if (!m || +m[4] < 24) return false; const c = rgb(m[1]); return c && hsl(c)[1] >= 0.5 && c[3] >= 0.25; });
const gradBorder = all.filter(e => { const s = css(e); return /gradient/.test(s.borderImageSource || '') || (/gradient/.test(s.backgroundImage) && /border-box/.test(s.backgroundOrigin + s.backgroundClip) && /padding-box/.test(s.backgroundClip)) || /gradient/.test(s.maskImage || s.webkitMaskImage || '') && /exclude|xor/.test(s.maskComposite || s.webkitMaskComposite || ''); });
// centred sections: centred heading + following grey text + grid/flex of ≥ 3 blocks
const sections = [...document.querySelectorAll('section, main > div, [class*=section i]')].filter(e => vis(e) && e.getBoundingClientRect().height >= 200);
const centred = sections.filter(s => { const h = s.querySelector('h2'); if (!h || !vis(h) || css(h).textAlign !== 'center') return false;
  const grid = [...s.querySelectorAll('*')].find(x => vis(x) && /grid|flex/.test(css(x).display) && [...x.children].filter(vis).length >= 3 && x.getBoundingClientRect().top > h.getBoundingClientRect().bottom);
  return !!grid; });
// first screen: gradient backgrounds and their colour families; decorative blobs
const fold = all.filter(e => e.getBoundingClientRect().top < innerHeight);
const foldGrad = fold.filter(e => /gradient/.test(css(e).backgroundImage)).map(e => ({ selector: name(e), families: [...new Set((css(e).backgroundImage.match(/rgba?\([^)]*\)/g) || []).map(rgb).filter(Boolean).map(family).filter(Boolean))] })).slice(0, 6);
const blobs = all.filter(e => { const s = css(e), r = e.getBoundingClientRect(); return !txt(e) && r.width >= 120 && /blur\((\d+)/.test(s.filter) && +/blur\((\d+)/.exec(s.filter)[1] >= 30; }).length;
// palette: page background, surfaces by area, accent = backgrounds of buttons
const area = new Map(); for (const e of [document.documentElement, document.body, ...all]) { const c = rgb(css(e).backgroundColor); if (!c || c[3] < 0.9) continue; const r = e.getBoundingClientRect(); const k = hex(c); area.set(k, (area.get(k) || 0) + r.width * r.height); }
const total = [...area.values()].reduce((a, b) => a + b, 0) || 1;
const surfaces = [...area].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([c, a]) => { const v = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; return { color: c, share: Math.round(a / total * 100), family: family(v) }; });
const btnBg = new Map(); for (const b of document.querySelectorAll('button, a[class*=btn i], a[class*=button i], [role=button]')) { if (!vis(b)) continue; const c = rgb(css(b).backgroundColor); if (c && c[3] > 0.5) btnBg.set(hex(c), family(c)); }
const ex = (list, n = 4) => list.slice(0, n).map(name);
return { width: innerWidth, fonts, fonts_default, serif_headings: serifHead,
  mono_caps: { count: monoCaps.length, ex: monoCaps.slice(0, 4).map(e => txt(e)) },
  glass: { count: glass.length, ex: ex(glass) }, bento: { count: bento.length, ex: ex(bento) },
  soft_card_rows: { count: softRows.length, ex: ex(softRows) }, icon_rows: { count: iconRows.length, ex: ex(iconRows) },
  chip_above_h1: chip, emoji_icons: { count: emoji.length, ex: emoji.slice(0, 4).map(e => txt(e).slice(0, 30)) },
  icon_sets: { libs, outline_24: outline24, svg_total: svgs.length }, glow: { count: glow.length, ex: ex(glow) }, gradient_borders: { count: gradBorder.length, ex: ex(gradBorder) },
  centred_sections: { count: centred.length, of: sections.length }, fold_gradients: foldGrad, blobs,
  surfaces, accents: [...btnBg].slice(0, 6).map(([color, fam]) => ({ color, family: fam })) };
