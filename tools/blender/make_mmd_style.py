# Builds an MMD-style character the way MMD converters lay it out:
# Japanese bone names, control bones + constraint-driven D bones, IK bones,
# hidden rigid bodies/joints, node-group materials, textures in a tex/ folder.
import bpy, sys, os, math, struct, json
from mathutils import Vector
out = sys.argv[sys.argv.index('--') + 1]
G = os.path.join(out, 'goat')
for d in ('tex', 'config', 'data', 'mesh'):
    os.makedirs(os.path.join(G, d), exist_ok=True)
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---------------------------------------------------------------- textures
def pattern(w, h, f):
    px = []
    for y in range(h):
        for x in range(w):
            px.extend(f(x, y))
    return px

def save_img(name, w, h, f, path, fmt, alpha=False):
    img = bpy.data.images.new(name, w, h, alpha=alpha)
    img.pixels = pattern(w, h, f)
    img.filepath_raw = path
    img.file_format = fmt
    img.save()
    return img

body_png = os.path.join(G, 'tex', 'body_col.png')
save_img('body_col', 64, 64, lambda x, y: (0.9, 0.3 + 0.4 * ((x // 8 + y // 8) % 2), 0.2, 1), body_png, 'PNG')
hair_tga = os.path.join(G, 'tex', 'hair.tga')
save_img('hair', 64, 64, lambda x, y: (0.1, 0.7, 0.6, 1.0 if (x // 4) % 2 else 0.0), hair_tga, 'TARGA', alpha=True)
eye_bmp = os.path.join(G, 'tex', 'eye.bmp')
save_img('eye', 32, 32, lambda x, y: (0.1, 0.2, 0.9, 1) if (x - 16) ** 2 + (y - 16) ** 2 < 64 else (1, 1, 1, 1), eye_bmp, 'BMP')

# face texture as DXT1 .dds (common in game rips); Blender can't write DDS
def write_dds_dxt1(path, w, h, f):
    def c565(c):
        r, g, b = [max(0, min(255, int(v * 255))) for v in c[:3]]
        return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
    blocks = bytearray()
    for by in range(0, h, 4):
        for bx in range(0, w, 4):
            # DDS rows go top-down; Blender pixels go bottom-up, so flip y
            cols = [f(bx + i, h - 1 - (by + j)) for j in range(4) for i in range(4)]
            lum = [c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11 for c in cols]
            hi = cols[lum.index(max(lum))]; lo = cols[lum.index(min(lum))]
            c0, c1 = c565(hi), c565(lo)
            if c0 < c1: c0, c1 = c1, c0; hi, lo = lo, hi
            if c0 == c1:
                idx = 0
            else:
                idx = 0
                for k, l in enumerate(lum):
                    t = (l - min(lum)) / max(1e-6, max(lum) - min(lum))
                    code = 0 if t > 0.83 else 2 if t > 0.5 else 3 if t > 0.17 else 1
                    idx |= code << (2 * k)
            blocks += struct.pack('<HHI', c0, c1, idx)
    hdr = struct.pack('<4sIIIIIII44sIIIIIIIIIIIII', b'DDS ', 124, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000, h, w, len(blocks), 0, 1,
                      b'\0' * 44, 32, 0x4, b'DXT1'[0] | (b'DXT1'[1] << 8) | (b'DXT1'[2] << 16) | (b'DXT1'[3] << 24), 0, 0, 0, 0, 0, 0x1000, 0, 0, 0, 0)
    open(path, 'wb').write(hdr + bytes(blocks))

face_dds = os.path.join(G, 'tex', 'face_d.dds')
write_dds_dxt1(face_dds, 64, 64, lambda x, y: (1.0, 0.85, 0.75, 1) if not (20 < x < 44 and 10 < y < 18) else (0.8, 0.2, 0.3, 1))

# ---------------------------------------------------------------- armature
J = []  # name, parent, head, tail, deform
def bone(n, p, hd, tl, deform=True): J.append((n, p, hd, tl, deform))
bone('全ての親', None, (0, 0, 0), (0, 0, 0.15), False)
bone('センター', '全ての親', (0, 0, 0.8), (0, 0, 0.7), False)
bone('グルーブ', 'センター', (0, 0, 0.85), (0, 0, 0.75), False)
bone('腰', 'グルーブ', (0, 0.02, 0.9), (0, 0, 0.95))
bone('上半身', '腰', (0, 0, 0.95), (0, 0, 1.15))
bone('上半身2', '上半身', (0, 0, 1.15), (0, 0, 1.36))
bone('首', '上半身2', (0, 0, 1.40), (0, 0, 1.50))
bone('頭', '首', (0, 0, 1.50), (0, 0, 1.72))
bone('下半身', '腰', (0, 0, 0.95), (0, 0, 0.84))
for S, sx, suf in (('左', 1, 'L'), ('右', -1, 'R')):
    bone(f'{S}肩', '上半身2', (0.03 * sx, 0, 1.36), (0.15 * sx, 0, 1.38))
    bone(f'{S}腕', f'{S}肩', (0.15 * sx, 0, 1.38), (0.40 * sx, 0, 1.30))
    bone(f'{S}ひじ', f'{S}腕', (0.40 * sx, 0, 1.30), (0.62 * sx, -0.01, 1.22))
    bone(f'{S}手首', f'{S}ひじ', (0.62 * sx, -0.01, 1.22), (0.72 * sx, -0.01, 1.19))
    bone(f'{S}人指１', f'{S}手首', (0.72 * sx, -0.02, 1.19), (0.76 * sx, -0.02, 1.18))
    # control leg (not deforming; MMD rigs pose these)
    bone(f'{S}足', '下半身', (0.09 * sx, 0, 0.88), (0.09 * sx, -0.01, 0.48), False)
    bone(f'{S}ひざ', f'{S}足', (0.09 * sx, -0.01, 0.48), (0.09 * sx, 0.01, 0.08), False)
    bone(f'{S}足首', f'{S}ひざ', (0.09 * sx, 0.01, 0.08), (0.09 * sx, -0.10, 0.02), False)
    # D bones carry the weights and copy the control bones
    bone(f'{S}足D', '下半身', (0.09 * sx, 0, 0.88), (0.09 * sx, -0.01, 0.48))
    bone(f'{S}ひざD', f'{S}足D', (0.09 * sx, -0.01, 0.48), (0.09 * sx, 0.01, 0.08))
    bone(f'{S}足首D', f'{S}ひざD', (0.09 * sx, 0.01, 0.08), (0.09 * sx, -0.10, 0.02))
    bone(f'{S}足先EX', f'{S}足首D', (0.09 * sx, -0.10, 0.02), (0.09 * sx, -0.15, 0.02))
    bone(f'{S}足ＩＫ', '全ての親', (0.09 * sx, 0.01, 0.08), (0.09 * sx, 0.11, 0.08), False)
    bone(f'乳001{suf}', '上半身2', (0.07 * sx, -0.06, 1.24), (0.07 * sx, -0.10, 1.22))
    bone(f'乳002{suf}', f'乳001{suf}', (0.07 * sx, -0.10, 1.22), (0.07 * sx, -0.13, 1.21))
    bone(f'_dummy_{S}足D', f'{S}足D', (0.09 * sx, 0, 0.88), (0.09 * sx, -0.01, 0.48), False)
    bone(f'_shadow_{S}足D', '下半身', (0.09 * sx, 0, 0.88), (0.09 * sx, -0.01, 0.48), False)

bpy.ops.object.armature_add(location=(0, 0, 0))
arm = bpy.context.object; arm.name = 'goatchan_arm'; arm.data.name = 'goatchan_arm'
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
for b in list(eb): eb.remove(b)
for n, p, hd, tl, d in J:
    b = eb.new(n); b.head = hd; b.tail = tl; b.use_deform = d
    if p: b.parent = eb[p]
bpy.ops.object.mode_set(mode='OBJECT')

# constraints like an MMD converter sets up
for S in ('左', '右'):
    for c, d in ((f'{S}足', f'{S}足D'), (f'{S}ひざ', f'{S}ひざD'), (f'{S}足首', f'{S}足首D')):
        con = arm.pose.bones[d].constraints.new('COPY_ROTATION')
        con.target = arm; con.subtarget = c
        con.owner_space = 'LOCAL'; con.target_space = 'LOCAL'
    ik = arm.pose.bones[f'{S}ひざ'].constraints.new('IK')
    ik.target = arm; ik.subtarget = f'{S}足ＩＫ'; ik.chain_count = 2
    arm.pose.bones[f'{S}ひざ'].use_ik_limit_y = True
    arm.pose.bones[f'{S}ひざ'].use_ik_limit_z = True
    lim = arm.pose.bones[f'{S}ひざ'].constraints.new('LIMIT_ROTATION')
    lim.use_limit_x = True; lim.min_x = 0; lim.max_x = math.radians(170); lim.owner_space = 'LOCAL'

# ---------------------------------------------------------------- materials
def mmd_group():
    g = bpy.data.node_groups.get('MMDShaderDev')
    if g: return g
    g = bpy.data.node_groups.new('MMDShaderDev', 'ShaderNodeTree')
    for n, t in (('Ambient Color', 'NodeSocketColor'), ('Diffuse Color', 'NodeSocketColor'), ('Base Tex Fac', 'NodeSocketFloat'),
                 ('Base Tex', 'NodeSocketColor'), ('Base Alpha', 'NodeSocketFloat'), ('Toon Tex', 'NodeSocketColor'), ('Sphere Tex', 'NodeSocketColor')):
        g.interface.new_socket(n, in_out='INPUT', socket_type=t)
    g.interface.new_socket('Shader', in_out='OUTPUT', socket_type='NodeSocketShader')
    gi = g.nodes.new('NodeGroupInput'); go = g.nodes.new('NodeGroupOutput')
    mix = g.nodes.new('ShaderNodeMix'); mix.data_type = 'RGBA'; mix.blend_type = 'MULTIPLY'
    bs = g.nodes.new('ShaderNodeBsdfPrincipled')
    g.links.new(gi.outputs['Base Tex Fac'], mix.inputs['Factor'])
    g.links.new(gi.outputs['Diffuse Color'], mix.inputs[6])
    g.links.new(gi.outputs['Base Tex'], mix.inputs[7])
    g.links.new(mix.outputs[2], bs.inputs['Base Color'])
    g.links.new(gi.outputs['Base Alpha'], bs.inputs['Alpha'])
    g.links.new(bs.outputs['BSDF'], go.inputs['Shader'])
    return g

def mmd_mat(name, tex_path, diffuse=(1, 1, 1, 1), toon=None):
    m = bpy.data.materials.new(name); m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes): nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    grp = nt.nodes.new('ShaderNodeGroup'); grp.node_tree = mmd_group(); grp.name = 'mmd_shader'
    grp.inputs['Diffuse Color'].default_value = diffuse
    grp.inputs['Base Tex Fac'].default_value = 1
    grp.inputs['Base Alpha'].default_value = 1
    tex = nt.nodes.new('ShaderNodeTexImage'); tex.name = 'mmd_base_tex'
    tex.image = bpy.data.images.load(tex_path)
    nt.links.new(tex.outputs['Color'], grp.inputs['Base Tex'])
    # toon + sphere textures are wired too, and must not be mistaken for the base color
    t2 = nt.nodes.new('ShaderNodeTexImage'); t2.name = 'mmd_toon_tex'
    t2.image = bpy.data.images.load(toon or eye_bmp, check_existing=True)
    if toon is None:
        t2.image = bpy.data.images.new('toon01.bmp', 4, 4); t2.image.source = 'FILE'; t2.image.filepath = 'C:\\Program Files\\MikuMikuDance\\Data\\toon01.bmp'
    nt.links.new(t2.outputs['Color'], grp.inputs['Toon Tex'])
    nt.links.new(grp.outputs['Shader'], out.inputs['Surface'])
    m.use_backface_culling = False
    return m

MATS = [mmd_mat('body', body_png), mmd_mat('face', face_dds)]
hm = bpy.data.materials.new('hair'); hm.use_nodes = True
bs = hm.node_tree.nodes['Principled BSDF']
ht = hm.node_tree.nodes.new('ShaderNodeTexImage'); ht.image = bpy.data.images.load(hair_tga)
hm.node_tree.links.new(ht.outputs['Color'], bs.inputs['Base Color'])
hm.node_tree.links.new(ht.outputs['Alpha'], bs.inputs['Alpha'])
hm.surface_render_method = 'BLENDED'
MATS += [hm, mmd_mat('eye', eye_bmp)]

# ---------------------------------------------------------------- body mesh
def part(bname, r, mat_index, verts=10, extra=None):
    b = arm.data.bones[bname]
    hd, tl = b.head_local, b.tail_local
    L = (tl - hd).length
    bpy.ops.mesh.primitive_cylinder_add(vertices=verts, radius=r, depth=L, location=(hd + tl) / 2)
    c = bpy.context.object
    c.rotation_mode = 'QUATERNION'; c.rotation_quaternion = Vector((0, 0, 1)).rotation_difference((tl - hd).normalized())
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    vg = c.vertex_groups.new(name=bname)
    vg.add(list(range(len(c.data.vertices))), 1.0, 'REPLACE')
    c.data.materials.append(MATS[mat_index])
    return c

parts = []
parts.append(part('上半身', 0.13, 0))
parts.append(part('上半身2', 0.14, 0))
parts.append(part('下半身', 0.13, 0))
parts.append(part('首', 0.04, 0))
for S, suf in (('左', 'L'), ('右', 'R')):
    parts += [part(f'{S}腕', 0.045, 0), part(f'{S}ひじ', 0.04, 0), part(f'{S}手首', 0.035, 0)]
    parts += [part(f'{S}足D', 0.06, 0), part(f'{S}ひざD', 0.05, 0), part(f'{S}足首D', 0.04, 0)]
    parts.append(part(f'乳002{suf}', 0.04, 0))
# head with face (dds), hair (tga, alpha) and eyes (bmp)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.12, location=(0, 0, 1.62), segments=16, ring_count=8)
head = bpy.context.object
head.vertex_groups.new(name='頭').add(list(range(len(head.data.vertices))), 1.0, 'REPLACE')
head.data.materials.append(MATS[1])
parts.append(head)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.135, location=(0, 0.01, 1.65), segments=16, ring_count=8)
hair = bpy.context.object
hair.vertex_groups.new(name='頭').add(list(range(len(hair.data.vertices))), 1.0, 'REPLACE')
hair.data.materials.append(MATS[2])
parts.append(hair)
for sx in (1, -1):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.02, location=(0.045 * sx, -0.11, 1.64), segments=8, ring_count=6)
    e = bpy.context.object
    e.vertex_groups.new(name='頭').add(list(range(len(e.data.vertices))), 1.0, 'REPLACE')
    e.data.materials.append(MATS[3])
    parts.append(e)

bpy.ops.object.select_all(action='DESELECT')
for p in parts: p.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.join()
body = bpy.context.object; body.name = 'goatchan_mesh'; body.data.name = 'goatchan_mesh'
bpy.ops.object.shade_smooth()

body.parent = arm
mod = body.modifiers.new('Armature', 'ARMATURE'); mod.object = arm

# shape keys with Japanese names
body.shape_key_add(name='Basis')
k = body.shape_key_add(name='まばたき')
for i, v in enumerate(body.data.vertices):
    if v.co.z > 1.5 and v.co.y < -0.08: k.data[i].co = v.co + Vector((0, 0, -0.01))

# ---------------------------------------------------------------- MMD root + physics helpers
root = bpy.data.objects.new('goatchan', None); bpy.context.scene.collection.objects.link(root)
root['mmd_type'] = 'ROOT'
arm.parent = root
rbp = bpy.data.objects.new('rigidbodies', None); bpy.context.scene.collection.objects.link(rbp); rbp.parent = root
jp = bpy.data.objects.new('joints', None); bpy.context.scene.collection.objects.link(jp); jp.parent = root
rb_col = bpy.data.collections.new('RigidBodies'); bpy.context.scene.collection.children.link(rb_col)
jt_col = bpy.data.collections.new('Joints'); bpy.context.scene.collection.children.link(jt_col)
for i in range(21):
    nm = 'rigidbody_bone' + ('' if i == 0 else '%03d' % i)
    if i <= 10:
        me = bpy.data.meshes.new(nm)
        bpy.ops.mesh.primitive_ico_sphere_add(radius=0.04, location=(0, 0, 0.9 + i * 0.04))
        tmp = bpy.context.object; me = tmp.data; bpy.data.objects.remove(tmp)
        o = bpy.data.objects.new(nm, me); bpy.context.scene.collection.objects.link(o)
        o.display_type = 'WIRE'; o.hide_render = True; o.hide_viewport = True   # object-level hide
    else:
        o = bpy.data.objects.new(nm, None); rb_col.objects.link(o)          # collection hidden in view layer
        o.location = (0, 0, 0.9 + i * 0.04)
    o.parent = rbp
for i in range(6):
    o = bpy.data.objects.new('joint_%d' % i, None); jt_col.objects.link(o); o.parent = jp
cage = bpy.ops.mesh.primitive_cube_add(size=2, location=(0, 0, 1))
cage = bpy.context.object; cage.name = 'temp_cage'
bpy.context.view_layer.update()
lc = bpy.context.view_layer.layer_collection
lc.children['RigidBodies'].hide_viewport = True   # eye icon
lc.children['Joints'].exclude = True              # checkbox off
cage.hide_set(True)                              # per-view-layer hide

# ---------------------------------------------------------------- animation on control bones
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='POSE')
def key(f, bn, eul=None, loc=None):
    pb = arm.pose.bones[bn]; pb.rotation_mode = 'XYZ'
    if eul is not None:
        pb.rotation_euler = [math.radians(a) for a in eul]; pb.keyframe_insert('rotation_euler', frame=f)
    if loc is not None:
        pb.location = loc; pb.keyframe_insert('location', frame=f)
for f, a in ((1, 0), (15, 1), (30, 0)):
    key(f, '左足', (-50 * a, 0, 0))
    key(f, '上半身', (0, 0, 20 * a))
    key(f, '左腕', (0, 40 * a, 0))
    key(f, 'センター', loc=(0, 0, -0.05 * a))
    key(f, '左足ＩＫ', loc=(0, -0.15 * a, 0.25 * a))
bpy.ops.object.mode_set(mode='OBJECT')
arm.animation_data.action.name = 'Dance'
bpy.context.scene.frame_start = 1; bpy.context.scene.frame_end = 30

# where the left knee mesh ends up at frame 15 (ground truth for the importer test)
bpy.context.scene.frame_set(15)
dg = bpy.context.evaluated_depsgraph_get()
truth = {}
for bn in ('左ひざD', '左足首D', '左ひざ', '頭', '左手首', '右ひざD'):
    pb = arm.pose.bones[bn]
    truth[bn] = list(arm.matrix_world @ pb.head)
bpy.context.scene.frame_set(1)
truth_rest = {bn: list(arm.matrix_world @ arm.pose.bones[bn].head) for bn in truth}
json.dump({'frame15': truth, 'frame1': truth_rest}, open(os.path.join(out, 'goat_truth.json'), 'w'), ensure_ascii=False, indent=1)

# random extra files like real asset folders have
json.dump({'shader': 'toon', 'outline': 0.002}, open(os.path.join(G, 'config', 'material.json'), 'w'))
json.dump({'physics': [{'name': 'rigidbody_bone', 'mass': 1}]}, open(os.path.join(G, 'data', 'physics.json'), 'w'))
open(os.path.join(G, 'mesh', 'goatchan.mesh'), 'wb').write(b'\x00MESH' * 100)
open(os.path.join(G, 'data', 'readme.txt'), 'w').write('test asset')

bpy.ops.wm.save_as_mainfile(filepath=os.path.join(G, 'goatchan.blend'), relative_remap=True)
for img in bpy.data.images:
    print('IMG', img.name, img.filepath)
bpy.ops.export_scene.gltf(filepath=os.path.join(out, 'goatchan.glb'), export_format='GLB', export_animations=True)
print('done', json.dumps(truth, ensure_ascii=False))
