// Revizor collector «links» — links of the page by blocks: header / main / footer / other.
// Collector interface: meta, collect(page, ctx), finalize(all, ctx) → { files, lines, summary }; called by snapshot.mjs.
// Per page → snapshot/<pid>/page.json, key "links" (list of the primary width + counts per width).
// Per site → measure/links-blocks.json: header/footer consistency across pages, phones and e-mails,
// messengers, generic link texts («Подробнее» ×N), one URL under different names, broken #anchors.
// Links are NOT opened here: status codes are checked by seo.mjs (measure/links.json).

import { existsSync } from 'node:fs';
import { hostOf, stripWww, isRiskyGet, normText, nowIso, insideRun, readJSON } from '../lib/util.mjs';
import { ensureHelpers, ev, loadInfo, groupByPid, logDropped, primaryOf, updatePageJson, writeMeasureMerged, pageEntry, selectedPids } from './meta.mjs';

export const meta = { name: 'links', widths: [390, 1440], order: 14 };

function collectLinksInPage(L) {
  const H = window.__revizorH;
  const GENERIC = /^(подробнее|подробно|узнать больше|узнать подробнее|читать далее|читать полностью|читать|далее|ещё|еще|смотреть|смотреть все|перейти|ссылка|тут|здесь|сюда|по ссылке|click here|here|read more|more|learn more|details|see more|view more|go|>+|→|»)$/i;
  const MESSENGER = /^(https?:\/\/)?((www\.)?(t\.me|telegram\.me|wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|vk\.me|m\.me|ig\.me)|viber:|tg:|whatsapp:|skype:)/i;
  const FILE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|rtf|odt|csv|txt|apk|dmg|exe)(\?|#|$)/i;
  const nameOf = a => {
    // H.textOf: innerText, or textContent when the link sits in a skipped content-visibility:auto section
    const txt = H.clean(H.textOf(a), 160);
    if (txt) return { name: txt, src: 'text' };
    const al = a.getAttribute('aria-label'); if (al && al.trim()) return { name: H.clean(al, 160), src: 'aria-label' };
    const lb = a.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map(id => { const e = document.getElementById(id); return e ? e.textContent : ''; }).join(' '); if (t.trim()) return { name: H.clean(t, 160), src: 'aria-labelledby' }; }
    const img = a.querySelector('img[alt]'); if (img && img.getAttribute('alt').trim()) return { name: H.clean(img.getAttribute('alt'), 160), src: 'img-alt' };
    const st = a.querySelector('svg title'); if (st && st.textContent.trim()) return { name: H.clean(st.textContent, 160), src: 'svg-title' };
    const ti = a.getAttribute('title'); if (ti && ti.trim()) return { name: H.clean(ti, 160), src: 'title' };
    const tc = H.clean(a.textContent || '', 160); if (tc) return { name: tc, src: 'hidden-text' };
    return { name: '', src: null };
  };
  const here = location.href.split('#')[0];
  const els = [...document.querySelectorAll('a[href], area[href]')];
  const out = [];
  for (const a of els.slice(0, L.max)) {
    const raw = a.getAttribute('href') || '';
    let href = null; try { href = new URL(raw, document.baseURI).href; } catch { href = raw; }
    const shown = H.shown(a, { opacity: false });
    const nm = nameOf(a);
    let kind = 'link', anchor_ok = null;
    const low = raw.trim().toLowerCase();
    if (low.startsWith('tel:')) kind = 'tel';
    else if (low.startsWith('mailto:')) kind = 'mailto';
    else if (low.startsWith('sms:')) kind = 'sms';
    else if (low.startsWith('javascript:')) kind = 'javascript';
    else if (MESSENGER.test(raw.trim())) kind = 'messenger';
    else if (a.getAttribute('data-toggle') === 'modal' || a.getAttribute('data-bs-toggle') === 'modal' || a.getAttribute('aria-haspopup') === 'dialog') kind = 'popup';
    else if (raw.trim() === '#' || raw.trim() === '#!' || raw.trim() === '') kind = 'empty-anchor';
    else if (href && href.split('#')[0] === here && href.includes('#')) {
      // «#form» / «#order» that points at a block of this page is an anchor; without such a block it opens a popup
      let id = href.slice(href.indexOf('#') + 1);
      try { id = decodeURIComponent(id); } catch { /* «#sale-50%»: a malformed escape, keep as written */ }
      const found = !id || id === 'top' || !!H.anchorTarget('#' + href.slice(href.indexOf('#') + 1)) || !!document.getElementById(id) || !!document.getElementsByName(id).length;
      if (!found && /^#(popup|order|modal|form)/i.test(raw.trim())) kind = 'popup';
      else { kind = 'anchor'; anchor_ok = found; }
    } else if (FILE.test(href || '')) kind = 'file';
    const nav = !!a.closest('nav, [role="navigation"], [role="menu"], [role="menubar"]');
    const region = H.regionOf(a);
    const r = a.getBoundingClientRect();
    out.push({
      text: nm.name, name_src: nm.src, href: href ? href.slice(0, 500) : null, raw: raw.slice(0, 200), kind, anchor_ok,
      region, nav, shown, collapsed: shown ? null : H.collapsedKind(a),
      rel: a.getAttribute('rel'), target: a.getAttribute('target'), download: a.hasAttribute('download'),
      generic: GENERIC.test(nm.name.trim()) || GENERIC.test(nm.name.replace(/[\s.…!→»›>]+$/, '').trim()), inline: shown ? H.inlineInText(a) : false,
      has_img: !!a.querySelector('img, svg, picture'),
      box: shown ? [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)] : null,
      selector: null, _i: out.length,
    });
  }
  // selectors only where an agent may need to point at the element (they cost time)
  for (const o of out) {
    const a = els[o._i];
    if (o.generic || !o.text || o.kind === 'javascript' || o.kind === 'empty-anchor' || o.anchor_ok === false || o.kind === 'tel' || o.kind === 'mailto' || o.kind === 'messenger' || o.kind === 'popup') o.selector = H.sel(a);
    delete o._i;
  }
  const buttons = [...document.querySelectorAll('button, [role="button"]')].slice(0, 300).filter(b => b.getAttribute('data-toggle') === 'modal' || b.getAttribute('data-bs-toggle') === 'modal' || b.getAttribute('aria-haspopup') === 'dialog' || /^#(popup|order|modal|form)/i.test(b.getAttribute('data-target') || b.getAttribute('data-bs-target') || ''))
    .map(b => ({ text: H.clean(b.innerText || b.getAttribute('aria-label') || '', 120), target: b.getAttribute('data-target') || b.getAttribute('data-bs-target') || null, region: H.regionOf(b), shown: H.shown(b, { opacity: false }), selector: H.sel(b) }));
  return { links: out, total: els.length, truncated: els.length > L.max, popup_buttons: buttons, page_url: here, regions_how: H.regions().how };
}

