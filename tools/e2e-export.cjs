const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ acceptDownloads: true });
  const page = await ctx.newPage();
  page.on('console', (m) => console.log('console.' + m.type() + ': ' + m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
  page.on('download', (d) => console.log('DOWNLOAD', d.suggestedFilename()));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1500);
  const r = await page.evaluate(async () => {
    const a = window.webblend;
    const t0 = performance.now();
    try {
      const { GLTFExporter } = {};
      const mod = a.models[0];
      // call the same path as the menu
      const res = await new Promise((resolve) => {
        const orig = a.toast;
        a.toast = (m, type) => { resolve({ toast: m, type }); return orig.call(a, m, type); };
        window.__exportGLB(a, a.models, 'x');
        setTimeout(() => resolve({ timeout: true }), 30000);
      });
      return { ...res, ms: performance.now() - t0 };
    } catch (e) { return { err: e.message }; }
  });
  console.log(JSON.stringify(r));
  await page.waitForTimeout(1000);
  await browser.close();
})();
