// Soft lips: the lips wrap, squish and curve around whatever passes between them (the
// tongue, a finger, something held to the mouth) instead of the mouth opening wide or
// the thing clipping through. Built like a Shrinkwrap (outside) + vertex group + Smooth
// modifier stack in Blender, evaluated live on every frame:
//  - vertex group: the lips and the skin right around them, fading out toward the
//    cheeks, nose and chin;
//  - shrinkwrap: lip vertices inside the tongue or a finger go to its surface: the upper
//    lip over it, the lower lip under it (around its sides when it comes in end-on);
//  - smooth: the push spreads into the rest of the lip so it curves around the thing
//    instead of creasing, with a slight bulge where it's squeezed.
// The offsets go to the GPU as a per-vertex attribute added after skinning, so the lips
// deform on top of whatever the rig and the shape keys do.
import * as THREE from 'three';
import { mouthProbe, mouthEffects, evaluator, headFrame, EMPTY, NOT_FACE, TONGUE, nameOf } from './mouth.js';
import { faceTracks } from './face.js';
import { ATTR, prepareMesh, layer, beginLayer, setOffset, commit, detachOffsets, weldedTriangles, unfold } from './offsets.js';

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const _m = new THREE.Matrix4(), _inv = new THREE.Matrix4(), _pre = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _v = new THREE.Vector3(), _w = new THREE.Vector3();
const IDENT = new THREE.Matrix4();

function visibleChain(o) { for (let p = o; p; p = p.parent) if (!p.visible) return false; return true; }
function dominant(si, sw, i) {
  let bi = 0, bw = -1;
  for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; bi = si.getComponent(i, k); } }
  return bi;
}

// ---------------------------------------------------------------- the controller
// -> the model's soft lips (built once per rig), or null when there's no mouth to wrap
export function softLips(model) {
  if (!model || !model.humanoid || !model.skinned || !model.skinned.length) return null;
  if (model._soft !== undefined && model._softN === model.nodeCount) return model._soft;
  if (model._soft) model._soft.clear();
  model._softN = model.nodeCount;
  model._soft = null;
  try { model._soft = build(model); } catch (e) { console.warn('soft lips', e); model._soft = null; }
  return model._soft;
}

// on unless switched off in the model's properties
export const softLipsOn = (model) => model.softLips !== false && !!softLips(model);

// every frame (cheap when nothing near the mouth changed)
export function updateSoftLips(model) {
  if (!model.humanoid || !model.root.visible) return;
  const s = softLips(model);
  if (!s) return;
  if (model.softLips === false) { s.clear(); return; }
  s.update();
}

// the GLB writer leaves the live offsets out of the file
export const detachSoftLips = detachOffsets;

function build(model) {
  const probe = mouthProbe(model);
  if (!probe) return null;
  const rig = model.humanoid, head = probe.head, hw = probe.halfWidth;
  const C = { x: probe.latC, y: probe.mouthUp, z: probe.lipFront };
  const fx = mouthEffects(model) || new Map();
  const opener = [...fx].filter(([, e]) => e.open > 0.003 && e.tongue < 0.004).sort((a, b) => b[1].open - a[1].open)[0];
  const headBones = new Set();
  head.traverse((o) => { if (o.isBone) headBones.add(o); });
  const tongueKey = new Set(probe.tongue.map((e) => e.mesh.uuid + ':' + e.i));
  // the vertex group: an egg around the mouth, full on the lips, fading toward its edge
  const RX = 1.45 * hw, RY = 0.95 * hw, RB = 1.3 * hw, RF = 0.7 * hw;
  const ell = (x, y, z) => Math.hypot((x - C.x) / RX, (y - C.y) / RY, (z - C.z) / (z < C.z ? RB : RF));
  const raw = [];
  const fingerVerts = new Map();
  const fingerBones = new Set();
  for (const side of ['left', 'right']) {
    const H = rig.handRig && rig.handRig(side);
    if (H) for (const ch of Object.values(H.chains)) for (const b of ch.bones) fingerBones.add(b.bone);
  }
  const ev = evaluator(model);
  const v = new THREE.Vector3();
  try {
    ev.at(EMPTY, 0);
    const frame = headFrame(head, probe.axes);
    for (const s of model.skinned) {
      if (!visibleChain(s) || !s.skeleton) continue;
      const g = s.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      if (!si || !sw || !g.attributes.position) continue;
      for (let i = 0; i < si.count; i++) {
        const b = s.skeleton.bones[dominant(si, sw, i)];
        if (!b) continue;
        if (fingerBones.has(b)) {
          // finger thickness, for the fingers as colliders
          s.getVertexPosition(i, v).applyMatrix4(s.matrixWorld);
          if (!fingerVerts.has(b)) fingerVerts.set(b, []);
          fingerVerts.get(b).push(v.clone());
          continue;
        }
        if (!headBones.has(b)) continue;
        const n = nameOf(b);
        if (NOT_FACE.test(n) || TONGUE.test(n) || tongueKey.has(s.uuid + ':' + i)) continue;
        frame.local({ mesh: s, i }, v);
        const r = ell(v.x, v.y, v.z);
        if (r >= 1) continue;
        raw.push({ mesh: s, i, x: v.x, y: v.y, z: v.z, r, b: b.uuid });
      }
    }
    if (raw.length < 12) return null;
    // the lower lip is what goes down when the mouth opens
    if (opener) {
      const { tracks } = faceTracks(model, [{ t: 0, control: opener[0], value: 1 }, { t: 1, control: opener[0], value: 1 }], 1, 2);
      ev.at(new THREE.AnimationClip('open', 1, tracks), 0.5);
      const f2 = headFrame(head, probe.axes);
      let maxDown = 0;
      for (const e of raw) { f2.local(e, v); e.dy = v.y - e.y; if (-e.dy > maxDown) maxDown = -e.dy; }
      for (const e of raw) e.lower = maxDown > 1e-4 ? -e.dy > maxDown * 0.35 : e.y < C.y;
      ev.at(EMPTY, 0);
    } else for (const e of raw) e.lower = e.y < C.y;
    // built in the rest pose (what sits inside the tongue at rest, finger thickness)
    return new SoftLips(model, probe, raw, fingerVerts, { C, hw, R: [RX, RY, RB, RF] });
  } finally { ev.done(); }
}

