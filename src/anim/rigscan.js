// Scans every bone of a model: which body part it moves (from the skin
// weights, its children and the constraints it feeds), whether it's a bone you
// rotate, a control handle you move (lip / jaw / IK handles), something the rig
// drives by itself, or unused. The AI gets this map so it can move any bone of
// any rig, with more or fewer bones than usual.
import * as THREE from 'three';
import { translateName } from '../core/jp.js';

const NAME_REGIONS = [
  ['fingers', /thumb|index|middle finger|ring finger|little finger|pinky|finger|digit|metacarpal/],
  ['tongue', /tongue/], ['teeth', /teeth|tooth/],
  ['lips / mouth', /\blips?\b|lip[._ ]|mouth/], ['jaw', /\bjaw|chin/],
  ['eyelids', /eyelid|\blid\b|lids/], ['brows', /brow/], ['eyes', /\beyes?\b|eye[._ ]|pupil|iris/],
  ['cheeks', /cheek/], ['nose', /\bnose/], ['ears', /\bears?\b|ear[._ ]/],
  ['hair', /hair|bangs|ahoge|twin ?tail|ponytail|braid|sideburn|fringe/],
  ['horns', /horn/], ['tail', /\btail/], ['wings', /wing/],
  ['breasts', /breast|bust|boob|oppai/], ['butt', /butt|glute/], ['belly', /belly|stomach|navel/],
  ['skirt / clothes', /skirt|sleeve|ribbon|\btie\b|\bhat\b|cape|hood|\bhem\b|collar|cloth|jacket|coat|belt|string|ornament|accessor|glove|sock|shoe|dress|scarf|frill/],
];
const PART = {
  hips: 'hips', spine: 'waist', chest: 'chest', upperChest: 'upper chest', neck: 'neck', head: 'head',
  leftShoulder: 'left shoulder', leftUpperArm: 'left upper arm', leftLowerArm: 'left forearm', leftHand: 'left hand',
  rightShoulder: 'right shoulder', rightUpperArm: 'right upper arm', rightLowerArm: 'right forearm', rightHand: 'right hand',
  leftUpperLeg: 'left thigh', leftLowerLeg: 'left shin', leftFoot: 'left foot', leftToes: 'left toes',
  rightUpperLeg: 'right thigh', rightLowerLeg: 'right shin', rightFoot: 'right foot', rightToes: 'right toes',
};
const FOLLOW = new Set(['STRETCH_TO', 'DAMPED_TRACK', 'TRACK_TO', 'LOCKED_TRACK', 'COPY_TRANSFORMS', 'COPY_ROTATION', 'CHILD_OF']);
const POS_TARGET = new Set(['STRETCH_TO', 'DAMPED_TRACK', 'TRACK_TO', 'LOCKED_TRACK', 'COPY_LOCATION', 'IK']);
const PHYSICS = /physics|rigid|揺れ物|剛体|jiggle|dynamic|spring|swing_|sway/i;

const textOf = (b) => (b.name + ' ' + (translateName(b.name) || '')).toLowerCase().replace(/[_.]/g, ' ');

export function nameRegion(b) {
  const t = textOf(b);
  for (const [r, re] of NAME_REGIONS) if (re.test(t)) return r;
  return null;
}

