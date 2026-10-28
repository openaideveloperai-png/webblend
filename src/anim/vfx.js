// Visual effects baked into clips: trails swept by a blade or body part, particle
// emitters and shaped effect meshes (shockwaves, flying slashes, glows, beams...).
// An effect is a list of elements (Claude composes them; presets are ready-made
// elements). Positions come from evaluating the clip itself, so a trail follows the
// blade exactly; everything ends up as keyframes on pooled meshes under the model,
// so effects scrub, loop and export like any other animation.
import * as THREE from 'three';
import { anchorsOfProp, heldProps } from './props-anim.js';

const clamp = THREE.MathUtils.clamp;
const smooth = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
function rnd(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const col = (c, d = '#ffffff') => { try { return new THREE.Color(typeof c === 'string' && c.trim() ? c.trim() : d); } catch { return new THREE.Color(d); } };
const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// ---------------------------------------------------------------- textures
const texCache = new Map();
function canvasTex(key, w, h, draw) {
  if (texCache.has(key)) return texCache.get(key);
  let cv = null;
  if (typeof OffscreenCanvas !== 'undefined') cv = new OffscreenCanvas(w, h);
  else if (typeof document !== 'undefined') { cv = document.createElement('canvas'); cv.width = w; cv.height = h; }
  let t = null;
  if (cv) {
    const g = cv.getContext('2d');
    if (g) { draw(g, w, h); t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.name = 'vfx-' + key; }
  }
  texCache.set(key, t);
  return t;
}
const TEX = {
  soft: () => canvasTex('soft', 128, 128, (g, w) => { const r = g.createRadialGradient(w / 2, w / 2, 0, w / 2, w / 2, w / 2); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,255,255,0.75)'); r.addColorStop(0.6, 'rgba(255,255,255,0.2)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, w, w); }),
  streak: () => canvasTex('streak', 64, 256, (g, w, h) => { const lg = g.createLinearGradient(0, 0, 0, h); lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.15, 'rgba(255,255,255,1)'); lg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = lg; g.fillRect(0, 0, w, h); const cg = g.createLinearGradient(0, 0, w, 0); cg.addColorStop(0, 'rgba(0,0,0,1)'); cg.addColorStop(0.5, 'rgba(0,0,0,0)'); cg.addColorStop(1, 'rgba(0,0,0,1)'); g.globalCompositeOperation = 'destination-out'; g.fillStyle = cg; g.fillRect(0, 0, w, h); }),
  flame: () => canvasTex('flame', 64, 128, (g, w, h) => { const r = g.createRadialGradient(w / 2, h * 0.72, 2, w / 2, h * 0.6, h * 0.55); r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.35, 'rgba(255,255,255,0.7)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.beginPath(); g.moveTo(w / 2, 0); g.bezierCurveTo(w * 0.95, h * 0.45, w * 0.95, h, w / 2, h); g.bezierCurveTo(w * 0.05, h, w * 0.05, h * 0.45, w / 2, 0); g.fill(); }),
  smoke: () => canvasTex('smoke', 128, 128, (g, w) => { const r0 = rnd(5); for (let i = 0; i < 26; i++) { const x = w / 2 + (r0() - 0.5) * w * 0.45, y = w / 2 + (r0() - 0.5) * w * 0.45, rr = w * (0.12 + r0() * 0.22); const r = g.createRadialGradient(x, y, 0, x, y, rr); r.addColorStop(0, 'rgba(255,255,255,0.22)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, w, w); } }),
  ring: () => canvasTex('ring', 256, 256, (g, w) => { const r = g.createRadialGradient(w / 2, w / 2, w * 0.3, w / 2, w / 2, w / 2); r.addColorStop(0, 'rgba(255,255,255,0)'); r.addColorStop(0.55, 'rgba(255,255,255,0.35)'); r.addColorStop(0.85, 'rgba(255,255,255,1)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, w, w); }),
  band: () => canvasTex('band', 16, 128, (g, w, h) => { const lg = g.createLinearGradient(0, 0, 0, h); lg.addColorStop(0, 'rgba(255,255,255,0)'); lg.addColorStop(0.5, 'rgba(255,255,255,1)'); lg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = lg; g.fillRect(0, 0, w, h); }),
  fadeUp: () => canvasTex('fadeup', 16, 128, (g, w, h) => { const lg = g.createLinearGradient(0, h, 0, 0); lg.addColorStop(0, 'rgba(255,255,255,1)'); lg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = lg; g.fillRect(0, 0, w, h); }),
  circle: () => canvasTex('circle', 512, 512, (g, w) => {
    const c = w / 2; g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineCap = 'round';
    for (const [r, lw] of [[0.96, 6], [0.86, 3], [0.62, 4], [0.4, 3]]) { g.lineWidth = lw; g.beginPath(); g.arc(c, c, r * c, 0, Math.PI * 2); g.stroke(); }
    g.lineWidth = 3; g.beginPath(); for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + i * (Math.PI * 4 / 5); const x = c + Math.cos(a) * c * 0.62, y = c + Math.sin(a) * c * 0.62; i ? g.lineTo(x, y) : g.moveTo(x, y); } g.stroke();
    g.font = `${Math.round(w * 0.045)}px serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    const runes = 'ᚠᚢᚦᚨᚱᚲᚷᚹᚺᚾᛁᛃᛇᛈᛉᛊᛏᛒᛖᛗᛚᛜᛞᛟ';
    for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2; g.save(); g.translate(c + Math.cos(a) * c * 0.91, c + Math.sin(a) * c * 0.91); g.rotate(a + Math.PI / 2); g.fillText(runes[i % runes.length], 0, 0); g.restore(); }
    const r = g.createRadialGradient(c, c, 0, c, c, c); r.addColorStop(0, 'rgba(255,255,255,0.18)'); r.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = r; g.fillRect(0, 0, w, w);
  }),
};

// ---------------------------------------------------------------- shapes
const shapeCache = new Map();
function cached(key, make) { if (!shapeCache.has(key)) shapeCache.set(key, make()); return shapeCache.get(key); }
// three crossed quads: reads as a soft blob from every side
function crossed(w = 1, h = 1, yOffset = 0) {
  const geos = [];
  for (const [rx, ry] of [[0, 0], [0, Math.PI / 2], [Math.PI / 2, 0]]) { const p = new THREE.PlaneGeometry(w, h); p.translate(0, yOffset, 0); p.rotateX(rx); p.rotateY(ry); geos.push(p); }
  return mergeSimple(geos);
}
function mergeSimple(geos) {
  let n = 0; for (const g of geos) n += g.index.count;
  const pos = [], uv = [], idx = [];
  let base = 0;
  for (const g of geos) {
    const p = g.attributes.position, u = g.attributes.uv;
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); uv.push(u.getX(i), u.getY(i)); }
    for (const i of g.index.array) idx.push(i + base);
    base += p.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  out.setIndex(idx);
  out.computeVertexNormals();
  return out;
}
function flatShape(points, bend = 0) {
  const s = new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ShapeGeometry(s, 6);
  if (bend) { const p = g.attributes.position; for (let i = 0; i < p.count; i++) p.setZ(i, bend * (p.getX(i) ** 2) * 4); g.computeVertexNormals(); }
  // UVs over the shape's box so textures center
  g.computeBoundingBox();
  const b = g.boundingBox, p = g.attributes.position, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) { uv[i * 2] = (p.getX(i) - b.min.x) / (b.max.x - b.min.x || 1); uv[i * 2 + 1] = (p.getY(i) - b.min.y) / (b.max.y - b.min.y || 1); }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
const star = (n = 5, inner = 0.42) => Array.from({ length: n * 2 }, (_, i) => { const a = Math.PI / 2 + (i / (n * 2)) * Math.PI * 2, r = i % 2 ? inner * 0.5 : 0.5; return [Math.cos(a) * r, Math.sin(a) * r]; });
const PARTICLE_SHAPES = {
  // [geometry (unit size), texture, default blend, orient: 'velocity' | 'tumble' | 'up' | 'none']
  spark: () => [cached('spark', () => { const g = crossed(0.14, 1, 0); g.rotateX(Math.PI / 2); return g; }), TEX.streak(), 'glow', 'velocity'],
  orb: () => [cached('orb', () => crossed(1, 1)), TEX.soft(), 'glow', 'none'],
  ember: () => [cached('orb', () => crossed(1, 1)), TEX.soft(), 'glow', 'none'],
  smoke: () => [cached('orb', () => crossed(1, 1)), TEX.smoke(), 'ink', 'tumble'],
  flame: () => [cached('flame', () => { const g = mergeSimple([new THREE.PlaneGeometry(0.6, 1).translate(0, 0.35, 0), new THREE.PlaneGeometry(0.6, 1).translate(0, 0.35, 0).rotateY(Math.PI / 2)]); return g; }), TEX.flame(), 'glow', 'up'],
  star: () => [cached('star', () => flatShape(star())), null, 'glow', 'tumble'],
  heart: () => [cached('heart', () => { const s = new THREE.Shape(); s.moveTo(0, -0.42); s.bezierCurveTo(-0.7, 0.05, -0.32, 0.55, 0, 0.22); s.bezierCurveTo(0.32, 0.55, 0.7, 0.05, 0, -0.42); return flatShape(s.getPoints(20).map((v) => [v.x, v.y])); }), null, 'solid', 'tumble'],
  petal: () => [cached('petal', () => flatShape([[0, -0.5], [0.28, -0.25], [0.32, 0.15], [0.12, 0.45], [0, 0.38], [-0.12, 0.45], [-0.32, 0.15], [-0.28, -0.25]], 0.18)), null, 'solid', 'tumble'],
  leaf: () => [cached('leaf', () => flatShape([[0, -0.5], [0.25, -0.2], [0.3, 0.1], [0, 0.5], [-0.3, 0.1], [-0.25, -0.2]], 0.12)), null, 'solid', 'tumble'],
  shard: () => [cached('shard', () => { const g = new THREE.OctahedronGeometry(0.5, 0); g.scale(0.5, 1, 0.35); return g; }), null, 'solid', 'tumble'],
  square: () => [cached('square', () => new THREE.PlaneGeometry(1, 0.6)), null, 'solid', 'tumble'],
  snow: () => [cached('snow', () => new THREE.IcosahedronGeometry(0.5, 1)), null, 'solid', 'none'],
  bubble: () => [cached('orb', () => crossed(1, 1)), TEX.ring(), 'glow', 'none'],
  bolt: () => [cached('boltp', () => { const g = crossed(0.12, 1); g.rotateX(Math.PI / 2); return g; }), TEX.streak(), 'glow', 'velocity'],
};
export const PARTICLE_SHAPE_NAMES = Object.keys(PARTICLE_SHAPES);
export const MESH_SHAPE_NAMES = ['sphere', 'ring', 'disc', 'circle', 'crescent', 'cone', 'beam', 'pillar', 'spiral', 'shell', 'bolt', 'star'];

function makeMaterial(color, blend, map, opacity = 1, vertexColors = false) {
  const ink = blend === 'ink', glow = blend === 'glow';
  return new THREE.MeshBasicMaterial({
    color, map: map || null, transparent: true, opacity, depthWrite: !glow && !ink && !map, side: THREE.DoubleSide,
    blending: glow ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: !glow, vertexColors,
  });
}
// light blending can't show dark colors: pick what will actually be visible
function blendFor(spec, color, fallback) {
  const b = spec.blend && spec.blend !== 'auto' ? spec.blend : fallback;
  if (b === 'glow' && lum(color) < 0.12) return 'ink';
  return b;
}

// ---------------------------------------------------------------- presets
// Each preset is a complete element; a spec's own values override it.
export const VFX_PRESETS = {
  slash: { kind: 'trail', attach: 'blade', when: 'swings', color: '#9fd4ff', color2: '#ffffff', blend: 'glow', length: 0.2, fade: 0.22, label: 'bright slash trail swept by the blade' },
  'dark-slash': { kind: 'trail', attach: 'blade', when: 'swings', color: '#2a0b45', color2: '#b27bff', blend: 'ink', length: 0.24, fade: 0.3, label: 'dark ink slash trail with a violet edge' },
  'fire-slash': { kind: 'trail', attach: 'blade', when: 'swings', color: '#ff5a1a', color2: '#fff2a0', blend: 'glow', length: 0.22, fade: 0.25, label: 'burning orange trail' },
  'ice-slash': { kind: 'trail', attach: 'blade', when: 'swings', color: '#5fd6ff', color2: '#f2ffff', blend: 'glow', length: 0.22, fade: 0.3, label: 'icy cyan trail' },
  'hand-trail': { kind: 'trail', attach: 'rightHand', when: 'fast', width: 0.16, color: '#9fd4ff', color2: '#ffffff', blend: 'glow', length: 0.16, fade: 0.18, label: 'streak behind a fast hand or foot (punches, kicks)' },
  sparks: { kind: 'particles', shape: 'spark', attach: 'tip', when: 'swings', count: 18, life: 0.35, size: 0.05, sizeEnd: 0.01, speed: 3.2, spread: 70, direction: 'along', gravity: 6, drag: 1.5, inherit: 0.25, color: '#ffc46b', color2: '#fff6d0', blend: 'glow', label: 'hot sparks flying off' },
  petals: { kind: 'particles', shape: 'petal', attach: 'blade', when: 'swings', count: 26, life: 1.6, size: 0.035, sizeEnd: 0.03, speed: 0.9, spread: 120, direction: 'along', gravity: 0.9, drag: 2.2, spin: 300, inherit: 0.15, color: '#ff8fbd', color2: '#ffd6e6', blend: 'solid', label: 'flower petals scattering' },
  embers: { kind: 'particles', shape: 'ember', attach: 'blade', when: 'swings', count: 22, life: 0.9, size: 0.03, sizeEnd: 0.005, speed: 0.9, spread: 160, direction: 'up', gravity: -1.2, drag: 1, inherit: 0.2, color: '#ff7a1a', color2: '#ffe08a', blend: 'glow', label: 'glowing embers drifting up' },
  flames: { kind: 'particles', shape: 'flame', attach: 'blade', when: 'always', count: 60, life: 0.45, size: 0.06, sizeEnd: 0.015, speed: 0.6, spread: 30, direction: 'up', gravity: -2, drag: 2, color: '#ff4a10', color2: '#ffd36b', blend: 'glow', label: 'flames licking off a burning weapon or body part' },
  smoke: { kind: 'particles', shape: 'smoke', attach: 'ground', when: 'times', count: 10, life: 1.6, size: 0.25, sizeEnd: 0.9, speed: 0.5, spread: 180, direction: 'out', gravity: -0.3, drag: 1.2, spin: 40, color: '#5a5a62', color2: '#8a8a92', blend: 'ink', opacity: 0.7, label: 'puffs of smoke' },
  dust: { kind: 'particles', shape: 'smoke', attach: 'ground', when: 'times', count: 14, life: 1.1, size: 0.12, sizeEnd: 0.5, speed: 1.4, spread: 25, direction: 'out', gravity: 0.6, drag: 2.5, color: '#9a8a70', color2: '#c2b496', blend: 'ink', opacity: 0.6, label: 'dust kicked up from the floor' },
  magic: { kind: 'particles', shape: 'star', attach: 'rightHand', when: 'always', count: 40, life: 0.9, size: 0.03, sizeEnd: 0.0, speed: 0.4, spread: 180, direction: 'out', gravity: -0.4, drag: 1, spin: 360, color: '#9a6bff', color2: '#ffffff', blend: 'glow', label: 'twinkling magic sparkles' },
  lightning: { kind: 'particles', shape: 'bolt', attach: 'blade', when: 'swings', count: 14, life: 0.12, size: 0.18, sizeEnd: 0.08, speed: 2, spread: 180, direction: 'out', color: '#7ab8ff', color2: '#ffffff', blend: 'glow', label: 'crackling electric arcs' },
  leaves: { kind: 'particles', shape: 'leaf', attach: 'root', when: 'always', count: 20, life: 2.5, size: 0.05, speed: 0.8, spread: 180, direction: 'out', gravity: 0.5, drag: 1.2, spin: 200, color: '#5aa83a', color2: '#9ad35a', blend: 'solid', label: 'leaves swirling' },
  snow: { kind: 'particles', shape: 'snow', attach: 'root', when: 'always', count: 50, life: 3, size: 0.015, speed: 0.2, spread: 180, direction: 'down', gravity: 0.3, drag: 1, color: '#ffffff', blend: 'solid', label: 'falling snow' },
  hearts: { kind: 'particles', shape: 'heart', attach: 'head', when: 'always', count: 10, life: 1.4, size: 0.06, sizeEnd: 0.03, speed: 0.4, spread: 50, direction: 'up', gravity: -0.4, drag: 1, spin: 60, color: '#ff4f8a', blend: 'solid', label: 'floating hearts' },
  confetti: { kind: 'particles', shape: 'square', attach: 'head', when: 'times', count: 60, life: 2.2, size: 0.03, speed: 3, spread: 50, direction: 'up', gravity: 3, drag: 1.8, spin: 600, color: '#ff4f8a', color2: '#4fc3ff', blend: 'solid', label: 'confetti burst (multicolor)' },
  shards: { kind: 'particles', shape: 'shard', attach: 'tip', when: 'times', count: 16, life: 1, size: 0.04, speed: 3, spread: 70, direction: 'forward', gravity: 9, drag: 0.5, spin: 500, color: '#a8d8ff', blend: 'solid', label: 'debris or crystal shards' },
  flash: { kind: 'mesh', shape: 'sphere', attach: 'tip', when: 'times', duration: 0.14, size: 0.2, sizeEnd: 0.45, color: '#ffe9b0', color2: '#ffffff', blend: 'glow', label: 'quick bright flash' },
  shockwave: { kind: 'mesh', shape: 'ring', attach: 'ground', when: 'times', duration: 0.5, size: 0.3, sizeEnd: 2.6, color: '#bfe4ff', blend: 'glow', label: 'ring expanding over the floor' },
  'energy-slash': { kind: 'mesh', shape: 'crescent', attach: 'blade', when: 'swings', duration: 0.7, size: 0.9, sizeEnd: 1.4, travel: 8, direction: 'forward', color: '#7fc8ff', color2: '#ffffff', blend: 'glow', label: 'crescent of energy flying off the swing' },
  'blade-glow': { kind: 'mesh', shape: 'shell', attach: 'blade', when: 'always', follow: true, size: 1, sizeEnd: 1, color: '#7fc8ff', blend: 'glow', opacity: 0.7, label: 'glow hugging the blade' },
  aura: { kind: 'mesh', shape: 'spiral', attach: 'hips', when: 'always', follow: true, size: 0.9, sizeEnd: 0.9, spin: 240, color: '#ffd24a', color2: '#ffffff', blend: 'glow', opacity: 0.7, label: 'whirling aura around the body' },
  'magic-circle': { kind: 'mesh', shape: 'circle', attach: 'ground', when: 'times', duration: 1.6, size: 1.6, sizeEnd: 1.8, spin: 50, color: '#9a6bff', blend: 'glow', label: 'glowing rune circle on the floor' },
  'light-pillar': { kind: 'mesh', shape: 'pillar', attach: 'ground', when: 'times', duration: 1.2, size: 0.6, sizeEnd: 0.9, length: 3, color: '#fff2b0', blend: 'glow', label: 'column of light' },
  beam: { kind: 'mesh', shape: 'beam', attach: 'tip', when: 'times', duration: 0.5, size: 0.05, sizeEnd: 0.02, length: 8, direction: 'forward', color: '#ff3a6a', color2: '#ffffff', blend: 'glow', label: 'laser / energy beam' },
  'lightning-bolt': { kind: 'mesh', shape: 'bolt', attach: 'tip', when: 'times', duration: 0.25, size: 0.06, length: 2.5, direction: 'forward', color: '#8ec5ff', color2: '#ffffff', blend: 'glow', label: 'jagged lightning bolt' },
};
export const VFX_PRESET_NAMES = Object.keys(VFX_PRESETS);

// a spec's values (unset = -1 / "" / [] / null) over its preset's
export function resolveSpec(s) {
  const base = VFX_PRESETS[s && s.preset] || {};
  const out = { ...base };
  for (const [k, v] of Object.entries(s || {})) {
    if (v === undefined || v === null || v === '' || v === -1 || (Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  if (!out.kind) out.kind = MESH_SHAPE_NAMES.includes(out.shape) ? 'mesh' : PARTICLE_SHAPES[out.shape] ? 'particles' : 'trail';
  if (!out.attach) out.attach = 'blade';
  if (!out.when) out.when = out.times && out.times.length ? 'times' : 'always';
  out.name = String(out.name || s.preset || out.kind).slice(0, 40);
  return out;
}

// ---------------------------------------------------------------- sampling
// Evaluates the clip on a scratch mixer and reads points in the model's own space.
function sampler(model, clip) {
  const root = model.root;
  const saved = [];
  root.traverse((o) => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  // start every frame from the rest pose (other clips don't leak in)
  // (not the nodes the clip animates: three.js only writes a value when it changed since
  // the last evaluation, so resetting those would lose poses the clip holds still)
  const animated = new Set(clip.tracks.map((t) => t.name.slice(0, t.name.indexOf('.'))));
  const base = saved.filter(([o]) => !animated.has(o.uuid) && !animated.has(o.name)).map(([o, p, q, sc]) => { const r = o !== root && model.rest && model.rest.get(o); return r ? [o, r.p.clone(), r.q.clone(), r.s.clone()] : [o, p.clone(), q.clone(), sc.clone()]; });
  const mixer = new THREE.AnimationMixer(root);
  // played once and held: sampling at the very end must not wrap to the first frame
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const inv = new THREE.Matrix4();
  let last = NaN;
  return {
    at(t) {
      if (t === last) return;
      last = t;
      for (const [o, p, q, s] of base) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
      mixer.setTime(clamp(t, 0, Math.max(0, clip.duration - 1e-4)));
      root.updateMatrixWorld(true);
      inv.copy(root.matrixWorld).invert();
    },
    // local point on a node -> model space
    point(node, local, out = new THREE.Vector3()) {
      out.copy(local || new THREE.Vector3());
      if (node) out.applyMatrix4(node.matrixWorld).applyMatrix4(inv);
      return out;
    },
    quat(node) { const m = node.matrixWorld.clone().premultiply(inv); const q = new THREE.Quaternion(); m.decompose(new THREE.Vector3(), q, new THREE.Vector3()); return q; },
    done() {
      mixer.stopAllAction(); mixer.uncacheRoot(root);
      for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
      root.updateMatrixWorld(true);
    },
  };
}

// the character's frame (model space): lat = its left, up, fwd
function frameOf(model) {
  const r = model.humanoid;
  if (r && r.lat && r.up && r.fwd) return { lat: r.lat.clone(), up: r.up.clone(), fwd: r.fwd.clone(), size: r.hipHeight ? r.hipHeight * 2 : 1.7 };
  return { lat: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), fwd: new THREE.Vector3(0, 0, 1), size: model.size || 1.7 };
}

const BODY = { rightHand: 'rightHand', leftHand: 'leftHand', rightFoot: 'rightFoot', leftFoot: 'leftFoot', head: 'head', chest: 'chest', hips: 'hips', spine: 'spine', neck: 'neck', rightElbow: 'rightLowerArm', leftElbow: 'leftLowerArm', rightKnee: 'rightLowerLeg', leftKnee: 'leftLowerLeg' };

// where an element comes from -> { kind: 'segment' | 'point' | 'ground', node, a, b, label }
function resolveAttach(model, spec, ctx) {
  const att = String(spec.attach || 'blade');
  const prop = ctx.prop || (model.adopt ? heldProps(model)[0] : null) || null;
  const rig = model.humanoid;
  const off = Array.isArray(spec.offset) && spec.offset.length >= 3 ? spec.offset.map(Number) : [0, 0, 0];
  const F = frameOf(model);
  const offset = new THREE.Vector3().addScaledVector(F.lat, off[0] || 0).addScaledVector(F.up, off[1] || 0).addScaledVector(F.fwd, off[2] || 0);
  const bone = (k) => (rig && rig.map[BODY[k] || k]) || (rig && k === 'chest' && (rig.map.upperChest || rig.map.spine)) || null;
  if ((att === 'blade' || att === 'tip' || att === 'grip' || att === 'muzzle') && prop) {
    const A = anchorsOfProp(prop);
    const tip = (A.muzzle || new THREE.Vector3(0, 0.5, 0)).clone(), grip = (A.grip || new THREE.Vector3()).clone();
    const melee = prop.userData.prop && prop.userData.prop.kind !== 'gun';
    if (att === 'blade') {
      // the striking part: from just past the hand to the tip (a gun: its barrel)
      // trails read best on the outer part of the blade; particles use all of it
      const base = melee ? grip.clone().lerp(tip, spec.kind === 'trail' ? 0.42 : 0.25) : tip.clone().addScaledVector(new THREE.Vector3(0, 0, 1), -0.12);
      return { kind: 'segment', node: prop, a: base, b: tip, offset, label: 'the ' + prop.name.toLowerCase() + (melee ? "'s blade" : "'s barrel") };
    }
    return { kind: 'point', node: prop, a: att === 'grip' ? grip : tip, offset, label: `the ${prop.name.toLowerCase()}'s ${att === 'grip' ? 'grip' : melee ? 'tip' : 'muzzle'}` };
  }
  if (att === 'blade' || att === 'tip' || att === 'muzzle' || att === 'grip') {
    // nothing held: the hand it would be in
    const b = bone('rightHand');
    if (b) return { kind: 'point', node: b, a: new THREE.Vector3(), offset, label: 'the right hand (nothing held)', fallback: true };
  }
  if (att === 'ground') return { kind: 'ground', node: bone('hips') || model.root, a: new THREE.Vector3(), offset, label: 'the floor under the character' };
  if (att === 'root') return { kind: 'point', node: null, a: new THREE.Vector3(), offset, label: 'the character\'s origin' };
  const b = bone(att) || (() => { let f = null; model.root.traverse((o) => { if (!f && o.name === att) f = o; }); return f; })();
  if (b) return { kind: 'point', node: b, a: new THREE.Vector3(), offset, label: b.name };
  return { kind: 'point', node: null, a: new THREE.Vector3(0, F.size * 0.5, 0), offset, label: 'the character (no "' + att + '" found)', fallback: true };
}

function floorOf(model) {
  const rig = model.humanoid;
  if (!rig) return 0;
  const up = rig.up;
  const toes = ['leftToes', 'rightToes', 'leftFoot', 'rightFoot'].map((k) => rig.map[k] && rig.rest.get(rig.map[k]).pos.dot(up)).filter((x) => Number.isFinite(x));
  return toes.length ? Math.min(...toes) - (rig.map.leftToes ? 0.02 : 0.06) * rig.hipHeight : 0;
}

// points of an attachment at the sampler's current time
function attachPoints(S, A, model, F, floor) {
  if (A.kind === 'segment') return { a: S.point(A.node, A.a).add(A.offset), b: S.point(A.node, A.b).add(A.offset) };
  const p = S.point(A.node, A.a);
  if (A.kind === 'ground') p.addScaledVector(F.up, floor - p.dot(F.up));
  return { a: p.add(A.offset) };
}

// ---------------------------------------------------------------- timing
// -> [{t0, t1}] windows (moments are windows of zero length)
function occurrences(spec, clip, ctx, S, A, model, F, floor) {
  const dur = clip.duration;
  const when = spec.when;
  const swings = ctx.swings || (clip.userData && clip.userData.swings) || [];
  const shots = ctx.shots || (clip.userData && clip.userData.shots) || [];
  const times = (Array.isArray(spec.times) ? spec.times : []).map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x <= dur + 1e-6);
  if (when === 'swings') return swings.map((s) => ({ t0: Math.max(0, s.t0 - 0.03), t1: Math.min(dur, s.t1 + 0.03), swing: s }));
  if (when === 'shots') return shots.map((t) => ({ t0: t, t1: t }));
  if (when === 'times') return times.map((t) => ({ t0: t, t1: t }));
  if (when === 'range') {
    const st = Number.isFinite(+spec.start) && +spec.start >= 0 ? +spec.start : times[0] ?? 0;
    const en = Number.isFinite(+spec.end) && +spec.end > st ? +spec.end : times[1] ?? dur;
    return [{ t0: clamp(st, 0, dur), t1: clamp(en, 0, dur) }];
  }
  if (when === 'fast') {
    // wherever the attach point moves faster than a quick strike
    const thr = (spec.threshold > 0 ? spec.threshold : 2.4) * (F.size / 1.7);
    const dt = 1 / 60, out = [];
    let prev = null, open = null;
    for (let t = 0; t <= dur + 1e-6; t += dt) {
      S.at(t);
      const p = attachPoints(S, A, model, F, floor);
      const q = p.b || p.a;
      if (prev) {
        const v = q.distanceTo(prev) / dt;
        if (v > thr && !open) open = { t0: Math.max(0, t - dt * 2) };
        else if (v <= thr * 0.8 && open) { open.t1 = Math.min(dur, t + dt); if (open.t1 - open.t0 > 0.05) out.push(open); open = null; }
      }
      prev = q.clone();
    }
    if (open) { open.t1 = dur; out.push(open); }
    // one strike, one window: join pieces that touch or nearly do
    const merged = [];
    for (const w of out) { const last = merged[merged.length - 1]; if (last && w.t0 - last.t1 < 0.1) last.t1 = Math.max(last.t1, w.t1); else merged.push({ ...w }); }
    return merged;
  }
  return [{ t0: 0, t1: dur }]; // always
}

// ---------------------------------------------------------------- nodes
function effectsRoot(model) {
  let g = model.root.children.find((c) => c.userData.fx === 'Effects');
  if (!g) {
    g = new THREE.Group();
    g.name = 'Effects';
    g.userData.fx = 'Effects';
    model.root.add(g);
    model.adopt(g);
  }
  return g;
}
function elementGroup(model, clip, spec, parent) {
  const g = new THREE.Group();
  g.name = spec.name;
  g.userData.fx = 'vfx';
  g.userData.vfxClip = clip.uuid;
  g.userData.vfxSpec = spec;
  (parent || effectsRoot(model)).add(g);
  return g;
}
function fxNode(o, clip) {
  o.userData.vfx = true;
  o.userData.vfxClip = clip.uuid;
  o.scale.setScalar(0);
  o.visible = false;
  o.renderOrder = 20;
  o.frustumCulled = false;
  return o;
}

// ---------------------------------------------------------------- trails
function bakeTrail(model, clip, spec, A, occ, S, F, floor, group, tracks) {
  const color = col(spec.color, '#9fd4ff'), core = col(spec.color2 || spec.color, '#ffffff');
  const blend = blendFor(spec, color, 'glow');
  const length = clamp(+spec.length || 0.2, 0.03, 3), fade = clamp(spec.fade >= 0 ? +spec.fade : 0.22, 0, 3);
  const width = clamp(+spec.width || 0.14 * (F.size / 1.7), 0.005, 5);
  const opacity = clamp(spec.opacity > 0 ? +spec.opacity : 1, 0.02, 1);
  const mat = makeMaterial(0xffffff, blend, null, 1, true);
  mat.name = spec.name;
  const fps = 60, hz = 240, dur = clip.duration;
  let frames = 0, area = 0;
  const pts = [];
  for (const o of occ) {
    const t0 = o.t0, t1 = Math.max(o.t1, o.t0 + 1 / fps);
    // the path, finely
    const path = [];
    for (let t = t0; t <= t1 + 1e-9; t += 1 / hz) {
      S.at(Math.min(t, dur));
      const p = attachPoints(S, A, model, F, floor);
      path.push({ t, a: p.a.clone(), b: p.b ? p.b.clone() : null });
    }
    const end = Math.min(dur, t1 + Math.max(length, fade));
    for (let tf = t0 + 1 / fps; tf <= end + 1e-9; tf += 1 / fps) {
      const head = Math.min(tf, t1), tail = Math.max(t0, tf - length);
      if (head - tail < 1 / hz) continue;
      const seg = path.filter((s) => s.t >= tail - 1e-9 && s.t <= head + 1e-9);
      if (seg.length < 2) continue;
      const after = tf > t1 ? (tf - t1) / Math.max(fade, 1e-3) : 0;
      const fadeMul = clamp(1 - after, 0, 1) * opacity;
      if (fadeMul <= 0.01) continue;
      const geo = A.kind === 'segment' ? ribbon(seg, tf, length, color, core, fadeMul) : streak(seg, tf, length, width, color, core, fadeMul, F);
      const m = fxNode(new THREE.Mesh(geo, mat), clip);
      m.name = `${spec.name} ${frames + 1}`;
      group.add(m);
      const on = Math.max(0, tf - 1 / fps), off = Math.min(dur, tf + 1e-4);
      tracks.push(new THREE.VectorKeyframeTrack(m.uuid + '.scale', [0, on, off], [0, 0, 0, 1, 1, 1, 0, 0, 0], THREE.InterpolateDiscrete));
      frames++;
      if (frames < 4000 && fadeMul > 0.5) for (const s of seg) pts.push(s.a, s.b || s.a);
      if (A.kind === 'segment') area = Math.max(area, seg.reduce((acc, s, i) => (i ? acc + s.b.distanceTo(seg[i - 1].b) * s.a.distanceTo(s.b) : 0), 0));
    }
  }
  return { frames, points: pts, area };
}

// a band swept between the blade's base and tip; u = age, v = base..tip
function ribbon(seg, tf, length, color, core, fadeMul) {
  const n = seg.length;
  const pos = new Float32Array(n * 2 * 3), cols = new Float32Array(n * 2 * 4), idx = [];
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const s = seg[i];
    const age = clamp((tf - s.t) / length, 0, 1);
    for (let j = 0; j < 2; j++) {
      const p = j ? s.b : s.a, v = j;
      pos.set([p.x, p.y, p.z], (i * 2 + j) * 3);
      // a bright rim along the tip's path, fading toward the base and the tail
      const hot = Math.pow(1 - age, 2) * smooth((v - 0.68) / 0.32);
      c.copy(color).lerp(core, hot);
      const a = fadeMul * Math.pow(1 - age, 1.6) * (0.08 + 0.92 * smooth(v / 0.9)) * smooth(Math.min(1, (1 - age) * 8));
      cols.set([c.r, c.g, c.b, a], (i * 2 + j) * 4);
    }
    if (i) { const k = i * 2; idx.push(k - 2, k - 1, k + 1, k - 2, k + 1, k); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(cols, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// a tapered tube trailing a point (hand, foot, tip)
function streak(seg, tf, length, width, color, core, fadeMul, F) {
  const n = seg.length, ring = 8;
  const pos = new Float32Array(n * ring * 3), cols = new Float32Array(n * ring * 4), idx = [];
  const c = new THREE.Color(), tan = new THREE.Vector3(), nrm = new THREE.Vector3(), bin = new THREE.Vector3(), p = new THREE.Vector3();
  for (let i = 0; i < n; i++) {
    const s = seg[i];
    const nb = seg[Math.min(n - 1, i + 1)].a, pb = seg[Math.max(0, i - 1)].a;
    tan.subVectors(nb, pb); if (tan.lengthSq() < 1e-12) tan.copy(F.fwd); tan.normalize();
    nrm.crossVectors(tan, Math.abs(tan.dot(F.up)) > 0.9 ? F.fwd : F.up).normalize();
    bin.crossVectors(tan, nrm).normalize();
    const age = clamp((tf - s.t) / length, 0, 1);
    const r = (width / 2) * Math.pow(1 - age, 0.8);
    const hot = Math.pow(1 - age, 2);
    c.copy(color).lerp(core, hot);
    const a = fadeMul * Math.pow(1 - age, 1.3);
    for (let k = 0; k < ring; k++) {
      const ang = (k / ring) * Math.PI * 2;
      p.copy(s.a).addScaledVector(nrm, Math.cos(ang) * r).addScaledVector(bin, Math.sin(ang) * r);
      pos.set([p.x, p.y, p.z], (i * ring + k) * 3);
      cols.set([c.r, c.g, c.b, a * (0.55 + 0.45 * Math.abs(Math.cos(ang)))], (i * ring + k) * 4);
    }
    if (i) for (let k = 0; k < ring; k++) { const a0 = (i - 1) * ring + k, a1 = (i - 1) * ring + ((k + 1) % ring), b0 = a0 + ring, b1 = a1 + ring; idx.push(a0, b0, a1, a1, b0, b1); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(cols, 4));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// ---------------------------------------------------------------- particles
function dirVector(name, F, motion, blade, r) {
  switch (name) {
    case 'up': return F.up.clone();
    case 'down': return F.up.clone().negate();
    case 'forward': return F.fwd.clone();
    case 'back': return F.fwd.clone().negate();
    case 'left': return F.lat.clone();
    case 'right': return F.lat.clone().negate();
    case 'along': case 'swing': return motion && motion.lengthSq() > 1e-8 ? motion.clone().normalize() : F.fwd.clone();
    case 'blade': return blade && blade.lengthSq() > 1e-8 ? blade.clone().normalize() : F.up.clone();
    default: { const v = new THREE.Vector3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1); return v.lengthSq() > 1e-6 ? v.normalize() : F.up.clone(); }
  }
}
function coneJitter(dir, spreadDeg, r) {
  const sp = THREE.MathUtils.degToRad(clamp(spreadDeg, 0, 180));
  if (sp <= 0) return dir.clone();
  const a = Math.acos(1 - r() * (1 - Math.cos(sp))), b = r() * Math.PI * 2;
  const perp = new THREE.Vector3(1, 0, 0); if (Math.abs(dir.x) > 0.9) perp.set(0, 1, 0);
  const u = perp.cross(dir).normalize(), w = new THREE.Vector3().crossVectors(dir, u);
  return dir.clone().multiplyScalar(Math.cos(a)).addScaledVector(u, Math.sin(a) * Math.cos(b)).addScaledVector(w, Math.sin(a) * Math.sin(b)).normalize();
}

function bakeParticles(model, clip, spec, A, occ, S, F, floor, group, tracks, seed) {
  const shapeName = PARTICLE_SHAPES[spec.shape] ? spec.shape : 'orb';
  const [geo, map, defBlend, orient] = PARTICLE_SHAPES[shapeName]();
  const color = col(spec.color, '#ffffff'), color2 = col(spec.color2 || spec.color, '#ffffff');
  const blend = blendFor(spec, color, defBlend);
  const count = clamp(Math.round(+spec.count || 16), 1, 400);
  const life = clamp(+spec.life || 0.8, 0.03, 8);
  const size = clamp(spec.size > 0 ? +spec.size : 0.04, 0.001, 5), sizeEnd = spec.sizeEnd >= 0 ? clamp(+spec.sizeEnd, 0, 10) : size * 0.6;
  const speed = clamp(spec.speed >= 0 ? +spec.speed : 1, 0, 80), spread = spec.spread >= 0 ? +spec.spread : 45;
  const gravity = Number.isFinite(+spec.gravity) ? +spec.gravity : 0, drag = clamp(+spec.drag || 0, 0, 20), spin = THREE.MathUtils.degToRad(+spec.spin || 0);
  const inherit = clamp(+spec.inherit || 0, 0, 2), opacity = clamp(spec.opacity > 0 ? +spec.opacity : 1, 0.02, 1);
  const dirName = spec.direction || 'out';
  const r = rnd(seed);
  const dur = clip.duration;
  // births: bursts at moments, spread through windows
  const births = [];
  for (const o of occ) {
    const len = o.t1 - o.t0;
    for (let i = 0; i < count; i++) births.push(len > 1e-3 ? o.t0 + (len * (i + r())) / count : o.t0 + r() * 0.02);
  }
  births.sort((a, b) => a - b);
  // pool: reuse a particle once its previous life is over
  const pool = [];
  const free = [];
  const lives = [];
  for (const tb of births) {
    if (tb >= dur) continue;
    const l = life * (0.7 + r() * 0.6);
    let slot = free.findIndex((x) => x <= tb);
    if (slot < 0) { if (pool.length >= 240) continue; slot = pool.length; pool.push([]); free.push(0); }
    free[slot] = tb + l + 0.02;
    pool[slot].push({ tb, l });
    lives.push({ slot, tb, l });
  }
  const pts = [];
  const g = new THREE.Vector3(), up = F.up;
  const nodes = pool.map((_, i) => {
    const m = fxNode(new THREE.Mesh(geo, makeMaterial(i % 3 === 2 && spec.color2 ? color2 : color, blend, map, opacity)), clip);
    m.name = `${spec.name} ${i + 1}`;
    m.material.name = spec.name;
    group.add(m);
    return m;
  });
  pool.forEach((list, si) => {
    const m = nodes[si];
    const PT = [], PV = [], QT = [], QV = [], ST = [0], SV = [0, 0, 0], OT = [0], OV = [0];
    for (const { tb, l } of list) {
      // where and how it starts
      S.at(tb);
      const p0 = attachPoints(S, A, model, F, floor);
      S.at(Math.min(dur, tb + 1 / 120));
      const p1 = attachPoints(S, A, model, F, floor);
      const k = r();
      const start = p0.b ? p0.a.clone().lerp(p0.b, Math.sqrt(k)) : p0.a.clone().add(new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).multiplyScalar(size * 0.6));
      const startNext = p1.b ? p1.a.clone().lerp(p1.b, Math.sqrt(k)) : p1.a.clone();
      const motion = startNext.clone().sub(start).multiplyScalar(120);
      const blade = p0.b ? p0.b.clone().sub(p0.a) : null;
      const dir = coneJitter(dirVector(dirName, F, motion, blade, r), dirName === 'out' ? 0 : spread, r);
      const v = dir.multiplyScalar(speed * (0.6 + r() * 0.8)).addScaledVector(motion, inherit);
      const axis = new THREE.Vector3(r() - 0.5, r() - 0.5, r() - 0.5).normalize();
      const wob = r() * Math.PI * 2;
      let q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(r(), r(), r()).normalize(), r() * Math.PI * 2);
      const p = start.clone();
      const step = 1 / 30;
      const t1 = Math.min(dur, tb + l);
      for (let t = tb; t <= t1 + 1e-6; t += step) {
        const age = (t - tb) / l;
        if (orient === 'velocity' && v.lengthSq() > 1e-8) q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), v.clone().normalize());
        else if (orient === 'up') q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
        if (PT.length && t <= PT[PT.length - 1]) continue;
        PT.push(t); PV.push(p.x, p.y, p.z);
        QT.push(t); QV.push(q.x, q.y, q.z, q.w);
        if (age > 0.1 && age < 0.9 && pts.length < 6000) pts.push(p.clone());
        // integrate to the next sample
        g.copy(up).multiplyScalar(-gravity * step);
        v.add(g).multiplyScalar(Math.exp(-drag * step));
        if (orient === 'tumble' && (shapeName === 'petal' || shapeName === 'leaf' || shapeName === 'snow' || shapeName === 'square')) v.addScaledVector(F.lat, Math.sin(t * 7 + wob) * 0.6 * step).addScaledVector(F.fwd, Math.cos(t * 5 + wob) * 0.4 * step);
        p.addScaledVector(v, step);
        if (gravity > 0 && p.dot(up) < floor + size * 0.3) { p.addScaledVector(up, floor + size * 0.3 - p.dot(up)); v.multiplyScalar(0.3); }
        if (orient !== 'velocity' && orient !== 'up' && spin) q = new THREE.Quaternion().setFromAxisAngle(axis, spin * step).multiply(q);
      }
      // size: pops in, eases to sizeEnd; opacity: holds, then fades
      const sOf = (x) => size + (sizeEnd - size) * x;
      const keysS = [[tb - 1e-3, 0], [tb, sOf(0) * 0.4], [tb + l * 0.12, sOf(0.12)], [tb + l * 0.6, sOf(0.6)], [t1, sOf(1)], [t1 + 1e-3, 0]];
      for (const [t, s] of keysS) { const tt = clamp(t, 0, dur); if (tt > ST[ST.length - 1] + 1e-5) { ST.push(tt); SV.push(s, s, s); } }
      const keysO = [[tb, opacity], [tb + l * (shapeName === 'smoke' ? 0.25 : 0.55), opacity], [t1, 0]];
      for (const [t, o] of keysO) { const tt = clamp(t, 0, dur); if (tt > OT[OT.length - 1] + 1e-5) { OT.push(tt); OV.push(o); } }
    }
    if (!PT.length) return;
    tracks.push(new THREE.VectorKeyframeTrack(m.uuid + '.position', PT, PV));
    tracks.push(new THREE.QuaternionKeyframeTrack(m.uuid + '.quaternion', QT, QV));
    tracks.push(new THREE.VectorKeyframeTrack(m.uuid + '.scale', ST, SV));
    tracks.push(new THREE.NumberKeyframeTrack(m.uuid + '.material.opacity', OT, OV));
  });
  return { particles: lives.length, nodes: nodes.length, points: pts };
}

// ---------------------------------------------------------------- effect meshes
function meshGeometry(shape, spec, A) {
  switch (shape) {
    case 'ring': return [new THREE.RingGeometry(0.5, 1, 64, 1).rotateX(-Math.PI / 2), TEX.ring(), 'ground'];
    case 'disc': return [new THREE.CircleGeometry(1, 48).rotateX(-Math.PI / 2), TEX.soft(), 'ground'];
    case 'circle': return [new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), TEX.circle(), 'ground'];
    case 'crescent': {
      // flat arc in the XY plane, opening toward -Y so it flies "forward" along +Y
      const g = new THREE.RingGeometry(0.75, 1, 48, 1, Math.PI * 0.15, Math.PI * 0.7);
      const p = g.attributes.position, uv = g.attributes.uv;
      for (let i = 0; i < p.count; i++) { const rr = Math.hypot(p.getX(i), p.getY(i)); uv.setXY(i, 0.5, (rr - 0.75) / 0.25); }
      return [g, TEX.band(), 'plane'];
    }
    case 'cone': return [new THREE.CylinderGeometry(0, 1, 1, 32, 1, true).translate(0, 0.5, 0), TEX.fadeUp(), 'dir'];
    case 'beam': return [new THREE.CylinderGeometry(1, 1, 1, 16, 1, true).translate(0, 0.5, 0), null, 'dir'];
    case 'pillar': return [new THREE.CylinderGeometry(1, 1, 1, 32, 1, true).translate(0, 0.5, 0), TEX.fadeUp(), 'up'];
    case 'spiral': {
      const curve = new THREE.Curve();
      curve.getPoint = (t, out = new THREE.Vector3()) => out.set(Math.cos(t * Math.PI * 6) * (1 - t * 0.3), t * 1.6 - 0.2, Math.sin(t * Math.PI * 6) * (1 - t * 0.3));
      const g = new THREE.TubeGeometry(curve, 160, 0.035, 6, false);
      return [g, null, 'up'];
    }
    case 'shell': {
      if (A.kind === 'segment') {
        const len = A.a.distanceTo(A.b);
        const g = new THREE.CapsuleGeometry(0.018, Math.max(0.01, len), 4, 12);
        // along the blade: from a to b in the prop's frame
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), A.b.clone().sub(A.a).normalize());
        g.applyQuaternion(q); g.translate(...A.a.clone().add(A.b).multiplyScalar(0.5).toArray());
        return [g, null, 'local'];
      }
      return [crossed(1, 1), TEX.soft(), 'local'];
    }
    case 'bolt': {
      const r = rnd(7), pts = [new THREE.Vector3()];
      for (let i = 1; i <= 12; i++) pts.push(new THREE.Vector3((r() - 0.5) * 0.12, i / 12, (r() - 0.5) * 0.12));
      const g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'catmullrom', 0), 48, 0.5, 5, false);
      return [g, null, 'dir'];
    }
    case 'star': return [flatShape(star(8, 0.25)), null, 'billboard'];
    default: return [crossed(1, 1), TEX.soft(), 'none']; // sphere
  }
}

function bakeMeshes(model, clip, spec, A, occ, S, F, floor, group, tracks, seed) {
  const shape = MESH_SHAPE_NAMES.includes(spec.shape) ? spec.shape : 'sphere';
  const color = col(spec.color, '#ffffff'), color2 = col(spec.color2 || spec.color, '#ffffff');
  const blend = blendFor(spec, color, 'glow');
  const dur = clip.duration;
  const follow = shape === 'shell' || spec.follow === true;
  const size = clamp(spec.size > 0 ? +spec.size : 0.4, 0.001, 50), sizeEnd = spec.sizeEnd >= 0 ? clamp(+spec.sizeEnd, 0, 100) : size;
  const travel = Number.isFinite(+spec.travel) ? +spec.travel : 0, spin = THREE.MathUtils.degToRad(+spec.spin || 0);
  const length = clamp(+spec.length || 2, 0.05, 100), opacity = clamp(spec.opacity > 0 ? +spec.opacity : 1, 0.02, 1);
  const r = rnd(seed);
  const pts = [];
  let made = 0;
  // shapes that last through a window (a glow during a swing) vs one-shots fired from it
  const lasting = ['shell', 'spiral', 'pillar', 'circle', 'disc', 'beam'].includes(shape);
  for (const o of occ) {
    const win = o.t1 > o.t0 + 1e-3;
    const one = spec.duration > 0 ? +spec.duration : 0.4;
    const tb = !win || lasting ? o.t0 : shape === 'ring' ? o.t1 : o.t0 + (o.t1 - o.t0) * 0.5;
    const life = win && lasting ? o.t1 - o.t0 + (spec.duration > 0 ? +spec.duration : 0.25) : one;
    const t1 = Math.min(dur, tb + life);
    if (tb >= dur) continue;
    const [geo, map, mode] = meshGeometry(shape, spec, A);
    // a hot core under glowing shapes
    const mat = makeMaterial(color, blend, map, opacity);
    mat.name = spec.name;
    const m = fxNode(new THREE.Mesh(geo, mat), clip);
    m.name = `${spec.name} ${made + 1}`;
    if (shape === 'sphere' || shape === 'beam' || shape === 'bolt') {
      const coreMat = makeMaterial(color2, blend, shape === 'sphere' ? TEX.soft() : null, opacity);
      const c = new THREE.Mesh(geo, coreMat);
      c.scale.set(0.45, shape === 'sphere' ? 0.45 : 1.001, 0.45);
      c.name = 'core';
      m.add(c);
    }
    // where it lives: on the attach node (follow) or in the model's space
    S.at(tb);
    const p0 = attachPoints(S, A, model, F, floor);
    S.at(Math.min(dur, tb + 1 / 60));
    const p1 = attachPoints(S, A, model, F, floor);
    const centre = p0.b ? p0.a.clone().lerp(p0.b, 0.6) : p0.a.clone();
    const motion = (p1.b || p1.a).clone().sub(p0.b || p0.a).multiplyScalar(60);
    const dirName = spec.direction || (shape === 'crescent' ? 'forward' : 'up');
    const dir = dirVector(dirName, F, motion, p0.b ? p0.b.clone().sub(p0.a) : null, r);
    let q0 = new THREE.Quaternion();
    if (mode === 'ground' || mode === 'up') q0.setFromUnitVectors(new THREE.Vector3(0, 1, 0), F.up);
    else if (mode === 'dir') q0.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    else if (mode === 'plane') {
      // the crescent lies in the swing plane, flying along `dir`
      let normal = p0.b ? p0.b.clone().sub(p0.a).cross(motion) : F.lat.clone();
      if (normal.lengthSq() < 1e-10) normal = F.lat.clone();
      normal.normalize();
      const fwdIn = dir.clone().addScaledVector(normal, -dir.dot(normal));
      if (fwdIn.lengthSq() < 1e-8) fwdIn.copy(F.fwd);
      fwdIn.normalize();
      q0.setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(fwdIn, normal), fwdIn, normal));
    } else if (mode === 'billboard') q0.setFromUnitVectors(new THREE.Vector3(0, 0, 1), F.fwd);
    let parent = group;
    let start = centre.clone();
    if (follow && A.node) {
      parent = A.node;
      start = shape === 'shell' && A.kind === 'segment' ? new THREE.Vector3() : (A.a ? A.a.clone() : new THREE.Vector3());
      if (mode !== 'local') q0 = new THREE.Quaternion();
    } else if (mode === 'ground') start.addScaledVector(F.up, 0.01);
    parent.add(m);
    if (parent !== group) { m.userData.vfxGroup = group.uuid; group.userData.vfxMembers = (group.userData.vfxMembers || []).concat(m.uuid); model.adopt?.(m); }
    // keys through its life
    const PT = [], PV = [], QT = [], QV = [], ST = [0], SV = [0, 0, 0], OT = [0], OV = [0];
    const n = Math.max(2, Math.ceil(life * 30));
    for (let i = 0; i <= n; i++) {
      const t = tb + (life * i) / n;
      if (t > dur + 1e-6) break;
      const x = i / n;
      const p = start.clone().addScaledVector(dir, travel * (t - tb));
      const q = spin ? new THREE.Quaternion().setFromAxisAngle(mode === 'dir' ? new THREE.Vector3(0, 1, 0) : mode === 'plane' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0), spin * (t - tb)) : new THREE.Quaternion();
      const qq = q0.clone().multiply(q);
      PT.push(t); PV.push(p.x, p.y, p.z); QT.push(t); QV.push(qq.x, qq.y, qq.z, qq.w);
      let s = size + (sizeEnd - size) * smooth(x);
      if (x < 0.08 && shape !== 'shell' && shape !== 'spiral') s *= 0.3 + 0.7 * (x / 0.08);
      const sv = mode === 'dir' && (shape === 'beam' || shape === 'bolt' || shape === 'cone') ? [s, length * (shape === 'cone' ? 0.5 : 1) * Math.min(1, x * 6), s] : mode === 'up' && shape === 'pillar' ? [s, length, s] : [s, s, s];
      if (i === 0) { ST.push(Math.max(0, t - 1e-3)); SV.push(0, 0, 0); }
      ST.push(t); SV.push(...sv);
      const fadeIn = shape === 'shell' || shape === 'spiral' || shape === 'circle' ? smooth(x / 0.15) : 1;
      const fadeOut = shape === 'beam' || shape === 'bolt' ? 1 - smooth((x - 0.5) / 0.5) : 1 - smooth((x - 0.55) / 0.45);
      const flicker = shape === 'bolt' ? (i % 2 ? 0.35 : 1) : 1;
      OT.push(t); OV.push(opacity * fadeIn * fadeOut * flicker);
      if (pts.length < 2000) {
        const wp = parent === group ? p : S.point(parent, p);
        pts.push(wp);
      }
    }
    ST.push(Math.min(dur, t1 + 1e-3)); SV.push(0, 0, 0);
    tracks.push(new THREE.VectorKeyframeTrack(m.uuid + '.position', PT, PV));
    tracks.push(new THREE.QuaternionKeyframeTrack(m.uuid + '.quaternion', QT, QV));
    tracks.push(new THREE.VectorKeyframeTrack(m.uuid + '.scale', ST, SV));
    tracks.push(new THREE.NumberKeyframeTrack(m.uuid + '.material.opacity', OT, OV));
    if (m.children[0]) tracks.push(new THREE.NumberKeyframeTrack(m.children[0].uuid + '.material.opacity', OT, OV.map((v) => Math.min(1, v * 1.2))));
    made++;
  }
  return { instances: made, points: pts };
}