class SoftLips {
  constructor(model, probe, raw, fingerVerts, g) {
    this.model = model;
    this.probe = probe;
    this.C = g.C;
    this.hw = g.hw;
    this.R = g.R;
    this.active = false;
    this.mats = new Map();
    // ---- weld duplicates (UV seams) so the lip can't tear; upper and lower lip vertices
    // sitting on the same spot stay apart
    const q = g.hw * 0.004;
    const ids = new Map(), reps = [];
    for (const e of raw) {
      const k = `${Math.round(e.x / q)},${Math.round(e.y / q)},${Math.round(e.z / q)},${e.lower ? 1 : 0},${e.b}`;
      let w = ids.get(k);
      if (w === undefined) { w = reps.length; ids.set(k, w); reps.push(e); e.members = []; }
      e.w = w;
      reps[w].members.push(e);
    }
    const N = (this.N = reps.length);
    this.meshes = [...new Set(raw.map((e) => e.mesh))];
    const mi = new Map(this.meshes.map((m, i) => [m, i]));
    // representative vertex of each welded one, grouped by mesh for skinning
    this.repBy = this.meshes.map((m) => ({ mesh: m, idx: [], at: [] }));
    reps.forEach((e, w) => { const r = this.repBy[mi.get(e.mesh)]; r.idx.push(e.i); r.at.push(w); });
    for (const r of this.repBy) { r.idx = Int32Array.from(r.idx); r.at = Int32Array.from(r.at); }
    this.memStart = new Int32Array(N + 1);
    const mm = [], mv = [];
    reps.forEach((e, w) => { this.memStart[w] = mm.length; for (const x of e.members) { mm.push(mi.get(x.mesh)); mv.push(x.i); } });
    this.memStart[N] = mm.length;
    this.memMesh = Int32Array.from(mm);
    this.memIdx = Int32Array.from(mv);
    this.weight = new Float32Array(N);
    this.side = new Int8Array(N);
    this.rest = new Float32Array(N * 3);
    // the lip edge: where the lips meet (these seal around what passes between them)
    this.edge = new Uint8Array(N);
    this.noHug = new Uint8Array(N);
    reps.forEach((e, w) => {
      this.weight[w] = 1 - smooth(0.5, 1, e.r);
      this.side[w] = e.lower ? -1 : 1;
      this.rest[w * 3] = e.x; this.rest[w * 3 + 1] = e.y; this.rest[w * 3 + 2] = e.z;
      if (Math.abs(e.y - g.C.y) < 0.16 * g.hw && e.z > g.C.z - 0.35 * g.hw && e.z < g.C.z + 0.25 * g.hw && Math.abs(e.x - g.C.x) < 1.05 * g.hw) this.edge[w] = 1;
    });
    this.hugRange = 0.3 * g.hw;
    // ---- edges between welded vertices (for the smoothing)
    const adj = Array.from({ length: N }, () => new Set());
    const maps = new Map();
    for (const m of this.meshes) {
      const map = new Int32Array(m.geometry.attributes.position.count).fill(-1);
      for (const e of raw) if (e.mesh === m) map[e.i] = e.w;
      maps.set(m, map);
      const ix = m.geometry.index;
      const n = ix ? ix.count : m.geometry.attributes.position.count;
      for (let t = 0; t + 2 < n; t += 3) {
        const a = map[ix ? ix.getX(t) : t], b = map[ix ? ix.getX(t + 1) : t + 1], c = map[ix ? ix.getX(t + 2) : t + 2];
        if (a >= 0 && b >= 0 && a !== b) { adj[a].add(b); adj[b].add(a); }
        if (b >= 0 && c >= 0 && b !== c) { adj[b].add(c); adj[c].add(b); }
        if (a >= 0 && c >= 0 && a !== c) { adj[a].add(c); adj[c].add(a); }
      }
    }
    Object.assign(this, weldedTriangles(this.meshes, (m) => maps.get(m), N));
    this.foldStamps = { a: new Uint32Array(this.tris.length / 3 + 1) };
    this.allIds = Int32Array.from({ length: N }, (_, i) => i);
    this.adjStart = new Int32Array(N + 1);
    const al = [];
    for (let i = 0; i < N; i++) { this.adjStart[i] = al.length; for (const j of adj[i]) al.push(j); }
    this.adjStart[N] = al.length;
    this.adj = Int32Array.from(al);
    // edge lengths: along the lip line (sideways) and across it (up / down / in / out)
    this.adjLat = new Float32Array(al.length);
    this.adjAcross = new Float32Array(al.length);
    for (let i = 0; i < N; i++) for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
      const j = this.adj[k];
      this.adjLat[k] = Math.abs(this.rest[i * 3] - this.rest[j * 3]);
      this.adjAcross[k] = Math.hypot(this.rest[i * 3 + 1] - this.rest[j * 3 + 1], this.rest[i * 3 + 2] - this.rest[j * 3 + 2]);
    }
    this.adjC = new Float32Array(al.length);
    this._soft = null;
    // the region's box (head frame, rest) with room for the jaw to move
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < N; i++) { const x = this.rest[i * 3], y = this.rest[i * 3 + 1], z = this.rest[i * 3 + 2]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z); z1 = Math.max(z1, z); }
    const pad = g.hw * 0.5;
    this.box = { x0: x0 - pad, x1: x1 + pad, y0: y0 - g.hw * 1.5, y1: y1 + pad, z0: z0 - pad, z1: z1 + pad };
    // ---- the tongue: its vertices and the triangles between them
    this.tongue = null;
    if (probe.tongue.length) {
      const by = new Map();
      for (const e of probe.tongue) { if (!by.has(e.mesh)) by.set(e.mesh, []); by.get(e.mesh).push(e.i); }
      const parts = [];
      let off = 0;
      const tris = [];
      for (const [mesh, list] of by) {
        const idx = Int32Array.from(list);
        const local = new Map(list.map((i, k) => [i, off + k]));
        const ix = mesh.geometry.index;
        const n = ix ? ix.count : mesh.geometry.attributes.position.count;
        for (let t = 0; t + 2 < n; t += 3) {
          const a = local.get(ix ? ix.getX(t) : t), b = local.get(ix ? ix.getX(t + 1) : t + 1), c = local.get(ix ? ix.getX(t + 2) : t + 2);
          if (a !== undefined && b !== undefined && c !== undefined) tris.push(a, b, c);
        }
        parts.push({ mesh, idx, off });
        off += idx.length;
      }
      this.tongue = { parts, n: off, tris: Int32Array.from(tris), P: new Float32Array(off * 3) };
      // a grid over the mouth (seen from above) holding the tongue's top and bottom
      const cs = g.hw / 14;
      this.field = new Field(this.box.x0, this.box.z0, cs, Math.ceil((this.box.x1 - this.box.x0) / cs) + 1, Math.ceil((this.box.z1 - this.box.z0) / cs) + 1);
    }
    this.maxTongue = Math.max(1.8 * (probe.tongueThick || 0), 0.6 * g.hw);
    // ---- fingers (both hands): capsules per finger bone, thickness measured on the mesh
    this.fingers = fingerCapsules(model, fingerVerts);
    // ---- buffers
    this.P = new Float32Array(N * 3);
    this.H = new Float32Array(N * 3);
    this.hard = new Uint8Array(N);
    this.D = new Float32Array(N * 3);
    this.D2 = new Float32Array(N * 3);
    this.inside = new Uint8Array(N);
    this.boneMats = new Map();
    // vertices already inside the tongue at rest (the floor of the mouth under it) never get pushed
    this.F = frameOf(probe);
    this.computePositions();
    if (this.tongue) {
      this.buildField();
      for (let i = 0; i < N; i++) {
        const r = this.field.query(this.P[i * 3], this.P[i * 3 + 2]);
        if (!r) continue;
        const y = this.P[i * 3 + 1];
        if (y > r.bot && y < r.top) this.inside[i] = 1;
        // lip edges resting near the tongue inside the mouth don't get pulled onto it
        else if (this.edge[i] && (this.side[i] > 0 ? y - r.top : r.bot - y) < this.hugRange * 1.5) this.noHug[i] = 1;
      }
    }
    this.sig = null;
    this.stats = { active: false, pushCm: 0, leftCm: 0 };
    // the GPU side: a per-vertex offset on each lip mesh's own geometry
    for (const m of this.meshes) prepareMesh(m);
  }

  // positions of the lip (welded) vertices in the head frame, with rig + shape keys
  computePositions() {
    const F = this.F;
    F.update();
    for (const r of this.repBy) {
      const mats = boneMatsOf(r.mesh, this.boneMats);
      skinTo(r.mesh, r.idx, mats, F, (k, x, y, z) => { const w = r.at[k] * 3; this.P[w] = x; this.P[w + 1] = y; this.P[w + 2] = z; });
    }
  }

  buildField() {
    const T = this.tongue, F = this.F;
    for (const p of T.parts) {
      const mats = boneMatsOf(p.mesh, this.boneMats);
      skinTo(p.mesh, p.idx, mats, F, (k, x, y, z) => { const w = (p.off + k) * 3; T.P[w] = x; T.P[w + 1] = y; T.P[w + 2] = z; });
    }
    const f = this.field;
    f.reset();
    const P = T.P, b = this.box;
    let any = false;
    this.tongueFront = -Infinity;
    for (let i = 0; i < T.n; i++) {
      const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2];
      if (z > this.tongueFront && Math.abs(x - this.C.x) < this.hw) this.tongueFront = z;
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1 || y < b.y0 - this.hw || y > b.y1 + this.hw) continue;
      f.point(x, y, z);
      any = true;
    }
    if (!any) return false;
    const tr = T.tris;
    for (let t = 0; t < tr.length; t += 3) {
      const a = tr[t] * 3, c = tr[t + 1] * 3, d = tr[t + 2] * 3;
      f.tri(P[a], P[a + 1], P[a + 2], P[c], P[c + 1], P[c + 2], P[d], P[d + 1], P[d + 2]);
    }
    return true;
  }

  // what's near the mouth this frame: finger / prop capsules in the head frame
  capsules() {
    const out = [];
    const F = this.F, b = this.box;
    const add = (A, B, r) => {
      const ax = F.x(A), ay = F.y(A), az = F.z(A), bx = F.x(B), by = F.y(B), bz = F.z(B);
      if (Math.max(ax, bx) + r < b.x0 || Math.min(ax, bx) - r > b.x1 || Math.max(ay, by) + r < b.y0 || Math.min(ay, by) - r > b.y1 || Math.max(az, bz) + r < b.z0 || Math.min(az, bz) - r > b.z1) return;
      out.push({ ax, ay, az, bx, by, bz, r });
    };
    const fingerCaps = (list) => {
      for (const f of list) {
        f.a.updateWorldMatrix(true, false);
        const A = _v.setFromMatrixPosition(f.a.matrixWorld).clone();
        let B;
        if (f.b) { f.b.updateWorldMatrix(true, false); B = _w.setFromMatrixPosition(f.b.matrixWorld).clone(); } else B = f.tip.clone().applyMatrix4(f.a.matrixWorld);
        const len = A.distanceTo(B);
        if (f.off) { f.a.getWorldQuaternion(_q2); const o = f.off.clone().applyQuaternion(_q2).multiplyScalar(len); A.add(o); B.add(o); }
        add(A, B, f.ratio * len);
      }
    };
    fingerCaps(this.fingers);
    // other characters' fingers, and things held to the mouth
    const app = this.model.app;
    const mouth = F.world(this.C.x, this.C.y, this.C.z, new THREE.Vector3());
    const reach = this.hw * 6;
    const heldBy = this.handBones || (this.handBones = new Set([this.model.humanoid.map.leftHand, this.model.humanoid.map.rightHand].filter(Boolean)));
    const props = [];
    this.model.root.traverse((o) => {
      if (!o.isMesh || o.isSkinnedMesh || !o.visible || o.userData.editorOnly || o.userData.helper) return;
      for (let p = o.parent; p; p = p.parent) if (heldBy.has(p)) { props.push(o); return; }
    });
    if (app && app.models) for (const m of app.models) {
      if (m === this.model || !m.root.visible) continue;
      if (m.humanoid && m._softFingers) fingerCaps(m._softFingers);
      else if (m.humanoid && m.humanoid.handRig) fingerCaps(m._softFingers = fingerCapsules(m, new Map()));
      for (const o of m.meshes || []) if (o.isMesh && !o.isSkinnedMesh && visibleChain(o)) props.push(o);
    }
    for (const o of props) {
      const c = meshCapsule(o);
      if (!c) continue;
      const A = c.a.clone().applyMatrix4(o.matrixWorld), B = c.b.clone().applyMatrix4(o.matrixWorld);
      const s = o.getWorldScale(_w);
      const r = c.r * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
      if (A.distanceTo(mouth) > reach + r + A.distanceTo(B) && B.distanceTo(mouth) > reach + r + A.distanceTo(B)) continue;
      add(A, B, r);
    }
    return out;
  }

  // what the lips and tongue are doing relative to the head (moving the whole head or
  // body doesn't change the wrap, only where it points)
  signature() {
    const s = this.sigBuf || (this.sigBuf = []);
    s.length = 0;
    const bones = this.watch || (this.watch = this.watchList());
    _inv.copy(this.probe.head.matrixWorld).invert();
    for (const b of bones) { _m.multiplyMatrices(_inv, b.matrixWorld); const e = _m.elements; for (let i = 0; i < 16; i++) s.push(Math.round(e[i] * 1e6)); }
    for (const m of this.meshes) if (m.morphTargetInfluences) for (const x of m.morphTargetInfluences) s.push(x);
    if (this.tongue) for (const p of this.tongue.parts) if (p.mesh.morphTargetInfluences && !this.meshes.includes(p.mesh)) for (const x of p.mesh.morphTargetInfluences) s.push(x);
    s.push(this.model.softLipsSoftness ?? 1);
    return s;
  }

  watchList() {
    const set = new Set([this.probe.head]);
    const addMesh = (mesh, idx) => {
      const g = mesh.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
      for (const i of idx) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 0) { const b = mesh.skeleton.bones[si.getComponent(i, k)]; if (b) set.add(b); }
    };
    for (const r of this.repBy) addMesh(r.mesh, r.idx);
    if (this.tongue) for (const p of this.tongue.parts) addMesh(p.mesh, p.idx);
    // (fingers and props near the mouth are checked every frame)
    set.delete(this.probe.head);
    return [...set];
  }

  // the shrinkwrap: how far (head frame) vertex i must move to be outside everything
  // -> remaining penetration the push couldn't fix (clamped)
  push(i, caps, out, hug = false) {
    let px = this.P[i * 3] + out[0], py = this.P[i * 3 + 1] + out[1], pz = this.P[i * 3 + 2] + out[2];
    const s = this.side[i];
    const margin = this.hw * 0.02;
    let left = 0, moved = false;
    // hug: a lip edge hovering just over (or under) the tongue / a finger closes onto it,
    // so the lips seal around it instead of leaving a gap
    if (hug && this.edge[i] && !this.noHug[i]) {
      let gap = Infinity;
      if (this.fieldOn && this.tongueFront > this.C.z && !this.inside[i]) {
        const r = this.field.query(px, pz);
        if (r) { const g = s > 0 ? py - (r.top + margin) : r.bot - margin - py; if (g > 0) gap = g; }
      }
      for (const c of caps) {
        const t = capHit(px, py, pz, 0, -s, 0, c.ax, c.ay, c.az, c.bx, c.by, c.bz, c.r + margin);
        if (t > 0 && t < gap) gap = t;
      }
      if (gap < this.hugRange) {
        const pull = gap * (1 - smooth(0.6, 1, gap / this.hugRange));
        if (pull > 1e-6) { py -= s * pull; out[1] -= s * pull; return 0; }
      }
    }
    for (let pass = 0; pass < 2; pass++) {
      if (this.fieldOn && !this.inside[i]) {
        const r = this.field.query(px, pz);
        if (r) {
          const need = s > 0 ? r.top + margin - py : py - (r.bot - margin);
          const within = s > 0 ? py > r.bot - margin : py < r.top + margin;
          if (within && need > 0) {
            const e = Math.min(need, this.maxTongue);
            if (pass === 1) left = Math.max(left, need - e);
            py += s * e; out[1] += s * e; moved = true;
          }
        }
      }
      for (const c of caps) {
        const r = capsulePush(px, py, pz, c, s, margin, _cp);
        if (!r) continue;
        px += _cp[0]; py += _cp[1]; pz += _cp[2];
        out[0] += _cp[0]; out[1] += _cp[1]; out[2] += _cp[2];
        moved = true;
      }
      if (!moved) break;
    }
    return moved ? left : -1;
  }

  // -> { active, pushCm (how far the lips were pushed), leftCm (what still clips) }
  // write: false measures without touching what's shown (the AI's checks)
  update({ write = true, force = false } = {}) {
    this.F.update();
    const caps = this.capsules();
    if (write) {
      // nothing near the mouth changed relative to the head: keep the wrap (re-aimed if the head moved)
      const sig = this.signature();
      let same = !force && !caps.length && !this.hadCaps && !!this.sig && sig.length === this.sig.length;
      if (same) for (let i = 0; i < sig.length; i++) if (sig[i] !== this.sig[i]) { same = false; break; }
      this.sig = sig.slice();
      this.hadCaps = caps.length > 0;
      if (same) { if (this.active) this.write(); return this.stats; }
    }
    this.fieldOn = !!this.tongue && this.buildField();
    const stats = { active: false, pushCm: 0, leftCm: 0, tongue: false, fingers: caps.length > 0 };
    if (!caps.length && !this.fieldOn) { if (write) { this.clear(); this.stats = stats; } return stats; }
    this.computePositions();
    const N = this.N, H = this.H, hard = this.hard;
    H.fill(0); hard.fill(0);
    const o = [0, 0, 0];
    let anyHard = false, left = 0;
    for (let i = 0; i < N; i++) {
      if (!(this.weight[i] > 0)) continue;
      o[0] = o[1] = o[2] = 0;
      const l = this.push(i, caps, o, true);
      if (l < 0) continue;
      H[i * 3] = o[0]; H[i * 3 + 1] = o[1]; H[i * 3 + 2] = o[2];
      hard[i] = 1; anyHard = true;
      if (this.fieldOn) stats.tongue = true;
      left = Math.max(left, l);
    }
    if (!anyHard) { if (write) { this.clear(); this.stats = stats; } return stats; }
    this.smooth();
    // never folding through itself
    this.folds = unfold(this.allIds, this.tris, this.triStart, this.triOf, this.P, this.D, this.foldStamps);
    // whatever the smoothing moved into the tongue or a finger goes back out
    const D = this.D;
    let maxD = 0;
    for (let i = 0; i < N; i++) {
      o[0] = D[i * 3]; o[1] = D[i * 3 + 1]; o[2] = D[i * 3 + 2];
      const l = this.weight[i] > 0 ? this.push(i, caps, o) : -1;
      if (l >= 0) { D[i * 3] = o[0]; D[i * 3 + 1] = o[1]; D[i * 3 + 2] = o[2]; left = Math.max(left, l); }
      maxD = Math.max(maxD, Math.hypot(D[i * 3], D[i * 3 + 1], D[i * 3 + 2]));
    }
    stats.active = true;
    stats.pushCm = +(maxD * 100).toFixed(2);
    stats.leftCm = +(left * 100).toFixed(2);
    if (write) { this.write(); this.stats = stats; }
    return stats;
  }

  // the smooth modifier + vertex group: each pushed vertex carries the rest of the lip
  // along, fading with the distance over the lip's surface (short along the lip line, so
  // the lips close again right beside the tongue or finger; long across it, so the whole
  // lip lifts instead of getting pinched thin), then a light smooth for an even curve
  smooth() {
    const N = this.N, H = this.H, hard = this.hard, w8 = this.weight;
    const soft = Math.min(2, Math.max(0.2, this.model.softLipsSoftness ?? 1));
    if (this._soft !== soft) {
      const Llat = 0.24 * this.hw * soft, Lacross = 0.9 * this.hw * soft;
      for (let k = 0; k < this.adj.length; k++) this.adjC[k] = Math.hypot(this.adjLat[k] / Llat, this.adjAcross[k] / Lacross);
      this._soft = soft;
    }
    // the strongest push reaching each vertex over the surface: a pushed vertex carries
    // its neighbours (and the rest of its own lip) along, fading with distance; upper and
    // lower lip are carried separately (Dijkstra on distance - log(push), from all at once)
    const key = this.dist || (this.dist = new Float32Array(N)), src = this.src || (this.src = new Int32Array(N));
    const heap = this.heap || (this.heap = new Heap(N));
    key.fill(Infinity); src.fill(-1); heap.clear();
    let ref = 0;
    for (let i = 0; i < N; i++) if (hard[i]) ref = Math.max(ref, Math.hypot(H[i * 3], H[i * 3 + 1], H[i * 3 + 2]));
    if (!(ref > 0)) { this.D.fill(0); return; }
    for (let i = 0; i < N; i++) {
      if (!hard[i]) continue;
      const k = Math.log(ref / Math.max(1e-9, Math.hypot(H[i * 3], H[i * 3 + 1], H[i * 3 + 2])));
      key[i] = k; src[i] = i; heap.push(i, k);
    }
    const as = this.adjStart, adj = this.adj, cost = this.adjC, side = this.side;
    while (heap.size) {
      const i = heap.pop();
      const ki = key[i];
      if (ki > 6) break;
      for (let k = as[i]; k < as[i + 1]; k++) {
        const j = adj[k];
        if (side[j] !== side[i]) continue;
        const d = ki + cost[k] / Math.max(0.05, w8[j]);
        if (d < key[j]) { key[j] = d; src[j] = src[i]; heap.push(j, d); }
      }
    }
    const D = this.D;
    D.fill(0);
    for (let i = 0; i < N; i++) {
      const s = src[i];
      if (s < 0) continue;
      const hl = Math.hypot(H[s * 3], H[s * 3 + 1], H[s * 3 + 2]) || 1;
      const f = (ref * Math.exp(-key[i])) / hl;
      D[i * 3] = H[s * 3] * f; D[i * 3 + 1] = H[s * 3 + 1] * f; D[i * 3 + 2] = H[s * 3 + 2] * f;
    }
    // a light smooth over the free vertices (no seams where two pushes meet)
    const D2 = this.D2;
    for (let it = 0; it < 3; it++) {
      D2.set(D);
      for (let i = 0; i < N; i++) {
        if (hard[i] || src[i] < 0) continue;
        const k0 = as[i], k1 = as[i + 1];
        if (k1 <= k0) continue;
        let sx = 0, sy = 0, sz = 0;
        for (let k = k0; k < k1; k++) { const j = adj[k] * 3; sx += D2[j]; sy += D2[j + 1]; sz += D2[j + 2]; }
        const n = k1 - k0, b = i * 3;
        D[b] = 0.5 * D2[b] + (0.5 * sx) / n; D[b + 1] = 0.5 * D2[b + 1] + (0.5 * sy) / n; D[b + 2] = 0.5 * D2[b + 2] + (0.5 * sz) / n;
      }
    }
    // seal: beside the tongue / finger the lip edges come back together (the lip above
    // still lifts), so the lips close tight around it instead of gaping at its sides
    const sealLen = 0.05 * this.hw;
    const hardE = [[], []];
    for (let i = 0; i < N; i++) if (hard[i] && this.edge[i]) hardE[side[i] > 0 ? 0 : 1].push(this.P[i * 3], Math.hypot(H[i * 3], H[i * 3 + 1], H[i * 3 + 2]));
    for (let i = 0; i < N; i++) {
      if (!this.edge[i] || src[i] < 0) continue;
      if (hard[i]) {
        // the lip edge touching it sits right on it (its neighbours don't lift it off)
        D[i * 3] = H[i * 3]; D[i * 3 + 1] = H[i * 3 + 1]; D[i * 3 + 2] = H[i * 3 + 2];
        continue;
      }
      // beside it, the edge opens no more than the contact next to it, closing within ~1 mm
      const list = hardE[side[i] > 0 ? 0 : 1];
      let env = 0;
      for (let k = 0; k < list.length; k += 2) { const dx = (this.P[i * 3] - list[k]) / sealLen; env = Math.max(env, list[k + 1] * Math.exp(-dx * dx)); }
      const d = Math.hypot(D[i * 3], D[i * 3 + 1], D[i * 3 + 2]);
      if (d > env) { const f = env / d; D[i * 3] *= f; D[i * 3 + 1] *= f; D[i * 3 + 2] *= f; }
    }
    // squish: lips pushed up or down bulge out a little at the front
    const C = this.C, hw = this.hw, R = this.rest, Dd = this.D;
    for (let i = 0; i < N; i++) {
      const front = smooth(C.z - 0.45 * hw, C.z + 0.05 * hw, R[i * 3 + 2]);
      if (front > 0) Dd[i * 3 + 2] += 0.22 * Math.abs(Dd[i * 3 + 1]) * front * w8[i];
    }
  }

  // head-frame offsets -> each lip mesh's local space -> the GPU
  write() {
    const F = this.F, D = this.D;
    const inv = this.meshes.map((m) => new THREE.Matrix3().setFromMatrix4(m.matrixWorld).invert());
    const ls = this.meshes.map((m) => (m.geometry.attributes[ATTR] ? layer(m, 'lips') : null));
    for (const l of ls) if (l) beginLayer(l);
    for (let i = 0; i < this.N; i++) {
      const dx = D[i * 3], dy = D[i * 3 + 1], dz = D[i * 3 + 2];
      if (!dx && !dy && !dz) continue;
      // head frame -> world
      _v.set(F.lat.x * dx + F.up.x * dy + F.fwd.x * dz, F.lat.y * dx + F.up.y * dy + F.fwd.y * dz, F.lat.z * dx + F.up.z * dy + F.fwd.z * dz);
      for (let k = this.memStart[i]; k < this.memStart[i + 1]; k++) {
        const m = this.memMesh[k], l = ls[m];
        if (!l) continue;
        _w.copy(_v).applyMatrix3(inv[m]);
        setOffset(l, this.memIdx[k], _w.x, _w.y, _w.z);
      }
    }
    for (const m of this.meshes) commit(m);
    this.active = true;
  }

  // back to no offsets
  clear() {
    if (!this.active) return;
    this.active = false;
    for (const m of this.meshes) {
      if (!m.geometry.attributes[ATTR]) continue;
      beginLayer(layer(m, 'lips'));
      commit(m);
    }
  }

  // is a point (head frame) in the soft part around the mouth? (things there get wrapped)
  covers(x, y, z, within = 0.85) {
    const [RX, RY, RB, RF] = this.R, C = this.C;
    return Math.hypot((x - C.x) / RX, (y - C.y) / RY, (z - C.z) / (z < C.z ? RB : RF)) < within;
  }

  // per welded vertex offset (head frame), for tests and the checks
  offsetAt(i) { return [this.D[i * 3], this.D[i * 3 + 1], this.D[i * 3 + 2]]; }
}

