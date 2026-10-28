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
import { softLips, fingerCapsules } from './softlips.js';
import { faceLandmarks } from './landmarks.js';
import { prepareMesh, layer, beginLayer, setOffset, commit, ATTR, normalDeltas, weldedTriangles, unfold } from './offsets.js';

const NOT_SKIN = /hair|bang|ahoge|髪|毛|eye|目|瞳|brow|眉|lash|まつ|teeth|歯|tongue|舌|べろ|ribbon|hat|horn|角|tail|尻尾|wing|羽/i;
// materials that never dent as skin (hair weighted to the head, horns, a loose skirt...)
// (whole words, camelCase too: "HairBack" and "eye_L" count, "detail" or "chat" don't)
const NOT_SKIN_WORD = /^(hair|bangs?$|ahoge|eye|iris|pupil|brow|lash|teeth|tooth|tongue|horn|tail|wing|hats?$|ribbon|skirt|cape|coat|glass|weapon|sword)/;
const NOT_SKIN_JP = /髪|目|瞳|眉|まつ|歯|舌|角|尻尾|羽|帽|リボン|スカート|マント|眼鏡|剣/;
function notSkinMaterial(name) {
  const n = String(name || '');
  if (NOT_SKIN_JP.test(n)) return true;
  return n.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z]+/).some((w) => w && NOT_SKIN_WORD.test(w));
}
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
// which of the PA angle bins (x, y) falls in: a pseudo-angle (same order as the real angle,
// without the trigonometry), used for the shape profiles and the per-frame test alike
function abin(x, y) {
  const s = (x < 0 ? -x : x) + (y < 0 ? -y : y);
  if (!(s > 0)) return 0;
  const p = y >= 0 ? 1 - x / s : 3 + x / s;
  return Math.floor(p * PA * 0.25) % PA;
}
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

export function updateSoftSkin(model, dt) {
  if (!model.humanoid || !model.root.visible) return;
  if (model.softSkin === false) { if (model._skin) model._skin.clear(); return; }
  // not built yet: only once two body parts (not joined at a joint) come close
  if (model._skin === undefined || model._skinN !== model.nodeCount) { if (!mayTouch(model)) return; }
  const s = softSkin(model);
  if (!s) return;
  // heavy rigs during playback: every other frame (paused / scrubbing is always exact)
  const playing = model.app && model.app.transport && model.app.transport.playing;
  // (the solid body, when on, has already decided this frame for both)
  if (s.frameSkip !== undefined) { const k = s.frameSkip; s.frameSkip = undefined; if (k) return; } else if (playing && (s.lastMs || 0) > 12 && (s.skipOdd = !s.skipOdd)) return;
  const t0 = performance.now();
  const before = s.solves;
  // the skin eases in time while playing or posing; scrubbing to another time is exact
  const tr = model.app && model.app.transport;
  const time = tr ? tr.time : 0;
  const jumped = s.lastTime !== undefined && Math.abs(time - s.lastTime) > 1e-6 && !playing;
  s.lastTime = time;
  s.update({ dt: dt > 0 && !jumped ? Math.min(dt, 0.1) : 0 });
  if (s.solves !== before) s.lastMs = performance.now() - t0;
}

// how the skin follows a press in time (viscoelastic, Kelvin-Voigt-like): pressed skin moves
// with what presses it at once (it can't lag into clipping); the crater around it settles in
// a few frames, and once let go it springs back over a fraction of a second, not instantly
const SETTLE_IN = 0.03, SETTLE_OUT = 0.16;

