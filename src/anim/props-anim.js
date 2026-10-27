// Characters holding props: attach a prop to a hand bone, then bake holding,
// aiming and shooting into ordinary clips: arms by IK (both hands on the gun),
// fingers curled around the grip, recoil, the slide / bolt / pump cycling,
// a muzzle flash, tracers flying out and spent casings bouncing on the floor.
// Everything is keyframes inside the character's own clip, so it plays,
// scrubs, loops and exports like any other animation.
import * as THREE from 'three';
import { defaultParams, paramsToSpec } from './humanoid.js';
import { HUMANOID } from './motions.js';

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export function isProp(o) { return !!(o && o.userData && o.userData.prop); }

export function heldProps(model) {
  const out = [];
  if (!model) return out;
  model.root.traverse((o) => { if (isProp(o) && o.userData.hold) out.push(o); });
  return out;
}

export function propOf(o) {
  for (let p = o; p; p = p.parent) if (isProp(p)) return p;
  return null;
}

// plain {x,y,z} anchors (from a reloaded file) -> Vector3
function anchorsOf(prop) {
  const a = (prop.userData.prop && prop.userData.prop.anchors) || {};
  const out = {};
  for (const [k, v] of Object.entries(a)) if (v && Number.isFinite(v.x)) out[k] = v.isVector3 ? v : new THREE.Vector3(v.x, v.y, v.z);
  prop.userData.prop.anchors = out;
  return out;
}

export function styleOf(prop) {
  const p = prop.userData.prop || {};
  if (p.kind === 'melee') return 'melee';
  const a = anchorsOf(prop);
  if (a.stock && p.preset !== 'pistol') return 'rifle';
  return 'pistol';
}

// Put `prop` in the character's hand (right by default). The prop keeps its
// real size in meters whatever the rig's units.
export function attachProp(model, prop, side = 'right') {
  const rig = model.humanoid;
  if (!rig || !rig.map[side + 'Hand']) throw new Error('This model has no hands to hold it with.');
  const hb = rig.map[side + 'Hand'];
  const r = rig.rest.get(hb);
  const ax = rig.handAxes[side];
  model.root.updateMatrixWorld(true);
  const rootScale = new THREE.Vector3().setFromMatrixScale(model.root.matrixWorld).x || 1;
  const k = 1 / rootScale; // model units per meter
  const f = ax.f.clone().applyQuaternion(r.Wq).normalize();
  const n = ax.n.clone().applyQuaternion(r.Wq).normalize();
  const thumb = side === 'right' ? new THREE.Vector3().crossVectors(f, n) : new THREE.Vector3().crossVectors(n, f);
  const Z = f, Y = thumb.addScaledVector(Z, -thumb.dot(Z)).normalize(), X = new THREE.Vector3().crossVectors(Y, Z);
  const Rp = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(X, Y, Z));
  const anchors = anchorsOf(prop);
  const origin = r.pos.clone().addScaledVector(f, 0.52 * ax.palmLen).addScaledVector(n, 0.2 * ax.palmLen);
  const Pp = origin.clone().sub((anchors.grip || new THREE.Vector3()).clone().multiplyScalar(k).applyQuaternion(Rp));
  const WqInv = r.Wq.clone().invert();
  const offsetQ = WqInv.clone().multiply(Rp);
  const offsetP = Pp.clone().sub(r.pos).applyQuaternion(WqInv);
  // local transform under the hand bone (from the hand's rest pose)
  const handWorldScale = new THREE.Vector3().setFromMatrixScale(hb.matrixWorld);
  const handRest = new THREE.Matrix4().compose(r.pos, r.Wq, handWorldScale.clone().multiplyScalar(k)).premultiply(model.root.matrixWorld);
  const propWorld = new THREE.Matrix4().compose(Pp, Rp, new THREE.Vector3(k, k, k)).premultiply(model.root.matrixWorld);
  const local = handRest.invert().multiply(propWorld);
  if (prop.parent) prop.parent.remove(prop);
  local.decompose(prop.position, prop.quaternion, prop.scale);
  hb.add(prop);
  prop.userData.hold = { side, offsetP: offsetP.toArray(), offsetQ: offsetQ.toArray(), k };
  model.adopt(prop);
  return prop;
}

