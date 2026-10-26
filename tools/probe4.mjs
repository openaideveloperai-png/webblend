import fs from 'fs';
import { BlendFile, StructView } from '../src/io/blend/blendfile.js';
const bf = new BlendFile(fs.readFileSync(process.argv[2]));
for (const b of bf.idBlocks('OB')) { const ob = bf.view(b);
  for (const mod of bf.listBase(ob.get('modifiers'), 'ModifierData')) {
    const mm = new StructView(bf, mod.offset, bf.structDef('MirrorModifierData'), mod.scope);
    console.log(ob.idName(), mod.str('name'), 'type', mod.get('type'), 'mode', mod.get('mode'), 'flag', mm.get('flag'), 'axis', mm.get('axis'), 'tol', mm.get('tolerance'));
  }}
