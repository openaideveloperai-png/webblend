// A top-level thing in the scene (imported file, primitive, light, camera...).
// Each model owns an AnimationMixer and a list of clips.
import * as THREE from 'three';
import { JointHelper } from '../core/joints.js';
import { uid } from '../core/util.js';
import { clipWithUuids, bumpClip, parseTrack } from './clips.js';
import { ConstraintSolver, hasConstraints } from './constraints.js';
import { addMMDConstraints } from '../io/mmd.js';
import { syncVFX, removeVFX, restoreVFX } from './vfx.js';

const LOOPS = { repeat: THREE.LoopRepeat, once: THREE.LoopOnce, pingpong: THREE.LoopPingPong };

export class Model {
  constructor(app, root, opts = {}) {
    this.app = app;
    this.id = uid('m');
    this.root = root;
    this.name = opts.name || root.name || 'Model';
    this.kind = opts.kind || 'import';
    this.source = opts.source || '';
    this.format = opts.format || '';
    root.userData.modelId = this.id;
    if (!root.name) root.name = this.name;
    this.mixer = new THREE.AnimationMixer(root);
    this.clips = [];
    this.activeClip = null;
    this.collect();
    this.captureRest();
    this.computeSize();
    this.buildJoints();
    this._humanoid = undefined;
  }

  collect() {
    this.bones = [];
    this.skinned = [];
    this.meshes = [];
    this.morphMeshes = [];
    this.root.traverse((o) => {
      if (o.userData.editorOnly) return;
      if (o.isBone && o.name !== '__static') this.bones.push(o);
      if (o.isSkinnedMesh) this.skinned.push(o);
      if (o.isMesh || o.isPoints || o.isLine) this.meshes.push(o);
      if (o.morphTargetInfluences && o.morphTargetInfluences.length) this.morphMeshes.push(o);
    });
    this.nodeCount = 0;
    this.root.traverse(() => { this.nodeCount++; });
    this.constraints = null;
    // MMD rigs that lost their IK / D-bone setup on export get it back
    if (this.bones.length && !hasConstraints(this.bones)) addMMDConstraints(this.bones);
    if (this.bones.length && hasConstraints(this.bones)) {
      let incomplete = false;
      this.root.traverse((o) => { if (o.userData.constraintsIncomplete) incomplete = true; });
      if (!incomplete) {
        try { const s = new ConstraintSolver(this.root, this.bones); if (s.count) this.constraints = s; } catch (e) { console.warn('constraints', e); }
      }
    }
    this.analyzeBones();
  }

