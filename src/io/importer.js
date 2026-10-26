// Format dispatch: turns dropped files into three.js objects + animation clips.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { MTLLoader } from 'three/examples/jsm/loaders/MTLLoader.js';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { ThreeMFLoader } from 'three/examples/jsm/loaders/3MFLoader.js';
import { AMFLoader } from 'three/examples/jsm/loaders/AMFLoader.js';
import { TDSLoader } from 'three/examples/jsm/loaders/TDSLoader.js';
import { VRMLLoader } from 'three/examples/jsm/loaders/VRMLLoader.js';
import { VOXLoader, buildMesh as buildVoxMesh } from 'three/examples/jsm/loaders/VOXLoader.js';
import { USDLoader } from 'three/examples/jsm/loaders/USDLoader.js';
import { LWOLoader } from 'three/examples/jsm/loaders/LWOLoader.js';
import { KMZLoader } from 'three/examples/jsm/loaders/KMZLoader.js';
import { PCDLoader } from 'three/examples/jsm/loaders/PCDLoader.js';
import { XYZLoader } from 'three/examples/jsm/loaders/XYZLoader.js';
import { VTKLoader } from 'three/examples/jsm/loaders/VTKLoader.js';
import { BVHLoader } from 'three/examples/jsm/loaders/BVHLoader.js';
import { MD2Loader } from 'three/examples/jsm/loaders/MD2Loader.js';
import { GCodeLoader } from 'three/examples/jsm/loaders/GCodeLoader.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { importBlend } from './blend/blendimport.js';
import { createDracoLoader } from './draco.js';
import { VFS } from './vfs.js';
import { optimizeTextures, textureFromBlob, sniffImageType } from './textures.js';
import { extOf, stripExt, baseName } from '../core/util.js';

export const MODEL_EXTS = new Set(['glb', 'gltf', 'fbx', 'obj', 'dae', 'stl', 'ply', '3mf', 'amf', '3ds', 'wrl', 'vrml', 'vox', 'usdz', 'usda', 'usdc', 'usd', 'lwo', 'kmz', 'pcd', 'xyz', 'vtk', 'vtp', 'bvh', 'md2', 'gcode', 'drc', 'svg', 'blend', 'json', 'vrm']);
export const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tga', 'avif']);
export const ACCEPT = [...MODEL_EXTS, ...IMAGE_EXTS, 'zip', 'mtl', 'bin'].map((e) => '.' + e).join(',');

const UNSUPPORTED = {
  max: '3ds Max scene files', ma: 'Maya ASCII files', mb: 'Maya binary files', c4d: 'Cinema 4D files', skp: 'SketchUp files',
  '3dm': 'Rhino files', step: 'STEP CAD files', stp: 'STEP CAD files', iges: 'IGES CAD files', igs: 'IGES CAD files', ifc: 'IFC BIM files',
  x: 'DirectX .x files', lxo: 'Modo files', ztl: 'ZBrush files', spp: 'Substance files', hip: 'Houdini files', mmd: 'MMD files', pmx: 'MMD (PMX) files', pmd: 'MMD (PMD) files',
  rar: 'RAR archives', '7z': '7-Zip archives',
};

export function unsupportedMessage(ext) {
  const what = UNSUPPORTED[ext];
  if (!what) return null;
  if (ext === 'rar' || ext === '7z') return `${what} can't be opened in the browser. Re-pack the folder as a .zip and drop it again.`;
  return `${what} can't be read in a browser. Export from that app as .glb/.gltf or .fbx (with "embed textures" on if available) and drop that instead.`;
}

const GREY_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQImWNo6Ojo/w8ABFIB/ZpNwGQAAAAASUVORK5CYII=';

function makeManager(vfs, basePath, missing) {
  const manager = new THREE.LoadingManager();
  let pending = 0;
  const waiters = [];
  const origStart = manager.itemStart.bind(manager);
  const origEnd = manager.itemEnd.bind(manager);
  const origErr = manager.itemError.bind(manager);
  const settle = () => { if (pending <= 0) { pending = 0; waiters.splice(0).forEach((w) => w()); } };
  manager.itemStart = (u) => { pending++; origStart(u); };
  manager.itemEnd = (u) => { pending--; origEnd(u); settle(); };
  manager.itemError = (u) => { origErr(u); };
  manager.waitIdle = (ms = 30000) => new Promise((res) => {
    if (pending <= 0) return res();
    waiters.push(res);
    setTimeout(res, ms);
  });
  manager.setURLModifier((url) => {
    if (/^(data|blob):/i.test(url)) return url;
    const e = vfs.find(url, basePath);
    if (e) return vfs.urlFor(e);
    if (/\.(png|jpe?g|tga|bmp|gif|webp|dds|tif|tiff|psd|exr|hdr|avif)(\?|$)/i.test(url)) {
      missing.add(baseName(url));
      return GREY_PIXEL;
    }
    return url;
  });
  manager.addHandler(/\.tga$/i, new TGALoader(manager));
  manager.addHandler(/\.dds$/i, new DDSLoader(manager));
  return manager;
}

