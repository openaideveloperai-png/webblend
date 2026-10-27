// Minecraft-style models: Java block/item models (assets/<ns>/models/**.json, with
// vanilla parents like cube_all and item/generated), Bedrock / GeckoLib entity
// geometry (*.geo.json) with *.animation.json clips (Molang included), and
// Blockbench .bbmodel files. 16 pixels = 1 block = 1 meter; characters face +Z.
import * as THREE from 'three';

const D2R = Math.PI / 180;

// ---------------------------------------------------------------- textures
// pixel art stays crisp; an animated strip (frames stacked vertically) shows frame 1
export function pixelTexture(tex) {
  if (!tex) return tex;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

async function loadImageTex(blob) {
  if (!blob) return null;
  try {
    const bmp = await createImageBitmap(blob);
    const t = new THREE.Texture(bmp);
    t.flipY = true;
    // ImageBitmap ignores flipY on upload; draw through a canvas so orientation is standard
    const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(bmp.width, bmp.height) : Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
    cv.getContext('2d').drawImage(bmp, 0, 0);
    const ct = new THREE.CanvasTexture(cv);
    ct.userData.size = [bmp.width, bmp.height];
    bmp.close?.();
    return pixelTexture(ct);
  } catch { return null; }
}

function matFor(tex, opts = {}) {
  const m = new THREE.MeshStandardMaterial({ map: tex || null, color: tex ? 0xffffff : 0xb0b4ba, roughness: 0.9, metalness: 0, alphaTest: tex ? 0.1 : 0, side: opts.double ? THREE.DoubleSide : THREE.FrontSide });
  m.name = opts.name || (tex && tex.name) || 'material';
  return m;
}

// ---------------------------------------------------------------- cube builder
// Faces in Minecraft / Blockbench space (front = north = -Z): corners seen from outside,
// top-left, top-right, bottom-right, bottom-left.
const FACES = {
  north: (f, t) => [[t[0], t[1], f[2]], [f[0], t[1], f[2]], [f[0], f[1], f[2]], [t[0], f[1], f[2]]],
  south: (f, t) => [[f[0], t[1], t[2]], [t[0], t[1], t[2]], [t[0], f[1], t[2]], [f[0], f[1], t[2]]],
  east: (f, t) => [[t[0], t[1], t[2]], [t[0], t[1], f[2]], [t[0], f[1], f[2]], [t[0], f[1], t[2]]],
  west: (f, t) => [[f[0], t[1], f[2]], [f[0], t[1], t[2]], [f[0], f[1], t[2]], [f[0], f[1], f[2]]],
  up: (f, t) => [[f[0], t[1], f[2]], [t[0], t[1], f[2]], [t[0], t[1], t[2]], [f[0], t[1], t[2]]],
  down: (f, t) => [[f[0], f[1], t[2]], [t[0], f[1], t[2]], [t[0], f[1], f[2]], [f[0], f[1], f[2]]],
};
// Java's default UVs when a face gives none (from the element's position)
function defaultUV(dir, f, t) {
  switch (dir) {
    case 'north': return [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]];
    case 'south': return [f[0], 16 - t[1], t[0], 16 - f[1]];
    case 'east': return [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]];
    case 'west': return [f[2], 16 - t[1], t[2], 16 - f[1]];
    case 'up': return [f[0], f[2], t[0], t[2]];
    default: return [f[0], 16 - t[2], t[0], 16 - f[2]];
  }
}

// elements: [{ from, to, inflate, rotate(v) (optional, px space), faces: {dir: {uv, rotation, tex, uvSize: [w, h]}} }]
// T maps a px-space point to the output frame; `mirror` = T flips handedness.
// -> Map(texKey -> {pos, uv, nrm, idx})
function buildCubes(elements, T, mirror) {
  const groups = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3();
  for (const el of elements) {
    const inf = el.inflate || 0;
    const f = [el.from[0] - inf, el.from[1] - inf, el.from[2] - inf], t = [el.to[0] + inf, el.to[1] + inf, el.to[2] + inf];
    for (const [dir, face] of Object.entries(el.faces || {})) {
      if (!face || !FACES[dir]) continue;
      // zero-thickness faces on the flat side of a plane still render (double sided)
      const corners = FACES[dir](f, t).map((p) => { const v = new THREE.Vector3(...p); if (el.rotate) el.rotate(v); return T(v); });
      const uv = face.uv && face.uv.length >= 4 ? face.uv : defaultUV(dir, el.from, el.to);
      const [uw, vh] = face.uvSize || [16, 16];
      const k = face.frameAspect || 1; // first frame of an animated strip
      let tc = [[uv[0], uv[1]], [uv[2], uv[1]], [uv[2], uv[3]], [uv[0], uv[3]]];
      const rot = (((face.rotation || 0) % 360) + 360) % 360;
      for (let r = 0; r < rot / 90; r++) tc = [tc[3], tc[0], tc[1], tc[2]];
      const key = face.tex ?? '';
      if (!groups.has(key)) groups.set(key, { pos: [], uv: [], nrm: [], idx: [] });
      const g = groups.get(key);
      const base = g.pos.length / 3;
      a.copy(corners[0]); b.copy(corners[1]); c.copy(corners[3]);
      n.subVectors(b, a).cross(c.sub(a)).normalize(); // (tr - tl) x (bl - tl) points out
      if (mirror) n.negate();
      if (!Number.isFinite(n.x)) n.set(0, 1, 0);
      corners.forEach((p, i) => {
        g.pos.push(p.x, p.y, p.z);
        g.uv.push(tc[i][0] / uw, 1 - (tc[i][1] / vh) * k);
        g.nrm.push(n.x, n.y, n.z);
      });
      // outward winding: tl, bl, br / tl, br, tr (flipped when the frame mirrors)
      if (!mirror) g.idx.push(base, base + 3, base + 2, base, base + 2, base + 1);
      else g.idx.push(base, base + 2, base + 3, base, base + 1, base + 2);
    }
  }
  return groups;
}

