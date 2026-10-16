'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { need, inOrg } = require('../lib/auth');
const { pick, bad, notFound, forbidden } = require('../lib/validate');
const { utcNow, addDays, nowIn, diffDays } = require('../lib/dates');
const {
  audit, employeeScope, inScope, nextEmpCode, fullName, managerMap, descendants, notifyEmployees,
} = require('../services/common');

const PROFILE = {
  first_name: ['str', { required: true, max: 80 }],
  last_name: ['str', { max: 80 }],
  father_name: ['str', { max: 150 }],
  gender: ['str', { oneOf: ['male', 'female', 'other'] }],
  dob: ['date'],
  marital_status: ['str', { oneOf: ['single', 'married', 'divorced', 'widowed'] }],
  national_id: ['str', { max: 40 }],
  email: ['email'],
  phone: ['str', { max: 40 }],
  address: ['str', { max: 400 }],
  emergency_name: ['str', { max: 150 }],
  emergency_phone: ['str', { max: 40 }],
  emergency_relation: ['str', { max: 60 }],
};
const JOB = {
  emp_code: ['str', { max: 30 }],
  department_id: ['id'],
  section_id: ['id'],
  designation_id: ['id'],
  grade_id: ['id'],
  branch_id: ['id'],
  shift_id: ['id'],
  policy_id: ['id'],
  manager_id: ['id'],
  employment_type: ['str', { oneOf: ['full_time', 'part_time', 'contract', 'intern', 'consultant'] }],
  join_date: ['date', { required: true }],
  probation_days: ['int', { min: 0, max: 730 }],
  remote_attendance: ['str', { oneOf: ['none', 'anywhere', 'geofence'] }],
  attendance_required: ['bool'],
  device_user_id: ['str', { max: 30 }],
  notes: ['str', { max: 5000 }],
};
const BANK = {
  payment_method: ['str', { oneOf: ['bank', 'cash', 'cheque'] }],
  bank_name: ['str', { max: 100 }],
  bank_account_title: ['str', { max: 150 }],
  bank_account_no: ['str', { max: 60 }],
  bank_iban: ['str', { max: 60 }],
  tax_number: ['str', { max: 40 }],
  tax_exempt: ['bool'],
};
const PHOTO_RE = /^data:image\/(png|jpeg|webp);base64,/;
const SENSITIVE = ['bank_name', 'bank_account_title', 'bank_account_no', 'bank_iban', 'tax_number', 'tax_exempt', 'national_id', 'notes'];

