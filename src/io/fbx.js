// Binary FBX 7.4 writer: meshes (normals, UVs, material slots), Phong materials with
// embedded PNG textures, skeletons with skin clusters and a bind pose, and one
// animation stack per clip. Laid out like Blender's FBX exporter so Roblox Studio,
// Unity, Unreal, Blender, Maya and the FBX SDK read it.
import * as THREE from 'three';
import { zlibSync } from 'three/examples/jsm/libs/fflate.module.js';

const KTIME = 46186158000n; // FBX time units per second (FBX 7.x)
const FILE_ID = new Uint8Array([0x28, 0xb3, 0x2a, 0xeb, 0xb6, 0x24, 0xcc, 0xc2, 0xbf, 0xc8, 0xb0, 0x2a, 0xa9, 0x2b, 0xfc, 0xf1]);
const FOOT_ID = new Uint8Array([0xfa, 0xbc, 0xab, 0x09, 0xd0, 0xc8, 0xd4, 0x66, 0xb1, 0x76, 0xfb, 0x83, 0x1c, 0xf7, 0x26, 0x7e]);
const FOOT_MAGIC = new Uint8Array([0xf8, 0x5a, 0x8c, 0x6a, 0xde, 0xf5, 0xd9, 0x7e, 0xec, 0xe9, 0x0c, 0xe3, 0x75, 0x8f, 0x29, 0x0b]);
const HEAD = new TextEncoder().encode('Kaydara FBX Binary  \0\x1a\0');
const enc = new TextEncoder();
const SEP = '\x00\x01';
const ALWAYS_SENTINEL = new Set(['AnimationStack', 'AnimationLayer']);

// ---------------------------------------------------------------- binary nodes
// property values: {t, v}; arrays are typed arrays
const P = {
  I: (v) => ({ t: 'I', v: v | 0 }), L: (v) => ({ t: 'L', v: BigInt(v) }), D: (v) => ({ t: 'D', v: +v }), F: (v) => ({ t: 'F', v: +v }),
  C: (v) => ({ t: 'C', v: v ? 1 : 0 }), S: (v) => ({ t: 'S', v: typeof v === 'string' ? enc.encode(v) : v }), R: (v) => ({ t: 'R', v }),
  d: (a) => ({ t: 'd', v: a instanceof Float64Array ? a : Float64Array.from(a) }), f: (a) => ({ t: 'f', v: a instanceof Float32Array ? a : Float32Array.from(a) }),
  i: (a) => ({ t: 'i', v: a instanceof Int32Array ? a : Int32Array.from(a) }), l: (a) => ({ t: 'l', v: a instanceof BigInt64Array ? a : BigInt64Array.from(a, (x) => BigInt(x)) }),
};

class Node {
  constructor(name, props = [], children = []) { this.name = name; this.props = props; this.children = children; }
  add(n) { this.children.push(n); return n; }
}
const N = (name, ...props) => new Node(name, props);
const N1 = (name, prop, children = []) => new Node(name, [prop], children);

// one property -> bytes (type code included)
function encodeProp(p) {
  const t = p.t.charCodeAt(0);
  const scalar = (size, set) => { const b = new Uint8Array(1 + size); const dv = new DataView(b.buffer); b[0] = t; set(dv); return b; };
  switch (p.t) {
    case 'I': return scalar(4, (dv) => dv.setInt32(1, p.v, true));
    case 'L': return scalar(8, (dv) => dv.setBigInt64(1, p.v, true));
    case 'D': return scalar(8, (dv) => dv.setFloat64(1, p.v, true));
    case 'F': return scalar(4, (dv) => dv.setFloat32(1, p.v, true));
    case 'C': return scalar(1, (dv) => dv.setUint8(1, p.v));
    case 'S': case 'R': {
      const b = new Uint8Array(5 + p.v.length); b[0] = t; new DataView(b.buffer).setUint32(1, p.v.length, true); b.set(p.v, 5); return b;
    }
    default: {
      // arrays: count, encoding (0 raw, 1 zlib), byte length, data
      const raw = new Uint8Array(p.v.buffer, p.v.byteOffset, p.v.byteLength);
      const zip = raw.length > 128;
      const data = zip ? zlibSync(raw, { level: 1 }) : raw;
      const b = new Uint8Array(13 + data.length);
      const dv = new DataView(b.buffer);
      b[0] = t; dv.setUint32(1, p.v.length, true); dv.setUint32(5, zip ? 1 : 0, true); dv.setUint32(9, data.length, true); b.set(data, 13);
      return b;
    }
  }
}

