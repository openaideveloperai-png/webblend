// Procedural motion library. Humanoid motions output rig-independent pose
// params (see humanoid.js POSE_PARAMS); object motions output offsets for any
// object; chain motions wiggle any bone chain (tails, tentacles, ropes).
import * as THREE from 'three';
import { defaultParams, paramsToSpec } from './humanoid.js';

const TAU = Math.PI * 2;
const S = (x) => Math.sin(TAU * x);
const C = (x) => Math.cos(TAU * x);
const pos = (x) => Math.max(0, x);
const ease = (t) => t * t * (3 - 2 * t);

// Interpolate keyposes: keys = [[t, {param: value}], ...] with t in [0,1].
function keyposes(keys, ph, base) {
  const out = {};
  const params = new Set();
  for (const [, o] of keys) for (const k of Object.keys(o)) params.add(k);
  let i = 0;
  while (i < keys.length - 1 && keys[i + 1][0] <= ph) i++;
  const [t0, a] = keys[i];
  const [t1, b] = keys[Math.min(i + 1, keys.length - 1)];
  const u = t1 > t0 ? ease(THREE.MathUtils.clamp((ph - t0) / (t1 - t0), 0, 1)) : 0;
  for (const k of params) {
    const va = a[k] ?? base[k] ?? 0, vb = b[k] ?? base[k] ?? 0;
    out[k] = va + (vb - va) * u;
  }
  return out;
}

