// AI animation assistant.
//  - Offline engine: understands plain-English requests and bakes procedural motions.
//  - Claude: free-form requests -> JSON keyframes, baked through the same rig-independent
//    pose system. Uses the viewer's claude.ai account when hosted as an artifact
//    (window.claude "sample" capability), or the user's API key in a local copy.
import * as THREE from 'three';
import { translateName, nameWithTranslation } from '../core/jp.js';
import { describeBody } from './bodymap.js';
import { buildProp, presetSpec, findPresetIn, findStyleIn, PROP_PRESETS, STYLE_NAMES, TEXTURES } from '../scene/props.js';
import { attachProp, detachProp, bakeHoldClip, heldProps, recoilOf, holdDriver, addShotEffects } from './props-anim.js';
import Anthropic from '@anthropic-ai/sdk';
import { HUMANOID, OBJECT, CHAIN, bakeHumanoid, bakeObject, bakeChain, boneChains } from './motions.js';
import { POSE_PARAMS, defaultParams, paramsToSpec, SPOTS } from './humanoid.js';
import { inArtifact } from '../core/util.js';

const NUM_WORDS = { once: 1, one: 1, twice: 2, two: 2, three: 3, thrice: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const LAYERABLE = {
  wave: (o) => new RegExp(`^(${o.side === 'left' ? 'l' : 'r'}(Arm|Elbow|Hand)|head)`),
  point: (o) => new RegExp(`^(${o.side === 'left' ? 'l' : 'r'}(Arm|Elbow|Hand))`),
  nod: () => /^(head|neck)/,
  shake: () => /^(head|neck)/,
  look: () => /^(head|neck)/,
  clap: () => /^(l|r)(Arm|Elbow|Hand)/,
  cheer: () => /^(l|r)(Arm|Elbow|Hand)|^head/,
  punch: () => /^(l|r)(Arm|Elbow|Hand)|^chest/,
  think: () => /^(l|r)(Arm|Elbow|Hand)|^head/,
  shrug: () => /^(l|r)(Arm|Elbow|Hand|Shoulder)|^head/,
};

// ------------------------------------------------------------ prompt parsing

function findMotions(text, table) {
  const found = [];
  for (const [key, m] of Object.entries(table)) {
    for (const w of m.words) {
      const re = new RegExp(`(^|[^a-z])${w.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}($|[^a-z])`, 'i');
      const mm = re.exec(text);
      if (mm) { found.push({ key, index: mm.index, len: w.length }); break; }
    }
  }
  // prefer longer phrases when they overlap ("jumping jacks" over "jump")
  found.sort((a, b) => a.index - b.index || b.len - a.len);
  const out = [];
  for (const f of found) {
    const prev = out[out.length - 1];
    if (prev && f.index < prev.index + prev.len) continue;
    out.push(f);
  }
  return out;
}

export function parseModifiers(text) {
  const t = text.toLowerCase();
  const o = { speed: 1, intensity: 1 };
  if (/\b(very|super|extremely|really) (fast|quick)/.test(t)) o.speed = 2;
  else if (/\b(fast|quick|quickly|rapid|rapidly|hurry|energetic)\b/.test(t)) o.speed = 1.5;
  if (/\b(very|super|extremely|really) slow/.test(t)) o.speed = 0.45;
  else if (/\b(slow|slowly|lazy|lazily|calm|calmly|relaxed|gently)\b/.test(t)) o.speed = 0.65;
  if (/\b(huge|exaggerated|crazy|wild|wildly|big|large|dramatic|intense|strong|hard)\b/.test(t)) o.intensity = 1.5;
  if (/\b(tiny|subtle|small|little|slight|slightly|gentle|soft)\b/.test(t)) o.intensity = 0.55;
  const dur = /(\d+(?:\.\d+)?)\s*(s|sec|secs|second|seconds)\b/.exec(t);
  if (dur) o.duration = Math.min(60, Math.max(0.2, parseFloat(dur[1])));
  const ms = /(\d+)\s*(ms|milliseconds?)\b/.exec(t);
  if (ms) o.duration = Math.max(0.2, parseInt(ms[1], 10) / 1000);
  const reps = /\b(\d+|once|twice|thrice|one|two|three|four|five|six|seven|eight|nine|ten)\s*(times|x\b)|\b(once|twice|thrice)\b/.exec(t);
  if (reps) o.reps = NUM_WORDS[reps[1] || reps[3]] || parseInt(reps[1], 10) || 1;
  if (/\bleft (hand|arm|leg|foot)\b|\bwith (the |his |her |their )?left\b|\bleft-handed\b/.test(t)) o.side = 'left';
  else if (/\bright (hand|arm|leg|foot)\b|\bwith (the |his |her |their )?right\b/.test(t)) o.side = 'right';
  const dir = /\b(to the |towards? the |toward )?(left|right|forward|forwards|backward|backwards|back|up|down|clockwise|counterclockwise|counter-clockwise|anticlockwise)\b/.exec(t);
  if (dir && !o.side) o.dir = dir[2].replace(/s$/, '').replace('back', 'backward').replace('backwardward', 'backward').replace(/counter-?clockwise|anticlockwise/, 'left').replace('clockwise', 'right');
  if (/\b(on|around|along) (the )?x( axis|-axis)?\b|\bx axis\b/.test(t)) o.axis = 'x';
  else if (/\b(on|around|along) (the )?z( axis|-axis)?\b|\bz axis\b/.test(t)) o.axis = 'z';
  if (/\b(forward|across|ahead|around the|toward|towards|away|travel|move forward|walk forward|run forward)\b/.test(t) && !/in place/.test(t)) o.travel = true;
  if (/\b(loop|looping|forever|continuous|continuously|repeat|repeating|keep)\b/.test(t)) o.loop = true;
  if (/\bmarch/.test(t)) o.march = true;
  return o;
}

// "put her left hand on her lap", "hands on hips", "hand under the belly"...
const SPOT_WORDS = [
  ['lower belly', 'lap'], ['lower stomach', 'lap'], ['lower tummy', 'lap'], ['under belly', 'lap'], ['underbelly', 'lap'], ['lap', 'lap'],
  ['belly', 'belly'], ['stomach', 'belly'], ['tummy', 'belly'], ['abdomen', 'belly'], ['waist', 'hip'], ['hips', 'hip'], ['hip', 'hip'],
  ['heart', 'heart'], ['chest', 'chest'], ['breasts', 'chest'], ['breast', 'chest'],
  ['back of head', 'backOfHead'], ['back of her head', 'backOfHead'], ['back of his head', 'backOfHead'], ['back of the head', 'backOfHead'],
  ['top of head', 'head'], ['top of her head', 'head'], ['top of his head', 'head'], ['forehead', 'forehead'], ['brow', 'forehead'],
  ['head', 'head'], ['mouth', 'face'], ['lips', 'face'], ['face', 'face'], ['eyes', 'eyes'], ['eye', 'eyes'], ['ears', 'ear'], ['ear', 'ear'],
  ['neck', 'neck'], ['throat', 'neck'],
  ['cheek', 'cheek'], ['cheeks', 'cheek'], ['chin', 'chin'], ['jaw', 'chin'], ['shoulder', 'shoulder'], ['shoulders', 'shoulder'],
  ['thighs', 'thigh'], ['thigh', 'thigh'], ['legs', 'thigh'], ['leg', 'thigh'], ['knees', 'knee'], ['knee', 'knee'],
  ['lower back', 'back'], ['back', 'back'],
];
const SPOT_RE = SPOT_WORDS.map(([w]) => w.replace(/ /g, '\\s+')).join('|');
const TOUCH_RE = new RegExp(`\\b(?:(left|right|both|one|two|her|his|their|the|a)\\s+)?(hands?|palms?|arms?)\\b(.{0,40}?)\\b(on|onto|over|against|at|to|under|below|beneath|behind|across|touching|touch)\\s+(?:(?:her|his|their|the|its|my|your|own|each|other)\\s+)*(${SPOT_RE})\\b`, 'gi');
const NEGATION = /\b(don'?t|do\s+not|not|never|without|no|avoid)\b[^.,;]{0,25}$/i;

export function parseTouches(text) {
  const t = String(text || '').toLowerCase().replace(/[’']/g, "'");
  const touches = [];
  let m;
  TOUCH_RE.lastIndex = 0;
  while ((m = TOUCH_RE.exec(t))) {
    if (NEGATION.test(t.slice(Math.max(0, m.index - 30), m.index))) continue;
    const word = m[5].replace(/\s+/g, ' ');
    let spot = (SPOT_WORDS.find(([w]) => w === word) || [])[1];
    if (!spot) continue;
    if ((m[4] === 'under' || m[4] === 'below' || m[4] === 'beneath') && spot === 'belly') spot = 'lap';
    if (m[4] === 'behind') spot = spot === 'head' || spot === 'neck' || spot === 'backOfHead' ? 'backOfHead' : 'back';
    const sideWord = m[1] || (/\b(left|right)\b/.exec(m[3]) || [])[1];
    const plural = /s$/.test(m[2]) || sideWord === 'both' || sideWord === 'two';
    const sides = sideWord === 'left' ? ['left'] : sideWord === 'right' ? ['right'] : plural ? ['left', 'right'] : ['right'];
    for (const side of sides) touches.push({ side, spot, at: m.index });
  }
  // poses said without "hand on ...": arms crossed, covering the eyes...
  const idiom = (re, spot, sides) => {
    re.lastIndex = 0;
    let mm;
    while ((mm = re.exec(t))) {
      if (NEGATION.test(t.slice(Math.max(0, mm.index - 30), mm.index))) continue;
      const sideWord = (/\b(left|right)\b/.exec(mm[0]) || [])[1];
      for (const side of sideWord ? [sideWord] : sides) touches.push({ side, spot, at: mm.index });
    }
  };
  idiom(/\b(cross(es|ed|ing)?|fold(s|ed|ing)?)\s+(?:(?:her|his|their|the|its|both)\s+)*arms\b|\barms\s+(crossed|folded)\b/g, 'crossed', ['left', 'right']);
  idiom(/\b(cover(s|ed|ing)?|hid(e|es|ing))\s+(?:(?:her|his|their|the|its|both|left|right)\s+)*eyes?\b|\bpeek-?a-?boo\b/g, 'eyes', ['left', 'right']);
  idiom(/\b(cover(s|ed|ing)?|plug(s|ged|ging)?)\s+(?:(?:her|his|their|the|its|both)\s+)*ears\b/g, 'ear', ['left', 'right']);
  idiom(/\b(cover(s|ed|ing)?)\s+(?:(?:her|his|their|the|its)\s+)*mouth\b|\b(gasp(s|ed|ing)?|yawn(s|ed|ing)?)\b/g, 'face', ['right']);
  idiom(/\bface-?palm(s|ed|ing)?\b/g, 'forehead', ['right']);
  // "touch her ear", "scratch his head", "rub her belly": one hand
  {
    const re = new RegExp(`\\b(?:touch(?:es|ed|ing)?|scratch(?:es|ed|ing)?|rub(?:s|bed|bing)?|pat(?:s|ted|ting)?|hold(?:s|ing)?|clutch(?:es|ed|ing)?|grab(?:s|bed|bing)?)\\s+(?:(?:her|his|their|the|its|my|your|own|left|right)\\s+)*(${SPOT_RE})\\b`, 'g');
    let mm;
    while ((mm = re.exec(t))) {
      if (NEGATION.test(t.slice(Math.max(0, mm.index - 30), mm.index))) continue;
      const spot = (SPOT_WORDS.find(([w]) => w === mm[1].replace(/\s+/g, ' ')) || [])[1];
      if (!spot || touches.some((x) => x.spot === spot && x.at !== undefined && Math.abs(x.at - mm.index) < 40)) continue;
      const sideWord = (/\b(left|right)\b/.exec(mm[0]) || /^\s+(?:with|using)\s+(?:(?:her|his|their|the|its|my|your)\s+)?(left|right)\b/.exec(t.slice(mm.index + mm[0].length)) || [])[1];
      touches.push({ side: sideWord || 'right', spot, at: mm.index });
    }
  }
  idiom(/\b(thinking|thinker)\s+pose\b|\bchin\s+(on|in)\s+(?:(?:her|his|their|the|a)\s+)*hand\b/g, 'chin', ['right']);
  touches.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  // later mentions win for the same hand
  const bySide = {};
  for (const x of touches) bySide[x.side] = x.spot;
  const lockLegs = /\b(standing|stand still|stands still|while (she|he|they)('s| is| are)? standing|keep (the |her |his |their )?(legs|feet)|(don'?t|do not|not|never|no) (move|touch|moving|touching|bend|bending|animate)( (the|her|his|their))? (legs?|feet|knees?)|legs? (still|straight)|without moving)\b/.test(t);
  return { touch: Object.keys(bySide).length ? bySide : null, lockLegs };
}

// "make a gun and shoot 3 times", "give her a rifle", "aim", "drop the gun"
const NUMW = { once: 1, one: 1, a: 1, twice: 2, two: 2, three: 3, thrice: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12, twenty: 20 };
export function parsePropRequest(text) {
  const t = ' ' + String(text || '').toLowerCase().replace(/[’']/g, "'") + ' ';
  const preset = findPresetIn(t);
  const make = !!preset && /\b(make|makes|create|build|give|gives|add|spawn|generate|model|craft|equip|hand her|hand him|arm|get|with|holding|hold|carry|carrying|wield|wielding|draw|pull out|take out)\b/.test(t);
  const negShoot = /\b(don'?t|do not|not|never|no)\s+(shoot|fire)/.test(t);
  const shootWord = !negShoot && /\b(shoot|shoots|shooting|shot|shots|fire|fires|firing|blast|blasting|pew|unload|unloads|spray|spraying|burst|open fire)\b/.test(t);
  let count = null;
  const m = t.match(/\b(\d+|once|twice|thrice|one|two|three|four|five|six|seven|eight|nine|ten|twelve|twenty)\s*(times|time|shots|shot|rounds|round|bullets|bullet|x)?\b/);
  if (m && (m[2] || /^(once|twice|thrice)$/.test(m[1]))) count = Number(m[1]) || NUMW[m[1]] || null;
  const auto = /\b(full auto|full-auto|automatic|spray|spraying|unload|unloads|mag dump|empty the mag|machine gun)\b/.test(t);
  const burst = /\bburst\b/.test(t);
  const aim = /\b(aim|aims|aiming|point (the|her|his|their)? ?(gun|weapon|rifle|pistol))\b/.test(t);
  const hold = /\b(hold|holds|holding|carry|carries|carrying|wield|wielding|draw|equip)\b/.test(t);
  const drop = /\b(drop|drops|remove|delete|put away|holster|get rid of|throw away|lose)\b.{0,20}\b(gun|weapon|pistol|rifle|sword|knife|prop|it|shotgun|katana|bat|smg|sniper)\b/.test(t);
  const swing = /\b(slash|slashes|slashing|swing|swings|swinging|attack|attacks|attacking|strike|strikes|chop|chops|cut|cuts|stab|stabs|hit|hits|combo)\b/.test(t);
  const side = /\b(left hand|left-handed|in (her|his|their|the) left)\b/.test(t) ? 'left' : 'right';
  const style = findStyleIn(t);
  const any = make || shootWord || aim || drop || (swing && !!preset);
  return any ? { preset, make, shoot: shootWord, swing, count, auto, burst, aim, hold, drop, side, style } : null;
}

export function parsePrompt(text) {
  const clean = String(text || '').toLowerCase().replace(/[“”"]/g, '').trim();
  const stepTexts = clean.split(/\s*(?:,?\s*\bthen\b|,?\s*\bafter that\b|,?\s*\bfollowed by\b|;|->|→|\band then\b)\s*/).filter(Boolean);
  const steps = stepTexts.map((st) => ({
    text: st,
    touch: parseTouches(st),
    human: findMotions(st, HUMANOID),
    object: findMotions(st, OBJECT),
    chain: findMotions(st, CHAIN),
    opts: parseModifiers(st),
  }));
  let target = 'selected';
  if (/\b(all|every|everything|everyone|each|both)\b/.test(clean)) target = 'all';
  const global = parseModifiers(clean);
  return { steps, target, global };
}

const FILLER = new Set(('make let have get do does please can could would you i want him her them it its the a an to and then with me my his their this that is be '
  + 'character model object guy man woman person robot cube sphere ball everything all everyone each both selected one times time seconds second sec s x loop forever '
  + 'slow slowly fast quickly quick very super really big small little tiny gentle subtle hard soft left right up down forward backward back around in place '
  + 'once twice thrice two three four five six seven eight nine ten for of on at by like while again some bit just start keep continuously repeat after followed').split(/\s+/));

// Short requests made only of motion words + modifiers are handled instantly offline.
const PROP_WORDS = new Set(('make makes create build give gives add spawn equip hand arm get with holding hold holds carry wield draw pull take out shoot shoots shooting shot shots fire fires firing blast pew unload spray burst open aim aims aiming point drop remove put away holster slash slashes slashing swing swings swinging attack attacks strike strikes chop cut stab hit hits combo full auto automatic mag dump times rounds bullets x her his him their them gun weapon').split(/\s+/));
for (const p of Object.values(PROP_PRESETS)) for (const w of p.words) for (const part of w.split(/[\s-]+/)) PROP_WORDS.add(part);
for (const w of ['tan', 'fde', 'desert', 'sand', 'olive', 'green', 'silver', 'chrome', 'gold', 'golden', 'wood', 'wooden', 'white', 'red', 'pink', 'blue', 'black']) PROP_WORDS.add(w);

// "make a lightsaber" (a model we have no preset for)
const MAKE_SOMETHING = /\b(make|makes|create|build|model|design|craft|generate|give|gives)\s+(me\s+|her\s+|him\s+|them\s+)?(a|an|the|some|my|his|her)\s+[a-z]/i;
export function wantsCustomModel(text) {
  return MAKE_SOMETHING.test(String(text || '')) && !findPresetIn(text);
}

export function isSimplePrompt(text) {
  if (wantsCustomModel(text)) return false;
  // prop requests the built-in models cover ("make a gun and shoot 3 times")
  const pr = parsePropRequest(text);
  if (pr) {
    const words = String(text).toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/[\s-]+/).filter(Boolean);
    const unknown = words.filter((w) => !FILLER.has(w) && !PROP_WORDS.has(w) && !/^\d+(\.\d+)?s?$/.test(w));
    return unknown.length === 0 && (!!pr.preset || pr.shoot || pr.aim || pr.drop || pr.swing);
  }
  const p = parsePrompt(text);
  if (!p.steps.every((s) => s.human.length || s.object.length || s.chain.length || s.touch.touch)) return false;
  const words = String(text).toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  const motionWords = new Set(['hand', 'hands', 'palm', 'palms', 'arm', 'arms', 'put', 'place', 'rest', 'resting', 'touch', 'touching', 'over', 'onto', 'under', 'below', 'behind', 'against', 'other', 'own', 'top', 'lower', 'pose', 'posing', 'still',
    'cross', 'crosses', 'crossed', 'crossing', 'fold', 'folds', 'folded', 'folding', 'cover', 'covers', 'covered', 'covering', 'hide', 'hides', 'hiding', 'plug', 'plugs', 'facepalm', 'facepalms', 'gasp', 'gasps', 'yawn', 'yawns', 'thinking', 'thinker', 'peekaboo']);
  for (const [w] of SPOT_WORDS) for (const part of w.split(/\s+/)) motionWords.add(part);
  for (const t of [HUMANOID, OBJECT, CHAIN]) for (const m of Object.values(t)) for (const w of m.words) for (const part of w.split(/\s+/)) motionWords.add(part);
  const unknown = words.filter((w) => !FILLER.has(w) && !motionWords.has(w) && !/^\d+(\.\d+)?s?$/.test(w));
  return unknown.length <= 1;
}

// ------------------------------------------------------------ clip utils

// Concatenate clips in time (same targets). Missing tracks hold their neighbour values.
export function concatClips(clips, name) {
  const names = new Map();
  for (const c of clips) for (const t of c.tracks) if (!names.has(t.name)) names.set(t.name, t);
  const tracks = [];
  let offset = 0;
  const segs = clips.map((c) => { const s = { clip: c, offset }; offset += c.duration; return s; });
  for (const [tn, proto] of names) {
    const times = [], vals = [];
    const size = proto.getValueSize();
    let last = null;
    for (const { clip, offset: off } of segs) {
      const tr = clip.tracks.find((t) => t.name === tn);
      if (tr) {
        for (let i = 0; i < tr.times.length; i++) {
          const tt = tr.times[i] + off;
          if (times.length && tt <= times[times.length - 1] + 1e-5) {
            // replace a coincident key
            times.pop(); vals.splice(vals.length - size, size);
          }
          times.push(tt);
          for (let j = 0; j < size; j++) vals.push(tr.values[i * size + j]);
        }
        last = Array.from(tr.values.slice((tr.times.length - 1) * size));
      } else if (last) {
        times.push(off + clip.duration);
        vals.push(...last);
      }
    }
    if (!times.length) continue;
    const T = proto.constructor;
    const nt = new T(tn, times, vals);
    nt.setInterpolation(proto.getInterpolation());
    tracks.push(nt);
  }
  return new THREE.AnimationClip(name || clips.map((c) => c.name).join(' → '), offset, tracks);
}

// ------------------------------------------------------------ assistant

export class AIAssistant {
  constructor(app) {
    this.app = app;
    this.sample = null;
    this.sampleReady = null;
    if (inArtifact()) {
      this.sampleReady = window.claude.use('sample').then((s) => { this.sample = s; return s; }).catch(() => null);
    }
  }

  // which engine will answer free-form prompts
  provider() {
    const pref = this.app.settings.get('aiProvider');
    if (pref === 'offline') return 'offline';
    if (pref === 'claude-ai') return this.sample ? 'claude-ai' : 'offline';
    if (pref === 'api') return this.app.settings.apiKey ? 'api' : 'offline';
    if (this.sample) return 'claude-ai';
    if (this.app.settings.apiKey) return 'api';
    return 'offline';
  }

  providerLabel(p = this.provider()) {
    return { 'claude-ai': 'Claude (your claude.ai account)', api: 'Claude (your API key)', offline: 'Built-in motion engine (offline)' }[p];
  }

  resolveTargets(target) {
    const app = this.app;
    const animatable = app.models.filter((m) => m.kind !== 'light-env');
    if (target === 'all') return animatable.map((m) => ({ model: m, object: m.root }));
    if (target && target !== 'selected') {
      const t = target.toLowerCase();
      const hit = animatable.find((m) => m.name.toLowerCase() === t) || animatable.find((m) => m.name.toLowerCase().includes(t) || t.includes(m.name.toLowerCase()));
      if (hit) return [{ model: hit, object: hit.root }];
    }
    const sel = app.selection;
    if (sel.model) {
      let obj = sel.object || sel.model.root;
      // a skinned mesh or the root means "the whole model"
      if (obj.isSkinnedMesh || obj === sel.model.root || (sel.model.humanoid && !obj.isBone)) obj = sel.model.root;
      return [{ model: sel.model, object: obj }];
    }
    if (animatable.length === 1) return [{ model: animatable[0], object: animatable[0].root }];
    return [];
  }

  // Offline: returns {results:[{model, clip}], message, understood}
  runOffline(prompt) {
    const pr = parsePropRequest(prompt);
    if (pr) { const r = this.runProps(pr, prompt); if (r) return r; }
    if (wantsCustomModel(prompt) && !parsePrompt(prompt).steps.some((st) => st.human.length || st.object.length || st.touch.touch)) {
      return { results: [], message: `Without Claude I can only make the built-in models: ${Object.keys(PROP_PRESETS).join(', ')}. Add an API key in Settings → AI (or use the hosted page) and Claude can model anything you describe.`, understood: false };
    }
    const parsed = parsePrompt(prompt);
    const targets = this.resolveTargets(parsed.target);
    if (!targets.length) return { results: [], message: 'Select a model first (click it in the viewport or the Scene list), or add one from the Add menu.', understood: false };
    const results = [];
    const notes = [];
    let understood = true;
    for (const { model, object } of targets) {
      const rig = object === model.root ? model.humanoid : null;
      const segs = [];
      for (const step of parsed.steps) {
        const opts = { ...parsed.global, ...step.opts };
        if (rig && step.touch.touch) {
          // hands placed on the body, on top of a base motion (or a still pose)
          const base = step.human.find((h) => !LAYERABLE[h.key]) || null;
          const key = base ? base.key : 'still';
          const touch = { ...step.touch.touch };
          if (key === 'sit') for (const sd of ['left', 'right']) if (touch[sd] === 'lap') touch[sd] = 'thigh';
          const BOTH = { crossed: 'arms crossed', eyes: 'covering the eyes', ear: 'covering the ears', backOfHead: 'hands behind the head', hip: 'hands on hips', lap: 'hands on lap' };
          const where = touch.left && touch.left === touch.right && BOTH[touch.left] ? BOTH[touch.left]
            : Object.entries(touch).map(([sd, sp]) => (sp === 'crossed' ? `${sd} arm crossed` : `${sd} hand on ${SPOTS[sp] ? SPOTS[sp].label.replace(/ \(.*\)/, '') : sp}`)).join(', ');
          const still = HUMANOID[key].still || key === 'still';
          segs.push(bakeHumanoid(rig, key, { ...opts, touch, lockLegs: step.touch.lockLegs || still, duration: opts.duration || (HUMANOID[key].loop ? Math.max(3, HUMANOID[key].cycle) : undefined), name: (base ? HUMANOID[key].label + ' + ' : '') + where.charAt(0).toUpperCase() + where.slice(1) }));
          continue;
        }
        if (rig && step.human.length) {
          const base = step.human[0];
          let layer = null;
          if (step.human.length > 1) {
            const second = step.human[1];
            const firstIsGesture = !!LAYERABLE[base.key] && !LAYERABLE[second.key];
            const [b, l] = firstIsGesture ? [second, base] : [base, second];
            if (LAYERABLE[l.key]) layer = { key: l.key, side: opts.side, channels: LAYERABLE[l.key](opts) };
            segs.push(bakeHumanoid(rig, b.key, { ...opts, layer, name: HUMANOID[b.key].label + (layer ? ' + ' + HUMANOID[l.key].label : '') }));
          } else {
            segs.push(bakeHumanoid(rig, base.key, { ...opts, name: HUMANOID[base.key].label }));
          }
        } else if (!rig && model.bones.length && (step.chain.length || (!step.object.length && step.human.length))) {
          const start = object.isBone ? object : null;
          const chains = boneChains(model.bones, start).filter((c) => c.length >= 2);
          if (chains.length) segs.push(bakeChain(chains, { ...opts, name: 'Wiggle' }));
        } else if (step.object.length) {
          const key = step.object[0].key;
          segs.push(bakeObject(object, key, { ...opts, size: this.sizeOf(model, object), name: OBJECT[key].label }));
        } else if (rig && step.object.length === 0 && step.human.length === 0 && step.chain.length === 0) {
          understood = false;
        } else if (step.human.length && !rig) {
          // humanoid word on a plain object: use the closest object motion
          const map = { jump: 'jump', walk: 'move', run: 'move', dance: 'wobble', wave: 'swing', nod: 'shake_head', shake: 'shake', fly: 'float', turn: 'spin', cheer: 'bounce', fall: 'sink', squat: 'pulse', jacks: 'bounce', swim: 'float' };
          const k = map[step.human[0].key] || 'bounce';
          segs.push(bakeObject(object, k, { ...opts, size: this.sizeOf(model, object), name: OBJECT[k].label }));
          notes.push(`"${model.name}" has no humanoid skeleton, so I used "${OBJECT[k].label}" instead.`);
        } else {
          understood = false;
        }
      }
      if (!segs.length) {
        understood = false;
        // fallback so the user always gets something
        if (rig) segs.push(bakeHumanoid(rig, 'idle', { name: 'Idle' }));
        else segs.push(bakeObject(object, 'float', { size: this.sizeOf(model, object), name: 'Float' }));
      }
      const clip = segs.length > 1 ? concatClips(segs) : segs[0];
      results.push({ model, clip, loop: parsed.global.loop || (segs.length === 1 && this.isLoop(clip)) });
    }
    const msg = results.map((r) => `Made "${r.clip.name}" (${r.clip.duration.toFixed(1)}s) on ${r.model.name}.`).join(' ') + (notes.length ? ' ' + notes.join(' ') : '');
    return { results, message: understood ? msg : `I didn't fully understand that, so ${msg.charAt(0).toLowerCase() + msg.slice(1)} Try words like: walk, run, jump, wave, dance, bounce, spin, float.`, understood };
  }

  // props offline: make / hold / aim / shoot / drop
  runProps(pr, prompt) {
    const app = this.app;
    const targets = this.resolveTargets('selected').filter((t) => t.object === t.model.root || t.object.isSkinnedMesh || t.object.isBone);
    const holder = targets.map((t) => t.model).find((m) => m.humanoid && m.adopt) || (app.models || []).find((m) => m.humanoid && m.adopt && (!app.selection.model || app.selection.model === m));
    const results = [], props = [], notes = [];
    if (!holder) {
      if (!pr.make || !app.addModel) return null;
      // nobody to hold it: put it in the scene on its own
      const prop = buildProp(presetSpec(pr.preset, { style: pr.style }));
      const m = app.addModel(prop, { name: prop.name, kind: 'prop' });
      return { results, props: [{ model: m, prop, standalone: true }], message: `Made a ${prop.name.toLowerCase()} (${PROP_PRESETS[pr.preset] ? 'built-in model' : 'model'}). Add or select a character and say "shoot" to use it.`, understood: true };
    }
    if (pr.drop && !pr.make) {
      const held = heldProps(holder);
      for (const p of held) app.removeProp ? app.removeProp(holder, p) : detachProp(holder, p);
      return { results, props: [], message: held.length ? `Took the ${held.map((p) => p.name.toLowerCase()).join(' and ')} away from ${holder.name}.` : `${holder.name} isn't holding anything.`, understood: true };
    }
    let prop = heldProps(holder).find((p) => p.userData.hold.side === pr.side) || heldProps(holder)[0];
    const wantKey = pr.preset || (pr.shoot && !prop ? 'pistol' : null);
    if (wantKey && (pr.make || !prop || (prop.userData.prop.preset !== wantKey && pr.preset))) {
      for (const p of heldProps(holder).filter((x) => x.userData.hold.side === pr.side)) app.removeProp ? app.removeProp(holder, p) : detachProp(holder, p);
      prop = buildProp(presetSpec(wantKey, { style: pr.style }));
      if (app.giveProp) app.giveProp(holder, prop, pr.side); else attachProp(holder, prop, pr.side);
      props.push({ model: holder, prop });
    }
    if (!prop) return null;
    const P = prop.userData.prop;
    const melee = P.kind === 'melee';
    let shots = 0;
    if (pr.shoot && !melee) {
      const rate = recoilOf(prop).rate;
      shots = pr.count || (pr.auto ? 15 : pr.burst ? 3 : P.auto ? 8 : rate < 1.5 ? 2 : 3);
      if (pr.burst && P.auto) shots = Math.max(3, Math.min(shots, 5));
    }
    const swings = melee && (pr.swing || pr.shoot) ? (pr.count || 2) : 0;
    const { clip } = bakeHoldClip(holder, prop, { shots, swings, aim: pr.aim, name: shots ? `Shoot ${prop.name.toLowerCase()} ×${shots}` : swings ? `Swing ${prop.name.toLowerCase()} ×${swings}` : pr.aim ? `${melee ? 'Guard' : 'Aim'} ${prop.name.toLowerCase()}` : `Hold ${prop.name.toLowerCase()}` });
    results.push({ model: holder, clip, loop: !shots && !swings && !pr.aim });
    if (pr.swing && !melee && !pr.shoot) notes.push(`(Say "shoot" to fire it.)`);
    const made = props.length ? `Made a ${prop.name.toLowerCase()} and put it in ${holder.name}'s ${pr.side} hand. ` : '';
    return { results, props, message: made + `Made "${clip.name}" (${clip.duration.toFixed(1)}s)${shots ? ' with muzzle flash, tracers, recoil and casings' : ''}.` + (notes.length ? ' ' + notes.join(' ') : ''), understood: true };
  }

  isLoop(clip) {
    const key = clip.userData?.generated;
    return !!((HUMANOID[key] && HUMANOID[key].loop) || (OBJECT[key] && OBJECT[key].loop) || key === 'wiggle');
  }

  sizeOf(model, object) {
    if (object === model.root) return model.size;
    const box = new THREE.Box3().setFromObject(object);
    const s = box.getSize(new THREE.Vector3());
    return Math.max(s.x, s.y, s.z, model.size * 0.05);
  }

  // ---------------------------------------------------------- Claude
  sceneDescription() {
    const app = this.app;
    const lines = [];
    for (const m of app.models) {
      const h = m.humanoid;
      const type = h ? 'humanoid character (use humanoidKeys / humanoid presets)' : m.bones.length ? `rigged model with ${m.bones.length} bones (use boneKeys)` : m.root.isLight ? 'light' : m.root.isCamera ? 'camera' : 'object (use objectKeys / object presets)';
      let s = `- "${m.name}": ${type}; size ${m.size.toFixed(2)} units`;
      if (!h && m.bones.length) {
        const list = (m.poseBones && m.poseBones.length ? m.poseBones : m.bones);
        s += `; bones${list.some((b) => translateName(b.name)) ? ' (Japanese names translated)' : ''}: ${list.slice(0, 60).map((b) => nameWithTranslation(b.name)).join(', ')}${list.length > 60 ? ', …' : ''}`;
      }
      if (m.clips.length) s += `; existing clips: ${m.clips.map((c) => c.clip.name).join(', ')}`;
      if (m.adopt) { const held = heldProps(m); if (held.length) s += `; holding: ${held.map((p) => `"${p.name}" (${p.userData.hold.side} hand, ${p.userData.prop.kind}${p.userData.prop.preset !== 'custom' ? ', preset ' + p.userData.prop.preset : ''})`).join(', ')}`; }
      if (m.kind === 'prop') s += ' (a prop model)';
      if (app.selection.model === m) s += ' [SELECTED]';
      lines.push(s);
      if (h) { try { const b = describeBody(m); if (b) lines.push(b); } catch (e) { console.warn('body map', e); } }
    }
    return lines.join('\n') || '(empty scene)';
  }

  instructions(prompt, ctx = {}) {
    const params = Object.entries(POSE_PARAMS).map(([k, [d, desc]]) => `${k} (default ${d})${desc ? ': ' + desc : ''}`).join('\n');
    const earlier = (this.history || []).slice(-4).map((h) => `- user: ${h.prompt}\n  you made: ${h.summary}`).join('\n');
    return `You create keyframe animations and 3D props for a browser 3D animation tool. Reply with ONE JSON object only.

SCENE (models the user can animate):
${this.sceneDescription()}
${earlier ? `\nEARLIER IN THIS SESSION (the user may refer back, e.g. "make it faster", "now with the left hand"):\n${earlier}\n` : ''}${ctx.images ? `\nThe user attached ${ctx.images} reference image(s). Use them: match a pose or motion they show, or the shape, proportions and colors of an object to model.\n` : ''}${ctx.research ? `\nWEB RESEARCH for this request (from a search just now):\n${ctx.research}\n` : ''}
JSON FORMAT:
{
  "message": "one short sentence telling the user what you made",
  "clips": [{
    "name": "clip name",
    "target": "model name from the scene, or \\"selected\\", or \\"all\\"",
    "duration": seconds (0.3-30),
    "loop": true/false (loop = first and last pose should match),
    "preset": one of ${JSON.stringify(['none', ...Object.keys(HUMANOID), ...Object.keys(OBJECT).map((k) => 'object:' + k)])},
    "speed": 1, "intensity": 1,
    "humanoidKeys": [{"t": seconds, "values": [{"param": "rElbow", "value": 70}, ...]}],
    "handTouches": [{"t": seconds, "hand": "left"|"right", "spot": "lap", "weight": 0-1}],
    "plantFeet": true/false,
    "objectKeys": [{"t": seconds, "channel": "position"|"rotation"|"scale"|"opacity"|"color", "x": n, "y": n, "z": n}],
    "boneKeys": [{"t": seconds, "bone": "bone name", "x": deg, "y": deg, "z": deg}],
    "useProp": "name of a prop the target holds (made in this reply or already held), or \"\"",
    "aimKeys": [{"t": seconds, "weight": 0-1, "yaw": deg, "pitch": deg}],
    "shots": [seconds, ...],
    "swings": [{"t": seconds, "back": false}]
  }],
  "props": [{
    "name": "e.g. Pistol", "holder": "model name, \"selected\", or \"none\"", "hand": "right"|"left",
    "preset": "custom" or ${JSON.stringify(Object.keys(PROP_PRESETS))}, "style": "default" or ${JSON.stringify(STYLE_NAMES)},
    "kind": "gun"|"melee"|"prop",
    "materials": [{"name": "steel", "color": "#3a3d43", "metalness": 0.9, "roughness": 0.3, "emissive": "#000000", "emissiveIntensity": 0, "opacity": 1, "texture": one of ${JSON.stringify(TEXTURES)}}],
    "parts": [{"name": "slide", "shape": "box|cylinder|cone|tube|sphere|capsule|torus|extrude|lathe|helix", "material": "steel", "parent": "", "pos": [x,y,z], "rot": [x,y,z], "dims": [...], "axis": "x|y|z", "profile": [[u,v],...], "holes": [[[u,v],...]], "bevel": meters, "segments": 24}],
    "anchors": {"grip": [x,y,z], "support": [], "muzzle": [], "eject": [], "stock": [], "sight": []},
    "slide": "part that cycles when firing, or \"\"", "slideTravel": meters, "fireRate": shots per second, "caliber": "none|9mm|5.56|.308|12ga", "action": "none|semi|auto|pump|bolt"
  }]
}

RULES
- Humanoid characters: prefer humanoidKeys with these rig-independent parameters (degrees unless noted). Unlisted params keep their default. Character space: +x = character's left, +y up, +z forward.
${params}
- A preset (e.g. "walk") can be combined with humanoidKeys: keys override the preset's params for that clip (good for "walk while waving").
- To put a hand ON the body, use handTouches instead of arm angles: the app measures this character's actual body surface and uses IK so the palm rests exactly on that spot, with the hand turned to lie flat. Spots: ${Object.entries(SPOTS).map(([k, v]) => `"${k}" = ${v.label}`).join('; ')}. A touch key has weight 0-1: ease in from 0 to 1 over about 0.4-0.7 s and back to 0 to take the hand away. While a hand's touch weight is 1, that arm's humanoidKeys are ignored. "On her lap" while standing means the "lap" spot (front of the lower belly / top of the thighs, below the belly); use "thigh" when sitting.
- plantFeet: true keeps both feet exactly where they stand; the legs only bend to follow the hips. Use it for anything done standing or in place. Do not key leg or hips params unless the user asks for leg/hip motion, and never when they say not to move the legs.
- Held poses (hand on lap, hands on hips, hand on chest...) should look calm: after the hands arrive, keep the body nearly still with only subtle breathing (chestPitch about ±1.5, tiny headPitch), and loop only that breathing.
- objectKeys: position = offset from the object's current place in multiples of its size; rotation = degrees (x,y,z euler) added to its current rotation; scale = multipliers; opacity uses x (0-1); color uses x,y,z as r,g,b 0-1.
- boneKeys rotate a bone (degrees, local x/y/z) relative to its rest pose. Use them for tails, wings, tentacles, robots, creatures.
- Use 4-30 keys per clip, spaced through the duration, with natural ease (anticipation, overshoot, follow-through). For loops make the last key equal the first.

PROPS (3D models the user asks you to make: guns, swords, tools, items...). Leave "props" empty when none is needed.
- Prefer a built-in preset when it fits: they are detailed, high-quality models (pistol, rifle, smg, sniper, shotgun, sword, katana, knife, bat). Recolor with "style", rename with "name", and add extra parts in "parts" (a suppressor, laser, scope, bayonet, engraving...) positioned in the preset's frame; leave materials empty to keep the preset's.
- Otherwise use "custom" and build it from parts. Units are meters at real-world size. Prop frame: +Z forward (barrel, blade edge, front), +Y up, +X the prop's left. When held, the hand closes around the "grip" anchor with the fingers along +Z and the thumb toward +Y: a gun's barrel runs along +Z with the grip below it; a melee weapon's handle runs along Y with the blade toward +Y and the edge toward +Z.
- Shapes and dims: box [width x, height y, depth z] (bevel = edge radius); cylinder/cone [radiusTop, radiusBottom, length] along "axis"; tube (hollow) [outerRadius, innerRadius, length]; sphere [rx, ry, rz]; capsule [radius, length]; torus [ringRadius, tubeRadius, arcDegrees] with "axis" = ring normal; extrude: a 2D outline "profile" [[u,v],...] (8-30 points, counterclockwise or clockwise) extruded by dims[0] (thickness), centered — axis "x" means the outline is the SIDE view (u = z forward, v = y up) extruded sideways: best for gun bodies, slides, stocks, grips, blades, magazines, axes; axis "y" = top view (u = x, v = z); axis "z" = front view (u = x, v = y); "holes" cut openings (trigger guards, windows); lathe: "profile" [[radius, height],...] spun around "axis" (barrels, muzzle devices, scopes, bottles, handles, pommels, lamps); helix [radius, wireRadius, length, turns] (springs, grip wraps). "pos" is the center (extrude/lathe: where their 0,0 is), "rot" degrees XYZ, "parent" = another part's name (then pos/rot are relative to it). Unused fields: [] / "" / 0.
- Make it look high-grade: 30-120 parts. Get the silhouette right with extrude outlines and a 1-3 mm bevel, then add the details that sell it: seams and grooves (thin dark boxes), serrations, screws and pins, vents, rails, sights, buttons and levers, edge highlights, labels/inlays. 3-7 materials with believable PBR values (metal: metalness 0.8-1, roughness 0.2-0.45; plastic/polymer: metalness 0, roughness 0.5-0.75; rubber 0.9; glass opacity 0.4) and fitting textures (brushed or scratched metal, stipple on grips, knurled, wood, carbon, leather, glow for lights/energy).
- Name parts that move "slide", "bolt", "pump", "trigger" or "magazine" (their children move with them). Anchors (prop frame, meters): grip = center of where the main hand holds; support = where the other hand holds ([] for one-handed items); muzzle = barrel tip; eject = ejection port; stock = rear end of a shoulder stock ([] for pistols); sight = a point on the sight line. Guns: set fireRate, caliber, action, slide and slideTravel.
- holder: who holds it (a humanoid in the scene, "selected", or "none" to just place it in the scene).
- To animate with a held prop set the clip's "useProp" to the prop's name. aimKeys weight 0 = relaxed, holding it at the side; 1 = aimed (guns: two-handed, on the line of sight; rifles shouldered; melee: guard stance), yaw/pitch = aim direction in degrees (+yaw = character's left, +pitch = up). "shots" = times the gun fires: recoil, muzzle flash, tracer, slide/bolt/pump cycling and ejected casings are added automatically; respect the gun's fire rate and aim first (weight 1 at least 0.2 s before the first shot). "swings" = melee slash start times ({back: true} = backhand). While aimed or swinging, the arms' humanoidKeys are ignored; legs/body keys and presets still apply (e.g. preset "walk" + aimKeys + shots to shoot while walking). Keep plantFeet true unless the legs should move.
- Keep motions physically plausible and within joint limits (elbows/knees 0-150, head yaw within ±80).

USER REQUEST: ${prompt}`;
  }

  schema() {
    const paramEnum = Object.keys(POSE_PARAMS);
    const presets = ['none', ...Object.keys(HUMANOID), ...Object.keys(OBJECT).map((k) => 'object:' + k)];
    return {
      type: 'object',
      additionalProperties: false,
      required: ['message', 'clips', 'props'],
      properties: {
        message: { type: 'string' },
        clips: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'target', 'duration', 'loop', 'preset', 'speed', 'intensity', 'humanoidKeys', 'handTouches', 'plantFeet', 'objectKeys', 'boneKeys', 'useProp', 'aimKeys', 'shots', 'swings'],
            properties: {
              name: { type: 'string' },
              target: { type: 'string' },
              duration: { type: 'number' },
              loop: { type: 'boolean' },
              preset: { type: 'string', enum: presets },
              speed: { type: 'number' },
              intensity: { type: 'number' },
              humanoidKeys: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false, required: ['t', 'values'],
                  properties: {
                    t: { type: 'number' },
                    values: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['param', 'value'], properties: { param: { type: 'string', enum: paramEnum }, value: { type: 'number' } } } },
                  },
                },
              },
              handTouches: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, required: ['t', 'hand', 'spot', 'weight'], properties: { t: { type: 'number' }, hand: { type: 'string', enum: ['left', 'right'] }, spot: { type: 'string', enum: Object.keys(SPOTS) }, weight: { type: 'number' } } },
              },
              plantFeet: { type: 'boolean' },
              objectKeys: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, required: ['t', 'channel', 'x', 'y', 'z'], properties: { t: { type: 'number' }, channel: { type: 'string', enum: ['position', 'rotation', 'scale', 'opacity', 'color'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
              },
              boneKeys: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, required: ['t', 'bone', 'x', 'y', 'z'], properties: { t: { type: 'number' }, bone: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
              },
              useProp: { type: 'string' },
              aimKeys: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, required: ['t', 'weight', 'yaw', 'pitch'], properties: { t: { type: 'number' }, weight: { type: 'number' }, yaw: { type: 'number' }, pitch: { type: 'number' } } },
              },
              shots: { type: 'array', items: { type: 'number' } },
              swings: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, required: ['t', 'back'], properties: { t: { type: 'number' }, back: { type: 'boolean' } } },
              },
            },
          },
        },
        props: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'holder', 'hand', 'preset', 'style', 'kind', 'materials', 'parts', 'anchors', 'slide', 'slideTravel', 'fireRate', 'caliber', 'action'],
            properties: {
              name: { type: 'string' },
              holder: { type: 'string' },
              hand: { type: 'string', enum: ['right', 'left'] },
              preset: { type: 'string', enum: ['custom', ...Object.keys(PROP_PRESETS)] },
              style: { type: 'string', enum: ['default', ...STYLE_NAMES] },
              kind: { type: 'string', enum: ['gun', 'melee', 'prop'] },
              materials: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false, required: ['name', 'color', 'metalness', 'roughness', 'emissive', 'emissiveIntensity', 'opacity', 'texture'],
                  properties: { name: { type: 'string' }, color: { type: 'string' }, metalness: { type: 'number' }, roughness: { type: 'number' }, emissive: { type: 'string' }, emissiveIntensity: { type: 'number' }, opacity: { type: 'number' }, texture: { type: 'string', enum: TEXTURES } },
                },
              },
              parts: {
                type: 'array',
                items: {
                  type: 'object', additionalProperties: false, required: ['name', 'shape', 'material', 'parent', 'pos', 'rot', 'dims', 'axis', 'profile', 'holes', 'bevel', 'segments'],
                  properties: {
                    name: { type: 'string' }, shape: { type: 'string', enum: ['box', 'cylinder', 'cone', 'tube', 'sphere', 'capsule', 'torus', 'extrude', 'lathe', 'helix'] },
                    material: { type: 'string' }, parent: { type: 'string' },
                    pos: { type: 'array', items: { type: 'number' } }, rot: { type: 'array', items: { type: 'number' } }, dims: { type: 'array', items: { type: 'number' } },
                    axis: { type: 'string', enum: ['x', 'y', 'z'] },
                    profile: { type: 'array', items: { type: 'array', items: { type: 'number' } } },
                    holes: { type: 'array', items: { type: 'array', items: { type: 'array', items: { type: 'number' } } } },
                    bevel: { type: 'number' }, segments: { type: 'number' },
                  },
                },
              },
              anchors: {
                type: 'object', additionalProperties: false, required: ['grip', 'support', 'muzzle', 'eject', 'stock', 'sight'],
                properties: Object.fromEntries(['grip', 'support', 'muzzle', 'eject', 'stock', 'sight'].map((k) => [k, { type: 'array', items: { type: 'number' } }])),
              },
              slide: { type: 'string' },
              slideTravel: { type: 'number' },
              fireRate: { type: 'number' },
              caliber: { type: 'string', enum: ['none', '9mm', '5.56', '.308', '12ga'] },
              action: { type: 'string', enum: ['none', 'semi', 'auto', 'pump', 'bolt'] },
            },
          },
        },
      },
    };
  }

  // can this view send images to Claude?
  async canSendImages() {
    const p = this.provider();
    if (p === 'api') return true;
    if (p === 'claude-ai' && this.sample && this.sample.limits) {
      try { const l = await this.sample.limits(); return !!(l && l.images); } catch { return false; }
    }
    return false;
  }

  // does this request ask for a model that's worth looking up first?
  wantsResearch(prompt) {
    const t = String(prompt || '');
    if (!/\b(make|makes|create|build|model|design|give|craft|generate|add)\b/i.test(t)) return false;
    if (/\b(search|look up|lookup|reference|references|accurate|realistic|real|detailed|high[- ]?(grade|quality|detail)|exact)\b/i.test(t)) return true;
    const preset = findPresetIn(t);
    if (!preset) return true;
    // a specific named thing (model numbers, brands)...
    if (/\b[A-Z][a-z]*[- ]?\d+[A-Za-z]*\b|\b(desert eagle|glock|beretta|colt|kalashnikov|winchester|remington|mossberg|benelli|barrett|sig|hk|heckler|walther|ruger|smith|wesson|thompson|tommy|lightsaber|excalibur|zweihander|claymore|scimitar|rapier)\b/i.test(t)) return true;
    // ...or described with more than a built-in name ("a retro ray gun", "a gun with a drum magazine")
    const words = t.toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/[\s-]+/).filter(Boolean);
    const known = (w) => FILLER.has(w) || PROP_WORDS.has(w) || /^\d+(\.\d+)?s?$/.test(w) || ['like', 'picture', 'image', 'photo', 'this', 'one', 'please', 'it', 'shown'].includes(w);
    return words.filter((w) => !known(w)).length > 0;
  }

  async research(prompt, imageBlocks, { signal, onStatus } = {}) {
    const client = new Anthropic({ apiKey: this.app.settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
    const model = this.app.settings.get('aiModel') || 'claude-opus-5-5';
    const tool = /haiku/.test(model) ? { type: 'web_search_20250305', name: 'web_search', max_uses: 3 } : { type: 'web_search_20260209', name: 'web_search', max_uses: 4 };
    let messages = [{ role: 'user', content: [...(imageBlocks || []), { type: 'text', text: `A 3D artist will build this from simple parts (boxes, extruded outlines, lathed shapes): "${prompt}". Search the web for reference on the object(s) to model: real dimensions in meters, the main parts and their shapes and proportions, details that make it recognizable, colors and materials. Reply with a compact bullet list (at most 250 words) of facts useful for modeling it. No preamble, no links.` }] }];
    onStatus?.('Searching the web for references…');
    for (let round = 0; round < 4; round++) {
      const msg = await client.messages.create({ model, max_tokens: 8000, output_config: { effort: 'low' }, tools: [tool], messages }, { signal });
      if (msg.stop_reason === 'pause_turn') { messages = [...messages, { role: 'assistant', content: msg.content }]; continue; }
      if (msg.stop_reason === 'refusal') return '';
      return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim().slice(0, 3000);
    }
    return '';
  }

  // images (File/Blob) -> base64 JPEG content blocks for the API (max 1568 px)
  static async imageBlocks(images) {
    const out = [];
    for (const img of images || []) {
      try {
        const bmp = await createImageBitmap(img);
        const scale = Math.min(1, 1568 / Math.max(bmp.width, bmp.height));
        const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
        const cv = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
        const g = cv.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
        g.drawImage(bmp, 0, 0, w, h);
        bmp.close?.();
        const blob = cv.convertToBlob ? await cv.convertToBlob({ type: 'image/jpeg', quality: 0.88 }) : await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.88));
        const buf = new Uint8Array(await blob.arrayBuffer());
        let bin = '';
        for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
        out.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: btoa(bin) } });
      } catch (e) { console.warn('image', e); }
    }
    return out;
  }

  remember(prompt, summary) {
    this.history = (this.history || []).concat({ prompt: String(prompt).slice(0, 300), summary: String(summary).slice(0, 400) }).slice(-8);
  }

  async askClaude(prompt, { signal, onText, images, onStatus } = {}) {
    const provider = this.provider();
    const imgs = (images || []).slice(0, 5);
    if (provider === 'claude-ai') {
      const full = this.instructions(prompt, { images: imgs.length });
      const opts = { signal, onText: onText ? ({ text }) => onText(text) : undefined, cache: false };
      if (imgs.length) opts.images = imgs;
      return await this.sample.json(full, opts);
    }
    if (provider === 'api') {
      const client = new Anthropic({ apiKey: this.app.settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
      const model = this.app.settings.get('aiModel') || 'claude-opus-5-5';
      const supportsFallback = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
      const imageBlocks = imgs.length ? await AIAssistant.imageBlocks(imgs) : [];
      let research = '';
      if (this.app.settings.get('aiWebSearch') !== false && this.wantsResearch(prompt)) {
        try { research = await this.research(prompt, imageBlocks, { signal, onStatus }); } catch (e) { if (signal?.aborted) throw e; console.warn('web research failed', e); }
        onStatus?.(research ? 'Found references. Claude is modeling…' : 'Claude is modeling…');
      }
      const full = this.instructions(prompt, { images: imageBlocks.length, research });
      const req = {
        model,
        max_tokens: 64000,
        output_config: { effort: this.app.settings.get('aiEffort') || 'medium', format: { type: 'json_schema', schema: this.schema() } },
        messages: [{ role: 'user', content: imageBlocks.length ? [...imageBlocks, { type: 'text', text: full }] : full }],
      };
      if (supportsFallback) { req.betas = ['server-side-fallback-2026-07-01']; req.fallbacks = 'default'; }
      const stream = supportsFallback ? client.beta.messages.stream(req, { signal }) : client.messages.stream(req, { signal });
      let text = '';
      stream.on('text', (d) => { text += d; onText?.(text); });
      const msg = await stream.finalMessage();
      if (msg.stop_reason === 'refusal') throw new Error('Claude declined this request. Try describing the motion differently.');
      if (msg.stop_reason === 'max_tokens') throw new Error('The answer was too long. Ask for a shorter or simpler animation.');
      const block = msg.content.find((b) => b.type === 'text');
      if (!block) throw new Error('Claude returned no text.');
      return parseJSONLoose(block.text);
    }
    throw new Error('No Claude connection available');
  }

  static errorText(e) {
    if (e instanceof Anthropic.AuthenticationError) return 'Your Anthropic API key was rejected. Check it in Settings → AI.';
    if (e instanceof Anthropic.PermissionDeniedError) return 'This API key does not have access to that model. Pick another model in Settings → AI.';
    if (e instanceof Anthropic.RateLimitError) return 'Rate limited by the Anthropic API. Wait a moment and try again.';
    if (e instanceof Anthropic.APIConnectionError) return 'Could not reach the Anthropic API (offline, or blocked by the network). The built-in engine still works.';
    if (e instanceof Anthropic.APIError) return `Anthropic API error ${e.status}: ${e.message}`;
    if (e && e.code) {
      const map = { not_granted: 'Claude access was not allowed for this page.', rate_limited: 'Too many requests right now. Try again in a bit.', refused: 'Claude declined this request. Try describing it differently.', invalid_json: 'Claude replied in an unexpected format. Try again.', sampling_disabled: 'Claude is not available for this account.', session_expired: 'Your claude.ai session expired. Sign in again.', cancelled: 'Stopped.' };
      return map[e.code] || e.message || 'Claude request failed.';
    }
    return e?.message || String(e);
  }

  // Claude's "props" -> models in hands (or standing in the scene)
  buildProps(spec) {
    const app = this.app;
    const out = [], notes = [];
    const vec = (a) => (Array.isArray(a) && a.length >= 3 && a.slice(0, 3).every((v) => Number.isFinite(Number(v))) ? a.slice(0, 3).map(Number) : null);
    for (const ps of ((spec && spec.props) || []).slice(0, 6)) {
      if (!ps) continue;
      try {
        const style = ps.style && ps.style !== 'default' ? ps.style : undefined;
        const clampDims = (parts) => (parts || []).filter((x) => x && x.shape).slice(0, 400).map((x) => ({ ...x, dims: (x.dims || []).map((v) => Math.max(-20, Math.min(20, Number(v) || 0))) }));
        let def;
        if (ps.preset && ps.preset !== 'custom' && PROP_PRESETS[ps.preset]) {
          def = presetSpec(ps.preset, { style, name: ps.name || undefined });
          if (ps.parts && ps.parts.length) def.parts = [...def.parts, ...clampDims(ps.parts)];
          if (ps.materials && ps.materials.length) {
            const names = new Set(ps.materials.map((m) => m.name));
            def.materials = [...def.materials.filter((m) => !names.has(m.name)), ...ps.materials];
          }
        } else {
          const anchors = {};
          for (const [k, v] of Object.entries(ps.anchors || {})) { const a = vec(v); if (a) anchors[k] = a; }
          def = {
            name: ps.name || 'Prop', kind: ps.kind || 'prop', preset: 'custom', materials: ps.materials || [], parts: clampDims(ps.parts), anchors,
            slide: ps.slide || '', slideTravel: Number(ps.slideTravel) || 0, fireRate: Number(ps.fireRate) || 0,
            caliber: ps.caliber && ps.caliber !== 'none' ? ps.caliber : (ps.kind === 'gun' ? '9mm' : null), action: ps.action && ps.action !== 'none' ? ps.action : null, auto: ps.action === 'auto',
          };
        }
        const prop = buildProp(def);
        let meshes = 0;
        prop.traverse((o) => { if (o.isMesh) meshes++; });
        if (!meshes) { notes.push(`"${ps.name}" came back with no usable parts.`); continue; }
        const side = ps.hand === 'left' ? 'left' : 'right';
        let holder = null;
        if (ps.holder && ps.holder !== 'none') {
          const t = this.resolveTargets(ps.holder === 'selected' ? 'selected' : ps.holder);
          holder = t.map((x) => x.model).find((m) => m.humanoid && m.adopt) || null;
        }
        if (holder) {
          for (const old of heldProps(holder).filter((x) => x.userData.hold.side === side)) app.removeProp(holder, old);
          app.giveProp(holder, prop, side);
          out.push({ model: holder, prop });
        } else {
          const m = app.addModel(prop, { name: prop.name, kind: 'prop', select: false });
          // stand it next to the selected model
          const sel = app.selection.model && app.selection.model !== m ? app.selection.model : null;
          if (sel) { const b = new THREE.Box3().setFromObject(sel.root); if (!b.isEmpty()) prop.position.set(b.max.x + 0.4, Math.max(0.8, (b.min.y + b.max.y) / 2), (b.min.z + b.max.z) / 2); }
          else prop.position.set(0, 1, 0);
          prop.updateMatrixWorld(true);
          m.captureRest();
          out.push({ model: m, prop, standalone: true });
        }
      } catch (e) {
        console.error(e);
        notes.push(`Couldn't build "${ps.name}": ${e.message}`);
      }
    }
    return { props: out, notes };
  }

  // Turn Claude's JSON into clips on models
  buildFromSpec(spec) {
    const results = [];
    const pr = this.buildProps(spec);
    const notes = [...pr.notes];
    for (const c of (spec && spec.clips) || []) {
      const targets = this.resolveTargets(c.target || 'selected');
      for (const { model, object } of targets) {
        try {
          const clip = this.buildClip(model, object, c);
          if (clip && clip.tracks.length) results.push({ model, clip, loop: !!c.loop });
          else notes.push(`Nothing to animate for "${c.name}" on ${model.name}.`);
        } catch (e) {
          console.error(e);
          notes.push(`Couldn't build "${c.name}": ${e.message}`);
        }
      }
    }
    return { results, notes, props: pr.props };
  }

  buildClip(model, object, c) {
    const duration = THREE.MathUtils.clamp(Number(c.duration) || 2, 0.2, 60);
    const speed = THREE.MathUtils.clamp(Number(c.speed) || 1, 0.1, 5);
    const intensity = THREE.MathUtils.clamp(Number(c.intensity) || 1, 0, 3);
    const name = String(c.name || 'AI clip').slice(0, 60);
    const preset = c.preset && c.preset !== 'none' ? c.preset : null;
    const rig = object === model.root ? model.humanoid : null;
    const tracks = [];
    // humanoid
    const hKeys = (c.humanoidKeys || []).filter((k) => k && Array.isArray(k.values)).sort((a, b) => a.t - b.t);
    const tKeys = (c.handTouches || []).filter((k) => k && SPOTS[k.spot] && (k.hand === 'left' || k.hand === 'right')).sort((a, b) => a.t - b.t);
    const touchAt = (hand, t) => {
      const ks = tKeys.filter((k) => k.hand === hand);
      if (!ks.length) return null;
      const w = (k) => THREE.MathUtils.clamp(Number(k.weight ?? 1), 0, 1);
      if (t <= ks[0].t) return { spot: ks[0].spot, weight: ks.length > 1 || ks[0].t <= 0 ? w(ks[0]) : w(ks[0]) * (ks[0].t > 0 ? Math.min(1, t / ks[0].t) : 1) };
      if (t >= ks[ks.length - 1].t) return { spot: ks[ks.length - 1].spot, weight: w(ks[ks.length - 1]) };
      let i = 0;
      while (i < ks.length - 2 && ks[i + 1].t <= t) i++;
      const a = ks[i], b = ks[i + 1];
      const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
      const e = u * u * (3 - 2 * u);
      if (a.spot === b.spot) return { spot: a.spot, weight: w(a) + (w(b) - w(a)) * e };
      // moving from one spot to another: lift off, then land
      return e < 0.5 ? { spot: a.spot, weight: w(a) * (1 - 2 * e) } : { spot: b.spot, weight: w(b) * (2 * e - 1) };
    };
    // a held prop: aim, shots, swings
    let driver = null, heldProp = null;
    if (rig && model.adopt) {
      const held = heldProps(model);
      const want = String(c.useProp || '').toLowerCase();
      heldProp = (want && (held.find((p) => p.name.toLowerCase() === want) || held.find((p) => p.name.toLowerCase().includes(want) || want.includes(p.name.toLowerCase())))) || null;
      if (!heldProp && held.length && ((c.shots && c.shots.length) || (c.swings && c.swings.length) || (c.aimKeys && c.aimKeys.length) || want)) heldProp = held[0];
      if (heldProp) {
        const aKeys = (c.aimKeys || []).filter((k) => k && Number.isFinite(Number(k.t))).sort((a, b) => a.t - b.t);
        const lerpKey = (field, t, d) => {
          if (!aKeys.length) return d;
          const g = (k) => (Number.isFinite(Number(k[field])) ? Number(k[field]) : d);
          if (t <= aKeys[0].t) return g(aKeys[0]);
          if (t >= aKeys[aKeys.length - 1].t) return g(aKeys[aKeys.length - 1]);
          let i = 0;
          while (i < aKeys.length - 2 && aKeys[i + 1].t <= t) i++;
          const a = aKeys[i], b = aKeys[i + 1];
          const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
          const e = u * u * (3 - 2 * u);
          return g(a) + (g(b) - g(a)) * e;
        };
        const shotTimes = (c.shots || []).map(Number).filter((x) => Number.isFinite(x) && x >= 0 && x < duration - 0.05);
        driver = holdDriver(model, heldProp, {
          shotTimes,
          swingList: (c.swings || []).filter((x) => x && Number.isFinite(Number(x.t)) && x.t < duration).map((x) => ({ t: Number(x.t), back: !!x.back })),
          aimAt: aKeys.length ? (t) => THREE.MathUtils.clamp(lerpKey('weight', t, 0), 0, 1) : undefined,
          aimDir: (t) => ({ yaw: THREE.MathUtils.clamp(lerpKey('yaw', t, 0), -80, 80), pitch: THREE.MathUtils.clamp(lerpKey('pitch', t, 0), -60, 60) }),
          duration, lower: false,
        });
      }
    }
    if (rig && (hKeys.length || tKeys.length || (preset && HUMANOID[preset]) || driver)) {
      const defaults = defaultParams();
      const presetM = preset && HUMANOID[preset];
      const cycle = presetM ? presetM.cycle / speed : duration;
      const keyed = new Set(hKeys.flatMap((k) => k.values.map((v) => v.param)));
      const valueAt = (param, t) => {
        // smooth interpolation between keys for one param
        const ks = hKeys.filter((k) => k.values.some((v) => v.param === param));
        if (!ks.length) return undefined;
        const get = (k) => k.values.find((v) => v.param === param).value;
        if (t <= ks[0].t) return get(ks[0]);
        if (t >= ks[ks.length - 1].t) return get(ks[ks.length - 1]);
        let i = 0;
        while (i < ks.length - 2 && ks[i + 1].t <= t) i++;
        const a = ks[i], b = ks[i + 1];
        const u = (t - a.t) / Math.max(1e-6, b.t - a.t);
        const e = u * u * (3 - 2 * u);
        return get(a) + (get(b) - get(a)) * e;
      };
      const clip = rig.bake(name, duration, (t) => {
        let p = { ...defaults };
        if (presetM) {
          const ph = presetM.loop ? (t / cycle) % 1 : Math.min(1, t / cycle);
          p = presetM.at(ph, p, {});
          if (intensity !== 1) for (const k of Object.keys(p)) if (typeof p[k] === 'number' && typeof defaults[k] === 'number') p[k] = defaults[k] + (p[k] - defaults[k]) * intensity;
        }
        for (const k of keyed) { if (k in p) { const v = valueAt(k, t); if (v !== undefined && isFinite(v)) p[k] = v; } }
        const lt = touchAt('left', t), rt = touchAt('right', t);
        if (lt) p.lTouch = lt;
        if (rt) p.rTouch = rt;
        if (c.plantFeet) p.plantFeet = true;
        if (driver) driver.apply(t, p);
        return paramsToSpec(p);
      }, driver ? driver.fps : 30);
      if (driver && driver.shots.length) addShotEffects(model, heldProp, clip, driver.shots);
      tracks.push(...clip.tracks);
    } else if (preset && preset.startsWith('object:') && OBJECT[preset.slice(7)]) {
      const clip = bakeObject(object, preset.slice(7), { speed, intensity, duration, size: this.sizeOf(model, object) });
      tracks.push(...clip.tracks);
    } else if (preset && HUMANOID[preset] && !rig) {
      const clip = bakeObject(object, 'bounce', { speed, intensity, duration, size: this.sizeOf(model, object) });
      tracks.push(...clip.tracks);
    }
    // object keys
    const oKeys = (c.objectKeys || []).filter((k) => k && k.channel).sort((a, b) => a.t - b.t);
    if (oKeys.length) {
      const size = this.sizeOf(model, object);
      const p0 = object.position.clone(), q0 = object.quaternion.clone(), s0 = object.scale.clone();
      const parentScale = new THREE.Vector3(1, 1, 1);
      if (object.parent) object.parent.getWorldScale(parentScale);
      const by = (ch) => oKeys.filter((k) => k.channel === ch);
      const pk = by('position');
      if (pk.length) tracks.push(new THREE.VectorKeyframeTrack(object.uuid + '.position', pk.map((k) => k.t), pk.flatMap((k) => [p0.x + (k.x * size) / parentScale.x, p0.y + (k.y * size) / parentScale.y, p0.z + (k.z * size) / parentScale.z])));
      const rk = by('rotation');
      if (rk.length) {
        let prev = null;
        const vals = rk.flatMap((k) => {
          const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(k.x), THREE.MathUtils.degToRad(k.y), THREE.MathUtils.degToRad(k.z))).premultiply(q0);
          if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
          prev = q;
          return q.toArray();
        });
        tracks.push(new THREE.QuaternionKeyframeTrack(object.uuid + '.quaternion', rk.map((k) => k.t), vals));
      }
      const sk = by('scale');
      if (sk.length) tracks.push(new THREE.VectorKeyframeTrack(object.uuid + '.scale', sk.map((k) => k.t), sk.flatMap((k) => [s0.x * (k.x || 1e-3), s0.y * (k.y || 1e-3), s0.z * (k.z || 1e-3)])));
      const mat = Array.isArray(object.material) ? object.material[0] : object.material;
      const prefix = Array.isArray(object.material) ? '.material[0].' : '.material.';
      const ok = by('opacity');
      if (ok.length && mat) { mat.transparent = true; tracks.push(new THREE.NumberKeyframeTrack(object.uuid + prefix + 'opacity', ok.map((k) => k.t), ok.map((k) => THREE.MathUtils.clamp(k.x, 0, 1)))); }
      const ck = by('color');
      if (ck.length && mat && mat.color) tracks.push(new THREE.ColorKeyframeTrack(object.uuid + prefix + 'color', ck.map((k) => k.t), ck.flatMap((k) => [k.x, k.y, k.z].map((v) => THREE.MathUtils.clamp(v, 0, 1)))));
      // object keys on a target without material: apply to child meshes
    }
    // bone keys
    const bKeys = (c.boneKeys || []).filter((k) => k && k.bone).sort((a, b) => a.t - b.t);
    if (bKeys.length) {
      const byBone = new Map();
      for (const k of bKeys) {
        const bone = findBone(model, k.bone);
        if (!bone) continue;
        if (!byBone.has(bone)) byBone.set(bone, []);
        byBone.get(bone).push(k);
      }
      for (const [bone, ks] of byBone) {
        const rest = model.rest.get(bone)?.q || bone.quaternion.clone();
        let prev = null;
        const vals = ks.flatMap((k) => {
          const q = rest.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(THREE.MathUtils.degToRad(k.x), THREE.MathUtils.degToRad(k.y), THREE.MathUtils.degToRad(k.z))));
          if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
          prev = q;
          return q.toArray();
        });
        tracks.push(new THREE.QuaternionKeyframeTrack(bone.uuid + '.quaternion', ks.map((k) => k.t), vals));
      }
    }
    const clip = new THREE.AnimationClip(name, duration, tracks);
    clip.userData = { generated: 'ai', prop: heldProp ? heldProp.uuid : undefined };
    return clip;
  }
}

function findBone(model, name) {
  const raw = String(name || '').trim();
  // the AI may copy "足.L (leg (thigh).L)" or just the translation
  const bare = raw.replace(/\s*\(.*\)\s*$/, '');
  for (const c of [raw, bare]) {
    const n = c.toLowerCase();
    const b = model.bones.find((x) => x.name === c) || model.bones.find((x) => x.name.toLowerCase() === n);
    if (b) return b;
  }
  const n = bare.toLowerCase(), nr = raw.toLowerCase();
  return model.bones.find((b) => { const t = translateName(b.name); return t && (t.toLowerCase() === nr || t.toLowerCase() === n); })
    || model.bones.find((b) => b.name.toLowerCase().endsWith(n) || b.name.toLowerCase().replace(/^.*[:|]/, '') === n) || null;
}

export function parseJSONLoose(text) {
  try { return JSON.parse(text); } catch { /* try harder */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* continue */ } }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
  throw new Error('Could not read the AI response as JSON');
}
