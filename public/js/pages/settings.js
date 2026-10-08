// Settings: everything an organization configures, with nothing hard-coded.
import { api } from '../api.js';
import { S, can, loadLookups, loadMe, navigate, options, employeeOptions, lookupName } from '../state.js';
import {
  h, clear, icon, pageHead, card, table, badge, buildForm, formModal, toast, errorToast, confirmDialog, alertBox, money, date, num, sentence,
  pickFile, shrinkImage, DOW, empty, utcToLocal, modal, todayLocal,
} from '../ui.js';
import { makeMap } from '../map.js';

const SECTIONS = [
  { grp: 'Organization' },
  { id: 'company', label: 'Company profile', icon: 'building', perm: 'org.manage' },
  { id: 'general', label: 'General rules', icon: 'sliders', perm: 'org.manage' },
  { grp: 'Structure' },
  { id: 'branches', label: 'Branches & geofences', icon: 'pin', perm: 'org.manage' },
  { id: 'departments', label: 'Departments', icon: 'org', perm: 'org.manage' },
  { id: 'designations', label: 'Designations & grades', icon: 'briefcase', perm: 'org.manage' },
  { grp: 'Time' },
  { id: 'shifts', label: 'Shifts', icon: 'clock', perm: 'org.manage' },
  { id: 'policies', label: 'Attendance policies', icon: 'shield', perm: 'org.manage' },
  { id: 'holidays', label: 'Holidays & exceptional days', icon: 'calendar', perm: 'org.manage' },
  { id: 'leave', label: 'Leave types', icon: 'calendar', perm: 'leave.manage' },
  { grp: 'Pay' },
  { id: 'components', label: 'Salary components', icon: 'coins', perm: 'salary.view' },
  { id: 'structures', label: 'Salary structures', icon: 'layers', perm: 'salary.view' },
  { id: 'tax', label: 'Income tax slabs', icon: 'percent', perm: 'salary.view' },
  { grp: 'People' },
  { id: 'users', label: 'Users & roles', icon: 'key', perm: 'users.manage' },
  { id: 'checklists', label: 'Onboarding & exit lists', icon: 'checkCircle', perm: 'org.manage' },
  { id: 'audit', label: 'Activity log', icon: 'history', perm: 'org.manage' },
];

export default async function settings(view, params) {
  const allowed = SECTIONS.filter((s) => s.grp || can(s.perm));
  const first = allowed.find((s) => s.id);
  if (!first) throw new Error('You cannot change settings.');
  const tab = params.tab && allowed.some((s) => s.id === params.tab) ? params.tab : first.id;
  await loadLookups(true);
  const org = await api.get('/api/org');
  view.append(pageHead('Settings', { sub: `${org.org.name} · changes apply to this organization only.` }));
  const nav = h('nav', { class: 'settings-nav' }, allowed.map((s, i) => {
    if (s.grp) return allowed[i + 1] && allowed[i + 1].id ? h('div', { class: 'grp' }, s.grp) : null;
    return h('a', { href: `#/settings/${s.id}`, class: s.id === tab ? 'on' : '' }, icon(s.icon, 16), s.label);
  }));
  const body = h('div', { style: { minWidth: 0 } });
  view.append(h('div', { class: 'settings-layout' }, nav, body));
  const ctx = { org, reload: () => navigate(`/settings/${tab}`) };
  const fn = {
    company, general, branches, departments, designations, shifts, policies, holidays, leave: leaveTypes, components, structures, tax, users, checklists, audit,
  }[tab];
  await fn(body, ctx);
}

/** A card with a table of rows and an add button that opens a form. */
function listSection(body, { title, rows, columns, fields, endpoint, values = {}, intro = null, onSaved = null, emptyText = '', name = (r) => r.name, canEdit = true, prepare = (v) => v, size = '' }) {
  const save = async (row = null) => {
    const ok = await formModal({
      title: row ? `Edit ${name(row)}` : `Add ${title.toLowerCase().replace(/s$/, '')}`,
      fields, values: row ? { ...row } : { ...values }, size,
      onSubmit: (v) => (row ? api.put(`${endpoint}/${row.id}`, prepare(v, row)) : api.post(endpoint, prepare(v, null))),
      danger: row ? { label: 'Delete', onClick: async () => {
        if (!(await confirmDialog(`Delete ${name(row)}?`, { danger: true, ok: 'Delete' }))) return false;
        try { await api.del(`${endpoint}/${row.id}`); toast('Deleted'); if (onSaved) onSaved(); else navigate(location.hash.slice(1)); } catch (err) { errorToast(err); return false; }
      } } : null,
    });
    if (ok === true) { toast('Saved'); await loadLookups(true); if (onSaved) onSaved(); else window.dispatchEvent(new HashChangeEvent('hashchange')); }
  };
  body.append(card(title, h('div', null, intro ? h('div', { style: { padding: '14px 18px 0' } }, intro) : null,
    rows.length ? table({ rows, columns, onRow: canEdit ? (r) => save(r) : null, pageSize: 100 }) : empty(`No ${title.toLowerCase()} yet`, emptyText, canEdit ? h('button', { class: 'btn primary', onclick: () => save() }, icon('plus', 16), 'Add') : null, 'plus')),
  { flush: true, actions: canEdit && rows.length ? h('button', { class: 'btn sm primary', onclick: () => save() }, icon('plus', 14), 'Add') : null }));
  return save;
}

const activeBadge = (r) => (r.active ? badge('Active', 'ok') : badge('Off'));