let ktx2Loader = null;
function getKTX2(renderer) {
  if (!ktx2Loader) {
    ktx2Loader = new KTX2Loader();
    ktx2Loader.setTranscoderPath('https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/basis/');
    try { ktx2Loader.detectSupport(renderer); } catch { /* ignore */ }
  }
  return ktx2Loader;
}

let dracoLoader = null;
function getDraco() {
  if (!dracoLoader) dracoLoader = createDracoLoader();
  return dracoLoader;
}

const readText = (blob) => blob.text();
const readBuf = (blob) => blob.arrayBuffer();

function stdMaterial(color = 0xb8bec8) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.05 });
}

function hasMesh(root) {
  let found = false;
  root.traverse((o) => { if (o.isMesh || o.isPoints || o.isLine) found = true; });
  return found;
}

function hasBones(root) {
  let found = false;
  root.traverse((o) => { if (o.isBone) found = true; });
  return found;
}

// Put static models on the ground, centered.
function groundAndCenter(root) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3());
  const wrap = root;
  wrap.position.x -= c.x;
  wrap.position.z -= c.z;
  wrap.position.y -= box.min.y;
}

function pointsFrom(geometry, color = 0xd0d6e0) {
  geometry.computeBoundingBox();
  const size = geometry.boundingBox.getSize(new THREE.Vector3()).length();
  const mat = new THREE.PointsMaterial({ size: Math.max(size / 400, 0.001), vertexColors: !!geometry.attributes.color, color: geometry.attributes.color ? 0xffffff : color, sizeAttenuation: true });
  return new THREE.Points(geometry, mat);
}

function meshFrom(geometry) {
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  const mat = stdMaterial();
  if (geometry.attributes.color) { mat.vertexColors = true; mat.color.set(0xffffff); }
  return new THREE.Mesh(geometry, mat);
}

export class Importer {
  constructor(app) {
    this.app = app;
  }

  // files: [{path, file}] -> {vfs, primaries, images}
  async buildVFS(files, onStatus) {
    const vfs = new VFS();
    for (const { path, file } of files) {
      if (extOf(path) === 'zip') {
        onStatus?.(`Extracting ${baseName(path)}…`);
        await new Promise((r) => setTimeout(r, 30));
        const u8 = new Uint8Array(await file.arrayBuffer());
        vfs.addZip(u8, stripExt(path));
      } else {
        vfs.add(path, file);
      }
    }
    return vfs;
  }

  pickPrimaries(vfs) {
    const all = vfs.list();
    const models = all.filter((e) => MODEL_EXTS.has(e.ext));
    // .json is a model only if it isn't referenced as a resource; skip package.json etc.
    const primaries = models.filter((e) => {
      if (e.ext === 'json') return !/(package|tsconfig|manifest|license)\.json$/i.test(e.name);
      return true;
    });
    // when a folder has both .gltf and .glb of the same thing, prefer .glb
    const stems = new Set(primaries.filter((e) => e.ext === 'glb').map((e) => stripExt(e.key)));
    const filtered = primaries.filter((e) => !(e.ext === 'gltf' && stems.has(stripExt(e.key))));
    // order: models with meshes first, animation sources (bvh/json) last
    const rank = (e) => (e.ext === 'bvh' || e.ext === 'json' ? 2 : 0);
    filtered.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
    const images = all.filter((e) => IMAGE_EXTS.has(e.ext));
    const unsupported = all.filter((e) => UNSUPPORTED[e.ext]);
    return { primaries: filtered, images, unsupported };
  }

