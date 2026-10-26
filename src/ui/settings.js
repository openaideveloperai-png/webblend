// Settings dialog.
import { h, icon } from './dom.js';
import { modal } from './toast.js';
import { QUALITY_LEVELS, QUALITY_PRESETS } from '../core/settings.js';
import { fmtBytes, inArtifact } from '../core/util.js';

const Q_ICONS = { potato: 'potato', low: 'bolt', medium: 'mesh', high: 'sparkle', ultra: 'sparkle' };
const Q_DESC = {
  potato: 'Lowest resolution, 30 fps cap, small textures. For very old or 4 GB PCs.',
  low: 'No shadows or reflections, reduced resolution. Smooth on most laptops.',
  medium: 'Shadows and reflections at normal resolution.',
  high: 'Sharper rendering and softer shadows.',
  ultra: 'Full resolution on high-DPI screens, big textures.',
};

export const SHORTCUTS = [
  ['Space', 'Play / pause'], ['K', 'Key selected object'], ['Shift+K', 'Key whole pose (all bones)'], ['Alt+K', 'Delete keys at current frame'],
  ['W / E / R', 'Move / rotate / scale'], ['Q', 'Local / world axes'], ['F', 'Frame selected'], ['Shift+F', 'Frame everything'],
  ['← / →', 'Previous / next frame'], ['↑ / ↓', 'Next / previous keyframe'], ['Shift+← / →', 'Start / end'],
  ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Ctrl+C / Ctrl+V', 'Copy / paste pose (keys when timeline focused)'], ['Ctrl+D', 'Duplicate model'],
  ['Del', 'Delete selected keys, or the selected model'], ['P', 'Select parent'], ['H', 'Hide / show model'], ['Esc', 'Deselect'],
  ['1 / 3 / 7 / 5', 'Front / right / top / perspective view'], ['0', 'Look through camera'], ['Ctrl+O', 'Open files'], ['Ctrl+E', 'Export GLB'],
  ['Timeline', 'Drag keys to retime · double-click to key · right-click for curves · Ctrl+wheel to zoom'],
];

