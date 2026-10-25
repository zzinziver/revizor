// Revizor built-in probe product-urgency.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/product-urgency.js" --no-shot
// Urgency texts (timers, "N left", "offer ends") with their numbers: run twice and compare
const re = /(осталось|осталась|остался|последн|только сегодня|до конца акции|акция до|успей|успейте|мест[ао]? остал|человек смотр|сейчас смотр|купили|заказали|left|only \d|ends in|hurry|people (are )?viewing)/i;
const out = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
for (let el = walker.nextNode(); el; el = walker.nextNode()) {
  if (el.children.length > 3) continue;
  const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
  if (!t || t.length > 160 || !re.test(t)) continue;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) continue;
  if (out.some(o => o.text.includes(t) || t.includes(o.text))) continue;
  out.push({ text: t, numbers: (t.match(/\d+([.,:]\d+)*/g) || []).slice(0, 6), y: Math.round(r.top + scrollY) });
}
const timers = [...document.querySelectorAll('[class*=timer i], [class*=countdown i], [id*=timer i], [id*=countdown i]')].slice(0, 5)
  .map(el => ({ sel: el.id ? '#' + el.id : el.className, text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) }));
return { at: new Date().toISOString(), found: out.slice(0, 20), timers };
