// Timeline: transport bar + canvas dope sheet for the selected model's active clip.
import * as THREE from 'three';
import { h, icon, clear } from './dom.js';
import { dropdown } from './toast.js';
import { clipInfo, propDesc, morphLabel, moveKeys, deleteKeys, setKey, setInterpolation, interpolationName, allKeyTimes, sampleTrack } from '../anim/clips.js';
import { isTextInput } from '../core/util.js';

const ROW_H = 20, RULER_H = 24;
const COLORS = {
  bg: '#171b21', alt: '#1a1f26', label: '#14181d', line: '#2a3039', text: '#c9d0da', muted: '#7d8696', faint: '#4f5866',
  key: '#cfd6e0', keySel: '#ffb84a', keySum: '#8d96a5', play: '#4aa8ff', range: 'rgba(0,0,0,0.28)', selRow: 'rgba(74,168,255,0.10)', box: 'rgba(74,168,255,0.15)', boxLine: '#4aa8ff',
};

const PROP_NAMES = { position: 'Position', quaternion: 'Rotation', scale: 'Scale', visible: 'Visible', 'material.color': 'Color', 'material.opacity': 'Opacity', 'material.emissiveIntensity': 'Glow', intensity: 'Intensity', color: 'Light color', fov: 'Field of view' };