// ---------------------------------------------------------------- the head frame, fast
function frameOf(probe) {
  const head = probe.head, axes = probe.axes;
  const F = {
    lat: new THREE.Vector3(), up: new THREE.Vector3(), fwd: new THREE.Vector3(), p: new THREE.Vector3(),
    update() {
      head.updateWorldMatrix(true, false);
      head.getWorldQuaternion(_q);
      F.p.setFromMatrixPosition(head.matrixWorld);
      F.lat.copy(axes.lat).applyQuaternion(_q); F.up.copy(axes.up).applyQuaternion(_q); F.fwd.copy(axes.fwd).applyQuaternion(_q);
    },
    x: (w) => (w.x - F.p.x) * F.lat.x + (w.y - F.p.y) * F.lat.y + (w.z - F.p.z) * F.lat.z,
    y: (w) => (w.x - F.p.x) * F.up.x + (w.y - F.p.y) * F.up.y + (w.z - F.p.z) * F.up.z,
    z: (w) => (w.x - F.p.x) * F.fwd.x + (w.y - F.p.y) * F.fwd.y + (w.z - F.p.z) * F.fwd.z,
    world: (x, y, z, out) => out.copy(F.p).addScaledVector(F.lat, x).addScaledVector(F.up, y).addScaledVector(F.fwd, z),
  };
  F.update();
  return F;
}

