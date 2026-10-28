// Humanoid rig detection, a body-relative "character frame", pose solving,
// clip baking and retargeting between different rigs.
//
// Character space: x = character's left, y = up, z = forward.
// Pose params are rig-independent (degrees / hip-height units), so the same
// motion works on Mixamo, Unreal, Unity/VRM, Rigify, Biped and custom rigs.
import * as THREE from 'three';

export const CANON = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes',
  'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
];

const EXCLUDE = /(twist|roll|ik|pole|target|ctrl|control|mch|helper|corr|jiggle|offset|null|_end$|end$|nub|tip$|socket|weapon|prop|attach|dummy|shadow|bend|share|sleeve|ribbon|breast|bust|hair|cloth|skirt|cape|tail|cancel)/;

// MMD (MikuMikuDance) bone names -> English words the matcher understands.
// Longest names first: 足首 (ankle) before 足 (leg = thigh in MMD).
const JP = [
  ['全ての親', 'master'], ['センター', 'center'], ['グルーブ', 'groove'], ['腰キャンセル', 'helper'], ['キャンセル', 'helper'],
  ['上半身3', 'upper chest'], ['上半身2', 'chest'], ['上半身', 'spine'], ['下半身', 'lowerbody'], ['腰', 'waist'],
  ['首', 'neck'], ['頭', 'head'], ['両目', 'eyes'], ['目', 'eye'],
  ['肩P', 'shoulder helper'], ['肩C', 'shoulder helper'], ['肩', 'shoulder'], ['腕捩', 'twist'], ['手捩', 'twist'], ['捩', 'twist'],
  ['腕', 'upperarm'], ['ひじ', 'elbow'], ['肘', 'elbow'], ['手首', 'wrist'], ['手先', 'tip'], ['ダミー', 'dummy'],
  ['親指', 'thumb'], ['人差指', 'index'], ['人指', 'index'], ['中指', 'middle'], ['薬指', 'ring'], ['小指', 'little'],
  ['足首', 'ankle'], ['足先EX', 'toe'], ['つま先', 'toe'], ['足', 'thigh'], ['ひざ', 'knee'], ['膝', 'knee'],
  ['乳', 'breast'], ['胸', 'breast'], ['髪', 'hair'], ['スカート', 'skirt'], ['ネクタイ', 'tie'], ['リボン', 'ribbon'], ['尻尾', 'tail'], ['しっぽ', 'tail'],
  ['左', 'left'], ['右', 'right'],
].sort((a, b) => b[0].length - a[0].length);
const HAS_JP = /[\u3040-\u30ff\u4e00-\u9fff]/;
const FINGER = /(thumb|index|middle|ring|pinky|little|finger|digit|metacarpal|carpal)/;
// bones under a hand that aren't finger joints (IK handles, MMD guides, twist helpers)
const FINGER_SKIP = /(ik|helper|dummy|twist|guide|target|pole|ctrl|control|mch|split|bend|socket|weapon|prop|attach|ガイド|曲切)/;
function fingerKind(flat) {
  if (/thumb|pollex/.test(flat)) return 'thumb';
  if (/index|pointer|forefinger/.test(flat)) return 'index';
  if (/middle/.test(flat)) return 'middle';
  if (/ring/.test(flat) && !/string|earring/.test(flat)) return 'ring';
  if (/pinky|pinkie|little/.test(flat)) return 'little';
  return null;
}

function words(name) {
  let s = String(name || '');
  if (s.normalize) s = s.normalize('NFKC'); // full-width ＩＫ, １ -> IK, 1
  if (HAS_JP.test(s)) for (const [jp, en] of JP) s = s.split(jp).join(' ' + en + ' ');
  s = s.replace(/^.*[:|]/, ''); // namespaces "mixamorig:Hips", "Armature|Hips"
  s = s.replace(/^(mixamorig\d*|def[-_]|org[-_]|bip0?1|character\d*|cc_base_|rig_|j_bip_|j_)/i, ' ');
  s = s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  s = s.replace(/[._\-:]+/g, ' ').replace(/(\d+)/g, ' $1 ').toLowerCase();
  return s.split(/\s+/).filter(Boolean);
}

function sideOf(ws) {
  if (ws.includes('left') || ws.includes('l') || ws.includes('lf') || ws.includes('lft')) return 'left';
  if (ws.includes('right') || ws.includes('r') || ws.includes('rt') || ws.includes('rgt')) return 'right';
  return '';
}

function partOf(ws) {
  // "d" / "ex": MMD deform bones (左足D, 足先EX)
  const w = ws.filter((x) => !['left', 'right', 'l', 'r', 'lf', 'rt', 'lft', 'rgt', 'bip', 'def', 'jnt', 'joint', 'bone', 'b', 'c', 'j', 'd', 'ex'].includes(x));
  const s = w.join(' ');
  const flat = w.join('');
  if (FINGER.test(flat)) return null;
  if (EXCLUDE.test(flat) && !/^(toe|toes|toebase|foot)$/.test(flat)) return null;
  if (/^(hips?|pelvis|hip|cog|root hips?|center of gravity)$/.test(s) || flat === 'hips') return 'hips';
  if (/^(head)$/.test(s) || /^head( \d)?$/.test(s)) return 'head';
  if (/^neck/.test(s)) return 'neck';
  if (/shoulder|clavicle|collar|clav/.test(flat)) return 'shoulder';
  if (/forearm|lowerarm|lowarm|elbow|radius|ulna|armlower/.test(flat)) return 'lowerArm';
  if (/upperarm|uparm|humerus|bicep|armupper|^arm( \d)?$/.test(flat) || /^arm( \d)?$/.test(s)) return 'upperArm';
  if (/^(hand|wrist|palm)$/.test(flat) || /^hand \d?$/.test(s)) return 'hand';
  if (/thigh|upleg|upperleg|femur|legupper/.test(flat)) return 'upperLeg';
  if (/calf|shin|lowerleg|lowleg|knee|tibia|leglower|^leg( \d)?$/.test(flat) || /^leg( \d)?$/.test(s)) return 'lowerLeg';
  if (/^(foot|ankle)$/.test(flat) || /^foot \d?$/.test(s)) return 'foot';
  if (/^(toe|toes|toebase|ball|toe base)/.test(flat)) return 'toes';
  if (/^(spine|abdomen|torso|waist|stomach|lowerback|back|chest|upperchest|ribs|thorax|spine \d+)/.test(s) || /spine|chest|abdomen|torso|^upperbody/.test(flat)) return 'spine';
  return null;
}

function depth(o) { let d = 0; while (o.parent) { d++; o = o.parent; } return d; }

function isAncestor(a, b) { // a is ancestor of b
  let o = b.parent;
  while (o) { if (o === a) return true; o = o.parent; }
  return false;
}

function pathBetween(anc, desc) { // bones from anc (exclusive) down to desc (exclusive)
  const out = [];
  let o = desc.parent;
  while (o && o !== anc) { out.unshift(o); o = o.parent; }
  return o === anc ? out : null;
}

const _v1 = new THREE.Vector3();

export function detectHumanoid(root, bones, opts = {}) {
  if (!bones || bones.length < 8) return null;
  const rank = opts.rank || (() => 1);
  root.updateMatrixWorld(true);
  const cands = {};
  for (const b of bones) {
    const ws = words(b.name);
    const part = partOf(ws);
    if (!part) continue;
    const side = ['hips', 'spine', 'neck', 'head'].includes(part) ? '' : sideOf(ws);
    if (!side && !['hips', 'spine', 'neck', 'head'].includes(part)) continue;
    const key = side ? side + part[0].toUpperCase() + part.slice(1) : part;
    (cands[key] = cands[key] || []).push(b);
  }
  // MMD English names: "leg" is the thigh when the same side also has a "knee"
  for (const side of ['left', 'right']) {
    const lower = cands[side + 'LowerLeg'];
    if (lower && lower.length > 1 && !(cands[side + 'UpperLeg'] || []).length) {
      const up = lower.filter((a) => lower.some((b) => b !== a && isAncestor(a, b)));
      if (up.length) { cands[side + 'UpperLeg'] = up; cands[side + 'LowerLeg'] = lower.filter((b) => !up.includes(b)); }
    }
  }
  // prefer bones that actually move the mesh (MMD "D" bones over unweighted
  // control bones in exported files; control bones when constraints drive)
  const pick = (key, prefer = 'shallow') => {
    const list = cands[key];
    if (!list || !list.length) return null;
    const usable = list.filter((b) => rank(b) > 0);
    const pool = usable.length ? usable : list;
    return pool.slice().sort((a, b) => (rank(b) - rank(a)) || (prefer === 'shallow' ? depth(a) - depth(b) : depth(b) - depth(a)))[0];
  };
  const map = {};
  for (const side of ['left', 'right']) {
    const S = (p) => side + p;
    map[S('UpperLeg')] = pick(S('UpperLeg'));
    map[S('LowerLeg')] = pick(S('LowerLeg'));
    map[S('Foot')] = pick(S('Foot'));
    map[S('Toes')] = pick(S('Toes'));
    map[S('Shoulder')] = pick(S('Shoulder'));
    map[S('UpperArm')] = pick(S('UpperArm'));
    map[S('LowerArm')] = pick(S('LowerArm'));
    map[S('Hand')] = pick(S('Hand'));
    // fill middle joints from hierarchy when names are odd
    if (map[S('UpperArm')] && map[S('Hand')] && !map[S('LowerArm')]) {
      const p = pathBetween(map[S('UpperArm')], map[S('Hand')]);
      if (p && p.length) map[S('LowerArm')] = p[p.length - 1];
    }
    if (map[S('UpperLeg')] && map[S('Foot')] && !map[S('LowerLeg')]) {
      const p = pathBetween(map[S('UpperLeg')], map[S('Foot')]);
      if (p && p.length) map[S('LowerLeg')] = p[p.length - 1];
    }
    // lower arm must be below upper arm, hand below lower arm, etc.
    const chainOk = (a, b) => !map[S(a)] || !map[S(b)] || isAncestor(map[S(a)], map[S(b)]);
    if (!chainOk('UpperArm', 'LowerArm')) map[S('LowerArm')] = null;
    if (!chainOk('LowerArm', 'Hand')) map[S('Hand')] = null;
    if (!chainOk('UpperLeg', 'LowerLeg')) map[S('LowerLeg')] = null;
    if (!chainOk('LowerLeg', 'Foot')) map[S('Foot')] = null;
    if (!chainOk('Foot', 'Toes')) map[S('Toes')] = null;
    if (map[S('Shoulder')] && map[S('UpperArm')] && !isAncestor(map[S('Shoulder')], map[S('UpperArm')])) map[S('Shoulder')] = null;
  }
  map.head = pick('head');
  map.neck = pick('neck');
  // Rigify / some rigs: head and neck are just the top of the spine chain (spine.004-006)
  if (!map.head && !map.neck && cands.spine && cands.spine.length >= 4) {
    const chainTop = cands.spine.slice().sort((a, b) => depth(b) - depth(a))[0];
    const armRootB = pick('leftShoulder') || pick('leftUpperArm');
    // the head is the deepest spine bone above the shoulders
    if (chainTop && (!armRootB || !isAncestor(chainTop, armRootB))) {
      map.head = chainTop;
      if (chainTop.parent && chainTop.parent.isBone && cands.spine.includes(chainTop.parent) && (!armRootB || !isAncestor(chainTop.parent, armRootB))) map.neck = chainTop.parent;
    }
  }
  // hips: named, or the common ancestor of both legs
  map.hips = pick('hips');
  const lul = map.leftUpperLeg, rul = map.rightUpperLeg;
  const top0 = map.neck || map.head;
  const coversAll = (h) => h && isAncestor(h, lul) && isAncestor(h, rul) && (!top0 || isAncestor(h, top0));
  if (lul && rul && !coversAll(map.hips)) {
    // lowest bone above both legs (and the spine: MMD splits upper/lower body)
    let a = lul.parent;
    while (a && !(isAncestor(a, rul) && (!top0 || isAncestor(a, top0)))) a = a.parent;
    if (a && a.isBone) map.hips = a;
    else if (!map.hips) {
      a = lul.parent;
      while (a && !isAncestor(a, rul)) a = a.parent;
      if (a && a.isBone) map.hips = a;
    }
  }
  if (!map.hips) return null;
  const top = map.neck || map.head;
  if (!top || !isAncestor(map.hips, top)) return null;
  if (!map.head && map.neck) {
    const kids = map.neck.children.filter((c) => c.isBone);
    if (kids.length) map.head = kids[0];
  }
  // spine chain between hips and neck/head
  const chain = (pathBetween(map.hips, top) || []).filter((b) => b.isBone);
  const armRoot = map.leftShoulder || map.leftUpperArm;
  let spineChain = chain;
  if (armRoot) {
    // chest = the spine bone that the arms hang from
    const anc = chain.filter((b) => isAncestor(b, armRoot));
    if (anc.length) spineChain = chain.slice(0, chain.indexOf(anc[anc.length - 1]) + 1);
  }
  if (map.neck && spineChain.includes(map.neck)) spineChain = spineChain.slice(0, spineChain.indexOf(map.neck));
  if (spineChain.length >= 1) map.spine = spineChain[0];
  if (spineChain.length >= 2) map.chest = spineChain[spineChain.length - 1];
  if (spineChain.length >= 3) { map.upperChest = spineChain[spineChain.length - 1]; map.chest = spineChain[Math.floor((spineChain.length - 1) / 2) || 1]; }
  if (!map.neck && chain.length && map.head) {
    const before = pathBetween(map.hips, map.head);
    if (before && before.length && !spineChain.includes(before[before.length - 1])) map.neck = before[before.length - 1];
  }
  // need both sides of at least legs or arms
  const legs = map.leftUpperLeg && map.rightUpperLeg && map.leftLowerLeg && map.rightLowerLeg;
  const arms = map.leftUpperArm && map.rightUpperArm && map.leftLowerArm && map.rightLowerArm;
  if (!legs && !arms) return null;
  for (const k of Object.keys(map)) if (!map[k]) delete map[k];
  return new HumanoidRig(root, bones, map);
}

