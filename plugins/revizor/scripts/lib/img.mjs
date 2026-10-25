// Revizor — image helpers done inside the browser (canvas), so no image libraries are needed.
// Every function takes a cdp Page (from lib/cdp.mjs) that can be a blank tab: we load the image as a data URL.
// Large screenshots are fine (Chrome canvas limit ~16k px per side / ~268M px area).

import { readFileSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';

function dataUrl(path) {
  const ext = extname(path).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

function saveDataUrl(du, out) {
  const b64 = du.slice(du.indexOf(',') + 1);
  writeFileSync(out, Buffer.from(b64, 'base64'));
  return out;
}

// Shared in-page loader: returns {w,h} and keeps the image on window.__rvImg
async function load(page, path) {
  await page.evaluate('document.body ? 0 : document.write("<body></body>")').catch(() => {});
  return page.evaluate(async (src) => {
    const img = new Image();
    img.decoding = 'sync';
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('image load failed')); img.src = src; });
    window.__rvImg = img;
    return { w: img.naturalWidth, h: img.naturalHeight };
  }, dataUrl(path));
}

/** Image size without decoding the whole file in Node (JPEG/PNG headers). */
export function imageSize(path) {
  const b = readFileSync(path);
  if (b[0] === 0x89 && b[1] === 0x50) return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xFF) { i++; continue; }
    const marker = b[i + 1];
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

/**
 * Slice a tall screenshot into parts for agents to read.
 * sliceImage(page, 'shots/1440-full.jpg', { partHeight: 1600, targetWidth: 1000, outPrefix: 'shots/1440-full.part-' })
 * → ['…part-01.jpg', …]
 */
export async function sliceImage(page, src, { partHeight = 1600, targetWidth = 1000, outPrefix, quality = 0.72 } = {}) {
  const { w, h } = await load(page, src);
  const scale = Math.min(1, targetWidth / w);
  const parts = Math.max(1, Math.ceil(h / partHeight));
  const files = [];
  for (let k = 0; k < parts; k++) {
    const y = k * partHeight, ph = Math.min(partHeight, h - y);
    const du = await page.evaluate((y, ph, w, scale, q) => {
      const c = document.createElement('canvas');
      c.width = Math.round(w * scale); c.height = Math.round(ph * scale);
      const ctx = c.getContext('2d');
      ctx.drawImage(window.__rvImg, 0, y, w, ph, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', q);
    }, y, ph, w, scale, quality);
    const out = `${outPrefix}${String(k + 1).padStart(2, '0')}.jpg`;
    files.push(saveDataUrl(du, out));
  }
  return files;
}

/**
 * Crop a region with a highlight frame (for report illustrations).
 * box = [x, y, w, h] in image pixels. pad adds context around the box.
 */
export async function cropWithBox(page, src, box, { out, pad = 80, border = 4, color = '#E5484D', maxWidth = 1400, quality = 0.8 } = {}) {
  const { w, h } = await load(page, src);
  const [bx, by, bw, bh] = box.map(Number);
  const x0 = Math.max(0, Math.floor(bx - pad)), y0 = Math.max(0, Math.floor(by - pad));
  const x1 = Math.min(w, Math.ceil(bx + bw + pad)), y1 = Math.min(h, Math.ceil(by + bh + pad));
  const du = await page.evaluate((x0, y0, x1, y1, bx, by, bw, bh, border, color, maxWidth, q) => {
    const cw = x1 - x0, ch = y1 - y0, scale = Math.min(1, maxWidth / cw);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(cw * scale)); c.height = Math.max(1, Math.round(ch * scale));
    const ctx = c.getContext('2d');
    ctx.drawImage(window.__rvImg, x0, y0, cw, ch, 0, 0, c.width, c.height);
    ctx.strokeStyle = color; ctx.lineWidth = border;
    ctx.strokeRect((bx - x0) * scale - border / 2, (by - y0) * scale - border / 2, bw * scale + border, bh * scale + border);
    return c.toDataURL('image/jpeg', q);
  }, x0, y0, x1, y1, bx, by, bw, bh, border, color, maxWidth, quality);
  return saveDataUrl(du, out);
}

