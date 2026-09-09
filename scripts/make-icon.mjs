/**
 * Generates the application icon from geometry, not from a checked-in bitmap.
 *
 * The icon is a terminal prompt — a `>` chevron and a cursor bar — in
 * `--accent` on `--surface`, the same two tokens the app itself uses. It is drawn here rather than exported from a
 * design tool so the token values stay the single source of truth: if
 * `--accent` moves, this file moves with it and the icon is regenerated,
 * instead of drifting into a colour the design gates would reject.
 *
 * Zero dependencies on purpose. Shapes are evaluated as signed distance
 * fields and antialiased analytically (coverage = 0.5 - distance, clamped),
 * PNG chunks are deflated with node:zlib, and the .ico is a PNG-payload
 * container (supported by Windows since Vista). Pulling a rasteriser into
 * devDependencies to draw three strokes would cost more than it saves.
 *
 * Run:    node scripts/make-icon.mjs
 * Emits:  build/icon.ico (Windows), build/icon.png (macOS/Linux), build/icon.svg (docs)
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'build');

// ---- Tokens ------------------------------
const SURFACE = [0x16, 0x1b, 0x22]; // --surface  #161B22
const BORDER = [0x2d, 0x33, 0x3b]; // --border   #2D333B
const ACCENT = [0x22, 0xd3, 0xee]; // --accent   #22D3EE

// ---- Geometry, in a 256-unit design square ---------------------------------
// The glyph is centred as an optical whole: chevron and bar together span
// x 68..188, so the pair straddles 128 even though neither does alone.
const G = {
  size: 256,
  radius: 56, // ~22%, the Windows 11 app-tile proportion
  stroke: 22,
  chevron: [
    [79, 88],
    [123, 128],
    [79, 168],
  ],
  bar: [
    [141, 168],
    [177, 168],
  ],
};

// ---- Signed distance fields ------------------------------------------------
/** Distance from a point to the segment ab. */
function segmentDistance(px, py, a, b) {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const wx = px - a[0];
  const wy = py - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  return Math.hypot(wx - t * vx, wy - t * vy);
}

/** Signed distance to a rounded square centred in the design box. */
function roundedSquareDistance(px, py, size, radius) {
  const half = size / 2;
  const qx = Math.abs(px - half) - (half - radius);
  const qy = Math.abs(py - half) - (half - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  return outside + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Coverage for a distance given in design units: 1 well inside, 0 well outside. */
function coverage(distance, scale) {
  return Math.max(0, Math.min(1, 0.5 - distance * scale));
}

function blend(dst, i, colour, alpha) {
  if (alpha <= 0) return;
  const a = dst[i + 3] / 255;
  const outA = alpha + a * (1 - alpha);
  if (outA <= 0) return;
  for (let c = 0; c < 3; c++) {
    dst[i + c] = Math.round((colour[c] * alpha + dst[i + c] * a * (1 - alpha)) / outA);
  }
  dst[i + 3] = Math.round(outA * 255);
}

/** Render the icon at `px` pixels square into an RGBA buffer. */
function render(px) {
  const rgba = Buffer.alloc(px * px * 4);
  const unit = G.size / px; // design units per pixel
  const scale = 1 / unit; // pixels per design unit — the width of the AA ramp
  const half = G.stroke / 2;

  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const i = (y * px + x) * 4;
      const dx = (x + 0.5) * unit; // sample at the pixel centre, in design units
      const dy = (y + 0.5) * unit;

      const tile = roundedSquareDistance(dx, dy, G.size, G.radius);
      blend(rgba, i, SURFACE, coverage(tile, scale));

      // An inset hairline, so the tile keeps an edge on a dark taskbar. Inset
      // rather than an outer stroke: an outer stroke would be clipped by the
      // icon bounds and read as a ragged edge at 16px.
      const ring = Math.abs(tile + 1.6) - 1.6;
      blend(rgba, i, BORDER, coverage(ring, scale));

      // Glyph: the two chevron arms and the cursor bar, unioned by min, then
      // offset by the half stroke — which is what gives the round caps.
      let glyph = Infinity;
      for (let s = 0; s < G.chevron.length - 1; s++) {
        glyph = Math.min(glyph, segmentDistance(dx, dy, G.chevron[s], G.chevron[s + 1]));
      }
      glyph = Math.min(glyph, segmentDistance(dx, dy, G.bar[0], G.bar[1]));
      blend(rgba, i, ACCENT, coverage(glyph - half, scale));
    }
  }
  return rgba;
}

// ---- PNG encoding ----------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePng(rgba, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(px, 0);
  ihdr.writeUInt32BE(px, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  // Filter byte 0 (None) per scanline. The image is smooth gradients over a
  // flat field, so a per-line filter search buys little and costs a pass.
  const stride = px * 4 + 1;
  const raw = Buffer.alloc(px * stride);
  for (let y = 0; y < px; y++) {
    raw[y * stride] = 0;
    rgba.copy(raw, y * stride + 1, y * px * 4, (y + 1) * px * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO container ---------------------------------------------------------
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, n) => {
    const at = n * 16;
    directory[at] = entry.px >= 256 ? 0 : entry.px; // 0 encodes 256
    directory[at + 1] = entry.px >= 256 ? 0 : entry.px;
    directory[at + 2] = 0; // palette size
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.png)]);
}

// ---- SVG (documentation copy, from the same geometry) ----------------------
function encodeSvg() {
  const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const arms = G.chevron.map((p) => `${p[0]} ${p[1]}`).join(' L ');
  const inset = 1.6;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${G.size} ${G.size}" width="${G.size}" height="${G.size}">`,
    `  <rect width="${G.size}" height="${G.size}" rx="${G.radius}" fill="${hex(SURFACE)}"/>`,
    `  <rect x="${inset}" y="${inset}" width="${G.size - inset * 2}" height="${G.size - inset * 2}" rx="${G.radius - inset}" fill="none" stroke="${hex(BORDER)}" stroke-width="${inset * 2}"/>`,
    `  <g fill="none" stroke="${hex(ACCENT)}" stroke-width="${G.stroke}" stroke-linecap="round" stroke-linejoin="round">`,
    `    <path d="M ${arms}"/>`,
    `    <path d="M ${G.bar[0][0]} ${G.bar[0][1]} L ${G.bar[1][0]} ${G.bar[1][1]}"/>`,
    `  </g>`,
    `</svg>`,
    '',
  ].join('\n');
}

// ---- Emit ------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });

// Windows draws 16/32 in Explorer lists and the taskbar, 48 on the desktop and
// 256 in large-icon views; the rest are the standard intermediate steps, so
// Windows never has to downscale a mismatched size itself.
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ico = encodeIco(ICO_SIZES.map((px) => ({ px, png: encodePng(render(px), px) })));
writeFileSync(join(OUT, 'icon.ico'), ico);

// electron-builder wants one square PNG of at least 512 for Linux and derives
// the macOS .icns from it; 1024 leaves room for the Retina slice.
writeFileSync(join(OUT, 'icon.png'), encodePng(render(1024), 1024));
writeFileSync(join(OUT, 'icon.svg'), encodeSvg());

console.log(`build/icon.ico  ${ICO_SIZES.join(', ')}px  ${ico.length} bytes`);
console.log('build/icon.png  1024px');
console.log('build/icon.svg');
