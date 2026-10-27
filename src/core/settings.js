// Persisted user settings + quality presets.
import { store, session } from './util.js';

const KEY = 'animator.settings.v1';

export const QUALITY_LEVELS = ['potato', 'low', 'medium', 'high', 'ultra'];

export const QUALITY_PRESETS = {
  ultra: { label: 'Ultra', renderScale: 1, maxPixelRatio: 2, antialias: true, shadows: true, shadowSize: 2048, env: true, maxTexture: 4096, fpsCap: 0, softShadows: true },
  high: { label: 'High', renderScale: 1, maxPixelRatio: 1.5, antialias: true, shadows: true, shadowSize: 1024, env: true, maxTexture: 2048, fpsCap: 0, softShadows: true },
  medium: { label: 'Medium', renderScale: 1, maxPixelRatio: 1, antialias: true, shadows: true, shadowSize: 1024, env: true, maxTexture: 2048, fpsCap: 60, softShadows: false },
  low: { label: 'Low', renderScale: 0.8, maxPixelRatio: 1, antialias: false, shadows: false, shadowSize: 512, env: false, maxTexture: 1024, fpsCap: 60, softShadows: false },
  potato: { label: 'Potato', renderScale: 0.55, maxPixelRatio: 1, antialias: false, shadows: false, shadowSize: 256, env: false, maxTexture: 512, fpsCap: 30, softShadows: false },
};

export const DEFAULTS = {
  quality: null, // null = detect on first run
  autoQuality: true,
  showGrid: true,
  showSkeleton: true,
  showAllBones: false,
  jointSize: 'auto', // auto | small | medium | large
  flySpeed: 1,
  showStats: false,
  showAxes: true,
  fps: 30,
  snap: true,
  autoKey: false,
  ikChain: 2,
  importLights: false,
  aiProvider: 'auto', // auto | claude-ai | api | offline
  aiModel: 'claude-opus-5-5',
  aiEffort: 'auto',
  rememberKey: false,
  bgColor: '#2a2f38',
  pickMode: 'object', // object | model
  textureLimitOverride: 0, // 0 = use quality preset
  undoLimit: 80,
  aiAlwaysClaude: false,
  aiWebSearch: true,
  aiReview: true,
  autoRotate: false,
  showEffects: true,
  exportPlatform: 'roblox',
  demoScene: true,
};

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS, ...store.get(KEY, {}) };
    this.apiKey = this.values.rememberKey ? store.get(KEY + '.key', '') : session.get(KEY + '.key', '');
  }
  get(k) { return this.values[k]; }
  set(k, v) {
    this.values[k] = v;
    store.set(KEY, this.values);
  }
  setApiKey(key, remember) {
    this.apiKey = key || '';
    this.set('rememberKey', !!remember);
    if (remember) { store.set(KEY + '.key', this.apiKey); session.del(KEY + '.key'); }
    else { session.set(KEY + '.key', this.apiKey); store.del(KEY + '.key'); }
  }
  preset() {
    return QUALITY_PRESETS[this.values.quality] || QUALITY_PRESETS.medium;
  }
  maxTexture() {
    return this.values.textureLimitOverride || this.preset().maxTexture;
  }
}

// Guess a sensible starting quality from the device.
export function detectQuality(gl) {
  const mem = navigator.deviceMemory || 8;
  const cores = navigator.hardwareConcurrency || 4;
  let gpu = '';
  try {
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
  } catch { /* ignore */ }
  const g = gpu.toLowerCase();
  const software = /swiftshader|llvmpipe|software|basic render|microsoft basic/.test(g);
  const weakGpu = /intel\(r\) hd graphics( [2-5]\d{2,3})?\b|intel hd|gma|mali-4|adreno \(tm\) [2-4]\d\d|powervr/.test(g);
  const mobile = matchMedia('(pointer: coarse)').matches;
  let q = 'high';
  if (software || mem <= 2) q = 'potato';
  else if (mem <= 4 || cores <= 2 || weakGpu) q = 'low';
  else if (mobile || mem <= 6) q = 'medium';
  return { quality: q, gpu, mem, cores, software };
}

// Watches frame times while the viewport renders continuously, and steps the
// quality down when the browser can't keep up.
export class PerfMonitor {
  constructor(onLag) {
    this.onLag = onLag;
    this.samples = [];
    this.windowStart = 0;
    this.badWindows = 0;
    this.fps = 0;
    this.cooldownUntil = 0;
  }
  frame(now, dtMs, active) {
    if (!active) { this.samples.length = 0; this.windowStart = now; return; }
    // ignore huge gaps (tab switch, breakpoint)
    if (dtMs > 1000) { this.samples.length = 0; this.windowStart = now; return; }
    this.samples.push(dtMs);
    if (now - this.windowStart < 2000) return;
    const n = this.samples.length;
    const total = this.samples.reduce((a, b) => a + b, 0);
    this.fps = n ? 1000 / (total / n) : 0;
    this.samples.length = 0;
    this.windowStart = now;
    if (now < this.cooldownUntil) return;
    if (this.fps > 0 && this.fps < 22) this.badWindows++;
    else this.badWindows = Math.max(0, this.badWindows - 1);
    if (this.badWindows >= 2) {
      this.badWindows = 0;
      this.cooldownUntil = now + 6000;
      this.onLag(this.fps);
    }
  }
}
