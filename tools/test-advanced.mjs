// Advanced character settings: your own lip bones, more than one mouth, where the soft
// skin is off, and the soft-skin numbers. Built on the soft-lips test mouth (no files needed).
// Usage: node tools/test-advanced.mjs
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mouthy } from './test-softlips.mjs';
import { softLips, softLipsExtra, allSoftLips, resetLips } from '../src/anim/softlips.js';
import { softSkin, SKIN_TUNE } from '../src/anim/softskin.js';
import { lipBones, mirrorBone, childBones } from '../src/anim/select.js';
import { bonePart } from '../src/core/joints.js';

let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };

// ---- lip bones found by name; then the user's own pick
{
  const { model, lipU, lipL } = mouthy();
  const auto = lipBones(model);
  ok('lip bones found by name', auto.length === 2 && auto.includes(lipU) && auto.includes(lipL), auto.map((b) => b.name).join());
  // rename so nothing looks like a lip: no name match, so soft lips can't find them
  lipU.name = 'mouthA'; lipL.name = 'mouthB';
  model.poses = [];
  resetLips(model);
  ok('renamed lip bones and no mouth shape: no lips found', !softLips(model));
  model.lipBones = ['mouthA', 'mouthB'];
  resetLips(model);
  const s = softLips(model);
  ok('your own lip bones: soft lips find the lips there', s && s.N > 200, s ? `N ${s.N}` : 'none');
  if (s) {
    const up = [...s.side].filter((x) => x > 0).length, lo = [...s.side].filter((x) => x < 0).length;
    ok('…upper and lower lip told apart from the bones\' heights', Math.abs(up - lo) < 20 && up > 50, `${up} / ${lo}`);
  }
  ok('Tools → Select lip bones uses your pick', lipBones(model).map((b) => b.name).join() === 'mouthA,mouthB');
}

// ---- 6 lip bones in a ring, not named as lips, parented outside the head, partly weighted
function ringMouth({ parentName = 'Neck', w = 0.4, side = false } = {}) {
  // side: the slit runs front to back on the left of the head, facing left (a muzzle mouth)
  const C = side ? [0.07, 1.6, 0.06] : [0, 1.6, 0.115];
  const at = (a, y, o) => (side ? [C[0] + o, y, C[2] + a] : [C[0] + a, y, C[2] + o]); // across, height, out
  const size = (a, y, o) => (side ? [o, y, a] : [a, y, o]);
  const t = mouthy();
  const { model } = t;
  const root = model.root;
  // drop the named lip mesh: this mouth is made of its own bones
  const old = root.getObjectByName('Mouth');
  old.parent.remove(old);
  model.skinned = model.skinned.filter((x) => x !== old);
  const head = root.getObjectByName('Head'), parent = root.getObjectByName(parentName) || head;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
  const bone = (name, p) => { const b = new THREE.Bone(); b.name = name; b.position.copy(new THREE.Vector3(...p).applyMatrix4(inv)); parent.add(b); return b; };
  const xs = [-0.018, 0, 0.018];
  const ups = xs.map((x, k) => bone('ring' + k, at(x, 1.603, 0))), los = xs.map((x, k) => bone('ring' + (k + 3), at(x, 1.597, 0)));
  root.updateMatrixWorld(true);
  const bones = [head, ...ups, ...los];
  const geos = [[1.603, ups], [1.597, los]].map(([y, set]) => {
    const g = side ? new THREE.BoxGeometry(...size(0.05, 0.006, 0.01), 4, 3, 24) : new THREE.BoxGeometry(0.05, 0.006, 0.01, 24, 3, 4);
    g.translate(...at(0, y, 0));
    const n = g.attributes.position.count, P = g.attributes.position;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = side ? P.getZ(i) - C[2] : P.getX(i);
      const k = x < -0.009 ? 0 : x > 0.009 ? 2 : 1;
      si[i * 4] = bones.indexOf(set[k]); sw[i * 4] = w;
      si[i * 4 + 1] = 0; sw[i * 4 + 1] = 1 - w; // the rest on the head
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    return g;
  });
  const mesh = new THREE.SkinnedMesh(mergeGeometries(geos), new THREE.MeshStandardMaterial());
  mesh.name = 'RingMouth';
  root.add(mesh); root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones), mesh.matrixWorld);
  model.skinned.push(mesh);
  model.bones.push(...ups, ...los);
  let n = 0; root.traverse(() => n++); model.nodeCount = n;
  model.poses = [];
  return { ...t, model, ups, los };
}
for (const [label, opts] of [['under the neck, 40% weight', { parentName: 'Neck', w: 0.4 }], ['under the head, 30% weight', { parentName: 'Head', w: 0.3 }], ['under the head, full weight', { parentName: 'Head', w: 1 }]]) {
  const { model, ups, los } = ringMouth(opts);
  ok(`6 ring bones (${label}): no lips found by themselves`, !softLips(model));
  model.lipBones = [...ups, ...los].map((b) => b.name);
  resetLips(model);
  const s = softLips(model);
  ok(`…your pick of them makes the lips (${label})`, s && s.N > 200, s ? `N ${s.N}` : `none: ${model._lipWhy}`);
  if (s) {
    const up = [...s.side].filter((x) => x > 0).length, lo = [...s.side].filter((x) => x < 0).length;
    ok(`…upper and lower lip told apart (${label})`, Math.abs(up - lo) < 30 && up > 50, `${up} / ${lo}`);
  }
}

