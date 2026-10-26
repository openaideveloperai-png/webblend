// Keyframe editing on THREE.AnimationClip objects.
import * as THREE from 'three';

const EPS = 1e-4;

function firstMaterial(o) {
  const m = o.material;
  return Array.isArray(m) ? m[0] : m;
}

// Keyable properties. `key` is the property path used in track names.
export const PROPS = {
  position: { label: 'Position', short: 'Pos', size: 3, Track: THREE.VectorKeyframeTrack, get: (o) => o.position.toArray(), set: (o, v) => o.position.fromArray(v) },
  quaternion: { label: 'Rotation', short: 'Rot', size: 4, Track: THREE.QuaternionKeyframeTrack, get: (o) => o.quaternion.toArray(), set: (o, v) => o.quaternion.fromArray(v).normalize() },
  scale: { label: 'Scale', short: 'Scl', size: 3, Track: THREE.VectorKeyframeTrack, get: (o) => o.scale.toArray(), set: (o, v) => o.scale.fromArray(v) },
  visible: { label: 'Visible', short: 'Vis', size: 1, Track: THREE.BooleanKeyframeTrack, get: (o) => [o.visible], set: (o, v) => { o.visible = !!v[0]; } },
  'material.color': { label: 'Color', short: 'Col', size: 3, Track: THREE.ColorKeyframeTrack, get: (o) => firstMaterial(o).color.toArray(), set: (o, v) => firstMaterial(o).color.fromArray(v), test: (o) => !!(firstMaterial(o) && firstMaterial(o).color) },
  'material.opacity': { label: 'Opacity', short: 'Opa', size: 1, Track: THREE.NumberKeyframeTrack, get: (o) => [firstMaterial(o).opacity], set: (o, v) => { const m = firstMaterial(o); m.opacity = v[0]; m.transparent = m.transparent || v[0] < 1; }, test: (o) => !!firstMaterial(o) },
  'material.emissiveIntensity': { label: 'Glow', short: 'Glw', size: 1, Track: THREE.NumberKeyframeTrack, get: (o) => [firstMaterial(o).emissiveIntensity ?? 0], set: (o, v) => { firstMaterial(o).emissiveIntensity = v[0]; }, test: (o) => !!(firstMaterial(o) && firstMaterial(o).emissive) },
  intensity: { label: 'Intensity', short: 'Int', size: 1, Track: THREE.NumberKeyframeTrack, get: (o) => [o.intensity], set: (o, v) => { o.intensity = v[0]; }, test: (o) => o.isLight },
  color: { label: 'Light color', short: 'Col', size: 3, Track: THREE.ColorKeyframeTrack, get: (o) => o.color.toArray(), set: (o, v) => o.color.fromArray(v), test: (o) => o.isLight },
  fov: { label: 'Field of view', short: 'FOV', size: 1, Track: THREE.NumberKeyframeTrack, get: (o) => [o.fov], set: (o, v) => { o.fov = v[0]; o.updateProjectionMatrix(); }, test: (o) => o.isPerspectiveCamera },
};

const MORPH_RE = /^morphTargetInfluences\[(.+)\]$/;

export function propDesc(prop) {
  if (PROPS[prop]) return PROPS[prop];
  const m = MORPH_RE.exec(prop);
  if (m) {
    const key = m[1];
    const idx = (o) => {
      if (/^\d+$/.test(key)) return parseInt(key, 10);
      return o.morphTargetDictionary ? o.morphTargetDictionary[key] ?? -1 : -1;
    };
    return {
      label: 'Shape: ' + key, short: 'Shp', size: 1, Track: THREE.NumberKeyframeTrack, morph: true,
      get: (o) => [o.morphTargetInfluences?.[idx(o)] ?? 0],
      set: (o, v) => { const i = idx(o); if (o.morphTargetInfluences && i >= 0) o.morphTargetInfluences[i] = v[0]; },
    };
  }
  return null;
}

export function morphLabel(o, prop) {
  const m = MORPH_RE.exec(prop);
  if (!m) return null;
  if (/^\d+$/.test(m[1]) && o && o.morphTargetDictionary) {
    const i = parseInt(m[1], 10);
    const name = Object.keys(o.morphTargetDictionary).find((k) => o.morphTargetDictionary[k] === i);
    if (name) return name;
  }
  return m[1];
}

