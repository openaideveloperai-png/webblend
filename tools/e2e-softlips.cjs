// Soft lips on the GPU: the lip offsets are added in the shader after skinning. Renders
// the small test mouth from tools/test-softlips.mjs in Chromium: with the offsets at zero
// the picture is exactly the unpatched one, with the tongue out the lips move around it.
// Usage: node tools/e2e-softlips.cjs
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright');
const esbuild = require('esbuild');

const page = `
import * as THREE from 'three';
import { mouthy } from './test-softlips.mjs';
import { softLips } from '../src/anim/softlips.js';
import { faceTracks } from '../src/anim/face.js';
window.run = () => {
  const { model, mouth } = mouthy();
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x30343a);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x404050, 1.6));
  const dl = new THREE.DirectionalLight(0xffffff, 2); dl.position.set(1, 2, 3); scene.add(dl);
  scene.add(model.root);
  const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true });
  renderer.setSize(320, 240);
  document.body.appendChild(renderer.domElement);
  const cam = new THREE.PerspectiveCamera(30, 320 / 240, 0.01, 10);
  const c = new THREE.Vector3(0, 1.6, 0.115);
  cam.position.copy(c).addScaledVector(new THREE.Vector3(0.35, 0.15, 1).normalize(), 0.13);
  cam.lookAt(c);
  const mixer = new THREE.AnimationMixer(model.root);
  mixer.clipAction(new THREE.AnimationClip('t', 1, faceTracks(model, [{ t: 0, control: 'tongue_out', value: 1 }, { t: 1, control: 'tongue_out', value: 1 }], 1).tracks)).play();
  mixer.setTime(0.5);
  model.root.updateMatrixWorld(true);
  const shot = () => { renderer.render(scene, cam); const g = renderer.getContext(), px = new Uint8Array(320 * 240 * 4); g.readPixels(0, 0, 320, 240, g.RGBA, g.UNSIGNED_BYTE, px); return px; };
  const plain = shot();
  const s = softLips(model);
  s.clear();
  const zero = shot();
  const st = s.update({ force: true });
  const wrapped = shot();
  const diff = (a, b) => { let n = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) n++; return n; };
  return { st, zeroDiff: diff(plain, zero), wrapDiff: diff(plain, wrapped), patched: !!mouth.geometry.attributes.contactOffset, png: renderer.domElement.toDataURL('image/png') };
};
`;

(async () => {
  let fails = 0;
  const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'softlips-'));
  const entry = path.join(__dirname, '.softlips-page.mjs');
  fs.writeFileSync(entry, page);
  try {
    await esbuild.build({ entryPoints: [entry], bundle: true, format: 'iife', outfile: path.join(dir, 'page.js'), logLevel: 'warning' });
  } finally { fs.unlinkSync(entry); }
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0"><script src="page.js"></script></body></html>');
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const pg = await browser.newPage();
  const errors = [];
  pg.on('pageerror', (e) => errors.push(e.message));
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
  await pg.goto('file://' + path.join(dir, 'index.html'));
  const r = await pg.evaluate(() => window.run());
  ok('the lip material compiles with the offset (no shader errors)', !errors.length, errors.slice(0, 2).join(' | '));
  ok('offsets at zero draw exactly the unpatched mouth', r.patched && r.zeroDiff === 0, `${r.zeroDiff} px differ`);
  ok('tongue out: the lips move around it on screen', r.st.active && r.wrapDiff > 400, `${r.wrapDiff} px changed, ${JSON.stringify(r.st)}`);
  if (process.argv[2]) fs.writeFileSync(process.argv[2], Buffer.from(r.png.split(',')[1], 'base64'));
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'SOFT LIPS GPU OK');
  process.exit(fails ? 1 : 0);
})();
