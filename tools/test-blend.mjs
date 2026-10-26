// Node test: import .blend files and compare against Blender ground truth
import fs from 'fs';
import path from 'path';
import * as THREE from 'three';
import { importBlend } from '../src/io/blend/blendimport.js';
const [,, truthFile, ...files] = process.argv;
const truth = JSON.parse(fs.readFileSync(truthFile, 'utf8'));
let fails = 0;
for (const f of files) {
  const name = path.basename(f);
  const t0 = performance.now();
  let images = 0;
  const res = await importBlend(fs.readFileSync(f), { loadImage: async ({ bytes, path: p }) => { images++; const tx = new THREE.Texture(); tx.userData.bytes = bytes?.length; tx.userData.path = p; return tx; } });
  const ms = (performance.now() - t0).toFixed(0);
  const tr = truth[name];
  console.log(`\n== ${name} (${ms}ms) info=${JSON.stringify(res.info)} warnings=${JSON.stringify(res.warnings)} images=${images}`);
  if (!tr) { console.log('  no truth'); continue; }
  // evaluate animations at their first frame, like Blender at frame 1
  if (res.animations.length) {
    const mixer = new THREE.AnimationMixer(res.scene);
    for (const c of res.animations) mixer.clipAction(c).play();
    mixer.setTime(0);
  }
  res.scene.updateMatrixWorld(true);
  for (const [oname, od] of Object.entries(tr.objects)) {
    const node = res.scene.getObjectByName(oname);
    if (!node) { console.log('  MISSING', oname); fails++; continue; }
    const wp = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld);
    const bl = [wp.x, -wp.z, wp.y];
    const dl = Math.hypot(bl[0]-od.world_loc[0], bl[1]-od.world_loc[1], bl[2]-od.world_loc[2]);
    let msg = `  ${oname.padEnd(12)} ${od.type.padEnd(8)} loc ${dl < 1e-3 ? 'ok' : 'BAD ' + bl.map(v=>v.toFixed(3)) + ' vs ' + od.world_loc}`;
    if (dl >= 1e-3) fails++;
    if (od.type === 'MESH') {
      const mesh = node.children.find(c => c.isMesh);
      if (!mesh) { msg += ' NO MESH'; fails++; }
      else {
        const tris = mesh.geometry.index.count / 3;
        msg += ` tris ${tris === od.tris ? 'ok' : 'BAD ' + tris + ' vs ' + od.tris}`;
        if (tris !== od.tris) fails++;
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        msg += ' mats ' + mats.map(m => `${m.name}#${m.color.getHexString()}${m.map ? '+map(' + (m.map.userData.bytes||m.map.userData.path) + ')' : ''}`).join(',');
        if (mesh.isSkinnedMesh) msg += ` skinned(${mesh.skeleton.bones.length} bones)`;
        if (mesh.morphTargetInfluences) msg += ` morphs=${mesh.userData.shapeKeyNames} infl=${mesh.morphTargetInfluences.map(v=>v.toFixed(2))}`;
        const bb = new THREE.Box3().setFromObject(mesh); msg += ` size=${bb.getSize(new THREE.Vector3()).toArray().map(v=>v.toFixed(2))}`;
      }
    }
    if (od.type === 'ARMATURE') {
      const bones = []; node.traverse(o => o.isBone && o.name !== '__static' && bones.push(o.name));
      msg += ` bones ${JSON.stringify(bones) === JSON.stringify(od.bones) ? 'ok' : 'BAD ' + bones + ' vs ' + od.bones}`;
    }
    console.log(msg);
  }
  for (const c of res.animations) console.log(`  clip ${c.name} dur=${c.duration.toFixed(3)} tracks=${c.tracks.length} [${c.tracks.slice(0,3).map(t=>t.name.split('.').pop() + ':' + t.times.length).join(' ')}]`);
}
console.log(fails ? `\n${fails} FAILURES` : '\nALL OK');
process.exit(fails ? 1 : 0);
