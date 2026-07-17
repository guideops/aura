// Generates AURA app + tray icons as PNGs with zero dependencies.
// Design mirrors the shell's avatar: dark rounded square, two glowing eyes.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "resources", "icons");
fs.mkdirSync(dir, { recursive: true });

const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

function png(size, pixelFn) {
  // RGBA rows, each prefixed with filter byte 0.
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const row = y * (size * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = pixelFn(x, y, size);
      const o = row + 1 + x * 4;
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Dark rounded square, two blue-glow eyes, subtle smile arc. */
function botPixel(x, y, size) {
  const u = x / size, v = y / size;
  // rounded-rect mask (superellipse)
  const cx = Math.abs(u - 0.5) * 2, cy = Math.abs(v - 0.5) * 2;
  const inside = Math.pow(cx, 4) + Math.pow(cy, 4) <= Math.pow(0.92, 4);
  if (!inside) return [0, 0, 0, 0];
  // background: deep navy with slight vertical gradient
  let r = 24 + v * 10, g = 30 + v * 10, b = 44 + v * 14;
  const eye = (ex, ey) => {
    const d = Math.hypot(u - ex, v - ey);
    return d < 0.09 ? 1 : d < 0.13 ? (0.13 - d) / 0.04 : 0;
  };
  const glow = Math.max(eye(0.34, 0.42), eye(0.66, 0.42));
  if (glow > 0) {
    r = r + (140 - r) * glow;
    g = g + (205 - g) * glow;
    b = b + (255 - b) * glow;
  }
  // smile: arc of circle centered (0.5, 0.38) radius .27, lower half band
  const sd = Math.abs(Math.hypot(u - 0.5, v - 0.38) - 0.27);
  if (sd < 0.02 && v > 0.6) {
    const s = (0.02 - sd) / 0.02;
    r = r + (140 - r) * s; g = g + (205 - g) * s; b = b + (255 - b) * s;
  }
  return [Math.round(r), Math.round(g), Math.round(b), 255];
}

for (const size of [16, 32, 256]) {
  fs.writeFileSync(path.join(dir, `icon-${size}.png`), png(size, botPixel));
}
// electron-builder expects a single 256 png it can convert to .ico
fs.copyFileSync(path.join(dir, "icon-256.png"), path.join(dir, "icon.png"));
console.log(`icons written → ${dir}`);
