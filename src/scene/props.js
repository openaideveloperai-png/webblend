// Props the AI (or the built-in presets) can make: a model is a list of parts
// (rounded boxes, bevelled extrusions of 2D outlines, lathes, tubes...) with
// physically based materials and small procedural surface textures (brushed
// metal, stippled grips, knurling, wood...). Static parts are merged per
// material, moving parts (slide, bolt, trigger, magazine) stay separate.
//
// Prop frame: +Z forward (barrel / edge), +Y up (thumb side when held), +X
// the prop's left. Units are meters. Anchors (grip, support, muzzle, eject,
// stock, sight) say where hands go and where effects come out.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const D2R = Math.PI / 180;

// ---------------------------------------------------------------- textures
// small grayscale/color canvases, shared; used as bump/roughness/color maps
const texCache = new Map();
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function makeCanvas(size) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(size, size);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = c.height = size; return c; }
  return null;
}

function canvasTexture(key, size, draw, colorSpace = THREE.NoColorSpace) {
  if (texCache.has(key)) return texCache.get(key);
  const cv = makeCanvas(size);
  let tex = null;
  if (cv) {
    const g = cv.getContext('2d');
    if (g) {
      draw(g, size);
      tex = new THREE.CanvasTexture(cv);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = colorSpace;
      tex.anisotropy = 4;
      tex.name = 'prop-' + key;
    }
  }
  texCache.set(key, tex);
  return tex;
}

const PATTERNS = {
  // tile = meters one texture repeat covers
  brushed: { tile: 0.08, bump: 0.25, rough: true, draw(g, s) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, s, s);
    const r = rng(7);
    for (let i = 0; i < 900; i++) { const y = r() * s, l = s * (0.2 + r() * 0.8), x = r() * s, v = 100 + r() * 60; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(x, y, l, 1); g.fillRect(x - s, y, l, 1); }
  } },
  stipple: { tile: 0.025, bump: 0.9, rough: false, draw(g, s) {
    g.fillStyle = '#7a7a7a'; g.fillRect(0, 0, s, s);
    const r = rng(11);
    for (let i = 0; i < 1400; i++) { const x = r() * s, y = r() * s, rad = 1 + r() * 2.2, v = r() < 0.5 ? 40 : 200; g.fillStyle = `rgb(${v},${v},${v})`; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill(); }
  } },
  knurled: { tile: 0.012, bump: 0.8, rough: false, draw(g, s) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, s, s);
    g.strokeStyle = '#202020'; g.lineWidth = s / 16;
    for (let i = -s; i <= 2 * s; i += s / 4) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s, s); g.stroke(); g.beginPath(); g.moveTo(i, s); g.lineTo(i + s, 0); g.stroke(); }
  } },
  serrated: { tile: 0.004, bump: 1, rough: false, draw(g, s) {
    const grd = g.createLinearGradient(0, 0, s, 0); grd.addColorStop(0, '#202020'); grd.addColorStop(0.5, '#e0e0e0'); grd.addColorStop(1, '#202020');
    g.fillStyle = grd; g.fillRect(0, 0, s, s);
  } },
  rubber: { tile: 0.03, bump: 0.35, rough: false, draw(g, s) {
    const id = g.createImageData(s, s); const r = rng(3);
    for (let i = 0; i < id.data.length; i += 4) { const v = 110 + r() * 40; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    g.putImageData(id, 0, 0);
  } },
  leather: { tile: 0.04, bump: 0.5, rough: false, draw(g, s) {
    g.fillStyle = '#909090'; g.fillRect(0, 0, s, s);
    const r = rng(5);
    for (let i = 0; i < 260; i++) { const x = r() * s, y = r() * s; g.strokeStyle = `rgba(30,30,30,${0.25 + r() * 0.4})`; g.lineWidth = 1 + r(); g.beginPath(); g.moveTo(x, y); g.lineTo(x + (r() - 0.5) * 20, y + (r() - 0.5) * 20); g.stroke(); }
  } },
  fabric: { tile: 0.01, bump: 0.6, rough: false, draw(g, s) {
    g.fillStyle = '#808080'; g.fillRect(0, 0, s, s);
    const n = 8, w = s / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = (i + j) % 2 ? 60 : 190; g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(i * w + 1, j * w + 1, w - 2, w - 2); }
  } },
  scratched: { tile: 0.12, bump: 0.15, rough: true, draw(g, s) {
    g.fillStyle = '#8a8a8a'; g.fillRect(0, 0, s, s);
    const r = rng(19);
    for (let i = 0; i < 160; i++) { const x = r() * s, y = r() * s, a = r() * 7, l = 4 + r() * 30, v = r() < 0.5 ? 60 : 210; g.strokeStyle = `rgb(${v},${v},${v})`; g.lineWidth = 0.6; g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke(); }
  } },
  wood: { tile: 0.25, bump: 0.12, rough: false, color: true, draw(g, s) {
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, s, s);
    const r = rng(23);
    for (let y = 0; y < s; y++) { const v = 200 + Math.sin(y * 0.15 + Math.sin(y * 0.031) * 4) * 30 + (r() - 0.5) * 20; g.fillStyle = `rgb(${v | 0},${(v * 0.92) | 0},${(v * 0.85) | 0})`; g.fillRect(0, y, s, 1); }
    for (let i = 0; i < 6; i++) { const y = r() * s; g.fillStyle = 'rgba(80,50,30,0.25)'; g.fillRect(0, y, s, 1 + r() * 2); }
  } },
  carbon: { tile: 0.02, bump: 0.3, rough: false, color: true, draw(g, s) {
    const n = 4, w = s / n;
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const grd = (i + j) % 2 ? g.createLinearGradient(i * w, 0, i * w + w, 0) : g.createLinearGradient(0, j * w, 0, j * w + w);
      grd.addColorStop(0, '#5a5a5a'); grd.addColorStop(0.5, '#d0d0d0'); grd.addColorStop(1, '#5a5a5a');
      g.fillStyle = grd; g.fillRect(i * w, j * w, w, w);
    }
  } },
};
export const TEXTURES = ['none', ...Object.keys(PATTERNS), 'glow'];

// ---------------------------------------------------------------- materials
function colorOf(c, fallback = '#888888') {
  try { return new THREE.Color(typeof c === 'string' && c ? c : fallback); } catch { return new THREE.Color(fallback); }
}

