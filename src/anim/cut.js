// Deleting body parts: the skin a bone moves (and everything under it) is cut out of the
// character's meshes, keeping each material's triangles in their own group. Undoable: the
// old triangle lists are kept and put back.
import * as THREE from 'three';

function dominant(si, sw, i) {
  let bi = 0, bw = -1;
  for (let k = 0; k < 4; k++) { const w = sw.getComponent(i, k); if (w > bw) { bw = w; bi = si.getComponent(i, k); } }
  return bi;
}

// -> { removed (triangles), undo(), redo() } or null when nothing follows those bones
export function cutBoneParts(model, bones) {
  const targets = new Set();
  for (const b of bones) b.traverse((o) => { if (o.isBone) targets.add(o); });
  const edits = [];
  let removed = 0;
  for (const s of model.skinned || []) {
    const g = s.geometry, si = g.attributes.skinIndex, sw = g.attributes.skinWeight;
    if (!si || !sw || !s.skeleton) continue;
    const inSet = s.skeleton.bones.map((b) => targets.has(b));
    if (!inSet.some(Boolean)) continue;
    const n = g.attributes.position.count;
    const cut = new Uint8Array(n);
    let any = false;
    for (let i = 0; i < n; i++) if (inSet[dominant(si, sw, i)]) { cut[i] = 1; any = true; }
    if (!any) continue;
    const idx = g.index ? g.index.array : null;
    const total = idx ? idx.length : n;
    const at = (k) => (idx ? idx[k] : k);
    const groups = g.groups && g.groups.length ? g.groups : [{ start: 0, count: total, materialIndex: 0 }];
    const kept = [];
    const newGroups = [];
    let gone = 0;
    for (const gr of groups) {
      const start = kept.length;
      const end = Math.min(total, gr.start + gr.count);
      for (let k = gr.start; k + 2 < end; k += 3) {
        const a = at(k), b = at(k + 1), c = at(k + 2);
        // a triangle goes when all its corners belong to the part (clean edges, no slivers)
        if (cut[a] && cut[b] && cut[c]) { gone++; continue; }
        kept.push(a, b, c);
      }
      if (kept.length > start) newGroups.push({ start, count: kept.length - start, materialIndex: gr.materialIndex });
    }
    if (!gone) continue;
    removed += gone;
    const oldIndex = g.index, oldGroups = g.groups.map((x) => ({ ...x }));
    const Arr = n > 65535 ? Uint32Array : Uint16Array;
    const newIndex = new THREE.BufferAttribute(new Arr(kept), 1);
    const hadGroups = g.groups && g.groups.length > 0;
    edits.push({
      g,
      apply: () => { g.setIndex(newIndex); g.clearGroups(); if (hadGroups) for (const x of newGroups) g.addGroup(x.start, x.count, x.materialIndex); },
      revert: () => { g.setIndex(oldIndex); g.clearGroups(); for (const x of oldGroups) g.addGroup(x.start, x.count, x.materialIndex); },
    });
  }
  if (!edits.length) return null;
  for (const e of edits) e.apply();
  return { removed, undo: () => { for (const e of edits) e.revert(); }, redo: () => { for (const e of edits) e.apply(); } };
}
