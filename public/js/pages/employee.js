// One employee: overview, salary, leave, attendance, documents and history.
import { api } from '../api.js';
import { can, loadLookups, navigate, lookupName } from '../state.js';
import {
  h, clear, icon, pageHead, card, kv, avatar, empStatus, badge, date, money, num, tabs, table, modal, formModal, toast, errorToast,
  confirmDialog, popMenu, empty, alertBox, utcToLocal, sentence, pickFile, readFile, todayLocal,
} from '../ui.js';
import { salaryEditor } from './salaryEditor.js';
import { balanceCards, applyLeave, leaveRequestsTable, attendanceMonth } from './widgets.js';

export default async function employeePage(view, params) {
  const e = await api.get(`/api/employees/${params.id}`);
  const tab = params.tab || 'overview';
  const edit = can('employees.edit');
  const reload = () => navigate(`/employees/${e.id}/${tab}`);

  const meta = [e.designation && e.designation.name, e.department && e.department.name].filter(Boolean).join(' · ');
  const actions = [];
  if (edit) {
    actions.push(h('a', { class: 'btn', href: `#/employees/${e.id}/edit` }, icon('edit', 16), 'Edit'));
    actions.push(h('button', { class: 'btn', 'aria-label': 'More actions', onclick: (ev) => moreMenu(ev.currentTarget, e, reload) }, icon('more', 16)));
  }
  view.append(pageHead(e.name, { crumbs: [{ label: can('employees.view') ? 'Employees' : 'My team', href: '#/employees' }, { label: e.name }], actions }));

  view.append(h('div', { class: 'card mb-16' }, h('div', { class: 'profile-hero' },
    avatar(e.name, { size: 'xl', photo: e.photo }),
    h('div', { class: 'grow' },
      h('div', { class: 'row wrap' }, h('h2', null, e.name), empStatus(e.status), e.employment_type !== 'full_time' ? badge(sentence(e.employment_type)) : null),
      h('div', { class: 'muted' }, meta || 'No designation yet'),
      h('div', { class: 'facts' },
        h('span', null, icon('briefcase', 14), e.emp_code),
        h('span', null, icon('calendar', 14), `Joined ${date(e.join_date)}`),
        e.manager ? h('span', null, icon('user', 14), 'Reports to ', h('a', { href: `#/employees/${e.manager.id}` }, e.manager.name)) : null,
        e.phone ? h('span', null, icon('device', 14), e.phone) : null,
        e.email ? h('span', null, icon('send', 14), e.email) : null)))));

  if (e.status === 'probation' && e.probation_end) {
    const total = e.probation_days || 1;
    const left = e.probation_days_left;
    const pct = Math.max(0, Math.min(100, ((total - Math.max(0, left)) / total) * 100));
    view.append(h('div', { class: 'card mb-16', style: { padding: '14px 18px', borderColor: left <= 7 ? 'var(--warn)' : 'var(--line)' } },
      h('div', { class: 'row wrap' },
        h('div', { class: 'grow' }, h('div', { class: 'strong' }, left < 0 ? `Probation ended ${-left} day(s) ago — please confirm or extend` : left === 0 ? 'Probation ends today' : `On probation: ${left} day(s) left`),
          h('div', { class: 'small muted' }, `${date(e.join_date)} → ${date(e.probation_end)}`), h('div', { class: 'progress mt-8', style: { maxWidth: '420px' } }, h('span', { style: { width: `${pct}%`, background: left <= 7 ? 'var(--warn)' : 'var(--brand)' } }))),
        edit ? h('button', { class: 'btn', onclick: () => extendProbation(e, reload) }, 'Extend') : null,
        edit ? h('button', { class: 'btn ok solid', onclick: () => confirmEmployee(e, reload) }, icon('check', 16), 'Confirm as permanent') : null)));
  }
  if (e.status === 'onboarding' && edit) {
    view.append(h('div', { class: 'mb-16' }, alertBox(h('div', { class: 'row wrap' }, h('span', { class: 'grow' }, `Joining on ${date(e.join_date)}. Complete the onboarding checklist, then start them on their first day.`),
      h('button', { class: 'btn sm primary', onclick: async () => { await api.post(`/api/employees/${e.id}/start`); toast('Started'); reload(); } }, icon('rocket', 14), 'Start now')), 'info', 'info')));
  }

  const showSalary = can('salary.view') || e.can.self;
  const showDocs = can('employees.view') || e.can.self;
  view.append(tabs([
    { id: 'overview', label: 'Overview', href: `#/employees/${e.id}` },
    showSalary ? { id: 'salary', label: 'Salary', href: `#/employees/${e.id}/salary` } : null,
    { id: 'leave', label: 'Leave', href: `#/employees/${e.id}/leave` },
    { id: 'attendance', label: 'Attendance', href: `#/employees/${e.id}/attendance` },
    showDocs ? { id: 'documents', label: 'Documents', href: `#/employees/${e.id}/documents` } : null,
    { id: 'history', label: 'History', href: `#/employees/${e.id}/history` },
  ], tab));
  const body = h('div');
  view.append(body);
  const renderers = { overview, salary: salaryTab, leave: leaveTab, attendance: attendanceTab, documents: documentsTab, history: historyTab };
  await (renderers[tab] || overview)(body, e, reload);
}