function prepare(node) {
  node._props = node.props.map(encodeProp);
  node._plen = node._props.reduce((a, b) => a + b.length, 0);
  node._name = enc.encode(node.name);
  for (const c of node.children) prepare(c);
}
// size of a node (12-byte header + name + props + children + sentinel)
function sizeOf(node, isLast) {
  let s = 13 + node._name.length + node._plen;
  s += childrenSize(node, isLast);
  return s;
}
function childrenSize(node, isLast) {
  if (node.children.length) return node.children.reduce((a, c, i) => a + sizeOf(c, i === node.children.length - 1), 0) + 13;
  return (!node.props.length && !isLast) || ALWAYS_SENTINEL.has(node.name) ? 13 : 0;
}
function writeNode(node, out, off, isLast) {
  const end = off + sizeOf(node, isLast);
  const dv = new DataView(out.buffer);
  dv.setUint32(off, end, true); dv.setUint32(off + 4, node.props.length, true); dv.setUint32(off + 8, node._plen, true);
  out[off + 12] = node._name.length; out.set(node._name, off + 13);
  let o = off + 13 + node._name.length;
  for (const p of node._props) { out.set(p, o); o += p.length; }
  o = writeChildren(node, out, o, isLast);
  if (o !== end) throw new Error(`FBX writer: ${node.name} is ${o - end} bytes off`);
  return o;
}
function writeChildren(node, out, o, isLast) {
  if (node.children.length) {
    node.children.forEach((c, i) => { o = writeNode(c, out, o, i === node.children.length - 1); });
    return o + 13; // zeroed sentinel
  }
  return (!node.props.length && !isLast) || ALWAYS_SENTINEL.has(node.name) ? o + 13 : o;
}

export function encodeFBX(topNodes, version = 7400) {
  const root = new Node('', [], topNodes);
  prepare(root);
  const start = HEAD.length + 4;
  const body = childrenSize(root, false);
  const afterBody = start + body + FOOT_ID.length + 4;
  let pad = ((afterBody + 15) & ~15) - afterBody;
  if (pad === 0) pad = 16;
  const total = afterBody + pad + 4 + 120 + FOOT_MAGIC.length;
  const out = new Uint8Array(total);
  out.set(HEAD, 0);
  new DataView(out.buffer).setUint32(HEAD.length, version, true);
  const o = writeChildren(root, out, start, false);
  out.set(FOOT_ID, o);
  const v = afterBody + pad;
  new DataView(out.buffer).setUint32(v, version, true);
  out.set(FOOT_MAGIC, v + 4 + 120);
  return out;
}

// ---------------------------------------------------------------- helpers
const props70 = (...rows) => new Node('Properties70', [], rows.filter(Boolean));
const pr = (name, type, label, flags, ...vals) => new Node('P', [P.S(name), P.S(type), P.S(label), P.S(flags), ...vals]);
const pInt = (n, v) => pr(n, 'int', 'Integer', '', P.I(v));
const pEnum = (n, v) => pr(n, 'enum', '', '', P.I(v));
const pBool = (n, v) => pr(n, 'bool', '', '', P.I(v ? 1 : 0));
const pDouble = (n, v) => pr(n, 'double', 'Number', '', P.D(v));
const pNumber = (n, v, anim = false) => pr(n, 'Number', '', anim ? 'A' : '', P.D(v));
const pColor = (n, c) => pr(n, 'Color', '', 'A', P.D(c.r), P.D(c.g), P.D(c.b));
const pColorRGB = (n, c) => pr(n, 'ColorRGB', 'Color', '', P.D(c[0]), P.D(c[1]), P.D(c[2]));
const pVec = (n, v) => pr(n, 'Vector3D', 'Vector', '', P.D(v[0]), P.D(v[1]), P.D(v[2]));
const pString = (n, v) => pr(n, 'KString', '', '', P.S(v));
const pUrl = (n, v) => pr(n, 'KString', 'Url', '', P.S(v));
const pTime = (n, v) => pr(n, 'KTime', 'Time', '', P.L(v));
const pLcl = (n, v, animated) => pr(n, n, '', animated ? 'A+' : 'A', P.D(v[0]), P.D(v[1]), P.D(v[2]));
const nameClass = (name, cls) => P.S(`${name}${SEP}${cls}`);
const secToKtime = (s) => BigInt(Math.round(s * 1e6)) * KTIME / 1000000n;

// quaternion -> FBX Lcl Rotation (XYZ order = three's 'ZYX'), close to prev to avoid flips
const _e = new THREE.Euler();
function eulerDeg(q, prev) {
  _e.setFromQuaternion(q, 'ZYX');
  let a = [_e.x, _e.y, _e.z].map(THREE.MathUtils.radToDeg);
  if (prev) {
    // the same rotation written the other way round, and whole turns, pick what's nearest
    const alt = [a[0] + 180, 180 - a[1], a[2] + 180];
    const fit = (v) => v.map((x, i) => x + Math.round((prev[i] - x) / 360) * 360);
    const c1 = fit(a), c2 = fit(alt);
    const d = (v) => v.reduce((s, x, i) => s + Math.abs(x - prev[i]), 0);
    a = d(c2) < d(c1) ? c2 : c1;
  }
  return a;
}

