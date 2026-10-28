// Self-review for models Claude builds: an automatic inspection (parts that failed,
// floating pieces, gaps, anchors off the model) and a contact sheet of renders
// (right side, front, top, three-quarter) Claude looks at to fix its own model.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { partBoxes, connectedGroups } from '../scene/props.js';

const cm = (m) => `${(m * 100).toFixed(m < 0.1 ? 1 : 0)} cm`;

function whyNot(p) {
  const n = (a) => (Array.isArray(a) ? a.length : 0);
  switch (p.shape) {
    case 'extrude': return n(p.profile) < 3 ? 'its profile needs at least 3 [u, v] points' : 'its outline could not be filled (self-crossing?)';
    case 'lathe': return 'its profile needs at least 2 [radius, height] points';
    case 'loft': return 'it needs at least 2 sections [at, width, height, roundness, offsetW, offsetH]';
    case 'sweep': return 'its path needs at least 2 distinct [x, y, z] points';
    default: return `unknown or incomplete shape "${p.shape}"`;
  }
}

const boxDist = (a, b) => {
  const d = (lo1, hi1, lo2, hi2) => Math.max(0, lo2 - hi1, lo1 - hi2);
  return Math.hypot(d(a.min.x, a.max.x, b.min.x, b.max.x), d(a.min.y, a.max.y, b.min.y, b.max.y), d(a.min.z, a.max.z, b.min.z, b.max.z));
};

// def = the spec buildProp got, prop = what it built -> { text, issues }
export function inspectProp(def, prop) {
  const parts = (def.parts || []).filter((p) => p && p.shape).slice(0, 400);
  const lines = [], issues = [];
  const box = new THREE.Box3().setFromObject(prop);
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3());
  let tris = 0;
  prop.traverse((o) => { if (o.isMesh) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; });
  lines.push(`size: ${cm(size.x)} wide (x) × ${cm(size.y)} tall (y) × ${cm(size.z)} long (z); ${parts.length} parts, ${Math.round(tris)} triangles`);
  const boxes = partBoxes(parts);
  const failed = parts.map((p, i) => (boxes[i] ? null : `"${p.name || p.shape}" (${whyNot(p)})`)).filter(Boolean);
  if (failed.length) issues.push(`${failed.length} part(s) could not be built and are missing: ${failed.slice(0, 8).join('; ')}`);
  // pieces that don't touch the main body
  const groups = connectedGroups(boxes, 0.002);
  if (groups.length > 1) {
    const vol = (g) => g.reduce((a, i) => a + boxes[i].reduce((s, b) => { const v = b.getSize(new THREE.Vector3()); return s + v.x * v.y * v.z; }, 0), 0);
    groups.sort((a, b) => vol(b) - vol(a));
    const main = groups[0];
    for (const g of groups.slice(1, 7)) {
      let gap = Infinity;
      for (const i of g) for (const j of main) for (const a of boxes[i]) for (const b of boxes[j]) gap = Math.min(gap, boxDist(a, b));
      issues.push(`not touching the main body (gap ${cm(gap)}): ${g.slice(0, 6).map((i) => `"${parts[i].name || parts[i].shape}"`).join(', ')}${g.length > 6 ? ` and ${g.length - 6} more` : ''}`);
    }
    if (groups.length > 7) issues.push(`${groups.length - 7} more separate pieces`);
  }
  // parts far bigger or smaller than makes sense
  const odd = [];
  parts.forEach((p, i) => {
    if (!boxes[i]) return;
    const s = boxes[i][0].getSize(new THREE.Vector3());
    const mx = Math.max(s.x, s.y, s.z);
    if (mx > Math.max(3, Math.max(size.x, size.y, size.z) * 0.98) && parts.length > 3) odd.push(`"${p.name}" is ${cm(mx)} long`);
    else if (mx < 0.0006) odd.push(`"${p.name}" is under 1 mm`);
  });
  if (odd.length) issues.push(`suspicious sizes: ${odd.slice(0, 5).join('; ')}`);
  // anchors on the model
  const A = (prop.userData.prop && prop.userData.prop.anchors) || {};
  const near = (v) => Math.min(...boxes.filter(Boolean).flat().map((b) => b.distanceToPoint(v)));
  if (A.grip && boxes.some(Boolean)) { const d = near(A.grip); if (d > 0.025) issues.push(`the grip anchor is ${cm(d)} away from any part (the hand would hold air)`); }
  if (A.support && boxes.some(Boolean)) { const d = near(A.support); if (d > 0.03) issues.push(`the support anchor is ${cm(d)} away from any part`); }
  if (def.kind === 'gun' && A.muzzle && !box.isEmpty() && A.muzzle.z < box.max.z - Math.max(0.03, size.z * 0.15)) issues.push(`the muzzle anchor (z ${cm(A.muzzle.z)}) is not at the front end of the model (z ${cm(box.max.z)}); guns point along +Z`);
  if (def.kind === 'gun' && size.z < Math.max(size.x, size.y) * 0.9) issues.push('the gun is not longest along z: the barrel should run along +Z');
  if (def.kind === 'melee' && size.y < Math.max(size.x, size.z) * 0.9) issues.push('the weapon is not longest along y: handle and blade should run along +Y');
  if (parts.length < 25 && def.preset === 'custom') issues.push(`only ${parts.length} parts: too simple for a high-quality model`);
  const mats = new Set(parts.map((p) => p.material));
  lines.push(`materials used: ${[...mats].join(', ')}`);
  return { text: [...lines, ...(issues.length ? issues.map((x) => '- ' + x) : ['- no automatic problems found'])].join('\n'), issues: issues.length };
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}

