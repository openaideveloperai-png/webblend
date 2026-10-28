// Soft skin: body parts that press on each other (an arm against the side, a hand on the
// cheek, fingers pinching, the chin on the chest, thighs together, a forearm folded onto
// the biceps) dent and bulge like flesh instead of clipping through, as far as the flesh
// over the bone allows. Evaluated live every frame, the same pose always gives the same
// result (scrubbing works, nothing can blow up):
//  1. each body part gets a capsule around its bone; parts whose capsules overlap are near
//  2. where they're near, skin against skin is tested on the real mesh surfaces: a vertex
//     behind the other part's surface is inside it
//  3. both sides give way, each by how soft it is (a belly gives more than a hand), never
//     deeper than its flesh (a share of the distance to its bone): past that the bones
//     stop it
//  4. the dent fades smoothly over the surface with a slight bulge around it (pinched skin
//     rises between two fingertips)
// Joints are left alone (that's the skinning's job). The offsets ride on the GPU on top of
// the rig and shape keys, summed with the soft lips.
import * as THREE from 'three';
import { evaluator, EMPTY } from './mouth.js';
import { softLips } from './softlips.js';
import { faceLandmarks } from './landmarks.js';
import { prepareMesh, layer, beginLayer, setOffset, commit, ATTR, normalDeltas, weldedTriangles } from './offsets.js';

const NOT_SKIN = /hair|bang|ahoge|髪|毛|eye|目|瞳|brow|眉|lash|まつ|teeth|歯|tongue|舌|べろ|ribbon|hat|horn|角|tail|尻尾|wing|羽/i;
// which body part each humanoid bone belongs to; how soft it is (share of a squeeze it
// takes) and how deep it can dent (share of the distance from skin to bone)
const GROUP = {
  hips: 'torso', spine: 'torso', chest: 'torso', upperChest: 'torso', leftShoulder: 'torso', rightShoulder: 'torso',
  neck: 'neck', head: 'head',
  leftUpperArm: 'lArm', leftLowerArm: 'lFore', leftHand: 'lHand', rightUpperArm: 'rArm', rightLowerArm: 'rFore', rightHand: 'rHand',
  leftUpperLeg: 'lThigh', leftLowerLeg: 'lShin', leftFoot: 'lFoot', leftToes: 'lFoot', rightUpperLeg: 'rThigh', rightLowerLeg: 'rShin', rightFoot: 'rFoot', rightToes: 'rFoot',
};
const KIND = { torso: [1, 0.32], neck: [0.5, 0.15], head: [0.15, 0.06], Arm: [0.7, 0.25], Fore: [0.5, 0.16], Hand: [0.25, 0.08], Thigh: [0.9, 0.3], Shin: [0.4, 0.12], Foot: [0.2, 0.06] };
const kindOf = (g) => KIND[g] || KIND[g.slice(1)] || [0.5, 0.15];
const CHEEK = [0.65, 0.22];

const _m = new THREE.Matrix4(), _pre = new THREE.Matrix4();
// part shape profile: heights from -0.3 to 1.3 of the bone segment, angles all round
const PT = 10, PA = 16, PT0 = -0.3, PTS = 1.6 / PT;
// the 27 cells around a point, nearest first
const RING = [];
for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) RING.push([dx, dy, dz]);
RING.sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) + Math.abs(a[2]) - (Math.abs(b[0]) + Math.abs(b[1]) + Math.abs(b[2])));
const IDENT = new THREE.Matrix4();
const len3 = (x, y, z) => Math.sqrt(x * x + y * y + z * z);
const len2 = (x, y) => Math.sqrt(x * x + y * y);
function visibleChain(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }

// -> the model's soft skin (built on first contact), or null
export function softSkin(model) {
  if (!model || !model.humanoid || !(model.skinned || []).length) return null;
  if (model._skin !== undefined && model._skinN === model.nodeCount) return model._skin;
  if (model._skin) model._skin.clear();
  model._skinN = model.nodeCount;
  model._skin = null;
  try { model._skin = build(model); } catch (e) { console.warn('soft skin', e); model._skin = null; }
  return model._skin;
}

export const softSkinOn = (model) => model.softSkin !== false && !!softSkin(model);

export function updateSoftSkin(model) {
  if (!model.humanoid || !model.root.visible) return;
  if (model.softSkin === false) { if (model._skin) model._skin.clear(); return; }
  // not built yet: only once two body parts (not joined at a joint) come close
  if (model._skin === undefined || model._skinN !== model.nodeCount) { if (!mayTouch(model)) return; }
  const s = softSkin(model);
  if (!s) return;
  // heavy rigs during playback: every other frame (paused / scrubbing is always exact)
  const playing = model.app && model.app.transport && model.app.transport.playing;
  if (playing && s.lastMs > 12 && (s.skipOdd = !s.skipOdd)) return;
  const t0 = performance.now();
  const before = s.solves;
  s.update();
  if (s.solves !== before) s.lastMs = performance.now() - t0;
}

const PART_NAME = { torso: 'body', neck: 'neck', head: 'head', lArm: 'left upper arm', rArm: 'right upper arm', lFore: 'left forearm', rFore: 'right forearm', lHand: 'left hand', rHand: 'right hand', lThigh: 'left thigh', rThigh: 'right thigh', lShin: 'left shin', rShin: 'right shin', lFoot: 'left foot', rFoot: 'right foot' };
export const partName = (g) => PART_NAME[g] || g;

// plays a clip (with an evaluator that poses the rig) and measures where body parts press
// into each other: how much the skin dents, and what still goes through beyond the flesh
export function skinContacts(model, at, times) {
  const s = softSkinOn(model) ? softSkin(model) : null;
  if (!s) return null;
  const worst = new Map();
  for (const t of times) {
    at(t);
    const st = s.solve({ write: false });
    if (!st.active) continue;
    for (const c of st.contacts) {
      const k = c.a + '|' + c.b;
      const e = worst.get(k);
      if (!e || c.cm > e.cm) worst.set(k, { ...c, t: +t.toFixed(2) });
    }
  }
  return [...worst.values()].sort((a, b) => b.cm - a.cm);
}

