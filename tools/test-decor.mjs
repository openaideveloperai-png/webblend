// Decorations and blades: swept blade geometry is closed, faces outward and has
// sane UVs; patterns land on the right materials; pattern phrases parse.
import * as THREE from 'three';
import { buildProp, presetSpec, decorateSpec, partGeometry, PROP_PRESETS } from '../src/scene/props.js';
import { findDecorationIn, patternLayers, resolveMapping } from '../src/scene/patterns.js';
let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };

for (const v of ['katana', 'double', 'knife']) {
  const g = partGeometry({ shape: 'blade', variant: v, dims: [] });
  const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
  const finite = [...n.array, ...uv.array, ...p.array].every(Number.isFinite);
  // signed volume > 0 means a closed surface facing outward
  const ix = g.index.array; let vol = 0; const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < ix.length; i += 3) { a.fromBufferAttribute(p, ix[i]); b.fromBufferAttribute(p, ix[i + 1]); c.fromBufferAttribute(p, ix[i + 2]); vol += a.dot(b.clone().cross(c)) / 6; }
  g.computeBoundingBox();
  const s = g.boundingBox.getSize(new THREE.Vector3());
  // the edge is thin: near +Z the blade is much thinner than at the spine
  let edgeX = 0, spineX = 0;
  for (let i = 0; i < p.count; i++) { if (Math.abs(p.getY(i) - s.y * 0.3) > 0.01) continue; const z = p.getZ(i), x = Math.abs(p.getX(i)); if (z > g.boundingBox.max.z - 0.003) edgeX = Math.max(edgeX, x); if (z < g.boundingBox.min.z + 0.004 + (v === 'double' ? -1 : 0)) spineX = Math.max(spineX, x); }
  ok(`${v} blade: closed, outward (${(vol * 1e6).toFixed(1)} cm³), ${s.y.toFixed(2)} m long, sharp edge`, finite && vol > 0 && s.y > 0.1 && edgeX < 0.0006, `edge half-thickness ${(edgeX * 1000).toFixed(2)} mm`);
}

// lofts and sweeps: closed and facing outward along every axis; mirrored twins too
const vol = (g) => {
  const p = g.attributes.position, ix = g.index ? g.index.array : [...Array(p.count).keys()];
  let v = 0; const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < ix.length; i += 3) { a.fromBufferAttribute(p, ix[i]); b.fromBufferAttribute(p, ix[i + 1]); c.fromBufferAttribute(p, ix[i + 2]); v += a.dot(b.clone().cross(c)) / 6; }
  return v;
};
for (const axis of ['x', 'y', 'z']) {
  const g = partGeometry({ shape: 'loft', axis, profile: [[0, 0.04, 0.02, 1], [0.05, 0.06, 0.03, 0.5, 0.005, 0], [0.1, 0.02, 0.02, 0]] });
  g.computeBoundingBox();
  const s = g.boundingBox.getSize(new THREE.Vector3());
  const along = { x: s.x, y: s.y, z: s.z }[axis];
  ok(`loft along ${axis}: closed, outward, ${(along * 100).toFixed(0)} cm long`, vol(g) > 0 && Math.abs(along - 0.1) < 1e-6 && [...g.attributes.normal.array].every(Number.isFinite), `vol ${(vol(g) * 1e6).toFixed(1)} cm³`);
}
for (const path of [[[0, 0, 0], [0, 0.1, 0.05], [0.05, 0.2, 0]], [[0, 0, 0], [0.1, 0, 0], [0.1, 0, 0.1], [0, 0, 0.1], [0, 0, 0]]]) {
  const g = partGeometry({ shape: 'sweep', profile: path, dims: [0.01, 0.006, 1] });
  ok(`sweep (${path.length} points${path.length === 5 ? ', closed loop' : ''}) faces outward`, g && vol(g) > 0, g && `vol ${(vol(g) * 1e6).toFixed(2)} cm³`);
}
{
  const prop = buildProp({ name: 'm', materials: [{ name: 'a' }], parts: [{ name: 'wing', shape: 'extrude', material: 'a', axis: 'x', dims: [0.004], pos: [0.05, 0, 0], profile: [[0, 0], [0.1, 0], [0, 0.05]], mirror: 'x' }] });
  const mesh = prop.children.find((o) => o.isMesh);
  mesh.geometry.computeBoundingBox();
  const bb = mesh.geometry.boundingBox;
  ok('mirror "x" adds the twin on the other side, both closed and outward', Math.abs(bb.min.x + bb.max.x) < 1e-6 && bb.min.x < -0.04 && vol(mesh.geometry) > 0, `x ${bb.min.x.toFixed(3)}..${bb.max.x.toFixed(3)}`);
}

