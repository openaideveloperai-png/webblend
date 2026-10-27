// DDS decoder: BC1-BC5, BC7 and uncompressed RGB(A), decoded to RGBA8 on the CPU.
// Decoding (instead of uploading compressed data) works on every GPU, and lets
// us pick the smallest mip level that is still big enough, which saves memory.

const FOURCC = (s) => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24);
const DXT1 = FOURCC('DXT1'), DXT2 = FOURCC('DXT2'), DXT3 = FOURCC('DXT3'), DXT4 = FOURCC('DXT4'), DXT5 = FOURCC('DXT5');
const ATI1 = FOURCC('ATI1'), BC4U = FOURCC('BC4U'), ATI2 = FOURCC('ATI2'), BC5U = FOURCC('BC5U'), DX10 = FOURCC('DX10');

// returns { width, height, data: Uint8Array RGBA, rows top to bottom }
export function decodeDDS(buffer, maxSize = 16384) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 128 || dv.getUint32(0, true) !== 0x20534444) throw new Error('not a DDS file');
  const height = dv.getUint32(12, true), width = dv.getUint32(16, true);
  const mipCount = Math.max(1, dv.getUint32(28, true));
  const pfFlags = dv.getUint32(80, true);
  const fourCC = dv.getUint32(84, true);
  const bitCount = dv.getUint32(88, true);
  const masks = [dv.getUint32(92, true), dv.getUint32(96, true), dv.getUint32(100, true), dv.getUint32(104, true)];
  let offset = 128;
  let kind = null; // bc1 bc2 bc3 bc4 bc5 bc7 rgba bgra masked
  if (pfFlags & 0x4) {
    if (fourCC === DXT1) kind = 'bc1';
    else if (fourCC === DXT2 || fourCC === DXT3) kind = 'bc2';
    else if (fourCC === DXT4 || fourCC === DXT5) kind = 'bc3';
    else if (fourCC === ATI1 || fourCC === BC4U) kind = 'bc4';
    else if (fourCC === ATI2 || fourCC === BC5U) kind = 'bc5';
    else if (fourCC === DX10) {
      const dxgi = dv.getUint32(128, true);
      offset = 148;
      kind = { 71: 'bc1', 72: 'bc1', 74: 'bc2', 75: 'bc2', 77: 'bc3', 78: 'bc3', 80: 'bc4', 83: 'bc5', 98: 'bc7', 99: 'bc7', 28: 'rgba', 29: 'rgba', 87: 'bgra', 91: 'bgra' }[dxgi] || null;
      if (!kind) throw new Error(dxgi === 95 || dxgi === 96 ? 'HDR (BC6H) DDS textures are not supported' : `unsupported DDS format (DXGI ${dxgi})`);
    } else throw new Error('unsupported DDS compression ' + String.fromCharCode(fourCC & 255, (fourCC >> 8) & 255, (fourCC >> 16) & 255, fourCC >>> 24));
  } else if ((pfFlags & 0x40 || pfFlags & 0x20000 || pfFlags & 0x2) && [8, 16, 24, 32].includes(bitCount)) {
    kind = 'masked';
  } else throw new Error('unsupported DDS pixel format');

  const blockBytes = { bc1: 8, bc4: 8, bc2: 16, bc3: 16, bc5: 16, bc7: 16 }[kind] || 0;
  const bpp = kind === 'rgba' || kind === 'bgra' ? 4 : kind === 'masked' ? bitCount / 8 : 0;
  const levelSize = (w, h) => blockBytes ? Math.max(1, (w + 3) >> 2) * Math.max(1, (h + 3) >> 2) * blockBytes : w * h * bpp;
  // skip mips that are bigger than needed
  let w = width, h = height, level = 0;
  while (level < mipCount - 1 && Math.max(w, h) > maxSize) {
    offset += levelSize(w, h);
    w = Math.max(1, w >> 1); h = Math.max(1, h >> 1); level++;
  }
  if (offset + levelSize(w, h) > u8.length) throw new Error('DDS file is truncated');
  const out = new Uint8Array(w * h * 4);
  if (blockBytes) decodeBlocks(kind, u8, offset, w, h, out);
  else decodeLinear(kind, u8, offset, w, h, out, bpp, masks, pfFlags);
  return { width: w, height: h, data: out };
}