// ---------------------------------------------------------------- humanoid
// at(phase 0..1, params) -> params. `cycle` = seconds per loop at speed 1.
export const HUMANOID = {
  idle: {
    // breathing only: the legs and feet stay where they are
    label: 'Idle (breathing)', words: ['idle', 'breath', 'breathe', 'stand', 'standing', 'wait', 'rest', 'stand still'], cycle: 4, loop: true, still: true,
    at(ph, p) {
      p.chestPitch = -1.5 * S(ph); p.spinePitch = 1 - 0.8 * S(ph);
      p.lShoulder = 1.5 * pos(S(ph)); p.rShoulder = 1.5 * pos(S(ph));
      p.headYaw = 3 * S(ph * 0.5); p.headPitch = 2 + 1.2 * S(ph);
      p.lArmRaise = 9 + 1.5 * S(ph); p.rArmRaise = 9 + 1.5 * S(ph);
      p.lElbow = 14; p.rElbow = 14;
      p.plantFeet = true;
      return p;
    },
  },
  still: {
    // a held pose: barely moving, for "hand on her lap while standing" and similar
    label: 'Pose', words: ['pose', 'posing', 'hold still', 'stay still', 'freeze'], cycle: 4, loop: true, still: true,
    at(ph, p) {
      p.chestPitch = -1 * S(ph); p.spinePitch = 0.6 - 0.5 * S(ph);
      p.headPitch = 1.5 + 0.8 * S(ph);
      p.lShoulder = 0.8 * pos(S(ph)); p.rShoulder = 0.8 * pos(S(ph));
      p.plantFeet = true;
      return p;
    },
  },
  walk: {
    label: 'Walk', words: ['walk', 'walking', 'stroll', 'step', 'march'], cycle: 1.1, loop: true, locomotion: 1.3,
    at(ph, p, o) {
      const s = S(ph), c = C(ph);
      p.lLegSwing = 24 * s; p.rLegSwing = -24 * s;
      p.lKnee = 5 + 48 * pos(c) ** 1.4; p.rKnee = 5 + 48 * pos(-c) ** 1.4;
      p.lFootPitch = -8 * s + 10 * pos(-c); p.rFootPitch = 8 * s + 10 * pos(c);
      p.lArmSwing = -20 * s; p.rArmSwing = 20 * s;
      p.lElbow = 16 + 14 * pos(-s); p.rElbow = 16 + 14 * pos(s);
      p.lArmRaise = 9; p.rArmRaise = 9;
      p.hipsY = -0.018 * C(ph * 2) - 0.01; p.hipsYaw = 6 * s; p.hipsRoll = 3 * S(ph + 0.25);
      p.spineYaw = -5 * s; p.chestYaw = -3 * s; p.spinePitch = 3; p.headYaw = 2 * s;
      if (o.march) { p.lLegSwing *= 1.8; p.rLegSwing *= 1.8; p.lArmSwing *= 2; p.rArmSwing *= 2; }
      return p;
    },
  },
  run: {
    label: 'Run', words: ['run', 'running', 'jog', 'jogging', 'sprint', 'dash'], cycle: 0.68, loop: true, locomotion: 3.2,
    at(ph, p) {
      const s = S(ph), c = C(ph);
      p.lLegSwing = 38 * s + 5; p.rLegSwing = -38 * s + 5;
      p.lKnee = 20 + 85 * pos(c) ** 1.2; p.rKnee = 20 + 85 * pos(-c) ** 1.2;
      p.lFootPitch = -10 * s; p.rFootPitch = 10 * s;
      p.lArmSwing = -42 * s; p.rArmSwing = 42 * s;
      p.lElbow = 85; p.rElbow = 85; p.lArmRaise = 14; p.rArmRaise = 14;
      p.hipsY = -0.04 + 0.05 * Math.abs(S(ph)); p.hipsYaw = 8 * s;
      p.spinePitch = 10; p.chestPitch = 4; p.spineYaw = -8 * s; p.headPitch = -6;
      return p;
    },
  },
  sneak: {
    label: 'Sneak', words: ['sneak', 'sneaking', 'tiptoe', 'creep', 'stealth', 'crouch walk'], cycle: 1.6, loop: true, locomotion: 0.7,
    at(ph, p) {
      const s = S(ph), c = C(ph);
      p.lLegSwing = 20 + 22 * s; p.rLegSwing = 20 - 22 * s;
      p.lKnee = 45 + 35 * pos(c); p.rKnee = 45 + 35 * pos(-c);
      p.hipsY = -0.22 - 0.02 * C(ph * 2); p.spinePitch = 25; p.chestPitch = 10; p.headPitch = -20;
      p.lArmRaise = 25; p.rArmRaise = 25; p.lArmSwing = 25 - 10 * s; p.rArmSwing = 25 + 10 * s; p.lElbow = 70; p.rElbow = 70;
      return p;
    },
  },
  jump: {
    label: 'Jump', words: ['jump', 'jumping', 'leap', 'hop up'], cycle: 1.3, loop: false,
    at(ph, p) {
      return Object.assign(p, keyposes([
        [0, {}],
        [0.22, { hipsY: -0.26, lKnee: 75, rKnee: 75, lLegSwing: 38, rLegSwing: 38, spinePitch: 25, lArmSwing: -45, rArmSwing: -45, lArmRaise: 15, rArmRaise: 15, lFootPitch: -20, rFootPitch: -20 }],
        [0.38, { hipsY: 0.12, lKnee: 0, rKnee: 0, lLegSwing: -5, rLegSwing: -5, spinePitch: -5, lArmRaise: 150, rArmRaise: 150, lArmSwing: 30, rArmSwing: 30, lFootPitch: 30, rFootPitch: 30 }],
        [0.55, { hipsY: 0.38, lKnee: 35, rKnee: 35, lLegSwing: 15, rLegSwing: 15, lArmRaise: 160, rArmRaise: 160, lArmSwing: 20, rArmSwing: 20, lElbow: 20, rElbow: 20 }],
        [0.74, { hipsY: 0.05, lKnee: 10, rKnee: 10, lLegSwing: 10, rLegSwing: 10, lArmRaise: 60, rArmRaise: 60, lArmSwing: 30, rArmSwing: 30 }],
        [0.84, { hipsY: -0.22, lKnee: 65, rKnee: 65, lLegSwing: 34, rLegSwing: 34, spinePitch: 22, lArmSwing: 35, rArmSwing: 35, lArmRaise: 25, rArmRaise: 25, lElbow: 40, rElbow: 40 }],
        [1, {}],
      ], ph, p));
    },
  },
  wave: {
    label: 'Wave hello', words: ['wave', 'waving', 'hello', 'hi', 'greet', 'greeting', 'bye', 'goodbye'], cycle: 2.4, loop: true,
    at(ph, p, o) {
      const side = o.side === 'left' ? 'l' : 'r';
      const k = Math.min(1, ph / 0.15, (1 - ph) / 0.15);
      const e = ease(Math.max(0, Math.min(1, k)));
      p[side + 'ArmRaise'] = 8 + (100 - 8) * e;
      p[side + 'ArmSwing'] = 15 * e;
      p[side + 'Elbow'] = 12 + (70 + 22 * S(ph * 4)) * e;
      p[side + 'ElbowUp'] = e;
      p[side + 'HandRoll'] = 0;
      p.headRoll = (side === 'r' ? -4 : 4) * e; p.headYaw = (side === 'r' ? -6 : 6) * e;
      p.chestRoll = (side === 'r' ? 3 : -3) * e;
      return p;
    },
  },
  nod: {
    label: 'Nod yes', words: ['nod', 'yes', 'agree', 'nodding'], cycle: 1.5, loop: true,
    at(ph, p) { p.headPitch = 12 * pos(S(ph * 3)) + 2; p.neckPitch = 5 * pos(S(ph * 3)); return p; },
  },
  shake: {
    label: 'Shake head no', words: ['shake head', 'no', 'disagree', 'refuse', 'deny'], cycle: 1.5, loop: true,
    at(ph, p) { p.headYaw = 28 * S(ph * 3); p.neckYaw = 8 * S(ph * 3); return p; },
  },
  bow: {
    label: 'Bow', words: ['bow', 'bowing', 'thank', 'respect'], cycle: 2.4, loop: false,
    at(ph, p) {
      return Object.assign(p, keyposes([[0, {}], [0.35, { spinePitch: 30, chestPitch: 15, headPitch: 15, lArmSwing: 12, rArmSwing: 12, hipsZ: -0.05, lElbow: 20, rElbow: 20 }], [0.65, { spinePitch: 32, chestPitch: 16, headPitch: 18, lArmSwing: 12, rArmSwing: 12, hipsZ: -0.05 }], [1, {}]], ph, p));
    },
  },
  clap: {
    label: 'Clap', words: ['clap', 'clapping', 'applause', 'applaud'], cycle: 2, loop: true,
    at(ph, p) {
      const c = 0.5 + 0.5 * C(ph * 4);
      p.lArmRaise = 18; p.rArmRaise = 18; p.lArmSwing = 55; p.rArmSwing = 55;
      p.lElbow = 60 + 30 * c; p.rElbow = 60 + 30 * c; p.lElbowUp = -0.9; p.rElbowUp = -0.9;
      p.headPitch = -3; p.chestPitch = -2;
      return p;
    },
  },
  cheer: {
    label: 'Cheer', words: ['cheer', 'celebrate', 'victory', 'hooray', 'yay', 'win', 'hands up', 'raise hands', 'raise arms', 'excited'], cycle: 1.2, loop: true,
    at(ph, p) {
      const b = pos(S(ph));
      p.lArmRaise = 155 + 10 * S(ph * 2); p.rArmRaise = 155 - 10 * S(ph * 2); p.lArmSwing = 10; p.rArmSwing = 10;
      p.lElbow = 20; p.rElbow = 20; p.hipsY = 0.06 * b; p.lKnee = 10 * (1 - b); p.rKnee = 10 * (1 - b);
      p.headPitch = -12; p.chestPitch = -6;
      return p;
    },
  },
  dance: {
    label: 'Dance', words: ['dance', 'dancing', 'groove', 'party', 'boogie', 'disco'], cycle: 2, loop: true,
    at(ph, p) {
      const s = S(ph * 2), s1 = S(ph);
      p.hipsX = 0.05 * s1; p.hipsRoll = 7 * s1; p.hipsY = -0.04 - 0.03 * Math.abs(s);
      p.lKnee = 18 + 14 * pos(s); p.rKnee = 18 + 14 * pos(-s);
      p.lLegSwing = 8 + 6 * pos(s); p.rLegSwing = 8 + 6 * pos(-s);
      p.spineRoll = -5 * s1; p.chestYaw = 10 * S(ph * 2 + 0.25);
      p.lArmRaise = 70 + 50 * pos(s1); p.rArmRaise = 70 + 50 * pos(-s1);
      p.lArmSwing = 25; p.rArmSwing = 25; p.lElbow = 80 - 30 * pos(s1); p.rElbow = 80 - 30 * pos(-s1); p.lElbowUp = 0.6; p.rElbowUp = 0.6;
      p.headYaw = 10 * s1; p.headPitch = 6 * pos(s);
      return p;
    },
  },
  punch: {
    label: 'Punch', words: ['punch', 'punching', 'box', 'boxing', 'hit', 'fight', 'jab'], cycle: 1.2, loop: true,
    at(ph, p, o) {
      const side = o.side === 'left' ? 'l' : 'r', other = side === 'r' ? 'l' : 'r';
      const guard = { [side + 'ArmRaise']: 25, [side + 'ArmSwing']: 45, [side + 'Elbow']: 125, [side + 'ElbowUp']: 0.3, [other + 'ArmRaise']: 25, [other + 'ArmSwing']: 50, [other + 'Elbow']: 120, [other + 'ElbowUp']: 0.3, lKnee: 15, rKnee: 15, lLegSwing: 12, rLegSwing: -6, spinePitch: 8 };
      const hit = { ...guard, [side + 'ArmRaise']: 30, [side + 'ArmSwing']: 85, [side + 'Elbow']: 5, chestYaw: side === 'r' ? 20 : -20, spineYaw: side === 'r' ? 10 : -10 };
      return Object.assign(p, keyposes([[0, guard], [0.3, guard], [0.42, hit], [0.55, hit], [0.8, guard], [1, guard]], ph, p));
    },
  },
  kick: {
    label: 'Kick', words: ['kick', 'kicking', 'kick ball'], cycle: 1.4, loop: false,
    at(ph, p, o) {
      const side = o.side === 'left' ? 'l' : 'r';
      return Object.assign(p, keyposes([[0, {}], [0.25, { [side + 'LegSwing']: -25, [side + 'Knee']: 70, spinePitch: 5, lArmRaise: 35, rArmRaise: 35 }], [0.45, { [side + 'LegSwing']: 75, [side + 'Knee']: 5, spinePitch: -8, lArmRaise: 40, rArmRaise: 40, lArmSwing: -10, rArmSwing: -10 }], [0.6, { [side + 'LegSwing']: 50, [side + 'Knee']: 40, lArmRaise: 30, rArmRaise: 30 }], [1, {}]], ph, p));
    },
  },
  squat: {
    label: 'Squat', words: ['squat', 'squats', 'crouch', 'duck', 'exercise'], cycle: 2.4, loop: true,
    at(ph, p) {
      const d = 0.5 - 0.5 * C(ph);
      p.hipsY = -0.42 * d; p.lLegSwing = 70 * d; p.rLegSwing = 70 * d; p.lKnee = 3 + 112 * d; p.rKnee = 3 + 112 * d;
      p.lFootPitch = -30 * d; p.rFootPitch = -30 * d; p.spinePitch = 25 * d; p.hipsZ = -0.12 * d;
      p.lArmSwing = 85 * d; p.rArmSwing = 85 * d; p.lElbow = 10; p.rElbow = 10;
      return p;
    },
  },
  sit: {
    label: 'Sit down', words: ['sit', 'sitting', 'seat', 'chair'], cycle: 2, loop: false, hold: true,
    at(ph, p) {
      return Object.assign(p, keyposes([[0, {}], [0.6, { hipsY: -0.48, hipsZ: -0.25, lLegSwing: 88, rLegSwing: 88, lKnee: 92, rKnee: 92, spinePitch: 5, lArmSwing: 35, rArmSwing: 35, lElbow: 45, rElbow: 45, lFootPitch: -2, rFootPitch: -2 }], [1, { hipsY: -0.48, hipsZ: -0.25, lLegSwing: 88, rLegSwing: 88, lKnee: 92, rKnee: 92, spinePitch: 2, lArmSwing: 35, rArmSwing: 35, lElbow: 45, rElbow: 45 }]], ph, p));
    },
  },
  look: {
    label: 'Look around', words: ['look around', 'look', 'search', 'scan', 'curious'], cycle: 4, loop: true,
    at(ph, p) { p.headYaw = 50 * S(ph); p.neckYaw = 15 * S(ph); p.chestYaw = 10 * S(ph); p.headPitch = 5 * S(ph * 2); return p; },
  },
  jacks: {
    label: 'Jumping jacks', words: ['jumping jack', 'jumping jacks', 'star jump', 'jacks'], cycle: 1, loop: true,
    at(ph, p) {
      const o = 0.5 - 0.5 * C(ph);
      p.lArmRaise = 10 + 160 * o; p.rArmRaise = 10 + 160 * o; p.lElbow = 10; p.rElbow = 10;
      p.lLegSpread = 3 + 22 * o; p.rLegSpread = 3 + 22 * o;
      p.hipsY = 0.08 * Math.abs(S(ph)) - 0.02; p.lKnee = 12 * (1 - Math.abs(S(ph))); p.rKnee = p.lKnee;
      return p;
    },
  },
  tpose: {
    label: 'T-pose', words: ['t pose', 't-pose', 'tpose', 'arms out'], cycle: 1, loop: false, hold: true,
    at(ph, p) { const e = ease(Math.min(1, ph * 2)); p.lArmRaise = 8 + 82 * e; p.rArmRaise = 8 + 82 * e; p.lElbow = 12 * (1 - e); p.rElbow = 12 * (1 - e); return p; },
  },
  shrug: {
    label: 'Shrug', words: ['shrug', 'dunno', "don't know", 'whatever', 'confused'], cycle: 1.8, loop: false,
    at(ph, p) {
      const pose = { lShoulder: 14, rShoulder: 14, lArmRaise: 22, rArmRaise: 22, lArmSwing: 25, rArmSwing: 25, lElbow: 90, rElbow: 90, lHandRoll: -60, rHandRoll: 60, headRoll: 8, headPitch: -4 };
      return Object.assign(p, keyposes([[0, {}], [0.3, pose], [0.7, pose], [1, {}]], ph, p));
    },
  },
  point: {
    label: 'Point', words: ['point', 'pointing', 'there', 'show'], cycle: 2, loop: false, hold: true,
    at(ph, p, o) {
      const side = o.side === 'left' ? 'l' : 'r';
      const pose = { [side + 'ArmRaise']: 80, [side + 'ArmSwing']: 70, [side + 'Elbow']: 3, chestYaw: side === 'r' ? 10 : -10, headYaw: side === 'r' ? -10 : 10 };
      return Object.assign(p, keyposes([[0, {}], [0.35, pose], [1, pose]], ph, p));
    },
  },
  think: {
    label: 'Think', words: ['think', 'thinking', 'hmm', 'ponder', 'wonder'], cycle: 3, loop: false, hold: true,
    at(ph, p) {
      const pose = { rArmRaise: 20, rArmSwing: 35, rElbow: 140, rElbowUp: 0.2, lArmRaise: 15, lArmSwing: 25, lElbow: 95, lElbowUp: -0.8, headPitch: 8, headRoll: -6, headYaw: -8 };
      return Object.assign(p, keyposes([[0, {}], [0.3, pose], [1, { ...pose, headRoll: -9 }]], ph, p));
    },
  },
  fly: {
    label: 'Fly / flap', words: ['fly', 'flying', 'flap', 'flapping', 'bird', 'wings'], cycle: 0.9, loop: true,
    at(ph, p) {
      const s = S(ph);
      p.lArmRaise = 90 + 40 * s; p.rArmRaise = 90 + 40 * s; p.lElbow = 15; p.rElbow = 15;
      p.hipsY = 0.12 + 0.05 * s; p.lLegSwing = -12; p.rLegSwing = -12; p.lKnee = 20; p.rKnee = 20; p.lFootPitch = 35; p.rFootPitch = 35;
      p.spinePitch = 8; p.headPitch = -10;
      return p;
    },
  },
  swim: {
    label: 'Swim', words: ['swim', 'swimming', 'paddle'], cycle: 1.4, loop: true,
    at(ph, p) {
      const s = S(ph);
      p.lArmRaise = 110 + 60 * s; p.rArmRaise = 110 - 60 * s; p.lArmSwing = 40 * C(ph); p.rArmSwing = -40 * C(ph);
      p.lElbow = 30; p.rElbow = 30; p.lLegSwing = 15 * s; p.rLegSwing = -15 * s; p.lKnee = 20; p.rKnee = 20;
      p.hipsPitch = 6; p.spinePitch = 6;
      return p;
    },
  },
  fall: {
    label: 'Fall down', words: ['fall', 'falling', 'die', 'dead', 'faint', 'collapse', 'trip'], cycle: 1.8, loop: false, hold: true,
    at(ph, p) {
      return Object.assign(p, keyposes([[0, {}], [0.25, { hipsY: -0.15, lKnee: 40, rKnee: 30, lArmRaise: 60, rArmRaise: 70, spinePitch: -15, headPitch: -20 }], [0.6, { hipsY: -0.62, hipsPitch: -70, lKnee: 30, rKnee: 15, lLegSwing: 30, rLegSwing: 15, lArmRaise: 100, rArmRaise: 120, spinePitch: -10, headPitch: -10, hipsZ: -0.3 }], [1, { hipsY: -0.78, hipsPitch: -88, lKnee: 10, rKnee: 25, lLegSwing: 10, rLegSwing: 20, lArmRaise: 95, rArmRaise: 130, hipsZ: -0.35 }]], ph, p));
    },
  },
  turn: {
    label: 'Turn around', words: ['turn around', 'turn', 'spin around', 'rotate'], cycle: 1.6, loop: false, hold: true,
    at(ph, p, o) {
      const dir = o.dir === 'right' ? -1 : 1;
      const e = ease(ph);
      p.rootYaw = 180 * dir * e;
      const step = S(ph * 2);
      p.lLegSwing = 15 * step; p.rLegSwing = -15 * step; p.lKnee = 10 + 25 * pos(step); p.rKnee = 10 + 25 * pos(-step);
      p.headYaw = 15 * dir * (1 - e) * Math.sin(Math.PI * ph);
      return p;
    },
  },
};

