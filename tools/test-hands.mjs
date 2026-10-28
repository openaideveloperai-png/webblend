// Fingers, fingertip touches, face controls, file poses, the bone scan and the
// motion self-check, on the demo mannequin (no files needed).
// Usage: node tools/test-hands.mjs
import * as THREE from 'three';
import { makeMannequin } from '../src/scene/primitives.js';
import { detectHumanoid, defaultParams, paramsToSpec } from '../src/anim/humanoid.js';
import { faceControls, faceTracks, isPoseClip, poseFromClip, blendPoses, faceKeysFor } from '../src/anim/face.js';
import { scanRig, describeRig } from '../src/anim/rigscan.js';
import { boneKeyPlan, boneKeyTracks } from '../src/anim/bonekeys.js';
import { checkMotion } from '../src/anim/motioncheck.js';
import { parseTouches, parseHandShapes, parseFaceWords } from '../src/anim/ai.js';

let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };
const f3 = (v) => v.toArray().map((x) => x.toFixed(3)).join(',');

const root = makeMannequin();
const bones = []; root.traverse((o) => { if (o.isBone) bones.push(o); });
const body = root.getObjectByName('Body');
// face shape keys on the head and one on the belly
{
  const g = body.geometry, pos = g.attributes.position, si = g.attributes.skinIndex;
  const head = bones.indexOf(root.getObjectByName('Head')), hips = bones.indexOf(root.getObjectByName('Hips'));
  const mk = (onBone, dy) => { const a = new Float32Array(pos.count * 3); for (let i = 0; i < pos.count; i++) if (si.getX(i) === onBone) a[i * 3 + 1] = dy; return new THREE.Float32BufferAttribute(a, 3); };
  g.morphAttributes.position = [mk(head, -0.004), mk(head, -0.01), mk(hips, 0.01)];
  g.morphTargetsRelative = true;
  body.updateMorphTargets();
  body.morphTargetDictionary = { 'まばたき': 0, 'あ': 1, belly_in: 2 };
  body.morphTargetInfluences = [0, 0, 0];
}
const rig = detectHumanoid(root, bones);
const rest = new Map(); root.traverse((o) => rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
let nodeCount = 0; root.traverse(() => nodeCount++);
const model = { root, humanoid: rig, rest, bones, skinned: [body], morphMeshes: [body], nodeCount, poses: [], size: 1.8, constraints: null, drivenBones: new Set() };
const wp = (n) => { const b = root.getObjectByName(n); b.updateMatrixWorld(true); return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld); };
const solve = (p) => rig.apply(rig.solve(paramsToSpec(p)));

// ---- hand rig
const H = rig.handRig('left');
ok('five finger chains per hand', H && Object.keys(H.chains).length === 5 && Object.keys(rig.handRig('right').chains).length === 5);
ok('thumb: base, middle and tip joints; tip markers left out', H.chains.thumb.bones.map((e) => e.role).join() === 'meta,prox,dist' && H.chains.index.bones.length === 3 && !H.chains.index.bones.some((e) => /4$/.test(e.bone.name)));
// ---- curls (in the hand's own frame: along the fingers, and toward the palm)
const ax = rig.handAxes.left;
const local = (n) => { const h = root.getObjectByName('LeftHand'); h.updateMatrixWorld(true); return wp(n).applyMatrix4(h.matrixWorld.clone().invert()); };
const base = { ...defaultParams(), lArmRaise: 90 };
solve(base);
const restAlong = local('LeftHandMiddle4').dot(ax.f);
solve({ ...base, lThumb: 1, lIndex: 1, lMiddle: 1, lRing: 1, lPinky: 1 });
const fistAlong = local('LeftHandMiddle4').dot(ax.f), fistPalm = local('LeftHandMiddle4').dot(ax.n), thumbPalm = local('LeftHandThumb4').dot(ax.n);
ok('fist: the fingertips fold back under the palm', fistAlong < restAlong * 0.5 && fistPalm > 0.005 && thumbPalm > 0.03, `middle tip along ${restAlong.toFixed(3)} -> ${fistAlong.toFixed(3)}, toward palm ${fistPalm.toFixed(3)}, thumb ${thumbPalm.toFixed(3)}`);
solve({ ...base, lThumb: 0.6, lIndex: 0, lMiddle: 1, lRing: 1, lPinky: 1 });
ok('point: index straight, the others curled', local('LeftHandIndex4').dot(ax.f) > restAlong * 0.85 && local('LeftHandMiddle4').dot(ax.f) < restAlong * 0.5);
const lat = (n) => local(n).dot(new THREE.Vector3().crossVectors(ax.n, ax.f));
solve(base); const gap0 = lat('LeftHandIndex4') - lat('LeftHandPinky4');
solve({ ...base, lSpread: 20 }); const gap1 = lat('LeftHandIndex4') - lat('LeftHandPinky4');
ok('spread opens the hand', gap1 > gap0 + 0.02, `${gap0.toFixed(3)} -> ${gap1.toFixed(3)}`);

