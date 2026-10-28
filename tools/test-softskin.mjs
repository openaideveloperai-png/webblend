// Soft skin: body parts pressing on each other dent and bulge like flesh instead of
// clipping, as far as the flesh over the bone allows. A smooth body on the demo
// mannequin's skeleton (no files needed). Also: face spots (cheek...) measured on the mesh.
// Usage: node tools/test-softskin.mjs
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeMannequin } from '../src/scene/primitives.js';
import { detectHumanoid, defaultParams, paramsToSpec } from '../src/anim/humanoid.js';
import { softSkin, updateSoftSkin, skinContacts, split, hertzOut, notSkinMaterial, solidBody, unsolidBody } from '../src/anim/softskin.js';
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
  const body = new THREE.SkinnedMesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color: 0xe9c3b0 }));
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
// triangles of the dent flipped over (the skin folding through itself)
function flips(s, list) {
  let n = 0;
  const P = s.P, D = s.D, seen = new Set();
  for (const w of list) for (let k = s.triStart[w]; k < s.triStart[w + 1]; k++) {
    const t = s.triOf[k];
    if (seen.has(t)) continue;
    seen.add(t);
    const [i, j, m] = [s.tris[t * 3] * 3, s.tris[t * 3 + 1] * 3, s.tris[t * 3 + 2] * 3];
    const cr = (o) => { const ux = P[j] - P[i] + o * (D[j] - D[i]), uy = P[j + 1] - P[i + 1] + o * (D[j + 1] - D[i + 1]), uz = P[j + 2] - P[i + 2] + o * (D[j + 2] - D[i + 2]); const vx = P[m] - P[i] + o * (D[m] - D[i]), vy = P[m + 1] - P[i + 1] + o * (D[m + 1] - D[i + 1]), vz = P[m + 2] - P[i + 2] + o * (D[m + 2] - D[i + 2]); return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx]; };
    const a = cr(0), b = cr(1);
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0) n++;
  }
  return n;
}
export { flips };

