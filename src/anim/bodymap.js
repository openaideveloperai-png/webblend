// A plain-text map of a character for the AI: how tall each body part is,
// which bone is which part (Japanese names translated), what moving each one
// carries along. Every other bone is mapped by rigscan.js.
import * as THREE from 'three';
import { translateName } from '../core/jp.js';

const PART_NAMES = {
  hips: 'hips (moves the whole body)', spine: 'lower spine', chest: 'chest', upperChest: 'upper chest', neck: 'neck', head: 'head',
  leftShoulder: 'left shoulder', leftUpperArm: 'left upper arm', leftLowerArm: 'left forearm', leftHand: 'left hand',
  rightShoulder: 'right shoulder', rightUpperArm: 'right upper arm', rightLowerArm: 'right forearm', rightHand: 'right hand',
  leftUpperLeg: 'left thigh', leftLowerLeg: 'left shin (knee)', leftFoot: 'left foot', leftToes: 'left toes',
  rightUpperLeg: 'right thigh', rightLowerLeg: 'right shin (knee)', rightFoot: 'right foot', rightToes: 'right toes',
};

const label = (b) => { const t = translateName(b.name); return t ? `${b.name} (${t})` : b.name; };

export function describeBody(model) {
  const rig = model.humanoid;
  if (!rig) return '';
  const lines = [];
  // ---- heights, as % of body height (feet = 0)
  const up = rig.up;
  const root = model.root;
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  let lo = Infinity, hi = -Infinity;
  const v = new THREE.Vector3();
  let skinned = false;
  root.traverse((o) => { if (o.isSkinnedMesh) skinned = true; });
  root.traverse((o) => {
    if (!o.isMesh || o.userData.helper) return;
    let vis = true, onBone = false;
    for (let p = o; p; p = p.parent) { if (!p.visible) vis = false; if (p !== o && p.isBone) onBone = true; }
    if (!vis || (skinned && !o.isSkinnedMesh && !onBone)) return;
    const pos = o.geometry && o.geometry.attributes.position;
    if (!pos) return;
    const step = Math.max(1, Math.floor(pos.count / 4000));
    for (let i = 0; i < pos.count; i += step) {
      o.getVertexPosition(i, v);
      v.applyMatrix4(o.matrixWorld).applyMatrix4(inv);
      const h = v.dot(up);
      if (h < lo) lo = h;
      if (h > hi) hi = h;
    }
  });
  const P = (k) => (rig.map[k] ? rig.rest.get(rig.map[k]).pos : null);
  const feet = [P('leftFoot'), P('rightFoot'), P('leftToes'), P('rightToes')].filter(Boolean);
  if (!(hi > lo)) {
    lo = Math.min(...feet.map((p) => p.dot(up)), 0);
    hi = (P('head') ? P('head').dot(up) : lo + rig.hipHeight * 2) + rig.hipHeight * 0.25;
  }
  const H = hi - lo;
  const pct = (p) => (p ? Math.round(((p.dot(up) - lo) / H) * 100) : null);
  const avg = (a, b) => (a && b ? a.clone().add(b).multiplyScalar(0.5) : a || b);
  const parts = [
    ['top of head', 100],
    ['head joint (base of skull)', pct(P('head'))],
    ['neck', pct(P('neck'))],
    ['shoulders', pct(avg(P('leftUpperArm'), P('rightUpperArm')))],
    ['chest', pct(P('upperChest') || P('chest'))],
    ['waist / lower spine', pct(P('spine'))],
    ['hip joints (crotch height)', pct(avg(P('leftUpperLeg'), P('rightUpperLeg')))],
    ['knees', pct(avg(P('leftLowerLeg'), P('rightLowerLeg')))],
    ['ankles', pct(avg(P('leftFoot'), P('rightFoot')))],
  ].filter(([, x]) => x !== null && x >= 0 && x <= 100);
  // how far the hands reach when the arms hang down
  const ua = P('leftUpperArm'), la = P('leftLowerArm'), hd = P('leftHand');
  let reach = '';
  if (ua && la && hd && rig.handAxes && rig.handAxes.left) {
    const armLen = ua.distanceTo(la) + la.distanceTo(hd) + rig.handAxes.left.palmLen * 1.6;
    const r = Math.round(((ua.dot(up) - armLen - lo) / H) * 100);
    reach = ` With arms hanging straight down the fingertips reach about ${Math.max(0, r)}%${r > 40 ? ' (short arms: the hands can\'t reach the knees without bending over)' : ''}.`;
  }
  lines.push(`  Body heights (% of body height, feet = 0%): ${parts.map(([n, x]) => `${n} ${x}%`).join(', ')}.${reach}`);
  // ---- which bone is which part
  const jp = Object.values(rig.map).some((b) => translateName(b.name));
  const mapped = Object.entries(rig.map).filter(([, b]) => b).map(([k, b]) => `${PART_NAMES[k] || k} = ${label(b)}`);
  lines.push(`  Rig${jp ? ' (Japanese bone names translated)' : ''}: ${mapped.join('; ')}.`);
  lines.push('  Moving a bone carries everything attached below it: hips -> the whole body; spine/chest -> the upper body, arms and head; upper arm -> the whole arm and hand; forearm -> forearm and hand; thigh -> the WHOLE leg with knee and foot; shin -> lower leg and foot. So to bend just a knee use lKnee/rKnee, not the thigh; to turn the head use neck/head params, not the chest. Animate these parts with humanoidKeys / handTouches (they handle all of this); boneKeys on them only add a small extra turn on top.');
  return lines.join('\n');
}
