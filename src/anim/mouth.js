// The mouth as geometry: finds the lips and the tongue on the character's mesh,
// measures how open the lips are and what passes through them (the tongue, a
// finger), and keeps the lips apart around it the way soft lips would part, so
// nothing clips through them. Also measures what each mouth control does (opens
// the lips, sticks the tongue out) so the AI knows, and checks fingers and hands
// against the face.
import * as THREE from 'three';
import { faceControls, faceTracks } from './face.js';
import { translateName } from '../core/jp.js';
import { softLips, softLipsOn } from './softlips.js';

const V = () => new THREE.Vector3();
export const TONGUE = /tongue|舌|べろ/i;
const LIP = /lip|唇|くちびる/i;
const UPPER = /upper|上|top|_u\b|\.u\b/i;
const LOWER = /lower|下|bottom|_d\b|\.d\b|_l\b(?!eft)/i;
export const NOT_FACE = /hair|bang|ahoge|髪|毛|ear|耳|horn|角|eye|目|瞳|brow|眉|lash|teeth|歯/i;
export const nameOf = (b) => b.name + ' ' + (translateName(b.name) || '');

// ---------------------------------------------------------------- evaluating with the rig on
// Plays a clip on a scratch mixer with the model's constraints solved, so lip and
// tongue handles move the mesh the way they do in the app.
export function evaluator(model) {
  const root = model.root;
  const nodes = [];
  root.traverse((o) => nodes.push(o));
  const saved = nodes.map((o) => [o, o.position.clone(), o.quaternion.clone(), o.scale.clone(), o.morphTargetInfluences ? o.morphTargetInfluences.slice() : null]);
  const solver = model.constraints || null;
  const solverState = solver ? solver.saveState() : null;
  let mixer = null, cur = null, animated = new Set(), morphs = new Map();
  return {
    at(clip, t) {
      if (clip !== cur) {
        if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(root); }
        mixer = new THREE.AnimationMixer(root);
        const a = mixer.clipAction(clip);
        a.setLoop(THREE.LoopOnce, 1);
        a.clampWhenFinished = true;
        a.play();
        cur = clip;
        animated = new Set();
        morphs = new Map();
        for (const tr of clip.tracks) {
          const id = tr.name.slice(0, tr.name.indexOf('.'));
          const m = /morphTargetInfluences\[(\d+)\]/.exec(tr.name);
          if (m) { if (!morphs.has(id)) morphs.set(id, new Set()); morphs.get(id).add(+m[1]); } else animated.add(id);
        }
      }
      // what the clip doesn't animate goes back to rest (three.js only writes changes,
      // so animated values are left to the mixer)
      for (const o of nodes) {
        const r = model.rest && model.rest.get(o);
        if (!r || o === root) continue;
        if (!animated.has(o.uuid)) { o.position.copy(r.p); o.quaternion.copy(r.q); o.scale.copy(r.s); }
        if (o.morphTargetInfluences && r.m) { const keep = morphs.get(o.uuid); for (let i = 0; i < o.morphTargetInfluences.length; i++) if (!keep || !keep.has(i)) o.morphTargetInfluences[i] = r.m[i] ?? 0; }
      }
      mixer.setTime(Math.min(Math.max(0, t), Math.max(0, clip.duration - 1e-4)));
      root.updateMatrixWorld(true);
      if (solver) { solver.solve(animated); root.updateMatrixWorld(true); }
    },
    done() {
      if (mixer) { mixer.stopAllAction(); mixer.uncacheRoot(root); }
      for (const [o, p, q, s, m] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); if (m && o.morphTargetInfluences) for (let i = 0; i < m.length; i++) o.morphTargetInfluences[i] = m[i]; }
      if (solver && solverState) solver.loadState(solverState);
      root.updateMatrixWorld(true);
    },
  };
}

export const EMPTY = new THREE.AnimationClip('rest', 1, []);

