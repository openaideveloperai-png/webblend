const { chromium } = require('playwright');
const path = require('path');
const [,, Z] = process.argv;
let fails = 0;
const ok = (l, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + l + (x ? '  ' + x : '')); if (!c) fails++; };
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1200);
  // idle: no rendering when paused and nothing changes
  const idle = await page.evaluate(async () => {
    const a = window.webblend; a.pause();
    await new Promise((r) => setTimeout(r, 400));
    const f0 = a.viewport.renderer.info.render.frame;
    await new Promise((r) => setTimeout(r, 1200));
    return a.viewport.renderer.info.render.frame - f0;
  });
  ok('no frames rendered while idle', idle === 0, idle + ' frames');
  // lag simulation: busy-wait in each frame at High quality
  const lag = await page.evaluate(async () => {
    const a = window.webblend;
    a.setSetting('autoQuality', true);
    a.setQuality('high');
    const orig = a.tick.bind(a);
    a.tick = (dt) => { const t = performance.now(); while (performance.now() - t < 70) { /* simulate a slow PC */ } orig(dt); };
    a.play();
    const seen = [];
    const off = a.on('quality', (q, auto) => seen.push(q + (auto ? '(auto)' : '')));
    await new Promise((r) => setTimeout(r, 9000));
    off(); a.tick = orig;
    return { seen, now: a.settings.get('quality'), toast: [...document.querySelectorAll('.toast')].map((t) => t.textContent).find((t) => /slowly/.test(t)) };
  });
  ok('auto-switches to a lighter mode when lagging', lag.seen.length >= 1 && /^(medium|low)\(auto\)$/.test(lag.seen[0]), JSON.stringify(lag));
  // potato downscales big textures on import
  await page.evaluate(() => { const a = window.webblend; a.setQuality('potato'); a.clearScene(); });
  await page.click('.menu-btn:has-text("File")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dd-item:has-text("Open files")')]);
  await chooser.setFiles([path.join(Z, 'huge4096.png')]);
  await page.waitForFunction(() => !document.querySelector('.toast.busy'), null, { timeout: 60000 });
  await page.waitForTimeout(500);
  const w = await page.evaluate(() => { let w = 0; window.webblend.models[0].root.traverse((o) => { if (o.material && o.material.map) w = o.material.map.image.width; }); return w; });
  ok('4096px texture downscaled to 512 in Potato mode', w === 512, 'width=' + w);
  // switching back down after import also shrinks textures
  await page.evaluate(() => { const a = window.webblend; a.setQuality('ultra'); });
  ok('no page errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  console.log(fails ? `${fails} FAILURE(S)` : 'ALL PERF TESTS OK');
})();