// ---------------------------------------------------------------- objects
// at(phase, o) -> {pos:[x,y,z] in object-size units, rot:[x,y,z] deg, scale:[x,y,z], opacity, hue}
export const OBJECT = {
  bounce: { label: 'Bounce', words: ['bounce', 'bouncing', 'bouncy', 'ball', 'hop'], cycle: 1, loop: true, at(ph, o) { const h = Math.abs(Math.sin(Math.PI * ph)); const squash = ph < 0.08 || ph > 0.92 ? 0.82 : 1; return { pos: [0, 1.2 * h * o.amp, 0], scale: [1 + (1 - squash) * 0.6, squash + 0.08 * h, 1 + (1 - squash) * 0.6] }; } },
  spin: { label: 'Spin', words: ['spin', 'spinning', 'rotate', 'rotating', 'turn', 'twirl', 'turntable', 'revolve'], cycle: 2, loop: true, at(ph, o) { const a = 360 * ph * (o.dir === 'right' || o.dir === 'clockwise' ? -1 : 1); const ax = o.axis || 'y'; return { rot: [ax === 'x' ? a : 0, ax === 'y' ? a : 0, ax === 'z' ? a : 0] }; } },
  float: { label: 'Float', words: ['float', 'floating', 'hover', 'hovering', 'levitate', 'bob', 'drift'], cycle: 3, loop: true, at(ph, o) { return { pos: [0, 0.15 * o.amp * S(ph), 0], rot: [4 * S(ph + 0.2) * o.amp, 10 * S(ph * 0.5), 3 * S(ph + 0.6) * o.amp] }; } },
  shake: { label: 'Shake', words: ['shake', 'shaking', 'vibrate', 'tremble', 'jitter', 'rattle', 'earthquake', 'angry'], cycle: 0.6, loop: true, at(ph, o) { return { pos: [0.04 * o.amp * S(ph * 6), 0.01 * o.amp * S(ph * 9), 0.02 * o.amp * S(ph * 4 + 0.3)], rot: [0, 0, 4 * o.amp * S(ph * 5)] }; } },
  pulse: { label: 'Pulse', words: ['pulse', 'pulsing', 'heartbeat', 'beat', 'throb', 'breathe', 'grow and shrink'], cycle: 1, loop: true, at(ph, o) { const b = 1 + 0.15 * o.amp * Math.pow(pos(S(ph)), 3) + 0.06 * o.amp * Math.pow(pos(S(ph * 2 + 0.1)), 4); return { scale: [b, b, b] }; } },
  swing: { label: 'Swing', words: ['swing', 'swinging', 'pendulum', 'sway', 'swaying', 'rock', 'rocking'], cycle: 2, loop: true, at(ph, o) { return { rot: [0, 0, 25 * o.amp * S(ph)] }; } },
  orbit: { label: 'Orbit', words: ['orbit', 'circle', 'circling', 'around', 'loop around'], cycle: 4, loop: true, at(ph, o) { const r = 1.5 * o.amp; return { pos: [r * Math.sin(TAU * ph), 0, r * Math.cos(TAU * ph) - r], rot: [0, 360 * ph, 0] }; } },
  flip: { label: 'Flip', words: ['flip', 'flipping', 'somersault', 'backflip', 'cartwheel'], cycle: 1.2, loop: false, at(ph, o) { const e = ease(ph); return { pos: [0, 1.4 * o.amp * Math.sin(Math.PI * ph), 0], rot: [(o.dir === 'backward' ? 360 : -360) * e, 0, 0] }; } },
  wobble: { label: 'Wobble', words: ['wobble', 'wobbling', 'jelly', 'jiggle', 'wiggle', 'squish', 'squishy'], cycle: 1.2, loop: true, at(ph, o) { const s = S(ph * 2); return { scale: [1 + 0.1 * o.amp * s, 1 - 0.12 * o.amp * s, 1 + 0.1 * o.amp * s], rot: [5 * o.amp * S(ph), 0, 5 * o.amp * S(ph + 0.25)] }; } },
  jump: { label: 'Jump', words: ['jump', 'jumping', 'leap'], cycle: 1, loop: true, at(ph, o) { const h = 4 * ph * (1 - ph); return { pos: [0, 1.5 * o.amp * h, 0], scale: [1, 1 + 0.15 * h, 1] }; } },
  roll: { label: 'Roll', words: ['roll', 'rolling', 'wheel'], cycle: 3, loop: true, at(ph, o) { const d = o.dir === 'left' ? -1 : 1; const x = 2 * o.amp * S(ph * 0.5); return { pos: [x * d, 0, 0], rot: [0, 0, -x * d * (180 / Math.PI) / 0.5] }; } },
  zigzag: { label: 'Zigzag', words: ['zigzag', 'zig zag', 'zig-zag'], cycle: 3, loop: true, at(ph, o) { const tri = (x) => 4 * Math.abs(x - Math.floor(x + 0.5)) - 1; return { pos: [0.8 * o.amp * tri(ph * 3), 0, 1.5 * o.amp * S(ph * 0.5)] }; } },
  figure8: { label: 'Figure eight', words: ['figure 8', 'figure eight', 'figure-8', 'infinity'], cycle: 4, loop: true, at(ph, o) { return { pos: [1.2 * o.amp * S(ph), 0, 0.6 * o.amp * S(ph * 2)] }; } },
  grow: { label: 'Grow in', words: ['grow', 'appear', 'pop in', 'spawn', 'scale up', 'pop'], cycle: 1, loop: false, at(ph) { const t = ph; const s = t < 0.7 ? ease(t / 0.7) * 1.15 : 1.15 - 0.15 * ease((t - 0.7) / 0.3); return { scale: [s, s, s] }; } },
  shrink: { label: 'Shrink away', words: ['shrink', 'disappear', 'vanish', 'scale down', 'poof'], cycle: 1, loop: false, at(ph) { const s = ph < 0.25 ? 1 + 0.1 * ease(ph / 0.25) : 1.1 * (1 - ease((ph - 0.25) / 0.75)); return { scale: [Math.max(s, 0.001), Math.max(s, 0.001), Math.max(s, 0.001)] }; } },
  fadein: { label: 'Fade in', words: ['fade in', 'fadein'], cycle: 1.5, loop: false, at(ph) { return { opacity: ease(ph) }; } },
  fadeout: { label: 'Fade out', words: ['fade out', 'fadeout', 'fade'], cycle: 1.5, loop: false, at(ph) { return { opacity: 1 - ease(ph) }; } },
  blink: { label: 'Blink', words: ['blink', 'flash', 'flicker', 'strobe'], cycle: 1, loop: true, at(ph) { return { visible: S(ph * 3) > -0.6 }; } },
  rainbow: { label: 'Color cycle', words: ['rainbow', 'color', 'colour', 'colors', 'colours', 'hue', 'disco'], cycle: 3, loop: true, at(ph) { return { hue: ph }; } },
  rise: { label: 'Rise', words: ['rise', 'up', 'ascend', 'lift', 'fly up'], cycle: 2, loop: false, at(ph, o) { return { pos: [0, 2 * o.amp * ease(ph), 0] }; } },
  sink: { label: 'Sink', words: ['sink', 'down', 'descend', 'drop', 'fall'], cycle: 1.5, loop: false, at(ph, o) { const e = ph * ph; return { pos: [0, -1.5 * o.amp * e, 0] }; } },
  move: { label: 'Slide', words: ['move', 'slide', 'go', 'travel', 'forward', 'backward', 'left', 'right'], cycle: 2, loop: false, at(ph, o) { const d = { left: [-1, 0, 0], right: [1, 0, 0], forward: [0, 0, 1], backward: [0, 0, -1], up: [0, 1, 0], down: [0, -1, 0] }[o.dir || 'forward']; const e = ease(ph) * 2 * o.amp; return { pos: [d[0] * e, d[1] * e, d[2] * e] }; } },
  shake_head: { label: 'Tilt', words: ['tilt', 'lean', 'nod'], cycle: 1.5, loop: true, at(ph, o) { return { rot: [12 * o.amp * S(ph), 0, 0] }; } },
};

