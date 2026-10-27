// Hands placed on body spots: palm lands on the body surface, hand turns, feet stay put.
// Usage: node tools/test-touch.mjs rig1.blend [rig2.blend ...]
import fs from 'fs';
import * as THREE from 'three';
import { importBlend } from '../src/io/blend/blendimport.js';
import { detectHumanoid, defaultParams, paramsToSpec, SPOTS } from '../src/anim/humanoid.js';
import { ConstraintSolver, hasConstraints } from '../src/anim/constraints.js';
let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };
for (const file of process.argv.slice(2)) {
  const buf = fs.readFileSync(file);
  const res = await importBlend(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), { loadImage: async () => null });
  const root = res.scene;
  root.updateMatrixWorld(true);
  const bones = []; root.traverse((o) => { if (o.isBone && o.name !== '__static') bones.push(o); });
  const solver = hasConstraints(bones) ? new ConstraintSolver(root, bones) : null;
  const driven = solver ? new Set(solver.driven.keys()) : new Set();
  const rig = detectHumanoid(root, bones, { rank: (b) => (driven.has(b) ? 0 : 2) });
  console.log(`\n${file.split('/').pop()}: humanoid=${!!rig}`);
  if (!rig) { fails++; continue; }
  const restPose = bones.map((b) => [b, b.position.clone(), b.quaternion.clone()]);
  const reset = () => { for (const [b, p, q] of restPose) { b.position.copy(p); b.quaternion.copy(q); } root.updateMatrixWorld(true); };
  const wp = (o) => o.getWorldPosition(new THREE.Vector3());
  // feet where they stand at rest, with the rig's constraints applied (what you see)
  reset();
  if (solver) { solver.solve(new Set()); root.updateMatrixWorld(true); }
  const feet0 = ['leftFoot', 'rightFoot'].map((k) => wp(rig.map[k]));
  const hh = rig.hipHeight;
  for (const spot of Object.keys(SPOTS)) {
    for (const side of spot === 'shoulder' || spot === 'heart' || spot === 'face' || spot === 'chin' ? ['right'] : ['left', 'right']) {
      reset();
      const p = defaultParams();
      p[side === 'left' ? 'lTouch' : 'rTouch'] = { spot, weight: 1 };
      p.plantFeet = true;
      rig.apply(rig.solve(paramsToSpec(p)));
      if (solver) { solver.solve(new Set()); root.updateMatrixWorld(true); }
      const hb = rig.map[side + 'Hand'];
      const ax = rig.handAxes[side];
      const hw = hb.getWorldQuaternion(new THREE.Quaternion());
      const fing = ax.f.clone().applyQuaternion(hw), palm = ax.n.clone().applyQuaternion(hw);
      // palm centre and the spot the solver aimed at
      const centre = wp(hb).addScaledVector(fing, 0.55 * ax.palmLen).addScaledVector(palm, 0.22 * ax.palmLen);
      const sp = rig.spot(spot, side);
      // the contact the solver aimed at (spots on the legs may slide up to stay in reach)
      const target = rig.lastTouch[side].contact;
      const miss = centre.distanceTo(target) / hh;
      // palm faces the body
      const facing = palm.dot(rig.lastTouch[side].palm);
      const feetMove = Math.max(...['leftFoot', 'rightFoot'].map((k, i) => wp(rig.map[k]).distanceTo(feet0[i]))) / hh;
      ok(`${side} hand on ${spot}${sp.hit ? '' : ' (no mesh hit)'}`, miss < 0.03 && facing > 0.85 && feetMove < 0.002, `miss ${(miss * 100).toFixed(1)}% hip height, palm facing ${facing.toFixed(2)}, feet moved ${(feetMove * 100).toFixed(2)}%`);
    }
  }
  // the hand turns, not only the arm (lap: palm toward the body)
  reset();
  const p = defaultParams();
  p.rTouch = { spot: 'lap', weight: 1 }; p.plantFeet = true;
  rig.apply(rig.solve(paramsToSpec(p)));
  const pl = rig.handAxes.right.n.clone().applyQuaternion(rig.map.rightHand.getWorldQuaternion(new THREE.Quaternion()));
  ok('lap: palm turned toward the body', pl.dot(rig.fwd) < -0.6, pl.dot(rig.fwd).toFixed(2));
  // hand on the thigh while standing: stays on the thigh, legs don't bend
  reset();
  const pt = defaultParams();
  pt.rTouch = { spot: 'thigh', weight: 1 }; pt.plantFeet = true;
  rig.apply(rig.solve(paramsToSpec(pt)));
  const thighRest0 = restPose.find(([b]) => b === rig.map.rightUpperLeg)[2];
  const c = rig.lastTouch.right.contact, hipJ = wp(rig.map.rightUpperLeg), kneeJ = wp(rig.map.rightLowerLeg);
  const along = c.clone().sub(hipJ).dot(kneeJ.clone().sub(hipJ).normalize()) / kneeJ.distanceTo(hipJ);
  ok('thigh: hand on the thigh, legs still', rig.map.rightUpperLeg.quaternion.angleTo(thighRest0) < 0.02 && along > -0.15 && along < 0.9, `leg turned ${rig.map.rightUpperLeg.quaternion.angleTo(thighRest0).toFixed(3)}, ${(along * 100).toFixed(0)}% down the thigh, leaned ${rig.lastLean}`);
  // legs untouched: thighs keep their rest direction
  const thighRest = restPose.find(([b]) => b === rig.map.leftUpperLeg)[2];
  ok('legs stay as they were', rig.map.leftUpperLeg.quaternion.angleTo(thighRest) < 0.02, rig.map.leftUpperLeg.quaternion.angleTo(thighRest).toFixed(3));
}
console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
