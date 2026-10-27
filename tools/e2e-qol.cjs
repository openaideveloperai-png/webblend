// Quality-of-life: edit an AI effect in Properties (recolor, remove, undo), hide effects,
// turntable view, export dialog remembers the platform.
const { chromium } = require('playwright');
const path = require('path');
let fails = 0;
const ok = (l, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + l + (x ? '  ' + x : '')); if (!c) fails++; };
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1200);
  const made = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0]; for (const e of [...m.clips]) m.removeClip(e);
    a.select(m.root, m);
    const r = a.ai.runOffline('katana slash with a trail and sparks');
    for (const res of r.results) a.addClipToModel(res.model, res.clip, { loop: false });
    a.pause();
    const fx = m.root.getObjectByName('Effects');
    const trail = fx && fx.children.find((g) => /trail/i.test(g.name));
    a.select(trail, m);
    return { msg: r.message, groups: fx ? fx.children.map((g) => g.name) : [] };
  });
  ok('offline: a slash with a trail and sparks', made.groups.length === 2, JSON.stringify(made));
  await page.waitForSelector('.sec-t:has-text("Effect · Slash trail")', { timeout: 5000 });
  ok('selecting an effect shows its editor', await page.isVisible('button:has-text("Remove effect")'));
  // recolor
  await page.evaluate(() => { const i = [...document.querySelectorAll('.field')].find((f) => f.textContent.startsWith('Color')).querySelector('input[type=color]'); i.value = '#ff2a2a'; i.dispatchEvent(new Event('change', { bubbles: true })); });
  const recolored = await page.evaluate(() => { const m = window.webblend.models[0]; const e = m.clips[m.clips.length - 1]; return e.clip.userData.vfx.find((v) => /trail/i.test(v.name)).color; });
  ok('recolor re-bakes the effect', recolored === '#ff2a2a', recolored);
  // hide effects
  const vis = async () => page.evaluate(() => { const a = window.webblend; a.setTime(0.75); a.tick(0); let n = 0; a.models[0].root.traverse((o) => { if (o.userData.vfx && o.visible) n++; }); return n; });
  const before = await vis();
  await page.evaluate(() => window.webblend.setSetting('showEffects', false));
  const hidden = await vis();
  await page.evaluate(() => window.webblend.setSetting('showEffects', true));
  ok('View → hide effects hides them, show brings them back', before > 0 && hidden === 0 && (await vis()) > 0, `${before} / ${hidden}`);
  // remove + undo
  await page.click('button:has-text("Remove effect")');
  const after = await page.evaluate(() => { const m = window.webblend.models[0]; const e = m.clips[m.clips.length - 1]; return e.clip.userData.vfx.map((v) => v.name); });
  await page.evaluate(() => window.webblend.history.undo());
  const undone = await page.evaluate(() => { const m = window.webblend.models[0]; const e = m.clips[m.clips.length - 1]; return e.clip.userData.vfx.map((v) => v.name); });
  ok('remove effect, then undo', after.length === 1 && !after.some((n) => /trail/i.test(n)) && undone.length === 2, JSON.stringify({ after, undone }));
  // turntable
  const cam0 = await page.evaluate(() => window.webblend.viewport.camera.position.toArray());
  await page.evaluate(() => window.webblend.setSetting('autoRotate', true));
  await page.waitForTimeout(700);
  const cam1 = await page.evaluate(() => window.webblend.viewport.camera.position.toArray());
  await page.evaluate(() => window.webblend.setSetting('autoRotate', false));
  ok('turntable orbits the view', Math.hypot(cam1[0] - cam0[0], cam1[2] - cam0[2]) > 0.01, JSON.stringify([cam0, cam1].map((v) => v.map((x) => +x.toFixed(2)))));
  // export dialog remembers the last platform
  await page.click('.menu-btn:has-text("File")');
  await page.click('.dd-item:has-text("Export for Roblox")');
  await page.click('[data-platform="unreal"]');
  await page.click('.modal-h .ibtn');
  await page.click('.menu-btn:has-text("File")');
  await page.click('.dd-item:has-text("Export for Roblox")');
  ok('export dialog opens on the platform used last', (await page.getAttribute('[data-platform="unreal"]', 'aria-pressed')) === 'true');
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL QOL TESTS OK');
  process.exit(fails ? 1 : 0);
})();
