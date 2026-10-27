// Surface decorations for props: procedural patterns (flowers, sakura,
// scrollwork, damascus, camo, hamon...) and drawings Claude makes as SVG.
// A decoration becomes the material's color map (and, engraved, its bump map).
import * as THREE from 'three';

function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function canvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return null;
}

const col = (c) => { try { return new THREE.Color(c); } catch { return new THREE.Color('#888888'); } };
const css = (c, a = 1) => { const k = col(c); return `rgba(${Math.round(k.r * 255)},${Math.round(k.g * 255)},${Math.round(k.b * 255)},${a})`; };
const mix = (a, b, t) => '#' + col(a).lerp(col(b), t).getHexString();

// draw at (x, y) and its wrapped copies so tiles repeat seamlessly
function wrapped(g, w, h, x, y, r, fn) {
  for (const dx of [-w, 0, w]) for (const dy of [-h, 0, h]) {
    const xx = x + dx, yy = y + dy;
    if (xx + r < 0 || xx - r > w || yy + r < 0 || yy - r > h) continue;
    fn(xx, yy);
  }
}

function flower(g, x, y, r, rot, petals, petal, center, notch) {
  g.save(); g.translate(x, y); g.rotate(rot);
  g.fillStyle = petal;
  for (let i = 0; i < petals; i++) {
    g.save(); g.rotate((i / petals) * Math.PI * 2);
    g.beginPath();
    if (notch) {
      // sakura petal: rounded with a notch at the tip
      g.moveTo(0, 0);
      g.bezierCurveTo(r * 0.55, -r * 0.25, r * 0.6, -r * 0.85, r * 0.12, -r);
      g.lineTo(0, -r * 0.82);
      g.lineTo(-r * 0.12, -r);
      g.bezierCurveTo(-r * 0.6, -r * 0.85, -r * 0.55, -r * 0.25, 0, 0);
    } else g.ellipse(0, -r * 0.55, r * 0.32, r * 0.55, 0, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
  g.fillStyle = center;
  g.beginPath(); g.arc(0, 0, r * 0.2, 0, Math.PI * 2); g.fill();
  g.restore();
}

// Each pattern draws on a w×h canvas (base color already filled). u = motif
// size in pixels: tiles use a fixed fraction of the tile, bands along a part
// (mapping "fit") scale motifs to the band's height so they keep their shape.
const count = (w, h, u, per) => Math.max(1, Math.round((w * h) / (u * u) * per));
const PATTERN_DRAW = {
  flowers(g, w, h, c, r, base, u) {
    const n = count(w, h, u, 0.7);
    for (let i = 0; i < n; i++) {
      const x = r() * w, y = r() * h, s = u * (0.28 + r() * 0.24);
      const rot = r() * 6.28, petals = 5 + Math.floor(r() * 2), la = r() * 6.28;
      wrapped(g, w, h, x, y, s * 2, (xx, yy) => {
        g.fillStyle = css(c, 0.75);
        for (let k = 0; k < 2; k++) { g.save(); g.translate(xx, yy); g.rotate(la + k * 2.4); g.beginPath(); g.ellipse(s * 1.1, 0, s * 0.55, s * 0.2, 0, 0, 6.28); g.fill(); g.restore(); }
        flower(g, xx, yy, s, rot, petals, css(c), css(mix(c, '#ffffff', 0.5)), false);
      });
    }
  },
  sakura(g, w, h, c, r, base, u) {
    g.strokeStyle = css(mix(c, '#000000', 0.45), 0.8); g.lineCap = 'round';
    const nb = count(w, h, u * 2.2, 0.6);
    for (let i = 0; i < nb; i++) {
      let x = r() * w, y = r() * h, a = r() * 6.28;
      g.lineWidth = Math.max(1, u * 0.06);
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 6; k++) { a += (r() - 0.5) * 1.2; x += Math.cos(a) * u * 0.45; y += Math.sin(a) * u * 0.45; g.lineTo(x, y); }
      g.stroke();
    }
    const n = count(w, h, u, 0.9);
    for (let i = 0; i < n; i++) {
      const x = r() * w, y = r() * h, s = u * (0.2 + r() * 0.2), rot = r() * 6.28;
      wrapped(g, w, h, x, y, s, (xx, yy) => flower(g, xx, yy, s, rot, 5, css(c), css(mix(c, '#ffff66', 0.6)), true));
    }
  },
  vines(g, w, h, c, r, base, u) {
    g.strokeStyle = css(c); g.lineCap = 'round';
    const n = count(w, h, u * 1.8, 0.8);
    for (let i = 0; i < n; i++) {
      let x = r() * w, y = r() * h, a = r() * 6.28;
      g.lineWidth = Math.max(1, u * 0.05);
      g.beginPath(); g.moveTo(x, y);
      for (let k = 0; k < 14; k++) {
        a += Math.sin(k * 0.9) * 0.5; const nx = x + Math.cos(a) * u * 0.3, ny = y + Math.sin(a) * u * 0.3;
        g.quadraticCurveTo(x + Math.cos(a + 0.6) * u * 0.2, y + Math.sin(a + 0.6) * u * 0.2, nx, ny);
        if (k % 2) { g.save(); g.fillStyle = css(c, 0.9); g.translate(nx, ny); g.rotate(a + 1.2); g.beginPath(); g.ellipse(u * 0.08, 0, u * 0.09, u * 0.035, 0, 0, 6.28); g.fill(); g.restore(); }
        x = nx; y = ny;
      }
      g.stroke();
    }
  },
  scroll(g, w, h, c, r, base, u) {
    // engraved scrollwork: spirals with leafy tails
    g.strokeStyle = css(c); g.lineCap = 'round';
    const n = count(w, h, u, 1.1);
    for (let i = 0; i < n; i++) {
      const cx = r() * w, cy = r() * h, R = u * (0.3 + r() * 0.25), dir = r() < 0.5 ? 1 : -1;
      wrapped(g, w, h, cx, cy, R * 2.5, (xx, yy) => {
        g.lineWidth = Math.max(1, R * 0.1);
        g.beginPath();
        for (let t = 0; t < 14; t += 0.15) { const rr = R * (1 - t / 16), a = dir * t; const px = xx + Math.cos(a) * rr * (t / 14 + 0.2), py = yy + Math.sin(a) * rr * (t / 14 + 0.2); t === 0 ? g.moveTo(px, py) : g.lineTo(px, py); }
        g.stroke();
        g.beginPath(); g.moveTo(xx + R * 0.9, yy); g.bezierCurveTo(xx + R * 1.6, yy - R * 0.8 * dir, xx + R * 2.2, yy + R * 0.2, xx + R * 2.4, yy - R * 0.3 * dir); g.stroke();
      });
    }
  },
  damascus(g, w, h, c, r, base, u) {
    const id = g.getImageData(0, 0, w, h); const d = id.data; const k = col(c);
    const ph = r() * 10, f1 = w / (u * 4), f2 = h / (u * 0.35);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const uu = x / w, v = y / h;
      const f = Math.sin((v * f2 + Math.sin(uu * 6.28 * Math.max(1, Math.round(f1)) + ph) * 1.6 + Math.sin(uu * 6.28 * Math.max(2, Math.round(f1 * 2.3)) + v * 9) * 0.4) * Math.PI);
      const t = f > 0.55 ? 0.65 : f > 0.2 ? 0.25 : 0;
      const i = (y * w + x) * 4;
      d[i] = d[i] * (1 - t) + k.r * 255 * t; d[i + 1] = d[i + 1] * (1 - t) + k.g * 255 * t; d[i + 2] = d[i + 2] * (1 - t) + k.b * 255 * t;
    }
    g.putImageData(id, 0, 0);
  },
  camo(g, w, h, c, r, base, u) {
    const shades = [c, mix(base, '#000000', 0.45), mix(c, base, 0.5)];
    for (const sh of shades) {
      g.fillStyle = css(sh);
      const n = count(w, h, u * 1.2, 0.7);
      for (let i = 0; i < n; i++) {
        const x = r() * w, y = r() * h, s = u * (0.35 + r() * 0.4);
        const radii = Array.from({ length: 13 }, () => 0.7 + r() * 0.6);
        wrapped(g, w, h, x, y, s * 2, (xx, yy) => {
          g.beginPath();
          radii.forEach((k, j) => { const a = (j / radii.length) * 6.283; const px = xx + Math.cos(a) * s * k * 1.5, py = yy + Math.sin(a) * s * k; j ? g.lineTo(px, py) : g.moveTo(px, py); });
          g.closePath(); g.fill();
        });
      }
    }
  },
  digital(g, w, h, c, r, base, u) {
    const cell = Math.max(2, u * 0.16), nx = Math.ceil(w / cell), ny = Math.ceil(h / cell);
    const shades = [c, mix(base, '#000000', 0.4), mix(c, '#ffffff', 0.25)];
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const v = Math.sin(i * 0.7 + Math.sin(j * 0.4) * 2) + Math.sin(j * 0.9 + i * 0.3) + (r() - 0.5);
      if (v > 0.6) { g.fillStyle = css(shades[(i + j) % 3]); g.fillRect(i * cell, j * cell, cell + 0.5, cell + 0.5); }
    }
  },
  hex(g, w, h, c, r, base, u) {
    g.strokeStyle = css(c); g.lineWidth = Math.max(1, u * 0.04);
    const s = u * 0.6, hh = s * Math.sqrt(3) / 2;
    for (let row = -1; row < h / hh + 1; row++) for (let ci = -1; ci < w / (s * 1.5) + 1; ci++) {
      const x = ci * s * 1.5, y = row * hh * 2 + (ci % 2 ? hh : 0);
      g.beginPath();
      for (let k = 0; k <= 6; k++) { const a = (k / 6) * Math.PI * 2; const px = x + Math.cos(a) * s * 0.95, py = y + Math.sin(a) * s * 0.95; k ? g.lineTo(px, py) : g.moveTo(px, py); }
      g.stroke();
    }
  },
  stripes(g, w, h, c, r, base, u) {
    g.fillStyle = css(c);
    const sw = u * 1.3, n = Math.ceil((w + h) / sw) + 2;
    for (let i = -2; i < n; i++) { g.beginPath(); g.moveTo(i * sw, 0); g.lineTo(i * sw + sw * 0.45, 0); g.lineTo(i * sw + sw * 0.45 - h, h); g.lineTo(i * sw - h, h); g.fill(); }
  },
  flames(g, w, h, c, r, base, u) {
    // flames licking from the bottom edge up
    const hot = mix(c, '#ffffaa', 0.5), n = Math.max(3, Math.round(w / (u * 0.9)));
    for (const [shade, scale] of [[c, 1], [hot, 0.6]]) {
      g.fillStyle = css(shade);
      g.beginPath(); g.moveTo(0, h);
      for (let i = 0; i <= n; i++) {
        const x = (i / n) * w, peak = h * (1 - (0.55 + 0.35 * Math.sin(i * 2.1)) * scale);
        g.quadraticCurveTo(x - w / n * 0.5, h - (h - peak) * 0.3, x - w / n * 0.15, peak);
        g.quadraticCurveTo(x, h - (h - peak) * 0.6, x + w / n * 0.2, h * 0.98);
      }
      g.lineTo(w, h); g.closePath(); g.fill();
    }
  },
  stars(g, w, h, c, r, base, u) {
    g.fillStyle = css(c);
    const n = count(w, h, u, 0.8);
    for (let i = 0; i < n; i++) {
      const x = r() * w, y = r() * h, s = u * (0.15 + r() * 0.25), rot = r() * 6.28;
      wrapped(g, w, h, x, y, s, (xx, yy) => { g.beginPath(); for (let k = 0; k < 10; k++) { const a = rot + (k / 10) * Math.PI * 2, rr = k % 2 ? s * 0.42 : s; g.lineTo(xx + Math.cos(a) * rr, yy + Math.sin(a) * rr); } g.closePath(); g.fill(); });
    }
  },
  hearts(g, w, h, c, r, base, u) {
    g.fillStyle = css(c);
    const n = count(w, h, u, 0.75);
    for (let i = 0; i < n; i++) {
      const x = r() * w, y = r() * h, s = u * (0.18 + r() * 0.22), rot = (r() - 0.5) * 0.8;
      wrapped(g, w, h, x, y, s * 1.5, (xx, yy) => { g.save(); g.translate(xx, yy); g.rotate(rot); g.beginPath(); g.moveTo(0, s * 0.35); g.bezierCurveTo(-s * 1.2, -s * 0.4, -s * 0.5, -s * 1.1, 0, -s * 0.45); g.bezierCurveTo(s * 0.5, -s * 1.1, s * 1.2, -s * 0.4, 0, s * 0.35); g.fill(); g.restore(); });
    }
  },
  scales(g, w, h, c, r, base, u) {
    const s = u * 0.5;
    for (let row = 0; row < h / (s * 0.5) + 2; row++) for (let i = -1; i <= w / s + 1; i++) {
      const x = i * s + (row % 2 ? s / 2 : 0), y = row * s * 0.5;
      const grd = g.createRadialGradient(x, y - s * 0.1, s * 0.05, x, y, s * 0.6);
      grd.addColorStop(0, css(mix(c, '#ffffff', 0.3))); grd.addColorStop(1, css(mix(c, base, 0.5)));
      g.fillStyle = grd; g.beginPath(); g.arc(x, y, s * 0.55, 0, Math.PI); g.fill();
      g.strokeStyle = css(mix(c, '#000000', 0.5), 0.6); g.lineWidth = 1; g.stroke();
    }
  },
  dots(g, w, h, c, r, base, u) {
    g.fillStyle = css(c);
    const s = u * 0.6;
    for (let i = 0; i <= w / s + 1; i++) for (let j = 0; j <= h / s + 1; j++) { g.beginPath(); g.arc(i * s + (j % 2 ? s / 2 : 0), j * s, s * 0.2, 0, 6.28); g.fill(); }
  },
  // blade temper line: frosty band along the edge (v = 1, the top of the canvas, is the edge)
  hamon(g, w, h, c, r) {
    const waves = Math.max(3, Math.round(w / h * 0.9));
    const band = (x) => h * (0.34 + 0.09 * Math.sin(x / w * 6.28 * waves) + 0.05 * Math.sin(x / w * 6.28 * waves * 2.6 + 1.3));
    g.fillStyle = css(c, 0.55);
    g.beginPath(); g.moveTo(0, 0);
    for (let x = 0; x <= w; x += w / 400) g.lineTo(x, band(x));
    g.lineTo(w, 0); g.closePath(); g.fill();
    // soft mist along the boundary and sparkles (nie)
    const n = Math.round(w * h / 120);
    for (let i = 0; i < n; i++) { const x = r() * w, y = band(x) + (r() - 0.5) * h * 0.12; g.fillStyle = css(c, 0.25 + r() * 0.4); g.fillRect(x, y, 1.5, 1.5); }
    g.fillStyle = css(c, 0.3); g.fillRect(0, 0, w, h * 0.06);
  },
  // sword fuller: a dark groove along the middle
  fuller(g, w, h, c) {
    const grd = g.createLinearGradient(0, h * 0.38, 0, h * 0.62);
    grd.addColorStop(0, css(c, 0)); grd.addColorStop(0.3, css(c, 0.8)); grd.addColorStop(0.7, css(c, 0.8)); grd.addColorStop(1, css(c, 0));
    g.fillStyle = grd; g.fillRect(w * 0.03, h * 0.38, w * 0.6, h * 0.24);
  },
  // the silk wrap of a katana handle: ray-skin diamonds between crossed silk bands
  // (a tile is half the handle's girth: one diamond across, two along)
  wrap(g, w, h, c, r, base) {
    const dark = css(mix(base, '#000000', 0.55)), light = css(mix(base, '#ffffff', 0.18));
    for (const cx of [w * 0.25, w * 0.75, w * 1.25, -w * 0.25]) {
      // the silk crossing over the diamond tips, shaded
      for (const sgn of [1, -1]) {
        g.strokeStyle = light; g.lineWidth = w * 0.07;
        g.beginPath(); g.moveTo(cx - w * 0.25, h * 0.5 - sgn * h * 0.5); g.lineTo(cx + w * 0.25, h * 0.5 + sgn * h * 0.5); g.stroke();
        g.strokeStyle = dark; g.lineWidth = w * 0.012;
        g.beginPath(); g.moveTo(cx - w * 0.25 + w * 0.035, h * 0.5 - sgn * h * 0.5); g.lineTo(cx + w * 0.25 + w * 0.035, h * 0.5 + sgn * h * 0.5); g.stroke();
      }
      // diamond of ray skin with a dark rim
      g.fillStyle = css(c);
      g.beginPath(); g.moveTo(cx, h * 0.5 - h * 0.3); g.lineTo(cx + w * 0.13, h * 0.5); g.lineTo(cx, h * 0.5 + h * 0.3); g.lineTo(cx - w * 0.13, h * 0.5); g.closePath(); g.fill();
      g.strokeStyle = dark; g.lineWidth = w * 0.012; g.stroke();
      // ray-skin nodules
      g.fillStyle = css(mix(c, '#ffffff', 0.5));
      for (let k = 0; k < 40; k++) { const a = r() * 6.28, d = Math.sqrt(r()) * 0.8; const x = cx + Math.cos(a) * w * 0.13 * d * 0.5, y = h * 0.5 + Math.sin(a) * h * 0.3 * d * 0.5; g.beginPath(); g.arc(x, y, w * 0.006, 0, 6.28); g.fill(); }
    }
  },
};
export const PATTERN_NAMES = ['none', ...Object.keys(PATTERN_DRAW), 'svg'];
// patterns that are drawn along a part rather than tiled
const FIT_DEFAULT = new Set(['hamon', 'fuller', 'flames']);
export function defaultMapping(pattern) { return String(pattern || '').split('+').some((p) => FIT_DEFAULT.has(p.trim())) ? 'fit' : 'tile'; }
// meters one tile covers (mapping "tile")
const TILE_M = { camo: 0.35, digital: 0.25, damascus: 0.12, stripes: 0.12, hex: 0.05, scales: 0.05, dots: 0.04, wrap: 0.048, svg: 0.12 };
export const tileMeters = (pattern) => TILE_M[pattern] || 0.1;