function leftInside(s) {
  let worst = 0;
  const P = s.P, D = s.D, Nn = s.Nr;
  const list = s.spreadSet || [];
  const byGroup = new Map();
  for (const w of list) { const g = s.group[w]; if (!byGroup.has(g)) byGroup.set(g, []); byGroup.get(g).push(w); }
  for (const w of list) {
    if (!s.pushed(w)) continue;
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
  for (const w of s.spreadSet) { if (!s.pushed(w)) continue; const d = Math.hypot(s.D[w * 3], s.D[w * 3 + 1], s.D[w * 3 + 2]); if (s.groups[s.group[w]] === 'torso') torsoD = Math.max(torsoD, d); if (s.groups[s.group[w]] === 'lArm') armD = Math.max(armD, d); }
  ok('both give way, the softer torso more than the arm', torsoD > armD && armD > 0, `torso ${(torsoD * 1000).toFixed(1)} mm, arm ${(armD * 1000).toFixed(1)} mm`);
  // the trampoline: a fingertip poking the belly pulls the skin around it down too
  pose({ rTouch: { spot: 'belly', weight: 1, finger: 'index', mode: 'tip', depth: 0.6 } });
  const poke = s.update({ write: false });
  let ring = 0, ringN = 0, far = 0, steps = 0, maxStep = 0, pc = null;
  for (const w of s.spreadSet) {
    if (s.pushed(w) || s.src[w] < 0) continue;
    const c = s.clusters[s.src[w]];
    if (s.groups[s.group[w]] !== 'torso' || c.depth < 0.002) continue;
    pc = c;
    const d = Math.hypot(s.D[w * 3], s.D[w * 3 + 1], s.D[w * 3 + 2]);
    const r = c.center ? s.key[w] : c.aGeo + s.key[w];
    if (r > 2 * c.aH && r < 3 * c.aH) { ring += d / c.depth; ringN++; }
    if (r > c.reach * 0.98) far = Math.max(far, d / c.depth);
  }
  for (const w of s.spreadSet) for (let k = s.adjStart[w]; k < s.adjStart[w + 1]; k++) { const u = s.adj[k]; if (s.group[u] !== s.group[w]) continue; const dd = Math.hypot(s.D[w * 3] - s.D[u * 3], s.D[w * 3 + 1] - s.D[u * 3 + 1], s.D[w * 3 + 2] - s.D[u * 3 + 2]); maxStep = Math.max(maxStep, dd / Math.max(1e-6, s.adjLen[k])); steps++; }
  ok('a fingertip poking the belly: the skin around it sinks too, a crater wider than the finger (trampoline)', poke.active && ringN > 3 && ring / ringN > 0.1 && pc && pc.reach > 4 * pc.aH, `2-3 contact radii out: ${(100 * ring / Math.max(1, ringN)).toFixed(0)}% of the ${pc ? (pc.depth * 1000).toFixed(1) : '?'} mm depth; crater ${pc ? (pc.reach / pc.aH).toFixed(1) : '?'}x the contact`);
  ok('...fading to nothing at its rim', far < 0.05, `${(far * 100).toFixed(1)}% at the rim`);
  ok('...and never folding through itself (no flipped triangles)', flips(s, s.spreadSet) === 0, `${flips(s, s.spreadSet)} flipped`);
  ok('the dent fades smoothly (no cliffs between neighbours)', steps > 0 && maxStep < 2.5, `max slope ${maxStep.toFixed(2)}`);
  pose({ lArmRaise: 2, rArmRaise: 2 });
  s.update({ write: false });
  // contact mechanics
  ok('Hertz contact: the edge sits at half the depth, ~22% at twice the radius', Math.abs(hertzOut(1) - 0.5) < 1e-9 && Math.abs(hertzOut(2) - 0.218) < 0.005 && hertzOut(5) < hertzOut(3));
  const a1 = split(0.01, 1, 0.03, 1, 0.03), a2 = split(0.01, 1, 0.03, 0.25, 0.03), a3 = split(0.05, 1, 0.03, 1, 0.01);
  ok('a squeeze is shared by softness, and the side near its bone stiffens', Math.abs(a1 - 0.005) < 1e-4 && a2 > 0.007 && Math.abs(a3 - 0.03) < 1e-9, `${(a1 * 1000).toFixed(1)} / ${(a2 * 1000).toFixed(1)} / ${(a3 * 1000).toFixed(1)} mm`);
  const st1 = split(0.02, 1, 0.025, 0.3, 0.004), st2 = split(0.04, 1, 0.025, 0.3, 0.004);
  ok('...flesh stiffens as it fills up: twice the squeeze, less than twice the dent', st2 < 2 * st1 && st2 > st1, `${(st1 * 1000).toFixed(1)} -> ${(st2 * 1000).toFixed(1)} mm`);
  // GPU side: offsets and bent normals written, cleared again
  s.update({ write: true, force: true });
  const a = body.geometry.attributes.contactOffset, n = body.geometry.attributes.contactNormal;
  let ma = 0, mn = 0; for (let i = 0; i < a.array.length; i++) { ma = Math.max(ma, Math.abs(a.array[i])); mn = Math.max(mn, Math.abs(n.array[i])); }
  ok('offsets and bent normals reach the mesh', ma > 0.003 && mn > 0.02, `offset ${(ma * 1000).toFixed(1)} mm, normal ${mn.toFixed(3)}`);
  const ti = body.geometry.attributes.contactTint;
  let mt = 0; for (let i = 0; i < ti.array.length; i += 3) mt = Math.max(mt, ti.array[i]);
  ok('pressed skin goes pale (blood pushed out)', mt > 0.08, `blanch ${mt.toFixed(2)}`);
  const shSkin = { vertexShader: 'void main(){\n#include <skinnormal_vertex>\n#include <skinning_vertex>\n}', fragmentShader: 'void main(){\n#include <color_fragment>\n}' };
  body.material.onBeforeCompile(shSkin, null);
  ok('skin materials show it; the dent bends the shading', /vContactTint/.test(shSkin.fragmentShader) && /objectNormal = normalize/.test(shSkin.vertexShader));
  const v0 = a.version, solves = s.solves;
  updateSoftSkin(model);
  ok('the same pose isn\'t solved again', s.solves === solves || a.version === v0);
  model.softSkin = false;
  updateSoftSkin(model);
  ok('switched off: the skin goes back', !a.array.some((x) => x !== 0) && !n.array.some((x) => x !== 0) && !ti.array.some((x) => x !== 0));
  model.softSkin = true;
  // the bones stop it: a forearm folded hard onto the upper arm can't sink all the way
  pose({ lArmRaise: 60, lElbow: 150 });
  const deep = s.update({ write: false });
  ok('past the flesh the bones stop it: the rest is reported, the dent stays within the flesh', deep.active && deep.leftCm > 0.5, JSON.stringify(deep.contacts.filter((c) => c.leftCm > 0)));
  let over = 0;
  for (const w of s.spreadSet) { const d = Math.hypot(s.D[w * 3], s.D[w * 3 + 1], s.D[w * 3 + 2]); over = Math.max(over, d - s.maxDepth[w] - s.edge * 0.03); }
  ok('...no vertex dents deeper than its flesh allows', over <= 1e-5, `${(over * 1000).toFixed(2)} mm over`);
  // joints: a bent elbow alone isn't contact; folded all the way the forearm presses the biceps
  pose({ lArmRaise: 60, lElbow: 60 });
  const bent = s.update({ write: false });
  ok('a bent elbow is the joint bending, not flesh pressing', !bent.contacts.some((c) => [c.a, c.b].includes('lArm') && [c.a, c.b].includes('lFore') && c.cm > 0.3), JSON.stringify(bent.contacts));
  pose({ lArmRaise: 60, lElbow: 150 });
  const folded = s.update({ write: false });
  ok('a hard squash (forearm folded onto the biceps) doesn\'t fold the skin through itself', flips(s, s.spreadSet) === 0, `${flips(s, s.spreadSet)} flipped, ${s.folds} eased`);
  ok('folded all the way, the forearm squashes the upper arm', folded.contacts.some((c) => [c.a, c.b].includes('lArm') && [c.a, c.b].includes('lFore') && c.cm > 0.5), JSON.stringify(folded.contacts));
  // the self-check's report
  pose();
  const clip = rig.bake('down', 1, (t) => paramsToSpec({ ...defaultParams(), lArmRaise: 60 - 58 * t, rArmRaise: 60 - 58 * t }), 30);
  const { evaluator } = await import('../src/anim/mouth.js');
  const ev = evaluator(model);
  let res;
  try { res = skinContacts(model, (tt) => ev.at(clip, tt), [0, 0.5, 1]); } finally { ev.done(); }
  ok('the self-check sees where parts press (and when)', res && res.some((c) => [c.a, c.b].includes('torso') && c.t === 1), JSON.stringify(res && res.slice(0, 3)));
  // per-bone settings (Ctrl+Shift+4): rigid, crater width, give
  {
    pose({ rTouch: { spot: 'belly', weight: 1, finger: 'index', mode: 'tip', depth: 0.6 } });
    const spine = root.getObjectByName('Spine1');
    const torsoMax = () => { let m = 0; for (const w of s.spreadSet) if (s.groups[s.group[w]] === 'torso') m = Math.max(m, Math.hypot(s.D[w * 3], s.D[w * 3 + 1], s.D[w * 3 + 2])); return m; };
    const reachOf = () => Math.max(0, ...s.clusters.filter((c) => c.wv !== undefined && s.groups[s.group[c.wv]] === 'torso').map((c) => c.reach));
    s.update({ write: false, force: true });
    const base = torsoMax(), baseReach = reachOf();
    model.indent = { [spine.uuid]: { rigid: true } }; model.indentVersion = 1;
    s.update({ write: false, force: true });
    const rigid = torsoMax();
    model.indent = { [spine.uuid]: { width: 2 } }; model.indentVersion = 2;
    s.update({ write: false, force: true });
    const wide = reachOf();
    model.indent = { [spine.uuid]: { give: 0.2 } }; model.indentVersion = 3;
    s.update({ write: false, force: true });
    const firm = torsoMax();
    ok('per-bone indent: rigid stops the dent, wider crater, firmer flesh dents less', base > 0.003 && rigid < base * 0.05 && wide > baseReach * 1.4 && firm < base, `dent ${(base * 1000).toFixed(1)} -> rigid ${(rigid * 1000).toFixed(1)} mm; crater ${(baseReach * 100).toFixed(1)} -> ${(wide * 100).toFixed(1)} cm; firm ${(firm * 1000).toFixed(1)} mm`);
    const info = s.boneInfo(spine);
    ok('...and it says how much skin a bone moves and how deep it can dent', info.count > 100 && info.dentCm > 0, JSON.stringify(info));
    model.indent = {}; model.indentVersion = 4;
  }
  // speed
  pose({ lArmRaise: 2, rArmRaise: 2 });
  for (let i = 0; i < 3; i++) s.update({ write: false, force: true });
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) s.update({ write: false, force: true });
  const ms = (performance.now() - t0) / 10;
  ok('fast enough to run live', ms < 25, `${ms.toFixed(1)} ms per solve, ${s.N} vertices`);
}