// prop -> JPEG Blob: four labelled views with a 10 cm grid and anchor dots (null without WebGL)
export async function renderReview(prop, { cell = [512, 384] } = {}) {
  if (typeof document === 'undefined') return null;
  const [W, H] = cell;
  let renderer;
  try {
    const glCanvas = document.createElement('canvas');
    renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
  } catch { return null; }
  const sheet = makeCanvas(W * 2, H * 2);
  const g2 = sheet.getContext('2d');
  const disposables = [];
  try {
    renderer.setPixelRatio(1);
    renderer.setSize(W, H, false);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#a7afb8');
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = env;
    disposables.push(env, pmrem);
    scene.add(new THREE.HemisphereLight('#ffffff', '#55585e', 0.8));
    const key = new THREE.DirectionalLight('#ffffff', 1.6); key.position.set(-1, 2, 1.5); scene.add(key);
    // the prop, centered, with its anchors as dots
    const holder = new THREE.Group();
    const parent = prop.parent, saved = { p: prop.position.clone(), q: prop.quaternion.clone(), s: prop.scale.clone() };
    prop.position.set(0, 0, 0); prop.quaternion.identity(); prop.scale.set(1, 1, 1);
    holder.add(prop);
    scene.add(holder);
    prop.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(prop);
    if (box.isEmpty()) return null;
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const maxD = Math.max(size.x, size.y, size.z, 0.01);
    const A = (prop.userData.prop && prop.userData.prop.anchors) || {};
    const dotR = Math.max(0.003, maxD * 0.012);
    for (const [k, c] of [['grip', '#2fd04a'], ['support', '#2f7bff'], ['muzzle', '#ff3030']]) {
      if (!A[k]) continue;
      const geo = new THREE.SphereGeometry(dotR, 12, 8), mat = new THREE.MeshBasicMaterial({ color: c, depthTest: false });
      const m = new THREE.Mesh(geo, mat); m.position.copy(A[k]); m.renderOrder = 10; holder.add(m);
      disposables.push(geo, mat);
    }
    // a 10 cm grid behind each orthographic view
    const views = [
      { label: 'RIGHT SIDE  (looking +X: front +Z is →, up +Y is ↑)', dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0), w: size.z, h: size.y },
      { label: 'FRONT  (looking −Z at the front: +X is →, up +Y is ↑)', dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), w: size.x, h: size.y },
      { label: 'TOP  (looking −Y: front +Z is ↑, left +X is ←)', dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, 1), w: size.x, h: size.z },
      { label: 'THREE-QUARTER', dir: new THREE.Vector3(-1, 0.55, 0.9).normalize(), up: new THREE.Vector3(0, 1, 0), persp: true },
    ];
    const aspect = W / H;
    views.forEach((v, i) => {
      let cam;
      if (v.persp) {
        cam = new THREE.PerspectiveCamera(30, aspect, maxD / 100, maxD * 20);
        const dist = (maxD * 0.62) / Math.tan(THREE.MathUtils.degToRad(15));
        cam.position.copy(center).addScaledVector(v.dir, dist);
      } else {
        let hw = Math.max(v.w, 0.01) * 0.58, hh = Math.max(v.h, 0.01) * 0.58;
        if (hw / hh > aspect) hh = hw / aspect; else hw = hh * aspect;
        cam = new THREE.OrthographicCamera(-hw, hw, hh, -hh, -maxD * 10, maxD * 10);
        cam.position.copy(center).addScaledVector(v.dir, maxD * 3);
      }
      cam.up.copy(v.up);
      cam.lookAt(center);
      cam.updateMatrixWorld(true);
      let grid = null;
      if (!v.persp) {
        const extent = Math.ceil((maxD * 1.6) / 0.1) * 0.1;
        grid = new THREE.GridHelper(extent * 2, Math.round((extent * 2) / 0.1), '#7d858e', '#8e969f');
        // lay the grid in the view plane, behind the model
        grid.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), v.dir);
        grid.position.copy(center).addScaledVector(v.dir, -maxD * 1.2);
        scene.add(grid);
      }
      renderer.render(scene, cam);
      g2.drawImage(renderer.domElement, (i % 2) * W, Math.floor(i / 2) * H, W, H);
      if (grid) { scene.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
      g2.fillStyle = 'rgba(0,0,0,0.55)';
      g2.fillRect((i % 2) * W, Math.floor(i / 2) * H, W, 22);
      g2.fillStyle = '#ffffff'; g2.font = '13px sans-serif';
      g2.fillText(v.label, (i % 2) * W + 8, Math.floor(i / 2) * H + 15);
    });
    g2.fillStyle = 'rgba(0,0,0,0.55)'; g2.fillRect(0, H * 2 - 22, W * 2, 22);
    g2.fillStyle = '#ffffff'; g2.font = '13px sans-serif';
    g2.fillText(`grid squares = 10 cm · size ${cm(size.x)} × ${cm(size.y)} × ${cm(size.z)} (x × y × z) · green = grip, blue = support hand, red = muzzle/tip`, 8, H * 2 - 7);
    g2.strokeStyle = '#ffffff'; g2.lineWidth = 2; g2.beginPath(); g2.moveTo(W, 0); g2.lineTo(W, H * 2); g2.moveTo(0, H); g2.lineTo(W * 2, H); g2.stroke();
    // put the prop back the way it was
    holder.remove(prop);
    if (parent) parent.add(prop);
    prop.position.copy(saved.p); prop.quaternion.copy(saved.q); prop.scale.copy(saved.s);
    prop.updateMatrixWorld(true);
    return sheet.convertToBlob ? await sheet.convertToBlob({ type: 'image/jpeg', quality: 0.85 }) : await new Promise((res) => sheet.toBlob(res, 'image/jpeg', 0.85));
  } catch (e) {
    console.warn('model review render failed', e);
    return null;
  } finally {
    for (const d of disposables) d.dispose?.();
    renderer.dispose();
    renderer.forceContextLoss?.();
  }
}

