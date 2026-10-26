// Virtual file system for dropped files, folders and zip archives.
// Resolves texture/resource URLs referenced by model files to blob URLs.
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js';
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
  addZip(u8, prefix = '', depth = 0) {
    let files;
    try {
      files = unzipSync(u8, { filter: (f) => !JUNK.test(f.name) && !f.name.endsWith('/') });
    } catch (e) {
      throw new Error('Could not read the zip archive (' + e.message + ')');
    }
    const added = [];
    for (const [name, data] of Object.entries(files)) {
      const path = prefix ? prefix + '/' + name : name;
      if (extOf(name) === 'zip' && depth < 2) {
        added.push(...this.addZip(data, path.replace(/\.zip$/i, ''), depth + 1));
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