// returns the effect nodes taken out, so an undo can put them back
export function detachProp(model, prop) {
  const fx = removeFX(model, prop);
  if (prop.parent) prop.parent.remove(prop);
  model.forget(prop);
  return fx;
}

export function restoreFX(model, fx) {
  for (const [name, node] of fx || []) {
    const root = fxRoot(model, name);
    root.add(node);
    model.adopt(node);
  }
}

function holdBase(prop) {
  const h = prop.userData.hold;
  const a = anchorsOf(prop);
  // where it sits in the hand right now (so nudging it with the gizmo counts)
  let offsetP = new THREE.Vector3().fromArray(h.offsetP), offsetQ = new THREE.Quaternion().fromArray(h.offsetQ);
  const hand = prop.parent;
  let root = hand;
  while (root && root.parent && !root.userData.modelId) root = root.parent;
  if (hand && hand.isBone && root) {
    root.updateMatrixWorld(true);
    const sHand = new THREE.Vector3().setFromMatrixScale(hand.matrixWorld).x;
    const sRoot = new THREE.Vector3().setFromMatrixScale(root.matrixWorld).x || 1;
    offsetP = prop.position.clone().multiplyScalar(sHand / sRoot);
    offsetQ = prop.quaternion.clone();
  }
  return { side: h.side, offsetP, offsetQ, k: h.k || 1, anchors: a, style: styleOf(prop) };
}

// Turn any imported model into a prop: the longest side becomes the barrel
// (thinner end forward), the taller side up, the grip at the low back.
export function wrapAsProp(root, name) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const S = root.scale.clone();
  // sample points in the root's own frame, at its own scale
  const pts = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    const n = o.geometry.attributes.position.count, step = Math.max(1, Math.floor(n / 3000));
    for (let i = 0; i < n; i += step) { o.getVertexPosition(i, v); pts.push(v.clone().applyMatrix4(o.matrixWorld).applyMatrix4(inv).multiply(S)); }
  });
  if (!pts.length) pts.push(new THREE.Vector3());
  const box = new THREE.Box3().setFromPoints(pts);
  const size = box.getSize(new THREE.Vector3());
  const axes = [0, 1, 2].sort((a, b) => size.getComponent(b) - size.getComponent(a));
  const L = axes[0], U = axes[1];
  const lo = box.min.getComponent(L), len = size.getComponent(L) || 1;
  // cross-section of each end: the thinner end is the front (muzzle / tip)
  const slice = (from, to) => {
    const sl = pts.filter((p) => { const u = (p.getComponent(L) - lo) / len; return u >= from && u <= to; });
    if (!sl.length) return { area: Infinity, c: null };
    const b = new THREE.Box3().setFromPoints(sl);
    const sz = b.getSize(new THREE.Vector3());
    return { area: sz.getComponent(axes[1]) * sz.getComponent(axes[2]), c: b.getCenter(new THREE.Vector3()) };
  };
  const a0 = slice(0, 0.15), a1 = slice(0.85, 1);
  const frontPos = a1.area <= a0.area;
  const center = box.getCenter(new THREE.Vector3());
  const frontC = (frontPos ? a1.c : a0.c) || center;
  const upSign = frontC.getComponent(U) >= center.getComponent(U) ? 1 : -1;
  const Z = new THREE.Vector3().setComponent(L, frontPos ? 1 : -1);
  const Y = new THREE.Vector3().setComponent(U, upSign);
  const X = new THREE.Vector3().crossVectors(Y, Z);
  const toProp = new THREE.Matrix4().makeBasis(X, Y, Z).setPosition(center).invert();
  const wrap = new THREE.Group();
  wrap.name = name || root.name || 'Prop';
  root.position.set(0, 0, 0); root.quaternion.identity(); root.scale.copy(S);
  root.updateMatrix();
  root.applyMatrix4(toProp); // local -> (scale) -> prop frame
  wrap.add(root);
  wrap.updateMatrixWorld(true);
  const P = pts.map((p) => p.clone().applyMatrix4(toProp));
  const pb = new THREE.Box3().setFromPoints(P);
  const ps = pb.getSize(new THREE.Vector3());
  const front = frontC.clone().applyMatrix4(toProp);
  // grip: the lowest point in the back 60%, raised a bit toward the top
  let low = null;
  for (const p of P) if (p.z < pb.min.z + ps.z * 0.6 && (!low || p.y < low.y)) low = p;
  const grip = low ? new THREE.Vector3(0, low.y + ps.y * 0.3, low.z) : new THREE.Vector3(0, 0, pb.min.z + ps.z * 0.25);
  const anchors = {
    grip,
    muzzle: new THREE.Vector3(0, front.y, pb.max.z),
    eject: new THREE.Vector3(-ps.x / 2, front.y, (pb.min.z + pb.max.z) / 2),
  };
  if (ps.z > 0.35) {
    anchors.support = new THREE.Vector3(ps.x * 0.3, pb.min.y + ps.y * 0.5, Math.min(pb.max.z - ps.z * 0.15, grip.z + ps.z * 0.35));
    anchors.stock = new THREE.Vector3(0, grip.y, pb.min.z);
  }
  const gunLike = ps.y > ps.z * 0.25;
  wrap.userData.prop = { kind: gunLike ? 'gun' : 'melee', preset: 'custom', anchors, slideTravel: 0, slideNode: null, fireRate: 4, caliber: gunLike ? '9mm' : null, action: gunLike ? 'semi' : null, imported: true };
  return wrap;
}

