import bpy, sys, os, math
out = sys.argv[sys.argv.index('--')+1]
ver = bpy.app.version_string.split()[0]
os.makedirs(out, exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_torus_add(); t = bpy.context.object; t.name = 'Donut'
img = bpy.data.images.new('pink', 64, 64)
img.pixels = [v for y in range(64) for x in range(64) for v in ((1, .4, .7, 1) if (x//8+y//8)%2 else (.3, .1, .2, 1))]
d = os.path.join(out, 'tex'); os.makedirs(d, exist_ok=True)
img.filepath_raw = os.path.join(d, 'pink.png'); img.file_format = 'PNG'; img.save()
m = bpy.data.materials.new('Icing'); m.use_nodes = True
n = m.node_tree.nodes.new('ShaderNodeTexImage'); n.image = img
m.node_tree.links.new(n.outputs['Color'], m.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
t.data.materials.append(m)
t.location = (0, 0, 1)
t.keyframe_insert('rotation_euler', frame=1); t.rotation_euler = (0, 0, math.pi); t.keyframe_insert('rotation_euler', frame=30)
def tryex(label, fn):
    try: fn(); print('OK', label)
    except Exception as e: print('FAIL', label, e)
if ver.startswith('5'):
    tryex('draco', lambda: bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'donut_draco.glb'), export_format='GLB', export_draco_mesh_compression_enable=True))
    tryex('gltf_sep', lambda: bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'gltfsep', 'donut.gltf'), export_format='GLTF_SEPARATE', export_texture_dir='textures'))
    tryex('stl', lambda: bpy.ops.wm.stl_export(filepath=os.path.join(out, 'donut.stl')))
    tryex('ply', lambda: bpy.ops.wm.ply_export(filepath=os.path.join(out, 'donut.ply')))
    tryex('usdz', lambda: bpy.ops.wm.usd_export(filepath=os.path.join(out, 'donut.usdz')))
    tryex('fbx_tex', lambda: bpy.ops.export_scene.fbx(filepath=os.path.join(out, 'fbxtex', 'donut.fbx'), path_mode='COPY', embed_textures=False))
else:
    tryex('dae', lambda: bpy.ops.wm.collada_export(filepath=os.path.join(out, 'donut.dae')))