// ---------------------------------------------------------------- solid body
// The body can't go through itself: where a press goes past what the flesh on both sides
// can take (the bones would meet), the limb doing it stops at that limit. Each arm / leg
// turns at its shoulder / hip just enough to back the contact out (a few passes, since
// moving one contact can change another). Changes the pose that's shown; the keys stay.
const LIMBS = [['left', 'UpperArm', ['lArm', 'lFore', 'lHand']], ['right', 'UpperArm', ['rArm', 'rFore', 'rHand']], ['left', 'UpperLeg', ['lThigh', 'lShin', 'lFoot']], ['right', 'UpperLeg', ['rThigh', 'rShin', 'rFoot']]];
const _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _va = new THREE.Vector3(), _vb = new THREE.Vector3(), _vj = new THREE.Vector3();
export function solidBody(model) {
  if (model.solidBody === false || model.softSkin === false || !model.humanoid) {
    // switched off: the limbs go back to the pose as animated
    if (model._solid && model._solid.size) { for (const [b, e] of model._solid) if (b.quaternion.equals(e.applied)) b.quaternion.copy(e.base); model._solid.clear(); model.root.updateMatrixWorld(true); }
    model._solidLast = null;
    return null;
  }
  const s = model._skin;
  if (!s) return null;
  const rig = model.humanoid;
  // the shoulders / hips as the pose has them (not last frame's correction on top)
  const st = model._solid || (model._solid = new Map());
  for (const [bone, e] of st) { if (bone.quaternion.equals(e.applied)) bone.quaternion.copy(e.base); }
  st.clear();
  model.root.updateMatrixWorld(true);
  // paused on the same pose as last time: the same correction, no need to work it out again
  // (while playing it keeps easing frame to frame)
  const app = model.app;
  const live = !!(app && ((app.transport && app.transport.playing) || app._drag));
  const baseSig = s.signature().slice();
  const last = model._solidLast;
  if (!live && last && last.sig.length === baseSig.length && last.sig.every((x, i) => x === baseSig[i])) {
    for (const [bone, e] of last.map) { e.base.copy(bone.quaternion); bone.quaternion.copy(e.applied); st.set(bone, e); }
    if (last.map.size) model.root.updateMatrixWorld(true);
    return last.out;
  }
  const limbs = LIMBS.map(([side, k, gs]) => ({ bone: rig.map[side + k], leg: k === 'UpperLeg', gs: new Set(gs.map((g) => s.groups.indexOf(g)).filter((i) => i >= 0)) })).filter((l) => l.bone && l.gs.size);
  // while playing or dragging: start from last frame's correction, eased a little back toward
  // the animation (warm start: usually one solve a frame, and a limb let go drifts back
  // smoothly); paused / scrubbed: worked out from scratch, exactly
  const prev = model._solidPrev;
  // a heavy rig while playing: the soft skin skips every other frame, and so does this
  // (keeping last frame's correction as it is)
  const playing = !!(app && app.transport && app.transport.playing);
  const skip = playing && (s.lastMs || 0) + (model._solidMs || 0) > 12 && (model._solidOdd = !model._solidOdd);
  s.frameSkip = skip;
  if (live && prev && prev.size) {
    for (const [bone, qd] of prev) {
      const e = { base: bone.quaternion.clone(), applied: new THREE.Quaternion() };
      _q.identity().slerp(qd, skip ? 1 : 0.9);
      bone.getWorldQuaternion(_q2);
      const parentQ = new THREE.Quaternion();
      if (bone.parent) bone.parent.getWorldQuaternion(parentQ);
      bone.quaternion.copy(parentQ.invert().multiply(_q.multiply(_q2)));
      e.applied.copy(bone.quaternion);
      st.set(bone, e);
    }
    model.root.updateMatrixWorld(true);
  }
  if (skip) { model.root.updateMatrixWorld(true); s.measured = null; return model._solidLast ? model._solidLast.out : null; }
  const t0 = performance.now();
  let res = null, moved = 0, dirty = false;
  for (let pass = 0, passes = live ? 2 : 4; pass < passes; pass++) {
    model.root.updateMatrixWorld(true);
    res = s.solve({ write: false, measure: true });
    dirty = false;
    const ex = s.excess || [];
    if (!ex.length) break;
    let any = false;
    for (const L of limbs) {
      // the one small turn at the limb's root that best moves every contact of it out of the
      // other part by as much as it's through (least squares over all of them at once, along
      // each contact's own direction only, so they may slide). Contacts freed in an earlier
      // pass stay in with "don't go back in", or freeing one would push another back through
      // (hands crossing in front, forearms on the thighs)
      L.bone.updateWorldMatrix(true, false);
      _vj.setFromMatrixPosition(L.bone.matrixWorld);
      const rows = [];
      let most = 0;
      for (const e of ex) {
        const mine = L.gs.has(e.g), theirs = L.gs.has(e.o);
        if (mine === theirs) continue;
        // against another limb, each backs off half; but an arm against a leg is the arm's
        // to move (the legs carry the stance, the feet may be planted)
        const other = limbs.find((M) => M !== L && M.gs.has(mine ? e.o : e.g));
        if (other && L.leg && !other.leg) continue;
        const share = other && L.leg === other.leg ? 0.5 : 1, sign = mine ? 1 : -1;
        // away from the other part's bone (deep inside thin parts the surface normals point
        // every which way; the line between the two bones doesn't)
        let dx = sign * e.dx, dy = sign * e.dy, dz = sign * e.dz;
        const lp = mine ? e.pa : e.po, op = mine ? e.po : e.pa;
        if (lp >= 0 && op >= 0 && s.caps) {
          segDist(s.caps[lp], s.caps[op]);
          const ax = _cpA.x - _cpB.x, ay = _cpA.y - _cpB.y, az = _cpA.z - _cpB.z, al = len3(ax, ay, az);
          if (al > 1e-4) { dx = ax / al; dy = ay / al; dz = az / al; }
        }
        // (the deepest points count most: they set the turn, the rest steer it)
        const dw = (e.left + 0.002) * 100;
        rows.push({ rx: e.x - _vj.x, ry: e.y - _vj.y, rz: e.z - _vj.z, dx, dy, dz, need: e.left * share + 0.001, w: dw * dw * dw, pair: Math.min(e.g, e.o) * 32 + Math.max(e.g, e.o) });
        most = Math.max(most, e.left * share);
      }
      // (playing: a second pass only for what's clearly still through)
      const fresh = most >= (live && pass ? 0.004 : 0.0015);
      const keep = L.keep || (L.keep = []);
      if (!fresh) { for (const k of keep) k.need = 0; continue; }
      // (only contacts already freed: the ones still through are in this pass's rows)
      const live2 = new Set(rows.map((r) => r.pair));
      const all = rows.concat(keep.filter((k) => !live2.has(k.pair)).map((k) => ({ ...k, need: 0, w: k.w * 0.7 })));
      // normal equations for omega: sum w g g^T omega = sum w need g, with g = r x d
      let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0, b0 = 0, b1 = 0, b2 = 0;
      for (const c of all) {
        const gx = c.ry * c.dz - c.rz * c.dy, gy = c.rz * c.dx - c.rx * c.dz, gz = c.rx * c.dy - c.ry * c.dx;
        a00 += c.w * gx * gx; a01 += c.w * gx * gy; a02 += c.w * gx * gz; a11 += c.w * gy * gy; a12 += c.w * gy * gz; a22 += c.w * gz * gz;
        b0 += c.w * c.need * gx; b1 += c.w * c.need * gy; b2 += c.w * c.need * gz;
      }
      // a little damping: the smallest turn that does it
      const tr = (a00 + a11 + a22) * 0.004 + 1e-14;
      const m00 = a00 + tr, m11 = a11 + tr, m22 = a22 + tr;
      const det = m00 * (m11 * m22 - a12 * a12) - a01 * (a01 * m22 - a12 * a02) + a02 * (a01 * a12 - m11 * a02);
      if (!(Math.abs(det) > 1e-40)) continue;
      const wx = (b0 * (m11 * m22 - a12 * a12) - a01 * (b1 * m22 - a12 * b2) + a02 * (b1 * a12 - m11 * b2)) / det;
      const wy = (m00 * (b1 * m22 - a12 * b2) - b0 * (a01 * m22 - a12 * a02) + a02 * (a01 * b2 - b1 * a02)) / det;
      const wz = (m00 * (m11 * b2 - b1 * a12) - a01 * (a01 * b2 - b1 * a02) + b0 * (a01 * a12 - m11 * a02)) / det;
      const ang = len3(wx, wy, wz);
      if (!(ang > 1e-7)) continue;
      // never more than a fair turn in one pass
      _q.setFromAxisAngle(_va.set(wx / ang, wy / ang, wz / ang), Math.min(ang, 0.35));
      // remember this pass's contacts (turned with the limb) for the next passes
      L.keep = all.map((c) => { _vb.set(c.rx, c.ry, c.rz).applyQuaternion(_q); return { rx: _vb.x, ry: _vb.y, rz: _vb.z, dx: c.dx, dy: c.dy, dz: c.dz, w: c.w, pair: c.pair }; }).slice(-400);
      const e = st.get(L.bone) || { base: L.bone.quaternion.clone(), applied: new THREE.Quaternion() };
      L.bone.getWorldQuaternion(_q2);
      const parentQ = new THREE.Quaternion();
      if (L.bone.parent) L.bone.parent.getWorldQuaternion(parentQ);
      L.bone.quaternion.copy(parentQ.invert().multiply(_q.multiply(_q2)));
      e.applied.copy(L.bone.quaternion);
      st.set(L.bone, e);
      any = true; moved++;
    }
    dirty = any;
    if (!any) break;
  }
  model.root.updateMatrixWorld(true);
  // the last measurement is of the pose shown: the soft skin only adds the crater to it
  if (res && dirty) res = s.solve({ write: false, measure: true });
  s.measured = res ? { sig: s.signature().slice(), stats: res, found: s.pending } : null;
  const out = { moved, leftCm: res ? res.leftCm : 0 };
  // each corrected limb's turn (world space), to start from next frame
  const pd = new Map();
  for (const [bone, e] of st) {
    const parentQ = new THREE.Quaternion();
    if (bone.parent) bone.parent.getWorldQuaternion(parentQ);
    const wa = parentQ.clone().multiply(e.applied), wb = parentQ.clone().multiply(e.base);
    const qd = wa.multiply(wb.invert());
    if (Math.abs(qd.w) < 0.9999995) pd.set(bone, qd);
  }
  model._solidPrev = pd;
  model._solidMs = performance.now() - t0;
  model._solidLast = { sig: baseSig, map: new Map([...st].map(([b, e]) => [b, { base: e.base.clone(), applied: e.applied.clone() }])), out };
  return out;
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
    let raw = [];
    const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
    let meshes = [];
    for (const s of model.skinned) {
      if (!visibleChain(s) || !s.skeleton) continue;
      const g = s.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, na = g.attributes.normal;
      if (!si || !sw || !na || !g.attributes.position) continue;
      nm.getNormalMatrix(s.matrixWorld);
      const skinV = skinVertices(s);
      let used = false;
      for (let i = 0; i < si.count; i++) {
        if (skinV && !skinV[i]) continue;
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
    // thin pieces lying on the skin (a detail layer, an accessory, a second skin mesh over the
    // body) don't dent on their own: each vertex follows the skin vertex under it, so they
    // stay on the skin instead of jumping about
    const followers = findFollowers(raw, meshes);
    if (followers.size || raw.some((e) => e.drop)) raw = raw.filter((e) => !followers.has(e) && !e.drop);
    this.followerMeshes = [...new Set([...followers.keys()].map((e) => e.mesh))].map((m) => m.name);
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
    for (const [f, host] of followers) reps[host.w].members.push(f);
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
        const ai = abin(x, y);
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
        const ti = Math.floor(((a / pr.len) - PT0) / (PTS / 2)), ai = abin(x, y);
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
    this.tissue = new Float32Array(N);
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
      // how thick the soft tissue is there (sets how far a dent spreads before it's anchored)
      this.tissue[w] = this.flesh[w] * Math.min(1, 3 * k);
    });
    // per-bone settings (Ctrl+Shift+4): the measured values stay as the base
    this.soft0 = this.soft.slice();
    this.maxDepth0 = this.maxDepth.slice();
    this.widthMul = new Float32Array(N).fill(1);
    this.rimAdd = new Float32Array(N);
    this.paleMul = new Float32Array(N).fill(1);
    this.applyOverrides();
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
    // the skin area around each vertex (for the size of a contact patch)
    this.varea = new Float32Array(N);
    for (let i = 0; i < N; i++) { let m = 0, c = 0; for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) { m += this.adjLen[k]; c++; } const e = c ? m / c : this.edge; this.varea[i] = 0.866 * e * e; }
    // triangles (for the dent's shading)
    Object.assign(this, weldedTriangles(meshes, (m) => maps.get(m), N));
    // vertices of each part (for the near-part test)
    this.byPart = parts.map(() => []);
    for (let w = 0; w < N; w++) this.byPart[this.part[w]].push(w);
    this.byPart = this.byPart.map((l) => Int32Array.from(l));
    // ---- fingers as fitted capsules too: a fingertip pressed into coarse skin can land
    // between its vertices, so the skin under it is found from the capsule
    const fv = new Map();
    for (const e of raw) { if (!fv.has(e.bone)) fv.set(e.bone, []); fv.get(e.bone).push(new THREE.Vector3(e.x, e.y, e.z)); }
    try { this.fingerCaps = fingerCapsules(model, fv); } catch { this.fingerCaps = []; }
    const handG = (side) => { const b = rig.map[side + 'Hand']; return b && pIndex.has(b) ? this.partGroup[pIndex.get(b)] : -1; };
    this.fingerGroup = this.fingerCaps.map((f) => { let p = f.a; while (p && !canon.has(p)) p = p.parent; return p && pIndex.has(p) ? this.partGroup[pIndex.get(p)] : handG('right'); });
    this.fingerPart = this.fingerCaps.map((f) => { let p = f.a; while (p && !canon.has(p)) p = p.parent; return p && pIndex.has(p) ? pIndex.get(p) : -1; });
    // for contact the capsule has to hold the whole finger, not its middle: radius from 90%
    // of the finger's skin (the fitted one is the median, so half the finger stuck out of it)
    this.fingerR = this.fingerCaps.map((f) => {
      const A = new THREE.Vector3().setFromMatrixPosition(f.a.matrixWorld), B = new THREE.Vector3();
      if (f.b) B.setFromMatrixPosition(f.b.matrixWorld); else B.copy(f.tip).applyMatrix4(f.a.matrixWorld);
      const L = A.distanceTo(B) || 1e-6;
      if (f.off) { const q = new THREE.Quaternion(); f.a.getWorldQuaternion(q); const o = f.off.clone().applyQuaternion(q).multiplyScalar(L); A.add(o); B.add(o); }
      const ab = B.clone().sub(A), l2 = ab.lengthSq() || 1e-12, ds = [];
      for (const p of fv.get(f.a) || []) { let t = p.clone().sub(A).dot(ab) / l2; t = Math.max(0, Math.min(1, t)); ds.push(p.distanceTo(A.clone().addScaledVector(ab, t))); }
      if (ds.length < 6) return f.ratio;
      ds.sort((a, b) => a - b);
      return Math.max(f.ratio, Math.min(f.ratio * 1.8, ds[Math.floor(0.9 * (ds.length - 1))] / L));
    });
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
    this.press = new Float32Array(N);
    this.rp = new Float32Array(N); // radius of what pressed each vertex (for the contact size)
    this.tint = new Float32Array(N * 3);
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
    s.push(this.model.softSkinSoftness ?? 1, this.model.indentVersion || 0);
    return s;
  }

  update({ write = true, force = false, dt = 0 } = {}) {
    if ((this.model.indentVersion || 0) !== this._ov) this.applyOverrides();
    this.dt = dt;
    if (write) {
      const sig = this.signature();
      let same = !force && !!this.sig && sig.length === this.sig.length;
      if (same) for (let i = 0; i < sig.length; i++) if (sig[i] !== this.sig[i]) { same = false; break; }
      this.sig = sig.slice();
      const m = this.measured;
      this.measured = null;
      if (!same && !force && m && m.sig.length === sig.length && m.sig.every((x, i) => x === sig[i])) {
        // the solid body just solved this exact pose: show that instead of solving again
        this.solves = (this.solves || 0) + 1;
        if (m.stats.active && m.found) this.finish(m.found.hard, m.found.soft, m.stats, true); else this.release();
        this.stats = m.stats;
        return m.stats;
      }
      if (same) {
        // the same pose: the skin may still be springing back
        if (this.settling) { this.settle(this.target || [], false); this.write(); }
        return this.stats;
      }
    }
    const st = this.solve({ write });
    this.solves = (this.solves || 0) + 1;
    if (write) this.stats = st;
    return st;
  }

  // measure: only what presses where and what goes through (no crater: the solid body
  // just needs to know what's still through)
  solve({ write = false, rest = false, measure = false } = {}) {
    this.pending = null;
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
    if (!pairs.length) { this.excess = []; if (write) this.release(); return stats; }
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
          const ai = abin(px, py);
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
    if (!nt) { this.excess = []; if (write) this.release(); return stats; }
    const touched = tbuf.subarray(0, nt);
    // 3. exact positions + normals of those vertices (shape keys and bones)
    this.skinFrame++;
    this.skin(touched);
    // 4. skin against skin: a vertex behind the other part's surface is inside it
    // (a flat spatial hash of this frame's vertices: nearest vertex of a part it may touch)
    const cell = Math.max(this.edge * 1.5, 1e-4);
    // (sized to this frame's vertices: clearing and summing a big table costs too)
    let T = 1024;
    while (T < nt * 2 && T < 1 << 15) T <<= 1;
    const MASK = T - 1;
    const hs = this.hashStart && this.hashStart.length === T + 1 ? this.hashStart : (this.hashStart = new Int32Array(T + 1));
    const hi = this.hashItems || (this.hashItems = new Int32Array(N));
    const hk = this.hashKey || (this.hashKey = new Int32Array(N));
    const Pp = this.P, Nn = this.Nr, grp = this.group;
    const lastNear = this.lastNear || (this.lastNear = new Int32Array(N).fill(-1));
    // keyed by cell and body part, so a lookup only meets the parts it may touch
    const hkey = (ix, iy, iz, g) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (g * 2654435761)) & MASK;
    hs.fill(0);
    for (const w of touched) { const k = hkey(Math.floor(Pp[w * 3] / cell), Math.floor(Pp[w * 3 + 1] / cell), Math.floor(Pp[w * 3 + 2] / cell), grp[w]); hk[w] = k; hs[k + 1]++; }
    for (let k = 0; k < T; k++) hs[k + 1] += hs[k];
    const fillAt = this.fillAt && this.fillAt.length === T ? this.fillAt : (this.fillAt = new Int32Array(T));
    fillAt.set(hs.subarray(0, T));
    for (const w of touched) hi[fillAt[hk[w]]++] = w;
    const soft = Math.min(2, Math.max(0.2, this.model.softSkinSoftness ?? 1));
    const hard = [];
    // what still goes through past both dent limits: where, how far, which way each side
    // would have to move to clear it (the solid body stops the limb there)
    const excess = (this.excess = []);
    // which vertices this solve has pushed so far (not the last solve's: that made every
    // other frame skip the fingertips, and the dent jumped back while still pressed)
    const hardTag = this.hardTag || (this.hardTag = new Uint32Array(N));
    const htag = (this.htag = (this.htag || 0) + 1);
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
      // start from last frame's match (it hardly moves): usually close enough to stop at once
      const ln = lastNear[w];
      if (ln >= 0 && this.stamp[ln] === this.frame && (mask & (1 << grp[ln]))) { best = (x - Pp[ln * 3]) ** 2 + (y - Pp[ln * 3 + 1]) ** 2 + (z - Pp[ln * 3 + 2]) ** 2; bu = ln; }
      // where in its cell the vertex sits: a neighbouring cell can't hold anything closer
      // than its wall, so cells farther than the best match so far are skipped
      const fx = x / cell - ix, fy = y / cell - iy, fz = z / cell - iz, c2 = cell * cell;
      for (let g = 0; g < 32 && best > good; g++) {
        if (!(mask & (1 << g))) continue;
        // own cell first, then the ring around it (stop once something is close enough)
        for (let r = 0; r < 27 && best > good; r++) {
          const o = RING[r];
          if (r) {
            const gx = o[0] > 0 ? 1 - fx : o[0] < 0 ? fx : 0, gy = o[1] > 0 ? 1 - fy : o[1] < 0 ? fy : 0, gz = o[2] > 0 ? 1 - fz : o[2] < 0 ? fz : 0;
            if ((gx * gx + gy * gy + gz * gz) * c2 >= best) continue;
          }
          const k = hkey(ix + o[0], iy + o[1], iz + o[2], g);
          for (let q = hs[k], e = hs[k + 1]; q < e; q++) {
            const u = hi[q];
            if (grp[u] !== g) continue;
            const d = (x - Pp[u * 3]) ** 2 + (y - Pp[u * 3 + 1]) ** 2 + (z - Pp[u * 3 + 2]) ** 2;
            if (d < best) { best = d; bu = u; }
          }
        }
      }
      lastNear[w] = bu;
      // (the hash can mix in vertices from far cells: those are no match)
      if (bu < 0 || best > cell * cell * 4) continue;
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
      // both give way until they push back equally hard; flesh stiffens as it's squeezed
      // (collagen straightening: the J-shaped curve) and locks at the bone
      const myCap = this.maxDepth[w] * soft, otherCap = this.maxDepth[bu] * soft;
      const push = Math.min(myCap, split(pen, this.soft[w], myCap, this.soft[bu], otherCap) + this.edge * 0.02);
      const left = Math.max(0, pen - myCap - otherCap);
      if (left > 0) excess.push({ x, y, z, left, g: gw, o: grp[bu], pa: this.part[w], po: this.part[bu], dx: mx, dy: my, dz: mz });
      if (!(hardTag[w] === htag && this.press[w] > (myCap > 0 ? push / myCap : 1))) this.press[w] = myCap > 0 ? Math.min(1, push / myCap) : 1;
      if (left > maxLeft) maxLeft = left;
      // into its own flesh, halfway between out of the other surface and in along its own
      // normal (a noisy normal on the other side can't slide the skin sideways)
      let bx = mx - nx, by = my - ny, bz = mz - nz;
      const bl = len3(bx, by, bz) || 1;
      bx /= bl; by /= bl; bz /= bl;
      // (unless this solve already pushed it further, as the other side of another contact)
      const hadW = hardTag[w] === htag ? len3(H[w * 3], H[w * 3 + 1], H[w * 3 + 2]) : 0;
      if (push >= hadW) { H[w * 3] = bx * push; H[w * 3 + 1] = by * push; H[w * 3 + 2] = bz * push; this.rp[w] = this.typical[this.part[bu]] || this.edge; }
      // ...and the other side takes its share of this same overlap: a finger sunk into the
      // skin between the skin's vertices pushes the skin under it too, not only itself (with
      // only its own small share it stayed mostly inside)
      const other = Math.min(otherCap, Math.max(0, pen - push));
      if (other > 0 && !rest) {
        const hadU = hardTag[bu] === htag ? len3(H[bu * 3], H[bu * 3 + 1], H[bu * 3 + 2]) : 0;
        if (other > hadU) {
          H[bu * 3] = -mx * other; H[bu * 3 + 1] = -my * other; H[bu * 3 + 2] = -mz * other;
          this.rp[bu] = this.typical[this.part[w]] || this.edge;
          this.press[bu] = otherCap > 0 ? Math.min(1, other / otherCap) : 1;
          if (hardTag[bu] !== htag) { hardTag[bu] = htag; hard.push(bu); }
        }
      }
      this.left[w] = left;
      if (hardTag[w] !== htag) { hardTag[w] = htag; hard.push(w); }
      const ck = gw < grp[bu] ? gw * 32 + grp[bu] : grp[bu] * 32 + gw;
      if (pen > contact[ck]) contact[ck] = pen;
      if (left > contactLeft[ck]) contactLeft[ck] = left;
    }
    // 4b. fingers as capsules: every skin vertex under a finger's length and width is pushed
    // down to the capsule's surface (a finger lying flat on the skin dents a groove along
    // it, not just one spot), even where it falls between the vertices of coarse skin
    this.probes = [];
    if (!rest) {
      const fc = this.fingerCaps;
      const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _q = new THREE.Quaternion();
      for (let fi = 0; fi < fc.length; fi++) {
        const f = fc[fi], gF = this.fingerGroup[fi];
        if (gF < 0) continue;
        f.a.updateWorldMatrix(true, false);
        _a.setFromMatrixPosition(f.a.matrixWorld);
        if (f.b) { f.b.updateWorldMatrix(true, false); _b.setFromMatrixPosition(f.b.matrixWorld); } else _b.copy(f.tip).applyMatrix4(f.a.matrixWorld);
        const L = _a.distanceTo(_b);
        if (f.off) { f.a.getWorldQuaternion(_q); const o = f.off.clone().applyQuaternion(_q).multiplyScalar(L); _a.add(o); _b.add(o); }
        const r = (this.fingerR ? this.fingerR[fi] : f.ratio) * L, bit = 1 << gF;
        // only the parts this hand is near this frame
        let partners = 0;
        for (const [pa, pb] of pairs) { const ga = this.partGroup[pa], gb = this.partGroup[pb]; if (ga === gF) partners |= 1 << gb; else if (gb === gF) partners |= 1 << ga; }
        if (!partners) continue;
        const abx = _b.x - _a.x, aby = _b.y - _a.y, abz = _b.z - _a.z, l2 = abx * abx + aby * aby + abz * abz || 1e-12;
        let best = 0, bw = -1;
        const thresh = Math.max(0.0005, this.edge * 0.03);
        // skin around the finger segment, from the spatial hash (cells of the parts it may touch)
        const pad = r + this.edge;
        const x0 = Math.floor((Math.min(_a.x, _b.x) - pad) / cell), x1 = Math.floor((Math.max(_a.x, _b.x) + pad) / cell);
        const y0 = Math.floor((Math.min(_a.y, _b.y) - pad) / cell), y1 = Math.floor((Math.max(_a.y, _b.y) + pad) / cell);
        const z0 = Math.floor((Math.min(_a.z, _b.z) - pad) / cell), z1 = Math.floor((Math.max(_a.z, _b.z) + pad) / cell);
        for (let g = 0; g < 32; g++) {
          if (!(partners & (1 << g))) continue;
          for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) for (let iz = z0; iz <= z1; iz++) {
            const hk2 = hkey(ix, iy, iz, g);
            for (let q = hs[hk2], e = hs[hk2 + 1]; q < e; q++) {
          const w = hi[q];
          if (grp[w] !== g || !(cand[w] & bit)) continue;
          const x = Pp[w * 3], y = Pp[w * 3 + 1], z = Pp[w * 3 + 2];
          let t = ((x - _a.x) * abx + (y - _a.y) * aby + (z - _a.z) * abz) / l2;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const px = _a.x + t * abx - x, py = _a.y + t * aby - y, pz = _a.z + t * abz - z;
          // how far the finger's axis is above the skin there (along the skin's normal), and to the side
          const sN = px * Nn[w * 3] + py * Nn[w * 3 + 1] + pz * Nn[w * 3 + 2];
          const d2 = px * px + py * py + pz * pz, side2 = d2 - sN * sN;
          if (side2 > (r + this.edge) * (r + this.edge)) continue;
          // the finger has to be at this skin, not somewhere along its normal far away
          const reach = r + this.maxDepth[w] * soft + this.edge;
          if (d2 > reach * reach) continue;
          // the finger's lower surface above this vertex (along its normal), over its width
          const side = side2 < r * r ? Math.sqrt(r * r - side2) : 0;
          const pen = side - sN - this.restPen[w];
          if (pen > best) { best = pen; bw = w; }
          if (pen <= thresh || side2 >= r * r) continue;
          const capW = this.maxDepth[w] * soft;
          const pushW = split(pen, this.soft[w], capW, 0.25, r * 0.15);
          const had = hardTag[w] === htag ? len3(H[w * 3], H[w * 3 + 1], H[w * 3 + 2]) : 0;
          if (pushW > had) {
            H[w * 3] = -Nn[w * 3] * pushW; H[w * 3 + 1] = -Nn[w * 3 + 1] * pushW; H[w * 3 + 2] = -Nn[w * 3 + 2] * pushW;
            this.rp[w] = r;
            if (hardTag[w] !== htag) { hardTag[w] = htag; hard.push(w); }
            this.press[w] = capW > 0 ? Math.min(1, pushW / capW) : 1;
          }
          const leftW = Math.max(0, pen - capW - r * 0.15);
          if (leftW > 0) {
            excess.push({ x, y, z, left: leftW, g: gF, o: grp[w], pa: this.fingerPart[fi], po: this.part[w], dx: Nn[w * 3], dy: Nn[w * 3 + 1], dz: Nn[w * 3 + 2] });
            if (leftW > maxLeft) maxLeft = leftW;
          }
            }
          }
        }
        if (bw < 0 || best <= thresh) continue;
        const cap = this.maxDepth[bw] * soft;
        const push = split(best, this.soft[bw], cap, 0.25, r * 0.15);
        const prev = hardTag[bw] === htag ? len3(H[bw * 3], H[bw * 3 + 1], H[bw * 3 + 2]) : 0;
        if (push > prev) {
          H[bw * 3] = -Nn[bw * 3] * push; H[bw * 3 + 1] = -Nn[bw * 3 + 1] * push; H[bw * 3 + 2] = -Nn[bw * 3 + 2] * push;
          this.rp[bw] = r;
          if (hardTag[bw] !== htag) { hardTag[bw] = htag; hard.push(bw); }
          this.press[bw] = cap > 0 ? Math.min(1, push / cap) : 1;
        }
        const left = Math.max(0, best - cap - r * 0.15);
        if (left > maxLeft) maxLeft = left;
        // a rounded fingertip of radius r sunk this deep touches over this radius
        this.probes.push({ w: bw, a: Math.max(r * 0.6, Math.sqrt(2 * r * best)), depth: push, rho: r });
        const ck = gF < grp[bw] ? gF * 32 + grp[bw] : grp[bw] * 32 + gF;
        if (best > contact[ck]) contact[ck] = best;
        if (left > contactLeft[ck]) contactLeft[ck] = left;
      }
    }
    if (rest) { if (write) this.clear(); return stats; }
    if (!hard.length) { if (write) this.release(); return stats; }
    stats.active = true;
    stats.leftCm = +(maxLeft * 100).toFixed(2);
    for (let k = 0; k < contact.length; k++) if (contact[k] > 0) stats.contacts.push({ a: this.groups[(k / 32) | 0], b: this.groups[k % 32], cm: +(contact[k] * 100).toFixed(1), leftCm: +(contactLeft[k] * 100).toFixed(1) });
    if (measure) { this.pending = { hard, soft }; return stats; }
    return this.finish(hard, soft, stats, write);
  }

  // 5. the dent fades over the surface, with a slight bulge around it (from what the contact
  // test found: this solve's, or the solid body's last measurement of this same pose)
  finish(hard, soft, stats, write) {
    const D = this.spread(hard, soft);
    let maxD = 0;
    for (const w of this.spreadSet) maxD = Math.max(maxD, len3(D[w * 3], D[w * 3 + 1], D[w * 3 + 2]));
    stats.dentCm = +(maxD * 100).toFixed(2);
    if (write) { this.target = this.spreadSet; this.settle(this.spreadSet, true); this.write(); }
    return stats;
  }

  // nothing presses any more: the skin springs back (at once when not easing in time)
  release() {
    this.target = [];
    if (!this.active && !this.settling) return;
    if (!(this.dt > 0)) { this.clear(); return; }
    this.settle([], false);
    this.write();
  }

  // the shown offsets follow this solve's offsets (D over the set) in time
  settle(set, solved) {
    const N = this.N, D = this.D, TI = this.tint;
    const S = this.S || (this.S = new Float32Array(N * 3)), ST = this.ST || (this.ST = new Float32Array(N * 3));
    const inSet = this.inSet || (this.inSet = new Uint32Array(N));
    const tag = (this.setTag = (this.setTag || 0) + 1);
    for (const w of set) inSet[w] = tag;
    const dt = this.dt > 0 ? this.dt : 0;
    const aIn = dt ? 1 - Math.exp(-dt / SETTLE_IN) : 1, aOut = dt ? 1 - Math.exp(-dt / SETTLE_OUT) : 1;
    const hardNow = solved && this.isHard ? this.hardStamp : -1;
    const old = this.shown || [];
    const list = [];
    const mark = this.shownMark || (this.shownMark = new Uint32Array(N));
    let moving = false;
    const step = (w) => {
      if (mark[w] === tag) return;
      mark[w] = tag;
      const on = inSet[w] === tag;
      const tx = on ? D[w * 3] : 0, ty = on ? D[w * 3 + 1] : 0, tz = on ? D[w * 3 + 2] : 0;
      const sx = S[w * 3], sy = S[w * 3 + 1], sz = S[w * 3 + 2];
      const deeper = tx * tx + ty * ty + tz * tz > sx * sx + sy * sy + sz * sz;
      // pressed skin keeps up with the press; the rest eases (in fast, out slower)
      const a = deeper && this.isHard && this.isHard[w] === hardNow ? 1 : deeper ? aIn : aOut;
      S[w * 3] = sx + (tx - sx) * a; S[w * 3 + 1] = sy + (ty - sy) * a; S[w * 3 + 2] = sz + (tz - sz) * a;
      for (let c = 0; c < 3; c++) { const t = on ? TI[w * 3 + c] : 0; ST[w * 3 + c] += (t - ST[w * 3 + c]) * (t > ST[w * 3 + c] ? aIn : aOut); }
      const rx = tx - S[w * 3], ry = ty - S[w * 3 + 1], rz = tz - S[w * 3 + 2];
      // within a fiftieth of a millimetre: there
      if (rx * rx + ry * ry + rz * rz > 4e-10) moving = true; else { S[w * 3] = tx; S[w * 3 + 1] = ty; S[w * 3 + 2] = tz; }
      if (on || S[w * 3] || S[w * 3 + 1] || S[w * 3 + 2]) {
        if (!on && Math.abs(S[w * 3]) + Math.abs(S[w * 3 + 1]) + Math.abs(S[w * 3 + 2]) < 2e-6) { S[w * 3] = S[w * 3 + 1] = S[w * 3 + 2] = 0; ST[w * 3] = ST[w * 3 + 1] = ST[w * 3 + 2] = 0; return; }
        list.push(w);
      }
    };
    for (const w of set) step(w);
    for (const w of old) step(w);
    // the positions of everything shown (and its triangles' corners) for the shading
    if (!solved) this.skinFrame++;
    const need = [];
    for (const w of list) {
      if (this.skinned[w] !== this.skinFrame) { this.skinned[w] = this.skinFrame; need.push(w); }
      for (let k = this.triStart[w]; k < this.triStart[w + 1]; k++) { const t = this.triOf[k] * 3; for (let c = 0; c < 3; c++) { const u = this.tris[t + c]; if (this.skinned[u] !== this.skinFrame) { this.skinned[u] = this.skinFrame; need.push(u); } } }
    }
    for (const u of need) this.skinned[u] = 0;
    if (need.length) this.skin(need);
    // corners outside what's shown stay where they are
    for (const u of need) if (mark[u] !== tag || !(S[u * 3] || S[u * 3 + 1] || S[u * 3 + 2])) { if (mark[u] !== tag) { S[u * 3] = S[u * 3 + 1] = S[u * 3 + 2] = 0; } }
    if (moving && list.length) {
      this.foldStamps = this.foldStamps || { a: new Uint32Array(this.tris.length / 3 + 1) };
      unfold(list, this.tris, this.triStart, this.triOf, this.P, S, this.foldStamps, 2);
      // pressed skin stays with the press
      for (const w of set) if (this.isHard[w] === hardNow) { const d = D[w * 3] * D[w * 3] + D[w * 3 + 1] * D[w * 3 + 1] + D[w * 3 + 2] * D[w * 3 + 2], e = S[w * 3] * S[w * 3] + S[w * 3 + 1] * S[w * 3 + 1] + S[w * 3 + 2] * S[w * 3 + 2]; if (d > e) { S[w * 3] = D[w * 3]; S[w * 3 + 1] = D[w * 3 + 1]; S[w * 3 + 2] = D[w * 3 + 2]; } }
    }
    this.shown = list;
    this.settling = moving;
  }

  // how far part k's skin reaches from its bone toward a world point (its shape profile)
  reachToward(k, pt) {
    const pr = this.profiles[k];
    const e = _m.copy(this.parts[k].matrixWorld).invert().elements;
    const x = pt.x, y = pt.y, z = pt.z;
    const lx = e[0] * x + e[4] * y + e[8] * z + e[12], ly = e[1] * x + e[5] * y + e[9] * z + e[13], lz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const al = lx * pr.u.x + ly * pr.u.y + lz * pr.u.z, px = lx * pr.e1.x + ly * pr.e1.y + lz * pr.e1.z, py = lx * pr.e2.x + ly * pr.e2.y + lz * pr.e2.z;
    const ti = Math.min(PT - 1, Math.max(0, Math.floor((al / pr.len - PT0) / PTS)));
    const ai = abin(px, py);
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

  // The dent like real skin (a membrane over incompressible tissue, the "waterbed" /
  // trampoline): the skin around a press is pulled down with it into a wide sloped crater
  // (Hertz contact: the edge of the real contact sits at half the depth, ~20% of it two
  // contact radii out, the real contact narrower than the overlap), anchored by the tissue
  // underneath (thin tissue over bone: a short crater; a belly: a wide one). Squeezed flesh
  // only rises in a rim where a wide contact presses thin tissue against bone. Pressed skin
  // goes pale (blood pushed out), with a faint flush around it.
  spread(hard, soft) {
    const N = this.N, H = this.H, D = this.D, TI = this.tint;
    const key = this.key || (this.key = new Float32Array(N)), src = this.src || (this.src = new Int32Array(N)), dist = this.dist || (this.dist = new Float32Array(N));
    const seen = this.seen || (this.seen = new Uint32Array(N));
    const isHard = this.isHard || (this.isHard = new Uint32Array(N));
    const clOf = this.clOf || (this.clOf = new Int32Array(N));
    const heap = this.heap || (this.heap = new Heap(N));
    heap.clear();
    for (const w of this.spreadSet || []) { D[w * 3] = D[w * 3 + 1] = D[w * 3 + 2] = 0; TI[w * 3] = TI[w * 3 + 1] = TI[w * 3 + 2] = 0; }
    const stamp = ++this.frame;
    this.hardStamp = stamp;
    for (const w of hard) isHard[w] = stamp;
    // 1. contact patches: connected pushed vertices of one part -> size, depth, direction
    const as = this.adjStart, adj = this.adj, len = this.adjLen;
    const cls = [];
    const queue = [];
    for (const w0 of hard) {
      if (seen[w0] === stamp) continue;
      const c = { area: 0, depth: 0, dx: 0, dy: 0, dz: 0, T: 0, press: 0 };
      const id = cls.length;
      cls.push(c);
      queue.length = 0; queue.push(w0); seen[w0] = stamp;
      while (queue.length) {
        const w = queue.pop();
        clOf[w] = id;
        c.area += this.varea[w];
        const hl = len3(H[w * 3], H[w * 3 + 1], H[w * 3 + 2]);
        if (hl > c.depth) { c.depth = hl; c.dx = H[w * 3] / hl; c.dy = H[w * 3 + 1] / hl; c.dz = H[w * 3 + 2] / hl; c.T = this.tissue[w]; c.wv = w; c.rp = this.rp[w]; }
        if (this.press[w] > c.press) c.press = this.press[w];
        for (let k = as[w]; k < as[w + 1]; k++) { const u = adj[k]; if (isHard[u] === stamp && seen[u] !== stamp && this.group[u] === this.group[w]) { seen[u] = stamp; queue.push(u); } }
      }
      // a round thing of radius R pressed in this deep touches at least over sqrt(R depth)
      // (Hertz), however few vertices happen to be inside it: no needle-sharp pits
      c.aGeo = Math.max(this.edge * 0.5, Math.sqrt(c.area / Math.PI), Math.sqrt((c.rp || 0) * c.depth));
      // a fingertip pressing between vertices: the patch is centred on it, shaped like it
      for (const p of this.probes || []) if (clOf[p.w] === id && seen[p.w] === stamp && p.a > c.aGeo) { c.aGeo = p.a; c.depth = Math.max(c.depth, p.depth); c.center = true; c.rho = p.rho; }
      c.aH = c.aGeo / Math.SQRT2;
      const wm = c.wv !== undefined ? this.widthMul[c.wv] : 1;
      c.Lt = Math.max(this.edge, 1.3 * c.T * soft * wm);
      c.reach = Math.min(5.5 * c.aH * soft * wm, 2 * c.Lt) + c.aGeo;
      // a rim only where a wide contact squeezes thin tissue against the bone (or where set)
      c.bulge = 0.25 * Math.min(1, Math.max(0, (c.aH / Math.max(1e-6, c.T) - 0.4) / 0.8)) + (c.wv !== undefined ? 0.35 * this.rimAdd[c.wv] : 0);
    }
    // 2. distance over the skin from each patch (the nearest patch wins)
    const set = [];
    const stamp2 = ++this.frame;
    const visit = (w) => { if (seen[w] !== stamp2) { seen[w] = stamp2; key[w] = Infinity; src[w] = -1; set.push(w); } };
    const sd = this.sd || (this.sd = new Float32Array(N));
    for (const w of hard) { visit(w); key[w] = 0; src[w] = clOf[w]; sd[w] = len3(H[w * 3], H[w * 3 + 1], H[w * 3 + 2]); heap.push(w, 0); }
    while (heap.size) {
      const i = heap.pop();
      const ki = key[i], c = cls[src[i]];
      if (ki > (c.center ? c.reach : c.reach - c.aGeo)) continue;
      for (let k = as[i]; k < as[i + 1]; k++) {
        const j = adj[k];
        if (isHard[j] === stamp) continue;
        visit(j);
        const d = ki + len[k];
        if (d < key[j]) { key[j] = d; src[j] = src[i]; sd[j] = sd[i]; heap.push(j, d); }
      }
    }
    // 3. the crater (every vertex of it needs its current normal)
    const fresh = [];
    for (const w of set) if (this.skinned[w] !== this.skinFrame) fresh.push(w);
    if (fresh.length) this.skin(fresh);
    for (const w of set) {
      const ci = src[w];
      if (ci < 0) continue;
      const c = cls[ci];
      const hard_ = isHard[w] === stamp;
      const hl = hard_ ? len3(H[w * 3], H[w * 3 + 1], H[w * 3 + 2]) : 0;
      // how far from the middle of the contact (a pushed vertex: from how deep it's pushed;
      // around a fingertip, straight from it)
      const r = c.center ? key[w] : hard_ ? c.aGeo * Math.sqrt(Math.max(0, 1 - hl / Math.max(1e-9, c.depth))) : c.aGeo + key[w];
      // inside the contact the skin takes the fingertip's round shape; outside, the crater
      // (around a finger: from how deep the nearest pressed vertex went, so a groove along a
      // finger lying on the skin is as deep as the finger there, never deeper)
      const d0 = c.center ? Math.min(c.depth, sd[w] || c.depth) : c.depth;
      const crater = c.center && hard_ ? hl : r <= c.aH ? (c.center ? Math.max(d0 * 0.5, d0 - (r * r) / (2 * c.rho)) : hard_ ? hl : c.depth * 0.5) : d0 * hertzOut(r / c.aH) * Math.exp(-(r - c.aH) / c.Lt);
      let ux, uy, uz;
      if (hard_ && hl >= crater) { ux = H[w * 3]; uy = H[w * 3 + 1]; uz = H[w * 3 + 2]; } else {
        // the press's direction, turned toward this spot's own inward normal (on a curved
        // body the crater sinks in instead of sliding along the surface)
        let ex = c.dx - this.Nr[w * 3], ey = c.dy - this.Nr[w * 3 + 1], ez = c.dz - this.Nr[w * 3 + 2];
        const el = len3(ex, ey, ez);
        if (el > 1e-6) { ex /= el; ey /= el; ez /= el; } else { ex = c.dx; ey = c.dy; ez = c.dz; }
        ux = ex * crater; uy = ey * crater; uz = ez * crater;
      }
      // never deeper than this spot's own flesh (the bone under it stops it)
      const lim = this.maxDepth[w] * soft, ul = len3(ux, uy, uz);
      if (ul > lim && ul > 0) { const f = lim / ul; ux *= f; uy *= f; uz *= f; }
      // fade out at the crater's edge
      const edgeF = 1 - smoothstep(0.75, 1, (r - c.aGeo) / Math.max(1e-6, c.reach - c.aGeo));
      // (the reach counts from the patch's edge, or from the fingertip's middle)
      ux *= edgeF; uy *= edgeF; uz *= edgeF;
      D[w * 3] = ux; D[w * 3 + 1] = uy; D[w * 3 + 2] = uz;
      // squeezed rim (along the skin's own normal) where tissue is thin under a wide contact
      const xr = (r - c.aH) / Math.max(this.edge, 0.6 * c.T);
      if (!hard_ && c.bulge > 0 && xr > 0) {
        const b = c.bulge * c.depth * xr * Math.exp(1 - xr) * edgeF;
        const has = this.skinned[w] === this.skinFrame;
        D[w * 3] += (has ? this.Nr[w * 3] : -c.dx) * b; D[w * 3 + 1] += (has ? this.Nr[w * 3 + 1] : -c.dy) * b; D[w * 3 + 2] += (has ? this.Nr[w * 3 + 2] : -c.dz) * b;
      }
      // pale where pressed, a faint flush just around it
      TI[w * 3] = this.paleMul[w] * c.press * (hard_ ? Math.max(0.35, this.press[w]) : Math.min(1, crater / Math.max(1e-9, c.depth)) * 0.6) * edgeF;
      const xf = (r - c.aGeo) / Math.max(this.edge, c.aGeo);
      TI[w * 3 + 1] = hard_ ? 0 : 0.5 * c.press * Math.max(0, xf) * Math.exp(1 - Math.max(0, xf)) * edgeF;
    }
    // 4. the membrane settles: a few smoothing passes over the free skin (no seams where craters meet)
    const D2 = this.D2 || (this.D2 = new Float32Array(N * 3));
    for (let it = 0; it < 3; it++) {
      for (const w of set) { D2[w * 3] = D[w * 3]; D2[w * 3 + 1] = D[w * 3 + 1]; D2[w * 3 + 2] = D[w * 3 + 2]; }
      for (const w of set) {
        if (isHard[w] === stamp || src[w] < 0) continue;
        let sx = 0, sy = 0, sz = 0, n = 0;
        for (let k = as[w]; k < as[w + 1]; k++) { const u = adj[k]; if (seen[u] !== stamp2) continue; sx += D2[u * 3]; sy += D2[u * 3 + 1]; sz += D2[u * 3 + 2]; n++; }
        if (!n) continue;
        D[w * 3] = 0.5 * D2[w * 3] + (0.5 * sx) / n; D[w * 3 + 1] = 0.5 * D2[w * 3 + 1] + (0.5 * sy) / n; D[w * 3 + 2] = 0.5 * D2[w * 3 + 2] + (0.5 * sz) / n;
      }
    }
    // 5. never folding through itself: every corner of the triangles around the dent gets
    // its real position, and triangles that would flip are eased back
    const need = [];
    for (const w of set) for (let k = this.triStart[w]; k < this.triStart[w + 1]; k++) { const t = this.triOf[k] * 3; for (let c = 0; c < 3; c++) { const u = this.tris[t + c]; if (this.skinned[u] !== this.skinFrame) { this.skinned[u] = this.skinFrame; need.push(u); } } }
    for (const u of need) this.skinned[u] = 0;
    if (need.length) this.skin(need);
    for (const u of need) if (seen[u] !== stamp2) { D[u * 3] = D[u * 3 + 1] = D[u * 3 + 2] = 0; }
    this.foldStamps = this.foldStamps || { a: new Uint32Array(this.tris.length / 3 + 1) };
    this.folds = unfold(set, this.tris, this.triStart, this.triOf, this.P, D, this.foldStamps);
    this.clusters = cls;
    this.spreadSet = set;
    return D;
  }

  // world offsets -> each mesh's local space -> the GPU (summed with the soft lips)
  write() {
    if (!this.prepared) { for (const m of this.meshes) prepareMesh(m); this.prepared = true; }
    const set = this.shown || [];
    // the bent normals (every corner of the triangles around what's shown was skinned)
    normalDeltas(set, this.tris, this.triStart, this.triOf, this.P, this.S, this.ND);
    const inv = this.meshes.map((m) => new THREE.Matrix3().setFromMatrix4(m.matrixWorld).invert());
    const rinv = this.meshes.map((m) => new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(m.matrixWorld)).invert());
    const ls = this.meshes.map((m) => (m.geometry.attributes[ATTR] ? layer(m, 'skin') : null));
    const ln = this.meshes.map((m) => (m.geometry.attributes[ATTR] ? layer(m, 'skin', 'nor') : null));
    const lt = this.meshes.map((m) => (m.geometry.attributes[ATTR] ? layer(m, 'skin', 'tint') : null));
    for (const l of ls) if (l) beginLayer(l);
    for (const l of ln) if (l) beginLayer(l);
    for (const l of lt) if (l) beginLayer(l);
    const TI = this.ST;
    const D = this.S, ND = this.ND, Nr = this.Nr, v = new THREE.Vector3();
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
        if (TI[w * 3] || TI[w * 3 + 1]) setOffset(lt[m], this.memIdx[k], TI[w * 3], TI[w * 3 + 1], 0);
      }
    }
    for (const m of this.meshes) commit(m);
    this.active = set.length > 0;
  }

  // the per-bone indent settings (model.indent[bone uuid] = { give, depth, width, rim, pale,
  // rigid, children }) -> per-vertex values; a bone's setting covers the vertices it moves
  // most, and its child bones' unless they have their own (or children is off)
  applyOverrides() {
    const ov = this.model.indent || {};
    this._ov = this.model.indentVersion || 0;
    const byBone = new Map();
    // a setting reaches down through helper bones (twist, breast, skirt...) but stops at the
    // next main body bone, which is its own region
    const canon = this.model.humanoid ? this.model.humanoid.canonOf : new Map();
    const lookup = (b) => {
      if (byBone.has(b)) return byBone.get(b);
      let found = null;
      for (let p = b, first = true; p; p = p.parent, first = false) {
        const o = ov[p.uuid];
        if (o && (first || o.children !== false)) { found = o; break; }
        if (!p.isBone || (canon.has(p) && !ov[p.uuid])) { if (!first || canon.has(p)) break; }
      }
      byBone.set(b, found);
      return found;
    };
    for (let w = 0; w < this.N; w++) {
      const o = lookup(this.dBones[this.dbone[w]]);
      const rigid = o && o.rigid;
      this.soft[w] = rigid ? 1e-4 : this.soft0[w] * (o ? Math.max(0.01, o.give ?? 1) : 1);
      this.maxDepth[w] = rigid ? 0 : this.maxDepth0[w] * (o ? Math.max(0, o.depth ?? 1) : 1);
      this.widthMul[w] = o ? Math.max(0.1, o.width ?? 1) : 1;
      this.rimAdd[w] = o ? Math.max(0, o.rim ?? 0) : 0;
      this.paleMul[w] = o ? Math.max(0, o.pale ?? 1) : 1;
    }
  }

  // skin vertices a bone moves most (and its children's, unless they have their own setting)
  // -> { count, fleshCm (deepest flesh over the bone), dentCm (how deep it can dent) }
  boneInfo(bone, children = true) {
    let count = 0, flesh = 0, dent = 0;
    const canon = this.model.humanoid ? this.model.humanoid.canonOf : new Map();
    const under = (b) => { for (let p = b; p; p = p.parent) { if (p === bone) return true; if (!children || !p.isBone || canon.has(p)) return false; } return false; };
    const memo = new Map();
    for (let w = 0; w < this.N; w++) {
      const b = this.dBones[this.dbone[w]];
      let u = memo.get(b);
      if (u === undefined) memo.set(b, (u = b === bone || under(b)));
      if (!u) continue;
      count += this.memStart[w + 1] - this.memStart[w];
      flesh = Math.max(flesh, this.tissue[w]);
      dent = Math.max(dent, this.maxDepth[w] * Math.min(2, Math.max(0.2, this.model.softSkinSoftness ?? 1)));
    }
    return { count, fleshCm: +(flesh * 100).toFixed(1), dentCm: +(dent * 100).toFixed(1) };
  }

  // was this vertex in contact (pushed by the other part) in the last solve?
  pushed(w) { return !!this.isHard && this.isHard[w] === this.hardStamp; }

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
    if (this.S && this.shown) for (const w of this.shown) { this.S[w * 3] = this.S[w * 3 + 1] = this.S[w * 3 + 2] = 0; this.ST[w * 3] = this.ST[w * 3 + 1] = this.ST[w * 3 + 2] = 0; }
    this.shown = [];
    this.settling = false;
    if (!this.active) return;
    this.active = false;
    for (const m of this.meshes) {
      if (!m.geometry.attributes[ATTR]) continue;
      beginLayer(layer(m, 'skin'));
      beginLayer(layer(m, 'skin', 'nor'));
      beginLayer(layer(m, 'skin', 'tint'));
      commit(m);
    }
  }
}

