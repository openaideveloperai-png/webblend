// DRACOLoader that uses the decoder embedded in this file (no network needed).
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { DRACO_WRAPPER_JS, DRACO_WASM_B64 } from '../generated/draco-inline.js';

function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

class InlineDRACOLoader extends DRACOLoader {
  _loadLibrary(url, responseType) {
    if (/wasm_wrapper/.test(url) && DRACO_WRAPPER_JS) return Promise.resolve(DRACO_WRAPPER_JS);
    if (/\.wasm/.test(url) && DRACO_WASM_B64) return Promise.resolve(b64ToArrayBuffer(DRACO_WASM_B64));
    return super._loadLibrary(url, responseType);
  }
}

export function createDracoLoader() {
  const l = new InlineDRACOLoader();
  l.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.186.1/examples/jsm/libs/draco/gltf/');
  l.setWorkerLimit(2);
  return l;
}
