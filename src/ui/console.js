// The hidden console: press 8 8 8 8 X (holding Ctrl or not) while Settings is open.
// Runs JavaScript in this page for this session only, with WebBlend's internals at hand,
// so you can make your own tools (menu items with shortcuts), panels, styles and
// per-frame behaviour. Nothing here is saved: a reload starts clean.
import * as THREE from 'three';
import { h, icon } from './dom.js';

// ---------------------------------------------------------------- unlock sequence
const SEQ = ['8', '8', '8', '8', 'x'];
export function watchUnlock(onUnlock) {
  let pos = 0;
  const onKey = (e) => {
    if (['Control', 'Shift', 'Meta', 'Alt'].includes(e.key)) return;
    const mod = e.ctrlKey || e.metaKey;
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
    if (typing && !mod) return; // typing 8888x into a box isn't the code
    const k = e.code === 'Digit8' || e.code === 'Numpad8' || e.key === '8' ? '8' : e.code === 'KeyX' || (e.key || '').toLowerCase() === 'x' ? 'x' : null;
    if (k && k === SEQ[pos]) {
      if (mod) e.preventDefault();
      pos++;
      if (pos === SEQ.length) { pos = 0; e.preventDefault(); e.stopPropagation(); onUnlock(); }
    } else pos = k === SEQ[0] ? 1 : 0;
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}

// ---------------------------------------------------------------- running code
let scriptN = 0;
const API_NAMES = ['app', 'webblend', 'THREE', 'api', 'print', 'sel', 'bones', 'model', 'addTool', 'removeTool', 'on', 'every', 'panel', 'css', 'h', 'select', 'setting', 'help'];

// compile a snippet into an async function of the API; the last expression is returned
// when the snippet is a single expression. new Function first; pages that forbid eval
// (strict content policies) get it through an inline script instead.
function compile(code) {
  const bodies = [`return (${code}\n);`, lastReturned(code), code].filter(Boolean);
  let lastErr = null;
  for (const body of bodies) {
    const src = `return (async () => {\n${body}\n})();`;
    try { return new Function(...API_NAMES, src); } catch (e) {
      lastErr = e;
      if (e instanceof SyntaxError) continue;
      // eval blocked: try an inline script
      const fn = viaScript(src);
      if (fn) return fn;
    }
  }
  // both blocked or both failed: one more try through a script for each form
  for (const body of bodies) { const fn = viaScript(`return (async () => {\n${body}\n})();`); if (fn) return fn; }
  throw lastErr || new Error('Could not run that');
}
// "a; b; c" or "a\nb\nc" -> "a; b; return (c)" (so the last value prints), when c is an expression
const STATEMENT = /^(const|let|var|if|for|while|do|return|function|class|throw|try|switch|import|export|break|continue|async\s+function|\}|\/\/)/;
function lastReturned(code) {
  let depth = 0, q = null, cut = -1;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue; }
    if (c === '"' || c === "'" || c === '`') q = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && (c === ';' || c === '\n') && code.slice(i + 1).trim()) cut = i;
  }
  if (cut < 0) return null;
  const tail = code.slice(cut + 1).trim().replace(/;$/, '');
  if (!tail || STATEMENT.test(tail)) return null;
  return `${code.slice(0, cut + 1)}\nreturn (${tail}\n);`;
}

function viaScript(src) {
  const id = '__wbConsole' + ++scriptN;
  const el = document.createElement('script');
  el.textContent = `window.${id} = function (${API_NAMES.join(', ')}) {\n${src}\n};`;
  const swallow = (e) => { e.preventDefault(); };
  window.addEventListener('error', swallow, true);
  try { document.head.append(el); } finally { window.removeEventListener('error', swallow, true); el.remove(); }
  const fn = window[id];
  try { delete window[id]; } catch { window[id] = undefined; }
  return typeof fn === 'function' ? fn : null;
}

