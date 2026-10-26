// Low-level .blend reader: header, file blocks and SDNA (struct definitions).
// Supports Blender 2.5x - 5.x files, 32/64-bit pointers, little/big endian,
// gzip (old) and zstd (3.0+) compression.
//
// Pointer lookups are scoped like Blender's own reader: DATA blocks belong to
// the ID block written before them, and data pointers only need to be unique
// inside that ID (Blender 5 writes small per-ID pointer values). ID pointers
// are resolved globally.

import { gunzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { decompress as zstdDecompress } from 'fzstd';

const latin1 = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');

export function decompressBlend(u8) {
  if (u8[0] === 0x1f && u8[1] === 0x8b) return gunzipSync(u8);
  if (u8[0] === 0x28 && u8[1] === 0xb5 && u8[2] === 0x2f && u8[3] === 0xfd) return zstdDecompress(u8);
  return u8;
}

export class StructView {
  constructor(bf, offset, def, scope) {
    this.bf = bf;
    this.offset = offset;
    this.def = def;
    this.scope = scope; // owning ID block (for scoped pointer lookups)
  }
  has(name) { return this.def.fieldMap.has(name); }
  field(name) { return this.def.fieldMap.get(name); }
  get(name, fallback) {
    const f = this.def.fieldMap.get(name);
    if (!f) return fallback;
    return this.bf.readField(this.offset + f.offset, f, this.scope);
  }
  // first existing field among aliases (renamed members across versions)
  any(names, fallback) {
    for (const n of names) {
      const f = this.def.fieldMap.get(n);
      if (f) return this.bf.readField(this.offset + f.offset, f, this.scope);
    }
    return fallback;
  }
  ptr(name) {
    const f = this.def.fieldMap.get(name);
    if (!f || !f.isPointer) return 0n;
    return this.bf.readPtr(this.offset + f.offset);
  }
  str(name) {
    const f = this.def.fieldMap.get(name);
    if (!f) return '';
    return this.bf.readCString(this.offset + f.offset, f.size);
  }
  // follow a pointer field to a struct view (optionally forcing struct type)
  deref(name, structName) {
    return this.bf.viewAtPtr(this.ptr(name), structName, this.scope);
  }
  // follow a pointer field to its raw block
  block(name) {
    return this.bf.blockAt(this.ptr(name), this.scope);
  }
  idName() {
    const id = this.get('id');
    if (!id) return '';
    return id.str('name').slice(2);
  }
  // ID type code (e.g. 'OB', 'ME') from id.name
  idCode() {
    const id = this.get('id');
    if (!id) return '';
    return id.str('name').slice(0, 2);
  }
}

export class BlendFile {
  constructor(input) {
    let u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
    u8 = decompressBlend(u8);
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.parseHeader();
    this.parseBlocks();
    this.parseSDNA();
  }

  parseHeader() {
    const u8 = this.u8;
    if (latin1.decode(u8.subarray(0, 7)) !== 'BLENDER') throw new Error('Not a .blend file');
    // Legacy: "BLENDER" + ptr('_'|'-') + endian('v'|'V') + "ver" (12 bytes)
    // 5.0+:  "BLENDER" + "17" (header size) + "-" + "01" (format) + "v" + "0500"
    const c7 = String.fromCharCode(u8[7]);
    if (c7 === '_' || c7 === '-') {
      this.pointerSize = c7 === '_' ? 4 : 8;
      this.littleEndian = String.fromCharCode(u8[8]) === 'v';
      this.version = parseInt(latin1.decode(u8.subarray(9, 12)), 10);
      this.headerSize = 12;
      this.fileFormat = 0;
      this.largeBHead = false;
    } else {
      const hsize = parseInt(latin1.decode(u8.subarray(7, 9)), 10);
      this.headerSize = hsize || 17;
      this.pointerSize = 8;
      this.fileFormat = parseInt(latin1.decode(u8.subarray(10, 12)), 10);
      this.littleEndian = String.fromCharCode(u8[12]) === 'v';
      this.version = parseInt(latin1.decode(u8.subarray(13, 17)), 10);
      this.largeBHead = this.fileFormat >= 1;
    }
  }

  parseBlocks() {
    const dv = this.dv, le = this.littleEndian, u8 = this.u8;
    const blocks = [];
    const idByPtr = new Map();   // ID (and other non-DATA) blocks, global
    const anyByPtr = new Map();  // fallback: first block with that pointer
    const byCode = new Map();
    let off = this.headerSize;
    const ps = this.pointerSize;
    let owner = null;
    while (off + 16 <= u8.length) {
      let e = off;
      while (e < off + 4 && u8[e] !== 0) e++;
      const code = latin1.decode(u8.subarray(off, e));
      let size, oldPtr, sdna, count, headSize;
      if (this.largeBHead) {
        sdna = dv.getInt32(off + 4, le);
        oldPtr = dv.getBigUint64(off + 8, le);
        size = Number(dv.getBigInt64(off + 16, le));
        count = Number(dv.getBigInt64(off + 24, le));
        headSize = 32;
      } else if (ps === 8) {
        size = dv.getInt32(off + 4, le);
        oldPtr = dv.getBigUint64(off + 8, le);
        sdna = dv.getInt32(off + 16, le);
        count = dv.getInt32(off + 20, le);
        headSize = 24;
      } else {
        size = dv.getInt32(off + 4, le);
        oldPtr = BigInt(dv.getUint32(off + 8, le));
        sdna = dv.getInt32(off + 12, le);
        count = dv.getInt32(off + 16, le);
        headSize = 20;
      }
      if (code === 'ENDB') break;
      if (size < 0 || off + headSize + size > u8.length) break;
      const block = { code, size, oldPtr, sdna, count, offset: off + headSize, owner: null, dataMap: null };
      blocks.push(block);
      if (code === 'DATA') {
        block.owner = owner;
        if (owner && oldPtr !== 0n) {
          if (!owner.dataMap) owner.dataMap = new Map();
          if (!owner.dataMap.has(oldPtr)) owner.dataMap.set(oldPtr, block);
        }
      } else {
        owner = block;
        if (oldPtr !== 0n && !idByPtr.has(oldPtr)) idByPtr.set(oldPtr, block);
      }
      if (oldPtr !== 0n && !anyByPtr.has(oldPtr)) anyByPtr.set(oldPtr, block);
      let arr = byCode.get(code);
      if (!arr) byCode.set(code, (arr = []));
      arr.push(block);
      off += headSize + size;
    }
    this.blocks = blocks;
    this.idByPtr = idByPtr;
    this.anyByPtr = anyByPtr;
    this.byCode = byCode;
  }

  parseSDNA() {
    const dna = (this.byCode.get('DNA1') || [])[0];
    if (!dna) throw new Error('.blend has no DNA1 block');
    const u8 = this.u8, dv = this.dv, le = this.littleEndian;
    let p = dna.offset;
    const base = dna.offset;
    const expect = (s) => {
      const got = latin1.decode(u8.subarray(p, p + 4));
      if (got !== s) throw new Error(`SDNA: expected ${s} got ${got}`);
      p += 4;
    };
    const align4 = () => { p = base + ((p - base + 3) & ~3); };
    const readStrings = (n) => {
      const out = new Array(n);
      for (let i = 0; i < n; i++) {
        let e = p;
        while (u8[e] !== 0) e++;
        out[i] = latin1.decode(u8.subarray(p, e));
        p = e + 1;
      }
      return out;
    };
    expect('SDNA');
    expect('NAME');
    const nNames = dv.getInt32(p, le); p += 4;
    const names = readStrings(nNames);
    align4();
    expect('TYPE');
    const nTypes = dv.getInt32(p, le); p += 4;
    const types = readStrings(nTypes);
    align4();
    expect('TLEN');
    const tlen = new Array(nTypes);
    for (let i = 0; i < nTypes; i++) { tlen[i] = dv.getUint16(p, le); p += 2; }
    align4();
    expect('STRC');
    const nStructs = dv.getInt32(p, le); p += 4;
    const structs = new Array(nStructs);
    const structByType = new Map();
    const ps = this.pointerSize;
    for (let i = 0; i < nStructs; i++) {
      const typeIdx = dv.getInt16(p, le); p += 2;
      const nFields = dv.getInt16(p, le); p += 2;
      const fields = [];
      const fieldMap = new Map();
      let fo = 0;
      for (let j = 0; j < nFields; j++) {
        const ft = dv.getInt16(p, le); p += 2;
        const fn = dv.getInt16(p, le); p += 2;
        const rawName = names[fn];
        const isFuncPtr = rawName.startsWith('(*');
        const isPointer = rawName.startsWith('*') || isFuncPtr;
        const ptrDepth = isFuncPtr ? 1 : (rawName.match(/^\*+/) || [''])[0].length;
        const base2 = rawName.replace(/^\(?\*+/, '').replace(/\)\(.*$/, '').replace(/\[.*$/, '');
        const dims = [];
        rawName.replace(/\[(\d+)\]/g, (_, d) => { dims.push(parseInt(d, 10)); return ''; });
        const count = dims.reduce((a, b) => a * b, 1);
        const elemSize = isPointer ? ps : tlen[ft];
        const f = {
          name: base2, rawName, type: types[ft], typeIdx: ft, isPointer, ptrDepth, dims, count,
          elemSize, size: elemSize * count, offset: fo,
        };
        fo += f.size;
        fields.push(f);
        if (!fieldMap.has(base2)) fieldMap.set(base2, f);
      }
      const def = { index: i, typeIdx, name: types[typeIdx], size: tlen[typeIdx], fields, fieldMap };
      structs[i] = def;
      structByType.set(def.name, def);
    }
    this.sdna = { names, types, tlen, structs, structByType };
  }

  structDef(name) { return this.sdna.structByType.get(name); }
  blockStruct(block) { return this.sdna.structs[block.sdna]; }
  scopeOf(block) { return block.code === 'DATA' ? block.owner : block; }

  // StructView for element i of a block
  view(block, i = 0, def) {
    if (!block) return null;
    def = def || this.blockStruct(block);
    if (!def) return null;
    return new StructView(this, block.offset + i * def.size, def, this.scopeOf(block));
  }

  blockAt(ptr, scope) {
    if (!ptr) return null;
    if (scope && scope.dataMap) {
      const b = scope.dataMap.get(ptr);
      if (b) return b;
    }
    return this.idByPtr.get(ptr) || this.anyByPtr.get(ptr) || null;
  }

  viewAtPtr(ptr, structName, scope) {
    if (!ptr) return null;
    const b = this.blockAt(ptr, scope);
    if (!b) return null;
    const def = structName ? this.structDef(structName) : this.blockStruct(b);
    if (!def) return null;
    return new StructView(this, b.offset, def, this.scopeOf(b));
  }

  readPtr(off) {
    return this.pointerSize === 8 ? this.dv.getBigUint64(off, this.littleEndian) : BigInt(this.dv.getUint32(off, this.littleEndian));
  }

  readCString(off, maxLen) {
    const u8 = this.u8;
    let e = off;
    const end = Math.min(off + maxLen, u8.length);
    while (e < end && u8[e] !== 0) e++;
    return utf8.decode(u8.subarray(off, e));
  }

  // C string stored in its own DATA block (char *name)
  stringAt(ptr, scope) {
    const b = this.blockAt(ptr, scope);
    return b ? this.readCString(b.offset, b.size) : '';
  }

  readPrim(off, type) {
    const dv = this.dv, le = this.littleEndian;
    switch (type) {
      case 'char': return dv.getInt8(off);
      case 'uchar': case 'uint8_t': return dv.getUint8(off);
      case 'int8_t': return dv.getInt8(off);
      case 'short': case 'int16_t': return dv.getInt16(off, le);
      case 'ushort': case 'uint16_t': return dv.getUint16(off, le);
      case 'int': case 'int32_t': return dv.getInt32(off, le);
      case 'uint': case 'uint32_t': return dv.getUint32(off, le);
      case 'float': return dv.getFloat32(off, le);
      case 'double': return dv.getFloat64(off, le);
      case 'long': return dv.getInt32(off, le);
      case 'ulong': return dv.getUint32(off, le);
      case 'int64_t': return Number(dv.getBigInt64(off, le));
      case 'uint64_t': return Number(dv.getBigUint64(off, le));
      default: return undefined;
    }
  }

  readField(off, f, scope) {
    if (f.isPointer) {
      if (f.count === 1) return this.readPtr(off);
      const out = [];
      for (let i = 0; i < f.count; i++) out.push(this.readPtr(off + i * this.pointerSize));
      return out;
    }
    const def = this.sdna.structByType.get(f.type);
    if (def) {
      if (f.count === 1) return new StructView(this, off, def, scope);
      const out = [];
      for (let i = 0; i < f.count; i++) out.push(new StructView(this, off + i * def.size, def, scope));
      return out;
    }
    if (f.type === 'char' && f.count > 1) return this.readCString(off, f.count);
    if (f.count === 1) return this.readPrim(off, f.type);
    const out = new Array(f.count);
    for (let i = 0; i < f.count; i++) out[i] = this.readPrim(off + i * f.elemSize, f.type);
    return out;
  }

  // iterate a ListBase {first,last} of structs linked by `next`
  *listBase(lb, structName) {
    if (!lb) return;
    let p = lb.ptr('first');
    let scope = lb.scope;
    let guard = 0;
    while (p && guard++ < 1e6) {
      const v = this.viewAtPtr(p, structName, scope);
      if (!v) break;
      yield v;
      scope = v.scope;
      p = v.ptr('next');
    }
  }

  // array of pointers stored in a DATA block (e.g. Material **mat)
  pointerArray(ptr, count, scope) {
    const b = this.blockAt(ptr, scope);
    if (!b) return [];
    const n = Math.min(count ?? Math.floor(b.size / this.pointerSize), Math.floor(b.size / this.pointerSize));
    const out = [];
    for (let i = 0; i < n; i++) out.push(this.readPtr(b.offset + i * this.pointerSize));
    return out;
  }

  float32Array(ptr, count, scope) {
    const b = this.blockAt(ptr, scope);
    if (!b) return null;
    const n = Math.min(count ?? (b.size >> 2), b.size >> 2);
    const out = new Float32Array(n);
    const dv = this.dv, le = this.littleEndian;
    for (let i = 0; i < n; i++) out[i] = dv.getFloat32(b.offset + i * 4, le);
    return out;
  }

  int32Array(ptr, count, scope) {
    const b = this.blockAt(ptr, scope);
    if (!b) return null;
    const n = Math.min(count ?? (b.size >> 2), b.size >> 2);
    const out = new Int32Array(n);
    const dv = this.dv, le = this.littleEndian;
    for (let i = 0; i < n; i++) out[i] = dv.getInt32(b.offset + i * 4, le);
    return out;
  }

  uint8Array(ptr, count, scope) {
    const b = this.blockAt(ptr, scope);
    if (!b) return null;
    const n = Math.min(count ?? b.size, b.size);
    return this.u8.slice(b.offset, b.offset + n);
  }

  idBlocks(code) { return this.byCode.get(code) || []; }
}
