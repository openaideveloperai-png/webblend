// Inspector: transform, appearance, shape keys, light/camera, bone and model tools.
import * as THREE from 'three';
import { h, icon, clear } from './dom.js';
import { propDesc, morphLabel } from '../anim/clips.js';
import { rafThrottle, evalExpr } from '../core/util.js';
import { propOf, heldProps, bakeHoldClip, attachProp } from '../anim/props-anim.js';
import { bakeVFX, removeVFX } from '../anim/vfx.js';
import { softLips } from '../anim/softlips.js';

const R2D = THREE.MathUtils.RAD2DEG, D2R = THREE.MathUtils.DEG2RAD;

function fmt(v, p = 3) {
  if (!isFinite(v)) return '0';
  const s = v.toFixed(p);
  return s.replace(/\.?0+$/, '') || '0';
}

// A number input with a draggable axis label
function numField(axis, read, write, { step = 0.01, precision = 3, onCommit } = {}) {
  const input = h('input', { type: 'text', inputmode: 'decimal', 'aria-label': axis });
  const tag = h('i', { class: axis.toLowerCase(), title: 'Drag to change' }, axis);
  const el = h('div', { class: 'num' }, tag, input);
  const update = () => { if (document.activeElement !== input) input.value = fmt(read(), precision); };
  input.addEventListener('focus', () => input.select());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') { input.value = fmt(read(), precision); input.blur(); }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const v = read() + (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
      const before = onCommit.begin();
      write(v); onCommit.end(before); update();
    }
  });
  input.addEventListener('change', () => {
    let v;
    try { v = evalExpr(input.value); } catch { v = parseFloat(input.value); }
    if (!isFinite(v)) { update(); return; }
    const before = onCommit.begin();
    write(v); onCommit.end(before); update();
  });
  tag.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    tag.setPointerCapture(e.pointerId);
    const startX = e.clientX, start = read();
    const before = onCommit.begin();
    let moved = false;
    const move = (ev) => {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 1) moved = true;
      write(start + dx * step * (ev.shiftKey ? 0.1 : 1) * (ev.ctrlKey || ev.metaKey ? 10 : 1));
      update();
    };
    const up = () => {
      tag.removeEventListener('pointermove', move);
      tag.removeEventListener('pointerup', up);
      if (moved) onCommit.end(before); else input.focus();
    };
    tag.addEventListener('pointermove', move);
    tag.addEventListener('pointerup', up);
  });
  update();
  el.update = update;
  return el;
}

// edit one effect element of a clip and bake the clip's effects again
function effectEditor(app, model, group, render, sec) {
  const entry = model.clips.find((e) => e.clip.uuid === group.userData.vfxClip);
  const spec = group.userData.vfxSpec || {};
  const rebake = (change) => {
    if (!entry) return;
    const clip = entry.clip;
    const before = (clip.userData.vfx || []).map((x) => ({ ...x }));
    const after = change(before.map((x) => ({ ...x })));
    const prop = clip.userData.prop ? model.root.getObjectByProperty('uuid', clip.userData.prop) : null;
    const apply = (list) => {
      if (list.length) bakeVFX(model, clip, list, { prop: prop || undefined });
      else { removeVFX(model, clip, { keepTracks: false }); clip.userData.vfx = []; }
      model.rebuildAction(entry);
      app.needsEval = true; app.emit('clips', model); app.viewport.requestRender();
    };
    apply(after);
    app.history.push({ label: 'Edit effect', undo: () => { apply(before); app.select(model.root, model); }, redo: () => apply(after) });
    const again = model.root.getObjectByName('Effects')?.children.find((g) => g.name === spec.name);
    app.select(again || model.root, model);
    render();
  };
  const edit = (key) => (e) => rebake((list) => list.map((x) => (x.name === spec.name ? { ...x, [key]: e.target.value } : x)));
  const desc = `${spec.kind === 'trail' ? 'Trail' : spec.kind === 'particles' ? `Particles (${spec.shape || 'orb'})` : `Effect mesh (${spec.shape || 'sphere'})`} · ${{ swings: 'on every swing', shots: 'on every shot', fast: 'on fast moves', times: 'at set times', range: 'for a time range', always: 'the whole clip' }[spec.when] || spec.when}${entry ? ` · in "${entry.clip.name}"` : ''}`;
  const colorIn = (key, label) => h('div', { class: 'field' }, h('label', {}, label), h('input', { type: 'color', value: '#' + new THREE.Color(spec[key] || '#ffffff').getHexString(), onchange: edit(key), 'aria-label': label }));
  const WHEN = { swings: 'Every swing', shots: 'Every shot', fast: 'Fast moves', always: 'Whole clip', times: 'At set times', range: 'Part of the clip' };
  const whens = ['swings', 'shots', 'fast', 'always'].concat(['swings', 'shots', 'fast', 'always'].includes(spec.when) || !WHEN[spec.when] ? [] : [spec.when]);
  const when = h('select', { 'aria-label': 'When', onchange: edit('when') }, ...whens.map((w) => h('option', { value: w, selected: spec.when === w || undefined }, WHEN[w])));
  return sec('Effect · ' + spec.name,
    h('div', { class: 'hint' }, desc + '. Made from the animation, so it follows the motion; it plays, scrubs and exports with the clip.'),
    colorIn('color', 'Color'), colorIn('color2', 'Core'),
    h('div', { class: 'field' }, h('label', {}, 'When'), when),
    h('div', { class: 'btns' }, h('button', { class: 'btn sm danger', onclick: () => rebake((list) => list.filter((x) => x.name !== spec.name)) }, icon('trash'), 'Remove effect')));
}

