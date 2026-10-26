import fs from 'fs';
import { BlendFile } from '../src/io/blend/blendfile.js';
const bf = new BlendFile(fs.readFileSync(process.argv[2]));
for (const s of ['AttributeArray','AttributeSingle']) { const d = bf.structDef(s); if (d) console.log(`struct ${s} size=${d.size}: ` + d.fields.map(f => `${f.type} ${f.rawName}@${f.offset}`).join(', ')); }
for (const b of bf.idBlocks('ME')) {
  const me = bf.view(b);
  console.log('MESH', me.idName(), 'v', me.get('totvert'), 'e', me.get('totedge'), 'p', me.get('totpoly'), 'l', me.get('totloop'), 'polyoff', me.ptr('poly_offset_indices') ? 'yes':'no', 'totcol', me.get('totcol'));
  for (const cdn of ['vdata','edata','pdata','ldata']) {
    const cd = me.get(cdn); const n = cd.get('totlayer');
    const lp = cd.ptr('layers');
    const layers = [];
    for (let i = 0; i < n; i++) {
      const def = bf.structDef('CustomDataLayer');
      const blk = bf.blockAt(lp);
      const L = bf.view(blk, i, def);
      const db = bf.blockAt(L.ptr('data'));
      layers.push(`${L.str('name')||'?'}:t${L.get('type')}:${db?db.size+'B/sdna'+bf.sdna.structs[db.sdna]?.name:'nodata'}`);
    }
    console.log('  ', cdn, n, layers.join(' | '));
  }
  if (me.has('attribute_storage')) {
    const as = me.get('attribute_storage'); const n = as.get('dna_attributes_num');
    const ab = bf.blockAt(as.ptr('dna_attributes'));
    const out=[];
    for (let i = 0; i < n; i++) {
      const A = bf.view(ab, i, bf.structDef('Attribute'));
      const nameB = bf.blockAt(A.ptr('name'));
      const name = nameB ? bf.readCString(nameB.offset, nameB.size) : '?';
      const db = bf.blockAt(A.ptr('data'));
      out.push(`${name}:dt${A.get('data_type')}:dom${A.get('domain')}:st${A.get('storage_type')}:${db?db.size+'B/'+bf.sdna.structs[db.sdna]?.name:'none'}`);
    }
    console.log('   attrs', n, out.join(' | '));
  }
}
