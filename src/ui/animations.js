// Animations tab: clips per model, blending (weight/speed/loop), transfer, edit ops.
import { h, icon, clear } from './dom.js';
import { dropdown, promptDialog, confirmDialog } from './toast.js';
import { openAnimationFor } from './menus.js';
import { reverseClip, simplifyClip, allKeyTimes } from '../anim/clips.js';
import { exportClipJSON } from '../io/export.js';

export function initAnimations(app, ui) {
  const root = document.getElementById('tab-anims');

  const sec = (title, ...children) => h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, h('span', { class: 'sec-t' }, title)), ...children);

  const clipMenu = (model, e, anchor) => {
    dropdown([
      { label: 'Rename…', action: async () => { const n = await promptDialog('Rename clip', 'Clip name', e.clip.name); if (n) { e.clip.name = n; app.emit('clips', model); } } },
      { label: 'Duplicate', icon: 'copy', action: () => { const c = e.clip.clone(); c.name = e.clip.name + ' copy'; app.addClipToModel(model, c, { solo: false }); } },
      { label: 'Reverse', action: () => app.editClip(model, e, (clip) => reverseClip(clip), 'Reverse clip') },
      { label: 'Remove redundant keys', action: () => app.editClip(model, e, (clip) => simplifyClip(clip), 'Simplify keys') },
      model.humanoid ? { label: 'Mirror left ↔ right', icon: 'mirror', action: () => app.mirrorClip(model, e) } : null,
      { sep: true },
      { label: 'Export as JSON', icon: 'download', action: () => exportClipJSON(app, model, e) },
      { sep: true },
      { label: 'Delete clip', icon: 'trash', action: async () => { if (await confirmDialog('Delete clip', `Delete "${e.clip.name}"? You can't undo this.`, 'Delete', true)) model.removeClip(e); } },
    ], { anchor });
  };

  const clipRow = (model, e) => {
    const active = model.activeClip === e;
    const radio = h('button', { class: 'ibtn', title: 'Edit this clip in the timeline', 'aria-label': 'Edit in timeline' }, h('span', { class: 'radio-dot' }));
    radio.addEventListener('click', () => model.setActiveClip(e));
    const play = h('button', { class: 'ibtn' + (e.playing ? ' on' : ''), title: e.playing ? 'Playing (click to mute)' : 'Muted (click to play)', 'aria-label': e.playing ? 'Mute clip' : 'Play clip' }, icon(e.playing ? 'play' : 'pause'));
    play.addEventListener('click', () => { model.setPlaying(e, !e.playing); app.needsEval = true; app.viewport.requestRender(); });
    const keys = allKeyTimes(e.clip).length;
    const name = h('div', { class: 'clip-name', title: 'Click to edit · double-click to rename' }, e.clip.name, ' ', h('span', { class: 'clip-meta' }, `${e.clip.duration.toFixed(2)}s · ${keys} key${keys === 1 ? '' : 's'}`));
    name.addEventListener('click', () => model.setActiveClip(e));
    name.addEventListener('dblclick', async () => { const n = await promptDialog('Rename clip', 'Clip name', e.clip.name); if (n) { e.clip.name = n; app.emit('clips', model); } });
    const more = h('button', { class: 'ibtn', title: 'More', 'aria-label': 'Clip options' }, icon('dots'));
    more.addEventListener('click', () => clipMenu(model, e, more));
    const weight = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: e.weight, title: 'Blend weight', 'aria-label': 'Blend weight' });
    weight.addEventListener('input', () => { model.setWeight(e, parseFloat(weight.value)); app.needsEval = true; app.viewport.requestRender(); });
    const speed = h('input', { type: 'number', min: -4, max: 4, step: 0.1, value: e.speed, title: 'Speed', 'aria-label': 'Speed' });
    speed.addEventListener('change', () => { const v = parseFloat(speed.value); model.setSpeed(e, isFinite(v) && v !== 0 ? v : 1); app.needsEval = true; app.emit('time', app.transport.time); });
    const loop = h('select', { 'aria-label': 'Loop mode' }, ...[['repeat', 'Loop'], ['once', 'Once'], ['pingpong', 'Ping-pong']].map(([v, l]) => h('option', { value: v, selected: e.loop === v || undefined }, l)));
    loop.addEventListener('change', () => { model.setLoop(e, loop.value); app.needsEval = true; app.viewport.requestRender(); });
    return h('div', { class: 'clip-row' + (active ? ' active' : '') }, radio, play, name, more,
      h('div', { class: 'clip-ctl' }, 'Mix', weight, 'Speed', speed, loop));
  };

  const transferItems = (dst) => {
    const items = [];
    for (const m of app.models) {
      if (m === dst || !m.clips.length) continue;
      items.push({ header: m.name + (m.humanoid ? ' (humanoid)' : '') });
      for (const e of m.clips) items.push({ label: e.clip.name, icon: 'bone', action: () => { const r = app.retargetFrom(m, e, dst); if (r) app.toast(`Copied "${e.clip.name}" onto ${dst.name}`, 'ok'); } });
    }
    if (!items.length) items.push({ label: 'No other model has animations yet', disabled: true });
    return items;
  };

  const render = () => {
    clear(root);
    const model = app.selection.model;
    if (!model) {
      const list = app.models.filter((m) => m.clips.length);
      root.append(h('div', { class: 'empty-note' }, h('b', {}, 'Select a model'), ' to see and blend its animation clips. Every model can play several clips at once, and all models play together on the timeline.'));
      if (list.length) {
        root.append(sec('Models with animation', ...list.map((m) => h('div', { class: 'clip-row', style: { gridTemplateColumns: '22px minmax(0,1fr) auto' } }, h('span', { class: 'ol-icon' }, icon(m.humanoid ? 'person' : 'mesh')), h('div', { class: 'clip-name', onclick: () => app.select(m.root, m) }, m.name, ' ', h('span', { class: 'clip-meta' }, `${m.clips.filter((c) => c.playing).length}/${m.clips.length} playing`)), h('span')))));
      }
      return;
    }
    const s = sec(`Clips · ${model.name}`);
    if (!model.clips.length) s.append(h('div', { class: 'hint', style: { marginBottom: '8px' } }, 'No animations yet. Create a clip and key some poses, ask the AI tab, or drop an animation file (FBX/GLB/BVH) on the page with this model selected.'));
    for (const e of model.clips) s.append(clipRow(model, e));
    const transferBtn = h('button', { class: 'btn sm' }, icon('bone'), 'Copy from…');
    transferBtn.addEventListener('click', () => dropdown(transferItems(model), { anchor: transferBtn }));
    s.append(h('div', { class: 'btns' },
      h('button', { class: 'btn sm primary', onclick: () => { model.newClip('Action', 2); app.setTime(0); app.emit('clips', model); } }, icon('plus'), 'New clip'),
      h('button', { class: 'btn sm', onclick: () => openAnimationFor(app, model) }, icon('upload'), 'Load file…'),
      transferBtn));
    if (model.humanoid) s.append(h('div', { class: 'hint' }, 'This is a humanoid rig: clips from other characters (Mixamo, VRM, Unreal, Blender…) are retargeted automatically.'));
    root.append(s);

    const e = model.activeClip;
    if (e) {
      const nameIn = h('input', { type: 'text', value: e.clip.name, 'aria-label': 'Clip name' });
      nameIn.addEventListener('change', () => { e.clip.name = nameIn.value || 'Action'; app.emit('clips', model); });
      const dur = h('input', { type: 'number', min: 0.05, step: 0.1, value: +e.clip.duration.toFixed(3), 'aria-label': 'Duration in seconds' });
      dur.addEventListener('change', () => {
        const v = parseFloat(dur.value);
        if (!(v > 0)) return;
        const old = e.clip.duration;
        app.editClip(model, e, (clip) => { clip.duration = v; }, 'Clip length');
        if (app.transport.time > v) app.setTime(0);
        void old;
      });
      const fitBtn = h('button', { class: 'btn sm', onclick: () => { const times = allKeyTimes(e.clip); if (times.length) app.editClip(model, e, (clip) => { clip.duration = Math.max(times[times.length - 1], 1 / app.settings.get('fps')); }, 'Fit length'); } }, 'Fit to keys');
      root.append(sec('Active clip',
        h('div', { class: 'field' }, h('label', {}, 'Name'), nameIn),
        h('div', { class: 'field' }, h('label', {}, 'Length (s)'), dur, fitBtn),
        h('div', { class: 'field' }, h('label', {}, 'Solo'), h('label', { class: 'toggle' }, (() => { const c = h('input', { type: 'checkbox', checked: model.clips.every((x) => x === e || !x.playing) || undefined }); c.addEventListener('change', () => { model.soloActive(c.checked); app.needsEval = true; app.viewport.requestRender(); render(); }); return c; })(), 'Only play this clip')),
        h('div', { class: 'hint' }, 'Keys you add go into this clip. Drag keys in the timeline to retime them; right-click for interpolation.')));
    }

    root.append(sec('Playback',
      h('div', { class: 'btns' },
        h('button', { class: 'btn sm', onclick: () => { app.setTime(0); app.play(); } }, icon('play'), 'Play all from start'),
        h('button', { class: 'btn sm', onclick: () => app.stop() }, icon('stop'), 'Stop')),
      h('div', { class: 'hint' }, 'All playing clips on every model run together, so you can stage several characters and objects in one scene.')));
  };

  app.on('selection', render);
  app.on('clips', (m) => { if (!m || m === app.selection.model) render(); });
  app.on('activeclip', (m) => { if (!m || m === app.selection.model) render(); });
  app.on('keys', (m) => { if (m === app.selection.model) render(); });
  app.on('models', render);
  render();
  ui.renderAnimations = render;
}
