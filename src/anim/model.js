// A top-level thing in the scene (imported file, primitive, light, camera...).
// Each model owns an AnimationMixer and a list of clips.
import * as THREE from 'three';
import { JointHelper } from '../core/joints.js';
import { uid } from '../core/util.js';
import { clipWithUuids, bumpClip, parseTrack } from './clips.js';

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
      for (const s of this.skinned) { s.geometry.computeBoundingBox(); box.union(s.geometry.boundingBox.clone().applyMatrix4(s.matrixWorld)); }
    }
    if (box.isEmpty()) box.setFromObject(this.root, false);
    if (box.isEmpty() && this.bones.length) for (const b of this.bones) box.expandByPoint(new THREE.Vector3().setFromMatrixPosition(b.matrixWorld));
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3().setFromMatrixPosition(this.root.matrixWorld), new THREE.Vector3(1, 1, 1));
    this.box = box;
    const s = box.getSize(new THREE.Vector3());
    this.size = Math.max(s.x, s.y, s.z, 1e-3);
    this.height = s.y;
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
    this.joints = new JointHelper(this, this.bones, size);
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
    const time = entry.action ? entry.action.time : 0;
    if (entry.action) {
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
  }

  rebuildClip(clip) {
    for (const e of this.clips) if (e.clip === clip) this.rebuildAction(e);
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
    if (!this.clips.length) return;
    let any = false;
    for (const e of this.clips) {
      if (!e.playing) continue;
      any = true;
      // "once" clips pause/disable themselves at the end; undo that so scrubbing works
      e.action.paused = false;
      e.action.enabled = true;
    }
    if (any) this.mixer.setTime(t);
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
