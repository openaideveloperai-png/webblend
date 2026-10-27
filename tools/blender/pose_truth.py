# Dump every bone's evaluated head position (constraints, IK and all) as
# Blender shows it, to compare WebBlend's rig solving with tools/test-pose-truth.mjs.
# Usage: blender -b --python tools/blender/pose_truth.py -- rig.blend out.json
#    or: python -I tools/blender/pose_truth.py rig.blend out.json   (with the bpy module)
import sys, json
import bpy
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else sys.argv[-2:]
src, out = args[0], args[1]
bpy.context.preferences.filepaths.use_scripts_auto_execute = False
bpy.ops.wm.open_mainfile(filepath=src, load_ui=False, use_scripts=False)
dg = bpy.context.evaluated_depsgraph_get()
res = {'frame': bpy.context.scene.frame_current, 'arms': {}}
for ob in bpy.context.scene.objects:
    if ob.type != 'ARMATURE':
        continue
    ev = ob.evaluated_get(dg)
    bones = {pb.name: list(ev.matrix_world @ pb.head) for pb in ev.pose.bones}
    # the same pose with every constraint muted (checks the raw import)
    muted = [c for pb in ob.pose.bones for c in pb.constraints if not c.mute]
    for c in muted:
        c.mute = True
    dg.update()
    ev = ob.evaluated_get(dg)
    raw = {pb.name: list(ev.matrix_world @ pb.head) for pb in ev.pose.bones}
    for c in muted:
        c.mute = False
    dg.update()
    res['arms'][ob.name] = {'bones': bones, 'raw': raw}
with open(out, 'w') as f:
    json.dump(res, f)
print('wrote', out, list(res['arms'].keys()))
