import bpy, sys, os, math
out = sys.argv[sys.argv.index('--')+1]
ver = bpy.app.version_string.split()[0]
os.makedirs(out, exist_ok=True)

def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)

def save(name, compress=False):
    p = os.path.join(out, f"{name}_{ver}{'_z' if compress else ''}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=p, compress=compress)
    print("saved", p)

# A: default cube scene
bpy.ops.wm.read_factory_settings(use_empty=False)
save("default")
save("default", True)

# B: multi objects + materials + packed texture
reset()
def mat(name, rgb):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf: bsdf.inputs["Base Color"].default_value = (*rgb, 1)
    return m
bpy.ops.mesh.primitive_cube_add(location=(0,0,1))
c = bpy.context.object; c.name = "RedCube"; c.data.materials.append(mat("Red", (0.9,0.1,0.1)))
bpy.ops.mesh.primitive_uv_sphere_add(location=(3,0,1), scale=(1,1,1.5))
s = bpy.context.object; s.name = "Sphere"; bpy.ops.object.shade_smooth(); s.data.materials.append(mat("Blue", (0.1,0.2,0.9)))
bpy.ops.object.empty_add(location=(-3,0,0)); e = bpy.context.object; e.name = "Pivot"; e.rotation_euler = (0,0,math.radians(45))
bpy.ops.mesh.primitive_monkey_add(location=(0,0,2)); m = bpy.context.object; m.name = "Suzanne"
m.parent = e; m.rotation_euler = (math.radians(30),0,0)
m.data.materials.append(mat("Green", (0.1,0.8,0.2)))
bpy.ops.mesh.primitive_cylinder_add(vertices=8, location=(0,4,1)); cy = bpy.context.object; cy.name = "Cyl8"  # has n-gon caps
# packed image texture on a plane
img = bpy.data.images.new("Checker", 64, 64)
px = []
for y in range(64):
    for x in range(64):
        v = 1.0 if ((x//8 + y//8) % 2) else 0.0
        px += [v, 0.5*v+0.2, 1-v, 1]
img.pixels = px
img.filepath_raw = os.path.join(out, "checker_tmp.png"); img.file_format = 'PNG'; img.save(); img.pack()
bpy.ops.mesh.primitive_plane_add(size=4, location=(0,-4,0)); pl = bpy.context.object; pl.name = "TexPlane"
tm = bpy.data.materials.new("Tex"); tm.use_nodes = True
nt = tm.node_tree; tex = nt.nodes.new("ShaderNodeTexImage"); tex.image = img
bsdf = nt.nodes.get("Principled BSDF"); nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
pl.data.materials.append(tm)
# multi-material object
bpy.ops.mesh.primitive_cube_add(location=(4,4,1)); mm = bpy.context.object; mm.name = "MultiMat"
mm.data.materials.append(mat("Yellow", (0.9,0.8,0.1))); mm.data.materials.append(mat("Purple", (0.5,0.1,0.8)))
for i,p in enumerate(mm.data.polygons): p.material_index = i % 2
save("multi")
save("multi", True)

# C: rig
reset()
bpy.ops.object.armature_add(location=(0,0,0))
arm = bpy.context.object; arm.name = "Rig"
bpy.ops.object.mode_set(mode='EDIT')
eb = arm.data.edit_bones
b0 = eb[0]; b0.name = "Root"; b0.head = (0,0,0); b0.tail = (0,0,1)
b1 = eb.new("Mid"); b1.head = (0,0,1); b1.tail = (0,0,2); b1.parent = b0; b1.use_connect = True
b2 = eb.new("Tip"); b2.head = (0,0,2); b2.tail = (0,0,3); b2.parent = b1; b2.use_connect = True
bpy.ops.object.mode_set(mode='OBJECT')
bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.3, depth=3, location=(0,0,1.5))
cyl = bpy.context.object; cyl.name = "Tube"
bpy.ops.object.mode_set(mode='EDIT'); bpy.ops.mesh.subdivide(number_cuts=8); bpy.ops.object.mode_set(mode='OBJECT')
cyl.select_set(True); arm.select_set(True); bpy.context.view_layer.objects.active = arm
bpy.ops.object.parent_set(type='ARMATURE_AUTO')
# action
bpy.context.view_layer.objects.active = arm
bpy.ops.object.mode_set(mode='POSE')
for f, ang in [(1,0),(12,40),(24,0)]:
    for bn in ("Mid","Tip"):
        pb = arm.pose.bones[bn]; pb.rotation_mode = 'XYZ'
        pb.rotation_euler = (math.radians(ang),0,0)
        pb.keyframe_insert("rotation_euler", frame=f)
bpy.ops.object.mode_set(mode='OBJECT')
arm.animation_data.action.name = "Bend"
# object-level animation on a cube
bpy.ops.mesh.primitive_cube_add(location=(3,0,0), size=0.5); ac = bpy.context.object; ac.name = "Mover"
ac.location = (3,0,0); ac.keyframe_insert("location", frame=1)
ac.location = (3,0,2); ac.keyframe_insert("location", frame=24)
ac.animation_data.action.name = "MoveUp"
save("rig")