const AX = new THREE.Vector3(1, 0, 0), AY = new THREE.Vector3(0, 1, 0), AZ = new THREE.Vector3(0, 0, 1);

export class HumanoidRig {
  constructor(root, bones, map) {
    this.root = root;
    this.bones = bones;
    this.map = map;
    this.canonOf = new Map(Object.entries(map).map(([k, b]) => [b, k]));
    this.captureRest();
  }

  // Rest data in root-local space (so moving the model doesn't matter).
  captureRest() {
    const root = this.root;
    root.updateMatrixWorld(true);
    const rootInv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const rootQInv = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().extractRotation(root.matrixWorld)).invert();
    this.rest = new Map();
    const worldQ = (o) => { const q = new THREE.Quaternion(); o.getWorldQuaternion(q); return rootQInv.clone().multiply(q); };
    const posR = (o) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(rootInv);
    for (const b of this.bones) {
      const r = {
        Lq: b.quaternion.clone(),
        Lp: b.position.clone(),
        Wq: worldQ(b),
        Pq: b.parent ? worldQ(b.parent) : new THREE.Quaternion(),
        pos: posR(b),
        parentMatInv: b.parent ? new THREE.Matrix4().multiplyMatrices(rootInv, b.parent.matrixWorld).invert() : new THREE.Matrix4(),
      };
      r.PqInv = r.Pq.clone().invert();
      r.parentPos = b.parent ? posR(b.parent) : new THREE.Vector3();
      r.offLocal = r.pos.clone().sub(r.parentPos).applyQuaternion(r.PqInv);
      this.rest.set(b, r);
    }
    // bone directions (to the next canonical bone or first child)
    const next = {
      leftUpperArm: 'leftLowerArm', leftLowerArm: 'leftHand', rightUpperArm: 'rightLowerArm', rightLowerArm: 'rightHand',
      leftUpperLeg: 'leftLowerLeg', leftLowerLeg: 'leftFoot', rightUpperLeg: 'rightLowerLeg', rightLowerLeg: 'rightFoot',
      leftFoot: 'leftToes', rightFoot: 'rightToes', leftShoulder: 'leftUpperArm', rightShoulder: 'rightUpperArm',
      hips: 'spine', spine: 'chest', chest: 'neck', neck: 'head',
    };
    for (const b of this.bones) {
      const r = this.rest.get(b);
      const c = this.canonOf.get(b);
      let target = c && next[c] && this.map[next[c]] ? this.map[next[c]] : null;
      if (!target) target = b.children.find((ch) => ch.isBone) || null;
      let dirModel;
      if (target) dirModel = this.rest.get(target)?.pos.clone().sub(r.pos) || null;
      if (!dirModel || dirModel.lengthSq() < 1e-10) dirModel = new THREE.Vector3(0, 1, 0).applyQuaternion(r.Wq);
      r.len = dirModel.length();
      r.dirModel = dirModel.normalize();
      r.dirLocal = dirModel.clone().applyQuaternion(r.Wq.clone().invert()).normalize();
    }
    // character frame
    const P = (k) => (this.map[k] ? this.rest.get(this.map[k]).pos : null);
    const hips = P('hips');
    const headP = P('head') || P('neck');
    let up = headP.clone().sub(hips).normalize();
    let lat = null;
    if (P('leftUpperLeg') && P('rightUpperLeg')) lat = P('leftUpperLeg').clone().sub(P('rightUpperLeg'));
    if ((!lat || lat.lengthSq() < 1e-8) && P('leftUpperArm') && P('rightUpperArm')) lat = P('leftUpperArm').clone().sub(P('rightUpperArm'));
    if (!lat || lat.lengthSq() < 1e-8) lat = new THREE.Vector3(1, 0, 0);
    // snap "up" to the model's +Y when close (most rigs)
    if (up.dot(AY) > 0.9) up = AY.clone();
    lat.addScaledVector(up, -lat.dot(up)).normalize();
    const fwd = new THREE.Vector3().crossVectors(lat, up).normalize();
    this.F = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(lat, up, fwd));
    this.Finv = this.F.clone().invert();
    this.up = up; this.lat = lat; this.fwd = fwd;
    // hip height (for translation units)
    let minUp = Infinity;
    for (const k of ['leftFoot', 'rightFoot', 'leftToes', 'rightToes']) if (P(k)) minUp = Math.min(minUp, P(k).dot(up));
    if (!isFinite(minUp)) for (const b of this.bones) minUp = Math.min(minUp, this.rest.get(b).pos.dot(up));
    this.hipHeight = Math.max(hips.dot(up) - minUp, 1e-3);
    this.hipsRestPos = hips.clone();
    // character's height
    this.height = Math.max(headP.dot(up) - minUp, this.hipHeight) * 1.12;
    // hands: finger direction and palm normal (model space, rest)
    this.handAxes = {};
    for (const side of ['left', 'right']) {
      const hb = this.map[side + 'Hand'];
      if (!hb) continue;
      const hr = this.rest.get(hb);
      const kids = hb.children.filter((c) => c.isBone && this.rest.has(c));
      const isThumb = (c) => /thumb|親指|_0?1$|finger_?0\b/i.test(c.name);
      const fingers = kids.filter((c) => !isThumb(c));
      const thumb = kids.find(isThumb);
      let f = new THREE.Vector3();
      const mid = fingers.find((c) => /middle|中指/i.test(c.name));
      if (mid) f.copy(this.rest.get(mid).pos).sub(hr.pos);
      else if (fingers.length) { for (const c of fingers) f.add(this.rest.get(c).pos.clone().sub(hr.pos)); f.divideScalar(fingers.length); }
      const la = this.map[side + 'LowerArm'];
      const forearm = la ? hr.pos.distanceTo(this.rest.get(la).pos) : this.hipHeight * 0.28;
      // palm length: wrist to finger knuckles (about 0.4 of the forearm when there are no finger bones)
      let palmLen = f.length();
      if (!(palmLen > forearm * 0.15 && palmLen < forearm * 0.8)) palmLen = forearm * 0.4;
      if (f.lengthSq() < 1e-12 && la) f.copy(hr.pos).sub(this.rest.get(la).pos);
      if (f.lengthSq() < 1e-12) f.set(side === 'left' ? 1 : -1, 0, 0).applyQuaternion(this.F);
      f.normalize();
      let n;
      if (thumb) {
        const t = this.rest.get(thumb).pos.clone().sub(hr.pos);
        t.addScaledVector(f, -t.dot(f));
        if (t.lengthSq() > 1e-12) n = side === 'left' ? new THREE.Vector3().crossVectors(f, t) : new THREE.Vector3().crossVectors(t, f);
      }
      if (!n || n.lengthSq() < 1e-12) n = this.up.clone().negate(); // T/A-pose: palms face down
      n.addScaledVector(f, -n.dot(f)).normalize();
      // in the hand bone's own frame
      const inv = hr.Wq.clone().invert();
      this.handAxes[side] = { f: f.clone().applyQuaternion(inv), n: n.clone().applyQuaternion(inv), palmLen };
    }
    this._spots = null;
    this._fingers = null;
    this._hands = null;
    this._weighted = null;
    this._scan = null;
    this._skullTop = undefined;
    this._eyes = undefined;
    this._mouth = undefined;
    // direction of each limb in character space (rest)
    this.restDirChar = {};
    for (const k of ['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm', 'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg', 'leftHand', 'rightHand', 'leftFoot', 'rightFoot']) {
      if (this.map[k]) this.restDirChar[k] = this.rest.get(this.map[k]).dirModel.clone().applyQuaternion(this.Finv);
    }
  }

  charToModel(v) { return v.clone().applyQuaternion(this.F); }

  // quaternion from char-space euler degrees [pitch(x), yaw(y), roll(z)] -> model space
  charRot(pitch = 0, yaw = 0, roll = 0) {
    const d = THREE.MathUtils.DEG2RAD;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch * d, yaw * d, roll * d, 'YXZ'));
    return this.F.clone().multiply(q).multiply(this.Finv);
  }

  // Solve a pose spec -> Map<bone, {q, p?}> of local transforms.
  // spec keys are canonical names with {rot:[p,y,r]} | {dir:Vector3(char)} | {bend:deg, front:Vector3(char)},
  // plus hips {pos: Vector3(char, hip-height units)}.
  // Extras: leftHand/rightHand {touch: {spot, weight, offset?}} puts the palm on
  // that spot of the body (IK), spec.plantFeet keeps the feet where they stand.
  solve(specIn) {
    let spec = specIn;
    const touches = ['left', 'right'].filter((s) => spec[s + 'Hand'] && spec[s + 'Hand'].touch && spec[s + 'Hand'].touch.weight > 0 && this.map[s + 'UpperArm'] && this.map[s + 'LowerArm'] && this.map[s + 'Hand']);
    // finger poses first: a fingertip touch needs to know where the tip is
    const heldSides = new Set();
    if (spec.hold && this.map.rightHand && this.map.leftHand) { heldSides.add(spec.hold.side); if (spec.hold.support > 0) heldSides.add(spec.hold.side === 'right' ? 'left' : 'right'); }
    const fingerLocals = {};
    for (const side of ['left', 'right']) if (!heldSides.has(side)) fingerLocals[side] = this.fingerPose(side, this.fingerSpec(side, spec[side + 'Hand']));
    if (!touches.length && !spec.plantFeet && !spec.hold) { const out = this.solveFK(spec).out; this.applyLocals(out, fingerLocals); return out; }
    const merge = (base, extra) => {
      const m = { ...base };
      for (const [k, v] of Object.entries(extra)) m[k] = { ...(base[k] || {}), ...v, rot: k.endsWith('Hand') || k.endsWith('Foot') ? undefined : (base[k] || {}).rot };
      return m;
    };
    // body first (with feet planted), then the hands on top of it
    const body = (sp) => {
      let f = this.solveFK(sp);
      if (sp.plantFeet) {
        const ex = {};
        for (const side of ['left', 'right']) Object.assign(ex, this.plantSpec(side, f));
        sp = merge(sp, ex);
        f = this.solveFK(sp);
      }
      return { sp, f };
    };
    let { sp, f } = body(spec);
    this.lastLean = 0;
    const defOf = (t) => SPOTS[SPOT_ALIAS[t.spot] || t.spot];
    // spots on the legs (thigh) slide up toward the hip when the arm can't
    // reach them, instead of bending the whole body over
    for (const side of touches) {
      const k = side + 'Hand';
      const def = defOf(spec[k].touch);
      if (!def || !def.slide) continue;
      let t = spec[k].touch;
      for (let i = 0; i < 4; i++) {
        const short = this.touchShortfall(side, t, f);
        if (short <= 0) break;
        const off = t.offset ? t.offset.clone() : new THREE.Vector3();
        off.y += Math.min(short / this.hipHeight * 1.05 + 0.005, 0.5);
        t = { ...t, offset: off };
      }
      if (t !== spec[k].touch) spec = { ...spec, [k]: { ...spec[k], touch: t } };
    }
    // spots out of reach that you bend down for (knees): bend at the hips and
    // waist, push the hips back and bend the knees
    if (touches.length) {
      for (let lean = 1; lean <= 10; lean++) {
        const short = Math.max(...touches.map((side) => (defOf(spec[side + 'Hand'].touch) || {}).lean ? this.touchShortfall(side, spec[side + 'Hand'].touch, f) : 0));
        if (short <= 0) break;
        const rot = (k) => (spec[k] && spec[k].rot) || [0, 0, 0];
        const hp = spec.hips && spec.hips.pos ? spec.hips.pos.clone() : new THREE.Vector3();
        hp.y -= 0.024; hp.z -= 0.012;
        spec = {
          ...spec,
          spine: { ...(spec.spine || {}), rot: [rot('spine')[0] + 4, rot('spine')[1], rot('spine')[2]] },
          chest: { ...(spec.chest || {}), rot: [rot('chest')[0] + 2, rot('chest')[1], rot('chest')[2]] },
          hips: { ...(spec.hips || {}), pos: hp, rot: [rot('hips')[0] + 4, rot('hips')[1], rot('hips')[2]] },
          plantFeet: true,
        };
        ({ sp, f } = body(spec));
        this.lastLean = lean;
      }
    }
    const extra = {};
    const held = spec.hold && this.map.rightHand && this.map.leftHand ? spec.hold : null;
    for (const side of touches) {
      if (held && (side === held.side || (held.support > 0 && side !== held.side))) continue; // hands busy holding
      Object.assign(extra, this.touchSpec(side, spec[side + 'Hand'].touch, f, fingerLocals[side]));
    }
    if (held) Object.assign(extra, this.holdSpec(held, f));
    const out = this.solveFK(merge(sp, extra)).out;
    this.applyLocals(out, fingerLocals);
    if (held) {
      this.curlFingers(out, held.side, held.curl ?? 1);
      if (held.support > 0) this.curlFingers(out, held.side === 'right' ? 'left' : 'right', 0.75 * held.support);
    }
    return out;
  }

  solveFK(spec) {
    const out = new Map();
    const cur = new Map();
    const curP = new Map();
    const tmpQ = new THREE.Quaternion();
    // fold rotations of missing canonical bones into their nearest existing parent
    const fold = { upperChest: ['chest', 'spine'], chest: ['spine', 'upperChest'], neck: ['head', 'upperChest', 'chest'], leftShoulder: ['leftUpperArm'], rightShoulder: ['rightUpperArm'] };
    const eff = { ...spec };
    for (const [k, alts] of Object.entries(fold)) {
      if (eff[k] && eff[k].rot && !this.map[k]) {
        const alt = alts.find((a) => this.map[a] && (!eff[a] || !eff[a].dir));
        if (alt) {
          const a = eff[alt] = { ...(eff[alt] || {}) };
          const r = a.rot || [0, 0, 0];
          a.rot = [r[0] + eff[k].rot[0], r[1] + eff[k].rot[1], r[2] + eff[k].rot[2]];
        }
        delete eff[k];
      }
    }
    for (const b of this.bones) {
      const r = this.rest.get(b);
      const parentW = b.parent && cur.has(b.parent) ? cur.get(b.parent) : r.Pq;
      const parentP = b.parent && curP.has(b.parent) ? curP.get(b.parent) : r.parentPos;
      const c = this.canonOf.get(b);
      const s = c ? eff[c] : null;
      let L = r.Lq.clone();
      let pos = null;
      let modelPos = parentP.clone().add(r.offLocal.clone().applyQuaternion(parentW));
      if (s) {
        let target = null;
        if (s.dir) target = this.charToModel(s.dir).normalize();
        else if (s.bend !== undefined) {
          const upper = { leftLowerArm: 'leftUpperArm', rightLowerArm: 'rightUpperArm', leftLowerLeg: 'leftUpperLeg', rightLowerLeg: 'rightUpperLeg' }[c];
          const ub = upper && this.map[upper];
          if (ub && cur.has(ub)) {
            const pDir = this.rest.get(ub).dirLocal.clone().applyQuaternion(cur.get(ub)).normalize();
            const front = this.charToModel(s.front || AZ);
            front.addScaledVector(pDir, -front.dot(pDir));
            if (front.lengthSq() < 1e-6) front.copy(this.charToModel(AY)).addScaledVector(pDir, -this.charToModel(AY).dot(pDir));
            front.normalize();
            const axis = new THREE.Vector3().crossVectors(pDir, front).normalize();
            target = pDir.clone().applyAxisAngle(axis, THREE.MathUtils.degToRad(s.bend));
          }
        }
        if (s.worldRot) {
          // absolute orientation in model space (hands placed on the body, planted feet)
          L = parentW.clone().invert().multiply(s.worldRot);
        } else if (target) {
          const Wun = parentW.clone().multiply(r.Lq);
          const curDir = r.dirLocal.clone().applyQuaternion(Wun).normalize();
          let W = tmpQ.setFromUnitVectors(curDir, target).clone().multiply(Wun);
          if (s.twist) W = new THREE.Quaternion().setFromAxisAngle(target, THREE.MathUtils.degToRad(s.twist)).multiply(W);
          if (s.twistToward) {
            // turn the forearm part of the way toward where the hand must point,
            // so the wrist doesn't twist unnaturally
            const rel = W.clone().invert().multiply(s.twistToward.q);
            const ax = r.dirLocal.clone().normalize();
            const twist = new THREE.Quaternion(rel.x, rel.y, rel.z, rel.w);
            const d = ax.x * twist.x + ax.y * twist.y + ax.z * twist.z;
            twist.set(ax.x * d, ax.y * d, ax.z * d, rel.w).normalize();
            const half = new THREE.Quaternion().slerp(twist, s.twistToward.share ?? 0.5);
            W = W.multiply(half);
          }
          L = parentW.clone().invert().multiply(W);
        }
        if (s.rot) {
          const D = this.charRot(s.rot[0], s.rot[1], s.rot[2]);
          if (target || s.worldRot) {
            // extra rotation applied in the solved frame (e.g. hand twist after aiming)
            const W = parentW.clone().multiply(L);
            L = parentW.clone().invert().multiply(D).multiply(W);
          } else {
            L = r.PqInv.clone().multiply(D).multiply(r.Pq).multiply(r.Lq);
          }
        }
        if (s.pos && c === 'hips') {
          const d = this.charToModel(s.pos).multiplyScalar(this.hipHeight);
          modelPos = r.pos.clone().add(d);
          pos = modelPos.clone().applyMatrix4(r.parentMatInv);
        }
      }
      cur.set(b, parentW.clone().multiply(L));
      curP.set(b, modelPos);
      out.set(b, { q: L, p: pos });
    }
    return { out, cur, curP };
  }

  // two-bone IK: elbow/knee position for a chain from a to goal, bending toward hint
  twoBoneJoint(a, goal, l1, l2, hint) {
    const toT = goal.clone().sub(a);
    const d = THREE.MathUtils.clamp(toT.length(), Math.abs(l1 - l2) + 1e-6, (l1 + l2) * 0.9995);
    const dir = toT.lengthSq() > 1e-14 ? toT.normalize() : hint.clone().normalize();
    const side = hint.clone().addScaledVector(dir, -hint.dot(dir));
    if (side.lengthSq() < 1e-10) side.copy(new THREE.Vector3(0, 0, 1).addScaledVector(dir, -dir.z));
    side.normalize();
    const x = (l1 * l1 - l2 * l2 + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
    return { joint: a.clone().addScaledVector(dir, x).addScaledVector(side, h), end: a.clone().addScaledVector(dir, d) };
  }

  // how far (model units) the wrist goal is beyond the arm's reach
  touchShortfall(side, touch, first) {
    const g = this.touchGoal(side, touch, first);
    if (!g) return 0;
    const ua = this.map[side + 'UpperArm'], la = this.map[side + 'LowerArm'], hb = this.map[side + 'Hand'];
    const reach = this.rest.get(la).pos.distanceTo(this.rest.get(ua).pos) + this.rest.get(hb).pos.distanceTo(this.rest.get(la).pos);
    return first.curP.get(ua).distanceTo(g.wrist) - reach * 0.985;
  }

  touchGoal(side, touch, first) {
    const spot = this.spot(touch.spot, side);
    if (!spot) return null;
    const ref = this.map[spot.ref] || this.map.hips;
    const refW = first.cur.get(ref), refP = first.curP.get(ref);
    const refDelta = refW.clone().multiply(this.rest.get(ref).Wq.clone().invert());
    const toModel = (c) => this.charToModel(c).applyQuaternion(refDelta);
    const contact = spot.local.clone().applyQuaternion(refW).add(refP);
    if (touch.offset) contact.add(toModel(touch.offset).multiplyScalar(this.hipHeight));
    const palm = toModel(spot.palm).normalize();
    // on the way there the hand comes in from outside the body, not through it
    const w = THREE.MathUtils.clamp(touch.weight ?? 1, 0, 1);
    if (w < 1) contact.addScaledVector(palm, -(1 - w) * (1 - w) * 0.35 * this.hipHeight);
    const fing = toModel(spot.fingers);
    fing.addScaledVector(palm, -fing.dot(palm)).normalize();
    const ax = this.handAxes[side];
    const wrist = contact.clone().addScaledVector(palm, -0.22 * ax.palmLen).addScaledVector(fing, -0.55 * ax.palmLen);
    return { spot, contact, palm, fing, wrist, hint: toModel(spot.hint), toModel };
  }

  // spec overrides that put one hand's palm (or a fingertip) on a body spot
  touchSpec(side, touch, first, locals) {
    if (touch.finger && touch.finger !== 'palm' && this.handRig(side)) {
      const r = this.fingerTouchSpec(side, touch, first, locals);
      if (r) return r;
    }
    const g = this.touchGoal(side, touch, first);
    if (!g) return {};
    const { palm, fing, wrist } = g;
    (this.lastTouch || (this.lastTouch = {}))[side] = { contact: g.contact.clone(), palm: palm.clone() };
    return this.reachSpec(side, wrist, this.handFrame(side, fing, palm), g.hint, touch.weight, first, palm.clone().negate());
  }

  // hand world rotation (model space) that puts the fingers along `fing` and the palm facing `palm`
  handFrame(side, fing, palm) {
    const ax = this.handAxes[side];
    const restW = this.rest.get(this.map[side + 'Hand']).Wq;
    const f0 = ax.f.clone().applyQuaternion(restW), n0 = ax.n.clone().applyQuaternion(restW);
    const basis = (f, n) => new THREE.Matrix4().makeBasis(f, n, new THREE.Vector3().crossVectors(f, n));
    const R = new THREE.Quaternion().setFromRotationMatrix(basis(fing, palm).multiply(basis(f0, n0).transpose()));
    return R.multiply(restW);
  }

  // spec overrides that bring one hand's wrist to `wrist` with world rotation
  // `handW` (both model space), elbow toward `hint`; weight blends with the FK pose
  reachSpec(side, wrist, handW, hint, weight, first, away = null) {
    const w = THREE.MathUtils.clamp(weight ?? 1, 0, 1);
    const hb = this.map[side + 'Hand'], ua = this.map[side + 'UpperArm'], la = this.map[side + 'LowerArm'];
    if (!hb || !ua || !la) return {};
    const shoulder = first.curP.get(ua);
    // segment lengths between the canonical joints (twist bones may sit in between)
    const l1 = this.rest.get(la).pos.distanceTo(this.rest.get(ua).pos), l2 = this.rest.get(hb).pos.distanceTo(this.rest.get(la).pos);
    let goal = wrist, mixW = w;
    if (away && w < 1) {
      // touching the body: the wrist travels along a path that bulges away from the
      // body (so the hand doesn't sweep through the face or chest), solved with IK
      const fkWrist = first.curP.get(hb);
      const e = w * w * (3 - 2 * w);
      const dist = fkWrist.distanceTo(wrist);
      goal = fkWrist.clone().lerp(wrist, e).addScaledVector(away, Math.sin(Math.PI * e) * 0.3 * dist + (1 - e) * 0.1 * dist);
      mixW = THREE.MathUtils.smoothstep(w, 0, 0.2);
    }
    const { joint: elbow, end } = this.twoBoneJoint(shoulder, goal, l1, l2, hint);
    // blend with the pose from the regular params while easing in / out
    const fkDir = (b) => this.rest.get(b).dirLocal.clone().applyQuaternion(first.cur.get(b)).normalize();
    const mix = (fk, ik) => fk.clone().lerp(ik, mixW).normalize();
    const upDir = mix(fkDir(ua), elbow.clone().sub(shoulder).normalize());
    const loDir = mix(fkDir(la), end.clone().sub(elbow).normalize());
    let hw = handW.clone();
    if (w < 1) hw = first.cur.get(hb).clone().slerp(hw, away ? Math.min(1, w * 1.5) : w);
    const toChar = (v) => v.clone().applyQuaternion(this.Finv);
    return {
      [side + 'UpperArm']: { dir: toChar(upDir), twist: 0 },
      [side + 'LowerArm']: { dir: toChar(loDir), bend: undefined, twistToward: { q: hw, share: 0.5 } },
      [side + 'Hand']: { worldRot: hw },
    };
  }

  // ---- holding a prop (gun, sword...) attached to a hand bone
  // hold: { side, offsetP, offsetQ (prop in the hand's frame, model units), k (model
  // units per meter), anchors (prop meters), style 'pistol'|'rifle'|'melee',
  // aim 0-1, yaw, pitch (deg), kick {back (m), up (deg)}, support 0-1, curl 0-1 }
  propTransform(hold, first) {
    const side = hold.side;
    const k = hold.k || 1;
    const hh = this.hipHeight;
    const P = (key) => first.curP.get(this.map[key]);
    // aim relative to where the character stands (hips), so a bladed stance
    // (torso turned) doesn't swing the gun off target
    const hipsB = this.map.hips;
    const hd = first.cur.get(hipsB).clone().multiply(this.rest.get(hipsB).Wq.clone().invert());
    const hdUp = this.up.clone().applyQuaternion(hd);
    const yawOnly = new THREE.Quaternion().setFromUnitVectors(hdUp, this.up).multiply(hd); // drop pitch/roll
    const toM = (x, y, z) => this.charToModel(new THREE.Vector3(x, y, z)).applyQuaternion(yawOnly);
    const yaw = (hold.yaw || 0) * D2R, pitch = (hold.pitch || 0) * D2R;
    const fwd = toM(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)).normalize();
    const up0 = toM(0, 1, 0);
    const A = hold.anchors || {};
    const anchor = (name) => (A[name] ? new THREE.Vector3(A[name].x, A[name].y, A[name].z).multiplyScalar(k) : null);
    const ua = this.map[side + 'UpperArm'], la = this.map[side + 'LowerArm'], hb = this.map[side + 'Hand'];
    const armLen = this.rest.get(la).pos.distanceTo(this.rest.get(ua).pos) + this.rest.get(hb).pos.distanceTo(this.rest.get(la).pos);
    const shL = P('leftUpperArm'), shR = P('rightUpperArm');
    const mid = shL.clone().add(shR).multiplyScalar(0.5);
    const lat = toM(1, 0, 0);
    let Rp, at, pivotName;
    const frame = (z, yHint) => {
      const y = yHint.clone().addScaledVector(z, -yHint.dot(z)).normalize();
      const x = new THREE.Vector3().crossVectors(y, z);
      return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
    };
    if (hold.style === 'rifle' && anchor('stock')) {
      // butt in the shoulder pocket, just inside the shooting shoulder
      const sh = side === 'right' ? shR : shL;
      at = sh.clone().addScaledVector(lat, (side === 'right' ? 1 : -1) * 0.07 * hh).addScaledVector(up0, -0.03 * hh).addScaledVector(fwd, 0.02 * hh);
      Rp = frame(fwd, up0);
      pivotName = 'stock';
    } else if (hold.style === 'melee') {
      const sgn = side === 'right' ? -1 : 1; // toward the holding side
      const guardAt = mid.clone().addScaledVector(fwd, 0.45 * armLen).addScaledVector(up0, -0.12 * hh).addScaledVector(lat, sgn * 0.04 * hh);
      const guardUp = up0.clone().multiplyScalar(0.8).addScaledVector(fwd, 0.6).normalize();
      at = guardAt;
      let bladeUp = guardUp;
      const sw = hold.swing;
      if (sw && sw.amount > 0) {
        // a slash: wound up over the shoulder -> through the front -> past the other hip
        const dir = sw.back ? -1 : 1;
        const pts = [
          { p: mid.clone().addScaledVector(lat, sgn * dir * 0.22 * hh).addScaledVector(up0, 0.10 * hh).addScaledVector(fwd, 0.15 * armLen), b: up0.clone().multiplyScalar(0.85).addScaledVector(lat, sgn * dir * 0.3).addScaledVector(fwd, -0.45).normalize() },
          { p: mid.clone().addScaledVector(fwd, 0.85 * armLen).addScaledVector(up0, -0.08 * hh), b: fwd.clone().multiplyScalar(0.95).addScaledVector(up0, 0.3).normalize() },
          { p: mid.clone().addScaledVector(lat, -sgn * dir * 0.18 * hh).addScaledVector(up0, -0.38 * hh).addScaledVector(fwd, 0.45 * armLen), b: fwd.clone().multiplyScalar(0.55).addScaledVector(up0, -0.55).addScaledVector(lat, -sgn * dir * 0.6).normalize() },
        ];
        const ph = THREE.MathUtils.clamp(sw.phase, 0, 1);
        const u = ph < 0.5 ? ph * 2 : (ph - 0.5) * 2;
        const [a, b] = ph < 0.5 ? [pts[0], pts[1]] : [pts[1], pts[2]];
        const swingAt = a.p.clone().lerp(b.p, u);
        const swingUp = a.b.clone().lerp(b.b, u).normalize();
        at = guardAt.clone().lerp(swingAt, sw.amount);
        bladeUp = guardUp.clone().lerp(swingUp, sw.amount).normalize();
      }
      // blade along +Y, edge leading (+Z)
      let edge = fwd.clone().addScaledVector(bladeUp, -fwd.dot(bladeUp));
      if (edge.lengthSq() < 1e-6) edge = up0.clone().negate().addScaledVector(bladeUp, up0.dot(bladeUp));
      edge.normalize();
      Rp = frame(edge, bladeUp);
      pivotName = 'grip';
    } else {
      // pistol: both arms out, the gun on the line of sight
      const two = hold.support > 0;
      at = mid.clone().addScaledVector(fwd, (two ? 0.98 : 1.04) * armLen).addScaledVector(up0, 0.0 * hh);
      if (!two) at.addScaledVector(lat, (side === 'right' ? -1 : 1) * 0.08 * hh);
      Rp = frame(fwd, up0);
      pivotName = 'grip';
    }
    const pivot = anchor(pivotName) || new THREE.Vector3();
    // recoil: muzzle up around the grip, pushed back
    if (hold.kick && (hold.kick.up || hold.kick.back)) {
      const xAxis = new THREE.Vector3(1, 0, 0).applyQuaternion(Rp);
      const gripW = at.clone().add((anchor('grip') || pivot).clone().sub(pivot).applyQuaternion(Rp));
      const q = new THREE.Quaternion().setFromAxisAngle(xAxis, -(hold.kick.up || 0) * D2R);
      at.sub(gripW).applyQuaternion(q).add(gripW);
      Rp = q.multiply(Rp);
      at.addScaledVector(fwd, -(hold.kick.back || 0) * k);
    }
    const Pp = at.clone().sub(pivot.clone().applyQuaternion(Rp));
    return { Pp, Rp, fwd, up: up0, lat, anchor };
  }

  holdSpec(hold, first) {
    const side = hold.side, other = side === 'right' ? 'left' : 'right';
    const m = side === 'right' ? -1 : 1; // character x of the holding side
    const out = {};
    const aim = THREE.MathUtils.clamp(hold.aim ?? 0, 0, 1);
    const support = THREE.MathUtils.clamp(hold.support ?? 0, 0, 1);
    if (aim <= 0 && support <= 0) return out;
    const g = this.propTransform(hold, first);
    const { Pp, Rp } = g;
    // holding hand: exact, through the attachment offset
    const oQ = new THREE.Quaternion(hold.offsetQ.x, hold.offsetQ.y, hold.offsetQ.z, hold.offsetQ.w);
    const oP = new THREE.Vector3(hold.offsetP.x, hold.offsetP.y, hold.offsetP.z);
    const handW = Rp.clone().multiply(oQ.clone().invert());
    const wrist = Pp.clone().sub(oP.clone().applyQuaternion(handW));
    const hintM = (x, y, z) => this.charToModel(new THREE.Vector3(x, y, z));
    const hintMain = hold.style === 'rifle' ? hintM(m * 1, -0.25, -0.2) : hold.style === 'melee' ? hintM(m * 0.6, -1, 0) : hintM(m * 0.35, -1, -0.1);
    if (aim > 0) Object.assign(out, this.reachSpec(side, wrist, handW, hintMain, aim, first));
    // support hand on the prop's support anchor
    const sup = g.anchor('support');
    if (support > 0 && sup) {
      const contact = Pp.clone().add(sup.clone().applyQuaternion(Rp));
      const toW = (v) => new THREE.Vector3(v[0], v[1], v[2]).applyQuaternion(Rp).normalize();
      const mo = -m; // other side's x sign
      let palm, fing;
      if (hold.style === 'rifle') { palm = toW([-0.25 * mo, 0.95, 0.1]); fing = toW([-0.85 * mo, 0.35, 0.35]); }
      else if (hold.style === 'melee') { palm = toW([-mo * 0.9, 0, 0.4]); fing = toW([-0.4 * mo, -0.2, 0.9]); }
      else { palm = toW([-0.9 * mo, 0.35, 0.1]); fing = toW([-0.45 * mo, -0.8, 0.35]); }
      fing.addScaledVector(palm, -fing.dot(palm)).normalize();
      const ax = this.handAxes[other];
      const w2 = contact.clone().addScaledVector(palm, -0.22 * ax.palmLen).addScaledVector(fing, -0.55 * ax.palmLen);
      const hintSup = hold.style === 'rifle' ? hintM(-m * 0.3, -1, 0.1) : hintM(-m * 0.35, -1, -0.1);
      Object.assign(out, this.reachSpec(other, w2, this.handFrame(other, fing, palm), hintSup, support, first));
    }
    // look down the sights
    if (aim > 0 && hold.style !== 'melee') {
      const add = (k, r) => { out[k] = { rot: r } };
      if (hold.style === 'rifle') { add('neck', [6 * aim, m * -4 * aim, m * 6 * aim]); add('head', [6 * aim, 0, m * 4 * aim]); }
      else { add('neck', [2 * aim, 0, 0]); }
    }
    return out;
  }

  // curl the finger bones of one hand around a grip (thumb left alone)
  curlFingers(out, side, amount) {
    if (!(amount > 0)) return;
    const list = this.fingerList(side);
    for (const fgr of list) {
      const o = out.get(fgr.bone);
      if (!o) continue;
      o.q = o.q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(fgr.axis, fgr.angle * amount));
    }
  }

  fingerList(side) {
    if (!this._fingers) this._fingers = {};
    if (this._fingers[side]) return this._fingers[side];
    const hb = this.map[side + 'Hand'];
    const ax = this.handAxes && this.handAxes[side];
    const list = [];
    if (hb && ax) {
      const restW = this.rest.get(hb).Wq;
      // curl axis: turns finger direction toward the palm
      const axisW = new THREE.Vector3().crossVectors(ax.f, ax.n).normalize().applyQuaternion(restW);
      const walk = (b, depth) => {
        for (const c of b.children) {
          if (!c.isBone || !this.rest.has(c)) continue;
          const ws = words(c.name);
          const flat = ws.join('');
          if (/(ik|helper|dummy|twist|tip|end|nub|guide|target)/.test(flat)) continue;
          const finger = FINGER.test(flat);
          if (finger && !/thumb/.test(flat)) {
            const base = ws.includes('0') || /metacarpal|carpal/.test(flat);
            const deg = /index/.test(flat) ? 52 : 72;
            const angle = (base ? 0.25 : depth === 0 ? 0.9 : 1) * deg * D2R;
            const axis = axisW.clone().applyQuaternion(this.rest.get(c).Wq.clone().invert()).normalize();
            list.push({ bone: c, axis, angle });
          }
          if (finger || depth === 0) walk(c, depth + (finger ? 1 : 0));
        }
      };
      walk(hb, 0);
    }
    this._fingers[side] = list;
    return list;
  }

  // ---- hands: finger chains found by name (any naming: Mixamo, VRM, Rigify, MMD,
  // Unreal...) or by shape, with their curl / spread axes and fingertips.
  // -> { chains: {thumb|index|middle|ring|little: {bones: [{bone, role, ang, curlL, spreadL, spreadF, acrossL}], path, tipLocal, len}}, n, f, t }
  handRig(side) {
    if (!this._hands) this._hands = {};
    if (this._hands[side] !== undefined) return this._hands[side];
    const hb = this.map[side + 'Hand'], ax = this.handAxes && this.handAxes[side];
    let res = null;
    try { if (hb && ax) res = this.buildHandRig(side, hb, ax); } catch (e) { console.warn('hand rig', e); }
    this._hands[side] = res;
    return res;
  }

  weightedSet() {
    if (this._weighted) return this._weighted;
    const set = new Set();
    this.root.traverse((o) => {
      if (!o.isSkinnedMesh || !o.skeleton) return;
      const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
      if (!si || !sw) return;
      const used = new Uint8Array(o.skeleton.bones.length);
      for (let i = 0; i < si.count; i++) for (let k = 0; k < 4; k++) if (sw.getComponent(i, k) > 1e-3) used[si.getComponent(i, k)] = 1;
      o.skeleton.bones.forEach((b, i) => { if (used[i]) set.add(b); });
    });
    for (const b of this.bones) if (b.children.some((c) => !c.isBone && (c.isMesh || c.children.length))) set.add(b);
    this._weighted = set;
    return set;
  }

  buildHandRig(side, hb, ax) {
    const hr = this.rest.get(hb);
    const nW = ax.n.clone().applyQuaternion(hr.Wq).normalize();
    const fW = ax.f.clone().applyQuaternion(hr.Wq).normalize();
    const weighted = this.weightedSet();
    const anyWeights = weighted.size > 0;
    const named = { thumb: [], index: [], middle: [], ring: [], little: [] };
    const tipBones = {};
    const visit = (b) => {
      for (const c of b.children) {
        if (!c.isBone || !this.rest.has(c)) continue;
        const flat = words(c.name).join('');
        if (FINGER_SKIP.test(flat)) continue;
        const which = fingerKind(flat);
        if (which) { if (/(tip|end|nub|top)$/.test(flat)) tipBones[which] = c; else named[which].push(c); }
        visit(c);
      }
    };
    visit(hb);
    // one parent-to-child chain per finger
    const chainOf = (list) => {
      if (!list.length) return [];
      const sorted = list.slice().sort((a, b) => depth(a) - depth(b));
      const chain = [sorted[0]];
      for (;;) {
        const cur = chain[chain.length - 1];
        const next = sorted.filter((b) => !chain.includes(b) && isAncestor(cur, b)).sort((a, b) => depth(a) - depth(b))[0];
        if (!next) break;
        chain.push(next);
      }
      return chain;
    };
    const chains = {};
    for (const k of Object.keys(named)) { const c = chainOf(named[k]); if (c.length) chains[k] = c; }
    // no finger names: chains under the hand, told apart by where they sit
    if (!Object.keys(chains).length) {
      const roots = [];
      const collect = (b, d) => {
        for (const c of b.children) {
          if (!c.isBone || !this.rest.has(c)) continue;
          const flat = words(c.name).join('');
          if (FINGER_SKIP.test(flat)) continue;
          const ch = [c];
          let x = c;
          for (;;) { const kids = x.children.filter((k) => k.isBone && this.rest.has(k)); if (kids.length !== 1) break; x = kids[0]; ch.push(x); }
          if (ch.length >= 2) roots.push(ch);
          else if (d < 1) collect(c, d + 1);
        }
      };
      collect(hb, 0);
      if (roots.length >= 2) {
        const hp = hr.pos;
        const ang = (ch) => { const v = this.rest.get(ch[0]).pos.clone().sub(hp); const w = this.rest.get(ch[ch.length - 1]).pos.clone().sub(this.rest.get(ch[0]).pos); return w.normalize().angleTo(fW); };
        let thumb = null;
        if (roots.length >= 3) { thumb = roots.slice().sort((a, b) => ang(b) - ang(a))[0]; if (ang(thumb) < 0.5) thumb = null; }
        const others = roots.filter((c) => c !== thumb);
        const tSide = this.thumbSide(side, nW, fW, thumb ? this.rest.get(thumb[0]).pos : null, hp);
        others.sort((a, b) => this.rest.get(b[0]).pos.clone().sub(hp).dot(tSide) - this.rest.get(a[0]).pos.clone().sub(hp).dot(tSide));
        if (thumb) chains.thumb = thumb;
        ['index', 'middle', 'ring', 'little'].slice(0, others.length).forEach((k, i) => { chains[k] = others[i]; });
        if (others.length > 4) chains.little = others[others.length - 1];
      }
    }
    if (!Object.keys(chains).length) return null;
    const tW = this.thumbSide(side, nW, fW, chains.thumb ? this.rest.get(chains.thumb[0]).pos : null, hr.pos);
    const SPREAD = { index: 1, middle: 0.1, ring: -0.8, little: -1.5 };
    const out = { chains: {}, n: nW, f: fW, t: tW };
    for (const [k, list0] of Object.entries(chains)) {
      let list = list0.slice();
      // an unweighted leaf at the end is a tip marker (Mixamo "Index4"), not a joint
      let tipBone = tipBones[k] || null;
      if (list.length >= 2 && anyWeights) {
        const last = list[list.length - 1];
        if (!weighted.has(last) && !last.children.some((c) => c.isBone)) { tipBone = tipBone || last; list = list.slice(0, -1); }
      }
      const pts = list.map((b) => this.rest.get(b).pos);
      const segs = [];
      for (let i = 0; i < pts.length - 1; i++) segs.push(pts[i + 1].clone().sub(pts[i]));
      let lastLen = 0, lastDir = null;
      if (tipBone) { const v = this.rest.get(tipBone).pos.clone().sub(pts[pts.length - 1]); if (v.length() > 1e-6) { lastLen = v.length(); lastDir = v.normalize(); } }
      const prev = segs.length ? segs[segs.length - 1] : null;
      if (!lastDir) {
        lastDir = prev ? prev.clone().normalize() : fW.clone();
        const bl = list[list.length - 1].userData && list[list.length - 1].userData.rest && list[list.length - 1].userData.rest.len;
        const guess = prev ? prev.length() * 0.85 : ax.palmLen * 0.35;
        lastLen = bl > guess * 0.4 && bl < guess * 2.5 ? bl : guess;
      }
      segs.push(lastDir.clone().multiplyScalar(lastLen));
      // joint roles: metacarpal (barely bends), then the three phalanges
      const n = list.length;
      const nameMeta = (b) => { const ws = words(b.name); return ws.includes('0') || /metacarpal|palm|carpal/.test(ws.join('')); };
      const roles = [];
      const thumb = k === 'thumb';
      let metas = thumb ? (n >= 3 ? n - 2 : 0) : Math.max(0, n - 3);
      if (!thumb && n === 3 && nameMeta(list[0])) metas = 1;
      for (let i = 0; i < n; i++) roles.push(i < metas ? 'meta' : ['prox', 'mid', 'dist'][Math.min(2, thumb ? (i - metas) * 2 : i - metas)]);
      const ANG = thumb ? { meta: 20, prox: 42, mid: 55, dist: 55 } : { meta: k === 'little' ? 8 : k === 'ring' ? 5 : 2, prox: 82, mid: 100, dist: 68 };
      if (!thumb && n - metas === 2) { ANG.prox = 85; ANG.mid = 110; }
      const bones = list.map((b, i) => {
        const Wq = this.rest.get(b).Wq;
        const inv = Wq.clone().invert();
        const d = segs[i].clone().normalize();
        let curlW = new THREE.Vector3().crossVectors(d, nW);
        if (curlW.lengthSq() < 0.05) curlW.crossVectors(fW, nW);
        curlW.normalize();
        const e = { bone: b, role: roles[i], ang: ANG[roles[i]], curlL: curlW.applyQuaternion(inv).normalize() };
        const first = thumb ? i === 0 : roles[i] === 'prox' && (i === 0 || roles[i - 1] === 'meta');
        if (first) {
          // spread: turn about the palm normal, + toward the thumb side
          const toward = new THREE.Vector3().crossVectors(nW, d).dot(tW) >= 0 ? 1 : -1;
          if (!thumb) { e.spreadL = nW.clone().multiplyScalar(toward).applyQuaternion(inv).normalize(); e.spreadF = SPREAD[k] ?? 0; }
          else e.acrossL = nW.clone().multiplyScalar(-toward).applyQuaternion(inv).normalize(); // thumb folds across the palm
        }
        return e;
      });
      const lastB = list[n - 1];
      out.chains[k] = {
        bones,
        path: pathBetween(hb, list[0]) || [],
        tipLocal: segs[n - 1].clone().applyQuaternion(this.rest.get(lastB).Wq.clone().invert()),
        len: segs.reduce((a, v) => a + v.length(), 0) - (metas ? segs.slice(0, metas).reduce((a, v) => a + v.length(), 0) : 0),
      };
    }
    return out;
  }

  // unit vector (model, rest) from the palm's middle toward the thumb
  thumbSide(side, nW, fW, thumbPos, handPos) {
    let t = side === 'left' ? new THREE.Vector3().crossVectors(nW, fW) : new THREE.Vector3().crossVectors(fW, nW);
    if (thumbPos) {
      const v = thumbPos.clone().sub(handPos);
      v.addScaledVector(fW, -v.dot(fW));
      if (v.lengthSq() > 1e-12 && v.dot(t) < 0) t.negate();
    }
    return t.normalize();
  }

  // finger values for one hand: params, or an automatic hand shape while a fingertip touches
  fingerSpec(side, hand) {
    if (!hand) return null;
    let F = hand.fingers ? { ...hand.fingers } : null;
    const t = hand.touch;
    if (t && t.weight > 0 && t.finger && t.finger !== 'palm' && !hand.fingersSet) {
      const use = t.finger === 'two' ? ['index', 'middle'] : [t.finger];
      const auto = { thumb: use.includes('thumb') ? 0.05 : 0.55, index: 0.85, middle: 0.85, ring: 0.9, little: 0.95, spread: 0 };
      for (const u of use) auto[u] = t.mode === 'pad' ? 0.1 : 0.04;
      if (t.finger === 'two') auto.spread = 0;
      F = F || { thumb: 0, index: 0, middle: 0, ring: 0, little: 0, spread: 0 };
      const w = THREE.MathUtils.clamp(t.weight, 0, 1);
      for (const k of Object.keys(auto)) F[k] = (F[k] || 0) + (auto[k] - (F[k] || 0)) * w;
    }
    return F;
  }

  // local rotations of the finger bones for {thumb, index, middle, ring, little: curl 0 (rest) .. 1 (fist), spread: degrees}
  fingerPose(side, F) {
    if (!F) return null;
    const H = this.handRig(side);
    if (!H) return null;
    const out = new Map();
    const any = ['thumb', 'index', 'middle', 'ring', 'little', 'spread'].some((k) => Math.abs(F[k] || 0) > 1e-4);
    if (!any) return null;
    for (const [k, ch] of Object.entries(H.chains)) {
      const curl = THREE.MathUtils.clamp(Number(F[k]) || 0, -0.35, 1.25);
      for (const e of ch.bones) {
        const q = this.rest.get(e.bone).Lq.clone();
        if (e.spreadL && F.spread) q.multiply(new THREE.Quaternion().setFromAxisAngle(e.spreadL, THREE.MathUtils.clamp(F.spread, -25, 40) * e.spreadF * D2R));
        if (e.acrossL && curl > 0) q.multiply(new THREE.Quaternion().setFromAxisAngle(e.acrossL, 28 * curl * D2R));
        if (curl) q.multiply(new THREE.Quaternion().setFromAxisAngle(e.curlL, e.ang * curl * D2R));
        out.set(e.bone, q);
      }
    }
    return out;
  }

  applyLocals(out, bySide) {
    for (const locals of Object.values(bySide || {})) {
      if (!locals) continue;
      for (const [b, q] of locals) { const o = out.get(b); if (o) o.q = q.clone(); }
    }
  }

  // fingertip (and finger root) in the hand bone's own frame, for a finger pose
  fingertip(side, finger, locals) {
    const H = this.handRig(side);
    const ch = H && H.chains[finger];
    if (!ch) return null;
    let pos = new THREE.Vector3(), Q = new THREE.Quaternion(), root = null;
    for (const b of [...ch.path, ...ch.bones.map((e) => e.bone)]) {
      const r = this.rest.get(b);
      pos = pos.clone().add(r.offLocal.clone().applyQuaternion(Q));
      if (!root && ch.bones.some((e) => e.bone === b && e.role !== 'meta')) root = pos.clone();
      Q = Q.clone().multiply((locals && locals.get(b)) || r.Lq);
    }
    const tip = pos.clone().add(ch.tipLocal.clone().applyQuaternion(Q));
    root = root || pos.clone();
    return { tip, root, dir: tip.clone().sub(root).normalize(), len: Math.max(tip.distanceTo(root), 1e-4), lastQ: Q };
  }

  // spec overrides that put a fingertip (or a finger's pad) on a body spot, e.g. the lips
  fingerTouchSpec(side, touch, first, locals) {
    const g = this.touchGoal(side, touch, first);
    if (!g) return null;
    const H = this.handRig(side);
    const use = touch.finger === 'two' ? ['index', 'middle'] : [touch.finger];
    const tips = use.map((f) => this.fingertip(side, f, locals)).filter(Boolean);
    if (!tips.length) return null;
    const avg = (key) => tips.reduce((a, t) => a.add(t[key]), new THREE.Vector3()).divideScalar(tips.length);
    const tip = avg('tip'), root = avg('root');
    const len = tips.reduce((a, t) => a + t.len, 0) / tips.length;
    const dirL = tip.clone().sub(root).normalize();
    const m = side === 'left' ? 1 : -1;
    const key = SPOT_ALIAS[touch.spot] || touch.spot;
    const def = SPOTS[key] || {};
    const pad = touch.mode === 'pad';
    // which way the finger points and the palm faces (model space)
    let D, P;
    if (pad) { D = g.fing.clone(); P = g.palm.clone(); if (def.pad) { D = g.toModel(def.pad(m)).normalize(); } }
    else {
      D = def.tip ? g.toModel(def.tip(m)).normalize() : g.palm.clone();
      P = g.toModel(def.tipPalm ? def.tipPalm(m) : new THREE.Vector3(-m * 0.55, -0.83, 0)).normalize();
    }
    P.addScaledVector(D, -P.dot(D));
    if (P.lengthSq() < 1e-6) P.copy(g.fing).addScaledVector(D, -g.fing.dot(D));
    P.normalize();
    // hand-local axes: the finger, and the palm normal square to it
    const nL = this.handAxes[side].n.clone();
    nL.addScaledVector(dirL, -nL.dot(dirL));
    if (nL.lengthSq() < 1e-8) return null;
    nL.normalize();
    const basis = (a, b) => new THREE.Matrix4().makeBasis(a, b, new THREE.Vector3().crossVectors(a, b));
    const R = basis(D, P).multiply(basis(dirL, nL).transpose());
    const handW = new THREE.Quaternion().setFromRotationMatrix(R);
    // the point that touches: the tip, pushed in by depth (a fraction of the finger), or the pad
    const depthF = THREE.MathUtils.clamp(Number(touch.depth) || 0, 0, 0.8);
    const refLocal = pad ? root.clone().lerp(tip, 0.72).addScaledVector(nL, 0.12 * len) : tip;
    const contact = g.contact.clone();
    if (!pad) contact.addScaledVector(D, depthF * len - 0.004 * this.hipHeight);
    const wrist = contact.clone().sub(refLocal.clone().applyQuaternion(handW));
    (this.lastTouch || (this.lastTouch = {}))[side] = { contact: contact.clone(), palm: P.clone(), finger: use.join('+'), tipLocal: refLocal.clone() };
    void H;
    return this.reachSpec(side, wrist, handW, g.hint, touch.weight, first, g.palm.clone().negate());
  }

  // keep a foot where it stands at rest (legs bend to follow the hips)
  plantSpec(side, first) {
    const ul = this.map[side + 'UpperLeg'], ll = this.map[side + 'LowerLeg'], ft = this.map[side + 'Foot'];
    if (!ul || !ll || !ft) return {};
    const hip = first.curP.get(ul);
    const H0 = this.rest.get(ul).pos, K0 = this.rest.get(ll).pos, F0 = this.rest.get(ft).pos;
    const goal = F0.clone();
    const l1 = K0.distanceTo(H0), l2 = F0.distanceTo(K0);
    // which way the knee bends: the way it does at rest (some rigs have slightly
    // backward knees), turning toward the front as the hips drop and the knee
    // has to bend more. So a standing pose keeps the legs exactly as they were.
    const hb = this.map.hips;
    const pelvis = hb && first.cur.get(hb) ? first.cur.get(hb).clone().multiply(this.rest.get(hb).Wq.clone().invert()) : new THREE.Quaternion();
    const fwd = this.charToModel(new THREE.Vector3(0, 0, 1)).applyQuaternion(pelvis);
    let hint = fwd;
    const line0 = F0.clone().sub(H0).normalize();
    const off0 = K0.clone().sub(H0);
    off0.addScaledVector(line0, -off0.dot(line0));
    const dir = goal.clone().sub(hip);
    if (off0.length() > 1e-4 * (l1 + l2) && dir.lengthSq() > 1e-12) {
      dir.normalize();
      const perp = (v) => v.clone().addScaledVector(dir, -v.dot(dir));
      const a = perp(off0.normalize().applyQuaternion(pelvis)), b = perp(fwd);
      if (a.lengthSq() > 1e-10 && b.lengthSq() > 1e-10) {
        a.normalize(); b.normalize();
        let t = THREE.MathUtils.clamp((F0.distanceTo(H0) - goal.distanceTo(hip)) / (0.06 * (l1 + l2)), 0, 1);
        t = t * t * (3 - 2 * t);
        const ang = Math.atan2(new THREE.Vector3().crossVectors(a, b).dot(dir), a.dot(b));
        hint = a.applyAxisAngle(dir, ang * t);
      }
    }
    const { joint: knee, end } = this.twoBoneJoint(hip, goal, l1, l2, hint);
    const toChar = (v) => v.clone().applyQuaternion(this.Finv);
    return {
      [side + 'UpperLeg']: { dir: toChar(knee.clone().sub(hip).normalize()) },
      [side + 'LowerLeg']: { dir: toChar(end.clone().sub(knee).normalize()), bend: undefined },
      [side + 'Foot']: { worldRot: this.rest.get(ft).Wq.clone() },
    };
  }

  // ---- body spots a hand can touch, measured on this character's mesh
  spot(name, side) {
    const key = SPOT_ALIAS[name] || name;
    const def = SPOTS[key];
    if (!def) return null;
    if (!this._spots) this._spots = new Map();
    const id = key + ':' + side;
    if (!this._spots.has(id)) this._spots.set(id, this.measureSpot(key, def, side));
    return this._spots.get(id);
  }

  measureSpot(key, def, side) {
    const m = side === 'left' ? 1 : -1;
    const hh = this.hipHeight;
    const P = (k) => (this.map[k] ? this.rest.get(this.map[k]).pos : null);
    const hips = this.hipsRestPos;
    const upOf = (p) => (p ? p.clone().sub(hips).dot(this.up) / hh : 0);
    const latOf = (p) => (p ? p.clone().sub(hips).dot(this.lat) / hh : 0);
    const legY = (upOf(P('leftUpperLeg')) + upOf(P('rightUpperLeg'))) / 2 || -0.08;
    const legX = Math.abs(latOf(P('leftUpperLeg')) - latOf(P('rightUpperLeg'))) / 2 || 0.1;
    const chestY = upOf(P('upperChest') || P('chest') || P('spine')) || 0.45;
    const neckY = upOf(P('neck') || P('head')) || chestY + 0.3;
    const headY = upOf(P('head')) || neckY + 0.1;
    const shX = Math.abs(latOf(P('leftUpperArm')) - latOf(P('rightUpperArm'))) / 2 || 0.25;
    const charPt = (x, y, z) => hips.clone().add(this.charToModel(new THREE.Vector3(x, y, z)).multiplyScalar(hh));
    const fwdOf = (p) => (p ? p.clone().sub(hips).dot(this.fwd) / hh : 0);
    // top of the skull, measured on the mesh (hair ignored) so big-headed
    // characters get their face found; skeleton estimate when there's no mesh
    if (this._skullTop === undefined) {
      this._skullTop = null;
      const hp = P('head');
      if (hp) {
        const zH = fwdOf(hp);
        let best = null;
        for (const dz of [0, 0.04, -0.04]) {
          const h = this.surfaceHit(charPt(0, upOf(hp) + 3, zH + dz), this.charToModel(new THREE.Vector3(0, -1, 0)).normalize(), 'face');
          const y = h ? upOf(h.point) : null;
          if (y !== null && y > upOf(hp) + 0.04 && y < upOf(hp) + 1.2 && (best === null || y > best)) best = y;
        }
        this._skullTop = best;
      }
    }
    const headTop = this._skullTop ?? headY + Math.max(0.18, (headY - neckY) * 2.2);
    const kneeY = upOf(P(side + 'LowerLeg')) || -0.5;
    const hipX = Math.abs(latOf(P(side + 'UpperLeg'))) || legX;
    const kneeX = P(side + 'LowerLeg') ? Math.abs(latOf(P(side + 'LowerLeg'))) : hipX;
    const shY = (upOf(P('leftUpperArm')) + upOf(P('rightUpperArm'))) / 2 || neckY - 0.05;
    // eyes: from eye bones when the rig has them
    if (this._eyes === undefined) {
      this._eyes = null;
      const eyes = [];
      if (this.map.head) this.map.head.traverse((o) => { if (o.isBone && o !== this.map.head && EYE_RE.test(o.name) && !NOT_EYE_RE.test(o.name) && sideOf(words(o.name))) eyes.push(this.rest.get(o).pos); });
      if (eyes.length >= 2) this._eyes = { y: eyes.reduce((a, p) => a + upOf(p), 0) / eyes.length, x: eyes.reduce((a, p) => a + Math.abs(latOf(p)), 0) / eyes.length };
    }
    if (this._mouth === undefined) {
      this._mouth = null;
      const ms = [];
      if (this.map.head) this.map.head.traverse((o) => { if (o.isBone && o !== this.map.head && MOUTH_RE.test(o.name) && !/tongue|舌|corner|角/i.test(o.name)) ms.push(this.rest.get(o)?.pos); });
      const ys = ms.filter(Boolean).map(upOf);
      if (ys.length) this._mouth = ys.reduce((a, b) => a + b, 0) / ys.length;
    }
    const headH = headTop - headY;
    let eyeY = this._eyes ? this._eyes.y : headY + headH * 0.45;
    if (!(eyeY > headY + headH * 0.15 && eyeY < headTop - headH * 0.1)) eyeY = headY + headH * 0.45;
    let eyeX = this._eyes ? this._eyes.x : headH * 0.18;
    if (!(eyeX > headH * 0.05 && eyeX < headH * 0.45)) eyeX = headH * 0.18;
    let mouthY = this._mouth ?? headY + (eyeY - headY) * 0.38;
    if (!(mouthY > headY - headH * 0.15 && mouthY < eyeY - headH * 0.04)) mouthY = headY + (eyeY - headY) * 0.38;
    const ctx = { m, legY, legX, hipX, kneeX, chestY, neckY, headY, headTop, eyeY, eyeX, shX, shY, kneeY, side, mouthY };
    const g = def.at(ctx); // {y, x, from: 'front'|'back'|'side'|'top', depth (fallback), z?}
    const region = def.region || g.region || 'torso';
    // depth is measured from the body part the spot sits on (heads and knees
    // are often forward of the hips)
    const refKey = this.map[def.ref(side)] ? def.ref(side) : 'hips';
    const z0 = fwdOf(this.rest.get(this.map[refKey]).pos);
    const gz = (g.z ?? 0) + z0;
    // cast rays at the body to find its surface there
    const dirs = { front: [0, 0, -1], back: [0, 0, 1], side: [-m, 0, 0], top: [0, -1, 0] };
    const dc = new THREE.Vector3(...dirs[g.from]);
    const expected = new THREE.Vector3(g.x, g.y, gz).addScaledVector(dc, -(g.depth ?? 0.12));
    const expectedM = charPt(expected.x, expected.y, expected.z);
    // two directions across the ray, to try nearby rays when one slips past
    const u = g.from === 'side' ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0);
    const w = new THREE.Vector3().crossVectors(dc, u).normalize();
    let hit = null, bestD = Infinity;
    for (const [a, b] of [[0, 0], [0.03, 0], [-0.03, 0], [0, 0.03], [0, -0.03], [0.06, 0], [-0.06, 0]]) {
      const st = new THREE.Vector3(g.x, g.y, gz).addScaledVector(dc, -3).addScaledVector(u, a).addScaledVector(w, b);
      const h = this.surfaceHit(charPt(st.x, st.y, st.z), this.charToModel(dc).normalize(), region);
      // ignore hits far from where that body part should be (ray slipped past it)
      const d = h ? h.point.distanceTo(expectedM) : Infinity;
      if (d < 0.3 * hh && d < bestD) { hit = h; bestD = d; }
      if (hit && a === 0 && b === 0) break;
    }
    let point, normalC = null;
    if (hit) {
      point = hit.point;
      normalC = hit.normal.clone().applyQuaternion(this.Finv);
      if (normalC.dot(dc) > 0) normalC.negate();
    } else {
      // no mesh hit: estimate from the skeleton
      point = expectedM.clone();
    }
    point.add(this.charToModel(normalC || dc.clone().negate()).multiplyScalar(((def.standoff ? def.standoff(m) : 0) + 0.006) * hh)); // rest on the skin
    // palm: face the surface (blend of the measured normal and the usual hand pose)
    const palm = def.palm(m).normalize();
    if (normalC) palm.lerp(normalC.clone().negate(), 0.5).normalize();
    const ref = this.map[def.ref(side)] ? def.ref(side) : 'hips';
    const rr = this.rest.get(this.map[ref]);
    return {
      ref,
      local: point.clone().sub(rr.pos).applyQuaternion(rr.Wq.clone().invert()),
      palm,
      fingers: def.fingers(m),
      hint: def.hint(m),
      hit: !!hit,
    };
  }

  // first body-surface hit along a ray (model space), ignoring arms/hands (and hair unless asked)
  surfaceHit(origin, dir, region) {
    if (!this._scan) {
      // what counts as body: skinned meshes and parts riding on bones (not props
      // standing around in the scene)
      const meshes = [];
      let skinned = false;
      this.root.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
      this.root.traverse((o) => {
        if (!(o.isSkinnedMesh || o.isMesh) || o.userData.helper) return;
        let v = true, onBone = false;
        for (let p = o; p; p = p.parent) { if (!p.visible) v = false; if (p !== o && p.isBone) onBone = true; }
        if (v && (o.isSkinnedMesh || onBone || !skinned)) meshes.push(o);
      });
      const arm = new Set();
      for (const k of ['leftUpperArm', 'rightUpperArm']) {
        const b = this.map[k];
        if (b) b.traverse((o) => { if (o.isBone) arm.add(o); });
      }
      const head = new Set(), hair = new Set();
      if (this.map.head) this.map.head.traverse((o) => { if (o.isBone) head.add(o); });
      for (const b of head) if (b !== this.map.head && HAIR_RE.test(b.name)) b.traverse((o) => { if (o.isBone) hair.add(o); });
      this._scan = { meshes, arm, head, hair };
    }
    const { meshes, arm, head, hair } = this._scan;
    if (!meshes.length) return null;
    // 'head': anything on the head (hair too); 'face': the head without hair; 'torso': the rest
    const okBone = (b) => b && !arm.has(b) && (region === 'head' ? head.has(b) : region === 'face' ? head.has(b) && !hair.has(b) : !head.has(b));
    // measure in the rest pose
    const saved = this.bones.map((b) => [b, b.position.clone(), b.quaternion.clone()]);
    for (const b of this.bones) { const r = this.rest.get(b); b.quaternion.copy(r.Lq); b.position.copy(r.Lp); }
    this.root.updateMatrixWorld(true);
    for (const o of meshes) if (o.isSkinnedMesh) { o.skeleton.update(); o.boundingSphere = null; o.boundingBox = null; }
    let best = null;
    try {
      const M = this.root.matrixWorld;
      const ray = new THREE.Raycaster(origin.clone().applyMatrix4(M), dir.clone().transformDirection(M), 0, Infinity);
      const hits = ray.intersectObjects(meshes, false);
      const inv = new THREE.Matrix4().copy(M).invert();
      for (const h of hits) {
        const o = h.object;
        let bone = null;
        if (o.isSkinnedMesh && h.face) {
          const si = o.geometry.attributes.skinIndex, sw = o.geometry.attributes.skinWeight;
          if (si && sw) {
            let bi = 0, bw = -1;
            for (let k = 0; k < 4; k++) { const wv = sw.getComponent(h.face.a, k); if (wv > bw) { bw = wv; bi = si.getComponent(h.face.a, k); } }
            bone = o.skeleton.bones[bi];
          }
        } else {
          for (let p = o.parent; p; p = p.parent) if (p.isBone) { bone = p; break; }
          if (!bone) bone = this.map.hips;
        }
        if (!okBone(bone)) continue;
        const n = h.face ? h.face.normal.clone().transformDirection(o.matrixWorld).transformDirection(inv) : dir.clone().negate();
        best = { point: h.point.clone().applyMatrix4(inv), normal: n.normalize() };
        break;
      }
    } catch (e) { console.warn('surface ray', e); }
    for (const [b, p, q] of saved) { b.position.copy(p); b.quaternion.copy(q); }
    this.root.updateMatrixWorld(true);
    for (const o of meshes) if (o.isSkinnedMesh) { o.skeleton.update(); o.boundingSphere = null; o.boundingBox = null; }
    return best;
  }

  // root-space world rotation of a bone in a solved pose (bones not in it keep their rest)
  solvedWorld(solved) {
    const memo = new Map();
    const W = (b) => {
      if (memo.has(b)) return memo.get(b);
      const r = this.rest.get(b);
      const parentW = b.parent && b.parent.isBone && this.rest.has(b.parent) ? W(b.parent) : r.Pq;
      const v = solved.get(b);
      const q = parentW.clone().multiply(v ? v.q : r.Lq);
      memo.set(b, q);
      return q;
    };
    return W;
  }

  apply(solved) {
    for (const [b, v] of solved) {
      b.quaternion.copy(v.q);
      if (v.p) b.position.copy(v.p);
    }
    this.root.updateMatrixWorld(true);
  }

  // Bake a function of time -> spec into an AnimationClip.
  bake(name, duration, specAt, fps = 30, opts = {}) {
    const n = Math.max(2, Math.round(duration * fps) + 1);
    const times = [];
    const qTracks = new Map();
    const pTracks = new Map();
    const hipsPos = [];
    const used = new Set();
    let prev = new Map();
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * duration;
      times.push(t);
      const spec = specAt(t);
      for (const k of Object.keys(spec)) if (this.map[k]) used.add(this.map[k]);
      const solved = this.solve(spec);
      if (opts.post) opts.post(solved, t, spec);
      for (const [b, v] of solved) {
        if (v.p && b !== this.map.hips) {
          let pa = pTracks.get(b);
          if (!pa) { pa = []; for (let j = 0; j < i; j++) pa.push(...this.rest.get(b).Lp.toArray()); pTracks.set(b, pa); }
          pa.push(v.p.x, v.p.y, v.p.z);
        } else if (pTracks.has(b)) pTracks.get(b).push(...this.rest.get(b).Lp.toArray());
        let arr = qTracks.get(b);
        if (!arr) qTracks.set(b, (arr = []));
        const q = v.q.clone();
        const p = prev.get(b);
        if (p && p.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
        prev.set(b, q);
        arr.push(q.x, q.y, q.z, q.w);
      }
      const hb = this.map.hips;
      const hv = solved.get(hb);
      hipsPos.push(...(hv && hv.p ? hv.p.toArray() : this.rest.get(hb).Lp.toArray()));
    }
    const tracks = [];
    for (const [b, vals] of qTracks) {
      // skip bones that never move
      if (!used.has(b) && !opts.allBones) {
        // keep it if it ever leaves its rest pose (a held grip doesn't change over time)
        // (rest rotations read from files aren't always exactly unit length: compare
        // normalized, or float noise turns into tracks on IK handles that switch the rig's IK on)
        const rq = this.rest.get(b).Lq;
        const rl = rq.length() || 1;
        let moved = false;
        for (let i = 0; i < vals.length && !moved; i += 4) {
          const l = Math.hypot(vals[i], vals[i + 1], vals[i + 2], vals[i + 3]) * rl;
          if (Math.abs(vals[i] * rq.x + vals[i + 1] * rq.y + vals[i + 2] * rq.z + vals[i + 3] * rq.w) < l * (1 - 1e-7)) moved = true;
        }
        if (!moved) continue;
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(b.uuid + '.quaternion', times, vals));
    }
    for (const [b, vals] of pTracks) {
      const L = this.rest.get(b).Lp;
      let moved = false;
      for (let i = 0; i < vals.length && !moved; i += 3) if (Math.abs(vals[i] - L.x) + Math.abs(vals[i + 1] - L.y) + Math.abs(vals[i + 2] - L.z) > 1e-7) moved = true;
      if (moved) tracks.push(new THREE.VectorKeyframeTrack(b.uuid + '.position', times.slice(), vals));
    }
    let hipsMoves = false;
    for (let i = 3; i < hipsPos.length; i++) if (Math.abs(hipsPos[i] - hipsPos[i % 3]) > 1e-6) { hipsMoves = true; break; }
    if (hipsMoves) tracks.push(new THREE.VectorKeyframeTrack(this.map.hips.uuid + '.position', times, hipsPos));
    return new THREE.AnimationClip(name, duration, tracks);
  }

  // Current pose of a bone relative to rest, in character-space quaternion
  deltaChar(bone) {
    const r = this.rest.get(bone);
    const W = this.worldQ(bone);
    const D = W.multiply(r.Wq.clone().invert());
    return this.Finv.clone().multiply(D).multiply(this.F);
  }

  worldQ(o) {
    const rootQInv = new THREE.Quaternion();
    this.root.getWorldQuaternion(rootQInv).invert();
    const q = new THREE.Quaternion();
    o.getWorldQuaternion(q);
    return rootQInv.multiply(q);
  }

  posModel(o) {
    const inv = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    return new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv);
  }
}