// ---------------------------------------------------------------- finding the lips and the tongue
// -> probe { head, axes (head-local up / forward / left), upper, lower, tongue: [{mesh, i}],
//            restGap, lipFront, mouthUp, halfWidth, tongueThick } or null
export function mouthProbe(model) {
  if (model._mouthProbe !== undefined && model._mouthProbeN === model.nodeCount) return model._mouthProbe;
  model._mouthProbeN = model.nodeCount;
  model._mouthProbe = null;
  const rig = model.humanoid;
  const head = rig && rig.map.head;
  if (!head || !(model.skinned || []).length) return null;
  const headSet = new Set();
  head.traverse((o) => { if (o.isBone) headSet.add(o); });
  const ev = evaluator(model);
  let probe = null;
  try {
    ev.at(EMPTY, 0);
    const hr = rig.rest.get(head);
    const inv = hr.Wq.clone().invert();
    const axes = { up: rig.up.clone().applyQuaternion(inv), fwd: rig.fwd.clone().applyQuaternion(inv), lat: rig.lat.clone().applyQuaternion(inv) };
    const frame = headFrame(head, axes);
    const cand = { upper: [], lower: [], tongue: [], face: [] };
    const v = V();
    for (const s of model.skinned) {
      let vis = true;
      for (let p = s; p; p = p.parent) if (!p.visible) vis = false;
      if (!vis || !s.skeleton) continue;
      const si = s.geometry.attributes.skinIndex, sw = s.geometry.attributes.skinWeight;
      if (!si || !sw) continue;
      const mats = [].concat(s.material);
      const groups = s.geometry.groups || [];
      const matOf = (i) => { if (!groups.length) return mats[0]; const g = groups.find((gg) => i >= gg.start && i < gg.start + gg.count); return g ? mats[g.materialIndex] : mats[0]; };
      void matOf;
      for (let i = 0; i < si.count; i++) {
        let bi = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; bi = si.getComponent(i, k); } }
        const b = s.skeleton.bones[bi];
        if (!headSet.has(b)) continue;
        const n = nameOf(b);
        const e = { mesh: s, i };
        if (TONGUE.test(n)) cand.tongue.push(e);
        else if (LIP.test(n) && LOWER.test(n)) cand.lower.push(e);
        else if (LIP.test(n) && UPPER.test(n)) cand.upper.push(e);
        else if (!NOT_FACE.test(n)) cand.face.push(e);
      }
    }
    const P = (e) => frame.local(e, v).clone();
    // lips from lip bones; else from the mouth-open shape key
    let upper = cand.upper, lower = cand.lower;
    if (upper.length < 3 || lower.length < 3) ({ upper, lower } = lipsFromMorph(model, cand.face, frame) || { upper: [], lower: [] });
    if (upper.length < 3 || lower.length < 3) return null;
    const pts = (list) => list.map((e) => ({ e, p: P(e) }));
    const U = pts(upper), L = pts(lower);
    const latC = [...U, ...L].reduce((a, x) => a + x.p.x, 0) / (U.length + L.length);
    const halfWidth = Math.max(...[...U, ...L].map((x) => Math.abs(x.p.x - latC))) || 0.02;
    const band = (x) => Math.abs(x.p.x - latC) < halfWidth * 0.45;
    const K = 8;
    const ue = U.filter(band).sort((a, b) => a.p.y - b.p.y).slice(0, K);
    const le = L.filter(band).sort((a, b) => b.p.y - a.p.y).slice(0, K);
    if (ue.length < 2 || le.length < 2) return null;
    const mean = (l, k) => l.reduce((a, x) => a + x.p[k], 0) / l.length;
    const restGap = mean(ue, 'y') - mean(le, 'y');
    const lipFront = (mean(ue, 'z') + mean(le, 'z')) / 2;
    const mouthUp = (mean(ue, 'y') + mean(le, 'y')) / 2;
    const T = pts(cand.tongue);
    const tongueThick = T.length ? Math.max(0.004, (Math.max(...T.map((x) => x.p.y)) - Math.min(...T.map((x) => x.p.y))) * 0.55) : 0;
    probe = { head, axes, upper: ue.map((x) => x.e), lower: le.map((x) => x.e), tongue: T.map((x) => x.e), restGap, lipFront, mouthUp, latC, halfWidth, tongueThick, restTongueFront: T.length ? Math.max(...T.map((x) => x.p.z)) : null };
  } catch (e) { console.warn('mouth probe', e); probe = null; } finally { ev.done(); }
  model._mouthProbe = probe;
  return probe;
}

