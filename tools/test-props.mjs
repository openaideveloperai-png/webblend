// Props: every preset builds; a character holds a gun with both hands, aims
// down the line of sight, and shooting adds recoil, flash, tracers and casings.
import * as THREE from 'three';
import { makeMannequin } from '../src/scene/primitives.js';
import { detectHumanoid } from '../src/anim/humanoid.js';
import { buildProp, presetSpec, PROP_PRESETS, findPresetIn } from '../src/scene/props.js';
import { attachProp, bakeHoldClip, heldProps } from '../src/anim/props-anim.js';
let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };

// every preset builds into a few merged meshes with sensible size
for (const key of Object.keys(PROP_PRESETS)) {
  const prop = buildProp(presetSpec(key));
  let meshes = 0, tris = 0;
  prop.traverse((o) => { if (o.isMesh) { meshes++; tris += o.geometry.attributes.position.count / 3; } });
  const size = new THREE.Box3().setFromObject(prop).getSize(new THREE.Vector3());
  const len = Math.max(size.x, size.y, size.z);
  const want = { pistol: [0.17, 0.24], rifle: [0.75, 1.05], smg: [0.5, 0.8], sniper: [0.95, 1.4], shotgun: [0.9, 1.3], sword: [0.85, 1.05], katana: [0.95, 1.15], knife: [0.2, 0.32], bat: [0.8, 0.95] }[key];
  ok(`${key}: ${meshes} meshes, ${Math.round(tris)} triangles, ${len.toFixed(2)} m`, meshes >= 2 && meshes <= 20 && tris > 400 && len > want[0] && len < want[1]);
}
ok('free text finds presets', findPresetIn('make her a pump shotgun') === 'shotgun' && findPresetIn('give him an AK-47') === 'rifle' && findPresetIn('a glock please') === 'pistol' && findPresetIn('make a katana') === 'katana');

function rigged() {
  const man = makeMannequin();
  man.updateMatrixWorld(true);
  const bones = []; man.traverse((o) => o.isBone && bones.push(o));
  const rig = detectHumanoid(man, bones);
  const model = { root: man, bones, humanoid: rig, adopt() {}, forget() {} };
  return { man, rig, model };
}
const wp = (o) => o.getWorldPosition(new THREE.Vector3());

