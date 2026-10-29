// Clickable skeleton display for a model: one instanced octahedron per bone
// plus line segments from each bone to its parent. Drawn on top of meshes.
import * as THREE from 'three';
import { BONE_PART_COLORS } from './settings.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _inv = new THREE.Matrix4();

const _cam = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _d = new THREE.Vector3();
// dot radius in pixels: [largest, smallest]
const JOINT_PX = { small: [3.5, 1.6], medium: [5, 2.2], large: [7.5, 3] };
export function defaultJointSize() {
  return typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches ? 'large' : 'medium';
}

// which body part a bone belongs to (for coloring the dots): its own humanoid
// role, else the nearest ancestor's, else a guess from its name
const HAIR = /(hair|ahoge|bang|ponytail|braid|髪|前髪|後髪|アホ毛)/;
const EXTRA = /(tail|skirt|cloth|cape|ribbon|coat|sleeve|scarf|breast|bust|boob|chest_?(l|r)$|尻尾|しっぽ|スカート|リボン|乳|袖|マント)/;
const FACE = /(eye|jaw|lip|mouth|tongue|teeth|tooth|brow|cheek|nose|ear|chin|lid|mouth|目|顎|口|舌|歯|眉|頬|鼻|耳|唇|瞼)/;
const CANON_PART = {
  head: 'head', neck: 'head', hips: 'torso', spine: 'torso', chest: 'torso', upperChest: 'torso',
  leftShoulder: 'arms', rightShoulder: 'arms', leftUpperArm: 'arms', rightUpperArm: 'arms', leftLowerArm: 'arms', rightLowerArm: 'arms',
  leftHand: 'hands', rightHand: 'hands', leftUpperLeg: 'legs', rightUpperLeg: 'legs', leftLowerLeg: 'legs', rightLowerLeg: 'legs',
  leftFoot: 'feet', rightFoot: 'feet', leftToes: 'feet', rightToes: 'feet',
};
const NAME_PART = [
  [/(finger|thumb|index|middle|ring|pinky|little|hand|wrist|palm|指|手首)/, 'hands'],
  [/(toe|foot|ankle|heel|足首|つま先)/, 'feet'],
  [/(shoulder|arm|elbow|clavicle|肩|腕|ひじ|肘)/, 'arms'],
  [/(thigh|leg|knee|calf|shin|ひざ|膝|足)/, 'legs'],
  [/(head|neck|頭|首)/, 'head'],
  [/(hip|pelvis|spine|chest|torso|waist|belly|abdomen|上半身|下半身|腰)/, 'torso'],
];
export function bonePart(bone, canonOf) {
  const n = (bone.name || '').toLowerCase();
  if (HAIR.test(n)) return 'hair';
  const own = canonOf && canonOf.get(bone);
  if (own) return CANON_PART[own] || 'other';
  if (EXTRA.test(n)) return 'extras';
  for (let p = bone.parent; p && p.isBone; p = p.parent) {
    const c = canonOf && canonOf.get(p);
    if (!c) continue;
    if (c === 'head') return 'face';
    if (c === 'neck') return FACE.test(n) ? 'face' : 'head';
    return CANON_PART[c] || 'other';
  }
  if (FACE.test(n)) return 'face';
  for (const [re, part] of NAME_PART) if (re.test(n)) return part;
  return 'other';
}

// the dot colors from the settings
export function boneColors(settings) {
  const g = (k, d) => { const v = settings && settings.get(k); return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : d; };
  return {
    idle: new THREE.Color(g('boneColor', '#9fb4d0')),
    sel: new THREE.Color(g('boneSelColor', '#ffb84a')),
    chain: new THREE.Color(g('boneChainColor', '#4aa8ff')),
    multi: new THREE.Color(g('boneMultiColor', '#ff6ad5')),
    line: new THREE.Color(g('boneLineColor', '#7f93ad')),
    byPart: !!(settings && settings.get('boneColorByPart')),
    parts: Object.fromEntries(Object.entries({ ...BONE_PART_COLORS, ...((settings && settings.get('bonePartColors')) || {}) }).map(([k, v]) => [k, new THREE.Color(v)])),
  };
}

