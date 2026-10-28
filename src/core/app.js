// Central application state and commands.
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import { Emitter, clamp, stripExt } from './util.js';
import { Settings, QUALITY_LEVELS, QUALITY_PRESETS, detectQuality } from './settings.js';
import { History } from './history.js';
import { Viewport } from './viewport.js';
import { Model, disposeObject } from '../anim/model.js';
import { setKey, snapshotClip, restoreClip, findTrackIndex, hasKeyAt, deleteKeys, clipInfo, PROPS, propDesc, bumpClip, clipWithUuids } from '../anim/clips.js';
import { detectHumanoid, retargetClip } from '../anim/humanoid.js';
import { attachProp, detachProp, propOf, restoreFX, isProp, wrapAsProp } from '../anim/props-anim.js';
import { ConstraintSolver, hasConstraints } from '../anim/constraints.js';
import { isPoseClip, poseFromClip } from '../anim/face.js';
import { vmdModelClip, vmdMorphTracks } from '../io/mmd.js';
import { ikChain, solveIK } from '../anim/ik.js';
import { AIAssistant } from '../anim/ai.js';
import { Importer, unsupportedMessage } from '../io/importer.js';
import { optimizeTextures } from '../io/textures.js';
import { makePrimitive, makeLight, makeCamera, makeEmpty, makeMannequin, PRIMITIVES } from '../scene/primitives.js';
import { onDecorationReady } from '../scene/patterns.js';

const _v = new THREE.Vector3();

export class App extends Emitter {
  constructor(dom) {
    super();
    this.dom = dom;
    this.settings = new Settings();
    this.history = new History(this, this.settings.get('undoLimit'));
    this.models = [];
    this.selection = { model: null, object: null };
    this.transport = { time: 0, playing: false, loop: true };
    this.needsEval = false;
    this.toast = (msg) => console.log('[toast]', msg);
    this.world = new THREE.Group();
    this.world.name = 'World';
    this.viewport = new Viewport(this, dom.viewport);
    // drawings on props load a moment later: show them when they arrive
    onDecorationReady(() => this.viewport.requestRender());
    this.viewport.scene.add(this.world);
    // first-run quality detection
    if (!this.settings.get('quality')) {
      const d = detectQuality(this.viewport.renderer.getContext());
      this.settings.set('quality', d.quality);
      this.detected = d;
    }
    this.viewport.applyQuality(this.settings.preset());
    this.importer = new Importer(this);
    this.ai = new AIAssistant(this);
    this.gizmoMode = 'translate';
    this.gizmoSpace = 'local';
    this.ikTarget = new THREE.Object3D();
    this.ikTarget.name = 'IK target';
    this.ikTarget.userData.helper = true;
    this.viewport.helpers.add(this.ikTarget);
    this.selBox = new THREE.BoxHelper(new THREE.Object3D(), 0xffb84a);
    this.selBox.userData.helper = true;
    this.selBox.material.depthTest = false;
    this.selBox.material.transparent = true;
    this.selBox.material.opacity = 0.55;
    this.selBox.visible = false;
    this.viewport.helpers.add(this.selBox);
    this.cameraHelpers = new Map();
    this.bindGizmo();
    this.detectHumanoid = (model) => detectHumanoid(model.root, model.bones, { rank: (b) => model.boneRank(b) });
  }

  fatal(msg) { this.emit('fatal', msg); }

  // ------------------------------------------------------------ models
  addModel(root, opts = {}) {
    this.world.add(root);
    root.updateMatrixWorld(true);
    const model = new Model(this, root, opts);
    this.models.push(model);
    if (root.isCamera) this.attachCameraHelper(model);
    // single-frame actions (a rig's mouth shapes, saved poses) are poses, not clips:
    // they go to Animations -> Poses and the AI can blend them
    model.poses = [];
    const stills = [];
    for (const clip of opts.animations || []) {
      if (isPoseClip(clip)) {
        const pose = poseFromClip(model, clip);
        if (pose && !pose.empty) model.poses.push(pose); else stills.push(clip.name);
        continue;
      }
      model.addClip(clip, { play: false, warnDropped: false });
    }
    if (model.poses.length || stills.length) {
      const parts = [];
      if (model.poses.length) parts.push(`${model.poses.length} pose${model.poses.length > 1 ? 's' : ''} saved in the file (${model.poses.slice(0, 4).map((p) => p.name).join(', ')}${model.poses.length > 4 ? '…' : ''}) ${model.poses.length > 1 ? 'are' : 'is'} under Animations → Poses, and the AI can use ${model.poses.length > 1 ? 'them' : 'it'}`);
      if (stills.length) parts.push(`${stills.slice(0, 3).map((n) => `"${n}"`).join(', ')}${stills.length > 3 ? ` and ${stills.length - 3} more` : ''} ${stills.length > 1 ? 'are single frames' : 'is a single frame'} identical to the rest pose (no motion in ${stills.length > 1 ? 'them' : 'it'}), so ${stills.length > 1 ? 'they were' : 'it was'} left out`);
      model.importNotes = parts;
    }
    if (model.clips.length) {
      // play the first clip so the user sees motion right away
      model.setPlaying(model.clips[0], true);
      model.setActiveClip(model.clips[0]);
    }
    this.updateWorldScale();
    this.emit('models');
    if (opts.select !== false) this.select(root, model);
    this.needsEval = true;
    this.viewport.requestRender();
    return model;
  }

  attachCameraHelper(model) {
    // short proxy frustum so the guide lines don't run across the whole scene
    const proxy = new THREE.PerspectiveCamera();
    const h = new THREE.CameraHelper(proxy);
    h.userData.helper = true;
    h.userData.proxy = proxy;
    this.viewport.helpers.add(h);
    this.cameraHelpers.set(model, h);
  }

