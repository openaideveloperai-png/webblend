// Top bar menus, transform tools and viewport buttons.
import { h, icon } from './dom.js';
import { dropdown } from './toast.js';
import { PRIMITIVES } from '../scene/primitives.js';
import { exportGLB, screenshot, recordVideo, exportClipJSON } from '../io/export.js';
import { openExportDialog } from './export-dialog.js';
import { ACCEPT } from '../io/importer.js';
import { lipBones, fingerBones, partBones, partOf, childBones, mirrorBone } from '../anim/select.js';
import { BONE_PARTS } from '../core/settings.js';
import { openAdvanced } from './advanced.js';
import { softLips, softLipsExtra, resetLips } from '../anim/softlips.js';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? '⌘' : 'Ctrl+';

export function openFiles(app) {
  const inp = document.getElementById('file-input');
  inp.accept = ACCEPT;
  inp.value = '';
  inp.onchange = () => app.importFiles([...inp.files].map((f) => ({ path: f.name, file: f })));
  inp.click();
}

export function openFolder(app) {
  const inp = document.getElementById('folder-input');
  inp.value = '';
  inp.onchange = () => app.importFiles([...inp.files].map((f) => ({ path: f.webkitRelativePath || f.name, file: f })));
  inp.click();
}

export function openAnimationFor(app, model) {
  const inp = document.getElementById('anim-input');
  inp.accept = '.fbx,.glb,.gltf,.bvh,.vmd,.json,.dae,.blend,.zip';
  inp.value = '';
  inp.onchange = async () => {
    if (model) app.select(model.root, model);
    await app.importFiles([...inp.files].map((f) => ({ path: f.name, file: f })));
  };
  inp.click();
}

export function addMenuItems(app) {
  return [
    { header: 'Characters' },
    { label: 'Demo mannequin (rigged)', icon: 'person', action: () => app.addMannequin() },
    { sep: true },
    { header: 'Shapes' },
    ...Object.entries(PRIMITIVES).map(([k, p]) => ({ label: p.label, icon: 'mesh', action: () => app.addPrimitive(k) })),
    { label: 'Empty (pivot)', icon: 'target', action: () => app.addEmpty() },
    { sep: true },
    { header: 'Lights & camera' },
    { label: 'Point light', icon: 'light', action: () => app.addLight('point') },
    { label: 'Spot light', icon: 'light', action: () => app.addLight('spot') },
    { label: 'Sun light', icon: 'light', action: () => app.addLight('directional') },
    { label: 'Camera', icon: 'camera', action: () => app.addCamera() },
    { sep: true },
    { label: 'Image or model from file…', icon: 'image', action: () => openFiles(app) },
  ];
}