/* ------------------------------------------------------------------ overview */
async function overview(body, e, reload) {
  const left = h('div', { class: 'col gap-16' });
  const right = h('div', { class: 'col gap-16' });
  body.append(h('div', { class: 'grid grid-side' }, left, right));
  left.append(card('Job', kv([
    ['Employee number', e.emp_code], ['Designation', e.designation && e.designation.name], ['Department', e.department && e.department.name],
    ['Grade', e.grade && e.grade.name], ['Branch', e.branch && e.branch.name], ['Line manager', e.manager ? h('a', { href: `#/employees/${e.manager.id}` }, e.manager.name) : 'Top of the organogram'],
    ['Employment type', sentence(e.employment_type)], ['Joined', date(e.join_date)],
    e.probation_end ? ['Probation', `${e.probation_days} days, ${e.status === 'probation' ? 'ends' : 'ended'} ${date(e.probation_end)}`] : null,
    e.confirmed_on ? ['Confirmed', date(e.confirmed_on)] : null,
    e.exit_date ? ['Last day', `${date(e.exit_date)}${e.exit_reason ? ` · ${sentence(e.exit_reason)}` : ''}`] : null,
  ])));
  left.append(card('Time & attendance', kv([
    ['Shift', e.shift ? `${e.shift.name} (${e.shift.start_time}–${e.shift.end_time})` : 'Organization default'],
    ['Attendance policy', lookupName('policies', e.policy_id, 'Organization default')],
    ['Machine number', e.device_user_id || h('span', { class: 'faint' }, 'Not enrolled')],
    ['Mobile attendance', { none: 'Off (machine only)', anywhere: 'From anywhere', geofence: 'Inside office geofence' }[e.remote_attendance]],
    e.remote_attendance === 'geofence' ? ['Allowed offices', (e.geofences.length ? e.geofences.map((id) => lookupName('branches', id)) : [e.branch ? `${e.branch.name} (own branch)` : 'None']).join(', ')] : null,
    ['Attendance tracked', e.attendance_required ? 'Yes' : 'No — no absence deductions'],
  ])));
  left.append(card('Personal', kv([
    ['Father / guardian', e.father_name], ['Gender', e.gender && sentence(e.gender)], ['Date of birth', e.dob && date(e.dob)], ['Marital status', e.marital_status && sentence(e.marital_status)],
    'national_id' in e ? ['National ID', e.national_id] : null, ['Phone', e.phone], ['Email', e.email], ['Address', e.address],
    ['Emergency contact', e.emergency_name ? `${e.emergency_name}${e.emergency_relation ? ` (${e.emergency_relation})` : ''} · ${e.emergency_phone || ''}` : null],
  ])));
  if ('bank_account_no' in e) {
    left.append(card('Pay & bank', kv([
      ['Paid by', sentence(e.payment_method)], ['Bank', e.bank_name], ['Account title', e.bank_account_title], ['Account number', e.bank_account_no], ['IBAN', e.bank_iban],
      ['Tax number', e.tax_number], ['Income tax', e.tax_exempt ? 'Exempt' : 'Deducted per slabs'],
    ])));
  }
  if (e.notes && 'national_id' in e) left.append(card('HR notes', h('p', { style: { whiteSpace: 'pre-wrap' } }, e.notes)));

  right.append(card(`Team (${e.reports.length})`, e.reports.length ? h('ul', { class: 'list' }, e.reports.map((r) => h('li', { class: 'click', onclick: () => navigate(`/employees/${r.id}`) }, avatar(r.name, { size: 'sm' }), h('span', { class: 'grow' }, r.name), h('span', { class: 'tiny muted' }, r.emp_code))))
    : h('p', { class: 'muted', style: { padding: '14px 18px', margin: 0 } }, 'Nobody reports to them.'), { flush: true, actions: h('a', { class: 'btn sm ghost', href: `#/organogram?focus=${e.id}` }, icon('org', 14), 'Chart') }));

  if (can('users.manage')) {
    right.append(card('Sign-in', e.account
      ? kv([['Username', e.account.username], ['Role', sentence(e.account.role)], ['Active', e.account.active ? 'Yes' : 'No']])
      : h('div', null, h('p', { class: 'muted' }, 'No sign-in yet. With one they can check in from their phone, apply for leave and see payslips.'),
        h('button', { class: 'btn sm primary', onclick: () => createAccount(e, reload) }, icon('plus', 14), 'Create sign-in'))));
  }
  if (can('employees.view')) {
    const list = await api.get(`/api/employees/${e.id}/checklist`);
    if (list.length) right.append(checklistCard(e, list, reload));
  }
}

