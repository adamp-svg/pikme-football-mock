// Minimal PNG reader — because the game canvas is TAINTED by cross-origin card art, so getImageData()
// throws a SecurityError and no in-page pixel check is possible. Screenshots are the only way to get
// pixels out, and analysing them needs a decoder. Handles what Chrome's captureScreenshot emits:
// 8-bit, non-interlaced, colour type 6 (RGBA) or 2 (RGB).
import { inflateSync } from 'node:zlib';

export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let off = 8, ihdr = null; const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], colour: data[9], interlace: data[12] };
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!ihdr) throw new Error('no IHDR');
  if (ihdr.depth !== 8 || ihdr.interlace !== 0) throw new Error(`unsupported PNG: depth ${ihdr.depth} interlace ${ihdr.interlace}`);
  const ch = ihdr.colour === 6 ? 4 : ihdr.colour === 2 ? 3 : ihdr.colour === 0 ? 1 : null;
  if (!ch) throw new Error(`unsupported colour type ${ihdr.colour}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = ihdr.w * ch, out = Buffer.alloc(ihdr.h * stride);
  let p = 0;
  for (let y = 0; y < ihdr.h; y++) {
    const filter = raw[p++];
    const line = raw.subarray(p, p + stride); p += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {                       // Paeth
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
  }
  return { w: ihdr.w, h: ihdr.h, ch, data: out };
}

// Share of pixels a predicate matches, as a percentage.
export function share(img, test) {
  let hit = 0, n = 0;
  for (let i = 0; i < img.data.length; i += img.ch) {
    if (test(img.data[i], img.data[i + 1], img.data[i + 2])) hit++;
    n++;
  }
  return { pct: +(hit / n * 100).toFixed(2), n };
}