// ---------------------------------------------------------------- contact mechanics
// surface outside a rounded press on soft tissue (Hertz contact on an elastic half-space),
// as a share of the depth at the middle; rho = distance / contact radius (>= 1): 0.5 at the
// edge of the contact, ~0.22 at twice the radius, ~0.14 at three times
export { notSkinMaterial };
export function hertzOut(rho) {
  if (rho <= 1) return 0.5;
  return ((2 - rho * rho) * Math.asin(1 / rho) + Math.sqrt(rho * rho - 1)) / Math.PI;
}
function smoothstep(a, b, x) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

// how a squeeze of depth pen is shared: each side pushes back harder the more it's
// squeezed and locks at its bone (force ~ u / (soft (1 - u / cap))); -> this side's share
export function split(pen, sA, cA, sB, cB) {
  if (!(cA > 0)) return 0;
  if (!(cB > 0)) return Math.min(pen, cA);
  if (pen >= cA + cB) return cA;
  const F = (u, sf, c) => u / (sf * Math.max(1e-6, 1 - u / c));
  let lo = Math.max(0, pen - cB * 0.9999), hi = Math.min(pen, cA * 0.9999);
  for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (F(m, sA, cA) > F(pen - m, sB, cB)) hi = m; else lo = m; }
  return (lo + hi) / 2;
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

