// End-to-end test in headless Chromium. Usage: node tools/e2e.cjs <assetsDir> <outDir>
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const [,, A, OUT] = process.argv;
const T = path.join(A, '..', 'testfiles');
let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };

async function openViaMenu(page, files) {
  await page.click('.menu-btn:has-text("File")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dd-item:has-text("Open files")')]);
  await chooser.setFiles(files);
  await page.waitForFunction(() => !document.querySelector('.toast.busy'), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const notes = await page.evaluate(() => { const m = document.querySelector('.modal-back'); if (!m) return null; const t = [...m.querySelectorAll('li')].map((l) => l.textContent); m.remove(); return t; });
  if (notes) console.log('   notes:', JSON.stringify(notes));
  const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
  if (toasts.length) console.log('   toasts:', JSON.stringify(toasts));
}
const state = (page) => page.evaluate(() => {
  const a = window.webblend;
  return a.models.map((m) => ({ name: m.name, kind: m.kind, clips: m.clips.map((c) => c.clip.name + '/' + c.clip.tracks.length), humanoid: !!m.humanoid, bones: m.bones.length, meshes: m.meshes.length }));
});

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message + ' ' + (e.stack || '').split('\n').slice(1, 3).join(' | ')));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(2000);
  let s = await state(page);
  ok('demo mannequin loaded with clips', s.length === 1 && s[0].humanoid && s[0].clips.length === 2, JSON.stringify(s));

  // 1. GLB humanoid
  await openViaMenu(page, [path.join(A, 'hero.glb')]);
  s = await state(page);
  const hero = s.find((m) => /hero|HeroRig|Scene/i.test(m.name));
  ok('hero.glb imported', !!hero, JSON.stringify(s));
  ok('demo replaced by user model', !s.some((m) => m.name === 'Mannequin'));
  ok('hero is humanoid (UE bone names)', hero && hero.humanoid);
  ok('hero has Wave clip', hero && hero.clips.some((c) => c.startsWith('Wave')));
  await page.screenshot({ path: path.join(OUT, 'e2e-1-hero.png') });

  // 2. animation-only Mixamo FBX onto the selected hero -> retarget
  await page.evaluate(() => { const a = window.webblend; const m = a.models.find((x) => x.humanoid); a.select(m.root, m); });
  await openViaMenu(page, [path.join(A, 'kick_anim_only.fbx')]);
  s = await state(page);
  const hero2 = s.find((m) => m.humanoid);
  ok('kick animation added to hero (no extra model)', hero2 && hero2.clips.some((c) => /kick/i.test(c)) && s.length === 1, JSON.stringify(s));
  const kickCheck = await page.evaluate(() => {
    const a = window.webblend; const m = a.models.find((x) => x.humanoid);
    const e = m.clips.find((c) => /kick/i.test(c.clip.name));
    if (!e) return null;
    for (const c of m.clips) m.setPlaying(c, c === e);
    m.setActiveClip(e);
    a.setTime(e.clip.duration * 0.45); a.tick(0);
    const foot = m.humanoid.map.leftFoot; const p = m.humanoid.posModel(foot);
    const rp = m.humanoid.rest.get(foot).pos;
    return { dz: (p.clone().sub(rp)).dot(m.humanoid.fwd), dup: (p.clone().sub(rp)).dot(m.humanoid.up), hh: m.humanoid.hipHeight };
  });
  ok('retargeted kick lifts left foot forward', kickCheck && kickCheck.dz > 0.1 * kickCheck.hh, JSON.stringify(kickCheck));

  // 3. zip with OBJ + MTL + texture
  await openViaMenu(page, [path.join(A, 'monkey_textured.zip')]);
  const tex = await page.evaluate(() => {
    const a = window.webblend; const m = a.models.find((x) => /monkey/i.test(x.name));
    if (!m) return null;
    let info = null;
    m.root.traverse((o) => { if (o.isMesh && !info) { const mat = Array.isArray(o.material) ? o.material[0] : o.material; info = { hasMap: !!mat.map, w: mat.map && mat.map.image && mat.map.image.width }; } });
    return info;
  });
  ok('zip: OBJ loaded with texture from MTL', tex && tex.hasMap && tex.w === 128, JSON.stringify(tex));

  // 4. FBX + .blend files together
  await openViaMenu(page, [path.join(A, 'hero.fbx'), path.join(T, 'multi_5.2.3_z.blend'), path.join(T, 'rig_4.2.23.blend'), path.join(T, 'mirror_5.2.3.blend')]);
  s = await state(page);
  ok('hero.fbx imported as humanoid', s.some((m) => /hero/i.test(m.name) && m.humanoid && m.meshes > 0 && m.kind === 'import' && m.name !== hero.name) || s.filter((m) => m.humanoid).length >= 2, JSON.stringify(s.map((m) => m.name)));
  ok('multi.blend imported', s.some((m) => /multi/i.test(m.name) && m.meshes >= 6));
  ok('rig.blend imported with clips', s.some((m) => /rig/i.test(m.name) && m.clips.length >= 1 && m.bones >= 3));
  ok('mirror.blend imported with shape-key clip', s.some((m) => /mirror/i.test(m.name) && m.clips.length >= 1));
  await page.evaluate(() => window.webblend.viewport.frameAll());
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'e2e-2-scene.png') });

  // 5. AI offline prompt via the UI
  await page.evaluate(() => { const a = window.webblend; const m = a.models.find((x) => x.humanoid); a.select(m.root, m); });
  await page.click('#btn-ai');
  await page.fill('#ai-prompt', 'jump then wave');
  await page.press('#ai-prompt', 'Enter');
  await page.waitForTimeout(600);
  s = await state(page);
  ok('AI made "Jump → Wave" clip', s.some((m) => m.clips.some((c) => /Jump/.test(c) && /Wave/.test(c))));
  await page.fill('#ai-prompt', 'make everything bounce');
  await page.press('#ai-prompt', 'Enter');
  await page.waitForTimeout(800);
  s = await state(page);
  ok('AI "everything bounce" hits all models', s.filter((m) => m.clips.some((c) => /Bounce/.test(c))).length === s.length, s.map((m) => m.name + ':' + m.clips.length).join(' '));
  await page.screenshot({ path: path.join(OUT, 'e2e-3-ai.png') });

  // 6. keying a bone + undo/redo
  const keyRes = await page.evaluate(() => {
    const a = window.webblend; const m = a.models.find((x) => x.humanoid);
    a.select(m.root, m);
    const e = m.newClip('Pose test', 2); a.setTime(0.5);
    const bone = m.humanoid.map.leftUpperArm;
    a.select(bone, m);
    bone.quaternion.setFromAxisAngle({ x: 0, y: 0, z: 1, isVector3: true }, 0.7);
    a.keySelection();
    const tracks1 = e.clip.tracks.length;
    a.history.undo();
    const tracks2 = e.clip.tracks.length;
    a.history.redo();
    return { tracks1, tracks2, tracks3: e.clip.tracks.length, state: a.propKeyState(bone, 'quaternion') };
  });
  ok('K inserts key on bone; undo removes; redo restores', keyRes.tracks1 >= 1 && keyRes.tracks2 === 0 && keyRes.tracks3 === keyRes.tracks1 && keyRes.state === 'key', JSON.stringify(keyRes));

  // 7. IK drag via API
  const ik = await page.evaluate(() => {
    const a = window.webblend; const m = a.models.find((x) => x.humanoid);
    const hand = m.humanoid.map.leftHand;
    a.setGizmoMode('translate'); a.select(hand, m);
    const before = hand.getWorldPosition(new hand.position.constructor());
    a.emit('gizmo:start');
    a.ikTarget.position.copy(before).add(new hand.position.constructor(0, 0.25 * m.humanoid.hipHeight, 0.2 * m.humanoid.hipHeight));
    a.ikTarget.updateMatrixWorld(true);
    a.emit('gizmo:change');
    a.emit('gizmo:end');
    const after = hand.getWorldPosition(new hand.position.constructor());
    return { moved: after.distanceTo(before), toTarget: after.distanceTo(a.ikTarget.position), ikActive: a.ikActive };
  });
  ok('IK drag moves the hand to the target', ik.ikActive && ik.moved > 0.01 && ik.toTarget < 0.05, JSON.stringify(ik));

  // 8. export scene GLB and re-import (with a per-bone indent and skin softness, which must come back)
  const indentBone = await page.evaluate(() => {
    const m = window.webblend.models.find((x) => x.humanoid); const b = m.humanoid.map.spine || m.humanoid.map.hips;
    m.indent = { [b.uuid]: { width: 2, rigid: false, give: 0.5 } }; m.indentVersion = (m.indentVersion || 0) + 1; m.softSkinSoftness = 1.4;
    return { model: m.name, bone: b.name };
  });
  await page.click('.menu-btn:has-text("File")');
  let dl;
  try {
    [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.dd-item:has-text("Save scene")')]);
  } catch (e) {
    console.log('   export toasts:', JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent))));
    console.log('   errors so far:', errors.slice(-5));
    throw e;
  }
  const glbPath = path.join(OUT, 'export.glb');
  await dl.saveAs(glbPath);
  const size = fs.statSync(glbPath).size;
  ok('GLB export downloaded', size > 10000, size + ' bytes');
  await page.evaluate(() => window.webblend.clearScene());
  await openViaMenu(page, [glbPath]);
  const re = await page.evaluate(() => window.webblend.models.map((m) => m.name + ':' + m.clips.length));
  ok('reopened scene restores each model with its clips', re.length === 6 && re.every((x) => +x.split(':')[1] >= 1), JSON.stringify(re));
  const reIndent = await page.evaluate((want) => {
    const m = window.webblend.models.find((x) => x.name === want.model); if (!m) return null;
    let bone = null; m.root.traverse((o) => { if (!bone && o.isBone && o.name === want.bone) bone = o; });
    return { softness: m.softSkinSoftness, indent: bone && m.indent ? m.indent[bone.uuid] : null };
  }, indentBone);
  ok('...and its per-bone indent (Ctrl+Shift+4) and skin softness', reIndent && reIndent.softness === 1.4 && reIndent.indent && reIndent.indent.width === 2 && reIndent.indent.give === 0.5, JSON.stringify(reIndent));

  // 9. quality switching (renderer rebuild for antialias)
  await page.evaluate(() => { const a = window.webblend; a.setQuality('ultra'); a.setQuality('high'); a.setQuality('potato'); a.setQuality('medium'); });
  await page.waitForTimeout(800);
  ok('quality switching works', await page.evaluate(() => window.webblend.settings.get('quality') === 'medium'));

  // 10. timeline interactions: click on canvas ruler scrubs
  const tl = await page.$('#tl-canvas');
  const box = await tl.boundingBox();
  await page.evaluate(() => { const a = window.webblend; const m = a.models[0]; a.select(m.root, m); a.pause(); });
  await page.mouse.click(box.x + box.width * 0.6, box.y + 10);
  const t = await page.evaluate(() => window.webblend.transport.time);
  ok('clicking the timeline ruler scrubs', t > 0.05, 't=' + t.toFixed(3));

  ok('no console errors', errors.length === 0, errors.slice(0, 8).join('\n   '));
  await browser.close();
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL E2E OK');
  process.exit(fails ? 1 : 0);
})();
