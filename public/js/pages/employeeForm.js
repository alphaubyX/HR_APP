// Add an employee (step-by-step onboarding) or edit one.
import { api } from '../api.js';
import { S, can, options, employeeOptions, loadLookups, navigate } from '../state.js';
import {
  h, clear, icon, pageHead, card, buildForm, toast, errorToast, alertBox, avatar, pickFile, shrinkImage, todayLocal,
} from '../ui.js';
import { salaryEditor } from './salaryEditor.js';

const sel = (list) => () => options(list);

function personalFields() {
  return [
    { name: 'first_name', label: 'First name', required: true },
    { name: 'last_name', label: 'Last name' },
    { name: 'father_name', label: 'Father’s / guardian’s name' },
    { name: 'gender', label: 'Gender', type: 'select', placeholder: '—', options: [['male', 'Male'], ['female', 'Female'], ['other', 'Other']] },
    { name: 'dob', label: 'Date of birth', type: 'date' },
    { name: 'marital_status', label: 'Marital status', type: 'select', placeholder: '—', options: ['single', 'married', 'divorced', 'widowed'] },
    { name: 'national_id', label: 'National ID (CNIC)', placeholder: '00000-0000000-0' },
    { name: 'phone', label: 'Mobile number', type: 'tel' },
    { name: 'email', label: 'Personal / work email', type: 'email' },
    { name: 'address', label: 'Home address', full: true },
    { section: 'Emergency contact' },
    { name: 'emergency_name', label: 'Name' },
    { name: 'emergency_relation', label: 'Relation' },
    { name: 'emergency_phone', label: 'Phone' },
  ];
}

function jobFields(isNew, nextCode) {
  return [
    { name: 'emp_code', label: 'Employee number', placeholder: nextCode || 'automatic', help: isNew ? 'Leave empty to use the next number.' : null },
    { name: 'join_date', label: 'Joining date', type: 'date', required: true },
    { name: 'employment_type', label: 'Employment type', type: 'select', options: [['full_time', 'Full time'], ['part_time', 'Part time'], ['contract', 'Contract'], ['intern', 'Intern'], ['consultant', 'Consultant']] },
    { name: 'probation_days', label: 'Probation period', type: 'number', min: 0, max: 730, suffix: 'days', help: `0 = permanent from day one. Default ${S.me.org.settings.probation_days} days.` },
    { name: 'department_id', label: 'Department', type: 'select', placeholder: '—', options: sel('departments'), numeric: true },
    { name: 'designation_id', label: 'Designation', type: 'select', placeholder: '—', options: sel('designations'), numeric: true },
    { name: 'manager_id', label: 'Line manager', type: 'select', placeholder: '— No manager (top level) —', options: () => employeeOptions(), numeric: true, help: 'You can also set this by dragging on the organogram.' },
    { name: 'branch_id', label: 'Branch / office', type: 'select', placeholder: '—', options: sel('branches'), numeric: true },
    { name: 'grade_id', label: 'Grade', type: 'select', placeholder: '—', options: sel('grades'), numeric: true },
    isNew ? { name: 'onboarding', label: 'Hasn’t started yet', type: 'checkbox', help: 'Keep them in "Joining" until their first day. Start them from their profile.' } : null,
  ].filter(Boolean);
}

function timeFields() {
  return [
    { name: 'shift_id', label: 'Shift', type: 'select', placeholder: 'Organization default', options: () => S.lookups.shifts.filter((s) => s.active).map((s) => [s.id, `${s.name} (${s.start_time}–${s.end_time})`]), numeric: true },
    { name: 'policy_id', label: 'Attendance policy', type: 'select', placeholder: 'Organization default', options: sel('policies'), numeric: true },
    { name: 'device_user_id', label: 'Attendance machine number', placeholder: 'e.g. 15', help: 'The user / enrol number on the fingerprint or face machine.' },
    { name: 'remote_attendance', label: 'Mobile attendance', type: 'select', options: [['none', 'Off — machine only'], ['geofence', 'From the phone, inside an office geofence'], ['anywhere', 'From the phone, anywhere (field staff)']] },
    { name: 'attendance_required', label: 'Track attendance', type: 'checkbox', default: true, help: 'Untick for people who don’t punch (e.g. directors): no absence deductions.' },
  ];
}

function bankFields() {
  return [
    { name: 'payment_method', label: 'Salary paid by', type: 'select', options: [['bank', 'Bank transfer'], ['cash', 'Cash'], ['cheque', 'Cheque']] },
    { name: 'bank_name', label: 'Bank', show: (v) => v.payment_method === 'bank' },
    { name: 'bank_account_title', label: 'Account title', show: (v) => v.payment_method === 'bank' },
    { name: 'bank_account_no', label: 'Account number', show: (v) => v.payment_method === 'bank' },
    { name: 'bank_iban', label: 'IBAN', show: (v) => v.payment_method === 'bank' },
    { name: 'tax_number', label: 'Tax number (NTN)' },
    { name: 'tax_exempt', label: 'Exempt from income tax', type: 'checkbox' },
    { name: 'notes', label: 'Private HR notes', type: 'textarea', full: true },
  ];
}