// Default keyable properties for an object
export function keyableProps(o) {
  const out = ['position', 'quaternion', 'scale'];
  if (!o.isBone) out.push('visible');
  if (o.isMesh && !o.isSkinnedMesh) { if (PROPS['material.color'].test(o)) out.push('material.color', 'material.opacity'); }
  if (o.isSkinnedMesh && PROPS['material.color'].test(o)) out.push('material.color', 'material.opacity');
  if (o.isLight) out.push('intensity', 'color');
  if (o.isPerspectiveCamera) out.push('fov');
  if (o.morphTargetInfluences) o.morphTargetInfluences.forEach((_, i) => out.push(`morphTargetInfluences[${i}]`));
  return out;
}

// ---- parse track names -> (node, prop)
export function parseTrack(track) {
  const p = THREE.PropertyBinding.parseTrackName(track.name);
  let prop = p.propertyName;
  if (p.objectName) prop = `${p.objectName}${p.objectIndex !== undefined ? '[' + p.objectIndex + ']' : ''}.${p.propertyName}`;
  if (p.propertyIndex !== undefined) prop += `[${p.propertyIndex}]`;
  // normalize material[0].color -> material.color (UI shows first material)
  prop = prop.replace(/^materials?\[0\]\./, 'material.');
  return { nodeName: p.nodeName, prop };
}

const infoCache = new WeakMap();

export function bumpClip(clip) {
  clip.userData = clip.userData || {};
  clip.userData.version = (clip.userData.version || 0) + 1;
}

// Groups tracks by target node. Cached per clip version.
export function clipInfo(clip, root) {
  const ver = clip.userData?.version || 0;
  const c = infoCache.get(clip);
  if (c && c.ver === ver && c.root === root && c.n === clip.tracks.length) return c;
  const groups = new Map();
  const unresolved = [];
  clip.tracks.forEach((track, ti) => {
    const { nodeName, prop } = parseTrack(track);
    let node = THREE.PropertyBinding.findNode(root, nodeName);
    if (!node && nodeName) node = findNodeLoose(root, nodeName);
    if (!node) { unresolved.push(ti); return; }
    let g = groups.get(node);
    if (!g) groups.set(node, (g = []));
    g.push({ track, ti, prop });
  });
  const info = { ver, root, n: clip.tracks.length, groups, unresolved };
  infoCache.set(clip, info);
  return info;
}

// match "mixamorig:Hips" with "mixamorigHips", case-insensitive, etc.
export function normBoneName(n) {
  return String(n || '').toLowerCase().replace(/^.*[:|]/, '').replace(/^(mixamorig\d*|armature|bip\d*|bip01|character\d*_?)/, '').replace(/[^a-z0-9]/g, '');
}

function findNodeLoose(root, name) {
  const target = normBoneName(name);
  if (!target) return null;
  let found = null;
  root.traverse((o) => { if (!found && normBoneName(o.name) === target) found = o; });
  return found;
}

export function findTrackIndex(clip, root, node, prop) {
  const info = clipInfo(clip, root);
  const g = info.groups.get(node);
  if (!g) return -1;
  const e = g.find((x) => x.prop === prop);
  return e ? e.ti : -1;
}

export function trackName(node, prop) {
  if (prop.startsWith('material.') && Array.isArray(node.material)) return `${node.uuid}.material[0].${prop.slice(9)}`;
  return `${node.uuid}.${prop}`;
}

function keyIndexAt(times, t, eps = EPS) {
  // binary search for a key within eps
  let lo = 0, hi = times.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (Math.abs(times[mid] - t) <= eps) return mid;
    if (times[mid] < t) lo = mid + 1; else hi = mid - 1;
  }
  return -1;
}

export function hasKeyAt(track, t, eps = EPS) { return keyIndexAt(track.times, t, eps) >= 0; }

