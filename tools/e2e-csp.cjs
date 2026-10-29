// Serve dist/artifact.html wrapped like the artifact host, under a strict CSP.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const [,, Z, wasmMode] = process.argv;
const frag = fs.readFileSync(path.resolve(__dirname, '../dist/artifact.html'), 'utf8');
const page = `<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;padding-top:env(safe-area-inset-top);padding-bottom:env(safe-area-inset-bottom)}body{margin:0;font:14px system-ui}img{max-width:100%}[hidden]{display:none!important}</style></head><body>${frag}</body></html>`;
const csp = [
  "default-src 'none'",
  `script-src 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com${wasmMode === 'wasm' ? " 'wasm-unsafe-eval'" : ''}`,
  "style-src 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  'img-src data: blob:',
  'media-src data: blob:',
  'connect-src blob: data:',
  'worker-src blob:',
].join('; ');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const pg = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 220)); });
  pg.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await pg.route('https://artifact.test/**', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/html', 'content-security-policy': csp }, body: page }));
  await pg.goto('https://artifact.test/');
  await pg.waitForTimeout(2500);
  const s1 = await pg.evaluate(() => ({ models: window.webblend ? window.webblend.models.length : -1, frames: window.webblend ? window.webblend.viewport.renderer.info.render.frame : 0 }));
  console.log('boot', JSON.stringify(s1));
  for (const f of ['donut_draco.glb', 'gltf_separate.zip', 'fbx_textured.zip']) {
    await pg.click('.menu-btn:has-text("File")');
    const [chooser] = await Promise.all([pg.waitForEvent('filechooser'), pg.click('.dd-item:has-text("Open files")')]);
    await chooser.setFiles([path.join(Z, f)]);
    await pg.waitForFunction(() => !document.querySelector('.toast.busy'), null, { timeout: 60000 });
    await pg.waitForTimeout(600);
    const r = await pg.evaluate(() => { const ms = window.webblend.models; const m = ms[ms.length - 1]; let meshes = 0, maps = 0; m && m.root.traverse((o) => { if (o.isMesh) { meshes++; if (o.material && o.material.map) maps++; } }); return { name: m && m.name, meshes, maps, toasts: [...document.querySelectorAll('.toast.warn,.toast.error')].map((t) => t.textContent) }; });
    console.log(f.padEnd(18), JSON.stringify(r));
  }
  // the console runs code even where the page may not eval (it falls back to an inline script)
  await pg.click('#btn-settings');
  await pg.waitForTimeout(150);
  await pg.evaluate(() => document.activeElement && document.activeElement.blur());
  for (const k of ['8', '8', '8', '8', 'x']) await pg.keyboard.press(k);
  await pg.waitForTimeout(150);
  let out = 'no console';
  if (await pg.isVisible('.con-in')) {
    await pg.fill('.con-in', 'const a = 2\na * 21');
    await pg.press('.con-in', 'Control+Enter');
    await pg.waitForTimeout(150);
    out = await pg.evaluate(() => [...document.querySelectorAll('.con-line')].slice(-1)[0]?.textContent || '');
  }
  console.log((out === '42' ? 'ok   ' : 'FAIL ') + 'console runs code under the artifact CSP  ' + out);
  // the eval attempt itself is reported by the browser; that one is expected
  const rest = errors.filter((e) => !/unsafe-eval|evaluate a string as JavaScript|EvalError/i.test(e));
  errors.length = 0; errors.push(...rest);
  console.log('errors:', errors.length ? errors.slice(0, 6) : 'none');
  await browser.close();
})();