function decodeLinear(kind, u8, off, w, h, out, bpp, masks, pfFlags) {
  if (kind === 'rgba' || kind === 'bgra') {
    for (let i = 0, n = w * h; i < n; i++) {
      const s = off + i * 4, d = i * 4;
      if (kind === 'rgba') { out[d] = u8[s]; out[d + 1] = u8[s + 1]; out[d + 2] = u8[s + 2]; }
      else { out[d] = u8[s + 2]; out[d + 1] = u8[s + 1]; out[d + 2] = u8[s]; }
      out[d + 3] = u8[s + 3];
    }
    return;
  }
  const chan = masks.map((m) => {
    if (!m) return null;
    let shift = 0; while (!((m >>> shift) & 1)) shift++;
    let bits = 0; while ((m >>> (shift + bits)) & 1) bits++;
    return { m, shift, max: (2 ** bits) - 1 };
  });
  const lum = !!(pfFlags & 0x20000);
  const hasAlpha = !!(pfFlags & 0x1) && chan[3];
  for (let i = 0, n = w * h; i < n; i++) {
    let v = 0;
    for (let k = 0; k < bpp; k++) v |= u8[off + i * bpp + k] << (8 * k);
    v >>>= 0;
    const get = (c) => (c ? Math.round((((v & c.m) >>> c.shift) / c.max) * 255) : 0);
    const d = i * 4;
    if (lum) { const l = get(chan[0]); out[d] = out[d + 1] = out[d + 2] = l; }
    else { out[d] = get(chan[0]); out[d + 1] = get(chan[1]); out[d + 2] = get(chan[2]); }
    out[d + 3] = hasAlpha ? get(chan[3]) : 255;
  }
}

function decodeBlocks(kind, u8, off, w, h, out) {
  const bw = Math.max(1, (w + 3) >> 2), bh = Math.max(1, (h + 3) >> 2);
  const px = new Uint8Array(64);
  const step = kind === 'bc1' || kind === 'bc4' ? 8 : 16;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      const s = off + (by * bw + bx) * step;
      switch (kind) {
        case 'bc1': bc1(u8, s, px, false); break;
        case 'bc2': bc1(u8, s + 8, px, true); bc2Alpha(u8, s, px); break;
        case 'bc3': bc1(u8, s + 8, px, true); bc3Channel(u8, s, px, 3); break;
        case 'bc4': bc3Channel(u8, s, px, 0); for (let i = 0; i < 16; i++) { px[i * 4 + 1] = px[i * 4 + 2] = px[i * 4]; px[i * 4 + 3] = 255; } break;
        case 'bc5':
          bc3Channel(u8, s, px, 0); bc3Channel(u8, s + 8, px, 1);
          for (let i = 0; i < 16; i++) {
            const x = px[i * 4] / 127.5 - 1, y = px[i * 4 + 1] / 127.5 - 1;
            px[i * 4 + 2] = Math.round((Math.sqrt(Math.max(0, 1 - x * x - y * y)) * 0.5 + 0.5) * 255);
            px[i * 4 + 3] = 255;
          }
          break;
        case 'bc7': bc7(u8, s, px); break;
        default: break;
      }
      for (let j = 0; j < 4; j++) {
        const y = by * 4 + j;
        if (y >= h) break;
        for (let i = 0; i < 4; i++) {
          const x = bx * 4 + i;
          if (x >= w) break;
          const d = (y * w + x) * 4, p = (j * 4 + i) * 4;
          out[d] = px[p]; out[d + 1] = px[p + 1]; out[d + 2] = px[p + 2]; out[d + 3] = px[p + 3];
        }
      }
    }
  }
}