// head-relative coordinates in world units: x = character's left, y = up, z = forward
export function headFrame(head, axes) {
  const q = new THREE.Quaternion(), hp = V(), w = V();
  const ax = { up: V(), fwd: V(), lat: V() };
  const update = () => {
    head.updateWorldMatrix(true, false);
    head.getWorldQuaternion(q);
    hp.setFromMatrixPosition(head.matrixWorld);
    ax.up.copy(axes.up).applyQuaternion(q); ax.fwd.copy(axes.fwd).applyQuaternion(q); ax.lat.copy(axes.lat).applyQuaternion(q);
  };
  update();
  return {
    update,
    // a vertex -> head frame
    local(e, out) { e.mesh.getVertexPosition(e.i, w); w.applyMatrix4(e.mesh.matrixWorld).sub(hp); return out.set(w.dot(ax.lat), w.dot(ax.up), w.dot(ax.fwd)); },
    // a world point -> head frame
    point(p, out) { w.copy(p).sub(hp); return out.set(w.dot(ax.lat), w.dot(ax.up), w.dot(ax.fwd)); },
  };
}

// no lip bones: the lower lip is what the mouth-open shape key pulls down the most
function lipsFromMorph(model, face, frame) {
  const open = faceControls(model).find((c) => c.kind === 'shape' && c.group === 'mouth' && /^(mouth[_ ]?)?(a|aa|ah)$|mouth[_ ]?a\b|jaw ?open|mouth ?open|^あ$/i.test(c.name + ' ' + c.label));
  if (!open) return null;
  const v = V(), d = V();
  const scored = [];
  for (const { mesh, index } of open.targets) {
    const attr = mesh.geometry.morphAttributes.position && mesh.geometry.morphAttributes.position[index];
    if (!attr) continue;
    const rel = mesh.geometry.morphTargetsRelative;
    const pos = mesh.geometry.attributes.position;
    for (const e of face) {
      if (e.mesh !== mesh) continue;
      d.fromBufferAttribute(attr, e.i);
      if (!rel) d.sub(v.fromBufferAttribute(pos, e.i));
      scored.push({ e, down: -d.y, p: frame.local(e, V()).clone() });
    }
  }
  if (scored.length < 10) return null;
  const max = Math.max(...scored.map((s) => s.down));
  if (!(max > 0)) return null;
  const lower = scored.filter((s) => s.down > max * 0.6).sort((a, b) => b.down - a.down).slice(0, 24);
  const ly = lower.reduce((a, s) => a + s.p.y, 0) / lower.length, lx = lower.reduce((a, s) => a + s.p.x, 0) / lower.length, lz = lower.reduce((a, s) => a + s.p.z, 0) / lower.length;
  const upper = scored.filter((s) => s.down < max * 0.2 && s.p.y > ly && s.p.y < ly + 0.03 && Math.abs(s.p.x - lx) < 0.025 && Math.abs(s.p.z - lz) < 0.015).sort((a, b) => a.p.y - b.p.y).slice(0, 24);
  return { upper: upper.map((s) => s.e), lower: lower.map((s) => s.e) };
}

// ---------------------------------------------------------------- measuring
// in meters: gap = how far the lips are apart (beyond rest), tongueOut = how far past the
// lips the tongue reaches, thick = the tongue's height where it crosses the lips, fingers
// = fingertips inside the lips
export function measureMouth(model, probe) {
  const frame = headFrame(probe.head, probe.axes);
  const v = V();
  const ys = (list) => list.reduce((a, e) => a + frame.local(e, v).y, 0) / list.length;
  const gap = ys(probe.upper) - ys(probe.lower) - probe.restGap;
  let tongueOut = -Infinity, lo = Infinity, hi = -Infinity;
  const band = Math.max(0.003, probe.halfWidth * 0.25);
  for (const e of probe.tongue) {
    const p = frame.local(e, v);
    if (p.z > tongueOut) tongueOut = p.z;
    if (Math.abs(p.z - probe.lipFront) < band && Math.abs(p.x - probe.latC) < probe.halfWidth) { lo = Math.min(lo, p.y); hi = Math.max(hi, p.y); }
  }
  tongueOut = probe.tongue.length ? tongueOut - probe.lipFront : -1;
  const thick = hi > lo ? hi - lo : probe.tongueThick;
  // fingertips between the lips
  const rig = model.humanoid;
  const fingers = [];
  for (const side of ['left', 'right']) {
    const H = rig.handRig && rig.handRig(side);
    if (!H) continue;
    for (const [k, ch] of Object.entries(H.chains)) {
      const last = ch.bones[ch.bones.length - 1].bone;
      last.updateWorldMatrix(true, false);
      const tipW = ch.tipLocal.clone().applyMatrix4(last.matrixWorld);
      const p = frame.point(tipW, V());
      if (p.z < probe.lipFront + 0.002 && p.z > probe.lipFront - 0.08 && Math.abs(p.x - probe.latC) < probe.halfWidth * 1.1 && Math.abs(p.y - probe.mouthUp) < 0.02) {
        const s = new THREE.Vector3(); last.getWorldScale(s);
        fingers.push({ side, finger: k, depth: probe.lipFront - p.z, thick: Math.max(0.008, ch.len * 0.2 * (s.x || 1)) });
      }
    }
  }
  return { gap, tongueOut, thick, fingers };
}

