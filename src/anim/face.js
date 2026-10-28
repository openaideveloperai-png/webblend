// Face and pose controls: shape keys (blink, smile, mouth vowels...), poses
// saved in the file as single-frame actions (a rig's mouth shapes, hand
// poses...), and a jaw bone. The AI keys them by name; the Animations tab shows
// the file's poses as sliders.
import * as THREE from 'three';
import { translateName } from '../core/jp.js';
import { parseTrack } from './clips.js';
import { scanRig } from './rigscan.js';

// MMD morph names (whole names) -> English
const MORPH_JP = {
  'まばたき': 'blink', 'まばたき2': 'blink 2', 'ウィンク': 'wink (left)', 'ウィンク右': 'wink (right)', 'ウィンク２': 'wink 2 (left)', 'ｳｨﾝｸ２右': 'wink 2 (right)', 'ウィンク２右': 'wink 2 (right)',
  '笑い': 'smiling eyes', 'はぅ': '> < eyes', 'なごみ': 'calm eyes', 'じと目': 'half-closed eyes', 'びっくり': 'surprised eyes', 'ｷﾘｯ': 'sharp eyes', 'キリッ': 'sharp eyes',
  '瞳小': 'small pupils', '瞳大': 'big pupils', 'ハイライト消': 'no eye highlights', '星目': 'star eyes', 'はぁと': 'heart eyes',
  'あ': 'mouth A (open)', 'い': 'mouth I (wide)', 'う': 'mouth U (pursed)', 'え': 'mouth E', 'お': 'mouth O (round)', 'あ２': 'mouth A 2', 'ん': 'mouth N (closed)',
  '▲': 'mouth triangle', '∧': 'mouth frown', '□': 'mouth square (shout)', 'ω': 'cat mouth', 'ω□': 'cat mouth open', 'ワ': 'mouth wide smile', 'にやり': 'grin', 'にっこり': 'smile', 'ぺろっ': 'tongue out', 'てへぺろ': 'tongue out wink',
  '口角上げ': 'mouth corners up', '口角下げ': 'mouth corners down', '口横広げ': 'mouth wide',
  '真面目': 'serious brows', '困る': 'troubled brows', '怒り': 'angry brows', 'にこり': 'happy brows', '上': 'brows up', '下': 'brows down', '前': 'brows forward',
  '照れ': 'blush', '青ざめ': 'pale', '涙': 'tears',
};

export function controlLabel(name) {
  const n = String(name || '');
  const k = n.normalize ? n.normalize('NFKC') : n;
  if (MORPH_JP[n]) return MORPH_JP[n];
  if (MORPH_JP[k]) return MORPH_JP[k];
  const t = translateName(n);
  // common short English prefixes: eb_ (eyebrow), el_ (eyelid), mth_ / mouth_
  return (t || n).replace(/^eb_/i, 'brows ').replace(/^el_/i, 'eyelids ').replace(/^mth_/i, 'mouth ').replace(/_/g, ' ').trim();
}

// 'eyes' | 'brows' | 'mouth' | 'face' | 'body' from a name (and whether its mesh is the head)
export function controlGroup(name, onHead) {
  const n = String(name || '');
  const l = (n + ' ' + controlLabel(n)).toLowerCase();
  if (/brow|^eb[_ ]|眉|真面目|困る|怒り|にこり/.test(l) || /^(上|下|前)$/.test(n)) return 'brows';
  if (/blink|wink|eyelid|^el[_ ]|lid|pupil|iris|eye|まばたき|ウィンク|じと|はぅ|なごみ|びっくり|瞳|笑い|まぶた|ｷﾘｯ|キリッ/.test(l)) return 'eyes';
  if (/mouth|lip|jaw|tongue|teeth|vowel|viseme|smile|grin|kiss|pout|frown|^(a|i|u|e|o|aa|ih|ou|ee|oh|ah|nn)$|あ|い|う|え|お|ω|にやり|にっこり|ぺろ|口|舌|歯|唇|▲|∧|□|ワ|ん/.test(l) || /^mouth/i.test(n)) return 'mouth';
  if (/blush|tear|cheek|face|expression|照れ|涙|頬/.test(l)) return 'face';
  return onHead ? 'face' : 'body';
}

// ---------------------------------------------------------------- poses saved in a file
export function isPoseClip(clip) {
  return !!clip && clip.tracks.length > 0 && clip.tracks.every((t) => t.times.length <= 1);
}

