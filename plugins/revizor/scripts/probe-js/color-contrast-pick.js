// Revizor built-in probe color-contrast-pick.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/color-contrast-pick.js" --no-shot
// WCAG 2.x ratio for colour pairs; nearest passing text colour and nearest passing background (same hue, lightness only); APCA Lc (lc) for color-39
const PAIRS = ARGS.pairs || [ ['#9a9a9a', '#ffffff', 4.5], ['#ffffff', '#f59e0b', 4.5], ['rgb(194, 194, 194)', 'rgba(255, 255, 255, 1)', 3] ]; // [text, background, norm] — pass your own with --js-args '{"pairs":[…]}'
// '#rgb', '#rrggbb', '#rrggbbaa', 'rgb(r, g, b)', 'rgba(r, g, b, a)', 'rgb(r g b / a)'; alpha is ignored (opaque colours only)
const hex2 = c => { c = String(c).trim().toLowerCase(); const m = c.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/);
  if (m) return [m[1], m[2], m[3]].map(v => Math.max(0, Math.min(255, Math.round(+v))));
  let h = c.replace('#', ''); if (h.length === 3 || h.length === 4) h = [...h.slice(0, 3)].map(x => x + x).join(''); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16)); };
const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
const ratio = (a, b) => { const x = lum(a), y = lum(b); return Math.floor(((Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)) * 100) / 100; };
const toHsl = ([r, g, b]) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2; let h = 0, s = 0;
  if (mx !== mn) { const d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h /= 6; } return [h, s, l]; };
const toRgb = ([h, s, l]) => { if (!s) return [l, l, l].map(v => Math.round(v * 255)); const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; }; return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255)); };
const hex = c => '#' + c.map(v => v.toString(16).padStart(2, '0')).join('');
// APCA-W3 0.0.98G, same as contrast.json → items[].apca: negative for light text on a darker background
const lc = (t, b) => { const Y = ([r, g, bl]) => 0.2126729 * (r / 255) ** 2.4 + 0.7151522 * (g / 255) ** 2.4 + 0.0721750 * (bl / 255) ** 2.4; const cl = y => (y > 0.022 ? y : y + (0.022 - y) ** 1.414);
  const yt = cl(Y(t)), yb = cl(Y(b)); if (Math.abs(yb - yt) < 0.0005) return 0; let o; if (yb > yt) { const v = (yb ** 0.56 - yt ** 0.57) * 1.14; o = v < 0.1 ? 0 : v - 0.027; } else { const v = (yb ** 0.65 - yt ** 0.62) * 1.14; o = v > -0.1 ? 0 : v + 0.027; } return Math.round(o * 1000) / 10; };
// move colour c away from the other colour in lightness until the pair passes
const nearest = (c, other, norm) => { const [h, s, l] = toHsl(c); const dir = lum(c) >= lum(other) ? 1 : -1;
  for (let k = 1; k <= 100; k++) { const n = toRgb([h, s, Math.min(1, Math.max(0, l + dir * k / 100))]); if (ratio(n, other) >= norm) return { hex: hex(n), ratio: ratio(n, other) }; } return null; };
return PAIRS.map(([fg, bg, norm]) => {
  const F = hex2(fg), B = hex2(bg);
  if ([...F, ...B].some(Number.isNaN)) return { fg, bg, error: 'цвет не разобран: нужен #rrggbb, #rgb или rgb()' };
  const now = ratio(F, B);
  return now >= norm ? { fg, bg, fg_hex: hex(F), bg_hex: hex(B), ratio: now, norm, pass: true, lc: lc(F, B) } : { fg, bg, fg_hex: hex(F), bg_hex: hex(B), ratio: now, norm, pass: false, lc: lc(F, B), new_text: nearest(F, B, norm), new_background: nearest(B, F, norm) };
});