// -> { info: Map<bone, {region, role, kind, weight, affects: Set, drives: Set, rangeCm?}>, unused: [] }
export function scanRig(model) {
  if (model._rigScan && model._rigScanN === model.nodeCount) return model._rigScan;
  const bones = model.bones || [];
  const rig = model.humanoid;
  // vertex weight per bone
  const weight = new Map();
  for (const s of model.skinned || []) {
    const si = s.geometry.attributes.skinIndex, sw = s.geometry.attributes.skinWeight;
    if (!si || !sw || !s.skeleton) continue;
    const bs = s.skeleton.bones;
    const step = Math.max(1, Math.floor(si.count / 30000));
    for (let i = 0; i < si.count; i += step) for (let k = 0; k < 4; k++) {
      const w = sw.getComponent(i, k);
      if (w > 1e-3) { const b = bs[si.getComponent(i, k)]; weight.set(b, (weight.get(b) || 0) + w * step); }
    }
  }
  for (const b of bones) if (b.children.some((c) => !c.isBone && (c.isMesh || c.children.length))) weight.set(b, (weight.get(b) || 0) + 50);
  // constraints: who follows whom
  const followers = new Map(); // target bone -> owners that follow it
  const posTargets = new Set();
  const follows = new Map(); // owner -> [types]
  const ikChain = new Set(), ikTargets = new Set();
  for (const it of (model.constraints && model.constraints.items) || []) {
    const type = it.c.type;
    if (it.target && it.target.isBone) {
      if (!followers.has(it.target)) followers.set(it.target, new Set());
      followers.get(it.target).add(it.owner);
      if (POS_TARGET.has(type)) posTargets.add(it.target);
    }
    if (type === 'IK') { for (const b of it.chain) ikChain.add(b); if (it.target && it.target.isBone) ikTargets.add(it.target); }
    if (FOLLOW.has(type) && (it.c.influence ?? 1) > 0.5) { if (!follows.has(it.owner)) follows.set(it.owner, []); follows.get(it.owner).push(type); }
  }
  // what each bone moves: itself, its children, and bones following it (transitively)
  const affects = new Map();
  const reach = (b, seen = new Set()) => {
    if (seen.has(b)) return seen;
    seen.add(b);
    for (const c of b.children) if (c.isBone) reach(c, seen);
    for (const f of followers.get(b) || []) reach(f, seen);
    return seen;
  };
  const canon = new Map(rig ? Object.entries(rig.map).map(([k, b]) => [b, k]) : []);
  const fingerBones = new Set();
  if (rig) for (const side of ['left', 'right']) { const H = rig.handRig && rig.handRig(side); if (H) for (const ch of Object.values(H.chains)) for (const e of ch.bones) fingerBones.add(e.bone); }
  const driven = model.drivenBones || new Set();
  const info = new Map();
  const unused = [];
  const partOf = (b) => { for (let p = b; p && p.isBone; p = p.parent) if (canon.has(p)) return PART[canon.get(p)] || canon.get(p); return null; };
  for (const b of bones) {
    const set = reach(b);
    set.delete(b);
    affects.set(b, set);
    const ownW = weight.get(b) || 0;
    let w = ownW;
    for (const x of set) w += (weight.get(x) || 0) * 0.5;
    const t = textOf(b);
    let role;
    if (canon.has(b)) role = 'body';
    else if (fingerBones.has(b)) role = 'finger';
    else if (driven.has(b) || follows.has(b) || ikChain.has(b)) role = 'auto';
    else if (ikTargets.has(b)) role = 'ik';
    else if (PHYSICS.test(b.name) || PHYSICS.test(t)) role = 'auto';
    else if (!(w > 0)) role = 'unused';
    else role = ownW > 0 ? 'deform' : 'control';
    if (role === 'unused') { unused.push(b); continue; }
    const kind = role === 'control' && (posTargets.has(b) || /^(con|ctrl|ctl|cnt)[._-]|handle|_ctrl$/i.test(b.name)) ? 'move' : 'rotate';
    let region = nameRegion(b);
    // a bone above body bones moves that part of the body (root / center / pelvis bones)
    if (!region && rig) {
      const has = (k) => rig.map[k] && set.has(rig.map[k]);
      if (has('hips') || (has('leftUpperLeg') && has('rightUpperLeg') && (has('spine') || has('chest') || has('head')))) region = 'whole body (root bones)';
      else if (has('leftUpperLeg') && has('rightUpperLeg')) region = 'lower body (pelvis)';
      else if (has('spine') || has('chest') || has('neck') || has('head')) region = 'upper body';
    }
    if (!region) {
      // name says nothing: the region of the bones it moves, or the body part it hangs from
      for (const x of [b, ...set]) { const r = nameRegion(x); if (r && (weight.get(x) || 0) > 0) { region = r; break; } }
    }
    if (!region) region = partOf(b) || 'other';
    if (canon.has(b)) region = PART[canon.get(b)] || region;
    info.set(b, { region, role, kind, weight: ownW, affects: set, follows: follows.get(b) || null });
  }
  // typical movement of handles, from the poses saved in the file
  for (const pose of model.poses || []) for (const d of pose.deltas) {
    const i = info.get(d.node);
    if (i && d.dp.length() > 0) i.rangeCm = Math.max(i.rangeCm || 0, d.dp.length() * 100 * worldScale(model, d.node));
  }
  const res = { info, unused };
  model._rigScan = res;
  model._rigScanN = model.nodeCount;
  return res;
}

