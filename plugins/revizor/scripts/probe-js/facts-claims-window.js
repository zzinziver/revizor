// Revizor built-in probe facts-claims-window.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/facts-claims-window.js" --no-shot
// "Free / 0 % / 24/7 / no fee / from X" claims with ±250 chars around each: visible text, collapsed or hidden text, JSON-LD
const claim = /(?<![\p{L}\d])(бесплатн\p{L}*|0\s?%|0\s?₽|без\s+комисси\p{L}*|без\s+переплат\p{L}*|без\s+скрытых\s+\p{L}+|24\s?\/\s?7|круглосуточн\p{L}*|№\s?1|номер\s+один|гарантир\p{L}*|от\s+\d[\d\s ]*(?:[.,]\d+)?\s?(?:₽|руб\p{L}*|%|\$|€)|free|no fee)/giu;
const cond = /(\*|при\s+условии|если\s|кроме|только\s+(?:при|для|в|до|с|по)\s|при\s+(?:оплате|заказе|покупке|подключении|пополнении|сумме)|на\s+условиях|условия\s+(?:акции|тарифа|предложения)|подробн\p{L}*\s+(?:в|на)\s|годовых|terms apply|conditions apply|only (?:for|when|if))/iu;
const textOf = root => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT); let x = ''; for (let n = w.nextNode(); n; n = w.nextNode()) x += ' ' + n.nodeValue; return x; };
const texts = [['visible', document.body.innerText || '']];
const hidden = [...document.querySelectorAll('details:not([open]), [hidden], [aria-hidden=true]')].map(textOf).join(' ');
if (hidden.trim()) texts.push(['collapsed_or_hidden', hidden]);
const ld = [...document.querySelectorAll('script[type="application/ld+json"]')].map(s => s.textContent || '').join(' ');
if (ld.trim()) texts.push(['json-ld', ld]);
const hits = [];
for (const [src, t] of texts) {
  const s = t.replace(/\s+/g, ' ');
  for (const m of s.matchAll(claim)) {
    const a = Math.max(0, m.index - 250), b = Math.min(s.length, m.index + m[0].length + 250);
    const win = s.slice(a, b);
    const rest = win.slice(0, m.index - a) + ' ' + win.slice(m.index - a + m[0].length);
    const cm = rest.match(cond);
    hits.push({ src, claim: m[0], condition_hint: cm ? cm[0] : null, window: win });
    if (hits.length >= 60) break;
  }
}
return { total: hits.length, without_condition_hint: hits.filter(h => !h.condition_hint).length, hits };
