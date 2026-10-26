// Import each test file into a fresh scene and report what loaded.
const { chromium } = require('playwright');
const path = require('path');
const [,, Z, OUT] = process.argv;
const cases = [
  ['donut_draco.glb', { mesh: true, map: true, clip: true }],
  ['hero_meshopt.glb', { mesh: true, clip: true, bones: true }],
  ['gltf_separate.zip', { mesh: true, map: true, clip: true }],
  ['donut.stl', { mesh: true }],
  ['donut.ply', { mesh: true }],
  ['donut.usdz', { mesh: true }],
  ['donut.dae', { mesh: true }],
  ['fbx_textured.zip', { mesh: true, map: true }],
  ['pink.png', { mesh: true, map: true }],
  ['star.svg', { mesh: true }],
  ['wave.bvh', { bones: true, clip: true }],
];
let fails = 0;
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1200);
  for (const [file, exp] of cases) {
    errors.length = 0;
    await page.evaluate(() => window.webblend.clearScene());
    await page.click('.menu-btn:has-text("File")');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dd-item:has-text("Open files")')]);
    await chooser.setFiles([path.join(Z, file)]);
    await page.waitForFunction(() => !document.querySelector('.toast.busy'), null, { timeout: 60000 });
    await page.waitForTimeout(700);
    const notes = await page.evaluate(() => { const m = document.querySelector('.modal-back'); const t = m ? [...m.querySelectorAll('li')].map((l) => l.textContent) : []; if (m) m.remove(); return t; });
    const toasts = await page.evaluate(() => [...document.querySelectorAll('.toast.warn, .toast.error')].map((t) => t.textContent));
    const r = await page.evaluate(() => {
      const a = window.webblend;
      let meshes = 0, maps = 0, bones = 0;
      for (const m of a.models) m.root.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) { meshes++; const mats = Array.isArray(o.material) ? o.material : [o.material]; if (mats.some((x) => x && x.map && x.map.image && (x.map.image.width || 0) > 1)) maps++; } if (o.isBone) bones++; });
      return { models: a.models.length, meshes, maps, bones, clips: a.models.reduce((n, m) => n + m.clips.length, 0), size: a.models[0] ? +a.models[0].size.toFixed(2) : 0 };
    });
    const good = r.models >= 1 && (!exp.mesh || r.meshes > 0) && (!exp.map || r.maps > 0) && (!exp.clip || r.clips > 0) && (!exp.bones || r.bones > 0) && !errors.length;
    if (!good) fails++;
    console.log((good ? 'ok   ' : 'FAIL ') + file.padEnd(20) + JSON.stringify(r) + (notes.length ? ' notes=' + JSON.stringify(notes) : '') + (toasts.length ? ' warn=' + JSON.stringify(toasts) : '') + (errors.length ? ' errors=' + JSON.stringify(errors.slice(0, 3)) : ''));
  }
  // everything at once
  await page.evaluate(() => window.webblend.clearScene());
  await page.click('.menu-btn:has-text("File")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dd-item:has-text("Open files")')]);
  await chooser.setFiles(cases.map(([f]) => path.join(Z, f)).filter((f) => !f.endsWith('.png')));
  await page.waitForFunction(() => !document.querySelector('.toast.busy'), null, { timeout: 90000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => { document.querySelector('.modal-back')?.remove(); const a = window.webblend; let x = 0; for (const m of a.models) { m.root.position.x += x; x += m.size * 1.2 + 0.5; m.root.updateMatrixWorld(true); } a.viewport.frameAll(); a.setQuality('medium'); });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, 'formats.png') });
  await browser.close();
  console.log(fails ? `${fails} FAILURE(S)` : 'ALL FORMATS OK');
})();