function checklistCard(e, list, reload) {
  const groups = ['onboarding', 'exit'].map((stage) => [stage, list.filter((x) => x.stage === stage)]).filter(([, l]) => l.length);
  const edit = can('employees.edit');
  return card('Checklists', h('div', null, groups.map(([stage, items]) => {
    const done = items.filter((i) => i.done_at).length;
    return h('div', { class: 'mb-16' },
      h('div', { class: 'row mb-8' }, h('strong', { class: 'grow' }, stage === 'onboarding' ? 'Onboarding' : 'Exit'), h('span', { class: 'small muted' }, `${done}/${items.length}`)),
      h('div', { class: 'progress mb-8' }, h('span', { style: { width: `${(done / items.length) * 100}%`, background: done === items.length ? 'var(--ok)' : 'var(--brand)' } })),
      items.map((it) => h('label', { class: 'check' }, h('input', {
        type: 'checkbox', checked: !!it.done_at, disabled: !edit,
        onchange: async (ev) => { try { await api.put(`/api/employees/${e.id}/checklist/${it.id}`, { done: ev.target.checked }); } catch (err) { errorToast(err); ev.target.checked = !ev.target.checked; } },
      }), h('span', null, it.title))));
  }), edit ? h('button', { class: 'btn sm ghost', onclick: async () => {
    const ok = await formModal({ title: 'Add a checklist item', fields: [{ name: 'title', label: 'Item', required: true, full: true }, { name: 'stage', label: 'List', type: 'select', options: [['onboarding', 'Onboarding'], ['exit', 'Exit']] }], values: { stage: 'onboarding' }, onSubmit: (v) => api.post(`/api/employees/${e.id}/checklist`, v) });
    if (ok) reload();
  } }, icon('plus', 14), 'Add item') : null));
}

/* ------------------------------------------------------------------ actions */
function moreMenu(anchor, e, reload) {
  popMenu(anchor, [
    e.status === 'probation' ? { label: 'Confirm as permanent', icon: 'checkCircle', onClick: () => confirmEmployee(e, reload) } : null,
    e.status === 'probation' ? { label: 'Extend probation', icon: 'clock', onClick: () => extendProbation(e, reload) } : null,
    e.status === 'onboarding' ? { label: 'Start (first day)', icon: 'rocket', onClick: async () => { await api.post(`/api/employees/${e.id}/start`); toast('Started'); reload(); } } : null,
    !['exited'].includes(e.status) ? { label: e.status === 'notice' ? 'Change last day' : 'Resignation / exit', icon: 'logout', onClick: () => exitEmployee(e, reload) } : null,
    ['exited', 'notice'].includes(e.status) ? { label: 'Rehire', icon: 'refresh', onClick: () => rehire(e, reload) } : null,
    !['exited', 'suspended'].includes(e.status) ? { label: 'Suspend', icon: 'pause', onClick: () => suspend(e, true, reload) } : null,
    e.status === 'suspended' ? { label: 'Lift suspension', icon: 'play', onClick: () => suspend(e, false, reload) } : null,
    { label: 'Add a note to history', icon: 'edit', onClick: () => addNote(e, reload) },
    can('users.manage') && !e.account ? { label: 'Create sign-in', icon: 'key', onClick: () => createAccount(e, reload) } : null,
    '-',
    { label: 'Delete record', icon: 'trash', danger: true, onClick: () => deleteEmployee(e) },
  ]);
}