// a quick look at the bones alone: hands / forearms near the body or head, legs together...
function mayTouch(model) {
  const m = model.humanoid.map;
  const P = (k) => { const b = m[k]; if (!b) return null; b.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(b.matrixWorld); };
  const head = P('head'), hips = P('hips'), foot = P('leftFoot') || P('rightFoot');
  if (!head || !hips) return false;
  const h = head.distanceTo(foot || hips) || 1;
  const near = h * 0.14;
  const body = [P('hips'), P('spine'), P('chest'), P('upperChest'), P('neck'), head].filter(Boolean);
  const bodySeg = (p) => { let d = Infinity; for (let i = 0; i + 1 < body.length; i++) d = Math.min(d, new THREE.Line3(body[i], body[i + 1]).closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p)); return d; };
  for (const s of ['left', 'right']) {
    for (const k of ['LowerArm', 'Hand']) { const p = P(s + k); if (p && bodySeg(p) < near * (k === 'Hand' ? 1.3 : 1)) return true; }
    const hand = P(s + 'Hand'), knee = P(s + 'LowerLeg');
    if (hand && knee && (hand.distanceTo(knee) < near || hand.distanceTo(P((s === 'left' ? 'right' : 'left') + 'Hand') || new THREE.Vector3(1e9, 0, 0)) < near)) return true;
    const lo = P(s + 'LowerArm'), up = P(s + 'UpperArm');
    if (lo && up && hand && lo.distanceTo(hand) > 1e-6 && up.distanceTo(hand) < lo.distanceTo(up) * 0.8) return true; // elbow folded
    const kn = P(s + 'LowerLeg'), ul = P(s + 'UpperLeg'), ft = P(s + 'Foot');
    if (kn && ul && ft && ul.distanceTo(ft) < ul.distanceTo(kn) * 0.9) return true; // knee folded
  }
  const kl = P('leftLowerLeg'), kr = P('rightLowerLeg');
  if (kl && kr && kl.distanceTo(kr) < near * 0.8) return true;
  return false;
}

function build(model) {
  const rig = model.humanoid;
  // each bone -> its body part (the nearest humanoid bone above it)
  const partOf = new Map();
  const canon = new Map();
  for (const [k, b] of Object.entries(rig.map)) if (b && GROUP[k]) canon.set(b, k);
  for (const b of model.bones) {
    let p = b;
    while (p && !canon.has(p)) p = p.parent;
    if (p) partOf.set(b, p);
  }
  if (!canon.size) return null;
  const lips = softLips(model);
  const lipKeys = new Set();
  if (lips) for (let i = 0; i < lips.N; i++) for (let k = lips.memStart[i]; k < lips.memStart[i + 1]; k++) lipKeys.add(lips.meshes[lips.memMesh[k]].uuid + ':' + lips.memIdx[k]);
  const lm = faceLandmarks(model);
  const ev = evaluator(model);
  try {
    ev.at(EMPTY, 0);
    return new SoftSkin(model, { partOf, canon, lipKeys, lm });
  } finally { ev.done(); }
}