/* ------------------------------------------------------------------ company */
async function company(body, { org }) {
  const o = org.org;
  let logo = o.logo;
  const logoBox = h('div', { class: 'row gap-12' });
  const drawLogo = () => clear(logoBox,
    h('div', { style: { width: '72px', height: '72px', borderRadius: '14px', border: '1px solid var(--line)', display: 'grid', placeItems: 'center', overflow: 'hidden', background: 'var(--panel-2)' } },
      logo ? h('img', { src: logo, alt: '', style: { maxWidth: '100%', maxHeight: '100%' } }) : icon('building', 26)),
    h('div', { class: 'col gap-4' },
      h('button', { class: 'btn sm', type: 'button', onclick: async () => { const f = await pickFile('image/png,image/jpeg,image/webp'); if (!f) return; logo = await shrinkImage(f, 400, 'image/png'); drawLogo(); } }, icon('upload', 14), 'Upload logo'),
      logo ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { logo = null; drawLogo(); } }, 'Remove') : null,
      h('span', { class: 'tiny muted' }, 'Shown on payslips and in the menu.')));
  drawLogo();
  const f = buildForm([
    { name: 'name', label: 'Name (as shown in the app)', required: true },
    { name: 'legal_name', label: 'Legal name (on payslips)' },
    { name: 'email', label: 'HR email', type: 'email' }, { name: 'phone', label: 'Phone' },
    { name: 'address', label: 'Address', type: 'textarea', full: true, rows: 2 },
    { name: 'country', label: 'Country' },
    { name: 'currency', label: 'Currency code', required: true, placeholder: 'PKR', help: 'e.g. PKR, AED, SAR, USD, GBP' },
    { name: 'timezone', label: 'Time zone', required: true, placeholder: 'Asia/Karachi', help: 'Attendance times use this zone. e.g. Asia/Karachi, Asia/Dubai, Europe/London' },
  ], o);
  body.append(card('Company profile', h('div', null, h('div', { class: 'mb-16' }, logoBox), f.el,
    h('div', { class: 'row mt-16' }, h('div', { class: 'spacer' }), h('button', {
      class: 'btn primary',
      onclick: async () => {
        if (!f.validate()) return;
        try { await api.put('/api/org', { ...f.values(), logo }); await loadMe(); toast('Saved'); window.dispatchEvent(new Event('hr:refresh-shell')); } catch (err) { errorToast(err); }
      },
    }, 'Save')))));
  body.append(card('Organization code', h('div', null, h('p', { class: 'muted small' }, 'Used by Broadwing single sign-on and support.'), h('div', { class: 'code-box' }, o.code))));
}

/* ------------------------------------------------------------------ general rules */
function defsToFields(defs, values) {
  return Object.entries(defs).map(([name, d]) => {
    if (d.type === 'bool') return { name, label: d.label, type: 'checkbox' };
    if (d.type === 'enum') return { name, label: d.label, type: 'select', options: d.values.map((v) => [v, ENUM_LABELS[v] || sentence(v)]) };
    if (d.type === 'str') return { name, label: d.label };
    return { name, label: d.label, type: 'number', min: d.min, max: d.max, step: d.type === 'num' ? 'any' : '1' };
  });
}
const ENUM_LABELS = {
  calendar: 'Days in the month (28–31)', fixed30: '30 days, every month', working: 'Working days in the month',
  none: 'Nothing', unit: 'Whole number', ten: 'Nearest 10', half_day: 'Mark as half day', hourly: 'Deduct by the hour',
  salary: 'Salary', leave_then_salary: 'Leave balance first, then salary', missing: 'Flag as missing (counts as present until fixed)',
  present: 'Present', absent: 'Absent',
};

async function general(body, { org }) {
  const groups = [
    ['Probation & employees', ['probation_days', 'employee_code_prefix']],
    ['Leave year & approvals', ['leave_year_start_month', 'leave_approval_levels', 'leave_hr_final', 'leave_escalate_days', 'leave_skip_absent_approver']],
    ['Payroll', ['payroll_day_basis', 'payroll_period_start_day', 'payroll_rounding', 'tax_enabled', 'deduction_leave_code']],
    ['Mobile attendance', ['mobile_accuracy_m', 'mobile_require_note_anywhere']],
  ];
  const forms = groups.map(([title, keys]) => {
    const defs = Object.fromEntries(keys.map((k) => [k, org.settingDefs[k]]));
    const f = buildForm(defsToFields(defs), org.org.settings);
    body.append(card(title, f.el));
    return f;
  });
  body.append(h('div', { class: 'row mt-16' }, h('div', { class: 'spacer' }), h('button', {
    class: 'btn primary',
    onclick: async () => {
      try { await api.put('/api/org/settings', Object.assign({}, ...forms.map((f) => f.values()))); await loadMe(); toast('Saved'); } catch (err) { errorToast(err); }
    },
  }, 'Save rules')));
}

