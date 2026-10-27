// Renderer, camera, controls, lighting, picking and the render loop.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { PerfMonitor, QUALITY_LEVELS } from './settings.js';

const _v = new THREE.Vector3();
const _box = new THREE.Box3();

export class Viewport {
  constructor(app, container) {
    this.app = app;
    this.container = container;
    this.dirty = true;
    this.continuous = 0; // >0 forces rendering every frame (recording, drags)
    this.interacting = false;
    this.last = performance.now();
    this.scene = new THREE.Scene();
    this.scene.name = 'Scene';
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
    this.camera.position.set(4, 3, 6);
    this.activeCamera = this.camera;
    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    this.helpers = new THREE.Group();
    this.helpers.name = 'helpers';
    this.helpers.userData.helper = true;
    this.scene.add(this.helpers);

    this.createRenderer(app.settings.preset());
    this.setupLights();
    this.setupGrid();
    this.setupControls();

    this.perf = new PerfMonitor((fps) => this.onLag(fps));
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------ renderer
  createRenderer(preset) {
    const old = this.renderer;
    let renderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: !!preset.antialias,
        alpha: false,
        powerPreference: preset.renderScale < 1 ? 'low-power' : 'high-performance',
        preserveDrawingBuffer: false,
        stencil: false,
      });
    } catch (e) {
      this.app.fatal?.('WebGL is not available in this browser. Try updating your browser or enabling hardware acceleration.');
      throw e;
    }
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    renderer.toneMappingExposure = 1;
    renderer.shadowMap.enabled = !!preset.shadows;
    renderer.shadowMap.type = preset.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    renderer.setClearColor(new THREE.Color(this.app.settings.get('bgColor')), 1);
    renderer.domElement.className = 'viewport-canvas';
    renderer.domElement.tabIndex = 0;
    // only the live renderer's context matters (old ones are lost on purpose when rebuilt)
    renderer.domElement.addEventListener('webglcontextlost', (e) => {
      if (renderer !== this.renderer) return;
      e.preventDefault();
      this.contextLost = true;
      this.app.toast('The graphics card reset (often low memory). Recovering…', 'warn', 5000);
    });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
      if (renderer !== this.renderer) return;
      this.contextLost = false;
      this.requestRender();
      // step quality down to make another reset less likely
      const lvls = QUALITY_LEVELS, cur = lvls.indexOf(this.app.settings.get('quality'));
      if (cur > 0) setTimeout(() => this.app.setQuality(lvls[cur - 1], true), 50);
    });
    this.renderer = renderer;
    if (old) {
      this.container.replaceChild(renderer.domElement, old.domElement);
      old.dispose();
      try { old.forceContextLoss(); } catch { /* ignore */ }
    } else {
      this.container.prepend(renderer.domElement);
    }
    this.antialias = !!preset.antialias;
    if (this.orbit) { this.orbit.disconnect(); this.orbit.connect(renderer.domElement); }
    if (this.gizmo) { this.gizmo.disconnect(); this.gizmo.connect(renderer.domElement); }
    if (this.viewHelper) this.viewHelper.dispose?.();
    this.viewHelper = new ViewHelper(this.camera, renderer.domElement);
    this.viewHelper.setLabels?.('X', 'Y', 'Z');
    if (this.envTex) { this.envTex.dispose(); this.envTex = null; }
    this.bindCanvasEvents();
    this.resize();
  }

  applyQuality(preset) {
    if (preset.antialias !== this.antialias) this.createRenderer(preset);
    const r = this.renderer;
    r.shadowMap.enabled = !!preset.shadows;
    r.shadowMap.type = preset.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    this.key.castShadow = !!preset.shadows;
    if (this.key.shadow.mapSize.x !== preset.shadowSize) {
      this.key.shadow.mapSize.set(preset.shadowSize, preset.shadowSize);
      this.key.shadow.map?.dispose();
      this.key.shadow.map = null;
    }
    this.shadowCatcher.visible = !!preset.shadows;
    if (preset.env) {
      if (!this.envTex) {
        const pmrem = new THREE.PMREMGenerator(r);
        const room = new RoomEnvironment();
        this.envTex = pmrem.fromScene(room, 0.04).texture;
        room.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); });
        pmrem.dispose();
      }
      this.scene.environment = this.envTex;
      this.scene.environmentIntensity = 0.55;
      this.hemi.intensity = 0.5;
    } else {
      this.scene.environment = null;
      this.hemi.intensity = 1.6;
    }
    // make sure materials recompile for shadow changes
    this.scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.needsUpdate = true; }); });
    this.preset = preset;
    this.resize();
    this.requestRender();
  }

  onLag(fps) {
    const s = this.app.settings;
    if (!s.get('autoQuality')) return;
    const cur = QUALITY_LEVELS.indexOf(s.get('quality'));
    if (cur <= 0) return;
    // very slow: skip a level
    const next = QUALITY_LEVELS[Math.max(0, cur - (fps < 12 ? 2 : 1))];
    this.app.setQuality(next, true);
    this.app.toast(`Running slowly (${fps.toFixed(0)} fps), switched to ${next[0].toUpperCase() + next.slice(1)} mode. Change it in Settings.`, 'warn', 5000);
  }

  // ------------------------------------------------------------ scene setup
  setupLights() {
    this.hemi = new THREE.HemisphereLight(0xdfe8ff, 0x3a3226, 1.2);
    this.hemi.name = 'Sky light';
    this.hemi.userData.helper = true;
    this.key = new THREE.DirectionalLight(0xffffff, 2.2);
    this.key.name = 'Key light';
    this.key.position.set(5, 10, 6);
    this.key.userData.helper = true;
    this.key.shadow.bias = -0.0005;
    this.key.shadow.normalBias = 0.02;
    this.fill = new THREE.DirectionalLight(0xbcd2ff, 0.6);
    this.fill.position.set(-6, 4, -5);
    this.fill.userData.helper = true;
    this.scene.add(this.hemi, this.key, this.key.target, this.fill);
  }

  setupGrid() {
    this.grid = new THREE.GridHelper(20, 20, 0x5d6878, 0x3a424e);
    this.grid.userData.helper = true;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.8;
    this.grid.material.depthWrite = false;
    this.scene.add(this.grid);
    this.axes = new THREE.AxesHelper(1);
    this.axes.userData.helper = true;
    this.axes.material.depthTest = false;
    this.axes.renderOrder = 1;
    this.scene.add(this.axes);
    const sc = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.ShadowMaterial({ opacity: 0.28 }));
    sc.rotation.x = -Math.PI / 2;
    sc.receiveShadow = true;
    sc.userData.helper = true;
    sc.name = 'shadow catcher';
    this.shadowCatcher = sc;
    this.scene.add(sc);
    this.setWorldScale(10);
  }

  // Scale grid, camera clip planes and shadow frustum to the scene size.
  setWorldScale(size) {
    size = Math.max(size, 0.01);
    const step = Math.pow(10, Math.floor(Math.log10(size / 2)));
    const gridSize = Math.ceil((size * 2) / step) * step;
    const divisions = Math.min(200, Math.round(gridSize / step));
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid.material.dispose();
    this.grid = new THREE.GridHelper(gridSize, divisions, 0x5d6878, 0x363d48);
    this.grid.userData.helper = true;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.85;
    this.grid.material.depthWrite = false;
    this.grid.visible = this.app.settings.get('showGrid');
    this.scene.add(this.grid);
    this.axes.scale.setScalar(step);
    this.axes.visible = this.app.settings.get('showAxes') && this.app.settings.get('showGrid');
    this.shadowCatcher.scale.setScalar(gridSize * 2);
    this.camera.near = Math.max(size / 2000, 0.001);
    this.camera.far = size * 200;
    this.camera.updateProjectionMatrix();
    const cam = this.key.shadow.camera;
    const s = size * 0.9;
    cam.left = -s; cam.right = s; cam.top = s; cam.bottom = -s;
    cam.near = size * 0.01; cam.far = size * 6;
    cam.updateProjectionMatrix();
    this.key.position.set(size * 0.6, size * 1.2, size * 0.8);
    this.worldScale = size;
    this.requestRender();
  }

  setupControls() {
    const dom = this.renderer.domElement;
    this.orbit = new OrbitControls(this.camera, dom);
    this.orbit.enableDamping = false;
    this.orbit.screenSpacePanning = true;
    this.orbit.addEventListener('change', () => this.requestRender());
    this.orbit.addEventListener('start', () => { this.interacting = true; });
    this.orbit.addEventListener('end', () => { this.interacting = false; });

    this.gizmo = new TransformControls(this.camera, dom);
    this.gizmo.setSize(0.85);
    const gh = this.gizmo.getHelper();
    gh.userData.helper = true;
    this.scene.add(gh);
    this.gizmo.addEventListener('dragging-changed', (e) => {
      this.orbit.enabled = !e.value;
      this.interacting = e.value;
      this.app.emit(e.value ? 'gizmo:start' : 'gizmo:end');
    });
    this.gizmo.addEventListener('objectChange', () => { this.app.emit('gizmo:change'); this.requestRender(); });
    this.gizmo.addEventListener('change', () => this.requestRender());
  }

  bindCanvasEvents() {
    const dom = this.renderer.domElement;
    let down = null;
    dom.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now(), button: e.button };
      dom.focus({ preventScroll: true });
    });
    dom.addEventListener('pointerup', (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      const wasGizmo = this.gizmo && (this.gizmo.dragging || (this.gizmo.object && this.gizmo.axis));
      if (moved < 5 && down.button === 0 && !wasGizmo && !this.gizmoJustUsed) {
        if (this.viewHelper && this.handleViewHelperClick(e)) { down = null; return; }
        const hit = this.pick(e.clientX, e.clientY);
        this.app.selectFromViewport(hit, e.shiftKey);
      }
      this.gizmoJustUsed = false;
      down = null;
    });
    dom.addEventListener('dblclick', (e) => {
      const hit = this.pick(e.clientX, e.clientY);
      if (hit && hit.object) this.frameObject(hit.bone || hit.object);
    });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  handleViewHelperClick(e) {
    const vh = this.viewHelper;
    vh.center.copy(this.orbit.target);
    const handled = vh.handleClick(e);
    if (handled) { this.requestRender(); return true; }
    return false;
  }

  // ------------------------------------------------------------ picking
  ndc(clientX, clientY) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    return this.pointer;
  }

  pick(clientX, clientY) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    // 1) bone joints by screen distance
    if (this.app.settings.get('showSkeleton')) {
      let best = null, bestD = 14;
      for (const model of this.app.models) {
        if (!model.joints || !model.joints.visible || !model.root.visible) continue;
        for (const b of model.joints.bones) {
          _v.setFromMatrixPosition(b.matrixWorld).project(this.camera);
          if (_v.z > 1 || _v.z < -1) continue;
          const sx = (_v.x * 0.5 + 0.5) * rect.width + rect.left;
          const sy = (-_v.y * 0.5 + 0.5) * rect.height + rect.top;
          const d = Math.hypot(sx - clientX, sy - clientY);
          if (d < bestD) { bestD = d; best = { model, bone: b, object: b }; }
        }
      }
      if (best) return best;
    }
    // 2) meshes
    this.raycaster.setFromCamera(this.ndc(clientX, clientY), this.camera);
    const targets = [];
    for (const m of this.app.models) if (m.root.visible) targets.push(m.root);
    // skinned meshes: refresh bounds for the current pose
    for (const t of targets) t.traverse((o) => { if (o.isSkinnedMesh) { o.boundingSphere = null; o.boundingBox = null; } });
    const hits = this.raycaster.intersectObjects(targets, true).filter((h) => !isHelper(h.object) && h.object.visible && visibleChain(h.object));
    if (!hits.length) return null;
    const obj = hits[0].object;
    const model = this.app.modelOf(obj);
    return { model, object: obj, point: hits[0].point };
  }

  // ------------------------------------------------------------ camera
  frameObject(obj, instant = true) {
    if (!obj) return;
    _box.makeEmpty();
    if (obj.isBone) {
      const p = new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld);
      const model = this.app.modelOf(obj);
      const s = model ? model.size * 0.25 : 1;
      _box.setFromCenterAndSize(p, new THREE.Vector3(s, s, s));
    } else {
      obj.updateWorldMatrix(true, true);
      _box.setFromObject(obj, false);
      if (_box.isEmpty()) _box.setFromCenterAndSize(new THREE.Vector3().setFromMatrixPosition(obj.matrixWorld), new THREE.Vector3(1, 1, 1));
    }
    this.frameBox(_box, instant);
  }

  frameBox(box, instant = true) {
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const radius = Math.max(size.length() * 0.5, 0.01);
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = radius / Math.sin(fov / 2) * 1.05;
    const dir = this.camera.position.clone().sub(this.orbit.target).normalize();
    if (dir.lengthSq() < 0.5) dir.set(0.5, 0.35, 0.8).normalize();
    this.orbit.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 0.001);
    this.camera.far = Math.max(dist * 100, this.worldScale * 50);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
    this.requestRender();
  }

  frameAll() {
    _box.makeEmpty();
    for (const m of this.app.models) if (m.root.visible) _box.expandByObject(m.root);
    if (_box.isEmpty()) _box.setFromCenterAndSize(new THREE.Vector3(0, 1, 0), new THREE.Vector3(4, 2, 4));
    this.frameBox(_box);
  }

  setView(name) {
    const t = this.orbit.target;
    const d = this.camera.position.distanceTo(t);
    const dirs = { front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0.0001], bottom: [0, -1, 0.0001], persp: [0.6, 0.45, 0.8] };
    const v = new THREE.Vector3(...(dirs[name] || dirs.persp)).normalize();
    this.camera.position.copy(t).addScaledVector(v, d);
    this.camera.lookAt(t);
    this.orbit.update();
    this.requestRender();
  }

  // ------------------------------------------------------------ loop
  requestRender() { this.dirty = true; }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const preset = this.preset || this.app.settings.preset();
    const pr = Math.min(window.devicePixelRatio || 1, preset.maxPixelRatio) * preset.renderScale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.activeCamera !== this.camera && this.activeCamera.isPerspectiveCamera) {
      this.activeCamera.aspect = w / h;
      this.activeCamera.updateProjectionMatrix();
    }
    this.requestRender();
  }

  loop(now) {
    requestAnimationFrame(this.loop);
    if (this.contextLost) return;
    const preset = this.preset || this.app.settings.preset();
    const cap = preset.fpsCap;
    const elapsed = now - this.last;
    if (cap && elapsed < 1000 / cap - 2) return;
    const playing = this.app.transport.playing;
    const animatingHelper = this.viewHelper && this.viewHelper.animating;
    const active = playing || this.dirty || this.continuous > 0 || animatingHelper;
    this.last = now;
    if (!active) { this.perf.frame(now, elapsed, false); return; }
    const dt = Math.min(elapsed / 1000, 0.1);
    if (animatingHelper) { this.viewHelper.update(dt); if (!this.viewHelper.animating) this.orbit.update(); }
    this.app.tick(dt);
    this.render();
    this.dirty = false;
    this.perf.frame(now, elapsed, playing || this.interacting || this.continuous > 0);
    this.app.emit('frame', dt);
  }

  render() {
    const r = this.renderer;
    r.render(this.scene, this.activeCamera);
    if (this.viewHelper && this.activeCamera === this.camera && this.app.settings.get('showAxes')) {
      r.autoClear = false;
      this.viewHelper.render(r);
      r.autoClear = true;
    }
  }

  stats() {
    const i = this.renderer.info;
    return {
      fps: this.perf.fps,
      calls: i.render.calls,
      triangles: i.render.triangles,
      geometries: i.memory.geometries,
      textures: i.memory.textures,
    };
  }
}

export function isHelper(o) {
  while (o) {
    if (o.userData && o.userData.helper) return true;
    o = o.parent;
  }
  return false;
}

function visibleChain(o) {
  while (o) { if (!o.visible) return false; o = o.parent; }
  return true;
}