// ---------------------------------------------------------------- what each mouth control does
// -> Map(control name -> { open (m), tongue (m) })
export function mouthEffects(model) {
  const probe = mouthProbe(model);
  if (!probe) return null;
  const key = model.nodeCount + ':' + (model.poses || []).length;
  if (model._mouthFx && model._mouthFxKey === key) return model._mouthFx;
  const out = new Map();
  const ev = evaluator(model);
  try {
    ev.at(EMPTY, 0);
    const base = measureMouth(model, probe);
    for (const c of faceControls(model)) {
      if (c.group !== 'mouth' && c.kind !== 'tongue') continue;
      const { tracks } = faceTracks(model, [{ t: 0, control: c.name, value: 1 }, { t: 1, control: c.name, value: 1 }], 1, 2);
      if (!tracks.length) continue;
      ev.at(new THREE.AnimationClip('fx', 1, tracks), 0.5);
      const m = measureMouth(model, probe);
      out.set(c.name, { open: m.gap - base.gap, tongue: probe.tongue.length ? m.tongueOut - base.tongueOut : 0 });
    }
  } catch (e) { console.warn('mouth effects', e); } finally { ev.done(); }
  model._mouthFx = out;
  model._mouthFxKey = key;
  return out;
}

// ---------------------------------------------------------------- keeping the lips apart
// Plays the clip with the rig on. Where the tongue or a finger passes the lips: with soft
// lips (the default) the lips wrap and seal around it and the mouth isn't opened (share =
// how much of its thickness the mouth opens, 0 = the lips do it all); without them the
// mouth opens just enough (with the control that opens it the most cleanly).
// -> { keys (the new faceKeys) | null, report }
export function clearMouth(model, clip, faceKeys = [], { share = null } = {}) {
  const probe = mouthProbe(model);
  if (!probe) return { keys: null, report: null };
  const fx = mouthEffects(model) || new Map();
  // the control that opens the lips with the least else going on
  const opener = [...fx].filter(([, e]) => e.open > 0.003 && e.tongue < 0.004).sort((a, b) => b[1].open - a[1].open)[0];
  const soft = softLipsOn(model) ? softLips(model) : null;
  if (share === null) share = soft ? 0 : 1;
  const fps = 15;
  const n = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = Array.from({ length: n }, (_, i) => (i / (n - 1)) * clip.duration);
  const sample = (c) => {
    const ev = evaluator(model);
    const res = [];
    try { for (const t of times) { ev.at(c, t); const m = measureMouth(model, probe); if (soft) m.soft = soft.update({ write: false }); res.push(m); } } finally { ev.done(); }
    return res;
  };
  const margin = 0.0015;
  const need = (m) => Math.max(m.tongueOut > 0.0015 ? m.thick + margin : 0, ...m.fingers.map((f) => f.thick + margin));
  const softLeft = (list) => Math.max(0, ...list.map((m) => (m.soft ? m.soft.leftCm : 0)));
  const softPush = (list) => Math.max(0, ...list.map((m) => (m.soft ? m.soft.pushCm : 0)));
  const before = sample(clip);
  const deficit = before.map((m) => Math.max(0, need(m) - m.gap));
  const worst = Math.max(...deficit);
  const report = { tongueOutCm: +(Math.max(0, ...before.map((m) => m.tongueOut)) * 100).toFixed(1), fingerIn: before.some((m) => m.fingers.length), clipCm: +(worst * 100).toFixed(1), opened: null, soft: !!soft, openCm: +(Math.max(0, ...before.map((m) => m.gap)) * 100).toFixed(1) };
  if (soft) { report.wrapCm = +softPush(before).toFixed(1); report.clipAfterCm = +softLeft(before).toFixed(1); }
  if (!(worst > 0.001)) return { keys: null, report };
  if (!opener || share <= 0) {
    if (!opener && !soft) report.unfixed = 'no control opens this mouth';
    return { keys: null, report };
  }
  const [name, eff] = opener;
  // extra opening over time: open a little before it's needed, close after
  const lead = Math.max(1, Math.round(0.15 * fps));
  let extra = deficit.map((d) => (d * share) / eff.open);
  extra = extra.map((_, i) => Math.max(...extra.slice(i, i + lead + 1), ...extra.slice(Math.max(0, i - 1), i + 1)));
  extra = extra.map((x, i) => (extra[Math.max(0, i - 1)] + 2 * x + extra[Math.min(n - 1, i + 1)]) / 4);
  const own = faceKeys.filter((k) => k && k.control === name).sort((a, b) => a.t - b.t);
  const ownAt = (t) => {
    if (!own.length) return 0;
    if (t <= own[0].t) return +own[0].value || 0;
    if (t >= own[own.length - 1].t) return +own[own.length - 1].value || 0;
    let i = 0;
    while (i < own.length - 2 && own[i + 1].t <= t) i++;
    const a = own[i], b = own[i + 1], u = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return (+a.value || 0) + ((+b.value || 0) - (+a.value || 0)) * u * u * (3 - 2 * u);
  };
  let scale = soft ? 1 : 1.15;
  let keys = null, after = null;
  for (let pass = 0; pass < 3; pass++) {
    keys = faceKeys.filter((k) => !k || k.control !== name).concat(times.map((t, i) => ({ t, control: name, value: Math.min(1, ownAt(t) + extra[i] * scale) })));
    const face = faceTracks(model, keys, clip.duration);
    const taken = new Set(face.tracks.map((t) => t.name));
    const test = new THREE.AnimationClip(clip.name, clip.duration, clip.tracks.filter((t) => !taken.has(t.name)).concat(face.tracks));
    after = sample(test);
    if (soft) {
      // the lips wrap around the rest; open more only if they can't (still clipping)
      const left = softLeft(after) / 100;
      if (left <= 0.0015 || share >= 1) break;
      scale *= 1 + left / Math.max(0.002, worst * share);
    } else {
      const left = Math.max(...after.map((m) => Math.max(0, need(m) - m.gap)));
      if (left <= 0.001) break;
      scale *= 1 + left / Math.max(0.002, worst);
    }
  }
  report.opened = name;
  report.openCm = +(Math.max(...after.map((m) => m.gap)) * 100).toFixed(1);
  report.clipAfterCm = soft ? +softLeft(after).toFixed(1) : +(Math.max(...after.map((m) => Math.max(0, need(m) - m.gap))) * 100).toFixed(1);
  if (soft) report.wrapCm = +softPush(after).toFixed(1);
  return { keys, report };
}