// ---------------------------------------------------------------- recoil and timing
const RECOIL = {
  pistol: { up: 9, back: 0.024, rate: 4 },
  rifle: { up: 3.2, back: 0.016, rate: 10 },
  smg: { up: 2.4, back: 0.011, rate: 14 },
  sniper: { up: 8, back: 0.03, rate: 0.8 },
  shotgun: { up: 11, back: 0.04, rate: 1.2 },
  custom: { up: 5, back: 0.02, rate: 5 },
};
export function recoilOf(prop) {
  const p = prop.userData.prop || {};
  const r = RECOIL[p.preset] || (styleOf(prop) === 'rifle' ? RECOIL.rifle : styleOf(prop) === 'pistol' ? RECOIL.pistol : RECOIL.custom);
  return { ...r, rate: p.fireRate > 0 ? p.fireRate : r.rate };
}

function rnd(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// recoil amount at t from shot times (sharp kick, quick recovery)
function kickAt(t, shots, amp) {
  let up = 0, back = 0;
  for (const s of shots) {
    const dt = t - s.t;
    if (dt < 0 || dt > 0.6) continue;
    const a = dt < 0.025 ? dt / 0.025 : Math.exp(-(dt - 0.025) / 0.075);
    up += a * amp.up * s.j;
    back += a * amp.back * s.j;
  }
  return { up: Math.min(up, amp.up * 2.2), back: Math.min(back, amp.back * 2.2) };
}

// Build a holding / aiming / shooting clip for `model` holding `prop`.
// opts: shots (number) or shotTimes (array), aimIn, hold (seconds after the
// last shot), lower (bool), yaw, pitch, twoHands, name, base ('still' | 'idle'), duration
// Timing and pose logic for a held prop, shared by the built-in clips and
// Claude's: apply(t, params) adds the hold (aim, support hand, recoil,
// swings) to a frame's pose params.
// opts: shots (count) | shotTimes, swings (count) | swingTimes | swingList [{t, back}],
// aim (bool) | aimAt(t) -> weight, aimIn, hold, lower, loop, yaw, pitch | aimDir(t) -> {yaw, pitch}, twoHands, duration
export function holdDriver(model, prop, opts = {}) {
  const base = holdBase(prop);
  const style = base.style;
  const rec = recoilOf(prop);
  const rate = opts.rate || rec.rate;
  const aimIn = opts.aimIn ?? (opts.shots || (opts.shotTimes && opts.shotTimes.length) || opts.aim || opts.swings ? 0.45 : 0);
  let shotTimes = opts.shotTimes ? opts.shotTimes.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b) : [];
  if (!opts.shotTimes && opts.shots > 0) {
    const first = aimIn + 0.22;
    for (let i = 0; i < Math.min(60, opts.shots); i++) shotTimes.push(first + i / rate);
  }
  // never faster than the gun can fire
  const minGap = 0.9 / Math.max(0.2, rate);
  shotTimes = shotTimes.filter((t, i, a) => i === 0 || t - a[i - 1] >= minGap * 0.999).slice(0, 120);
  const r = rnd(shotTimes.length * 7919 + 13);
  const shots = style === 'melee' ? [] : shotTimes.map((t) => ({ t, j: 0.8 + r() * 0.4 }));
  // melee swings: [{t0, t1, back}]
  const swings = [];
  if (style === 'melee') {
    if (opts.swingList && opts.swingList.length) opts.swingList.forEach((sw) => swings.push({ t0: sw.t, t1: sw.t + 0.32, back: !!sw.back }));
    else if (opts.swings > 0 || (opts.swingTimes && opts.swingTimes.length)) {
      const st = opts.swingTimes || Array.from({ length: Math.min(12, opts.swings) }, (_, i) => 0.55 + i * 0.75);
      st.forEach((t0, i) => swings.push({ t0, t1: t0 + 0.32, back: i % 2 === 1 }));
    }
  }
  const aiming = !!(shots.length || opts.aim || swings.length || opts.aimAt);
  const lastShot = shots.length ? shots[shots.length - 1].t : swings.length ? swings[swings.length - 1].t1 + 0.2 : aimIn;
  const lower = opts.lower ?? (aiming && !opts.loop);
  const holdAfter = opts.hold ?? 0.6;
  const duration = opts.duration || Math.max(1.5, aiming ? lastShot + holdAfter + (lower ? 0.55 : 0) : 3);
  const twoHands = opts.twoHands ?? (style !== 'melee' || (prop.userData.prop.preset === 'katana' || prop.userData.prop.preset === 'bat'));
  const aimW = opts.aimAt || ((t) => {
    if (!aiming) return 0;
    let w = aimIn > 0 ? ease(t / aimIn) : 1;
    if (lower) w *= 1 - ease((t - (lastShot + holdAfter)) / 0.5);
    return w;
  });
  const apply = (t, p) => {
    const w = THREE.MathUtils.clamp(aimW(t) || 0, 0, 1);
    const kick = kickAt(t, shots, rec);
    // the body takes some of the recoil too
    p.chestPitch = (p.chestPitch || 0) - kick.up * 0.12;
    p.neckPitch = (p.neckPitch || 0) - kick.up * 0.05;
    if (style === 'rifle') {
      // bladed stance: support shoulder forward, chest turned away from the target
      const sgn = base.side === 'right' ? -1 : 1;
      p.chestPitch += 4 * w;
      p.spineYaw = (p.spineYaw || 0) + sgn * 14 * w;
      p.chestYaw = (p.chestYaw || 0) + sgn * 10 * w;
    }
    let swing = null;
    for (const sw of swings) {
      if (t < sw.t0 - 0.35 || t > sw.t1 + 0.35) continue;
      const amt = t < sw.t0 ? ease((t - (sw.t0 - 0.35)) / 0.35) : t > sw.t1 ? 1 - ease((t - sw.t1) / 0.35) : 1;
      const phase = t < sw.t0 ? 0 : t > sw.t1 ? 1 : ease((t - sw.t0) / (sw.t1 - sw.t0));
      swing = { amount: amt, phase, back: sw.back };
      // put the body into it
      const into = Math.sin(Math.PI * phase) * amt;
      const sgn = (base.side === 'right' ? 1 : -1) * (sw.back ? -1 : 1);
      p.spineYaw = (p.spineYaw || 0) + sgn * (18 - 36 * phase) * amt;
      p.chestPitch = (p.chestPitch || 0) + 8 * into;
      p.hipsYaw = (p.hipsYaw || 0) + sgn * (8 - 16 * phase) * amt;
    }
    const dir = opts.aimDir ? opts.aimDir(t) : { yaw: opts.yaw || 0, pitch: opts.pitch || 0 };
    const a = swing ? Math.max(w, swing.amount) : w;
    p.hold = { ...base, aim: a, support: twoHands ? a : 0, yaw: dir.yaw || 0, pitch: dir.pitch || 0, kick, curl: 1, swing };
    return p;
  };
  return { apply, shots: shots.map((s) => s.t), swings, duration, style, fps: shots.length || swings.length ? 60 : 30 };
}

