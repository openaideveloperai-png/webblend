// Advanced character settings: which bones are the lips, more mouths, where the soft skin
// is switched off, and every soft-skin number (timing, crater, depth, the solid body's
// limit). Opened from the character's properties or Tools → Advanced character settings.
import { h, icon } from './dom.js';
import { modal } from './toast.js';
import { softLips, softLipsExtra, resetLips } from '../anim/softlips.js';
import { softSkin, SKIN_TUNE } from '../anim/softskin.js';
import { lipBones, partBones } from '../anim/select.js';
import { BONE_PARTS } from '../core/settings.js';
import { translateName } from '../core/jp.js';

const nice = (b) => { const t = translateName(b.name); return t && t !== b.name ? `${t} (${b.name})` : b.name; };

export function openAdvanced(app, model) {
  model = model || app.selection.model;
  if (!model || !model.humanoid) { app.toast('Select a character first.', 'warn'); return null; }
  const body = h('div', {});
  const redraw = () => { app.needsEval = true; app.viewport.requestRender(); };
  const sec = (id, title, ...kids) => h('div', { class: 'sec', id: 'adv-' + id }, h('div', { class: 'sec-h' }, h('span', { class: 'sec-t' }, title)), ...kids);
  const chips = (bones, max = 24) => h('div', { class: 'adv-chips' }, ...bones.slice(0, max).map((b) => h('span', { class: 'chip' }, nice(b))), bones.length > max ? h('span', { class: 'hint' }, `+${bones.length - max} more`) : null);
  const selected = () => app.selectedBones().filter((b) => model.bones.includes(b));

  const draw = () => {
    const lips = lipBones(model);
    const own = Array.isArray(model.lipBones) && model.lipBones.length;
    const main = softLips(model);
    const extra = softLipsExtra(model);
    const sel = selected();
    // ---- lips
    const lipSec = sec('lips', 'Lips',
      h('div', { class: 'hint' }, own ? 'Your lip bones:' : lips.length ? 'Found automatically (by name or by the mouth\'s vertices):' : 'No lip bones found on this rig.'),
      lips.length ? chips(lips) : null,
      h('div', { class: 'hint' }, main ? `Soft lips: ${main.N.toLocaleString()} lip vertices${model.softLips === false ? ' (switched off)' : ''}.` : own ? 'Those bones don\'t move enough mouth vertices (an upper and a lower lip) for soft lips. Pick the bones the lips are weighted to.' : 'Soft lips need lip bones or a mouth-open shape key.'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn sm amber', disabled: !sel.length || undefined, title: 'Select the lip bones first (Shift+click their dots)', onclick: () => { model.lipBones = sel.map((b) => b.name); resetLips(model); draw(); redraw(); app.emit('selection', app.selection); } }, icon('bone'), `Use the ${sel.length || ''} selected bone${sel.length === 1 ? '' : 's'} as the lips`),
        h('button', { class: 'btn sm', disabled: !lips.length || undefined, onclick: () => app.selectBones(lips, model) }, 'Select them'),
        own ? h('button', { class: 'btn sm ghost', onclick: () => { delete model.lipBones; resetLips(model); draw(); redraw(); } }, icon('reset'), 'Find automatically') : null),
      toggleRow('Soft lips on', model.softLips !== false, (v) => { model.softLips = v; if (!v) { main?.clear(); for (const x of extra) x.clear(); } redraw(); }));
    // ---- more mouths
    const mouths = model.extraMouths || [];
    const mouthRows = mouths.map((mo, i) => {
      const bones = model.bones.filter((b) => mo.bones.includes(b.name));
      const sl = extra.find((x) => x.layerName === 'lips' + (i + 1));
      const name = h('input', { class: 'inp', type: 'text', value: mo.name || `Mouth ${i + 2}`, 'aria-label': 'Mouth name', style: { width: '130px' } });
      name.addEventListener('change', () => { mo.name = name.value; });
      return h('div', { class: 'adv-row' }, name,
        h('span', { class: 'hint grow' }, `${bones.length} bone${bones.length === 1 ? '' : 's'} · ${sl ? sl.N.toLocaleString() + ' lip vertices' : 'not enough lip vertices'}`),
        h('button', { class: 'btn sm', onclick: () => app.selectBones(bones, model) }, 'Select'),
        h('button', { class: 'btn sm ghost', 'aria-label': 'Remove mouth', onclick: () => { mouths.splice(i, 1); model.extraMouths = mouths; resetLips(model); draw(); redraw(); } }, icon('trash')));
    });
    const mouthSec = sec('mouths', 'More mouths',
      h('div', { class: 'hint' }, 'A character with more than one mouth: select the lip bones of another mouth and add it. Each gets its own soft lips, and the soft skin leaves it alone too.'),
      ...mouthRows,
      h('div', { class: 'btns' }, h('button', { class: 'btn sm amber', disabled: !sel.length || undefined, onclick: () => { model.extraMouths = [...mouths, { name: `Mouth ${mouths.length + 2}`, bones: sel.map((b) => b.name) }]; resetLips(model); draw(); redraw(); } }, icon('plus'), 'Add a mouth from the selected bones')));
    // ---- where the soft skin is
    const ind = model.indent || {};
    const withSettings = model.bones.filter((b) => ind[b.uuid]);
    const setRigid = (bones, rigid) => {
      model.indent = model.indent || {};
      for (const b of bones) {
        const cur = { ...(model.indent[b.uuid] || {}) };
        if (rigid) cur.rigid = true; else delete cur.rigid;
        if (Object.keys(cur).length) model.indent[b.uuid] = cur; else delete model.indent[b.uuid];
      }
      model.indentVersion = (model.indentVersion || 0) + 1;
      const s = model._skin; if (s) { s.applyOverrides(); s.update({ force: true }); }
      draw(); redraw();
    };
    const partSel = h('select', { 'aria-label': 'Body part' }, ...BONE_PARTS.map(([k, l]) => h('option', { value: k }, l)));
    const whereSec = sec('where', 'Where the soft skin is',
      h('div', { class: 'hint' }, 'Switch the soft skin off where you don\'t want dents (that skin stays rigid and other parts dent against it), or back on. Per-bone depth, width and softness: select a bone and press Ctrl+Shift+4.'),
      h('div', { class: 'btns' },
        h('button', { class: 'btn sm', disabled: !sel.length || undefined, onclick: () => setRigid(sel, true) }, `No soft skin on the ${sel.length || ''} selected bone${sel.length === 1 ? '' : 's'}`),
        h('button', { class: 'btn sm', disabled: !sel.length || undefined, onclick: () => setRigid(sel, false) }, 'Soft skin back on them')),
      h('div', { class: 'adv-row' }, partSel,
        h('button', { class: 'btn sm', onclick: () => setRigid(partBones(model, partSel.value), true) }, 'No soft skin there'),
        h('button', { class: 'btn sm ghost', onclick: () => setRigid(partBones(model, partSel.value), false) }, 'Back on')),
      withSettings.length ? h('div', { class: 'adv-list' }, ...withSettings.map((b) => h('div', { class: 'adv-row' },
        h('span', { class: 'grow' }, nice(b)),
        h('span', { class: 'hint' }, ind[b.uuid].rigid ? 'no soft skin' : 'own dent settings'),
        h('button', { class: 'btn sm ghost', 'aria-label': 'Clear', onclick: () => { delete model.indent[b.uuid]; setRigid([], false); } }, icon('close'))))) : h('div', { class: 'hint' }, 'Soft skin is on everywhere.'),
      toggleRow('Soft skin on', model.softSkin !== false, (v) => { model.softSkin = v; if (!v && model._skin) model._skin.clear(); redraw(); }),
      toggleRow('Solid body (limbs stop at the dent limit)', model.solidBody !== false, (v) => { model.solidBody = v; model._solidLast = null; if (!v && model._solid) { for (const [b, e] of model._solid) if (b.quaternion.equals(e.applied)) b.quaternion.copy(e.base); model._solid.clear(); } redraw(); }));
    // ---- the numbers
    const T = (model.skinTune = model.skinTune || {});
    const get = (k) => (T[k] === undefined ? SKIN_TUNE[k] : T[k]);
    const set = (k, v, rebuild) => {
      if (v === SKIN_TUNE[k]) delete T[k]; else T[k] = v;
      if (rebuild) { if (model._skin) model._skin.clear(); model._skin = undefined; }
      else { model.indentVersion = (model.indentVersion || 0) + 1; const s = model._skin; if (s) { s.applyOverrides(); s.update({ force: true }); } }
      redraw();
    };
    const num = (label, k, min, max, step, { scale = 1, unit = '', rebuild = false, hint = '' } = {}) => {
      const r = h('input', { type: 'range', min, max, step, value: get(k) * scale, 'aria-label': label, id: 'adv-' + k });
      const val = h('span', { class: 'val' });
      const show = () => { val.textContent = (+(get(k) * scale).toFixed(3)) + unit; };
      show();
      r.addEventListener('input', () => { set(k, parseFloat(r.value) / scale, false); show(); });
      if (rebuild) r.addEventListener('change', () => set(k, parseFloat(r.value) / scale, true));
      return h('div', { class: 'field' }, h('label', { title: hint }, label), r, val);
    };
    const softness = h('input', { type: 'range', min: 0.3, max: 2, step: 0.05, value: model.softSkinSoftness ?? 1, 'aria-label': 'Softness' });
    const softVal = h('span', { class: 'val' }, String(model.softSkinSoftness ?? 1));
    softness.addEventListener('input', () => { model.softSkinSoftness = parseFloat(softness.value); softVal.textContent = String(model.softSkinSoftness); if (model._skin) model._skin.update({ force: true }); redraw(); });
    const anat = h('input', { type: 'checkbox', checked: get('anatomy') !== false || undefined, id: 'adv-anatomy' });
    anat.addEventListener('change', () => set('anatomy', anat.checked, true));
    const tuneSec = sec('tune', 'Soft skin numbers',
      h('div', { class: 'field' }, h('label', { title: 'How far the flesh gives way' }, 'Softness'), softness, softVal),
      num('Spring back time', 'settleOut', 0.02, 1, 0.01, { unit: ' s', hint: 'How long pressed skin takes to spring back once let go' }),
      num('Press settle time', 'settleIn', 0.005, 0.3, 0.005, { unit: ' s', hint: 'How fast the crater around a press settles' }),
      num('Crater width', 'crater', 0.2, 3, 0.05, { unit: '×', hint: 'How far around a press the skin is pulled down with it' }),
      num('Dent depth limit', 'depth', 0, 3, 0.05, { unit: '×', hint: 'How deep the skin can dent before the bone stops it' }),
      num('Solid body turn limit', 'maxTurn', 0, 1.57, 0.01, { scale: 180 / Math.PI, unit: '°', hint: 'The most an arm is turned back so it doesn\'t go through the body' }),
      num('Mouth zone size', 'mouthZone', 0.3, 3, 0.05, { unit: '×', rebuild: true, hint: 'How much skin around each mouth is left to the soft lips' }),
      h('div', { class: 'field' }, h('label', { class: 'toggle', for: 'adv-anatomy' }, anat, 'Anatomy (bone, muscle and fat give differently); off = the same flesh everywhere')),
      h('div', { class: 'btns' }, h('button', { class: 'btn sm ghost', onclick: () => { model.skinTune = {}; if (model._skin) model._skin.clear(); model._skin = undefined; model.indentVersion = (model.indentVersion || 0) + 1; draw(); redraw(); } }, icon('reset'), 'Reset the numbers')));
    body.replaceChildren(lipSec, mouthSec, whereSec, tuneSec,
      h('div', { class: 'hint', style: { marginTop: '8px' } }, 'These are kept with the scene (.glb) and copied with a duplicated character. Tip: select bones first (Shift+click, or Tools → Select…), then come back here.'));
  };
  draw();
  const off = app.on('selection', () => { if (body.isConnected) draw(); });
  const m = modal(`Advanced · ${model.name}`, body, { width: 640, onClose: () => off() });
  // make sure the soft skin exists so the lists are right
  try { softSkin(model); } catch { /* shown as off */ }
  return m;
}

function toggleRow(label, on, fn) {
  const c = h('input', { type: 'checkbox', checked: on || undefined });
  c.addEventListener('change', () => fn(c.checked));
  return h('div', { class: 'field' }, h('label', { class: 'toggle' }, c, label));
}
