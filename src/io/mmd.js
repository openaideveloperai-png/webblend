// MikuMikuDance files: .pmx / .pmd models and .vmd motions.
//
// Models become a skinned mesh with MMD's IK and "append" (付与) bones set up
// as bone constraints, so they pose like in MMD. Coordinates are converted
// from MMD's left-handed space (flip Z); one MMD unit is 8 cm.
import * as THREE from 'three';
import { normBoneName } from '../anim/clips.js';

export const MMD_SCALE = 0.08;

// ---------------------------------------------------------------- binary reader
class Reader {
  constructor(buffer) {
    this.u8 = new Uint8Array(buffer);
    this.dv = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength);
    this.o = 0;
  }
  check(n) { if (this.o + n > this.u8.length) throw new Error('file is truncated or not a valid MMD file'); }
  u8v() { this.check(1); return this.u8[this.o++]; }
  i8() { this.check(1); return this.dv.getInt8(this.o++); }
  u16() { this.check(2); const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
  i16() { this.check(2); const v = this.dv.getInt16(this.o, true); this.o += 2; return v; }
  u32() { this.check(4); const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
  i32() { this.check(4); const v = this.dv.getInt32(this.o, true); this.o += 4; return v; }
  f32() { this.check(4); const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  vec(n) { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = this.f32(); return a; }
  bytes(n) { this.check(n); const b = this.u8.subarray(this.o, this.o + n); this.o += n; return b; }
  skip(n) { this.check(n); this.o += n; }
  // fixed-size, zero-terminated Shift-JIS string (PMD, VMD)
  sjis(n) {
    const b = this.bytes(n);
    let e = b.indexOf(0);
    if (e < 0) e = n;
    return decodeSJIS(b.subarray(0, e));
  }
}

let sjisDecoder;
function decodeSJIS(bytes) {
  if (sjisDecoder === undefined) { try { sjisDecoder = new TextDecoder('shift_jis'); } catch { sjisDecoder = null; } }
  if (sjisDecoder) return sjisDecoder.decode(bytes).replace(/\0.*$/, '').trim();
  let s = '';
  for (const c of bytes) s += c < 128 ? String.fromCharCode(c) : '?';
  return s.trim();
}

// ---------------------------------------------------------------- PMX
export function parsePMX(buffer) {
  const r = new Reader(buffer);
  const magic = String.fromCharCode(...r.bytes(4));
  if (magic !== 'PMX ') throw new Error('not a PMX file');
  const version = r.f32();
  const nGlobals = r.u8v();
  const g = [...r.bytes(nGlobals)];
  const [encoding, addUV, vSize, tSize, mSize, bSize, morphSize] = g;
  const dec = new TextDecoder(encoding === 0 ? 'utf-16le' : 'utf-8');
  const text = () => { const n = r.i32(); if (n < 0 || n > 1e6) throw new Error('bad string in PMX file'); return dec.decode(r.bytes(n)); };
  const idx = (size, unsigned) => {
    if (size === 1) return unsigned ? r.u8v() : r.i8();
    if (size === 2) return unsigned ? r.u16() : r.i16();
    return r.i32();
  };
  const vIdx = () => idx(vSize, true), tIdx = () => idx(tSize), mIdx = () => idx(mSize), bIdx = () => idx(bSize), morphIdx = () => idx(morphSize);
  const out = { format: 'pmx', version, name: text(), nameEn: text(), comment: text(), commentEn: text() };
  // vertices
  const nv = r.i32();
  if (nv < 0 || nv > 5e6) throw new Error('bad vertex count');
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    pos[i * 3] = r.f32(); pos[i * 3 + 1] = r.f32(); pos[i * 3 + 2] = r.f32();
    nrm[i * 3] = r.f32(); nrm[i * 3 + 1] = r.f32(); nrm[i * 3 + 2] = r.f32();
    uv[i * 2] = r.f32(); uv[i * 2 + 1] = r.f32();
    r.skip(addUV * 16);
    const type = r.u8v();
    const o = i * 4;
    if (type === 0) { si[o] = Math.max(0, bIdx()); sw[o] = 1; }
    else if (type === 1) { si[o] = Math.max(0, bIdx()); si[o + 1] = Math.max(0, bIdx()); const w = r.f32(); sw[o] = w; sw[o + 1] = 1 - w; }
    else if (type === 2 || type === 4) { for (let k = 0; k < 4; k++) si[o + k] = Math.max(0, bIdx()); for (let k = 0; k < 4; k++) sw[o + k] = r.f32(); }
    else if (type === 3) { si[o] = Math.max(0, bIdx()); si[o + 1] = Math.max(0, bIdx()); const w = r.f32(); sw[o] = w; sw[o + 1] = 1 - w; r.skip(36); }
    else throw new Error('unknown vertex weight type ' + type);
    r.skip(4); // edge scale
  }
  out.vertices = { count: nv, pos, nrm, uv, si, sw };
  // faces
  const ni = r.i32();
  const index = new Uint32Array(ni);
  for (let i = 0; i < ni; i++) index[i] = vIdx();
  out.index = index;
  // textures
  const nt = r.i32();
  out.textures = [];
  for (let i = 0; i < nt; i++) out.textures.push(text());
  // materials
  const nm = r.i32();
  out.materials = [];
  for (let i = 0; i < nm; i++) {
    const m = { name: text(), nameEn: text() };
    m.diffuse = r.vec(4); m.specular = r.vec(3); m.shininess = r.f32(); m.ambient = r.vec(3);
    m.flags = r.u8v(); m.edgeColor = r.vec(4); m.edgeSize = r.f32();
    m.texture = tIdx(); m.sphere = tIdx(); m.sphereMode = r.u8v();
    const shared = r.u8v();
    m.toon = shared ? -1 - r.u8v() : tIdx();
    m.memo = text(); m.faceCount = r.i32();
    out.materials.push(m);
  }
  // bones
  const nb = r.i32();
  out.bones = [];
  for (let i = 0; i < nb; i++) {
    const b = { name: text(), nameEn: text() };
    b.pos = r.vec(3); b.parent = bIdx(); b.layer = r.i32();
    const f = r.u16();
    b.flags = f;
    if (f & 0x0001) b.tailBone = bIdx(); else b.tailOffset = r.vec(3);
    if (f & 0x0300) { b.inherit = { parent: bIdx(), ratio: r.f32(), rotate: !!(f & 0x0100), translate: !!(f & 0x0200) }; }
    if (f & 0x0400) b.fixedAxis = r.vec(3);
    if (f & 0x0800) { b.localX = r.vec(3); b.localZ = r.vec(3); }
    if (f & 0x2000) r.i32();
    if (f & 0x0020) {
      const ik = { target: bIdx(), loop: r.i32(), limit: r.f32(), links: [] };
      const nl = r.i32();
      for (let k = 0; k < nl; k++) {
        const link = { bone: bIdx(), hasLimit: !!r.u8v() };
        if (link.hasLimit) { link.min = r.vec(3); link.max = r.vec(3); }
        ik.links.push(link);
      }
      b.ik = ik;
    }
    out.bones.push(b);
  }
  // morphs
  out.morphs = [];
  try {
    const nmo = r.i32();
    for (let i = 0; i < nmo; i++) {
      const mo = { name: text(), nameEn: text(), panel: r.u8v(), type: r.u8v(), offsets: [] };
      const n = r.i32();
      if (mo.type === 1) { // vertex
        const idxs = new Uint32Array(n), d = new Float32Array(n * 3);
        for (let k = 0; k < n; k++) { idxs[k] = vIdx(); d[k * 3] = r.f32(); d[k * 3 + 1] = r.f32(); d[k * 3 + 2] = r.f32(); }
        mo.idx = idxs; mo.d = d;
      } else if (mo.type === 0 || mo.type === 9) { // group / flip
        for (let k = 0; k < n; k++) mo.offsets.push({ morph: morphIdx(), weight: r.f32() });
      } else if (mo.type === 2) { for (let k = 0; k < n; k++) { bIdx(); r.skip(28); } }
      else if (mo.type >= 3 && mo.type <= 7) { for (let k = 0; k < n; k++) { vIdx(); r.skip(16); } }
      else if (mo.type === 8) { for (let k = 0; k < n; k++) { mIdx(); r.skip(113); } }
      else if (mo.type === 10) { for (let k = 0; k < n; k++) { idx(g[7] || 4); r.skip(25); } }
      else throw new Error('unknown morph type');
      out.morphs.push(mo);
    }
  } catch (e) {
    out.morphWarning = 'some facial morphs could not be read';
  }
  return out;
}

// ---------------------------------------------------------------- PMD
export function parsePMD(buffer) {
  const r = new Reader(buffer);
  const magic = String.fromCharCode(...r.bytes(3));
  if (magic !== 'Pmd') throw new Error('not a PMD file');
  const out = { format: 'pmd', version: r.f32(), name: r.sjis(20), comment: r.sjis(256) };
  const nv = r.u32();
  if (nv > 5e6) throw new Error('bad vertex count');
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  const si = new Uint16Array(nv * 4), sw = new Float32Array(nv * 4);
  for (let i = 0; i < nv; i++) {
    pos[i * 3] = r.f32(); pos[i * 3 + 1] = r.f32(); pos[i * 3 + 2] = r.f32();
    nrm[i * 3] = r.f32(); nrm[i * 3 + 1] = r.f32(); nrm[i * 3 + 2] = r.f32();
    uv[i * 2] = r.f32(); uv[i * 2 + 1] = r.f32();
    si[i * 4] = r.u16(); si[i * 4 + 1] = r.u16();
    const w = r.u8v() / 100;
    sw[i * 4] = w; sw[i * 4 + 1] = 1 - w;
    r.u8v(); // edge flag
  }
  out.vertices = { count: nv, pos, nrm, uv, si, sw };
  const ni = r.u32();
  const index = new Uint32Array(ni);
  for (let i = 0; i < ni; i++) index[i] = r.u16();
  out.index = index;
  const nm = r.u32();
  out.materials = [];
  out.textures = [];
  for (let i = 0; i < nm; i++) {
    const m = { name: `material ${i + 1}` };
    m.diffuse = r.vec(4); m.shininess = r.f32(); m.specular = r.vec(3); m.ambient = r.vec(3);
    const toon = r.u8v(); m.toon = toon === 255 ? -1 : -2 - toon;
    const edge = r.u8v();
    m.flags = edge ? 0x10 : 0;
    m.faceCount = r.u32();
    const file = r.sjis(20);
    // "texture.bmp*sphere.sph"
    const parts = file.split('*');
    m.texture = -1; m.sphere = -1;
    for (const p of parts) {
      if (!p) continue;
      const k = out.textures.push(p) - 1;
      if (/\.sp[ha]$/i.test(p)) m.sphere = k; else m.texture = k;
    }
    // PMD materials are double-sided when translucent
    if (m.diffuse[3] < 1) m.flags |= 0x01;
    out.materials.push(m);
  }
  const nb = r.u16();
  out.bones = [];
  for (let i = 0; i < nb; i++) {
    const b = { name: r.sjis(20) };
    const parent = r.u16(), tail = r.u16(), type = r.u8v(), ikParent = r.u16();
    b.parent = parent === 0xffff ? -1 : parent;
    b.tailBone = tail === 0xffff || tail === 0 ? undefined : tail;
    b.type = type;
    b.pos = r.vec(3);
    b.flags = 0x0002 | (type === 1 || type === 2 ? 0x0004 : 0) | 0x0008 | 0x0010;
    // rotation-affected (5) and co-rotating (9) bones follow another bone
    if (type === 5 && ikParent !== 0xffff) b.inherit = { parent: ikParent, ratio: 1, rotate: true, translate: false };
    if (type === 9 && tail !== 0xffff) b.inherit = { parent: tail, ratio: ikParent / 100, rotate: true, translate: false };
    out.bones.push(b);
  }
  const nik = r.u16();
  for (let i = 0; i < nik; i++) {
    const ikBone = r.u16(), target = r.u16(), len = r.u8v(), loop = r.u16(), limit = r.f32();
    const links = [];
    for (let k = 0; k < len; k++) {
      const bone = r.u16();
      const link = { bone, hasLimit: false };
      // PMD knees can only bend one way
      if (/ひざ/.test(out.bones[bone]?.name || '')) { link.hasLimit = true; link.min = [-Math.PI, 0, 0]; link.max = [-0.0087, 0, 0]; }
      links.push(link);
    }
    if (out.bones[ikBone]) out.bones[ikBone].ik = { target, loop, limit, links };
  }
  out.morphs = [];
  try {
    const nmo = r.u16();
    let base = null;
    for (let i = 0; i < nmo; i++) {
      const name = r.sjis(20);
      const n = r.u32();
      const type = r.u8v();
      const idxs = new Uint32Array(n), d = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) { idxs[k] = r.u32(); d[k * 3] = r.f32(); d[k * 3 + 1] = r.f32(); d[k * 3 + 2] = r.f32(); }
      if (type === 0) { base = idxs; continue; }
      // indices point into the base morph's vertex list
      if (base) for (let k = 0; k < n; k++) idxs[k] = base[idxs[k]] ?? 0;
      out.morphs.push({ name, type: 1, panel: type, idx: idxs, d });
    }
  } catch {
    out.morphWarning = 'some facial morphs could not be read';
  }
  return out;
}