function c565(x, o, p) {
  let r = (x & 0xf800) >> 8; r |= r >> 5;
  let g = (x & 0x7e0) >> 3; g |= g >> 6;
  let b = (x & 0x1f) << 3; b |= b >> 5;
  o[p] = r; o[p + 1] = g; o[p + 2] = b; o[p + 3] = 255;
}

const pal = new Uint8Array(16);
function bc1(u8, s, px, fourColor) {
  const c0 = u8[s] | (u8[s + 1] << 8), c1 = u8[s + 2] | (u8[s + 3] << 8);
  c565(c0, pal, 0); c565(c1, pal, 4);
  if (c0 > c1 || fourColor) {
    for (let k = 0; k < 3; k++) { pal[8 + k] = ((2 * pal[k] + pal[4 + k]) / 3) | 0; pal[12 + k] = ((pal[k] + 2 * pal[4 + k]) / 3) | 0; }
    pal[11] = 255; pal[15] = 255;
  } else {
    for (let k = 0; k < 3; k++) { pal[8 + k] = ((pal[k] + pal[4 + k]) / 2) | 0; pal[12 + k] = 0; }
    pal[11] = 255; pal[15] = 0;
  }
  for (let n = 0; n < 4; n++) {
    const row = u8[s + 4 + n];
    for (let o = 0; o < 4; o++) {
      const ci = (row >> (2 * o)) & 3;
      const d = (n * 4 + o) * 4;
      px[d] = pal[ci * 4]; px[d + 1] = pal[ci * 4 + 1]; px[d + 2] = pal[ci * 4 + 2]; px[d + 3] = pal[ci * 4 + 3];
    }
  }
}

function bc2Alpha(u8, s, px) {
  for (let i = 0; i < 16; i++) {
    const a = (u8[s + (i >> 1)] >> ((i & 1) * 4)) & 15;
    px[i * 4 + 3] = a * 17;
  }
}

const apal = new Uint8Array(8);
function bc3Channel(u8, s, px, ch) {
  const a0 = u8[s], a1 = u8[s + 1];
  apal[0] = a0; apal[1] = a1;
  if (a0 > a1) for (let k = 1; k < 7; k++) apal[k + 1] = (((7 - k) * a0 + k * a1) / 7) | 0;
  else { for (let k = 1; k < 5; k++) apal[k + 1] = (((5 - k) * a0 + k * a1) / 5) | 0; apal[6] = 0; apal[7] = 255; }
  const lut1 = u8[s + 2] | (u8[s + 3] << 8) | (u8[s + 4] << 16);
  const lut2 = u8[s + 5] | (u8[s + 6] << 8) | (u8[s + 7] << 16);
  for (let n = 0; n < 8; n++) px[n * 4 + ch] = apal[(lut1 >> (3 * n)) & 7];
  for (let n = 0; n < 8; n++) px[(8 + n) * 4 + ch] = apal[(lut2 >> (3 * n)) & 7];
}

// ---------------------------------------------------------------- BC7
// mode table: subsets, partition bits, rotation bits, index-selection bit,
// color bits, alpha bits, per-endpoint p-bits, shared p-bits, index bits, index bits 2
const MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0], [2, 6, 0, 0, 6, 0, 0, 1, 3, 0], [3, 6, 0, 0, 5, 0, 0, 0, 2, 0], [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3], [1, 0, 2, 0, 7, 8, 0, 0, 2, 2], [1, 0, 0, 0, 7, 7, 1, 0, 4, 0], [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
];
const P2 = [0xcccc, 0x8888, 0xeeee, 0xecc8, 0xc880, 0xfeec, 0xfec8, 0xec80, 0xc800, 0xffec, 0xfe80, 0xe800, 0xffe8, 0xff00, 0xfff0, 0xf000,
  0xf710, 0x008e, 0x7100, 0x08ce, 0x008c, 0x7310, 0x3100, 0x8cce, 0x088c, 0x3110, 0x6666, 0x366c, 0x17e8, 0x0ff0, 0x718e, 0x399c,
  0xaaaa, 0xf0f0, 0x5a5a, 0x33cc, 0x3c3c, 0x55aa, 0x9696, 0xa55a, 0x73ce, 0x13c8, 0x324c, 0x3bdc, 0x6996, 0xc33c, 0x9966, 0x0660,
  0x0272, 0x04e4, 0x4e40, 0x2720, 0xc936, 0x936c, 0x39c6, 0x639c, 0x9336, 0x9cc6, 0x817e, 0xe718, 0xccf0, 0x0fcc, 0x7744, 0xee22];