function findNode(model, nodeName) {
  let n = null;
  model.root.traverse((o) => { if (!n && o.uuid === nodeName) n = o; });
  return n || model.root.getObjectByName(nodeName) || null;
}

// A single-frame clip -> { name, deltas: [{node, dq, dp, ds}], empty, group }
export function poseFromClip(model, clip) {
  const byNode = new Map();
  for (const t of clip.tracks) {
    const { nodeName, prop: propertyName } = parseTrack(t);
    if (!['quaternion', 'position', 'scale'].includes(propertyName)) continue;
    const node = findNode(model, nodeName);
    const r = node && model.rest.get(node);
    if (!r) continue;
    if (!byNode.has(node)) byNode.set(node, { node, dq: new THREE.Quaternion(), dp: new THREE.Vector3(), ds: new THREE.Vector3() });
    const d = byNode.get(node);
    const v = t.values;
    if (propertyName === 'quaternion') d.dq.copy(r.q.clone().invert().multiply(new THREE.Quaternion(v[0], v[1], v[2], v[3]).normalize()));
    if (propertyName === 'position') d.dp.set(v[0] - r.p.x, v[1] - r.p.y, v[2] - r.p.z);
    if (propertyName === 'scale') d.ds.set(v[0] - r.s.x, v[1] - r.s.y, v[2] - r.s.z);
  }
  // keep only what really moves (size-relative: 0.05 mm on a 1.7 m character)
  const tiny = Math.max(1e-5, (model.size || 1.7) * 3e-5);
  const deltas = [...byNode.values()].filter((d) => 2 * Math.acos(Math.min(1, Math.abs(d.dq.w))) > 0.002 || d.dp.length() > tiny || d.ds.length() > 1e-4);
  const head = model.humanoid && model.humanoid.map.head;
  const under = (o, a) => { for (let p = o; p; p = p.parent) if (p === a) return true; return false; };
  const onHead = !!head && deltas.length > 0 && deltas.every((d) => under(d.node, head));
  const group = onHead ? controlGroup(clip.name, true) : 'body';
  return { name: clip.name, label: controlLabel(clip.name), deltas, empty: deltas.length === 0, group: group === 'body' && onHead ? 'face' : group };
}

// node -> {q, p, s} for weighted poses ([{pose, w}]), starting from rest
export function blendPoses(model, list) {
  const out = new Map();
  for (const { pose, w } of list) {
    if (!pose || !(Math.abs(w) > 1e-5)) continue;
    for (const d of pose.deltas) {
      const r = model.rest.get(d.node);
      if (!r) continue;
      let o = out.get(d.node);
      if (!o) out.set(d.node, (o = { q: r.q.clone(), p: r.p.clone(), s: r.s.clone() }));
      o.q.multiply(new THREE.Quaternion().slerp(d.dq, THREE.MathUtils.clamp(w, -1, 1.5)));
      o.p.addScaledVector(d.dp, w);
      o.s.addScaledVector(d.ds, w);
    }
  }
  return out;
}

