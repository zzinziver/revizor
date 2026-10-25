// Revizor built-in probe product-block-anchors.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/product-block-anchors.js" --no-shot
// Blocks that can be sent as a link: does each visible H2 have an id nearby (own, wrapper, or an anchor right before it)
const idNear = h => {
  if (h.id) return h.id;
  for (let n = h.parentElement, d = 0; n && n !== document.body && d < 6; n = n.parentElement, d++) {
    if (n.id && n.getBoundingClientRect().height < innerHeight * 8) return n.id;
    const p = n.previousElementSibling;
    if (p && p.tagName === 'A' && p.getAttribute('name')) return p.getAttribute('name');
    if (p && p.id && p.getBoundingClientRect().height < 5) return p.id;
  }
  return null;
};
const blocks = [];
for (const h of document.querySelectorAll('h2')) {
  const r = h.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) continue;
  const id = idNear(h);
  blocks.push({ heading: (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60), id, generated: id ? /\d{4,}/.test(id) : null, y: Math.round(r.top + scrollY) });
  if (blocks.length >= 40) break;
}
return { total: blocks.length, with_id: blocks.filter(b => b.id).length, readable_id: blocks.filter(b => b.id && !b.generated).length, blocks };
