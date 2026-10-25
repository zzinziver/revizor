// Revizor — parse HTML in the browser, not with regexps.
// parseHtml(browser|page, html, baseUrl) runs DOMParser:
//   · given a Browser — in our own blank tab with scripts disabled (Emulation.setScriptExecutionDisabled);
//   · given a live Page of a site — in an isolated world (Page.createIsolatedWorld): the site's scripts cannot
//     replace DOMParser, URL or prototypes there, so they cannot fake the result.
// A DOMParser document is inert: no scripts run, nothing is fetched.
//
//   import { Browser } from './cdp.mjs';  import { parseHtml, closeDomTab } from './dom.mjs';
//   const b = await Browser.launch();  const d = await parseHtml(b, rawHtml, 'https://example.com/');  await closeDomTab(b); await b.close();
//
// → { base_url, title, titles_count, lang, dir, charset, viewport, meta {key→content (first)}, meta_list [{key, content}],
//     robots, robots_bots {googlebot, yandex…}, canonical, canonicals [], alternates [{hreflang, href}], link_tags [{rel, href, …}],
//     headings [{level, text, id, hidden}], h1 [] (all), h1_visible [] (without hidden ones),
//     links [{href, raw, text, rel, target, title, aria_label, internal, in, hidden}],
//     jsonld [{raw, parsed, error, types}], images [{src, raw_src, data_src, srcset, sizes, alt, width, height, loading, decoding, fetchpriority, in_link, in, hidden}],
//     forms [{action, method, method_set, id, name, enctype, novalidate, target, fields [...], submits [...], in, hidden}],
//     fields_outside_forms [...], iframes [], scripts [], inline_scripts {count, bytes}, stylesheets [], comments [],
//     text (visible text without script/style/noscript/template/svg and hidden elements), text_length, word_count, text_truncated,
//     counts { …, h1, h1_visible } }
// `alt: null` = no attribute, `alt: ""` = empty attribute. `in`: header|nav|main|footer|aside|other (nearest landmark).
// `hidden` is known only from markup: the hidden attribute, <template>/<noscript>, display:none or visibility:hidden in the
// style attribute. A class that hides an element (display:none in a stylesheet) is NOT seen here — use the live page for that.

const MAX_HTML = 15 * 1024 * 1024;
const LIMITS = { links: 5000, images: 2000, forms: 100, jsonld: 200000, text: 2000000, scripts: 400, comments: 100 };
const TABS = new WeakMap(); // browser → its parsing tab