/* ------------------------------------------------------------------ branches */
async function branches(body, ctx) {
  const rows = await api.get('/api/branches');
  const edit = async (b = null) => {
    let lat = b ? b.lat : null;
    let lng = b ? b.lng : null;
    let radius = b ? b.radius_m : 150;
    const f = buildForm([
      { name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code' },
      { name: 'address', label: 'Address', full: true },
      { name: 'radius_m', label: 'Geofence radius', type: 'number', min: 10, max: 50000, suffix: 'metres', help: 'Phones must be within this distance to check in. 100–300 m suits most offices.' },
      { name: 'active', label: 'Active', type: 'checkbox', default: true },
    ], b || { radius_m: 150, active: true });
    const coords = h('div', { class: 'small muted' });
    const mapEl = h('div', { class: 'map tall' });
    const drawCoords = () => { coords.textContent = lat !== null && lat !== undefined ? `Location: ${Number(lat).toFixed(6)}, ${Number(lng).toFixed(6)}` : 'No location yet: click on the map, or use your current location.'; };
    drawCoords();
    let marker = null; let circle = null; let mapObj = null;
    const place = () => {
      if (!mapObj || lat === null || lat === undefined) return;
      const { L, map } = mapObj;
      if (!marker) {
        marker = L.marker([lat, lng], { draggable: true }).addTo(map);
        marker.on('dragend', () => { const p = marker.getLatLng(); lat = p.lat; lng = p.lng; circle.setLatLng(p); drawCoords(); });
        circle = L.circle([lat, lng], { radius, color: '#4f46e5', weight: 2, fillOpacity: 0.12 }).addTo(map);
      } else { marker.setLatLng([lat, lng]); circle.setLatLng([lat, lng]); }
      circle.setRadius(radius);
    };
    f.inputs.radius_m.addEventListener('input', () => { radius = Number(f.inputs.radius_m.value) || 150; place(); });
    const useMine = h('button', {
      class: 'btn sm', type: 'button',
      onclick: () => navigator.geolocation.getCurrentPosition((p) => { lat = p.coords.latitude; lng = p.coords.longitude; drawCoords(); place(); if (mapObj) mapObj.map.setView([lat, lng], 17); },
        () => errorToast(new Error('Could not get your location (allow location access, and use https).')), { enableHighAccuracy: true, timeout: 15000 }),
    }, icon('pin', 14), 'Use my current location');
    const err = h('div');
    const m = modal({
      title: b ? `Edit ${b.name}` : 'Add a branch', size: 'lg',
      body: h('div', null, f.el, h('div', { class: 'row mt-16 mb-8' }, coords, h('div', { class: 'spacer' }), useMine), mapEl,
        h('p', { class: 'tiny muted mt-8' }, 'Click the map to set the office location, or drag the pin. The circle is the check-in area.'), err),
      actions: [
        b ? h('button', { class: 'btn danger', style: { marginRight: 'auto' }, onclick: async () => {
          if (!(await confirmDialog(`Delete ${b.name}?`, { danger: true, ok: 'Delete' }))) return;
          try { await api.del(`/api/branches/${b.id}`); m.close(); toast('Deleted'); ctx.reload(); } catch (x) { errorToast(x); }
        } }, 'Delete') : null,
        h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'),
        h('button', { class: 'btn primary', onclick: async () => {
          if (!f.validate()) return;
          try {
            const v = { ...f.values(), lat, lng };
            if (b) await api.put(`/api/branches/${b.id}`, v); else await api.post('/api/branches', v);
            m.close(); toast('Saved'); await loadLookups(true); ctx.reload();
          } catch (x) { clear(err, h('div', { class: 'mt-16' }, alertBox(x.message, 'bad', 'alert'))); }
        } }, 'Save'),
      ].filter(Boolean),
    });
    try {
      mapObj = await makeMap(mapEl, lat !== null && lat !== undefined ? { lat, lng, zoom: 17 } : {});
      mapObj.map.on('click', (e) => { lat = e.latlng.lat; lng = e.latlng.lng; drawCoords(); place(); });
      place();
    } catch { clear(mapEl, h('p', { class: 'muted', style: { padding: '12px' } }, 'The map could not load. You can still use “Use my current location”.')); }
  };
  body.append(card('Branches & geofences', h('div', null,
    h('div', { style: { padding: '14px 18px 0' } }, alertBox('Each branch can have a location and radius. Employees with mobile attendance set to “inside an office geofence” can check in from their phone only within it.', 'info', 'pin')),
    table({
      rows, onRow: (b) => edit(b),
      columns: [
        { key: 'name', label: 'Branch', render: (b) => h('div', null, h('div', { class: 'strong' }, b.name), h('div', { class: 'tiny muted' }, b.address || '')) },
        { key: 'geo', label: 'Geofence', render: (b) => (b.lat !== null ? h('span', { class: 'chip' }, icon('pin', 13), `${b.radius_m} m`) : badge('No location', 'warn')) },
        { key: 'people', label: 'People', num: true, render: (b) => S.lookups.employees.filter((e) => e.branch_id === b.id && e.status !== 'exited').length },
        { key: 'active', label: '', render: activeBadge },
      ],
    })), { flush: true, actions: h('button', { class: 'btn sm primary', onclick: () => edit() }, icon('plus', 14), 'Add branch') }));
}

/* ------------------------------------------------------------------ departments */
async function departments(body, ctx) {
  const rows = await api.get('/api/departments');
  const count = (id) => S.lookups.employees.filter((e) => e.department_id === id && e.status !== 'exited').length;
  listSection(body, {
    title: 'Departments', rows, endpoint: '/api/departments', onSaved: ctx.reload,
    intro: h('p', { class: 'muted small' }, 'Tip: you can also arrange departments and their heads by dragging on the ', h('a', { href: '#/organogram?mode=departments' }, 'Organogram'), '.'),
    fields: [
      { name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code' },
      { name: 'parent_id', label: 'Part of', type: 'select', placeholder: '— Top level —', options: () => options('departments', { active: false }), numeric: true },
      { name: 'head_employee_id', label: 'Head of department', type: 'select', placeholder: '—', options: () => employeeOptions(), numeric: true },
      { name: 'color', label: 'Colour', type: 'color' }, { name: 'sort', label: 'Order', type: 'number' },
      { name: 'active', label: 'Active', type: 'checkbox', default: true },
    ],
    values: { color: '#4f46e5', active: true, sort: 0 },
    columns: [
      { key: 'name', label: 'Department', render: (d) => h('span', { class: 'row' }, h('span', { class: 'swatch', style: { background: d.color || 'var(--faint)' } }), h('strong', null, d.name), d.code ? h('span', { class: 'tiny muted' }, d.code) : null) },
      { key: 'parent', label: 'Part of', render: (d) => lookupName('departments', d.parent_id) },
      { key: 'head', label: 'Head', render: (d) => lookupName('employees', d.head_employee_id) },
      { key: 'n', label: 'People', num: true, render: (d) => count(d.id) },
      { key: 'active', label: '', render: activeBadge },
    ],
  });
}

/* ------------------------------------------------------------------ designations & grades */
async function designations(body, ctx) {
  const [des, grades] = await Promise.all([api.get('/api/designations'), api.get('/api/grades')]);
  listSection(body, {
    title: 'Designations', rows: des, endpoint: '/api/designations', onSaved: ctx.reload,
    fields: [{ name: 'name', label: 'Title', required: true }, { name: 'grade_id', label: 'Usual grade', type: 'select', placeholder: '—', options: () => options('grades'), numeric: true }, { name: 'sort', label: 'Order', type: 'number' }, { name: 'active', label: 'Active', type: 'checkbox', default: true }],
    values: { active: true, sort: 0 },
    columns: [{ key: 'name', label: 'Designation', render: (d) => h('strong', null, d.name) }, { key: 'grade', label: 'Grade', render: (d) => lookupName('grades', d.grade_id) }, { key: 'active', label: '', render: activeBadge }],
  });
  body.append(h('div', { class: 'mt-16' }));
  listSection(body, {
    title: 'Grades', rows: grades, endpoint: '/api/grades', onSaved: ctx.reload,
    fields: [
      { name: 'name', label: 'Grade', required: true, placeholder: 'e.g. G-5' },
      { name: 'structure_id', label: 'Salary structure', type: 'select', placeholder: '—', options: () => options('structures'), numeric: true },
      { name: 'min_salary', label: 'Minimum gross', type: 'money' }, { name: 'max_salary', label: 'Maximum gross', type: 'money' },
      { name: 'sort', label: 'Order', type: 'number' }, { name: 'active', label: 'Active', type: 'checkbox', default: true },
    ],
    values: { active: true, sort: 0 },
    columns: [
      { key: 'name', label: 'Grade', render: (g) => h('strong', null, g.name) },
      { key: 'range', label: 'Salary range', render: (g) => (g.min_salary || g.max_salary ? `${money(g.min_salary || 0)} – ${g.max_salary ? money(g.max_salary) : '…'}` : '—') },
      { key: 'structure', label: 'Structure', render: (g) => lookupName('structures', g.structure_id) },
      { key: 'active', label: '', render: activeBadge },
    ],
  });
}

/* ------------------------------------------------------------------ shifts */
async function shifts(body, ctx) {
  const rows = S.lookups.shifts;
  const edit = async (s = null) => {
    let overrides = {};
    try { overrides = s && s.day_overrides ? JSON.parse(s.day_overrides) : {}; } catch { overrides = {}; }
    const ovBox = h('div', { class: 'col gap-4' });
    const drawOv = () => clear(ovBox, DOW.map((d, i) => {
      const k = String(i + 1);
      const o = overrides[k];
      return h('div', { class: 'row' },
        h('label', { class: 'check', style: { width: '170px' } }, h('input', { type: 'checkbox', checked: !!o, onchange: (e) => { if (e.target.checked) overrides[k] = { start: '09:00', end: '13:00' }; else delete overrides[k]; drawOv(); } }), `Different hours on ${d}`),
        o ? h('input', { class: 'input sm', type: 'time', value: o.start, style: { width: '120px' }, onchange: (e) => { o.start = e.target.value; } }) : null,
        o ? h('input', { class: 'input sm', type: 'time', value: o.end, style: { width: '120px' }, onchange: (e) => { o.end = e.target.value; } }) : null);
    }));
    drawOv();
    const ok = await formModal({
      title: s ? `Edit ${s.name}` : 'Add a shift', size: 'lg',
      fields: [
        { name: 'name', label: 'Name', required: true, full: true },
        { name: 'start_time', label: 'Starts', type: 'time', required: true }, { name: 'end_time', label: 'Ends', type: 'time', required: true, help: 'For a night shift, an end before the start means the next day.' },
        { name: 'break_minutes', label: 'Break', type: 'number', min: 0, suffix: 'minutes' },
        { name: 'weekly_off', label: 'Weekly days off', type: 'days', full: true },
        { node: h('div', null, h('label', { class: 'small strong' }, 'Short or different days (e.g. Friday half day)'), ovBox) },
        { name: 'is_default', label: 'Default shift for people without one', type: 'checkbox' },
        { name: 'active', label: 'Active', type: 'checkbox', default: true },
      ],
      values: s || { start_time: '09:00', end_time: '18:00', break_minutes: 60, weekly_off: '6,7', active: true },
      onSubmit: (v) => { const body2 = { ...v, day_overrides: overrides }; return s ? api.put(`/api/shifts/${s.id}`, body2) : api.post('/api/shifts', body2); },
      danger: s ? { label: 'Delete', onClick: async () => { if (!(await confirmDialog(`Delete ${s.name}?`, { danger: true, ok: 'Delete' }))) return false; try { await api.del(`/api/shifts/${s.id}`); toast('Deleted'); ctx.reload(); } catch (err) { errorToast(err); return false; } } } : null,
    });
    if (ok === true) { toast('Saved'); await loadLookups(true); ctx.reload(); }
  };
  body.append(card('Shifts', table({
    rows, onRow: (s) => edit(s),
    columns: [
      { key: 'name', label: 'Shift', render: (s) => h('div', { class: 'row' }, h('strong', null, s.name), s.is_default ? badge('Default', 'brand') : null) },
      { key: 'time', label: 'Hours', render: (s) => `${s.start_time} – ${s.end_time}` },
      { key: 'break_minutes', label: 'Break', render: (s) => `${s.break_minutes} min` },
      { key: 'weekly_off', label: 'Days off', render: (s) => (s.weekly_off ? s.weekly_off.split(',').map((d) => DOW[Number(d) - 1]).join(', ') : 'None') },
      { key: 'active', label: '', render: activeBadge },
    ],
  }), { flush: true, actions: h('button', { class: 'btn sm primary', onclick: () => edit() }, icon('plus', 14), 'Add shift') }));
}

/* ------------------------------------------------------------------ attendance policies */
async function policies(body, ctx) {
  const rows = await api.get('/api/policies');
  const defs = ctx.org.policyDefs;
  const groups = [
    ['Late arrivals', ['grace_minutes', 'lates_per_deduction', 'late_deduction_days', 'late_deduct_from', 'half_day_if_late_minutes', 'early_grace_minutes', 'count_early_as_late']],
    ['Absences & short time', ['absent_deduction_days', 'absent_deduct_from', 'min_minutes_for_half_day', 'full_day_tolerance_minutes', 'short_time_action', 'single_punch', 'sandwich_rule']],
    ['Overtime', ['overtime_enabled', 'overtime_min_minutes', 'overtime_rate', 'overtime_offday_rate', 'overtime_max_hours_month']],
  ];
  const edit = async (p = null) => {
    const rules = p ? p.rules : Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.default]));
    const fields = [{ name: 'name', label: 'Policy name', required: true }, { name: 'is_default', label: 'Default for everyone without a policy', type: 'checkbox' }];
    for (const [title, keys] of groups) {
      fields.push({ section: title });
      fields.push(...defsToFields(Object.fromEntries(keys.map((k) => [k, defs[k]])), rules).map((f) => ({ ...f, show: f.name.startsWith('overtime_') && f.name !== 'overtime_enabled' ? (v) => v.overtime_enabled : undefined })));
    }
    const ok = await formModal({
      title: p ? `Edit ${p.name}` : 'New attendance policy', size: 'lg', fields,
      intro: h('p', { class: 'muted small mb-16' }, 'Example: grace 15 minutes and “every 3 lates deduct 1 day” means arriving at 9:14 is fine, and the 3rd, 6th, 9th… late in a month costs a day’s pay (or leave).'),
      values: { ...rules, name: p ? p.name : '', is_default: p ? !!p.is_default : false },
      onSubmit: (v) => {
        const { name, is_default: isDefault, ...r } = v;
        return p ? api.put(`/api/policies/${p.id}`, { name, is_default: isDefault, rules: r }) : api.post('/api/policies', { name, is_default: isDefault, rules: r });
      },
      danger: p && !p.is_default ? { label: 'Delete', onClick: async () => { try { await api.del(`/api/policies/${p.id}`); toast('Deleted'); ctx.reload(); } catch (err) { errorToast(err); return false; } } } : null,
    });
    if (ok === true) { toast('Saved — recalculate attendance to apply it to past days'); await loadLookups(true); ctx.reload(); }
  };
  body.append(card('Attendance policies', h('div', null,
    h('div', { style: { padding: '14px 18px 0' } }, alertBox('Policies hold your attendance rules (lates, absences, short time, overtime). Have one for office staff and another for field or factory staff, and pick it on each employee.', 'info', 'shield')),
    table({
      rows, onRow: (p) => edit(p),
      columns: [
        { key: 'name', label: 'Policy', render: (p) => h('div', { class: 'row' }, h('strong', null, p.name), p.is_default ? badge('Default', 'brand') : null) },
        { key: 'late', label: 'Lates', render: (p) => `${p.rules.grace_minutes} min grace · ${p.rules.lates_per_deduction ? `${p.rules.lates_per_deduction} lates = ${num(p.rules.late_deduction_days)} day` : 'no deduction'}` },
        { key: 'abs', label: 'Absence', render: (p) => `${num(p.rules.absent_deduction_days)} day${p.rules.absent_deduct_from === 'leave_then_salary' ? ' (leave first)' : ''}` },
        { key: 'ot', label: 'Overtime', render: (p) => (p.rules.overtime_enabled ? `${p.rules.overtime_rate}× / ${p.rules.overtime_offday_rate}× off days` : 'Off') },
      ],
    })), { flush: true, actions: h('button', { class: 'btn sm primary', onclick: () => edit() }, icon('plus', 14), 'New policy') }));
}

