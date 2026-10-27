// Converts a parsed .blend file into a three.js scene graph + AnimationClips.
// Handles: meshes (legacy MVert/MPoly, CustomData attributes, 5.x AttributeStorage),
// n-gons, UVs, smooth/flat shading, material slots, Principled BSDF colors and
// image textures (packed or external), object hierarchy (incl. bone parenting),
// armatures, skinning, shape keys, cameras, lights, mirror modifier, and actions
// (legacy and layered/slotted) for objects, bones and shape keys.

import * as THREE from 'three';
import { BlendFile, StructView } from './blendfile.js';

const OB_EMPTY = 0, OB_MESH = 1, OB_LAMP = 10, OB_CAMERA = 11, OB_ARMATURE = 25;
const PARBONE = 7;
const MOD_MIRROR = 5, MOD_ARMATURE = 8, MOD_SUBSURF = 1;

// CustomData types (3.x-4.x)
const CD_MDEFORMVERT = 2, CD_PROP_INT32 = 11, CD_MLOOPUV = 16, CD_PROP_FLOAT3 = 48, CD_PROP_FLOAT2 = 49, CD_PROP_BOOL = 50;
// AttrType (5.x)
const AT_BOOL = 0, AT_INT32 = 3, AT_FLOAT2 = 6, AT_FLOAT3 = 7;

const EULER_ORDERS = { 1: 'ZYX', 2: 'YZX', 3: 'ZXY', 4: 'XZY', 5: 'YXZ', 6: 'XYZ' };

function m4FromBlender(arr) {
  // Blender float[4][4] is mat[col][row] -> column-major, same as three.js
  return new THREE.Matrix4().fromArray(arr);
}

function rotationFromMode(rotmode, eul, quat, axis, angle) {
  const q = new THREE.Quaternion();
  if (rotmode === 0) {
    q.set(quat[1], quat[2], quat[3], quat[0]).normalize();
  } else if (rotmode === -1) {
    const ax = new THREE.Vector3(axis[0], axis[1], axis[2]);
    if (ax.lengthSq() < 1e-12) ax.set(0, 1, 0);
    q.setFromAxisAngle(ax.normalize(), angle);
  } else {
    q.setFromEuler(new THREE.Euler(eul[0], eul[1], eul[2], EULER_ORDERS[rotmode] || 'ZYX'));
  }
  return q;
}

// ---------------------------------------------------------------- mesh data

function readMeshData(bf, me) {
  const totvert = me.get('totvert') || 0;
  const totpoly = me.any(['totpoly', 'faces_num'], 0) || 0;
  const totloop = me.any(['totloop', 'corners_num'], 0) || 0;
  const data = { totvert, totpoly, totloop, positions: null, faceOffsets: null, cornerVerts: null, uvs: null, matIndex: null, sharpFace: null, sharpFaceSingle: null, dverts: null };

  // --- 5.x AttributeStorage
  const as = me.get('attribute_storage');
  const attrs = new Map();
  if (as && as.get('dna_attributes_num') > 0) {
    const n = as.get('dna_attributes_num');
    const ab = as.block('dna_attributes');
    const adef = bf.structDef('Attribute');
    if (ab && adef) {
      const cnt = Math.min(n, Math.floor(ab.size / adef.size));
      for (let i = 0; i < cnt; i++) {
        const A = bf.view(ab, i, adef);
        const name = bf.stringAt(A.ptr('name'), A.scope);
        const dt = A.get('data_type'), dom = A.get('domain'), st = A.get('storage_type');
        const holder = A.deref('data', st === 0 ? 'AttributeArray' : 'AttributeSingle');
        if (!holder) continue;
        attrs.set(name, { dt, dom, st, dataPtr: holder.ptr('data'), scope: holder.scope });
      }
    }
  }
  const attrFloat = (name, comps, count) => {
    const a = attrs.get(name);
    if (!a || a.st !== 0) return null;
    return bf.float32Array(a.dataPtr, count * comps, a.scope);
  };
  const attrInt = (name, count) => {
    const a = attrs.get(name);
    if (!a || a.st !== 0) return null;
    return bf.int32Array(a.dataPtr, count, a.scope);
  };

  // --- CustomData layers (3.x-4.x, also deform verts in 5.x)
  const cdLayers = (cdName) => {
    const cd = me.get(cdName);
    if (!cd) return [];
    const n = cd.get('totlayer') || 0;
    const lb = cd.block('layers');
    const def = bf.structDef('CustomDataLayer');
    const out = [];
    if (!lb || !def) return out;
    for (let i = 0; i < n && (i + 1) * def.size <= lb.size; i++) {
      const L = bf.view(lb, i, def);
      out.push({ name: L.str('name'), type: L.get('type'), dataPtr: L.ptr('data'), scope: L.scope, active: L.get('active') });
    }
    return out;
  };
  const vlayers = cdLayers('vdata');
  const players = cdLayers('pdata');
  const llayers = cdLayers('ldata');

  // positions
  data.positions = attrFloat('position', 3, totvert);
  if (!data.positions) {
    const L = vlayers.find((l) => l.type === CD_PROP_FLOAT3 && l.name === 'position');
    if (L) data.positions = bf.float32Array(L.dataPtr, totvert * 3, L.scope);
  }
  if (!data.positions) {
    // legacy MVert
    const mvBlock = me.block('mvert');
    const def = bf.structDef('MVert');
    if (mvBlock && def) {
      const co = def.fieldMap.get('co');
      data.positions = new Float32Array(totvert * 3);
      for (let i = 0; i < totvert; i++) {
        const o = mvBlock.offset + i * def.size + co.offset;
        for (let k = 0; k < 3; k++) data.positions[i * 3 + k] = bf.dv.getFloat32(o + k * 4, bf.littleEndian);
      }
    }
  }

  // face offsets
  const offPtr = me.ptr('poly_offset_indices') || me.ptr('face_offset_indices');
  if (offPtr) data.faceOffsets = bf.int32Array(offPtr, totpoly + 1, me.scope);
  let legacyPolys = null;
  if (!data.faceOffsets) {
    const mpBlock = me.block('mpoly');
    const def = bf.structDef('MPoly');
    if (mpBlock && def) {
      const ls = def.fieldMap.get('loopstart'), tl = def.fieldMap.get('totloop'), mn = def.fieldMap.get('mat_nr'), fl = def.fieldMap.get('flag');
      data.faceOffsets = new Int32Array(totpoly + 1);
      legacyPolys = { mat: new Int32Array(totpoly), smooth: new Uint8Array(totpoly) };
      let acc = 0;
      for (let i = 0; i < totpoly; i++) {
        const b = mpBlock.offset + i * def.size;
        const start = bf.dv.getInt32(b + ls.offset, bf.littleEndian);
        const cnt = bf.dv.getInt32(b + tl.offset, bf.littleEndian);
        data.faceOffsets[i] = start;
        acc = start + cnt;
        if (mn) legacyPolys.mat[i] = bf.dv.getInt16(b + mn.offset, bf.littleEndian);
        if (fl) legacyPolys.smooth[i] = bf.dv.getInt8(b + fl.offset) & 1;
      }
      data.faceOffsets[totpoly] = acc;
    }
  }

  // corner verts
  data.cornerVerts = attrInt('.corner_vert', totloop);
  if (!data.cornerVerts) {
    const L = llayers.find((l) => l.type === CD_PROP_INT32 && l.name === '.corner_vert');
    if (L) data.cornerVerts = bf.int32Array(L.dataPtr, totloop, L.scope);
  }
  if (!data.cornerVerts) {
    const mlBlock = me.block('mloop');
    const def = bf.structDef('MLoop');
    if (mlBlock && def) {
      const v = def.fieldMap.get('v');
      data.cornerVerts = new Int32Array(totloop);
      for (let i = 0; i < totloop; i++) data.cornerVerts[i] = bf.dv.getInt32(mlBlock.offset + i * def.size + v.offset, bf.littleEndian);
    }
  }

  // UVs: active float2 corner attribute
  for (const [name, a] of attrs) {
    if (a.dt === AT_FLOAT2 && a.dom === 3 && a.st === 0 && !name.startsWith('.')) {
      data.uvs = bf.float32Array(a.dataPtr, totloop * 2, a.scope);
      break;
    }
  }
  if (!data.uvs) {
    const uvL = llayers.filter((l) => l.type === CD_PROP_FLOAT2 && !l.name.startsWith('.'));
    if (uvL.length) data.uvs = bf.float32Array(uvL[0].dataPtr, totloop * 2, uvL[0].scope);
  }
  if (!data.uvs) {
    const L = llayers.find((l) => l.type === CD_MLOOPUV);
    const def = bf.structDef('MLoopUV');
    if (L && def) {
      const b = bf.blockAt(L.dataPtr, L.scope);
      if (b) {
        const uvf = def.fieldMap.get('uv');
        data.uvs = new Float32Array(totloop * 2);
        for (let i = 0; i < totloop; i++) {
          const o = b.offset + i * def.size + uvf.offset;
          data.uvs[i * 2] = bf.dv.getFloat32(o, bf.littleEndian);
          data.uvs[i * 2 + 1] = bf.dv.getFloat32(o + 4, bf.littleEndian);
        }
      }
    }
  }

  // material index
  data.matIndex = attrInt('material_index', totpoly);
  if (!data.matIndex) {
    const L = players.find((l) => l.type === CD_PROP_INT32 && l.name === 'material_index');
    if (L) data.matIndex = bf.int32Array(L.dataPtr, totpoly, L.scope);
  }
  if (!data.matIndex && legacyPolys) data.matIndex = legacyPolys.mat;

  // flat / smooth
  const sf = attrs.get('sharp_face');
  if (sf) {
    if (sf.st === 0) data.sharpFace = bf.uint8Array(sf.dataPtr, totpoly, sf.scope);
    else {
      const b = bf.blockAt(sf.dataPtr, sf.scope);
      data.sharpFaceSingle = b ? bf.u8[b.offset] !== 0 : false;
    }
  } else {
    const L = players.find((l) => l.type === CD_PROP_BOOL && l.name === 'sharp_face');
    if (L) data.sharpFace = bf.uint8Array(L.dataPtr, totpoly, L.scope);
    else if (legacyPolys) {
      data.sharpFace = new Uint8Array(totpoly);
      for (let i = 0; i < totpoly; i++) data.sharpFace[i] = legacyPolys.smooth[i] ? 0 : 1;
    } else if (bf.version < 401) {
      data.sharpFaceSingle = false;
    }
  }

  // deform verts (vertex group weights)
  let dvPtr = 0n, dvScope = me.scope;
  const dvL = vlayers.find((l) => l.type === CD_MDEFORMVERT);
  if (dvL) { dvPtr = dvL.dataPtr; dvScope = dvL.scope; }
  if (!dvPtr) dvPtr = me.ptr('dvert');
  if (dvPtr) {
    const dvb = bf.blockAt(dvPtr, dvScope);
    const def = bf.structDef('MDeformVert');
    const wdef = bf.structDef('MDeformWeight');
    if (dvb && def && wdef) {
      const fdw = def.fieldMap.get('dw'), ftot = def.fieldMap.get('totweight');
      const fnr = wdef.fieldMap.get('def_nr'), fw = wdef.fieldMap.get('weight');
      const dverts = new Array(totvert);
      for (let i = 0; i < totvert && (i + 1) * def.size <= dvb.size; i++) {
        const o = dvb.offset + i * def.size;
        const tot = bf.dv.getInt32(o + ftot.offset, bf.littleEndian);
        const p = bf.readPtr(o + fdw.offset);
        const list = [];
        if (tot > 0 && p) {
          const wb = bf.blockAt(p, dvb.owner || dvScope);
          if (wb) {
            for (let j = 0; j < tot && (j + 1) * wdef.size <= wb.size; j++) {
              const wo = wb.offset + j * wdef.size;
              list.push([bf.dv.getInt32(wo + fnr.offset, bf.littleEndian), bf.dv.getFloat32(wo + fw.offset, bf.littleEndian)]);
            }
          }
        }
        dverts[i] = list;
      }
      data.dverts = dverts;
    }
  }

  // ancient (pre-2.63) meshes: tessellated MFace only
  if ((!data.faceOffsets || !data.cornerVerts) && me.ptr('mface')) {
    const mfb = me.block('mface');
    const def = bf.structDef('MFace');
    const totface = me.get('totface') || 0;
    if (mfb && def) {
      const f = ['v1', 'v2', 'v3', 'v4'].map((n) => def.fieldMap.get(n));
      const mn = def.fieldMap.get('mat_nr'), fl = def.fieldMap.get('flag');
      const offs = [0], corners = [], mats = [], sharp = [];
      for (let i = 0; i < totface; i++) {
        const o = mfb.offset + i * def.size;
        const vs = f.map((ff) => bf.dv.getInt32(o + ff.offset, bf.littleEndian));
        const n = vs[3] ? 4 : 3;
        for (let k = 0; k < n; k++) corners.push(vs[k]);
        offs.push(corners.length);
        mats.push(mn ? bf.dv.getInt8(o + mn.offset) : 0);
        sharp.push(fl ? ((bf.dv.getInt8(o + fl.offset) & 1) ? 0 : 1) : 1);
      }
      data.totpoly = totface;
      data.totloop = corners.length;
      data.faceOffsets = Int32Array.from(offs);
      data.cornerVerts = Int32Array.from(corners);
      data.matIndex = Int32Array.from(mats);
      data.sharpFace = Uint8Array.from(sharp);
      data.uvs = null;
    }
  }
  return data;
}

