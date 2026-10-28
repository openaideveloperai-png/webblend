// Advanced: how the skin a bone moves dents when something presses it (soft skin).
// Select a bone and press Ctrl+Shift+4 (or "Indent…" in its properties).
import { h } from './dom.js';
import { modal } from './toast.js';
import { softSkin, partName } from '../anim/softskin.js';
import { translateName } from '../core/jp.js';

const DEFAULTS = { give: 1, depth: 1, width: 1, rim: 0, pale: 1, rigid: false, children: true };

export function openIndentEditor(app) {
  const model = app.selection.model, bone = app.selection.object;
  if (!model || !bone || !bone.isBone || !model.humanoid) {
    app.toast('Select a bone of a character first (click a joint, or pick it in the Scene list), then press Ctrl+Shift+4.', 'warn', 4500);
    return null;
  }
  if (model.softSkin === false) model.softSkin = true;
  const skin = softSkin(model);
  if (!skin) { app.toast(`${model.name} has no skin to dent (no skinned mesh on this rig).`, 'warn', 4000); return null; }
  model.indent = model.indent || {};
  const cur = { ...DEFAULTS, ...(model.indent[bone.uuid] || {}) };
  const label = (translateName(bone.name) || bone.name) + (translateName(bone.name) && translateName(bone.name) !== bone.name ? ` (${bone.name})` : '');
  const part = (() => { for (let p = bone; p; p = p.parent) { const k = model.humanoid.canonOf.get(p); if (k) return k; } return null; })();
  const info = h('div', { class: 'hint' });
  const refreshInfo = () => {
    const i = skin.boneInfo(bone, cur.children);
    info.textContent = i.count
      ? `${i.count.toLocaleString()} skin vertices follow this bone${cur.children ? ' (and its helper bones)' : ''}${part ? ` · ${partName(groupOf(part))}` : ''}. Flesh here up to ${i.fleshCm} cm; it can dent up to ${i.dentCm} cm.`
      : 'No skin follows this bone directly. Pick a bone the mesh is weighted to (or tick "helper bones").';
  };
  const apply = () => {
    const same = Object.keys(DEFAULTS).every((k) => cur[k] === DEFAULTS[k]);
    if (same) delete model.indent[bone.uuid]; else model.indent[bone.uuid] = { ...cur };
    model.indentVersion = (model.indentVersion || 0) + 1;
    skin.applyOverrides();
    skin.update({ force: true });
    refreshInfo();
    app.needsEval = true;
    app.viewport.requestRender();
  };
  const rows = [];
  const slider = (key, title, hint, min, max, step) => {
    const range = h('input', { type: 'range', min, max, step, value: cur[key], 'aria-label': title });
    const val = h('span', { class: 'val' });
    const show = () => { val.textContent = key === 'rim' ? (+cur[key]).toFixed(2) : `${(+cur[key]).toFixed(2)}×`; range.value = cur[key]; };
    range.addEventListener('input', () => { cur[key] = parseFloat(range.value); show(); apply(); });
    show();
    rows.push({ key, show });
    return h('div', {}, h('div', { class: 'field' }, h('label', { title: hint }, title), range, val), h('div', { class: 'hint', style: { margin: '-4px 0 8px' } }, hint));
  };
  const check = (key, title) => {
    const c = h('input', { type: 'checkbox', checked: cur[key] || undefined });
    c.addEventListener('change', () => { cur[key] = c.checked; apply(); });
    rows.push({ key, show: () => { c.checked = !!cur[key]; } });
    return h('div', { class: 'field' }, h('label', { class: 'toggle' }, c, title));
  };
  const body = h('div', { class: 'sec' },
    info,
    slider('give', 'Give', 'How much this part gives way when something presses it, against what presses it (a belly gives more than a hand).', 0, 3, 0.05),
    slider('depth', 'Depth limit', 'How deep it can dent before the bone under it stops it (times its flesh).', 0, 3, 0.05),
    slider('width', 'Crater width', 'How far the skin around a press is pulled down with it (the trampoline effect).', 0.1, 3, 0.05),
    slider('rim', 'Squeeze rim', 'Flesh rising in a ridge around the dent (squeezed tissue going somewhere).', 0, 1, 0.05),
    slider('pale', 'Paleness', 'How pale the skin goes where it\'s pressed (blood pushed out of it).', 0, 2, 0.05),
    check('rigid', 'Rigid: this part never dents'),
    check('children', 'Also its helper bones (twist, breast, skirt…; not the next body part)'),
    h('div', { class: 'btns', style: { justifyContent: 'flex-end' } },
      h('button', { class: 'btn ghost', onclick: () => { Object.assign(cur, DEFAULTS); for (const r of rows) r.show(); apply(); } }, 'Reset'),
      h('button', { class: 'btn primary', onclick: () => m.close() }, 'Done')));
  refreshInfo();
  const m = modal(`Indent · ${label}`, body, { width: 440 });
  return m;
}

const groupOf = (canon) => {
  const side = canon.startsWith('left') ? 'l' : canon.startsWith('right') ? 'r' : '';
  if (/UpperArm|Shoulder/.test(canon) && side) return /Shoulder/.test(canon) ? 'torso' : side + 'Arm';
  if (/LowerArm/.test(canon)) return side + 'Fore';
  if (/Hand/.test(canon)) return side + 'Hand';
  if (/UpperLeg/.test(canon)) return side + 'Thigh';
  if (/LowerLeg/.test(canon)) return side + 'Shin';
  if (/Foot|Toes/.test(canon)) return side + 'Foot';
  if (canon === 'head') return 'head';
  if (canon === 'neck') return 'neck';
  return 'torso';
};