const P3 = [0xaa685050, 0x6a5a5040, 0x5a5a4200, 0x5450a0a8, 0xa5a50000, 0xa0a05050, 0x5555a0a0, 0x5a5a5050, 0xaa550000, 0xaa555500,
  0xaaaa5500, 0x90909090, 0x94949494, 0xa4a4a4a4, 0xa9a59450, 0x2a0a4250, 0xa5945040, 0x0a425054, 0xa5a5a500, 0x55a0a0a0,
  0xa8a85454, 0x6a6a4040, 0xa4a45000, 0x1a1a0500, 0x0050a4a4, 0xaaa59090, 0x14696914, 0x69691400, 0xa08585a0, 0xaa821414,
  0x50a4a450, 0x6a5a0200, 0xa9a58000, 0x5090a0a8, 0xa8a09050, 0x24242424, 0x00aa5500, 0x24924924, 0x24499224, 0x50a50a50,
  0x500aa550, 0xaaaa4444, 0x66660000, 0xa5a0a5a0, 0x50a050a0, 0x69286928, 0x44aaaa44, 0x66666600, 0xaa444444, 0x54a854a8,
  0x95809580, 0x96969600, 0xa85454a8, 0x80959580, 0xaa141414, 0x96960000, 0xaaaa1414, 0xa05050a0, 0xa0a5a5a0, 0x96000000,
  0x40804080, 0xa9a8a9a8, 0xaaaaaa44, 0x2a4a5254];
const A2 = [15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 2, 8, 2, 2, 8, 8, 15, 2, 8, 2, 2, 8, 8, 2, 2,
  15, 15, 6, 8, 2, 8, 15, 15, 2, 8, 2, 2, 2, 15, 15, 6, 6, 2, 6, 8, 15, 15, 2, 2, 15, 15, 15, 15, 15, 2, 2, 15];
const A3a = [3, 3, 15, 15, 8, 3, 15, 15, 8, 8, 6, 6, 6, 5, 3, 3, 3, 3, 8, 15, 3, 3, 6, 10, 5, 8, 8, 6, 8, 5, 15, 15,
  8, 15, 3, 5, 6, 10, 8, 15, 15, 3, 15, 5, 15, 15, 15, 15, 3, 15, 5, 5, 5, 8, 5, 10, 5, 10, 8, 13, 15, 12, 3, 3];
const A3b = [15, 8, 8, 3, 15, 15, 3, 8, 15, 15, 15, 15, 15, 15, 15, 8, 15, 8, 15, 3, 15, 8, 15, 8, 3, 15, 6, 10, 15, 15, 10, 8,
  15, 3, 15, 10, 10, 8, 9, 10, 6, 15, 8, 15, 3, 6, 6, 8, 15, 3, 15, 15, 15, 15, 15, 15, 15, 15, 15, 15, 3, 15, 15, 8];
const W = { 2: [0, 21, 43, 64], 3: [0, 9, 18, 27, 37, 46, 55, 64], 4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64] };

const ep = new Uint8Array(24); // 6 endpoints x rgba
function bits(u8, s, pos, n) {
  let v = 0;
  for (let k = 0; k < n; k++) { const b = pos + k; v |= ((u8[s + (b >> 3)] >> (b & 7)) & 1) << k; }
  return v;
}