// ---------------------------------------------------------------- build the three.js model
// opts: loadTexture(path) -> Promise<Texture|null>, maxMorphs
export async function buildMMD(data, opts = {}) {
  const warnings = [];
  const V = data.vertices;
  const nv = V.count;
  // left-handed -> right-handed: flip Z, reverse the triangle winding
  const pos = new Float32Array(nv * 3), nrm = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let i = 0; i < nv; i++) {
    pos[i * 3] = V.pos[i * 3]; pos[i * 3 + 1] = V.pos[i * 3 + 1]; pos[i * 3 + 2] = -V.pos[i * 3 + 2];
    nrm[i * 3] = V.nrm[i * 3]; nrm[i * 3 + 1] = V.nrm[i * 3 + 1]; nrm[i * 3 + 2] = -V.nrm[i * 3 + 2];
    uv[i * 2] = V.uv[i * 2]; uv[i * 2 + 1] = 1 - V.uv[i * 2 + 1];
  }
  const nb = data.bones.length;
  const index = data.index.slice();
  for (let i = 0; i + 2 < index.length; i += 3) { const t = index[i + 1]; index[i + 1] = index[i + 2]; index[i + 2] = t; }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  const si = V.si;
  if (nb) for (let i = 0; i < si.length; i++) if (si[i] >= nb) { si[i] = 0; V.sw[i] = 0; }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(V.sw, 4));
  geo.setIndex(new THREE.BufferAttribute(index, 1));

  // materials
  const texCache = new Map();
  const tex = (i) => {
    if (i == null || i < 0 || !data.textures[i]) return null;
    if (!texCache.has(i)) texCache.set(i, opts.loadTexture ? opts.loadTexture(data.textures[i]) : Promise.resolve(null));
    return texCache.get(i);
  };
  const mats = [];
  let start = 0;
  for (const m of data.materials) {
    const mat = new THREE.MeshStandardMaterial({ name: m.name || 'material', roughness: 0.85, metalness: 0 });
    mat.color.setRGB(m.diffuse[0], m.diffuse[1], m.diffuse[2]);
    // MMD adds the ambient color on top of lighting
    mat.emissive.setRGB(m.ambient[0] * 0.25, m.ambient[1] * 0.25, m.ambient[2] * 0.25);
    mat.side = (m.flags & 0x01) ? THREE.DoubleSide : THREE.FrontSide;
    if (m.diffuse[3] < 0.999) { mat.transparent = true; mat.opacity = m.diffuse[3]; mat.depthWrite = m.diffuse[3] > 0.5; }
    if (m.diffuse[3] <= 0.001) mat.visible = false;
    const t = await tex(m.texture);
    if (t) {
      t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.needsUpdate = true;
      mat.map = t;
      // eyelashes, hair tips etc. use texture alpha
      if (/\.(png|tga|dds|webp|gif)$/i.test(data.textures[m.texture])) { mat.transparent = true; mat.alphaTest = 0.02; }
    }
    mats.push(mat);
    if (m.faceCount > 0) geo.addGroup(start, m.faceCount, mats.length - 1);
    start += m.faceCount;
  }
  if (!mats.length) mats.push(new THREE.MeshStandardMaterial({ color: 0xcccccc }));

  // bones (rest orientation is identity in MMD)
  const bones = data.bones.map((b) => {
    const bone = new THREE.Bone();
    bone.name = b.name || 'bone';
    return bone;
  });
  const world = data.bones.map((b) => new THREE.Vector3(b.pos[0], b.pos[1], -b.pos[2]));
  const roots = [];
  data.bones.forEach((b, i) => {
    const p = b.parent;
    // guard against loops / bad parents
    let ok = p >= 0 && p < nb && p !== i;
    for (let q = p, n = 0; ok && q >= 0 && n < nb; q = data.bones[q].parent, n++) if (q === i) ok = false;
    if (ok) { bones[p].add(bones[i]); bones[i].position.copy(world[i]).sub(world[p]); }
    else { roots.push(bones[i]); bones[i].position.copy(world[i]); }
  });
  // constraints + rest info for the solver
  const nameOf = (i) => (i >= 0 && i < nb ? bones[i].name : '');
  data.bones.forEach((b, i) => {
    const bone = bones[i];
    let len = 0;
    if (b.tailBone != null && b.tailBone >= 0 && b.tailBone < nb) len = world[b.tailBone].distanceTo(world[i]);
    else if (b.tailOffset) len = Math.hypot(...b.tailOffset);
    bone.userData.rest = { p: bone.position.toArray(), q: [0, 0, 0, 1], len: len || 0.5 };
    const cons = [];
    if (b.inherit && b.inherit.parent >= 0 && b.inherit.parent < nb && b.inherit.parent !== i) {
      cons.push({ type: 'INHERIT', name: 'append', influence: 1, target: '', subtarget: nameOf(b.inherit.parent), ratio: b.inherit.ratio, rotate: b.inherit.rotate, translate: b.inherit.translate, ownerSpace: 'LOCAL', targetSpace: 'LOCAL' });
    }
    if (cons.length) bone.userData.constraints = cons;
  });
  data.bones.forEach((b, i) => {
    if (!b.ik || b.ik.target < 0 || b.ik.target >= nb || !b.ik.links.length) return;
    const eff = bones[b.ik.target];
    const links = b.ik.links.filter((l) => l.bone >= 0 && l.bone < nb);
    const c = { type: 'IK', name: 'IK', influence: 1, target: '', subtarget: bones[i].name, chain: links.length, useTail: false, links: links.map((l) => bones[l.bone].name), iterations: b.ik.loop || 40, ownerSpace: 'WORLD', targetSpace: 'WORLD' };
    (eff.userData.constraints = eff.userData.constraints || []).push(c);
    for (const l of links) {
      if (!l.hasLimit) continue;
      // left-handed limits: X and Y angles flip sign (and swap min/max)
      const min = [-l.max[0], -l.max[1], l.min[2]];
      const max = [-l.min[0], -l.min[1], l.max[2]];
      bones[l.bone].userData.ik = { lock: [false, false, false], limit: [true, true, true], min, max };
    }
  });

  const mesh = new THREE.SkinnedMesh(geo, mats.length > 1 ? mats : mats[0]);
  mesh.name = data.name || 'MMD model';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  // morphs: vertex morphs, plus group morphs (expressions) flattened
  const limit = opts.maxMorphs ?? 96;
  const vMorphs = data.morphs.filter((m) => m.type === 1 && m.idx && m.idx.length);
  const groups = data.morphs.filter((m) => m.type === 0 && m.offsets.length);
  const list = [];
  for (const m of vMorphs) list.push({ name: m.name, parts: [{ m, w: 1 }] });
  for (const gm of groups) {
    const parts = gm.offsets.map((o) => ({ m: data.morphs[o.morph], w: o.weight })).filter((p) => p.m && p.m.type === 1 && p.m.idx);
    if (parts.length) list.push({ name: gm.name, parts });
  }
  if (list.length > limit) warnings.push(`kept ${limit} of ${list.length} facial morphs to save memory`);
  const used = new Set();
  const morphAttrs = [];
  const names = [];
  for (const item of list.slice(0, limit)) {
    let nm = item.name || 'morph';
    while (used.has(nm)) nm += '_';
    used.add(nm);
    const arr = new Float32Array(nv * 3);
    for (const { m, w } of item.parts) {
      for (let k = 0; k < m.idx.length; k++) {
        const v = m.idx[k];
        if (v >= nv) continue;
        arr[v * 3] += m.d[k * 3] * w; arr[v * 3 + 1] += m.d[k * 3 + 1] * w; arr[v * 3 + 2] -= m.d[k * 3 + 2] * w;
      }
    }
    const a = new THREE.BufferAttribute(arr, 3);
    a.name = nm;
    morphAttrs.push(a);
    names.push(nm);
  }
  if (morphAttrs.length) {
    geo.morphAttributes.position = morphAttrs;
    geo.morphTargetsRelative = true;
    mesh.updateMorphTargets();
    mesh.userData.shapeKeyNames = names;
  }
  if (data.morphWarning) warnings.push(data.morphWarning);

  // scene: model (scaled to meters) -> armature + mesh
  const root = new THREE.Group();
  root.name = data.name || 'MMD model';
  const scaled = new THREE.Group();
  scaled.name = 'MMD units';
  scaled.scale.setScalar(MMD_SCALE);
  root.add(scaled);
  const arm = new THREE.Group();
  arm.name = (data.name || 'MMD') + ' armature';
  for (const b of roots) arm.add(b);
  scaled.add(arm);
  scaled.add(mesh);
  root.userData.mmd = { format: data.format };
  root.updateMatrixWorld(true);
  if (nb) mesh.bind(new THREE.Skeleton(bones), mesh.matrixWorld);
  return { root, warnings, info: { vertices: nv, bones: nb, morphs: morphAttrs.length, materials: mats.length } };
}