class SoftSkin {
  constructor(model, { partOf, canon, lipKeys, lm }) {
    this.model = model;
    const rig = model.humanoid;
    // ---- body parts: a segment along each humanoid bone, its group, its neighbours
    const parts = [...canon.keys()];
    this.parts = parts;
    const pIndex = new Map(parts.map((b, i) => [b, i]));
    const groups = [...new Set(parts.map((b) => GROUP[canon.get(b)]))];
    this.groups = groups;
    const gIndex = new Map(groups.map((g, i) => [g, i]));
    this.partGroup = Int8Array.from(parts.map((b) => gIndex.get(GROUP[canon.get(b)])));
    const wp = (o) => { o.updateWorldMatrix(true, false); return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld); };
    // joints: where a part hangs from a part of another group (shoulder, elbow, wrist, neck...)
    this.joints = [];
    for (const b of parts) {
      let p = b.parent;
      while (p && !canon.has(p)) p = p.parent;
      if (!p) continue;
      const ga = gIndex.get(GROUP[canon.get(b)]), gb = gIndex.get(GROUP[canon.get(p)]);
      if (ga !== gb) this.joints.push({ bone: b, a: ga, b: gb, r: 0 });
    }
    // wrist, ankle and neck: what touches there is the joint bending (skinning's job), never
    // flesh pressing on flesh; elbows, knees, shoulders and hips fold onto real contact
    this.skipPair = new Uint8Array(32 * 32);
    for (const j of this.joints) {
      const n = [groups[j.a], groups[j.b]].join(' ');
      if (/Hand|Foot|neck/.test(n)) { this.skipPair[j.a * 32 + j.b] = 1; this.skipPair[j.b * 32 + j.a] = 1; }
    }
    // ---- skin vertices (rest pose)
    const raw = [];
    const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
    const meshes = [];
    for (const s of model.skinned) {
      if (!visibleChain(s) || !s.skeleton) continue;
      const g = s.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, na = g.attributes.normal;
      if (!si || !sw || !na || !g.attributes.position) continue;
      nm.getNormalMatrix(s.matrixWorld);
      let used = false;
      for (let i = 0; i < si.count; i++) {
        let bi = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; bi = si.getComponent(i, k); } }
        const b = s.skeleton.bones[bi];
        if (!b || NOT_SKIN.test(b.name) || lipKeys.has(s.uuid + ':' + i)) continue;
        const part = partOf.get(b);
        if (!part) continue;
        s.getVertexPosition(i, v).applyMatrix4(s.matrixWorld);
        n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
        raw.push({ mesh: s, i, x: v.x, y: v.y, z: v.z, nx: n.x, ny: n.y, nz: n.z, part: pIndex.get(part), bone: b });
        used = true;
      }
      if (used) meshes.push(s);
    }
    this.meshes = meshes;
    const mi = new Map(meshes.map((m, i) => [m, i]));
    // weld seams (same spot, same part)
    let y0 = Infinity, y1 = -Infinity;
    for (const e of raw) { if (e.y < y0) y0 = e.y; if (e.y > y1) y1 = e.y; }
    const q = Math.max(1e-7, (y1 - y0) * 5e-5);
    const ids = new Map(), reps = [];
    for (const e of raw) {
      const k = `${Math.round(e.x / q)},${Math.round(e.y / q)},${Math.round(e.z / q)},${e.part}`;
      let w = ids.get(k);
      if (w === undefined) { w = reps.length; ids.set(k, w); reps.push(e); e.members = []; }
      e.w = w;
      reps[w].members.push(e);
    }
    const N = (this.N = reps.length);
    if (N < 20) throw new Error('too little skin');
    this.memStart = new Int32Array(N + 1);
    const mm = [], mv = [];
    reps.forEach((e, w) => { this.memStart[w] = mm.length; for (const x of e.members) { mm.push(mi.get(x.mesh)); mv.push(x.i); } });
    this.memStart[N] = mm.length;
    this.memMesh = Int32Array.from(mm);
    this.memIdx = Int32Array.from(mv);
    // representative per welded vertex, grouped by mesh for skinning
    this.repMesh = Int32Array.from(reps.map((e) => mi.get(e.mesh)));
    this.repIdx = Int32Array.from(reps.map((e) => e.i));
    this.part = Int16Array.from(reps.map((e) => e.part));
    this.group = Int8Array.from(reps.map((e) => this.partGroup[e.part]));
    // the bone that mostly moves each vertex, and the vertex in that bone's space (fast estimate)
    const dBones = [...new Set(reps.map((e) => e.bone))];
    const dIndex = new Map(dBones.map((b, i) => [b, i]));
    this.dBones = dBones;
    this.dbone = Int32Array.from(reps.map((e) => dIndex.get(e.bone)));
    this.local = new Float32Array(N * 3);
    const inv = dBones.map((b) => { b.updateWorldMatrix(true, false); return b.matrixWorld.clone().invert(); });
    reps.forEach((e, w) => { v.set(e.x, e.y, e.z).applyMatrix4(inv[this.dbone[w]]); this.local[w * 3] = v.x; this.local[w * 3 + 1] = v.y; this.local[w * 3 + 2] = v.z; });
    // ---- part segments (bone to its next part, or along its own skin) and bounding radius
    const restPos = parts.map(wp);
    this.segEnd = parts.map((b, k) => {
      const kids = parts.filter((c) => { let p = c.parent; while (p && !canon.has(p)) p = p.parent; return p === b; });
      let end;
      if (kids.length) end = kids.map(wp).reduce((a, x) => a.add(x), new THREE.Vector3()).divideScalar(kids.length);
      else {
        // a leaf (head, hand, foot): out along its own skin
        const mine = reps.filter((e) => e.part === k);
        let dir = restPos[k].clone().sub(b.parent ? wp(b.parent) : restPos[k].clone().add(new THREE.Vector3(0, -1, 0)));
        if (dir.lengthSq() < 1e-12) dir.set(0, 1, 0);
        dir.normalize();
        let far = 0;
        for (const e of mine) far = Math.max(far, (e.x - restPos[k].x) * dir.x + (e.y - restPos[k].y) * dir.y + (e.z - restPos[k].z) * dir.z);
        end = restPos[k].clone().addScaledVector(dir, far * 0.85);
      }
      b.updateWorldMatrix(true, false);
      return end.applyMatrix4(b.matrixWorld.clone().invert());
    });
    const segA = restPos, segB = parts.map((b, k) => this.segEnd[k].clone().applyMatrix4(b.matrixWorld));
    const distSeg = (k, x, y, z) => {
      const A = segA[k], B = segB[k];
      const abx = B.x - A.x, aby = B.y - A.y, abz = B.z - A.z, l2 = abx * abx + aby * aby + abz * abz;
      let t = l2 > 1e-12 ? ((x - A.x) * abx + (y - A.y) * aby + (z - A.z) * abz) / l2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      return Math.hypot(x - A.x - t * abx, y - A.y - t * aby, z - A.z - t * abz);
    };
    const radii = parts.map(() => []);
    this.flesh = new Float32Array(N);
    reps.forEach((e, w) => { const d = distSeg(e.part, e.x, e.y, e.z); this.flesh[w] = d; radii[e.part].push(d); });
    this.radius = Float32Array.from(radii.map((r) => { if (!r.length) return 0; r.sort((a, b) => a - b); return r[Math.floor((r.length - 1) * 0.97)]; }));
    this.typical = Float32Array.from(radii.map((r) => (r.length ? r[Math.floor((r.length - 1) * 0.5)] : 0)));
    // each part's shape around its bone: how far its skin reaches at each height and angle
    // (so only skin that can really touch it gets tested)
    this.profiles = parts.map((b, k) => {
      const inv = b.matrixWorld.clone().invert();
      const B = this.segEnd[k].clone(), len = B.length() || 1e-6;
      const u = B.clone().divideScalar(len);
      const e1 = Math.abs(u.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      e1.addScaledVector(u, -e1.dot(u)).normalize();
      const e2 = new THREE.Vector3().crossVectors(u, e1);
      const bins = new Float32Array(PT * PA);
      const p = new THREE.Vector3();
      for (const e of reps) {
        if (e.part !== k) continue;
        p.set(e.x, e.y, e.z).applyMatrix4(inv);
        const a = p.dot(u), x = p.dot(e1), y = p.dot(e2), r = Math.hypot(x, y);
        const ti = Math.min(PT - 1, Math.max(0, Math.floor(((a / len) - PT0) / PTS)));
        const ai = ((Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * PA) % PA) + PA) % PA;
        if (r > bins[ti * PA + ai]) bins[ti * PA + ai] = r;
      }
      // grow a bin into its neighbours (no holes between sparse vertices)
      const grown = new Float32Array(PT * PA);
      for (let ti = 0; ti < PT; ti++) for (let ai = 0; ai < PA; ai++) {
        let m = 0;
        for (let dt = -1; dt <= 1; dt++) for (let da = -1; da <= 1; da++) { const tj = ti + dt; if (tj < 0 || tj >= PT) continue; m = Math.max(m, bins[tj * PA + ((ai + da + PA) % PA)]); }
        grown[ti * PA + ai] = m;
      }
      const sc = new THREE.Vector3(); b.getWorldScale(sc);
      return { u, e1, e2, len, bins: grown, scale: Math.max(1e-9, (Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3) };
    });
    // each part's skin in small patches (a centre in the part's frame + a radius), so whole
    // patches far from another part are skipped at once
    this.chunks = parts.map((b, k) => {
      const inv = b.matrixWorld.clone().invert();
      const pr = this.profiles[k];
      const cells = new Map();
      const p = new THREE.Vector3();
      reps.forEach((e, w) => {
        if (e.part !== k) return;
        p.set(e.x, e.y, e.z).applyMatrix4(inv);
        const a = p.dot(pr.u), x = p.dot(pr.e1), y = p.dot(pr.e2);
        const ti = Math.floor(((a / pr.len) - PT0) / (PTS / 2)), ai = ((Math.floor(((Math.atan2(y, x) + Math.PI) / (2 * Math.PI)) * PA) % PA) + PA) % PA;
        const key = ti * 64 + ai;
        let c = cells.get(key);
        if (!c) cells.set(key, (c = { ids: [], sx: 0, sy: 0, sz: 0 }));
        c.ids.push(w); c.sx += p.x; c.sy += p.y; c.sz += p.z;
      });
      return [...cells.values()].map((c) => {
        const n = c.ids.length, cx = c.sx / n, cy = c.sy / n, cz = c.sz / n;
        let r = 0;
        for (const w of c.ids) { const e = reps[w]; p.set(e.x, e.y, e.z).applyMatrix4(inv); r = Math.max(r, Math.hypot(p.x - cx, p.y - cy, p.z - cz)); }
        return { ids: Int32Array.from(c.ids), c: new THREE.Vector3(cx, cy, cz), r: r * pr.scale * 1.25 + this.edge };
      });
    });
    for (const j of this.joints) {
      const k = pIndex.get(j.bone);
      const pk = (() => { let p = j.bone.parent; while (p && !canon.has(p)) p = p.parent; return pIndex.get(p); })();
      j.pos = j.bone.matrixWorld.clone();
      j.r = 1.25 * Math.max(this.typical[k] || 0, this.typical[pk] || 0, this.radius[k] * 0.6);
      j.part = k;
    }
    // ---- softness and how deep each vertex can give (cheeks soft, skull hard)
    this.soft = new Float32Array(N);
    this.maxDepth = new Float32Array(N);
    const head = rig.map.head;
    let cheek = null;
    if (lm && lm.points && (lm.points.cheekL || lm.points.cheekR) && head) {
      head.updateWorldMatrix(true, false);
      const hq = new THREE.Quaternion(); head.getWorldQuaternion(hq);
      const hp = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
      const hrq = rig.rest.get(head).Wq.clone().invert();
      const ax = { lat: rig.lat.clone().applyQuaternion(hrq).applyQuaternion(hq), up: rig.up.clone().applyQuaternion(hrq).applyQuaternion(hq), fwd: rig.fwd.clone().applyQuaternion(hrq).applyQuaternion(hq) };
      const pts = ['cheekL', 'cheekR'].map((k) => lm.points[k]).filter(Boolean).map((c) => hp.clone().addScaledVector(ax.lat, c.p.x).addScaledVector(ax.up, c.p.y).addScaledVector(ax.fwd, c.p.z));
      cheek = { pts, r: (lm.eyeX || 0.03) * 1.1 };
    }
    reps.forEach((e, w) => {
      const g = groups[this.group[w]];
      let [sf, k] = kindOf(g);
      if (g === 'head' && cheek) {
        let f = 0;
        for (const c of cheek.pts) f = Math.max(f, 1 - Math.min(1, Math.hypot(e.x - c.x, e.y - c.y, e.z - c.z) / cheek.r));
        f = f * f * (3 - 2 * f);
        sf += (CHEEK[0] - sf) * f; k += (CHEEK[1] - k) * f;
      }
      this.soft[w] = sf;
      this.maxDepth[w] = k * this.flesh[w];
    });
    // ---- surface graph (for the smooth dent)
    const adj = Array.from({ length: N }, () => new Set());
    const maps = new Map();
    for (const m of meshes) {
      const map = new Int32Array(m.geometry.attributes.position.count).fill(-1);
      for (const e of raw) if (e.mesh === m) map[e.i] = e.w;
      maps.set(m, map);
      const ix = m.geometry.index;
      const cnt = ix ? ix.count : m.geometry.attributes.position.count;
      for (let t = 0; t + 2 < cnt; t += 3) {
        const a = map[ix ? ix.getX(t) : t], b = map[ix ? ix.getX(t + 1) : t + 1], c = map[ix ? ix.getX(t + 2) : t + 2];
        if (a >= 0 && b >= 0 && a !== b) { adj[a].add(b); adj[b].add(a); }
        if (b >= 0 && c >= 0 && b !== c) { adj[b].add(c); adj[c].add(b); }
        if (a >= 0 && c >= 0 && a !== c) { adj[a].add(c); adj[c].add(a); }
      }
    }
    this.adjStart = new Int32Array(N + 1);
    const al = [];
    for (let i = 0; i < N; i++) { this.adjStart[i] = al.length; for (const j of adj[i]) al.push(j); }
    this.adjStart[N] = al.length;
    this.adj = Int32Array.from(al);
    this.adjLen = new Float32Array(al.length);
    let sumE = 0;
    for (let i = 0; i < N; i++) for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
      const a = reps[i], b = reps[this.adj[k]];
      this.adjLen[k] = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
      sumE += this.adjLen[k];
    }
    this.edge = al.length ? sumE / al.length : rig.height * 0.01;
    // triangles (for the dent's shading)
    Object.assign(this, weldedTriangles(meshes, (m) => maps.get(m), N));
    // vertices of each part (for the near-part test)
    this.byPart = parts.map(() => []);
    for (let w = 0; w < N; w++) this.byPart[this.part[w]].push(w);
    this.byPart = this.byPart.map((l) => Int32Array.from(l));
    // ---- buffers
    this.P = new Float32Array(N * 3);
    this.Nr = new Float32Array(N * 3);
    this.H = new Float32Array(N * 3);
    this.D = new Float32Array(N * 3);
    this.left = new Float32Array(N);
    this.cand = new Int32Array(N); // bitmask of groups each vertex may touch this frame
    this.stamp = new Uint32Array(N);
    this.skinned = new Uint32Array(N); // which frame each vertex was last skinned
    this.ND = new Float32Array(N * 3);
    this.skinFrame = 0;
    this.frame = 1;
    this.restPen = new Float32Array(N);
    this.boneMats = new Map();
    this.active = false;
    this.sig = null;
    this.stats = { active: false, dentCm: 0, leftCm: 0, contacts: [] };
    this.prepared = false;
    // what already overlaps in the rest pose (thighs touching...) stays as modelled
    this.solve({ rest: true });
  }

  // ---------------------------------------------------------------- per frame
  // the part capsules now (world)
  capsules() {
    const out = this.caps || (this.caps = this.parts.map(() => ({ ax: 0, ay: 0, az: 0, bx: 0, by: 0, bz: 0, r: 0 })));
    const v = new THREE.Vector3();
    this.parts.forEach((b, k) => {
      b.updateWorldMatrix(true, false);
      const c = out[k];
      v.setFromMatrixPosition(b.matrixWorld); c.ax = v.x; c.ay = v.y; c.az = v.z;
      v.copy(this.segEnd[k]).applyMatrix4(b.matrixWorld); c.bx = v.x; c.by = v.y; c.bz = v.z;
      c.r = this.radius[k];
    });
    return out;
  }

  signature() {
    const s = this.sigBuf || (this.sigBuf = []);
    s.length = 0;
    const root = this.model.root;
    root.updateWorldMatrix(true, false);
    _m.copy(root.matrixWorld).invert();
    for (const b of this.dBones) { _pre.multiplyMatrices(_m, b.matrixWorld); const e = _pre.elements; for (let i = 0; i < 16; i++) s.push(Math.round(e[i] * 1e6)); }
    s.push(this.model.softSkinSoftness ?? 1);
    return s;
  }

  update({ write = true, force = false } = {}) {
    if (write) {
      const sig = this.signature();
      let same = !force && !!this.sig && sig.length === this.sig.length;
      if (same) for (let i = 0; i < sig.length; i++) if (sig[i] !== this.sig[i]) { same = false; break; }
      this.sig = sig.slice();
      if (same) return this.stats;
    }
    const st = this.solve({ write });
    this.solves = (this.solves || 0) + 1;
    if (write) this.stats = st;
    return st;
  }

  solve({ write = false, rest = false } = {}) {
    const N = this.N, caps = this.capsules();
    const stats = { active: false, dentCm: 0, leftCm: 0, contacts: [] };
    // 1. which parts are near each other (not across a joint's own two parts)
    const P = this.parts.length, pairs = [];
    for (let a = 0; a < P; a++) for (let b = a + 1; b < P; b++) {
      if (this.partGroup[a] === this.partGroup[b] || !this.radius[a] || !this.radius[b] || this.skipPair[this.partGroup[a] * 32 + this.partGroup[b]]) continue;
      const d = segDist(caps[a], caps[b]);
      if (d >= caps[a].r + caps[b].r) continue;
      // how far each one's skin really reaches toward the other there
      if (d > this.reachToward(a, _cpB) + this.reachToward(b, _cpA) + this.edge * 2) continue;
      pairs.push([a, b]);
    }
    const H = this.H, cand = this.cand;
    this.frame++;
    if (!pairs.length) { if (write) this.clear(); return stats; }
    // 2. vertices of each part close to the other part (estimated from their bone)
    const mats = this.mats || (this.mats = []);
    for (let i = 0; i < this.dBones.length; i++) { const b = this.dBones[i]; b.updateWorldMatrix(true, false); mats[i] = b.matrixWorld.elements; }
    const tbuf = this.tbuf || (this.tbuf = new Int32Array(N));
    let nt = 0;
    const qmask = this.qmask || (this.qmask = new Int32Array(N));
    const L = this.local;
    const tol = this.edge * 0.8;
    const invs = new Map();
    const invOf = (o) => { let e = invs.get(o); if (!e) { e = _m.copy(this.parts[o].matrixWorld).invert().elements.slice(); invs.set(o, e); } return e; };
    for (const [a, b] of pairs) {
      for (const [p, o] of [[a, b], [b, a]]) {
        const c = caps[o], lim = c.r + tol, gm = 1 << this.partGroup[o];
        const pr = this.profiles[o], ie = invOf(o), tl = tol / pr.scale;
        const pm = this.parts[p].matrixWorld.elements;
        for (const ch of this.chunks[p]) {
          const cx = ch.c.x, cy = ch.c.y, cz = ch.c.z;
          const wx = pm[0] * cx + pm[4] * cy + pm[8] * cz + pm[12], wy = pm[1] * cx + pm[5] * cy + pm[9] * cz + pm[13], wz = pm[2] * cx + pm[6] * cy + pm[10] * cz + pm[14];
          if (pointSeg(wx, wy, wz, c) - ch.r > lim) continue;
          for (const w of ch.ids) {
          const e = mats[this.dbone[w]], vx = L[w * 3], vy = L[w * 3 + 1], vz = L[w * 3 + 2];
          const x = e[0] * vx + e[4] * vy + e[8] * vz + e[12], y = e[1] * vx + e[5] * vy + e[9] * vz + e[13], z = e[2] * vx + e[6] * vy + e[10] * vz + e[14];
          if (pointSeg(x, y, z, c) > lim) continue;
          // into the other part's frame: is it within that part's skin there?
          const lx = ie[0] * x + ie[4] * y + ie[8] * z + ie[12], ly = ie[1] * x + ie[5] * y + ie[9] * z + ie[13], lz = ie[2] * x + ie[6] * y + ie[10] * z + ie[14];
          const al = lx * pr.u.x + ly * pr.u.y + lz * pr.u.z, px = lx * pr.e1.x + ly * pr.e1.y + lz * pr.e1.z, py = lx * pr.e2.x + ly * pr.e2.y + lz * pr.e2.z;
          const tt = al / pr.len;
          let ti = Math.floor((tt - PT0) / PTS), over = 0;
          if (ti < 0) { over = (PT0 - tt) * pr.len; ti = 0; } else if (ti >= PT) { over = (tt - PT0 - PT * PTS) * pr.len; ti = PT - 1; }
          const ai = ((Math.floor(((Math.atan2(py, px) + Math.PI) / (2 * Math.PI)) * PA) % PA) + PA) % PA;
          const reach = pr.bins[ti * PA + ai];
          if (!(reach > 0)) continue;
          const out = len2(px, py) - reach;
          if ((out > 0 ? out * out : 0) + over * over > tl * tl) continue;
          if (this.stamp[w] !== this.frame) { this.stamp[w] = this.frame; cand[w] = 0; qmask[w] = 0; tbuf[nt++] = w; }
          cand[w] |= gm;
          // inside that part's outline: worth asking whether it's really inside its skin
          if (out <= tl * 0.25 && over <= tl * 0.25) qmask[w] |= gm;
          }
        }
      }
    }
    if (!nt) { if (write) this.clear(); return stats; }
    const touched = tbuf.subarray(0, nt);
    // 3. exact positions + normals of those vertices (shape keys and bones)
    this.skinFrame++;
    this.skin(touched);
    // 4. skin against skin: a vertex behind the other part's surface is inside it
    // (a flat spatial hash of this frame's vertices: nearest vertex of a part it may touch)
    const cell = Math.max(this.edge * 1.5, 1e-4);
    const T = 1 << 15, MASK = T - 1;
    const hs = this.hashStart || (this.hashStart = new Int32Array(T + 1));
    const hi = this.hashItems || (this.hashItems = new Int32Array(N));
    const hk = this.hashKey || (this.hashKey = new Int32Array(N));
    const Pp = this.P, Nn = this.Nr, grp = this.group;
    // keyed by cell and body part, so a lookup only meets the parts it may touch
    const hkey = (ix, iy, iz, g) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (g * 2654435761)) & MASK;
    hs.fill(0);
    for (const w of touched) { const k = hkey(Math.floor(Pp[w * 3] / cell), Math.floor(Pp[w * 3 + 1] / cell), Math.floor(Pp[w * 3 + 2] / cell), grp[w]); hk[w] = k; hs[k + 1]++; }
    for (let k = 0; k < T; k++) hs[k + 1] += hs[k];
    const fillAt = this.fillAt || (this.fillAt = new Int32Array(T));
    fillAt.set(hs.subarray(0, T));
    for (const w of touched) hi[fillAt[hk[w]]++] = w;
    const soft = Math.min(2, Math.max(0.2, this.model.softSkinSoftness ?? 1));
    const hard = [];
    let maxLeft = 0;
    const contact = this.contact || (this.contact = new Float32Array(32 * 32));
    const contactLeft = this.contactLeft || (this.contactLeft = new Float32Array(32 * 32));
    contact.fill(0); contactLeft.fill(0);
    for (const w of touched) {
      const mask = qmask[w], gw = grp[w];
      if (!mask) continue;
      const x = Pp[w * 3], y = Pp[w * 3 + 1], z = Pp[w * 3 + 2];
      const nx = Nn[w * 3], ny = Nn[w * 3 + 1], nz = Nn[w * 3 + 2];
      const ix = Math.floor(x / cell), iy = Math.floor(y / cell), iz = Math.floor(z / cell);
      let best = Infinity, bu = -1;
      const good = (cell * 0.35) ** 2;
      for (let g = 0; g < 32 && best > good; g++) {
        if (!(mask & (1 << g))) continue;
        // own cell first, then the ring around it (stop once something is close enough)
        for (let r = 0; r < 27 && best > good; r++) {
          const o = RING[r];
          const k = hkey(ix + o[0], iy + o[1], iz + o[2], g);
          for (let q = hs[k], e = hs[k + 1]; q < e; q++) {
            const u = hi[q];
            if (grp[u] !== g) continue;
            const d = (x - Pp[u * 3]) ** 2 + (y - Pp[u * 3 + 1]) ** 2 + (z - Pp[u * 3 + 2]) ** 2;
            if (d < best) { best = d; bu = u; }
          }
        }
      }
      if (bu < 0) continue;
      const ux = Pp[bu * 3], uy = Pp[bu * 3 + 1], uz = Pp[bu * 3 + 2], mx = Nn[bu * 3], my = Nn[bu * 3 + 1], mz = Nn[bu * 3 + 2];
      const d = (x - ux) * mx + (y - uy) * my + (z - uz) * mz;
      if (d >= 0) continue;
      // within the other surface's reach (not off past its edge), surfaces facing each other
      const tx = x - ux - d * mx, ty = y - uy - d * my, tz = z - uz - d * mz;
      if (tx * tx + ty * ty + tz * tz > cell * cell * 2.25) continue;
      if (nx * mx + ny * my + nz * mz > 0.5) continue;
      // near a joint between these two parts, the skinning handles it
      const jf = this.jointFade(w, bu, x, y, z);
      if (jf <= 0) continue;
      let pen = -d;
      if (rest) { this.restPen[w] = Math.max(this.restPen[w], pen); continue; }
      pen = (pen - this.restPen[w] * 1.05) * jf;
      // a hair's breadth is noise, not a press
      if (pen <= Math.max(0.0004, this.edge * 0.03)) continue;
      // both give way by how soft they are; when one side is down to its bone, the
      // other takes the rest (as far as its own flesh goes)
      const myCap = this.maxDepth[w] * soft, otherCap = this.maxDepth[bu] * soft;
      let mine = pen * (this.soft[w] / (this.soft[w] + this.soft[bu]));
      const other = pen - mine;
      if (other > otherCap) mine += other - otherCap;
      mine += this.edge * 0.02;
      const push = Math.min(mine, myCap);
      const left = Math.max(0, pen - push - Math.min(pen - push, otherCap));
      if (left > maxLeft) maxLeft = left;
      H[w * 3] = mx * push; H[w * 3 + 1] = my * push; H[w * 3 + 2] = mz * push;
      this.left[w] = left;
      hard.push(w);
      const ck = gw < grp[bu] ? gw * 32 + grp[bu] : grp[bu] * 32 + gw;
      if (pen > contact[ck]) contact[ck] = pen;
      if (left > contactLeft[ck]) contactLeft[ck] = left;
    }
    if (rest || !hard.length) { if (write) this.clear(); return stats; }
    // 5. the dent fades over the surface, with a slight bulge around it
    const D = this.spread(hard, soft);
    let maxD = 0;
    for (const w of this.spreadSet) maxD = Math.max(maxD, len3(D[w * 3], D[w * 3 + 1], D[w * 3 + 2]));
    stats.active = true;
    stats.dentCm = +(maxD * 100).toFixed(2);
    stats.leftCm = +(maxLeft * 100).toFixed(2);
    for (let k = 0; k < contact.length; k++) if (contact[k] > 0) stats.contacts.push({ a: this.groups[(k / 32) | 0], b: this.groups[k % 32], cm: +(contact[k] * 100).toFixed(1), leftCm: +(contactLeft[k] * 100).toFixed(1) });
    if (write) this.write();
    return stats;
  }

  // how far part k's skin reaches from its bone toward a world point (its shape profile)
  reachToward(k, pt) {
    const pr = this.profiles[k];
    const e = _m.copy(this.parts[k].matrixWorld).invert().elements;
    const x = pt.x, y = pt.y, z = pt.z;
    const lx = e[0] * x + e[4] * y + e[8] * z + e[12], ly = e[1] * x + e[5] * y + e[9] * z + e[13], lz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const al = lx * pr.u.x + ly * pr.u.y + lz * pr.u.z, px = lx * pr.e1.x + ly * pr.e1.y + lz * pr.e1.z, py = lx * pr.e2.x + ly * pr.e2.y + lz * pr.e2.z;
    const ti = Math.min(PT - 1, Math.max(0, Math.floor((al / pr.len - PT0) / PTS)));
    const ai = ((Math.floor(((Math.atan2(py, px) + Math.PI) / (2 * Math.PI)) * PA) % PA) + PA) % PA;
    return pr.bins[ti * PA + ai] * pr.scale;
  }

  // 0 near the joint the two parts share (shoulder, elbow...), 1 away from it
  jointFade(w, u, x, y, z) {
    const ga = this.group[w], gb = this.group[u];
    let f = 1;
    for (const j of this.joints) {
      if (!((j.a === ga && j.b === gb) || (j.a === gb && j.b === ga))) continue;
      const e = j.bone.matrixWorld.elements;
      const d = len3(x - e[12], y - e[13], z - e[14]);
      const t = Math.min(1, Math.max(0, (d - j.r * 0.75) / (j.r * 0.5)));
      f = Math.min(f, t * t * (3 - 2 * t));
    }
    return f;
  }

  // exact skinned positions + normals (world) of some welded vertices
  skin(list) {
    const byMesh = new Map();
    for (const w of list) { const m = this.repMesh[w]; if (!byMesh.has(m)) byMesh.set(m, []); byMesh.get(m).push(w); }
    for (const [mk, ws] of byMesh) {
      const mesh = this.meshes[mk];
      const E = boneMatsOf(mesh, this.boneMats);
      const g = mesh.geometry, pos = g.attributes.position, nor = g.attributes.normal, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      const morph = g.morphAttributes.position, infl = mesh.morphTargetInfluences, rel = g.morphTargetsRelative;
      const act = [];
      if (morph && infl) for (let k = 0; k < morph.length && k < infl.length; k++) if (infl[k]) act.push(k);
      for (const w of ws) {
        this.skinned[w] = this.skinFrame;
        const i = this.repIdx[w];
        let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
        for (const k of act) { const a = morph[k], f = infl[k]; if (rel) { x += f * a.getX(i); y += f * a.getY(i); z += f * a.getZ(i); } else { x += f * (a.getX(i) - pos.getX(i)); y += f * (a.getY(i) - pos.getY(i)); z += f * (a.getZ(i) - pos.getZ(i)); } }
        const ax = nor.getX(i), ay = nor.getY(i), az = nor.getZ(i);
        let wx = 0, wy = 0, wz = 0, qx = 0, qy = 0, qz = 0;
        for (let c = 0; c < 4; c++) {
          const wt = sw.getComponent(i, c);
          if (!wt) continue;
          const o = si.getComponent(i, c) * 16;
          wx += wt * (E[o] * x + E[o + 4] * y + E[o + 8] * z + E[o + 12]);
          wy += wt * (E[o + 1] * x + E[o + 5] * y + E[o + 9] * z + E[o + 13]);
          wz += wt * (E[o + 2] * x + E[o + 6] * y + E[o + 10] * z + E[o + 14]);
          qx += wt * (E[o] * ax + E[o + 4] * ay + E[o + 8] * az);
          qy += wt * (E[o + 1] * ax + E[o + 5] * ay + E[o + 9] * az);
          qz += wt * (E[o + 2] * ax + E[o + 6] * ay + E[o + 10] * az);
        }
        const ql = len3(qx, qy, qz) || 1;
        this.P[w * 3] = wx; this.P[w * 3 + 1] = wy; this.P[w * 3 + 2] = wz;
        this.Nr[w * 3] = qx / ql; this.Nr[w * 3 + 1] = qy / ql; this.Nr[w * 3 + 2] = qz / ql;
      }
    }
  }

  // each pushed vertex carries its surroundings along (a smooth, rounded dent), and just
  // outside the dent the skin rises a little (squeezed flesh goes somewhere)
  spread(hard, soft) {
    const N = this.N, H = this.H, D = this.D;
    const key = this.key || (this.key = new Float32Array(N)), src = this.src || (this.src = new Int32Array(N)), dist = this.dist || (this.dist = new Float32Array(N));
    const seen = this.seen || (this.seen = new Uint32Array(N));
    const heap = this.heap || (this.heap = new Heap(N));
    heap.clear();
    for (const w of this.spreadSet || []) { D[w * 3] = D[w * 3 + 1] = D[w * 3 + 2] = 0; }
    const stamp = ++this.frame;
    const set = [];
    let ref = 0;
    for (const w of hard) ref = Math.max(ref, len3(H[w * 3], H[w * 3 + 1], H[w * 3 + 2]));
    const visit = (w) => { if (seen[w] !== stamp) { seen[w] = stamp; key[w] = Infinity; src[w] = -1; dist[w] = 0; set.push(w); } };
    for (const w of hard) {
      visit(w);
      const k = Math.log(ref / Math.max(1e-9, len3(H[w * 3], H[w * 3 + 1], H[w * 3 + 2])));
      if (k < key[w]) { key[w] = k; src[w] = w; dist[w] = 0; heap.push(w, k); }
    }
    // falloff over the surface: a share of the part's thickness (wider dents on a belly than on a finger)
    const as = this.adjStart, adj = this.adj, len = this.adjLen;
    while (heap.size) {
      const i = heap.pop();
      const ki = key[i];
      if (dist[i] > 2.4 || ki > 9) continue;
      const Li = Math.max(this.edge, 0.3 * this.typical[this.part[i]] * soft);
      for (let k = as[i]; k < as[i + 1]; k++) {
        const j = adj[k];
        visit(j);
        const step = len[k] / Li;
        const d = ki + step;
        if (d < key[j]) { key[j] = d; src[j] = src[i]; dist[j] = dist[i] + step; heap.push(j, d); }
      }
    }
    for (const w of set) {
      const s = src[w];
      if (s < 0) { D[w * 3] = D[w * 3 + 1] = D[w * 3 + 2] = 0; continue; }
      const hx = H[s * 3], hy = H[s * 3 + 1], hz = H[s * 3 + 2], hl = len3(hx, hy, hz);
      const x = dist[w];
      // dent: full at the contact, rounded off around it
      const f = s === w ? 1 : Math.exp(-x * x * 2.2);
      // bulge: the squeezed flesh rises in a ridge just outside the dent (along its own normal)
      const xb = x / 0.75;
      const b = s === w ? 0 : 0.35 * hl * xb * xb * Math.exp(1 - xb * xb);
      D[w * 3] = hx * f; D[w * 3 + 1] = hy * f; D[w * 3 + 2] = hz * f;
      if (b > 0) {
        // the normal of a vertex we didn't skin this frame: take the dent's own direction reversed
        const has = this.skinned[w] === this.skinFrame;
        const nx = has ? this.Nr[w * 3] : -hx / (hl || 1), ny = has ? this.Nr[w * 3 + 1] : -hy / (hl || 1), nz = has ? this.Nr[w * 3 + 2] : -hz / (hl || 1);
        D[w * 3] += nx * b; D[w * 3 + 1] += ny * b; D[w * 3 + 2] += nz * b;
      }
    }
    this.spreadSet = set;
    return D;
  }

  // world offsets -> each mesh's local space -> the GPU (summed with the soft lips)
  write() {
    if (!this.prepared) { for (const m of this.meshes) prepareMesh(m); this.prepared = true; }
    const set = this.spreadSet || [];
    // the bent normals: every corner of the triangles around the dent needs a position
    const need = [];
    for (const w of set) for (let k = this.triStart[w]; k < this.triStart[w + 1]; k++) { const t = this.triOf[k] * 3; for (let c = 0; c < 3; c++) { const u = this.tris[t + c]; if (this.skinned[u] !== this.skinFrame) { this.skinned[u] = this.skinFrame; need.push(u); } } }
    for (const u of need) this.skinned[u] = 0;
    if (need.length) this.skin(need);
    normalDeltas(set, this.tris, this.triStart, this.triOf, this.P, this.D, this.ND);
    const inv = this.meshes.map((m) => new THREE.Matrix3().setFromMatrix4(m.matrixWorld).invert());
    const rinv = this.meshes.map((m) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m.matrixWorld)).invert());
    const ls = this.meshes.map((m) => (m.geometry.attributes[ATTR] ? layer(m, 'skin') : null));
    const ln = this.meshes.map((m) => (m.geometry.attributes[ATTR] ? layer(m, 'skin', 'nor') : null));
    for (const l of ls) if (l) beginLayer(l);
    for (const l of ln) if (l) beginLayer(l);
    const D = this.D, ND = this.ND, Nr = this.Nr, v = new THREE.Vector3();
    for (const w of set) {
      const dx = D[w * 3], dy = D[w * 3 + 1], dz = D[w * 3 + 2];
      if (!dx && !dy && !dz) continue;
      // triangles wound the other way: flip so the normal bends the right way
      let nx = ND[w * 3], ny = ND[w * 3 + 1], nz = ND[w * 3 + 2];
      if (this.windingFlip(w)) { nx = -nx; ny = -ny; nz = -nz; }
      for (let k = this.memStart[w]; k < this.memStart[w + 1]; k++) {
        const m = this.memMesh[k], l = ls[m];
        if (!l) continue;
        v.set(dx, dy, dz).applyMatrix3(inv[m]);
        setOffset(l, this.memIdx[k], v.x, v.y, v.z);
        v.set(nx, ny, nz).applyQuaternion(rinv[m]);
        setOffset(ln[m], this.memIdx[k], v.x, v.y, v.z);
      }
    }
    for (const m of this.meshes) commit(m);
    this.active = true;
  }

  // do this vertex's triangles face against its own normal? (mirrored or flipped meshes)
  windingFlip(w) {
    const P = this.P, Nr = this.Nr;
    let ax = 0, ay = 0, az = 0;
    for (let k = this.triStart[w]; k < this.triStart[w + 1]; k++) {
      const t = this.triOf[k] * 3, i = this.tris[t] * 3, j = this.tris[t + 1] * 3, m = this.tris[t + 2] * 3;
      const ux = P[j] - P[i], uy = P[j + 1] - P[i + 1], uz = P[j + 2] - P[i + 2], vx = P[m] - P[i], vy = P[m + 1] - P[i + 1], vz = P[m + 2] - P[i + 2];
      ax += uy * vz - uz * vy; ay += uz * vx - ux * vz; az += ux * vy - uy * vx;
    }
    return ax * Nr[w * 3] + ay * Nr[w * 3 + 1] + az * Nr[w * 3 + 2] < 0;
  }

  clear() {
    if (!this.active) return;
    this.active = false;
    for (const m of this.meshes) {
      if (!m.geometry.attributes[ATTR]) continue;
      beginLayer(layer(m, 'skin'));
      beginLayer(layer(m, 'skin', 'nor'));
      commit(m);
    }
  }
}