// which vertices of a mesh belong to skin triangles (by material) -> Uint8Array, or null (all)
function skinVertices(mesh) {
  const mats = [].concat(mesh.material);
  const bad = mats.map((m) => !!m && notSkinMaterial(m.name));
  if (!bad.some(Boolean)) return null;
  const g = mesh.geometry, ix = g.index, cnt = ix ? ix.count : g.attributes.position.count;
  const out = new Uint8Array(g.attributes.position.count);
  const groups = g.groups.length ? g.groups : [{ start: 0, count: cnt, materialIndex: 0 }];
  for (const gr of groups) {
    if (bad[gr.materialIndex] ?? bad[0]) continue;
    for (let k = gr.start, e = Math.min(cnt, gr.start + gr.count); k < e; k++) out[ix ? ix.getX(k) : k] = 1;
  }
  return out;
}

// skin meshes that lie within ~1.5 cm over a bigger skin mesh (rest pose) -> Map(entry ->
// host entry): each of their vertices follows its nearest vertex on the bigger mesh
function findFollowers(raw, meshes) {
  const out = new Map();
  if (meshes.length < 2) return out;
  const byMesh = new Map(meshes.map((m) => [m, []]));
  for (const e of raw) byMesh.get(e.mesh).push(e);
  const cell = 0.01;
  const hash = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (const e of raw) { const k = key(e.x, e.y, e.z); let l = hash.get(k); if (!l) hash.set(k, (l = [])); l.push(e); }
  const nearestOn = (e, ok) => {
    let best = Infinity, b = null;
    const ix = Math.floor(e.x / cell), iy = Math.floor(e.y / cell), iz = Math.floor(e.z / cell);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) {
      for (const q of hash.get(`${ix + dx},${iy + dy},${iz + dz}`) || []) {
        if (!ok(q)) continue;
        const d = (q.x - e.x) ** 2 + (q.y - e.y) ** 2 + (q.z - e.z) ** 2;
        if (d < best) { best = d; b = q; }
      }
    }
    return b ? { e: b, d: Math.sqrt(best) } : null;
  };
  const fol = new Set();
  for (const m of meshes) {
    const mine = byMesh.get(m);
    if (!mine.length) continue;
    const step = Math.max(1, Math.floor(mine.length / 300));
    const ds = [];
    for (let k = 0; k < mine.length; k += step) {
      const h = nearestOn(mine[k], (q) => q.mesh !== m && byMesh.get(q.mesh).length > mine.length);
      ds.push(h ? h.d : Infinity);
    }
    ds.sort((a, b) => a - b);
    if (ds[ds.length >> 1] < 0.015) fol.add(m);
  }
  if (!fol.size) return out;
  for (const m of fol) for (const e of byMesh.get(m)) {
    const h = nearestOn(e, (q) => !fol.has(q.mesh));
    if (h && h.d < 0.03) out.set(e, h.e);
  }
  // follower vertices with no skin under them are left alone (not dented, not moved)
  for (const m of fol) for (const e of byMesh.get(m)) if (!out.has(e)) out.set(e, null);
  for (const [e, h] of [...out]) if (!h) out.delete(e), (e.drop = true);
  return out;
}

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