const fmt = (v, depth = 0) => {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return depth ? JSON.stringify(v) : v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'function') return `ƒ ${v.name || '(anonymous)'}()`;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (v.isVector3 || v.isVector2 || v.isQuaternion || v.isEuler) return `${v.constructor.name}(${v.toArray().map((n) => (typeof n === 'number' ? +n.toFixed(4) : n)).join(', ')})`;
  if (v.isObject3D) return `${v.type} "${v.name}"${v.children.length ? ` (${v.children.length} children)` : ''}`;
  if (Array.isArray(v)) return depth > 1 ? `[…${v.length}]` : `[${v.slice(0, 20).map((x) => fmt(x, depth + 1)).join(', ')}${v.length > 20 ? `, …${v.length - 20} more` : ''}]`;
  if (v instanceof Map) return `Map(${v.size})`;
  if (v instanceof Set) return `Set(${v.size})`;
  try {
    if (depth > 1) return '{…}';
    const keys = Object.keys(v).slice(0, 16);
    return `{ ${keys.map((k) => `${k}: ${fmt(v[k], depth + 1)}`).join(', ')}${Object.keys(v).length > 16 ? ', …' : ''} }`;
  } catch { return String(v); }
};

// ---------------------------------------------------------------- the API given to snippets
export function consoleAPI(app, ui, out) {
  app.sessionTools = app.sessionTools || [];
  const subs = app._consoleSubs || (app._consoleSubs = []);
  const print = (...a) => { out(a.map((x) => fmt(x)).join(' ')); return a[a.length - 1]; };
  const api = {
    app, webblend: app, THREE,
    print,
    sel: () => app.selection,
    bones: () => app.selectedBones(),
    model: () => app.selection.model,
    // a menu item in Tools (and a shortcut if key is given, e.g. 'g' or 'Shift+G')
    addTool(name, fn, opts = {}) {
      if (typeof name !== 'string' || typeof fn !== 'function') throw new TypeError('addTool(name, fn, { key, icon })');
      app.sessionTools = app.sessionTools.filter((t) => t.name !== name);
      app.sessionTools.push({ name, fn, key: opts.key || null, icon: opts.icon || 'wand' });
      app.emit('tools');
      return `Added "${name}" to the Tools menu${opts.key ? ` (${opts.key})` : ''}`;
    },
    removeTool(name) { const n = app.sessionTools.length; app.sessionTools = app.sessionTools.filter((t) => t.name !== name); app.emit('tools'); return n !== app.sessionTools.length; },
    // listen to the app: 'selection', 'transform', 'time', 'keys', 'models', 'frame' (every frame, with dt)…
    on(event, fn) { app.on(event, fn); const off = () => app.off(event, fn); subs.push(off); return off; },
    // keeps the viewport drawing every frame while it's on
    every(fn) {
      const off = api.on('frame', fn);
      app.viewport.continuous = (app.viewport.continuous || 0) + 1;
      app.viewport.requestRender();
      let done = false;
      return () => { if (done) return; done = true; off(); app.viewport.continuous = Math.max(0, app.viewport.continuous - 1); };
    },
    // a small floating window of your own; returns its body element
    panel(title = 'Panel') { return floating(title, { width: 300, height: 220 }).body; },
    css(text) { const st = document.createElement('style'); st.textContent = String(text); st.dataset.console = '1'; document.head.append(st); return st; },
    h,
    select(what) {
      const m = app.selection.model || app.models[0];
      if (!m) return null;
      const list = (Array.isArray(what) ? what : [what]).map((x) => (typeof x === 'string' ? m.bones.find((b) => b.name === x) : x)).filter(Boolean);
      if (what instanceof RegExp) list.push(...m.bones.filter((b) => what.test(b.name)));
      if (list.length === 1 && !list[0].isBone) app.select(list[0], m); else app.selectBones(list, m);
      return list.length;
    },
    setting(k, v) { if (v === undefined) return app.settings.get(k); app.setSetting(k, v); return v; },
    help() { out(HELP); },
  };
  api.api = api;
  return api;
}