// ---- fingertip touches
const sp = rig.spot('mouth', 'right');
const hr = rig.rest.get(rig.map.head);
const mouth = sp.local.clone().applyQuaternion(hr.Wq).add(hr.pos);
ok('mouth found on the face surface', sp.hit && mouth.y > wp('Head').y && mouth.z > 0.08, f3(mouth));
solve({ ...defaultParams(), rTouch: { spot: 'mouth', weight: 1, finger: 'index', mode: 'tip', depth: 0 } });
const dir = wp('RightHandIndex4').sub(wp('RightHandIndex1')).normalize();
ok('index fingertip on the lips', wp('RightHandIndex4').distanceTo(mouth) < 0.01, `${(wp('RightHandIndex4').distanceTo(mouth) * 100).toFixed(2)} cm`);
ok('...pointing into the mouth, the other fingers curled', dir.z < -0.8 && wp('RightHandMiddle4').distanceTo(wp('RightHandMiddle1')) < 0.05, f3(dir));
solve({ ...defaultParams(), rTouch: { spot: 'mouth', weight: 1, finger: 'index', mode: 'pad', depth: 0 } });
const dirPad = wp('RightHandIndex4').sub(wp('RightHandIndex1')).normalize();
ok('"shh": the finger lies up across the lips', dirPad.y > 0.9 && wp('RightHandIndex2').lerp(wp('RightHandIndex3'), 0.5).distanceTo(mouth) < 0.03, f3(dirPad));
solve({ ...defaultParams(), rTouch: { spot: 'mouth', weight: 1, finger: 'index', mode: 'tip', depth: 0.4 } });
const inside = (mouth.z - wp('RightHandIndex4').z) * 100;
ok('depth pushes the fingertip past the lips', inside > 1.8 && inside < 4.5, `${inside.toFixed(2)} cm`);
const elbowMoved = wp('RightForeArm').distanceTo(new THREE.Vector3(-0.45, 1.42, 0));
ok('the whole arm moves (not just the wrist)', elbowMoved > 0.2, `elbow moved ${elbowMoved.toFixed(2)} m`);

// ---- baking: rest rotations a hair off unit length must not become tracks
{
  const helper = root.getObjectByName('HeadTop_End');
  const q = helper.quaternion; q.set(q.x, q.y, q.z, 1.0000004);
  const rig2 = detectHumanoid(root, bones);
  const clip = rig2.bake('t', 1, () => paramsToSpec({ ...defaultParams(), rElbow: 40 }), 10);
  ok('no tracks on untouched bones from float noise (they switch rig IK on)', !clip.tracks.some((t) => t.name.startsWith(helper.uuid)), clip.tracks.length + ' tracks');
  q.set(0, 0, 0, 1);
}

// ---- face controls, file poses
const controls = faceControls(model);
const g = (n) => (controls.find((c) => c.name === n) || {}).group;
ok('shape keys sorted by where they move the mesh', g('まばたき') === 'eyes' && g('あ') === 'mouth' && g('belly_in') === 'body', JSON.stringify(controls.map((c) => [c.name, c.group, c.label])));
const ft = faceTracks(model, [{ t: 0, control: 'まばたき', value: 0 }, { t: 0.5, control: 'blink', value: 1 }, { t: 1, control: 'nope', value: 1 }], 1);
ok('faceKeys -> shape-key tracks (by name or English label), unknown names reported', ft.tracks.length === 1 && /morphTargetInfluences\[0\]/.test(ft.tracks[0].name) && ft.unknown.join() === 'nope');
const headB = root.getObjectByName('Head');
const poseClip = new THREE.AnimationClip('mouth_o', 0, [new THREE.QuaternionKeyframeTrack(headB.uuid + '.quaternion', [0], new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.4).toArray()), new THREE.VectorKeyframeTrack(rig.map.neck.uuid + '.position', [0], rest.get(rig.map.neck).p.toArray())]);
const stillClip = new THREE.AnimationClip('rest', 0, [new THREE.QuaternionKeyframeTrack(headB.uuid + '.quaternion', [0], [0, 0, 0, 1])]);
ok('single-frame actions are poses', isPoseClip(poseClip) && !isPoseClip(new THREE.AnimationClip('x', 1, [new THREE.NumberKeyframeTrack('a.b', [0, 1], [0, 1])])));
const pose = poseFromClip(model, poseClip);
ok('a pose keeps only what moves; a rest-pose copy is empty', pose.deltas.length === 1 && poseFromClip(model, stillClip).empty, `${pose.deltas.length} deltas`);
model.poses = [pose]; model._faceControls = null;
const half = blendPoses(model, [{ pose, w: 0.5 }]).get(headB);
ok('poses blend by weight', half && Math.abs(2 * Math.acos(Math.min(1, Math.abs(half.q.w))) - 0.2) < 1e-3);
const pt = faceTracks(model, [{ t: 0, control: 'mouth_o', value: 0 }, { t: 1, control: 'mouth_o', value: 1 }], 1);
ok('faceKeys on a file pose -> bone tracks', pt.tracks.some((t) => t.name === headB.uuid + '.quaternion'));
const fk = faceKeysFor(model, [{ kind: 'blink' }, { kind: 'open' }, { kind: 'smile' }], 6);
ok('words -> face keys: blink and open found, smile reported missing', fk.keys.some((k) => k.control === 'まばたき') && fk.keys.some((k) => k.control === 'あ') && fk.missing.join() === 'smile', JSON.stringify(fk.missing));

