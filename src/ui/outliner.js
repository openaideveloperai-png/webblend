// Scene tree: models -> objects -> bones. Lazy expansion, filter, visibility.
import { h, icon, clear } from './dom.js';
import { dropdown } from './toast.js';
import { translateName } from '../core/jp.js';

const MAX_CHILDREN = 250;

// name, plus an English translation for Japanese names (MMD rigs)
const trCache = new Map();
function nameEl(o) {
  const name = o.name || (o.isMesh ? 'Mesh' : o.isBone ? 'Bone' : o.type);
  let t = trCache.get(name);
  if (t === undefined) { t = translateName(name); trCache.set(name, t); }
  if (!t) return h('span', { class: 'ol-name', title: name }, name);
  return h('span', { class: 'ol-name', title: `${name} — ${t}` }, name, h('span', { class: 'ol-tr' }, ' ' + t));
}

function kindIcon(o, model) {
  if (o === model.root) {
    if (model.kind === 'character' || model.humanoid) return ['person', 'person'];
    if (o.isLight) return ['light', ''];
    if (o.isCamera) return ['camera', ''];
    if (model.kind === 'image') return ['image', ''];
    if (model.bones.length) return ['bone', 'bone'];
  }
  if (o.isBone) return ['bone', 'bone'];
  if (o.isLight) return ['light', ''];
  if (o.isCamera) return ['camera', ''];
  if (o.isMesh || o.isPoints || o.isLine) return ['mesh', ''];
  return ['group', ''];
}

function visibleChildren(o) {
  return o.children.filter((c) => !c.userData.editorOnly && !c.userData.helper);
}

// hidden objects (rigid bodies, colliders, cages...) and groups holding only those
function showsSomething(o, memo) {
  const k = 'v:' + o.id;
  if (memo.has(k)) return memo.get(k);
  const r = o.visible && (!!(o.isMesh || o.isPoints || o.isLine || o.isLight) || o.children.some((c) => showsSomething(c, memo)));
  memo.set(k, r);
  return r;
}
function isHiddenStuff(o, memo) {
  if (memo.has(o)) return memo.get(o);
  let r = false;
  if (!o.isBone && !o.isCamera && !showsSomething(o, memo) && !o.children.some((c) => c.isBone)) {
    if (!o.visible || o.userData.hiddenInFile) r = true;
    else if (!o.isMesh && !o.isLight && !o.isPoints && !o.isLine) {
      const kids = visibleChildren(o);
      r = kids.length > 0 && kids.every((c) => isHiddenStuff(c, memo));
    }
  }
  memo.set(o, r);
  return r;
}

// what an eye toggle switches: the object itself, or for an object node whose
// only job is holding its mesh, that mesh (so hidden-in-file parts come back)
function drawable(o) {
  const content = o.children.filter((c) => (c.isMesh || c.isPoints || c.isLine || c.isLight) && !c.children.length);
  if (o.userData.hiddenInFile && content.length) return content;
  if (!o.visible) return [o];
  if (content.length && content.every((c) => !c.visible)) return content;
  return [o];
}

function isAncestorOf(a, b) { for (let p = b.parent; p; p = p.parent) if (p === a) return true; return false; }