/* ------------------------------------------------------------------ holidays */
async function holidays(body, ctx) {
  const year = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('year')) || new Date().getFullYear();
  const rows = await api.get('/api/holidays', { year });
  listSection(body, {
    title: `Holidays ${year}`, rows, endpoint: '/api/holidays', onSaved: ctx.reload,
    intro: h('div', null,
      h('div', { class: 'row mb-8' }, h('a', { class: 'btn sm', href: `#/settings/holidays?year=${year - 1}` }, icon('left', 14), year - 1), h('a', { class: 'btn sm', href: `#/settings/holidays?year=${year + 1}` }, year + 1, icon('right', 14)),
        h('div', { class: 'spacer' }), rows.length ? h('button', { class: 'btn sm', onclick: () => copyYear(rows, year, ctx) }, icon('copy', 14), `Copy to ${year + 1}`) : null),
      alertBox(h('span', null, h('strong', null, 'Exceptional days'), ' cover the unexpected — heavy rain, strikes, power outages: close the office (paid day off), relax attendance (no late or absent marks) or make it a half day, for all branches or one.'), 'info', 'info')),
    fields: [
      { name: 'holiday_date', label: 'Date', type: 'date', required: true }, { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Independence Day / Heavy rain' },
      { name: 'kind', label: 'Kind', type: 'select', options: [['public', 'Public holiday (paid day off)'], ['exceptional', 'Exceptional day']] },
      { name: 'treatment', label: 'On that day', type: 'select', show: (v) => v.kind === 'exceptional', options: [['closed', 'Office closed — paid day off'], ['relaxed', 'Attendance relaxed — no late, short or absent marks'], ['half_day', 'Half day — only half the shift needed']] },
      { name: 'branch_id', label: 'Branch', type: 'select', placeholder: 'All branches', options: () => options('branches'), numeric: true },
      { name: 'note', label: 'Note', full: true },
    ],
    values: { holiday_date: todayLocal(), kind: 'public', treatment: 'closed' },
    columns: [
      { key: 'holiday_date', label: 'Date', render: (x) => h('div', null, h('strong', null, date(x.holiday_date)), h('div', { class: 'tiny muted' }, DOW[(new Date(`${x.holiday_date}T00:00:00Z`).getUTCDay() + 6) % 7])) },
      { key: 'name', label: 'Name', render: (x) => h('strong', null, x.name) },
      { key: 'kind', label: 'Kind', render: (x) => (x.kind === 'public' ? badge('Public holiday', 'violet') : badge({ closed: 'Closed', relaxed: 'Relaxed attendance', half_day: 'Half day' }[x.treatment], 'warn')) },
      { key: 'branch', label: 'Where', render: (x) => (x.branch_id ? lookupName('branches', x.branch_id) : 'All branches') },
    ],
  });
}