// ---- a fingertip held in the skin while the body moves slightly: its dent stays (it used
// to skip the fingertip every other frame, and the skin jumped back while still pressed)
{
  const F = fleshy();
  const s2 = softSkin(F.model);
  const dents = [];
  for (let i = 0; i < 10; i++) {
    F.model.humanoid.apply(F.model.humanoid.solve(paramsToSpec({ ...defaultParams(), lArmRaise: 4 + i * 0.05, rTouch: { spot: 'belly', weight: 1, finger: 'index', mode: 'tip', depth: 0.2 } })));
    F.root.updateMatrixWorld(true);
    s2.update();
    let mx = 0;
    // (the belly around the finger: the patch the fingertip's deepest point belongs to)
    const pcs = new Set((s2.probes || []).filter((p) => s2.groups[s2.group[p.w]] === 'torso').map((p) => s2.src[p.w]));
    for (const w of s2.spreadSet || []) if (s2.groups[s2.group[w]] === 'torso' && s2.src[w] >= 0 && pcs.has(s2.src[w])) mx = Math.max(mx, Math.hypot(s2.D[w * 3], s2.D[w * 3 + 1], s2.D[w * 3 + 2]));
    dents.push(mx);
  }
  const lo = Math.min(...dents), hi = Math.max(...dents);
  ok('a fingertip held in the belly while the body moves a little: its dent stays (no jumping back every other frame)', lo > 0.0005 && hi - lo < 0.15 * hi, dents.map((d) => (d * 1000).toFixed(1)).join(' ') + ' mm');
}

