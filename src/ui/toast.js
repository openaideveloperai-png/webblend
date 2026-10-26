// Toast notifications, modal dialogs and dropdown/context menus.
import { h, icon } from './dom.js';

export function initToasts(app) {
  const root = document.getElementById('toasts');
  app.toast = (msg, type = 'info', ms = 2600, action) => {
    const text = h('span', {}, msg);
    const lead = type === 'busy' ? h('div', { class: 'spin' }) : icon({ ok: 'check', warn: 'warn', error: 'warn', info: 'info' }[type] || 'info');
    const el = h('div', { class: 'toast ' + type, role: type === 'error' ? 'alert' : 'status' }, lead, text);
    let closed = false;
    const close = () => { if (closed) return; closed = true; el.remove(); };
    if (action) el.append(h('button', { class: 't-act', onclick: () => { action.run(); close(); } }, action.label));
    if (type === 'error' || type === 'warn') el.append(h('button', { class: 'ibtn', 'aria-label': 'Dismiss', onclick: close }, icon('close')));
    root.append(el);
    while (root.children.length > 5) root.firstChild.remove();
    if (ms) setTimeout(close, ms);
    return { el, close, update: (m) => { text.textContent = m; } };
  };
}

export function modal(title, body, { onClose, width } = {}) {
  const back = h('div', { class: 'modal-back' });
  const close = () => { back.remove(); document.removeEventListener('keydown', onKey, true); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title, style: width ? { width: `min(${width}px, 100%)` } : null },
    h('div', { class: 'modal-h' }, h('h3', {}, title), h('button', { class: 'ibtn', 'aria-label': 'Close', onclick: close }, icon('close'))),
    h('div', { class: 'modal-b' }, body));
  back.append(box);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(back);
  setTimeout(() => box.querySelector('input, select, button:not(.ibtn)')?.focus(), 30);
  return { close, el: box };
}

// In-page confirm (the artifact viewer blocks window.confirm)
export function confirmDialog(title, message, okLabel = 'OK', danger = false) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const body = h('div', { class: 'sec' }, h('p', { style: { margin: '4px 0 14px', color: 'var(--muted)', lineHeight: '1.5' } }, message),
      h('div', { class: 'btns', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'btn ghost', onclick: () => finish(false) }, 'Cancel'),
        h('button', { class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => finish(true) }, okLabel)));
    const m = modal(title, body, { width: 420, onClose: () => { if (!done) { done = true; resolve(false); } } });
  });
}

export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    let done = false;
    const input = h('input', { class: 'inp', type: 'text', value, style: { width: '100%' } });
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value.trim()); });
    const body = h('div', { class: 'sec' }, h('div', { class: 'hint', style: { marginBottom: '6px' } }, label), input,
      h('div', { class: 'btns', style: { justifyContent: 'flex-end' } }, h('button', { class: 'btn ghost', onclick: () => finish(null) }, 'Cancel'), h('button', { class: 'btn primary', onclick: () => finish(input.value.trim()) }, 'OK')));
    const m = modal(title, body, { width: 400, onClose: () => { if (!done) { done = true; resolve(null); } } });
    setTimeout(() => { input.focus(); input.select(); }, 40);
  });
}

let openDD = null;
export function closeDropdown() {
  if (openDD) { openDD.el.remove(); openDD.anchor?.setAttribute('aria-expanded', 'false'); openDD = null; }
}

// items: [{label, icon, kbd, action, disabled, sep, header}]
export function dropdown(items, { anchor, x, y } = {}) {
  closeDropdown();
  const el = h('div', { class: 'dropdown', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { el.append(h('div', { class: 'dd-sep' })); continue; }
    if (it.header) { el.append(h('div', { class: 'dd-label' }, it.header)); continue; }
    const b = h('button', { class: 'dd-item', role: 'menuitem', disabled: it.disabled || undefined },
      it.icon ? icon(it.icon) : h('span', { class: 'ico' }), h('span', { class: 'grow' }, it.label), it.kbd ? h('span', { class: 'kbd' }, it.kbd) : null);
    b.addEventListener('click', () => { closeDropdown(); it.action?.(); });
    el.append(b);
  }
  document.body.append(el);
  let px = x, py = y;
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    px = r.left; py = r.bottom + 4;
    anchor.setAttribute('aria-expanded', 'true');
  }
  const w = el.offsetWidth, hh = el.offsetHeight;
  px = Math.max(8, Math.min(px, window.innerWidth - w - 8));
  if (py + hh > window.innerHeight - 8) py = Math.max(8, (anchor ? anchor.getBoundingClientRect().top - hh - 4 : window.innerHeight - hh - 8));
  el.style.left = px + 'px';
  el.style.top = py + 'px';
  openDD = { el, anchor };
  el.querySelector('.dd-item:not(:disabled)')?.focus({ preventScroll: true });
  el.addEventListener('keydown', (e) => {
    const list = [...el.querySelectorAll('.dd-item:not(:disabled)')];
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    if (e.key === 'Escape') { e.preventDefault(); closeDropdown(); anchor?.focus(); }
  });
  return el;
}

document.addEventListener('pointerdown', (e) => {
  if (openDD && !openDD.el.contains(e.target) && e.target !== openDD.anchor && !openDD.anchor?.contains(e.target)) closeDropdown();
}, true);
window.addEventListener('blur', closeDropdown);
window.addEventListener('resize', closeDropdown);
