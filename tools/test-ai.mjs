import * as THREE from 'three';
import { makeMannequin, makePrimitive } from '../src/scene/primitives.js';
import { detectHumanoid } from '../src/anim/humanoid.js';
import { AIAssistant, parsePrompt } from '../src/anim/ai.js';
const man = makeMannequin(); const bones = []; man.traverse(o => o.isBone && bones.push(o));
const mk = (root, bones=[]) => ({ name: root.name, root, bones, size: 1.8, rest: new Map(), clips: [], humanoid: bones.length ? detectHumanoid(root, bones) : null, kind: 'import' });
const mModel = mk(man, bones); const cube = makePrimitive('cube'); const cModel = mk(cube); cModel.size = 1;
const app = { models: [mModel, cModel], selection: { model: mModel, object: man }, settings: { get: () => 'offline', apiKey: '' } };
const ai = new AIAssistant(app);
const prompts = ['walk', 'make him run fast for 3 seconds', 'jump then wave', 'walk and wave with the left hand', 'dance like crazy', 'nod twice', 'do a backflip', 'blah blah', 'squat 3 times slowly', 'walk forward 4 seconds', 'cheer', 'sit down'];
for (const p of prompts) {
  const r = ai.runOffline(p);
  console.log(JSON.stringify(p).padEnd(42), r.understood ? 'ok ' : '?? ', r.results.map(x => `${x.clip.name} ${x.clip.duration.toFixed(2)}s tracks=${x.clip.tracks.length}`).join(' | '));
}
app.selection = { model: cModel, object: cube };
for (const p of ['bounce', 'spin slowly on the x axis', 'float', 'flip', 'grow then pulse', 'rainbow', 'walk', 'fade out']) {
  const r = ai.runOffline(p);
  console.log(JSON.stringify(p).padEnd(42), r.understood ? 'ok ' : '?? ', r.results.map(x => `${x.clip.name} ${x.clip.duration.toFixed(2)}s tracks=${x.clip.tracks.map(t=>t.name.split('.').slice(1).join('.')).join(',')}`).join(' | '));
}
const all = ai.runOffline('make everything bounce');
console.log('all ->', all.results.map(r => r.model.name + ':' + r.clip.name));
// validate a clip evaluates without NaN
const r = ai.runOffline('jump then wave'); app.selection = { model: mModel, object: man };
const r2 = ai.runOffline('jump then wave');
const mixer = new THREE.AnimationMixer(man); mixer.clipAction(r2.results[0].clip).play();
let nan = false; for (let t = 0; t < r2.results[0].clip.duration; t += 0.1) { mixer.setTime(t); man.traverse(o => { if (o.isBone && (isNaN(o.quaternion.x) || isNaN(o.position.y))) nan = true; }); }
console.log('NaN check', nan ? 'FAIL' : 'ok');
// Claude spec build
const spec = { message: 'x', clips: [{ name: 'Custom wave', target: 'selected', duration: 2, loop: true, preset: 'walk', speed: 1, intensity: 1, humanoidKeys: [{ t: 0, values: [{ param: 'rArmRaise', value: 100 }, { param: 'rElbow', value: 60 }] }, { t: 1, values: [{ param: 'rElbow', value: 100 }] }, { t: 2, values: [{ param: 'rElbow', value: 60 }] }], objectKeys: [], boneKeys: [] }, { name: 'Cube hop', target: 'Cube', duration: 1, loop: true, preset: 'none', speed: 1, intensity: 1, humanoidKeys: [], objectKeys: [{ t: 0, channel: 'position', x: 0, y: 0, z: 0 }, { t: 0.5, channel: 'position', x: 0, y: 1, z: 0 }, { t: 1, channel: 'position', x: 0, y: 0, z: 0 }, { t: 0.5, channel: 'color', x: 1, y: 0, z: 0 }], boneKeys: [] }] };
const built = ai.buildFromSpec(spec);
console.log('spec ->', built.results.map(r => `${r.model.name}:${r.clip.name}:${r.clip.tracks.length}`), built.notes);

// hands placed on the body (offline and from Claude's handTouches)
{
  let bad = 0;
  app.selection = { model: mModel, object: man };
  const hb = mModel.humanoid.map.rightHand;
  const evalAt = (clip, t) => { const mx = new THREE.AnimationMixer(man); mx.clipAction(clip).play(); mx.setTime(t); man.updateMatrixWorld(true); const p = hb.getWorldPosition(new THREE.Vector3()); mx.stopAllAction(); mx.uncacheRoot(man); return p; };
  const legTracks = (clip) => clip.tracks.filter((t) => /Leg|Foot|Toe/.test(man.getObjectByProperty('uuid', t.name.split('.')[0])?.name || '') && t.times.length > 1 && t.values.some((v, i) => Math.abs(v - t.values[i % 4]) > 1e-4));
  for (const p of ['put hand on her lap while shes standing dont touch legs or anything', 'hands on hips', 'right hand on her head', 'cross her arms', 'hands behind her head', 'cover her eyes', 'facepalm', 'hand on her neck', 'touch her ear']) {
    const r = ai.runOffline(p);
    const clip = r.results[0].clip;
    const moved = legTracks(clip).length;
    console.log(JSON.stringify(p).padEnd(42), r.understood ? 'ok ' : '?? ', clip.name, `legs animated: ${moved}`);
    if (!r.understood || moved) bad++;
  }
  // Claude: a hand eases onto the lap and stays, feet planted
  const tspec = { message: 'x', clips: [{ name: 'Hand on lap', target: 'selected', duration: 3, loop: false, preset: 'none', speed: 1, intensity: 1, humanoidKeys: [{ t: 0, values: [{ param: 'chestPitch', value: 0 }] }, { t: 3, values: [{ param: 'chestPitch', value: 1.5 }] }], handTouches: [{ t: 0, hand: 'right', spot: 'lap', weight: 0 }, { t: 0.6, hand: 'right', spot: 'lap', weight: 1 }], plantFeet: true, objectKeys: [], boneKeys: [] }] };
  const tb = ai.buildFromSpec(tspec);
  const clip = tb.results[0] && tb.results[0].clip;
  const h0 = clip && evalAt(clip, 0), h2 = clip && evalAt(clip, 2);
  const rig = mModel.humanoid;
  const front = h2 ? h2.clone().sub(rig.posModel(rig.map.hips)).dot(rig.fwd) : 0;
  console.log('claude handTouches ->', clip ? `${clip.tracks.length} tracks, hand moved ${h0.distanceTo(h2).toFixed(2)}, in front of hips ${front.toFixed(2)}, legs animated ${legTracks(clip).length}` : 'no clip');
  if (!clip || h0.distanceTo(h2) < 0.1 || front < 0.02 || legTracks(clip).length) bad++;
  console.log(bad ? 'TOUCH FAIL' : 'TOUCH OK');
  if (bad) process.exitCode = 1;
}
