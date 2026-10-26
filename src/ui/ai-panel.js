// AI tab: chat-style animation requests.
import { h, icon, clear } from './dom.js';
import { AIAssistant, parsePrompt } from '../anim/ai.js';

export function initAIPanel(app, ui) {
  const root = document.getElementById('tab-ai');
  const ai = app.ai;
  let busy = null; // AbortController
  const log = h('div', { class: 'ai-log', 'aria-live': 'polite' });
  const providerEl = h('div', { class: 'ai-provider' });
  const chips = h('div', { class: 'ai-chips' });
  const input = h('textarea', { id: 'ai-prompt', placeholder: 'Describe a motion: "walk then wave", "jump twice", "make the cube bounce", "slow sneaky walk"…', 'aria-label': 'Describe the animation' });
  const target = h('div', { class: 'ai-target' });
  const goBtn = h('button', { class: 'btn amber' }, icon('sparkle'), 'Animate');
  const stopBtn = h('button', { class: 'btn', hidden: true }, icon('stop'), 'Stop');
  root.append(h('div', { class: 'ai-wrap' }, providerEl, log, chips, h('div', { class: 'ai-input' }, input, h('div', { class: 'row' }, target, stopBtn, goBtn))));

  const msg = (role, content, cls = '') => {
    const el = h('div', { class: `msg ${role} ${cls}` }, content);
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };

  const renderProvider = () => {
    const p = ai.provider();
    clear(providerEl).append(h('span', { class: 'pdot ' + (p === 'offline' ? 'offline' : 'claude') }), h('span', {}, 'Using ', h('b', {}, ai.providerLabel(p))), h('span', { style: { flex: 1 } }),
      h('button', { class: 'btn ghost sm', onclick: () => ui.openSettings('ai') }, 'Change'));
  };

  const renderTarget = () => {
    const sel = app.selection;
    if (sel.model) {
      const what = sel.object && sel.object !== sel.model.root && !sel.object.isSkinnedMesh && !(sel.model.humanoid && !sel.object.isBone) ? `${sel.object.name || 'part'} of ${sel.model.name}` : sel.model.name;
      target.textContent = 'Target: ' + what + (sel.model.humanoid ? ' (humanoid)' : '');
    } else target.textContent = app.models.length ? 'Target: select a model (or say "everything")' : 'Add or drop a model first';
  };

  const renderChips = () => {
    clear(chips);
    const m = app.selection.model;
    let list;
    if (m && m.humanoid && (!app.selection.object || app.selection.object === m.root || app.selection.object.isSkinnedMesh)) list = ['walk', 'run', 'jump then wave', 'dance', 'idle breathing', 'walk and wave', 'sneak', 'cheer', 'sit down'];
    else if (m && m.bones.length && !m.humanoid) list = ['wiggle', 'slow sway', 'fast wag', 'bounce'];
    else if (m) list = ['bounce', 'spin', 'float', 'pulse', 'flip', 'grow then spin', 'shake', 'rainbow colors'];
    else list = ['make everything bounce'];
    for (const t of list) {
      const c = h('button', { class: 'ai-chip' }, t);
      c.addEventListener('click', () => { input.value = t; run(); });
      chips.append(c);
    }
  };

  const applyResults = (results) => {
    const added = [];
    for (const r of results) {
      const e = app.addClipToModel(r.model, r.clip, { solo: true, loop: r.loop !== false });
      added.push({ model: r.model, entry: e });
    }
    if (added.length) {
      app.select(added[0].model.root, added[0].model);
      app.setTime(0);
      app.play();
    }
    return added;
  };

  const actions = (added, prompt, offline) => {
    const row = h('div', { class: 'msg-actions' });
    if (added.length) {
      row.append(h('button', { class: 'btn sm', onclick: () => { app.setTime(0); app.play(); } }, icon('play'), 'Replay'));
      row.append(h('button', { class: 'btn sm ghost', onclick: () => { for (const a of added) a.model.removeClip(a.entry); app.needsEval = true; app.viewport.requestRender(); row.remove(); } }, icon('trash'), 'Remove'));
    }
    if (offline && (ai.sample || app.settings.apiKey)) row.append(h('button', { class: 'btn sm ghost', onclick: () => run(prompt, true) }, icon('sparkle'), 'Ask Claude instead'));
    return row;
  };

  async function run(promptArg, forceClaude = false) {
    const prompt = (promptArg ?? input.value).trim();
    if (!prompt || busy) return;
    if (!promptArg) input.value = '';
    msg('user', prompt);
    const provider = ai.provider();
    const parsed = parsePrompt(prompt);
    const simple = parsed.steps.every((s) => s.human.length || s.object.length || s.chain.length) && prompt.split(/\s+/).length <= 8;
    const useOffline = provider === 'offline' || (!forceClaude && simple && !app.settings.get('aiAlwaysClaude'));
    if (useOffline) {
      const r = ai.runOffline(prompt);
      const added = applyResults(r.results);
      const el = msg('bot', r.message, r.results.length ? '' : 'err');
      el.append(actions(added, prompt, true));
      return;
    }
    busy = new AbortController();
    goBtn.disabled = true;
    stopBtn.hidden = false;
    const thinking = msg('bot', h('div', { class: 'thinking' }, h('div', { class: 'spin' }), 'Claude is choreographing…'));
    try {
      const spec = await ai.askClaude(prompt, { signal: busy.signal, onText: (t) => { thinking.firstChild.lastChild.textContent = `Claude is writing keyframes… (${Math.round(t.length / 100) / 10}k chars)`; } });
      const { results, notes } = ai.buildFromSpec(spec);
      thinking.remove();
      const added = applyResults(results);
      const text = (spec && spec.message ? spec.message + ' ' : '') + (results.length ? results.map((r) => `"${r.clip.name}" on ${r.model.name} (${r.clip.duration.toFixed(1)}s).`).join(' ') : 'No animation came back.') + (notes.length ? ' ' + notes.join(' ') : '');
      const el = msg('bot', text, results.length ? '' : 'err');
      el.append(actions(added, prompt, false));
    } catch (e) {
      thinking.remove();
      if (e && (e.code === 'cancelled' || e.name === 'AbortError' || /abort/i.test(e.message || ''))) msg('bot', 'Stopped.');
      else {
        console.error(e);
        const el = msg('bot', AIAssistant.errorText(e) + ' Falling back to the built-in engine.', 'err');
        const r = ai.runOffline(prompt);
        const added = applyResults(r.results);
        el.append(h('div', { style: { marginTop: '6px' } }, r.message), actions(added, prompt, false));
      }
    } finally {
      busy = null;
      goBtn.disabled = false;
      stopBtn.hidden = true;
    }
  }

  goBtn.addEventListener('click', () => run());
  stopBtn.addEventListener('click', () => busy?.abort());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); run(); }
    e.stopPropagation();
  });

  msg('bot', h('div', {}, 'Tell me what to animate. I understand things like ', h('b', {}, '"walk then wave"'), ', ', h('b', {}, '"jump 3 times fast"'), ', ', h('b', {}, '"make everything bounce"'), '. Works on any humanoid rig, plain objects, and tails or tentacles.'));
  app.on('selection', () => { renderTarget(); renderChips(); });
  app.on('models', () => { renderTarget(); renderChips(); });
  app.on('settings', renderProvider);
  if (ai.sampleReady) ai.sampleReady.then(() => { renderProvider(); });
  renderProvider();
  renderTarget();
  renderChips();
  ui.runAI = run;
  ui.renderAIProvider = renderProvider;
}
