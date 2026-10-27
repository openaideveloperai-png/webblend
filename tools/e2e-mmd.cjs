// MMD-style character end to end: .blend in a zip with a tex/ folder, and the
// same character exported to .glb by Blender.
// Usage: node tools/e2e-mmd.cjs <dir with goatchan.zip goatchan.glb goat_truth.json> <outDir>
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const [,, D, OUT] = process.argv;
let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };

async function open(page, files) {
  await page.click('.menu-btn:has-text("File")');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.dd-item:has-text("Open files")')]);
  await chooser.setFiles(files);
  await page.waitForFunction(() => !document.querySelector('.toast.busy'), null, { timeout: 60000 });
  await page.waitForTimeout(800);
  const notes = await page.evaluate(() => { const m = document.querySelector('.modal-back'); if (!m) return null; const t = [...m.querySelectorAll('li')].map((l) => l.textContent); m.remove(); return t; });
  return notes;
}

(async () => {
  const truth = JSON.parse(fs.readFileSync(path.join(D, 'goat_truth.json'), 'utf8'));
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  await page.goto('file://' + path.resolve(__dirname, '../index.html'));
  await page.waitForTimeout(1500);

  // ---- 1. .blend inside a zip, textures in tex/
  const notes = await open(page, [path.join(D, 'goatchan.zip')]);
  ok('zip opens without error notes (config .json files skipped quietly)', !notes, JSON.stringify(notes));
  const info = await page.evaluate(() => {
    const a = window.webblend;
    const m = a.models.find((x) => x.name === 'goatchan');
    if (!m) return null;
    const maps = {};
    let skinned = null;
    const shown = [], hidden = [];
    m.root.traverse((o) => {
      if (o.isSkinnedMesh) { skinned = o; for (const mt of o.material) maps[mt.name] = !!(mt.map && mt.map.image && (mt.map.image.width || mt.map.image.data)); }
      if (o.isMesh && !o.isSkinnedMesh) { let v = true; for (let p = o; p; p = p.parent) if (!p.visible) v = false; (v ? shown : hidden).push(o.name); }
    });
    const jointNames = m.joints.bones.map((b) => b.name);
    return { maps, double: skinned && skinned.material.every((mt) => mt.side === 2), shown, hidden: hidden.length, humanoid: !!m.humanoid, jointNames, constraints: m.constraints ? m.constraints.count : 0 };
  });
  ok('model loaded', !!info);
  ok('all 4 textures found (png, dds, tga, bmp; through MMD node groups)', info && Object.values(info.maps).length === 4 && Object.values(info.maps).every(Boolean), JSON.stringify(info && info.maps));
  ok('materials are double-sided like in Blender', info && info.double);
  ok('rigid bodies / hidden helpers are hidden', info && info.shown.length === 0 && info.hidden >= 12, JSON.stringify(info && info.shown));
  ok('rig with Japanese bone names is a humanoid', info && info.humanoid);
  ok('bone dots: control bones and IK handles, not the D/helper bones', info && info.jointNames.includes('左足') && info.jointNames.includes('左足ＩＫ') && !info.jointNames.includes('左足D') && !info.jointNames.some((n) => /_dummy_|_shadow_/.test(n)), JSON.stringify(info && info.jointNames));
  ok('bone constraints are running', info && info.constraints >= 10, info && info.constraints);

  // outliner tucks the hidden helpers away
  const ol = await page.evaluate(() => {
    const a = window.webblend; const m = a.models.find((x) => x.name === 'goatchan');
    const rb = m.root.getObjectByName('rigidbodies');
    a.select(m.root, m);
    // expand down to the rigidbodies empty
    a.select(rb, m); a.select(m.root, m);
    return [...document.querySelectorAll('#outliner .ol-row')].map((r) => r.textContent);
  });
  ok('Scene list groups hidden helper objects', ol.some((t) => /\d+ hidden objects/.test(t)), JSON.stringify(ol.slice(0, 12)));

  // posing a control bone moves the deforming D bone (and so the mesh)
  const drive = await page.evaluate(() => {
    const a = window.webblend; const m = a.models.find((x) => x.name === 'goatchan');
    for (const e of m.clips) m.setPlaying(e, false);
    a.pause(); a.setTime(0); a.tick(0);
    const ctl = m.root.getObjectByName('左足'), def = m.root.getObjectByName('左足D');
    const knee = m.root.getObjectByName('左ひざD');
    const before = knee.getWorldPosition(knee.position.clone());
    a.select(ctl, m);
    ctl.quaternion.multiply(new ctl.quaternion.constructor().setFromAxisAngle(new ctl.position.constructor(1, 0, 0), -0.8));
    a.tick(0);
    const after = knee.getWorldPosition(knee.position.clone());
    return { moved: after.distanceTo(before), same: Math.abs(def.quaternion.dot(ctl.quaternion)) };
  });
  ok('rotating control bone 左足 moves the D bone chain', drive.moved > 0.1 && drive.same > 0.999, JSON.stringify(drive));

  // the .blend's own animation plays with IK, like in Blender
  const anim = await page.evaluate((tr) => {
    const a = window.webblend; const m = a.models.find((x) => x.name === 'goatchan');
    m.resetPose();
    const e = m.clips.find((c) => /Dance/.test(c.clip.name));
    m.setPlaying(e, true); m.setActiveClip(e);
    a.setTime(14 / 24); a.tick(0);
    const out = {};
    m.root.updateMatrixWorld(true);
    // Blender coordinates are Z-up; the importer wraps them to Y-up
    const zup = m.root.getObjectByName('Z-up');
    for (const [name, p] of Object.entries(tr.frame15)) {
      const b = m.root.getObjectByName(name);
      const w = b.getWorldPosition(b.position.clone());
      const local = zup.worldToLocal(w.clone());
      out[name] = Math.hypot(local.x - p[0], local.y - p[1], local.z - p[2]);
    }
    return out;
  }, truth);
  const worst = Math.max(...Object.values(anim));
  ok('Dance clip matches Blender at frame 15 (D bones + leg IK)', worst < 0.03, JSON.stringify(Object.fromEntries(Object.entries(anim).map(([k, v]) => [k, +(v * 100).toFixed(1)]))) + ' cm');

  // AI walk works through the control bones
  await page.evaluate(() => { const a = window.webblend; const m = a.models.find((x) => x.name === 'goatchan'); for (const e of m.clips) m.setPlaying(e, false); m.resetPose(); a.select(m.root, m); });
  await page.click('#btn-ai');
  await page.fill('#ai-prompt', 'walk');
  await page.press('#ai-prompt', 'Enter');
  await page.waitForTimeout(800);
  const walk = await page.evaluate(() => {
    const a = window.webblend; const m = a.models.find((x) => x.name === 'goatchan');
    const e = m.clips.find((c) => /walk/i.test(c.clip.name));
    if (!e) return null;
    for (const c of m.clips) m.setPlaying(c, c === e);
    const knee = m.root.getObjectByName('左ひざD');
    const pos = [];
    for (const t of [0, 0.25, 0.5, 0.75]) { a.setTime(t * e.clip.duration); a.tick(0); pos.push(knee.getWorldPosition(knee.position.clone())); }
    let spread = 0;
    for (const p of pos) spread = Math.max(spread, p.distanceTo(pos[0]));
    return { spread, tracks: e.clip.tracks.length };
  });
  ok('AI "walk" moves the legs (mesh follows through constraints)', walk && walk.spread > 0.05, JSON.stringify(walk));

  // export bakes the constraints so other apps see the motion
  await page.click('.menu-btn:has-text("File")');
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.dd-item:has-text("Save scene")')]);
  const glbPath = path.join(OUT, 'mmd-export.glb');
  await dl.saveAs(glbPath);
  const glb = fs.readFileSync(glbPath);
  const jsonLen = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.slice(20, 20 + jsonLen).toString('utf8'));
  const nodeNames = gltf.nodes.map((n) => n.name);
  const dIdx = nodeNames.indexOf('左ひざD');
  const walkAnim = (gltf.animations || []).find((x) => /walk/i.test(x.name));
  ok('exported walk has baked keys on the D bones', !!walkAnim && walkAnim.channels.some((c) => c.target.node === dIdx), walkAnim ? walkAnim.name : 'no walk animation');

  // ---- 2. the same character exported to .glb by Blender (no constraints in the file)
  await page.evaluate(() => window.webblend.clearScene());
  await open(page, [path.join(D, 'goatchan.glb')]);
  const g = await page.evaluate(() => {
    const a = window.webblend; const m = a.models[0];
    const h = m.humanoid;
    const shown = [];
    m.root.traverse((o) => { if (o.isMesh && !o.isSkinnedMesh) { let v = true; for (let p = o; p; p = p.parent) if (!p.visible) v = false; if (v) shown.push(o.name); } });
    // rotate the humanoid's thigh: the skinned mesh must follow
    for (const e of m.clips) m.setPlaying(e, false);
    m.resetPose(); a.tick(0);
    const sk = []; m.root.traverse((o) => { if (o.isSkinnedMesh) sk.push(o); });
    const thigh = h && h.map.leftUpperLeg;
    const measure = () => { let s = 0; const v = new thigh.position.constructor(); for (const mesh of sk) { for (let i = 0; i < mesh.geometry.attributes.position.count; i += 7) { mesh.getVertexPosition(i, v); s += v.z + v.y; } } return s; };
    const before = thigh ? measure() : 0;
    if (thigh) { thigh.rotateX(-0.9); a.tick(0); for (const mesh of sk) mesh.skeleton.update(); }
    const after = thigh ? measure() : 0;
    return { humanoid: !!h, thigh: thigh && thigh.name, joints: m.joints.bones.map((b) => b.name), shown, moved: Math.abs(after - before), constraints: m.constraints ? m.constraints.count : 0 };
  });
  ok('GLB: MMD leg IK and D bones rebuilt from bone names', g.constraints >= 8, g.constraints);
  ok('GLB: humanoid found, legs mapped to the control bones', g.humanoid && g.thigh === '左足', g.thigh);
  ok('GLB: bone dots on control bones and IK handles, D bones hidden', g.joints.includes('左足') && g.joints.includes('左足ＩＫ') && !g.joints.includes('左足D'), JSON.stringify(g.joints));
  ok('GLB: rigid body meshes hidden by name', !g.shown.some((n) => /rigid/i.test(n)), JSON.stringify(g.shown));
  ok('GLB: posing the thigh deforms the mesh', g.moved > 0.01, g.moved.toFixed(3));
  await page.evaluate(() => window.webblend.viewport.frameAll());
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'e2e-mmd.png') });

  ok('no console errors', errors.length === 0, errors.slice(0, 6).join('\n   '));
  await browser.close();
  console.log(fails ? `\n${fails} FAILURE(S)` : '\nALL MMD TESTS OK');
  process.exit(fails ? 1 : 0);
})();