function vertexGroupNames(bf, me, ob) {
  let names = [...bf.listBase(me.get('vertex_group_names'), 'bDeformGroup')].map((g) => g.str('name'));
  if (!names.length && ob) names = [...bf.listBase(ob.get('defbase'), 'bDeformGroup')].map((g) => g.str('name'));
  return names;
}

function readShapeKeys(bf, me, totvert) {
  const key = me.deref('key', 'Key');
  if (!key) return null;
  const refPtr = key.ptr('refkey');
  const blocks = [];
  for (const kb of bf.listBase(key.get('block'), 'KeyBlock')) {
    const isRef = kb.offset === (bf.viewAtPtr(refPtr, 'KeyBlock', key.scope) || {}).offset;
    const arr = bf.float32Array(kb.ptr('data'), totvert * 3, kb.scope);
    blocks.push({ name: kb.str('name'), value: kb.get('curval') || 0, data: arr, isRef, relative: kb.get('relative') });
  }
  return { key, blocks: blocks.filter((b) => !b.isRef && b.data && b.data.length === totvert * 3), keyView: key };
}

// Newell normal of polygon
function polyNormal(pos, cv, start, end, out) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = start; i < end; i++) {
    const a = cv[i] * 3, b = cv[i + 1 < end ? i + 1 : start] * 3;
    nx += (pos[a + 1] - pos[b + 1]) * (pos[a + 2] + pos[b + 2]);
    ny += (pos[a + 2] - pos[b + 2]) * (pos[a] + pos[b]);
    nz += (pos[a] - pos[b]) * (pos[a + 1] + pos[b + 1]);
  }
  out[0] = nx; out[1] = ny; out[2] = nz;
  return out;
}

function triangulateFace(pos, cv, start, end, normal, tris) {
  const n = end - start;
  if (n === 3) { tris.push(start, start + 1, start + 2); return; }
  if (n === 4) {
    const p = (i) => cv[start + i] * 3;
    const d02 = dist2(pos, p(0), p(2)), d13 = dist2(pos, p(1), p(3));
    if (d02 <= d13) tris.push(start, start + 1, start + 2, start, start + 2, start + 3);
    else tris.push(start, start + 1, start + 3, start + 1, start + 2, start + 3);
    return;
  }
  if (n < 3) return;
  // project to 2D along dominant normal axis and ear-clip
  const ax = Math.abs(normal[0]), ay = Math.abs(normal[1]), az = Math.abs(normal[2]);
  let i0 = 0, i1 = 1;
  if (ax >= ay && ax >= az) { i0 = 1; i1 = 2; } else if (ay >= ax && ay >= az) { i0 = 2; i1 = 0; }
  const contour = [];
  for (let i = start; i < end; i++) {
    const o = cv[i] * 3;
    contour.push(new THREE.Vector2(pos[o + i0], pos[o + i1]));
  }
  let faces;
  try { faces = THREE.ShapeUtils.triangulateShape(contour, []); } catch (e) { faces = null; }
  if (!faces || !faces.length) {
    for (let i = 1; i < n - 1; i++) tris.push(start, start + i, start + i + 1);
    return;
  }
  // keep winding consistent with original order
  const flip = THREE.ShapeUtils.isClockWise(contour) !== false ? false : false;
  for (const f of faces) {
    if (flip) tris.push(start + f[0], start + f[2], start + f[1]);
    else tris.push(start + f[0], start + f[1], start + f[2]);
  }
  // fix winding per triangle against face normal
  for (let t = tris.length - faces.length * 3; t < tris.length; t += 3) {
    const a = cv[tris[t]] * 3, b = cv[tris[t + 1]] * 3, c = cv[tris[t + 2]] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (cx * normal[0] + cy * normal[1] + cz * normal[2] < 0) { const tmp = tris[t + 1]; tris[t + 1] = tris[t + 2]; tris[t + 2] = tmp; }
  }
}

function dist2(p, a, b) {
  const dx = p[a] - p[b], dy = p[a + 1] - p[b + 1], dz = p[a + 2] - p[b + 2];
  return dx * dx + dy * dy + dz * dz;
}

