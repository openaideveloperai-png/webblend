// Soft lips: the lips wrap around a tongue or a finger instead of the mouth opening
// wide or the thing clipping through. A small closed mouth on the demo mannequin (no
// files needed): fine upper and lower lip meshes, a tongue behind them.
// Usage: node tools/test-softlips.mjs
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { makeMannequin } from '../src/scene/primitives.js';
import { detectHumanoid, defaultParams, paramsToSpec } from '../src/anim/humanoid.js';
import { poseFromClip, faceTracks } from '../src/anim/face.js';
import { evaluator, clearMouth } from '../src/anim/mouth.js';
import { softLips, updateSoftLips, detachSoftLips } from '../src/anim/softlips.js';
import { mouthWish, parseFaceWords } from '../src/anim/ai.js';

let fails = 0;
const ok = (label, cond, extra = '') => { console.log((cond ? 'ok   ' : 'FAIL ') + label + (extra ? '  ' + extra : '')); if (!cond) fails++; };

// lips 5 cm wide, 6 mm tall each, meeting at y = 1.600; a box tongue 2 cm wide, 8 mm thick behind them
export function mouthy() {
  const root = makeMannequin('Mouthy');
  const head = root.getObjectByName('Head');
  root.updateMatrixWorld(true);
  const hp = new THREE.Vector3().setFromMatrixPosition(head.matrixWorld);
  const bone = (name, p) => { const b = new THREE.Bone(); b.name = name; b.position.set(p[0] - hp.x, p[1] - hp.y, p[2] - hp.z); head.add(b); return b; };
  const lipU = bone('lip.upper', [0, 1.603, 0.115]), lipL = bone('lip.lower', [0, 1.597, 0.115]), tongue = bone('tongue', [0, 1.6, 0.09]);
  root.updateMatrixWorld(true);
  const parts = [[[0.05, 0.006, 0.01, 24, 3, 4], [0, 1.603, 0.115], 0], [[0.05, 0.006, 0.01, 24, 3, 4], [0, 1.597, 0.115], 1], [[0.02, 0.008, 0.03, 8, 3, 10], [0, 1.6, 0.089], 2]];
  const geos = parts.map(([sz, c, bi]) => {
    const g = new THREE.BoxGeometry(...sz);
    g.translate(...c);
    const n = g.attributes.position.count;
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4).map((_, i) => (i % 4 ? 0 : bi)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4).map((_, i) => (i % 4 ? 0 : 1)), 4));
    return g;
  });
  const mouth = new THREE.SkinnedMesh(mergeGeometries(geos), new THREE.MeshStandardMaterial({ color: 0xd08080 }));
  mouth.name = 'Mouth';
  root.add(mouth);
  root.updateMatrixWorld(true);
  mouth.bind(new THREE.Skeleton([lipU, lipL, tongue]), mouth.matrixWorld);
  const bones = []; root.traverse((o) => { if (o.isBone) bones.push(o); });
  const rest = new Map(); root.traverse((o) => rest.set(o, { p: o.position.clone(), q: o.quaternion.clone(), s: o.scale.clone() }));
  let nodeCount = 0; root.traverse(() => nodeCount++);
  const model = { root, humanoid: detectHumanoid(root, bones), rest, bones, skinned: [root.getObjectByName('Body'), mouth], meshes: [], morphMeshes: [], nodeCount, poses: [], size: 1.8, constraints: null, drivenBones: new Set() };
  const pose = (name, b, d) => poseFromClip(model, new THREE.AnimationClip(name, 0, [new THREE.VectorKeyframeTrack(b.uuid + '.position', [0], b.position.clone().add(new THREE.Vector3(...d)).toArray())]));
  model.poses = [pose('mouth_open', lipL, [0, -0.012, 0]), pose('tongue_out', tongue, [0, 0, 0.03])];
  return { model, mouth, lipU, lipL, tongue };
}

const hold = (model, name, v = 1) => new THREE.AnimationClip('c', 1, faceTracks(model, [{ t: 0, control: name, value: v }, { t: 1, control: name, value: v }], 1).tracks);
// the lip line (front edge where the lips meet), per side, along x: [x, pushed y (mm)]
const edge = (s, side, dz = 0.005) => {
  const out = [];
  for (let i = 0; i < s.N; i++) {
    if (s.side[i] !== side) continue;
    const x = s.P[i * 3], y = s.P[i * 3 + 1], z = s.P[i * 3 + 2];
    if (Math.abs(y - s.C.y) < 0.0005 && Math.abs(z - (s.C.z + dz)) < 0.0012) out.push([x, s.D[i * 3 + 1] * 1000]);
  }
  return out.sort((a, b) => a[0] - b[0]);
};
const at = (row, x) => row.reduce((b, r) => (Math.abs(r[0] - x) < Math.abs(b[0] - x) ? r : b), row[0])[1];

