// Per-vertex offsets added on the GPU right after skinning: the soft lips and the soft
// skin each write their own layer, and the layers are summed into one attribute per mesh.
import * as THREE from 'three';

export const ATTR = 'contactOffset';
export const NATTR = 'contactNormal';
const layersOf = new WeakMap(); // geometry -> Map(name -> layer)

// The mesh gets its own geometry (copies of the model share theirs) with a zeroed offset
// attribute, and its materials add the offset after skinning.
export function prepareMesh(mesh) {
  let g = mesh.geometry;
  if (g.userData.softOwner && g.userData.softOwner !== mesh.uuid) {
    g = mesh.geometry = g.clone();
    for (const n of [ATTR, NATTR]) if (g.attributes[n]) g.deleteAttribute(n);
  }
  g.userData.softOwner = mesh.uuid;
  for (const name of [ATTR, NATTR]) {
    if (g.attributes[name]) continue;
    const a = new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 3), 3);
    a.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute(name, a);
  }
  for (const m of [].concat(mesh.material)) patchMaterial(m);
  return g;
}

const PATCHED = new WeakSet();
export function patchMaterial(mat) {
  if (!mat || PATCHED.has(mat)) return;
  PATCHED.add(mat);
  const prev = mat.onBeforeCompile;
  const ownKey = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey') ? mat.customProgramCacheKey : null;
  const prevSrc = prev && prev !== THREE.Material.prototype.onBeforeCompile ? prev.toString() : '';
  mat.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    if (shader.vertexShader.includes('#include <skinning_vertex>') && !shader.vertexShader.includes(ATTR)) {
      let vs = `attribute vec3 ${ATTR};\nattribute vec3 ${NATTR};\n` + shader.vertexShader.replace('#include <skinning_vertex>', `#include <skinning_vertex>\n\ttransformed += ${ATTR};`);
      // the dent shows in the shading too: its normals bend with it
      if (vs.includes('#include <skinnormal_vertex>')) vs = vs.replace('#include <skinnormal_vertex>', `#include <skinnormal_vertex>\n\tobjectNormal = normalize( normalize( objectNormal ) + ${NATTR} );`);
      shader.vertexShader = vs;
    }
  };
  mat.customProgramCacheKey = function () { return (ownKey ? ownKey.call(this) : prevSrc) + '|softlips'; };
  // meshes sharing this material without the attribute read zeros
  mat.defaultAttributeValues = Object.assign({}, mat.defaultAttributeValues, { [ATTR]: [0, 0, 0], [NATTR]: [0, 0, 0] });
  mat.needsUpdate = true;
}

// a named layer of offsets on a mesh (mesh-local space); kind 'pos' moves vertices,
// 'nor' bends their normals
export function layer(mesh, name, kind = 'pos') {
  const g = mesh.geometry;
  let L = layersOf.get(g);
  if (!L) layersOf.set(g, (L = new Map()));
  const id = kind + ':' + name;
  let l = L.get(id);
  if (!l || l.a.length !== g.attributes.position.count * 3) {
    l = { a: new Float32Array(g.attributes.position.count * 3), lo: Infinity, hi: -1, plo: Infinity, phi: -1, kind };
    L.set(id, l);
  }
  return l;
}

// start rewriting a layer: what it covered before is cleared (and summed again on commit)
export function beginLayer(l) {
  if (l.hi >= l.lo) { l.a.fill(0, l.lo * 3, (l.hi + 1) * 3); l.plo = Math.min(l.plo, l.lo); l.phi = Math.max(l.phi, l.hi); }
  l.lo = Infinity; l.hi = -1;
}

export function setOffset(l, vi, x, y, z) {
  const k = vi * 3;
  l.a[k] = x; l.a[k + 1] = y; l.a[k + 2] = z;
  if (vi < l.lo) l.lo = vi;
  if (vi > l.hi) l.hi = vi;
}

