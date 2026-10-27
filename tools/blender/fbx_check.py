# Import an FBX into an empty Blender scene and report what came in.
import bpy, sys, json, mathutils
path, out = sys.argv[sys.argv.index('--') + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=path)
sc = bpy.context.scene
rep = {'objects': {}, 'meshes': 0, 'tris': 0, 'armatures': [], 'actions': [a.name for a in bpy.data.actions], 'images': [i.name for i in bpy.data.images], 'materials': len(bpy.data.materials), 'fps': sc.render.fps}
for o in sc.objects:
    rep['objects'][o.type] = rep['objects'].get(o.type, 0) + 1
    if o.type == 'MESH':
        rep['meshes'] += 1
        me = o.data; me.calc_loop_triangles(); rep['tris'] += len(me.loop_triangles)
        if o.vertex_groups: rep.setdefault('skinned', []).append([o.name, len(o.vertex_groups), o.parent.name if o.parent else None])
    if o.type == 'ARMATURE':
        rep['armatures'].append([o.name, len(o.data.bones)])
arm = next((o for o in sc.objects if o.type == 'ARMATURE'), None)
if arm:
    walk = next((a for a in bpy.data.actions if 'Walk' in a.name), None)
    if walk:
        arm.animation_data_create(); arm.animation_data.action = walk
        try:
            if walk.slots: arm.animation_data.action_slot = walk.slots[0]
        except Exception: pass
        rep['walk_range'] = list(walk.frame_range)
    truth = json.load(open(sys.argv[sys.argv.index('--') + 3]))['samples'] if len(sys.argv) > sys.argv.index('--') + 3 else {}
    err = 0; n = 0
    for t, bones in truth.items():
        sc.frame_set(1, subframe=0.0)
        f = 1 + float(t) * sc.render.fps
        sc.frame_set(int(f), subframe=f - int(f))
        bpy.context.view_layer.update()
        for name, p in bones.items():
            pb = arm.pose.bones.get(name)
            if not pb: continue
            w = arm.matrix_world @ pb.head
            want = mathutils.Vector((p[0], -p[2], p[1]))  # three Y-up -> Blender Z-up
            err = max(err, (w - want).length); n += 1
    rep['poseError'] = err; rep['poseChecks'] = n
    sc.frame_set(16)
    bpy.context.view_layer.update()
    # where the skinned mesh's foot vertices ended up (skin deformation works?)
    sk = next((o for o in sc.objects if o.type == 'MESH' and o.vertex_groups.get('LeftFoot')), None)
    if sk:
        dg = bpy.context.evaluated_depsgraph_get(); ev = sk.evaluated_get(dg); me = ev.to_mesh()
        vg = sk.vertex_groups['LeftFoot'].index
        pts = [sk.matrix_world @ me.vertices[v.index].co for v in sk.data.vertices if any(g.group == vg and g.weight > 0.9 for g in v.groups)]
        if pts: c = sum(pts, mathutils.Vector()) / len(pts); rep['footSkinCenter'] = list(c); rep['footSkinVerts'] = len(pts)
        ev.to_mesh_clear()
json.dump(rep, open(out, 'w'), indent=1)
