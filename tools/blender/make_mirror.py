import bpy, sys, os, math
out = sys.argv[sys.argv.index('--')+1]
ver = bpy.app.version_string.split()[0]
bpy.ops.wm.read_factory_settings(use_empty=True)
# half monkey with mirror + shape key + mirrored vgroups and an armature
bpy.ops.mesh.primitive_monkey_add(location=(0,0,0))
m = bpy.context.object; m.name = "HalfMonkey"
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT'); bpy.ops.object.mode_set(mode='OBJECT')
for v in m.data.vertices: v.select = v.co.x < -1e-4
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.delete(type='VERT'); bpy.ops.object.mode_set(mode='OBJECT')
mod = m.modifiers.new("Mirror", 'MIRROR'); mod.use_axis[0] = True; mod.use_mirror_merge = True; mod.use_mirror_vertex_groups = True
bpy.ops.object.shade_smooth()
m.shape_key_add(name="Basis"); k = m.shape_key_add(name="Puff")
for i,v in enumerate(k.data): v.co = v.co * 1.2
k.value = 0.3
k.keyframe_insert("value", frame=1); k.value = 1.0; k.keyframe_insert("value", frame=20)
print("TRIS_EVAL", sum(len(p.vertices)-2 for p in m.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.polygons))
print("VERTS_EVAL", len(m.evaluated_get(bpy.context.evaluated_depsgraph_get()).data.vertices))
print("MIRROR_FLAGS axis", list(mod.use_axis), "merge", mod.use_mirror_merge, "vg", mod.use_mirror_vertex_groups, "thr", mod.merge_threshold)
p = os.path.join(out, f"mirror_{ver}.blend"); bpy.ops.wm.save_as_mainfile(filepath=p); print("saved", p)
