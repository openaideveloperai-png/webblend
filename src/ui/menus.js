// Top bar menus, transform tools and viewport buttons.
import { h, icon } from './dom.js';
import { dropdown } from './toast.js';
import { PRIMITIVES } from '../scene/primitives.js';
import { exportGLB, screenshot, recordVideo, exportClipJSON } from '../io/export.js';
import { ACCEPT } from '../io/importer.js';

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
  const space = h('button', { class: 'tbtn', title: 'Toggle local / world axes (Q)', onclick: () => app.setGizmoSpace(app.gizmoSpace === 'local' ? 'world' : 'local') });
  tools.append(space);
  const sync = () => {
    for (const [m, b] of Object.entries(btns)) b.classList.toggle('on', app.gizmoMode === m);
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