// ---- spots a hand can touch ----
// at(): where to aim (x = character's left, y = up from the hips, in hip-height
// units) and which way to look for the surface. palm/fingers/hint are the wanted
// palm normal (pointing into the body), finger direction and elbow direction.
const V = (x, y, z) => new THREE.Vector3(x, y, z);
// eye bones (not brows, lids or highlights)
const EYE_RE = /eye|目|瞳/i;
// lips / mouth bones (not the tongue)
const MOUTH_RE = /lip|mouth|口|唇|teeth|歯/i;
const NOT_EYE_RE = /brow|lash|lid|light|眉|まぶた|ハイライト|^(con|mch|ctrl)[._]/i;
// hair-like bones (romaji, Japanese, English)
const HAIR_RE = /hair|kami|ahoge|bang|fringe|ponytail|twintail|tail_?hair|髪|アホ毛|あほ毛|もみあげ|ポニ|ツイン|おさげ/i;

export const SPOTS = {
  lap: { label: 'lap (below the belly)', ref: () => 'hips', at: (c) => ({ x: c.m * c.legX * 0.35, y: c.legY + 0.02, from: 'front', depth: 0.12 }), palm: () => V(0, -0.35, -1), fingers: (m) => V(-m * 0.5, -0.85, 0.15), hint: (m) => V(m * 0.85, -0.35, -0.45) },
  belly: { label: 'belly', ref: () => 'spine', at: (c) => ({ x: c.m * c.legX * 0.3, y: c.legY + (c.chestY - c.legY) * 0.42, from: 'front', depth: 0.15 }), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.9, -0.3, 0), hint: (m) => V(m * 0.9, -0.4, -0.3) },
  chest: { label: 'chest', ref: () => 'chest', at: (c) => ({ x: c.m * c.shX * 0.35, y: c.chestY + (c.neckY - c.chestY) * 0.3, from: 'front', depth: 0.17 }), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.6, 0.75, 0), hint: (m) => V(m * 0.7, -0.7, 0) },
  heart: { label: 'heart (left side of the chest)', ref: () => 'chest', at: (c) => ({ x: c.shX * 0.35, y: c.chestY + (c.neckY - c.chestY) * 0.3, from: 'front', depth: 0.17 }), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.5, 0.8, 0), hint: (m) => V(m * 0.6, -0.8, 0) },
  hip: { label: 'hip (side of the waist)', ref: () => 'hips', at: (c) => ({ x: c.m * 0.2, y: c.legY + 0.14, from: 'side', depth: 0.06 }), palm: (m) => V(-m, 0, 0), fingers: () => V(0, -0.45, 0.9), hint: (m) => V(m, 0, -0.35) },
  thigh: { label: 'front of the thigh', slide: true, ref: (s) => s + 'UpperLeg', at: (c) => ({ x: c.m * (c.hipX + (c.kneeX - c.hipX) * 0.35), y: c.legY + (c.kneeY - c.legY) * 0.35, from: 'front', depth: 0.08 }), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.15, -1, 0.1), hint: (m) => V(m * 0.6, -0.2, -0.75) },
  knee: { label: 'knee', lean: true, ref: (s) => s + 'LowerLeg', at: (c) => ({ x: c.m * c.kneeX, y: c.kneeY + 0.02, from: 'front', depth: 0.07 }), palm: () => V(0, -0.6, -0.8), fingers: () => V(0, -0.7, 0.7), hint: (m) => V(m * 0.8, 0.2, -0.3) },
  back: { label: 'lower back (behind the back)', ref: () => 'spine', at: (c) => ({ x: c.m * c.legX * 0.3, y: c.legY + (c.chestY - c.legY) * 0.25, from: 'back', depth: 0.11 }), palm: () => V(0, 0, 1), fingers: (m) => V(-m * 0.75, -0.6, 0), hint: (m) => V(m * 0.6, -0.4, -0.8) },
  head: { label: 'top of the head', ref: () => 'head', region: 'head', at: (c) => ({ x: c.m * 0.03, y: c.headTop - 0.06, z: 0, from: 'top', depth: 0.06 }), palm: () => V(0, -1, 0), fingers: (m) => V(-m * 0.8, 0, 0.5), hint: (m) => V(m, 0.5, 0) },
  mouth: { label: 'mouth / lips (for a finger to the lips or in the mouth use finger "index" with mode "tip"; "pad" lays the finger across the lips, like "shh")', ref: () => 'head', region: 'face', at: (c) => ({ x: 0, y: c.mouthY, from: 'front', depth: 0.08 }), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.8, 0.5, 0), hint: (m) => V(m * 0.55, -0.8, 0.25), tip: (m) => V(m * 0.12, 0.18, -1), tipPalm: (m) => V(-m * 0.55, -0.83, 0), pad: (m) => V(-m * 0.12, 1, 0.05) },
  nose: { label: 'nose', ref: () => 'head', region: 'face', at: (c) => ({ x: 0, y: c.mouthY + (c.eyeY - c.mouthY) * 0.55, from: 'front', depth: 0.1 }), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.5, 0.8, 0), hint: (m) => V(m * 0.55, -0.8, 0.25), tip: (m) => V(m * 0.1, 0.1, -1), tipPalm: (m) => V(-m * 0.55, -0.83, 0) },
  face: { label: 'whole face (palm over the mouth / face)', ref: () => 'head', region: 'face', at: (c) => ({ x: 0, y: c.headY + (c.headTop - c.headY) * 0.28, from: 'front', depth: 0.1 }), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.8, 0.5, 0), hint: (m) => V(m * 0.5, -0.8, 0.3) },
  cheek: { label: 'cheek', ref: () => 'head', region: 'face', at: (c) => ({ x: c.m * 0.06, y: c.headY + (c.headTop - c.headY) * 0.32, z: 0.03, from: 'side', depth: 0.02 }), palm: (m) => V(-m, 0, -0.2), fingers: () => V(0, 1, 0.15), hint: (m) => V(m * 0.4, -0.9, 0.2) },
  chin: { label: 'chin (resting the chin on the hand)', ref: () => 'head', region: 'face', at: (c) => ({ x: 0, y: c.headY + (c.headTop - c.headY) * 0.12, from: 'front', depth: 0.08 }), palm: () => V(0, 0.6, -0.8), fingers: (m) => V(-m * 0.5, 0.5, 0.6), hint: (m) => V(m * 0.3, -0.9, 0.3) },
  forehead: { label: 'forehead', ref: () => 'head', region: 'face', at: (c) => ({ x: 0, y: c.eyeY + (c.headTop - c.eyeY) * 0.45, from: 'front', depth: 0.1 }), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.85, 0.5, 0), hint: (m) => V(m * 0.6, -0.6, 0.4) },
  eyes: { label: 'eyes (covering them)', ref: () => 'head', region: 'face', at: (c) => ({ x: c.m * c.eyeX, y: c.eyeY, from: 'front', depth: 0.1 }), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.35, 0.95, 0), hint: (m) => V(m * 0.5, -0.8, 0.3) },
  ear: { label: 'ear (side of the head)', ref: () => 'head', region: 'face', at: (c) => ({ x: c.m * c.eyeX, y: c.eyeY - (c.eyeY - c.headY) * 0.25, z: -0.02, from: 'side', depth: 0.05 }), palm: (m) => V(-m, 0, 0), fingers: () => V(0, 1, 0.1), hint: (m) => V(m * 0.7, -0.6, 0.1) },
  backOfHead: { label: 'back of the head (hands behind the head)', ref: () => 'head', region: 'head', at: (c) => ({ x: c.m * c.eyeX * 0.6, y: c.eyeY, from: 'back', depth: 0.1 }), palm: () => V(0, 0, 1), fingers: (m) => V(-m * 0.85, 0.5, 0), hint: (m) => V(m, 0.35, 0.15) },
  neck: { label: 'neck (front)', ref: () => 'neck', at: (c) => ({ x: c.m * 0.01, y: c.neckY + (c.headY - c.neckY) * 0.5, from: 'front', depth: 0.05 }), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.8, 0.45, 0), hint: (m) => V(m * 0.6, -0.8, 0.2) },
  crossed: { label: 'arms crossed (hand tucked at the other arm)', ref: () => 'chest', at: (c) => ({ x: -c.m * c.shX * 0.75, y: c.chestY - (c.chestY - c.legY) * 0.12 + c.m * 0.02, from: 'front', depth: 0.15 }), standoff: (m) => (m < 0 ? 0.06 : 0), palm: () => V(0, 0, -1), fingers: (m) => V(-m * 0.9, 0.1, -0.3), hint: (m) => V(m * 0.7, -0.6, 0.35) },
  shoulder: { label: 'the other shoulder', ref: () => 'chest', at: (c) => ({ x: -c.m * c.shX * 0.6, y: c.shY, from: 'top', depth: 0.04 }), palm: () => V(0, -1, 0.1), fingers: (m) => V(-m * 0.3, -0.2, -0.9), hint: (m) => V(m * 0.3, -0.6, 0.7) },
};
export const SPOT_ALIAS = {
  brow: 'forehead', eye: 'eyes', ears: 'ear', backofhead: 'backOfHead', nape: 'backOfHead', throat: 'neck', crossedarms: 'crossed', arms: 'crossed',
  lowerbelly: 'lap', underbelly: 'lap', abdomen: 'belly', stomach: 'belly', tummy: 'belly', waist: 'hip', hips: 'hip', side: 'hip',
  breast: 'chest', heart: 'heart', lips: 'mouth', lip: 'mouth', jaw: 'chin', leg: 'thigh', thighs: 'thigh', knees: 'knee', lowerback: 'back', behind: 'back',
};

