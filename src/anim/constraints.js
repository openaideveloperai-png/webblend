// Bone constraints from .blend files, evaluated every frame after animation.
// MMD rigs, Rigify and many game rigs pose "control" bones and let
// constraints move the bones that actually deform the mesh (D bones, DEF-
// bones), so without this, posing those rigs does nothing visible.
//
// Supported: Copy Rotation / Location / Scale / Transforms, IK (with pole,
// chain length and per-bone IK locks and limits), Damped Track, Track To,
// Locked Track (as damped), Stretch To and Limit Rotation.
import * as THREE from 'three';

const Q1 = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), Q3 = new THREE.Quaternion(), Q4 = new THREE.Quaternion();
const V1 = new THREE.Vector3(), V2 = new THREE.Vector3(), V3 = new THREE.Vector3(), V4 = new THREE.Vector3();
const E1 = new THREE.Euler(), E2 = new THREE.Euler();
const M1 = new THREE.Matrix4();
const ID = new THREE.Quaternion();
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
// Blender euler order enum -> three.js order (Blender's XYZ is three's ZYX)
const ORDER = { 0: 'ZYX', 1: 'ZYX', 2: 'YZX', 3: 'ZXY', 4: 'XZY', 5: 'YXZ', 6: 'XYZ' };
const TRACK = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-1, 0, 0], [0, -1, 0], [0, 0, -1]];

const isLocal = (s) => s === 'LOCAL' || s === 'LOCAL_WITH_PARENT';
const sanitize = (n) => String(n || '').replace(/\s/g, '_').replace(/[[\].:/]/g, '');

export function hasConstraints(bones) {
  return bones.some((b) => b.userData.constraints && b.userData.constraints.length);
}

function armatureOf(o) {
  let p = o.parent;
  while (p && p.isBone) p = p.parent;
  return p;
}

// ---------------------------------------------------------------- rest-relative ("basis") transforms
function restQ(b, out) { const r = b.userData.rest; return r ? out.fromArray(r.q) : out.identity(); }
function basisQ(b, out) { return restQ(b, out).invert().multiply(b.quaternion); }
function setBasisQ(b, q) { restQ(b, Q4); b.quaternion.copy(Q4).multiply(q).normalize(); }
function basisP(b, out) {
  const r = b.userData.rest;
  if (!r) return out.copy(b.position);
  return out.copy(b.position).sub(V4.fromArray(r.p)).applyQuaternion(restQ(b, Q4).invert());
}
function setBasisP(b, p) {
  const r = b.userData.rest;
  if (!r) { b.position.copy(p); return; }
  b.position.copy(p).applyQuaternion(restQ(b, Q4)).add(V4.fromArray(r.p));
}
function worldQ(o, out) { o.updateWorldMatrix(true, false); return o.getWorldQuaternion(out); }
function worldP(o, out) { o.updateWorldMatrix(true, false); return out.setFromMatrixPosition(o.matrixWorld); }
function setWorldQ(o, q) {
  if (o.parent) { o.parent.updateWorldMatrix(true, false); o.parent.getWorldQuaternion(Q4); o.quaternion.copy(Q4.invert().multiply(q)).normalize(); }
  else o.quaternion.copy(q);
}
function setWorldP(o, p) {
  if (o.parent) { o.parent.updateWorldMatrix(true, false); o.position.copy(o.parent.worldToLocal(V4.copy(p))); }
  else o.position.copy(p);
}
function boneLength(b) { const r = b.userData.rest; return r && r.len ? r.len : (b.children.find((c) => c.isBone)?.position.length() || 0.1); }
// point along a bone (0 = head, 1 = tail) or an object's origin, in world space
function targetPoint(t, headTail, out) {
  worldP(t, out);
  if (t.isBone && headTail) out.lerp(t.localToWorld(V4.set(0, boneLength(t), 0)), headTail);
  return out;
}

function mixAxes(own, tgt, flag, order, out) {
  E1.setFromQuaternion(own, order);
  E2.setFromQuaternion(tgt, order);
  const keys = ['x', 'y', 'z'];
  for (let k = 0; k < 3; k++) {
    if (flag & (1 << k)) E1[keys[k]] = (flag & (16 << k)) ? -E2[keys[k]] : E2[keys[k]];
  }
  return out.setFromEuler(E1);
}