// Runs inside the page. Must stay self-contained (it is serialized into Runtime.evaluate).
function parseInPage(html, baseUrl, limits) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  let base = baseUrl || '';
  const baseEl = doc.querySelector('base[href]');
  if (baseEl) { try { base = new URL(baseEl.getAttribute('href'), baseUrl || undefined).href; } catch (e) { /* keep page url */ } }
  const abs = v => { if (v === null || v === undefined) return null; v = String(v).trim(); if (!v) return ''; try { return new URL(v, base || undefined).href; } catch (e) { return v; } };
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const attr = (el, n) => (el.hasAttribute(n) ? el.getAttribute(n) : null);
  const host = (() => { try { return new URL(base).hostname.replace(/^www\./, ''); } catch (e) { return ''; } })();
  const hiddenStyle = el => /(^|;)\s*(display\s*:\s*none|visibility\s*:\s*hidden)/i.test(el.getAttribute('style') || '');
  const isHidden = el => {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const t = e.tagName.toUpperCase();
      if (e.hasAttribute('hidden') || hiddenStyle(e) || t === 'TEMPLATE' || t === 'NOSCRIPT') return true;
    }
    return false;
  };
  const LANDMARK = { banner: 'header', navigation: 'nav', main: 'main', contentinfo: 'footer', complementary: 'aside' };
  const region = el => {
    const r = el.closest('header,nav,main,footer,aside,[role=banner],[role=navigation],[role=main],[role=contentinfo],[role=complementary]');
    if (!r) return 'other';
    const role = r.getAttribute('role');
    return (role && LANDMARK[role]) || r.tagName.toLowerCase();
  };

  // meta
  const meta = {}, metaList = [];
  let charset = null;
  for (const m of doc.querySelectorAll('meta')) {
    if (m.hasAttribute('charset')) { charset = charset || m.getAttribute('charset'); continue; }
    const key = (m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('http-equiv') || m.getAttribute('itemprop') || '').trim().toLowerCase();
    if (!key) continue;
    const content = m.getAttribute('content') ?? '';
    metaList.push({ key, content });
    if (!(key in meta)) meta[key] = content;
    if (key === 'content-type' && !charset) { const c = content.match(/charset=([\w-]+)/i); if (c) charset = c[1]; }
  }
  const robotsBots = {};
  for (const k of ['googlebot', 'googlebot-news', 'yandex', 'yandexbot', 'bingbot']) if (k in meta) robotsBots[k] = meta[k];

  // link tags
  const linkEls = [...doc.querySelectorAll('link[rel]')];
  const linkTags = linkEls.map(l => ({ rel: clean(l.getAttribute('rel')).toLowerCase(), href: abs(l.getAttribute('href')), hreflang: attr(l, 'hreflang'),
    type: attr(l, 'type'), sizes: attr(l, 'sizes'), media: attr(l, 'media'), as: attr(l, 'as'), integrity: attr(l, 'integrity'), crossorigin: attr(l, 'crossorigin') }));
  const relHas = (l, r) => l.rel.split(' ').includes(r);
  const canonicals = linkTags.filter(l => relHas(l, 'canonical')).map(l => l.href);
  const alternates = linkTags.filter(l => relHas(l, 'alternate') && l.hreflang).map(l => ({ hreflang: l.hreflang, href: l.href }));
  const stylesheets = linkTags.filter(l => relHas(l, 'stylesheet')).map(l => ({ href: l.href, media: l.media, integrity: l.integrity, crossorigin: l.crossorigin }));

  // headings
  const headings = [...doc.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(h => ({ level: Number(h.tagName[1]), text: clean(h.textContent).slice(0, 300), id: h.id || null, hidden: isHidden(h) }));

  // links
  const links = [];
  for (const a of doc.querySelectorAll('a[href], area[href]')) {
    if (links.length >= limits.links) break;
    const raw = a.getAttribute('href');
    const href = abs(raw);
    let text = clean(a.textContent);
    if (!text) text = clean([...a.querySelectorAll('img[alt]')].map(i => i.getAttribute('alt')).join(' '));
    let internal = null;
    try { const u = new URL(href); internal = /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') === host : false; } catch (e) { /* javascript:, broken */ }
    links.push({ href, raw, text: text.slice(0, 200), rel: attr(a, 'rel'), target: attr(a, 'target'), title: attr(a, 'title'), aria_label: attr(a, 'aria-label'), internal, in: region(a), hidden: isHidden(a) });
  }

  // JSON-LD
  const typesOf = (x, out) => {
    if (Array.isArray(x)) x.forEach(y => typesOf(y, out));
    else if (x && typeof x === 'object') {
      if (x['@type']) [].concat(x['@type']).forEach(v => out.add(String(v)));
      for (const v of Object.values(x)) if (v && typeof v === 'object') typesOf(v, out);
    }
    return out;
  };
  const jsonld = [...doc.querySelectorAll('script[type]')].filter(s => /ld\+json/i.test(s.getAttribute('type'))).map(s => {
    const raw = s.textContent || '';
    try { const parsed = JSON.parse(raw); return { raw: raw.slice(0, limits.jsonld), parsed, error: null, types: [...typesOf(parsed, new Set())] }; }
    catch (e) { return { raw: raw.slice(0, limits.jsonld), parsed: null, error: String(e.message || e), types: [] }; }
  });

  // images
  const images = [...doc.querySelectorAll('img')].slice(0, limits.images).map(i => ({
    src: abs(i.getAttribute('src')), raw_src: attr(i, 'src'),
    data_src: abs(i.getAttribute('data-src') || i.getAttribute('data-original') || i.getAttribute('data-lazy-src') || i.getAttribute('data-lazy')) || null,
    srcset: attr(i, 'srcset'), sizes: attr(i, 'sizes'), alt: attr(i, 'alt'), width: attr(i, 'width'), height: attr(i, 'height'),
    loading: attr(i, 'loading'), decoding: attr(i, 'decoding'), fetchpriority: attr(i, 'fetchpriority'), in_link: !!i.closest('a[href]'), in: region(i), hidden: isHidden(i),
  }));

  // forms
  const labelFor = el => {
    const parts = [];
    if (el.id) { try { const l = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) parts.push(clean(l.textContent)); } catch (e) { /* odd id */ } }
    const wrap = el.closest('label'); if (wrap) parts.push(clean(wrap.textContent));
    const al = el.getAttribute('aria-label'); if (al) parts.push(clean(al));
    const lb = el.getAttribute('aria-labelledby');
    if (lb) parts.push(clean(lb.split(/\s+/).map(id => (doc.getElementById(id) || {}).textContent || '').join(' ')));
    return parts.filter(Boolean)[0] || null;
  };
  const fieldInfo = el => {
    const tag = el.tagName.toLowerCase();
    const type = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : tag;
    return { tag, type, name: attr(el, 'name'), id: el.id || null, label: labelFor(el), placeholder: attr(el, 'placeholder'),
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true', autocomplete: attr(el, 'autocomplete'), inputmode: attr(el, 'inputmode'),
      pattern: attr(el, 'pattern'), maxlength: attr(el, 'maxlength'), checked: ['checkbox', 'radio'].includes(type) ? el.hasAttribute('checked') : undefined,
      options: tag === 'select' ? el.querySelectorAll('option').length : undefined, hidden: type === 'hidden' || isHidden(el) };
  };
  const NOT_FIELD = ['submit', 'button', 'image', 'reset'];
  const forms = [...doc.querySelectorAll('form')].slice(0, limits.forms).map(f => ({
    action: f.hasAttribute('action') ? abs(f.getAttribute('action')) : null, method: (f.getAttribute('method') || 'get').toLowerCase(), method_set: f.hasAttribute('method'),
    id: f.id || null, name: attr(f, 'name'), enctype: attr(f, 'enctype'), novalidate: f.hasAttribute('novalidate'), target: attr(f, 'target'),
    fields: [...f.querySelectorAll('input,select,textarea')].filter(el => !NOT_FIELD.includes((el.getAttribute('type') || '').toLowerCase())).slice(0, 100).map(fieldInfo),
    submits: [...f.querySelectorAll('button, input[type=submit], input[type=image]')]
      .filter(b => b.tagName !== 'BUTTON' || !b.getAttribute('type') || b.getAttribute('type').toLowerCase() === 'submit')
      .map(b => ({ text: clean(b.textContent || b.getAttribute('value') || b.getAttribute('aria-label') || '').slice(0, 100), type: (b.getAttribute('type') || 'submit').toLowerCase() })),
    in: region(f), hidden: isHidden(f),
  }));
  const fieldsOutside = [...doc.querySelectorAll('input,select,textarea')]
    .filter(el => !el.closest('form') && !NOT_FIELD.includes((el.getAttribute('type') || '').toLowerCase()) && (el.getAttribute('type') || '').toLowerCase() !== 'hidden')
    .slice(0, 50).map(fieldInfo);

  // embeds, scripts, comments
  const iframes = [...doc.querySelectorAll('iframe')].slice(0, 100).map(f => ({ src: abs(f.getAttribute('src')), title: attr(f, 'title'), loading: attr(f, 'loading'), sandbox: attr(f, 'sandbox'), in: region(f) }));
  const scriptEls = [...doc.querySelectorAll('script')].filter(s => !/ld\+json/i.test(s.getAttribute('type') || ''));
  const scripts = scriptEls.filter(s => s.hasAttribute('src')).slice(0, limits.scripts).map(s => ({ src: abs(s.getAttribute('src')), type: attr(s, 'type'), async: s.hasAttribute('async'),
    defer: s.hasAttribute('defer'), integrity: attr(s, 'integrity'), crossorigin: attr(s, 'crossorigin'), nomodule: s.hasAttribute('nomodule'), in_head: !!s.closest('head') }));
  const inline = scriptEls.filter(s => !s.hasAttribute('src'));
  const comments = [];
  const tw = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
  while (tw.nextNode() && comments.length < limits.comments) { const c = clean(tw.currentNode.nodeValue); if (c) comments.push(c.slice(0, 300)); }

  // visible text (structure by block elements)
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'HEAD', 'IFRAME', 'OBJECT', 'CANVAS', 'SELECT', 'MATH', 'VIDEO', 'AUDIO']);
  const BLOCK = new Set(['P', 'DIV', 'LI', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TABLE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'NAV', 'MAIN',
    'ASIDE', 'BLOCKQUOTE', 'PRE', 'FORM', 'DD', 'DT', 'DL', 'FIGCAPTION', 'FIGURE', 'ADDRESS', 'HR', 'DETAILS', 'SUMMARY', 'FIELDSET', 'LEGEND', 'CAPTION', 'BODY']);
  const buf = [];
  let size = 0, truncated = false;
  const walk = node => {
    for (let n = node.firstChild; n; n = n.nextSibling) {
      if (size > limits.text) { truncated = true; return; }
      if (n.nodeType === 3) { buf.push(n.nodeValue); size += n.nodeValue.length; }
      else if (n.nodeType === 1) {
        const tag = n.tagName.toUpperCase();
        if (SKIP.has(tag) || n.hasAttribute('hidden') || hiddenStyle(n)) continue;
        if (tag === 'BR') { buf.push('\n'); continue; }
        const block = BLOCK.has(tag);
        if (block) buf.push('\n');
        else if (tag === 'TD' || tag === 'TH') buf.push(' ');
        walk(n);
        if (block) buf.push('\n');
      }
    }
  };
  if (doc.body) walk(doc.body);
  let text = buf.join('').replace(/[ \t\r\f\v]+/g, ' ').replace(/ *\n[ \n]*/g, '\n').trim();
  if (text.length > limits.text) { text = text.slice(0, limits.text); truncated = true; }
  const wordCount = (text.match(/[\p{L}\p{N}]+(?:[-'’][\p{L}\p{N}]+)*/gu) || []).length;

  const de = doc.documentElement;
  return {
    base_url: base || null, title: clean(doc.title), titles_count: [...doc.getElementsByTagName('title')].filter(t => !t.closest('svg')).length,
    lang: de ? attr(de, 'lang') : null, dir: de ? attr(de, 'dir') : null, charset, viewport: meta.viewport ?? null,
    meta, meta_list: metaList, robots: meta.robots ?? null, robots_bots: robotsBots,
    canonical: canonicals[0] ?? null, canonicals, alternates, link_tags: linkTags,
    headings, h1: headings.filter(h => h.level === 1).map(h => h.text), h1_visible: headings.filter(h => h.level === 1 && !h.hidden).map(h => h.text),
    links, jsonld, images, forms, fields_outside_forms: fieldsOutside, iframes, scripts,
    inline_scripts: { count: inline.length, bytes: inline.reduce((n, s) => n + (s.textContent || '').length, 0) },
    stylesheets, comments, text, text_length: text.length, word_count: wordCount, text_truncated: truncated,
    counts: { links: links.length, internal_links: links.filter(l => l.internal).length, images: images.length, images_no_alt: images.filter(i => i.alt === null).length,
      forms: forms.length, jsonld: jsonld.length, jsonld_errors: jsonld.filter(j => j.error).length, h1: headings.filter(h => h.level === 1).length,
      h1_visible: headings.filter(h => h.level === 1 && !h.hidden).length, iframes: iframes.length, scripts: scripts.length },
  };
}

const isPage = t => !!(t && typeof t.send === 'function' && t.sessionId && typeof t.newPage !== 'function');
async function ownTab(browser) {
  if (!browser || typeof browser.newPage !== 'function') throw new Error('parseHtml: нужен Browser или Page из lib/cdp.mjs');
  let page = TABS.get(browser);
  if (!page) {
    page = await browser.newPage({ blockNavigation: true });
    await page.send('Emulation.setScriptExecutionDisabled', { value: true });
    TABS.set(browser, page);
  }
  return page;
}
async function evaluateIn(page, contextId, fn, args) {
  const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
  const r = await page.send('Runtime.evaluate', { expression, ...(contextId ? { contextId } : {}), returnByValue: true, awaitPromise: true, userGesture: false }, 120000);
  if (r.exceptionDetails) { const e = new Error('evaluate: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)); e.inPage = true; throw e; }
  return r.result?.value;
}
// The isolated world of the page's main frame: own JS globals, untouched by the site's scripts.
// The shared one of lib/cdp (page.isolatedContextId) when there is one, else a new world here.
async function isolatedWorld(page, fresh = false) {
  if (!fresh && typeof page.isolatedContextId === 'function') { try { return await page.isolatedContextId(); } catch { /* make our own */ } }
  const tree = await page.send('Page.getFrameTree');
  const frameId = tree?.frameTree?.frame?.id;
  if (!frameId) throw new Error('parseHtml: у вкладки нет главного фрейма — передайте Browser');
  const { executionContextId } = await page.send('Page.createIsolatedWorld', { frameId, worldName: 'revizor-dom', grantUniveralAccess: false });
  if (!executionContextId) throw new Error('parseHtml: изолированный мир не создан — передайте Browser');
  return executionContextId;
}
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(r, ms))]);

/** Parse an HTML string in the browser. baseUrl resolves relative links (a <base href> inside the HTML wins). */
export async function parseHtml(browserOrPage, html, baseUrl = '', limits = {}) {
  const src = String(html ?? '');
  const argv = [src.length > MAX_HTML ? src.slice(0, MAX_HTML) : src, baseUrl || '', { ...LIMITS, ...limits }];
  let res;
  if (isPage(browserOrPage)) {
    // a live tab of the site: never its main world (the site could have replaced DOMParser)
    try { res = await evaluateIn(browserOrPage, await isolatedWorld(browserOrPage), parseInPage, argv); }
    catch (e) { // the world went away with a navigation: once more in a fresh one
      if (e.inPage) throw e;
      res = await evaluateIn(browserOrPage, await isolatedWorld(browserOrPage, true), parseInPage, argv);
    }
  } else {
    for (let attempt = 0; ; attempt++) {
      const page = await ownTab(browserOrPage);
      try { res = await evaluateIn(page, null, parseInPage, argv); break; }
      catch (e) {
        // the parsing tab crashed or got closed (huge HTML, out of memory): forget it, one more try in a new tab
        if (attempt > 0 || e.inPage) throw e;
        TABS.delete(browserOrPage);
        await withTimeout(page.close().catch(() => {}), 3000);
      }
    }
  }
  if (src.length > MAX_HTML) res.html_truncated = true;
  return res;
}

/** Close the parsing tab of a browser (Browser.close() closes it too). */
export async function closeDomTab(browser) {
  const page = TABS.get(browser);
  if (page) { TABS.delete(browser); await page.close(); }
}
