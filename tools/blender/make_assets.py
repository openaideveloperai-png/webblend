import bpy, sys, os, math, bmesh
from mathutils import Vector
out = sys.argv[sys.argv.index('--')+1]
os.makedirs(out, exist_ok=True)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

# humanoid skeleton definition (Blender Z-up, facing -Y)
UE = [
 ('pelvis', None, (0,0,0.95), (0,0,1.05)),
 ('spine_01', 'pelvis', (0,0,1.05), (0,0,1.17)),
 ('spine_02', 'spine_01', (0,0,1.17), (0,0,1.30)),
 ('spine_03', 'spine_02', (0,0,1.30), (0,0,1.45)),
 ('neck_01', 'spine_03', (0,0,1.45), (0,0,1.56)),
 ('head', 'neck_01', (0,0,1.56), (0,0,1.78)),
]
for s, sx in (('l',1),('r',-1)):
    UE += [
     (f'clavicle_{s}', 'spine_03', (0.03*sx,0,1.41), (0.17*sx,0,1.42)),
     (f'upperarm_{s}', f'clavicle_{s}', (0.17*sx,0,1.42), (0.44*sx,0,1.42)),
     (f'lowerarm_{s}', f'upperarm_{s}', (0.44*sx,0,1.42), (0.69*sx,0,1.42)),
     (f'hand_{s}', f'lowerarm_{s}', (0.69*sx,0,1.42), (0.82*sx,0,1.42)),
     (f'thigh_{s}', 'pelvis', (0.1*sx,0,0.92), (0.1*sx,-0.01,0.5)),
     (f'calf_{s}', f'thigh_{s}', (0.1*sx,-0.01,0.5), (0.1*sx,0.01,0.09)),
     (f'foot_{s}', f'calf_{s}', (0.1*sx,0.01,0.09), (0.1*sx,-0.12,0.03)),
     (f'ball_{s}', f'foot_{s}', (0.1*sx,-0.12,0.03), (0.1*sx,-0.2,0.03)),
    ]

def build_armature(name, bones, prefix=''):
    bpy.ops.object.armature_add(location=(0,0,0))
    arm = bpy.context.object; arm.name = name; arm.data.name = name
    bpy.ops.object.mode_set(mode='EDIT')
    eb = arm.data.edit_bones
    for b in list(eb): eb.remove(b)
    for n, p, hd, tl in bones:
        b = eb.new(prefix + n); b.head = hd; b.tail = tl
        if p: b.parent = eb[prefix + p]
    bpy.ops.object.mode_set(mode='OBJECT')
    return arm

def build_body(arm):
    parts = []
    for b in arm.data.bones:
        hd = arm.matrix_world @ b.head_local; tl = arm.matrix_world @ b.tail_local
        L = (tl-hd).length
        if 'ball' in b.name or 'clavicle' in b.name: continue
        r = 0.06
        if 'head' in b.name: r = 0.1
        if 'pelvis' in b.name or 'spine' in b.name: r = 0.14
        if 'hand' in b.name or 'foot' in b.name: r = 0.04
        if 'lowerarm' in b.name or 'neck' in b.name: r = 0.045
        bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=r, depth=L, location=(hd+tl)/2)
        c = bpy.context.object
        c.rotation_mode = 'QUATERNION'; c.rotation_quaternion = Vector((0,0,1)).rotation_difference((tl-hd).normalized())
        bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.subdivide(number_cuts=3); bpy.ops.object.mode_set(mode='OBJECT')
        parts.append(c)
    bpy.ops.object.select_all(action='DESELECT')
    for p in parts: p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join(); body = bpy.context.object; body.name = 'Body'
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    m = bpy.data.materials.new('Skin'); m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.8, 0.45, 0.3, 1)
    body.data.materials.append(m)
    body.select_set(True); arm.select_set(True); bpy.context.view_layer.objects.active = arm
    bpy.ops.object.parent_set(type='ARMATURE_AUTO')
    return body

def key_action(arm, name, frames, poses, prefix=''):
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode='POSE')
    for f, pose in zip(frames, poses):
        for bn, eul in pose.items():
            pb = arm.pose.bones[prefix + bn]; pb.rotation_mode = 'XYZ'
            pb.rotation_euler = [math.radians(a) for a in eul]
            pb.keyframe_insert('rotation_euler', frame=f)
    bpy.ops.object.mode_set(mode='OBJECT')
    arm.animation_data.action.name = name

