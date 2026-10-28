// Soft skin: body parts pressing on each other dent and bulge like flesh instead of
// clipping, as far as the flesh over the bone allows. A smooth body on the demo
// mannequin's skeleton (no files needed). Also: face spots (cheek...) measured on the mesh.
// Usage: node tools/test-softskin.mjs
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeMannequin } from '../src/scene/primitives.js';
import { detectHumanoid, defaultParams, paramsToSpec } from '../src/anim/humanoid.js';
import { softSkin, updateSoftSkin, skinContacts } from '../src/anim/softskin.js';
import { faceLandmarks } from '../src/anim/landmarks.js';
import { mouthy } from './test-softlips.mjs';

let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };

// the mannequin's skeleton with smooth parts: an oval torso, round limbs, a head
function fleshy() {
  const root = makeMannequin('Fleshy');
  const old = root.getObjectByName('Body');
  const bi = new Map(old.skeleton.bones.map((b, i) => [b.name, i]));
  root.updateMatrixWorld(true);
  const W = (n) => new THREE.Vector3().setFromMatrixPosition(root.getObjectByName(n).matrixWorld);
  const parts = [];
  const limb = (a, b, r, bone, seg = 20, rad = 24) => {
    const A = W(a), B = W(b), len = A.distanceTo(B);
    const g = new THREE.CapsuleGeometry(r, len, 6, rad, seg);
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), B.clone().sub(A).normalize()));
    g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2);
    parts.push([g, bone]);
  };
  const t = new THREE.CapsuleGeometry(0.11, 0.36, 8, 40, 28); t.scale(1.35, 1, 0.85); t.translate(0, 1.15, 0); parts.push([t, 'Spine1']);
  const hd = new THREE.SphereGeometry(0.1, 40, 30); hd.scale(0.95, 1.12, 1); hd.translate(0, 1.66, 0.015); parts.push([hd, 'Head']);
  for (const S of ['Left', 'Right']) {
    limb(S + 'Arm', S + 'ForeArm', 0.048, S + 'Arm');
    limb(S + 'ForeArm', S + 'Hand', 0.04, S + 'ForeArm');
    for (const f of ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky']) for (let i = 1; i <= 3; i++) limb(`${S}Hand${f}${i}`, `${S}Hand${f}${i + 1}`, f === 'Thumb' ? 0.0105 : 0.009, `${S}Hand${f}${i}`, 3, 8);
    limb(S + 'UpLeg', S + 'Leg', 0.07, S + 'UpLeg');
    limb(S + 'Leg', S + 'Foot', 0.052, S + 'Leg');
  }
  const geos = parts.map(([g, bone]) => {
    if (g.attributes.uv) g.deleteAttribute('uv');
    const n = g.attributes.position.count, k = bi.get(bone);
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, i) => (i % 4 ? 0 : k)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 4));
    return g;
  });
  const body = new THREE.SkinnedMesh(mergeGeometries(geos), new THREE.MeshStandardMaterial());
  body.name = 'Body';
  old.parent.remove(old);
  root.add(body);
  root.updateMatrixWorld(true);
  body.bind(old.skeleton, body.matrixWorld);
  const bones = []; root.traverse((o) => { if (o.isBone) bones.push(o); });
  const rest = new Map(); root.traverse((o) => rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
  let nodeCount = 0; root.traverse(() => nodeCount++);
  return { root, body, model: { root, humanoid: detectHumanoid(root, bones), rest, bones, skinned: [body], meshes: [], morphMeshes: [], nodeCount, poses: [], size: 1.8, constraints: null, drivenBones: new Set() } };
}

