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
  solve(spec) {
    const out = new Map();
    const cur = new Map();
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
      const c = this.canonOf.get(b);
      const s = c ? eff[c] : null;
      let L = r.Lq.clone();
      let pos = null;
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
        if (target) {
          const Wun = parentW.clone().multiply(r.Lq);
          const curDir = r.dirLocal.clone().applyQuaternion(Wun).normalize();
          let W = tmpQ.setFromUnitVectors(curDir, target).clone().multiply(Wun);
          if (s.twist) W = new THREE.Quaternion().setFromAxisAngle(target, THREE.MathUtils.degToRad(s.twist)).multiply(W);
          L = parentW.clone().invert().multiply(W);
        }
        if (s.rot) {
          const D = this.charRot(s.rot[0], s.rot[1], s.rot[2]);
          if (target) {
            // extra rotation applied in the solved frame (e.g. hand twist after aiming)
            const W = parentW.clone().multiply(L);
            L = parentW.clone().invert().multiply(D).multiply(W);
          } else {
            L = r.PqInv.clone().multiply(D).multiply(r.Pq).multiply(r.Lq);
          }
        }
        if (s.pos && c === 'hips') {
          const d = this.charToModel(s.pos).multiplyScalar(this.hipHeight);
          pos = r.pos.clone().add(d).applyMatrix4(r.parentMatInv);
        }
      }
      cur.set(b, parentW.clone().multiply(L));
      out.set(b, { q: L, p: pos });
    }
    return out;
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
    const hipsPos = [];
    const used = new Set();
    let prev = new Map();
    for (let i = 0; i < n; i++) {
      const t = (i / (n - 1)) * duration;
      times.push(t);
      const spec = specAt(t);
      for (const k of Object.keys(spec)) if (this.map[k]) used.add(this.map[k]);
      const solved = this.solve(spec);
      for (const [b, v] of solved) {
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
        let moved = false;
        for (let i = 4; i < vals.length && !moved; i++) if (Math.abs(vals[i] - vals[i % 4]) > 1e-5) moved = true;
        if (!moved) continue;
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(b.uuid + '.quaternion', times, vals));
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
    spec[side + 'UpperLeg'] = { dir: legDir(side, p[s + 'LegSwing'], p[s + 'LegSpread']) };
    spec[side + 'LowerLeg'] = { bend: p[s + 'Knee'], front: new THREE.Vector3(0, 0, -1) };
    spec[side + 'Foot'] = { rot: [p[s + 'FootPitch'], 0, 0] };
  }
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
