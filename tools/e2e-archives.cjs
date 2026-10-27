// Archives: a mod .jar opens like a zip; every model inside is listed (nested jars and
// hidden folders too) and Minecraft formats load: Java item/block models, a GeckoLib
// entity with its animation (Molang included) and a Blockbench model.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
let fails = 0;
const ok = (l, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + l + (x ? '  ' + x : '')); if (!c) fails++; };
const OUT = process.argv[2] || path.join(__dirname, '../out');
fs.mkdirSync(OUT, { recursive: true });

// a tiny PNG encoder (RGBA)
function png(w, h, px) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) raw.set(px(x, y), y * (w * 4 + 1) + 1 + x * 4); }
  const crc = (buf) => { let c, table = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; } let r = 0xffffffff; for (const b of buf) r = table[(r ^ b) & 0xff] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sword = png(16, 16, (x, y) => (Math.abs(x - (15 - y)) <= 1 && x > 2 ? [200, 30, 40, 255] : x < 4 && y > 11 ? [90, 60, 30, 255] : [0, 0, 0, 0]));
const block = png(16, 16, (x, y) => [180 + ((x * 7 + y * 3) % 40), 20, 40, 255]);
const goblinTex = png(64, 64, (x, y) => [60 + x, 140, 60 + y, 255]);
const gltfBox = { asset: { version: '2.0' }, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'Crate' }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
  accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3', min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }, { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' }],
  bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 96 }, { buffer: 0, byteOffset: 96, byteLength: 72 }], buffers: [{ byteLength: 168 }] };
{
  const v = new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 1, -0.5, -0.5, 1, -0.5, -0.5, 0, 0.5, 0.5, 0, 0.5, 0.5, 1, 0.5, -0.5, 1, 0.5]);
  const i = new Uint16Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6, 5, 0, 4, 7, 0, 7, 3]);
  gltfBox.buffers[0].uri = 'data:application/octet-stream;base64,' + Buffer.concat([Buffer.from(v.buffer), Buffer.from(i.buffer)]).toString('base64');
}
const bb = { meta: { format_version: '4.5', model_format: 'free', box_uv: false }, name: 'statue', resolution: { width: 16, height: 16 },
  elements: [{ name: 'body', uuid: 'e1', from: [-4, 0, -4], to: [4, 16, 4], origin: [0, 0, 0], rotation: [0, 0, 0], faces: Object.fromEntries(['north', 'south', 'east', 'west', 'up', 'down'].map((f) => [f, { uv: [0, 0, 16, 16], texture: 0 }])) }],
  outliner: [{ name: 'root', uuid: 'g1', origin: [0, 0, 0], rotation: [0, 0, 0], children: ['e1'] }],
  textures: [{ name: 'stone', source: 'data:image/png;base64,' + block.toString('base64') }],
  animations: [{ name: 'spin', loop: 'loop', length: 2, animators: { g1: { name: 'root', type: 'bone', keyframes: [{ channel: 'rotation', time: 0, data_points: [{ x: 0, y: 0, z: 0 }] }, { channel: 'rotation', time: 2, data_points: [{ x: 0, y: 360, z: 0 }] }] } } }] };
const geo = { format_version: '1.12.0', 'minecraft:geometry': [{ description: { identifier: 'geometry.goblin', texture_width: 64, texture_height: 64 }, bones: [
  { name: 'body', pivot: [0, 12, 0], cubes: [{ origin: [-4, 12, -2], size: [8, 12, 4], uv: [16, 16] }] },
  { name: 'head', parent: 'body', pivot: [0, 24, 0], cubes: [{ origin: [-4, 24, -4], size: [8, 8, 8], uv: [0, 0] }] },
  { name: 'leftArm', parent: 'body', pivot: [5, 22, 0], cubes: [{ origin: [4, 12, -2], size: [4, 12, 4], uv: [40, 16] }] },
  { name: 'rightArm', parent: 'body', pivot: [-5, 22, 0], cubes: [{ origin: [-8, 12, -2], size: [4, 12, 4], uv: [40, 16], mirror: true }] }] }] };