const matArray = (m, k = 1) => {
  const e = m.elements.slice();
  if (k !== 1) { e[12] *= k; e[13] *= k; e[14] *= k; }
  return Float64Array.from(e);
};

// texture -> PNG bytes (resized to fit, optionally tinted); null if its pixels can't be read
async function texturePNG(tex, { maxSize = 2048, tint = null, flipY = false } = {}) {
  const img = tex && tex.image;
  if (!img) return null;
  let w = img.width || img.naturalWidth || 0, h = img.height || img.naturalHeight || 0;
  if (!w || !h || (tex.isCompressedTexture)) return null;
  const k = Math.min(1, maxSize / Math.max(w, h));
  const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
  const g = cv.getContext('2d');
  try {
    if (tex.isDataTexture) {
      const d = img.data;
      if (!d || d.length < w * h * 4 || !(d instanceof Uint8Array || d instanceof Uint8ClampedArray)) return null;
      const id = new ImageData(new Uint8ClampedArray(d.buffer, d.byteOffset, w * h * 4), w, h);
      const tmp = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
      tmp.getContext('2d').putImageData(id, 0, 0);
      g.drawImage(tmp, 0, 0, W, H);
    } else g.drawImage(img, 0, 0, W, H);
    if (tint) { g.globalCompositeOperation = 'multiply'; g.fillStyle = tint; g.fillRect(0, 0, W, H); g.globalCompositeOperation = 'destination-in'; g.drawImage(img, 0, 0, W, H); g.globalCompositeOperation = 'source-over'; }
    if (flipY) { g.save(); g.scale(1, -1); g.drawImage(cv, 0, -H, W, H); g.restore(); }
  } catch { return null; }
  const blob = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/png' }) : await new Promise((r) => cv.toBlob(r, 'image/png'));
  return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
}