async function confirmEmployee(e, reload) {
  const ok = await formModal({
    title: `Confirm ${e.name} as permanent`, size: 'sm', submit: 'Confirm',
    fields: [{ name: 'date', label: 'Confirmed from', type: 'date', required: true }, { name: 'note', label: 'Note', type: 'textarea', full: true }],
    values: { date: e.probation_end && e.probation_end < todayLocal() ? e.probation_end : todayLocal() }, one: true,
    onSubmit: (v) => api.post(`/api/employees/${e.id}/confirm`, v),
  });
  if (ok) { toast(`${e.name} is now permanent`); reload(); }
}

async function extendProbation(e, reload) {
  const ok = await formModal({
    title: 'Extend probation', size: 'sm', one: true, submit: 'Extend',
    fields: [{ name: 'days', label: 'Extend by', type: 'number', min: 1, max: 365, suffix: 'days', required: true }, { name: 'note', label: 'Reason', type: 'textarea' }],
    values: { days: 30 }, onSubmit: (v) => api.post(`/api/employees/${e.id}/extend-probation`, v),
  });
  if (ok) { toast('Probation extended'); reload(); }
}

async function exitEmployee(e, reload) {
  const ok = await formModal({
    title: `${e.name} is leaving`, submit: 'Save',
    intro: h('p', { class: 'muted small' }, 'Payroll pays them up to their last day. People who report to them move to their manager when they leave. Their sign-in is switched off.'),
    fields: [
      { name: 'kind', label: 'Reason', type: 'select', options: [['resigned', 'Resigned'], ['terminated', 'Terminated'], ['contract_end', 'Contract ended'], ['retired', 'Retired'], ['other', 'Other']] },
      { name: 'exit_date', label: 'Last working day', type: 'date', required: true },
      { name: 'notice', label: 'Serving notice period until then', type: 'checkbox', help: 'Keep them active until the last day.' },
      { name: 'reason', label: 'Details', type: 'textarea', full: true },
    ],
    values: { kind: 'resigned', exit_date: e.exit_date || todayLocal(), notice: true },
    onSubmit: (v) => api.post(`/api/employees/${e.id}/exit`, v),
  });
  if (ok) { await loadLookups(true); toast('Saved'); reload(); }
}

async function rehire(e, reload) {
  const ok = await formModal({
    title: `Rehire ${e.name}`, size: 'sm', one: true, submit: 'Rehire',
    fields: [{ name: 'join_date', label: 'New joining date', type: 'date', required: true }, { name: 'probation_days', label: 'Probation', type: 'number', min: 0, suffix: 'days' }],
    values: { join_date: todayLocal(), probation_days: 0 }, onSubmit: (v) => api.post(`/api/employees/${e.id}/rehire`, v),
  });
  if (ok) { toast('Rehired'); reload(); }
}

async function suspend(e, on, reload) {
  if (!(await confirmDialog(on ? `Suspend ${e.name}? Their payslips are put on hold.` : `Lift ${e.name}'s suspension?`, { ok: on ? 'Suspend' : 'Lift', danger: on }))) return;
  try { await api.post(`/api/employees/${e.id}/suspend`, { suspend: on }); toast('Saved'); reload(); } catch (err) { errorToast(err); }
}

async function addNote(e, reload) {
  const ok = await formModal({
    title: 'Add to history', one: true,
    fields: [{ name: 'event', label: 'Kind', type: 'select', options: [['note', 'Note'], ['promotion', 'Promotion'], ['award', 'Award'], ['warning', 'Warning'], ['training', 'Training']] },
      { name: 'event_date', label: 'Date', type: 'date', required: true }, { name: 'title', label: 'What happened', required: true }],
    values: { event: 'note', event_date: todayLocal() }, onSubmit: (v) => api.post(`/api/employees/${e.id}/events`, v),
  });
  if (ok) { toast('Added'); navigate(`/employees/${e.id}/history`); }
}