// ---------------------------------------------------------------- geometry helpers
function pointSeg(x, y, z, c) {
  const abx = c.bx - c.ax, aby = c.by - c.ay, abz = c.bz - c.az, l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 1e-14 ? ((x - c.ax) * abx + (y - c.ay) * aby + (z - c.az) * abz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return len3(x - c.ax - t * abx, y - c.ay - t * aby, z - c.az - t * abz);
}

// closest distance between two segments
function segDist(p, q) {
  const d1x = p.bx - p.ax, d1y = p.by - p.ay, d1z = p.bz - p.az, d2x = q.bx - q.ax, d2y = q.by - q.ay, d2z = q.bz - q.az;
  const rx = p.ax - q.ax, ry = p.ay - q.ay, rz = p.az - q.az;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  let s, t;
  if (a <= 1e-14 && e <= 1e-14) { s = t = 0; } else if (a <= 1e-14) { s = 0; t = Math.min(1, Math.max(0, f / e)); } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-14) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > 1e-14 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); } else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  _cpA.set(p.ax + d1x * s, p.ay + d1y * s, p.az + d1z * s);
  _cpB.set(q.ax + d2x * t, q.ay + d2y * t, q.az + d2z * t);
  return _cpA.distanceTo(_cpB);
}
const _cpA = new THREE.Vector3(), _cpB = new THREE.Vector3();