// ---- in time: pressed skin keeps up with the press at once, and once let go it springs
// back over a fraction of a second instead of snapping (scrubbing stays exact)
{
  const F = fleshy();
  const s3 = softSkin(F.model);
  const poseT = (p) => { F.model.humanoid.apply(F.model.humanoid.solve(paramsToSpec({ ...defaultParams(), ...p }))); F.root.updateMatrixWorld(true); };
  // (the belly, where the finger pressed: knees and elbows touch a little even in a T-pose)
  const shownMax = () => { let m = 0; for (const w of s3.shown || []) if (s3.groups[s3.group[w]] === 'torso') m = Math.max(m, Math.hypot(s3.S[w * 3], s3.S[w * 3 + 1], s3.S[w * 3 + 2])); return m; };
  const poke = { lArmRaise: 90, rTouch: { spot: 'belly', weight: 1, finger: 'index', mode: 'tip', depth: 0.6 } };
  const free = { lArmRaise: 90, rArmRaise: 90, lElbow: 0, rElbow: 0 };
  poseT(free); s3.update({ dt: 1 / 60 });
  poseT(poke); s3.update({ dt: 1 / 60 });
  let lag = 0;
  for (const w of s3.spreadSet) if (s3.pushed(w)) lag = Math.max(lag, Math.hypot(s3.D[w * 3] - s3.S[w * 3], s3.D[w * 3 + 1] - s3.S[w * 3 + 1], s3.D[w * 3 + 2] - s3.S[w * 3 + 2]));
  ok('pressed skin moves with the press in the same frame (it can\'t lag into clipping)', lag < 1e-6, `${(lag * 1000).toFixed(3)} mm behind`);
  for (let i = 0; i < 30; i++) s3.update({ dt: 1 / 60 });
  const full = shownMax();
  poseT(free);
  const curve = [];
  for (let i = 0; i < 60; i++) { s3.update({ dt: 1 / 60 }); curve.push(shownMax() / full); }
  const at = (t) => curve[Math.round(t * 60) - 1];
  ok('let go, the skin springs back smoothly over a fraction of a second (not in one frame)', at(1 / 60) > 0.8 && at(0.2) > 0.25 && at(0.2) < 0.55 && at(1) < 0.02 && curve.every((v, i) => i === 0 || v <= curve[i - 1] + 1e-9), `${[1 / 60, 0.1, 0.2, 0.5, 1].map((t) => (at(t) * 100).toFixed(0) + '%').join(' / ')} after 1 frame / 0.1 / 0.2 / 0.5 / 1 s`);
  let more = 0;
  while (s3.settling && more < 300) { s3.update({ dt: 1 / 60 }); more++; }
  ok('...and it keeps drawing until it has settled (then stops), the belly back as it was', !s3.settling && shownMax() < 1e-4 && more < 60, `settled ${((60 + more) / 60).toFixed(1)} s after letting go, ${(shownMax() * 1000).toFixed(3)} mm left`);
  poseT(poke); for (let i = 0; i < 10; i++) s3.update({ dt: 1 / 60 });
  poseT(free); s3.update({ dt: 0 });
  ok('scrubbing (no time step) shows the pose exactly: nothing left from before', shownMax() < 1e-4, `${(shownMax() * 1000).toFixed(3)} mm`);
}

