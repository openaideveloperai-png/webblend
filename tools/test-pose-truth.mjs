// Compare WebBlend's rig (raw import and constraint solving) with Blender's
// evaluated pose dumped by tools/blender/pose_truth.py.
// Usage: node tools/test-pose-truth.mjs rig.blend truth.json [toleranceCm=1]
import fs from 'fs';
import * as THREE from 'three';
import { importBlend } from '../src/io/blend/blendimport.js';
import { ConstraintSolver, hasConstraints } from '../src/anim/constraints.js';
const [file, truthFile, tolArg] = process.argv.slice(2);
const tol = (parseFloat(tolArg) || 1) / 100;
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
const buf = fs.readFileSync(file);
const res = await importBlend(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), { loadImage: async () => null });
const root = res.scene;
root.updateMatrixWorld(true);
const zup = root.getObjectByName('Z-up') || root;
const bones = [];
root.traverse((o) => { if (o.isBone && o.name !== '__static') bones.push(o); });
const ref = {};
for (const a of Object.values(truth.arms)) for (const k of ['bones', 'raw']) for (const [n, p] of Object.entries(a[k])) (ref[k] || (ref[k] = {}))[n] = p;
let fails = 0;
const cmp = (label, table) => {
  root.updateMatrixWorld(true);
  const errs = [];
  for (const b of bones) {
    let t = table[b.name];
    if (!t) continue;
    if (Array.isArray(t[0])) t = t[0]; // [head, tail]
    const p = zup.worldToLocal(b.getWorldPosition(new THREE.Vector3()));
    errs.push([b.name, Math.hypot(p.x - t[0], p.y - t[1], p.z - t[2])]);
  }
  errs.sort((a, b) => b[1] - a[1]);
  const worst = errs.length ? errs[0][1] : 0;
  const ok = errs.length > 0 && worst < tol;
  if (!ok) fails++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${errs.length} bones, worst ${errs.slice(0, 5).map(([n, e]) => `${n} ${(e * 100).toFixed(2)}cm`).join(', ')}`);
};
cmp('raw import (constraints muted)', ref.raw || {});
if (hasConstraints(bones)) {
  const solver = new ConstraintSolver(root, bones);
  solver.solve(new Set());
  cmp(`constraints solved (${solver.count} constraints)`, ref.bones || {});
}
console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