// Frames of a clip as the app plays it (effects included), for Claude to check its
// effects: up to 6 labelled moments from a three-quarter view. -> JPEG Blob or null
export async function renderFilmstrip(app, model, entry, times, { labels = [], top = 0, focus = null, views = [] } = {}) {
  const vp = app.viewport;
  if (!vp || !vp.renderer || !times.length) return null;
  const r = vp.renderer, canvas = r.domElement;
  const aspect = canvas.width / Math.max(1, canvas.height) || 1.5;
  const W = 400, H = Math.round(W / aspect);
  const cols = 3, rows = Math.ceil(Math.min(6, times.length) / cols);
  const sheet = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W * cols, H * rows) : Object.assign(document.createElement('canvas'), { width: W * cols, height: H * rows });
  const g = sheet.getContext('2d');
  const tr = app.transport, savedT = tr.time, wasPlaying = tr.playing;
  if (wasPlaying) app.pause();
  const hidden = [];
  const hide = (o) => { if (o && o.visible) { o.visible = false; hidden.push(o); } };
  for (const m of app.models) hide(m.joints);
  hide(app.selBox); hide(vp.gizmo && vp.gizmo.getHelper ? vp.gizmo.getHelper() : null);
  try {
    // frame the character and where its effects went
    model.root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model.root, true);
    const size = box.getSize(new THREE.Vector3()), c = box.getCenter(new THREE.Vector3());
    const rig = model.humanoid;
    const toWorld = (v) => v.clone().transformDirection(model.root.matrixWorld);
    const fwd = rig && rig.fwd ? toWorld(rig.fwd) : new THREE.Vector3(0, 0, 1), lat = rig && rig.lat ? toWorld(rig.lat) : new THREE.Vector3(1, 0, 0), up = rig && rig.up ? toWorld(rig.up) : new THREE.Vector3(0, 1, 0);
    // frame the character from the floor up to whatever the effects reach (capped)
    const floorY = box.min.dot(up);
    const charH = Math.max(size.y, 0.5);
    const height = Math.min(Math.max(charH, top || 0), charH * 3);
    const look = c.clone().addScaledVector(up, floorY + height / 2 - c.dot(up));
    const cam = new THREE.PerspectiveCamera(35, aspect, height / 50, height * 60);
    const dist = (height * 0.62) / Math.tan(THREE.MathUtils.degToRad(17.5));
    cam.position.copy(look).addScaledVector(fwd, dist * 0.84).addScaledVector(lat, -dist * 0.42).addScaledVector(up, dist * 0.12);
    cam.up.copy(up);
    cam.lookAt(look);
    times.slice(0, 6).forEach((t, i) => {
      app.setTime(t, { emit: false });
      app.tick(0);
      if (focus) {
        // a close-up that follows a part of the body (the face): 3/4 front or from the side
        const f = focus(t);
        const d = f.radius / Math.tan(THREE.MathUtils.degToRad(17.5));
        cam.near = d / 50; cam.far = d * 50; cam.updateProjectionMatrix();
        if (views[i] === 'side') cam.position.copy(f.center).addScaledVector(f.lat, -d).addScaledVector(f.fwd, d * 0.15);
        else cam.position.copy(f.center).addScaledVector(f.fwd, d * 0.85).addScaledVector(f.lat, -d * 0.42).addScaledVector(f.up, d * 0.08);
        cam.up.copy(f.up);
        cam.lookAt(f.center);
      }
      r.render(vp.scene, cam);
      const x = (i % cols) * W, y = Math.floor(i / cols) * H;
      g.drawImage(canvas, x, y, W, H);
      g.fillStyle = 'rgba(0,0,0,0.6)'; g.fillRect(x, y, W, 20);
      g.fillStyle = '#fff'; g.font = '13px sans-serif';
      g.fillText(`${String.fromCharCode(65 + i)}  t = ${t.toFixed(2)} s${labels[i] ? '  ·  ' + labels[i] : ''}`, x + 6, y + 14);
    });
  } catch (e) {
    console.warn('filmstrip failed', e);
    return null;
  } finally {
    for (const o of hidden) o.visible = true;
    app.setTime(savedT, { emit: false });
    app.tick(0);
    if (wasPlaying) app.play();
    vp.requestRender();
  }
  return sheet.convertToBlob ? await sheet.convertToBlob({ type: 'image/jpeg', quality: 0.85 }) : await new Promise((res) => sheet.toBlob(res, 'image/jpeg', 0.85));
}
