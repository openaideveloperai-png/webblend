// Quality-of-life: edit an AI effect in Properties (recolor, remove, undo), hide effects,
// turntable view, export dialog remembers the platform.
const { chromium } = require('playwright');
const path = require('path');
let fails = 0;
const ok = (l, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + l + (x ? '  ' + x : '')); if (!c) fails++; };
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1200);
  const made = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0]; for (const e of [...m.clips]) m.removeClip(e);
    a.select(m.root, m);
    const r = a.ai.runOffline('katana slash with a trail and sparks');
    for (const res of r.results) a.addClipToModel(res.model, res.clip, { loop: false });
    a.pause();
    const fx = m.root.getObjectByName('Effects');
    const trail = fx && fx.children.find((g) => /trail/i.test(g.name));
    a.select(trail, m);
    return { msg: r.message, groups: fx ? fx.children.map((g) => g.name) : [] };
  });
  ok('offline: a slash with a trail and sparks', made.groups.length === 2, JSON.stringify(made));
  await page.waitForSelector('.sec-t:has-text("Effect · Slash trail")', { timeout: 5000 });
  ok('selecting an effect shows its editor', await page.isVisible('button:has-text("Remove effect")'));
  // recolor
  await page.evaluate(() => { const i = [...document.querySelectorAll('.field')].find((f) => f.textContent.startsWith('Color')).querySelector('input[type=color]'); i.value = '#ff2a2a'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  const recolored = await page.evaluate(() => { const m = window.webblend.models[0]; const e = m.clips[m.clips.length - 1]; return e.clip.userData.vfx.find((v) => /trail/i.test(v.name)).color; });
  ok('recolor re-bakes the effect', recolored === '#ff2a2a', recolored);
  // hide effects
  const vis = async () => page.evaluate(() => { const a = window.webblend; a.setTime(0.75); a.tick(0); let n = 0; a.models[0].root.traverse((o) => { if (o.userData.vfx && o.visible) n++; }); return n; });
  const before = await vis();
  await page.evaluate(() => window.webblend.setSetting('showEffects', false));
  const hidden = await vis();
  await page.evaluate(() => window.webblend.setSetting('showEffects', true));
  ok('View → hide effects hides them, show brings them back', before > 0 && hidden === 0 && (await vis()) > 0, `${before} / ${hidden}`);
  // remove + undo
  await page.click('button:has-text("Remove effect")');
  const after = await page.evaluate(() => { const m = window.webblend.models[0]; const e = m.clips[m.clips.length - 1]; return e.clip.userData.vfx.map((v) => v.name); });
  await page.evaluate(() => window.webblend.history.undo());
  const undone = await page.evaluate(() => { const m = window.webblend.models[0]; const e = m.clips[m.clips.length - 1]; return e.clip.userData.vfx.map((v) => v.name); });
  ok('remove effect, then undo', after.length === 1 && !after.some((n) => /trail/i.test(n)) && undone.length === 2, JSON.stringify({ after, undone }));
  // turntable
  const cam0 = await page.evaluate(() => window.webblend.viewport.camera.position.toArray());
  await page.evaluate(() => window.webblend.setSetting('autoRotate', true));
  await page.waitForTimeout(700);
  const cam1 = await page.evaluate(() => window.webblend.viewport.camera.position.toArray());
  await page.evaluate(() => window.webblend.setSetting('autoRotate', false));
  ok('turntable orbits the view', Math.hypot(cam1[0] - cam0[0], cam1[2] - cam0[2]) > 0.01, JSON.stringify([cam0, cam1].map((v) => v.map((x) => +x.toFixed(2)))));
  // export dialog remembers the last platform
  await page.click('.menu-btn:has-text("File")');
  await page.click('.dd-item:has-text("Export for Roblox")');
  await page.click('[data-platform="unreal"]');
  await page.click('.modal-h .ibtn');
  await page.click('.menu-btn:has-text("File")');
  await page.click('.dd-item:has-text("Export for Roblox")');
  ok('export dialog opens on the platform used last', (await page.getAttribute('[data-platform="unreal"]', 'aria-pressed')) === 'true');
  await page.keyboard.press('Escape').catch(() => {});
  await page.evaluate(() => document.querySelectorAll('.modal-back').forEach((m) => m.remove()));
  // poses saved in a file: single-frame actions become poses (not zero-length clips), with sliders
  const poses = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0];
    for (const e of [...m.clips]) m.removeClip(e);
    const Clip = a.ai.runOffline('wave').results[0].clip.constructor;
    const head = m.root.getObjectByName('Head'), idx = m.root.getObjectByName('LeftHandIndex1');
    const s = Math.sin(0.2), c = Math.cos(0.2);
    m.addClip(Clip.parse({ name: 'mouth_o', duration: 0, tracks: [{ name: head.uuid + '.quaternion', type: 'quaternion', times: [0], values: [s, 0, 0, c] }, { name: idx.uuid + '.quaternion', type: 'quaternion', times: [0], values: idx.quaternion.toArray() }] }), { play: false });
    m.addClip(Clip.parse({ name: 'still_pose', duration: 0, tracks: [{ name: head.uuid + '.quaternion', type: 'quaternion', times: [0], values: head.quaternion.toArray() }] }), { play: false });
    const m2 = a.duplicateModel(m); // goes through the same path as opening a file
    a.select(m2.root, m2);
    return { poses: (m2.poses || []).map((p) => `${p.name}/${p.deltas.length}`), clips: m2.clips.map((e) => e.clip.name), notes: m2.importNotes || [] };
  });
  ok('single-frame actions become poses; a copy of the rest pose is left out', JSON.stringify(poses.poses) === '["mouth_o/1"]' && poses.clips.length === 0 && /under Animations → Poses/.test(poses.notes.join(' ')) && /"still_pose"/.test(poses.notes.join(' ')), JSON.stringify(poses));
  await page.click('.tab:has-text("Animations")');
  await page.waitForSelector('.sec-t:has-text("Poses saved in the file")', { timeout: 5000 });
  await page.evaluate(() => { const r = document.querySelector('.pose-row input[type=range]'); r.value = '1'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  const turned = await page.evaluate(() => { const a = window.webblend; const m = a.selection.model; const h = m.root.getObjectByName('Head'); return +(2 * Math.acos(Math.min(1, Math.abs(h.quaternion.w))) * 57.3).toFixed(1); });
  ok('the pose slider poses the bones', Math.abs(turned - 22.9) < 0.5, turned + '°');
  await page.click('button:has-text("Key this mix")');
  const keyed = await page.evaluate(() => { const a = window.webblend; const m = a.selection.model; const h = m.root.getObjectByName('Head'); const e = m.activeClip; return e ? e.clip.tracks.filter((t) => t.name.startsWith(h.uuid)).length : 0; });
  ok('"Key this mix" keys it into the active clip', keyed >= 1, keyed);
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL QOL TESTS OK');
  process.exit(fails ? 1 : 0);
})();