export function initTimeline(app, ui) {
  const bar = document.getElementById('tl-bar');
  const body = document.getElementById('tl-body');
  const canvas = document.getElementById('tl-canvas');
  const emptyEl = document.getElementById('tl-empty');
  // static parts (rows, keys, ruler) are painted into an offscreen layer and only
  // re-rendered when something changes; playback just blits it and draws the playhead
  const screen = canvas.getContext('2d');
  const baseCanvas = document.createElement('canvas');
  const baseCtx = baseCanvas.getContext('2d');
  let ctx = baseCtx;
  let baseDirty = true;
  const view = { t0: -0.05, pps: 120, scrollY: 0 };
  let rows = [];
  let selected = new Set(); // "ti:ki"
  const expanded = new Set();
  let drag = null;
  let dpr = 1, W = 0, H = 0;
  let labelW = 168;
  let lastClip = null;
  let keyClipboard = null;

  const fps = () => app.settings.get('fps') || 30;
  const model = () => app.selection.model;
  const entry = () => model()?.activeClip || null;
  const tToX = (t) => labelW + (t - view.t0) * view.pps;
  const xToT = (x) => view.t0 + (x - labelW) / view.pps;
  const snapT = (t) => (app.settings.get('snap') ? Math.round(t * fps()) / fps() : t);

  // ------------------------------------------------------------ toolbar
  const clipSel = h('select', { class: 'tl-clip', 'aria-label': 'Clip being edited' });
  clipSel.addEventListener('change', () => {
    const m = model();
    if (!m) return;
    if (clipSel.value === '__new') { m.newClip('Action', 2); app.setTime(0); app.emit('clips', m); return; }
    const e = m.clips.find((c) => c.id === clipSel.value);
    if (e) m.setActiveClip(e);
  });
  const tb = (ic, title, fn, cls = '') => { const b = h('button', { class: 'tbtn ' + cls, title, 'aria-label': title }, icon(ic)); b.addEventListener('click', fn); return b; };
  const bFirst = tb('first', 'Go to start (Shift+←)', () => app.setTime(0));
  const bPrev = tb('prevkey', 'Previous key (↓)', () => jumpKey(-1));
  const bPlay = tb('play', 'Play / pause (Space)', () => app.togglePlay());
  const bNext = tb('nextkey', 'Next key (↑)', () => jumpKey(1));
  const bLast = tb('last', 'Go to end (Shift+→)', () => app.setTime(app.duration() - 1e-4));
  const timecode = h('div', { class: 'timecode', title: 'Current frame / seconds' });
  const bLoop = tb('loop', 'Loop playback', () => { app.transport.loop = !app.transport.loop; syncBar(); });
  const bRec = tb('record', 'Auto-key: record every change as a keyframe', () => { app.setSetting('autoKey', !app.settings.get('autoKey')); syncBar(); }, 'rec');
  const bKey = tb('key', 'Insert key on selection (K)', () => app.keySelection(), 'key');
  const bDel = tb('keyo', 'Delete selected keys (Del)', () => deleteSelected());
  const interp = h('select', { class: 'tl-sel', title: 'Interpolation of selected keys\' curves', 'aria-label': 'Interpolation' }, h('option', { value: '' }, 'Curve…'), h('option', { value: 'linear' }, 'Linear'), h('option', { value: 'smooth' }, 'Smooth'), h('option', { value: 'step' }, 'Stepped'));
  interp.addEventListener('change', () => { if (interp.value) applyInterp(interp.value); interp.value = ''; });
  const lenIn = h('input', { class: 'tl-num', type: 'number', min: 0.05, step: 0.1, title: 'Clip length in seconds', 'aria-label': 'Clip length (s)' });
  lenIn.addEventListener('change', () => { const e = entry(), m = model(); const v = parseFloat(lenIn.value); if (e && v > 0) app.editClip(m, e, (c) => { c.duration = v; }, 'Clip length'); fit(); });
  const fpsSel = h('select', { class: 'tl-sel', title: 'Frames per second (key snapping)', 'aria-label': 'Frames per second' }, ...[12, 24, 25, 30, 48, 60].map((f) => h('option', { value: f, selected: fps() === f || undefined }, f + ' fps')));
  fpsSel.addEventListener('change', () => { app.setSetting('fps', parseInt(fpsSel.value, 10)); draw(); syncBar(); });
  const bSnap = tb('magnet', 'Snap keys and playhead to frames', () => { app.setSetting('snap', !app.settings.get('snap')); syncBar(); });
  const bFit = tb('frame', 'Fit clip in view', () => fit());
  bar.append(clipSel, h('div', { class: 'sep' }), bFirst, bPrev, bPlay, bNext, bLast, timecode, bLoop, h('div', { class: 'sep' }), bRec, bKey, bDel, interp,
    h('div', { class: 'sep' }), h('span', { class: 'tl-lbl' }, 'Length'), lenIn, fpsSel, bSnap, bFit);

  function syncBar() {
    const m = model();
    clear(clipSel);
    if (!m) { clipSel.append(h('option', {}, 'No model selected')); clipSel.disabled = true; }
    else {
      clipSel.disabled = false;
      if (!m.clips.length) clipSel.append(h('option', { value: '' }, 'No clips'));
      for (const c of m.clips) clipSel.append(h('option', { value: c.id, selected: m.activeClip === c || undefined }, c.clip.name));
      clipSel.append(h('option', { value: '__new' }, '+ New clip'));
    }
    bPlay.replaceChildren(icon(app.transport.playing ? 'pause' : 'play'));
    bPlay.classList.toggle('on', app.transport.playing);
    bLoop.classList.toggle('on', app.transport.loop);
    bRec.classList.toggle('on', !!app.settings.get('autoKey'));
    bSnap.classList.toggle('on', !!app.settings.get('snap'));
    const e = entry();
    lenIn.disabled = !e;
    if (e && document.activeElement !== lenIn) lenIn.value = +e.clip.duration.toFixed(3);
    syncTime();
  }

  function curT() {
    const e = entry();
    return e ? app.localTime(e) : app.transport.time;
  }

  function syncTime() {
    const t = app.transport.playing ? (entry() ? (app.transport.time * entry().speed) % Math.max(entry().clip.duration, 1e-3) : app.transport.time) : curT();
    const total = entry() ? entry().clip.duration : app.duration();
    const f = Math.round(t * fps());
    timecode.replaceChildren(h('span', { class: 'fr' }, 'F ' + f), h('span', {}, t.toFixed(2) + 's'), h('span', { class: 'of' }, '/ ' + total.toFixed(2) + 's'));
  }

  // ------------------------------------------------------------ rows
  function buildRows() {
    rows = [];
    const m = model(), e = entry();
    if (!m || !e) return;
    const info = clipInfo(e.clip, m.root);
    const order = new Map();
    let i = 0;
    m.root.traverse((o) => order.set(o, i++));
    const nodes = [...info.groups.keys()];
    const selObj = app.selection.object;
    if (selObj && !info.groups.has(selObj) && m.rest.has(selObj)) nodes.push(selObj);
    nodes.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
    rows.push({ type: 'summary', label: 'Summary · ' + e.clip.name });
    for (const node of nodes) {
      const g = (info.groups.get(node) || []).slice().sort((a, b) => propOrder(a.prop) - propOrder(b.prop));
      const open = expanded.has(node.uuid);
      rows.push({ type: 'node', node, tracks: g, open });
      if (open) for (const t of g) rows.push({ type: 'prop', node, ti: t.ti, prop: t.prop, track: t.track });
    }
  }

  function propOrder(p) {
    const order = ['position', 'quaternion', 'scale', 'visible'];
    const i = order.indexOf(p);
    return i < 0 ? 10 : i;
  }

  function propLabel(node, prop) {
    if (PROP_NAMES[prop]) return PROP_NAMES[prop];
    const ml = morphLabel(node, prop);
    if (ml) return 'Shape: ' + ml;
    return prop;
  }

  // keys displayed on a row: [{t, items:[{ti,ki}]}]
  function rowKeys(row) {
    const e = entry();
    if (!e) return [];
    const map = new Map();
    const add = (ti, track) => {
      track.times.forEach((t, ki) => {
        const k = Math.round(t * 1e4) / 1e4;
        let v = map.get(k);
        if (!v) map.set(k, (v = { t, items: [] }));
        v.items.push({ ti, ki });
      });
    };
    if (row.type === 'summary') e.clip.tracks.forEach((tr, ti) => add(ti, tr));
    else if (row.type === 'node') row.tracks.forEach((t) => add(t.ti, e.clip.tracks[t.ti]));
    else add(row.ti, e.clip.tracks[row.ti]);
    return [...map.values()];
  }

  // ------------------------------------------------------------ drawing
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = body.clientWidth; H = body.clientHeight;
    canvas.width = Math.max(1, W * dpr); canvas.height = Math.max(1, H * dpr);
    baseCanvas.width = canvas.width; baseCanvas.height = canvas.height;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    labelW = W < 560 ? 104 : 168;
    draw();
  }

  let rafPending = false;
  function draw(full = true) {
    if (full) baseDirty = true;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; paint(); });
  }

  function paint() {
    if (baseDirty || drag) { ctx = baseCtx; paintBase(); baseDirty = false; }
    screen.setTransform(1, 0, 0, 1, 0, 0);
    screen.drawImage(baseCanvas, 0, 0);
    ctx = screen;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const e = entry();
    if (model() && e) paintPlayhead(e, e.clip.duration);
    ctx = baseCtx;
  }

  function paintBase() {
    const m = model(), e = entry();
    if (e && e.clip !== lastClip) { lastClip = e.clip; selected.clear(); fit(true); }
    buildRows();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, W, H);
    if (!m || !e) {
      emptyEl.hidden = false;
      emptyEl.textContent = !m ? 'Select a model to see its keyframes here.' : 'No clip yet. Pose the model and press K to add the first keyframe, or ask the AI tab for an animation.';
      return;
    }
    emptyEl.hidden = true;
    const dur = e.clip.duration;
    const maxScroll = Math.max(0, rows.length * ROW_H - (H - RULER_H));
    view.scrollY = Math.max(0, Math.min(view.scrollY, maxScroll));
    // rows
    ctx.font = '12px ' + getComputedStyle(document.body).getPropertyValue('--f-ui');
    ctx.textBaseline = 'middle';
    const selObj = app.selection.object;
    for (let i = 0; i < rows.length; i++) {
      const y = RULER_H + i * ROW_H - view.scrollY;
      if (y + ROW_H < RULER_H || y > H) continue;
      const r = rows[i];
      ctx.fillStyle = i % 2 ? COLORS.alt : COLORS.bg;
      ctx.fillRect(labelW, y, W - labelW, ROW_H);
      if (r.node && r.node === selObj) { ctx.fillStyle = COLORS.selRow; ctx.fillRect(0, y, W, ROW_H); }
    }
    // out-of-range shading
    const xEnd = tToX(dur);
    ctx.fillStyle = COLORS.range;
    if (xEnd < W) ctx.fillRect(Math.max(labelW, xEnd), RULER_H, W - Math.max(labelW, xEnd), H - RULER_H);
    const x0 = tToX(0);
    if (x0 > labelW) ctx.fillRect(labelW, RULER_H, x0 - labelW, H - RULER_H);
    // frame grid
    drawGrid();
    // keys
    for (let i = 0; i < rows.length; i++) {
      const y = RULER_H + i * ROW_H - view.scrollY;
      if (y + ROW_H < RULER_H || y > H) continue;
      const r = rows[i];
      const keys = rowKeys(r);
      const cy = y + ROW_H / 2;
      // hold lines between keys with identical values (prop rows)
      if (r.type === 'prop' && r.track && r.track.times.length > 1) {
        const size = r.track.getValueSize();
        ctx.strokeStyle = 'rgba(207,214,224,0.25)';
        ctx.lineWidth = 2;
        for (let k = 0; k < r.track.times.length - 1; k++) {
          let same = true;
          for (let j = 0; j < size; j++) if (Math.abs(r.track.values[k * size + j] - r.track.values[(k + 1) * size + j]) > 1e-5) { same = false; break; }
          if (same) { ctx.beginPath(); ctx.moveTo(tToX(r.track.times[k]), cy); ctx.lineTo(tToX(r.track.times[k + 1]), cy); ctx.stroke(); }
        }
      }
      for (const k of keys) {
        const x = tToX(k.t);
        if (x < labelW - 6 || x > W + 6) continue;
        const sel = k.items.some((it) => selected.has(it.ti + ':' + it.ki));
        let dx = 0;
        if (drag && drag.type === 'move' && sel) dx = drag.dt * view.pps;
        const size = r.type === 'summary' ? 5 : r.type === 'node' ? 5 : 4.2;
        diamond(x + dx, cy, size, sel ? COLORS.keySel : r.type === 'summary' ? COLORS.keySum : COLORS.key, sel);
      }
    }
    // box selection
    if (drag && drag.type === 'box') {
      const bx = Math.min(drag.x0, drag.x1), by = Math.min(drag.y0, drag.y1);
      ctx.fillStyle = COLORS.box; ctx.strokeStyle = COLORS.boxLine; ctx.lineWidth = 1;
      ctx.fillRect(bx, by, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
      ctx.strokeRect(bx + 0.5, by + 0.5, Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0));
    }
    // label column
    ctx.fillStyle = COLORS.label;
    ctx.fillRect(0, RULER_H, labelW, H - RULER_H);
    for (let i = 0; i < rows.length; i++) {
      const y = RULER_H + i * ROW_H - view.scrollY;
      if (y + ROW_H < RULER_H || y > H) continue;
      const r = rows[i];
      if (r.node && r.node === selObj) { ctx.fillStyle = COLORS.selRow; ctx.fillRect(0, y, labelW, ROW_H); }
      const cy = y + ROW_H / 2;
      let text, indent = 8, color = COLORS.text;
      if (r.type === 'summary') { text = r.label; color = COLORS.muted; }
      else if (r.type === 'node') {
        indent = 20;
        if (r.tracks.length) {
          ctx.fillStyle = COLORS.muted;
          ctx.beginPath();
          if (r.open) { ctx.moveTo(8, cy - 2); ctx.lineTo(14, cy - 2); ctx.lineTo(11, cy + 2); }
          else { ctx.moveTo(9, cy - 3); ctx.lineTo(13, cy); ctx.lineTo(9, cy + 3); }
          ctx.fill();
        }
        text = (r.node.isBone ? '◇ ' : '') + (r.node.name || r.node.type);
        if (!r.tracks.length) color = COLORS.faint;
      } else { indent = 34; text = propLabel(r.node, r.prop); color = COLORS.muted; }
      ctx.fillStyle = color;
      ctx.fillText(ellipsize(text, labelW - indent - 6), indent, cy);
    }
    ctx.strokeStyle = COLORS.line;
    ctx.beginPath(); ctx.moveTo(labelW + 0.5, 0); ctx.lineTo(labelW + 0.5, H); ctx.stroke();
    // ruler
    drawRuler(dur);
  }

  function paintPlayhead(e, dur) {
    const pt = app.transport.playing ? (app.transport.time * e.speed) % Math.max(dur, 1e-3) : curT();
    const px = tToX(pt);
    if (px >= labelW) {
      ctx.strokeStyle = COLORS.play; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, RULER_H - 6); ctx.lineTo(px, H); ctx.stroke();
      const label = String(Math.round(pt * fps()));
      ctx.font = '11px ' + getComputedStyle(document.body).getPropertyValue('--f-mono');
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = COLORS.play;
      roundRect(px - tw / 2, 3, tw, 17, 4);
      ctx.fillStyle = '#06121f';
      ctx.textAlign = 'center';
      ctx.fillText(label, px, 12);
      ctx.textAlign = 'left';
    }
  }

  function ellipsize(t, w) {
    if (ctx.measureText(t).width <= w) return t;
    while (t.length > 1 && ctx.measureText(t + '…').width > w) t = t.slice(0, -1);
    return t + '…';
  }

  function roundRect(x, y, w, hh, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + hh, r); ctx.arcTo(x + w, y + hh, x, y + hh, r); ctx.arcTo(x, y + hh, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.fill();
  }

  function diamond(x, y, s, color, sel) {
    ctx.beginPath();
    ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y); ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = sel ? '#fff3dc' : 'rgba(0,0,0,0.55)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function tickStep() {
    const f = fps();
    const frameW = view.pps / f;
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    for (const s of steps) if (s * frameW >= 48) return s;
    return 1200;
  }

  function drawGrid() {
    const f = fps();
    const step = tickStep();
    const startF = Math.floor(xToT(labelW) * f / step) * step;
    ctx.strokeStyle = 'rgba(255,255,255,0.035)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let fr = startF; ; fr += step) {
      const x = Math.round(tToX(fr / f)) + 0.5;
      if (x > W) break;
      if (x < labelW) continue;
      ctx.moveTo(x, RULER_H); ctx.lineTo(x, H);
    }
    ctx.stroke();
  }

  function drawRuler(dur) {
    ctx.fillStyle = '#12161b';
    ctx.fillRect(0, 0, W, RULER_H);
    ctx.strokeStyle = COLORS.line;
    ctx.beginPath(); ctx.moveTo(0, RULER_H + 0.5); ctx.lineTo(W, RULER_H + 0.5); ctx.stroke();
    const f = fps();
    const step = tickStep();
    const minor = step >= 5 ? step / 5 : 1;
    ctx.font = '10.5px ' + getComputedStyle(document.body).getPropertyValue('--f-mono');
    ctx.fillStyle = COLORS.muted;
    const startF = Math.floor(xToT(labelW) * f / minor) * minor;
    ctx.beginPath();
    for (let fr = startF; ; fr += minor) {
      const x = Math.round(tToX(fr / f)) + 0.5;
      if (x > W) break;
      if (x < labelW) continue;
      const major = Math.abs(fr % step) < 1e-6;
      ctx.moveTo(x, major ? 12 : 18); ctx.lineTo(x, RULER_H);
      if (major) ctx.fillText(String(Math.round(fr)), x + 3, 9);
    }
    ctx.strokeStyle = COLORS.faint;
    ctx.stroke();
    // clip end marker
    const xe = tToX(dur);
    if (xe >= labelW && xe <= W) {
      ctx.fillStyle = COLORS.keySel;
      ctx.fillRect(xe - 1, 0, 2, RULER_H);
      ctx.beginPath(); ctx.moveTo(xe - 5, 0); ctx.lineTo(xe + 5, 0); ctx.lineTo(xe, 6); ctx.fill();
    }
    ctx.fillStyle = COLORS.label;
    ctx.fillRect(0, 0, labelW, RULER_H);
    ctx.fillStyle = COLORS.faint;
    ctx.font = '10.5px ' + getComputedStyle(document.body).getPropertyValue('--f-ui');
    ctx.fillText('FRAME', 8, 12);
  }

  function fit(silent) {
    const e = entry();
    const dur = e ? Math.max(e.clip.duration, 0.25) : 2;
    const avail = Math.max(50, W - labelW - 24);
    view.pps = avail / (dur * 1.04);
    view.t0 = -dur * 0.02;
    if (!silent) draw();
  }

  // ------------------------------------------------------------ hit testing
  function rowAt(y) {
    const i = Math.floor((y - RULER_H + view.scrollY) / ROW_H);
    return i >= 0 && i < rows.length ? { row: rows[i], index: i } : null;
  }

  function keyAt(x, y) {
    const hit = rowAt(y);
    if (!hit) return null;
    const keys = rowKeys(hit.row);
    let best = null, bd = 7;
    for (const k of keys) { const d = Math.abs(tToX(k.t) - x); if (d < bd) { bd = d; best = k; } }
    return best ? { ...best, row: hit.row } : null;
  }

  function selectionList() {
    return [...selected].map((s) => { const [ti, ki] = s.split(':').map(Number); return { ti, ki }; });
  }

  // ------------------------------------------------------------ actions
  function deleteSelected() {
    const m = model(), e = entry();
    if (!m || !e || !selected.size) { app.deleteKeysAt(); return; }
    const sel = selectionList();
    app.editClip(m, e, (clip) => deleteKeys(clip, sel), 'Delete keys');
    selected.clear();
    draw();
  }

  function applyInterp(mode) {
    const m = model(), e = entry();
    if (!m || !e) return;
    let tis = [...new Set(selectionList().map((s) => s.ti))];
    if (!tis.length) {
      const info = clipInfo(e.clip, m.root);
      const g = app.selection.object && info.groups.get(app.selection.object);
      tis = g ? g.map((x) => x.ti) : e.clip.tracks.map((_, i) => i);
    }
    app.editClip(m, e, (clip) => setInterpolation(clip, tis, mode), 'Interpolation');
    app.toast(`${mode[0].toUpperCase() + mode.slice(1)} interpolation on ${tis.length} curve${tis.length > 1 ? 's' : ''}`, 'ok', 1500);
  }

  function copyKeys() {
    const m = model(), e = entry();
    if (!m || !e || !selected.size) return false;
    const sel = selectionList();
    const t0 = Math.min(...sel.map(({ ti, ki }) => e.clip.tracks[ti].times[ki]));
    keyClipboard = sel.map(({ ti, ki }) => {
      const tr = e.clip.tracks[ti];
      const size = tr.getValueSize();
      const info = clipInfo(e.clip, m.root);
      let node = null, prop = null;
      for (const [n, g] of info.groups) { const f = g.find((x) => x.ti === ti); if (f) { node = n; prop = f.prop; break; } }
      return { nodeUuid: node?.uuid, nodeName: node?.name, prop, dt: tr.times[ki] - t0, value: Array.from(tr.values.slice(ki * size, ki * size + size)) };
    }).filter((k) => k.prop);
    app.toast(`Copied ${keyClipboard.length} key${keyClipboard.length > 1 ? 's' : ''}`, 'ok', 1200);
    return true;
  }

  function pasteKeys() {
    const m = model();
    if (!m || !keyClipboard || !keyClipboard.length) return false;
    const e = app.ensureClip(m);
    const t = curT();
    app.editClip(m, e, (clip) => {
      for (const k of keyClipboard) {
        let node = null;
        m.root.traverse((o) => { if (!node && o.uuid === k.nodeUuid) node = o; });
        if (!node) m.root.traverse((o) => { if (!node && o.name === k.nodeName) node = o; });
        if (node && propDesc(k.prop)) setKey(clip, m.root, node, k.prop, snapT(t + k.dt), k.value, app.keyEps());
      }
    }, 'Paste keys');
    return true;
  }
  ui.copyKeys = copyKeys;
  ui.pasteKeys = pasteKeys;
  ui.hasKeySelection = () => selected.size > 0;
  ui.timelineFocused = () => document.activeElement === canvas;

  function jumpKey(dir) {
    const m = model(), e = entry();
    if (!m || !e) return;
    const info = clipInfo(e.clip, m.root);
    const g = app.selection.object && info.groups.get(app.selection.object);
    const tracks = g && g.length ? g.map((x) => x.track) : e.clip.tracks;
    const times = allKeyTimes(e.clip, tracks);
    const t = curT();
    const next = dir > 0 ? times.find((x) => x > t + 1e-4) : [...times].reverse().find((x) => x < t - 1e-4);
    if (next !== undefined) { app.pause(); app.setTime(next / (e.speed || 1)); }
  }
  ui.jumpKey = jumpKey;

  function insertKeyOnRow(row, t) {
    const m = model();
    if (!m) return;
    const e = app.ensureClip(m);
    const node = row.node || app.selection.object;
    if (!node) return;
    const props = row.type === 'prop' ? [row.prop] : row.type === 'node' && row.tracks.length ? row.tracks.map((x) => x.prop) : app.defaultKeyProps(node);
    app.editClip(m, e, (clip) => {
      for (const p of props) {
        const desc = propDesc(p);
        if (!desc) continue;
        // value of the curve at t (or current value if no curve)
        const ti = clip.tracks.findIndex((tr) => tr.name.startsWith(node.uuid + '.') && tr.name.slice(node.uuid.length + 1).replace(/^material\[0\]\./, 'material.') === p);
        const val = ti >= 0 ? sampleTrack(clip.tracks[ti], t) : desc.get(node);
        setKey(clip, m.root, node, p, t, val, app.keyEps());
      }
    }, 'Insert key');
  }

  // ------------------------------------------------------------ pointer
  canvas.addEventListener('pointerdown', (ev) => {
    const m = model(), e = entry();
    canvas.focus({ preventScroll: true });
    if (!m || !e) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (ev.button === 1) { drag = { type: 'pan', x0: x, t00: view.t0, y0: y, s0: view.scrollY }; canvas.setPointerCapture(ev.pointerId); return; }
    if (ev.button !== 0) return;
    canvas.setPointerCapture(ev.pointerId);
    if (y < RULER_H && x > labelW) {
      const xe = tToX(e.clip.duration);
      if (Math.abs(x - xe) < 6) { drag = { type: 'end', before: e.clip.duration }; return; }
      app.pause();
      drag = { type: 'scrub' };
      scrubTo(x);
      return;
    }
    if (x < labelW) {
      const hit = rowAt(y);
      if (hit && hit.row.node) {
        if (hit.row.type === 'node' && x < 20 && hit.row.tracks.length) { if (expanded.has(hit.row.node.uuid)) expanded.delete(hit.row.node.uuid); else expanded.add(hit.row.node.uuid); draw(); return; }
        app.select(hit.row.node, m);
      }
      return;
    }
    const k = keyAt(x, y);
    if (k) {
      const ids = k.items.map((it) => it.ti + ':' + it.ki);
      const allSel = ids.every((id) => selected.has(id));
      if (ev.shiftKey) { if (allSel) ids.forEach((id) => selected.delete(id)); else ids.forEach((id) => selected.add(id)); }
      else if (!allSel) { selected = new Set(ids); }
      drag = { type: 'move', x0: x, dt: 0, moved: false };
      draw();
      return;
    }
    drag = { type: 'box', x0: x, y0: y, x1: x, y1: y, additive: ev.shiftKey, moved: false };
  });

  canvas.addEventListener('pointermove', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (!drag) {
      const e = entry();
      canvas.style.cursor = e && y < RULER_H && Math.abs(x - tToX(e.clip.duration)) < 6 ? 'ew-resize' : y < RULER_H && x > labelW ? 'text' : keyAt(x, y) ? 'pointer' : 'default';
      return;
    }
    if (drag.type === 'scrub') scrubTo(x);
    else if (drag.type === 'pan') { view.t0 = drag.t00 - (x - drag.x0) / view.pps; view.scrollY = drag.s0 - (y - drag.y0); draw(); }
    else if (drag.type === 'end') { const e = entry(); if (e) { e.clip.duration = Math.max(1 / fps(), snapT(xToT(x))); draw(); syncTime(); } }
    else if (drag.type === 'move') {
      let dt = (x - drag.x0) / view.pps;
      if (app.settings.get('snap')) dt = Math.round(dt * fps()) / fps();
      if (Math.abs(x - drag.x0) > 3) drag.moved = true;
      drag.dt = dt;
      draw();
    } else if (drag.type === 'box') { drag.x1 = x; drag.y1 = y; if (Math.abs(x - drag.x0) + Math.abs(y - drag.y0) > 4) drag.moved = true; draw(); }
  });

  canvas.addEventListener('pointerup', (ev) => {
    const d = drag;
    drag = null;
    const m = model(), e = entry();
    if (!d || !m || !e) return;
    if (d.type === 'end') {
      const after = e.clip.duration;
      e.clip.duration = d.before;
      app.editClip(m, e, (c) => { c.duration = after; }, 'Clip length');
      syncBar();
    } else if (d.type === 'move' && d.moved && d.dt !== 0) {
      const sel = selectionList();
      let newSel = [];
      app.editClip(m, e, (clip) => { newSel = moveKeys(clip, sel, d.dt, app.settings.get('snap') ? snapT : null); }, 'Move keys');
      selected = new Set(newSel.map((s) => s.ti + ':' + s.ki));
    } else if (d.type === 'box') {
      if (!d.moved) {
        if (!d.additive) selected.clear();
        const rect = canvas.getBoundingClientRect();
        app.pause();
        scrubTo(ev.clientX - rect.left);
      } else {
        const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
        if (!d.additive) selected.clear();
        rows.forEach((r, i) => {
          const cy = RULER_H + i * ROW_H - view.scrollY + ROW_H / 2;
          if (cy < y0 || cy > y1) return;
          for (const k of rowKeys(r)) { const kx = tToX(k.t); if (kx >= x0 && kx <= x1) k.items.forEach((it) => selected.add(it.ti + ':' + it.ki)); }
        });
      }
    }
    draw();
  });

  canvas.addEventListener('dblclick', (ev) => {
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (x < labelW || y < RULER_H) return;
    const hit = rowAt(y);
    if (!hit) return;
    insertKeyOnRow(hit.row, snapT(Math.max(0, xToT(x))));
  });

  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    if (ev.ctrlKey || ev.metaKey) {
      const t = xToT(x);
      const f = Math.exp(-ev.deltaY * 0.0025);
      view.pps = Math.max(8, Math.min(4000, view.pps * f));
      view.t0 = t - (x - labelW) / view.pps;
    } else if (ev.shiftKey || Math.abs(ev.deltaX) > Math.abs(ev.deltaY)) {
      view.t0 += (ev.deltaX || ev.deltaY) / view.pps;
    } else {
      const maxScroll = Math.max(0, rows.length * ROW_H - (H - RULER_H));
      if (maxScroll > 0) view.scrollY = Math.max(0, Math.min(maxScroll, view.scrollY + ev.deltaY));
      else view.t0 += ev.deltaY / view.pps;
    }
    draw();
  }, { passive: false });

  canvas.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    const k = keyAt(x, y);
    if (k && !k.items.every((it) => selected.has(it.ti + ':' + it.ki))) { selected = new Set(k.items.map((it) => it.ti + ':' + it.ki)); draw(); }
    const hit = rowAt(y);
    const t = snapT(Math.max(0, xToT(x)));
    const e = entry();
    const curInterp = selected.size && e ? interpolationName(e.clip.tracks[selectionList()[0].ti]) : null;
    dropdown([
      hit && x > labelW ? { label: `Insert key here (frame ${Math.round(t * fps())})`, icon: 'key', action: () => insertKeyOnRow(hit.row, t) } : null,
      { label: 'Delete selected keys', icon: 'trash', kbd: 'Del', disabled: !selected.size, action: deleteSelected },
      { label: 'Copy keys', icon: 'copy', kbd: 'Ctrl+C', disabled: !selected.size, action: copyKeys },
      { label: 'Paste keys at playhead', icon: 'copy', kbd: 'Ctrl+V', disabled: !keyClipboard, action: pasteKeys },
      { sep: true },
      { header: 'Interpolation' + (curInterp ? ` (now ${curInterp})` : '') },
      { label: 'Linear', action: () => applyInterp('linear') },
      { label: 'Smooth', action: () => applyInterp('smooth') },
      { label: 'Stepped (hold)', action: () => applyInterp('step') },
      { sep: true },
      { label: 'Select all keys', kbd: 'Ctrl+A', action: selectAll },
      { label: 'Fit clip in view', icon: 'frame', action: () => fit() },
    ], { x: ev.clientX, y: ev.clientY });
  });

  function selectAll() {
    const e = entry();
    if (!e) return;
    selected.clear();
    e.clip.tracks.forEach((tr, ti) => tr.times.forEach((_, ki) => selected.add(ti + ':' + ki)));
    draw();
  }

  canvas.addEventListener('keydown', (ev) => {
    if (isTextInput(ev.target) && ev.target !== canvas) return;
    const mod = ev.ctrlKey || ev.metaKey;
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && selected.size) { ev.preventDefault(); ev.stopPropagation(); deleteSelected(); }
    else if (mod && ev.key.toLowerCase() === 'a') { ev.preventDefault(); ev.stopPropagation(); selectAll(); }
    else if (mod && ev.key.toLowerCase() === 'c' && selected.size) { ev.preventDefault(); ev.stopPropagation(); copyKeys(); }
    else if (mod && ev.key.toLowerCase() === 'v' && keyClipboard) { ev.preventDefault(); ev.stopPropagation(); pasteKeys(); }
  });

  function scrubTo(x) {
    const e = entry();
    let t = snapT(Math.max(0, xToT(x)));
    if (e) t = Math.min(t, e.clip.duration);
    app.setTime(e ? t / (e.speed || 1) : t);
  }

  // ------------------------------------------------------------ resize handle
  new ResizeObserver(resize).observe(body);
  app.on('time', () => { syncTime(); draw(false); });
  app.on('play', () => { syncBar(); draw(); });
  app.on('keys', () => { syncBar(); draw(); });
  app.on('clips', () => { syncBar(); draw(); });
  app.on('activeclip', () => { syncBar(); draw(); });
  app.on('selection', () => {
    const o = app.selection.object;
    if (o) expanded.add(o.uuid);
    syncBar(); draw();
  });
  app.on('settings', (k) => { if (k === 'fps' || k === 'snap' || k === 'autoKey') { fpsSel.value = String(fps()); syncBar(); draw(); } });
  app.on('frame', () => { if (app.transport.playing) draw(false); });
  syncBar();
  resize();
  ui.fitTimeline = fit;
}