// ---------------------------------------------------------------- hands against the face
// Fingertips and palms that go into the face (behind its surface, outside the open
// mouth) -> [{t, what, cm}], one per part at its deepest moment.
function faceSurface(model) {
  if (model._faceSurf !== undefined && model._faceSurfN === model.nodeCount) return model._faceSurf;
  model._faceSurfN = model.nodeCount;
  model._faceSurf = null;
  const rig = model.humanoid, head = rig && rig.map.head;
  if (!head) return null;
  const headSet = new Set(); head.traverse((o) => { if (o.isBone) headSet.add(o); });
  const hr = rig.rest.get(head), inv = hr.Wq.clone().invert();
  const axes = { up: rig.up.clone().applyQuaternion(inv), fwd: rig.fwd.clone().applyQuaternion(inv), lat: rig.lat.clone().applyQuaternion(inv) };
  const ev = evaluator(model);
  try {
    ev.at(EMPTY, 0);
    const frame = headFrame(head, axes);
    const q = new THREE.Quaternion(); head.getWorldQuaternion(q);
    const ax = { up: axes.up.clone().applyQuaternion(q), fwd: axes.fwd.clone().applyQuaternion(q), lat: axes.lat.clone().applyQuaternion(q) };
    const pts = [], nrm = [];
    const v = V(), n = V(), nm = new THREE.Matrix3();
    for (const s of model.skinned || []) {
      let vis = true; for (let p = s; p; p = p.parent) if (!p.visible) vis = false;
      if (!vis || !s.skeleton) continue;
      const si = s.geometry.attributes.skinIndex, sw = s.geometry.attributes.skinWeight, na = s.geometry.attributes.normal;
      if (!si || !sw || !na) continue;
      nm.getNormalMatrix(s.matrixWorld);
      let count = 0;
      for (let i = 0; i < si.count; i++) {
        let bi = 0, bw = -1;
        for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; bi = si.getComponent(i, k); } }
        const b = s.skeleton.bones[bi];
        if (!headSet.has(b) || NOT_FACE.test(nameOf(b)) || TONGUE.test(nameOf(b))) continue;
        if (++count % 2) continue;
        frame.local({ mesh: s, i }, v);
        n.fromBufferAttribute(na, i).applyMatrix3(nm).normalize();
        pts.push(v.x, v.y, v.z);
        nrm.push(n.dot(ax.lat), n.dot(ax.up), n.dot(ax.fwd));
      }
    }
    if (pts.length > 30) model._faceSurf = { axes, pts: new Float32Array(pts), nrm: new Float32Array(nrm) };
  } catch (e) { console.warn('face surface', e); } finally { ev.done(); }
  return model._faceSurf;
}