// Build a holding / aiming / shooting / swinging clip for `model` holding `prop`
// (opts as holdDriver, plus name and base motion 'still' | 'idle').
export function bakeHoldClip(model, prop, opts = {}) {
  const rig = model.humanoid;
  const d = holdDriver(model, prop, opts);
  const baseKey = HUMANOID[opts.base] ? opts.base : HUMANOID.still ? 'still' : 'idle';
  const bm = HUMANOID[baseKey];
  const defaults = defaultParams();
  const fn = (t) => {
    const ph = bm.loop ? (t / bm.cycle) % 1 : Math.min(1, t / bm.cycle);
    const p = bm.at(ph, { ...defaults }, {});
    p.plantFeet = true;
    return paramsToSpec(d.apply(t, p));
  };
  const clip = rig.bake(opts.name || (d.shots.length ? 'Shoot' : d.swings.length ? 'Slash' : 'Hold'), d.duration, fn, d.fps);
  clip.userData = { generated: 'hold', prop: prop.uuid };
  if (d.shots.length) addShotEffects(model, prop, clip, d.shots, opts);
  return { clip, shots: d.shots, swings: d.swings, duration: d.duration };
}

// ---------------------------------------------------------------- effects
const fxTex = new Map();
function flameTexture(kind) {
  if (fxTex.has(kind)) return fxTex.get(kind);
  const s = 128;
  let cv = null;
  if (typeof OffscreenCanvas !== 'undefined') cv = new OffscreenCanvas(s, s);
  else if (typeof document !== 'undefined') { cv = document.createElement('canvas'); cv.width = cv.height = s; }
  const g = cv && cv.getContext('2d');
  let tex = null;
  if (g) {
    if (kind === 'star') {
      const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
      grd.addColorStop(0, 'rgba(255,255,240,1)'); grd.addColorStop(0.25, 'rgba(255,210,120,0.9)'); grd.addColorStop(0.6, 'rgba(255,120,30,0.35)'); grd.addColorStop(1, 'rgba(255,80,0,0)');
      g.fillStyle = grd; g.fillRect(0, 0, s, s);
      g.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; g.strokeStyle = 'rgba(255,220,150,0.7)'; g.lineWidth = 5; g.beginPath(); g.moveTo(s / 2, s / 2); g.lineTo(s / 2 + Math.cos(a) * s * 0.48, s / 2 + Math.sin(a) * s * 0.48); g.stroke(); }
    } else {
      // flame seen from the side: bright at the muzzle (bottom), tapering forward (up)
      const grd = g.createLinearGradient(0, s, 0, 0);
      grd.addColorStop(0, 'rgba(255,255,230,1)'); grd.addColorStop(0.3, 'rgba(255,200,90,0.9)'); grd.addColorStop(0.75, 'rgba(255,110,20,0.4)'); grd.addColorStop(1, 'rgba(255,60,0,0)');
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(s * 0.5, s); g.bezierCurveTo(s * 0.05, s * 0.75, s * 0.25, s * 0.25, s * 0.5, 0); g.bezierCurveTo(s * 0.75, s * 0.25, s * 0.95, s * 0.75, s * 0.5, s); g.fill();
    }
    tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
  }
  fxTex.set(kind, tex);
  return tex;
}