for (const key of ['pistol', 'rifle', 'shotgun']) {
  const { man, rig, model } = rigged();
  const prop = buildProp(presetSpec(key));
  attachProp(model, prop, 'right');
  ok(`${key}: attached to the right hand`, prop.parent === rig.map.rightHand && heldProps(model).length === 1);
  // the grip anchor sits in the palm at rest
  man.updateMatrixWorld(true);
  const grip = prop.userData.prop.anchors.grip.clone().applyMatrix4(prop.matrixWorld);
  const palm = wp(rig.map.rightHand);
  ok(`${key}: grip in the hand`, grip.distanceTo(palm) < rig.hipHeight * 0.15, grip.distanceTo(palm).toFixed(3));
  const scale = new THREE.Vector3().setFromMatrixScale(prop.matrixWorld);
  ok(`${key}: real size kept`, Math.abs(scale.x - 1) < 1e-3, scale.x.toFixed(4));
  const { clip, shots } = bakeHoldClip(model, prop, { shots: key === 'pistol' ? 3 : 6 });
  ok(`${key}: shoot clip with ${shots.length} shots`, shots.length >= 3 && clip.tracks.length > 10, `${clip.tracks.length} tracks, ${clip.duration.toFixed(2)} s`);
  const mixer = new THREE.AnimationMixer(man);
  mixer.clipAction(clip).play();
  // aimed: muzzle in front of the chest, pointing forward, at about shoulder height
  const tAim = shots[0] - 0.02;
  mixer.setTime(tAim); man.updateMatrixWorld(true);
  const m = prop.userData.prop.anchors.muzzle.clone().applyMatrix4(prop.matrixWorld);
  const fwdW = new THREE.Vector3(0, 0, 1).transformDirection(prop.matrixWorld);
  const chest = wp(rig.map.chest || rig.map.spine);
  const sh = wp(rig.map.rightUpperArm);
  const front = m.clone().sub(chest).dot(rig.fwd);
  ok(`${key}: aimed forward`, fwdW.dot(rig.fwd) > 0.95, fwdW.dot(rig.fwd).toFixed(3));
  ok(`${key}: muzzle out in front`, front > rig.hipHeight * (key === 'pistol' ? 0.5 : 0.6), (front / rig.hipHeight).toFixed(2) + ' hip heights');
  ok(`${key}: at shoulder height`, Math.abs(m.y - sh.y) < rig.hipHeight * 0.2, ((m.y - sh.y) / rig.hipHeight).toFixed(2));
  // support hand near the support anchor
  const sup = prop.userData.prop.anchors.support.clone().applyMatrix4(prop.matrixWorld);
  // palm centre of the left hand (wrist + along the fingers + out of the palm)
  const ax = rig.handAxes.left, lw = rig.map.leftHand.getWorldQuaternion(new THREE.Quaternion());
  const lh = wp(rig.map.leftHand).addScaledVector(ax.f.clone().applyQuaternion(lw), 0.55 * ax.palmLen).addScaledVector(ax.n.clone().applyQuaternion(lw), 0.22 * ax.palmLen);
  ok(`${key}: left hand on the gun`, lh.distanceTo(sup) < rig.hipHeight * 0.06, (lh.distanceTo(sup) / rig.hipHeight).toFixed(2));
  // recoil: muzzle climbs right after a shot
  mixer.setTime(shots[0] + 0.03); man.updateMatrixWorld(true);
  const fwd2 = new THREE.Vector3(0, 0, 1).transformDirection(prop.matrixWorld);
  ok(`${key}: recoil lifts the muzzle`, fwd2.y > fwdW.y + 0.02, `${fwdW.y.toFixed(3)} -> ${fwd2.y.toFixed(3)}`);
  // effects
  const names = new Set(clip.tracks.map((t) => man.getObjectByProperty('uuid', t.name.split('.')[0])?.name || '?'));
  const mover = { pistol: 'slide', shotgun: 'pump' }[key] || 'bolt';
  ok(`${key}: flash, tracers, casings, ${mover}`, names.has('Muzzle flash') && [...names].some((n) => /^Tracer/.test(n)) && [...names].some((n) => /^Casing/.test(n)) && names.has(mover), [...names].filter((n) => !/^(mixamorig|Hips|Spine|Left|Right|Neck|Head)/.test(n)).join(', '));
  // a tracer is visible and flying right after the shot, hidden later
  const tr = man.getObjectByName('Tracer 1');
  mixer.setTime(shots[0] + 0.05); man.updateMatrixWorld(true);
  const p1 = wp(tr), vis1 = tr.scale.x;
  mixer.setTime(shots[0] + 0.15); man.updateMatrixWorld(true);
  const p2 = wp(tr);
  ok(`${key}: tracer flies forward`, vis1 > 0 && p2.clone().sub(p1).dot(rig.fwd) > 1, `${p2.clone().sub(p1).dot(rig.fwd).toFixed(2)} m`);
  // casing lands near the floor
  const cs = man.getObjectByName('Casing 1');
  mixer.setTime(Math.min(clip.duration - 0.02, shots[0] + 1.5)); man.updateMatrixWorld(true);
  ok(`${key}: casing falls to the floor`, wp(cs).y < 0.05 && wp(cs).y > -0.03 && cs.scale.x > 0, wp(cs).y.toFixed(3));
  // no NaN anywhere
  let nan = false;
  for (let t = 0; t < clip.duration; t += 0.05) { mixer.setTime(t); man.traverse((o) => { if (isNaN(o.position.x + o.quaternion.x + o.scale.x)) nan = true; }); }
  ok(`${key}: no NaN`, !nan);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL OK');
process.exit(fails ? 1 : 0);