  updateCameraHelper(model, h) {
    const cam = model.root, proxy = h.userData.proxy;
    cam.updateMatrixWorld(true);
    proxy.fov = cam.fov; proxy.aspect = this.viewport.camera.aspect; proxy.near = Math.min(cam.near, 0.05);
    proxy.far = Math.max(0.5, (this.viewport.worldScale || 4) * 0.25);
    proxy.updateProjectionMatrix();
    proxy.matrixWorld.copy(cam.matrixWorld);
    h.update();
  }

  updateWorldScale() {
    const box = new THREE.Box3();
    for (const m of this.models) if (m.kind === 'import' || m.kind === 'character' || m.kind === 'skeleton') box.union(m.box);
    let size = 4;
    if (!box.isEmpty()) { const s = box.getSize(_v); size = Math.max(s.x, s.y, s.z); }
    this.viewport.setWorldScale(Math.max(size * 1.5, 2));
  }

  modelOf(obj) {
    let o = obj;
    while (o) {
      if (o.userData && o.userData.modelId) return this.models.find((m) => m.id === o.userData.modelId) || null;
      o = o.parent;
    }
    return null;
  }

  removeModel(model, { undoable = true } = {}) {
    const i = this.models.indexOf(model);
    if (i < 0) return;
    this.models.splice(i, 1);
    this.world.remove(model.root);
    if (model.joints) model.joints.visible = false;
    const ch = this.cameraHelpers.get(model);
    if (ch) ch.visible = false;
    if (this.viewport.activeCamera === model.root) this.lookThrough(null);
    if (this.selection.model === model) this.select(null);
    this.emit('models');
    this.viewport.requestRender();
    const finalize = () => {
      if (this.models.includes(model)) return;
      const shared = this.sharedResources(model);
      model.dispose((r) => shared.has(r));
      if (ch) { this.viewport.helpers.remove(ch); ch.dispose(); this.cameraHelpers.delete(model); }
    };
    if (!undoable) { finalize(); return; }
    let undone = false;
    this.toast(`Deleted "${model.name}"`, 'info', 7000, { label: 'Undo', run: () => { undone = true; this.restoreModel(model, i); } });
    setTimeout(() => { if (!undone) finalize(); }, 7500);
  }

  restoreModel(model, index) {
    this.world.add(model.root);
    this.models.splice(Math.min(index, this.models.length), 0, model);
    if (model.joints) model.joints.visible = this.settings.get('showSkeleton');
    const ch = this.cameraHelpers.get(model);
    if (ch) ch.visible = true;
    this.emit('models');
    this.select(model.root, model);
  }

  // geometries/materials/textures used by other models (duplicates share them)
  sharedResources(except) {
    const set = new Set();
    for (const m of this.models) {
      if (m === except) continue;
      m.root.traverse((o) => {
        if (o.geometry) set.add(o.geometry);
        if (o.material) for (const mat of Array.isArray(o.material) ? o.material : [o.material]) {
          set.add(mat);
          for (const k of Object.keys(mat)) if (mat[k] && mat[k].isTexture) set.add(mat[k]);
        }
      });
    }
    return set;
  }

  duplicateModel(model) {
    const clone = SkeletonUtils.clone(model.root);
    clone.name = model.name + ' copy';
    const offset = model.size * 0.8;
    clone.position.x += offset;
    // map node uuids old -> new by walking both trees in parallel
    const map = new Map();
    const walk = (a, b) => { map.set(a.uuid, b.uuid); a.children.forEach((c, i) => b.children[i] && walk(c, b.children[i])); };
    walk(model.root, clone);
    const clips = model.clips.map((e) => {
      const c = e.clip.clone();
      c.tracks.forEach((t) => {
        const dot = t.name.indexOf('.');
        const id = t.name.slice(0, dot);
        if (map.has(id)) t.name = map.get(id) + t.name.slice(dot);
      });
      // keep root motion relative: shift root position keys by the offset
      for (const t of c.tracks) if (t.name.startsWith(clone.uuid + '.position')) for (let i = 0; i < t.values.length; i += 3) t.values[i] += offset;
      return c;
    });
    const m2 = this.addModel(clone, { name: clone.name, kind: model.kind, source: model.source, format: model.format, animations: clips });
    // poses saved in the file follow to the copy's nodes
    if (model.poses && model.poses.length) {
      const byUuid = new Map();
      clone.traverse((o) => byUuid.set(o.uuid, o));
      m2.poses = model.poses.map((p) => ({ ...p, deltas: p.deltas.map((d) => ({ ...d, node: byUuid.get(map.get(d.node.uuid)) })).filter((d) => d.node) }));
    }
    model.clips.forEach((e, i) => { const e2 = m2.clips[i]; if (e2) { m2.setPlaying(e2, e.playing); m2.setWeight(e2, e.weight); m2.setSpeed(e2, e.speed); m2.setLoop(e2, e.loop); } });
    this.toast(`Duplicated "${model.name}"`, 'ok');
    return m2;
  }

  clearScene() {
    for (const m of [...this.models]) this.removeModel(m, { undoable: false });
    this.history.clear();
    this.setTime(0);
    this.pause();
  }

  // ------------------------------------------------------------ add built-ins
  addPrimitive(type) {
    const mesh = makePrimitive(type);
    // place next to existing things
    const n = this.models.filter((m) => m.kind === 'primitive').length;
    mesh.position.x += (n % 5) * 1.3 - (this.models.length ? 0 : 0);
    if (this.models.length) mesh.position.x += this.sceneBox().max.x + 0.8;
    return this.addModel(mesh, { name: PRIMITIVES[type]?.label || 'Object', kind: 'primitive' });
  }
  addLight(type) {
    const light = makeLight(type);
    return this.addModel(light, { name: light.name, kind: 'light' });
  }
  addCamera() {
    const cam = makeCamera();
    return this.addModel(cam, { name: 'Camera', kind: 'camera' });
  }
  addEmpty() { return this.addModel(makeEmpty(), { name: 'Empty', kind: 'empty' }); }
  addMannequin() {
    const root = makeMannequin('Mannequin');
    if (this.models.length) root.position.x = this.sceneBox().max.x + 0.8;
    const m = this.addModel(root, { name: 'Mannequin', kind: 'character' });
    this.viewport.frameAll();
    return m;
  }