if (typeof process !== 'undefined' && process.argv && process.argv[1] && process.argv[1].endsWith('test-softlips.mjs')) {
  // ---- built from the rig: which vertices are the lips, upper vs lower
  const { model, mouth } = mouthy();
  const s = softLips(model);
  ok('soft lips found the lips', s && s.N > 200, s ? `N ${s.N}` : '');
  const up = [...s.side].filter((x) => x > 0).length, lo = [...s.side].filter((x) => x < 0).length;
  ok('upper and lower lip told apart (the lower one goes down when the mouth opens)', Math.abs(up - lo) < 20, `${up} / ${lo}`);
  ok('the tongue is a collider; nothing inside it at rest', s.tongue && s.tongue.n > 50 && ![...s.inside].some(Boolean));
  const ev = evaluator(model);
  try {
    ev.at(new THREE.AnimationClip('rest', 1, []), 0);
    ok('at rest nothing is pushed', !s.update({ write: false }).active);
    // ---- the tongue comes out through the closed lips
    ev.at(hold(model, 'tongue_out'), 0.5);
    const st = s.update({ write: false });
    ok('tongue out: the lips wrap around it, nothing left clipping', st.active && st.tongue && st.leftCm === 0, JSON.stringify(st));
    const U = edge(s, 1), L = edge(s, -1);
    ok('upper lip goes over the tongue, lower lip under it (4 mm half thickness + margin)', at(U, 0) >= 4.5 && at(L, 0) <= -4.5, `${at(U, 0).toFixed(1)} / ${at(L, 0).toFixed(1)} mm`);
    ok('the lips close again beside the tongue (not a wide-open mouth)', at(U, 0.022) < at(U, 0) * 0.2 && at(L, -0.022) > at(L, 0) * 0.2 && at(U, 0.014) < at(U, 0) * 0.65, `edge at 1.4 / 2.2 cm: ${at(U, 0.014).toFixed(1)} / ${at(U, 0.022).toFixed(1)} mm`);
    const smooth = U.every((r, i) => i === 0 || r[0] > 0.0105 || r[0] < -0.0105 || Math.abs(r[1] - U[i - 1][1]) < 1.6);
    ok('...curving smoothly toward the corners', smooth);
    const top = edge(s, 1, 0.005).length ? (() => { let best = 0; for (let i = 0; i < s.N; i++) if (s.side[i] > 0 && Math.abs(s.P[i * 3]) < 0.001 && Math.abs(s.P[i * 3 + 1] - (s.C.y + 0.006)) < 0.0005) best = Math.max(best, s.D[i * 3 + 1] * 1000); return best; })() : 0;
    ok('the whole upper lip lifts (squished a little, not pinched thin)', top > at(U, 0) * 0.55, `top ${top.toFixed(1)} mm vs edge ${at(U, 0).toFixed(1)} mm`);
    const bulge = (() => { let m = 0; for (let i = 0; i < s.N; i++) m = Math.max(m, s.D[i * 3 + 2]); return m * 1000; })();
    ok('squeezed lips bulge forward a little', bulge > 0.3 && bulge < 3, `${bulge.toFixed(2)} mm`);
    // softer lips give way further along
    model.softLipsSoftness = 1.8;
    s.update({ write: false });
    const wide = at(edge(s, 1), 0.016);
    model.softLipsSoftness = 1;
    s.update({ write: false });
    ok('softness spreads the wrap further', wide > at(edge(s, 1), 0.016) * 1.3, `${wide.toFixed(2)} vs ${at(edge(s, 1), 0.016).toFixed(2)} mm`);
    // ---- the GPU side: offsets on the mesh, cleared again
    s.update({ write: true, force: true });
    const a = mouth.geometry.attributes.contactOffset;
    let mx = 0; for (let i = 0; i < a.array.length; i++) mx = Math.max(mx, Math.abs(a.array[i]));
    ok('offsets written to the lip mesh (per vertex, added after skinning)', a && mx > 0.004, `max ${(mx * 1000).toFixed(1)} mm`);
    s.clear();
    ok('cleared back to zero', !a.array.some((x) => x !== 0));
    const sh = { vertexShader: 'void main() {\n#include <skinning_vertex>\n}', fragmentShader: '' };
    mouth.material.onBeforeCompile(sh, null);
    ok('the material adds the offset after skinning', /attribute vec3 contactOffset/.test(sh.vertexShader) && /#include <skinning_vertex>\s*transformed \+= contactOffset;/.test(sh.vertexShader) && /softlips/.test(mouth.material.customProgramCacheKey()));
    const back = detachSoftLips([model]);
    ok('left out of exported files', !mouth.geometry.attributes.contactOffset);
    back();
    ok('...and put back after', !!mouth.geometry.attributes.contactOffset);
  } finally { ev.done(); }

  // ---- a finger in the mouth
  {
    const rig = model.humanoid;
    rig.apply(rig.solve(paramsToSpec({ ...defaultParams(), rTouch: { spot: 'mouth', weight: 1, finger: 'index', mode: 'tip', depth: 0.5 } })));
    model.root.updateMatrixWorld(true);
    const st = s.update({ write: false });
    ok('finger in the mouth: the lips wrap around it', st.active && st.fingers && st.leftCm === 0 && st.pushCm > 0.3, JSON.stringify(st));
    const U = edge(s, 1), L = edge(s, -1);
    const peakU = Math.max(...U.map((r) => r[1])), peakL = Math.min(...L.map((r) => r[1]));
    ok('...upper lip arches over it, lower lip under it, closed at the corners', peakU > 3 && peakL < -3 && Math.abs(U[0][1]) < peakU * 0.25 && Math.abs(U[U.length - 1][1]) < peakU * 0.25, `${peakU.toFixed(1)} / ${peakL.toFixed(1)} mm`);
    rig.apply(rig.solve(paramsToSpec(defaultParams())));
    model.root.updateMatrixWorld(true);
  }

  // ---- the live update: cheap when nothing changed, off when switched off
  {
    const ev2 = evaluator(model);
    ev2.at(hold(model, 'tongue_out'), 0.5);
    updateSoftLips(model);
    const a = mouth.geometry.attributes.contactOffset;
    const v0 = a.version;
    updateSoftLips(model);
    ok('live: the same pose isn\'t solved again', a.version === v0 && s.stats.active);
    model.softLips = false;
    updateSoftLips(model);
    ok('switched off: the lips go back', !a.array.some((x) => x !== 0));
    model.softLips = true;
    ev2.done();
  }

  // ---- the clip builder: with soft lips the mouth barely opens
  {
    const keys = [{ t: 0, control: 'tongue_out', value: 0 }, { t: 0.6, control: 'tongue_out', value: 1 }, { t: 2, control: 'tongue_out', value: 1 }];
    const clip = new THREE.AnimationClip('t', 2, faceTracks(model, keys, 2).tracks);
    const res = clearMouth(model, clip, keys);
    const open = Math.max(0, ...((res.keys || []).filter((k) => k.control === 'mouth_open').map((k) => k.value)));
    ok('clip: the jaw drops only a little, the lips wrap the rest, nothing clips', res.report.soft && open > 0.05 && open < 0.4 && res.report.clipAfterCm <= 0.1 && res.report.wrapCm > 0.2, `open ${open.toFixed(2)} ${JSON.stringify(res.report)}`);
    const shut = clearMouth(model, clip, keys, { share: 0 });
    ok('clip: "mouth not open" keeps it shut, lips still wrap with no clipping', !shut.keys && shut.report.clipAfterCm <= 0.1, JSON.stringify(shut.report));
    model.softLips = false;
    const hard = clearMouth(model, clip, keys);
    ok('without soft lips the mouth opens all the way around it (old behavior)', hard.report.opened === 'mouth_open' && hard.keys.some((k) => k.control === 'mouth_open' && k.value > 0.5));
    model.softLips = true;
  }

  // ---- copies of the model get their own offsets
  {
    const { model: m2, mouth: mouth2 } = mouthy();
    const twin = mouth2.clone();
    softLips(m2);
    const g0 = mouth2.geometry;
    // a second mesh sharing the geometry (like a duplicated model) gets its own copy
    const { model: m3 } = mouthy();
    m3.skinned[1].geometry = g0;
    m3.root.getObjectByName('Mouth').geometry = g0;
    const s3 = softLips(m3);
    ok('a duplicate sharing the geometry gets its own copy of it', s3 && m3.root.getObjectByName('Mouth').geometry !== g0 && !!m3.root.getObjectByName('Mouth').geometry.attributes.contactOffset);
    void twin;
  }

  // ---- words
  ok('words: "the mouth isn\'t all open, lips curving around the tongue" = keep it shut', mouthWish("make sure the mouth isnt all open but rather the lips curving around the tounge") === 'closed' && mouthWish('put a finger in her mouth, lips wrapped around it') === 'closed' && mouthWish("don't open her mouth") === 'closed');
  ok('words: an open mouth when asked', mouthWish('open her mouth wide') === 'open' && mouthWish('stick her tongue out') === null);
  ok('words: misspelled tongue still sticks out', parseFaceWords('with the ounge out silly').includes('tongue') && parseFaceWords('tounge out').includes('tongue'));

  console.log(fails ? `${fails} FAILED` : 'all soft-lips tests passed');
  process.exit(fails ? 1 : 0);
}