  // Load one primary file. Returns {root, animations, warnings, format, name, kind}
  async load(entry, vfs) {
    const ext = entry.ext;
    const basePath = entry.key.includes('/') ? entry.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') + '/' : '';
    const missing = new Set();
    const manager = makeManager(vfs, entry.path, missing);
    const name = stripExt(entry.name);
    const warnings = [];
    let root = null, animations = [], kind = 'import', placeOnGround = false, info = null;
    const renderer = this.app.viewport.renderer;

    switch (ext) {
      case 'glb': case 'gltf': case 'vrm': {
        const loader = new GLTFLoader(manager);
        loader.setDRACOLoader(getDraco());
        loader.setMeshoptDecoder(MeshoptDecoder);
        loader.setKTX2Loader(getKTX2(renderer));
        const data = await readBuf(entry.blob);
        const gltf = await loader.parseAsync(data, basePath);
        root = gltf.scene || gltf.scenes?.[0] || new THREE.Group();
        animations = gltf.animations || [];
        if (gltf.cameras) for (const c of gltf.cameras) c.userData.fromFile = true;
        break;
      }
      case 'fbx': {
        const loader = new FBXLoader(manager);
        const data = await readBuf(entry.blob);
        root = loader.parse(data, basePath);
        animations = root.animations || [];
        root.animations = [];
        break;
      }
      case 'obj': {
        const text = await readText(entry.blob);
        const loader = new OBJLoader(manager);
        const libs = [...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map((m) => m[1]);
        let mtlEntry = null;
        for (const lib of libs) { mtlEntry = vfs.find(lib, entry.path); if (mtlEntry) break; }
        if (!mtlEntry) mtlEntry = vfs.find(stripExt(entry.name) + '.mtl', entry.path);
        if (mtlEntry) {
          const mtl = new MTLLoader(manager);
          const mats = mtl.parse(await readText(mtlEntry.blob), basePath);
          mats.preload();
          loader.setMaterials(mats);
        } else if (libs.length) warnings.push(`Material file ${libs[0]} was not included`);
        root = loader.parse(text);
        placeOnGround = true;
        break;
      }
      case 'dae': {
        const loader = new ColladaLoader(manager);
        const res = loader.parse(await readText(entry.blob), basePath);
        root = res.scene;
        animations = res.animations || [];
        break;
      }
      case 'stl': {
        const geo = new STLLoader(manager).parse(await readBuf(entry.blob));
        root = new THREE.Group();
        const mesh = meshFrom(geo);
        if (geo.hasColors) { mesh.material.vertexColors = true; mesh.material.color.set(0xffffff); }
        mesh.name = name;
        mesh.rotation.x = -Math.PI / 2;
        root.add(mesh);
        placeOnGround = true;
        break;
      }
      case 'ply': {
        const geo = new PLYLoader(manager).parse(await readBuf(entry.blob));
        root = new THREE.Group();
        const obj = geo.index || (geo.attributes.position.count % 3 === 0 && geo.attributes.normal && !geo.attributes.color) ? meshFrom(geo) : pointsFrom(geo);
        obj.name = name;
        root.add(obj);
        placeOnGround = true;
        break;
      }
      case '3mf': {
        root = new ThreeMFLoader(manager).parse(await readBuf(entry.blob));
        root.rotation.x = -Math.PI / 2;
        const g = new THREE.Group(); g.add(root); root = g;
        placeOnGround = true;
        break;
      }
      case 'amf': {
        root = new AMFLoader(manager).parse(await readBuf(entry.blob));
        root.rotation.x = -Math.PI / 2;
        const g = new THREE.Group(); g.add(root); root = g;
        placeOnGround = true;
        break;
      }
      case '3ds': {
        const loader = new TDSLoader(manager);
        loader.setResourcePath?.(basePath);
        root = loader.parse(await readBuf(entry.blob), basePath);
        root.rotation.x = -Math.PI / 2;
        const g = new THREE.Group(); g.add(root); root = g;
        placeOnGround = true;
        break;
      }
      case 'wrl': case 'vrml': {
        root = new VRMLLoader(manager).parse(await readText(entry.blob), basePath);
        break;
      }
      case 'vox': {
        const res = new VOXLoader(manager).parse(await readBuf(entry.blob));
        if (res && res.scene) root = res.scene;
        else {
          root = new THREE.Group();
          const chunks = Array.isArray(res) ? res : res?.chunks || [];
          for (const ch of chunks) root.add(buildVoxMesh(ch));
        }
        root.scale.setScalar(0.1);
        const g = new THREE.Group(); g.add(root); root = g;
        placeOnGround = true;
        break;
      }
      case 'usdz': case 'usda': case 'usdc': case 'usd': {
        const loader = new USDLoader(manager);
        const buf = await readBuf(entry.blob);
        root = await new Promise((res, rej) => {
          try { loader.parse(buf, basePath, res, rej); } catch (e) { rej(e); }
        });
        break;
      }
      case 'lwo': {
        const res = new LWOLoader(manager).parse(await readBuf(entry.blob), basePath, name);
        root = new THREE.Group();
        for (const m of res.meshes) root.add(m);
        break;
      }
      case 'kmz': {
        const res = new KMZLoader(manager).parse(await readBuf(entry.blob));
        root = res.scene;
        break;
      }
      case 'pcd': {
        const pts = new PCDLoader(manager).parse(await readBuf(entry.blob));
        root = new THREE.Group(); root.add(pts);
        placeOnGround = true;
        break;
      }
      case 'xyz': {
        const geo = new XYZLoader(manager).parse(await readText(entry.blob));
        root = new THREE.Group(); root.add(pointsFrom(geo));
        placeOnGround = true;
        break;
      }
      case 'vtk': case 'vtp': {
        const geo = new VTKLoader(manager).parse(await readBuf(entry.blob), basePath);
        root = new THREE.Group(); root.add(geo.index || geo.attributes.normal ? meshFrom(geo) : pointsFrom(geo));
        placeOnGround = true;
        break;
      }
      case 'bvh': {
        const res = new BVHLoader(manager).parse(await readText(entry.blob));
        root = new THREE.Group();
        root.name = name;
        root.add(res.skeleton.bones[0]);
        res.clip.name = name;
        animations = [res.clip];
        kind = 'skeleton';
        break;
      }
      case 'md2': {
        const geo = new MD2Loader(manager).parse(await readBuf(entry.blob));
        const mat = stdMaterial();
        const img = vfs.list().find((e) => IMAGE_EXTS.has(e.ext));
        if (img) { const t = await textureFromBlob(img.blob); t.colorSpace = THREE.SRGBColorSpace; mat.map = t; mat.color.set(0xffffff); }
        const mesh = new THREE.Mesh(geo, mat);
        mesh.name = name;
        root = new THREE.Group();
        root.add(mesh);
        root.scale.setScalar(0.04);
        animations = geo.animations || [];
        placeOnGround = true;
        break;
      }
      case 'gcode': {
        root = new GCodeLoader(manager).parse(await readText(entry.blob));
        const g = new THREE.Group(); root.rotation.x = -Math.PI / 2; root.scale.setScalar(0.01); g.add(root); root = g;
        placeOnGround = true;
        break;
      }
      case 'drc': {
        const buf = await readBuf(entry.blob);
        const geo = await new Promise((res, rej) => getDraco().parse(buf, res, rej));
        root = new THREE.Group();
        root.add(geo.index ? meshFrom(geo) : pointsFrom(geo));
        placeOnGround = true;
        break;
      }
      case 'svg': {
        root = svgToObject(await readText(entry.blob), name);
        placeOnGround = true;
        break;
      }
      case 'blend': {
        const res = await importBlend(await readBuf(entry.blob), {
          importLights: this.app.settings.get('importLights'),
          loadImage: async ({ bytes, path }) => {
            if (bytes && bytes.length) {
              const type = sniffImageType(bytes);
              if (type) return textureFromBlob(new Blob([bytes], { type }));
              if (/\.tga$/i.test(path)) return new TGALoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
              return null;
            }
            if (!path) return null;
            const rel = path.replace(/^\/\//, '');
            const e = vfs.find(rel, entry.path) || vfs.find(baseName(rel), entry.path);
            if (!e) { missing.add(baseName(rel)); return null; }
            if (e.ext === 'tga') return new TGALoader().parse(await e.blob.arrayBuffer());
            return textureFromBlob(e.blob);
          },
        });
        root = res.scene;
        animations = res.animations;
        warnings.push(...res.warnings);
        info = res.info;
        break;
      }
      case 'json': {
        const text = await readText(entry.blob);
        let json;
        try { json = JSON.parse(text); } catch { throw new Error('This .json file is not valid JSON'); }
        if (json.metadata && /Object|Scene/i.test(json.metadata.type || '')) {
          root = await new THREE.ObjectLoader(manager).parseAsync(json);
          animations = root.animations || [];
        } else {
          const list = Array.isArray(json) ? json : json.animations || (json.tracks ? [json] : json.clips || []);
          animations = list.filter((c) => c && c.tracks).map((c) => THREE.AnimationClip.parse(c));
          if (!animations.length) throw new Error('This .json file has no model or animation data');
          root = null;
          kind = 'animation';
        }
        break;
      }
      default:
        throw new Error(`.${ext} files aren't supported`);
    }

    if (root) {
      await manager.waitIdle(20000);
      if (placeOnGround && !animations.length) groundAndCenter(root);
      root.traverse((o) => {
        if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; }
        if (o.isSkinnedMesh) o.frustumCulled = false;
        if (o.material) {
          for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
            if (m.map && m.map.colorSpace === THREE.NoColorSpace && !m.map.isDataTexture) m.map.colorSpace = THREE.SRGBColorSpace;
            if (m.emissiveMap && m.emissiveMap.colorSpace === THREE.NoColorSpace) m.emissiveMap.colorSpace = THREE.SRGBColorSpace;
          }
        }
      });
      try {
        const gpuMax = renderer.capabilities.maxTextureSize || 4096;
        await optimizeTextures(root, this.app.settings.maxTexture(), gpuMax);
      } catch (e) { console.warn(e); }
    }
    if (missing.size) warnings.push(`Missing texture${missing.size > 1 ? 's' : ''}: ${[...missing].slice(0, 6).join(', ')}${missing.size > 6 ? '…' : ''} (drop the textures or a .zip together with the model)`);
    const animationOnly = !!root && !hasMesh(root) && animations.length > 0;
    if (kind === 'animation') return { root: null, animations, warnings, format: ext, name, kind, animationOnly: true };
    return { root, animations, warnings, format: ext, name, kind, animationOnly, hasBones: root ? hasBones(root) : false, info };
  }