// ---------------------------------------------------------------- the solvers
const SOLVE = {
  COPY_ROTATION(it) {
    const { owner: o, target: t, c } = it;
    const all = (c.flag & 7) === 7 && !(c.flag & 112);
    const order = ORDER[c.eulerOrder] || 'ZYX';
    if (isLocal(c.ownerSpace) && isLocal(c.targetSpace)) {
      const own = basisQ(o, Q1), tq = t.isBone ? basisQ(t, Q2) : Q2.copy(t.quaternion);
      let nq = all ? Q3.copy(tq) : mixAxes(own, tq, c.flag, order, Q3);
      if (c.mix === 1 || c.mix === 3) nq = own.clone().multiply(nq); // add / after
      else if (c.mix === 2) nq = nq.clone().multiply(own); // before
      setBasisQ(o, own.clone().slerp(nq, c.influence));
      return;
    }
    // world / pose space: compare in armature space
    const arm = armatureOf(o);
    const A = arm ? worldQ(arm, new THREE.Quaternion()) : new THREE.Quaternion();
    const Ai = A.clone().invert();
    const own = Ai.clone().multiply(worldQ(o, Q1));
    const tq = Ai.clone().multiply(worldQ(t, Q2));
    let nq = all ? tq.clone() : mixAxes(own, tq, c.flag, order, new THREE.Quaternion());
    if (c.mix === 1 || c.mix === 3) nq = own.clone().multiply(nq);
    else if (c.mix === 2) nq = nq.clone().multiply(own);
    setWorldQ(o, A.multiply(own.slerp(nq, c.influence)));
  },

  COPY_LOCATION(it) {
    const { owner: o, target: t, c } = it;
    const flag = c.flag ?? 7;
    const mix = (own, tp) => {
      const np = own.clone();
      for (let k = 0; k < 3; k++) {
        if (!(flag & (1 << k))) continue;
        const v = tp.getComponent(k) * ((flag & (16 << k)) ? -1 : 1);
        np.setComponent(k, v + ((flag & 128) ? own.getComponent(k) : 0));
      }
      return own.lerp(np, c.influence);
    };
    if (isLocal(c.ownerSpace) && isLocal(c.targetSpace)) {
      const own = basisP(o, new THREE.Vector3()), tp = t.isBone ? basisP(t, V2) : V2.copy(t.position);
      setBasisP(o, mix(own, tp));
      return;
    }
    const arm = armatureOf(o) || o.parent;
    arm.updateWorldMatrix(true, false);
    const own = arm.worldToLocal(worldP(o, new THREE.Vector3()));
    const tp = arm.worldToLocal(targetPoint(t, c.headTail, V2));
    setWorldP(o, arm.localToWorld(mix(own, tp)));
  },

  COPY_SCALE(it) {
    const { owner: o, target: t, c } = it;
    const flag = c.flag ?? 7;
    const s = o.scale.clone();
    for (let k = 0; k < 3; k++) if (flag & (1 << k)) s.setComponent(k, t.scale.getComponent(k));
    o.scale.lerp(s, c.influence);
  },

  COPY_TRANSFORMS(it) {
    const { owner: o, target: t, c } = it;
    if (isLocal(c.ownerSpace) && isLocal(c.targetSpace)) {
      const p = basisP(o, new THREE.Vector3()), q = basisQ(o, new THREE.Quaternion());
      const tp = t.isBone ? basisP(t, V2) : V2.copy(t.position), tq = t.isBone ? basisQ(t, Q2) : Q2.copy(t.quaternion);
      setBasisP(o, p.lerp(tp, c.influence));
      setBasisQ(o, q.slerp(tq, c.influence));
      o.scale.lerp(t.scale, c.influence);
      return;
    }
    t.updateWorldMatrix(true, false);
    M1.copy(t.matrixWorld);
    if (o.parent) { o.parent.updateWorldMatrix(true, false); M1.premultiply(new THREE.Matrix4().copy(o.parent.matrixWorld).invert()); }
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
    M1.decompose(p, q, s);
    o.position.lerp(p, c.influence);
    o.quaternion.slerp(q, c.influence);
    o.scale.lerp(s, c.influence);
  },

  // MMD "append" (付与): add a share of another bone's rotation / movement
  INHERIT(it, ctx) {
    const { owner: o, target: t, c } = it;
    // a clip that keys this bone already holds its final pose (baked exports)
    if (ctx.animated && ctx.animated.has(o.uuid)) return;
    const r = c.ratio ?? 1;
    if (c.rotate) {
      const tq = t.isBone ? basisQ(t, Q2) : Q2.copy(t.quaternion);
      if (r < 0) tq.invert();
      const add = Q3.identity().slerp(tq, Math.abs(r));
      setBasisQ(o, basisQ(o, Q1).multiply(add));
    }
    if (c.translate) {
      const tp = t.isBone ? basisP(t, V2) : V2.copy(t.position);
      setBasisP(o, basisP(o, V1).addScaledVector(tp, r));
    }
  },

  // Child Of: follow the target as if parented to it (with Blender's "set inverse" matrix)
  CHILD_OF(it, ctx) {
    const { owner: o, target: t, c } = it;
    t.updateWorldMatrix(true, false);
    o.updateWorldMatrix(true, false);
    const res = new THREE.Matrix4().copy(t.matrixWorld);
    if (it.inverse) {
      // inverse is stored in Blender world space: convert to this scene's world
      const RW = ctx.blenderWorld();
      res.multiply(RW.clone().multiply(it.inverse).multiply(RW.clone().invert()));
    }
    res.multiply(o.matrixWorld);
    if (o.parent) { o.parent.updateWorldMatrix(true, false); res.premultiply(new THREE.Matrix4().copy(o.parent.matrixWorld).invert()); }
    const p = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    res.decompose(p, q, sc);
    o.position.lerp(p, c.influence);
    o.quaternion.slerp(q, c.influence);
    o.scale.lerp(sc, c.influence);
  },

  LIMIT_LOCATION(it, ctx) {
    const { owner: o, c } = it;
    const clampV = (v) => {
      const out = v.clone();
      for (let k = 0; k < 3; k++) {
        let x = out.getComponent(k);
        if (c.flag & (1 << (2 * k))) x = Math.max(x, c.min[k]);
        if (c.flag & (2 << (2 * k))) x = Math.min(x, c.max[k]);
        out.setComponent(k, x);
      }
      return out;
    };
    if (isLocal(c.ownerSpace)) {
      const cur = basisP(o, new THREE.Vector3());
      setBasisP(o, cur.clone().lerp(clampV(cur), c.influence));
      return;
    }
    // world / pose space: limits are in Blender's world coordinates
    const RW = ctx.blenderWorld();
    const inv = RW.clone().invert();
    const w = worldP(o, new THREE.Vector3());
    const b = w.clone().applyMatrix4(inv);
    const nb = b.clone().lerp(clampV(b), c.influence);
    setWorldP(o, nb.applyMatrix4(RW));
  },

  LIMIT_SCALE(it) {
    const { owner: o, c } = it;
    const sc = o.scale.clone();
    for (let k = 0; k < 3; k++) {
      let x = sc.getComponent(k);
      if (c.flag & (1 << (2 * k))) x = Math.max(x, c.min[k]);
      if (c.flag & (2 << (2 * k))) x = Math.min(x, c.max[k]);
      sc.setComponent(k, x);
    }
    o.scale.lerp(sc, c.influence);
  },

  LIMIT_ROTATION(it, ctx) {
    // a limit on a bone of an IK chain belongs to that IK: it runs just before
    // the IK solve (Blender's order), and not at all while the chain is posed by hand
    if (it.ikOwner && !it.runNow) return;
    const { owner: o, c } = it;
    const order = ORDER[c.eulerOrder] || 'ZYX';
    const clampE = () => {
      const keys = ['x', 'y', 'z'];
      let changed = false;
      for (let k = 0; k < 3; k++) {
        if (!(c.flag & (1 << k))) continue;
        const v = THREE.MathUtils.clamp(E1[keys[k]], c.min[k], c.max[k]);
        if (v !== E1[keys[k]]) { E1[keys[k]] = v; changed = true; }
      }
      return changed;
    };
    if (isLocal(c.ownerSpace) || !o.isBone) {
      const q = basisQ(o, Q1);
      E1.setFromQuaternion(q, order);
      if (!clampE()) return;
      setBasisQ(o, q.clone().slerp(Q2.setFromEuler(E1), c.influence));
      return;
    }
    // pose space = relative to the armature; world = Blender's world
    let S;
    if (c.ownerSpace === 'WORLD' && ctx) S = new THREE.Quaternion().setFromRotationMatrix(ctx.blenderWorld());
    else { const arm = armatureOf(o); S = arm ? worldQ(arm, new THREE.Quaternion()) : new THREE.Quaternion(); }
    const q = S.clone().invert().multiply(worldQ(o, Q1));
    E1.setFromQuaternion(q, order);
    if (!clampE()) return;
    setWorldQ(o, S.multiply(q.clone().slerp(Q2.setFromEuler(E1), c.influence)));
  },

  DAMPED_TRACK(it) { track(it, c => c.track ?? 1); },
  LOCKED_TRACK(it) { track(it, c => c.track ?? 1); },
  TRACK_TO(it) { track(it, c => c.track ?? 1); },

  STRETCH_TO(it) {
    const { owner: o, target: t, c } = it;
    track(it, () => 1);
    const head = worldP(o, V1);
    const dist = targetPoint(t, c.headTail, V2).distanceTo(head);
    o.parent?.updateWorldMatrix(true, false);
    const ps = o.parent ? V3.setFromMatrixScale(o.parent.matrixWorld).y : 1;
    const rest = (c.restLength || boneLength(o)) * ps;
    if (rest > 1e-6) {
      const r = THREE.MathUtils.lerp(1, dist / rest, c.influence);
      const side = 1 / Math.sqrt(Math.max(r, 1e-3));
      o.scale.set(side, r, side);
    }
  },

  IK(it, ctx) {
    if (!ctx.engaged(it)) return;
    const { owner, target, c, chain } = it;
    if (!chain.length) return;
    // limits on the chain bones set the pose the IK starts from
    if (it.limits) for (const l of it.limits) { l.runNow = true; SOLVE.LIMIT_ROTATION(l, ctx); l.runNow = false; }
    const saved = c.influence < 1 ? chain.map((b) => b.quaternion.clone()) : null;
    const tip = c.useTail ? owner : owner.parent;
    const eff = new THREE.Vector3(0, c.useTail ? boneLength(owner) : 0, 0);
    // effector expressed on the last chain bone
    const effOn = (b) => {
      if (b === owner) return eff;
      if (owner.parent === b) return owner.position.clone();
      b.updateWorldMatrix(true, false);
      return b.worldToLocal(worldP(owner, new THREE.Vector3()));
    };
    const goal = targetPoint(target, 0, new THREE.Vector3());
    const pole = it.pole ? targetPoint(it.pole, 0, new THREE.Vector3()) : null;
    const last = chain[chain.length - 1];
    void tip;
    let hint = pole;
    if (!hint && c.poleForward && ctx.root) {
      ctx.root.updateWorldMatrix(true, false);
      const fwd = new THREE.Vector3(0, 0, 1).transformDirection(ctx.root.matrixWorld);
      hint = worldP(chain[0], new THREE.Vector3()).addScaledVector(fwd, 1000);
    }
    if (chain.length === 1) aim(last, effOn(last), goal);
    else if (chain.length === 2) twoBone(chain[0], chain[1], effOn(last), goal, hint);
    else ccd(chain, last, effOn(last), goal, Math.min(c.iterations || 40, 40));
    if (saved) chain.forEach((b, i) => { b.quaternion.copy(saved[i].slerp(b.quaternion, c.influence)); });
  },
};

