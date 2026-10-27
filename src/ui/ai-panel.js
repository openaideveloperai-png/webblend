// AI tab: chat-style animation requests.
import { h, icon, clear } from './dom.js';
import { AIAssistant, isSimplePrompt } from '../anim/ai.js';

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
  // reference images for Claude: button, paste, or drop onto the prompt
  let images = [];
  const thumbs = h('div', { class: 'ai-thumbs', hidden: true });
  const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true, id: 'ai-image-input' });
  const imgBtn = h('button', { class: 'btn ghost sm ai-img-btn', title: 'Attach reference images (or paste / drop them here)', 'aria-label': 'Attach images' }, icon('image'));
  imgBtn.addEventListener('click', () => fileIn.click());
  const renderThumbs = () => {
    clear(thumbs);
    thumbs.hidden = !images.length;
    images.forEach((f, i) => {
      const url = URL.createObjectURL(f);
      const im = h('img', { src: url, alt: f.name || 'image', title: f.name || 'image' });
      im.addEventListener('load', () => URL.revokeObjectURL(url));
      const x = h('button', { class: 'ai-thumb-x', 'aria-label': 'Remove image', onclick: () => { images.splice(i, 1); renderThumbs(); } }, '×');
      thumbs.append(h('div', { class: 'ai-thumb' }, im, x));
    });
  };
  const addImages = (list) => {
    const ok = [...list].filter((f) => /^image\/(png|jpe?g|webp|gif)$/.test(f.type) && f.size < 20e6);
    images = images.concat(ok).slice(0, 5);
    renderThumbs();
    if (ok.length && ai.provider() === 'offline') msg('bot', 'Images need Claude: add an API key in Settings → AI, or use the hosted page. The built-in engine can\'t look at pictures.', 'err');
  };
  fileIn.addEventListener('change', () => { addImages(fileIn.files); fileIn.value = ''; });
  input.addEventListener('paste', (e) => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addImages(fs); } });
  const inputWrap = h('div', { class: 'ai-input' }, thumbs, input, h('div', { class: 'row' }, imgBtn, target, stopBtn, goBtn), fileIn);
  inputWrap.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.items || [])].some((it) => it.type.startsWith('image/'))) { e.preventDefault(); e.stopPropagation(); inputWrap.classList.add('drop'); } });
  inputWrap.addEventListener('dragleave', () => inputWrap.classList.remove('drop'));
  inputWrap.addEventListener('drop', (e) => { const fs = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/')); inputWrap.classList.remove('drop'); if (fs.length) { e.preventDefault(); e.stopPropagation(); addImages(fs); } });
  root.append(h('div', { class: 'ai-wrap' }, providerEl, log, chips, inputWrap));
  // prompt history (up / down)
  const past = [];
  let pastIdx = -1;

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
    if (m && m.humanoid && (!app.selection.object || app.selection.object === m.root || app.selection.object.isSkinnedMesh)) list = ['walk', 'run', 'jump then wave', 'dance', 'make a gun and shoot', 'give her a rifle', 'katana slash', 'hands on lap', 'hands on hips', 'cross arms', 'cheer', 'sit down'];
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

  const actions = (added, prompt, offline, props = []) => {
    const row = h('div', { class: 'msg-actions' });
    if (added.length || props.length) {
      if (added.length) row.append(h('button', { class: 'btn sm', onclick: () => {
        for (const a of added) if (a.model.clips.includes(a.entry)) a.model.switchClip(a.entry);
        app.setTime(0); app.play();
      } }, icon('play'), 'Replay'));
      row.append(h('button', { class: 'btn sm ghost', onclick: () => {
        for (const a of added) if (a.model.clips.includes(a.entry)) a.model.removeClip(a.entry);
        for (const p of props) {
          if (p.standalone) { if (app.models.includes(p.model)) app.removeModel ? app.removeModel(p.model) : null; }
          else if (p.prop.parent) app.removeProp(p.model, p.prop);
        }
        app.needsEval = true; app.viewport.requestRender(); row.remove();
      } }, icon('trash'), 'Remove'));
    }
    if (offline && (ai.sample || app.settings.apiKey)) row.append(h('button', { class: 'btn sm ghost', onclick: () => run(prompt, true) }, icon('sparkle'), 'Ask Claude instead'));
    return row;
  };

  async function run(promptArg, forceClaude = false) {
    const prompt = (promptArg ?? input.value).trim();
    if (!prompt || busy) return;
    if (!promptArg) input.value = '';
    if (past[past.length - 1] !== prompt) past.push(prompt);
    pastIdx = -1;
    const imgs = promptArg ? [] : images.slice();
    if (!promptArg) { images = []; renderThumbs(); }
    const userMsg = msg('user', prompt);
    if (imgs.length) {
      const strip = h('div', { class: 'ai-thumbs in-log' });
      for (const f of imgs) { const url = URL.createObjectURL(f); strip.append(h('div', { class: 'ai-thumb' }, h('img', { src: url, alt: f.name || 'image' }))); }
      userMsg.append(strip);
    }
    const provider = ai.provider();
    const simple = isSimplePrompt(prompt);
    let useOffline = provider === 'offline' || (!forceClaude && !imgs.length && simple && !app.settings.get('aiAlwaysClaude'));
    if (imgs.length && !useOffline && !(await ai.canSendImages())) {
      msg('bot', 'This view can\'t send images to Claude, so I\'ll go by your words only.', 'err');
      imgs.length = 0;
    }
    if (useOffline) {
      const r = ai.runOffline(prompt);
      const added = applyResults(r.results);
      const el = msg('bot', r.message, r.results.length || (r.props && r.props.length) ? '' : 'err');
      el.append(actions(added, prompt, true, r.props || []));
      if (r.understood) ai.remember(prompt, r.message);
      return;
    }
    busy = new AbortController();
    goBtn.disabled = true;
    stopBtn.hidden = false;
    const thinking = msg('bot', h('div', { class: 'thinking' }, h('div', { class: 'spin' }), imgs.length ? 'Claude is looking at your images…' : 'Claude is choreographing…'));
    const status = (t) => { thinking.firstChild.lastChild.textContent = t; };
    try {
      const spec = await ai.askClaude(prompt, { signal: busy.signal, images: imgs, onStatus: status, onText: (t) => status(`Claude is writing${/"parts"\s*:\s*\[\s*\{/.test(t) ? ' the model' : ' keyframes'}… (${Math.round(t.length / 100) / 10}k chars)`) });
      const { results, notes, props } = ai.buildFromSpec(spec);
      const added = applyResults(results);
      // Claude watches its effects play and fixes them
      let fxNote = '';
      try { fxNote = await ai.reviewEffects(prompt, results, { signal: busy.signal, onStatus: status }); } catch (e) { if (busy.signal.aborted || e?.code === 'cancelled') throw e; console.warn('effects review failed', e); }
      if (fxNote) spec.reviewedFx = fxNote;
      thinking.remove();
      const made = (props || []).map((p) => (p.standalone ? `Made "${p.prop.name}".` : `Made "${p.prop.name}" and put it in ${p.model.name}'s ${p.prop.userData.hold.side} hand.`)).join(' ');
      const text = (spec && spec.message ? spec.message + ' ' : '') + (spec && spec.reviewed ? `(Looked it over: ${spec.reviewed.replace(/\.?$/, '.')}) ` : '') + (spec && spec.reviewedFx ? `(Checked the effects: ${spec.reviewedFx.replace(/\.?$/, '.')}) ` : '') + (made ? made + ' ' : '') + (results.length ? results.map((r) => `"${r.clip.name}" on ${r.model.name} (${r.clip.duration.toFixed(1)}s).`).join(' ') : props && props.length ? '' : 'No animation came back.') + (notes.length ? ' ' + notes.join(' ') : '');
      const ok = results.length || (props && props.length);
      const el = msg('bot', text, ok ? '' : 'err');
      el.append(actions(added, prompt, false, props || []));
      if (ok) ai.remember(prompt, text);
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
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && past.length && !input.value.includes('\n')) {
      const atEdge = e.key === 'ArrowUp' ? input.selectionStart === 0 || pastIdx >= 0 || !input.value : pastIdx >= 0;
      if (atEdge) {
        e.preventDefault();
        if (e.key === 'ArrowUp') pastIdx = pastIdx < 0 ? past.length - 1 : Math.max(0, pastIdx - 1);
        else pastIdx = pastIdx >= past.length - 1 ? -1 : pastIdx + 1;
        input.value = pastIdx < 0 ? '' : past[pastIdx];
      }
    }
    e.stopPropagation();
  });

  msg('bot', h('div', {}, 'Tell me what to animate. I understand things like ', h('b', {}, '"walk then wave"'), ', ', h('b', {}, '"jump 3 times fast"'), ', ', h('b', {}, '"make a gun and shoot 3 times"'), ', ', h('b', {}, '"give her a katana and slash"'), '. Works on any humanoid rig, plain objects, and tails or tentacles. With Claude you can also ask for custom models and attach reference images (paste or drop them here).'));
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