// ---------------------------------------------------------------- VMD
export function parseVMD(buffer) {
  const r = new Reader(buffer);
  const head = decodeSJIS(r.bytes(30));
  if (!/^Vocaloid Motion Data/.test(head)) throw new Error('not a VMD motion file');
  const modelName = r.sjis(head.includes('0002') ? 20 : 10);
  const bones = new Map();
  const nb = r.u32();
  if (nb > 5e6) throw new Error('bad VMD file');
  for (let i = 0; i < nb; i++) {
    const name = r.sjis(15);
    const frame = r.u32();
    const p = r.vec(3), q = r.vec(4);
    const ip = r.bytes(64);
    if (!bones.has(name)) bones.set(name, []);
    bones.get(name).push({ frame, p, q, ip: [ip[0], ip[4], ip[8], ip[12], ip[1], ip[5], ip[9], ip[13], ip[2], ip[6], ip[10], ip[14], ip[3], ip[7], ip[11], ip[15]] });
  }
  const morphs = new Map();
  if (r.o + 4 <= r.u8.length) {
    const nm = r.u32();
    for (let i = 0; i < nm && r.o + 23 <= r.u8.length; i++) {
      const name = r.sjis(15);
      const frame = r.u32();
      const w = r.f32();
      if (!morphs.has(name)) morphs.set(name, []);
      morphs.get(name).push({ frame, w });
    }
  }
  for (const list of bones.values()) list.sort((a, b) => a.frame - b.frame);
  for (const list of morphs.values()) list.sort((a, b) => a.frame - b.frame);
  let last = 0;
  for (const l of bones.values()) last = Math.max(last, l[l.length - 1].frame);
  for (const l of morphs.values()) last = Math.max(last, l[l.length - 1].frame);
  return { modelName, bones, morphs, frames: last };
}