// ---- a mouth along the muzzle (slit front to back, facing sideways): measured in its own frame
{
  const { model, ups, los } = ringMouth({ parentName: 'Head', w: 1, side: true });
  model.lipBones = [...ups, ...los].map((b) => b.name);
  resetLips(model);
  const s = softLips(model);
  ok('side mouth: soft lips found', s && s.N > 200, s ? `N ${s.N}` : `none: ${model._lipWhy}`);
  if (s) {
    const fwd = s.probe.axes.fwd.clone().applyQuaternion(model.root.getObjectByName('Head').getWorldQuaternion(new THREE.Quaternion()));
    ok('…its own frame faces out of the mouth (sideways), not the head\'s forward', fwd.x > 0.9, fwd.toArray().map((x) => x.toFixed(2)).join());
    ok('…its width is the slit\'s length (5 cm), not its depth', Math.abs(s.hw - 0.025) < 0.004, `half width ${(s.hw * 100).toFixed(1)} cm`);
    const up = [...s.side].filter((x) => x > 0).length, lo = [...s.side].filter((x) => x < 0).length;
    ok('…upper and lower lip told apart', Math.abs(up - lo) < 30 && up > 50, `${up} / ${lo}`);
    // a finger pushed between the lips from the side, across the slit
    const rig = model.humanoid;
    const head = model.root.getObjectByName('Head');
    // a stand-in finger: a capsule through the middle of the slit, out of the mouth's face
    const c = new THREE.Vector3(0.07, 1.6, 0.06);
    const capsule = { a: c.clone().add(new THREE.Vector3(0.05, 0, 0)), b: c.clone().add(new THREE.Vector3(-0.012, 0, 0)), r: 0.007 };
    s.capsules = function () { const F = this.F, A = capsule.a, B = capsule.b; return [{ ax: F.x(A), ay: F.y(A), az: F.z(A), bx: F.x(B), by: F.y(B), bz: F.z(B), r: capsule.r }]; };
    const st = s.update({ write: false });
    ok('a finger between the side lips: they wrap around it, nothing left inside', st.active && st.leftCm === 0 && st.pushCm > 0.3, JSON.stringify(st));
    // lip line along the slit: up / down where the finger is, closed toward the ends
    const rows = (sd) => { const out = []; for (let i = 0; i < s.N; i++) { if (s.side[i] !== sd) continue; const y = s.P[i * 3 + 1]; if (Math.abs(y - s.C.y) < 0.0005) out.push([s.P[i * 3], s.D[i * 3 + 1] * 1000]); } return out.sort((a, b) => a[0] - b[0]); };
    const U = rows(1), L = rows(-1);
    const near = (row, x) => row.reduce((b, r) => (Math.abs(r[0] - x) < Math.abs(b[0] - x) ? r : b), row[0])[1];
    const xc = s.C.x;
    ok('…upper lip over it, lower lip under it, closed again at the ends', near(U, xc) > 3 && near(L, xc) < -3 && Math.abs(near(U, xc + 0.023)) < near(U, xc) * 0.35 && Math.abs(near(U, xc - 0.023)) < near(U, xc) * 0.35, `${near(U, xc).toFixed(1)} / ${near(L, xc).toFixed(1)} mm, ends ${near(U, xc - 0.023).toFixed(1)} ${near(U, xc + 0.023).toFixed(1)}`);
    // the finger along the slit instead, in from its front end to the middle
    capsule.a = c.clone().add(new THREE.Vector3(0, 0, 0.07)); capsule.b = c.clone().add(new THREE.Vector3(0, 0, 0));
    s._sig = null;
    const st2 = s.update({ write: false, force: true });
    const U2 = rows(1), L2 = rows(-1);
    // across = along the slit; which end is the front depends on the frame's sign
    const front = s.probe.axes.lat.clone().applyQuaternion(head.getWorldQuaternion(new THREE.Quaternion())).z > 0 ? 1 : -1;
    const xf = xc + front * 0.015, xb = xc - front * 0.02;
    ok('a finger in along the slit: the lips part along it, closed behind its tip', st2.active && st2.leftCm === 0 && near(U2, xf) > 3 && near(L2, xf) < -3 && Math.abs(near(U2, xb)) < near(U2, xf) * 0.35, `${JSON.stringify(st2)} front ${near(U2, xf).toFixed(1)} / ${near(L2, xf).toFixed(1)} mm, behind ${near(U2, xb).toFixed(1)}`);
    void rig;
  }
}

