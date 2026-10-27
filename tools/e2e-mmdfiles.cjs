// Real MMD files: .pmx / .pmd models with textures, .vmd motions (by bone
// name and retargeted onto a non-MMD character).
// Usage: node tools/e2e-mmdfiles.cjs <pmxDir> <pmdDir> <dance.vmd> <outDir>
//   pmxDir: a .pmx and its textures; pmdDir: a .pmd and its textures
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const [,, PMX, PMD, VMD, OUT] = process.argv;
let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };
const filesIn = (d) => fs.readdirSync(d).filter((f) => !f.startsWith('.') && fs.statSync(path.join(d, f)).isFile() && f !== 'COPY_PMX_SAMPLES.HERE').map((f) => path.join(d, f));

async function open(page, files) {
  await page.click('.menu-btn:has-text("File")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dd-item:has-text("Open files")')]);
  // in-memory files: the headless browser can't open non-ASCII paths from disk in some locales
  await chooser.setFiles(files.map((f) => ({ name: path.basename(f), mimeType: 'application/octet-stream', buffer: fs.readFileSync(f) })));
  await page.waitForFunction(() => !document.querySelector('.toast.busy'), null, { timeout: 90000 });
  await page.waitForTimeout(800);
  return page.evaluate(() => { const m = document.querySelector('.modal-back'); if (!m) return null; const t = [...m.querySelectorAll('li')].map((l) => l.textContent); m.remove(); return t; });
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1500);

  // ---- PMX with textures
  const pmxFiles = filesIn(PMX).filter((f) => !/\.pmx$/i.test(f) || f === filesIn(PMX).find((x) => /\.pmx$/i.test(x)));
  const notes1 = await open(page, pmxFiles);
  const pmx = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0];
    let maps = 0, mats = 0, sk = null;
    m.root.traverse((o) => { if (o.isSkinnedMesh) { sk = o; for (const mt of [].concat(o.material)) { mats++; if (mt.map) maps++; } } });
    return { name: m.name, humanoid: !!m.humanoid, joints: m.joints ? m.joints.bones.length : 0, bones: m.bones.length, constraints: m.constraints ? m.constraints.count : 0, maps, mats, morphs: sk && sk.morphTargetInfluences ? sk.morphTargetInfluences.length : 0, height: +m.height.toFixed(2) };
  });
  ok('PMX model loads as a humanoid with IK', pmx.humanoid && pmx.constraints >= 4 && pmx.bones > 50, JSON.stringify(pmx));
  ok('PMX is about 1.6 m tall (MMD units converted)', pmx.height > 1.3 && pmx.height < 2.0, pmx.height);
  ok('PMX textures found', pmx.maps >= 1, `${pmx.maps}/${pmx.mats} materials textured; notes ${JSON.stringify(notes1)}`);
  ok('PMX facial morphs', pmx.morphs >= 5, pmx.morphs);

  // ---- PMD + VMD by bone name, with IK
  await page.evaluate(() => window.webblend.clearScene());
  await open(page, filesIn(PMD));
  await page.evaluate(() => { const a = window.webblend; a.select(a.models[0].root, a.models[0]); });
  await open(page, [VMD]);
  const pmd = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0];
    const e = m.clips.find((c) => c.playing) || m.clips[0];
    if (!e) return { clips: 0 };
    a.setTime(Math.min(30, e.clip.duration * 0.3)); a.tick(0);
    const ankle = m.root.getObjectByName('左足首'), ik = m.root.getObjectByName('左足ＩＫ');
    const dist = ankle && ik ? ankle.getWorldPosition(ankle.position.clone()).distanceTo(ik.getWorldPosition(ik.position.clone())) : -1;
    return { models: a.models.length, clips: m.clips.length, name: e.clip.name, dur: +e.clip.duration.toFixed(1), tracks: e.clip.tracks.length, dist, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent).slice(-2) };
  });
  ok('VMD dance added to the PMD model by bone name', pmd.models === 1 && pmd.clips >= 1 && pmd.tracks > 50, JSON.stringify(pmd));
  ok('feet follow the leg IK handles while dancing', pmd.dist >= 0 && pmd.dist < 0.002, `${(pmd.dist * 100).toFixed(2)} cm`);
  await page.evaluate(() => window.webblend.viewport.frameAll());
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'e2e-pmd-dance.png') });

  // save + reopen keeps the dance
  await page.click('.menu-btn:has-text("File")');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 90000 }), page.click('.dd-item:has-text("Save scene")')]);
  const glbPath = path.join(OUT, 'pmd-dance.glb');
  await dl.saveAs(glbPath);
  await page.evaluate(() => window.webblend.clearScene());
  await open(page, [glbPath]);
  const re = await page.evaluate(() => window.webblend.models.map((m) => ({ name: m.name, clips: m.clips.length, humanoid: !!m.humanoid })));
  ok('saved scene reopens with the dance', re.length === 1 && re[0].clips >= 1 && re[0].humanoid, JSON.stringify(re));

  // ---- VMD retargeted onto a non-MMD character (the demo mannequin)
  await page.evaluate(() => { const a = window.webblend; a.clearScene(); a.addMannequin(); });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const a = window.webblend; const m = a.models[0]; for (const e of m.clips) m.setPlaying(e, false); a.select(m.root, m); });
  await open(page, [VMD]);
  const rt = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0];
    const e = m.clips.find((c) => c.playing);
    if (!e) return null;
    const h = m.humanoid;
    const knee = h.map.leftLowerLeg, arm = h.map.leftUpperArm;
    const ang = [];
    for (const f of [0.1, 0.3, 0.5, 0.7]) { a.setTime(e.clip.duration * f); a.tick(0); ang.push([knee.quaternion.angleTo(h.rest.get(knee).Lq), arm.quaternion.angleTo(h.rest.get(arm).Lq)]); }
    return { name: e.clip.name, how: e.how, ang: ang.map((x) => x.map((v) => +v.toFixed(2))), toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).slice(-1)[0] };
  });
  ok('VMD retargets onto a non-MMD humanoid', rt && rt.ang.some(([k, a2]) => a2 > 0.2) && rt.ang.some(([k]) => k > 0.1), JSON.stringify(rt));
  await page.screenshot({ path: path.join(OUT, 'e2e-vmd-retarget.png') });

  ok('no console errors', errors.length === 0, errors.slice(0, 6).join('\n   '));
  await browser.close();
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL MMD FILE TESTS OK');
  process.exit(fails ? 1 : 0);
})();
