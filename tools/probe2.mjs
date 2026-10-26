import fs from 'fs';
import { BlendFile } from '../src/io/blend/blendfile.js';
const bf = new BlendFile(fs.readFileSync(process.argv[2]));
for (const b of bf.idBlocks('ME')) {
  const me = bf.view(b);
  const as = me.get('attribute_storage');
  const ab = bf.blockAt(as.ptr('dna_attributes'));
  console.log(me.idName(), 'num', as.get('dna_attributes_num'), 'block size', ab.size, 'count', ab.count, 'sdna', bf.sdna.structs[ab.sdna].name);
}
// find all blocks named material_index strings
for (const b of bf.blocks) { if (b.code==='DATA' && b.size<40) { const s = bf.readCString(b.offset, b.size); if (s==='material_index') console.log('found string block', b.oldPtr.toString(16)); } }