// ---- lips turned sideways: the slit runs up and down, the two lips sit left and right;
// 6 lip bones under a middle bone that moves them all, partly weighted (like a remodeled
// lips model put on a character on its side)
function turnedMouth({ w = 0.5 } = {}) {
  const t = mouthy();
  const { model } = t;
  const root = model.root;
  const old = root.getObjectByName('Mouth');
  old.parent.remove(old);
  model.skinned = model.skinned.filter((x) => x !== old);
  const head = root.getObjectByName('Head');
  root.updateMatrixWorld(true);
  const C = new THREE.Vector3(0, 1.6, 0.115);
  // across = up the slit (world y), sep = which lip (world x), out = forward (z)
  const W = (across, sep, out = 0) => new THREE.Vector3(C.x + sep, C.y + across, C.z + out);
  const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
  const mid = new THREE.Bone(); mid.name = 'mouthMover'; mid.position.copy(W(0, 0).applyMatrix4(inv)); head.add(mid);
  root.updateMatrixWorld(true);
  const minv = new THREE.Matrix4().copy(mid.matrixWorld).invert();
  const bone = (name, p) => { const b = new THREE.Bone(); b.name = name; b.position.copy(p.applyMatrix4(minv)); mid.add(b); return b; };
  const as = [-0.018, 0, 0.018];
  const A = as.map((a, k) => bone('lipBoneA' + k, W(a, 0.003))), B = as.map((a, k) => bone('lipBoneB' + k, W(a, -0.003)));
  root.updateMatrixWorld(true);
  const bones = [head, mid, ...A, ...B];
  const geos = [[0.003, A], [-0.003, B]].map(([sep, set]) => {
    const g = new THREE.BoxGeometry(0.006, 0.05, 0.01, 3, 24, 4);
    g.translate(C.x + sep, C.y, C.z);
    const n = g.attributes.position.count, P = g.attributes.position;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const a = P.getY(i) - C.y;
      const k = a < -0.009 ? 0 : a > 0.009 ? 2 : 1;
      si[i * 4] = bones.indexOf(set[k]); sw[i * 4] = w;
      si[i * 4 + 1] = 1; sw[i * 4 + 1] = (1 - w) * 0.6; // the middle bone moves all of it a little
      si[i * 4 + 2] = 0; sw[i * 4 + 2] = (1 - w) * 0.4;
    }
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    return g;
  });
  const mesh = new THREE.SkinnedMesh(mergeGeometries(geos), new THREE.MeshStandardMaterial());
  mesh.name = 'TurnedMouth';
  root.add(mesh); root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(bones), mesh.matrixWorld);
  model.skinned.push(mesh);
  model.bones.push(mid, ...A, ...B);
  let n = 0; root.traverse(() => n++); model.nodeCount = n;
  model.poses = [];
  return { model, mid, A, B, C, head };
}
{
  const { model, mid, A, B, C, head } = turnedMouth();
  // the user picks all 7 (the middle one too)
  model.lipBones = [mid, ...A, ...B].map((b) => b.name);
  resetLips(model);
  const s = softLips(model);
  ok('turned lips (slit up and down, 6 bones + a middle one): soft lips found', s && s.N > 200, s ? `N ${s.N}` : `none: ${model._lipWhy}`);
  if (s) {
    const hq = head.getWorldQuaternion(new THREE.Quaternion());
    const up = s.probe.axes.up.clone().applyQuaternion(hq), across = s.probe.axes.lat.clone().applyQuaternion(hq);
    ok('…"between the lips" is sideways and "across" runs up the slit', Math.abs(up.x) > 0.9 && Math.abs(across.y) > 0.9, `up ${up.toArray().map((x) => x.toFixed(2))} across ${across.toArray().map((x) => x.toFixed(2))}`);
    const sideA = new Set(), sideB = new Set();
    for (let i = 0; i < s.N; i++) { const k = s.memStart[i]; const x = s.meshes[s.memMesh[k]].geometry.attributes.position.getX(s.memIdx[k]); if (Math.abs(x - C.x) > 1e-4) (x > C.x ? sideA : sideB).add(Math.sign(s.side[i])); }
    ok('…each lip all on one side (no mixed-up halves)', sideA.size === 1 && sideB.size === 1 && [...sideA][0] !== [...sideB][0], `${[...sideA]} / ${[...sideB]}`);
    const capsule = { a: C.clone().add(new THREE.Vector3(0, 0, 0.06)), b: C.clone().add(new THREE.Vector3(0, 0, -0.012)), r: 0.007 };
    s.capsules = function () { const F = this.F, a = capsule.a, b = capsule.b; return [{ ax: F.x(a), ay: F.y(a), az: F.z(a), bx: F.x(b), by: F.y(b), bz: F.z(b), r: capsule.r }]; };
    const st = s.update({ write: false });
    const rows = (sd) => { const out = []; for (let i = 0; i < s.N; i++) { if (s.side[i] !== sd) continue; if (Math.abs(s.P[i * 3 + 1] - s.C.y) < 0.0005) out.push([s.P[i * 3], s.D[i * 3 + 1] * 1000]); } return out.sort((a, b) => a[0] - b[0]); };
    const U = rows(1), L = rows(-1);
    const near = (row, x) => (row.length ? row.reduce((b, r) => (Math.abs(r[0] - x) < Math.abs(b[0] - x) ? r : b), row[0])[1] : 0);
    const xc = s.C.x;
    ok('a finger between the turned lips: they part around it, smooth, closed at the ends, nothing inside', st.active && st.leftCm === 0 && near(U, xc) > 3 && near(L, xc) < -3 && Math.abs(near(U, xc + 0.023)) < near(U, xc) * 0.35 && Math.abs(near(U, xc - 0.023)) < near(U, xc) * 0.35, `${JSON.stringify(st)} ${near(U, xc).toFixed(1)} / ${near(L, xc).toFixed(1)} mm, ends ${near(U, xc - 0.023).toFixed(1)} ${near(U, xc + 0.023).toFixed(1)}`);
    // smooth: no lip vertex jumps far from its neighbours along the lip line
    const jumps = (row) => Math.max(0, ...row.slice(1).map((r, i) => Math.abs(r[1] - row[i][1]) / Math.max(1e-4, (r[0] - row[i][0]) * 1000)));
    ok('…and the lip line is smooth (no spikes)', jumps(U) < 2.5 && jumps(L) < 2.5, `steepest ${jumps(U).toFixed(2)} / ${jumps(L).toFixed(2)} mm per mm`);
  }
}