function geofencePicker(selected = []) {
  const withCoords = S.lookups.branches.filter((b) => b.active && b.lat !== null && b.lng !== null);
  const set = new Set(selected.map(Number));
  const el = h('div', { class: 'field full' }, h('label', null, 'Offices where they may check in by phone'),
    withCoords.length ? h('div', { class: 'row wrap gap-8' }, withCoords.map((b) => h('label', { class: 'chip', style: { cursor: 'pointer' } },
      h('input', { type: 'checkbox', checked: set.has(b.id), onchange: (e) => { if (e.target.checked) set.add(b.id); else set.delete(b.id); } }), icon('pin', 13), `${b.name} · ${b.radius_m} m`)))
      : alertBox(h('span', null, 'No office has a location yet. Set one under ', h('a', { href: '#/settings/branches' }, 'Settings → Branches & geofences'), '.'), 'warn', 'alert'),
    h('div', { class: 'help' }, 'If none is ticked, their own branch is used.'));
  return { el, value: () => [...set] };
}

function photoPicker(name, photo) {
  let value = photo || null;
  const box = h('div', { class: 'row gap-12' });
  const draw = () => clear(box, avatar(name || '?', { size: 'xl', photo: value }),
    h('div', { class: 'col gap-4' },
      h('button', { class: 'btn sm', type: 'button', onclick: async () => { const f = await pickFile('image/*'); if (!f) return; try { value = await shrinkImage(f, 320); draw(); } catch (err) { errorToast(err); } } }, icon('upload', 14), value ? 'Change photo' : 'Add photo'),
      value ? h('button', { class: 'btn sm ghost', type: 'button', onclick: () => { value = null; draw(); } }, 'Remove') : null));
  draw();
  return { el: box, value: () => value };
}