function boneMatsOf(mesh, cache) {
  const sk = mesh.skeleton, n = sk.bones.length;
  let a = cache.get(mesh);
  if (!a || a.length !== n * 16) { a = new Float32Array(n * 16); cache.set(mesh, a); }
  _pre.multiplyMatrices(mesh.matrixWorld, mesh.bindMatrixInverse);
  for (let b = 0; b < n; b++) {
    const bone = sk.bones[b];
    _m.multiplyMatrices(bone ? bone.matrixWorld : IDENT, sk.boneInverses[b] || IDENT).premultiply(_pre).multiply(mesh.bindMatrix);
    a.set(_m.elements, b * 16);
  }
  return a;
}

class Heap {
  constructor(n) { this.ids = new Int32Array(n * 4 + 8); this.keys = new Float32Array(n * 4 + 8); this.size = 0; }
  clear() { this.size = 0; }
  push(id, key) {
    if (this.size >= this.ids.length) { const a = new Int32Array(this.ids.length * 2), b = new Float32Array(this.ids.length * 2); a.set(this.ids); b.set(this.keys); this.ids = a; this.keys = b; }
    let i = this.size++;
    const ids = this.ids, keys = this.keys;
    while (i > 0) { const p = (i - 1) >> 1; if (keys[p] <= key) break; ids[i] = ids[p]; keys[i] = keys[p]; i = p; }
    ids[i] = id; keys[i] = key;
  }
  pop() {
    const ids = this.ids, keys = this.keys, top = ids[0];
    const n = --this.size;
    if (n > 0) {
      const id = ids[n], key = keys[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && keys[c + 1] < keys[c]) c++;
        if (keys[c] >= key) break;
        ids[i] = ids[c]; keys[i] = keys[c]; i = c;
      }
      ids[i] = id; keys[i] = key;
    }
    return top;
  }
}