// Build an indexed BufferGeometry. Splits vertices where UVs differ or faces are flat.
function buildGeometry(md, opts = {}) {
  const { positions: pos, faceOffsets: fo, cornerVerts: cv, uvs } = md;
  const totvert = md.totvert, totpoly = md.totpoly;
  if (!pos || !fo || !cv || totpoly === 0) return null;
  const flatAll = md.sharpFaceSingle === true;
  const isFlat = (f) => (md.sharpFace ? md.sharpFace[f] !== 0 : flatAll);

  // face normals + smooth vertex normals
  const fn = new Float32Array(totpoly * 3);
  const vn = new Float32Array(totvert * 3);
  const tmp = [0, 0, 0];
  for (let f = 0; f < totpoly; f++) {
    const s = fo[f], e = fo[f + 1];
    if (e - s < 3) continue;
    polyNormal(pos, cv, s, e, tmp);
    fn[f * 3] = tmp[0]; fn[f * 3 + 1] = tmp[1]; fn[f * 3 + 2] = tmp[2];
    if (!isFlat(f)) for (let i = s; i < e; i++) { const v = cv[i] * 3; vn[v] += tmp[0]; vn[v + 1] += tmp[1]; vn[v + 2] += tmp[2]; }
  }
  const norm3 = (a, i) => {
    const x = a[i], y = a[i + 1], z = a[i + 2];
    const l = Math.hypot(x, y, z) || 1;
    a[i] = x / l; a[i + 1] = y / l; a[i + 2] = z / l;
  };
  for (let f = 0; f < totpoly; f++) norm3(fn, f * 3);
  for (let v = 0; v < totvert; v++) norm3(vn, v * 3);

  // triangulate, grouped by material
  const triCorners = [];
  const triMat = [];
  const tris = [];
  for (let f = 0; f < totpoly; f++) {
    const s = fo[f], e = fo[f + 1];
    tris.length = 0;
    triangulateFace(pos, cv, s, e, [fn[f * 3], fn[f * 3 + 1], fn[f * 3 + 2]], tris);
    const m = md.matIndex ? md.matIndex[f] : 0;
    for (let i = 0; i < tris.length; i += 3) {
      triCorners.push(tris[i], tris[i + 1], tris[i + 2]);
      triMat.push(m, f);
    }
  }
  const ntris = triCorners.length / 3;
  const order = new Uint32Array(ntris);
  for (let i = 0; i < ntris; i++) order[i] = i;
  const hasMulti = md.matIndex && md.matCount > 1;
  if (hasMulti) order.sort((a, b) => triMat[a * 2] - triMat[b * 2]);

  // vertex dedupe chains
  const heads = new Int32Array(totvert).fill(-1);
  const nextIdx = [];
  const outVert = [], outU = [], outV = [], outFlat = [];
  const index = new Uint32Array(ntris * 3);
  const groups = [];
  let curMat = -1, groupStart = 0;
  for (let ti = 0; ti < ntris; ti++) {
    const t = order[ti];
    const m = triMat[t * 2], f = triMat[t * 2 + 1];
    if (hasMulti && m !== curMat) {
      if (curMat !== -1) groups.push({ start: groupStart, count: ti * 3 - groupStart, mat: curMat });
      curMat = m; groupStart = ti * 3;
    }
    const flat = isFlat(f) ? f + 1 : 0;
    for (let k = 0; k < 3; k++) {
      const c = triCorners[t * 3 + k];
      const v = cv[c];
      const u = uvs ? uvs[c * 2] : 0, w = uvs ? uvs[c * 2 + 1] : 0;
      let idx = heads[v], found = -1;
      while (idx !== -1) {
        if (outFlat[idx] === flat && Math.abs(outU[idx] - u) < 1e-6 && Math.abs(outV[idx] - w) < 1e-6) { found = idx; break; }
        idx = nextIdx[idx];
      }
      if (found === -1) {
        found = outVert.length;
        outVert.push(v); outU.push(u); outV.push(w); outFlat.push(flat);
        nextIdx.push(heads[v]);
        heads[v] = found;
      }
      index[ti * 3 + k] = found;
    }
  }
  if (hasMulti && curMat !== -1) groups.push({ start: groupStart, count: ntris * 3 - groupStart, mat: curMat });

  const nv = outVert.length;
  const P = new Float32Array(nv * 3), N = new Float32Array(nv * 3);
  const UV = uvs ? new Float32Array(nv * 2) : null;
  for (let i = 0; i < nv; i++) {
    const v = outVert[i] * 3;
    P[i * 3] = pos[v]; P[i * 3 + 1] = pos[v + 1]; P[i * 3 + 2] = pos[v + 2];
    const flat = outFlat[i];
    const src = flat ? fn : vn, si = flat ? (flat - 1) * 3 : v;
    N[i * 3] = src[si]; N[i * 3 + 1] = src[si + 1]; N[i * 3 + 2] = src[si + 2];
    if (UV) { UV[i * 2] = outU[i]; UV[i * 2 + 1] = outV[i]; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  if (UV) g.setAttribute('uv', new THREE.BufferAttribute(UV, 2));
  g.setIndex(new THREE.BufferAttribute(nv > 65535 ? index : Uint16Array.from(index), 1));
  for (const gr of groups) g.addGroup(gr.start, gr.count, gr.mat);
  g.userData.srcVert = outVert; // original vertex for each output vertex
  return g;
}

const MIR_AXIS_X = 1 << 3, MIR_AXIS_Y = 1 << 4, MIR_AXIS_Z = 1 << 5, MIR_VGROUP = 1 << 6, MIR_NO_MERGE = 1 << 7;

// Mirror modifier: duplicate + flip geometry per enabled axis, weld seam vertices.
function applyMirror(md, mod) {
  const flag = mod.get('flag') || 0;
  const tol = mod.get('tolerance') ?? 0.001;
  const axes = [];
  if (flag & MIR_AXIS_X) axes.push(0);
  if (flag & MIR_AXIS_Y) axes.push(1);
  if (flag & MIR_AXIS_Z) axes.push(2);
  if (!axes.length) axes.push(0);
  let cur = md;
  for (const axis of axes) {
    const V = cur.totvert, F = cur.totpoly, L = cur.totloop;
    const src = cur.positions;
    const pos = new Float32Array(V * 6);
    pos.set(src);
    const remap = new Int32Array(V);
    for (let i = 0; i < V; i++) {
      pos[(V + i) * 3] = src[i * 3];
      pos[(V + i) * 3 + 1] = src[i * 3 + 1];
      pos[(V + i) * 3 + 2] = src[i * 3 + 2];
      pos[(V + i) * 3 + axis] *= -1;
      const onSeam = !(flag & MIR_NO_MERGE) && Math.abs(src[i * 3 + axis]) <= tol;
      remap[i] = onSeam ? i : V + i;
    }
    const fo = new Int32Array(F * 2 + 1);
    for (let f = 0; f <= F; f++) fo[f] = cur.faceOffsets[f];
    for (let f = 0; f < F; f++) fo[F + 1 + f] = L + cur.faceOffsets[f + 1];
    const cv = new Int32Array(L * 2);
    cv.set(cur.cornerVerts);
    const uvs = cur.uvs ? new Float32Array(L * 4) : null;
    if (uvs) uvs.set(cur.uvs);
    for (let f = 0; f < F; f++) {
      const s = cur.faceOffsets[f], e = cur.faceOffsets[f + 1];
      for (let j = 0; j < e - s; j++) {
        const from = e - 1 - j; // reversed winding keeps normals outward
        cv[L + s + j] = remap[cur.cornerVerts[from]];
        if (uvs) { uvs[(L + s + j) * 2] = cur.uvs[from * 2]; uvs[(L + s + j) * 2 + 1] = cur.uvs[from * 2 + 1]; }
      }
    }
    const mat = cur.matIndex ? new Int32Array(F * 2) : null;
    if (mat) { mat.set(cur.matIndex); mat.set(cur.matIndex, F); }
    const sharp = cur.sharpFace ? new Uint8Array(F * 2) : null;
    if (sharp) { sharp.set(cur.sharpFace); sharp.set(cur.sharpFace, F); }
    let dverts = null;
    if (cur.dverts) {
      dverts = cur.dverts.slice();
      for (let i = 0; i < V; i++) dverts[V + i] = (cur.dverts[i] || []).map(([g, w]) => [(flag & MIR_VGROUP) ? -(g + 1) : g, w]);
    }
    const morphs = cur.morphs ? cur.morphs.map((m) => {
      const a = new Float32Array(V * 6);
      a.set(m.data);
      for (let i = 0; i < V; i++) for (let k = 0; k < 3; k++) a[(V + i) * 3 + k] = m.data[i * 3 + k] * (k === axis ? -1 : 1);
      return { ...m, data: a };
    }) : null;
    cur = { ...cur, totvert: V * 2, totpoly: F * 2, totloop: L * 2, positions: pos, faceOffsets: fo, cornerVerts: cv, uvs, matIndex: mat, sharpFace: sharp, dverts, morphs };
  }
  return cur;
}

// Catmull-Clark subdivision (one level). Every new vertex is a weighted sum of
// old vertices, so positions, shape keys and skin weights all go through the same rows.
function subdivideOnce(md) {
  const V = md.totvert, F = md.totpoly, L = md.totloop;
  const fo = md.faceOffsets, cv = md.cornerVerts;
  const edgeMap = new Map();
  const ev0 = [], ev1 = [], efaces = [];
  const cornerEdge = new Int32Array(L);
  for (let f = 0; f < F; f++) {
    const s = fo[f], e = fo[f + 1];
    for (let i = s; i < e; i++) {
      const a = cv[i], b = cv[i + 1 < e ? i + 1 : s];
      const key = a < b ? a * V + b : b * V + a;
      let ei = edgeMap.get(key);
      if (ei === undefined) { ei = ev0.length; edgeMap.set(key, ei); ev0.push(a); ev1.push(b); efaces.push([]); }
      efaces[ei].push(f);
      cornerEdge[i] = ei;
    }
  }
  const E = ev0.length;
  const vEdges = Array.from({ length: V }, () => []);
  const vFaces = Array.from({ length: V }, () => []);
  for (let ei = 0; ei < E; ei++) { vEdges[ev0[ei]].push(ei); vEdges[ev1[ei]].push(ei); }
  for (let f = 0; f < F; f++) for (let i = fo[f]; i < fo[f + 1]; i++) vFaces[cv[i]].push(f);
  // rows: arrays [idx, w, idx, w, ...]
  const faceRow = (f) => {
    const s = fo[f], e = fo[f + 1], k = e - s, r = [];
    for (let i = s; i < e; i++) r.push(cv[i], 1 / k);
    return r;
  };
  const merge = (parts) => { // parts: [[row, scale], ...]
    const m = new Map();
    for (const [row, sc] of parts) for (let j = 0; j < row.length; j += 2) m.set(row[j], (m.get(row[j]) || 0) + row[j + 1] * sc);
    const out = [];
    for (const [i, w] of m) if (w !== 0) out.push(i, w);
    return out;
  };
  const rows = new Array(V + E + F);
  for (let f = 0; f < F; f++) rows[V + E + f] = faceRow(f);
  for (let ei = 0; ei < E; ei++) {
    const ff = efaces[ei];
    if (ff.length === 2) rows[V + ei] = merge([[[ev0[ei], 1, ev1[ei], 1], 0.25], [rows[V + E + ff[0]], 0.25], [rows[V + E + ff[1]], 0.25]]);
    else rows[V + ei] = [ev0[ei], 0.5, ev1[ei], 0.5];
  }
  for (let v = 0; v < V; v++) {
    const edges = vEdges[v];
    if (!edges.length) { rows[v] = [v, 1]; continue; }
    const boundary = edges.filter((ei) => efaces[ei].length !== 2);
    if (boundary.length) {
      if (boundary.length === 2) {
        const o = boundary.map((ei) => (ev0[ei] === v ? ev1[ei] : ev0[ei]));
        rows[v] = [v, 0.75, o[0], 0.125, o[1], 0.125];
      } else rows[v] = [v, 1];
      continue;
    }
    const n = edges.length;
    const parts = [[[v, 1], (n - 3) / n]];
    const faces = vFaces[v];
    for (const f of faces) parts.push([rows[V + E + f], 1 / (faces.length * n)]);
    for (const ei of edges) parts.push([[ev0[ei], 0.5, ev1[ei], 0.5], 2 / (edges.length * n)]);
    rows[v] = merge(parts);
  }
  const apply = (src, comps) => {
    const out = new Float32Array(rows.length * comps);
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let j = 0; j < row.length; j += 2) {
        const i = row[j], w = row[j + 1];
        for (let c = 0; c < comps; c++) out[r * comps + c] += w * src[i * comps + c];
      }
    }
    return out;
  };
  // topology: each k-gon -> k quads
  const nF = L;
  const nfo = new Int32Array(nF + 1);
  const ncv = new Int32Array(nF * 4);
  const nuv = md.uvs ? new Float32Array(nF * 8) : null;
  const nmat = md.matIndex ? new Int32Array(nF) : null;
  const nsharp = md.sharpFace ? new Uint8Array(nF) : null;
  let q = 0;
  for (let f = 0; f < F; f++) {
    const s = fo[f], e = fo[f + 1], k = e - s;
    let fu = 0, fv = 0;
    if (nuv) { for (let i = s; i < e; i++) { fu += md.uvs[i * 2]; fv += md.uvs[i * 2 + 1]; } fu /= k; fv /= k; }
    for (let j = 0; j < k; j++) {
      const i = s + j, nx = s + ((j + 1) % k), pv = s + ((j - 1 + k) % k);
      nfo[q] = q * 4;
      ncv.set([cv[i], V + cornerEdge[i], V + E + f, V + cornerEdge[pv]], q * 4);
      if (nuv) {
        const U = md.uvs;
        nuv.set([U[i * 2], U[i * 2 + 1], (U[i * 2] + U[nx * 2]) / 2, (U[i * 2 + 1] + U[nx * 2 + 1]) / 2, fu, fv, (U[i * 2] + U[pv * 2]) / 2, (U[i * 2 + 1] + U[pv * 2 + 1]) / 2], q * 8);
      }
      if (nmat) nmat[q] = md.matIndex[f];
      if (nsharp) nsharp[q] = md.sharpFace[f];
      q++;
    }
  }
  nfo[nF] = nF * 4;
  let dverts = null;
  if (md.dverts) {
    dverts = new Array(rows.length);
    for (let r = 0; r < rows.length; r++) {
      const m = new Map();
      const row = rows[r];
      for (let j = 0; j < row.length; j += 2) for (const [g, w] of md.dverts[row[j]] || []) m.set(g, (m.get(g) || 0) + w * row[j + 1]);
      dverts[r] = [...m].filter(([, w]) => w > 1e-4);
    }
  }
  return {
    ...md, totvert: rows.length, totpoly: nF, totloop: nF * 4, positions: apply(md.positions, 3), faceOffsets: nfo, cornerVerts: ncv,
    uvs: nuv, matIndex: nmat, sharpFace: nsharp, dverts, morphs: md.morphs ? md.morphs.map((m) => ({ ...m, data: apply(m.data, 3) })) : null,
  };
}

// Move vertices of an all-quad Catmull-Clark mesh onto the limit surface
// (Blender's default "Use Limit Surface").
function projectToLimit(md) {
  const V = md.totvert, F = md.totpoly, fo = md.faceOffsets, cv = md.cornerVerts;
  const nbr = Array.from({ length: V }, () => new Set());
  const diag = Array.from({ length: V }, () => []);
  const edgeCount = new Map();
  for (let f = 0; f < F; f++) {
    const s = fo[f], e = fo[f + 1], k = e - s;
    if (k !== 4) return md; // only valid for quads
    for (let j = 0; j < 4; j++) {
      const a = cv[s + j], b = cv[s + ((j + 1) % 4)], o = cv[s + ((j + 2) % 4)];
      nbr[a].add(b); nbr[b].add(a);
      diag[a].push(o);
      const key = a < b ? a * V + b : b * V + a;
      edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
    }
  }
  const isBoundaryEdge = (a, b) => edgeCount.get(a < b ? a * V + b : b * V + a) === 1;
  const rows = new Array(V);
  for (let v = 0; v < V; v++) {
    const ns = [...nbr[v]];
    const bnd = ns.filter((n) => isBoundaryEdge(v, n));
    if (bnd.length) {
      rows[v] = bnd.length === 2 ? [v, 4 / 6, bnd[0], 1 / 6, bnd[1], 1 / 6] : [v, 1];
      continue;
    }
    const n = ns.length;
    if (!n) { rows[v] = [v, 1]; continue; }
    const den = n * (n + 5);
    const row = [v, (n * n) / den];
    for (const u of ns) row.push(u, 4 / den);
    for (const u of diag[v]) row.push(u, 1 / den);
    rows[v] = row;
  }
  const apply = (src) => {
    const out = new Float32Array(V * 3);
    for (let r = 0; r < V; r++) {
      const row = rows[r];
      for (let j = 0; j < row.length; j += 2) { const i = row[j] * 3, w = row[j + 1]; out[r * 3] += w * src[i]; out[r * 3 + 1] += w * src[i + 1]; out[r * 3 + 2] += w * src[i + 2]; }
    }
    return out;
  };
  return { ...md, positions: apply(md.positions), morphs: md.morphs ? md.morphs.map((m) => ({ ...m, data: apply(m.data) })) : null };
}

