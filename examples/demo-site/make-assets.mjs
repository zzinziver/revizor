#!/usr/bin/env node
// Demo site assets generator (deterministic). The generated files are committed;
// run this only to rebuild them:  node make-assets.mjs
//  - site/assets/img/hero.png   ~2.5 MB "photo" (warm gradient + bokeh + grain): the planted heavy LCP image
//  - site/assets/video/steam.mp4  short looping clip (needs ffmpeg in PATH; skipped without it)
import { writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const IMG = join(HERE, 'site', 'assets', 'img');
const VID = join(HERE, 'site', 'assets', 'video');
mkdirSync(IMG, { recursive: true }); mkdirSync(VID, { recursive: true });

// ---------- PNG writer ----------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xFFFFFFFF; for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ---------- deterministic noise ----------
function mulberry32(a) { return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20171207);

// hero: light cream on the left (where the white headline sits — low contrast on purpose), dark roast on the right
const W = 1400, H = 760;
const rgb = Buffer.alloc(W * H * 3);
const light = [241, 228, 208], mid = [196, 150, 108], dark = [74, 46, 30];
const bokeh = Array.from({ length: 26 }, () => ({ x: rnd() * W, y: rnd() * H, r: 30 + rnd() * 90, a: 0.10 + rnd() * 0.22 }));
const mix = (a, b, t) => a + (b - a) * t;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const t = Math.min(1, Math.max(0, (x / W) * 0.85 + (y / H) * 0.25));
    const base = t < 0.5 ? [0, 1, 2].map(i => mix(light[i], mid[i], t * 2)) : [0, 1, 2].map(i => mix(mid[i], dark[i], (t - 0.5) * 2));
    let glow = 0;
    for (const b of bokeh) { const d = Math.hypot(x - b.x, y - b.y); if (d < b.r) glow += b.a * (1 - d / b.r); }
    const grain = (rnd() - 0.5) * 58;
    for (let i = 0; i < 3; i++) {
      const v = base[i] + glow * (255 - base[i]) * 0.6 + grain;
      rgb[(y * W + x) * 3 + i] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
}
const heroPath = join(IMG, 'hero.png');
writeFileSync(heroPath, png(W, H, rgb));
console.log(`hero.png ${statSync(heroPath).size} bytes`);

// ---------- video (optional) ----------
const mp4 = join(VID, 'steam.mp4');
try {
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i',
    'gradients=s=640x360:c0=0x2b1d14:c1=0x7a4a2c:c2=0xd9b48f:x0=0:y0=0:x1=640:y1=360:d=4:speed=0.03:r=25',
    '-vf', 'noise=alls=18:allf=t,format=yuv420p', '-c:v', 'libx264', '-crf', '30', '-an', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
  console.log('steam.mp4 ok');
} catch (e) {
  console.log(existsSync(mp4) ? 'ffmpeg not found — steam.mp4 kept as is' : 'ffmpeg not found — steam.mp4 not created');
}