// ---- the bone scan
const scan = scanRig(model);
ok('scan: finger bones are fingers, arms are body', scan.info.get(root.getObjectByName('LeftHandIndex2')).role === 'finger' && scan.info.get(rig.map.leftUpperArm).role === 'body');
ok('scan: tip markers move nothing', scan.unused.some((b) => /Index4$/.test(b.name)));
ok('scan description', /finger bones/.test(describeRig(model)));

// ---- bone keys in the character's axes
{
  const plan = boneKeyPlan(model, [{ t: 0, bone: 'Head', x: 0, y: 0, z: 0 }, { t: 1, bone: 'Head (head)', x: 30, y: 0, z: 0 }, { t: 1, bone: 'Nope' }]);
  const tracks = boneKeyTracks(model, plan, 1, 30, rig);
  const tr = tracks.find((t) => t.name === headB.uuid + '.quaternion');
  const q = new THREE.Quaternion().fromArray(tr.values, tr.values.length - 4);
  const top = new THREE.Vector3(0, 0.2, 0).applyQuaternion(q);
  ok('bone keys: x+ nods the head forward; unknown bones reported', top.z > 0.08 && plan.unknown.join() === 'Nope', f3(top));
}

// ---- the self-check
{
  const T = (t) => ({ t, hand: 'right', spot: 'mouth', weight: 1, finger: 'index', mode: 'tip', depth: 0.3 });
  const good = rig.bake('good', 3, (t) => paramsToSpec({ ...defaultParams(), rTouch: { ...T(0), weight: Math.min(1, t / 1) } }), 30);
  good.userData = { plan: { touches: [T(1.2), T(3), T(2)] } };
  const c1 = checkMotion(model, good, { prompt: 'finger in her mouth' });
  ok('check: a fingertip that reaches is "touching", held poses measured right', !c1.issues.length && (c1.text.match(/touching/g) || []).length === 3, c1.text.split('\n')[0]);
  const wrist = rig.bake('wrist', 2, (t) => paramsToSpec({ ...defaultParams(), rHandPitch: 40 * t }), 30);
  wrist.userData = { plan: { touches: [] } };
  const c2 = checkMotion(model, wrist, { prompt: 'put her finger in her mouth' });
  ok('check: only the wrist moving is flagged', c2.issues.some((i) => /neither hand goes anywhere/.test(i)), c2.issues.join(' | '));
  const far = rig.bake('far', 2, () => paramsToSpec(defaultParams()), 30);
  far.userData = { plan: { touches: [T(1)] } };
  ok('check: a touch that misses is flagged with the distance', checkMotion(model, far, {}).issues.some((i) => /cm from the mouth/.test(i)));
}

// ---- words
{
  const t1 = parseTouches('put a finger in her mouth').touch, t2 = parseTouches('shh').touch, t3 = parseTouches('poke her cheek with the left finger').touch;
  ok('words: finger in the mouth / shh / poke a cheek', t1.right.finger === 'index' && t1.right.depth > 0.2 && t2.right.mode === 'pad' && t3.left && t3.left.spot === 'cheek');
  const hs = parseHandShapes('give a thumbs up and make a fist with the left hand');
  ok('words: hand shapes', hs.right && hs.right.thumb === 0 && hs.left && hs.left.index === 1, JSON.stringify(hs));
  ok('words: face', parseFaceWords('smile, blink and open her mouth').join() === 'smile,blink,open');
}
console.log(fails ? `\n${fails} FAILED` : '\nALL HAND TESTS OK');
process.exit(fails ? 1 : 0);