export function subdivide(md, levels, maxFaces = 400000, limit = true) {
  let cur = md;
  let done = 0;
  for (let l = 0; l < levels; l++) {
    if (cur.totloop > maxFaces) break; // next level would have totloop faces
    cur = subdivideOnce(cur);
    done++;
  }
  return done && limit ? projectToLimit(cur) : cur;
}

// "Arm.L" <-> "Arm.R", "LeftHand" <-> "RightHand", "thigh_l" <-> "thigh_r"
export function flipSideName(name) {
  const rules = [
    [/([._\- ])L$/, '$1R'], [/([._\- ])R$/, '$1L'], [/([._\- ])l$/, '$1r'], [/([._\- ])r$/, '$1l'],
    [/^L([._\- ])/, 'R$1'], [/^R([._\- ])/, 'L$1'], [/^l([._\- ])/, 'r$1'], [/^r([._\- ])/, 'l$1'],
    [/Left/, 'Right'], [/Right/, 'Left'], [/left/, 'right'], [/right/, 'left'], [/LEFT/, 'RIGHT'], [/RIGHT/, 'LEFT'],
  ];
  for (const [re, rep] of rules) if (re.test(name)) return name.replace(re, rep);
  return name;
}

// ------------------------------------------------------------- FCurves

function readFCurve(bf, fc) {
  const path = bf.stringAt(fc.ptr('rna_path'), fc.scope);
  const index = fc.get('array_index') || 0;
  const n = fc.get('totvert') || 0;
  const bb = fc.block('bezt');
  const def = bf.structDef('BezTriple');
  const keys = [];
  if (bb && def) {
    const fvec = def.fieldMap.get('vec'), fipo = def.fieldMap.get('ipo'), feas = def.fieldMap.get('easing');
    for (let i = 0; i < n && (i + 1) * def.size <= bb.size; i++) {
      const o = bb.offset + i * def.size;
      const v = [];
      for (let k = 0; k < 9; k++) v.push(bf.dv.getFloat32(o + fvec.offset + k * 4, bf.littleEndian));
      keys.push({
        hl: [v[0], v[1]], x: v[3], y: v[4], hr: [v[6], v[7]],
        ipo: fipo ? bf.dv.getInt8(o + fipo.offset) : 2,
        easing: feas ? bf.dv.getInt8(o + feas.offset) : 0,
      });
    }
  }
  return { path, index, keys, extend: fc.get('extend') || 0 };
}

function bezierSolve(p0, p1, p2, p3, x) {
  // find t so that bezier_x(t) = x
  let lo = 0, hi = 1, t = (x - p0[0]) / ((p3[0] - p0[0]) || 1);
  for (let i = 0; i < 24; i++) {
    const it = 1 - t;
    const bx = it * it * it * p0[0] + 3 * it * it * t * p1[0] + 3 * it * t * t * p2[0] + t * t * t * p3[0];
    if (Math.abs(bx - x) < 1e-5) break;
    if (bx < x) lo = t; else hi = t;
    t = (lo + hi) / 2;
  }
  const it = 1 - t;
  return it * it * it * p0[1] + 3 * it * it * t * p1[1] + 3 * it * t * t * p2[1] + t * t * t * p3[1];
}

const easeFns = {
  3: (t) => t * t * (2.70158 * t - 1.70158), // back
  4: (t) => 1 - bounceOut(1 - t),
  5: (t) => 1 - Math.sqrt(1 - t * t),
  6: (t) => t * t * t,
  7: (t) => (t === 0 || t === 1 ? t : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3))),
  8: (t) => (t === 0 ? 0 : Math.pow(2, 10 * t - 10)),
  9: (t) => t * t,
  10: (t) => t * t * t * t,
  11: (t) => t * t * t * t * t,
  12: (t) => 1 - Math.cos((t * Math.PI) / 2),
};
function bounceOut(t) {
  const n1 = 7.5625, d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
}

function evalFCurve(fc, frame) {
  const k = fc.keys;
  if (!k.length) return 0;
  if (frame <= k[0].x) {
    if (fc.extend === 1 && k.length > 1) return k[0].y + (frame - k[0].x) * (k[1].y - k[0].y) / ((k[1].x - k[0].x) || 1);
    return k[0].y;
  }
  const last = k[k.length - 1];
  if (frame >= last.x) {
    if (fc.extend === 1 && k.length > 1) { const p = k[k.length - 2]; return last.y + (frame - last.x) * (last.y - p.y) / ((last.x - p.x) || 1); }
    return last.y;
  }
  let i = 0;
  while (i < k.length - 2 && k[i + 1].x <= frame) i++;
  const a = k[i], b = k[i + 1];
  const span = b.x - a.x || 1;
  const t = (frame - a.x) / span;
  if (a.ipo === 0) return a.y;
  if (a.ipo === 1) return a.y + (b.y - a.y) * t;
  if (a.ipo === 2) {
    // correct handles so curve is monotonic in x
    const p0 = [a.x, a.y], p3 = [b.x, b.y];
    let h1 = [a.hr[0] - a.x, a.hr[1] - a.y], h2 = [b.hl[0] - b.x, b.hl[1] - b.y];
    const len1 = Math.max(0, h1[0]), len2 = Math.max(0, -h2[0]);
    const sum = len1 + len2;
    if (sum > span && sum > 0) { const s = span / sum; h1 = [h1[0] * s, h1[1] * s]; h2 = [h2[0] * s, h2[1] * s]; }
    return bezierSolve(p0, [a.x + Math.max(0, h1[0]), a.y + h1[1]], [b.x + Math.min(0, h2[0]), b.y + h2[1]], p3, frame);
  }
  const fnE = easeFns[a.ipo];
  if (!fnE) return a.y + (b.y - a.y) * t;
  let mode = a.easing;
  if (mode === 0) mode = a.ipo === 3 || a.ipo === 4 || a.ipo === 7 ? 2 : 1;
  let e;
  if (mode === 1) e = fnE(t);
  else if (mode === 2) e = 1 - fnE(1 - t);
  else e = t < 0.5 ? fnE(t * 2) / 2 : 1 - fnE((1 - t) * 2) / 2;
  return a.y + (b.y - a.y) * e;
}

function actionFCurves(bf, ac, slotHandle) {
  // layered (4.4+) actions: pick channelbag for slot
  const out = [];
  const nKD = ac.get('strip_keyframe_data_array_num') || 0;
  if (nKD > 0 && bf.structDef('ActionStripKeyframeData')) {
    let bags = [];
    for (const kp of bf.pointerArray(ac.ptr('strip_keyframe_data_array'), nKD, ac.scope)) {
      const K = bf.viewAtPtr(kp, 'ActionStripKeyframeData', ac.scope);
      if (!K) continue;
      for (const cp of bf.pointerArray(K.ptr('channelbag_array'), K.get('channelbag_array_num'), K.scope)) {
        const C = bf.viewAtPtr(cp, 'ActionChannelBag', K.scope) || bf.viewAtPtr(cp, 'ActionChannelbag', K.scope);
        if (C) bags.push(C);
      }
    }
    let chosen = bags.filter((c) => c.any(['slot_handle', 'binding_handle']) === slotHandle);
    if (!chosen.length) chosen = bags.slice(0, 1);
    for (const C of chosen) {
      for (const fp of bf.pointerArray(C.ptr('fcurve_array'), C.get('fcurve_array_num'), C.scope)) {
        const fc = bf.viewAtPtr(fp, 'FCurve', C.scope);
        if (fc) out.push(readFCurve(bf, fc));
      }
    }
    if (out.length) return out;
  }
  for (const fc of bf.listBase(ac.get('curves'), 'FCurve')) out.push(readFCurve(bf, fc));
  return out;
}

// --------------------------------------------------------------- import

