// Advanced character settings: your own lip bones, more than one mouth, where the soft
// skin is off, and the soft-skin numbers. Built on the soft-lips test mouth (no files needed).
// Usage: node tools/test-advanced.mjs
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mouthy } from './test-softlips.mjs';
import { softLips, softLipsExtra, allSoftLips, resetLips } from '../src/anim/softlips.js';
import { softSkin, SKIN_TUNE } from '../src/anim/softskin.js';
import { lipBones, mirrorBone, childBones } from '../src/anim/select.js';
import { bonePart } from '../src/core/joints.js';

let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };

// ---- lip bones found by name; then the user's own pick
{
  const { model, lipU, lipL } = mouthy();
  const auto = lipBones(model);
  ok('lip bones found by name', auto.length === 2 && auto.includes(lipU) && auto.includes(lipL), auto.map((b) => b.name).join());
  // rename so nothing looks like a lip: no name match, so soft lips can't find them
  lipU.name = 'mouthA'; lipL.name = 'mouthB';
  model.poses = [];
  resetLips(model);
  ok('renamed lip bones and no mouth shape: no lips found', !softLips(model));
  model.lipBones = ['mouthA', 'mouthB'];
  resetLips(model);
  const s = softLips(model);
  ok('your own lip bones: soft lips find the lips there', s && s.N > 200, s ? `N ${s.N}` : 'none');
  if (s) {
    const up = [...s.side].filter((x) => x > 0).length, lo = [...s.side].filter((x) => x < 0).length;
    ok('…upper and lower lip told apart from the bones\' heights', Math.abs(up - lo) < 20 && up > 50, `${up} / ${lo}`);
  }
  ok('Tools → Select lip bones uses your pick', lipBones(model).map((b) => b.name).join() === 'mouthA,mouthB');
}

// ---- a second mouth (on the chest)
function twoMouths() {
  const t = mouthy();
  const { model } = t;
  const root = model.root;
  const chest = root.getObjectByName('Chest') || root.getObjectByName('Spine');
  root.updateMatrixWorld(true);
  const cp = new THREE.Vector3().setFromMatrixPosition(chest.matrixWorld);
  const at = [0, cp.y, 0.16];
  const inv = new THREE.Matrix4().copy(chest.matrixWorld).invert();
  const bone = (name, p) => { const b = new THREE.Bone(); b.name = name; b.position.copy(new THREE.Vector3(...p).applyMatrix4(inv)); chest.add(b); return b; };
  const u = bone('m2.top', [at[0], at[1] + 0.003, at[2]]), l = bone('m2.bottom', [at[0], at[1] - 0.003, at[2]]);
  root.updateMatrixWorld(true);
  const geos = [[[0.05, 0.006, 0.01, 24, 3, 4], [at[0], at[1] + 0.003, at[2]], 0], [[0.05, 0.006, 0.01, 24, 3, 4], [at[0], at[1] - 0.003, at[2]], 1]].map(([sz, c, bi]) => {
    const g = new THREE.BoxGeometry(...sz); g.translate(...c);
    const n = g.attributes.position.count;
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, i) => (i % 4 ? 0 : bi)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 4));
    return g;
  });
  const m2 = new THREE.SkinnedMesh(mergeGeometries(geos), new THREE.MeshStandardMaterial());
  m2.name = 'Mouth2';
  root.add(m2); root.updateMatrixWorld(true);
  m2.bind(new THREE.Skeleton([u, l]), m2.matrixWorld);
  model.skinned.push(m2);
  model.bones.push(u, l);
  let n = 0; root.traverse(() => n++); model.nodeCount = n;
  return { ...t, u, l, m2 };
}
{
  const { model } = twoMouths();
  ok('no extra mouths until you add one', softLipsExtra(model).length === 0);
  model.extraMouths = [{ name: 'Chest mouth', bones: ['m2.top', 'm2.bottom'] }];
  resetLips(model);
  const x = softLipsExtra(model);
  ok('a second mouth from its bones gets its own soft lips', x.length === 1 && x[0].N > 200, x[0] ? `N ${x[0].N}` : 'none');
  if (x[0]) {
    ok('…on its own offset layer', x[0].layerName === 'lips1' && softLips(model).layerName === 'lips');
    const up = [...x[0].side].filter((v) => v > 0).length, lo = [...x[0].side].filter((v) => v < 0).length;
    ok('…with its upper and lower lip', Math.abs(up - lo) < 20 && up > 50, `${up} / ${lo}`);
    ok('…and it runs (nothing pushed at rest)', !x[0].update({ write: false }).active);
  }
  ok('both mouths listed', allSoftLips(model).length === 2);
  const sk = softSkin(model);
  ok('soft skin leaves the second mouth to its soft lips', sk && sk.mouthZones && sk.mouthZones.length === 1, sk ? `${sk.mouthZones.length} zone(s)` : 'no skin');
}