// ---------------------------------------------------------------- skinning a few vertices on the CPU
// (same math as the GPU: shape keys, then the bones)
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

function skinTo(mesh, idx, E, F, put) {
  const g = mesh.geometry, pos = g.attributes.position, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
  const morph = g.morphAttributes.position, infl = mesh.morphTargetInfluences, rel = g.morphTargetsRelative;
  const act = [];
  if (morph && infl) for (let k = 0; k < morph.length && k < infl.length; k++) if (infl[k]) act.push(k);
  const px = F.p.x, py = F.p.y, pz = F.p.z, L = F.lat, U = F.up, W = F.fwd;
  for (let n = 0; n < idx.length; n++) {
    const i = idx[n];
    let x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (act.length) {
      let dx = 0, dy = 0, dz = 0;
      for (const k of act) {
        const a = morph[k], f = infl[k];
        if (rel) { dx += f * a.getX(i); dy += f * a.getY(i); dz += f * a.getZ(i); } else { dx += f * (a.getX(i) - x); dy += f * (a.getY(i) - y); dz += f * (a.getZ(i) - z); }
      }
      x += dx; y += dy; z += dz;
    }
    let wx = 0, wy = 0, wz = 0;
    for (let c = 0; c < 4; c++) {
      const w = sw.getComponent(i, c);
      if (!w) continue;
      const o = si.getComponent(i, c) * 16;
      wx += w * (E[o] * x + E[o + 4] * y + E[o + 8] * z + E[o + 12]);
      wy += w * (E[o + 1] * x + E[o + 5] * y + E[o + 9] * z + E[o + 13]);
      wz += w * (E[o + 2] * x + E[o + 6] * y + E[o + 10] * z + E[o + 14]);
    }
    wx -= px; wy -= py; wz -= pz;
    put(n, wx * L.x + wy * L.y + wz * L.z, wx * U.x + wy * U.y + wz * U.z, wx * W.x + wy * W.y + wz * W.z);
  }
}