async function copyYear(rows, year, ctx) {
  if (!(await confirmDialog(`Copy ${rows.length} holiday(s) to ${year + 1} on the same dates?`, { ok: 'Copy', detail: 'Moving holidays (e.g. Eid) need their dates checked afterwards.' }))) return;
  for (const r of rows) {
    const d = `${year + 1}${r.holiday_date.slice(4)}`;
    try { await api.post('/api/holidays', { holiday_date: d, name: r.name, kind: r.kind, treatment: r.treatment, branch_id: r.branch_id, note: r.note }); } catch { /* invalid date like 29 Feb */ }
  }
  toast('Copied');
  navigate(`/settings/holidays?year=${year + 1}`);
}

/* ------------------------------------------------------------------ leave types */
async function leaveTypes(body, ctx) {
  const rows = await api.get('/api/leave-types');
  listSection(body, {
    title: 'Leave types', rows, endpoint: '/api/leave-types', onSaved: ctx.reload, size: 'lg',
    intro: h('p', { class: 'muted small' }, `Allocations are made for each leave year (starting month ${ctx.org.org.settings.leave_year_start_month}). Leftover days carry forward up to each type’s limit; the rest lapses.`),
    fields: [
      { name: 'name', label: 'Name', required: true }, { name: 'code', label: 'Code', required: true, placeholder: 'e.g. AL' },
      { name: 'annual_quota', label: 'Days per year', type: 'number', min: 0, step: '0.5', help: '0 with “may go below zero” = unlimited (e.g. unpaid leave).' },
      { name: 'carry_forward_max', label: 'Carry forward at most', type: 'number', min: 0, step: '0.5', suffix: 'days' },
      { name: 'color', label: 'Colour', type: 'color' },
      { name: 'gender', label: 'For', type: 'select', options: [['any', 'Everyone'], ['female', 'Women'], ['male', 'Men']] },
      { name: 'min_notice_days', label: 'Notice needed', type: 'number', min: 0, suffix: 'days' },
      { name: 'max_days_per_request', label: 'Most days in one request', type: 'number', min: 0 },
      { name: 'paid', label: 'Paid leave', type: 'checkbox', default: true },
      { name: 'allow_half_day', label: 'Half days allowed', type: 'checkbox', default: true },
      { name: 'allow_in_probation', label: 'Can be taken during probation', type: 'checkbox' },
      { name: 'prorate_on_join', label: 'Prorate for people who join mid-year', type: 'checkbox', default: true },
      { name: 'count_off_days', label: 'Weekends and holidays inside the leave count as leave', type: 'checkbox' },
      { name: 'allow_negative', label: 'Balance may go below zero', type: 'checkbox' },
      { name: 'active', label: 'Active', type: 'checkbox', default: true },
    ],
    values: { annual_quota: 10, carry_forward_max: 0, color: '#2563eb', gender: 'any', paid: true, allow_half_day: true, prorate_on_join: true, active: true },
    columns: [
      { key: 'name', label: 'Leave type', render: (t) => h('span', { class: 'row' }, h('span', { class: 'swatch', style: { background: t.color || 'var(--brand)' } }), h('strong', null, t.name), h('span', { class: 'tiny muted' }, t.code)) },
      { key: 'quota', label: 'Per year', render: (t) => (Number(t.annual_quota) ? `${num(t.annual_quota)} days` : t.allow_negative ? 'Unlimited' : '—') },
      { key: 'cf', label: 'Carry forward', render: (t) => (Number(t.carry_forward_max) ? `up to ${num(t.carry_forward_max)}` : '—') },
      { key: 'flags', label: '', render: (t) => h('div', { class: 'row gap-4 wrap' }, t.paid ? badge('Paid', 'ok') : badge('Unpaid'), t.allow_in_probation ? badge('In probation', 'info') : null, t.gender !== 'any' ? badge(sentence(t.gender)) : null, t.active ? null : badge('Off')) },
    ],
  });
}