// meters per local unit of a bone's parent (models scaled on import)
function worldScale(model, node) {
  const s = new THREE.Vector3(1, 1, 1);
  if (node.parent) node.parent.getWorldScale(s);
  const r = new THREE.Vector3(1, 1, 1);
  model.root.getWorldScale(r);
  return (s.x / (r.x || 1)) || 1;
}

const label = (b) => { const t = translateName(b.name); return t && t !== b.name ? `${b.name} (${t})` : b.name; };

// The bone map for the AI (one line per body part).
export function describeRig(model, { max = 260 } = {}) {
  const { info, unused } = scanRig(model);
  const rig = model.humanoid;
  const byRegion = new Map();
  const auto = [];
  let fingers = 0, n = 0;
  for (const [b, i] of info) {
    if (i.role === 'body') continue;
    if (i.role === 'finger') { fingers++; continue; }
    if (i.role === 'auto' || i.role === 'ik') { auto.push(b); continue; }
    if (!byRegion.has(i.region)) byRegion.set(i.region, []);
    byRegion.get(i.region).push(b);
  }
  const lines = [];
  const order = ['whole body (root bones)', 'upper body', 'lower body (pelvis)', 'lips / mouth', 'jaw', 'tongue', 'teeth', 'cheeks', 'eyes', 'eyelids', 'brows', 'nose', 'ears', 'head', 'hair', 'horns', 'neck', 'breasts', 'chest', 'upper chest', 'belly', 'waist', 'hips', 'butt', 'tail', 'wings', 'skirt / clothes'];
  const regions = [...byRegion.keys()].sort((a, b) => ((order.indexOf(a) + 1) || 99) - ((order.indexOf(b) + 1) || 99));
  for (const r of regions) {
    const list = byRegion.get(r);
    const items = [];
    for (const b of list) {
      if (n >= max) break;
      const i = info.get(b);
      const tag = i.kind === 'move' ? `move${i.rangeCm ? ` ~${i.rangeCm.toFixed(1)} cm` : ''}` : 'rotate';
      const moves = i.role === 'control' && i.affects.size ? `, moves ${[...i.affects].filter((x) => (info.get(x) || {}).weight > 0).slice(0, 3).map((x) => x.name).join('/') || 'its children'}` : '';
      items.push(`${label(b)} [${tag}${moves}]`);
      n++;
    }
    if (items.length) lines.push(`    ${r}: ${items.join(', ')}${list.length > items.length ? `, +${list.length - items.length} more` : ''}`);
  }
  const out = [];
  if (lines.length) out.push(`  Bones you can key with boneKeys, by the body part they move (scanned from this rig's skin weights and constraints; [rotate] = turn it, [move] = a control handle you slide with mx/my/mz, e.g. lip, jaw or eye-target handles; "moves" = the bones it carries along). Root bones move everything below them: for the body use the hips / root params instead:\n${lines.join('\n')}`);
  if (rig) out.push(`  ${fingers ? `${fingers} finger bones: pose them with the finger params (lThumb..rPinky, lSpread/rSpread), not boneKeys.` : 'This rig has no finger bones.'} The body (hips, spine, chest, neck, head, arms, hands, legs, feet) moves with humanoidKeys / handTouches.`);
  if (auto.length) out.push(`  Driven automatically (keys on them are overridden by constraints, IK or physics; move what drives them instead): ${auto.slice(0, 30).map((b) => b.name).join(', ')}${auto.length > 30 ? `, +${auto.length - 30} more` : ''}.`);
  if (unused.length) out.push(`  ${unused.length} bone${unused.length > 1 ? 's move' : ' moves'} nothing (helpers, tips) and can be ignored.`);
  return out.join('\n');
}

// every bone name the AI may key (for checking its answer)
export function keyableBones(model) {
  const { info } = scanRig(model);
  return new Set([...info].filter(([, i]) => i.role === 'deform' || i.role === 'control').map(([b]) => b));
}