// the layers -> the GPU attribute (only the part that changed)
export function commit(mesh) {
  const g = mesh.geometry;
  const L = layersOf.get(g);
  if (!L) return;
  for (const [kind, name] of [['pos', ATTR], ['nor', NATTR]]) {
    const at = g.attributes[name];
    if (!at) continue;
    let lo = Infinity, hi = -1;
    const ls = [...L.values()].filter((l) => l.kind === kind);
    for (const l of ls) { lo = Math.min(lo, l.lo, l.plo); hi = Math.max(hi, l.hi, l.phi); }
    if (hi < lo) continue;
    const arrs = ls.map((l) => l.a), n = arrs.length;
    const A = at.array;
    for (let k = lo * 3, e = (hi + 1) * 3; k < e; k++) { let s = 0; for (let j = 0; j < n; j++) s += arrs[j][k]; A[k] = s; }
    for (const l of ls) { l.plo = Infinity; l.phi = -1; }
    at.clearUpdateRanges?.();
    at.addUpdateRange?.(lo * 3, (hi - lo + 1) * 3);
    at.needsUpdate = true;
  }
}

// how the normals of a deformed patch bend: per vertex, the (unit) normal of its triangles
// with the offsets minus without them. tris: welded vertex ids (3 per triangle), triStart /
// triOf: the triangles around each vertex; P: positions; D: offsets (same space)
export function normalDeltas(list, tris, triStart, triOf, P, D, out) {
  for (const w of list) {
    let ax = 0, ay = 0, az = 0, bx = 0, by = 0, bz = 0;
    for (let k = triStart[w]; k < triStart[w + 1]; k++) {
      const t = triOf[k] * 3, i = tris[t] * 3, j = tris[t + 1] * 3, m = tris[t + 2] * 3;
      let ux = P[j] - P[i], uy = P[j + 1] - P[i + 1], uz = P[j + 2] - P[i + 2], vx = P[m] - P[i], vy = P[m + 1] - P[i + 1], vz = P[m + 2] - P[i + 2];
      ax += uy * vz - uz * vy; ay += uz * vx - ux * vz; az += ux * vy - uy * vx;
      ux += D[j] - D[i]; uy += D[j + 1] - D[i + 1]; uz += D[j + 2] - D[i + 2];
      vx += D[m] - D[i]; vy += D[m + 1] - D[i + 1]; vz += D[m + 2] - D[i + 2];
      bx += uy * vz - uz * vy; by += uz * vx - ux * vz; bz += ux * vy - uy * vx;
    }
    const al = Math.hypot(ax, ay, az), bl = Math.hypot(bx, by, bz);
    if (!(al > 0) || !(bl > 0)) { out[w * 3] = out[w * 3 + 1] = out[w * 3 + 2] = 0; continue; }
    out[w * 3] = bx / bl - ax / al; out[w * 3 + 1] = by / bl - ay / al; out[w * 3 + 2] = bz / bl - az / al;
  }
}

// triangles of meshes as welded vertex ids, and the triangles around each vertex
// (map(mesh) -> Int32Array vertex index -> welded id or -1)
export function weldedTriangles(meshes, mapOf, N) {
  const tris = [];
  for (const m of meshes) {
    const map = mapOf(m);
    const ix = m.geometry.index;
    const cnt = ix ? ix.count : m.geometry.attributes.position.count;
    for (let t = 0; t + 2 < cnt; t += 3) {
      const a = map[ix ? ix.getX(t) : t], b = map[ix ? ix.getX(t + 1) : t + 1], c = map[ix ? ix.getX(t + 2) : t + 2];
      if (a >= 0 && b >= 0 && c >= 0 && a !== b && b !== c && a !== c) tris.push(a, b, c);
    }
  }
  const T = Int32Array.from(tris);
  const count = new Int32Array(N + 1);
  for (let k = 0; k < T.length; k++) count[T[k] + 1]++;
  for (let i = 0; i < N; i++) count[i + 1] += count[i];
  const at = count.slice(0, N), of = new Int32Array(T.length);
  for (let k = 0; k < T.length; k++) of[at[T[k]]++] = (k / 3) | 0;
  return { tris: T, triStart: count, triOf: of };
}

// the GLB writer leaves the live offsets out of the file
export function detachOffsets(models) {
  const back = [];
  for (const m of models) m.root.traverse((o) => { const g = o.geometry; if (!g || !g.attributes) return; for (const n of [ATTR, NATTR]) if (g.attributes[n]) { back.push([g, n, g.attributes[n]]); g.deleteAttribute(n); } });
  return () => { for (const [g, n, a] of back) g.setAttribute(n, a); };
}