// ---------------------------------------------------------------- the list of controls
// -> [{ id, kind: 'shape'|'pose'|'jaw', name, label, group, targets?, pose?, bone?, axisL?, maxDeg? }]
export function faceControls(model) {
  if (model._faceControls && model._faceControlsN === model.nodeCount && model._faceControlsP === (model.poses || []).length) return model._faceControls;
  const list = [];
  const head = model.humanoid && model.humanoid.map.head;
  const isHeadMesh = (mesh) => {
    if (/head|face|頭|顔|eye|目|mouth|口/i.test(mesh.name)) return true;
    if (!head || !mesh.isSkinnedMesh || !mesh.skeleton) return false;
    const sw = mesh.geometry.attributes.skinWeight, si = mesh.geometry.attributes.skinIndex;
    if (!sw || !si) return false;
    const headSet = new Set();
    head.traverse((o) => { if (o.isBone) headSet.add(o); });
    let onHead = 0, n = 0;
    const step = Math.max(1, Math.floor(si.count / 2000));
    for (let i = 0; i < si.count; i += step) { n++; if (headSet.has(mesh.skeleton.bones[si.getComponent(i, 0)])) onHead++; }
    return onHead > n * 0.6;
  };
  // shape keys, merged by name across meshes; a key counts as a face control
  // only when the vertices it moves sit on the head
  const headSet = new Set();
  if (head) head.traverse((o) => { if (o.isBone) headSet.add(o); });
  const morphOnHead = (mesh, index) => {
    const d = mesh.geometry.morphAttributes && mesh.geometry.morphAttributes.position && mesh.geometry.morphAttributes.position[index];
    if (!d) return isHeadMesh(mesh);
    if (!head) return /head|face|頭|顔/i.test(mesh.name);
    const rel = mesh.geometry.morphTargetsRelative;
    const pos = mesh.geometry.attributes.position, si = mesh.geometry.attributes.skinIndex;
    let on = 0, moved = 0;
    const step = Math.max(1, Math.floor(d.count / 20000));
    for (let i = 0; i < d.count; i += step) {
      let dx = d.getX(i), dy = d.getY(i), dz = d.getZ(i);
      if (!rel) { dx -= pos.getX(i); dy -= pos.getY(i); dz -= pos.getZ(i); }
      if (dx * dx + dy * dy + dz * dz < 1e-10) continue;
      moved++;
      if (mesh.isSkinnedMesh && si && mesh.skeleton ? headSet.has(mesh.skeleton.bones[si.getComponent(i, 0)]) : isHeadMesh(mesh)) on++;
    }
    return moved ? on > moved * 0.5 : isHeadMesh(mesh);
  };
  const shapes = new Map();
  for (const mesh of model.morphMeshes || []) {
    const dict = mesh.morphTargetDictionary || {};
    const names = Object.keys(dict).length ? Object.entries(dict) : (mesh.morphTargetInfluences || []).map((_, i) => [`shape ${i}`, i]);
    for (const [name, index] of names) {
      if (/^(basis|base|ベース)$/i.test(name)) continue;
      if (!shapes.has(name)) {
        const onHead = morphOnHead(mesh, index);
        shapes.set(name, { id: 'shape:' + name, kind: 'shape', name, label: controlLabel(name), group: onHead ? controlGroup(name, true) : 'body', targets: [] });
      }
      shapes.get(name).targets.push({ mesh, index });
    }
  }
  list.push(...shapes.values());
  // poses from the file
  for (const pose of model.poses || []) list.push({ id: 'pose:' + pose.name, kind: 'pose', name: pose.name, label: pose.label, group: pose.group, pose });
  // a jaw bone that rotates freely (not driven by constraints)
  if (head) {
    const { info } = scanRig(model);
    let jaw = null;
    // a bone that turns (deforms the jaw itself, or a parent of jaw bones), not one a constraint drives
    head.traverse((o) => { const i = info.get(o); if (!jaw && o.isBone && /jaw|顎|あご|chin/i.test(o.name) && i && i.role !== 'auto' && i.kind === 'rotate') jaw = o; });
    const rig = model.humanoid;
    if (jaw && rig.rest.get(jaw)) {
      const r = rig.rest.get(jaw);
      // turning about the character's left-right axis; + must swing the chin down
      const kids = []; jaw.traverse((o) => { if (o !== jaw && o.isBone && rig.rest.get(o)) kids.push(rig.rest.get(o).pos); });
      const arm = kids.length ? kids.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(kids.length).sub(r.pos) : rig.fwd.clone().multiplyScalar(0.05 * rig.hipHeight);
      if (arm.lengthSq() < 1e-12) arm.copy(rig.fwd);
      let axisW = rig.lat.clone();
      const moved = arm.clone().applyAxisAngle(axisW, 0.2).sub(arm);
      if (moved.dot(rig.up) > 0) axisW.negate();
      list.push({ id: 'jaw', kind: 'jaw', name: 'jawOpen', label: 'open the jaw (bone ' + jaw.name + ')', group: 'mouth', bone: jaw, axisL: axisW.applyQuaternion(r.Wq.clone().invert()).normalize(), maxDeg: 22 });
    }
  }
  model._faceControls = list;
  model._faceControlsN = model.nodeCount;
  model._faceControlsP = (model.poses || []).length;
  return list;
}

export function findControl(model, name) {
  const list = faceControls(model);
  const raw = String(name || '').trim();
  const bare = raw.replace(/\s*\(.*\)\s*$/, '').trim();
  const low = (x) => x.toLowerCase();
  return list.find((c) => c.name === raw || c.name === bare)
    || list.find((c) => low(c.name) === low(bare) || low(c.label) === low(bare) || low(c.label) === low(raw))
    || list.find((c) => low(c.id) === low(raw)) || null;
}