  // Which bones matter for posing: bones that move the mesh (weighted, or
  // carrying parented parts), the control bones that drive them through
  // constraints, IK handles, and their parents. Leaf/helper bones are left out.
  analyzeBones() {
    const weighted = new Set();
    for (const s of this.skinned) {
      const si = s.geometry.attributes.skinIndex, sw = s.geometry.attributes.skinWeight;
      const bones = s.skeleton && s.skeleton.bones;
      if (!si || !sw || !bones) continue;
      const used = new Uint8Array(bones.length);
      for (let i = 0, n = si.count; i < n; i++) {
        for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 1e-3) used[si.getComponent(i, k)] = 1;
      }
      bones.forEach((b, i) => { if (used[i]) weighted.add(b); });
    }
    for (const b of this.bones) {
      if (b.children.some((c) => !c.isBone && hasGeometry(c))) weighted.add(b);
    }
    const driven = this.constraints ? this.constraints.driven : new Map();
    const effective = new Set();
    const addEff = (b, d = 0) => {
      if (effective.has(b) || d > 64) return;
      effective.add(b);
      for (const t of driven.get(b) || []) addEff(t, d + 1);
    };
    for (const b of weighted) addEff(b);
    if (this.constraints) {
      for (const it of this.constraints.items) {
        if (it.c.type !== 'IK' || !it.chain.some((b) => effective.has(b))) continue;
        if (it.target && it.target.isBone) effective.add(it.target);
        if (it.pole && it.pole.isBone) effective.add(it.pole);
      }
    }
    const keep = new Set();
    for (const b of effective) for (let p = b; p && p.isBone; p = p.parent) keep.add(p);
    this.weightedBones = weighted;
    this.effectiveBones = keep;
    this.drivenBones = new Set([...driven.keys()].filter((b) => driven.get(b).some((t) => keep.has(t))));
    const helper = /^_(dummy|shadow)_|^(mch|org|wgt)[-_.]/i;
    let list = this.bones.filter((b) => keep.has(b) && !this.drivenBones.has(b) && !helper.test(b.name));
    if (!weighted.size || list.length < 2) list = this.bones.filter((b) => !helper.test(b.name));
    if (list.length < 2) list = this.bones.slice();
    this.poseBones = list;
  }

  // 2 = moves the mesh, 1 = other, 0 = overridden by constraints
  boneRank(b) {
    if (this.drivenBones && this.drivenBones.has(b)) return 0;
    return this.effectiveBones && this.effectiveBones.has(b) && this.weightedBones.size ? 2 : 1;
  }

  animatedSet() {
    const set = new Set();
    for (const e of this.clips) {
      if (!e.playing || !(e.weight > 0)) continue;
      for (const t of e.clip.tracks) { const i = t.name.indexOf('.'); set.add(i > 0 ? t.name.slice(0, i) : t.name); }
    }
    return set;
  }

  solveConstraints() {
    if (!this.constraints) return false;
    this.constraints.solve(this.animatedSet());
    return true;
  }

  // nodes added after loading (props, effects): give them a rest pose and count them
  adopt(node) {
    node.traverse((o) => {
      this.rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), m: o.morphTargetInfluences ? o.morphTargetInfluences.slice() : null, v: o.visible });
      if ((o.isMesh || o.isPoints || o.isLine) && !this.meshes.includes(o)) this.meshes.push(o);
    });
    this.recount();
  }

  forget(node) {
    node.traverse((o) => {
      this.rest.delete(o);
      const i = this.meshes.indexOf(o);
      if (i >= 0) this.meshes.splice(i, 1);
    });
    this.recount();
  }

  recount() {
    this.nodeCount = 0;
    this.root.traverse(() => { this.nodeCount++; });
    this._uuids = null;
    this.app?.emit?.('scenegraph', this);
  }

  captureRest() {
    this.rest = new Map();
    this.root.traverse((o) => {
      this.rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone(), m: o.morphTargetInfluences ? o.morphTargetInfluences.slice() : null, v: o.visible });
    });
  }

  resetPose(objects) {
    const list = objects || [...this.rest.keys()];
    for (const o of list) {
      const r = this.rest.get(o);
      if (!r) continue;
      if (o === this.root && this.kind !== 'import') continue; // keep placement of primitives
      o.position.copy(r.p);
      o.quaternion.copy(r.q);
      o.scale.copy(r.s);
      if (r.m && o.morphTargetInfluences) for (let i = 0; i < r.m.length; i++) o.morphTargetInfluences[i] = r.m[i];
    }
    this.root.updateMatrixWorld(true);
  }

  computeSize() {
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    // bones give a good size for characters in bind pose
    if (this.skinned.length) {
      // base shape only: shape keys can push vertices far away
      for (const s of this.skinned) { const pa = s.geometry.attributes.position; if (pa) box.union(new THREE.Box3().setFromBufferAttribute(pa).applyMatrix4(s.matrixWorld)); }
    }
    if (box.isEmpty()) box.setFromObject(this.root, false);
    if (box.isEmpty() && this.bones.length) for (const b of this.bones) box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(b.matrixWorld));
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3().setFromMatrixPosition(this.root.matrixWorld), new THREE.Vector3(1, 1, 1));
    this.box = box;
    const s = box.getSize(new THREE.Vector3());
    this.size = Math.max(s.x, s.y, s.z, 1e-3);
    this.height = s.y;
  }

  // after a part is deleted or put back: the mesh lists and size (bones stay as they are)
  refreshParts() {
    this.skinned = [];
    this.meshes = [];
    this.morphMeshes = [];
    this.root.traverse((o) => {
      if (o.userData.editorOnly) return;
      if (o.isSkinnedMesh) this.skinned.push(o);
      if (o.isMesh || o.isPoints || o.isLine) this.meshes.push(o);
      if (o.morphTargetInfluences && o.morphTargetInfluences.length) this.morphMeshes.push(o);
    });
    this.nodeCount = 0;
    this.root.traverse(() => { this.nodeCount++; });
    this.computeSize();
  }

  buildJoints() {
    if (this.joints) { this.joints.parent?.remove(this.joints); this.joints.dispose(); this.joints = null; }
    if (!this.bones.length) return;
    // joint size from typical bone length
    let total = 0, n = 0;
    const p = new THREE.Vector3(), q = new THREE.Vector3();
    for (const b of this.bones) {
      if (b.parent && b.parent.isBone) { p.setFromMatrixPosition(b.matrixWorld); q.setFromMatrixPosition(b.parent.matrixWorld); total += p.distanceTo(q); n++; }
    }
    const avg = n ? total / n : this.size * 0.05;
    const size = Math.min(Math.max(avg * 0.12, this.size * 0.004), this.size * 0.02);
    const shown = this.app.settings.get('showAllBones') ? this.bones : (this.poseBones || this.bones);
    this.joints = new JointHelper(this, shown, size);
    this.joints.visible = this.app.settings.get('showSkeleton') && this.root.visible;
    this.app.viewport.helpers.add(this.joints);
    this.joints.update();
  }

  get humanoid() {
    if (this._humanoid === undefined) this._humanoid = this.app.detectHumanoid ? this.app.detectHumanoid(this) : null;
    return this._humanoid;
  }
  set humanoid(v) { this._humanoid = v; }

  // ---------------------------------------------------------------- clips
  addClip(clip, opts = {}) {
    clip.userData = clip.userData || {};
    if (clip.userData._vfxTaken) restoreVFX(this, clip);
    // make track targets unambiguous and drop tracks that can't bind
    const needs = clip.tracks.some((t) => {
      const { nodeName } = parseTrack(t);
      return !this.uuidSet().has(nodeName);
    });
    if (needs) {
      const before = clip.tracks.length;
      const c = clipWithUuids(clip, this.root);
      c.name = clip.name;
      c.userData = clip.userData;
      c.uuid = clip.uuid; // its effects know it by this
      clip = c;
      if (clip.tracks.length < before && opts.warnDropped !== false) {
        this.app.toast?.(`"${clip.name}": ${before - clip.tracks.length} of ${before} tracks didn't match this model and were skipped`, 'warn', 4000);
      }
    }
    if (!clip.name) clip.name = 'Action';
    clip.name = this.uniqueClipName(clip.name);
    bumpClip(clip);
    const entry = { id: uid('c'), clip, action: null, playing: opts.play ?? true, weight: 1, speed: 1, loop: opts.loop || 'repeat' };
    this.clips.push(entry);
    this.rebuildAction(entry);
    if (!this.activeClip || opts.activate) this.setActiveClip(entry);
    this.app.emit('clips', this);
    return entry;
  }

  uuidSet() {
    if (!this._uuids || this._uuidsCount !== this.nodeCount) {
      this._uuids = new Set();
      this.root.traverse((o) => this._uuids.add(o.uuid));
      this._uuidsCount = this.nodeCount;
    }
    return this._uuids;
  }

  uniqueClipName(name) {
    const names = new Set(this.clips.map((c) => c.clip.name));
    if (!names.has(name)) return name;
    let i = 2;
    while (names.has(`${name} ${i}`)) i++;
    return `${name} ${i}`;
  }

  newClip(name = 'Action', duration = 2) {
    const clip = new THREE.AnimationClip(name, duration, []);
    return this.addClip(clip, { activate: true, play: true });
  }

  rebuildAction(entry) {
    if (entry.clip.userData && entry.clip.userData._vfxTaken) restoreVFX(this, entry.clip);
    const time = entry.action ? entry.action.time : 0;
    // stopping an action makes three.js put its bones back where they were when
    // first animated (often the T-pose); keep the pose on screen instead, and
    // have the new keys evaluated on the next frame
    let keep = null;
    if (entry.action) {
      keep = [];
      this.root.traverse((o) => keep.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone(), o.morphTargetInfluences ? o.morphTargetInfluences.slice() : null]));
      entry.action.stop();
      this.mixer.uncacheAction(entry.clip, this.root);
    }
    this.mixer.uncacheClip(entry.clip);
    const a = this.mixer.clipAction(entry.clip, this.root);
    a.setLoop(LOOPS[entry.loop] || THREE.LoopRepeat, Infinity);
    a.clampWhenFinished = true;
    a.enabled = true;
    a.setEffectiveWeight(entry.weight);
    a.setEffectiveTimeScale(entry.speed);
    a.time = time;
    entry.action = a;
    if (entry.playing) a.play();
    if (keep) {
      for (const [o, p, q, sc, mi] of keep) {
        o.position.copy(p); o.quaternion.copy(q); o.scale.copy(sc);
        if (mi && o.morphTargetInfluences) for (let i = 0; i < mi.length; i++) o.morphTargetInfluences[i] = mi[i];
      }
    }
    if (this.app) { this.app.needsEval = true; this.app.viewport?.requestRender(); }
  }

  rebuildClip(clip) {
    for (const e of this.clips) if (e.clip === clip) this.rebuildAction(e);
  }

  // the user picked a clip: play only that one (others can be layered back on
  // with their play toggles)
  switchClip(entry) {
    if (!entry) return;
    for (const e of this.clips) if (e !== entry && e.playing) this.setPlaying(e, false);
    if (!entry.playing) this.setPlaying(entry, true);
    this.setActiveClip(entry);
    if (this.app) { this.app.needsEval = true; this.app.viewport?.requestRender(); }
  }

  setActiveClip(entry) {
    this.activeClip = entry;
    if (entry && !entry.playing) this.setPlaying(entry, true);
    this.app.emit('activeclip', this);
  }

  setPlaying(entry, on) {
    entry.playing = on;
    if (on) entry.action.play(); else entry.action.stop();
    this.app.emit('clips', this);
  }

  setWeight(entry, w) { entry.weight = w; entry.action.setEffectiveWeight(w); }
  setSpeed(entry, s) { entry.speed = s; entry.action.setEffectiveTimeScale(s); }
  setLoop(entry, loop) { entry.loop = loop; entry.action.setLoop(LOOPS[loop] || THREE.LoopRepeat, Infinity); }

  removeClip(entry) {
    const i = this.clips.indexOf(entry);
    if (i < 0) return;
    // its effects leave with it (kept on the clip for undo)
    removeVFX(this, entry.clip);
    entry.action.stop();
    this.mixer.uncacheAction(entry.clip, this.root);
    this.mixer.uncacheClip(entry.clip);
    this.clips.splice(i, 1);
    if (this.activeClip === entry) this.activeClip = this.clips[0] || null;
    this.app.emit('clips', this);
    this.app.emit('activeclip', this);
  }

  // Solo: only the active clip contributes
  soloActive(on) {
    for (const e of this.clips) {
      if (on) { e._wasPlaying = e.playing; if (e !== this.activeClip && e.playing) this.setPlaying(e, false); }
      else if (e._wasPlaying !== undefined) { if (e._wasPlaying !== e.playing) this.setPlaying(e, e._wasPlaying); delete e._wasPlaying; }
    }
  }

  hasPlaying() { return this.clips.some((c) => c.playing); }

  maxDuration() {
    let d = 0;
    for (const c of this.clips) if (c.playing) d = Math.max(d, c.clip.duration / Math.max(0.01, Math.abs(c.speed)));
    return d;
  }

  evaluate(t) {
    let any = false;
    for (const e of this.clips) {
      if (!e.playing) continue;
      any = true;
      // "once" clips pause/disable themselves at the end; undo that so scrubbing works
      e.action.paused = false;
      e.action.enabled = true;
    }
    if (any) this.mixer.setTime(t);
    this.releaseUnanimated();
    // effects only show while their clip plays (and only on frames they're on)
    syncVFX(this, new Set(this.clips.filter((e) => e.playing).map((e) => e.clip.uuid)));
  }

  // A bone (or shape key) whose keys were all deleted, or whose clip was removed or
  // muted, goes back to its rest pose instead of staying where the last key left it.
  // Things you posed by hand without keys aren't touched.
  releaseUnanimated() {
    const sig = this.clips.map((e) => `${e.id}:${e.playing && e.weight > 0 ? 1 : 0}:${(e.clip.userData && e.clip.userData.version) || 0}:${e.clip.tracks.length}`).join('|');
    if (sig === this._animSig) return;
    this._animSig = sig;
    const now = new Set();
    for (const e of this.clips) {
      if (!e.playing || !(e.weight > 0)) continue;
      for (const tr of e.clip.tracks) now.add(tr.name);
    }
    const prev = this._animPrev;
    this._animPrev = now;
    if (!prev) return;
    let byUuid = this._byUuid;
    if (!byUuid || this._byUuidN !== this.nodeCount) {
      byUuid = this._byUuid = new Map();
      this.root.traverse((o) => byUuid.set(o.uuid, o));
      this._byUuidN = this.nodeCount;
    }
    let changed = false;
    for (const name of prev) {
      if (now.has(name)) continue;
      const dot = name.indexOf('.');
      const o = byUuid.get(name.slice(0, dot));
      const r = o && this.rest.get(o);
      if (!r) continue;
      const prop = name.slice(dot + 1);
      if (prop === 'position') o.position.copy(r.p);
      else if (prop === 'quaternion') o.quaternion.copy(r.q);
      else if (prop === 'scale') o.scale.copy(r.s);
      else if (prop === 'visible') o.visible = r.v;
      else {
        const m = /^morphTargetInfluences\[(\d+)\]$/.exec(prop);
        if (m && o.morphTargetInfluences && r.m) o.morphTargetInfluences[+m[1]] = r.m[+m[1]] ?? 0;
        else continue;
      }
      changed = true;
    }
    if (changed) this.root.updateMatrixWorld(true);
  }

  updateHelpers() {
    if (this.joints && this.joints.visible) this.joints.update();
  }

  setVisible(v) {
    this.root.visible = v;
    if (this.joints) this.joints.visible = v && this.app.settings.get('showSkeleton');
  }

  dispose(sharedCheck) {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.root);
    if (this.joints) { this.joints.parent?.remove(this.joints); this.joints.dispose(); }
    disposeObject(this.root, sharedCheck);
  }
}

function hasGeometry(o) {
  let found = false;
  o.traverse((c) => { if (!found && (c.isMesh || c.isPoints || c.isLine)) found = true; });
  return found;
}

export function disposeObject(root, isShared) {
  const done = new Set();
  root.traverse((o) => {
    if (o.geometry && !done.has(o.geometry) && !(isShared && isShared(o.geometry))) { done.add(o.geometry); o.geometry.dispose(); }
    if (o.material) {
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (done.has(m) || (isShared && isShared(m))) continue;
        done.add(m);
        for (const k of Object.keys(m)) {
          const v = m[k];
          if (v && v.isTexture && !done.has(v) && !(isShared && isShared(v))) { done.add(v); v.dispose(); if (v.image && v.image.close) { try { v.image.close(); } catch { /* ignore */ } } }
        }
        m.dispose();
      }
    }
    if (o.skeleton && o.skeleton.boneTexture) o.skeleton.dispose();
    if (o.isLight && o.shadow && o.shadow.map) o.shadow.map.dispose();
  });
}