export function initMenus(app, ui) {
  const menus = document.getElementById('menus');
  const defs = {
    File: () => [
      { label: 'Open files…', icon: 'upload', kbd: MOD + 'O', action: () => openFiles(app) },
      { label: 'Open folder…', icon: 'folder', action: () => openFolder(app) },
      { label: 'Add animation to selected model…', icon: 'bone', disabled: !app.selection.model, action: () => openAnimationFor(app, app.selection.model) },
      { sep: true },
      { label: 'Save scene (.glb, reopen to keep editing)', icon: 'download', kbd: MOD + 'E', disabled: !app.models.length, action: () => exportGLB(app, app.models, 'webblend-scene') },
      { label: 'Export for Roblox, Unity, Unreal, Blender…', icon: 'download', disabled: !app.models.length, action: () => openExportDialog(app) },
      { label: 'Export selected model as GLB', icon: 'download', disabled: !app.selection.model, action: () => exportGLB(app, [app.selection.model]) },
      { label: 'Export active clip as JSON', icon: 'download', disabled: !app.selection.model?.activeClip, action: () => exportClipJSON(app, app.selection.model, app.selection.model.activeClip) },
      { sep: true },
      { label: 'Screenshot (PNG)', icon: 'image', action: () => screenshot(app) },
      { label: 'Record video of animation (WebM)', icon: 'film', action: () => ui.recordDialog() },
      { sep: true },
      { label: 'Clear scene', icon: 'trash', disabled: !app.models.length, action: () => ui.confirmClear() },
    ],
    Add: () => addMenuItems(app),
    Edit: () => [
      { label: 'Undo', icon: 'undo', kbd: MOD + 'Z', disabled: !app.history.undoStack.length, action: () => app.history.undo() },
      { label: 'Redo', icon: 'redo', kbd: MOD + 'Shift+Z', disabled: !app.history.redoStack.length, action: () => app.history.redo() },
      { sep: true },
      { label: 'Insert key on selection', icon: 'key', kbd: 'K', disabled: !app.selection.object, action: () => app.keySelection() },
      { label: 'Key whole pose (all bones)', icon: 'key', kbd: 'Shift+K', disabled: !app.selection.model, action: () => app.keyPose() },
      { label: 'Delete keys at current frame', icon: 'keyo', kbd: 'Alt+K', disabled: !app.selection.object, action: () => app.deleteKeysAt() },
      { sep: true },
      { label: 'Copy pose', icon: 'copy', kbd: MOD + 'C', disabled: !app.selection.model, action: () => ui.copyPose() },
      { label: 'Paste pose', icon: 'copy', kbd: MOD + 'V', disabled: !ui.poseClipboard, action: () => ui.pastePose() },
      { label: 'Reset pose to rest', icon: 'reset', disabled: !app.selection.model, action: () => ui.resetPose() },
      { sep: true },
      { label: 'Duplicate model', icon: 'copy', kbd: MOD + 'D', disabled: !app.selection.model, action: () => app.duplicateModel(app.selection.model) },
      { label: 'Delete model', icon: 'trash', kbd: 'Del', disabled: !app.selection.model, action: () => app.removeModel(app.selection.model) },
    ],
    Tools: () => toolsMenu(app, ui),
    View: () => [
      { label: 'Frame selected', icon: 'frame', kbd: 'F', disabled: !app.selection.object, action: () => app.viewport.frameObject(app.selection.object) },
      { label: 'Frame everything', icon: 'frame', kbd: 'Shift+F', action: () => app.viewport.frameAll() },
      { sep: true },
      { label: 'Front view', kbd: '1', action: () => app.viewport.setView('front') },
      { label: 'Right view', kbd: '3', action: () => app.viewport.setView('right') },
      { label: 'Top view', kbd: '7', action: () => app.viewport.setView('top') },
      { label: 'Perspective', kbd: '5', action: () => app.viewport.setView('persp') },
      { label: app.viewport.fly.on ? 'Leave fly mode' : 'Fly mode (WASD)', icon: 'fly', kbd: '`', action: () => app.viewport.fly.toggle() },
      ...app.models.filter((m) => m.root.isCamera).map((m) => ({ label: `Look through "${m.name}"`, icon: 'camera', kbd: '0', action: () => app.lookThrough(m) })),
      { sep: true },
      { label: (app.settings.get('showGrid') ? 'Hide' : 'Show') + ' grid', action: () => app.setSetting('showGrid', !app.settings.get('showGrid')) },
      { label: (app.settings.get('showSkeleton') ? 'Hide' : 'Show') + ' bones', icon: 'bone', action: () => app.setSetting('showSkeleton', !app.settings.get('showSkeleton')) },
      { label: (app.settings.get('showStats') ? 'Hide' : 'Show') + ' performance stats', action: () => ui.toggleStats() },
      { label: (app.settings.get('showEffects') === false ? 'Show' : 'Hide') + ' effects (trails, particles…)', icon: 'sparkle', action: () => app.setSetting('showEffects', app.settings.get('showEffects') === false) },
      { label: (app.settings.get('autoRotate') ? 'Stop turntable' : 'Turntable (slowly orbit the view)'), icon: 'reset', action: () => app.setSetting('autoRotate', !app.settings.get('autoRotate')) },
      { sep: true },
      { label: 'Keyboard shortcuts', icon: 'info', kbd: '?', action: () => ui.shortcuts() },
    ],
  };
  for (const name of Object.keys(defs)) {
    const b = h('button', { class: 'menu-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, name);
    b.addEventListener('click', () => dropdown(defs[name](), { anchor: b }));
    b.addEventListener('pointerenter', () => {
      const open = document.querySelector('.dropdown');
      if (open && document.querySelector('.menu-btn[aria-expanded="true"]') && b.getAttribute('aria-expanded') !== 'true') dropdown(defs[name](), { anchor: b });
    });
    menus.append(b);
  }
  // compact menu for phones
  ui.allMenus = () => [
    { header: 'File' }, ...defs.File().slice(0, 6),
    { header: 'Add' }, ...defs.Add().filter((i) => i.label && i.label !== 'Image or model from file…').slice(0, 12),
    { header: 'View' }, ...defs.View().slice(0, 2), defs.View().find((i) => i.icon === 'fly'),
    { sep: true },
    { label: 'Settings…', icon: 'gear', action: () => ui.openSettings() },
  ];

  // transform tools
  const tools = document.getElementById('gizmo-tools');
  const modes = [['translate', 'move', 'Move', 'W'], ['rotate', 'rotate', 'Rotate', 'E'], ['scale', 'scale', 'Scale', 'R']];
  const btns = {};
  for (const [mode, ic, label, k] of modes) {
    const b = h('button', { class: 'tbtn', title: `${label} (${k})`, 'aria-label': label, onclick: () => app.setGizmoMode(mode) }, icon(ic), h('span', { class: 'lbl' }, label));
    btns[mode] = b;
    tools.append(b);
  }
  // uniform scale: every scale handle scales all axes equally
  const uni = h('button', { class: 'tbtn', title: 'Uniform scale: scale equally on all sides (Shift+R)', 'aria-label': 'Uniform scale', onclick: () => { app.setUniformScale(!app.settings.get('uniformScale')); if (app.settings.get('uniformScale')) app.setGizmoMode('scale'); } }, icon('frame'), h('span', { class: 'lbl' }, 'Uniform'));
  tools.append(uni);
  const space = h('button', { class: 'tbtn', title: 'Toggle local / world axes (Q)', onclick: () => app.setGizmoSpace(app.gizmoSpace === 'local' ? 'world' : 'local') });
  tools.append(space);
  const sync = () => {
    for (const [m, b] of Object.entries(btns)) b.classList.toggle('on', app.gizmoMode === m);
    uni.classList.toggle('on', !!app.settings.get('uniformScale'));
    uni.setAttribute('aria-pressed', String(!!app.settings.get('uniformScale')));
    space.replaceChildren(icon(app.gizmoSpace === 'local' ? 'local' : 'globe'), h('span', { class: 'lbl' }, app.gizmoSpace === 'local' ? 'Local' : 'World'));
  };
  app.on('gizmo', sync);
  app.on('selection', sync);
  sync();

  // viewport corner tools
  const vt = document.getElementById('vp-tools');
  const vbtn = (ic, title, fn) => { const b = h('button', { class: 'vp-tool', title, 'aria-label': title, onclick: fn }, icon(ic)); vt.append(b); return b; };
  vbtn('frame', 'Frame everything (Shift+F)', () => app.viewport.frameAll());
  vbtn('target', 'Frame selected (F)', () => app.selection.object && app.viewport.frameObject(app.selection.object));
  vbtn('bone', 'Show / hide bones', () => app.setSetting('showSkeleton', !app.settings.get('showSkeleton')));
  const flyBtn = vbtn('fly', 'Fly mode: move with WASD (`)', () => app.viewport.fly.toggle());
  app.on('fly', (on) => { flyBtn.classList.toggle('on', on); flyBtn.setAttribute('aria-pressed', String(on)); });
  vbtn('image', 'Screenshot', () => screenshot(app));

  document.getElementById('btn-add-quick').append(icon('plus'));
  document.getElementById('btn-add-quick').addEventListener('click', (e) => dropdown(addMenuItems(app), { anchor: e.currentTarget }));
  document.getElementById('search-ico').replaceWith(icon('search'));
}

// Tools: select groups of bones (the lips, fingers, a body part…), spread them, and the
// tools added from the console this session
export function toolsMenu(app, ui) {
  const m = app.selection.model;
  const bone = app.selection.object && app.selection.object.isBone ? app.selection.object : null;
  const pick = (bones, what) => {
    if (!m) return;
    if (!bones.length) { app.toast(`No ${what} found on this model`, 'warn'); return; }
    app.selectBones(bones, m);
    app.toast(`${bones.length} ${what} selected · drag to move them together, hold Ctrl while moving to spread them apart`, 'ok', 3200);
  };
  const add = (bones, what) => pick([...app.selectedBones().filter((b) => !bones.includes(b)), ...bones], what);
  const sel = app.selectedBones();
  const items = [
    { header: 'Select bones' },
    { label: m && m.lipBones && m.lipBones.length ? `Lip bones (yours: ${m.lipBones.length})` : 'Lip bones (all the lips)', icon: 'bone', disabled: !m || !m.bones.length, action: () => pick(lipBones(m), 'lip bones') },
    { label: 'Face bones', icon: 'bone', disabled: !m || !m.bones.length, action: () => pick(partBones(m, 'face'), 'face bones') },
    { label: 'Fingers: left hand', icon: 'bone', disabled: !m || !m.humanoid, action: () => pick(fingerBones(m, 'left'), 'finger bones') },
    { label: 'Fingers: right hand', icon: 'bone', disabled: !m || !m.humanoid, action: () => pick(fingerBones(m, 'right'), 'finger bones') },
    { label: 'Same body part as this bone', icon: 'bone', disabled: !bone, action: () => pick(partBones(m, partOf(m, bone)).filter((b) => b !== bone).concat(bone), 'bones') },
    { label: 'This bone and everything under it', icon: 'bone', disabled: !bone, action: () => pick([...childBones(bone), bone], 'bones') },
    { label: 'Add the other side (left ↔ right)', icon: 'mirror', disabled: !sel.length, action: () => add(sel.map((b) => mirrorBone(m, b)).filter(Boolean), 'bones') },
    { label: 'Body part…', icon: 'bone', disabled: !m || !m.bones.length, action: () => setTimeout(() => dropdown(BONE_PARTS.map(([k, label]) => ({ label, action: () => pick(partBones(m, k), label.toLowerCase() + ' bones') })), { anchor: [...document.querySelectorAll('.menu-btn')].find((b) => b.textContent === 'Tools') }), 0) },
    { label: 'Keep only the active bone', icon: 'close', disabled: sel.length < 2, action: () => app.select(bone, m) },
    { sep: true },
    { header: 'Selected bones' },
    { label: 'Spread apart (+15%)', icon: 'plus', disabled: sel.length < 2, action: () => app.spreadSelected(0.15) },
    { label: 'Bring together (−15%)', icon: 'minus', disabled: sel.length < 2, action: () => app.spreadSelected(-0.15) },
    { label: (app.settings.get('uniformScale') ? '✓ ' : '') + 'Uniform scale', icon: 'frame', kbd: 'Shift+R', action: () => app.setUniformScale(!app.settings.get('uniformScale')) },
    { sep: true },
    { header: 'Lips & mouths' },
    { label: `Make the ${sel.length > 1 ? sel.length + ' ' : ''}selected bone${sel.length === 1 ? '' : 's'} the lips`, icon: 'bone', disabled: !m || !m.humanoid || !sel.length, action: () => {
      m.lipBones = sel.map((b) => b.name);
      resetLips(m);
      const s = softLips(m);
      app.toast(s ? `Lips set: ${sel.length} bone${sel.length === 1 ? '' : 's'}, ${s.N.toLocaleString()} lip vertices. Tools → Lip bones selects them now, and the soft lips use them.` : `Lip bones set (${sel.length}), but soft lips can't use them: ${m._lipWhy || 'they don\'t move an upper and a lower lip'}. Tools → Lip bones still selects them.`, s ? 'ok' : 'warn', 4500);
      app.needsEval = true; app.viewport.requestRender();
    } },
    { label: 'Add the selected bones as another mouth', icon: 'plus', disabled: !m || !m.humanoid || !sel.length, action: () => {
      const n = (m.extraMouths || []).length + 2;
      m.extraMouths = [...(m.extraMouths || []), { name: `Mouth ${n}`, bones: sel.map((b) => b.name) }];
      resetLips(m);
      const x = softLipsExtra(m);
      const ok = x.length === m.extraMouths.length;
      app.toast(ok ? `Mouth ${n} added (${sel.length} bones): it has its own soft lips, and the soft skin leaves it alone. Manage mouths in Tools → Advanced character settings.` : `Mouth ${n} added, but its bones don't move an upper and a lower lip soft lips can use. Manage mouths in Tools → Advanced character settings.`, ok ? 'ok' : 'warn', 5000);
      app.needsEval = true; app.viewport.requestRender();
    } },
    { label: 'Find the lips automatically again', icon: 'reset', disabled: !m || !(m.lipBones && m.lipBones.length), action: () => { delete m.lipBones; resetLips(m); app.toast('Lip bones are found automatically again', 'ok'); app.needsEval = true; app.viewport.requestRender(); } },
    { label: 'Advanced character settings… (lips, mouths, soft skin)', icon: 'gear', disabled: !m || !m.humanoid, action: () => openAdvanced(app, m) },
  ];
  const own = app.sessionTools || [];
  if (own.length || app.consoleUnlocked) items.push({ sep: true }, { header: 'This session' });
  for (const t of own) items.push({ label: t.name, icon: t.icon || 'wand', kbd: t.key || undefined, action: () => app.runTool(t) });
  if (app.consoleUnlocked) items.push({ label: 'Console…', icon: 'dots', action: () => ui.openConsole?.() });
  return items;
}
