// Where things are on the character's face, measured on its own mesh: the eyes, nose,
// cheeks, chin, forehead and mouth. Touches use them (a hand "on the cheek" lands on
// the cheek, not on the side of the head) and the AI is told where they are.
import * as THREE from 'three';
import { evaluator, EMPTY, headFrame, mouthProbe, NOT_FACE, TONGUE, nameOf } from './mouth.js';

const EYE = /eye|目|瞳|pupil|iris|hitomi|highlight/i;
const NOT_EYE = /brow|眉|lash|まつ|lid|socket|まぶた/i;
const HAIR = /hair|bang|ahoge|髪|毛|ribbon|hat|horn|角/i;

// -> { points: {name: {p, n}} in the head frame (x = character's left, y = up, z = forward),
//      spot(key, side) -> { point, normal } in the model's root space, or null } | null
export function faceLandmarks(model) {
  if (model._landmarks !== undefined && model._landmarksN === model.nodeCount) return model._landmarks;
  if (model._landmarksBusy) return null;
  model._landmarksBusy = true;
  model._landmarksN = model.nodeCount;
  model._landmarks = null;
  try { model._landmarks = scan(model); } catch (e) { console.warn('face landmarks', e); model._landmarks = null; } finally { model._landmarksBusy = false; }
  // spots measured before the landmarks were known get measured again
  if (model._humanoid) model._humanoid._spots = null;
  return model._landmarks;
}

function visible(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }

function scan(model) {
  const rig = model.humanoid, head = rig && rig.map.head;
  if (!head || !(model.skinned || []).length) return null;
  const probe = mouthProbe(model);
  const hr = rig.rest.get(head), inv = hr.Wq.clone().invert();
  const axes = probe ? probe.axes : { up: rig.up.clone().applyQuaternion(inv), fwd: rig.fwd.clone().applyQuaternion(inv), lat: rig.lat.clone().applyQuaternion(inv) };
  const headBones = new Set();
  head.traverse((o) => { if (o.isBone) headBones.add(o); });
  const ev = evaluator(model);
  try {
    ev.at(EMPTY, 0);
    const frame = headFrame(head, axes);
    const q = new THREE.Quaternion();
    head.updateWorldMatrix(true, false);
    head.getWorldQuaternion(q);
    const W = { p: new THREE.Vector3().setFromMatrixPosition(head.matrixWorld), lat: axes.lat.clone().applyQuaternion(q), up: axes.up.clone().applyQuaternion(q), fwd: axes.fwd.clone().applyQuaternion(q) };
    const face = [], eyes = [];
    const v = new THREE.Vector3(), n = new THREE.Vector3(), nm = new THREE.Matrix3();
    for (const s of model.skinned) {
      if (!visible(s) || !s.skeleton) continue;
      const g = s.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight, na = g.attributes.normal;
      if (!si || !sw || !na) continue;
      const mats = [].concat(s.material);
      const groups = g.groups || [];
      const index = g.index;
      // material per vertex (eyes are often their own material)
      const matOfVert = new Int16Array(si.count).fill(-1);
      if (groups.length && mats.length > 1) for (const gr of groups) for (let k = gr.start; k < gr.start + gr.count; k++) { const vi = index ? index.getX(k) : k; if (vi < matOfVert.length && matOfVert[vi] < 0) matOfVert[vi] = gr.materialIndex; }
      nm.getNormalMatrix(s.matrixWorld);
      for (let i = 0; i < si.count; i++) {
        let bi = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; bi = si.getComponent(i, k); } }
        const b = s.skeleton.bones[bi];
        if (!b || !headBones.has(b)) continue;
        const bn = nameOf(b);
        const mat = mats[matOfVert[i] >= 0 ? matOfVert[i] : 0];
        const mn = (mat && mat.name) || '';
        frame.local({ mesh: s, i }, v);
        n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
        const e = { x: v.x, y: v.y, z: v.z, nx: n.dot(W.lat), ny: n.dot(W.up), nz: n.dot(W.fwd) };
        if ((EYE.test(bn) && !NOT_EYE.test(bn)) || (EYE.test(mn) && !NOT_EYE.test(mn)) || (EYE.test(s.name) && !NOT_EYE.test(s.name))) { eyes.push(e); continue; }
        if (NOT_FACE.test(bn) || TONGUE.test(bn) || HAIR.test(mn) || HAIR.test(s.name)) continue;
        face.push(e);
      }
    }
    const front = face.filter((e) => e.nz > 0.15);
    if (front.length < 30) return null;
    const pts = {};
    const cx = probe ? probe.latC : front.reduce((a, e) => a + e.x, 0) / front.length;
    if (probe) pts.mouth = { p: new THREE.Vector3(probe.latC, probe.mouthUp, probe.lipFront), n: new THREE.Vector3(0, 0, 1) };
    // eyes: their own vertices (bones, material or mesh named eye), else the rig's eye bones
    const side = (list, m) => list.filter((e) => m * (e.x - cx) > 0);
    // middle of the eye's outline (highlights and lashes drawn on one side don't pull it over)
    const center = (list) => {
      if (list.length < 3) return null;
      const xs = list.map((e) => e.x).sort((a, b) => a - b), ys = list.map((e) => e.y).sort((a, b) => a - b);
      const q = (a, f) => a[Math.min(a.length - 1, Math.max(0, Math.round(f * (a.length - 1))))];
      return new THREE.Vector3((q(xs, 0.05) + q(xs, 0.95)) / 2, (q(ys, 0.05) + q(ys, 0.95)) / 2, Math.max(...list.map((e) => e.z)));
    };
    let eL = center(side(eyes, 1)), eR = center(side(eyes, -1));
    if (!eL || !eR) {
      const eb = [];
      head.traverse((o) => { if (o.isBone && o !== head && EYE.test(o.name) && !NOT_EYE.test(o.name)) { o.updateWorldMatrix(true, false); eb.push(frame.point(new THREE.Vector3().setFromMatrixPosition(o.matrixWorld), new THREE.Vector3())); } });
      const L = eb.filter((p) => p.x > cx), R = eb.filter((p) => p.x < cx);
      if (L.length && R.length) { eL = L[0]; eR = R[0]; }
    }
    if (!eL || !eR || !pts.mouth) return finish(pts, W, model);
    const eyeY = (eL.y + eR.y) / 2, eyeX = Math.abs(eL.x - eR.x) / 2;
    const span = eyeY - pts.mouth.p.y;
    if (!(span > 0) || !(eyeX > 0)) return finish(pts, W, model);
    // the front-most skin near a spot (seen from the front)
    const nearest = (tx, ty, r, filter = () => true) => {
      let best = null;
      for (const e of front) {
        if (!filter(e)) continue;
        const d = Math.hypot((e.x - tx) / r, (e.y - ty) / r);
        if (d > 1) continue;
        // closer to the spot and further forward wins
        const score = e.z - d * r * 0.35;
        if (!best || score > best.score) best = { e, score };
      }
      if (!best) return null;
      // average the normal over the neighbourhood for a steady direction
      const nb = front.filter((e) => Math.hypot(e.x - best.e.x, e.y - best.e.y, e.z - best.e.z) < r * 0.6);
      const nrm = new THREE.Vector3();
      for (const e of nb) nrm.x += e.nx, nrm.y += e.ny, nrm.z += e.nz;
      if (nrm.lengthSq() < 1e-9) nrm.set(best.e.nx, best.e.ny, best.e.nz);
      return { p: new THREE.Vector3(best.e.x, best.e.y, best.e.z), n: nrm.normalize() };
    };
    pts.eyeL = { p: eL.clone(), n: new THREE.Vector3(0, 0, 1) };
    pts.eyeR = { p: eR.clone(), n: new THREE.Vector3(0, 0, 1) };
    const nose = nearest(cx, pts.mouth.p.y + span * 0.55, Math.max(eyeX * 0.4, span * 0.35), (e) => Math.abs(e.x - cx) < eyeX * 0.3 && e.y > pts.mouth.p.y + span * 0.15 && e.y < eyeY - span * 0.1);
    if (nose) pts.nose = nose;
    for (const [k, m] of [['cheekL', 1], ['cheekR', -1]]) {
      const c = nearest(cx + m * eyeX * 1.05, pts.mouth.p.y + span * 0.45, eyeX * 0.4, (e) => m * (e.x - cx) > eyeX * 0.55);
      if (c) pts[k] = c;
    }
    // chin: the lowest front part of the face below the mouth
    const below = front.filter((e) => Math.abs(e.x - cx) < eyeX * 0.4 && e.y < pts.mouth.p.y - span * 0.12);
    if (below.length) {
      const jaw = Math.min(...below.map((e) => e.y));
      const chin = nearest(cx, jaw + (pts.mouth.p.y - jaw) * 0.3, Math.max(eyeX * 0.35, (pts.mouth.p.y - jaw) * 0.4), (e) => Math.abs(e.x - cx) < eyeX * 0.4 && e.y < pts.mouth.p.y - span * 0.1);
      if (chin) pts.chin = chin;
    }
    const fh = nearest(cx, eyeY + span * 0.8, eyeX * 0.5, (e) => Math.abs(e.x - cx) < eyeX * 0.6 && e.y > eyeY + span * 0.25);
    if (fh) pts.forehead = fh;
    return finish(pts, W, model, { eyeX, span });
  } finally { ev.done(); }
}