function bc7(u8, s, px) {
  const first = u8[s];
  if (!first) { for (let i = 0; i < 16; i++) { px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = 0; px[i * 4 + 3] = 255; } return; }
  let mode = 0;
  while (!(first & (1 << mode))) mode++;
  let pos = mode + 1;
  const [ns, pb, rb, isb, cb0, ab0, epb, spb, ib, ib2] = MODES[mode];
  const partition = bits(u8, s, pos, pb); pos += pb;
  const rotation = bits(u8, s, pos, rb); pos += rb;
  const indexSel = bits(u8, s, pos, isb); pos += isb;
  const numep = ns * 2;
  let cb = cb0, ab = ab0;
  for (let c = 0; c < 3; c++) for (let i = 0; i < numep; i++) { ep[i * 4 + c] = bits(u8, s, pos, cb); pos += cb; }
  for (let i = 0; i < numep; i++) { if (ab) { ep[i * 4 + 3] = bits(u8, s, pos, ab); pos += ab; } else ep[i * 4 + 3] = 255; }
  if (epb) {
    cb++; if (ab) ab++;
    for (let i = 0; i < numep; i++) {
      const p = bits(u8, s, pos, 1); pos++;
      for (let c = 0; c < (ab ? 4 : 3); c++) ep[i * 4 + c] = (ep[i * 4 + c] << 1) | p;
    }
  }
  if (spb) {
    cb++; if (ab) ab++;
    for (let i = 0; i < numep; i += 2) {
      const p = bits(u8, s, pos, 1); pos++;
      for (let j = 0; j < 2; j++) for (let c = 0; c < (ab ? 4 : 3); c++) ep[(i + j) * 4 + c] = (ep[(i + j) * 4 + c] << 1) | p;
    }
  }
  for (let i = 0; i < numep; i++) {
    for (let c = 0; c < 3; c++) { const v = (ep[i * 4 + c] << (8 - cb)) & 255; ep[i * 4 + c] = v | (v >> cb); }
    if (ab) { const v = (ep[i * 4 + 3] << (8 - ab)) & 255; ep[i * 4 + 3] = v | (v >> ab); }
  }
  const cw = W[ib], aw = W[(ab0 && ib2) ? ib2 : ib];
  let cbit = pos;
  let abit = cbit + 16 * ib - ns;
  for (let i = 0; i < 16; i++) {
    const sub = ns === 2 ? (P2[partition] >> i) & 1 : ns === 3 ? (P3[partition] >>> (2 * i)) & 3 : 0;
    let n = ib;
    if (i === 0) n--;
    else if (ns === 2 && i === A2[partition]) n--;
    else if (ns === 3 && (i === A3a[partition] || i === A3b[partition])) n--;
    const i0 = bits(u8, s, cbit, n); cbit += n;
    let s0, s1;
    if (ab0 && ib2) {
      const n2 = i === 0 ? ib2 - 1 : ib2;
      const i1 = bits(u8, s, abit, n2); abit += n2;
      if (indexSel) { s0 = aw[i1]; s1 = cw[i0]; } else { s0 = cw[i0]; s1 = aw[i1]; }
    } else { s0 = s1 = cw[i0]; }
    const e = sub * 8, d = i * 4;
    const t0 = 64 - s0, t1 = 64 - s1;
    px[d] = (t0 * ep[e] + s0 * ep[e + 4] + 32) >> 6;
    px[d + 1] = (t0 * ep[e + 1] + s0 * ep[e + 5] + 32) >> 6;
    px[d + 2] = (t0 * ep[e + 2] + s0 * ep[e + 6] + 32) >> 6;
    px[d + 3] = (t1 * ep[e + 3] + s1 * ep[e + 7] + 32) >> 6;
    if (rotation) { const c = rotation - 1, t = px[d + c]; px[d + c] = px[d + 3]; px[d + 3] = t; }
  }
}