// ---------------------------------------------------------------- bake
// Add effect elements to a clip. ctx: { prop, swings: [{t0,t1}], shots: [t] }.
// -> { report: [{ name, kind, attach, occurrences, ..., issues: [] }] }
export function bakeVFX(model, clip, specs, ctx = {}) {
  const list = (specs || []).filter(Boolean).slice(0, 16).map(resolveSpec);
  const report = [];
  if (!list.length) return { report };
  removeVFX(model, clip, { keepTracks: false });
  const S = sampler(model, clip);
  const F = frameOf(model);
  const floor = floorOf(model);
  const tracks = [];
  const used = new Set();
  try {
    list.forEach((spec, i) => {
      if (used.has(spec.name)) spec.name = `${spec.name} ${i + 1}`;
      used.add(spec.name);
      const A = resolveAttach(model, spec, ctx);
      const occ = occurrences(spec, clip, ctx, S, A, model, F, floor);
      const group = elementGroup(model, clip, spec);
      const rep = { name: spec.name, kind: spec.kind, attach: A.label, when: spec.when, occurrences: occ.map((o) => [+o.t0.toFixed(2), +o.t1.toFixed(2)]), issues: [] };
      if (A.fallback) rep.issues.push(`"${spec.attach}" isn't available, so it comes from ${A.label}`);
      if (!occ.length) rep.issues.push(spec.when === 'swings' ? 'never appears: this clip has no swings (use when "times" or "fast", or give the clip swings)' : spec.when === 'shots' ? 'never appears: this clip has no shots' : spec.when === 'fast' ? 'never appears: the attach point never moves fast in this clip' : 'never appears: no times inside the clip');
      let res = { points: [] };
      if (occ.length) {
        if (spec.kind === 'trail') res = bakeTrail(model, clip, spec, A, occ, S, F, floor, group, tracks);
        else if (spec.kind === 'particles') res = bakeParticles(model, clip, spec, A, occ, S, F, floor, group, tracks, 101 + i * 7919);
        else res = bakeMeshes(model, clip, spec, A, occ, S, F, floor, group, tracks, 31 + i * 104729);
      }
      model.adopt?.(group);
      Object.assign(rep, { frames: res.frames, particles: res.particles, instances: res.instances });
      // does it stay with the character?
      if (res.points && res.points.length) {
        const box = new THREE.Box3().setFromPoints(res.points);
        const sz = box.getSize(new THREE.Vector3());
        rep.size = [+sz.x.toFixed(2), +sz.y.toFixed(2), +sz.z.toFixed(2)];
        const lo = box.min.dot(F.up), hi = box.max.dot(F.up);
        rep.heightRange = [+(lo - floor).toFixed(2), +(hi - floor).toFixed(2)];
        // distance from the attach path
        const ap = [];
        for (const o of occ.slice(0, 6)) for (let t = o.t0; t <= o.t1 + 1e-6; t += Math.max(1 / 30, (o.t1 - o.t0) / 20)) { S.at(t); const p = attachPoints(S, A, model, F, floor); ap.push(p.a.clone()); if (p.b) ap.push(p.b.clone(), p.a.clone().lerp(p.b, 0.5)); }
        let far = 0;
        for (const p of res.points.filter((_, k) => k % 7 === 0)) far = Math.max(far, Math.min(...ap.map((a) => a.distanceTo(p))));
        rep.maxDistanceFromSource = +far.toFixed(2);
        if (far > F.size * 1.6 && spec.kind !== 'mesh') rep.issues.push(`drifts ${far.toFixed(1)} m away from ${A.label}`);
        if (hi - floor > F.size * 2.2 && !(spec.kind === 'mesh' && (spec.shape === 'pillar' || spec.shape === 'beam'))) rep.issues.push(`reaches ${(hi - floor).toFixed(1)} m above the floor (the character is ${F.size.toFixed(1)} m tall)`);
        if (lo - floor < -0.3) rep.issues.push('goes below the floor');
      } else if (occ.length) rep.issues.push('produced nothing visible');
      if (spec.blend === 'glow' && lum(col(spec.color)) < 0.12) rep.issues.push('a dark color with "glow" blending is invisible; used "ink" instead');
      report.push(rep);
    });
  } finally { S.done(); }
  for (const t of tracks) clip.tracks.push(t);
  clip.userData = { ...(clip.userData || {}), vfx: list.map((s) => ({ ...s })), version: (clip.userData?.version || 0) + 1 };
  clip.resetDuration?.();
  model._vfxCache = null;
  model.recount?.();
  return { report };
}

