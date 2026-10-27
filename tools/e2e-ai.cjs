// Tests the Claude integrations with mocked responses (no real API calls).
const { chromium } = require('playwright');
const path = require('path');
let fails = 0;
const ok = (l, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + l + (x ? '  ' + x : '')); if (!c) fails++; };
const SPEC = { message: 'A cheerful two-step hop.', clips: [{ name: 'Happy hop', target: 'selected', duration: 1.5, loop: true, preset: 'none', speed: 1, intensity: 1,
  humanoidKeys: [{ t: 0, values: [{ param: 'hipsY', value: 0 }, { param: 'lArmRaise', value: 20 }] }, { t: 0.75, values: [{ param: 'hipsY', value: 0.2 }, { param: 'lArmRaise', value: 150 }, { param: 'rArmRaise', value: 150 }] }, { t: 1.5, values: [{ param: 'hipsY', value: 0 }, { param: 'lArmRaise', value: 20 }] }],
  objectKeys: [], boneKeys: [] }] };

function sse(text) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const half = Math.floor(text.length / 2);
  return ev('message_start', { message: { id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } })
    + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(half) } })
    + ev('content_block_stop', { index: 0 })
    + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 200 } })
    + ev('message_stop', {});
}

// Claude models a custom ray gun, puts it in the mannequin's hand and fires it
const RAYGUN = { message: 'A retro ray gun.', props: [{ name: 'Ray gun', holder: 'selected', hand: 'right', preset: 'custom', style: 'default', kind: 'gun',
  materials: [
    { name: 'chrome', color: '#c9ccd1', metalness: 0.95, roughness: 0.18, emissive: '#000000', emissiveIntensity: 0, opacity: 1, texture: 'brushed' },
    { name: 'grip', color: '#7a2a1a', metalness: 0, roughness: 0.6, emissive: '#000000', emissiveIntensity: 0, opacity: 1, texture: 'wood' },
    { name: 'glow', color: '#5cf2ff', metalness: 0, roughness: 0.3, emissive: '#5cf2ff', emissiveIntensity: 2, opacity: 1, texture: 'glow' }],
  parts: [
    { name: 'body', shape: 'lathe', material: 'chrome', parent: '', pos: [0, 0.02, 0.02], rot: [0, 0, 0], dims: [], axis: 'z', profile: [[0, -0.08], [0.025, -0.075], [0.03, -0.02], [0.018, 0.05], [0.012, 0.11], [0, 0.11]], holes: [], bevel: 0, segments: 28 },
    { name: 'grip', shape: 'extrude', material: 'grip', parent: '', pos: [0, 0, 0], rot: [0, 0, 0], dims: [0.026], axis: 'x', profile: [[-0.01, 0.0], [-0.03, -0.1], [-0.07, -0.1], [-0.06, 0.0]], holes: [], bevel: 0.003, segments: 0 },
    ...[0, 1, 2].map((i) => ({ name: 'coil ' + i, shape: 'torus', material: 'glow', parent: 'body', pos: [0, 0, 0.02 + i * 0.025], rot: [0, 0, 0], dims: [0.022 - i * 0.003, 0.003, 360], axis: 'z', profile: [], holes: [], bevel: 0, segments: 24 })),
    { name: 'trigger', shape: 'box', material: 'chrome', parent: '', pos: [0, -0.02, -0.005], rot: [0, 0, 0], dims: [0.005, 0.02, 0.006], axis: 'y', profile: [], holes: [], bevel: 0.001, segments: 0 }],
  anchors: { grip: [0, -0.05, -0.045], support: [], muzzle: [0, 0.02, 0.135], eject: [], stock: [], sight: [0, 0.05, 0] },
  slide: '', slideTravel: 0, fireRate: 3, caliber: 'none', action: 'semi' }],
  clips: [{ name: 'Ray gun blast', target: 'selected', duration: 2, loop: false, preset: 'none', speed: 1, intensity: 1, humanoidKeys: [], handTouches: [], plantFeet: true, objectKeys: [], boneKeys: [],
    useProp: 'Ray gun', aimKeys: [{ t: 0, weight: 0, yaw: 0, pitch: 0 }, { t: 0.5, weight: 1, yaw: 10, pitch: 0 }, { t: 1.8, weight: 1, yaw: 10, pitch: 0 }], shots: [0.8, 1.2], swings: [] }] };