function fxMat(color, map, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, map: map || null, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
}

function fxRoot(model, name) {
  let g = model.root.children.find((c) => c.userData.fx === name);
  if (!g) {
    g = new THREE.Group();
    g.name = name;
    g.userData.fx = name;
    model.root.add(g);
    model.adopt(g);
  }
  return g;
}

function ensureFlash(model, prop) {
  let fl = prop.children.find((c) => c.userData.fx === 'flash');
  if (fl) return fl;
  const a = anchorsOf(prop);
  const size = { shotgun: 0.24, rifle: 0.17, sniper: 0.2, smg: 0.12 }[prop.userData.prop.preset] || 0.11;
  fl = new THREE.Group();
  fl.name = 'Muzzle flash';
  fl.userData.fx = 'flash';
  fl.position.copy(a.muzzle || new THREE.Vector3());
  const side = flameTexture('side'), star = flameTexture('star');
  for (const rz of [0, Math.PI / 2]) {
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.55, size).translate(0, size / 2, 0).rotateX(Math.PI / 2), fxMat(0xffcf8a, side));
    pl.rotation.z = rz;
    pl.name = 'flame';
    fl.add(pl);
  }
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(size * 0.7, size * 0.7), fxMat(0xffe2b0, star));
  disc.name = 'flash core';
  disc.position.z = size * 0.06;
  fl.add(disc);
  fl.scale.setScalar(0);
  fl.renderOrder = 10;
  prop.add(fl);
  model.adopt(fl);
  return fl;
}

