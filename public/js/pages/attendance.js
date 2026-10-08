// Attendance for HR and managers: today, the monthly sheet, punches, corrections, machines and imports.
import { api } from '../api.js';
import { S, can, options, employeeOptions, navigate } from '../state.js';
import {
  h, clear, icon, pageHead, card, tabs, table, person, attBadge, attKey, ATT, time, date, duration, num, stat, monthLabel, addMonths, todayLocal,
  addDays, DOW, weekday, toast, errorToast, formModal, confirmDialog, modal, alertBox, empty, badge, sentence, ago, pickFile, download, kv,
} from '../ui.js';
import { overrideDay } from './widgets.js';

export default async function attendancePage(view, params, query) {
  const tab = params.tab || 'today';
  const manage = can('attendance.manage');
  view.append(pageHead('Attendance', { sub: 'From attendance machines, phones and manual entries — calculated with your policies.' }));
  view.append(tabs([
    { id: 'today', label: 'Daily', href: '#/attendance', icon: 'clock' },
    { id: 'sheet', label: 'Monthly sheet', href: '#/attendance/sheet', icon: 'calendar' },
    { id: 'punches', label: 'Punches', href: '#/attendance/punches', icon: 'finger' },
    { id: 'corrections', label: 'Corrections', href: '#/attendance/corrections', icon: 'edit' },
    manage ? { id: 'machines', label: 'Machines & import', href: '#/attendance/machines', icon: 'device' } : null,
  ], tab));
  const body = h('div');
  view.append(body);
  await ({ today, sheet, punches, corrections, machines }[tab] || today)(body, query);
}

const deptSelect = (value, onChange) => h('select', { class: 'input sm', style: { width: '190px' }, onchange: (e) => onChange(e.target.value) },
  h('option', { value: '' }, 'All departments'), options('departments').map(([id, n]) => h('option', { value: id, selected: String(id) === String(value) }, n)));

/* ------------------------------------------------------------------ daily */
async function today(body, query) {
  let day = query.date || todayLocal();
  let dept = '';
  const holder = h('div');
  const dateInput = h('input', { class: 'input sm', type: 'date', value: day, style: { width: '160px' }, onchange: (e) => { day = e.target.value; load(); } });
  body.append(h('div', { class: 'toolbar' },
    h('button', { class: 'icon-btn', onclick: () => { day = addDays(day, -1); dateInput.value = day; load(); }, 'aria-label': 'Previous day' }, icon('left')),
    dateInput,
    h('button', { class: 'icon-btn', onclick: () => { day = addDays(day, 1); dateInput.value = day; load(); }, 'aria-label': 'Next day' }, icon('right')),
    h('button', { class: 'btn sm', onclick: () => { day = todayLocal(); dateInput.value = day; load(); } }, 'Today'),
    h('div', { class: 'spacer' }), deptSelect(dept, (v) => { dept = v; load(); }),
    h('button', { class: 'btn sm', onclick: load }, icon('refresh', 14), 'Refresh')), holder);

  async function load() {
    const d = await api.get('/api/attendance/day', { date: day, department_id: dept });
    const t = d.totals;
    clear(holder,
      h('div', { class: 'grid grid-4 mb-16' },
        stat('Present', `${t.present} / ${t.people}`, { ic: 'checkCircle', color: 'var(--ok)', bg: 'var(--ok-soft)' }),
        stat('Late', t.late, { ic: 'clock', color: 'var(--warn)', bg: 'var(--warn-soft)' }),
        stat('On leave', t.leave, { ic: 'calendar', color: 'var(--info)', bg: 'var(--info-soft)' }),
        stat(day === todayLocal() ? 'Not in yet' : 'Absent', t.absent, { ic: 'alert', color: 'var(--bad)', bg: 'var(--bad-soft)', hint: t.missing ? `${t.missing} missing a punch` : null })),
      card(null, table({
        rows: d.rows, search: 'Search people…', pageSize: 100,
        onRow: (r) => navigate(`/employees/${r.id}/attendance`),
        columns: [
          { key: 'name', label: 'Employee', sort: true, render: (r) => person(r.name, `${r.emp_code}${r.department ? ` · ${r.department}` : ''}`, { photo: r.has_photo, id: r.id }) },
          { key: 'status', label: 'Status', sort: (r) => attKey(r.day), render: (r) => h('div', { class: 'row gap-4 wrap' }, attBadge(r.day), r.day && r.day.manual ? badge('Set by HR', 'violet') : null) },
          { key: 'in', label: 'In', sort: (r) => (r.day && r.day.first_in) || '', render: (r) => (r.day ? time(r.day.first_in) : '—') },
          { key: 'out', label: 'Out', sort: (r) => (r.day && r.day.last_out) || '', render: (r) => (r.day ? time(r.day.last_out) : '—') },
          { key: 'late', label: 'Late', num: true, sort: (r) => (r.day && r.day.late_minutes) || 0, render: (r) => (r.day && r.day.late_minutes ? h('span', { style: { color: 'var(--warn)', fontWeight: 600 } }, duration(r.day.late_minutes)) : '—') },
          { key: 'worked', label: 'Worked', num: true, className: 'hide-sm', render: (r) => (r.day ? duration(r.day.worked_minutes) : '—') },
          { key: 'remarks', label: 'Notes', className: 'hide-sm', render: (r) => h('span', { class: 'small muted' }, r.day ? r.day.remarks || '' : '') },
          can('attendance.manage') ? { key: 'x', label: '', render: (r) => (r.day ? h('button', { class: 'btn xs', onclick: () => overrideDay(r.id, r.day, load) }, icon('edit', 12), 'Set') : null) } : null,
        ].filter(Boolean),
      }), { flush: true }));
  }
  await load();
}