// ---- an object you mark makes the lips wrap around it (a cigarette in the model itself)
{
  const { model, mid, A, B, C } = turnedMouth();
  model.lipBones = [mid, ...A, ...B].map((b) => b.name);
  resetLips(model);
  const s = softLips(model);
  const cig = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 8).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial());
  cig.name = 'Cigarette';
  cig.position.copy(C).add(new THREE.Vector3(0, 0, 0.03));
  model.root.add(cig);
  model.root.updateMatrixWorld(true);
  ok('an object in the model that isn\'t marked: the lips ignore it', s && !s.update({ write: false }).active);
  cig.userData.lipCollider = true;
  const st = s ? s.update({ write: false }) : {};
  ok('marked (Tools → Lips react to the selected object): the lips wrap around it', st.active && st.leftCm === 0 && st.pushCm > 0.1, JSON.stringify(st));
}

// ---- marked objects of every kind: a rigged (skinned) one, one inside a marked group, an
// odd-shaped one only partly at the lips
{
  const { model, mid, A, B, C, head } = turnedMouth();
  model.lipBones = [mid, ...A, ...B].map((b) => b.name);
  resetLips(model);
  const s = softLips(model);
  const run = (label, make) => {
    const o = make();
    model.root.updateMatrixWorld(true);
    s.sig = null;
    const st = s.update({ write: false });
    ok(`marked ${label}: the lips wrap around it`, st.active && st.leftCm === 0 && st.pushCm > 0.1, JSON.stringify(st));
    o.parent.remove(o);
    s.sig = null;
  };
  // rigged: a cigarette skinned to the head bone
  run('rigged object (skinned to the head)', () => {
    const g = new THREE.CylinderGeometry(0.004, 0.004, 0.07, 8, 6).rotateX(Math.PI / 2).translate(C.x, C.y, C.z + 0.03);
    const n = g.attributes.position.count;
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 4));
    const m = new THREE.SkinnedMesh(g, new THREE.MeshStandardMaterial());
    m.name = 'RiggedCig';
    model.root.add(m); model.root.updateMatrixWorld(true);
    m.bind(new THREE.Skeleton([head]), m.matrixWorld);
    m.userData.lipCollider = true;
    return m;
  });
  // a group marked, the mesh inside it with its geometry off-centre
  run('group (the mesh inside it)', () => {
    const grp = new THREE.Group(); grp.name = 'Props';
    const m = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 8).rotateX(Math.PI / 2).translate(0.5, 0, 0), new THREE.MeshStandardMaterial());
    m.position.set(C.x - 0.5, C.y, C.z + 0.03);
    grp.add(m); model.root.add(grp);
    grp.userData.lipCollider = true;
    return grp;
  });
  // a big L-shaped thing whose short arm pokes between the lips (its bounding box is huge)
  run('odd-shaped object partly at the lips', () => {
    const arm1 = new THREE.BoxGeometry(0.008, 0.008, 0.05).translate(C.x, C.y, C.z + 0.02);
    const arm2 = new THREE.BoxGeometry(0.3, 0.008, 0.008).translate(C.x + 0.15, C.y, C.z + 0.045);
    const m = new THREE.Mesh(mergeGeometries([arm1, arm2]), new THREE.MeshStandardMaterial());
    m.name = 'LShape';
    model.root.add(m);
    m.userData.lipCollider = true;
    return m;
  });
}

