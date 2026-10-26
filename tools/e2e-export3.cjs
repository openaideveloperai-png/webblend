const { chromium } = require('playwright');
const path = require('path');
const [,, A] = process.argv;
const T = path.join(A, '..', 'testfiles');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('console.' + m.type() + ': ' + m.text().slice(0, 300)); });
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1500);
  await page.click('.menu-btn:has-text("File")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dd-item:has-text("Open files")')]);
  await chooser.setFiles([path.join(A, 'hero.glb'), path.join(A, 'monkey_textured.zip'), path.join(A, 'hero.fbx'), path.join(T, 'multi_5.2.3_z.blend'), path.join(T, 'rig_4.2.23.blend'), path.join(T, 'mirror_5.2.3.blend')]);
  await page.waitForFunction(() => !document.querySelector('.toast.busy'), null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const r = await page.evaluate(async () => {
    const a = window.webblend;
    const t0 = performance.now();
    const res = await Promise.race([
      new Promise((resolve) => { const orig = a.toast; a.toast = (msg, type) => { if (/Downloaded|failed/.test(msg)) { a.toast = orig; resolve(type + ': ' + msg); } return orig.call(a, msg, type); }; window.__exportGLB(a, a.models, 'all'); }),
      new Promise((resolve) => setTimeout(() => resolve('HANG'), 40000)),
    ]);
    return res + ' in ' + Math.round(performance.now() - t0) + 'ms; models after: ' + a.models.map((m) => m.root.parent && m.root.parent.name).join(',');
  });
  console.log(r);
  await browser.close();
})();
