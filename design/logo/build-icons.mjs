// Renders the site's icons from etherdisk-logo.svg. Run from the repo root:
//   node design/logo/build-icons.mjs
// (uses sharp from web/node_modules).
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../web/package.json", import.meta.url));
const sharp = require("sharp");

const logo = readFileSync(new URL("etherdisk-logo.svg", import.meta.url), "utf8");
const web = (p) => new URL(`../../web/${p}`, import.meta.url);

// Square, no rounding: iOS and Android masks round the corners themselves.
const fullBleed = logo.replace('rx="15" ', "");
// Maskable: the drawing shrunk into the 80% safe zone of a full background.
const maskable = fullBleed.replace(/(<rect[^>]*\/>)(.*)<\/svg>/, '$1<g transform="translate(32 32) scale(.74) translate(-32 -33)">$2</g></svg>');

const png = (svg, size) => sharp(Buffer.from(svg), { density: (72 * size) / 64 }).resize(size, size).png().toBuffer();

/** An .ico holding PNG images (supported by every current browser). */
function ico(images) {
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach(({ size, data }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e);
    head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4);
    head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(data.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([head, ...images.map((x) => x.data)]);
}

const sizes = [16, 32, 48];
writeFileSync(web("src/app/favicon.ico"), ico(await Promise.all(sizes.map(async (size) => ({ size, data: await png(logo, size) })))));
writeFileSync(web("src/app/icon.svg"), logo);
writeFileSync(web("src/app/apple-icon.png"), await png(fullBleed, 180));
writeFileSync(web("public/icons/icon-192.png"), await png(logo, 192));
writeFileSync(web("public/icons/icon-512.png"), await png(logo, 512));
writeFileSync(web("public/icons/maskable-512.png"), await png(maskable, 512));
console.log("icons written");