const anim = { format_version: '1.8.0', animations: { 'animation.goblin.walk': { loop: true, animation_length: 1, bones: {
  leftArm: { rotation: { '0.0': [0, 0, 0], '0.5': [-40, 0, 0], '1.0': [0, 0, 0] } },
  head: { rotation: ['math.sin(query.anim_time * 360) * 10', 0, 0] } } } } };

(async () => {
  const { zipSync } = await import('three/examples/jsm/libs/fflate.module.js');
  const u8 = (s) => new TextEncoder().encode(typeof s === 'string' ? s : JSON.stringify(s));
  const inner = zipSync({ 'models/statue.bbmodel': u8(bb) });
  const jar = zipSync({
    'META-INF/MANIFEST.MF': u8('Manifest-Version: 1.0\n'), 'fabric.mod.json': u8({ id: 'testmod', version: '1.0' }),
    'assets/testmod/models/item/ruby_sword.json': u8({ parent: 'item/handheld', textures: { layer0: 'testmod:item/ruby_sword' } }),
    'assets/testmod/textures/item/ruby_sword.png': new Uint8Array(sword),
    'assets/testmod/models/block/ruby_block.json': u8({ parent: 'minecraft:block/cube_all', textures: { all: 'testmod:block/ruby_block' } }),
    'assets/testmod/textures/block/ruby_block.png': new Uint8Array(block),
    'assets/testmod/models/block/lamp.json': u8({ textures: { t: 'testmod:block/ruby_block' }, elements: [{ from: [6, 0, 6], to: [10, 10, 10], faces: { north: { texture: '#t' }, south: { texture: '#t' }, east: { texture: '#t' }, west: { texture: '#t' }, up: { texture: '#t' } } }, { from: [4, 10, 4], to: [12, 14, 12], rotation: { origin: [8, 12, 8], axis: 'y', angle: 22.5 }, faces: { north: { texture: '#t' }, south: { texture: '#t' }, east: { texture: '#t' }, west: { texture: '#t' }, up: { texture: '#t' }, down: { texture: '#t' } } }] }),
    'assets/testmod/blockstates/ruby_block.json': u8({ variants: { '': { model: 'testmod:block/ruby_block' } } }),
    'data/testmod/recipes/ruby.json': u8({ type: 'minecraft:crafting_shaped' }),
    'assets/testmod/geo/goblin.geo.json': u8(geo), 'assets/testmod/textures/entity/goblin.png': new Uint8Array(goblinTex),
    'assets/testmod/animations/goblin.animation.json': u8(anim),
    '.secret/stash/crate.gltf': u8(gltfBox),
    'META-INF/jars/inner.jar': inner,
  });
  const jarPath = path.join(OUT, 'testmod-1.0.jar');
  fs.writeFileSync(jarPath, jar);

  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.webblend.clearScene());
  await page.click('.menu-btn:has-text("File")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dd-item:has-text("Open files")')]);
  await chooser.setFiles(jarPath);
  await page.waitForSelector('.picker-row', { timeout: 20000 });
  const listed = await page.$$eval('.picker-row', (rows) => rows.map((r) => [r.querySelector('.picker-name').textContent, r.querySelector('.picker-kind').textContent, r.title]));
  const names = listed.map((x) => x[0]);
  ok('the .jar opens and every model is listed', listed.length === 6 && ['ruby_sword.json', 'ruby_block.json', 'lamp.json', 'goblin.geo.json', 'crate.gltf', 'statue.bbmodel'].every((n) => names.includes(n)), names.join(', '));
  ok('…including the hidden folder and the jar inside the jar', listed.some((x) => /\.secret\/stash/.test(x[2])) && listed.some((x) => /META-INF\/jars\/inner\/models/.test(x[2])));
  ok('…labelled by kind', listed.find((x) => x[0] === 'goblin.geo.json')[1] === 'Minecraft entity' && listed.find((x) => x[0] === 'ruby_sword.json')[1] === 'Minecraft item' && listed.find((x) => x[0] === 'statue.bbmodel')[1] === 'Blockbench');
  ok('data files (recipes, blockstates, mod info) are not offered as models', !names.some((n) => /recipe|ruby\.json|fabric|blockstate/.test(n)) && listed.filter((x) => x[0] === 'ruby_block.json').length === 1);
  await page.click('button:has-text("Select all shown")');
  await page.click('#picker-open');
  await page.waitForFunction(() => window.webblend.models.length >= 6, null, { timeout: 30000 });
  await page.waitForTimeout(800);
  const st = await page.evaluate(() => {
    const a = window.webblend;
    const by = (n) => a.models.find((m) => m.name.toLowerCase().includes(n));
    const tris = (m) => { let t = 0; m.root.traverse((o) => { if (o.isMesh) t += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; }); return t; };
    const gob = by('goblin'), sw = by('ruby_sword'), bl = by('ruby_block'), lamp = by('lamp'), crate = by('crate'), statue = by('statue');
    let nearest = true; for (const m of [sw, bl, gob]) m && m.root.traverse((o) => { if (o.isMesh && o.material.map && o.material.map.magFilter !== 1003) nearest = false; });
    const walk = gob && gob.clips.find((c) => /walk/.test(c.clip.name));
    // head nods by Molang: 10 degrees at a quarter of the cycle
    let headDeg = null;
    if (walk) {
      const head = gob.root.getObjectByName('head');
      const tr = walk.clip.tracks.find((t) => t.name.startsWith(head.uuid) && /quaternion/.test(t.name));
      const i = Math.round(0.25 * 30);
      const q = { x: tr.values[i * 4], y: tr.values[i * 4 + 1], z: tr.values[i * 4 + 2], w: tr.values[i * 4 + 3] };
      headDeg = 2 * Math.acos(Math.min(1, Math.abs(q.w))) * 180 / Math.PI;
    }
    const xs = a.models.map((m) => m.root.position.x);
    const size = (m) => { const b = new (m.root.position.constructor === Object ? Object : window.webblend.viewport.camera.position.constructor)(); return 0; };
    return {
      count: a.models.length, gob: gob && { bones: gob.bones.length, clips: gob.clips.map((c) => [c.clip.name, +c.clip.duration.toFixed(2)]), tris: tris(gob) },
      sword: sw && tris(sw), block: bl && tris(bl), lamp: lamp && tris(lamp), crate: crate && tris(crate), statue: statue && { tris: tris(statue), clips: statue.clips.map((c) => c.clip.name) },
      nearest, headDeg, spread: new Set(xs.map((x) => x.toFixed(2))).size,
      report: [...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | '),
    };
  });
  ok('GeckoLib entity: bones, its walk animation', st.gob && st.gob.bones >= 4 && st.gob.clips.some(([n, d]) => n === 'walk' && d === 1) && st.gob.tris === 48, JSON.stringify(st.gob));
  ok('…the head nods by its Molang expression (10° at t = 0.25 s)', Math.abs(st.headDeg - 10) < 0.5, st.headDeg && st.headDeg.toFixed(2));
  ok('item sprite extruded a pixel thick', st.sword > 40, st.sword);
  ok('block from cube_all: 6 faces', st.block === 12, st.block);
  ok('custom block model with a rotated element', st.lamp === 22, st.lamp);
  ok('model from the hidden folder', st.crate === 12, st.crate);
  ok('Blockbench model from the nested jar, with its animation', st.statue && st.statue.tris === 12 && st.statue.clips.includes('spin'), JSON.stringify(st.statue));
  ok('pixel-art textures stay crisp', st.nearest);
  ok('models stand side by side', st.spread === st.count, `${st.spread} distinct positions for ${st.count}`);
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(fails ? `${fails} FAILED` : 'ALL ARCHIVE TESTS OK');
  process.exit(fails ? 1 : 0);
})();