/* ------------------------------------------------------------------ salary components */
async function components(body, ctx) {
  const rows = await api.get('/api/salary-components');
  const edit = can('salary.edit');
  const calcText = (c) => ({ fixed: c.value ? `Fixed ${money(c.value)}` : 'Fixed (set per person)', percent: `${num(c.value)}% of ${c.percent_of === 'GROSS' || !c.percent_of ? 'gross' : c.percent_of}`, formula: c.formula, remainder: 'Rest of gross' }[c.calc]);
  listSection(body, {
    title: 'Salary components', rows, endpoint: '/api/salary-components', onSaved: ctx.reload, canEdit: edit, size: 'lg',
    intro: h('div', null, alertBox(h('span', null, 'Components make up the salary: basic, house rent, fuel, medical… Each has a ', h('strong', null, 'code'), ' you can use in formulas, e.g. ', h('code', null, 'BASIC * 0.45'), ' or ', h('code', null, 'min(GROSS * 0.1, 5000)'), '. ', h('code', null, 'GROSS'), ' is the employee’s monthly gross. Functions: min, max, round, floor, ceil, abs, if(condition, a, b).'), 'info', 'coins')),
    fields: [
      { name: 'name', label: 'Name', required: true, placeholder: 'e.g. House rent' },
      { name: 'code', label: 'Code', required: true, placeholder: 'e.g. HOUSE_RENT', help: 'Capital letters, numbers, _. Cannot change later.' },
      { name: 'kind', label: 'Type', type: 'select', options: [['earning', 'Earning'], ['deduction', 'Deduction'], ['employer', 'Employer contribution (information only)']] },
      { name: 'calc', label: 'Default calculation', type: 'select', options: [['fixed', 'Fixed amount'], ['percent', 'Percentage of…'], ['formula', 'Formula'], ['remainder', 'Rest of gross (balancing figure)']] },
      { name: 'value', label: 'Amount / percentage', type: 'number', step: 'any', show: (v) => v.calc === 'fixed' || v.calc === 'percent' },
      { name: 'percent_of', label: 'Percentage of', type: 'select', show: (v) => v.calc === 'percent', options: () => [['GROSS', 'Gross salary'], ...rows.map((c) => [c.code, `${c.name} (${c.code})`])] },
      { name: 'formula', label: 'Formula', full: true, show: (v) => v.calc === 'formula', placeholder: 'e.g. floor(GROSS / 1.55)' },
      { name: 'taxable', label: 'Taxable', type: 'checkbox', default: true },
      { name: 'attendance_based', label: 'Reduced for absences, unpaid leave and lates', type: 'checkbox', default: true },
      { name: 'prorate', label: 'Prorated for joiners and leavers', type: 'checkbox', default: true },
      { name: 'show_on_payslip', label: 'Show on payslip', type: 'checkbox', default: true },
      { name: 'sort', label: 'Order', type: 'number' },
      { name: 'active', label: 'Active', type: 'checkbox', default: true },
    ],
    values: { kind: 'earning', calc: 'fixed', value: 0, percent_of: 'GROSS', taxable: true, attendance_based: true, prorate: true, show_on_payslip: true, active: true, sort: rows.length },
    prepare: (v, row) => { const out = { ...v }; if (row) delete out.code; return out; },
    columns: [
      { key: 'name', label: 'Component', render: (c) => h('div', null, h('strong', null, c.name), h('div', { class: 'tiny muted mono' }, c.code)) },
      { key: 'kind', label: 'Type', render: (c) => badge(sentence(c.kind), { earning: 'ok', deduction: 'bad', employer: 'info' }[c.kind]) },
      { key: 'calc', label: 'Default', render: (c) => h('span', { class: c.calc === 'formula' ? 'mono small' : '' }, calcText(c)) },
      { key: 'flags', label: '', render: (c) => h('div', { class: 'row gap-4 wrap' }, c.taxable ? badge('Taxable') : null, c.attendance_based ? badge('Attendance') : null, c.active ? null : badge('Off', 'warn')) },
    ],
  });
}