export async function importBlend(arrayBuffer, opts = {}) {
  const bf = new BlendFile(new Uint8Array(arrayBuffer));
  const warnings = [];
  const loadImage = opts.loadImage || (async () => null);

  const sc = bf.idBlocks('SC')[0] ? bf.view(bf.idBlocks('SC')[0]) : null;
  let fps = 24;
  if (sc) {
    const r = sc.get('r');
    if (r) { const fs = r.get('frs_sec') || 24, fb = r.get('frs_sec_base') || 1; fps = fs / fb || 24; }
  }

  const root = new THREE.Group();
  root.name = 'Blend';
  const zup = new THREE.Group();
  zup.name = 'Z-up';
  zup.rotation.x = -Math.PI / 2;
  root.add(zup);

  // ---------- materials & images
  const imageCache = new Map();
  const getImageTexture = async (imView, colorSpace) => {
    if (!imView) return null;
    const key = imView.offset + ':' + colorSpace;
    if (imageCache.has(key)) return imageCache.get(key);
    const p = (async () => {
      let bytes = null;
      let pf = imView.deref('packedfile', 'PackedFile');
      if (!pf) {
        for (const ipf of bf.listBase(imView.get('packedfiles'), 'ImagePackedFile')) { pf = ipf.deref('packedfile', 'PackedFile'); if (pf) break; }
      }
      if (pf) {
        const size = pf.get('size');
        bytes = bf.uint8Array(pf.ptr('data'), size, pf.scope);
      }
      const path = imView.str('name') || imView.str('filepath') || '';
      const tex = await loadImage({ bytes, path, name: imView.idName() });
      if (tex) { tex.colorSpace = colorSpace; tex.name = imView.idName(); }
      return tex;
    })();
    imageCache.set(key, p);
    return p;
  };

  const matCache = new Map();
  const convertMaterial = async (maView) => {
    if (!maView) return null;
    if (matCache.has(maView.offset)) return matCache.get(maView.offset);
    const p = (async () => {
      const m = new THREE.MeshStandardMaterial({ name: maView.idName() });
      m.color.setRGB(maView.get('r') ?? 0.8, maView.get('g') ?? 0.8, maView.get('b') ?? 0.8);
      m.metalness = maView.get('metallic') ?? 0;
      m.roughness = maView.get('roughness') ?? 0.5;
      const nt = maView.deref('nodetree', 'bNodeTree');
      if (nt && (maView.get('use_nodes') || bf.version >= 500)) {
        try { await applyNodeTree(bf, nt, m, getImageTexture, maView); } catch (e) { warnings.push('Material ' + m.name + ': ' + e.message); }
      }
      // Blender shows both sides unless "Backface Culling" is ticked
      m.side = (maView.get('blend_flag') || 0) & 1 ? THREE.FrontSide : THREE.DoubleSide;
      return m;
    })();
    matCache.set(maView.offset, p);
    return p;
  };

  // ---------- objects
  let objViews = bf.idBlocks('OB').map((b) => bf.view(b));
  const vis = sceneVisibility(bf);
  if (vis) {
    // objects that aren't in the current scene (other scenes, unused data) stay out,
    // except parents of objects that are in it
    const keep = new Set(vis.inScene);
    for (const ob of objViews) {
      if (!vis.inScene.has(ob.offset)) continue;
      for (let p = ob.deref('parent'), n = 0; p && n < 64; p = p.deref('parent'), n++) keep.add(p.offset);
    }
    objViews = objViews.filter((ob) => keep.has(ob.offset));
  }
  const nodes = new Map(); // ob offset -> {ob, node(animated), attach(parent for children)}
  const objByPtr = new Map();
  for (const b of bf.idBlocks('OB')) objByPtr.set(b.oldPtr, bf.view(b));

  const armatures = new Map(); // ob offset -> {bones: Map name->Bone, boneList, restLocal}
  const meshTasks = [];
  const pending = [];

  for (const ob of objViews) {
    const type = ob.get('type');
    const name = ob.idName();
    let node;
    if (type === OB_ARMATURE) node = new THREE.Group();
    else node = new THREE.Group();
    node.name = name;
    // local transform
    const loc = ob.get('loc') || [0, 0, 0], dloc = ob.get('dloc') || [0, 0, 0];
    const size = ob.get('size') || [1, 1, 1], dscale = ob.get('dscale') || [1, 1, 1];
    const rotmode = ob.get('rotmode') ?? 1;
    const q = rotationFromMode(rotmode, ob.get('rot') || [0, 0, 0], ob.get('quat') || [1, 0, 0, 0], ob.get('rotAxis') || [0, 1, 0], ob.get('rotAngle') || 0);
    const dq = rotationFromMode(rotmode, ob.get('drot') || [0, 0, 0], ob.get('dquat') || [1, 0, 0, 0], ob.get('drotAxis') || [0, 1, 0], ob.get('drotAngle') || 0);
    node.position.set(loc[0] + dloc[0], loc[1] + dloc[1], loc[2] + dloc[2]);
    node.quaternion.copy(dq).multiply(q);
    node.scale.set(size[0] * dscale[0], size[1] * dscale[1], size[2] * dscale[2]);
    node.userData.blend = { type, rotmode };
    const hidden = vis ? (!vis.inScene.has(ob.offset) || vis.isHidden(ob)) : !!((ob.get('restrictflag') || 0) & 1);
    nodes.set(ob.offset, { ob, node, attach: node, type, hidden });
  }

  // armature bones
  for (const { ob, node, type } of nodes.values()) {
    if (type !== OB_ARMATURE) continue;
    const arm = ob.deref('data', 'bArmature');
    if (!arm) continue;
    const bones = new Map();
    const boneList = [];
    const restInfo = new Map();
    const build = (bv, parentBone, parentArm) => {
      const b = new THREE.Bone();
      b.name = bv.str('name');
      const armMat = m4FromBlender(bv.get('arm_mat'));
      const local = parentArm ? parentArm.clone().invert().multiply(armMat) : armMat.clone();
      local.decompose(b.position, b.quaternion, b.scale);
      b.scale.set(1, 1, 1);
      restInfo.set(b.name, { pos: b.position.clone(), quat: b.quaternion.clone(), length: bv.get('length') || 0 });
      (parentBone || node).add(b);
      bones.set(b.name, b);
      boneList.push(b);
      for (const child of bf.listBase(bv.get('childbase'), 'Bone')) build(child, b, armMat);
    };
    for (const bv of bf.listBase(arm.get('bonebase'), 'Bone')) build(bv, null, null);
    armatures.set(ob.offset, { ob, node, bones, boneList, restInfo, pose: ob.deref('pose', 'bPose') });
  }

  // hierarchy
  for (const entry of nodes.values()) {
    const { ob, node } = entry;
    const parentOb = ob.deref('parent');
    const parentEntry = parentOb ? nodes.get(parentOb.offset) : null;
    let parentNode = parentEntry ? parentEntry.attach : zup;
    const partype = ob.get('partype') || 0;
    if (parentEntry && partype === PARBONE) {
      const arm = armatures.get(parentEntry.ob.offset);
      const boneName = ob.str('parsubstr');
      const bone = arm && arm.bones.get(boneName);
      if (bone) {
        const tip = new THREE.Group();
        tip.name = boneName + '_tail';
        tip.position.set(0, arm.restInfo.get(boneName).length, 0);
        bone.add(tip);
        parentNode = tip;
      }
    }
    if (parentEntry) {
      const pinv = m4FromBlender(ob.get('parentinv'));
      if (!pinv.equals(new THREE.Matrix4())) {
        const holder = new THREE.Group();
        holder.name = node.name + '_parentinv';
        holder.matrixAutoUpdate = false;
        holder.matrix.copy(pinv);
        parentNode.add(holder);
        parentNode = holder;
      }
    }
    parentNode.add(node);
  }

  // object data
  const camLights = [];
  for (const entry of nodes.values()) {
    const { ob, node, type } = entry;
    if (type === OB_MESH) {
      meshTasks.push(entry);
    } else if (type === OB_CAMERA) {
      const cam = ob.deref('data', 'Camera');
      const lens = cam ? cam.get('lens') || 50 : 50;
      const sensor = cam ? cam.get('sensor_x') || 36 : 36;
      const fov = THREE.MathUtils.radToDeg(2 * Math.atan(sensor / 2 / lens));
      const c = new THREE.PerspectiveCamera(Math.min(fov, 120), 16 / 9, cam?.get('clipsta') || 0.1, cam?.get('clipend') || 1000);
      c.name = node.name + '_camera';
      node.add(c);
      camLights.push(c);
    } else if (type === OB_LAMP && opts.importLights !== false) {
      const la = ob.deref('data', 'Lamp') || ob.deref('data', 'Light');
      if (la) {
        const lt = la.get('type') || 0;
        const col = new THREE.Color(la.get('r') ?? 1, la.get('g') ?? 1, la.get('b') ?? 1);
        const energy = la.get('energy') ?? la.get('energy_new') ?? 10;
        let light;
        if (lt === 1) { light = new THREE.DirectionalLight(col, Math.min(energy, 10) * 0.8); light.position.set(0, 0, 0); light.target.position.set(0, 0, -1); node.add(light.target); }
        else if (lt === 2) { light = new THREE.SpotLight(col, energy / (4 * Math.PI) * 0.6, 0, (la.get('spotsize') || 0.78) / 2, la.get('spotblend') || 0.15, 2); light.target.position.set(0, 0, -1); node.add(light.target); }
        else { light = new THREE.PointLight(col, energy / (4 * Math.PI) * 0.6, 0, 2); }
        light.name = node.name + '_light';
        node.add(light);
        camLights.push(light);
      }
    }
  }

  // meshes
  for (const entry of meshTasks) {
    const { ob, node } = entry;
    const me = ob.deref('data', 'Mesh');
    if (!me) continue;
    let md;
    try { md = readMeshData(bf, me); } catch (e) { warnings.push(`Mesh ${me.idName()}: ${e.message}`); continue; }
    if (!md.positions || !md.faceOffsets || !md.cornerVerts) { warnings.push(`Mesh ${me.idName()}: no face data`); continue; }
    const totcol = Math.max(me.get('totcol') || 0, ob.get('totcol') || 0);
    md.matCount = totcol;
    const sk = readShapeKeys(bf, me, me.get('totvert'));
    if (sk && sk.blocks.length) md.morphs = sk.blocks.map((b) => ({ name: b.name, value: b.value, data: b.data }));
    // modifiers
    let armMod = null;
    for (const mod of bf.listBase(ob.get('modifiers'), 'ModifierData')) {
      const mt = mod.get('type');
      const enabled = (mod.get('mode') || 0) & 1; // eModifierMode_Realtime
      if (!enabled && mt !== MOD_ARMATURE) continue;
      if (mt === MOD_MIRROR) {
        const mdef = bf.structDef('MirrorModifierData');
        if (mdef) md = applyMirror(md, new StructView(bf, mod.offset, mdef, mod.scope));
      } else if (mt === MOD_ARMATURE) {
        const adef = bf.structDef('ArmatureModifierData');
        const armOb = adef ? new StructView(bf, mod.offset, adef, mod.scope).deref('object') : null;
        if (armOb) armMod = armatures.get(armOb.offset);
      } else if (mt === MOD_SUBSURF) {
        const sdef = bf.structDef('SubsurfModifierData');
        const sv = sdef ? new StructView(bf, mod.offset, sdef, mod.scope) : null;
        const levels = Math.min(sv ? sv.get('levels') ?? 1 : 1, opts.maxSubdivLevels ?? 2);
        if (levels > 0) md = subdivide(md, levels, opts.maxSubdivFaces || 400000, true);
      }
    }
    md.matCount = totcol;
    const geo = buildGeometry(md);
    if (!geo) continue;
    // materials
    const matPtrs = new Array(totcol).fill(0n);
    const meMats = bf.pointerArray(me.ptr('mat'), me.get('totcol') || 0, me.scope);
    const obMats = bf.pointerArray(ob.ptr('mat'), ob.get('totcol') || 0, ob.scope);
    const matbitsB = ob.block('matbits');
    for (let i = 0; i < totcol; i++) {
      const useOb = matbitsB && i < matbitsB.size && bf.u8[matbitsB.offset + i];
      matPtrs[i] = (useOb ? obMats[i] : meMats[i]) || meMats[i] || obMats[i] || 0n;
    }
    const mats = [];
    for (let i = 0; i < Math.max(1, totcol); i++) {
      const mv = matPtrs[i] ? bf.viewAtPtr(matPtrs[i], 'Material') : null;
      let m = mv ? await convertMaterial(mv) : null;
      if (!m) m = new THREE.MeshStandardMaterial({ color: 0xcccccc, roughness: 0.6, name: 'Default' });
      mats.push(m);
    }
    // shape keys (already carried through mirror / subdivision)
    const srcVert = geo.userData.srcVert;
    if (md.morphs && md.morphs.length) {
      geo.morphAttributes.position = md.morphs.map((m) => {
        const arr = new Float32Array(srcVert.length * 3);
        for (let i = 0; i < srcVert.length; i++) { const v = srcVert[i] * 3; arr[i * 3] = m.data[v]; arr[i * 3 + 1] = m.data[v + 1]; arr[i * 3 + 2] = m.data[v + 2]; }
        const a = new THREE.BufferAttribute(arr, 3);
        a.name = m.name;
        return a;
      });
      geo.morphTargetsRelative = false;
    }
    let mesh;
    const useMulti = totcol > 1 && geo.groups.length > 0;
    if (armMod && md.dverts) {
      const vgNames = vertexGroupNames(bf, me, ob);
      const boneList = armMod.boneList.slice();
      let staticBone = null;
      const skinIndex = new Uint16Array(srcVert.length * 4);
      const skinWeight = new Float32Array(srcVert.length * 4);
      const nameToIdx = new Map(boneList.map((b, i) => [b.name, i]));
      for (let i = 0; i < srcVert.length; i++) {
        const list = (md.dverts[srcVert[i]] || []).map(([g, w]) => [nameToIdx.get(g < 0 ? flipSideName(vgNames[-g - 1] || '') : vgNames[g]), w]).filter(([bi, w]) => bi !== undefined && w > 0);
        list.sort((a, b) => b[1] - a[1]);
        let sum = 0;
        for (let k = 0; k < Math.min(4, list.length); k++) sum += list[k][1];
        if (sum <= 0) {
          if (!staticBone) { staticBone = new THREE.Bone(); staticBone.name = '__static'; armMod.node.add(staticBone); boneList.push(staticBone); }
          skinIndex[i * 4] = boneList.length - 1; skinWeight[i * 4] = 1;
          continue;
        }
        for (let k = 0; k < Math.min(4, list.length); k++) { skinIndex[i * 4 + k] = list[k][0]; skinWeight[i * 4 + k] = list[k][1] / sum; }
      }
      geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndex, 4));
      geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeight, 4));
      mesh = new THREE.SkinnedMesh(geo, useMulti ? mats : mats[0]);
      mesh.userData.pendingSkeleton = boneList;
      pending.push(mesh);
    } else {
      mesh = new THREE.Mesh(geo, useMulti ? mats : mats[0]);
    }
    delete geo.userData.srcVert;
    mesh.name = me.idName();
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    if (sk && sk.blocks.length) {
      mesh.updateMorphTargets();
      sk.blocks.forEach((kb, i) => { mesh.morphTargetInfluences[i] = kb.value; });
      mesh.userData.shapeKeyNames = sk.blocks.map((b) => b.name);
      mesh.userData.keyView = sk.keyView;
    }
    node.add(mesh);
    entry.mesh = mesh;
  }

  // bind skins at rest pose, then apply stored pose
  root.updateMatrixWorld(true);
  for (const mesh of pending) {
    const bones = mesh.userData.pendingSkeleton;
    delete mesh.userData.pendingSkeleton;
    const skeleton = new THREE.Skeleton(bones);
    mesh.bind(skeleton, mesh.matrixWorld);
  }
  const unsupportedCons = new Set();
  for (const arm of armatures.values()) {
    if (!arm.pose) continue;
    const armUnsupported = new Set();
    for (const pc of bf.listBase(arm.pose.get('chanbase'), 'bPoseChannel')) {
      const b = arm.bones.get(pc.str('name'));
      const rest = arm.restInfo.get(pc.str('name'));
      if (!b || !rest) continue;
      const loc = pc.get('loc') || [0, 0, 0];
      const q = rotationFromMode(pc.get('rotmode') ?? 0, pc.get('eul') || [0, 0, 0], pc.get('quat') || [1, 0, 0, 0], pc.get('rotAxis') || [0, 1, 0], pc.get('rotAngle') || 0);
      const s = pc.get('size') || [1, 1, 1];
      b.position.copy(new THREE.Vector3(...loc).applyQuaternion(rest.quat).add(rest.pos));
      b.quaternion.copy(rest.quat).multiply(q);
      b.scale.set(s[0], s[1], s[2]);
      b.userData.blendRotmode = pc.get('rotmode') ?? 0;
      const cons = readConstraints(bf, pc, armUnsupported);
      if (cons.length) {
        b.userData.constraints = cons;
        arm.hasConstraints = true;
      }
      const ikflag = pc.get('ikflag') || 0;
      if (ikflag) {
        b.userData.ik = {
          lock: [!!(ikflag & 1), !!(ikflag & 2), !!(ikflag & 4)],
          limit: [!!(ikflag & 8), !!(ikflag & 16), !!(ikflag & 32)],
          min: pc.get('limitmin') || [0, 0, 0],
          max: pc.get('limitmax') || [0, 0, 0],
        };
      }
    }
    // rest pose per bone, needed to evaluate constraints later
    if (arm.hasConstraints) {
      for (const [name, r] of arm.restInfo) {
        const b = arm.bones.get(name);
        if (b) b.userData.rest = { p: r.pos.toArray(), q: r.quat.toArray(), len: r.length };
      }
      arm.node.userData.constraintArmature = true;
    }
    if (armUnsupported.size) {
      // can't reproduce this rig's behaviour: pose the deforming bones directly instead
      arm.node.userData.constraintsIncomplete = [...armUnsupported];
      for (const u of armUnsupported) unsupportedCons.add(u);
    }
  }
  if (unsupportedCons.size) warnings.push(`This rig uses bone constraints WebBlend can't run (${[...unsupportedCons].join(', ')}), so its control bones are off. You can still pose the bones that move the mesh.`);

  // ---------- animations
  const animations = [];
  const actionsUsed = new Map(); // action offset -> clip
  const allActions = bf.idBlocks('AC').map((b) => bf.view(b));

  const buildClip = (ac, slotHandle, target) => {
    const fcs = actionFCurves(bf, ac, slotHandle);
    if (!fcs.length) return null;
    // group: key = targetId|prop
    const groups = new Map();
    let minF = Infinity, maxF = -Infinity;
    for (const fc of fcs) {
      if (!fc.keys.length) continue;
      minF = Math.min(minF, fc.keys[0].x);
      maxF = Math.max(maxF, fc.keys[fc.keys.length - 1].x);
      let m = fc.path.match(/^pose\.bones\["(.+?)"\]\.(location|rotation_euler|rotation_quaternion|rotation_axis_angle|scale)$/);
      let gk;
      if (m) gk = 'bone|' + m[1] + '|' + m[2];
      else if ((m = fc.path.match(/^(location|rotation_euler|rotation_quaternion|scale)$/))) gk = 'obj||' + m[1];
      else if ((m = fc.path.match(/^key_blocks\["(.+?)"\]\.value$/))) gk = 'key|' + m[1] + '|value';
      else continue;
      let g = groups.get(gk);
      if (!g) groups.set(gk, (g = []));
      g[fc.index] = fc;
    }
    if (!groups.size || !isFinite(minF)) return null;
    const frames = [];
    const step = maxF - minF > 2000 ? Math.ceil((maxF - minF) / 2000) : 1;
    for (let f = minF; f <= maxF + 1e-6; f += step) frames.push(f);
    if (frames[frames.length - 1] < maxF) frames.push(maxF);
    const times = frames.map((f) => (f - minF) / fps);
    const tracks = [];
    const ev = (g, i, f, def) => (g[i] ? evalFCurve(g[i], f) : def);
    for (const [gk, g] of groups) {
      const [kind, tname, prop] = gk.split('|');
      if (kind === 'bone') {
        const arm = target.arm;
        if (!arm) continue;
        const b = arm.bones.get(tname), rest = arm.restInfo.get(tname);
        if (!b || !rest) continue;
        if (prop === 'location') {
          const vals = new Float32Array(frames.length * 3);
          const v = new THREE.Vector3();
          frames.forEach((f, i) => {
            v.set(ev(g, 0, f, 0), ev(g, 1, f, 0), ev(g, 2, f, 0)).applyQuaternion(rest.quat).add(rest.pos);
            v.toArray(vals, i * 3);
          });
          tracks.push(new THREE.VectorKeyframeTrack(b.uuid + '.position', times, vals));
        } else if (prop === 'scale') {
          const vals = new Float32Array(frames.length * 3);
          frames.forEach((f, i) => { vals[i * 3] = ev(g, 0, f, 1); vals[i * 3 + 1] = ev(g, 1, f, 1); vals[i * 3 + 2] = ev(g, 2, f, 1); });
          tracks.push(new THREE.VectorKeyframeTrack(b.uuid + '.scale', times, vals));
        } else {
          const vals = new Float32Array(frames.length * 4);
          const rotmode = b.userData.blendRotmode ?? (prop === 'rotation_quaternion' ? 0 : 1);
          frames.forEach((f, i) => {
            let q;
            if (prop === 'rotation_quaternion') q = rotationFromMode(0, null, [ev(g, 0, f, 1), ev(g, 1, f, 0), ev(g, 2, f, 0), ev(g, 3, f, 0)]);
            else if (prop === 'rotation_axis_angle') q = rotationFromMode(-1, null, null, [ev(g, 1, f, 0), ev(g, 2, f, 1), ev(g, 3, f, 0)], ev(g, 0, f, 0));
            else q = rotationFromMode(rotmode > 0 ? rotmode : 1, [ev(g, 0, f, 0), ev(g, 1, f, 0), ev(g, 2, f, 0)]);
            const out = rest.quat.clone().multiply(q);
            if (i > 0) { // keep shortest path
              const pv = new THREE.Quaternion().fromArray(vals, (i - 1) * 4);
              if (pv.dot(out) < 0) out.set(-out.x, -out.y, -out.z, -out.w);
            }
            out.toArray(vals, i * 4);
          });
          tracks.push(new THREE.QuaternionKeyframeTrack(b.uuid + '.quaternion', times, vals));
        }
      } else if (kind === 'obj') {
        const node = target.node;
        if (!node) continue;
        if (prop === 'location') {
          const vals = new Float32Array(frames.length * 3);
          frames.forEach((f, i) => { vals[i * 3] = ev(g, 0, f, node.position.x); vals[i * 3 + 1] = ev(g, 1, f, node.position.y); vals[i * 3 + 2] = ev(g, 2, f, node.position.z); });
          tracks.push(new THREE.VectorKeyframeTrack(node.uuid + '.position', times, vals));
        } else if (prop === 'scale') {
          const vals = new Float32Array(frames.length * 3);
          frames.forEach((f, i) => { vals[i * 3] = ev(g, 0, f, node.scale.x); vals[i * 3 + 1] = ev(g, 1, f, node.scale.y); vals[i * 3 + 2] = ev(g, 2, f, node.scale.z); });
          tracks.push(new THREE.VectorKeyframeTrack(node.uuid + '.scale', times, vals));
        } else {
          const rotmode = node.userData.blend?.rotmode ?? 1;
          const vals = new Float32Array(frames.length * 4);
          const e0 = new THREE.Euler().setFromQuaternion(node.quaternion, EULER_ORDERS[rotmode] || 'ZYX');
          frames.forEach((f, i) => {
            let q;
            if (prop === 'rotation_quaternion') q = rotationFromMode(0, null, [ev(g, 0, f, 1), ev(g, 1, f, 0), ev(g, 2, f, 0), ev(g, 3, f, 0)]);
            else q = rotationFromMode(rotmode > 0 ? rotmode : 1, [ev(g, 0, f, e0.x), ev(g, 1, f, e0.y), ev(g, 2, f, e0.z)]);
            if (i > 0) { const pv = new THREE.Quaternion().fromArray(vals, (i - 1) * 4); if (pv.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); }
            q.toArray(vals, i * 4);
          });
          tracks.push(new THREE.QuaternionKeyframeTrack(node.uuid + '.quaternion', times, vals));
        }
      } else if (kind === 'key') {
        for (const mesh of target.meshes || []) {
          const idx = (mesh.userData.shapeKeyNames || []).indexOf(tname);
          if (idx < 0) continue;
          const vals = new Float32Array(frames.length);
          frames.forEach((f, i) => { vals[i] = ev(g, 0, f, 0); });
          tracks.push(new THREE.NumberKeyframeTrack(mesh.uuid + '.morphTargetInfluences[' + idx + ']', times, vals));
        }
      }
    }
    if (!tracks.length) return null;
    return new THREE.AnimationClip(ac.idName(), times[times.length - 1] || 0, tracks);
  };

  const meshesByKey = new Map();
  for (const entry of meshTasks) {
    if (entry.mesh && entry.mesh.userData.keyView) {
      const k = entry.mesh.userData.keyView.offset;
      if (!meshesByKey.has(k)) meshesByKey.set(k, []);
      meshesByKey.get(k).push(entry.mesh);
      delete entry.mesh.userData.keyView;
    }
  }

  // actions assigned through AnimData
  const merged = new Map(); // clip name -> tracks (merge object + bone anims sharing an action name)
  const addClip = (clip) => {
    if (!clip) return;
    const ex = merged.get(clip.name);
    if (ex) { ex.tracks.push(...clip.tracks); ex.duration = Math.max(ex.duration, clip.duration); }
    else merged.set(clip.name, clip);
  };
  for (const entry of nodes.values()) {
    const adt = entry.ob.deref('adt', 'AnimData');
    if (!adt) continue;
    const ac = adt.deref('action', 'bAction');
    if (!ac) continue;
    const slot = adt.any(['slot_handle', 'binding_handle'], 0);
    const clip = buildClip(ac, slot, { node: entry.node, arm: armatures.get(entry.ob.offset) });
    actionsUsed.set(ac.offset, true);
    addClip(clip);
  }
  // shape key actions
  for (const [koff, meshes] of meshesByKey) {
    const kb = bf.blocks.find((b) => b.offset === koff);
    const key = kb ? bf.view(kb) : null;
    const adt = key ? key.deref('adt', 'AnimData') : null;
    const ac = adt ? adt.deref('action', 'bAction') : null;
    if (!ac) continue;
    actionsUsed.set(ac.offset, true);
    addClip(buildClip(ac, adt.any(['slot_handle', 'binding_handle'], 0), { meshes }));
  }
  // unassigned actions (e.g. stored with fake user): try on first armature
  const firstArm = [...armatures.values()][0];
  for (const ac of allActions) {
    if (actionsUsed.has(ac.offset)) continue;
    const clip = firstArm ? buildClip(ac, -1, { arm: firstArm, node: firstArm.node }) : null;
    if (clip) addClip(clip);
  }
  for (const c of merged.values()) { c.resetDuration?.(); animations.push(c); }

  // Hidden objects: hide what they draw, not the node, because in Blender
  // hiding a parent (e.g. the armature) doesn't hide its children.
  let hiddenCount = 0;
  for (const e of nodes.values()) {
    if (!e.hidden) continue;
    hiddenCount++;
    e.node.userData.hiddenInFile = true;
    for (const c of e.node.children) if (c.isMesh || c.isCamera || c.isLight || c.isPoints || c.isLine) c.visible = false;
  }

  root.updateMatrixWorld(true);
  const info = {
    version: (bf.version / 100).toFixed(2),
    objects: nodes.size,
    hidden: hiddenCount,
    meshes: meshTasks.filter((e) => e.mesh).length,
    armatures: armatures.size,
    actions: animations.length,
    fps,
  };
  return { scene: root, animations, warnings, info };
}

