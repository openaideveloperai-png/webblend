// Exports: GLB (models + animations), animation JSON, screenshots, video.
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { zipSync } from 'three/examples/jsm/libs/fflate.module.js';
import { clipWithNames, clipWithUuids } from '../anim/clips.js';
import { inArtifact } from '../core/util.js';

let downloadsCap;
async function downloads() {
  if (downloadsCap !== undefined) return downloadsCap;
  downloadsCap = null;
  if (inArtifact()) {
    try { downloadsCap = await window.claude.use('downloads'); } catch { downloadsCap = null; }
  }
  return downloadsCap;
}

// Formats the artifact viewer accepts for saves; others get zipped.
const ARTIFACT_OK = /\.(gif|png|jpe?g|webp|mp4|webm|txt|json|md|zip|html|svg|csv|pdf)$/i;

export async function saveFile(blob, filename, app) {
  const dl = await downloads();
  if (dl) {
    let data = blob, name = filename;
    if (!ARTIFACT_OK.test(filename)) {
      const u8 = new Uint8Array(await blob.arrayBuffer());
      data = new Blob([zipSync({ [filename]: u8 })], { type: 'application/zip' });
      name = filename.replace(/\.[^.]+$/, '') + '.zip';
    }
    try {
      await dl.save({ filename: name, data });
      app?.toast(`Saved ${name}`, 'ok');
      return true;
    } catch (e) {
      if (e && e.code === 'declined') return false;
      app?.toast(`Couldn't save: ${e?.message || e?.code || e}`, 'error');
      return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  app?.toast(`Downloaded ${filename}`, 'ok');
  return true;
}

function safeName(s) { return String(s || 'scene').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'scene'; }

// Export models (array) with their clips as one GLB.
export async function exportGLB(app, models, filename) {
  if (!models.length) { app.toast('Nothing to export', 'warn'); return; }
  const group = new THREE.Group();
  group.name = models.length === 1 ? models[0].name : 'Scene';
  // lets WebBlend split the file back into separate models when reopened
  // unique names so clips map back to the right model
  const used = new Map();
  const uname = new Map(models.map((m) => {
    const base = (m.name || 'Model').replace(/\s*\|\s*/g, ' ');
    const n = used.get(base) || 0;
    used.set(base, n + 1);
    return [m, n ? `${base} ${n + 1}` : base];
  }));
  group.userData = { webblend: { version: 1, models: models.map((m) => ({ name: uname.get(m), kind: m.kind, clips: m.clips.map((e) => ({ name: e.clip.name, playing: e.playing, weight: e.weight, speed: e.speed, loop: e.loop })) })) } };
  const parents = models.map((m) => [m, m.root.parent]);
  const hidden = [];
  const clips = [];
  try {
    for (const m of models) {
      // editor-only markers stay out of the file
      m.root.traverse((o) => { if (o.userData.editorOnly && o.visible) { o.visible = false; hidden.push(o); } });
      group.add(m.root);
      for (const e of m.clips) {
        const c = morphTracksByName(clipWithUuids(e.clip, m.root), m.root);
        c.name = `${uname.get(m)} | ${e.clip.name}`;
        if (c.tracks.length) clips.push(c);
      }
    }
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(group, { binary: true, animations: clips, onlyVisible: true, includeCustomExtensions: false, maxTextureSize: app.settings.maxTexture() });
    const blob = new Blob([result], { type: 'model/gltf-binary' });
    await saveFile(blob, (filename || safeName(group.name)) + '.glb', app);
  } catch (e) {
    console.error(e);
    app.toast('GLB export failed: ' + (e.message || e), 'error', 6000);
  } finally {
    for (const o of hidden) o.visible = true;
    for (const [m, parent] of parents) (parent || app.world).add(m.root);
    app.world.updateMatrixWorld(true);
  }
}

// GLTFExporter looks morph targets up by name: turn [0] into [Smile]
function morphTracksByName(clip, root) {
  const byUuid = new Map();
  root.traverse((o) => byUuid.set(o.uuid, o));
  clip.tracks = clip.tracks.filter((t) => {
    const m = /^([^.]+)\.morphTargetInfluences\[(\d+)\]$/.exec(t.name);
    if (!m) return true;
    const node = byUuid.get(m[1]);
    const dict = node && node.morphTargetDictionary;
    if (!dict) return false;
    const name = Object.keys(dict).find((k) => dict[k] === parseInt(m[2], 10));
    if (!name || /[[\].:/]/.test(name)) return false;
    t.name = `${m[1]}.morphTargetInfluences[${name}]`;
    return true;
  });
  return clip;
}

export async function exportClipJSON(app, model, entry) {
  const clip = clipWithNames(entry.clip, model.root);
  const json = { format: 'webblend-animation', version: 1, model: model.name, clip: THREE.AnimationClip.toJSON(clip) };
  const blob = new Blob([JSON.stringify(json)], { type: 'application/json' });
  await saveFile(blob, `${safeName(model.name)}-${safeName(entry.clip.name)}.json`, app);
}

export async function screenshot(app) {
  const vp = app.viewport;
  vp.render();
  const blob = await new Promise((res) => vp.renderer.domElement.toBlob(res, 'image/png'));
  if (!blob) { app.toast('Screenshot failed', 'error'); return; }
  await saveFile(blob, `webblend-${Date.now()}.png`, app);
}

// Record the active clip (or everything playing) from start to end as WebM.
export async function recordVideo(app, { seconds, fps = 30, onProgress } = {}) {
  const canvas = app.viewport.renderer.domElement;
  if (!canvas.captureStream || typeof MediaRecorder === 'undefined') { app.toast('Video recording isn\'t supported in this browser', 'warn'); return; }
  // VP8 encodes fastest (matters on low-end PCs); VP9 can stall in software
  const types = ['video/webm;codecs=vp8', 'video/webm', 'video/webm;codecs=vp9', 'video/mp4'];
  const mime = types.find((t) => MediaRecorder.isTypeSupported(t));
  if (!mime) { app.toast('No supported video format in this browser', 'warn'); return; }
  const duration = seconds || app.duration();
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 5_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });
  const wasLoop = app.transport.loop;
  app.transport.loop = false;
  app.pause();
  app.setTime(0);
  app.viewport.continuous++;
  // let frames flow into the stream and the encoder start before playback,
  // otherwise the first recording in a session can come back empty
  await new Promise((r) => setTimeout(r, 350));
  const started = new Promise((res) => { rec.onstart = res; setTimeout(res, 1500); });
  rec.start(250);
  await started;
  await new Promise((r) => setTimeout(r, 150));
  app.setTime(0);
  app.play();
  const start = performance.now();
  await new Promise((res) => {
    const check = () => {
      const t = (performance.now() - start) / 1000;
      onProgress?.(Math.min(1, t / duration));
      if (t >= duration + 0.1 || !app.transport.playing) res(); else requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  rec.stop();
  await done;
  app.viewport.continuous--;
  app.transport.loop = wasLoop;
  app.pause();
  stream.getTracks().forEach((t) => t.stop());
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  if (!blob.size) { app.toast('The browser didn\'t produce any video frames. Try again, or use a lower quality mode.', 'error', 6000); return; }
  await saveFile(blob, `webblend-${Date.now()}.${mime.includes('mp4') ? 'mp4' : 'webm'}`, app);
}