function track(it, axisOf) {
  const { owner: o, target: t, c } = it;
  const head = worldP(o, V1);
  const des = targetPoint(t, c.headTail, V2).sub(head);
  if (des.lengthSq() < 1e-14) return;
  des.normalize();
  const ow = worldQ(o, Q1);
  const ax = TRACK[axisOf(c)] || TRACK[1];
  const cur = V3.set(ax[0], ax[1], ax[2]).applyQuaternion(ow);
  Q2.setFromUnitVectors(cur, des);
  const nw = Q3.copy(Q2).multiply(ow);
  setWorldQ(o, ow.clone().slerp(nw, c.influence));
}

// IK helpers ------------------------------------------------------
function rotateWorld(b, q) {
  const w = worldQ(b, Q1);
  setWorldQ(b, Q2.copy(q).multiply(w));
  b.updateWorldMatrix(false, false);
}

// keep a bone inside its IK locks / limits
function enforceDOF(b) {
  const ik = b.userData.ik;
  if (!ik) return;
  const q = basisQ(b, Q3);
  E1.setFromQuaternion(q, 'ZYX');
  const keys = ['x', 'y', 'z'];
  for (let k = 0; k < 3; k++) {
    if (ik.lock[k]) E1[keys[k]] = 0;
    else if (ik.limit[k]) E1[keys[k]] = THREE.MathUtils.clamp(E1[keys[k]], ik.min[k], ik.max[k]);
  }
  setBasisQ(b, Q3.setFromEuler(E1));
}

