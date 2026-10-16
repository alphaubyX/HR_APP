'use strict';

const { need, inOrg, ROLES, hashPassword } = require('../lib/auth');
const { pick, bad, notFound } = require('../lib/validate');
const { utcNow, isTimeZone, isTime } = require('../lib/dates');
const { ORG_SETTINGS, POLICY_RULES, orgSettings, policyRules } = require('../engine/policy');
const { audit, employeeScope, fullName } = require('../services/common');
const { createUser, checkPassword, cleanUsername } = require('../services/accounts');
const { crud } = require('./crud');

module.exports = function orgRoutes(r, { db }) {
  /* ---------------------------------------------------------- profile & settings */
  r.get('/org', inOrg, async (req, res) => {
    const org = await db.get('SELECT * FROM orgs WHERE id = ?', [req.org.id]);
    org.settings = orgSettings(org.settings);
    res.json({ org, settingDefs: ORG_SETTINGS, policyDefs: POLICY_RULES, roles: ROLES });
  });

  r.put('/org', need('org.manage'), async (req, res) => {
    const b = pick(req.body, {
      name: ['str', { required: true, max: 150 }], legal_name: ['str', { max: 200 }], email: ['email'], phone: ['str', { max: 50 }],
      address: ['str', { max: 400 }], country: ['str', { max: 60 }], currency: ['str', { required: true, max: 8 }],
      timezone: ['str', { required: true, max: 60 }], logo: ['str', { max: 400000 }],
    }, { partial: true });
    if (b.timezone && !isTimeZone(b.timezone)) throw bad('Unknown time zone. Use a name like Asia/Karachi or Asia/Dubai.');
    if (b.logo && !/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(b.logo)) throw bad('The logo must be a PNG, JPEG, WebP or SVG image.');
    await db.update('orgs', { id: req.org.id }, b);
    await audit(db, req, 'org.update', 'orgs', req.org.id, { ...b, logo: b.logo ? '(image)' : undefined });
    res.json({ ok: true });
  });

  r.put('/org/settings', need('org.manage'), async (req, res) => {
    const merged = orgSettings({ ...req.org.settings, ...(req.body || {}) });
    await db.update('orgs', { id: req.org.id }, { settings: JSON.stringify(merged) });
    await audit(db, req, 'org.settings', 'orgs', req.org.id, req.body);
    res.json(merged);
  });

  /* Everything the forms need in one request. People outside HR only get their own team. */
  r.get('/lookups', inOrg, async (req, res) => {
    const id = req.org.id;
    const q = (sql) => db.all(sql, [id]);
    const scope = await employeeScope(req);
    let employees = await db.all(
      `SELECT id, emp_code, first_name, last_name, department_id, section_id, designation_id, branch_id, manager_id, status, gender, photo IS NOT NULL AS has_photo
       FROM employees WHERE org_id = ? ORDER BY first_name, last_name`, [id]);
    if (!scope.all) {
      // managers of the people you can see are named too (e.g. "your line manager")
      const visible = new Set(scope.ids);
      employees.forEach((e) => { if (visible.has(e.id) && e.manager_id) visible.add(e.manager_id); });
      employees = employees.filter((e) => visible.has(e.id));
    }
    res.json({
      branches: await q('SELECT id, name, code, lat, lng, radius_m, active FROM branches WHERE org_id = ? ORDER BY name'),
      departments: await q('SELECT id, name, code, parent_id, head_employee_id, color, approved_strength, active FROM departments WHERE org_id = ? ORDER BY sort, name'),
      sections: await q('SELECT id, department_id, name, code, head_employee_id, approved_strength, active FROM sections WHERE org_id = ? ORDER BY sort, name'),
      designations: await q('SELECT id, name, grade_id, active FROM designations WHERE org_id = ? ORDER BY sort, name'),
      grades: await q('SELECT id, name, min_salary, max_salary, structure_id, active FROM grades WHERE org_id = ? ORDER BY sort, name'),
      shifts: await q('SELECT id, name, start_time, end_time, break_minutes, weekly_off, day_overrides, is_default, active FROM shifts WHERE org_id = ? ORDER BY name'),
      policies: await q('SELECT id, name, is_default, active FROM attendance_policies WHERE org_id = ? ORDER BY name'),
      leaveTypes: await q('SELECT * FROM leave_types WHERE org_id = ? ORDER BY sort, name'),
      components: req.perms.has('salary.view') ? await q('SELECT * FROM salary_components WHERE org_id = ? ORDER BY sort, id') : [],
      structures: req.perms.has('salary.view') ? await q('SELECT id, name, description, active FROM salary_structures WHERE org_id = ? ORDER BY name') : [],
      employees: employees.map((e) => ({ ...e, name: fullName(e), has_photo: !!Number(e.has_photo) })),
    });
  });

  /* ---------------------------------------------------------------- reference data */
  const used = async (sql, params, message) => {
    if (Number(await db.value(sql, params))) throw bad(message);
  };
  const own = async (req, table, id, what) => {
    if (!(await db.get(`SELECT id FROM ${table} WHERE id = ? AND org_id = ?`, [id, req.org.id]))) throw bad(`${what} not found.`);
  };

  crud(r, db, {
    path: 'branches', table: 'branches', perm: 'org.manage', viewPerm: 'member', order: 'name', label: 'Branch', hasCreatedAt: true,
    spec: {
      name: ['str', { required: true, max: 120 }], code: ['str', { max: 30 }], address: ['str', { max: 400 }],
      lat: ['num', { min: -90, max: 90 }], lng: ['num', { min: -180, max: 180 }], radius_m: ['int', { min: 10, max: 50000, default: 150 }],
      active: ['bool'],
    },
    beforeDelete: (req, row) => used('SELECT COUNT(*) FROM employees WHERE org_id = ? AND branch_id = ?', [req.org.id, row.id], 'People still work at this branch. Move them first.'),
  });

  crud(r, db, {
    path: 'departments', table: 'departments', perm: 'org.manage', viewPerm: 'member', order: 'sort, name', label: 'Department', hasCreatedAt: true,
    spec: {
      name: ['str', { required: true, max: 120 }], code: ['str', { max: 30 }], parent_id: ['id'], head_employee_id: ['id'],
      color: ['str', { max: 20 }], approved_strength: ['int', { min: 0, max: 100000 }],
      sort: ['int', { min: 0, max: 100000, default: 0 }], active: ['bool'],
    },
    async beforeSave(req, data, existing) {
      if (data.head_employee_id) await own(req, 'employees', data.head_employee_id, 'Head of department');
      if (data.parent_id) {
        if (existing && data.parent_id === existing.id) throw bad('A department cannot be inside itself.');
        // walk up from the new parent: we must not meet this department
        let cur = data.parent_id;
        const seen = new Set();
        while (cur && !seen.has(cur)) {
          if (existing && cur === existing.id) throw bad('That would put the department inside one of its own sub-departments.');
          seen.add(cur);
          const p = await db.get('SELECT parent_id FROM departments WHERE id = ? AND org_id = ?', [cur, req.org.id]);
          if (!p) throw bad('Parent department not found.');
          cur = p.parent_id;
        }
      }
    },
    async beforeDelete(req, row) {
      await used('SELECT COUNT(*) FROM employees WHERE org_id = ? AND department_id = ?', [req.org.id, row.id], 'This department still has people. Move them first.');
      await used('SELECT COUNT(*) FROM departments WHERE org_id = ? AND parent_id = ?', [req.org.id, row.id], 'This department has sub-departments. Move or delete them first.');
      await used('SELECT COUNT(*) FROM sections WHERE org_id = ? AND department_id = ?', [req.org.id, row.id], 'This department has sections. Move or delete them first.');
    },
  });

  crud(r, db, {
    path: 'sections', table: 'sections', perm: 'org.manage', viewPerm: 'member', order: 'sort, name', label: 'Section', hasCreatedAt: true,
    spec: {
      department_id: ['id', { required: true }], name: ['str', { required: true, max: 120 }], code: ['str', { max: 30 }],
      head_employee_id: ['id'], approved_strength: ['int', { min: 0, max: 100000 }],
      sort: ['int', { min: 0, max: 100000, default: 0 }], active: ['bool'],
    },
    async beforeSave(req, data) {
      if (data.department_id === null) throw bad('Department is required.');
      if (data.department_id) await own(req, 'departments', data.department_id, 'Department');
      if (data.head_employee_id) await own(req, 'employees', data.head_employee_id, 'Head of section');
    },
    // people in a section that moves to another department move with it
    async afterSave(req, id, data, existing) {
      if (existing && data.department_id && data.department_id !== existing.department_id) {
        await db.run('UPDATE employees SET department_id = ? WHERE org_id = ? AND section_id = ?', [data.department_id, req.org.id, id]);
      }
    },
    beforeDelete: (req, row) => used('SELECT COUNT(*) FROM employees WHERE org_id = ? AND section_id = ?', [req.org.id, row.id], 'This section still has people. Move them first.'),
  });

  crud(r, db, {
    path: 'designations', table: 'designations', perm: 'org.manage', viewPerm: 'member', order: 'sort, name', label: 'Designation',
    spec: { name: ['str', { required: true, max: 120 }], grade_id: ['id'], sort: ['int', { min: 0, max: 100000, default: 0 }], active: ['bool'] },
    beforeDelete: (req, row) => used('SELECT COUNT(*) FROM employees WHERE org_id = ? AND designation_id = ?', [req.org.id, row.id], 'People still have this designation.'),
  });

  crud(r, db, {
    path: 'grades', table: 'grades', perm: 'org.manage', viewPerm: 'member', order: 'sort, name', label: 'Grade',
    spec: {
      name: ['str', { required: true, max: 80 }], min_salary: ['money'], max_salary: ['money'], structure_id: ['id'],
      sort: ['int', { min: 0, max: 100000, default: 0 }], active: ['bool'],
    },
    beforeDelete: (req, row) => used('SELECT COUNT(*) FROM employees WHERE org_id = ? AND grade_id = ?', [req.org.id, row.id], 'People are still on this grade.'),
  });

  const checkOverrides = (v) => {
    if (v === null || v === undefined || v === '') return null;
    let o = v;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { throw bad('Day overrides are not valid.'); } }
    const out = {};
    for (const [day, val] of Object.entries(o || {})) {
      if (!/^[1-7]$/.test(day) || !val) continue;
      if (val.off) { out[day] = { off: true }; continue; }
      if (!isTime(val.start) || !isTime(val.end)) throw bad('Each day override needs a start and end time (HH:MM).');
      out[day] = { start: val.start, end: val.end };
    }
    return Object.keys(out).length ? JSON.stringify(out) : null;
  };

  crud(r, db, {
    path: 'shifts', table: 'shifts', perm: 'org.manage', viewPerm: 'member', order: 'name', label: 'Shift',
    spec: {
      name: ['str', { required: true, max: 80 }], start_time: ['time', { required: true }], end_time: ['time', { required: true }],
      break_minutes: ['int', { min: 0, max: 600, default: 0 }], weekly_off: ['str', { max: 20, default: '' }], is_default: ['bool'], active: ['bool'],
    },
    async beforeSave(req, data) {
      if (data.weekly_off !== undefined && data.weekly_off !== null) {
        const days = String(data.weekly_off).split(',').map((x) => x.trim()).filter(Boolean);
        if (days.some((d) => !/^[1-7]$/.test(d))) throw bad('Weekly off days are numbers 1 (Monday) to 7 (Sunday).');
        data.weekly_off = [...new Set(days)].sort().join(',');
      }
      if ('day_overrides' in (req.body || {})) data.day_overrides = checkOverrides(req.body.day_overrides);
      if (data.is_default) await db.run('UPDATE shifts SET is_default = 0 WHERE org_id = ?', [req.org.id]);
    },
    beforeDelete: async (req, row) => {
      if (row.is_default) throw bad('This is the default shift. Make another shift the default first.');
      await used('SELECT COUNT(*) FROM employees WHERE org_id = ? AND shift_id = ?', [req.org.id, row.id], 'People still work this shift.');
    },
  });

  crud(r, db, {
    path: 'policies', table: 'attendance_policies', perm: 'org.manage', viewPerm: 'member', order: 'name', label: 'Policy',
    spec: { name: ['str', { required: true, max: 80 }], is_default: ['bool'], active: ['bool'] },
    decorate: (p) => ({ ...p, rules: policyRules(p.rules) }),
    async beforeSave(req, data, existing) {
      if (req.body && req.body.rules) data.rules = JSON.stringify(policyRules({ ...(existing ? policyRules(existing.rules) : {}), ...req.body.rules }));
      else if (!existing) data.rules = JSON.stringify(policyRules({}));
      if (data.is_default) await db.run('UPDATE attendance_policies SET is_default = 0 WHERE org_id = ?', [req.org.id]);
    },
    beforeDelete: async (req, row) => {
      if (row.is_default) throw bad('This is the default policy. Make another policy the default first.');
      await used('SELECT COUNT(*) FROM employees WHERE org_id = ? AND policy_id = ?', [req.org.id, row.id], 'People still follow this policy.');
    },
  });

  crud(r, db, {
    path: 'holidays', table: 'holidays', perm: 'org.manage', viewPerm: 'member', order: 'holiday_date', label: 'Holiday', hasCreatedAt: true,
    spec: {
      holiday_date: ['date', { required: true }], name: ['str', { required: true, max: 150 }],
      kind: ['str', { oneOf: ['public', 'exceptional'], default: 'public' }],
      treatment: ['str', { oneOf: ['closed', 'relaxed', 'half_day'], default: 'closed' }],
      branch_id: ['id'], note: ['str', { max: 300 }],
    },
    listWhere: (req) => (req.query.year ? ['holiday_date >= ? AND holiday_date <= ?', [`${Number(req.query.year)}-01-01`, `${Number(req.query.year)}-12-31`]] : [null, []]),
    async beforeSave(req, data) {
      if (data.kind === 'public') data.treatment = 'closed';
    },
  });

  crud(r, db, {
    path: 'checklist-items', table: 'checklist_items', perm: 'org.manage', order: 'stage, sort, id', label: 'Checklist item',
    spec: { stage: ['str', { oneOf: ['onboarding', 'exit'], default: 'onboarding' }], title: ['str', { required: true, max: 200 }], sort: ['int', { min: 0, max: 10000, default: 0 }], active: ['bool'] },
  });

  /* ------------------------------------------------------------------ users & roles */
  r.get('/users', need('users.manage'), async (req, res) => {
    res.json(await db.all(
      `SELECT m.id, m.role, m.employee_id, m.active, m.created_at, u.id AS user_id, u.username, u.name, u.email, u.last_login_at, u.active AS user_active
       FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name`, [req.org.id]));
  });

  const roleOk = (req, role) => {
    if (!ROLES[role]) throw bad('Unknown role.');
    if (role === 'admin' && req.member.role !== 'admin') throw bad('Only an administrator can make someone an administrator.');
  };

  async function checkEmployee(req, employeeId, membershipId = null) {
    if (!employeeId) return null;
    const e = await db.get('SELECT id FROM employees WHERE id = ? AND org_id = ?', [employeeId, req.org.id]);
    if (!e) throw bad('Employee not found.');
    const taken = await db.get('SELECT id FROM memberships WHERE org_id = ? AND employee_id = ? AND id <> ?', [req.org.id, employeeId, membershipId || 0]);
    if (taken) throw bad('That employee already has a sign-in account.');
    return e.id;
  }

  /** Create a sign-in for someone (or add an existing username to this organization). */
  r.post('/users', need('users.manage'), async (req, res) => {
    const b = pick(req.body, {
      username: ['str', { required: true, max: 40 }], name: ['str', { max: 150 }], email: ['email'],
      role: ['str', { default: 'employee' }], employee_id: ['id'],
    });
    roleOk(req, b.role);
    const employeeId = await checkEmployee(req, b.employee_id);
    const uname = cleanUsername(b.username);
    let user = await db.get('SELECT * FROM users WHERE username = ?', [uname]);
    if (user) {
      if (await db.get('SELECT id FROM memberships WHERE user_id = ? AND org_id = ?', [user.id, req.org.id])) throw bad('That person is already in this organization.');
      if (!req.body.add_existing) throw bad('That username is taken. Tick "add existing account" to give that person access to this organization.');
    } else {
      if (!b.name) throw bad('Name is required.');
      const id = await createUser(db, { username: uname, name: b.name, email: b.email, password: req.body.password });
      user = { id };
    }
    const id = await db.insert('memberships', { user_id: user.id, org_id: req.org.id, role: b.role, employee_id: employeeId, created_at: utcNow() });
    await audit(db, req, 'users.create', 'memberships', id, { username: uname, role: b.role });
    res.json({ id });
  });

  r.put('/users/:id', need('users.manage'), async (req, res) => {
    const m = await db.get('SELECT * FROM memberships WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!m) throw notFound('User');
    const b = pick(req.body, { role: ['str'], employee_id: ['id'], active: ['bool'] }, { partial: true });
    if (b.role) roleOk(req, b.role);
    if (m.role === 'admin' && req.member.role !== 'admin') throw bad('Only an administrator can change another administrator.');
    if (m.user_id === req.user.id && (b.role && b.role !== m.role || b.active === 0)) throw bad('You cannot change your own role or switch yourself off.');
    if ('employee_id' in b) b.employee_id = await checkEmployee(req, b.employee_id, m.id);
    await db.update('memberships', { id: m.id }, b);
    if (req.body && req.body.password) {
      const owner = await db.get('SELECT is_owner FROM users WHERE id = ?', [m.user_id]);
      if (owner.is_owner && !req.user.is_owner) throw bad('You cannot reset the server owner\'s password.');
      const other = await db.value('SELECT COUNT(*) FROM memberships WHERE user_id = ? AND org_id <> ?', [m.user_id, req.org.id]);
      if (Number(other) && !req.user.is_owner) throw bad('This person also uses other organizations, so only they can change their password.');
      await db.update('users', { id: m.user_id }, { password_hash: hashPassword(checkPassword(req.body.password)) });
      await db.run('DELETE FROM sessions WHERE user_id = ?', [m.user_id]);
    }
    if (b.active === 0) await db.run('DELETE FROM sessions WHERE user_id = ? AND org_id = ?', [m.user_id, req.org.id]);
    await audit(db, req, 'users.update', 'memberships', m.id, { ...b, password: req.body && req.body.password ? '(reset)' : undefined });
    res.json({ ok: true });
  });

  r.delete('/users/:id', need('users.manage'), async (req, res) => {
    const m = await db.get('SELECT * FROM memberships WHERE id = ? AND org_id = ?', [req.params.id, req.org.id]);
    if (!m) throw notFound('User');
    if (m.user_id === req.user.id) throw bad('You cannot remove yourself.');
    if (m.role === 'admin' && req.member.role !== 'admin') throw bad('Only an administrator can remove another administrator.');
    await db.run('DELETE FROM memberships WHERE id = ?', [m.id]);
    await db.run('DELETE FROM sessions WHERE user_id = ? AND org_id = ?', [m.user_id, req.org.id]);
    await audit(db, req, 'users.delete', 'memberships', m.id);
    res.json({ ok: true });
  });

  r.get('/audit', need('org.manage'), async (req, res) => {
    const limit = Math.min(500, Number(req.query.limit) || 200);
    res.json(await db.all(
      `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id WHERE a.org_id = ? ORDER BY a.id DESC LIMIT ${limit}`,
      [req.org.id]));
  });
};