// every node of a clip's effects (including ones following a bone or prop)
export function vfxNodes(model, clip) {
  const out = [];
  model.root.traverse((o) => { if (o.userData.vfxClip === clip.uuid) out.push(o); });
  return out;
}

// Take a clip's effects off the model (their tracks too unless keepTracks). The nodes are
// kept on the clip so undo / re-adding the clip brings them back.
export function removeVFX(model, clip, { keepTracks = true } = {}) {
  const groups = [];
  model.root.traverse((o) => { if (o.userData.vfxClip === clip.uuid && (o.userData.fx === 'vfx' || o.userData.vfxGroup)) groups.push(o); });
  if (!groups.length) return [];
  const uuids = new Set();
  for (const g of groups) g.traverse((o) => uuids.add(o.uuid));
  const taken = groups.map((g) => [g, g.parent]);
  for (const [g, p] of taken) { p.remove(g); model.forget?.(g); }
  model._vfxCache = null;
  if (!keepTracks) {
    clip.tracks = clip.tracks.filter((t) => !uuids.has(t.name.slice(0, t.name.indexOf('.'))));
    for (const [g] of taken) g.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); [].concat(o.material).forEach((m) => m.dispose()); } });
    if (clip.userData) delete clip.userData._vfxTaken;
  } else clip.userData = { ...(clip.userData || {}), _vfxTaken: taken };
  const root = model.root.children.find((c) => c.userData.fx === 'Effects');
  if (root && !root.children.length) { model.root.remove(root); model.forget?.(root); }
  return taken;
}