module.exports = function employeeRoutes(r, { db, options }) {
  const docsDir = path.join(options.dataDir, 'documents');

  async function load(req, id) {
    const e = await db.get('SELECT * FROM employees WHERE id = ? AND org_id = ?', [id, req.org.id]);
    if (!e) throw notFound('Employee');
    return e;
  }

  async function loadVisible(req, id) {
    const e = await load(req, id);
    const scope = await employeeScope(req);
    if (!inScope(scope, e.id)) throw forbidden('You can only see your own team.');
    return { e, scope };
  }

  /** Reference ids must belong to this organization. */
  async function checkRefs(req, data, existing = null) {
    const refs = { department_id: 'departments', section_id: 'sections', designation_id: 'designations', grade_id: 'grades', branch_id: 'branches', shift_id: 'shifts', policy_id: 'attendance_policies', manager_id: 'employees' };
    for (const [col, table] of Object.entries(refs)) {
      if (!data[col]) continue;
      if (!(await db.get(`SELECT id FROM ${table} WHERE id = ? AND org_id = ?`, [data[col], req.org.id]))) throw bad(`${col.replace('_id', '').replace('_', ' ')} not found.`);
    }
    // the section decides the department; a new department without a section leaves the old section
    if (data.section_id) {
      const sectionDept = await db.value('SELECT department_id FROM sections WHERE id = ?', [data.section_id]);
      // the form sent the old section with a new department: the department change wins
      const movedAway = existing && data.section_id === existing.section_id && 'department_id' in data
        && data.department_id !== existing.department_id && data.department_id !== sectionDept;
      if (movedAway) data.section_id = null;
      else data.department_id = sectionDept;
    } else if (existing && 'department_id' in data && !('section_id' in data) && data.department_id !== existing.department_id) {
      data.section_id = null;
    }
    if (data.device_user_id) {
      const dup = await db.get('SELECT id, first_name FROM employees WHERE org_id = ? AND device_user_id = ? AND id <> ?', [req.org.id, data.device_user_id, data.id || 0]);
      if (dup) throw bad(`Attendance machine number ${data.device_user_id} is already used by ${dup.first_name}.`);
    }
  }

  /** Would making managerId the manager of id create a loop (someone managing their own manager)? */
  async function checkManager(req, id, managerId) {
    if (!managerId) return;
    if (managerId === id) throw bad('Someone cannot be their own line manager.');
    const below = descendants(await managerMap(db, req.org.id), id);
    if (below.has(managerId)) throw bad('That person reports to this employee, so they cannot be their manager.');
  }

  function serialize(e, { full }) {
    const out = { ...e, name: fullName(e) };
    if (!full) for (const k of SENSITIVE) delete out[k];
    return out;
  }

  async function addEvent(dbx, req, employeeId, event, eventDate, title, details = null) {
    await dbx.insert('employee_events', {
      org_id: req.org.id, employee_id: employeeId, event, event_date: eventDate, title, details: details ? JSON.stringify(details) : null,
      user_id: req.user.id, created_at: utcNow(),
    });
  }

  /* ------------------------------------------------------------------ list */
  r.get('/employees', inOrg, async (req, res) => {
    const scope = await employeeScope(req);
    let sql = `SELECT e.*, d.name AS department, sc.name AS section, g.name AS designation, b.name AS branch,
                 m.first_name AS manager_first, m.last_name AS manager_last
               FROM employees e
               LEFT JOIN departments d ON d.id = e.department_id
               LEFT JOIN sections sc ON sc.id = e.section_id
               LEFT JOIN designations g ON g.id = e.designation_id
               LEFT JOIN branches b ON b.id = e.branch_id
               LEFT JOIN employees m ON m.id = e.manager_id
               WHERE e.org_id = ?`;
    const params = [req.org.id];
    if (req.query.status === 'current') sql += " AND e.status <> 'exited'";
    else if (req.query.status) { sql += ' AND e.status = ?'; params.push(String(req.query.status)); }
    if (req.query.department_id) { sql += ' AND e.department_id = ?'; params.push(Number(req.query.department_id)); }
    if (req.query.section_id) { sql += ' AND e.section_id = ?'; params.push(Number(req.query.section_id)); }
    sql += ' ORDER BY e.first_name, e.last_name';
    let rows = await db.all(sql, params);
    if (!scope.all) rows = rows.filter((e) => scope.ids.has(e.id));
    const full = req.perms.has('employees.edit');
    res.json(rows.map((e) => {
      const out = serialize(e, { full });
      out.manager = e.manager_first ? [e.manager_first, e.manager_last].filter(Boolean).join(' ') : null;
      delete out.manager_first; delete out.manager_last;
      if (!req.query.photos) out.photo = e.photo ? true : null;
      return out;
    }));
  });

  r.get('/employees/next-code', need('employees.edit'), async (req, res) => {
    res.json({ code: await nextEmpCode(db, req.org) });
  });

  /* --------------------------------------------------------- onboarding */
  r.post('/employees', need('employees.edit'), async (req, res) => {
    const data = pick(req.body, { ...PROFILE, ...JOB, ...BANK });
    if (req.org.max_employees) {
      const n = Number(await db.value("SELECT COUNT(*) FROM employees WHERE org_id = ? AND status <> 'exited'", [req.org.id]));
      if (n >= req.org.max_employees) throw bad(`Your plan allows ${req.org.max_employees} employees. Please contact us to upgrade.`);
    }
    await checkRefs(req, data);
    if (!data.emp_code) data.emp_code = await nextEmpCode(db, req.org);
    if (data.probation_days === null || data.probation_days === undefined) data.probation_days = req.org.settings.probation_days;
    const onboarding = !!(req.body && req.body.onboarding); // not started yet: joins on join_date
    const status = onboarding ? 'onboarding' : data.probation_days > 0 ? 'probation' : 'permanent';
    const now = utcNow();
    if (typeof req.body.photo === 'string' && PHOTO_RE.test(req.body.photo) && req.body.photo.length < 400000) data.photo = req.body.photo;

    const id = await db.tx(async (t) => {
      const empId = await t.insert('employees', {
        ...data, org_id: req.org.id, status,
        employment_type: data.employment_type || 'full_time',
        remote_attendance: data.remote_attendance || 'none',
        payment_method: data.payment_method || 'bank',
        attendance_required: 'attendance_required' in (req.body || {}) ? data.attendance_required : 1,
        probation_end: data.probation_days > 0 ? addDays(data.join_date, data.probation_days) : null,
        confirmed_on: status === 'permanent' ? data.join_date : null,
        created_at: now, updated_at: now,
      });
      await addEvent(t, req, empId, 'joined', data.join_date, data.probation_days > 0 ? `Joined on probation for ${data.probation_days} days` : 'Joined as permanent');
      const items = await t.all("SELECT title, sort FROM checklist_items WHERE org_id = ? AND stage = 'onboarding' AND active = 1 ORDER BY sort, id", [req.org.id]);
      for (const it of items) await t.insert('employee_checklist', { org_id: req.org.id, employee_id: empId, stage: 'onboarding', title: it.title, sort: it.sort });
      return empId;
    });
    await audit(db, req, 'employees.create', 'employees', id, { name: fullName(data), emp_code: data.emp_code });
    res.json({ id });
  });

  /** The employee photo as an image (lists only send whether there is one). */
  r.get('/employees/:id/photo', inOrg, async (req, res) => {
    const e = await db.get('SELECT photo FROM employees WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    const m = e && e.photo && e.photo.match(/^data:(image\/(?:png|jpeg|webp));base64,(.*)$/);
    if (!m) throw notFound('Photo');
    res.set('Cache-Control', 'private, max-age=300');
    res.type(m[1]).send(Buffer.from(m[2], 'base64'));
  });

  /**
   * Bring employees over from a spreadsheet (CSV). Recognised columns (any order, header row needed):
   * emp_code, first_name, last_name, father_name, gender, dob, national_id, phone, email, address, join_date,
   * department, designation, branch, manager_code, device_user_id, probation_days, bank_name, bank_account_title,
   * bank_account_no, bank_iban, gross. Departments and designations that don't exist yet are created.
   */
  r.post('/employees/import', need('employees.edit'), async (req, res) => {
    const text = String(req.body?.csv || '');
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) throw bad('The file needs a header row and at least one employee.');
    if (lines.length > 5001) throw bad('Import at most 5000 employees at a time.');
    const parseLine = (line) => {
      const out = []; let cur = ''; let q = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true; else if (ch === ',' || ch === ';' || ch === '\t') { out.push(cur.trim()); cur = ''; } else cur += ch;
      }
      out.push(cur.trim());
      return out;
    };
    const header = parseLine(lines[0]).map((h) => h.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
    const alias = { employee_code: 'emp_code', employee_no: 'emp_code', code: 'emp_code', first: 'first_name', name: 'first_name', last: 'last_name', joining_date: 'join_date', joined: 'join_date', cnic: 'national_id', mobile: 'phone', machine_no: 'device_user_id', machine_number: 'device_user_id', line_manager_code: 'manager_code', manager: 'manager_code', gross_salary: 'gross', salary: 'gross' };
    const cols = header.map((h) => alias[h] || h);
    if (!cols.includes('first_name') || !cols.includes('join_date')) throw bad('Columns "first_name" and "join_date" are required.');
    const lookup = async (table, name, extra = {}) => {
      if (!name) return null;
      const row = await db.get(`SELECT id FROM ${table} WHERE org_id = ? AND LOWER(name) = ?`, [req.org.id, name.toLowerCase()]);
      if (row) return row.id;
      return db.insert(table, { org_id: req.org.id, name: name.slice(0, 120), ...extra });
    };
    const result = { created: 0, skipped: [], managers: 0, salaries: 0 };
    const pending = [];
    const structure = await db.get('SELECT id FROM salary_structures WHERE org_id = ? AND active = 1 ORDER BY id LIMIT 1', [req.org.id]);
    for (let i = 1; i < lines.length; i++) {
      const v = Object.fromEntries(parseLine(lines[i]).map((x, j) => [cols[j], x]));
      try {
        for (const k of ['join_date', 'dob']) if (v[k] && /^\d{1,2}[/.-]\d{1,2}[/.-]\d{4}$/.test(v[k])) { const [d, m, y] = v[k].split(/[/.-]/); v[k] = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; }
        if (v.gender) v.gender = /^f/i.test(v.gender) ? 'female' : /^m/i.test(v.gender) ? 'male' : 'other';
        const data = pick(v, { ...PROFILE, ...JOB, ...BANK }, { partial: true });
        if (!data.first_name || !data.join_date) throw bad('first name and join date are needed');
        if (data.emp_code && await db.get('SELECT id FROM employees WHERE org_id = ? AND emp_code = ?', [req.org.id, data.emp_code])) throw bad(`number ${data.emp_code} already exists`);
        if (!data.emp_code) data.emp_code = await nextEmpCode(db, req.org);
        data.department_id = await lookup('departments', v.department, { created_at: utcNow() });
        data.designation_id = await lookup('designations', v.designation);
        if (v.branch) data.branch_id = await lookup('branches', v.branch, { created_at: utcNow() });
        delete data.manager_id;
        if (data.probation_days === undefined || data.probation_days === null) data.probation_days = 0;
        const today = nowIn(req.org.timezone).date;
        const probationEnd = data.probation_days > 0 ? addDays(data.join_date, data.probation_days) : null;
        const status = probationEnd && probationEnd > today ? 'probation' : 'permanent';
        const now = utcNow();
        const id = await db.insert('employees', {
          ...data, org_id: req.org.id, status, employment_type: data.employment_type || 'full_time', remote_attendance: data.remote_attendance || 'none',
          payment_method: data.payment_method || (data.bank_account_no ? 'bank' : 'cash'), probation_end: probationEnd,
          confirmed_on: status === 'permanent' ? (probationEnd || data.join_date) : null, created_at: now, updated_at: now,
        });
        await addEvent(db, req, id, 'joined', data.join_date, 'Imported from a spreadsheet');
        if (v.manager_code) pending.push([id, v.manager_code]);
        const gross = Number(String(v.gross || '').replace(/,/g, ''));
        if (gross > 0 && structure) {
          const sl = await db.all('SELECT * FROM structure_lines WHERE structure_id = ?', [structure.id]);
          const sid = await db.insert('employee_salaries', { org_id: req.org.id, employee_id: id, effective_from: data.join_date, gross, structure_id: structure.id, reason: 'Imported', user_id: req.user.id, created_at: now });
          for (const l of sl) await db.insert('employee_salary_lines', { org_id: req.org.id, salary_id: sid, component_id: l.component_id, calc: l.calc, value: l.value, percent_of: l.percent_of, formula: l.formula });
          result.salaries++;
        }
        result.created++;
      } catch (err) {
        if (!err.status) throw err;
        result.skipped.push(`Row ${i + 1}: ${err.message}`);
      }
    }
    for (const [id, code] of pending) {
      const m = await db.get('SELECT id FROM employees WHERE org_id = ? AND emp_code = ?', [req.org.id, code]);
      if (m && m.id !== id) { await db.update('employees', { id }, { manager_id: m.id }); result.managers++; } else result.skipped.push(`Manager ${code} not found`);
    }
    await audit(db, req, 'employees.import', null, null, { created: result.created });
    res.json(result);
  });

  /* -------------------------------------------------------------- profile */
  r.get('/employees/:id', inOrg, async (req, res) => {
    const { e } = await loadVisible(req, req.params.id);
    const self = e.id === req.member.employee_id;
    const full = req.perms.has('employees.edit') || self;
    const out = serialize(e, { full });
    const [dept, section, desig, branch, shift, mgr, grade] = await Promise.all([
      e.department_id && db.get('SELECT id, name FROM departments WHERE id = ?', [e.department_id]),
      e.section_id && db.get('SELECT id, name FROM sections WHERE id = ?', [e.section_id]),
      e.designation_id && db.get('SELECT id, name FROM designations WHERE id = ?', [e.designation_id]),
      e.branch_id && db.get('SELECT id, name FROM branches WHERE id = ?', [e.branch_id]),
      e.shift_id && db.get('SELECT id, name, start_time, end_time FROM shifts WHERE id = ?', [e.shift_id]),
      e.manager_id && db.get('SELECT id, first_name, last_name, emp_code FROM employees WHERE id = ?', [e.manager_id]),
      e.grade_id && db.get('SELECT id, name FROM grades WHERE id = ?', [e.grade_id]),
    ]);
    Object.assign(out, {
      department: dept || null, section: section || null, designation: desig || null, branch: branch || null, shift: shift || null, grade: grade || null,
      manager: mgr ? { id: mgr.id, name: fullName(mgr), emp_code: mgr.emp_code } : null,
    });
    out.reports = (await db.all("SELECT id, first_name, last_name, emp_code FROM employees WHERE org_id = ? AND manager_id = ? AND status <> 'exited' ORDER BY first_name", [req.org.id, e.id]))
      .map((x) => ({ id: x.id, name: fullName(x), emp_code: x.emp_code }));
    out.geofences = (await db.all('SELECT branch_id FROM employee_geofences WHERE employee_id = ?', [e.id])).map((g) => g.branch_id);
    out.account = await db.get(
      'SELECT m.id, m.role, m.active, u.username FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? AND m.employee_id = ?', [req.org.id, e.id]);
    out.can = { edit: req.perms.has('employees.edit'), salary: req.perms.has('salary.view'), self };
    const today = nowIn(req.org.timezone).date;
    out.probation_days_left = e.status === 'probation' && e.probation_end ? diffDays(today, e.probation_end) : null;
    res.json(out);
  });

  r.put('/employees/:id', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const data = pick(req.body, { ...PROFILE, ...JOB, ...BANK }, { partial: true });
    for (const k of ['first_name', 'join_date', 'employment_type', 'remote_attendance', 'payment_method', 'probation_days']) if (data[k] === null) delete data[k];
    data.id = e.id;
    await checkRefs(req, data, e);
    delete data.id;
    if ('manager_id' in data) await checkManager(req, e.id, data.manager_id);
    if ('emp_code' in data && !data.emp_code) delete data.emp_code;
    if ('photo' in (req.body || {})) {
      const p = req.body.photo;
      if (p && !(typeof p === 'string' && PHOTO_RE.test(p) && p.length < 400000)) throw bad('Photo must be a PNG, JPEG or WebP image under 300 KB.');
      data.photo = p || null;
    }
    // Probation length changed while still on probation: move the end date.
    if (('probation_days' in data || 'join_date' in data) && e.status === 'probation') {
      const days = data.probation_days ?? e.probation_days;
      data.probation_end = addDays(data.join_date || e.join_date, days);
    }
    data.updated_at = utcNow();
    const changes = [];
    if ('department_id' in data && data.department_id !== e.department_id) changes.push('department');
    else if ('section_id' in data && data.section_id !== e.section_id) changes.push('section');
    if ('designation_id' in data && data.designation_id !== e.designation_id) changes.push('designation');
    if ('branch_id' in data && data.branch_id !== e.branch_id) changes.push('branch');
    if ('manager_id' in data && data.manager_id !== e.manager_id) changes.push('line manager');
    await db.update('employees', { id: e.id, org_id: req.org.id }, data);
    if (changes.length) {
      await addEvent(db, req, e.id, 'transfer', nowIn(req.org.timezone).date, `Changed ${changes.join(', ')}`, { from: { department_id: e.department_id, designation_id: e.designation_id, branch_id: e.branch_id, manager_id: e.manager_id } });
    }
    await audit(db, req, 'employees.update', 'employees', e.id, { ...data, photo: data.photo ? '(photo)' : undefined });
    res.json({ ok: true });
  });

  r.put('/employees/:id/geofences', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const ids = [...new Set((req.body?.branch_ids || []).map(Number).filter(Boolean))];
    for (const id of ids) if (!(await db.get('SELECT id FROM branches WHERE id = ? AND org_id = ?', [id, req.org.id]))) throw bad('Branch not found.');
    await db.tx(async (t) => {
      await t.run('DELETE FROM employee_geofences WHERE employee_id = ?', [e.id]);
      for (const id of ids) await t.insert('employee_geofences', { org_id: req.org.id, employee_id: e.id, branch_id: id });
    });
    res.json({ ok: true });
  });

  /* ------------------------------------------------------------ organogram */
  r.get('/organogram', inOrg, async (req, res) => {
    const scope = await employeeScope(req);
    const rows = await db.all(
      `SELECT e.id, e.emp_code, e.first_name, e.last_name, e.manager_id, e.department_id, e.section_id, e.designation_id, e.branch_id, e.status, e.photo,
         d.name AS department, d.color AS department_color, g.name AS designation
       FROM employees e LEFT JOIN departments d ON d.id = e.department_id LEFT JOIN designations g ON g.id = e.designation_id
       WHERE e.org_id = ? AND e.status <> 'exited' ORDER BY e.first_name`, [req.org.id]);
    // people outside HR see the chart from their own manager down
    let visible = rows;
    if (!scope.all) {
      const me = rows.find((x) => x.id === req.member.employee_id);
      const top = me && me.manager_id ? me.manager_id : me && me.id;
      const map = new Map(rows.map((x) => [x.id, x.manager_id]));
      const ids = top ? new Set([top, ...descendants(map, top)]) : new Set();
      visible = rows.filter((x) => ids.has(x.id));
    }
    res.json({
      canEdit: req.perms.has('employees.edit'),
      people: visible.map((x) => ({ ...x, name: fullName(x) })),
      canManage: req.perms.has('org.manage'),
      departments: await db.all('SELECT id, name, code, parent_id, head_employee_id, color, approved_strength, sort FROM departments WHERE org_id = ? AND active = 1 ORDER BY sort, name', [req.org.id]),
      sections: await db.all('SELECT id, department_id, name, code, head_employee_id, approved_strength, sort FROM sections WHERE org_id = ? AND active = 1 ORDER BY sort, name', [req.org.id]),
    });
  });

  /** Drag and drop on the organogram: put someone under a new line manager (or at the top). */
  r.put('/organogram/:id/manager', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const managerId = req.body?.manager_id ? Number(req.body.manager_id) : null;
    if (managerId) await load(req, managerId);
    await checkManager(req, e.id, managerId);
    const data = { manager_id: managerId, updated_at: utcNow() };
    if (req.body?.department_id !== undefined) {
      const dep = req.body.department_id ? Number(req.body.department_id) : null;
      if (dep && !(await db.get('SELECT id FROM departments WHERE id = ? AND org_id = ?', [dep, req.org.id]))) throw bad('Department not found.');
      data.department_id = dep;
    }
    await db.update('employees', { id: e.id }, data);
    if (managerId !== e.manager_id) {
      const mgr = managerId ? await db.get('SELECT first_name, last_name FROM employees WHERE id = ?', [managerId]) : null;
      await addEvent(db, req, e.id, 'transfer', nowIn(req.org.timezone).date, mgr ? `Now reports to ${fullName(mgr)}` : 'Now at the top of the organogram');
      if (managerId) await notifyEmployees(db, req.org.id, [managerId], `${fullName(e)} now reports to you`, null, `#/employees/${e.id}`);
    }
    await audit(db, req, 'organogram.move', 'employees', e.id, data);
    res.json({ ok: true });
  });

  /** Departments chart: drop a person into a department or one of its sections. */
  r.put('/organogram/:id/place', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const data = pick(req.body, { department_id: ['id'], section_id: ['id'] });
    await checkRefs(req, data, e);
    if (!data.department_id) throw bad('Choose a department.');
    if (!data.section_id) data.section_id = null;
    if (data.department_id === e.department_id && data.section_id === e.section_id) { res.json({ ok: true }); return; }
    await db.update('employees', { id: e.id }, { ...data, updated_at: utcNow() });
    const where = await db.value('SELECT name FROM departments WHERE id = ?', [data.department_id]);
    const sec = data.section_id ? await db.value('SELECT name FROM sections WHERE id = ?', [data.section_id]) : null;
    await addEvent(db, req, e.id, 'transfer', nowIn(req.org.timezone).date, `Moved to ${sec ? `${where} › ${sec}` : where}`,
      { from: { department_id: e.department_id, section_id: e.section_id } });
    await audit(db, req, 'organogram.place', 'employees', e.id, data);
    res.json({ ok: true });
  });

  /** Departments chart: drag a section to another department, or set its head. */
  r.put('/organogram/sections/:id', need('employees.edit', 'org.manage'), async (req, res) => {
    const s = await db.get('SELECT * FROM sections WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!s) throw notFound('Section');
    const data = pick(req.body, { department_id: ['id'], head_employee_id: ['id'] }, { partial: true });
    if ('department_id' in data) {
      if (!data.department_id || !(await db.get('SELECT id FROM departments WHERE id = ? AND org_id = ?', [data.department_id, req.org.id]))) throw bad('Department not found.');
    }
    if (data.head_employee_id) await load(req, data.head_employee_id);
    await db.tx(async (t) => {
      await t.update('sections', { id: s.id }, data);
      if (data.department_id && data.department_id !== s.department_id) {
        await t.run('UPDATE employees SET department_id = ? WHERE org_id = ? AND section_id = ?', [data.department_id, req.org.id, s.id]);
      }
    });
    await audit(db, req, 'organogram.section', 'sections', s.id, data);
    res.json({ ok: true });
  });

  /** Departments chart: drag a department under another, or set its head. */
  r.put('/organogram/departments/:id', need('employees.edit', 'org.manage'), async (req, res) => {
    const d = await db.get('SELECT * FROM departments WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!d) throw notFound('Department');
    const data = {};
    if ('parent_id' in (req.body || {})) {
      const parent = req.body.parent_id ? Number(req.body.parent_id) : null;
      let cur = parent;
      const seen = new Set();
      while (cur && !seen.has(cur)) {
        if (cur === d.id) throw bad('That would put the department inside itself.');
        seen.add(cur);
        const p = await db.get('SELECT parent_id FROM departments WHERE id = ? AND org_id = ?', [cur, req.org.id]);
        if (!p) throw bad('Department not found.');
        cur = p.parent_id;
      }
      data.parent_id = parent;
    }
    if ('head_employee_id' in (req.body || {})) {
      const h = req.body.head_employee_id ? Number(req.body.head_employee_id) : null;
      if (h) await load(req, h);
      data.head_employee_id = h;
    }
    await db.update('departments', { id: d.id }, data);
    await audit(db, req, 'organogram.department', 'departments', d.id, data);
    res.json({ ok: true });
  });

  /* ------------------------------------------------------ lifecycle actions */
  r.post('/employees/:id/confirm', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    if (!['probation', 'onboarding'].includes(e.status)) throw bad('Only someone on probation can be confirmed.');
    const b = pick(req.body, { date: ['date'], note: ['str', { max: 300 }] });
    const date = b.date || nowIn(req.org.timezone).date;
    await db.update('employees', { id: e.id }, { status: 'permanent', confirmed_on: date, updated_at: utcNow() });
    await addEvent(db, req, e.id, 'confirmed', date, 'Confirmed as permanent', b.note ? { note: b.note } : null);
    await notifyEmployees(db, req.org.id, [e.id], 'Congratulations! Your employment is confirmed.', null, '#/me');
    await audit(db, req, 'employees.confirm', 'employees', e.id);
    res.json({ ok: true });
  });

  r.post('/employees/:id/extend-probation', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    if (e.status !== 'probation') throw bad('This person is not on probation.');
    const b = pick(req.body, { days: ['int', { required: true, min: 1, max: 365 }], note: ['str', { max: 300 }] });
    const end = addDays(e.probation_end || addDays(e.join_date, e.probation_days), b.days);
    await db.update('employees', { id: e.id }, { probation_end: end, probation_days: e.probation_days + b.days, updated_at: utcNow() });
    await addEvent(db, req, e.id, 'probation_extended', nowIn(req.org.timezone).date, `Probation extended by ${b.days} days (now ends ${end})`, b.note ? { note: b.note } : null);
    await audit(db, req, 'employees.extend_probation', 'employees', e.id, b);
    res.json({ ok: true, probation_end: end });
  });

  r.post('/employees/:id/start', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    if (e.status !== 'onboarding') throw bad('This person has already started.');
    const status = e.probation_days > 0 ? 'probation' : 'permanent';
    await db.update('employees', { id: e.id }, { status, confirmed_on: status === 'permanent' ? e.join_date : null, updated_at: utcNow() });
    await addEvent(db, req, e.id, 'status', nowIn(req.org.timezone).date, status === 'probation' ? 'Started: on probation' : 'Started: permanent');
    res.json({ ok: true });
  });

  r.post('/employees/:id/exit', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const b = pick(req.body, {
      exit_date: ['date', { required: true }], reason: ['str', { max: 300 }],
      kind: ['str', { oneOf: ['resigned', 'terminated', 'contract_end', 'retired', 'other'], default: 'resigned' }],
      notice: ['bool'],
    });
    if (b.exit_date < e.join_date) throw bad('The last day cannot be before the joining date.');
    const today = nowIn(req.org.timezone).date;
    const status = b.notice && b.exit_date >= today ? 'notice' : 'exited';
    await db.tx(async (t) => {
      await t.update('employees', { id: e.id }, { status, exit_date: b.exit_date, exit_reason: [b.kind, b.reason].filter(Boolean).join(': '), updated_at: utcNow() });
      // people who reported to them move up to their manager
      if (status === 'exited') await t.run('UPDATE employees SET manager_id = ? WHERE org_id = ? AND manager_id = ?', [e.manager_id, req.org.id, e.id]);
      await addEvent(t, req, e.id, 'exit', b.exit_date, status === 'notice' ? `Serving notice: last day ${b.exit_date}` : `Left (${b.kind.replace('_', ' ')})`, { reason: b.reason });
      const items = await t.all("SELECT title, sort FROM checklist_items WHERE org_id = ? AND stage = 'exit' AND active = 1 ORDER BY sort, id", [req.org.id]);
      const have = await t.value("SELECT COUNT(*) FROM employee_checklist WHERE employee_id = ? AND stage = 'exit'", [e.id]);
      if (!Number(have)) for (const it of items) await t.insert('employee_checklist', { org_id: req.org.id, employee_id: e.id, stage: 'exit', title: it.title, sort: it.sort });
      if (status === 'exited') await t.run('UPDATE memberships SET active = 0 WHERE org_id = ? AND employee_id = ?', [req.org.id, e.id]);
    });
    await audit(db, req, 'employees.exit', 'employees', e.id, b);
    res.json({ ok: true, status });
  });

  r.post('/employees/:id/rehire', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    if (!['exited', 'notice'].includes(e.status)) throw bad('Only someone who has left can be rehired.');
    const b = pick(req.body, { join_date: ['date', { required: true }], probation_days: ['int', { min: 0, max: 730, default: 0 }] });
    const status = b.probation_days > 0 ? 'probation' : 'permanent';
    await db.update('employees', { id: e.id }, {
      status, join_date: b.join_date, probation_days: b.probation_days, probation_end: b.probation_days ? addDays(b.join_date, b.probation_days) : null,
      confirmed_on: status === 'permanent' ? b.join_date : null, exit_date: null, exit_reason: null, updated_at: utcNow(),
    });
    await db.run('UPDATE memberships SET active = 1 WHERE org_id = ? AND employee_id = ?', [req.org.id, e.id]);
    await addEvent(db, req, e.id, 'joined', b.join_date, 'Rehired');
    res.json({ ok: true });
  });

  r.post('/employees/:id/suspend', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const on = !!req.body?.suspend;
    if (on && ['exited', 'suspended'].includes(e.status)) throw bad('Cannot suspend this person.');
    if (!on && e.status !== 'suspended') throw bad('This person is not suspended.');
    const back = e.probation_end && !e.confirmed_on ? 'probation' : 'permanent';
    await db.update('employees', { id: e.id }, { status: on ? 'suspended' : back, updated_at: utcNow() });
    await addEvent(db, req, e.id, 'status', nowIn(req.org.timezone).date, on ? 'Suspended' : 'Suspension lifted', req.body?.note ? { note: String(req.body.note).slice(0, 300) } : null);
    res.json({ ok: true });
  });

  /** Remove an employee record completely (only when nothing important refers to it). */
  r.delete('/employees/:id', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const slips = Number(await db.value('SELECT COUNT(*) FROM payslips WHERE employee_id = ?', [e.id]));
    if (slips) throw bad('This person has payslips, so their record must be kept. Mark them as left instead.');
    await db.tx(async (t) => {
      await t.run('UPDATE employees SET manager_id = ? WHERE org_id = ? AND manager_id = ?', [e.manager_id, req.org.id, e.id]);
      for (const table of ['employee_events', 'employee_checklist', 'employee_geofences', 'leave_ledger', 'leave_requests', 'attendance_days', 'regularizations', 'adjustments']) {
        await t.run(`DELETE FROM ${table} WHERE employee_id = ? AND org_id = ?`, [e.id, req.org.id]);
      }
      const sal = await t.all('SELECT id FROM employee_salaries WHERE employee_id = ?', [e.id]);
      for (const s of sal) await t.run('DELETE FROM employee_salary_lines WHERE salary_id = ?', [s.id]);
      await t.run('DELETE FROM employee_salaries WHERE employee_id = ?', [e.id]);
      await t.run('UPDATE punches SET employee_id = NULL WHERE employee_id = ?', [e.id]);
      await t.run('UPDATE memberships SET employee_id = NULL WHERE employee_id = ?', [e.id]);
      await t.run('UPDATE departments SET head_employee_id = NULL WHERE head_employee_id = ?', [e.id]);
      await t.run('UPDATE sections SET head_employee_id = NULL WHERE head_employee_id = ?', [e.id]);
      await t.run('DELETE FROM employees WHERE id = ?', [e.id]);
    });
    await audit(db, req, 'employees.delete', 'employees', e.id, { name: fullName(e), emp_code: e.emp_code });
    res.json({ ok: true });
  });

  /* ----------------------------------------------- timeline, checklist, docs */
  r.get('/employees/:id/events', inOrg, async (req, res) => {
    const { e } = await loadVisible(req, req.params.id);
    res.json(await db.all(
      `SELECT ev.*, u.name AS user_name FROM employee_events ev LEFT JOIN users u ON u.id = ev.user_id
       WHERE ev.employee_id = ? AND ev.org_id = ? ORDER BY ev.event_date DESC, ev.id DESC`, [e.id, req.org.id]));
  });

  r.post('/employees/:id/events', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const b = pick(req.body, { title: ['str', { required: true, max: 200 }], event_date: ['date', { required: true }], event: ['str', { oneOf: ['note', 'promotion', 'warning', 'award', 'training'], default: 'note' }] });
    await addEvent(db, req, e.id, b.event, b.event_date, b.title);
    res.json({ ok: true });
  });

  r.get('/employees/:id/checklist', need('employees.view'), async (req, res) => {
    const e = await load(req, req.params.id);
    res.json(await db.all('SELECT * FROM employee_checklist WHERE employee_id = ? AND org_id = ? ORDER BY stage, sort, id', [e.id, req.org.id]));
  });

  r.put('/employees/:id/checklist/:itemId', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const done = !!req.body?.done;
    await db.run('UPDATE employee_checklist SET done_at = ?, done_by = ? WHERE id = ? AND employee_id = ?', [done ? utcNow() : null, done ? req.user.id : null, req.params.itemId, e.id]);
    res.json({ ok: true });
  });

  r.post('/employees/:id/checklist', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const b = pick(req.body, { title: ['str', { required: true, max: 200 }], stage: ['str', { oneOf: ['onboarding', 'exit'], default: 'onboarding' }] });
    await db.insert('employee_checklist', { org_id: req.org.id, employee_id: e.id, stage: b.stage, title: b.title, sort: 999 });
    res.json({ ok: true });
  });

  const MIME_OK = /^(application\/pdf|image\/(png|jpeg|webp)|application\/(msword|vnd\.openxmlformats-officedocument\.[\w.]+)|text\/plain)$/;

  r.get('/employees/:id/documents', inOrg, async (req, res) => {
    const { e } = await loadVisible(req, req.params.id);
    if (!req.perms.has('employees.view') && e.id !== req.member.employee_id) throw forbidden();
    res.json(await db.all('SELECT id, title, file_name, mime, size, expires_on, created_at FROM employee_documents WHERE employee_id = ? AND org_id = ? ORDER BY id DESC', [e.id, req.org.id]));
  });

  r.post('/employees/:id/documents', need('employees.edit'), async (req, res) => {
    const e = await load(req, req.params.id);
    const b = pick(req.body, { title: ['str', { required: true, max: 150 }], file_name: ['str', { required: true, max: 200 }], mime: ['str', { required: true, max: 100 }], expires_on: ['date'] });
    if (!MIME_OK.test(b.mime)) throw bad('Upload a PDF, image, Word document or text file.');
    const buf = Buffer.from(String(req.body.data || ''), 'base64');
    if (!buf.length) throw bad('The file is empty.');
    if (buf.length > 5 * 1024 * 1024) throw bad('Files can be at most 5 MB.');
    const storedAs = `${req.org.id}-${e.id}-${crypto.randomBytes(12).toString('hex')}`;
    fs.mkdirSync(docsDir, { recursive: true });
    fs.writeFileSync(path.join(docsDir, storedAs), buf);
    const id = await db.insert('employee_documents', { ...b, org_id: req.org.id, employee_id: e.id, size: buf.length, stored_as: storedAs, user_id: req.user.id, created_at: utcNow() });
    await audit(db, req, 'documents.upload', 'employees', e.id, { title: b.title });
    res.json({ id });
  });

  r.get('/documents/:id', inOrg, async (req, res) => {
    const d = await db.get('SELECT * FROM employee_documents WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!d) throw notFound('Document');
    if (!req.perms.has('employees.view') && d.employee_id !== req.member.employee_id) throw forbidden();
    const file = path.join(docsDir, path.basename(d.stored_as));
    if (!fs.existsSync(file)) throw notFound('File');
    res.set('Content-Type', d.mime || 'application/octet-stream');
    res.set('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${d.file_name.replace(/[^\w.\- ]/g, '_')}"`);
    res.sendFile(file);
  });

  r.delete('/documents/:id', need('employees.edit'), async (req, res) => {
    const d = await db.get('SELECT * FROM employee_documents WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!d) throw notFound('Document');
    await db.run('DELETE FROM employee_documents WHERE id = ?', [d.id]);
    try { fs.unlinkSync(path.join(docsDir, path.basename(d.stored_as))); } catch { /* already gone */ }
    res.json({ ok: true });
  });

  /* ------------------------------------------- sign-in account for an employee */
  r.post('/employees/:id/account', need('users.manage'), async (req, res) => {
    const e = await load(req, req.params.id);
    if (await db.get('SELECT id FROM memberships WHERE org_id = ? AND employee_id = ?', [req.org.id, e.id])) throw bad('This person already has an account.');
    const { createUser, cleanUsername } = require('../services/accounts');
    const uname = cleanUsername(req.body?.username);
    const userId = await createUser(db, { username: uname, name: fullName(e), email: e.email, password: req.body?.password });
    const role = ['employee', 'hr', 'payroll'].includes(req.body?.role) ? req.body.role : 'employee';
    await db.insert('memberships', { user_id: userId, org_id: req.org.id, role, employee_id: e.id, created_at: utcNow() });
    await audit(db, req, 'users.create', 'employees', e.id, { username: uname, role });
    res.json({ ok: true });
  });
};
