import bpy, sys, os
out = sys.argv[sys.argv.index('--')+1]
src = sys.argv[sys.argv.index('--')+2]
bpy.ops.wm.open_mainfile(filepath=src)
arm = [o for o in bpy.data.objects if o.type == 'ARMATURE'][0]
bpy.context.view_layer.objects.active = arm; arm.select_set(True)
try:
    bpy.ops.preferences.addon_enable(module='io_anim_bvh')
except Exception as e: print('addon', e)
bpy.ops.export_anim.bvh(filepath=os.path.join(out, 'wave.bvh'), frame_start=1, frame_end=24)
print('OK bvh')
