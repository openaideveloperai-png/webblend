// Export for other apps: pick where the model is going and get the right file
// (FBX or GLB) with that app's units, texture size and naming, plus how to import it.
import { h, icon } from './dom.js';
import { modal } from './toast.js';
import { exportFBX, exportGLB } from '../io/export.js';

// per platform: format and defaults, and the import steps shown in the dialog
export const PLATFORMS = {
  roblox: {
    label: 'Roblox Studio', format: 'fbx', unit: 'm', maxTexture: 1024, bakeColors: true, ascii: true, splitClips: true,
    steps: [
      'Studio: Home (or Avatar) tab → Import 3D, and pick the model .fbx. A rigged character comes in as a rig with its bones.',
      'Each animation is its own .fbx (Roblox imports one per file): select the imported rig, open the Animation Editor, then Import → From FBX Animation, and pick a clip file.',
      'Roblox limits each mesh to 20,000 triangles and 4 bone weights per vertex; the export tells you if a mesh is over.',
    ],
  },
  unity: {
    label: 'Unity', format: 'fbx', unit: 'm', maxTexture: 2048,
    steps: [
      'Drag the .fbx into the Assets window (textures are embedded; use Materials → Extract Textures if you want them as files).',
      'Characters: in the Rig tab set Animation Type to Humanoid (or Generic), Apply.',
      'Every clip is listed in the Animation tab of the import settings.',
    ],
  },
  unreal: {
    label: 'Unreal Engine', format: 'fbx', unit: 'cm', maxTexture: 2048,
    steps: [
      'Content Browser → Import, pick the .fbx.',
      'Rigged models import as a Skeletal Mesh; leave Import Animations on to get every clip as an Animation Sequence.',
      'The file is in centimeters, Unreal\'s own unit, so sizes come in 1:1.',
    ],
  },
  blender: {
    label: 'Blender', format: 'glb', unit: 'm',
    steps: ['File → Import → glTF 2.0 (.glb). Clips become Actions; switch them in the Action Editor or NLA.', 'Prefer FBX? Choose it below and use File → Import → FBX.'],
  },
  godot: {
    label: 'Godot', format: 'glb', unit: 'm',
    steps: ['Drop the .glb into the FileSystem dock; open it as a scene. Clips are in its AnimationPlayer.'],
  },
  web: {
    label: 'Web / Sketchfab / three.js', format: 'glb', unit: 'm',
    steps: ['Upload the .glb (Sketchfab, model-viewer, three.js and Babylon.js all read it with animations and PBR materials).'],
  },
  other: {
    label: 'Other (Maya, 3ds Max, Cinema 4D…)', format: 'fbx', unit: 'cm', maxTexture: 4096,
    steps: ['Import the .fbx (FBX 7.4 binary, Y up, textures embedded).'],
  },
};