// MMD's per-channel bezier easing (x1, y1, x2, y2 in 0..127)
function bezier(x1, y1, x2, y2, x) {
  if (x1 === y1 && x2 === y2) return x; // linear
  x1 /= 127; y1 /= 127; x2 /= 127; y2 /= 127;
  let lo = 0, hi = 1, t = x;
  for (let i = 0; i < 18; i++) {
    t = (lo + hi) / 2;
    const bx = 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
    if (bx < x) lo = t; else hi = t;
  }
  return 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
}
const isLinear = (ip, c) => ip[c * 4] === ip[c * 4 + 1] && ip[c * 4 + 2] === ip[c * 4 + 3];

// Sample one bone's keys: every original key, plus every frame inside eased segments.
// Returns { times, pos (x,y,z MMD-space, z flipped), rot (quaternions, converted) }
export function sampleVMDBone(keys, fps = 30) {
  const frames = [];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    frames.push(k.frame);
    const n = keys[i + 1];
    if (!n || n.frame - k.frame <= 1) continue;
    const eased = [0, 1, 2, 3].some((c) => !isLinear(n.ip, c));
    if (eased) for (let f = k.frame + 1; f < n.frame; f++) frames.push(f);
  }
  const times = new Float32Array(frames.length), pos = new Float32Array(frames.length * 3), rot = new Float32Array(frames.length * 4);
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  let ki = 0;
  frames.forEach((f, j) => {
    while (ki < keys.length - 1 && keys[ki + 1].frame <= f) ki++;
    const a = keys[ki], b = keys[Math.min(ki + 1, keys.length - 1)];
    let p, q;
    if (b === a || b.frame === a.frame || f <= a.frame) { p = a.p; q = qa.set(a.q[0], a.q[1], a.q[2], a.q[3]); }
    else {
      const x = (f - a.frame) / (b.frame - a.frame);
      const ip = b.ip;
      p = [0, 1, 2].map((c) => a.p[c] + (b.p[c] - a.p[c]) * bezier(ip[c * 4], ip[c * 4 + 1], ip[c * 4 + 2], ip[c * 4 + 3], x));
      q = qa.set(a.q[0], a.q[1], a.q[2], a.q[3]).slerp(qb.set(b.q[0], b.q[1], b.q[2], b.q[3]), bezier(ip[12], ip[13], ip[14], ip[15], x));
    }
    times[j] = f / fps;
    pos[j * 3] = p[0]; pos[j * 3 + 1] = p[1]; pos[j * 3 + 2] = -p[2];
    // left-handed rotation -> right-handed: negate x and y
    rot[j * 4] = -q.x; rot[j * 4 + 1] = -q.y; rot[j * 4 + 2] = q.z; rot[j * 4 + 3] = q.w;
  });
  // keep quaternions continuous
  for (let j = 1; j < frames.length; j++) {
    const d = rot[j * 4] * rot[j * 4 - 4] + rot[j * 4 + 1] * rot[j * 4 - 3] + rot[j * 4 + 2] * rot[j * 4 - 2] + rot[j * 4 + 3] * rot[j * 4 - 1];
    if (d < 0) for (let c = 0; c < 4; c++) rot[j * 4 + c] = -rot[j * 4 + c];
  }
  return { times, pos, rot };
}

