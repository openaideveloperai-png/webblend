// Tools and customization: the start-up intro, bone colors (one per body part),
// uniform scale, multi-select bones with Ctrl spread, and the hidden console.
const { chromium } = require('playwright');
const path = require('path');
let fails = 0;
const ok = (l, c, x = '') => { console.log((c ? 'ok   ' : 'FAIL ') + l + (x ? '  ' + x : '')); if (!c) fails++; };
const url = 'file://' + path.resolve(__dirname, '../index.html');
(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); if (process.env.STACK) console.log('STACK', e.stack); });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  // ---------------------------------------------------------------- intro
  await page.goto(url + '?intro');
  await page.waitForTimeout(600);
  ok('the intro plays over the app (forced with ?intro)', await page.evaluate(() => !!document.querySelector('.intro canvas')));
  await page.mouse.click(400, 300);
  await page.waitForTimeout(600);
  ok('clicking skips it', await page.evaluate(() => !document.querySelector('.intro')));
  await page.goto(url);
  await page.waitForTimeout(1200);
  ok('no intro under automation', await page.evaluate(() => !document.querySelector('.intro')));

  // ---------------------------------------------------------------- bone colors
  const colors = await page.evaluate(() => {
    const a = window.webblend; const m = a.models.find((x) => x.humanoid); a.select(null);
    const j = m.joints;
    const col = (i) => { const c = new (j.points.instanceColor.array.constructor)(3); c.set(j.points.instanceColor.array.subarray(i * 3, i * 3 + 3)); return '#' + [...c].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join(''); };
    a.setSetting('boneColor', '#ff0000');
    const single = col(0);
    a.setSetting('boneColorByPart', true);
    const parts = {};
    j.bones.forEach((b, i) => { (parts[j.parts[i]] = parts[j.parts[i]] || []).push(b.name); });
    const hand = j.bones.findIndex((b) => m.humanoid.canonOf.get(b) === 'leftHand');
    const head = j.bones.findIndex((b) => m.humanoid.canonOf.get(b) === 'head');
    const handCol = col(hand), headCol = col(head);
    a.setSetting('bonePartColors', { hands: '#00ff00' });
    const handCol2 = col(hand);
    a.setSetting('boneSelColor', '#0000ff');
    a.select(j.bones[head], m);
    const selCol = col(head);
    a.select(null);
    a.setSetting('boneSelColor', '#ffb84a');
    a.setSetting('boneColorByPart', false); a.setSetting('boneColor', '#9fb4d0'); a.setSetting('bonePartColors', null);
    return { single, parts: Object.fromEntries(Object.entries(parts).map(([k, v]) => [k, v.length])), handCol, headCol, handCol2, selCol };
  });
  ok('one color for every dot', colors.single === '#ff0000', colors.single);
  ok('by body part: hands, head, torso, arms, legs, feet each found', ['hands', 'head', 'torso', 'arms', 'legs', 'feet'].every((k) => colors.parts[k] > 0), JSON.stringify(colors.parts));
  ok('hand and head dots get different colors', colors.handCol !== colors.headCol, `${colors.handCol} / ${colors.headCol}`);
  ok('a part color can be changed', colors.handCol2 === '#00ff00', colors.handCol2);
  ok('the selected bone keeps the selection color', colors.selCol === '#0000ff', colors.selCol);

  // ---------------------------------------------------------------- uniform scale
  const uni = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0];
    a.select(m.root, m);
    a.setGizmoMode('scale');
    a.setUniformScale(true);
    const s0 = m.root.scale.clone();
    a.emit('gizmo:start');
    m.root.scale.set(s0.x * 1.5, s0.y, s0.z); // dragging the X handle
    a.emit('gizmo:change');
    a.emit('gizmo:end');
    const after = m.root.scale.toArray();
    a.history.undo();
    const undone = m.root.scale.toArray();
    a.setUniformScale(false);
    a.emit('gizmo:start');
    m.root.scale.set(s0.x * 1.5, s0.y, s0.z);
    a.emit('gizmo:change');
    a.emit('gizmo:end');
    const free = m.root.scale.toArray();
    a.history.undo();
    return { s0: s0.toArray(), after, undone, free, btn: !!document.querySelector('#gizmo-tools button[aria-label="Uniform scale"]') };
  });
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  ok('uniform scale: dragging one axis scales all three equally', near(uni.after, uni.s0.map((v) => v * 1.5)), JSON.stringify(uni.after));
  ok('…and undoes in one step', near(uni.undone, uni.s0), JSON.stringify(uni.undone));
  ok('with it off only that axis scales', near(uni.free, [uni.s0[0] * 1.5, uni.s0[1], uni.s0[2]]), JSON.stringify(uni.free));
  ok('toolbar has the Uniform button', uni.btn);
  await page.keyboard.press('Shift+R');
  ok('Shift+R turns uniform scale on', await page.evaluate(() => window.webblend.settings.get('uniformScale') === true && window.webblend.gizmoMode === 'scale'));
  await page.keyboard.press('Shift+R');
  // the Uniform field in Properties
  const field = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0];
    a.select(null); a.select(m.root, m);
    const inp = document.querySelector('.xyz.one input');
    if (!inp) return null;
    const s0 = m.root.scale.toArray();
    inp.value = '2'; inp.dispatchEvent(new Event('change', { bubbles: true }));
    const s1 = m.root.scale.toArray();
    a.history.undo();
    return { s0, s1, s2: m.root.scale.toArray() };
  });
  ok('Properties → Uniform sets all three axes', field && near(field.s1, field.s0.map((v) => v * 2 / ((field.s0[0] + field.s0[1] + field.s0[2]) / 3))) && near(field.s2, field.s0), JSON.stringify(field));

  // ---------------------------------------------------------------- settings dialog
  await page.evaluate(() => window.webblend.select(null));
  await page.keyboard.press('Escape');
  await page.click('#btn-settings');
  await page.waitForTimeout(200);
  ok('settings has a Bones section with part colors', await page.evaluate(() => !!document.querySelector('#set-bones') && !!document.querySelector('#set-boneColorByPart')));
  ok('settings has the intro toggle', await page.evaluate(() => !!document.querySelector('#set-introAnimation')));
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- multi-select bones
  const multi = await page.evaluate(() => {
    const a = window.webblend; const m = a.models.find((x) => x.humanoid);
    const rig = m.humanoid;
    const H = rig.handRig('left');
    const fingers = Object.values(H.chains).flatMap((c) => c.bones.map((b) => b.bone));
    const V = (b) => { const v = b.getWorldPosition(new (a.multiPivot.position.constructor)()); return [v.x, v.y, v.z]; };
    const res = {};
    a.setGizmoMode('translate');
    a.selectBones(fingers, m);
    res.count = a.selectedBones().length;
    res.extra = a.selection.extra.length;
    res.multiActive = a.multiActive;
    res.attached = a.viewport.gizmo.object === a.multiPivot;
    const col = (b) => { const j = m.joints; const i = j.boneIndex.get(b); return [...j.points.instanceColor.array.subarray(i * 3, i * 3 + 3)].map((x) => Math.round(x * 100) / 100); };
    res.extraColor = col(fingers[0]);
    // move them together
    const p0 = fingers.map(V);
    a.emit('gizmo:start'); a.multiPivot.position.y += 0.1; a.multiPivot.updateMatrixWorld(); a.emit('gizmo:change'); a.emit('gizmo:end');
    const p1 = fingers.map(V);
    res.moved = p1.map((p, i) => p[1] - p0[i][1]);
    res.movedX = p1.map((p, i) => Math.abs(p[0] - p0[i][0]));
    a.history.undo();
    res.undone = Math.max(...fingers.map(V).map((p, i) => Math.hypot(p[0] - p0[i][0], p[1] - p0[i][1], p[2] - p0[i][2])));
    // Ctrl held: spread apart along the drag
    a.placePivot();
    const c = a.multiPivot.position.clone();
    a.viewport.ctrlHeld = true; a.viewport.gizmo.axis = 'Y';
    a.setGizmoSpace('world'); a.placePivot();
    a.emit('gizmo:start'); a.multiPivot.position.y += 0.02; a.emit('gizmo:change'); a.emit('gizmo:end');
    a.viewport.ctrlHeld = false; a.viewport.gizmo.axis = null;
    const p2 = fingers.map(V);
    res.spreadOk = fingers.every((b, i) => { const off = p0[i][1] - c.y; const d = p2[i][1] - p0[i][1]; return Math.abs(off) < 1e-4 ? Math.abs(d) < 1e-4 : Math.sign(d) === Math.sign(off); });
    res.spreadSpan = [Math.max(...p0.map((p) => p[1])) - Math.min(...p0.map((p) => p[1])), Math.max(...p2.map((p) => p[1])) - Math.min(...p2.map((p) => p[1]))];
    a.history.undo();
    // drag back the other way: together
    a.placePivot();
    a.viewport.ctrlHeld = true; a.viewport.gizmo.axis = 'Y';
    a.emit('gizmo:start'); a.multiPivot.position.y -= 0.01; a.emit('gizmo:change'); a.emit('gizmo:end');
    a.viewport.ctrlHeld = false; a.viewport.gizmo.axis = null;
    const p3 = fingers.map(V);
    res.closeSpan = Math.max(...p3.map((p) => p[1])) - Math.min(...p3.map((p) => p[1]));
    a.history.undo();
    // rotate them about their middle: distances between them stay the same
    a.setGizmoMode('rotate'); a.placePivot();
    const piv = a.multiPivot.position.clone();
    a.emit('gizmo:start');
    a.multiPivot.quaternion.multiply(new (a.multiPivot.quaternion.constructor)().setFromAxisAngle(new (a.multiPivot.position.constructor)(0, 1, 0), 0.5));
    a.emit('gizmo:change'); a.emit('gizmo:end');
    const p4 = fingers.map(V);
    const dist = (P, i, j) => Math.hypot(P[i][0] - P[j][0], P[i][1] - P[j][1], P[i][2] - P[j][2]);
    res.rigid = Math.max(...fingers.slice(1).map((_, i) => Math.abs(dist(p4, 0, i + 1) - dist(p0, 0, i + 1))));
    res.turned = Math.hypot(p4[0][0] - p0[0][0], p4[0][2] - p0[0][2]);
    res.pivotDist = Math.abs(Math.hypot(p4[0][0] - piv.x, p4[0][2] - piv.z) - Math.hypot(p0[0][0] - piv.x, p0[0][2] - piv.z));
    a.history.undo();
    a.setGizmoMode('translate'); a.setGizmoSpace('local');
    // Shift+click toggles bones in and out
    const head = rig.map.head;
    a.selectFromViewport({ bone: head, model: m }, true);
    res.afterAdd = [a.selectedBones().length, a.selection.object === head];
    a.selectFromViewport({ bone: head, model: m }, true);
    res.afterRemove = [a.selectedBones().length, a.selectedBones().includes(head)];
    // keying keys all of them
    a.keySelection();
    const e = m.activeClip;
    const names = new Set(e.clip.tracks.map((t) => t.name.split('.')[0]));
    res.keyed = fingers.filter((b) => names.has(b.uuid) || names.has(b.name)).length;
    a.history.undo();
    a.select(null);
    return res;
  });
  ok('select many bones at once (left-hand fingers)', multi.count > 10 && multi.extra === multi.count - 1, `${multi.count} bones`);
  ok('the gizmo sits at their middle', multi.multiActive && multi.attached);
  ok('extra selected bones get their own dot color', multi.extraColor.join() === '1,0.15,0.67' || multi.extraColor[0] > 0.9, multi.extraColor.join());
  ok('moving moves them all together', multi.moved.every((d) => Math.abs(d - 0.1) < 1e-4) && multi.movedX.every((d) => d < 1e-4), multi.moved.slice(0, 3).join());
  ok('…undone in one step', multi.undone < 1e-5, String(multi.undone));
  ok('Ctrl+move spreads them apart (above go up, below go down)', multi.spreadOk && multi.spreadSpan[1] > multi.spreadSpan[0] * 1.2, multi.spreadSpan.map((x) => x.toFixed(4)).join(' → '));
  ok('Ctrl+move the other way brings them together', multi.closeSpan < multi.spreadSpan[0] * 0.95, `${multi.spreadSpan[0].toFixed(4)} → ${multi.closeSpan.toFixed(4)}`);
  ok('rotating turns them about their middle, rigidly', multi.rigid < 1e-4 && multi.turned > 1e-3 && multi.pivotDist < 1e-4, `${multi.rigid} ${multi.turned} ${multi.pivotDist}`);
  ok('Shift+click adds a bone (it becomes the active one) and takes it out again', multi.afterAdd[0] === multi.count + 1 && multi.afterAdd[1] && multi.afterRemove[0] === multi.count && !multi.afterRemove[1], JSON.stringify([multi.afterAdd, multi.afterRemove]));
  ok('K keys every selected bone', multi.keyed === multi.count, `${multi.keyed} / ${multi.count}`);
  // the Tools menu
  await page.evaluate(() => { const a = window.webblend; const m = a.models.find((x) => x.humanoid); a.select(m.humanoid.map.leftHand, m); });
  await page.click('.menu-btn:has-text("Tools")');
  await page.click('.dd-item:has-text("Fingers: left hand")');
  ok('Tools → Fingers: left hand selects them', await page.evaluate(() => window.webblend.selectedBones().length > 10));
  ok('Properties says how many bones are selected', await page.isVisible('.multi-note'));
  await page.click('button:has-text("Spread")');
  ok('the Spread button spreads them (one undo step)', await page.evaluate(() => window.webblend.history.undoStack[window.webblend.history.undoStack.length - 1].label === 'Spread bones'));
  await page.evaluate(() => { window.webblend.history.undo(); window.webblend.select(null); });

  // ---------------------------------------------------------------- the console
  await page.click('#btn-settings');
  await page.waitForTimeout(150);
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  for (const k of ['Control+8', 'Control+8', 'Control+8', 'Control+8', 'Control+x']) await page.keyboard.press(k);
  await page.waitForTimeout(150);
  ok('Ctrl+8 8 8 8 X in Settings opens the console', await page.isVisible('.floatwin .con-in') && !(await page.isVisible('#set-bones')));
  const run = async (code) => { await page.fill('.con-in', code); await page.press('.con-in', 'Control+Enter'); await page.waitForTimeout(80); return page.evaluate(() => [...document.querySelectorAll('.con-line')].slice(-1)[0]?.textContent || ''); };
  ok('an expression prints its value', (await run('1 + 2')) === '3');
  ok('statements run (and can use THREE and the app)', (await run('const v = new THREE.Vector3(1, 2, 3)\nreturn v.length().toFixed(3)')) === '3.742');
  ok('errors show up', (await run('nope()')).includes('ReferenceError'));
  ok('addTool adds a tool', (await run("addTool('Test tool', () => { window.__ran = (window.__ran || 0) + 1 }, { key: 'g' })")).includes('Added'));
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('g');
  ok('…with its own shortcut', await page.evaluate(() => window.__ran === 1));
  await page.click('.menu-btn:has-text("Tools")');
  ok('…and in the Tools menu', await page.isVisible('.dd-item:has-text("Test tool")'));
  await page.click('.dd-item:has-text("Test tool")');
  ok('…which runs it', await page.evaluate(() => window.__ran === 2));
  ok('a panel of your own', (await run("const b = panel('Mine'); b.append(h('span', { id: 'mine' }, 'hi')); 'ok'")) === 'ok' && await page.isVisible('#mine'));
  await page.click('.floatwin:has(.con-in) .fw-h button');
  ok('the console closes', !(await page.isVisible('.con-in')));
  // typing 8888x into a text box isn't the code
  await page.click('#btn-settings');
  await page.waitForTimeout(150);
  await page.focus('#set-apikey');
  await page.keyboard.type('8888x');
  ok('typing 8888x in a box does not open it', !(await page.isVisible('.con-in')));
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- Advanced character settings
  await page.evaluate(() => { const a = window.webblend; const m = a.models.find((x) => x.humanoid); a.select(m.root, m); });
  await page.click('button:has-text("Advanced…")');
  await page.waitForTimeout(200);
  ok('Advanced… opens the character settings', await page.isVisible('#adv-lips') && await page.isVisible('#adv-mouths') && await page.isVisible('#adv-where') && await page.isVisible('#adv-tune'));
  const adv = await page.evaluate(async () => {
    const a = window.webblend; const m = a.models.find((x) => x.humanoid);
    const head = m.humanoid.map.head, neck = m.humanoid.map.neck;
    a.selectBones([neck, head], m);
    await new Promise((r) => setTimeout(r, 50));
    const btn = (t) => [...document.querySelectorAll('#adv-lips button, #adv-mouths button, #adv-where button')].find((b) => b.textContent.includes(t));
    btn('as the lips').click();
    const lips = m.lipBones && m.lipBones.slice();
    btn('Add a mouth').click();
    const mouths = m.extraMouths && m.extraMouths.length;
    btn('No soft skin on the').click();
    const rigid = [neck, head].every((b) => m.indent && m.indent[b.uuid] && m.indent[b.uuid].rigid);
    btn('Soft skin back on').click();
    const back = [neck, head].every((b) => !m.indent[b.uuid]);
    const r = document.querySelector('#adv-settleOut');
    r.value = '0.4'; r.dispatchEvent(new Event('input', { bubbles: true }));
    const tune = m.skinTune && m.skinTune.settleOut;
    // put it back
    delete m.lipBones; m.extraMouths = []; m.skinTune = {};
    return { lips, mouths, rigid, back, tune };
  });
  ok('use the selected bones as the lips', adv.lips && adv.lips.length === 2, JSON.stringify(adv.lips));
  ok('add another mouth from the selected bones', adv.mouths === 1);
  ok('switch the soft skin off on the selected bones, and back on', adv.rigid && adv.back);
  ok('soft-skin numbers (spring back time)', adv.tune === 0.4, String(adv.tune));
  await page.keyboard.press('Escape');
  await page.click('.menu-btn:has-text("Tools")');
  ok('Tools has Advanced character settings', await page.isVisible('.dd-item:has-text("Advanced character settings")'));
  await page.keyboard.press('Escape');
  // Tools → make the selected bones the lips / another mouth
  await page.evaluate(() => { const a = window.webblend; const m = a.models.find((x) => x.humanoid); a.selectBones([m.humanoid.map.neck, m.humanoid.map.head], m); });
  await page.click('.menu-btn:has-text("Tools")');
  await page.click('.dd-item:has-text("selected bones the lips")');
  await page.click('.menu-btn:has-text("Tools")');
  await page.click('.dd-item:has-text("another mouth")');
  const lipsMenu = await page.evaluate(() => { const m = window.webblend.models.find((x) => x.humanoid); const r = { lips: (m.lipBones || []).length, mouths: (m.extraMouths || []).length }; delete m.lipBones; m.extraMouths = []; return r; });
  ok('Tools → make the selected bones the lips, and add another mouth', lipsMenu.lips === 2 && lipsMenu.mouths === 1, JSON.stringify(lipsMenu));

  // ---------------------------------------------------------------- lips react to an object
  await page.evaluate(() => { const a = window.webblend; const cube = a.addPrimitive('cube'); a.select(cube.root, cube); });
  await page.click('.menu-btn:has-text("Tools")');
  await page.click('.dd-item:has-text("Lips react to the selected object")');
  const marked = await page.evaluate(() => { const a = window.webblend; const r = !!a.selection.object.userData.lipCollider; const m = a.selection.model; a.removeModel(m, { undoable: false }); return r; });
  ok('Tools → Lips react to the selected object marks it', marked);

  // ---------------------------------------------------------------- Del deletes body parts
  const tris = () => page.evaluate(() => { const m = window.webblend.models.find((x) => x.humanoid); return m.skinned.reduce((a, s) => a + (s.geometry.index ? s.geometry.index.count : s.geometry.attributes.position.count) / 3, 0); });
  const t0 = await tris();
  await page.evaluate(() => { const a = window.webblend; const m = a.models.find((x) => x.humanoid); a.select(m.humanoid.map.leftHand, m); document.activeElement && document.activeElement.blur(); });
  await page.keyboard.press('Delete');
  const t1 = await tris();
  ok('Del on a bone deletes the body part it moves (the hand and fingers)', t1 < t0 && t0 - t1 > 20 && (await page.evaluate(() => window.webblend.models.some((x) => x.humanoid))), `${t0} → ${t1} triangles`);
  await page.keyboard.press('Control+z');
  ok('…and Ctrl+Z brings it back', (await tris()) === t0);
  const part = await page.evaluate(() => {
    const a = window.webblend; const m = a.models.find((x) => x.humanoid);
    const piece = new (m.root.constructor)(); // an extra mesh piece on the character
    let mesh = null; m.root.traverse((o) => { if (!mesh && o.isMesh && !o.isSkinnedMesh) mesh = o; });
    const extra = mesh ? mesh.clone() : null;
    if (!extra) return null;
    extra.name = 'Extra piece'; m.root.add(extra); m.refreshParts();
    a.select(extra, m);
    document.activeElement && document.activeElement.blur();
    void piece;
    return m.meshes.length;
  });
  if (part) {
    await page.keyboard.press('Delete');
    const gone = await page.evaluate(() => { const m = window.webblend.models.find((x) => x.humanoid); return { has: !!m.root.getObjectByName('Extra piece'), n: m.meshes.length }; });
    await page.keyboard.press('Control+z');
    const back = await page.evaluate(() => { const m = window.webblend.models.find((x) => x.humanoid); return !!m.root.getObjectByName('Extra piece'); });
    ok('Del on a mesh piece deletes it, Ctrl+Z puts it back', !gone.has && gone.n === part - 1 && back, JSON.stringify(gone));
  } else ok('Del on a mesh piece (no plain mesh on the mannequin to try)', true);

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  console.log(fails ? `${fails} failed` : 'all passed');
  process.exit(fails ? 1 : 0);
})();