// Insert or replace a key. Returns the track index.
export function setKey(clip, root, node, prop, time, value, eps = EPS) {
  const desc = propDesc(prop);
  if (!desc) return -1;
  value = Array.from(value);
  let ti = findTrackIndex(clip, root, node, prop);
  if (ti < 0) {
    const track = new desc.Track(trackName(node, prop), [time], value);
    if (prop === 'visible') track.setInterpolation(THREE.InterpolateDiscrete);
    clip.tracks.push(track);
    ti = clip.tracks.length - 1;
  } else {
    const tr = clip.tracks[ti];
    const size = tr.getValueSize();
    const times = Array.from(tr.times), vals = Array.from(tr.values);
    if (desc === PROPS.quaternion && times.length) {
      // keep sign continuity with the previous key
      let pi = -1;
      for (let i = 0; i < times.length; i++) if (times[i] < time - eps) pi = i;
      if (pi >= 0) {
        const d = vals[pi * 4] * value[0] + vals[pi * 4 + 1] * value[1] + vals[pi * 4 + 2] * value[2] + vals[pi * 4 + 3] * value[3];
        if (d < 0) value = value.map((v) => -v);
      }
    }
    const k = keyIndexAt(tr.times, time, eps);
    if (k >= 0) {
      for (let j = 0; j < size; j++) vals[k * size + j] = value[j];
    } else {
      let at = times.findIndex((x) => x > time);
      if (at < 0) at = times.length;
      times.splice(at, 0, time);
      vals.splice(at * size, 0, ...value.slice(0, size));
    }
    const nt = new tr.constructor(tr.name, times, vals);
    nt.setInterpolation(tr.getInterpolation());
    clip.tracks[ti] = nt;
  }
  if (time > clip.duration) clip.duration = time;
  bumpClip(clip);
  return ti;
}

export function sampleTrack(track, t) {
  const interp = track.createInterpolant(new track.ValueBufferType(track.getValueSize()));
  return Array.from(interp.evaluate(t));
}

// Delete keys: sel = [{ti, ki}]
export function deleteKeys(clip, sel) {
  const byTrack = new Map();
  for (const { ti, ki } of sel) {
    if (!byTrack.has(ti)) byTrack.set(ti, new Set());
    byTrack.get(ti).add(ki);
  }
  const removeTracks = [];
  for (const [ti, ks] of byTrack) {
    const tr = clip.tracks[ti];
    if (!tr) continue;
    const size = tr.getValueSize();
    const times = [], vals = [];
    for (let i = 0; i < tr.times.length; i++) {
      if (ks.has(i)) continue;
      times.push(tr.times[i]);
      for (let j = 0; j < size; j++) vals.push(tr.values[i * size + j]);
    }
    if (!times.length) { removeTracks.push(ti); continue; }
    const nt = new tr.constructor(tr.name, times, vals);
    nt.setInterpolation(tr.getInterpolation());
    clip.tracks[ti] = nt;
  }
  removeTracks.sort((a, b) => b - a).forEach((ti) => clip.tracks.splice(ti, 1));
  bumpClip(clip);
}

// Move selected keys by dt (seconds). Returns new selection.
export function moveKeys(clip, sel, dt, snap) {
  const byTrack = new Map();
  for (const { ti, ki } of sel) {
    if (!byTrack.has(ti)) byTrack.set(ti, new Set());
    byTrack.get(ti).add(ki);
  }
  const newSel = [];
  let maxT = 0;
  for (const [ti, ks] of byTrack) {
    const tr = clip.tracks[ti];
    if (!tr) continue;
    const size = tr.getValueSize();
    const keys = [];
    for (let i = 0; i < tr.times.length; i++) {
      let t = tr.times[i];
      const s = ks.has(i);
      if (s) { t = Math.max(0, t + dt); if (snap) t = snap(t); }
      keys.push({ t, v: Array.from(tr.values.subarray(i * size, i * size + size)), s });
    }
    keys.sort((a, b) => a.t - b.t || (a.s ? 1 : -1));
    const out = [];
    for (const k of keys) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.t - k.t) <= EPS) {
        if (k.s || !prev.s) out[out.length - 1] = k; // selected key wins
        continue;
      }
      out.push(k);
    }
    const nt = new tr.constructor(tr.name, out.map((k) => k.t), out.flatMap((k) => k.v));
    nt.setInterpolation(tr.getInterpolation());
    clip.tracks[ti] = nt;
    out.forEach((k, i) => { if (k.s) newSel.push({ ti, ki: i }); maxT = Math.max(maxT, k.t); });
  }
  if (maxT > clip.duration) clip.duration = maxT;
  bumpClip(clip);
  return newSel;
}

export function setInterpolation(clip, tis, mode) {
  const map = { linear: THREE.InterpolateLinear, step: THREE.InterpolateDiscrete, smooth: THREE.InterpolateSmooth };
  for (const ti of tis) {
    const tr = clip.tracks[ti];
    if (!tr) continue;
    let m = map[mode];
    if (tr instanceof THREE.QuaternionKeyframeTrack && m === THREE.InterpolateSmooth) m = THREE.InterpolateLinear;
    if (tr instanceof THREE.BooleanKeyframeTrack || tr instanceof THREE.StringKeyframeTrack) m = THREE.InterpolateDiscrete;
    tr.setInterpolation(m);
  }
  bumpClip(clip);
}