export function makeMaterial(spec = {}) {
  const tex = PATTERNS[spec.texture] ? spec.texture : null;
  const metal = THREE.MathUtils.clamp(Number(spec.metalness ?? 0), 0, 1);
  const rough = THREE.MathUtils.clamp(Number(spec.roughness ?? 0.5), 0.02, 1);
  const opacity = THREE.MathUtils.clamp(Number(spec.opacity ?? 1), 0.05, 1);
  const polished = spec.texture === 'carbon' || (metal < 0.3 && rough < 0.25);
  const M = polished ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial;
  const m = new M({ color: colorOf(spec.color), metalness: metal, roughness: rough });
  if (polished && m.isMeshPhysicalMaterial) { m.clearcoat = 0.8; m.clearcoatRoughness = 0.15; }
  m.name = String(spec.name || 'material');
  if (spec.emissive && spec.emissive !== '#000000') {
    m.emissive = colorOf(spec.emissive, '#000000');
    m.emissiveIntensity = THREE.MathUtils.clamp(Number(spec.emissiveIntensity ?? 1), 0, 20);
  }
  if (spec.texture === 'glow') { m.emissive = m.color.clone(); m.emissiveIntensity = Math.max(1.5, m.emissiveIntensity || 0); m.toneMapped = false; }
  if (opacity < 1) { m.transparent = true; m.opacity = opacity; m.depthWrite = opacity > 0.6; }
  if (tex) {
    const P = PATTERNS[tex];
    const t = canvasTexture(tex, P.color ? 256 : 128, P.draw, P.color ? THREE.SRGBColorSpace : THREE.NoColorSpace);
    if (t) {
      if (P.color) m.map = t;
      m.bumpMap = t;
      m.bumpScale = P.bump;
      if (P.rough) m.roughnessMap = t;
      m.userData.tile = P.tile;
    }
  }
  return m;
}

// ---------------------------------------------------------------- geometry
const AXIS_FROM_Y = { x: (g) => g.rotateZ(-Math.PI / 2), y: () => {}, z: (g) => g.rotateX(Math.PI / 2) };
const AXIS_FROM_Z = { x: (g) => g.rotateY(-Math.PI / 2), y: (g) => g.rotateX(Math.PI / 2), z: () => {} };
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pos2 = (p) => (Array.isArray(p) && p.length >= 2 ? new THREE.Vector2(num(p[0]), num(p[1])) : null);

function shapeFrom(points, holes) {
  const pts = (points || []).map(pos2).filter(Boolean);
  if (pts.length < 3) return null;
  if (THREE.ShapeUtils.isClockWise(pts)) pts.reverse();
  const shape = new THREE.Shape(pts);
  for (const h of holes || []) {
    const hp = (h || []).map(pos2).filter(Boolean);
    if (hp.length < 3) continue;
    if (!THREE.ShapeUtils.isClockWise(hp)) hp.reverse();
    shape.holes.push(new THREE.Path(hp));
  }
  return shape;
}

export function partGeometry(p) {
  const d = Array.isArray(p.dims) ? p.dims.map((v) => Math.abs(num(v))) : [];
  const axis = ['x', 'y', 'z'].includes(p.axis) ? p.axis : 'y';
  const segs = THREE.MathUtils.clamp(Math.round(num(p.segments, 24)), 3, 64);
  const bevel = Math.max(0, num(p.bevel));
  let g = null;
  switch (p.shape) {
    case 'box': case 'roundbox': {
      const [w = 0.1, h = 0.1, dd = 0.1] = d;
      const r = Math.min(bevel, Math.min(w, h, dd) / 2 - 1e-5);
      g = r > 1e-5 ? new RoundedBoxGeometry(w, h, dd, 2, r) : new THREE.BoxGeometry(w, h, dd);
      break;
    }
    case 'cylinder': case 'cone': {
      const [rt = 0.05, rb = rt, len = 0.1] = d;
      g = new THREE.CylinderGeometry(p.shape === 'cone' ? 0 : rt, rb, len, segs, 1, false);
      AXIS_FROM_Y[axis](g);
      break;
    }
    case 'tube': {
      const [ro = 0.05, ri = ro * 0.7, len = 0.1] = d;
      const inner = Math.min(ri, ro * 0.98);
      g = new THREE.LatheGeometry([new THREE.Vector2(inner, -len / 2), new THREE.Vector2(ro, -len / 2), new THREE.Vector2(ro, len / 2), new THREE.Vector2(inner, len / 2), new THREE.Vector2(inner, -len / 2)], segs);
      AXIS_FROM_Y[axis](g);
      break;
    }
    case 'sphere': {
      const [rx = 0.05, ry = rx, rz = rx] = d;
      g = new THREE.SphereGeometry(1, Math.max(12, segs), Math.max(8, Math.round(segs * 0.6)));
      g.scale(rx || 0.05, ry || rx || 0.05, rz || rx || 0.05);
      break;
    }
    case 'capsule': {
      const [r = 0.03, len = 0.1] = d;
      g = new THREE.CapsuleGeometry(r, Math.max(0, len - 2 * r), 6, Math.max(8, segs));
      AXIS_FROM_Y[axis](g);
      break;
    }
    case 'torus': {
      const [R = 0.05, r = 0.01, arc = 360] = d;
      g = new THREE.TorusGeometry(R, Math.min(r, R), 10, Math.max(12, segs), THREE.MathUtils.clamp(arc || 360, 1, 360) * D2R);
      AXIS_FROM_Z[axis](g);
      break;
    }
    case 'extrude': {
      const shape = shapeFrom(p.profile, p.holes);
      if (!shape) return null;
      const depth = d[0] || 0.01;
      const bt = Math.min(bevel, depth * 0.45);
      g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(1e-4, depth - 2 * bt), bevelEnabled: bt > 1e-5, bevelThickness: bt, bevelSize: bt * 0.9, bevelSegments: 2, curveSegments: 8 });
      g.translate(0, 0, -(depth - 2 * bt) / 2);
      AXIS_FROM_Z[axis](g);
      break;
    }
    case 'lathe': {
      const pts = (p.profile || []).map(pos2).filter(Boolean).map((v) => new THREE.Vector2(Math.max(0, v.x), v.y));
      if (pts.length < 2) return null;
      g = new THREE.LatheGeometry(pts, Math.max(8, segs));
      AXIS_FROM_Y[axis](g);
      break;
    }
    case 'helix': {
      // a wrap / spring: [radius, wire radius, length, turns]
      const [R = 0.015, r = 0.0015, len = 0.1] = d;
      const turns = num(p.dims && p.dims[3], 8) || 8;
      const curve = new THREE.Curve();
      curve.getPoint = (t, out = new THREE.Vector3()) => out.set(Math.cos(t * turns * 2 * Math.PI) * R, (t - 0.5) * len, Math.sin(t * turns * 2 * Math.PI) * R);
      g = new THREE.TubeGeometry(curve, Math.max(32, Math.round(turns * 16)), Math.min(r, R), 6, false);
      AXIS_FROM_Y[axis](g);
      break;
    }
    default: return null;
  }
  return g;
}