const { root, body, model } = fleshy();
const rig = model.humanoid;
const pose = (p = {}) => { rig.apply(rig.solve(paramsToSpec({ ...defaultParams(), ...p }))); root.updateMatrixWorld(true); };
// does anything still go into the other part after the dent? (deformed positions, nearest
// deformed vertex of the other part, along its normal)
function leftInside(s) {
  let worst = 0;
  const P = s.P, D = s.D, Nn = s.Nr;
  const list = s.spreadSet || [];
  const byGroup = new Map();
  for (const w of list) { const g = s.group[w]; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(w); }
  for (const w of list) {
    if (s.src[w] !== w) continue;
    const x = P[w * 3] + D[w * 3], y = P[w * 3 + 1] + D[w * 3 + 1], z = P[w * 3 + 2] + D[w * 3 + 2];
    let best = Infinity, bu = -1;
    for (const [g, ws] of byGroup) { if (g === s.group[w]) continue; for (const u of ws) { const d = (x - P[u * 3] - D[u * 3]) ** 2 + (y - P[u * 3 + 1] - D[u * 3 + 1]) ** 2 + (z - P[u * 3 + 2] - D[u * 3 + 2]) ** 2; if (d < best) { best = d; bu = u; } } }
    if (bu < 0 || best > (s.edge * 2) ** 2) continue;
    const d = (x - P[bu * 3] - D[bu * 3]) * Nn[bu * 3] + (y - P[bu * 3 + 1] - D[bu * 3 + 1]) * Nn[bu * 3 + 1] + (z - P[bu * 3 + 2] - D[bu * 3 + 2]) * Nn[bu * 3 + 2];
    if (s.left[w] < 1e-4 && -d > worst) worst = -d;
  }
  return worst;
}

