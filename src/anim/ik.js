// Inverse kinematics for posing: analytic two-bone IK (limbs) and CCD for longer chains.
import * as THREE from 'three';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();
const _q = new THREE.Quaternion(), _wq = new THREE.Quaternion(), _pq = new THREE.Quaternion();

function worldPos(o, out) { return out.setFromMatrixPosition(o.matrixWorld); }

// Rotate `bone` (in world space) by quaternion q, keeping its parent fixed.
function rotateWorld(bone, q) {
  bone.getWorldQuaternion(_wq);
  if (bone.parent) bone.parent.getWorldQuaternion(_pq); else _pq.identity();
  const newWorld = q.clone().multiply(_wq);
  bone.quaternion.copy(_pq.invert().multiply(newWorld)).normalize();
  bone.updateMatrixWorld(true);
}

// Bones from effector up `length` parents (excluding the effector).
export function ikChain(effector, length) {
  const chain = [];
  let o = effector.parent;
  while (o && chain.length < length && (o.isBone || o.parent)) {
    if (!o.isBone && chain.length) break;
    if (!o.isBone) break;
    chain.unshift(o);
    o = o.parent;
  }
  return chain;
}

// Move `effector` toward `target` (world) by rotating `chain` bones.
export function solveIK(chain, effector, target, opts = {}) {
  if (!chain.length) return;
  chain[0].updateWorldMatrix(true, true);
  if (chain.length === 2) return twoBone(chain[0], chain[1], effector, target, opts.pole);
  return ccd(chain, effector, target, opts.iterations || 12);
}

function twoBone(upper, middle, end, target, poleHint) {
  const a = worldPos(upper, new THREE.Vector3());
  const b = worldPos(middle, new THREE.Vector3());
  const c = worldPos(end, new THREE.Vector3());
  const l1 = a.distanceTo(b), l2 = b.distanceTo(c);
  if (l1 < 1e-6 || l2 < 1e-6) return ccd([upper, middle], end, target, 8);
  const toT = target.clone().sub(a);
  const d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-4, l1 + l2 - 1e-4);
  const dirT = toT.lengthSq() > 1e-12 ? toT.normalize() : b.clone().sub(a).normalize();
  // bend plane normal from current pose (or pole hint for a straight limb)
  let n = b.clone().sub(a).cross(c.clone().sub(b));
  if (n.lengthSq() < 1e-10) {
    const pole = poleHint || new THREE.Vector3(0, 0, 1);
    n = b.clone().sub(a).cross(pole);
    if (n.lengthSq() < 1e-10) n = b.clone().sub(a).cross(new THREE.Vector3(1, 0, 0));
  }
  n.normalize();
  const cosA = THREE.MathUtils.clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const A = Math.acos(cosA);
  // two candidate elbow positions; keep the one on the current bend side
  const e1 = dirT.clone().applyAxisAngle(n, A).multiplyScalar(l1).add(a);
  const e2 = dirT.clone().applyAxisAngle(n, -A).multiplyScalar(l1).add(a);
  // the correct side keeps the same sign of (elbow - a) x (target - elbow) . n
  const side = (e) => e.clone().sub(a).cross(target.clone().sub(e)).dot(n);
  const newB = side(e1) > 0 ? e1 : e2;
  _q.setFromUnitVectors(b.clone().sub(a).normalize(), newB.clone().sub(a).normalize());
  rotateWorld(upper, _q);
  const b2 = worldPos(middle, _b), c2 = worldPos(end, _c);
  _q.setFromUnitVectors(c2.clone().sub(b2).normalize(), target.clone().sub(b2).normalize());
  rotateWorld(middle, _q);
}

function ccd(chain, effector, target, iterations) {
  for (let it = 0; it < iterations; it++) {
    for (let i = chain.length - 1; i >= 0; i--) {
      const bone = chain[i];
      const bp = worldPos(bone, _a);
      const ep = worldPos(effector, _b);
      const toE = ep.clone().sub(bp), toT = target.clone().sub(bp);
      if (toE.lengthSq() < 1e-12 || toT.lengthSq() < 1e-12) continue;
      toE.normalize(); toT.normalize();
      const angle = toE.angleTo(toT);
      if (angle < 1e-4) continue;
      _q.setFromUnitVectors(toE, toT);
      // damp large steps for stability
      if (angle > 0.5) _q.slerp(new THREE.Quaternion(), 1 - 0.5 / angle);
      rotateWorld(bone, _q);
    }
    if (worldPos(effector, _c).distanceTo(target) < 1e-4) break;
  }
}