function makeBullet(i, caliber) {
  const g = new THREE.Group();
  g.name = 'Tracer ' + (i + 1);
  const len = caliber === '12ga' ? 0.25 : 0.42;
  const core = new THREE.Mesh(new THREE.CylinderGeometry(0.0022, 0.0045, len, 8, 1, true).translate(0, -len / 2, 0).rotateX(Math.PI / 2), fxMat(0xffb35a, null, 0.95));
  core.name = 'tracer';
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.0055, 10, 8), fxMat(0xfff0c8));
  head.name = 'bullet';
  g.add(core, head);
  return g;
}

function makeCasing(i, caliber) {
  const g = new THREE.Group();
  g.name = 'Casing ' + (i + 1);
  const brass = new THREE.MeshStandardMaterial({ color: 0xc89a4a, metalness: 0.95, roughness: 0.28 });
  if (caliber === '12ga') {
    const hull = new THREE.Mesh(new THREE.CylinderGeometry(0.0105, 0.0105, 0.05, 14).rotateX(Math.PI / 2).translate(0, 0, 0.008), new THREE.MeshStandardMaterial({ color: 0xa3201e, roughness: 0.5 }));
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, 0.016, 14).rotateX(Math.PI / 2).translate(0, 0, -0.025), brass);
    g.add(hull, base);
  } else {
    const len = caliber === '5.56' ? 0.045 : caliber === '.308' ? 0.051 : 0.019;
    const r = caliber === '9mm' ? 0.0048 : 0.0048;
    const c = new THREE.Mesh(new THREE.CylinderGeometry(r * (caliber === '9mm' ? 1 : 0.62), r, len, 12).rotateX(Math.PI / 2), brass);
    c.name = 'brass';
    g.add(c);
  }
  for (const m of g.children) m.castShadow = true;
  return g;
}

function poolOf(model, prop, kind, count, maker) {
  const root = fxRoot(model, kind === 'tracer' ? 'Tracers' : 'Casings');
  const k = prop.userData.hold ? prop.userData.hold.k || 1 : 1;
  const cal = prop.userData.prop.caliber || '9mm';
  const key = prop.uuid;
  const mine = root.children.filter((c) => c.userData.owner === key);
  while (mine.length < count) {
    const n = maker(mine.length, cal);
    n.userData.owner = key;
    n.scale.setScalar(0);
    n.userData.restScale = k;
    root.add(n);
    model.adopt(n);
    mine.push(n);
  }
  return mine.slice(0, count);
}

export function removeFX(model, prop) {
  const taken = [];
  for (const name of ['Tracers', 'Casings']) {
    const root = model.root.children.find((c) => c.userData.fx === name);
    if (!root) continue;
    for (const c of root.children.filter((x) => x.userData.owner === prop.uuid)) { root.remove(c); model.forget(c); taken.push([name, c]); }
    if (!root.children.length) { model.root.remove(root); model.forget(root); }
  }
  return taken;
}

