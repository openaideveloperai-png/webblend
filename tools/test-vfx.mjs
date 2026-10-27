// Effects: a slash trail follows the blade exactly, particles leave from the blade and
// fall, ground effects sit on the floor, flying slashes fly forward, "fast" finds punches.
import * as THREE from 'three';
import { makeMannequin } from '../src/scene/primitives.js';
import { detectHumanoid } from '../src/anim/humanoid.js';
import { buildProp, presetSpec } from '../src/scene/props.js';
import { attachProp, bakeHoldClip, anchorsOfProp } from '../src/anim/props-anim.js';
import { bakeVFX, vfxFromText, removeVFX, restoreVFX, resolveSpec } from '../src/anim/vfx.js';
let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };

function character() {
  const man = makeMannequin();
  man.updateMatrixWorld(true);
  const bones = []; man.traverse((o) => o.isBone && bones.push(o));
  const rig = detectHumanoid(man, bones);
  const rest = new Map();
  const model = { root: man, bones, humanoid: rig, rest, size: 1.8, adopt(n) { n.traverse((o) => rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() })); }, forget(n) { n.traverse((o) => rest.delete(o)); } };
  model.adopt(man);
  return model;
}
const at = (model, clip, t, fn) => {
  const mixer = new THREE.AnimationMixer(model.root);
  mixer.clipAction(clip).play();
  mixer.setTime(t);
  model.root.updateMatrixWorld(true);
  const r = fn();
  mixer.stopAllAction(); mixer.uncacheRoot(model.root);
  return r;
};
const findNode = (root, uuid) => { let f = null; root.traverse((o) => { if (o.uuid === uuid) f = o; }); return f; };
const visibleAt = (clip, node) => { const tr = clip.tracks.find((t) => t.name === node.uuid + '.scale'); if (!tr) return null; for (let i = 0; i < tr.times.length; i++) if (tr.values[i * 3] > 0) return [tr.times[i], tr.times[i + 1]]; return null; };

// --- slash trail on a katana
const m = character();
const katana = buildProp(presetSpec('katana'));
attachProp(m, katana, 'right');
const { clip, swings } = bakeHoldClip(m, katana, { swings: 2 });
const { report } = bakeVFX(m, clip, [{ preset: 'slash' }, { preset: 'petals' }, { preset: 'shockwave', when: 'swings' }, { preset: 'energy-slash' }]);
ok('trail baked per swing as frames', report[0].occurrences.length === swings.length && report[0].frames > 20, JSON.stringify(report[0]));
const trailGroup = m.root.getObjectByName('Effects').children.find((g) => g.name === 'slash');
const frames = trailGroup.children.filter((f) => f.isMesh);
let worst = 0, checked = 0;
const A = anchorsOfProp(katana);
for (const f of frames.filter((_, i) => i % 5 === 2)) {
  const [t0] = visibleAt(clip, f);
  const tf = t0 + 1 / 60; // the frame shows the trail up to its own time
  const pos = f.geometry.attributes.position, n = pos.count;
  const headTip = new THREE.Vector3().fromBufferAttribute(pos, n - 1);
  const swing = swings.find((s) => tf >= s.t0 - 0.05 && tf <= s.t1 + 0.05);
  if (!swing) continue; // fading after the swing: head stays at the end
  const tip = at(m, clip, Math.min(tf, swing.t1 + 0.03), () => A.muzzle.clone().applyMatrix4(katana.matrixWorld).applyMatrix4(m.root.matrixWorld.clone().invert()));
  worst = Math.max(worst, tip.distanceTo(headTip)); checked++;
}
ok('the trail\'s leading edge is on the blade tip', checked >= 3 && worst < 0.02, `${checked} frames, worst ${(worst * 100).toFixed(2)} cm`);
const alphaEnd = (() => { const f = frames[frames.length - 1]; const c = f.geometry.attributes.color; let mx = 0; for (let i = 0; i < c.count; i++) mx = Math.max(mx, c.getW(i)); return mx; })();
const alphaMid = (() => { const f = frames[Math.floor(frames.length / 4)]; const c = f.geometry.attributes.color; let mx = 0; for (let i = 0; i < c.count; i++) mx = Math.max(mx, c.getW(i)); return mx; })();
ok('the trail fades out after the swing', alphaEnd < alphaMid * 0.5, `last frame alpha ${alphaEnd.toFixed(2)} vs ${alphaMid.toFixed(2)}`);
ok('petals come off the blade and stay near the character', report[1].particles > 20 && report[1].maxDistanceFromSource < 2.5 && !report[1].issues.length, JSON.stringify({ p: report[1].particles, d: report[1].maxDistanceFromSource, i: report[1].issues }));
ok('shockwave sits on the floor', report[2].heightRange && Math.abs(report[2].heightRange[0]) < 0.06, JSON.stringify(report[2].heightRange));
const wave = report[3];
ok('energy slash flies forward from the swing', wave.instances === swings.length && wave.maxDistanceFromSource > 2, JSON.stringify(wave));
// it moves along the character's forward
{
  const g = m.root.getObjectByName('Effects').children.find((x) => x.name === 'energy-slash');
  const node = g.children[0];
  const tr = clip.tracks.find((t) => t.name === node.uuid + '.position');
  const p0 = new THREE.Vector3().fromArray(tr.values, 0), p1 = new THREE.Vector3().fromArray(tr.values, tr.values.length - 3);
  ok('…along +Z (the mannequin faces +Z)', p1.z - p0.z > 2, `${p0.z.toFixed(2)} -> ${p1.z.toFixed(2)}`);
}
// remove and restore keep tracks and nodes together
const nTracks = clip.tracks.length;
removeVFX(m, clip);
const gone = !m.root.getObjectByName('Effects');
restoreVFX(m, clip);
ok('effects come off with their clip and back on undo', gone && !!m.root.getObjectByName('Effects') && clip.tracks.length === nTracks);
// re-baking replaces, doesn't stack
bakeVFX(m, clip, [{ preset: 'slash' }]);
ok('re-baking replaces the old effects', m.root.getObjectByName('Effects').children.length === 1 && clip.userData.vfx.length === 1);

