const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const [,, A, OUT] = process.argv;
let fails = 0;
const ok = (l, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + l + (x ? '  ' + x : '')); if (!c) fails++; };
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.webblend.setQuality('low'));

  // add light + camera from the Add menu
  await page.click('.menu-btn:has-text("Add")');
  await page.click('.dd-item:has-text("Point light")');
  await page.click('.menu-btn:has-text("Add")');
  await page.click('.dd-item:has-text("Camera")');
  await page.click('.menu-btn:has-text("Add")');
  await page.click('.dd-item:has-text("Cube")');
  let names = await page.evaluate(() => window.webblend.models.map((m) => m.kind));
  ok('Add menu: light, camera, cube', names.includes('light') && names.includes('camera') && names.includes('primitive'), names.join(','));

  // properties: type a position value and drag-scrub another
  const before = await page.evaluate(() => window.webblend.selection.object.position.toArray());
  const inputs = await page.$$('#tab-props .num input');
  await inputs[0].fill('2.5');
  await inputs[0].press('Enter');
  const tag = await page.$$('#tab-props .num i');
  const tb = await tag[1].boundingBox();
  await page.mouse.move(tb.x + 4, tb.y + 8); await page.mouse.down(); await page.mouse.move(tb.x + 60, tb.y + 8, { steps: 5 }); await page.mouse.up();
  const after = await page.evaluate(() => window.webblend.selection.object.position.toArray());
  ok('typing a value sets position X', Math.abs(after[0] - 2.5) < 1e-6, JSON.stringify(after));
  ok('dragging the Y label scrubs the value', after[1] > before[1] + 0.01, `${before[1]} -> ${after[1]}`);
  await page.keyboard.press('Control+z');
  const undone = await page.evaluate(() => window.webblend.selection.object.position.y);
  ok('undo reverts the scrub', Math.abs(undone - before[1]) < 1e-6, String(undone));

  // camera: key fov, look through
  await page.evaluate(() => { const a = window.webblend; const cam = a.models.find((m) => m.kind === 'camera'); a.select(cam.root, cam); });
  await page.waitForTimeout(200);
  await page.click('#tab-props button:has-text("Look through")');
  const looking = await page.evaluate(() => window.webblend.viewport.activeCamera !== window.webblend.viewport.camera);
  ok('look through camera', looking);
  await page.keyboard.press('0');
  ok('0 toggles back to editor view', await page.evaluate(() => window.webblend.viewport.activeCamera === window.webblend.viewport.camera));

  // timeline: key the cube at frames 0 and 30, drag a key, double-click insert, delete
  const tl = await page.evaluate(() => {
    const a = window.webblend; const cube = a.models.find((m) => m.kind === 'primitive');
    a.select(cube.root, cube); a.setTime(0); a.keySelection();
    cube.root.position.y = 2; a.setTime(1); a.keySelection();
    return cube.activeClip.clip.tracks[0].times.length;
  });
  ok('two keys on the cube', tl === 2, String(tl));
  const canvas = await page.$('#tl-canvas');
  const cb = await canvas.boundingBox();
  // find x of key at t=1 in the summary row
  const keyX = await page.evaluate(() => { const c = document.getElementById('tl-canvas'); return null; });
  // use the app's own time->x by scanning: click summary row at many x and detect selection via Delete count is heavy; instead drag the key at t=1 using view math
  const geo = await page.evaluate(() => { const a = window.webblend; const e = a.selection.model.activeClip; return { dur: e.clip.duration }; });
  // fit view then compute x from fit formula (labelW 168, pad 24, 1.04 factor, t0=-2%)
  await page.click('button[title="Fit clip in view"]');
  const labelW = 168, W = cb.width;
  const pps = Math.max(50, W - labelW - 24) / (Math.max(geo.dur, 0.25) * 1.04);
  const t0 = -Math.max(geo.dur, 0.25) * 0.02;
  const xAt = (t) => cb.x + labelW + (t - t0) * pps;
  const rowY = cb.y + 24 + 20 * 0 + 10; // summary row
  await page.mouse.move(xAt(1), rowY); await page.mouse.down(); await page.mouse.move(xAt(1.5), rowY, { steps: 6 }); await page.mouse.up();
  const times = await page.evaluate(() => Array.from(window.webblend.selection.model.activeClip.clip.tracks[0].times).map((x) => +x.toFixed(3)));
  ok('dragging a key retimes it (1.0s -> 1.5s)', times.length === 2 && Math.abs(times[1] - 1.5) < 0.05, JSON.stringify(times));
  await page.mouse.dblclick(xAt(0.5), cb.y + 24 + 20 * 2 + 10); // first node row (Cube) -> insert keys
  const n3 = await page.evaluate(() => window.webblend.selection.model.activeClip.clip.tracks[0].times.length);
  ok('double-click inserts a key', n3 === 3, String(n3));
  await page.mouse.click(xAt(0.5), rowY);
  await page.keyboard.press('Delete');
  const n4 = await page.evaluate(() => window.webblend.selection.model.activeClip.clip.tracks[0].times.length);
  ok('Delete removes the selected key', n4 === 2, String(n4));
  await page.mouse.click(xAt(1.5), rowY, { button: 'right' });
  await page.click('.dd-item:has-text("Stepped")');
  const interp = await page.evaluate(() => window.webblend.selection.model.activeClip.clip.tracks[0].getInterpolation());
  ok('context menu sets stepped interpolation', interp === 2300, String(interp));

  // pose copy/paste on mannequin + mirror clip + copy from another character
  const pose = await page.evaluate(() => {
    const a = window.webblend; const man = a.models.find((m) => m.humanoid);
    a.select(man.root, man); a.pause(); a.setTime(0.3); a.tick(0);
    const arm = man.humanoid.map.leftUpperArm; const q0 = arm.quaternion.clone();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }));
    arm.quaternion.set(0, 0, 0, 1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }));
    const restored = arm.quaternion.angleTo(q0) < 1e-4;
    const walk = man.clips.find((c) => /Walk/.test(c.clip.name));
    const mir = a.mirrorClip(man, walk);
    const dup = a.duplicateModel(man);
    const r = a.retargetFrom(man, walk, dup);
    return { restored, mirrored: !!mir && mir.clip.tracks.length > 10, copied: !!r && r.clip.tracks.length > 10 };
  });
  ok('Ctrl+C / Ctrl+V copies and pastes a pose', pose.restored);
  ok('mirror clip creates a mirrored walk', pose.mirrored);
  ok('copy clip from another character', pose.copied);

  // settings modal: switch quality via the dialog
  await page.click('#btn-settings');
  await page.click('.qbtn:has-text("Potato")');
  ok('settings dialog changes quality', await page.evaluate(() => window.webblend.settings.get('quality') === 'potato'));
  await page.keyboard.press('Escape');

  // video recording (short)
  await page.evaluate(() => window.webblend.setQuality('low'));
  await page.click('.menu-btn:has-text("File")');
  await page.click('.dd-item:has-text("Record video")');
  await page.fill('.modal input[type=number]', '1');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.modal button:has-text("Record")')]);
  const vp = path.join(OUT, 'clip.webm');
  await dl.saveAs(vp);
  ok('records a WebM video', fs.statSync(vp).size > 2000, fs.statSync(vp).size + ' bytes');

  // bone dots stay small on screen when the camera is very close
  const dots = await page.evaluate(() => {
    const a = window.webblend;
    a.clearScene(); const m = a.addMannequin();
    for (const e of m.clips) m.setPlaying(e, false);
    m.resetPose();
    const vp = a.viewport;
    const hand = m.humanoid.map.leftHand;
    const p = hand.getWorldPosition(hand.position.clone());
    vp.orbit.target.copy(p);
    vp.camera.position.copy(p).add(new p.constructor(0, 0, 0.12));
    vp.camera.near = 0.001; vp.camera.updateProjectionMatrix(); vp.orbit.update();
    a.tick(0);
    // on-screen radius of each dot in pixels
    const h = vp.renderer.domElement.clientHeight;
    const pm = m.joints.points, M = new pm.matrix.constructor(), pos = p.clone(), q = vp.camera.quaternion.clone(), sc = p.clone();
    let maxPx = 0;
    for (let i = 0; i < pm.count; i++) {
      pm.getMatrixAt(i, M); M.decompose(pos, q, sc);
      const depth = pos.clone().sub(vp.camera.position).dot(vp.camera.getWorldDirection(p.clone()));
      if (depth <= 0.002) continue;
      const px = sc.x / (2 * depth * Math.tan(vp.camera.fov * Math.PI / 360) / h);
      maxPx = Math.max(maxPx, px);
    }
    return { maxPx, size: m.joints.size };
  });
  ok('bone dots stay small when zoomed in close', dots.maxPx > 0.5 && dots.maxPx <= 9, JSON.stringify(dots));

  // fly mode: ` toggles, WASD moves the camera without switching gizmo tools
  await page.evaluate(() => { const a = window.webblend; a.viewport.frameAll(); a.setGizmoMode('rotate'); });
  await page.click('#viewport canvas', { position: { x: 5, y: 300 } });
  await page.keyboard.press('Backquote');
  const fly0 = await page.evaluate(() => ({ on: window.webblend.viewport.fly.on, pos: window.webblend.viewport.camera.position.toArray(), hud: !document.querySelector('.fly-hud').hidden }));
  await page.keyboard.down('KeyW');
  await page.waitForTimeout(600);
  await page.keyboard.up('KeyW');
  await page.keyboard.down('KeyE');
  await page.waitForTimeout(300);
  await page.keyboard.up('KeyE');
  const fly1 = await page.evaluate(() => ({ pos: window.webblend.viewport.camera.position.toArray(), mode: window.webblend.gizmoMode, orbit: window.webblend.viewport.orbit.enabled }));
  const moved = Math.hypot(fly1.pos[0] - fly0.pos[0], fly1.pos[1] - fly0.pos[1], fly1.pos[2] - fly0.pos[2]);
  ok('fly mode turns on with ` and shows its hint', fly0.on && fly0.hud);
  ok('W / E move the camera (gizmo tool unchanged, orbit off)', moved > 0.1 && fly1.pos[1] > fly0.pos[1] && fly1.mode === 'rotate' && !fly1.orbit, JSON.stringify({ moved: moved.toFixed(2), mode: fly1.mode }));
  // right-drag looks around
  const q0 = await page.evaluate(() => window.webblend.viewport.camera.quaternion.toArray());
  const box = await (await page.$('#viewport canvas')).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 30, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  const q1 = await page.evaluate(() => window.webblend.viewport.camera.quaternion.toArray());
  ok('right-drag looks around in fly mode', Math.abs(q0[1] - q1[1]) + Math.abs(q0[0] - q1[0]) > 0.05, JSON.stringify([q0.map((v) => +v.toFixed(2)), q1.map((v) => +v.toFixed(2))]));
  await page.keyboard.press('Escape');
  const fly2 = await page.evaluate(() => ({ on: window.webblend.viewport.fly.on, orbit: window.webblend.viewport.orbit.enabled, hud: !document.querySelector('.fly-hud').hidden }));
  ok('Esc leaves fly mode and orbiting works again', !fly2.on && fly2.orbit && !fly2.hud, JSON.stringify(fly2));
  await page.keyboard.press('w');
  ok('W switches back to the move tool after fly mode', await page.evaluate(() => window.webblend.gizmoMode === 'translate'));

  ok('no console errors', errors.length === 0, errors.slice(0, 5).join(' | '));
  await page.screenshot({ path: path.join(OUT, 'ui.png') });
  await browser.close();
  console.log(fails ? `${fails} FAILURE(S)` : 'ALL UI TESTS OK');
})();
