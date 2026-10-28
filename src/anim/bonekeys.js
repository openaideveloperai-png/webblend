// Bone keys from the AI, in the character's own axes so they mean the same on
// every rig: x / y / z = degrees about the character's left / up / forward
// axes through the bone's joint (x+ swings the part forward/down like a nod,
// y+ turns it to the character's left, z+ tilts it to the character's right),
// mx / my / mz = slide in cm along left / up / forward (control handles such as
// lips and jaw). Applied on top of whatever the body pose does at that moment.
import * as THREE from 'three';
import { translateName } from '../core/jp.js';

const D2R = THREE.MathUtils.DEG2RAD;

export function findBone(model, name) {
  const raw = String(name || '').trim();
  // the AI may copy "足.L (leg (thigh).L)" or just the translation
  const bare = raw.replace(/\s*\[.*\]\s*$/, '').replace(/\s*\(.*\)\s*$/, '').trim();
  for (const c of [raw, bare]) {
    const n = c.toLowerCase();
    const b = model.bones.find((x) => x.name === c) || model.bones.find((x) => x.name.toLowerCase() === n);
    if (b) return b;
  }
  const n = bare.toLowerCase(), nr = raw.toLowerCase();
  return model.bones.find((b) => { const t = translateName(b.name); return t && (t.toLowerCase() === nr || t.toLowerCase() === n); })
    || model.bones.find((b) => b.name.toLowerCase().endsWith(n) || b.name.toLowerCase().replace(/^.*[:|]/, '') === n) || null;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// keys -> { bones: [{bone, keys}], unknown: [names] }, bones ordered parents first
export function boneKeyPlan(model, keys) {
  const by = new Map();
  const unknown = new Set();
  for (const k of keys || []) {
    if (!k || !k.bone || !Number.isFinite(Number(k.t))) continue;
    const bone = findBone(model, k.bone);
    if (!bone) { unknown.add(String(k.bone)); continue; }
    if (!by.has(bone)) by.set(bone, []);
    by.get(bone).push({ t: Number(k.t), x: num(k.x), y: num(k.y), z: num(k.z), mx: num(k.mx), my: num(k.my), mz: num(k.mz) });
  }
  const depth = (o) => { let d = 0; for (let p = o.parent; p; p = p.parent) d++; return d; };
  const bones = [...by].map(([bone, ks]) => ({ bone, keys: ks.sort((a, b) => a.t - b.t) })).sort((a, b) => depth(a.bone) - depth(b.bone));
  return { bones, unknown: [...unknown] };
}

function valueAt(ks, t) {
  const F = ['x', 'y', 'z', 'mx', 'my', 'mz'];
  const pick = (k) => Object.fromEntries(F.map((f) => [f, k[f]]));
  if (t <= ks[0].t) return pick(ks[0]);
  if (t >= ks[ks.length - 1].t) return pick(ks[ks.length - 1]);
  let i = 0;
  while (i < ks.length - 2 && ks[i + 1].t <= t) i++;
  const a = ks[i], b = ks[i + 1];
  const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
  const e = u * u * (3 - 2 * u);
  return Object.fromEntries(F.map((f) => [f, a[f] + (b[f] - a[f]) * e]));
}

// root units per meter (FBX files in centimeters sit under a 0.01 wrapper)
function unitsPerMeter(model) {
  const s = new THREE.Vector3(1, 1, 1);
  model.root.getWorldScale(s);
  return 1 / (s.x || 1);
}

// humanoid: modify a solved pose (Map bone -> {q, p}) at time t
export function boneKeyPost(model, rig, plan) {
  const cm = unitsPerMeter(model) * 0.01;
  return (solved, t) => {
    for (const { bone, keys } of plan.bones) {
      const r = rig.rest.get(bone);
      if (!r) continue;
      const v = valueAt(keys, t);
      const W = rig.solvedWorld(solved);
      const Pw = bone.parent && bone.parent.isBone && rig.rest.has(bone.parent) ? W(bone.parent) : r.Pq;
      const cur = solved.get(bone) || { q: r.Lq.clone(), p: null };
      const out = { q: cur.q.clone(), p: cur.p ? cur.p.clone() : null };
      if (v.x || v.y || v.z) {
        const D = rig.charRot(v.x, v.y, v.z);
        out.q = Pw.clone().invert().multiply(D).multiply(Pw).multiply(cur.q);
      }
      if (v.mx || v.my || v.mz) {
        const d = rig.charToModel(new THREE.Vector3(v.mx, v.my, v.mz)).multiplyScalar(cm);
        out.p = (cur.p || r.Lp).clone().add(d.applyQuaternion(Pw.clone().invert()));
      }
      solved.set(bone, out);
    }
  };
}

// tracks straight from the keys (no body pose to bake): in the character's axes when
// there's a humanoid, else the model's own
export function boneKeyTracks(model, plan, duration, fps = 30, rig = null) {
  const cm = unitsPerMeter(model) * 0.01;
  const tracks = [];
  const restWorld = (o) => {
    const q = new THREE.Quaternion();
    const chain = [];
    for (let p = o; p && p !== model.root; p = p.parent) chain.unshift(p);
    for (const p of chain) { const r = model.rest.get(p); q.multiply(r ? r.q : p.quaternion); }
    return q;
  };
  const n = Math.max(2, Math.round(duration * fps) + 1);
  for (const { bone, keys } of plan.bones) {
    const r = model.rest.get(bone) || { q: bone.quaternion.clone(), p: bone.position.clone() };
    const Pw = rig && rig.rest.get(bone) ? rig.rest.get(bone).Pq.clone() : bone.parent ? restWorld(bone.parent) : new THREE.Quaternion();
    const PwInv = Pw.clone().invert();
    const times = [], qv = [], pv = [];
    let moves = false, prev = null;
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * duration;
      times.push(t);
      const v = valueAt(keys, t);
      const D = rig ? rig.charRot(v.x, v.y, v.z) : new THREE.Quaternion().setFromEuler(new THREE.Euler(v.x * D2R, v.y * D2R, v.z * D2R, 'YXZ'));
      const q = PwInv.clone().multiply(D).multiply(Pw).multiply(r.q);
      if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prev = q;
      qv.push(q.x, q.y, q.z, q.w);
      const m = new THREE.Vector3(v.mx, v.my, v.mz);
      const p = r.p.clone().add((rig ? rig.charToModel(m) : m).multiplyScalar(cm).applyQuaternion(PwInv));
      if (v.mx || v.my || v.mz) moves = true;
      pv.push(p.x, p.y, p.z);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(bone.uuid + '.quaternion', times, qv));
    if (moves) tracks.push(new THREE.VectorKeyframeTrack(bone.uuid + '.position', times.slice(), pv));
  }
  return tracks;
}