  async imagePlane(entry) {
    let tex;
    if (entry.ext === 'tga') tex = new TGALoader().parse(await entry.blob.arrayBuffer());
    else tex = await textureFromBlob(entry.blob);
    tex.colorSpace = THREE.SRGBColorSpace;
    const img = tex.image;
    const aspect = (img.width || 1) / (img.height || 1);
    const h = 1.5, w = h * aspect;
    const mat = new THREE.MeshStandardMaterial({ map: tex, side: THREE.DoubleSide, transparent: entry.ext === 'png' || entry.ext === 'webp' || entry.ext === 'gif', alphaTest: 0.02, roughness: 0.9 });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
    mesh.position.y = h / 2;
    mesh.name = stripExt(entry.name);
    mesh.castShadow = true;
    const root = new THREE.Group();
    root.name = stripExt(entry.name);
    root.add(mesh);
    await optimizeTextures(root, this.app.settings.maxTexture(), this.app.viewport.renderer.capabilities.maxTextureSize || 4096);
    return root;
  }
}

function svgToObject(text, name) {
  const data = new SVGLoader().parse(text);
  const group = new THREE.Group();
  const box = new THREE.Box2();
  for (const p of data.paths) for (const sp of p.subPaths) for (const pt of sp.getPoints()) box.expandByPoint(pt);
  const size = box.getSize(new THREE.Vector2());
  const maxDim = Math.max(size.x, size.y) || 1;
  const depth = maxDim * 0.06;
  let order = 0;
  for (const path of data.paths) {
    const style = path.userData?.style || {};
    const fill = style.fill;
    if (fill !== undefined && fill !== 'none') {
      const color = new THREE.Color().setStyle(fill === 'currentColor' ? '#888' : fill);
      const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.5, transparent: (style.fillOpacity ?? 1) < 1, opacity: style.fillOpacity ?? 1 });
      for (const shape of SVGLoader.createShapes(path)) {
        const geo = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 8 });
        const m = new THREE.Mesh(geo, mat);
        m.position.z = order * depth * 0.01;
        group.add(m);
      }
    }
    const stroke = style.stroke;
    if (stroke !== undefined && stroke !== 'none') {
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setStyle(stroke), side: THREE.DoubleSide });
      for (const sp of path.subPaths) {
        const geo = SVGLoader.pointsToStroke(sp.getPoints(), style);
        if (geo) group.add(new THREE.Mesh(geo, mat));
      }
    }
    order++;
  }
  const c = box.getCenter(new THREE.Vector2());
  const s = 2 / maxDim;
  group.children.forEach((ch) => { ch.position.x -= c.x; ch.position.y -= c.y; });
  group.scale.set(s, -s, s);
  const root = new THREE.Group();
  root.name = name;
  root.add(group);
  return root;
}