// ---- pose param helpers (used by the motion library and the AI) ----

const D2R = THREE.MathUtils.DEG2RAD;

// Arm direction: raise = degrees out from hanging down (90 = T-pose, 180 = straight up),
// swing = degrees forward (+) / backward (-).
export function armDir(side, raise, swing) {
  const s = side === 'left' ? 1 : -1;
  const v = new THREE.Vector3(0, -1, 0);
  v.applyAxisAngle(AZ, s * raise * D2R);
  v.applyAxisAngle(AX, -swing * D2R);
  return v;
}

// Leg direction: swing forward (+) / back (-), spread outward
export function legDir(side, swing, spread) {
  const s = side === 'left' ? 1 : -1;
  const v = new THREE.Vector3(0, -1, 0);
  v.applyAxisAngle(AZ, s * spread * D2R);
  v.applyAxisAngle(AX, -swing * D2R);
  return v;
}

export const POSE_PARAMS = {
  hipsX: [0, 'hips sideways shift (hip-height units, + = character left)'],
  hipsY: [0, 'hips up/down (hip-height units, -0.4 = deep crouch)'],
  hipsZ: [0, 'hips forward/back (hip-height units)'],
  hipsPitch: [0, 'pelvis tilt forward (+)'], hipsYaw: [0, 'pelvis turn left (+)'], hipsRoll: [0, 'pelvis roll'],
  spinePitch: [0, 'lower spine bend forward (+) / back (-)'], spineYaw: [0, 'lower spine twist left (+)'], spineRoll: [0, 'lower spine side bend'],
  chestPitch: [0, 'chest bend forward (+)'], chestYaw: [0, 'chest twist left (+)'], chestRoll: [0, 'chest side bend'],
  neckPitch: [0, 'neck bend forward (+)'], neckYaw: [0, 'neck turn left (+)'],
  headPitch: [0, 'head nod down (+) / up (-)'], headYaw: [0, 'head turn left (+)'], headRoll: [0, 'head tilt'],
  lShoulder: [0, 'left shoulder shrug up (+)'], rShoulder: [0, 'right shoulder shrug up (+)'],
  lArmRaise: [8, 'left upper arm: 0 = hanging down, 90 = out to the side (T-pose), 180 = straight up'],
  lArmSwing: [0, 'left upper arm swing forward (+) / backward (-)'],
  lArmTwist: [0, 'left upper arm twist'],
  lElbow: [12, 'left elbow bend 0..150'],
  lElbowUp: [0, 'left elbow bend plane: 0 = forearm moves forward, 1 = forearm moves up (waving), -1 = inward (clapping)'],
  lHandPitch: [0, 'left wrist bend'], lHandYaw: [0, 'left wrist side'], lHandRoll: [0, 'left wrist twist'],
  rArmRaise: [8, 'right upper arm (same as left)'], rArmSwing: [0, ''], rArmTwist: [0, ''], rElbow: [12, ''], rElbowUp: [0, ''],
  rHandPitch: [0, ''], rHandYaw: [0, ''], rHandRoll: [0, ''],
  lThumb: [0, 'left thumb curl: 0 = as at rest (straight), 1 = folded into the palm'],
  lIndex: [0, 'left index finger curl 0..1 (1 = fully curled into a fist)'], lMiddle: [0, 'left middle finger curl 0..1'], lRing: [0, 'left ring finger curl 0..1'], lPinky: [0, 'left little finger curl 0..1'],
  lSpread: [0, 'left fingers spread apart (degrees, 0-30; negative = pressed together)'],
  rThumb: [0, 'right thumb curl (same as left)'], rIndex: [0, ''], rMiddle: [0, ''], rRing: [0, ''], rPinky: [0, ''], rSpread: [0, ''],
  lLegSwing: [0, 'left thigh swing forward (+) / back (-)'], lLegSpread: [4, 'left thigh out to the side'],
  lKnee: [3, 'left knee bend 0..150'], lFootPitch: [0, 'left ankle: toes down (+) / up (-)'],
  rLegSwing: [0, ''], rLegSpread: [4, ''], rKnee: [3, ''], rFootPitch: [0, ''],
  rootX: [0, 'whole character moves left (+) (hip-height units)'],
  rootZ: [0, 'whole character moves forward (+) (hip-height units)'],
  rootYaw: [0, 'whole character turns left (+) degrees'],
};

