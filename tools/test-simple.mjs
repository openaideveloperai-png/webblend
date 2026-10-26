import { isSimplePrompt } from '../src/anim/ai.js';
for (const p of ['walk', 'make him run fast for 3 seconds', 'jump then wave', 'walk and wave with the left hand', 'perform an elaborate interpretive dance about the ocean', 'do a cheerful little hop while raising both arms like you won something', 'bounce', 'make everything bounce', 'spin slowly on the x axis', 'dance like crazy', 'sneak up on someone', 'nod twice'])
  console.log(isSimplePrompt(p) ? 'offline' : 'CLAUDE ', p);