// ---------------------------------------------------------------- keys -> tracks
// keys: [{t, control, value}] -> { tracks, unknown: [names], used: [labels] }
export function faceTracks(model, keys, duration, fps = 30) {
  const byControl = new Map();
  const unknown = new Set();
  for (const k of keys || []) {
    if (!k || !Number.isFinite(Number(k.t))) continue;
    const c = findControl(model, k.control);
    if (!c) { unknown.add(String(k.control)); continue; }
    if (!byControl.has(c)) byControl.set(c, []);
    byControl.get(c).push({ t: THREE.MathUtils.clamp(Number(k.t), 0, duration), v: Number(k.value) || 0 });
  }
  const tracks = [];
  const valueAt = (ks, t) => {
    if (t <= ks[0].t) return ks[0].v;
    if (t >= ks[ks.length - 1].t) return ks[ks.length - 1].v;
    let i = 0;
    while (i < ks.length - 2 && ks[i + 1].t <= t) i++;
    const a = ks[i], b = ks[i + 1];
    const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
    return a.v + (b.v - a.v) * u * u * (3 - 2 * u);
  };
  const boneControls = [];
  for (const [c, ks0] of byControl) {
    const ks = ks0.sort((a, b) => a.t - b.t);
    if (c.kind === 'shape') {
      // smooth: sample between keys
      const times = [], vals = [];
      const n = Math.max(2, Math.round(duration * fps) + 1);
      for (let i = 0; i < n; i++) { const t = (i / (n - 1)) * duration; times.push(t); vals.push(THREE.MathUtils.clamp(valueAt(ks, t), 0, 1)); }
      for (const { mesh, index } of c.targets) tracks.push(new THREE.NumberKeyframeTrack(`${mesh.uuid}.morphTargetInfluences[${index}]`, times, vals));
    } else boneControls.push([c, ks]);
  }
  if (boneControls.length) {
    const n = Math.max(2, Math.round(duration * fps) + 1);
    const times = [];
    const per = new Map(); // node -> {q:[], p:[], s:[]}
    let prevQ = new Map();
    const nodes = new Set();
    for (const [c] of boneControls) { if (c.kind === 'pose') for (const d of c.pose.deltas) nodes.add(d.node); else nodes.add(c.bone); }
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * duration;
      times.push(t);
      const poses = [];
      const jaw = new Map();
      for (const [c, ks] of boneControls) {
        const v = valueAt(ks, t);
        if (c.kind === 'pose') poses.push({ pose: c.pose, w: THREE.MathUtils.clamp(v, 0, 1.2) });
        else jaw.set(c, THREE.MathUtils.clamp(v, -0.2, 1.2));
      }
      const blended = blendPoses(model, poses);
      for (const [c, v] of jaw) {
        const r = model.rest.get(c.bone);
        const o = blended.get(c.bone) || { q: r.q.clone(), p: r.p.clone(), s: r.s.clone() };
        o.q.multiply(new THREE.Quaternion().setFromAxisAngle(c.axisL, v * c.maxDeg * THREE.MathUtils.DEG2RAD));
        blended.set(c.bone, o);
      }
      for (const node of nodes) {
        const r = model.rest.get(node);
        const o = blended.get(node) || { q: r.q.clone(), p: r.p.clone(), s: r.s.clone() };
        let a = per.get(node);
        if (!a) per.set(node, (a = { q: [], p: [], s: [] }));
        const q = o.q.clone();
        const pq = prevQ.get(node);
        if (pq && pq.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        prevQ.set(node, q);
        a.q.push(q.x, q.y, q.z, q.w);
        a.p.push(o.p.x, o.p.y, o.p.z);
        a.s.push(o.s.x, o.s.y, o.s.z);
      }
    }
    for (const [node, a] of per) {
      const r = model.rest.get(node);
      const changes = (arr, base, size) => { for (let i = 0; i < arr.length; i += size) for (let j = 0; j < size; j++) if (Math.abs(arr[i + j] - base[j]) > 1e-7) return true; return false; };
      if (changes(a.q, r.q.toArray(), 4)) tracks.push(new THREE.QuaternionKeyframeTrack(node.uuid + '.quaternion', times.slice(), a.q));
      if (changes(a.p, r.p.toArray(), 3)) tracks.push(new THREE.VectorKeyframeTrack(node.uuid + '.position', times.slice(), a.p));
      if (changes(a.s, r.s.toArray(), 3)) tracks.push(new THREE.VectorKeyframeTrack(node.uuid + '.scale', times.slice(), a.s));
    }
  }
  return { tracks, unknown: [...unknown], used: [...byControl.keys()].map((c) => c.name) };
}