// "左腕" / "腕.L" / "腕_L" all compare equal
export function mmdKey(name) {
  let s = String(name || '').normalize ? String(name || '').normalize('NFKC') : String(name || '');
  s = s.trim();
  let side = '';
  if (/^左/.test(s)) { side = 'L'; s = s.slice(1); } else if (/^右/.test(s)) { side = 'R'; s = s.slice(1); }
  const m = /^(.*?)[._ ]?([LR])$/.exec(s);
  if (!side && m && /[^\x00-\x7f]/.test(m[1])) { side = m[2]; s = m[1]; }
  return (s + (side ? '|' + side : '')).toLowerCase();
}

// ---------------------------------------------------------------- standard skeleton for retargeting
// A typical MMD body (MMD units, already right-handed: facing +Z, left = +X).
const TEMPLATE = [
  ['全ての親', null, [0, 0, 0]], ['センター', '全ての親', [0, 8.0, 0]], ['グルーブ', 'センター', [0, 8.2, 0]],
  ['上半身', 'グルーブ', [0, 11.8, 0.1]], ['上半身2', '上半身', [0, 13.0, 0.1]], ['首', '上半身2', [0, 15.9, 0.25]], ['頭', '首', [0, 16.9, 0.1]],
  ['下半身', 'グルーブ', [0, 11.8, 0.1]],
];
for (const [S, x] of [['左', 1], ['右', -1]]) {
  TEMPLATE.push(
    [S + '肩', '上半身2', [0.35 * x, 15.4, 0.3]], [S + '腕', S + '肩', [1.5 * x, 15.1, 0.25]], [S + 'ひじ', S + '腕', [3.5 * x, 13.7, 0.2]], [S + '手首', S + 'ひじ', [5.3 * x, 12.4, 0.15]],
    [S + '足', '下半身', [0.95 * x, 10.9, 0.1]], [S + 'ひざ', S + '足', [0.95 * x, 6.0, -0.05]], [S + '足首', S + 'ひざ', [0.95 * x, 1.2, 0.2]], [S + 'つま先', S + '足首', [0.95 * x, 0.15, 1.5]],
    [S + '足ＩＫ', '全ての親', [0.95 * x, 1.2, 0.2]], [S + 'つま先ＩＫ', S + '足ＩＫ', [0.95 * x, 0.15, 1.5]],
  );
}

