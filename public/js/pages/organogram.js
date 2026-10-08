// Organogram: a drag-and-drop chart of who reports to whom, and of departments.
// Drag a person (from the list on the left, or a card on the chart) onto someone to make them their
// line manager. Drag the background to move around, scroll or use the buttons to zoom.
import { api } from '../api.js';
import { S, can, loadLookups, navigate } from '../state.js';
import {
  h, clear, icon, pageHead, avatar, seg, modal, toast, errorToast, colorFor, initials, buildForm,
} from '../ui.js';

const W = 220; // card width
const H = 88; // card height
const HGAP = 26;
const VGAP = 64;
const STACK_GAP = 12;
const INDENT = 34;

export default async function organogram(view, params, query) {
  const editable = can('employees.edit');
  let mode = query.mode === 'departments' ? 'departments' : 'people';
  let data = await api.get('/api/organogram');
  const collapsed = new Set();
  let zoom = 1;
  let pan = { x: 40, y: 40 };
  let deptFilter = '';
  let search = '';
  let positions = new Map();

  /* ---------------------------------------------------------------- layout of the page */
  const stage = h('div', { class: 'org-stage' });
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'org-lines');
  stage.append(svg);
  const rootDrop = h('div', { class: 'org-root-drop' }, icon('up', 16), 'Drop here to put at the top (no manager)');
  const hint = h('div', { class: 'org-hint hide-sm' }, editable ? 'Drag a person onto their new manager · drag the background to move · scroll to zoom' : 'Drag the background to move · scroll to zoom');
  const detail = h('div', { class: 'org-detail hidden' });
  const canvas = h('div', { class: 'org-canvas', tabindex: '0', 'aria-label': 'Organization chart' }, stage, rootDrop, detail, hint,
    h('div', { class: 'org-controls no-print' },
      h('button', { title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => zoomBy(1.2) }, icon('zoomIn', 18)),
      h('button', { title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => zoomBy(1 / 1.2) }, icon('zoomOut', 18)),
      h('button', { title: 'Fit to screen', 'aria-label': 'Fit to screen', onclick: fit }, icon('fit', 18))));
  const trayList = h('div', { class: 'org-tray-list' });
  const traySearch = h('input', { class: 'input sm', placeholder: 'Find a person…', oninput: (e) => { search = e.target.value.trim().toLowerCase(); drawTray(); draw(); } });
  traySearch.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const p = matches()[0]; if (p) centerOn(p.id, true); } });
  const tray = h('aside', { class: 'org-tray' },
    h('div', { class: 'org-tray-head' }, h('div', { class: 'strong' }, 'People'), traySearch,
      h('div', { class: 'tiny muted' }, editable ? 'Drag a name onto a card to set their line manager.' : 'Click a name to find it on the chart.')),
    trayList);
  const page = h('div', { class: ['org-page', !editable && 'no-side'] }, editable ? tray : null, canvas);

  const deptSel = h('select', { class: 'input sm', style: { width: '200px' }, onchange: (e) => { deptFilter = e.target.value; draw(); } },
    h('option', { value: '' }, 'All departments'), data.departments.map((d) => h('option', { value: d.id }, d.name)));
  view.append(pageHead('Organogram', {
    sub: mode === 'people' ? 'Who reports to whom. Your changes save straight away.' : 'How departments sit inside each other, and who heads them.',
    actions: [
      seg([['people', 'Reporting lines'], ['departments', 'Departments']], mode, (m) => { mode = m; collapsed.clear(); hideDetail(); drawTray(); draw(); setTimeout(fit, 0); }),
      deptSel,
      h('button', { class: 'btn', onclick: () => { collapsed.clear(); draw(); } }, 'Expand all'),
      h('button', { class: 'btn', onclick: () => window.print() }, icon('printer', 16), 'Print'),
    ],
  }));
  view.append(page);

  /* ---------------------------------------------------------------- data → trees */
  const people = () => data.people;
  const byId = () => new Map(data.people.map((p) => [p.id, p]));

  function items() {
    if (mode === 'people') {
      return data.people.map((p) => ({ id: p.id, parent: p.manager_id, p }));
    }
    const counts = new Map();
    data.people.forEach((p) => counts.set(p.department_id, (counts.get(p.department_id) || 0) + 1));
    return data.departments.map((d) => ({ id: d.id, parent: d.parent_id, d: { ...d, count: counts.get(d.id) || 0 } }));
  }

  function buildTrees() {
    const list = items();
    const ids = new Set(list.map((x) => x.id));
    const nodes = new Map(list.map((x) => [x.id, { ...x, children: [] }]));
    const roots = [];
    for (const n of nodes.values()) {
      if (n.parent && ids.has(n.parent) && n.parent !== n.id) nodes.get(n.parent).children.push(n);
      else roots.push(n);
    }
    const name = (n) => (n.p ? n.p.name : n.d.name);
    const sortRec = (n) => { n.children.sort((a, b) => b.children.length - a.children.length || name(a).localeCompare(name(b))); n.children.forEach(sortRec); };
    roots.sort((a, b) => countAll(b) - countAll(a) || name(a).localeCompare(name(b)));
    roots.forEach(sortRec);
    return { roots, nodes };
  }
  function countAll(n) { return n.children.reduce((a, c) => a + 1 + countAll(c), 0); }

  /* ---------------------------------------------------------------- tidy layout */
  function measure(n) {
    const kids = collapsed.has(n.id) ? [] : n.children;
    n.vis = kids;
    n.compact = false;
    if (!kids.length) { n.w = W; n.h = H; return; }
    kids.forEach(measure);
    if (kids.length >= 3 && kids.every((k) => !k.vis.length)) {
      n.compact = true;
      n.w = W + INDENT;
      n.h = H + 24 + kids.length * (H + STACK_GAP);
      return;
    }
    const total = kids.reduce((a, k) => a + k.w, 0) + HGAP * (kids.length - 1);
    n.w = Math.max(W, total);
    n.h = H + VGAP + Math.max(...kids.map((k) => k.h));
  }
  function place(n, x, y, out) {
    if (n.compact) {
      n.x = x + (n.w - W - INDENT) / 2; n.y = y;
      out.set(n.id, n);
      n.vis.forEach((k, i) => { k.x = n.x + INDENT; k.y = y + H + 24 + i * (H + STACK_GAP); k.vis = []; out.set(k.id, k); });
      return;
    }
    n.x = x + (n.w - W) / 2; n.y = y;
    out.set(n.id, n);
    if (!n.vis.length) return;
    const total = n.vis.reduce((a, k) => a + k.w, 0) + HGAP * (n.vis.length - 1);
    let cx = x + (n.w - total) / 2;
    for (const k of n.vis) { place(k, cx, y + H + VGAP, out); cx += k.w + HGAP; }
  }

  /* ---------------------------------------------------------------- drawing */
  function matches() {
    if (!search) return [];
    return people().filter((p) => `${p.name} ${p.emp_code} ${p.designation || ''}`.toLowerCase().includes(search));
  }

  function draw() {
    const { roots } = buildTrees();
    positions = new Map();
    let x = 0;
    let maxH = 0;
    for (const r of roots) { measure(r); place(r, x, 0, positions); x += r.w + HGAP * 2; maxH = Math.max(maxH, r.h); }
    const width = Math.max(W, x - HGAP * 2);
    stage.querySelectorAll('.org-node').forEach((n) => n.remove());
    svg.setAttribute('width', width + 40);
    svg.setAttribute('height', maxH + 40);
    const paths = [];
    const hits = new Set(matches().map((p) => p.id));
    for (const n of positions.values()) {
      for (const k of n.vis || []) {
        if (n.compact) {
          const lx = n.x + 16;
          paths.push(`M${lx},${n.y + H} V${k.y + H / 2} H${k.x}`);
        } else {
          const px = n.x + W / 2; const cx = k.x + W / 2; const my = n.y + H + VGAP / 2;
          paths.push(`M${px},${n.y + H} V${my} H${cx} V${k.y}`);
        }
      }
      stage.append(mode === 'people' ? personCard(n, hits) : deptCard(n));
    }
    svg.innerHTML = paths.map((d) => `<path d="${d}"/>`).join('');
    if (!positions.size) {
      stage.append(h('div', { class: 'org-node', style: { left: '0px', top: '0px', width: '320px', height: 'auto' } },
        h('div', { class: 'strong' }, mode === 'people' ? 'No one on the chart yet' : 'No departments yet'),
        h('div', { class: 'small muted' }, mode === 'people' ? 'Add employees first.' : 'Add departments under Settings.')));
    }
    applyTransform();
  }

  function personCard(n, hits) {
    const p = n.p;
    const dim = (deptFilter && String(p.department_id) !== deptFilter) || (search && !hits.has(p.id));
    const isSelf = S.me.employee && S.me.employee.id === p.id;
    const kids = n.children.length;
    const el = h('div', {
      class: ['org-node', isSelf && 'self', hits.has(p.id) && search && 'highlight'],
      style: { left: `${n.x}px`, top: `${n.y}px`, height: `${H}px`, opacity: dim ? '.32' : '1' },
      dataset: { id: p.id },
    },
    h('div', { class: 'bar', style: { background: p.department_color || colorFor(p.department || 'none') } }),
    h('div', { class: 'row', style: { gap: '10px' } },
      avatar(p.name, { size: 'sm', photo: p.photo }),
      h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'nm' }, p.name), h('div', { class: 'ds' }, p.designation || 'No designation'))),
    h('div', { class: 'ft' },
      h('span', { class: 'ellipsis', style: { maxWidth: '120px' } }, p.department || 'No department'),
      kids ? h('button', {
        class: 'toggle', type: 'button', title: collapsed.has(p.id) ? 'Show team' : 'Hide team',
        onpointerdown: (e) => e.stopPropagation(),
        onclick: (e) => { e.stopPropagation(); if (collapsed.has(p.id)) collapsed.delete(p.id); else collapsed.add(p.id); draw(); },
      }, collapsed.has(p.id) ? icon('down', 11) : icon('up', 11), String(countAll(n))) : null));
    el.addEventListener('pointerdown', (e) => startPointer(e, { kind: 'person', id: p.id, el }));
    return el;
  }

  function deptCard(n) {
    const d = n.d;
    const head = d.head_employee_id ? byId().get(d.head_employee_id) : null;
    const dim = deptFilter && String(d.id) !== deptFilter;
    const el = h('div', { class: 'org-node', style: { left: `${n.x}px`, top: `${n.y}px`, height: `${H}px`, opacity: dim ? '.32' : '1' }, dataset: { id: d.id } },
      h('div', { class: 'bar', style: { background: d.color || colorFor(d.name) } }),
      h('div', { class: 'row', style: { gap: '10px' } },
        h('span', { class: 'avatar sm', style: { background: d.color || colorFor(d.name), borderRadius: '8px' } }, initials(d.name)),
        h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'nm' }, d.name), h('div', { class: 'ds' }, head ? `Head: ${head.name}` : 'No head yet'))),
      h('div', { class: 'ft' }, icon('users', 12), `${d.count} ${d.count === 1 ? 'person' : 'people'}`,
        n.children.length ? h('button', {
          class: 'toggle', type: 'button', onpointerdown: (e) => e.stopPropagation(),
          onclick: (e) => { e.stopPropagation(); if (collapsed.has(d.id)) collapsed.delete(d.id); else collapsed.add(d.id); draw(); },
        }, collapsed.has(d.id) ? icon('down', 11) : icon('up', 11), String(countAll(n))) : null));
    el.addEventListener('pointerdown', (e) => startPointer(e, { kind: 'dept', id: d.id, el }));
    return el;
  }

  function drawTray() {
    if (!editable) return;
    const placed = new Set(people().filter((p) => p.manager_id).map((p) => p.id));
    let list = people();
    if (search) list = matches();
    if (mode === 'departments') list = list.slice();
    clear(trayList, list.length ? list.map((p) => {
      const el = h('div', { class: 'tray-item', title: 'Drag onto their new manager · double-click to find on the chart' },
        icon('grip', 14, 'style="opacity:.4"'), avatar(p.name, { size: 'sm', photo: p.photo }),
        h('div', { class: 'grow', style: { minWidth: 0 } }, h('div', { class: 'small strong ellipsis' }, p.name), h('div', { class: 'tiny muted ellipsis' }, p.designation || p.emp_code)),
        placed.has(p.id) ? null : h('span', { class: 'top-tag', title: 'No line manager: at the top of the chart' }, 'Top'));
      el.addEventListener('pointerdown', (e) => startPointer(e, { kind: 'person', id: p.id, el, fromTray: true }));
      el.addEventListener('dblclick', () => centerOn(p.id, true));
      return el;
    }) : h('div', { class: 'small muted', style: { padding: '8px' } }, 'No one found.'));
  }

  /* ---------------------------------------------------------------- pan & zoom */
  function applyTransform() { stage.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`; }
  function zoomBy(f, cx = canvas.clientWidth / 2, cy = canvas.clientHeight / 2) {
    const nz = Math.min(2, Math.max(0.2, zoom * f));
    pan.x = cx - ((cx - pan.x) * nz) / zoom;
    pan.y = cy - ((cy - pan.y) * nz) / zoom;
    zoom = nz;
    applyTransform();
  }
  /** First view: readable cards, the top of the chart centred. */
  function initialView() {
    fit();
    if (zoom >= 0.75 || !positions.size) return;
    const roots = [...positions.values()].filter((n) => n.y === 0);
    const first = roots.sort((a, b) => a.x - b.x)[0];
    zoom = 0.8;
    pan.x = canvas.clientWidth / 2 - (first.x + W / 2) * zoom;
    pan.y = 40;
    applyTransform();
  }
  function fit() {
    if (!positions.size) return;
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const n of positions.values()) { minX = Math.min(minX, n.x); minY = Math.min(minY, n.y); maxX = Math.max(maxX, n.x + W); maxY = Math.max(maxY, n.y + H); }
    const cw = canvas.clientWidth || 800; const ch = canvas.clientHeight || 600;
    zoom = Math.max(0.2, Math.min(1, (cw - 80) / (maxX - minX), (ch - 100) / (maxY - minY)));
    pan.x = (cw - (maxX - minX) * zoom) / 2 - minX * zoom;
    pan.y = Math.max(30, (ch - (maxY - minY) * zoom) / 2) - minY * zoom;
    applyTransform();
  }
  function centerOn(id, flash = false) {
    // open collapsed managers so the person is visible
    if (mode === 'people') {
      let cur = byId().get(id);
      while (cur && cur.manager_id) { collapsed.delete(cur.manager_id); cur = byId().get(cur.manager_id); }
      draw();
    }
    const n = positions.get(id);
    if (!n) return;
    zoom = Math.max(zoom, 0.8);
    pan.x = canvas.clientWidth / 2 - (n.x + W / 2) * zoom;
    pan.y = canvas.clientHeight / 3 - (n.y + H / 2) * zoom;
    applyTransform();
    if (flash) {
      const el = stage.querySelector(`.org-node[data-id="${id}"]`);
      if (el) { el.classList.remove('highlight'); void el.offsetWidth; el.classList.add('highlight'); }
    }
  }
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1, e.clientX - r.left, e.clientY - r.top);
    else { pan.x -= e.deltaX; applyTransform(); }
  }, { passive: false });
  canvas.addEventListener('keydown', (e) => {
    const step = 60;
    if (e.key === '+' || e.key === '=') zoomBy(1.2);
    else if (e.key === '-') zoomBy(1 / 1.2);
    else if (e.key === 'ArrowLeft') { pan.x += step; applyTransform(); }
    else if (e.key === 'ArrowRight') { pan.x -= step; applyTransform(); }
    else if (e.key === 'ArrowUp') { pan.y += step; applyTransform(); }
    else if (e.key === 'ArrowDown') { pan.y -= step; applyTransform(); }
    else if (e.key === '0') fit();
    else return;
    e.preventDefault();
  });
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.org-node, .org-controls, .org-detail, button')) return;
    hideDetail();
    const start = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    canvas.classList.add('panning');
    canvas.setPointerCapture(e.pointerId);
    const move = (ev) => { pan.x = start.px + ev.clientX - start.x; pan.y = start.py + ev.clientY - start.y; applyTransform(); };
    const up = () => { canvas.classList.remove('panning'); canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up); };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
  });

  /* ---------------------------------------------------------------- drag and drop */
  function descendantsOf(id) {
    const out = new Set();
    const list = items();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const x of list) if (x.parent === cur && !out.has(x.id)) { out.add(x.id); stack.push(x.id); }
    }
    return out;
  }

  function startPointer(e, src) {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (e.pointerType !== 'touch') e.preventDefault(); // no text selection or native drag while dragging a person
    const start = { x: e.clientX, y: e.clientY };
    let dragging = false;
    let ghost = null;
    let target = null;
    let longPress = null;
    const draggable = editable && (src.kind === 'person' || mode === 'departments');
    const forbidden = src.kind === 'person' && mode === 'people' ? descendantsOf(src.id) : src.kind === 'dept' ? descendantsOf(src.id) : new Set();

    const begin = () => {
      dragging = true;
      ghost = src.el.cloneNode(true);
      ghost.classList.add('org-ghost');
      ghost.classList.remove('highlight');
      ghost.style.left = '0px'; ghost.style.top = '0px'; ghost.style.opacity = '1';
      if (src.fromTray) Object.assign(ghost.style, { background: 'var(--panel)', border: '1px solid var(--brand)', borderRadius: '12px', padding: '8px 10px' });
      document.body.append(ghost);
      src.el.classList.add('dragging');
      if (src.kind === 'person' && mode === 'people') rootDrop.classList.add('show');
      if (src.kind === 'dept') { rootDrop.classList.add('show'); rootDrop.lastChild.textContent = 'Drop here to make it a top-level department'; }
      moveGhost(e.clientX, e.clientY);
    };
    const moveGhost = (x, y) => { ghost.style.transform = `translate(${x + 12}px, ${y + 8}px) rotate(-2deg)`; };
    const findTarget = (x, y) => {
      const under = document.elementFromPoint(x, y);
      if (!under) return null;
      if (under.closest('.org-root-drop')) return 'root';
      const node = under.closest('.org-node');
      if (!node || !stage.contains(node)) return null;
      const id = Number(node.dataset.id);
      if (mode === 'people') {
        if (src.kind !== 'person' || id === src.id || forbidden.has(id)) return null;
      } else if (src.kind === 'dept') {
        if (id === src.id || forbidden.has(id)) return null;
      }
      return { id, node };
    };
    const edgeScroll = (x, y) => {
      const r = canvas.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return; // e.g. still over the list
      const m = 40;
      let dx = 0; let dy = 0;
      if (x < r.left + m) dx = 12; else if (x > r.right - m) dx = -12;
      if (y < r.top + m) dy = 12; else if (y > r.bottom - m) dy = -12;
      if (dx || dy) { pan.x += dx; pan.y += dy; applyTransform(); }
    };

    const move = (ev) => {
      const dist = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
      if (!dragging) {
        if (ev.pointerType === 'touch') {
          if (dist > 8) { clearTimeout(longPress); cleanup(); if (!src.fromTray) panFrom(ev); }
          return;
        }
        if (dist > 5 && draggable) begin(); else return;
      }
      ev.preventDefault();
      moveGhost(ev.clientX, ev.clientY);
      edgeScroll(ev.clientX, ev.clientY);
      const t = findTarget(ev.clientX, ev.clientY);
      stage.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      rootDrop.classList.toggle('over', t === 'root');
      if (t && t !== 'root') t.node.classList.add('drop-target');
      target = t;
    };
    const up = async (ev) => {
      clearTimeout(longPress);
      const wasDragging = dragging;
      cleanup();
      if (!wasDragging) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) {
          if (src.fromTray) centerOn(src.id, true); else showDetail(src);
        }
        return;
      }
      if (!target) return;
      await drop(src, target === 'root' ? null : target.id);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      if (ghost) ghost.remove();
      src.el.classList.remove('dragging');
      stage.querySelectorAll('.drop-target').forEach((n) => n.classList.remove('drop-target'));
      rootDrop.classList.remove('show', 'over');
      rootDrop.lastChild.textContent = 'Drop here to put at the top (no manager)';
    };
    const cancel = () => { clearTimeout(longPress); cleanup(); };
    const panFrom = (ev) => {
      // a touch that moves quickly on a card pans the chart instead
      const s = { x: ev.clientX, y: ev.clientY, px: pan.x, py: pan.y };
      const mv = (x) => { pan.x = s.px + x.clientX - s.x; pan.y = s.py + x.clientY - s.y; applyTransform(); };
      const end = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', end); };
      window.addEventListener('pointermove', mv);
      window.addEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    if (e.pointerType === 'touch' && draggable) longPress = setTimeout(() => { if (navigator.vibrate) navigator.vibrate(15); begin(); }, 380);
  }

  async function drop(src, targetId) {
    const people = byId();
    if (mode === 'people') {
      const p = people.get(src.id);
      const mgr = targetId ? people.get(targetId) : null;
      if ((p.manager_id || null) === (targetId || null)) return;
      const sameDept = !mgr || !mgr.department_id || mgr.department_id === p.department_id;
      const form = buildForm(sameDept ? [] : [{ name: 'move_dept', label: `Also move ${p.name} to ${mgr.department}`, type: 'checkbox', default: true }], {}, { one: true });
      const ok = await askMove(mgr ? `Make ${p.name} report to ${mgr.name}?` : `Put ${p.name} at the top of the chart?`,
        h('div', null, h('div', { class: 'row gap-12 mb-16' }, avatar(p.name, { photo: p.photo }), icon('right', 18), mgr ? avatar(mgr.name, { photo: mgr.photo }) : h('span', { class: 'badge' }, 'Top level')),
          h('p', { class: 'muted small' }, p.manager_id ? `Today ${p.name} reports to ${people.get(p.manager_id) ? people.get(p.manager_id).name : 'someone else'}. ${mgr ? `${mgr.name} will approve their leave from now on.` : ''}` : (mgr ? `${mgr.name} will approve their leave from now on.` : '')),
          form.el));
      if (!ok) return;
      const body = { manager_id: targetId };
      if (!sameDept && form.values().move_dept) body.department_id = mgr.department_id;
      try {
        await api.put(`/api/organogram/${p.id}/manager`, body);
        toast(mgr ? `${p.name} now reports to ${mgr.name}` : `${p.name} is now at the top`);
        await refresh();
        centerOn(p.id, true);
      } catch (err) { errorToast(err); }
      return;
    }
    // departments chart
    const depts = new Map(data.departments.map((d) => [d.id, d]));
    if (src.kind === 'dept') {
      const d = depts.get(src.id);
      const parent = targetId ? depts.get(targetId) : null;
      if ((d.parent_id || null) === (targetId || null)) return;
      if (!(await askMove(parent ? `Put ${d.name} inside ${parent.name}?` : `Make ${d.name} a top-level department?`, null))) return;
      try { await api.put(`/api/organogram/departments/${d.id}`, { parent_id: targetId }); toast('Department moved'); await refresh(); } catch (err) { errorToast(err); }
    } else if (src.kind === 'person' && targetId) {
      const p = people.get(src.id);
      const d = depts.get(targetId);
      if (!(await askMove(`Make ${p.name} the head of ${d.name}?`, h('p', { class: 'muted small' }, 'This sets the department head. Their own department stays as it is.')))) return;
      try { await api.put(`/api/organogram/departments/${d.id}`, { head_employee_id: p.id }); toast(`${p.name} heads ${d.name}`); await refresh(); } catch (err) { errorToast(err); }
    }
  }

  function askMove(title, body) {
    return new Promise((resolve) => {
      let done = false;
      const m = modal({
        title, size: 'sm', body: body || h('div'),
        actions: [h('button', { class: 'btn', onclick: () => { done = true; m.close(); resolve(false); } }, 'Cancel'),
          h('button', { class: 'btn primary', onclick: () => { done = true; m.close(); resolve(true); } }, 'Move')],
        onClose: () => { if (!done) resolve(false); },
      });
    });
  }

  async function refresh() {
    data = await api.get('/api/organogram');
    loadLookups(true).catch(() => {});
    drawTray();
    draw();
  }

  /* ---------------------------------------------------------------- details */
  function hideDetail() { detail.classList.add('hidden'); }
  function showDetail(src) {
    if (mode === 'people') {
      const p = byId().get(src.id);
      const mgr = p.manager_id ? byId().get(p.manager_id) : null;
      const team = data.people.filter((x) => x.manager_id === p.id);
      clear(detail, h('div', { class: 'card', style: { boxShadow: 'var(--shadow-lg)' } },
        h('div', { class: 'card-body' },
          h('div', { class: 'row gap-12' }, avatar(p.name, { size: 'lg', photo: p.photo }), h('div', { class: 'grow' }, h('h3', null, p.name), h('div', { class: 'small muted' }, p.designation || '—'), h('div', { class: 'tiny muted' }, p.emp_code)),
            h('button', { class: 'icon-btn', onclick: hideDetail, 'aria-label': 'Close' }, icon('x', 16))),
          h('div', { class: 'small mt-16 col gap-4' },
            h('div', null, h('span', { class: 'muted' }, 'Department: '), p.department || '—'),
            h('div', null, h('span', { class: 'muted' }, 'Reports to: '), mgr ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); centerOn(mgr.id, true); showDetail({ id: mgr.id }); } }, mgr.name) : 'Nobody (top)'),
            h('div', null, h('span', { class: 'muted' }, 'Direct team: '), `${team.length} ${team.length === 1 ? 'person' : 'people'}`)),
          h('div', { class: 'row mt-16' },
            can('employees.view') || (S.me.employee && S.me.employee.id === p.id) ? h('a', { class: 'btn sm', href: `#/employees/${p.id}` }, 'Open profile') : null,
            editable && p.manager_id ? h('button', { class: 'btn sm', onclick: () => drop({ kind: 'person', id: p.id }, null) }, 'Move to top') : null))));
    } else {
      const d = data.departments.find((x) => x.id === src.id);
      const members = data.people.filter((x) => x.department_id === d.id);
      clear(detail, h('div', { class: 'card', style: { boxShadow: 'var(--shadow-lg)' } }, h('div', { class: 'card-body' },
        h('div', { class: 'row' }, h('h3', { class: 'grow' }, d.name), h('button', { class: 'icon-btn', onclick: hideDetail }, icon('x', 16))),
        h('div', { class: 'small muted mb-8' }, `${members.length} ${members.length === 1 ? 'person' : 'people'}`),
        h('div', { class: 'col gap-4', style: { maxHeight: '240px', overflow: 'auto' } }, members.map((m) => h('a', { href: '#', class: 'row small', onclick: (e) => { e.preventDefault(); navigate(`/employees/${m.id}`); } }, avatar(m.name, { size: 'sm', photo: m.photo }), m.name))))));
    }
    detail.classList.remove('hidden');
  }

  drawTray();
  draw();
  requestAnimationFrame(() => {
    initialView();
    if (query.focus) centerOn(Number(query.focus), true);
  });
  window.addEventListener('resize', () => { if (document.body.contains(canvas)) applyTransform(); });
}
