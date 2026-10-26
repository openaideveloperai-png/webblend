import bpy, sys, json
args = sys.argv[sys.argv.index('--')+1:]
res = {}
for f in args:
    bpy.ops.wm.open_mainfile(filepath=f)
    dg = bpy.context.evaluated_depsgraph_get()
    objs = {}
    for ob in bpy.data.objects:
        d = {'type': ob.type, 'world_loc': [round(x,4) for x in ob.matrix_world.translation]}
        if ob.type == 'MESH':
            # evaluate with only mirror modifiers (subsurf disabled)
            saved = [(m, m.show_viewport) for m in ob.modifiers if m.type not in ('MIRROR','ARMATURE')]
            for m,_ in saved: m.show_viewport = False
            dg.update()
            ev = ob.evaluated_get(dg).data
            d['tris'] = sum(len(p.vertices)-2 for p in ev.polygons)
            d['mats'] = [ (m.name if m else None) for m in ob.data.materials ]
            for m,v in saved: m.show_viewport = v
        if ob.type == 'ARMATURE':
            d['bones'] = [b.name for b in ob.data.bones]
        objs[ob.name] = d
    res[f.split('/')[-1]] = {'objects': objs, 'actions': {a.name: list(a.frame_range) for a in bpy.data.actions}}
print('JSON' + json.dumps(res))