export async function collect(page, ctx = {}) {
  await ensureHelpers(page);
  const data = await ev(page, collectLinksInPage, { max: 1500 });
  const li = loadInfo(page, ctx);
  const site = stripWww(hostOf(li.final_url || data.page_url || ctx.url || ''));
  for (const l of data.links) {
    if (l.kind === 'link' || l.kind === 'file' || l.kind === 'anchor') {
      const h = stripWww(hostOf(l.href || ''));
      l.internal = !!h && (h === site || h.endsWith('.' + site) || site.endsWith('.' + h));
      if (/^http:\/\//i.test(l.href || '') && /^https:/i.test(li.final_url || '')) l.insecure = true;
      if (l.href && /^https?:/i.test(l.href) && isRiskyGet(l.href)) l.risky = true;
      if (l.target === '_blank' && !l.internal && !/noopener|noreferrer/i.test(l.rel || '')) l.blank_without_noopener = true;
    }
  }
  return { ...data, final_url: li.final_url, captured: nowIso() };
}

// ---------------------------------------------------------------------------------------------
const digits = s => String(s || '').replace(/^tel:/i, '').replace(/[^\d+]/g, '');
const keyOf = l => `${l.kind}|${(l.href || '').split('#')[0]}|${normText(l.text)}`;

function pageStats(d) {
  const L = d.links;
  const by = (f) => L.reduce((a, l) => { const k = f(l); a[k] = (a[k] || 0) + 1; return a; }, {});
  const generic = L.filter(l => l.generic && (l.shown || l.collapsed));
  const genericCounts = generic.reduce((a, l) => { const k = l.text.toLowerCase(); a[k] = (a[k] || 0) + 1; return a; }, {});
  // one text → several targets; one target → several texts (internal, main region)
  const textTargets = new Map(), targetTexts = new Map();
  for (const l of L) {
    if (!['link', 'file'].includes(l.kind) || !l.text || l.generic) continue;
    const t = normText(l.text), u = (l.href || '').split('#')[0], full = l.href || '';
    if (!textTargets.has(t)) textTargets.set(t, new Set()); textTargets.get(t).add(u);
    if (l.internal) { if (!targetTexts.has(full)) targetTexts.set(full, new Set()); targetTexts.get(full).add(l.text); }
  }
  return {
    total: d.total, truncated: d.truncated,
    by_region: by(l => l.region), by_kind: by(l => l.kind),
    shown: L.filter(l => l.shown).length, collapsed: L.filter(l => !l.shown && l.collapsed).length, hidden: L.filter(l => !l.shown && !l.collapsed).length,
    internal_unique: [...new Set(L.filter(l => l.internal).map(l => (l.href || '').split('#')[0]))].length,
    external_hosts: [...new Set(L.filter(l => l.kind === 'link' && !l.internal).map(l => stripWww(hostOf(l.href || ''))).filter(Boolean))].slice(0, 60),
    generic: Object.entries(genericCounts).map(([text, n]) => ({ text, n })).sort((a, b) => b.n - a.n),
    no_name: L.filter(l => !l.text && (l.shown || l.collapsed)).map(l => ({ href: l.href, region: l.region, selector: l.selector })).slice(0, 30),
    name_only_hidden_text: L.filter(l => l.name_src === 'hidden-text' && l.shown).length,
    broken_anchors: L.filter(l => l.anchor_ok === false).map(l => ({ href: l.raw, text: l.text, selector: l.selector })).slice(0, 30),
    empty_anchors: L.filter(l => l.kind === 'empty-anchor').length, javascript: L.filter(l => l.kind === 'javascript').length,
    insecure: L.filter(l => l.insecure).map(l => l.href).slice(0, 20),
    risky: L.filter(l => l.risky).map(l => ({ href: l.href, text: l.text })).slice(0, 20),
    blank_without_noopener: L.filter(l => l.blank_without_noopener).length,
    tel: [...new Set(L.filter(l => l.kind === 'tel').map(l => digits(l.raw)))],
    mailto: [...new Set(L.filter(l => l.kind === 'mailto').map(l => l.raw.replace(/^mailto:/i, '').split('?')[0].toLowerCase()))],
    messengers: [...new Set(L.filter(l => l.kind === 'messenger').map(l => l.href))].slice(0, 20),
    files: L.filter(l => l.kind === 'file').map(l => ({ href: l.href, text: l.text })).slice(0, 40),
    popup_triggers: L.filter(l => l.kind === 'popup').map(l => ({ text: l.text, raw: l.raw, region: l.region, shown: l.shown, selector: l.selector })).slice(0, 40)
      .concat((d.popup_buttons || []).map(b => ({ text: b.text, raw: b.target, region: b.region, shown: b.shown, selector: b.selector, button: true }))).slice(0, 60),
    same_text_many_targets: [...textTargets].filter(([, s]) => s.size > 1).map(([text, s]) => ({ text, targets: [...s].slice(0, 6) })).slice(0, 20),
    same_target_many_texts: [...targetTexts].filter(([, s]) => s.size > 2).map(([href, s]) => ({ href, texts: [...s].slice(0, 8) })).slice(0, 20),
  };
}

export async function finalize(all, ctx = {}) {
  if (!ctx.run) throw new Error('links.finalize: ctx.run is required');
  const lang = ctx.lang === 'en' ? 'en' : 'ru';
  const items = [], errors = [], lines = [];
  const perPage = new Map();
  const groups = groupByPid(all, ctx.pages);
  logDropped(ctx, 'links', groups);
  for (const [pid, its] of groups) {
    const ok = its.filter(x => x.data && !x.data.error && Array.isArray(x.data.links));
    for (const x of its) if (!x.data || x.data.error) errors.push({ pid, width: x.width, error: x.data ? x.data.error : 'no data' });
    if (!ok.length) continue;
    const prim = primaryOf(ok);
    const byWidth = {};
    for (const x of ok) byWidth[x.width] = pageStats(x.data);
    // links present on one width only (by kind + target + text)
    let width_diff = null;
    if (ok.length > 1) {
      const narrow = ok[0], wide = ok[ok.length - 1];
      const ks = d => new Set(d.links.filter(l => l.shown || l.collapsed).map(keyOf));
      const kn = ks(narrow.data), kw = ks(wide.data);
      const pick = (d, other) => d.links.filter(l => (l.shown || l.collapsed) && !other.has(keyOf(l))).map(l => ({ text: l.text, href: l.href, region: l.region })).slice(0, 30);
      width_diff = { widths: [narrow.width, wide.width], only_narrow: pick(narrow.data, kw), only_wide: pick(wide.data, kn) };
    }
    // compact list: empty values dropped; «shown» and «anchor_ok» stay even when false (a hidden link and a broken
    // #anchor must be told apart from an unchecked one: anchor_ok is absent only when the link is not an anchor)
    const KEEP_FALSE = new Set(['shown', 'anchor_ok']);
    const list = prim.data.links.map(l => { const o = { ...l }; for (const k of Object.keys(o)) if (o[k] === null || (o[k] === false && !KEEP_FALSE.has(k))) delete o[k]; return o; });
    await updatePageJson(ctx.run, pid, { links: { width: prim.width, captured: prim.data.captured, stats: byWidth[prim.width], by_width: Object.fromEntries(Object.entries(byWidth).map(([w, s]) => [w, { total: s.total, by_region: s.by_region, shown: s.shown, collapsed: s.collapsed }])), width_diff, list } });
    const pageUrl = pageEntry(ctx.pages, pid)?.url || prim.url || prim.data.final_url;
    perPage.set(pid, { prim, stats: byWidth[prim.width], url: pageUrl, final_url: prim.data.final_url });
    for (const x of ok) items.push({ pid, url: pageUrl, width: x.width, ...byWidth[x.width] });
    const s = byWidth[prim.width];
    lines.push(lang === 'en'
      ? `${pid}: ${s.total} links (header ${s.by_region.header || 0}, main ${s.by_region.main || 0}, footer ${s.by_region.footer || 0}); generic ${s.generic.reduce((a, g) => a + g.n, 0)}, broken #anchors ${s.broken_anchors.length}`
      : `${pid}: ссылок ${s.total} (шапка ${s.by_region.header || 0}, main ${s.by_region.main || 0}, подвал ${s.by_region.footer || 0}); «Подробнее»-подобных ${s.generic.reduce((a, g) => a + g.n, 0)}, битых #якорей ${s.broken_anchors.length}`);
  }

  // pages finished in earlier (resumed) snapshot calls: take their lists from page.json
  const measurePath = insideRun(ctx.run, 'measure', 'links-blocks.json');
  const sel = selectedPids(ctx.pages);
  if (existsSync(measurePath)) {
    for (const pid of new Set((readJSON(measurePath, {}).items || []).map(x => x.pid))) {
      if (perPage.has(pid) || (sel && !sel.has(pid))) continue;
      const pj = readJSON(insideRun(ctx.run, 'snapshot', String(pid), 'page.json'), {});
      if (pj.links && Array.isArray(pj.links.list)) perPage.set(pid, { prim: { data: { links: pj.links.list } }, stats: pj.links.stats, url: pj.url || pj.final_url, final_url: pj.final_url });
    }
  }

  // site level: header/footer sets per page, phones, generic texts
  const siteSummary = () => {
    const sets = region => {
      const m = new Map();
      for (const [pid, p] of perPage) m.set(pid, new Set(p.prim.data.links.filter(l => l.region === region && (l.shown || l.collapsed) && ['link', 'anchor', 'file', 'popup'].includes(l.kind)).map(l => `${(l.href || '').split('#')[0]}|${normText(l.text)}`)));
      const counts = new Map();
      for (const s of m.values()) for (const k of s) counts.set(k, (counts.get(k) || 0) + 1);
      const n = m.size, common = [...counts].filter(([, c]) => c >= Math.ceil(n * 0.6)).map(([k]) => k);
      const differs = [];
      for (const [pid, s] of m) {
        const missing = common.filter(k => !s.has(k)), extra = [...s].filter(k => (counts.get(k) || 0) < Math.ceil(n * 0.6));
        if (missing.length || (n > 2 && extra.length > 3)) differs.push({ pid, missing: missing.slice(0, 10).map(k => k.split('|')[1] || k), extra: extra.slice(0, 10).map(k => k.split('|')[1] || k) });
      }
      return { pages: n, common: common.length, sample: common.slice(0, 20).map(k => { const [href, text] = k.split('|'); return { text, href }; }), differs };
    };
    const phones = new Map(), mails = new Map();
    for (const [pid, p] of perPage) {
      for (const t of p.stats.tel) { if (!phones.has(t)) phones.set(t, []); phones.get(t).push(pid); }
      for (const m of p.stats.mailto) { if (!mails.has(m)) mails.set(m, []); mails.get(m).push(pid); }
    }
    const generic = new Map();
    for (const [pid, p] of perPage) for (const g of p.stats.generic) { const e = generic.get(g.text) || { text: g.text, n: 0, pages: [] }; e.n += g.n; e.pages.push(pid); generic.set(g.text, e); }
    const linkedFrom = new Map();
    for (const [pid, p] of perPage) for (const l of p.prim.data.links) if (l.internal && (l.shown || l.collapsed)) { const u = (l.href || '').split('#')[0].replace(/\/$/, ''); if (!linkedFrom.has(u)) linkedFrom.set(u, new Set()); linkedFrom.get(u).add(pid); }
    const notLinked = [];
    for (const [pid, p] of perPage) {
      if (pid === 'home') continue;
      const us = [p.url, p.final_url].filter(Boolean).map(x => String(x).split('#')[0].replace(/\/$/, ''));
      const from = [...new Set(us.flatMap(u => [...(linkedFrom.get(u) || [])]))].filter(x => x !== pid);
      if (!from.length) notLinked.push(pid);
    }
    return {
      pages: perPage.size,
      header: sets('header'), footer: sets('footer'),
      phones: [...phones].map(([number, pages]) => ({ number, pages })), emails: [...mails].map(([email, pages]) => ({ email, pages })),
      generic_texts: [...generic.values()].sort((a, b) => b.n - a.n).slice(0, 20),
      broken_anchors: [...perPage].flatMap(([pid, p]) => p.stats.broken_anchors.map(b => ({ pid, ...b }))).slice(0, 40),
      selected_not_linked_from_selected: notLinked,
      no_name: [...perPage].reduce((a, [, p]) => a + p.stats.no_name.length, 0),
      risky: [...perPage].flatMap(([pid, p]) => p.stats.risky.map(r => ({ pid, ...r }))).slice(0, 20),
    };
  };
  const out = writeMeasureMerged(ctx, 'links-blocks', { items, errors, summaryFn: () => siteSummary() });
  const sm = out.summary;
  if (sm && sm.phones && sm.phones.length > 1) lines.push(lang === 'en' ? `phones on the site: ${sm.phones.map(p => p.number).join(', ')}` : `телефоны на сайте: ${sm.phones.map(p => p.number).join(', ')}`);
  if (ctx.log) try { ctx.log(`links: page.json × ${perPage.size}, measure/links-blocks.json`); } catch {}
  return { files: ['measure/links-blocks.json'], lines, summary: { pages: sm?.pages ?? perPage.size, phones: (sm?.phones || []).length, broken_anchors: (sm?.broken_anchors || []).length, generic_texts: (sm?.generic_texts || []).reduce((a, g) => a + g.n, 0) } };
}