export function initProperties(app, ui) {
  const root = document.getElementById('tab-props');
  let updaters = [];
  let keyBtns = [];

  const keyButton = (obj, prop) => {
    const b = h('button', { class: 'keybtn', title: 'Insert / remove key (K)', 'aria-label': 'Key ' + prop });
    const refresh = () => {
      const st = app.propKeyState(obj, prop);
      b.className = 'keybtn' + (st === 'key' ? ' key' : st === 'animated' ? ' animated' : '');
      b.replaceChildren(icon(st === 'key' ? 'key' : 'keyo'));
      b.title = st === 'key' ? 'Remove key at this frame' : st === 'animated' ? 'Animated — click to key this frame' : 'Insert key';
    };
    b.addEventListener('click', () => { app.toggleKeyProp(obj, prop); refresh(); });
    refresh();
    keyBtns.push(refresh);
    return b;
  };

  // commit helper bound to object + prop
  const committer = (obj, prop, label) => ({
    begin: () => propDesc(prop).get(obj),
    end: (before) => app.setProperty(obj, prop, propDesc(prop).get(obj), { commit: true, before, label }),
  });

  const vecRow = (label, obj, prop, opts = {}) => {
    const desc = propDesc(prop);
    const fields = ['X', 'Y', 'Z'].map((ax, i) => {
      let read, write;
      if (prop === 'quaternion') {
        read = () => new THREE.Euler().setFromQuaternion(obj.quaternion, obj.rotation.order)['xyz'[i]] * R2D;
        write = (v) => {
          const e = new THREE.Euler().setFromQuaternion(obj.quaternion, obj.rotation.order);
          e['xyz'[i]] = v * D2R;
          obj.quaternion.setFromEuler(e);
          app.afterEdit();
        };
      } else {
        read = () => obj[prop].getComponent(i);
        write = (v) => { const a = desc.get(obj); a[i] = v; desc.set(obj, a); app.afterEdit(); };
      }
      const f = numField(ax, read, write, { step: opts.step || 0.01, precision: opts.precision ?? 3, onCommit: committer(obj, prop, label) });
      updaters.push(f.update);
      return f;
    });
    const lab = h('span', { class: 'plabel', title: label }, label);
    return h('div', { class: 'prow' }, lab, h('div', { class: 'xyz' }, fields), keyButton(obj, prop));
  };

  const sliderRow = (label, obj, prop, min, max, step = 0.01) => {
    const desc = propDesc(prop);
    const range = h('input', { type: 'range', min, max, step, 'aria-label': label });
    const val = h('span', { class: 'val' });
    let before = null;
    const update = () => { const v = desc.get(obj)[0]; if (document.activeElement !== range) range.value = v; val.textContent = fmt(v, 2); };
    range.addEventListener('pointerdown', () => { before = desc.get(obj); });
    range.addEventListener('input', () => { desc.set(obj, [parseFloat(range.value)]); val.textContent = fmt(parseFloat(range.value), 2); app.afterEdit(); });
    range.addEventListener('change', () => { app.setProperty(obj, prop, [parseFloat(range.value)], { before: before || desc.get(obj), label }); before = null; });
    updaters.push(update);
    update();
    return h('div', { class: 'field' }, h('label', { title: label }, label), range, val, keyButton(obj, prop));
  };

  const colorRow = (label, obj, prop) => {
    const desc = propDesc(prop);
    const inp = h('input', { type: 'color', 'aria-label': label });
    const update = () => { if (document.activeElement !== inp) inp.value = '#' + new THREE.Color().fromArray(desc.get(obj)).getHexString(); };
    let before = null;
    inp.addEventListener('focus', () => { before = desc.get(obj); });
    inp.addEventListener('input', () => { desc.set(obj, new THREE.Color(inp.value).toArray()); app.afterEdit(); });
    inp.addEventListener('change', () => { app.setProperty(obj, prop, new THREE.Color(inp.value).toArray(), { before: before || desc.get(obj), label }); before = null; });
    updaters.push(update);
    update();
    return h('div', { class: 'field' }, h('label', {}, label), inp, h('span', { style: { flex: 1 } }), keyButton(obj, prop));
  };

  const sec = (title, ...children) => h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, h('span', { class: 'sec-t' }, title)), ...children);
  const effectSection = (g, m) => effectEditor(app, m, g, render, sec);

  const render = () => {
    clear(root);
    updaters = [];
    keyBtns = [];
    const { object: obj, model } = app.selection;
    if (!obj || !model) {
      root.append(h('div', { class: 'empty-note' },
        h('div', {}, h('b', {}, 'Nothing selected.')),
        h('div', { style: { marginTop: '6px' } }, 'Click a model in the viewport or the Scene list. Click the small dots on a character to select bones, then rotate them (E) or drag hands and feet (W) to pose with IK.'),
        h('div', { style: { marginTop: '10px' } }, 'Press ', h('b', {}, 'K'), ' to set a keyframe, ', h('b', {}, 'Space'), ' to play.')));
      return;
    }
    const typeLabel = obj === model.root ? (model.humanoid ? 'Character' : model.kind === 'light' ? 'Light' : model.kind === 'camera' ? 'Camera' : 'Model') : obj.isBone ? 'Bone' : obj.isSkinnedMesh ? 'Skinned mesh' : obj.isMesh ? 'Mesh' : obj.isLight ? 'Light' : 'Object';
    const nameInput = h('input', { type: 'text', value: obj.name || '', 'aria-label': 'Name' });
    nameInput.addEventListener('change', () => {
      obj.name = nameInput.value;
      if (obj === model.root) model.name = nameInput.value;
      app.emit('models');
    });
    root.append(h('div', { class: 'sec' },
      h('div', { class: 'sel-head' }, icon(obj.isBone ? 'bone' : obj === model.root && model.humanoid ? 'person' : obj.isLight ? 'light' : obj.isCamera ? 'camera' : 'mesh'), nameInput),
      h('div', { class: 'sub' }, `${typeLabel}${obj !== model.root ? ' in ' + model.name : ''}`)));

    // an effect made by the AI (trail, particles...): recolor, retime or remove it
    if (obj.userData.fx === 'vfx') { root.append(effectSection(obj, model)); return; }

    // transform
    const t = sec('Transform',
      vecRow('Position', obj, 'position', { step: Math.max(model.size, 0.01) * 0.004 }),
      vecRow('Rotation', obj, 'quaternion', { step: 0.5, precision: 1 }),
      vecRow('Scale', obj, 'scale', { step: 0.005 }));
    const tb = h('div', { class: 'btns' },
      h('button', { class: 'btn sm amber', onclick: () => app.keySelection() }, icon('key'), 'Key all (K)'),
      h('button', { class: 'btn sm', onclick: () => { const r = model.rest.get(obj); if (!r) return; const before = { p: obj.position.clone(), q: obj.quaternion.clone(), s: obj.scale.clone() }; obj.position.copy(r.p); obj.quaternion.copy(r.q); obj.scale.copy(r.s); const after = { p: r.p.clone(), q: r.q.clone(), s: r.s.clone() }; app.history.push({ label: 'Reset transform', undo: () => { obj.position.copy(before.p); obj.quaternion.copy(before.q); obj.scale.copy(before.s); app.afterEdit(); }, redo: () => { obj.position.copy(after.p); obj.quaternion.copy(after.q); obj.scale.copy(after.s); app.afterEdit(); } }); app.afterEdit(); } }, icon('reset'), 'Reset'));
    t.append(tb);
    root.append(t);

    // props: held items (guns, swords...) and giving a model to a character
    const holderOf = (pr) => app.models.find((m) => m.root !== pr && pr.parent && m.root.getObjectById(pr.id));
    const propActions = (holder, pr) => {
      const P = pr.userData.prop;
      const play = (opts, label) => {
        const { clip } = bakeHoldClip(holder, pr, { ...opts, name: `${label} ${pr.name.toLowerCase()}` });
        app.addClipToModel(holder, clip, { loop: false });
        app.select(holder.root, holder);
        app.setTime(0); app.play();
      };
      const side = pr.userData.hold.side, other = side === 'right' ? 'left' : 'right';
      const flip = () => {
        // turn it around inside the hand (front <-> back)
        const R = new THREE.Matrix4().makeRotationY(Math.PI);
        for (const c of [...pr.children]) if (!c.userData.fx) c.applyMatrix4(R);
        for (const a of Object.values(P.anchors || {})) if (a && a.isVector3) { a.x = -a.x; a.z = -a.z; }
        const fl = pr.children.find((c) => c.userData.fx === 'flash');
        if (fl && P.anchors.muzzle) fl.position.copy(P.anchors.muzzle);
        attachProp(holder, pr, side);
        app.needsEval = true; app.viewport.requestRender(); render();
      };
      return h('div', { class: 'btns' },
        P.kind === 'gun' ? h('button', { class: 'btn sm amber', onclick: () => play({ shots: P.auto ? 8 : 3 }, 'Shoot') }, icon('sparkle'), 'Shoot') : null,
        P.kind === 'melee' ? h('button', { class: 'btn sm amber', onclick: () => play({ swings: 2 }, 'Swing') }, icon('sparkle'), 'Swing') : null,
        h('button', { class: 'btn sm', onclick: () => play({ aim: true, lower: false, hold: 1.2 }, P.kind === 'melee' ? 'Guard' : 'Aim') }, P.kind === 'melee' ? 'Guard' : 'Aim'),
        h('button', { class: 'btn sm', onclick: () => { attachProp(holder, pr, other); app.needsEval = true; app.viewport.requestRender(); render(); } }, `To ${other} hand`),
        h('button', { class: 'btn sm', title: 'Turn it around in the hand', onclick: flip }, 'Flip'),
        h('button', { class: 'btn sm danger', onclick: () => app.removeProp(holder, pr) }, icon('trash'), 'Remove'));
    };
    const heldHere = propOf(obj);
    if (heldHere && heldHere.userData.hold) {
      const holder = holderOf(heldHere) || model;
      root.append(sec('Held prop · ' + heldHere.name,
        h('div', { class: 'hint' }, `In ${holder.name}'s ${heldHere.userData.hold.side} hand. Move or rotate it with the gizmo to adjust the grip; aiming and shooting follow.`),
        propActions(holder, heldHere)));
    } else if (obj === model.root && model.humanoid && model.adopt) {
      for (const pr of heldProps(model)) root.append(sec('Holding · ' + pr.name, propActions(model, pr)));
    }
    // soft lips: the lips wrap around the tongue / a finger / something held to the mouth
    const soft = obj === model.root && model.humanoid ? softLips(model) : null;
    if (soft) {
      const on = h('input', { type: 'checkbox', checked: model.softLips !== false || undefined, 'aria-label': 'Soft lips' });
      const range = h('input', { type: 'range', min: 0.3, max: 2, step: 0.05, value: model.softLipsSoftness ?? 1, 'aria-label': 'Lip softness' });
      const val = h('span', { class: 'val' }, fmt(model.softLipsSoftness ?? 1, 2));
      const redraw = () => { app.needsEval = true; app.viewport.requestRender(); };
      on.addEventListener('change', () => { model.softLips = on.checked; if (!on.checked) soft.clear(); else soft.update({ force: true }); redraw(); });
      range.addEventListener('input', () => { model.softLipsSoftness = parseFloat(range.value); val.textContent = fmt(model.softLipsSoftness, 2); soft.update({ force: true }); redraw(); });
      root.append(sec('Soft lips',
        h('div', { class: 'field' }, h('label', {}, 'Wrap'), h('label', { class: 'toggle' }, on)),
        h('div', { class: 'field' }, h('label', { title: 'How far the lips give way around what presses them' }, 'Softness'), range, val),
        h('div', { class: 'hint' }, 'The lips wrap, squish and curve around the tongue, a finger or anything held to the mouth, live (like Shrinkwrap + Smooth on a lip vertex group). They part only where it passes.')));
    }
    const holders = app.models.filter((m) => m !== model && m.humanoid);
    if (obj === model.root && !model.humanoid && !obj.isLight && !obj.isCamera && model.meshes.length && holders.length) {
      const who = h('select', { 'aria-label': 'Character' }, ...holders.map((m, i) => h('option', { value: String(i) }, m.name)));
      const hand = h('select', { 'aria-label': 'Hand' }, h('option', { value: 'right' }, 'Right hand'), h('option', { value: 'left' }, 'Left hand'));
      root.append(sec('Give to a character',
        h('div', { class: 'field' }, h('label', {}, 'Character'), who),
        h('div', { class: 'field' }, h('label', {}, 'Hand'), hand),
        h('div', { class: 'btns' }, h('button', { class: 'btn sm amber', onclick: () => { const m = holders[parseInt(who.value, 10)]; const pr = app.giveModelTo(model, m, hand.value); if (pr) app.toast(`${m.name} is holding ${pr.name}. Select the character and use Shoot / Swing, or ask the AI.`, 'ok', 3500); } }, 'Give')),
        h('div', { class: 'hint' }, 'Puts this model in the character\'s hand (its long side forward). Then it can aim, shoot or swing it; use Flip if it faces backward.')));
    }

    // bone tools
    if (obj.isBone) {
      const ik = h('select', { 'aria-label': 'IK chain length' }, ...[[0, 'Off (rotate only)'], [2, '2 bones (arm / leg)'], [3, '3 bones'], [4, '4 bones']].map(([v, l]) => h('option', { value: v, selected: app.settings.get('ikChain') === v || undefined }, l)));
      ik.addEventListener('change', () => app.setSetting('ikChain', parseInt(ik.value, 10)));
      root.append(sec('Posing',
        h('div', { class: 'field' }, h('label', {}, 'IK drag'), ik),
        h('div', { class: 'hint' }, 'With ', h('b', {}, 'Move (W)'), ', dragging a hand or foot bends the arm or leg to follow. ', h('b', {}, 'Rotate (E)'), ' turns a single bone.'),
        h('div', { class: 'btns' },
          h('button', { class: 'btn sm amber', onclick: () => app.keyPose(model) }, icon('key'), 'Key whole pose'),
          h('button', { class: 'btn sm', onclick: () => ui.copyPose() }, icon('copy'), 'Copy pose'),
          h('button', { class: 'btn sm', disabled: !ui.poseClipboard || undefined, onclick: () => ui.pastePose() }, 'Paste'),
          h('button', { class: 'btn sm', onclick: () => app.selectParent() }, 'Select parent (P)'))));
    }

    // appearance
    const mats = obj.material ? (Array.isArray(obj.material) ? obj.material : [obj.material]) : [];
    if (obj.isMesh || obj.isPoints) {
      const s = sec('Appearance');
      if (!obj.isBone) s.append(h('div', { class: 'field' }, h('label', {}, 'Visible'), h('label', { class: 'toggle' }, (() => { const c = h('input', { type: 'checkbox', checked: obj.visible || undefined }); c.addEventListener('change', () => app.setProperty(obj, 'visible', [c.checked], { label: 'Visibility' })); return c; })()), h('span', { style: { flex: 1 } }), keyButton(obj, 'visible')));
      if (mats[0] && mats[0].color && !mats[0].vertexColors) s.append(colorRow('Color', obj, 'material.color'));
      if (mats[0]) s.append(sliderRow('Opacity', obj, 'material.opacity', 0, 1));
      if (mats[0] && mats[0].emissive) s.append(sliderRow('Glow', obj, 'material.emissiveIntensity', 0, 5));
      if (mats[0] && 'wireframe' in mats[0]) {
        const c = h('input', { type: 'checkbox', checked: mats[0].wireframe || undefined });
        c.addEventListener('change', () => { mats.forEach((m) => { m.wireframe = c.checked; }); app.viewport.requestRender(); });
        s.append(h('div', { class: 'field' }, h('label', {}, 'Wireframe'), h('label', { class: 'toggle' }, c)));
      }
      if (mats.length > 1) s.append(h('div', { class: 'hint' }, `${mats.length} materials; color and opacity keys apply to the first.`));
      root.append(s);
    } else if (obj === model.root && !obj.isLight && !obj.isCamera) {
      root.append(sec('Appearance', h('div', { class: 'field' }, h('label', {}, 'Visible'), h('label', { class: 'toggle' }, (() => { const c = h('input', { type: 'checkbox', checked: obj.visible || undefined }); c.addEventListener('change', () => app.setProperty(obj, 'visible', [c.checked], { label: 'Visibility' })); return c; })()), h('span', { style: { flex: 1 } }), keyButton(obj, 'visible'))));
    }

    // shape keys
    const morphTargets = obj.morphTargetInfluences ? [obj] : (obj === model.root ? model.morphMeshes : []);
    for (const mm of morphTargets.slice(0, 6)) {
      const s = sec('Shape keys' + (mm !== obj ? ` · ${mm.name}` : ''));
      mm.morphTargetInfluences.slice(0, 40).forEach((_, i) => s.append(sliderRow(morphLabel(mm, `morphTargetInfluences[${i}]`) || `Shape ${i}`, mm, `morphTargetInfluences[${i}]`, 0, 1)));
      if (mm.morphTargetInfluences.length > 40) s.append(h('div', { class: 'hint' }, `Showing 40 of ${mm.morphTargetInfluences.length}.`));
      root.append(s);
    }

    // light / camera
    if (obj.isLight) {
      root.append(sec('Light', sliderRow('Intensity', obj, 'intensity', 0, obj.isDirectionalLight ? 10 : 100, 0.1), colorRow('Color', obj, 'color'),
        h('div', { class: 'field' }, h('label', {}, 'Shadows'), h('label', { class: 'toggle' }, (() => { const c = h('input', { type: 'checkbox', checked: obj.castShadow || undefined }); c.addEventListener('change', () => { obj.castShadow = c.checked; app.viewport.requestRender(); }); return c; })()))));
    }
    if (obj.isPerspectiveCamera) {
      const look = h('button', { class: 'btn sm', onclick: () => app.lookThrough(model) }, icon('camera'), app.viewport.activeCamera === obj ? 'Back to editor view' : 'Look through (0)');
      root.append(sec('Camera', sliderRow('Field of view', obj, 'fov', 10, 120, 0.5), h('div', { class: 'btns' }, look), h('div', { class: 'hint' }, 'Key the camera\'s position, rotation and field of view to animate shots. Record video while looking through it.')));
    }

    // model info
    if (obj === model.root || !obj.isBone) {
      let tris = 0;
      model.root.traverse((o) => { if (o.isMesh && o.geometry) tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position?.count || 0) / 3; });
      const info = h('div', { class: 'stat-grid' },
        'Source', h('b', {}, model.source || model.kind),
        'Triangles', h('b', {}, Math.round(tris).toLocaleString()),
        'Bones', h('b', {}, String(model.bones.length)),
        'Clips', h('b', {}, String(model.clips.length)),
        'Size', h('b', {}, `${fmt(model.box.getSize(new THREE.Vector3()).x, 2)} × ${fmt(model.box.getSize(new THREE.Vector3()).y, 2)} × ${fmt(model.box.getSize(new THREE.Vector3()).z, 2)}`),
        model.humanoid ? 'Rig' : null, model.humanoid ? h('b', {}, 'Humanoid (AI ready)') : null);
      const btns = h('div', { class: 'btns' },
        h('button', { class: 'btn sm', onclick: () => app.viewport.frameObject(model.root) }, icon('frame'), 'Frame'),
        h('button', { class: 'btn sm', onclick: () => ui.resetPose() }, icon('reset'), 'Rest pose'),
        h('button', { class: 'btn sm', onclick: () => app.duplicateModel(model) }, icon('copy'), 'Duplicate'),
        h('button', { class: 'btn sm danger', onclick: () => app.removeModel(model) }, icon('trash'), 'Delete'));
      const s = sec('Model · ' + model.name, info, btns);
      if (model.humanoid && (model.humanoid.height > 20 || model.humanoid.height < 0.2)) {
        s.append(h('div', { class: 'hint' }, `This character is ${fmt(model.humanoid.height, 2)} units tall (different units than meters).`),
          h('div', { class: 'btns' }, h('button', { class: 'btn sm', onclick: () => ui.fitHeight(model) }, 'Scale to 1.75 m')));
      }
      root.append(s);
    }
  };

  const refreshValues = rafThrottle(() => { for (const u of updaters) u(); for (const k of keyBtns) k(); });
  app.on('selection', render);
  app.on('models', () => { if (!app.selection.model) render(); });
  app.on('clips', (m) => { if (m && m === app.selection.model && !root.contains(document.activeElement)) render(); });
  app.on('transform', refreshValues);
  app.on('evaluated', refreshValues);
  app.on('keys', refreshValues);
  app.on('time', refreshValues);
  app.on('activeclip', refreshValues);
  app.on('history', refreshValues);
  render();
  ui.renderProperties = render;
}
