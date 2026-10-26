import bpy, sys, os
out = sys.argv[sys.argv.index('--')+1]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.mesh.primitive_uv_sphere_add(); s = bpy.context.object; s.name = 'Ball'
img = bpy.data.images.load(os.path.join(out, '..', 'tex', 'pink.png'))
m = bpy.data.materials.new('BallMat'); m.use_nodes = True
n = m.node_tree.nodes.new('ShaderNodeTexImage'); n.image = img
m.node_tree.links.new(n.outputs['Color'], m.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
s.data.materials.append(m)
bpy.ops.export_scene.fbx(filepath=os.path.join(out, 'ball.fbx'), path_mode='COPY', embed_textures=False)
print('OK fbxtex')
