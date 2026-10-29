// Renders the app icons (public/icon-*.png) without dependencies. Run once: node scripts/icons.mjs
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const CRC = new Int32Array(256).map((_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

function icon(size) {
  const bg = [0x1e, 0x3b, 0x30], fg = [0xec, 0xf0, 0xe6], gold = [0xf4, 0xdd, 0x6b]; // board green, chalk, yellow chalk
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let c = bg;
      // five people as dots in an arc, the middle one is the lead (gold, larger)
      for (let i = 0; i < 5; i++) {
        const a = Math.PI * (0.15 + 0.175 * i);
        const cx = 0.5 - 0.27 * Math.cos(a), cy = 0.62 - 0.27 * Math.sin(a);
        const r = i === 2 ? 0.1 : 0.065;
        if ((u - cx) ** 2 + (v - cy) ** 2 < r * r) c = i === 2 ? gold : fg;
      }
      // a base bar
      if (v > 0.66 && v < 0.72 && u > 0.26 && u < 0.74) c = fg;
      raw.set(c, y * (size * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [192, 512]) writeFileSync(new URL(`../public/icon-${size}.png`, import.meta.url), icon(size));