function meshesFrom(groups, mats, name) {
  const out = [];
  for (const [key, g] of groups) {
    if (!g.idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(g.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(g.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(g.uv, 2));
    geo.setIndex(g.idx);
    geo.computeBoundingSphere();
    const m = new THREE.Mesh(geo, mats(key));
    m.name = name + (groups.size > 1 && key !== '' ? ` (${String(key).replace(/^#/, '')})` : '');
    m.castShadow = m.receiveShadow = true;
    out.push(m);
  }
  return out;
}

// rotation about an origin, Euler degrees applied Z then Y then X ... as Blockbench does ('ZYX')
function eulerRotator(origin, deg) {
  if (!deg || (!deg[0] && !deg[1] && !deg[2])) return null;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(deg[0] * D2R, deg[1] * D2R, deg[2] * D2R, 'ZYX'));
  const o = new THREE.Vector3(...origin);
  return (v) => v.sub(o).applyQuaternion(q).add(o);
}

// ---------------------------------------------------------------- Java block / item models
const VANILLA = {
  'block/cube': { elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { down: { texture: '#down', cullface: 'down' }, up: { texture: '#up' }, north: { texture: '#north' }, south: { texture: '#south' }, west: { texture: '#west' }, east: { texture: '#east' } } }] },
  'block/cube_all': { parent: 'block/cube', textures: { particle: '#all', down: '#all', up: '#all', north: '#all', east: '#all', south: '#all', west: '#all' } },
  'block/cube_column': { parent: 'block/cube', textures: { particle: '#side', down: '#end', up: '#end', north: '#side', east: '#side', south: '#side', west: '#side' } },
  'block/cube_column_horizontal': { parent: 'block/cube_column' },
  'block/cube_bottom_top': { parent: 'block/cube', textures: { particle: '#side', down: '#bottom', up: '#top', north: '#side', east: '#side', south: '#side', west: '#side' } },
  'block/cube_top': { parent: 'block/cube', textures: { particle: '#side', down: '#side', up: '#top', north: '#side', east: '#side', south: '#side', west: '#side' } },
  'block/orientable': { parent: 'block/cube', textures: { particle: '#front', down: '#top', up: '#top', north: '#front', east: '#side', south: '#side', west: '#side' } },
  'block/orientable_with_bottom': { parent: 'block/cube', textures: { particle: '#front', down: '#bottom', up: '#top', north: '#front', east: '#side', south: '#side', west: '#side' } },
  'block/leaves': { parent: 'block/cube_all' },
  'block/cross': { elements: [
    { from: [0.8, 0, 8], to: [15.2, 16, 8], rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true }, shade: false, faces: { north: { uv: [0, 0, 16, 16], texture: '#cross' }, south: { uv: [0, 0, 16, 16], texture: '#cross' } } },
    { from: [8, 0, 0.8], to: [8, 16, 15.2], rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true }, shade: false, faces: { west: { uv: [0, 0, 16, 16], texture: '#cross' }, east: { uv: [0, 0, 16, 16], texture: '#cross' } } }] },
  'block/tinted_cross': { parent: 'block/cross' },
  'block/slab': { elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { down: { uv: [0, 0, 16, 16], texture: '#bottom' }, up: { uv: [0, 0, 16, 16], texture: '#top' }, north: { uv: [0, 8, 16, 16], texture: '#side' }, south: { uv: [0, 8, 16, 16], texture: '#side' }, west: { uv: [0, 8, 16, 16], texture: '#side' }, east: { uv: [0, 8, 16, 16], texture: '#side' } } }] },
  'block/slab_top': { elements: [{ from: [0, 8, 0], to: [16, 16, 16], faces: { down: { uv: [0, 0, 16, 16], texture: '#bottom' }, up: { uv: [0, 0, 16, 16], texture: '#top' }, north: { uv: [0, 0, 16, 8], texture: '#side' }, south: { uv: [0, 0, 16, 8], texture: '#side' }, west: { uv: [0, 0, 16, 8], texture: '#side' }, east: { uv: [0, 0, 16, 8], texture: '#side' } } }] },
  'block/carpet': { elements: [{ from: [0, 0, 0], to: [16, 1, 16], faces: { down: { uv: [0, 0, 16, 16], texture: '#wool' }, up: { uv: [0, 0, 16, 16], texture: '#wool' }, north: { uv: [0, 15, 16, 16], texture: '#wool' }, south: { uv: [0, 15, 16, 16], texture: '#wool' }, west: { uv: [0, 15, 16, 16], texture: '#wool' }, east: { uv: [0, 15, 16, 16], texture: '#wool' } } }] },
  'block/block': {}, 'item/generated': { generated: true }, 'item/handheld': { parent: 'item/generated' }, 'item/handheld_rod': { parent: 'item/generated' }, 'builtin/generated': { generated: true },
};
const stripNs = (s) => String(s || '').replace(/^minecraft:/, '');

