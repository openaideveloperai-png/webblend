// Clickable skeleton display for a model: one instanced octahedron per bone
// plus line segments from each bone to its parent. Drawn on top of meshes.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _pp = new THREE.Vector3();
const _inv = new THREE.Matrix4();

const COLOR_IDLE = new THREE.Color(0x9fb4d0);
const COLOR_SEL = new THREE.Color(0xffb84a);
const COLOR_CHAIN = new THREE.Color(0x4aa8ff);

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
    for (let i = 0; i < bones.length; i++) this.points.setColorAt(i, COLOR_IDLE);
    const lineGeo = new THREE.BufferGeometry();
    this.linePos = new Float32Array(bones.length * 6);
    lineGeo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    const lineMat = new THREE.LineBasicMaterial({ color: 0x7f93ad, depthTest: false, depthWrite: false, transparent: true, opacity: 0.75 });
    this.lines = new THREE.LineSegments(lineGeo, lineMat);
    this.lines.renderOrder = 998;
    this.lines.frustumCulled = false;
    this.lines.userData.helper = true;
    this.add(this.lines, this.points);
    this.boneIndex = new Map(bones.map((b, i) => [b, i]));
    this.selected = -1;
    this.chain = [];
    this.matrixAutoUpdate = false;
  }

  setSize(s) { this.size = s; }

  // Positions are written in world space; the helper lives at the scene root.
  update() {
    const { bones, size } = this;
    const pm = this.points;
    for (let i = 0; i < bones.length; i++) {
      const b = bones[i];
      b.matrixWorld.decompose(_p, _q, _s);
      const sel = i === this.selected;
      const k = sel ? 1.6 : 1;
      _m.compose(_p, _q, _s.set(size * k, size * k, size * k));
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

  highlight(bone, chain = []) {
    const pm = this.points;
    for (let i = 0; i < this.bones.length; i++) pm.setColorAt(i, COLOR_IDLE);
    this.selected = bone ? this.boneIndex.get(bone) ?? -1 : -1;
    for (const c of chain) { const i = this.boneIndex.get(c); if (i !== undefined) pm.setColorAt(i, COLOR_CHAIN); }
    if (this.selected >= 0) pm.setColorAt(this.selected, COLOR_SEL);
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
