# WebBlend Animator

A 3D model animator that lives in **one HTML file**. Drop in models (including `.blend` files and `.zip` folders with textures), pose characters with bones, keyframe anything on a timeline, blend several animations, and let the AI assistant create motion for you.

Nothing is uploaded anywhere: files you open stay on your computer.

## Open it (no hosting needed)

**Option 1: just the file.** Download [`index.html`](https://github.com/openaideveloperai-png/webblend/raw/claude/dreamy-ride-2nlmh9/index.html) and double-click it. It opens in Chrome, Edge or Firefox and works offline.

**Option 2: hosted on claude.ai.** <https://claude.ai/artifact/5uxAALB4W3kXVCx2gek1kW>. This version can use Claude through your claude.ai account for the AI assistant, with no API key. It starts private; use the page's Share menu to give others access.

## What it does

- **Imports almost anything**, including whole folders and `.zip` archives. Textures are found automatically, even when the model file points at old paths like `C:\Users\…\wood.tga`.
- **Opens game files and mods.** Drop a `.jar` (a Minecraft mod or resource pack), `.mcpack`, `.apk`, `.unitypackage` or similar and WebBlend unpacks it like a zip, searches every folder (hidden ones and archives inside the archive too) and lists the models it finds so you can pick which to open. Minecraft block and item models, Bedrock / GeckoLib entities with their animations and Blockbench files open directly.
- **Effects (VFX)**: slash trails that follow the blade, sparks, petals, fire, smoke, energy waves, auras and more, made by the AI and timed to the animation. They're keyframes in the clip, so they scrub, loop and export as video.
- **Animates with bones.** Click the dots on a character to select bones. Rotate them (E), or drag a hand or foot (W) and the arm or leg follows (IK).
- **Animates anything else too.** Position, rotation and scale of any part, plus visibility, color, opacity, glow, shape keys, light intensity and color, and camera field of view.
- **Timeline / dope sheet.** Scrub, drag keys to retime them, double-click to add a key, box-select, copy/paste, delete, linear/smooth/stepped curves, and drag the clip end to change its length.
- **Multiple animations.** Every model can hold many clips. Play several at once with mix weights, speed and loop modes. All models play together.
- **Retargeting.** Drop a Mixamo (or other humanoid) animation file onto any humanoid character and it is retargeted automatically: Mixamo, Unreal, Unity/VRM, Blender/Rigify and 3ds Max Biped naming all work. You can also copy clips between characters and mirror clips left/right.
- **AI assistant** (the AI tab) creates animations from plain English. See below.
- **Potato mode.** Five quality levels, Potato → Ultra. The app picks one for your device and steps down automatically when it lags. You can change it any time with the quality button.
- **Exports**: a `.glb` of the whole scene (reopen it later to keep editing), **FBX or GLB for other apps** with presets for Roblox Studio, Unity, Unreal, Blender and Godot (see below), animation clips as JSON, PNG screenshots, and WebM video of the animation.
- **Undo/redo** for edits, keys and poses.
- **Handy extras**: View → Turntable slowly orbits the camera to show a model off, View → Hide effects, and the export dialog opens on the platform you used last.

## Supported files

| Type | Formats |
|---|---|
| 3D models | `.glb` `.gltf` (incl. Draco and meshopt compression) · `.fbx` · `.obj` + `.mtl` · `.blend` · `.pmx`/`.pmd` (MikuMikuDance) · `.dae` · `.stl` · `.ply` · `.3mf` · `.amf` · `.3ds` · `.wrl`/`.vrml` · `.vox` · `.usdz`/`.usda`/`.usdc` · `.lwo` · `.kmz` · `.vtk` · `.md2` · `.gcode` · `.drc` · `.vrm` |
| Point clouds | `.pcd` · `.xyz` · `.ply` |
| Animation only | `.bvh` · `.vmd` (MMD dances) · `.fbx`/`.glb` with no mesh (applied to the selected character) · `.json` clips exported from this app |
| 2D → 3D | `.svg` (extruded) · `.png` `.jpg` `.webp` `.gif` `.bmp` `.tga` (image planes) |
| Game files | Minecraft Java block / item models (`.json`, with vanilla parents like `cube_all` and flat item sprites) · Bedrock and GeckoLib entities (`.geo.json` + `.animation.json`, Molang expressions included) · Blockbench `.bbmodel` |
| Archives | `.zip` and anything zip-based: `.jar` · `.mcpack` `.mcaddon` `.mcworld` · `.apk` `.aar` · `.pk3` · `.war` and others; `.tar` `.tgz` · `.unitypackage`; nested archives and hidden folders are searched too. Whole folders work as well. |
| Textures | png, jpg, webp, gif, bmp, tga, dds (BC1–BC5, BC7), ktx2 (ktx2 needs internet) |

FBX, BVH and DAE files in centimeters are converted to meters automatically.

When a drop holds more than four models (a mod `.jar` often has dozens), a list opens with each model's name, kind and folder; search it, tick the ones you want and they're placed side by side. Data files such as recipes, blockstates and mod info are left out. Pixel-art textures stay crisp.

A character file saved without its skeleton (some exporters write only the posed meshes) can be moved but not posed; WebBlend says so when you open it. Open the original `.blend` / `.pmx` / `.vrm` instead, or save from WebBlend, which keeps the bones. Physics helper meshes in such files (`RB…`, `CL…`, rigid bodies) are hidden.

### About `.blend` files

`.blend` files are read directly, with no Blender install needed. Tested with Blender 4.2 and 5.2 files, compressed or not; files from Blender 2.8+ should work.

Supported:
- Meshes with n-gons, UVs, smooth/flat shading and multiple materials
- Principled BSDF colors and image textures, also inside node groups (MMD and other toon shaders), emission/lightmap textures (premultiplied by their alpha like Blender does), alpha-masked decals, and normal maps behind Bump nodes. Textures can be packed into the file, or sit next to it / in the same zip (png, jpg, bmp, tga, dds including BC7, webp). Missing texture files are listed by name when you open the file
- Object hierarchy, bone parenting, empties, cameras and (optionally) lights
- Objects hidden in Blender (hidden objects or collections, rigid bodies, cages) stay hidden, and so do objects Blender only draws as a wireframe or box, like smoke/fluid simulation domains; the Scene list tucks them away
- Armatures with skin weights, shape keys, and actions, including Blender 4.4+ layered actions
- Bone constraints, live: Copy Rotation/Location/Scale/Transforms, IK (chain length, pole, knee limits), Damped Track, Track To, Stretch To, Child Of, Limit Rotation/Location/Scale (local, pose or world space). MMD rigs (control bones driving "D" bones, leg IK) pose and play like in Blender. IK chains that nobody has posed rest exactly as Blender shows them; rotate a chain bone yourself (or play a motion that does) and that chain switches to plain FK so your pose wins
- Mirror and Subdivision Surface modifiers (subdivision matches Blender's result)

Not supported (export to glTF from Blender for these): other modifiers, geometry nodes, curves/text objects, linked library data, procedural shader textures, simulations (cloth, fluid, rigid body physics), and some constraint types (Armature, Transformation, Action, Spline IK…; when a rig uses these, you pose the bones that move the mesh directly). Shrinkwrap, Floor and similar small helper constraints are skipped quietly.

### MikuMikuDance (MMD)

- `.pmx` and `.pmd` models open directly: drop the model together with its texture files (or the whole folder / a zip). Leg IK, toe IK and "D" bones work like in MMD, facial morphs become shape keys, and Japanese file and bone names are fine. Physics (hair/skirt rigid bodies) isn't simulated.
- `.vmd` motions: select a character and drop the `.vmd`. On MMD characters (`.pmx`, `.pmd`, or MMD models converted to `.blend`/`.glb`/`.fbx`) bones and facial expressions are matched by name; on other humanoids (Mixamo, VRM, the demo mannequin…) the dance is retargeted.
- MMD characters exported to `.glb`/`.fbx` lose their IK setup; WebBlend rebuilds the leg IK and D bones from the standard bone names.

### Rigs from MMD, games and Rigify

Only the bones that move the mesh (plus the control bones and IK handles that drive them) get clickable dots, so exported rigs with hundreds of helper bones stay usable. Turn on Settings → Viewport → "Also show helper bones" to see every bone. Japanese MMD bone names (センター, 上半身, 左腕, 右ひざ, 左足ＩＫ…) are recognized, so the AI motions and retargeting work on MMD characters.

## Quick animating guide

1. Select a model (click it, or pick it in the Scene list).
2. Pose it: **W** move, **E** rotate, **R** scale. On characters, click the bone dots.
3. Press **K** to set a keyframe at the current frame. Move the playhead (click the timeline ruler, or use ←/→) and pose again.
4. Press **Space** to play. Turn on the red **Auto-key** button to record every change automatically.
   To get in close, use **fly mode** (the keys button in the viewport corner, or the ` key) and move with W A S D like in a game. Bone dots stay small on screen however close you get; change their size in Settings → Viewport.
5. Use the **Animations** tab to add more clips, mix them, change speed, or copy a clip from another character. Picking a clip (there or in the timeline's clip menu) plays just that one; to layer clips on top of each other, switch extra ones on with their play buttons.

## AI assistant

Open the **AI** tab (or the AI button at the top) and describe what you want:

- `walk`, `run fast`, `jump then wave`, `walk and wave with the left hand`, `dance like crazy`, `sneak`, `sit down`, `nod twice`, `cheer`
- Hands on the body: `put her hand on her lap while standing`, `hands on hips`, `left hand on her chest and right hand on her head`, `hands behind her back`, `hand on chin`, `hands on knees`, `cross her arms`, `hands behind her head`, `cover her eyes`, `cover ears`, `facepalm`, `hand on her neck`, `touch her ear`. The app scans the character's own mesh (its proportions, where the face, chest, thighs and knees really are, hair ignored), so the palm lands on that spot (lap, belly, chest, heart, hip, thigh, knee, lower back, head, back of the head, forehead, eyes, ear, face, cheek, chin, neck, other shoulder, arms crossed) and the hand turns to lie flat. Standing poses keep the feet planted and the legs still. If the arms are too short for a spot on the thigh, the hand rests as low as it reaches instead of bending over; only knees make the character bend down (mostly at the hips).
- Props: `make a gun and shoot 3 times`, `give her a rifle and shoot full auto`, `give him a pump shotgun`, `make a gold pistol and aim`, `give her a katana and slash twice`, `drop the gun`. The character holds it at real size in the right (or left) hand with the fingers closed around the grip; aiming uses both hands (pistols out in front, rifles and shotguns shouldered in a bladed stance); every shot adds recoil through the arms, the slide / bolt / pump cycling, a muzzle flash, a tracer and an ejected casing that bounces on the floor. It is all keyframes in one clip, so it scrubs, loops and exports.
- `make everything bounce`, `spin slowly on the x axis`, `float`, `grow then pulse`, `rainbow colors`
- On creatures and rigs with tails or tentacles: `wiggle`, `slow sway`

Short requests like these are handled instantly by the built-in motion engine, which works offline with no account. Longer or unusual requests go to **Claude**, which writes custom keyframes:

- In the **hosted** version, Claude uses your claude.ai account. You'll be asked to allow it the first time.
- In the **downloaded file**, add an Anthropic API key under Settings → AI. The key stays in your browser and is only sent to `api.anthropic.com`. It's forgotten when you close the tab unless you tick "Remember on this device". The default model is Claude Opus 5.5; Sonnet 5.5 and Haiku 5.5 are faster options.

The built-in motions work on any humanoid rig, so the same "walk" fits a Mixamo character, a VRoid model, or the demo mannequin.

### Effects (VFX)

Ask for effects in the same sentence as the motion:

- `make the character swing a dark flower pattern katana and when it swings the blade leaves a trail where it cut that then disappears`
- `katana slash with a trail and sparks`, `swing a flaming sword with sparks`, `katana with gold flowers and petals`
- `punch twice with a trail on the fist`, `jump and make dust when he lands`, `cast a spell with a magic circle`, `power up with an aura`

Trails are swept by the real path of the blade (or the hand or foot) frame by frame, so the ribbon matches the cut, glows brightest at the edge and fades from the oldest part first. The built-in engine handles common effects offline (slash trails, sparks, petals, embers, fire, smoke, dust, lightning, energy slashes, shockwaves, auras, magic circles, hearts, confetti, snow…); "dark" or "shadow" makes an ink-coloured trail with a coloured edge.

Claude can design its own effects instead of picking from a list. Each effect is a **trail**, **particles** (spark, petal, ember, flame, smoke, star, leaf, snow, heart, shard and more) or a **shape** (ring, crescent, beam, pillar, sphere, spiral, rune circle, lightning bolt…), and Claude chooses where it comes from (the blade, the tip, a hand, a foot, the head, the floor), when (each swing, each shot, whenever the point moves fast, at set times, or the whole time), colours, size, how long it lasts, speed, spread, gravity and spin. After baking, WebBlend checks every effect (does it appear at all, does it drift away from the character, go into the sky or under the floor) and shows Claude a filmstrip of the motion with the effects on, so it can fix anything that looks wrong before you see it.

Select an effect (it's one row in the timeline, marked ✦) to change its colours or timing, or remove it. **View → Hide effects** hides them while you animate.

### Models made by the AI

The built-in models (pistol, rifle, SMG, sniper rifle, pump shotgun, sword, katana, knife, baseball bat) are detailed procedural models: bevelled outlines, slide serrations, sights, rails, pins and grooves, with metal, polymer, rubber and wood surfaces. Blades have a real cross-section (spine, ridge line, sharp edge, curved katana tip and temper line). Add a colour (black, tan, olive, silver, gold, wood, white, red, pink, blue) and a pattern: `make a katana with gold flowers and swing it`, `an engraved silver pistol`, `pink camo rifle`. Patterns: flowers, sakura, vines, scroll engraving, damascus, camo, digital camo, hex, stripes, flames, stars, hearts, scales, dots. They work offline.

With Claude you can ask for anything else ("make a retro ray gun", "make a lightsaber and swing it", "a revolver with a long barrel", "a katana with a dragon drawn on the blade"). Claude builds it as a custom model at game-asset quality rather than falling back to a built-in one: extruded outlines for the silhouette, smooth lofted bodies, lathed round parts, swept tubes and cables, real blades, mirrored left/right parts, bevels and small details, physically based materials, and patterns or its own SVG drawings painted onto surfaces. It says where the hands go and where the muzzle is, and animates the character using it.

**Claude checks its own work.** After the first draft, WebBlend renders the model from four sides (right, front, top, three-quarter on a 10 cm grid, with the grip and muzzle marked) and runs an inspection (parts that failed to build, pieces floating or not touching, the grip off the model, a gun not pointing forward, too few parts). Claude gets the renders and the report, compares them with your request and reference images, and sends back an improved model. Turn it off under Settings → AI if you want faster answers. Modeling requests use Claude's most capable setting automatically (Settings → AI → Effort: Auto).

You can also:

- **Attach reference images**: the picture button next to the prompt, or paste / drop images onto it. Claude copies a pose, a motion, or an object's shape and colours from them (hosted page and API key).
- **Let it look things up**: with an API key, Claude can search the web for references (real dimensions, parts, colours) before modelling something specific. Turn it off under Settings → AI.
- **Ask follow-ups**: it remembers the last few requests in the session ("now faster", "same but with the left hand").

**Holding things.** Select a held prop (or the character) to get Shoot / Swing, Aim / Guard, move it to the other hand, Flip it, or Remove it. Nudge it in the hand with the gizmo and aiming follows. Any model you import (a gun from Sketchfab, a tool...) can be put in a character's hand with **Give to a character** in its properties; WebBlend guesses the front, the grip and the muzzle, and Flip turns it around if it guessed wrong.

Claude gets a map of each character: how tall each body part is, which bone is which part (Japanese bone names translated to English), what moving each bone carries along (rotating a thigh moves the whole leg, so it bends knees with the knee setting instead), and the extra bones it can key, grouped as hair, ears, eyes, face, tail, fingers, clothes and so on. The Scene list also shows an English translation next to Japanese names, and its filter searches both.

## Export to Roblox, Unity, Unreal, Blender, Godot

**File → Export for Roblox, Unity, Unreal, Blender…** Pick where it's going (it remembers your choice next time) and the dialog sets the format and options, and shows how to import it there:

| Platform | File | Notes |
|---|---|---|
| Roblox Studio | `.fbx` (zip: the model plus one `.fbx` per animation) | Meters with the FBX unit scale, textures embedded (max 1024 px), material colours baked into textures, plain English bone names. Import with Home → Import 3D; bring each animation in through the Animation Editor's Import → From FBX Animation. Warns about meshes over Roblox's 20,000-triangle limit. |
| Unity | `.fbx` | Meters, every clip in one file (they show up in the Animation tab of the import settings). |
| Unreal Engine | `.fbx` | Centimeters; rigged models import as a Skeletal Mesh with every clip as an Animation Sequence. |
| Blender, Godot, web | `.glb` | glTF keeps shape keys and PBR materials; FBX is available too. |

The FBX is binary FBX 7.4 with meshes, normals, UVs, material slots, embedded textures, skeletons with skin weights and a bind pose, and one animation take per clip (constraints and IK are baked into the bones). "Animation only" writes just the motion for a rig you already imported. Shape keys (face morphs) are not written to FBX; use GLB for those.

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
| ` | Fly mode: W A S D move, E / Q up / down, right-drag look, Shift faster, mouse wheel sets speed, Esc exits |
| P · H · Esc | Select parent · hide model · deselect |

## Saving your work

Use **File → Save scene (.glb)**. Opening that file again restores every model with its clips and mix settings. The `.glb` also opens in Blender, Unity, Unreal, Godot and other tools; for Roblox use the FBX export above.

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
node tools/test-touch.mjs test-assets/assets/hero.blend              # hands placed on body spots, feet planted
node tools/test-props.mjs                                            # built-in models, holding, aiming, shooting effects
node tools/test-decor.mjs                                            # blades, lofts, sweeps, mirroring, patterns
node tools/test-vfx.mjs                                              # effects: trails follow the blade, timing, presets, checks
node tools/test-ai.mjs                                               # offline AI prompt parsing
node tools/e2e.cjs test-assets/assets ./out                          # full app in headless Chromium
node tools/e2e-formats.cjs test-assets/zoo ./out                     # every importer
node tools/e2e-ai.cjs                                                # Claude integrations (incl. the model self-review) with mocked responses
node tools/e2e-export.cjs ./out [python-with-bpy]                    # FBX export read back by three.js and, if given, Blender
node tools/e2e-archives.cjs ./out                                    # .jar scan (hidden folders, nested jars), Minecraft / GeckoLib / Blockbench models
node tools/e2e-qol.cjs                                               # effect editor, hide effects, turntable, remembered export platform
node tools/e2e-ui.cjs test-assets/assets ./out                       # timeline, properties, recording…
node tools/test-mmd.mjs test-assets/mmd/goat/goatchan.blend test-assets/mmd/goat_truth.json  # constraints + IK vs Blender
node tools/test-pose-truth.mjs rig.blend truth.json                # any rig vs Blender (truth from tools/blender/pose_truth.py)
node tools/e2e-mmd.cjs test-assets/mmd ./out                         # MMD-style .blend zip and Blender-exported .glb
node tools/e2e-mmdfiles.cjs <pmx folder> <pmd folder> <dance.vmd> ./out  # real MMD files (bring your own)
```