// ---- soft-skin numbers and where it's off
{
  const { model } = mouthy();
  const sk = softSkin(model);
  ok('soft skin built', !!sk);
  if (sk) {
    const w0 = Float32Array.from(sk.widthMul), d0 = Float32Array.from(sk.maxDepth);
    model.skinTune = { crater: 2, depth: 0.5 };
    sk.applyOverrides();
    const wr = sk.widthMul.reduce((a, v, i) => a + v / w0[i], 0) / sk.N;
    let dr = 0, n = 0; for (let i = 0; i < sk.N; i++) if (d0[i] > 1e-6) { dr += sk.maxDepth[i] / d0[i]; n++; }
    ok('crater width × and depth × apply everywhere', Math.abs(wr - 2) < 1e-4 && Math.abs(dr / n - 0.5) < 1e-4, `${wr.toFixed(3)} / ${(dr / n).toFixed(3)}`);
    model.skinTune = {};
    // no soft skin on the arms
    const arm = model.humanoid.map.leftUpperArm;
    model.indent = { [arm.uuid]: { rigid: true } };
    sk.applyOverrides();
    let armV = 0, armDeep = 0;
    // (a bone's setting covers its helper bones, not the next body part: the forearm has its own)
    const canon = model.humanoid.canonOf;
    for (let w = 0; w < sk.N; w++) { let p = sk.dBones[sk.dbone[w]]; while (p && !canon.has(p)) p = p.parent; if (p === arm) { armV++; armDeep = Math.max(armDeep, sk.maxDepth[w]); } }
    ok('no soft skin where you switch it off (rigid: no depth)', armV > 0 && armDeep === 0, `${armV} vertices, deepest ${armDeep}`);
    model.indent = {};
    ok('defaults are what they were', SKIN_TUNE.settleOut === 0.16 && SKIN_TUNE.settleIn === 0.03 && Math.abs(SKIN_TUNE.maxTurn - 0.45) < 1e-9);
    // anatomy off: rebuilt with even flesh
    model.skinTune = { anatomy: false };
    sk.clear(); model._skin = undefined;
    const flat = softSkin(model);
    ok('anatomy off rebuilds the soft skin', !!flat && flat !== sk);
  }
}

// ---- bone groups
{
  const { model } = mouthy();
  const rig = model.humanoid;
  ok('the other side of a bone (left ↔ right)', mirrorBone(model, rig.map.leftHand) === rig.map.rightHand && mirrorBone(model, rig.map.rightUpperLeg) === rig.map.leftUpperLeg);
  ok('a bone and everything under it', childBones(rig.map.leftHand).length >= 5);
  ok('body part of a bone (for colors and Tools → Body part)', bonePart(rig.map.leftHand, rig.canonOf) === 'hands' && bonePart(rig.map.head, rig.canonOf) === 'head' && bonePart(model.root.getObjectByName('tongue'), rig.canonOf) === 'face');
}

console.log(fails ? `${fails} failed` : 'all advanced tests passed');
process.exit(fails ? 1 : 0);
