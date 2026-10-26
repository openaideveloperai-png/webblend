// AI animation assistant.
//  - Offline engine: understands plain-English requests and bakes procedural motions.
//  - Claude: free-form requests -> JSON keyframes, baked through the same rig-independent
//    pose system. Uses the viewer's claude.ai account when hosted as an artifact
//    (window.claude "sample" capability), or the user's API key in a local copy.
import * as THREE from 'three';
import Anthropic from '@anthropic-ai/sdk';
import { HUMANOID, OBJECT, CHAIN, bakeHumanoid, bakeObject, bakeChain, boneChains } from './motions.js';
import { POSE_PARAMS, defaultParams, paramsToSpec } from './humanoid.js';
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

export function parsePrompt(text) {
  const clean = String(text || '').toLowerCase().replace(/[“”"]/g, '').trim();
  const stepTexts = clean.split(/\s*(?:,?\s*\bthen\b|,?\s*\bafter that\b|,?\s*\bfollowed by\b|;|->|→|\band then\b)\s*/).filter(Boolean);
  const steps = stepTexts.map((st) => ({
    text: st,
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
export function isSimplePrompt(text) {
  const p = parsePrompt(text);
  if (!p.steps.every((s) => s.human.length || s.object.length || s.chain.length)) return false;
  const words = String(text).toLowerCase().replace(/[^a-z0-9\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  const motionWords = new Set();
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
      if (!h && m.bones.length) s += `; bones: ${m.bones.slice(0, 50).map((b) => b.name).join(', ')}${m.bones.length > 50 ? ', …' : ''}`;
      if (m.clips.length) s += `; existing clips: ${m.clips.map((c) => c.clip.name).join(', ')}`;
      if (app.selection.model === m) s += ' [SELECTED]';
      lines.push(s);
    }
    return lines.join('\n') || '(empty scene)';
  }

  instructions(prompt) {
    const params = Object.entries(POSE_PARAMS).map(([k, [d, desc]]) => `${k} (default ${d})${desc ? ': ' + desc : ''}`).join('\n');
    return `You create keyframe animations for a browser 3D animation tool. Reply with ONE JSON object only.

SCENE (models the user can animate):
${this.sceneDescription()}

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
    "objectKeys": [{"t": seconds, "channel": "position"|"rotation"|"scale"|"opacity"|"color", "x": n, "y": n, "z": n}],
    "boneKeys": [{"t": seconds, "bone": "bone name", "x": deg, "y": deg, "z": deg}]
  }]
}

RULES
- Humanoid characters: prefer humanoidKeys with these rig-independent parameters (degrees unless noted). Unlisted params keep their default. Character space: +x = character's left, +y up, +z forward.
${params}
- A preset (e.g. "walk") can be combined with humanoidKeys: keys override the preset's params for that clip (good for "walk while waving").
- objectKeys: position = offset from the object's current place in multiples of its size; rotation = degrees (x,y,z euler) added to its current rotation; scale = multipliers; opacity uses x (0-1); color uses x,y,z as r,g,b 0-1.
- boneKeys rotate a bone (degrees, local x/y/z) relative to its rest pose. Use them for tails, wings, tentacles, robots, creatures.
- Use 4-30 keys per clip, spaced through the duration, with natural ease (anticipation, overshoot, follow-through). For loops make the last key equal the first.
- Keep motions physically plausible and within joint limits (elbows/knees 0-150, head yaw within ±80).

USER REQUEST: ${prompt}`;
  }

  schema() {
    const paramEnum = Object.keys(POSE_PARAMS);
    const presets = ['none', ...Object.keys(HUMANOID), ...Object.keys(OBJECT).map((k) => 'object:' + k)];
    return {
      type: 'object',
      additionalProperties: false,
      required: ['message', 'clips'],
      properties: {
        message: { type: 'string' },
        clips: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'target', 'duration', 'loop', 'preset', 'speed', 'intensity', 'humanoidKeys', 'objectKeys', 'boneKeys'],
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
              objectKeys: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, required: ['t', 'channel', 'x', 'y', 'z'], properties: { t: { type: 'number' }, channel: { type: 'string', enum: ['position', 'rotation', 'scale', 'opacity', 'color'] }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
              },
              boneKeys: {
                type: 'array',
                items: { type: 'object', additionalProperties: false, required: ['t', 'bone', 'x', 'y', 'z'], properties: { t: { type: 'number' }, bone: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } } },
              },
            },
          },
        },
      },
    };
  }

  async askClaude(prompt, { signal, onText } = {}) {
    const provider = this.provider();
    const full = this.instructions(prompt);
    if (provider === 'claude-ai') {
      return await this.sample.json(full, { signal, onText: onText ? ({ text }) => onText(text) : undefined, cache: false });
    }
    if (provider === 'api') {
      const client = new Anthropic({ apiKey: this.app.settings.apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
      const model = this.app.settings.get('aiModel') || 'claude-opus-5-5';
      const supportsFallback = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
      const req = {
        model,
        max_tokens: 32000,
        output_config: { effort: this.app.settings.get('aiEffort') || 'medium', format: { type: 'json_schema', schema: this.schema() } },
        messages: [{ role: 'user', content: full }],
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

  // Turn Claude's JSON into clips on models
  buildFromSpec(spec) {
    const results = [];
    const notes = [];
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
    return { results, notes };
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
    if (rig && (hKeys.length || (preset && HUMANOID[preset]))) {
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
          if (intensity !== 1) for (const k of Object.keys(p)) p[k] = defaults[k] + (p[k] - defaults[k]) * intensity;
        }
        for (const k of keyed) { if (k in p) { const v = valueAt(k, t); if (v !== undefined && isFinite(v)) p[k] = v; } }
        return paramsToSpec(p);
      }, 30);
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
    clip.userData = { generated: 'ai' };
    return clip;
  }
}

function findBone(model, name) {
  const n = String(name).toLowerCase();
  return model.bones.find((b) => b.name.toLowerCase() === n) || model.bones.find((b) => b.name.toLowerCase().endsWith(n) || b.name.toLowerCase().replace(/^.*[:|]/, '') === n) || null;
}

export function parseJSONLoose(text) {
  try { return JSON.parse(text); } catch { /* try harder */ }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  if (fence) { try { return JSON.parse(fence[1]); } catch { /* continue */ } }
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(text.slice(a, b + 1));
  throw new Error('Could not read the AI response as JSON');
}
