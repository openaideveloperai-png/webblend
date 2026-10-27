// Archives with many models (a mod .jar, an asset pack): list everything found, with
// its folder, and let the user pick what to open.
import { h, icon } from './dom.js';
import { modal } from './toast.js';

const KIND = (e) => (e.mc === 'java' ? (/\/item\//i.test(e.key) ? 'Minecraft item' : /\/block\//i.test(e.key) ? 'Minecraft block' : 'Minecraft model') : e.mc === 'geo' ? 'Minecraft entity' : e.ext === 'bbmodel' ? 'Blockbench' : e.ext.toUpperCase());

// -> Promise<entries | null>
export function chooseModels(app, entries, sources = []) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    // entities and real models first, then blocks / items, each by folder
    const rank = (e) => (e.mc === 'geo' || e.ext === 'bbmodel' ? 0 : e.mc === 'java' ? 2 : 1);
    const list = entries.slice().sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
    const picked = new Set(list.filter((e) => rank(e) < 2).slice(0, 12));
    if (!picked.size) for (const e of list.slice(0, 6)) picked.add(e);
    const search = h('input', { class: 'inp', type: 'search', placeholder: 'Filter by name or folder…', 'aria-label': 'Filter models', style: { width: '100%' } });
    const rows = h('div', { class: 'picker-list', role: 'listbox', 'aria-multiselectable': 'true' });
    const count = h('span', { class: 'hint' });
    const go = h('button', { class: 'btn primary', id: 'picker-open' });
    const shown = () => { const q = search.value.trim().toLowerCase(); return q ? list.filter((e) => e.key.includes(q) || KIND(e).toLowerCase().includes(q)) : list; };
    function render() {
      const s = shown();
      rows.replaceChildren(...s.slice(0, 400).map((e) => {
        const c = h('input', { type: 'checkbox', checked: picked.has(e) || undefined, onchange: () => { if (c.checked) picked.add(e); else picked.delete(e); update(); } });
        const dir = e.path.replace(/\\/g, '/').split('/').slice(0, -1).join('/');
        return h('label', { class: 'picker-row', title: e.path }, c, h('span', { class: 'picker-name' }, e.name), h('span', { class: 'picker-kind' }, KIND(e)), h('span', { class: 'picker-dir' }, dir || '/'));
      }), ...(s.length > 400 ? [h('div', { class: 'hint', style: { padding: '6px 8px' } }, `…and ${s.length - 400} more: type to narrow it down`)] : []));
      update();
    }
    function update() {
      count.textContent = `${picked.size} of ${list.length} selected`;
      go.replaceChildren(icon('upload'), ` Open ${picked.size || ''}`.trimEnd());
      go.disabled = !picked.size;
    }
    search.addEventListener('input', render);
    go.addEventListener('click', () => finish(list.filter((e) => picked.has(e))));
    const body = h('div', { class: 'sec' },
      h('p', { class: 'hint', style: { margin: '0 0 8px' } }, `Every model in ${sources.length ? sources.join(', ') : 'what you dropped'}, including nested archives and hidden folders.`),
      search,
      h('div', { class: 'btns', style: { margin: '8px 0' } },
        h('button', { class: 'btn ghost', onclick: () => { for (const e of shown()) picked.add(e); render(); } }, 'Select all shown'),
        h('button', { class: 'btn ghost', onclick: () => { picked.clear(); render(); } }, 'None'), count),
      rows,
      h('div', { class: 'btns', style: { justifyContent: 'flex-end', marginTop: '10px' } }, h('button', { class: 'btn ghost', onclick: () => finish(null) }, 'Cancel'), go));
    const m = modal(`Found ${list.length} models`, body, { width: 680, onClose: () => { if (!done) { done = true; resolve(null); } } });
    render();
    setTimeout(() => search.focus(), 40);
  });
}
