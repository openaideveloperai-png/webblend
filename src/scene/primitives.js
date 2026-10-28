// Built-in objects: primitives, lights, cameras and a rigged demo mannequin.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const PALETTE = [0x6aa9ff, 0xffb84a, 0x5fd39a, 0xff7a8a, 0xb69cff, 0x4fd1d9, 0xf2d15c];
let colorIdx = 0;
const nextColor = () => PALETTE[colorIdx++ % PALETTE.length];

export const PRIMITIVES = {
  cube: { label: 'Cube', make: () => new THREE.BoxGeometry(1, 1, 1), y: 0.5 },
  sphere: { label: 'Sphere', make: () => new THREE.SphereGeometry(0.5, 32, 16), y: 0.5 },
  cylinder: { label: 'Cylinder', make: () => new THREE.CylinderGeometry(0.4, 0.4, 1, 32), y: 0.5 },
  cone: { label: 'Cone', make: () => new THREE.ConeGeometry(0.5, 1, 32), y: 0.5 },
  capsule: { label: 'Capsule', make: () => new THREE.CapsuleGeometry(0.3, 0.6, 8, 16), y: 0.6 },
  torus: { label: 'Torus', make: () => new THREE.TorusGeometry(0.4, 0.15, 16, 48), y: 0.55 },
  knot: { label: 'Torus knot', make: () => new THREE.TorusKnotGeometry(0.35, 0.12, 128, 16), y: 0.6 },
  ico: { label: 'Gem', make: () => new THREE.IcosahedronGeometry(0.5, 0), y: 0.5 },
  plane: { label: 'Plane', make: () => new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), y: 0.001 },
};

export function makePrimitive(type) {
  const p = PRIMITIVES[type] || PRIMITIVES.cube;
  const mat = new THREE.MeshStandardMaterial({ color: nextColor(), roughness: 0.45, metalness: 0.05, side: type === 'plane' ? THREE.DoubleSide : THREE.FrontSide });
  const mesh = new THREE.Mesh(p.make(), mat);
  mesh.name = p.label;
  mesh.position.y = p.y;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function marker(color) {
  const m = new THREE.Mesh(new THREE.OctahedronGeometry(0.12, 0), new THREE.MeshBasicMaterial({ color, wireframe: false }));
  m.userData.editorOnly = true;
  m.name = 'marker';
  return m;
}

export function makeLight(type) {
  let light;
  if (type === 'spot') {
    light = new THREE.SpotLight(0xffffff, 30, 0, Math.PI / 6, 0.3, 2);
    light.position.set(2, 4, 2);
  } else if (type === 'directional') {
    light = new THREE.DirectionalLight(0xffffff, 2);
    light.position.set(-3, 5, 2);
  } else {
    light = new THREE.PointLight(0xffd9a0, 12, 0, 2);
    light.position.set(1.5, 2.5, 1.5);
  }
  light.name = { spot: 'Spot light', directional: 'Sun light', point: 'Point light' }[type] || 'Light';
  light.castShadow = false;
  if (light.target) {
    light.target.position.set(0, -1, 0);
    light.target.name = 'target';
    light.target.userData.editorOnly = true;
    light.add(light.target);
    if (type === 'spot' || type === 'directional') light.lookAt(0, 0, 0);
  }
  light.add(marker(0xffe08a));
  return light;
}

export function makeCamera() {
  const cam = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 500);
  cam.name = 'Camera';
  cam.position.set(0, 1.6, 5);
  cam.lookAt(0, 1, 0);
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.18, 0.3), new THREE.MeshBasicMaterial({ color: 0x9fb4d0 }));
  body.position.z = 0.15;
  body.userData.editorOnly = true;
  const lens = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.15, 12).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4aa8ff }));
  lens.position.z = -0.05;
  lens.userData.editorOnly = true;
  cam.add(body, lens);
  return cam;
}

export function makeEmpty() {
  const g = new THREE.Group();
  g.name = 'Empty';
  const axes = new THREE.AxesHelper(0.4);
  axes.userData.editorOnly = true;
  g.add(axes);
  const pick = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), new THREE.MeshBasicMaterial({ color: 0xcfd6e0 }));
  pick.userData.editorOnly = true;
  g.add(pick);
  g.position.y = 1;
  return g;
}

// ---------------------------------------------------------------- mannequin