export function buildTemplateSkeleton() {
  const bones = new Map();
  const world = new Map();
  for (const [name, parent, p] of TEMPLATE) {
    const b = new THREE.Bone();
    b.name = name;
    world.set(name, new THREE.Vector3(...p));
    bones.set(name, b);
    if (parent) { bones.get(parent).add(b); b.position.copy(world.get(name)).sub(world.get(parent)); }
    else b.position.copy(world.get(name));
    b.userData.rest = { p: b.position.toArray(), q: [0, 0, 0, 1], len: 1 };
  }
  for (const [S] of [['左'], ['右']]) {
    bones.get(S + 'ひざ').userData.ik = { lock: [false, false, false], limit: [true, true, true], min: [0.0087, 0, 0], max: [Math.PI, 0, 0] };
    bones.get(S + '足首').userData.constraints = [{ type: 'IK', influence: 1, target: '', subtarget: S + '足ＩＫ', chain: 2, useTail: false, links: [S + 'ひざ', S + '足'], ownerSpace: 'WORLD', targetSpace: 'WORLD' }];
    bones.get(S + 'つま先').userData.constraints = [{ type: 'IK', influence: 1, target: '', subtarget: S + 'つま先ＩＫ', chain: 1, useTail: false, links: [S + '足首'], ownerSpace: 'WORLD', targetSpace: 'WORLD' }];
  }
  for (const b of bones.values()) b.userData.rest.len = (b.children.find((c) => c.isBone)?.position.length()) || 1;
  const root = new THREE.Group();
  root.name = 'MMD motion';
  const scaled = new THREE.Group();
  scaled.scale.setScalar(MMD_SCALE);
  scaled.name = 'MMD units';
  const arm = new THREE.Group();
  arm.name = 'MMD armature';
  arm.add(bones.get('全ての親'));
  scaled.add(arm);
  root.add(scaled);
  root.updateMatrixWorld(true);
  return { root, bones };
}

