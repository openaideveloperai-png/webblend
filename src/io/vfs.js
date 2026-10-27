// Virtual file system for dropped files, folders and zip archives.
// Resolves texture/resource URLs referenced by model files to blob URLs.
import { unzipSync, gunzipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { extOf, baseName } from '../core/util.js';

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  svg: 'image/svg+xml', avif: 'image/avif', ktx2: 'image/ktx2', tga: 'image/x-tga', dds: 'image/vnd-ms.dds',
  gltf: 'model/gltf+json', glb: 'model/gltf-binary', bin: 'application/octet-stream', json: 'application/json',
};

export function normPath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  try { s = decodeURIComponent(s); } catch { /* keep */ }
  s = s.replace(/^[a-z]+:\/\/[^/]*\//i, ''); // strip scheme+host (blob:, file://...)
  s = s.replace(/^[a-z]:\//i, ''); // windows drive
  s = s.replace(/^\/+/, '').replace(/\/\.\//g, '/').replace(/^\.\//, '');
  // resolve ".."
  const parts = [];
  for (const seg of s.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/').toLowerCase();
}

const JUNK = /(^|\/)(__macosx\/|\.ds_store$|thumbs\.db$|desktop\.ini$|\._)/i;

// containers that are zip files inside: Java / Android / Minecraft packs, game paks, plugins
export const ZIP_EXTS = new Set(['zip', 'jar', 'mcpack', 'mcaddon', 'mctemplate', 'mcworld', 'apk', 'aar', 'war', 'ear', 'pk3', 'pk4', 'ipa', 'xpi', 'nupkg', 'vsix', 'kra', 'sb3']);
export const TAR_EXTS = new Set(['tar', 'tgz', 'unitypackage']);
export function archiveKind(name) {
  const n = String(name || '').toLowerCase();
  if (n.endsWith('.tar.gz')) return 'tar';
  const e = extOf(n);
  return ZIP_EXTS.has(e) ? 'zip' : TAR_EXTS.has(e) ? 'tar' : null;
}
const stripArchive = (p) => p.replace(/\.(tar\.gz|[a-z0-9]+)$/i, '');

// a (possibly gzipped) tar -> {name: Uint8Array}
function untar(u8) {
  if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = gunzipSync(u8);
  const out = {};
  const str = (a, b) => { let s = ''; for (let i = a; i < b && u8[i]; i++) s += String.fromCharCode(u8[i]); return s; };
  let off = 0, longName = null;
  while (off + 512 <= u8.length) {
    const name = str(off, off + 100);
    if (!name) break;
    const size = parseInt(str(off + 124, off + 136).trim() || '0', 8) || 0;
    const type = String.fromCharCode(u8[off + 156] || 48);
    const prefix = str(off + 345, off + 500);
    const data = u8.subarray(off + 512, off + 512 + size);
    if (type === 'L') longName = new TextDecoder().decode(data).replace(/\0+$/, '');
    else {
      const full = longName || (prefix ? prefix + '/' + name : name);
      longName = null;
      if (type === '0' || type === '\0' || type === '7') out[full] = data;
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

// Unity packages: <guid>/asset + <guid>/pathname -> the asset at its project path
function unityPackage(files) {
  const by = new Map();
  for (const [name, data] of Object.entries(files)) {
    const m = /^(?:\.\/)?([^/]+)\/(asset|pathname)$/.exec(name);
    if (!m) continue;
    if (!by.has(m[1])) by.set(m[1], {});
    by.get(m[1])[m[2]] = data;
  }
  const out = {};
  for (const { asset, pathname } of by.values()) {
    if (!asset || !pathname) continue;
    const p = new TextDecoder().decode(pathname).split('\n')[0].trim();
    if (p) out[p] = asset;
  }
  return Object.keys(out).length ? out : files;
}

export class VFS {
  constructor() {
    this.files = new Map(); // normPath -> entry {path, name, blob, size}
    this.byBase = new Map(); // basename -> [entries]
    this.urls = new Map(); // normPath -> blob url
    this.allUrls = new Set();
  }

  add(path, blob) {
    if (JUNK.test(path)) return null;
    const key = normPath(path);
    const name = baseName(path);
    const entry = { path, key, name, blob, size: blob.size, ext: extOf(name) };
    this.files.set(key, entry);
    const b = name.toLowerCase();
    if (!this.byBase.has(b)) this.byBase.set(b, []);
    this.byBase.get(b).push(entry);
    return entry;
  }

  // Extract a zip (Uint8Array). Nested zips are expanded too.
  addZip(u8, prefix = '', depth = 0) { return this.addArchive(u8, prefix, 'zip', depth); }

  // Extract any archive: zip-based (.zip, .jar, .mcpack, .apk...), tar / .tgz / .unitypackage.
  // Nested archives (a jar inside a jar, as Fabric mods bundle them) open too; hidden
  // folders are kept.
  addArchive(u8, prefix = '', kind = 'zip', depth = 0) {
    let files;
    try {
      files = kind === 'tar' ? unityPackage(untar(u8)) : unzipSync(u8, { filter: (f) => !JUNK.test(f.name) && !f.name.endsWith('/') });
    } catch (e) {
      throw new Error(`Could not read the ${kind === 'tar' ? 'archive' : 'zip archive'} (${e.message})`);
    }
    const added = [];
    for (const [name, data] of Object.entries(files)) {
      if (JUNK.test(name) || name.endsWith('/')) continue;
      const path = prefix ? prefix + '/' + name : name;
      const inner = archiveKind(name);
      if (inner && depth < 3) {
        try { added.push(...this.addArchive(data, stripArchive(path), inner, depth + 1)); } catch { /* not really an archive: keep as a file */ this.add(path, new Blob([data])); }
        continue;
      }
      const e = this.add(path, new Blob([data], { type: MIME[extOf(name)] || '' }));
      if (e) added.push(e);
    }
    return added;
  }

  get(path) { return this.files.get(normPath(path)) || null; }

  // Find a file referenced as `url` from a file at `fromPath`.
  find(url, fromPath = '') {
    if (!url) return null;
    const u = String(url);
    if (/^data:/i.test(u)) return null;
    const n = normPath(u);
    if (this.files.has(n)) return this.files.get(n);
    if (fromPath) {
      const dir = normPath(fromPath).split('/').slice(0, -1).join('/');
      const rel = normPath((dir ? dir + '/' : '') + u.replace(/\\/g, '/'));
      if (this.files.has(rel)) return this.files.get(rel);
    }
    // match by path suffix (textures/wood.png inside some other folder)
    const segs = n.split('/');
    for (let k = Math.min(segs.length, 4); k >= 2; k--) {
      const tail = segs.slice(-k).join('/');
      for (const [key, e] of this.files) if (key.endsWith('/' + tail) || key === tail) return e;
    }
    const base = segs[segs.length - 1];
    const list = this.byBase.get(base);
    if (list && list.length) return list[0];
    // same name, different image extension (tex.tga referenced, tex.png shipped)
    const stem = base.replace(/\.[^.]+$/, '');
    if (/\.(png|jpe?g|tga|tif|tiff|bmp|dds|psd|exr|webp|gif)$/i.test(base)) {
      for (const ext of ['png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'gif', 'dds']) {
        const l2 = this.byBase.get(stem + '.' + ext);
        if (l2 && l2.length) return l2[0];
      }
    }
    return null;
  }

  urlFor(entry) {
    if (!entry) return null;
    let u = this.urls.get(entry.key);
    if (!u) {
      u = URL.createObjectURL(entry.blob);
      // keep extension visible to three's loaders (they sniff by extension)
      this.urls.set(entry.key, u);
      this.allUrls.add(u);
    }
    return u;
  }

  list() { return [...this.files.values()]; }

  revokeAll() {
    for (const u of this.allUrls) URL.revokeObjectURL(u);
    this.allUrls.clear();
    this.urls.clear();
  }
}

// Read DataTransfer items, recursing into folders (Chrome/Edge/Firefox/Safari).
export async function filesFromDataTransfer(dt) {
  const out = [];
  const items = dt.items ? [...dt.items] : [];
  const entries = items.map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
  if (entries.some(Boolean)) {
    const walk = async (entry, prefix) => {
      if (!entry) return;
      if (entry.isFile) {
        const file = await new Promise((res, rej) => entry.file(res, rej)).catch(() => null);
        if (file) out.push({ path: prefix + file.name, file });
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const readBatch = () => new Promise((res) => reader.readEntries(res, () => res([])));
        let batch;
        do {
          batch = await readBatch();
          for (const e of batch) await walk(e, prefix + entry.name + '/');
        } while (batch.length);
      }
    };
    for (const e of entries) await walk(e, '');
    // items not exposing entries (rare)
    if (!out.length && dt.files) for (const f of dt.files) out.push({ path: f.name, file: f });
    return out;
  }
  for (const f of dt.files || []) out.push({ path: f.webkitRelativePath || f.name, file: f });
  return out;
}