export function initOutliner(app, ui) {
  const root = document.getElementById('outliner');
  const search = document.getElementById('ol-search');
  const expanded = new Set();
  let query = '';

  const expandTo = (o) => {
    let p = o.parent;
    while (p && p !== app.world) { expanded.add(p.uuid); p = p.parent; }
  };

  const row = (o, model, depth) => {
    const kids = visibleChildren(o);
    const isOpen = expanded.has(o.uuid);
    const [ic, icCls] = kindIcon(o, model);
    const sel = app.selection.object === o;
    const caret = h('button', { class: 'ol-caret' + (isOpen ? ' open' : '') + (kids.length ? '' : ' empty'), 'aria-label': isOpen ? 'Collapse' : 'Expand', tabindex: -1 }, icon('chevron'));
    caret.addEventListener('click', (e) => { e.stopPropagation(); if (isOpen) expanded.delete(o.uuid); else expanded.add(o.uuid); render(); });
    const r = h('div', { class: 'ol-row' + (sel ? ' sel' : '') + (o === model.root ? ' model' : ''), style: { paddingLeft: 6 + depth * 14 + 'px' }, role: 'treeitem', 'aria-selected': sel ? 'true' : 'false', 'aria-expanded': kids.length ? String(isOpen) : undefined, tabindex: sel ? 0 : -1 },
      caret, h('span', { class: 'ol-icon ' + icCls }, icon(ic)), nameEl(o));
    if (o === model.root) {
      if (model.clips.length) r.append(h('span', { class: 'ol-badge', title: `${model.clips.length} animation clip(s)` }, `${model.clips.length}▸`));
      const eye = h('button', { class: 'ol-eye' + (o.visible ? '' : ' off'), title: o.visible ? 'Hide' : 'Show', 'aria-label': o.visible ? 'Hide' : 'Show' }, icon(o.visible ? 'eye' : 'eyeoff'));
      eye.addEventListener('click', (e) => { e.stopPropagation(); model.setVisible(!o.visible); app.viewport.requestRender(); render(); });
      r.append(eye);
    } else if (!o.isBone) {
      // parts can be shown/hidden too (e.g. a helper object a file left visible)
      const target = drawable(o);
      const on = target.every((t) => t.visible);
      const eye = h('button', { class: 'ol-eye' + (on ? '' : ' off'), title: on ? 'Hide' : 'Show', 'aria-label': on ? 'Hide' : 'Show' }, icon(on ? 'eye' : 'eyeoff'));
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        const before = target.map((t) => t.visible);
        const set = (vals) => { target.forEach((t, i) => { t.visible = vals[i]; }); app.viewport.requestRender(); render(); };
        const after = target.map(() => !on);
        set(after);
        app.history.push({ label: on ? 'Hide' : 'Show', undo: () => set(before), redo: () => set(after) });
      });
      r.append(eye);
    }
    r.addEventListener('click', () => app.select(o, model));
    r.addEventListener('dblclick', () => app.viewport.frameObject(o));
    r.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      app.select(o, model);
      dropdown([
        { label: 'Frame in view', icon: 'frame', action: () => app.viewport.frameObject(o) },
        { label: 'Insert key', icon: 'key', kbd: 'K', action: () => app.keySelection() },
        o === model.root ? { label: 'Duplicate', icon: 'copy', action: () => app.duplicateModel(model) } : null,
        o === model.root ? { label: 'Delete', icon: 'trash', action: () => app.removeModel(model) } : null,
        o.isCamera ? { label: 'Look through camera', icon: 'camera', action: () => app.lookThrough(model) } : null,
      ], { x: e.clientX, y: e.clientY });
    });
    return { r, kids, isOpen };
  };

  const render = () => {
    clear(root);
    if (!app.models.length) {
      root.append(h('div', { class: 'empty-note' }, 'Nothing here yet. ', h('b', {}, 'Drop a model'), ' on the page, or use ', h('b', {}, 'Add → Demo mannequin'), ' to try animating right away.'));
      return;
    }
    root.setAttribute('role', 'tree');
    if (query) {
      let n = 0;
      for (const model of app.models) {
        model.root.traverse((o) => {
          if (n > 400 || o.userData.editorOnly || o.userData.helper) return;
          const nm = (o.name || '').toLowerCase();
          if (nm.includes(query) || (translateName(o.name) || '').toLowerCase().includes(query)) { root.append(row(o, model, 0).r); n++; }
        });
      }
      if (!n) root.append(h('div', { class: 'empty-note' }, 'No matches.'));
      return;
    }
    const memo = new Map();
    const walk = (o, model, depth) => {
      const { r, kids, isOpen } = row(o, model, depth);
      root.append(r);
      if (isOpen) {
        const sel = app.selection.object;
        const hidden = kids.filter((c) => isHiddenStuff(c, memo) && c !== sel && !(sel && isAncestorOf(c, sel)));
        const shown = hidden.length >= 2 ? kids.filter((c) => !hidden.includes(c)) : kids;
        shown.slice(0, MAX_CHILDREN).forEach((c) => walk(c, model, depth + 1));
        if (shown.length > MAX_CHILDREN) root.append(h('div', { class: 'ol-more' }, `${shown.length - MAX_CHILDREN} more — use the filter box`));
        if (hidden.length >= 2) {
          // tuck hidden helpers away behind one row
          const key = o.uuid + ':hidden';
          const open = expanded.has(key);
          const hr = h('div', { class: 'ol-row ol-hidden-group', style: { paddingLeft: 6 + (depth + 1) * 14 + 'px' }, role: 'treeitem', 'aria-expanded': String(open), title: 'Objects that are hidden in the file (physics bodies, helpers...)' },
            h('button', { class: 'ol-caret' + (open ? ' open' : ''), tabindex: -1, 'aria-label': open ? 'Collapse' : 'Expand' }, icon('chevron')),
            h('span', { class: 'ol-icon' }, icon('eyeoff')), h('span', { class: 'ol-name' }, `${hidden.length} hidden objects`));
          hr.addEventListener('click', () => { if (open) expanded.delete(key); else expanded.add(key); render(); });
          root.append(hr);
          if (open) hidden.slice(0, MAX_CHILDREN).forEach((c) => walk(c, model, depth + 2));
        }
      }
    };
    for (const model of app.models) walk(model.root, model, 0);
    root.querySelector('.ol-row.sel')?.scrollIntoView({ block: 'nearest' });
  };

  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); render(); });
  app.on('models', render);
  let sgPending = false;
  app.on('scenegraph', () => { if (sgPending) return; sgPending = true; requestAnimationFrame(() => { sgPending = false; render(); }); });
  app.on('clips', render);
  app.on('selection', (s) => { if (s.object) expandTo(s.object); render(); });
  // keyboard: up/down through rows when the tree has focus
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rows = [...root.querySelectorAll('.ol-row')];
    const i = rows.findIndex((r) => r.classList.contains('sel'));
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) { e.preventDefault(); next.click(); setTimeout(() => root.querySelector('.ol-row.sel')?.focus(), 0); }
  });
  render();
  ui.renderOutliner = render;
}
