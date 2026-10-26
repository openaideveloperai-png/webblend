import fs from 'fs';
import { BlendFile } from '../src/io/blend/blendfile.js';
const [,, file, ...structs] = process.argv;
const bf = new BlendFile(fs.readFileSync(file));
console.log('version', bf.version, 'ptr', bf.pointerSize, 'LE', bf.littleEndian, 'fmt', bf.fileFormat, 'blocks', bf.blocks.length);
const codes = {}; for (const b of bf.blocks) codes[b.code] = (codes[b.code]||0)+1;
console.log(JSON.stringify(codes));
for (const s of structs) {
  const d = bf.structDef(s);
  if (!d) { console.log('NO STRUCT', s); continue; }
  console.log(`struct ${s} size=${d.size}: ` + d.fields.map(f => `${f.type} ${f.rawName}@${f.offset}`).join(', '));
}
