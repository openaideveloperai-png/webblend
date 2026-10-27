// Entry point: builds the UI around the App.
import * as THREE from 'three';
import { App } from './core/app.js';
import { h, icon } from './ui/dom.js';
import { initToasts, modal, dropdown, confirmDialog } from './ui/toast.js';
import { initMenus, openFiles, openFolder, MOD } from './ui/menus.js';
import { initOutliner } from './ui/outliner.js';
import { initProperties } from './ui/properties.js';
import { initAnimations } from './ui/animations.js';
import { initTimeline } from './ui/timeline.js';
import { initAIPanel } from './ui/ai-panel.js';
import { openSettings, SHORTCUTS } from './ui/settings.js';
import { filesFromDataTransfer } from './io/vfs.js';
import { exportGLB, recordVideo } from './io/export.js';
import { QUALITY_LEVELS, QUALITY_PRESETS } from './core/settings.js';
import { store, isTextInput, fmtBytes } from './core/util.js';
import { bakeHumanoid } from './anim/motions.js';

function boot() {
  const appEl = document.getElementById('app');
  const ui = {};
  let app;
  try {
    app = new App({ viewport: document.getElementById('viewport') });
  } catch (e) {
    console.error(e);
    document.getElementById('viewport').append(h('div', { class: 'empty-state' }, h('div', { class: 'empty-card' }, h('h2', {}, 'WebGL is not available'), h('p', {}, 'This browser or computer can\'t run 3D graphics right now. Update your browser, enable hardware acceleration in its settings, or try Chrome, Edge or Firefox.'))));
    return;
  }
  window.webblend = app; // handy for debugging from the console
  window.__exportGLB = exportGLB;
  window.__recordVideo = recordVideo;
  initToasts(app);
  app.on('fatal', (m) => app.toast(m, 'error', 0));

  // ------------------------------------------------------------ layout sizes
  const sizes = store.get('animator.layout', {});
  const applySizes = () => {
    if (sizes.left) appEl.style.setProperty('--left-w', sizes.left + 'px');
    if (sizes.right) appEl.style.setProperty('--right-w', sizes.right + 'px');
    if (sizes.timeline) { appEl.style.setProperty('--tl-h', sizes.timeline + 'px'); document.documentElement.style.setProperty('--tl-h', sizes.timeline + 'px'); }
  };
  applySizes();
  for (const r of document.querySelectorAll('.resizer')) {
    r.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      r.setPointerCapture(e.pointerId);
      r.classList.add('drag');
      const kind = r.dataset.resize;
      const move = (ev) => {
        if (kind === 'left') sizes.left = Math.max(160, Math.min(480, ev.clientX));
        if (kind === 'right') sizes.right = Math.max(240, Math.min(560, window.innerWidth - ev.clientX));
        if (kind === 'timeline') sizes.timeline = Math.max(110, Math.min(window.innerHeight - 200, window.innerHeight - ev.clientY));
        applySizes();
      };
      const up = () => { r.classList.remove('drag'); r.removeEventListener('pointermove', move); r.removeEventListener('pointerup', up); store.set('animator.layout', sizes); };
      r.addEventListener('pointermove', move);
      r.addEventListener('pointerup', up);
    });
  }

  // phone drawers
  const left = document.getElementById('left-panel'), right = document.getElementById('right-panel');
  const btnLeft = document.getElementById('btn-left'), btnRight = document.getElementById('btn-right');
  btnLeft.append(icon('panelLeft'));
  btnRight.append(icon('panelRight'));
  btnLeft.addEventListener('click', () => { left.classList.toggle('open'); right.classList.remove('open'); });
  btnRight.addEventListener('click', () => { right.classList.toggle('open'); left.classList.remove('open'); });
  document.getElementById('viewport').addEventListener('pointerdown', () => { left.classList.remove('open'); right.classList.remove('open'); });

  // ------------------------------------------------------------ tabs
  const tabsEl = document.getElementById('tabs');
  const tabs = [['props', 'Properties', 'gear'], ['anims', 'Animations', 'film'], ['ai', 'AI', 'sparkle']];
  const tabBtns = {};
  const showTab = (id) => {
    for (const [tid] of tabs) {
      document.getElementById('tab-' + tid).hidden = tid !== id;
      tabBtns[tid].classList.toggle('on', tid === id);
      tabBtns[tid].setAttribute('aria-selected', String(tid === id));
    }
    document.getElementById('btn-ai').classList.toggle('on', id === 'ai');
    store.set('animator.tab', id);
    if (id === 'ai') setTimeout(() => document.getElementById('ai-prompt')?.focus(), 30);
  };
  for (const [id, label, ic] of tabs) {
    const b = h('button', { class: 'tab' + (id === 'ai' ? ' ai-tab' : ''), role: 'tab', 'aria-controls': 'tab-' + id }, icon(ic), label);
    b.addEventListener('click', () => showTab(id));
    tabBtns[id] = b;
    tabsEl.append(b);
  }
  ui.showTab = showTab;

  // ------------------------------------------------------------ helpers used by menus/panels
  ui.poseClipboard = null;
  ui.copyPose = () => {
    const m = app.selection.model;
    if (!m) return;
    const targets = m.bones.length ? m.bones : [m.root];
    ui.poseClipboard = { names: targets.map((o) => o.name), data: targets.map((o) => ({ p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() })), rig: m.humanoid ? true : false };
    app.toast(`Copied pose of ${m.name}`, 'ok', 1200);
    ui.renderProperties?.();
  };
  ui.pastePose = () => {
    const m = app.selection.model, cb = ui.poseClipboard;
    if (!m || !cb) return;
    const targets = m.bones.length ? m.bones : [m.root];
    const byName = new Map(targets.map((o) => [o.name, o]));
    const changed = [];
    cb.names.forEach((n, i) => {
      const o = byName.get(n);
      if (!o) return;
      changed.push([o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }, cb.data[i]]);
    });
    if (!changed.length) { app.toast('That pose doesn\'t match this model\'s bones', 'warn'); return; }
    const apply = (which) => { for (const c of changed) { const t = c[which]; c[0].position.copy(t.p); c[0].quaternion.copy(t.q); c[0].scale.copy(t.s); } app.afterEdit(); };
    apply(2);
    app.history.push({ label: 'Paste pose', undo: () => apply(1), redo: () => apply(2) });
    if (app.settings.get('autoKey')) app.keyPose(m);
    app.toast(`Pasted pose on ${changed.length} bones`, 'ok', 1200);
  };
  ui.resetPose = () => {
    const m = app.selection.model;
    if (!m) return;
    const objs = [...m.rest.keys()];
    const before = objs.map((o) => ({ p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
    m.resetPose();
    const after = objs.map((o) => ({ p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
    const apply = (arr) => { objs.forEach((o, i) => { o.position.copy(arr[i].p); o.quaternion.copy(arr[i].q); o.scale.copy(arr[i].s); }); app.afterEdit(); };
    app.history.push({ label: 'Rest pose', undo: () => apply(before), redo: () => apply(after) });
    app.afterEdit();
  };
  ui.fitHeight = (m) => {
    const k = 1.75 / m.humanoid.height;
    m.root.scale.multiplyScalar(k);
    m.root.updateMatrixWorld(true);
    m.captureRest();
    m.computeSize();
    m.buildJoints();
    m.humanoid = undefined;
    app.updateWorldScale();
    app.viewport.frameObject(m.root);
    ui.renderProperties?.();
  };
  ui.confirmClear = async () => { if (await confirmDialog('Clear scene', 'Remove every model and animation from the scene? This can\'t be undone.', 'Clear', true)) app.clearScene(); };
  ui.shortcuts = () => modal('Keyboard shortcuts', h('div', { class: 'sec' }, h('div', { class: 'shortcuts' }, ...SHORTCUTS.flatMap(([k, d]) => [h('kbd', {}, k), h('span', {}, d)]))), { width: 560 });
  ui.openSettings = (section) => openSettings(app, ui, section);
  ui.recordDialog = () => {
    const secs = h('input', { class: 'inp', type: 'number', min: 0.5, max: 120, step: 0.5, value: +app.duration().toFixed(2), style: { maxWidth: '90px' } });
    const bar = h('div', { class: 'progress' }, h('div'));
    const startBtn = h('button', { class: 'btn primary' }, icon('record'), 'Record');
    const body = h('div', { class: 'sec' },
      h('div', { class: 'field' }, h('label', {}, 'Seconds'), secs),
      h('div', { class: 'hint' }, 'Records the viewport exactly as you see it while the animation plays from the start (look through a camera first for a clean shot). Saves a .webm video.'),
      bar, h('div', { class: 'btns', style: { justifyContent: 'flex-end' } }, startBtn));
    const m = modal('Record video', body, { width: 420 });
    startBtn.addEventListener('click', async () => {
      startBtn.disabled = true;
      await recordVideo(app, { seconds: parseFloat(secs.value) || app.duration(), onProgress: (p) => { bar.firstChild.style.width = (p * 100).toFixed(1) + '%'; } });
      m.close();
    });
  };

  // stats overlay
  const statsEl = document.getElementById('stats');
  let statsTimer = null;
  ui.toggleStats = (on) => {
    const v = on ?? !app.settings.get('showStats');
    app.settings.set('showStats', v);
    statsEl.hidden = !v;
    clearInterval(statsTimer);
    if (v) statsTimer = setInterval(() => {
      const s = app.viewport.stats();
      const mem = performance.memory ? `\nmem   ${fmtBytes(performance.memory.usedJSHeapSize)}` : '';
      statsEl.textContent = `fps   ${app.transport.playing || app.viewport.interacting ? s.fps.toFixed(0) : 'idle'}\ndraw  ${s.calls}\ntris  ${s.triangles.toLocaleString()}\ngeo   ${s.geometries}  tex ${s.textures}${mem}\nmode  ${app.settings.get('quality')}`;
    }, 500);
  };
  if (app.settings.get('showStats')) ui.toggleStats(true);

  // fly mode: hint bar, speed readout, and arrow buttons on touch screens
  {
    const vpEl = document.getElementById('viewport');
    const speed = h('b', {}, '');
    const touch = matchMedia('(pointer: coarse)').matches;
    const exit = h('button', { class: 'btn small', onclick: () => app.viewport.fly.disable() }, 'Exit');
    const hud = h('div', { class: 'fly-hud', hidden: true, role: 'status' },
      h('span', { class: 'fly-title' }, icon('fly'), 'Fly mode'),
      touch
        ? h('span', {}, 'Drag to look · arrows to move')
        : h('span', {}, h('kbd', {}, 'W A S D'), ' move · ', h('kbd', {}, 'E'), '/', h('kbd', {}, 'Q'), ' up/down · right-drag look · ', h('kbd', {}, 'Shift'), ' fast · wheel speed'),
      h('span', { class: 'fly-speed' }, 'speed ', speed), exit);
    const pad = h('div', { class: 'fly-pad', hidden: true });
    const padBtn = (code, label, cls) => {
      const b = h('button', { class: 'fly-key ' + cls, 'aria-label': label }, label);
      const up = () => { app.viewport.fly.press(code, false); b.classList.remove('down'); };
      b.addEventListener('pointerdown', (e) => { e.preventDefault(); b.setPointerCapture?.(e.pointerId); app.viewport.fly.press(code, true); b.classList.add('down'); });
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('lostpointercapture', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      pad.append(b);
    };
    padBtn('KeyW', '▲', 'k-fwd'); padBtn('KeyA', '◀', 'k-left'); padBtn('KeyS', '▼', 'k-back'); padBtn('KeyD', '▶', 'k-right');
    padBtn('KeyE', 'Up', 'k-up'); padBtn('KeyQ', 'Down', 'k-down');
    vpEl.append(hud, pad);
    const showSpeed = (v) => { speed.textContent = (v || app.settings.get('flySpeed') || 1).toFixed(2).replace(/\.?0+$/, '') + '×'; };
    app.on('flyspeed', showSpeed);
    app.on('fly', (on) => { hud.hidden = !on; pad.hidden = !on || !touch; vpEl.classList.toggle('flying', on); showSpeed(); });
  }

  // ------------------------------------------------------------ panels
  initMenus(app, ui);
  initOutliner(app, ui);
  initProperties(app, ui);
  initAnimations(app, ui);
  initTimeline(app, ui);
  initAIPanel(app, ui);
  showTab(store.get('animator.tab', 'props'));

  // quality chip
  const qBtn = document.getElementById('btn-quality');
  const syncQ = () => {
    const q = app.settings.get('quality');
    document.getElementById('q-label').textContent = QUALITY_PRESETS[q]?.label || q;
    document.getElementById('q-dot').className = 'q-dot ' + (q === 'potato' ? 'potato' : q === 'low' ? 'low' : '');
  };
  qBtn.addEventListener('click', () => dropdown([
    { header: 'Quality mode' },
    ...QUALITY_LEVELS.slice().reverse().map((q) => ({ label: QUALITY_PRESETS[q].label + (app.settings.get('quality') === q ? '  ✓' : ''), icon: q === 'potato' ? 'potato' : 'mesh', action: () => app.setQuality(q) })),
    { sep: true },
    { label: (app.settings.get('autoQuality') ? '✓ ' : '') + 'Auto-switch when slow', action: () => app.setSetting('autoQuality', !app.settings.get('autoQuality')) },
    { label: 'Performance settings…', icon: 'gear', action: () => ui.openSettings('performance') },
  ], { anchor: qBtn }));
  app.on('quality', syncQ);
  syncQ();

  const aiBtn = document.getElementById('btn-ai');
  aiBtn.append(icon('sparkle'), h('span', {}, 'AI'));
  aiBtn.addEventListener('click', () => { showTab('ai'); right.classList.add('open'); left.classList.remove('open'); });
  const setBtn = document.getElementById('btn-settings');
  setBtn.append(icon('gear'));
  setBtn.addEventListener('click', () => ui.openSettings());

  // empty state
  const empty = document.getElementById('empty-state');
  document.getElementById('empty-btns').append(
    h('button', { class: 'btn primary', onclick: () => openFiles(app) }, icon('upload'), 'Open files'),
    h('button', { class: 'btn', onclick: () => openFolder(app) }, icon('folder'), 'Open folder'),
    h('button', { class: 'btn', onclick: () => demo(true) }, icon('person'), 'Demo character'));
  const syncEmpty = () => { empty.hidden = app.models.length > 0; };
  app.on('models', syncEmpty);

  // viewport label (camera)
  const vpLabel = document.getElementById('vp-label');
  app.on('camera', () => { vpLabel.textContent = app.viewport.activeCamera === app.viewport.camera ? 'Perspective' : 'Camera · ' + (app.viewport.activeCamera.name || 'camera'); });

  // import report
  app.on('report', (lines) => {
    const shown = lines.slice(0, 30);
    if (shown.length === 1 && shown[0].length < 140) { app.toast(shown[0], /can't|failed|not|missing|doesn't/i.test(shown[0]) ? 'warn' : 'info', 6000); return; }
    modal('Import notes', h('div', { class: 'sec' }, h('ul', { class: 'report' }, ...shown.map((l) => h('li', {}, l))), lines.length > 30 ? h('div', { class: 'hint' }, `…and ${lines.length - 30} more`) : null), { width: 560 });
  });

  // replace the untouched demo when the user imports their own model
  app.on('models', () => {
    const demoM = app.models.find((m) => m.root.userData.demo);
    const others = app.models.filter((m) => !m.root.userData.demo);
    if (demoM && others.some((m) => m.kind === 'import' || m.kind === 'skeleton') && !demoM.root.userData.touched) {
      demoM.root.userData.demo = false;
      app.removeModel(demoM);
    }
  });
  app.on('keys', (m) => { if (m && m.root.userData.demo) m.root.userData.touched = true; });
  app.on('gizmo:end', () => { const m = app.selection.model; if (m && m.root.userData.demo) m.root.userData.touched = true; });

  // ------------------------------------------------------------ drag & drop
  const overlay = document.getElementById('drop-overlay');
  let dragDepth = 0;
  const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; overlay.hidden = false; });
  window.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) overlay.hidden = true; });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) app.importFiles(files);
  });

  // ------------------------------------------------------------ keyboard
  window.addEventListener('keydown', (e) => {
    if (isTextInput(e.target) || document.querySelector('.modal-back')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    const kl = k.toLowerCase();
    const tlFocused = ui.timelineFocused?.();
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod && kl === 'z' && !e.shiftKey) { handled(); app.history.undo(); return; }
    if ((mod && kl === 'z' && e.shiftKey) || (mod && kl === 'y')) { handled(); app.history.redo(); return; }
    if (mod && kl === 'o') { handled(); openFiles(app); return; }
    if (mod && kl === 'e') { handled(); exportGLB(app, app.models, 'webblend-scene'); return; }
    if (mod && kl === 'd') { handled(); if (app.selection.model) app.duplicateModel(app.selection.model); return; }
    if (mod && kl === 'c') { if (tlFocused && ui.copyKeys()) { handled(); return; } if (app.selection.model) { handled(); ui.copyPose(); } return; }
    if (mod && kl === 'v') { if (tlFocused && ui.pasteKeys()) { handled(); return; } if (ui.poseClipboard) { handled(); ui.pastePose(); } return; }
    if (mod) return;
    switch (k) {
      case ' ': handled(); app.togglePlay(); return;
      case 'ArrowLeft': handled(); if (e.shiftKey) app.setTime(0); else app.stepFrame(-1); return;
      case 'ArrowRight': handled(); if (e.shiftKey) app.setTime(app.duration() - 1e-4); else app.stepFrame(1); return;
      case 'ArrowUp': handled(); ui.jumpKey?.(1); return;
      case 'ArrowDown': handled(); ui.jumpKey?.(-1); return;
      case 'Escape': app.select(null); return;
      case 'Delete': case 'Backspace':
        if (tlFocused && ui.hasKeySelection()) return;
        if (app.selection.model) { handled(); if (app.selection.object === app.selection.model.root) app.removeModel(app.selection.model); else app.deleteKeysAt(); }
        return;
      case '?': handled(); ui.shortcuts(); return;
      case '`': handled(); app.viewport.fly.toggle(); return;
      default: break;
    }
    if (e.altKey && kl === 'k') { handled(); app.deleteKeysAt(); return; }
    if (e.altKey) return;
    switch (kl) {
      case 'k': case 'i': handled(); if (e.shiftKey) app.keyPose(); else app.keySelection(); return;
      case 'w': handled(); app.setGizmoMode('translate'); return;
      case 'e': handled(); app.setGizmoMode('rotate'); return;
      case 'r': handled(); app.setGizmoMode('scale'); return;
      case 'q': handled(); app.setGizmoSpace(app.gizmoSpace === 'local' ? 'world' : 'local'); return;
      case 'f': handled(); if (e.shiftKey || !app.selection.object) app.viewport.frameAll(); else app.viewport.frameObject(app.selection.object); return;
      case 'p': handled(); app.selectParent(); return;
      case 'h': handled(); if (app.selection.model) { app.selection.model.setVisible(!app.selection.model.root.visible); app.emit('models'); app.viewport.requestRender(); } return;
      case '1': handled(); app.viewport.setView('front'); return;
      case '3': handled(); app.viewport.setView('right'); return;
      case '7': handled(); app.viewport.setView('top'); return;
      case '5': handled(); app.viewport.setView('persp'); return;
      case '0': { handled(); const cam = app.models.find((m) => m.root.isCamera); app.lookThrough(app.viewport.activeCamera !== app.viewport.camera ? null : cam || null); return; }
      default: break;
    }
  });

  // phone: compact menu button in place of the menu bar
  if (matchMedia('(max-width: 520px)').matches) {
    const mb = h('button', { class: 'tbtn', 'aria-label': 'Menu' }, icon('menu'));
    mb.addEventListener('click', () => dropdown(ui.allMenus(), { anchor: mb }));
    document.querySelector('.brand').after(mb);
  }

  // ------------------------------------------------------------ demo scene
  function demo(force) {
    const m = app.addMannequin();
    m.root.userData.demo = !force;
    if (m.humanoid) {
      const clip = bakeHumanoid(m.humanoid, 'walk', { name: 'Walk (demo)' });
      const idle = bakeHumanoid(m.humanoid, 'idle', { name: 'Idle (demo)' });
      m.addClip(idle, { play: false, warnDropped: false });
      const e = m.addClip(clip, { play: true, activate: true, warnDropped: false });
      for (const c of m.clips) if (c !== e && c.playing) m.setPlaying(c, false);
      m.setActiveClip(e);
    }
    app.select(m.root, m);
    app.viewport.frameAll();
    app.setTime(0);
    app.play();
    return m;
  }
  if (app.settings.get('demoScene')) {
    demo(false);
    if (!store.get('animator.seenDemoTip', false)) {
      store.set('animator.seenDemoTip', true);
      setTimeout(() => app.toast('This is a demo character. Drop your own models (or a .zip with textures) anywhere on the page.', 'info', 6500), 600);
    }
  } else {
    app.viewport.frameAll();
  }
  syncEmpty();
  if (app.detected && app.detected.quality !== 'high') {
    setTimeout(() => app.toast(`Started in ${QUALITY_PRESETS[app.detected.quality].label} mode for this device. Change it with the quality button at the top.`, 'info', 6000), 1400);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