// ---------------------------------------------------------------- bone constraints

const CON_TYPES = {
  2: ['TRACK_TO', 'bTrackToConstraint'], 3: ['IK', 'bKinematicConstraint'], 5: ['LIMIT_ROTATION', 'bRotLimitConstraint'],
  8: ['COPY_ROTATION', 'bRotateLikeConstraint'], 9: ['COPY_LOCATION', 'bLocateLikeConstraint'], 10: ['COPY_SCALE', 'bSizeLikeConstraint'],
  13: ['LOCKED_TRACK', 'bLockTrackConstraint'], 15: ['STRETCH_TO', 'bStretchToConstraint'], 21: ['DAMPED_TRACK', 'bDampTrackConstraint'],
  23: ['COPY_TRANSFORMS', 'bTransLikeConstraint'],
};
const CON_NAMES = { 1: 'Child Of', 4: 'Follow Path', 6: 'Limit Location', 7: 'Limit Scale', 11: 'Python', 12: 'Action', 14: 'Limit Distance', 16: 'Floor', 18: 'Clamp To', 19: 'Transformation', 20: 'Shrinkwrap', 22: 'Spline IK', 24: 'Maintain Volume', 25: 'Pivot', 30: 'Armature' };
const CON_SPACE = { 0: 'WORLD', 1: 'LOCAL', 2: 'POSE', 3: 'LOCAL_WITH_PARENT', 4: 'POSE', 5: 'WORLD', 6: 'LOCAL' };