export default async function employeeForm(view, params) {
  await loadLookups(true);
  const isNew = !params.id;
  if (!can('employees.edit')) throw new Error('You cannot edit employees.');
  let e = {};
  let geo = [];
  if (!isNew) {
    e = await api.get(`/api/employees/${params.id}`);
    geo = e.geofences || [];
    e.department_id = e.department ? e.department.id : null;
    e.designation_id = e.designation ? e.designation.id : null;
    e.branch_id = e.branch ? e.branch.id : null;
    e.shift_id = e.shift ? e.shift.id : null;
    e.grade_id = e.grade ? e.grade.id : null;
    e.manager_id = e.manager ? e.manager.id : null;
    e.attendance_required = !!e.attendance_required;
    e.tax_exempt = !!e.tax_exempt;
  } else {
    e = {
      join_date: todayLocal(), employment_type: 'full_time', probation_days: S.me.org.settings.probation_days, remote_attendance: 'none', payment_method: 'bank',
      attendance_required: true, branch_id: S.lookups.branches.length === 1 ? S.lookups.branches[0].id : null,
    };
  }
  const nextCode = isNew ? (await api.get('/api/employees/next-code')).code : null;

  const forms = {
    personal: buildForm(personalFields(), e),
    job: buildForm(jobFields(isNew, nextCode), e),
    time: buildForm(timeFields(), e),
    bank: buildForm(bankFields(), e),
  };
  const photo = photoPicker(isNew ? 'New employee' : e.name, isNew ? null : e.photo);
  const fences = geofencePicker(geo);
  forms.time.el.append(fences.el);
  const syncFence = () => fences.el.classList.toggle('hidden', forms.time.values().remote_attendance !== 'geofence');
  forms.time.inputs.remote_attendance.addEventListener('change', syncFence);
  syncFence();

  const collect = () => {
    const v = { ...forms.personal.values(), ...forms.job.values(), ...forms.time.values(), ...forms.bank.values(), photo: photo.value() };
    if (!v.emp_code) delete v.emp_code;
    return v;
  };

  if (!isNew) {
    view.append(pageHead(`Edit ${e.name}`, { crumbs: [{ label: 'Employees', href: '#/employees' }, { label: e.name, href: `#/employees/${e.id}` }, { label: 'Edit' }] }));
    const save = h('button', { class: 'btn primary' }, icon('check', 16), 'Save changes');
    const err = h('div');
    save.addEventListener('click', async () => {
      if (!forms.personal.validate() || !forms.job.validate()) return;
      save.disabled = true;
      try {
        await api.put(`/api/employees/${e.id}`, collect());
        await api.put(`/api/employees/${e.id}/geofences`, { branch_ids: fences.value() });
        await loadLookups(true);
        toast('Saved');
        navigate(`/employees/${e.id}`);
      } catch (x) { clear(err, alertBox(x.message, 'bad', 'alert')); save.disabled = false; }
    });
    view.append(
      card('Photo & personal details', h('div', null, h('div', { class: 'mb-16' }, photo.el), forms.personal.el)),
      card('Job & reporting', forms.job.el),
      card('Time & attendance', forms.time.el),
      card('Pay & bank', forms.bank.el),
      h('div', { class: 'row mt-16' }, err, h('div', { class: 'spacer' }), h('a', { class: 'btn', href: `#/employees/${e.id}` }, 'Cancel'), save));
    return;
  }

  /* ---------------- step-by-step onboarding */
  const salary = can('salary.edit') && (S.lookups.components || []).length ? salaryEditor({}) : null;
  const account = buildForm([
    { name: 'create', label: 'Create a sign-in for this employee', type: 'checkbox', default: false, help: 'They can then check in from their phone, apply for leave and see payslips.' },
    { name: 'username', label: 'Username', show: (v) => v.create, help: 'e.g. their first name and a number.' },
    { name: 'password', label: 'Temporary password', type: 'text', show: (v) => v.create, help: 'At least 8 characters. Ask them to change it after signing in.' },
    { name: 'role', label: 'Role', type: 'select', show: (v) => v.create, options: [['employee', 'Employee (self-service)'], ['hr', 'HR manager'], ['payroll', 'Payroll officer']] },
  ], { role: 'employee' });
  const steps = [
    { title: 'Personal details', sub: 'Who are they?', body: h('div', null, h('div', { class: 'mb-16' }, photo.el), forms.personal.el), check: () => forms.personal.validate() },
    { title: 'Job & reporting', sub: 'Where do they sit in the organization?', body: forms.job.el, check: () => forms.job.validate() },
    { title: 'Time & attendance', sub: 'Shift, attendance machine and mobile check-in.', body: forms.time.el },
    { title: 'Pay & bank', sub: 'How salary is paid.', body: forms.bank.el },
    salary ? { title: 'Salary', sub: 'Optional: you can also set this later from their profile.', body: salary.el } : null,
    can('users.manage') ? { title: 'Sign-in account', sub: 'Optional: for self-service on the web and phone.', body: account.el } : null,
  ].filter(Boolean);
  let step = 0;
  const err = h('div');
  const holder = h('div');
  view.append(pageHead('Add an employee', { crumbs: [{ label: 'Employees', href: '#/employees' }, { label: 'New' }], sub: 'They join on probation and become permanent when you confirm them.' }));
  view.append(holder);

  function draw() {
    const s = steps[step];
    const back = h('button', { class: 'btn', disabled: step === 0, onclick: () => { step--; draw(); } }, icon('left', 16), 'Back');
    const last = step === steps.length - 1;
    const next = h('button', { class: 'btn primary', onclick: () => go(next) }, last ? icon('check', 16) : null, last ? 'Add employee' : 'Continue', last ? null : icon('right', 16));
    clear(holder,
      h('div', { class: 'steps' }, steps.map((_, i) => h('div', { class: i <= step ? 'on' : '' }))),
      card(h('div', { class: 'grow' }, h('div', { class: 'tiny muted' }, `Step ${step + 1} of ${steps.length}`), h('h3', null, s.title), h('div', { class: 'small muted' }, s.sub)), s.body),
      h('div', { class: 'row mt-16' }, back, h('div', { class: 'spacer' }), err, next));
  }

  async function go(btn) {
    const s = steps[step];
    if (s.check && !s.check()) return;
    clear(err);
    if (step < steps.length - 1) { step++; draw(); window.scrollTo(0, 0); return; }
    btn.disabled = true;
    try {
      const data = collect();
      const { id } = await api.post('/api/employees', data);
      const problems = [];
      try { await api.put(`/api/employees/${id}/geofences`, { branch_ids: fences.value() }); } catch (x) { problems.push(x.message); }
      if (salary) {
        const sv = salary.value();
        if (sv.gross || sv.lines.some((l) => l.calc === 'fixed' && l.value)) {
          try { await api.post(`/api/employees/${id}/salary`, { ...sv, effective_from: data.join_date, reason: 'Joining salary' }); } catch (x) { problems.push(`Salary: ${x.message}`); }
        }
      }
      const acc = account.values();
      if (acc.create) {
        try { await api.post(`/api/employees/${id}/account`, acc); } catch (x) { problems.push(`Sign-in: ${x.message}`); }
      }
      await loadLookups(true);
      if (problems.length) toast(`Employee added, but: ${problems.join(' ')}`, 'bad'); else toast('Employee added');
      navigate(`/employees/${id}`);
    } catch (x) {
      clear(err, alertBox(x.message, 'bad', 'alert'));
      btn.disabled = false;
    }
  }
  draw();
}