async function solidPNG(color) {
  const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(8, 8) : Object.assign(document.createElement('canvas'), { width: 8, height: 8 });
  const g = cv.getContext('2d');
  g.fillStyle = '#' + color.getHexString(THREE.SRGBColorSpace); g.fillRect(0, 0, 8, 8);
  const blob = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/png' }) : await new Promise((r) => cv.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------- scene -> FBX
// models: [{ root, name, clips: [AnimationClip with uuid track names] }]
// opts: unit 'm' | 'cm', fps, maxTexture, bakeColors (solid textures for untextured
// materials, tint baked in), asciiNames (fn name -> name), skipMeshes (animation only)
export async function buildFBX(models, opts = {}) {
  const k = opts.unit === 'cm' ? 100 : 1; // position multiplier
  const unitScaleFactor = opts.unit === 'cm' ? 1 : 100; // cm per unit
  const fps = opts.fps || 30;
  const report = { meshes: 0, triangles: 0, bones: 0, materials: 0, textures: 0, clips: 0, bigMeshes: [], skippedTextures: 0 };
  let uidN = 1000000n;
  const uid = () => ++uidN;
  const objects = [], conns = [];
  const counts = {};
  const count = (t) => { counts[t] = (counts[t] || 0) + 1; };
  const C = (type, a, b, prop) => conns.push(new Node('C', [P.S(type), P.L(a), P.L(b), ...(prop ? [P.S(prop)] : [])]));
  const nodeUid = new Map();
  const usedNodes = new Map(), usedMats = new Map();
  const nameOf = (o, fallback, used = usedNodes) => {
    let n = String((opts.asciiNames ? opts.asciiNames(o.name) : o.name) || fallback).replace(/[\x00\x01]/g, '').slice(0, 120) || fallback;
    const c = used.get(n) || 0; used.set(n, c + 1);
    return c ? `${n}.${String(c).padStart(3, '0')}` : n;
  };
  const exportable = (o) => !o.userData.editorOnly && !o.isLight && !o.isCamera && !o.isLine && !o.isPoints && !o.isSprite && !(o.isMesh && o.isInstancedMesh) && o.visible !== false;
  const matUid = new Map(), texUid = new Map();
  const animatedProps = new Map(); // node -> Set('T','R','S')

  // what each clip animates
  const clipNodes = [];
  for (const m of models) {
    const byUuid = new Map(); m.root.traverse((o) => byUuid.set(o.uuid, o));
    for (const clip of m.clips || []) {
      const nodes = new Map();
      for (const t of clip.tracks) {
        const dot = t.name.indexOf('.');
        const o = byUuid.get(t.name.slice(0, dot)), prop = t.name.slice(dot + 1);
        const ch = prop === 'position' ? 'T' : prop === 'quaternion' ? 'R' : prop === 'scale' ? 'S' : null;
        if (!o || !ch) continue;
        if (!nodes.has(o)) nodes.set(o, new Set());
        nodes.get(o).add(ch);
        if (!animatedProps.has(o)) animatedProps.set(o, new Set());
        animatedProps.get(o).add(ch);
      }
      if (nodes.size) clipNodes.push({ model: m, clip, nodes });
    }
  }

  // ---- materials and textures
  async function textureNode(tex, kind, tint) {
    const key = tex ? tex.uuid + '|' + kind + '|' + (tint || '') : 'solid|' + tint;
    if (texUid.has(key)) return texUid.get(key);
    const bytes = tex ? await texturePNG(tex, { maxSize: opts.maxTexture || 2048, tint }) : await solidPNG(new THREE.Color(tint));
    if (!bytes) { report.skippedTextures++; texUid.set(key, null); return null; }
    const name = (tex && tex.name ? tex.name : kind).replace(/[^\w.-]+/g, '_').slice(0, 40) + '_' + (texUid.size + 1);
    const file = name + '.png';
    const tId = uid(), vId = uid();
    const video = new Node('Video', [P.L(vId), nameClass(name, 'Video'), P.S('Clip')], [
      N1('Type', P.S('Clip')), props70(pUrl('Path', file)), N1('UseMipMap', P.I(0)), N1('Filename', P.S(file)), N1('RelativeFilename', P.S(file)), N1('Content', P.R(bytes)),
    ]);
    const texture = new Node('Texture', [P.L(tId), nameClass(name, 'Texture'), P.S('')], [
      N1('Type', P.S('TextureVideoClip')), N1('Version', P.I(202)), N1('TextureName', nameClass(name, 'Texture')),
      props70(pEnum('CurrentMappingType', 0), pEnum('WrapModeU', 0), pEnum('WrapModeV', 0), pBool('UseMaterial', true), pBool('UseMipMap', false), pString('UVSet', 'UVMap')),
      N1('Media', nameClass(name, 'Video')), N1('FileName', P.S(file)), N1('RelativeFilename', P.S(file)),
      new Node('ModelUVTranslation', [P.D(0), P.D(0)]), new Node('ModelUVScaling', [P.D(1), P.D(1)]),
      N1('Texture_Alpha_Source', P.S('None')), new Node('Cropping', [P.I(0), P.I(0), P.I(0), P.I(0)]),
    ]);
    objects.push(video, texture); count('Video'); count('Texture');
    C('OO', vId, tId);
    report.textures++;
    texUid.set(key, tId);
    return tId;
  }

  async function materialNode(mat) {
    if (matUid.has(mat)) return matUid.get(mat);
    const id = uid();
    matUid.set(mat, id);
    const color = mat.color ? mat.color : new THREE.Color(1, 1, 1);
    const emissive = mat.emissive ? mat.emissive.clone().multiplyScalar(mat.emissiveIntensity ?? 1) : new THREE.Color(0, 0, 0);
    const opacity = mat.transparent ? mat.opacity ?? 1 : 1;
    const rough = mat.roughness ?? 0.5, metal = mat.metalness ?? 0;
    const shin = ((1 - rough) * 10) ** 2;
    // a colored material over a texture: bake the tint in (some apps ignore DiffuseColor under a map)
    const tinted = opts.bakeColors && mat.map && color.getHex() !== 0xffffff;
    const node = new Node('Material', [P.L(id), nameClass(nameOf({ name: mat.name }, 'Material', usedMats), 'Material'), P.S('')], [
      N1('Version', P.I(102)), N1('ShadingModel', P.S('Phong')), N1('MultiLayer', P.I(0)),
      props70(
        pString('ShadingModel', 'Phong'), pColor('DiffuseColor', tinted || (opts.bakeColors && !mat.map) ? new THREE.Color(1, 1, 1) : color), pNumber('DiffuseFactor', 1, true),
        pColor('EmissiveColor', emissive), pNumber('EmissiveFactor', 1, true), pColor('AmbientColor', new THREE.Color(0, 0, 0)), pNumber('AmbientFactor', 0, true),
        pColor('TransparentColor', new THREE.Color(1 - opacity, 1 - opacity, 1 - opacity)), pNumber('TransparencyFactor', 1 - opacity, true), pNumber('Opacity', opacity, true),
        pColor('SpecularColor', color), pNumber('SpecularFactor', 0.25, true), pNumber('Shininess', shin, true), pNumber('ShininessExponent', shin, true),
        pColor('ReflectionColor', color), pNumber('ReflectionFactor', metal, true),
      ),
    ]);
    objects.push(node); count('Material');
    report.materials++;
    if (opts.textures !== false) {
      const tint = tinted ? '#' + color.getHexString(THREE.SRGBColorSpace) : null;
      let diffuse = null;
      if (mat.map) diffuse = await textureNode(mat.map, 'diffuse', tint);
      else if (opts.bakeColors) diffuse = await textureNode(null, 'color', '#' + color.getHexString(THREE.SRGBColorSpace));
      if (diffuse) C('OP', diffuse, id, 'DiffuseColor');
      if (mat.normalMap) { const n = await textureNode(mat.normalMap, 'normal'); if (n) C('OP', n, id, 'NormalMap'); }
      if (mat.emissiveMap) { const e = await textureNode(mat.emissiveMap, 'emissive'); if (e) C('OP', e, id, 'EmissiveColor'); }
    }
    return id;
  }

  // ---- geometry
  function geometryNode(mesh, mats) {
    const g = mesh.geometry;
    const pos = g.attributes.position, nor = g.attributes.normal, uvA = g.attributes.uv;
    const index = g.index ? g.index.array : null;
    const nIdx = index ? index.length : pos.count;
    const triCount = Math.floor(nIdx / 3);
    const verts = new Float64Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) { verts[i * 3] = pos.getX(i) * k; verts[i * 3 + 1] = pos.getY(i) * k; verts[i * 3 + 2] = pos.getZ(i) * k; }
    const pvi = new Int32Array(triCount * 3);
    for (let i = 0; i < triCount * 3; i++) { const v = index ? index[i] : i; pvi[i] = i % 3 === 2 ? -v - 1 : v; }
    const id = uid();
    const children = [N1('GeometryVersion', P.I(124)), N1('Vertices', P.d(verts)), N1('PolygonVertexIndex', P.i(pvi))];
    const layer = new Node('Layer', [P.I(0)], [N1('Version', P.I(100))]);
    if (nor) {
      const normals = new Float64Array(triCount * 9);
      for (let i = 0; i < triCount * 3; i++) { const v = index ? index[i] : i; normals[i * 3] = nor.getX(v); normals[i * 3 + 1] = nor.getY(v); normals[i * 3 + 2] = nor.getZ(v); }
      children.push(new Node('LayerElementNormal', [P.I(0)], [N1('Version', P.I(101)), N1('Name', P.S('')), N1('MappingInformationType', P.S('ByPolygonVertex')), N1('ReferenceInformationType', P.S('Direct')), N1('Normals', P.d(normals))]));
      layer.add(new Node('LayerElement', [], [N1('Type', P.S('LayerElementNormal')), N1('TypedIndex', P.I(0))]));
    }
    if (uvA) {
      // UVs as the color map expects them: its repeat/offset baked in, and glTF-style (top-down) flipped
      const map = mats.map((m) => m && m.map).find(Boolean);
      const rep = map ? map.repeat : { x: 1, y: 1 }, off = map ? map.offset : { x: 0, y: 0 };
      const flip = !!(map && map.flipY === false);
      const uv = new Float64Array(uvA.count * 2);
      for (let i = 0; i < uvA.count; i++) {
        const u = uvA.getX(i) * rep.x + off.x, v = uvA.getY(i) * rep.y + off.y;
        uv[i * 2] = u; uv[i * 2 + 1] = flip ? 1 - v : v;
      }
      const uvi = new Int32Array(triCount * 3);
      for (let i = 0; i < triCount * 3; i++) uvi[i] = index ? index[i] : i;
      children.push(new Node('LayerElementUV', [P.I(0)], [N1('Version', P.I(101)), N1('Name', P.S('UVMap')), N1('MappingInformationType', P.S('ByPolygonVertex')), N1('ReferenceInformationType', P.S('IndexToDirect')), N1('UV', P.d(uv)), N1('UVIndex', P.i(uvi))]));
      layer.add(new Node('LayerElement', [], [N1('Type', P.S('LayerElementUV')), N1('TypedIndex', P.I(0))]));
    }
    // material slot per triangle
    let matEl;
    if (mats.length > 1 && g.groups.length) {
      const per = new Int32Array(triCount);
      for (const grp of g.groups) for (let t = Math.floor(grp.start / 3); t < Math.min(triCount, Math.floor((grp.start + grp.count) / 3)); t++) per[t] = Math.min(grp.materialIndex || 0, mats.length - 1);
      matEl = [N1('MappingInformationType', P.S('ByPolygon')), N1('ReferenceInformationType', P.S('IndexToDirect')), N1('Materials', P.i(per))];
    } else matEl = [N1('MappingInformationType', P.S('AllSame')), N1('ReferenceInformationType', P.S('IndexToDirect')), N1('Materials', P.i([0]))];
    children.push(new Node('LayerElementMaterial', [P.I(0)], [N1('Version', P.I(101)), N1('Name', P.S('')), ...matEl]));
    layer.add(new Node('LayerElement', [], [N1('Type', P.S('LayerElementMaterial')), N1('TypedIndex', P.I(0))]));
    children.push(layer);
    objects.push(new Node('Geometry', [P.L(id), nameClass(mesh.name || 'Mesh', 'Geometry'), P.S('Mesh')], [props70(), ...children]));
    count('Geometry');
    report.meshes++; report.triangles += triCount;
    if (triCount > 20000) report.bigMeshes.push({ name: mesh.name || 'mesh', triangles: triCount });
    return id;
  }

  // ---- nodes (models)
  const skinned = [];
  const pendingMats = []; // [materials, model id]: textures are encoded after the pose-dependent work
  function modelNode(o, parentId, isRoot, rootMatrix) {
    const id = uid();
    nodeUid.set(o, id);
    const type = o.isBone ? 'LimbNode' : o.isMesh && !opts.skipMeshes ? 'Mesh' : 'Null';
    // a model's top node keeps where it stands in the scene
    const m = isRoot ? rootMatrix : o.matrix;
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    m.decompose(p, q, s);
    const anim = animatedProps.get(o) || new Set();
    const node = new Node('Model', [P.L(id), nameClass(nameOf(o, type === 'LimbNode' ? 'Bone' : 'Object'), 'Model'), P.S(type)], [
      N1('Version', P.I(232)),
      props70(
        pLcl('Lcl Translation', [p.x * k, p.y * k, p.z * k], anim.has('T')), pLcl('Lcl Rotation', eulerDeg(q), anim.has('R')), pLcl('Lcl Scaling', [s.x, s.y, s.z], anim.has('S')),
        pr('Visibility', 'Visibility', '', 'A', P.D(1)), pInt('DefaultAttributeIndex', 0), pEnum('InheritType', 1),
      ),
      N1('MultiLayer', P.I(0)), N1('MultiTake', P.I(0)), N1('Shading', P.C(1)), N1('Culling', P.S('CullingOff')),
    ]);
    objects.push(node); count('Model');
    C('OO', id, parentId);
    if (type === 'LimbNode' || type === 'Null') {
      const aId = uid();
      objects.push(new Node('NodeAttribute', [P.L(aId), nameClass(o.name || 'Node', 'NodeAttribute'), P.S(type)], type === 'LimbNode'
        ? [props70(pDouble('Size', 33)), N1('TypeFlags', P.S('Skeleton'))]
        : [props70(pDouble('Size', 100), pEnum('Look', 1)), N1('TypeFlags', P.S('Null'))]));
      count('NodeAttribute');
      C('OO', aId, id);
      if (type === 'LimbNode') report.bones++;
    } else {
      const mats = (Array.isArray(o.material) ? o.material : [o.material]).filter(Boolean);
      const gId = geometryNode(o, mats);
      C('OO', gId, id);
      pendingMats.push([mats, id]);
      if (o.isSkinnedMesh && o.skeleton) skinned.push({ mesh: o, gId, id });
    }
    for (const c of o.children) if (exportable(c)) modelNode(c, id, false);
    return id;
  }

  for (const m of models) {
    m.root.updateMatrixWorld(true);
    const rm = m.root.matrixWorld.clone().premultiply(opts.worldInverse || new THREE.Matrix4());
    modelNode(m.root, 0n, true, rm);
  }

  // ---- skins: a cluster per bone with its weights, bind matrices from the skeleton
  const W = opts.worldInverse || new THREE.Matrix4();
  for (const { mesh, gId } of skinned) {
    const sk = mesh.skeleton;
    const skinId = uid();
    objects.push(new Node('Deformer', [P.L(skinId), nameClass(mesh.name || 'Skin', 'Deformer'), P.S('Skin')], [N1('Version', P.I(101)), N1('Link_DeformAcuracy', P.D(50))]));
    count('Deformer');
    C('OO', skinId, gId);
    const si = mesh.geometry.attributes.skinIndex, sw = mesh.geometry.attributes.skinWeight;
    const per = sk.bones.map(() => ({ idx: [], w: [] }));
    if (si && sw) {
      for (let v = 0; v < si.count; v++) {
        let total = 0;
        for (let j = 0; j < 4; j++) total += sw.getComponent(v, j);
        for (let j = 0; j < 4; j++) {
          const w = sw.getComponent(v, j);
          if (w <= 1e-6) continue;
          const b = si.getComponent(v, j);
          if (!per[b]) continue;
          per[b].idx.push(v); per[b].w.push(total > 0 ? w / total : w);
        }
      }
    }
    const meshBind = mesh.bindMatrix.clone().premultiply(W);
    const poseNodes = [new Node('PoseNode', [], [N1('Node', P.L(nodeUid.get(mesh))), N1('Matrix', P.d(matArray(mesh.matrixWorld.clone().premultiply(W), k)))])];
    sk.bones.forEach((bone, i) => {
      const bId = nodeUid.get(bone);
      if (!bId) return;
      const link = sk.boneInverses[i].clone().invert().premultiply(W); // bone's world matrix at bind
      const transform = link.clone().invert().multiply(meshBind);
      const cId = uid();
      const kids = [N1('Version', P.I(100)), new Node('UserData', [P.S(''), P.S('')])];
      if (per[i].idx.length) kids.push(N1('Indexes', P.i(per[i].idx)), N1('Weights', P.d(per[i].w)));
      kids.push(N1('Transform', P.d(matArray(transform, k))), N1('TransformLink', P.d(matArray(link, k))));
      objects.push(new Node('Deformer', [P.L(cId), nameClass(bone.name || 'Bone', 'SubDeformer'), P.S('Cluster')], kids));
      count('Deformer');
      C('OO', cId, skinId);
      C('OO', bId, cId);
      poseNodes.push(new Node('PoseNode', [], [N1('Node', P.L(bId)), N1('Matrix', P.d(matArray(link, k)))]));
    });
    const poseId = uid();
    objects.push(new Node('Pose', [P.L(poseId), nameClass(mesh.name || 'Mesh', 'Pose'), P.S('BindPose')], [N1('Type', P.S('BindPose')), N1('Version', P.I(100)), N1('NbPoseNodes', P.I(poseNodes.length)), ...poseNodes]));
    count('Pose');
  }

  // ---- animation: one stack per clip, sampled at fps
  const takes = [new Node('Current', [P.S('')])];
  let longest = 0;
  for (const { model, clip, nodes } of clipNodes) {
    if (!opts.sample) break;
    const frames = opts.sample(model, clip, [...nodes.keys()], fps); // Map node -> {t: Float32Array, p, q, s}
    if (!frames) continue;
    const name = (opts.clipName ? opts.clipName(model, clip) : clip.name).replace(/[\x00\x01]/g, '');
    const stackId = uid(), layerId = uid();
    const dur = clip.duration;
    longest = Math.max(longest, dur);
    const stop = secToKtime(dur);
    objects.push(new Node('AnimationStack', [P.L(stackId), nameClass(name, 'AnimStack'), P.S('')], [props70(pTime('LocalStart', 0n), pTime('LocalStop', stop), pTime('ReferenceStart', 0n), pTime('ReferenceStop', stop))]));
    objects.push(new Node('AnimationLayer', [P.L(layerId), nameClass(name, 'AnimLayer'), P.S('')], []));
    count('AnimationStack'); count('AnimationLayer');
    C('OO', layerId, stackId);
    for (const [o, chs] of nodes) {
      const f = frames.get(o);
      const nId = nodeUid.get(o);
      if (!f || !nId) continue;
      const n = f.t.length;
      const times = new BigInt64Array(n);
      for (let i = 0; i < n; i++) times[i] = secToKtime(f.t[i]);
      const channels = [];
      if (chs.has('T')) channels.push(['T', 'Lcl Translation', (i) => [f.p[i * 3] * k, f.p[i * 3 + 1] * k, f.p[i * 3 + 2] * k]]);
      if (chs.has('R')) { let prev = null; const rot = []; const q = new THREE.Quaternion(); for (let i = 0; i < n; i++) { q.fromArray(f.q, i * 4); prev = eulerDeg(q, prev); rot.push(prev); } channels.push(['R', 'Lcl Rotation', (i) => rot[i]]); }
      if (chs.has('S')) channels.push(['S', 'Lcl Scaling', (i) => [f.s[i * 3], f.s[i * 3 + 1], f.s[i * 3 + 2]]]);
      for (const [short, prop, at] of channels) {
        const cnId = uid();
        const v0 = at(0);
        objects.push(new Node('AnimationCurveNode', [P.L(cnId), nameClass(short, 'AnimCurveNode'), P.S('')], [props70(pNumber('d|X', v0[0], true), pNumber('d|Y', v0[1], true), pNumber('d|Z', v0[2], true))]));
        count('AnimationCurveNode');
        C('OO', cnId, layerId);
        C('OP', cnId, nId, prop);
        ['X', 'Y', 'Z'].forEach((axis, ai) => {
          const vals = new Float32Array(n);
          for (let i = 0; i < n; i++) vals[i] = at(i)[ai];
          const cId = uid();
          objects.push(new Node('AnimationCurve', [P.L(cId), nameClass('', 'AnimCurve'), P.S('')], [
            N1('Default', P.D(vals[0])), N1('KeyVer', P.I(4008)), N1('KeyTime', P.l(times)), N1('KeyValueFloat', P.f(vals)),
            N1('KeyAttrFlags', P.i([4 | 256 | 8192 | 16384])), N1('KeyAttrDataFloat', P.f([0, 0, 9.419963346924634e-30, 0])), N1('KeyAttrRefCount', P.i([n])),
          ]));
          count('AnimationCurve');
          C('OP', cId, cnId, 'd|' + axis);
        });
      }
    }
    const take = new Node('Take', [P.S(name)], [N1('FileName', P.S(name.replace(/[^\w-]+/g, '_') + '.tak')), new Node('LocalTime', [P.L(0n), P.L(stop)]), new Node('ReferenceTime', [P.L(0n), P.L(stop)])]);
    takes.push(take);
    report.clips++;
  }

  // ---- materials (in slot order) and their textures; nothing above may wait, the scene is live
  for (const [mats, id] of pendingMats) for (const mat of mats) C('OO', await materialNode(mat), id);

  // ---- header, settings, definitions
  const timeMode = { 24: 11, 25: 10, 30: 6, 48: 5, 50: 4, 60: 3, 100: 2, 120: 1 }[fps] ?? 14;
  const creator = 'WebBlend FBX export';
  const header = new Node('FBXHeaderExtension', [], [
    N1('FBXHeaderVersion', P.I(1003)), N1('FBXVersion', P.I(7400)), N1('EncryptionType', P.I(0)),
    new Node('CreationTimeStamp', [], [N1('Version', P.I(1000)), N1('Year', P.I(1970)), N1('Month', P.I(1)), N1('Day', P.I(1)), N1('Hour', P.I(10)), N1('Minute', P.I(0)), N1('Second', P.I(0)), N1('Millisecond', P.I(0))]),
    N1('Creator', P.S(creator)),
    new Node('SceneInfo', [nameClass('GlobalInfo', 'SceneInfo'), P.S('UserData')], [
      N1('Type', P.S('UserData')), N1('Version', P.I(100)),
      new Node('MetaData', [], [N1('Version', P.I(100)), N1('Title', P.S('')), N1('Subject', P.S('')), N1('Author', P.S('')), N1('Keywords', P.S('')), N1('Revision', P.S('')), N1('Comment', P.S(''))]),
      props70(pUrl('DocumentUrl', '/scene.fbx'), pUrl('SrcDocumentUrl', '/scene.fbx'), pr('Original', 'Compound', '', ''), pString('Original|ApplicationVendor', 'WebBlend'), pString('Original|ApplicationName', 'WebBlend'), pString('Original|ApplicationVersion', '1'), pr('Original|DateTime_GMT', 'DateTime', '', '', P.S('01/01/1970 00:00:00.000')), pString('Original|FileName', '/scene.fbx'),
        pr('LastSaved', 'Compound', '', ''), pString('LastSaved|ApplicationVendor', 'WebBlend'), pString('LastSaved|ApplicationName', 'WebBlend'), pString('LastSaved|ApplicationVersion', '1'), pr('LastSaved|DateTime_GMT', 'DateTime', '', '', P.S('01/01/1970 00:00:00.000'))),
    ]),
  ]);
  const globals = new Node('GlobalSettings', [], [N1('Version', P.I(1000)), props70(
    pInt('UpAxis', 1), pInt('UpAxisSign', 1), pInt('FrontAxis', 2), pInt('FrontAxisSign', 1), pInt('CoordAxis', 0), pInt('CoordAxisSign', 1),
    pInt('OriginalUpAxis', 1), pInt('OriginalUpAxisSign', 1), pDouble('UnitScaleFactor', unitScaleFactor), pDouble('OriginalUnitScaleFactor', unitScaleFactor),
    pColorRGB('AmbientColor', [0, 0, 0]), pString('DefaultCamera', 'Producer Perspective'), pEnum('TimeMode', timeMode),
    pTime('TimeSpanStart', 0n), pTime('TimeSpanStop', secToKtime(longest || 1)), pDouble('CustomFrameRate', fps),
  )]);
  const docId = uid();
  const documents = new Node('Documents', [], [N1('Count', P.I(1)), new Node('Document', [P.L(docId), P.S('Scene'), P.S('Scene')], [props70(pr('SourceObject', 'object', '', ''), pString('ActiveAnimStackName', '')), N1('RootNode', P.L(0n))])]);
  count('GlobalSettings');
  const defs = new Node('Definitions', [], [N1('Version', P.I(100)), N1('Count', P.I(Object.values(counts).reduce((a, b) => a + b, 0)))]);
  for (const [t, c] of Object.entries(counts)) defs.add(new Node('ObjectType', [P.S(t)], [N1('Count', P.I(c))]));
  const file = encodeFBX([
    header, N1('FileId', P.R(FILE_ID)), N1('CreationTime', P.S('1970-01-01 10:00:00:000')), N1('Creator', P.S(creator)),
    globals, documents, new Node('References'), defs,
    new Node('Objects', [], objects), new Node('Connections', [], conns), new Node('Takes', [], takes),
  ]);
  return { bytes: file, report };
}