// ---------------------------------------------------------------- the tongue as a height field
// Seen from above (x, z), each cell keeps the lowest and highest point of the tongue:
// a lip vertex in that column between the two is inside the tongue.
class Field {
  constructor(x0, z0, cs, nx, nz) {
    Object.assign(this, { x0, z0, cs, nx, nz });
    this.top = new Float32Array(nx * nz);
    this.bot = new Float32Array(nx * nz);
    this.reset();
  }
  reset() { this.top.fill(-Infinity); this.bot.fill(Infinity); }
  set(i, j, y) {
    if (i < 0 || j < 0 || i >= this.nx || j >= this.nz) return;
    const k = j * this.nx + i;
    if (y > this.top[k]) this.top[k] = y;
    if (y < this.bot[k]) this.bot[k] = y;
  }
  point(x, y, z) { this.set(Math.floor((x - this.x0) / this.cs), Math.floor((z - this.z0) / this.cs), y); }
  tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    const cs = this.cs, x0 = this.x0, z0 = this.z0;
    const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(det) < 1e-14) return;
    const i0 = Math.max(0, Math.ceil((Math.min(ax, bx, cx) - x0) / cs - 0.5)), i1 = Math.min(this.nx - 1, Math.floor((Math.max(ax, bx, cx) - x0) / cs - 0.5));
    const j0 = Math.max(0, Math.ceil((Math.min(az, bz, cz) - z0) / cs - 0.5)), j1 = Math.min(this.nz - 1, Math.floor((Math.max(az, bz, cz) - z0) / cs - 0.5));
    for (let j = j0; j <= j1; j++) {
      const pz = z0 + (j + 0.5) * cs;
      for (let i = i0; i <= i1; i++) {
        const px = x0 + (i + 0.5) * cs;
        const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
        const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) continue;
        this.set(i, j, l1 * ay + l2 * by + l3 * cy);
      }
    }
  }
  // -> { bot, top } of the tongue in the column through (x, z), or null
  query(x, z) {
    const fx = (x - this.x0) / this.cs - 0.5, fz = (z - this.z0) / this.cs - 0.5;
    const ni = Math.round(fx), nj = Math.round(fz);
    if (ni < 0 || nj < 0 || ni >= this.nx || nj >= this.nz) return null;
    const nk = nj * this.nx + ni;
    if (!(this.top[nk] >= this.bot[nk])) return null;
    const i = Math.floor(fx), j = Math.floor(fz), tx = fx - i, tz = fz - j;
    let wt = 0, top = 0, bot = 0;
    for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= this.nx || jj >= this.nz) continue;
      const k = jj * this.nx + ii;
      if (!(this.top[k] >= this.bot[k])) continue;
      const w = (di ? tx : 1 - tx) * (dj ? tz : 1 - tz) + 1e-6;
      wt += w; top += w * this.top[k]; bot += w * this.bot[k];
    }
    _fq.top = top / wt; _fq.bot = bot / wt;
    return _fq;
  }
}
const _fq = { top: 0, bot: 0 };