export function openSettings(app, ui, section) {
  const s = app.settings;
  const sec = (id, title, ...children) => h('div', { class: 'sec', id: 'set-' + id }, h('div', { class: 'sec-h' }, h('span', { class: 'sec-t' }, title)), ...children);
  const toggle = (key, label, onChange) => {
    const c = h('input', { type: 'checkbox', id: 'set-' + key, checked: s.get(key) || undefined });
    c.addEventListener('change', () => { app.setSetting(key, c.checked); onChange?.(c.checked); });
    return h('div', { class: 'field' }, h('label', { class: 'toggle', for: 'set-' + key }, c, label));
  };
  const select = (key, label, options, cast = (v) => v) => {
    const sel = h('select', { id: 'set-' + key }, ...options.map(([v, l]) => h('option', { value: v, selected: String(s.get(key)) === String(v) || undefined }, l)));
    sel.addEventListener('change', () => app.setSetting(key, cast(sel.value)));
    return h('div', { class: 'field' }, h('label', { for: 'set-' + key }, label), sel);
  };

  // performance
  const qgrid = h('div', { class: 'qgrid', role: 'radiogroup', 'aria-label': 'Quality mode' });
  const qdesc = h('div', { class: 'hint' });
  const drawQ = () => {
    qgrid.replaceChildren(...QUALITY_LEVELS.map((q) => {
      const b = h('button', { class: 'qbtn' + (s.get('quality') === q ? ' on' : ''), role: 'radio', 'aria-checked': String(s.get('quality') === q) }, icon(Q_ICONS[q]), QUALITY_PRESETS[q].label);
      b.addEventListener('click', () => { app.setQuality(q); drawQ(); });
      return b;
    }));
    qdesc.textContent = Q_DESC[s.get('quality')] || '';
  };
  drawQ();
  const mem = performance.memory ? `JS memory ${fmtBytes(performance.memory.usedJSHeapSize)} of ${fmtBytes(performance.memory.jsHeapSizeLimit)} limit · ` : '';
  const dev = `${navigator.deviceMemory ? navigator.deviceMemory + ' GB RAM reported · ' : ''}${navigator.hardwareConcurrency || '?'} CPU threads`;
  const perf = sec('performance', 'Performance',
    qgrid, qdesc,
    toggle('autoQuality', 'Switch to a lighter mode automatically when it lags'),
    select('textureLimitOverride', 'Max texture', [[0, 'From quality mode'], [256, '256 px'], [512, '512 px'], [1024, '1024 px'], [2048, '2048 px'], [4096, '4096 px']], Number),
    toggle('showStats', 'Show performance stats in the viewport', () => ui.toggleStats(s.get('showStats'))),
    h('div', { class: 'hint' }, mem + dev + (app.detected?.gpu ? ' · ' + app.detected.gpu : '')),
    h('div', { class: 'hint' }, 'Tips for 4 GB PCs: use Potato or Low, close other tabs, prefer .glb files, and keep textures at 1024 px or less. Big textures are downscaled when you import.'));

  const view = sec('viewport', 'Viewport',
    toggle('showGrid', 'Grid'), toggle('showAxes', 'Axis gizmo'), toggle('showSkeleton', 'Show bones (click the dots to pose)'),
    select('pickMode', 'Clicking selects', [['object', 'The part under the mouse'], ['model', 'The whole model']]),
    (() => { const c = h('input', { type: 'color', value: s.get('bgColor') }); c.addEventListener('input', () => app.setSetting('bgColor', c.value)); return h('div', { class: 'field' }, h('label', {}, 'Background'), c); })(),
    toggle('importLights', 'Import lights from .blend files'),
    toggle('demoScene', 'Start with the demo mannequin'));

  const anim = sec('animation', 'Animation',
    select('fps', 'Frame rate', [12, 24, 25, 30, 48, 60].map((f) => [f, f + ' fps']), Number),
    toggle('snap', 'Snap keys and playhead to whole frames'),
    toggle('autoKey', 'Auto-key: every change becomes a keyframe'),
    select('ikChain', 'IK drag', [[0, 'Off'], [2, '2 bones (arm / leg)'], [3, '3 bones'], [4, '4 bones']], Number));

  // AI
  const keyIn = h('input', { type: 'password', id: 'set-apikey', placeholder: 'sk-ant-…', value: s.apiKey || '', autocomplete: 'off', spellcheck: 'false' });
  const remember = h('input', { type: 'checkbox', checked: s.get('rememberKey') || undefined });
  const saveKey = () => { s.setApiKey(keyIn.value.trim(), remember.checked); app.emit('settings', 'apiKey'); };
  keyIn.addEventListener('change', saveKey);
  remember.addEventListener('change', saveKey);
  const hosted = inArtifact();
  const ai = sec('ai', 'AI assistant',
    select('aiProvider', 'Engine', [['auto', 'Automatic (best available)'], ['claude-ai', 'Claude via claude.ai (hosted page)'], ['api', 'Claude via my API key'], ['offline', 'Built-in engine only (offline)']]),
    h('div', { class: 'hint' }, hosted
      ? (app.ai.sample ? 'This page can ask Claude using your claude.ai account. You\'ll be asked to allow it the first time.' : 'Claude through claude.ai isn\'t available in this view.')
      : 'Opened as a local file: add an Anthropic API key to use Claude. The built-in engine always works without one.'),
    h('div', { class: 'field' }, h('label', { for: 'set-apikey' }, 'API key'), keyIn),
    h('div', { class: 'field' }, h('span', { class: 'flabel' }), h('label', { class: 'toggle' }, remember, 'Remember on this device'), h('button', { class: 'btn sm ghost', onclick: () => { keyIn.value = ''; saveKey(); } }, 'Clear')),
    select('aiModel', 'Model', [['claude-opus-5-5', 'Claude Opus 5.5 (best)'], ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (faster)'], ['claude-haiku-5-5', 'Claude Haiku 5.5 (fastest)']]),
    select('aiEffort', 'Effort', [['low', 'Low (quick)'], ['medium', 'Medium'], ['high', 'High (more careful)']]),
    toggle('aiAlwaysClaude', 'Send every request to Claude (even simple ones like "walk")'),
    h('div', { class: 'hint' }, 'Your key stays in this browser and is only sent to api.anthropic.com. Without "remember" it is forgotten when you close the tab.'));

  const shortcuts = sec('about', 'Keyboard shortcuts', h('div', { class: 'shortcuts' }, ...SHORTCUTS.flatMap(([k, d]) => [h('kbd', {}, k), h('span', {}, d)])),
    h('div', { class: 'hint', style: { marginTop: '12px' } }, 'WebBlend Animator runs entirely in your browser. Files you open never leave your computer.'));

  const body = h('div', {}, perf, view, anim, ai, shortcuts);
  const m = modal('Settings', body, { width: 620 });
  if (section) setTimeout(() => body.querySelector('#set-' + section)?.scrollIntoView({ block: 'start' }), 50);
  return m;
}
