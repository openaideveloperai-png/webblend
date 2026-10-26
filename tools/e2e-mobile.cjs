const { chromium } = require('playwright');
const path = require('path');
const [,, OUT] = process.argv;
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 400, height: 820 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(2500);
  const overflow = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  console.log('overflow', JSON.stringify(overflow));
  await page.screenshot({ path: path.join(OUT, 'mobile-1.png') });
  await page.click('#btn-right');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'mobile-2-inspector.png') });
  console.log('errors', errors.length ? errors : 'none');
  await browser.close();
})();
