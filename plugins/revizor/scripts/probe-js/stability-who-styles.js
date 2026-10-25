// Revizor built-in probe stability-who-styles.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/stability-who-styles.js" --no-shot
// which CSS rules match the first element for TARGET (TARGET from --js-args '{"target":"<selector>"}'); rules inside @media are listed too
const TARGET = ARGS.target || 'header nav a';
const el = document.querySelector(TARGET);
if (!el) return { error: 'no element for ' + TARGET };
const rules = []; let crossOrigin = 0;
const walk = list => {
  for (const r of list) {
    if (r.cssRules && !r.selectorText) { walk(r.cssRules); continue; }
    if (!r.selectorText) continue;
    let hit = false;
    try { hit = el.matches(r.selectorText); } catch (e) {}
    if (hit) rules.push({ selector: r.selectorText.slice(0, 120), css: r.style.cssText.slice(0, 160),
      sheet: r.parentStyleSheet && r.parentStyleSheet.href ? r.parentStyleSheet.href.split('?')[0].split('/').pop() : 'inline' });
  }
};
for (const sh of document.styleSheets) { try { walk(sh.cssRules); } catch (e) { crossOrigin++; } }
const cs = getComputedStyle(el);
return { target: TARGET, rules: rules.slice(-30), cross_origin_sheets: crossOrigin,
  computed: { text_decoration: cs.textDecorationLine, color: cs.color, display: cs.display, font_size: cs.fontSize } };