// --- a punch: "fast" finds the strike, trail follows the fist
{
  const p = character();
  const rig = p.humanoid;
  const hand = rig.map.rightHand, upper = rig.map.rightUpperArm;
  // swing the right arm quickly between 0.4 and 0.55 s
  const lower = rig.map.rightLowerArm;
  const along = lower.position.clone().normalize();
  const axis = new THREE.Vector3().crossVectors(along, Math.abs(along.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0)).normalize();
  const q0 = upper.quaternion.clone(), q1 = upper.quaternion.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, -1.4));
  const tr = new THREE.QuaternionKeyframeTrack(upper.uuid + '.quaternion', [0, 0.4, 0.55, 1.2], [...q0.toArray(), ...q0.toArray(), ...q1.toArray(), ...q1.toArray()]);
  const c = new THREE.AnimationClip('Punch', 1.2, [tr]);
  const r = bakeVFX(p, c, [{ preset: 'hand-trail' }, { preset: 'dust', when: 'fast', attach: 'rightHand' }]).report;
  ok('"fast" finds the punch', r[0].occurrences.length === 1 && r[0].occurrences[0][0] > 0.3 && r[0].occurrences[0][1] < 0.7, JSON.stringify(r[0].occurrences));
  ok('hand trail baked as a streak', r[0].frames > 5, r[0].frames);
}

// --- words -> effects
const fx = vfxFromText('make the characther swing a dark flower pattern katana and when it swings the blade makes a trail appear trail like where it cut and then disapears', { melee: true, dark: true });
ok('"…when it swings the blade makes a trail…" -> a blade trail on the swings', fx.length >= 1 && fx[0].attach === 'blade' && fx[0].when === 'swings' && /slash/.test(fx[0].preset), JSON.stringify(fx));
const fire = vfxFromText('swing a flaming sword with blue fire and sparks', { melee: true });
ok('"blue fire and sparks" -> fire trail, embers, flames in blue, sparks', fire.some((e) => e.preset === 'fire-slash') && fire.some((e) => e.preset === 'embers' && e.color === '#3a8bff') && fire.some((e) => e.preset === 'sparks'), fire.map((e) => e.preset + (e.color ? ':' + e.color : '')).join(' '));
ok('presets fill what a spec leaves unset (-1 / "")', resolveSpec({ preset: 'sparks', count: -1, color: '', speed: 5 }).count === 18 && resolveSpec({ preset: 'sparks', speed: 5 }).speed === 5);
ok('no NaN anywhere', clip.tracks.every((t) => [...t.values].every(Number.isFinite) && [...t.times].every(Number.isFinite)));

console.log(fails ? `${fails} FAILED` : 'ALL VFX TESTS OK');
process.exit(fails ? 1 : 0);
