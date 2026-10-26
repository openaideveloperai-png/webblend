import fs from 'fs';
import * as THREE from 'three';
import { USDComposer } from 'three/examples/jsm/loaders/usd/USDComposer.js';
const orig = USDComposer.prototype.applyTransform;
USDComposer.prototype.applyTransform = function (obj, fields, attrs = {}) {
  const data = { ...fields, ...attrs };
  for (const k of Object.keys(data)) if (k.startsWith('xformOp')) console.log(k, JSON.stringify(data[k]).slice(0, 200));
  return orig.call(this, obj, fields, attrs);
};
const { USDLoader } = await import('three/examples/jsm/loaders/USDLoader.js');
const buf = fs.readFileSync(process.argv[2]);
try { new USDLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '', (g) => console.log('loaded', g.children.length), (e) => console.log('ERR', e.message)); } catch (e) { console.log('THROW', e.message); }