export function restoreVFX(model, clip) {
  const taken = clip.userData && clip.userData._vfxTaken;
  if (!taken) return;
  for (const [g, p] of taken) {
    (p && isInside(model.root, p) ? p : effectsRoot(model)).add(g);
    model.adopt?.(g);
  }
  model._vfxCache = null;
  delete clip.userData._vfxTaken;
}
function isInside(root, o) { for (let x = o; x; x = x.parent) if (x === root) return true; return false; }

// Effects show only while their clip plays; a node at scale 0 is hidden (no wasted draws)
export function syncVFX(model, playing) {
  // the cache is dropped whenever effects are baked, removed or restored; a node that left the
  // model some other way (deleted, undone) also forces a rescan
  if (!model._vfxCache || model._vfxCacheN !== model.rest.size || model._vfxCache.some((o) => !isInside(model.root, o))) {
    model._vfxCache = [];
    model.root.traverse((o) => { if (o.userData.vfx) model._vfxCache.push(o); });
    model._vfxCacheN = model.rest.size;
  }
  for (const o of model._vfxCache) {
    if (!playing.has(o.userData.vfxClip)) { if (o.visible || o.scale.x) { o.scale.setScalar(0); o.visible = false; } continue; }
    o.visible = o.scale.x > 1e-6 && model.app?.settings?.get('showEffects') !== false;
  }
}