{
  pose();
  const s = softSkin(model);
  ok('soft skin found the body parts', s && s.groups.includes('torso') && s.groups.includes('lArm') && s.groups.includes('head'), s ? s.groups.join(',') : '');
  pose({ lArmRaise: 90, rArmRaise: 90, lElbow: 0, rElbow: 0 });
  const tp = s.update({ write: false });
  ok('T-pose: nothing presses, nothing changes', !tp.contacts.some((c) => c.cm > 0.2), JSON.stringify(tp.contacts));
  // arms down: the upper arms press into the sides
  pose({ lArmRaise: 2, rArmRaise: 2 });
  const st = s.update({ write: false });
  const armSide = st.contacts.find((c) => [c.a, c.b].includes('torso') && [c.a, c.b].includes('lArm'));
  ok('arms down at the sides: the torso dents and the arm flattens instead of clipping', st.active && armSide && armSide.cm > 0.5 && st.leftCm < 0.2, JSON.stringify(armSide));
  const left = leftInside(s);
  ok('...nothing left inside the other part after the dent (within a quarter of an edge)', left < s.edge * 0.25, `${(left * 1000).toFixed(1)} mm (edges ${(s.edge * 1000).toFixed(0)} mm)`);
  // both sides give way: torso (soft) more than the arm
  let torsoD = 0, armD = 0;
  for (const w of s.spreadSet) { if (s.src[w] !== w) continue; const d = Math.hypot(s.D[w * 3], s.D[w * 3 + 1], s.D[w * 3 + 2]); if (s.groups[s.group[w]] === 'torso') torsoD = Math.max(torsoD, d); if (s.groups[s.group[w]] === 'lArm') armD = Math.max(armD, d); }
  ok('both give way, the softer torso more than the arm', torsoD > armD && armD > 0, `torso ${(torsoD * 1000).toFixed(1)} mm, arm ${(armD * 1000).toFixed(1)} mm`);
  // the dent is rounded off, with a slight bulge around it
  let bulge = 0, steps = 0, maxStep = 0;
  for (const w of s.spreadSet) {
    if (s.src[w] === w) continue;
    const out = s.D[w * 3] * s.Nr[w * 3] + s.D[w * 3 + 1] * s.Nr[w * 3 + 1] + s.D[w * 3 + 2] * s.Nr[w * 3 + 2];
    if (s.skinned[w] === s.skinFrame && out > bulge) bulge = out;
  }
  for (const w of s.spreadSet) for (let k = s.adjStart[w]; k < s.adjStart[w + 1]; k++) { const u = s.adj[k]; if (s.group[u] !== s.group[w]) continue; const dd = Math.hypot(s.D[w * 3] - s.D[u * 3], s.D[w * 3 + 1] - s.D[u * 3 + 1], s.D[w * 3 + 2] - s.D[u * 3 + 2]); maxStep = Math.max(maxStep, dd / Math.max(1e-6, s.adjLen[k])); steps++; }
  ok('the skin around the dent rises a little (squeezed flesh)', bulge > 0.0003, `${(bulge * 1000).toFixed(2)} mm`);
  ok('the dent fades smoothly (no cliffs between neighbours)', steps > 0 && maxStep < 0.9, `max slope ${maxStep.toFixed(2)}`);
  // GPU side: offsets and bent normals written, cleared again
  s.update({ write: true, force: true });
  const a = body.geometry.attributes.contactOffset, n = body.geometry.attributes.contactNormal;
  let ma = 0, mn = 0; for (let i = 0; i < a.array.length; i++) { ma = Math.max(ma, Math.abs(a.array[i])); mn = Math.max(mn, Math.abs(n.array[i])); }
  ok('offsets and bent normals reach the mesh', ma > 0.003 && mn > 0.02, `offset ${(ma * 1000).toFixed(1)} mm, normal ${mn.toFixed(3)}`);
  const v0 = a.version, solves = s.solves;
  updateSoftSkin(model);
  ok('the same pose isn\'t solved again', s.solves === solves || a.version === v0);
  model.softSkin = false;
  updateSoftSkin(model);
  ok('switched off: the skin goes back', !a.array.some((x) => x !== 0) && !n.array.some((x) => x !== 0));
  model.softSkin = true;
  // the bones stop it: a forearm folded hard onto the upper arm can't sink all the way
  pose({ lArmRaise: 60, lElbow: 150 });
  const deep = s.update({ write: false });
  ok('past the flesh the bones stop it: the rest is reported, the dent stays within the flesh', deep.active && deep.leftCm > 0.5, JSON.stringify(deep.contacts.filter((c) => c.leftCm > 0)));
  let over = 0;
  for (const w of s.spreadSet) { if (s.src[w] !== w) continue; const d = Math.hypot(s.D[w * 3], s.D[w * 3 + 1], s.D[w * 3 + 2]); over = Math.max(over, d - s.maxDepth[w] - s.edge * 0.03); }
  ok('...no vertex dents deeper than its flesh allows', over <= 1e-5, `${(over * 1000).toFixed(2)} mm over`);
  // joints: a bent elbow alone isn't contact; folded all the way the forearm presses the biceps
  pose({ lArmRaise: 60, lElbow: 60 });
  const bent = s.update({ write: false });
  ok('a bent elbow is the joint bending, not flesh pressing', !bent.contacts.some((c) => [c.a, c.b].includes('lArm') && [c.a, c.b].includes('lFore') && c.cm > 0.3), JSON.stringify(bent.contacts));
  pose({ lArmRaise: 60, lElbow: 150 });
  const folded = s.update({ write: false });
  ok('folded all the way, the forearm squashes the upper arm', folded.contacts.some((c) => [c.a, c.b].includes('lArm') && [c.a, c.b].includes('lFore') && c.cm > 0.5), JSON.stringify(folded.contacts));
  // the self-check's report
  pose();
  const clip = rig.bake('down', 1, (t) => paramsToSpec({ ...defaultParams(), lArmRaise: 60 - 58 * t, rArmRaise: 60 - 58 * t }), 30);
  const { evaluator } = await import('../src/anim/mouth.js');
  const ev = evaluator(model);
  let res;
  try { res = skinContacts(model, (tt) => ev.at(clip, tt), [0, 0.5, 1]); } finally { ev.done(); }
  ok('the self-check sees where parts press (and when)', res && res.some((c) => [c.a, c.b].includes('torso') && c.t === 1), JSON.stringify(res && res.slice(0, 3)));
  // speed
  pose({ lArmRaise: 2, rArmRaise: 2 });
  for (let i = 0; i < 3; i++) s.update({ write: false, force: true });
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) s.update({ write: false, force: true });
  const ms = (performance.now() - t0) / 10;
  ok('fast enough to run live', ms < 25, `${ms.toFixed(1)} ms per solve, ${s.N} vertices`);
}