// VMD -> clip on the standard skeleton (for retargeting to any humanoid)
export function vmdTemplateClip(vmd, bones, name) {
  const tracks = [];
  for (const [vname, keys] of vmd.bones) {
    const b = bones.get(vname) || [...bones.values()].find((x) => mmdKey(x.name) === mmdKey(vname));
    if (!b || !keys.length) continue;
    const s = sampleVMDBone(keys);
    const rest = b.userData.rest.p;
    const p = new Float32Array(s.pos.length);
    for (let i = 0; i < s.pos.length; i += 3) { p[i] = rest[0] + s.pos[i]; p[i + 1] = rest[1] + s.pos[i + 1]; p[i + 2] = rest[2] + s.pos[i + 2]; }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.uuid}.quaternion`, s.times, s.rot));
    if (keys.some((k) => k.p[0] || k.p[1] || k.p[2])) tracks.push(new THREE.VectorKeyframeTrack(`${b.uuid}.position`, s.times, p));
  }
  const clip = new THREE.AnimationClip(name || 'Motion', -1, tracks);
  clip.resetDuration();
  return clip;
}

// VMD -> clip for a model whose bones carry MMD names (any rest orientation,
// e.g. MMD characters converted in Blender). Returns null if too few match.
export function vmdModelClip(vmd, root, name) {
  const byKey = new Map();
  root.traverse((o) => { if (o.isBone) { const k = mmdKey(o.name); if (!byKey.has(k)) byKey.set(k, o); } });
  let matched = 0, total = 0;
  const pairs = [];
  for (const [vname, keys] of vmd.bones) {
    if (!keys.length) continue;
    total++;
    const b = byKey.get(mmdKey(vname)) || byKey.get(mmdKey(normBoneName(vname)));
    if (b) { matched++; pairs.push([b, keys]); }
  }
  if (!matched || matched < Math.min(4, total)) return null;
  // how many of the main body bones matched (VMDs often carry extra bones for other models)
  const CORE = ['センター', '上半身', '首', '頭', '左腕', '右腕', '左ひじ', '右ひじ', '左足', '右足', '左足ＩＫ', '右足ＩＫ'];
  const vmdCore = CORE.filter((n) => vmd.bones.has(n));
  const coreHit = vmdCore.filter((n) => byKey.has(mmdKey(n))).length;
  root.updateMatrixWorld(true);
  // unit size: MMD leg length vs this rig's (in its armature space)
  const leg = byKey.get(mmdKey('左足')), ankle = byKey.get(mmdKey('左足首'));
  let unit = 1;
  if (leg && ankle) {
    const arm = armatureOf(leg);
    const a = arm.worldToLocal(leg.getWorldPosition(new THREE.Vector3())), c = arm.worldToLocal(ankle.getWorldPosition(new THREE.Vector3()));
    const len = a.distanceTo(c);
    if (len > 1e-6) unit = len / 9.7;
  }
  const tracks = [];
  const tmp = new THREE.Quaternion(), tmp2 = new THREE.Quaternion(), v = new THREE.Vector3();
  for (const [b, keys] of pairs) {
    const s = sampleVMDBone(keys);
    const rest = b.userData.rest;
    const Lq = rest ? new THREE.Quaternion().fromArray(rest.q) : b.quaternion.clone();
    const Lp = rest ? new THREE.Vector3().fromArray(rest.p) : b.position.clone();
    // parent's rest orientation in the model's (Y-up) space, where MMD axes live
    const Wp = new THREE.Quaternion();
    for (let p = b.parent; p && p !== root; p = p.parent) {
      const pr = p.isBone && p.userData.rest;
      Wp.premultiply(pr ? tmp.fromArray(pr.q) : p.quaternion);
    }
    const WpInv = Wp.clone().invert();
    const q = new Float32Array(s.rot.length), p = new Float32Array(s.pos.length);
    for (let i = 0; i < s.times.length; i++) {
      tmp2.fromArray(s.rot, i * 4);
      // MMD rotations are in world-aligned bone axes: L = Wp^-1 * q * Wp * Lq
      tmp.copy(WpInv).multiply(tmp2).multiply(Wp).multiply(Lq).normalize();
      tmp.toArray(q, i * 4);
      v.fromArray(s.pos, i * 3).multiplyScalar(unit).applyQuaternion(WpInv).add(Lp);
      v.toArray(p, i * 3);
    }
    for (let i = 4; i < q.length; i += 4) {
      if (q[i] * q[i - 4] + q[i + 1] * q[i - 3] + q[i + 2] * q[i - 2] + q[i + 3] * q[i - 1] < 0) for (let c = 0; c < 4; c++) q[i + c] = -q[i + c];
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.uuid}.quaternion`, s.times, q));
    if (keys.some((k) => k.p[0] || k.p[1] || k.p[2])) tracks.push(new THREE.VectorKeyframeTrack(`${b.uuid}.position`, s.times, p));
  }
  tracks.push(...vmdMorphTracks(vmd, root));
  const clip = new THREE.AnimationClip(name || 'Motion', -1, tracks);
  clip.resetDuration();
  return { clip, matched, total, core: vmdCore.length ? coreHit / vmdCore.length : 0 };
}