// five fingers per hand (Mixamo names; the 4th bone of each is the tip marker).
// T-pose: palm down, fingers along x, thumb toward the front (+z)
const FINGERS = {
  Thumb: [[0.722, 1.413, 0.032], [0.748, 1.405, 0.058], [0.77, 1.4, 0.074], [0.79, 1.397, 0.085]],
  Index: [[0.79, 1.42, 0.028], [0.826, 1.42, 0.03], [0.85, 1.42, 0.031], [0.869, 1.42, 0.031]],
  Middle: [[0.794, 1.42, 0.009], [0.834, 1.42, 0.01], [0.861, 1.42, 0.01], [0.882, 1.42, 0.01]],
  Ring: [[0.791, 1.42, -0.01], [0.828, 1.42, -0.011], [0.853, 1.42, -0.012], [0.872, 1.42, -0.012]],
  Pinky: [[0.783, 1.42, -0.028], [0.811, 1.42, -0.03], [0.83, 1.42, -0.031], [0.845, 1.42, -0.031]],
};
function fingerBones(S, sx) {
  const out = [];
  for (const [f, pts] of Object.entries(FINGERS)) {
    pts.forEach((p, i) => out.push([`${S}Hand${f}${i + 1}`, i ? `${S}Hand${f}${i}` : `${S}Hand`, [p[0] * sx, p[1], p[2]]]));
  }
  return out;
}

const BONES = [
  // name, parent, world position (meters, T-pose, facing +Z, character's left = +X)
  ['Hips', null, [0, 0.95, 0]],
  ['Spine', 'Hips', [0, 1.05, 0]],
  ['Spine1', 'Spine', [0, 1.17, 0]],
  ['Spine2', 'Spine1', [0, 1.3, 0]],
  ['Neck', 'Spine2', [0, 1.47, 0]],
  ['Head', 'Neck', [0, 1.57, 0.01]],
  ['HeadTop_End', 'Head', [0, 1.78, 0.01]],
  ['LeftShoulder', 'Spine2', [0.05, 1.41, 0]],
  ['LeftArm', 'LeftShoulder', [0.18, 1.42, 0]],
  ['LeftForeArm', 'LeftArm', [0.45, 1.42, 0]],
  ['LeftHand', 'LeftForeArm', [0.7, 1.42, 0]],
  ...fingerBones('Left', 1),
  ['RightShoulder', 'Spine2', [-0.05, 1.41, 0]],
  ['RightArm', 'RightShoulder', [-0.18, 1.42, 0]],
  ['RightForeArm', 'RightArm', [-0.45, 1.42, 0]],
  ['RightHand', 'RightForeArm', [-0.7, 1.42, 0]],
  ...fingerBones('Right', -1),
  ['LeftUpLeg', 'Hips', [0.1, 0.9, 0]],
  ['LeftLeg', 'LeftUpLeg', [0.1, 0.5, 0.01]],
  ['LeftFoot', 'LeftLeg', [0.1, 0.09, -0.01]],
  ['LeftToeBase', 'LeftFoot', [0.1, 0.03, 0.12]],
  ['LeftToe_End', 'LeftToeBase', [0.1, 0.03, 0.2]],
  ['RightUpLeg', 'Hips', [-0.1, 0.9, 0]],
  ['RightLeg', 'RightUpLeg', [-0.1, 0.5, 0.01]],
  ['RightFoot', 'RightLeg', [-0.1, 0.09, -0.01]],
  ['RightToeBase', 'RightFoot', [-0.1, 0.03, 0.12]],
  ['RightToe_End', 'RightToeBase', [-0.1, 0.03, 0.2]],
];

function limb(a, b, r, segs = 12) {
  const va = new THREE.Vector3(...a), vb = new THREE.Vector3(...b);
  const len = va.distanceTo(vb);
  const g = new THREE.CapsuleGeometry(r, Math.max(len - r * 2 * 0.6, 0.01), 4, segs);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), vb.clone().sub(va).normalize());
  g.applyQuaternion(q);
  const mid = va.clone().add(vb).multiplyScalar(0.5);
  g.translate(mid.x, mid.y, mid.z);
  return g;
}

function box(center, size, round = 0) {
  const g = new THREE.BoxGeometry(size[0], size[1], size[2], 2, 2, 2);
  if (round) {
    // soften corners by pushing vertices toward an ellipsoid
    const p = g.attributes.position;
    const v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const e = new THREE.Vector3(v.x / (size[0] / 2), v.y / (size[1] / 2), v.z / (size[2] / 2));
      const l = e.length();
      if (l > 0) e.multiplyScalar(1 / l);
      v.lerp(new THREE.Vector3(e.x * size[0] / 2, e.y * size[1] / 2, e.z * size[2] / 2), round);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
  }
  g.translate(center[0], center[1], center[2]);
  return g;
}