async function createAccount(e, reload) {
  const suggested = (e.first_name || 'user').toLowerCase().replace(/[^a-z0-9]/g, '') + (e.emp_code || '').replace(/\D/g, '').slice(-3);
  const ok = await formModal({
    title: `Sign-in for ${e.name}`, one: true, submit: 'Create',
    fields: [
      { name: 'username', label: 'Username', required: true },
      { name: 'password', label: 'Temporary password', required: true, help: 'At least 8 characters. Share it privately.' },
      { name: 'role', label: 'Role', type: 'select', options: [['employee', 'Employee (self-service)'], ['hr', 'HR manager'], ['payroll', 'Payroll officer']] },
    ],
    values: { username: suggested, password: Math.random().toString(36).slice(2, 10), role: 'employee' },
    onSubmit: (v) => api.post(`/api/employees/${e.id}/account`, v),
  });
  if (ok) { toast('Sign-in created'); reload(); }
}

async function deleteEmployee(e) {
  if (!(await confirmDialog(`Delete ${e.name}'s record for good?`, { ok: 'Delete', danger: true, detail: 'Their leave, attendance and history go too. Someone who has payslips cannot be deleted: mark them as left instead.' }))) return;
  try { await api.del(`/api/employees/${e.id}`); await loadLookups(true); toast('Deleted'); navigate('/employees'); } catch (err) { errorToast(err); }
}

/* ------------------------------------------------------------------ salary */
async function salaryTab(body, e, reload) {
  const revisions = await api.get(`/api/employees/${e.id}/salary`);
  const editable = can('salary.edit');
  const add = editable ? h('button', { class: 'btn primary', onclick: () => reviseSalary(e, revisions[0], reload) }, icon(revisions.length ? 'edit' : 'plus', 16), revisions.length ? 'Revise salary' : 'Set salary') : null;
  if (!revisions.length) {
    body.append(card(null, empty('No salary yet', 'Set their gross salary and how it splits into basic, house rent, allowances…', add, 'wallet')));
    return;
  }
  const current = revisions.find((r) => r.current) || revisions[0];
  const comp = (kind) => current.lines.filter((l) => l.kind === kind);
  const section = (title, rows) => (rows.length ? [h('tr', null, h('td', { colspan: 2, class: 'tiny muted strong', style: { paddingTop: '14px', textTransform: 'uppercase', letterSpacing: '.05em' } }, title)),
    ...rows.map((l) => h('tr', null, h('td', null, l.name, h('span', { class: 'tiny muted mono' }, `  ${l.code}`)), h('td', { class: 'num' }, money(l.amount))))] : []);
  body.append(h('div', { class: 'grid grid-side' },
    card(h('div', { class: 'grow' }, h('h3', null, 'Current salary'), h('div', { class: 'small muted' }, `Since ${date(current.effective_from)}${current.structure ? ` · ${current.structure}` : ''}`)),
      h('div', null,
        h('div', { class: 'row wrap gap-16 mb-16' },
          h('div', null, h('div', { class: 'tiny muted' }, 'Gross per month'), h('div', { style: { fontSize: '26px', fontWeight: 750 } }, money(current.gross, { symbol: true }))),
          h('div', null, h('div', { class: 'tiny muted' }, 'Earnings'), h('div', { class: 'strong', style: { fontSize: '18px' } }, money(current.earnings))),
          current.deductions ? h('div', null, h('div', { class: 'tiny muted' }, 'Fixed deductions'), h('div', { class: 'strong', style: { fontSize: '18px' } }, money(current.deductions))) : null),
        current.errors.length ? alertBox(current.errors.join(' '), 'warn', 'alert') : null,
        h('table', { class: 'table compact' }, h('tbody', null, section('Earnings', comp('earning')), section('Deductions', comp('deduction')), section('Employer contributions', comp('employer'))))),
      { actions: add }),
    card('Salary history', h('ul', { class: 'list' }, revisions.map((r) => h('li', null,
      h('div', { class: 'grow' }, h('div', { class: 'strong' }, money(r.gross, { symbol: true })), h('div', { class: 'tiny muted' }, `${date(r.effective_from)}${r.reason ? ` · ${r.reason}` : ''}`)),
      r.current ? badge('Current', 'ok') : r.future ? badge('Upcoming', 'info') : null,
      editable ? h('button', { class: 'icon-btn', title: 'Delete this revision', onclick: async () => {
        if (!(await confirmDialog(`Delete the salary from ${date(r.effective_from)}?`, { ok: 'Delete', danger: true }))) return;
        try { await api.del(`/api/salaries/${r.id}`); toast('Deleted'); reload(); } catch (err) { errorToast(err); }
      } }, icon('trash', 15)) : null))), { flush: true })));
}

