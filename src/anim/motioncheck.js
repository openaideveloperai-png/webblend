// Measures a finished AI clip the way a person would check it: where each hand
// (palm or fingertip) really is when it should touch something, how far the
// hands travel, how curled the fingers are, and anything the clip asked for
// that doesn't exist on this rig. The report goes back to Claude to fix.
import * as THREE from 'three';
import { SPOTS, SPOT_ALIAS } from './humanoid.js';

// evaluate a clip on a scratch mixer from the rest pose; points in root space
function sampler(model, clip) {
  const root = model.root;
  const saved = [];
  root.traverse((o) => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  // nodes the clip animates are left to the mixer: three.js only writes a value when it
  // changed since the last evaluation, so resetting them would lose held poses
  const animated = new Set(clip.tracks.map((t) => t.name.slice(0, t.name.indexOf('.'))));
  const base = saved.filter(([o]) => !animated.has(o.uuid) && !animated.has(o.name)).map(([o, p, q, s]) => { const r = o !== root && model.rest && model.rest.get(o); return r ? [o, r.p, r.q, r.s] : [o, p, q, s]; });
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const inv = new THREE.Matrix4();
  return {
    at(t) {
      for (const [o, p, q, s] of base) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
      mixer.setTime(Math.min(Math.max(t, 0), Math.max(0, clip.duration - 1e-4)));
      root.updateMatrixWorld(true);
      inv.copy(root.matrixWorld).invert();
    },
    point(node, local) { return (local ? local.clone() : new THREE.Vector3()).applyMatrix4(node.matrixWorld).applyMatrix4(inv); },
    quat(node) { const m = node.matrixWorld.clone().premultiply(inv); const q = new THREE.Quaternion(); m.decompose(new THREE.Vector3(), q, new THREE.Vector3()); return q; },
    done() {
      mixer.stopAllAction(); mixer.uncacheRoot(root);
      for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
      root.updateMatrixWorld(true);
    },
  };
}

const FINGERS = ['thumb', 'index', 'middle', 'ring', 'little'];

// -> { text, issues: [] }
export function checkMotion(model, clip, { prompt = '' } = {}) {
  const rig = model.humanoid;
  const plan = (clip.userData && clip.userData.plan) || {};
  const issues = [];
  const lines = [];
  for (const n of plan.unknownBones || []) issues.push(`boneKeys name a bone this rig doesn't have: "${n}" (use a name from the bone map)`);
  for (const n of plan.unknownFace || []) issues.push(`faceKeys name a control this model doesn't have: "${n}" (use one from the face / pose controls list)`);
  if (!rig) return { text: issues.join('\n'), issues };
  const scale = rig.height || 1.7;
  const cm = (d) => d / scale * 170; // in cm of a 1.7 m person
  const S = sampler(model, clip);
  try {
    const handPoint = (side, finger) => {
      const hb = rig.map[side + 'Hand'];
      if (!hb) return null;
      if (finger && finger !== 'palm') {
        const H = rig.handRig(side);
        const names = finger === 'two' ? ['index', 'middle'] : [finger];
        const pts = names.map((f) => H && H.chains[f]).filter(Boolean).map((ch) => S.point(ch.bones[ch.bones.length - 1].bone, ch.tipLocal));
        if (pts.length) return pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
      }
      const ax = rig.handAxes[side];
      return S.point(hb, ax.f.clone().multiplyScalar(0.55 * ax.palmLen).addScaledVector(ax.n, 0.22 * ax.palmLen));
    };
    const spotPoint = (key, side) => {
      const sp = rig.spot(key, side);
      const ref = sp && rig.map[sp.ref];
      if (!ref) return null;
      return sp.local.clone().applyQuaternion(S.quat(ref)).add(S.point(ref));
    };
    // how curled each finger is: 0 = straight .. 1 = fist (from the fingertip's distance to the knuckle)
    const curls = (side) => {
      const H = rig.handRig(side);
      if (!H) return null;
      const out = {};
      for (const f of FINGERS) {
        const ch = H.chains[f];
        if (!ch) continue;
        const first = ch.bones.find((e) => e.role !== 'meta') || ch.bones[0];
        const tip = S.point(ch.bones[ch.bones.length - 1].bone, ch.tipLocal);
        const d = tip.distanceTo(S.point(first.bone));
        out[f] = THREE.MathUtils.clamp((1 - d / Math.max(ch.len, 1e-6)) / 0.55, 0, 1);
      }
      return out;
    };
    const fmtCurls = (c) => (c ? FINGERS.filter((f) => f in c).map((f) => `${f} ${Math.round(c[f] * 100)}%`).join(', ') : '');
    // 1. every touch that should be fully on
    for (const k of plan.touches || []) {
      if (!(k.weight >= 0.9)) continue;
      const key = SPOT_ALIAS[k.spot] || k.spot;
      if (!SPOTS[key]) continue;
      S.at(k.t);
      const want = spotPoint(key, k.hand);
      const got = handPoint(k.hand, k.finger);
      if (!want || !got) continue;
      let d = got.distanceTo(want);
      const what = k.finger && k.finger !== 'palm' ? `${k.hand} ${k.finger === 'two' ? 'index + middle' : k.finger} fingertip${k.mode === 'pad' ? ' (pad)' : ''}` : `${k.hand} palm`;
      // a finger pushed in on purpose sits past the surface
      if (k.finger && k.finger !== 'palm' && k.depth > 0) { const H = rig.handRig(k.hand); const len = H && H.chains[k.finger === 'two' ? 'index' : k.finger] ? H.chains[k.finger === 'two' ? 'index' : k.finger].len : 0; d = Math.max(0, d - k.depth * len); }
      const c = curls(k.hand);
      lines.push(`- ${k.t.toFixed(2)} s: ${what} on the ${key}: ${cm(d) < 1.5 ? 'touching' : `${cm(d).toFixed(1)} cm away`}${c ? `; ${k.hand} fingers curled: ${fmtCurls(c)}` : ''}`);
      if (cm(d) > 4) issues.push(`at ${k.t.toFixed(2)} s the ${what} is ${cm(d).toFixed(0)} cm from the ${key} it should touch (out of reach or blocked: move the body closer, e.g. lean or bend, or pick a reachable spot)`);
    }
    // 2. hand travel over the clip, and where the hands end up
    const N = Math.min(24, Math.max(6, Math.round(clip.duration * 6)));
    const path = { left: [], right: [] };
    for (let i = 0; i <= N; i++) {
      S.at((i / N) * clip.duration);
      for (const side of ['left', 'right']) { const p = handPoint(side, null); if (p) path[side].push(p); }
    }
    const spotsNear = (side, p) => {
      let best = null;
      for (const key of Object.keys(SPOTS)) {
        if (key === 'crossed' || key === 'shoulder') continue;
        const q = spotPoint(key, side);
        if (!q) continue;
        const d = q.distanceTo(p);
        if (!best || d < best.d) best = { key, d };
      }
      return best;
    };
    const travel = {};
    for (const side of ['left', 'right']) {
      const ps = path[side];
      if (ps.length < 2) continue;
      let far = 0;
      for (const p of ps) far = Math.max(far, p.distanceTo(ps[0]));
      S.at(clip.duration * 0.5);
      const near = [handPoint(side, null), handPoint(side, 'index')].filter(Boolean).map((p) => spotsNear(side, p)).filter(Boolean).sort((a, b) => a.d - b.d)[0];
      lines.push(`- ${side} hand: moves up to ${cm(far).toFixed(0)} cm from where it starts; mid-clip it is ${near && cm(near.d) < 12 ? `at the ${near.key} (${cm(near.d).toFixed(0)} cm)` : 'away from the body'}`);
      travel[side] = cm(far);
      const wants = (plan.touches || []).some((k) => k.hand === side && k.weight >= 0.5);
      if (wants && cm(far) < 6) issues.push(`the ${side} hand hardly moves (${cm(far).toFixed(0)} cm) although it should go to ${[...new Set((plan.touches || []).filter((k) => k.hand === side).map((k) => k.spot))].join(' / ')}`);
    }
    // the request is about the hands (or the face, touched by a hand) but neither hand goes anywhere
    const handWords = /\b(hands?|fingers?|fingertips?|thumbs?|palms?|touch\w*|mouth|lips?|face|cheeks?|chin|nose|wave|waving|point\w*|reach\w*|grab\w*|cover\w*|hold\w*|clap\w*)\b/i;
    const tl = travel.left ?? 0, tr = travel.right ?? 0;
    if (handWords.test(prompt) && Math.max(tl, tr) < 6 && !(plan.touches || []).length) issues.push(`the request needs a hand to move, but neither hand goes anywhere (left ${tl.toFixed(0)} cm, right ${tr.toFixed(0)} cm): move the whole arm with handTouches (palm or fingertip on a spot) or arm params (rArmRaise / rArmSwing / rElbow...), not just the wrist`);
    // 3. bones keyed that a constraint overrides
    const scanInfo = model._rigScan && model._rigScan.info;
    if (scanInfo) for (const n of plan.keyedBones || []) {
      const b = model.bones.find((x) => x.name === n);
      const i = b && scanInfo.get(b);
      if (i && i.role === 'auto') issues.push(`"${n}" is driven by the rig's constraints, so its keys are overridden; key the bone or handle that drives it`);
    }
  } finally { S.done(); }
  if (plan.face && plan.face.length) lines.push(`- face controls used: ${plan.face.join(', ')}`);
  return { text: lines.join('\n'), issues };
}