// ---- face spots measured on the mesh: the cheek is on the cheek
{
  const { model: m2 } = mouthy();
  const head = m2.root.getObjectByName('Head');
  m2.root.updateMatrixWorld(true);
  const hp = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  // eyes (their own bones and meshes) and a face to find the cheeks on
  const eyes = [];
  for (const [n, x] of [['eye.L', 0.032], ['eye.R', -0.032]]) { const b = new THREE.Bone(); b.name = n; b.position.set(x - hp.x, 1.655 - hp.y, 0.1 - hp.z); head.add(b); eyes.push(b); }
  m2.root.updateMatrixWorld(true);
  const mk = (g, bone) => { const n = g.attributes.position.count; g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, i) => (i % 4 ? 0 : bone)), 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 4)); return g; };
  const face = new THREE.SphereGeometry(0.1, 40, 30); face.scale(0.95, 1.12, 1); face.translate(0, 1.62, 0.015);
  const e1 = new THREE.SphereGeometry(0.012, 12, 8); e1.translate(0.032, 1.655, 0.108);
  const e2 = new THREE.SphereGeometry(0.012, 12, 8); e2.translate(-0.032, 1.655, 0.108);
  const fm = new THREE.SkinnedMesh(mergeGeometries([mk(face, 0), mk(e1, 1), mk(e2, 2)]), new THREE.MeshStandardMaterial());
  fm.name = 'Face';
  m2.root.add(fm); m2.root.updateMatrixWorld(true);
  fm.bind(new THREE.Skeleton([head, ...eyes]), fm.matrixWorld);
  m2.skinned.push(fm);
  let nc = 0; m2.root.traverse(() => nc++); m2.nodeCount = nc;
  m2.bones = []; m2.root.traverse((o) => { if (o.isBone) m2.bones.push(o); });
  m2.rest = new Map(); m2.root.traverse((o) => m2.rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
  m2.humanoid = detectHumanoid(m2.root, m2.bones);
  const lm = faceLandmarks(m2);
  const P = lm && lm.points;
  ok('face parts found on the mesh: eyes, nose, cheeks, chin, lips', P && P.eyeL && P.eyeR && P.cheekL && P.cheekR && P.mouth && P.nose, P ? Object.keys(P).join(',') : '');
  if (P && P.cheekL) {
    const c = P.cheekL.p;
    ok('the left cheek: beside the nose, under the eye, on the front of the face', c.x > 0.02 && c.x < 0.06 && c.y < P.eyeL.p.y && c.y > P.mouth.p.y && c.z > 0.06 && P.cheekL.n.z > 0.5, `(${[c.x, c.y, c.z].map((v) => (v * 100).toFixed(1)).join(', ')}) cm, normal z ${P.cheekL.n.z.toFixed(2)}`);
    ok('the right cheek mirrors it', Math.abs(P.cheekR.p.x + c.x) < 0.005);
  }
  // the touch spot uses it
  const rig2 = m2.humanoid;
  const before = rig2.spot('cheek', 'left');
  rig2._spots = null;
  rig2.landmarks = () => faceLandmarks(m2);
  const after = rig2.spot('cheek', 'left');
  ok('a hand "on the cheek" now goes to the measured cheek', after.measured === 'mesh' && before.measured !== 'mesh', `${before.measured} -> ${after.measured}`);
}

console.log(fails ? `${fails} FAILED` : 'all soft-skin tests passed');
process.exit(fails ? 1 : 0);