// how far a bone's pose is outside its limits (radians)
function limitViolation(b) {
  const ik = b.userData.ik;
  if (!ik) return 0;
  E1.setFromQuaternion(basisQ(b, Q3), 'ZYX');
  const keys = ['x', 'y', 'z'];
  let v = 0;
  for (let k = 0; k < 3; k++) {
    const a = E1[keys[k]];
    if (ik.lock[k]) v += Math.abs(a);
    else if (ik.limit[k]) v += Math.max(0, ik.min[k] - a, a - ik.max[k]);
  }
  return v;
}

// the one axis a bone may bend around, in world space (MMD knees, elbows)
function hingeAxis(b) {
  const ik = b.userData.ik;
  if (!ik) return null;
  const free = [0, 1, 2].filter((k) => !ik.lock[k] && !(ik.limit[k] && Math.abs(ik.max[k] - ik.min[k]) < 1e-4));
  if (free.length !== 1) return null;
  b.parent.updateWorldMatrix(true, false);
  const pq = b.parent.getWorldQuaternion(new THREE.Quaternion());
  return AXES[free[0]].clone().applyQuaternion(pq.multiply(restQ(b, Q3)));
}

function aim(b, effLocal, goal) {
  const head = worldP(b, V1).clone();
  const e = b.localToWorld(V2.copy(effLocal)).sub(head);
  const t = V3.copy(goal).sub(head);
  if (e.lengthSq() < 1e-14 || t.lengthSq() < 1e-14) return;
  rotateWorld(b, Q4.setFromUnitVectors(e.normalize(), t.normalize()));
  enforceDOF(b);
}