// ---------------------------------------------------------------- words -> effects (offline)
const VFX_WORDS = [
  ['trail', /\b(trails?|swoosh|swish|slash (effect|trail|line|arc)s?|streaks?|after ?images?|motion blur|arcs? of light|slash vfx)\b/],
  ['petals', /\b(petals?|sakura|cherry blossoms?|flower (burst|storm|petals?))\b/],
  ['sparks', /\b(sparks?|sparkles? (fly|flying)|clang)\b/],
  ['fire', /\b(fire|flames?|flaming|burning|blaze|blazing|inferno|on fire)\b/],
  ['lightning', /\b(lightning|electric|electricity|thunder|shock(ing)?|zap)\b/],
  ['ice', /\b(ice|icy|frost|frozen|freezing)\b/],
  ['magic', /\b(magic(al)?|sparkly|glitter|fairy dust|enchanted|twinkl\w*)\b/],
  ['smoke', /\b(smoke|smoky|mist|fog)\b/],
  ['dust', /\b(dust|dusty|debris)\b/],
  ['shockwave', /\b(shock ?waves?|impact|ground slam|slam|explosion|explode|blast wave)\b/],
  ['wave', /\b(energy (slash|wave)|flying slash|sword (wave|beam)|crescent|projectile slash|air slash|wind slash)\b/],
  ['glow', /\b(glow(s|ing)?|aura|radiant|shining|luminous)\b/],
  ['beam', /\b(laser|beam|ray)\b/],
  ['hearts', /\b(hearts?)\b(?! pattern)/],
  ['confetti', /\b(confetti|celebrat\w*)\b/],
  ['dark', /\b(dark|shadow|void|black flame|evil|demonic)\b/],
];
const EFFECT_COLORS = { red: '#ff3b3b', crimson: '#c8102e', orange: '#ff8a1a', yellow: '#ffe14a', gold: '#ffd24a', golden: '#ffd24a', green: '#3dff7a', blue: '#3a8bff', cyan: '#4fe3ff', purple: '#a24bff', violet: '#9a6bff', pink: '#ff6fb5', white: '#ffffff', black: '#141018', silver: '#d8e4f0' };
export function vfxWordsIn(text) {
  // "glowing blue trail": glowing describes the trail, it isn't a separate glow
  const t = String(text || '').toLowerCase().replace(/\b(glow(ing|s)?|shining|bright)\s+(\w+\s+)?(trails?|slash(es)?|streaks?|sparks?|petals?|particles?|waves?|beams?|lasers?|arcs?|swoosh)\b/g, '$4');
  return VFX_WORDS.filter(([, re]) => re.test(t)).map(([k]) => k);
}
// color named right before an effect word ("blue fire", "red trail")
function effectColor(t, words) {
  const m = new RegExp(`\\b(${Object.keys(EFFECT_COLORS).join('|')})\\s+(${words})`).exec(t);
  return m ? EFFECT_COLORS[m[1]] : null;
}