// every preset still builds; with flowers they put them where they belong
const where = {};
for (const key of Object.keys(PROP_PRESETS)) {
  const spec = presetSpec(key);
  decorateSpec(spec, { pattern: 'flowers', patternColor: '#d4af37' });
  const prop = buildProp(spec);
  let meshes = 0, bad = 0;
  prop.traverse((o) => { if (o.isMesh) { meshes++; for (const k of ['position', 'normal', 'uv']) if (!o.geometry.attributes[k] || ![...o.geometry.attributes[k].array].every(Number.isFinite)) bad++; } });
  where[key] = spec.materials.filter((m) => m.pattern && /flowers/.test(m.pattern)).map((m) => m.name);
  ok(`${key} with flowers builds (${meshes} meshes) on ${where[key].join(', ')}`, meshes >= 2 && !bad && where[key].length >= 1);
}
const kat = presetSpec('katana'); decorateSpec(kat, { pattern: 'flowers', patternColor: '#d4af37' });
const blade = kat.materials.find((m) => m.name === 'blade');
ok('katana keeps its temper line under the flowers', /^hamon:[^+]+\+flowers:#d4af37$/.test(blade.pattern) && blade.mapping === 'fit' && !blade.engrave, blade.pattern);
const pis = presetSpec('pistol'); decorateSpec(pis, { pattern: 'scroll' });
ok('engraving on a pistol goes on the slide, in relief', pis.materials.find((m) => m.name === 'steel').engrave && !pis.materials.find((m) => m.name === 'polymer').pattern);
const rif = presetSpec('rifle'); decorateSpec(rif, { pattern: 'camo', patternColor: '#4a5136' });
ok('camo covers a rifle', ['alu', 'polymer'].every((n) => rif.materials.find((m) => m.name === n).pattern === 'camo:#4a5136') && resolveMapping(rif.materials[0]) !== 'fit');
const svgSpec = presetSpec('katana'); decorateSpec(svgSpec, { svg: '<svg viewBox="0 0 1000 40"><circle cx="20" cy="20" r="10"/></svg>' });
ok('a drawing goes on the blade as a band', svgSpec.materials.find((m) => m.name === 'blade').svg.includes('<svg') && svgSpec.materials.find((m) => m.name === 'blade').mapping === 'fit');
// custom model: the most used material gets it
const custom = { name: 'Thing', materials: [{ name: 'body', color: '#888' }, { name: 'lamp', color: '#fff', texture: 'glow' }], parts: [{ shape: 'box', material: 'body', dims: [0.1, 0.1, 0.1] }, { shape: 'box', material: 'body', dims: [0.1, 0.1, 0.1], pos: [0.2, 0, 0] }, { shape: 'sphere', material: 'lamp', dims: [0.02] }] };
decorateSpec(custom, { pattern: 'stars' });
ok('custom model: pattern on its main material', custom.materials[0].pattern === 'stars' && !custom.materials[1].pattern);

// phrases
const d1 = findDecorationIn('make a katana in gold flowerr pattern on the katana as a drawing on it and make it swing');
ok('"katana in gold flowerr pattern" -> gold flowers', d1 && d1.pattern === 'flowers' && d1.colorWord === 'gold', JSON.stringify(d1));
const d2 = findDecorationIn('a gold katana with a flower pattern');
ok('"a gold katana with a flower pattern" -> flowers, katana gold', d2 && d2.pattern === 'flowers' && !d2.colorWord);
ok('"flames in red", "pink camo", "engraved"', findDecorationIn('pistol with flames in red').colorWord === 'red' && findDecorationIn('pink camo rifle').pattern === 'camo' && findDecorationIn('engraved silver pistol').engrave);
ok('layers parse', JSON.stringify(patternLayers('hamon:#ffffff+flowers+bogus')) === JSON.stringify([{ name: 'hamon', color: '#ffffff' }, { name: 'flowers', color: null }]));

console.log(fails ? `${fails} FAILED` : 'ALL DECOR TESTS OK');
process.exit(fails ? 1 : 0);