const HELP = `app (= webblend)   the app: app.models, app.selection, app.viewport, app.settings, app.history…
THREE              three.js
print(…)           write here
sel() bones() model()   the selection, the selected bones, the selected model
select('name' | /regex/ | [bones])   select bones by name
addTool(name, fn, { key: 'g', icon })   a menu item in Tools (fn gets this same API)
removeTool(name)
on(event, fn)      'selection' 'transform' 'time' 'keys' 'models' 'frame' (every frame, fn(dt))
every(fn)          run fn(dt) every frame
panel(title)       a small window of your own (returns its body; use h(tag, attrs, …children))
css(text)          add your own styles, e.g. css(':root { --accent: #ff4fd8 }')
setting(key, value)   read or change a setting
Everything lasts until the page is reloaded.`;

const EXAMPLES = [
  ['Select every lip bone and spread them', `select(/lip|唇/i)\napp.spreadSelected(0.2)`],
  ['A tool: mirror the selected bones’ rotation (Shift+M)', `addTool('Mirror rotation to the other side', () => {\n  const m = model();\n  for (const b of bones()) {\n    const o = m.bones.find((x) => x.name === b.name.replace(/left/i, 'Right').replace(/right/i, 'Left') && x !== b);\n    if (o) o.quaternion.set(b.quaternion.x, -b.quaternion.y, -b.quaternion.z, b.quaternion.w);\n  }\n  app.afterEdit();\n}, { key: 'Shift+M' })`],
  ['A panel with a slider that turns the head', `const body = panel('Head turn')\nconst head = model().humanoid.map.head\nconst q0 = head.quaternion.clone()\nconst r = h('input', { type: 'range', min: -60, max: 60, value: 0 })\nr.oninput = () => { head.quaternion.copy(q0).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.value * Math.PI / 180)); app.afterEdit() }\nbody.append(r)`],
  ['Pink theme', `css(':root { --accent: #ff4fd8; --accent-2: #ff8ae6 }')`],
  ['Spin the selected model every frame (stopSpin() ends it)', `const o = sel().object\nwindow.stopSpin = every((dt) => { o.rotation.y += dt })`],
  ['List the bones of the selected model', `model().bones.map((b) => b.name)`],
];

// ---------------------------------------------------------------- windows
function floating(title, { width = 640, height = 440, onClose } = {}) {
  const body = h('div', { class: 'fw-b' });
  const close = h('button', { class: 'ibtn', 'aria-label': 'Close' }, icon('close'));
  const head = h('div', { class: 'fw-h' }, h('span', { class: 'fw-t' }, title), close);
  const n = document.querySelectorAll('.floatwin').length;
  const el = h('div', { class: 'floatwin', role: 'dialog', 'aria-label': title, style: { width: `min(${width}px, calc(100vw - 32px))`, height: `min(${height}px, calc(100vh - 80px))`, right: `${16 + n * 24}px`, bottom: `${56 + n * 24}px` } }, head, body);
  close.addEventListener('click', () => { el.remove(); onClose?.(); });
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(), sx = e.clientX - r.left, sy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = (ev) => {
      el.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - sx)) + 'px';
      el.style.top = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - sy)) + 'px';
      el.style.right = 'auto'; el.style.bottom = 'auto';
    };
    const up = () => { head.removeEventListener('pointermove', move); head.removeEventListener('pointerup', up); };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  document.body.append(el);
  return { el, body, close: () => close.click() };
}