// ---- a second mouth (on the chest)
function twoMouths() {
  const t = mouthy();
  const { model } = t;
  const root = model.root;
  const chest = root.getObjectByName('Chest') || root.getObjectByName('Spine');
  root.updateMatrixWorld(true);
  const cp = new THREE.Vector3().setFromMatrixPosition(chest.matrixWorld);
  const at = [0, cp.y, 0.16];
  const inv = new THREE.Matrix4().copy(chest.matrixWorld).invert();
  const bone = (name, p) => { const b = new THREE.Bone(); b.name = name; b.position.copy(new THREE.Vector3(...p).applyMatrix4(inv)); chest.add(b); return b; };
  const u = bone('m2.top', [at[0], at[1] + 0.003, at[2]]), l = bone('m2.bottom', [at[0], at[1] - 0.003, at[2]]);
  root.updateMatrixWorld(true);
  const geos = [[[0.05, 0.006, 0.01, 24, 3, 4], [at[0], at[1] + 0.003, at[2]], 0], [[0.05, 0.006, 0.01, 24, 3, 4], [at[0], at[1] - 0.003, at[2]], 1]].map(([sz, c, bi]) => {
    const g = new THREE.BoxGeometry(...sz); g.translate(...c);
    const n = g.attributes.position.count;
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, i) => (i % 4 ? 0 : bi)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 4));
    return g;
  });
  const m2 = new THREE.SkinnedMesh(mergeGeometries(geos), new THREE.MeshStandardMaterial());
  m2.name = 'Mouth2';
  root.add(m2); root.updateMatrixWorld(true);
  m2.bind(new THREE.Skeleton([u, l]), m2.matrixWorld);
  model.skinned.push(m2);
  model.bones.push(u, l);
  let n = 0; root.traverse(() => n++); model.nodeCount = n;
  return { ...t, u, l, m2 };
}
{
  const { model } = twoMouths();
  ok('no extra mouths until you add one', softLipsExtra(model).length === 0);
  model.extraMouths = [{ name: 'Chest mouth', bones: ['m2.top', 'm2.bottom'] }];
  resetLips(model);
  const x = softLipsExtra(model);
  ok('a second mouth from its bones gets its own soft lips', x.length === 1 && x[0].N > 200, x[0] ? `N ${x[0].N}` : 'none');
  if (x[0]) {
    ok('…on its own offset layer', x[0].layerName === 'lips1' && softLips(model).layerName === 'lips');
    const up = [...x[0].side].filter((v) => v > 0).length, lo = [...x[0].side].filter((v) => v < 0).length;
    ok('…with its upper and lower lip', Math.abs(up - lo) < 20 && up > 50, `${up} / ${lo}`);
    ok('…and it runs (nothing pushed at rest)', !x[0].update({ write: false }).active);
  }
  ok('both mouths listed', allSoftLips(model).length === 2);
  const sk = softSkin(model);
  ok('soft skin leaves the second mouth to its soft lips', sk && sk.mouthZones && sk.mouthZones.length === 1, sk ? `${sk.mouthZones.length} zone(s)` : 'no skin');
}