// metric "box projection" UVs so procedural textures have the same scale everywhere
function metricUV(g, tile) {
  if (!g.attributes.normal) g.computeVertexNormals();
  const p = g.attributes.position, n = g.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ax >= ay && ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else if (ay >= az) { u = p.getZ(i); v = p.getX(i); }
    else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u / tile; uv[i * 2 + 1] = v / tile;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

// ---------------------------------------------------------------- build
const MOVING = /^(slide|bolt|trigger|hammer|magazine|mag|pump|forend|charging|cylinder_gun|barrel_move)/i;
const vec3 = (a, d = [0, 0, 0]) => new THREE.Vector3(...(Array.isArray(a) && a.length >= 3 ? a.slice(0, 3).map((v) => num(v)) : d));

// spec -> THREE.Group with userData.prop {kind, anchors, moving, ...}
export function buildProp(spec) {
  const root = new THREE.Group();
  root.name = String(spec.name || 'Prop').slice(0, 40);
  const mats = new Map();
  for (const ms of spec.materials || []) mats.set(String(ms.name), makeMaterial(ms));
  const matOf = (name) => {
    if (!mats.has(name)) mats.set(name, makeMaterial({ name: name || 'default', color: '#7a7d82', metalness: 0.3, roughness: 0.5 }));
    return mats.get(name);
  };
  // part transforms (relative to parent part)
  const parts = (spec.parts || []).filter((p) => p && p.shape).slice(0, 400);
  const byName = new Map();
  parts.forEach((p, i) => { p._i = i; if (p.name && !byName.has(p.name)) byName.set(p.name, p); });
  const local = (p) => {
    const m = new THREE.Matrix4();
    const e = new THREE.Euler(...(Array.isArray(p.rot) ? p.rot.slice(0, 3).map((v) => num(v) * D2R) : [0, 0, 0]), 'XYZ');
    m.compose(vec3(p.pos), new THREE.Quaternion().setFromEuler(e), new THREE.Vector3(1, 1, 1));
    return m;
  };
  const world = new Map();
  const worldOf = (p, depth = 0) => {
    if (world.has(p)) return world.get(p);
    const par = p.parent && byName.get(p.parent);
    const m = par && par !== p && depth < 32 ? worldOf(par, depth + 1).clone().multiply(local(p)) : local(p);
    world.set(p, m);
    return m;
  };
  // which moving part (if any) each part rides on
  const movingRoot = (p, depth = 0) => {
    if (MOVING.test(p.name || '') || p.moving) return p;
    const par = p.parent && byName.get(p.parent);
    return par && par !== p && depth < 32 ? movingRoot(par, depth + 1) : null;
  };
  const groups = new Map(); // key -> {mover, mat, geos}
  for (const p of parts) {
    const g0 = partGeometry(p);
    if (!g0) continue;
    const mat = matOf(p.material);
    let g = g0.index ? g0.toNonIndexed() : g0;
    if (g !== g0) g0.dispose();
    const mover = movingRoot(p);
    // into the mover's frame (or the prop's)
    const M = worldOf(p).clone();
    if (mover) M.premultiply(worldOf(mover).clone().invert());
    g.applyMatrix4(M);
    // remove attributes mergeGeometries can't line up
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    g.clearGroups();
    const key = (mover ? mover.name : '') + '|' + (p.material || '');
    if (!groups.has(key)) groups.set(key, { mover, mat, geos: [] });
    groups.get(key).geos.push(g);
  }
  const moverNodes = new Map();
  const nodeFor = (mover) => {
    if (!mover) return root;
    if (moverNodes.has(mover)) return moverNodes.get(mover);
    const n = new THREE.Group();
    n.name = mover.name;
    worldOf(mover).decompose(n.position, n.quaternion, n.scale);
    root.add(n);
    moverNodes.set(mover, n);
    return n;
  };
  for (const [, grp] of groups) {
    for (const g of grp.geos) metricUV(g, grp.mat.userData.tile || 0.05);
    const merged = grp.geos.length === 1 ? grp.geos[0] : mergeGeometries(grp.geos, false);
    if (!merged) continue;
    if (grp.geos.length > 1) for (const g of grp.geos) g.dispose();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, grp.mat);
    mesh.name = `${grp.mover ? grp.mover.name : root.name} (${grp.mat.name})`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    nodeFor(grp.mover).add(mesh);
  }
  const A = spec.anchors || {};
  const anchors = {};
  for (const k of ['grip', 'support', 'muzzle', 'eject', 'stock', 'sight']) if (Array.isArray(A[k]) && A[k].length >= 3) anchors[k] = vec3(A[k]);
  if (!anchors.grip) {
    // hold it near one end of its longest side if nobody said where
    const box = new THREE.Box3().setFromObject(root);
    anchors.grip = box.isEmpty() ? new THREE.Vector3() : box.getCenter(new THREE.Vector3());
  }
  const moving = {};
  for (const [mv, node] of moverNodes) moving[mv.name.toLowerCase()] = node;
  const slideName = String(spec.slide || '').toLowerCase();
  const slideNode = moving[slideName] || moving.slide || moving.bolt || moving.pump || moving.forend || null;
  root.userData.prop = {
    kind: spec.kind || 'prop',
    preset: spec.preset || 'custom',
    anchors,
    slideTravel: num(spec.slideTravel, slideNode ? 0.02 : 0),
    slideNode: slideNode ? slideNode.name : null,
    triggerNode: moving.trigger ? moving.trigger.name : null,
    fireRate: num(spec.fireRate, 0),
    caliber: spec.caliber || null,
    auto: !!spec.auto,
    action: spec.action || null,
  };
  root.userData.generatedProp = true;
  return root;
}

// ---------------------------------------------------------------- presets
// color schemes for the built-in models
const STYLES = {
  black: { frame: '#26282c', metal: '#383b41', accent: '#4a4e56', furniture: '#2a2c30' },
  tan: { frame: '#8a7553', metal: '#26282c', accent: '#3a3d42', furniture: '#8a7553' },
  od: { frame: '#4a5136', metal: '#25272b', accent: '#3a3d42', furniture: '#4a5136' },
  silver: { frame: '#1b1c1f', metal: '#b6babf', accent: '#8d9196', furniture: '#1d1e21' },
  gold: { frame: '#1b1c1f', metal: '#c9a44c', accent: '#9a7a35', furniture: '#2a2320' },
  wood: { frame: '#5b3a22', metal: '#2a2c30', accent: '#3a3d42', furniture: '#6b4426' },
  white: { frame: '#d9d9d6', metal: '#2a2c30', accent: '#9a9da2', furniture: '#d9d9d6' },
  red: { frame: '#7a1c1c', metal: '#26282c', accent: '#3a3d42', furniture: '#7a1c1c' },
  pink: { frame: '#d98aa8', metal: '#2a2c30', accent: '#ffffff', furniture: '#d98aa8' },
  blue: { frame: '#23406e', metal: '#26282c', accent: '#3a3d42', furniture: '#23406e' },
};
export const STYLE_NAMES = Object.keys(STYLES);