export function interpolationName(track) {
  const i = track.getInterpolation();
  return i === THREE.InterpolateDiscrete ? 'step' : i === THREE.InterpolateSmooth ? 'smooth' : 'linear';
}

export function snapshotClip(clip) {
  return {
    duration: clip.duration,
    name: clip.name,
    tracks: clip.tracks.map((t) => ({ name: t.name, ctor: t.constructor, times: t.times.slice(), values: t.values.slice(), interp: t.getInterpolation() })),
  };
}

export function restoreClip(clip, snap) {
  clip.tracks = snap.tracks.map((s) => {
    const t = new s.ctor(s.name, s.times.slice(), s.values.slice());
    t.setInterpolation(s.interp);
    return t;
  });
  clip.duration = snap.duration;
  clip.name = snap.name;
  bumpClip(clip);
}

export function allKeyTimes(clip, tracks) {
  const set = new Set();
  for (const t of tracks || clip.tracks) for (const x of t.times) set.add(Math.round(x * 1e4) / 1e4);
  return [...set].sort((a, b) => a - b);
}

// Remove keys that don't change anything (keeps first/last)
export function simplifyClip(clip, tol = 1e-4) {
  clip.tracks = clip.tracks.map((tr) => {
    const size = tr.getValueSize();
    const n = tr.times.length;
    if (n <= 2) return tr;
    const keep = [0];
    for (let i = 1; i < n - 1; i++) {
      let same = true;
      for (let j = 0; j < size; j++) {
        const a = tr.values[(i - 1) * size + j], b = tr.values[i * size + j], c = tr.values[(i + 1) * size + j];
        if (Math.abs(a - b) > tol || Math.abs(b - c) > tol) { same = false; break; }
      }
      if (!same) keep.push(i);
    }
    keep.push(n - 1);
    if (keep.length === n) return tr;
    const nt = new tr.constructor(tr.name, keep.map((i) => tr.times[i]), keep.flatMap((i) => Array.from(tr.values.subarray(i * size, i * size + size))));
    nt.setInterpolation(tr.getInterpolation());
    return nt;
  });
  bumpClip(clip);
}

export function reverseClip(clip) {
  const d = clip.duration;
  clip.tracks = clip.tracks.map((tr) => {
    const size = tr.getValueSize();
    const n = tr.times.length;
    const times = [], vals = [];
    for (let i = n - 1; i >= 0; i--) { times.push(d - tr.times[i]); for (let j = 0; j < size; j++) vals.push(tr.values[i * size + j]); }
    const nt = new tr.constructor(tr.name, times, vals);
    nt.setInterpolation(tr.getInterpolation());
    return nt;
  });
  bumpClip(clip);
}

// Make a standalone copy whose track names use node names resolvable from `root`
// (for export/sharing). Nodes with duplicate names keep their uuid.
export function clipWithNames(clip, root) {
  const counts = new Map();
  root.traverse((o) => counts.set(o.name, (counts.get(o.name) || 0) + 1));
  const c = clip.clone();
  c.tracks = c.tracks.map((tr) => {
    const { nodeName } = parseTrack(tr);
    const node = THREE.PropertyBinding.findNode(root, nodeName);
    if (node && node.name && counts.get(node.name) === 1 && /^[^[\].:/]+$/.test(node.name)) {
      const t = tr.clone();
      t.name = node.name + tr.name.slice(nodeName.length);
      return t;
    }
    return tr.clone();
  });
  return c;
}

// Copy of a clip whose track names point at node uuids under root (unambiguous).
export function clipWithUuids(clip, root) {
  const c = clip.clone();
  c.tracks = c.tracks.map((tr) => {
    const { nodeName } = parseTrack(tr);
    let node = THREE.PropertyBinding.findNode(root, nodeName) || findNodeLoose(root, nodeName);
    const t = tr.clone();
    if (node) t.name = node.uuid + tr.name.slice(nodeName.length);
    return t;
  }).filter((t) => {
    const { nodeName } = parseTrack(t);
    return !!THREE.PropertyBinding.findNode(root, nodeName);
  });
  return c;
}