// ---- soft-skin numbers and where it's off
{
  const { model } = mouthy();
  const sk = softSkin(model);
  ok('soft skin built', !!sk);
  if (sk) {
    const w0 = Float32Array.from(sk.widthMul), d0 = Float32Array.from(sk.maxDepth);
    model.skinTune = { crater: 2, depth: 0.5 };
    sk.applyOverrides();
    const wr = sk.widthMul.reduce((a, v, i) => a + v / w0[i], 0) / sk.N;
    let dr = 0, n = 0; for (let i = 0; i < sk.N; i++) if (d0[i] > 1e-6) { dr += sk.maxDepth[i] / d0[i]; n++; }
    ok('crater width × and depth × apply everywhere', Math.abs(wr - 2) < 1e-4 && Math.abs(dr / n - 0.5) < 1e-4, `${wr.toFixed(3)} / ${(dr / n).toFixed(3)}`);
    model.skinTune = {};
    // no soft skin on the arms
    const arm = model.humanoid.map.leftUpperArm;
    model.indent = { [arm.uuid]: { rigid: true } };
    sk.applyOverrides();
    let armV = 0, armDeep = 0;
    // (a bone's setting covers its helper bones, not the next body part: the forearm has its own)
    const canon = model.humanoid.canonOf;
    for (let w = 0; w < sk.N; w++) { let p = sk.dBones[sk.dbone[w]]; while (p && !canon.has(p)) p = p.parent; if (p === arm) { armV++; armDeep = Math.max(armDeep, sk.maxDepth[w]); } }
    ok('no soft skin where you switch it off (rigid: no depth)', armV > 0 && armDeep === 0, `${armV} vertices, deepest ${armDeep}`);
    model.indent = {};
    ok('defaults are what they were', SKIN_TUNE.settleOut === 0.16 && SKIN_TUNE.settleIn === 0.03 && Math.abs(SKIN_TUNE.maxTurn - 0.45) < 1e-9);
    // anatomy off: rebuilt with even flesh
    model.skinTune = { anatomy: false };
    sk.clear(); model._skin = undefined;
    const flat = softSkin(model);
    ok('anatomy off rebuilds the soft skin', !!flat && flat !== sk);
  }
}

// ---- bone groups
{
  const { model } = mouthy();
  const rig = model.humanoid;
  ok('the other side of a bone (left ↔ right)', mirrorBone(model, rig.map.leftHand) === rig.map.rightHand && mirrorBone(model, rig.map.rightUpperLeg) === rig.map.leftUpperLeg);
  ok('a bone and everything under it', childBones(rig.map.leftHand).length >= 5);
  ok('body part of a bone (for colors and Tools → Body part)', bonePart(rig.map.leftHand, rig.canonOf) === 'hands' && bonePart(rig.map.head, rig.canonOf) === 'head' && bonePart(model.root.getObjectByName('tongue'), rig.canonOf) === 'face');
}

console.log(fails ? `${fails} failed` : 'all advanced tests passed');
process.exit(fails ? 1 : 0);