// resolve a namespaced texture / model id to a file in the archive
function mcPath(id, kind, ownNs) {
  const s = String(id || '');
  const [ns, p] = s.includes(':') ? s.split(':') : [ownNs || 'minecraft', s];
  return `assets/${ns}/${kind}/${p}`;
}
function nsOf(path) { const m = /assets\/([^/]+)\//i.exec(path); return m ? m[1] : 'minecraft'; }

// a Java model json -> THREE.Group. vfs: find(path) / get(path) -> entry {blob}
export async function loadJavaModel(json, path, vfs) {
  const ns = nsOf(path);
  const root = String(path).replace(/\\/g, '/').replace(/assets\/.*$/i, '');
  // walk the parent chain, children override parents
  let model = { textures: {}, elements: null, generated: false };
  const chain = [];
  let cur = json, guard = 0;
  while (cur && guard++ < 16) {
    chain.push(cur);
    const parent = cur.parent ? stripNs(cur.parent) : null;
    if (!parent) break;
    if (VANILLA[parent]) { cur = VANILLA[parent]; continue; }
    const e = vfs.get(root + mcPath(cur.parent, 'models', ns) + '.json');
    if (!e) break;
    try { cur = JSON.parse(await e.blob.text()); } catch { break; }
  }
  for (const m of chain.reverse()) {
    if (m.textures) model.textures = { ...model.textures, ...m.textures };
    if (m.elements) model.elements = m.elements;
    if (m.generated) model.generated = true;
  }
  if (json.elements) model.elements = json.elements;
  const resolve = (ref, depth = 0) => {
    if (!ref) return null;
    if (ref.startsWith('#')) return depth > 8 ? null : resolve(model.textures[ref.slice(1)], depth + 1);
    return ref;
  };
  const texCache = new Map();
  const texFor = async (ref) => {
    const id = resolve(ref);
    if (!id) return null;
    if (texCache.has(id)) return texCache.get(id);
    const file = vfs.get(root + mcPath(id, 'textures', ns) + '.png') || vfs.find(stripNs(id).split('/').pop() + '.png', path);
    const t = file ? await loadImageTex(file.blob) : null;
    if (t) t.name = stripNs(id);
    texCache.set(id, t);
    return t;
  };
  const group = new THREE.Group();
  group.name = String(path).split('/').pop().replace(/\.json$/i, '');
  const warnings = [];
  if (model.generated && !model.elements) {
    // flat items: each layer's opaque pixels, one pixel thick
    for (let i = 0; i < 8; i++) {
      const ref = model.textures['layer' + i];
      if (!ref) break;
      const tex = await texFor(ref);
      if (!tex) { warnings.push(`missing texture ${resolve(ref)}`); continue; }
      const m = itemSprite(tex, i);
      if (m) group.add(m);
    }
    return { root: group, warnings };
  }
  if (!model.elements) return { root: null, warnings: ['no elements (a vanilla parent this reader doesn\'t know?)'] };
  const els = [];
  const keys = new Set();
  for (const el of model.elements) {
    if (!el || !el.from || !el.to) continue;
    let rotate = null;
    if (el.rotation && el.rotation.angle) {
      const ax = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[el.rotation.axis] || new THREE.Vector3(0, 1, 0);
      const q = new THREE.Quaternion().setFromAxisAngle(ax, el.rotation.angle * D2R);
      const o = new THREE.Vector3(...(el.rotation.origin || [8, 8, 8]));
      const k = el.rotation.rescale ? 1 / Math.cos(Math.abs(el.rotation.angle) * D2R) : 1;
      const sc = new THREE.Vector3(el.rotation.axis === 'x' ? 1 : k, el.rotation.axis === 'y' ? 1 : k, el.rotation.axis === 'z' ? 1 : k);
      rotate = (v) => v.sub(o).multiply(sc).applyQuaternion(q).add(o);
    }
    const faces = {};
    for (const [dir, fc] of Object.entries(el.faces || {})) {
      if (!fc) continue;
      const tex = await texFor(fc.texture);
      const sz = tex && tex.userData.size;
      faces[dir] = { uv: fc.uv, rotation: fc.rotation, tex: tex ? tex.name : '', frameAspect: sz && sz[1] > sz[0] && sz[1] % sz[0] === 0 ? sz[0] / sz[1] : 1 };
      keys.add(tex ? tex.name : '');
    }
    els.push({ from: el.from, to: el.to, rotate, faces });
  }
  const texByName = new Map();
  for (const t of texCache.values()) if (t) texByName.set(t.name, t);
  const mats = new Map();
  const matOf = (k) => { if (!mats.has(k)) mats.set(k, matFor(texByName.get(k), { name: k || 'untextured', double: true })); return mats.get(k); };
  // centered on the block, its front (north) toward the viewer
  const T = (v) => new THREE.Vector3((8 - v.x) / 16, v.y / 16, (8 - v.z) / 16);
  for (const m of meshesFrom(buildCubes(els, T, false), matOf, group.name)) group.add(m);
  return { root: group, warnings };
}

// an item texture extruded one pixel thick (like Minecraft draws held items)
function itemSprite(tex, layer) {
  const img = tex.image;
  const w = img.width, h = img.height;
  const g = img.getContext ? img.getContext('2d') : null;
  if (!g) return null;
  const fh = h > w && h % w === 0 ? w : h; // first frame of a strip
  const px = g.getImageData(0, 0, w, fh).data;
  const solid = (x, y) => x >= 0 && y >= 0 && x < w && y < fh && px[(y * w + x) * 4 + 3] > 20;
  const s = 1 / 16 * (16 / Math.max(w, fh)); // one block across
  const th = 1 / 16, z0 = -th / 2 - layer * 0.001, z1 = th / 2 + layer * 0.001;
  const pos = [], uv = [], nrm = [], idx = [];
  const fa = fh / h;
  const quad = (p, n, t) => { const b = pos.length / 3; for (let i = 0; i < 4; i++) { pos.push(...p[i]); nrm.push(...n); uv.push(...t[i]); } idx.push(b, b + 1, b + 2, b, b + 2, b + 3); };
  const X = (x) => (x - w / 2) * s, Y = (y) => (fh / 2 - y) * s + 0.5;
  const U = (x) => x / w, V = (y) => 1 - (y / fh) * fa;
  // front and back
  quad([[X(0), Y(fh), z1], [X(w), Y(fh), z1], [X(w), Y(0), z1], [X(0), Y(0), z1]], [0, 0, 1], [[U(0), V(fh)], [U(w), V(fh)], [U(w), V(0)], [U(0), V(0)]]);
  quad([[X(w), Y(fh), z0], [X(0), Y(fh), z0], [X(0), Y(0), z0], [X(w), Y(0), z0]], [0, 0, -1], [[U(w), V(fh)], [U(0), V(fh)], [U(0), V(0)], [U(w), V(0)]]);
  // edges where a solid pixel meets an empty one
  for (let y = 0; y < fh; y++) for (let x = 0; x < w; x++) {
    if (!solid(x, y)) continue;
    const t = [[U(x + 0.25), V(y + 0.25)], [U(x + 0.75), V(y + 0.25)], [U(x + 0.75), V(y + 0.75)], [U(x + 0.25), V(y + 0.75)]];
    if (!solid(x, y - 1)) quad([[X(x), Y(y), z0], [X(x + 1), Y(y), z0], [X(x + 1), Y(y), z1], [X(x), Y(y), z1]], [0, 1, 0], t);
    if (!solid(x, y + 1)) quad([[X(x), Y(y + 1), z1], [X(x + 1), Y(y + 1), z1], [X(x + 1), Y(y + 1), z0], [X(x), Y(y + 1), z0]], [0, -1, 0], t);
    if (!solid(x - 1, y)) quad([[X(x), Y(y), z0], [X(x), Y(y), z1], [X(x), Y(y + 1), z1], [X(x), Y(y + 1), z0]], [-1, 0, 0], t);
    if (!solid(x + 1, y)) quad([[X(x + 1), Y(y), z1], [X(x + 1), Y(y), z0], [X(x + 1), Y(y + 1), z0], [X(x + 1), Y(y + 1), z1]], [1, 0, 0], t);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  const m = new THREE.Mesh(geo, matFor(tex, { name: tex.name, double: false }));
  m.name = tex.name.split('/').pop();
  m.castShadow = m.receiveShadow = true;
  return m;
}

// ---------------------------------------------------------------- Bedrock / GeckoLib geometry
export function isBedrockGeo(json) {
  if (!json || typeof json !== 'object') return false;
  if (Array.isArray(json['minecraft:geometry'])) return true;
  return Object.keys(json).some((k) => /^geometry\./.test(k) && json[k] && json[k].bones);
}
export function isBedrockAnimation(json) {
  return !!(json && json.animations && typeof json.animations === 'object' && Object.values(json.animations).some((a) => a && (a.bones || a.animation_length !== undefined)));
}

// Bedrock files flip X relative to Blockbench (which faces north); we then turn it to face +Z.
// Net effect on a file point: (x, y, z) -> (x, y, -z) / 16, a mirror, so windings flip.
const geoPoint = (v) => new THREE.Vector3(v.x / 16, v.y / 16, -v.z / 16);
const geoEuler = (r) => new THREE.Euler(-(r[0] || 0) * D2R, -(r[1] || 0) * D2R, (r[2] || 0) * D2R, 'ZYX');

// box UV regions (Blockbench / Bedrock layout, faces named as in Blockbench space)
function boxUV(u, v, size, mirror) {
  const [w, h, d] = size.map((x) => Math.floor(Math.abs(x) + 1e-6) || Math.abs(x));
  const f = {
    east: [u, v + d, u + d, v + d + h], north: [u + d, v + d, u + d + w, v + d + h], west: [u + d + w, v + d, u + d + w + d, v + d + h], south: [u + d + w + d, v + d, u + d + w + d + w, v + d + h],
    up: [u + d, v, u + d + w, v + d], down: [u + d + w, v + d, u + d + w + w, v],
  };
  if (mirror) { const e = f.east; f.east = f.west; f.west = e; for (const k of Object.keys(f)) { const r = f[k]; f[k] = [r[2], r[1], r[0], r[3]]; } }
  return f;
}

// geo json + texture blob (optional) -> { root (Group with Bones), bones: Map(name -> Bone) }
export async function loadBedrockGeo(json, texBlob, nameHint) {
  let geo, desc;
  if (Array.isArray(json['minecraft:geometry'])) { geo = json['minecraft:geometry'][0]; desc = geo.description || {}; }
  else { const k = Object.keys(json).find((x) => /^geometry\./.test(x)); geo = json[k]; desc = { identifier: k, texture_width: geo.texturewidth, texture_height: geo.textureheight }; }
  if (!geo || !Array.isArray(geo.bones)) throw new Error('no bones in this geometry');
  const tw = desc.texture_width || 64, th = desc.texture_height || 64;
  const tex = texBlob ? await loadImageTex(texBlob) : null;
  const mat = matFor(tex, { name: (desc.identifier || 'geometry').replace(/^geometry\./, ''), double: false });
  const group = new THREE.Group();
  group.name = nameHint || (desc.identifier || 'model').replace(/^geometry\./, '');
  const bones = new Map();
  // bones: local position = pivot relative to the parent's pivot
  for (const b of geo.bones) {
    const bone = new THREE.Bone();
    bone.name = b.name;
    bone.userData.pivot = b.pivot || [0, 0, 0];
    bone.userData.restRot = b.rotation || [0, 0, 0];
    bones.set(b.name, bone);
  }
  for (const b of geo.bones) {
    const bone = bones.get(b.name);
    const parent = b.parent && bones.get(b.parent);
    const pv = new THREE.Vector3(...(b.pivot || [0, 0, 0]));
    const ppv = parent ? new THREE.Vector3(...(parent.userData.pivot || [0, 0, 0])) : new THREE.Vector3();
    bone.position.copy(geoPoint(pv.clone().sub(ppv)));
    bone.quaternion.setFromEuler(geoEuler(b.rotation || [0, 0, 0]));
    (parent || group).add(bone);
    // its cubes, in the bone's frame (around its pivot)
    const els = [];
    for (const c of b.cubes || []) {
      if (!c.size) continue;
      const o = c.origin || [0, 0, 0];
      // into Blockbench space (x flipped) where the face names and box UVs live
      const from = [-(o[0] + c.size[0]), o[1], o[2]], to = [-o[0], o[1] + c.size[1], o[2] + c.size[2]];
      const faces = {};
      if (Array.isArray(c.uv)) {
        const f = boxUV(c.uv[0], c.uv[1], c.size, !!(c.mirror ?? b.mirror));
        for (const [dir, r] of Object.entries(f)) faces[dir] = { uv: r, uvSize: [tw, th] };
      } else if (c.uv && typeof c.uv === 'object') {
        for (const [dir, fc] of Object.entries(c.uv)) {
          if (!fc || !fc.uv) continue;
          const us = fc.uv_size || [0, 0];
          faces[dir] = { uv: [fc.uv[0], fc.uv[1], fc.uv[0] + us[0], fc.uv[1] + us[1]], uvSize: [tw, th] };
        }
      }
      let rotate = null;
      if (c.rotation && (c.rotation[0] || c.rotation[1] || c.rotation[2])) {
        const p = c.pivot || [0, 0, 0];
        // the cube's own rotation, in Blockbench space (x flipped: y and z angles flip)
        rotate = eulerRotator([-p[0], p[1], p[2]], [c.rotation[0], -c.rotation[1], -c.rotation[2]]);
      }
      els.push({ from, to, inflate: c.inflate || 0, rotate, faces });
    }
    if (els.length) {
      // Blockbench space -> ours: turn to face +Z and make it relative to the bone's pivot
      const bbPivot = new THREE.Vector3(-pv.x, pv.y, pv.z);
      const T = (v) => new THREE.Vector3(-(v.x - bbPivot.x) / 16, (v.y - bbPivot.y) / 16, -(v.z - bbPivot.z) / 16);
      for (const m of meshesFrom(buildCubes(els, T, false), () => mat, b.name)) {
        // undo the bone's rest rotation: cubes are given unrotated
        m.quaternion.copy(bone.quaternion).invert();
        bone.add(m);
      }
    }
  }
  return { root: group, bones, info: { texture: !!tex, identifier: desc.identifier } };
}

// ---------------------------------------------------------------- Molang (a safe subset)
// numbers, + - * / %, comparisons, && || !, ?:, parentheses, math.*, query.anim_time /
// life_time; unknown variables are 0. Parsed to a closure, never evaluated as JS.
export function molang(src) {
  const s = String(src).toLowerCase().replace(/\s+/g, '');
  let i = 0;
  const peek = () => s[i], eat = (t) => { if (s.startsWith(t, i)) { i += t.length; return true; } return false; };
  const fns = {
    'math.sin': (a) => Math.sin(a * D2R), 'math.cos': (a) => Math.cos(a * D2R), 'math.abs': Math.abs, 'math.sqrt': Math.sqrt, 'math.floor': Math.floor, 'math.ceil': Math.ceil,
    'math.round': Math.round, 'math.trunc': Math.trunc, 'math.pow': Math.pow, 'math.min': Math.min, 'math.max': Math.max, 'math.exp': Math.exp, 'math.ln': Math.log,
    'math.clamp': (v, a, b) => Math.min(Math.max(v, a), b), 'math.lerp': (a, b, t) => a + (b - a) * t, 'math.mod': (a, b) => a % b, 'math.atan': (a) => Math.atan(a) / D2R,
    'math.atan2': (a, b) => Math.atan2(a, b) / D2R, 'math.asin': (a) => Math.asin(a) / D2R, 'math.acos': (a) => Math.acos(a) / D2R, 'math.random': (a = 0, b = 1) => a + (b - a) * 0.5, 'math.hermite_blend': (t) => 3 * t * t - 2 * t * t * t,
  };
  const ternary = () => { const c = or(); if (eat('?')) { const a = ternary(); eat(':'); const b = ternary(); return (ctx) => (c(ctx) ? a(ctx) : b(ctx)); } return c; };
  const or = () => { let l = and(); while (eat('||')) { const a = l, b = and(); l = (ctx) => (a(ctx) || b(ctx) ? 1 : 0); } return l; };
  const and = () => { let l = cmp(); while (eat('&&')) { const a = l, b = cmp(); l = (ctx) => (a(ctx) && b(ctx) ? 1 : 0); } return l; };
  const cmp = () => {
    let l = add();
    for (;;) {
      const op = ['<=', '>=', '==', '!=', '<', '>'].find((o) => s.startsWith(o, i));
      if (!op) return l;
      i += op.length;
      const a = l, b = add();
      l = { '<=': (c) => +(a(c) <= b(c)), '>=': (c) => +(a(c) >= b(c)), '==': (c) => +(a(c) === b(c)), '!=': (c) => +(a(c) !== b(c)), '<': (c) => +(a(c) < b(c)), '>': (c) => +(a(c) > b(c)) }[op];
    }
  };
  const add = () => { let l = mul(); for (;;) { if (eat('+')) { const a = l, b = mul(); l = (c) => a(c) + b(c); } else if (peek() === '-' ) { i++; const a = l, b = mul(); l = (c) => a(c) - b(c); } else return l; } };
  const mul = () => { let l = unary(); for (;;) { if (eat('*')) { const a = l, b = unary(); l = (c) => a(c) * b(c); } else if (eat('/')) { const a = l, b = unary(); l = (c) => { const d = b(c); return d ? a(c) / d : 0; }; } else if (eat('%')) { const a = l, b = unary(); l = (c) => a(c) % b(c); } else return l; } };
  const unary = () => { if (eat('-')) { const a = unary(); return (c) => -a(c); } if (eat('!')) { const a = unary(); return (c) => (a(c) ? 0 : 1); } if (eat('+')) return unary(); return atom(); };
  const atom = () => {
    if (eat('(')) { const e = ternary(); eat(')'); return e; }
    const num = /^(\d+\.?\d*|\.\d+)f?/.exec(s.slice(i));
    if (num) { i += num[0].length; const v = parseFloat(num[1]); return () => v; }
    const id = /^[a-z_][a-z0-9_.]*/.exec(s.slice(i));
    if (!id) { i++; return () => 0; }
    i += id[0].length;
    let name = id[0].replace(/^q\./, 'query.').replace(/^v\./, 'variable.').replace(/^t\./, 'temp.');
    if (name === 'math.pi') return () => Math.PI;
    if (eat('(')) {
      const args = [];
      if (!eat(')')) { do args.push(ternary()); while (eat(',')); eat(')'); }
      const fn = fns[name];
      return fn ? (c) => fn(...args.map((a) => a(c))) : () => 0;
    }
    if (name === 'query.anim_time' || name === 'query.life_time') return (c) => c.t;
    if (name === 'query.ground_speed' || name === 'query.modified_move_speed') return () => 1;
    if (name === 'query.is_on_ground') return () => 1;
    return (c) => (c.vars && c.vars[name]) || 0;
  };
  let fn;
  try { fn = ternary(); } catch { fn = () => 0; }
  return (t) => { const v = fn({ t }); return Number.isFinite(v) ? v : 0; };
}

// "1.5" | 1.5 | [x, y, z] (numbers or Molang) -> f(t) -> [x, y, z]
function channelValue(v) {
  const one = (x) => (typeof x === 'number' ? () => x : typeof x === 'string' ? molang(x) : () => 0);
  if (Array.isArray(v)) { const f = v.slice(0, 3).map(one); while (f.length < 3) f.push(f[0] || (() => 0)); return (t) => f.map((g) => g(t)); }
  const g = one(v);
  return (t) => { const x = g(t); return [x, x, x]; };
}
// a bone channel -> sampler over time (keyframes with linear / step / catmullrom, or one value)
function channelSampler(ch) {
  if (ch === undefined || ch === null) return null;
  if (typeof ch !== 'object' || Array.isArray(ch)) return channelValue(ch);
  const keys = Object.entries(ch).map(([k, v]) => {
    const pre = v && typeof v === 'object' && !Array.isArray(v) ? v.pre ?? v.post : v;
    const post = v && typeof v === 'object' && !Array.isArray(v) ? v.post ?? v.pre : v;
    return { t: parseFloat(k), pre: channelValue(pre), post: channelValue(post), smooth: v && v.lerp_mode === 'catmullrom', step: v && v.lerp_mode === 'step' };
  }).filter((k) => Number.isFinite(k.t)).sort((a, b) => a.t - b.t);
  if (!keys.length) return null;
  return (t) => {
    if (t <= keys[0].t) return keys[0].pre(t);
    const n = keys.length;
    if (t >= keys[n - 1].t) return keys[n - 1].post(t);
    let i = 0;
    while (i < n - 2 && keys[i + 1].t <= t) i++;
    const a = keys[i], b = keys[i + 1];
    if (a.step) return a.post(t);
    const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
    const A = a.post(t), B = b.pre(t);
    if (a.smooth || b.smooth) {
      const P = (keys[i - 1] || a).post(t), Q = (keys[i + 2] || b).pre(t);
      return A.map((_, k) => 0.5 * (2 * A[k] + (-P[k] + B[k]) * u + (2 * P[k] - 5 * A[k] + 4 * B[k] - Q[k]) * u * u + (-P[k] + 3 * A[k] - 3 * B[k] + Q[k]) * u * u * u));
    }
    return A.map((x, k) => x + (B[k] - x) * u);
  };
}

// animation json + the bones of a loaded geometry -> AnimationClips
export function bedrockClips(json, bones) {
  const out = [];
  for (const [name, anim] of Object.entries(json.animations || {})) {
    if (!anim || typeof anim !== 'object') continue;
    const tracks = [];
    let len = Number(anim.animation_length) || 0;
    const chans = [];
    for (const [bn, chs] of Object.entries(anim.bones || {})) {
      const bone = bones.get(bn) || [...bones.values()].find((b) => b.name.toLowerCase() === bn.toLowerCase());
      if (!bone || !chs) continue;
      for (const key of ['rotation', 'position', 'scale']) {
        const c = chs[key];
        if (c === undefined) continue;
        const f = channelSampler(c);
        if (!f) continue;
        if (c && typeof c === 'object' && !Array.isArray(c)) for (const k of Object.keys(c)) { const tt = parseFloat(k); if (Number.isFinite(tt)) len = Math.max(len, tt); }
        chans.push({ bone, key, f });
      }
    }
    if (!chans.length) continue;
    len = Math.max(len, 0.05);
    const fps = 30, n = Math.max(2, Math.round(len * fps) + 1);
    const times = Float32Array.from({ length: n }, (_, i) => Math.min(len, i / fps));
    for (const { bone, key, f } of chans) {
      if (key === 'rotation') {
        const rest = bone.userData.restRot || [0, 0, 0];
        const vals = new Float32Array(n * 4);
        let prev = null;
        for (let i = 0; i < n; i++) {
          const r = f(times[i]);
          const q = new THREE.Quaternion().setFromEuler(geoEuler([rest[0] + r[0], rest[1] + r[1], rest[2] + r[2]]));
          if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
          prev = q;
          q.toArray(vals, i * 4);
        }
        tracks.push(new THREE.QuaternionKeyframeTrack(bone.uuid + '.quaternion', times, vals));
      } else if (key === 'position') {
        const base = bone.position.clone();
        const vals = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { const p = f(times[i]); base.clone().add(geoPoint(new THREE.Vector3(p[0], p[1], p[2]))).toArray(vals, i * 3); }
        tracks.push(new THREE.VectorKeyframeTrack(bone.uuid + '.position', times, vals));
      } else {
        const vals = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) { const s = f(times[i]); vals.set([s[0], s[1], s[2]], i * 3); }
        tracks.push(new THREE.VectorKeyframeTrack(bone.uuid + '.scale', times, vals));
      }
    }
    const clip = new THREE.AnimationClip(name.replace(/^animation\.[^.]*\./, '').replace(/^animation\./, ''), len, tracks);
    clip.userData = { loop: anim.loop === true || anim.loop === 'loop' };
    out.push(clip);
  }
  return out;
}

// ---------------------------------------------------------------- Blockbench .bbmodel
// Blockbench space faces north (-Z); we turn it to face +Z: (x, y, z) -> (-x, y, -z).
const bbEuler = (r) => new THREE.Euler(-(r[0] || 0) * D2R, (r[1] || 0) * D2R, -(r[2] || 0) * D2R, 'ZYX');
export async function loadBBModel(json) {
  const res = json.resolution || { width: 16, height: 16 };
  const box = !!(json.meta && json.meta.box_uv);
  const textures = [];
  for (const t of json.textures || []) {
    let tex = null;
    if (typeof t.source === 'string' && t.source.startsWith('data:image')) {
      try { const blob = await (await fetch(t.source)).blob(); tex = await loadImageTex(blob); } catch { tex = null; }
    }
    if (tex) { tex.name = t.name || 'texture'; tex.userData.uvSize = [t.uv_width || res.width, t.uv_height || res.height]; }
    textures.push(tex);
  }
  const mats = textures.map((t, i) => matFor(t, { name: (t && t.name) || 'texture ' + (i + 1), double: true }));
  const fallback = matFor(null, { name: 'untextured', double: true });
  const elements = new Map((json.elements || []).map((e) => [e.uuid, e]));
  const group = new THREE.Group();
  group.name = (json.name || json.model_identifier || 'Blockbench model').replace(/\.bbmodel$/i, '');
  const bones = new Map();
  const T0 = (origin) => (v) => new THREE.Vector3(-(v.x - origin[0]) / 16, (v.y - origin[1]) / 16, -(v.z - origin[2]) / 16);
  const addCubes = (list, parent, origin) => {
    const els = [];
    for (const el of list) {
      if (!el || el.type === 'locator' || !el.from || !el.to || el.visibility === false) continue;
      const faces = {};
      if (box && el.box_uv !== false && el.uv_offset) {
        const size = [el.to[0] - el.from[0], el.to[1] - el.from[1], el.to[2] - el.from[2]];
        const f = boxUV(el.uv_offset[0], el.uv_offset[1], size, !!el.mirror_uv);
        for (const [dir, r] of Object.entries(f)) { const ti = el.faces && el.faces[dir] ? el.faces[dir].texture : 0; faces[dir] = { uv: r, tex: ti ?? 0, uvSize: (textures[ti ?? 0] && textures[ti ?? 0].userData.uvSize) || [res.width, res.height] }; }
      } else {
        for (const [dir, fc] of Object.entries(el.faces || {})) {
          if (!fc || fc.texture === null || fc.texture === undefined) continue;
          faces[dir] = { uv: fc.uv, rotation: fc.rotation, tex: fc.texture, uvSize: (textures[fc.texture] && textures[fc.texture].userData.uvSize) || [res.width, res.height] };
        }
      }
      els.push({ from: el.from, to: el.to, inflate: el.inflate || 0, rotate: eulerRotator(el.origin || [0, 0, 0], el.rotation), faces });
    }
    if (els.length) for (const m of meshesFrom(buildCubes(els, T0(origin), false), (k) => mats[k] || fallback, parent.name || group.name)) parent.add(m);
  };
  const walk = (items, parent, parentOrigin) => {
    const loose = [];
    for (const it of items || []) {
      if (typeof it === 'string') { const el = elements.get(it); if (el) loose.push(el); continue; }
      if (!it || it.visibility === false) continue;
      const bone = new THREE.Bone();
      bone.name = it.name || 'group';
      const o = it.origin || [0, 0, 0];
      bone.position.set(-(o[0] - parentOrigin[0]) / 16, (o[1] - parentOrigin[1]) / 16, -(o[2] - parentOrigin[2]) / 16);
      bone.quaternion.setFromEuler(bbEuler(it.rotation || [0, 0, 0]));
      bone.userData.restRotBB = it.rotation || [0, 0, 0];
      bones.set(it.uuid || bone.name, bone);
      bones.set(bone.name, bone);
      parent.add(bone);
      walk(it.children, bone, o);
    }
    addCubes(loose, parent, parentOrigin);
  };
  walk(json.outliner && json.outliner.length ? json.outliner : [...elements.keys()], group, [0, 0, 0]);
  // animations
  const clips = [];
  for (const a of json.animations || []) {
    const tracks = [];
    const len = Number(a.length) || 1;
    for (const [id, an] of Object.entries(a.animators || {})) {
      const bone = bones.get(id) || bones.get(an && an.name);
      if (!bone || !an || !Array.isArray(an.keyframes)) continue;
      for (const ch of ['rotation', 'position', 'scale']) {
        const kfs = an.keyframes.filter((k) => k.channel === ch).sort((x, y) => x.time - y.time);
        if (!kfs.length) continue;
        const val = (k) => { const d = (k.data_points && k.data_points[0]) || {}; return ['x', 'y', 'z'].map((c) => { const v = d[c]; return typeof v === 'number' ? () => v : molang(v ?? (ch === 'scale' ? 1 : 0)); }); };
        const keyed = kfs.map((k) => ({ t: k.time, f: val(k), step: k.interpolation === 'step', smooth: k.interpolation === 'catmullrom' }));
        const times = [], vals = [];
        const n = Math.max(2, Math.round(len * 30) + 1);
        let prev = null;
        for (let i = 0; i < n; i++) {
          const t = Math.min(len, i / 30);
          let j = 0;
          while (j < keyed.length - 1 && keyed[j + 1].t <= t) j++;
          const A = keyed[j], B = keyed[Math.min(keyed.length - 1, j + 1)];
          const u = B === A || A.step ? 0 : THREE.MathUtils.clamp((t - A.t) / Math.max(1e-6, B.t - A.t), 0, 1);
          const v = [0, 1, 2].map((c) => { const x = A.f[c](t), y = B.f[c](t); return x + (y - x) * (t < keyed[0].t ? 0 : u); });
          times.push(t);
          if (ch === 'rotation') {
            const r0 = bone.userData.restRotBB || [0, 0, 0];
            const q = new THREE.Quaternion().setFromEuler(bbEuler([r0[0] + v[0], r0[1] + v[1], r0[2] + v[2]]));
            if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
            prev = q;
            vals.push(q.x, q.y, q.z, q.w);
          } else if (ch === 'position') {
            vals.push(bone.position.x - v[0] / 16, bone.position.y + v[1] / 16, bone.position.z - v[2] / 16);
          } else vals.push(v[0], v[1], v[2]);
        }
        tracks.push(ch === 'rotation' ? new THREE.QuaternionKeyframeTrack(bone.uuid + '.quaternion', times, vals) : new THREE.VectorKeyframeTrack(bone.uuid + '.' + ch, times, vals));
      }
    }
    if (tracks.length) clips.push(new THREE.AnimationClip(a.name || 'animation', len, tracks));
  }
  return { root: group, animations: clips, bones };
}