// ---------------------------------------------------------------- capsules (fingers, props)
const _cp = [0, 0, 0];
// p inside capsule c (with margin)? -> the push out: over / under it along the lip's side
// (s = +1 up, -1 down), or around its side when that's much shorter (things coming in end-on)
function capsulePush(px, py, pz, c, s, margin, out) {
  const abx = c.bx - c.ax, aby = c.by - c.ay, abz = c.bz - c.az;
  const ab2 = abx * abx + aby * aby + abz * abz;
  let t = ab2 > 1e-14 ? ((px - c.ax) * abx + (py - c.ay) * aby + (pz - c.az) * abz) / ab2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = px - (c.ax + t * abx), qy = py - (c.ay + t * aby), qz = pz - (c.az + t * abz);
  const d = Math.hypot(qx, qy, qz), R = c.r + margin;
  if (d >= R) return false;
  // straight up (or down) out of it
  const big = 4 * R + Math.sqrt(ab2);
  const hit = capHit(px, py + s * big, pz, 0, -s, 0, c.ax, c.ay, c.az, c.bx, c.by, c.bz, R);
  const e = hit >= 0 ? big - hit : Infinity;
  if (e <= 2.2 * R) { out[0] = 0; out[1] = s * (e + 1e-5); out[2] = 0; return true; }
  // around: the nearest way out
  const k = d > 1e-9 ? (R - d) / d : 0;
  if (k) { out[0] = qx * k; out[1] = qy * k; out[2] = qz * k; } else { out[0] = 0; out[1] = s * R; out[2] = 0; }
  return true;
}