# --- hero (UE names) with Wave action
reset()
arm = build_armature('HeroRig', UE)
body = build_body(arm)
key_action(arm, 'Wave', [1, 12, 24], [
  {'upperarm_r': (0,0,0), 'lowerarm_r': (0,0,0)},
  {'upperarm_r': (0,-60,0), 'lowerarm_r': (0,0,-70)},
  {'upperarm_r': (0,0,0), 'lowerarm_r': (0,0,0)}])
bpy.context.scene.frame_end = 24
bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'hero.glb'), export_format='GLB', export_animations=True)
bpy.ops.export_scene.fbx(filepath=os.path.join(out, 'hero.fbx'), bake_anim=True, add_leaf_bones=False)
bpy.ops.wm.save_as_mainfile(filepath=os.path.join(out, 'hero.blend'))
print('hero done')

# --- mixamo-named animation-only armature (no mesh), different proportions (taller)
reset()
MX = {'pelvis':'Hips','spine_01':'Spine','spine_02':'Spine1','spine_03':'Spine2','neck_01':'Neck','head':'Head',
      'clavicle_l':'LeftShoulder','upperarm_l':'LeftArm','lowerarm_l':'LeftForeArm','hand_l':'LeftHand','thigh_l':'LeftUpLeg','calf_l':'LeftLeg','foot_l':'LeftFoot','ball_l':'LeftToeBase',
      'clavicle_r':'RightShoulder','upperarm_r':'RightArm','lowerarm_r':'RightForeArm','hand_r':'RightHand','thigh_r':'RightUpLeg','calf_r':'RightLeg','foot_r':'RightFoot','ball_r':'RightToeBase'}
bones = [(MX[n], MX[p] if p else None, tuple(v*1.15 for v in hd), tuple(v*1.15 for v in tl)) for n,p,hd,tl in UE]
arm = build_armature('Armature', bones, prefix='mixamorig:')
# kick with left leg + arms up
key_action(arm, 'Kick', [1, 10, 20], [
  {'LeftUpLeg': (0,0,0), 'LeftLeg': (0,0,0), 'LeftArm': (0,0,0), 'RightArm': (0,0,0)},
  {'LeftUpLeg': (-70,0,0), 'LeftLeg': (20,0,0), 'LeftArm': (0,-50,0), 'RightArm': (0,50,0)},
  {'LeftUpLeg': (0,0,0), 'LeftLeg': (0,0,0), 'LeftArm': (0,0,0), 'RightArm': (0,0,0)}], prefix='mixamorig:')
bpy.context.scene.frame_end = 20
bpy.ops.export_scene.fbx(filepath=os.path.join(out, 'kick_anim_only.fbx'), bake_anim=True, add_leaf_bones=False)
print('anim done')

# --- textured OBJ + MTL + PNG
reset()
bpy.ops.mesh.primitive_monkey_add()
o = bpy.context.object; o.name = 'Monkey'
bpy.ops.object.modifier_add(type='SUBSURF'); o.modifiers[0].levels = 1; bpy.ops.object.modifier_apply(modifier=o.modifiers[0].name)
bpy.ops.object.shade_smooth()
img = bpy.data.images.new('wood', 128, 128)
px = []
for y in range(128):
    for x in range(128):
        v = 0.5 + 0.5*math.sin(x*0.3 + math.sin(y*0.05)*4)
        px += [0.55*v+0.25, 0.35*v+0.15, 0.15*v+0.05, 1]
img.pixels = px; texdir = os.path.join(out, 'objpack', 'textures'); os.makedirs(texdir, exist_ok=True)
img.filepath_raw = os.path.join(texdir, 'wood.png'); img.file_format='PNG'; img.save()
m = bpy.data.materials.new('Wood'); m.use_nodes = True
t = m.node_tree.nodes.new('ShaderNodeTexImage'); t.image = img
m.node_tree.links.new(t.outputs['Color'], m.node_tree.nodes['Principled BSDF'].inputs['Base Color'])
o.data.materials.append(m)
bpy.ops.wm.obj_export(filepath=os.path.join(out, 'objpack', 'monkey.obj'), path_mode='RELATIVE')
print('obj done')
