// Export for other apps: FBX through the export dialog, read back by three's FBX loader
// (and by Blender when a bpy Python is given). Usage: node tools/e2e-export.cjs <outDir> [bpyPython]
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const [,, OUT, BPY] = process.argv;
let fails = 0;
const ok = (l, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + l + (x ? '  ' + x : '')); if (!c) fails++; };
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true })).newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1200);
  // the mannequin walks holding a pistol; remember where some bones are mid-walk
  const truth = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0];
    for (const e of [...m.clips]) m.removeClip(e);
    a.select(m.root, m);
    for (const p of ['make a gun', 'walk']) { const r = a.ai.runOffline(p); for (const res of r.results) a.addClipToModel(res.model, res.clip, { loop: true }); }
    a.pause();
    const walk = m.clips.find((c) => /walk/i.test(c.clip.name));
    m.switchClip(walk);
    const samples = {};
    for (const t of [0, 0.3, 0.5, 0.8]) {
      a.setTime(t); a.tick(0);
      samples[t] = {};
      for (const k of ['leftFoot', 'rightHand', 'head', 'hips']) { const b = m.humanoid.map[k]; samples[t][b.name] = b.getWorldPosition(new b.position.constructor()).toArray(); }
    }
    const f = m.humanoid.map.leftFoot;
    return { samples, clips: m.clips.map((c) => [c.clip.name, c.clip.duration]), bones: m.bones.length, footNow: f.getWorldPosition(new f.position.constructor()).toArray() };
  });
  fs.writeFileSync(path.join(OUT, 'truth.json'), JSON.stringify(truth));
  const exportVia = async (platform, tweak) => {
    await page.click('.menu-btn:has-text("File")');
    await page.click('.dd-item:has-text("Export for Roblox")');
    await page.click(`[data-platform="${platform}"]`);
    if (tweak) await tweak();
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#ex-go')]);
    const file = path.join(OUT, `${platform}-${dl.suggestedFilename()}`);
    await dl.saveAs(file);
    await page.waitForSelector('.export-status[data-done="1"]', { timeout: 30000 });
    const status = await page.textContent('.export-status');
    await page.click('.modal-h .ibtn');
    return { file, status };
  };
  const unity = await exportVia('unity');
  const head = fs.readFileSync(unity.file).subarray(0, 27).toString('latin1');
  ok('Unity: one binary FBX 7.4 with meshes, bones and both clips', /^Kaydara FBX Binary/.test(head) && fs.readFileSync(unity.file).readUInt32LE(23) === 7400 && /27 bones/.test(unity.status) && /2 animations/.test(unity.status), unity.status);
  const kept = await page.evaluate((want) => { const m = window.webblend.models[0]; const f = m.humanoid.map.leftFoot; m.root.updateMatrixWorld(true); const p = f.getWorldPosition(new f.position.constructor()).toArray(); return p.every((v, i) => Math.abs(v - want[i]) < 1e-6); }, truth.footNow);
  ok('exporting leaves the scene exactly as it was', kept);
  const unreal = await exportVia('unreal');
  const roblox = await exportVia('roblox');
  const { unzipSync } = await import('fflate').catch(() => ({}));
  let names = [];
  if (unzipSync) names = Object.keys(unzipSync(fs.readFileSync(roblox.file)));
  else names = execFileSync('unzip', ['-Z1', roblox.file]).toString().trim().split('\n');
  ok('Roblox: model file plus one animation file per clip, zipped', /\.zip$/.test(roblox.file) && names.length === 3 && names.includes('Mannequin.fbx') && names.some((n) => /Walk\.fbx$/.test(n)), names.join(', '));
  ok('Roblox: colors baked into textures', /[1-9]\d* textures/.test(roblox.status), roblox.status);

  // read the Unity file back with three's FBX loader (a fresh page, through Open files)
  const page2 = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  page2.on('pageerror', (e) => errors.push(e.message));
  await page2.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page2.waitForTimeout(1000);
  await page2.evaluate(() => window.webblend.clearScene());
  await page2.click('.menu-btn:has-text("File")');
  const [chooser] = await Promise.all([page2.waitForEvent('filechooser'), page2.click('.dd-item:has-text("Open files")')]);
  await chooser.setFiles(unity.file);
  await page2.waitForFunction(() => window.webblend.models.length > 0, null, { timeout: 30000 });
  await page2.waitForTimeout(800);
  const back = await page2.evaluate(() => {
    const m = window.webblend.models[0];
    let meshes = 0, skinned = 0, tris = 0;
    m.root.traverse((o) => { if (o.isMesh) { meshes++; if (o.isSkinnedMesh) skinned++; tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; } });
    const size = m.size;
    return { meshes, skinned, tris, bones: m.bones.length, clips: m.clips.map((c) => [c.clip.name, +c.clip.duration.toFixed(2)]), humanoid: !!m.humanoid, size };
  });
  ok('three.js reads it back: meshes, skin, bones, humanoid', back.meshes === 14 && back.skinned >= 1 && back.bones >= 27 && back.humanoid, JSON.stringify(back));
  ok('three.js reads it back: both clips with their lengths', back.clips.length === 2 && truth.clips.every(([n, d]) => back.clips.some(([bn, bd]) => bn.includes(n) && Math.abs(bd - d) < 0.05)), JSON.stringify(back.clips));
  ok('real-world size survives (meters)', back.size > 1.2 && back.size < 2.6, back.size.toFixed(2));
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();

  if (BPY && fs.existsSync(BPY)) {
    const rep = path.join(OUT, 'blender.json');
    execFileSync(BPY, ['-I', '-c', `import sys; sys.argv=['x','--',${JSON.stringify(unity.file)},${JSON.stringify(rep)},${JSON.stringify(path.join(OUT, 'truth.json'))}]; exec(open(${JSON.stringify(path.resolve(__dirname, 'blender/fbx_check.py'))}).read())`], { stdio: 'ignore', timeout: 300000 });
    const r = JSON.parse(fs.readFileSync(rep, 'utf8'));
    ok('Blender: 14 meshes, 27-bone armature, skin weights, both actions', r.meshes === 14 && r.armatures[0][1] === 27 && (r.skinned || []).length >= 1 && r.actions.length === 2, JSON.stringify({ m: r.meshes, a: r.armatures, act: r.actions }));
    ok('Blender: bone positions match WebBlend through the walk', r.poseChecks >= 16 && r.poseError < 1e-4, `max error ${(r.poseError * 1000).toFixed(4)} mm over ${r.poseChecks} checks`);
    // the centimeter file (Unreal) lands at the same size once Blender applies its unit
    execFileSync(BPY, ['-I', '-c', `import sys; sys.argv=['x','--',${JSON.stringify(unreal.file)},${JSON.stringify(rep)},${JSON.stringify(path.join(OUT, 'truth.json'))}]; exec(open(${JSON.stringify(path.resolve(__dirname, 'blender/fbx_check.py'))}).read())`], { stdio: 'ignore', timeout: 300000 });
    const r2 = JSON.parse(fs.readFileSync(rep, 'utf8'));
    ok('Blender: the centimeter (Unreal) file matches too', r2.poseChecks >= 16 && r2.poseError < 1e-4, `max error ${(r2.poseError * 1000).toFixed(4)} mm`);
  } else console.log('(no bpy Python given: Blender checks skipped)');
  console.log(fails ? `${fails} FAILED` : 'ALL EXPORT TESTS OK');
  process.exit(fails ? 1 : 0);
})();
