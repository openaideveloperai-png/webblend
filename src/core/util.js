// Small shared helpers.

export class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) {
    if (!this._h.has(ev)) this._h.set(ev, new Set());
    this._h.get(ev).add(fn);
    return () => this.off(ev, fn);
  }
  off(ev, fn) { this._h.get(ev)?.delete(fn); }
  emit(ev, ...args) {
    const s = this._h.get(ev);
    if (!s) return;
    for (const fn of [...s]) {
      try { fn(...args); } catch (e) { console.error(`[${ev}]`, e); }
    }
  }
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const uid = (() => { let n = 0; return (p = 'id') => `${p}${(++n).toString(36)}${Math.random().toString(36).slice(2, 6)}`; })();

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function rafThrottle(fn) {
  let pending = false, lastArgs;
  return (...a) => {
    lastArgs = a;
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; fn(...lastArgs); });
  };
}

export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function fmtBytes(n) {
  if (!isFinite(n)) return '-';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function fmtTime(t, fps) {
  const f = Math.round(t * fps);
  const s = Math.floor(t);
  const ff = Math.round((t - s) * fps);
  return { frame: f, label: `${String(s).padStart(2, '0')}:${String(Math.min(ff, fps - 1)).padStart(2, '0')}` };
}

export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

export function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

export function stripExt(n) {
  return String(n || '').replace(/\.[^.]+$/, '');
}

// localStorage wrappers that never throw
export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  del(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } },
};

export const session = {
  get(key, fallback) {
    try { const v = sessionStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) { try { sessionStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ } },
  del(key) { try { sessionStorage.removeItem(key); } catch { /* ignore */ } },
};

// Are we inside the claude.ai artifact viewer?
export const inArtifact = () => typeof window !== 'undefined' && !!window.claude && typeof window.claude.use === 'function';

export function isTextInput(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
}

// Safe arithmetic for number fields: "1.5*2", "-(3+4)/2" (no eval)
export function evalExpr(str) {
  const s = String(str).replace(/\s+/g, '').replace(/,/g, '.');
  let i = 0;
  const peek = () => s[i];
  const num = () => {
    const m = /^(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i.exec(s.slice(i));
    if (!m) throw new Error('bad');
    i += m[0].length;
    return parseFloat(m[0]);
  };
  const factor = () => {
    if (peek() === '-') { i++; return -factor(); }
    if (peek() === '+') { i++; return factor(); }
    if (peek() === '(') { i++; const v = expr(); if (s[i++] !== ')') throw new Error('bad'); return v; }
    return num();
  };
  const term = () => { let v = factor(); while (peek() === '*' || peek() === '/') { const op = s[i++]; const r = factor(); v = op === '*' ? v * r : v / r; } return v; };
  const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') { const op = s[i++]; const r = term(); v = op === '+' ? v + r : v - r; } return v; };
  const v = expr();
  if (i !== s.length) throw new Error('bad');
  return v;
}