// first hit of a ray (o + t d) on a capsule a-b of radius r, or -1
function capHit(ox, oy, oz, dx, dy, dz, ax, ay, az, bx, by, bz, r) {
  const bax = bx - ax, bay = by - ay, baz = bz - az, oax = ox - ax, oay = oy - ay, oaz = oz - az;
  const baba = bax * bax + bay * bay + baz * baz, bard = bax * dx + bay * dy + baz * dz, baoa = bax * oax + bay * oay + baz * oaz;
  const rdoa = dx * oax + dy * oay + dz * oaz, oaoa = oax * oax + oay * oay + oaz * oaz;
  const A = baba - bard * bard;
  if (A > 1e-12 * Math.max(baba, 1e-12)) {
    const B = baba * rdoa - baoa * bard, Cc = baba * oaoa - baoa * baoa - r * r * baba;
    const h = B * B - A * Cc;
    if (h < 0) return -1;
    const t = (-B - Math.sqrt(h)) / A;
    const y = baoa + t * bard;
    if (y > 0 && y < baba) return t;
  }
  let best = -1;
  for (let k = 0; k < 2; k++) {
    const cx = k ? bx : ax, cy = k ? by : ay, cz = k ? bz : az;
    const ocx = ox - cx, ocy = oy - cy, ocz = oz - cz;
    const b = dx * ocx + dy * ocy + dz * ocz, c = ocx * ocx + ocy * ocy + ocz * ocz - r * r, h = b * b - c;
    if (h > 0) { const t = -b - Math.sqrt(h); if (t >= 0 && (best < 0 || t < best)) best = t; }
  }
  return best;
}

