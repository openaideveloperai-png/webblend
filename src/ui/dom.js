// Minimal DOM helpers + inline icon set (no external assets).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function icon(name, cls = '') {
  const span = document.createElement('span');
  span.className = 'ico ' + cls;
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = ICONS[name] || ICONS.dot;
  return span;
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

const s = (d, extra = '') => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ${extra}>${d}</svg>`;

export const ICONS = {
  dot: s('<circle cx="8" cy="8" r="2"/>'),
  move: s('<path d="M8 1.5v13M1.5 8h13M8 1.5 6 3.5M8 1.5l2 2M8 14.5l-2-2M8 14.5l2-2M1.5 8l2-2M1.5 8l2 2M14.5 8l-2-2M14.5 8l-2 2"/>'),
  rotate: s('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2v3h-3"/>'),
  scale: s('<rect x="2" y="7" width="7" height="7" rx="1"/><path d="M9 7l5-5M10 2h4v4"/>'),
  globe: s('<circle cx="8" cy="8" r="6"/><path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12"/>'),
  local: s('<path d="M3 13V3M3 13h10M3 13l7-7"/>'),
  play: '<svg viewBox="0 0 16 16"><path d="M4.5 2.8v10.4c0 .5.5.8.9.5l8-5.2a.6.6 0 0 0 0-1L5.4 2.3c-.4-.3-.9 0-.9.5Z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 16 16"><rect x="3.5" y="2.5" width="3" height="11" rx=".8" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx=".8" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="1.2" fill="currentColor"/></svg>',
  first: s('<path d="M3.5 3v10M12.5 3.5 6 8l6.5 4.5z" fill="currentColor"/>'),
  last: s('<path d="M12.5 3v10M3.5 3.5 10 8l-6.5 4.5z" fill="currentColor"/>'),
  prevkey: s('<path d="M10 8 6.5 4.5 3 8l3.5 3.5z"/><path d="M13 4.5v7"/>'),
  nextkey: s('<path d="M6 8l3.5-3.5L13 8l-3.5 3.5z"/><path d="M3 4.5v7"/>'),
  key: s('<path d="M8 2.5 13.5 8 8 13.5 2.5 8z" fill="currentColor"/>'),
  keyo: s('<path d="M8 2.5 13.5 8 8 13.5 2.5 8z"/>'),
  record: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg>',
  loop: s('<path d="M3 7a4 4 0 0 1 4-4h5l-2-2M13 9a4 4 0 0 1-4 4H4l2 2"/>'),
  magnet: s('<path d="M3 3v5a5 5 0 0 0 10 0V3h-3v5a2 2 0 0 1-4 0V3z"/><path d="M3 5.5h3M10 5.5h3"/>'),
  eye: s('<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>'),
  eyeoff: s('<path d="M2 2l12 12M6.6 3.7A6 6 0 0 1 8 3.5c4 0 6.5 4.5 6.5 4.5a12 12 0 0 1-1.9 2.5M4.4 4.9A12 12 0 0 0 1.5 8S4 12.5 8 12.5a6 6 0 0 0 2.6-.6"/>'),
  bone: s('<path d="M5 11l6-6"/><circle cx="4" cy="12" r="1.6"/><circle cx="12" cy="4" r="1.6"/><circle cx="3" cy="10.5" r="1"/><circle cx="13.5" cy="5.5" r="1"/>'),
  mesh: s('<path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z"/><path d="M8 8v6.2M8 8l5.5-3M8 8 2.5 5"/>'),
  person: s('<circle cx="8" cy="3.3" r="1.6"/><path d="M8 5.5v4.5M5 7.5h6M8 10l-2.2 4M8 10l2.2 4"/>'),
  light: s('<path d="M8 1.5a4 4 0 0 0-2.3 7.3c.5.4.8.9.8 1.5V11h3v-.7c0-.6.3-1.1.8-1.5A4 4 0 0 0 8 1.5z"/><path d="M6.5 13h3M7 14.5h2"/>'),
  camera: s('<rect x="1.5" y="4.5" width="9" height="7" rx="1.2"/><path d="M10.5 7l4-2v6l-4-2"/>'),
  group: s('<rect x="2" y="2" width="5" height="5" rx="1"/><rect x="9" y="2" width="5" height="5" rx="1"/><rect x="2" y="9" width="5" height="5" rx="1"/><rect x="9" y="9" width="5" height="5" rx="1"/>'),
  image: s('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="5.5" cy="6" r="1.2"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>'),
  plus: s('<path d="M8 3v10M3 8h10"/>'),
  minus: s('<path d="M3 8h10"/>'),
  trash: s('<path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4"/>'),
  copy: s('<rect x="5" y="5" width="8.5" height="8.5" rx="1.2"/><path d="M11 5V3.2c0-.4-.3-.7-.7-.7H3.2c-.4 0-.7.3-.7.7v7.1c0 .4.3.7.7.7H5"/>'),
  gear: s('<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>'),
  sparkle: s('<path d="M8 1.5l1.3 4.2 4.2 1.3-4.2 1.3L8 12.5 6.7 8.3 2.5 7l4.2-1.3z"/><path d="M13 11l.6 1.4 1.4.6-1.4.6L13 15l-.6-1.4L11 13l1.4-.6z"/>'),
  upload: s('<path d="M8 11V2.5M4.5 6 8 2.5 11.5 6M2.5 11v2.5h11V11"/>'),
  download: s('<path d="M8 2.5V11M4.5 7.5 8 11l3.5-3.5M2.5 11v2.5h11V11"/>'),
  folder: s('<path d="M1.5 4.5c0-.6.4-1 1-1h3.3l1.5 1.5h6.2c.6 0 1 .4 1 1v6.5c0 .6-.4 1-1 1h-11c-.6 0-1-.4-1-1z"/>'),
  chevron: s('<path d="M6 4l4 4-4 4"/>'),
  chevdown: s('<path d="M4 6l4 4 4-4"/>'),
  close: s('<path d="M4 4l8 8M12 4l-8 8"/>'),
  search: s('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>'),
  undo: s('<path d="M5.5 3 2.5 6l3 3"/><path d="M2.5 6H10a3.5 3.5 0 0 1 0 7H6"/>'),
  redo: s('<path d="M10.5 3l3 3-3 3"/><path d="M13.5 6H6a3.5 3.5 0 0 0 0 7h4"/>'),
  film: s('<rect x="2" y="2.5" width="12" height="11" rx="1.2"/><path d="M5 2.5v11M11 2.5v11M2 5.5h3M2 8h3M2 10.5h3M11 5.5h3M11 8h3M11 10.5h3"/>'),
  frame: s('<path d="M2 5V2h3M11 2h3v3M14 11v3h-3M5 14H2v-3"/><circle cx="8" cy="8" r="2"/>'),
  menu: s('<path d="M2.5 4h11M2.5 8h11M2.5 12h11"/>'),
  panelLeft: s('<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M6 2.5v11"/>'),
  panelRight: s('<rect x="1.5" y="2.5" width="13" height="11" rx="1.2"/><path d="M10 2.5v11"/>'),
  send: s('<path d="M14 2 7 9M14 2l-4.5 12L7 9 2 6.5z"/>'),
  reset: s('<path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1"/><path d="M2.5 2.5v3h3"/>'),
  mirror: s('<path d="M8 1.5v13" stroke-dasharray="1.5 1.5"/><path d="M6 4 2 12h4zM10 4l4 8h-4z"/>'),
  target: s('<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="2"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2"/>'),
  potato: s('<path d="M4.2 3.2c2-1.6 5.6-1.6 7.6.4s2 5.8.6 8.2-5.3 3.1-7.9 1.6S1.6 9 2 6.6c.2-1.4 1-2.6 2.2-3.4z"/><circle cx="6" cy="6.5" r=".6" fill="currentColor"/><circle cx="9.5" cy="9" r=".6" fill="currentColor"/><circle cx="7" cy="10.5" r=".5" fill="currentColor"/>'),
  bolt: s('<path d="M9 1.5 3.5 9H8l-1 5.5L12.5 7H8z"/>'),
  info: s('<circle cx="8" cy="8" r="6"/><path d="M8 7.2V11M8 5v.1"/>'),
  warn: s('<path d="M8 2 14.5 13.5h-13z"/><path d="M8 6.5v3.2M8 11.5v.1"/>'),
  check: s('<path d="M3 8.5 6.5 12 13 4.5"/>'),
  dots: s('<circle cx="3.5" cy="8" r="1" fill="currentColor"/><circle cx="8" cy="8" r="1" fill="currentColor"/><circle cx="12.5" cy="8" r="1" fill="currentColor"/>'),
  key2: s('<circle cx="5" cy="8" r="3"/><path d="M8 8h6.5M12 8v2.5M14 8v2"/>'),
  wand: s('<path d="M2.5 13.5l8-8M9 3.5l1-2 1 2 2 1-2 1-1 2-1-2-2-1zM12.5 9l.5 1 1 .5-1 .5-.5 1-.5-1-1-.5 1-.5z"/>'),
};