// Claude decorates a katana (flowers on the blade, a drawing on the guard) and adds loose
// "flower" discs floating around it, which must be dropped
const disc = (i) => ({ name: 'flower disc ' + i, shape: 'cylinder', material: 'gold', parent: '', pos: [0.03, 0.15 + i * 0.12, 0.05], rot: [0, 0, 90], dims: [0.012, 0.012, 0.002], axis: 'x', profile: [], holes: [], bevel: 0, segments: 16, variant: '' });
const KATANA = { message: 'A katana with gold flowers.', props: [{ name: 'Flower katana', holder: 'selected', hand: 'right', preset: 'katana', style: 'default', kind: 'melee', materials: [],
  parts: [disc(0), disc(1), disc(2), { name: 'tassel ring', shape: 'torus', material: 'gold', parent: '', pos: [0, -0.29, 0], rot: [0, 0, 0], dims: [0.006, 0.0015, 360], axis: 'x', profile: [], holes: [], bevel: 0, segments: 12, variant: '' }],
  decorations: [{ material: 'blade', pattern: 'hamon+flowers', patternColor: '#e9c25a', mapping: 'fit', svg: '', engrave: false },
    { material: 'guard', pattern: 'none', patternColor: '', mapping: 'fit', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 100"><path d="M10 50 Q100 0 200 50 T390 50" stroke="#ffd700" stroke-width="12" fill="none"/><text x="200" y="90" font-size="30" fill="#fff">花</text><script>alert(1)</script></svg>', engrave: false }],
  anchors: { grip: [], support: [], muzzle: [], eject: [], stock: [], sight: [] }, slide: '', slideTravel: 0, fireRate: 0, caliber: 'none', action: 'none' }],
  clips: [{ name: 'Katana slash', target: 'selected', duration: 2.4, loop: false, preset: 'none', speed: 1, intensity: 1, humanoidKeys: [], handTouches: [], plantFeet: true, objectKeys: [], boneKeys: [],
    useProp: 'Flower katana', aimKeys: [{ t: 0, weight: 0, yaw: 0, pitch: 0 }, { t: 0.4, weight: 1, yaw: 0, pitch: 0 }], shots: [], swings: [{ t: 0.6, back: false }, { t: 1.4, back: true }] }] };
const PNG1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  // ---------------- Claude makes a model (API key, with web research and an image)
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    const calls = [];
    await page.route('https://api.anthropic.com/**', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      calls.push(body);
      if ((body.tools || []).some((t) => /^web_search/.test(t.type))) {
        // research round: plain JSON message
        await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ id: 'msg_r', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'text', text: '- Retro ray guns: ~25 cm long, bulbous chrome body, glowing rings, wooden grip.' }] }) });
        return;
      }
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(JSON.stringify(RAYGUN)) });
    });
    await page.goto('file://' + path.resolve(__dirname, '../index.html'));
    await page.waitForTimeout(1200);
    await page.evaluate(() => { const a = window.webblend; a.settings.setApiKey('sk-ant-test-key', false); a.emit('settings', 'apiKey'); const m = a.models[0]; for (const e of [...m.clips]) m.removeClip(e); a.select(m.root, m); });
    await page.click('#btn-ai');
    await page.setInputFiles('#ai-image-input', { name: 'ref.png', mimeType: 'image/png', buffer: PNG1 });
    const thumbs = await page.$$eval('.ai-input .ai-thumb', (t) => t.length);
    ok('image attached shows a thumbnail', thumbs === 1, thumbs);
    await page.fill('#ai-prompt', 'make a retro ray gun like in the picture and shoot it twice');
    await page.press('#ai-prompt', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.msg .thinking'), null, { timeout: 30000 });
    await page.waitForTimeout(300);
    const research = calls.find((b) => (b.tools || []).some((t) => /^web_search/.test(t.type)));
    const main = calls.find((b) => b.output_config && b.output_config.format);
    ok('web research ran first with the web search tool', !!research && research.tools[0].type === 'web_search_20260209' && calls.indexOf(research) < calls.indexOf(main), research && JSON.stringify(research.tools));
    const mainContent = main && main.messages[0].content;
    ok('image sent to Claude as a base64 image block', Array.isArray(mainContent) && mainContent[0].type === 'image' && mainContent[0].source.media_type === 'image/jpeg' && mainContent[0].source.data.length > 50);
    const text = Array.isArray(mainContent) ? mainContent.find((c) => c.type === 'text').text : String(mainContent);
    ok('research notes and image note in the instructions', /WEB RESEARCH/.test(text) && /reference image/.test(text) && /PROPS/.test(text));
    ok('schema asks for props', main && main.output_config.format.schema.properties.props && main.output_config.format.schema.required.includes('props'));
    const st = await page.evaluate(() => {
      const a = window.webblend; const m = a.models[0];
      const gun = m.root.getObjectByName('Ray gun');
      const e = m.clips.find((c) => c.clip.name === 'Ray gun blast');
      let meshes = 0; if (gun) gun.traverse((o) => { if (o.isMesh) meshes++; });
      const names = e ? new Set(e.clip.tracks.map((t) => (m.root.getObjectByProperty('uuid', t.name.split('.')[0]) || {}).name)) : new Set();
      return { gun: !!gun, parent: gun && gun.parent && gun.parent.name, hand: m.humanoid.map.rightHand.name, meshes, clip: !!e, flash: names.has('Muzzle flash'), tracer: [...names].some((n) => /^Tracer/.test(n || '')), msg: [...document.querySelectorAll('.msg.bot')].pop().textContent };
    });
    ok('custom prop built and put in the right hand', st.gun && st.parent === st.hand && st.meshes >= 3, JSON.stringify({ parent: st.parent, meshes: st.meshes }));
    ok('clip uses the prop: muzzle flash and tracers', st.clip && st.flash && st.tracer, JSON.stringify(st));
    ok('message says what was made', /Ray gun/.test(st.msg) && /hand/.test(st.msg), st.msg.slice(0, 120));
    // the follow-up remembers this request
    await page.fill('#ai-prompt', 'now make it shoot faster and more times please');
    await page.press('#ai-prompt', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.msg .thinking'), null, { timeout: 30000 });
    const last = calls[calls.length - 1];
    const lastText = Array.isArray(last.messages[0].content) ? last.messages[0].content.find((c) => c.type === 'text').text : last.messages[0].content;
    ok('follow-up includes the earlier request', /EARLIER IN THIS SESSION/.test(lastText) && /ray gun/i.test(lastText) && /holding: "Ray gun"/.test(lastText));
    // removing from the log takes the prop away too
    await page.evaluate(() => [...document.querySelectorAll('.msg-actions')].pop().querySelector('button.ghost').click());
    const gone = await page.evaluate(() => !window.webblend.models[0].root.getObjectByName('Ray gun') && !window.webblend.models[0].clips.some((c) => /Ray gun blast/.test(c.clip.name)));
    ok('Remove takes away the clip and the prop', gone);
    ok('no page errors (props)', errors.length === 0, errors.slice(0, 4).join(' | '));
    await page.close();
  }
  // ---------------- Claude decorates a built-in model
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('dialog', (d) => { errors.push('dialog: ' + d.message()); d.dismiss(); });
    let main = null;
    await page.route('https://api.anthropic.com/**', async (route) => {
      const body = JSON.parse(route.request().postData() || '{}');
      if ((body.tools || []).some((t) => /^web_search/.test(t.type))) {
        await route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ id: 'msg_r', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 5 }, content: [{ type: 'text', text: '- notes' }] }) });
        return;
      }
      main = body;
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(JSON.stringify(KATANA)) });
    });
    await page.goto('file://' + path.resolve(__dirname, '../index.html'));
    await page.waitForTimeout(1200);
    await page.evaluate(() => { const a = window.webblend; a.settings.setApiKey('sk-ant-test-key', false); a.emit('settings', 'apiKey'); const m = a.models[0]; for (const e of [...m.clips]) m.removeClip(e); a.select(m.root, m); });
    await page.click('#btn-ai');
    await page.fill('#ai-prompt', 'make a katana in gold flowerr pattern on the katana as a drawing on it and make it swing');
    await page.press('#ai-prompt', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.msg .thinking'), null, { timeout: 30000 });
    await page.waitForTimeout(800);
    const text = main && (Array.isArray(main.messages[0].content) ? main.messages[0].content.find((c) => c.type === 'text').text : main.messages[0].content);
    ok('decorated request goes to Claude with decoration rules and preset frames', !!main && /decorations/.test(text) && /never extra parts/.test(text) && /katana: blade along \+Y/.test(text));
    const sch = main && main.output_config.format.schema.properties.props.items;
    ok('schema has decorations and the blade shape', sch && sch.required.includes('decorations') && sch.properties.parts.items.properties.shape.enum.includes('blade'));
    const st = await page.evaluate(() => {
      const a = window.webblend; const m = a.models[0];
      const k = m.root.getObjectByName('Flower katana');
      const mats = {}; let discs = 0, ring = false;
      if (k) k.traverse((o) => { if (o.isMesh) { mats[o.material.name] = { map: o.material.map && o.material.map.name, decorated: o.material.userData.decorated }; } });
      // count gold parts: habaki, 2 seppa, 2 menuki + ring; floating discs would add 3 more cylinders
      const gold = k && [...k.children].find((o) => o.isMesh && o.material.name === 'gold');
      const goldVerts = gold ? gold.geometry.attributes.position.count : 0;
      // the guard drawing: did the SVG paint over the base color?
      let painted = 0;
      const guard = k && [...k.children].find((o) => o.isMesh && o.material.name === 'guard');
      const img = guard && guard.material.map && guard.material.map.image;
      if (img) { const g = img.getContext('2d'); const d = g.getImageData(0, 0, img.width, img.height).data; const b = [d[0], d[1], d[2]]; for (let i = 0; i < d.length; i += 4 * 7) if (Math.abs(d[i] - b[0]) + Math.abs(d[i + 1] - b[1]) + Math.abs(d[i + 2] - b[2]) > 60) painted++; }
      const clip = m.clips.find((c) => c.clip.name === 'Katana slash');
      return { k: !!k, mats, goldVerts, painted, clip: !!clip, msg: [...document.querySelectorAll('.msg.bot')].pop().textContent };
    });
    ok('katana built and held, swing clip made', st.k && st.clip, JSON.stringify({ k: st.k, clip: st.clip }));
    ok('blade wears hamon + flowers as a fitted band', st.mats.blade && /hamon\+flowers/.test(st.mats.blade.map) && st.mats.blade.decorated === 'fit', JSON.stringify(st.mats.blade));
    ok('the SVG drawing painted the guard', st.mats.guard && st.mats.guard.map === 'decoration-drawing' && st.painted > 20, `painted samples ${st.painted}`);
    ok('loose floating discs dropped, attached ring kept', /Left out 3 loose parts/.test(st.msg), st.msg.slice(0, 200));
    ok('no page errors, no script from the drawing ran', errors.length === 0, errors.slice(0, 4).join(' | '));
    await page.close();
  }
  // ---------------- API key path
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    let captured = null;
    await page.route('https://api.anthropic.com/**', async (route) => {
      const req = route.request();
      captured = { url: req.url(), headers: await req.allHeaders(), body: JSON.parse(req.postData() || '{}') };
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse(JSON.stringify(SPEC)) });
    });
    await page.goto('file://' + path.resolve(__dirname, '../index.html'));
    await page.waitForTimeout(1200);
    await page.evaluate(() => { const a = window.webblend; a.settings.setApiKey('sk-ant-test-key', false); a.emit('settings', 'apiKey'); });
    await page.click('#btn-ai');
    const prov = await page.textContent('.ai-provider');
    ok('provider shows API key mode', /API key/.test(prov), prov.trim());
    await page.fill('#ai-prompt', 'do a cheerful little hop while raising both arms like you won something');
    await page.press('#ai-prompt', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.msg .thinking'), null, { timeout: 30000 });
    await page.waitForTimeout(300);
    ok('request sent to /v1/messages', captured && /\/v1\/messages/.test(captured.url), captured && captured.url);
    ok('uses claude-opus-5-5 by default', captured && captured.body.model === 'claude-opus-5-5');
    ok('structured output json_schema', captured && captured.body.output_config && captured.body.output_config.format && captured.body.output_config.format.type === 'json_schema');
    ok('server-side fallbacks enabled', captured && captured.body.fallbacks === 'default' && /server-side-fallback-2026-07-01/.test(captured.headers['anthropic-beta'] || ''), captured && captured.headers['anthropic-beta']);
    ok('browser access header set', captured && captured.headers['anthropic-dangerous-direct-browser-access'] === 'true');
    ok('api key sent (SDK auth header)', captured && (captured.headers['x-api-key'] === 'sk-ant-test-key' || captured.headers['authorization'] === 'Bearer sk-ant-test-key'));
    ok('streaming requested', captured && captured.body.stream === true);
    const clip = await page.evaluate(() => { const m = window.webblend.selection.model; const e = m && m.clips.find((c) => c.clip.name === 'Happy hop'); return e ? { tracks: e.clip.tracks.length, dur: e.clip.duration } : null; });
    ok('Claude spec became a clip on the mannequin', clip && clip.tracks > 5 && Math.abs(clip.dur - 1.5) < 1e-6, JSON.stringify(clip));
    const lastMsg = await page.evaluate(() => [...document.querySelectorAll('.msg.bot')].pop().textContent);
    ok('assistant message shown', /cheerful/.test(lastMsg), lastMsg.slice(0, 90));
    // simple prompt stays offline (no request)
    captured = null;
    await page.fill('#ai-prompt', 'walk');
    await page.press('#ai-prompt', 'Enter');
    await page.waitForTimeout(400);
    ok('simple prompt handled offline (no API call)', captured === null);
    // error path: 401
    await page.unroute('https://api.anthropic.com/**');
    await page.route('https://api.anthropic.com/**', (route) => route.fulfill({ status: 401, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }) }));
    await page.fill('#ai-prompt', 'perform an elaborate interpretive dance about the ocean');
    await page.press('#ai-prompt', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.msg .thinking'), null, { timeout: 30000 });
    const errMsg = await page.evaluate(() => [...document.querySelectorAll('.msg.bot')].pop().textContent);
    ok('bad key shows a clear message and falls back', /rejected/.test(errMsg) && /Made/.test(errMsg), errMsg.slice(0, 140));
    ok('no page errors (api)', errors.length === 0, errors.join(' | '));
    await page.close();
  }
  // ---------------- artifact (window.claude sample) path
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.addInitScript((spec) => {
      window.__sampleCalls = [];
      const sample = async (input, opts) => ({ text: JSON.stringify(spec), truncated: false, modelTierApplied: 'default' });
      sample.json = async (input, opts) => { window.__sampleCalls.push({ input: String(input).slice(0, 200), opts: Object.keys(opts || {}), images: opts && opts.images ? opts.images.length : 0 }); opts && opts.onText && opts.onText({ text: '{', delta: '{' }); return spec; };
      sample.limits = async () => ({ maxPromptBytes: 262144, images: { maxCount: 5, maxInputBytes: 20e6, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] } });
      const downloads = { save: async ({ filename }) => { window.__saved = filename; return { status: 'saved' }; } };
      window.claude = { use: async (name) => (name === 'sample' ? sample : name === 'downloads' ? downloads : null) };
    }, SPEC);
    await page.goto('file://' + path.resolve(__dirname, '../index.html'));
    await page.waitForTimeout(1500);
    await page.click('#btn-ai');
    await page.waitForTimeout(300);
    const prov = await page.textContent('.ai-provider');
    ok('artifact: provider is claude.ai account', /claude\.ai/.test(prov), prov.trim());
    await page.fill('#ai-prompt', 'celebrate like you just scored the winning goal in a final');
    await page.press('#ai-prompt', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.msg .thinking'), null, { timeout: 30000 });
    const calls = await page.evaluate(() => window.__sampleCalls);
    ok('artifact: sample.json called with instructions', calls.length === 1 && /keyframe animations/.test(calls[0].input), JSON.stringify(calls[0] && calls[0].opts));
    const has = await page.evaluate(() => !!window.webblend.selection.model.clips.find((c) => c.clip.name === 'Happy hop'));
    ok('artifact: clip created from Claude answer', has);
    // images go to Claude through the sample capability
    await page.setInputFiles('#ai-image-input', { name: 'pose.png', mimeType: 'image/png', buffer: PNG1 });
    await page.fill('#ai-prompt', 'copy the pose in this picture');
    await page.press('#ai-prompt', 'Enter');
    await page.waitForFunction(() => !document.querySelector('.msg .thinking'), null, { timeout: 30000 });
    const calls2 = await page.evaluate(() => window.__sampleCalls);
    ok('artifact: image passed to sample.json', calls2.length === 2 && calls2[1].images === 1 && calls2[1].opts.includes('images'), JSON.stringify(calls2[1]));
    // downloads capability used for saves; GLB gets zipped for the artifact allowlist
    await page.evaluate(() => window.__exportGLB(window.webblend, window.webblend.models, 'scene'));
    await page.waitForTimeout(800);
    const saved = await page.evaluate(() => window.__saved);
    ok('artifact: GLB saved via downloads capability as .zip', saved === 'scene.zip', saved);
    ok('no page errors (artifact)', errors.length === 0, errors.join(' | '));
    await page.close();
  }
  await browser.close();
  console.log(fails ? `${fails} FAILURE(S)` : 'ALL AI TESTS OK');
})();