export function defaultParams() {
  const o = {};
  for (const [k, [v]] of Object.entries(POSE_PARAMS)) o[k] = v;
  return o;
}

// Turn flat params into a solver spec
export function paramsToSpec(p) {
  const spec = {};
  const elbowFront = (up) => {
    const f = new THREE.Vector3(0, 0, 1);
    if (up > 0) f.lerp(new THREE.Vector3(0, 1, 0), Math.min(1, up));
    return f;
  };
  const inward = (side, amt) => new THREE.Vector3(side === 'left' ? -1 : 1, 0, 0).lerp(new THREE.Vector3(0, 0, 1), 1 - Math.min(1, amt));
  // root yaw/translation are applied on hips (rotation folds the whole body)
  spec.hips = {
    rot: [p.hipsPitch, p.hipsYaw + p.rootYaw, p.hipsRoll],
    pos: new THREE.Vector3(p.hipsX + p.rootX, p.hipsY, p.hipsZ + p.rootZ),
  };
  spec.spine = { rot: [p.spinePitch, p.spineYaw, p.spineRoll] };
  spec.chest = { rot: [p.chestPitch, p.chestYaw, p.chestRoll] };
  spec.neck = { rot: [p.neckPitch, p.neckYaw, 0] };
  spec.head = { rot: [p.headPitch, p.headYaw, p.headRoll] };
  spec.leftShoulder = { rot: [0, 0, -p.lShoulder] };
  spec.rightShoulder = { rot: [0, 0, p.rShoulder] };
  for (const [side, s] of [['left', 'l'], ['right', 'r']]) {
    spec[side + 'UpperArm'] = { dir: armDir(side, p[s + 'ArmRaise'], p[s + 'ArmSwing']), twist: p[s + 'ArmTwist'] || 0 };
    const up = p[s + 'ElbowUp'] || 0;
    spec[side + 'LowerArm'] = { bend: p[s + 'Elbow'], front: up < 0 ? inward(side, -up) : elbowFront(up) };
    spec[side + 'Hand'] = { rot: [p[s + 'HandPitch'], p[s + 'HandYaw'], p[s + 'HandRoll']] };
    const fingers = { thumb: p[s + 'Thumb'] || 0, index: p[s + 'Index'] || 0, middle: p[s + 'Middle'] || 0, ring: p[s + 'Ring'] || 0, little: p[s + 'Pinky'] || 0, spread: p[s + 'Spread'] || 0 };
    if (Object.values(fingers).some((v) => Math.abs(v) > 1e-4)) spec[side + 'Hand'].fingers = fingers;
    if (p[s + 'FingersSet']) spec[side + 'Hand'].fingersSet = true;
    const touch = p[s + 'Touch'];
    if (touch && touch.spot && touch.weight > 0) spec[side + 'Hand'].touch = touch;
    spec[side + 'UpperLeg'] = { dir: legDir(side, p[s + 'LegSwing'], p[s + 'LegSpread']) };
    spec[side + 'LowerLeg'] = { bend: p[s + 'Knee'], front: new THREE.Vector3(0, 0, -1) };
    spec[side + 'Foot'] = { rot: [p[s + 'FootPitch'], 0, 0] };
  }
  if (p.plantFeet) spec.plantFeet = true;
  if (p.hold) spec.hold = p.hold;
  return spec;
}

