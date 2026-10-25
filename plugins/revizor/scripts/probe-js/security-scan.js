// Revizor built-in probe security-scan.js: the body of an async function (result via return; ARGS = --js-args JSON, {} by default).
// Run: node "<ROOT>/scripts/probe.mjs" --run "<RUN>" --pid <pid> --width 1440 --js "<ROOT>/scripts/probe-js/security-scan.js" --no-shot
// inline code, state blobs, comments, attributes and hidden or collapsed text: secrets (masked), internal hosts,
// text aimed at AI. Reads the DOM only: no network. Secrets in external script files come from headers.json → secrets[].
const PAT = [
  ['aws-key', /AKIA[0-9A-Z]{16}/g], ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['stripe-secret', /sk_live_[0-9a-zA-Z]{20,}/g], ['slack-token', /xox[abprs]-[0-9A-Za-z-]{10,}/g],
  ['github-token', /gh[pousr]_[0-9A-Za-z]{30,}/g], ['telegram-bot-token', /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g],
  ['jwt', /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ['generic-secret', /["'](?:secret|client_secret|api_secret|private_key|access_token|auth_token|password|passwd)["']\s*[:=]\s*["']([^"'\s]{12,})["']/gi],
  ['internal-host', /(?:https?:)?\/\/(?:localhost|127\.0\.0\.1|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|[a-z0-9-]+\.(?:local|internal|lan))(?::\d+)?/gi],
  ['public-google-key', /AIza[0-9A-Za-z_-]{35}/g],
];
const PLACEHOLDER = /placeholder|example|sample|dummy|changeme|your[_-]?|xxxx|\*\*\*\*|^<|^\{\{|^\$\{|process\.env/i;
// commands to AI only; plain mentions of AI or neural networks are not matched
const AI = /(ignore (?:all )?(?:the )?(?:previous|prior|above) instructions|disregard (?:all )?(?:the )?(?:previous|prior|above) instructions|\bAI (?:agents?|assistants?|models?)\s*:|\bif you are an? (?:AI|LLM|language model)\b|(?:игнорируй|не обращай\p{L}* внимани\p{L}* на)\p{L}*\s+(?:(?:все|всё|любые)\s+(?:(?:предыдущ|прошл|прежн|ранее|системн)\p{L}*\s+)?|(?:предыдущ|прошл|прежн|ранее|системн)\p{L}*\s+)(?:инструкци|указани|правил|промпт)|инструкци\p{L}* для (?:ИИ|нейросет\p{L}*|ассистент\p{L}*|бот\p{L}*|языков\p{L}* модел\p{L}*)|(?:ИИ|AI)[- ]?(?:агент|ассистент)\p{L}*\s*:|если ты (?:ИИ|нейросеть|языковая модель|ассистент|бот)(?!\p{L}))/iu;
const mask = v => v.slice(0, 4) + '***';
const jwtInfo = t => {
  try {
    const p = JSON.parse(atob(t.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    let iss = null; try { iss = p.iss ? new URL(p.iss).host : null; } catch (e) { iss = null; }
    return { role: p.role || null, iss_host: iss, public: ['anon', 'public', 'anonymous'].includes(String(p.role || '').toLowerCase()) };
  } catch (e) { return { role: null, iss_host: null, public: false }; }
};
const hits = []; let placeholders = 0;
const scan = (text, where) => {
  for (const [id, re] of PAT) {
    re.lastIndex = 0;
    const all = [...text.matchAll(re)];
    if (!all.length) continue;
    if (id === 'generic-secret') {
      const real = all.filter(m => !PLACEHOLDER.test(m[1]));
      placeholders += all.length - real.length;
      if (real.length) hits.push({ id, where, count: real.length, length: real[0][1].length, mask: mask(real[0][1]), conf_max: 7 });
    } else if (id === 'jwt') {
      for (const m of all.slice(0, 5)) hits.push({ id, where, count: 1, length: m[0].length, mask: mask(m[0]), ...jwtInfo(m[0]) });
    } else if (id === 'internal-host') {
      hits.push({ id, where, count: all.length, host: all[0][0].replace(/^(?:https?:)?\/\//, '').slice(0, 40) });
    } else hits.push({ id, where, count: all.length, length: all[0][0].length, mask: mask(all[0][0]), public: id === 'public-google-key' });
  }
};
const inline = [...document.scripts].filter(s => !s.src && !/json/i.test(s.type || '')).map(s => s.textContent || '').join('\n');
scan(inline.slice(0, 1500000), 'inline');
const own = [...document.scripts].map(s => s.src).filter(u => { try { return u && new URL(u).origin === location.origin; } catch (e) { return false; } });
const state_blobs = [];
for (const [name, txt] of [['__NEXT_DATA__', (document.getElementById('__NEXT_DATA__') || {}).textContent], ['__NUXT__', window.__NUXT__ ? JSON.stringify(window.__NUXT__) : null], ['__INITIAL_STATE__', window.__INITIAL_STATE__ ? JSON.stringify(window.__INITIAL_STATE__) : null]]) {
  if (!txt) continue;
  scan(txt.slice(0, 1500000), name);
  state_blobs.push({ name, bytes: txt.length, emails: (txt.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).length, phones: (txt.match(/\+?\d[\d\s()-]{9,}\d/g) || []).length });
}
// where the text sits: closed <details> or accordion/tab panel = collapsed (the visitor opens it), otherwise hidden
const PANEL = /accordion|collapse|faq|spoiler|tab-?pane|tabs?__panel/i;
const collapsedBy = el => {
  for (let a = el; a && a !== document.body; a = a.parentElement) {
    if (a.tagName === 'DETAILS' && !a.open && !(el.closest('summary') && el.closest('details') === a)) return true;
    if (a.getAttribute('role') === 'tabpanel' || PANEL.test(typeof a.className === 'string' ? a.className : '')) return true;
    if (a.id && document.querySelector('[aria-controls~="' + CSS.escape(a.id) + '"]')) return true;
  }
  return false;
};
const where = el => {
  const vis = el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true;
  const r = el.getBoundingClientRect();
  const shown = vis && r.width >= 2 && r.height >= 2 && r.right >= 0 && r.left <= innerWidth + 2000;
  if (shown) return 'видимый текст';
  return collapsedBy(el) ? 'свёрнуто' : 'скрыто';
};
const ai_text = [];
const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
let n;
while ((n = walker.nextNode()) && ai_text.length < 10) {
  const t = (n.nodeValue || '').trim();
  const el = n.parentElement;
  if (t.length < 8 || !el || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
  if (AI.test(t)) ai_text.push({ where: where(el), el: el.tagName.toLowerCase(), quote: t.split(/\s+/).slice(0, 15).join(' ') });
}
for (const el of document.querySelectorAll('[alt],[title],[aria-label],meta[content]')) {
  if (ai_text.length >= 12) break;
  for (const at of ['alt', 'title', 'aria-label', 'content']) {
    const t = el.getAttribute(at);
    if (t && t.length >= 8 && AI.test(t)) ai_text.push({ where: 'атрибут ' + at, el: el.tagName.toLowerCase(), quote: t.split(/\s+/).slice(0, 15).join(' ') });
  }
}
const cw = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
const comments = [];
while ((n = cw.nextNode())) {
  const t = (n.nodeValue || '').trim();
  comments.push(t);
  if (ai_text.length < 14 && AI.test(t)) ai_text.push({ where: 'HTML-комментарий', el: null, quote: t.split(/\s+/).slice(0, 15).join(' ') });
}
scan(comments.join('\n').slice(0, 300000), 'comments');
return { inline_bytes: inline.length, own_script_files: own.length, hits, placeholders_skipped: placeholders, state_blobs, ai_text };
