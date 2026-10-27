// Diagnostic: open files in the app and dump what came in. Usage: node tools/probe-mmd.cjs <outDir> <files...>
const { chromium } = require('playwright');
const path = require('path');
const [,, OUT, ...FILES] = process.argv;
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1500);
  await page.click('.menu-btn:has-text("File")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dd-item:has-text("Open files")')]);
  await chooser.setFiles(FILES);
  await page.waitForFunction(() => !document.querySelector('.toast.busy'), null, { timeout: 60000 });
  await page.waitForTimeout(1000);
  const notes = await page.evaluate(() => { const m = document.querySelector('.modal-back'); if (!m) return null; const t = m.innerText; m.remove(); return t; });
  console.log('NOTES:', notes);
  console.log('TOASTS:', await page.evaluate(() => [...document.querySelectorAll('.toast')].map((t) => t.textContent)));
  const info = await page.evaluate(() => {
    const a = window.webblend;
    return a.models.map((m) => {
      const mats = [];
      const vis = [], hidden = [];
      m.root.traverse((o) => {
        let v = true; for (let p = o; p; p = p.parent) if (!p.visible) v = false;
        (v ? vis : hidden).push(o.name + (o.isMesh ? '[mesh]' : o.isBone ? '[bone]' : ''));
        if (o.isMesh) for (const mt of [].concat(o.material)) mats.push({ name: mt.name, map: mt.map ? (mt.map.name || 'tex') + ' ' + (mt.map.image ? (mt.map.image.width + 'x' + mt.map.image.height) : (mt.map.mipmaps ? 'mips' : 'noimg')) : null, side: mt.side, transparent: mt.transparent, alphaTest: mt.alphaTest, color: mt.color && mt.color.getHexString() });
      });
      const h = m.humanoid;
      return { name: m.name, bones: m.bones.length, joints: m.joints ? m.joints.bones.length : 0, clips: m.clips.map((c) => c.clip.name + '/' + c.clip.tracks.length), humanoid: h ? Object.fromEntries(Object.entries(h.map).filter(([, b]) => b).map(([k, b]) => [k, b.name])) : null, mats, visible: vis.filter((n) => !n.endsWith('[bone]')).slice(0, 40), hidden: hidden.filter((n) => !n.endsWith('[bone]')).slice(0, 40) };
    });
  });
  console.log(JSON.stringify(info, null, 1));
  await page.evaluate(() => { const a = window.webblend; a.setQuality('high'); const m = a.models[0]; a.viewport.frameObject(m.root); });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'probe.png') });
  console.log('ERRORS:', errors.slice(0, 20));
  await browser.close();
})();