/** Grid of thumbnails with optional labels. files: [{path, label}] */
export async function contactSheet(page, files, { out, cols = 4, thumbWidth = 360, gap = 16, bg = '#f4f4f5', quality = 0.8 } = {}) {
  const items = files.map(f => (typeof f === 'string' ? { path: f } : f)).map(f => ({ src: dataUrl(f.path), label: f.label || '' }));
  const du = await page.evaluate(async (items, cols, tw, gap, bg, q) => {
    const imgs = await Promise.all(items.map(it => new Promise(res => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = it.src; })));
    const rows = Math.ceil(items.length / cols);
    const heights = imgs.map(i => (i ? Math.round(i.naturalHeight * tw / i.naturalWidth) : 40));
    const rowH = []; for (let r = 0; r < rows; r++) rowH.push(Math.max(...heights.slice(r * cols, r * cols + cols)) + 28);
    const c = document.createElement('canvas');
    c.width = cols * tw + (cols + 1) * gap; c.height = rowH.reduce((a, b) => a + b + gap, gap);
    const ctx = c.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, c.width, c.height);
    ctx.font = '14px system-ui, sans-serif'; ctx.fillStyle = '#18181b';
    let y = gap;
    for (let r = 0; r < rows; r++) {
      for (let k = 0; k < cols; k++) {
        const idx = r * cols + k; if (idx >= items.length) break;
        const x = gap + k * (tw + gap);
        if (imgs[idx]) ctx.drawImage(imgs[idx], x, y + 22, tw, heights[idx]);
        ctx.fillText(items[idx].label.slice(0, 48), x, y + 15);
      }
      y += rowH[r] + gap;
    }
    return c.toDataURL('image/jpeg', q);
  }, items, cols, thumbWidth, gap, bg, quality);
  return saveDataUrl(du, out);
}

/**
 * Brightness / palette stats of an image or a region.
 * → { meanL, medianL (0..100, CIE L*), whiteShare, blackShare, saturationMean, palette:[{hex, share}], distinctTones }
 */
export async function imageStats(page, src, { box = null, sampleStep = 4, paletteSize = 8 } = {}) {
  await load(page, src);
  return page.evaluate((box, step, k) => {
    const img = window.__rvImg;
    const [x, y, w, h] = box || [0, 0, img.naturalWidth, img.naturalHeight];
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h));
    const ctx = c.getContext('2d'); ctx.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const Ls = []; let white = 0, black = 0, sat = 0, n = 0; const buckets = new Map();
    const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    for (let i = 0; i < d.length; i += 4 * step) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const L = Y <= 0.008856 ? Y * 903.3 : 116 * Math.cbrt(Y) - 16;
      Ls.push(L); n++;
      if (r > 250 && g > 250 && b > 250) white++;
      if (r < 6 && g < 6 && b < 6) black++;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b); sat += mx ? (mx - mn) / mx : 0;
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    Ls.sort((a, b) => a - b);
    const top = [...buckets.entries()].sort((a, b) => b[1] - a[1]);
    const toHex = key => '#' + [(key >> 8) & 15, (key >> 4) & 15, key & 15].map(v => (v * 16 + 8).toString(16).padStart(2, '0')).join('');
    return {
      meanL: Math.round(Ls.reduce((a, b) => a + b, 0) / n), medianL: Math.round(Ls[n >> 1]),
      whiteShare: Math.round(1000 * white / n) / 10, blackShare: Math.round(1000 * black / n) / 10,
      saturationMean: Math.round(100 * sat / n) / 100,
      palette: top.slice(0, k).map(([key, cnt]) => ({ hex: toHex(key), share: Math.round(1000 * cnt / n) / 10 })),
      distinctTones: top.filter(([, cnt]) => cnt / n > 0.005).length,
    };
  }, box, sampleStep, paletteSize);
}

/**
 * Background colour under a text box, sampled from a screenshot (median + darkest/lightest),
 * used for contrast on images/gradients/video. box in image pixels.
 */
export async function sampleBackground(page, src, box) {
  await load(page, src);
  return page.evaluate((box) => {
    const img = window.__rvImg;
    const [x, y, w, h] = box.map(v => Math.max(0, Math.round(v)));
    const c = document.createElement('canvas'); c.width = Math.max(1, w); c.height = Math.max(1, h);
    const ctx = c.getContext('2d'); ctx.drawImage(img, x, y, w, h, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const px = [];
    for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
    const lum = p => 0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2];
    px.sort((a, b) => lum(a) - lum(b));
    return { median: px[px.length >> 1], darkest: px[Math.floor(px.length * 0.05)], lightest: px[Math.floor(px.length * 0.95)], n: px.length };
  }, box);
}