// Two bones where the middle one is a hinge (knee/elbow with IK locks or
// limits): pick the hinge angle that gives exactly the needed reach, aim the
// upper bone, then swivel so the knee stays near its current direction (or
// toward the pole / hint).
function hingeTwoBone(upper, middle, effLocal, goal, hint, free) {
  const ik = middle.userData.ik;
  const axis = AXES[free];
  const rq = restQ(middle, new THREE.Quaternion());
  const lo = ik.limit[free] ? ik.min[free] : -Math.PI, hi = ik.limit[free] ? ik.max[free] : Math.PI;
  const hip = worldP(upper, new THREE.Vector3());
  // the hinge axis before solving: kept where it is when there's no pole
  // (Blender's solver turns the chain the least it can)
  const hingeW = () => axis.clone().applyQuaternion(rq).applyQuaternion(worldQ(upper, Q3));
  const hinge0 = hingeW();
  upper.updateWorldMatrix(true, false);
  const s = V3.setFromMatrixScale(upper.matrixWorld).x || 1;
  const want = goal.distanceTo(hip) / s;
  const e = new THREE.Vector3(), q = new THREE.Quaternion(), aq = new THREE.Quaternion();
  const reach = (th) => {
    q.copy(rq).multiply(aq.setFromAxisAngle(axis, th));
    return e.copy(effLocal).multiply(middle.scale).applyQuaternion(q).add(middle.position).length() - want;
  };
  // current hinge angle (prefer the solution closest to it)
  E1.setFromQuaternion(basisQ(middle, Q3), 'ZYX');
  const cur = [E1.x, E1.y, E1.z][free];
  const N = 72;
  let best = null, bestScore = Infinity, fallback = lo, fallbackErr = Infinity;
  let prevT = lo, prevF = reach(lo);
  for (let i = 1; i <= N; i++) {
    const t = lo + ((hi - lo) * i) / N;
    const f = reach(t);
    if (Math.abs(prevF) < fallbackErr) { fallbackErr = Math.abs(prevF); fallback = prevT; }
    if (Math.abs(f) < fallbackErr) { fallbackErr = Math.abs(f); fallback = t; }
    if ((prevF <= 0 && f >= 0) || (prevF >= 0 && f <= 0)) {
      let a = prevT, b = t, fa = prevF;
      for (let k = 0; k < 30; k++) {
        const m = (a + b) / 2, fm = reach(m);
        if ((fa <= 0 && fm <= 0) || (fa >= 0 && fm >= 0)) { a = m; fa = fm; } else b = m;
      }
      const root = (a + b) / 2;
      const score = Math.abs(root - cur);
      if (score < bestScore) { bestScore = score; best = root; }
    }
    prevT = t; prevF = f;
  }
  const th = best ?? fallback; // out of reach: as close as the limits allow
  middle.quaternion.copy(rq).multiply(aq.setFromAxisAngle(axis, th));
  // aim the upper bone so the effector lies on the line to the goal
  middle.updateWorldMatrix(true, false);
  const effW = middle.localToWorld(effLocal.clone());
  const toE = effW.sub(hip), toG = goal.clone().sub(hip);
  if (toE.lengthSq() > 1e-14 && toG.lengthSq() > 1e-14) rotateWorld(upper, Q4.setFromUnitVectors(toE.normalize(), toG.clone().normalize()));
  // swivel around the hip -> goal line: knee toward the pole / hint, or the
  // hinge axis back where it was
  if (toG.lengthSq() > 1e-14) {
    const ax = toG.normalize();
    let cur, ref;
    if (hint) {
      cur = worldP(middle, new THREE.Vector3()).sub(hip);
      ref = hint.clone().sub(hip);
    } else {
      cur = hingeW();
      ref = hinge0.clone();
    }
    cur.addScaledVector(ax, -cur.dot(ax));
    ref.addScaledVector(ax, -ref.dot(ax));
    if (cur.lengthSq() > 1e-12 && ref.lengthSq() > 1e-12) {
      cur.normalize(); ref.normalize();
      const ang = Math.atan2(cur.clone().cross(ref).dot(ax), cur.dot(ref));
      if (Math.abs(ang) > 1e-6) rotateWorld(upper, Q4.setFromAxisAngle(ax, ang));
    }
  }
}

function hingeIndex(b) {
  const ik = b.userData.ik;
  if (!ik) return -1;
  const free = [0, 1, 2].filter((k) => !ik.lock[k] && !(ik.limit[k] && Math.abs(ik.max[k] - ik.min[k]) < 1e-4));
  return free.length === 1 ? free[0] : -1;
}

