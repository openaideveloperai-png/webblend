// Groups of bones to select at once: the lips, the fingers, a body part, a bone's
// children, the other side's bones.
import { bonePart } from '../core/joints.js';
import { translateName } from '../core/jp.js';
import { softLips } from './softlips.js';

const LIP = /lip|唇|くちびる|口角|mouth_?(corner|upper|lower|top|bottom|[lr]\b)|^mouth[._ -]?[lr]$/i;
const NOT_LIP = /tongue|舌|べろ|teeth|tooth|歯|jaw|顎|あご/i;
const nameOf = (b) => (b.name || '') + ' ' + (translateName(b.name) || '');

// the bones that move the lips: the user's own list if they set one (Advanced → Lips),
// else bones named as lips, else the bones that carry the soft lips' vertices
export function lipBones(model) {
  if (!model || !model.bones) return [];
  const own = model.lipBones;
  if (Array.isArray(own) && own.length) {
    const byName = new Map(model.bones.map((b) => [b.name, b]));
    const list = own.map((n) => byName.get(n)).filter(Boolean);
    if (list.length) return list;
  }
  const rig = model.humanoid;
  const head = rig && rig.map && rig.map.head;
  const pool = [];
  if (head) head.traverse((o) => { if (o.isBone) pool.push(o); });
  const named = (pool.length ? pool : model.bones).filter((b) => LIP.test(nameOf(b)) && !NOT_LIP.test(nameOf(b)));
  if (named.length) return named;
  // no lip names: the bones whose vertices the soft lips found on the mouth
  const sl = softLips(model);
  if (!sl || !sl.boneIds) return [];
  const ids = new Set(sl.boneIds);
  return model.bones.filter((b) => ids.has(b.uuid) && b !== head);
}

// the finger bones of one hand ('left' / 'right') or both
export function fingerBones(model, side) {
  const rig = model && model.humanoid;
  const out = [];
  for (const s of side ? [side] : ['left', 'right']) {
    const H = rig && rig.handRig && rig.handRig(s);
    if (H) for (const ch of Object.values(H.chains)) for (const b of ch.bones) out.push(b.bone);
  }
  return out;
}

// the bones of one body part (as the bone colors group them: head, face, hands…)
export function partBones(model, part) {
  if (!model || !model.bones) return [];
  let canonOf = null;
  try { canonOf = model.humanoid ? model.humanoid.canonOf : null; } catch { canonOf = null; }
  const shown = model.joints ? model.joints.bones : model.bones;
  return shown.filter((b) => bonePart(b, canonOf) === part);
}

export function partOf(model, bone) {
  let canonOf = null;
  try { canonOf = model.humanoid ? model.humanoid.canonOf : null; } catch { canonOf = null; }
  return bonePart(bone, canonOf);
}

// every bone under this one (not the bone itself)
export function childBones(bone) {
  const out = [];
  bone.traverse((o) => { if (o !== bone && o.isBone) out.push(o); });
  return out;
}

// the same bone on the other side (Left ↔ Right, .L ↔ .R, 左 ↔ 右)
const matchCase = (src, word) => (src === src.toUpperCase() ? word.toUpperCase() : src === src.toLowerCase() ? word.toLowerCase() : word);
const SWAPS = [
  (n) => n.replace(/left/gi, (m) => matchCase(m, 'Right')),
  (n) => n.replace(/right/gi, (m) => matchCase(m, 'Left')),
  (n) => n.replace(/左/g, '右'),
  (n) => n.replace(/右/g, '左'),
  (n) => n.replace(/([._ -])([lL])(?=$|[._ \-\d])/, (m, a, c) => a + (c === 'l' ? 'r' : 'R')),
  (n) => n.replace(/([._ -])([rR])(?=$|[._ \-\d])/, (m, a, c) => a + (c === 'r' ? 'l' : 'L')),
  (n) => n.replace(/^([lL])(?=[._ -])/, (m, c) => (c === 'l' ? 'r' : 'R')),
  (n) => n.replace(/^([rR])(?=[._ -])/, (m, c) => (c === 'r' ? 'l' : 'L')),
];
export function mirrorBone(model, bone) {
  const n = bone.name || '';
  const byName = new Map(model.bones.map((b) => [b.name, b]));
  for (const f of SWAPS) {
    const cand = f(n);
    if (cand !== n && byName.has(cand) && byName.get(cand) !== bone) return byName.get(cand);
  }
  // by humanoid role
  const rig = model.humanoid;
  const c = rig && rig.canonOf && rig.canonOf.get(bone);
  if (c) {
    const other = c.startsWith('left') ? 'right' + c.slice(4) : c.startsWith('right') ? 'left' + c.slice(5) : null;
    if (other && rig.map[other]) return rig.map[other];
  }
  return null;
}