function baseMaterials(st, furnitureTexture = 'stipple') {
  const s = STYLES[st] || STYLES.black;
  return [
    { name: 'polymer', color: s.frame, metalness: 0.0, roughness: 0.62, texture: 'rubber' },
    { name: 'grip', color: s.furniture, metalness: 0.0, roughness: 0.85, texture: furnitureTexture },
    { name: 'steel', color: s.metal, metalness: 0.88, roughness: 0.28, texture: 'brushed' },
    { name: 'darksteel', color: '#2a2c31', metalness: 0.85, roughness: 0.38, texture: 'scratched' },
    { name: 'alu', color: s.accent, metalness: 0.65, roughness: 0.45, texture: 'scratched' },
    { name: 'dark', color: '#111214', metalness: 0.2, roughness: 0.6 },
    { name: 'brass', color: '#c8a050', metalness: 0.95, roughness: 0.25 },
    { name: 'sightdot', color: '#9dff8a', emissive: '#7dff6a', emissiveIntensity: 1.6, roughness: 0.3 },
    { name: 'white', color: '#f2f2f2', roughness: 0.4 },
    { name: 'glass', color: '#3b5f7a', metalness: 0.1, roughness: 0.05, opacity: 0.45 },
    { name: 'reddot', color: '#ff2a2a', emissive: '#ff1a1a', emissiveIntensity: 3, roughness: 0.2 },
    { name: 'rubber', color: '#151517', metalness: 0, roughness: 0.92, texture: 'rubber' },
    { name: 'wood', color: s.furniture === s.frame && st !== 'wood' ? '#6b4426' : s.furniture, metalness: 0, roughness: 0.55, texture: 'wood' },
  ];
}

const box = (name, material, pos, dims, extra = {}) => ({ name, shape: 'box', material, pos, dims, bevel: extra.bevel ?? Math.min(...dims) * 0.18, ...extra });
const cyl = (name, material, pos, dims, axis = 'z', extra = {}) => ({ name, shape: 'cylinder', material, pos, dims, axis, ...extra });
const ext = (name, material, depth, profile, extra = {}) => ({ name, shape: 'extrude', material, axis: 'x', dims: [depth], profile, pos: [0, 0, 0], bevel: extra.bevel ?? depth * 0.12, ...extra });

// A striker-fired pistol (Glock/P320 class), ~19 cm long
function pistolSpec(o = {}) {
  const st = o.style || 'black';
  const parts = [
    ext('frame', 'polymer', 0.026, [[0.100, 0.010], [0.100, -0.006], [0.040, -0.006], [0.036, -0.030], [0.026, -0.044], [-0.004, -0.046], [-0.018, -0.040], [-0.024, -0.055], [-0.028, -0.068], [-0.032, -0.080], [-0.036, -0.092], [-0.040, -0.104], [-0.048, -0.112], [-0.086, -0.112], [-0.092, -0.100], [-0.088, -0.070], [-0.082, -0.040], [-0.080, -0.020], [-0.086, -0.004], [-0.092, 0.004], [-0.084, 0.010]],
      { holes: [[[0.030, -0.010], [0.026, -0.030], [0.018, -0.038], [-0.002, -0.039], [-0.012, -0.034], [-0.014, -0.012], [-0.008, -0.009]]], bevel: 0.002 }),
    ext('grip panel', 'grip', 0.0285, [[-0.027, -0.050], [-0.031, -0.068], [-0.035, -0.082], [-0.039, -0.098], [-0.084, -0.100], [-0.083, -0.072], [-0.078, -0.042], [-0.076, -0.026], [-0.030, -0.026]], { bevel: 0.0018 }),
    // slide and what rides on it
    ext('slide', 'steel', 0.0235, [[-0.077, 0.008], [0.114, 0.008], [0.116, 0.012], [0.116, 0.036], [0.110, 0.042], [-0.072, 0.042], [-0.077, 0.037]], { bevel: 0.0016 }),
    box('ejection port', 'dark', [-0.0115, 0.034, 0.024], [0.002, 0.010, 0.036], { parent: 'slide', bevel: 0.0006 }),
    box('barrel hood', 'brass', [-0.0104, 0.034, 0.024], [0.0012, 0.0085, 0.033], { parent: 'slide', bevel: 0.0004 }),
    box('rear sight', 'dark', [0, 0.0455, -0.066], [0.019, 0.006, 0.007], { parent: 'slide', bevel: 0.001 }),
    box('rear sight notch', 'steel', [0, 0.0475, -0.066], [0.0035, 0.0025, 0.0075], { parent: 'slide', bevel: 0.0003 }),
    { name: 'rear dot L', shape: 'sphere', material: 'sightdot', parent: 'slide', pos: [0.0055, 0.0465, -0.0625], dims: [0.0011], segments: 10 },
    { name: 'rear dot R', shape: 'sphere', material: 'sightdot', parent: 'slide', pos: [-0.0055, 0.0465, -0.0625], dims: [0.0011], segments: 10 },
    box('front sight', 'dark', [0, 0.0455, 0.106], [0.0035, 0.0065, 0.006], { parent: 'slide', bevel: 0.0008 }),
    { name: 'front dot', shape: 'sphere', material: 'sightdot', parent: 'slide', pos: [0, 0.047, 0.1092], dims: [0.0012], segments: 10 },
    // barrel crown and guide rod at the muzzle end
    { name: 'muzzle', shape: 'tube', material: 'darksteel', axis: 'z', pos: [0, 0.025, 0.1175], dims: [0.0066, 0.0046, 0.004], segments: 20 },
    cyl('guide rod', 'darksteel', [0, 0.003, 0.1005], [0.0035, 0.0035, 0.003], 'z', { segments: 12 }),
    // controls and pins
    box('slide stop', 'darksteel', [0.0138, 0.0055, -0.004], [0.0022, 0.004, 0.022], { bevel: 0.0007 }),
    box('takedown', 'darksteel', [0.0138, 0.0035, 0.022], [0.0022, 0.0045, 0.008], { bevel: 0.0007 }),
    box('mag release', 'darksteel', [0.0135, -0.016, -0.022], [0.0022, 0.007, 0.006], { bevel: 0.001 }),
    cyl('trigger pin', 'darksteel', [0, -0.0035, 0.008], [0.0016, 0.0016, 0.0275], 'x', { segments: 10 }),
    cyl('locking pin', 'darksteel', [0, 0.0025, 0.031], [0.0016, 0.0016, 0.0275], 'x', { segments: 10 }),
    // accessory rail
    ...[0.052, 0.066, 0.080].map((z, i) => box('rail ' + i, 'polymer', [0, -0.0085, z], [0.022, 0.004, 0.0045], { bevel: 0.0008 })),
    // trigger (moves) and magazine base
    ext('trigger', 'darksteel', 0.0062, [[0.0100, -0.0090], [0.0150, -0.0200], [0.0130, -0.0320], [0.0060, -0.0365], [0.0040, -0.0310], [0.0070, -0.0200], [0.0045, -0.0090]], { bevel: 0.0012 }),
    box('magazine', 'polymer', [0, -0.1155, -0.0665], [0.027, 0.008, 0.044], { rot: [18, 0, 0], bevel: 0.002 }),
  ];
  // slide serrations, both sides, rear and front
  const serr = [];
  for (let i = 0; i < 9; i++) for (const x of [0.01185, -0.01185]) serr.push(box(`serration ${i}${x > 0 ? 'L' : 'R'}`, 'darksteel', [x, 0.025, -0.069 + i * 0.0042], [0.0008, 0.024, 0.0016], { parent: 'slide', bevel: 0.0002 }));
  for (let i = 0; i < 5; i++) for (const x of [0.01185, -0.01185]) serr.push(box(`front serration ${i}${x > 0 ? 'L' : 'R'}`, 'darksteel', [x, 0.027, 0.076 + i * 0.0042], [0.0008, 0.018, 0.0016], { parent: 'slide', bevel: 0.0002 }));
  return {
    name: o.name || 'Pistol', kind: 'gun', preset: 'pistol', materials: baseMaterials(st), parts: [...parts, ...serr],
    anchors: { grip: [0, -0.056, -0.058], support: [0.020, -0.066, -0.048], muzzle: [0, 0.025, 0.121], eject: [-0.013, 0.036, 0.024], sight: [0, 0.047, 0] },
    slide: 'slide', slideTravel: 0.024, fireRate: 4, caliber: '9mm', action: 'semi',
  };
}