function sphere(center, r, sx = 1, sy = 1, sz = 1) {
  const g = new THREE.SphereGeometry(r, 20, 14);
  g.scale(sx, sy, sz);
  g.translate(center[0], center[1], center[2]);
  return g;
}

export function makeMannequin(name = 'Mannequin') {
  const root = new THREE.Group();
  root.name = name;
  const bones = {};
  const list = [];
  for (const [n, parent, pos] of BONES) {
    const b = new THREE.Bone();
    b.name = n;
    b.userData.world = pos;
    bones[n] = b;
    list.push(b);
    if (parent) {
      const pw = bones[parent].userData.world;
      b.position.set(pos[0] - pw[0], pos[1] - pw[1], pos[2] - pw[2]);
      bones[parent].add(b);
    } else {
      b.position.set(...pos);
      root.add(b);
    }
  }
  const P = (n) => bones[n].userData.world;
  const body = new THREE.Color(0xcdd3dc), dark = new THREE.Color(0x58637a), accent = new THREE.Color(0xffb84a), skin = new THREE.Color(0xe6e9ee);
  const parts = [];
  const add = (geo, bone, color) => parts.push({ geo, bone, color });
  // torso
  add(box([0, 0.95, 0], [0.3, 0.17, 0.19], 0.6), 'Hips', dark);
  add(box([0, 1.1, 0.005], [0.25, 0.14, 0.16], 0.6), 'Spine', body);
  add(box([0, 1.22, 0.01], [0.31, 0.14, 0.19], 0.6), 'Spine1', body);
  add(box([0, 1.34, 0.005], [0.38, 0.17, 0.21], 0.55), 'Spine2', body);
  add(limb([0, 1.44, 0], [0, 1.56, 0.01], 0.045), 'Neck', skin);
  add(sphere([0, 1.66, 0.015], 0.105, 0.95, 1.12, 1), 'Head', skin);
  add(box([0, 1.675, 0.1], [0.13, 0.04, 0.03], 0.5), 'Head', accent); // visor shows facing
  for (const [S, sx] of [['Left', 1], ['Right', -1]]) {
    add(sphere([0.17 * sx, 1.42, 0], 0.062), S + 'Shoulder', dark);
    add(limb(P(S + 'Arm'), P(S + 'ForeArm'), 0.05), S + 'Arm', body);
    add(sphere(P(S + 'ForeArm'), 0.047), S + 'ForeArm', dark);
    add(limb(P(S + 'ForeArm'), P(S + 'Hand'), 0.042), S + 'ForeArm', body);
    add(box([0.75 * sx, 1.42, 0], [0.095, 0.03, 0.08], 0.5), S + 'Hand', skin);
    for (const f of Object.keys(FINGERS)) {
      const r = f === 'Thumb' ? 0.0105 : f === 'Pinky' ? 0.0075 : 0.0088;
      for (let i = 1; i <= 3; i++) add(limb(P(`${S}Hand${f}${i}`), P(`${S}Hand${f}${i + 1}`), r, 6), `${S}Hand${f}${i}`, skin);
    }
    add(sphere([0.1 * sx, 0.9, 0], 0.075), S + 'UpLeg', dark);
    add(limb(P(S + 'UpLeg'), P(S + 'Leg'), 0.07), S + 'UpLeg', body);
    add(sphere(P(S + 'Leg'), 0.058), S + 'Leg', dark);
    add(limb(P(S + 'Leg'), P(S + 'Foot'), 0.056), S + 'Leg', body);
    add(box([0.1 * sx, 0.045, 0.04], [0.1, 0.07, 0.24], 0.45), S + 'Foot', dark);
  }
  const boneIndex = new Map(list.map((b, i) => [b.name, i]));
  const geos = parts.map(({ geo, bone, color }) => {
    const g = geo.index ? geo : geo;
    if (g.attributes.uv) g.deleteAttribute('uv');
    const n = g.attributes.position.count;
    const col = new Float32Array(n * 3);
    const si = new Uint16Array(n * 4);
    const sw = new Float32Array(n * 4);
    const bi = boneIndex.get(bone);
    for (let i = 0; i < n; i++) {
      col.set([color.r, color.g, color.b], i * 3);
      si[i * 4] = bi;
      sw[i * 4] = 1;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    return g.index ? g : g;
  });
  const geometry = mergeGeometries(geos.map((g) => (g.index ? g : g)), false);
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.05, name: 'Mannequin' });
  const mesh = new THREE.SkinnedMesh(geometry, material);
  mesh.name = 'Body';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(new THREE.Skeleton(list));
  return root;
}
