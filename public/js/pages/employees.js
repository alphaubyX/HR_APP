import { api } from '../api.js';
import { can, options, navigate, loadLookups } from '../state.js';
import {
  h, icon, pageHead, card, table, person, empStatus, date, seg, clear, empty, download, sentence, modal, pickFile, alertBox, toast, errorToast,
} from '../ui.js';

const TEMPLATE = 'emp_code,first_name,last_name,gender,join_date,department,designation,manager_code,device_user_id,phone,email,national_id,bank_name,bank_account_no,gross\n'
  + 'EMP-0001,Usman,Younos,male,2020-01-01,Management,Chief Executive,,1,0300-0000000,usman@example.com,,,,450000\n'
  + 'EMP-0002,Sara,Iqbal,female,15/03/2024,Sales,Sales executive,EMP-0001,2,,,,Meezan Bank,0101234567,95000\n';

function importDialog(after) {
  const result = h('div');
  const m = modal({
    title: 'Import employees from a spreadsheet',
    body: h('div', null,
      h('p', null, 'Save your spreadsheet as CSV with a header row. Only first_name and join_date are required; departments and designations are created if they don’t exist, line managers are linked by their employee number, and a gross salary is split with your first salary structure.'),
      h('p', { class: 'small muted' }, 'Columns: emp_code, first_name, last_name, father_name, gender, dob, national_id, phone, email, address, join_date, department, designation, branch, manager_code, device_user_id, probation_days, bank_name, bank_account_title, bank_account_no, bank_iban, gross. Dates as YYYY-MM-DD or DD/MM/YYYY.'),
      h('div', { class: 'row mt-16' },
        h('button', { class: 'btn', onclick: () => { const a = h('a', { href: `data:text/csv;charset=utf-8,${encodeURIComponent(TEMPLATE)}`, download: 'employees-template.csv' }); document.body.append(a); a.click(); a.remove(); } }, icon('download', 16), 'Template'),
        h('button', { class: 'btn primary', onclick: async (e) => {
          const f = await pickFile('.csv,text/csv');
          if (!f) return;
          e.target.disabled = true;
          try {
            const r = await api.post('/api/employees/import', { csv: await f.text() });
            clear(result, h('div', { class: 'mt-16' }, alertBox(h('div', null, h('div', { class: 'strong' }, `${r.created} employee(s) added, ${r.salaries} salaries set, ${r.managers} line managers linked.`),
              r.skipped.map((x) => h('div', { class: 'small' }, x))), r.skipped.length ? 'warn' : 'ok', 'info')));
            await loadLookups(true);
            toast('Import finished');
            after();
          } catch (err) { errorToast(err); }
          e.target.disabled = false;
        } }, icon('upload', 16), 'Choose CSV file')),
      result),
    actions: [h('button', { class: 'btn', onclick: () => m.close() }, 'Close')],
  });
}

export default async function employees(view, params, query) {
  let status = query.status || 'current';
  let dept = query.department_id || '';
  const holder = h('div');
  const actions = [];
  if (can('reports.view')) actions.push(h('button', { class: 'btn', onclick: () => download('/api/reports/headcount.csv') }, icon('download', 16), 'Export'));
  if (can('employees.edit')) actions.push(h('button', { class: 'btn', onclick: () => importDialog(load) }, icon('upload', 16), 'Import'));
  if (can('employees.edit')) actions.push(h('a', { class: 'btn primary', href: '#/employees/new' }, icon('plus', 16), 'Add employee'));
  view.append(pageHead(can('employees.view') ? 'Employees' : 'My team', { sub: 'Everyone in your organization, from onboarding to exit.', actions }));

  const deptSelect = h('select', { class: 'input sm', style: { width: '200px' }, onchange: (e) => { dept = e.target.value; load(); } },
    h('option', { value: '' }, 'All departments'), options('departments').map(([id, n]) => h('option', { value: id, selected: String(id) === String(dept) }, n)));
  view.append(h('div', { class: 'toolbar' },
    seg([['current', 'Current'], ['probation', 'Probation'], ['permanent', 'Permanent'], ['onboarding', 'Joining'], ['notice', 'Notice'], ['exited', 'Left']], status, (s) => { status = s; load(); }),
    h('div', { class: 'spacer' }), deptSelect));
  view.append(holder);

  async function load() {
    const rows = await api.get('/api/employees', { status, department_id: dept });
    const tbl = table({
      search: 'Search name, number, designation…',
      rows,
      onRow: (r) => navigate(`/employees/${r.id}`),
      empty: empty(status === 'current' ? 'No employees yet' : `No ${sentence(status).toLowerCase()} employees`,
        status === 'current' ? 'Add your first employee: they start on probation and become permanent after it.' : '',
        can('employees.edit') && status === 'current' ? h('a', { class: 'btn primary', href: '#/employees/new' }, icon('plus', 16), 'Add employee') : null, 'users'),
      columns: [
        { key: 'name', label: 'Employee', sort: (r) => r.name, text: (r) => `${r.name} ${r.emp_code}`, render: (r) => person(r.name, r.emp_code, { photo: r.photo, id: r.id }) },
        { key: 'designation', label: 'Designation', sort: true, render: (r) => r.designation || h('span', { class: 'faint' }, '—') },
        { key: 'department', label: 'Department', sort: true, render: (r) => r.department || h('span', { class: 'faint' }, '—') },
        { key: 'manager', label: 'Line manager', sort: true, className: 'hide-sm', render: (r) => r.manager || h('span', { class: 'faint' }, '—') },
        { key: 'join_date', label: 'Joined', sort: true, className: 'hide-sm', render: (r) => date(r.join_date) },
        { key: 'status', label: 'Status', sort: true, render: (r) => h('div', { class: 'col gap-4', style: { alignItems: 'flex-start' } }, empStatus(r.status),
          r.status === 'probation' && r.probation_end ? h('span', { class: 'tiny muted' }, `until ${date(r.probation_end)}`) : null) },
        { key: 'remote_attendance', label: 'Mobile', className: 'hide-sm', render: (r) => (r.remote_attendance === 'none' ? h('span', { class: 'faint' }, '—') : h('span', { class: 'chip', title: r.remote_attendance === 'geofence' ? 'Only inside an office geofence' : 'From anywhere' }, icon(r.remote_attendance === 'geofence' ? 'pin' : 'device', 13), sentence(r.remote_attendance))) },
      ],
    });
    clear(holder, card(null, tbl, { flush: true }));
  }
  await load();
}
