const { chromium } = require('playwright');
const path = require('path');
const [,, A] = process.argv;
const T = path.join(A, '..', 'testfiles');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console.' + m.type() + ': ' + m.text().slice(0, 200)); });
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1500);
  await page.click('.menu-btn:has-text("File")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dd-item:has-text("Open files")')]);
  await chooser.setFiles([path.join(A, 'hero.glb'), path.join(A, 'monkey_textured.zip'), path.join(A, 'hero.fbx'), path.join(T, 'multi_5.2.3_z.blend'), path.join(T, 'rig_4.2.23.blend'), path.join(T, 'mirror_5.2.3.blend')]);
  await page.waitForFunction(() => !document.querySelector('.toast.busy'), null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const names = await page.evaluate(() => window.webblend.models.map((m) => m.name));
  for (let i = 0; i < names.length; i++) {
    const r = await page.evaluate(async (i) => {
      const a = window.webblend;
      const m = a.models[i];
      const res = await Promise.race([
        new Promise((resolve) => { const orig = a.toast; a.toast = (msg, type) => { a.toast = orig; resolve(type + ': ' + msg); return orig.call(a, msg, type); }; window.__exportGLB(a, [m], 'x' + i); }),
        new Promise((resolve) => setTimeout(() => resolve('HANG'), 15000)),
      ]);
      return m.name + ' -> ' + res;
    }, i);
    console.log(r);
  }
  await browser.close();
})();