// Plain-data description of a pose bone's constraints (stored in bone.userData).
function readConstraints(bf, pc, unsupported) {
  const out = [];
  for (const c of bf.listBase(pc.get('constraints'), 'bConstraint')) {
    const t = c.get('type');
    const flag = c.get('flag') || 0;
    if (flag & (512 | 4)) continue; // muted or invalid
    const def = CON_TYPES[t];
    if (!def) { if (CON_NAMES[t]) unsupported.add(CON_NAMES[t]); continue; }
    const [type, structName] = def;
    const d = bf.viewAtPtr(c.ptr('data'), structName, c.scope);
    if (!d) continue;
    const tar = d.deref('tar', 'Object');
    const con = {
      type,
      name: c.str('name'),
      influence: c.get('enforce') ?? 1,
      ownerSpace: CON_SPACE[c.get('ownspace')] || 'WORLD',
      targetSpace: CON_SPACE[c.get('tarspace')] || 'WORLD',
      headTail: c.get('headtail') || 0,
      target: tar ? tar.idName() : '',
      subtarget: d.str('subtarget'),
    };
    if (type === 'COPY_ROTATION' || type === 'COPY_LOCATION' || type === 'COPY_SCALE' || type === 'COPY_TRANSFORMS') {
      con.flag = d.get('flag') || 0;
      con.mix = d.get('mix_mode') || 0;
      con.eulerOrder = d.get('euler_order') || 0;
    } else if (type === 'IK') {
      const ik = d.get('flag') || 0;
      con.chain = d.get('rootbone') || 0;
      con.useTail = !!(ik & 1);
      con.iterations = d.get('iterations') || 500;
      const pole = d.deref('poletar', 'Object');
      con.pole = pole ? pole.idName() : '';
      con.poleSub = d.str('polesubtarget');
      con.poleAngle = d.get('poleangle') || 0;
      if (!con.target) continue; // IK without target (auto IK) does nothing on its own
    } else if (type === 'LIMIT_ROTATION') {
      con.flag = d.get('flag') || 0;
      con.min = [d.get('xmin') || 0, d.get('ymin') || 0, d.get('zmin') || 0];
      con.max = [d.get('xmax') || 0, d.get('ymax') || 0, d.get('zmax') || 0];
      con.eulerOrder = d.get('euler_order') || 0;
    } else if (type === 'DAMPED_TRACK' || type === 'LOCKED_TRACK') {
      con.track = d.get('trackflag') ?? 1;
    } else if (type === 'TRACK_TO') {
      con.track = d.get('reserved1') ?? 1;
    } else if (type === 'STRETCH_TO') {
      con.restLength = d.get('orglength') || 0;
    }
    if (type !== 'LIMIT_ROTATION' && !con.target) continue;
    out.push(con);
  }
  return out;
}

// ---------------------------------------------------------------- scene / visibility

// Which objects belong to the current scene, and which of those Blender hides
// in the viewport (hidden object, hidden or excluded collection, "H" hide).
function sceneVisibility(bf) {
  const globB = bf.blocks.find((b) => b.code === 'GLOB');
  const gdef = bf.structDef('FileGlobal');
  const glob = globB && gdef ? new StructView(bf, globB.offset, gdef, globB) : null;
  let sce = glob ? glob.deref('curscene', 'Scene') : null;
  if (!sce) { const sb = bf.idBlocks('SC')[0]; sce = sb ? bf.view(sb) : null; }
  if (!sce) return null;
  const master = sce.deref('master_collection', 'Collection');
  if (!master) return null; // files from before 2.8
  const inScene = new Set();
  const seenCol = new Set();
  const walkCol = (c) => {
    if (!c || seenCol.has(c.offset)) return;
    seenCol.add(c.offset);
    for (const co of bf.listBase(c.get('gobject'), 'CollectionObject')) { const ob = co.deref('ob', 'Object'); if (ob) inScene.add(ob.offset); }
    for (const ch of bf.listBase(c.get('children'), 'CollectionChild')) walkCol(ch.deref('collection', 'Collection'));
  };
  walkCol(master);
  if (!inScene.size) return null;
  const layers = [...bf.listBase(sce.get('view_layers'), 'ViewLayer')];
  let vl = glob ? glob.deref('cur_view_layer', 'ViewLayer') : null;
  if (!vl || !layers.some((l) => l.offset === vl.offset)) vl = layers[0] || null;
  const visibleCol = new Set();
  const baseFlag = new Map();
  if (vl) {
    const walkLC = (lb, parentHidden, depth) => {
      if (depth > 64) return;
      for (const lc of bf.listBase(lb, 'LayerCollection')) {
        const flag = lc.get('flag') || 0;
        if (flag & 16) continue; // excluded (checkbox off)
        const c = lc.deref('collection', 'Collection');
        const hidden = parentHidden || !!(flag & 128) || !!(c && (c.get('flag') || 0) & 1);
        if (!hidden && c) for (const co of bf.listBase(c.get('gobject'), 'CollectionObject')) { const ob = co.deref('ob', 'Object'); if (ob) visibleCol.add(ob.offset); }
        walkLC(lc.get('layer_collections'), hidden, depth + 1);
      }
    };
    walkLC(vl.get('layer_collections'), false, 0);
    for (const b of bf.listBase(vl.get('object_bases'), 'Base')) { const ob = b.deref('object', 'Object'); if (ob) baseFlag.set(ob.offset, b.get('flag') || 0); }
  }
  return { inScene, isHidden: (ob) => {
    const r = ob.get('restrictflag') || 0;
    if (r & 1 || r & 4) return true; // hidden in viewport / disabled in renders
    if (vl && !visibleCol.has(ob.offset)) return true;
    if ((baseFlag.get(ob.offset) || 0) & 256) return true;
    return false;
  } };
}

// ---------------------------------------------------------------- nodes

// Texture names that are clearly not the base color (MMD toon/sphere maps,
// PBR helper maps...) and names that clearly are.
const NOT_COLOR = /toon|sphere|\bsp[ah]\b|\.sp[ah]\b|normal|\bnrm\b|_n\b|_nm\b|bump|rough|metal|spec|gloss|occlu|\bao\b|_ao\b|mask|height|disp|emis|matcap|ramp|shadow|\blut\b|rim|cavity|curvature|detail|noise|orm\b|_mra\b|_rma\b/i;
const IS_COLOR = /base|diffuse|albedo|colou?r|\bcol\b|_col\b|main|_d\b|_c\b|_bc\b|_alb\b|\btex\b|_tex\b|skin|body|face|hair|cloth/i;
const NODE_DO_OUTPUT = 64;