export class JointHelper extends THREE.Group {
  constructor(model, bones, size) {
    super();
    this.name = 'joints';
    this.userData.helper = true;
    this.model = model;
    this.bones = bones;
    this.size = size;
    const geo = new THREE.OctahedronGeometry(1, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, transparent: true, opacity: 0.9 });
    this.points = new THREE.InstancedMesh(geo, mat, Math.max(1, bones.length));
    this.points.count = bones.length;
    this.points.renderOrder = 999;
    this.points.frustumCulled = false;
    this.points.userData.helper = true;
    this.points.userData.jointHelper = this;
    for (let i = 0; i < bones.length; i++) this.points.setColorAt(i, new THREE.Color(0x9fb4d0));
    const lineGeo = new THREE.BufferGeometry();
    this.linePos = new Float32Array(bones.length * 6);
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lineCol = new Float32Array(bones.length * 6);
    lineGeo.setAttribute('color', new THREE.BufferAttribute(this.lineCol, 3));
    const lineMat = new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true, opacity: 0.75 });
    this.lines = new THREE.LineSegments(lineGeo, lineMat);
    this.lines.renderOrder = 998;
    this.lines.frustumCulled = false;
    this.lines.userData.helper = true;
    this.add(this.lines, this.points);
    this.boneIndex = new Map(bones.map((b, i) => [b, i]));
    this.selected = -1;
    this.chain = [];
    this.extra = [];
    this.matrixAutoUpdate = false;
    this.recolor();
  }

  // dot and line colors from the settings (one color, or one per body part)
  recolor() {
    const settings = this.model.app && this.model.app.settings;
    const c = (this.colors = boneColors(settings));
    let canonOf = null;
    // (the rig is only looked up once the model is in the scene)
    const added = this.model.app && this.model.app.models && this.model.app.models.includes(this.model);
    if (c.byPart && added) { try { canonOf = this.model.humanoid ? this.model.humanoid.canonOf : null; } catch (e) { canonOf = null; } }
    this.parts = c.byPart ? this.bones.map((b) => bonePart(b, canonOf)) : null;
    this.base = this.bones.map((b, i) => (this.parts ? c.parts[this.parts[i]] || c.idle : c.idle));
    const dim = new THREE.Color();
    for (let i = 0; i < this.bones.length; i++) {
      const col = this.parts ? dim.copy(this.base[i]).multiplyScalar(0.8) : c.line;
      this.lineCol.set([col.r, col.g, col.b, col.r, col.g, col.b], i * 6);
    }
    this.lines.geometry.attributes.color.needsUpdate = true;
    this.highlight(this.selectedBone || null, this.chain, this.extra);
  }

  setSize(s) { this.size = s; }

  // Positions are written in world space; the helper lives at the scene root.
  // Dots keep a small on-screen size: close up they don't swell into each
  // other, far away they shrink with the model so they don't pile up.
  update() {
    const { bones, size } = this;
    const pm = this.points;
    const vp = this.model.app.viewport;
    const cam = vp && vp.activeCamera;
    const h = (vp && vp.renderer.domElement.clientHeight) || 600;
    const [maxPx, minPx] = JOINT_PX[this.model.app.settings.get('jointSize')] || JOINT_PX[defaultJointSize()];
    let persp = 0, ortho = 0;
    if (cam && cam.isPerspectiveCamera) {
      cam.getWorldPosition(_cam);
      cam.getWorldDirection(_fwd);
      persp = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / (h * (cam.zoom || 1));
    } else if (cam && cam.isOrthographicCamera) {
      ortho = (cam.top - cam.bottom) / (cam.zoom || 1) / h;
    }
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      b.matrixWorld.decompose(_p, _q, _s);
      const sel = i === this.selected;
      const k = sel ? 1.6 : this.extraSet && this.extraSet.has(i) ? 1.35 : 1;
      let r = size;
      const upp = persp ? Math.max(1e-6, _d.copy(_p).sub(_cam).dot(_fwd)) * persp : ortho; // world units per pixel here
      if (upp) r = THREE.MathUtils.clamp(size, minPx * upp, maxPx * upp);
      r *= k;
      _m.compose(_p, _q, _s.set(r, r, r));
      pm.setMatrixAt(i, _m);
      const parent = b.parent && b.parent.isBone ? b.parent : null;
      if (parent) {
        _pp.setFromMatrixPosition(parent.matrixWorld);
        this.linePos.set([_pp.x, _pp.y, _pp.z, _p.x, _p.y, _p.z], i * 6);
      } else {
        this.linePos.set([_p.x, _p.y, _p.z, _p.x, _p.y, _p.z], i * 6);
      }
    }
    pm.instanceMatrix.needsUpdate = true;
    this.lines.geometry.attributes.position.needsUpdate = true;
  }

  // the selected bone, its IK chain, and any extra selected bones (Shift+click)
  highlight(bone, chain = [], extra = []) {
    const pm = this.points;
    const c = this.colors;
    for (let i = 0; i < this.bones.length; i++) pm.setColorAt(i, this.base[i]);
    this.selectedBone = bone || null;
    this.chain = chain || [];
    this.extra = extra || [];
    this.selected = bone ? this.boneIndex.get(bone) ?? -1 : -1;
    for (const b of this.chain) { const i = this.boneIndex.get(b); if (i !== undefined) pm.setColorAt(i, c.chain); }
    this.extraSet = new Set();
    for (const b of this.extra) { const i = this.boneIndex.get(b); if (i !== undefined) { pm.setColorAt(i, c.multi); this.extraSet.add(i); } }
    if (this.selected >= 0) pm.setColorAt(this.selected, c.sel);
    if (pm.instanceColor) pm.instanceColor.needsUpdate = true;
  }

  dispose() {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.points.dispose?.();
    this.lines.geometry.dispose();
    this.lines.material.dispose();
  }
}

export { _inv };
