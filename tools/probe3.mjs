import fs from 'fs';
import { BlendFile } from '../src/io/blend/blendfile.js';
const bf = new BlendFile(fs.readFileSync(process.argv[2]));
console.log('version', bf.version);
for (const b of bf.idBlocks('ME')) {
  const me = bf.view(b);
  console.log('MESH', me.idName(), 'dvert ptr', me.ptr('dvert').toString(16), 'dvert block', !!me.block('dvert'));
  for (const cdn of ['vdata']) { const cd = me.get(cdn); const n = cd.get('totlayer'); const lb = cd.block('layers');
    for (let i=0;i<n;i++){ const L = bf.view(lb,i,bf.structDef('CustomDataLayer')); console.log('  vdata layer', L.str('name'), L.get('type')); } }
  if (me.has('attribute_storage')) { const as = me.get('attribute_storage'); const ab = as.block('dna_attributes'); const n = as.get('dna_attributes_num');
    for (let i=0;i<n;i++){ const A = bf.view(ab,i,bf.structDef('Attribute')); console.log('  attr', bf.stringAt(A.ptr('name'), A.scope), A.get('data_type'), A.get('domain'), A.get('storage_type')); } }
  console.log('  vgroup names', [...bf.listBase(me.get('vertex_group_names'), 'bDeformGroup')].map(g=>g.str('name')));
}
for (const b of bf.idBlocks('OB')) {
  const ob = bf.view(b);
  const adt = ob.deref('adt', 'AnimData');
  console.log('OB', ob.idName(), 'type', ob.get('type'), 'parent', ob.deref('parent')?.idName(), 'partype', ob.get('partype'), 'parsubstr', ob.str('parsubstr'), 'rotmode', ob.get('rotmode'), 'loc', ob.get('loc'), 'adt', !!adt, adt ? ('action ' + adt.deref('action')?.idName() + ' slot ' + adt.any(['slot_handle','binding_handle'])) : '');
  const mods = [...bf.listBase(ob.get('modifiers'), 'ModifierData')].map(m => m.str('name') + ':' + m.get('type'));
  console.log('   mods', mods.join(','));
  const pose = ob.deref('pose', 'bPose');
  if (pose) for (const pc of bf.listBase(pose.get('chanbase'), 'bPoseChannel')) console.log('   pchan', pc.str('name'), 'rotmode', pc.get('rotmode'), 'eul', pc.get('eul'));
}
for (const b of bf.idBlocks('AC')) {
  const ac = bf.view(b);
  console.log('ACTION', ac.idName(), 'layers', ac.get('layer_array_num'), 'slots', ac.any(['slot_array_num','binding_array_num']), 'curves listbase first', ac.get('curves').ptr('first').toString(16));
  for (const fc of bf.listBase(ac.get('curves'), 'FCurve')) console.log('   legacy fcurve', bf.stringAt(fc.ptr('rna_path'), fc.scope), fc.get('array_index'), fc.get('totvert'));
  const nL = ac.get('layer_array_num') || 0;
  const layers = bf.pointerArray(ac.ptr('layer_array'), nL, ac.scope);
  for (const lp of layers) { const L = bf.viewAtPtr(lp, 'ActionLayer', ac.scope); const sn = L.get('strip_array_num');
    for (const sp of bf.pointerArray(L.ptr('strip_array'), sn, L.scope)) { const S = bf.viewAtPtr(sp, 'ActionStrip', L.scope); console.log('   strip type', S.get('strip_type'), 'data_index', S.get('data_index')); } }
  const kds = bf.pointerArray(ac.ptr('strip_keyframe_data_array'), ac.get('strip_keyframe_data_array_num') || 0, ac.scope);
  for (const kp of kds) { const K = bf.viewAtPtr(kp, 'ActionStripKeyframeData', ac.scope);
    for (const cp of bf.pointerArray(K.ptr('channelbag_array'), K.get('channelbag_array_num'), K.scope)) { const C = bf.viewAtPtr(cp, 'ActionChannelBag', K.scope);
      console.log('   channelbag slot', C.get('slot_handle'), 'fcurves', C.get('fcurve_array_num'));
      for (const fp of bf.pointerArray(C.ptr('fcurve_array'), C.get('fcurve_array_num'), C.scope)) { const fc = bf.viewAtPtr(fp, 'FCurve', C.scope);
        const bz = fc.block('bezt'); console.log('     fcurve', bf.stringAt(fc.ptr('rna_path'), fc.scope), fc.get('array_index'), 'keys', fc.get('totvert'), 'first', bz ? bf.view(bz,0,bf.structDef('BezTriple')).get('vec').slice(3,5) : null); } } }
  const slots = bf.pointerArray(ac.ptr('slot_array'), ac.get('slot_array_num') || 0, ac.scope);
  for (const sp of slots) { const S = bf.viewAtPtr(sp, 'ActionSlot', ac.scope); console.log('   slot', S.str('name'), S.get('handle'), S.get('idtype')); }
}
const sc = bf.view(bf.idBlocks('SC')[0]); const r = sc.get('r'); console.log('fps', r.get('frs_sec'), r.get('frs_sec_base'));
