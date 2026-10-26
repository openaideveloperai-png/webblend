const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const out = process.argv[2] || '/tmp/shot.png';
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message + '\n' + (e.stack || '').split('\n').slice(0, 4).join('\n')));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(3500);
  await page.screenshot({ path: out });
  const info = await page.evaluate(() => {
    const a = window.webblend;
    if (!a) return 'no app';
    return { models: a.models.map((m) => m.name + ':' + m.clips.length + ':' + (m.humanoid ? 'H' : '-')), quality: a.settings.get('quality'), time: a.transport.time.toFixed(2), playing: a.transport.playing };
  });
  console.log(JSON.stringify(info));
  console.log(errors.slice(0, 30).join('\n'));
  await browser.close();
})();