/* ------------------------------------------------------------------ monthly sheet */
async function sheet(body, query) {
  let month = query.month || todayLocal().slice(0, 7);
  let dept = '';
  const holder = h('div');
  const label = h('strong', { style: { minWidth: '130px', textAlign: 'center' } });
  body.append(h('div', { class: 'toolbar' },
    h('button', { class: 'icon-btn', onclick: () => { month = addMonths(month, -1); load(); } }, icon('left')), label,
    h('button', { class: 'icon-btn', onclick: () => { month = addMonths(month, 1); load(); } }, icon('right')),
    h('div', { class: 'spacer' }), deptSelect(dept, (v) => { dept = v; load(); }),
    can('attendance.manage') ? h('button', { class: 'btn sm', onclick: () => load(true) }, icon('refresh', 14), 'Recalculate') : null,
    can('reports.view') ? h('button', { class: 'btn sm', onclick: () => download(`/api/reports/attendance.csv?month=${month}`) }, icon('download', 14), 'Export') : null),
  h('div', { class: 'legend mb-16' }, ['present', 'late', 'absent', 'half_day', 'leave', 'holiday', 'weekend', 'missing'].map((k) => h('span', null, h('i', { class: `st-${k}` }, ATT[k].code), ATT[k].label))),
  holder);

  async function load(refresh = false) {
    label.textContent = monthLabel(month);
    clear(holder, h('div', { class: 'loading' }, h('div', { class: 'spinner' })));
    const d = await api.get('/api/attendance/sheet', { month, department_id: dept, refresh: refresh ? 1 : undefined });
    if (!d.rows.length) { clear(holder, card(null, empty('No one to show', 'There are no employees for this month.', null, 'users'))); return; }
    const today = todayLocal();
    const thead = h('tr', null, h('th', { class: 'name-col' }, 'Employee'),
      d.dates.map((x) => h('th', { class: weekday(x) >= 6 ? 'we' : '' }, h('div', null, x.slice(8)), h('div', { class: 'tiny', style: { fontWeight: 500 } }, DOW[weekday(x) - 1].slice(0, 2)))),
      ['P', 'A', 'LV', 'Late', 'Ded.'].map((t) => h('th', { class: 'sum' }, t)));
    const rows = d.rows.map((r) => {
      const byDate = new Map(r.days.map((x) => [x.work_date, x]));
      return h('tr', null,
        h('td', { class: 'name-col' }, h('a', { href: `#/employees/${r.id}/attendance`, class: 'strong', style: { color: 'var(--text)' } }, r.name), h('div', { class: 'tiny muted' }, r.emp_code)),
        d.dates.map((x) => {
          const day = byDate.get(x);
          const k = day ? attKey(day) : x > today ? 'none' : 'none';
          const tip = day ? `${date(x)} · ${(ATT[k] || { label: k }).label}${day.first_in ? ` · ${time(day.first_in)}–${time(day.last_out)}` : ''}${day.late_minutes ? ` · late ${duration(day.late_minutes)}` : ''}${day.remarks ? ` · ${day.remarks}` : ''}` : date(x);
          return h('td', null, h('div', {
            class: `cell st-${k}`, title: tip,
            onclick: () => (day && can('attendance.manage') ? overrideDay(r.id, day, () => load()) : day ? null : null),
          }, day ? (ATT[k] || { code: '?' }).code : ''));
        }),
        h('td', { class: 'sum' }, num(r.summary.present_days)), h('td', { class: 'sum' }, r.summary.absent_days),
        h('td', { class: 'sum' }, num(r.summary.paid_leave_days + r.summary.unpaid_leave_days)), h('td', { class: 'sum' }, r.summary.late_count),
        h('td', { class: 'sum strong' }, num(r.summary.deduction_days + r.summary.late_deduction_days)));
    });
    clear(holder, h('div', { class: 'card', style: { overflow: 'auto', maxHeight: 'calc(100vh - 300px)' } }, h('table', { class: 'sheet' }, h('thead', null, thead), h('tbody', null, rows))),
      h('p', { class: 'tiny muted mt-8' }, `Period ${date(d.start)} – ${date(d.end)}. "Ded." = days that payroll will deduct (absences, half days, unpaid leave and late penalties) before using any leave balance. ${can('attendance.manage') ? 'Click a day to set it by hand.' : ''}`));
  }
  await load();
}