// ---- retargeting ----

// Bake `clip` (playing on srcRig's root) onto dstRig. Both must be HumanoidRigs.
export function retargetClip(srcRig, clip, dstRig, opts = {}) {
  const fps = opts.fps || 30;
  const mixer = new THREE.AnimationMixer(srcRig.root);
  // save source pose
  const saved = srcRig.bones.map((b) => [b, b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
  const action = mixer.clipAction(clip);
  action.play();
  const duration = clip.duration || 1;
  const n = Math.max(2, Math.round(duration * fps) + 1);
  const keys = Object.keys(dstRig.map).filter((k) => srcRig.map[k]);
  const limb = new Set(['leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm', 'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg']);
  // rest alignment for limbs: rotate dst rest dir onto src rest dir (in char space)
  const align = {};
  for (const k of keys) {
    if (limb.has(k) && srcRig.restDirChar[k] && dstRig.restDirChar[k]) {
      const q = new THREE.Quaternion().setFromUnitVectors(dstRig.restDirChar[k].clone().normalize(), srcRig.restDirChar[k].clone().normalize());
      align[k] = dstRig.F.clone().multiply(q).multiply(dstRig.Finv);
    }
  }
  const mirror = !!opts.mirror;
  const swapSide = (k) => (k.startsWith('left') ? 'right' + k.slice(4) : k.startsWith('right') ? 'left' + k.slice(5) : k);
  const times = [];
  const tracks = new Map();
  const hipsPos = [];
  const prevQ = new Map();
  const srcRootInv = new THREE.Matrix4();
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * duration;
    times.push(t);
    mixer.setTime(t);
    srcRig.root.updateMatrixWorld(true);
    if (srcRig.afterEvaluate) srcRig.afterEvaluate(clip);
    srcRootInv.copy(srcRig.root.matrixWorld).invert();
    // source deltas in char space
    const deltas = {};
    for (const k of keys) {
      const sk = mirror ? swapSide(k) : k;
      const sb = srcRig.map[sk];
      if (!sb) continue;
      let d = srcRig.deltaChar(sb);
      if (mirror) d = new THREE.Quaternion(d.x, -d.y, -d.z, d.w);
      deltas[k] = d;
    }
    // hips translation
    let hipOffset = new THREE.Vector3();
    {
      const hp = srcRig.posModel(srcRig.map.hips).sub(srcRig.hipsRestPos).applyQuaternion(srcRig.Finv).divideScalar(srcRig.hipHeight);
      if (mirror) hp.x = -hp.x;
      hipOffset = hp;
    }
    // solve destination top-down
    const cur = new Map();
    for (const b of dstRig.bones) {
      const r = dstRig.rest.get(b);
      const parentW = b.parent && cur.has(b.parent) ? cur.get(b.parent) : r.Pq;
      const c = dstRig.canonOf.get(b);
      let L = r.Lq;
      if (c && deltas[c]) {
        const Dm = dstRig.F.clone().multiply(deltas[c]).multiply(dstRig.Finv);
        let Wt = Dm.multiply(align[c] ? align[c].clone().multiply(r.Wq) : r.Wq.clone());
        L = parentW.clone().invert().multiply(Wt);
      }
      const W = parentW.clone().multiply(L);
      cur.set(b, W);
      const q = L.clone();
      const pq = prevQ.get(b);
      if (pq && pq.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
      prevQ.set(b, q);
      let arr = tracks.get(b);
      if (!arr) tracks.set(b, (arr = []));
      arr.push(q.x, q.y, q.z, q.w);
    }
    const hr = dstRig.rest.get(dstRig.map.hips);
    const p = hr.pos.clone().add(dstRig.charToModel(hipOffset).multiplyScalar(dstRig.hipHeight)).applyMatrix4(hr.parentMatInv);
    hipsPos.push(p.x, p.y, p.z);
  }
  action.stop();
  mixer.uncacheRoot(srcRig.root);
  for (const [b, p, q, s] of saved) { b.position.copy(p); b.quaternion.copy(q); b.scale.copy(s); }
  srcRig.root.updateMatrixWorld(true);
  const out = [];
  const mapped = new Set(keys.map((k) => dstRig.map[k]));
  for (const [b, vals] of tracks) {
    if (!mapped.has(b)) continue;
    out.push(new THREE.QuaternionKeyframeTrack(b.uuid + '.quaternion', times, vals));
  }
  if (opts.rootMotion !== false) out.push(new THREE.VectorKeyframeTrack(dstRig.map.hips.uuid + '.position', times, hipsPos));
  return new THREE.AnimationClip(opts.name || clip.name, duration, out);
}