// ---------------------------------------------------------------- bone chains
export const CHAIN = {
  wiggle: { label: 'Wiggle chain', words: ['wiggle', 'wag', 'tail', 'tentacle', 'wave', 'snake', 'slither', 'swish', 'flow', 'sway', 'rope', 'worm', 'flag'], cycle: 1.6, loop: true },
};

// Find chains of bones (from roots to leaves) for wiggling.
export function boneChains(bones, start) {
  const set = new Set(bones);
  const chains = [];
  const roots = start ? [start] : bones.filter((b) => !b.parent || !set.has(b.parent));
  const walk = (b, chain) => {
    const kids = b.children.filter((c) => set.has(c));
    chain = chain.concat([b]);
    if (!kids.length) { chains.push(chain); return; }
    if (kids.length === 1) return walk(kids[0], chain);
    // branch: each child starts a new chain, keep parent prefix
    for (const k of kids) walk(k, chain);
  };
  for (const r of roots) walk(r, []);
  return chains;
}

// ---------------------------------------------------------------- bake helpers

export function bakeHumanoid(rig, motionKey, opts = {}) {
  const m = HUMANOID[motionKey];
  const speed = opts.speed || 1;
  const intensity = opts.intensity ?? 1;
  const reps = opts.reps || 1;
  const cycle = m.cycle / speed;
  const duration = opts.duration || (m.loop ? cycle * Math.max(1, Math.round(reps)) : cycle * reps);
  const defaults = defaultParams();
  const forward = opts.travel && m.locomotion ? m.locomotion * speed : 0; // hip-heights per second
  const layer = opts.layer || null; // second motion keys overriding arm params etc.
  const num = (k, p) => typeof p[k] === 'number' && typeof defaults[k] === 'number';
  // hands placed on the body: {left: spot, right: spot}, eased in over `touchIn` seconds
  const touch = opts.touch || null;
  const touchIn = Math.min(0.7, duration * 0.3);
  const LEGS = ['lLegSwing', 'lLegSpread', 'lKnee', 'lFootPitch', 'rLegSwing', 'rLegSpread', 'rKnee', 'rFootPitch', 'hipsX', 'hipsY', 'hipsZ', 'hipsPitch', 'hipsYaw', 'hipsRoll'];
  const fn = (t) => {
    let ph = m.loop ? (t / cycle) % 1 : Math.min(1, (t / cycle) % (1 + 1e-9));
    if (!m.loop && reps > 1) ph = (t / cycle) % 1;
    if (!m.loop && t >= duration - 1e-6 && m.hold) ph = 1;
    let p = m.at(ph, { ...defaults }, opts);
    if (intensity !== 1) for (const k of Object.keys(p)) if (num(k, p)) p[k] = defaults[k] + (p[k] - defaults[k]) * intensity;
    if (forward) p.rootZ = (p.rootZ || 0) + forward * t;
    if (layer) {
      const lm = HUMANOID[layer.key];
      const lc = lm.cycle / (layer.speed || 1);
      const lp = lm.at(lm.loop ? (t / lc) % 1 : Math.min(1, t / lc), { ...defaults }, layer);
      for (const k of Object.keys(lp)) if (num(k, lp) && Math.abs(lp[k] - defaults[k]) > 1e-6 && layer.channels.test(k)) p[k] = lp[k];
    }
    if (opts.lockLegs) {
      for (const k of LEGS) p[k] = defaults[k];
      p.plantFeet = true;
    }
    if (touch) {
      const w = ease(Math.min(1, t / Math.max(1e-3, touchIn)));
      // a fingertip goes to the spot first, then in (a finger slipping between the lips)
      const tp = (v) => (typeof v === 'string' ? { spot: v, weight: w } : { ...v, weight: w, depth: (v.depth || 0) * ease(THREE.MathUtils.clamp((t - touchIn * 0.9) / 0.5, 0, 1)) });
      if (touch.left) p.lTouch = tp(touch.left);
      if (touch.right) p.rTouch = tp(touch.right);
    }
    if (opts.hands) {
      // hand shapes ("thumbs up", "peace sign", "fist") ease in with the motion
      const w = ease(Math.min(1, t / Math.max(1e-3, Math.min(0.5, duration * 0.3))));
      for (const [side, sh] of Object.entries(opts.hands)) {
        const s = side === 'left' ? 'l' : 'r';
        if (!sh) continue;
        p[s + 'Thumb'] = sh.thumb * w; p[s + 'Index'] = sh.index * w; p[s + 'Middle'] = sh.middle * w; p[s + 'Ring'] = sh.ring * w; p[s + 'Pinky'] = sh.little * w; p[s + 'Spread'] = (sh.spread || 0) * w;
        p[s + 'FingersSet'] = true;
        // shown to someone (thumbs up, peace sign): bring the hand up in front
        if (opts.present && opts.present.includes(side)) {
          p[s + 'ArmSwing'] = (p[s + 'ArmSwing'] || 0) + 28 * w; p[s + 'ArmRaise'] = Math.max(p[s + 'ArmRaise'] || 0, 14 * w + (p[s + 'ArmRaise'] || 0) * (1 - w));
          p[s + 'Elbow'] = Math.max(p[s + 'Elbow'] || 0, 105 * w); p[s + 'ElbowUp'] = 0.35 * w;
        }
      }
    }
    return paramsToSpec(p);
  };
  const fps = opts.fps || Math.min(30, Math.max(12, Math.round(24 / Math.max(0.5, speed))));
  const clip = rig.bake(opts.name || m.label, duration, fn, fps);
  clip.userData = { generated: motionKey };
  return clip;
}