async function reviseSalary(e, latest, reload) {
  const editor = salaryEditor(latest ? { gross: latest.gross, structure_id: latest.structure_id, lines: latest.lines.map((l) => ({ component_id: l.component_id, calc: l.calc, value: l.value, percent_of: l.percent_of, formula: l.formula })) } : {});
  await editor.ready;
  const effective = h('input', { class: 'input', type: 'date', value: latest ? todayLocal().slice(0, 8) + '01' : e.join_date });
  const reason = h('input', { class: 'input', placeholder: latest ? 'e.g. Annual increment' : 'Joining salary', value: latest ? '' : 'Joining salary' });
  const err = h('div');
  const m = modal({
    title: latest ? `Revise ${e.name}'s salary` : `Set ${e.name}'s salary`, size: 'lg',
    body: h('div', null, h('div', { class: 'form mb-16' }, h('div', { class: 'field' }, h('label', null, 'Effective from'), effective), h('div', { class: 'field' }, h('label', null, 'Reason'), reason)), editor.el, err),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Cancel'), h('button', {
      class: 'btn primary',
      onclick: async (ev) => {
        ev.target.disabled = true;
        try {
          await api.post(`/api/employees/${e.id}/salary`, { ...editor.value(), effective_from: effective.value, reason: reason.value });
          m.close(); toast('Salary saved'); reload();
        } catch (x) { clear(err, h('div', { class: 'mt-16' }, alertBox(x.message, 'bad', 'alert'))); ev.target.disabled = false; }
      },
    }, 'Save salary')],
  });
}

/* ------------------------------------------------------------------ leave */
async function leaveTab(body, e, reload) {
  const year = Number(new URLSearchParams(location.hash.split('?')[1] || '').get('year')) || null;
  const [bal, reqs] = await Promise.all([api.get('/api/leave/balances', { employee_id: e.id, year }), api.get('/api/leave/requests', { scope: 'all', employee_id: e.id })]);
  const manage = can('leave.manage');
  body.append(h('div', { class: 'row wrap mb-16' }, h('h3', { class: 'grow', style: { minWidth: '220px' } }, `Leave year ${bal.year}`, h('span', { class: 'small muted', style: { fontWeight: 400 } }, ` · ${date(bal.range.start)} – ${date(bal.range.end)}`)),
    manage ? h('button', { class: 'btn', onclick: () => adjustBalance(e, bal, reload) }, icon('sliders', 16), 'Adjust balance') : null,
    manage || e.can.self ? h('button', { class: 'btn primary', onclick: () => applyLeave({ employeeId: e.can.self ? null : e.id, onDone: reload }) }, icon('plus', 16), 'Apply for leave') : null));
  body.append(balanceCards(bal.balances));
  body.append(h('div', { class: 'mt-24' }, card('Requests', leaveRequestsTable(reqs, { showName: false, onChange: reload }), { flush: true })));
  const ledger = await api.get('/api/leave/ledger', { employee_id: e.id, year: bal.year });
  body.append(h('div', { class: 'mt-16' }, card('Leave ledger', table({
    rows: ledger, compact: true, pageSize: 100,
    columns: [
      { key: 'created_at', label: 'When', render: (r) => utcToLocal(r.created_at) },
      { key: 'type_name', label: 'Type', render: (r) => h('span', { class: 'row gap-4' }, h('span', { class: 'swatch', style: { background: r.color || 'var(--brand)' } }), r.type_name) },
      { key: 'entry', label: 'Entry', render: (r) => sentence(r.entry) },
      { key: 'days', label: 'Days', num: true, render: (r) => h('span', { style: { color: r.days < 0 ? 'var(--bad)' : 'var(--ok)', fontWeight: 600 } }, `${r.days > 0 ? '+' : ''}${num(r.days)}`) },
      { key: 'note', label: 'Note', render: (r) => h('span', { class: 'small' }, [r.note, r.user_name && `by ${r.user_name}`].filter(Boolean).join(' · ')) },
    ],
  }), { flush: true })));
}