/* ------------------------------------------------------------------ salary structures */
async function structures(body, ctx) {
  const rows = await api.get('/api/salary-structures');
  const comps = S.lookups.components.filter((c) => c.active);
  const edit = async (s = null) => {
    let lines = s ? s.lines.map((l) => ({ component_id: l.component_id, calc: l.calc, value: l.value, percent_of: l.percent_of, formula: l.formula })) : comps.filter((c) => c.kind === 'earning').map((c) => ({ component_id: c.id, calc: c.calc, value: c.value, percent_of: c.percent_of, formula: c.formula }));
    const tbody = h('tbody');
    const draw = () => clear(tbody, lines.map((l, i) => {
      const c = comps.find((x) => x.id === Number(l.component_id));
      return h('tr', null,
        h('td', null, h('select', { class: 'input sm', onchange: (e) => { l.component_id = Number(e.target.value); } }, comps.map((x) => h('option', { value: x.id, selected: x.id === Number(l.component_id) }, x.name)))),
        h('td', null, h('select', { class: 'input sm', onchange: (e) => { l.calc = e.target.value; draw(); } }, [['fixed', 'Fixed'], ['percent', '% of'], ['formula', 'Formula'], ['remainder', 'Rest of gross']].map(([k, t]) => h('option', { value: k, selected: k === l.calc }, t)))),
        h('td', null, l.calc === 'fixed' || l.calc === 'percent' ? h('input', { class: 'input sm num', type: 'number', step: 'any', value: l.value ?? 0, oninput: (e) => { l.value = Number(e.target.value) || 0; } }) : l.calc === 'formula' ? h('input', { class: 'input sm mono', value: l.formula || '', oninput: (e) => { l.formula = e.target.value; } }) : ''),
        h('td', null, l.calc === 'percent' ? h('select', { class: 'input sm', onchange: (e) => { l.percent_of = e.target.value; } }, ['GROSS', ...comps.map((x) => x.code).filter((x) => !c || x !== c.code)].map((x) => h('option', { value: x, selected: (l.percent_of || 'GROSS') === x }, x))) : ''),
        h('td', null, h('button', { class: 'icon-btn', onclick: () => { lines.splice(i, 1); draw(); } }, icon('x', 15))));
    }));
    draw();
    const ok = await formModal({
      title: s ? `Edit ${s.name}` : 'New salary structure', size: 'lg',
      fields: [{ name: 'name', label: 'Name', required: true }, { name: 'description', label: 'Description' },
        { node: h('div', null, h('div', { class: 'table-wrap', style: { border: '1px solid var(--line)', borderRadius: '10px' } }, h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'Component'), h('th', null, 'Calculation'), h('th', null, 'Value'), h('th', null, 'Of'), h('th'))), tbody)),
          h('button', { class: 'btn sm mt-8', type: 'button', onclick: () => { if (comps[0]) { lines.push({ component_id: comps[0].id, calc: 'fixed', value: 0 }); draw(); } } }, icon('plus', 14), 'Add line')) }],
      values: s || {},
      onSubmit: (v) => (s ? api.put(`/api/salary-structures/${s.id}`, { ...v, lines }) : api.post('/api/salary-structures', { ...v, lines })),
      danger: s ? { label: 'Delete', onClick: async () => { await api.del(`/api/salary-structures/${s.id}`); toast('Deleted'); ctx.reload(); } } : null,
    });
    if (ok === true) { toast('Saved'); await loadLookups(true); ctx.reload(); }
  };
  body.append(card('Salary structures', h('div', null,
    h('div', { style: { padding: '14px 18px 0' } }, alertBox('A structure is a ready-made split of the gross salary (e.g. “Standard”: basic = gross ÷ 1.55, house rent 45% of basic, utilities 10% of basic). Pick it when setting someone’s salary, then adjust if needed.', 'info', 'layers')),
    table({ rows, onRow: can('salary.edit') ? (s) => edit(s) : null, columns: [
      { key: 'name', label: 'Structure', render: (s) => h('div', null, h('strong', null, s.name), h('div', { class: 'tiny muted' }, s.description || '')) },
      { key: 'lines', label: 'Components', render: (s) => s.lines.map((l) => l.name).join(', ') },
    ] })), { flush: true, actions: can('salary.edit') ? h('button', { class: 'btn sm primary', onclick: () => edit() }, icon('plus', 14), 'New structure') : null }));
}