let open = null;
const history = [];
let draft = '';
export function openConsole(app, ui) {
  if (open && open.el.isConnected) { open.input.focus(); return open; }
  app.consoleUnlocked = true;
  const w = floating('Console (this session only)', { width: 680, height: 460 });
  const outEl = h('div', { class: 'con-out', role: 'log', 'aria-live': 'polite' });
  const write = (text, cls = '') => { outEl.append(h('div', { class: 'con-line ' + cls }, text)); outEl.scrollTop = outEl.scrollHeight; };
  const api = consoleAPI(app, ui, (t) => write(t));
  const input = h('textarea', { class: 'con-in', spellcheck: 'false', autocomplete: 'off', placeholder: 'JavaScript… (Ctrl+Enter runs, ↑ / ↓ history)  ·  try help()', rows: 5 });
  input.value = draft;
  let hi = history.length;
  const run = async () => {
    const code = input.value.trim();
    if (!code) return;
    history.push(code); hi = history.length;
    draft = ''; input.value = '';
    write('› ' + code, 'cmd');
    try {
      const fn = compile(code);
      const v = await fn(...API_NAMES.map((n) => (n === 'api' ? api : api[n])));
      if (v !== undefined) write(fmt(v), 'val');
      app.viewport.requestRender();
    } catch (e) {
      write(fmt(e), 'err');
    }
  };
  input.addEventListener('input', () => { draft = input.value; });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); run(); return; }
    const one = !input.value.includes('\n');
    if (e.key === 'ArrowUp' && one && hi > 0) { e.preventDefault(); hi--; input.value = history[hi]; }
    else if (e.key === 'ArrowDown' && one && hi < history.length) { e.preventDefault(); hi++; input.value = history[hi] || ''; }
  });
  const ex = h('select', { 'aria-label': 'Examples' }, h('option', { value: '' }, 'Examples…'), ...EXAMPLES.map(([l], i) => h('option', { value: String(i) }, l)));
  ex.addEventListener('change', () => { if (ex.value !== '') { input.value = EXAMPLES[+ex.value][1]; draft = input.value; ex.value = ''; input.focus(); } });
  const toolsList = h('div', { class: 'con-tools' });
  const drawTools = () => {
    const t = app.sessionTools || [];
    toolsList.replaceChildren(...(t.length ? [h('span', { class: 'hint' }, 'Your tools: '), ...t.map((x) => h('span', { class: 'chip' }, x.name + (x.key ? ` (${x.key})` : ''), h('button', { class: 'ibtn', 'aria-label': 'Remove ' + x.name, onclick: () => { api.removeTool(x.name); } }, icon('close'))))] : []));
  };
  app.on('tools', drawTools);
  drawTools();
  const bar = h('div', { class: 'con-bar' },
    h('button', { class: 'btn sm primary', onclick: run }, icon('play'), 'Run'),
    h('button', { class: 'btn sm ghost', onclick: () => outEl.replaceChildren() }, 'Clear'),
    ex,
    h('span', { class: 'grow' }),
    h('button', { class: 'btn sm ghost', onclick: () => api.help() }, 'Help'));
  w.body.append(outEl, toolsList, input, bar);
  if (!outEl.childElementCount) write('Runs JavaScript in this page, for this session only. Type help() for what you can use, or pick an example.', 'hint');
  setTimeout(() => input.focus(), 30);
  open = { el: w.el, input, close: w.close };
  return open;
}

// run a tool added from the console
export function runTool(app, t, api) {
  try {
    const r = t.fn(api);
    if (r && typeof r.then === 'function') r.catch((e) => app.toast(`${t.name}: ${e.message || e}`, 'error'));
    app.viewport.requestRender();
  } catch (e) { app.toast(`${t.name}: ${e.message || e}`, 'error'); }
}

// does a key event match a tool's key ('g', 'Shift+G', 'Ctrl+Alt+T')?
export function keyMatches(spec, e) {
  if (!spec) return false;
  const parts = String(spec).split('+').map((p) => p.trim().toLowerCase());
  const key = parts.pop();
  const want = { ctrl: parts.includes('ctrl') || parts.includes('cmd'), shift: parts.includes('shift'), alt: parts.includes('alt') };
  return (e.key || '').toLowerCase() === key && !!(e.ctrlKey || e.metaKey) === want.ctrl && !!e.shiftKey === want.shift && !!e.altKey === want.alt;
}