// a request in words -> effect elements. ctx: { melee, gun, dark (weapon style) }
export function vfxFromText(text, ctx = {}) {
  const t = String(text || '').toLowerCase().replace(/\b(glow(ing|s)?|shining|bright)\s+((\w+)\s+)?(trails?|slash(es)?|streaks?|sparks?|petals?|particles?|waves?|beams?|lasers?|arcs?|swoosh)\b/g, (m, a, b, c, word, eff) => `${word ? word + ' ' : ''}${eff}`);
  const w = new Set(vfxWordsIn(t));
  const has = (k) => w.has(k);
  const out = [];
  const melee = !!ctx.melee, gun = !!ctx.gun;
  const onMove = melee ? { attach: 'blade', when: 'swings' } : gun ? { attach: 'tip', when: 'shots' } : { attach: 'rightHand', when: 'fast' };
  const trailColor = effectColor(t, 'trails?|slash|swoosh|streaks?|glow|aura');
  const fireCol = effectColor(t, 'fire|flames?|blaze');
  const wantTrail = has('trail') || has('wave') || (melee && (has('fire') || has('ice') || has('lightning') || has('dark')));
  if (wantTrail) {
    const preset = has('fire') ? 'fire-slash' : has('ice') ? 'ice-slash' : has('dark') && !trailColor ? 'dark-slash' : 'slash';
    const e = { preset, name: 'Slash trail', ...onMove };
    if (!melee) Object.assign(e, { preset: 'hand-trail', name: 'Motion trail', attach: onMove.attach, when: 'fast', color: VFX_PRESETS[preset].color, color2: VFX_PRESETS[preset].color2 });
    if (trailColor) { e.color = trailColor; e.color2 = '#ffffff'; }
    else if (ctx.dark && preset === 'slash') { e.color = '#7a3cff'; e.color2 = '#efe2ff'; }
    if (/\b(long|lingering|stays)\b/.test(t)) { e.length = 0.35; e.fade = 0.5; }
    out.push(e);
  }
  if (has('petals')) out.push({ preset: 'petals', name: 'Petals', ...onMove, color: effectColor(t, 'petals?|sakura|flowers?') || (has('dark') ? '#7a1f3d' : undefined) });
  if (has('sparks')) out.push({ preset: 'sparks', name: 'Sparks', ...(melee ? { attach: 'tip', when: 'swings' } : onMove) });
  if (has('fire')) {
    out.push({ preset: 'embers', name: 'Embers', ...onMove, color: fireCol || undefined });
    if (melee || /\b(fist|hand|body)\b/.test(t)) out.push({ preset: 'flames', name: 'Flames', attach: melee ? 'blade' : 'rightHand', when: 'always', color: fireCol || undefined, count: 50 });
  }
  if (has('lightning')) out.push({ preset: 'lightning', name: 'Electric arcs', ...onMove });
  if (has('ice')) out.push({ preset: 'shards', name: 'Ice shards', ...(melee ? { attach: 'tip', when: 'swings' } : { attach: onMove.attach, when: onMove.when }), color: '#bfefff', count: 10 });
  if (has('magic')) out.push({ preset: 'magic', name: 'Magic sparkles', ...(melee ? { attach: 'blade', when: 'always', count: 30 } : { attach: 'rightHand', when: 'always' }), color: effectColor(t, 'magic|sparkles?|glitter') || undefined });
  if (has('smoke')) out.push({ preset: 'smoke', name: 'Smoke', attach: melee ? 'tip' : 'ground', when: melee ? 'swings' : 'always', count: melee ? 6 : 14, color: has('dark') ? '#1a1420' : undefined });
  if (has('dust')) out.push({ preset: 'dust', name: 'Dust', attach: 'ground', when: 'fast', count: 12 });
  if (has('shockwave')) out.push({ preset: 'shockwave', name: 'Shockwave', attach: 'ground', when: melee ? 'swings' : 'fast', color: effectColor(t, 'shock ?waves?|impact|explosion') || undefined });
  if (has('wave')) out.push({ preset: 'energy-slash', name: 'Energy slash', ...onMove, color: trailColor || (has('fire') ? '#ff6a1a' : has('dark') ? '#7a3cff' : undefined) });
  if (has('glow') && !has('beam')) out.push(melee ? { preset: 'blade-glow', name: 'Blade glow', attach: 'blade', when: 'always', color: trailColor || (has('fire') ? '#ff7a2a' : has('dark') ? '#7a3cff' : undefined) } : { preset: 'aura', name: 'Aura', attach: 'hips', when: 'always', color: trailColor || undefined });
  if (has('beam')) out.push({ preset: 'beam', name: 'Beam', attach: gun || melee ? 'tip' : 'rightHand', when: gun ? 'shots' : 'times', times: gun ? undefined : [0.6], color: effectColor(t, 'laser|beam|ray') || undefined });
  if (has('hearts')) out.push({ preset: 'hearts', name: 'Hearts', attach: 'head', when: 'always' });
  if (has('confetti')) out.push({ preset: 'confetti', name: 'Confetti', attach: 'head', when: 'times', times: [0.3] });
  for (const e of out) for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return out;
}