/* ------------------------------------------------------------------ tax */
async function tax(body) {
  let slabs = await api.get('/api/tax-slabs');
  const tbody = h('tbody');
  const edit = can('salary.edit');
  const draw = () => clear(tbody, slabs.length ? slabs.map((s, i) => h('tr', null,
    h('td', null, h('input', { class: 'input sm num', type: 'number', value: s.from_amount, disabled: !edit, oninput: (e) => { s.from_amount = Number(e.target.value) || 0; } })),
    h('td', null, h('input', { class: 'input sm num', type: 'number', value: s.to_amount ?? '', placeholder: 'and above', disabled: !edit, oninput: (e) => { s.to_amount = e.target.value === '' ? null : Number(e.target.value); } })),
    h('td', null, h('input', { class: 'input sm num', type: 'number', value: s.fixed_tax, disabled: !edit, oninput: (e) => { s.fixed_tax = Number(e.target.value) || 0; } })),
    h('td', null, h('input', { class: 'input sm num', type: 'number', step: 'any', value: s.rate, disabled: !edit, oninput: (e) => { s.rate = Number(e.target.value) || 0; } })),
    edit ? h('td', null, h('button', { class: 'icon-btn', onclick: () => { slabs.splice(i, 1); draw(); } }, icon('x', 15))) : null))
    : h('tr', null, h('td', { colspan: 5, class: 'muted center', style: { padding: '20px' } }, 'No slabs: no income tax is deducted.')));
  draw();
  body.append(card('Income tax slabs (yearly income)', h('div', null,
    alertBox('Payroll works out the yearly taxable income (monthly taxable × 12), finds its slab, and deducts one twelfth of the yearly tax each month: tax = fixed amount + rate % of the income above “from”. Enter the slabs your tax authority publishes, and update them when the law changes.', 'info', 'percent'),
    h('div', { class: 'table-wrap mt-16' }, h('table', { class: 'table compact' }, h('thead', null, h('tr', null, h('th', null, 'From'), h('th', null, 'To'), h('th', null, 'Fixed tax'), h('th', null, 'Rate % above “from”'), edit ? h('th') : null)), tbody)),
    edit ? h('div', { class: 'row mt-16' },
      h('button', { class: 'btn sm', onclick: () => { const last = slabs[slabs.length - 1]; slabs.push({ from_amount: last ? last.to_amount || last.from_amount : 0, to_amount: null, fixed_tax: 0, rate: 0 }); draw(); } }, icon('plus', 14), 'Add slab'),
      h('button', { class: 'btn sm', onclick: () => { slabs = pkSalaried(); draw(); toast('Example loaded — check it against the current law, then save'); } }, 'Load example (Pakistan salaried)'),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn primary', onclick: async () => { try { await api.put('/api/tax-slabs', { slabs }); toast('Saved'); } catch (err) { errorToast(err); } } }, 'Save slabs')) : null)));
}

// An EXAMPLE only (Pakistan, salaried individuals, tax year 2026 as announced in the 2025 budget).
// Tax law changes every year: the organization must check and maintain its own slabs.
function pkSalaried() {
  return [
    { from_amount: 0, to_amount: 600000, fixed_tax: 0, rate: 0 },
    { from_amount: 600000, to_amount: 1200000, fixed_tax: 0, rate: 1 },
    { from_amount: 1200000, to_amount: 2200000, fixed_tax: 6000, rate: 11 },
    { from_amount: 2200000, to_amount: 3200000, fixed_tax: 116000, rate: 23 },
    { from_amount: 3200000, to_amount: 4100000, fixed_tax: 346000, rate: 30 },
    { from_amount: 4100000, to_amount: null, fixed_tax: 616000, rate: 35 },
  ];
}

/* ------------------------------------------------------------------ users */
async function users(body, ctx) {
  const rows = await api.get('/api/users');
  const roles = ctx.org.roles;
  const roleOpts = Object.entries(roles).map(([k, r]) => [k, r.label]);
  const linked = new Set(rows.map((r) => r.employee_id).filter(Boolean));
  const add = async () => {
    const ok = await formModal({
      title: 'Add a user',
      fields: [
        { name: 'employee_id', label: 'Employee', type: 'select', placeholder: '— Not an employee (e.g. outside accountant) —', options: () => employeeOptions().filter(([id]) => !linked.has(id)), numeric: true, full: true },
        { name: 'name', label: 'Name' }, { name: 'email', label: 'Email', type: 'email' },
        { name: 'username', label: 'Username', required: true }, { name: 'password', label: 'Temporary password', help: 'At least 8 characters.' },
        { name: 'role', label: 'Role', type: 'select', options: roleOpts },
        { name: 'add_existing', label: 'This person already has a Broadwing HR account (in another organization): just give them access here', type: 'checkbox' },
      ],
      values: { role: 'employee' },
      onSubmit: (v) => {
        if (!v.name && v.employee_id) v.name = (S.lookups.employees.find((e) => e.id === v.employee_id) || {}).name;
        return api.post('/api/users', v);
      },
    });
    if (ok) { toast('User added'); ctx.reload(); }
  };
  const edit = async (u) => {
    const ok = await formModal({
      title: `${u.name} (@${u.username})`, one: true,
      fields: [
        { name: 'role', label: 'Role', type: 'select', options: roleOpts },
        { name: 'employee_id', label: 'Employee record', type: 'select', placeholder: '— None —', options: () => employeeOptions().filter(([id]) => !linked.has(id) || id === u.employee_id), numeric: true },
        { name: 'active', label: 'Can sign in', type: 'checkbox' },
        { name: 'password', label: 'Set a new password (optional)', type: 'text' },
      ],
      values: { ...u, active: !!u.active, password: '' },
      onSubmit: (v) => { if (!v.password) delete v.password; return api.put(`/api/users/${u.id}`, v); },
      danger: { label: 'Remove access', onClick: async () => { if (!(await confirmDialog(`Remove ${u.name}'s access to this organization?`, { danger: true, ok: 'Remove' }))) return false; try { await api.del(`/api/users/${u.id}`); toast('Removed'); ctx.reload(); } catch (err) { errorToast(err); return false; } } },
    });
    if (ok === true) { toast('Saved'); ctx.reload(); }
  };
  body.append(card('Users & roles', h('div', null,
    h('div', { style: { padding: '14px 18px 0' } }, alertBox(h('div', null, Object.values(roles).map((r) => h('div', null, h('strong', null, r.label), ': ', r.perms.length ? r.perms.map((p) => p.replace('.', ' ')).join(', ') : 'their own attendance, leave and payslips')),
      h('div', { class: 'mt-8' }, 'Line managers need no special role: anyone with people under them on the organogram sees their team and approves their requests.')), 'info', 'key')),
    table({
      rows, search: 'Search…', onRow: (u) => edit(u),
      columns: [
        { key: 'name', label: 'User', sort: true, render: (u) => h('div', null, h('div', { class: 'strong' }, u.name), h('div', { class: 'tiny muted' }, `@${u.username}${u.email ? ` · ${u.email}` : ''}`)) },
        { key: 'role', label: 'Role', sort: true, render: (u) => badge(roles[u.role] ? roles[u.role].label : u.role, u.role === 'admin' ? 'brand' : '') },
        { key: 'employee', label: 'Employee', render: (u) => (u.employee_id ? lookupName('employees', u.employee_id) : h('span', { class: 'faint' }, '—')) },
        { key: 'last_login_at', label: 'Last sign-in', sort: true, render: (u) => (u.last_login_at ? utcToLocal(u.last_login_at) : 'Never') },
        { key: 'active', label: '', render: (u) => (u.active && u.user_active ? badge('Active', 'ok') : badge('Off')) },
      ],
    })), { flush: true, actions: h('button', { class: 'btn sm primary', onclick: add }, icon('plus', 14), 'Add user') }));
}

/* ------------------------------------------------------------------ checklists */
async function checklists(body, ctx) {
  const rows = await api.get('/api/checklist-items');
  for (const [stage, title] of [['onboarding', 'Onboarding checklist'], ['exit', 'Exit checklist']]) {
    listSection(body, {
      title, rows: rows.filter((r) => r.stage === stage), endpoint: '/api/checklist-items', onSaved: ctx.reload, name: (r) => r.title,
      intro: h('p', { class: 'muted small' }, stage === 'onboarding' ? 'Copied to every new employee’s profile.' : 'Copied to the profile when someone leaves.'),
      fields: [{ name: 'title', label: 'Item', required: true, full: true }, { name: 'sort', label: 'Order', type: 'number' }, { name: 'active', label: 'Active', type: 'checkbox', default: true }],
      values: { stage, active: true, sort: 0 },
      prepare: (v) => ({ ...v, stage }),
      columns: [{ key: 'title', label: 'Item' }, { key: 'active', label: '', render: activeBadge }],
    });
    body.append(h('div', { class: 'mt-16' }));
  }
}

/* ------------------------------------------------------------------ audit */
async function audit(body) {
  const rows = await api.get('/api/audit', { limit: 300 });
  body.append(card('Activity log', table({
    rows, search: 'Search…', compact: true, pageSize: 100,
    columns: [
      { key: 'created_at', label: 'When', render: (r) => utcToLocal(r.created_at) },
      { key: 'user_name', label: 'Who', render: (r) => r.user_name || 'System' },
      { key: 'action', label: 'What', render: (r) => h('span', { class: 'mono small' }, r.action) },
      { key: 'details', label: 'Details', text: (r) => r.details || '', render: (r) => h('span', { class: 'small muted', style: { display: 'block', maxWidth: '520px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, title: r.details || '' }, r.details || '') },
    ],
  }), { flush: true }));
}