/* ------------------------------------------------------------------ punches */
async function punches(body) {
  let from = todayLocal();
  let to = todayLocal();
  let source = '';
  let emp = '';
  const holder = h('div');
  const manage = can('attendance.manage');
  body.append(h('div', { class: 'toolbar' },
    h('input', { class: 'input sm', type: 'date', value: from, onchange: (e) => { from = e.target.value; load(); } }), h('span', { class: 'muted' }, 'to'),
    h('input', { class: 'input sm', type: 'date', value: to, onchange: (e) => { to = e.target.value; load(); } }),
    h('select', { class: 'input sm', onchange: (e) => { source = e.target.value; load(); } }, [['', 'All sources'], ['device', 'Machine'], ['mobile', 'Phone'], ['manual', 'Manual'], ['import', 'Imported']].map(([v, l]) => h('option', { value: v }, l))),
    h('select', { class: 'input sm', style: { width: '220px' }, onchange: (e) => { emp = e.target.value; load(); } }, h('option', { value: '' }, 'Everyone'), employeeOptions().map(([v, l]) => h('option', { value: v }, l))),
    h('div', { class: 'spacer' }),
    manage ? h('button', { class: 'btn sm primary', onclick: addPunch }, icon('plus', 14), 'Add punch') : null), holder);

  async function addPunch() {
    const ok = await formModal({
      title: 'Add a punch by hand',
      fields: [
        { name: 'employee_id', label: 'Employee', type: 'select', required: true, options: () => employeeOptions(), numeric: true, placeholder: 'Choose…', full: true },
        { name: 'date', label: 'Date', type: 'date', required: true }, { name: 'time', label: 'Time', type: 'time', required: true },
        { name: 'direction', label: 'Direction', type: 'select', options: [['auto', 'Automatic'], ['in', 'In'], ['out', 'Out']] },
        { name: 'note', label: 'Reason', required: true, full: true },
      ],
      values: { date: todayLocal(), direction: 'auto' },
      onSubmit: (v) => api.post('/api/punches', v),
    });
    if (ok) { toast('Punch added'); load(); }
  }

  async function load() {
    const rows = await api.get('/api/punches', { from, to, source, employee_id: emp });
    clear(holder, card(null, table({
      rows, search: 'Search…', pageSize: 100,
      columns: [
        { key: 'punch_time', label: 'Time', sort: true, render: (p) => h('div', null, h('strong', null, time(p.punch_time)), h('div', { class: 'tiny muted' }, date(p.punch_time))) },
        { key: 'name', label: 'Employee', sort: true, render: (p) => (p.name ? h('a', { href: `#/employees/${p.employee_id}/attendance` }, p.name) : h('span', { class: 'badge warn' }, `Unknown machine no. ${p.device_user_id}`)) },
        { key: 'source', label: 'Source', sort: true, render: (p) => h('span', { class: 'chip' }, icon({ device: 'finger', mobile: 'device', manual: 'edit', import: 'upload' }[p.source] || 'info', 13), sentence(p.source), p.device_name ? ` · ${p.device_name}` : '') },
        { key: 'direction', label: 'In/out', render: (p) => (p.direction === 'auto' ? '—' : sentence(p.direction)) },
        { key: 'where', label: 'Where', className: 'hide-sm', render: (p) => (p.source === 'mobile' ? h('span', { class: 'small' }, p.branch_name ? `${p.branch_name} (${p.distance_m} m)` : p.distance_m !== null ? `${p.distance_m} m from nearest office` : 'No office nearby', ' ',
          p.lat ? h('a', { href: `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}`, target: '_blank', rel: 'noopener' }, 'map') : null) : p.branch_name || '') },
        { key: 'note', label: 'Note', className: 'hide-sm', render: (p) => h('span', { class: 'small muted' }, p.note || '') },
        manage ? { key: 'x', label: '', render: (p) => h('button', { class: 'icon-btn', title: 'Delete', onclick: async () => {
          if (!(await confirmDialog(`Delete the punch at ${time(p.punch_time)}?`, { ok: 'Delete', danger: true }))) return;
          try { await api.del(`/api/punches/${p.id}`); toast('Deleted'); load(); } catch (err) { errorToast(err); }
        } }, icon('trash', 15)) } : null,
      ].filter(Boolean),
    }), { flush: true }));
  }
  await load();
}