// "hamon:#ffffff+flowers" -> layers [{name: 'hamon', color: '#ffffff'}, {name: 'flowers', color: null}]
export function patternLayers(p) {
  return String(p || '').split(/[+,\s]+/).map((x) => {
    const [name, color] = x.trim().split(':');
    return { name: (name || '').toLowerCase(), color: color && /^#?[0-9a-f]{3,8}$|^[a-z]+$/i.test(color) ? (/^[0-9a-f]{3,8}$/i.test(color) ? '#' + color : color) : null };
  }).filter((l) => PATTERN_DRAW[l.name]).slice(0, 4);
}
export function patternList(p) { return patternLayers(p).map((l) => l.name); }

// a readable engraving color for a base color
export function contrastColor(base) {
  const c = col(base || '#888888');
  const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  return '#' + (l > 0.35 ? c.clone().lerp(new THREE.Color('#000000'), 0.55) : c.clone().lerp(new THREE.Color('#ffffff'), 0.6)).getHexString();
}

// "fit" (one band stretched along a part) or "tile" (repeats at a fixed size)
export function resolveMapping(d) {
  if (!d) return null;
  if (d.mapping === 'fit' || d.mapping === 'tile') return d.mapping;
  const list = patternList(d.pattern);
  const hasSvg = !!(d.svg && String(d.svg).includes('<svg'));
  if (!hasSvg && !list.length) return null;
  return hasSvg && !list.length ? 'fit' : defaultMapping(list.join('+'));
}

let listener = null;
export function onDecorationReady(fn) { listener = fn; }

const cache = new Map();
// spec: {color, pattern ("flowers", "hamon+flowers"), patternColor, mapping "tile"|"fit", svg, aspect}
// -> { texture, fit, tile } or null. aspect = length/width of the part a fit band covers.
// A fit band is a two-sided atlas: the left half is the part's front, the right half its
// back. Patterns are mirrored onto the back so features line up through the part (a fuller,
// a temper line); drawings are copied unmirrored so they read the right way round on both sides.
export function decorationTexture(spec) {
  const hasSvg = !!(spec.svg && String(spec.svg).includes('<svg'));
  const list = patternList(spec.pattern);
  if (!hasSvg && !list.length) return null;
  const base = spec.color || '#888888';
  const pc = spec.patternColor || contrastColor(base);
  const fit = resolveMapping(spec) === 'fit';
  const aspect = fit ? THREE.MathUtils.clamp(Number(spec.aspect) || 8, 0.05, 64) : 1;
  const svgKey = hasSvg ? String(spec.svg).length + ':' + hash(String(spec.svg)) : '';
  const layers = patternLayers(spec.pattern);
  const key = [String(spec.pattern || ''), base, pc, fit, fit ? aspect.toFixed(2) : '', svgKey].join('|');
  if (cache.has(key)) return cache.get(key);
  let w = 512, h = 512;
  if (fit) {
    if (aspect >= 1) { w = 1024; h = Math.max(32, Math.round(1024 / aspect)); }
    else { h = 1024; w = Math.max(32, Math.round(1024 * aspect)); }
  } else if (hasSvg) { w = h = 1024; }
  const cv = canvas(fit ? w * 2 : w, h);
  const g = cv && cv.getContext('2d');
  if (!g) { cache.set(key, null); return null; }
  // patterns on one face
  const face = fit ? canvas(w, h) : cv;
  const fg = face.getContext('2d');
  fg.fillStyle = css(base); fg.fillRect(0, 0, w, h);
  // motif size: a fifth of a tile, or most of a band's height
  const unit = fit ? Math.min(w, h) * 0.72 : w / 5;
  const rand = rng(hash(key));
  for (const l of layers) PATTERN_DRAW[l.name](fg, w, h, l.color || pc, rand, base, unit);
  if (fit) {
    g.drawImage(face, 0, 0);
    g.save(); g.translate(w * 2, 0); g.scale(-1, 1); g.drawImage(face, 0, 0); g.restore();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.wrapS = tex.wrapT = fit ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
  tex.name = 'decoration-' + (list.join('+') || 'drawing');
  if (hasSvg) drawSVG(g, fit ? [[0, 0, w, h], [w, 0, w, h]] : [[0, 0, w, h]], spec.svg, tex);
  tex.needsUpdate = true;
  const out = { texture: tex, fit, tile: tileMeters(hasSvg && !list.length ? 'svg' : list[list.length - 1]) };
  cache.set(key, out);
  return out;
}

function hash(s) { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return x >>> 0; }

function svgAspect(svg) {
  const m = /viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(svg);
  if (m && +m[1] > 0 && +m[2] > 0) return { w: +m[1], h: +m[2] };
  const wm = /\bwidth\s*=\s*["']([\d.]+)/i.exec(svg), hm = /\bheight\s*=\s*["']([\d.]+)/i.exec(svg);
  if (wm && hm && +wm[1] > 0 && +hm[1] > 0) return { w: +wm[1], h: +hm[1] };
  return null;
}

// Claude's drawing -> canvas (scripts, event handlers and outside links stripped)
export function cleanSVG(svg) {
  let s = String(svg || '').slice(0, 120000);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<foreignObject[\s\S]*?<\/foreignObject>/gi, '');
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  s = s.replace(/(href\s*=\s*["'])(?!#)[^"']*(["'])/gi, '$1#$2');
  if (!/xmlns=/.test(s)) s = s.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  // give the image a real size so it keeps its proportions when drawn
  const tag = (/<svg\b[^>]*>/i.exec(s) || [''])[0];
  if (tag && !/\swidth\s*=/.test(tag)) {
    const a = svgAspect(tag);
    if (a) { const k = 1024 / Math.max(a.w, a.h); s = s.replace(/<svg\b/i, `<svg width="${Math.round(a.w * k)}" height="${Math.round(a.h * k)}"`); }
  }
  return s;
}

function drawSVG(g, rects, svg, tex) {
  if (typeof Image === 'undefined' || typeof Blob === 'undefined') return;
  const src = cleanSVG(svg);
  const url = URL.createObjectURL(new Blob([src], { type: 'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    try {
      // keep the drawing's proportions, centered in each face
      for (const [x, y, w, h] of rects) {
        const iw = img.naturalWidth || img.width || w, ih = img.naturalHeight || img.height || h;
        const k = Math.min(w / iw, h / ih);
        g.drawImage(img, x + (w - iw * k) / 2, y + (h - ih * k) / 2, iw * k, ih * k);
      }
      tex.needsUpdate = true; listener?.(tex);
    } catch (e) { console.warn('drawing', e); }
    URL.revokeObjectURL(url);
  };
  img.onerror = () => { console.warn('Could not read the SVG drawing'); URL.revokeObjectURL(url); };
  img.src = url;
}

// words -> pattern ("a katana with a gold flower pattern")
const PATTERN_WORDS = [
  ['sakura', /\b(sakura|cherry blossoms?)\b/], ['flowers', /\b(flowe?r+s?|floral|flowery|flowr+s?|roses?|blossoms?|petals?|daisy|daisies|lotus|lil(y|ies))\b/], ['scroll', /\b(scroll ?work|scrolls?|engrav(ed|ing|ings)|filigree|baroque)\b/],
  ['vines', /\b(vines?|ivy|leaves|leafy)\b/], ['damascus', /\b(damascus|damask|folded steel|wavy steel)\b/], ['digital', /\b(digital camo|pixel camo|marpat)\b/],
  ['camo', /\b(camo|camouflage|woodland)\b/], ['hex', /\b(hex|hexagons?|honeycomb)\b/], ['stripes', /\b(stripes?|striped|racing stripes?)\b/], ['flames', /\b(flames?|fire|flaming)\b/],
  ['stars', /\b(stars?|starry)\b/], ['hearts', /\b(hearts?)\b/], ['scales', /\b(scales|scaly|dragon ?scales?)\b/], ['dots', /\b(dots|polka|spots|spotted)\b/],
];
export function findPatternIn(text) {
  const t = String(text || '').toLowerCase();
  for (const [k, re] of PATTERN_WORDS) if (re.test(t)) return k;
  return null;
}

export const COLOR_WORDS = {
  gold: '#e9c25a', golden: '#e9c25a', silver: '#c9ccd1', chrome: '#d9dce0', pink: '#ff86b8', red: '#c8102e', crimson: '#9e1b32', blue: '#2a5bd7',
  navy: '#1b2a5c', white: '#f2f2f2', black: '#141414', green: '#2e8b57', purple: '#7b3fbf', violet: '#8f5bd6', orange: '#ff8c1a', yellow: '#ffd23f',
  cyan: '#2fd6e6', teal: '#178a8a', copper: '#b87333', bronze: '#a97142', brass: '#c8a050', rose: '#e8768f', lavender: '#b9a2e8', brown: '#7a4a2a',
};
const COLOR_RE = new RegExp(`\\b(${Object.keys(COLOR_WORDS).join('|')})\\b`);

// "a katana with a gold flower pattern" -> {pattern: 'flowers', patternColor: '#d4af37', colorPhrase: 'gold', engrave}
// The color right before (or "in <color>" right after) the pattern word colors the pattern;
// colorPhrase is cut out of the text so it isn't read as the whole model's color.
export function findDecorationIn(text) {
  const t = String(text || '').toLowerCase();
  let hit = null;
  for (const [k, re] of PATTERN_WORDS) { const m = re.exec(t); if (m && (!hit || m.index < hit.index)) hit = { pattern: k, index: m.index, word: m[0] }; }
  const engrave = /\b(engrav(e|ed|ing|ings)|etch(ed|ing|ings)?|carv(e|ed|ing|ings)|emboss(ed)?|inlaid|inlay)\b/.test(t);
  if (!hit) return engrave ? { pattern: 'scroll', patternColor: null, colorPhrase: null, engrave } : null;
  const before = t.slice(Math.max(0, hit.index - 28), hit.index);
  const after = t.slice(hit.index + hit.word.length, hit.index + hit.word.length + 30);
  let colorPhrase = null, color = null;
  const mb = new RegExp(`\\b(${Object.keys(COLOR_WORDS).join('|')})(?:[\\s-]+(?:colou?red|metal|metallic|leaf|plated))?[\\s-]+(?:[a-z]+[\\s-]+)?$`).exec(before);
  const ma = /^\s*(?:pattern|patterns|design|designs|motifs?|print|drawings?)?\s*(?:in|of)\s+([a-z]+)\b/.exec(after);
  if (mb) { color = mb[1]; colorPhrase = mb[0].trim(); }
  else if (ma && COLOR_WORDS[ma[1]]) { color = ma[1]; colorPhrase = ma[0].trim(); }
  return { pattern: hit.pattern, patternColor: color ? COLOR_WORDS[color] : null, colorPhrase, colorWord: color, engrave };
}
export { COLOR_RE };