  sceneBox() {
    const box = new THREE.Box3();
    for (const m of this.models) if (m.root.visible && m.kind !== 'light' && m.kind !== 'camera') box.expandByObject(m.root);
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3());
    return box;
  }

  // ------------------------------------------------------------ selection
  select(object, model) {
    if (object && !model) model = this.modelOf(object);
    const prev = this.selection;
    if (prev.object === object && prev.model === model) return;
    // highlight
    for (const m of this.models) if (m.joints) m.joints.highlight(null);
    this.selection = { model: model || null, object: object || null };
    if (model && model.joints && object && object.isBone) {
      const chain = this.settings.get('ikChain') > 0 ? ikChain(object, this.settings.get('ikChain')) : [];
      model.joints.highlight(object, this.gizmoMode === 'translate' ? chain : []);
    }
    if (object && object.isBone && this.gizmoMode === 'translate' && !this.canIK(object)) this.setGizmoMode('rotate', true);
    this.attachGizmo();
    this.updateSelBox();
    this.emit('selection', this.selection);
    this.emit('activeclip', model);
    this.viewport.requestRender();
  }

  selectFromViewport(hit, shift) {
    if (!hit) { if (!shift) this.select(null); return; }
    if (hit.bone) return this.select(hit.bone, hit.model);
    let obj = hit.object;
    const model = hit.model || this.modelOf(obj);
    if (!model) return;
    if (this.settings.get('pickMode') === 'model' || obj.isSkinnedMesh || obj.userData.editorOnly) obj = model.root;
    // a trail frame or a particle: select the effect it belongs to
    if (obj.userData.vfx) { let g = obj; while (g && g.userData.fx !== 'vfx') g = g.parent; if (!g && obj.userData.vfxGroup) g = model.root.getObjectByProperty('uuid', obj.userData.vfxGroup); if (g) obj = g; }
    // clicking the selected part again selects its parent (handy for nested models)
    if (this.selection.object === obj && obj !== model.root && obj.parent) {
      let p = obj.parent;
      while (p && p !== model.root && !p.name) p = p.parent;
      obj = p || model.root;
    }
    this.select(obj, model);
  }

  selectParent() {
    const o = this.selection.object;
    if (!o || !this.selection.model || o === this.selection.model.root) return;
    this.select(o.parent, this.selection.model);
  }

  updateSelBox() {
    const o = this.selection.object;
    const m = this.selection.model;
    // characters show their joints instead; skinned bounds are bind-pose only
    const rigged = m && m.bones.length && (o === m.root || o.isSkinnedMesh);
    if (o && !o.isBone && !rigged && !o.isLight && !o.isCamera) {
      this.selBox.setFromObject(o);
      this.selBox.visible = true;
    } else {
      this.selBox.visible = false;
    }
  }

  canIK(bone) {
    return bone && bone.isBone && this.settings.get('ikChain') > 0 && bone.parent && bone.parent.isBone && bone.parent.parent && bone.parent.parent.isBone;
  }

  // ------------------------------------------------------------ gizmo
  setGizmoMode(mode, silent) {
    this.gizmoMode = mode;
    this.viewport.gizmo.setMode(mode);
    this.attachGizmo();
    const o = this.selection.object;
    if (o && o.isBone && this.selection.model && this.selection.model.joints) {
      const chain = mode === 'translate' && this.canIK(o) ? ikChain(o, this.settings.get('ikChain')) : [];
      this.selection.model.joints.highlight(o, chain);
    }
    if (!silent) this.emit('gizmo', mode);
    this.viewport.requestRender();
  }

  setGizmoSpace(space) {
    this.gizmoSpace = space;
    this.viewport.gizmo.setSpace(space);
    this.emit('gizmo', this.gizmoMode);
    this.viewport.requestRender();
  }

  attachGizmo() {
    const g = this.viewport.gizmo;
    const o = this.selection.object;
    g.setMode(this.gizmoMode);
    g.setSpace(this.gizmoSpace);
    if (!o) { g.detach(); return; }
    if (o.isBone && this.gizmoMode === 'translate' && this.canIK(o)) {
      o.getWorldPosition(this.ikTarget.position);
      this.ikTarget.updateMatrixWorld(true);
      g.attach(this.ikTarget);
      g.setSpace('world');
      this.ikActive = true;
      return;
    }
    this.ikActive = false;
    g.attach(o);
  }

  bindGizmo() {
    this.on('gizmo:start', () => {
      if (this.transport.playing) this.pause();
      const o = this.selection.object;
      if (!o) return;
      let objs = [o];
      if (this.ikActive) objs = ikChain(o, this.settings.get('ikChain'));
      this._drag = { objs, before: objs.map(snapTransform), ik: this.ikActive };
    });
    this.on('gizmo:change', () => {
      if (this.ikActive && this._drag) {
        const o = this.selection.object;
        const chain = ikChain(o, this.settings.get('ikChain'));
        solveIK(chain, o, this.ikTarget.getWorldPosition(new THREE.Vector3()));
      }
      this.updateSelBox();
      this.emit('transform');
    });
    this.on('gizmo:end', () => {
      const d = this._drag;
      this._drag = null;
      this.viewport.gizmoJustUsed = true;
      if (!d) return;
      const after = d.objs.map(snapTransform);
      const changed = new Set();
      d.objs.forEach((o, i) => {
        const b = d.before[i], a = after[i];
        if (!b.p.equals(a.p)) changed.add('position');
        if (Math.abs(b.q.dot(a.q)) < 0.999999) changed.add('quaternion');
        if (!b.s.equals(a.s)) changed.add('scale');
      });
      if (d.ik) {
        const o = this.selection.object;
        o.getWorldPosition(this.ikTarget.position);
        changed.delete('position');
        changed.add('quaternion');
      }
      if (!changed.size) return;
      const model = this.selection.model;
      let clipUndo = null;
      if (this.settings.get('autoKey') && model) {
        const entry = this.ensureClip(model);
        const before = snapshotClip(entry.clip);
        const t = this.localTime(entry);
        for (const o of d.objs) for (const prop of changed) setKey(entry.clip, model.root, o, prop, t, PROPS[prop].get(o), this.keyEps());
        model.rebuildClip(entry.clip);
        clipUndo = { model, entry, before, after: snapshotClip(entry.clip) };
        this.emit('keys', model);
      }
      const objs = d.objs;
      this.history.push({
        label: d.ik ? 'IK pose' : 'Transform',
        undo: () => { objs.forEach((o, i) => applyTransform(o, d.before[i])); if (clipUndo) { restoreClip(clipUndo.entry.clip, clipUndo.before); clipUndo.model.rebuildClip(clipUndo.entry.clip); this.emit('keys', clipUndo.model); } this.afterEdit(); },
        redo: () => { objs.forEach((o, i) => applyTransform(o, after[i])); if (clipUndo) { restoreClip(clipUndo.entry.clip, clipUndo.after); clipUndo.model.rebuildClip(clipUndo.entry.clip); this.emit('keys', clipUndo.model); } this.afterEdit(); },
      });
      this.emit('transform');
    });
  }

  afterEdit() {
    this.updateSelBox();
    this.emit('transform');
    this.viewport.requestRender();
  }

  // Change a property from the UI (properties panel)
  setProperty(obj, prop, value, { commit = true, label = 'Edit', before: beforeOverride } = {}) {
    const desc = propDesc(prop);
    if (!desc) return;
    const before = beforeOverride || desc.get(obj);
    desc.set(obj, value);
    const model = this.modelOf(obj);
    let clipUndo = null;
    if (commit && this.settings.get('autoKey') && model) {
      const entry = this.ensureClip(model);
      const b = snapshotClip(entry.clip);
      setKey(entry.clip, model.root, obj, prop, this.localTime(entry), desc.get(obj), this.keyEps());
      model.rebuildClip(entry.clip);
      clipUndo = { model, entry, before: b, after: snapshotClip(entry.clip) };
      this.emit('keys', model);
    }
    if (commit) {
      const after = desc.get(obj);
      this.history.push({
        label,
        undo: () => { desc.set(obj, before); if (clipUndo) { restoreClip(clipUndo.entry.clip, clipUndo.before); model.rebuildClip(clipUndo.entry.clip); this.emit('keys', model); } this.afterEdit(); },
        redo: () => { desc.set(obj, after); if (clipUndo) { restoreClip(clipUndo.entry.clip, clipUndo.after); model.rebuildClip(clipUndo.entry.clip); this.emit('keys', model); } this.afterEdit(); },
      });
    }
    this.afterEdit();
  }

  // ------------------------------------------------------------ clips & keys
  ensureClip(model) {
    if (model.activeClip) return model.activeClip;
    const e = model.newClip('Action', Math.max(2, this.transport.time + 1));
    this.emit('clips', model);
    return e;
  }

  keyEps() { return 0.5 / (this.settings.get('fps') || 30); }

  localTime(entry) {
    if (!entry) return this.transport.time;
    const d = entry.clip.duration || 0;
    let t = this.transport.time * entry.speed;
    if (d > 0 && entry.loop === 'repeat' && t > d + 1e-6) t = t % d;
    if (d > 0 && entry.loop === 'once') t = Math.min(t, d);
    return Math.max(0, this.snap(t));
  }

  snap(t) {
    if (!this.settings.get('snap')) return t;
    const fps = this.settings.get('fps') || 30;
    return Math.round(t * fps) / fps;
  }

  defaultKeyProps(obj) {
    const model = this.modelOf(obj);
    if (obj.isBone) {
      const props = ['quaternion'];
      const r = model && model.rest.get(obj);
      const isRootBone = !obj.parent || !obj.parent.isBone;
      if (isRootBone || (r && r.p.distanceToSquared(obj.position) > 1e-10)) props.push('position');
      if (r && r.s.distanceToSquared(obj.scale) > 1e-10) props.push('scale');
      return props;
    }
    return ['position', 'quaternion', 'scale'];
  }

  // Insert keys for the selection at the current time.
  keySelection(props) {
    const { object, model } = this.selection;
    if (!object || !model) { this.toast('Select something to key first', 'warn'); return; }
    const entry = this.ensureClip(model);
    const t = this.localTime(entry);
    props = props || this.defaultKeyProps(object);
    this.editClip(model, entry, (clip) => {
      for (const p of props) setKey(clip, model.root, object, p, t, propDesc(p).get(object), this.keyEps());
    }, 'Insert key');
    this.toast(`Keyed ${object.name || 'object'} at frame ${Math.round(t * this.settings.get('fps'))}`, 'ok', 1200);
  }

  // Key every bone of a model (pose key)
  keyPose(model) {
    model = model || this.selection.model;
    if (!model) return;
    const entry = this.ensureClip(model);
    const t = this.localTime(entry);
    const targets = model.bones.length ? model.bones : [model.root];
    this.editClip(model, entry, (clip) => {
      for (const o of targets) for (const p of this.defaultKeyProps(o)) setKey(clip, model.root, o, p, t, propDesc(p).get(o), this.keyEps());
    }, 'Key pose');
  }

  deleteKeysAt(obj) {
    const model = this.selection.model;
    obj = obj || this.selection.object;
    if (!model || !obj || !model.activeClip) return;
    const entry = model.activeClip;
    const t = this.localTime(entry);
    const info = clipInfo(entry.clip, model.root);
    const g = info.groups.get(obj) || [];
    const sel = [];
    for (const { track, ti } of g) {
      track.times.forEach((x, ki) => { if (Math.abs(x - t) <= this.keyEps()) sel.push({ ti, ki }); });
    }
    if (!sel.length) return;
    this.editClip(model, entry, (clip) => deleteKeys(clip, sel), 'Delete keys');
  }

  // Generic undoable clip edit
  editClip(model, entry, fn, label = 'Edit keys') {
    const before = snapshotClip(entry.clip);
    const result = fn(entry.clip);
    bumpClip(entry.clip);
    const after = snapshotClip(entry.clip);
    model.rebuildClip(entry.clip);
    this.needsEval = true;
    this.emit('keys', model);
    this.viewport.requestRender();
    this.history.push({
      label,
      undo: () => { restoreClip(entry.clip, before); model.rebuildClip(entry.clip); this.needsEval = true; this.emit('keys', model); this.viewport.requestRender(); },
      redo: () => { restoreClip(entry.clip, after); model.rebuildClip(entry.clip); this.needsEval = true; this.emit('keys', model); this.viewport.requestRender(); },
    });
    return result;
  }

  propKeyState(obj, prop) {
    const model = this.modelOf(obj);
    const entry = model && model.activeClip;
    if (!entry) return 'none';
    const ti = findTrackIndex(entry.clip, model.root, obj, prop);
    if (ti < 0) return 'none';
    return hasKeyAt(entry.clip.tracks[ti], this.localTime(entry), this.keyEps()) ? 'key' : 'animated';
  }

  toggleKeyProp(obj, prop) {
    const model = this.modelOf(obj);
    if (!model) return;
    const state = this.propKeyState(obj, prop);
    const entry = this.ensureClip(model);
    const t = this.localTime(entry);
    if (state === 'key') {
      const ti = findTrackIndex(entry.clip, model.root, obj, prop);
      const tr = entry.clip.tracks[ti];
      const sel = [];
      tr.times.forEach((x, ki) => { if (Math.abs(x - t) <= this.keyEps()) sel.push({ ti, ki }); });
      this.editClip(model, entry, (clip) => deleteKeys(clip, sel), 'Delete key');
    } else {
      this.editClip(model, entry, (clip) => setKey(clip, model.root, obj, prop, t, propDesc(prop).get(obj), this.keyEps()), 'Insert key');
    }
  }

  // Put a prop (gun, sword...) in a character's hand; undoable
  giveProp(model, prop, side = 'right') {
    attachProp(model, prop, side);
    this.needsEval = true;
    this.viewport.requestRender();
    this.history.push({
      label: 'Give prop',
      undo: () => { detachProp(model, prop); this.needsEval = true; this.viewport.requestRender(); },
      redo: () => { attachProp(model, prop, side); this.needsEval = true; this.viewport.requestRender(); },
    });
    return prop;
  }

  // put a whole scene model (e.g. an imported gun) in a character's hand
  giveModelTo(model, holder, side = 'right') {
    const i = this.models.indexOf(model);
    if (i < 0 || !holder.humanoid) return null;
    model.mixer.stopAllAction();
    this.models.splice(i, 1);
    this.world.remove(model.root);
    if (model.joints) model.joints.visible = false;
    const prop = isProp(model.root) ? model.root : wrapAsProp(model.root, model.name);
    if (prop === model.root) { prop.position.set(0, 0, 0); prop.quaternion.identity(); }
    delete model.root.userData.modelId;
    attachProp(holder, prop, side);
    this.emit('models');
    this.select(holder.root, holder);
    this.needsEval = true;
    this.viewport.requestRender();
    this.history.push({
      label: 'Give to character',
      undo: () => { detachProp(holder, prop); this.restoreModel(model, i); },
      redo: () => { this.models.splice(this.models.indexOf(model), 1); this.world.remove(model.root); attachProp(holder, prop, side); this.emit('models'); },
    });
    return prop;
  }

  removeProp(model, prop) {
    const side = prop.userData.hold ? prop.userData.hold.side : 'right';
    if (this.selection.object && propOf(this.selection.object) === prop) this.select(model.root, model);
    // clips made for this prop go with it; other clips lose their keys on its parts
    const uuids = new Set();
    prop.traverse((o) => uuids.add(o.uuid));
    model.root.traverse((o) => { if (o.userData.owner === prop.uuid) o.traverse((c) => uuids.add(c.uuid)); });
    const removed = model.clips.filter((e) => e.clip.userData && e.clip.userData.prop === prop.uuid);
    const stripped = [];
    let fx = [];
    const take = () => {
      stripped.length = 0;
      for (const e of model.clips) {
        if (removed.includes(e)) continue;
        const keep = e.clip.tracks.filter((t) => !uuids.has(t.name.slice(0, t.name.indexOf('.'))));
        if (keep.length !== e.clip.tracks.length) { stripped.push([e, e.clip.tracks]); e.clip.tracks = keep; model.rebuildAction(e); }
      }
      for (const e of removed) model.removeClip(e);
      fx = detachProp(model, prop);
      this.emit('clips', model);
      this.needsEval = true;
      this.viewport.requestRender();
    };
    take();
    this.history.push({
      label: 'Remove prop',
      undo: () => {
        attachProp(model, prop, side);
        restoreFX(model, fx);
        for (const [e, tracks] of stripped) { e.clip.tracks = tracks; model.rebuildAction(e); }
        for (const e of removed) { model.clips.push(e); model.rebuildAction(e); }
        this.emit('clips', model);
        this.needsEval = true;
        this.viewport.requestRender();
      },
      redo: take,
    });
  }

  // Add a generated / imported clip, make it the one playing
  addClipToModel(model, clip, { solo = true, loop = true } = {}) {
    if (solo) for (const e of model.clips) if (e.playing) model.setPlaying(e, false);
    const entry = model.addClip(clip, { activate: true, play: true, loop: loop ? 'repeat' : 'once' });
    model.setActiveClip(entry);
    this.history.push({
      label: 'Add clip',
      undo: () => { model.removeClip(entry); this.needsEval = true; this.viewport.requestRender(); },
      redo: () => { model.clips.push(entry); model.rebuildAction(entry); model.setActiveClip(entry); this.emit('clips', model); this.needsEval = true; },
    });
    this.emit('clips', model);
    this.setTime(0);
    return entry;
  }

  // ------------------------------------------------------------ retargeting
  // Apply clips from another source (animation-only file, other model) onto `model`.
  applyAnimations(model, clips, srcRoot) {
    const added = [];
    let srcRig = null;
    if (srcRoot) {
      const bones = [];
      srcRoot.traverse((o) => { if (o.isBone) bones.push(o); });
      srcRig = detectHumanoid(srcRoot, bones);
      // sources with IK / constraints (MMD motions): solve them while sampling
      if (srcRig && hasConstraints(bones)) {
        const solver = new ConstraintSolver(srcRoot, bones);
        srcRig.afterEvaluate = (clip) => {
          if (!clip._animSet) clip._animSet = new Set(clip.tracks.map((t) => t.name.slice(0, t.name.indexOf('.'))));
          solver.solve(clip._animSet);
          srcRoot.updateMatrixWorld(true);
        };
      }
    }
    const vmd = srcRoot && srcRoot.userData.vmd;
    for (const clip of clips) {
      if (vmd) {
        // MMD motion: by bone name onto MMD rigs, otherwise retarget to a humanoid
        let out = null, how = '';
        const direct = vmdModelClip(vmd, model.root, clip.name);
        if (direct && (direct.matched / direct.total >= 0.3 || direct.core >= 0.6)) { out = direct.clip; how = `MMD bones matched (${direct.matched}/${direct.total})`; }
        else if (srcRig && model.humanoid) {
          out = retargetClip(srcRig, clip, model.humanoid, { name: clip.name });
          out.tracks.push(...vmdMorphTracks(vmd, model.root));
          out.resetDuration();
          how = 'retargeted';
        } else if (direct) { out = direct.clip; how = `${direct.matched} of ${direct.total} bones matched`; }
        if (out && out.tracks.length) {
          added.push(model.addClip(out, { play: false, warnDropped: false }));
          added[added.length - 1].how = how;
        }
        continue;
      }
      // how many tracks bind directly?
      const direct = clipWithUuids(clip, model.root);
      const ratio = clip.tracks.length ? direct.tracks.length / clip.tracks.length : 0;
      let out = null, how = '';
      const sameRest = srcRig && model.humanoid && Math.abs(srcRig.hipHeight / srcRig.height - model.humanoid.hipHeight / model.humanoid.height) < 0.08;
      if (srcRig && model.humanoid && (ratio < 0.6 || !sameRest)) {
        out = retargetClip(srcRig, clip, model.humanoid, { name: clip.name });
        how = 'retargeted';
      } else if (ratio > 0) {
        out = direct;
        out.name = clip.name;
        how = ratio < 0.99 ? `${Math.round(ratio * 100)}% of tracks matched` : 'matched';
      }
      if (out && out.tracks.length) {
        added.push(model.addClip(out, { play: false, warnDropped: false }));
        added[added.length - 1].how = how;
      }
    }
    if (added.length) {
      for (const e of model.clips) if (e.playing && !added.includes(e)) model.setPlaying(e, false);
      model.setPlaying(added[0], true);
      model.setActiveClip(added[0]);
      this.setTime(0);
    }
    return added;
  }

  retargetFrom(srcModel, srcEntry, dstModel, { mirror = false } = {}) {
    const srcRig = srcModel.humanoid, dstRig = dstModel.humanoid;
    if (srcRig && dstRig) {
      const clip = retargetClip(srcRig, srcEntry.clip, dstRig, { name: srcEntry.clip.name + (mirror ? ' (mirrored)' : ''), mirror });
      return this.addClipToModel(dstModel, clip);
    }
    // same skeleton names
    const direct = clipWithUuids(srcEntry.clip, dstModel.root);
    if (!direct.tracks.length) { this.toast('These two models have different skeletons, and at least one isn\'t a recognized humanoid, so the clip can\'t be transferred.', 'warn', 5000); return null; }
    direct.name = srcEntry.clip.name;
    return this.addClipToModel(dstModel, direct);
  }

  mirrorClip(model, entry) {
    if (!model.humanoid) { this.toast('Mirroring needs a humanoid rig', 'warn'); return; }
    // evaluate on the model itself; temporarily stop its mixer
    const playing = model.clips.filter((e) => e.playing);
    playing.forEach((e) => e.action.stop());
    const clip = retargetClip(model.humanoid, entry.clip, model.humanoid, { name: entry.clip.name + ' (mirrored)', mirror: true });
    playing.forEach((e) => e.action.play());
    return this.addClipToModel(model, clip);
  }

  // ------------------------------------------------------------ transport
  duration() {
    const m = this.selection.model;
    if (m && m.activeClip) return m.activeClip.clip.duration / Math.max(0.01, Math.abs(m.activeClip.speed)) || 1;
    let d = 0;
    for (const mm of this.models) d = Math.max(d, mm.maxDuration());
    return d || 2;
  }

  setTime(t, { emit = true } = {}) {
    this.transport.time = Math.max(0, t);
    this.needsEval = true;
    this.viewport.requestRender();
    if (emit) this.emit('time', this.transport.time);
  }

  play() {
    if (this.transport.playing) return;
    if (this.transport.time >= this.duration() - 1e-4) this.transport.time = 0;
    this.transport.playing = true;
    this.emit('play', true);
    this.viewport.requestRender();
  }
  pause() {
    if (!this.transport.playing) return;
    this.transport.playing = false;
    this.transport.time = this.snap(this.transport.time);
    this.needsEval = true;
    this.emit('play', false);
    this.emit('time', this.transport.time);
    this.viewport.requestRender();
  }
  togglePlay() { this.transport.playing ? this.pause() : this.play(); }
  stop() { this.pause(); this.setTime(0); }
  stepFrame(n) {
    this.pause();
    const fps = this.settings.get('fps');
    this.setTime(clamp(Math.round(this.transport.time * fps + n) / fps, 0, this.duration()));
  }

  tick(dt) {
    const tr = this.transport;
    if (tr.playing) {
      tr.time += dt;
      const d = this.duration();
      if (tr.time > d) {
        if (tr.loop) tr.time = d > 0 ? tr.time % d : 0;
        else { tr.time = d; this.pause(); }
      }
      this.needsEval = true;
      this._timeEmitAcc = (this._timeEmitAcc || 0) + dt;
      if (this._timeEmitAcc > 1 / 30) { this._timeEmitAcc = 0; this.emit('time', tr.time); }
    }
    if (this.needsEval && !this._drag) {
      for (const m of this.models) m.evaluate(tr.time);
      this.needsEval = false;
      if (this.ikActive && this.selection.object) this.selection.object.getWorldPosition(this.ikTarget.position);
      this.emit('evaluated');
    }
    this.world.updateMatrixWorld(true);
    // bone constraints (control bones driving deform bones, IK legs...)
    for (const m of this.models) if (m.constraints && m.root.visible && m.solveConstraints()) m.root.updateMatrixWorld(true);
    for (const m of this.models) m.updateHelpers();
    for (const [m, h] of this.cameraHelpers) if (h.visible) { m.root.updateProjectionMatrix?.(); this.updateCameraHelper(m, h); }
    if (this.selBox.visible && (tr.playing || this._drag)) this.updateSelBox();
  }

  lookThrough(model) {
    const vp = this.viewport;
    if (!model || vp.activeCamera === model.root) {
      vp.activeCamera = vp.camera;
      vp.gizmo.camera = vp.camera;
    } else {
      vp.activeCamera = model.root;
      model.root.aspect = vp.camera.aspect;
      model.root.updateProjectionMatrix();
    }
    for (const [, h] of this.cameraHelpers) h.visible = vp.activeCamera === vp.camera;
    this.emit('camera');
    vp.resize();
  }

  // ------------------------------------------------------------ settings
  setQuality(q, auto = false) {
    if (!QUALITY_PRESETS[q]) return;
    const prev = QUALITY_LEVELS.indexOf(this.settings.get('quality'));
    this.settings.set('quality', q);
    const preset = QUALITY_PRESETS[q];
    this.viewport.applyQuality(preset);
    if (QUALITY_LEVELS.indexOf(q) < prev) {
      const max = this.settings.maxTexture();
      for (const m of this.models) optimizeTextures(m.root, max, this.viewport.renderer.capabilities.maxTextureSize).then(() => this.viewport.requestRender());
    }
    this.emit('quality', q, auto);
  }

  setSetting(k, v) {
    this.settings.set(k, v);
    if (k === 'showGrid') { this.viewport.grid.visible = v; this.viewport.axes.visible = v && this.settings.get('showAxes'); }
    if (k === 'showAxes') this.viewport.axes.visible = v && this.settings.get('showGrid');
    if (k === 'showSkeleton') for (const m of this.models) if (m.joints) m.joints.visible = v && m.root.visible;
    if (k === 'showAllBones') { for (const m of this.models) m.buildJoints(); this.select(this.selection.object, this.selection.model); }
    if (k === 'bgColor') this.viewport.renderer.setClearColor(new THREE.Color(v), 1);
    if (k === 'ikChain') this.select(this.selection.object, this.selection.model);
    if (k === 'showEffects') this.needsEval = true;
    this.emit('settings', k, v);
    this.viewport.requestRender();
  }

  // ------------------------------------------------------------ importing
  // models in a row (wrapping into a grid), each standing on the floor
  lineUp(models) {
    const boxes = models.map((m) => { m.root.updateMatrixWorld(true); return new THREE.Box3().setFromObject(m.root); });
    const sizes = boxes.map((b) => (b.isEmpty() ? new THREE.Vector3(1, 1, 1) : b.getSize(new THREE.Vector3())));
    const gap = Math.max(0.1, Math.min(...sizes.map((s) => Math.max(s.x, s.z))) * 0.3);
    const perRow = Math.ceil(Math.sqrt(models.length * 1.5));
    let x = 0, z = 0, rowDepth = 0, i = 0;
    const rowW = sizes.slice(0, perRow).reduce((a, s) => a + s.x + gap, -gap);
    models.forEach((m, k) => {
      const b = boxes[k], s = sizes[k];
      if (i === perRow) { i = 0; x = 0; z -= rowDepth + gap; rowDepth = 0; }
      const c = b.isEmpty() ? new THREE.Vector3() : b.getCenter(new THREE.Vector3());
      m.root.position.x += x + s.x / 2 - c.x - rowW / 2;
      m.root.position.z += z - c.z;
      if (!b.isEmpty()) m.root.position.y -= b.min.y;
      m.root.updateMatrixWorld(true);
      m.captureRest?.();
      x += s.x + gap; rowDepth = Math.max(rowDepth, s.z); i++;
    });
  }

  async importFiles(files) {
    if (!files.length) return;
    let t = this.toast('Reading files…', 'busy', 0);
    const status = (msg) => t?.update?.(msg);
    let vfs;
    try {
      vfs = await this.importer.buildVFS(files, status);
    } catch (e) {
      t?.close?.();
      this.toast(e.message, 'error', 6000);
      return;
    }
    let { primaries, images, unsupported, skipped = [] } = this.importer.pickPrimaries(vfs);
    // an archive full of models (a mod .jar, an asset pack) or a huge drop: let the user pick
    if (this.chooseModels && (primaries.length > 12 || (primaries.length > 4 && vfs.archives?.length))) {
      t?.close?.();
      const picked = await this.chooseModels(primaries, vfs.archives || []);
      if (!picked || !picked.length) { vfs.revokeAll(); return; }
      primaries = picked;
      t = this.toast('Loading models…', 'busy', 0);
    }
    const report = [];
    for (const u of unsupported) report.push(unsupportedMessage(u.ext));
    const loaded = [];
    const animOnly = [];
    const infoNotes = [];
    for (const x of skipped) infoNotes.push(`skipped ${x.entry.name} (same model as ${x.kept.name})`);
    let added = 0;
    for (const entry of primaries) {
      status(`Loading ${entry.name}…`);
      await new Promise((r) => setTimeout(r, 16));
      try {
        const res = await this.importer.load(entry, vfs);
        if (entry.optional && !res.root && !(res.animations || []).length) continue;
        for (const w of res.warnings) report.push(`${entry.name}: ${w}`);
        for (const n of res.notes || []) infoNotes.push(`${entry.name} ${n}`);
        if (res.animationOnly) animOnly.push({ entry, res });
        else if (res.root) loaded.push({ entry, res });
      } catch (e) {
        if (entry.optional) continue;
        console.error(e);
        report.push(`${entry.name}: ${friendlyError(e)}`);
      }
    }
    // models
    const newModels = [];
    for (const { entry, res } of loaded) {
      // a scene saved by WebBlend: restore each model separately
      let saved = null;
      res.root.traverse((o) => { if (!saved && o.userData && o.userData.webblend) saved = o; });
      if (saved && saved.userData.webblend.models) {
        const meta = saved.userData.webblend.models;
        const kids = [...saved.children];
        kids.forEach((child, i) => {
          const info = meta[i] || { name: child.name, clips: [] };
          const prefix = info.name + ' | ';
          const clips = res.animations.filter((c) => c.name.startsWith(prefix)).map((c) => { c.name = c.name.slice(prefix.length); return c; });
          saved.remove(child);
          const m = this.addModel(child, { name: info.name || child.name, kind: info.kind === 'character' ? 'character' : info.kind || 'import', source: entry.name, format: res.format, animations: clips, select: false });
          (info.clips || []).forEach((ci, j) => {
            const e = m.clips.find((x) => x.clip.name === ci.name) || m.clips[j];
            if (!e) return;
            m.setWeight(e, ci.weight ?? 1); m.setSpeed(e, ci.speed ?? 1); m.setLoop(e, ci.loop || 'repeat'); m.setPlaying(e, ci.playing !== false);
          });
          newModels.push(m);
          added++;
        });
        continue;
      }
      const name = res.root.name && res.root.name !== 'Scene' && !/^(root|group|Scene_Root|RootNode|Blend|AuxScene|Sketchfab_Scene|Sketchfab_model|OSG_Scene|model|object)$/i.test(res.root.name) ? res.root.name : stripExt(entry.name);
      res.root.name = name;
      const m = this.addModel(res.root, { name, kind: res.kind === 'skeleton' ? 'skeleton' : 'import', source: entry.name, format: res.format, animations: res.animations, select: false });
      newModels.push(m);
      added++;
    }
    // animation-only files: apply to a fitting model
    for (const { entry, res } of animOnly) {
      const target = this.pickAnimTarget(newModels);
      if (!target) {
        if (res.root) {
          const m = this.addModel(res.root, { name: stripExt(entry.name), kind: 'skeleton', source: entry.name, format: res.format, animations: res.animations, select: false });
          newModels.push(m);
          added++;
        } else report.push(`${entry.name}: animation file — select a model first, then drop it again`);
        continue;
      }
      const clips = this.applyAnimations(target, res.animations, res.root);
      if (clips.length) infoNotes.push(`${entry.name}: added ${clips.length} animation${clips.length > 1 ? 's' : ''} to "${target.name}" (${clips.map((c) => c.how).filter(Boolean)[0] || 'ok'})`);
      else report.push(`${entry.name}: its animation doesn't match "${target.name}"'s skeleton`);
      if (res.root) disposeObject(res.root);
    }
    // image-only drops become textured planes
    if (!primaries.length && images.length) {
      for (const img of images.slice(0, 12)) {
        try { newModels.push(this.addModel(await this.importer.imagePlane(img), { name: stripExt(img.name), kind: 'image', select: false })); added++; } catch (e) { report.push(`${img.name}: ${friendlyError(e)}`); }
      }
    }
    vfs.revokeAll();
    t?.close?.();
    // several models at once: stand them side by side instead of inside each other
    if (newModels.length > 1 && newModels.length <= 200 && !loaded.some(({ res }) => { let w = false; res.root.traverse((o) => { if (o.userData && o.userData.webblend) w = true; }); return w; })) this.lineUp(newModels);
    if (newModels.length) {
      this.select(newModels[0].root, newModels[0]);
      this.viewport.frameAll();
    }
    for (const m of newModels) for (const n of m.importNotes || []) infoNotes.push(`${m.name}: ${n}`);
    if (!primaries.length && !images.length && !unsupported.length) report.push('No 3D models found in what you dropped.');
    const errors = report.filter(Boolean);
    if (added || infoNotes.length) this.toast((added ? `Imported ${added} item${added > 1 ? 's' : ''}. ` : '') + infoNotes.slice(0, 3).join('. ') + (infoNotes.length > 3 ? '…' : ''), 'ok', infoNotes.length ? 9000 : 4500);
    if (errors.length) this.emit('report', errors);
    this.emit('models');
  }

  pickAnimTarget(fresh) {
    const sel = this.selection.model;
    if (sel && sel.bones.length) return sel;
    const withBones = [...fresh, ...this.models].filter((m) => m.bones.length && m.kind !== 'skeleton');
    return withBones[0] || null;
  }
}

function snapTransform(o) { return { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }; }
function applyTransform(o, t) { o.position.copy(t.p); o.quaternion.copy(t.q); o.scale.copy(t.s); o.updateMatrixWorld(true); }

export function friendlyError(e) {
  const m = (e && e.message) || String(e);
  if (/Unexpected token|JSON/.test(m)) return 'the file looks damaged or isn\'t the format its extension says';
  if (/out of memory|Array buffer allocation|allocation failed/i.test(m)) return 'not enough memory to open this file. Try Potato mode in Settings, close other tabs, or use a smaller file';
  if (/Draco/i.test(m)) return 'this file uses Draco compression and the decoder failed: ' + m;
  if (/KTX2|basis/i.test(m)) return 'this file uses KTX2 textures, which need an internet connection to decode';
  if (/fbx version/i.test(m)) return 'this FBX version isn\'t supported (re-export as FBX 2014/2018 binary, or glTF)';
  return m;
}