function twoBone(upper, middle, effLocal, goal, pole) {
  const hingeK = hingeIndex(middle);
  if (hingeK >= 0) { hingeTwoBone(upper, middle, effLocal, goal, pole, hingeK); return; }
  const a = worldP(upper, new THREE.Vector3());
  const b = worldP(middle, new THREE.Vector3());
  middle.updateWorldMatrix(false, false);
  const c = middle.localToWorld(effLocal.clone());
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  if (l1 < 1e-6 || l2 < 1e-6) { ccd([upper, middle], middle, effLocal, goal, 10); return; }
  const toT = goal.clone().sub(a);
  const d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-5, l1 + l2 - 1e-5);
  const dir = toT.lengthSq() > 1e-12 ? toT.normalize() : b.clone().sub(a).normalize();
  // bend plane normal: pole target, hinge axis, or the current bend
  const hinge = hingeAxis(middle);
  let n;
  if (pole) n = dir.clone().cross(pole.clone().sub(a)).negate();
  else if (hinge) n = hinge.clone();
  else n = b.clone().sub(a).cross(c.clone().sub(b));
  if (n.lengthSq() < 1e-10) n = AXES[0].clone().applyQuaternion(worldQ(middle, Q1));
  n.sub(dir.clone().multiplyScalar(n.dot(dir)));
  if (n.lengthSq() < 1e-10) n = new THREE.Vector3(1, 0, 0).cross(dir);
  n.normalize();
  const A = Math.acos(THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1));
  const q0 = upper.quaternion.clone(), m0 = middle.quaternion.clone();
  const apply = (sign) => {
    upper.quaternion.copy(q0); middle.quaternion.copy(m0);
    const e = dir.clone().applyAxisAngle(n, sign * A).multiplyScalar(l1).add(a);
    const b0 = worldP(middle, V1).clone();
    rotateWorld(upper, Q4.setFromUnitVectors(b0.sub(a).normalize(), e.clone().sub(a).normalize()));
    const b2 = worldP(middle, V1).clone();
    middle.updateWorldMatrix(false, false);
    const c2 = middle.localToWorld(effLocal.clone());
    rotateWorld(middle, Q4.setFromUnitVectors(c2.sub(b2).normalize(), goal.clone().sub(b2).normalize()));
    return e;
  };
  // smallest change from the current pose breaks ties (like Blender's iterative solver)
  const change = () => upper.quaternion.angleTo(q0) + middle.quaternion.angleTo(m0);
  const score = (sign) => {
    const e = apply(sign);
    if (middle.userData.ik) return limitViolation(middle) * 100 + change();
    if (pole) return -e.clone().sub(a).dot(pole.clone().sub(a));
    // keep the current bend side
    const side = e.clone().sub(a).cross(goal.clone().sub(e)).dot(curBend);
    return Math.abs(side) > 1e-9 ? -side : change();
  };
  const curBend = b.clone().sub(a).cross(c.clone().sub(b));
  const s1 = score(1), s2 = score(-1);
  apply(s1 <= s2 ? 1 : -1);
  if (middle.userData.ik) enforceDOF(middle);
}

function ccd(chain, last, effLocal, goal, iterations) {
  for (let it = 0; it < iterations; it++) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const bone = chain[i];
      const bp = worldP(bone, V1).clone();
      last.updateWorldMatrix(true, false);
      const ep = last.localToWorld(V2.copy(effLocal));
      const toE = ep.sub(bp), toT = V3.copy(goal).sub(bp);
      if (toE.lengthSq() < 1e-12 || toT.lengthSq() < 1e-12) continue;
      toE.normalize(); toT.normalize();
      const angle = toE.angleTo(toT);
      if (angle < 1e-5) continue;
      Q4.setFromUnitVectors(toE, toT);
      if (angle > 0.4) Q4.slerp(ID, 1 - 0.4 / angle);
      rotateWorld(bone, Q4);
      enforceDOF(bone);
    }
    last.updateWorldMatrix(true, false);
    if (last.localToWorld(V2.copy(effLocal)).distanceTo(goal) < 1e-5) break;
  }
}

