# WebBlend Animator

A 3D model animator that lives in **one HTML file**. Drop in models (including `.blend` files and `.zip` folders with textures), pose characters with bones, keyframe anything on a timeline, blend several animations, and let the AI assistant create motion for you.

Nothing is uploaded anywhere: files you open stay on your computer.

## Open it (no hosting needed)

**Option 1: just the file.** Download [`index.html`](https://github.com/openaideveloperai-png/webblend/raw/claude/dreamy-ride-2nlmh9/index.html) and double-click it. It opens in Chrome, Edge or Firefox and works offline.

**Option 2: hosted on claude.ai.** <https://claude.ai/artifact/5uxAALB4W3kXVCx2gek1kW>. This version can use Claude through your claude.ai account for the AI assistant, with no API key. It starts private; use the page's Share menu to give others access.

## What it does

- **Imports almost anything**, including whole folders and `.zip` archives. Textures are found automatically, even when the model file points at old paths like `C:\Users\…\wood.tga`.
- **Animates with bones.** Click the dots on a character to select bones. Rotate them (E), or drag a hand or foot (W) and the arm or leg follows (IK).
- **Animates anything else too.** Position, rotation and scale of any part, plus visibility, color, opacity, glow, shape keys, light intensity and color, and camera field of view.
- **Timeline / dope sheet.** Scrub, drag keys to retime them, double-click to add a key, box-select, copy/paste, delete, linear/smooth/stepped curves, and drag the clip end to change its length.
- **Multiple animations.** Every model can hold many clips. Play several at once with mix weights, speed and loop modes. All models play together.
- **Retargeting.** Drop a Mixamo (or other humanoid) animation file onto any humanoid character and it is retargeted automatically: Mixamo, Unreal, Unity/VRM, Blender/Rigify and 3ds Max Biped naming all work. You can also copy clips between characters and mirror clips left/right.
- **AI assistant** (the AI tab) creates animations from plain English. See below.
- **Potato mode.** Five quality levels, Potato → Ultra. The app picks one for your device and steps down automatically when it lags. You can change it any time with the quality button.
- **Exports**: a `.glb` of the whole scene (reopen it later to keep editing), animation clips as JSON, PNG screenshots, and WebM video of the animation.
- **Undo/redo** for edits, keys and poses.

## Supported files

| Type | Formats |
|---|---|
| 3D models | `.glb` `.gltf` (incl. Draco and meshopt compression) · `.fbx` · `.obj` + `.mtl` · `.blend` · `.dae` · `.stl` · `.ply` · `.3mf` · `.amf` · `.3ds` · `.wrl`/`.vrml` · `.vox` · `.usdz`/`.usda`/`.usdc` · `.lwo` · `.kmz` · `.vtk` · `.md2` · `.gcode` · `.drc` · `.vrm` |
| Point clouds | `.pcd` · `.xyz` · `.ply` |
| Animation only | `.bvh` · `.fbx`/`.glb` with no mesh (applied to the selected character) · `.json` clips exported from this app |
| 2D → 3D | `.svg` (extruded) · `.png` `.jpg` `.webp` `.gif` `.bmp` `.tga` (image planes) |
| Archives | `.zip` (nested zips too) and whole folders |
| Textures | png, jpg, webp, gif, bmp, tga, dds, ktx2 (ktx2 needs internet) |

FBX, BVH and DAE files in centimeters are converted to meters automatically.

### About `.blend` files

`.blend` files are read directly, with no Blender install needed. Tested with Blender 4.2 and 5.2 files, compressed or not; files from Blender 2.8+ should work.

Supported:
- Meshes with n-gons, UVs, smooth/flat shading and multiple materials
- Principled BSDF colors, plus image textures (packed into the file, or dropped alongside it / in the same zip)
- Object hierarchy, bone parenting, empties, cameras and (optionally) lights
- Armatures with skin weights, shape keys, and actions, including Blender 4.4+ layered actions
- Mirror and Subdivision Surface modifiers (subdivision matches Blender's result)

Not supported (export to glTF from Blender for these): other modifiers, geometry nodes, curves/text objects, linked library data, and procedural shader textures.

## Quick animating guide

1. Select a model (click it, or pick it in the Scene list).
2. Pose it: **W** move, **E** rotate, **R** scale. On characters, click the bone dots.
3. Press **K** to set a keyframe at the current frame. Move the playhead (click the timeline ruler, or use ←/→) and pose again.
4. Press **Space** to play. Turn on the red **Auto-key** button to record every change automatically.
5. Use the **Animations** tab to add more clips, mix them, change speed, or copy a clip from another character.

## AI assistant

Open the **AI** tab (or the AI button at the top) and describe what you want:

- `walk`, `run fast`, `jump then wave`, `walk and wave with the left hand`, `dance like crazy`, `sneak`, `sit down`, `nod twice`, `cheer`
- `make everything bounce`, `spin slowly on the x axis`, `float`, `grow then pulse`, `rainbow colors`
- On creatures and rigs with tails or tentacles: `wiggle`, `slow sway`

Short requests like these are handled instantly by the built-in motion engine, which works offline with no account. Longer or unusual requests go to **Claude**, which writes custom keyframes:

- In the **hosted** version, Claude uses your claude.ai account. You'll be asked to allow it the first time.
- In the **downloaded file**, add an Anthropic API key under Settings → AI. The key stays in your browser and is only sent to `api.anthropic.com`. It's forgotten when you close the tab unless you tick "Remember on this device". The default model is Claude Opus 5.5; Sonnet 5.5 and Haiku 5.5 are faster options.

The built-in motions work on any humanoid rig, so the same "walk" fits a Mixamo character, a VRoid model, or the demo mannequin.

## Performance and low-memory PCs (4 GB)

- **Potato** renders at reduced resolution with a 30 fps cap, no shadows or reflections, and textures shrunk to 512 px. **Low** keeps more detail with no shadows.
- When the app runs slowly while playing or orbiting, it switches to a lighter mode by itself (turn this off in Settings → Performance).
- Nothing renders while nothing changes, so the app costs almost no CPU or GPU when you're not interacting.
- Large textures are downscaled when you import them, and deleted models free their memory.
- Tips: prefer `.glb`, keep textures at 1024 px or less, and close other heavy tabs.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| Space | Play / pause |
| K · Shift+K · Alt+K | Key selection · key whole pose · delete keys at this frame |
| W / E / R · Q | Move / rotate / scale · local/world axes |
| F · Shift+F | Frame selected · frame everything |
| ← / → · ↑ / ↓ | Previous/next frame · next/previous keyframe |
| Ctrl+Z · Ctrl+Shift+Z | Undo · redo |
| Ctrl+C / Ctrl+V | Copy/paste pose (keys, when the timeline has focus) |
| Ctrl+D · Del | Duplicate model · delete keys or model |
| 1 / 3 / 7 / 5 · 0 | Front / right / top / perspective · look through camera |
| P · H · Esc | Select parent · hide model · deselect |

## Saving your work

Use **File → Save scene (.glb)**. Opening that file again restores every model with its clips and mix settings. The `.glb` also opens in Blender, Unity, Unreal, Godot and other tools.

## Building from source

```bash
npm install
npm run build      # writes index.html (standalone) and dist/artifact.html (hosted fragment)
```

The source lives in `src/`: `core/` (app, viewport, settings), `io/` (importers, the `.blend` reader, exporters), `anim/` (clips, humanoid rigs, IK, motions, AI) and `ui/` (panels and timeline). It's built on [three.js](https://threejs.org) r186.

### Tests

The test assets are generated with Blender's Python module (`pip install bpy`):

```bash
tools/make-test-assets.sh /path/to/python-with-bpy ./test-assets
node tools/test-blend.mjs truth.json test-assets/testfiles/*.blend   # .blend vs Blender ground truth (tools/blender/truth.py)
node tools/test-humanoid.mjs                                         # rig detection, pose solving, retargeting
node tools/test-ai.mjs                                               # offline AI prompt parsing
node tools/e2e.cjs test-assets/assets ./out                          # full app in headless Chromium
node tools/e2e-formats.cjs test-assets/zoo ./out                     # every importer
node tools/e2e-ai.cjs                                                # Claude integrations with mocked responses
node tools/e2e-ui.cjs test-assets/assets ./out                       # timeline, properties, recording…
```