// ---- not everything on the body is skin: hair weighted to the head never dents, and a thin
// piece lying on the skin (a detail layer, an accessory) follows the skin under it instead
// of denting on its own (separately it jumped about)
{
  const F = fleshy();
  const skel = F.body.skeleton, bi = new Map(skel.bones.map((b, i) => [b.name, i]));
  const weighted = (g, bone) => { const n = g.attributes.position.count, k = bi.get(bone); g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, i) => (i % 4 ? 0 : k)), 4)); g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 4)); return g; };
  // a patch of belly skin, 3 mm out from the body
  const patch = new THREE.CapsuleGeometry(0.11, 0.36, 8, 40, 28); patch.scale(1.35, 1, 0.85); patch.translate(0, 1.15, 0);
  const pp = patch.attributes.position, pn = patch.attributes.normal, keep = [];
  for (let i = 0; i < pp.count; i++) { if (pp.getZ(i) > 0.05 && Math.abs(pp.getY(i) - 1.05) < 0.12) keep.push(i); pp.setXYZ(i, pp.getX(i) + pn.getX(i) * 0.003, pp.getY(i) + pn.getY(i) * 0.003, pp.getZ(i) + pn.getZ(i) * 0.003); }
  const ix = patch.index.array, tri = [];
  const kept = new Set(keep);
  for (let t = 0; t < ix.length; t += 3) if (kept.has(ix[t]) && kept.has(ix[t + 1]) && kept.has(ix[t + 2])) tri.push(ix[t], ix[t + 1], ix[t + 2]);
  patch.setIndex(tri);
  const over = new THREE.SkinnedMesh(weighted(patch, 'Spine1'), new THREE.MeshStandardMaterial({ name: 'body_detail', color: 0xe9c3b0 })); over.name = 'Overlay';
  const hairG = new THREE.SphereGeometry(0.115, 24, 16); hairG.translate(0, 1.68, 0);
  const hair = new THREE.SkinnedMesh(weighted(hairG, 'Head'), new THREE.MeshStandardMaterial({ name: 'hair', color: 0x332211 })); hair.name = 'Hair';
  for (const m of [over, hair]) { F.root.add(m); F.root.updateMatrixWorld(true); m.bind(skel, m.matrixWorld); F.model.skinned.push(m); }
  F.model.nodeCount += 2;
  const s4 = softSkin(F.model);
  const names = { hair: true, HairBack: true, eye_L: true, Eyelash: true, '髪': true, horn: true, body_detail: false, face: false, body: false, chat_skin: false, Hatsune_body: false, body_socks: false };
  const wrong = Object.entries(names).filter(([n, v]) => notSkinMaterial(n) !== v).map(([n]) => n);
  ok('materials: hair, eyes, horns aren\'t skin; "detail", "chat" or "Hatsune" don\'t trip it', !wrong.length, wrong.join(', '));
  ok('hair weighted to the head isn\'t skin; a thin piece on the skin follows it', !s4.meshes.includes(hair) && s4.followerMeshes.includes('Overlay'), `skin meshes: ${s4.meshes.map((m) => m.name).join(', ')}; following: ${s4.followerMeshes.join(', ')}`);
  F.model.humanoid.apply(F.model.humanoid.solve(paramsToSpec({ ...defaultParams(), lArmRaise: 90, rTouch: { spot: 'belly', weight: 1, finger: 'index', mode: 'tip', depth: 0.6 } })));
  F.root.updateMatrixWorld(true);
  s4.update({ force: true });
  const maxOff = (m) => { const a = m.geometry.attributes.contactOffset; let x = 0; if (a) for (let k = 0; k < a.array.length; k += 3) x = Math.max(x, Math.hypot(a.array[k], a.array[k + 1], a.array[k + 2])); return x; };
  const bodyD = maxOff(F.body), overD = maxOff(over);
  ok('...pressed, the piece on the skin sinks with the skin under it', bodyD > 0.003 && overD > bodyD * 0.6 && overD <= bodyD * 1.01, `body ${(bodyD * 1000).toFixed(1)} mm, piece on it ${(overD * 1000).toFixed(1)} mm`);
}

