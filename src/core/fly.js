// Fly mode: move the viewport camera like in a game.
// WASD move, E / Space up, Q / C down, right-drag (or one-finger
// drag on touch) looks around, Shift = faster, Alt = slower, scroll = speed.
// Left click still selects bones and the gizmo still works, so you can fly
// in close and keep posing.
import * as THREE from 'three';

const MOVE_KEYS = {
  KeyW: [0, 0, -1], KeyS: [0, 0, 1], KeyA: [-1, 0, 0], KeyD: [1, 0, 0],
  KeyE: [0, 1, 0], Space: [0, 1, 0], KeyQ: [0, -1, 0], KeyC: [0, -1, 0],
};
export const FLY_KEYS = new Set([...Object.keys(MOVE_KEYS), 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight']);

const _e = new THREE.Euler(0, 0, 0, 'YXZ');
const _v = new THREE.Vector3();
const _f = new THREE.Vector3();

export class FlyMode {
  constructor(viewport) {
    this.vp = viewport;
    this.on = false;
    this.keys = new Set();
    this.look = null;
    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onBlur = () => this.keys.clear();
    this.onPointerDown = this.onPointerDown.bind(this);
    this.onPointerMove = this.onPointerMove.bind(this);
    this.onPointerUp = this.onPointerUp.bind(this);
    this.onWheel = this.onWheel.bind(this);
  }

  get app() { return this.vp.app; }
  get speedMul() { return this.app.settings.get('flySpeed') || 1; }

  toggle() { if (this.on) this.disable(); else this.enable(); }

  enable() {
    if (this.on) return;
    const vp = this.vp;
    if (vp.activeCamera !== vp.camera) this.app.lookThrough(null);
    this.on = true;
    this.keys.clear();
    vp.orbit.enabled = false;
    this.orbitDist = Math.max(vp.camera.position.distanceTo(vp.orbit.target), 1e-3);
    // walking speed relative to what's in the scene (a 1.8 m character -> ~1.4 m/s)
    const box = new THREE.Box3();
    for (const m of this.app.models) if (m.root.visible) box.expandByObject(m.root);
    const size = box.isEmpty() ? 2 : box.getSize(_v).length();
    this.baseSpeed = THREE.MathUtils.clamp(size * 0.45, 0.05, 5000);
    vp.camera.near = Math.max(0.0005, Math.min(vp.camera.near, this.baseSpeed * 0.002));
    vp.camera.updateProjectionMatrix();
    window.addEventListener('keydown', this.onKeyDown, true);
    window.addEventListener('keyup', this.onKeyUp, true);
    window.addEventListener('blur', this.onBlur);
    const dom = vp.renderer.domElement;
    dom.addEventListener('pointerdown', this.onPointerDown, true);
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    dom.addEventListener('wheel', this.onWheel, { passive: false });
    this.app.emit('fly', true);
    vp.requestRender();
  }

  disable() {
    if (!this.on) return;
    const vp = this.vp;
    this.on = false;
    this.keys.clear();
    this.look = null;
    window.removeEventListener('keydown', this.onKeyDown, true);
    window.removeEventListener('keyup', this.onKeyUp, true);
    window.removeEventListener('blur', this.onBlur);
    const dom = vp.renderer.domElement;
    dom.removeEventListener('pointerdown', this.onPointerDown, true);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    dom.removeEventListener('wheel', this.onWheel);
    // orbit around a point in front of the camera from here on
    vp.camera.getWorldDirection(_f);
    const d = Math.min(this.orbitDist || 2, this.baseSpeed * 3 || 2);
    vp.orbit.target.copy(vp.camera.position).addScaledVector(_f, d);
    vp.orbit.enabled = true;
    vp.orbit.update();
    this.app.emit('fly', false);
    vp.requestRender();
  }

  // ---------------------------------------------------------------- input
  typing(e) {
    const t = e.target;
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) || !!document.querySelector('.modal-back');
  }

  onKeyDown(e) {
    if (this.typing(e) || e.ctrlKey || e.metaKey) return;
    if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); this.disable(); return; }
    if (!FLY_KEYS.has(e.code)) return;
    // these keys belong to fly mode now (not gizmo / timeline shortcuts)
    e.preventDefault();
    e.stopPropagation();
    this.keys.add(e.code);
    this.vp.requestRender();
  }

  onKeyUp(e) {
    if (!FLY_KEYS.has(e.code)) return;
    this.keys.delete(e.code);
    if (e.code.startsWith('Alt')) e.preventDefault(); // don't focus the browser menu
  }

  // hold a direction from an on-screen button (touch)
  press(code, down) {
    if (down) this.keys.add(code); else this.keys.delete(code);
    this.vp.requestRender();
  }

  onPointerDown(e) {
    // right / middle drag look around; on touch, a one-finger drag does
    const touch = e.pointerType === 'touch' || e.pointerType === 'pen';
    if (e.button === 1 || e.button === 2 || touch) {
      this.look = { id: e.pointerId, x: e.clientX, y: e.clientY, touch, moved: 0 };
      if (!touch) e.preventDefault();
    }
  }

  onPointerMove(e) {
    const l = this.look;
    if (!l || e.pointerId !== l.id) return;
    const dx = e.clientX - l.x, dy = e.clientY - l.y;
    l.x = e.clientX; l.y = e.clientY;
    l.moved += Math.abs(dx) + Math.abs(dy);
    // on touch, wait a little so taps still select
    if (l.touch && l.moved < 6) return;
    if (l.touch && this.vp.gizmo && this.vp.gizmo.dragging) return;
    const k = l.touch ? 0.006 : 0.0045;
    const cam = this.vp.camera;
    _e.setFromQuaternion(cam.quaternion, 'YXZ');
    _e.y -= dx * k;
    _e.x = THREE.MathUtils.clamp(_e.x - dy * k, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
    _e.z = 0;
    cam.quaternion.setFromEuler(_e);
    this.vp.requestRender();
  }

  onPointerUp(e) {
    if (this.look && e.pointerId === this.look.id) this.look = null;
  }

  onWheel(e) {
    e.preventDefault();
    e.stopPropagation();
    const f = e.deltaY > 0 ? 1 / 1.25 : 1.25;
    const v = THREE.MathUtils.clamp(this.speedMul * f, 0.05, 20);
    this.app.settings.set('flySpeed', v);
    this.app.emit('flyspeed', v);
  }

  // ---------------------------------------------------------------- per frame
  moving() {
    if (!this.on) return false;
    for (const k of this.keys) if (MOVE_KEYS[k]) return true;
    return false;
  }

  update(dt) {
    if (!this.moving()) return false;
    const dir = _v.set(0, 0, 0);
    for (const k of this.keys) { const m = MOVE_KEYS[k]; if (m) dir.x += m[0], dir.y += m[1], dir.z += m[2]; }
    if (dir.lengthSq() === 0) return false;
    const cam = this.vp.camera;
    let speed = this.baseSpeed * this.speedMul;
    if (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')) speed *= 3;
    if (this.keys.has('AltLeft') || this.keys.has('AltRight')) speed *= 0.3;
    // forward/back follow where you look; up/down are straight up and down
    const up = dir.y;
    dir.y = 0;
    if (dir.lengthSq()) dir.normalize().applyQuaternion(cam.quaternion);
    dir.y += up;
    if (dir.lengthSq() > 1) dir.normalize();
    cam.position.addScaledVector(dir, speed * dt);
    cam.updateMatrixWorld();
    return true;
  }
}