// one line per group for the AI
export function describeFace(model) {
  const list = faceControls(model);
  if (!list.length) return '';
  const groups = {};
  for (const c of list) (groups[c.group] = groups[c.group] || []).push(c);
  const fmt = (c) => (c.label && c.label !== c.name ? `"${c.name}" (${c.label})` : `"${c.name}"`) + (c.kind === 'pose' ? ' [pose from the file]' : c.kind === 'jaw' ? ' [jaw bone]' : '');
  const order = ['mouth', 'eyes', 'brows', 'face', 'body'];
  const parts = order.filter((g) => groups[g]).map((g) => `${g}: ${groups[g].slice(0, g === 'body' ? 12 : 40).map(fmt).join(', ')}${groups[g].length > (g === 'body' ? 12 : 40) ? ', …' : ''}`);
  return `  Face / pose controls for faceKeys (value 0 = off, 1 = full; they can be mixed): ${parts.join('; ')}.`;
}

// ---------------------------------------------------------------- words -> face keys (offline)
const WANT = {
  smile: { re: /smile|joy|happy|笑|にっこり|にこり|grin/, groups: ['mouth', 'eyes', 'brows'], value: 0.8 },
  blink: { re: /blink|まばたき/, groups: ['eyes'], value: 1 },
  wink: { re: /wink|ウィンク/, groups: ['eyes'], value: 1 },
  open: { re: /^(mouth[_ ]?)?(a|aa|ah)$|mouth[_ ]?a\b|mouth a \(open\)|jaw ?open|open the jaw|mouth ?open|^あ$/, groups: ['mouth'], value: 0.6 },
  round: { re: /^(mouth[_ ]?)?(o|u|ou|oh)$|mouth[_ ]?[ou]\b|mouth [ou] \(|pucker|kiss|pout|^お$|^う$|ω/, groups: ['mouth'], value: 0.7 },
};
// wants: [{kind, at?, value?}] -> { keys: [{t, control, value}], missing: [kinds] }
export function faceKeysFor(model, wants, duration) {
  const list = faceControls(model);
  const keys = [];
  const missing = [];
  const pick = (w) => {
    const out = [];
    for (const g of w.groups) {
      const c = list.find((x) => x.group === g && (w.re.test(x.name.toLowerCase()) || w.re.test(x.label.toLowerCase())));
      if (c) out.push(c);
      if (out.length && w !== WANT.smile) break; // a smile may use mouth + eyes + brows, the rest one control
    }
    return out;
  };
  const seen = new Set();
  for (const want of wants) {
    const w = WANT[want.kind];
    if (!w) continue;
    const cs = pick(w);
    if (!cs.length) { if (!missing.includes(want.kind)) missing.push(want.kind); continue; }
    for (const c of cs) {
      if (seen.has(c.name + want.kind)) continue;
      seen.add(c.name + want.kind);
      const v = want.value ?? (c.group === 'brows' ? 0.6 : w.value);
      if (want.kind === 'blink') {
        for (let t = Math.min(0.8, duration * 0.3); t < duration - 0.2; t += 2.6) keys.push({ t: t - 0.07, control: c.name, value: 0 }, { t, control: c.name, value: v }, { t: t + 0.1, control: c.name, value: 0 });
      } else if (want.kind === 'wink') {
        const t = Math.min(0.6, duration * 0.3);
        keys.push({ t: t - 0.1, control: c.name, value: 0 }, { t: t + 0.05, control: c.name, value: v }, { t: t + 0.35, control: c.name, value: v }, { t: t + 0.5, control: c.name, value: 0 });
      } else {
        const t = want.at ?? Math.min(0.25, duration * 0.15);
        keys.push({ t: Math.max(0, t - 0.2), control: c.name, value: 0 }, { t: Math.min(duration, t + 0.2), control: c.name, value: v }, { t: duration, control: c.name, value: v });
      }
    }
  }
  return { keys, missing };
}