// ---- a hand lying flat on the belly: the skin under every finger sinks along its length
// (it used to dent only under the deepest point of each finger; the rest clipped through)
{
  const F = fleshy();
  const s6 = softSkin(F.model);
  F.model.humanoid.apply(F.model.humanoid.solve(paramsToSpec({ ...defaultParams(), lArmRaise: 90, rTouch: { spot: 'belly', weight: 1, mode: 'palm', depth: 0.6 } })));
  F.root.updateMatrixWorld(true);
  // the palm pose keeps the fingers just off the skin: push the hand in until they're ~6 mm in
  const A = new THREE.Vector3(), B = new THREE.Vector3(), Q = new THREE.Quaternion();
  const hand = F.model.humanoid.map.rightHand, spine = F.model.humanoid.map.spine;
  const hw = new THREE.Vector3().setFromMatrixPosition(hand.matrixWorld), sw = new THREE.Vector3().setFromMatrixPosition(spine.matrixWorld);
  const toBody = new THREE.Vector3(sw.x - hw.x, 0, sw.z - hw.z).normalize();
  const local = toBody.clone().transformDirection(new THREE.Matrix4().copy(hand.parent.matrixWorld).invert()).multiplyScalar(0.025 / hand.parent.getWorldScale(new THREE.Vector3()).x);
  hand.position.add(local);
  F.root.updateMatrixWorld(true);
  s6.update({ force: true });
  // skin under each finger capsule: how far it's still inside the finger, before and after
  let under = 0, clipBefore = 0, clipAfter = 0, worst = 0;
  for (let fi = 0; fi < s6.fingerCaps.length; fi++) {
    const f = s6.fingerCaps[fi];
    if (s6.groups[s6.fingerGroup[fi]] !== 'rHand') continue;
    A.setFromMatrixPosition(f.a.matrixWorld);
    if (f.b) B.setFromMatrixPosition(f.b.matrixWorld); else B.copy(f.tip).applyMatrix4(f.a.matrixWorld);
    const L = A.distanceTo(B);
    if (f.off) { f.a.getWorldQuaternion(Q); const o = f.off.clone().applyQuaternion(Q).multiplyScalar(L); A.add(o); B.add(o); }
    const r = f.ratio * L, ab = B.clone().sub(A), l2 = ab.lengthSq() || 1e-12;
    for (let w = 0; w < s6.N; w++) {
      if (s6.groups[s6.group[w]] !== 'torso' || s6.skinned[w] !== s6.skinFrame) continue;
      const inside = (dx, dy, dz) => {
        const x = s6.P[w * 3] + dx, y = s6.P[w * 3 + 1] + dy, z = s6.P[w * 3 + 2] + dz;
        let t = ((x - A.x) * ab.x + (y - A.y) * ab.y + (z - A.z) * ab.z) / l2; t = Math.max(0, Math.min(1, t));
        return r - Math.hypot(A.x + t * ab.x - x, A.y + t * ab.y - y, A.z + t * ab.z - z);
      };
      const before = inside(0, 0, 0);
      if (before <= 0.001) continue;
      under++; clipBefore++;
      const after = inside(s6.S[w * 3], s6.S[w * 3 + 1], s6.S[w * 3 + 2]);
      if (after > 0.001) clipAfter++;
      worst = Math.max(worst, after);
    }
  }
  ok('a hand lying flat on the belly: the skin sinks under the whole length of every finger (no finger clipping in)', under > 10 && clipAfter === 0 && worst < 0.0012, `${under} skin points inside the fingers before the dent, ${clipAfter} after (deepest ${(worst * 1000).toFixed(1)} mm)`);
}