// ---------------------------------------------------------------- solver
export class ConstraintSolver {
  constructor(root, bones) {
    this.root = root;
    this.items = [];
    this.zup = root.getObjectByName('Z-up') || null;
    const objByName = new Map();
    root.traverse((o) => {
      if (o.isBone || !o.name) return;
      if (!objByName.has(o.name)) objByName.set(o.name, o);
      const sn = sanitize(o.name);
      if (!objByName.has(sn)) objByName.set(sn, o);
    });
    const boneMaps = new Map();
    const boneIn = (arm, name) => {
      let m = boneMaps.get(arm);
      if (!m) {
        m = new Map();
        arm.traverse((o) => { if (o.isBone) { if (!m.has(o.name)) m.set(o.name, o); const sn = sanitize(o.name); if (!m.has(sn)) m.set(sn, o); } });
        boneMaps.set(arm, m);
      }
      return m.get(name) || m.get(sanitize(name)) || null;
    };
    const resolve = (owner, obj, sub) => {
      if (!obj) return sub ? boneIn(armatureOf(owner), sub) : null; // same skeleton (MMD files)
      let node = objByName.get(obj) || objByName.get(sanitize(obj));
      if (!node && obj) {
        // target is this armature, but the object was renamed on import
        node = armatureOf(owner);
        if (sub && !boneIn(node, sub)) return null;
      }
      if (!node) return null;
      if (sub) {
        const arm = node.isBone ? armatureOf(node) : node;
        return boneIn(arm, sub);
      }
      return node;
    };
    this.unresolved = 0;
    for (const b of bones) {
      for (const c of b.userData.constraints || []) {
        const noTarget = c.type === 'LIMIT_ROTATION' || c.type === 'LIMIT_LOCATION' || c.type === 'LIMIT_SCALE';
        const target = noTarget ? null : resolve(b, c.target, c.subtarget);
        if (!noTarget && (!target || target === b)) { this.unresolved++; continue; }
        const it = { owner: b, c, target, pole: null, chain: [] };
        if (c.type === 'CHILD_OF' && c.inverse && c.inverse.length === 16) it.inverse = new THREE.Matrix4().fromArray(c.inverse);
        if (c.type === 'IK') {
          if (c.pole) it.pole = resolve(b, c.pole, c.poleSub);
          if (c.links && c.links.length) {
            // explicit chain, listed from the effector up (MMD)
            it.chain = c.links.map((n) => resolve(b, '', n)).filter(Boolean).reverse();
          } else {
            let o = c.useTail ? b : b.parent;
            const max = c.chain > 0 ? c.chain : 255;
            while (o && o.isBone && it.chain.length < max) { it.chain.unshift(o); o = o.parent; }
          }
          it.restTarget = target.isBone ? null : { p: target.position.clone(), q: target.quaternion.clone() };
        }
        this.items.push(it);
      }
    }
    // rotation limits on IK chain bones go with their IK (see LIMIT_ROTATION)
    for (const ik of this.items) {
      if (ik.c.type !== 'IK') continue;
      const chain = new Set(ik.chain);
      for (const l of this.items) {
        if (l.c.type === 'LIMIT_ROTATION' && !l.ikOwner && chain.has(l.owner)) { l.ikOwner = ik; (ik.limits || (ik.limits = [])).push(l); }
      }
    }
    this.order = this.sortItems();
    this.driven = new Map(); // bone -> bones driving its rotation
    for (const it of this.items) {
      const full = it.c.type === 'COPY_TRANSFORMS' || (it.c.type === 'COPY_ROTATION' && ((it.c.flag ?? 7) & 7) === 7)
        || (it.c.type === 'INHERIT' && it.c.rotate && Math.abs(Math.abs(it.c.ratio ?? 1) - 1) < 1e-3);
      if (full && it.c.influence > 0.99 && it.target.isBone) {
        if (!this.driven.has(it.owner)) this.driven.set(it.owner, []);
        this.driven.get(it.owner).push(it.target);
      }
    }
    this.ikTargets = new Set(this.items.filter((it) => it.c.type === 'IK').map((it) => it.target));
    // every bone the solver writes to, and its pose before constraints
    this.touched = this.affectedBones();
    this.state = new Map(this.touched.map((b) => [b, { base: snap(b), post: null }]));
  }

  // Constraints apply on top of the animated / hand-posed transform, not on
  // top of their own result from the last frame.
  restoreBase() {
    for (const b of this.touched) {
      const st = this.state.get(b);
      if (st.post && same(b, st.post)) load(b, st.base);
      else st.base = snap(b, st.base);
    }
  }

  saveState() { return new Map([...this.state].map(([b, st]) => [b, { base: st.base && snap0(st.base), post: st.post && snap0(st.post) }])); }
  loadState(saved) { this.state = saved; }

  get count() { return this.items.length; }

  // targets must be solved before the bones that read them; parents before children
  sortItems() {
    const items = this.items;
    const writes = items.map((it) => (it.c.type === 'IK' ? it.chain : [it.owner]));
    const reads = items.map((it) => {
      const set = new Set();
      const addUp = (o) => { for (let p = o; p && p !== this.root; p = p.parent) set.add(p); };
      if (it.target) addUp(it.target);
      if (it.pole) addUp(it.pole);
      addUp((it.c.type === 'IK' ? it.chain[0] : it.owner)?.parent);
      return set;
    });
    const n = items.length;
    const indeg = new Array(n).fill(0);
    const edges = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        // i before j if i writes something j reads, or same owner in stack order
        const before = writes[i].some((b) => reads[j].has(b)) || (items[i].owner === items[j].owner && i < j);
        if (before) { edges[i].push(j); indeg[j]++; }
      }
    }
    const out = [];
    const queue = [];
    for (let i = 0; i < n; i++) if (!indeg[i]) queue.push(i);
    while (queue.length) {
      const i = queue.shift();
      out.push(items[i]);
      for (const j of edges[i]) if (--indeg[j] === 0) queue.push(j);
    }
    if (out.length < n) for (const it of items) if (!out.includes(it)) out.push(it); // cycle: keep file order
    return out;
  }

  // animated: Set of node uuids that playing clips animate
  solve(animated) {
    // a motion that keys any IK handle is an IK motion (MMD dances): all IK on.
    // Otherwise IK engages when its handle is moved, or when nobody has posed
    // the chain (like Blender at rest); FK motions (AI, retargeted clips) and
    // bones rotated by hand aren't pinned by handles sitting at rest.
    let ikMotion = false;
    if (animated) for (const t of this.ikTargets) if (animated.has(t.uuid)) { ikMotion = true; break; }
    const zup = this.zup;
    const ctx = {
      animated,
      root: this.root,
      blenderWorld: () => { if (zup) { zup.updateWorldMatrix(true, false); return zup.matrixWorld.clone(); } this.root.updateWorldMatrix(true, false); return this.root.matrixWorld.clone(); },
      engaged: (it) => {
        const t = it.target;
        if (ikMotion || it.unposed) return true;
        for (let p = t.parent; p && p.isBone; p = p.parent) if (animated && animated.has(p.uuid) && !isAncestorOf(p, it.owner)) return true;
        const r = t.userData.rest;
        if (r) return moved(t, V3.fromArray(r.p), Q3.fromArray(r.q));
        if (it.restTarget) return moved(t, it.restTarget.p, it.restTarget.q);
        return true;
      },
    };
    this.restoreBase();
    // chains nobody animates or has rotated (checked before any constraint runs)
    for (const it of this.order) {
      if (it.c.type !== 'IK') continue;
      it.unposed = it.chain.length > 0 && it.chain.every((b) => {
        if (animated && animated.has(b.uuid)) return false;
        const r = b.userData.rest;
        return !!r && !moved(b, V3.fromArray(r.p), Q3.fromArray(r.q));
      });
    }
    for (const it of this.order) {
      if (!(it.c.influence > 0)) continue;
      const fn = SOLVE[it.c.type];
      if (fn) fn(it, ctx);
    }
    for (const b of this.touched) { const st = this.state.get(b); st.post = snap(b, st.post); }
  }

  // bones whose transforms the solver may change (for baking)
  affectedBones() {
    const set = new Set();
    for (const it of this.items) {
      if (it.c.type === 'IK') for (const b of it.chain) set.add(b);
      else set.add(it.owner);
    }
    return [...set];
  }
}