// Reads a material's node tree (following links into node groups) and fills
// in a three.js material: base color + texture, alpha, metal/rough, normal map, emission.
async function applyNodeTree(bf, nt, mat, getImageTexture, maView) {
  const graphs = new Map();
  const graph = (tree) => {
    if (!tree) return null;
    if (graphs.has(tree.offset)) return graphs.get(tree.offset);
    const g = { tree, nodes: [], byOffset: new Map(), linkTo: new Map(), groupOut: null };
    graphs.set(tree.offset, g);
    for (const n of bf.listBase(tree.get('nodes'), 'bNode')) {
      const info = { n, idname: n.str('idname'), name: n.str('name'), label: n.str('label'), flag: n.get('flag') || 0, inputs: [...bf.listBase(n.get('inputs'), 'bNodeSocket')], outputs: [...bf.listBase(n.get('outputs'), 'bNodeSocket')] };
      g.nodes.push(info);
      g.byOffset.set(n.offset, info);
    }
    for (const l of bf.listBase(tree.get('links'), 'bNodeLink')) {
      if ((l.get('flag') || 0) & 16) continue; // muted link
      const ts = l.deref('tosock', 'bNodeSocket');
      if (ts) g.linkTo.set(ts.offset, l);
    }
    const outs = g.nodes.filter((x) => x.idname === 'NodeGroupOutput');
    g.groupOut = outs.find((x) => x.flag & NODE_DO_OUTPUT) || outs[0] || null;
    return g;
  };
  const sockName = (s) => s.str('name') || s.str('identifier');
  const sameSock = (list, s) => {
    const id = s.str('identifier'), nm = sockName(s);
    return list.find((x) => x.str('identifier') === id) || list.find((x) => sockName(x) === nm) || null;
  };
  const input = (info, ...names) => {
    for (const name of names) {
      const s = info.inputs.find((x) => sockName(x) === name || x.str('identifier') === name);
      if (s) return s;
    }
    return null;
  };
  const defaultValue = (s) => {
    const dv = s && s.deref('default_value');
    return dv ? dv.get('value') : null;
  };
  const isGroupNode = (info) => /NodeGroup$|^ShaderNodeCustomGroup$/.test(info.idname) && info.n.ptr('id');

  // Follow a socket upstream through reroutes and group boundaries.
  // -> { node: {g, info, outSock, stack}, names } | { sock (unlinked), names } | null
  const trace = (g, sock, stack = [], names = [], depth = 0) => {
    if (!g || !sock || depth > 64) return null;
    const l = g.linkTo.get(sock.offset);
    if (!l) return { sock, names };
    const fn = l.deref('fromnode', 'bNode');
    const fs = l.deref('fromsock', 'bNodeSocket');
    const info = fn && g.byOffset.get(fn.offset);
    if (!info || !fs) return null;
    if (info.idname === 'NodeReroute') return trace(g, info.inputs[0], stack, names, depth + 1);
    if (info.flag & 512 && info.inputs[0]) return trace(g, info.inputs[0], stack, names, depth + 1); // muted node passes through
    if (info.idname === 'NodeGroupInput') {
      if (!stack.length) return { sock: null, names };
      const { g: pg, info: gnode } = stack[stack.length - 1];
      const outer = sameSock(gnode.inputs, fs);
      if (!outer) return null;
      return trace(pg, outer, stack.slice(0, -1), [...names, sockName(outer)], depth + 1);
    }
    if (isGroupNode(info)) {
      const sub = graph(info.n.deref('id', 'bNodeTree'));
      const inner = sub && sub.groupOut && sameSock(sub.groupOut.inputs, fs);
      if (!inner) return null;
      return trace(sub, inner, [...stack, { g, info }], [...names, info.name, info.label, sockName(fs)], depth + 1);
    }
    return { node: { g, info, outSock: fs, stack }, names };
  };
  const valueOf = (g, sock, stack) => {
    const t = trace(g, sock, stack);
    return t && t.sock ? defaultValue(t.sock) : (t && !t.node ? null : undefined);
  };

  // all image textures feeding a socket, with the names seen on the way
  const imagesFeeding = (g, sock, stack, out = [], path = [], depth = 0, seen = new Set()) => {
    if (depth > 10) return out;
    const t = trace(g, sock, stack);
    if (!t || !t.node) return out;
    const { info } = t.node;
    const key = t.node.g.tree.offset + ':' + info.n.offset + ':' + t.node.stack.length;
    if (seen.has(key)) return out;
    seen.add(key);
    const names = [...path, ...t.names];
    if (info.idname === 'ShaderNodeTexImage') {
      const image = info.n.deref('id');
      if (image) out.push({ image, info, outName: sockName(t.node.outSock), names, depth });
      return out;
    }
    for (const s of info.inputs) {
      if (s.str('identifier') === 'Vector' || sockName(s) === 'Vector') continue;
      imagesFeeding(t.node.g, s, t.node.stack, out, [...names, sockName(s)], depth + 1, seen);
    }
    return out;
  };
  const imageText = (c) => [c.info.name, c.info.label, c.image.idName(), c.image.str('filepath') || c.image.str('name'), ...c.names].join(' ');
  const nonColor = (image) => {
    const cs = image.get('colorspace_settings');
    return !!cs && /non-?color|raw|linear data|generic data/i.test(cs.str('name'));
  };
  const scoreColor = (c) => {
    const text = imageText(c);
    let s = 0;
    if (NOT_COLOR.test(text)) s -= 10;
    if (IS_COLOR.test(text)) s += 4;
    if (c.outName === 'Alpha') s -= 6;
    if (nonColor(c.image)) s -= 8;
    return s - c.depth * 0.3;
  };
  const best = (cands, min) => {
    let top = null, ts = -Infinity;
    for (const c of cands) { const s = scoreColor(c); if (s > ts) { ts = s; top = c; } }
    return top && ts >= min ? top : null;
  };
  const textureFor = async (c, colorSpace) => {
    const tex = await getImageTexture(c.image, colorSpace);
    if (tex) {
      const st = bf.viewAtPtr(c.info.n.ptr('storage'), 'NodeTexImage', c.info.n.scope);
      const ext = st ? st.get('extension') ?? 0 : 0;
      const wrap = ext === 1 || ext === 2 ? THREE.ClampToEdgeWrapping : ext === 3 ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
      if (tex.wrapS !== wrap) { tex.wrapS = tex.wrapT = wrap; tex.needsUpdate = true; }
    }
    return tex;
  };

  // ----- find the surface shader
  const root = graph(nt);
  const outputs = root.nodes.filter((x) => x.idname === 'ShaderNodeOutputMaterial');
  const output = outputs.find((x) => x.flag & NODE_DO_OUTPUT) || outputs[0] || null;
  const SHADER = /Bsdf|Emission|Principled|EeveeSpecular|SubsurfaceScattering/;
  let alphaMix = null;
  const findShader = (g, sock, stack, depth = 0) => {
    if (depth > 12) return null;
    const t = trace(g, sock, stack);
    if (!t || !t.node) return null;
    const { info } = t.node;
    if (info.idname === 'ShaderNodeBsdfTransparent') return { transparent: true };
    if (SHADER.test(info.idname)) return t.node;
    if (info.idname === 'ShaderNodeMixShader' || info.idname === 'ShaderNodeAddShader') {
      const shaderIns = info.inputs.filter((s) => /^Shader/.test(s.str('identifier') || sockName(s)));
      const found = shaderIns.map((s) => findShader(t.node.g, s, t.node.stack, depth + 1));
      const ti = found.findIndex((f) => f && f.transparent);
      const real = found.find((f) => f && !f.transparent);
      if (ti >= 0 && real && info.idname === 'ShaderNodeMixShader') alphaMix = { g: t.node.g, stack: t.node.stack, fac: input(info, 'Fac', 'Factor'), transparentFirst: ti === 0 };
      return real || null;
    }
    // anything else (shader-to-RGB, custom nodes...): keep looking upstream
    for (const s of info.inputs) {
      const r = findShader(t.node.g, s, t.node.stack, depth + 1);
      if (r && !r.transparent) return r;
    }
    return null;
  };
  let bsdf = output ? findShader(root, input(output, 'Surface'), []) : null;
  if (!bsdf) {
    const p = root.nodes.find((x) => x.idname === 'ShaderNodeBsdfPrincipled') || root.nodes.find((x) => SHADER.test(x.idname));
    if (p) bsdf = { g: root, info: p, stack: [] };
  }

  // ----- base color
  let colorDone = false;
  if (bsdf) {
    const { g, info, stack } = bsdf;
    const colorSock = input(info, 'Base Color', 'Color', 'Diffuse Color');
    if (colorSock) {
      const v = valueOf(g, colorSock, stack);
      if (Array.isArray(v)) mat.color.setRGB(v[0], v[1], v[2]);
      const pick = best(imagesFeeding(g, colorSock, stack), -5);
      if (pick) {
        const tex = await textureFor(pick, THREE.SRGBColorSpace);
        if (tex) { mat.map = tex; mat.color.setRGB(1, 1, 1); colorDone = true; mat.userData.mapNode = pick.info; }
      }
    }
  }
  if (!colorDone) {
    // custom/toon shaders we can't follow: use the most color-like image anywhere in the material
    const all = [];
    const scan = (g, stack, depth) => {
      if (!g || depth > 4) return;
      for (const info of g.nodes) {
        if (info.idname === 'ShaderNodeTexImage') { const image = info.n.deref('id'); if (image) all.push({ image, info, outName: 'Color', names: [], depth }); }
        else if (isGroupNode(info)) scan(graph(info.n.deref('id', 'bNodeTree')), [...stack, { g, info }], depth + 1);
      }
    };
    scan(root, [], 0);
    const pick = best(all, all.length === 1 ? -4 : 0);
    if (pick) {
      const tex = await textureFor(pick, THREE.SRGBColorSpace);
      if (tex) { mat.map = tex; mat.color.setRGB(1, 1, 1); mat.userData.mapNode = pick.info; }
    }
  }
  if (!bsdf) return;
  const { g, info, stack } = bsdf;

  const num = (sock) => { const v = sock ? valueOf(g, sock, stack) : null; return typeof v === 'number' ? v : null; };
  const metal = num(input(info, 'Metallic'));
  if (metal !== null) mat.metalness = metal;
  const rough = num(input(info, 'Roughness'));
  if (rough !== null) mat.roughness = rough;
  if (info.idname === 'ShaderNodeBsdfDiffuse' || info.idname === 'ShaderNodeBsdfToon') { mat.metalness = 0; mat.roughness = Math.max(mat.roughness, 0.8); }

  // ----- alpha
  const blended = (maView.get('surface_render_method') === 1) || (maView.get('blend_method') === 5);
  const useImageAlpha = () => {
    if (blended) { mat.transparent = true; mat.alphaTest = 0.05; }
    else mat.alphaTest = 0.5;
  };
  const alphaSock = input(info, 'Alpha');
  if (alphaSock) {
    const t = trace(g, alphaSock, stack);
    if (t && t.node) {
      if (imagesFeeding(g, alphaSock, stack).length) useImageAlpha();
    } else {
      const v = t && t.sock ? defaultValue(t.sock) : null;
      if (typeof v === 'number' && v < 0.999) { mat.transparent = true; mat.opacity = v; mat.depthWrite = v > 0.5; }
    }
  }
  if (alphaMix && alphaMix.fac) {
    const t = trace(alphaMix.g, alphaMix.fac, alphaMix.stack);
    if (t && t.node) {
      if (imagesFeeding(alphaMix.g, alphaMix.fac, alphaMix.stack).length) useImageAlpha();
    } else {
      const f = t && t.sock ? defaultValue(t.sock) : null;
      if (typeof f === 'number') {
        const op = alphaMix.transparentFirst ? f : 1 - f;
        if (op < 0.999) { mat.transparent = true; mat.opacity = op; mat.depthWrite = op > 0.5; }
      }
    }
  }

  // ----- normal map
  const normal = input(info, 'Normal');
  if (normal) {
    const t = trace(g, normal, stack);
    if (t && t.node && t.node.info.idname === 'ShaderNodeNormalMap') {
      const nm = t.node;
      const imgs = imagesFeeding(nm.g, input(nm.info, 'Color'), nm.stack);
      if (imgs.length) {
        const tex = await textureFor(imgs[0], THREE.NoColorSpace);
        if (tex && tex !== mat.map) {
          mat.normalMap = tex;
          const strength = valueOf(nm.g, input(nm.info, 'Strength'), nm.stack);
          if (typeof strength === 'number') mat.normalScale.set(strength, strength);
        }
      }
    }
  }

  // ----- emission
  const emis = input(info, 'Emission Color', 'Emission');
  const emisStr = input(info, 'Emission Strength');
  const strength = emisStr ? num(emisStr) : 1;
  if (emis && typeof strength === 'number' && strength > 0) {
    const v = valueOf(g, emis, stack);
    if (Array.isArray(v) && (v[0] + v[1] + v[2]) > 0) { mat.emissive.setRGB(v[0], v[1], v[2]); mat.emissiveIntensity = strength; }
    const imgs = imagesFeeding(g, emis, stack);
    if (imgs.length) { const t = await textureFor(imgs[0], THREE.SRGBColorSpace); if (t) { mat.emissiveMap = t; mat.emissive.setRGB(1, 1, 1); mat.emissiveIntensity = strength; } }
  }
  if (info.idname === 'ShaderNodeEmission') {
    const c = valueOf(g, input(info, 'Color'), stack);
    const s = num(input(info, 'Strength'));
    if (Array.isArray(c)) { mat.emissive.setRGB(c[0], c[1], c[2]); mat.emissiveIntensity = s ?? 1; if (!mat.map) mat.color.setRGB(0, 0, 0); }
    if (mat.map && !mat.emissiveMap) { mat.emissiveMap = mat.map; mat.emissive.setRGB(1, 1, 1); }
  }
}
