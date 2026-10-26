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

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
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
      sample.json = async (input, opts) => { window.__sampleCalls.push({ input: String(input).slice(0, 200), opts: Object.keys(opts || {}) }); opts && opts.onText && opts.onText({ text: '{', delta: '{' }); return spec; };
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