// head-frame points -> the model's root space (what the rig's spots use)
function finish(pts, W, model, extra = {}) {
  if (!Object.keys(pts).length) return null;
  const root = model.root;
  root.updateMatrixWorld(true);
  const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const rootQInv = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(root.matrixWorld)).invert();
  const toRoot = (p) => W.p.clone().addScaledVector(W.lat, p.x).addScaledVector(W.up, p.y).addScaledVector(W.fwd, p.z).applyMatrix4(rootInv);
  const dirRoot = (n) => new THREE.Vector3().addScaledVector(W.lat, n.x).addScaledVector(W.up, n.y).addScaledVector(W.fwd, n.z).applyQuaternion(rootQInv).normalize();
  const KEY = { mouth: () => 'mouth', nose: () => 'nose', chin: () => 'chin', forehead: () => 'forehead', cheek: (s) => (s === 'left' ? 'cheekL' : 'cheekR'), eyes: (s) => (s === 'left' ? 'eyeL' : 'eyeR') };
  return {
    points: pts,
    ...extra,
    spot(key, side) {
      const k = KEY[key] && KEY[key](side);
      const e = k && pts[k];
      return e ? { point: toRoot(e.p), normal: dirRoot(e.n) } : null;
    },
  };
}

// one line for the AI: where the face parts are (cm from the head bone)
export function describeLandmarks(model) {
  const lm = faceLandmarks(model);
  if (!lm) return '';
  const s = new THREE.Vector3(); model.root.getWorldScale(s);
  const cm = (p) => `(${[p.x, p.y, p.z].map((x) => (x * 100).toFixed(1)).join(', ')})`;
  const names = { eyeL: 'left eye', eyeR: 'right eye', nose: 'nose tip', cheekL: 'left cheek', cheekR: 'right cheek', mouth: 'lips', chin: 'chin', forehead: 'forehead' };
  const parts = Object.entries(names).filter(([k]) => lm.points[k]).map(([k, label]) => `${label} ${cm(lm.points[k].p)}`);
  return parts.length ? `Face, measured on the mesh (cm from the head bone; x = the character's left, y = up, z = forward): ${parts.join(', ')}. Touch spots "cheek", "nose", "chin", "forehead", "eyes", "mouth" land exactly there.` : '';
}

// the body spots a hand can touch, where they are on this character (measured on its mesh in
// the rest pose): cm from the hips, x = the character's left, y = up, z = forward
export function describeBodySpots(model) {
  const rig = model && model.humanoid;
  if (!rig || !rig.spot || !rig.map.hips) return '';
  const sc = new THREE.Vector3(); model.root.getWorldScale(sc);
  const k = 100 * ((Math.abs(sc.x) + Math.abs(sc.y) + Math.abs(sc.z)) / 3 || 1);
  const hips = rig.rest.get(rig.map.hips).pos;
  const list = [['betweenLegs', 'between the legs', 'right'], ['lap', 'lap', 'right'], ['belly', 'belly', 'right'], ['chest', 'chest', 'right'], ['hip', 'right hip', 'right'], ['thigh', 'right thigh', 'right'], ['knee', 'right knee', 'right'], ['back', 'lower back', 'right']];
  const parts = [];
  for (const [key, label, side] of list) {
    let sp = null;
    try { sp = rig.spot(key, side); } catch { sp = null; }
    if (!sp || !rig.map[sp.ref]) continue;
    const r = rig.rest.get(rig.map[sp.ref]);
    const p = sp.local.clone().applyQuaternion(r.Wq).add(r.pos).sub(hips);
    const x = p.dot(rig.lat) * k, y = p.dot(rig.up) * k, z = p.dot(rig.fwd) * k;
    parts.push(`${label} (${[x, y, z].map((v) => v.toFixed(1)).join(', ')})${sp.measured === 'guess' ? ' estimated' : ''}`);
  }
  return parts.length ? `Body spots, measured on this character's mesh (cm from the hips; x = the character's left, y = up, z = forward): ${parts.join(', ')}. A handTouches key with one of these spots puts the palm exactly there.` : '';
}