// facial animation: VMD morph names -> shape keys with the same name
export function vmdMorphTracks(vmd, root) {
  const tracks = [];
  const meshes = [];
  root.traverse((o) => { if (o.morphTargetDictionary) meshes.push(o); });
  for (const [name, keys] of vmd.morphs) {
    for (const m of meshes) {
      const i = m.morphTargetDictionary[name];
      if (i === undefined) continue;
      const times = new Float32Array(keys.map((k) => k.frame / 30));
      const vals = new Float32Array(keys.map((k) => k.w));
      tracks.push(new THREE.NumberKeyframeTrack(`${m.uuid}.morphTargetInfluences[${i}]`, times, vals));
    }
  }
  return tracks;
}

function armatureOf(o) {
  let p = o.parent;
  while (p && p.isBone) p = p.parent;
  return p;
}

// MMD characters exported to GLB/FBX lose their IK and D-bone setup. When a
// constraint-free rig has MMD bone names, rebuild the standard parts so
// posing and .vmd dances behave like in MMD. Returns how many were added.
export function addMMDConstraints(bones) {
  if (!bones.length || bones.some((b) => b.userData.constraints && b.userData.constraints.length)) return 0;
  const byKey = new Map();
  for (const b of bones) { const k = mmdKey(b.name); if (!byKey.has(k)) byKey.set(k, b); }
  const get = (n) => byKey.get(mmdKey(n));
  if (!get('左足ＩＫ') && !get('左足IK') && !get('左足D')) return 0;
  let n = 0;
  // remember the rest pose (bones are at rest right after import)
  for (const b of bones) if (!b.userData.rest) b.userData.rest = { p: b.position.toArray(), q: b.quaternion.toArray(), len: (b.children.find((c) => c.isBone)?.position.length()) || 0.1 };
  const add = (b, c) => { (b.userData.constraints = b.userData.constraints || []).push(c); n++; };
  for (const S of ['左', '右']) {
    const thigh = get(S + '足'), knee = get(S + 'ひざ'), ankle = get(S + '足首'), toe = get(S + 'つま先');
    const legIK = get(S + '足ＩＫ') || get(S + '足IK'), toeIK = get(S + 'つま先ＩＫ') || get(S + 'つま先IK');
    if (thigh && knee && ankle && legIK) add(ankle, { type: 'IK', influence: 1, target: '', subtarget: legIK.name, chain: 2, useTail: false, links: [knee.name, thigh.name], poleForward: true, ownerSpace: 'WORLD', targetSpace: 'WORLD' });
    if (ankle && toe && toeIK) add(toe, { type: 'IK', influence: 1, target: '', subtarget: toeIK.name, chain: 1, useTail: false, links: [ankle.name], ownerSpace: 'WORLD', targetSpace: 'WORLD' });
    for (const [ctl, def] of [[thigh, get(S + '足D')], [knee, get(S + 'ひざD')], [ankle, get(S + '足首D')]]) {
      if (ctl && def && ctl !== def) add(def, { type: 'INHERIT', influence: 1, target: '', subtarget: ctl.name, ratio: 1, rotate: true, translate: false, ownerSpace: 'LOCAL', targetSpace: 'LOCAL' });
    }
  }
  return n;
}
