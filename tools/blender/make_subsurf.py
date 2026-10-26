import bpy, sys, os, json
out = sys.argv[sys.argv.index('--')+1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_cube_add(location=(0,0,1)); c = bpy.context.object; c.name = 'SubCube'
m = c.modifiers.new('Subdivision', 'SUBSURF'); m.levels = 2
bpy.ops.mesh.primitive_monkey_add(location=(3,0,1)); k = bpy.context.object; k.name = 'SubMonkey'
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.select_all(action='DESELECT'); bpy.ops.object.mode_set(mode='OBJECT')
for v in k.data.vertices: v.select = v.co.x < -1e-4
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.delete(type='VERT'); bpy.ops.object.mode_set(mode='OBJECT')
mm = k.modifiers.new('Mirror', 'MIRROR'); mm.use_mirror_merge = True
ms = k.modifiers.new('Subdivision', 'SUBSURF'); ms.levels = 1
k.shape_key_add(name='Basis'); sk = k.shape_key_add(name='Grow')
for d in sk.data: d.co = d.co * 1.3
bpy.ops.object.shade_smooth()
dg = bpy.context.evaluated_depsgraph_get()
truth = {}
for ob in (c, k):
    ev = ob.evaluated_get(dg)
    me = ev.to_mesh()
    xs = [v.co for v in me.vertices]
    mn = [min(p[i] for p in xs) for i in range(3)]; mx = [max(p[i] for p in xs) for i in range(3)]
    truth[ob.name] = {'tris': sum(len(p.vertices)-2 for p in me.polygons), 'size': [round(mx[i]-mn[i], 3) for i in range(3)]}
    ev.to_mesh_clear()
p = os.path.join(out, 'subsurf.blend'); bpy.ops.wm.save_as_mainfile(filepath=p, compress=True)
print('TRUTH' + json.dumps(truth))