// Bake an object motion onto `target` (any Object3D) as root-relative tracks.
export function bakeObject(target, motionKey, opts = {}) {
  const m = OBJECT[motionKey];
  const speed = opts.speed || 1;
  const cycle = m.cycle / speed;
  const reps = opts.reps || 1;
  const duration = opts.duration || cycle * Math.max(1, reps);
  const fps = 30;
  const n = Math.max(2, Math.round(duration * fps) + 1);
  const size = opts.size || 1;
  const amp = (opts.intensity ?? 1);
  const p0 = target.position.clone(), q0 = target.quaternion.clone(), s0 = target.scale.clone();
  const times = [], P = [], Q = [], Sc = [], O = [], V = [], H = [];
  let hasP = false, hasR = false, hasS = false, hasO = false, hasV = false, hasH = false;
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const mat = Array.isArray(target.material) ? target.material[0] : target.material;
  const baseColor = mat && mat.color ? mat.color.clone() : null;
  const baseHSL = baseColor ? baseColor.getHSL({}) : null;
  // translation in parent space scaled by object size
  const parentScale = new THREE.Vector3(1, 1, 1);
  if (target.parent) target.parent.getWorldScale(parentScale);
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * duration;
    let ph = m.loop ? (t / cycle) % 1 : Math.min(1, (t / cycle));
    if (!m.loop && reps > 1) ph = Math.min(1, (t / cycle) % 1 + (t >= duration - 1e-6 ? 1 : 0));
    if (i === n - 1 && m.loop) ph = 1;
    const r = m.at(ph, { ...opts, amp }) || {};
    times.push(t);
    const d = r.pos || [0, 0, 0];
    if (r.pos) hasP = true;
    P.push(p0.x + (d[0] * size) / parentScale.x, p0.y + (d[1] * size) / parentScale.y, p0.z + (d[2] * size) / parentScale.z);
    const rr = r.rot || [0, 0, 0];
    if (r.rot) hasR = true;
    e.set(THREE.MathUtils.degToRad(rr[0]), THREE.MathUtils.degToRad(rr[1]), THREE.MathUtils.degToRad(rr[2]), 'XYZ');
    q.setFromEuler(e).premultiply(q0);
    if (i > 0 && Q.length >= 4) { const pq = new THREE.Quaternion().fromArray(Q, Q.length - 4); if (pq.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); }
    Q.push(q.x, q.y, q.z, q.w);
    const sc = r.scale || [1, 1, 1];
    if (r.scale) hasS = true;
    Sc.push(s0.x * sc[0], s0.y * sc[1], s0.z * sc[2]);
    if (r.opacity !== undefined) { hasO = true; O.push(r.opacity); } else O.push(1);
    if (r.visible !== undefined) { hasV = true; V.push(!!r.visible); } else V.push(true);
    if (r.hue !== undefined && baseHSL) { hasH = true; const c = new THREE.Color().setHSL((baseHSL.h + r.hue) % 1, Math.max(0.55, baseHSL.s), Math.min(0.65, Math.max(0.45, baseHSL.l))); H.push(c.r, c.g, c.b); } else if (baseColor) H.push(baseColor.r, baseColor.g, baseColor.b);
  }
  const tracks = [];
  const id = target.uuid;
  if (hasP) tracks.push(new THREE.VectorKeyframeTrack(id + '.position', times, P));
  if (hasR) tracks.push(new THREE.QuaternionKeyframeTrack(id + '.quaternion', times, Q));
  if (hasS) tracks.push(new THREE.VectorKeyframeTrack(id + '.scale', times, Sc));
  const matPrefix = Array.isArray(target.material) ? '.material[0].' : '.material.';
  if (hasO && mat) { mat.transparent = true; tracks.push(new THREE.NumberKeyframeTrack(id + matPrefix + 'opacity', times, O)); }
  if (hasV) { const tr = new THREE.BooleanKeyframeTrack(id + '.visible', times, V); tracks.push(tr); }
  if (hasH && mat && mat.color) tracks.push(new THREE.ColorKeyframeTrack(id + matPrefix + 'color', times, H));
  const clip = new THREE.AnimationClip(opts.name || m.label, duration, tracks);
  clip.userData = { generated: motionKey };
  return clip;
}

