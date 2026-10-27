// MMD-style rig from a .blend: constraint-driven D bones + leg IK vs Blender's result.
// Usage: node tools/test-mmd.mjs goatchan.blend goat_truth.json
import fs from 'fs';
import * as THREE from 'three';
import { importBlend } from '../src/io/blend/blendimport.js';
import { ConstraintSolver } from '../src/anim/constraints.js';
import { detectHumanoid } from '../src/anim/humanoid.js';
const [,, file, truthFile] = process.argv;
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
const buf = fs.readFileSync(file);
const res = await importBlend(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), { loadImage: async () => null });
let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };
const root = res.scene;
const bones = [];
root.traverse((o) => { if (o.isBone) bones.push(o); });
const solver = new ConstraintSolver(root, bones);
ok('constraints resolved', solver.count >= 10 && solver.unresolved === 0, `count=${solver.count} unresolved=${solver.unresolved}`);
ok('D bones are driven by control bones', [...solver.driven.keys()].some((b) => b.name === '左足D'));
const byName = new Map(bones.map((b) => [b.name, b]));
const clip = res.animations[0];
const mixer = new THREE.AnimationMixer(root);
mixer.clipAction(clip).play();
const animated = new Set(clip.tracks.map((t) => t.name.split('.')[0]));
const fps = res.info.fps || 24;
const check = (frame, key) => {
  mixer.setTime((frame - 1) / fps);
  root.updateMatrixWorld(true);
  solver.solve(animated);
  root.updateMatrixWorld(true);
  for (const [name, p] of Object.entries(truth[key])) {
    const b = byName.get(name);
    const w = new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
    const exp = new THREE.Vector3(p[0], p[2], -p[1]); // Blender Z-up -> Y-up
    const d = w.distanceTo(exp);
    ok(`frame ${frame} ${name}`, d < 0.02, `off by ${(d * 100).toFixed(1)} cm`);
  }
};
check(1, 'frame1');
check(15, 'frame15');
// humanoid detection with MMD names, preferring control bones when constraints drive
const driven = new Set(solver.driven.keys());
const h = detectHumanoid(root, bones, { rank: (b) => (driven.has(b) ? 0 : 2) });
ok('MMD rig detected as humanoid', !!h);
if (h) {
  const m = Object.fromEntries(Object.entries(h.map).map(([k, b]) => [k, b.name]));
  console.log('   ', JSON.stringify(m));
  ok('hips = 腰, legs = control bones', m.hips === '腰' && m.leftUpperLeg === '左足' && m.leftLowerLeg === '左ひざ' && m.leftFoot === '左足首');
  ok('arms + spine + head', m.leftUpperArm === '左腕' && m.leftLowerArm === '左ひじ' && m.leftHand === '左手首' && m.spine === '上半身' && m.head === '頭' && m.neck === '首');
}
// exported files have no constraints: D bones carry the weights there
const h2 = detectHumanoid(root, bones, { rank: (b) => (/D$|EX$/.test(b.name) || !/足|ひざ/.test(b.name) ? 2 : 1) });
ok('without constraints: legs map to the D bones', h2 && h2.map.leftUpperLeg.name === '左足D' && h2.map.leftLowerLeg.name === '左ひざD');
console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
