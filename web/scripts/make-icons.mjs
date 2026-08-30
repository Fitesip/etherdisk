// Draws the app icons (PWA, Apple touch) as PNGs without image libraries:
// signed-distance rounded rectangles with 4x4 supersampling, encoded with zlib.
// Run: node scripts/make-icons.mjs  (writes public/icons/*.png and src/app/apple-icon.png)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Signed distance to a rounded rect centred at (cx, cy) with half-size (hw, hh). */
const roundRect = (x, y, cx, cy, hw, hh, r) => {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const BG_TOP = hex("#6366f1");
const BG_BOTTOM = hex("#4338ca");
const FG = [255, 255, 255];

/**
 * The drive glyph (as in the app logo) on an indigo gradient. `pad` shrinks the
 * glyph for maskable icons, whose outer 20% may be cropped by the launcher.
 */
function draw(size, { rounded, pad }) {
  const out = Buffer.alloc(size * size * 4);
  const S = 4; // supersampling
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < S; sy++) {
        for (let sx = 0; sx < S; sx++) {
          // Unit coordinates 0..1.
          const x = (px + (sx + 0.5) / S) / size;
          const y = (py + (sy + 0.5) / S) / size;
          const inBg = rounded ? roundRect(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) <= 0 : true;
          if (!inBg) continue;
          const t = y;
          let c = BG_TOP.map((v, i) => v + (BG_BOTTOM[i] - v) * t);
          // Glyph, scaled around the centre.
          const k = 1 - pad;
          const gx = 0.5 + (x - 0.5) / k;
          const gy = 0.5 + (y - 0.5) / k;
          // Two stacked storage units, each with an indicator dot and a slot.
          const unit = (cy) => {
            const frame = Math.abs(roundRect(gx, gy, 0.5, cy, 0.3, 0.095, 0.05)) - 0.024;
            const dot = circle(gx, gy, 0.32, cy, 0.03);
            const slot = roundRect(gx, gy, 0.58, cy, 0.1, 0.014, 0.014);
            return Math.min(frame, dot, slot);
          };
          if (Math.min(unit(0.385), unit(0.615)) <= 0) c = FG;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 255;
        }
      }
      const n = S * S;
      const o = (py * size + px) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = a / n;
    }
  }
  return png(size, out);
}

const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data);
  console.log("wrote", path);
};
write(join(web, "public/icons/icon-192.png"), draw(192, { rounded: true, pad: 0.08 }));
write(join(web, "public/icons/icon-512.png"), draw(512, { rounded: true, pad: 0.08 }));
write(join(web, "public/icons/maskable-512.png"), draw(512, { rounded: false, pad: 0.3 }));
write(join(web, "src/app/apple-icon.png"), draw(180, { rounded: false, pad: 0.12 }));