// AR-pattern rifle family: rifle, carbine/SMG, marksman/sniper; shotgun is a pump variant
function rifleSpec(o = {}) {
  const v = o.variant || 'rifle';
  const st = o.style || 'black';
  const hgLen = { rifle: 0.34, smg: 0.17, sniper: 0.40, shotgun: 0.24 }[v] || 0.34;
  const barrelOut = { rifle: 0.13, smg: 0.04, sniper: 0.32, shotgun: 0.30 }[v] || 0.13;
  const hg0 = 0.128, hg1 = hg0 + hgLen;
  const bEnd = hg1 + barrelOut;
  const parts = [];
  // receivers
  parts.push(ext('upper receiver', 'alu', 0.031, [[-0.122, -0.012], [0.130, -0.012], [0.130, 0.020], [0.122, 0.030], [-0.110, 0.030], [-0.122, 0.022]], { bevel: 0.0022 }));
  parts.push(ext('lower receiver', 'alu', 0.029, [[-0.117, -0.012], [0.106, -0.012], [0.101, -0.030], [0.089, -0.072], [0.033, -0.072], [0.031, -0.050], [-0.040, -0.050], [-0.060, -0.044], [-0.090, -0.040], [-0.117, -0.030]], { bevel: 0.002 }));
  parts.push(ext('trigger guard', 'alu', 0.011, [[0.026, -0.049], [0.023, -0.077], [-0.046, -0.077], [-0.053, -0.049]], { holes: [[[0.017, -0.053], [0.015, -0.069], [-0.040, -0.069], [-0.045, -0.053]]], bevel: 0.0015 }));
  parts.push(ext('trigger', 'darksteel', 0.0055, [[-0.004, -0.048], [0.001, -0.058], [-0.001, -0.068], [-0.007, -0.071], [-0.008, -0.066], [-0.005, -0.058], [-0.009, -0.048]], { bevel: 0.001 }));
  parts.push(ext('pistol grip', 'grip', 0.031, [[-0.046, -0.046], [-0.052, -0.074], [-0.058, -0.100], [-0.062, -0.126], [-0.068, -0.150], [-0.108, -0.153], [-0.103, -0.120], [-0.096, -0.085], [-0.092, -0.055], [-0.094, -0.044]], { bevel: 0.003 }));
  // top rail
  parts.push(box('top rail', 'alu', [0, 0.033, 0.004], [0.021, 0.006, 0.244], { bevel: 0.0012 }));
  for (let z = -0.112; z < 0.122; z += 0.0105) parts.push(box('rail rib', 'alu', [0, 0.0375, z], [0.0235, 0.004, 0.0055], { bevel: 0.0008 }));
  // ejection port, dust cover, bolt (moves), forward assist, charging handle
  parts.push(box('ejection port', 'dark', [-0.0158, 0.010, 0.026], [0.0015, 0.016, 0.050], { bevel: 0.0005 }));
  parts.push(box('bolt', 'steel', [-0.0150, 0.010, 0.026], [0.0016, 0.012, 0.044], { bevel: 0.0005 }));
  parts.push(cyl('forward assist', 'darksteel', [-0.012, 0.021, -0.048], [0.0055, 0.0055, 0.022], 'z', { rot: [0, -25, 0], segments: 14 }));
  parts.push(box('charging handle', 'darksteel', [0, 0.024, -0.124], [0.034, 0.008, 0.012], { bevel: 0.002 }));
  // controls and pins
  parts.push(box('selector', 'darksteel', [0.0158, -0.024, -0.066], [0.002, 0.005, 0.016], { rot: [30, 0, 0], bevel: 0.0008 }));
  parts.push(box('mag release', 'darksteel', [-0.0155, -0.032, 0.024], [0.002, 0.008, 0.008], { bevel: 0.001 }));
  parts.push(box('bolt catch', 'darksteel', [0.0155, -0.022, 0.030], [0.002, 0.014, 0.006], { bevel: 0.0008 }));
  for (const [z, y] of [[-0.090, -0.020], [0.092, -0.016], [-0.020, -0.040], [-0.040, -0.040]]) parts.push(cyl('pin', 'darksteel', [0, y, z], [0.0022, 0.0022, 0.0305], 'x', { segments: 10 }));
  // magazine (moves on reload)
  if (v === 'shotgun') {
    parts.push(cyl('tube magazine', 'darksteel', [0, -0.026, hg0 + hgLen * 0.5 + 0.04], [0.011, 0.011, hgLen + 0.14], 'z', { segments: 20 }));
  } else {
    const deep = v === 'smg' ? 0.16 : 0.185;
    parts.push(ext('magazine', st === 'tan' ? 'polymer' : 'darksteel', 0.0225, [[0.035, -0.060], [0.087, -0.060], [0.093, -0.060 - deep * 0.32], [0.103, -0.060 - deep * 0.66], [0.115, -0.060 - deep], [0.119, -0.070 - deep], [0.061, -0.075 - deep], [0.057, -0.065 - deep], [0.047, -0.060 - deep * 0.66], [0.039, -0.060 - deep * 0.32]], { bevel: 0.0016 }));
    for (let i = 0; i < 3; i++) parts.push(box('mag rib', 'dark', [0, -0.090 - i * 0.04, 0.068 + i * 0.005], [0.0232, 0.003, 0.03], { parent: 'magazine', rot: [-10 - i * 4, 0, 0], bevel: 0.0008 }));
  }
  // handguard (octagonal) with slots, or a pump forend
  if (v === 'shotgun') {
    parts.push(cyl('barrel', 'darksteel', [0, 0.004, (hg0 + bEnd) / 2], [0.0115, 0.0115, bEnd - hg0], 'z', { segments: 24 }));
    parts.push({ name: 'pump', shape: 'lathe', material: 'wood', axis: 'z', pos: [0, -0.024, hg0 + 0.13], segments: 24, profile: [[0.0, -0.07], [0.019, -0.07], [0.023, -0.06], [0.023, 0.06], [0.019, 0.07], [0.0, 0.07]] });
    for (let i = 0; i < 6; i++) parts.push({ name: 'pump groove', shape: 'torus', material: 'dark', parent: 'pump', axis: 'z', pos: [0, 0, -0.045 + i * 0.018], dims: [0.0232, 0.0018, 360], segments: 24 });
    parts.push({ name: 'bead sight', shape: 'sphere', material: 'brass', pos: [0, 0.017, bEnd - 0.01], dims: [0.0025] });
  } else {
    parts.push({ name: 'handguard', shape: 'cylinder', material: 'alu', axis: 'z', pos: [0, 0.004, (hg0 + hg1) / 2], dims: [0.026, 0.026, hgLen], segments: 8, rot: [0, 0, 22.5] });
    for (let z = hg0 + 0.04; z < hg1 - 0.03; z += 0.06) for (const [x, y, rz] of [[0.0242, 0.004, 0], [-0.0242, 0.004, 0], [0, -0.0202, 90]]) parts.push(box('mlok slot', 'dark', [x, y, z], [0.0016, 0.0085, 0.032], { rot: [0, 0, rz], bevel: 0.0007 }));
    parts.push(box('handguard rail', 'alu', [0, 0.031, (hg0 + hg1) / 2], [0.021, 0.006, hgLen - 0.01], { bevel: 0.0012 }));
    for (let z = hg0 + 0.01; z < hg1 - 0.01; z += 0.0105) parts.push(box('rail rib', 'alu', [0, 0.0355, z], [0.0235, 0.004, 0.0055], { bevel: 0.0008 }));
    parts.push(cyl('barrel', 'darksteel', [0, 0.004, (hg1 + bEnd) / 2], [0.0095, 0.0095, bEnd - hg1], 'z', { segments: 20 }));
    // flash hider
    parts.push({ name: 'flash hider', shape: 'lathe', material: 'darksteel', axis: 'z', pos: [0, 0.004, bEnd], segments: 20, profile: [[0.0045, 0], [0.011, 0], [0.011, 0.008], [0.0103, 0.011], [0.0103, 0.044], [0.0118, 0.048], [0.0118, 0.056], [0.0045, 0.056], [0.0045, 0]] });
    for (let i = 0; i < 4; i++) parts.push(box('hider slot', 'dark', [Math.cos(i * Math.PI / 2) * 0.0104, 0.004 + Math.sin(i * Math.PI / 2) * 0.0104, bEnd + 0.028], [0.0016, 0.0016, 0.026], { bevel: 0.0004 }));
  }
  const muzzleZ = v === 'shotgun' ? bEnd + 0.002 : bEnd + 0.058;
  // stock: buffer tube + adjustable stock (shotgun: solid wood)
  if (v === 'shotgun') {
    parts.push(ext('stock', 'wood', 0.040, [[-0.115, 0.022], [-0.35, 0.018], [-0.36, 0.010], [-0.36, -0.105], [-0.34, -0.112], [-0.27, -0.060], [-0.17, -0.040], [-0.115, -0.034]], { bevel: 0.006 }));
    parts.push(box('butt pad', 'rubber', [0, -0.044, -0.368], [0.042, 0.125, 0.014], { bevel: 0.005 }));
  } else {
    const len = v === 'smg' ? 0.14 : 0.18;
    parts.push(cyl('buffer tube', 'alu', [0, 0.005, -0.122 - len / 2], [0.0148, 0.0148, len], 'z', { segments: 20 }));
    const b = -0.122 - len;
    parts.push(ext('stock', 'polymer', 0.040, [[b + 0.165, 0.024], [b + 0.005, 0.028], [b - 0.005, 0.021], [b - 0.010, -0.074], [b + 0.010, -0.084], [b + 0.055, -0.040], [b + 0.125, -0.020], [b + 0.165, -0.016]], { bevel: 0.004 }));
    parts.push(box('butt pad', 'rubber', [0, -0.027, b - 0.016], [0.042, 0.112, 0.012], { bevel: 0.004 }));
    parts.push({ name: 'sling loop', shape: 'torus', material: 'darksteel', axis: 'x', pos: [0, -0.045, b + 0.03], dims: [0.009, 0.0018, 360], segments: 20 });
  }
  // optics
  const optic = o.optic || (v === 'sniper' ? 'scope' : v === 'shotgun' ? 'none' : 'reddot');
  let sightY = 0.04;
  if (optic === 'reddot') {
    parts.push(box('optic mount', 'alu', [0, 0.046, -0.01], [0.018, 0.016, 0.032], { bevel: 0.002 }));
    parts.push({ name: 'optic body', shape: 'tube', material: 'alu', axis: 'z', pos: [0, 0.067, -0.008], dims: [0.0175, 0.0142, 0.058], segments: 28 });
    parts.push(cyl('optic lens', 'glass', [0, 0.067, 0.014], [0.0142, 0.0142, 0.002], 'z', { segments: 28 }));
    parts.push({ name: 'red dot', shape: 'sphere', material: 'reddot', pos: [0, 0.067, 0.012], dims: [0.0012], segments: 10 });
    parts.push(cyl('optic knob', 'darksteel', [0.0195, 0.067, -0.012], [0.006, 0.006, 0.006], 'x', { segments: 14 }));
    sightY = 0.067;
  } else if (optic === 'scope') {
    parts.push(box('scope ring F', 'alu', [0, 0.050, 0.050], [0.026, 0.024, 0.016], { bevel: 0.003 }));
    parts.push(box('scope ring R', 'alu', [0, 0.050, -0.060], [0.026, 0.024, 0.016], { bevel: 0.003 }));
    parts.push({ name: 'scope', shape: 'lathe', material: 'darksteel', axis: 'z', pos: [0, 0.066, -0.005], segments: 32, profile: [[0.0, -0.17], [0.019, -0.17], [0.021, -0.155], [0.0135, -0.11], [0.0135, 0.07], [0.022, 0.12], [0.023, 0.17], [0.0, 0.17]] });
    parts.push(cyl('turret top', 'darksteel', [0, 0.087, -0.005], [0.009, 0.009, 0.014], 'y', { segments: 18 }));
    parts.push(cyl('turret side', 'darksteel', [-0.019, 0.066, -0.005], [0.009, 0.009, 0.014], 'x', { segments: 18 }));
    parts.push(cyl('scope lens', 'glass', [0, 0.066, 0.1655], [0.020, 0.020, 0.002], 'z', { segments: 28 }));
    sightY = 0.066;
  } else {
    parts.push(box('rear sight', 'darksteel', [0, 0.045, -0.095], [0.018, 0.012, 0.012], { bevel: 0.002 }));
    if (v !== 'shotgun') parts.push(box('front sight', 'darksteel', [0, 0.042, hg1 - 0.01], [0.008, 0.018, 0.008], { bevel: 0.0015 }));
    sightY = 0.048;
  }
  if (v === 'sniper') {
    // bipod
    parts.push(box('bipod mount', 'darksteel', [0, -0.026, hg1 - 0.04], [0.02, 0.012, 0.03], { bevel: 0.002 }));
    for (const x of [0.012, -0.012]) parts.push(cyl('bipod leg', 'darksteel', [x, -0.030, hg1 - 0.14], [0.0045, 0.0045, 0.20], 'z', { segments: 10 }));
  }
  const name = o.name || { rifle: 'Rifle', smg: 'SMG', sniper: 'Sniper rifle', shotgun: 'Shotgun' }[v];
  const supportZ = v === 'shotgun' ? hg0 + 0.13 : hg0 + Math.min(0.12, hgLen * 0.6);
  return {
    name, kind: 'gun', preset: v, materials: baseMaterials(st, v === 'shotgun' ? 'wood' : 'stipple'), parts,
    anchors: { grip: [0, -0.096, -0.077], support: [0.012, v === 'shotgun' ? -0.040 : -0.028, supportZ], muzzle: [0, 0.004, muzzleZ], eject: [-0.017, 0.012, 0.026], stock: [0, -0.028, v === 'shotgun' ? -0.375 : (-0.122 - (v === 'smg' ? 0.14 : 0.18) - 0.022)], sight: [0, sightY, 0] },
    slide: v === 'shotgun' ? 'pump' : 'bolt', slideTravel: v === 'shotgun' ? 0.07 : 0.032,
    fireRate: { rifle: 10, smg: 14, sniper: 0.8, shotgun: 1.2 }[v], caliber: { rifle: '5.56', smg: '9mm', sniper: '.308', shotgun: '12ga' }[v],
    auto: v === 'rifle' || v === 'smg', action: v === 'shotgun' ? 'pump' : v === 'sniper' ? 'bolt' : 'auto',
  };
}