// world state of the prop's anchors at time t (evaluates the clip)
function sampleProp(model, prop, clip, times) {
  const root = model.root;
  const saved = [];
  root.traverse((o) => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.play();
  const inv = new THREE.Matrix4();
  const a = anchorsOf(prop);
  const out = [];
  for (const t of times) {
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    inv.copy(root.matrixWorld).invert();
    const M = prop.matrixWorld.clone().premultiply(inv); // prop -> model space
    const q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    M.decompose(p, q, s);
    const pt = (v) => (v ? v.clone().applyMatrix4(M) : p.clone());
    out.push({
      t,
      muzzle: pt(a.muzzle), eject: pt(a.eject || a.muzzle), q,
      fwd: new THREE.Vector3(0, 0, 1).applyQuaternion(q), right: new THREE.Vector3(-1, 0, 0).applyQuaternion(q), up: new THREE.Vector3(0, 1, 0).applyQuaternion(q),
    });
  }
  action.stop();
  mixer.uncacheRoot(root);
  for (const [o, p, q, s] of saved) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
  root.updateMatrixWorld(true);
  return out;
}

// Add flash, slide / bolt / pump, tracers and casings to a clip, for shots at `times`.
export function addShotEffects(model, prop, clip, times, opts = {}) {
  if (!times.length) return clip;
  const P = prop.userData.prop;
  const k = prop.userData.hold ? prop.userData.hold.k || 1 : 1;
  const dur = clip.duration;
  const tracks = [];
  const eps = 1 / 240;
  // muzzle flash: on for two frames each shot, random roll
  const flash = ensureFlash(model, prop);
  {
    const ts = [0], sv = [0, 0, 0], qts = [0], qv = [0, 0, 0, 1];
    const r = rnd(times.length * 31 + 7);
    for (const t of times) {
      const big = 0.85 + r() * 0.4;
      ts.push(t, t + 0.045); sv.push(big, big, big * (0.9 + r() * 0.3), 0, 0, 0);
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), r() * Math.PI * 2);
      qts.push(t); qv.push(q.x, q.y, q.z, q.w);
    }
    tracks.push(new THREE.VectorKeyframeTrack(flash.uuid + '.scale', ts, sv, THREE.InterpolateDiscrete));
    tracks.push(new THREE.QuaternionKeyframeTrack(flash.uuid + '.quaternion', qts, qv, THREE.InterpolateDiscrete));
  }
  // slide / bolt / pump
  const slide = P.slideNode ? prop.getObjectByName(P.slideNode) : null;
  if (slide && P.slideTravel > 0) {
    const p0 = slide.position.clone();
    const back = p0.clone();
    back.z -= P.slideTravel; // straight back along the barrel
    const ts = [0], v = [...p0.toArray()];
    const push = (t, p) => { if (t > ts[ts.length - 1] + 1e-4 && t <= dur) { ts.push(t); v.push(...p.toArray()); } };
    for (const t of times) {
      if (P.action === 'pump') { push(t + 0.16, p0); push(t + 0.30, back); push(t + 0.48, p0); }
      else if (P.action === 'bolt') { push(t + 0.25, p0); push(t + 0.45, back); push(t + 0.7, p0); }
      else { push(t - eps, p0); push(t + 0.018, back); push(t + 0.07, p0); }
    }
    if (ts.length > 1) tracks.push(new THREE.VectorKeyframeTrack(slide.uuid + '.position', ts, v));
  }
  // where the gun is at each shot (and after, for the casings' start)
  const states = sampleProp(model, prop, clip, times);
  // tracers: fly out along the barrel
  const speed = (opts.bulletSpeed || 55) * k; // model units / s (slowed so you can see them)
  const life = opts.bulletLife || 0.28;
  const nT = Math.min(16, Math.ceil(life * (times.length > 1 ? 1 / Math.max(1e-3, times[1] - times[0]) : 1)) + 1);
  const pool = poolOf(model, prop, 'tracer', nT, makeBullet);
  const pellets = P.caliber === '12ga' ? 5 : 1;
  const tracerPool = pellets > 1 ? poolOf(model, prop, 'tracer', Math.min(16, nT * pellets), makeBullet) : pool;
  const tracksFor = new Map(tracerPool.map((n) => [n, { pt: [], pv: [], qt: [], qv: [], st: [0], sv: [0, 0, 0] }]));
  let slot = 0;
  const rr = rnd(97 + times.length);
  states.forEach((st) => {
    for (let j = 0; j < pellets; j++) {
      const n = tracerPool[slot++ % tracerPool.length];
      const T = tracksFor.get(n);
      let dir = st.fwd.clone();
      if (pellets > 1) dir.add(st.up.clone().multiplyScalar((rr() - 0.5) * 0.08)).add(st.right.clone().multiplyScalar((rr() - 0.5) * 0.08)).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
      const t0 = st.t, t1 = Math.min(dur, st.t + life);
      const p0 = st.muzzle.clone().addScaledVector(dir, 0.02 * k), p1 = p0.clone().addScaledVector(dir, speed * (t1 - t0));
      if (T.pt.length && T.pt[T.pt.length - 1] >= t0) continue;
      T.pt.push(t0, t1); T.pv.push(...p0.toArray(), ...p1.toArray());
      T.qt.push(t0); T.qv.push(q.x, q.y, q.z, q.w);
      T.st.push(t0, t1); T.sv.push(k, k, k, 0, 0, 0);
    }
  });
  for (const [n, T] of tracksFor) {
    if (!T.pt.length) continue;
    tracks.push(new THREE.VectorKeyframeTrack(n.uuid + '.position', T.pt, T.pv));
    tracks.push(new THREE.QuaternionKeyframeTrack(n.uuid + '.quaternion', T.qt, T.qv, THREE.InterpolateDiscrete));
    tracks.push(new THREE.VectorKeyframeTrack(n.uuid + '.scale', T.st, T.sv, THREE.InterpolateDiscrete));
  }
  // casings: thrown out of the ejection port, fall, bounce, roll to a stop
  if (P.kind === 'gun') {
    const rig = model.humanoid;
    const up = rig ? rig.up.clone() : new THREE.Vector3(0, 1, 0);
    let floor = 0;
    if (rig) {
      const toes = ['leftToes', 'rightToes', 'leftFoot', 'rightFoot'].map((kk) => rig.map[kk] && rig.rest.get(rig.map[kk]).pos.dot(up)).filter((x) => x !== undefined && x !== null);
      floor = toes.length ? Math.min(...toes) - (rig.map.leftToes ? 0.02 : 0.06) * rig.hipHeight : 0;
    }
    const lifeC = 1.8; // in the air, a couple of bounces, then lie on the floor
    const ejectDelay = P.action === 'pump' ? 0.28 : P.action === 'bolt' ? 0.5 : 0.012;
    const ct = times.map((t) => t + ejectDelay).filter((t) => t < dur - 0.05);
    const cStates = sampleProp(model, prop, clip, ct);
    const nC = Math.min(16, Math.ceil(lifeC * (ct.length > 1 ? 1 / Math.max(1e-3, ct[1] - ct[0]) : 1)) + 1);
    const cp = poolOf(model, prop, 'casing', nC, makeCasing);
    const cTracks = new Map(cp.map((n) => [n, { pt: [], pv: [], qv: [], st: [0], sv: [0, 0, 0] }]));
    const g = 9.8 * k;
    const rc = rnd(17 + ct.length);
    cStates.forEach((st, i) => {
      const n = cp[i % cp.length];
      const T = cTracks.get(n);
      if (T.pt.length && T.pt[T.pt.length - 1] >= st.t) return;
      const v = st.right.clone().multiplyScalar((1.6 + rc() * 0.9) * k).addScaledVector(st.up, (1.4 + rc() * 0.8) * k).addScaledVector(st.fwd, (-0.4 + rc() * 0.3) * k);
      const spinAxis = new THREE.Vector3(rc() - 0.5, rc() - 0.5, rc() - 0.5).normalize();
      const spin = 18 + rc() * 14;
      const p = st.eject.clone();
      let q = st.q.clone();
      let landed = 0;
      const t1 = Math.min(dur - 1e-3, st.t + lifeC);
      const step = 1 / 60;
      for (let t = st.t; t <= t1 + 1e-6; t += step) {
        T.pt.push(t); T.pv.push(...p.toArray()); T.qv.push(q.x, q.y, q.z, q.w);
        v.addScaledVector(up, -g * step);
        p.addScaledVector(v, step);
        const h = p.dot(up) - floor;
        if (h < 0.004 * k) {
          p.addScaledVector(up, 0.004 * k - h);
          const vn = v.dot(up);
          if (vn < 0) v.addScaledVector(up, -vn * (landed < 2 ? 1.45 : 1));
          v.multiplyScalar(landed < 2 ? 0.55 : 0.8);
          landed++;
        }
        const sp = landed > 3 ? spin * 0.2 : spin;
        q = new THREE.Quaternion().setFromAxisAngle(spinAxis, sp * step).multiply(q);
      }
      T.st.push(st.t, t1 + 1e-4); T.sv.push(k, k, k, 0, 0, 0);
    });
    for (const [n, T] of cTracks) {
      if (!T.pt.length) continue;
      tracks.push(new THREE.VectorKeyframeTrack(n.uuid + '.position', T.pt, T.pv));
      tracks.push(new THREE.QuaternionKeyframeTrack(n.uuid + '.quaternion', T.pt, T.qv));
      tracks.push(new THREE.VectorKeyframeTrack(n.uuid + '.scale', T.st, T.sv, THREE.InterpolateDiscrete));
    }
  }
  for (const t of tracks) { t.validate?.(); clip.tracks.push(t); }
  clip.resetDuration();
  clip.duration = Math.max(clip.duration, dur);
  return clip;
}