async function adjustBalance(e, bal, reload) {
  const ok = await formModal({
    title: 'Adjust leave balance', one: true,
    intro: h('p', { class: 'muted small' }, 'Add days with a positive number (e.g. compensatory leave) or remove days with a negative one. It is recorded in the ledger.'),
    fields: [
      { name: 'leave_type_id', label: 'Leave type', type: 'select', options: bal.balances.map((b) => [b.leave_type_id, b.name]), numeric: true },
      { name: 'days', label: 'Days (+ or −)', type: 'number', step: '0.5', required: true },
      { name: 'note', label: 'Reason', required: true },
    ],
    values: { leave_type_id: bal.balances[0] && bal.balances[0].leave_type_id },
    onSubmit: (v) => api.post('/api/leave/ledger', { ...v, employee_id: e.id, year: bal.year }),
  });
  if (ok) { toast('Balance adjusted'); reload(); }
}

/* ------------------------------------------------------------------ attendance */
async function attendanceTab(body, e) {
  body.append(attendanceMonth(e.can.self && !can('attendance.view') ? null : e.id, { canEdit: can('attendance.manage') }));
}

/* ------------------------------------------------------------------ documents */
async function documentsTab(body, e, reload) {
  const docs = await api.get(`/api/employees/${e.id}/documents`);
  const edit = can('employees.edit');
  const upload = async () => {
    const f = await pickFile('.pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.txt');
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) { errorToast(new Error('Files can be at most 5 MB.')); return; }
    const ok = await formModal({
      title: 'Upload document', one: true,
      fields: [{ name: 'title', label: 'Title', required: true }, { name: 'expires_on', label: 'Expires on (optional)', type: 'date', help: 'e.g. for an ID card or visa.' }],
      values: { title: f.name.replace(/\.[^.]+$/, '') },
      onSubmit: async (v) => api.post(`/api/employees/${e.id}/documents`, { ...v, file_name: f.name, mime: f.type || 'application/octet-stream', data: await readFile(f, false) }),
    });
    if (ok) { toast('Uploaded'); reload(); }
  };
  body.append(card('Documents', docs.length ? table({
    rows: docs,
    columns: [
      { key: 'title', label: 'Document', render: (d) => h('a', { href: `/api/documents/${d.id}`, target: '_blank', rel: 'noopener' }, icon('file', 14), ' ', d.title) },
      { key: 'file_name', label: 'File', render: (d) => h('span', { class: 'small muted' }, `${d.file_name} · ${Math.ceil(d.size / 1024)} KB`) },
      { key: 'expires_on', label: 'Expires', render: (d) => (d.expires_on ? h('span', null, date(d.expires_on), ' ', d.expires_on < todayLocal() ? badge('Expired', 'bad') : null) : '—') },
      { key: 'created_at', label: 'Uploaded', render: (d) => utcToLocal(d.created_at) },
      edit ? { key: 'x', label: '', render: (d) => h('button', { class: 'icon-btn', title: 'Delete', onclick: async () => {
        if (!(await confirmDialog(`Delete "${d.title}"?`, { ok: 'Delete', danger: true }))) return;
        await api.del(`/api/documents/${d.id}`); toast('Deleted'); reload();
      } }, icon('trash', 15)) } : null,
    ].filter(Boolean),
  }) : empty('No documents', 'Keep contracts, ID copies and certificates here.', null, 'file'), { flush: true, actions: edit ? h('button', { class: 'btn sm primary', onclick: upload }, icon('upload', 14), 'Upload') : null }));
}

/* ------------------------------------------------------------------ history */
async function historyTab(body, e, reload) {
  const events = await api.get(`/api/employees/${e.id}/events`);
  const ic = { joined: 'rocket', confirmed: 'checkCircle', probation_extended: 'clock', transfer: 'org', salary: 'wallet', exit: 'logout', status: 'info', promotion: 'star', award: 'gift', warning: 'alert', training: 'briefcase', note: 'edit' };
  body.append(card('History', events.length ? h('ul', { class: 'timeline' }, events.map((ev) => h('li', null,
    h('div', { class: 'row' }, icon(ic[ev.event] || 'info', 15), h('strong', null, ev.title)),
    h('div', { class: 'when' }, `${date(ev.event_date)}${ev.user_name ? ` · by ${ev.user_name}` : ''}`))))
    : empty('Nothing yet', ''), { actions: can('employees.edit') ? h('button', { class: 'btn sm', onclick: () => addNote(e, reload) }, icon('plus', 14), 'Add') : null }));
}

