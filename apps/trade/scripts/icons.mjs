#!/usr/bin/env node
/**
 * The app mark, drawn from the design tokens and rasterised into `public/`.
 *
 * There is no image library in this repo and none is added for four small squares.
 * A PNG is a zlib stream of filtered scanlines with a CRC on each chunk, and
 * `node:zlib` is already here — so the mark is defined as geometry, supersampled 4x
 * for antialiasing, and written directly. That also means the icon is reproducible:
 * `node scripts/icons.mjs` regenerates every file byte for byte, and the mark lives
 * in this file rather than in a binary nobody can diff.
 *
 * ## The mark
 *
 * An "M" for MoneyMarkets, drawn as one round-capped stroke on the design system's
 * green `--accent`. The stroke's two peaks read as a price line as much as a letter,
 * and a single heavy stroke with no thin joins survives 16 px where a typeset "M"
 * would not.
 *
 * `maskable` gets the safe zone Android crops to (the mark inside the middle 60%);
 * the Apple touch icon is full-bleed because iOS applies its own mask and a
 * pre-rounded corner inside it reads as a mistake.
 */
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** `--accent` (light theme) in packages/ui/src/tokens.css, and paper for the stroke. */
const ACCENT = [0x0e, 0x9f, 0x63];
const PAPER = [0xff, 0xff, 0xff];

const SS = 4; // supersampling factor

/**
 * Signed distance to a rounded rectangle, in pixels. Negative inside.
 */
function roundedRect(x, y, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(x - cx) - (halfW - radius);
  const dy = Math.abs(y - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  return outside + Math.min(Math.max(dx, dy), 0) - radius;
}

/** Distance from a point to a line segment, in pixels. */
function segmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/**
 * The mark, as coverage per pixel.
 *
 * `inset` is the fraction of the canvas the mark occupies (1 for full-bleed, 0.6 for
 * the maskable safe zone). `plate` false draws the stroke with no green ground behind
 * it, which nothing currently needs but keeps the geometry honest.
 */
function render(size, { inset = 1, plate = true } = {}) {
  const pixels = new Uint8Array(size * size * 4);
  const m = size * inset; // side of the mark itself
  const originX = (size - m) / 2;
  const originY = (size - m) / 2;

  // The "M" in mark-relative units: one polyline, left foot to right foot.
  const stroke = 0.118; // full stroke width
  const points = [
    [0.27, 0.715],
    [0.27, 0.3],
    [0.5, 0.555],
    [0.73, 0.3],
    [0.73, 0.715],
  ];

  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let covered = 0;

      for (let sy = 0; sy < SS; sy += 1) {
        for (let sx = 0; sx < SS; sx += 1) {
          const x = px + (sx + 0.5) / SS;
          const y = py + (sy + 0.5) / SS;

          // Ground: the green rounded square.
          const plateD = roundedRect(x, y, size / 2, size / 2, m / 2, m / 2, m * 0.22);
          const inPlate = plate && plateD < 0;

          // The stroke.
          let inBar = false;
          for (let i = 0; i + 1 < points.length; i += 1) {
            const ax = originX + points[i][0] * m;
            const ay = originY + points[i][1] * m;
            const bx = originX + points[i + 1][0] * m;
            const by = originY + points[i + 1][1] * m;
            if (segmentDistance(x, y, ax, ay, bx, by) < (stroke * m) / 2) {
              inBar = true;
              break;
            }
          }

          if (inBar && inPlate) {
            r += PAPER[0];
            g += PAPER[1];
            b += PAPER[2];
            covered += 1;
          } else if (inPlate) {
            r += ACCENT[0];
            g += ACCENT[1];
            b += ACCENT[2];
            covered += 1;
          }
        }
      }

      // Colour is the mean of the *covered* samples, so a partly covered edge keeps
      // its own colour and only its alpha falls off. Averaging over all samples
      // instead would darken every edge toward transparent black.
      const n = SS * SS;
      const i = (py * size + px) * 4;
      pixels[i] = covered === 0 ? 0 : Math.round(r / covered);
      pixels[i + 1] = covered === 0 ? 0 : Math.round(g / covered);
      pixels[i + 2] = covered === 0 ? 0 : Math.round(b / covered);
      pixels[i + 3] = Math.round((covered / n) * 255);
    }
  }
  return pixels;
}

/** Composite RGBA over an opaque background, for formats that cannot carry alpha. */
function flatten(pixels, size, background) {
  const out = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    const a = pixels[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c += 1) {
      out[i * 4 + c] = Math.round(pixels[i * 4 + c] * a + background[c] * (1 - a));
    }
    out[i * 4 + 3] = 255;
  }
  return out;
}

/* ---------- PNG ---------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(pixels, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte (0 = None) per scanline, then the row.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    Buffer.from(pixels.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** An .ico is a directory of images; each entry here is a whole PNG. */
function ico(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = [];
  let offset = 6 + entries.length * 16;
  for (const entry of entries) {
    const row = Buffer.alloc(16);
    row[0] = entry.size >= 256 ? 0 : entry.size;
    row[1] = entry.size >= 256 ? 0 : entry.size;
    row.writeUInt16LE(1, 4); // colour planes
    row.writeUInt16LE(32, 6); // bits per pixel
    row.writeUInt32LE(entry.data.length, 8);
    row.writeUInt32LE(offset, 12);
    offset += entry.data.length;
    directory.push(row);
  }
  return Buffer.concat([header, ...directory, ...entries.map((e) => e.data)]);
}

/* ---------- write ---------- */

const here = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(here, '..', 'public');
mkdirSync(publicDir, { recursive: true });

const write = (name, buffer) => {
  writeFileSync(resolve(publicDir, name), buffer);
  process.stdout.write(`  ${name}  ${buffer.length} bytes\n`);
};

write('icon-192.png', png(render(192), 192));
write('icon-512.png', png(render(512), 512));
write('icon-maskable-512.png', png(render(512, { inset: 0.6 }), 512));
// iOS composites onto white if it sees alpha, so the ground is drawn in.
write('apple-touch-icon.png', png(flatten(render(180), 180, [0xf2, 0xf5, 0xf3]), 180));
write(
  'favicon.ico',
  ico([
    { size: 32, data: png(render(32), 32) },
    { size: 16, data: png(render(16), 16) },
  ]),
);
