import fs from 'fs';
import * as THREE from 'three';
import { importBlend } from '../src/io/blend/blendimport.js';
import { detectHumanoid } from '../src/anim/humanoid.js';
const res = await importBlend(fs.readFileSync(process.argv[2]), {});
const bones = []; res.scene.traverse((o) => o.isBone && o.name !== '__static' && bones.push(o));
const skinned = []; res.scene.traverse((o) => o.isSkinnedMesh && skinned.push(o));
const rig = detectHumanoid(res.scene, bones);
console.log('bones', bones.length, 'skinned', skinned.length, 'humanoid', !!rig, 'clips', res.animations.map((c) => c.name + ':' + c.tracks.length), res.warnings);
const hand = res.scene.getObjectByName('hand_r');
const p0 = hand.getWorldPosition(new THREE.Vector3());
const mixer = new THREE.AnimationMixer(res.scene);
mixer.clipAction(res.animations[0]).play();
mixer.setTime(res.animations[0].duration / 2);
res.scene.updateMatrixWorld(true);
const p1 = hand.getWorldPosition(new THREE.Vector3());
console.log('right hand y at rest', p0.y.toFixed(3), 'mid-wave', p1.y.toFixed(3), p1.y > p0.y + 0.2 ? 'RAISED ok' : 'NOT RAISED');
// skinned vertex follows: compare a hand-region vertex before/after
const sm = skinned[0];
const pos = sm.geometry.attributes.position;
let idx = -1, best = 1e9;
const restHand = new THREE.Vector3(-0.75, 1.42, 0); // blender coords -> three: (x, z, -y)
for (let i = 0; i < pos.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(sm.matrixWorld); const d = v.distanceTo(new THREE.Vector3(-0.75, 1.42, 0)); if (d < best) { best = d; idx = i; } }
const vv = new THREE.Vector3(); sm.getVertexPosition(idx, vv); vv.applyMatrix4(sm.matrixWorld);
console.log('skinned hand vertex y', vv.y.toFixed(3), vv.y > 1.6 ? 'FOLLOWS ok' : 'DOES NOT FOLLOW');