// Swords and knives: handle along +Y from the hand, edge toward +Z
function bladeSpec(o = {}) {
  const v = o.variant || 'sword';
  const st = o.style || 'silver';
  const steel = { name: 'blade', color: st === 'gold' ? '#d4b05a' : st === 'black' ? '#2b2d31' : '#cfd3d8', metalness: 0.95, roughness: 0.18, texture: 'brushed' };
  const mats = [steel, { name: 'guard', color: st === 'gold' ? '#b08a3a' : '#5b5e63', metalness: 0.9, roughness: 0.3, texture: 'scratched' },
    { name: 'wrap', color: v === 'katana' ? '#1d2747' : '#4a2f1c', metalness: 0, roughness: 0.8, texture: v === 'katana' ? 'knurled' : 'leather' },
    { name: 'dark', color: '#0d0d0f', roughness: 0.5 }, { name: 'ray', color: '#ecebe4', roughness: 0.6, texture: 'stipple' }];
  const parts = [];
  if (v === 'knife') {
    parts.push(ext('blade', 'blade', 0.0035, [[0.0, 0.0], [0.016, 0.0], [0.017, 0.08], [0.008, 0.125], [0.0, 0.135], [-0.004, 0.10], [-0.012, 0.02], [-0.012, 0.0]], { axis: 'x', bevel: 0.0014 }));
    parts.push(box('bolster', 'guard', [0, -0.004, 0.002], [0.016, 0.008, 0.036], { bevel: 0.002 }));
    parts.push(box('handle', 'wrap', [0, -0.058, 0.002], [0.020, 0.10, 0.026], { bevel: 0.008 }));
    for (const y of [-0.03, -0.085]) parts.push(cyl('rivet', 'guard', [0, y, 0.002], [0.003, 0.003, 0.0215], 'x', { segments: 12 }));
    return { name: o.name || 'Knife', kind: 'melee', preset: 'knife', materials: mats, parts, anchors: { grip: [0, -0.055, 0.0], muzzle: [0, 0.135, 0] } };
  }
  if (v === 'katana') {
    // curved blade: build the outline along a gentle arc
    const L = 0.70, pts = [];
    const back = [], edge = [];
    for (let i = 0; i <= 14; i++) {
      const t = i / 14, y = t * L, curve = -0.025 * t * t;
      const w = 0.030 - t * 0.006;
      back.push([curve - w * 0.35, y]);
      edge.push([curve + w * 0.65, y]);
    }
    edge[edge.length - 1] = [edge[edge.length - 1][0] - 0.012, L + 0.03];
    pts.push(...back, ...edge.reverse());
    parts.push(ext('blade', 'blade', 0.0055, pts, { axis: 'x', bevel: 0.0024 }));
    parts.push(cyl('habaki', 'guard', [0, 0.006, 0], [0.012, 0.012, 0.03], 'y', { segments: 14 }));
    parts.push({ name: 'tsuba', shape: 'cylinder', material: 'guard', axis: 'y', pos: [0, -0.012, 0], dims: [0.042, 0.042, 0.007], segments: 32 });
    parts.push(cyl('handle', 'wrap', [0, -0.15, 0], [0.0145, 0.0155, 0.26], 'y', { segments: 20 }));
    for (let i = 0; i < 8; i++) parts.push({ name: 'ray diamond', shape: 'sphere', material: 'ray', pos: [0.0148, -0.04 - i * 0.03, 0], dims: [0.0012, 0.009, 0.006], segments: 10 });
    for (let i = 0; i < 8; i++) parts.push({ name: 'ray diamond', shape: 'sphere', material: 'ray', pos: [-0.0148, -0.04 - i * 0.03, 0], dims: [0.0012, 0.009, 0.006], segments: 10 });
    parts.push(cyl('kashira', 'guard', [0, -0.285, 0], [0.016, 0.015, 0.012], 'y', { segments: 18 }));
    return { name: o.name || 'Katana', kind: 'melee', preset: 'katana', materials: mats, parts, anchors: { grip: [0, -0.07, 0], support: [0, -0.20, 0], muzzle: [0, 0.73, -0.02] } };
  }
  // longsword
  parts.push(ext('blade', 'blade', 0.0055, [[-0.022, 0.0], [0.022, 0.0], [0.020, 0.55], [0.012, 0.66], [0.0, 0.72], [-0.012, 0.66], [-0.020, 0.55]], { axis: 'x', bevel: 0.0026 }));
  for (const x of [0.0033, -0.0033]) parts.push(box('fuller', 'dark', [x, 0.25, 0], [0.0008, 0.42, 0.007], { bevel: 0.0003 }));
  parts.push(box('crossguard', 'guard', [0, -0.010, 0], [0.026, 0.020, 0.21], { bevel: 0.006 }));
  for (const z of [0.105, -0.105]) parts.push({ name: 'guard end', shape: 'sphere', material: 'guard', pos: [0, -0.010, z], dims: [0.013], segments: 16 });
  parts.push(cyl('grip', 'wrap', [0, -0.11, 0], [0.0145, 0.0165, 0.18], 'y', { segments: 18 }));
  parts.push({ name: 'grip wrap', shape: 'helix', material: 'wrap', axis: 'y', pos: [0, -0.11, 0], dims: [0.0158, 0.0022, 0.17, 10] });
  parts.push({ name: 'pommel', shape: 'lathe', material: 'guard', axis: 'y', pos: [0, -0.215, 0], segments: 24, profile: [[0, -0.022], [0.014, -0.020], [0.022, -0.008], [0.022, 0.006], [0.012, 0.018], [0, 0.020]] });
  return { name: o.name || 'Sword', kind: 'melee', preset: 'sword', materials: mats, parts, anchors: { grip: [0, -0.07, 0], support: [0, -0.16, 0], muzzle: [0, 0.72, 0] } };
}