// For objects whose own tracks would fight with the gizmo (e.g. a model root),
// keep positions relative by animating the given target.
export function bakeChain(chains, opts = {}) {
  const speed = opts.speed || 1;
  const cycle = CHAIN.wiggle.cycle / speed;
  const duration = opts.duration || cycle * Math.max(1, opts.reps || 2);
  const amp = (opts.intensity ?? 1) * 22;
  const fps = 30;
  const n = Math.max(2, Math.round(duration * fps) + 1);
  const tracks = [];
  const axisName = opts.axis || 'auto';
  for (const chain of chains) {
    chain.forEach((bone, i) => {
      const q0 = bone.quaternion.clone();
      // bend axis: perpendicular to bone direction (child offset), prefer local Z or X
      const child = chain[i + 1] || bone.children.find((c) => c.isBone);
      const dir = child ? child.position.clone().normalize() : new THREE.Vector3(0, 1, 0);
      let axis = axisName === 'x' ? new THREE.Vector3(1, 0, 0) : axisName === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
      if (axisName === 'auto') {
        axis = Math.abs(dir.z) > 0.8 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
        axis.addScaledVector(dir, -axis.dot(dir)).normalize();
      }
      const times = [], vals = [];
      const falloff = 0.5 + (i / Math.max(1, chain.length - 1)) * 0.8;
      for (let k = 0; k < n; k++) {
        const t = (k / (n - 1)) * duration;
        const a = THREE.MathUtils.degToRad(amp * falloff * Math.sin(TAU * (t / cycle) - i * 0.7));
        const q = q0.clone().multiply(new THREE.Quaternion().setFromAxisAngle(axis, a));
        times.push(t); vals.push(q.x, q.y, q.z, q.w);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(bone.uuid + '.quaternion', times, vals));
    });
  }
  const clip = new THREE.AnimationClip(opts.name || 'Wiggle', duration, tracks);
  clip.userData = { generated: 'wiggle' };
  return clip;
}

export function motionList() {
  return {
    humanoid: Object.entries(HUMANOID).map(([k, v]) => ({ key: k, label: v.label })),
    object: Object.entries(OBJECT).map(([k, v]) => ({ key: k, label: v.label })),
  };
}