export function faceHits(model, clip, { exempt = null } = {}) {
  const rig = model.humanoid;
  const surf = faceSurface(model);
  if (!surf) return [];
  const probe = mouthProbe(model);
  const head = rig.map.head;
  // with soft lips, whatever touches the lips gets wrapped by them, not clipped
  const soft = softLipsOn(model) ? softLips(model) : null;
  const hits = [];
  const ev = evaluator(model);
  try {
    const fps = 10, n = Math.max(2, Math.round(clip.duration * fps) + 1);
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * clip.duration;
      ev.at(clip, t);
      const frame = headFrame(head, surf.axes);
      const m = probe ? measureMouth(model, probe) : null;
      for (const side of ['left', 'right']) {
        const H = rig.handRig && rig.handRig(side);
        const parts = [];
        if (H) for (const [k, ch] of Object.entries(H.chains)) { const last = ch.bones[ch.bones.length - 1].bone; last.updateWorldMatrix(true, false); parts.push([`${side} ${k} fingertip`, ch.tipLocal.clone().applyMatrix4(last.matrixWorld), k]); }
        const hb = rig.map[side + 'Hand'];
        if (hb) { hb.updateWorldMatrix(true, false); const ax = rig.handAxes[side]; parts.push([`${side} palm`, ax.f.clone().multiplyScalar(0.5 * ax.palmLen).addScaledVector(ax.n, 0.2 * ax.palmLen).applyMatrix4(hb.matrixWorld), 'palm']); }
        for (const [what, w, k] of parts) {
          if (exempt && exempt(t, side, k)) continue;
          const p = frame.point(w, V());
          // nearest face point; behind its surface = inside the face
          let best = Infinity, bi = -1;
          for (let j = 0; j < surf.pts.length; j += 3) {
            const dx = p.x - surf.pts[j], dy = p.y - surf.pts[j + 1], dz = p.z - surf.pts[j + 2];
            const d = dx * dx + dy * dy + dz * dz;
            if (d < best) { best = d; bi = j; }
          }
          if (bi < 0 || Math.sqrt(best) > 0.03) continue;
          const depth = -((p.x - surf.pts[bi]) * surf.nrm[bi] + (p.y - surf.pts[bi + 1]) * surf.nrm[bi + 1] + (p.z - surf.pts[bi + 2]) * surf.nrm[bi + 2]);
          if (depth < 0.01) continue; // deeper than a centimeter: smaller is surface noise (ears and hair are left out)
          if (soft && soft.covers(p.x, p.y, p.z)) continue;
          // a finger between parted lips is fine
          if (m && (m.fingers.some((f) => f.side === side && f.finger === k) || (probe && m.gap > 0.003 && Math.abs(p.x - probe.latC) < probe.halfWidth && Math.abs(p.y - probe.mouthUp) < m.gap + 0.006 && p.z < probe.lipFront + 0.004))) continue;
          hits.push({ t: +t.toFixed(2), what, cm: +(depth * 100).toFixed(1) });
        }
      }
    }
  } catch (e) { console.warn('face hits', e); } finally { ev.done(); }
  const best = new Map();
  for (const h of hits) if (!best.has(h.what) || best.get(h.what).cm < h.cm) best.set(h.what, h);
  return [...best.values()];
}
