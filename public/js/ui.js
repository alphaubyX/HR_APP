// Small UI toolkit: element builder, formatting, modals, forms, tables, toasts.
import { icon } from './icons.js';

export { icon };

/* ------------------------------------------------------------------ elements */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = Array.isArray(v) ? v.filter(Boolean).join(' ') : v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false || c === true) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

/* ------------------------------------------------------------------ formatting */
let currency = 'PKR';
export function setCurrency(c) { currency = c || 'PKR'; }
export function money(n, { symbol = false, decimals = null } = {}) {
  const v = Number(n) || 0;
  const d = decimals ?? (Math.round(v) === v ? 0 : 2);
  const s = v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  return symbol ? `${currency} ${s}` : s;
}
export function num(n, d = 2) { const v = Number(n) || 0; return Number.isInteger(v) ? String(v) : v.toFixed(d).replace(/\.?0+$/, ''); }
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export function date(d, { year = true } = {}) {
  if (!d) return '—';
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
  return `${dd} ${MONTHS[m - 1]}${year ? ` ${y}` : ''}`;
}
export function monthLabel(m, long = true) {
  if (!m) return '—';
  const [y, mm] = m.split('-').map(Number);
  return `${(long ? MONTHS_LONG : MONTHS)[mm - 1]} ${y}`;
}
export function time(dt) { return dt ? dt.slice(11, 16) : '—'; }
export function dateTime(dt) { return dt ? `${date(dt)} ${time(dt)}` : '—'; }
/** UTC 'YYYY-MM-DD HH:MM:SS' from the server → the viewer's local time. */
export function utcToLocal(dt) {
  if (!dt) return '—';
  const d = new Date(`${dt.replace(' ', 'T')}Z`);
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
export function ago(dt) {
  if (!dt) return '';
  const s = (Date.now() - new Date(`${dt.replace(' ', 'T')}Z`).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)} d ago`;
  return utcToLocal(dt);
}
export function duration(min) {
  min = Math.round(Number(min) || 0);
  if (!min) return '—';
  const hh = Math.floor(min / 60);
  const mm = min % 60;
  return hh ? `${hh}h ${String(mm).padStart(2, '0')}m` : `${mm}m`;
}
export function weekday(d) { const x = new Date(`${d}T00:00:00Z`).getUTCDay(); return x === 0 ? 7 : x; }
export function addDays(d, n) { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
export function todayLocal() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
export function addMonths(m, n) { const [y, mm] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mm - 1 + n, 1)); return d.toISOString().slice(0, 7); }
export const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
export const sentence = (s) => { s = String(s || '').replace(/_/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1); };

/* ------------------------------------------------------------------ avatars & badges */
const PALETTE = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#db2777', '#7c3aed', '#2563eb', '#dc2626', '#0d9488', '#9333ea'];
export function colorFor(s) { let x = 0; for (const c of String(s)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return PALETTE[x % PALETTE.length]; }
export function initials(name) { return String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join(''); }
export function avatar(name, { photo = null, size = '', id = null } = {}) {
  const el = h('span', { class: ['avatar', size], style: { background: colorFor(name) }, title: name });
  if (photo && typeof photo === 'string') el.append(h('img', { src: photo, alt: '' }));
  else if (photo === true && id) el.append(h('img', { src: `/api/employees/${id}/photo`, alt: '', onerror: (e) => { e.target.remove(); el.textContent = initials(name); } }));
  else el.textContent = initials(name);
  return el;
}
export function person(name, meta, opts = {}) {
  return h('div', { class: 'person' }, avatar(name, opts), h('div', { class: 'who' }, h('div', { class: 'name' }, name), meta ? h('div', { class: 'meta' }, meta) : null));
}
export function badge(text, kind = '', { dot = false, title = null } = {}) {
  return h('span', { class: ['badge', kind, dot && 'dot'], title }, text);
}
const EMP_STATUS = { onboarding: 'info', probation: 'warn', permanent: 'ok', notice: 'violet', exited: '', suspended: 'bad' };
export function empStatus(s) { return badge(sentence(s), EMP_STATUS[s] || '', { dot: true }); }
const REQ_STATUS = { pending: 'warn', approved: 'ok', rejected: 'bad', cancelled: '', draft: '', processed: 'info', paid: 'violet' };
export function reqStatus(s) { return badge(sentence(s), REQ_STATUS[s] || '', { dot: true }); }
export const ATT = {
  present: { code: 'P', label: 'Present' },
  late: { code: 'L', label: 'Late' },
  absent: { code: 'A', label: 'Absent' },
  half_day: { code: 'H', label: 'Half day' },
  half_leave: { code: '½', label: 'Half-day leave' },
  leave: { code: 'LV', label: 'Leave' },
  holiday: { code: 'HO', label: 'Holiday' },
  weekend: { code: 'W', label: 'Weekend' },
  off: { code: 'O', label: 'Off' },
  missing: { code: 'M', label: 'Missing punch' },
  not_employed: { code: '', label: 'Not employed' },
};
export function attKey(d) {
  if (!d) return 'none';
  if (d.status === 'present' && d.late_minutes > 0) return 'late';
  return d.status;
}
export function attBadge(d) {
  const k = attKey(d);
  const a = ATT[k] || { label: k === 'none' ? 'No record' : sentence(k) };
  return h('span', { class: `badge st-${k}` }, a.label);
}

/* ------------------------------------------------------------------ feedback */
let toastBox;
export function toast(message, kind = 'ok') {
  if (!toastBox) { toastBox = h('div', { class: 'toasts', role: 'status' }); document.body.append(toastBox); }
  const t = h('div', { class: ['toast', kind] }, icon(kind === 'bad' ? 'alert' : 'checkCircle', 18), h('span', null, message));
  toastBox.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 300); }, kind === 'bad' ? 5000 : 3000);
}
export function errorToast(err) { toast(err && err.message ? err.message : String(err), 'bad'); }

export function spinner() { return h('div', { class: 'loading' }, h('div', { class: 'spinner' })); }
export function empty(title, text = '', action = null, ic = 'inbox') {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-icon' }, icon(ic, 24)), h('h3', null, title), text ? h('p', null, text) : null, action);
}
export function alertBox(text, kind = '', ic = 'info') { return h('div', { class: ['alert', kind] }, icon(ic, 16), h('div', null, text)); }

/* ------------------------------------------------------------------ modal */
export function modal({ title, body, actions = [], size = '', onClose = null, dismissable = true }) {
  const prevFocus = document.activeElement;
  const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey); if (onClose) onClose(); if (prevFocus && prevFocus.focus) prevFocus.focus(); };
  const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(); };
  const foot = actions.length ? h('div', { class: 'modal-foot' }, actions) : null;
  const box = h('div', { class: ['modal', size], role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'modal-body' }, body), foot);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay && dismissable) close(); } }, box);
  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  setTimeout(() => { const f = box.querySelector('input:not([type=hidden]):not([disabled]), select, textarea'); if (f) f.focus(); }, 30);
  return { close, box, body: box.querySelector('.modal-body'), foot };
}

export function confirmDialog(message, { title = 'Are you sure?', ok = 'Confirm', danger = false, detail = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const m = modal({
      title, size: 'sm',
      body: h('div', null, h('p', null, message), detail ? h('p', { class: 'muted small' }, detail) : null),
      actions: [
        h('button', { class: 'btn', onclick: () => { done = true; m.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: ['btn', danger ? 'danger solid' : 'primary'], onclick: () => { done = true; m.close(); resolve(true); } }, ok),
      ],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

/** Ask for a single text value. */
export function promptDialog(title, { label = '', value = '', placeholder = '', required = true, multiline = false, ok = 'Save' } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const input = multiline ? h('textarea', { class: 'input', placeholder }, value) : h('input', { class: 'input', value, placeholder });
    const submit = () => { const v = input.value.trim(); if (required && !v) { input.classList.add('invalid'); return; } done = true; m.close(); resolve(v); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) submit(); });
    const m = modal({
      title, size: 'sm',
      body: h('div', { class: 'field' }, label ? h('label', null, label) : null, input),
      actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', onclick: submit }, ok)],
      onClose: () => { if (!done) resolve(null); },
    });
  });
}

/* ------------------------------------------------------------------ menu */
export function popMenu(anchor, items) {
  document.querySelectorAll('.menu').forEach((m) => m.remove());
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { menu.append(h('div', { class: 'sep' })); continue; }
    if (it.head) { menu.append(h('div', { class: 'head' }, it.head)); continue; }
    menu.append(h('button', { class: it.danger ? 'danger' : '', role: 'menuitem', onclick: () => { menu.remove(); it.onClick(); } }, it.icon ? icon(it.icon, 16) : null, it.label));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
  menu.style.top = `${r.bottom + mh + 6 > window.innerHeight ? Math.max(8, r.top - mh - 6) : r.bottom + 6}px`;
  setTimeout(() => {
    const off = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('mousedown', off); } };
    document.addEventListener('mousedown', off);
  });
  return menu;
}

/* ------------------------------------------------------------------ forms */
/**
 * fields: [{ name, label, type, options, required, help, placeholder, min, max, step, full, show(values), section }]
 * type: text | email | password | number | money | date | time | month | select | textarea | checkbox | color | days | readonly
 */
export function buildForm(fields, values = {}, { one = false, onChange = null } = {}) {
  const form = h('form', { class: ['form', one && 'one'], novalidate: true, onsubmit: (e) => e.preventDefault() });
  const inputs = {};
  const wraps = {};
  const errs = {};
  const read = () => {
    const out = {};
    for (const f of fields) {
      if (!f.name || !inputs[f.name]) continue;
      const el = inputs[f.name];
      if (f.type === 'checkbox') out[f.name] = el.checked;
      else if (f.type === 'days') out[f.name] = [...el.querySelectorAll('input:checked')].map((x) => x.value).join(',');
      else if (f.type === 'number' || f.type === 'money') out[f.name] = el.value === '' ? null : Number(el.value);
      else if (f.type === 'select' && f.numeric) out[f.name] = el.value === '' ? null : Number(el.value);
      else out[f.name] = el.value;
    }
    return out;
  };
  const refresh = () => {
    const v = read();
    for (const f of fields) {
      if (f.show && wraps[f.key || f.name]) wraps[f.key || f.name].classList.toggle('hidden', !f.show(v));
    }
  };
  for (const f of fields) {
    if (f.section) { const s = h('div', { class: 'form-section' }, f.section); wraps[f.key || f.section] = s; form.append(s); continue; }
    if (f.node) { const w = h('div', { class: ['field', f.full !== false && 'full'] }, f.node); wraps[f.key || 'node'] = w; form.append(w); continue; }
    const v = values[f.name] ?? f.default ?? '';
    let input;
    const id = `f_${f.name}_${Math.random().toString(36).slice(2, 7)}`;
    switch (f.type) {
      case 'select':
        input = h('select', { class: 'input', id, name: f.name },
          f.placeholder !== undefined ? h('option', { value: '' }, f.placeholder) : null,
          (typeof f.options === 'function' ? f.options() : f.options || []).map((o) => {
            const [val, lab] = Array.isArray(o) ? o : typeof o === 'object' ? [o.value, o.label] : [o, sentence(o)];
            return h('option', { value: val ?? '', selected: String(val ?? '') === String(v ?? '') }, lab);
          }));
        break;
      case 'textarea': input = h('textarea', { class: 'input', id, name: f.name, placeholder: f.placeholder || '', rows: f.rows || 3 }, v ?? ''); break;
      case 'checkbox': input = h('input', { type: 'checkbox', id, name: f.name, checked: !!(values[f.name] ?? f.default) }); break;
      case 'days': {
        const sel = String(v || '').split(',');
        input = h('div', { class: 'days-picker', id }, DOW.map((d, i) => h('label', null, h('input', { type: 'checkbox', value: String(i + 1), checked: sel.includes(String(i + 1)) }), h('span', null, d))));
        break;
      }
      case 'money': case 'number':
        input = h('input', { class: 'input num', id, name: f.name, type: 'number', value: v ?? '', min: f.min, max: f.max, step: f.step || (f.type === 'money' ? '0.01' : 'any'), placeholder: f.placeholder || '', inputmode: 'decimal' });
        break;
      default:
        input = h('input', { class: 'input', id, name: f.name, type: f.type || 'text', value: v ?? '', placeholder: f.placeholder || '', autocomplete: f.autocomplete || 'off', readOnly: f.type === 'readonly' });
    }
    if (f.disabled) input.disabled = true;
    inputs[f.name] = input;
    input.addEventListener(f.type === 'checkbox' || f.type === 'select' || f.type === 'days' ? 'change' : 'input', () => {
      input.classList.remove('invalid');
      if (errs[f.name]) errs[f.name].textContent = '';
      refresh();
      if (onChange) onChange(read(), f.name);
    });
    errs[f.name] = h('div', { class: 'err' });
    let wrap;
    if (f.type === 'checkbox') {
      wrap = h('div', { class: ['field', f.full !== false && 'full'] }, h('label', { class: 'check', for: id }, input, h('div', null, h('div', { class: 'strong' }, f.label), f.help ? h('div', { class: 'sub' }, f.help) : null)), errs[f.name]);
    } else {
      const control = f.suffix ? h('div', { class: 'input-group' }, input, h('span', { class: 'addon' }, f.suffix)) : input;
      wrap = h('div', { class: ['field', f.full && 'full'] },
        f.label ? h('label', { for: id }, f.label, f.required ? h('span', { class: 'req' }, ' *') : null) : null,
        control, f.help ? h('div', { class: 'help' }, f.help) : null, errs[f.name]);
    }
    wraps[f.name] = wrap;
    form.append(wrap);
  }
  refresh();
  return {
    el: form,
    inputs,
    values: read,
    validate() {
      let ok = true;
      const v = read();
      for (const f of fields) {
        if (!f.name || !f.required || (wraps[f.name] && wraps[f.name].classList.contains('hidden'))) continue;
        if (v[f.name] === '' || v[f.name] === null || v[f.name] === undefined) {
          ok = false;
          inputs[f.name].classList.add('invalid');
          errs[f.name].textContent = `${f.label || 'This'} is required.`;
        }
      }
      if (!ok) { const first = form.querySelector('.invalid'); if (first) first.focus(); }
      return ok;
    },
    set(name, value) { const el = inputs[name]; if (!el) return; if (el.type === 'checkbox') el.checked = !!value; else el.value = value ?? ''; refresh(); },
    refresh,
  };
}

/**
 * A modal with a form. onSubmit(values) may throw; the error is shown and the modal stays open.
 */
export function formModal({ title, fields, values = {}, submit = 'Save', size = '', onSubmit, intro = null, one = false, danger = null, extra = null, onChange = null }) {
  return new Promise((resolve) => {
    let done = false;
    const form = buildForm(fields, values, { one, onChange });
    if (onChange) setTimeout(() => onChange(form.values(), null), 0);
    const errBox = h('div');
    const btn = h('button', { class: 'btn primary', type: 'submit' }, submit);
    const go = async () => {
      if (!form.validate()) return;
      btn.disabled = true;
      clear(errBox);
      try {
        const result = await onSubmit(form.values(), form);
        done = true;
        m.close();
        resolve(result === undefined ? true : result);
      } catch (err) {
        clear(errBox, h('div', { class: 'mt-16' }, alertBox(err.message || String(err), 'bad', 'alert')));
        btn.disabled = false;
      }
    };
    form.el.addEventListener('submit', (e) => { e.preventDefault(); go(); });
    btn.addEventListener('click', (e) => { e.preventDefault(); go(); });
    const actions = [];
    if (danger) actions.push(h('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => { const r = await danger.onClick(); if (r !== false) { done = true; m.close(); resolve('deleted'); } } }, danger.label));
    actions.push(h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), btn);
    const m = modal({ title, size, body: h('div', null, intro, form.el, extra, errBox), actions, onClose: () => { if (!done) resolve(null); } });
  });
}

/* ------------------------------------------------------------------ table */
/**
 * columns: [{ key, label, render(row), sort(row) | true, num, width, className }]
 * Returns an element; options: rows, empty, onRow, search (placeholder) , pageSize, footer(rows)
 */
export function table({ columns, rows, empty: emptyEl = null, onRow = null, search = null, pageSize = 50, footer = null, toolbar = null, compact = false, initialSort = null }) {
  let sortKey = initialSort ? initialSort.key : null;
  let sortDir = initialSort ? initialSort.dir : 1;
  let q = '';
  let page = 0;
  const wrap = h('div');
  const body = h('div');
  const searchInput = search ? h('input', { class: 'input sm', placeholder: search, style: { maxWidth: '280px' }, oninput: (e) => { q = e.target.value.toLowerCase(); page = 0; render(); } }) : null;
  if (searchInput || toolbar) wrap.append(h('div', { class: 'toolbar', style: { padding: '12px 14px 0' } }, searchInput, h('div', { class: 'spacer' }), toolbar));
  wrap.append(body);

  const textOf = (r) => columns.map((c) => {
    const v = c.text ? c.text(r) : c.sort && typeof c.sort === 'function' ? c.sort(r) : r[c.key];
    return v === null || v === undefined ? '' : String(v);
  }).join(' ').toLowerCase();

  function render() {
    let list = rows;
    if (q) list = list.filter((r) => textOf(r).includes(q));
    if (sortKey) {
      const col = columns.find((c) => c.key === sortKey);
      const val = (r) => (typeof col.sort === 'function' ? col.sort(r) : r[col.key]);
      list = [...list].sort((a, b) => {
        const x = val(a); const y = val(b);
        if (x === y) return 0;
        if (x === null || x === undefined || x === '') return 1;
        if (y === null || y === undefined || y === '') return -1;
        return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sortDir;
      });
    }
    const pages = Math.max(1, Math.ceil(list.length / pageSize));
    if (page >= pages) page = pages - 1;
    const shown = list.slice(page * pageSize, page * pageSize + pageSize);
    if (!rows.length && emptyEl) { clear(body, emptyEl); return; }
    const thead = h('thead', null, h('tr', null, columns.map((c) => {
      const th = h('th', { class: [c.num && 'num', c.sort && 'sortable', c.className], style: c.width ? { width: c.width } : null }, c.label || '');
      if (c.sort) {
        if (sortKey === c.key) th.append(' ', sortDir > 0 ? '↑' : '↓');
        th.addEventListener('click', () => { if (sortKey === c.key) sortDir = -sortDir; else { sortKey = c.key; sortDir = 1; } render(); });
      }
      return th;
    })));
    const tbody = h('tbody', null, shown.length ? shown.map((r) => {
      const tr = h('tr', { class: onRow && 'click' }, columns.map((c) => h('td', { class: [c.num && 'num', c.className] }, c.render ? c.render(r) : (r[c.key] ?? '—'))));
      if (onRow) tr.addEventListener('click', (e) => { if (e.target.closest('button, a, input, select, label')) return; onRow(r, e); });
      return tr;
    }) : h('tr', null, h('td', { colspan: columns.length, class: 'center muted', style: { padding: '28px' } }, q ? 'Nothing matches your search.' : 'Nothing here yet.')));
    const tfoot = footer ? h('tfoot', null, footer(list)) : null;
    const t = h('table', { class: ['table', compact && 'compact'] }, thead, tbody, tfoot);
    const nav = pages > 1 ? h('div', { class: 'table-foot' },
      h('span', null, `${page * pageSize + 1}–${Math.min(list.length, (page + 1) * pageSize)} of ${list.length}`), h('div', { class: 'spacer' }),
      h('button', { class: 'btn sm', disabled: page === 0, onclick: () => { page--; render(); } }, icon('left', 14), 'Previous'),
      h('button', { class: 'btn sm', disabled: page >= pages - 1, onclick: () => { page++; render(); } }, 'Next', icon('right', 14))) : null;
    clear(body, h('div', { class: 'table-wrap' }, t), nav);
  }
  render();
  wrap.update = (newRows) => { rows = newRows; render(); };
  return wrap;
}

/* ------------------------------------------------------------------ layout bits */
export function pageHead(title, { sub = null, actions = [], crumbs = null } = {}) {
  return h('div', { class: 'page-head' },
    h('div', { class: 'titles' },
      crumbs ? h('div', { class: 'crumbs' }, crumbs.flatMap((c, i) => [i ? icon('right', 12) : null, c.href ? h('a', { href: c.href }, c.label) : h('span', null, c.label)])) : null,
      h('h1', null, title), sub ? h('div', { class: 'sub' }, sub) : null),
    actions.length ? h('div', { class: 'actions' }, actions) : null);
}
export function card(title, body, { actions = null, flush = false, className = '' } = {}) {
  return h('div', { class: ['card', className] },
    title ? h('div', { class: 'card-head' }, typeof title === 'string' ? h('h3', null, title) : title, actions) : null,
    h('div', { class: ['card-body', flush && 'flush'] }, body));
}
export function stat(label, value, { hint = null, ic = null, color = 'var(--brand)', bg = 'var(--brand-soft)', onClick = null } = {}) {
  return h('div', { class: 'card stat', style: onClick ? { cursor: 'pointer' } : null, onclick: onClick },
    h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), hint ? h('div', { class: 'hint' }, hint) : null,
    ic ? h('div', { class: 'stat-icon', style: { color, background: bg } }, icon(ic, 18)) : null);
}
export function tabs(items, active, onChange) {
  return h('div', { class: 'tabs', role: 'tablist' }, items.filter(Boolean).map((t) => {
    const props = { class: t.id === active ? 'on' : '', role: 'tab', 'aria-selected': String(t.id === active) };
    const inner = [t.icon ? icon(t.icon, 16) : null, t.label, t.count ? h('span', { class: 'count' }, t.count) : null];
    return t.href ? h('a', { ...props, href: t.href }, inner) : h('button', { ...props, type: 'button', onclick: () => onChange(t.id) }, inner);
  }));
}
export function seg(items, active, onChange) {
  const box = h('div', { class: 'seg' });
  const draw = (cur) => clear(box, items.map(([id, label]) => h('button', { type: 'button', class: id === cur ? 'on' : '', onclick: () => { draw(id); onChange(id); } }, label)));
  draw(active);
  return box;
}
export function kv(pairs) {
  return h('dl', { class: 'kv' }, pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? '—' : v)]));
}

/** Read a file chosen by the user as a data URL (images) or base64. */
export function readFile(file, asDataUrl = true) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(asDataUrl ? r.result : String(r.result).split(',')[1]);
    r.onerror = () => reject(new Error('Could not read the file.'));
    r.readAsDataURL(file);
  });
}

/** Shrink an image to fit size × size and return a JPEG data URL (for photos and logos). */
export async function shrinkImage(file, size = 256, type = 'image/jpeg') {
  const url = await readFile(file);
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('That is not an image.')); i.src = url; });
  const scale = Math.min(1, size / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(type, 0.85);
}

export function pickFile(accept) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, style: { display: 'none' } });
    input.addEventListener('change', () => { resolve(input.files[0] || null); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export function download(url) {
  const a = h('a', { href: url, download: '' });
  document.body.append(a); a.click(); a.remove();
}
