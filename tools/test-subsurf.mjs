import fs from 'fs';
import * as THREE from 'three';
import { importBlend } from '../src/io/blend/blendimport.js';
const [,, file, truthFile] = process.argv;
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
const t0 = performance.now();
const res = await importBlend(fs.readFileSync(file), {});
console.log('import ms', (performance.now() - t0).toFixed(0), res.warnings);
let fails = 0;
for (const [name, tr] of Object.entries(truth)) {
  const node = res.scene.getObjectByName(name);
  const mesh = node && node.children.find((c) => c.isMesh);
  if (!mesh) { console.log('MISSING', name); fails++; continue; }
  const tris = mesh.geometry.index.count / 3;
  mesh.geometry.computeBoundingBox();
  const sz = mesh.geometry.boundingBox.getSize(new THREE.Vector3()).toArray().map((v) => +v.toFixed(3));
  const sizeOk = sz.every((v, i) => Math.abs(v - tr.size[i]) < 0.03 * Math.max(1, tr.size[i]));
  console.log(name.padEnd(10), 'tris', tris, 'vs', tr.tris, tris === tr.tris ? 'ok' : 'BAD', '| size', sz.join(','), 'vs', tr.size.join(','), sizeOk ? 'ok' : 'BAD', mesh.morphTargetInfluences ? 'morphs=' + mesh.geometry.morphAttributes.position.length : '');
  if (tris !== tr.tris || !sizeOk) fails++;
}
console.log(fails ? fails + ' FAILURES' : 'SUBSURF OK');