/* ------------------------------------------------------------------ corrections */
async function corrections(body) {
  const rows = await api.get('/api/regularizations', { scope: can('attendance.view') ? 'all' : 'team' });
  body.append(card(null, rows.length ? table({
    rows, search: 'Search…',
    columns: [
      { key: 'name', label: 'Employee', sort: true },
      { key: 'work_date', label: 'Day', sort: true, render: (r) => date(r.work_date) },
      { key: 'times', label: 'Times', render: (r) => [r.in_time && `in ${r.in_time}`, r.out_time && `out ${r.out_time}`].filter(Boolean).join(', ') },
      { key: 'reason', label: 'Reason' },
      { key: 'status', label: 'Status', sort: true, render: (r) => badge(sentence(r.status), { pending: 'warn', approved: 'ok', rejected: 'bad' }[r.status] || '') },
      { key: 'x', label: '', render: (r) => (r.can_act ? h('a', { class: 'btn xs', href: '#/approvals' }, 'Review') : null) },
    ],
  }) : empty('No corrections', 'Employees ask for corrections from their phone when they forget to punch.', null, 'edit'), { flush: true }));
}

/* ------------------------------------------------------------------ machines & import */
async function machines(body) {
  const [devices, unmatched] = await Promise.all([api.get('/api/devices'), api.get('/api/punches/unmatched')]);
  const origin = location.origin;
  const reload = () => navigate('/attendance/machines');

  const edit = async (d = null) => {
    const ok = await formModal({
      title: d ? `Edit ${d.name}` : 'Add an attendance machine',
      intro: d ? null : h('p', { class: 'muted small' }, 'For ZKTeco and compatible machines with "ADMS" / "Cloud server" push, choose "Machine pushes" and enter its serial number. For other machines, use the attendance agent or CSV import.'),
      fields: [
        { name: 'name', label: 'Name', required: true, placeholder: 'e.g. Head office entrance' },
        { name: 'kind', label: 'Connection', type: 'select', options: [['adms', 'Machine pushes to this server (ZKTeco ADMS)'], ['api', 'Agent / API with a secret key']] },
        { name: 'serial_no', label: 'Serial number', show: (v) => v.kind === 'adms', help: 'Menu → System info → Device info on the machine.' },
        { name: 'branch_id', label: 'Branch', type: 'select', placeholder: '—', options: () => options('branches'), numeric: true },
        { name: 'active', label: 'Active', type: 'checkbox', default: true },
      ],
      values: d || { kind: 'adms', active: true },
      onSubmit: (v) => (d ? api.put(`/api/devices/${d.id}`, v) : api.post('/api/devices', v)),
      danger: d ? { label: 'Delete', onClick: async () => { if (!(await confirmDialog(`Remove ${d.name}? Its punches are kept.`, { danger: true, ok: 'Remove' }))) return false; await api.del(`/api/devices/${d.id}`); toast('Removed'); reload(); } } : null,
    });
    if (ok === true) { toast('Saved'); reload(); }
  };

  const newKey = async (d) => {
    if (d.has_key && !(await confirmDialog('Make a new key? The old key stops working.', { ok: 'New key' }))) return;
    const { key } = await api.post(`/api/devices/${d.id}/key`);
    modal({
      title: 'Device key', body: h('div', null, h('p', null, 'Copy this key now: it is shown only once.'), h('div', { class: 'code-box' }, key),
        h('p', { class: 'muted small mt-16' }, 'Use it in the attendance agent (agent/.env → HR_DEVICE_KEY) or send punches yourself:'),
        h('div', { class: 'code-box' }, `POST ${origin}/api/device/punches\nX-Device-Key: ${key}\n\n{ "punches": [ { "user_id": "15", "time": "2026-10-08 09:02:11" } ] }`)),
      actions: [h('button', { class: 'btn primary', onclick: async (e) => { try { await navigator.clipboard.writeText(key); toast('Copied'); } catch { /* no clipboard */ } e.target.closest('.overlay').remove(); reload(); } }, icon('copy', 14), 'Copy & close')],
    });
  };

  body.append(h('div', { class: 'grid grid-side' },
    h('div', { class: 'col gap-16' },
      card('Machines', devices.length ? table({
        rows: devices,
        onRow: (d) => edit(d),
        columns: [
          { key: 'name', label: 'Machine', render: (d) => h('div', null, h('div', { class: 'strong' }, d.name), h('div', { class: 'tiny muted' }, d.kind === 'adms' ? `ZKTeco push · SN ${d.serial_no}` : 'Agent / API')) },
          { key: 'branch_id', label: 'Branch', render: (d) => (S.lookups.branches.find((b) => b.id === d.branch_id) || { name: '—' }).name },
          { key: 'last_seen_at', label: 'Last contact', render: (d) => (d.last_seen_at ? h('span', null, badge(ago(d.last_seen_at), Date.now() - new Date(`${d.last_seen_at.replace(' ', 'T')}Z`) < 3600000 ? 'ok' : 'warn', { dot: true })) : badge('Never', '', { dot: true })) },
          { key: 'active', label: 'Status', render: (d) => (d.active ? badge('Active', 'ok') : badge('Off')) },
          { key: 'x', label: '', render: (d) => (d.kind === 'api' ? h('button', { class: 'btn xs', onclick: () => newKey(d) }, icon('key', 12), d.has_key ? 'New key' : 'Get key') : null) },
        ],
      }) : empty('No machines yet', 'Connect your fingerprint / face machines so punches arrive automatically.', h('button', { class: 'btn primary', onclick: () => edit() }, icon('plus', 16), 'Add machine'), 'finger'),
      { flush: true, actions: devices.length ? h('button', { class: 'btn sm primary', onclick: () => edit() }, icon('plus', 14), 'Add machine') : null }),
      card('Import from a file', importBox(reload)),
      unmatched.length ? card('Machine numbers without an employee', h('div', null,
        h('p', { class: 'muted small' }, 'These numbers have punches but no employee has them yet. Put the number in the employee’s profile (Time & attendance → Attendance machine number) and their punches are linked automatically.'),
        table({ rows: unmatched, compact: true, columns: [
          { key: 'device_user_id', label: 'Machine no.', render: (u) => h('strong', null, u.device_user_id) }, { key: 'punches', label: 'Punches', num: true },
          { key: 'first_seen', label: 'First', render: (u) => date(u.first_seen) }, { key: 'last_seen', label: 'Last', render: (u) => date(u.last_seen) }] }))) : null),
    card('How to connect a machine', h('div', { class: 'small col gap-12' },
      h('div', null, h('div', { class: 'strong mb-8' }, '1. ZKTeco push (best)'),
        h('p', null, 'On the machine: Menu → Comm. → Cloud Server Setting (ADMS):'),
        kv([['Server address', location.hostname], ['Server port', location.port || (location.protocol === 'https:' ? '443' : '80')], ['HTTPS', location.protocol === 'https:' ? 'On' : 'Off']]),
        h('p', { class: 'mt-8' }, 'Then add the machine here with its serial number. Punches arrive within seconds.')),
      h('div', null, h('div', { class: 'strong mb-8' }, '2. Attendance agent (pull)'),
        h('p', null, 'For machines on your office network that can’t reach the internet: run the small agent from the agent/ folder on any office PC. It reads the machine every few minutes and sends the punches here with a device key.')),
      h('div', null, h('div', { class: 'strong mb-8' }, '3. CSV / Excel export'),
        h('p', null, 'Export the attendance log from the machine’s software and import it here. Columns needed: the machine number (User ID / AC-No.) or employee number, and the date & time.'))))));
}

function importBox(after) {
  const result = h('div');
  const zone = h('div', { class: 'drop-zone' }, icon('upload', 22), h('div', { class: 'strong mt-8' }, 'Drop a CSV file here or click to choose'), h('div', { class: 'small' }, 'e.g. "User ID, DateTime" or "AC-No., Date, Time"'));
  const handle = async (file) => {
    if (!file) return;
    try {
      const text = await file.text();
      const r = await api.post('/api/attendance/import', { csv: text });
      clear(result, h('div', { class: 'mt-16' }, alertBox(`${r.inserted} punch${r.inserted === 1 ? '' : 'es'} imported · ${r.duplicates} already there · ${r.unmatched} for unknown machine numbers · ${r.invalid} rows skipped.`, r.inserted ? 'ok' : 'warn', 'info')));
      if (r.inserted) toast('Imported');
    } catch (err) { errorToast(err); }
  };
  zone.addEventListener('click', async () => handle(await pickFile('.csv,.txt,text/csv')));
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); handle(e.dataTransfer.files[0]); });
  return h('div', null, zone, result);
}
