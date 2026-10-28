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
  page.on('pageerror', (e) => { errors.push(e.message); if (process.env.STACK) console.log('STACK', e.stack); });
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
  // bones go back to rest when their keys are deleted or their clip goes away; a bone
  // posed by hand (no keys) stays where it was put
  const rel = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0]; a.select(m.root, m);
    for (const e of [...m.clips]) m.removeClip(e);
    const ang = (b) => +(2 * Math.acos(Math.min(1, Math.abs(b.quaternion.dot(m.rest.get(b).q)))) * 57.3).toFixed(1);
    const fore = m.root.getObjectByName('RightForeArm'), upper = m.root.getObjectByName('RightArm'), head = m.root.getObjectByName('LeftHandIndex2');
    const r = a.ai.runOffline('wave with the right hand');
    const e = a.addClipToModel(m, r.results[0].clip, { solo: true });
    a.pause(); a.setTime(0.6); a.needsEval = true; a.tick(0);
    const keyed = ang(fore);
    head.quaternion.multiply(new head.quaternion.constructor(0.3, 0, 0, 0.954).normalize()); // posed by hand, no keys
    a.editClip(m, e, (clip) => { clip.tracks = clip.tracks.filter((t) => !t.name.startsWith(fore.uuid)); }, 'Delete keys');
    a.needsEval = true; a.tick(0);
    const afterDelete = ang(fore), upperStill = ang(upper);
    m.removeClip(e); a.needsEval = true; a.tick(0);
    return { keyed, afterDelete, upperStill, upperAfterRemove: ang(upper), headKept: ang(head) };
  });
  ok('deleting a bone\'s keys puts it back to rest; removing the clip releases the rest', rel.keyed > 10 && rel.afterDelete < 0.5 && rel.upperStill > 5 && rel.upperAfterRemove < 0.5, JSON.stringify(rel));
  ok('a bone posed by hand without keys stays posed', rel.headKept > 20, rel.headKept);
  // advanced indent settings: select a bone, Ctrl+Shift+4
  await page.evaluate(() => { const a = window.webblend; const m = a.models[0]; a.select(m.root.getObjectByName('Spine1'), m); });
  await page.evaluate(() => { document.querySelectorAll('.modal-back').forEach((m) => m.remove()); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); });
  await page.keyboard.press('Control+Shift+Digit4');
  await page.waitForTimeout(300);
  const dlg = await page.evaluate(() => { const m = document.querySelector('.modal'); if (!m) return { none: true, sel: window.webblend.selection.object && window.webblend.selection.object.name, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ') }; return m ? { title: m.querySelector('h3').textContent, sliders: m.querySelectorAll('input[type=range]').length, info: m.querySelector('.hint').textContent } : null; });
  ok('Ctrl+Shift+4 on a bone opens its indent settings', dlg && /Indent/.test(dlg.title) && /Spine1/.test(dlg.title) && dlg.sliders === 5, JSON.stringify(dlg));
  await page.evaluate(() => { const r = document.querySelector('.modal input[aria-label="Crater width"]'); r.value = '2'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  const ind = await page.evaluate(() => { const a = window.webblend; const m = a.models[0]; const b = m.root.getObjectByName('Spine1'); return m.indent && m.indent[b.uuid]; });
  ok('...the sliders set it on the bone', ind && ind.width === 2, JSON.stringify(ind));
  await page.click('.modal button:has-text("Done")');
  await page.evaluate(() => { const a = window.webblend; a.select(null); });
  await page.keyboard.press('Control+Shift+Digit4');
  await page.waitForTimeout(200);
  const warned = await page.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => /Select a bone/.test(t.textContent)) && !document.querySelector('.modal'));
  ok('...and asks for a bone when none is selected', warned);
  // shape keys: type the value; negative runs the shape the other way, past 1 exaggerates
  const mesh = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0];
    let mesh = null; m.root.traverse((o) => { if (!mesh && o.isMesh && !o.isSkinnedMesh && o.geometry.attributes.position.count > 20) mesh = o; });
    if (!mesh) m.root.traverse((o) => { if (!mesh && o.isMesh) mesh = o; });
    // (a fresh geometry: three.js doesn't expect shape keys to appear on one it has drawn)
    const g = mesh.geometry = mesh.geometry.clone(), pos = g.attributes.position, n = g.attributes.normal;
    // one shape key: every vertex 2 cm out along its normal ("grow")
    const d = new pos.constructor(new Float32Array(pos.count * 3), 3);
    for (let i = 0; i < pos.count; i++) d.setXYZ(i, n.getX(i) * 0.02, n.getY(i) * 0.02, n.getZ(i) * 0.02);
    g.morphAttributes.position = [d]; g.morphTargetsRelative = true;
    mesh.updateMorphTargets(); mesh.morphTargetDictionary = { grow: 0 };
    a.select(mesh, m);
    return { name: mesh.name, uuid: mesh.uuid };
  });
  await page.evaluate(() => document.querySelectorAll('.modal-back').forEach((m) => m.remove()));
  await page.waitForTimeout(300);
  const typeShape = async (v) => {
    // (as typing does: focus, the value changes, Enter)
    await page.evaluate((val) => {
      const box = document.querySelector('input.num[aria-label="grow value"]');
      box.dispatchEvent(new FocusEvent('focus')); box.focus();
      box.value = String(val); box.dispatchEvent(new Event('input', { bubbles: true }));
      box.dispatchEvent(new Event('change', { bubbles: true }));
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }, v);
    await page.waitForTimeout(150);
    return page.evaluate((uuid) => {
      const a = window.webblend; let mesh = null; a.world.traverse((o) => { if (o.uuid === uuid) mesh = o; });
      const v = new mesh.position.constructor(), r = new mesh.position.constructor();
      mesh.getVertexPosition(0, v); r.fromBufferAttribute(mesh.geometry.attributes.position, 0);
      const nn = new mesh.position.constructor().fromBufferAttribute(mesh.geometry.attributes.normal, 0);
      return { value: mesh.morphTargetInfluences[0], out: +(v.sub(r).dot(nn) * 100).toFixed(3), slider: +document.querySelector('input[type=range][aria-label="grow"]').value };
    }, mesh.uuid);
  };
  const plus = await typeShape(0.5), minus = await typeShape(-0.5), big = await typeShape(2);
  ok('shape keys: type the value in; negative runs the shape the other way (a "grow" key shrinks)', Math.abs(plus.value - 0.5) < 1e-6 && Math.abs(minus.value + 0.5) < 1e-6 && plus.out > 0.9 && minus.out < -0.9, JSON.stringify({ plus, minus }));
  ok('...past 1 exaggerates it, the slider stays at its end', Math.abs(big.value - 2) < 1e-6 && big.out > 3.9 && big.slider === 1, JSON.stringify(big));
  await page.keyboard.press('Control+z'); await page.waitForTimeout(150);
  const unTyped = await page.evaluate((uuid) => { let mesh = null; window.webblend.world.traverse((o) => { if (o.uuid === uuid) mesh = o; }); return mesh.morphTargetInfluences[0]; }, mesh.uuid);
  ok("...and undo takes a typed value back", Math.abs(unTyped + 0.5) < 1e-6, String(unTyped));
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL QOL TESTS OK');
  process.exit(fails ? 1 : 0);
})();
