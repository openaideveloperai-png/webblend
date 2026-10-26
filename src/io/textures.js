// Texture helpers: downscale oversized textures to save GPU/CPU memory.
import * as THREE from 'three';

export const TEXTURE_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap', 'alphaMap', 'bumpMap', 'displacementMap', 'lightMap', 'specularMap', 'clearcoatMap', 'clearcoatNormalMap', 'clearcoatRoughnessMap', 'sheenColorMap', 'sheenRoughnessMap', 'transmissionMap', 'thicknessMap', 'specularColorMap', 'specularIntensityMap', 'iridescenceMap', 'anisotropyMap', 'gradientMap', 'matcap'];

export function collectTextures(root) {
  const set = new Set();
  root.traverse((o) => {
    if (!o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      for (const k of TEXTURE_KEYS) if (m[k] && m[k].isTexture) set.add(m[k]);
    }
  });
  return set;
}

function imageSize(img) {
  if (!img) return [0, 0];
  return [img.width || img.videoWidth || 0, img.height || img.videoHeight || 0];
}

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') {
    try { return new OffscreenCanvas(w, h); } catch { /* fall through */ }
  }
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

export function estimateTextureBytes(tex) {
  const [w, h] = imageSize(tex.image);
  return w * h * 4 * (tex.generateMipmaps ? 1.34 : 1);
}

// Downscale every texture in `root` larger than maxSize. Returns bytes saved.
export async function optimizeTextures(root, maxSize, gpuMax = 16384) {
  const limit = Math.min(maxSize, gpuMax);
  let saved = 0;
  for (const tex of collectTextures(root)) {
    if (tex.isCompressedTexture || tex.isDataArrayTexture || tex.isData3DTexture) continue;
    const img = tex.image;
    const [w, h] = imageSize(img);
    if (!w || !h || Math.max(w, h) <= limit) continue;
    const s = limit / Math.max(w, h);
    const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
    try {
      let src = img;
      if (tex.isDataTexture && img.data) {
        // DataTexture (TGA, EXR...): go through ImageData (8-bit only)
        if (!(img.data instanceof Uint8Array || img.data instanceof Uint8ClampedArray) || img.data.length !== w * h * 4) continue;
        const c0 = makeCanvas(w, h);
        const ctx0 = c0.getContext('2d');
        ctx0.putImageData(new ImageData(new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, w * h * 4), w, h), 0, 0);
        src = c0;
        const c = makeCanvas(nw, nh);
        c.getContext('2d').drawImage(src, 0, 0, nw, nh);
        const id = c.getContext('2d').getImageData(0, 0, nw, nh);
        tex.image = { data: new Uint8Array(id.data.buffer), width: nw, height: nh };
        tex.needsUpdate = true;
      } else {
        let out;
        if (typeof createImageBitmap === 'function' && (img instanceof ImageBitmap || img instanceof HTMLImageElement || (typeof HTMLCanvasElement !== 'undefined' && img instanceof HTMLCanvasElement))) {
          out = await createImageBitmap(img, { resizeWidth: nw, resizeHeight: nh, resizeQuality: 'high' });
        } else {
          out = makeCanvas(nw, nh);
          out.getContext('2d').drawImage(img, 0, 0, nw, nh);
        }
        if (img instanceof ImageBitmap) { try { img.close(); } catch { /* ignore */ } }
        tex.image = out;
        tex.needsUpdate = true;
      }
      saved += (w * h - nw * nh) * 4;
    } catch (e) {
      console.warn('texture downscale failed', e);
    }
  }
  return saved;
}

// Create a texture from raw bytes (packed .blend images, image drops).
export async function textureFromBlob(blob, { flipY = true } = {}) {
  let image;
  if (typeof createImageBitmap === 'function') {
    try {
      image = await createImageBitmap(blob, { imageOrientation: flipY ? 'flipY' : 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
      const tex = new THREE.Texture(image);
      tex.flipY = false; // already flipped
      tex.needsUpdate = true;
      return tex;
    } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(blob);
  try {
    image = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = url; });
    const tex = new THREE.Texture(image);
    tex.flipY = flipY;
    tex.needsUpdate = true;
    return tex;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
}

export function sniffImageType(u8) {
  if (!u8 || u8.length < 12) return '';
  if (u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'image/png';
  if (u8[0] === 0xff && u8[1] === 0xd8) return 'image/jpeg';
  if (u8[0] === 0x52 && u8[1] === 0x49 && u8[2] === 0x46 && u8[3] === 0x46 && u8[8] === 0x57) return 'image/webp';
  if (u8[0] === 0x47 && u8[1] === 0x49 && u8[2] === 0x46) return 'image/gif';
  if (u8[0] === 0x42 && u8[1] === 0x4d) return 'image/bmp';
  return '';
}