function isAncestorOf(a, b) { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; }

// has a handle been moved away from its rest pose? (tolerant of float32 data)
function moved(o, p, q) {
  const tol = 1e-5 * Math.max(1, p.length());
  if (Math.abs(o.position.x - p.x) > tol || Math.abs(o.position.y - p.y) > tol || Math.abs(o.position.z - p.z) > tol) return true;
  const d = Math.abs(o.quaternion.dot(q)) / Math.max(1e-12, o.quaternion.length() * q.length());
  return d < 1 - 1e-7;
}

function snap(o, out) {
  if (!out) return { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() };
  out.p.copy(o.position); out.q.copy(o.quaternion); out.s.copy(o.scale);
  return out;
}
function snap0(t) { return { p: t.p.clone(), q: t.q.clone(), s: t.s.clone() }; }
function load(o, t) { o.position.copy(t.p); o.quaternion.copy(t.q); o.scale.copy(t.s); }
function same(o, t) { return o.position.equals(t.p) && o.quaternion.equals(t.q) && o.scale.equals(t.s); }

// Bake what the constraints do into a clip (for exporting to other apps).
export function bakeConstraints(model, clip, fps = 30) {
  const solver = model.constraints;
  if (!solver || !solver.count) return clip;
  const bones = solver.affectedBones();
  if (!bones.length) return clip;
  const root = model.root;
  const all = [];
  root.traverse((o) => all.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const savedState = solver.saveState();
  solver.restoreBase();
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip, root);
  action.play();
  const animated = new Set(clip.tracks.map((t) => t.name.slice(0, t.name.indexOf('.'))));
  const base = new Map(bones.map((b) => [b, [b.position.clone(), b.quaternion.clone(), b.scale.clone()]]));
  const n = Math.max(2, Math.round(clip.duration * fps) + 1);
  const times = new Float32Array(n);
  const data = new Map(bones.map((b) => [b, { p: new Float32Array(n * 3), q: new Float32Array(n * 4), s: new Float32Array(n * 3) }]));
  for (let i = 0; i < n; i++) {
    const t = Math.min(clip.duration, i / fps);
    times[i] = t;
    for (const [b, [p, q, s]] of base) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(s); }
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    solver.solve(animated);
    for (const b of bones) {
      const d = data.get(b);
      b.position.toArray(d.p, i * 3);
      b.quaternion.toArray(d.q, i * 4);
      b.scale.toArray(d.s, i * 3);
    }
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  for (const [o, p, q, s] of all) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
  solver.loadState(savedState);
  root.updateMatrixWorld(true);
  const out = clip.clone();
  const names = new Set();
  const tracks = [];
  for (const b of bones) {
    const d = data.get(b);
    const pn = `${b.uuid}.position`, qn = `${b.uuid}.quaternion`, sn = `${b.uuid}.scale`;
    names.add(pn); names.add(qn); names.add(sn);
    tracks.push(new THREE.VectorKeyframeTrack(pn, times, d.p), new THREE.QuaternionKeyframeTrack(qn, times, d.q));
    if (d.s.some((v) => Math.abs(v - 1) > 1e-4)) tracks.push(new THREE.VectorKeyframeTrack(sn, times, d.s));
  }
  out.tracks = out.tracks.filter((t) => !names.has(t.name)).concat(tracks);
  return out;
}