export function openExportDialog(app, { platform } = {}) {
  platform = platform || (PLATFORMS[app.settings.get('exportPlatform')] ? app.settings.get('exportPlatform') : 'roblox');
  const sel = app.selection.model;
  const state = { platform, scope: sel ? 'selected' : 'all', clips: 'all', animationOnly: false };
  let opts = {};
  const body = h('div', { class: 'export-dlg' });
  const resetOpts = () => { const P = PLATFORMS[state.platform]; opts = { format: P.format, unit: P.unit, maxTexture: P.maxTexture || 2048, bakeColors: !!P.bakeColors, ascii: !!P.ascii, splitClips: !!P.splitClips }; };
  resetOpts();
  const models = () => (state.scope === 'selected' && sel ? [sel] : app.models.filter((m) => !m.root.userData.editorOnly));
  const clipCount = () => models().reduce((a, m) => a + (state.clips === 'none' ? 0 : state.clips === 'active' ? (m.activeClip || m.clips[0] ? 1 : 0) : m.clips.length), 0);
  const radio = (name, value, label, cur, on) => h('label', { class: 'toggle' }, h('input', { type: 'radio', name, value, checked: cur === value || undefined, onchange: () => on(value) }), label);
  const check = (key, label, title) => h('label', { class: 'toggle', title: title || '' }, h('input', { type: 'checkbox', checked: opts[key] || undefined, onchange: (e) => { opts[key] = e.target.checked; render(); } }), label);
  const status = h('div', { class: 'hint export-status', role: 'status', 'aria-live': 'polite' });

  function render() {
    const P = PLATFORMS[state.platform];
    const fbx = opts.format === 'fbx';
    body.replaceChildren(
      h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, h('span', { class: 'sec-t' }, 'Where is it going?')),
        h('div', { class: 'export-platforms' }, ...Object.entries(PLATFORMS).map(([k, p]) => h('button', {
          class: 'btn' + (k === state.platform ? ' primary' : ' ghost'), 'data-platform': k, 'aria-pressed': String(k === state.platform),
          onclick: () => { state.platform = k; app.settings.set('exportPlatform', k); resetOpts(); render(); },
        }, p.label)))),
      h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, h('span', { class: 'sec-t' }, 'What')),
        h('div', { class: 'ex-row' }, sel ? radio('ex-scope', 'selected', `Selected model (${sel.name})`, state.scope, (v) => { state.scope = v; render(); }) : null,
          radio('ex-scope', 'all', `Everything (${app.models.length} model${app.models.length === 1 ? '' : 's'})`, state.scope, (v) => { state.scope = v; render(); })),
        h('div', { class: 'ex-row' },
          radio('ex-clips', 'all', 'All animations', state.clips, (v) => { state.clips = v; render(); }),
          radio('ex-clips', 'active', 'Active clip only', state.clips, (v) => { state.clips = v; render(); }),
          radio('ex-clips', 'none', 'No animation', state.clips, (v) => { state.clips = v; render(); })),
        fbx ? h('div', { class: 'ex-row' }, h('label', { class: 'toggle', title: 'Just the motion, for a rig you already imported' }, h('input', { type: 'checkbox', checked: state.animationOnly || undefined, onchange: (e) => { state.animationOnly = e.target.checked; render(); } }), 'Animation only (no meshes)')) : null),
      h('div', { class: 'sec' }, h('div', { class: 'sec-h' }, h('span', { class: 'sec-t' }, 'Options')),
        h('div', { class: 'field' }, h('label', { for: 'ex-format' }, 'Format'),
          h('select', { id: 'ex-format', onchange: (e) => { opts.format = e.target.value; render(); } },
            h('option', { value: 'fbx', selected: fbx || undefined }, 'FBX (.fbx)'), h('option', { value: 'glb', selected: !fbx || undefined }, 'glTF binary (.glb)'))),
        fbx ? h('div', { class: 'field' }, h('label', { for: 'ex-unit' }, 'Units'),
          h('select', { id: 'ex-unit', onchange: (e) => { opts.unit = e.target.value; } },
            h('option', { value: 'm', selected: opts.unit === 'm' || undefined }, 'Meters (FBX unit scale)'), h('option', { value: 'cm', selected: opts.unit === 'cm' || undefined }, 'Centimeters'))) : null,
        fbx ? h('div', { class: 'field' }, h('label', { for: 'ex-tex' }, 'Largest texture'),
          h('select', { id: 'ex-tex', onchange: (e) => { opts.maxTexture = +e.target.value; } }, ...[512, 1024, 2048, 4096].map((v) => h('option', { value: v, selected: opts.maxTexture === v || undefined }, `${v} px`)))) : null,
        fbx ? h('div', { class: 'ex-row' }, check('bakeColors', 'Bake material colors into textures', 'Apps that only read texture maps still get the colors'), check('ascii', 'Plain English bone and part names', 'Translates Japanese names and drops other characters'), check('splitClips', 'One file per animation')) : null),
      h('div', { class: 'sec export-steps' }, h('div', { class: 'sec-h' }, h('span', { class: 'sec-t' }, `Importing into ${P.label}`)), h('ol', {}, ...P.steps.map((t) => h('li', {}, t)))),
      h('div', { class: 'sec ex-foot' }, status,
      h('div', { class: 'btns', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'btn ghost', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn primary', id: 'ex-go', disabled: !models().length || undefined, onclick: go }, icon('download'), ` Export ${fbx ? 'FBX' : 'GLB'}`))),
    );
    status.textContent = `${models().length} model${models().length === 1 ? '' : 's'}, ${clipCount()} animation${clipCount() === 1 ? '' : 's'}.`;
  }

  async function go() {
    const btn = body.querySelector('#ex-go');
    btn.disabled = true;
    status.textContent = 'Exporting…';
    const list = models();
    if (opts.format === 'glb') {
      await exportGLB(app, list, list.length === 1 ? undefined : 'webblend-scene');
      m.close();
      return;
    }
    const r = await exportFBX(app, list, { ...opts, clips: state.clips, animationOnly: state.animationOnly, filename: list.length === 1 ? list[0].name : 'webblend-scene' });
    btn.disabled = false;
    if (!r) { status.textContent = 'Export failed.'; return; }
    const { report } = r;
    const notes = [`Wrote ${r.files.length} file${r.files.length === 1 ? '' : 's'}: ${report.meshes} mesh${report.meshes === 1 ? '' : 'es'}, ${report.bones} bones, ${report.textures} textures, ${report.clips} animation${report.clips === 1 ? '' : 's'}.`];
    if (state.platform === 'roblox' && report.bigMeshes.length) notes.push(`Over Roblox's 20,000-triangle limit: ${report.bigMeshes.map((b) => `${b.name} (${b.triangles.toLocaleString()})`).join(', ')}. Reduce or split them before importing.`);
    if (report.skippedTextures) notes.push(`${report.skippedTextures} texture(s) couldn't be read back and were left out.`);
    if (report.morphs) notes.push('Shape keys (face morphs) are not in the FBX; use GLB to keep them.');
    status.textContent = notes.join(' ');
    status.dataset.done = '1';
  }

  const m = modal('Export for other apps', body, { width: 640 });
  render();
  return m;
}