// each finger bone as a capsule to its child (the last one to the fingertip); its
// thickness measured from the skin around it (a share of its length, so it scales)
export function fingerCapsules(model, verts) {
  const rig = model.humanoid;
  const out = [];
  for (const side of ['left', 'right']) {
    const H = rig.handRig && rig.handRig(side);
    if (!H) continue;
    for (const ch of Object.values(H.chains)) {
      const list = ch.bones.filter((b) => b.role !== 'meta').map((b) => b.bone);
      list.forEach((bone, k) => {
        const next = list[k + 1] || null;
        const seg = { a: bone, b: next, tip: next ? null : ch.tipLocal.clone(), ratio: 0.3, off: null };
        const vs = verts.get(bone);
        if (vs && vs.length >= 4) {
          // fitted to the finger's own skin: where its middle really is (often not on the
          // bone) and how thick it is, so the lips touch what you see
          bone.updateWorldMatrix(true, false);
          const A = new THREE.Vector3().setFromMatrixPosition(bone.matrixWorld);
          const B = next ? new THREE.Vector3().setFromMatrixPosition(next.matrixWorld) : seg.tip.clone().applyMatrix4(bone.matrixWorld);
          const len = A.distanceTo(B);
          if (len > 1e-6) {
            const u = B.clone().sub(A).divideScalar(len);
            const perp = [];
            for (const p of vs) {
              const d = p.clone().sub(A), t = d.dot(u);
              if (t < -0.15 * len || t > 1.15 * len) continue;
              perp.push(d.addScaledVector(u, -t));
            }
            if (perp.length >= 4) {
              const off = perp.reduce((a, d) => a.add(d), new THREE.Vector3()).divideScalar(perp.length);
              const ds = perp.map((d) => d.distanceTo(off)).sort((x, y) => x - y);
              seg.ratio = THREE.MathUtils.clamp(ds[Math.floor(ds.length * 0.5)] / len, 0.1, 0.6);
              const q = new THREE.Quaternion();
              bone.getWorldQuaternion(q);
              if (off.length() > 0.05 * len) seg.off = off.applyQuaternion(q.invert()).divideScalar(len);
            }
          }
        }
        out.push(seg);
      });
    }
  }
  return out;
}

// a mesh (prop part) as one capsule along its longest side, in its own space
const _capCache = new WeakMap();
function meshCapsule(o) {
  const g = o.geometry;
  if (!g || !g.attributes || !g.attributes.position) return null;
  let c = _capCache.get(g);
  if (c !== undefined) return c;
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox, size = bb.getSize(new THREE.Vector3()), mid = bb.getCenter(new THREE.Vector3());
  const ax = size.x >= size.y && size.x >= size.z ? 'x' : size.y >= size.z ? 'y' : 'z';
  const others = ['x', 'y', 'z'].filter((k) => k !== ax).map((k) => size[k] / 2);
  const r = Math.max(1e-4, Math.min(...others));
  const half = Math.max(0, size[ax] / 2 - r);
  const a = mid.clone(), b = mid.clone();
  a[ax] -= half; b[ax] += half;
  c = { a, b, r };
  _capCache.set(g, c);
  return c;
}

// a binary min-heap of vertex ids by distance
class Heap {
  constructor(n) { this.ids = new Int32Array(n * 8 + 8); this.keys = new Float32Array(n * 8 + 8); this.size = 0; }
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