// ---- solid body: where a press goes past what the flesh on both sides can take (here the
// hands and forearms pushed into the thighs), the limbs stop at the limit
{
  const F = fleshy();
  const s5 = softSkin(F.model);
  const poseS = (p) => { F.model.humanoid.apply(F.model.humanoid.solve(paramsToSpec({ ...defaultParams(), ...p }))); F.root.updateMatrixWorld(true); };
  const deep = { lArmRaise: -8, rArmRaise: -8 };
  poseS(deep);
  const before = s5.solve({ write: false }).leftCm;
  const arm = F.model.humanoid.map.leftUpperArm, animated = arm.quaternion.clone();
  const r1 = solidBody(F.model);
  const after = s5.solve({ write: false }).leftCm;
  const turned = arm.quaternion.angleTo(animated) * 180 / Math.PI;
  ok('solid body: limbs pressing past the dent limit stop there instead of going through', before > 0.8 && after < 0.3 && r1.moved > 0, `${before} cm through -> ${after} cm (shoulder turned ${turned.toFixed(1)}°)`);
  const q1 = arm.quaternion.clone();
  const r2 = solidBody(F.model);
  ok('...the same pose again: the same correction, not worked out again or piled on', r2 === r1 && arm.quaternion.angleTo(q1) < 1e-6);
  poseS(deep); solidBody(F.model);
  ok('...the animation posing it again: corrected from the animated pose (nothing builds up)', arm.quaternion.angleTo(q1) < 1e-4, `${(arm.quaternion.angleTo(q1) * 180 / Math.PI).toFixed(4)}°`);
  F.model.solidBody = false; solidBody(F.model);
  ok('...switched off: the limbs go back to the pose as animated', arm.quaternion.angleTo(animated) < 1e-6);
  F.model.solidBody = true;
  poseS({ lArmRaise: 90, rArmRaise: 90 }); const free = arm.quaternion.clone(); solidBody(F.model);
  ok('...nothing pressing too hard: the pose is left exactly as it is', arm.quaternion.angleTo(free) < 1e-9);
  // playing: starts from last frame's correction (one solve a frame), and once let go the
  // limb drifts back to the animation over a few frames instead of snapping
  F.model.app = { transport: { playing: true, time: 0 } };
  const lefts = [];
  for (let i = 0; i < 12; i++) { poseS(deep); solidBody(F.model); lefts.push(s5.solve({ write: false }).leftCm); }
  const off = [];
  for (let i = 0; i < 40; i++) { poseS({}); const animatedQ = arm.quaternion.clone(); solidBody(F.model); off.push(arm.quaternion.angleTo(animatedQ) * 180 / Math.PI); }
  ok('...while playing it holds the limit frame after frame', Math.max(...lefts.slice(4)) < 0.5, lefts.map((x) => x.toFixed(1)).join(' ') + ' cm');
  ok('...and let go, the limb eases back to the animation (no snap)', off[0] > 0.2 && off[3] > 0.1 && off[39] < 0.05 && off.every((v, i) => i === 0 || v <= off[i - 1] + 1e-6), off.filter((_, i) => i % 5 === 0).map((x) => x.toFixed(2) + '°').join(' '));
  F.model.app = null;
  // a rig whose constraints / IK write the arm (MMD arm IK): like the real solver, a bone
  // that isn't where it left it counts as posed by hand and becomes the new pose. The
  // solid body's turn comes off before the constraints run, so it can't pile up
  F.model.app = { transport: { playing: true, time: 0 } };
  F.model._solidPrev = null; F.model._solid = null;
  const ik = { post: null, base: null };
  const fakeIK = () => { if (ik.post && arm.quaternion.equals(ik.post)) arm.quaternion.copy(ik.base); else ik.base = arm.quaternion.clone(); ik.post = arm.quaternion.clone(); };
  poseS(deep);
  const animatedQ = arm.quaternion.clone();
  const turns = [];
  for (let i = 0; i < 80; i++) { unsolidBody(F.model); fakeIK(); F.root.updateMatrixWorld(true); solidBody(F.model); turns.push(arm.quaternion.angleTo(animatedQ) * 180 / Math.PI); }
  const late = turns.slice(-15);
  ok('...on a rig whose IK writes the arm, the turn settles instead of piling up (arms folding)', ik.base.angleTo(animatedQ) < 1e-6 && Math.max(...late) - Math.min(...late) < 0.3 && Math.max(...turns) < 26, `turn ${turns.filter((_, i) => i % 16 === 0).map((x) => x.toFixed(1)).join(' -> ')}°, IK sees ${(ik.base.angleTo(animatedQ) * 57.3).toFixed(2)}° from the pose`);
  F.model.app = null;
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