function batSpec(o = {}) {
  return {
    name: o.name || 'Baseball bat', kind: 'melee', preset: 'bat',
    materials: [{ name: 'wood', color: '#c9a06a', roughness: 0.45, texture: 'wood' }, { name: 'tape', color: '#151515', roughness: 0.9, texture: 'fabric' }],
    parts: [
      { name: 'bat', shape: 'lathe', material: 'wood', axis: 'y', pos: [0, -0.14, 0], segments: 28, profile: [[0, -0.02], [0.026, -0.018], [0.03, -0.008], [0.013, 0.0], [0.012, 0.25], [0.022, 0.45], [0.032, 0.70], [0.033, 0.82], [0.026, 0.84], [0, 0.845]] },
      cyl('tape', 'tape', [0, -0.03, 0], [0.0135, 0.0135, 0.2], 'y', { segments: 20 }),
    ],
    anchors: { grip: [0, -0.06, 0], support: [0, 0.02, 0], muzzle: [0, 0.70, 0] },
  };
}

// name -> preset (words the offline AI understands)
export const PROP_PRESETS = {
  pistol: { words: ['pistol', 'handgun', 'gun', 'glock', 'revolver', 'firearm', 'sidearm', 'gat', 'piece', '9mm', 'deagle', 'desert eagle', 'beretta', 'colt'], make: (o) => pistolSpec(o) },
  rifle: { words: ['rifle', 'assault rifle', 'ar15', 'ar-15', 'ar 15', 'm4', 'm16', 'ak', 'ak47', 'ak-47', 'carbine', 'machine gun', 'machinegun', 'battle rifle', 'scar'], make: (o) => rifleSpec({ ...o, variant: 'rifle' }) },
  smg: { words: ['smg', 'submachine gun', 'sub machine gun', 'uzi', 'mp5', 'mp7', 'vector', 'pdw'], make: (o) => rifleSpec({ ...o, variant: 'smg' }) },
  sniper: { words: ['sniper', 'sniper rifle', 'marksman rifle', 'dmr', 'awp', 'scoped rifle'], make: (o) => rifleSpec({ ...o, variant: 'sniper' }) },
  shotgun: { words: ['shotgun', 'pump shotgun', 'pump action', 'boomstick', '12 gauge'], make: (o) => rifleSpec({ ...o, style: o.style || 'wood', variant: 'shotgun' }) },
  sword: { words: ['sword', 'longsword', 'broadsword', 'blade', 'saber', 'sabre'], make: (o) => bladeSpec({ ...o, variant: 'sword' }) },
  katana: { words: ['katana', 'samurai sword', 'nodachi', 'tachi'], make: (o) => bladeSpec({ ...o, variant: 'katana' }) },
  knife: { words: ['knife', 'dagger', 'combat knife', 'kunai'], make: (o) => bladeSpec({ ...o, variant: 'knife' }) },
  bat: { words: ['bat', 'baseball bat', 'club'], make: (o) => batSpec(o) },
};

export function presetSpec(name, opts = {}) {
  const p = PROP_PRESETS[name];
  return p ? p.make(opts) : null;
}

// find a preset named in free text ("make her a pump shotgun") -> key or null
export function findPresetIn(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ') + ' ';
  let best = null, bestLen = 0;
  for (const [key, p] of Object.entries(PROP_PRESETS)) {
    for (const w of p.words) {
      if (t.includes(' ' + w + ' ') && w.length > bestLen) { best = key; bestLen = w.length; }
    }
  }
  return best;
}

export function findStyleIn(text) {
  const t = String(text || '').toLowerCase();
  const map = { tan: /\b(tan|fde|desert|sand|coyote)\b/, od: /\b(od|olive|green)\b/, silver: /\b(silver|chrome|stainless|nickel)\b/, gold: /\b(gold|golden)\b/, wood: /\b(wood|wooden)\b/, white: /\b(white|arctic)\b/, red: /\b(red)\b/, pink: /\b(pink)\b/, blue: /\b(blue)\b/, black: /\b(black)\b/ };
  for (const [k, re] of Object.entries(map)) if (re.test(t)) return k;
  return null;
}
